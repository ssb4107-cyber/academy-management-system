/**
 * 공통 시트명/열 정의.
 * COL은 getRange(row, col)에 쓰는 1-based 번호이고,
 * IDX는 getValues() 배열에 쓰는 0-based 번호입니다.
 */
var SHEET_NAMES = {
  STUDENTS: "DB_명단",
  PAYMENTS: "DB_수납",
  REQUESTS: "DB_요청",
  LOGS: "DB_로그",
  VACATIONS: "DB_휴가기간",
  EVENTS: "DB_이벤트",
  TRASH: "DB_휴지통",
  TEACHERS: "DB_원장",
  USERS: "DB_사용자",
  SETTINGS: "DB_설정",
  SALARY_SETTLEMENTS: "DB_급여정산",
  SALARY_ENTRIES: "DB_급여내역",
  HOME: "바탕화면"
};

var COL = {
  STUDENT: {
    ID: 1,
    NAME: 2,
    GRADE: 3,
    STATUS: 4,
    TEACHER: 5,
    FIRST_DATE: 6,
    EXIT_DATE: 7,
    BASE_DAY: 8,
    RATE: 9,
    PHONE: 10,
    FEE: 11,
    FAMILY_ID: 13,
    FAMILY_NAME: 14,
    CASH_RECEIPT: 15,
    PARENT_NAME: 16,
    ORIGINAL_JOIN_DATE: 17
    ,FAMILY_DISCOUNT: 18
    ,COURSE_MODE: 19
    ,TEACHER_ID: 20
  },
  PAYMENT: {
    ID: 1,
    CREATED_AT: 2,
    PAY_DATE: 3,
    STUDENT_ID: 4,
    STUDENT_NAME: 5,
    MONTH: 6,
    TYPE: 7,
    AMOUNT: 9,
    METHOD: 10,
    MEMO: 13
    ,REQUEST_ID: 14
    ,RECORD_STATUS: 16
    ,CALC_TYPE: 17
    ,CALC_START: 18
    ,CALC_END: 19
    ,ACTIVE_DAYS: 20
    ,BILLING_DAYS: 21
    ,SIBLING_DISCOUNT: 22
    ,OTHER_DISCOUNT: 23
  },
  REQUEST: {
    ID:1, CREATED_AT:2, CATEGORY:3, TYPE:4, STATUS:5, TARGET_ID:6, TARGET_NAME:7,
    SUMMARY:8, PAYLOAD:9, REQUESTER_EMAIL:10, REQUESTER_NAME:11, EVIDENCE_IDS:12,
    SOURCE_SHEET:13, SOURCE_ID:14, EFFECTIVE_DATE:15, PROCESSED_AT:16, PROCESSED_BY:17,
    DECISION_MEMO:18, RESULT:19, ERROR:20, UPDATED_AT:21, SCHEMA_VERSION:22
  },
  LOG: {
    CREATED_AT: 1,
    STUDENT_NAME: 2,
    STUDENT_ID: 3,
    ITEM: 4,
    BEFORE: 5,
    AFTER: 6,
    EFFECTIVE_DATE: 7,
    REF_ID: 8
  },
  VACATION: {
    ID: 1,
    STUDENT_ID: 2,
    STUDENT_NAME: 3,
    START_DATE: 4,
    END_DATE: 5,
    REASON: 6,
    CREATED_AT: 7,
    PERIOD_TYPE: 8,
    START_EVENT_ID: 9,
    END_EVENT_ID: 10,
    CREATED_METHOD: 11
  },
  EVENT: {
    ID: 1,
    CREATED_AT: 2,
    EFFECTIVE_DATE: 3,
    TYPE: 4,
    TARGET_TYPE: 5,
    TARGET_ID: 6,
    STUDENT_ID: 7,
    FIELD: 8,
    BEFORE: 9,
    AFTER: 10,
    REF_ID: 11,
    REQUEST_ID: 12,
    GROUP_ID: 13,
    USER_EMAIL: 14,
    STATUS: 15,
    CANCEL_EVENT_ID: 16,
    MEMO: 17,
    SCHEMA_VERSION: 18
  },
  TEACHER: {
    ID: 1, NAME: 2, ACTIVE: 3, DEFAULT_RATE: 4, SALARY_TARGET: 5,
    START_DATE: 6, END_DATE: 7, MEMO: 8, CREATED_AT: 9, UPDATED_AT: 10, UPDATED_BY: 11
  },
  USER: {
    ID: 1, EMAIL: 2, NAME: 3, ROLE: 4, ACTIVE: 5, PERMISSIONS: 6,
    CREATED_AT: 7, UPDATED_AT: 8, UPDATED_BY: 9, TEACHER_ID: 10, STUDENT_SCOPE: 11
  },
  SETTING: {
    KEY: 1, CATEGORY: 2, LABEL: 3, VALUE: 4, TYPE: 5, MIN: 6, MAX: 7, DESCRIPTION: 8
  },
  SALARY_SETTLEMENT: {
    ID: 1, YM: 2, TEACHER_ID: 3, TEACHER_NAME: 4, STATUS: 5,
    BASE_AMOUNT: 6, ADJUSTMENT_AMOUNT: 7, FINAL_AMOUNT: 8, PAID_AMOUNT: 9,
    BALANCE_AMOUNT: 10, SOURCE_TYPE: 11, MEMO: 12, CREATED_AT: 13,
    UPDATED_AT: 14, CONFIRMED_AT: 15, CONFIRMED_BY: 16
  },
  SALARY_ENTRY: {
    ID: 1, SETTLEMENT_ID: 2, TYPE: 3, AMOUNT: 4, ENTRY_DATE: 5,
    MEMO: 6, CREATED_AT: 7, CREATED_BY: 8, STATUS: 9, REF_ID: 10, DETAILS: 11
  }
};

var STUDENT_COURSE_MODES = {
  REGULAR: "정규",
  SPECIAL_ONLY: "특강전용"
};

