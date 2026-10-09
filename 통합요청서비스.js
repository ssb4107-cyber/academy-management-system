/** 수납·학생·휴가·형제 요청의 공통 인덱스와 통합 요청함 */
var UNIFIED_REQUEST_CATEGORY = { PAYMENT:"PAYMENT", CHANGE:"CHANGE" };
var UNIFIED_REQUEST_RECONCILE_PROPERTY = "UNIFIED_REQUEST_RECONCILE_NEEDED";
var UNIFIED_REQUEST_NATIVE_COMPLETION_PREFIX = "UNIFIED_REQUEST_NATIVE_DONE_";

function UnifiedRequest_markReconcileNeeded_() {
  try { PropertiesService.getScriptProperties().setProperty(UNIFIED_REQUEST_RECONCILE_PROPERTY, "1"); }
  catch (error) { logError_("통합요청 대조 예약", error); }
}

function UnifiedRequest_nativeCompletionKey_(requestId) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(requestId || ""));
  return UNIFIED_REQUEST_NATIVE_COMPLETION_PREFIX + Utilities.base64EncodeWebSafe(digest).replace(/=+$/, "").substring(0, 40);
}

function UnifiedRequest_nativeRequestFingerprint_(request) {
  request = request || {};
  return ChangeRequest_fingerprint_({
    id:String(request.id || ""),
    category:String(request.category || ""),
    type:String(request.type || ""),
    targetId:String(request.targetId || ""),
    targetName:String(request.targetName || ""),
    summary:String(request.summary || ""),
    payloadText:String(request.payloadText || ""),
    requesterEmail:String(request.requesterEmail || "").trim().toLowerCase(),
    requesterName:String(request.requesterName || ""),
    sourceSheet:String(request.sourceSheet || ""),
    sourceId:String(request.sourceId || ""),
    effectiveDate:String(request.effectiveDate || "")
  });
}

function UnifiedRequest_nativeCompletionBinding_(completion, request) {
  if (!completion || !String(completion.requestFingerprint || "")) {
    return { matches:false, reason:"완료 표식에 요청 지문이 없습니다." };
  }
  var currentFingerprint = UnifiedRequest_nativeRequestFingerprint_(request);
  return {
    matches:String(completion.requestFingerprint) === currentFingerprint,
    reason:String(completion.requestFingerprint) === currentFingerprint ? "" : "완료 표식과 현재 요청 원문이 다릅니다.",
    currentFingerprint:currentFingerprint
  };
}

function UnifiedRequest_storeNativeCompletion_(requestId, resultText, processedBy, decisionMemo, requestFingerprint) {
  var record = { requestId:String(requestId || ""), result:String(resultText || "").substring(0, 2000),
    processedBy:String(processedBy || ""), decisionMemo:String(decisionMemo || "").substring(0, 500),
    requestFingerprint:requireText_(requestFingerprint, "요청 지문", 200), completedAt:new Date().toISOString() };
  PropertiesService.getScriptProperties().setProperty(UnifiedRequest_nativeCompletionKey_(requestId), JSON.stringify(record));
  return record;
}

function UnifiedRequest_getNativeCompletion_(requestId) {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(UnifiedRequest_nativeCompletionKey_(requestId));
    if (!raw) return null;
    var record = JSON.parse(raw);
    return String(record.requestId || "") === String(requestId || "") ? record : null;
  } catch (error) { logError_("통합 작업요청 완료표식 조회 " + requestId, error); return null; }
}

function UnifiedRequest_clearNativeCompletion_(requestId) {
  try { PropertiesService.getScriptProperties().deleteProperty(UnifiedRequest_nativeCompletionKey_(requestId)); }
  catch (error) { logError_("통합 작업요청 완료표식 정리 " + requestId, error); }
}

function UnifiedRequest_buildRow_(data) {
  data = data || {};
  return [
    requireText_(data.id, "요청 ID", 120), data.createdAt || new Date(),
    requireText_(data.category, "요청 분류", 20), requireText_(data.type, "요청 유형", 50),
    String(data.status || "PENDING"), optionalText_(data.targetId, 120), safeSheetText_(data.targetName, 80),
    safeSheetText_(data.summary, 500), safeSheetText_(typeof data.payload === "string" ? data.payload : JSON.stringify(data.payload || {}), 45000),
    String(data.requesterEmail || "").trim().toLowerCase(), safeSheetText_(data.requesterName, 80),
    optionalText_(data.evidenceIds, 1000), optionalText_(data.sourceSheet, 100), optionalText_(data.sourceId || data.id, 120),
    data.effectiveDate || "", data.processedAt || "", optionalText_(data.processedBy, 120),
    safeSheetText_(data.decisionMemo, 500), safeSheetText_(data.result, 2000), safeSheetText_(data.error, 2000),
    new Date(), "1"
  ];
}

