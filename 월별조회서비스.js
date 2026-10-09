/** 월별 화면들이 함께 사용하는 학생·수납·휴가 조회 스냅샷 */
function MonthlySnapshot_parseDate_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }
  var parsed = DateMoney_parseDateOnly(value);
  if (parsed) return parsed;
  var match = String(value || "").trim().match(/^(\d{2})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (!match) return null;
  var year = 2000 + Number(match[1]);
  var monthIndex = Number(match[2]) - 1;
  var day = Number(match[3]);
  var date = new Date(year, monthIndex, day);
  return date.getFullYear() === year && date.getMonth() === monthIndex && date.getDate() === day ? date : null;
}

function MonthlySnapshot_monthString_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value.getFullYear() + "-" + ("0" + (value.getMonth() + 1)).slice(-2);
  }
  var match = String(value || "").trim().match(/^(\d{4})-(0[1-9]|1[0-2])/);
  return match ? match[1] + "-" + match[2] : "";
}

function MonthlySnapshot_isEarlyExit_(status, firstDate, exitDate, monthStart) {
  return status === "퇴원" && !!firstDate && !!exitDate &&
    exitDate.getFullYear() === monthStart.getFullYear() &&
    exitDate.getMonth() === monthStart.getMonth() &&
    exitDate.getDate() <= 3 && firstDate < monthStart;
}

function MonthlySnapshot_resolveExitDate_(studentRow, histories, asOfDate, resolvedState) {
  var rawExitDate = MonthlySnapshot_parseDate_(studentRow[IDX.STUDENT.EXIT_DATE]);
  if (!resolvedState || resolvedState.status !== "퇴원") return rawExitDate;
  var studentId = String(studentRow[IDX.STUDENT.ID] || "").trim();
  var statusEvents = ((((histories || {})[studentId] || {}).status) || []).filter(function(event) {
    return event.effectiveDate <= asOfDate && String(event.after || "").trim() === "퇴원";
  }).sort(function(a, b) {
    return (b.effectiveDate - a.effectiveDate) || (b.createdAt - a.createdAt) || (b.rowOrder - a.rowOrder);
  });
  return statusEvents.length ? new Date(statusEvents[0].effectiveDate) : rawExitDate;
}

function MonthlySnapshot_buildTeacherOwnerships_(studentRow, histories, teacherIdByName) {
  var studentId = String(studentRow[IDX.STUDENT.ID] || "").trim();
  var events = (((histories || {})[studentId] || {}).teacher || []).slice().sort(function(a, b) {
    return (a.effectiveDate - b.effectiveDate) || (a.createdAt - b.createdAt) || (a.rowOrder - b.rowOrder);
  });
  var ownerships = [];
  var periodStart = new Date(2000, 0, 1);
  var periodTeacher = events.length
    ? String(events.slice().sort(function(a, b) { return (a.createdAt - b.createdAt) || (a.rowOrder - b.rowOrder); })[0].before || "").trim()
    : String(studentRow[IDX.STUDENT.TEACHER] || "").trim();
  var periodTeacherId = events.length
    ? String((teacherIdByName || {})[periodTeacher] || "").trim()
    : String(studentRow[IDX.STUDENT.TEACHER_ID] || (teacherIdByName || {})[periodTeacher] || "").trim();
  events.forEach(function(event) {
    var periodEnd = new Date(event.effectiveDate);
    periodEnd.setDate(periodEnd.getDate() - 1);
    if (periodStart <= periodEnd) ownerships.push({
      teacher: periodTeacher, teacherId: periodTeacherId, start: new Date(periodStart), end: periodEnd
    });
    periodTeacher = String(event.after || "").trim();
    periodTeacherId = String(event.refId || (teacherIdByName || {})[periodTeacher] || "").trim();
    periodStart = new Date(event.effectiveDate);
  });
  ownerships.push({
    teacher: periodTeacher, teacherId: periodTeacherId, start: periodStart, end: new Date(2099, 11, 31)
  });
  return ownerships;
}