function normalizeStudentCourseMode_(value) {
  var text = String(value == null ? "" : value).trim();
  if (!text || text === "REGULAR" || text === "정규수강") return STUDENT_COURSE_MODES.REGULAR;
  if (text === "SPECIAL_ONLY" || text === "특강" || text === "특강생") return STUDENT_COURSE_MODES.SPECIAL_ONLY;
  if ([STUDENT_COURSE_MODES.REGULAR, STUDENT_COURSE_MODES.SPECIAL_ONLY].indexOf(text) === -1) {
    throw new Error("수강 형태가 올바르지 않습니다.");
  }
  return text;
}

function isSpecialOnlyCourseMode_(value) {
  return normalizeStudentCourseMode_(value) === STUDENT_COURSE_MODES.SPECIAL_ONLY;
}

var IDX = (function() {
  function toIdxMap(colMap) {
    var result = {};
    Object.keys(colMap).forEach(function(key) {
      result[key] = colMap[key] - 1;
    });
    return result;
  }

  return {
    STUDENT: toIdxMap(COL.STUDENT),
    PAYMENT: toIdxMap(COL.PAYMENT),
    REQUEST: toIdxMap(COL.REQUEST),
    LOG: toIdxMap(COL.LOG),
    VACATION: toIdxMap(COL.VACATION),
    EVENT: toIdxMap(COL.EVENT),
    TEACHER: toIdxMap(COL.TEACHER),
    USER: toIdxMap(COL.USER),
    SETTING: toIdxMap(COL.SETTING),
    SALARY_SETTLEMENT: toIdxMap(COL.SALARY_SETTLEMENT),
    SALARY_ENTRY: toIdxMap(COL.SALARY_ENTRY)
  };
})();

var CACHE_TTL_SECONDS = 600;

/** 신규 입력에 사용하는 공통 결제 방식과 기존 데이터 호환 별칭입니다. */
var PAYMENT_METHODS = ["모락", "카드", "동백전QR", "현금영수증", "계좌이체"];
var PAYMENT_METHOD_ALIASES = {
  "동백전": "동백전QR",
  "계좌": "계좌이체"
};

function normalizePaymentMethod_(value) {
  var method = String(value == null ? "" : value).trim();
  return PAYMENT_METHOD_ALIASES[method] || method;
}

function requirePaymentMethod_(value) {
  var method = normalizePaymentMethod_(requireText_(value, "납부 방식", 30));
  if (PAYMENT_METHODS.indexOf(method) === -1) throw new Error("허용되지 않은 납부 방식입니다: " + method);
  return method;
}

function getPaymentMethodOptionsHtml_() {
  return PAYMENT_METHODS.map(function(method) {
    return '<option value="' + method + '">' + method + '</option>';
  }).join("");
}

var ACCESS_BOOTSTRAP_ADMINS_PROPERTY = "ACCESS_BOOTSTRAP_ADMINS_JSON";
var AccessControl_bootstrapAdminConfigCache_ = null;

var ACCESS_CONTROL = {
  GOOGLE_WEB_CLIENT_ID: "278604638840-02mgbg349k5t4v2gk36qkamiqa58oobt.apps.googleusercontent.com",
  // 필요 시 코드에서 B통로를 강제할 계정 목록입니다.
  MANAGER_EMAILS: [],
  ROLES: { SUPER_ADMIN: "SUPER_ADMIN", MANAGER: "MANAGER" }
};

function AccessControl_getBootstrapAdminConfig_() {
  if (AccessControl_bootstrapAdminConfigCache_) return AccessControl_bootstrapAdminConfigCache_;

  var raw = String(PropertiesService.getScriptProperties()
    .getProperty(ACCESS_BOOTSTRAP_ADMINS_PROPERTY) || "").trim();
  if (!raw) {
    throw new Error("최고관리자 비상 계정 설정이 없습니다. Script Properties의 " +
      ACCESS_BOOTSTRAP_ADMINS_PROPERTY + " 값을 확인해주세요.");
  }

  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("최고관리자 비상 계정 설정 형식이 올바르지 않습니다.");
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error("최고관리자 비상 계정을 한 명 이상 등록해주세요.");
  }

  var emails = [];
  var displayNames = {};
  parsed.forEach(function(item) {
    var email = String(item && item.email || "").trim().toLowerCase();
    var displayName = String(item && item.displayName || "").trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("최고관리자 비상 계정 이메일 형식이 올바르지 않습니다.");
    }
    if (emails.indexOf(email) !== -1) return;
    emails.push(email);
    displayNames[email] = displayName || email.split("@")[0];
  });

  AccessControl_bootstrapAdminConfigCache_ = {
    emails: emails,
    displayNames: displayNames
  };
  return AccessControl_bootstrapAdminConfigCache_;
}

Object.defineProperty(ACCESS_CONTROL, "ADMIN_EMAILS", {
  enumerable: true,
  get: function() { return AccessControl_getBootstrapAdminConfig_().emails; }
});
Object.defineProperty(ACCESS_CONTROL, "ADMIN_DISPLAY_NAMES", {
  enumerable: true,
  get: function() { return AccessControl_getBootstrapAdminConfig_().displayNames; }
});

/** 하위관리자의 학생 데이터 범위는 원장 연결 유무와 별도로 명시합니다. */
var STUDENT_ACCESS_SCOPES = {
  NONE: "NONE",
  LINKED_TEACHER: "LINKED_TEACHER",
  ALL_STUDENTS: "ALL_STUDENTS"
};

