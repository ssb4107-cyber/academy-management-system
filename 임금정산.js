/**
 * 🖥️ [실행용] 강사료 정산 대시보드 열기
 * -> 이 함수를 실행하거나 버튼에 연결하세요!
 */
function showSalaryDashboard() {
  requireSpreadsheetSuperAdmin_();
  var html = HtmlService.createTemplateFromFile('SalaryDashboard').evaluate()
      .setWidth(1200) // 창 가로 크기
      .setHeight(900) // 창 세로 크기
      .setSandboxMode(HtmlService.SandboxMode.IFRAME);
  
  SpreadsheetApp.getUi().showModalDialog(html, '💰 급여 관리');
}

var SALARY_RESULT_CACHE_MAX_CHUNKS = 20;
var SALARY_RESULT_CACHE_TTL_SECONDS = 600;
var SalaryResultCache_lastReadStatus_ = "not_checked";
var SalaryResultCache_lastWriteStatus_ = "not_attempted";

/** 급여 계산에 영향을 주는 모든 원본의 세대번호로 월별 결과 캐시를 구분합니다. */
function SalaryResultCache_signature_(targetYm) {
  var dependencies = [
    SHEET_NAMES.STUDENTS, SHEET_NAMES.PAYMENTS, SHEET_NAMES.VACATIONS,
    SHEET_NAMES.LOGS, SHEET_NAMES.EVENTS, SHEET_NAMES.TEACHERS,
    SHEET_NAMES.SALARY_SETTLEMENTS, SHEET_NAMES.SALARY_ENTRIES, SHEET_NAMES.USERS, SHEET_NAMES.SETTINGS
  ];
  return QueryResultCache_signature_("SALARY_V4_SETTINGS_OWNERSHIP", targetYm, dependencies);
}

function SalaryResultCache_get_(signature) {
  var read = QueryResultCache_read_(signature, { maxChunks: SALARY_RESULT_CACHE_MAX_CHUNKS });
  SalaryResultCache_lastReadStatus_ = read.status;
  return read.value;
}

function SalaryResultCache_put_(signature, results) {
  var write = QueryResultCache_write_(signature, results || [], SALARY_RESULT_CACHE_TTL_SECONDS,
    { maxChunks: SALARY_RESULT_CACHE_MAX_CHUNKS });
  SalaryResultCache_lastWriteStatus_ = write.status;
  return write.stored;
}

/**
 * 📋 [목록] 급여 정산 대상 원장 명단
 * 비활성 원장도 과거 월 필터에서 선택할 수 있도록 급여 대상 여부만 적용합니다.
 */
function getTeacherList() {
  requireSuperAdmin_();
  return TeacherDirectory_list_({ salaryOnly: true }).map(function(item) { return item.name; });
}

function Salary_allocateReceivedRevenue_(receivedAmount, teacherActiveDays, studentActiveDays) {
  if (Number(studentActiveDays) <= 0 || Number(teacherActiveDays) <= 0) return 0;
  return prorateMoney_(receivedAmount, teacherActiveDays, studentActiveDays);
}

/** 기존 시트의 0.6, 60, "60%" 형식을 모두 0.6으로 통일합니다. */
function Salary_normalizeRate_(value) {
  var text = String(value == null ? "" : value).trim();
  if (!text) throw new Error("배분율이 비어 있습니다.");
  var hasPercent = /%$/.test(text);
  var number = Number(text.replace("%", ""));
  if (!isFinite(number) || number < 0) throw new Error("배분율 형식이 올바르지 않습니다: " + text);
  if (hasPercent || number > 1) number = number / 100;
  if (number > 1) throw new Error("배분율은 100%를 초과할 수 없습니다: " + text);
  return number;
}

/** 정산월 바로 다음 달에 퇴원 예정인지 판정합니다. */
function Salary_isLeavingNextMonth_(exitDate, targetYm) {
  var parsedExitDate = parseDateOnly_(exitDate);
  var match = String(targetYm || "").trim().match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (!parsedExitDate || !match) return false;
  parsedExitDate.setHours(0, 0, 0, 0);
  var year = Number(match[1]);
  var month = Number(match[2]);
  var nextMonthStart = new Date(year, month, 1);
  var nextMonthEnd = new Date(year, month + 1, 0);
  return parsedExitDate >= nextMonthStart && parsedExitDate <= nextMonthEnd;
}

