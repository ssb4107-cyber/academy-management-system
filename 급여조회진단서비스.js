/** 급여 확정본 조회·인쇄·원장·데이터 진단 서비스 */
function listSalarySettlementRecords() {
  requireSuperAdmin_();
  return SalarySettlement_listRecords_();
}

function SalarySettlement_listRecords_() {
  var rows = DataRepository_getRows_(SHEET_NAMES.SALARY_SETTLEMENTS, { required: false });
  if (rows.length < 2) return [];
  return rows.slice(1).map(function(row) {
    return { id: row[IDX.SALARY_SETTLEMENT.ID], ym: SalaryManagement_normalizeYmCell_(row[IDX.SALARY_SETTLEMENT.YM]), teacherName: row[IDX.SALARY_SETTLEMENT.TEACHER_NAME], finalAmount: Number(row[IDX.SALARY_SETTLEMENT.FINAL_AMOUNT]) || 0, paidAmount: Number(row[IDX.SALARY_SETTLEMENT.PAID_AMOUNT]) || 0, balanceAmount: Number(row[IDX.SALARY_SETTLEMENT.BALANCE_AMOUNT]) || 0, status: row[IDX.SALARY_SETTLEMENT.STATUS], sourceType: row[IDX.SALARY_SETTLEMENT.SOURCE_TYPE], memo: row[IDX.SALARY_SETTLEMENT.MEMO], confirmedAt: row[IDX.SALARY_SETTLEMENT.CONFIRMED_AT] ? String(row[IDX.SALARY_SETTLEMENT.CONFIRMED_AT]) : "", confirmedBy: String(row[IDX.SALARY_SETTLEMENT.CONFIRMED_BY] || "") };
  }).sort(function(a, b) { return b.ym.localeCompare(a.ym) || String(a.teacherName).localeCompare(String(b.teacherName), "ko"); });
}

function listHistoricalSalaryRecords() { return listSalarySettlementRecords(); }

/** 급여 관리 탭의 정산 기록과 원장 목록을 한 번의 인증·브라우저 왕복으로 반환합니다. */
function getSalaryAdminInitialData() {
  requireSuperAdmin_();
  return {
    records:SalarySettlement_listRecords_(),
    teachers:TeacherDirectory_list_()
  };
}