/** URL·권한·좌측 메뉴가 함께 참조하는 단일 화면 경로표입니다. */
var APP_ROUTE_REGISTRY = [
  { key:"STUDENT_ADD", page:"StudentAddUI", group:"학생 관리", label:"학생 등록", icon:"➕", manager:true, nav:true },
  { key:"STUDENT_EDIT", page:"StudentEdit", group:"학생 관리", label:"학생 정보 수정·퇴원", icon:"✏️", manager:true, nav:true },
  { key:"STUDENT_VACATION", page:"StudentVacation", group:"학생 관리", label:"학생 휴가", icon:"🏖️", manager:true, nav:true },
  { key:"SIBLING_MANAGER", page:"SiblingManager", group:"학생 관리", label:"형제·자매 관리", icon:"👨‍👩‍👦", manager:true, nav:true },
  { key:"PAYMENT_DASHBOARD", page:"DashboardUI", aliases:["ManagerDashboard"], group:"수납 관리", label:"수납 대시보드", icon:"📊", manager:true, nav:true },
  { page:"PaymentEdit", group:"수납 관리", label:"수납 내역 수정", icon:"🛠️", superOnly:true, nav:true },
  { page:"PaymentChecklist", group:"수납 관리", label:"납부 체크리스트", icon:"🖨️", superOnly:true, nav:true },
  { page:"CashReceipt", group:"수납 관리", label:"현금영수증 명부", icon:"🧾", superOnly:true, nav:true },
  { page:"StatisticsDashboard", group:"수납 관리", label:"기간별 통계", icon:"📈", superOnly:true, nav:true },
  { page:"SalaryDashboard", group:"관리", label:"급여 관리", icon:"💰", superOnly:true, nav:true },
  { page:"TeacherManagement", group:"관리", label:"원장 관리", icon:"👩‍🏫", superOnly:true, nav:true },
  { page:"SettingsDashboard", group:"관리", label:"설정 및 사용자 권한", icon:"⚙️", superOnly:true, nav:true },
  { page:"ChangeLogViewer", group:"관리", label:"변경 이력", icon:"🕘", superOnly:true, nav:true },
  { page:"TrashManager", group:"관리", label:"휴지통", icon:"🗑️", superOnly:true, nav:true },
  { page:"MyRequestStatus", group:"요청", label:"요청 처리 현황", icon:"⏳", managerOpen:true, managerOnly:true, nav:true },
  { page:"Manual", aliases:["HelpGuide"], group:"도움말", label:"사용 설명서", icon:"📘", managerOpen:true, nav:true },
  { page:"ChangeRequestDashboard", renderPage:"DashboardUI", label:"이전 통합 요청 주소", superOnly:true, nav:false }
];

var MANAGER_ROUTE_PERMISSIONS = APP_ROUTE_REGISTRY.filter(function(route) { return !!route.manager; });

function AppRoute_find_(page) {
  page = String(page || "");
  for (var i = 0; i < APP_ROUTE_REGISTRY.length; i++) {
    var route = APP_ROUTE_REGISTRY[i];
    if (route.page === page || (route.aliases || []).indexOf(page) !== -1) return route;
  }
  return null;
}

function AppRoute_renderPage_(page) {
  var route = AppRoute_find_(page);
  return route ? String(route.renderPage || route.page) : "";
}

function AccessControl_managerPermissionKeys_() {
  return MANAGER_ROUTE_PERMISSIONS.map(function(item) { return item.key; });
}

function AccessControl_normalizePermissions_(value) {
  var text = String(value || "").trim();
  if (text === "*" || text === "OPERATIONS") return AccessControl_managerPermissionKeys_();
  var allowed = {}; AccessControl_managerPermissionKeys_().forEach(function(key) { allowed[key] = true; });
  var seen = {};
  return text.split(",").map(function(key) { return String(key || "").trim().toUpperCase(); })
    .filter(function(key) { if (!allowed[key] || seen[key]) return false; seen[key] = true; return true; });
}

function AccessControl_serializePermissions_(values) {
  var requested = {}; (values || []).forEach(function(key) { requested[String(key || "").trim().toUpperCase()] = true; });
  return AccessControl_managerPermissionKeys_().filter(function(key) { return requested[key]; }).join(",");
}

/**
 * 기존 데이터 호환 규칙:
 * - 범위 값이 비어 있고 연결 원장이 있으면 기존 의도를 LINKED_TEACHER로 보존합니다.
 * - 범위 값과 연결 원장이 모두 없으면 안전하게 NONE으로 판정합니다.
 * - 잘못된 저장값은 권한을 넓히지 않고 NONE으로 축소합니다.
 */
function AccessControl_normalizeStudentScope_(value, teacherId, role) {
  if (String(role || "").trim() === ACCESS_CONTROL.ROLES.SUPER_ADMIN) return STUDENT_ACCESS_SCOPES.ALL_STUDENTS;
  var scope = String(value || "").trim().toUpperCase();
  var linkedTeacherId = String(teacherId || "").trim();
  // 원장이 연결된 하위관리자는 과거 저장값이 전체 학생이어도 연결 원장 학생으로 제한합니다.
  if (linkedTeacherId) return STUDENT_ACCESS_SCOPES.LINKED_TEACHER;
  if (!scope) return linkedTeacherId ? STUDENT_ACCESS_SCOPES.LINKED_TEACHER : STUDENT_ACCESS_SCOPES.NONE;
  if ([STUDENT_ACCESS_SCOPES.NONE, STUDENT_ACCESS_SCOPES.LINKED_TEACHER, STUDENT_ACCESS_SCOPES.ALL_STUDENTS].indexOf(scope) === -1) {
    return STUDENT_ACCESS_SCOPES.NONE;
  }
  if (scope === STUDENT_ACCESS_SCOPES.LINKED_TEACHER && !linkedTeacherId) return STUDENT_ACCESS_SCOPES.NONE;
  return scope;
}

function AccessControl_requireValidStudentScope_(value, teacherId, role) {
  if (String(role || "").trim() === ACCESS_CONTROL.ROLES.SUPER_ADMIN) return STUDENT_ACCESS_SCOPES.ALL_STUDENTS;
  var scope = String(value || "").trim().toUpperCase();
  if ([STUDENT_ACCESS_SCOPES.NONE, STUDENT_ACCESS_SCOPES.LINKED_TEACHER, STUDENT_ACCESS_SCOPES.ALL_STUDENTS].indexOf(scope) === -1) {
    throw new Error("이 사용자가 볼 수 있는 학생을 선택해주세요.");
  }
  if (scope === STUDENT_ACCESS_SCOPES.LINKED_TEACHER && !String(teacherId || "").trim()) {
    throw new Error("선택한 원장의 학생만 보려면 먼저 원장을 선택해주세요.");
  }
  return scope;
}