function Salary_resolveTuitionRevenue_(theoreticalRevenue, receivedAmount, hasTuitionPayment, specialOnly, teacherActiveDays, studentActiveDays) {
  if (hasTuitionPayment) {
    return { amount: Salary_allocateReceivedRevenue_(receivedAmount, teacherActiveDays, studentActiveDays), basis: "실수납" };
  }
  if (specialOnly) return { amount: 0, basis: "특강비만" };
  return { amount: theoreticalRevenue, basis: "규정금액" };
}

function Salary_applyDirectReceiptExclusions_(calculated, excludedStudentIds) {
  calculated = calculated || { list: [], summary: {} };
  var excludedMap = {};
  (excludedStudentIds || []).forEach(function(id) {
    id = String(id);
    if (excludedMap[id]) throw new Error("직접수령 제외 학생이 중복 선택되었습니다: " + id);
    excludedMap[id] = true;
  });
  var excluded = [];
  var included = (calculated.list || []).filter(function(item) {
    if (excludedMap[String(item.studentId || "")]) { excluded.push(item); return false; }
    return true;
  });
  if (excluded.length !== Object.keys(excludedMap).length) throw new Error("직접수령 제외 대상 중 현재 정산에서 찾을 수 없는 학생이 있습니다. 다시 조회해주세요.");
  var totalRevenue = included.reduce(function(total, item) { return total + (Number(item.totalRowRevenue) || 0); }, 0);
  var teacherShare = included.reduce(function(total, item) { return total + (Number(item.calculatedShare) || 0); }, 0);
  var tax = truncateMoney_(teacherShare * 0.033);
  return {
    data: {
      list: included,
      summary: {
        totalRevenue: totalRevenue, teacherShare: teacherShare, tax: tax, finalPay: teacherShare - tax,
        actualReceivedCount: included.filter(function(item) { return item.calculationBasis === "실수납"; }).length,
        theoreticalCount: included.filter(function(item) { return item.calculationBasis === "규정금액"; }).length,
        specialOnlyCount: included.filter(function(item) { return item.calculationBasis === "특강비만"; }).length,
        directReceiptExcludedCount: excluded.length
      }
    },
    excluded: excluded
  };
}

/**
 * 🚀 [일괄 조회] 모든 원장님 급여 계산 (인쇄용)
 */
function calculateAllSalaries(targetYm) {
  requireSuperAdmin_();
  return Salary_calculateAllSalaries_(targetYm);
}