function UnifiedRequest_append_(tx, data) {
  var sheet = DataSchema_ensureSheet_(SHEET_NAMES.REQUESTS, tx).sheet;
  var id = String(data && data.id || "").trim();
  if (!id) throw new Error("통합 요청 ID가 비어 있습니다.");
  if (sheet.getLastRow() > 1) {
    var ids = sheet.getRange(2, COL.REQUEST.ID, sheet.getLastRow() - 1, 1).getDisplayValues();
    for (var i = 0; i < ids.length; i++) if (String(ids[i][0] || "") === id) return { duplicate:true, rowNumber:i + 2 };
  }
  var appended = tx.appendRows(sheet, [UnifiedRequest_buildRow_(data)]);
  tx.invalidate([SHEET_NAMES.REQUESTS]);
  return { duplicate:false, rowNumber:appended.startRow };
}

function UnifiedRequest_toObject_(row) {
  var payloadText = String(row[IDX.REQUEST.PAYLOAD] || "");
  var payload = {};
  try { payload = JSON.parse(payloadText || "{}"); } catch (ignoredPayload) {}
  return {
    id:String(row[IDX.REQUEST.ID] || ""), createdAt:Management_formatTimestamp_(row[IDX.REQUEST.CREATED_AT]),
    category:String(row[IDX.REQUEST.CATEGORY] || ""), type:String(row[IDX.REQUEST.TYPE] || ""),
    status:String(row[IDX.REQUEST.STATUS] || ""), targetId:String(row[IDX.REQUEST.TARGET_ID] || ""),
    targetName:String(row[IDX.REQUEST.TARGET_NAME] || ""), summary:String(row[IDX.REQUEST.SUMMARY] || ""),
    payloadText:payloadText, payload:payload, requesterEmail:String(row[IDX.REQUEST.REQUESTER_EMAIL] || ""),
    requesterName:String(row[IDX.REQUEST.REQUESTER_NAME] || ""),
    evidenceIds:String(row[IDX.REQUEST.EVIDENCE_IDS] || "").split(",").map(function(v){return v.trim();}).filter(Boolean),
    sourceSheet:String(row[IDX.REQUEST.SOURCE_SHEET] || ""), sourceId:String(row[IDX.REQUEST.SOURCE_ID] || ""),
    effectiveDate:formatDateOnly_(parseDateOnly_(row[IDX.REQUEST.EFFECTIVE_DATE])) || String(row[IDX.REQUEST.EFFECTIVE_DATE] || ""),
    processedAt:Management_formatTimestamp_(row[IDX.REQUEST.PROCESSED_AT]), processedBy:String(row[IDX.REQUEST.PROCESSED_BY] || ""),
    decisionMemo:String(row[IDX.REQUEST.DECISION_MEMO] || ""), result:String(row[IDX.REQUEST.RESULT] || ""),
    error:String(row[IDX.REQUEST.ERROR] || "")
  };
}

/** 학생·휴가·형제 작업 요청은 출처 표기가 과거 값이어도 DB_요청 행을 단일 원본으로 처리합니다. */
function UnifiedRequest_isNativeChange_(request) {
  return !!request && request.category === UNIFIED_REQUEST_CATEGORY.CHANGE;
}

function UnifiedRequest_find_(requestId, tx) {
  requestId = requireText_(requestId, "요청 ID", 120);
  var sheet = DataSchema_ensureSheet_(SHEET_NAMES.REQUESTS, tx).sheet;
  if (sheet.getLastRow() < 2) throw new Error("요청을 찾을 수 없습니다.");
  var found = LookupIndex_findRows_(SHEET_NAMES.REQUESTS, COL.REQUEST.ID, requestId, false);
  if (!found.length) found = LookupIndex_findRows_(SHEET_NAMES.REQUESTS, COL.REQUEST.ID, requestId, true);
  found = found.filter(function(item) { return String(item.row[IDX.REQUEST.ID] || "") === requestId; })
    .map(function(item) { return { sheet:sheet, row:item.row, rowNumber:item.rowNumber }; });
  if (found.length !== 1) throw new Error(found.length ? "동일 요청 ID가 중복되어 있습니다." : "요청을 찾을 수 없습니다.");
  return found[0];
}

