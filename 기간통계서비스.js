/** 기간별 경영·수납 통계 화면 */
function openStatisticsDashboard() {
  requireSpreadsheetSuperAdmin_();
  var html = HtmlService.createTemplateFromFile("StatisticsDashboard").evaluate()
    .setWidth(1500)
    .setHeight(900);
  SpreadsheetApp.getUi().showModalDialog(html, "기간별 통계");
}

var STATISTICS_RESULT_CACHE_MAX_CHUNKS = 50;
var STATISTICS_RESULT_CACHE_TTL_SECONDS = 600;
var StatisticsResultCache_lastReadStatus_ = "not_checked";
var StatisticsResultCache_lastWriteStatus_ = "not_attempted";

function StatisticsResultCache_signature_(startYm, endYm, revenueBasis) {
  var dependencies = [
    SHEET_NAMES.STUDENTS, SHEET_NAMES.PAYMENTS, SHEET_NAMES.VACATIONS,
    SHEET_NAMES.LOGS, SHEET_NAMES.EVENTS, SHEET_NAMES.SETTINGS,
    SHEET_NAMES.SALARY_SETTLEMENTS, SHEET_NAMES.SALARY_ENTRIES
  ];
  var months = Statistics_monthRange_(startYm, endYm);
  return QueryResultCache_signatureForMonths_("STATISTICS_V3_MONTH_VERSION", [startYm, endYm, revenueBasis].join("_"), months, dependencies);
}

function StatisticsResultCache_get_(signature) {
  var read = QueryResultCache_read_(signature, { maxChunks: STATISTICS_RESULT_CACHE_MAX_CHUNKS });
  StatisticsResultCache_lastReadStatus_ = read.status;
  return read.value;
}

function StatisticsResultCache_put_(signature, result) {
  var write = QueryResultCache_write_(signature, result, STATISTICS_RESULT_CACHE_TTL_SECONDS,
    { maxChunks: STATISTICS_RESULT_CACHE_MAX_CHUNKS });
  StatisticsResultCache_lastWriteStatus_ = write.status;
  return write.stored;
}

function Statistics_monthRange_(startYm, endYm) {
  startYm = requireMonthString_(startYm, "시작 월");
  endYm = requireMonthString_(endYm, "종료 월");
  var start = DateMoney_parseMonthStart(startYm);
  var end = DateMoney_parseMonthStart(endYm);
  if (start > end) throw new Error("시작 월은 종료 월보다 늦을 수 없습니다.");
  var count = (end.getFullYear() - start.getFullYear()) * 12 + end.getMonth() - start.getMonth() + 1;
  if (count > 36) throw new Error("한 번에 조회할 수 있는 기간은 최대 36개월입니다.");
  var result = [];
  for (var i = 0; i < count; i++) {
    result.push(DateMoney_formatDateOnly(new Date(start.getFullYear(), start.getMonth() + i, 1)).substring(0, 7));
  }
  return result;
}

function Statistics_getMonthPayments_(snapshot, targetYm, revenueBasis) {
  if (revenueBasis === "PAY_DATE") {
    return ((snapshot.paymentsByPayDateMonth || {})[targetYm] || []).slice();
  }
  var result = [];
  Object.keys(snapshot.paymentsByStudentMonth || {}).forEach(function(studentId) {
    var months = snapshot.paymentsByStudentMonth[studentId] || {};
    (months[targetYm] || []).forEach(function(payment) { result.push(payment); });
  });
  return result;
}

/**
 * 대시보드와 동일하게 구조화된 일할 정보 또는 기존 일할 메모가 있으면
 * 해당 계산값을 월 규정 예상액보다 우선합니다.
 */
function Statistics_expectedTuition_(student, tuitionPayments, billingDays) {
  if (!student || !student.inMonth) return 0;
  return PaymentDomain_evaluateMonthlyTuition_(student, tuitionPayments, { billingDays: billingDays }).expected;
}

function Statistics_addAggregate_(map, key, values) {
  key = String(key || "미지정").trim() || "미지정";
  if (!map[key]) {
    map[key] = {
      name: key, activeStudents: 0, expectedTuition: 0, tuitionReceived: 0,
      otherRevenue: 0, totalReceived: 0, paymentCount: 0
    };
  }
  Object.keys(values || {}).forEach(function(field) {
    if (field === "name") return;
    map[key][field] = (Number(map[key][field]) || 0) + (Number(values[field]) || 0);
  });
}

