/**
 * ---------------------------------------------------------
 * [휴가 관리 구역]
 * ---------------------------------------------------------
 */

var VACATION_PERIOD_TYPES = {
  VACATION: "일반휴가",
  RETIREMENT_GAP: "퇴원공백"
};

var VACATION_HEADERS = [
  "휴가ID", "학생ID", "학생명", "시작일", "종료일", "사유", "등록일시",
  "기간유형", "시작이벤트ID", "종료이벤트ID", "생성방식"
];

function VacationDomain_ensureSchema_(sheet) {
  if (!sheet) throw new Error("휴가 기간 시트를 찾을 수 없습니다.");
  DataSchema_ensureSheet_(SHEET_NAMES.VACATIONS);
}

function VacationDomain_getOrCreateSheet_(tx) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAMES.VACATIONS);
  if (sheet) {
    VacationDomain_ensureSchema_(sheet);
    return sheet;
  }
  return DataSchema_ensureSheet_(SHEET_NAMES.VACATIONS, tx).sheet;
}

function VacationDomain_buildRetirementGapDates_(exitDateValue, returnDateValue) {
  var exitDate = parseDateOnly_(exitDateValue);
  var returnDate = parseDateOnly_(returnDateValue);
  if (!exitDate || !returnDate) throw new Error("퇴원일 또는 복귀일이 올바르지 않습니다.");
  var gapStart = new Date(exitDate.getFullYear(), exitDate.getMonth(), exitDate.getDate() + 1);
  var gapEnd = new Date(returnDate.getFullYear(), returnDate.getMonth(), returnDate.getDate() - 1);
  if (gapStart > gapEnd) return null;
  return { startDate: formatDateOnly_(gapStart), endDate: formatDateOnly_(gapEnd) };
}

function VacationDomain_periodsOverlap_(firstStart, firstEnd, secondStart, secondEnd) {
  var aStart = parseDateOnly_(firstStart);
  var aEnd = parseDateOnly_(firstEnd);
  var bStart = parseDateOnly_(secondStart);
  var bEnd = parseDateOnly_(secondEnd);
  return !!(aStart && aEnd && bStart && bEnd && aStart <= bEnd && aEnd >= bStart);
}

function VacationDomain_appendRetirementGap_(tx, options) {
  options = options || {};
  var studentId = requireText_(options.studentId, "학생 ID", 100);
  var studentName = safeSheetText_(requireText_(options.studentName, "학생 이름", 40), 40);
  var exitText = requireDateString_(options.exitDate, "기존 퇴원일");
  var returnText = requireDateString_(options.returnDate, "실제 복귀일");
  var gapDates = VacationDomain_buildRetirementGapDates_(exitText, returnText);
  if (!gapDates) return null;
  var startText = gapDates.startDate;
  var endText = gapDates.endDate;
  var sheet = VacationDomain_getOrCreateSheet_(tx);
  var rows = LookupIndex_findRows_(
    SHEET_NAMES.VACATIONS, COL.VACATION.STUDENT_ID, studentId, false
  ).map(function(item) { return item.row; });
  for (var i = 0; i < rows.length; i++) {
    var existingType = String(rows[i][IDX.VACATION.PERIOD_TYPE] || VACATION_PERIOD_TYPES.VACATION).trim();
    var existingStart = formatDateOnly_(parseDateOnly_(rows[i][IDX.VACATION.START_DATE]));
    var existingEnd = formatDateOnly_(parseDateOnly_(rows[i][IDX.VACATION.END_DATE]));
    if (existingType === VACATION_PERIOD_TYPES.RETIREMENT_GAP &&
        existingStart === startText && existingEnd === endText) {
      return {
        id: rows[i][IDX.VACATION.ID],
        startDate: startText,
        endDate: endText,
        duplicate: true
      };
    }
    if (VacationDomain_periodsOverlap_(startText, endText, existingStart, existingEnd)) {
      throw new Error("기존 휴가·퇴원공백과 기간이 겹쳐 복귀 공백을 자동 등록할 수 없습니다. 기존 기간을 먼저 확인해주세요.");
    }
  }

  var gapId = createUniqueId_("GAP");
  tx.appendRows(sheet, [[
    gapId, studentId, studentName, startText, endText,
    "퇴원 후 실제 복귀 전 공백", new Date(), VACATION_PERIOD_TYPES.RETIREMENT_GAP,
    optionalText_(options.startEventId, 120), optionalText_(options.endEventId, 120), "복귀처리 자동생성"
  ]]);
  tx.queueEvent({
    eventType: "퇴원공백등록", targetType: "기간", targetId: gapId, studentId: studentId,
    field: "퇴원공백", before: "", after: startText + "~" + endText,
    effectiveDate: startText, refId: gapId,
    memo: "실제 복귀일 " + returnText
  });
  tx.invalidateMonths(MonthlyCache_monthsBetween_(startText, endText));
  tx.invalidate([SHEET_NAMES.VACATIONS, SHEET_NAMES.EVENTS]);
  return { id: gapId, startDate: startText, endDate: endText, duplicate: false };
}

