/** DB 시트 생성과 헤더 검증을 한곳에서 관리합니다. */
function DataSchema_getDefinitions_() {
  var definitions = {};
  definitions[SHEET_NAMES.STUDENTS] = [
    "학생ID", "학생명", "학번/학년", "상태", "담당 강사", "첫 수업일", "퇴원일", "수강료 기준일",
    "배분률", "부모님 전화번호", "수강료", null, "형제그룹ID", "형제그룹명", "현금영수증번호",
    "입금자명", "최초입학일", "형제할인액", "수강형태", "담당원장ID"
  ];
  definitions[SHEET_NAMES.PAYMENTS] = [
    "수납ID", "등록일시", "납부일", "학생ID", "학생명", "귀속월", "수납항목", null, "납부금액",
    "납부방식", null, null, "메모", "요청ID", null, "레코드상태", "계산유형", "계산시작일",
    "계산종료일", "적용일수", "기준일수", "형제할인", "기타할인"
  ];
  definitions[SHEET_NAMES.REQUESTS] = [
    "요청ID", "요청일시", "요청분류", "요청유형", "처리상태", "대상ID", "대상명",
    "요청요약", "요청원문", "요청자이메일", "요청자명", "증빙파일ID", "원본시트",
    "원본요청ID", "적용일", "처리일시", "처리자", "처리메모", "처리결과", "오류",
    "수정일시", "스키마버전"
  ];
  definitions[SHEET_NAMES.VACATIONS] = VACATION_HEADERS.slice();
  definitions[SHEET_NAMES.EVENTS] = EVENT_HEADERS.slice();
  definitions[SHEET_NAMES.TRASH] = TRASH_HEADERS.slice();
  definitions[SHEET_NAMES.TEACHERS] = [
    "원장ID", "원장명", "활성", "신규학생 기본배분율", "급여정산대상",
    "시작일", "종료일", "메모", "생성일시", "수정일시", "수정자"
  ];
  definitions[SHEET_NAMES.USERS] = [
    "사용자ID", "이메일", "표시명", "역할", "활성", "추가권한",
    "생성일시", "수정일시", "수정자", "연결원장ID", "학생접근범위"
  ];
  definitions[SHEET_NAMES.SETTINGS] = [
    "설정키", "구분", "설정명", "현재값", "자료형", "최소값", "최대값", "설명"
  ];
  definitions[SHEET_NAMES.SALARY_SETTLEMENTS] = [
    "정산ID", "정산월", "원장ID", "원장명", "상태", "계산금액", "조정금액",
    "확정금액", "지급액", "잔액", "자료구분", "메모", "생성일시", "수정일시", "확정일시", "확정자"
  ];
  definitions[SHEET_NAMES.SALARY_ENTRIES] = [
    "내역ID", "정산ID", "내역유형", "금액", "처리일", "메모", "생성일시", "처리자", "상태", "참조ID", "상세JSON"
  ];
  return definitions;
}

/** 열 의미와 위치가 같은 과거 헤더 명칭만 표준 헤더로 안전하게 치환합니다. */
function DataSchema_getHeaderAliases_() {
  var aliases = {};
  aliases[SHEET_NAMES.STUDENTS] = {
    1: ["학생 ID"],
    3: ["학년/학번"],
    5: ["담당 원장"],
    11: ["월 수강료"],
    13: ["가족ID"],
    14: ["가족명"],
    15: ["현금영수증 전번"],
    16: ["입금자(부모님)명"]
  };
  aliases[SHEET_NAMES.PAYMENTS] = {
    2: ["처리일"],
    3: ["수납일"],
    4: ["학생 ID"],
    6: ["귀속 연/월"],
    7: ["구분"],
    10: ["결제수단"],
    13: ["비고"]
  };
  aliases[SHEET_NAMES.VACATIONS] = {
    6: ["휴가사유"]
  };
  return aliases;
}

function DataSchema_isCompatibleHeader_(sheetName, column, current) {
  var sheetAliases = DataSchema_getHeaderAliases_()[sheetName] || {};
  return (sheetAliases[column] || []).indexOf(String(current || "").trim()) !== -1;
}

function DataSchema_formatMismatchError_(sheetName, mismatches) {
  var detail = (mismatches || []).map(function(item) {
    return (item.label || item.column + "열") + ": 예상 '" + item.expected + "', 현재 '" + item.actual + "'";
  }).join(" / ");
  return "DB 구조가 예상과 달라 저장을 중단했습니다. [" + sheetName + "] " + detail +
    " · DB 구조 점검에서 확인한 뒤 백업 후 보정해주세요.";
}

