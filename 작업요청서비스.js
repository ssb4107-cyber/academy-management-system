/** 하위관리자의 학생·휴가·형제 변경 요청과 최고관리자 승인 처리 */
var CHANGE_REQUEST_STATUS = { PENDING:"PENDING", PROCESSING:"PROCESSING", APPROVED:"APPROVED", REJECTED:"REJECTED", ERROR:"ERROR", CANCELLED:"CANCELLED" };

function ChangeRequest_isManager_(user) {
  return !!user && !user.bootstrap && user.role === ACCESS_CONTROL.ROLES.MANAGER;
}

function ChangeRequest_getStudentScopes_(studentIds) {
  var ids = (studentIds || []).map(function(studentId) {
    return requireText_(studentId, "학생 ID", 100);
  });
  var records = LookupIndex_findRowsForValues_(SHEET_NAMES.STUDENTS, COL.STUDENT.ID, ids, false);
  var foundIds = {};
  records.forEach(function(item) { foundIds[String(item.row[IDX.STUDENT.ID] || "").trim()] = true; });
  if (ids.some(function(id) { return !foundIds[id]; })) {
    records = LookupIndex_findRowsForValues_(SHEET_NAMES.STUDENTS, COL.STUDENT.ID, ids, true);
  }
  var histories = buildStudentChangeHistory_(EventRepository_getLegacyRowsForStudents_(ids));
  var lookup = TeacherDirectory_buildLookup_();
  var asOf = new Date(); asOf.setHours(23, 59, 59, 999);
  var result = {};
  records.forEach(function(item) {
    var studentId = String(item.row[IDX.STUDENT.ID] || "").trim();
    if (!studentId || result[studentId]) return;
    var state = resolveStudentStateAtDate_(item.row, histories, asOf, { teacherIdByName:lookup.idByName });
    result[studentId] = { id:studentId, name:String(item.row[IDX.STUDENT.NAME] || ""), teacherId:String(state.teacherId || "").trim() };
  });
  ids.forEach(function(id) { if (!result[id]) throw new Error("요청 대상 학생을 찾을 수 없습니다."); });
  return result;
}

function ChangeRequest_getStudentScope_(studentId) {
  studentId = requireText_(studentId, "학생 ID", 100);
  return ChangeRequest_getStudentScopes_([studentId])[studentId];
}

function ChangeRequest_assertStudentScope_(user, studentIds) {
  if (!ChangeRequest_isManager_(user)) return;
  var scope = AccessControl_getStudentScope_(user);
  if (scope === STUDENT_ACCESS_SCOPES.NONE) AccessControl_requireStudentDataAccess_(user);
  if (scope === STUDENT_ACCESS_SCOPES.ALL_STUDENTS) return;
  var linkedTeacherId = String(user.teacherId || "").trim();
  if (!linkedTeacherId) AccessControl_requireStudentDataAccess_(user);
  var students = ChangeRequest_getStudentScopes_(studentIds);
  (studentIds || []).forEach(function(studentId) {
    var student = students[String(studentId || "").trim()];
    if (student.teacherId !== linkedTeacherId) throw new Error("연결된 담당 원장의 학생만 요청할 수 있습니다: " + student.name);
  });
}

function ChangeRequest_getVacationStudentId_(periodId) {
  periodId = requireText_(periodId, "기간 ID", 120);
  var found = LookupIndex_findRows_(SHEET_NAMES.VACATIONS, COL.VACATION.ID, periodId, true);
  if (found.length) return String(found[0].row[IDX.VACATION.STUDENT_ID] || "").trim();
  throw new Error("휴가 기간을 찾을 수 없습니다.");
}

function ChangeRequest_fingerprint_(value) {
  var normalized = JSON.stringify(value, function(key, item) {
    return item instanceof Date ? item.toISOString() : item;
  });
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, normalized)).replace(/=+$/, "");
}

function ChangeRequest_getStudentFingerprints_(studentIds) {
  var ids = (studentIds || []).map(function(id) { return requireText_(id, "학생 ID", 100); });
  var records = LookupIndex_findRowsForValues_(SHEET_NAMES.STUDENTS, COL.STUDENT.ID, ids, true);
  var rowById = {};
  records.forEach(function(item) {
    var id = String(item.row[IDX.STUDENT.ID] || "").trim();
    if (id && !rowById[id]) rowById[id] = item.row;
  });
  var relatedById = {};
  ids.forEach(function(id) { relatedById[id] = []; });
  EventRepository_getLegacyRowsForStudents_(ids, true).slice(1).forEach(function(logRow) {
    var id = String(logRow[IDX.LOG.STUDENT_ID] || "").trim();
    if (relatedById[id]) relatedById[id].push(logRow);
  });
  var result = {};
  ids.forEach(function(id) {
    if (!rowById[id]) throw new Error("요청 대상 학생을 찾을 수 없습니다.");
    result[id] = ChangeRequest_fingerprint_({ row:rowById[id], logs:relatedById[id] });
  });
  return result;
}

