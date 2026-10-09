/** 최고관리자의 수납 요청 조회·증빙 확인·승인·반려를 담당합니다. */
function PaymentApproval_findRequest_(requestId, tx) {
  requestId = requireText_(requestId, "수납 요청 ID", 120);
  var found = UnifiedRequest_find_(requestId, tx);
  if (String(found.row[IDX.REQUEST.CATEGORY] || "") !== UNIFIED_REQUEST_CATEGORY.PAYMENT) {
    throw new Error("수납 요청이 아닌 작업 요청입니다.");
  }
  return found;
}

function PaymentApproval_parseEvidenceIds_(value) {
  var seen = {};
  return String(value || "").split(",").map(function(id) { return id.trim(); }).filter(function(id) {
    if (!id || seen[id]) return false;
    seen[id] = true;
    return true;
  });
}

/** 신규 요청은 제출 당시의 해시·크기·형식을 보존합니다. 과거 요청은 표식이 없으면 호환 처리합니다. */
function PaymentApproval_parseEvidenceIntegrity_(row, payload) {
  payload = payload || PaymentApproval_parsePayload_(row);
  var allowed = PaymentApproval_parseEvidenceIds_(row[IDX.REQUEST.EVIDENCE_IDS]);
  if (!Object.prototype.hasOwnProperty.call(payload, "evidenceIntegrity")) {
    return { legacy:true, allowedIds:allowed, byId:{} };
  }
  if (!Array.isArray(payload.evidenceIntegrity) || payload.evidenceIntegrity.length !== allowed.length) {
    throw new Error("수납 증빙 무결성 표식이 손상되어 확인할 수 없습니다.");
  }
  var allowedMap = {}, byId = {};
  allowed.forEach(function(id) { allowedMap[id] = true; });
  payload.evidenceIntegrity.forEach(function(item) {
    item = item || {};
    var fileId = String(item.fileId || "").trim();
    var mime = String(item.mimeType || "").trim().toLowerCase();
    var size = Number(item.size);
    var sha256 = String(item.sha256 || "").trim();
    if (!fileId || !allowedMap[fileId] || byId[fileId] ||
        ["image/jpeg", "image/png", "image/webp"].indexOf(mime) === -1 ||
        !Number.isFinite(size) || size <= 0 || size > PAYMENT_EVIDENCE_MAX_BYTES ||
        !/^[A-Za-z0-9_-]{43}$/.test(sha256)) {
      throw new Error("수납 증빙 무결성 표식이 손상되어 확인할 수 없습니다.");
    }
    byId[fileId] = { fileId:fileId, mimeType:mime, size:size, sha256:sha256 };
  });
  if (Object.keys(byId).length !== allowed.length) {
    throw new Error("수납 증빙 무결성 표식이 손상되어 확인할 수 없습니다.");
  }
  return { legacy:false, allowedIds:allowed, byId:byId };
}

function PaymentApproval_loadVerifiedEvidence_(row, fileId, payload) {
  fileId = requireText_(fileId, "증빙 파일 ID", 200);
  var integrity = PaymentApproval_parseEvidenceIntegrity_(row, payload);
  if (integrity.allowedIds.indexOf(fileId) === -1) throw new Error("이 수납 요청에 속하지 않은 증빙 파일입니다.");
  var file = DriveApp.getFileById(fileId);
  if (file.isTrashed()) throw new Error("증빙 파일이 휴지통에 있습니다.");
  var blob = file.getBlob();
  var mime = String(blob.getContentType() || "").toLowerCase();
  if (["image/jpeg", "image/png", "image/webp"].indexOf(mime) === -1) throw new Error("표시할 수 없는 증빙 형식입니다.");
  var bytes = blob.getBytes();
  if (!bytes.length || bytes.length > PAYMENT_EVIDENCE_MAX_BYTES) throw new Error("증빙 파일이 허용 크기를 초과했습니다.");
  if (!PaymentRequest_hasImageSignature_(bytes, mime)) throw new Error("증빙 파일 내용과 이미지 형식이 일치하지 않습니다.");
  if (!integrity.legacy) {
    var expected = integrity.byId[fileId];
    if (!expected || expected.mimeType !== mime || expected.size !== bytes.length ||
        expected.sha256 !== PaymentRequest_hashBytes_(bytes)) {
      throw new Error("증빙 파일이 제출 이후 변경되어 확인을 차단했습니다. 요청자에게 새 요청을 등록해달라고 안내해주세요.");
    }
  }
  return { file:file, blob:blob, bytes:bytes, mimeType:mime, legacy:integrity.legacy };
}