/** 사용자 설정에서 원장 연결 방식과 학생 범위가 서로 모순되지 않게 최종값을 결정합니다. */
function AccessControl_resolveManagedStudentScope_(identityMode, value, teacherId, role) {
  if (String(role || "").trim() === ACCESS_CONTROL.ROLES.SUPER_ADMIN) return STUDENT_ACCESS_SCOPES.ALL_STUDENTS;
  var mode = String(identityMode || "").trim().toUpperCase();
  if (mode === "TEACHER") {
    if (!String(teacherId || "").trim()) throw new Error("이 사용자의 원장을 선택해주세요.");
    return STUDENT_ACCESS_SCOPES.LINKED_TEACHER;
  }
  if (mode !== "CUSTOM") throw new Error("표시명 입력 방식을 확인할 수 없습니다.");
  var scope = AccessControl_requireValidStudentScope_(value, "", role);
  if (scope === STUDENT_ACCESS_SCOPES.LINKED_TEACHER) {
    throw new Error("원장과 연결하지 않은 사용자는 ‘학생을 보지 않음’ 또는 ‘모든 학생’만 선택할 수 있습니다.");
  }
  return scope;
}

function AccessControl_getStudentScope_(user) {
  if (!user) return STUDENT_ACCESS_SCOPES.NONE;
  if (user.bootstrap || user.role === ACCESS_CONTROL.ROLES.SUPER_ADMIN) return STUDENT_ACCESS_SCOPES.ALL_STUDENTS;
  return AccessControl_normalizeStudentScope_(user.studentScope, user.teacherId, user.role);
}

function AccessControl_hasStudentDataAccess_(user) {
  var scope = AccessControl_getStudentScope_(user);
  return scope === STUDENT_ACCESS_SCOPES.ALL_STUDENTS ||
    (scope === STUDENT_ACCESS_SCOPES.LINKED_TEACHER && !!String(user && user.teacherId || "").trim());
}

function AccessControl_requireStudentDataAccess_(user) {
  user = user || requireAuthorizedUser_();
  if (!AccessControl_hasStudentDataAccess_(user)) {
    throw new Error("이 계정에서 볼 수 있는 학생이 정해지지 않았습니다. 최고 원장에게 사용자 설정을 확인해달라고 요청해주세요.");
  }
  return user;
}

function AccessControl_filterStudentList_(list, user) {
  var source = Array.isArray(list) ? list : [];
  var scope = AccessControl_getStudentScope_(user);
  if (scope === STUDENT_ACCESS_SCOPES.ALL_STUDENTS) return source.slice();
  if (scope !== STUDENT_ACCESS_SCOPES.LINKED_TEACHER) return [];
  var teacherId = String(user && user.teacherId || "").trim();
  return source.filter(function(student) { return String(student && student.teacherId || "").trim() === teacherId; });
}

function AccessControl_hasPermission_(user, permissionKey) {
  if (!user) return false;
  if (user.bootstrap || user.role === ACCESS_CONTROL.ROLES.SUPER_ADMIN) return true;
  // 역할 값이 비어 있거나 손상된 계정이 메뉴 권한 문자열만으로 RPC를 우회하지 못하게 합니다.
  if (user.role !== ACCESS_CONTROL.ROLES.MANAGER) return false;
  // 메뉴 권한과 학생 데이터 범위는 서로 독립입니다. 범위가 NONE이면 화면은 열되
  // 조회 결과를 빈 목록으로 만들고, 실제 변경 요청은 쓰기 경계에서 거부합니다.
  return AccessControl_normalizePermissions_(user.permissions).indexOf(String(permissionKey || "")) !== -1;
}

function AccessControl_requireValidRole_(value) {
  var role = String(value || "").trim();
  if ([ACCESS_CONTROL.ROLES.SUPER_ADMIN, ACCESS_CONTROL.ROLES.MANAGER].indexOf(role) === -1) {
    throw new Error("등록된 사용자 역할이 올바르지 않아 접근을 차단했습니다.");
  }
  return role;
}

function AccessControl_permissionForPage_(page) {
  var route = AppRoute_find_(page);
  return route && route.manager ? String(route.key || "") : "";
}

function AccessControl_canAccessPage_(user, page) {
  var route = AppRoute_find_(page);
  if (!route || !user) return false;
  if (user.bootstrap || user.role === ACCESS_CONTROL.ROLES.SUPER_ADMIN) return true;
  if (user.role !== ACCESS_CONTROL.ROLES.MANAGER || route.superOnly) return false;
  if (route.managerOpen) return true;
  var permission = route.manager ? String(route.key || "") : "";
  return !!permission && AccessControl_hasPermission_(user, permission);
}

function requireManagerPermission_(permissionKey) {
  var user = requireAuthorizedUser_();
  if (!AccessControl_hasPermission_(user, permissionKey)) throw new Error("이 계정에는 해당 메뉴가 열려 있지 않습니다. 최고 원장에게 확인해주세요.");
  return user;
}

// 동일 실행에서 스프레드시트 메뉴 경계를 통과한 사용자 이메일만 내부 호출에 전달합니다.
// 웹 RPC는 실행마다 새 컨텍스트에서 시작하며 이 값이 없으므로 활성 계정으로 대체되지 않습니다.
var AccessControl_spreadsheetExecutionEmail_ = "";

function AccessControl_isSpreadsheetUiContext_() {
  try {
    return !!SpreadsheetApp.getActiveSpreadsheet() && !!SpreadsheetApp.getUi();
  } catch (ignoredSpreadsheetUiError) {
    return false;
  }
}

