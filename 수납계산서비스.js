var PAYMENT_TOLERANCE_WON = 1000;
var PAYMENT_WARNING_HIGH_WON = 5000;
var PAYMENT_SILENT_DIFF_WON = 10;
// DB_수납 O열은 과거 수납그룹ID 자리입니다. 열 위치 호환을 위해 남기되 항상 비워둡니다.
var PAYMENT_RETIRED_GROUP_COLUMN = 15;
var PAYMENT_RETIRED_GROUP_MIGRATION_PROPERTY = "PAYMENT_RETIRED_GROUP_COLUMN_V1";

function PaymentDomain_toleranceWon_() { return OperationalSettings_getNumber_("PAYMENT_TOLERANCE_WON", PAYMENT_TOLERANCE_WON); }
function PaymentDomain_warningHighWon_() { return Math.max(PaymentDomain_toleranceWon_() + 1, OperationalSettings_getNumber_("PAYMENT_WARNING_HIGH_WON", PAYMENT_WARNING_HIGH_WON)); }
function PaymentDomain_silentDiffWon_() { return Math.min(PaymentDomain_toleranceWon_(), OperationalSettings_getNumber_("PAYMENT_SILENT_DIFF_WON", PAYMENT_SILENT_DIFF_WON)); }
function PaymentDomain_prorationWarningPercent_() { return OperationalSettings_getNumber_("PRORATION_AMOUNT_WARNING_PERCENT", 20); }

function PaymentDomain_prorationDifference_(actualAmount, calculatedAmount) {
  var actual = DateMoney_roundWon(Number(actualAmount) || 0);
  var calculated = DateMoney_roundWon(Number(calculatedAmount) || 0);
  var difference = actual - calculated;
  var percent = calculated === 0 ? (actual === 0 ? 0 : Infinity) : Math.abs(difference) / calculated * 100;
  return { actualAmount:actual, calculatedAmount:calculated, difference:difference, percent:percent,
    exceeds:percent > PaymentDomain_prorationWarningPercent_() };
}

function normalizePaymentType_(value) {
  var type = String(value == null ? "" : value).trim();
  return type || "수강료";
}

function isTuitionPaymentType_(value) {
  return normalizePaymentType_(value) === "수강료";
}

function PaymentDomain_ensurePaymentSchema_(sheet, tx) {
  if (!sheet) throw new Error("수납 시트를 찾을 수 없습니다.");
  DataSchema_ensureSheet_(SHEET_NAMES.PAYMENTS, tx);
  PaymentDomain_retireGroupColumn_(sheet, tx);
}

function PaymentDomain_retireGroupColumn_(sheet, tx) {
  var properties = PropertiesService.getScriptProperties();
  var alreadyDone = properties.getProperty(PAYMENT_RETIRED_GROUP_MIGRATION_PROPERTY) === "DONE";
  var header = String(sheet.getRange(1, PAYMENT_RETIRED_GROUP_COLUMN).getDisplayValue() || "").trim();
  if (alreadyDone && !header) return false;
  var rowCount = Math.max(1, sheet.getLastRow());
  var blanks = [];
  for (var i = 0; i < rowCount; i++) blanks.push([""]);
  if (tx) tx.writeRange(sheet, 1, PAYMENT_RETIRED_GROUP_COLUMN, blanks);
  else sheet.getRange(1, PAYMENT_RETIRED_GROUP_COLUMN, rowCount, 1).setValues(blanks);
  properties.setProperty(PAYMENT_RETIRED_GROUP_MIGRATION_PROPERTY, "DONE");
  if (tx) tx.addRollback(function() { properties.deleteProperty(PAYMENT_RETIRED_GROUP_MIGRATION_PROPERTY); });
  return true;
}

function PaymentDomain_ensureStudentDiscountSchema_(sheet, tx) {
  if (!sheet) throw new Error("학생 명단 시트를 찾을 수 없습니다.");
  DataSchema_ensureSheet_(SHEET_NAMES.STUDENTS, tx);
}

function PaymentDomain_sumTuitionPayments(payments) {
  return (payments || []).reduce(function(total, payment) {
    return isTuitionPaymentType_(payment.type) ? total + (Number(payment.amount) || 0) : total;
  }, 0);
}