function PaymentApproval_verifyAllEvidence_(row, payload) {
  var integrity = PaymentApproval_parseEvidenceIntegrity_(row, payload);
  integrity.allowedIds.forEach(function(fileId) {
    PaymentApproval_loadVerifiedEvidence_(row, fileId, payload);
  });
  return { count:integrity.allowedIds.length, legacy:integrity.legacy,
    files:integrity.allowedIds.map(function(fileId) { return integrity.byId[fileId]; }).filter(Boolean) };
}

function PaymentApproval_parsePayload_(row) {
  var payload;
  try { payload = JSON.parse(String(row[IDX.REQUEST.PAYLOAD] || "")); }
  catch (error) { throw new Error("수납 요청의 저장 데이터가 손상되어 승인할 수 없습니다."); }
  if (!payload || !Array.isArray(payload.payments) || !payload.payments.length) {
    throw new Error("수납 요청의 저장 항목이 비어 있습니다.");
  }
  var requestId = String(row[IDX.REQUEST.ID] || "").trim();
  if (String(payload.requestId || "").trim() !== requestId) {
    throw new Error("수납 요청 ID와 저장 데이터의 요청 ID가 일치하지 않습니다.");
  }
  payload.returnSavedRows = true;
  return payload;
}

function PaymentApproval_validatePayloadAgainstRow_(payload, row) {
  var payment = payload.payments && payload.payments[0];
  var item = payment && payment.items && payment.items[0];
  if (payload.payments.length !== 1 || !payment || !Array.isArray(payment.items) || payment.items.length !== 1 || !item) {
    throw new Error("현재 승인 화면은 학생 1명·수납 항목 1개의 요청만 처리할 수 있습니다.");
  }
  var comparisons = [
    [String(payment.studentId || ""), String(row[IDX.REQUEST.TARGET_ID] || ""), "학생"],
    [String(payment.studentName || ""), String(row[IDX.REQUEST.TARGET_NAME] || ""), "학생명"],
    [requireDateString_(payload.payDate, "납부일"), formatDateOnly_(parseDateOnly_(row[IDX.REQUEST.EFFECTIVE_DATE])) || "", "납부일"]
  ];
  requireMonthString_(item.month, "귀속월");
  normalizePaymentType_(requireText_(item.type, "수납 항목", 30));
  requirePaymentMethod_(payload.payMethod);
  requireMoney_(item.amount, "수납 금액", 0, 100000000);
  comparisons.forEach(function(pair) {
    if (String(pair[0]) !== String(pair[1])) throw new Error("승인 표시값과 실제 저장 데이터의 " + pair[2] + "이(가) 일치하지 않습니다.");
  });
  return payload;
}

function PaymentApproval_toObject_(row) {
  var unified = UnifiedRequest_toObject_(row);
  if (unified.category !== UNIFIED_REQUEST_CATEGORY.PAYMENT) throw new Error("수납 요청 자료가 아닙니다.");
  var payment = UnifiedRequest_paymentView_(unified);
  var evidenceIds = unified.evidenceIds;
  var requesterEmail = unified.requesterEmail;
  return {
    requestId:unified.id, createdAt:unified.createdAt, status:unified.status,
    requestType:unified.type, studentId:unified.targetId, studentName:unified.targetName,
    payDate:payment.payDate, month:payment.month, itemType:payment.itemType,
    amount:payment.amount, method:payment.method, memo:payment.memo,
    requesterEmail:requesterEmail,
    requesterName:Management_getUserDisplayName_(requesterEmail) || unified.requesterName,
    reason:String(unified.payload.requestReason || ""),
    evidenceIds:evidenceIds,
    evidenceCount:evidenceIds.length
  };
}

function PaymentApproval_duplicateCandidateRows_(requests) {
  var sheet = DataRepository_getSheet_(SHEET_NAMES.PAYMENTS, false);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var studentIds = {};
  (requests || []).forEach(function(request) {
    var studentId = LookupIndex_normalizeKey_(request.studentId);
    if (studentId) studentIds[studentId] = true;
  });
  var index = LookupIndex_get_(SHEET_NAMES.PAYMENTS, COL.PAYMENT.STUDENT_ID, false);
  var rowNumbers = [];
  Object.keys(studentIds).forEach(function(studentId) {
    rowNumbers = rowNumbers.concat((index.map && index.map[studentId]) || []);
  });
  return LookupIndex_readRows_(sheet, rowNumbers).map(function(item) { return item.row; });
}

