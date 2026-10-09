/**
 * 💾 [수납 등록] 일괄 저장 함수 (최종: 캐시 즉시 갱신 포함)
 */
function PaymentLifecycle_buildAuditMemo_(message, baseDayUpdates, requestFingerprint) {
  return JSON.stringify({
    message: String(message || ""),
    baseDayUpdates: baseDayUpdates || {},
    requestFingerprint: String(requestFingerprint || "")
  });
}

/** 멱등 재시도 비교에 쓰는 수납 업무 내용을 서버 규칙으로 정규화합니다. */
function PaymentLifecycle_normalizeRequestForRetry_(paymentData) {
  paymentData = paymentData || {};
  var payDate = requireDateString_(paymentData.payDate, "납부일");
  var payMethod = requirePaymentMethod_(paymentData.payMethod);
  var targets = paymentData.payments && paymentData.payments.length
    ? paymentData.payments
    : [{ studentId:paymentData.studentId, items:paymentData.items || [], newBaseDay:paymentData.newBaseDay }];
  if (!targets.length) throw new Error("저장할 수납 대상이 없습니다.");
  return {
    payDate:payDate,
    payMethod:payMethod,
    payments:targets.map(function(target) {
      var studentId = requireText_(target.studentId, "학생 ID", 100);
      var items = target.items || [];
      if (!Array.isArray(items) || !items.length) throw new Error("수납 항목이 없습니다: " + studentId);
      var rawNewBaseDay = target.newBaseDay !== "" && target.newBaseDay != null
        ? target.newBaseDay : paymentData.newBaseDay;
      var newBaseDay = rawNewBaseDay === "" || rawNewBaseDay == null ? ""
        : requireNumberInRange_(rawNewBaseDay, "변경할 수납 기준일", 1, 31);
      return {
        studentId:studentId,
        newBaseDay:newBaseDay,
        items:items.map(function(item) {
          var calcType = optionalText_(item.calcType, 30) || "STANDARD";
          if (["STANDARD", "PRORATED"].indexOf(calcType) === -1) throw new Error("지원하지 않는 수납 계산 유형입니다.");
          var normalized = {
            month:requireMonthString_(item.month, "귀속월"),
            type:normalizePaymentType_(requireText_(item.type, "수납 항목", 30)),
            amount:requireMoney_(item.amount, "수납 금액", 0, 100000000),
            memo:safeSheetText_(item.memo, 500),
            calcType:calcType,
            calcStart:item.calcStart ? requireDateString_(item.calcStart, "일할 시작일") : "",
            calcEnd:item.calcEnd ? requireDateString_(item.calcEnd, "일할 종료일") : "",
            activeDays:item.activeDays === "" || item.activeDays == null ? "" : requireNumberInRange_(item.activeDays, "적용 일수", 0, 366),
            billingDays:item.billingDays === "" || item.billingDays == null ? "" : requireNumberInRange_(item.billingDays, "기준 일수", 1, 366),
            vacationApplied:item.vacationApplied === true,
            siblingDiscount:requireMoney_(item.siblingDiscount || 0, "형제 할인", 0, 100000000),
            otherDiscount:requireMoney_(item.otherDiscount || 0, "기타 할인", 0, 100000000)
          };
          if (normalized.calcType === "PRORATED" && (!normalized.calcStart || !normalized.calcEnd ||
              normalized.activeDays === "" || normalized.billingDays === "")) {
            throw new Error("일할 수납의 계산 기간과 적용 일수가 비어 있습니다. 다시 계산해주세요.");
          }
          return normalized;
        })
      };
    })
  };
}

function PaymentLifecycle_requestFingerprint_(normalizedRequest) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, JSON.stringify(normalizedRequest || {}), Utilities.Charset.UTF_8
  )).replace(/=+$/, "");
}

function PaymentLifecycle_legacyRetryEntries_(normalizedRequest) {
  var entries = [];
  (normalizedRequest.payments || []).forEach(function(payment) {
    (payment.items || []).forEach(function(item) {
      entries.push(JSON.stringify({
        studentId:payment.studentId, payDate:normalizedRequest.payDate,
        month:item.month, type:item.type, amount:item.amount, method:normalizedRequest.payMethod,
        memo:item.memo, calcType:item.calcType, calcStart:item.calcStart, calcEnd:item.calcEnd,
        activeDays:item.activeDays, billingDays:item.billingDays,
        siblingDiscount:item.siblingDiscount, otherDiscount:item.otherDiscount
      }));
    });
  });
  return entries.sort();
}

