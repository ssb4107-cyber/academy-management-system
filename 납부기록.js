function openHtmlDashboard() {
  requireSpreadsheetManagerPermission_("PAYMENT_DASHBOARD");
  var template = HtmlService.createTemplateFromFile('DashboardUI');
  var html = template.evaluate()
      .setWidth(1600) 
      .setHeight(900);
  SpreadsheetApp.getUi().showModalDialog(html, '종합 수납 대시보드');
}

var DASHBOARD_RESULT_CACHE_MAX_CHUNKS = 20;
var DASHBOARD_RESULT_CACHE_TTL_SECONDS = 600;
var DashboardResultCache_lastReadStatus_ = "not_checked";
var DashboardResultCache_lastWriteStatus_ = "not_attempted";

function Dashboard_cacheDependencyMonths_(targetYm) {
  targetYm = requireMonthString_(targetYm, "조회 월");
  var months = [];
  for (var offset = -23; offset <= 1; offset++) months.push(Dashboard_shiftMonth_(targetYm, offset));
  return months;
}

/** 원본 시트 세대가 같은 동안에는 완성된 월별 대시보드 결과를 재사용합니다. */
function DashboardResultCache_signature_(targetYm) {
  var dependencies = [
    SHEET_NAMES.STUDENTS, SHEET_NAMES.PAYMENTS, SHEET_NAMES.VACATIONS,
    SHEET_NAMES.LOGS, SHEET_NAMES.EVENTS, SHEET_NAMES.TEACHERS, SHEET_NAMES.SETTINGS,
    SHEET_NAMES.REQUESTS
  ];
  // 화면은 전월·당월·익월뿐 아니라 최대 24개월의 연속 미납 이력을 사용합니다.
  // 조회 월 하나만 서명에 넣으면 과거 수납 수정 후 현재 화면이 오래된 결과를
  // 재사용할 수 있으므로 실제 소비 범위를 모두 캐시 의존성으로 포함합니다.
  var months = Dashboard_cacheDependencyMonths_(targetYm);
  // 과거 월 화면도 '현재 재원 여부(paymentEligible)'를 함께 표시하므로 오늘 날짜가
  // 바뀌면 결과 캐시가 달라져야 합니다. 월별 파생 스냅샷의 과거 안정성과는 별개입니다.
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd");
  return QueryResultCache_signatureForMonths_(
    "DASHBOARD_V10_PENDING_PAYMENTS", targetYm + "_" + today, months, dependencies
  );
}

function DashboardResultCache_get_(signature) {
  var read = QueryResultCache_read_(signature, { maxChunks: DASHBOARD_RESULT_CACHE_MAX_CHUNKS });
  DashboardResultCache_lastReadStatus_ = read.status;
  return read.value;
}

function DashboardResultCache_put_(signature, data) {
  var write = QueryResultCache_write_(signature, data, DASHBOARD_RESULT_CACHE_TTL_SECONDS,
    { maxChunks: DASHBOARD_RESULT_CACHE_MAX_CHUNKS });
  DashboardResultCache_lastWriteStatus_ = write.status;
  return write.stored;
}

/**
 * 🔄 [대시보드 전용] 캐시 강제 초기화 후 데이터 조회
 * 조회 버튼을 눌렀을 때 원본 시트와 100% 동기화시키는 무적의 함수
 */
function Dashboard_getDataWithPolicy_(targetYm, forceRefresh, access) {
  var stage = "권한 확인";
  try {
    access = access || requireManagerPermission_("PAYMENT_DASHBOARD");
    if (!AccessControl_hasPermission_(access, "PAYMENT_DASHBOARD")) throw new Error("수납 대시보드 접근 권한이 없습니다. 최고 원장에게 사용자 메뉴 권한을 확인해달라고 요청해주세요.");
    targetYm = Dashboard_resolveTargetYm_(targetYm);
    if (forceRefresh) {
      stage = "캐시 초기화";
      try {
        Dashboard_forceRefreshMonths_(targetYm);
      } catch (cacheError) {
        console.warn("[수납 대시보드][캐시 초기화 경고] " + (cacheError && cacheError.stack ? cacheError.stack : cacheError));
      }
    }
    stage = forceRefresh ? "원본 조회 및 월별 데이터 조립" : "캐시 우선 월별 데이터 조립";
    return Dashboard_getDataForHtml_(targetYm, { access:access });
  } catch (error) {
    var diagnosticId = DashboardLog_failure_(targetYm, stage, error);
    var message = error && error.message ? error.message : String(error || "알 수 없는 오류");
    throw new Error("수납 대시보드 조회에 실패했습니다. 오류 ID: " + diagnosticId + " / " + message);
  }
}