/** 누적 완료 이력은 읽지 않고 승인 대기 행만 상태 인덱스로 가져옵니다. */
function UnifiedRequest_readPendingRows_(forceRebuild) {
  var sheet = DataRepository_getSheet_(SHEET_NAMES.REQUESTS, false);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return LookupIndex_findRows_(SHEET_NAMES.REQUESTS, COL.REQUEST.STATUS, "PENDING", !!forceRebuild)
    .filter(function(item) { return String(item.row[IDX.REQUEST.STATUS] || "") === "PENDING"; })
    .map(function(item) { return item.row; });
}

function UnifiedRequest_updateStatus_(requestId, status, fields, allowManager) {
  fields = fields || {};
  return MutationPipeline_run_({ operation:"통합요청 상태변경", allowManagerPortal:!!allowManager }, function(tx) {
    var found = UnifiedRequest_find_(requestId, tx);
    if (fields.fromStatuses && fields.fromStatuses.indexOf(String(found.row[IDX.REQUEST.STATUS] || "")) === -1) {
      throw new Error("현재 상태에서는 처리할 수 없습니다: " + found.row[IDX.REQUEST.STATUS]);
    }
    found.row[IDX.REQUEST.STATUS] = status;
    found.row[IDX.REQUEST.PROCESSED_AT] = fields.processedAt === false ? "" : (fields.processedAt || new Date());
    found.row[IDX.REQUEST.PROCESSED_BY] = fields.processedBy || getCurrentUserEmail_();
    found.row[IDX.REQUEST.DECISION_MEMO] = safeSheetText_(fields.decisionMemo || "", 500);
    found.row[IDX.REQUEST.RESULT] = safeSheetText_(fields.result || "", 2000);
    found.row[IDX.REQUEST.ERROR] = safeSheetText_(fields.error || "", 2000);
    found.row[IDX.REQUEST.UPDATED_AT] = new Date();
    tx.writeRange(found.sheet, found.rowNumber, 1, [found.row]);
    tx.invalidate([SHEET_NAMES.REQUESTS]);
    return UnifiedRequest_toObject_(found.row);
  });
}

function initializeUnifiedRequests() {
  requireSuperAdmin_();
  var result = DataSchema_ensureSheet_(SHEET_NAMES.REQUESTS);
  return { singleSource:true, sheetName:SHEET_NAMES.REQUESTS, created:result.created };
}

function UnifiedRequest_ensureInitialized_() {
  return DataSchema_ensureSheet_(SHEET_NAMES.REQUESTS).sheet;
}

function UnifiedRequest_paymentView_(request) {
  var payload = request.payload || {}, payment = payload.payments && payload.payments[0] || {}, item = payment.items && payment.items[0] || {};
  return {
    payDate:String(payload.payDate || request.effectiveDate || ""), month:String(item.month || ""), itemType:String(item.type || request.type || "수납"),
    amount:Number(item.amount || 0), method:String(payload.payMethod || ""), memo:String(item.memo || ""), evidenceCount:request.evidenceIds.length
  };
}

