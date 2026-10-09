/**
 * 🖨️ [HTML 버전] 납부 체크리스트 팝업 열기
 */
function openPaymentChecklistModal() {
  requireSpreadsheetSuperAdmin_();
  var html = HtmlService.createTemplateFromFile('PaymentChecklist').evaluate()
      .setWidth(1000) // 가로로 넓게
      .setHeight(800);
  SpreadsheetApp.getUi().showModalDialog(html, '🖨️ 월별 납부 체크리스트 출력');
}



/**
 * 📡 [데이터 처리] 납부 체크리스트용 데이터 조회 (납부방식 G열 추가)
 */
function getPaymentChecklistData(targetYm) {
  var startedAt = Date.now();
  requireSuperAdmin_();
  targetYm = requireMonthString_(targetYm, "조회 월");
  var dependencies = [
    SHEET_NAMES.STUDENTS, SHEET_NAMES.VACATIONS, SHEET_NAMES.PAYMENTS,
    SHEET_NAMES.LOGS, SHEET_NAMES.EVENTS
  ];
  var initialSignature = QueryResultCache_signature_("PAY_CHECKLIST", targetYm, dependencies);
  var cachedResult = QueryResultCache_get_(initialSignature);
  if (cachedResult) {
    console.log("[납부 체크리스트 조회 성능] " + JSON.stringify({ targetYm: targetYm, cacheHit: true, totalMs: Date.now() - startedAt }));
    return cachedResult;
  }
  var context = DataRepository_loadContext_([
    SHEET_NAMES.STUDENTS, SHEET_NAMES.VACATIONS, SHEET_NAMES.PAYMENTS, SHEET_NAMES.LOGS
  ], { required: false });
  var signatureAfterLoad = QueryResultCache_signature_("PAY_CHECKLIST", targetYm, dependencies);
  var monthlySnapshot = MonthlySnapshot_build_(targetYm, context);
  
  // 날짜 계산 (월말 계산)
  var year = parseInt(targetYm.split("-")[0]);
  var month = parseInt(targetYm.split("-")[1]);
  var monthStart = new Date(year, month - 1, 1);
  var monthEnd = new Date(year, month, 0); // 해당 월의 마지막 날

  var students = monthlySnapshot.studentRows;

  // -------------------------------------------------------------
  // ★ [수정됨] 납부 내역 매핑 (DB_수납 구조 정확 반영)
  // D열(3): 학생ID, F열(5): 귀속월, I열(8): 납부금액, C열(2): 수납일, ★ G열(6): 납부방식
  // -------------------------------------------------------------
  var payMap = MonthlySnapshot_buildPaymentSummary_(monthlySnapshot, targetYm);

  var groupedData = {};

  // 학생 명단 순회
  for (var i = 1; i < students.length; i++) {
    var row = students[i];
    var sId = String(row[IDX.STUDENT.ID]);
    var monthlyStudent = monthlySnapshot.studentsById[sId];
    if (!monthlyStudent || monthlyStudent.excludedByEarlyExit) continue;
    // 특강 전용 학생은 정규 월 수강료 납부 체크 대상이 아닙니다.
    if (monthlyStudent.specialOnly) continue;
    var state = monthlyStudent.state;
    var sName = row[IDX.STUDENT.NAME];
    var sGrade = row[IDX.STUDENT.GRADE];
    var sStatus = state.status;
    var sTeacher = state.teacher;
    var sFee = monthlyStudent.baseFee;

    // 1. 재원 기간 필터링
    var fDate = monthlyStudent.firstDate;
    var eDate = monthlyStudent.exitDate;
    if (!fDate) continue;

    // 입학일이 조회 월보다 미래면 제외
    if (fDate > monthEnd) continue; 
    
    // 퇴원생인 경우 필터링
    if (sStatus === "퇴원") {
      if (!eDate) continue; 
      if (eDate < monthStart) continue; // 기존: 지난달 이전 퇴원자 제외
    }
    
    
    // 2. 휴원 여부 체크
    var vacationNote = "";
    var isVacation = false;
    monthlyStudent.vacations.forEach(function(vacation) {
      var vStart = vacation.start;
      var vEnd = vacation.end;
      if (vStart <= monthEnd && vEnd >= monthStart) {
        isVacation = true;
        var vs = (vStart < monthStart) ? "전월" : (vStart.getMonth()+1)+"/"+vStart.getDate();
        var ve = (vEnd > monthEnd) ? "익월" : (vEnd.getMonth()+1)+"/"+vEnd.getDate();
        vacationNote = "휴원(" + vs + "~" + ve + ")";
      }
    });

    // 3. 납부 정보 매칭 (위에서 만든 payMap 사용)
    var payInfo = payMap[sId];
    var payDateDisplay = "";
    var payAmountDisplay = "";
    var payMethodDisplay = ""; // ★ 납부 방식 텍스트
    
    if (payInfo) {
      payDateDisplay = payInfo.dates.join(", ");
      payAmountDisplay = payInfo.total.toLocaleString();
      payMethodDisplay = payInfo.methods.join(", "); // ★ 배열에 쌓인 수단들을 콤마로 연결
    }

    // 4. 데이터 그룹화 (선생님별)
    if (!groupedData[sTeacher]) groupedData[sTeacher] = [];
    groupedData[sTeacher].push({
      studentId: sId,
      grade: sGrade,
      name: sName,
      fee: sFee ? Number(sFee).toLocaleString() : "0",
      note: vacationNote,
      isVacation: isVacation,
      paidDate: payDateDisplay,     
      paidAmount: payAmountDisplay, 
      payMethod: payMethodDisplay   // ★ HTML쪽의 s.payMethod 로 전달됨!
    });
  }

  var finalSignature = QueryResultCache_signature_("PAY_CHECKLIST", targetYm, dependencies);
  if (finalSignature === signatureAfterLoad) QueryResultCache_put_(finalSignature, groupedData, 600);
  console.log("[납부 체크리스트 조회 성능] " + JSON.stringify({
    targetYm: targetYm, cacheHit: false,
    cacheStored: finalSignature === signatureAfterLoad,
    monthlySnapshotStatus:monthlySnapshot.persistentSnapshotStatus || "unknown",
    totalMs: Date.now() - startedAt
  }));
  return groupedData;
}
