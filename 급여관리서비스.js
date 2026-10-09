/** 급여 확정·지급·스냅샷·진단 서비스 */
function createHistoricalSalaryRecord(data) {
  requireSuperAdmin_();
  data = data || {};
  return MutationPipeline_run_({ operation: "과거급여기록" }, function(tx) {
    var ym = requireMonthString_(data.ym, "정산 월");
    var teacher = TeacherDirectory_getById_(requireText_(data.teacherId, "원장 ID", 120));
    if (!teacher) throw new Error("등록된 원장을 선택해주세요.");
    if (SalaryManagement_findLatestSettlement_(ym, teacher.id)) throw new Error("해당 월·원장의 정산 기록이 이미 있습니다. 기존 기록에 지급 내역을 추가해주세요.");
    var finalAmount = requireMoney_(data.finalAmount, "확정 급여", 0, 100000000);
    var paidAmount = requireMoney_(data.paidAmount == null || data.paidAmount === "" ? 0 : data.paidAmount, "실제 지급액", 0, 100000000);
    var paidDate = paidAmount > 0 ? requireDateString_(data.paidDate, "지급일") : (data.paidDate ? requireDateString_(data.paidDate, "지급일") : "");
    var memo = safeSheetText_(data.memo, 500);
    var balance = finalAmount - paidAmount;
    var status = SalaryManagement_status_(finalAmount, paidAmount);
    var now = new Date();
    var user = requireSuperAdmin_();
    var settlementId = createUniqueId_("SAL");
    var settlementSheet = DataSchema_ensureSheet_(SHEET_NAMES.SALARY_SETTLEMENTS, tx).sheet;
    tx.appendRows(settlementSheet, [[settlementId, ym, teacher.id, teacher.name, status, finalAmount, 0, finalAmount, paidAmount, balance, "과거수동", memo, now, now, now, user.email]]);
    if (paidAmount > 0) {
      var entrySheet = DataSchema_ensureSheet_(SHEET_NAMES.SALARY_ENTRIES, tx).sheet;
      tx.appendRows(entrySheet, [[createUniqueId_("SLE"), settlementId, "지급", paidAmount, paidDate, memo, now, user.email, "완료", "", ""]]);
    }
    tx.queueEvent({ eventType: "과거급여기록", targetType: "급여정산", targetId: settlementId, field: "과거급여", before: "", after: ym + "/" + teacher.name + "/" + finalAmount + "/지급:" + paidAmount, memo: memo });
    tx.invalidate([SHEET_NAMES.SALARY_SETTLEMENTS, SHEET_NAMES.SALARY_ENTRIES]);
    return { settlementId: settlementId, status: status, balanceAmount: balance };
  });
}

function SalaryManagement_status_(finalAmount, paidAmount) {
  finalAmount = Number(finalAmount) || 0;
  paidAmount = Number(paidAmount) || 0;
  if (paidAmount === finalAmount) return "지급완료";
  if (paidAmount === 0) return "미지급";
  return paidAmount < finalAmount ? "일부지급" : "초과지급";
}

/** DB_급여정산의 월 값이 문자열 또는 시트 날짜여도 YYYY-MM으로 통일합니다. */
function SalaryManagement_normalizeYmCell_(value) {
  if (value && typeof value.getTime === "function" && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM");
  }
  var text = String(value == null ? "" : value).trim();
  var match = text.match(/^(\d{4})[-./년\s]+(\d{1,2})/);
  if (!match) {
    match = text.match(/^(\d{2})[-./년\s]+(\d{1,2})/);
    if (match) match[1] = "20" + match[1];
  }
  if (!match) return "";
  var month = Number(match[2]);
  return month >= 1 && month <= 12 ? match[1] + "-" + ("0" + month).slice(-2) : "";
}

var SALARY_SNAPSHOT_SCHEMA_VERSION = 2;

function SalaryManagement_calculateAdjustment_(item, representativeRate, skipClientValidation) {
  item = item || {};
  var origin = Number(item.originAmount);
  var clientFinal = Number(item.finalAmount);
  var amount;
  if (isFinite(origin) && origin > 0) {
    amount = roundMoney_(origin);
    if (item.isRate) amount = roundMoney_(amount * Salary_normalizeRate_(representativeRate));
    if (item.isTax) amount -= truncateMoney_(amount * 0.033);
  } else {
    amount = Math.abs(clientFinal || 0);
  }
  amount = requireMoney_(amount, "조정 금액", 0, 100000000);
  var isSubtract = String(item.type || "").indexOf("SUB") === 0 || (!item.type && clientFinal < 0);
  var signed = isSubtract ? -amount : amount;
  if (!skipClientValidation && isFinite(clientFinal) && Math.abs(clientFinal - signed) > 1) throw new Error("화면과 서버의 조정 금액이 일치하지 않습니다. 다시 조회해주세요.");
  return signed;
}