/** 작업 요청 적용 후 최종 상태 기록이 실패한 경우만 완료표식으로 복구합니다. */
function UnifiedRequest_reconcilePending_() {
  requireSuperAdmin_();
  var reconciliation = MutationPipeline_run_({ operation:"통합요청 상태 대조" }, function(tx) {
    var requestSheet = DataSchema_ensureSheet_(SHEET_NAMES.REQUESTS, tx).sheet;
    if (requestSheet.getLastRow() < 2) return { reconciled:0 };
    var processingRows = LookupIndex_findRows_(SHEET_NAMES.REQUESTS, COL.REQUEST.STATUS, "PROCESSING", true);
    var changed = 0, now = new Date(), nativeCompletionIds = [], blocked = [];
    processingRows.forEach(function(item) {
      var row = item.row;
      var currentStatus = String(row[IDX.REQUEST.STATUS] || "");
      var nativeRequestId = String(row[IDX.REQUEST.ID] || "");
      if (currentStatus === "PROCESSING" && String(row[IDX.REQUEST.CATEGORY] || "") === UNIFIED_REQUEST_CATEGORY.CHANGE &&
          (!String(row[IDX.REQUEST.SOURCE_SHEET] || "") || String(row[IDX.REQUEST.SOURCE_SHEET] || "") === SHEET_NAMES.REQUESTS)) {
        var completion = UnifiedRequest_getNativeCompletion_(nativeRequestId);
        if (!completion) return;
        var binding = UnifiedRequest_nativeCompletionBinding_(completion, UnifiedRequest_toObject_(row));
        if (!binding.matches) {
          blocked.push({ requestId:nativeRequestId, reason:binding.reason });
          return;
        }
        row[IDX.REQUEST.STATUS] = "APPROVED"; row[IDX.REQUEST.PROCESSED_AT] = completion.completedAt ? new Date(completion.completedAt) : now;
        row[IDX.REQUEST.PROCESSED_BY] = completion.processedBy || ""; row[IDX.REQUEST.DECISION_MEMO] = completion.decisionMemo || "";
        row[IDX.REQUEST.RESULT] = completion.result || ""; row[IDX.REQUEST.ERROR] = ""; row[IDX.REQUEST.UPDATED_AT] = now;
        tx.writeRange(requestSheet, item.rowNumber, 1, [row]);
        nativeCompletionIds.push(nativeRequestId); changed++;
      }
    });
    tx.invalidate([SHEET_NAMES.REQUESTS]);
    return { reconciled:changed, nativeCompletionIds:nativeCompletionIds, blocked:blocked };
  });
  (reconciliation.nativeCompletionIds || []).forEach(UnifiedRequest_clearNativeCompletion_);
  return { reconciled:reconciliation.reconciled, blocked:reconciliation.blocked || [] };
}

function UnifiedRequest_finalizeAfterDispatch_(requestId, status, fields) {
  try { UnifiedRequest_updateStatus_(requestId, status, fields, false); return true; }
  catch (syncError) {
    // 원본 처리가 끝난 뒤의 보조 기록 실패이므로 사용자에게 실제 처리를 실패로 알리지 않습니다.
    // 다음 요청함 상세 조회에서 UnifiedRequest_reconcilePending_이 원본을 기준으로 복구합니다.
    logError_("통합요청 최종상태 동기화 " + requestId, syncError);
    UnifiedRequest_markReconcileNeeded_();
    return false;
  }
}

function UnifiedRequest_reconcileIfNeeded_() {
  var properties = PropertiesService.getScriptProperties();
  if (properties.getProperty(UNIFIED_REQUEST_RECONCILE_PROPERTY) !== "1") return { reconciled:0, skipped:true };
  var result = UnifiedRequest_reconcilePending_();
  if (!(result.blocked || []).length) properties.deleteProperty(UNIFIED_REQUEST_RECONCILE_PROPERTY);
  return result;
}

