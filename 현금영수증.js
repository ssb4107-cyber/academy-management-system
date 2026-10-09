/**
 * ---------------------------------------------------------
 * [현금영수증 관리 구역] O열(인덱스 14) 현금영수증 번호, P열(인덱스 15) 입금자명 활용
 * ---------------------------------------------------------
 */

// 1. 현금영수증 창 열기
function openCashReceiptModal() {
  requireSpreadsheetSuperAdmin_();
  var html = HtmlService.createTemplateFromFile('CashReceipt').evaluate()
      .setWidth(800)
      .setHeight(700);
  SpreadsheetApp.getUi().showModalDialog(html, '🧾 현금영수증 발급 명단 관리');
}

// 2. 발급 대상자 목록 조회 및 전체 학생 조회
function getCashReceiptData() {
  requireSuperAdmin_();
  var context = DataRepository_loadContext_([SHEET_NAMES.STUDENTS, SHEET_NAMES.LOGS], { required: false });
  var data = context[SHEET_NAMES.STUDENTS] || [];
  var histories = buildStudentChangeHistory_(context[SHEET_NAMES.LOGS] || []);
  var asOfDate = new Date(); asOfDate.setHours(23, 59, 59, 999);
  
  var receiptList = [];
  var allActiveStudents = [];
  
  for (var i = 1; i < data.length; i++) {
    var id = String(data[i][IDX.STUDENT.ID]).trim();
    if (!id) continue;
    
    var name = data[i][IDX.STUDENT.NAME];
    var grade = data[i][IDX.STUDENT.GRADE];
    var status = resolveStudentStateAtDate_(data[i], histories, asOfDate).status;
    var baseDay = data[i][IDX.STUDENT.BASE_DAY];
    var parentPhone = data[i][IDX.STUDENT.PHONE];
    var receiptPhone = data[i][IDX.STUDENT.CASH_RECEIPT];
    var parentName = data[i][IDX.STUDENT.PARENT_NAME];

    // '재원' 학생만 추가 목록에 올림
    if (status === "재원") {
      allActiveStudents.push({
        id: id, 
        name: name, 
        grade: grade, 
        defaultPhone: parentPhone,
        parentName: parentName ? String(parentName).trim() : "" // ★ 입금자명 추가 전달
      });
    }

    // O열에 현금영수증 번호가 있는 학생만 발급 명단에 올림
    if (receiptPhone && String(receiptPhone).trim() !== "") {
      receiptList.push({
        id: id, 
        name: name, 
        grade: grade, 
        baseDay: baseDay, 
        receiptPhone: String(receiptPhone).trim(),
        parentName: parentName ? String(parentName).trim() : "" // ★ 입금자명 추가 전달
      });
    }
  }

  return {
    receiptList: receiptList,
    allStudents: allActiveStudents
  };
}

// 3. 현금영수증 대상자 추가/수정/삭제
// ★ 매개변수에 parentNameStr(입금자명) 추가
function updateCashReceiptTarget(studentId, phoneStr, isDelete, parentNameStr) {
  try {
    return MutationPipeline_run_({ operation: "현금영수증정보변경" }, function(tx) {
    studentId = requireText_(studentId, "학생 ID", 100);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAMES.STUDENTS);
    var studentMatches = LookupIndex_findRows_(SHEET_NAMES.STUDENTS, COL.STUDENT.ID, studentId, false);
    if (!studentMatches.length) {
      studentMatches = LookupIndex_findRows_(SHEET_NAMES.STUDENTS, COL.STUDENT.ID, studentId, true);
    }
    if (!studentMatches.length) return "❌ 학생을 찾을 수 없습니다.";
    var targetRow = studentMatches[0].rowNumber;
    var studentRow = studentMatches[0].row;
    var histories = buildStudentChangeHistory_(EventRepository_getLegacyRowsForStudents_([studentId], false));
    var nowAsOf = new Date(); nowAsOf.setHours(23, 59, 59, 999);
    if (!isDelete && resolveStudentStateAtDate_(studentRow, histories, nowAsOf).status !== "재원") {
      throw new Error("현재 재원 중인 학생만 현금영수증 대상에 추가할 수 있습니다.");
    }
    var oldValue = String(studentRow[IDX.STUDENT.CASH_RECEIPT] || "");
    var oldParentName = String(studentRow[IDX.STUDENT.PARENT_NAME] || "");
    
    // 제외 처리일 경우 데이터를 비우고, 추가/수정일 경우 전달받은 값을 할당
    var newValue = isDelete ? "" : safeSheetText_(requireText_(phoneStr, "현금영수증 번호", 30), 30);
    var newParentName = isDelete ? "" : safeSheetText_(parentNameStr, 40);
    
    tx.writeRange(sheet, targetRow, COL.STUDENT.CASH_RECEIPT, [[newValue, newParentName]]);

    if (oldValue !== newValue || oldParentName !== newParentName) {
      tx.queueEvent({
        eventType: "현금영수증정보변경", targetType: "학생", targetId: studentId, studentId: studentId,
        field: "현금영수증", before: oldValue + "/" + oldParentName, after: newValue + "/" + newParentName
      });
    }

    tx.invalidate([SHEET_NAMES.STUDENTS, SHEET_NAMES.EVENTS]);

    return isDelete ? "🗑️ 명단에서 제외되었습니다." : "✅ 저장되었습니다.";
    });
  } catch(err) {
    return "❌ 오류 발생: " + err.toString();
  }
}
