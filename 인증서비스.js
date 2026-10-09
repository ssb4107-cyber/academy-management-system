/** Google ID 토큰 검증과 임시 사용자 키 기반 웹앱 세션 */
var ACCESS_SESSION_TTL_SECONDS = 21600;
var ACCESS_SESSION_CACHE_PREFIX = "AUTH_SESSION_V1_";
var ACCESS_OAUTH_STATE_PREFIX = "AUTH_OAUTH_STATE_V1_";
var ACCESS_SESSION_PROPERTY_PREFIX = "AUTH_SESSION_STORE_V1_";
var ACCESS_OAUTH_STATE_PROPERTY_PREFIX = "AUTH_OAUTH_STATE_STORE_V1_";
var ACCESS_OAUTH_STATE_TTL_SECONDS = 600;
var ACCESS_OAUTH_CLIENT_SECRET_PROPERTY = "GOOGLE_WEB_CLIENT_SECRET";
var ACCESS_OAUTH_ISSUE_WINDOW_SECONDS = 60;
var ACCESS_OAUTH_ISSUE_MAX_NEW = 5;
var ACCESS_OAUTH_BLOCK_SECONDS = 300;
var ACCESS_OAUTH_REUSE_SECONDS = 30;
var ACCESS_OAUTH_ISSUE_PREFIX = "AUTH_OAUTH_ISSUE_V1_";
var ACCESS_OAUTH_BLOCK_PREFIX = "AUTH_OAUTH_BLOCK_V1_";
var ACCESS_OAUTH_REUSE_PREFIX = "AUTH_OAUTH_REUSE_V1_";

/**
 * 배포자 최초 1회 권한 승인용입니다.
 * Apps Script 편집기에서 runAdminOAuthPermissionSetup을 실행하면 OAuth 토큰 검증에 필요한
 * script.external_request 권한 승인 창이 표시됩니다.
 */
function authorizeGoogleOAuthNetworkAccess_() {
  var response = UrlFetchApp.fetch("https://oauth2.googleapis.com/tokeninfo", {
    method:"get",
    muteHttpExceptions:true,
    followRedirects:false
  });
  return "외부 통신 권한 승인 완료 (확인 응답 " + response.getResponseCode() + ")";
}

function AccessSession_key_() {
  var temporaryKey = String(Session.getTemporaryActiveUserKey() || "");
  if (!temporaryKey) return "";
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, temporaryKey);
  return ACCESS_SESSION_CACHE_PREFIX + Utilities.base64EncodeWebSafe(digest).replace(/=+$/, "").substring(0, 60);
}

function AccessSession_getCurrent_() {
  var key = AccessSession_key_();
  if (!key) return null;
  var cache = CacheService.getScriptCache();
  var propertyKey = ACCESS_SESSION_PROPERTY_PREFIX + key.substring(ACCESS_SESSION_CACHE_PREFIX.length);
  var raw = cache.get(key) || PropertiesService.getScriptProperties().getProperty(propertyKey);
  if (!raw) return null;
  try {
    var session = JSON.parse(raw);
    if (!session.email || !session.expiresAt || Number(session.expiresAt) <= Date.now()) {
      cache.remove(key);
      PropertiesService.getScriptProperties().deleteProperty(propertyKey);
      return null;
    }
    var ttl = Math.max(60, Math.min(ACCESS_SESSION_TTL_SECONDS, Math.floor((Number(session.expiresAt) - Date.now()) / 1000)));
    try { cache.put(key, raw, ttl); } catch (ignoredSessionRehydrateError) {}
    return session;
  } catch (error) {
    cache.remove(key);
    PropertiesService.getScriptProperties().deleteProperty(propertyKey);
    return null;
  }
}