function Statistics_mapToSortedList_(map, sortField) {
  return Object.keys(map || {}).map(function(key) { return map[key]; }).sort(function(a, b) {
    var difference = (Number(b[sortField]) || 0) - (Number(a[sortField]) || 0);
    return difference || String(a.name).localeCompare(String(b.name));
  });
}

function Statistics_monthFromDate_(value) {
  var date = MonthlySnapshot_parseDate_(value);
  return date ? DateMoney_formatDateOnly(date).substring(0, 7) : "";
}

function Statistics_normalizeSalaryYm_(value) {
  if (typeof SalaryManagement_normalizeYmCell_ === "function") {
    return SalaryManagement_normalizeYmCell_(value);
  }
  if (value instanceof Date && !isNaN(value.getTime())) {
    return DateMoney_formatDateOnly(new Date(value.getFullYear(), value.getMonth(), 1)).substring(0, 7);
  }
  var match = String(value || "").trim().match(/^(\d{4})[-./](\d{1,2})/);
  return match ? match[1] + "-" + ("0" + Number(match[2])).slice(-2) : "";
}

/** 확정 급여(귀속월)와 실제 지급(지급일)을 의도적으로 분리합니다. */
function Statistics_buildSalaryStats_(months, context) {
  var monthMap = {};
  var monthSet = {};
  var settlementMap = {};
  var paymentEntrySeen = {};
  var compatibilityFallbackCount = 0;
  var teacherMap = {};
  months.forEach(function(month) {
    monthSet[month] = true;
    monthMap[month] = { finalAmount: 0, paidAmount: 0, balanceAmount: 0 };
  });
  function teacherItem(name) {
    name = String(name || "미지정").trim() || "미지정";
    if (!teacherMap[name]) teacherMap[name] = { name: name, finalAmount: 0, paidAmount: 0, balanceAmount: 0 };
    return teacherMap[name];
  }
  ((context || {})[SHEET_NAMES.SALARY_SETTLEMENTS] || []).slice(1).forEach(function(row) {
    var settlementId = String(row[IDX.SALARY_SETTLEMENT.ID] || "").trim();
    if (!settlementId || String(row[IDX.SALARY_SETTLEMENT.STATUS] || "").trim() === "취소") return;
    var ym = Statistics_normalizeSalaryYm_(row[IDX.SALARY_SETTLEMENT.YM]);
    var teacher = String(row[IDX.SALARY_SETTLEMENT.TEACHER_NAME] || "").trim() || "미지정";
    settlementMap[settlementId] = {
      teacher: teacher, ym: ym,
      legacyPaidAmount: Number(row[IDX.SALARY_SETTLEMENT.PAID_AMOUNT]) || 0
    };
    if (!monthSet[ym]) return;
    var finalAmount = Number(row[IDX.SALARY_SETTLEMENT.FINAL_AMOUNT]) || 0;
    var balanceAmount = Number(row[IDX.SALARY_SETTLEMENT.BALANCE_AMOUNT]) || 0;
    monthMap[ym].finalAmount += finalAmount;
    monthMap[ym].balanceAmount += balanceAmount;
    teacherItem(teacher).finalAmount += finalAmount;
    teacherItem(teacher).balanceAmount += balanceAmount;
  });
  ((context || {})[SHEET_NAMES.SALARY_ENTRIES] || []).slice(1).forEach(function(row) {
    if (String(row[IDX.SALARY_ENTRY.STATUS] || "").trim() === "취소") return;
    var type = String(row[IDX.SALARY_ENTRY.TYPE] || "").trim();
    if (["지급", "지급차감보정"].indexOf(type) === -1) return;
    var settlementId = String(row[IDX.SALARY_ENTRY.SETTLEMENT_ID] || "").trim();
    var settlement = settlementMap[settlementId];
    var paidYm = Statistics_monthFromDate_(row[IDX.SALARY_ENTRY.ENTRY_DATE]);
    if (!settlement) return;
    paymentEntrySeen[settlementId] = true;
    if (!monthSet[paidYm]) return;
    var amount = Number(row[IDX.SALARY_ENTRY.AMOUNT]) || 0;
    monthMap[paidYm].paidAmount += amount;
    teacherItem(settlement.teacher).paidAmount += amount;
  });
  // 급여내역 도입 전 기록은 지급일을 알 수 없으므로 정산 귀속월에만 호환 집계합니다.
  Object.keys(settlementMap).forEach(function(settlementId) {
    var settlement = settlementMap[settlementId];
    if (paymentEntrySeen[settlementId] || !settlement.legacyPaidAmount || !monthSet[settlement.ym]) return;
    monthMap[settlement.ym].paidAmount += settlement.legacyPaidAmount;
    teacherItem(settlement.teacher).paidAmount += settlement.legacyPaidAmount;
    compatibilityFallbackCount++;
  });
  var totals = { finalAmount: 0, paidAmount: 0, balanceAmount: 0 };
  months.forEach(function(month) {
    totals.finalAmount += monthMap[month].finalAmount;
    totals.paidAmount += monthMap[month].paidAmount;
    totals.balanceAmount += monthMap[month].balanceAmount;
  });
  return {
    months: monthMap,
    totals: totals,
    compatibilityFallbackCount: compatibilityFallbackCount,
    teachers: Object.keys(teacherMap).map(function(key) { return teacherMap[key]; }).sort(function(a, b) {
      return (b.paidAmount - a.paidAmount) || (b.finalAmount - a.finalAmount) || a.name.localeCompare(b.name);
    })
  };
}

