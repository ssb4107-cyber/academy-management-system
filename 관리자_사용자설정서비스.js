/** 관리자 전용: 사용자 권한·설정 화면·운영 도구 서비스 */
function getManagedUsers() {
  requireSuperAdmin_();
  var rows = DataRepository_getRows_(SHEET_NAMES.USERS, { required: false });
  return Management_buildManagedUsers_(rows, TeacherDirectory_list_());
}

/** 설정 화면이 이미 읽은 사용자·원장 행을 재사용하는 내부 변환기입니다. */
function Management_buildManagedUsers_(rows, teachers) {
  if (rows.length < 2) return [];
  var teacherById = {};
  (teachers || []).forEach(function(teacher) { teacherById[teacher.id] = teacher; });
  var userNameByEmail = {};
  rows.slice(1).forEach(function(row) {
    var email = String(row[IDX.USER.EMAIL] || "").trim().toLowerCase();
    if (email) userNameByEmail[email] = String(row[IDX.USER.NAME] || "").trim() || email;
  });
  return rows.slice(1).map(function(row) {
    var email = String(row[IDX.USER.EMAIL] || "").trim().toLowerCase();
    var bootstrap = ACCESS_CONTROL.ADMIN_EMAILS.indexOf(email) !== -1;
    var fixedManager = ACCESS_CONTROL.MANAGER_EMAILS.indexOf(email) !== -1;
    var teacherId = String(row[IDX.USER.TEACHER_ID] || "").trim();
    var teacher = teacherById[teacherId] || null;
    var role = bootstrap ? ACCESS_CONTROL.ROLES.SUPER_ADMIN :
      (fixedManager ? ACCESS_CONTROL.ROLES.MANAGER : String(row[IDX.USER.ROLE] || ""));
    var studentScope = bootstrap ? STUDENT_ACCESS_SCOPES.ALL_STUDENTS :
      AccessControl_normalizeStudentScope_(row[IDX.USER.STUDENT_SCOPE], teacherId, role);
    return {
      id: String(row[IDX.USER.ID] || ""), email: email, name: String(row[IDX.USER.NAME] || ""),
      role: role,
      active: bootstrap ? true : Management_toBoolean_(row[IDX.USER.ACTIVE]),
      permissions: bootstrap ? "*" : String(row[IDX.USER.PERMISSIONS] || (fixedManager ? "OPERATIONS" : "")),
      permissionKeys: bootstrap ? AccessControl_managerPermissionKeys_() : AccessControl_normalizePermissions_(row[IDX.USER.PERMISSIONS] || (fixedManager ? "OPERATIONS" : "")),
      createdAt: Management_formatTimestamp_(row[IDX.USER.CREATED_AT]),
      updatedAt: Management_formatTimestamp_(row[IDX.USER.UPDATED_AT]),
      updatedBy: String(row[IDX.USER.UPDATED_BY] || ""),
      updatedByName: userNameByEmail[String(row[IDX.USER.UPDATED_BY] || "").trim().toLowerCase()] ||
        ACCESS_CONTROL.ADMIN_DISPLAY_NAMES[String(row[IDX.USER.UPDATED_BY] || "").trim().toLowerCase()] ||
        String(row[IDX.USER.UPDATED_BY] || ""),
      teacherId: teacherId,
      teacherName: teacher ? teacher.name : "",
      teacherActive: teacher ? teacher.active : false,
      studentScope: studentScope,
      bootstrap: bootstrap
    };
  });
}

function Management_formatTimestamp_(value) {
  var date = value instanceof Date ? value : new Date(value);
  if (!value || isNaN(date.getTime())) return "";
  return Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm");
}

function Management_getUserDisplayName_(email) {
  email = String(email || "").trim().toLowerCase();
  if (!email) return "";
  return AccessControl_getDisplayName_(email);
}

function getCurrentAccessProfile() {
  var user = requireAuthorizedUser_();
  return {
    email: user.email,
    name: user.name || user.email,
    role: user.role, teacherId:user.teacherId || "", studentScope:AccessControl_getStudentScope_(user),
    isSuperAdmin: user.bootstrap || user.role === ACCESS_CONTROL.ROLES.SUPER_ADMIN
  };
}