function AccessControl_assertSpreadsheetUiContext_() {
  if (!AccessControl_isSpreadsheetUiContext_()) {
    throw new Error("이 작업은 연결된 스프레드시트 메뉴에서만 실행할 수 있습니다.");
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

function requireSpreadsheetAuthorizedUser_() {
  AccessControl_assertSpreadsheetUiContext_();
  var user = requireAuthorizedUser_({ allowActiveUser:true });
  AccessControl_spreadsheetExecutionEmail_ = user.email;
  return user;
}

function requireSpreadsheetSuperAdmin_() {
  var user = requireSpreadsheetAuthorizedUser_();
  if (!user.bootstrap && user.role !== ACCESS_CONTROL.ROLES.SUPER_ADMIN) {
    throw new Error("이 작업을 수행할 권한이 없습니다. 최고 원장에게 계정 역할을 확인해달라고 요청해주세요.");
  }
  return user;
}

function requireSpreadsheetManagerPermission_(permissionKey) {
  var user = requireSpreadsheetAuthorizedUser_();
  if (!AccessControl_hasPermission_(user, permissionKey)) throw new Error("이 계정에는 해당 메뉴가 열려 있지 않습니다. 최고 원장에게 확인해주세요.");
  return user;
}

function requireAnyManagerPermission_(permissionKeys) {
  var user = requireAuthorizedUser_();
  for (var i = 0; i < (permissionKeys || []).length; i++) {
    if (AccessControl_hasPermission_(user, permissionKeys[i])) return user;
  }
  throw new Error("이 계정에는 해당 메뉴가 열려 있지 않습니다. 최고 원장에게 확인해주세요.");
}

function AccessControl_chooseSessionIdentity_(activeEmail, authenticated) {
  var verifiedEmail = String(authenticated && authenticated.email || "").trim().toLowerCase();
  if (verifiedEmail) return { email:verifiedEmail, source:"VERIFIED_GOOGLE_SESSION" };
  var active = String(activeEmail || "").trim().toLowerCase();
  if (active) return { email:active, source:"ACTIVE_USER" };
  return { email:"", source:"VERIFIED_SESSION_REQUIRED" };
}

function AccessControl_getSessionIdentity_() {
  var active = String(Session.getActiveUser().getEmail() || "").trim().toLowerCase();
  var authenticated = typeof AccessSession_getCurrent_ === "function" ? AccessSession_getCurrent_() : null;
  // 웹 앱에서 사용자가 명시적으로 고른 OAuth 계정을 우선합니다. 저장된 앱 세션이 없을 때만
  // Apps Script가 제공하는 활성 계정을 사용하므로 스프레드시트 메뉴 호환성은 유지됩니다.
  return AccessControl_chooseSessionIdentity_(active, authenticated);
}

/** 공개 웹앱 화면은 Apps Script 계정이 아니라 앱에서 직접 검증한 Google 세션만 신뢰합니다. */
function AccessControl_getVerifiedSessionIdentity_() {
  var authenticated = typeof AccessSession_getCurrent_ === "function" ? AccessSession_getCurrent_() : null;
  return AccessControl_chooseSessionIdentity_("", authenticated);
}

function getCurrentUserEmail_() {
  return AccessControl_getSessionIdentity_().email;
}

/** 웹 앱은 배포자 권한으로 실행되며, 실제 접속자는 검증된 Google 세션으로 판정합니다. */
function getCurrentInteractiveUserEmail_() {
  return AccessControl_getVerifiedSessionIdentity_().email;
}

/** 직접 실행·시간 트리거 전용. 사용자 화면의 인증에는 사용하지 않습니다. */
function getAutomationUserEmail_() {
  var effective = String(Session.getEffectiveUser().getEmail() || "").trim().toLowerCase();
  return ACCESS_CONTROL.ADMIN_EMAILS.indexOf(effective) !== -1 ? effective : "";
}

/** DB_사용자의 표시명을 우선 사용하고, 복구 계정 기본명은 값이 없을 때만 사용합니다. */
function AccessControl_getDisplayName_(email) {
  email = String(email || "").trim().toLowerCase();
  if (!email) return "";
  try {
    var rows = DataRepository_getRows_(SHEET_NAMES.USERS, { required:false });
    for (var i = 1; i < rows.length; i++) {
        if (String(rows[i][IDX.USER.EMAIL] || "").trim().toLowerCase() !== email) continue;
        var storedName = String(rows[i][IDX.USER.NAME] || "").trim();
        if (storedName) return storedName;
        break;
    }
  } catch (displayNameError) {
    logError_("사용자 표시명 조회", displayNameError);
  }
  return ACCESS_CONTROL.ADMIN_DISPLAY_NAMES[email] || email;
}

function AccessControl_getLinkedTeacherId_(email) {
  email = String(email || "").trim().toLowerCase();
  if (!email) return "";
  try {
    var rows = DataRepository_getRows_(SHEET_NAMES.USERS, { required:false });
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][IDX.USER.EMAIL] || "").trim().toLowerCase() === email) {
        return String(rows[i][IDX.USER.TEACHER_ID] || "").trim();
      }
    }
  } catch (linkedTeacherError) {
    logError_("사용자 연결 원장 조회", linkedTeacherError);
  }
  return "";
}

function AccessControl_selectAccountFromRows_(email, rows) {
  var matches = [];
  for (var i = 1; i < (rows || []).length; i++) {
    if (String(rows[i][IDX.USER.EMAIL] || "").trim().toLowerCase() === email) matches.push(rows[i]);
  }
  if (matches.length > 1) throw new Error("동일 이메일의 사용자 계정이 중복 등록되어 접근을 차단했습니다. 최고 원장에게 사용자 설정을 정리해달라고 요청해주세요.");
  if (matches.length !== 1 || !Management_toBoolean_(matches[0][IDX.USER.ACTIVE])) return { account:null };
  var account = matches[0].slice();
  if (ACCESS_CONTROL.MANAGER_EMAILS.indexOf(email) !== -1) {
    account[IDX.USER.ROLE] = ACCESS_CONTROL.ROLES.MANAGER;
    account[IDX.USER.PERMISSIONS] = "OPERATIONS";
  }
  return { account:account };
}

/** 인증 판정은 사용자 시트 누락·헤더 손상을 미등록 계정으로 오인하지 않습니다. */
function AccessControl_validateAuthorizationUserRows_(rows) {
  var expected = DataSchema_getDefinitions_()[SHEET_NAMES.USERS] || [];
  var headers = Array.isArray(rows) && rows.length && Array.isArray(rows[0]) ? rows[0] : [];
  var mismatches = [];
  expected.forEach(function(header, index) {
    if (header == null) return;
    var actual = String(headers[index] == null ? "" : headers[index]).trim();
    if (actual !== header && !DataSchema_isCompatibleHeader_(SHEET_NAMES.USERS, index + 1, actual)) {
      mismatches.push({ column:index + 1, expected:header, actual:actual });
    }
  });
  if (mismatches.length) {
    throw new Error("사용자 권한 DB 구조가 올바르지 않아 접근을 차단했습니다. DB_사용자 스키마를 점검해주세요.");
  }
  return rows;
}

