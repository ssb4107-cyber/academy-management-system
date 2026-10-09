/** 일반 원장용 담당 학생 조회와 수납 승인 요청 서비스입니다. */
var PAYMENT_REQUEST_STATUS = { PENDING:"PENDING", APPROVED:"APPROVED", REJECTED:"REJECTED", CANCELLED:"CANCELLED" };
var PAYMENT_EVIDENCE_FOLDER_PROPERTY = "PAYMENT_EVIDENCE_FOLDER_ID";
var PAYMENT_EVIDENCE_FOLDER_ID = "1BK0r3Eo_uGp1wm4ZzOh6QbmIY1zcoW3A";
var PAYMENT_EVIDENCE_PARENT_FOLDER_ID = "13bqUv5R5Dh7uPJQuuRmUFLKgMI7z-UmZ";
var PAYMENT_EVIDENCE_MAX_FILES = 3;
var PAYMENT_EVIDENCE_MAX_BYTES = 2 * 1024 * 1024;
var PAYMENT_EVIDENCE_MAX_BASE64_CHARS = Math.ceil(PAYMENT_EVIDENCE_MAX_BYTES * 4 / 3) + 16;
var PAYMENT_EVIDENCE_MANAGER_CACHE_PREFIX = "PAYMENT_EVIDENCE_MANAGER_V1_";
var PAYMENT_EVIDENCE_MONTH_CACHE_PREFIX = "PAYMENT_EVIDENCE_MONTH_V1_";
var PAYMENT_EVIDENCE_ROOT_SECURITY_PROPERTY = "PAYMENT_EVIDENCE_ROOT_SECURITY_V2";

function ManagerPortal_isSuperAdmin_(user) {
  return !!(user && (user.bootstrap || user.role === ACCESS_CONTROL.ROLES.SUPER_ADMIN));
}

function ManagerPortal_normalizeTeacherName_(value) {
  return String(value || "").replace(/\s+/g, "").replace(/원장님?$/, "");
}

function ManagerPortal_requireTeacher_(user) {
  if (ManagerPortal_isSuperAdmin_(user)) throw new Error("관리 원장님 전용 화면입니다. 최고 원장은 기존 관리 화면을 이용해주세요.");
  if (!user.teacherId) throw new Error("이 계정에 원장이 지정되지 않았습니다. 최고 원장에게 사용자 설정을 확인해달라고 요청해주세요.");
  var linkedTeacher = TeacherDirectory_getById_(user.teacherId);
  if (!linkedTeacher) throw new Error("선택된 원장 정보를 찾을 수 없습니다. 최고 원장에게 사용자 설정을 확인해달라고 요청해주세요.");
  if (!linkedTeacher.active) throw new Error("선택된 원장이 현재 사용 중지 상태입니다. 최고 원장에게 확인해주세요.");
  return linkedTeacher;
}

function ManagerPortal_getOptionalTeacher_(user) {
  if (ManagerPortal_isSuperAdmin_(user)) return null;
  if (!user.teacherId) return null;
  var teacher = TeacherDirectory_getById_(user.teacherId);
  if (!teacher) throw new Error("연결된 원장 정보를 찾을 수 없습니다. 사용자 설정을 확인해주세요.");
  if (!teacher.active) throw new Error("연결된 원장이 사용 중지 상태입니다. 최고 원장에게 원장 또는 사용자 연결 상태를 확인해달라고 요청해주세요.");
  return teacher;
}

function ManagerPortal_statusSummary_(students) {
  var summary = { total:students.length, complete:0, partial:0, unpaid:0, special:0 };
  students.forEach(function(student) {
    if (student.status === "완납") summary.complete++;
    else if (student.status === "부분납") summary.partial++;
    else if (student.status === "특강") summary.special++;
    else summary.unpaid++;
  });
  return summary;
}

