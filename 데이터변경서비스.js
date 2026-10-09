var EVENT_HEADERS = [
  "이벤트ID", "생성일시", "적용일", "이벤트유형", "대상유형", "대상ID", "학생ID",
  "변경항목", "변경전", "변경후", "참조ID", "요청ID", "그룹ID", "작업자이메일",
  "처리상태", "취소대상이벤트ID", "사유/메모", "스키마버전"
];

function Mutation_getEventSheet_() {
  return DataSchema_ensureSheet_(SHEET_NAMES.EVENTS).sheet;
}

function Mutation_buildEventRow_(event, user, now) {
  event = event || {};
  var eventId = event.eventId || createUniqueId_("EVT");
  var effectiveDate = event.effectiveDate ? requireDateString_(event.effectiveDate, "이벤트 적용일") : formatDateOnly_(now);
  return [
    eventId, now, effectiveDate,
    requireText_(event.eventType, "이벤트 유형", 50),
    requireText_(event.targetType, "대상 유형", 30),
    requireText_(event.targetId, "대상 ID", 120),
    optionalText_(event.studentId, 120),
    requireText_(event.field, "변경 항목", 80),
    safeSheetText_(event.before, 1000),
    safeSheetText_(event.after, 1000),
    optionalText_(event.refId, 500),
    optionalText_(event.requestId, 120),
    optionalText_(event.groupId, 120),
    user.email,
    event.status || "완료",
    optionalText_(event.cancelEventId, 120),
    safeSheetText_(event.memo, 1000),
    "1"
  ];
}

function Mutation_recordEvents_(events, authorizedUser) {
  events = events || [];
  if (!events.length) return [];
  // 변경 파이프라인에서 이미 확인한 사용자는 다시 로그인 조회하지 않습니다.
  var user = authorizedUser || requireAuthorizedUser_();
  var now = new Date();
  var rows = events.map(function(event) { return Mutation_buildEventRow_(event, user, now); });
  try {
    var sheet = Mutation_getEventSheet_();
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, EVENT_HEADERS.length).setValues(rows);
  } catch (error) {
    // 데이터 변경 후 로그 시트만 일시 실패한 경우 감사 이벤트를 잃지 않도록 재시도 큐에 보관합니다.
    var pending = {};
    rows.forEach(function(row) { pending["PENDING_EVENT_" + row[0]] = JSON.stringify(row); });
    PropertiesService.getScriptProperties().setProperties(pending, false);
    logError_("이벤트 기록 대기 전환 " + rows.length + "건", error);
    return rows.map(function(row) { return row[0]; });
  }
  try { DataRepository_clearCache_(SHEET_NAMES.EVENTS); } catch (cacheError) { logError_("이벤트 캐시 삭제", cacheError); }
  try { Mutation_retryPendingEvents_(); } catch (retryError) { logError_("대기 이벤트 후속 재시도", retryError); }
  return rows.map(function(row) { return row[0]; });
}

function Mutation_retryPendingEvents_() {
  var properties = PropertiesService.getScriptProperties();
  var all = properties.getProperties();
  var sheet = Mutation_getEventSheet_();
  var restored = 0;
  var duplicateCleared = 0;
  var existingIds = {};
  var pendingRows = [];
  var pendingKeys = [];
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().forEach(function(row) { existingIds[String(row[0])] = true; });
  }
  Object.keys(all).filter(function(key) { return key.indexOf("PENDING_EVENT_") === 0; }).forEach(function(key) {
    try {
      var row = JSON.parse(all[key]);
      if (existingIds[String(row[0])]) {
        properties.deleteProperty(key);
        duplicateCleared++;
        return;
      }
      if (row[1]) row[1] = new Date(row[1]);
      if (!Array.isArray(row) || row.length !== EVENT_HEADERS.length) {
        throw new Error("대기 이벤트 열 수가 올바르지 않습니다.");
      }
      pendingRows.push(row);
      pendingKeys.push(key);
      existingIds[String(row[0])] = true;
    } catch (error) { logError_("대기 이벤트 재기록 " + key, error); }
  });
  if (pendingRows.length) {
    try {
      sheet.getRange(sheet.getLastRow() + 1, 1, pendingRows.length, EVENT_HEADERS.length).setValues(pendingRows);
      pendingKeys.forEach(function(key) { properties.deleteProperty(key); });
      restored = pendingRows.length;
    } catch (batchError) {
      logError_("대기 이벤트 일괄 재기록", batchError);
    }
  }
  Mutation_invalidateTimelineCachesAfterRestore_(restored);
  return "대기 이벤트 " + restored + "건을 기록했습니다. (중복 대기 " + duplicateCleared + "건 정리)";
}