function PaymentLifecycle_legacyCompletedEntries_(completed) {
  return (completed && completed.savedRows || []).map(function(row) {
    return JSON.stringify({
      studentId:String(row.studentId || ""), payDate:String(row.fullDate || ""),
      month:String(row.month || ""), type:normalizePaymentType_(row.type), amount:Number(row.amount) || 0,
      method:String(row.method || ""), memo:String(row.memo || ""),
      calcType:String(row.calcType || "STANDARD"), calcStart:String(row.calcStart || ""), calcEnd:String(row.calcEnd || ""),
      activeDays:row.activeDays === "" || row.activeDays == null ? "" : Number(row.activeDays),
      billingDays:row.billingDays === "" || row.billingDays == null ? "" : Number(row.billingDays),
      siblingDiscount:Number(row.siblingDiscount) || 0, otherDiscount:Number(row.otherDiscount) || 0
    });
  }).sort();
}

function PaymentLifecycle_assertSameCompletedRequest_(completed, normalizedRequest, requestFingerprint) {
  if (!PaymentLifecycle_hasComparableCompletion_(completed)) {
    throw new Error("이 요청의 수납 완료 표식은 있지만 내용을 비교할 기록이 부족해 재시도를 중단했습니다. " +
      "최고 원장이 수납 내역·휴지통·변경 이력을 확인해야 합니다. 확인 전에는 새 요청으로 다시 등록하지 마세요.");
  }
  var storedFingerprint = String(completed && completed.requestFingerprint || "");
  var same = storedFingerprint
    ? storedFingerprint === String(requestFingerprint || "")
    : JSON.stringify(PaymentLifecycle_legacyCompletedEntries_(completed)) ===
      JSON.stringify(PaymentLifecycle_legacyRetryEntries_(normalizedRequest));
  if (!same) {
    throw new Error("같은 요청 ID로 이전과 다른 수납 내용이 전송되었습니다. 화면을 닫고 다시 열어 새 요청으로 저장해주세요.");
  }
  return completed;
}

function PaymentLifecycle_hasComparableCompletion_(completed) {
  return !!(completed && typeof completed === "object" &&
    (completed.requestFingerprint || (Array.isArray(completed.savedRows) && completed.savedRows.length)));
}