function Dashboard_forceRefreshMonths_(targetYm) {
  targetYm = requireMonthString_(targetYm, "조회 월");
  var months = Dashboard_cacheDependencyMonths_(targetYm);
  // 화면 결과와 같은 범위(연속 미납 최대 24개월 + 다음 달)를 새로고칩니다.
  // 전월·당월·익월만 지우면 더 오래된 수납 수정이 미납 연속 개월에 남습니다.
  [SHEET_NAMES.STUDENTS, SHEET_NAMES.PAYMENTS, SHEET_NAMES.VACATIONS, SHEET_NAMES.LOGS, SHEET_NAMES.EVENTS, SHEET_NAMES.REQUESTS]
    .forEach(function(sheetName) { DataRepository_evictCache_(sheetName); });
  MonthlyCache_markMonthsDirty_(months);
  MonthlySnapshotStore_markMonthsStale_(months);
}

function getDashboardData(targetYm) {
  return Dashboard_getDataWithPolicy_(targetYm, false);
}

function getDashboardDataWithRefresh(targetYm) {
  return Dashboard_getDataWithPolicy_(targetYm, true);
}

function getDashboardDataWithPolicyForHtml(targetYm, forceRefresh) {
  var access = requireAuthorizedUser_();
  var result = Dashboard_getDataWithPolicy_(targetYm, !!forceRefresh, access);
  // 대시보드 본문·접근 권한·좌측 메뉴·요청 건수를 한 번의 브라우저 왕복으로 전달합니다.
  result.navigationState = AppNavigation_buildState_(access);
  return result;
}

/** 저장·수정 직후 전체 화면 대신 영향받은 학생만 서버 기준으로 다시 계산합니다. */
function getDashboardStudentsForHtml(targetYm, studentIds) {
  var access = requireManagerPermission_("PAYMENT_DASHBOARD");
  if (!AccessControl_hasStudentDataAccess_(access)) return { list:[], months:{} };
  var idMap = {}, cleanIds = [];
  (studentIds || []).forEach(function(id) {
    var cleanId = String(id || "").trim();
    if (cleanId && !idMap[cleanId]) { idMap[cleanId] = true; cleanIds.push(cleanId); }
  });
  if (!cleanIds.length) return { list:[], months:{} };
  var resolvedYm = requireMonthString_(Dashboard_resolveTargetYm_(targetYm), "조회 월");
  cleanIds.sort();
  var dependencies = [
    SHEET_NAMES.STUDENTS, SHEET_NAMES.PAYMENTS, SHEET_NAMES.REQUESTS,
    SHEET_NAMES.VACATIONS, SHEET_NAMES.EVENTS, SHEET_NAMES.LOGS, SHEET_NAMES.TEACHERS
  ];
  var accessKey = [
    AccessControl_getStudentScope_(access), String(access.teacherId || ""), cleanIds.join("|")
  ].join("|");
  var accessHash = Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, accessKey, Utilities.Charset.UTF_8
  )).replace(/=+$/, "").substring(0, 24);
  var signature = QueryResultCache_signature_("DASHBOARD_TARGETED_V2", resolvedYm + "_" + accessHash, dependencies);
  var cached = QueryResultCache_get_(signature, { maxChunks: 10 });
  if (cached && Array.isArray(cached.list)) {
    cached.performance = { cacheHit:true, partial:true, targetedCacheHit:true, serverMs:0 };
    return cached;
  }
  var context = Dashboard_buildTargetedContext_(cleanIds);
  if (!context[SHEET_NAMES.STUDENTS] || context[SHEET_NAMES.STUDENTS].length <= 1) {
    var empty = { list:[], months:{} };
    QueryResultCache_put_(signature, empty, 180, { maxChunks: 2 });
    return empty;
  }
  var data = Dashboard_getDataForHtml_(resolvedYm, {
    context: context, partial:true, access:access
  });
  var result = {
    list: data.list,
    months: data.months
  };
  var finalSignature = QueryResultCache_signature_("DASHBOARD_TARGETED_V2", resolvedYm + "_" + accessHash, dependencies);
  if (finalSignature === signature) QueryResultCache_put_(finalSignature, result, 180, { maxChunks: 10 });
  return result;
}

function Dashboard_readIndexedRows_(sheetName, columnNumber, ids) {
  return LookupIndex_readTableForValues_(sheetName, columnNumber, ids, false);
}