/** 설치 시 확인한 시트 식별자와 헤더 위치만 보관합니다. 학생·수납 원본은 저장하지 않습니다. */
function DataSchema_readStructureBaseline_() {
  var raw = PropertiesService.getScriptProperties().getProperty("MANAGED_STRUCTURE_BASELINE_V1");
  if (!raw) return {};
  var baseline;
  try { baseline = JSON.parse(raw); } catch (error) { throw new Error("DB 구조 기준정보가 손상되었습니다. 저장을 중단하고 백업·배포 환경 점검을 실행해주세요."); }
  if (!baseline || !baseline.sheets || typeof baseline.sheets !== "object") {
    throw new Error("DB 구조 기준정보가 올바르지 않습니다. 저장을 중단하고 백업·배포 환경 점검을 실행해주세요.");
  }
  return String(baseline.spreadsheetId) === String(SpreadsheetApp.getActiveSpreadsheet().getId()) ? baseline.sheets : {};
}

/** 읽기 전용 검사: 과거 헤더 별칭과 아직 도입하지 않은 끝쪽 확장 열은 허용합니다. */
function DataSchema_inspectSheetStructure_(sheetName, sheet, baseline) {
  if (baseline && (!sheet || String(sheet.getSheetId()) !== String(baseline.sheetId))) {
    return [{ label:"시트 식별자", expected:String(baseline.sheetId), actual:sheet ? String(sheet.getSheetId()) : "삭제 또는 이름 변경" }];
  }
  if (!sheet) return [];
  var expected = DataSchema_getDefinitions_()[sheetName] || (baseline && baseline.headers) || [];
  if (!expected.length) return [];
  var width = Math.min(sheet.getMaxColumns(), expected.length);
  var headers = width ? sheet.getRange(1, 1, 1, width).getValues()[0] : [];
  var lastNamedColumn = -1;
  headers.forEach(function(value, index) { if (String(value == null ? "" : value).trim()) lastNamedColumn = index; });
  var requiredColumns = baseline && baseline.columns || [];
  var mismatches = [];
  expected.forEach(function(header, index) {
    if (header == null) return;
    var actual = String(headers[index] == null ? "" : headers[index]).trim();
    var missingRequired = !actual && (index <= lastNamedColumn || requiredColumns.indexOf(index + 1) !== -1 ||
      (lastNamedColumn < 0 && sheet.getLastRow() > 1));
    if (missingRequired || (actual && actual !== header && !DataSchema_isCompatibleHeader_(sheetName, index + 1, actual))) {
      mismatches.push({ column:index + 1, expected:header, actual:actual });
    }
  });
  return mismatches;
}

function DataSchema_assertManagedStructure_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var baseline = DataSchema_readStructureBaseline_();
  var names = DataMutation_managedEditSheetNames_();
  names.forEach(function(name) {
    var mismatches = DataSchema_inspectSheetStructure_(name, ss.getSheetByName(name), baseline[name]);
    if (mismatches.length) throw new Error(DataSchema_formatMismatchError_(name, mismatches));
  });
  return true;
}

/** 호출자는 먼저 구조를 검증해야 합니다. 검증된 백업 복구 후에는 새 시트 ID를 기준으로 삼습니다. */
function DataSchema_captureManagedStructure_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var definitions = DataSchema_getDefinitions_();
  var sheets = {};
  DataMutation_managedEditSheetNames_().forEach(function(name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) return;
    var expected = definitions[name];
    var width = Math.min(sheet.getMaxColumns(), expected ? expected.length : sheet.getLastColumn());
    var headers = width ? sheet.getRange(1, 1, 1, width).getValues()[0] : [];
    var columns = [];
    headers.forEach(function(value, index) {
      if ((!expected || expected[index] != null) && String(value == null ? "" : value).trim()) columns.push(index + 1);
    });
    sheets[name] = { sheetId:sheet.getSheetId(), columns:columns };
    if (!expected) sheets[name].headers = headers.map(function(value) { return String(value || "").trim() || null; });
  });
  PropertiesService.getScriptProperties().setProperty("MANAGED_STRUCTURE_BASELINE_V1",
    JSON.stringify({ spreadsheetId:ss.getId(), sheets:sheets }));
  return Object.keys(sheets).length;
}