/** 현재 학생·수납 원본을 재계산하지 않고 확정 당시 급여 기록만으로 출력 자료를 만듭니다. */
function getSalarySettlementPrintData(settlementId) {
  requireSuperAdmin_();
  settlementId = requireText_(settlementId, "정산 ID", 120);
  var found = SalaryManagement_findSettlementById_(settlementId);
  if (!found) throw new Error("정산 기록을 찾을 수 없습니다.");
  var row = found.values;
  var sourceType = String(row[IDX.SALARY_SETTLEMENT.SOURCE_TYPE] || "");
  var settlement = {
    id: settlementId,
    ym: SalaryManagement_normalizeYmCell_(row[IDX.SALARY_SETTLEMENT.YM]),
    teacherName: String(row[IDX.SALARY_SETTLEMENT.TEACHER_NAME] || ""),
    status: String(row[IDX.SALARY_SETTLEMENT.STATUS] || ""),
    baseAmount: Number(row[IDX.SALARY_SETTLEMENT.BASE_AMOUNT]) || 0,
    adjustmentAmount: Number(row[IDX.SALARY_SETTLEMENT.ADJUSTMENT_AMOUNT]) || 0,
    finalAmount: Number(row[IDX.SALARY_SETTLEMENT.FINAL_AMOUNT]) || 0,
    paidAmount: Number(row[IDX.SALARY_SETTLEMENT.PAID_AMOUNT]) || 0,
    balanceAmount: Number(row[IDX.SALARY_SETTLEMENT.BALANCE_AMOUNT]) || 0,
    sourceType: sourceType,
    confirmedAt: row[IDX.SALARY_SETTLEMENT.CONFIRMED_AT] && typeof row[IDX.SALARY_SETTLEMENT.CONFIRMED_AT].getTime === "function"
      ? Utilities.formatDate(row[IDX.SALARY_SETTLEMENT.CONFIRMED_AT], Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm")
      : String(row[IDX.SALARY_SETTLEMENT.CONFIRMED_AT] || ""),
    confirmedBy: String(row[IDX.SALARY_SETTLEMENT.CONFIRMED_BY] || ""),
    confirmedByName: Management_getUserDisplayName_(row[IDX.SALARY_SETTLEMENT.CONFIRMED_BY]),
    directReceiptCount: 0,
    revisionCount: 0
  };
  if (!settlement.ym) throw new Error("확정 정산의 월 형식이 올바르지 않아 출력할 수 없습니다.");
  var entrySheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.SALARY_ENTRIES);
  var list = [];
  var adjustments = [];
  var summary = null;
  var snapshotVersion = 0;
  if (entrySheet && entrySheet.getLastRow() > 1) {
    entrySheet.getRange(2, 1, entrySheet.getLastRow() - 1, COL.SALARY_ENTRY.DETAILS).getValues().forEach(function(entry) {
      if (String(entry[IDX.SALARY_ENTRY.SETTLEMENT_ID] || "") !== settlementId || String(entry[IDX.SALARY_ENTRY.STATUS] || "") === "취소") return;
      var type = String(entry[IDX.SALARY_ENTRY.TYPE] || "");
      var detail;
      try { detail = JSON.parse(String(entry[IDX.SALARY_ENTRY.DETAILS] || "{}")); } catch (ignored) { detail = {}; }
      if (type === "정산요약") {
        summary = detail.summary || null;
        snapshotVersion = Number(detail.schemaVersion) || 1;
      } else if (type === "계산근거") {
        list.push(detail);
      } else if (type === "직접수령제외") {
        detail.directReceiptExcluded = true;
        detail.directReceiptReason = String(entry[IDX.SALARY_ENTRY.MEMO] || "선입금");
        list.push(detail);
        settlement.directReceiptCount++;
      } else if (type === "조정추가" || type === "조정공제" || type === "확정액추가보정" || type === "확정액공제보정") {
        if (type === "확정액추가보정" || type === "확정액공제보정") settlement.revisionCount++;
        adjustments.push({
          type: detail.type || "",
          typeText: detail.typeText || type,
          originAmount: Number(detail.originAmount) || Math.abs(Number(entry[IDX.SALARY_ENTRY.AMOUNT]) || 0),
          finalAmount: Number(entry[IDX.SALARY_ENTRY.AMOUNT]) || 0,
          note: String(entry[IDX.SALARY_ENTRY.MEMO] || ""),
          isRate: !!detail.isRate,
          isTax: !!detail.isTax
        });
      }
    });
  }
  if (sourceType === "과거수동") {
    return { printable: true, summaryOnly: true, snapshotVersion: 0, teacher: settlement.teacherName, ym: settlement.ym, settlement: settlement };
  }
  if (!summary || !list.length) throw new Error("확정 당시 학생별 급여 스냅샷이 없어 확정본을 출력할 수 없습니다. 급여 데이터 점검을 실행해주세요.");
  var includedShare = list.filter(function(item) { return !item.directReceiptExcluded; }).reduce(function(sum, item) { return sum + (Number(item.calculatedShare) || 0); }, 0);
  var adjustmentTotal = adjustments.reduce(function(sum, item) { return sum + (Number(item.finalAmount) || 0); }, 0);
  if (includedShare !== Number(summary.teacherShare || 0) || Number(summary.finalPay || 0) !== settlement.baseAmount) {
    throw new Error("확정 스냅샷의 학생별 계산 합계가 정산 요약과 일치하지 않아 출력을 중단했습니다.");
  }
  if (adjustmentTotal !== settlement.adjustmentAmount || settlement.baseAmount + settlement.adjustmentAmount !== settlement.finalAmount) {
    throw new Error("확정 스냅샷의 조정 합계가 현재 확정액과 일치하지 않아 출력을 중단했습니다.");
  }
  return {
    printable: true,
    summaryOnly: false,
    snapshotVersion: snapshotVersion,
    teacher: settlement.teacherName,
    ym: settlement.ym,
    settlement: settlement,
    data: { list: list, summary: summary, adjustments: adjustments }
  };
}