function SalaryManagement_createPreviewToken_(preview) {
  var tokenSource = JSON.stringify({
    schemaVersion: SALARY_SNAPSHOT_SCHEMA_VERSION,
    ym: preview.ym,
    teacherId: preview.teacher.id,
    data: preview.data,
    excludedData: preview.excluded || [],
    adjustments: preview.adjustments,
    exclusions: preview.exclusions,
    adjustmentAmount: preview.adjustmentAmount,
    finalAmount: preview.finalAmount
  });
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, tokenSource, Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/g, "");
}

/** 화면 미리보기와 확정 저장이 함께 사용하는 단일 급여 계산 경로입니다. */
function SalaryManagement_buildPreview_(data, sharedDb) {
  data = data || {};
  var ym = requireMonthString_(data.ym, "정산 월");
  var teacher = TeacherDirectory_getById_(requireText_(data.teacherId, "원장 ID", 120));
  if (!teacher || !teacher.salaryTarget) throw new Error("급여 정산 대상 원장을 선택해주세요.");
  var db = sharedDb || loadAllData(ym, { fresh: true, cache: false });
  var originalCalculation = Salary_processCalculation_(db, ym, teacher.name, teacher.id);
  var requestedExclusions = Array.isArray(data.exclusions) ? data.exclusions : [];
  var exclusionReasonById = {};
  var exclusionIds = requestedExclusions.map(function(item) {
    var id = requireText_(item && item.studentId, "선입금 학생 ID", 120);
    if (exclusionReasonById[id]) throw new Error("선입금 학생이 중복 선택되었습니다: " + id);
    exclusionReasonById[id] = safeSheetText_(requireText_(item.reason || "원장 직접 현금 수령(선입금)", "선입금 사유", 500), 500);
    return id;
  });
  var exclusionResult = Salary_applyDirectReceiptExclusions_(originalCalculation, exclusionIds);
  var calculated = exclusionResult.data;
  var representativeRate = calculated.list.length
    ? Salary_normalizeRate_(calculated.list[0].rate)
    : Salary_normalizeRate_(teacher.defaultRate == null ? 60 : teacher.defaultRate);
  var normalizedAdjustments = [];
  var adjustmentAmount = 0;
  (Array.isArray(data.adjustments) ? data.adjustments : []).forEach(function(item) {
    item = item || {};
    var signed = SalaryManagement_calculateAdjustment_(item, representativeRate, true);
    adjustmentAmount += signed;
    normalizedAdjustments.push({
      type: optionalText_(item.type, 40),
      typeText: optionalText_(item.typeText, 100),
      originAmount: requireMoney_(item.originAmount, "조정 원금", 0, 100000000),
      finalAmount: signed,
      note: optionalText_(item.note, 500),
      isRate: !!item.isRate,
      isTax: !!item.isTax,
      representativeRate: representativeRate
    });
  });
  var baseAmount = requireMoney_(calculated.summary.finalPay, "계산 급여", 0, 100000000);
  var finalAmount = roundMoney_(baseAmount + adjustmentAmount);
  if (finalAmount < 0) throw new Error("조정 후 확정 급여는 0원보다 작을 수 없습니다.");
  var preview = {
    schemaVersion: SALARY_SNAPSHOT_SCHEMA_VERSION,
    ym: ym,
    teacher: { id: teacher.id, name: teacher.name },
    data: calculated,
    excluded: exclusionResult.excluded,
    exclusions: exclusionIds.map(function(id) { return { studentId: id, reason: exclusionReasonById[id] }; }),
    adjustments: normalizedAdjustments,
    representativeRate: representativeRate,
    baseAmount: baseAmount,
    adjustmentAmount: adjustmentAmount,
    finalAmount: finalAmount
  };
  preview.previewToken = SalaryManagement_createPreviewToken_(preview);
  return preview;
}

function previewSalarySettlement(data) {
  requireSuperAdmin_();
  data = data || {};
  var ym = requireMonthString_(data.ym, "정산 월");
  // 화면 편집 중에는 공통 조회 캐시를 사용합니다. 확정 직전 요청은 원본을 다시
  // 읽어 확정 함수와 동일한 기준으로 토큰을 만들며, 캐시 시차로 인한 1회 실패를 막습니다.
  if (data.freshSource === true) return SalaryManagement_buildPreview_(data);
  return SalaryManagement_buildPreview_(data, Salary_loadAllData_(ym));
}

function SalaryManagement_findLatestSettlement_(ym, teacherId) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.SALARY_SETTLEMENTS);
  if (!sheet || sheet.getLastRow() < 2) return null;
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, COL.SALARY_SETTLEMENT.CONFIRMED_BY).getValues();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (SalaryManagement_normalizeYmCell_(rows[i][IDX.SALARY_SETTLEMENT.YM]) === ym &&
        String(rows[i][IDX.SALARY_SETTLEMENT.TEACHER_ID] || "") === teacherId &&
        String(rows[i][IDX.SALARY_SETTLEMENT.STATUS] || "") !== "취소") {
      return { row: i + 2, values: rows[i] };
    }
  }
  return null;
}