function ManagerPortal_getOwnRequests_(email) {
  email = String(email || "").trim().toLowerCase();
  return LookupIndex_readTableForValues_(SHEET_NAMES.REQUESTS, COL.REQUEST.REQUESTER_EMAIL, [email], false).slice(1)
    .map(UnifiedRequest_toObject_)
    .filter(function(request) {
      return request.category === UNIFIED_REQUEST_CATEGORY.PAYMENT &&
        String(request.requesterEmail || "").trim().toLowerCase() === email;
    }).map(function(request) {
      var payment = UnifiedRequest_paymentView_(request);
      return {
        requestId:request.id, createdAt:request.createdAt, status:request.status,
        studentId:request.targetId, studentName:request.targetName, payDate:payment.payDate,
        month:payment.month, itemType:payment.itemType, amount:payment.amount, method:payment.method,
        evidenceCount:request.evidenceIds.length, decisionMemo:request.decisionMemo
      };
    }).sort(function(a,b) { return a.createdAt < b.createdAt ? 1 : -1; }).slice(0, 30);
}

function getManagerPortalData(targetYm) {
  var user = requireManagerPermission_("PAYMENT_DASHBOARD");
  var teacher = ManagerPortal_getOptionalTeacher_(user);
  var ym = Dashboard_resolveTargetYm_(targetYm);
  var dashboard = Dashboard_getDataForHtml_(ym, { access:user });
  // 대시보드 공통 범위 필터가 NONE/LINKED_TEACHER/ALL_STUDENTS 정책을 적용합니다.
  var students = dashboard.list || [];
  var requests = ManagerPortal_getOwnRequests_(user.email);
  return {
    profile:{ email:user.email, name:user.name || (teacher ? teacher.name : user.email),
      teacherId:teacher ? teacher.id : "", teacherName:teacher ? teacher.name : "전체" },
    targetYm:ym, months:dashboard.months, summary:ManagerPortal_statusSummary_(students), students:students,
    requests:requests, pendingCount:requests.filter(function(item) { return item.status === PAYMENT_REQUEST_STATUS.PENDING; }).length,
    paymentMethods:PAYMENT_METHODS.slice()
  };
}

function PaymentRequest_getEvidenceRootFolder_() {
  try {
    var folder = DriveApp.getFolderById(PAYMENT_EVIDENCE_FOLDER_ID);
    if (folder.isTrashed()) throw new Error("폴더가 휴지통에 있습니다.");
    if (!PaymentRequest_isInConfiguredParent_(folder)) throw new Error("지정된 프로그램 폴더 밖으로 이동되었습니다.");
    var properties = PropertiesService.getScriptProperties();
    if (properties.getProperty(PAYMENT_EVIDENCE_ROOT_SECURITY_PROPERTY) !== "1") {
      PaymentRequest_secureEvidenceRoot_(folder);
      properties.setProperty(PAYMENT_EVIDENCE_ROOT_SECURITY_PROPERTY, "1");
    }
    return folder;
  }
  catch (error) { throw new Error("수납 증빙 저장소에 접근할 수 없습니다. 폴더 공유 권한을 확인해주세요."); }
}

function PaymentRequest_isInConfiguredParent_(folder) {
  var parents = folder.getParents();
  while (parents.hasNext()) if (parents.next().getId() === PAYMENT_EVIDENCE_PARENT_FOLDER_ID) return true;
  return false;
}

function PaymentRequest_getOrCreateFolder_(parent, name) {
  var folders = parent.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : parent.createFolder(name);
}

function PaymentRequest_safeFolderName_(value) {
  return String(value || "미지정").replace(/[\\\/:*?"<>|#%{}~]/g, "_").replace(/\s+/g, " ").trim().substring(0, 80) || "미지정";
}

function PaymentRequest_folderPropertyKey_(prefix, value) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value || ""));
  return prefix + Utilities.base64EncodeWebSafe(digest).replace(/=+$/, "").substring(0, 45);
}