/** 저장 직후에는 전체 원장을 조립하지 않고 영향받은 학생의 행만 읽습니다. */
function Dashboard_buildTargetedContext_(studentIds) {
  var context = {};
  context[SHEET_NAMES.STUDENTS] = Dashboard_readIndexedRows_(SHEET_NAMES.STUDENTS, COL.STUDENT.ID, studentIds);
  if (!context[SHEET_NAMES.STUDENTS] || context[SHEET_NAMES.STUDENTS].length <= 1) {
    context.__monthlySnapshotPartial = true;
    return context;
  }
  context[SHEET_NAMES.PAYMENTS] = Dashboard_readIndexedRows_(SHEET_NAMES.PAYMENTS, COL.PAYMENT.STUDENT_ID, studentIds);
  context[SHEET_NAMES.REQUESTS] = Dashboard_readIndexedRows_(SHEET_NAMES.REQUESTS, COL.REQUEST.TARGET_ID, studentIds);
  context[SHEET_NAMES.VACATIONS] = Dashboard_readIndexedRows_(SHEET_NAMES.VACATIONS, COL.VACATION.STUDENT_ID, studentIds);
  var eventRows = Dashboard_readIndexedRows_(SHEET_NAMES.EVENTS, COL.EVENT.STUDENT_ID, studentIds);
  context[SHEET_NAMES.LOGS] = EventRepository_toLegacyRows_(eventRows);
  context.__monthlySnapshotPartial = true;
  return context;
}

/** 조회 월이 생략된 직접 실행·초기 화면 호출은 한국 시간 기준 현재 월을 사용합니다. */
function Dashboard_resolveTargetYm_(targetYm) {
  var value = String(targetYm || "").trim();
  return value || Dashboard_defaultTargetYm_();
}

/** 설정된 당월 전환일 전까지는 전달을, 전환일부터는 당월을 사용합니다. */
function Dashboard_defaultTargetYm_() {
  return Dashboard_defaultTargetYmForDate_(new Date());
}

function Dashboard_defaultTargetYmForDate_(dateValue) {
  var date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (isNaN(date.getTime())) throw new Error("기본 조회 월 계산 날짜가 올바르지 않습니다.");
  var tz = Session.getScriptTimeZone();
  var localDate = Utilities.formatDate(date, tz, "yyyy-MM-dd");
  var parts = localDate.split("-");
  var year = Number(parts[0]);
  var month = Number(parts[1]);
  var day = Number(parts[2]);
  var cutoffDay = OperationalSettings_getNumber_("DASHBOARD_MONTH_CUTOFF_DAY", 10);
  if (day < cutoffDay) {
    month -= 1;
    if (month === 0) { year -= 1; month = 12; }
  }
  return year + "-" + (month < 10 ? "0" : "") + month;
}

/** Apps Script 실행 기록에서 대시보드 실패를 찾기 위한 구조화 로그입니다. */
function DashboardLog_failure_(targetYm, stage, error) {
  var diagnosticId = createUniqueId_("DASHERR");
  var email = "";
  try { email = getCurrentUserEmail_(); } catch (ignoredEmailError) {}
  var payload = {
    diagnosticId: diagnosticId,
    occurredAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss"),
    userEmail: email || "(확인 불가)",
    targetYm: String(targetYm || ""),
    stage: String(stage || "확인 불가"),
    errorName: error && error.name ? String(error.name) : "Error",
    errorMessage: error && error.message ? String(error.message) : String(error || ""),
    stack: error && error.stack ? String(error.stack) : ""
  };
  console.error("[수납 대시보드 조회 실패] " + JSON.stringify(payload));
  return diagnosticId;
}

/** 서버 조회 성공 후 브라우저에서 결과를 그리다 실패한 경우의 진단 로그입니다. */
function logDashboardClientFailure(stage, message, stack, targetYm) {
  requireAuthorizedUser_();
  var diagnosticId = createUniqueId_("DASHCLIENT");
  var payload = {
    diagnosticId: diagnosticId,
    occurredAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss"),
    userEmail: getCurrentUserEmail_() || "(확인 불가)",
    targetYm: String(targetYm || "").substring(0, 20),
    stage: String(stage || "브라우저 화면 처리").substring(0, 100),
    errorMessage: String(message || "알 수 없는 브라우저 오류").substring(0, 1000),
    stack: String(stack || "").substring(0, 4000)
  };
  console.error("[수납 대시보드 화면 처리 실패] " + JSON.stringify(payload));
  return diagnosticId;
}

/** 브라우저 왕복·화면 렌더 시간을 Apps Script 실행 로그에 남깁니다. */
function logDashboardClientPerformance(metrics) {
  requireAuthorizedUser_();
  metrics = metrics || {};
  var payload = {
    targetYm: String(metrics.targetYm || "").substring(0, 20),
    forceRefresh: !!metrics.forceRefresh,
    cacheHit: !!metrics.cacheHit,
    cacheReadStatus: String(metrics.cacheReadStatus || "").substring(0, 50),
    cacheWriteStatus: String(metrics.cacheWriteStatus || "").substring(0, 50),
    serverMs: Math.max(0, Number(metrics.serverMs) || 0),
    responseMs: Math.max(0, Number(metrics.responseMs) || 0),
    prepareMs: Math.max(0, Number(metrics.prepareMs) || 0),
    renderMs: Math.max(0, Number(metrics.renderMs) || 0),
    totalMs: Math.max(0, Number(metrics.totalMs) || 0),
    resultRows: Math.max(0, Number(metrics.resultRows) || 0),
    renderedRows: Math.max(0, Number(metrics.renderedRows) || 0),
    responseChars: Math.max(0, Number(metrics.responseChars) || 0)
  };
  console.log("[수납 대시보드 브라우저 성능] " + JSON.stringify(payload));
  return true;
}