function AccessSession_store_(identity, options) {
  options = options || {};
  var key = AccessSession_key_();
  if (!key) throw new Error("브라우저 세션 키를 만들 수 없습니다. Google 계정으로 다시 접속해주세요.");
  // ID 토큰은 로그인 순간에 유효성을 검증하고, 이후에는 별도의 서버 세션으로 최대 6시간 유지합니다.
  var expiresAt = Date.now() + ACCESS_SESSION_TTL_SECONDS * 1000;
  var session = { email:String(identity.email || "").trim().toLowerCase(), sub:String(identity.sub || ""),
    expiresAt:expiresAt, authenticatedAt:Date.now() };
  var ttl = Math.max(60, Math.min(ACCESS_SESSION_TTL_SECONDS, Math.floor((expiresAt - Date.now()) / 1000)));
  var raw = JSON.stringify(session);
  CacheService.getScriptCache().put(key, raw, ttl);
  var propertyKey = ACCESS_SESSION_PROPERTY_PREFIX + key.substring(ACCESS_SESSION_CACHE_PREFIX.length);
  if (options.persistent === false) {
    // 공개 C창구 계정은 데이터 권한이 없으며, 반복 로그인으로 영구 속성 한도를 소모하지 않게 캐시에만 둡니다.
    PropertiesService.getScriptProperties().deleteProperty(propertyKey);
  } else {
    PropertiesService.getScriptProperties().setProperty(propertyKey, raw);
  }
  return session;
}

function AccessSession_verifyGoogleToken_(credential, expectedNonce) {
  credential = String(credential || "").trim();
  if (!credential || credential.split(".").length !== 3 || credential.length > 10000) throw new Error("Google 로그인 토큰 형식이 올바르지 않습니다.");
  var response = UrlFetchApp.fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential), {
    method:"get", muteHttpExceptions:true, followRedirects:false
  });
  if (response.getResponseCode() !== 200) throw new Error("Google 로그인 토큰을 검증하지 못했습니다. 다시 로그인해주세요.");
  var identity;
  try { identity = JSON.parse(response.getContentText()); }
  catch (error) { throw new Error("Google 로그인 검증 응답을 읽지 못했습니다."); }
  var issuer = String(identity.iss || "");
  if (String(identity.aud || "") !== ACCESS_CONTROL.GOOGLE_WEB_CLIENT_ID) throw new Error("다른 애플리케이션에서 발급된 로그인 토큰입니다.");
  if (["accounts.google.com", "https://accounts.google.com"].indexOf(issuer) === -1) throw new Error("Google이 발급한 로그인 토큰이 아닙니다.");
  if (Number(identity.exp || 0) * 1000 <= Date.now()) throw new Error("Google 로그인 시간이 만료되었습니다.");
  if (String(identity.email_verified || "").toLowerCase() !== "true") throw new Error("확인되지 않은 Google 이메일입니다.");
  if (expectedNonce && String(identity.nonce || "") !== String(expectedNonce)) throw new Error("Google 로그인 요청 정보가 일치하지 않습니다. 처음부터 다시 로그인해주세요.");
  identity.email = String(identity.email || "").trim().toLowerCase();
  if (!identity.email || !identity.sub) throw new Error("Google 계정 정보를 확인할 수 없습니다.");
  return identity;
}

function AccessSession_getOAuthClientSecret_() {
  return String(PropertiesService.getScriptProperties().getProperty(ACCESS_OAUTH_CLIENT_SECRET_PROPERTY) || "").trim();
}

function AccessSession_randomToken_() {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    Utilities.getUuid() + "|" + Utilities.getUuid() + "|" + Date.now());
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, "");
}

function AccessSession_oauthIssueKeys_(sessionKey, mode) {
  var suffix = String(sessionKey || "").replace(ACCESS_SESSION_CACHE_PREFIX, "") + "_" + String(mode || "LOGIN");
  return {
    issue:ACCESS_OAUTH_ISSUE_PREFIX + suffix,
    block:ACCESS_OAUTH_BLOCK_PREFIX + suffix,
    reuse:ACCESS_OAUTH_REUSE_PREFIX + suffix
  };
}

function AccessSession_oauthRemainingSeconds_(blockedUntil, now) {
  return Math.max(1, Math.ceil((Number(blockedUntil || 0) - Number(now || Date.now())) / 1000));
}

function AccessSession_oauthBlockMessage_(blockedUntil, now) {
  return "Google 로그인 요청이 짧은 시간에 반복되어 이 브라우저의 새 요청을 잠시 멈췄습니다. " +
    AccessSession_oauthRemainingSeconds_(blockedUntil, now) + "초 뒤 다시 시도해주세요.";
}

