/**
 * 원본 DB를 대체하지 않는 학생·월 파생 스냅샷 저장소입니다.
 * 원본 세대번호나 날짜가 바뀌면 서명이 달라져 기존 행은 자동으로 무시됩니다.
 */
var MONTHLY_SNAPSHOT_STORE_SHEET = "_CACHE_월별스냅샷";
var MONTHLY_SNAPSHOT_STORE_HEADERS = ["스냅샷ID", "조회월", "학생ID", "원본버전", "계산결과JSON", "생성일시"];
var MONTHLY_SNAPSHOT_STORE_VERSION = "MONTHLY_FACTS_V2";
var MONTHLY_SNAPSHOT_REFRESH_PREFIX = "MONTHLY_SNAPSHOT_REFRESH_V1_";
var MONTHLY_SNAPSHOT_GLOBAL_REFRESH_KEY = "MONTHLY_SNAPSHOT_GLOBAL_REFRESH_V1";
var MONTHLY_SNAPSHOT_ENABLED_KEY = "MONTHLY_SNAPSHOT_STORE_ENABLED_V1";
var MONTHLY_SNAPSHOT_PREFLIGHT_KEY = "MONTHLY_SNAPSHOT_PREFLIGHT_V1";
// Google Sheets 셀 한도보다 여유를 두어, 비정상적으로 커진 학생 1명의 JSON이
// 해당 월 전체 스냅샷 교체를 중간 실패로 만들지 않도록 합니다.
var MONTHLY_SNAPSHOT_MAX_FACT_CHARS = 45000;

function MonthlySnapshotStore_isEnabled_() {
  return PropertiesService.getScriptProperties().getProperty(MONTHLY_SNAPSHOT_ENABLED_KEY) === "true";
}

function MonthlySnapshotStore_sourceVersion_(targetYm) {
  var properties = PropertiesService.getScriptProperties().getProperties();
  // 휴가처럼 월 범위가 명확한 원본은 월별 세대번호로 구분합니다. 시트 전체
  // 세대번호를 넣으면 한 달의 휴가 수정만으로 모든 과거 스냅샷이 폐기됩니다.
  var dependencies = [SHEET_NAMES.STUDENTS, SHEET_NAMES.TEACHERS, SHEET_NAMES.SETTINGS];
  var generations = dependencies.map(function(sheetName) {
    return Number(properties[DataRepository_generationKey_(sheetName)] || 0) || 0;
  });
  var globalRefresh = Number(properties[MONTHLY_SNAPSHOT_GLOBAL_REFRESH_KEY] || 0) || 0;
  generations.push(Number(properties[MONTHLY_SNAPSHOT_REFRESH_PREFIX + String(targetYm).replace(/[^0-9]/g, "")] || 0) || 0);
  var timeBucket = MonthlyCache_timeBucketForMonths_([targetYm]);
  return [MONTHLY_SNAPSHOT_STORE_VERSION, targetYm, timeBucket,
    "SG" + globalRefresh].concat(generations).join("_");
}

function MonthlySnapshotStore_markMonthsStale_(months) {
  CacheVersion_withLock_(function() {
    var properties = PropertiesService.getScriptProperties(), all = properties.getProperties(), update = {};
    (months || []).forEach(function(month) {
      var ym = MonthlySnapshot_monthString_(month);
      if (!ym) return;
      var key = MONTHLY_SNAPSHOT_REFRESH_PREFIX + ym.replace(/[^0-9]/g, "");
      update[key] = String((Number(all[key] || 0) || 0) + 1);
    });
    if (Object.keys(update).length) properties.setProperties(update, false);
  });
}

function MonthlySnapshotStore_markAllStale_() {
  CacheVersion_withLock_(function() {
    var properties = PropertiesService.getScriptProperties();
    var current = Number(properties.getProperty(MONTHLY_SNAPSHOT_GLOBAL_REFRESH_KEY) || 0) || 0;
    properties.setProperty(MONTHLY_SNAPSHOT_GLOBAL_REFRESH_KEY, String(current + 1));
  });
}

