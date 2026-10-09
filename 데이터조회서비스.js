/**
 * 시트 조회와 캐시 직렬화를 한곳에서 관리하는 공통 저장소입니다.
 * 공개 서버 함수는 기존 파일에 유지하고, 내부 조회만 이 계층을 사용합니다.
 */
var DATA_REPOSITORY_CACHE_VERSION = "DR3";
var DATA_REPOSITORY_CACHE_CHUNK_CHARS = 30000;
var DATA_REPOSITORY_CACHE_MAX_CHUNKS = 20;
var QUERY_RESULT_CACHE_VERSION = "QUERY_RESULT_V1";
var QUERY_RESULT_CACHE_CHUNK_CHARS = 12000;
var QUERY_RESULT_CACHE_MAX_CHUNKS = 30;
var QueryResultCache_runtime_ = {};
// 성능 진단 복사본에서 기존 운영형 캐시를 건드리지 않고 독립된 콜드 키를 만들 때만 사용합니다.
var QueryResultCache_namespaceSalt_ = "";
// 같은 Apps Script 실행 안에서 같은 원본을 다시 요구하면 CacheService 청크를
// 재조립하지 않고 이미 검증한 행을 재사용합니다. 실행이 끝나면 전역도 함께 폐기됩니다.
var DataRepository_runtimeRows_ = {};
var MONTHLY_CACHE_GLOBAL_VERSION_KEY = "MONTHLY_CACHE_GLOBAL_VERSION_V1";
var MONTHLY_CACHE_MONTH_VERSION_PREFIX = "MONTHLY_CACHE_MONTH_VERSION_V1_";

/**
 * 캐시 세대번호는 여러 웹 요청이 동시에 변경할 수 있으므로 read-modify-write를
 * 반드시 스크립트 락 안에서 수행합니다. 이미 같은 실행이 락을 보유한 경우에는
 * 재진입하여 교착되지 않도록 그대로 실행합니다.
 */
function CacheVersion_withLock_(callback) {
  var lock = LockService.getScriptLock();
  var acquiredHere = false;
  try {
    if (!lock.hasLock()) {
      lock.waitLock(5000);
      acquiredHere = true;
    }
    return callback();
  } finally {
    if (acquiredHere && lock.hasLock()) lock.releaseLock();
  }
}

function MonthlyCache_timeBucketForMonths_(months) {
  var now = new Date();
  var currentYm = now.getFullYear() + "-" + ("0" + (now.getMonth() + 1)).slice(-2);
  var needsDailyRefresh = !(months || []).length || (months || []).some(function(month) {
    var ym = MonthlySnapshot_monthString_(month);
    return !ym || ym >= currentYm;
  });
  return needsDailyRefresh
    ? Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyyMMdd")
    : "HISTORICAL";
}

function MonthlyCache_monthKey_(targetYm) {
  return MONTHLY_CACHE_MONTH_VERSION_PREFIX + String(targetYm || "").replace(/[^0-9]/g, "");
}

function MonthlyCache_versions_(targetYm, allProperties) {
  allProperties = allProperties || PropertiesService.getScriptProperties().getProperties();
  return {
    global:Number(allProperties[MONTHLY_CACHE_GLOBAL_VERSION_KEY] || 0) || 0,
    month:Number(allProperties[MonthlyCache_monthKey_(targetYm)] || 0) || 0
  };
}

function MonthlyCache_incrementProperties_(keys) {
  CacheVersion_withLock_(function() {
    var properties = PropertiesService.getScriptProperties();
    var all = properties.getProperties(), update = {};
    (keys || []).forEach(function(key) { update[key] = String((Number(all[key] || 0) || 0) + 1); });
    if (Object.keys(update).length) properties.setProperties(update, false);
  });
  QueryResultCache_runtime_ = {};
}

function MonthlyCache_markMonthsDirty_(months) {
  var seen = {}, keys = [];
  (months || []).forEach(function(month) {
    var ym = MonthlySnapshot_monthString_(month);
    if (ym && !seen[ym]) { seen[ym] = true; keys.push(MonthlyCache_monthKey_(ym)); }
  });
  MonthlyCache_incrementProperties_(keys);
}

function MonthlyCache_markAllDirty_() {
  MonthlyCache_incrementProperties_([MONTHLY_CACHE_GLOBAL_VERSION_KEY]);
}