function AccessSession_createOAuthRequest_(options) {
  options = options || {};
  var sessionKey = AccessSession_key_();
  if (!sessionKey) throw new Error("브라우저 세션을 확인할 수 없습니다. 쿠키를 허용한 뒤 다시 접속해주세요.");
  if (!AccessSession_getOAuthClientSecret_()) {
    throw new Error("스크립트 속성에 " + ACCESS_OAUTH_CLIENT_SECRET_PROPERTY + " 값을 먼저 등록해주세요.");
  }
  var cache = CacheService.getScriptCache();
  var mode = options.allowSessionKeyChange === true ? "SWITCH" : "LOGIN";
  var keys = AccessSession_oauthIssueKeys_(sessionKey, mode);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(250)) throw new Error("Google 로그인 요청이 많습니다. 잠시 뒤 다시 시도해주세요.");
  try {
    var now = Date.now();
    var blockedUntil = Number(cache.get(keys.block) || 0);
    if (blockedUntil > now) throw new Error(AccessSession_oauthBlockMessage_(blockedUntil, now));
    if (blockedUntil) cache.remove(keys.block);

    var reusable = null;
    try { reusable = JSON.parse(cache.get(keys.reuse) || "null"); } catch (ignoredReuseParseError) {}
    if (reusable && reusable.state && reusable.authorizationUrl &&
        now - Number(reusable.createdAt || 0) <= ACCESS_OAUTH_REUSE_SECONDS * 1000 &&
        cache.get(ACCESS_OAUTH_STATE_PREFIX + reusable.state)) {
      return { authorizationUrl:reusable.authorizationUrl, reused:true };
    }
    cache.remove(keys.reuse);

    var issueWindow = null;
    try { issueWindow = JSON.parse(cache.get(keys.issue) || "null"); } catch (ignoredIssueParseError) {}
    if (!issueWindow || !issueWindow.startedAt || now - Number(issueWindow.startedAt) >= ACCESS_OAUTH_ISSUE_WINDOW_SECONDS * 1000) {
      issueWindow = { startedAt:now, count:0 };
    }
    if (Number(issueWindow.count || 0) >= ACCESS_OAUTH_ISSUE_MAX_NEW) {
      blockedUntil = now + ACCESS_OAUTH_BLOCK_SECONDS * 1000;
      cache.put(keys.block, String(blockedUntil), ACCESS_OAUTH_BLOCK_SECONDS);
      throw new Error(AccessSession_oauthBlockMessage_(blockedUntil, now));
    }

    var state = AccessSession_randomToken_();
    var nonce = AccessSession_randomToken_();
    var redirectUri = ScriptApp.getService().getUrl();
    var statePayload = JSON.stringify({
      sessionKey:sessionKey, nonce:nonce, redirectUri:redirectUri, createdAt:now,
      allowSessionKeyChange:options.allowSessionKeyChange === true, issueMode:mode
    });
    var params = {
      client_id:ACCESS_CONTROL.GOOGLE_WEB_CLIENT_ID,
      redirect_uri:redirectUri,
      response_type:"code",
      scope:"openid email",
      state:state,
      nonce:nonce,
      prompt:"select_account",
      include_granted_scopes:"true"
    };
    var query = Object.keys(params).map(function(key) {
      return encodeURIComponent(key) + "=" + encodeURIComponent(params[key]);
    }).join("&");
    var authorizationUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + query;
    cache.put(ACCESS_OAUTH_STATE_PREFIX + state, statePayload, ACCESS_OAUTH_STATE_TTL_SECONDS);
    issueWindow.count = Number(issueWindow.count || 0) + 1;
    cache.put(keys.issue, JSON.stringify(issueWindow), ACCESS_OAUTH_ISSUE_WINDOW_SECONDS);
    cache.put(keys.reuse, JSON.stringify({ state:state, authorizationUrl:authorizationUrl, createdAt:now }), ACCESS_OAUTH_REUSE_SECONDS);
    // 공개 로그인 화면은 누구나 열 수 있으므로 OAuth 임시 상태를 영구 속성에 누적하지 않습니다.
    // 캐시가 일찍 비워진 경우에는 로그인 요청을 다시 시작하게 하여 저장소 고갈보다 안전한 실패를 택합니다.
    return { authorizationUrl:authorizationUrl, reused:false };
  } finally {
    lock.releaseLock();
  }
}