function MonthlySnapshotStore_getSheet_(createIfMissing) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(MONTHLY_SNAPSHOT_STORE_SHEET);
  if (!sheet && createIfMissing) {
    sheet = ss.insertSheet(MONTHLY_SNAPSHOT_STORE_SHEET);
    sheet.getRange(1, 1, 1, MONTHLY_SNAPSHOT_STORE_HEADERS.length).setValues([MONTHLY_SNAPSHOT_STORE_HEADERS]);
    sheet.setFrozenRows(1);
    sheet.hideSheet();
  }
  if (!sheet) return null;
  var headers = sheet.getRange(1, 1, 1, MONTHLY_SNAPSHOT_STORE_HEADERS.length).getDisplayValues()[0];
  if (headers.join("|") !== MONTHLY_SNAPSHOT_STORE_HEADERS.join("|")) return null;
  return sheet;
}

function MonthlySnapshotStore_dateValue_(value) {
  if (!value) return null;
  var date = value instanceof Date ? value : new Date(value);
  return isNaN(date.getTime()) ? null : date.getTime();
}

function MonthlySnapshotStore_toFact_(student) {
  return {
    // currentState는 오늘 날짜가 바뀌면 원본 변경 없이도 달라질 수 있으므로
    // 저장하지 않고 조회할 때 최신 이벤트 이력으로 다시 계산합니다.
    state:student.state,
    firstDate:MonthlySnapshotStore_dateValue_(student.firstDate),
    exitDate:MonthlySnapshotStore_dateValue_(student.exitDate),
    excludedByEarlyExit:!!student.excludedByEarlyExit, inMonth:!!student.inMonth,
    validStart:MonthlySnapshotStore_dateValue_(student.validStart),
    validEnd:MonthlySnapshotStore_dateValue_(student.validEnd),
    activeDays:Number(student.activeDays) || 0, vacationDays:Number(student.vacationDays) || 0,
    retirementGapDays:Number(student.retirementGapDays) || 0, absenceDays:Number(student.absenceDays) || 0,
    teacherOwnerships:(student.teacherOwnerships || []).map(function(item) {
      return { teacher:item.teacher || "", teacherId:item.teacherId || "",
        start:MonthlySnapshotStore_dateValue_(item.start), end:MonthlySnapshotStore_dateValue_(item.end) };
    }),
    baseFee:Number(student.baseFee) || 0, siblingDiscount:Number(student.siblingDiscount) || 0,
    billableFee:Number(student.billableFee) || 0, courseMode:student.courseMode || "", specialOnly:!!student.specialOnly
  };
}

function MonthlySnapshotStore_fromFact_(fact) {
  fact = fact || {};
  function date(value) { return value == null ? null : new Date(Number(value)); }
  return {
    state:fact.state || {},
    firstDate:date(fact.firstDate), exitDate:date(fact.exitDate),
    excludedByEarlyExit:!!fact.excludedByEarlyExit, inMonth:!!fact.inMonth,
    validStart:date(fact.validStart), validEnd:date(fact.validEnd),
    activeDays:Number(fact.activeDays) || 0, vacationDays:Number(fact.vacationDays) || 0,
    retirementGapDays:Number(fact.retirementGapDays) || 0, absenceDays:Number(fact.absenceDays) || 0,
    teacherOwnerships:(fact.teacherOwnerships || []).map(function(item) {
      return { teacher:item.teacher || "", teacherId:item.teacherId || "",
        start:date(item.start), end:date(item.end) };
    }),
    baseFee:Number(fact.baseFee) || 0, siblingDiscount:Number(fact.siblingDiscount) || 0,
    billableFee:Number(fact.billableFee) || 0, courseMode:fact.courseMode || "", specialOnly:!!fact.specialOnly
  };
}

function MonthlySnapshotStore_serializeFact_(student) {
  var payload = JSON.stringify(MonthlySnapshotStore_toFact_(student));
  return payload.length <= MONTHLY_SNAPSHOT_MAX_FACT_CHARS ? payload : null;
}