function MonthlySnapshot_prepareContext_(context) {
  context = context || {};
  if (context.__monthlySnapshotPrepared) return context.__monthlySnapshotPrepared;
  var studentRows = context[SHEET_NAMES.STUDENTS] || [];
  var paymentRows = context[SHEET_NAMES.PAYMENTS] || [];
  var vacationRows = context[SHEET_NAMES.VACATIONS] || [];
  var logRows = context[SHEET_NAMES.LOGS] || [];
  var histories = buildStudentChangeHistory_(logRows);
  var teacherLookup = TeacherDirectory_buildLookup_();
  var paymentsByStudentMonth = {};
  var paymentsByPayDateMonth = {};
  for (var p = 1; p < paymentRows.length; p++) {
    var payRow = paymentRows[p];
    var studentId = String(payRow[IDX.PAYMENT.STUDENT_ID] || "").trim();
    var month = MonthlySnapshot_monthString_(payRow[IDX.PAYMENT.MONTH]);
    if (!studentId || !month) continue;
    var payDate = MonthlySnapshot_parseDate_(payRow[IDX.PAYMENT.PAY_DATE]);
    var payment = {
      payId: payRow[IDX.PAYMENT.ID], studentId: studentId,
      dateObject: payDate,
      date: payDate ? fastFormatDate(payDate, "MM-dd") : "",
      fullDate: payDate ? fastFormatDate(payDate, "yyyy-MM-dd") : "",
      month: month,
      amount: Number(payRow[IDX.PAYMENT.AMOUNT]) || 0,
      method: normalizePaymentMethod_(payRow[IDX.PAYMENT.METHOD]),
      memo: String(payRow[IDX.PAYMENT.MEMO] || ""),
      type: normalizePaymentType_(payRow[IDX.PAYMENT.TYPE]),
      calcType: String(payRow[IDX.PAYMENT.CALC_TYPE] || ""),
      calcStart: payRow[IDX.PAYMENT.CALC_START] || "",
      calcEnd: payRow[IDX.PAYMENT.CALC_END] || "",
      activeDays: payRow[IDX.PAYMENT.ACTIVE_DAYS] || "",
      billingDays: payRow[IDX.PAYMENT.BILLING_DAYS] || "",
      siblingDiscount: Number(payRow[IDX.PAYMENT.SIBLING_DISCOUNT]) || 0,
      otherDiscount: Number(payRow[IDX.PAYMENT.OTHER_DISCOUNT]) || 0
    };
    if (!paymentsByStudentMonth[studentId]) paymentsByStudentMonth[studentId] = {};
    if (!paymentsByStudentMonth[studentId][month]) paymentsByStudentMonth[studentId][month] = [];
    paymentsByStudentMonth[studentId][month].push(payment);
    var payDateMonth = payment.fullDate.substring(0, 7);
    if (payDateMonth) {
      if (!paymentsByPayDateMonth[payDateMonth]) paymentsByPayDateMonth[payDateMonth] = [];
      paymentsByPayDateMonth[payDateMonth].push(payment);
    }
  }
  var vacationsByStudent = {};
  for (var v = 1; v < vacationRows.length; v++) {
    var vacationStudentId = String(vacationRows[v][IDX.VACATION.STUDENT_ID] || "").trim();
    var vacationStart = MonthlySnapshot_parseDate_(vacationRows[v][IDX.VACATION.START_DATE]);
    var vacationEnd = MonthlySnapshot_parseDate_(vacationRows[v][IDX.VACATION.END_DATE]);
    if (!vacationStudentId || !vacationStart || !vacationEnd) continue;
    if (!vacationsByStudent[vacationStudentId]) vacationsByStudent[vacationStudentId] = [];
    vacationsByStudent[vacationStudentId].push({
      id: vacationRows[v][IDX.VACATION.ID], start: vacationStart, end: vacationEnd,
      reason: String(vacationRows[v][IDX.VACATION.REASON] || ""),
      periodType: String(vacationRows[v][IDX.VACATION.PERIOD_TYPE] || VACATION_PERIOD_TYPES.VACATION).trim() ||
        VACATION_PERIOD_TYPES.VACATION
    });
  }
  var teacherChangesByStudent = {};
  Object.keys(histories).forEach(function(historyStudentId) {
    teacherChangesByStudent[historyStudentId] = (histories[historyStudentId].teacher || []).map(function(event) {
      return {
        date: new Date(event.effectiveDate),
        oldTeacher: String(event.before || "").trim(),
        newTeacher: String(event.after || "").trim(),
        newTeacherId: String(event.refId || "").trim()
      };
    });
  });
  var prepared = {
    studentRows: studentRows, paymentRows: paymentRows, vacationRows: vacationRows, logRows: logRows,
    histories: histories, paymentsByStudentMonth: paymentsByStudentMonth,
    paymentsByPayDateMonth: paymentsByPayDateMonth,
    vacationsByStudent: vacationsByStudent, teacherChangesByStudent: teacherChangesByStudent,
    teacherLookup: teacherLookup
  };
  try {
    Object.defineProperty(context, "__monthlySnapshotPrepared", {
      value: prepared, configurable: true, enumerable: false, writable: true
    });
  } catch (ignoredPreparedPropertyError) {
    context.__monthlySnapshotPrepared = prepared;
  }
  return prepared;
}