function PaymentRequest_getCachedChildFolder_(parent, name, propertyKey) {
  var properties = PropertiesService.getScriptProperties();
  var cachedId = properties.getProperty(propertyKey);
  if (cachedId) {
    try {
      var cached = DriveApp.getFolderById(cachedId);
      var parents = cached.getParents(), belongsToParent = false;
      while (parents.hasNext()) if (parents.next().getId() === parent.getId()) belongsToParent = true;
      if (!cached.isTrashed() && belongsToParent) return cached;
    } catch (ignoredCachedFolderError) {}
    properties.deleteProperty(propertyKey);
  }
  var folder = PaymentRequest_getOrCreateFolder_(parent, name);
  properties.setProperty(propertyKey, folder.getId());
  return folder;
}

function PaymentRequest_getManagerMonthFolder_(root, user, teacher, payDate) {
  var accountKey = String(user.email || "").toLowerCase() + "|" + String(user.teacherId || "");
  var teacherName = teacher && teacher.name ? teacher.name : (user.name || user.email);
  var managerName = PaymentRequest_safeFolderName_(teacherName + " · " + user.email);
  var managerKey = PaymentRequest_folderPropertyKey_(PAYMENT_EVIDENCE_MANAGER_CACHE_PREFIX, accountKey);
  var managerFolder = PaymentRequest_getCachedChildFolder_(root, managerName, managerKey);
  var shareKey = managerKey + "_SHARED";
  var properties = PropertiesService.getScriptProperties();
  if (properties.getProperty(shareKey) !== "1") {
    try { managerFolder.addEditor(user.email); properties.setProperty(shareKey, "1"); }
    catch (shareError) { logError_("원장별 증빙 폴더 공유 " + user.email, shareError); }
  }
  var ym = String(payDate || "").substring(0, 7);
  var monthKey = PaymentRequest_folderPropertyKey_(PAYMENT_EVIDENCE_MONTH_CACHE_PREFIX, accountKey + "|" + ym);
  return PaymentRequest_getCachedChildFolder_(managerFolder, ym, monthKey);
}

function PaymentRequest_hasImageSignature_(bytes, mime) {
  function b(index) { return (Number(bytes[index]) + 256) % 256; }
  if (mime === "image/jpeg") return bytes.length >= 3 && b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff;
  if (mime === "image/png") return bytes.length >= 8 &&
    [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every(function(value,index) { return b(index) === value; });
  if (mime === "image/webp") return bytes.length >= 12 &&
    [0x52,0x49,0x46,0x46].every(function(value,index) { return b(index) === value; }) &&
    [0x57,0x45,0x42,0x50].every(function(value,index) { return b(index + 8) === value; });
  return false;
}

function PaymentRequest_hashBytes_(bytes) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
  ).replace(/=+$/, "");
}

function PaymentRequest_evidenceFileName_(requestId, index, mime) {
  var extension = mime === "image/png" ? ".png" : (mime === "image/webp" ? ".webp" : ".jpg");
  return "증빙_" + PaymentRequest_safeFolderName_(requestId) + "_" + (Number(index) + 1) + extension;
}