function Mutation_invalidateTimelineCachesAfterRestore_(restored) {
  if (!restored) return false;
  // 대기 이벤트는 원본 변경보다 늦게 복원될 수 있습니다. 그 사이 생성된 월 결과와
  // 영구 학생 스냅샷은 EVENTS 원본 세대번호만으로는 자동 폐기되지 않으므로 모두 갱신합니다.
  DataRepository_clearCache_(SHEET_NAMES.EVENTS);
  MonthlyCache_markAllDirty_();
  MonthlySnapshotStore_markAllStale_();
  return true;
}

function retryPendingEvents() {
  requireSuperAdmin_();
  return Mutation_retryPendingEvents_();
}

function Mutation_isCompletedBatchEventRow_(row, requestId) {
  return String((row || [])[IDX.EVENT.TYPE] || "") === "수납일괄등록" &&
    String((row || [])[IDX.EVENT.REQUEST_ID] || "") === String(requestId || "") &&
    String((row || [])[IDX.EVENT.STATUS] || "") === "완료";
}

function Mutation_findCompletedRequest_(requestId) {
  if (!requestId) return null;
  var targetRequestId = String(requestId);
  var persistedSummary = null;

  function resultFromMemo(memo) {
    var fallback = { message: "이미 처리된 수납 요청입니다.", savedRows: [], baseDayUpdates: {}, duplicate: true };
    try {
      var parsed = JSON.parse(String(memo || ""));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
    } catch (e) {
      return fallback;
    }
  }

  // 이벤트 시트 기록이 일시 실패해도 대기열에는 완성된 이벤트 행이 남습니다.
  var properties = PropertiesService.getScriptProperties().getProperties();
  var pendingKeys = Object.keys(properties).filter(function(key) { return key.indexOf("PENDING_EVENT_") === 0; });
  for (var p = 0; p < pendingKeys.length; p++) {
    try {
      var pendingRow = JSON.parse(properties[pendingKeys[p]]);
      if (Mutation_isCompletedBatchEventRow_(pendingRow, targetRequestId)) {
        var pendingResult = resultFromMemo(pendingRow[IDX.EVENT.MEMO]);
        if (pendingResult) {
          pendingResult.duplicate = true;
          if (Array.isArray(pendingResult.savedRows) && pendingResult.savedRows.length) return pendingResult;
          persistedSummary = pendingResult;
          break;
        }
      }
    } catch (pendingError) { logError_("대기 요청 ID 확인 " + pendingKeys[p], pendingError); }
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAMES.EVENTS);
  if (sheet && sheet.getLastRow() >= 2) {
    var indexedEvents = LookupIndex_findRows_(SHEET_NAMES.EVENTS, COL.EVENT.REQUEST_ID, targetRequestId);
    for (var i = indexedEvents.length - 1; i >= 0; i--) {
      var indexedEventRow = indexedEvents[i].row;
      if (Mutation_isCompletedBatchEventRow_(indexedEventRow, targetRequestId)) {
        var eventResult = resultFromMemo(indexedEventRow[IDX.EVENT.MEMO]);
        if (eventResult) {
          eventResult.duplicate = true;
          if (Array.isArray(eventResult.savedRows) && eventResult.savedRows.length) return eventResult;
          // 대기열에 남아 있는 새 지문을 구형 이벤트 요약으로 덮어쓰지 않습니다.
          if (!persistedSummary || !persistedSummary.requestFingerprint) persistedSummary = eventResult;
          break;
        }
      }
    }
  }

  // 이벤트와 캐시가 모두 유실돼도 원본 수납 행의 영구 요청 ID로 중복을 막습니다.
  var paySheet = ss.getSheetByName(SHEET_NAMES.PAYMENTS);
  var indexedPayments = paySheet && paySheet.getLastRow() >= 2
    ? LookupIndex_findRows_(SHEET_NAMES.PAYMENTS, COL.PAYMENT.REQUEST_ID, targetRequestId) : [];
  var savedRows = [];
  for (var r = 0; r < indexedPayments.length; r++) {
    var row = indexedPayments[r].row;
    if (LookupIndex_normalizeKey_(row[IDX.PAYMENT.REQUEST_ID]) !== LookupIndex_normalizeKey_(targetRequestId)) continue;
    if (String(row[IDX.PAYMENT.REQUEST_ID] || "") !== targetRequestId) continue;
    if (row[IDX.PAYMENT.RECORD_STATUS] && String(row[IDX.PAYMENT.RECORD_STATUS]) !== "ACTIVE") continue;
    var payDate = row[IDX.PAYMENT.PAY_DATE] instanceof Date
      ? row[IDX.PAYMENT.PAY_DATE]
      : parseDateOnly_(row[IDX.PAYMENT.PAY_DATE]);
    savedRows.push({
      payId: row[IDX.PAYMENT.ID], studentId: row[IDX.PAYMENT.STUDENT_ID], studentName: row[IDX.PAYMENT.STUDENT_NAME],
      date: payDate ? fastFormatDate(payDate, "MM-dd") : "",
      fullDate: payDate ? fastFormatDate(payDate, "yyyy-MM-dd") : String(row[IDX.PAYMENT.PAY_DATE] || ""),
      month: MonthlySnapshot_monthString_(row[IDX.PAYMENT.MONTH]), type: normalizePaymentType_(row[IDX.PAYMENT.TYPE]),
      amount: Number(row[IDX.PAYMENT.AMOUNT]) || 0, method: row[IDX.PAYMENT.METHOD], memo: row[IDX.PAYMENT.MEMO],
      calcType: row[IDX.PAYMENT.CALC_TYPE] || "", calcStart: formatDateOnly_(parseDateOnly_(row[IDX.PAYMENT.CALC_START])) || "",
      calcEnd: formatDateOnly_(parseDateOnly_(row[IDX.PAYMENT.CALC_END])) || "",
      activeDays: row[IDX.PAYMENT.ACTIVE_DAYS] == null ? "" : row[IDX.PAYMENT.ACTIVE_DAYS],
      billingDays: row[IDX.PAYMENT.BILLING_DAYS] == null ? "" : row[IDX.PAYMENT.BILLING_DAYS],
      siblingDiscount: row[IDX.PAYMENT.SIBLING_DISCOUNT] || 0,
      otherDiscount: row[IDX.PAYMENT.OTHER_DISCOUNT] || 0
    });
  }
  if (savedRows.length) {
    return {
      message: persistedSummary && persistedSummary.message
        ? persistedSummary.message
        : "이미 처리된 수납 요청입니다.",
      savedRows: savedRows,
      baseDayUpdates: persistedSummary && persistedSummary.baseDayUpdates
        ? persistedSummary.baseDayUpdates
        : {},
      requestFingerprint: String(persistedSummary && persistedSummary.requestFingerprint || ""),
      duplicate: true
    };
  }
  if (persistedSummary) {
    persistedSummary.savedRows = [];
    persistedSummary.baseDayUpdates = persistedSummary.baseDayUpdates || {};
    persistedSummary.duplicate = true;
    return persistedSummary;
  }
  return null;
}

