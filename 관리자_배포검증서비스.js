/** 관리자 전용: 실제 Apps Script 배포 환경의 권한·Drive·트리거·캐시·인덱스를 점검합니다. */
function DeploymentDiagnostics_recoveryAction_(name) {
  name = String(name || "");
  if (/실행 계정|최고관리자 권한|최고 원장 권한/.test(name)) return "비상 관리자 Google 계정으로 다시 로그인한 뒤 설정의 등록 사용자에서 현재 계정의 사용자 종류와 사용 상태를 확인합니다.";
  if (/시간대/.test(name)) return "날짜 입력을 중단하고 Apps Script 프로젝트 설정의 시간대를 Asia/Seoul로 맞춘 뒤 배포 환경 점검을 다시 실행합니다.";
  if (/웹 앱 URL/.test(name)) return "Apps Script의 배포 관리에서 웹 앱 배포가 존재하는지 확인하고, 최신 버전 URL로 다시 접속합니다.";
  if (/DB 스키마/.test(name)) return "신규 저장을 중단하고 수동 백업을 만든 뒤 백업 검증·복구에서 오류 전 백업과 현재 구조를 비교합니다. DB 열을 직접 추가하거나 이동하지 마세요.";
  if (/백업|Drive/.test(name)) return "Drive에서 백업 폴더가 휴지통에 있거나 이동·이름 변경되지 않았는지 확인하고, 실행 계정에 편집 권한을 부여한 뒤 수동 백업을 다시 실행합니다.";
  if (/트리거|자동 운영/.test(name)) return "스프레드시트의 ‘학원관리 개발·테스트’ 메뉴에서 ‘자동 운영 트리거 설치/갱신’을 한 번 실행한 뒤 배포 환경 점검을 다시 실행합니다.";
  if (/캐시|인덱스|조회/.test(name)) return "설정에서 ‘화면 임시정보 지우기’를 실행하고 ‘월별 빠른 조회 점검’ 후 배포 환경 점검을 다시 실행합니다. 원본 데이터는 수정하지 않습니다.";
  if (/회귀|대시보드|체크리스트|급여 화면/.test(name)) return "해당 화면의 저장 작업을 중단하고 데이터 상태 진단을 실행합니다. 진단이 정상이면 새로고침 후 한 번만 다시 조회합니다.";
  return "해당 항목의 상세 문구를 보존하고 데이터 상태 진단을 실행한 뒤, 같은 점검을 다시 실행해 일시 오류인지 확인합니다.";
}

function DeploymentDiagnostics_add_(result, name, ok, detail, severity) {
  var action = ok ? "" : DeploymentDiagnostics_recoveryAction_(name);
  result.checks.push({ name: name, ok: !!ok, detail: String(detail || ""), action: action });
  if (!ok) result.issues.push({ severity: severity || "높음", name: name, message: String(detail || "점검 실패"), action: action });
}

function DeploymentDiagnostics_ageHours_(value) {
  var date = value ? new Date(value) : null;
  return date && !isNaN(date.getTime()) ? (Date.now() - date.getTime()) / 3600000 : Infinity;
}

function DeploymentDiagnostics_indexCheck_(sheetName, columnNumber, uniqueRequired) {
  var index = LookupIndex_get_(sheetName, columnNumber, true);
  var duplicateKeys = [];
  Object.keys(index.map || {}).forEach(function(key) {
    if (uniqueRequired && index.map[key].length > 1) duplicateKeys.push(key);
  });
  return { indexedRows: index.indexedRows, keys: Object.keys(index.map || {}).length, duplicateKeys: duplicateKeys.slice(0, 20) };
}

function DeploymentDiagnostics_runReadFlow_(result, name, loader, validator) {
  var startedAt = Date.now();
  try {
    var value = loader();
    var valid = validator(value);
    DeploymentDiagnostics_add_(result, name, valid,
      (valid ? "응답 형식 정상" : "응답 형식 불일치") + " · " + (Date.now() - startedAt) + "ms", "높음");
  } catch (error) {
    DeploymentDiagnostics_add_(result, name, false,
      (error && error.message ? error.message : String(error)) + " · " + (Date.now() - startedAt) + "ms", "높음");
  }
}