function saveManagedUser(data) {
  requireSuperAdmin_();
  data = data || {};
  return MutationPipeline_run_({ operation: "사용자관리" }, function(tx) {
    var sheet = DataSchema_ensureSheet_(SHEET_NAMES.USERS, tx).sheet;
    var id = optionalText_(data.id, 120);
    var email = requireText_(data.email, "이메일", 120).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("이메일 형식이 올바르지 않습니다.");
    var identityMode = String(data.identityMode || (data.teacherId ? "TEACHER" : "CUSTOM")).toUpperCase();
    if (["TEACHER", "CUSTOM"].indexOf(identityMode) === -1) throw new Error("표시명 입력 방식을 확인할 수 없습니다.");
    var teacherId = "";
    var name = "";
    if (identityMode === "TEACHER") {
      teacherId = requireText_(data.teacherId, "사용자에게 지정할 원장", 120);
      var linkedTeacher = TeacherDirectory_getById_(teacherId);
      if (!linkedTeacher) throw new Error("선택한 원장 정보를 찾을 수 없습니다.");
      name = linkedTeacher.name;
    } else {
      name = requireText_(data.name, "표시명", 40);
    }
    var role = String(data.role || ACCESS_CONTROL.ROLES.MANAGER);
    if ([ACCESS_CONTROL.ROLES.SUPER_ADMIN, ACCESS_CONTROL.ROLES.MANAGER].indexOf(role) === -1) throw new Error("허용되지 않은 역할입니다.");
    var active = data.active !== false;
    if (ACCESS_CONTROL.ADMIN_EMAILS.indexOf(email) !== -1) { role = ACCESS_CONTROL.ROLES.SUPER_ADMIN; active = true; }
    if (ACCESS_CONTROL.MANAGER_EMAILS.indexOf(email) !== -1) role = ACCESS_CONTROL.ROLES.MANAGER;
    var requestedStudentScope = Object.prototype.hasOwnProperty.call(data, "studentScope") ? data.studentScope : STUDENT_ACCESS_SCOPES.NONE;
    var studentScope = AccessControl_resolveManagedStudentScope_(identityMode, requestedStudentScope, teacherId, role);
    var actor = requireSuperAdmin_();
    var permissionsProvided = Object.prototype.hasOwnProperty.call(data, "permissionKeys");
    var requestedPermissions = permissionsProvided ? AccessControl_serializePermissions_(data.permissionKeys) : "";
    var now = new Date();
    var beforeSummary = "신규";
    var lastRow = sheet.getLastRow();
    var rows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, COL.USER.STUDENT_SCOPE).getValues() : [];
    var targetRow = -1;
    for (var i = 0; i < rows.length; i++) {
      var rowId = String(rows[i][IDX.USER.ID] || "");
      var rowEmail = String(rows[i][IDX.USER.EMAIL] || "").trim().toLowerCase();
      if (id && rowId === id) targetRow = i + 2;
      if ((!id || rowId !== id) && rowEmail === email) throw new Error("이미 등록된 이메일입니다.");
    }
    if (targetRow > 0) {
      var current = sheet.getRange(targetRow, 1, 1, COL.USER.STUDENT_SCOPE).getValues()[0];
      var currentEmail = String(current[IDX.USER.EMAIL] || "").trim().toLowerCase();
      if (ACCESS_CONTROL.ADMIN_EMAILS.indexOf(currentEmail) !== -1) {
        if (email !== currentEmail) throw new Error("비상 관리자 계정의 이메일은 변경할 수 없습니다.");
        role = ACCESS_CONTROL.ROLES.SUPER_ADMIN;
        active = true;
      }
      if (ACCESS_CONTROL.MANAGER_EMAILS.indexOf(currentEmail) !== -1) {
        if (email !== currentEmail) throw new Error("보호된 관리 원장님 계정의 이메일은 변경할 수 없습니다.");
        role = ACCESS_CONTROL.ROLES.MANAGER;
      }
      if (currentEmail === actor.email && (!active || role !== ACCESS_CONTROL.ROLES.SUPER_ADMIN)) {
        throw new Error("현재 로그인한 최고 원장 계정은 권한을 낮추거나 사용 중지할 수 없습니다.");
      }
      if (currentEmail === actor.email && email !== currentEmail) {
        throw new Error("현재 로그인한 계정의 이메일은 직접 변경할 수 없습니다. 새 계정을 먼저 등록한 뒤 다른 최고 원장 계정으로 변경해주세요.");
      }
      beforeSummary = currentEmail + "/" + String(current[IDX.USER.ROLE] || "") + "/활성:" + Management_toBoolean_(current[IDX.USER.ACTIVE]);
      current[IDX.USER.EMAIL] = email; current[IDX.USER.NAME] = name; current[IDX.USER.ROLE] = role; current[IDX.USER.ACTIVE] = active;
      current[IDX.USER.PERMISSIONS] = role === ACCESS_CONTROL.ROLES.SUPER_ADMIN ? "*" :
        (permissionsProvided ? requestedPermissions : String(current[IDX.USER.PERMISSIONS] || "OPERATIONS"));
      current[IDX.USER.UPDATED_AT] = now; current[IDX.USER.UPDATED_BY] = actor.email;
      current[IDX.USER.TEACHER_ID] = teacherId;
      current[IDX.USER.STUDENT_SCOPE] = studentScope;
      tx.writeRange(sheet, targetRow, 1, [current]);
    } else {
      id = createUniqueId_("USR");
      tx.appendRows(sheet, [[id, email, name, role, active, role === ACCESS_CONTROL.ROLES.SUPER_ADMIN ? "*" :
        (permissionsProvided ? requestedPermissions : "OPERATIONS"), now, now, actor.email, teacherId, studentScope]]);
    }
    tx.queueEvent({ eventType: "사용자관리", targetType: "사용자", targetId: id, field: "접근권한/원장연결/학생범위", before: beforeSummary, after: email + "/" + role + "/활성:" + active + "/원장ID:" + (teacherId || "직접입력") + "/학생범위:" + studentScope });
    tx.invalidate([SHEET_NAMES.USERS]);
    return { id: id, email: email, name: name, teacherId:teacherId, studentScope:studentScope,
      permissionKeys:role === ACCESS_CONTROL.ROLES.SUPER_ADMIN ? AccessControl_managerPermissionKeys_() :
        AccessControl_normalizePermissions_(permissionsProvided ? requestedPermissions : "OPERATIONS") };
  });
}