/** 저장본 사용 전후의 월별 조회 결과에서 화면 계산에 영향을 주는 값만 비교합니다. */
function MonthlySnapshotStore_parityPayload_(snapshot) {
  var paymentSummary = MonthlySnapshot_buildPaymentSummary_(snapshot, snapshot.targetYm);
  var studentPayload = (snapshot.students || []).map(function(student) {
    return {
      id:student.id,
      fact:MonthlySnapshotStore_toFact_(student),
      currentState:student.currentState || {},
      paymentSummary:paymentSummary[student.id] || null,
      displayEntries:MonthlySnapshot_getDisplayEntries_(snapshot, student.id, snapshot.targetYm)
    };
  });
  return {
    targetYm:snapshot.targetYm, billingDays:snapshot.billingDays,
    students:studentPayload,
    teachers:snapshot.teachers || [], teachersInMonth:snapshot.teachersInMonth || [],
    specialOnlyPaymentByStudent:snapshot.specialOnlyPaymentByStudent || {},
    tuitionReceivedAmountByStudent:snapshot.tuitionReceivedAmountByStudent || {},
    proratedTuitionAmountByStudent:snapshot.proratedTuitionAmountByStudent || {}
  };
}

function MonthlySnapshotStore_expectedStudentIds_(prepared) {
  var ids = [];
  for (var i = 1; i < (prepared.studentRows || []).length; i++) {
    var id = String(prepared.studentRows[i][IDX.STUDENT.ID] || "").trim();
    if (id) ids.push(id);
  }
  return ids;
}

function MonthlySnapshotStore_readRowsDirect_(sheet, targetYm) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  var width = Math.max(MONTHLY_SNAPSHOT_STORE_HEADERS.length, sheet.getLastColumn());
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    var rowYm = MonthlySnapshot_monthString_(values[i][1]);
    if (rowYm === targetYm) rows.push({ rowNumber:i + 2, row:values[i] });
  }
  return rows;
}

function MonthlySnapshotStore_read_(targetYm, prepared, allowPersistent, forceForDiagnostics) {
  var version = MonthlySnapshotStore_sourceVersion_(targetYm);
  if (!allowPersistent) return { facts:null, status:"partial_context", sourceVersion:version };
  if (!forceForDiagnostics && !MonthlySnapshotStore_isEnabled_()) {
    return { facts:null, status:"disabled", sourceVersion:version };
  }
  var sheet = MonthlySnapshotStore_getSheet_(false);
  if (!sheet || sheet.getLastRow() < 2) return { facts:null, status:"store_miss", sourceVersion:version };
  var expectedIds = MonthlySnapshotStore_expectedStudentIds_(prepared);
  var rows = LookupIndex_findRows_(MONTHLY_SNAPSHOT_STORE_SHEET, 2, targetYm, false);
  // 방금 쓴 월 행이 조회 인덱스 캐시에 아직 반영되지 않은 경우, 빈 결과는
  // 일반 인덱스의 행 불일치 자가복구 조건에 걸리지 않습니다. 기대 학생 수를
  // 알고 있는 스냅샷 읽기에서는 한 번 강제 재생성해 정상 행을 놓치지 않습니다.
  if (rows.length !== expectedIds.length) {
    rows = LookupIndex_findRows_(MONTHLY_SNAPSHOT_STORE_SHEET, 2, targetYm, true);
  }
  // CacheService 또는 조회 인덱스가 연속으로 누락돼도 실제 저장 행을 마지막으로
  // 직접 대조합니다. 정상 경로에서는 실행되지 않으며 원본 DB를 수정하지 않습니다.
  if (rows.length !== expectedIds.length) {
    rows = MonthlySnapshotStore_readRowsDirect_(sheet, targetYm);
  }
  if (rows.length !== expectedIds.length) return { facts:null, status:"row_count_miss", sourceVersion:version };
  var expected = {}; expectedIds.forEach(function(id) { expected[id] = true; });
  var facts = {};
  try {
    rows.forEach(function(item) {
      var row = item.row;
      var studentId = String(row[2] || "").trim();
      if (!expected[studentId] || String(row[3] || "") !== version || facts[studentId]) throw new Error("invalid");
      facts[studentId] = MonthlySnapshotStore_fromFact_(JSON.parse(String(row[4] || "{}")));
    });
  } catch (error) {
    return { facts:null, status:"payload_invalid", sourceVersion:version };
  }
  return { facts:facts, status:"persistent_hit", sourceVersion:version };
}

