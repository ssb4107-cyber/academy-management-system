/**
 * 최고관리자가 배포 전 한 번 실행하는 읽기 중심 종합 점검입니다.
 * 스프레드시트 상단 메뉴: 학원관리 개발·테스트 → 배포 전 필수 점검 한 번에
 */
function runAdminReleaseChecksFromMenu() {
  var user = requireSpreadsheetSuperAdmin_();
  var result = { checkedAt:new Date().toISOString(), checkedBy:user.email, checks:[], healthy:true };

  function run(name, callback, summarize) {
    try {
      var value = callback();
      var summary = summarize(value);
      result.checks.push({ name:name, ok:summary.ok, detail:summary.detail });
      if (!summary.ok) result.healthy = false;
    } catch (error) {
      result.healthy = false;
      result.checks.push({ name:name, ok:false, detail:error && error.message ? error.message : String(error) });
    }
  }

  run("통합 회귀 테스트", runIntegrationRegressionTests_, function(value) {
    return { ok:String(value || "").indexOf("통과") !== -1, detail:String(value || "결과 없음") };
  });
  run("시스템 데이터 진단", runSystemDataDiagnostics, function(value) {
    var issues = value && value.issues || [];
    var notices = value && value.notices || [];
    return { ok:!!(value && value.healthy), detail:"진단 ID " + String(value && value.diagnosticId || "-") +
      " · 확인 필요 " + issues.length + "건" + (notices.length ? " · 안내 " + notices.length + "건" : "") };
  });
  run("배포 환경 비파괴 점검", runDeploymentReadinessDiagnostics, function(value) {
    var issues = value && value.issues || [];
    return { ok:!!(value && value.healthy), detail:"진단 ID " + String(value && value.diagnosticId || "-") + " · 확인 필요 " + issues.length + "건" };
  });
  run("월별 스냅샷 적용 상태", getAdminMonthlySnapshotDeploymentStatus, function(value) {
    if (!value.enabled) return { ok:true, detail:"미적용(원본 계산 사용 중)" };
    var preflight = value.preflight || {};
    return {
      ok:!!value.sheetReady && !!preflight.healthy,
      detail:value.sheetReady
        ? "사용 중 · 저장 " + value.storedRows + "행 · 최근 사전검증 " + String(preflight.checkedAt || "확인 안 됨")
        : "사용 설정은 켜졌으나 캐시 시트가 없습니다. 즉시 사용 중지 필요"
    };
  });

  var lines = [
    "배포 전 필수 점검",
    "결과: " + (result.healthy ? "모두 통과" : "확인 필요"),
    ""
  ];
  result.checks.forEach(function(check) {
    lines.push((check.ok ? "✅ " : "⚠️ ") + check.name + " · " + check.detail);
  });
  if (!result.healthy) {
    lines.push("", "권장 처리 순서", "1. DB 구조 점검/보완", "2. 설정에서 새 백업 생성", "3. 배포 전 필수 점검 재실행");
  }
  SpreadsheetApp.getUi().alert("배포 전 필수 점검", lines.join("\n"), SpreadsheetApp.getUi().ButtonSet.OK);
  return result;
}

/**
 * OAuth 외부 요청 권한 오류가 발생한 경우에만 Apps Script 편집기에서 실행합니다.
 * 정상 로그인 중이라면 따로 실행할 필요가 없습니다.
 */
function runAdminOAuthPermissionSetup() {
  requireSpreadsheetSuperAdmin_();
  return authorizeGoogleOAuthNetworkAccess_();
}

/** 현재 스냅샷 적용 상태를 원본 변경 없이 확인합니다. */
function getAdminMonthlySnapshotDeploymentStatus() {
  requireSuperAdmin_();
  var properties = PropertiesService.getScriptProperties();
  var raw = properties.getProperty(MONTHLY_SNAPSHOT_PREFLIGHT_KEY);
  var preflight = null;
  try { preflight = raw ? JSON.parse(raw) : null; } catch (ignoredParseError) {}
  var sheet = MonthlySnapshotStore_getSheet_(false);
  return {
    enabled:MonthlySnapshotStore_isEnabled_(),
    sheetReady:!!sheet,
    storedRows:sheet ? Math.max(0, sheet.getLastRow() - 1) : 0,
    preflight:preflight
  };
}