/** 권한 검사가 끝난 동일 서버 실행 안에서 사용하는 급여 전체 계산 본체입니다. */
function Salary_calculateAllSalaries_(targetYm, options) {
  options = options || {};
  var startedAt = Date.now();
  targetYm = requireMonthString_(targetYm, "정산 월");
  var initialCacheSignature = SalaryResultCache_signature_(targetYm);
  var cachedResults = SalaryResultCache_get_(initialCacheSignature);
  if (cachedResults) {
    console.log("[급여 전체 조회 성능] " + JSON.stringify({
      targetYm: targetYm,
      cacheHit: true,
      cacheReadStatus: SalaryResultCache_lastReadStatus_,
      cacheWriteStatus: "not_needed",
      students: 0,
      teachers: cachedResults.length,
      loadMs: 0,
      referenceMs: 0,
      calculationMs: 0,
      totalMs: Date.now() - startedAt
    }));
    return cachedResults;
  }
  var db = Salary_loadAllData_(targetYm);
  var loadedAt = Date.now();
  var candidates = db.monthlySnapshot ? db.monthlySnapshot.teachersInMonth.slice() : getTeacherList();
  // 급여 화면에서 이미 읽은 원장 목록을 재사용합니다. 원장 목록을 이름 조회와 ID 조회로
  // 두 번 더 읽던 구조는 CacheService가 miss일 때 불필요한 시트 왕복을 만들었습니다.
  var salaryDirectory = Array.isArray(options.salaryDirectory)
    ? options.salaryDirectory
    : TeacherDirectory_list_({ salaryOnly: true });
  var allowedTeacherNames = {};
  var teacherIdByName = {};
  salaryDirectory.forEach(function(item) {
    var name = String(item && item.name || "").trim();
    if (!name) return;
    allowedTeacherNames[name] = true;
    teacherIdByName[name] = String(item.id || "").trim();
  });
  var teachers = candidates.filter(function(name) {
    name = String(name || "").trim();
    // 기존 명단이 아직 생성되지 않은 설치 환경의 호환 동작은 유지합니다.
    return name && (salaryDirectory.length ? !!allowedTeacherNames[name] : true);
  });
  var settlementMap = SalaryManagement_getSettlementMapForMonth_(targetYm);
  var referencesLoadedAt = Date.now();
  // 최초 원본 캐시 생성에 따른 세대 변경은 계산 기준에 포함합니다.
  var cacheSignatureAfterLoad = SalaryResultCache_signature_(targetYm);
  var results = [];

  teachers.sort(); // 가나다순 정렬

  teachers.forEach(function(teacher) {
    var teacherId = teacherIdByName[teacher] || "";
    var data = Salary_processCalculation_(db, targetYm, teacher, teacherId);
    var settlement = settlementMap[teacherId] || settlementMap["NAME:" + teacher] || null;
    if (settlement && settlement.snapshotData) data = settlement.snapshotData;
    else if (settlement) {
      // 확정 기록에 스냅샷이 없으면 현재 학생 데이터로 상세 내역을 꾸며내지 않습니다.
      data = {
        list: [], adjustments: [],
        summary: { totalRevenue: 0, teacherShare: 0, tax: 0, finalPay: settlement.baseAmount || 0 },
        summaryOnly: settlement.sourceType === "과거수동",
        snapshotMissing: settlement.sourceType !== "과거수동"
      };
    }
    // 데이터가 있는 원장님만 결과에 포함
    if (data.list.length > 0 || settlement) {
      results.push({ teacher: teacher, teacherId: teacherId || (settlement && settlement.teacherId) || "", data: data, settlement: settlement });
    }
  });

  var finalCacheSignature = SalaryResultCache_signature_(targetYm);
  if (finalCacheSignature === cacheSignatureAfterLoad) {
    SalaryResultCache_put_(finalCacheSignature, results);
    if (SalaryResultCache_lastWriteStatus_.indexOf("stored_") === 0 && initialCacheSignature !== finalCacheSignature) {
      SalaryResultCache_lastWriteStatus_ += "_after_source_refresh";
    }
  } else {
    SalaryResultCache_lastWriteStatus_ = "generation_changed_after_load";
  }

  console.log("[급여 전체 조회 성능] " + JSON.stringify({
    targetYm: targetYm,
    cacheHit: false,
    cacheReadStatus: SalaryResultCache_lastReadStatus_,
    cacheWriteStatus: SalaryResultCache_lastWriteStatus_,
    monthlySnapshotStatus:db.monthlySnapshot && db.monthlySnapshot.persistentSnapshotStatus || "unknown",
    students: Math.max(0, (db.sheet || []).length - 1),
    teachers: teachers.length,
    loadMs: loadedAt - startedAt,
    referenceMs: referencesLoadedAt - loadedAt,
    calculationMs: Date.now() - referencesLoadedAt,
    totalMs: Date.now() - startedAt
  }));
  return results;
}

/** 급여 화면 최초 진입에 필요한 권한·원장 목록·정산 결과를 한 번에 반환합니다. */
function getSalaryDashboardInitialData(targetYm) {
  var startedAt = Date.now();
  var user = requireSuperAdmin_();
  var profile = {
    email: user.email,
    name: user.name || user.email,
    role: user.role,
    isSuperAdmin: user.bootstrap || user.role === ACCESS_CONTROL.ROLES.SUPER_ADMIN
  };
  var salaryDirectory = TeacherDirectory_list_({ salaryOnly: true });
  var teachers = salaryDirectory.map(function(item) { return item.name; });
  var referencesLoadedAt = Date.now();
  var results = Salary_calculateAllSalaries_(targetYm, { salaryDirectory: salaryDirectory });
  console.log("[급여 화면 최초 로딩 성능] " + JSON.stringify({
    targetYm: targetYm,
    profileAndTeachersMs: referencesLoadedAt - startedAt,
    salaryDataMs: Date.now() - referencesLoadedAt,
    totalMs: Date.now() - startedAt
  }));
  return { profile: profile, teachers: teachers, results: results };
}

// =================================================================
// ⚙️ [내부 함수] 데이터 로딩 및 계산 로직 분리 (중복 제거)
// =================================================================