function PaymentRequest_saveEvidence_(requestId, payDate, attachments, user, teacher) {
  attachments = Array.isArray(attachments) ? attachments : [];
  if (attachments.length > PAYMENT_EVIDENCE_MAX_FILES) throw new Error("증빙 이미지는 최대 3장까지 첨부할 수 있습니다.");
  // 첨부가 없는 일반 승인 요청은 Drive를 전혀 열지 않습니다. 첨부가 있어도
  // 원장/연월까지만 유지하고 요청별 하위 폴더는 만들지 않습니다.
  if (!attachments.length) return { fileIds:[], evidenceIntegrity:[], folderId:"", skipped:true };
  var root = PaymentRequest_getEvidenceRootFolder_();
  var monthFolder = PaymentRequest_getManagerMonthFolder_(root, user, teacher, payDate);
  var created = [], evidenceIntegrity = [];
  try {
    attachments.forEach(function(item, index) {
      var mime = String(item.type || "").toLowerCase();
      if (["image/jpeg","image/png","image/webp"].indexOf(mime) === -1) throw new Error("JPG·PNG·WebP 이미지만 첨부할 수 있습니다.");
      var encoded = String(item.base64 || "");
      if (!encoded || encoded.length > PAYMENT_EVIDENCE_MAX_BASE64_CHARS) throw new Error("증빙 이미지 한 장은 2MB 이하여야 합니다.");
      var bytes;
      try { bytes = Utilities.base64Decode(encoded); }
      catch (decodeError) { throw new Error("증빙 이미지 데이터를 읽을 수 없습니다."); }
      if (!bytes.length || bytes.length > PAYMENT_EVIDENCE_MAX_BYTES) throw new Error("증빙 이미지 한 장은 2MB 이하여야 합니다.");
      if (!PaymentRequest_hasImageSignature_(bytes, mime)) throw new Error("파일 내용과 이미지 형식이 일치하지 않습니다.");
      var fileName = PaymentRequest_evidenceFileName_(requestId, index, mime);
      var sha256 = PaymentRequest_hashBytes_(bytes);
      var file = monthFolder.createFile(Utilities.newBlob(bytes, mime, fileName));
      created.push(file);
      evidenceIntegrity.push({ fileId:file.getId(), mimeType:mime, size:bytes.length, sha256:sha256 });
    });
    // 월 폴더는 여러 요청이 함께 사용하므로 실패 정리 대상 폴더로 반환하지 않습니다.
    return { fileIds:evidenceIntegrity.map(function(item) { return item.fileId; }),
      evidenceIntegrity:evidenceIntegrity, folderId:"" };
  } catch (error) {
    created.forEach(function(file) { try { file.setTrashed(true); } catch (ignored) {} });
    throw error;
  }
}

function ManagerPaymentRequest_existingMap_(rows) {
  var result = {};
  for (var i = 0; i < (rows || []).length; i++) {
    var id = String(rows[i][IDX.REQUEST.ID] || "");
    if (id) result[id] = rows[i];
  }
  return result;
}

function ManagerPaymentRequest_deletedIdMap_(requestIds) {
  var deleted = {};
  if (!requestIds || !requestIds.length) return deleted;
  LookupIndex_findRowsForValues_(SHEET_NAMES.EVENTS, COL.EVENT.REQUEST_ID, requestIds, false).forEach(function(item) {
    var row = item.row || [];
    if (String(row[IDX.EVENT.TYPE] || "") === "수납요청기록삭제") {
      deleted[String(row[IDX.EVENT.REQUEST_ID] || "")] = true;
    }
  });
  return deleted;
}

/** 요청 ID 재사용은 같은 업무 내용을 다시 보낸 경우에만 멱등 재시도로 인정합니다. */
function ManagerPaymentRequest_normalizeRetryPayload_(data, studentId) {
  data = data || {};
  var calcType = optionalText_(data.calcType, 30) || "STANDARD";
  if (["STANDARD", "PRORATED"].indexOf(calcType) === -1) throw new Error("지원하지 않는 수납 계산 유형입니다.");
  var normalized = {
    studentId: requireText_(studentId == null ? data.studentId : studentId, "학생 ID", 100),
    payDate: requireDateString_(data.payDate, "납부일"),
    month: requireMonthString_(data.month, "귀속월"),
    itemType: normalizePaymentType_(requireText_(data.itemType, "수납 항목", 30)),
    amount: requireMoney_(data.amount, "수납 금액", 0, 100000000),
    method: requirePaymentMethod_(data.method),
    memo: safeSheetText_(data.memo, 500),
    reason: safeSheetText_(data.reason, 500),
    calcType: calcType,
    calcStart: data.calcStart ? requireDateString_(data.calcStart, "일할 시작일") : "",
    calcEnd: data.calcEnd ? requireDateString_(data.calcEnd, "일할 종료일") : "",
    activeDays: data.activeDays === "" || data.activeDays == null ? "" : requireNumberInRange_(data.activeDays, "적용 일수", 0, 366),
    billingDays: data.billingDays === "" || data.billingDays == null ? "" : requireNumberInRange_(data.billingDays, "기준 일수", 1, 366),
    vacationApplied: data.vacationApplied === true,
    siblingDiscount: requireMoney_(data.siblingDiscount || 0, "형제 할인", 0, 100000000),
    otherDiscount: requireMoney_(data.otherDiscount || 0, "기타 할인", 0, 100000000)
  };
  if (normalized.calcType === "PRORATED" && (!normalized.calcStart || !normalized.calcEnd ||
      normalized.activeDays === "" || normalized.billingDays === "")) {
    throw new Error("일할 수납의 계산 기간과 적용 일수가 비어 있습니다. 다시 계산해주세요.");
  }
  return normalized;
}