function ChangeRequest_getStudentFingerprint_(studentId) {
  studentId = requireText_(studentId, "학생 ID", 100);
  return ChangeRequest_getStudentFingerprints_([studentId])[studentId];
}

function ChangeRequest_getVacationFingerprint_(periodId) {
  periodId = requireText_(periodId, "기간 ID", 120);
  var found = LookupIndex_findRows_(SHEET_NAMES.VACATIONS, COL.VACATION.ID, periodId, true);
  if (found.length) return ChangeRequest_fingerprint_(found[0].row);
  throw new Error("휴가 기간을 찾을 수 없습니다.");
}

function ChangeRequest_findPendingDuplicate_(sheet, type, targetId, payloadText, requesterEmail) {
  if (!sheet || sheet.getLastRow() < 2) return "";
  var rows = UnifiedRequest_readPendingRows_(true);
  requesterEmail = String(requesterEmail || "").trim().toLowerCase();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][IDX.REQUEST.STATUS] || "") !== CHANGE_REQUEST_STATUS.PENDING) continue;
    if (String(rows[i][IDX.REQUEST.CATEGORY] || "") !== UNIFIED_REQUEST_CATEGORY.CHANGE) continue;
    if (String(rows[i][IDX.REQUEST.TYPE] || "") !== String(type || "")) continue;
    if (String(rows[i][IDX.REQUEST.TARGET_ID] || "") !== String(targetId || "")) continue;
    if (String(rows[i][IDX.REQUEST.REQUESTER_EMAIL] || "").trim().toLowerCase() !== requesterEmail) continue;
    if (String(rows[i][IDX.REQUEST.PAYLOAD] || "") === payloadText) return String(rows[i][IDX.REQUEST.ID] || "");
  }
  return "";
}

function ChangeRequest_submit_(type, payload, meta) {
  var user = requireAuthorizedUser_();
  if (!ChangeRequest_isManager_(user)) return null;
  AccessControl_requireStudentDataAccess_(user);
  var permissionByType = {
    STUDENT_CREATE:"STUDENT_ADD", STUDENT_UPDATE:"STUDENT_EDIT",
    VACATION_CREATE:"STUDENT_VACATION", VACATION_UPDATE:"STUDENT_VACATION", VACATION_DELETE:"STUDENT_VACATION",
    SIBLING_DISCOUNT:"SIBLING_MANAGER", SIBLING_GROUP:"SIBLING_MANAGER"
  };
  if (!permissionByType[type] || !AccessControl_hasPermission_(user, permissionByType[type])) {
    throw new Error("이 계정에는 이 작업 권한이 열려 있지 않습니다. 최고 원장에게 사용자 메뉴 권한을 확인해달라고 요청해주세요.");
  }
  payload = payload || {}; meta = meta || {};
  var studentIds = (meta.studentIds || []).map(function(id) { return String(id || "").trim(); }).filter(Boolean);
  var snapshotStudentIds = (meta.snapshotStudentIds || studentIds).map(function(id) {
    return String(id || "").trim();
  }).filter(Boolean);
  ChangeRequest_assertStudentScope_(user, studentIds);
  if (AccessControl_getStudentScope_(user) === STUDENT_ACCESS_SCOPES.LINKED_TEACHER) {
    if (type === "STUDENT_CREATE") payload.teacherId = user.teacherId;
    if (type === "STUDENT_UPDATE") payload.teacherId = user.teacherId;
  }
  var requestContext = { studentFingerprints:{} };
  requestContext.studentFingerprints = ChangeRequest_getStudentFingerprints_(snapshotStudentIds);
  if ((type === "VACATION_UPDATE" || type === "VACATION_DELETE") && payload.periodId) {
    requestContext.vacationFingerprint = ChangeRequest_getVacationFingerprint_(payload.periodId);
  }
  payload.__requestContext = requestContext;
  var requestId = createUniqueId_("CHGREQ");
  var targetId = String(meta.targetId || studentIds[0] || "").trim();
  var targetName = safeSheetText_(meta.targetName || "", 80);
  var summary = safeSheetText_(meta.summary || type, 300);
  var payloadText = JSON.stringify(payload);
  if (payloadText.length > 45000) throw new Error("요청 내용이 너무 큽니다.");
  return MutationPipeline_run_({ operation:"작업승인요청", allowManagerPortal:true, authorizedUser:user }, function(tx) {
    var requestSheet = DataSchema_ensureSheet_(SHEET_NAMES.REQUESTS, tx).sheet;
    var duplicateId = ChangeRequest_findPendingDuplicate_(requestSheet, type, targetId, payloadText, user.email);
    if (duplicateId) return { requested:true, duplicate:true, requestId:duplicateId, status:CHANGE_REQUEST_STATUS.PENDING,
      message:"동일한 승인 대기 요청이 이미 있습니다. 요청 처리 현황에서 확인해주세요." };
    UnifiedRequest_append_(tx, { id:requestId, category:UNIFIED_REQUEST_CATEGORY.CHANGE, type:type,
      status:CHANGE_REQUEST_STATUS.PENDING, targetId:targetId, targetName:targetName, summary:summary,
      payload:payloadText, requesterEmail:user.email, requesterName:user.name || user.email,
      sourceSheet:SHEET_NAMES.REQUESTS, sourceId:requestId });
    tx.queueEvent({ eventType:"작업승인요청", targetType:"작업요청", targetId:requestId, studentId:targetId,
      field:type, before:"", after:"승인대기", effectiveDate:formatDateOnly_(new Date()), actorEmail:user.email });
    tx.invalidate([SHEET_NAMES.REQUESTS, SHEET_NAMES.EVENTS]);
    return { requested:true, requestId:requestId, status:CHANGE_REQUEST_STATUS.PENDING,
      message:"최고 원장 승인 요청으로 등록했습니다. 요청 처리 현황에서 진행 상태를 확인해주세요." };
  });
}

