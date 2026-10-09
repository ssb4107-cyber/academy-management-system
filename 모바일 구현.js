/* =================================================================
   🌐 [웹 앱] 라우팅 시스템 (모바일/브라우저 접속용)
   ================================================================= */

function doGet(e) {
  if (e && e.parameter && (e.parameter.code || e.parameter.error)) {
    return AccessSession_renderOAuthCallback_(e);
  }
  var authorizedUser;
  try {
    authorizedUser = requireInteractiveAuthorizedUser_();
  } catch (authError) {
    var identity = AccessControl_getVerifiedSessionIdentity_();
    if (identity.email) {
      try {
        var accessState = AccessSession_classifyIdentity_({ email:identity.email });
        if (!accessState.accessGranted) return AccessSession_renderAccessRequest_(accessState);
      } catch (accessStateError) {
        return AccessSession_renderLogin_(accessStateError && accessStateError.message
          ? String(accessStateError.message) : "계정 권한 상태를 확인하지 못했습니다.");
      }
    }
    var loginMessage = identity.source === "VERIFIED_SESSION_REQUIRED" ? "" :
      (authError && authError.message ? String(authError.message) : "로그인 세션을 확인할 수 없습니다.");
    return AccessSession_renderLogin_(loginMessage);
  }
  var page = e && e.parameter ? e.parameter.page : "";
  // ★ 신규 추가: URL에서 searchName 파라미터를 추출 (없으면 빈 문자열)
  var searchName = e && e.parameter ? String(e.parameter.searchName || "").substring(0, 50) : "";
  var embedded = !!(e && e.parameter && String(e.parameter.embedded || "") === "1");

  // 1. 페이지 요청이 없으면 '메인 메뉴'를 보여줌
  if (!page) {
    return createMainMenuHtml(authorizedUser);
  }
  var requestedRoute = AppRoute_find_(page);
  if (!requestedRoute) {
    return HtmlService.createHtmlOutput('❌ 허용되지 않은 페이지입니다.<br><a href="' + getScriptUrl() + '">메인으로 돌아가기</a>');
  }
  var pageAccess = authorizedUser;
  var pageRoute = AccessControl_getPortalRoute_(pageAccess);
  var pageIsSuperAdmin = pageRoute === "A_SUPER_ADMIN";
  if (!pageIsSuperAdmin && !AccessControl_canAccessPage_(pageAccess, page)) {
    return HtmlService.createHtmlOutput("최고 원장이 이 계정에 해당 메뉴를 열어주지 않았습니다.")
      .setTitle("접근 제한");
  }
  page = AppRoute_renderPage_(page);
  
  // 2. 요청된 페이지가 있으면 해당 HTML 파일을 열어줌
  try {
    // ★ 변경: 바로 evaluate() 하지 않고 템플릿 객체를 먼저 생성합니다.
    var template = HtmlService.createTemplateFromFile(page);
    
    // ★ 핵심: HTML 템플릿 내부(<?= searchName ?>)에서 쓸 수 있도록 변수를 주입합니다.
    template.searchName = searchName; 
    template.embedded = embedded;

    var evaluatedPage = template.evaluate();
    return HtmlService.createHtmlOutput(AppNavigation_inject_(evaluatedPage.getContent()))
        .setTitle('학원비 관리 시스템')
        .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } catch (err) {
    console.error("페이지 로드 실패: " + page + " / " + err);
    return HtmlService.createHtmlOutput('❌ 페이지를 불러오지 못했습니다.<br><a href="' + getScriptUrl() + '">메인으로 돌아가기</a>');
  }
}

// 현재 웹 앱의 URL을 가져오는 함수
function getScriptUrl() {
  requireAuthorizedUser_();
  return ScriptApp.getService().getUrl();
}