/**
 * 시트를 직접 수정한 경우에는 공통 변경 파이프라인을 거치지 않으므로 캐시
 * 세대가 자동으로 바뀌지 않습니다. 단순 onEdit 트리거에서 원본은 건드리지
 * 않고 관련 조회 캐시만 보수적으로 무효화합니다.
 */
function DataMutation_managedEditSheetNames_() {
  return [
    SHEET_NAMES.STUDENTS, SHEET_NAMES.PAYMENTS, SHEET_NAMES.REQUESTS,
    SHEET_NAMES.VACATIONS, SHEET_NAMES.LOGS, SHEET_NAMES.EVENTS,
    SHEET_NAMES.TRASH, SHEET_NAMES.TEACHERS, SHEET_NAMES.USERS,
    SHEET_NAMES.SETTINGS, SHEET_NAMES.SALARY_SETTLEMENTS, SHEET_NAMES.SALARY_ENTRIES
  ];
}

function DataMutation_structureTriggers_(triggers, spreadsheetId) {
  return (triggers || []).filter(function(trigger) {
    return trigger.getHandlerFunction() === "DataMutation_onSpreadsheetChange_" &&
      trigger.getEventType() === ScriptApp.EventType.ON_CHANGE &&
      String(trigger.getTriggerSourceId()) === String(spreadsheetId);
  });
}