/** google.script.run이 받을 수 있도록 Date를 날짜 문자열로 바꾸고 순수 배열·객체만 반환합니다. */
function Dashboard_toClientValue_(value) {
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? "" : Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  if (Array.isArray(value)) {
    return value.map(function(item) { return Dashboard_toClientValue_(item); });
  }
  if (value && typeof value === "object") {
    var result = {};
    Object.keys(value).forEach(function(key) {
      var item = value[key];
      if (typeof item !== "function" && typeof item !== "undefined") result[key] = Dashboard_toClientValue_(item);
    });
    return result;
  }
  return typeof value === "undefined" ? null : value;
}

function Dashboard_isRetiredCarryover_(snapshotStudent, previousMonthStart, monthEnd) {
  if (!snapshotStudent || !snapshotStudent.exitDate || !snapshotStudent.state) return false;
  return snapshotStudent.state.status === "퇴원" &&
    snapshotStudent.exitDate >= previousMonthStart && snapshotStudent.exitDate <= monthEnd;
}

/** 대시보드 화면이 실제 사용하는 수납 필드만 전달하여 통신량을 줄입니다. */
function Dashboard_compactDisplayEntries_(entries) {
  return (entries || []).map(function(item) {
    var compact = {
      payId: item.payId || "",
      date: item.date || "",
      fullDate: item.fullDate || "",
      month: item.month || "",
      amount: Number(item.amount) || 0,
      method: item.method || "",
      memo: item.memo || "",
      type: item.type || "수강료"
    };
    if (item.calcType) compact.calcType = item.calcType;
    if (item.isVirtual) compact.isVirtual = true;
    return compact;
  });
}

/** 승인 전 수납은 실제 수납 배열과 분리해 월별 반투명 예정 표시에만 사용합니다. */
function Dashboard_buildPendingPaymentMap_(rows) {
  var result = {};
  (rows || []).forEach(function(row) {
    row = row || [];
    if (String(row[IDX.REQUEST.CATEGORY] || "") !== UNIFIED_REQUEST_CATEGORY.PAYMENT ||
        String(row[IDX.REQUEST.STATUS] || "") !== PAYMENT_REQUEST_STATUS.PENDING) return;
    var request = UnifiedRequest_toObject_(row);
    var payment = UnifiedRequest_paymentView_(request);
    var studentId = String(request.targetId || "").trim();
    var month = String(payment.month || "").trim();
    if (!studentId || !/^\d{4}-\d{2}$/.test(month)) return;
    if (!result[studentId]) result[studentId] = {};
    if (!result[studentId][month]) result[studentId][month] = [];
    result[studentId][month].push({
      requestId:request.id,
      requestedAt:request.createdAt,
      payDate:String(payment.payDate || ""),
      month:month,
      type:String(payment.itemType || "수납"),
      amount:Number(payment.amount || 0),
      method:String(payment.method || ""),
      memo:String(payment.memo || ""),
      evidenceCount:Number(request.evidenceIds && request.evidenceIds.length || 0)
    });
  });
  Object.keys(result).forEach(function(studentId) {
    Object.keys(result[studentId]).forEach(function(month) {
      result[studentId][month].sort(function(a,b) {
        return String(a.requestedAt || a.requestId).localeCompare(String(b.requestedAt || b.requestId));
      });
    });
  });
  return result;
}

function Dashboard_pendingPaymentsFor_(pendingMap, studentId, month) {
  return pendingMap && pendingMap[studentId] && pendingMap[studentId][month]
    ? pendingMap[studentId][month].slice() : [];
}

function Dashboard_allPendingPaymentsFor_(pendingMap, studentId) {
  var byMonth = pendingMap && pendingMap[studentId] || {};
  var result = [];
  Object.keys(byMonth).sort().forEach(function(month) {
    (byMonth[month] || []).forEach(function(item) {
      var copy = {};
      Object.keys(item || {}).forEach(function(key) { copy[key] = item[key]; });
      copy.month = month;
      result.push(copy);
    });
  });
  return result;
}


