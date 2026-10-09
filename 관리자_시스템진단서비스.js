/** 관리자 전용: 원본을 변경하지 않고 주요 시트의 ID·참조·이벤트·수납 유형 상태를 검사합니다. */
function SystemDiagnostics_recoveryAction_(code) {
  code = String(code || "");
  if (/USER|SCOPE|PERMISSION/.test(code)) {
    return "설정 및 운영 관리의 ‘등록 사용자’에서 이메일 중복, 사용 상태, 사용자 종류, 연결 원장, 볼 수 있는 학생과 메뉴 권한을 차례로 확인한 뒤 해당 계정으로 다시 로그인합니다.";
  }
  if (/TEACHER/.test(code)) {
    return "원장 관리에서 해당 원장이 사용 중인지 확인하고, 설정의 등록 사용자에서 같은 원장과 연결되어 있는지 확인합니다. 이름이나 ID를 DB 시트에서 직접 고치지 마세요.";
  }
  if (/REQUEST|PROCESSING/.test(code)) {
    return "승인 요청함을 먼저 새로 열어 완료 표식 자동 복구 여부를 확인합니다. 같은 요청을 다시 승인하지 말고 요청 ID·학생·금액을 비교한 뒤 불필요한 중복 요청만 반려합니다.";
  }
  if (/PENDING_EVENT|PLANNED_VALUE|EVENT_VALUE|SAME_DATE_EVENT/.test(code)) {
    return "학생 정보 수정에서 해당 학생의 ‘앞으로 적용될 변경’을 확인합니다. 같은 날짜의 변경을 추가하지 말고, 오류 발생 전 검증된 백업이 있다면 복구 영향 검증으로 차이를 먼저 확인합니다.";
  }
  if (/PAYMENT|VACATION/.test(code)) {
    return "해당 학생의 수납 내역 또는 휴가 기간을 화면에서 다시 조회합니다. 원본에 없는 참조라면 신규 저장을 중단하고 수동 백업 후 오류 발생 전 백업을 ‘선택 백업 검증’으로 비교합니다.";
  }
  if (/DUPLICATE_PRIMARY_ID|MISSING_SHEET|ORPHAN|LEGACY_REF|REFERENCE|MISMATCH/.test(code)) {
    return "신규 저장을 잠시 중단하고 먼저 수동 백업을 만듭니다. DB 시트를 직접 편집하지 말고, 오류 발생 전 검증된 백업을 선택해 사라짐·복구·되돌림 건수를 확인한 뒤에만 복구를 결정합니다.";
  }
  return "같은 작업을 반복하지 말고 화면을 새로고침해 반영 여부를 먼저 확인합니다. 이후 수동 백업과 배포 환경 점검을 실행하고, DB 시트 직접 수정은 피합니다.";
}

function SystemDiagnostics_addIssue_(issues, severity, code, message, details) {
  issues.push({
    severity: severity,
    code: code,
    message: message,
    action: SystemDiagnostics_recoveryAction_(code),
    details: details || {}
  });
}

function SystemDiagnostics_findDuplicateIds_(rows, idIndex) {
  var seen = {};
  var duplicates = {};
  for (var i = 1; i < (rows || []).length; i++) {
    var id = String(rows[i][idIndex] || "").trim();
    if (!id) continue;
    if (seen[id]) duplicates[id] = (duplicates[id] || 1) + 1;
    else seen[id] = i + 1;
  }
  return Object.keys(duplicates).map(function(id) {
    return { id: id, count: duplicates[id] };
  });
}

function SystemDiagnostics_buildIdSet_(rows, idIndex) {
  var result = {};
  for (var i = 1; i < (rows || []).length; i++) {
    var id = String(rows[i][idIndex] || "").trim();
    if (id) result[id] = true;
  }
  return result;
}

function SystemDiagnostics_displayValue_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return String(value == null ? "" : value).trim();
}

/**
 * 현재 적용 상태와 퇴원일의 조합이 서로 모순되는 학생을 찾습니다.
 * 미래 퇴원 예정(현재 재원 + 미래 퇴원일)은 정상으로 취급합니다.
 */
function SystemDiagnostics_findStudentStatusDateMismatches_(students, histories, asOfDate) {
  var mismatches = [];
  var checkDate = asOfDate instanceof Date ? new Date(asOfDate.getTime()) : new Date();
  checkDate.setHours(23, 59, 59, 999);

  for (var i = 1; i < (students || []).length; i++) {
    var row = students[i];
    var studentId = String(row[IDX.STUDENT.ID] || "").trim();
    if (!studentId) continue;

    var currentState = resolveStudentStateAtDate_(row, histories || {}, checkDate);
    var currentStatus = String(currentState.status || "").trim();
    var exitDate = parseDateOnly_(row[IDX.STUDENT.EXIT_DATE]);
    var reason = "";

    if (currentStatus === "재원" && exitDate && exitDate <= checkDate) {
      reason = "현재 재원으로 계산되지만 퇴원일이 이미 지났습니다.";
    } else if (currentStatus === "퇴원" && (!exitDate || exitDate > checkDate)) {
      reason = exitDate
        ? "현재 퇴원으로 계산되지만 퇴원일이 미래입니다."
        : "현재 퇴원으로 계산되지만 퇴원일이 없습니다.";
    }

    if (reason) {
      mismatches.push({
        row: i + 1,
        studentId: studentId,
        studentName: String(row[IDX.STUDENT.NAME] || "").trim(),
        dbStatus: String(row[IDX.STUDENT.STATUS] || "").trim(),
        currentStatus: currentStatus,
        exitDate: exitDate ? formatDateOnly_(exitDate) : "",
        reason: reason
      });
    }
  }
  return mismatches;
}