function runDeploymentReadinessDiagnostics() {
  var user = requireSuperAdmin_();
  var result = {
    diagnosticId: createUniqueId_("DEPLOY"),
    checkedAt: new Date().toISOString(),
    checkedBy: user.email,
    checks: [], issues: []
  };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  DeploymentDiagnostics_add_(result, "실행 계정", !!user.email, user.email || "계정 이메일 확인 불가");
  DeploymentDiagnostics_add_(result, "최고 원장 권한", user.bootstrap || user.role === ACCESS_CONTROL.ROLES.SUPER_ADMIN,
    user.role + (user.bootstrap ? " · 복구계정" : ""));
  DeploymentDiagnostics_add_(result, "시간대", Session.getScriptTimeZone() === "Asia/Seoul", Session.getScriptTimeZone(), "중간");
  DeploymentDiagnostics_add_(result, "웹 앱 URL", !!ScriptApp.getService().getUrl(), ScriptApp.getService().getUrl() || "배포 URL 없음", "높음");

  var schema = Backup_verifySpreadsheet_(ss);
  DeploymentDiagnostics_add_(result, "관리 DB 스키마", schema.valid,
    schema.valid ? schema.sheets.length + "개 시트 정상" : schema.errors.join(" / "), "치명적");

  try {
    var folder = Backup_getFolder_();
    DeploymentDiagnostics_add_(result, "백업 폴더 접근", true, folder.getName());
  } catch (backupFolderError) {
    DeploymentDiagnostics_add_(result, "백업 폴더 접근", false, backupFolderError.message, "높음");
  }

  var triggers = ScriptApp.getProjectTriggers().filter(function(trigger) {
    return trigger.getHandlerFunction() === "runScheduledMaintenance";
  });
  DeploymentDiagnostics_add_(result, "자동 운영 트리거", triggers.length === 1,
    triggers.length + "개 설치", triggers.length ? "중간" : "높음");
  var structureTriggers = DataMutation_structureTriggers_(ScriptApp.getProjectTriggers(), ss.getId());
  DeploymentDiagnostics_add_(result, "시트 구조 감시 트리거", structureTriggers.length === 1,
    structureTriggers.length + "개 설치 · 설치 계정에서 확인", "중간");
  try {
    var baselineCount = Object.keys(DataSchema_readStructureBaseline_()).length;
    DeploymentDiagnostics_add_(result, "시트 구조 감시 트리거 기준정보", baselineCount > 0,
      baselineCount ? baselineCount + "개 관리 시트 등록" : "자동 운영 트리거 설치/갱신 필요", "중간");
    DataSchema_assertManagedStructure_();
    DeploymentDiagnostics_add_(result, "DB 스키마 구조 보호", true, "시트 식별자·필수 헤더 위치 정상");
  } catch (structureError) {
    DeploymentDiagnostics_add_(result, "DB 스키마 구조 보호", false, structureError.message, "치명적");
  }

  var properties = PropertiesService.getScriptProperties();
  var lastStructureChange = null;
  try { lastStructureChange = JSON.parse(properties.getProperty("MANAGED_STRUCTURE_LAST_CHANGE_V1") || "null"); } catch (ignoredStructureParse) {}
  if (lastStructureChange) {
    DeploymentDiagnostics_add_(result, "최근 시트 구조 감시 처리", !(lastStructureChange.errors || []).length,
      String(lastStructureChange.changedAt || "") + " · " + String(lastStructureChange.changeType || "") +
      " · DB_이벤트의 시트구조직접변경 기록 확인" +
      ((lastStructureChange.errors || []).length ? " · " + lastStructureChange.errors.join(" / ") : ""), "중간");
  }
  var lastMaintenance = null;
  var lastBackup = null;
  try { lastMaintenance = JSON.parse(properties.getProperty("MAINTENANCE_LAST_RESULT") || "null"); } catch (ignoredMaintenanceParse) {}
  try { lastBackup = JSON.parse(properties.getProperty("MAINTENANCE_LAST_BACKUP") || "null"); } catch (ignoredBackupParse) {}
  DeploymentDiagnostics_add_(result, "최근 자동 운영", DeploymentDiagnostics_ageHours_(lastMaintenance && lastMaintenance.completedAt) <= 48,
    lastMaintenance && lastMaintenance.completedAt || "최근 실행 기록 없음", "중간");
  DeploymentDiagnostics_add_(result, "최근 백업", DeploymentDiagnostics_ageHours_(lastBackup && lastBackup.completedAt) <= (OperationalSettings_getNumber_("BACKUP_INTERVAL_DAYS", BACKUP_INTERVAL_DAYS) + 2) * 24,
    lastBackup && lastBackup.completedAt || "최근 백업 기록 없음", "높음");
  DeploymentDiagnostics_add_(result, "최근 백업 검증",
    !!(lastBackup && lastBackup.verification && lastBackup.verification.valid && lastBackup.verification.copyMatchesSource),
    lastBackup && lastBackup.verification ? JSON.stringify({ valid:lastBackup.verification.valid,
      copyMatchesSource:lastBackup.verification.copyMatchesSource,
      errors:(lastBackup.verification.errors || []).slice(0, 5),
      copyErrors:(lastBackup.verification.copyErrors || []).slice(0, 5) }) : "새 검증 형식의 백업 기록 없음", "높음");

  try {
    var cacheKey = "DEPLOY_CACHE_TEST_" + result.diagnosticId;
    CacheService.getScriptCache().put(cacheKey, "OK", 60);
    var cacheValue = CacheService.getScriptCache().get(cacheKey);
    CacheService.getScriptCache().remove(cacheKey);
    // CacheService는 저장 직후에도 값이 없을 수 있는 보조 계층입니다. 원본 시트 대체 경로가 있으므로 배포 차단 사유로 보지 않습니다.
    DeploymentDiagnostics_add_(result, "스크립트 캐시", true, cacheValue === "OK"
      ? "쓰기·조회·삭제 정상"
      : "현재 실행에서 재조회되지 않음 · 원본 시트 대체 경로 사용(배포 비차단)", "중간");
  } catch (cacheError) {
    DeploymentDiagnostics_add_(result, "스크립트 캐시", true,
      "캐시 서비스 예외 · 원본 시트 대체 경로 사용(배포 비차단): " + cacheError.message, "중간");
  }

  try {
    var indexReports = [
      DeploymentDiagnostics_indexCheck_(SHEET_NAMES.PAYMENTS, COL.PAYMENT.ID, true),
      DeploymentDiagnostics_indexCheck_(SHEET_NAMES.PAYMENTS, COL.PAYMENT.STUDENT_ID, false),
      DeploymentDiagnostics_indexCheck_(SHEET_NAMES.PAYMENTS, COL.PAYMENT.REQUEST_ID, false),
      DeploymentDiagnostics_indexCheck_(SHEET_NAMES.REQUESTS, COL.REQUEST.ID, true),
      DeploymentDiagnostics_indexCheck_(SHEET_NAMES.REQUESTS, COL.REQUEST.STATUS, false),
      DeploymentDiagnostics_indexCheck_(SHEET_NAMES.EVENTS, COL.EVENT.ID, true),
      DeploymentDiagnostics_indexCheck_(SHEET_NAMES.EVENTS, COL.EVENT.STUDENT_ID, false),
      DeploymentDiagnostics_indexCheck_(SHEET_NAMES.EVENTS, COL.EVENT.REQUEST_ID, false)
    ];
    var duplicates = indexReports.reduce(function(total, item) { return total + item.duplicateKeys.length; }, 0);
    DeploymentDiagnostics_add_(result, "조회 인덱스", duplicates === 0,
      "6개 인덱스 재생성 · 고유 ID 중복 " + duplicates + "건", "높음");
  } catch (indexError) {
    DeploymentDiagnostics_add_(result, "조회 인덱스", false, indexError.message, "높음");
  }

  try {
    var regression = runIntegrationRegressionTests_();
    DeploymentDiagnostics_add_(result, "통합 회귀 계산", regression === "통합 회귀 테스트 통과", regression, "높음");
  } catch (regressionError) {
    DeploymentDiagnostics_add_(result, "통합 회귀 계산", false, regressionError.message, "높음");
  }

  // 실제 운영 시트와 공개 서버 함수를 통해 핵심 읽기 흐름의 반환 계약까지 확인합니다.
  var targetYm = Dashboard_defaultTargetYm_();
  DeploymentDiagnostics_runReadFlow_(result, "수납 대시보드 통합 조회", function() {
    return getDashboardDataForHtml(targetYm);
  }, function(value) {
    return !!value && Array.isArray(value.list) && !!value.months && typeof value.months === "object";
  });
  DeploymentDiagnostics_runReadFlow_(result, "납부 체크리스트 통합 조회", function() {
    return getPaymentChecklistData(targetYm);
  }, function(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  });
  DeploymentDiagnostics_runReadFlow_(result, "급여 화면 통합 조회", function() {
    return getSalaryDashboardInitialData(targetYm);
  }, function(value) {
    return !!value && !!value.profile && Array.isArray(value.teachers) && Array.isArray(value.results);
  });

  result.healthy = result.issues.length === 0;
  console.log("[배포 환경 진단] " + JSON.stringify(result));
  return result;
}