/**
 * 📊 [대시보드] 데이터 조회 (형제 이름 매핑 & 퇴원생 로직 강화)
 */
function Dashboard_shiftMonth_(targetYm, offset) {
  var date = DateMoney_parseMonthStart(targetYm);
  date.setMonth(date.getMonth() + Number(offset || 0));
  return date.getFullYear() + "-" + ("0" + (date.getMonth() + 1)).slice(-2);
}

/**
 * 현재 조회 월이 미납일 때, 직전 월부터 같은 상태가 확실한 구간만 셉니다.
 * 시트 추가 조회 없이 월별 스냅샷의 결제·휴가·학생 이력을 재사용하므로 대시보드 속도에는 거의 영향을 주지 않습니다.
 */
function Dashboard_countConsecutiveUnpaidMonths_(snapshot, student, targetYm, currentStatus) {
  if (!snapshot || !student || currentStatus !== "미납" || student.specialOnly) return 0;
  var count = 1;
  var firstYm = student.firstDate ? fastFormatDate(student.firstDate, "yyyy-MM") : "";
  var paymentsByMonth = ((snapshot.paymentsByStudentMonth || {})[student.id] || {});
  var vacations = (snapshot.vacationsByStudent || {})[student.id] || [];
  var histories = snapshot.histories || {};

  // 지나치게 오래된 기록을 훑지 않도록 24개월에서 제한합니다. 표시는 실제 확인된 연속 개월 수만 사용합니다.
  for (var offset = 1; offset < 24; offset++) {
    var ym = Dashboard_shiftMonth_(targetYm, -offset);
    if (firstYm && ym < firstYm) break;
    var monthStart = DateMoney_parseMonthStart(ym);
    var monthLastDay = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
    var monthEnd = new Date(monthLastDay);
    monthEnd.setHours(23, 59, 59, 999);
    var state = resolveStudentStateAtDate_(student.row, histories, monthEnd);
    if (!state || state.status !== "재원" || Number(state.fee) <= 0 || isSpecialOnlyCourseMode_(state.courseMode)) break;

    // 일부라도 납부한 달은 '미납 연속'이 아니라 부분납 달이므로 여기서 끊습니다.
    var hasTuitionPayment = (paymentsByMonth[ym] || []).some(function(payment) {
      return Number(payment.amount) > 0 && isTuitionPaymentType_(payment.type);
    });
    if (hasTuitionPayment) break;

    // 한 달 전체가 휴원·퇴원공백이면 청구 대상 미납 월로 세지 않습니다.
    var fullyPaused = vacations.some(function(vacation) {
      return vacation.start <= monthStart && vacation.end >= monthLastDay;
    });
    if (fullyPaused) break;
    count++;
  }
  return count;
}

