/**
 * ---------------------------------------------------------
 * [백업 구역] 3일 주기 자동 백업 시스템 (3개월 보관)
 * ---------------------------------------------------------
 */
var BACKUP_FOLDER_ID = "1ff7mIwxgSeKAq47rf_Ow7tElUDvoR9Dw";
var BACKUP_INTERVAL_DAYS = 3;
var BACKUP_RETENTION_MONTHS = 3;

function Backup_addMonthsClamped_(date, months) {
  var targetMonthStart = new Date(date.getFullYear(), date.getMonth() + months, 1);
  var lastDay = new Date(targetMonthStart.getFullYear(), targetMonthStart.getMonth() + 1, 0).getDate();
  return new Date(targetMonthStart.getFullYear(), targetMonthStart.getMonth(),
    Math.min(date.getDate(), lastDay), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
}

function Backup_isDue_(lastCompletedAt, now) {
  var last = lastCompletedAt ? new Date(lastCompletedAt) : null;
  var current = now instanceof Date ? now : new Date();
  if (!last || isNaN(last.getTime())) return true;
  return current.getTime() - last.getTime() >= OperationalSettings_getNumber_("BACKUP_INTERVAL_DAYS", BACKUP_INTERVAL_DAYS) * 86400000;
}

function Backup_shouldCreate_() {
  var lastBackup = null;
  try {
    lastBackup = JSON.parse(PropertiesService.getScriptProperties().getProperty("MAINTENANCE_LAST_BACKUP") || "null");
  } catch (ignoredBackupStateError) {}
  return Backup_isDue_(lastBackup && lastBackup.completedAt, new Date());
}

function Backup_getManagedSheetNames_(sourceSpreadsheet) {
  var names = Object.keys(DataSchema_getDefinitions_()).filter(function(name) {
    return !sourceSpreadsheet || !!sourceSpreadsheet.getSheetByName(name);
  });
  if (SHEET_NAMES.LOGS && sourceSpreadsheet && sourceSpreadsheet.getSheetByName(SHEET_NAMES.LOGS) && names.indexOf(SHEET_NAMES.LOGS) === -1) {
    names.push(SHEET_NAMES.LOGS);
  }
  return names;
}

function Backup_verifySpreadsheet_(spreadsheet) {
  var definitions = DataSchema_getDefinitions_();
  var sheets = [];
  var errors = [];
  Object.keys(definitions).forEach(function(sheetName) {
    var expected = definitions[sheetName];
    var sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) {
      // 설정 시트 도입 전 생성된 정상 백업도 복구할 수 있게 현재 설정은 유지합니다.
      if (sheetName === SHEET_NAMES.SETTINGS) return;
      errors.push("필수 시트 없음: " + sheetName);
      return;
    }
    var width = Math.min(sheet.getMaxColumns(), expected.length);
    var headers = width ? sheet.getRange(1, 1, 1, width).getDisplayValues()[0] : [];
    while (headers.length < expected.length) headers.push("");
    var mismatches = [];
    expected.forEach(function(header, index) {
      if (header == null) return;
      var actual = String(headers[index] || "").trim();
      if (actual !== header) mismatches.push((index + 1) + "열 '" + actual + "'≠'" + header + "'");
    });
    if (mismatches.length) errors.push(sheetName + " 헤더 불일치: " + mismatches.join(", "));
    sheets.push({
      name: sheetName,
      rows: Math.max(0, sheet.getLastRow() - 1),
      columns: sheet.getLastColumn(),
      headerValid: mismatches.length === 0,
      contentFingerprint: Backup_sheetContentFingerprint_(sheetName, sheet.getDataRange().getValues())
    });
  });
  if (SHEET_NAMES.LOGS && !definitions[SHEET_NAMES.LOGS]) {
    var legacySheet = spreadsheet.getSheetByName(SHEET_NAMES.LOGS);
    if (legacySheet) sheets.push({
      name: SHEET_NAMES.LOGS,
      rows: Math.max(0, legacySheet.getLastRow() - 1),
      columns: legacySheet.getLastColumn(),
      headerValid: true,
      contentFingerprint: Backup_sheetContentFingerprint_(SHEET_NAMES.LOGS, legacySheet.getDataRange().getValues()),
      legacy: true
    });
  }
  return { valid: errors.length === 0, spreadsheetId: spreadsheet.getId(), sheets: sheets, errors: errors };
}