function AccessControl_loadAuthorizationUserRows_() {
  return AccessControl_validateAuthorizationUserRows_(
    DataRepository_getRows_(SHEET_NAMES.USERS, { required:true, fresh:true, cache:false })
  );
}

/** 권한을 부여하지 않고 로그인/화이트리스트 실패 지점만 식별합니다. */
function AccessControl_diagnoseInteractiveAccess_() {
  var identity = AccessControl_getVerifiedSessionIdentity_();
  var activeEmail = identity.email;
  var effectiveEmail = String(Session.getEffectiveUser().getEmail() || "").trim().toLowerCase();
  var result = {
    code: "UNKNOWN",
    activeEmail: activeEmail,
    identitySource: identity.source,
    effectiveEmail: effectiveEmail,
    activeMatchesEffective: !!activeEmail && activeEmail === effectiveEmail
  };
  if (!activeEmail) {
    if (identity.source === "VERIFIED_SESSION_REQUIRED") {
      result.code = "GOOGLE_SESSION_REQUIRED";
    } else if (effectiveEmail && ACCESS_CONTROL.ADMIN_EMAILS.indexOf(effectiveEmail) !== -1) {
      result.code = "DEPLOYMENT_RUNNING_AS_ADMIN";
    } else if (effectiveEmail) {
      result.code = "EFFECTIVE_USER_NOT_WHITELISTED";
      result.effectiveDomain = effectiveEmail.indexOf("@") > -1 ? effectiveEmail.split("@").pop() : "";
    } else {
      result.code = "LOGIN_EMAIL_NOT_EXPOSED";
    }
    return result;
  }
  if (ACCESS_CONTROL.ADMIN_EMAILS.indexOf(activeEmail) !== -1) {
    result.code = "AUTHORIZED_A";
    return result;
  }
  try {
    var rows = AccessControl_loadAuthorizationUserRows_();
    var matches = [];
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][IDX.USER.EMAIL] || "").trim().toLowerCase() === activeEmail) matches.push(rows[i]);
    }
    result.matchCount = matches.length;
    if (!matches.length) result.code = "NOT_IN_WHITELIST";
    else if (matches.length > 1) result.code = "DUPLICATE_EMAIL";
    else if (!Management_toBoolean_(matches[0][IDX.USER.ACTIVE])) result.code = "ACCOUNT_INACTIVE";
    else {
      var selected = AccessControl_selectAccountFromRows_(activeEmail, rows).account;
      result.role = selected ? String(selected[IDX.USER.ROLE] || "") : "";
      result.code = result.role === ACCESS_CONTROL.ROLES.SUPER_ADMIN ? "AUTHORIZED_A" :
        (result.role === ACCESS_CONTROL.ROLES.MANAGER ? "AUTHORIZED_B" : "INVALID_ROLE");
    }
  } catch (error) {
    result.code = "USER_TABLE_READ_FAILED";
    result.detail = error && error.message ? String(error.message) : String(error);
  }
  return result;
}

function AccessControl_formatDiagnosticMessage_(diagnostic) {
  diagnostic = diagnostic || {};
  var labels = {
    LOGIN_EMAIL_NOT_EXPOSED: "Google 로그인 이메일을 웹앱이 받지 못했습니다.",
    GOOGLE_SESSION_REQUIRED: "검증된 Google 로그인 세션이 필요합니다.",
    DEPLOYMENT_RUNNING_AS_ADMIN: "웹앱이 접속자가 아니라 배포자 최고 원장 계정으로 실행되고 있습니다.",
    EFFECTIVE_USER_NOT_WHITELISTED: "웹앱이 감지한 Google 계정이 등록된 관리자 계정과 다릅니다.",
    NOT_IN_WHITELIST: "현재 로그인 이메일이 DB_사용자에 없습니다.",
    DUPLICATE_EMAIL: "DB_사용자에 같은 이메일이 두 번 이상 있습니다.",
    ACCOUNT_INACTIVE: "DB_사용자에서 이 계정이 비활성 상태입니다.",
    INVALID_ROLE: "DB_사용자의 역할 값이 올바르지 않습니다.",
    USER_TABLE_READ_FAILED: "DB_사용자 시트를 읽는 중 오류가 발생했습니다."
  };
  var message = labels[diagnostic.code] || "접근 판정에 실패했습니다.";
  message += "<br>진단 코드: " + String(diagnostic.code || "UNKNOWN");
  message += "<br>감지된 로그인: " + (diagnostic.activeEmail || "(감지 안 됨)");
  message += "<br>감지 방식: " + String(diagnostic.identitySource || "UNKNOWN");
  if (diagnostic.code === "DEPLOYMENT_RUNNING_AS_ADMIN") {
    message += "<br>조치: 웹앱 배포 설정을 '웹 앱에 액세스하는 사용자'로 변경한 새 배포가 필요합니다.";
  }
  if (diagnostic.effectiveDomain) message += "<br>감지 계정 도메인: " + String(diagnostic.effectiveDomain).replace(/[<>&]/g, "");
  if (diagnostic.detail) message += "<br>세부 원인: " + String(diagnostic.detail).replace(/[<>&]/g, "");
  return message;
}