// 📱 웹 앱용 메인 메뉴 화면 생성 (HTML 파일 없이 코드로 생성)
function createMainMenuHtml(access) {
  // 공개 서버 함수이므로 전달받은 access 객체를 신뢰하지 않고 현재 세션을 다시 판정합니다.
  access = requireAuthorizedUser_();
  var url = ScriptApp.getService().getUrl();
  var isSuperAdmin = access.bootstrap || access.role === ACCESS_CONTROL.ROLES.SUPER_ADMIN;
  var navigationState = AppNavigation_buildState_(access);
  function can(pageName) { return isSuperAdmin || AccessControl_canAccessPage_(access, pageName); }
  function mainLink(pageName, icon, label, badge) {
    var route = AppRoute_find_(pageName);
    if (route) { icon = route.icon || icon; label = route.label || label; }
    return can(pageName) ? `<a href="${url}?page=${pageName}" class="menu-item"><span class="icon">${icon}</span>${label}${badge || ""}</a>` : "";
  }
  function requestBadge_(count) {
    count = Number(count) || 0;
    return count ? `<span class="main-request-badge">${count > 99 ? "99+" : count}</span>` : "";
  }
  var adminMenus = isSuperAdmin ? `
        ${mainLink("TeacherManagement", "", "")}
        ${mainLink("SettingsDashboard", "", "")}
        ` : "";
  var studentMenuLinks = mainLink("StudentAddUI", "➕", "학생 등록") +
    mainLink("StudentEdit", "✏️", "학생 정보 수정/퇴원처리") +
    mainLink("StudentVacation", "🏖️", "학생 휴가 등록") +
    mainLink("SiblingManager", "👨‍👩‍👦", "형제/자매 관리");
  var studentMenus = studentMenuLinks ? `
        <div class="menu-group">
          <div class="group-title">학생 관리</div>
          ${studentMenuLinks}
        </div>` : "";
  var paymentMenus = isSuperAdmin ? `
        ${mainLink("DashboardUI", "", "", requestBadge_(navigationState.counts.total))}
        ${mainLink("PaymentEdit", "", "")}
        ${mainLink("PaymentChecklist", "", "")}
        ${mainLink("CashReceipt", "", "")}
        ${mainLink("StatisticsDashboard", "", "")}
        ${mainLink("TrashManager", "", "")}` : `
        ${mainLink("DashboardUI", "📊", "수납 대시보드")}`;
  var paymentSection = paymentMenus ? `<div class="menu-group"><div class="group-title">수납 관리</div>${paymentMenus}</div>` : "";
  var settlementMenus = isSuperAdmin ? `
      <div class="menu-group">
        <div class="group-title">선생님/정산</div>
        ${mainLink("SalaryDashboard", "", "")}
        ${adminMenus}
      </div>` : "";
  var historyMenu = isSuperAdmin ? mainLink("ChangeLogViewer", "", "") : "";
  var requestStatusMenu = isSuperAdmin ? "" : mainLink("MyRequestStatus", "", "", requestBadge_(navigationState.counts.total));
  var appTheme = HtmlService.createHtmlOutputFromFile("AppTheme").getContent();
  var appGlossary = includeHtml_("AppGlossary");

  var html = `
    <!DOCTYPE html>
    <html>
    <head>
      <base target="_top">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700&display=swap" rel="stylesheet">
      ${appTheme}
      <style>
        * { box-sizing:border-box; } body { margin:0; font-family:'Noto Sans KR',sans-serif; background:var(--app-bg); color:var(--app-ink); }
        .hero { padding:28px 20px; text-align:center; color:#fff; background:linear-gradient(120deg,var(--app-navy),var(--app-blue)); box-shadow:0 4px 15px rgba(22,50,92,.2); }
        .hero h1 { margin:0; font-size:25px; }.hero p{margin:6px 0 0;color:rgba(255,255,255,.78);font-size:13px}.shell{max-width:760px;margin:auto;padding:18px}
        .menu-group { background:white;border:1px solid var(--app-line);border-radius:14px;box-shadow:0 3px 12px rgba(40,64,100,.065);overflow:hidden;margin-bottom:14px; }
        .group-title { background:var(--app-soft);color:#174ea6;font-weight:bold;padding:11px 14px;font-size:13px;text-align:left; }
        .menu-item { display:flex;align-items:center;min-height:52px;padding:14px;border-bottom:1px solid #edf0f4;text-decoration:none;color:#283443;font-weight:bold;font-size:15px;text-align:left; }
        .menu-item:last-child { border-bottom: none; }
        .menu-item:hover { background-color: #f8fbff; color: #1a73e8; }
        .icon { display:inline-flex;align-items:center;justify-content:center;width:28px;margin-right:8px; }
        .main-request-badge { display:inline-flex; align-items:center; justify-content:center; min-width:22px; height:22px; padding:0 7px; margin-left:auto; border-radius:12px; background:#d93025; color:#fff; font-size:11px; font-weight:900; }
        .account-switch { display:block;margin:8px auto 2px;border:0;background:transparent;color:#6b7280;text-decoration:underline;cursor:pointer; }
        @media(max-width:520px){.hero{padding:23px 14px}.shell{padding:12px}.menu-item{min-height:54px}}
      </style>
    </head>
    <body>
      <header class="hero"><h1>🎓 학원비 관리 시스템</h1><p>필요한 업무를 선택하세요.</p></header><main class="shell">

      ${studentMenus}

      ${paymentSection}

      ${settlementMenus}

      <div class="menu-group">
        <div class="group-title">기타</div>
        ${historyMenu}
        ${requestStatusMenu}
        ${mainLink("Manual", "", "")}
      </div>
      <button class="account-switch" onclick="var b=this;b.disabled=true;b.textContent='계정 선택 화면 여는 중...';google.script.run.withSuccessHandler(function(r){if(!r||!r.redirectUrl){b.disabled=false;b.textContent='다른 Google 계정으로 전환';alert('계정 선택 주소를 만들지 못했습니다. 화면을 새로고침한 뒤 다시 시도해주세요.');return}window.top.location.href=r.redirectUrl}).withFailureHandler(function(e){b.disabled=false;b.textContent='다른 Google 계정으로 전환';alert(((e&&e.message)||e||'계정 선택 화면을 열지 못했습니다.')+'\\n화면을 새로고침한 뒤 다시 시도해주세요.')}).logoutWebAppSession()">다른 Google 계정으로 전환</button>
      </main>
      ${appGlossary}
    </body>
    </html>
  `;
  
  return HtmlService.createHtmlOutput(html)
      .setTitle('메인 메뉴')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