function SalaryManagement_findSettlementById_(settlementId) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.SALARY_SETTLEMENTS);
  if (!sheet || sheet.getLastRow() < 2) return null;
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, COL.SALARY_SETTLEMENT.CONFIRMED_BY).getValues();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][IDX.SALARY_SETTLEMENT.ID] || "") === String(settlementId || "")) return { sheet: sheet, row: i + 2, values: rows[i] };
  }
  return null;
}

function SalaryManagement_getSettlementMapForMonth_(ym) {
  ym = requireMonthString_(ym, "정산 월");
  var startedAt = Date.now();
  // 먼저 작은 정산 원장만 읽어 해당 월 확정본의 존재를 확인합니다. 과거 구현은
  // 확정본이 없는 달에도 큰 상세내역 시트와 사용자 시트를 전부 읽었습니다.
  var settlementRows = DataRepository_getRows_(SHEET_NAMES.SALARY_SETTLEMENTS, { required: false });
  var settlementLoadedAt = Date.now();
  if (settlementRows.length < 2) return {};
  var rows = settlementRows.slice(1);
  var map = {};
  rows.forEach(function(row) {
    if (SalaryManagement_normalizeYmCell_(row[IDX.SALARY_SETTLEMENT.YM]) !== ym || String(row[IDX.SALARY_SETTLEMENT.STATUS] || "") === "취소") return;
    var name = String(row[IDX.SALARY_SETTLEMENT.TEACHER_NAME] || "");
    var teacherId = String(row[IDX.SALARY_SETTLEMENT.TEACHER_ID] || "").trim();
    // 신규 구조는 원장 ID가 기본키입니다. ID가 없는 과거 수동 기록만 이름 호환 키로 남깁니다.
    var mapKey = teacherId || ("NAME:" + name);
    map[mapKey] = {
      id: String(row[IDX.SALARY_SETTLEMENT.ID] || ""), ym: ym,
      teacherId: teacherId, teacherName: name,
      status: String(row[IDX.SALARY_SETTLEMENT.STATUS] || ""),
      baseAmount: Number(row[IDX.SALARY_SETTLEMENT.BASE_AMOUNT]) || 0,
      adjustmentAmount: Number(row[IDX.SALARY_SETTLEMENT.ADJUSTMENT_AMOUNT]) || 0,
      finalAmount: Number(row[IDX.SALARY_SETTLEMENT.FINAL_AMOUNT]) || 0,
      paidAmount: Number(row[IDX.SALARY_SETTLEMENT.PAID_AMOUNT]) || 0,
      balanceAmount: Number(row[IDX.SALARY_SETTLEMENT.BALANCE_AMOUNT]) || 0,
      sourceType: String(row[IDX.SALARY_SETTLEMENT.SOURCE_TYPE] || ""),
      confirmedAt: row[IDX.SALARY_SETTLEMENT.CONFIRMED_AT] && typeof row[IDX.SALARY_SETTLEMENT.CONFIRMED_AT].getTime === "function"
        ? Utilities.formatDate(row[IDX.SALARY_SETTLEMENT.CONFIRMED_AT], Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm")
        : String(row[IDX.SALARY_SETTLEMENT.CONFIRMED_AT] || ""),
      confirmedBy: String(row[IDX.SALARY_SETTLEMENT.CONFIRMED_BY] || ""),
      confirmedByName: "",
      directReceiptCount: 0,
      revisionCount: 0,
      snapshotVersion: 0,
      snapshotData: null
    };
  });
  var wanted = {};
  Object.keys(map).forEach(function(name) { wanted[map[name].id] = map[name]; });
  var wantedIds = Object.keys(wanted);
  if (!wantedIds.length) {
    console.log("[급여 확정 참조 조회 성능] " + JSON.stringify({
      targetYm: ym, settlements: 0, settlementMs: settlementLoadedAt - startedAt,
      usersMs: 0, entriesMs: 0, totalMs: Date.now() - startedAt
    }));
    return map;
  }

  var userDisplayNames = {};
  var userRows = DataRepository_getRows_(SHEET_NAMES.USERS, { required: false });
  userRows.slice(1).forEach(function(userRow) {
    var email = String(userRow[IDX.USER.EMAIL] || "").trim().toLowerCase();
    if (email) userDisplayNames[email] = String(userRow[IDX.USER.NAME] || "").trim() || email;
  });
  Object.keys(ACCESS_CONTROL.ADMIN_DISPLAY_NAMES || {}).forEach(function(email) {
    var key = String(email).toLowerCase();
    if (!userDisplayNames[key]) userDisplayNames[key] = ACCESS_CONTROL.ADMIN_DISPLAY_NAMES[email];
  });
  Object.keys(map).forEach(function(key) {
    var email = String(map[key].confirmedBy || "").trim().toLowerCase();
    map[key].confirmedByName = userDisplayNames[email] || email;
  });
  var usersLoadedAt = Date.now();

  // 상세내역은 정산 ID 열 인덱스로 현재 월에 필요한 행만 읽습니다. 스냅샷 JSON이
  // 큰 DB_급여내역 전체를 매번 전송하던 비용과 간헐적인 30초대 지연을 피합니다.
  var entrySheet = DataRepository_getSheet_(SHEET_NAMES.SALARY_ENTRIES, false);
  var entryRows = [];
  if (entrySheet && entrySheet.getLastRow() > 1) {
    var entryIndex = LookupIndex_get_(SHEET_NAMES.SALARY_ENTRIES, COL.SALARY_ENTRY.SETTLEMENT_ID, false);
    var wantedRowNumbers = {};
    wantedIds.forEach(function(id) {
      var normalizedId = LookupIndex_normalizeKey_(id);
      ((entryIndex.map && entryIndex.map[normalizedId]) || []).forEach(function(rowNumber) {
        wantedRowNumbers[Number(rowNumber)] = true;
      });
    });
    entryRows = LookupIndex_readRows_(entrySheet, Object.keys(wantedRowNumbers).map(Number)).map(function(item) {
      return item.row;
    });
  }
  var entriesLoadedAt = Date.now();
  var snapshots = {};
  entryRows.forEach(function(row) {
    var settlementId = String(row[IDX.SALARY_ENTRY.SETTLEMENT_ID] || "");
    if (!wanted[settlementId] || String(row[IDX.SALARY_ENTRY.STATUS] || "") === "취소") return;
    var type = String(row[IDX.SALARY_ENTRY.TYPE] || "");
    var isAdjustment = type === "조정추가" || type === "조정공제" || type === "확정액추가보정" || type === "확정액공제보정";
    if (type !== "정산요약" && type !== "계산근거" && type !== "직접수령제외" && !isAdjustment) return;
    var detail;
    try { detail = JSON.parse(String(row[IDX.SALARY_ENTRY.DETAILS] || "")); } catch (error) { detail = {}; }
    if (!snapshots[settlementId]) snapshots[settlementId] = { list: [], summary: null, adjustments: [] };
    if (type === "정산요약") {
      snapshots[settlementId].summary = detail.summary || null;
      wanted[settlementId].snapshotVersion = Number(detail.schemaVersion) || 1;
    }
    else if (type === "계산근거") snapshots[settlementId].list.push(detail);
    else if (type === "직접수령제외") {
      wanted[settlementId].directReceiptCount++;
      detail.directReceiptExcluded = true;
      detail.directReceiptReason = String(row[IDX.SALARY_ENTRY.MEMO] || "선입금");
      snapshots[settlementId].list.push(detail);
    }
    else {
      if (type === "확정액추가보정" || type === "확정액공제보정") wanted[settlementId].revisionCount++;
      snapshots[settlementId].adjustments.push({
      type: detail.type || "", typeText: detail.typeText || type,
      originAmount: Number(detail.originAmount) || Math.abs(Number(row[IDX.SALARY_ENTRY.AMOUNT]) || 0),
      finalAmount: Number(row[IDX.SALARY_ENTRY.AMOUNT]) || 0,
      note: String(row[IDX.SALARY_ENTRY.MEMO] || ""), isRate: !!detail.isRate, isTax: !!detail.isTax
      });
    }
  });
  Object.keys(wanted).forEach(function(id) {
    var snapshot = snapshots[id];
    if (snapshot && snapshot.summary) wanted[id].snapshotData = snapshot;
  });
  console.log("[급여 확정 참조 조회 성능] " + JSON.stringify({
    targetYm: ym, settlements: wantedIds.length,
    settlementMs: settlementLoadedAt - startedAt,
    usersMs: usersLoadedAt - settlementLoadedAt,
    entriesMs: entriesLoadedAt - usersLoadedAt,
    parseMs: Date.now() - entriesLoadedAt,
    totalMs: Date.now() - startedAt
  }));
  return map;
}

/** 개별·월 일괄 확정이 함께 사용하는 정산 저장기입니다. */
function SalaryManagement_appendSettlement_(tx, preview, requestId, batchId) {
  var ym = preview.ym;
  var teacher = preview.teacher;
  var calculated = preview.data;
  var baseAmount = preview.baseAmount;
  var adjustmentAmount = preview.adjustmentAmount;
  var finalAmount = preview.finalAmount;
  var entryRows = [];
  var now = new Date();
  var user = requireSuperAdmin_();
  var settlementId = createUniqueId_("SAL");
  preview.adjustments.forEach(function(item) {
    entryRows.push([createUniqueId_("SLE"), settlementId, item.finalAmount >= 0 ? "조정추가" : "조정공제", item.finalAmount, formatDateOnly_(now), safeSheetText_(item.note, 500), now, user.email, "완료", "", safeSheetText_(JSON.stringify(item), 5000)]);
  });
  var sheet = DataSchema_ensureSheet_(SHEET_NAMES.SALARY_SETTLEMENTS, tx).sheet;
  var initialStatus = SalaryManagement_status_(finalAmount, 0);
  tx.appendRows(sheet, [[settlementId, ym, teacher.id, teacher.name, initialStatus, baseAmount, adjustmentAmount, finalAmount, 0, finalAmount, "자동계산", "", now, now, now, user.email]]);
  entryRows.push([createUniqueId_("SLE"), settlementId, "정산요약", finalAmount, formatDateOnly_(now), "확정 시점 요약", now, user.email, "완료", teacher.id, safeSheetText_(JSON.stringify({ schemaVersion: SALARY_SNAPSHOT_SCHEMA_VERSION, previewToken: preview.previewToken, summary: calculated.summary, batchId: batchId || "" }), 10000)]);
  calculated.list.forEach(function(item) {
    entryRows.push([createUniqueId_("SLE"), settlementId, "계산근거", item.calculatedShare, formatDateOnly_(now), item.name, now, user.email, "완료", item.studentId, safeSheetText_(JSON.stringify(item), 10000)]);
  });
  preview.excluded.forEach(function(item) {
    var reason = preview.exclusions.filter(function(exclusion) { return exclusion.studentId === item.studentId; })[0];
    entryRows.push([createUniqueId_("SLE"), settlementId, "직접수령제외", -Math.abs(Number(item.calculatedShare) || 0), formatDateOnly_(now), reason ? reason.reason : "선입금", now, user.email, "완료", item.studentId, safeSheetText_(JSON.stringify(item), 10000)]);
  });
  if (entryRows.length) tx.appendRows(DataSchema_ensureSheet_(SHEET_NAMES.SALARY_ENTRIES, tx).sheet, entryRows);
  tx.queueEvent({ eventType: "급여정산확정", targetType: "급여정산", targetId: settlementId, field: "급여확정", before: "", after: ym + "/" + teacher.name + "/" + finalAmount, requestId: requestId, groupId: batchId || "", memo: "계산액:" + baseAmount + ", 조정:" + adjustmentAmount + ", 선입금 제외:" + preview.excluded.length + "명, 스냅샷:v" + SALARY_SNAPSHOT_SCHEMA_VERSION + (batchId ? ", 월일괄확정:" + batchId : "") });
  return { settlementId: settlementId, teacherId: teacher.id, teacherName: teacher.name, finalAmount: finalAmount, status: initialStatus, previewToken: preview.previewToken, schemaVersion: SALARY_SNAPSHOT_SCHEMA_VERSION };
}

function finalizeSalarySettlement(data) {
  requireSuperAdmin_();
  data = data || {};
  var requestId = optionalText_(data.requestId, 120);
  var completed = getCompletedRequest_(requestId);
  if (completed) return completed;
  var result = MutationPipeline_run_({ operation: "급여정산확정" }, function(tx) {
    // 구조 검증은 MutationPipeline_run_이 이미 수행합니다. 여기서 관리 기반자료를
    // 보정하면 직전 미리보기 이후 원본 세대가 바뀌어 토큰을 스스로 무효화할 수 있습니다.
    var preview = SalaryManagement_buildPreview_(data);
    var ym = preview.ym;
    var teacher = preview.teacher;
    if (SalaryManagement_findLatestSettlement_(ym, teacher.id)) throw new Error("이미 확정된 정산이 있습니다. 기존 정산에서 지급 또는 차액을 관리해주세요.");
    var suppliedToken = requireText_(data.previewToken, "급여 미리보기 토큰", 200);
    if (suppliedToken !== preview.previewToken) throw new Error("미리보기 이후 급여 원본 또는 입력값이 변경되었습니다. 서버 미리보기를 다시 확인해주세요.");
    if (data.expectedFinalAmount != null && data.expectedFinalAmount !== "" && requireMoney_(data.expectedFinalAmount, "화면 최종 급여", 0, 100000000) !== preview.finalAmount) {
      throw new Error("화면 최종 급여와 서버 확정 급여가 일치하지 않습니다. 다시 미리보기 해주세요.");
    }
    var saved = SalaryManagement_appendSettlement_(tx, preview, requestId, "");
    tx.invalidate([SHEET_NAMES.SALARY_SETTLEMENTS, SHEET_NAMES.SALARY_ENTRIES]);
    return saved;
  });
  markRequestCompleted_(requestId, result);
  return result;
}

/** 선택한 연·월의 미확정 원장 정산을 검증 후 전부 또는 전무로 확정합니다. */
function finalizeSalarySettlementsBatch(data) {
  requireSuperAdmin_();
  data = data || {};
  var requestId = requireText_(data.requestId, "월 일괄 확정 요청 ID", 120);
  var completed = getCompletedRequest_(requestId);
  if (completed) return completed;
  var ym = requireMonthString_(data.ym, "정산 월");
  var items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) throw new Error("일괄 확정할 미확정 원장이 없습니다.");
  if (items.length > 30) throw new Error("한 번에 확정할 수 있는 원장은 30명 이하입니다.");
  var result = MutationPipeline_run_({ operation: "급여정산월일괄확정" }, function(tx) {
    var sharedDb = loadAllData(ym, { fresh: true, cache: false });
    var seenTeachers = {};
    var previews = items.map(function(item) {
      item = item || {};
      if (requireMonthString_(item.ym, "원장별 정산 월") !== ym) throw new Error("일괄 확정 항목의 정산 월이 서로 다릅니다.");
      var preview = SalaryManagement_buildPreview_(item, sharedDb);
      if (seenTeachers[preview.teacher.id]) throw new Error("같은 원장이 일괄 확정 목록에 중복되어 있습니다: " + preview.teacher.name);
      seenTeachers[preview.teacher.id] = true;
      if (SalaryManagement_findLatestSettlement_(ym, preview.teacher.id)) throw new Error(preview.teacher.name + " 원장님의 정산은 이미 확정되어 있습니다. 화면을 새로고침해주세요.");
      var suppliedToken = requireText_(item.previewToken, preview.teacher.name + " 미리보기 토큰", 200);
      if (suppliedToken !== preview.previewToken) throw new Error(preview.teacher.name + " 원장님의 급여 원본 또는 입력값이 변경되었습니다. 다시 확인해주세요.");
      if (item.expectedFinalAmount != null && item.expectedFinalAmount !== "" && requireMoney_(item.expectedFinalAmount, preview.teacher.name + " 화면 최종 급여", 0, 100000000) !== preview.finalAmount) {
        throw new Error(preview.teacher.name + " 원장님의 화면 금액과 서버 금액이 일치하지 않습니다.");
      }
      return preview;
    });
    var saved = previews.map(function(preview) {
      return SalaryManagement_appendSettlement_(tx, preview, requestId, requestId);
    });
    tx.invalidate([SHEET_NAMES.SALARY_SETTLEMENTS, SHEET_NAMES.SALARY_ENTRIES]);
    return {
      ym: ym,
      count: saved.length,
      totalFinalAmount: saved.reduce(function(sum, item) { return sum + Number(item.finalAmount || 0); }, 0),
      settlements: saved,
      requestId: requestId
    };
  });
  markRequestCompleted_(requestId, result);
  return result;
}