function requireAuthorizedUser_(options) {
  options = options || {};
  var email = getCurrentInteractiveUserEmail_();
  var spreadsheetExecutionEmail = String(AccessControl_spreadsheetExecutionEmail_ || "").trim().toLowerCase();
  if (!email && spreadsheetExecutionEmail) email = spreadsheetExecutionEmail;
  var allowActiveUser = options.interactiveOnly !== true && options.allowActiveUser === true;
  if (!email && allowActiveUser) email = getCurrentUserEmail_();
  if (!email) throw new Error("접근 권한이 없습니다. 승인된 Google 계정으로 로그인해주세요.");
  var bootstrap = ACCESS_CONTROL.ADMIN_EMAILS.indexOf(email) !== -1;
  if (bootstrap) {
    // 복구 최고관리자는 권한표와 무관하게 통과시키되, 표시명과 연결 원장은 같은
    // 사용자 원본을 한 번만 읽어 구합니다. 기존에는 두 도우미가 각각 시트를 읽었습니다.
    var bootstrapName = ACCESS_CONTROL.ADMIN_DISPLAY_NAMES[email] || email;
    var bootstrapTeacherId = "";
    try {
      var bootstrapRows = DataRepository_getRows_(SHEET_NAMES.USERS, { required:false });
      for (var bi = 1; bi < bootstrapRows.length; bi++) {
        if (String(bootstrapRows[bi][IDX.USER.EMAIL] || "").trim().toLowerCase() !== email) continue;
        bootstrapName = String(bootstrapRows[bi][IDX.USER.NAME] || "").trim() || bootstrapName;
        bootstrapTeacherId = String(bootstrapRows[bi][IDX.USER.TEACHER_ID] || "").trim();
        break;
      }
    } catch (bootstrapProfileError) {
      logError_("복구 최고 원장 프로필 조회", bootstrapProfileError);
    }
    return {
      email: email,
      name: bootstrapName,
      role: ACCESS_CONTROL.ROLES.SUPER_ADMIN,
      permissions: "*",
      teacherId: bootstrapTeacherId,
      studentScope: STUDENT_ACCESS_SCOPES.ALL_STUDENTS,
      bootstrap: true
    };
  }
  var account = null;
  try {
    // 권한표는 일반 조회 캐시보다 보안이 우선입니다. 비활성화·역할·메뉴 변경을 다음 호출부터 즉시 반영합니다.
    var rows = AccessControl_loadAuthorizationUserRows_();
    var selected = AccessControl_selectAccountFromRows_(email, rows);
    account = selected.account;
  } catch (authReadError) {
    logError_("사용자 권한표 조회", authReadError);
    throw authReadError;
  }
  if (!account) {
    throw new Error("접근 권한이 없습니다. 승인된 Google 계정으로 로그인해주세요.");
  }
  var accountRole = AccessControl_requireValidRole_(account[IDX.USER.ROLE]);
  return {
    email: email,
    name: String(account[IDX.USER.NAME] || "").trim() || email,
    role: accountRole,
    permissions: String(account[IDX.USER.PERMISSIONS] || ""),
    teacherId: String(account[IDX.USER.TEACHER_ID] || "").trim(),
    studentScope: AccessControl_normalizeStudentScope_(account[IDX.USER.STUDENT_SCOPE], account[IDX.USER.TEACHER_ID], accountRole),
    bootstrap: false
  };
}

function requireRole_(allowedRoles) {
  var user = requireAuthorizedUser_();
  if (user.bootstrap) return user;
  if ((allowedRoles || []).indexOf(user.role) === -1) throw new Error("이 작업을 수행할 권한이 없습니다. 최고 원장에게 계정 역할을 확인해달라고 요청해주세요.");
  return user;
}

function requireSuperAdmin_() {
  return requireRole_([ACCESS_CONTROL.ROLES.SUPER_ADMIN]);
}

function requireAutomationSuperAdmin_() {
  var email = getAutomationUserEmail_();
  var interactiveEmail = getCurrentInteractiveUserEmail_();
  if (!email || (interactiveEmail && ACCESS_CONTROL.ADMIN_EMAILS.indexOf(interactiveEmail) === -1)) {
    throw new Error("자동 실행 계정이 복구 최고 원장과 일치하지 않습니다.");
  }
  return { email:email, name:ACCESS_CONTROL.ADMIN_DISPLAY_NAMES[email] || email, role:ACCESS_CONTROL.ROLES.SUPER_ADMIN, permissions:"*", teacherId:"", studentScope:STUDENT_ACCESS_SCOPES.ALL_STUDENTS, bootstrap:true, automation:true };
}

function requireInteractiveAuthorizedUser_() {
  return requireAuthorizedUser_({ interactiveOnly: true });
}

/** 화이트리스트 조회 결과를 단 하나의 A/B 통로로 변환합니다. */
function AccessControl_getPortalRoute_(user) {
  if (!user) throw new Error("로그인 사용자 정보를 확인할 수 없습니다. 승인된 Google 계정으로 다시 접속해주세요.");
  if (user.bootstrap || user.role === ACCESS_CONTROL.ROLES.SUPER_ADMIN) return "A_SUPER_ADMIN";
  if (user.role === ACCESS_CONTROL.ROLES.MANAGER) return "B_MANAGER";
  throw new Error("등록된 사용자 역할이 올바르지 않아 접근을 차단했습니다.");
}

function logError_(context, error) {
  console.error("[" + context + "] " + (error && error.stack ? error.stack : error));
}

/** 화면 실패를 실행 로그와 연결하고 사용자에게 전달할 짧은 진단 ID를 반환합니다. */
function reportClientFailure(context, message) {
  var user = requireAuthorizedUser_();
  var diagnosticId = createUniqueId_("UIERR");
  console.error("[화면 요청 실패] " + JSON.stringify({
    diagnosticId: diagnosticId,
    occurredAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss"),
    userEmail: user.email,
    context: String(context || "화면 요청").substring(0, 100),
    message: String(message || "알 수 없는 오류").substring(0, 1000)
  }));
  return diagnosticId;
}

function parseDateOnly_(value) {
  return DateMoney_parseDateOnly(value);
}

function formatDateOnly_(date) {
  return DateMoney_formatDateOnly(date);
}

function getAsOfDateForMonth_(targetYm) {
  var match = String(targetYm || "").match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (!match) throw new Error("조회 월 형식이 올바르지 않습니다.");
  var year = Number(match[1]);
  var monthIndex = Number(match[2]) - 1;
  var now = new Date();
  var result = (now.getFullYear() === year && now.getMonth() === monthIndex)
    ? now
    : new Date(year, monthIndex + 1, 0);
  result.setHours(23, 59, 59, 999);
  return result;
}

function buildStudentChangeHistory_(logData) {
  return StudentTimeline_buildHistories(logData);
}

function getLatestPlannedStudentState_(studentRow, histories, options) {
  return resolveStudentStateAtDate_(studentRow, histories, new Date(9999, 11, 31, 23, 59, 59, 999), options);
}

function getRequestCacheKey_(requestId) {
  return "REQUEST_" + Utilities.base64EncodeWebSafe(String(requestId)).substring(0, 80);
}