function MonthlyCache_monthsBetween_(startValue, endValue) {
  var start = MonthlySnapshot_parseDate_(startValue), end = MonthlySnapshot_parseDate_(endValue);
  if (!start || !end || start > end) return [];
  var cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  var last = new Date(end.getFullYear(), end.getMonth(), 1), result = [];
  while (cursor <= last && result.length < 240) {
    result.push(cursor.getFullYear() + "-" + ("0" + (cursor.getMonth() + 1)).slice(-2));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return result;
}

/** 여러 시트에 의존하는 완성 조회 결과의 공통 캐시 서명입니다. */
function QueryResultCache_signature_(namespace, discriminator, dependencies) {
  var properties = PropertiesService.getScriptProperties();
  var allProperties = properties.getProperties();
  var targetYm = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(discriminator || "")) ? String(discriminator) : "";
  var monthlyDependencies = {};
  [SHEET_NAMES.STUDENTS, SHEET_NAMES.PAYMENTS, SHEET_NAMES.VACATIONS, SHEET_NAMES.LOGS, SHEET_NAMES.EVENTS]
    .forEach(function(name) { monthlyDependencies[name] = true; });
  var generations = (dependencies || []).filter(function(sheetName) {
    return !(targetYm && monthlyDependencies[sheetName]);
  }).map(function(sheetName) {
    var value = Number(allProperties[DataRepository_generationKey_(sheetName)] || 0);
    return isFinite(value) && value >= 0 ? value : 0;
  });
  var day = MonthlyCache_timeBucketForMonths_(targetYm ? [targetYm] : []);
  var monthlyVersions = targetYm ? MonthlyCache_versions_(targetYm, allProperties) : null;
  var parts = [String(namespace), String(discriminator), day]
    .concat(monthlyVersions ? ["MG" + monthlyVersions.global, "MM" + monthlyVersions.month] : [])
    .concat(generations);
  if (QueryResultCache_namespaceSalt_) parts.push("S" + String(QueryResultCache_namespaceSalt_));
  return parts.join("_");
}

function QueryResultCache_signatureForMonths_(namespace, discriminator, months, dependencies) {
  var properties = PropertiesService.getScriptProperties().getProperties();
  var monthlyDependencies = {};
  [SHEET_NAMES.STUDENTS, SHEET_NAMES.PAYMENTS, SHEET_NAMES.VACATIONS, SHEET_NAMES.LOGS, SHEET_NAMES.EVENTS]
    .forEach(function(name) { monthlyDependencies[name] = true; });
  var generations = (dependencies || []).filter(function(name) { return !monthlyDependencies[name]; }).map(function(name) {
    return Number(properties[DataRepository_generationKey_(name)] || 0) || 0;
  });
  var globalVersion = Number(properties[MONTHLY_CACHE_GLOBAL_VERSION_KEY] || 0) || 0;
  var monthVersions = (months || []).map(function(ym) {
    return String(ym) + ":" + (Number(properties[MonthlyCache_monthKey_(ym)] || 0) || 0);
  });
  var day = MonthlyCache_timeBucketForMonths_(months || []);
  var versionPayload = ["MG" + globalVersion].concat(monthVersions).concat(generations).join("|");
  var versionHash = Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, versionPayload, Utilities.Charset.UTF_8
  )).replace(/=+$/, "").substring(0, 32);
  var parts = [String(namespace), String(discriminator), day, versionHash];
  if (QueryResultCache_namespaceSalt_) parts.push("S" + String(QueryResultCache_namespaceSalt_));
  return parts.join("_");
}

function QueryResultCache_baseKey_(signature) {
  return QUERY_RESULT_CACHE_VERSION + "_" + signature;
}