function AccessSession_canUseOAuthRequest_(request, currentSessionKey) {
  return !!(request && request.sessionKey) &&
    (request.allowSessionKeyChange === true || String(request.sessionKey) === String(currentSessionKey || ""));
}

function AccessSession_exchangeAuthorizationCode_(code, state) {
  code = String(code || "").trim();
  state = String(state || "").trim();
  if (!code || !state) throw new Error("Google 로그인 응답이 완전하지 않습니다.");
  var cache = CacheService.getScriptCache();
  var stateKey = ACCESS_OAUTH_STATE_PREFIX + state;
  var properties = PropertiesService.getScriptProperties();
  var raw = cache.get(stateKey);
  cache.remove(stateKey);
  // 이전 배포가 남긴 동일 state 속성이 있으면 함께 정리하되 로그인에는 사용하지 않습니다.
  properties.deleteProperty(ACCESS_OAUTH_STATE_PROPERTY_PREFIX + state);
  if (!raw) throw new Error("로그인 요청이 만료되었거나 이미 사용되었습니다. 다시 로그인해주세요.");
  var request;
  try { request = JSON.parse(raw); }
  catch (parseError) { throw new Error("로그인 요청 정보를 읽지 못했습니다."); }
  if (!AccessSession_canUseOAuthRequest_(request, AccessSession_key_())) {
    throw new Error("로그인을 시작한 브라우저와 현재 브라우저가 다릅니다.");
  }
  if (!request.createdAt || Date.now() - Number(request.createdAt) > ACCESS_OAUTH_STATE_TTL_SECONDS * 1000) throw new Error("로그인 요청 시간이 만료되었습니다. 다시 로그인해주세요.");
  var response = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", {
    method:"post",
    muteHttpExceptions:true,
    payload:{
      code:code,
      client_id:ACCESS_CONTROL.GOOGLE_WEB_CLIENT_ID,
      client_secret:AccessSession_getOAuthClientSecret_(),
      redirect_uri:String(request.redirectUri || ScriptApp.getService().getUrl()),
      grant_type:"authorization_code"
    }
  });
  var tokenResult;
  try { tokenResult = JSON.parse(response.getContentText()); }
  catch (parseTokenError) { throw new Error("Google 토큰 응답을 읽지 못했습니다."); }
  if (response.getResponseCode() !== 200 || !tokenResult.id_token) {
    console.error("[Google OAuth 토큰 교환 실패] " + JSON.stringify({ code:response.getResponseCode(), error:tokenResult.error,
      description:tokenResult.error_description }));
    throw new Error("Google 로그인을 완료하지 못했습니다. OAuth 클라이언트 설정을 확인해주세요.");
  }
  var identity = AccessSession_verifyGoogleToken_(tokenResult.id_token, request.nonce);
  var accessState = AccessSession_classifyIdentity_(identity);
  var session = AccessSession_store_(identity, { persistent:accessState.accessGranted });
  console.log("[Google OAuth 로그인 성공] " + JSON.stringify({ email:session.email, route:accessState.route,
    expiresAt:session.expiresAt }));
  return { authenticated:true, accessGranted:accessState.accessGranted, accessReason:accessState.reason || "",
    email:session.email, route:accessState.route, expiresAt:session.expiresAt,
    redirectUrl:ScriptApp.getService().getUrl() };
}