function Dashboard_getDataForHtml_(targetYm, options) {
  options = options || {};
  var startedAt = Date.now();
  var access = options.access || requireAuthorizedUser_();
  targetYm = Dashboard_resolveTargetYm_(targetYm);
  targetYm = requireMonthString_(targetYm, "조회 월");
  var cacheSignature = DashboardResultCache_signature_(targetYm);
  var cachedResult = options.context ? null : DashboardResultCache_get_(cacheSignature);
  if (cachedResult) {
    cachedResult.performance = {
      cacheHit: true,
      cacheReadStatus: DashboardResultCache_lastReadStatus_,
      cacheWriteStatus: "not_needed",
      serverMs: Date.now() - startedAt
    };
    return Dashboard_applyAccessScope_(cachedResult, access);
  }
  // 1. 날짜 계산 (최적화됨)
  var currDate = DateMoney_parseMonthStart(targetYm);
  var y = currDate.getFullYear();
  var m = currDate.getMonth(); 
  var viewWindowEnd = new Date(y, m + 2, 0); 
  var monthStart = new Date(y, m, 1);
  var previousMonthStart = new Date(y, m - 1, 1);
  var monthEnd = new Date(y, m + 1, 0); 
  var monthDays = monthEnd.getDate(); // 이번 달 총 일수

  // TimeZone 호출 최소화 (속도 향상)
  var tz = Session.getScriptTimeZone();
  var prevYm = Utilities.formatDate(new Date(y, m - 1, 1), tz, "yyyy-MM");
  var currYm = Utilities.formatDate(currDate, tz, "yyyy-MM");
  var nextYm = Utilities.formatDate(new Date(y, m + 1, 1), tz, "yyyy-MM");

  // 2. 수납 내역 매핑 (★ 캐시 사용 & 고속화 적용)
  var context = options.context || DataRepository_loadContext_([
    SHEET_NAMES.PAYMENTS, SHEET_NAMES.VACATIONS, SHEET_NAMES.STUDENTS, SHEET_NAMES.LOGS
  ], { required: false });
  var pendingRows = options.context
    ? (context[SHEET_NAMES.REQUESTS] || [])
    : UnifiedRequest_readPendingRows_();
  var pendingPaymentMap = Dashboard_buildPendingPaymentMap_(pendingRows);
  // 최초 원본 캐시 작성 과정에서 세대번호가 갱신될 수 있으므로,
  // 모든 원본을 읽은 시점을 완성 결과 캐시의 기준으로 삼습니다.
  var cacheSignatureAfterLoad = options.context ? cacheSignature : DashboardResultCache_signature_(targetYm);
  var monthlySnapshot = MonthlySnapshot_build_(currYm, context);
  var studentData = monthlySnapshot.studentRows;
  var vacMapByStudent = monthlySnapshot.vacationsByStudent;

  // 4. 학생 명단 스캔: 최종 데이터 조립
  var resultList = [];
  var teachers = new Set();

  for (var i = 1; i < studentData.length; i++) {
    var snapshotStudentId = String(studentData[i][IDX.STUDENT.ID] || "").trim();
    var snapshotStudent = monthlySnapshot.studentsById[snapshotStudentId];
    if (!snapshotStudent || snapshotStudent.excludedByEarlyExit) continue;
    // 퇴원 월이 바로 전달이면 미납 확인을 위해 유지하고, 그보다 이전 퇴원생만 제외합니다.
    // 다음 달 입학 예정자를 미리 보여주는 기존 동작도 유지합니다.
    if (!snapshotStudent.inMonth && snapshotStudent.exitDate && snapshotStudent.exitDate < previousMonthStart) continue;
    var resolvedState = snapshotStudent.state;
    var currentState = snapshotStudent.currentState;
    var status = resolvedState.status;
    
    // 재원/퇴원 모두 가져오되, HTML에서 필터링함
    if (status === "재원" || status === "퇴원") {
      
      // ============================================================
      // ★ [수정됨] 최초 등원일(F열) 강력 파싱 로직
      // (캐시된 문자열, 날짜 객체, 24.03.02 형식 모두 처리)
      // ============================================================
      var firstDateObj = snapshotStudent.firstDate;
      var firstDateYm = "";
      var firstDateFull = "";
      if (firstDateObj) {
        firstDateYm = fastFormatDate(firstDateObj, "yyyy-MM");
        var shortYear = firstDateObj.getFullYear() % 100;
        firstDateFull = shortYear + "년 " + (firstDateObj.getMonth() + 1) + "월 " + firstDateObj.getDate() + "일";
        if (firstDateObj > viewWindowEnd) continue;
      }
      // ===============================================================================

      var sId = String(studentData[i][IDX.STUDENT.ID]);
      var sName = studentData[i][IDX.STUDENT.NAME];
      var sGrade = studentData[i][IDX.STUDENT.GRADE];
      var sTeacher = resolvedState.teacher;
      var sTeacherId = resolvedState.teacherId;
      var sBaseDay = studentData[i][IDX.STUDENT.BASE_DAY] || 1;
      var sFee = snapshotStudent.baseFee;
      var sFamilyId = (studentData[i].length > IDX.STUDENT.FAMILY_ID) ? String(studentData[i][IDX.STUDENT.FAMILY_ID]).trim() : "";
      
      // 형제 설정 화면에서 저장한 그룹명을 그대로 전달합니다.
      var sFamilyName = (studentData[i].length > IDX.STUDENT.FAMILY_NAME)
        ? String(studentData[i][IDX.STUDENT.FAMILY_NAME] || "").trim()
        : "";
      var sSiblingDiscount = snapshotStudent.siblingDiscount;
      var sBillableFee = snapshotStudent.billableFee;
      var sCourseMode = snapshotStudent.courseMode;
      var isSpecialOnly = snapshotStudent.specialOnly;

      if (sTeacher) teachers.add(sTeacher);

      var prevPay = MonthlySnapshot_getDisplayEntries_(monthlySnapshot, sId, prevYm);
      var currPay = MonthlySnapshot_getDisplayEntries_(monthlySnapshot, sId, currYm);
      var nextPay = MonthlySnapshot_getDisplayEntries_(monthlySnapshot, sId, nextYm);
      
      // 납부 상태 판별
      var payStatus = "미납";
      if (!Array.isArray(currPay)) currPay = currPay.amount ? [currPay] : [];
      
      var hasVacation = currPay.some(function(p) { return p.type === "휴원"; });
      
      var hasPrev = Array.isArray(prevPay) ? prevPay.length > 0 : !!prevPay.amount;
      var hasCurr = Array.isArray(currPay) ? currPay.length > 0 : !!currPay.amount;
      var hasNext = Array.isArray(nextPay) ? nextPay.length > 0 : !!nextPay.amount;
      var hasPaymentInWindow = (hasPrev || hasCurr || hasNext);
      var retiredCarryover = Dashboard_isRetiredCarryover_(snapshotStudent, previousMonthStart, monthEnd);
      // ============================================================
      // ★ [최종 업그레이드] 신호등 로직 (휴가 일수 V 차감 적용)
      // 공식: (종료일 - 시작일 + 1 - 휴가일수) / N
      // ============================================================
      var validation = { level: 0, msg: "", diff: 0, expected: 0, real: 0 };
      
      // 1. N (분모) 설정
      var totalDaysN = monthlySnapshot.billingDays;

      // 2. M (시작일) & 종료일 설정 (날짜 객체 및 숫자 동시 관리)
      var startDayM = 1;
      var endDay = monthDays; 

      // 날짜 범위 계산용 (실제 달력 기준)
      var validStart = new Date(monthStart); validStart.setHours(0,0,0,0);
      var validEnd = new Date(monthEnd);     validEnd.setHours(0,0,0,0);

      // (1) 입학일 반영
      if (firstDateObj) {
         if (firstDateObj >= monthStart && firstDateObj <= monthEnd) {
            //  startDayM = firstDateObj.getDate();
             var fd = new Date(firstDateObj); fd.setHours(0,0,0,0);
             if (fd > validStart) validStart = fd;
         } else if (firstDateObj > monthEnd) {
             startDayM = 999; 
         }
      }

      // (2) 퇴원일 반영
      var sExitObj = snapshotStudent.exitDate;
      var exitDateYm = "";
      var exitDateFull = "-";
      if (sExitObj) {
        if (sExitObj >= monthStart && sExitObj <= monthEnd) {
          endDay = sExitObj.getDate();
          var ed = new Date(sExitObj); ed.setHours(0,0,0,0);
          if (ed < validEnd) validEnd = ed;
        } else if (sExitObj < monthStart) {
          endDay = 0;
        }
        exitDateYm = fastFormatDate(sExitObj, "yyyy-MM");
        var eShortYear = sExitObj.getFullYear() % 100;
        exitDateFull = eShortYear + "년 " + (sExitObj.getMonth() + 1) + "월 " + sExitObj.getDate() + "일";
      }
      // 입학·퇴원 이벤트, 일반휴가, 퇴원공백, 설정 기반 2월 기준일수 보정을 공통 월별 스냅샷에서
      // 한 번만 계산합니다. 화면에서 다시 휴가를 더하면 겹친 기간이 중복 차감될 수 있습니다.
      var activeDays = Math.max(0, Number(snapshotStudent.activeDays) || 0);

      // 만근 판단 (휴가 때문에 줄어들었어도 일할로 침)
      var isProRated = (activeDays < totalDaysN); 
      var tuitionEvaluation = PaymentDomain_evaluateMonthlyTuition_(snapshotStudent, currPay, {
        billingDays: totalDaysN
      });
      payStatus = tuitionEvaluation.status;
      validation = {
        level: tuitionEvaluation.warningLevel,
        msg: tuitionEvaluation.warningMessage,
        diff: tuitionEvaluation.received - tuitionEvaluation.expected,
        expected: tuitionEvaluation.expected,
        real: tuitionEvaluation.received,
        balance: tuitionEvaluation.balance,
        calculationSource: tuitionEvaluation.calculationSource,
        conflictingProration: tuitionEvaluation.conflictingProration
      };
      if (isSpecialOnly) {
        payStatus = "특강";
        validation = { level: 0, msg: "", diff: 0, expected: 0, real: 0, balance: 0, calculationSource: "특강전용" };
      }
      var unpaidStreak = Dashboard_countConsecutiveUnpaidMonths_(monthlySnapshot, snapshotStudent, currYm, payStatus);

      resultList.push({
        id: sId, name: sName, grade: sGrade, teacher: sTeacher, teacherId: sTeacherId,
        baseDay: sBaseDay, fee: sFee, billableFee: sBillableFee, siblingDiscount: sSiblingDiscount, familyId: sFamilyId,
        courseMode: sCourseMode, specialOnly: isSpecialOnly,
        vacationPeriods: (vacMapByStudent[sId] || []).map(function(vacation) {
          return {
            startDate: fastFormatDate(vacation.start, "yyyy-MM-dd"),
            endDate: fastFormatDate(vacation.end, "yyyy-MM-dd"),
            reason: String(vacation.reason || ""),
            periodType: String(vacation.periodType || VACATION_PERIOD_TYPES.VACATION)
          };
        }),
        relName: sFamilyName || "-", 
        firstDateYm: firstDateYm,     // ★ 복구됨
        firstDateFull: firstDateFull, // ★ 복구됨
        exitDateYm: exitDateYm,       
        exitDateFull: exitDateFull,
        status: payStatus, unpaidStreak: unpaidStreak, enrollment: status, paymentEligible: currentState.status === "재원",
        hasPaymentInWindow: hasPaymentInWindow, retiredCarryover: retiredCarryover,
        prev: Dashboard_compactDisplayEntries_(prevPay),
        curr: Dashboard_compactDisplayEntries_(currPay),
        next: Dashboard_compactDisplayEntries_(nextPay),
        pendingPayments: {
          prev: Dashboard_pendingPaymentsFor_(pendingPaymentMap, sId, prevYm),
          curr: Dashboard_pendingPaymentsFor_(pendingPaymentMap, sId, currYm),
          next: Dashboard_pendingPaymentsFor_(pendingPaymentMap, sId, nextYm),
          all: Dashboard_allPendingPaymentsFor_(pendingPaymentMap, sId)
        },

        validation: {
          level: validation.level,
          msg: validation.msg,
          diff: validation.diff,
          expected: validation.expected,
          real: validation.real
        }
      });
    }
  }

  var clientResult = Dashboard_toClientValue_({
    list: resultList,
    teachers: Array.from(teachers).sort(),
    months: { prev: prevYm, curr: currYm, next: nextYm }
  });
  // 원본을 모두 읽은 뒤 실제 데이터 세대가 다시 바뀌지 않았을 때만 저장합니다.
  // 원본 캐시 준비 중 발생한 세대 갱신은 새 서명으로 흡수하여 다음 조회부터 재사용합니다.
  var finalCacheSignature = options.context ? cacheSignature : DashboardResultCache_signature_(targetYm);
  if (!options.context && finalCacheSignature === cacheSignatureAfterLoad) {
    DashboardResultCache_put_(finalCacheSignature, clientResult);
    if (DashboardResultCache_lastWriteStatus_.indexOf("stored_") === 0 && cacheSignature !== finalCacheSignature) {
      DashboardResultCache_lastWriteStatus_ += "_after_source_refresh";
    }
  } else if (!options.context) {
    DashboardResultCache_lastWriteStatus_ = "generation_changed_after_load";
  }
  clientResult.performance = {
    cacheHit: false,
    cacheReadStatus: DashboardResultCache_lastReadStatus_,
    cacheWriteStatus: DashboardResultCache_lastWriteStatus_,
    monthlySnapshotStatus:monthlySnapshot.persistentSnapshotStatus || "unknown",
    serverMs: Date.now() - startedAt,
    partial: !!options.partial
  };
  return Dashboard_applyAccessScope_(clientResult, access);
}