function ManagerPaymentRequest_normalizeStoredRetryPayload_(row) {
  var request = UnifiedRequest_toObject_(row || []);
  var payload = request.payload || {};
  var payment = payload.payments && payload.payments[0] || {};
  var item = payment.items && payment.items[0] || {};
  return ManagerPaymentRequest_normalizeRetryPayload_({
    studentId: payment.studentId || request.targetId,
    payDate: payload.payDate || request.effectiveDate,
    month: item.month,
    itemType: item.type,
    amount: item.amount,
    method: payload.payMethod,
    memo: item.memo,
    reason: payload.requestReason,
    calcType: item.calcType,
    calcStart: item.calcStart,
    calcEnd: item.calcEnd,
    activeDays: item.activeDays,
    billingDays: item.billingDays,
    vacationApplied: item.vacationApplied === true,
    siblingDiscount: item.siblingDiscount,
    otherDiscount: item.otherDiscount
  });
}

function ManagerPaymentRequest_isSameRetry_(row, normalizedInput) {
  try {
    return JSON.stringify(ManagerPaymentRequest_normalizeStoredRetryPayload_(row)) === JSON.stringify(normalizedInput);
  } catch (storedPayloadError) {
    return false;
  }
}

function ManagerPaymentRequest_assertSameRetry_(row, normalizedInput, requesterEmail) {
  var existingEmail = String((row || [])[IDX.REQUEST.REQUESTER_EMAIL] || "").trim().toLowerCase();
  if (existingEmail !== String(requesterEmail || "").trim().toLowerCase()) {
    throw new Error("이미 다른 사용자가 사용한 요청 ID입니다.");
  }
  if (String((row || [])[IDX.REQUEST.CATEGORY] || "") !== UNIFIED_REQUEST_CATEGORY.PAYMENT) {
    throw new Error("동일 요청 ID가 다른 작업 요청에 사용되었습니다.");
  }
  if (!ManagerPaymentRequest_isSameRetry_(row, normalizedInput)) {
    throw new Error("같은 요청 ID로 이전과 다른 수납 내용이 전송되었습니다. 화면을 닫고 다시 열어 새 요청으로 등록해주세요.");
  }
  return row;
}

function ManagerPaymentRequest_trashEvidence_(evidenceIds, folderId) {
  (evidenceIds || []).forEach(function(fileId) {
    try { DriveApp.getFileById(fileId).setTrashed(true); } catch (ignored) {}
  });
  if (folderId) try { DriveApp.getFolderById(folderId).setTrashed(true); } catch (ignoredFolderTrash) {}
}