function loadAllData(targetYm, options) {
  requireSuperAdmin_();
  return Salary_loadAllData_(targetYm, options);
}

/** 권한 검사가 끝난 급여 처리 내부에서 사용하는 월 데이터 로더입니다. */
function Salary_loadAllData_(targetYm, options) {
  options = options || {};
  var context = DataRepository_loadContext_([
    SHEET_NAMES.STUDENTS, SHEET_NAMES.VACATIONS, SHEET_NAMES.LOGS, SHEET_NAMES.PAYMENTS
  ], { required: false, fresh: !!options.fresh, cache: options.cache !== false });
  var monthlySnapshot = MonthlySnapshot_build_(targetYm, context);
  return {
    sheet: context[SHEET_NAMES.STUDENTS] || [],
    monthlySnapshot: monthlySnapshot
  };
}

function processSalaryCalculation(db, targetYm, teacherName, teacherId) {
  requireSuperAdmin_();
  return Salary_processCalculation_(db, targetYm, teacherName, teacherId);
}

/** 권한 검사가 끝난 급여 조회·확정 흐름에서 반복 호출하는 계산 본체입니다. */
function Salary_processCalculation_(db, targetYm, teacherName, teacherId) {
  var data = db.sheet;
  var monthlySnapshot = db.monthlySnapshot;
  if (!monthlySnapshot) throw new Error("월별 정산 스냅샷이 없습니다.");
  var stateHistories = monthlySnapshot.histories;
  var salaryAsOfDate = monthlySnapshot.asOfDate;

  var [year, month] = targetYm.split("-").map(Number); 
  var lastDayOfDate = new Date(year, month, 0).getDate(); 
  var monthDays = DateMoney_billingDays(year, month);
  var monthStart = new Date(year, month - 1, 1);
  var monthEnd = new Date(year, month - 1, lastDayOfDate); 
  monthStart.setHours(0,0,0,0);
  monthEnd.setHours(0,0,0,0);

  var vacMap = monthlySnapshot.vacationsByStudent;
  var specialPayMap = monthlySnapshot.specialPaymentsByStudent;
  var receivedTuitionMap = monthlySnapshot.tuitionReceivedAmountByStudent;
  var teacherHistoryMap = monthlySnapshot.teacherChangesByStudent;

  var resultList = [];
  var totalRevenue = 0;   
  var teacherShare = 0;   

  // 4. 명단 스캔
  for (var i = 1; i < data.length; i++) {
    var sName = String(data[i][IDX.STUDENT.NAME]).trim();
    var sId = String(data[i][IDX.STUDENT.ID]).trim();
    var sGrade = data[i][IDX.STUDENT.GRADE];       
    var snapshotStudent = monthlySnapshot ? monthlySnapshot.studentsById[sId] : null;
    if (snapshotStudent && snapshotStudent.excludedByEarlyExit) continue;
    var salaryState = snapshotStudent ? snapshotStudent.state : resolveStudentStateAtDate_(data[i], stateHistories, salaryAsOfDate);
    var sStatus = salaryState.status;
    var sFirstDate = snapshotStudent ? snapshotStudent.firstDate : data[i][IDX.STUDENT.FIRST_DATE];
    var sExitDate = snapshotStudent ? snapshotStudent.exitDate : data[i][IDX.STUDENT.EXIT_DATE];
    var sRate;
    try {
      sRate = Salary_normalizeRate_(data[i][IDX.STUDENT.RATE]);
    } catch (rateError) {
      throw new Error(sName + " 학생의 " + rateError.message);
    }
    var currentFee = snapshotStudent ? snapshotStudent.baseFee : salaryState.fee;
    var specialOnlyStudent = snapshotStudent
      ? !!snapshotStudent.specialOnly
      : isSpecialOnlyCourseMode_(salaryState.courseMode);
    var siblingDiscount = snapshotStudent ? snapshotStudent.siblingDiscount : (Number(data[i][IDX.STUDENT.FAMILY_DISCOUNT]) || 0);

    // =========================================================
    // ★ [완결판] 선생님 담당 기간(타임라인) 조각내기
    // =========================================================
    var ownerships = snapshotStudent
      ? snapshotStudent.teacherOwnerships
      : MonthlySnapshot_buildTeacherOwnerships_(data[i], stateHistories, monthlySnapshot.teacherIdByName || {});

    // 우리가 지금 조회하고 있는 대상 원장님의 담당 기간만 필터링
    var targetTeacher = String(teacherName).trim();
    var targetTeacherId = String(teacherId || "").trim();
    var myOwnerships = ownerships.filter(function(o) {
      return targetTeacherId ? String(o.teacherId || "") === targetTeacherId : o.teacher === targetTeacher;
    });

    if (myOwnerships.length === 0) continue; // 이 학생을 한 번도 맡은 적이 없는 원장님은 스킵
    // =========================================================

    // 수강료 과거 시점 추적
    var appliedFee = currentFee;
    var feeDiff = 0;
    var feeEvents = ((stateHistories[sId] || {}).fee || []).filter(function(event) {
      return event.effectiveDate >= monthStart && event.effectiveDate <= monthEnd;
    }).sort(function(a, b) {
      return (a.effectiveDate - b.effectiveDate) || (a.createdAt - b.createdAt) || (a.rowOrder - b.rowOrder);
    });
    if (feeEvents.length) {
      var beforeMonth = new Date(monthStart); beforeMonth.setDate(beforeMonth.getDate() - 1);
      var feeBeforeMonth = resolveStudentStateAtDate_(data[i], stateHistories, beforeMonth).fee;
      feeDiff = Number(feeEvents[feeEvents.length - 1].after) - feeBeforeMonth;
    }
    appliedFee = PaymentDomain_adjustMonthlyFee(appliedFee, siblingDiscount, 0);
    if (specialOnlyStudent) appliedFee = 0;

    var startObj = parseDateOnly_(sFirstDate);
    var endObj = parseDateOnly_(sExitDate);

    if (!startObj) continue;
    startObj.setHours(0,0,0,0);
    if (endObj) endObj.setHours(0,0,0,0);

    // =========================================================
    // ★ [실무 보정] 1~3일 지연 퇴원 처리자는 당월 정산에서 아예 제외
    // =========================================================
    if (sStatus === "퇴원" && endObj && !isNaN(endObj.getTime())) {
      // 퇴원일이 조회하는 달의 1일~3일 사이인지 확인
      if (endObj.getFullYear() === year && endObj.getMonth() === (month - 1) && endObj.getDate() <= 3) {
        // 단, 이번 달에 입학한 신입생이 아니라 이전부터 다니던 학생인 경우에만 제외 (전월 말일 퇴원 간주)
        if (startObj < monthStart) {
          continue; 
        }
      }
    }
    // =========================================================

    var isNewStudent = (startObj > monthStart);
    var isLeavingNextMonth = Salary_isLeavingNextMonth_(endObj, targetYm);
    var baseCalcStart = (startObj > monthStart) ? startObj : monthStart;
    var baseCalcEnd = monthEnd;
    if (endObj && !isNaN(endObj.getTime()) && endObj < monthEnd) baseCalcEnd = endObj;

    if (baseCalcStart > baseCalcEnd) continue;

    // 실제 수납액을 담당자별로 나눌 때 사용할 학생 전체 유효 수업일입니다.
    // 담당자가 월중 변경돼도 같은 수납액이 각 담당자에게 전액 중복되지 않게 합니다.
    var totalStudentActiveDays = inclusiveCalendarDays_(baseCalcStart, baseCalcEnd);
    var totalVacationDates = {};
    (vacMap[sId] || []).forEach(function(vacation) {
      var overlapStart = vacation.start > baseCalcStart ? vacation.start : baseCalcStart;
      var overlapEnd = vacation.end < baseCalcEnd ? vacation.end : baseCalcEnd;
      for (var totalDay = new Date(overlapStart); totalDay <= overlapEnd; totalDay.setDate(totalDay.getDate() + 1)) {
        totalVacationDates[totalDay.getTime()] = true;
      }
    });
    totalStudentActiveDays -= Object.keys(totalVacationDates).length;
    if (month === 2 && baseCalcEnd.getDate() === lastDayOfDate &&
        !totalVacationDates[baseCalcEnd.getTime()]) {
      totalStudentActiveDays += (30 - lastDayOfDate);
    }
    if (totalStudentActiveDays < 0) totalStudentActiveDays = 0;

    // =========================================================
    // ★ [교집합 계산] 학생의 해당 월 유효 기간과 원장님의 담당 기간 겹치는 부분 추출
    // =========================================================
    var validPeriods = [];
    myOwnerships.forEach(function(o) {
      var rStart = (baseCalcStart > o.start) ? baseCalcStart : o.start;
      var rEnd = (baseCalcEnd < o.end) ? baseCalcEnd : o.end;
      if (rStart <= rEnd) {
        validPeriods.push({start: rStart, end: rEnd});
      }
    });

    if (validPeriods.length === 0) continue; // 이번 달에는 이 원장님이 단 하루도 담당하지 않음

    var activeDays = 0;
    var vacationDetails = [];
    var vacationSet = new Set(); 
    var specialRevenue = 0;
    var specialClassRevenue = 0;
    var specialItems = [];
    var otherRevenueItems = [];
    var calcStartDisplay = validPeriods[0].start; 
    var calcEndDisplay = validPeriods[validPeriods.length - 1].end; 

    // 추출된 조각 기간(들)에 대해서만 일수 및 휴가 차감 계산
    validPeriods.forEach(function(p) {
      var pStart = p.start;
      var pEnd = p.end;
      if (pStart < calcStartDisplay) calcStartDisplay = pStart;
      if (pEnd > calcEndDisplay) calcEndDisplay = pEnd;

      activeDays += inclusiveCalendarDays_(pStart, pEnd);

      // 해당 기간 내의 특수 매출(교재비 등) 배분
      if (specialPayMap[sId]) {
        specialPayMap[sId].forEach(function(sp) {
          if (sp.date >= pStart && sp.date <= pEnd) {
            specialRevenue += sp.amount;
            if (sp.type === "특강비") {
              specialClassRevenue += sp.amount;
              specialItems.push(sp.type + " " + Number(sp.amount).toLocaleString() + "원");
            } else {
              otherRevenueItems.push(sp.type + " " + Number(sp.amount).toLocaleString() + "원");
            }
          }
        });
      }

      // 해당 기간 내의 휴가 차감
      if (vacMap[sId]) {
         var vacations = vacMap[sId];
         vacations.forEach(function(v) {
            var vOverlapStart = (v.start > pStart) ? v.start : pStart;
            var vOverlapEnd = (v.end < pEnd) ? v.end : pEnd;
            if (vOverlapStart.getTime() <= vOverlapEnd.getTime()) {
               var detailStr = Utilities.formatDate(vOverlapStart, Session.getScriptTimeZone(), "MM.dd") + "~" + 
                               Utilities.formatDate(vOverlapEnd, Session.getScriptTimeZone(), "MM.dd");
               if (vacationDetails.indexOf(detailStr) === -1) vacationDetails.push(detailStr);
               for (var d = new Date(vOverlapStart); d <= vOverlapEnd; d.setDate(d.getDate() + 1)) {
                   vacationSet.add(d.getTime());
               }
            }
         });
      }
    });

    var vacationDeduced = vacationSet.size;
    activeDays -= vacationDeduced;

    // 2월 말일 보정은 계산 종료일이 실제 휴가·퇴원공백에 포함되지 않을 때만 적용합니다.
    if (month === 2) {
       // 1. 월말까지 정상적으로 재원한 경우 (+2일)
       if (calcEndDisplay.getDate() === lastDayOfDate && !vacationSet.has(calcEndDisplay.getTime())) {
          activeDays += (30 - lastDayOfDate);
       }
       // 2. 도중에 학원을 '퇴원'한 경우, 마지막 담당 원장님에게만 (+2일)
       // (단, 같은 학원 내에서 다른 원장님께 반 이동으로 넘겨준 중간 기간은 제외)
       else if (sStatus === "퇴원" && endObj && calcEndDisplay.getTime() === endObj.getTime() &&
               !vacationSet.has(calcEndDisplay.getTime())) {
          activeDays += (30 - lastDayOfDate);
       }
    }
    if (activeDays < 0) activeDays = 0;

    if (activeDays > 0 || specialRevenue > 0) {
      // ★ [신규] 이론상 금액 계산 vs 실제 수납액 적용
      var theoreticalRevenue = prorateMoney_(appliedFee, activeDays, monthDays);
      var revenueResolution = Salary_resolveTuitionRevenue_(
        theoreticalRevenue, receivedTuitionMap[sId], Object.prototype.hasOwnProperty.call(receivedTuitionMap, sId),
        specialOnlyStudent, activeDays, totalStudentActiveDays
      );
      var revenue = revenueResolution.amount;
      var isActualReceivedOverride = revenueResolution.basis === "실수납" && revenue !== theoreticalRevenue;

      if (specialOnlyStudent && specialRevenue <= 0) continue;
      var totalItemRevenue = revenue + specialRevenue;
      var calculated = roundMoney_(totalItemRevenue * sRate);
      
      totalRevenue += totalItemRevenue;
      teacherShare += calculated;

      var dateRangeStr = Utilities.formatDate(calcStartDisplay, Session.getScriptTimeZone(), "MM.dd") + "~" + Utilities.formatDate(calcEndDisplay, Session.getScriptTimeZone(), "MM.dd");
      var exitDateStr = (endObj && !isNaN(endObj.getTime())) ? Utilities.formatDate(endObj, Session.getScriptTimeZone(), "yyyy.MM.dd") : "-";

      var noteList = [];
      if (vacationDetails.length > 0) noteList.push("🏖️ " + vacationDetails.join(", "));
      if (specialOnlyStudent && specialClassRevenue > 0) {
        noteList.push("🎁 특강전용 학생 · 특강매출 " + Number(specialClassRevenue).toLocaleString() + "원");
      } else if (specialItems.length > 0) {
        noteList.push("🎁 " + specialItems.join(", "));
      }
      if (otherRevenueItems.length > 0) noteList.push("➕ 기타매출 · " + otherRevenueItems.join(", "));
      if (specialOnlyStudent && specialRevenue > 0 && specialClassRevenue <= 0) noteList.push("🎁 특강전용 학생");
      if (isActualReceivedOverride) noteList.push("💡 [실수납] 받은 금액 적용");

      // =========================================================
      // ★ [추가] 반이동(강사 변경) 내역을 찾아 비고란에 상세히 표기
      // =========================================================
      if (teacherHistoryMap[sId]) {
        var transferDetails = [];
        teacherHistoryMap[sId].forEach(function(th) {
          // 조회하는 달(이번 달) 안에서 변경된 기록만 찾기
          if (th.date >= monthStart && th.date <= monthEnd) {
            var formattedDate = Utilities.formatDate(th.date, Session.getScriptTimeZone(), "MM.dd");
            
            // "A원장->B원장 이동(02.10)" 형태로 문자열 생성
            var detailStr = th.oldTeacher + "원장->" + th.newTeacher + "원장 이동(" + formattedDate + ")";
            
            // 중복 추가 방지
            if (transferDetails.indexOf(detailStr) === -1) {
              transferDetails.push(detailStr);
            }
          }
        });
        
        // 반이동 기록이 있다면 비고란에 텍스트 추가
        if (transferDetails.length > 0) {
          noteList.push("🔄 " + transferDetails.join(", "));
        }
      }
      // =========================================================

      resultList.push({
        studentId: sId,
        name: sName,
        grade: sGrade,
        status: sStatus, 
        fee: appliedFee, 
        feeDiff: feeDiff, 
        rate: sRate,
        monthDays: monthDays,
        activeDays: activeDays, 
        vacationDays: vacationDeduced,
        vacationDetails: noteList.join("\n"), 
        dateRange: dateRangeStr,
        exitDate: exitDateStr,
        calculatedShare: calculated,
        proratedRevenue: revenue,
        specialRevenue: specialRevenue, 
        totalRowRevenue: totalItemRevenue, 
        isNew: isNewStudent,
        isLeavingNextMonth: isLeavingNextMonth,
        specialOnly: specialOnlyStudent,
        calculationBasis: revenueResolution.basis
      });
    }
  }

  var tax = truncateMoney_(teacherShare * 0.033); 
  var finalPay = teacherShare - tax;

  return {
    list: resultList,
    summary: {
      totalRevenue: totalRevenue, teacherShare: teacherShare, tax: tax, finalPay: finalPay,
      actualReceivedCount: resultList.filter(function(item) { return item.calculationBasis === "실수납"; }).length,
      theoreticalCount: resultList.filter(function(item) { return item.calculationBasis === "규정금액"; }).length,
      specialOnlyCount: resultList.filter(function(item) { return item.calculationBasis === "특강비만"; }).length
    }
  };
}
