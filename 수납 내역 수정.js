/**
 * ---------------------------------------------------------
 * [수납 수정 구역] 잘못된 수납 내역 고치기
 * ---------------------------------------------------------
 */

function showPaymentEditPopup() {
  requireSpreadsheetSuperAdmin_();
  var html = HtmlService.createTemplateFromFile('PaymentEdit').evaluate()
      .setWidth(400)
      .setHeight(600);
  SpreadsheetApp.getUi().showModalDialog(html, '수납 내역 수정');
}




/** 학생 ID로 전체 수납 내역을 최신 저장 순서부터 조회합니다. */
function getPaymentHistoryForEdit(studentId) {
  requireSuperAdmin_();
  var paySheet = DataRepository_getSheet_(SHEET_NAMES.PAYMENTS, false);
  if (!paySheet) return JSON.stringify([]);

  var cleanTarget = requireText_(studentId, "학생 ID", 100).replace(/[\s\u00A0\u200B\uFEFF]+/g, "");
  var indexedRows = LookupIndex_findRows_(SHEET_NAMES.PAYMENTS, COL.PAYMENT.STUDENT_ID, cleanTarget);
  var history = [];
  for (var i = indexedRows.length - 1; i >= 0; i--) {
    var dataRow = indexedRows[i].row;
    var rawRowId = dataRow[IDX.PAYMENT.STUDENT_ID];
    var cleanRowId = String(rawRowId).replace(/[\s\u00A0\u200B\uFEFF]+/g, "");

    if (cleanRowId === cleanTarget) {
      var payDate = parseDateOnly_(dataRow[IDX.PAYMENT.PAY_DATE]);
      history.push({
        payId: dataRow[IDX.PAYMENT.ID],
        row: indexedRows[i].rowNumber,
        date: payDate ? formatDateOnly_(payDate) : "",
        fullDate: payDate ? formatDateOnly_(payDate) : "",
        month: MonthlySnapshot_monthString_(dataRow[IDX.PAYMENT.MONTH]),
        amount: dataRow[IDX.PAYMENT.AMOUNT],
        method: normalizePaymentMethod_(dataRow[IDX.PAYMENT.METHOD]),
        memo: dataRow[IDX.PAYMENT.MEMO],
        type: normalizePaymentType_(dataRow[IDX.PAYMENT.TYPE]),
        calcType: dataRow[IDX.PAYMENT.CALC_TYPE] || "",
        calcStart: formatDateOnly_(parseDateOnly_(dataRow[IDX.PAYMENT.CALC_START])) || "",
        calcEnd: formatDateOnly_(parseDateOnly_(dataRow[IDX.PAYMENT.CALC_END])) || "",
        activeDays: dataRow[IDX.PAYMENT.ACTIVE_DAYS] || "",
        billingDays: dataRow[IDX.PAYMENT.BILLING_DAYS] || "",
        siblingDiscount: dataRow[IDX.PAYMENT.SIBLING_DISCOUNT] || 0,
        otherDiscount: dataRow[IDX.PAYMENT.OTHER_DISCOUNT] || 0
      });
    }
  }
  return JSON.stringify(history);
}

/**
 * 💾 [완결판] 수납 내역 수정 및 삭제 (강력 캐시 폭파 & 로그 기록)
 */