function Settings_readJsonProperty_(key) {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty(key) || "null");
  } catch (ignoredSettingsPropertyError) {
    return null;
  }
}

/** 웹 앱 설정 화면에서 사용하는 읽기 전용 운영 현황입니다. */
function getSettingsOverview() {
  var actor = requireSuperAdmin_();
  var userRows = DataRepository_getRows_(SHEET_NAMES.USERS, { required: false });
  var teachers = TeacherDirectory_list_();
  var users = Management_buildManagedUsers_(userRows, teachers);
  var operationalSettings = OperationalSettings_list_();
  var operationalMap = {}; operationalSettings.forEach(function(item) { operationalMap[item.key] = item.value; });
  var triggers = ScriptApp.getProjectTriggers().filter(function(trigger) {
    return trigger.getHandlerFunction() === "runScheduledMaintenance";
  });
  return {
    users: users,
    teachers: teachers,
    managerPermissions: MANAGER_ROUTE_PERMISSIONS.map(function(item) { return { key:item.key, group:item.group, label:item.label }; }),
    operationalSettings: operationalSettings,
    currentUser: { email: actor.email, name: actor.name || Management_getUserDisplayName_(actor.email), role: actor.role, teacherId:actor.teacherId || "", bootstrap: !!actor.bootstrap },
    userCounts: {
      total: users.length,
      active: users.filter(function(user) { return user.active; }).length,
      superAdmins: users.filter(function(user) { return user.active && user.role === ACCESS_CONTROL.ROLES.SUPER_ADMIN; }).length,
      managers: users.filter(function(user) { return user.active && user.role === ACCESS_CONTROL.ROLES.MANAGER; }).length,
      recovery: users.filter(function(user) { return user.bootstrap; }).length
    },
    maintenance: {
      triggerCount: triggers.length,
      installed: triggers.length > 0,
      lastResult: Settings_readJsonProperty_("MAINTENANCE_LAST_RESULT"),
      lastBackup: Settings_readJsonProperty_("MAINTENANCE_LAST_BACKUP"),
      backupIntervalDays: operationalMap.BACKUP_INTERVAL_DAYS,
      backupRetentionMonths: operationalMap.BACKUP_RETENTION_MONTHS
    },
    policies: {
      timezone: Session.getScriptTimeZone(),
      dashboardMonthRule: "매월 " + (operationalMap.DASHBOARD_MONTH_CUTOFF_DAY - 1) + "일까지 전달, " + operationalMap.DASHBOARD_MONTH_CUTOFF_DAY + "일부터 당월",
      paymentToleranceWon: operationalMap.PAYMENT_TOLERANCE_WON,
      februaryBillingDays: operationalMap.FEBRUARY_BILLING_DAYS,
      recoveryAccounts: ACCESS_CONTROL.ADMIN_EMAILS.slice()
    }
  };
}

