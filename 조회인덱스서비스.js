/** ID 열만 읽어 구성하는 세대번호 기반 조회 인덱스입니다. 원본 시트가 유일한 영구 원장입니다. */
var LOOKUP_INDEX_TTL_SECONDS = 600;

function LookupIndex_normalizeKey_(value) {
  return String(value == null ? "" : value).replace(/[\s\u00A0\u200B\uFEFF]+/g, "");
}

function LookupIndex_signature_(sheetName, columnNumber) {
  var sheet = DataRepository_getSheet_(sheetName, false);
  // 설치형 변경 트리거가 실행되기 전에도 행·열 삭제/삽입과 시트 교체를 구분합니다.
  var shape = sheet ? [sheet.getSheetId(), sheet.getLastRow(), sheet.getLastColumn()].join("_") : "MISSING";
  return QueryResultCache_signature_("LOOKUP_INDEX_V2", sheetName + "_C" + columnNumber + "_" + shape, [sheetName]);
}

function LookupIndex_build_(sheetName, columnNumber) {
  var sheet = DataRepository_getSheet_(sheetName, false);
  var map = {};
  if (!sheet || sheet.getLastRow() < 2) return { map: map, indexedRows: 0, builtAt: new Date().toISOString() };
  var values = sheet.getRange(2, columnNumber, sheet.getLastRow() - 1, 1).getDisplayValues();
  values.forEach(function(row, index) {
    var key = LookupIndex_normalizeKey_(row[0]);
    if (!key) return;
    if (!Object.prototype.hasOwnProperty.call(map, key)) map[key] = [];
    map[key].push(index + 2);
  });
  return { map: map, indexedRows: values.length, builtAt: new Date().toISOString() };
}

function LookupIndex_get_(sheetName, columnNumber, forceRebuild) {
  var signature = LookupIndex_signature_(sheetName, columnNumber);
  if (!forceRebuild) {
    var read = QueryResultCache_read_(signature, { maxChunks: 10 });
    if (read.value && read.value.map) return read.value;
  }
  var index = LookupIndex_build_(sheetName, columnNumber);
  QueryResultCache_write_(signature, index, LOOKUP_INDEX_TTL_SECONDS, { maxChunks: 10 });
  return index;
}

function LookupIndex_findRowNumbers_(sheetName, columnNumber, value, forceRebuild) {
  var key = LookupIndex_normalizeKey_(value);
  if (!key) return [];
  var index = LookupIndex_get_(sheetName, columnNumber, !!forceRebuild);
  var rows = index.map && index.map[key];
  return Array.isArray(rows) ? rows.slice() : [];
}

