
// ---------------------------------------------------------
// 2. [바탕화면] 경영 현황 대시보드 (최종: 매출-처리일 / 상태-귀속월 / 문구 축약)
// ---------------------------------------------------------
var HOME_DASHBOARD_DIRTY_KEY = "HOME_DASHBOARD_DIRTY";
var HOME_DASHBOARD_REFRESHED_AT_KEY = "HOME_DASHBOARD_REFRESHED_AT";

function markHomeDashboardDirty_() {
  try { PropertiesService.getScriptProperties().setProperty(HOME_DASHBOARD_DIRTY_KEY, "1"); } catch (error) { logError_("바탕화면 변경표시", error); }
}

function refreshDashboardIfNeeded_() {
  var properties = PropertiesService.getScriptProperties();
  var dirty = properties.getProperty(HOME_DASHBOARD_DIRTY_KEY) === "1";
  var last = Number(properties.getProperty(HOME_DASHBOARD_REFRESHED_AT_KEY)) || 0;
  if (!dirty && Date.now() - last < 30 * 60 * 1000) return "바탕화면 최신 상태 유지";
  return refreshDashboard();
}

function refreshDashboard() {
  requireSpreadsheetSuperAdmin_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var mainSheet = ss.getSheetByName(SHEET_NAMES.HOME);
  var listSheet = ss.getSheetByName(SHEET_NAMES.STUDENTS);
  var paySheet = ss.getSheetByName(SHEET_NAMES.PAYMENTS);

  if (!mainSheet || !listSheet || !paySheet) return;

  // 1. 기존 필터 해제 및 초기화
  try {
    var filter = mainSheet.getFilter();
    if (filter) filter.remove();
  } catch(e) { logError_("바탕화면 필터 제거", e); }

  mainSheet.clear(); 
  mainSheet.setFrozenRows(0); 

  // 2. 기준 날짜 (오늘 기준)
  var now = new Date();
  var thisYear = now.getFullYear();
  var thisMonth = now.getMonth() + 1;
  
  // 귀속월 비교용 문자열 (예: "2026-01") - 상태 확인용
  var targetYm = thisYear + "-" + (thisMonth < 10 ? "0" + thisMonth : thisMonth);

  // 3. 데이터 가져오기
  var context = DataRepository_loadContext_([
    SHEET_NAMES.STUDENTS, SHEET_NAMES.PAYMENTS, SHEET_NAMES.VACATIONS, SHEET_NAMES.LOGS
  ], { required: false });
  var students = context[SHEET_NAMES.STUDENTS] || [];
  var payments = context[SHEET_NAMES.PAYMENTS] || [];
  var histories = buildStudentChangeHistory_(context[SHEET_NAMES.LOGS] || []);
  var monthlySnapshot = MonthlySnapshot_build_(targetYm, context);
  var dashboardAsOfDate = new Date();
  dashboardAsOfDate.setHours(23, 59, 59, 999);

  // 4. 데이터 집계
  var payMap = {};      // 학생별 이번 달 수강료 납부 합계 (귀속월 기준)
  var totalRevenue = 0; // 총 매출 (★처리일 기준 - 현금주의)

  for (var i = 1; i < payments.length; i++) {
    var pProcessDate = payments[i][IDX.PAYMENT.CREATED_AT]; // 처리일
    var pStudentId = payments[i][IDX.PAYMENT.STUDENT_ID];
    var pAttrMonth = payments[i][IDX.PAYMENT.MONTH];
    var pAmount = payments[i][IDX.PAYMENT.AMOUNT];
    var pType = normalizePaymentType_(payments[i][IDX.PAYMENT.TYPE]);

    var amountVal = Number(String(pAmount).replace(/,/g, ""));
    if (isNaN(amountVal)) amountVal = 0;

    // (1) ★ 매출 집계: "처리일(B열)"이 이번 달이면 합산 (이번 달에 들어온 돈)
    var isReveneThisMonth = false;
    if (pProcessDate instanceof Date) {
      if (pProcessDate.getFullYear() === thisYear && (pProcessDate.getMonth() + 1) === thisMonth) {
        isReveneThisMonth = true;
      }
    } else {
      // 날짜가 문자로 들어온 경우 대비
      var procDate = new Date(pProcessDate);
      if (!isNaN(procDate.getTime())) {
         if (procDate.getFullYear() === thisYear && (procDate.getMonth() + 1) === thisMonth) {
            isReveneThisMonth = true;
         }
      }
    }

    if (isReveneThisMonth) {
      totalRevenue += amountVal;
    }

    // (2) 납부 상태 체크: "귀속월(F열)"이 이번 달이면 '납부함'으로 표시 (이번 달 수업료 냈는지)
    var cleanMonth = "";
    if (pAttrMonth instanceof Date) {
      var y = pAttrMonth.getFullYear();
      var m = pAttrMonth.getMonth() + 1;
      cleanMonth = y + "-" + (m < 10 ? "0" + m : m);
    } else {
      cleanMonth = String(pAttrMonth).trim().substring(0, 7);
    }

    if (cleanMonth === targetYm && isTuitionPaymentType_(pType)) {
      payMap[pStudentId] = (payMap[pStudentId] || 0) + amountVal;
    }
  }

  // 명단 리스트 구성
  var rawDataList = [];
  var activeCount = 0; 
  var unpaidCount = 0; 

  for (var i = 1; i < students.length; i++) {
    var state = resolveStudentStateAtDate_(students[i], histories, dashboardAsOfDate);
    if (state.status === "재원") {
      activeCount++;
      
      var sId = students[i][IDX.STUDENT.ID];
      var sName = students[i][IDX.STUDENT.NAME];
      var sGrade = students[i][IDX.STUDENT.GRADE];
      var sTeacher = state.teacher;
      var sFee = state.fee; 
      var snapshotStudent = monthlySnapshot.studentsById[String(sId)] || null;
      var billableFee = snapshotStudent ? snapshotStudent.billableFee : Number(sFee || 0);

      var paidAmount = Number(payMap[sId] || 0);
      var paymentState = PaymentDomain_calculateBalance(billableFee, paidAmount);
      var isPaid = paymentState.status === "완납";
      if (!isPaid) unpaidCount++;

      rawDataList.push({
        grade: sGrade, name: sName, teacher: sTeacher, fee: sFee, isPaid: isPaid, paidAmount: paidAmount, paymentStatus: paymentState.status
      });
    }
  }

  // --- 디자인 및 출력 ---
  mainSheet.getRange("B2").setValue("📅 " + thisYear + "년 " + thisMonth + "월 학원비 관리 현황")
      .setFontSize(16).setFontWeight("bold").setFontColor("#1a73e8");

  // 통계 박스
  mainSheet.getRange("B4").setValue("총 원생").setBackground("#f8f9fa").setFontWeight("bold").setHorizontalAlignment("center");
  mainSheet.getRange("C4").setValue("미납 인원").setBackground("#fce8e6").setFontWeight("bold").setHorizontalAlignment("center");
  
  var revenueHeader = mainSheet.getRange("D4:E4"); 
  revenueHeader.merge().setValue("현재 매출 (처리일 기준)").setBackground("#e6f4ea").setFontWeight("bold").setHorizontalAlignment("center");
  
  mainSheet.getRange("B5").setValue(activeCount + "명").setHorizontalAlignment("center").setFontSize(12);
  mainSheet.getRange("C5").setValue(unpaidCount + "명").setHorizontalAlignment("center").setFontSize(12).setFontWeight("bold").setFontColor("#c5221f");
  
  var revenueValue = mainSheet.getRange("D5:E5"); 
  revenueValue.merge().setValue(totalRevenue.toLocaleString() + "원").setHorizontalAlignment("center").setFontSize(12).setFontWeight("bold").setFontColor("#137333");

  mainSheet.getRange("B4:E5").setBorder(true, true, true, true, true, true, "#dadce0", SpreadsheetApp.BorderStyle.SOLID);
  
  // ★ 요청하신 문구 축약 적용
  mainSheet.getRange("B7").setValue("※ 모든 기능은 상단 [🎓학원비 관리] 메뉴에 있습니다.")
      .setFontColor("#5f6368").setFontStyle("italic").setFontSize(10);
  mainSheet.getRange("B8").setValue("※ 화면을 실수로 지우는 등의 손상 시 [🔄 바탕화면 새로고침]으로 복구 가능합니다. (데이터 안전)")
      .setFontColor("#5f6368").setFontStyle("italic").setFontSize(10);

  // 리스트 출력
  var headers = ["학년/학번", "이름", "담당 원장", "수강료", "이번달 납부"];
  mainSheet.getRange(9, 2, 1, 5).setValues([headers])
      .setBackground("#4285f4").setFontColor("white").setFontWeight("bold").setHorizontalAlignment("center");

  if (rawDataList.length > 0) {
    rawDataList.sort(function(a, b) { return a.name < b.name ? -1 : 1; });

    var displayValues = [];
    var bgColors = []; 

    for (var k = 0; k < rawDataList.length; k++) {
      var item = rawDataList[k];
      
        var statusText = item.paymentStatus;
      var statusBg = item.isPaid ? "#d9ead3" : "#f4cccc";

      var gradeBg = getGradeColor(item.grade); 
      var teacherBg = getTeacherColor(item.teacher);

      displayValues.push([item.grade, item.name, item.teacher, item.fee, statusText]);
      bgColors.push([gradeBg, "white", teacherBg, "white", statusBg]);
    }

    var dataRange = mainSheet.getRange(10, 2, displayValues.length, 5);
    dataRange.setValues(displayValues).setHorizontalAlignment("center");
    dataRange.setBackgrounds(bgColors);
    dataRange.setBorder(true, true, true, true, true, true, "#eee", SpreadsheetApp.BorderStyle.SOLID);
    mainSheet.getRange(10, 5, displayValues.length, 1).setNumberFormat("#,##0");

    var filterRange = mainSheet.getRange(9, 2, displayValues.length + 1, 5);
    filterRange.createFilter(); 

  } else {
    mainSheet.getRange(10, 2).setValue("데이터가 없습니다.");
  }

  mainSheet.setColumnWidth(1, 20); 
  mainSheet.setColumnWidth(2, 80); 
  mainSheet.setColumnWidth(3, 100);
  mainSheet.setColumnWidth(4, 100);
  mainSheet.setColumnWidth(5, 100);
  mainSheet.setColumnWidth(6, 120); 
  mainSheet.setHiddenGridlines(true);
  try {
    PropertiesService.getScriptProperties().setProperties({
      HOME_DASHBOARD_DIRTY: "0",
      HOME_DASHBOARD_REFRESHED_AT: String(Date.now())
    }, false);
  } catch (refreshStateError) { logError_("바탕화면 갱신상태 기록", refreshStateError); }
  return "바탕화면을 갱신했습니다.";
}