function recordSalaryPayment(data) {
  data = data || {};
  data.adjustmentType = "PAYMENT_ADD";
  return recordSalarySettlementAdjustment(data);
}

/** 선택한 연·월의 확정 정산 중 남은 양수 잔액을 전부 또는 전무로 지급 처리합니다. */
function recordSalaryMonthPayments(data) {
  requireSuperAdmin_();
  data = data || {};
  var requestId = requireText_(data.requestId, "월 일괄 지급 요청 ID", 120);
  var completed = getCompletedRequest_(requestId);
  if (completed) return completed;
  var ym = requireMonthString_(data.ym, "지급 대상 월");
  var entryDate = requireDateString_(data.entryDate, "일괄 지급일");
  var expectedCount = Number(data.expectedCount);
  if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 30) throw new Error("확인 화면의 지급 대상 인원수가 올바르지 않습니다.");
  var expectedTotalPaid = requireMoney_(data.expectedTotalPaid, "확인 화면의 총 지급액", 1, 3000000000);
  var memoText = optionalText_(data.memo, 500);
  var memo = safeSheetText_(memoText || (ym + " 급여 일괄 지급"), 500);
  var result = MutationPipeline_run_({ operation: "급여월일괄지급" }, function(tx) {
    Management_ensureInfrastructure_();
    var sheet = DataSchema_ensureSheet_(SHEET_NAMES.SALARY_SETTLEMENTS, tx).sheet;
    if (sheet.getLastRow() < 2) throw new Error("지급할 확정 급여가 없습니다.");
    var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, COL.SALARY_SETTLEMENT.CONFIRMED_BY).getValues();
    var now = new Date();
    var user = requireSuperAdmin_();
    var seenTeachers = {};
    var entryRows = [];
    var paidItems = [];

    rows.forEach(function(row) {
      if (SalaryManagement_normalizeYmCell_(row[IDX.SALARY_SETTLEMENT.YM]) !== ym || String(row[IDX.SALARY_SETTLEMENT.STATUS] || "") === "취소") return;
      var finalAmount = Number(row[IDX.SALARY_SETTLEMENT.FINAL_AMOUNT]) || 0;
      var beforePaid = Number(row[IDX.SALARY_SETTLEMENT.PAID_AMOUNT]) || 0;
      var balance = finalAmount - beforePaid;
      if (balance <= 0) return;
      var teacherKey = String(row[IDX.SALARY_SETTLEMENT.TEACHER_ID] || row[IDX.SALARY_SETTLEMENT.TEACHER_NAME] || "");
      if (seenTeachers[teacherKey]) throw new Error("같은 월에 중복된 원장 정산이 있어 일괄 지급을 중단했습니다: " + String(row[IDX.SALARY_SETTLEMENT.TEACHER_NAME] || ""));
      seenTeachers[teacherKey] = true;
      var settlementId = String(row[IDX.SALARY_SETTLEMENT.ID] || "");
      row[IDX.SALARY_SETTLEMENT.PAID_AMOUNT] = finalAmount;
      row[IDX.SALARY_SETTLEMENT.BALANCE_AMOUNT] = 0;
      row[IDX.SALARY_SETTLEMENT.STATUS] = SalaryManagement_status_(finalAmount, finalAmount);
      row[IDX.SALARY_SETTLEMENT.UPDATED_AT] = now;
      entryRows.push([createUniqueId_("SLE"), settlementId, "지급", balance, entryDate, memo, now, user.email, "완료", teacherKey, safeSheetText_(JSON.stringify({ action: "MONTH_PAYMENT", ym: ym, requestId: requestId, beforePaid: beforePaid, afterPaid: finalAmount, finalAmount: finalAmount }), 5000)]);
      paidItems.push({ settlementId: settlementId, teacherId: teacherKey, teacherName: String(row[IDX.SALARY_SETTLEMENT.TEACHER_NAME] || ""), amount: balance });
      tx.queueEvent({ eventType: "급여월일괄지급", targetType: "급여정산", targetId: settlementId, field: "지급", before: String(beforePaid), after: String(finalAmount), requestId: requestId, groupId: requestId, memo: memo });
    });
    if (!paidItems.length) throw new Error("해당 월에 지급할 미지급 잔액이 없습니다.");
    if (paidItems.length > 30) throw new Error("한 번에 지급할 수 있는 원장은 30명 이하입니다.");
    var totalPaid = paidItems.reduce(function(sum, item) { return sum + item.amount; }, 0);
    if (paidItems.length !== expectedCount || totalPaid !== expectedTotalPaid) {
      throw new Error("확인 후 정산 지급 상태가 변경되었습니다. 목록을 새로 불러온 뒤 금액을 다시 확인해주세요.");
    }
    tx.writeRange(sheet, 2, 1, rows);
    tx.appendRows(DataSchema_ensureSheet_(SHEET_NAMES.SALARY_ENTRIES, tx).sheet, entryRows);
    tx.invalidate([SHEET_NAMES.SALARY_SETTLEMENTS, SHEET_NAMES.SALARY_ENTRIES]);
    return {
      ym: ym,
      entryDate: entryDate,
      count: paidItems.length,
      totalPaid: totalPaid,
      settlements: paidItems,
      requestId: requestId
    };
  });
  markRequestCompleted_(requestId, result);
  return result;
}