function QueryResultCache_read_(signature, options) {
  options = options || {};
  var maxChunks = Number(options.maxChunks) || QUERY_RESULT_CACHE_MAX_CHUNKS;
  try {
    if (Object.prototype.hasOwnProperty.call(QueryResultCache_runtime_, signature)) {
      return { value:QueryResultCache_runtime_[signature], status:"runtime_hit" };
    }
    var cache = CacheService.getScriptCache();
    var base = QueryResultCache_baseKey_(signature);
    var metaText = cache.get(base + "_META");
    if (!metaText) return { value: null, status: "meta_miss" };
    var meta = JSON.parse(metaText);
    if (meta.version !== QUERY_RESULT_CACHE_VERSION || meta.signature !== signature ||
        meta.chunks < 1 || meta.chunks > maxChunks) return { value: null, status: "meta_invalid" };
    var keys = [];
    for (var i = 0; i < meta.chunks; i++) keys.push(base + "_" + i);
    var entries = cache.getAll(keys);
    var text = "";
    for (var ci = 0; ci < keys.length; ci++) {
      if (entries[keys[ci]] == null) return { value: null, status: "chunk_miss_" + ci };
      text += entries[keys[ci]];
    }
    var parsed = JSON.parse(text);
    QueryResultCache_runtime_[signature] = parsed;
    return { value: parsed, status: "hit" };
  } catch (error) {
    console.warn("[공통 완성 결과 캐시 조회 실패] " + (error && error.stack ? error.stack : error));
    return { value: null, status: "read_error" };
  }
}

function QueryResultCache_get_(signature, options) {
  return QueryResultCache_read_(signature, options).value;
}

function QueryResultCache_write_(signature, result, ttlSeconds, options) {
  options = options || {};
  var maxChunks = Number(options.maxChunks) || QUERY_RESULT_CACHE_MAX_CHUNKS;
  try {
    var text = JSON.stringify(result);
    var chunkCount = Math.max(1, Math.ceil(text.length / QUERY_RESULT_CACHE_CHUNK_CHARS));
    if (chunkCount > maxChunks) return { stored: false, status: "too_large_" + chunkCount };
    var base = QueryResultCache_baseKey_(signature);
    var entries = {};
    for (var i = 0; i < chunkCount; i++) {
      entries[base + "_" + i] = text.substring(
        i * QUERY_RESULT_CACHE_CHUNK_CHARS,
        (i + 1) * QUERY_RESULT_CACHE_CHUNK_CHARS
      );
    }
    entries[base + "_META"] = JSON.stringify({
      version: QUERY_RESULT_CACHE_VERSION, signature: signature, chunks: chunkCount
    });
    CacheService.getScriptCache().putAll(entries, Number(ttlSeconds) || 600);
    QueryResultCache_runtime_[signature] = result;
    return { stored: true, status: "stored_" + chunkCount };
  } catch (error) {
    console.warn("[공통 완성 결과 캐시 저장 실패] " + (error && error.stack ? error.stack : error));
    return { stored: false, status: "write_error" };
  }
}

function QueryResultCache_put_(signature, result, ttlSeconds, options) {
  return QueryResultCache_write_(signature, result, ttlSeconds, options).stored;
}

function DataRepository_getSchema_(sheetName) {
  var schemas = {};
  schemas[SHEET_NAMES.STUDENTS] = { idIndex: IDX.STUDENT.ID };
  schemas[SHEET_NAMES.PAYMENTS] = { idIndex: IDX.PAYMENT.ID };
  schemas[SHEET_NAMES.REQUESTS] = { idIndex: IDX.REQUEST.ID };
  schemas[SHEET_NAMES.VACATIONS] = { idIndex: IDX.VACATION.ID };
  schemas[SHEET_NAMES.EVENTS] = { idIndex: 0 };
  schemas[SHEET_NAMES.TRASH] = { idIndex: 0 };
  schemas[SHEET_NAMES.TEACHERS] = { idIndex: IDX.TEACHER.ID };
  schemas[SHEET_NAMES.USERS] = { idIndex: IDX.USER.ID };
  schemas[SHEET_NAMES.SETTINGS] = { idIndex: IDX.SETTING.KEY };
  schemas[SHEET_NAMES.SALARY_SETTLEMENTS] = { idIndex: IDX.SALARY_SETTLEMENT.ID };
  schemas[SHEET_NAMES.SALARY_ENTRIES] = { idIndex: IDX.SALARY_ENTRY.ID };
  schemas[SHEET_NAMES.LOGS] = { idIndex: null };
  schemas[SHEET_NAMES.HOME] = { idIndex: null };
  return schemas[sheetName] || { idIndex: null };
}

function DataRepository_getSheet_(sheetName, required) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet && required !== false) throw new Error(sheetName + " 시트를 찾을 수 없습니다.");
  return sheet;
}

function DataRepository_encodeRows_(rows) {
  return (rows || []).map(function(row) {
    return row.map(function(value) {
      return value instanceof Date
        ? { __dataRepositoryType: "DATE", value: value.getTime() }
        : value;
    });
  });
}

