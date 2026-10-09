var DATE_MONEY_POLICY = {
  TIME_ZONE: "Asia/Seoul",
  FEBRUARY_BILLING_DAYS: 30,
  ROUND_AT_FINAL_STEP: true
};

function DateMoney_parseDateOnly(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  var match = String(value || "").trim().match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[T\s].*)?$/);
  if (!match) return null;
  var year = Number(match[1]);
  var monthIndex = Number(match[2]) - 1;
  var day = Number(match[3]);
  var date = new Date(year, monthIndex, day);
  return date.getFullYear() === year && date.getMonth() === monthIndex && date.getDate() === day ? date : null;
}

function DateMoney_formatDateOnly(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return "";
  return date.getFullYear() + "-" + ("0" + (date.getMonth() + 1)).slice(-2) + "-" + ("0" + date.getDate()).slice(-2);
}

/** 화면용 고속 날짜 포맷. 시간대 변환이 필요 없는 날짜 전용 값에만 사용합니다. */
function fastFormatDate(dateObj, format) {
  if (!dateObj || !(dateObj instanceof Date)) return "";
  var y = dateObj.getFullYear();
  var m = dateObj.getMonth() + 1;
  var d = dateObj.getDate();
  var mm = m < 10 ? "0" + m : String(m);
  var dd = d < 10 ? "0" + d : String(d);
  if (format === "yyyy-MM") return y + "-" + mm;
  if (format === "MM-dd") return mm + "-" + dd;
  if (format === "yyyy-MM-dd") return y + "-" + mm + "-" + dd;
  return "";
}

function DateMoney_parseMonthStart(targetYm) {
  var match = String(targetYm || "").match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (!match) throw new Error("조회 월 형식이 올바르지 않습니다.");
  return new Date(Number(match[1]), Number(match[2]) - 1, 1);
}

function DateMoney_roundWon(value) {
  var number = Number(value);
  if (!isFinite(number)) throw new Error("금액 계산값이 올바르지 않습니다.");
  return number >= 0 ? Math.floor(number + 0.5) : Math.ceil(number - 0.5);
}

function DateMoney_truncateWon(value) {
  var number = Number(value);
  if (!isFinite(number)) throw new Error("금액 계산값이 올바르지 않습니다.");
  return number >= 0 ? Math.floor(number) : Math.ceil(number);
}

function DateMoney_inclusiveDays(startDate, endDate) {
  var startUtc = Date.UTC(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  var endUtc = Date.UTC(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  return Math.floor((endUtc - startUtc) / 86400000) + 1;
}

function DateMoney_prorate(monthlyFee, activeDays, billingDays) {
  var fee = DateMoney_roundWon(monthlyFee);
  var usedDays = Number(activeDays);
  var totalDays = Number(billingDays);
  if (!isFinite(usedDays) || !isFinite(totalDays) || usedDays < 0 || totalDays <= 0) throw new Error("일할 계산 일수가 올바르지 않습니다.");
  return DateMoney_roundWon(fee * usedDays / totalDays);
}

function DateMoney_billingDays(year, month) {
  return month === 2 ? OperationalSettings_getNumber_("FEBRUARY_BILLING_DAYS", DATE_MONEY_POLICY.FEBRUARY_BILLING_DAYS) : new Date(year, month, 0).getDate();
}