function MonthlySnapshotStore_write_(targetYm, students, allowPersistent, expectedSourceVersion, forceForDiagnostics) {
  if (!allowPersistent || !students || !students.length) return "not_stored";
  if (!forceForDiagnostics && !MonthlySnapshotStore_isEnabled_()) return "disabled";
  var serializedPayloads = [];
  for (var payloadIndex = 0; payloadIndex < students.length; payloadIndex++) {
    var serialized = MonthlySnapshotStore_serializeFact_(students[payloadIndex]);
    if (serialized == null) {
      return "payload_too_large_" + String(students[payloadIndex].id || "unknown").substring(0, 40);
    }
    serializedPayloads.push(serialized);
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return "lock_busy";
  try {
    var sheet = MonthlySnapshotStore_getSheet_(true);
    if (!sheet) return "schema_invalid";
    var version = MonthlySnapshotStore_sourceVersion_(targetYm);
    if (expectedSourceVersion && version !== expectedSourceVersion) return "source_changed";
    var createdAt = new Date();
    var rowsToWrite = [];
    for (var studentIndex = 0; studentIndex < students.length; studentIndex++) {
      var student = students[studentIndex];
      rowsToWrite.push([targetYm + "|" + student.id, targetYm, student.id, version,
        serializedPayloads[studentIndex], createdAt]);
    }

    // 한 달 갱신 때문에 캐시 시트 전체를 지우고 다시 쓰지 않습니다. 기존 월 행이
    // 연속이면 그 구간만 교체하고, 행 수가 달라진 경우에만 해당 구간을 삭제한 뒤
    // 끝에 추가합니다. 다른 월 스냅샷은 그대로 유지됩니다.
    var lastRow = sheet.getLastRow();
    var monthValues = lastRow > 1 ? sheet.getRange(2, 2, lastRow - 1, 1).getDisplayValues() : [];
    var rowNumbers = [];
    for (var i = 0; i < monthValues.length; i++) {
      if (String(monthValues[i][0] || "") === targetYm) rowNumbers.push(i + 2);
    }
    var contiguous = rowNumbers.every(function(rowNumber, index) {
      return index === 0 || rowNumber === rowNumbers[index - 1] + 1;
    });
    if (rowNumbers.length === rowsToWrite.length && contiguous) {
      sheet.getRange(rowNumbers[0], 1, rowsToWrite.length, MONTHLY_SNAPSHOT_STORE_HEADERS.length).setValues(rowsToWrite);
    } else {
      if (rowNumbers.length) {
        if (contiguous) sheet.deleteRows(rowNumbers[0], rowNumbers.length);
        else {
          for (var ri = rowNumbers.length - 1; ri >= 0; ri--) sheet.deleteRow(rowNumbers[ri]);
        }
      }
      var appendAt = sheet.getLastRow() + 1;
      var requiredLastRow = appendAt + rowsToWrite.length - 1;
      if (requiredLastRow > sheet.getMaxRows()) {
        sheet.insertRowsAfter(sheet.getMaxRows(), requiredLastRow - sheet.getMaxRows());
      }
      sheet.getRange(appendAt, 1, rowsToWrite.length, MONTHLY_SNAPSHOT_STORE_HEADERS.length).setValues(rowsToWrite);
    }
    sheet.setFrozenRows(1);
    try { sheet.hideSheet(); } catch (ignoredHideError) {}
    DataRepository_clearCache_(MONTHLY_SNAPSHOT_STORE_SHEET);
    if (MonthlySnapshotStore_sourceVersion_(targetYm) !== version) return "source_changed_after_write";
    return "stored_" + students.length;
  } catch (error) {
    logError_("월별 스냅샷 저장", error);
    return "write_error";
  } finally {
    lock.releaseLock();
  }
}

function clearMonthlySnapshotStore() {
  requireSuperAdmin_();
  var sheet = MonthlySnapshotStore_getSheet_(false);
  if (!sheet) return { cleared:0 };
  var rows = Math.max(0, sheet.getLastRow() - 1);
  if (rows) sheet.getRange(2, 1, rows, sheet.getLastColumn()).clearContent();
  DataRepository_clearCache_(MONTHLY_SNAPSHOT_STORE_SHEET);
  PropertiesService.getScriptProperties().deleteProperty(MONTHLY_SNAPSHOT_PREFLIGHT_KEY);
  return { cleared:rows };
}

function MonthlySnapshotStore_purgeOld_(retentionMonths) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return 0;
  try {
  var sheet = MonthlySnapshotStore_getSheet_(false);
  if (!sheet || sheet.getLastRow() < 2) return 0;
  retentionMonths = Math.max(36, Number(retentionMonths) || 48);
  var cutoff = new Date(); cutoff = new Date(cutoff.getFullYear(), cutoff.getMonth() - retentionMonths, 1);
  var rows = sheet.getDataRange().getValues(), kept = [MONTHLY_SNAPSHOT_STORE_HEADERS.slice()], removed = 0;
  for (var i = 1; i < rows.length; i++) {
    var month = DateMoney_parseMonthStart(String(rows[i][1] || ""));
    if (month && month < cutoff) removed++;
    else kept.push(rows[i].slice(0, MONTHLY_SNAPSHOT_STORE_HEADERS.length));
  }
  if (!removed) return 0;
  sheet.clearContents();
  sheet.getRange(1, 1, kept.length, MONTHLY_SNAPSHOT_STORE_HEADERS.length).setValues(kept);
  sheet.getRange(1, 1, 1, MONTHLY_SNAPSHOT_STORE_HEADERS.length).setFontWeight("bold");
  DataRepository_clearCache_(MONTHLY_SNAPSHOT_STORE_SHEET);
  return removed;
  } finally {
    lock.releaseLock();
  }
}