/** 여러 학생·항목 요청을 개별 승인 건으로 유지하되 검증·잠금·시트 쓰기는 한 번에 처리합니다. */
function ManagerPaymentRequest_submitBatch_(items, authenticatedUser) {
  items = Array.isArray(items) ? items : [];
  if (!items.length) throw new Error("승인 요청할 수납 항목이 없습니다.");
  var startedAt = Date.now();
  var user = authenticatedUser || requireManagerPermission_("PAYMENT_DASHBOARD");
  AccessControl_requireStudentDataAccess_(user);
  if (!ChangeRequest_isManager_(user) || !AccessControl_hasPermission_(user, "PAYMENT_DASHBOARD")) {
    throw new Error("수납 요청 권한이 없습니다. 최고 원장에게 수납 요청 메뉴 권한을 확인해달라고 요청해주세요.");
  }
  var teacher = ManagerPortal_getOptionalTeacher_(user);
  var requesterName = user.name || (teacher && teacher.name) || user.email;
  var requestIds = items.map(function(data) {
    var id = requireText_(data && data.requestId, "요청 ID", 120);
    if (id.indexOf("PAYREQ-") !== 0) throw new Error("수납 요청 ID 형식이 올바르지 않습니다.");
    return id;
  });
  var seenIds = {};
  requestIds.forEach(function(id) {
    if (seenIds[id]) throw new Error("한 번의 수납 요청 안에 동일한 요청 ID가 있습니다.");
    seenIds[id] = true;
  });
  var deletedIds = ManagerPaymentRequest_deletedIdMap_(requestIds);
  requestIds.forEach(function(id) {
    if (deletedIds[id]) throw new Error("이미 처리 후 정리된 수납 요청 ID입니다. 화면을 닫고 새 요청으로 다시 등록해주세요.");
  });
  var requestedStudentIds = items.map(function(data) {
    return requireText_(data && data.studentId, "학생 ID", 100);
  });

  // DB_요청이 대기·승인·반려·취소 상태를 모두 보존하는 단일 원본입니다.
  var existingRows = LookupIndex_findRowsForValues_(
    SHEET_NAMES.REQUESTS, COL.REQUEST.ID, requestIds, false
  ).map(function(item) { return item.row; });
  var existing = ManagerPaymentRequest_existingMap_(existingRows);
  // 전체 대시보드를 다시 만들지 않고 요청 대상 학생만 동일 계산기로 검증합니다.
  var current = Dashboard_getDataForHtml_(Dashboard_defaultTargetYm_(), {
    access:user, context:Dashboard_buildTargetedContext_(requestedStudentIds), partial:true
  });
  var targetDataLoadedAt = Date.now();
  var students = {};
  (current.list || []).forEach(function(student) { students[String(student.id)] = student; });
  var prepared = [];
  var resultById = {};
  var evidenceSavedAt = targetDataLoadedAt;

  try {
    items.forEach(function(data, index) {
      data = data || {};
      var requestId = requestIds[index];
      var studentId = requestedStudentIds[index];
      var normalizedInput = ManagerPaymentRequest_normalizeRetryPayload_(data, studentId);
      if (existing[requestId]) {
        ManagerPaymentRequest_assertSameRetry_(existing[requestId], normalizedInput, user.email);
        resultById[requestId] = { requestId:requestId,
          status:String(existing[requestId][IDX.REQUEST.STATUS] || ""), duplicate:true,
          evidenceCount:PaymentApproval_parseEvidenceIds_(existing[requestId][IDX.REQUEST.EVIDENCE_IDS]).length };
        return;
      }
      var student = students[studentId];
      if (!student) throw new Error("현재 담당 학생으로 확인되지 않습니다. 화면을 새로고침해주세요.");
      var preparedItem = {
        requestId:requestId, studentId:studentId, studentName:student.name,
        payDate:normalizedInput.payDate, month:normalizedInput.month,
        itemType:normalizedInput.itemType, amount:normalizedInput.amount, method:normalizedInput.method,
        memo:normalizedInput.memo, reason:normalizedInput.reason, evidenceIds:[],
        calcType:normalizedInput.calcType, calcStart:normalizedInput.calcStart, calcEnd:normalizedInput.calcEnd,
        activeDays:normalizedInput.activeDays, billingDays:normalizedInput.billingDays,
        vacationApplied:normalizedInput.vacationApplied,
        siblingDiscount:normalizedInput.siblingDiscount, otherDiscount:normalizedInput.otherDiscount,
        retryPayload:normalizedInput
      };
      var savedEvidence = PaymentRequest_saveEvidence_(requestId, preparedItem.payDate, data.attachments, user, teacher);
      preparedItem.evidenceIds = savedEvidence.fileIds;
      preparedItem.evidenceIntegrity = savedEvidence.evidenceIntegrity || [];
      preparedItem.evidenceFolderId = savedEvidence.folderId;
      prepared.push(preparedItem);
    });
    evidenceSavedAt = Date.now();
  } catch (prepareError) {
    prepared.forEach(function(item) { ManagerPaymentRequest_trashEvidence_(item.evidenceIds, item.evidenceFolderId); });
    throw prepareError;
  }

  if (prepared.length) {
    try {
      MutationPipeline_run_({ operation:"일반관리자수납요청일괄", allowManagerPortal:true, authorizedUser:user }, function(tx) {
        tx.addRollback(function() {
          prepared.forEach(function(item) { ManagerPaymentRequest_trashEvidence_(item.evidenceIds, item.evidenceFolderId); });
        });
        var requestSheet = DataSchema_ensureSheet_(SHEET_NAMES.REQUESTS, tx).sheet;
        var lockedUnifiedIds = {};
        if (requestSheet.getLastRow() > 1) {
          requestSheet.getRange(2, COL.REQUEST.ID, requestSheet.getLastRow() - 1, 1).getDisplayValues()
            .forEach(function(row, rowIndex) { if (row[0]) lockedUnifiedIds[String(row[0])] = rowIndex + 2; });
        }
        var unifiedRows = [];
        prepared.forEach(function(item) {
          if (lockedUnifiedIds[item.requestId]) {
            var lockedRow = requestSheet.getRange(
              lockedUnifiedIds[item.requestId], 1, 1, COL.REQUEST.SCHEMA_VERSION
            ).getValues()[0];
            ManagerPaymentRequest_assertSameRetry_(lockedRow, item.retryPayload, user.email);
            ManagerPaymentRequest_trashEvidence_(item.evidenceIds, item.evidenceFolderId);
            resultById[item.requestId] = { requestId:item.requestId,
              status:String(lockedRow[IDX.REQUEST.STATUS] || ""), duplicate:true,
              evidenceCount:PaymentApproval_parseEvidenceIds_(lockedRow[IDX.REQUEST.EVIDENCE_IDS]).length };
            return;
          }
          var payload = safeSheetText_(JSON.stringify({
            requestId:item.requestId, payDate:item.payDate, payMethod:item.method, returnSavedRows:true,
            requestReason:item.reason,
            evidenceIntegrity:item.evidenceIntegrity,
            payments:[{ studentId:item.studentId, studentName:item.studentName,
              items:[{ month:item.month, type:item.itemType, amount:item.amount, memo:item.memo,
                calcType:item.calcType, calcStart:item.calcStart, calcEnd:item.calcEnd,
                activeDays:item.activeDays, billingDays:item.billingDays,
                vacationApplied:item.vacationApplied,
                siblingDiscount:item.siblingDiscount, otherDiscount:item.otherDiscount }] }]
          }), 20000);
          unifiedRows.push(UnifiedRequest_buildRow_({
            id:item.requestId, category:UNIFIED_REQUEST_CATEGORY.PAYMENT, type:"PAYMENT_CREATE",
            status:PAYMENT_REQUEST_STATUS.PENDING, targetId:item.studentId, targetName:item.studentName,
            summary:item.month + " · " + Number(item.amount).toLocaleString() + "원", payload:payload,
            requesterEmail:user.email, requesterName:requesterName, evidenceIds:item.evidenceIds.join(","),
            sourceSheet:SHEET_NAMES.REQUESTS, sourceId:item.requestId, effectiveDate:item.payDate
          }));
          tx.queueEvent({
            eventType:"수납등록요청", targetType:"수납요청", targetId:item.requestId, studentId:item.studentId,
            field:"수납 승인", before:"", after:"승인대기", effectiveDate:item.payDate,
            requestId:item.requestId, groupId:item.requestId, refId:item.evidenceIds.join(","), status:"대기",
            memo:safeSheetText_(item.studentName + " / " + item.itemType + " / " + item.amount + "원" +
              (item.reason ? " / " + item.reason : ""),1000)
          });
          resultById[item.requestId] = { requestId:item.requestId, status:PAYMENT_REQUEST_STATUS.PENDING,
            evidenceCount:item.evidenceIds.length };
        });
        if (unifiedRows.length) tx.appendRows(requestSheet, unifiedRows);
        tx.invalidate([SHEET_NAMES.REQUESTS, SHEET_NAMES.EVENTS]);
      });
    } catch (error) {
      prepared.forEach(function(item) { ManagerPaymentRequest_trashEvidence_(item.evidenceIds, item.evidenceFolderId); });
      throw error;
    }
  }
  var finishedAt = Date.now();
  var performance = { itemCount:items.length, newCount:prepared.length,
    duplicateCount:items.length - prepared.length, targetLoadMs:targetDataLoadedAt - startedAt,
    evidenceMs:evidenceSavedAt - targetDataLoadedAt, writeMs:finishedAt - evidenceSavedAt,
    writeAndEvidenceMs:finishedAt - targetDataLoadedAt, serverMs:finishedAt - startedAt };
  var results = requestIds.map(function(id) {
    var result = resultById[id];
    if (result) result.performance = performance;
    return result;
  });
  console.log("[수납 승인요청 성능] " + JSON.stringify(performance));
  return results;
}