function getUnifiedAdminRequestInbox() {
  requireSuperAdmin_(); UnifiedRequest_ensureInitialized_(); UnifiedRequest_reconcileIfNeeded_();
  var requests = UnifiedRequest_readPendingRows_().map(UnifiedRequest_toObject_);
  if (!requests.length) return { count:0, counts:{ total:0, payment:0, change:0 }, requests:[] };
  var requestPermissionByType = { STUDENT_CREATE:"STUDENT_ADD", STUDENT_UPDATE:"STUDENT_EDIT",
    VACATION_CREATE:"STUDENT_VACATION", VACATION_UPDATE:"STUDENT_VACATION", VACATION_DELETE:"STUDENT_VACATION",
    SIBLING_DISCOUNT:"SIBLING_MANAGER", SIBLING_GROUP:"SIBLING_MANAGER" };
  var requesterRows = {};
  DataRepository_getRows_(SHEET_NAMES.USERS, { required:false, fresh:true, cache:false }).slice(1).forEach(function(row) {
    var email = String(row[IDX.USER.EMAIL] || "").trim().toLowerCase();
    if (!requesterRows[email]) requesterRows[email] = [];
    requesterRows[email].push(row);
  });
  requests.forEach(function(request) {
    var email = String(request.requesterEmail || "").trim().toLowerCase();
    if (ACCESS_CONTROL.ADMIN_EMAILS.indexOf(email) !== -1) return;
    var matches = requesterRows[email] || [];
    if (matches.length !== 1) { request.accessWarning = matches.length ? "요청자 계정이 중복 등록되어 현재 로그인이 차단된 상태입니다." : "요청자 계정이 현재 사용자 목록에 없습니다."; return; }
    if (!Management_toBoolean_(matches[0][IDX.USER.ACTIVE])) { request.accessWarning = "요청자 계정이 현재 비활성 상태입니다."; return; }
    var expectedPermission = request.category === UNIFIED_REQUEST_CATEGORY.PAYMENT ? "PAYMENT_DASHBOARD" : requestPermissionByType[request.type];
    if (String(matches[0][IDX.USER.ROLE] || "") === ACCESS_CONTROL.ROLES.MANAGER && expectedPermission &&
        AccessControl_normalizePermissions_(matches[0][IDX.USER.PERMISSIONS]).indexOf(expectedPermission) === -1) {
      request.accessWarning = "요청 후 해당 메뉴 권한이 해제되었습니다. 승인 전에 내용을 다시 확인해주세요.";
    }
  });
  var teacherLookup = null;
  requests.forEach(function(request) {
    if (request.category !== UNIFIED_REQUEST_CATEGORY.CHANGE || !request.payload || !request.payload.teacherId) return;
    if (!teacherLookup) teacherLookup = TeacherDirectory_buildLookup_();
    var teacher = teacherLookup.byId[String(request.payload.teacherId)] || null;
    request.displayValues = request.displayValues || {};
    request.displayValues.teacherId = teacher ? teacher.name : "등록되지 않은 원장";
  });
  requests.forEach(function(r){ if (r.category === UNIFIED_REQUEST_CATEGORY.PAYMENT) r.payment = UnifiedRequest_paymentView_(r); });
  var paymentRequests = requests.filter(function(r){return r.category === UNIFIED_REQUEST_CATEGORY.PAYMENT;}).map(function(r){
    return { requestId:r.id, studentId:r.targetId, payDate:r.payment.payDate, month:r.payment.month,
      itemType:r.payment.itemType, amount:r.payment.amount };
  });
  var duplicateWarnings = PaymentApproval_duplicateWarnings_(paymentRequests);
  requests.forEach(function(r){if(r.payment)r.duplicateWarning=duplicateWarnings[r.id]||"";});
  requests.sort(function(a,b){return a.createdAt > b.createdAt ? 1 : -1;});
  var counts = { total:requests.length, payment:0, change:0 };
  requests.forEach(function(r){if(r.category===UNIFIED_REQUEST_CATEGORY.PAYMENT)counts.payment++;else counts.change++;});
  // 요청함은 열었을 때만 상세 목록을 읽으므로, 임의로 100건을 잘라
  // 화면의 건수와 실제 처리 가능한 카드 수가 달라지지 않게 모두 전달합니다.
  return { count:requests.length, counts:counts, requests:requests };
}

function getUnifiedRequestSummary() {
  requireSuperAdmin_();
  return UnifiedRequest_getSummary_();
}

function UnifiedRequest_getSummary_() {
  UnifiedRequest_ensureInitialized_();
  var signature = QueryResultCache_signature_("UNIFIED_REQUEST_SUMMARY_V1", "PENDING", [SHEET_NAMES.REQUESTS]);
  var cached = QueryResultCache_get_(signature, { maxChunks:2 });
  if (cached && typeof cached.total === "number") return cached;
  var counts = { total:0, payment:0, change:0 };
  UnifiedRequest_readPendingRows_().forEach(function(row){counts.total++;if(String(row[IDX.REQUEST.CATEGORY])===UNIFIED_REQUEST_CATEGORY.PAYMENT)counts.payment++;else counts.change++;});
  QueryResultCache_put_(signature, counts, 300, { maxChunks:2 });
  return counts;
}

function approveUnifiedRequest(requestId, memo) {
  var user = requireSuperAdmin_(); UnifiedRequest_ensureInitialized_();
  var found = UnifiedRequest_find_(requestId), request = UnifiedRequest_toObject_(found.row), result;
  if (UnifiedRequest_isNativeChange_(request)) {
    var nativeResult = UnifiedRequest_approveNativeChange_(request.id, memo || "");
    result = nativeResult.result;
    return { request:request, result:result, status:"APPROVED", syncPending:!!nativeResult.syncPending,
      studentId:(result && result.studentId) || request.targetId, studentName:(result && result.studentName) || request.targetName };
  }
  result = approvePaymentApprovalRequest(request.id, memo || "", user);
  return { request:request, result:result, status:"APPROVED", syncPending:false,
    studentId:(result && result.studentId) || request.targetId, studentName:(result && result.studentName) || request.targetName };
}