/** 과거 공개 함수 호출 호환. 브라우저가 내부 access 객체를 주입하지 못하게 서버에서 다시 판정합니다. */
function getDashboardDataForHtml(targetYm) {
  return Dashboard_getDataForHtml_(targetYm, { access:requireManagerPermission_("PAYMENT_DASHBOARD") });
}

/** 하위관리자는 명시된 학생 범위(NONE/LINKED_TEACHER/ALL_STUDENTS)만 조회합니다. */
function Dashboard_applyAccessScope_(data, access) {
  var isSuperAdmin = !!(access && (access.bootstrap || access.role === ACCESS_CONTROL.ROLES.SUPER_ADMIN));
  var teacherId = String(access && access.teacherId || "").trim();
  var studentScope = AccessControl_getStudentScope_(access);
  var sourceList = data && Array.isArray(data.list) ? data.list : [];
  var scopedList = AccessControl_filterStudentList_(sourceList, access);
  var teacherMap = {};
  scopedList.forEach(function(student) {
    var name = String(student.teacher || "").trim();
    if (name) teacherMap[name] = true;
  });
  var result = {};
  Object.keys(data || {}).forEach(function(key) { result[key] = data[key]; });
  result.list = scopedList;
  result.teachers = Object.keys(teacherMap).sort();
  result.access = {
    isSuperAdmin: isSuperAdmin,
    canEdit: isSuperAdmin,
    canRequest: !isSuperAdmin && AccessControl_hasStudentDataAccess_(access),
    canCreateStudent: isSuperAdmin || (AccessControl_hasStudentDataAccess_(access) && AccessControl_hasPermission_(access, "STUDENT_ADD")),
    canCreatePayment: isSuperAdmin || (AccessControl_hasStudentDataAccess_(access) && AccessControl_hasPermission_(access, "PAYMENT_DASHBOARD")),
    canEditPayments: isSuperAdmin,
    teacherId: teacherId,
    scopeMode: studentScope
  };
  return result;
}
/* --------------------------------------------------------------------------------
   3. 수납 내역 수정/삭제 (최종: 복구 메시지 로직 완벽 부활)
   -------------------------------------------------------------------------------- */
