/** 스프레드시트 개발·관리 메뉴에서 전체 학생 명단 인쇄 화면을 엽니다. */
function openStudentRosterPrint() {
  requireSpreadsheetSuperAdmin_();
  var html = HtmlService.createTemplateFromFile("StudentRosterPrint").evaluate()
    .setWidth(1400)
    .setHeight(900);
  SpreadsheetApp.getUi().showModalDialog(html, "전체 학생 명단 인쇄");
}

function StudentRoster_formatDate_(value) {
  var date = parseDateOnly_(value);
  return date ? formatDateOnly_(date) : "";
}

function StudentRoster_formatRate_(value) {
  var text = String(value == null ? "" : value).trim();
  if (!text) return "";
  var number = Number(text.replace("%", ""));
  if (!isFinite(number)) return text;
  if (/%$/.test(text) || number > 1) return number + "%";
  return Math.round(number * 10000) / 100 + "%";
}

/** 오늘 기준 상태를 적용하되, 원본 시트의 연락처·입퇴원 정보도 함께 제공합니다. */
function getStudentRosterPrintData() {
  var startedAt = Date.now();
  requireSuperAdmin_();
  var dependencies = [SHEET_NAMES.STUDENTS, SHEET_NAMES.LOGS, SHEET_NAMES.EVENTS];
  var initialSignature = QueryResultCache_signature_("STUDENT_ROSTER", "TODAY", dependencies);
  var cachedResult = QueryResultCache_get_(initialSignature);
  if (cachedResult) {
    console.log("[학생 명단 출력 조회 성능] " + JSON.stringify({ cacheHit: true, rows: cachedResult.rows.length, totalMs: Date.now() - startedAt }));
    return cachedResult;
  }
  var context = DataRepository_loadContext_([SHEET_NAMES.STUDENTS, SHEET_NAMES.LOGS], { required: false });
  var signatureAfterLoad = QueryResultCache_signature_("STUDENT_ROSTER", "TODAY", dependencies);
  var students = context[SHEET_NAMES.STUDENTS] || [];
  var histories = StudentTimeline_buildHistories(context[SHEET_NAMES.LOGS] || []);
  var today = new Date();
  today.setHours(23, 59, 59, 999);
  var rows = [];
  for (var i = 1; i < students.length; i++) {
    var row = students[i];
    var studentId = String(row[IDX.STUDENT.ID] || "").trim();
    var name = String(row[IDX.STUDENT.NAME] || "").trim();
    if (!studentId || !name) continue;
    var state = StudentTimeline_resolveState(row, histories, today);
    var exitDate = parseDateOnly_(row[IDX.STUDENT.EXIT_DATE]);
    var status = state.status || String(row[IDX.STUDENT.STATUS] || "").trim();
    if (status !== "퇴원" && exitDate && exitDate > today) status = "퇴원예정";
    var phone = String(row[IDX.STUDENT.PHONE] || "").replace(/^'/, "").trim();
    var firstDate = row[IDX.STUDENT.ORIGINAL_JOIN_DATE] || row[IDX.STUDENT.FIRST_DATE];
    rows.push({
      studentId: studentId,
      status: status,
      name: name,
      grade: String(row[IDX.STUDENT.GRADE] || ""),
      courseMode: state.courseMode,
      teacher: state.teacher,
      fee: Number(state.fee) || 0,
      baseDay: Number(row[IDX.STUDENT.BASE_DAY]) || "",
      rate: StudentRoster_formatRate_(row[IDX.STUDENT.RATE]),
      firstDate: StudentRoster_formatDate_(firstDate),
      exitDate: StudentRoster_formatDate_(row[IDX.STUDENT.EXIT_DATE]),
      parentName: String(row[IDX.STUDENT.PARENT_NAME] || ""),
      phone: phone
    });
  }
  var statusOrder = { "재원": 0, "퇴원예정": 1, "퇴원": 2 };
  rows.sort(function(a, b) {
    return (statusOrder[a.status] == null ? 9 : statusOrder[a.status]) - (statusOrder[b.status] == null ? 9 : statusOrder[b.status]) ||
      String(a.teacher).localeCompare(String(b.teacher), "ko") ||
      String(a.grade).localeCompare(String(b.grade), "ko") ||
      String(a.name).localeCompare(String(b.name), "ko");
  });
  var result = {
    generatedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm"),
    rows: rows,
    counts: {
      all: rows.length,
      active: rows.filter(function(item) { return item.status === "재원"; }).length,
      plannedExit: rows.filter(function(item) { return item.status === "퇴원예정"; }).length,
      retired: rows.filter(function(item) { return item.status === "퇴원"; }).length
    }
  };
  var finalSignature = QueryResultCache_signature_("STUDENT_ROSTER", "TODAY", dependencies);
  if (finalSignature === signatureAfterLoad) QueryResultCache_put_(finalSignature, result, 600);
  console.log("[학생 명단 출력 조회 성능] " + JSON.stringify({
    cacheHit: false, cacheStored: finalSignature === signatureAfterLoad,
    rows: rows.length, totalMs: Date.now() - startedAt
  }));
  return result;
}