function VacationDomain_findPeriod_(sheet, periodId) {
  var targetId = String(periodId || "").trim();
  if (!sheet || !targetId) return null;
  var matches = LookupIndex_findRows_(SHEET_NAMES.VACATIONS, COL.VACATION.ID, targetId, false);
  if (!matches.length) {
    matches = LookupIndex_findRows_(SHEET_NAMES.VACATIONS, COL.VACATION.ID, targetId, true);
  }
  return matches.length ? { rowNumber:matches[0].rowNumber, row:matches[0].row } : null;
}

function getVacationPeriodsForStudent(studentId) {
  var access = requireManagerPermission_("STUDENT_VACATION");
  if (!AccessControl_hasStudentDataAccess_(access)) return [];
  ChangeRequest_assertStudentScope_(access, [studentId]);
  studentId = requireText_(studentId, "학생 ID", 100);
  var sheet = DataRepository_getSheet_(SHEET_NAMES.VACATIONS, false);
  if (!sheet) return [];
  return LookupIndex_findRows_(SHEET_NAMES.VACATIONS, COL.VACATION.STUDENT_ID, studentId, false)
    .map(function(item) { return item.row; }).map(function(row) {
    return {
      id: row[IDX.VACATION.ID],
      startDate: formatDateOnly_(parseDateOnly_(row[IDX.VACATION.START_DATE])),
      endDate: formatDateOnly_(parseDateOnly_(row[IDX.VACATION.END_DATE])),
      reason: String(row[IDX.VACATION.REASON] || ""),
      periodType: String(row[IDX.VACATION.PERIOD_TYPE] || VACATION_PERIOD_TYPES.VACATION)
    };
    }).sort(function(a, b) { return String(b.startDate).localeCompare(String(a.startDate)); });
}

function updateVacationPeriod(form) {
  form = form || {};
  var requestUser = requireAuthorizedUser_();
  if (ChangeRequest_isManager_(requestUser)) AccessControl_requireStudentDataAccess_(requestUser);
  if (ChangeRequest_isManager_(requestUser)) {
    var requestStudentId = ChangeRequest_getVacationStudentId_(form.periodId);
    return ChangeRequest_submit_("VACATION_UPDATE", form, { studentIds:[requestStudentId], targetId:requestStudentId,
      targetName:form.studentName, summary:"휴가 기간 수정" }).message;
  }
  return MutationPipeline_run_({ operation: "휴가기간수정" }, function(tx) {
    var periodId = requireText_(form.periodId, "기간 ID", 120);
    var startDate = requireDateString_(form.startDate, "기간 시작일");
    var endDate = requireDateString_(form.endDate, "기간 종료일");
    if (startDate > endDate) throw new Error("기간 종료일은 시작일보다 빠를 수 없습니다.");
    var reason = safeSheetText_(form.reason, 300);
    var sheet = VacationDomain_getOrCreateSheet_(tx);
    var found = VacationDomain_findPeriod_(sheet, periodId);
    if (!found) throw new Error("수정할 휴가·퇴원공백을 찾을 수 없습니다.");
    if (String(found.row[IDX.VACATION.PERIOD_TYPE] || VACATION_PERIOD_TYPES.VACATION) === VACATION_PERIOD_TYPES.RETIREMENT_GAP) {
      throw new Error("퇴원공백은 학생 복귀 기록에서 자동 관리됩니다. 학생 정보의 복귀 기록을 정정해주세요.");
    }
    var studentId = String(found.row[IDX.VACATION.STUDENT_ID] || "").trim();
    var studentPeriods = LookupIndex_findRows_(
      SHEET_NAMES.VACATIONS, COL.VACATION.STUDENT_ID, studentId, false
    );
    for (var i = 0; i < studentPeriods.length; i++) {
      if (studentPeriods[i].rowNumber === found.rowNumber) continue;
      var otherRow = studentPeriods[i].row;
      var otherStart = parseDateOnly_(otherRow[IDX.VACATION.START_DATE]);
      var otherEnd = parseDateOnly_(otherRow[IDX.VACATION.END_DATE]);
      if (otherStart && otherEnd && parseDateOnly_(startDate) <= otherEnd && parseDateOnly_(endDate) >= otherStart) {
        throw new Error("다른 휴가·퇴원공백 기간과 겹칩니다.");
      }
    }
    var before = formatDateOnly_(parseDateOnly_(found.row[IDX.VACATION.START_DATE])) + "~" +
      formatDateOnly_(parseDateOnly_(found.row[IDX.VACATION.END_DATE]));
    tx.writeRange(sheet, found.rowNumber, COL.VACATION.START_DATE, [[startDate, endDate, reason]]);
    tx.queueEvent({
      eventType: "휴가기간수정", targetType: "기간", targetId: periodId, studentId: studentId,
      field: String(found.row[IDX.VACATION.PERIOD_TYPE] || VACATION_PERIOD_TYPES.VACATION),
      before: before, after: startDate + "~" + endDate, effectiveDate: startDate,
      refId: periodId, memo: reason
    });
    tx.invalidateMonths(MonthlyCache_monthsBetween_(found.row[IDX.VACATION.START_DATE], found.row[IDX.VACATION.END_DATE])
      .concat(MonthlyCache_monthsBetween_(startDate, endDate)));
    tx.invalidate([SHEET_NAMES.VACATIONS, SHEET_NAMES.EVENTS]);
    return "휴가·퇴원공백 기간을 수정했습니다.";
  });
}

