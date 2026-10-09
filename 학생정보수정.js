/**
 * ---------------------------------------------------------
 * [수정 구역] 학생 정보 수정 (Update)
 * ---------------------------------------------------------
 */

// 1. 수정 팝업 열기
function showEditPopup() {
  requireSpreadsheetManagerPermission_("STUDENT_EDIT");
  var html = HtmlService.createTemplateFromFile('StudentEdit').evaluate()
      .setWidth(400)
      .setHeight(600); // 항목이 많아서 조금 길게
  SpreadsheetApp.getUi().showModalDialog(html, '학생 정보 수정/퇴원처리');
}

/**
 * 💾 [수정용] 학생 정보 업데이트 (로그 ID 컬럼 추가 및 캐시 갱신 포함)
 */
function StudentUpdate_shouldCreateReturnGap_(form, currentStatus, newStatus, plannedStatus) {
  form = form || {};
  // 최신 화면은 사용자가 상태 선택값을 실제로 바꿨는지 함께 보냅니다. 과거 화면은
  // 최종 계획 상태와 새 값의 차이로 종전 동작을 유지합니다. 이렇게 해야 미래 복귀가
  // 예약된 퇴원생의 연락처만 수정했을 때 이를 오늘 복귀로 오인하지 않습니다.
  var changedFromPlannedState = String(plannedStatus || "") !== String(newStatus || "");
  var explicitlyChanged = changedFromPlannedState ||
    (Object.prototype.hasOwnProperty.call(form, "statusChanged") && form.statusChanged === true);
  return String(currentStatus || "") === "퇴원" && String(newStatus || "") === "재원" && explicitlyChanged;
}