var BACKUP_IMPACT_LABELS = {};
BACKUP_IMPACT_LABELS[SHEET_NAMES.STUDENTS] = "학생";
BACKUP_IMPACT_LABELS[SHEET_NAMES.PAYMENTS] = "수납";
BACKUP_IMPACT_LABELS[SHEET_NAMES.REQUESTS] = "통합 요청";
BACKUP_IMPACT_LABELS[SHEET_NAMES.VACATIONS] = "휴가";
BACKUP_IMPACT_LABELS[SHEET_NAMES.EVENTS] = "변경·처리 이력";
BACKUP_IMPACT_LABELS[SHEET_NAMES.LOGS] = "과거 변경 로그";
BACKUP_IMPACT_LABELS[SHEET_NAMES.TRASH] = "삭제 보관 기록";
BACKUP_IMPACT_LABELS[SHEET_NAMES.TEACHERS] = "원장";
BACKUP_IMPACT_LABELS[SHEET_NAMES.USERS] = "사용자 권한";
BACKUP_IMPACT_LABELS[SHEET_NAMES.SETTINGS] = "운영 설정";
BACKUP_IMPACT_LABELS[SHEET_NAMES.SALARY_SETTLEMENTS] = "급여 정산";
BACKUP_IMPACT_LABELS[SHEET_NAMES.SALARY_ENTRIES] = "급여 내역";

function Backup_normalizeCell_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return { date:value.getTime() };
  if (typeof value === "number" && !isFinite(value)) return String(value);
  return value == null ? "" : value;
}

function Backup_rowSignature_(row) {
  return JSON.stringify((row || []).map(Backup_normalizeCell_));
}

function Backup_hashText_(text) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, String(text || ""), Utilities.Charset.UTF_8
  )).replace(/=+$/, "");
}

/** 백업·복구 검증용 내용 지문. 폐기된 수납 열은 복구 정규화와 동일하게 제외합니다. */
function Backup_sheetContentFingerprint_(sheetName, rows) {
  var normalizedRows = (rows || []).map(function(row) {
    var normalized = (row || []).slice();
    if (sheetName === SHEET_NAMES.PAYMENTS && normalized.length >= PAYMENT_RETIRED_GROUP_COLUMN) {
      normalized[PAYMENT_RETIRED_GROUP_COLUMN - 1] = "";
    }
    return Backup_rowSignature_(normalized);
  });
  return Backup_hashText_(normalizedRows.join("\n"));
}

function Backup_readSheetRows_(spreadsheet, sheetName) {
  var sheet = spreadsheet.getSheetByName(sheetName);
  return sheet ? sheet.getDataRange().getValues() : [];
}

function Backup_buildComparableRows_(sheetName, rows) {
  var idIndex = DataRepository_getSchema_(sheetName).idIndex;
  var result = {}, occurrences = {};
  for (var i = 1; i < (rows || []).length; i++) {
    var comparableRow = rows[i].slice();
    if (sheetName === SHEET_NAMES.PAYMENTS) comparableRow[PAYMENT_RETIRED_GROUP_COLUMN - 1] = "";
    var signature = Backup_rowSignature_(comparableRow);
    var rawId = idIndex == null ? "" : String(comparableRow[idIndex] == null ? "" : comparableRow[idIndex]).trim();
    var base = rawId ? "ID:" + rawId : "ROW:" + Backup_hashText_(signature);
    occurrences[base] = (occurrences[base] || 0) + 1;
    result[base + "#" + occurrences[base]] = signature;
  }
  return result;
}

function Backup_compareComparableRows_(current, backup) {
  var result = { willDisappear:0, willRestore:0, willRevert:0 };
  Object.keys(current || {}).forEach(function(key) {
    if (!Object.prototype.hasOwnProperty.call(backup || {}, key)) result.willDisappear++;
    else if (current[key] !== backup[key]) result.willRevert++;
  });
  Object.keys(backup || {}).forEach(function(key) {
    if (!Object.prototype.hasOwnProperty.call(current || {}, key)) result.willRestore++;
  });
  return result;
}