function AccessSession_renderOAuthCallback_(e) {
  try {
    var params = e && e.parameter ? e.parameter : {};
    if (params.error) throw new Error(params.error === "access_denied" ? "Google 로그인이 취소되었습니다." : "Google 로그인 오류: " + params.error);
    var loginResult = AccessSession_exchangeAuthorizationCode_(params.code, params.state);
    if (!loginResult.accessGranted) return AccessSession_renderAccessRequest_(loginResult);
    // 콜백이 Apps Script의 제한된 iframe 안에서 열릴 수도 있으므로 최상위 창으로
    // 다시 이동하지 않습니다. 방금 저장한 검증 세션으로 메인 화면을 같은 응답에 렌더링합니다.
    return createMainMenuHtml();
  } catch (error) {
    return AccessSession_renderLogin_(error && error.message ? error.message : "로그인하지 못했습니다.");
  }
}

/** 검증된 Google 계정을 A/B 통로 또는 데이터 접근이 없는 C창구로 분류합니다. */
function AccessSession_classifyIdentityFromRows_(identity, rows) {
  var email = String(identity.email || "").trim().toLowerCase();
  if (!email) throw new Error("Google 계정 이메일을 확인할 수 없습니다.");
  if (ACCESS_CONTROL.ADMIN_EMAILS.indexOf(email) !== -1) {
    return { email:email, route:"A_SUPER_ADMIN", accessGranted:true, reason:"" };
  }
  var matches = [];
  for (var i = 1; i < (rows || []).length; i++) {
    if (String(rows[i][IDX.USER.EMAIL] || "").trim().toLowerCase() === email) matches.push(rows[i]);
  }
  if (matches.length > 1) {
    throw new Error("동일 이메일의 사용자 계정이 중복 등록되어 접근을 차단했습니다. 최고 원장에게 사용자 설정을 정리해달라고 요청해주세요.");
  }
  if (!matches.length) {
    return { email:email, route:"C_NO_ACCESS", accessGranted:false, reason:"NOT_REGISTERED" };
  }
  if (!Management_toBoolean_(matches[0][IDX.USER.ACTIVE])) {
    return { email:email, route:"C_NO_ACCESS", accessGranted:false, reason:"ACCOUNT_INACTIVE" };
  }
  var selected = AccessControl_selectAccountFromRows_(email, rows).account;
  var role = AccessControl_requireValidRole_(selected[IDX.USER.ROLE]);
  return { email:email, route:role === ACCESS_CONTROL.ROLES.SUPER_ADMIN ? "A_SUPER_ADMIN" : "B_MANAGER",
    accessGranted:true, reason:"" };
}

function AccessSession_classifyIdentity_(identity) {
  var email = String(identity && identity.email || "").trim().toLowerCase();
  if (ACCESS_CONTROL.ADMIN_EMAILS.indexOf(email) !== -1) {
    return { email:email, route:"A_SUPER_ADMIN", accessGranted:true, reason:"" };
  }
  var rows = AccessControl_loadAuthorizationUserRows_();
  return AccessSession_classifyIdentityFromRows_(identity, rows);
}

function AccessSession_authorizeIdentity_(identity) {
  var accessState = AccessSession_classifyIdentity_(identity);
  if (!accessState.accessGranted) {
    throw new Error("등록되지 않았거나 사용이 중지된 계정입니다. 최고 원장에게 확인해주세요: " + accessState.email);
  }
  return accessState;
}

// 이전 GIS 실험용 경로입니다. nonce 없는 ID 토큰을 공개 RPC로 받지 않도록 비공개로 유지합니다.
function authenticateGoogleCredential_(credential) {
  var identity = AccessSession_verifyGoogleToken_(credential);
  var accessState = AccessSession_classifyIdentity_(identity);
  var session = AccessSession_store_(identity, { persistent:accessState.accessGranted });
  console.log("[Google 로그인 성공] " + JSON.stringify({ email:session.email, route:accessState.route,
    expiresAt:session.expiresAt }));
  return { authenticated:true, accessGranted:accessState.accessGranted, accessReason:accessState.reason || "",
    email:session.email, route:accessState.route, expiresAt:session.expiresAt,
    redirectUrl:ScriptApp.getService().getUrl() };
}

function AccessSession_clearCurrent_() {
  var key = AccessSession_key_();
  if (key) {
    CacheService.getScriptCache().remove(key);
    PropertiesService.getScriptProperties().deleteProperty(
      ACCESS_SESSION_PROPERTY_PREFIX + key.substring(ACCESS_SESSION_CACHE_PREFIX.length)
    );
  }
  return !!key;
}