function rejectUnifiedRequest(requestId, memo) {
  var user = requireSuperAdmin_(); memo = optionalText_(memo, 500); UnifiedRequest_ensureInitialized_();
  var found = UnifiedRequest_find_(requestId), request = UnifiedRequest_toObject_(found.row), result;
  if (UnifiedRequest_isNativeChange_(request)) {
    UnifiedRequest_updateStatus_(request.id, "REJECTED", { fromStatuses:["PENDING"], decisionMemo:memo }, false);
    return { request:request, result:{ requestId:request.id, status:"REJECTED" }, status:"REJECTED", syncPending:false };
  }
  result = rejectPaymentApprovalRequest(request.id, memo, user);
  return { request:request, result:result, status:"REJECTED", syncPending:false };
}

function UnifiedRequest_approveNativeChange_(requestId, memo) {
  var claimed = UnifiedRequest_updateStatus_(requestId, "PROCESSING", {
    fromStatuses:["PENDING"], processedAt:false, decisionMemo:memo || ""
  }, false);
  var payload;
  try {
    payload = JSON.parse(String(claimed.payloadText || "{}"));
  } catch (parseError) {
    UnifiedRequest_updateStatus_(requestId, "ERROR", { fromStatuses:["PROCESSING"], decisionMemo:memo || "", error:"요청원문 손상" }, false);
    throw new Error("요청원문이 손상되었습니다.");
  }
  var applied;
  try {
    ChangeRequest_validateSnapshot_(payload);
    applied = ChangeRequest_dispatch_(claimed.type, payload);
  } catch (error) {
    UnifiedRequest_updateStatus_(requestId, "ERROR", { fromStatuses:["PROCESSING"], decisionMemo:memo || "",
      error:error && error.message ? error.message : String(error) }, false);
    throw error;
  }
  var resultText = typeof applied === "string" ? applied : JSON.stringify(applied || {});
  var requestFingerprint = UnifiedRequest_nativeRequestFingerprint_(claimed);
  try { UnifiedRequest_storeNativeCompletion_(requestId, resultText, getCurrentUserEmail_(), memo || "", requestFingerprint); }
  catch (markerError) { logError_("통합 작업요청 완료표식 저장 " + requestId, markerError); }
  var synced = UnifiedRequest_finalizeAfterDispatch_(requestId, "APPROVED", {
    fromStatuses:["PROCESSING"], decisionMemo:memo || "", result:resultText
  });
  if (synced) UnifiedRequest_clearNativeCompletion_(requestId);
  return { result:applied, syncPending:!synced };
}

function UnifiedRequest_cancelOwnNativeChange_(requestId, user) {
  return MutationPipeline_run_({ operation:"본인 통합 작업요청 취소", allowManagerPortal:true, authorizedUser:user }, function(tx) {
    var found = UnifiedRequest_find_(requestId, tx);
    var request = UnifiedRequest_toObject_(found.row);
    if (!UnifiedRequest_isNativeChange_(request)) throw new Error("통합 작업 요청이 아닙니다.");
    if (request.requesterEmail.trim().toLowerCase() !== user.email) throw new Error("본인이 등록한 요청만 취소할 수 있습니다.");
    if (request.status !== "PENDING") throw new Error("승인 대기 중인 요청만 취소할 수 있습니다.");
    found.row[IDX.REQUEST.STATUS] = "CANCELLED";
    found.row[IDX.REQUEST.PROCESSED_AT] = new Date();
    found.row[IDX.REQUEST.PROCESSED_BY] = user.email;
    found.row[IDX.REQUEST.DECISION_MEMO] = "요청자가 직접 취소했습니다.";
    found.row[IDX.REQUEST.RESULT] = "";
    found.row[IDX.REQUEST.ERROR] = "";
    found.row[IDX.REQUEST.UPDATED_AT] = new Date();
    tx.writeRange(found.sheet, found.rowNumber, 1, [found.row]);
    tx.queueEvent({ eventType:"작업요청취소", targetType:"작업요청", targetId:requestId,
      studentId:request.targetId, field:request.type || "작업 요청", before:"승인대기", after:"요청취소",
      requestId:requestId, memo:"요청자가 승인 전에 직접 취소" });
    tx.invalidate([SHEET_NAMES.REQUESTS, SHEET_NAMES.EVENTS]);
    return { requestId:requestId, category:"작업", status:"CANCELLED" };
  });
}