/** 조회와 분리된 명시적 설정 기반시설 복구입니다. 설정 열기만으로 DB가 바뀌지 않습니다. */
function repairSettingsInfrastructure() {
  requireSuperAdmin_();
  var schema = DataSchema_ensureSheet_(SHEET_NAMES.USERS);
  Management_seedBootstrapUsers_(schema.sheet);
  var defaults = OperationalSettings_ensureDefaults_();
  DataRepository_clearCache_(SHEET_NAMES.USERS);
  OperationalSettings_clearCache_();
  MonthlyCache_markAllDirty_();
  return {
    repaired:true,
    userSheetCreated:!!schema.created,
    userHeaderColumns:(schema.filledColumns || []).slice(),
    operationalDefaultsInserted:Number(defaults && defaults.inserted != null ? defaults.inserted : defaults) || 0,
    message:"설정 기반시설과 기본값을 점검·복구했습니다."
  };
}

function clearSystemCachesFromSettings() {
  requireSuperAdmin_();
  Object.keys(SHEET_NAMES).forEach(function(key) {
    var sheetName = SHEET_NAMES[key];
    if (sheetName) DataRepository_clearCache_(sheetName);
  });
  OperationalSettings_clearCache_();
  return { message: "공통 데이터 캐시를 초기화했습니다.", completedAt: Management_formatTimestamp_(new Date()) };
}

function runSystemDiagnosticsFromSettings() {
  requireSuperAdmin_();
  var result = runSystemDataDiagnostics();
  return {
    diagnosticId: result.diagnosticId,
    checkedAt: result.checkedAt,
    counts: result.counts,
    healthy: result.healthy,
    issues: (result.issues || []).map(function(issue) {
      return { severity: issue.severity, code: issue.code, message: issue.message };
    })
  };
}

function createBackupFromSettings() {
  requireSuperAdmin_();
  // 구형 이름이나 새로 추가된 빈 메타데이터 열은 데이터 이동 없이 표준 헤더로
  // 보정한 뒤 복사합니다. 의미가 다른 실제 충돌은 경고만 숨기지 않고 중단합니다.
  var schemaResults = ensureDataSchemas();
  var blocked = schemaResults.filter(function(item) { return item.blocked; });
  if (blocked.length) {
    throw new Error("DB 구조가 달라 백업 전 보정을 중단했습니다: " + blocked.map(function(item) {
      return item.sheetName + " " + (item.mismatches || []).map(function(mismatch) {
        return (mismatch.label || mismatch.column + "열") + " '" + mismatch.actual + "'→'" + mismatch.expected + "'";
      }).join(", ");
    }).join(" / "));
  }
  var repaired = schemaResults.filter(function(item) {
    return (item.filledColumns || []).length || (item.normalizedColumns || []).length;
  }).map(function(item) {
    return item.sheetName + " " + (item.filledColumns || []).concat(item.normalizedColumns || []).join(",") + "열";
  });
  var created = createDailyBackup();
  var state = Settings_readJsonProperty_("MAINTENANCE_LAST_BACKUP") || {};
  return {
    backupName: created.backupName || state.backupName || "",
    backupFileId: created.backupFileId || state.backupFileId || "",
    fileUrl: created.fileUrl || state.fileUrl || "",
    folderUrl: created.folderUrl || state.folderUrl || ("https://drive.google.com/drive/folders/" + BACKUP_FOLDER_ID),
    completedAt: Management_formatTimestamp_(created.completedAt || new Date()),
    schemaRepairs: repaired,
    verified: !!(state.verification && state.verification.valid && state.verification.copyMatchesSource),
    verificationErrors: state.verification && state.verification.errors || []
  };
}

function ResolvedPaymentRequest_resultPayIds_(row) {
  var result = null;
  try { result = JSON.parse(String((row || [])[IDX.REQUEST.RESULT] || "{}")); } catch (ignoredResultParseError) {}
  return result && Array.isArray(result.payIds)
    ? result.payIds.map(function(id) { return String(id || "").trim(); }).filter(Boolean)
    : [];
}

