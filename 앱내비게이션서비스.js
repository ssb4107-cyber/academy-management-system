function getAppNavigationState() {
  var user = requireAuthorizedUser_();
  return AppNavigation_buildState_(user);
}

/** 이미 인증을 마친 화면에서는 사용자 판정을 반복하지 않고 메뉴 상태만 조립합니다. */
function AppNavigation_buildState_(user) {
  var isSuper = !!(user.bootstrap || user.role === ACCESS_CONTROL.ROLES.SUPER_ADMIN);
  var hasStudentAccess = isSuper || AccessControl_hasStudentDataAccess_(user);
  var baseUrl = ScriptApp.getService().getUrl();
  var changeCount, paymentCount;
  if (isSuper) {
    var unifiedCounts = UnifiedRequest_getSummary_();
    changeCount = Number(unifiedCounts.change) || 0;
    paymentCount = Number(unifiedCounts.payment) || 0;
  } else if (hasStudentAccess) {
    var ownUnifiedCounts = { change:0, payment:0 };
    UnifiedRequest_readPendingRows_().forEach(function(row) {
      if (String(row[IDX.REQUEST.REQUESTER_EMAIL] || "").trim().toLowerCase() !== user.email) return;
      if (String(row[IDX.REQUEST.CATEGORY] || "") === UNIFIED_REQUEST_CATEGORY.PAYMENT) ownUnifiedCounts.payment++;
      else ownUnifiedCounts.change++;
    });
    changeCount = ownUnifiedCounts.change;
    // 모든 요청 상태는 DB_요청 한 곳에서 집계합니다.
    paymentCount = ownUnifiedCounts.payment;
  } else {
    changeCount = 0;
    paymentCount = 0;
  }
  var menus = [];
  function add(group, label, page, icon, badge) { menus.push({ group:group, label:label, url:baseUrl + (page ? "?page=" + page : ""), icon:icon, badge:Number(badge) || 0 }); }
  add("바로가기", "메인", "", "🏠", 0);
  APP_ROUTE_REGISTRY.forEach(function(route) {
    if (!route.nav || (route.managerOnly && isSuper) || !AccessControl_canAccessPage_(user, route.page)) return;
    var badge = route.page === "DashboardUI" && isSuper ? changeCount + paymentCount
      : route.page === "MyRequestStatus" ? changeCount + paymentCount : 0;
    add(route.group, route.label, route.page, route.icon, badge);
  });
  return { isSuperAdmin:isSuper, hasStudentAccess:hasStudentAccess,
    studentScope:AccessControl_getStudentScope_(user), userName:user.name || user.email, menus:menus,
    counts:{ change:changeCount, payment:paymentCount, total:changeCount + paymentCount } };
}

function AppNavigation_inject_(html) {
  html = String(html || "");
  if (html.indexOf("id=\"appNavRoot\"") !== -1) return html;
  var component = HtmlService.createHtmlOutputFromFile("AppTheme").getContent()
    + HtmlService.createHtmlOutputFromFile("AppNavigation").getContent();
  // 대시보드 스크립트에는 iframe용 HTML 문자열의 </body>가 들어 있습니다.
  // 첫 일치 항목을 바꾸면 JavaScript가 중간에서 끊기므로 실제 문서의 마지막 닫는 태그만 사용합니다.
  var lower = html.toLowerCase();
  var bodyCloseIndex = lower.lastIndexOf("</body>");
  return bodyCloseIndex >= 0
    ? html.substring(0, bodyCloseIndex) + component + html.substring(bodyCloseIndex)
    : html + component;
}