function recordSalarySettlementAdjustment(data) {
  requireSuperAdmin_();
  data = data || {};
  return MutationPipeline_run_({ operation: "급여정산보정" }, function(tx) {
    var settlementId = requireText_(data.settlementId, "정산 ID", 120);
    var action = requireText_(data.adjustmentType, "처리 유형", 30);
    var allowed = ["PAYMENT_ADD", "PAYMENT_SUB", "FINAL_ADD", "FINAL_SUB"];
    if (allowed.indexOf(action) === -1) throw new Error("허용되지 않은 급여 보정 유형입니다.");
    var amount = requireMoney_(data.amount, "처리 금액", 1, 100000000);
    var entryDate = requireDateString_(data.entryDate, "처리일");
    var memoText = optionalText_(data.memo, 500);
    if (action !== "PAYMENT_ADD" && !memoText) throw new Error("보정 사유를 입력해주세요.");
    var memo = safeSheetText_(memoText || "급여 지급", 500);
    var found = SalaryManagement_findSettlementById_(settlementId);
    if (!found) throw new Error("정산 기록을 찾을 수 없습니다.");
    var row = found.values;
    if (String(row[IDX.SALARY_SETTLEMENT.STATUS] || "") === "취소") throw new Error("취소된 정산은 보정할 수 없습니다.");
    var beforeFinal = Number(row[IDX.SALARY_SETTLEMENT.FINAL_AMOUNT]) || 0;
    var beforePaid = Number(row[IDX.SALARY_SETTLEMENT.PAID_AMOUNT]) || 0;
    var finalAmount = beforeFinal;
    var paidAmount = beforePaid;
    var entryType = "";
    var signed = amount;
    if (action === "PAYMENT_ADD") { paidAmount += amount; entryType = "지급"; }
    if (action === "PAYMENT_SUB") {
      if (amount > paidAmount) throw new Error("차감 보정액이 현재 지급액보다 큽니다.");
      paidAmount -= amount; entryType = "지급차감보정"; signed = -amount;
    }
    if (action === "FINAL_ADD") { finalAmount += amount; entryType = "확정액추가보정"; }
    if (action === "FINAL_SUB") {
      if (amount > finalAmount) throw new Error("공제 보정액이 현재 확정액보다 큽니다.");
      finalAmount -= amount; entryType = "확정액공제보정"; signed = -amount;
    }
    row[IDX.SALARY_SETTLEMENT.FINAL_AMOUNT] = finalAmount;
    row[IDX.SALARY_SETTLEMENT.ADJUSTMENT_AMOUNT] = finalAmount - (Number(row[IDX.SALARY_SETTLEMENT.BASE_AMOUNT]) || 0);
    row[IDX.SALARY_SETTLEMENT.PAID_AMOUNT] = paidAmount;
    row[IDX.SALARY_SETTLEMENT.BALANCE_AMOUNT] = finalAmount - paidAmount;
    row[IDX.SALARY_SETTLEMENT.STATUS] = SalaryManagement_status_(finalAmount, paidAmount);
    row[IDX.SALARY_SETTLEMENT.UPDATED_AT] = new Date();
    tx.writeRange(found.sheet, found.row, 1, [row]);
    var user = requireSuperAdmin_();
    tx.appendRows(DataSchema_ensureSheet_(SHEET_NAMES.SALARY_ENTRIES, tx).sheet, [[createUniqueId_("SLE"), settlementId, entryType, signed, entryDate, memo, new Date(), user.email, "완료", "", safeSheetText_(JSON.stringify({ action: action, beforeFinal: beforeFinal, afterFinal: finalAmount, beforePaid: beforePaid, afterPaid: paidAmount }), 5000)]]);
    tx.queueEvent({ eventType: "급여정산보정", targetType: "급여정산", targetId: settlementId, field: entryType, before: "확정:" + beforeFinal + "/지급:" + beforePaid, after: "확정:" + finalAmount + "/지급:" + paidAmount, memo: memo });
    tx.invalidate([SHEET_NAMES.SALARY_SETTLEMENTS, SHEET_NAMES.SALARY_ENTRIES]);
    return { status: row[IDX.SALARY_SETTLEMENT.STATUS], finalAmount: finalAmount, paidAmount: paidAmount, balanceAmount: finalAmount - paidAmount };
  });
}