function ResolvedPaymentRequest_activePaymentMap_(payIds) {
  var active = {};
  if (!payIds || !payIds.length) return active;
  LookupIndex_findRowsForValues_(SHEET_NAMES.PAYMENTS, COL.PAYMENT.ID, payIds, false).forEach(function(item) {
    var row = item.row || [];
    var id = String(row[IDX.PAYMENT.ID] || "").trim();
    if (id && String(row[IDX.PAYMENT.RECORD_STATUS] || "ACTIVE") === "ACTIVE") active[id] = true;
  });
  return active;
}

function ResolvedPaymentRequest_collectRows_() {
  var rows = [];
  [PAYMENT_REQUEST_STATUS.APPROVED, PAYMENT_REQUEST_STATUS.REJECTED].forEach(function(status) {
    LookupIndex_findRows_(SHEET_NAMES.REQUESTS, COL.REQUEST.STATUS, status, false).forEach(function(item) {
      if (String((item.row || [])[IDX.REQUEST.CATEGORY] || "") === UNIFIED_REQUEST_CATEGORY.PAYMENT) rows.push(item);
    });
  });
  return rows;
}

/** 삭제 가능한 승인 완료·반려 수납 요청을 동일 정책으로 판정합니다. */
function ResolvedPaymentRequest_cleanupOverview_() {
  var rows = ResolvedPaymentRequest_collectRows_();
  var approvedPayIds = [];
  rows.forEach(function(item) {
    if (String(item.row[IDX.REQUEST.STATUS] || "") === PAYMENT_REQUEST_STATUS.APPROVED) {
      approvedPayIds = approvedPayIds.concat(ResolvedPaymentRequest_resultPayIds_(item.row));
    }
  });
  var activePayments = ResolvedPaymentRequest_activePaymentMap_(approvedPayIds);
  var items = rows.map(function(item) {
    var row = item.row, status = String(row[IDX.REQUEST.STATUS] || "");
    var payIds = status === PAYMENT_REQUEST_STATUS.APPROVED ? ResolvedPaymentRequest_resultPayIds_(row) : [];
    var missingPayIds = payIds.filter(function(id) { return !activePayments[id]; });
    var deletable = status === PAYMENT_REQUEST_STATUS.REJECTED || (payIds.length > 0 && !missingPayIds.length);
    return {
      requestId:String(row[IDX.REQUEST.ID] || ""), status:status,
      studentName:String(row[IDX.REQUEST.TARGET_NAME] || row[IDX.REQUEST.TARGET_ID] || ""),
      summary:String(row[IDX.REQUEST.SUMMARY] || ""), requesterEmail:String(row[IDX.REQUEST.REQUESTER_EMAIL] || ""),
      requesterName:String(row[IDX.REQUEST.REQUESTER_NAME] || ""),
      createdAt:Management_formatTimestamp_(row[IDX.REQUEST.CREATED_AT]),
      processedAt:Management_formatTimestamp_(row[IDX.REQUEST.PROCESSED_AT]),
      evidenceCount:PaymentApproval_parseEvidenceIds_(row[IDX.REQUEST.EVIDENCE_IDS]).length,
      payIds:payIds, deletable:deletable,
      blockedReason:deletable ? "" : (payIds.length ? "연결된 수납이 현재 원장에 없어 삭제할 수 없습니다." : "승인 결과의 수납 ID가 없어 삭제할 수 없습니다.")
    };
  }).sort(function(a,b) { return String(b.processedAt || b.createdAt).localeCompare(String(a.processedAt || a.createdAt)); });
  return { items:items, total:items.length, deletableCount:items.filter(function(item) { return item.deletable; }).length };
}

/** 설정 화면에서 정리 가능 건수와 최근 처리 결과를 조회합니다. */
function getResolvedPaymentRequestsForCleanup() {
  requireSuperAdmin_();
  var overview = ResolvedPaymentRequest_cleanupOverview_();
  overview.items = overview.items.slice(0, 200);
  return overview;
}

/** 선택 과정 없이 정리 가능한 요청 행을 최대 100건씩 안전하게 지웁니다. */
function deleteAllResolvedPaymentRequestsForCleanup() {
  requireSuperAdmin_();
  var overview = ResolvedPaymentRequest_cleanupOverview_();
  var requestIds = overview.items.filter(function(item) { return item.deletable; })
    .slice(0, 100).map(function(item) { return item.requestId; });
  if (!requestIds.length) {
    return { deleted:0, requestIds:[], remainingCount:0,
      message:"정리할 승인 완료·반려 수납 요청이 없습니다. 수납·이벤트·증빙은 변경하지 않았습니다." };
  }
  var result = deleteResolvedPaymentRequests(requestIds);
  result.remainingCount = Math.max(0, overview.deletableCount - Number(result.deleted || 0));
  return result;
}

