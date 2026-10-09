/**
 * DB_이벤트를 기존 시점 계산기가 사용하는 8열 호환 행으로 변환합니다.
 * DB_로그는 보관 완료 후에도 롤백 상황에서만 읽는 예비 원본입니다.
 */
function EventRepository_isCompleted_(row) {
  var status = String(row[IDX.EVENT.STATUS] || "완료").trim();
  return !status || status === "완료";
}

function EventRepository_canonicalField_(field) {
  var value = String(field || "").trim();
  var aliases = {
    "기준일 자동변경(수납)": "수납 기준일",
    "휴가 등록": "휴가기간",
    "현금영수증 정보 변경": "현금영수증",
    "형제 관계 변경": "형제관계"
  };
  return aliases[value] || value;
}

function EventRepository_signature_(row) {
  return [
    String(row[IDX.EVENT.STUDENT_ID] || row[IDX.EVENT.TARGET_ID] || "").trim(),
    EventRepository_canonicalField_(row[IDX.EVENT.FIELD]),
    formatDateOnly_(parseDateOnly_(row[IDX.EVENT.EFFECTIVE_DATE])) || "",
    String(row[IDX.EVENT.BEFORE] == null ? "" : row[IDX.EVENT.BEFORE]),
    String(row[IDX.EVENT.AFTER] == null ? "" : row[IDX.EVENT.AFTER])
  ].join("\u001f");
}

function EventRepository_toLegacyRows_(eventRows) {
  var header = ["생성일시", "학생명", "학생ID", "변경항목", "변경전", "변경후", "적용일", "참조ID"];
  if (!eventRows || eventRows.length <= 1) return [header];

  var nativeSignatures = {};
  for (var n = 1; n < eventRows.length; n++) {
    var nativeRow = eventRows[n];
    if (!EventRepository_isCompleted_(nativeRow)) continue;
    if (String(nativeRow[IDX.EVENT.TYPE] || "") === "기존로그이관") continue;
    nativeSignatures[EventRepository_signature_(nativeRow)] = true;
  }

  var seenEventIds = {};
  var seenSignatures = {};
  var output = [];
  for (var i = 1; i < eventRows.length; i++) {
    var row = eventRows[i];
    if (!EventRepository_isCompleted_(row)) continue;
    var eventId = String(row[IDX.EVENT.ID] || "").trim();
    if (eventId && seenEventIds[eventId]) continue;
    if (eventId) seenEventIds[eventId] = true;

    var studentId = String(row[IDX.EVENT.STUDENT_ID] || row[IDX.EVENT.TARGET_ID] || "").trim();
    var field = String(row[IDX.EVENT.FIELD] || "").trim();
    if (!studentId || !field) continue;

    var signature = EventRepository_signature_(row);
    var isMigratedLegacy = String(row[IDX.EVENT.TYPE] || "") === "기존로그이관";
    if (isMigratedLegacy && nativeSignatures[signature]) continue;
    if (seenSignatures[signature]) continue;
    seenSignatures[signature] = true;

    output.push({
      createdAt: row[IDX.EVENT.CREATED_AT],
      rowOrder: i,
      values: [
        row[IDX.EVENT.CREATED_AT],
        "",
        studentId,
        field,
        row[IDX.EVENT.BEFORE],
        row[IDX.EVENT.AFTER],
        row[IDX.EVENT.EFFECTIVE_DATE],
        row[IDX.EVENT.REF_ID]
      ]
    });
  }

  output.sort(function(a, b) {
    var ad = a.createdAt instanceof Date ? a.createdAt.getTime() : new Date(a.createdAt).getTime();
    var bd = b.createdAt instanceof Date ? b.createdAt.getTime() : new Date(b.createdAt).getTime();
    if (isNaN(ad)) ad = a.rowOrder;
    if (isNaN(bd)) bd = b.rowOrder;
    return (ad - bd) || (a.rowOrder - b.rowOrder);
  });
  return [header].concat(output.map(function(item) { return item.values; }));
}

