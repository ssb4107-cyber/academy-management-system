/** 최고관리자가 화면에서 바꿀 수 있는 운영 규칙과 기본 수치 */
var OPERATIONAL_SETTING_CACHE_KEY = "OPERATIONAL_SETTINGS_V1";
var OperationalSettings_runtimeMap_ = null;
var OperationalSettings_definitionMapCache_ = null;

function OperationalSettings_clearCache_() {
  OperationalSettings_runtimeMap_ = null;
  try { CacheService.getScriptCache().remove(OPERATIONAL_SETTING_CACHE_KEY); } catch (ignoredCacheClearError) {}
}

function OperationalSettings_definitions_() {
  return [
    { key:"DASHBOARD_MONTH_CUTOFF_DAY", category:"화면", label:"대시보드 당월 전환일", defaultValue:10, type:"NUMBER", min:1, max:28, description:"이 날짜 전날까지는 전달, 해당일부터 당월을 기본으로 표시합니다." },
    { key:"PAYMENT_TOLERANCE_WON", category:"금액", label:"완납 허용 오차", defaultValue:1000, type:"NUMBER", min:0, max:100000, description:"청구액보다 부족해도 완납으로 보는 최대 차이입니다." },
    { key:"PAYMENT_WARNING_HIGH_WON", category:"금액", label:"큰 차이 경고 기준", defaultValue:5000, type:"NUMBER", min:1, max:1000000, description:"이 금액 이상 차이나면 강한 경고로 표시합니다." },
    { key:"PAYMENT_SILENT_DIFF_WON", category:"금액", label:"표시 생략 오차", defaultValue:10, type:"NUMBER", min:0, max:10000, description:"이 금액 이하의 차이는 별도 경고를 표시하지 않습니다." },
    { key:"FEBRUARY_BILLING_DAYS", category:"일할 계산", label:"2월 일할 기준일수", defaultValue:30, type:"NUMBER", min:28, max:31, description:"2월 수강료 일할 계산의 분모로 사용합니다." },
    { key:"PRORATION_AMOUNT_WARNING_PERCENT", category:"일할 계산", label:"일할 금액 차이 경고율", defaultValue:20, type:"NUMBER", min:0, max:100, description:"서버 계산액과 실제 입력액의 차이가 이 비율을 넘으면 저장을 막고 재확인을 요청합니다." },
    { key:"ELEMENTARY_DEFAULT_FEE", category:"학생 등록", label:"초등 기본 수강료", defaultValue:250000, type:"NUMBER", min:0, max:10000000, description:"신규 학생 등록 시 학년에 따라 자동 제시합니다." },
    { key:"MIDDLE_DEFAULT_FEE", category:"학생 등록", label:"중등 기본 수강료", defaultValue:350000, type:"NUMBER", min:0, max:10000000, description:"신규 학생 등록 시 학년에 따라 자동 제시합니다." },
    { key:"HIGH_DEFAULT_FEE", category:"학생 등록", label:"고등 기본 수강료", defaultValue:400000, type:"NUMBER", min:0, max:10000000, description:"신규 학생 등록 시 학년에 따라 자동 제시합니다." },
    { key:"BACKUP_INTERVAL_DAYS", category:"백업", label:"자동 백업 주기", defaultValue:3, type:"NUMBER", min:1, max:30, description:"마지막 정상 백업 후 다음 자동 백업까지의 일수입니다." },
    { key:"BACKUP_RETENTION_MONTHS", category:"백업", label:"백업 보관 개월", defaultValue:3, type:"NUMBER", min:1, max:24, description:"이 기간보다 오래된 정기 백업을 자동 정리합니다." }
  ];
}

function OperationalSettings_definitionMap_() {
  if (OperationalSettings_definitionMapCache_) return OperationalSettings_definitionMapCache_;
  var map = {}; OperationalSettings_definitions_().forEach(function(item) { map[item.key] = item; });
  OperationalSettings_definitionMapCache_ = map;
  return OperationalSettings_definitionMapCache_;
}

function OperationalSettings_readStoredMap_() {
  if (OperationalSettings_runtimeMap_) return OperationalSettings_runtimeMap_;
  var cached = CacheService.getScriptCache().get(OPERATIONAL_SETTING_CACHE_KEY);
  if (cached) { try { OperationalSettings_runtimeMap_ = JSON.parse(cached); return OperationalSettings_runtimeMap_; } catch (ignoredCacheError) {} }
  var map = {}, sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.SETTINGS);
  if (sheet && sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, COL.SETTING.DESCRIPTION).getValues().forEach(function(row) {
      var key = String(row[IDX.SETTING.KEY] || "").trim(); if (key) map[key] = row[IDX.SETTING.VALUE];
    });
  }
  try { CacheService.getScriptCache().put(OPERATIONAL_SETTING_CACHE_KEY, JSON.stringify(map), 300); } catch (ignoredPutError) {}
  OperationalSettings_runtimeMap_ = map;
  return OperationalSettings_runtimeMap_;
}