function getPendingChangeRequests() {
  requireSuperAdmin_();
  UnifiedRequest_ensureInitialized_();
  return UnifiedRequest_readPendingRows_().map(UnifiedRequest_toObject_)
    .filter(function(item) { return item.category === UNIFIED_REQUEST_CATEGORY.CHANGE; })
    .map(ChangeRequest_fromUnified_).sort(function(a,b) { return String(a.createdAt).localeCompare(String(b.createdAt)); });
}

function getMyChangeRequests() {
  var user = requireAuthorizedUser_();
  return LookupIndex_readTableForValues_(SHEET_NAMES.REQUESTS, COL.REQUEST.REQUESTER_EMAIL, [user.email], false).slice(1)
    .map(UnifiedRequest_toObject_)
    .filter(function(item) { return item.category === UNIFIED_REQUEST_CATEGORY.CHANGE && item.requesterEmail.trim().toLowerCase() === user.email; })
    .map(ChangeRequest_fromUnified_).sort(function(a,b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
}

function ChangeRequest_fromUnified_(item) {
  return { requestId:item.id, createdAt:item.createdAt, type:item.type, status:item.status,
    targetId:item.targetId, targetName:item.targetName, summary:item.summary,
    requesterEmail:item.requesterEmail, requesterName:item.requesterName,
    decisionMemo:item.decisionMemo, error:item.error, payload:item.payloadText };
}

function getMyOperationRequests() {
  var user = requireAuthorizedUser_();
  var unifiedRows = LookupIndex_readTableForValues_(SHEET_NAMES.REQUESTS, COL.REQUEST.REQUESTER_EMAIL, [user.email], false).slice(1)
    .map(UnifiedRequest_toObject_).filter(function(item) { return item.requesterEmail.trim().toLowerCase() === user.email; })
    .map(function(item) {
      var payment = item.category === UNIFIED_REQUEST_CATEGORY.PAYMENT ? UnifiedRequest_paymentView_(item) : null;
      return { id:item.id, createdAt:item.createdAt, category:payment ? "수납" : "작업", type:payment ? payment.itemType : item.type,
        studentId:payment ? item.targetId : String(item.payload && item.payload.studentId || ""),
        status:item.status, target:item.targetName || (payment ? "학생 정보 확인 필요" : "요청 대상"),
        summary:item.summary || (payment ? payment.month + " · " + Number(payment.amount || 0).toLocaleString() + "원" : "학생·운영 변경 요청"),
        decisionMemo:item.decisionMemo, error:item.error, canCancel:item.status === "PENDING" };
    });
  return unifiedRows.sort(function(a,b) { return String(b.createdAt).localeCompare(String(a.createdAt)); }).slice(0,100);
}

function cancelMyOperationRequest(requestId, category) {
  var user = requireAuthorizedUser_();
  requestId = requireText_(requestId, "요청 ID", 120);
  category = requireText_(category, "요청 구분", 20);
  var result;
  if (category === "작업") {
    result = UnifiedRequest_cancelOwnNativeChange_(requestId, user);
  }
  else if (category === "수납") result = PaymentRequest_cancelOwn_(requestId, user);
  else throw new Error("취소할 요청 구분이 올바르지 않습니다.");
  return result;
}

function PaymentRequest_cancelOwn_(requestId, user) {
  var evidenceIds = [];
  var result = MutationPipeline_run_({ operation:"본인 수납요청 취소", allowManagerPortal:true, authorizedUser:user }, function(tx) {
    var found = PaymentApproval_findRequest_(requestId, tx);
    var request = UnifiedRequest_toObject_(found.row);
    var ownerEmail = String(request.requesterEmail || "").trim().toLowerCase();
    if (ownerEmail !== user.email) throw new Error("본인이 등록한 요청만 취소할 수 있습니다.");
    if (request.status !== PAYMENT_REQUEST_STATUS.PENDING) {
      throw new Error("승인 대기 중인 요청만 취소할 수 있습니다.");
    }
    evidenceIds = request.evidenceIds;
    found.row[IDX.REQUEST.STATUS] = PAYMENT_REQUEST_STATUS.CANCELLED;
    found.row[IDX.REQUEST.PROCESSED_AT] = new Date();
    found.row[IDX.REQUEST.PROCESSED_BY] = user.email;
    found.row[IDX.REQUEST.DECISION_MEMO] = "요청자가 직접 취소했습니다.";
    found.row[IDX.REQUEST.RESULT] = "";
    found.row[IDX.REQUEST.ERROR] = "";
    found.row[IDX.REQUEST.UPDATED_AT] = new Date();
    tx.writeRange(found.sheet, found.rowNumber, 1, [found.row]);
    tx.queueEvent({ eventType:"수납요청취소", targetType:"수납요청", targetId:requestId,
      studentId:request.targetId, field:"수납 승인",
      before:"승인대기", after:"요청취소", requestId:requestId, groupId:requestId,
      refId:evidenceIds.join(","), memo:"요청자가 승인 전에 직접 취소" });
    tx.invalidate([SHEET_NAMES.REQUESTS, SHEET_NAMES.EVENTS]);
    return { requestId:requestId, category:"수납", status:PAYMENT_REQUEST_STATUS.CANCELLED };
  });
  evidenceIds.forEach(function(fileId) {
    try { DriveApp.getFileById(fileId).setTrashed(true); }
    catch (cleanupError) { logError_("취소 수납요청 증빙 정리 " + fileId, cleanupError); }
  });
  return result;
}

function ChangeRequest_dispatch_(type, payload) {
  if (type === "STUDENT_CREATE") return createStudent(payload);
  if (type === "STUDENT_UPDATE") return updateStudentData(payload);
  if (type === "VACATION_CREATE") return saveVacation(payload);
  if (type === "VACATION_UPDATE") return updateVacationPeriod(payload);
  if (type === "VACATION_DELETE") return deleteVacationPeriod(payload.periodId, payload.reason);
  if (type === "SIBLING_DISCOUNT") return updateSiblingDiscount(payload.studentId, payload.amount, payload.effectiveMonth);
  if (type === "SIBLING_GROUP") return updateSiblingGroup(payload.studentIds, payload.mode, payload.customName);
  throw new Error("지원하지 않는 작업 요청 유형입니다: " + type);
}

function ChangeRequest_validateSnapshot_(payload) {
  var context = payload && payload.__requestContext || {};
  var fingerprints = context.studentFingerprints || {};
  var currentFingerprints = ChangeRequest_getStudentFingerprints_(Object.keys(fingerprints));
  Object.keys(fingerprints).forEach(function(studentId) {
    if (currentFingerprints[studentId] !== fingerprints[studentId]) {
      throw new Error("요청 후 학생 정보가 변경되었습니다. 현재 내용을 확인한 뒤 새 요청을 등록해주세요.");
    }
  });
  if (context.vacationFingerprint && payload.periodId && ChangeRequest_getVacationFingerprint_(payload.periodId) !== context.vacationFingerprint) {
    throw new Error("요청 후 휴가 기간이 변경되었습니다. 현재 내용을 확인한 뒤 새 요청을 등록해주세요.");
  }
  delete payload.__requestContext;
}

function openChangeRequestDashboard() {
  requireSuperAdmin_();
  var url = ScriptApp.getService().getUrl() + "?page=DashboardUI";
  return HtmlService.createHtmlOutput('<script>top.location.replace(' + JSON.stringify(url) + ');</script>')
    .setTitle("통합 요청함").addMetaTag("viewport", "width=device-width, initial-scale=1");
}