function EventRepository_getLegacyRows_(options) {
  options = options || {};
  var useCache = !options.fresh && options.cache !== false;
  var cacheSignature = QueryResultCache_signature_("EVENT_LEGACY_VIEW_V1", "ALL", [SHEET_NAMES.EVENTS, SHEET_NAMES.LOGS]);
  if (useCache) {
    var cached = QueryResultCache_get_(cacheSignature, { maxChunks:30 });
    if (Array.isArray(cached) && cached.length) return cached;
  }
  var eventRows = DataRepository_getRows_(SHEET_NAMES.EVENTS, {
    required: false,
    fresh: !!options.fresh,
    cache: options.cache
  });
  if (eventRows && eventRows.length > 1) {
    var compatibleRows = EventRepository_toLegacyRows_(eventRows);
    var needsLegacyRefRecovery = compatibleRows.some(function(row, index) {
      return index > 0 && /^LEGACY-\d+$/.test(String(row[IDX.LOG.REF_ID] || ""));
    });
    if (needsLegacyRefRecovery) {
      var rawLegacyRows = DataRepository_getRowsRaw_(SHEET_NAMES.LOGS, { required: false });
      compatibleRows.forEach(function(row, index) {
        if (index === 0) return;
        var match = String(row[IDX.LOG.REF_ID] || "").match(/^LEGACY-(\d+)$/);
        if (!match) return;
        var sourceRowNumber = Number(match[1]);
        if (sourceRowNumber >= 2 && sourceRowNumber <= rawLegacyRows.length) {
          row[IDX.LOG.REF_ID] = rawLegacyRows[sourceRowNumber - 1][IDX.LOG.REF_ID] || "";
        }
      });
    }
    if (useCache) QueryResultCache_put_(cacheSignature, compatibleRows, 600, { maxChunks:30 });
    return compatibleRows;
  }

  // 전환 전·복구 상황에서 이벤트 시트가 비어 있으면 기존 로그를 안전하게 사용합니다.
  var fallbackRows = DataRepository_getRowsRaw_(SHEET_NAMES.LOGS, {
    required: false,
    fresh: !!options.fresh,
    cache: options.cache
  });
  if (useCache) QueryResultCache_put_(cacheSignature, fallbackRows, 600, { maxChunks:30 });
  return fallbackRows;
}

/** 특정 학생의 시점 계산에 필요한 이벤트만 읽습니다. 이벤트 전환 전 자료는 기존 로그로 대체합니다. */
function EventRepository_getLegacyRowsForStudents_(studentIds, forceRebuild) {
  var ids = (studentIds || []).map(function(id) { return String(id || "").trim(); }).filter(Boolean);
  var header = ["생성일시", "학생명", "학생ID", "변경항목", "변경전", "변경후", "적용일", "참조ID"];
  if (!ids.length) return [header];
  var eventSheet = DataRepository_getSheet_(SHEET_NAMES.EVENTS, false);
  if (eventSheet && eventSheet.getLastRow() > 1) {
    var compatibleRows = EventRepository_toLegacyRows_(
      LookupIndex_readTableForValues_(SHEET_NAMES.EVENTS, COL.EVENT.STUDENT_ID, ids, !!forceRebuild)
    );
    var needsLegacyRefRecovery = compatibleRows.some(function(row, index) {
      return index > 0 && /^LEGACY-\d+$/.test(String(row[IDX.LOG.REF_ID] || ""));
    });
    if (needsLegacyRefRecovery) {
      var rawLegacyRows = DataRepository_getRowsRaw_(SHEET_NAMES.LOGS, { required:false });
      compatibleRows.forEach(function(row, index) {
        if (index === 0) return;
        var match = String(row[IDX.LOG.REF_ID] || "").match(/^LEGACY-(\d+)$/);
        var sourceRowNumber = match ? Number(match[1]) : 0;
        if (sourceRowNumber >= 2 && sourceRowNumber <= rawLegacyRows.length) {
          row[IDX.LOG.REF_ID] = rawLegacyRows[sourceRowNumber - 1][IDX.LOG.REF_ID] || "";
        }
      });
    }
    return compatibleRows;
  }
  var wanted = {};
  ids.forEach(function(id) { wanted[id] = true; });
  var legacyRows = DataRepository_getRowsRaw_(SHEET_NAMES.LOGS, { required:false });
  if (!legacyRows.length) return [header];
  return [legacyRows[0]].concat(legacyRows.slice(1).filter(function(row) {
    return !!wanted[String(row[IDX.LOG.STUDENT_ID] || "").trim()];
  }));
}

function EventRepository_findBaseDayChange_(studentId, payId) {
  var rows = EventRepository_getLegacyRows_();
  var targetStudentId = String(studentId || "").trim();
  var targetPayId = String(payId || "").trim();
  for (var i = rows.length - 1; i >= 1; i--) {
    var item = String(rows[i][IDX.LOG.ITEM] || "").trim();
    if (String(rows[i][IDX.LOG.STUDENT_ID] || "").trim() !== targetStudentId) continue;
    if (item !== "기준일 자동변경(수납)" && item !== "수납 기준일") continue;
    var refIds = String(rows[i][IDX.LOG.REF_ID] || "").split(",").map(function(id) {
      return String(id).trim();
    }).filter(function(id) { return !!id; });
    if (refIds.indexOf(targetPayId) === -1) continue;
    return {
      before: rows[i][IDX.LOG.BEFORE],
      after: rows[i][IDX.LOG.AFTER],
      refIds: refIds
    };
  }
  return null;
}
