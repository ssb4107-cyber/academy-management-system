function assertEqual_(label, actual, expected) {
  if (actual !== expected) throw new Error(label + " 실패: expected=" + expected + ", actual=" + actual);
}

function runIntegrationRegressionTests_() {
  assertEqual_("최고 원장 권한 경로", AccessControl_getPortalRoute_({ role:ACCESS_CONTROL.ROLES.SUPER_ADMIN }), "A_SUPER_ADMIN");
  assertEqual_("관리 원장 승인 요청 경로", AccessControl_getPortalRoute_({ role:ACCESS_CONTROL.ROLES.MANAGER }), "B_MANAGER");
  assertEqual_("명시적으로 선택한 OAuth 계정 우선",
    AccessControl_chooseSessionIdentity_("browser@example.com", { email:"selected@example.com" }).email, "selected@example.com");
  assertEqual_("앱 OAuth 세션이 없을 때 활성 계정 사용",
    AccessControl_chooseSessionIdentity_("browser@example.com", null).source, "ACTIVE_USER");
  assertEqual_("계정 없는 경우 로그인 요구",
    AccessControl_chooseSessionIdentity_("", null).source, "VERIFIED_SESSION_REQUIRED");
  assertEqual_("일반 로그인 요청의 브라우저 키 변경 차단",
    AccessSession_canUseOAuthRequest_({ sessionKey:"OLD", allowSessionKeyChange:false }, "NEW"), false);
  assertEqual_("계정 전환 요청의 브라우저 키 변경 허용",
    AccessSession_canUseOAuthRequest_({ sessionKey:"OLD", allowSessionKeyChange:true }, "NEW"), true);
  var originalSessionClear = AccessSession_clearCurrent_;
  var originalOAuthRequestCreate = AccessSession_createOAuthRequest_;
  try {
    var clearedForSwitch = false, switchOptions = null;
    AccessSession_clearCurrent_ = function() { clearedForSwitch = true; return true; };
    AccessSession_createOAuthRequest_ = function(options) {
      switchOptions = options;
      return { authorizationUrl:"https://accounts.google.com/o/oauth2/v2/auth?prompt=select_account" };
    };
    var switchResult = logoutWebAppSession();
    assertEqual_("계정 전환 전 앱 세션 삭제", clearedForSwitch, true);
    assertEqual_("계정 전환 요청에 키 변경 허용", switchOptions.allowSessionKeyChange, true);
    assertEqual_("계정 전환 시 Google 선택 주소 직접 반환",
      switchResult.redirectUrl.indexOf("accounts.google.com") >= 0, true);
  } finally {
    AccessSession_clearCurrent_ = originalSessionClear;
    AccessSession_createOAuthRequest_ = originalOAuthRequestCreate;
  }
  var authHeader = [];
  var inactiveManager = []; inactiveManager[IDX.USER.EMAIL] = "inactive@example.com"; inactiveManager[IDX.USER.ROLE] = ACCESS_CONTROL.ROLES.MANAGER; inactiveManager[IDX.USER.ACTIVE] = false; inactiveManager[IDX.USER.PERMISSIONS] = "OPERATIONS";
  var activeManager = []; activeManager[IDX.USER.EMAIL] = "manager@example.com"; activeManager[IDX.USER.ROLE] = ACCESS_CONTROL.ROLES.MANAGER; activeManager[IDX.USER.ACTIVE] = true; activeManager[IDX.USER.PERMISSIONS] = "OPERATIONS"; activeManager[IDX.USER.STUDENT_SCOPE] = STUDENT_ACCESS_SCOPES.ALL_STUDENTS;
  assertEqual_("비활성 화이트리스트 차단", AccessControl_selectAccountFromRows_("inactive@example.com", [authHeader, inactiveManager]).account, null);
  assertEqual_("활성 하위관리자 허용", AccessControl_selectAccountFromRows_("manager@example.com", [authHeader, activeManager]).account[IDX.USER.EMAIL], "manager@example.com");
  var missingAccessState = AccessSession_classifyIdentityFromRows_({ email:"missing@example.com" }, [authHeader, activeManager]);
  assertEqual_("미등록 계정 C창구", missingAccessState.route, "C_NO_ACCESS");
  assertEqual_("미등록 계정 데이터 권한 없음", missingAccessState.accessGranted, false);
  assertEqual_("미등록 계정 C창구 사유", missingAccessState.reason, "NOT_REGISTERED");
  var inactiveAccessState = AccessSession_classifyIdentityFromRows_({ email:"inactive@example.com" }, [authHeader, inactiveManager]);
  assertEqual_("비활성 계정 C창구", inactiveAccessState.route, "C_NO_ACCESS");
  assertEqual_("비활성 계정 C창구 사유", inactiveAccessState.reason, "ACCOUNT_INACTIVE");
  var managerAccessState = AccessSession_classifyIdentityFromRows_({ email:"manager@example.com" }, [authHeader, activeManager]);
  assertEqual_("활성 하위관리자 승인 요청 경로 유지", managerAccessState.route, "B_MANAGER");
  assertEqual_("활성 하위관리자 데이터 권한", managerAccessState.accessGranted, true);
  var databaseAdmin = []; databaseAdmin[IDX.USER.EMAIL] = "database-admin@example.com"; databaseAdmin[IDX.USER.ROLE] = ACCESS_CONTROL.ROLES.SUPER_ADMIN; databaseAdmin[IDX.USER.ACTIVE] = true; databaseAdmin[IDX.USER.PERMISSIONS] = "*";
  assertEqual_("DB 최고관리자 즉시 처리 경로 유지",
    AccessSession_classifyIdentityFromRows_({ email:"database-admin@example.com" }, [authHeader, databaseAdmin]).route,
    "A_SUPER_ADMIN");
  assertEqual_("복구 최고관리자 즉시 처리 경로 유지",
    AccessSession_classifyIdentityFromRows_({ email:ACCESS_CONTROL.ADMIN_EMAILS[0] }, [authHeader]).route,
    "A_SUPER_ADMIN");
  var validAuthorizationRows = [DataSchema_getDefinitions_()[SHEET_NAMES.USERS].slice(), activeManager];
  assertEqual_("정상 사용자 권한 DB 헤더 허용",
    AccessControl_validateAuthorizationUserRows_(validAuthorizationRows), validAuthorizationRows);
  var brokenAuthorizationRowsBlocked = false;
  try { AccessControl_validateAuthorizationUserRows_([[]]); }
  catch (brokenAuthorizationRowsError) { brokenAuthorizationRowsBlocked = true; }
  assertEqual_("사용자 권한 DB 헤더 손상 오류 차단", brokenAuthorizationRowsBlocked, true);
  var originalAuthorizationRowsReader = DataRepository_getRows_;
  try {
    DataRepository_getRows_ = function() { throw new Error("DB_사용자 시트를 찾을 수 없습니다."); };
    var missingAuthorizationDbBlocked = false;
    try { AccessSession_classifyIdentity_({ email:"missing@example.com" }); }
    catch (missingAuthorizationDbError) { missingAuthorizationDbBlocked = true; }
    assertEqual_("사용자 권한 DB 누락을 C창구로 숨기지 않음", missingAuthorizationDbBlocked, true);
  } finally {
    DataRepository_getRows_ = originalAuthorizationRowsReader;
  }
  var originalDirectRpcEmail = getCurrentUserEmail_;
  originalAuthorizationRowsReader = DataRepository_getRows_;
  var originalDirectRpcSpreadsheetExecutionEmail = AccessControl_spreadsheetExecutionEmail_;
  try {
    // 스프레드시트 메뉴에서 성능 진단 안에 이 테스트를 실행해도 앞선 인증 전역값이
    // 미등록·비활성 계정 차단 시나리오를 우회하지 않도록 완전히 격리합니다.
    AccessControl_spreadsheetExecutionEmail_ = "";
    DataRepository_getRows_ = function() { return validAuthorizationRows; };
    getCurrentUserEmail_ = function() { return "missing@example.com"; };
    var cGatewayDirectRpcBlocked = false;
    try { requireAuthorizedUser_(); } catch (cGatewayDirectRpcError) { cGatewayDirectRpcBlocked = true; }
    assertEqual_("C창구 미등록 계정 직접 데이터 RPC 차단", cGatewayDirectRpcBlocked, true);
    DataRepository_getRows_ = function() {
      return [DataSchema_getDefinitions_()[SHEET_NAMES.USERS].slice(), inactiveManager];
    };
    getCurrentUserEmail_ = function() { return "inactive@example.com"; };
    var inactiveDirectRpcBlocked = false;
    try { requireAuthorizedUser_(); } catch (inactiveDirectRpcError) { inactiveDirectRpcBlocked = true; }
    assertEqual_("C창구 비활성 계정 직접 데이터 RPC 차단", inactiveDirectRpcBlocked, true);
  } finally {
    getCurrentUserEmail_ = originalDirectRpcEmail;
    DataRepository_getRows_ = originalAuthorizationRowsReader;
    AccessControl_spreadsheetExecutionEmail_ = originalDirectRpcSpreadsheetExecutionEmail;
  }
  var originalInteractiveRpcEmail = getCurrentInteractiveUserEmail_;
  originalDirectRpcEmail = getCurrentUserEmail_;
  var originalSpreadsheetUiContextAssert = AccessControl_assertSpreadsheetUiContext_;
  var originalSpreadsheetExecutionEmail = AccessControl_spreadsheetExecutionEmail_;
  try {
    AccessControl_assertSpreadsheetUiContext_ = function() { return true; };
    AccessControl_spreadsheetExecutionEmail_ = "";
    getCurrentInteractiveUserEmail_ = function() { return ""; };
    getCurrentUserEmail_ = function() { return ACCESS_CONTROL.ADMIN_EMAILS[0]; };
    var activeFallbackBlocked = false;
    try { requireAuthorizedUser_(); } catch (activeFallbackError) { activeFallbackBlocked = true; }
    assertEqual_("웹 RPC 기본 경계는 Apps Script 활성 계정 대체 차단", activeFallbackBlocked, true);
    assertEqual_("명시적 스프레드시트 경계만 활성 계정 허용",
      requireAuthorizedUser_({ allowActiveUser:true }).bootstrap, true);
    AccessControl_spreadsheetExecutionEmail_ = "";
    assertEqual_("스프레드시트 메뉴 경계가 실행 사용자 전달",
      requireSpreadsheetAuthorizedUser_().email, ACCESS_CONTROL.ADMIN_EMAILS[0]);
    assertEqual_("스프레드시트 메뉴 내부 호출의 기존 권한 유지", requireAuthorizedUser_().bootstrap, true);
    AccessControl_spreadsheetExecutionEmail_ = "";
    getCurrentInteractiveUserEmail_ = function() { return ACCESS_CONTROL.ADMIN_EMAILS[0]; };
    assertEqual_("검증된 앱 OAuth 최고관리자 경로 유지", requireAuthorizedUser_().bootstrap, true);
  } finally {
    getCurrentInteractiveUserEmail_ = originalInteractiveRpcEmail;
    getCurrentUserEmail_ = originalDirectRpcEmail;
    AccessControl_assertSpreadsheetUiContext_ = originalSpreadsheetUiContextAssert;
    AccessControl_spreadsheetExecutionEmail_ = originalSpreadsheetExecutionEmail;
  }
  var secondAdminEmail = ACCESS_CONTROL.ADMIN_EMAILS[1];
  var secondAdmin = []; secondAdmin[IDX.USER.EMAIL] = secondAdminEmail; secondAdmin[IDX.USER.ROLE] = ACCESS_CONTROL.ROLES.SUPER_ADMIN; secondAdmin[IDX.USER.ACTIVE] = true; secondAdmin[IDX.USER.PERMISSIONS] = "*";
  var selectedSecondAdmin = AccessControl_selectAccountFromRows_(secondAdminEmail, [authHeader, secondAdmin]).account;
  assertEqual_("두 번째 최고관리자 등록", ACCESS_CONTROL.ADMIN_EMAILS.indexOf(secondAdminEmail) >= 0, true);
  assertEqual_("손민영 최고관리자 역할 유지", selectedSecondAdmin[IDX.USER.ROLE], ACCESS_CONTROL.ROLES.SUPER_ADMIN);
  assertEqual_("손민영 최고관리자 전체 권한 유지", selectedSecondAdmin[IDX.USER.PERMISSIONS], "*");
  var duplicateBlocked = false;
  try { AccessControl_selectAccountFromRows_("manager@example.com", [authHeader, activeManager, activeManager]); } catch (duplicateError) { duplicateBlocked = true; }
  assertEqual_("중복 이메일 차단", duplicateBlocked, true);
  var dashboardScopeFixture = { list:[
    { id:"S-A", teacher:"A", teacherId:"T-A" },
    { id:"S-B", teacher:"B", teacherId:"T-B" }
  ], teachers:["A", "B"], months:{ curr:"2026-08" } };
  var linkedManagerDashboard = Dashboard_applyAccessScope_(dashboardScopeFixture, { role:ACCESS_CONTROL.ROLES.MANAGER, teacherId:"T-A", studentScope:STUDENT_ACCESS_SCOPES.LINKED_TEACHER });
  assertEqual_("연결 원장 대시보드 학생 제한", linkedManagerDashboard.list.length, 1);
  assertEqual_("연결 원장 대시보드 대상", linkedManagerDashboard.list[0].id, "S-A");
  var noScopeManagerDashboard = Dashboard_applyAccessScope_(dashboardScopeFixture, { role:ACCESS_CONTROL.ROLES.MANAGER, teacherId:"", permissions:"OPERATIONS", studentScope:STUDENT_ACCESS_SCOPES.NONE });
  assertEqual_("미연결 관리자 대시보드 학생 0명", noScopeManagerDashboard.list.length, 0);
  assertEqual_("미연결 관리자 대시보드 학생 생성 비활성", noScopeManagerDashboard.access.canCreateStudent, false);
  assertEqual_("미연결 관리자 대시보드 수납 생성 비활성", noScopeManagerDashboard.access.canCreatePayment, false);
  assertEqual_("명시적 전체 학생 대시보드", Dashboard_applyAccessScope_(dashboardScopeFixture, { role:ACCESS_CONTROL.ROLES.MANAGER, teacherId:"", studentScope:STUDENT_ACCESS_SCOPES.ALL_STUDENTS }).list.length, 2);
  assertEqual_("최고관리자 대시보드 전체", Dashboard_applyAccessScope_(dashboardScopeFixture, { role:ACCESS_CONTROL.ROLES.SUPER_ADMIN, teacherId:"T-A" }).list.length, 2);
  assertEqual_("대시보드 원본 캐시 보존", dashboardScopeFixture.list.length, 2);
  assertEqual_("기존 연결 원장 계정 범위 호환", AccessControl_normalizeStudentScope_("", "T-A", ACCESS_CONTROL.ROLES.MANAGER), STUDENT_ACCESS_SCOPES.LINKED_TEACHER);
  assertEqual_("기존 연결 원장 계정의 전체 범위 안전 축소", AccessControl_normalizeStudentScope_(STUDENT_ACCESS_SCOPES.ALL_STUDENTS, "T-A", ACCESS_CONTROL.ROLES.MANAGER), STUDENT_ACCESS_SCOPES.LINKED_TEACHER);
  assertEqual_("기존 미연결 계정 접근 없음", AccessControl_normalizeStudentScope_("", "", ACCESS_CONTROL.ROLES.MANAGER), STUDENT_ACCESS_SCOPES.NONE);
  assertEqual_("잘못된 학생 범위 안전 축소", AccessControl_normalizeStudentScope_("BROKEN", "", ACCESS_CONTROL.ROLES.MANAGER), STUDENT_ACCESS_SCOPES.NONE);
  var linkedScopeWithoutTeacherBlocked = false;
  try { AccessControl_requireValidStudentScope_(STUDENT_ACCESS_SCOPES.LINKED_TEACHER, "", ACCESS_CONTROL.ROLES.MANAGER); }
  catch (linkedScopeValidationError) { linkedScopeWithoutTeacherBlocked = true; }
  assertEqual_("연결 원장 없는 연결 범위 저장 차단", linkedScopeWithoutTeacherBlocked, true);
  assertEqual_("원장 연결 없는 명시적 전체 범위 저장 허용",
    AccessControl_requireValidStudentScope_(STUDENT_ACCESS_SCOPES.ALL_STUDENTS, "", ACCESS_CONTROL.ROLES.MANAGER),
    STUDENT_ACCESS_SCOPES.ALL_STUDENTS);
  assertEqual_("원장 연결 사용자는 연결 학생 범위 자동 고정",
    AccessControl_resolveManagedStudentScope_("TEACHER", STUDENT_ACCESS_SCOPES.ALL_STUDENTS, "T-A", ACCESS_CONTROL.ROLES.MANAGER),
    STUDENT_ACCESS_SCOPES.LINKED_TEACHER);
  assertEqual_("직접입력 사용자는 전체 학생 범위 선택 허용",
    AccessControl_resolveManagedStudentScope_("CUSTOM", STUDENT_ACCESS_SCOPES.ALL_STUDENTS, "", ACCESS_CONTROL.ROLES.MANAGER),
    STUDENT_ACCESS_SCOPES.ALL_STUDENTS);
  var customLinkedScopeBlocked = false;
  try { AccessControl_resolveManagedStudentScope_("CUSTOM", STUDENT_ACCESS_SCOPES.LINKED_TEACHER, "", ACCESS_CONTROL.ROLES.MANAGER); }
  catch (customLinkedScopeError) { customLinkedScopeBlocked = true; }
  assertEqual_("직접입력 사용자의 연결 원장 범위 저장 차단", customLinkedScopeBlocked, true);
  var noScopeRequestBlocked = false;
  try { ChangeRequest_assertStudentScope_({ role:ACCESS_CONTROL.ROLES.MANAGER, studentScope:STUDENT_ACCESS_SCOPES.NONE, teacherId:"" }, []); }
  catch (noScopeRequestError) { noScopeRequestBlocked = true; }
  assertEqual_("학생 범위 미설정 요청 차단", noScopeRequestBlocked, true);
  assertEqual_("전체 학생 범위 요청 허용", ChangeRequest_assertStudentScope_({ role:ACCESS_CONTROL.ROLES.MANAGER, studentScope:STUDENT_ACCESS_SCOPES.ALL_STUDENTS, teacherId:"" }, []), undefined);
  var managerChildRequestId = PaymentLifecycle_managerChildRequestId_("CLIENT-BATCH-1", 0, 0);
  assertEqual_("하위관리자 묶음 재시도 요청 ID 결정성", PaymentLifecycle_managerChildRequestId_("CLIENT-BATCH-1", 0, 0), managerChildRequestId);
  assertEqual_("하위관리자 묶음 항목별 요청 ID 분리", PaymentLifecycle_managerChildRequestId_("CLIENT-BATCH-1", 0, 1) === managerChildRequestId, false);
  assertEqual_("하위관리자 작업요청 판정", ChangeRequest_isManager_({ role:ACCESS_CONTROL.ROLES.MANAGER, bootstrap:false }), true);
  assertEqual_("최고관리자 직접처리 판정", ChangeRequest_isManager_({ role:ACCESS_CONTROL.ROLES.SUPER_ADMIN, bootstrap:false }), false);
  assertEqual_("기존 OPERATIONS 권한 전체 승계", AccessControl_normalizePermissions_("OPERATIONS").length, MANAGER_ROUTE_PERMISSIONS.length);
  assertEqual_("유효한 하위관리자 메뉴 권한 허용", AccessControl_hasPermission_({ role:ACCESS_CONTROL.ROLES.MANAGER, permissions:"STUDENT_EDIT", studentScope:STUDENT_ACCESS_SCOPES.ALL_STUDENTS }, "STUDENT_EDIT"), true);
  assertEqual_("범위 없는 하위관리자 메뉴 권한 유지", AccessControl_hasPermission_({ role:ACCESS_CONTROL.ROLES.MANAGER, permissions:"OPERATIONS", studentScope:STUDENT_ACCESS_SCOPES.NONE }, "STUDENT_EDIT"), true);
  assertEqual_("잘못된 역할의 직접 RPC 권한 차단", AccessControl_hasPermission_({ role:"INVALID", permissions:"STUDENT_EDIT" }, "STUDENT_EDIT"), false);
  var invalidRoleBlocked = false;
  try { AccessControl_requireValidRole_(""); } catch (invalidRoleError) { invalidRoleBlocked = true; }
  assertEqual_("빈 역할 계정 차단", invalidRoleBlocked, true);
  var originalAutomationEmail = getAutomationUserEmail_;
  var originalInteractiveEmail = getCurrentInteractiveUserEmail_;
  try {
    getAutomationUserEmail_ = function() { return ACCESS_CONTROL.ADMIN_EMAILS[0]; };
    getCurrentInteractiveUserEmail_ = function() { return "manager@example.com"; };
    var managerAutomationBlocked = false;
    try { requireAutomationSuperAdmin_(); } catch (managerAutomationError) { managerAutomationBlocked = true; }
    assertEqual_("하위관리자의 시간 트리거 함수 직접 호출 차단", managerAutomationBlocked, true);
    getCurrentInteractiveUserEmail_ = function() { return ""; };
    assertEqual_("비대화형 시간 트리거 실행 유지", requireAutomationSuperAdmin_().automation, true);
  } finally {
    getAutomationUserEmail_ = originalAutomationEmail;
    getCurrentInteractiveUserEmail_ = originalInteractiveEmail;
  }
  var originalRequireSuperAdmin = requireSuperAdmin_;
  var originalRequireAuthorizedUser = requireAuthorizedUser_;
  try {
    requireSuperAdmin_ = function() { throw new Error("TEST_AUTH_REQUIRED"); };
    var spoofedApprovalBlocked = false;
    try {
      approvePaymentApprovalRequest("PAYREQ-SPOOF", "", {
        email:"attacker@example.com", role:ACCESS_CONTROL.ROLES.SUPER_ADMIN, bootstrap:true
      });
    } catch (spoofedApprovalError) { spoofedApprovalBlocked = spoofedApprovalError.message === "TEST_AUTH_REQUIRED"; }
    assertEqual_("수납 승인 공개 RPC 사용자 객체 위조 차단", spoofedApprovalBlocked, true);
    var spoofedRejectionBlocked = false;
    try {
      rejectPaymentApprovalRequest("PAYREQ-SPOOF", "반려", {
        email:"attacker@example.com", role:ACCESS_CONTROL.ROLES.SUPER_ADMIN, bootstrap:true
      });
    } catch (spoofedRejectionError) { spoofedRejectionBlocked = spoofedRejectionError.message === "TEST_AUTH_REQUIRED"; }
    assertEqual_("수납 반려 공개 RPC 사용자 객체 위조 차단", spoofedRejectionBlocked, true);

    requireAuthorizedUser_ = function() { throw new Error("TEST_SESSION_REQUIRED"); };
    var spoofedMenuAccessBlocked = false;
    try {
      createMainMenuHtml({ email:"attacker@example.com", role:ACCESS_CONTROL.ROLES.SUPER_ADMIN, bootstrap:true });
    } catch (spoofedMenuError) { spoofedMenuAccessBlocked = spoofedMenuError.message === "TEST_SESSION_REQUIRED"; }
    assertEqual_("메인 메뉴 공개 함수 access 객체 위조 차단", spoofedMenuAccessBlocked, true);
  } finally {
    requireSuperAdmin_ = originalRequireSuperAdmin;
    requireAuthorizedUser_ = originalRequireAuthorizedUser;
  }
  assertEqual_("선택 경로 외 접근 차단", AccessControl_canAccessPage_({ role:ACCESS_CONTROL.ROLES.MANAGER, permissions:"STUDENT_ADD", studentScope:STUDENT_ACCESS_SCOPES.ALL_STUDENTS }, "StudentEdit"), false);
  assertEqual_("선택 경로 접근 허용", AccessControl_canAccessPage_({ role:ACCESS_CONTROL.ROLES.MANAGER, permissions:"STUDENT_ADD", studentScope:STUDENT_ACCESS_SCOPES.ALL_STUDENTS }, "StudentAddUI"), true);
  assertEqual_("경로표 별칭 렌더링", AppRoute_renderPage_("ManagerDashboard"), "DashboardUI");
  assertEqual_("최고관리자 경로 하위관리자 차단", AccessControl_canAccessPage_({ role:ACCESS_CONTROL.ROLES.MANAGER, permissions:"OPERATIONS" }, "SettingsDashboard"), false);
  assertEqual_("공개 관리자 도움말 경로", AccessControl_canAccessPage_({ role:ACCESS_CONTROL.ROLES.MANAGER, permissions:"" }, "Manual"), true);
  assertEqual_("범위 없는 관리자 요청현황 경로 유지", AccessControl_canAccessPage_({ role:ACCESS_CONTROL.ROLES.MANAGER, permissions:"", studentScope:STUDENT_ACCESS_SCOPES.NONE }, "MyRequestStatus"), true);
  var originalNoScopeReadUser = requireAuthorizedUser_;
  try {
    requireAuthorizedUser_ = function() {
      return { role:ACCESS_CONTROL.ROLES.MANAGER, email:"none@example.com", permissions:"OPERATIONS", studentScope:STUDENT_ACCESS_SCOPES.NONE, teacherId:"" };
    };
    assertEqual_("범위 없는 직접 동명이 조회 일치 없음", checkNameDuplicate("김학생").exists, false);
    assertEqual_("범위 없는 직접 휴가 조회 빈 목록", getVacationPeriodsForStudent("S-OUT").length, 0);
    assertEqual_("범위 없는 직접 학생 상세 미발견", getStudentDetail("S-OUT"), null);
    assertEqual_("범위 없는 직접 표적 대시보드 빈 목록", getDashboardStudentsForHtml("2026-08", ["S-OUT"]).list.length, 0);
    var noScopeProrationNotFound = false;
    try { calculateProratedFee(300000, "2026-08-01", "2026-08-31", "S-OUT", true); }
    catch (noScopeProrationError) { noScopeProrationNotFound = String(noScopeProrationError && noScopeProrationError.message || "").indexOf("학생을 찾을 수 없습니다") !== -1; }
    assertEqual_("범위 없는 직접 일할 계산 학생 미발견", noScopeProrationNotFound, true);
  } finally {
    requireAuthorizedUser_ = originalNoScopeReadUser;
  }
  assertEqual_("신규 작업요청 단일 원본 판정", UnifiedRequest_isNativeChange_({ category:UNIFIED_REQUEST_CATEGORY.CHANGE, sourceSheet:SHEET_NAMES.REQUESTS }), true);
  assertEqual_("과거 출처 표기가 남은 작업요청도 통합 원본 판정", UnifiedRequest_isNativeChange_({ category:UNIFIED_REQUEST_CATEGORY.CHANGE, sourceSheet:"DB_작업요청" }), true);
  var nativeCompletionRequest = { id:"CHGREQ-FP", category:UNIFIED_REQUEST_CATEGORY.CHANGE, type:"STUDENT_UPDATE",
    targetId:"S-FP", targetName:"지문학생", summary:"연락처 변경", payloadText:'{"phone":"010-1111-2222"}',
    requesterEmail:"manager@example.com", requesterName:"관리 원장", sourceSheet:SHEET_NAMES.REQUESTS,
    sourceId:"CHGREQ-FP", effectiveDate:"2026-09-09" };
  var nativeCompletionFingerprint = UnifiedRequest_nativeRequestFingerprint_(nativeCompletionRequest);
  assertEqual_("작업요청 완료 표식 지문 일치",
    UnifiedRequest_nativeCompletionBinding_({ requestFingerprint:nativeCompletionFingerprint }, nativeCompletionRequest).matches, true);
  var changedNativeCompletionRequest = Object.assign({}, nativeCompletionRequest, { payloadText:'{"phone":"010-9999-9999"}' });
  assertEqual_("작업요청 완료 표식과 변경 원문 불일치 차단",
    UnifiedRequest_nativeCompletionBinding_({ requestFingerprint:nativeCompletionFingerprint }, changedNativeCompletionRequest).matches, false);
  assertEqual_("지문 없는 과거 작업요청 완료 표식 자동 복구 차단",
    UnifiedRequest_nativeCompletionBinding_({ requestId:"CHGREQ-FP" }, nativeCompletionRequest).matches, false);
  assertEqual_("수납 요청 증빙 ID 중복 제거", PaymentApproval_parseEvidenceIds_("F-1,F-1,F-2").join(","), "F-1,F-2");
  var approvalRequestRow = [];
  approvalRequestRow[IDX.REQUEST.ID] = "PAYREQ-TEST";
  approvalRequestRow[IDX.REQUEST.CREATED_AT] = new Date("2026-08-18T09:00:00+09:00");
  approvalRequestRow[IDX.REQUEST.CATEGORY] = UNIFIED_REQUEST_CATEGORY.PAYMENT;
  approvalRequestRow[IDX.REQUEST.TYPE] = "PAYMENT_CREATE";
  approvalRequestRow[IDX.REQUEST.STATUS] = "PENDING";
  approvalRequestRow[IDX.REQUEST.TARGET_ID] = "S-TEST";
  approvalRequestRow[IDX.REQUEST.TARGET_NAME] = "테스트학생";
  approvalRequestRow[IDX.REQUEST.REQUESTER_EMAIL] = "manager@example.com";
  approvalRequestRow[IDX.REQUEST.REQUESTER_NAME] = "테스트원장";
  approvalRequestRow[IDX.REQUEST.EVIDENCE_IDS] = "F-1,F-2";
  approvalRequestRow[IDX.REQUEST.EFFECTIVE_DATE] = "2026-08-18";
  approvalRequestRow[IDX.REQUEST.SOURCE_SHEET] = SHEET_NAMES.REQUESTS;
  approvalRequestRow[IDX.REQUEST.SOURCE_ID] = "PAYREQ-TEST";
  approvalRequestRow[IDX.REQUEST.PAYLOAD] = JSON.stringify({
    requestId:"PAYREQ-TEST", payDate:"2026-08-18", payMethod:"카드",
    payments:[{ studentId:"S-TEST", studentName:"테스트학생", items:[{ month:"2026-08", type:"수강료", amount:400000, memo:"" }] }]
  });
  assertEqual_("수납 승인 요청 payload 요청 ID 검증", PaymentApproval_parsePayload_(approvalRequestRow).requestId, "PAYREQ-TEST");
  assertEqual_("수납 승인 표시값과 payload 일치 검증",
    PaymentApproval_validatePayloadAgainstRow_(PaymentApproval_parsePayload_(approvalRequestRow), approvalRequestRow).payments[0].studentId,
    "S-TEST");
  assertEqual_("수납 요청 통합행 금액 표시", PaymentApproval_toObject_(approvalRequestRow).amount, 400000);
  var approvalHistoryMemo = PaymentApproval_historyMemo_(PaymentApproval_toObject_(approvalRequestRow), "APPROVED", "확인 완료", ["PAY-1"]);
  assertEqual_("수납 승인 이벤트 메모 1000자 이내", approvalHistoryMemo.length < 1000, true);
  assertEqual_("수납 승인 이력 요청자 복구", JSON.parse(approvalHistoryMemo).requesterEmail, "manager@example.com");
  var retryPayloadFixture = ManagerPaymentRequest_normalizeRetryPayload_({
    studentId:"S-TEST", payDate:"2026-08-18", month:"2026-08", itemType:"수강료",
    amount:400000, method:"카드", memo:"", reason:""
  });
  assertEqual_("동일 수납 요청 ID·동일 내용 재시도 허용",
    ManagerPaymentRequest_isSameRetry_(approvalRequestRow, retryPayloadFixture), true);
  var changedRetryPayloadFixture = ManagerPaymentRequest_normalizeRetryPayload_({
    studentId:"S-TEST", payDate:"2026-08-18", month:"2026-08", itemType:"수강료",
    amount:410000, method:"카드", memo:"", reason:""
  });
  assertEqual_("동일 수납 요청 ID·변경 금액 재시도 차단",
    ManagerPaymentRequest_isSameRetry_(approvalRequestRow, changedRetryPayloadFixture), false);
  var differentOwnerRetryBlocked = false;
  try { ManagerPaymentRequest_assertSameRetry_(approvalRequestRow, retryPayloadFixture, "other@example.com"); }
  catch (differentOwnerRetryError) { differentOwnerRetryBlocked = String(differentOwnerRetryError.message).indexOf("다른 사용자") !== -1; }
  assertEqual_("동일 수납 요청 ID·다른 요청자 재시도 차단", differentOwnerRetryBlocked, true);
  var originalRetryRequirePermission = requireManagerPermission_;
  var originalRetryLookup = LookupIndex_findRowsForValues_;
  var originalRetryDashboard = Dashboard_getDataForHtml_;
  var originalRetryTargetedContext = Dashboard_buildTargetedContext_;
  var originalRetryTeacher = ManagerPortal_getOptionalTeacher_;
  try {
    requireManagerPermission_ = function() {
      return { email:"manager@example.com", name:"테스트원장", role:ACCESS_CONTROL.ROLES.MANAGER,
        permissions:"PAYMENT_DASHBOARD", studentScope:STUDENT_ACCESS_SCOPES.ALL_STUDENTS, teacherId:"" };
    };
    LookupIndex_findRowsForValues_ = function() { return [{ row:approvalRequestRow }]; };
    Dashboard_getDataForHtml_ = function() { return { list:[] }; };
    Dashboard_buildTargetedContext_ = function() { return {}; };
    ManagerPortal_getOptionalTeacher_ = function() { return null; };
    var sameRetryResult = submitManagerPaymentRequest({
      requestId:"PAYREQ-TEST", studentId:"S-TEST", payDate:"2026-08-18", month:"2026-08",
      itemType:"수강료", amount:400000, method:"카드", memo:"", reason:""
    });
    assertEqual_("수납 공개 RPC 동일 내용 재시도 중복 반환", sameRetryResult.duplicate, true);
    var changedRetryBlocked = false;
    try {
      submitManagerPaymentRequest({
        requestId:"PAYREQ-TEST", studentId:"S-TEST", payDate:"2026-08-18", month:"2026-08",
        itemType:"수강료", amount:410000, method:"카드", memo:"", reason:""
      });
    } catch (changedRetryError) {
      changedRetryBlocked = String(changedRetryError && changedRetryError.message || "").indexOf("이전과 다른 수납 내용") !== -1;
    }
    assertEqual_("수납 공개 RPC 변경 내용 재시도 거부", changedRetryBlocked, true);
  } finally {
    requireManagerPermission_ = originalRetryRequirePermission;
    LookupIndex_findRowsForValues_ = originalRetryLookup;
    Dashboard_getDataForHtml_ = originalRetryDashboard;
    Dashboard_buildTargetedContext_ = originalRetryTargetedContext;
    ManagerPortal_getOptionalTeacher_ = originalRetryTeacher;
  }
  var originalRaceRequirePermission = requireManagerPermission_;
  var originalRaceLookup = LookupIndex_findRowsForValues_;
  var originalRaceDashboard = Dashboard_getDataForHtml_;
  var originalRaceTargetedContext = Dashboard_buildTargetedContext_;
  var originalRaceTeacher = ManagerPortal_getOptionalTeacher_;
  var originalRaceEvidenceSave = PaymentRequest_saveEvidence_;
  var originalRaceEvidenceTrash = ManagerPaymentRequest_trashEvidence_;
  var originalRacePipeline = MutationPipeline_run_;
  var originalRaceEnsureSheet = DataSchema_ensureSheet_;
  try {
    requireManagerPermission_ = function() {
      return { email:"manager@example.com", name:"테스트원장", role:ACCESS_CONTROL.ROLES.MANAGER,
        permissions:"PAYMENT_DASHBOARD", studentScope:STUDENT_ACCESS_SCOPES.ALL_STUDENTS, teacherId:"" };
    };
    LookupIndex_findRowsForValues_ = function() { return []; };
    Dashboard_getDataForHtml_ = function() { return { list:[{ id:"S-TEST", name:"테스트학생" }] }; };
    Dashboard_buildTargetedContext_ = function() { return {}; };
    ManagerPortal_getOptionalTeacher_ = function() { return null; };
    PaymentRequest_saveEvidence_ = function() { return { fileIds:["RACE-FILE"], folderId:"RACE-FOLDER" }; };
    var raceEvidenceCleanupCount = 0;
    ManagerPaymentRequest_trashEvidence_ = function() { raceEvidenceCleanupCount++; };
    var raceSheet = {
      getLastRow:function() { return 2; },
      getRange:function(_row, column, _rowCount, columnCount) {
        return column === COL.REQUEST.ID && columnCount === 1
          ? { getDisplayValues:function() { return [["PAYREQ-TEST"]]; } }
          : { getValues:function() { return [approvalRequestRow]; } };
      }
    };
    DataSchema_ensureSheet_ = function() { return { sheet:raceSheet }; };
    MutationPipeline_run_ = function(_options, executor) {
      return executor({ addRollback:function() {}, invalidate:function() {} });
    };
    var raceSameRetry = submitManagerPaymentRequest({
      requestId:"PAYREQ-TEST", studentId:"S-TEST", payDate:"2026-08-18", month:"2026-08",
      itemType:"수강료", amount:400000, method:"카드", memo:"", reason:"", attachments:[]
    });
    assertEqual_("잠금 대기 중 생성된 동일 요청·동일 내용 재시도 허용", raceSameRetry.duplicate, true);
    var raceChangedRetryBlocked = false;
    try {
      submitManagerPaymentRequest({
        requestId:"PAYREQ-TEST", studentId:"S-TEST", payDate:"2026-08-18", month:"2026-08",
        itemType:"수강료", amount:410000, method:"카드", memo:"", reason:"", attachments:[]
      });
    } catch (raceChangedRetryError) {
      raceChangedRetryBlocked = String(raceChangedRetryError && raceChangedRetryError.message || "").indexOf("이전과 다른 수납 내용") !== -1;
    }
    assertEqual_("잠금 대기 중 생성된 동일 요청·변경 내용 재시도 차단", raceChangedRetryBlocked, true);
    assertEqual_("잠금 내부 중복·충돌 증빙 정리", raceEvidenceCleanupCount, 2);
  } finally {
    requireManagerPermission_ = originalRaceRequirePermission;
    LookupIndex_findRowsForValues_ = originalRaceLookup;
    Dashboard_getDataForHtml_ = originalRaceDashboard;
    Dashboard_buildTargetedContext_ = originalRaceTargetedContext;
    ManagerPortal_getOptionalTeacher_ = originalRaceTeacher;
    PaymentRequest_saveEvidence_ = originalRaceEvidenceSave;
    ManagerPaymentRequest_trashEvidence_ = originalRaceEvidenceTrash;
    MutationPipeline_run_ = originalRacePipeline;
    DataSchema_ensureSheet_ = originalRaceEnsureSheet;
  }
  var duplicatePaymentRow = [];
  duplicatePaymentRow[IDX.PAYMENT.STUDENT_ID] = "S-TEST";
  duplicatePaymentRow[IDX.PAYMENT.MONTH] = "2026-08";
  duplicatePaymentRow[IDX.PAYMENT.TYPE] = "수강료";
  duplicatePaymentRow[IDX.PAYMENT.AMOUNT] = 400000;
  duplicatePaymentRow[IDX.PAYMENT.PAY_DATE] = "2026-08-18";
  duplicatePaymentRow[IDX.PAYMENT.RECORD_STATUS] = "ACTIVE";
  assertEqual_("대상 학생 행만으로 중복 수납 경고 계산",
    PaymentApproval_duplicateWarningsFromRows_([{
      requestId:"PAYREQ-TEST", studentId:"S-TEST", month:"2026-08", itemType:"수강료", amount:400000, payDate:"2026-08-18"
    }], [duplicatePaymentRow])["PAYREQ-TEST"].indexOf("1건") >= 0, true);
  assertEqual_("조회 인덱스 키 공백 정규화", LookupIndex_normalizeKey_(" PAY-1 "), "PAY-1");
  assertEqual_("조회 인덱스 열 문자 A", LookupIndex_columnLetter_(1), "A");
  assertEqual_("조회 인덱스 열 문자 W", LookupIndex_columnLetter_(23), "W");
  assertEqual_("조회 인덱스 열 문자 AA", LookupIndex_columnLetter_(27), "AA");
  var schemaDefinitions = DataSchema_getDefinitions_();
  assertEqual_("학생 스키마 확장 열 수", schemaDefinitions[SHEET_NAMES.STUDENTS].length, 20);
  assertEqual_("학생 형제할인 헤더", schemaDefinitions[SHEET_NAMES.STUDENTS][COL.STUDENT.FAMILY_DISCOUNT - 1], "형제할인액");
  assertEqual_("학생 수강형태 헤더", schemaDefinitions[SHEET_NAMES.STUDENTS][COL.STUDENT.COURSE_MODE - 1], "수강형태");
  assertEqual_("학생 담당 원장 ID 헤더", schemaDefinitions[SHEET_NAMES.STUDENTS][COL.STUDENT.TEACHER_ID - 1], "담당원장ID");
  assertEqual_("학생 과거 헤더 호환", DataSchema_isCompatibleHeader_(SHEET_NAMES.STUDENTS, 5, "담당 원장"), true);
  assertEqual_("수납 과거 헤더 호환", DataSchema_isCompatibleHeader_(SHEET_NAMES.PAYMENTS, 10, "결제수단"), true);
  assertEqual_("휴가 과거 헤더 호환", DataSchema_isCompatibleHeader_(SHEET_NAMES.VACATIONS, 6, "휴가사유"), true);
  assertEqual_("수납 스키마 확장 열 수", schemaDefinitions[SHEET_NAMES.PAYMENTS].length, 23);
  assertEqual_("수납 O열 폐기 후 빈 열 유지", schemaDefinitions[SHEET_NAMES.PAYMENTS][14], null);
  assertEqual_("수납 요청 단일 원본", SHEET_NAMES.PAYMENT_REQUESTS, undefined);
  assertEqual_("통합 요청 스키마 열 수", schemaDefinitions[SHEET_NAMES.REQUESTS].length, 22);
  assertEqual_("통합 요청 상태 헤더", schemaDefinitions[SHEET_NAMES.REQUESTS][COL.REQUEST.STATUS - 1], "처리상태");
  assertEqual_("통합 요청 원본 시트 헤더", schemaDefinitions[SHEET_NAMES.REQUESTS][COL.REQUEST.SOURCE_SHEET - 1], "원본시트");
  var directlyEditedSheetNames = DataMutation_managedEditSheetNames_();
  assertEqual_("직접 요청 시트 수정 캐시 무효화", directlyEditedSheetNames.indexOf(SHEET_NAMES.REQUESTS) >= 0, true);
  assertEqual_("직접 사용자 시트 수정 캐시 무효화", directlyEditedSheetNames.indexOf(SHEET_NAMES.USERS) >= 0, true);
  assertEqual_("직접 휴지통 시트 수정 캐시 무효화", directlyEditedSheetNames.indexOf(SHEET_NAMES.TRASH) >= 0, true);
  ["INSERT_ROW", "REMOVE_ROW", "INSERT_COLUMN", "REMOVE_COLUMN", "INSERT_GRID", "REMOVE_GRID", "OTHER"].forEach(function(type) {
    assertEqual_("직접 구조 변경 감지 " + type, DataMutation_isStructuralChange_(type), true);
  });
  assertEqual_("일반 값 편집은 기존 onEdit로 처리", DataMutation_isStructuralChange_("EDIT"), false);
  assertEqual_("단순 서식 변경 제외", DataMutation_isStructuralChange_("FORMAT"), false);
  assertEqual_("이벤트 없는 구조 감시 직접 실행 무시", DataMutation_onSpreadsheetChange_().ignored, true);
  var structureHeaders = schemaDefinitions[SHEET_NAMES.STUDENTS].slice();
  var structureSheet = {
    getSheetId:function() { return 42; }, getMaxColumns:function() { return 20; }, getLastRow:function() { return 2; },
    getRange:function() { return { getValues:function() { return [structureHeaders.slice()]; } }; }
  };
  var structureBaseline = { sheetId:42, columns:[1, 2, 20] };
  assertEqual_("정상 구조 검사", DataSchema_inspectSheetStructure_(SHEET_NAMES.STUDENTS, structureSheet, structureBaseline).length, 0);
  structureHeaders[4] = "담당 원장";
  assertEqual_("구조 보호 과거 헤더 호환", DataSchema_inspectSheetStructure_(SHEET_NAMES.STUDENTS, structureSheet, structureBaseline).length, 0);
  structureHeaders[1] = "";
  assertEqual_("중간 헤더 삭제 자동 보완 차단", DataSchema_inspectSheetStructure_(SHEET_NAMES.STUDENTS, structureSheet).length, 1);
  structureHeaders[1] = "학생명";
  structureHeaders[19] = "";
  assertEqual_("등록된 마지막 헤더 삭제 차단", DataSchema_inspectSheetStructure_(SHEET_NAMES.STUDENTS, structureSheet, structureBaseline).length, 1);
  assertEqual_("기존 파일의 미도입 끝쪽 확장 열 허용", DataSchema_inspectSheetStructure_(SHEET_NAMES.STUDENTS, structureSheet).length, 0);
  assertEqual_("등록된 시트 삭제 감지", DataSchema_inspectSheetStructure_(SHEET_NAMES.STUDENTS, null, structureBaseline).length, 1);
  assertEqual_("동일 이름의 다른 시트 교체 감지", DataSchema_inspectSheetStructure_(SHEET_NAMES.STUDENTS, structureSheet, { sheetId:43 }).length, 1);
  structureHeaders = schemaDefinitions[SHEET_NAMES.STUDENTS].slice();
  structureHeaders.splice(1, 1);
  assertEqual_("학생명 열 삭제 후 열 밀림 감지", DataSchema_inspectSheetStructure_(SHEET_NAMES.STUDENTS, structureSheet, structureBaseline).length > 1, true);
  assertEqual_("운영 설정 스키마 열 수", schemaDefinitions[SHEET_NAMES.SETTINGS].length, 8);
  assertEqual_("일반 관리자 원장명 접미사 정규화", ManagerPortal_normalizeTeacherName_("김철수 원장님"), "김철수");
  assertEqual_("수납 요청 기본 대기 상태", PAYMENT_REQUEST_STATUS.PENDING, "PENDING");
  assertEqual_("수납 요청 ID 헤더", schemaDefinitions[SHEET_NAMES.PAYMENTS][COL.PAYMENT.REQUEST_ID - 1], "요청ID");
  assertEqual_("원장 관리 스키마 열 수", schemaDefinitions[SHEET_NAMES.TEACHERS].length, 11);
  assertEqual_("사용자 권한 스키마 열 수", schemaDefinitions[SHEET_NAMES.USERS].length, 11);
  assertEqual_("사용자 연결 원장 헤더", schemaDefinitions[SHEET_NAMES.USERS][COL.USER.TEACHER_ID - 1], "연결원장ID");
  assertEqual_("사용자 학생 범위 헤더", schemaDefinitions[SHEET_NAMES.USERS][COL.USER.STUDENT_SCOPE - 1], "학생접근범위");
  var duplicateStudentRows = [[], []];
  duplicateStudentRows[1][IDX.STUDENT.ID] = "S-DUP";
  duplicateStudentRows[1][IDX.STUDENT.NAME] = "김 학생";
  duplicateStudentRows[1][IDX.STUDENT.PHONE] = "'010-1234-5678";
  assertEqual_("동명이인 보호자 전화 일치 시 중복", StudentIdentity_findDuplicate_("김학생", "01012345678", duplicateStudentRows).id, "S-DUP");
  assertEqual_("동명이인 보호자 전화 불일치 시 허용", StudentIdentity_findDuplicate_("김학생", "010-9999-9999", duplicateStudentRows), null);
  assertEqual_("보호자 전화 미입력 시 이름만으로 차단 안 함", StudentIdentity_findDuplicate_("김학생", "", duplicateStudentRows), null);
  assertEqual_("급여 정산 스키마 열 수", schemaDefinitions[SHEET_NAMES.SALARY_SETTLEMENTS].length, 16);
  assertEqual_("급여 내역 스키마 열 수", schemaDefinitions[SHEET_NAMES.SALARY_ENTRIES].length, 11);
  assertEqual_("급여 미지급 상태", SalaryManagement_status_(300000, 0), "미지급");
  assertEqual_("급여 일부지급 상태", SalaryManagement_status_(300000, 250000), "일부지급");
  assertEqual_("급여 지급완료 상태", SalaryManagement_status_(300000, 300000), "지급완료");
  assertEqual_("급여 초과지급 상태", SalaryManagement_status_(300000, 310000), "초과지급");
  assertEqual_("급여 월 짧은 표기 정규화", SalaryManagement_normalizeYmCell_("26.8"), "2026-08");
  assertEqual_("급여 월 날짜문자 정규화", SalaryManagement_normalizeYmCell_("2026-08-01"), "2026-08");
  assertEqual_("급여 배분율 소수 형식", Salary_normalizeRate_(0.6), 0.6);
  assertEqual_("급여 배분율 정수 형식", Salary_normalizeRate_(60), 0.6);
  assertEqual_("급여 배분율 문자 형식", Salary_normalizeRate_("60%"), 0.6);
  assertEqual_("급여 조정 비율·세금 서버 재계산", SalaryManagement_calculateAdjustment_({
    type: "ADD_OMIT", originAmount: 100000, finalAmount: 58020, isRate: true, isTax: true
  }, 0.6), 58020);
  assertEqual_("급여 공제 서버 재계산", SalaryManagement_calculateAdjustment_({
    type: "SUB_ETC", originAmount: 10000, finalAmount: -10000, isRate: false, isTax: false
  }, 0.6), -10000);
  assertEqual_("급여 미리보기는 잘못된 화면 조정액을 서버값으로 교체", SalaryManagement_calculateAdjustment_({
    type: "ADD_OMIT", originAmount: 100000, finalAmount: 99999, isRate: true, isTax: true
  }, 0.6, true), 58020);
  var salaryTokenFixture = { ym:"2026-08", teacher:{ id:"T-1" }, data:{ list:[], summary:{ finalPay:1000 } }, adjustments:[], exclusions:[], adjustmentAmount:0, finalAmount:1000 };
  var salaryToken = SalaryManagement_createPreviewToken_(salaryTokenFixture);
  assertEqual_("급여 미리보기 토큰 결정성", SalaryManagement_createPreviewToken_(salaryTokenFixture), salaryToken);
  salaryTokenFixture.finalAmount = 1001;
  assertEqual_("급여 미리보기 변경 토큰 구분", SalaryManagement_createPreviewToken_(salaryTokenFixture) === salaryToken, false);
  assertEqual_("시트 불리언 TRUE 호환", Management_toBoolean_("TRUE"), true);
  var configuredBackupDays = OperationalSettings_getNumber_("BACKUP_INTERVAL_DAYS", BACKUP_INTERVAL_DAYS);
  var backupStart = new Date("2026-08-01T04:00:00.000Z");
  assertEqual_("설정 백업 주기 직전 미도래", Backup_isDue_(backupStart, new Date(backupStart.getTime() + configuredBackupDays * 86400000 - 1)), false);
  assertEqual_("설정 백업 주기 도래", Backup_isDue_(backupStart, new Date(backupStart.getTime() + configuredBackupDays * 86400000)), true);
  assertEqual_("백업 3개월 월말 보정", formatDateOnly_(Backup_addMonthsClamped_(new Date(2026, 4, 31), -3)), "2026-02-28");
  var backupManifest = { sheets: [{ name:"DB_명단", rows:127, columns:19 }] };
  assertEqual_("백업 복사 행·열 일치", Backup_compareManifests_(backupManifest,
    { sheets: [{ name:"DB_명단", rows:127, columns:19 }] }).matches, true);
  assertEqual_("백업 복사 행 수 불일치 차단", Backup_compareManifests_(backupManifest,
    { sheets: [{ name:"DB_명단", rows:126, columns:19 }] }).matches, false);
  var backupContentManifest = { sheets: [{ name:"DB_명단", rows:127, columns:19, contentFingerprint:"HASH-A" }] };
  assertEqual_("백업 복사 내용 지문 일치", Backup_compareManifests_(backupContentManifest,
    { sheets: [{ name:"DB_명단", rows:127, columns:19, contentFingerprint:"HASH-A" }] }).matches, true);
  assertEqual_("백업 복사 같은 크기 내용 불일치 차단", Backup_compareManifests_(backupContentManifest,
    { sheets: [{ name:"DB_명단", rows:127, columns:19, contentFingerprint:"HASH-B" }] }).matches, false);
  var backupPaymentFingerprintRow = [];
  backupPaymentFingerprintRow[IDX.PAYMENT.ID] = "PAY-BACKUP";
  backupPaymentFingerprintRow[IDX.PAYMENT.AMOUNT] = 100000;
  backupPaymentFingerprintRow[PAYMENT_RETIRED_GROUP_COLUMN - 1] = "과거묶음A";
  var backupPaymentFingerprintChanged = backupPaymentFingerprintRow.slice();
  backupPaymentFingerprintChanged[IDX.PAYMENT.AMOUNT] = 100001;
  var backupPaymentFingerprintRetiredOnly = backupPaymentFingerprintRow.slice();
  backupPaymentFingerprintRetiredOnly[PAYMENT_RETIRED_GROUP_COLUMN - 1] = "과거묶음B";
  assertEqual_("백업 내용 지문은 실제 수납값 변경 구분",
    Backup_sheetContentFingerprint_(SHEET_NAMES.PAYMENTS, [backupPaymentFingerprintRow]) ===
      Backup_sheetContentFingerprint_(SHEET_NAMES.PAYMENTS, [backupPaymentFingerprintChanged]), false);
  assertEqual_("백업 내용 지문은 폐기 수납열 복구 정규화 호환",
    Backup_sheetContentFingerprint_(SHEET_NAMES.PAYMENTS, [backupPaymentFingerprintRow]),
    Backup_sheetContentFingerprint_(SHEET_NAMES.PAYMENTS, [backupPaymentFingerprintRetiredOnly]));
  var restoreImpact = Backup_compareComparableRows_(
    { "ID:S-1#1":"현재값", "ID:S-2#1":"삭제될값", "ID:S-4#1":"같은값" },
    { "ID:S-1#1":"과거값", "ID:S-3#1":"복구될값", "ID:S-4#1":"같은값" }
  );
  assertEqual_("백업 복구 시 사라질 기록 계산", restoreImpact.willDisappear, 1);
  assertEqual_("백업 복구 시 되살아날 기록 계산", restoreImpact.willRestore, 1);
  assertEqual_("백업 복구 시 이전 값 복원 계산", restoreImpact.willRevert, 1);
  assertEqual_("스키마 불일치 저장 차단 안내",
    DataSchema_formatMismatchError_("DB_명단", [{ column:2, expected:"학생명", actual:"이름" }]).indexOf("저장을 중단") >= 0, true);

  var studentRow = [];
  studentRow[IDX.STUDENT.ID] = "S-TEST";
  studentRow[IDX.STUDENT.FEE] = 100000;
  studentRow[IDX.STUDENT.STATUS] = "재원";
  studentRow[IDX.STUDENT.TEACHER] = "A";
  var histories = { "S-TEST": { fee: [
    { effectiveDate: new Date(2026, 7, 10), createdAt: 1, rowOrder: 1, before: 100000, after: 120000 },
    { effectiveDate: new Date(2026, 6, 10), createdAt: 2, rowOrder: 2, before: 120000, after: 110000 }
  ], status: [], teacher: [] } };
  assertEqual_("역순 미래변경 6월", StudentTimeline_resolveState(studentRow, histories, new Date(2026, 5, 30)).fee, 100000);
  assertEqual_("역순 미래변경 7월", StudentTimeline_resolveState(studentRow, histories, new Date(2026, 6, 31)).fee, 110000);
  assertEqual_("역순 미래변경 8월", StudentTimeline_resolveState(studentRow, histories, new Date(2026, 7, 31)).fee, 120000);
  var pendingHistory = StudentTimeline_withPendingChange_(histories["S-TEST"].fee, {
    effectiveDate: "2026-07-10", createdAt: new Date(2026, 6, 2), before: 100000, after: 115000
  });
  assertEqual_("중간 미래변경 후 최종 계획값 유지",
    StudentTimeline_resolveValue(studentRow[IDX.STUDENT.FEE], pendingHistory, new Date(9999, 11, 31)), 120000);
  assertEqual_("미래변경 직전값 계산",
    StudentTimeline_resolveValueBeforeDate_(studentRow[IDX.STUDENT.FEE], histories["S-TEST"].fee, "2026-07-10"), 100000);
  var teacherTimelineRow = [];
  teacherTimelineRow[IDX.STUDENT.ID] = "S-TEACHER-ID";
  teacherTimelineRow[IDX.STUDENT.TEACHER] = "B";
  teacherTimelineRow[IDX.STUDENT.TEACHER_ID] = "T-B";
  var teacherTimelineHistories = { "S-TEACHER-ID": {
    fee: [], status: [], discount: [], courseMode: [], teacher: [{
      effectiveDate: new Date(2026, 6, 15), createdAt: 1, rowOrder: 1,
      before: "A", after: "B", refId: "T-B"
    }]
  } };
  var teacherTimelineOptions = { teacherIdByName: { A: "T-A", B: "T-B" } };
  assertEqual_("담당 변경 전 원장 ID 복원", StudentTimeline_resolveState(
    teacherTimelineRow, teacherTimelineHistories, new Date(2026, 6, 14), teacherTimelineOptions
  ).teacherId, "T-A");
  assertEqual_("담당 변경 후 이벤트 원장 ID 적용", StudentTimeline_resolveState(
    teacherTimelineRow, teacherTimelineHistories, new Date(2026, 6, 15), teacherTimelineOptions
  ).teacherId, "T-B");
  var teacherOwnershipFixture = MonthlySnapshot_buildTeacherOwnerships_(
    teacherTimelineRow, teacherTimelineHistories, teacherTimelineOptions.teacherIdByName
  );
  assertEqual_("급여 담당 기간 변경 전 원장 ID", teacherOwnershipFixture[0].teacherId, "T-A");
  assertEqual_("급여 담당 기간 변경 후 원장 ID", teacherOwnershipFixture[1].teacherId, "T-B");

  var statusDiagnosticRows = [[]];
  var activeWithPastExit = [];
  activeWithPastExit[IDX.STUDENT.ID] = "S-STATUS-1";
  activeWithPastExit[IDX.STUDENT.NAME] = "과거퇴원일재원";
  activeWithPastExit[IDX.STUDENT.STATUS] = "재원";
  activeWithPastExit[IDX.STUDENT.EXIT_DATE] = "2026-07-31";
  var activeWithFutureExit = [];
  activeWithFutureExit[IDX.STUDENT.ID] = "S-STATUS-2";
  activeWithFutureExit[IDX.STUDENT.NAME] = "미래퇴원예정";
  activeWithFutureExit[IDX.STUDENT.STATUS] = "퇴원";
  activeWithFutureExit[IDX.STUDENT.EXIT_DATE] = "2026-09-01";
  var retiredWithoutExit = [];
  retiredWithoutExit[IDX.STUDENT.ID] = "S-STATUS-3";
  retiredWithoutExit[IDX.STUDENT.NAME] = "퇴원일누락";
  retiredWithoutExit[IDX.STUDENT.STATUS] = "퇴원";
  retiredWithoutExit[IDX.STUDENT.EXIT_DATE] = "";
  statusDiagnosticRows.push(activeWithPastExit, activeWithFutureExit, retiredWithoutExit);
  var statusDiagnosticHistories = {
    "S-STATUS-2": { fee: [], teacher: [], discount: [], courseMode: [], status: [{
      effectiveDate: new Date(2026, 8, 1), createdAt: 1, rowOrder: 1, before: "재원", after: "퇴원"
    }] }
  };
  var statusDateIssues = SystemDiagnostics_findStudentStatusDateMismatches_(
    statusDiagnosticRows, statusDiagnosticHistories, new Date(2026, 7, 13)
  );
  assertEqual_("상태·퇴원일 모순 2건 탐지", statusDateIssues.length, 2);
  assertEqual_("미래 퇴원 예정은 상태·퇴원일 모순에서 제외",
    statusDateIssues.some(function(item) { return item.studentId === "S-STATUS-2"; }), false);

  assertEqual_("양수 0.5원 절댓값 바깥 반올림", DateMoney_roundWon(1.5), 2);
  assertEqual_("음수 0.5원 절댓값 바깥 반올림", DateMoney_roundWon(-1.5), -2);
  assertEqual_("평년의 잘못된 2월 29일 거부", DateMoney_parseDateOnly("2026-02-29"), null);
  assertEqual_("윤년 날짜", DateMoney_formatDateOnly(DateMoney_parseDateOnly("2028-02-29")), "2028-02-29");
  assertEqual_("윤년 2월 말 포함 기간 일수", DateMoney_inclusiveDays(
    DateMoney_parseDateOnly("2028-02-28"), DateMoney_parseDateOnly("2028-03-01")), 3);
  assertEqual_("설정된 2월 기준일", DateMoney_billingDays(2028, 2), OperationalSettings_getNumber_("FEBRUARY_BILLING_DAYS", 30));
  assertEqual_("기준일 월말 보정", StudentTimeline_normalizeFeeEffectiveDate("2028-02-10", 31), "2028-02-29");
  assertEqual_("귀속월 Date 직렬화 전 월 고정",
    MonthlySnapshot_monthString_(new Date(2026, 5, 1)), "2026-06");
  var configuredCutoffDay = OperationalSettings_getNumber_("DASHBOARD_MONTH_CUTOFF_DAY", 10);
  assertEqual_("대시보드 전환일 전 전달 조회",
    Dashboard_defaultTargetYmForDate_(new Date(2026, 7, configuredCutoffDay - 1, 12, 0, 0)), "2026-07");
  assertEqual_("대시보드 전환일부터 당월 조회",
    Dashboard_defaultTargetYmForDate_(new Date(2026, 7, configuredCutoffDay, 12, 0, 0)), "2026-08");
  assertEqual_("대시보드 1월 전환일 전 연도 경계",
    Dashboard_defaultTargetYmForDate_(new Date(2026, 0, configuredCutoffDay - 1, 12, 0, 0)), "2025-12");
  assertEqual_("미납 연속 월 계산 연도 경계", Dashboard_shiftMonth_("2026-01", -1), "2025-12");
  assertEqual_("미납 연속 월 계산 윤년 경계", Dashboard_shiftMonth_("2024-03", -1), "2024-02");
  var specialFeeRow = [];
  specialFeeRow[IDX.STUDENT.ID] = "S-SPECIAL-FEE";
  specialFeeRow[IDX.STUDENT.FEE] = 240000;
  specialFeeRow[IDX.STUDENT.COURSE_MODE] = STUDENT_COURSE_MODES.SPECIAL_ONLY;
  assertEqual_("특강 전용 청구액은 0원", StudentTimeline_resolveState(specialFeeRow, {}, new Date()).fee, 0);
  assertEqual_("특강 전용 기본 수강료 원값은 보존",
    Number(StudentTimeline_resolveValue(specialFeeRow[IDX.STUDENT.FEE], [], new Date(9999, 11, 31))), 240000);
  var vacationProration = PaymentDomain_calculateProratedPeriod_(310000,
    new Date(2026, 7, 10), new Date(2026, 7, 20), [
      { startDate:"2026-08-12", endDate:"2026-08-14", reason:"휴가1" },
      { startDate:"2026-08-14", endDate:"2026-08-16", reason:"휴가2" },
      { startDate:"2026-07-01", endDate:"2026-07-31", reason:"범위 밖" }
    ]);
  assertEqual_("일할 휴가 겹침 날짜 중복 제외", vacationProration.vacationDays, 5);
  assertEqual_("일할 휴가 제외 후 적용일수", vacationProration.activeDays, 6);
  assertEqual_("일할 휴가 제외 후 금액", vacationProration.amount, 60000);
  var vacationNotApplied = PaymentDomain_calculateProratedPeriod_(310000,
    new Date(2026, 7, 10), new Date(2026, 7, 20), []);
  assertEqual_("휴가 미적용 시 선택 기간 전체 사용", vacationNotApplied.activeDays, 11);
  assertEqual_("휴가 미적용 시 일할 금액", vacationNotApplied.amount, 110000);

  var configuredTolerance = PaymentDomain_toleranceWon_();
  assertEqual_("허용 오차만큼 부족 시 완납", PaymentDomain_calculateBalance(300000, 300000 - configuredTolerance).status, "완납");
  assertEqual_("허용 오차 초과 부족 시 부분납", PaymentDomain_calculateBalance(300000, 300000 - configuredTolerance - 1).status, "부분납");
  assertEqual_("초과수납 완납", PaymentDomain_calculateBalance(300000, 500000).status, "완납");
  assertEqual_("8월 정산의 다음 달 퇴원 예정 표시", Salary_isLeavingNextMonth_("2026-09-15", "2026-08"), true);
  assertEqual_("8월 정산의 당월 퇴원은 다음 달 표시 제외", Salary_isLeavingNextMonth_("2026-08-31", "2026-08"), false);
  assertEqual_("12월 정산의 다음 해 1월 퇴원 표시", Salary_isLeavingNextMonth_("2027-01-01", "2026-12"), true);
  assertEqual_("정확한 금액 경고 없음", PaymentDomain_classifyDifference(0, "정규 금액").level, 0);
  assertEqual_("10원 차이 경고 없음", PaymentDomain_classifyDifference(-10, "정규 금액").level, 0);
  assertEqual_("11원 차이 확인 표시", PaymentDomain_classifyDifference(11, "정규 금액").level, 1);
  assertEqual_("1천원 완납 확인 표시", PaymentDomain_classifyDifference(-1000, "정규 금액").level, 1);
  assertEqual_("4999원 소액 확인", PaymentDomain_classifyDifference(4999, "정규 금액").level, 1);
  assertEqual_("5000원 주의 표시", PaymentDomain_classifyDifference(5000, "정규 금액").level, 2);
  var proratedExpected = PaymentDomain_prorateAdjustedFee(400000, 0, 0, 24, 31);
  assertEqual_("일할 수납 1원 차이 완납", PaymentDomain_calculateBalance(proratedExpected, proratedExpected + 1).status, "완납");
  assertEqual_("일할 수납 1원 차이 표시 없음", PaymentDomain_classifyDifference(1, "일할 금액").level, 0);
  assertEqual_("기존 동백전 방식 정규화", normalizePaymentMethod_("동백전"), "동백전QR");
  assertEqual_("기존 계좌 방식 정규화", normalizePaymentMethod_("계좌"), "계좌이체");
  assertEqual_("공통 결제 방식 유지", normalizePaymentMethod_("모락"), "모락");
  assertEqual_("빈 기존 수납 유형은 수강료", normalizePaymentType_(""), "수강료");
  assertEqual_("특강비 유형 보존", normalizePaymentType_("특강비"), "특강비");
  assertEqual_("기존 학생 수강형태 하위 호환", normalizeStudentCourseMode_(""), "정규");
  assertEqual_("특강 전용 수강형태", normalizeStudentCourseMode_("특강전용"), "특강전용");
  var specialOnlyStudentRow = [];
  specialOnlyStudentRow[IDX.STUDENT.ID] = "S-SPECIAL-ONLY";
  specialOnlyStudentRow[IDX.STUDENT.FEE] = 400000;
  specialOnlyStudentRow[IDX.STUDENT.STATUS] = "재원";
  specialOnlyStudentRow[IDX.STUDENT.TEACHER] = "A";
  specialOnlyStudentRow[IDX.STUDENT.COURSE_MODE] = "특강전용";
  assertEqual_("특강전용 학생의 기존 수강료도 조회 시 0원 강제",
    StudentTimeline_resolveState(specialOnlyStudentRow, {}, new Date(2026, 7, 1)).fee, 0);
  var specialEvaluation = PaymentDomain_evaluateMonthlyTuition_({
    billableFee: 0, activeDays: 31, billingDays: 31
  }, [{ type: "특강비", amount: 200000 }], { billingDays: 31 });
  assertEqual_("특강 전용 정규 청구액 0원", specialEvaluation.expected, 0);
  assertEqual_("특강비는 정규 수강료 수납액에서 제외", specialEvaluation.received, 0);
  var regularSpecialOnlyPayment = PaymentDomain_evaluateMonthlyTuition_({
    billableFee: 400000, activeDays: 31, billingDays: 31
  }, [{ type: "특강비", amount: 200000 }], { billingDays: 31 });
  assertEqual_("정규생의 특강비는 정규 수강료 납부로 계산하지 않음", regularSpecialOnlyPayment.received, 0);
  assertEqual_("정규생이 특강비만 납부해도 미납 유지", regularSpecialOnlyPayment.status, "미납");
  assertEqual_("정규생은 특강비만 있어도 급여 수강료 기준을 특강전용 0원으로 바꾸지 않음",
    Salary_resolveTuitionRevenue_(400000, 0, false, false, 31, 31).amount, 400000);
  assertEqual_("형제할인 후 일할", PaymentDomain_prorateAdjustedFee(300000, 25000, 0, 15, 30), 137500);
  var commonEvaluation = PaymentDomain_evaluateMonthlyTuition_({
    billableFee: 400000, activeDays: 31, billingDays: 31
  }, [{
    payId: "PAY-PRORATED", type: "수강료", amount: 309678,
    calcType: "PRORATED", activeDays: 24, billingDays: 31, memo: ""
  }], { billingDays: 31 });
  assertEqual_("공통 월평가 구조화 일할 예상액", commonEvaluation.expected, 309677);
  assertEqual_("공통 월평가 일할 1원 차이 완납", commonEvaluation.status, "완납");
  assertEqual_("공통 월평가 일할 1원 경고 없음", commonEvaluation.warningLevel, 0);
  var batchAuditMemo = PaymentLifecycle_buildAuditMemo_("가족 3명 일괄 수납", {
    "S-1": 1, "S-2": 1, "S-3": 1
  });
  assertEqual_("3인 수납 감사 메모 1000자 이하", batchAuditMemo.length < 1000, true);
  assertEqual_("3인 수납 감사 메모 상세행 제외", batchAuditMemo.indexOf("savedRows") === -1, true);
  var directRetryNormalized = PaymentLifecycle_normalizeRequestForRetry_({
    payDate:"2026-08-18", payMethod:"카드", payments:[{
      studentId:"S-TEST", newBaseDay:"", items:[{
        month:"2026-08", type:"수강료", amount:400000, memo:"", calcType:"STANDARD",
        siblingDiscount:0, otherDiscount:0
      }]
    }]
  });
  var directRetryFingerprint = PaymentLifecycle_requestFingerprint_(directRetryNormalized);
  assertEqual_("직접 수납 동일 내용 요청 지문 안정성",
    PaymentLifecycle_requestFingerprint_(PaymentLifecycle_normalizeRequestForRetry_({
      payDate:"2026-08-18", payMethod:"카드", payments:[{
        studentId:"S-TEST", newBaseDay:"", items:[{
          month:"2026-08", type:"수강료", amount:400000, memo:"", calcType:"STANDARD",
          siblingDiscount:0, otherDiscount:0
        }]
      }]
    })), directRetryFingerprint);
  var directChangedFingerprint = PaymentLifecycle_requestFingerprint_(PaymentLifecycle_normalizeRequestForRetry_({
    payDate:"2026-08-18", payMethod:"카드", payments:[{
      studentId:"S-TEST", newBaseDay:"", items:[{
        month:"2026-08", type:"수강료", amount:410000, memo:"", calcType:"STANDARD",
        siblingDiscount:0, otherDiscount:0
      }]
    }]
  }));
  assertEqual_("직접 수납 변경 금액 요청 지문 분리", directChangedFingerprint === directRetryFingerprint, false);
  assertEqual_("직접 수납 동일 완료 지문 재시도 허용",
    PaymentLifecycle_assertSameCompletedRequest_({ requestFingerprint:directRetryFingerprint },
      directRetryNormalized, directRetryFingerprint).requestFingerprint, directRetryFingerprint);
  var directChangedRetryBlocked = false;
  try {
    PaymentLifecycle_assertSameCompletedRequest_({ requestFingerprint:directRetryFingerprint },
      directRetryNormalized, directChangedFingerprint);
  } catch (directChangedRetryError) {
    directChangedRetryBlocked = String(directChangedRetryError && directChangedRetryError.message || "").indexOf("이전과 다른 수납 내용") !== -1;
  }
  assertEqual_("직접 수납 동일 요청 ID·변경 내용 재시도 차단", directChangedRetryBlocked, true);
  var fingerprintAuditMemo = JSON.parse(PaymentLifecycle_buildAuditMemo_(
    "저장 완료", { "S-TEST":21 }, directRetryFingerprint));
  assertEqual_("직접 수납 완료 이벤트 요청 지문 보존", fingerprintAuditMemo.requestFingerprint, directRetryFingerprint);
  [{}, { savedRows:[] }, "과거 저장 완료"].forEach(function(legacyCompletion, index) {
    var unknownCompletionBlocked = false;
    try { PaymentLifecycle_assertSameCompletedRequest_(legacyCompletion, directRetryNormalized, directRetryFingerprint); }
    catch (unknownCompletionError) { unknownCompletionBlocked = unknownCompletionError.message.indexOf("확인 전에는 새 요청") >= 0; }
    assertEqual_("비교 자료 없는 과거 완료 표식 차단 " + index, unknownCompletionBlocked, true);
  });
  var reconstructableCompletion = { savedRows:[{
    studentId:"S-TEST", fullDate:"2026-08-18", month:"2026-08", type:"수강료", amount:400000, method:"카드"
  }] };
  assertEqual_("수납 원본이 남은 구형 동일 재시도 호환",
    PaymentLifecycle_assertSameCompletedRequest_(reconstructableCompletion, directRetryNormalized, directRetryFingerprint), reconstructableCompletion);
  reconstructableCompletion.savedRows[0].amount = 410000;
  var legacyChangedBlocked = false;
  try { PaymentLifecycle_assertSameCompletedRequest_(reconstructableCompletion, directRetryNormalized, directRetryFingerprint); }
  catch (legacyChangedError) { legacyChangedBlocked = true; }
  assertEqual_("수납 원본이 남은 구형 변경 재시도 차단", legacyChangedBlocked, true);
  var maxLengthStudentId = new Array(101).join("S");
  var fourStudentBaseDays = {};
  for (var fourIndex = 1; fourIndex <= 4; fourIndex++) {
    fourStudentBaseDays[maxLengthStudentId.substring(0, 99) + fourIndex] = 31;
  }
  var fourPersonAuditMemo = PaymentLifecycle_buildAuditMemo_("가족 4명 일괄 수납 및 기준일 변경 반영", fourStudentBaseDays);
  assertEqual_("4인 최대길이 ID 감사 메모 1000자 이하", fourPersonAuditMemo.length < 1000, true);
  var fourPaymentRefs = ["PAY-" + new Array(37).join("1"), "PAY-" + new Array(37).join("2"),
    "PAY-" + new Array(37).join("3"), "PAY-" + new Array(37).join("4")].join(",");
  assertEqual_("4인 수납 참조 ID 500자 이하", fourPaymentRefs.length < 500, true);
  var batchEventRow = [];
  batchEventRow[IDX.EVENT.TYPE] = "수납일괄등록";
  batchEventRow[IDX.EVENT.REQUEST_ID] = "REQ-3";
  batchEventRow[IDX.EVENT.STATUS] = "완료";
  var proratedEventRow = batchEventRow.slice();
  proratedEventRow[IDX.EVENT.TYPE] = "일할수납등록";
  assertEqual_("중복 요청 일괄 이벤트 선택", Mutation_isCompletedBatchEventRow_(batchEventRow, "REQ-3"), true);
  assertEqual_("중복 요청 일할 이벤트 제외", Mutation_isCompletedBatchEventRow_(proratedEventRow, "REQ-3"), false);
  if (typeof Salary_allocateReceivedRevenue_ === "function") {
    assertEqual_("담당 변경 시 실제 수납 배분", Salary_allocateReceivedRevenue_(120000, 15, 30), 60000);
  }
  var eventHeader = [];
  var migratedEvent = [];
  migratedEvent[IDX.EVENT.ID] = "MIG-TEST";
  migratedEvent[IDX.EVENT.CREATED_AT] = new Date(2026, 0, 1);
  migratedEvent[IDX.EVENT.EFFECTIVE_DATE] = "2026-02-01";
  migratedEvent[IDX.EVENT.TYPE] = "기존로그이관";
  migratedEvent[IDX.EVENT.TARGET_ID] = "S-TEST";
  migratedEvent[IDX.EVENT.STUDENT_ID] = "S-TEST";
  migratedEvent[IDX.EVENT.FIELD] = "수강료 변경";
  migratedEvent[IDX.EVENT.BEFORE] = 400000;
  migratedEvent[IDX.EVENT.AFTER] = 450000;
  migratedEvent[IDX.EVENT.REF_ID] = "LEGACY-2";
  migratedEvent[IDX.EVENT.STATUS] = "완료";
  var nativeEvent = migratedEvent.slice();
  nativeEvent[IDX.EVENT.ID] = "EVT-TEST";
  nativeEvent[IDX.EVENT.TYPE] = "학생정보변경";
  nativeEvent[IDX.EVENT.REF_ID] = "";
  var compatibleEventRows = EventRepository_toLegacyRows_([eventHeader, migratedEvent, nativeEvent]);
  assertEqual_("이관·신규 이벤트 중복 제거", compatibleEventRows.length - 1, 1);
  assertEqual_("이벤트 시점 값 호환", compatibleEventRows[1][IDX.LOG.AFTER], 450000);
  var cancelledEvent = migratedEvent.slice();
  cancelledEvent[IDX.EVENT.ID] = "MIG-CANCELLED";
  cancelledEvent[IDX.EVENT.STATUS] = "취소";
  assertEqual_("취소 이벤트 시점 계산 제외",
    EventRepository_toLegacyRows_([eventHeader, cancelledEvent]).length, 1);
  var trashDate = new Date(2026, 6, 14, 10, 30, 0);
  var restoredTrashRow = Trash_deserializeRow_(Trash_serializeRow_(["PAY-1", trashDate, 300000]));
  assertEqual_("휴지통 날짜 형식 보존", restoredTrashRow[1] instanceof Date, true);
  assertEqual_("휴지통 금액 보존", restoredTrashRow[2], 300000);
  assertEqual_("휴지통 월말 2개월 보정", DateMoney_formatDateOnly(Trash_addMonthsClamped_(new Date(2026, 11, 31), 2)), "2027-02-28");
  var repositoryDate = new Date(2026, 6, 15, 4, 30, 0);
  var repositoryRows = [["ID", "날짜"], ["S-1", repositoryDate]];
  var decodedRows = DataRepository_decodeRows_(DataRepository_encodeRows_(repositoryRows));
  assertEqual_("공통 캐시 날짜 형식 보존", decodedRows[1][1] instanceof Date, true);
  assertEqual_("공통 캐시 날짜 값 보존", decodedRows[1][1].getTime(), repositoryDate.getTime());
  assertEqual_("공통 저장소 ID 행 검색", DataRepository_findRowById_(SHEET_NAMES.STUDENTS, repositoryRows, "S-1").rowNumber, 2);

  var studentHeader = [];
  var earlyExitStudent = [];
  earlyExitStudent[IDX.STUDENT.ID] = "S-EARLY";
  earlyExitStudent[IDX.STUDENT.NAME] = "월초퇴원";
  earlyExitStudent[IDX.STUDENT.STATUS] = "퇴원";
  earlyExitStudent[IDX.STUDENT.TEACHER] = "A";
  earlyExitStudent[IDX.STUDENT.FIRST_DATE] = new Date(2026, 0, 1);
  earlyExitStudent[IDX.STUDENT.EXIT_DATE] = new Date(2026, 5, 2);
  earlyExitStudent[IDX.STUDENT.FEE] = 300000;
  var transferStudent = [];
  transferStudent[IDX.STUDENT.ID] = "S-MOVE";
  transferStudent[IDX.STUDENT.NAME] = "담당변경";
  transferStudent[IDX.STUDENT.STATUS] = "재원";
  transferStudent[IDX.STUDENT.TEACHER] = "B";
  transferStudent[IDX.STUDENT.FIRST_DATE] = new Date(2026, 0, 1);
  transferStudent[IDX.STUDENT.FEE] = 300000;
  var logHeader = [];
  var teacherLog = [];
  teacherLog[IDX.LOG.CREATED_AT] = new Date(2026, 4, 1);
  teacherLog[IDX.LOG.STUDENT_ID] = "S-MOVE";
  teacherLog[IDX.LOG.ITEM] = "담당 원장 변경";
  teacherLog[IDX.LOG.BEFORE] = "A";
  teacherLog[IDX.LOG.AFTER] = "B";
  teacherLog[IDX.LOG.EFFECTIVE_DATE] = "2026-06-15";
  var paymentHeader = [];
  var paymentRow = [];
  paymentRow[IDX.PAYMENT.ID] = "PAY-T";
  paymentRow[IDX.PAYMENT.PAY_DATE] = new Date(2026, 5, 5);
  paymentRow[IDX.PAYMENT.STUDENT_ID] = "S-MOVE";
  paymentRow[IDX.PAYMENT.MONTH] = "2026-06";
  paymentRow[IDX.PAYMENT.TYPE] = "수강료";
  paymentRow[IDX.PAYMENT.AMOUNT] = 300000;
  paymentRow[IDX.PAYMENT.METHOD] = "계좌";
  var proratedPayment1 = [];
  proratedPayment1[IDX.PAYMENT.ID] = "PAY-P1";
  proratedPayment1[IDX.PAYMENT.PAY_DATE] = new Date(2026, 5, 5);
  proratedPayment1[IDX.PAYMENT.STUDENT_ID] = "S-PRORATE";
  proratedPayment1[IDX.PAYMENT.MONTH] = "2026-06";
  proratedPayment1[IDX.PAYMENT.TYPE] = "수강료";
  proratedPayment1[IDX.PAYMENT.AMOUNT] = 50000;
  proratedPayment1[IDX.PAYMENT.CALC_TYPE] = "PRORATED";
  var proratedPayment2 = proratedPayment1.slice();
  proratedPayment2[IDX.PAYMENT.ID] = "PAY-P2";
  proratedPayment2[IDX.PAYMENT.AMOUNT] = 70000;
  var specialPayment = proratedPayment1.slice();
  specialPayment[IDX.PAYMENT.ID] = "PAY-SPECIAL";
  specialPayment[IDX.PAYMENT.TYPE] = "특강비";
  specialPayment[IDX.PAYMENT.AMOUNT] = 30000;
  specialPayment[IDX.PAYMENT.CALC_TYPE] = "STANDARD";
  var vacationHeader = [];
  var vacationRow = [];
  vacationRow[IDX.VACATION.ID] = "VAC-T";
  vacationRow[IDX.VACATION.STUDENT_ID] = "S-MOVE";
  vacationRow[IDX.VACATION.START_DATE] = new Date(2026, 5, 10);
  vacationRow[IDX.VACATION.END_DATE] = new Date(2026, 5, 11);
  var snapshotContext = {};
  snapshotContext[SHEET_NAMES.STUDENTS] = [studentHeader, earlyExitStudent, transferStudent];
  snapshotContext[SHEET_NAMES.PAYMENTS] = [paymentHeader, paymentRow, proratedPayment1, proratedPayment2, specialPayment];
  snapshotContext[SHEET_NAMES.VACATIONS] = [vacationHeader, vacationRow];
  snapshotContext[SHEET_NAMES.LOGS] = [logHeader, teacherLog];
  var monthlySnapshot = MonthlySnapshot_build_("2026-06", snapshotContext);
  assertEqual_("월초 1~3일 퇴원 공통 제외", monthlySnapshot.studentsById["S-EARLY"].excludedByEarlyExit, true);
  assertEqual_("담당 변경 전 강사 월 목록", monthlySnapshot.teachersInMonth.indexOf("A") !== -1, true);
  assertEqual_("담당 변경 후 강사 월 목록", monthlySnapshot.teachersInMonth.indexOf("B") !== -1, true);
  assertEqual_("월별 휴가 차감 일수", monthlySnapshot.studentsById["S-MOVE"].activeDays, 28);
  assertEqual_("월별 수납 요약", MonthlySnapshot_buildPaymentSummary_(monthlySnapshot, "2026-06")["S-MOVE"].total, 300000);
  assertEqual_("분할 일할 실제 수납 합산", monthlySnapshot.proratedTuitionAmountByStudent["S-PRORATE"], 120000);
  assertEqual_("정산용 실제 수강료 합산", monthlySnapshot.tuitionReceivedAmountByStudent["S-PRORATE"], 120000);
  assertEqual_("특강비 정산 대상 유지", monthlySnapshot.specialPaymentsByStudent["S-PRORATE"][0].amount, 30000);
  var specialOnlyRow = specialPayment.slice();
  specialOnlyRow[IDX.PAYMENT.ID] = "PAY-SPECIAL-ONLY";
  specialOnlyRow[IDX.PAYMENT.STUDENT_ID] = "S-SPECIAL-ONLY";
  var specialOnlyContext = {};
  specialOnlyContext[SHEET_NAMES.STUDENTS] = [studentHeader];
  specialOnlyContext[SHEET_NAMES.PAYMENTS] = [paymentHeader, specialOnlyRow];
  specialOnlyContext[SHEET_NAMES.VACATIONS] = [vacationHeader];
  specialOnlyContext[SHEET_NAMES.LOGS] = [logHeader];
  var specialOnlySnapshot = MonthlySnapshot_build_("2026-06", specialOnlyContext);
  assertEqual_("특강비만 수납 식별", specialOnlySnapshot.specialOnlyPaymentByStudent["S-SPECIAL-ONLY"], true);
  assertEqual_("특강비만 수납 시 수강료 0원", Salary_resolveTuitionRevenue_(180000, 0, false, true, 30, 30).amount, 0);
  var exclusionResult = Salary_applyDirectReceiptExclusions_({ list: [
    { studentId: "S-CASH", totalRowRevenue: 300000, calculatedShare: 180000, calculationBasis: "실수납" },
    { studentId: "S-NORMAL", totalRowRevenue: 300000, calculatedShare: 180000, calculationBasis: "규정금액" }
  ], summary: {} }, ["S-CASH"]);
  assertEqual_("원장 직접수령 학생 제외", exclusionResult.data.list.length, 1);
  assertEqual_("직접수령 제외 후 원장 지분", exclusionResult.data.summary.teacherShare, 180000);
  var statisticsMonth = Statistics_buildMonth_("2026-06", snapshotContext);
  assertEqual_("기간 통계 재원 인원", statisticsMonth.activeStudents, 1);
  assertEqual_("기간 통계 수강료 합계", statisticsMonth.tuitionReceived, 420000);
  assertEqual_("기간 통계 기타 매출", statisticsMonth.otherRevenue, 30000);
  assertEqual_("기간 통계 총 수납", statisticsMonth.totalReceived, 450000);
  assertEqual_("기간 통계 결제수단 정규화",
    statisticsMonth.methods.filter(function(item) { return item.name === "계좌이체"; })[0].totalReceived, 300000);
  assertEqual_("기간 통계 월 범위", Statistics_monthRange_("2026-01", "2026-12").length, 12);
  var advancePayment = paymentRow.slice();
  advancePayment[IDX.PAYMENT.ID] = "PAY-ADVANCE";
  advancePayment[IDX.PAYMENT.PAY_DATE] = new Date(2026, 4, 25);
  var advanceContext = {};
  advanceContext[SHEET_NAMES.STUDENTS] = [studentHeader, transferStudent];
  advanceContext[SHEET_NAMES.PAYMENTS] = [paymentHeader, advancePayment];
  advanceContext[SHEET_NAMES.VACATIONS] = [vacationHeader];
  advanceContext[SHEET_NAMES.LOGS] = [logHeader];
  var advanceStatistics = Statistics_buildMonth_("2026-06", advanceContext, "PAY_DATE");
  assertEqual_("선납은 6월 현금흐름 수납에서 제외", advanceStatistics.tuitionReceived, 0);
  assertEqual_("선납도 귀속월 상태 수납에는 포함", advanceStatistics.attributedTuitionReceived, 300000);
  assertEqual_("선납 학생 귀속월 완납 유지", advanceStatistics.fullPaid, 1);
  assertEqual_("선납 학생 허위 미납 방지", advanceStatistics.unpaid, 0);

  var salarySettlementHeader = [];
  var salarySettlementRow = [];
  salarySettlementRow[IDX.SALARY_SETTLEMENT.ID] = "SAL-TEST";
  salarySettlementRow[IDX.SALARY_SETTLEMENT.YM] = "2026-06";
  salarySettlementRow[IDX.SALARY_SETTLEMENT.TEACHER_NAME] = "A";
  salarySettlementRow[IDX.SALARY_SETTLEMENT.STATUS] = "일부지급";
  salarySettlementRow[IDX.SALARY_SETTLEMENT.FINAL_AMOUNT] = 180000;
  salarySettlementRow[IDX.SALARY_SETTLEMENT.BALANCE_AMOUNT] = 80000;
  var salaryEntryHeader = [];
  var salaryEntryRow = [];
  salaryEntryRow[IDX.SALARY_ENTRY.ID] = "SLE-TEST";
  salaryEntryRow[IDX.SALARY_ENTRY.SETTLEMENT_ID] = "SAL-TEST";
  salaryEntryRow[IDX.SALARY_ENTRY.TYPE] = "지급";
  salaryEntryRow[IDX.SALARY_ENTRY.AMOUNT] = 100000;
  salaryEntryRow[IDX.SALARY_ENTRY.ENTRY_DATE] = new Date(2026, 6, 1);
  salaryEntryRow[IDX.SALARY_ENTRY.STATUS] = "완료";
  var salaryStatisticsContext = {};
  salaryStatisticsContext[SHEET_NAMES.SALARY_SETTLEMENTS] = [salarySettlementHeader, salarySettlementRow];
  salaryStatisticsContext[SHEET_NAMES.SALARY_ENTRIES] = [salaryEntryHeader, salaryEntryRow];
  var salaryStatistics = Statistics_buildSalaryStats_(["2026-06", "2026-07"], salaryStatisticsContext);
  assertEqual_("급여 확정액은 귀속월 집계", salaryStatistics.months["2026-06"].finalAmount, 180000);
  assertEqual_("급여 지급액은 지급월 집계", salaryStatistics.months["2026-07"].paidAmount, 100000);
  assertEqual_("급여 귀속 잔액 집계", salaryStatistics.months["2026-06"].balanceAmount, 80000);

  var pastExitStudent = [];
  pastExitStudent[IDX.STUDENT.ID] = "S-PAST-EXIT";
  pastExitStudent[IDX.STUDENT.NAME] = "과거퇴원";
  pastExitStudent[IDX.STUDENT.GRADE] = "고2";
  pastExitStudent[IDX.STUDENT.STATUS] = "퇴원";
  pastExitStudent[IDX.STUDENT.TEACHER] = "A";
  pastExitStudent[IDX.STUDENT.FIRST_DATE] = new Date(2026, 0, 1);
  pastExitStudent[IDX.STUDENT.EXIT_DATE] = new Date(2026, 0, 31);
  pastExitStudent[IDX.STUDENT.RATE] = 0.6;
  pastExitStudent[IDX.STUDENT.FEE] = 400000;
  var julyContext = {};
  julyContext[SHEET_NAMES.STUDENTS] = [studentHeader, pastExitStudent];
  julyContext[SHEET_NAMES.PAYMENTS] = [paymentHeader];
  julyContext[SHEET_NAMES.VACATIONS] = [vacationHeader];
  julyContext[SHEET_NAMES.LOGS] = [logHeader];
  var julySnapshot = MonthlySnapshot_build_("2026-07", julyContext);
  assertEqual_("과거 퇴원생 7월 재원 제외", julySnapshot.studentsById["S-PAST-EXIT"].inMonth, false);
  assertEqual_("전달 퇴원생 미납 확인 유지",
    Dashboard_isRetiredCarryover_(julySnapshot.studentsById["S-PAST-EXIT"], new Date(2026, 0, 1), new Date(2026, 1, 28)), true);
  assertEqual_("오래된 퇴원생 이월 종료",
    Dashboard_isRetiredCarryover_(julySnapshot.studentsById["S-PAST-EXIT"], new Date(2026, 5, 1), new Date(2026, 6, 31)), false);

  var febStudent = [];
  febStudent[IDX.STUDENT.ID] = "S-FEB-VAC";
  febStudent[IDX.STUDENT.NAME] = "2월전체휴가";
  febStudent[IDX.STUDENT.STATUS] = "재원";
  febStudent[IDX.STUDENT.TEACHER] = "A";
  febStudent[IDX.STUDENT.FIRST_DATE] = new Date(2026, 0, 1);
  febStudent[IDX.STUDENT.FEE] = 300000;
  var febVacation = [];
  febVacation[IDX.VACATION.ID] = "VAC-FEB";
  febVacation[IDX.VACATION.STUDENT_ID] = "S-FEB-VAC";
  febVacation[IDX.VACATION.START_DATE] = new Date(2026, 1, 1);
  febVacation[IDX.VACATION.END_DATE] = new Date(2026, 1, 28);
  febVacation[IDX.VACATION.PERIOD_TYPE] = VACATION_PERIOD_TYPES.VACATION;
  var febContext = {};
  febContext[SHEET_NAMES.STUDENTS] = [studentHeader, febStudent];
  febContext[SHEET_NAMES.PAYMENTS] = [paymentHeader];
  febContext[SHEET_NAMES.VACATIONS] = [vacationHeader, febVacation];
  febContext[SHEET_NAMES.LOGS] = [logHeader];
  var febSnapshot = MonthlySnapshot_build_("2026-02", febContext);
  assertEqual_("2월 전체 일반휴가 재원 유지", febSnapshot.studentsById["S-FEB-VAC"].inMonth, true);
  assertEqual_("2월 전체 일반휴가 0일", febSnapshot.studentsById["S-FEB-VAC"].activeDays, 0);
  var febFullStudent = febStudent.slice();
  febFullStudent[IDX.STUDENT.ID] = "S-FEB-FULL";
  febFullStudent[IDX.STUDENT.NAME] = "2월만근";
  var febFullContext = {};
  febFullContext[SHEET_NAMES.STUDENTS] = [studentHeader, febFullStudent];
  febFullContext[SHEET_NAMES.PAYMENTS] = [paymentHeader];
  febFullContext[SHEET_NAMES.VACATIONS] = [vacationHeader];
  febFullContext[SHEET_NAMES.LOGS] = [logHeader];
  var febFullSnapshot = MonthlySnapshot_build_("2026-02", febFullContext);
  assertEqual_("2월 만근 일수는 운영설정 기준", febFullSnapshot.studentsById["S-FEB-FULL"].activeDays, febFullSnapshot.billingDays);

  var returnStudent = [];
  returnStudent[IDX.STUDENT.ID] = "S-RETURN";
  returnStudent[IDX.STUDENT.NAME] = "복귀학생";
  returnStudent[IDX.STUDENT.STATUS] = "재원";
  returnStudent[IDX.STUDENT.TEACHER] = "A";
  returnStudent[IDX.STUDENT.FIRST_DATE] = new Date(2025, 0, 1);
  returnStudent[IDX.STUDENT.EXIT_DATE] = "";
  returnStudent[IDX.STUDENT.FEE] = 300000;
  var retiredLog = [];
  retiredLog[IDX.LOG.CREATED_AT] = new Date(2025, 5, 30);
  retiredLog[IDX.LOG.STUDENT_ID] = "S-RETURN";
  retiredLog[IDX.LOG.ITEM] = "상태 변경";
  retiredLog[IDX.LOG.BEFORE] = "재원";
  retiredLog[IDX.LOG.AFTER] = "퇴원";
  retiredLog[IDX.LOG.EFFECTIVE_DATE] = "2025-06-30";
  var returnedLog = [];
  returnedLog[IDX.LOG.CREATED_AT] = new Date(2025, 7, 10);
  returnedLog[IDX.LOG.STUDENT_ID] = "S-RETURN";
  returnedLog[IDX.LOG.ITEM] = "상태 변경";
  returnedLog[IDX.LOG.BEFORE] = "퇴원";
  returnedLog[IDX.LOG.AFTER] = "재원";
  returnedLog[IDX.LOG.EFFECTIVE_DATE] = "2025-08-10";
  var retirementGap = [];
  retirementGap[IDX.VACATION.ID] = "GAP-RETURN";
  retirementGap[IDX.VACATION.STUDENT_ID] = "S-RETURN";
  retirementGap[IDX.VACATION.START_DATE] = new Date(2025, 6, 1);
  retirementGap[IDX.VACATION.END_DATE] = new Date(2025, 7, 9);
  retirementGap[IDX.VACATION.PERIOD_TYPE] = VACATION_PERIOD_TYPES.RETIREMENT_GAP;
  var returnContext = {};
  returnContext[SHEET_NAMES.STUDENTS] = [studentHeader, returnStudent];
  returnContext[SHEET_NAMES.PAYMENTS] = [paymentHeader];
  returnContext[SHEET_NAMES.VACATIONS] = [vacationHeader, retirementGap];
  returnContext[SHEET_NAMES.LOGS] = [logHeader, retiredLog, returnedLog];
  var gapMonthSnapshot = MonthlySnapshot_build_("2025-07", returnContext);
  var returnMonthSnapshot = MonthlySnapshot_build_("2025-08", returnContext);
  assertEqual_("퇴원공백 전체 월 재원 제외", gapMonthSnapshot.studentsById["S-RETURN"].inMonth, false);
  assertEqual_("퇴원일 삭제 후 이벤트 퇴원일 복원",
    DateMoney_formatDateOnly(gapMonthSnapshot.studentsById["S-RETURN"].exitDate), "2025-06-30");
  assertEqual_("복귀 월 퇴원공백 차감", returnMonthSnapshot.studentsById["S-RETURN"].activeDays, 22);
  assertEqual_("복귀 월 재원 포함", returnMonthSnapshot.studentsById["S-RETURN"].inMonth, true);
  assertEqual_("퇴원공백은 일반휴가 통계에서 제외", returnMonthSnapshot.studentsById["S-RETURN"].vacationDays, 0);
  var generatedGapDates = VacationDomain_buildRetirementGapDates_("2026-01-31", "2026-07-10");
  assertEqual_("퇴원공백 시작일 자동 계산", generatedGapDates.startDate, "2026-02-01");
  assertEqual_("퇴원공백 종료일 자동 계산", generatedGapDates.endDate, "2026-07-09");
  assertEqual_("퇴원공백과 기존 휴가 겹침 탐지",
    VacationDomain_periodsOverlap_("2026-02-01", "2026-07-09", "2026-03-10", "2026-03-12"), true);
  assertEqual_("퇴원공백 직전 기간은 겹침 아님",
    VacationDomain_periodsOverlap_("2026-02-01", "2026-07-09", "2026-01-31", "2026-01-31"), false);
  assertEqual_("미래 복귀 예약 학생의 다른 정보 수정은 실제 복귀 아님",
    StudentUpdate_shouldCreateReturnGap_({ statusChanged:false }, "퇴원", "재원", "재원"), false);
  assertEqual_("명시적으로 바꾼 퇴원→재원은 실제 복귀",
    StudentUpdate_shouldCreateReturnGap_({ statusChanged:true }, "퇴원", "재원", "퇴원"), true);
  assertEqual_("클라이언트 거짓 플래그로 일반 복귀 공백 생성을 생략할 수 없음",
    StudentUpdate_shouldCreateReturnGap_({ statusChanged:false }, "퇴원", "재원", "퇴원"), true);
  assertEqual_("과거 화면의 일반 퇴원→재원 호환",
    StudentUpdate_shouldCreateReturnGap_({}, "퇴원", "재원", "퇴원"), true);

  var discountStudent = [];
  discountStudent[IDX.STUDENT.ID] = "S-DISCOUNT";
  discountStudent[IDX.STUDENT.FEE] = 300000;
  discountStudent[IDX.STUDENT.STATUS] = "재원";
  discountStudent[IDX.STUDENT.TEACHER] = "A";
  discountStudent[IDX.STUDENT.FAMILY_DISCOUNT] = 0;
  var discountHistories = { "S-DISCOUNT": { fee: [], status: [], teacher: [], discount: [
    { effectiveDate: new Date(2026, 2, 1), createdAt: 1, rowOrder: 1, before: 0, after: 25000 },
    { effectiveDate: new Date(2026, 7, 1), createdAt: 2, rowOrder: 2, before: 25000, after: 0 }
  ] } };
  assertEqual_("형제할인 시작 전", StudentTimeline_resolveState(
    discountStudent, discountHistories, new Date(2026, 1, 28)).siblingDiscount, 0);
  assertEqual_("형제할인 적용 중", StudentTimeline_resolveState(
    discountStudent, discountHistories, new Date(2026, 5, 30)).siblingDiscount, 25000);
  assertEqual_("형제할인 종료 후", StudentTimeline_resolveState(
    discountStudent, discountHistories, new Date(2026, 7, 31)).siblingDiscount, 0);
  assertEqual_("기간 통계 사전 인덱스 재사용",
    MonthlySnapshot_prepareContext_(returnContext) === MonthlySnapshot_prepareContext_(returnContext), true);
  var editedProration = PaymentLifecycle_prepareCalculationMetadata_({
    calcType: "PRORATED", calcStart: "2026-07-01", calcEnd: "2026-07-20",
    activeDays: 20, billingDays: 31, siblingDiscount: 0, otherDiscount: 0
  });
  assertEqual_("일할 수정 후 기준일 계산", editedProration.nextBaseDay, 21);
  var prorationWarningPercent = PaymentDomain_prorationWarningPercent_();
  var prorationBoundaryAmount = 100000 + Math.floor(100000 * prorationWarningPercent / 100);
  assertEqual_("일할 금액 설정 경계 이내 허용", PaymentDomain_prorationDifference_(prorationBoundaryAmount, 100000).exceeds, false);
  assertEqual_("일할 금액 설정 경계 초과 경고", PaymentDomain_prorationDifference_(prorationBoundaryAmount + 1, 100000).exceeds, true);
  assertEqual_("월 단위 무효화 범위", MonthlyCache_monthsBetween_("2026-12-20", "2027-02-03").join(","), "2026-12,2027-01,2027-02");
  var storedFactFixture = MonthlySnapshotStore_fromFact_(MonthlySnapshotStore_toFact_({
    state:{ fee:300000, status:"재원", teacher:"A" }, currentState:{ status:"재원" },
    firstDate:new Date(2026, 0, 2), exitDate:null, excludedByEarlyExit:false, inMonth:true,
    validStart:new Date(2026, 7, 1), validEnd:new Date(2026, 7, 31), activeDays:31,
    vacationDays:0, retirementGapDays:0, absenceDays:0,
    teacherOwnerships:[{ teacher:"A", teacherId:"T-A", start:new Date(2026, 0, 1), end:new Date(2099, 11, 31) }],
    baseFee:300000, siblingDiscount:0, billableFee:300000, courseMode:"정규", specialOnly:false
  }));
  assertEqual_("월별 스냅샷 날짜 복원", formatDateOnly_(storedFactFixture.validEnd), "2026-08-31");
  assertEqual_("월별 스냅샷 담당 원장 복원", storedFactFixture.teacherOwnerships[0].teacherId, "T-A");
  assertEqual_("월별 스냅샷은 날짜 의존 현재상태를 저장하지 않음",
    Object.prototype.hasOwnProperty.call(storedFactFixture, "currentState"), false);
  assertEqual_("월별 스냅샷 정상 payload 직렬화",
    MonthlySnapshotStore_serializeFact_(storedFactFixture) !== null, true);
  var oversizedOwnerships = [];
  for (var ownershipIndex = 0; ownershipIndex < 600; ownershipIndex++) {
    oversizedOwnerships.push({
      teacher:"담당원장-" + new Array(81).join("가") + ownershipIndex,
      teacherId:"T-" + ownershipIndex,
      start:new Date(2026, 0, 1), end:new Date(2099, 11, 31)
    });
  }
  var oversizedFactFixture = {
    state:{ fee:300000, status:"재원", teacher:"A" }, firstDate:new Date(2026, 0, 2),
    validStart:new Date(2026, 7, 1), validEnd:new Date(2026, 7, 31),
    teacherOwnerships:oversizedOwnerships
  };
  assertEqual_("월별 스냅샷 과대 payload 저장 차단",
    MonthlySnapshotStore_serializeFact_(oversizedFactFixture), null);

  var persistentFactsFixture = {};
  monthlySnapshot.students.forEach(function(student) {
    persistentFactsFixture[student.id] = MonthlySnapshotStore_fromFact_(MonthlySnapshotStore_toFact_(student));
  });
  var originalSnapshotRead = MonthlySnapshotStore_read_;
  var originalSnapshotWrite = MonthlySnapshotStore_write_;
  try {
    snapshotContext.__dataRepositoryFullContext = true;
    MonthlySnapshotStore_read_ = function() {
      return { facts:persistentFactsFixture, status:"persistent_hit", sourceVersion:"TEST" };
    };
    MonthlySnapshotStore_write_ = function() { throw new Error("저장본 적중 시 재기록하면 안 됩니다."); };
    var persistentHitSnapshot = MonthlySnapshot_build_("2026-06", snapshotContext);
    assertEqual_("영구 스냅샷 적중 전후 화면 계산 payload 일치",
      JSON.stringify(MonthlySnapshotStore_parityPayload_(persistentHitSnapshot)),
      JSON.stringify(MonthlySnapshotStore_parityPayload_(monthlySnapshot)));
  } finally {
    MonthlySnapshotStore_read_ = originalSnapshotRead;
    MonthlySnapshotStore_write_ = originalSnapshotWrite;
    delete snapshotContext.__dataRepositoryFullContext;
  }

  var originalEventCacheClear = DataRepository_clearCache_;
  var originalMonthlyDirty = MonthlyCache_markAllDirty_;
  var originalSnapshotStale = MonthlySnapshotStore_markAllStale_;
  var restoredInvalidations = [];
  try {
    DataRepository_clearCache_ = function(sheetName) { restoredInvalidations.push("RAW:" + sheetName); };
    MonthlyCache_markAllDirty_ = function() { restoredInvalidations.push("MONTHLY"); };
    MonthlySnapshotStore_markAllStale_ = function() { restoredInvalidations.push("SNAPSHOT"); };
    assertEqual_("대기 이벤트 미복원 시 무효화 생략", Mutation_invalidateTimelineCachesAfterRestore_(0), false);
    assertEqual_("대기 이벤트 미복원 시 호출 없음", restoredInvalidations.length, 0);
    assertEqual_("대기 이벤트 복원 시 무효화 수행", Mutation_invalidateTimelineCachesAfterRestore_(2), true);
    assertEqual_("대기 이벤트 복원 시 전체 월 결과·스냅샷 무효화",
      restoredInvalidations.join(","), "RAW:" + SHEET_NAMES.EVENTS + ",MONTHLY,SNAPSHOT");
  } finally {
    DataRepository_clearCache_ = originalEventCacheClear;
    MonthlyCache_markAllDirty_ = originalMonthlyDirty;
    MonthlySnapshotStore_markAllStale_ = originalSnapshotStale;
  }
  var dashboardDependencyMonths = Dashboard_cacheDependencyMonths_("2026-08");
  assertEqual_("대시보드 캐시 과거 의존 범위", dashboardDependencyMonths[0], "2024-09");
  assertEqual_("대시보드 캐시 미래 의존 범위", dashboardDependencyMonths[dashboardDependencyMonths.length - 1], "2026-09");
  assertEqual_("대시보드 캐시 의존 월 개수", dashboardDependencyMonths.length, 25);
  assertEqual_("사용자 진단 자력 대응 안내",
    SystemDiagnostics_recoveryAction_("DUPLICATE_USER_EMAIL").indexOf("등록 사용자") >= 0, true);
  assertEqual_("DB 참조 진단 안전 대응 안내",
    SystemDiagnostics_recoveryAction_("ORPHAN_PAYMENT_STUDENT").indexOf("수동 백업") >= 0, true);
  assertEqual_("자동 운영 진단 자력 복구 안내",
    DeploymentDiagnostics_recoveryAction_("자동 운영 트리거").indexOf("설치/갱신") >= 0, true);
  assertEqual_("백업 폴더 진단 권한 대응 안내",
    DeploymentDiagnostics_recoveryAction_("백업 폴더 접근").indexOf("편집 권한") >= 0, true);
  return "통합 회귀 테스트 통과";
}