function submitManagerPaymentRequest(data) {
  return ManagerPaymentRequest_submitBatch_([data])[0];
}

function initializePaymentEvidenceStorage() {
  requireSuperAdmin_();
  var folder = PaymentRequest_getEvidenceRootFolder_();
  PaymentRequest_secureEvidenceRoot_(folder);
  PropertiesService.getScriptProperties().setProperty(PAYMENT_EVIDENCE_ROOT_SECURITY_PROPERTY, "1");
  PropertiesService.getScriptProperties().setProperty(PAYMENT_EVIDENCE_FOLDER_PROPERTY, PAYMENT_EVIDENCE_FOLDER_ID);
  return PaymentRequest_evidenceFolderInfo_(folder, false);
}

function PaymentRequest_secureEvidenceRoot_(folder) {
  var keep = {};
  ACCESS_CONTROL.ADMIN_EMAILS.forEach(function(email) { keep[String(email).toLowerCase()] = true; });
  keep[String(Session.getEffectiveUser().getEmail() || "").toLowerCase()] = true;
  try { folder.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE); }
  catch (sharingModeError) { logError_("증빙 루트 링크 공유 차단", sharingModeError); }
  folder.getEditors().forEach(function(editor) {
    var email = String(editor.getEmail() || "").toLowerCase();
    if (!keep[email]) {
      try { folder.removeEditor(email); } catch (removeError) { logError_("증빙 루트 공유 회수 " + email, removeError); }
    }
  });
  folder.getViewers().forEach(function(viewer) {
    var email = String(viewer.getEmail() || "").toLowerCase();
    if (!keep[email]) {
      try { folder.removeViewer(email); } catch (removeViewerError) { logError_("증빙 루트 열람 회수 " + email, removeViewerError); }
    }
  });
  ACCESS_CONTROL.ADMIN_EMAILS.forEach(function(email) {
    try { folder.addEditor(email); } catch (adminShareError) { logError_("증빙 루트 최고 원장 공유 " + email, adminShareError); }
  });
}

function PaymentRequest_evidenceFolderInfo_(folder, created) {
  var parentNames = [];
  var parents = folder.getParents();
  while (parents.hasNext()) parentNames.push(parents.next().getName());
  return {
    available:true, folderId:folder.getId(), folderName:folder.getName(), created:!!created,
    folderUrl:"https://drive.google.com/drive/folders/" + folder.getId(),
    parentNames:parentNames, configuredParent:PaymentRequest_isInConfiguredParent_(folder)
  };
}

function getPaymentEvidenceStorageStatus() {
  requireSuperAdmin_();
  try {
    var folder = DriveApp.getFolderById(PAYMENT_EVIDENCE_FOLDER_ID);
    if (folder.isTrashed()) return { available:false, message:"지정된 증빙 폴더가 휴지통에 있습니다.", folderId:PAYMENT_EVIDENCE_FOLDER_ID };
    return PaymentRequest_evidenceFolderInfo_(folder, false);
  } catch (error) {
    return { available:false, message:"지정된 증빙 폴더에 접근할 수 없습니다. Google Drive 공유 권한을 확인해주세요.", folderId:PAYMENT_EVIDENCE_FOLDER_ID };
  }
}