function DataRepository_decodeRows_(rows) {
  return (rows || []).map(function(row) {
    return row.map(function(value) {
      if (value && typeof value === "object" && value.__dataRepositoryType === "DATE") {
        var date = new Date(Number(value.value));
        return isNaN(date.getTime()) ? "" : date;
      }
      return value;
    });
  });
}

function DataRepository_cacheBaseKey_(sheetName) {
  return DATA_REPOSITORY_CACHE_VERSION + "_" + sheetName;
}

function DataRepository_generationKey_(sheetName) {
  return "DATA_REPOSITORY_GENERATION_" + Utilities.base64EncodeWebSafe(String(sheetName));
}

function DataRepository_getGeneration_(sheetName) {
  try {
    var value = PropertiesService.getScriptProperties().getProperty(DataRepository_generationKey_(sheetName));
    var generation = Number(value);
    return isFinite(generation) && generation >= 0 ? generation : 0;
  } catch (error) {
    // 캐시는 보조 계층입니다. 권한·서비스 일시 오류가 원본 조회까지 막지 않게 합니다.
    logError_("캐시 세대 조회 실패 " + sheetName, error);
    return 0;
  }
}

function DataRepository_removeCacheEntries_(sheetName) {
  delete DataRepository_runtimeRows_[String(sheetName)];
  try {
    var cache = CacheService.getScriptCache();
    var bases = [sheetName, "DR2_" + sheetName, DataRepository_cacheBaseKey_(sheetName)];
    var keys = [];
    bases.forEach(function(base) {
      keys.push(base, base + "_META");
      for (var i = 0; i < DATA_REPOSITORY_CACHE_MAX_CHUNKS; i++) keys.push(base + "_" + i);
    });
    cache.removeAll(keys);
  } catch (error) {
    logError_("캐시 항목 삭제 실패 " + sheetName, error);
  }
}

/** 원본 변경 없이 만료·손상된 캐시 조각만 제거합니다. */
function DataRepository_evictCache_(sheetName) {
  DataRepository_removeCacheEntries_(sheetName);
}

/** 실제 원본 변경 또는 사용자의 강제 새로고침 때만 세대번호를 증가시킵니다. */
function DataRepository_clearCache_(sheetName) {
  try {
    CacheVersion_withLock_(function() {
      var properties = PropertiesService.getScriptProperties();
      var generationKey = DataRepository_generationKey_(sheetName);
      var current = Number(properties.getProperty(generationKey) || 0) || 0;
      properties.setProperty(generationKey, String(current + 1));
    });
  } catch (error) {
    logError_("캐시 세대 갱신 실패 " + sheetName, error);
  }
  DataRepository_removeCacheEntries_(sheetName);
}

function DataRepository_readCachedRows_(sheetName, expectedGeneration) {
  try {
    var cache = CacheService.getScriptCache();
    var base = DataRepository_cacheBaseKey_(sheetName);
    var metaText = cache.get(base + "_META");
    if (!metaText) return null;
    var meta = JSON.parse(metaText);
    var generation = expectedGeneration == null ? DataRepository_getGeneration_(sheetName) : Number(expectedGeneration);
    if (meta.version !== DATA_REPOSITORY_CACHE_VERSION || Number(meta.generation) !== generation ||
        meta.chunks < 1 || meta.chunks > DATA_REPOSITORY_CACHE_MAX_CHUNKS) {
      DataRepository_evictCache_(sheetName);
      return null;
    }
    var keys = [];
    for (var i = 0; i < meta.chunks; i++) keys.push(base + "_" + i);
    var entries = cache.getAll(keys);
    var text = "";
    for (var ci = 0; ci < keys.length; ci++) {
      var chunk = entries[keys[ci]];
      if (chunk == null) {
        DataRepository_evictCache_(sheetName);
        return null;
      }
      text += chunk;
    }
    return DataRepository_decodeRows_(JSON.parse(text));
  } catch (error) {
    logError_("공통 캐시 해석 실패 " + sheetName, error);
    DataRepository_evictCache_(sheetName);
    return null;
  }
}