/** 현재 운영본과 선택 백업을 ID 기준으로 비교해 복구 영향을 계산합니다. */
function Backup_buildRestoreImpact_(currentSpreadsheet, backupSpreadsheet) {
  var names = Backup_getManagedSheetNames_(backupSpreadsheet).slice().sort();
  var items = [], fingerprintParts = [];
  var totals = { willDisappear:0, willRestore:0, willRevert:0 };
  names.forEach(function(sheetName) {
    var currentRows = Backup_readSheetRows_(currentSpreadsheet, sheetName);
    var backupRows = Backup_readSheetRows_(backupSpreadsheet, sheetName);
    var current = Backup_buildComparableRows_(sheetName, currentRows);
    var backup = Backup_buildComparableRows_(sheetName, backupRows);
    var comparison = Backup_compareComparableRows_(current, backup);
    var disappear = comparison.willDisappear, restore = comparison.willRestore, revert = comparison.willRevert;
    totals.willDisappear += disappear; totals.willRestore += restore; totals.willRevert += revert;
    if (disappear || restore || revert) items.push({
      sheetName:sheetName, label:BACKUP_IMPACT_LABELS[sheetName] || sheetName,
      willDisappear:disappear, willRestore:restore, willRevert:revert,
      currentRows:Math.max(0, currentRows.length - 1), backupRows:Math.max(0, backupRows.length - 1)
    });
    fingerprintParts.push(sheetName + ":" + Backup_hashText_(currentRows.map(Backup_rowSignature_).join("\n")));
  });
  return {
    items:items, totals:totals,
    hasChanges:totals.willDisappear + totals.willRestore + totals.willRevert > 0,
    currentFingerprint:Backup_hashText_(fingerprintParts.join("|"))
  };
}

function Backup_getFolder_() {
  try {
    var folder = DriveApp.getFolderById(BACKUP_FOLDER_ID);
    folder.getName();
    return folder;
  } catch (folderError) {
    throw new Error("백업 폴더에 접근할 수 없습니다. 폴더 ID와 공유 권한을 확인해주세요. (" + folderError.message + ")");
  }
}

function Backup_compareManifests_(source, copy) {
  var errors = [];
  var copyByName = {};
  (copy.sheets || []).forEach(function(item) { copyByName[item.name] = item; });
  (source.sheets || []).forEach(function(item) {
    var copied = copyByName[item.name];
    if (!copied) errors.push("복사본 시트 누락: " + item.name);
    else if (copied.rows !== item.rows || copied.columns !== item.columns) {
      errors.push(item.name + " 크기 불일치: 원본 " + item.rows + "행/" + item.columns + "열, 복사본 " + copied.rows + "행/" + copied.columns + "열");
    } else if (item.contentFingerprint && copied.contentFingerprint !== item.contentFingerprint) {
      errors.push(item.name + " 내용 지문 불일치");
    }
  });
  return { matches: errors.length === 0, errors: errors };
}

function Backup_createVerifiedCopy_(reason) {
  var source = SpreadsheetApp.getActiveSpreadsheet();
  var sourceVerification = Backup_verifySpreadsheet_(source);
  var timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd_HHmmss");
  var suffix = reason ? "_" + String(reason).replace(/[^0-9A-Za-z가-힣_-]/g, "_").substring(0, 30) : "";
  var backupName = "[백업_" + timestamp + suffix + "] " + source.getName();
  var copy = DriveApp.getFileById(source.getId()).makeCopy(backupName, Backup_getFolder_());
  var verification;
  try {
    verification = Backup_verifySpreadsheet_(SpreadsheetApp.openById(copy.getId()));
  } catch (openError) {
    copy.setTrashed(true);
    throw new Error("생성된 백업을 다시 열어 검증하지 못했습니다: " + openError.message);
  }
  var comparison = Backup_compareManifests_(sourceVerification, verification);
  verification.copyMatchesSource = comparison.matches;
  verification.copyErrors = comparison.errors;
  if (!comparison.matches) {
    copy.setTrashed(true);
    throw new Error("백업 복사본의 구조 또는 내용이 원본과 달라 폐기했습니다: " + comparison.errors.join(" / "));
  }
  if (!verification.valid) console.warn("[백업 구조 경고] 원본 보존용 복사본은 유지하지만 자동 복구에는 사용할 수 없습니다: " + verification.errors.join(" / "));
  return {
    fileId: copy.getId(), backupName: backupName, verification: verification,
    fileUrl: "https://docs.google.com/spreadsheets/d/" + copy.getId() + "/edit",
    folderUrl: "https://drive.google.com/drive/folders/" + BACKUP_FOLDER_ID
  };
}

function createDailyBackup() {
  requireSuperAdmin_();
  return Backup_createDailyBackup_();
}