function cancelSalarySettlement(settlementId, reason) {
  requireSuperAdmin_();
  return MutationPipeline_run_({ operation: "급여정산취소" }, function(tx) {
    settlementId = requireText_(settlementId, "정산 ID", 120);
    reason = safeSheetText_(requireText_(reason, "취소 사유", 500), 500);
    var found = SalaryManagement_findSettlementById_(settlementId);
    if (!found) throw new Error("정산 기록을 찾을 수 없습니다.");
    var row = found.values;
    if (String(row[IDX.SALARY_SETTLEMENT.STATUS] || "") === "취소") return { cancelled: true };
    if ((Number(row[IDX.SALARY_SETTLEMENT.PAID_AMOUNT]) || 0) !== 0) throw new Error("지급 기록이 있는 정산은 취소할 수 없습니다. 지급액 차감 보정 후 취소해주세요.");
    var beforeStatus = String(row[IDX.SALARY_SETTLEMENT.STATUS] || "");
    row[IDX.SALARY_SETTLEMENT.STATUS] = "취소";
    row[IDX.SALARY_SETTLEMENT.MEMO] = [String(row[IDX.SALARY_SETTLEMENT.MEMO] || ""), "[취소] " + reason].filter(Boolean).join(" / ");
    row[IDX.SALARY_SETTLEMENT.UPDATED_AT] = new Date();
    tx.writeRange(found.sheet, found.row, 1, [row]);
    var entrySheet = DataSchema_ensureSheet_(SHEET_NAMES.SALARY_ENTRIES, tx).sheet;
    if (entrySheet.getLastRow() > 1) {
      var entryRows = entrySheet.getRange(2, 1, entrySheet.getLastRow() - 1, COL.SALARY_ENTRY.DETAILS).getValues();
      var changed = false;
      entryRows.forEach(function(entry) {
        if (String(entry[IDX.SALARY_ENTRY.SETTLEMENT_ID] || "") === settlementId) { entry[IDX.SALARY_ENTRY.STATUS] = "취소"; changed = true; }
      });
      if (changed) tx.writeRange(entrySheet, 2, 1, entryRows);
    }
    tx.queueEvent({ eventType: "급여정산취소", targetType: "급여정산", targetId: settlementId, field: "정산상태", before: beforeStatus, after: "취소", memo: reason });
    tx.invalidate([SHEET_NAMES.SALARY_SETTLEMENTS, SHEET_NAMES.SALARY_ENTRIES]);
    return { cancelled: true };
  });
}