function OperationalSettings_getNumber_(key, fallback) {
  var stored = OperationalSettings_readStoredMap_();
  var value = Object.prototype.hasOwnProperty.call(stored, key) ? Number(stored[key]) : Number(fallback);
  var definition = OperationalSettings_definitionMap_()[key];
  if (!isFinite(value) || Math.floor(value) !== value || (definition && (value < definition.min || value > definition.max))) {
    return Number(fallback);
  }
  return value;
}

function OperationalSettings_ensureDefaults_() {
  requireSuperAdmin_();
  var definitions = OperationalSettings_definitions_();
  var currentSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.SETTINGS);
  if (currentSheet && currentSheet.getLastRow() > 1) {
    var currentKeys = {};
    currentSheet.getRange(2, COL.SETTING.KEY, currentSheet.getLastRow() - 1, 1).getDisplayValues().forEach(function(row) {
      currentKeys[String(row[0] || "").trim()] = true;
    });
    if (definitions.every(function(item) { return currentKeys[item.key]; })) return { inserted:0, skipped:true };
  }
  return MutationPipeline_run_({ operation:"운영설정 초기화" }, function(tx) {
    var sheet = DataSchema_ensureSheet_(SHEET_NAMES.SETTINGS, tx).sheet;
    var existing = {}, rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, COL.SETTING.DESCRIPTION).getValues() : [];
    rows.forEach(function(row) { existing[String(row[IDX.SETTING.KEY] || "").trim()] = true; });
    var append = definitions.filter(function(item) { return !existing[item.key]; }).map(function(item) {
      return [item.key, item.category, item.label, item.defaultValue, item.type, item.min, item.max, item.description];
    });
    if (append.length) {
      tx.appendRows(sheet, append);
      tx.invalidate([SHEET_NAMES.SETTINGS]);
      OperationalSettings_clearCache_();
    }
    return append.length;
  });
}

function OperationalSettings_list_() {
  var stored = OperationalSettings_readStoredMap_();
  return OperationalSettings_definitions_().map(function(item) {
    var value = Object.prototype.hasOwnProperty.call(stored, item.key) ? Number(stored[item.key]) : item.defaultValue;
    return { key:item.key, category:item.category, label:item.label, value:value, defaultValue:item.defaultValue,
      type:item.type, min:item.min, max:item.max, description:item.description, modified:value !== item.defaultValue };
  });
}

function saveOperationalSettings(values) {
  requireSuperAdmin_(); values = values || {};
  var definitions = OperationalSettings_definitions_(), validated = {};
  definitions.forEach(function(item) {
    var value = Number(values[item.key]);
    if (!isFinite(value) || Math.floor(value) !== value || value < item.min || value > item.max) {
      throw new Error(item.label + "은(는) " + item.min + "~" + item.max + " 범위의 정수로 입력해주세요.");
    }
    validated[item.key] = value;
  });
  if (validated.PAYMENT_SILENT_DIFF_WON > validated.PAYMENT_TOLERANCE_WON) throw new Error("표시 생략 오차는 완납 허용 오차보다 클 수 없습니다.");
  if (validated.PAYMENT_WARNING_HIGH_WON <= validated.PAYMENT_TOLERANCE_WON) throw new Error("큰 차이 경고 기준은 완납 허용 오차보다 커야 합니다.");
  return MutationPipeline_run_({ operation:"운영설정 저장" }, function(tx) {
    var actor = requireSuperAdmin_(), sheet = DataSchema_ensureSheet_(SHEET_NAMES.SETTINGS, tx).sheet;
    var rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, COL.SETTING.DESCRIPTION).getValues() : [];
    var rowByKey = {}; rows.forEach(function(row, index) { rowByKey[String(row[IDX.SETTING.KEY] || "")] = index + 2; });
    var before = [], after = [];
    definitions.forEach(function(item) {
      var row = [item.key, item.category, item.label, validated[item.key], item.type, item.min, item.max, item.description];
      if (rowByKey[item.key]) {
        var oldValue = sheet.getRange(rowByKey[item.key], COL.SETTING.VALUE).getValue();
        if (Number(oldValue) !== validated[item.key]) { before.push(item.label + ":" + oldValue); after.push(item.label + ":" + validated[item.key]); }
        tx.writeRange(sheet, rowByKey[item.key], 1, [row]);
      } else { tx.appendRows(sheet, [row]); after.push(item.label + ":" + validated[item.key]); }
    });
    tx.queueEvent({ eventType:"운영설정", targetType:"설정", targetId:"OPERATIONAL_SETTINGS", field:"운영 규칙",
      before:before.join(" / "), after:after.join(" / "), actorEmail:actor.email });
    tx.invalidate([SHEET_NAMES.SETTINGS, SHEET_NAMES.EVENTS]);
    OperationalSettings_clearCache_();
    clearDashboardCaches_();
    return { saved:true, changed:after.length, settings:OperationalSettings_list_() };
  });
}

/** 설정 모달의 '기본값 복원'에서 사용하는 명시적 전체 초기화입니다. */
function resetOperationalSettingsToDefaults() {
  requireSuperAdmin_();
  var values = {};
  OperationalSettings_definitions_().forEach(function(item) { values[item.key] = item.defaultValue; });
  return saveOperationalSettings(values);
}