function getCompletedRequest_(requestId) {
  if (!requestId) return null;
  var cached = CacheService.getScriptCache().get(getRequestCacheKey_(requestId));
  if (!cached) return null;
  try { return JSON.parse(cached); } catch (e) { return null; }
}

function markRequestCompleted_(requestId, result) {
  if (!requestId) return false;
  try {
    CacheService.getScriptCache().put(getRequestCacheKey_(requestId), JSON.stringify(result), 21600);
    return true;
  } catch (error) {
    // 원본 트랜잭션과 영구 이벤트/행이 이미 커밋된 뒤의 보조 캐시 실패는
    // 전체 저장 실패로 보고하지 않습니다. 재시도는 영구 기록 대조가 막습니다.
    logError_("요청 완료 보조 캐시 저장 " + requestId, error);
    return false;
  }
}

function resolveStudentStateAtDate_(studentRow, histories, asOfDate, options) {
  return StudentTimeline_resolveState(studentRow, histories, asOfDate, options);
}

function withDocumentLock_(callback) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function clearDashboardCaches_() {
  [SHEET_NAMES.STUDENTS, SHEET_NAMES.PAYMENTS, SHEET_NAMES.VACATIONS, SHEET_NAMES.LOGS, SHEET_NAMES.EVENTS].forEach(function(sheetName) {
    DataRepository_clearCache_(sheetName);
  });
  MonthlyCache_markAllDirty_();
}

/** 서버 저장 함수에서 공통으로 사용하는 입력 검증/정규화 도구 */
function requireText_(value, label, maxLength) {
  var text = String(value == null ? "" : value).trim();
  if (!text) throw new Error(label + "을(를) 입력해주세요.");
  if (maxLength && text.length > maxLength) throw new Error(label + "은(는) " + maxLength + "자 이하여야 합니다.");
  return text;
}

function optionalText_(value, maxLength) {
  var text = String(value == null ? "" : value).trim();
  if (maxLength && text.length > maxLength) throw new Error("입력값은 " + maxLength + "자 이하여야 합니다.");
  return text;
}

function requireNumberInRange_(value, label, min, max) {
  var number = Number(String(value == null ? "" : value).replace(/,/g, ""));
  if (!isFinite(number) || number < min || number > max) {
    throw new Error(label + "은(는) " + min + "~" + max + " 범위의 숫자여야 합니다.");
  }
  return number;
}

function requireMoney_(value, label, min, max) {
  var amount = requireNumberInRange_(value, label, min, max);
  if (Math.floor(amount) !== amount) throw new Error(label + "은(는) 정수 원 단위여야 합니다.");
  return amount;
}

function requireDateString_(value, label) {
  var text = String(value == null ? "" : value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(label + " 형식이 올바르지 않습니다.");
  var parts = text.split("-").map(Number);
  var date = new Date(parts[0], parts[1] - 1, parts[2]);
  if (date.getFullYear() !== parts[0] || date.getMonth() !== parts[1] - 1 || date.getDate() !== parts[2]) {
    throw new Error(label + "이(가) 실제 달력 날짜가 아닙니다.");
  }
  return text;
}

function requireMonthString_(value, label) {
  var text = String(value == null ? "" : value).trim().substring(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text)) throw new Error(label + " 형식이 올바르지 않습니다.");
  return text;
}

// Sheets가 사용자 입력을 수식으로 해석하지 않도록 위험한 선두 문자를 텍스트로 저장합니다.
function safeSheetText_(value, maxLength) {
  var text = optionalText_(value, maxLength);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function createUniqueId_(prefix) {
  return prefix + "-" + Utilities.getUuid();
}

/** 금액은 모든 경로에서 정수 원 단위, 0.5원은 부호 방향으로 반올림합니다. */
function roundMoney_(value) {
  return DateMoney_roundWon(value);
}

function truncateMoney_(value) {
  return DateMoney_truncateWon(value);
}

function prorateMoney_(monthlyFee, activeDays, billingDays) {
  return DateMoney_prorate(monthlyFee, activeDays, billingDays);
}

function inclusiveCalendarDays_(startDate, endDate) {
  return DateMoney_inclusiveDays(startDate, endDate);
}

function calculateProratedFee(monthlyFee, startDateText, endDateText, studentId, applyVacation) {
  var access = requireManagerPermission_("PAYMENT_DASHBOARD");
  if (!AccessControl_hasStudentDataAccess_(access)) throw new Error("학생을 찾을 수 없습니다.");
  studentId = requireText_(studentId, "학생 ID", 100);
  ChangeRequest_assertStudentScope_(access, [studentId]);
  var fee = requireNumberInRange_(monthlyFee, "월 수강료", 0, 100000000);
  var startText = requireDateString_(startDateText, "시작일");
  var endText = requireDateString_(endDateText, "종료일");
  var startDate = parseDateOnly_(startText);
  var endDate = parseDateOnly_(endText);
  if (startDate > endDate) throw new Error("종료일은 시작일보다 빠를 수 없습니다.");
  if (startDate.getFullYear() !== endDate.getFullYear() || startDate.getMonth() !== endDate.getMonth()) {
    throw new Error("일할 계산 기간은 같은 달 안에서 선택해주세요.");
  }

  // 기존 수납 수정 화면의 4개 인자 호출은 기존 동작을 유지하고, 새 대시보드는
  // 별도 '휴가 적용' 선택값을 명시적으로 전달합니다.
  var shouldApplyVacation = arguments.length < 5 ? true : applyVacation === true;
  var calculation = PaymentDomain_calculateProratedPeriod_(
    fee, startDate, endDate, shouldApplyVacation ? PaymentDomain_getStudentVacations_(studentId) : []
  );
  var nextDate = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() + 1);
  return {
    amount: calculation.amount,
    activeDays: calculation.activeDays,
    billingDays: calculation.billingDays,
    calendarDays: calculation.calendarDays,
    vacationDays: calculation.vacationDays,
    vacationPeriods: calculation.vacationPeriods,
    vacationApplied: shouldApplyVacation && calculation.vacationDays > 0,
    nextBaseDay: nextDate.getDate(),
    startDate: startText,
    endDate: endText
  };
}