function DataSchema_ensureSheet_(sheetName, tx, options) {
  options = options || {};
  var definitions = DataSchema_getDefinitions_();
  var expected = definitions[sheetName];
  if (!expected) throw new Error("관리 대상이 아닌 DB 시트입니다: " + sheetName);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  var structureErrors = DataSchema_inspectSheetStructure_(sheetName, sheet, DataSchema_readStructureBaseline_()[sheetName]);
  if (structureErrors.length) {
    if (options.reportMismatch) return { sheet:sheet, created:false, filledColumns:[], normalizedColumns:[], mismatches:structureErrors, blocked:true };
    throw new Error(DataSchema_formatMismatchError_(sheetName, structureErrors));
  }
  var created = false;
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    created = true;
    if (tx) {
      tx.addRollback(function() {
        var current = ss.getSheetByName(sheetName);
        if (current && current.getSheetId() === sheet.getSheetId()) ss.deleteSheet(current);
      });
    }
  }

  var readableColumns = Math.min(sheet.getMaxColumns(), expected.length);
  var currentHeaders = readableColumns > 0
    ? sheet.getRange(1, 1, 1, readableColumns).getValues()[0]
    : [];
  while (currentHeaders.length < expected.length) currentHeaders.push("");
  var nextHeaders = currentHeaders.slice();
  var filledColumns = [];
  var normalizedColumns = [];
  var mismatches = [];
  expected.forEach(function(header, index) {
    if (header == null) return;
    var current = String(currentHeaders[index] == null ? "" : currentHeaders[index]).trim();
    if (!current) {
      nextHeaders[index] = header;
      filledColumns.push(index + 1);
    } else if (current !== header) {
      if (DataSchema_isCompatibleHeader_(sheetName, index + 1, current)) {
        nextHeaders[index] = header;
        normalizedColumns.push(index + 1);
      } else {
        mismatches.push({ column: index + 1, expected: header, actual: current });
      }
    }
  });
  if (mismatches.length) {
    if (options.reportMismatch) {
      return { sheet: sheet, created: created, filledColumns: [], normalizedColumns: [], mismatches: mismatches, blocked: true };
    }
    throw new Error(DataSchema_formatMismatchError_(sheetName, mismatches));
  }
  if (sheet.getMaxColumns() < expected.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), expected.length - sheet.getMaxColumns());
  }
  var range = sheet.getRange(1, 1, 1, expected.length);
  if (filledColumns.length || normalizedColumns.length) {
    if (tx) tx.writeRange(sheet, 1, 1, [nextHeaders]);
    else range.setValues([nextHeaders]);
  }
  sheet.getRange(1, 1, 1, expected.length).setFontWeight("bold");
  sheet.setFrozenRows(1);
  return { sheet: sheet, created: created, filledColumns: filledColumns, normalizedColumns: normalizedColumns, mismatches: mismatches, blocked: false };
}

function ensureDataSchemas() {
  requireSuperAdmin_();
  return MutationPipeline_run_({ operation: "DB스키마점검", skipSchemaPreflight: true }, function(tx) {
    var names = [SHEET_NAMES.STUDENTS, SHEET_NAMES.PAYMENTS, SHEET_NAMES.REQUESTS, SHEET_NAMES.VACATIONS, SHEET_NAMES.EVENTS, SHEET_NAMES.TRASH,
      SHEET_NAMES.TEACHERS, SHEET_NAMES.USERS, SHEET_NAMES.SETTINGS, SHEET_NAMES.SALARY_SETTLEMENTS, SHEET_NAMES.SALARY_ENTRIES];
    var results = names.map(function(name) {
      var result = DataSchema_ensureSheet_(name, tx, { reportMismatch: true });
      if (!result.blocked) {
        if (name === SHEET_NAMES.PAYMENTS) PaymentDomain_retireGroupColumn_(result.sheet, tx);
        tx.invalidate([name]);
      }
      return {
        sheetName: name,
        created: result.created,
        filledColumns: result.filledColumns,
        normalizedColumns: result.normalizedColumns || [],
        mismatches: result.mismatches,
        blocked: result.blocked
      };
    });
    return results;
  });
}

function showDataSchemaStatus() {
  requireSpreadsheetSuperAdmin_();
  var results = ensureDataSchemas();
  var lines = results.map(function(result) {
    var changeParts = [];
    if (result.created) changeParts.push("시트 생성");
    if (result.filledColumns.length) changeParts.push("빈 헤더 보완: " + result.filledColumns.join(", "));
    if ((result.normalizedColumns || []).length) changeParts.push("과거 헤더 표준화: " + result.normalizedColumns.join(", "));
    var changes = changeParts.length ? changeParts.join(" / ") : "정상";
    if (result.mismatches.length) {
      changes += " / 저장 차단: " + result.mismatches.map(function(item) {
        return (item.label || item.column + "열") + " '" + item.actual + "'→'" + item.expected + "'";
      }).join(", ");
    }
    return result.sheetName + ": " + changes;
  });
  SpreadsheetApp.getUi().alert("DB 구조 점검", lines.join("\n"), SpreadsheetApp.getUi().ButtonSet.OK);
  return results;
}