/** 이미 시작된 변경 트랜잭션 안에서도 재사용할 수 있는 수납 생성 본체입니다. */
function PaymentLifecycle_createBatchInTransaction_(paymentData, tx, options) {
  paymentData = paymentData || {};
  options = options || {};
  var startedAt = Date.now();
  var requestId = requireText_(paymentData.requestId, "요청 ID", 120);
  var normalizedRequest = PaymentLifecycle_normalizeRequestForRetry_(paymentData);
  var requestFingerprint = PaymentLifecycle_requestFingerprint_(normalizedRequest);
  if (!options.skipCompletedCheck) {
    var completedRequest = getCompletedRequest_(requestId);
    if (PaymentLifecycle_hasComparableCompletion_(completedRequest)) {
      return PaymentLifecycle_assertSameCompletedRequest_(completedRequest, normalizedRequest, requestFingerprint);
    }
    var persistentRequest = Mutation_findCompletedRequest_(requestId);
    if (persistentRequest) return PaymentLifecycle_assertSameCompletedRequest_(persistentRequest, normalizedRequest, requestFingerprint);
    if (completedRequest) return PaymentLifecycle_assertSameCompletedRequest_(completedRequest, normalizedRequest, requestFingerprint);
  }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var dbSheet = ss.getSheetByName(SHEET_NAMES.PAYMENTS);
    var listSheet = ss.getSheetByName(SHEET_NAMES.STUDENTS);
    if (!dbSheet) throw new Error("DB_수납 시트를 찾을 수 없습니다.");
    if (!listSheet) throw new Error("학생 명단 시트를 찾을 수 없습니다.");
    PaymentDomain_ensurePaymentSchema_(dbSheet, tx);
    PaymentDomain_ensureStudentDiscountSchema_(listSheet, tx);
    var payDate = requireDateString_(paymentData.payDate, "납부일");
    var payMethod = requirePaymentMethod_(paymentData.payMethod);
    var timestamp = new Date();
    var targets = paymentData.payments && paymentData.payments.length
      ? paymentData.payments
      : [{
          studentId: paymentData.studentId, studentName: paymentData.studentName,
          items: paymentData.items || [], newBaseDay: paymentData.newBaseDay
        }];
    var targetStudentIds = targets.map(function(target) {
      return requireText_(target.studentId, "학생 ID", 100);
    });
    var studentRecords = LookupIndex_findRowsForValues_(SHEET_NAMES.STUDENTS, COL.STUDENT.ID, targetStudentIds, false);
    var foundStudentIds = {};
    studentRecords.forEach(function(item) { foundStudentIds[String(item.row[IDX.STUDENT.ID] || "").trim()] = true; });
    if (targetStudentIds.some(function(id) { return !foundStudentIds[id]; })) {
      studentRecords = LookupIndex_findRowsForValues_(SHEET_NAMES.STUDENTS, COL.STUDENT.ID, targetStudentIds, true);
    }
    var histories = buildStudentChangeHistory_(EventRepository_getLegacyRowsForStudents_(targetStudentIds));
    var targetDataLoadedAt = Date.now();
    var asOfDate = new Date(); asOfDate.setHours(23, 59, 59, 999);
    var activeStudents = {};
    var activeStudentRecords = {};
    for (var s = 0; s < studentRecords.length; s++) {
      var studentRecord = studentRecords[s];
      if (resolveStudentStateAtDate_(studentRecord.row, histories, asOfDate).status === "재원") {
        var activeStudentId = String(studentRecord.row[IDX.STUDENT.ID] || "").trim();
        activeStudents[activeStudentId] = studentRecord.row;
        activeStudentRecords[activeStudentId] = studentRecord;
      }
    }

    var newRows = [];
    var savedRows = [];
    var paymentIdsByStudent = {};
    targets.forEach(function(target) {
      var studentId = requireText_(target.studentId, "학생 ID", 100);
      var studentRow = activeStudents[studentId];
      if (!studentRow) throw new Error("재원 학생 정보를 확인할 수 없습니다: " + studentId);
      var studentName = String(studentRow[IDX.STUDENT.NAME] || "").trim();
      var items = target.items || [];
      if (!Array.isArray(items) || !items.length) throw new Error(studentName + " 학생의 수납 항목이 없습니다.");
      items.forEach(function(item) {
        var payId = createUniqueId_("PAY");
        if (!paymentIdsByStudent[studentId]) paymentIdsByStudent[studentId] = [];
        paymentIdsByStudent[studentId].push(payId);
        var month = requireMonthString_(item.month, "귀속월");
        var type = normalizePaymentType_(requireText_(item.type, "수납 항목", 30));
        var amount = requireMoney_(item.amount, "수납 금액", 0, 100000000);
        var memo = safeSheetText_(item.memo, 500);
        var calcType = optionalText_(item.calcType, 30) || "STANDARD";
        if (["STANDARD", "PRORATED"].indexOf(calcType) === -1) throw new Error("지원하지 않는 수납 계산 유형입니다.");
        var calcStart = item.calcStart ? requireDateString_(item.calcStart, "일할 시작일") : "";
        var calcEnd = item.calcEnd ? requireDateString_(item.calcEnd, "일할 종료일") : "";
        var activeDays = item.activeDays === "" || item.activeDays == null ? "" :
          requireNumberInRange_(item.activeDays, "적용 일수", 0, 366);
        var billingDays = item.billingDays === "" || item.billingDays == null ? "" :
          requireNumberInRange_(item.billingDays, "기준 일수", 1, 366);
        var vacationApplied = item.vacationApplied === true;
        if (calcType === "PRORATED" && (!calcStart || !calcEnd || activeDays === "" || billingDays === "")) {
          throw new Error("일할 수납의 계산 기간과 적용 일수가 비어 있습니다. 다시 계산해주세요.");
        }
        var siblingDiscount = requireMoney_(item.siblingDiscount || 0, "형제 할인", 0, 100000000);
        var otherDiscount = requireMoney_(item.otherDiscount || 0, "기타 할인", 0, 100000000);
        var prorationDifference = null;
        if (calcType === "PRORATED") {
          if (month !== calcStart.substring(0, 7) || month !== calcEnd.substring(0, 7)) {
            throw new Error("일할 계산 기간과 귀속월이 다릅니다. 다시 계산해주세요.");
          }
          var monthEnd = parseDateOnly_(month + "-" + String(new Date(Number(month.substring(0,4)), Number(month.substring(5,7)), 0).getDate()).padStart(2, "0"));
          var monthState = resolveStudentStateAtDate_(studentRow, histories, monthEnd);
          var baseFee = requireMoney_(monthState.fee, "해당 월 수강료", 0, 100000000);
          var adjustedFee = PaymentDomain_adjustMonthlyFee(baseFee, siblingDiscount, otherDiscount);
          var verifiedCalculation = PaymentDomain_calculateProratedPeriod_(
            adjustedFee, parseDateOnly_(calcStart), parseDateOnly_(calcEnd),
            vacationApplied ? PaymentDomain_getStudentVacations_(studentId) : []
          );
          if (activeDays !== verifiedCalculation.activeDays || billingDays !== verifiedCalculation.billingDays) {
            throw new Error(studentName + " 학생의 일할 날짜·휴가·적용일수가 최신 정보와 다릅니다. 화면에서 다시 계산해주세요.");
          }
          prorationDifference = PaymentDomain_prorationDifference_(amount, verifiedCalculation.amount);
          if (prorationDifference.exceeds) {
            var differenceLabel = isFinite(prorationDifference.percent) ? prorationDifference.percent.toFixed(1) + "%" : "계산 불가";
            throw new Error(studentName + " 학생의 일할 입력액이 서버 계산액과 " + differenceLabel + " 차이납니다. " +
              "계산액 " + verifiedCalculation.amount.toLocaleString() + "원 / 입력액 " + amount.toLocaleString() +
              "원입니다. 금액을 확인해주세요.");
          }
        }
        var payDateObject = parseDateOnly_(payDate);
        newRows.push([
          payId, timestamp, payDate, studentId, safeSheetText_(studentName, 40),
          month, safeSheetText_(type, 30), "", amount, safeSheetText_(payMethod, 30),
          "", "", memo, requestId, "", "ACTIVE", calcType, calcStart, calcEnd,
          activeDays, billingDays, siblingDiscount, otherDiscount
        ]);
        savedRows.push({
          payId: payId, studentId: studentId, studentName: studentName,
          date: fastFormatDate(payDateObject, "MM-dd"), fullDate: fastFormatDate(payDateObject, "yyyy-MM-dd"),
          month: month, type: type, amount: amount, method: payMethod, memo: memo,
          calcType: calcType, calcStart: calcStart, calcEnd: calcEnd,
          activeDays: activeDays, billingDays: billingDays,
          vacationApplied: vacationApplied,
          calculatedAmount:prorationDifference ? prorationDifference.calculatedAmount : amount,
          prorationDifference:prorationDifference ? prorationDifference.difference : 0,
          prorationDifferencePercent:prorationDifference ? prorationDifference.percent : 0,
          siblingDiscount: siblingDiscount, otherDiscount: otherDiscount
        });
      });
    });
    if (!newRows.length) throw new Error("저장할 수납 항목이 없습니다.");
    tx.appendRows(dbSheet, newRows);

    var baseDayUpdates = {};
    var baseDayTargets = {};
    targets.forEach(function(target) {
      var rawNewBaseDay = target.newBaseDay !== "" && target.newBaseDay != null
        ? target.newBaseDay : paymentData.newBaseDay;
      if (rawNewBaseDay !== "" && rawNewBaseDay != null) {
        baseDayTargets[String(target.studentId)] =
          requireNumberInRange_(rawNewBaseDay, "변경할 수납 기준일", 1, 31);
      }
    });
    Object.keys(baseDayTargets).forEach(function(targetStudentId) {
      var targetRecord = activeStudentRecords[targetStudentId];
      if (!targetRecord) throw new Error("재원 학생 정보를 확인할 수 없습니다: " + targetStudentId);
      var oldBaseDay = targetRecord.row[IDX.STUDENT.BASE_DAY];
      var newBaseDay = baseDayTargets[targetStudentId];
      if (String(oldBaseDay) === String(newBaseDay)) return;
      tx.writeRange(listSheet, targetRecord.rowNumber, COL.STUDENT.BASE_DAY, [[newBaseDay]]);
      baseDayUpdates[targetStudentId] = newBaseDay;
      tx.queueEvent({
        eventType: "수납기준일변경", targetType: "학생", targetId: targetStudentId,
        studentId: targetStudentId, field: "수납 기준일",
        before: String(oldBaseDay), after: String(newBaseDay), effectiveDate: payDate,
        requestId: requestId, groupId: requestId,
        refId: (paymentIdsByStudent[targetStudentId] || []).join(","),
        memo: "일할 수납에 따른 기준일 자동변경"
      });
    });

    var message = "✅ 저장 완료 (" + newRows.length + "건)";
    if (targets.length > 1) message += "\n(가족 " + targets.length + "명 일괄 수납)";
    if (Object.keys(baseDayUpdates).length) message += "\n(기준일 변경 반영됨)";
    var response = paymentData.returnSavedRows
      ? { message: message, savedRows: savedRows, baseDayUpdates: baseDayUpdates, requestFingerprint:requestFingerprint }
      : message;
    tx.queueEvent({
      eventType: "수납일괄등록", targetType: "수납그룹", targetId: requestId,
      field: "수납등록", before: "", after: newRows.length + "건", effectiveDate: payDate,
      requestId: requestId, groupId: requestId,
      refId: savedRows.map(function(row) { return row.payId; }).join(","),
      memo: PaymentLifecycle_buildAuditMemo_(message, baseDayUpdates, requestFingerprint)
    });
    savedRows.forEach(function(row) {
      if (String(row.calcType || "") !== "PRORATED") return;
      tx.queueEvent({
        eventType: "일할수납등록", targetType: "수납", targetId: row.payId, studentId: row.studentId,
        field: "일할 계산", before: "", after: JSON.stringify({
          amount: row.amount, startDate: row.calcStart, endDate: row.calcEnd,
          activeDays: row.activeDays, billingDays: row.billingDays,
          vacationApplied:row.vacationApplied === true,
          calculatedAmount:row.calculatedAmount,
          enteredAmount:row.amount,
          amountDifference:row.prorationDifference,
          amountDifferencePercent:isFinite(row.prorationDifferencePercent) ? Number(row.prorationDifferencePercent.toFixed(2)) : null,
          warningPercent:PaymentDomain_prorationWarningPercent_()
        }),
        effectiveDate: payDate, requestId: requestId, groupId: requestId,
        refId: row.payId, memo: row.memo
      });
    });
    tx.invalidateMonths(savedRows.map(function(row) { return row.month; }).concat([payDate.substring(0, 7)]));
    if (Object.keys(baseDayUpdates).length) tx.invalidateAllMonths();
    tx.invalidate([SHEET_NAMES.PAYMENTS, SHEET_NAMES.STUDENTS, SHEET_NAMES.EVENTS]);
    console.log("[수납 저장 성능] " + JSON.stringify({
      targetStudents:targetStudentIds.length, paymentRows:newRows.length,
      targetLoadMs:targetDataLoadedAt - startedAt, transactionBodyMs:Date.now() - startedAt
    }));
  return response;
}

/** 신규 수납 생성도 수정·삭제와 같은 잠금/롤백/이벤트/캐시 파이프라인을 사용합니다. */
function PaymentLifecycle_createBatchWithPipeline_(paymentData) {
  paymentData = paymentData || {};
  var requestId = requireText_(paymentData.requestId, "요청 ID", 120);
  var result = MutationPipeline_run_({ operation: "수납일괄등록" }, function(tx) {
    return PaymentLifecycle_createBatchInTransaction_(paymentData, tx);
  });
  markRequestCompleted_(requestId, result);
  return result;
}