/**
 * 적용 전 검증 및 예열입니다. 원본 DB는 변경하지 않고 숨김 캐시 시트만 작성합니다.
 * 월을 생략하면 직전 12개월부터 다음 달까지를 한 번의 원본 조회로 검증합니다.
 */
function runAdminMonthlySnapshotPreflight(targetMonths) {
  var user = requireSuperAdmin_();
  var now = new Date();
  var currentYm = now.getFullYear() + "-" + ("0" + (now.getMonth() + 1)).slice(-2);
  var months = Array.isArray(targetMonths) ? targetMonths.slice() : [];
  if (!months.length) {
    for (var offset = -12; offset <= 1; offset++) months.push(Dashboard_shiftMonth_(currentYm, offset));
  }
  var seen = {};
  months = months.map(function(month) { return requireMonthString_(month, "점검 월"); })
    .filter(function(month) {
      if (seen[month]) return false;
      seen[month] = true;
      return true;
    }).slice(0, 24);
  if (!months.length) throw new Error("점검할 월이 없습니다.");

  var context = DataRepository_loadContext_([
    SHEET_NAMES.STUDENTS, SHEET_NAMES.PAYMENTS, SHEET_NAMES.VACATIONS, SHEET_NAMES.LOGS
  ], { required:false, fresh:true, cache:false });
  var prepared = MonthlySnapshot_prepareContext_(context);
  var results = [];
  months.forEach(function(targetYm) {
    context.__monthlySnapshotPartial = true;
    var calculated = MonthlySnapshot_build_(targetYm, context);
    delete context.__monthlySnapshotPartial;
    var sourceVersion = MonthlySnapshotStore_sourceVersion_(targetYm);
    var writeStatus = MonthlySnapshotStore_write_(targetYm, calculated.students, true, sourceVersion, true);
    var stored = MonthlySnapshotStore_read_(targetYm, prepared, true, true);
    var mismatchCount = 0, samples = [];
    calculated.students.forEach(function(student) {
      var expected = JSON.stringify(MonthlySnapshotStore_toFact_(student));
      var fact = stored.facts && stored.facts[student.id];
      var actual = fact ? JSON.stringify(MonthlySnapshotStore_toFact_(fact)) : "";
      if (expected !== actual) {
        mismatchCount++;
        if (samples.length < 5) samples.push({ studentId:student.id, studentName:student.name });
      }
    });
    context.__monthlySnapshotForceRead = true;
    var replayed = MonthlySnapshot_build_(targetYm, context);
    delete context.__monthlySnapshotForceRead;
    var outputParity = JSON.stringify(MonthlySnapshotStore_parityPayload_(calculated)) ===
      JSON.stringify(MonthlySnapshotStore_parityPayload_(replayed));
    results.push({
      targetYm:targetYm, students:calculated.students.length, sourceVersion:sourceVersion,
      writeStatus:writeStatus, readStatus:stored.status,
      mismatchCount:mismatchCount, mismatchSamples:samples,
      outputParity:outputParity,
      healthy:!!stored.facts && mismatchCount === 0 && outputParity && String(writeStatus).indexOf("stored_") === 0
    });
  });

  var report = {
    checkedAt:new Date().toISOString(), checkedBy:user.email, months:months,
    healthy:results.every(function(item) { return item.healthy; }), results:results
  };
  var properties = PropertiesService.getScriptProperties();
  if (report.healthy) properties.setProperty(MONTHLY_SNAPSHOT_PREFLIGHT_KEY, JSON.stringify(report));
  else properties.deleteProperty(MONTHLY_SNAPSHOT_PREFLIGHT_KEY);
  return report;
}