function getSalarySettlementLedger(settlementId) {
  requireSuperAdmin_();
  settlementId = requireText_(settlementId, "정산 ID", 120);
  var found = SalaryManagement_findSettlementById_(settlementId);
  if (!found) throw new Error("정산 기록을 찾을 수 없습니다.");
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var entrySheet = ss.getSheetByName(SHEET_NAMES.SALARY_ENTRIES);
  var transactions = [];
  var calculationCount = 0;
  if (entrySheet && entrySheet.getLastRow() > 1) {
    LookupIndex_findRows_(SHEET_NAMES.SALARY_ENTRIES, COL.SALARY_ENTRY.SETTLEMENT_ID, settlementId, false).forEach(function(record) {
      var row = record.row;
      var type = String(row[IDX.SALARY_ENTRY.TYPE] || "");
      if (type === "계산근거") { calculationCount++; return; }
      if (type === "정산요약") return;
      transactions.push({
        type: type, amount: Number(row[IDX.SALARY_ENTRY.AMOUNT]) || 0,
        entryDate: row[IDX.SALARY_ENTRY.ENTRY_DATE] ? formatDateOnly_(parseDateOnly_(row[IDX.SALARY_ENTRY.ENTRY_DATE])) : "",
        memo: String(row[IDX.SALARY_ENTRY.MEMO] || ""), status: String(row[IDX.SALARY_ENTRY.STATUS] || "")
      });
    });
  }
  var row = found.values;
  return {
    id: settlementId, ym: SalaryManagement_normalizeYmCell_(row[IDX.SALARY_SETTLEMENT.YM]),
    teacherName: String(row[IDX.SALARY_SETTLEMENT.TEACHER_NAME] || ""),
    finalAmount: Number(row[IDX.SALARY_SETTLEMENT.FINAL_AMOUNT]) || 0,
    paidAmount: Number(row[IDX.SALARY_SETTLEMENT.PAID_AMOUNT]) || 0,
    balanceAmount: Number(row[IDX.SALARY_SETTLEMENT.BALANCE_AMOUNT]) || 0,
    calculationCount: calculationCount, transactions: transactions
  };
}