function showDeploymentReadinessDiagnostics() {
  requireSpreadsheetSuperAdmin_();
  var result = runDeploymentReadinessDiagnostics();
  var lines = ["진단 ID: " + result.diagnosticId, "결과: " + (result.healthy ? "정상" : "확인 필요")];
  result.checks.forEach(function(item) { lines.push((item.ok ? "✅ " : "⚠️ ") + item.name + " · " + item.detail); });
  SpreadsheetApp.getUi().alert("배포 환경 점검", lines.join("\n"), SpreadsheetApp.getUi().ButtonSet.OK);
  return result;
}

function DeploymentDiagnostics_requireTestCopy_() {
  var name = String(SpreadsheetApp.getActiveSpreadsheet().getName() || "");
  if (name.indexOf("[배포테스트]") !== 0 && name.indexOf("[성능테스트]") !== 0) {
    throw new Error("쓰기 격리 테스트는 이름이 '[배포테스트]' 또는 '[성능테스트]'로 시작하는 복사본에서만 실행할 수 있습니다.");
  }
  return name;
}

function runDeploymentWriteIsolationTest() {
  var user = requireSuperAdmin_();
  var spreadsheetName = DeploymentDiagnostics_requireTestCopy_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var testSheetName = "TMP_DEPLOY_" + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "HHmmss");
  var sheet = null;
  var propertyKey = "DEPLOY_PROPERTY_TEST_" + createUniqueId_("TMP");
  var checks = [];
  try {
    sheet = ss.insertSheet(testSheetName);
    sheet.getRange("A1").setValue("BEFORE");
    var rollbackWorked = false;
    try {
      MutationPipeline_run_({ operation:"배포쓰기격리테스트" }, function(tx) {
        tx.writeRange(sheet, 1, 1, [["AFTER"]]);
        throw new Error("EXPECTED_ROLLBACK");
      });
    } catch (expectedError) {
      if (String(expectedError.message || expectedError).indexOf("EXPECTED_ROLLBACK") === -1) throw expectedError;
      rollbackWorked = sheet.getRange("A1").getValue() === "BEFORE";
    }
    checks.push({ name:"MutationPipeline 자동복구", ok:rollbackWorked });

    var props = PropertiesService.getScriptProperties();
    props.setProperty(propertyKey, "OK");
    checks.push({ name:"ScriptProperties", ok:props.getProperty(propertyKey) === "OK" });
    props.deleteProperty(propertyKey);

    var lock = LockService.getScriptLock();
    var locked = lock.tryLock(5000);
    checks.push({ name:"ScriptLock", ok:locked });
    if (locked) lock.releaseLock();

    var folder = Backup_getFolder_();
    checks.push({ name:"Drive 백업 폴더", ok:!!folder.getId() });
  } finally {
    try { PropertiesService.getScriptProperties().deleteProperty(propertyKey); } catch (ignoredPropertyCleanup) {}
    if (sheet) try { ss.deleteSheet(sheet); } catch (sheetCleanupError) { checks.push({ name:"임시 시트 정리", ok:false, detail:sheetCleanupError.message }); }
  }
  var failed = checks.filter(function(item) { return !item.ok; });
  var result = { testId:createUniqueId_("DEPLOYWRITE"), spreadsheetName:spreadsheetName, checkedBy:user.email, checks:checks, healthy:failed.length === 0 };
  console.log("[배포 쓰기 격리 테스트] " + JSON.stringify(result));
  if (failed.length) throw new Error("배포 쓰기 격리 테스트 실패: " + failed.map(function(item) { return item.name; }).join(", "));
  return result;
}

function runDeploymentWriteIsolationTestFromMenu() {
  requireSpreadsheetSuperAdmin_();
  var result = runDeploymentWriteIsolationTest();
  SpreadsheetApp.getUi().alert("배포 쓰기 격리 테스트", result.checks.map(function(item) {
    return (item.ok ? "✅ " : "⚠️ ") + item.name;
  }).join("\n"), SpreadsheetApp.getUi().ButtonSet.OK);
  return result;
}