function PaymentApproval_duplicateWarningsFromRows_(requests, payments) {
  requests = requests || [];
  var warnings = {};
  if (!requests.length) return warnings;
  var wanted = {};
  function signature(studentId, month, itemType, amount, payDate) {
    return [String(studentId || ""), String(month || ""), normalizePaymentType_(itemType), Number(amount) || 0, String(payDate || "")].join("\u001f");
  }
  requests.forEach(function(request) {
    var key = signature(request.studentId, request.month, request.itemType, request.amount, request.payDate);
    if (!wanted[key]) wanted[key] = [];
    wanted[key].push(request.requestId);
  });
  var counts = {};
  payments = payments || [];
  for (var i = 0; i < payments.length; i++) {
    var row = payments[i];
    if (String(row[IDX.PAYMENT.RECORD_STATUS] || "ACTIVE") !== "ACTIVE") continue;
    var key = signature(row[IDX.PAYMENT.STUDENT_ID], MonthlySnapshot_monthString_(row[IDX.PAYMENT.MONTH]),
      row[IDX.PAYMENT.TYPE], row[IDX.PAYMENT.AMOUNT], formatDateOnly_(parseDateOnly_(row[IDX.PAYMENT.PAY_DATE])) || "");
    if (wanted[key]) counts[key] = (counts[key] || 0) + 1;
  }
  Object.keys(counts).forEach(function(key) {
    wanted[key].forEach(function(requestId) {
      warnings[requestId] = "같은 학생·귀속월·항목·금액·납부일의 기존 수납 " + counts[key] + "건이 있습니다.";
    });
  });
  return warnings;
}

function PaymentApproval_duplicateWarnings_(requests) {
  requests = requests || [];
  if (!requests.length) return {};
  return PaymentApproval_duplicateWarningsFromRows_(requests, PaymentApproval_duplicateCandidateRows_(requests));
}

function getPendingPaymentApprovalRequests() {
  requireSuperAdmin_();
  var requests = UnifiedRequest_readPendingRows_(true).filter(function(row) {
    return String(row[IDX.REQUEST.CATEGORY] || "") === UNIFIED_REQUEST_CATEGORY.PAYMENT;
  }).map(PaymentApproval_toObject_);
  var warnings = PaymentApproval_duplicateWarnings_(requests);
  requests.forEach(function(request) { request.duplicateWarning = warnings[request.requestId] || ""; });
  requests.sort(function(a, b) { return a.createdAt > b.createdAt ? 1 : -1; });
  return { count:requests.length, requests:requests };
}

function getPaymentApprovalEvidence(requestId, fileId) {
  requireSuperAdmin_();
  var found = PaymentApproval_findRequest_(requestId);
  var verified = PaymentApproval_loadVerifiedEvidence_(found.row, fileId);
  return {
    fileId:fileId,
    fileName:verified.file.getName(),
    mimeType:verified.mimeType,
    dataUrl:"data:" + verified.mimeType + ";base64," + Utilities.base64Encode(verified.bytes)
  };
}

function PaymentApproval_historyMemo_(request, decision, decisionMemo, payIds) {
  return JSON.stringify({
    requesterEmail:request.requesterEmail,
    requesterName:request.requesterName,
    studentName:request.studentName,
    payDate:request.payDate,
    month:request.month,
    itemType:request.itemType,
    amount:request.amount,
    method:request.method,
    requestReason:String(request.reason || "").substring(0, 160),
    decision:decision,
    decisionMemo:String(decisionMemo || "").substring(0, 200),
    evidenceIds:request.evidenceIds,
    payIds:payIds || []
  });
}