/** 최근 사전검증 결과와 현재 원본 버전이 모두 같을 때만 스냅샷을 활성화합니다. */
function enableAdminMonthlySnapshotDeployment() {
  requireSuperAdmin_();
  var properties = PropertiesService.getScriptProperties();
  var raw = properties.getProperty(MONTHLY_SNAPSHOT_PREFLIGHT_KEY);
  if (!raw) throw new Error("먼저 스냅샷 적용 전 검증을 실행해주세요.");
  var report;
  try { report = JSON.parse(raw); }
  catch (error) { throw new Error("스냅샷 사전검증 기록이 손상되었습니다. 검증을 다시 실행해주세요."); }
  var checkedAt = new Date(report.checkedAt || 0);
  if (!report.healthy || isNaN(checkedAt.getTime()) || Date.now() - checkedAt.getTime() > 24 * 60 * 60 * 1000) {
    throw new Error("사전검증이 없거나 24시간이 지났습니다. 검증을 다시 실행해주세요.");
  }
  (report.results || []).forEach(function(item) {
    if (MonthlySnapshotStore_sourceVersion_(item.targetYm) !== item.sourceVersion) {
      throw new Error(item.targetYm + " 원본이 사전검증 후 변경되었습니다. 검증을 다시 실행해주세요.");
    }
  });
  properties.setProperty(MONTHLY_SNAPSHOT_ENABLED_KEY, "true");
  QueryResultCache_runtime_ = {};
  return getAdminMonthlySnapshotDeploymentStatus();
}

/** 문제가 의심될 때 원본 계산으로 즉시 돌아갑니다. 저장된 캐시는 원본 DB와 분리되어 보존됩니다. */
function disableAdminMonthlySnapshotDeployment() {
  requireSuperAdmin_();
  PropertiesService.getScriptProperties().setProperty(MONTHLY_SNAPSHOT_ENABLED_KEY, "false");
  QueryResultCache_runtime_ = {};
  return getAdminMonthlySnapshotDeploymentStatus();
}

function runAdminMonthlySnapshotPreflightFromMenu() {
  requireSpreadsheetSuperAdmin_();
  var result = runAdminMonthlySnapshotPreflight();
  var failed = result.results.filter(function(item) { return !item.healthy; });
  SpreadsheetApp.getUi().alert(
    "스냅샷 적용 전 검증",
    (result.healthy ? "검증과 예열이 완료되었습니다." : "확인이 필요한 월이 있습니다.") +
      "\n점검 월: " + result.months[0] + " ~ " + result.months[result.months.length - 1] +
      "\n정상: " + (result.results.length - failed.length) + "건 / 확인 필요: " + failed.length + "건" +
      (result.healthy ? "\n이제 '스냅샷 사용 시작'을 눌러도 됩니다." : "\n사용 시작 전 오류 월을 먼저 확인해주세요."),
    SpreadsheetApp.getUi().ButtonSet.OK
  );
  return result;
}

function enableAdminMonthlySnapshotDeploymentFromMenu() {
  requireSpreadsheetSuperAdmin_();
  var ui = SpreadsheetApp.getUi();
  if (ui.alert("스냅샷 사용 시작", "최근 사전검증 결과로 스냅샷 사용을 시작할까요?", ui.ButtonSet.YES_NO) !== ui.Button.YES) {
    return { cancelled:true };
  }
  var status = enableAdminMonthlySnapshotDeployment();
  ui.alert("스냅샷 사용 시작", "활성화되었습니다. 문제가 의심되면 메뉴의 '스냅샷 사용 중지'로 즉시 원본 계산으로 돌아갈 수 있습니다.", ui.ButtonSet.OK);
  return status;
}

function disableAdminMonthlySnapshotDeploymentFromMenu() {
  requireSpreadsheetSuperAdmin_();
  var ui = SpreadsheetApp.getUi();
  if (ui.alert("스냅샷 사용 중지", "스냅샷 사용을 중지하고 원본 계산으로 돌아갈까요?", ui.ButtonSet.YES_NO) !== ui.Button.YES) {
    return { cancelled:true };
  }
  var status = disableAdminMonthlySnapshotDeployment();
  ui.alert("스냅샷 사용 중지", "중지되었습니다. 원본 DB와 기존 수납 기록은 변경되지 않았습니다.", ui.ButtonSet.OK);
  return status;
}