function PaymentDomain_calculateBalance(expectedAmount, paidAmount, options) {
  var expected = requireMoney_(expectedAmount, "확정 청구액", 0, 100000000);
  var paid = requireMoney_(paidAmount, "납부 합계", 0, 1000000000);
  var tolerance = options && options.tolerance != null ? Number(options.tolerance) : PaymentDomain_toleranceWon_();
  var isVacation = !!(options && options.isVacation);
  var balance = expected - paid;
  var status;
  if (isVacation && expected === 0 && paid === 0) status = "휴원";
  else if (expected === 0) status = "완납";
  else if (paid === 0) status = "미납";
  else if (paid >= expected - tolerance) status = "완납"; // 초과 수납도 완납
  else status = "부분납";
  return { expected: expected, paid: paid, balance: balance, status: status, tolerance: tolerance };
}

/** 완납 허용 범위와 별개로 실제 금액 차이를 화면에 표시하기 위한 공통 판정입니다. */
function PaymentDomain_classifyDifference(diffAmount, contextLabel) {
  var diff = Number(diffAmount) || 0;
  var absDiff = Math.abs(diff);
  var label = String(contextLabel || "금액");
  var silentDiff = PaymentDomain_silentDiffWon_();
  var tolerance = PaymentDomain_toleranceWon_();
  var warningHigh = PaymentDomain_warningHighWon_();
  if (absDiff <= silentDiff) return { level: 0, message: "" };
  if (absDiff <= tolerance) {
    return { level: 1, message: label + " 완납 허용 오차 (±" + tolerance.toLocaleString() + "원 이내)" };
  }
  if (absDiff < warningHigh) {
    return { level: 1, message: label + " 소액 차이 확인" };
  }
  return { level: 2, message: label + " 차이 큼" };
}

function PaymentDomain_adjustMonthlyFee(baseFee, siblingDiscount, otherDiscount) {
  var fee = requireMoney_(baseFee, "기본 수강료", 0, 100000000);
  var sibling = requireMoney_(siblingDiscount || 0, "형제 할인", 0, 100000000);
  var other = requireMoney_(otherDiscount || 0, "기타 할인", 0, 100000000);
  return Math.max(0, fee - sibling - other);
}

function PaymentDomain_prorateAdjustedFee(baseFee, siblingDiscount, otherDiscount, activeDays, billingDays) {
  return prorateMoney_(PaymentDomain_adjustMonthlyFee(baseFee, siblingDiscount, otherDiscount), activeDays, billingDays);
}

/** 선택한 일할 기간에서 학생의 휴가·퇴원공백과 겹치는 날짜를 중복 없이 제외합니다. */
function PaymentDomain_calculateProratedPeriod_(monthlyFee, startDate, endDate, vacations) {
  var actualLastDay = new Date(endDate.getFullYear(), endDate.getMonth() + 1, 0).getDate();
  var billingDays = DateMoney_billingDays(endDate.getFullYear(), endDate.getMonth() + 1);
  var calendarDays = inclusiveCalendarDays_(startDate, endDate);
  var absenceDates = {};
  var overlappingPeriods = [];

  (vacations || []).forEach(function(vacation) {
    var vacationStart = parseDateOnly_(vacation.startDate || vacation.start);
    var vacationEnd = parseDateOnly_(vacation.endDate || vacation.end);
    if (!vacationStart || !vacationEnd || vacationStart > endDate || vacationEnd < startDate) return;
    var overlapStart = vacationStart > startDate ? vacationStart : startDate;
    var overlapEnd = vacationEnd < endDate ? vacationEnd : endDate;
    for (var day = new Date(overlapStart); day <= overlapEnd; day.setDate(day.getDate() + 1)) {
      absenceDates[Date.UTC(day.getFullYear(), day.getMonth(), day.getDate())] = true;
    }
    overlappingPeriods.push({
      startDate:formatDateOnly_(overlapStart), endDate:formatDateOnly_(overlapEnd),
      reason:String(vacation.reason || ""), periodType:String(vacation.periodType || VACATION_PERIOD_TYPES.VACATION)
    });
  });

  var vacationDays = Object.keys(absenceDates).length;
  var activeDays = Math.max(0, calendarDays - vacationDays);
  var lastDayKey = Date.UTC(endDate.getFullYear(), endDate.getMonth(), actualLastDay);
  // 월별 스냅샷과 동일하게 2월 말일까지 수강 가능할 때만 설정 기준일수 차이를 더합니다.
  if (endDate.getMonth() === 1 && endDate.getDate() === actualLastDay && !absenceDates[lastDayKey]) {
    activeDays += billingDays - actualLastDay;
  }
  activeDays = Math.max(0, Math.min(activeDays, billingDays));
  return {
    amount:prorateMoney_(monthlyFee, activeDays, billingDays), activeDays:activeDays,
    billingDays:billingDays, calendarDays:calendarDays, vacationDays:vacationDays,
    vacationPeriods:overlappingPeriods
  };
}