function LookupIndex_columnLetter_(columnNumber) {
  var value = Number(columnNumber) || 1;
  var result = "";
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function LookupIndex_readRows_(sheet, rowNumbers) {
  if (!sheet || !rowNumbers || !rowNumbers.length) return [];
  var unique = {};
  var lastRow = sheet.getLastRow();
  rowNumbers.forEach(function(rowNumber) {
    var value = Number(rowNumber);
    if (value >= 2 && value <= lastRow) unique[value] = true;
  });
  var ordered = Object.keys(unique).map(Number).sort(function(a, b) { return a - b; });
  if (!ordered.length) return [];
  var lastColumn = Math.max(1, sheet.getLastColumn());
  var contiguous = ordered.every(function(rowNumber, index) {
    return index === 0 || rowNumber === ordered[index - 1] + 1;
  });
  if (contiguous) {
    var contiguousRows = sheet.getRange(ordered[0], 1, ordered.length, lastColumn).getValues();
    return contiguousRows.map(function(row, index) {
      return { rowNumber:ordered[0] + index, row:row };
    });
  }
  // 대상 행 사이 간격이 좁거나 묶음 크기가 충분하면 RangeList의 행별 getValues
  // 왕복보다 최소~최대 행을 한 번 읽는 편이 빠릅니다. 최대 셀 수를 제한해
  // 희소한 소수 행 때문에 과도한 데이터를 가져오지는 않습니다.
  var firstRow = ordered[0];
  var span = ordered[ordered.length - 1] - firstRow + 1;
  var boundingCells = span * lastColumn;
  var shouldReadBoundingRange =
    (ordered.length >= 4 && boundingCells <= 12000) ||
    (ordered.length >= 40 && ordered.length >= Math.ceil(span * 0.35));
  if (shouldReadBoundingRange) {
    var allRows = sheet.getRange(firstRow, 1, span, lastColumn).getValues();
    return ordered.map(function(rowNumber) {
      return { rowNumber:rowNumber, row:allRows[rowNumber - firstRow] };
    });
  }
  var endColumn = LookupIndex_columnLetter_(lastColumn);
  var ranges = sheet.getRangeList(ordered.map(function(rowNumber) {
    return "A" + rowNumber + ":" + endColumn + rowNumber;
  })).getRanges();
  return ranges.map(function(range, index) { return { rowNumber: ordered[index], row: range.getValues()[0] }; });
}

function LookupIndex_findRows_(sheetName, columnNumber, value, forceRebuild) {
  return LookupIndex_findRowsForValues_(sheetName, columnNumber, [value], forceRebuild);
}

/** 여러 키를 한 번의 인덱스 조회로 묶어 대상 행만 읽습니다. */
function LookupIndex_findRowsForValues_(sheetName, columnNumber, values, forceRebuild) {
  var sheet = DataRepository_getSheet_(sheetName, false);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var index = LookupIndex_get_(sheetName, columnNumber, !!forceRebuild);
  var rowMap = {};
  var wantedKeys = {};
  (values || []).forEach(function(value) {
    var key = LookupIndex_normalizeKey_(value);
    if (!key) return;
    wantedKeys[key] = true;
    ((index.map && index.map[key]) || []).forEach(function(rowNumber) {
      rowMap[Number(rowNumber)] = true;
    });
  });
  var rowNumbers = Object.keys(rowMap).map(Number);
  var records = LookupIndex_readRows_(sheet, rowNumbers);
  var matching = records.filter(function(record) {
    return Object.prototype.hasOwnProperty.call(wantedKeys, LookupIndex_normalizeKey_(record.row[columnNumber - 1]));
  });
  // 같은 행 수의 정렬·이동 또는 조회 중 직접 편집에도 다른 ID의 행은 반환하지 않습니다.
  if (!forceRebuild && (matching.length !== records.length || records.length !== rowNumbers.length)) {
    return LookupIndex_findRowsForValues_(sheetName, columnNumber, values, true);
  }
  return matching;
}

/** 기존 전체행 기반 계산기에 넘길 수 있도록 헤더와 대상 행만 조립합니다. */
function LookupIndex_readTableForValues_(sheetName, columnNumber, values, forceRebuild) {
  var sheet = DataRepository_getSheet_(sheetName, false);
  if (!sheet) return [];
  var width = Math.max(1, sheet.getLastColumn());
  var header = sheet.getRange(1, 1, 1, width).getValues()[0];
  return [header].concat(LookupIndex_findRowsForValues_(sheetName, columnNumber, values, forceRebuild)
    .map(function(item) { return item.row; }));
}

function rebuildLookupIndexes() {
  requireSuperAdmin_();
  var targets = [
    [SHEET_NAMES.STUDENTS, COL.STUDENT.ID],
    [SHEET_NAMES.STUDENTS, COL.STUDENT.NAME],
    [SHEET_NAMES.PAYMENTS, COL.PAYMENT.ID],
    [SHEET_NAMES.PAYMENTS, COL.PAYMENT.STUDENT_ID],
    [SHEET_NAMES.PAYMENTS, COL.PAYMENT.REQUEST_ID],
    [SHEET_NAMES.VACATIONS, COL.VACATION.ID],
    [SHEET_NAMES.VACATIONS, COL.VACATION.STUDENT_ID],
    [SHEET_NAMES.REQUESTS, COL.REQUEST.ID],
    [SHEET_NAMES.REQUESTS, COL.REQUEST.STATUS],
    [SHEET_NAMES.REQUESTS, COL.REQUEST.REQUESTER_EMAIL],
    [SHEET_NAMES.EVENTS, COL.EVENT.ID],
    [SHEET_NAMES.EVENTS, COL.EVENT.STUDENT_ID],
    [SHEET_NAMES.EVENTS, COL.EVENT.REQUEST_ID],
    [SHEET_NAMES.EVENTS, COL.EVENT.TARGET_ID],
    [SHEET_NAMES.TRASH, 1],
    [SHEET_NAMES.SALARY_ENTRIES, COL.SALARY_ENTRY.SETTLEMENT_ID]
  ];
  return targets.map(function(target) {
    var index = LookupIndex_get_(target[0], target[1], true);
    return { sheetName: target[0], column: target[1], indexedRows: index.indexedRows };
  });
}