function Statistics_buildMonth_(targetYm, context, revenueBasis) {
    var snapshot = MonthlySnapshot_build_(targetYm, context);
  var monthPayments = Statistics_getMonthPayments_(snapshot, targetYm, revenueBasis);
  var students = {};
  var teacherMap = {};
  var gradeMap = {};
  var methodMap = {};
  var typeMap = {};
  var expectedTuition = 0;
  var tuitionReceived = 0;
  var otherRevenue = 0;
  var paymentCount = 0;
  var fullPaid = 0;
  var partialPaid = 0;
  var unpaid = 0;
  var exempt = 0;
  var outstanding = 0;
  var overpaid = 0;
  var attributedTuitionReceived = 0;
  var receivables = [];
  var activeStudents = 0;
  var newStudents = 0;
  var exitedStudents = 0;
  var vacationStudents = 0;
  var vacationDays = 0;

  snapshot.students.forEach(function(student) {
    students[student.id] = {
      expected: 0, tuitionReceived: 0,
      teacher: String(student.state.teacher || "").trim() || "미지정",
      grade: String(student.grade || "").trim() || "미지정",
      student: student
    };
    if (student.inMonth) {
      activeStudents++;
      vacationDays += Number(student.vacationDays) || 0;
      if (student.vacationDays > 0) vacationStudents++;
      Statistics_addAggregate_(teacherMap, students[student.id].teacher, { activeStudents: 1 });
      Statistics_addAggregate_(gradeMap, students[student.id].grade, { activeStudents: 1 });
    }
    if (student.firstDate &&
        student.firstDate.getFullYear() === snapshot.monthStart.getFullYear() &&
        student.firstDate.getMonth() === snapshot.monthStart.getMonth()) newStudents++;
    if (student.exitDate &&
        student.exitDate.getFullYear() === snapshot.monthStart.getFullYear() &&
        student.exitDate.getMonth() === snapshot.monthStart.getMonth()) exitedStudents++;
  });

  monthPayments.forEach(function(payment) {
    var amount = Number(payment.amount) || 0;
    if (amount <= 0) return;
    var type = normalizePaymentType_(payment.type);
    var typeLabel = type;
    var method = String(payment.method || "").trim() || "미지정";
    var studentStats = students[String(payment.studentId)] || {
      expected: 0, tuitionReceived: 0, teacher: "미지정", grade: "미지정", student: null
    };
    paymentCount++;
    Statistics_addAggregate_(methodMap, method, { totalReceived: amount, paymentCount: 1 });
    Statistics_addAggregate_(typeMap, typeLabel, { totalReceived: amount, paymentCount: 1 });
    Statistics_addAggregate_(teacherMap, studentStats.teacher, {
      tuitionReceived: isTuitionPaymentType_(type) ? amount : 0,
      otherRevenue: isTuitionPaymentType_(type) ? 0 : amount,
      totalReceived: amount,
      paymentCount: 1
    });
    Statistics_addAggregate_(gradeMap, studentStats.grade, {
      tuitionReceived: isTuitionPaymentType_(type) ? amount : 0,
      otherRevenue: isTuitionPaymentType_(type) ? 0 : amount,
      totalReceived: amount,
      paymentCount: 1
    });
    if (isTuitionPaymentType_(type)) {
      tuitionReceived += amount;
      studentStats.tuitionReceived += amount;
    } else {
      otherRevenue += amount;
    }
  });

  Object.keys(students).forEach(function(studentId) {
    var item = students[studentId];
    var student = item.student;
    if (!student || !student.inMonth) return;
    var tuitionPayments = MonthlySnapshot_getPaymentEntries_(snapshot, studentId, targetYm).filter(function(payment) {
      return isTuitionPaymentType_(payment.type) && Number(payment.amount) > 0;
    });
    item.expected = Statistics_expectedTuition_(student, tuitionPayments, snapshot.billingDays);
    expectedTuition += item.expected;
    Statistics_addAggregate_(teacherMap, item.teacher, { expectedTuition: item.expected });
    Statistics_addAggregate_(gradeMap, item.grade, { expectedTuition: item.expected });
    if (item.expected <= 0) {
      exempt++;
      return;
    }
    var statusReceived = tuitionPayments.reduce(function(sum, payment) {
      return sum + (Number(payment.amount) || 0);
    }, 0);
    attributedTuitionReceived += statusReceived;
    var balance = PaymentDomain_calculateBalance(item.expected, statusReceived);
    if (balance.status === "완납") fullPaid++;
    else if (statusReceived > 0) partialPaid++;
    else unpaid++;
    var shortage = balance.status === "완납" ? 0 : Math.max(0, item.expected - statusReceived);
    outstanding += shortage;
    overpaid += Math.max(0, statusReceived - item.expected);
    if (balance.status !== "완납") {
      receivables.push({
        month: targetYm, studentId: studentId, name: String(student.name || ""),
        grade: item.grade, teacher: item.teacher,
        status: statusReceived > 0 ? "부분납" : "미납",
        expected: item.expected, received: statusReceived, outstanding: shortage
      });
    }
  });

  var totalReceived = tuitionReceived + otherRevenue;
  return {
    month: targetYm,
    snapshotStatus:snapshot.persistentSnapshotStatus || "unknown",
    activeStudents: activeStudents,
    newStudents: newStudents,
    exitedStudents: exitedStudents,
    netStudentChange: newStudents - exitedStudents,
    vacationStudents: vacationStudents,
    vacationDays: vacationDays,
    expectedTuition: expectedTuition,
    tuitionReceived: tuitionReceived,
    attributedTuitionReceived: attributedTuitionReceived,
    otherRevenue: otherRevenue,
    totalReceived: totalReceived,
    paymentCount: paymentCount,
    averagePayment: paymentCount ? DateMoney_roundWon(totalReceived / paymentCount) : 0,
    collectionRate: expectedTuition > 0 ? Math.round(tuitionReceived * 1000 / expectedTuition) / 10 : 0,
    statusCollectionRate: expectedTuition > 0 ? Math.round(attributedTuitionReceived * 1000 / expectedTuition) / 10 : 0,
    fullPaid: fullPaid,
    partialPaid: partialPaid,
    unpaid: unpaid,
    exempt: exempt,
    outstanding: outstanding,
    overpaid: overpaid,
    receivables: receivables.sort(function(a, b) { return b.outstanding - a.outstanding || a.name.localeCompare(b.name); }),
    teachers: Statistics_mapToSortedList_(teacherMap, "totalReceived"),
    grades: Statistics_mapToSortedList_(gradeMap, "totalReceived"),
    methods: Statistics_mapToSortedList_(methodMap, "totalReceived"),
    types: Statistics_mapToSortedList_(typeMap, "totalReceived")
  };
}