function PaymentDomain_getStudentVacations_(studentId) {
  var targetId = String(studentId || "").trim();
  if (!targetId) return [];
  return LookupIndex_findRows_(SHEET_NAMES.VACATIONS, COL.VACATION.STUDENT_ID, targetId, false)
    .map(function(item) { return item.row; }).map(function(row) {
    return {
      startDate:formatDateOnly_(parseDateOnly_(row[IDX.VACATION.START_DATE])),
      endDate:formatDateOnly_(parseDateOnly_(row[IDX.VACATION.END_DATE])),
      reason:String(row[IDX.VACATION.REASON] || ""),
      periodType:String(row[IDX.VACATION.PERIOD_TYPE] || VACATION_PERIOD_TYPES.VACATION)
    };
    });
}

/** 월 예상액·실수납·완납 상태·경고를 모든 화면에서 동일하게 계산합니다. */
function PaymentDomain_evaluateMonthlyTuition_(student, payments, options) {
  student = student || {};
  payments = payments || [];
  options = options || {};
  var billableFee = DateMoney_roundWon(Number(student.billableFee) || 0);
  var activeDays = Math.max(0, Number(student.activeDays) || 0);
  var billingDays = Math.max(1, Number(options.billingDays || student.billingDays) || 30);
  var expected = activeDays <= 0 ? 0
    : activeDays < billingDays ? prorateMoney_(billableFee, activeDays, billingDays) : billableFee;
  var source = activeDays < billingDays ? "월별재원일수" : "정규수강료";
  var structured = [];
  var legacy = [];
  payments.forEach(function(payment, index) {
    if (!isTuitionPaymentType_(payment.type)) return;
    var paymentActiveDays = Number(payment.activeDays);
    var paymentBillingDays = Number(payment.billingDays);
    if (String(payment.calcType || "") === "PRORATED" &&
        isFinite(paymentActiveDays) && paymentActiveDays >= 0 &&
        isFinite(paymentBillingDays) && paymentBillingDays > 0) {
      structured.push({ index: index, activeDays: paymentActiveDays, billingDays: paymentBillingDays, payId: payment.payId || "" });
      return;
    }
    var match = String(payment.memo || "").match(/\((\d+)일\/(\d+)일/);
    if (match && Number(match[2]) > 0) {
      legacy.push({ index: index, activeDays: Number(match[1]), billingDays: Number(match[2]), payId: payment.payId || "" });
    }
  });
  var candidates = structured.length ? structured : legacy;
  var selected = candidates.length ? candidates[candidates.length - 1] : null;
  if (selected) {
    expected = prorateMoney_(billableFee, selected.activeDays, selected.billingDays);
    source = structured.length ? "구조화일할" : "기존일할메모";
    activeDays = selected.activeDays;
    billingDays = selected.billingDays;
  }
  var conflict = candidates.some(function(candidate) {
    return selected && (candidate.activeDays !== selected.activeDays || candidate.billingDays !== selected.billingDays);
  });
  var received = PaymentDomain_sumTuitionPayments(payments);
  var hasVacation = payments.some(function(payment) { return String(payment.type || "") === "휴원"; });
  var balance = PaymentDomain_calculateBalance(expected, received, { isVacation: hasVacation });
  var hasActualTuition = payments.some(function(payment) {
    return !payment.isVirtual && isTuitionPaymentType_(payment.type);
  });
  var differenceLabel = source === "정규수강료" ? "정규 금액" : "일할 금액";
  var warning = (received > 0 || (expected > 0 && hasActualTuition))
    ? PaymentDomain_classifyDifference(received - expected, differenceLabel)
    : { level: 0, message: "" };
  if (conflict && warning.level < 1) warning = { level: 1, message: "서로 다른 일할 조건이 있어 최신 조건을 적용했습니다." };
  return {
    expected: expected, received: received, balance: balance.balance, status: balance.status,
    warningLevel: warning.level, warningMessage: warning.message,
    calculationSource: source, activeDays: activeDays, billingDays: billingDays,
    conflictingProration: conflict, selectedProrationPayId: selected ? selected.payId : ""
  };
}