function DataMutation_isStructuralChange_(changeType) {
  return ["INSERT_ROW", "REMOVE_ROW", "INSERT_COLUMN", "REMOVE_COLUMN", "INSERT_GRID", "REMOVE_GRID", "OTHER"]
    .indexOf(String(changeType || "")) !== -1;
}

/** 설치형 트리거 전용. change 이벤트에는 변경 시트/범위가 없으므로 활성 시트를 추측하지 않습니다. */
function DataMutation_onSpreadsheetChange_(event) {
  if (!event || !event.triggerUid || !event.source) return { ignored:true };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (String(event.source.getId()) !== String(ss.getId())) return { ignored:true };
  var registered = DataMutation_structureTriggers_(ScriptApp.getProjectTriggers(), ss.getId()).some(function(trigger) {
    return String(trigger.getUniqueId()) === String(event.triggerUid);
  });
  if (!registered) return { ignored:true };
  // 편집자와 트리거 실행자는 다를 수 있습니다. 공개 RPC가 아닌 등록된 트리거에서만 실행자 확인을 합니다.
  var runnerEmail = getAutomationUserEmail_();
  if (!runnerEmail) throw new Error("시트 구조 감시 트리거는 복구 최고 원장 계정으로 설치해야 합니다.");
  var changeType = String(event.changeType || "");
  if (!DataMutation_isStructuralChange_(changeType) && changeType !== "EDIT") return { ignored:true };
  return withDocumentLock_(function() {
    var schemaError = "";
    try { DataSchema_assertManagedStructure_(); } catch (error) { schemaError = String(error.message || error); }
    // 값 편집은 기존 onEdit가 처리합니다. 헤더 손상이 확인된 편집만 구조 감사에 포함합니다.
    if (changeType === "EDIT" && !schemaError) return { ignored:true };
    var errors = [];
    function attempt(label, action) {
      try { action(); } catch (error) { errors.push(label + ": " + String(error.message || error)); }
    }
    DataMutation_managedEditSheetNames_().forEach(function(name) {
      attempt(name + " 캐시", function() { DataRepository_clearCache_(name); });
    });
    attempt("월별 캐시", MonthlyCache_markAllDirty_);
    attempt("월별 스냅샷", MonthlySnapshotStore_markAllStale_);
    attempt("운영 설정", OperationalSettings_clearCache_);
    attempt("홈 화면", markHomeDashboardDirty_);
    var editorEmail = "";
    try { editorEmail = String(event.user && event.user.getEmail() || ""); } catch (ignoredEditorError) {}
    var state = { changedAt:new Date().toISOString(), changeType:changeType,
      editorEmail:editorEmail, runnerEmail:runnerEmail, schemaError:schemaError.substring(0, 1500), errors:errors };
    attempt("감사 기록", function() {
      Mutation_recordEvents_([{
        eventType:"시트구조직접변경", targetType:"시스템", targetId:ss.getId(), field:"스프레드시트 구조",
        before:"", after:changeType,
        memo:JSON.stringify({ editorEmail:editorEmail || "Google에서 제공하지 않음", runnerEmail:runnerEmail,
          scope:"파일 전체 감지: 변경 시트·범위·삭제 전 값은 제공되지 않음",
          schemaError:schemaError.substring(0, 400), guidance:"직접 삭제 자료는 버전 기록·휴지통·백업과 대조" })
      }], { email:runnerEmail });
    });
    PropertiesService.getScriptProperties().setProperty("MANAGED_STRUCTURE_LAST_CHANGE_V1", JSON.stringify(state));
    if (errors.length) throw new Error("시트 구조 변경 후 처리 일부 실패: " + errors.join(" / "));
    return state;
  });
}

function onEdit(event) {
  try {
    var range = event && event.range;
    var sheet = range && range.getSheet();
    if (!sheet) return;
    var sheetName = sheet.getName();
    var managed = {};
    DataMutation_managedEditSheetNames_().forEach(function(name) { managed[name] = true; });
    if (!managed[sheetName]) return;
    DataRepository_clearCache_(sheetName);
    MonthlyCache_markAllDirty_();
    if (sheetName === SHEET_NAMES.VACATIONS || sheetName === SHEET_NAMES.LOGS || sheetName === SHEET_NAMES.EVENTS) {
      MonthlySnapshotStore_markAllStale_();
    }
    try { markHomeDashboardDirty_(); } catch (ignoredHomeDirtyError) {}
  } catch (error) {
    console.warn("[직접 시트 수정 캐시 갱신 실패] " + (error && error.stack ? error.stack : error));
  }
}