function Backup_createDailyBackup_() {
  var created = Backup_createVerifiedCopy_("정기");
  var folder = Backup_getFolder_();
  console.log("✅ 신규 백업 생성 및 검증 완료: " + created.backupName);

  // ============================================================
  // ★ 오래된 파일 자동 정리 (3개월 보관)
  // ============================================================
  
  var cutoffDate = Backup_addMonthsClamped_(new Date(), -OperationalSettings_getNumber_("BACKUP_RETENTION_MONTHS", BACKUP_RETENTION_MONTHS));

  // 폴더 내 모든 파일 탐색
  var files = folder.getFiles();
  
  while (files.hasNext()) {
    var oldFile = files.next();
    
    // 삭제 조건:
    // 1. 파일 생성일이 기준일(14일 전)보다 과거이고
    // 2. 파일 이름이 "[백업_"으로 시작하는 경우 (혹시 모를 다른 중요 파일 삭제 방지)
    if (oldFile.getDateCreated() < cutoffDate && oldFile.getName().indexOf("[백업_") === 0) {
      
      var oldName = oldFile.getName();
      oldFile.setTrashed(true); // 휴지통으로 이동 (완전 삭제가 아니라 복구 가능)
      
      console.log("🗑️ 오래된 백업 삭제됨: " + oldName);
    }
  }
  PropertiesService.getScriptProperties().setProperty("MAINTENANCE_LAST_BACKUP", JSON.stringify({
    completedAt: new Date().toISOString(), backupName: created.backupName, backupFileId: created.fileId,
    fileUrl: created.fileUrl, folderId: BACKUP_FOLDER_ID, folderUrl: created.folderUrl,
    verification: created.verification
  }));
  return {
    backupName:created.backupName, backupFileId:created.fileId,
    fileUrl:created.fileUrl, folderUrl:created.folderUrl,
    completedAt:new Date().toISOString(),
    verified:!!(created.verification && created.verification.valid && created.verification.copyMatchesSource),
    verification:created.verification
  };
}

function Backup_requireCandidate_(fileId) {
  var id = String(fileId || "").trim();
  if (!id) throw new Error("백업 파일 ID가 없습니다.");
  var file = DriveApp.getFileById(id);
  if (file.isTrashed() || file.getName().indexOf("[백업_") !== 0) throw new Error("학원 관리 백업 파일이 아닙니다.");
  var inBackupFolder = false;
  var parents = file.getParents();
  while (parents.hasNext()) if (parents.next().getId() === BACKUP_FOLDER_ID) inBackupFolder = true;
  if (!inBackupFolder) throw new Error("지정된 백업 폴더에 있는 파일만 복구할 수 있습니다.");
  if (file.getId() === SpreadsheetApp.getActiveSpreadsheet().getId()) throw new Error("현재 운영 파일은 복구 원본으로 선택할 수 없습니다.");
  return file;
}

