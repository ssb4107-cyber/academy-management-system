/** 관리자 전용: 복사본에서 실행하는 전체 함수 성능 진단 */
var PERFORMANCE_LOG_SHEET_NAME = "관리_성능로그";
var PERFORMANCE_MAX_RUNTIME_MS = 280000;

function PerformanceDiagnostics_requireTestCopy_() {
  var name = String(SpreadsheetApp.getActiveSpreadsheet().getName() || "");
  if (name.indexOf("[성능테스트]") !== 0) {
    throw new Error("운영 파일에서는 전체 함수 성능 진단을 실행할 수 없습니다. 최신 복사본 이름을 '[성능테스트] 원본이름'으로 바꾼 뒤 실행해주세요.");
  }
  return name;
}

function PerformanceDiagnostics_previousYm_() {
  var date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() - 1);
  return Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM");
}

function PerformanceDiagnostics_resultInfo_(value) {
  var count = 0;
  if (Array.isArray(value)) count = value.length;
  else if (value && Array.isArray(value.list)) count = value.list.length;
  else if (value && Array.isArray(value.rows)) count = value.rows.length;
  else if (value && Array.isArray(value.results)) count = value.results.length;
  else if (value && value.counts && typeof value.counts === "object") {
    count = Number(value.counts.students || value.counts.issues || 0);
  }
  var chars = 0;
  try { chars = JSON.stringify(value == null ? null : value).length; } catch (ignoredSizeError) {}
  return { count: count, chars: chars };
}

function PerformanceDiagnostics_clearReadCaches_() {
  QueryResultCache_runtime_ = {};
  DataRepository_runtimeRows_ = {};
  [
    SHEET_NAMES.STUDENTS, SHEET_NAMES.PAYMENTS, SHEET_NAMES.REQUESTS, SHEET_NAMES.VACATIONS,
    SHEET_NAMES.EVENTS, SHEET_NAMES.LOGS, SHEET_NAMES.TRASH,
    SHEET_NAMES.TEACHERS, SHEET_NAMES.USERS,
    SHEET_NAMES.SALARY_SETTLEMENTS, SHEET_NAMES.SALARY_ENTRIES
  // 성능 측정용 비우기는 원본 변경이 아닙니다. 세대번호·영구 월별 스냅샷은
  // 그대로 두고, 진단 전용 캐시 키와 원본 임시 캐시만 분리합니다.
  ].forEach(function(sheetName) { DataRepository_evictCache_(sheetName); });
}

function PerformanceDiagnostics_buildFixtures_(targetYm) {
  var students = DataRepository_getRows_(SHEET_NAMES.STUDENTS, { required: false, fresh: true, cache: false });
  var sampleStudentId = "";
  for (var i = 1; i < students.length; i++) {
    sampleStudentId = String(students[i][IDX.STUDENT.ID] || "").trim();
    if (sampleStudentId) break;
  }
  var teachers = TeacherDirectory_list_({ salaryOnly: true });
  var settlements = listSalarySettlementRecords();
  var targetSettlement = null;
  for (var s = 0; s < settlements.length; s++) {
    if (String(settlements[s].ym || "") === targetYm && String(settlements[s].status || "") !== "취소") {
      targetSettlement = settlements[s];
      break;
    }
  }
  if (!targetSettlement) {
    targetSettlement = settlements.filter(function(item) { return String(item.status || "") !== "취소"; })[0] || null;
  }
  return {
    targetYm: targetYm,
    sampleStudentId: sampleStudentId,
    salaryTeacher: teachers[0] || null,
    settlementId: targetSettlement ? String(targetSettlement.id || "") : ""
  };
}