/** 서버 내부 전용 월별 스냅샷. 학생·수납 원문을 포함하므로 브라우저 공개 함수로 두지 않습니다. */
function MonthlySnapshot_build_(targetYm, context) {
  targetYm = requireMonthString_(targetYm, "조회 월");
  context = context || DataRepository_loadContext_([
    SHEET_NAMES.STUDENTS, SHEET_NAMES.PAYMENTS, SHEET_NAMES.VACATIONS, SHEET_NAMES.LOGS
  ], { required: false });

  var monthStart = DateMoney_parseMonthStart(targetYm);
  var monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
  monthStart.setHours(0, 0, 0, 0);
  monthEnd.setHours(0, 0, 0, 0);
  var billingDays = DateMoney_billingDays(monthStart.getFullYear(), monthStart.getMonth() + 1);
  var asOfDate = getAsOfDateForMonth_(targetYm);
  var currentAsOfDate = new Date(); currentAsOfDate.setHours(23, 59, 59, 999);
  var prepared = MonthlySnapshot_prepareContext_(context);
  var studentRows = prepared.studentRows;
  var paymentRows = prepared.paymentRows;
  var vacationRows = prepared.vacationRows;
  var logRows = prepared.logRows;
  var histories = prepared.histories;
  var paymentsByStudentMonth = prepared.paymentsByStudentMonth;
  var paymentsByPayDateMonth = prepared.paymentsByPayDateMonth;
  var vacationsByStudent = prepared.vacationsByStudent;
  var teacherChangesByStudent = prepared.teacherChangesByStudent;
  var teacherLookup = prepared.teacherLookup;
  var allowPersistentStore = context.__dataRepositoryFullContext === true && !context.__monthlySnapshotPartial;
  var forcePersistentForDiagnostics = context.__monthlySnapshotForceRead === true;
  var persistentRead = MonthlySnapshotStore_read_(targetYm, prepared, allowPersistentStore, forcePersistentForDiagnostics);
  var persistentFacts = persistentRead.facts;
  var timelineOptions = { teacherIdByName: teacherLookup.idByName };
  var specialPaymentsByStudent = {};
  var specialOnlyPaymentByStudent = {};
  var proratedTuitionAmountByStudent = {};
  var tuitionReceivedAmountByStudent = {};
  Object.keys(paymentsByStudentMonth).forEach(function(studentId) {
    ((paymentsByStudentMonth[studentId] || {})[targetYm] || []).forEach(function(payment) {
      if (payment.amount > 0) {
      if (!isTuitionPaymentType_(payment.type)) {
        if (!specialPaymentsByStudent[studentId]) specialPaymentsByStudent[studentId] = [];
          specialPaymentsByStudent[studentId].push({ type: payment.type, amount: payment.amount, date: payment.dateObject });
      } else {
        tuitionReceivedAmountByStudent[studentId] =
          (tuitionReceivedAmountByStudent[studentId] || 0) + payment.amount;
        if (payment.calcType === "PRORATED" || payment.memo.indexOf("[일할]") !== -1) {
          // 기존 소비자 호환용 일할 수납 합계도 계속 제공합니다.
          proratedTuitionAmountByStudent[studentId] =
            (proratedTuitionAmountByStudent[studentId] || 0) + payment.amount;
        }
      }
      }
    });
    if (specialPaymentsByStudent[studentId] && specialPaymentsByStudent[studentId].some(function(payment) { return payment.type === "특강비"; }) &&
        !Object.prototype.hasOwnProperty.call(tuitionReceivedAmountByStudent, studentId)) {
      specialOnlyPaymentByStudent[studentId] = true;
    }
  });

  var students = [];
  var studentsById = {};
  var teachers = {};
  var teachersInMonth = {};
  for (var s = 1; s < studentRows.length; s++) {
    var row = studentRows[s];
    var id = String(row[IDX.STUDENT.ID] || "").trim();
    if (!id) continue;
    var storedFact = persistentFacts && persistentFacts[id];
    if (storedFact) {
      var storedCurrentState = resolveStudentStateAtDate_(row, histories, currentAsOfDate, timelineOptions);
      var storedStudent = {
        row:row, rowNumber:s + 1, id:id,
        name:String(row[IDX.STUDENT.NAME] || ""), grade:row[IDX.STUDENT.GRADE],
        state:storedFact.state, currentState:storedCurrentState,
        firstDate:storedFact.firstDate, exitDate:storedFact.exitDate,
        excludedByEarlyExit:storedFact.excludedByEarlyExit, inMonth:storedFact.inMonth,
        validStart:storedFact.validStart, validEnd:storedFact.validEnd,
        activeDays:storedFact.activeDays, vacationDays:storedFact.vacationDays,
        retirementGapDays:storedFact.retirementGapDays, absenceDays:storedFact.absenceDays,
        teacherOwnerships:storedFact.teacherOwnerships,
        baseFee:storedFact.baseFee, siblingDiscount:storedFact.siblingDiscount,
        billableFee:storedFact.billableFee, courseMode:storedFact.courseMode, specialOnly:storedFact.specialOnly,
        paymentsByMonth:paymentsByStudentMonth[id] || {}, vacations:vacationsByStudent[id] || []
      };
      students.push(storedStudent);
      studentsById[id] = storedStudent;
      if (storedStudent.state.teacher) teachers[storedStudent.state.teacher] = true;
      if (storedStudent.inMonth && storedStudent.validStart && storedStudent.validEnd) {
        storedStudent.teacherOwnerships.forEach(function(ownership) {
          var overlapStart = ownership.start > storedStudent.validStart ? ownership.start : storedStudent.validStart;
          var overlapEnd = ownership.end < storedStudent.validEnd ? ownership.end : storedStudent.validEnd;
          if (ownership.teacher && overlapStart <= overlapEnd) teachersInMonth[ownership.teacher] = true;
        });
      }
      continue;
    }
    var state = resolveStudentStateAtDate_(row, histories, asOfDate, timelineOptions);
    var currentState = resolveStudentStateAtDate_(row, histories, currentAsOfDate, timelineOptions);
    var firstDate = MonthlySnapshot_parseDate_(row[IDX.STUDENT.FIRST_DATE]);
    var exitDate = MonthlySnapshot_resolveExitDate_(row, histories, asOfDate, state);
    var excludedByEarlyExit = MonthlySnapshot_isEarlyExit_(state.status, firstDate, exitDate, monthStart);
    var validStart = firstDate && firstDate > monthStart ? new Date(firstDate) : new Date(monthStart);
    var validEnd = exitDate && exitDate < monthEnd ? new Date(exitDate) : new Date(monthEnd);
    var baseInMonth = !!firstDate && firstDate <= monthEnd && (!exitDate || exitDate >= monthStart) &&
      !excludedByEarlyExit && validStart <= validEnd;
    var siblingDiscount = Number(state.siblingDiscount) || 0;
    var courseMode = normalizeStudentCourseMode_(state.courseMode);
    var specialOnly = isSpecialOnlyCourseMode_(courseMode);
    var billableFee = specialOnly ? 0 : PaymentDomain_adjustMonthlyFee(state.fee, siblingDiscount, 0);
    var absenceDates = {};
    var vacationDates = {};
    var retirementGapDates = {};
    if (baseInMonth) {
      (vacationsByStudent[id] || []).forEach(function(vacation) {
        var overlapStart = vacation.start > validStart ? vacation.start : validStart;
        var overlapEnd = vacation.end < validEnd ? vacation.end : validEnd;
        for (var day = new Date(overlapStart); day <= overlapEnd; day.setDate(day.getDate() + 1)) {
          absenceDates[day.getTime()] = true;
          if (vacation.periodType === VACATION_PERIOD_TYPES.RETIREMENT_GAP) retirementGapDates[day.getTime()] = true;
          else vacationDates[day.getTime()] = true;
        }
      });
    }
    var vacationDays = Object.keys(vacationDates).length;
    var retirementGapDays = Object.keys(retirementGapDates).length;
    var absenceDays = Object.keys(absenceDates).length;
    var possibleCalendarDays = baseInMonth ? inclusiveCalendarDays_(validStart, validEnd) : 0;
    var inMonth = baseInMonth && retirementGapDays < possibleCalendarDays;
    var activeDays = baseInMonth ? Math.max(0, possibleCalendarDays - absenceDays) : 0;
    // 2월 기준일수는 운영설정(28~31일)을 따릅니다. 실제 월말까지 재원하고
    // 출석 가능한 경우에만 달력 일수와 기준일수의 차이를 보정합니다.
    if (baseInMonth && monthStart.getMonth() === 1 && validEnd.getTime() === monthEnd.getTime() &&
        !absenceDates[monthEnd.getTime()]) {
      activeDays += billingDays - monthEnd.getDate();
    }
    var teacherOwnerships = MonthlySnapshot_buildTeacherOwnerships_(row, histories, teacherLookup.idByName);
    if (inMonth) {
      teacherOwnerships.forEach(function(ownership) {
        var overlapStart = ownership.start > validStart ? ownership.start : validStart;
        var overlapEnd = ownership.end < validEnd ? ownership.end : validEnd;
        if (ownership.teacher && overlapStart <= overlapEnd) teachersInMonth[ownership.teacher] = true;
      });
    }
    var student = {
      row: row, rowNumber: s + 1, id: id,
      name: String(row[IDX.STUDENT.NAME] || ""), grade: row[IDX.STUDENT.GRADE],
      state: state, currentState: currentState,
      firstDate: firstDate, exitDate: exitDate,
      excludedByEarlyExit: excludedByEarlyExit, inMonth: inMonth,
      validStart: validStart, validEnd: validEnd,
      activeDays: activeDays, vacationDays: vacationDays,
      retirementGapDays: retirementGapDays, absenceDays: absenceDays,
      teacherOwnerships: teacherOwnerships,
      baseFee: state.fee, siblingDiscount: siblingDiscount, billableFee: billableFee,
      courseMode: courseMode, specialOnly: specialOnly,
      paymentsByMonth: paymentsByStudentMonth[id] || {}, vacations: vacationsByStudent[id] || []
    };
    students.push(student);
    studentsById[id] = student;
    if (state.teacher) teachers[state.teacher] = true;
  }

  var persistentWriteStatus = persistentFacts ? "not_needed" :
    MonthlySnapshotStore_write_(targetYm, students, allowPersistentStore, persistentRead.sourceVersion, forcePersistentForDiagnostics);
  return {
    targetYm: targetYm, monthStart: monthStart, monthEnd: monthEnd, billingDays: billingDays,
    asOfDate: asOfDate, histories: histories,
    teacherIdByName: teacherLookup.idByName,
    students: students, studentsById: studentsById,
    studentRows: studentRows, paymentRows: paymentRows, vacationRows: vacationRows, logRows: logRows,
    paymentsByStudentMonth: paymentsByStudentMonth,
    paymentsByPayDateMonth: paymentsByPayDateMonth,
    vacationsByStudent: vacationsByStudent,
    specialPaymentsByStudent: specialPaymentsByStudent,
    specialOnlyPaymentByStudent: specialOnlyPaymentByStudent,
    tuitionReceivedAmountByStudent: tuitionReceivedAmountByStudent,
    proratedTuitionAmountByStudent: proratedTuitionAmountByStudent,
    teacherChangesByStudent: teacherChangesByStudent,
    teachers: Object.keys(teachers).sort(), teachersInMonth: Object.keys(teachersInMonth).sort(),
    persistentSnapshotStatus:persistentFacts ? persistentRead.status : persistentWriteStatus
  };
}