function getBackupRecoveryOverview() {
  requireSuperAdmin_();
  var files = Backup_getFolder_().getFiles();
  var list = [];
  while (files.hasNext()) {
    var file = files.next();
    if (!file.isTrashed() && file.getName().indexOf("[백업_") === 0) {
      list.push({ fileId: file.getId(), name: file.getName(), createdAt: file.getDateCreated().toISOString(),
        fileUrl:"https://docs.google.com/spreadsheets/d/" + file.getId() + "/edit" });
    }
  }
  list.sort(function(a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
  return {
    backups: list.slice(0, 30),
    restoreScope: "관리 DB 시트",
    currentSpreadsheetName: SpreadsheetApp.getActiveSpreadsheet().getName(),
    folderUrl: "https://drive.google.com/drive/folders/" + BACKUP_FOLDER_ID
  };
}

function previewBackupRestore(fileId) {
  requireSuperAdmin_();
  var file = Backup_requireCandidate_(fileId);
  var backupSpreadsheet = SpreadsheetApp.openById(file.getId());
  var verification = Backup_verifySpreadsheet_(backupSpreadsheet);
  if (!verification.valid) throw new Error("복구할 수 없는 백업입니다: " + verification.errors.join(" / "));
  var impact = Backup_buildRestoreImpact_(SpreadsheetApp.getActiveSpreadsheet(), backupSpreadsheet);
  var previewToken = createUniqueId_("RESTOREPREVIEW");
  CacheService.getUserCache().put("BACKUP_RESTORE_" + previewToken, JSON.stringify({
    fileId: file.getId(), lastUpdated: file.getLastUpdated().getTime(), currentFingerprint:impact.currentFingerprint
  }), 600);
  return { previewToken: previewToken, fileId: file.getId(), name: file.getName(), sheets: verification.sheets, impact:impact };
}

function Backup_replaceManagedData_(source, target) {
  var names = Backup_getManagedSheetNames_(source);
  names.forEach(function(sheetName) {
    var sourceSheet = source.getSheetByName(sheetName);
    if (!sourceSheet) throw new Error("복구 원본에 필수 시트가 없습니다: " + sheetName);
    var values = sourceSheet.getDataRange().getValues();
    if (sheetName === SHEET_NAMES.PAYMENTS) values = values.map(function(row) {
      var normalized = row.slice();
      normalized[PAYMENT_RETIRED_GROUP_COLUMN - 1] = "";
      return normalized;
    });
    var targetSheet = target.getSheetByName(sheetName) || target.insertSheet(sheetName);
    if (targetSheet.getMaxRows() < values.length) targetSheet.insertRowsAfter(targetSheet.getMaxRows(), values.length - targetSheet.getMaxRows());
    if (targetSheet.getMaxColumns() < values[0].length) targetSheet.insertColumnsAfter(targetSheet.getMaxColumns(), values[0].length - targetSheet.getMaxColumns());
    targetSheet.clearContents();
    targetSheet.getRange(1, 1, values.length, values[0].length).setValues(values);
    targetSheet.getRange(1, 1, 1, values[0].length).setFontWeight("bold");
    targetSheet.setFrozenRows(sourceSheet.getFrozenRows());
  });
}

function restoreBackupFromPreview(request) {
  var user = requireSuperAdmin_();
  request = request || {};
  if (String(request.confirmation || "").trim() !== "복구") throw new Error("확인 문구로 '복구'를 입력해야 합니다.");
  var token = String(request.previewToken || "").trim();
  var cached = CacheService.getUserCache().get("BACKUP_RESTORE_" + token);
  if (!cached) throw new Error("복구 미리보기 유효시간이 지났습니다. 다시 검증해주세요.");
  var preview = JSON.parse(cached);
  if (String(preview.fileId) !== String(request.fileId || "")) throw new Error("검증한 백업과 복구 요청이 다릅니다.");
  var sourceFile = Backup_requireCandidate_(preview.fileId);
  if (Number(preview.lastUpdated) !== sourceFile.getLastUpdated().getTime()) {
    throw new Error("미리보기 이후 백업 파일이 변경되었습니다. 다시 검증해주세요.");
  }
  var source = SpreadsheetApp.openById(sourceFile.getId());
  var sourceVerification = Backup_verifySpreadsheet_(source);
  if (!sourceVerification.valid) throw new Error("복구 직전 백업 재검증에 실패했습니다: " + sourceVerification.errors.join(" / "));

  // 일반 데이터 변경과 같은 문서 잠금을 사용해 영향 미리보기 확인 후 복구 사이의 변경을 차단합니다.
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  var rollback = null;
  try {
    var target = SpreadsheetApp.getActiveSpreadsheet();
    var impact = Backup_buildRestoreImpact_(target, source);
    if (String(preview.currentFingerprint || "") !== String(impact.currentFingerprint || "")) {
      throw new Error("복구 미리보기 이후 운영 데이터가 변경되었습니다. 영향 건수를 다시 확인해주세요.");
    }
    rollback = Backup_createVerifiedCopy_("복구전");
    try {
      Backup_replaceManagedData_(source, target);
      var after = Backup_verifySpreadsheet_(target);
      if (!after.valid) throw new Error("복구 후 구조 검증 실패: " + after.errors.join(" / "));
      var restoreComparison = Backup_compareManifests_(sourceVerification, after);
      if (!restoreComparison.matches) {
        throw new Error("복구 후 관리 데이터 내용 검증에 실패했습니다: " + restoreComparison.errors.join(" / "));
      }
    } catch (restoreError) {
      try { Backup_replaceManagedData_(SpreadsheetApp.openById(rollback.fileId), target); }
      catch (rollbackError) { throw new Error("복구 실패 후 자동 원상복구도 실패했습니다. 복구 오류: " + restoreError.message + " / 원상복구 오류: " + rollbackError.message); }
      throw new Error("복구에 실패하여 복구 전 자동 백업으로 원상복구했습니다: " + restoreError.message);
    }
    Backup_getManagedSheetNames_(source).forEach(function(name) { DataRepository_clearCache_(name); });
    MonthlyCache_markAllDirty_();
    MonthlySnapshotStore_markAllStale_();
    OperationalSettings_clearCache_();
    // 삭제된 시트를 백업으로 복원하면 ID가 달라집니다. 검증된 복구 결과에만 새 기준을 적용합니다.
    DataSchema_captureManagedStructure_();
    Mutation_recordEvents_([{
      eventType: "백업복구", targetType: "시스템", targetId: sourceFile.getId(),
      field: "관리DB복구", before: rollback.fileId, after: sourceFile.getId(),
      memo: "복구 원본: " + sourceFile.getName() + " / 자동 롤백 백업: " + rollback.backupName +
        " / 사라짐:" + impact.totals.willDisappear + " / 복구:" + impact.totals.willRestore + " / 되돌림:" + impact.totals.willRevert
    }]);
    PropertiesService.getScriptProperties().setProperty("BACKUP_LAST_RESTORE", JSON.stringify({
      completedAt: new Date().toISOString(), restoredFromFileId: sourceFile.getId(), restoredFromName: sourceFile.getName(),
      rollbackFileId: rollback.fileId, rollbackName: rollback.backupName, restoredBy: user.email, impact:impact
    }));
    CacheService.getUserCache().remove("BACKUP_RESTORE_" + token);
    return { message: "관리 DB 시트 복구 및 검증을 완료했습니다.", restoredFrom: sourceFile.getName(),
      rollbackBackup: rollback.backupName, rollbackBackupUrl:rollback.fileUrl,
      backupFolderUrl:rollback.folderUrl, impact:impact };
  } finally {
    lock.releaseLock();
  }
}

/** 매일 백업·대기 이벤트 복구를 실행하고 일요일에만 휴지통을 정리합니다. */
function Maintenance_requireRegisteredTimeTrigger_(event) {
  if (!event || !event.triggerUid) {
    throw new Error("자동 운영은 등록된 시간 트리거에서만 실행할 수 있습니다.");
  }
  var registered = ScriptApp.getProjectTriggers().some(function(trigger) {
    return trigger.getHandlerFunction() === "runScheduledMaintenance" &&
      trigger.getEventType() === ScriptApp.EventType.CLOCK &&
      String(trigger.getUniqueId()) === String(event.triggerUid);
  });
  if (!registered) throw new Error("등록되지 않은 자동 운영 트리거 호출을 차단했습니다.");
}

function runScheduledMaintenance(event) {
  Maintenance_requireRegisteredTimeTrigger_(event);
  requireAutomationSuperAdmin_();
  var result = { startedAt: new Date().toISOString(), backup: "", pendingEvents: "", expiredAuthRecords:0,
    expiredMonthlySnapshots:0, trash: "건너뜀", errors: [] };
  try { result.pendingEvents = Mutation_retryPendingEvents_(); } catch (pendingError) { result.errors.push("대기 이벤트: " + pendingError.message); }
  try { result.expiredAuthRecords = AccessSession_cleanupExpired_(); } catch (authCleanupError) { result.errors.push("인증 기록 정리: " + authCleanupError.message); }
  try { result.expiredMonthlySnapshots = MonthlySnapshotStore_purgeOld_(48); }
  catch (snapshotCleanupError) { result.errors.push("월별 스냅샷 정리: " + snapshotCleanupError.message); }
  if (Backup_shouldCreate_()) {
    try {
      var scheduledBackup = Backup_createDailyBackup_();
      result.backup = scheduledBackup.backupName;
      var backupState = JSON.parse(PropertiesService.getScriptProperties().getProperty("MAINTENANCE_LAST_BACKUP") || "null");
      if (!backupState || !backupState.verification || !backupState.verification.valid || !backupState.verification.copyMatchesSource) {
        result.errors.push("백업: 복사본은 생성했지만 DB 구조 검증 경고가 있어 자동 복구용으로 사용할 수 없습니다.");
      }
    } catch (backupError) { result.errors.push("백업: " + backupError.message); }
  } else {
    result.backup = OperationalSettings_getNumber_("BACKUP_INTERVAL_DAYS", BACKUP_INTERVAL_DAYS) + "일 백업 주기 대기";
  }
  if (new Date().getDay() === 0) {
    try { result.trash = PaymentLifecycle_purgeExpiredTrash_(); } catch (trashError) { result.errors.push("휴지통: " + trashError.message); }
  }
  result.completedAt = new Date().toISOString();
  PropertiesService.getScriptProperties().setProperty("MAINTENANCE_LAST_RESULT", JSON.stringify(result));
  if (result.errors.length) throw new Error("자동 운영 일부 실패: " + result.errors.join(" / "));
  return result;
}

function installMaintenanceTrigger() {
  requireSpreadsheetSuperAdmin_();
  requireAutomationSuperAdmin_();
  withDocumentLock_(function() {
    DataSchema_assertManagedStructure_();
    DataSchema_captureManagedStructure_();
    var handlers = { createDailyBackup:true, purgeExpiredTrash:true, runScheduledMaintenance:true, DataMutation_onSpreadsheetChange_:true };
    var previous = ScriptApp.getProjectTriggers().filter(function(trigger) {
      if (trigger.getHandlerFunction() === "DataMutation_onSpreadsheetChange_") {
        return DataMutation_structureTriggers_([trigger], SpreadsheetApp.getActiveSpreadsheet().getId()).length > 0;
      }
      return handlers[trigger.getHandlerFunction()];
    });
    var created = [];
    try {
      created.push(ScriptApp.newTrigger("runScheduledMaintenance").timeBased().everyDays(1).atHour(4).create());
      created.push(ScriptApp.newTrigger("DataMutation_onSpreadsheetChange_")
        .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet()).onChange().create());
    } catch (error) {
      created.forEach(function(trigger) { try { ScriptApp.deleteTrigger(trigger); } catch (ignoredCleanupError) {} });
      throw error;
    }
    // 새 트리거를 모두 만든 뒤 기존 것만 교체하여 설치 실패 때 기존 자동 운영을 보존합니다.
    previous.forEach(function(trigger) { ScriptApp.deleteTrigger(trigger); });
  });
  return "자동 운영 트리거를 설치했습니다. 매일 새벽 4시 대기 이벤트를 처리하고, " +
    OperationalSettings_getNumber_("BACKUP_INTERVAL_DAYS", BACKUP_INTERVAL_DAYS) + "일마다 백업하며, 일요일에는 휴지통도 정리합니다. " +
    "시트 구조 변경 감시도 설치했습니다. 직접 행·열·시트 변경 시 캐시를 갱신하고 감사 기록을 남깁니다.";
}

function showMaintenanceStatus() {
  requireSpreadsheetSuperAdmin_();
  var properties = PropertiesService.getScriptProperties();
  var lastResult = null;
  var lastBackup = null;
  try { lastResult = JSON.parse(properties.getProperty("MAINTENANCE_LAST_RESULT") || "null"); } catch (ignoredResultError) {}
  try { lastBackup = JSON.parse(properties.getProperty("MAINTENANCE_LAST_BACKUP") || "null"); } catch (ignoredBackupError) {}
  var triggers = ScriptApp.getProjectTriggers().filter(function(trigger) {
    return trigger.getHandlerFunction() === "runScheduledMaintenance";
  });
  var structureTriggers = DataMutation_structureTriggers_(ScriptApp.getProjectTriggers(), SpreadsheetApp.getActiveSpreadsheet().getId());
  var lines = [
    "자동 운영 트리거: " + (triggers.length ? "설치됨 (" + triggers.length + "개)" : "미설치"),
    "시트 구조 감시 트리거: " + (structureTriggers.length ? "설치됨 (" + structureTriggers.length + "개)" : "미설치 · 설치/갱신 필요"),
    "최근 전체 실행: " + (lastResult && lastResult.completedAt ? lastResult.completedAt : "기록 없음"),
    "최근 백업: " + (lastBackup && lastBackup.completedAt ? lastBackup.completedAt : "기록 없음"),
    "최근 백업 파일: " + (lastBackup && lastBackup.backupName ? lastBackup.backupName : "기록 없음")
  ];
  if (lastResult && lastResult.errors && lastResult.errors.length) {
    lines.push("최근 오류: " + lastResult.errors.join(" / "));
  }
  SpreadsheetApp.getUi().alert("자동 운영 상태", lines.join("\n"), SpreadsheetApp.getUi().ButtonSet.OK);
  return { triggerCount: triggers.length, structureTriggerCount:structureTriggers.length, lastResult: lastResult, lastBackup: lastBackup };
}