function PerformanceDiagnostics_cases_(fixture) {
  var ym = fixture.targetYm;
  var studentId = fixture.sampleStudentId;
  var cases = [
    { category: "권한·설정", name: "getCurrentAccessProfile", run: function() { return getCurrentAccessProfile(); } },
    { category: "권한·설정", name: "getTeacherOptionsForStudentAdd", run: function() { return getTeacherOptionsForStudentAdd(); } },
    { category: "권한·설정", name: "getTeacherOptionsForStudentEdit", run: function() { return getTeacherOptionsForStudentEdit(); } },
    { category: "권한·설정", name: "getManagedTeachers", run: function() { return getManagedTeachers(); } },
    { category: "권한·설정", name: "getManagedUsers", run: function() { return getManagedUsers(); } },
    { category: "권한·설정", name: "getSettingsOverview", run: function() { return getSettingsOverview(); } },
    { category: "요청", name: "getAppNavigationState", run: function() { return getAppNavigationState(); } },
    { category: "요청", name: "getUnifiedRequestSummary", run: function() { return getUnifiedRequestSummary(); } },
    { category: "요청", name: "getUnifiedAdminRequestInbox", run: function() { return getUnifiedAdminRequestInbox(); } },
    { category: "요청", name: "getMyOperationRequests", run: function() { return getMyOperationRequests(); } },
    { category: "대시보드", name: "getDashboardDataForHtml", run: function() { return getDashboardDataForHtml(ym); } },
    { category: "대시보드", name: "getDashboardDataWithPolicyForHtml", run: function() { return getDashboardDataWithPolicyForHtml(ym, false); } },
    { category: "대시보드", name: "getDashboardStudentsForHtml", run: function() { return getDashboardStudentsForHtml(ym, studentId ? [studentId] : []); } },
    { category: "수납", name: "getPaymentChecklistData", run: function() { return getPaymentChecklistData(ym); } },
    { category: "통계", name: "getPeriodStatistics_1month", run: function() { return getPeriodStatistics(ym, ym, "PAY_DATE"); } },
    { category: "급여", name: "getTeacherList", run: function() { return getTeacherList(); } },
    { category: "급여", name: "calculateAllSalaries", run: function() { return calculateAllSalaries(ym); } },
    { category: "급여", name: "getSalaryDashboardInitialData", run: function() { return getSalaryDashboardInitialData(ym); } },
    { category: "급여", name: "getSalaryAdminInitialData", run: function() { return getSalaryAdminInitialData(); } },
    { category: "급여", name: "listSalarySettlementRecords", run: function() { return listSalarySettlementRecords(); } },
    { category: "급여", name: "listHistoricalSalaryRecords", run: function() { return listHistoricalSalaryRecords(); } },
    { category: "급여", name: "runSalaryDataDiagnostics", run: function() { return runSalaryDataDiagnostics(); } },
      { category: "학생", name: "getStudentListForEdit_active", run: function() { return getStudentListForEdit(false); } },
      { category: "학생", name: "getStudentListForEdit_all", run: function() { return getStudentListForEdit(true); } },
      { category: "학생", name: "getStudentListForVacation", run: function() { return getStudentListForVacation(false); } },
    { category: "학생", name: "getStudentDetail", run: function() { return studentId ? getStudentDetail(studentId) : null; } },
    { category: "학생", name: "checkNameDuplicate", run: function() { return checkNameDuplicate("__성능진단_존재하지않는학생__"); } },
    { category: "학생", name: "getStudentAddEmbeddedContent", run: function() { return getStudentAddEmbeddedContent(); } },
    { category: "학생", name: "getStudentRosterPrintData", run: function() { return getStudentRosterPrintData(); } },
    { category: "수납", name: "getPaymentHistoryForEdit", run: function() { return studentId ? getPaymentHistoryForEdit(studentId) : []; } },
    { category: "휴가", name: "getVacationPeriodsForStudent", run: function() { return studentId ? getVacationPeriodsForStudent(studentId) : []; } },
    { category: "현금영수증", name: "getCashReceiptData", run: function() { return getCashReceiptData(); } },
    { category: "형제", name: "getStudentListForManager", run: function() { return getStudentListForManager(); } },
    { category: "이력", name: "getChangeLogData", run: function() { return getChangeLogData({ type: "ALL" }); } },
    { category: "휴지통", name: "getTrashItems", run: function() { return getTrashItems(); } },
    { category: "도움말", name: "getHelpContent", run: function() { return getHelpContent(); } },
    { category: "웹앱", name: "getScriptUrl", run: function() { return getScriptUrl(); } },
    { category: "웹앱", name: "createMainMenuHtml", run: function() { return createMainMenuHtml(); } },
    { category: "진단", name: "runIntegrationRegressionTests_", run: function() { return runIntegrationRegressionTests_(); } },
    { category: "진단", name: "runSystemDataDiagnostics", run: function() { return runSystemDataDiagnostics(); } },
    { category: "계산", name: "coreCalculationMicroBenchmark", run: function() {
      var total = 0;
      for (var i = 0; i < 1000; i++) {
        total += DateMoney_prorate(400000, 20, 30);
        total += PaymentDomain_calculateBalance(400000, 399000).balance;
        total += PaymentDomain_prorateAdjustedFee(400000, 25000, 0, 20, 30);
      }
      return total;
    } }
  ];
  if (fixture.salaryTeacher) {
    cases.push({ category: "급여", name: "previewSalarySettlement", run: function() {
      return previewSalarySettlement({
        ym: ym, teacherId: fixture.salaryTeacher.id, exclusions: [], adjustments: []
      });
    } });
  }
  if (fixture.settlementId) {
    cases.push({ category: "급여", name: "getSalarySettlementPrintData", run: function() {
      return getSalarySettlementPrintData(fixture.settlementId);
    } });
    cases.push({ category: "급여", name: "getSalarySettlementLedger", run: function() {
      return getSalarySettlementLedger(fixture.settlementId);
    } });
  }
  return cases;
}