function DataRepository_writeCachedRows_(sheetName, rows, expectedGeneration) {
  try {
    var cache = CacheService.getScriptCache();
    var base = DataRepository_cacheBaseKey_(sheetName);
    var generation = expectedGeneration == null ? DataRepository_getGeneration_(sheetName) : Number(expectedGeneration);
    if (DataRepository_getGeneration_(sheetName) !== generation) return false;
    var text = JSON.stringify(DataRepository_encodeRows_(rows));
    var chunkCount = Math.max(1, Math.ceil(text.length / DATA_REPOSITORY_CACHE_CHUNK_CHARS));
    if (chunkCount > DATA_REPOSITORY_CACHE_MAX_CHUNKS) {
      DataRepository_evictCache_(sheetName);
      return false;
    }
    DataRepository_removeCacheEntries_(sheetName);
    var entries = {};
    for (var i = 0; i < chunkCount; i++) {
      entries[base + "_" + i] = text.substring(i * DATA_REPOSITORY_CACHE_CHUNK_CHARS, (i + 1) * DATA_REPOSITORY_CACHE_CHUNK_CHARS);
    }
    entries[base + "_META"] = JSON.stringify({ version: DATA_REPOSITORY_CACHE_VERSION, chunks: chunkCount, generation: generation });
    cache.putAll(entries, CACHE_TTL_SECONDS);
    if (DataRepository_getGeneration_(sheetName) !== generation) {
      DataRepository_removeCacheEntries_(sheetName);
      return false;
    }
    return true;
  } catch (error) {
    logError_("공통 캐시 저장 실패 " + sheetName, error);
    DataRepository_evictCache_(sheetName);
    return false;
  }
}

function DataRepository_getRowsRaw_(sheetName, options) {
  options = options || {};
  if (!options.fresh) {
    var generation = DataRepository_getGeneration_(sheetName);
    var runtimeEntry = DataRepository_runtimeRows_[String(sheetName)];
    if (runtimeEntry && Number(runtimeEntry.generation) === generation) return runtimeEntry.rows;
    var cached = DataRepository_readCachedRows_(sheetName, generation);
    if (cached !== null) {
      DataRepository_runtimeRows_[String(sheetName)] = { generation:generation, rows:cached };
      return cached;
    }
  }
  var sheet = DataRepository_getSheet_(sheetName, options.required);
  if (!sheet) return [];
  var generation = DataRepository_getGeneration_(sheetName);
  var rows = sheet.getDataRange().getValues();
  if (options.cache !== false) {
    var stored = DataRepository_writeCachedRows_(sheetName, rows, generation);
    // 읽는 사이 다른 실행이 원본을 바꾼 경우에는 오래된 행을 실행 캐시에도 남기지 않습니다.
    if (stored) DataRepository_runtimeRows_[String(sheetName)] = { generation:generation, rows:rows };
  }
  return rows;
}

function DataRepository_getRows_(sheetName, options) {
  if (sheetName === SHEET_NAMES.LOGS &&
      !(options && options.rawLegacy) &&
      typeof EventRepository_getLegacyRows_ === "function") {
    return EventRepository_getLegacyRows_(options || {});
  }
  return DataRepository_getRowsRaw_(sheetName, options);
}

function DataRepository_loadContext_(sheetNames, options) {
  var context = {};
  (sheetNames || []).forEach(function(sheetName) {
    context[sheetName] = DataRepository_getRows_(sheetName, options || {});
  });
  try { Object.defineProperty(context, "__dataRepositoryFullContext", { value:true, enumerable:false }); }
  catch (ignoredContextMarkerError) { context.__dataRepositoryFullContext = true; }
  return context;
}

function DataRepository_findRowById_(sheetName, rows, rowId) {
  var idIndex = DataRepository_getSchema_(sheetName).idIndex;
  if (idIndex == null) throw new Error(sheetName + " 시트에는 기본키 열이 정의되어 있지 않습니다.");
  var target = String(rowId == null ? "" : rowId).trim();
  if (!target) return null;
  for (var i = 1; i < (rows || []).length; i++) {
    if (String(rows[i][idIndex] == null ? "" : rows[i][idIndex]).trim() === target) {
      return { index: i, rowNumber: i + 1, row: rows[i] };
    }
  }
  return null;
}

/** 기존 호출부 호환용 별칭입니다. 신규 코드는 DataRepository_getRows_를 직접 사용합니다. */
function getCachedData_(sheetName) {
  return DataRepository_getRows_(sheetName, { required:false });
}

function clearCache_(sheetName) {
  DataRepository_clearCache_(sheetName);
}