function getPeriodStatistics(startYm, endYm, revenueBasis) {
  var startedAt = Date.now();
  requireSuperAdmin_();
  revenueBasis = String(revenueBasis || "PAY_DATE").trim().toUpperCase();
  if (["PAY_DATE", "ATTRIBUTION"].indexOf(revenueBasis) === -1) throw new Error("통계 집계 기준이 올바르지 않습니다.");
  var months = Statistics_monthRange_(startYm, endYm);
  startYm = months[0];
  endYm = months[months.length - 1];
  var initialCacheSignature = StatisticsResultCache_signature_(startYm, endYm, revenueBasis);
  var cachedResult = StatisticsResultCache_get_(initialCacheSignature);
  if (cachedResult) {
    console.log("[기간 통계 조회 성능] " + JSON.stringify({
      startYm: startYm, endYm: endYm, revenueBasis: revenueBasis,
      months: months.length, cacheHit: true,
      cacheReadStatus: StatisticsResultCache_lastReadStatus_, cacheWriteStatus: "not_needed",
      totalMs: Date.now() - startedAt
    }));
    return cachedResult;
  }
  var context = DataRepository_loadContext_([
    SHEET_NAMES.STUDENTS, SHEET_NAMES.PAYMENTS, SHEET_NAMES.VACATIONS, SHEET_NAMES.LOGS,
    SHEET_NAMES.SALARY_SETTLEMENTS, SHEET_NAMES.SALARY_ENTRIES
  ], { required: false });
  var cacheSignatureAfterLoad = StatisticsResultCache_signature_(startYm, endYm, revenueBasis);
  var monthRows = months.map(function(targetYm) {
    return Statistics_buildMonth_(targetYm, context, revenueBasis);
  });
  var teacherMap = {};
  var gradeMap = {};
  var methodMap = {};
  var typeMap = {};
  var salaryStats = Statistics_buildSalaryStats_(months, context);
  var receivables = [];
  var totals = {
    activeStudentMonths: 0, newStudents: 0, exitedStudents: 0,
    vacationStudents: 0, vacationDays: 0, expectedTuition: 0,
    tuitionReceived: 0, attributedTuitionReceived: 0, otherRevenue: 0, totalReceived: 0,
    paymentCount: 0, fullPaid: 0, partialPaid: 0, unpaid: 0,
    exempt: 0, outstanding: 0, overpaid: 0
  };

  monthRows.forEach(function(month) {
    totals.activeStudentMonths += month.activeStudents;
    totals.newStudents += month.newStudents;
    totals.exitedStudents += month.exitedStudents;
    totals.vacationStudents += month.vacationStudents;
    totals.vacationDays += month.vacationDays;
    totals.expectedTuition += month.expectedTuition;
    totals.tuitionReceived += month.tuitionReceived;
    totals.attributedTuitionReceived += month.attributedTuitionReceived;
    totals.otherRevenue += month.otherRevenue;
    totals.totalReceived += month.totalReceived;
    totals.paymentCount += month.paymentCount;
    totals.fullPaid += month.fullPaid;
    totals.partialPaid += month.partialPaid;
    totals.unpaid += month.unpaid;
    totals.exempt += month.exempt;
    totals.outstanding += month.outstanding;
    totals.overpaid += month.overpaid;
    receivables = receivables.concat(month.receivables || []);
    var salaryMonth = salaryStats.months[month.month] || { finalAmount: 0, paidAmount: 0, balanceAmount: 0 };
    month.salaryFinalAmount = salaryMonth.finalAmount;
    month.salaryPaidAmount = salaryMonth.paidAmount;
    month.salaryBalanceAmount = salaryMonth.balanceAmount;
    month.afterSalaryAmount = month.totalReceived - salaryMonth.paidAmount;
    month.teachers.forEach(function(item) { Statistics_addAggregate_(teacherMap, item.name, item); });
    month.grades.forEach(function(item) { Statistics_addAggregate_(gradeMap, item.name, item); });
    month.methods.forEach(function(item) { Statistics_addAggregate_(methodMap, item.name, item); });
    month.types.forEach(function(item) { Statistics_addAggregate_(typeMap, item.name, item); });
  });

  totals.averageActiveStudents = months.length ? Math.round(totals.activeStudentMonths * 10 / months.length) / 10 : 0;
  totals.averagePayment = totals.paymentCount ? DateMoney_roundWon(totals.totalReceived / totals.paymentCount) : 0;
  totals.collectionRate = totals.expectedTuition > 0
    ? Math.round(totals.tuitionReceived * 1000 / totals.expectedTuition) / 10
    : 0;
  totals.statusCollectionRate = totals.expectedTuition > 0
    ? Math.round(totals.attributedTuitionReceived * 1000 / totals.expectedTuition) / 10
    : 0;
  totals.netStudentChange = totals.newStudents - totals.exitedStudents;
  totals.salaryFinalAmount = salaryStats.totals.finalAmount;
  totals.salaryPaidAmount = salaryStats.totals.paidAmount;
  totals.salaryBalanceAmount = salaryStats.totals.balanceAmount;
  totals.afterSalaryAmount = totals.totalReceived - totals.salaryPaidAmount;
  totals.salaryPaidRate = totals.totalReceived > 0
    ? Math.round(totals.salaryPaidAmount * 1000 / totals.totalReceived) / 10 : 0;
  var latestMonth = monthRows[monthRows.length - 1];
  var uniqueReceivableStudents = {};
  var uniqueUnpaidStudents = {};
  receivables.forEach(function(item) {
    uniqueReceivableStudents[item.studentId] = true;
    if (item.status === "미납") uniqueUnpaidStudents[item.studentId] = true;
  });

  var result = {
    period: { start: months[0], end: months[months.length - 1], monthCount: months.length },
    totals: totals,
    months: monthRows,
    teachers: Statistics_mapToSortedList_(teacherMap, "totalReceived"),
    grades: Statistics_mapToSortedList_(gradeMap, "totalReceived"),
    methods: Statistics_mapToSortedList_(methodMap, "totalReceived"),
    types: Statistics_mapToSortedList_(typeMap, "totalReceived"),
    salaries: salaryStats.teachers,
    receivables: receivables.sort(function(a, b) {
      return String(b.month).localeCompare(String(a.month)) || b.outstanding - a.outstanding || a.name.localeCompare(b.name);
    }),
    latestStatus: latestMonth ? {
      month: latestMonth.month, fullPaid: latestMonth.fullPaid, partialPaid: latestMonth.partialPaid,
      unpaid: latestMonth.unpaid, outstanding: latestMonth.outstanding,
      receivables: latestMonth.receivables || []
    } : null,
    receivableSummary: {
      studentMonths: receivables.length,
      uniqueStudents: Object.keys(uniqueReceivableStudents).length,
      uniqueUnpaidStudents: Object.keys(uniqueUnpaidStudents).length
    },
    basis: {
      expectedTuition: "월별 대시보드와 동일한 적용일·휴가·형제할인·일할 정보 기준",
      teacher: "각 조회 월 말 담당자 기준",
      revenue: revenueBasis === "PAY_DATE" ? "실제 납부일 기준의 0원 초과 수납 기록" : "수업 귀속월 기준의 0원 초과 수납 기록",
      revenueBasis: revenueBasis,
      paymentStatus: "완납·부분납·미납은 조회 기준과 무관하게 수업 귀속월 수강료로 판정",
      salary: "확정 급여는 정산 귀속월, 실제 지급 급여는 급여내역 지급일 기준" +
        (salaryStats.compatibilityFallbackCount ? " (지급일 없는 기존 " + salaryStats.compatibilityFallbackCount + "건은 귀속월로 표시)" : "")
    }
  };
  var finalCacheSignature = StatisticsResultCache_signature_(startYm, endYm, revenueBasis);
  if (finalCacheSignature === cacheSignatureAfterLoad) {
    StatisticsResultCache_put_(finalCacheSignature, result);
    if (StatisticsResultCache_lastWriteStatus_.indexOf("stored_") === 0 && initialCacheSignature !== finalCacheSignature) {
      StatisticsResultCache_lastWriteStatus_ += "_after_source_refresh";
    }
  } else {
    StatisticsResultCache_lastWriteStatus_ = "generation_changed_after_load";
  }
  console.log("[기간 통계 조회 성능] " + JSON.stringify({
    startYm: startYm, endYm: endYm, revenueBasis: revenueBasis,
    months: months.length, cacheHit: false,
    cacheReadStatus: StatisticsResultCache_lastReadStatus_,
    cacheWriteStatus: StatisticsResultCache_lastWriteStatus_,
    monthlySnapshotStatuses:monthRows.map(function(item) { return item.month + ":" + item.snapshotStatus; }),
    resultChars: JSON.stringify(result).length,
    totalMs: Date.now() - startedAt
  }));
  return result;
}