function PerformanceDiagnostics_skippedFunctions_() {
  return [
    ["UI", "open*/show*/stu_add/onOpen/doGet", "화면·메뉴 함수는 서버 처리시간과 브라우저 렌더링을 분리 측정해야 함"],
    ["데이터변경", "createStudent/updateStudentData", "합성 학생 생명주기 시나리오 필요"],
    ["데이터변경", "processPaymentBatch/updatePaymentData", "합성 수납 및 멱등성 요청 시나리오 필요"],
    ["데이터변경", "saveVacation/updateVacationPeriod/deleteVacationPeriod", "합성 휴가 생명주기 시나리오 필요"],
    ["데이터변경", "updateSiblingGroup/updateSiblingDiscount", "합성 학생 2명 이상 필요"],
    ["데이터변경", "updateCashReceiptTarget", "합성 학생 개인정보 변경 시나리오 필요"],
    ["데이터변경", "restoreTrashItem/purgeExpiredTrash", "삭제·복구 및 보존기간 fixture 필요"],
    ["급여변경", "finalize*/recordSalary*/cancelSalary*", "합성 급여 확정·지급·취소 시나리오 필요"],
    ["설정변경", "saveManagedTeacher/saveManagedUser/prepareTeacherDirectoryData", "관리 데이터 변경 함수"],
    ["시스템변경", "ensureDataSchemas/refreshDashboard/retryPendingEvents", "시트 또는 운영 상태를 변경함"],
    ["외부상태", "createDailyBackup/installMaintenanceTrigger/runScheduledMaintenance", "Drive·트리거·휴지통 상태를 변경함"]
  ];
}

function PerformanceDiagnostics_measure_(runId, round, testCase, startedAllAt) {
  if (Date.now() - startedAllAt > PERFORMANCE_MAX_RUNTIME_MS) {
    return { runId: runId, round: round, category: testCase.category, name: testCase.name,
      durationMs: 0, count: 0, chars: 0, status: "SKIPPED", message: "실행 제한시간 보호" };
  }
  var startedAt = Date.now();
  try {
    var value = testCase.run();
    var info = PerformanceDiagnostics_resultInfo_(value);
    return { runId: runId, round: round, category: testCase.category, name: testCase.name,
      durationMs: Date.now() - startedAt, count: info.count, chars: info.chars, status: "SUCCESS", message: "" };
  } catch (error) {
    return { runId: runId, round: round, category: testCase.category, name: testCase.name,
      durationMs: Date.now() - startedAt, count: 0, chars: 0, status: "ERROR",
      message: String(error && error.message ? error.message : error).substring(0, 500) };
  }
}