function runSalaryDataDiagnostics() {
  requireSuperAdmin_();
  var issues = [];
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var infrastructureSheets = [SHEET_NAMES.TEACHERS, SHEET_NAMES.USERS, SHEET_NAMES.SETTINGS,
    SHEET_NAMES.SALARY_SETTLEMENTS, SHEET_NAMES.SALARY_ENTRIES];
  var needsInfrastructure = infrastructureSheets.some(function(sheetName) { return !ss.getSheetByName(sheetName); });
  var teacherSheetForCheck = ss.getSheetByName(SHEET_NAMES.TEACHERS);
  var userSheetForCheck = ss.getSheetByName(SHEET_NAMES.USERS);
  if (needsInfrastructure || (teacherSheetForCheck && teacherSheetForCheck.getLastRow() < 2) ||
      (userSheetForCheck && userSheetForCheck.getLastRow() < 2)) {
    Management_ensureInfrastructure_();
  }
  // 진단 시점의 원본을 한 번씩만 읽어 같은 실행 안에서 서로 다른 시점의 행이 섞이지 않게 합니다.
  var diagnosticContext = DataRepository_loadContext_([
    SHEET_NAMES.TEACHERS, SHEET_NAMES.USERS, SHEET_NAMES.STUDENTS,
    SHEET_NAMES.SALARY_SETTLEMENTS, SHEET_NAMES.SALARY_ENTRIES
  ], { required:false, fresh:true, cache:false });
  var teacherRows = (diagnosticContext[SHEET_NAMES.TEACHERS] || []).slice(1);
  var teacherIds = {};
  var teacherNames = {};
  var teacherNameById = {};
  var teacherActiveById = {};
  teacherRows.forEach(function(row, index) {
    var rowNumber = index + 2;
    var teacherId = String(row[IDX.TEACHER.ID] || "").trim();
    var teacherName = String(row[IDX.TEACHER.NAME] || "").trim();
    if (!teacherId || !teacherName) {
      issues.push({ severity: "높음", message: "DB_원장 " + rowNumber + "행의 원장 ID 또는 원장명이 비어 있습니다." });
      return;
    }
    if (teacherIds[teacherId]) issues.push({ severity: "높음", message: "DB_원장에 중복 원장 ID가 있습니다: " + teacherId });
    if (teacherNames[teacherName]) issues.push({ severity: "높음", message: "DB_원장에 중복 원장명이 있습니다: " + teacherName });
    teacherIds[teacherId] = true;
    teacherNames[teacherName] = true;
    teacherNameById[teacherId] = teacherName;
    teacherActiveById[teacherId] = Management_toBoolean_(row[IDX.TEACHER.ACTIVE]);
  });
  var userRows = (diagnosticContext[SHEET_NAMES.USERS] || []).slice(1);
  if (userRows.length) {
    userRows.forEach(function(row, index) {
      if (!Management_toBoolean_(row[IDX.USER.ACTIVE])) return;
      var linkedTeacherId = String(row[IDX.USER.TEACHER_ID] || "").trim();
      if (!linkedTeacherId) return;
      var email = String(row[IDX.USER.EMAIL] || "").trim();
      if (!teacherIds[linkedTeacherId]) {
        issues.push({ severity: "높음", message: (index + 2) + "행 활성 사용자의 연결 원장 ID가 DB_원장에 없습니다: " + email + "/" + linkedTeacherId });
      } else if (!teacherActiveById[linkedTeacherId]) {
        issues.push({ severity: "중간", message: (index + 2) + "행 활성 사용자가 비활성 원장과 연결되어 있습니다: " + email + "/" + teacherNameById[linkedTeacherId] });
      }
    });
  }
  var studentRows = (diagnosticContext[SHEET_NAMES.STUDENTS] || []).slice(1);
  if (studentRows.length) {
    studentRows.forEach(function(row, index) {
      try { Salary_normalizeRate_(row[IDX.STUDENT.RATE]); }
      catch (error) { issues.push({ severity: "높음", message: (index + 2) + "행 " + String(row[IDX.STUDENT.NAME] || "") + " 학생 배분율 오류: " + error.message }); }
      var assignedTeacher = String(row[IDX.STUDENT.TEACHER] || "").trim();
      if (!assignedTeacher || !teacherNames[assignedTeacher]) {
        issues.push({ severity: "높음", message: (index + 2) + "행 " + String(row[IDX.STUDENT.NAME] || "") + " 학생의 담당 원장이 DB_원장과 연결되지 않습니다: " + (assignedTeacher || "(빈 값)") });
      }
    });
  }
  var settlements = (diagnosticContext[SHEET_NAMES.SALARY_SETTLEMENTS] || []).slice(1);
  var entries = (diagnosticContext[SHEET_NAMES.SALARY_ENTRIES] || []).slice(1);
  var entryStats = {};
  entries.forEach(function(row) {
    if (String(row[IDX.SALARY_ENTRY.STATUS] || "") === "취소") return;
    var id = String(row[IDX.SALARY_ENTRY.SETTLEMENT_ID] || "");
    if (!entryStats[id]) entryStats[id] = { paid: 0, adjustment: 0, detailCount: 0, summaryCount: 0 };
    var type = String(row[IDX.SALARY_ENTRY.TYPE] || "");
    var amount = Number(row[IDX.SALARY_ENTRY.AMOUNT]) || 0;
    if (type === "지급" || type === "지급차감보정") entryStats[id].paid += amount;
    if (type === "조정추가" || type === "조정공제" || type === "확정액추가보정" || type === "확정액공제보정") entryStats[id].adjustment += amount;
    if (type === "계산근거") entryStats[id].detailCount++;
    if (type === "정산요약") entryStats[id].summaryCount++;
  });
  var activeKeys = {};
  settlements.forEach(function(row, index) {
    var id = String(row[IDX.SALARY_SETTLEMENT.ID] || "");
    var status = String(row[IDX.SALARY_SETTLEMENT.STATUS] || "");
    if (status === "취소") return;
    var settlementTeacherId = String(row[IDX.SALARY_SETTLEMENT.TEACHER_ID] || "").trim();
    var settlementTeacherName = String(row[IDX.SALARY_SETTLEMENT.TEACHER_NAME] || "").trim();
    if (!teacherIds[settlementTeacherId]) {
      issues.push({ severity: "높음", message: (index + 2) + "행 급여 정산의 원장 ID가 DB_원장에 없습니다: " + (settlementTeacherId || "(빈 값)") });
    } else if (teacherNameById[settlementTeacherId] !== settlementTeacherName) {
      issues.push({ severity: "높음", message: (index + 2) + "행 급여 정산의 원장 ID와 원장명이 일치하지 않습니다: " + settlementTeacherId + "/" + settlementTeacherName });
    }
    var normalizedYm = SalaryManagement_normalizeYmCell_(row[IDX.SALARY_SETTLEMENT.YM]);
    if (!normalizedYm) issues.push({ severity: "높음", message: (index + 2) + "행 급여 정산 월 형식이 올바르지 않습니다." });
    var label = (normalizedYm || "월 형식 오류") + " " + String(row[IDX.SALARY_SETTLEMENT.TEACHER_NAME] || "");
    var key = normalizedYm + "|" + String(row[IDX.SALARY_SETTLEMENT.TEACHER_ID] || "");
    if (activeKeys[key]) issues.push({ severity: "높음", message: label + " 활성 정산이 중복되어 있습니다." });
    activeKeys[key] = true;
    var base = Number(row[IDX.SALARY_SETTLEMENT.BASE_AMOUNT]) || 0;
    var adjustment = Number(row[IDX.SALARY_SETTLEMENT.ADJUSTMENT_AMOUNT]) || 0;
    var finalAmount = Number(row[IDX.SALARY_SETTLEMENT.FINAL_AMOUNT]) || 0;
    var paid = Number(row[IDX.SALARY_SETTLEMENT.PAID_AMOUNT]) || 0;
    var balance = Number(row[IDX.SALARY_SETTLEMENT.BALANCE_AMOUNT]) || 0;
    if (base + adjustment !== finalAmount) issues.push({ severity: "높음", message: label + " 확정액이 계산액+조정액과 일치하지 않습니다." });
    if (finalAmount - paid !== balance) issues.push({ severity: "높음", message: label + " 잔액이 확정액-지급액과 일치하지 않습니다." });
    var stat = entryStats[id] || { paid: 0, adjustment: 0, detailCount: 0, summaryCount: 0 };
    if (stat.paid !== paid) issues.push({ severity: "높음", message: label + " 지급 내역 합계와 정산 지급액이 일치하지 않습니다." });
    if (stat.adjustment !== adjustment) issues.push({ severity: "중간", message: label + " 조정 내역 합계와 정산 조정액이 일치하지 않습니다." });
    if (String(row[IDX.SALARY_SETTLEMENT.SOURCE_TYPE] || "") === "자동계산" && (!stat.detailCount || !stat.summaryCount)) {
      issues.push({ severity: "중간", message: label + " 확정 시점 학생별 계산 스냅샷이 없습니다. 기존 방식으로 확정된 기록일 수 있습니다." });
    }
  });
  return { checkedAt: formatDateOnly_(new Date()), settlements: settlements.length, entries: entries.length, issues: issues, healthy: issues.length === 0 };
}