function MonthlySnapshot_getPaymentEntries_(snapshot, studentId, targetYm) {
  return (((snapshot.paymentsByStudentMonth || {})[String(studentId)] || {})[targetYm] || []).slice();
}

function MonthlySnapshot_getVacationEntries_(snapshot, studentId, targetYm) {
  var monthStart = DateMoney_parseMonthStart(targetYm);
  var monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
  return ((snapshot.vacationsByStudent || {})[String(studentId)] || []).filter(function(vacation) {
    return vacation.start <= monthEnd && vacation.end >= monthStart;
  }).map(function(vacation) {
    var isRetirementGap = vacation.periodType === VACATION_PERIOD_TYPES.RETIREMENT_GAP;
    return {
      payId: "VAC-" + vacation.id,
      date: fastFormatDate(vacation.start, "MM-dd") + "~" + fastFormatDate(vacation.end, "MM-dd"),
      fullDate: fastFormatDate(vacation.start, "yyyy-MM-dd"), month: targetYm,
      amount: 0,
      method: isRetirementGap ? "퇴원공백" : "기간휴원",
      memo: vacation.reason || (isRetirementGap ? "퇴원 후 복귀 전 공백" : "등록된 휴가"),
      type: isRetirementGap ? "퇴원공백" : "휴원",
      periodType: vacation.periodType,
      isVirtual: true
    };
  });
}

function MonthlySnapshot_getDisplayEntries_(snapshot, studentId, targetYm) {
  return MonthlySnapshot_getPaymentEntries_(snapshot, studentId, targetYm)
    .concat(MonthlySnapshot_getVacationEntries_(snapshot, studentId, targetYm));
}

function MonthlySnapshot_buildPaymentSummary_(snapshot, targetYm) {
  var result = {};
  Object.keys(snapshot.paymentsByStudentMonth || {}).forEach(function(studentId) {
    MonthlySnapshot_getPaymentEntries_(snapshot, studentId, targetYm).forEach(function(payment) {
      if (payment.amount <= 0) return;
      if (!result[studentId]) result[studentId] = { dates: [], methods: [], total: 0 };
      var dateText = payment.dateObject ? (payment.dateObject.getMonth() + 1) + "/" + payment.dateObject.getDate() : "";
      if (dateText && result[studentId].dates.indexOf(dateText) === -1) result[studentId].dates.push(dateText);
      if (payment.method && result[studentId].methods.indexOf(payment.method) === -1) result[studentId].methods.push(payment.method);
      result[studentId].total += payment.amount;
    });
  });
  return result;
}