function PerformanceDiagnostics_median_(values) {
  var sorted = (values || []).map(Number).filter(function(value) { return isFinite(value); })
    .sort(function(a, b) { return a - b; });
  if (!sorted.length) return 0;
  var middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function PerformanceDiagnostics_writeRows_(spreadsheetName, targetYm, results) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(PERFORMANCE_LOG_SHEET_NAME);
  var headers = ["실행ID", "측정일시", "파일명", "조회월", "회차", "구분", "함수/시나리오", "소요ms", "결과수", "응답문자수", "상태", "오류/제외사유"];
  if (!sheet) {
    sheet = ss.insertSheet(PERFORMANCE_LOG_SHEET_NAME);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  var measuredAt = new Date();
  var rows = results.map(function(item) {
    return [item.runId, measuredAt, spreadsheetName, targetYm, item.round, item.category, item.name,
      item.durationMs, item.count, item.chars, item.status, item.message];
  });
  if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
}

/**
 * 테스트 복사본에서 각 읽기·계산·HTML 생성 함수를 콜드/웜 한 쌍으로 측정합니다.
 * 변경 함수는 실행하지 않고 누락 없이 제외 사유를 기록합니다.
 */
function runFullFunctionPerformanceDiagnostics() {
  requireSuperAdmin_();
  var spreadsheetName = PerformanceDiagnostics_requireTestCopy_();
  var targetYm = PerformanceDiagnostics_previousYm_();
  var runId = createUniqueId_("PERF");
  var startedAllAt = Date.now();
  var fixture = PerformanceDiagnostics_buildFixtures_(targetYm);
  var cases = PerformanceDiagnostics_cases_(fixture);
  var results = [];

  try {
    cases.forEach(function(testCase, caseIndex) {
      // 다른 사례가 먼저 데운 공통 캐시가 콜드 측정에 섞이지 않게 사례별 키를 사용합니다.
      QueryResultCache_namespaceSalt_ = runId + "_" + caseIndex;
      PerformanceDiagnostics_clearReadCaches_();
      results.push(PerformanceDiagnostics_measure_(runId, "COLD_PASS", testCase, startedAllAt));
      results.push(PerformanceDiagnostics_measure_(runId, "WARM_PASS", testCase, startedAllAt));
    });
    // 단 한 번의 웜 측정이 느렸다는 이유로 회귀로 단정하지 않습니다.
    // 최초 비교에서 20%·50ms 이상 느린 후보만 같은 캐시 키로 두 번 더 재측정합니다.
    cases.forEach(function(testCase, caseIndex) {
      var cold = results.filter(function(item) {
        return item.name === testCase.name && item.round === "COLD_PASS" && item.status === "SUCCESS";
      })[0];
      var warm = results.filter(function(item) {
        return item.name === testCase.name && item.round === "WARM_PASS" && item.status === "SUCCESS";
      })[0];
      if (!cold || !warm || warm.durationMs - cold.durationMs < 50 || warm.durationMs <= cold.durationMs * 1.2) return;
      QueryResultCache_namespaceSalt_ = runId + "_" + caseIndex;
      results.push(PerformanceDiagnostics_measure_(runId, "WARM_RECHECK_2", testCase, startedAllAt));
      results.push(PerformanceDiagnostics_measure_(runId, "WARM_RECHECK_3", testCase, startedAllAt));
    });
  } finally {
    QueryResultCache_namespaceSalt_ = "";
    QueryResultCache_runtime_ = {};
    DataRepository_runtimeRows_ = {};
  }
  PerformanceDiagnostics_skippedFunctions_().forEach(function(item) {
    results.push({ runId: runId, round: "NOT_RUN", category: item[0], name: item[1],
      durationMs: 0, count: 0, chars: 0, status: "SKIPPED", message: item[2] });
  });

  PerformanceDiagnostics_writeRows_(spreadsheetName, targetYm, results);
  var successful = results.filter(function(item) { return item.status === "SUCCESS"; });
  var errors = results.filter(function(item) { return item.status === "ERROR"; });
  var slowest = successful.slice().sort(function(a, b) { return b.durationMs - a.durationMs; }).slice(0, 10);
  var pairsByName = {};
  successful.forEach(function(item) {
    if (!pairsByName[item.name]) pairsByName[item.name] = {};
    pairsByName[item.name][item.round] = item;
    if (item.round.indexOf("WARM_") === 0 || item.round === "WARM_PASS") {
      if (!pairsByName[item.name].warmSamples) pairsByName[item.name].warmSamples = [];
      pairsByName[item.name].warmSamples.push(Number(item.durationMs) || 0);
    }
  });
  var warmComparisons = Object.keys(pairsByName).map(function(name) {
    var pair = pairsByName[name];
    if (!pair.COLD_PASS || !pair.WARM_PASS) return null;
    var coldMs = Number(pair.COLD_PASS.durationMs) || 0;
    var warmSamples = pair.warmSamples && pair.warmSamples.length ? pair.warmSamples : [Number(pair.WARM_PASS.durationMs) || 0];
    var warmMs = PerformanceDiagnostics_median_(warmSamples);
    return {
      name:name, category:pair.COLD_PASS.category, coldMs:coldMs, warmMs:warmMs,
      warmSamples:warmSamples,
      savingMs:coldMs - warmMs,
      improvementPercent:coldMs > 0 ? Math.round((coldMs - warmMs) * 100 / coldMs) : 0
    };
  }).filter(Boolean).sort(function(a, b) { return b.savingMs - a.savingMs; });
  var summary = {
    runId: runId,
    targetYm: targetYm,
    monthlySnapshotEnabled:MonthlySnapshotStore_isEnabled_(),
    totalMs: Date.now() - startedAllAt,
    measured: successful.length,
    errors: errors.length,
    skipped: results.filter(function(item) { return item.status === "SKIPPED"; }).length,
    slowest: slowest,
    warmComparisons:warmComparisons.slice(0, 10),
    warmRegressions:warmComparisons.filter(function(item) {
      return item.warmMs - item.coldMs >= 50 && item.warmMs > item.coldMs * 1.2;
    }).sort(function(a, b) { return (b.warmMs - b.coldMs) - (a.warmMs - a.coldMs); }).slice(0, 10),
    errorDetails: errors.slice(0, 20)
  };
  console.log("[전체 함수 성능 진단] " + JSON.stringify(summary));
  return summary;
}

function runFullFunctionPerformanceDiagnosticsFromMenu() {
  requireSpreadsheetSuperAdmin_();
  var result = runFullFunctionPerformanceDiagnostics();
  var lines = [
    "실행 ID: " + result.runId,
    "조회 월: " + result.targetYm,
    "스냅샷: " + (result.monthlySnapshotEnabled ? "사용 중" : "미적용(원본 계산)"),
    "전체 시간: " + result.totalMs + "ms",
    "측정 성공: " + result.measured + "건 / 오류: " + result.errors + "건 / 제외: " + result.skipped + "건",
    "",
    "가장 느린 항목"
  ];
  result.slowest.slice(0, 5).forEach(function(item) {
    lines.push(item.round + " · " + item.name + " · " + item.durationMs + "ms");
  });
  lines.push("", "재조회 절감 상위");
  (result.warmComparisons || []).slice(0, 3).forEach(function(item) {
    lines.push(item.name + " · " + item.coldMs + "→" + item.warmMs + "ms (" + item.improvementPercent + "%)");
  });
  if ((result.warmRegressions || []).length) {
    lines.push("", "재조회가 더 느린 항목: " + result.warmRegressions.length + "건 (관리_성능로그 확인)");
  }
  SpreadsheetApp.getUi().alert("전체 함수 성능 진단", lines.join("\n"), SpreadsheetApp.getUi().ButtonSet.OK);
  return result;
}