/**
 * 🎨 [헬퍼 함수] 학년별 배경색 반환
 */
function getGradeColor(gradeStr) {
  if (!gradeStr) return "white";
  var s = String(gradeStr);
  if (s.indexOf("고") !== -1) return "#d0e0e3"; // 고등 - 하늘색
  if (s.indexOf("중") !== -1) return "#d9ead3"; // 중등 - 초록색
  if (s.indexOf("초") !== -1) return "#f5fdad"; // 초등 - 노란색 (요청 색상)
  return "white";
}

/**
 * 🎨 [헬퍼 함수] 선생님별 배경색 반환 (알고리즘 적용)
 */
function getTeacherColor(name) {
  if (!name) return "white";
  // 이름 자체를 코드에 저장하지 않고 문자열 해시로 고정 색상을 정합니다.
  return stringToPastelColor(name);
}

/**
 * 🎲 이름을 넣으면 항상 같은 파스텔톤 색상을 뱉어주는 마법의 함수
 */
function stringToPastelColor(str) {
  var hash = 0;
  for (var i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  // 파스텔톤 팔레트 (눈이 편안한 색상들)
  var palette = [
    "#e1d5e7", // 연한 보라
    "#fff2cc", // 연한 노랑
    "#f8cecc", // 연한 분홍
    "#dae8fc", // 아주 연한 파랑
    "#d5e8d4", // 아주 연한 초록
    "#ffe6cc"  // 살구색
  ];
  
  // 이름의 해시값을 팔레트 개수로 나눈 나머지 -> 인덱스 결정
  var index = Math.abs(hash) % palette.length;
  return palette[index];
}