/** 요청 행만 삭제하며 실제 수납·이벤트 타임라인·증빙·완료 표식은 보존합니다. */
function deleteResolvedPaymentRequests(requestIds) {
  var user = requireSuperAdmin_();
  requestIds = Array.isArray(requestIds) ? requestIds.map(function(id) { return requireText_(id, "요청 ID", 120); }) : [];
  var seen = {};
  requestIds = requestIds.filter(function(id) { if (seen[id]) return false; seen[id] = true; return true; });
  if (!requestIds.length) throw new Error("삭제할 승인 완료·반려 요청을 선택해주세요.");
  if (requestIds.length > 100) throw new Error("한 번에 삭제할 수 있는 요청은 최대 100건입니다.");
  return MutationPipeline_run_({ operation:"처리완료수납요청기록삭제", authorizedUser:user }, function(tx) {
    var targets = requestIds.map(function(requestId) {
      var found = UnifiedRequest_find_(requestId, tx);
      var row = found.row;
      if (String(row[IDX.REQUEST.CATEGORY] || "") !== UNIFIED_REQUEST_CATEGORY.PAYMENT) throw new Error("정리 대상에 수납 요청이 아닌 기록이 포함되어 있어 중단했습니다.");
      var status = String(row[IDX.REQUEST.STATUS] || "");
      if ([PAYMENT_REQUEST_STATUS.APPROVED, PAYMENT_REQUEST_STATUS.REJECTED].indexOf(status) === -1) {
        throw new Error("승인 완료 또는 반려 상태가 아닌 요청이 포함되어 있어 중단했습니다.");
      }
      return { requestId:requestId, rowNumber:found.rowNumber, row:row, status:status,
        payIds:status === PAYMENT_REQUEST_STATUS.APPROVED ? ResolvedPaymentRequest_resultPayIds_(row) : [] };
    });
    var approvedPayIds = [];
    targets.forEach(function(target) { approvedPayIds = approvedPayIds.concat(target.payIds); });
    var activePayments = ResolvedPaymentRequest_activePaymentMap_(approvedPayIds);
    targets.forEach(function(target) {
      if (target.status === PAYMENT_REQUEST_STATUS.APPROVED &&
          (!target.payIds.length || target.payIds.some(function(id) { return !activePayments[id]; }))) {
        throw new Error("연결 수납이 모두 남아 있지 않은 승인 요청이 있어 정리를 중단했습니다.");
      }
      tx.queueEvent({
        eventType:"수납요청기록삭제", targetType:"수납요청", targetId:target.requestId,
        studentId:String(target.row[IDX.REQUEST.TARGET_ID] || ""), field:"처리 완료 요청 기록",
        before:target.status, after:"삭제됨", requestId:target.requestId, groupId:target.requestId,
        refId:target.payIds.join(","), status:"완료",
        memo:JSON.stringify({ requestSummary:String(target.row[IDX.REQUEST.SUMMARY] || ""),
          requesterEmail:String(target.row[IDX.REQUEST.REQUESTER_EMAIL] || ""),
          evidenceCount:PaymentApproval_parseEvidenceIds_(target.row[IDX.REQUEST.EVIDENCE_IDS]).length,
          deletedBy:user.email })
      });
    });
    var requestSheet = DataRepository_getSheet_(SHEET_NAMES.REQUESTS, true);
    targets.sort(function(a,b) { return b.rowNumber - a.rowNumber; }).forEach(function(target) {
      tx.deleteRows(requestSheet, target.rowNumber, 1);
    });
    tx.invalidate([SHEET_NAMES.REQUESTS, SHEET_NAMES.EVENTS]);
    return { deleted:targets.length, requestIds:targets.map(function(target) { return target.requestId; }),
      message:"처리 완료 수납 요청 " + targets.length + "건의 요청 행을 삭제했습니다. 수납·이벤트·증빙은 보존했습니다." };
  });
}

function openSettingsDashboard() {
  requireSpreadsheetSuperAdmin_();
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createTemplateFromFile("SettingsDashboard").evaluate().setWidth(1100).setHeight(850), "설정 및 운영 관리");
}