function updateStudentData(form) {
  var requestUser = requireAuthorizedUser_();
  if (ChangeRequest_isManager_(requestUser)) AccessControl_requireStudentDataAccess_(requestUser);
  if (ChangeRequest_isManager_(requestUser)) return ChangeRequest_submit_("STUDENT_UPDATE", form || {}, {
    studentIds:[form && form.studentId], targetId:form && form.studentId, targetName:form && form.name,
    summary:"학생 정보·상태 변경"
  }).message;
  return MutationPipeline_run_({ operation: "학생정보수정" }, function(tx) {
  form = form || {};
  form.studentId = requireText_(form.studentId, "학생 ID", 100);
  form.name = requireText_(form.name, "학생 이름", 40);
  form.grade = requireText_(form.grade, "학년", 30);
  form.teacherId = requireText_(form.teacherId, "담당 원장", 120);
  form.firstDate = requireDateString_(form.firstDate, "첫 수업일");
  form.baseDay = requireNumberInRange_(form.baseDay, "수강료 기준일", 1, 31);
  form.courseMode = normalizeStudentCourseMode_(form.courseMode);
  form.fee = requireMoney_(form.fee, "수강료", 0, 10000000);
  if (form.courseMode === "특강전용") form.fee = 0;
  if (["재원", "퇴원"].indexOf(String(form.status)) === -1) throw new Error("학생 상태가 올바르지 않습니다.");
  if (form.feeApplyDate) form.feeApplyDate = requireDateString_(form.feeApplyDate, "수강료 적용일");
  if (form.statusApplyDate) form.statusApplyDate = requireDateString_(form.statusApplyDate, "상태 적용일");
  if (form.teacherApplyDate) form.teacherApplyDate = requireDateString_(form.teacherApplyDate, "담당자 적용일");
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = DataSchema_ensureSheet_(SHEET_NAMES.STUDENTS, tx).sheet;
  
  var studentMatches = LookupIndex_findRows_(SHEET_NAMES.STUDENTS, COL.STUDENT.ID, form.studentId, false);
  if (!studentMatches.length) {
    studentMatches = LookupIndex_findRows_(SHEET_NAMES.STUDENTS, COL.STUDENT.ID, form.studentId, true);
  }
  if (!studentMatches.length) return "❌ 오류: 학생을 찾을 수 없습니다.";
  var targetRow = studentMatches[0].rowNumber;
  var currentRow = studentMatches[0].row;
  var histories = buildStudentChangeHistory_(DataRepository_getRows_(SHEET_NAMES.LOGS, { required: false }));
  var studentHistory = histories[String(form.studentId)] || { fee: [], status: [], teacher: [], discount: [], courseMode: [] };
  var teacherLookup = TeacherDirectory_buildLookup_();
  var timelineOptions = { teacherIdByName: teacherLookup.idByName };
  var oldPlannedState = getLatestPlannedStudentState_(currentRow, histories, timelineOptions);

  // 화면의 원장명을 그대로 신뢰하지 않고 원장 기준정보에서 다시 확인합니다.
  // 기존에 배정된 비활성 원장은 다른 항목 수정 시 유지할 수 있지만 새 담당자로는 지정할 수 없습니다.
  var managedTeacher = teacherLookup.byId[form.teacherId] || null;
  if (!managedTeacher) throw new Error("등록된 원장을 드롭다운에서 선택해주세요.");
  if (String(oldPlannedState.teacherId || "") !== String(managedTeacher.id) && !managedTeacher.active) {
    throw new Error("비활성 원장은 새 담당자로 지정할 수 없습니다.");
  }

  var newStatus = form.status;
  var newTeacher = safeSheetText_(managedTeacher.name, 40); 
  var newFee = Number(form.fee);
  var timestamp = new Date();
  var todayStr = Utilities.formatDate(timestamp, Session.getScriptTimeZone(), "yyyy-MM-dd");
  var effectiveDate = form.feeApplyDate
    ? StudentTimeline_normalizeFeeEffectiveDate(form.feeApplyDate, form.baseDay)
    : StudentTimeline_normalizeFeeEffectiveDate(todayStr, form.baseDay);
  var statusEffectiveDate = form.statusApplyDate ? form.statusApplyDate : todayStr;
  var teacherEffectiveDate = form.teacherApplyDate ? form.teacherApplyDate : todayStr;
  var currentOperationalState = resolveStudentStateAtDate_(currentRow, histories, timestamp, timelineOptions);
  var isActualReturn = StudentUpdate_shouldCreateReturnGap_(
    form, currentOperationalState.status, newStatus, oldPlannedState.status
  );
  if (isActualReturn && statusEffectiveDate > todayStr) {
    throw new Error("복귀 처리는 실제 복귀일 당일 또는 이후에 등록해주세요. 복귀 예정만으로는 재원 상태를 변경하지 않습니다.");
  }
  
  // 화면에 표시했던 최종 계획값과 비교합니다. DB 셀의 마지막 입력값과 비교하면
  // 중간 적용일 변경 뒤 연락처만 수정해도 현재 변경으로 오인될 수 있습니다.
  var changeEvents = [];
  if (String(oldPlannedState.status) !== String(newStatus)) changeEvents.push({
    eventId: createUniqueId_("EVT"),
    field: "status", item: "상태 변경",
    before: StudentTimeline_resolveValueBeforeDate_(currentRow[IDX.STUDENT.STATUS], studentHistory.status, statusEffectiveDate),
    after: newStatus, effectiveDate: statusEffectiveDate, createdAt: timestamp
  });
  if (String(oldPlannedState.teacherId || "") !== String(managedTeacher.id)) changeEvents.push({
    eventId: createUniqueId_("EVT"),
    field: "teacher", item: "담당 원장 변경",
    before: StudentTimeline_resolveValueBeforeDate_(currentRow[IDX.STUDENT.TEACHER], studentHistory.teacher, teacherEffectiveDate),
    after: newTeacher, effectiveDate: teacherEffectiveDate, createdAt: timestamp, refId: managedTeacher.id
  });
  if (Number(oldPlannedState.fee) !== Number(newFee)) changeEvents.push({
    eventId: createUniqueId_("EVT"),
    field: "fee", item: "수강료 변경",
    before: StudentTimeline_resolveValueBeforeDate_(currentRow[IDX.STUDENT.FEE], studentHistory.fee, effectiveDate),
    after: newFee, effectiveDate: effectiveDate, createdAt: timestamp
  });
  if (normalizeStudentCourseMode_(oldPlannedState.courseMode) !== form.courseMode) changeEvents.push({
    eventId: createUniqueId_("EVT"),
    field: "courseMode", item: "수강형태 변경",
    before: normalizeStudentCourseMode_(StudentTimeline_resolveValueBeforeDate_(
      currentRow[IDX.STUDENT.COURSE_MODE], studentHistory.courseMode, todayStr
    )),
    after: form.courseMode, effectiveDate: todayStr, createdAt: timestamp
  });

  var prospectiveHistories = {};
  Object.keys(histories).forEach(function(id) { prospectiveHistories[id] = histories[id]; });
  var prospectiveStudentHistory = {
    fee: (studentHistory.fee || []).slice(),
    status: (studentHistory.status || []).slice(),
    teacher: (studentHistory.teacher || []).slice(),
    discount: (studentHistory.discount || []).slice(),
    courseMode: (studentHistory.courseMode || []).slice()
  };
  changeEvents.forEach(function(event) {
    prospectiveStudentHistory[event.field] = StudentTimeline_withPendingChange_(prospectiveStudentHistory[event.field], event);
  });
  prospectiveHistories[String(form.studentId)] = prospectiveStudentHistory;
  var plannedAfter = resolveStudentStateAtDate_(
    currentRow, prospectiveHistories, new Date(9999, 11, 31, 23, 59, 59, 999), timelineOptions
  );

  // B~K 핵심 열만 한 번에 기록하여 셀별 부분 반영과 다른 열의 수식 손상을 방지합니다.
  var phoneVal = form.phone ? "'" + form.phone : "";
  var nextExitDate = currentRow[IDX.STUDENT.EXIT_DATE];
  if (plannedAfter.status === "재원") nextExitDate = "";
  if (plannedAfter.status === "퇴원") {
    var orderedStatusEvents = prospectiveStudentHistory.status.slice().sort(function(a, b) {
      return (a.effectiveDate - b.effectiveDate) || (a.createdAt - b.createdAt) || (a.rowOrder - b.rowOrder);
    });
    if (orderedStatusEvents.length) nextExitDate = formatDateOnly_(orderedStatusEvents[orderedStatusEvents.length - 1].effectiveDate);
    else if (!nextExitDate) nextExitDate = statusEffectiveDate;
  }
  tx.writeRange(sheet, targetRow, COL.STUDENT.NAME, [[
    safeSheetText_(form.name, 40), safeSheetText_(form.grade, 30), plannedAfter.status,
    plannedAfter.teacher, form.firstDate, nextExitDate, form.baseDay,
    currentRow[IDX.STUDENT.RATE], phoneVal, plannedAfter.fee
  ]]);
  tx.writeRange(sheet, targetRow, COL.STUDENT.COURSE_MODE, [[plannedAfter.courseMode]]);
  if (!plannedAfter.teacherId) throw new Error("최종 계획 담당 원장의 ID를 확인할 수 없습니다: " + plannedAfter.teacher);
  tx.writeRange(sheet, targetRow, COL.STUDENT.TEACHER_ID, [[plannedAfter.teacherId]]);

  if (form.asd !== undefined) {
    tx.writeRange(sheet, targetRow, COL.STUDENT.ORIGINAL_JOIN_DATE, [[form.asd]]);
  }

  // 데이터 변경 성공 후에만 로그를 기록해 실패한 작업이 이력에 남는 것을 방지합니다.
  if (changeEvents.length > 0) {
    changeEvents.forEach(function(event) {
      tx.queueEvent({
        eventId: event.eventId,
        eventType: "학생정보변경", targetType: "학생", targetId: form.studentId, studentId: form.studentId,
        field: event.item, before: event.before, after: event.after, effectiveDate: event.effectiveDate,
        refId: event.refId || ""
      });
    });
  }
  var retirementGap = null;
  if (isActualReturn) {
    var previousExitDate = parseDateOnly_(currentRow[IDX.STUDENT.EXIT_DATE]);
    if (!previousExitDate) {
      var returnDateObject = parseDateOnly_(statusEffectiveDate);
      var priorRetirementEvents = (studentHistory.status || []).filter(function(event) {
        return String(event.after || "").trim() === "퇴원" && event.effectiveDate < returnDateObject;
      }).sort(function(a, b) {
        return (b.effectiveDate - a.effectiveDate) || (b.createdAt - a.createdAt) || (b.rowOrder - a.rowOrder);
      });
      if (priorRetirementEvents.length) previousExitDate = priorRetirementEvents[0].effectiveDate;
    }
    if (!previousExitDate) {
      throw new Error("복귀 전 퇴원일을 확인할 수 없습니다. 퇴원 기록을 먼저 확인해주세요.");
    }
    var returnEvent = changeEvents.filter(function(event) { return event.field === "status"; })[0];
    retirementGap = VacationDomain_appendRetirementGap_(tx, {
      studentId: form.studentId,
      studentName: form.name,
      exitDate: formatDateOnly_(previousExitDate),
      returnDate: statusEffectiveDate,
      endEventId: returnEvent ? returnEvent.eventId : ""
    });
  }
  tx.invalidate([SHEET_NAMES.STUDENTS, SHEET_NAMES.EVENTS]);

  var feeChanged = changeEvents.some(function(event) { return event.field === "fee"; });
  var feeNotice = feeChanged ? "\n수강료 적용일: " + effectiveDate + " (기준일 적용)" : "";
  var returnNotice = retirementGap
    ? "\n퇴원공백: " + retirementGap.startDate + " ~ " + retirementGap.endDate +
      (retirementGap.duplicate ? " (기존 기록 유지)" : " (자동 등록)")
    : "";
  return "✅ 수정 완료되었습니다 (" + form.name + ")" + feeNotice + returnNotice;
  });
}
/**
 * 📋 [수정용] 학생 목록 가져오기 (필터 기능 추가)
 * @param {boolean} includeRetired - 퇴원생 포함 여부
 */