function logoutWebAppSession() {
  // 같은 웹 앱 주소로 돌아가 기존 계정이 자동 선택되는 대신 Google 계정 선택 화면으로
  // 곧바로 이동합니다. 계정 변경 시 임시 사용자 키가 달라질 수 있어 이 요청에 한해서만
  // 콜백의 키 변경을 허용하고, 무작위 state와 일회용 nonce 검증은 그대로 유지합니다.
  var oauthRequest = AccessSession_createOAuthRequest_({ allowSessionKeyChange:true });
  // 선택 주소 생성에 실패했을 때 현재 세션까지 잃지 않도록 주소를 만든 뒤 기존 세션을 지웁니다.
  AccessSession_clearCurrent_();
  return { loggedOut:true, accountSelection:true, redirectUrl:oauthRequest.authorizationUrl };
}

/** 일일 유지보수에서 만료된 보조 세션·OAuth 상태만 정리합니다. 토큰은 저장하지 않습니다. */
function AccessSession_cleanupExpired_() {
  var properties = PropertiesService.getScriptProperties();
  var all = properties.getProperties();
  var now = Date.now(), removed = 0;
  Object.keys(all).forEach(function(key) {
    if (key.indexOf(ACCESS_SESSION_PROPERTY_PREFIX) !== 0 && key.indexOf(ACCESS_OAUTH_STATE_PROPERTY_PREFIX) !== 0) return;
    var value = null;
    try { value = JSON.parse(all[key]); } catch (ignoredParseError) {}
    var expired = key.indexOf(ACCESS_SESSION_PROPERTY_PREFIX) === 0
      ? (!value || Number(value.expiresAt || 0) <= now)
      : (!value || now - Number(value.createdAt || 0) > ACCESS_OAUTH_STATE_TTL_SECONDS * 1000);
    if (expired) { properties.deleteProperty(key); removed++; }
  });
  return removed;
}

function AccessSession_renderLogin_(message) {
  var template = HtmlService.createTemplateFromFile("AuthGateway");
  var oauthRequest = null;
  var setupError = "";
  try { oauthRequest = AccessSession_createOAuthRequest_(); }
  catch (error) { setupError = error && error.message ? String(error.message) : String(error); }
  template.authorizationUrl = oauthRequest ? oauthRequest.authorizationUrl : "";
  template.message = String(message || setupError || "");
  template.redirectUrl = ScriptApp.getService().getUrl();
  return template.evaluate().setTitle("학원비 관리 로그인").addMetaTag("viewport", "width=device-width, initial-scale=1");
}

/** C창구는 검증된 계정과 조치 안내만 표시하며 업무 데이터는 조회하지 않습니다. */
function AccessSession_renderAccessRequest_(accessState) {
  accessState = accessState || {};
  var reason = String(accessState.reason || accessState.accessReason || "NOT_REGISTERED");
  var template = HtmlService.createTemplateFromFile("AccessRequestGateway");
  var switchRequest = null;
  var setupError = "";
  try { switchRequest = AccessSession_createOAuthRequest_({ allowSessionKeyChange:true }); }
  catch (error) { setupError = error && error.message ? String(error.message) : String(error); }
  template.email = String(accessState.email || "").trim().toLowerCase();
  template.reason = reason;
  template.statusTitle = reason === "ACCOUNT_INACTIVE" ? "현재 사용이 중지된 계정입니다" : "아직 사용 권한이 없습니다";
  template.statusMessage = reason === "ACCOUNT_INACTIVE"
    ? "최고 원장에게 계정의 사용 상태를 확인해달라고 요청해주세요."
    : "최고 원장에게 아래 Google 이메일을 사용자로 등록해달라고 요청해주세요.";
  template.switchAuthorizationUrl = switchRequest ? switchRequest.authorizationUrl : "";
  template.setupError = setupError;
  template.redirectUrl = ScriptApp.getService().getUrl();
  return template.evaluate().setTitle("학원비 관리 권한 안내").addMetaTag("viewport", "width=device-width, initial-scale=1");
}