function runMonthlySnapshotDiagnostics(targetYm) {
  requireSuperAdmin_();
  targetYm = requireMonthString_(targetYm || Dashboard_defaultTargetYm_(), "점검 월");
  var context = DataRepository_loadContext_([
    SHEET_NAMES.STUDENTS, SHEET_NAMES.PAYMENTS, SHEET_NAMES.VACATIONS, SHEET_NAMES.LOGS
  ], { required:false, fresh:true });
  context.__monthlySnapshotPartial = true;
  var calculated = MonthlySnapshot_build_(targetYm, context);
  delete context.__monthlySnapshotPartial;
  var writeStatus = MonthlySnapshotStore_write_(targetYm, calculated.students, true, null, true);
  var prepared = MonthlySnapshot_prepareContext_(context);
  var stored = MonthlySnapshotStore_read_(targetYm, prepared, true, true);
  var mismatches = [], mismatchCount = 0;
  calculated.students.forEach(function(student) {
    var expected = JSON.stringify(MonthlySnapshotStore_toFact_(student));
    var actualFact = stored.facts && stored.facts[student.id];
    var actual = actualFact ? JSON.stringify(MonthlySnapshotStore_toFact_(actualFact)) : "";
    if (expected !== actual) {
      mismatchCount++;
      if (mismatches.length < 10) mismatches.push({ studentId:student.id, studentName:student.name });
    }
  });
  context.__monthlySnapshotForceRead = true;
  var replayed = MonthlySnapshot_build_(targetYm, context);
  delete context.__monthlySnapshotForceRead;
  var outputParity = JSON.stringify(MonthlySnapshotStore_parityPayload_(calculated)) ===
    JSON.stringify(MonthlySnapshotStore_parityPayload_(replayed));
  return {
    targetYm:targetYm, students:calculated.students.length, writeStatus:writeStatus,
    readStatus:stored.status, mismatchCount:mismatchCount, mismatchSamples:mismatches,
    outputParity:outputParity,
    healthy:!!stored.facts && mismatchCount === 0 && outputParity
  };
}