function runSystemDataDiagnostics() {
  var user = requireSuperAdmin_();
  var context = DataRepository_loadContext_([
    SHEET_NAMES.STUDENTS, SHEET_NAMES.PAYMENTS, SHEET_NAMES.REQUESTS, SHEET_NAMES.VACATIONS,
    SHEET_NAMES.EVENTS, SHEET_NAMES.TRASH, SHEET_NAMES.TEACHERS, SHEET_NAMES.USERS
  ], { required: false, fresh: true, cache: false });
  var students = context[SHEET_NAMES.STUDENTS] || [];
  var payments = context[SHEET_NAMES.PAYMENTS] || [];
  var requests = context[SHEET_NAMES.REQUESTS] || [];
  var vacations = context[SHEET_NAMES.VACATIONS] || [];
  var events = context[SHEET_NAMES.EVENTS] || [];
  var trash = context[SHEET_NAMES.TRASH] || [];
  var teachers = context[SHEET_NAMES.TEACHERS] || [];
  var users = context[SHEET_NAMES.USERS] || [];
  var issues = [];
  var notices = [];
  var legacyPaymentRequestSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("DB_수납요청");
  if (legacyPaymentRequestSheet) {
    notices.push({
      code:"LEGACY_PAYMENT_REQUEST_SHEET_REMAINS",
      message:"수납 요청은 DB_요청으로 단일화되었습니다. 남아 있는 DB_수납요청 시트는 더 이상 사용되지 않으므로 삭제해도 됩니다.",
      details:{ rows:Math.max(0, legacyPaymentRequestSheet.getLastRow() - 1) }
    });
  }

  [
    { name: SHEET_NAMES.STUDENTS, rows: students, idIndex: IDX.STUDENT.ID },
    { name: SHEET_NAMES.PAYMENTS, rows: payments, idIndex: IDX.PAYMENT.ID },
    { name: SHEET_NAMES.REQUESTS, rows: requests, idIndex: IDX.REQUEST.ID },
    { name: SHEET_NAMES.VACATIONS, rows: vacations, idIndex: IDX.VACATION.ID },
    { name: SHEET_NAMES.EVENTS, rows: events, idIndex: IDX.EVENT.ID },
    { name: SHEET_NAMES.TRASH, rows: trash, idIndex: 0 },
    { name: SHEET_NAMES.TEACHERS, rows: teachers, idIndex: IDX.TEACHER.ID },
    { name: SHEET_NAMES.USERS, rows: users, idIndex: IDX.USER.ID }
  ].forEach(function(target) {
    if (!target.rows.length) {
      SystemDiagnostics_addIssue_(issues, target.name === SHEET_NAMES.EVENTS ? "치명적" : "높음",
        "MISSING_OR_EMPTY_SHEET", target.name + " 시트가 없거나 비어 있습니다.");
      return;
    }
    var duplicates = SystemDiagnostics_findDuplicateIds_(target.rows, target.idIndex);
    if (duplicates.length) {
      SystemDiagnostics_addIssue_(issues, "치명적", "DUPLICATE_PRIMARY_ID",
        target.name + " 시트에 중복 기본키가 있습니다.", { duplicates: duplicates.slice(0, 50) });
    }
  });

  var studentIds = SystemDiagnostics_buildIdSet_(students, IDX.STUDENT.ID);
  var teacherIds = {};
  var teacherNames = {};
  for (var tr = 1; tr < teachers.length; tr++) {
    var diagnosticTeacherId = String(teachers[tr][IDX.TEACHER.ID] || "").trim();
    var diagnosticTeacherName = String(teachers[tr][IDX.TEACHER.NAME] || "").trim();
    if (diagnosticTeacherId) teacherIds[diagnosticTeacherId] = Management_toBoolean_(teachers[tr][IDX.TEACHER.ACTIVE]);
    if (diagnosticTeacherName) teacherNames[diagnosticTeacherName] = diagnosticTeacherId;
  }
  var unlinkedStudentTeachers = [];
  var missingStudentTeacherIds = [];
  var mismatchedStudentTeacherIds = [];
  for (var st = 1; st < students.length; st++) {
    var studentTeacherName = String(students[st][IDX.STUDENT.TEACHER] || "").trim();
    var studentTeacherId = String(students[st][IDX.STUDENT.TEACHER_ID] || "").trim();
    if (studentTeacherName && !teacherNames[studentTeacherName]) {
      unlinkedStudentTeachers.push({ row: st + 1, studentId: String(students[st][IDX.STUDENT.ID] || ""), studentName: String(students[st][IDX.STUDENT.NAME] || ""), teacher: studentTeacherName });
    } else if (studentTeacherName && !studentTeacherId) {
      missingStudentTeacherIds.push({ row: st + 1, studentId: String(students[st][IDX.STUDENT.ID] || ""), studentName: String(students[st][IDX.STUDENT.NAME] || ""), teacher: studentTeacherName });
    } else if (studentTeacherName && teacherNames[studentTeacherName] !== studentTeacherId) {
      mismatchedStudentTeacherIds.push({ row: st + 1, studentId: String(students[st][IDX.STUDENT.ID] || ""), studentName: String(students[st][IDX.STUDENT.NAME] || ""), teacher: studentTeacherName, teacherId: studentTeacherId, expectedTeacherId: teacherNames[studentTeacherName] });
    }
  }
  if (unlinkedStudentTeachers.length) {
    SystemDiagnostics_addIssue_(issues, "높음", "UNLINKED_STUDENT_TEACHER",
      "학생의 담당 원장명이 DB_원장과 연결되지 않습니다.", { count: unlinkedStudentTeachers.length, samples: unlinkedStudentTeachers.slice(0, 50) });
  }
  if (missingStudentTeacherIds.length) {
    SystemDiagnostics_addIssue_(issues, "높음", "MISSING_STUDENT_TEACHER_ID",
      "학생의 담당 원장 ID가 비어 있습니다. 기존 원장 ID 이관을 실행해주세요.", { count: missingStudentTeacherIds.length, samples: missingStudentTeacherIds.slice(0, 50) });
  }
  if (mismatchedStudentTeacherIds.length) {
    SystemDiagnostics_addIssue_(issues, "치명적", "STUDENT_TEACHER_ID_MISMATCH",
      "학생의 담당 원장명과 원장 ID가 서로 다릅니다.", { count: mismatchedStudentTeacherIds.length, samples: mismatchedStudentTeacherIds.slice(0, 50) });
  }
  var invalidUserTeacherLinks = [];
  var inactiveUserTeacherLinks = [];
  var linkedScopeWithoutTeacher = [];
  for (var ur = 1; ur < users.length; ur++) {
    if (!Management_toBoolean_(users[ur][IDX.USER.ACTIVE])) continue;
    var userTeacherId = String(users[ur][IDX.USER.TEACHER_ID] || "").trim();
    var userRole = String(users[ur][IDX.USER.ROLE] || "").trim();
    var userStudentScope = AccessControl_normalizeStudentScope_(users[ur][IDX.USER.STUDENT_SCOPE], userTeacherId, userRole);
    if (!userTeacherId) {
      if (userRole === ACCESS_CONTROL.ROLES.MANAGER &&
          String(users[ur][IDX.USER.STUDENT_SCOPE] || "").trim().toUpperCase() === STUDENT_ACCESS_SCOPES.LINKED_TEACHER) {
        linkedScopeWithoutTeacher.push({
          row: ur + 1,
          email: String(users[ur][IDX.USER.EMAIL] || ""),
          displayName: String(users[ur][IDX.USER.NAME] || ""),
          studentScope:userStudentScope
        });
      }
      continue;
    }
    var userLinkSample = { row: ur + 1, email: String(users[ur][IDX.USER.EMAIL] || ""), teacherId: userTeacherId };
    if (!Object.prototype.hasOwnProperty.call(teacherIds, userTeacherId)) invalidUserTeacherLinks.push(userLinkSample);
    else if (!teacherIds[userTeacherId]) inactiveUserTeacherLinks.push(userLinkSample);
  }
  if (linkedScopeWithoutTeacher.length) {
    SystemDiagnostics_addIssue_(issues, "높음", "LINKED_SCOPE_WITHOUT_TEACHER",
      "연결 원장 학생 범위인데 연결 원장 ID가 없는 활성 사용자가 있습니다.",
      { count:linkedScopeWithoutTeacher.length, samples:linkedScopeWithoutTeacher.slice(0, 50) });
  }
  if (invalidUserTeacherLinks.length) {
    SystemDiagnostics_addIssue_(issues, "높음", "ORPHAN_USER_TEACHER_ID",
      "활성 사용자가 존재하지 않는 원장 ID를 참조합니다.", { count: invalidUserTeacherLinks.length, samples: invalidUserTeacherLinks.slice(0, 50) });
  }
  if (inactiveUserTeacherLinks.length) {
    SystemDiagnostics_addIssue_(issues, "중간", "INACTIVE_USER_TEACHER_ID",
      "활성 사용자가 비활성 원장 ID를 참조합니다.", { count: inactiveUserTeacherLinks.length, samples: inactiveUserTeacherLinks.slice(0, 50) });
  }
  var userEmailRows = {}, duplicateUserEmails = [], invalidUserRoles = [], invalidPermissionRows = [], invalidStudentScopes = [];
  var allowedPermissionKeys = AccessControl_managerPermissionKeys_();
  for (var ua = 1; ua < users.length; ua++) {
    var diagnosticEmail = String(users[ua][IDX.USER.EMAIL] || "").trim().toLowerCase();
    if (diagnosticEmail) {
      if (userEmailRows[diagnosticEmail]) duplicateUserEmails.push({ email:diagnosticEmail, rows:[userEmailRows[diagnosticEmail], ua + 1] });
      else userEmailRows[diagnosticEmail] = ua + 1;
    }
    var diagnosticRole = String(users[ua][IDX.USER.ROLE] || "").trim();
    if ([ACCESS_CONTROL.ROLES.SUPER_ADMIN, ACCESS_CONTROL.ROLES.MANAGER].indexOf(diagnosticRole) === -1) {
      invalidUserRoles.push({ row:ua + 1, email:diagnosticEmail, role:diagnosticRole });
    }
    var permissionText = String(users[ua][IDX.USER.PERMISSIONS] || "").trim();
    if (diagnosticRole === ACCESS_CONTROL.ROLES.MANAGER && permissionText && permissionText !== "OPERATIONS") {
      var invalidKeys = permissionText.split(",").map(function(key) { return String(key || "").trim().toUpperCase(); })
        .filter(function(key) { return key && allowedPermissionKeys.indexOf(key) === -1; });
      if (invalidKeys.length) invalidPermissionRows.push({ row:ua + 1, email:diagnosticEmail, invalidKeys:invalidKeys });
    }
    var scopeText = String(users[ua][IDX.USER.STUDENT_SCOPE] || "").trim().toUpperCase();
    if (scopeText && [STUDENT_ACCESS_SCOPES.NONE, STUDENT_ACCESS_SCOPES.LINKED_TEACHER, STUDENT_ACCESS_SCOPES.ALL_STUDENTS].indexOf(scopeText) === -1) {
      invalidStudentScopes.push({ row:ua + 1, email:diagnosticEmail, studentScope:scopeText });
    }
  }
  if (duplicateUserEmails.length) SystemDiagnostics_addIssue_(issues, "치명적", "DUPLICATE_USER_EMAIL",
    "같은 이메일이 DB_사용자에 중복되어 해당 계정의 로그인이 차단됩니다.", { samples:duplicateUserEmails.slice(0, 50) });
  if (invalidUserRoles.length) SystemDiagnostics_addIssue_(issues, "높음", "INVALID_USER_ROLE",
    "DB_사용자에 허용되지 않은 역할 값이 있습니다.", { samples:invalidUserRoles.slice(0, 50) });
  if (invalidPermissionRows.length) SystemDiagnostics_addIssue_(issues, "중간", "INVALID_MANAGER_PERMISSION",
    "인식되지 않는 관리자 메뉴 권한 키가 있습니다.", { samples:invalidPermissionRows.slice(0, 50) });
  if (invalidStudentScopes.length) SystemDiagnostics_addIssue_(issues, "높음", "INVALID_STUDENT_SCOPE",
    "DB_사용자에 허용되지 않는 학생 접근 범위 값이 있습니다. 해당 계정은 학생 접근 없음으로 처리됩니다.",
    { samples:invalidStudentScopes.slice(0, 50) });
  var pendingRequestKeys = {}, duplicatePendingRequests = [], staleProcessingRequests = [], invalidRequestStatuses = [], invalidPaymentRequestPayloads = [];
  var requestStatusSet = { PENDING:true, PROCESSING:true, APPROVED:true, REJECTED:true, ERROR:true, CANCELLED:true };
  var diagnosticNow = Date.now();
  for (var rq = 1; rq < requests.length; rq++) {
    var requestId = String(requests[rq][IDX.REQUEST.ID] || "").trim();
    var requestStatus = String(requests[rq][IDX.REQUEST.STATUS] || "").trim();
    if (String(requests[rq][IDX.REQUEST.CATEGORY] || "") === UNIFIED_REQUEST_CATEGORY.PAYMENT) {
      try {
        var paymentPayload = JSON.parse(String(requests[rq][IDX.REQUEST.PAYLOAD] || "{}"));
        var paymentTarget = paymentPayload.payments && paymentPayload.payments[0];
        if (String(paymentPayload.requestId || "") !== requestId || !paymentTarget ||
            !Array.isArray(paymentTarget.items) || paymentTarget.items.length !== 1) {
          invalidPaymentRequestPayloads.push({ row:rq + 1, requestId:requestId, reason:"요청 ID 또는 수납 항목 구조 불일치" });
        }
      } catch (paymentPayloadError) {
        invalidPaymentRequestPayloads.push({ row:rq + 1, requestId:requestId, reason:"요청원문 JSON 손상" });
      }
    }
    if (!requestStatusSet[requestStatus]) invalidRequestStatuses.push({ row:rq + 1, requestId:requestId, status:requestStatus });
    if (requestStatus === "PENDING") {
      var duplicateKey = [String(requests[rq][IDX.REQUEST.CATEGORY] || ""), String(requests[rq][IDX.REQUEST.TYPE] || ""),
        String(requests[rq][IDX.REQUEST.TARGET_ID] || ""), String(requests[rq][IDX.REQUEST.REQUESTER_EMAIL] || "").trim().toLowerCase(),
        String(requests[rq][IDX.REQUEST.PAYLOAD] || "")].join("|");
      if (pendingRequestKeys[duplicateKey]) duplicatePendingRequests.push({ requestId:requestId, duplicateOf:pendingRequestKeys[duplicateKey] });
      else pendingRequestKeys[duplicateKey] = requestId;
    }
    if (requestStatus === "PROCESSING") {
      var updatedAt = requests[rq][IDX.REQUEST.UPDATED_AT] instanceof Date ? requests[rq][IDX.REQUEST.UPDATED_AT] : new Date(requests[rq][IDX.REQUEST.UPDATED_AT]);
      var ageMinutes = !isNaN(updatedAt.getTime()) ? Math.floor((diagnosticNow - updatedAt.getTime()) / 60000) : null;
      if (ageMinutes == null || ageMinutes >= 15) {
        var nativeCompletion = UnifiedRequest_getNativeCompletion_(requestId);
        var completionBinding = nativeCompletion
          ? UnifiedRequest_nativeCompletionBinding_(nativeCompletion, UnifiedRequest_toObject_(requests[rq]))
          : null;
        staleProcessingRequests.push({ requestId:requestId, ageMinutes:ageMinutes,
          completionMarker:!!nativeCompletion, completionMarkerValid:!!(completionBinding && completionBinding.matches),
          completionMarkerError:completionBinding && !completionBinding.matches ? completionBinding.reason : "" });
      }
    }
  }
  if (duplicatePendingRequests.length) SystemDiagnostics_addIssue_(issues, "중간", "DUPLICATE_PENDING_REQUEST",
    "동일한 내용의 승인 대기 요청이 둘 이상 있습니다.", { samples:duplicatePendingRequests.slice(0, 50) });
  var recoverableProcessing = staleProcessingRequests.filter(function(item) { return item.completionMarkerValid; });
  var invalidCompletionProcessing = staleProcessingRequests.filter(function(item) { return item.completionMarker && !item.completionMarkerValid; });
  var ambiguousProcessing = staleProcessingRequests.filter(function(item) { return !item.completionMarker; });
  if (recoverableProcessing.length) SystemDiagnostics_addIssue_(issues, "중간", "RECOVERABLE_PROCESSING_REQUEST",
    "완료 표식이 남은 처리 중 요청이 있습니다. 통합 요청함을 열면 승인 완료로 자동 복구됩니다.",
    { samples:recoverableProcessing.slice(0, 50) });
  if (invalidCompletionProcessing.length) SystemDiagnostics_addIssue_(issues, "높음", "INVALID_PROCESSING_COMPLETION_MARKER",
    "처리 중 요청의 완료 표식에 비교 가능한 요청 지문이 없거나 현재 요청 원문과 일치하지 않아 자동 복구를 차단했습니다.",
    { samples:invalidCompletionProcessing.slice(0, 50) });
  if (ambiguousProcessing.length) SystemDiagnostics_addIssue_(issues, "높음", "STALE_PROCESSING_REQUEST",
    "15분 이상 처리 중 상태이며 완료 여부를 자동 판정할 수 없는 요청이 있습니다. 원본 데이터와 이벤트를 확인해주세요.",
    { samples:ambiguousProcessing.slice(0, 50) });
  if (invalidRequestStatuses.length) SystemDiagnostics_addIssue_(issues, "높음", "INVALID_REQUEST_STATUS",
    "DB_요청에 인식되지 않는 상태 값이 있습니다.", { samples:invalidRequestStatuses.slice(0, 50) });
  if (invalidPaymentRequestPayloads.length) SystemDiagnostics_addIssue_(issues, "높음", "INVALID_PAYMENT_REQUEST_PAYLOAD",
    "DB_요청의 수납 요청 원문이 손상되었거나 요청 ID와 연결되지 않습니다.",
    { samples:invalidPaymentRequestPayloads.slice(0, 50) });
  var missingTeacherEventRefs = [];
  var mismatchedTeacherEventRefs = [];
  for (var te = 1; te < events.length; te++) {
    var teacherEventField = String(events[te][IDX.EVENT.FIELD] || "").trim();
    if (["담당 원장 변경", "담당 강사 변경", "담당자 변경"].indexOf(teacherEventField) === -1) continue;
    var eventTeacherName = String(events[te][IDX.EVENT.AFTER] || "").trim();
    var eventTeacherRef = String(events[te][IDX.EVENT.REF_ID] || "").trim();
    if (!teacherNames[eventTeacherName]) continue;
    if (!eventTeacherRef) missingTeacherEventRefs.push({ row: te + 1, eventId: String(events[te][IDX.EVENT.ID] || ""), teacher: eventTeacherName });
    else if (eventTeacherRef !== teacherNames[eventTeacherName]) mismatchedTeacherEventRefs.push({ row: te + 1, eventId: String(events[te][IDX.EVENT.ID] || ""), teacher: eventTeacherName, refId: eventTeacherRef, expectedRefId: teacherNames[eventTeacherName] });
  }
  if (missingTeacherEventRefs.length) {
    SystemDiagnostics_addIssue_(issues, "중간", "MISSING_TEACHER_EVENT_REF_ID",
      "담당 원장 변경 이벤트에 원장 참조 ID가 없습니다.", { count: missingTeacherEventRefs.length, samples: missingTeacherEventRefs.slice(0, 50) });
  }
  if (mismatchedTeacherEventRefs.length) {
    SystemDiagnostics_addIssue_(issues, "높음", "TEACHER_EVENT_REF_ID_MISMATCH",
      "담당 원장 변경 이벤트의 원장명과 참조 ID가 서로 다릅니다.", { count: mismatchedTeacherEventRefs.length, samples: mismatchedTeacherEventRefs.slice(0, 50) });
  }
  var studentsByName = {};
  for (var sn = 1; sn < students.length; sn++) {
    var studentNameKey = String(students[sn][IDX.STUDENT.NAME] || "").trim();
    if (!studentNameKey) continue;
    if (!studentsByName[studentNameKey]) studentsByName[studentNameKey] = [];
    studentsByName[studentNameKey].push({
      studentId: String(students[sn][IDX.STUDENT.ID] || "").trim(),
      name: studentNameKey,
      grade: String(students[sn][IDX.STUDENT.GRADE] || "").trim(),
      status: String(students[sn][IDX.STUDENT.STATUS] || "").trim()
    });
  }
  var paymentIds = SystemDiagnostics_buildIdSet_(payments, IDX.PAYMENT.ID);
  var trashPaymentIds = {};
  for (var t = 1; t < trash.length; t++) {
    if (String(trash[t][3] || "") === SHEET_NAMES.PAYMENTS && String(trash[t][10] || "") === "보관중") {
      trashPaymentIds[String(trash[t][4] || "").trim()] = true;
    }
  }

  var blankPaymentTypes = [];
  var orphanPayments = [];
  var missingRequestIds = [];
  for (var p = 1; p < payments.length; p++) {
    var payId = String(payments[p][IDX.PAYMENT.ID] || "").trim();
    var studentId = String(payments[p][IDX.PAYMENT.STUDENT_ID] || "").trim();
    var rawType = String(payments[p][IDX.PAYMENT.TYPE] || "").trim();
    var requestId = String(payments[p][IDX.PAYMENT.REQUEST_ID] || "").trim();
    if (!rawType) blankPaymentTypes.push({ row: p + 1, payId: payId });
    if (studentId && !studentIds[studentId]) {
      var paymentStudentName = String(payments[p][IDX.PAYMENT.STUDENT_NAME] || "").trim();
      orphanPayments.push({
        row: p + 1,
        payId: payId,
        studentId: studentId,
        studentName: paymentStudentName,
        payDate: SystemDiagnostics_displayValue_(payments[p][IDX.PAYMENT.PAY_DATE]),
        month: SystemDiagnostics_displayValue_(payments[p][IDX.PAYMENT.MONTH]),
        type: normalizePaymentType_(payments[p][IDX.PAYMENT.TYPE]),
        amount: Number(payments[p][IDX.PAYMENT.AMOUNT]) || 0,
        exactNameCandidates: (studentsByName[paymentStudentName] || []).slice(0, 10)
      });
    }
    if (!requestId) missingRequestIds.push({ row: p + 1, payId: payId });
  }
  if (blankPaymentTypes.length) {
    SystemDiagnostics_addIssue_(issues, "중간", "BLANK_PAYMENT_TYPE",
      "유형이 빈 수납은 호환 규칙에 따라 수강료로 계산됩니다.", { count: blankPaymentTypes.length, samples: blankPaymentTypes.slice(0, 50) });
  }
  if (orphanPayments.length) {
    SystemDiagnostics_addIssue_(issues, "높음", "ORPHAN_PAYMENT_STUDENT",
      "존재하지 않는 학생 ID를 참조하는 수납이 있습니다.", { count: orphanPayments.length, samples: orphanPayments.slice(0, 50) });
  }
  if (missingRequestIds.length) {
    SystemDiagnostics_addIssue_(issues, "낮음", "LEGACY_PAYMENT_WITHOUT_REQUEST_ID",
      "영구 요청 ID가 없는 기존 수납이 있습니다.", { count: missingRequestIds.length, samples: missingRequestIds.slice(0, 50) });
  }
  var orphanVacationStudents = [];
  for (var v = 1; v < vacations.length; v++) {
    var vacationStudentId = String(vacations[v][IDX.VACATION.STUDENT_ID] || "").trim();
    if (vacationStudentId && !studentIds[vacationStudentId]) {
      orphanVacationStudents.push({ row: v + 1, vacationId: vacations[v][IDX.VACATION.ID], studentId: vacationStudentId });
    }
  }
  if (orphanVacationStudents.length) {
    SystemDiagnostics_addIssue_(issues, "높음", "ORPHAN_VACATION_STUDENT",
      "존재하지 않는 학생 ID를 참조하는 휴가·퇴원공백이 있습니다.",
      { count: orphanVacationStudents.length, samples: orphanVacationStudents.slice(0, 50) });
  }

  var orphanEventStudents = [];
  var unresolvedLegacyRefs = [];
  var missingPaymentRefs = [];
  var purgedPaymentIds = {};
  for (var pe = 1; pe < events.length; pe++) {
    if (String(events[pe][IDX.EVENT.TYPE] || "") === "휴지통영구삭제" &&
        String(events[pe][IDX.EVENT.TARGET_TYPE] || "") === "수납") {
      purgedPaymentIds[String(events[pe][IDX.EVENT.TARGET_ID] || "").trim()] = true;
    }
  }
  for (var e = 1; e < events.length; e++) {
    if (!EventRepository_isCompleted_(events[e])) continue;
    var eventStudentId = String(events[e][IDX.EVENT.STUDENT_ID] || "").trim();
    if (eventStudentId && !studentIds[eventStudentId]) {
      orphanEventStudents.push({
        row: e + 1,
        eventId: events[e][IDX.EVENT.ID],
        studentId: eventStudentId,
        effectiveDate: SystemDiagnostics_displayValue_(events[e][IDX.EVENT.EFFECTIVE_DATE]),
        eventType: SystemDiagnostics_displayValue_(events[e][IDX.EVENT.TYPE]),
        targetType: SystemDiagnostics_displayValue_(events[e][IDX.EVENT.TARGET_TYPE]),
        targetId: SystemDiagnostics_displayValue_(events[e][IDX.EVENT.TARGET_ID]),
        field: SystemDiagnostics_displayValue_(events[e][IDX.EVENT.FIELD]),
        before: SystemDiagnostics_displayValue_(events[e][IDX.EVENT.BEFORE]),
        after: SystemDiagnostics_displayValue_(events[e][IDX.EVENT.AFTER]),
        refId: SystemDiagnostics_displayValue_(events[e][IDX.EVENT.REF_ID]),
        memo: SystemDiagnostics_displayValue_(events[e][IDX.EVENT.MEMO])
      });
    }
    var refText = String(events[e][IDX.EVENT.REF_ID] || "").trim();
    if (/^LEGACY-\d+$/.test(refText)) {
      unresolvedLegacyRefs.push({ row: e + 1, eventId: events[e][IDX.EVENT.ID], refId: refText });
    }
    refText.split(",").map(function(value) { return String(value).trim(); }).filter(function(value) {
      return /^PAY-/.test(value);
    }).forEach(function(payRef) {
      if (!paymentIds[payRef] && !trashPaymentIds[payRef] && !purgedPaymentIds[payRef]) {
        missingPaymentRefs.push({ row: e + 1, eventId: events[e][IDX.EVENT.ID], payId: payRef });
      }
    });
  }
  if (orphanEventStudents.length) {
    SystemDiagnostics_addIssue_(issues, "높음", "ORPHAN_EVENT_STUDENT",
      "존재하지 않는 학생 ID를 참조하는 이벤트가 있습니다.", { count: orphanEventStudents.length, samples: orphanEventStudents.slice(0, 50) });
  }
  if (unresolvedLegacyRefs.length) {
    SystemDiagnostics_addIssue_(issues, "높음", "UNRESOLVED_LEGACY_REF",
      "이관 후 실제 참조 ID로 복구되지 않은 LEGACY 참조가 있습니다.",
      { count: unresolvedLegacyRefs.length, samples: unresolvedLegacyRefs.slice(0, 50) });
  }
  if (missingPaymentRefs.length) {
    SystemDiagnostics_addIssue_(issues, "높음", "MISSING_PAYMENT_REFERENCE",
      "원본 수납과 휴지통 어디에도 없는 수납 ID를 참조하는 이벤트가 있습니다.",
      { count: missingPaymentRefs.length, samples: missingPaymentRefs.slice(0, 50) });
  }

  // ID 연결뿐 아니라 시점 이벤트의 의미 연결도 검사합니다. 자동 보정은 하지 않습니다.
  var semanticHistories = StudentTimeline_buildHistories(EventRepository_toLegacyRows_(events));
  var sameDateConflicts = [];
  var chainMismatches = [];
  Object.keys(semanticHistories).forEach(function(studentId) {
    ["fee", "status", "teacher", "discount", "courseMode"].forEach(function(field) {
      var ordered = (semanticHistories[studentId][field] || []).slice().sort(function(a, b) {
        return (a.effectiveDate - b.effectiveDate) || (a.createdAt - b.createdAt) || (a.rowOrder - b.rowOrder);
      });
      var dateCounts = {};
      ordered.forEach(function(event) {
        var key = formatDateOnly_(event.effectiveDate);
        dateCounts[key] = (dateCounts[key] || 0) + 1;
      });
      Object.keys(dateCounts).forEach(function(date) {
        if (dateCounts[date] > 1) sameDateConflicts.push({ studentId: studentId, field: field, effectiveDate: date, count: dateCounts[date] });
      });
      for (var ci = 1; ci < ordered.length; ci++) {
        if (String(ordered[ci - 1].after) !== String(ordered[ci].before)) {
          chainMismatches.push({
            studentId: studentId, field: field,
            previousDate: formatDateOnly_(ordered[ci - 1].effectiveDate), previousAfter: ordered[ci - 1].after,
            nextDate: formatDateOnly_(ordered[ci].effectiveDate), nextBefore: ordered[ci].before
          });
        }
      }
    });
  });
  if (sameDateConflicts.length) {
    SystemDiagnostics_addIssue_(issues, "중간", "SAME_DATE_EVENT_CONFLICT",
      "같은 학생·항목·적용일에 완료 이벤트가 여러 건 있습니다. 마지막 기록이 적용됩니다.",
      { count: sameDateConflicts.length, samples: sameDateConflicts.slice(0, 50) });
  }
  if (chainMismatches.length) {
    SystemDiagnostics_addIssue_(issues, "중간", "EVENT_VALUE_CHAIN_MISMATCH",
      "시점 이벤트의 이전 변경후 값과 다음 변경전 값이 이어지지 않는 구간이 있습니다.",
      { count: chainMismatches.length, samples: chainMismatches.slice(0, 50) });
  }

  var plannedValueMismatches = [];
  var farFuture = new Date(9999, 11, 31, 23, 59, 59, 999);
  var diagnosticAsOfDate = new Date();
  diagnosticAsOfDate.setHours(23, 59, 59, 999);
  for (var ps = 1; ps < students.length; ps++) {
    var plannedStudentId = String(students[ps][IDX.STUDENT.ID] || "").trim();
    if (!plannedStudentId) continue;
    var plannedState = resolveStudentStateAtDate_(students[ps], semanticHistories, farFuture);
    var plannedHistory = semanticHistories[plannedStudentId] || { fee:[] };
    // 특강 전용은 실제 청구액만 0원으로 계산하며 DB의 기본 수강료는 보존합니다.
    // 따라서 계획값 일치 검사는 청구액(plannedState.fee)이 아니라 수강료 시점 이력의 원값과 비교합니다.
    var plannedBaseFee = Number(String(StudentTimeline_resolveValue(
      students[ps][IDX.STUDENT.FEE], plannedHistory.fee || [], farFuture
    )).replace(/,/g, "")) || 0;
    var rawChecks = [
      { field: "fee", raw: Number(String(students[ps][IDX.STUDENT.FEE] || 0).replace(/,/g, "")) || 0, planned: plannedBaseFee },
      { field: "status", raw: String(students[ps][IDX.STUDENT.STATUS] || "").trim(), planned: plannedState.status },
      { field: "teacher", raw: String(students[ps][IDX.STUDENT.TEACHER] || "").trim(), planned: plannedState.teacher },
      { field: "discount", raw: Number(students[ps][IDX.STUDENT.FAMILY_DISCOUNT]) || 0, planned: plannedState.siblingDiscount },
      {
        field: "courseMode",
        raw: normalizeStudentCourseMode_(students[ps][IDX.STUDENT.COURSE_MODE]),
        planned: normalizeStudentCourseMode_(plannedState.courseMode)
      }
    ];
    rawChecks.forEach(function(check) {
      if (String(check.raw) !== String(check.planned)) plannedValueMismatches.push({
        studentId: plannedStudentId, field: check.field, dbValue: check.raw, plannedValue: check.planned
      });
    });
  }
  if (plannedValueMismatches.length) {
    SystemDiagnostics_addIssue_(issues, "높음", "PLANNED_VALUE_MISMATCH",
      "학생 명단의 계획값과 시점 이벤트의 최종 계획값이 다릅니다.",
      { count: plannedValueMismatches.length, samples: plannedValueMismatches.slice(0, 50) });
  }

  var statusDateMismatches = SystemDiagnostics_findStudentStatusDateMismatches_(
    students, semanticHistories, diagnosticAsOfDate
  );
  if (statusDateMismatches.length) {
    SystemDiagnostics_addIssue_(issues, "높음", "STUDENT_STATUS_EXIT_DATE_MISMATCH",
      "학생의 현재 적용 상태와 퇴원일이 서로 맞지 않습니다.",
      { count: statusDateMismatches.length, samples: statusDateMismatches.slice(0, 50) });
  }

  var pendingEventKeys = [];
  try {
    pendingEventKeys = Object.keys(PropertiesService.getScriptProperties().getProperties()).filter(function(key) {
      return key.indexOf("PENDING_EVENT_") === 0;
    });
  } catch (pendingError) {
    SystemDiagnostics_addIssue_(issues, "중간", "PENDING_EVENT_CHECK_FAILED",
      "대기 이벤트 속성을 확인하지 못했습니다.", { message: pendingError.message || String(pendingError) });
  }
  if (pendingEventKeys.length) {
    SystemDiagnostics_addIssue_(issues, "중간", "PENDING_EVENTS",
      "아직 DB_이벤트에 재기록되지 않은 대기 이벤트가 있습니다.", { count: pendingEventKeys.length });
  }

  var severityOrder = { "치명적": 0, "높음": 1, "중간": 2, "낮음": 3 };
  issues.sort(function(a, b) { return severityOrder[a.severity] - severityOrder[b.severity]; });
  var result = {
    diagnosticId: createUniqueId_("HEALTH"),
    checkedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss"),
    checkedBy: user.email,
    counts: {
      students: Math.max(0, students.length - 1),
      payments: Math.max(0, payments.length - 1),
      vacations: Math.max(0, vacations.length - 1),
      events: Math.max(0, events.length - 1),
      trashRows: Math.max(0, trash.length - 1),
      teachers: Math.max(0, teachers.length - 1),
      users: Math.max(0, users.length - 1),
      issues: issues.length,
      notices: notices.length
    },
    issues: issues,
    notices: notices,
    healthy: !issues.some(function(issue) { return issue.severity === "치명적" || issue.severity === "높음"; })
  };
  console.log("[시스템 데이터 진단] " + JSON.stringify(result));
  return result;
}

function showSystemDataDiagnostics() {
  requireSpreadsheetSuperAdmin_();
  var result = runSystemDataDiagnostics();
  var lines = [
    "진단 ID: " + result.diagnosticId,
    "학생 " + result.counts.students + "명 / 수납 " + result.counts.payments + "건 / 이벤트 " + result.counts.events + "건",
    "확인 필요: " + result.counts.issues + "건 / 운영 안내: " + result.counts.notices + "건",
    ""
  ];
  result.issues.slice(0, 20).forEach(function(issue) {
    lines.push("[" + issue.severity + "] " + issue.message);
  });
  (result.notices || []).slice(0, 5).forEach(function(notice) {
    lines.push("[안내] " + notice.message);
  });
  if (result.issues.length > 20) lines.push("외 " + (result.issues.length - 20) + "건은 실행 로그에서 확인하세요.");
  SpreadsheetApp.getUi().alert("데이터 상태 진단", lines.join("\n"), SpreadsheetApp.getUi().ButtonSet.OK);
}