function StudentDirectory_listForOperations_(includeRetired) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAMES.STUDENTS);
  if (!sheet) return [];

  var context = DataRepository_loadContext_([SHEET_NAMES.STUDENTS, SHEET_NAMES.LOGS], { required: false });
  var data = context[SHEET_NAMES.STUDENTS] || [];
  var histories = buildStudentChangeHistory_(context[SHEET_NAMES.LOGS] || []);
  var asOfDate = new Date();
  asOfDate.setHours(23, 59, 59, 999);
  var list = [];
  var teacherLookup = TeacherDirectory_buildLookup_();
  var timelineOptions = { teacherIdByName: teacherLookup.idByName };

  // 1행(헤더) 건너뛰고 스캔
  for (var i = 1; i < data.length; i++) {
    var state = resolveStudentStateAtDate_(data[i], histories, asOfDate, timelineOptions);
    var status = state.status;
    
    // 조건: '재원'이거나, '퇴원생 포함' 체크가 되어있으면 추가
    // (상태가 비어있는 경우도 있을 수 있으니 확실한 '퇴원'만 구분하거나, 재원이 아니면 다 퇴원으로 볼지 결정 필요.
    //  여기서는 '재원'인 경우와, 옵션이 켜졌을 때의 나머지 경우를 가져옵니다.)
    
    var isActive = (status === "재원");
    
    if (isActive || includeRetired) {
      // 리스트에 보여줄 이름표 (퇴원생은 뒤에 라벨 붙임)
      var nameLabel = data[i][IDX.STUDENT.NAME];
      if (!isActive) nameLabel += " (퇴원)"; 

      list.push({
        id: data[i][IDX.STUDENT.ID],
        name: data[i][IDX.STUDENT.NAME],
        nameLabel: nameLabel,// 리스트 표시용 이름 (퇴원 표시 포함)
        grade: data[i][IDX.STUDENT.GRADE],
        teacher: state.teacher,
        teacherId: state.teacherId,
        fee: state.fee
      });
    }
  }
  return list;
}