function deleteVacationPeriod(periodId, reason) {
  var requestUser = requireAuthorizedUser_();
  if (ChangeRequest_isManager_(requestUser)) AccessControl_requireStudentDataAccess_(requestUser);
  if (ChangeRequest_isManager_(requestUser)) {
    var requestStudentId = ChangeRequest_getVacationStudentId_(periodId);
    return ChangeRequest_submit_("VACATION_DELETE", { periodId:periodId, reason:reason }, {
      studentIds:[requestStudentId], targetId:requestStudentId, summary:"휴가 기간 삭제"
    }).message;
  }
  return MutationPipeline_run_({ operation: "휴가기간휴지통이동" }, function(tx) {
    periodId = requireText_(periodId, "기간 ID", 120);
    var sheet = VacationDomain_getOrCreateSheet_(tx);
    var found = VacationDomain_findPeriod_(sheet, periodId);
    if (!found) throw new Error("삭제할 휴가·퇴원공백을 찾을 수 없습니다.");
    var row = found.row;
    if (String(row[IDX.VACATION.PERIOD_TYPE] || VACATION_PERIOD_TYPES.VACATION) === VACATION_PERIOD_TYPES.RETIREMENT_GAP) {
      throw new Error("퇴원공백은 직접 삭제할 수 없습니다. 학생 복귀 기록을 정정해주세요.");
    }
    var trashSheet = PaymentLifecycle_getTrashSheet_(tx);
    var deletedAt = new Date();
    var purgeAt = Trash_addMonthsClamped_(deletedAt, 2);
    var trashId = createUniqueId_("TRASH");
    var deleteReason = safeSheetText_(reason || "휴가·퇴원공백 삭제", 300);
    tx.appendRows(trashSheet, [[
      trashId, deletedAt, purgeAt, SHEET_NAMES.VACATIONS, periodId,
      row[IDX.VACATION.STUDENT_ID], row[IDX.VACATION.STUDENT_NAME], requireAuthorizedUser_().email,
      deleteReason, Trash_serializeRow_(row), "보관중", "", ""
    ]]);
    tx.deleteRows(sheet, found.rowNumber, 1);
    tx.queueEvent({
      eventType: "휴가기간휴지통이동", targetType: "기간", targetId: periodId,
      studentId: row[IDX.VACATION.STUDENT_ID], field: "삭제상태",
      before: "사용중", after: "휴지통", refId: trashId, memo: deleteReason
    });
    tx.invalidateMonths(MonthlyCache_monthsBetween_(row[IDX.VACATION.START_DATE], row[IDX.VACATION.END_DATE]));
    tx.invalidate([SHEET_NAMES.VACATIONS, SHEET_NAMES.TRASH, SHEET_NAMES.EVENTS]);
    return "휴가·퇴원공백을 휴지통으로 이동했습니다. 두 달 동안 복구할 수 있습니다.";
  });
}