function approvePaymentApprovalRequest(requestId, decisionMemo, authenticatedUser) {
  // 밑줄이 없는 함수는 google.script.run에서 직접 호출할 수 있습니다. 내부 호출자가
  // 넘긴 객체를 신뢰하면 브라우저가 bootstrap/role 값을 위조해 승인할 수 있으므로
  // 공개 경계에서는 매번 현재 세션의 최고관리자 권한을 다시 확인합니다.
  var user = requireSuperAdmin_();
  decisionMemo = optionalText_(decisionMemo, 300);
  var result = MutationPipeline_run_({ operation:"수납요청승인", authorizedUser:user }, function(tx) {
    var found = PaymentApproval_findRequest_(requestId, tx);
    var row = found.row;
    if (String(row[IDX.REQUEST.STATUS] || "") !== PAYMENT_REQUEST_STATUS.PENDING) {
      throw new Error("승인 대기 상태인 요청만 승인할 수 있습니다.");
    }
    var request = PaymentApproval_toObject_(row);
    var payload = PaymentApproval_validatePayloadAgainstRow_(PaymentApproval_parsePayload_(row), row);
    var evidenceVerification = PaymentApproval_verifyAllEvidence_(row, payload);
    if (!evidenceVerification.legacy && evidenceVerification.files.length) {
      tx.queueEvent({
        eventType:"수납증빙무결성확인", targetType:"수납요청", targetId:request.requestId,
        studentId:request.studentId, field:"증빙 SHA-256", before:"제출", after:"승인 직전 일치",
        requestId:request.requestId, groupId:request.requestId,
        refId:evidenceVerification.files.map(function(item) { return item.fileId; }).join(","),
        memo:JSON.stringify({ algorithm:"SHA-256", files:evidenceVerification.files })
      });
    }
    var existing = Mutation_findCompletedRequest_(request.requestId);
    var normalizedPayload = existing ? PaymentLifecycle_normalizeRequestForRetry_(payload) : null;
    var paymentResult = existing
      ? PaymentLifecycle_assertSameCompletedRequest_(existing, normalizedPayload,
          PaymentLifecycle_requestFingerprint_(normalizedPayload))
      : PaymentLifecycle_createBatchInTransaction_(payload, tx, { skipCompletedCheck:true });
    var payIds = (paymentResult.savedRows || []).map(function(item) { return String(item.payId || ""); }).filter(Boolean);
    tx.queueEvent({
      eventType:"수납요청승인", targetType:"수납요청", targetId:request.requestId, studentId:request.studentId,
      field:"수납 승인", before:"승인대기", after:"승인완료", effectiveDate:request.payDate,
      requestId:request.requestId, groupId:request.requestId, refId:payIds.join(","),
      memo:PaymentApproval_historyMemo_(request, "APPROVED", decisionMemo, payIds)
    });
    var response = {
      requestId:request.requestId, status:PAYMENT_REQUEST_STATUS.APPROVED,
      studentId:request.studentId, studentName:request.studentName, payIds:payIds,
      paymentResult:paymentResult, processedBy:user.name || user.email
    };
    row[IDX.REQUEST.STATUS] = PAYMENT_REQUEST_STATUS.APPROVED;
    row[IDX.REQUEST.PROCESSED_AT] = new Date();
    row[IDX.REQUEST.PROCESSED_BY] = user.email;
    row[IDX.REQUEST.DECISION_MEMO] = safeSheetText_(decisionMemo || "", 500);
    row[IDX.REQUEST.RESULT] = JSON.stringify({ requestId:response.requestId, status:response.status,
      payIds:response.payIds, processedBy:response.processedBy });
    row[IDX.REQUEST.ERROR] = "";
    row[IDX.REQUEST.UPDATED_AT] = new Date();
    tx.writeRange(found.sheet, found.rowNumber, 1, [row]);
    tx.invalidate([SHEET_NAMES.REQUESTS, SHEET_NAMES.PAYMENTS, SHEET_NAMES.STUDENTS, SHEET_NAMES.EVENTS]);
    return response;
  });
  markRequestCompleted_(requestId, result.paymentResult || result);
  return result;
}

function rejectPaymentApprovalRequest(requestId, decisionMemo, authenticatedUser) {
  // 승인 함수와 마찬가지로 호출 인자의 사용자 객체는 권한 근거로 사용하지 않습니다.
  var user = requireSuperAdmin_();
  decisionMemo = optionalText_(decisionMemo, 300);
  return MutationPipeline_run_({ operation:"수납요청반려", authorizedUser:user }, function(tx) {
    var found = PaymentApproval_findRequest_(requestId, tx);
    var row = found.row;
    if (String(row[IDX.REQUEST.STATUS] || "") !== PAYMENT_REQUEST_STATUS.PENDING) {
      throw new Error("승인 대기 상태인 요청만 반려할 수 있습니다.");
    }
    var request = PaymentApproval_toObject_(row);
    tx.queueEvent({
      eventType:"수납요청반려", targetType:"수납요청", targetId:request.requestId, studentId:request.studentId,
      field:"수납 승인", before:"승인대기", after:"반려", effectiveDate:request.payDate,
      requestId:request.requestId, groupId:request.requestId, refId:request.evidenceIds.join(","),
      memo:PaymentApproval_historyMemo_(request, "REJECTED", decisionMemo, [])
    });
    var response = {
      requestId:request.requestId, status:PAYMENT_REQUEST_STATUS.REJECTED,
      studentId:request.studentId, studentName:request.studentName,
      processedBy:user.name || user.email
    };
    row[IDX.REQUEST.STATUS] = PAYMENT_REQUEST_STATUS.REJECTED;
    row[IDX.REQUEST.PROCESSED_AT] = new Date();
    row[IDX.REQUEST.PROCESSED_BY] = user.email;
    row[IDX.REQUEST.DECISION_MEMO] = safeSheetText_(decisionMemo, 500);
    row[IDX.REQUEST.RESULT] = safeSheetText_(JSON.stringify(response), 2000);
    row[IDX.REQUEST.ERROR] = "";
    row[IDX.REQUEST.UPDATED_AT] = new Date();
    tx.writeRange(found.sheet, found.rowNumber, 1, [row]);
    tx.invalidate([SHEET_NAMES.REQUESTS, SHEET_NAMES.EVENTS]);
    return response;
  });
}