function StudentDirectory_applyManagerScope_(list, access) {
  return AccessControl_filterStudentList_(list || [], access);
}

function getStudentListForEdit(includeRetired) {
  var access = requireManagerPermission_("STUDENT_EDIT");
  return StudentDirectory_applyManagerScope_(StudentDirectory_listForOperations_(includeRetired), access);
}

/** 휴가 화면에는 선택에 필요한 최소 정보만 전달합니다. */
function getStudentListForVacation(includeRetired) {
  var access = requireManagerPermission_("STUDENT_VACATION");
  return StudentDirectory_applyManagerScope_(StudentDirectory_listForOperations_(includeRetired), access).map(function(student) {
    return { id:student.id, name:student.name, nameLabel:student.nameLabel };
  });
}

var STUDENT_DETAIL_CACHE_TTL_SECONDS = 300;

function StudentDetail_build_(targetId) {
  var studentMatches = LookupIndex_findRows_(SHEET_NAMES.STUDENTS, COL.STUDENT.ID, targetId, false);
  if (!studentMatches.length) {
    studentMatches = LookupIndex_findRows_(SHEET_NAMES.STUDENTS, COL.STUDENT.ID, targetId, true);
  }
  if (!studentMatches.length) {
    console.error("❌ 학생을 찾지 못함. 목표ID: [" + targetId + "]");
    return null;
  }
  var studentRow = studentMatches[0].row;
  var histories = buildStudentChangeHistory_(EventRepository_getLegacyRowsForStudents_([targetId], false));
  var teacherLookup = TeacherDirectory_buildLookup_();
  var timelineOptions = { teacherIdByName: teacherLookup.idByName };
  var asOfDate = new Date();
  asOfDate.setHours(23, 59, 59, 999);
  var studentHistory = histories[targetId] || { fee: [], status: [], teacher: [] };
  var plannedState = getLatestPlannedStudentState_(studentRow, histories, timelineOptions);
  var futureChanges = { fee: [], status: [], teacher: [] };
  ["fee", "status", "teacher"].forEach(function(field) {
    futureChanges[field] = (studentHistory[field] || []).filter(function(change) {
      return change.effectiveDate > asOfDate;
    }).sort(function(a, b) {
      return (a.effectiveDate - b.effectiveDate) || (a.createdAt - b.createdAt);
    }).map(function(change) {
      return {
        effectiveDate: Utilities.formatDate(change.effectiveDate, Session.getScriptTimeZone(), "yyyy-MM-dd"),
        before: change.before,
        after: change.after,
        refId: change.refId || ""
      };
    });
  });
  var firstDateVal = studentRow[IDX.STUDENT.FIRST_DATE];
  var firstDateStr = "";
  if (firstDateVal instanceof Date) {
    firstDateStr = Utilities.formatDate(firstDateVal, Session.getScriptTimeZone(), "yyyy-MM-dd");
  } else {
    firstDateStr = String(firstDateVal);
  }

  var asdVal = studentRow[IDX.STUDENT.ORIGINAL_JOIN_DATE];
  var asdStr = "";
  if (asdVal instanceof Date) {
    asdStr = Utilities.formatDate(asdVal, Session.getScriptTimeZone(), "yyyy-MM-dd");
  } else if (asdVal) {
    asdStr = String(asdVal);
  }

  var exitDateVal = studentRow[IDX.STUDENT.EXIT_DATE];
  var exitDateStr = "";
  if (exitDateVal instanceof Date) {
    exitDateStr = Utilities.formatDate(exitDateVal, Session.getScriptTimeZone(), "yyyy-MM-dd");
  } else if (exitDateVal) {
    exitDateStr = String(exitDateVal);
  }

  return {
    id: studentRow[IDX.STUDENT.ID],
    studentId: studentRow[IDX.STUDENT.ID],
    name: studentRow[IDX.STUDENT.NAME],
    grade: studentRow[IDX.STUDENT.GRADE],
    status: plannedState.status,
    teacher: plannedState.teacher,
    teacherId: plannedState.teacherId,
    firstDate: firstDateStr,
    exitDate: exitDateStr,
    asd: asdStr,
    baseDay: studentRow[IDX.STUDENT.BASE_DAY],
    phone: studentRow[IDX.STUDENT.PHONE],
    fee: plannedState.fee,
    courseMode: plannedState.courseMode,
    relName: String(studentRow[IDX.STUDENT.FAMILY_NAME] || "").trim() || "-",
    futureChanges: futureChanges
  };
}

