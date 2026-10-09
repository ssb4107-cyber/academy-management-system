/** 관리자 메뉴와 직접 실행 진입점 */
function onOpen() {
  var ui = SpreadsheetApp.getUi();
  var access = null;
  try { access = requireSpreadsheetAuthorizedUser_(); } catch (accessError) {}
  var isSuperAdmin = !!(access && (access.bootstrap || access.role === ACCESS_CONTROL.ROLES.SUPER_ADMIN));

  if (!isSuperAdmin) {
    var limitedMenu = ui.createMenu('🎓 학원관리');
    if (access && access.role === ACCESS_CONTROL.ROLES.MANAGER) {
      limitedMenu
        .addItem('담당 학생 관리 열기', 'openManagerPortalLink')
        .addItem('📘 사용 설명서', 'openManual');
    } else {
      limitedMenu.addItem('접근 권한 안내', 'showAccessDeniedMessage');
    }
    limitedMenu.addToUi();
    return;
  }

  ui.createMenu('🧪 학원관리 개발·테스트')
    .addItem('   ➕ 학생 등록', 'stu_add')
    .addItem('   ✏️ 학생 정보 수정/퇴원처리', 'showEditPopup')
    .addItem('   🏖️ 학생 휴가 등록', 'showVacationPopup')
    .addItem('   👨‍👩‍👧‍👦 형제/자매 관계 설정', 'openSiblingManager')
    .addItem('   🖨️ 전체 학생 명단 인쇄', 'openStudentRosterPrint')

    .addSeparator()
    .addItem('   📊 수납 대시보드 열기(납부 기록)', 'openHtmlDashboard')
    .addItem('   🧾 수납 내역 수정', 'showPaymentEditPopup')
    .addItem('   🗑️ 휴지통', 'openTrashManager')
    .addItem('   ⚙️ 자동 운영 트리거 설치/갱신', 'installMaintenanceTrigger')
    .addItem('   ℹ️ 자동 운영 상태 확인', 'showMaintenanceStatus')
    .addItem('   ✅ 납부 체크리스트', 'openPaymentChecklistModal')
    .addItem('   🧾 현금영수증 명부', 'openCashReceiptModal')
    .addItem('   📈 기간별 통계', 'openStatisticsDashboard')

    .addSeparator()
    .addItem('   💰 급여 관리', 'showSalaryDashboard')
    .addItem('   👩‍🏫 원장 관리', 'openTeacherManagement')
    .addItem('   🧩 원장 데이터 생성/보완', 'prepareTeacherDirectoryDataFromMenu')
    .addItem('   🪪 기존 원장 ID 이관', 'migrateLegacyTeacherIdsFromMenu')

    .addSeparator()
    .addItem('⚙️ 설정 및 사용자 권한', 'openSettingsDashboard')
    .addItem('📘 사용 설명서', 'openManual')
    .addItem('🕘 변경 이력 보기', 'openChangeLogViewer')
    .addItem('🚦 배포 전 필수 점검 한 번에', 'runAdminReleaseChecksFromMenu')
    .addItem('🩺 데이터 상태 진단', 'showSystemDataDiagnostics')
    .addItem('🧱 DB 구조 점검/보완', 'showDataSchemaStatus')
    .addItem('🧪 통합 회귀 테스트 실행', 'runIntegrationRegressionTestsFromMenu')
    .addItem('🌐 배포 환경 비파괴 점검', 'showDeploymentReadinessDiagnostics')
    .addItem('🧪 배포 쓰기 격리 테스트(복사본 전용)', 'runDeploymentWriteIsolationTestFromMenu')
    .addItem('⏱️ 전체 함수 성능 진단(복사본 전용)', 'runFullFunctionPerformanceDiagnosticsFromMenu')
    .addSeparator()
    .addItem('🧊 월별 조회 속도 기능 미리 점검', 'runAdminMonthlySnapshotPreflightFromMenu')
    .addItem('▶️ 월별 빠른 조회 사용 시작', 'enableAdminMonthlySnapshotDeploymentFromMenu')
    .addItem('⏸️ 월별 빠른 조회 사용 중지', 'disableAdminMonthlySnapshotDeploymentFromMenu')
    .addItem('🔄 바탕화면 새로고침', 'refreshDashboard')
    .addToUi();

  refreshDashboardIfNeeded_();
}

function openManagerPortalLink() {
  var user = requireSpreadsheetAuthorizedUser_();
  if (user.role !== ACCESS_CONTROL.ROLES.MANAGER || user.bootstrap) throw new Error("관리 원장님 전용 기능입니다.");
  var url = ScriptApp.getService().getUrl();
  var html = HtmlService.createHtmlOutput('<div style="font-family:sans-serif;padding:22px;text-align:center"><h3>담당 학생 관리</h3><p><a href="' + url + '" target="_blank" style="display:inline-block;padding:12px 20px;background:#1a73e8;color:white;text-decoration:none;border-radius:8px;font-weight:bold">관리 화면 열기</a></p></div>')
    .setWidth(360).setHeight(190);
  SpreadsheetApp.getUi().showModalDialog(html, "담당 학생 관리");
}

function showAccessDeniedMessage() {
  AccessControl_assertSpreadsheetUiContext_();
  SpreadsheetApp.getUi().alert("이 Google 계정은 학원관리 시스템 사용 권한이 없거나 비활성 상태입니다.");
}

function runIntegrationRegressionTestsFromMenu() {
  requireSpreadsheetSuperAdmin_();
  var result = runIntegrationRegressionTests_();
  SpreadsheetApp.getUi().alert("통합 회귀 테스트", result, SpreadsheetApp.getUi().ButtonSet.OK);
  return result;
}

function openManual() {
  requireSpreadsheetAuthorizedUser_();
  var html = HtmlService.createTemplateFromFile('Manual').evaluate()
      .setWidth(950)
      .setHeight(800)
      .setTitle('학원 관리 시스템 사용 설명서');
  SpreadsheetApp.getUi().showModelessDialog(html, '📘 사용 설명서');
}