// 1. 휴가 등록 팝업 열기
function showVacationPopup() {
  requireSpreadsheetManagerPermission_("STUDENT_VACATION");
  var html = HtmlService.createTemplateFromFile('StudentVacation').evaluate()
      .setWidth(400)
      .setHeight(720);
  SpreadsheetApp.getUi().showModalDialog(html, '학생 휴가 등록');
}

/**
 * 2. [최적화됨] 휴가 데이터 저장 (캐시 삭제 포함)
 */
function saveVacation(form) {
  var requestUser = requireAuthorizedUser_();
  if (ChangeRequest_isManager_(requestUser)) AccessControl_requireStudentDataAccess_(requestUser);
  if (ChangeRequest_isManager_(requestUser)) return ChangeRequest_submit_("VACATION_CREATE", form || {}, {
    studentIds:[form && form.studentId], targetId:form && form.studentId, targetName:form && form.studentName,
    summary:"휴가 기간 등록"
  }).message;
  return MutationPipeline_run_({ operation: "휴가등록" }, function(tx) {
  form = form || {};
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = VacationDomain_getOrCreateSheet_(tx);

  var studentId = requireText_(form.studentId, "학생 ID", 100);
  var studentSheet = ss.getSheetByName(SHEET_NAMES.STUDENTS);
  if (!studentSheet) throw new Error("학생 명단 시트를 찾을 수 없습니다.");
  var studentMatches = LookupIndex_findRows_(SHEET_NAMES.STUDENTS, COL.STUDENT.ID, studentId, false);
  if (!studentMatches.length) {
    studentMatches = LookupIndex_findRows_(SHEET_NAMES.STUDENTS, COL.STUDENT.ID, studentId, true);
  }
  if (!studentMatches.length) throw new Error("학생 ID에 해당하는 학생을 찾을 수 없습니다.");
  var studentRow = studentMatches[0].row;
  var histories = buildStudentChangeHistory_(EventRepository_getLegacyRowsForStudents_([studentId], false));
  var asOfDate = new Date(); asOfDate.setHours(23, 59, 59, 999);
  var state = resolveStudentStateAtDate_(studentRow, histories, asOfDate);
  if (state.status !== "재원") throw new Error("현재 재원 중인 학생만 휴가를 등록할 수 있습니다.");
  var studentName = String(studentRow[IDX.STUDENT.NAME]).trim();
  var startDate = requireDateString_(form.startDate, "휴가 시작일");
  var endDate = requireDateString_(form.endDate, "휴가 종료일");
  if (startDate > endDate) throw new Error("휴가 종료일은 시작일보다 빠를 수 없습니다.");
  var reason = safeSheetText_(form.reason, 300);
  var vacId = createUniqueId_("VAC");
  var now = new Date();

  var existingVacations = LookupIndex_findRows_(
    SHEET_NAMES.VACATIONS, COL.VACATION.STUDENT_ID, studentId, false
  ).map(function(item) { return item.row; });
  var newStart = parseDateOnly_(startDate);
  var newEnd = parseDateOnly_(endDate);
  for (var v = 0; v < existingVacations.length; v++) {
    var oldStart = parseDateOnly_(existingVacations[v][IDX.VACATION.START_DATE]);
    var oldEnd = parseDateOnly_(existingVacations[v][IDX.VACATION.END_DATE]);
    if (oldStart && oldEnd && newStart <= oldEnd && newEnd >= oldStart) {
      throw new Error("기존 휴가 기간과 겹칩니다.");
    }
  }

  // 데이터 추가
  tx.appendRows(sheet, [[
    vacId,
    studentId,
    safeSheetText_(studentName, 40),
    startDate,
    endDate,
    reason,
    now,
    VACATION_PERIOD_TYPES.VACATION,
    "",
    "",
    "직접등록"
  ]]);

  tx.queueEvent({
    eventType: "휴가등록", targetType: "휴가", targetId: vacId, studentId: studentId,
    field: "휴가기간", before: "", after: startDate + "~" + endDate, effectiveDate: startDate,
    refId: vacId, memo: reason
  });

  tx.invalidateMonths(MonthlyCache_monthsBetween_(startDate, endDate));
  tx.invalidate([SHEET_NAMES.VACATIONS, SHEET_NAMES.EVENTS]);

  return "✅ 휴가가 등록되었습니다.\n(" + studentName + ": " + startDate + " ~ " + endDate + ")";
  });
}

// 학생 목록은 휴가 화면 전용 최소정보 함수(getStudentListForVacation)에서 제공합니다.