function StudentDetail_getCached_(studentId) {
  var targetId = requireText_(studentId, "학생 ID", 100).trim();
  var dependencies = [SHEET_NAMES.STUDENTS, SHEET_NAMES.EVENTS, SHEET_NAMES.LOGS, SHEET_NAMES.TEACHERS];
  var signature = QueryResultCache_signature_("STUDENT_DETAIL_V1", targetId, dependencies);
  var cached = QueryResultCache_get_(signature);
  if (cached) return cached;
  var detail = StudentDetail_build_(targetId);
  var finalSignature = QueryResultCache_signature_("STUDENT_DETAIL_V1", targetId, dependencies);
  if (detail && signature === finalSignature) QueryResultCache_put_(finalSignature, detail, STUDENT_DETAIL_CACHE_TTL_SECONDS);
  return detail;
}

function StudentDetail_assertAccess_(access, detail) {
  AccessControl_requireStudentDataAccess_(access);
  if (!detail || !ChangeRequest_isManager_(access)) return detail;
  var scope = AccessControl_getStudentScope_(access);
  if (scope === STUDENT_ACCESS_SCOPES.ALL_STUDENTS) return detail;
  var linkedTeacherId = String(access.teacherId || "").trim();
  if (!linkedTeacherId || String(detail.teacherId || "").trim() !== linkedTeacherId) {
    throw new Error("선택한 담당 원장의 학생 정보만 확인할 수 있습니다.");
  }
  return detail;
}

function StudentDetail_getForAccess_(studentId, access) {
  // 학생 범위가 없는 계정은 화면 접근은 유지하되, 조회 자체를 시작하지 않고 빈 결과를 돌려줍니다.
  if (!AccessControl_hasStudentDataAccess_(access)) return null;
  var detail = StudentDetail_getCached_(studentId);
  if (!detail) return null;
  return StudentDetail_assertAccess_(access, detail);
}

/**
 * 🔍 학생 정보 수정 화면용 상세 정보 조회
 */
function getStudentDetail(studentId) {
  var access = requireManagerPermission_("STUDENT_EDIT");
  return StudentDetail_getForAccess_(studentId, access);
}

/** 학생명이 표시된 모든 화면에서 사용하는 공통 상세 모달 조회입니다. */
function getStudentInfoModalData(studentId) {
  var access = requireAuthorizedUser_();
  var detail = StudentDetail_getForAccess_(studentId, access);
  if (!detail) return null;
  var response = {};
  Object.keys(detail).forEach(function(key) { response[key] = detail[key]; });
  response.canViewPaymentHistory = !!(access.bootstrap || access.role === ACCESS_CONTROL.ROLES.SUPER_ADMIN);
  return response;
}
