/**
 * 수납 레코드의 생성, 수정, 휴지통 이동, 복구, 영구 정리를 잇는 공통 진입점입니다.
 * 공개 함수명은 기존 HTML 및 설치된 트리거와의 호환성을 유지합니다.
 */

function PaymentLifecycle_managerChildRequestId_(batchRequestId, paymentIndex, itemIndex) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    String(batchRequestId || "") + "|" + Number(paymentIndex || 0) + "|" + Number(itemIndex || 0));
  return "PAYREQ-DASH-" + Utilities.base64EncodeWebSafe(digest).replace(/=+$/, "").substring(0, 48);
}

function processPaymentBatch(paymentData) {
  var startedAt = Date.now();
  var user = requireAuthorizedUser_();
  if (ChangeRequest_isManager_(user)) {
    AccessControl_requireStudentDataAccess_(user);
    paymentData = paymentData || {};
    var batchRequestId = requireText_(paymentData.requestId, "수납 묶음 요청 ID", 120);
    var requestItems = [];
    (paymentData.payments || []).forEach(function(payment, paymentIndex) {
      (payment.items || []).forEach(function(item, itemIndex) {
        requestItems.push({
          // 같은 저장 시도를 다시 보내도 이미 처리한 항목은 중복 생성하지 않고 이어서 완료합니다.
          requestId:PaymentLifecycle_managerChildRequestId_(batchRequestId, paymentIndex, itemIndex), studentId:payment.studentId,
          payDate:paymentData.payDate, month:item.month, itemType:item.type, amount:item.amount,
          method:paymentData.payMethod, memo:item.memo, reason:"수납 대시보드 승인 요청",
          attachments:Array.isArray(paymentData.attachments) ? paymentData.attachments : [],
          calcType:item.calcType, calcStart:item.calcStart, calcEnd:item.calcEnd,
          activeDays:item.activeDays, billingDays:item.billingDays,
          vacationApplied:item.vacationApplied === true,
          siblingDiscount:item.siblingDiscount, otherDiscount:item.otherDiscount
        });
      });
    });
    var requested = ManagerPaymentRequest_submitBatch_(requestItems, user);
    var requestPerformance = requested[0] && requested[0].performance || {};
    var affectedStudentIds = [];
    var affectedStudentMap = {};
    requestItems.forEach(function(item) {
      var studentId = String(item.studentId || "");
      if (studentId && !affectedStudentMap[studentId]) {
        affectedStudentMap[studentId] = true;
        affectedStudentIds.push(studentId);
      }
    });
    return { requested:true, requestCount:requested.length, savedRows:[], affectedStudentIds:affectedStudentIds,
      performance:{ path:"APPROVAL_REQUEST", itemCount:requested.length,
        targetLoadMs:Number(requestPerformance.targetLoadMs) || 0,
        evidenceMs:Number(requestPerformance.evidenceMs) || 0,
        writeMs:Number(requestPerformance.writeMs) || 0,
        serverMs:Date.now() - startedAt },
      message:"수납 " + requested.length + "건을 최고 원장 승인 요청으로 등록했습니다." };
  }
  if (!user.bootstrap && user.role !== ACCESS_CONTROL.ROLES.SUPER_ADMIN) throw new Error("수납 저장 권한이 없습니다.");
  var result = PaymentLifecycle_createBatchWithPipeline_(paymentData);
  if (result && typeof result === "object") {
    result.performance = { path:"DIRECT_SAVE", itemCount:(result.savedRows || []).length, serverMs:Date.now() - startedAt };
  }
  console.log("[수납 저장 성능] " + JSON.stringify(result && result.performance || { path:"DIRECT_SAVE", serverMs:Date.now() - startedAt }));
  return result;
}

function PaymentLifecycle_findPayment_(sheet, payId) {
  var targetId = String(payId || "").trim();
  if (!sheet || !targetId) return null;
  var matches = LookupIndex_findRows_(SHEET_NAMES.PAYMENTS, COL.PAYMENT.ID, targetId);
  // 앱 밖에서 시트를 직접 수정한 직후에도 기존 수납을 놓치지 않도록, ID 조회 실패 때만 한 번 재생성합니다.
  if (!matches.length) matches = LookupIndex_findRows_(SHEET_NAMES.PAYMENTS, COL.PAYMENT.ID, targetId, true);
  if (!matches.length) return null;
  var valid = matches.filter(function(item) {
    return LookupIndex_normalizeKey_(item.row[IDX.PAYMENT.ID]) === LookupIndex_normalizeKey_(targetId);
  });
  if (!valid.length) return null;
  var found = valid[valid.length - 1];
  return { rowNumber: found.rowNumber, row: found.row };
}

function PaymentLifecycle_getTrashSheet_(tx) {
  return DataSchema_ensureSheet_(SHEET_NAMES.TRASH, tx).sheet;
}

function PaymentLifecycle_moveToTrash_(tx, paySheet, rowNumber, reason) {
  var user = requireAuthorizedUser_();
  var values = paySheet.getRange(rowNumber, 1, 1, paySheet.getLastColumn()).getValues()[0];
  var payId = String(values[IDX.PAYMENT.ID] || "").trim();
  if (!payId) throw new Error("휴지통으로 이동할 수납 ID가 없습니다.");

  var deletedAt = new Date();
  var purgeAt = Trash_addMonthsClamped_(deletedAt, 2);
  var trashId = createUniqueId_("TRASH");
  var deleteReason = safeSheetText_(reason || "사용자 삭제", 300);
  var trashSheet = PaymentLifecycle_getTrashSheet_(tx);

  tx.appendRows(trashSheet, [[
    trashId, deletedAt, purgeAt, SHEET_NAMES.PAYMENTS, payId,
    values[IDX.PAYMENT.STUDENT_ID], values[IDX.PAYMENT.STUDENT_NAME], user.email,
    deleteReason, Trash_serializeRow_(values), "보관중", "", ""
  ]]);
  tx.deleteRows(paySheet, rowNumber, 1);
  tx.queueEvent({
    eventType: "수납휴지통이동", targetType: "수납", targetId: payId,
    studentId: values[IDX.PAYMENT.STUDENT_ID], field: "삭제상태",
    before: "사용중", after: "휴지통", refId: trashId, memo: deleteReason
  });
  tx.invalidate([SHEET_NAMES.PAYMENTS, SHEET_NAMES.TRASH, SHEET_NAMES.EVENTS]);
  return { trashId: trashId, payId: payId, purgeAt: formatDateOnly_(purgeAt), row: values };
}

function PaymentLifecycle_revertBaseDay_(tx, targetName, targetId, targetPayId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var studentSheet = ss.getSheetByName(SHEET_NAMES.STUDENTS);
  if (!studentSheet) return null;

  var baseDayChange = EventRepository_findBaseDayChange_(targetId, targetPayId);
  if (!baseDayChange || baseDayChange.before == null || baseDayChange.before === "") return null;
  var oldBaseDay = baseDayChange.before;
  var changedBaseDay = baseDayChange.after;
  var linkedPayIds = baseDayChange.refIds;

  var paySheet = ss.getSheetByName(SHEET_NAMES.PAYMENTS);
  if (paySheet && linkedPayIds.length > 1) {
    var remaining = {};
    LookupIndex_findRowsForValues_(
      SHEET_NAMES.PAYMENTS, COL.PAYMENT.ID, linkedPayIds, false
    ).map(function(item) { return item.row; }).forEach(function(row) {
      remaining[String(row[IDX.PAYMENT.ID] || "")] = true;
    });
    if (linkedPayIds.some(function(id) { return id !== String(targetPayId) && remaining[id]; })) return null;
  }

  var studentMatches = LookupIndex_findRows_(SHEET_NAMES.STUDENTS, COL.STUDENT.ID, targetId, false);
  if (!studentMatches.length) {
    studentMatches = LookupIndex_findRows_(SHEET_NAMES.STUDENTS, COL.STUDENT.ID, targetId, true);
  }
  for (var s = 0; s < studentMatches.length; s++) {
    var studentRow = studentMatches[s].row;
    var currentBaseDay = studentRow[IDX.STUDENT.BASE_DAY];
    if (String(currentBaseDay) !== String(changedBaseDay)) return null;
    tx.writeRange(studentSheet, studentMatches[s].rowNumber, COL.STUDENT.BASE_DAY, [[oldBaseDay]]);
    tx.queueEvent({
      eventType: "기준일복구", targetType: "학생", targetId: String(targetId),
      studentId: String(targetId), field: "수강료기준일", before: currentBaseDay,
      after: oldBaseDay, refId: String(targetPayId), memo: "연결된 일할 수납 삭제"
    });
    tx.invalidate([SHEET_NAMES.STUDENTS, SHEET_NAMES.EVENTS]);
    return oldBaseDay;
  }
  return null;
}

function PaymentLifecycle_isProratedRow_(row) {
  return String((row || [])[IDX.PAYMENT.CALC_TYPE] || "") === "PRORATED" ||
    String((row || [])[IDX.PAYMENT.MEMO] || "").indexOf("[일할]") !== -1;
}

function PaymentLifecycle_prepareCalculationMetadata_(form) {
  var calcType = optionalText_(form.calcType, 30) || "STANDARD";
  if (["STANDARD", "PRORATED"].indexOf(calcType) === -1) throw new Error("지원하지 않는 수납 계산 유형입니다.");
  if (calcType !== "PRORATED") {
    return {
      calcType: "STANDARD", calcStart: "", calcEnd: "", activeDays: "", billingDays: "",
      vacationApplied:false,
      siblingDiscount: requireMoney_(form.siblingDiscount || 0, "형제 할인", 0, 100000000),
      otherDiscount: requireMoney_(form.otherDiscount || 0, "기타 할인", 0, 100000000),
      nextBaseDay: null
    };
  }
  var calcStart = requireDateString_(form.calcStart, "일할 시작일");
  var calcEnd = requireDateString_(form.calcEnd, "일할 종료일");
  var startDate = parseDateOnly_(calcStart);
  var endDate = parseDateOnly_(calcEnd);
  if (startDate > endDate) throw new Error("일할 종료일은 시작일보다 빠를 수 없습니다.");
  if (startDate.getFullYear() !== endDate.getFullYear() || startDate.getMonth() !== endDate.getMonth()) {
    throw new Error("일할 계산 기간은 같은 달 안에서 선택해주세요.");
  }
  var activeDays = requireNumberInRange_(form.activeDays, "적용 일수", 0, 366);
  var billingDays = requireNumberInRange_(form.billingDays, "기준 일수", 1, 366);
  var nextDate = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() + 1);
  return {
    calcType: calcType, calcStart: calcStart, calcEnd: calcEnd,
    activeDays: activeDays, billingDays: billingDays,
    vacationApplied:form.vacationApplied === true,
    siblingDiscount: requireMoney_(form.siblingDiscount || 0, "형제 할인", 0, 100000000),
    otherDiscount: requireMoney_(form.otherDiscount || 0, "기타 할인", 0, 100000000),
    nextBaseDay: nextDate.getDate()
  };
}

function PaymentLifecycle_replaceProratedBaseDay_(tx, paySheet, oldRow, targetPayId, calculation, effectiveDate) {
  var oldIsProrated = PaymentLifecycle_isProratedRow_(oldRow);
  var newIsProrated = calculation.calcType === "PRORATED";
  if (!oldIsProrated && !newIsProrated) return null;

  var studentId = String(oldRow[IDX.PAYMENT.STUDENT_ID] || "").trim();
  var baseDayChange = oldIsProrated ? EventRepository_findBaseDayChange_(studentId, targetPayId) : null;
  var linkedIds = baseDayChange ? baseDayChange.refIds : [];
  var otherLinkedProrated = false;
  if (linkedIds.length) {
    var payRows = LookupIndex_findRowsForValues_(
      SHEET_NAMES.PAYMENTS, COL.PAYMENT.ID, linkedIds, false
    ).map(function(item) { return item.row; });
    for (var p = 0; p < payRows.length; p++) {
      var linkedPayId = String(payRows[p][IDX.PAYMENT.ID] || "").trim();
      if (linkedPayId === String(targetPayId) || linkedIds.indexOf(linkedPayId) === -1) continue;
      if (PaymentLifecycle_isProratedRow_(payRows[p])) {
        otherLinkedProrated = true;
        break;
      }
    }
  }
  if (!newIsProrated && otherLinkedProrated) return null;

  var studentSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.STUDENTS);
  if (!studentSheet) throw new Error("학생 명단 시트를 찾을 수 없습니다.");
  var studentMatches = LookupIndex_findRows_(SHEET_NAMES.STUDENTS, COL.STUDENT.ID, studentId, false);
  if (!studentMatches.length) {
    studentMatches = LookupIndex_findRows_(SHEET_NAMES.STUDENTS, COL.STUDENT.ID, studentId, true);
  }
  for (var s = 0; s < studentMatches.length; s++) {
    var currentBaseDay = Number(studentMatches[s].row[IDX.STUDENT.BASE_DAY]) || 1;
    var lifecycleBaseDay = baseDayChange && baseDayChange.before !== ""
      ? Number(baseDayChange.before)
      : currentBaseDay;
    var expectedCurrentEffect = baseDayChange && baseDayChange.after !== ""
      ? Number(baseDayChange.after)
      : currentBaseDay;
    if (oldIsProrated && baseDayChange && currentBaseDay !== expectedCurrentEffect) {
      throw new Error("일할 수납 이후 수납 기준일이 별도로 변경되어 자동 교체할 수 없습니다. 현재 기준일을 확인해주세요.");
    }
    var desiredBaseDay = newIsProrated ? calculation.nextBaseDay : lifecycleBaseDay;
    if (currentBaseDay === desiredBaseDay) return desiredBaseDay;
      tx.writeRange(studentSheet, studentMatches[s].rowNumber, COL.STUDENT.BASE_DAY, [[desiredBaseDay]]);
    if (newIsProrated) {
      // 삭제 시 최초 기준일로 정확히 되돌릴 수 있도록 이 수납 행의 전체 효과를 다시 기록합니다.
      tx.queueEvent({
        eventType: "수납기준일재설정", targetType: "학생", targetId: studentId,
        studentId: studentId, field: "수납 기준일",
        before: lifecycleBaseDay, after: desiredBaseDay,
        effectiveDate: effectiveDate, refId: String(targetPayId),
        memo: "일할 수납 계산정보 수정"
      });
    } else {
      tx.queueEvent({
        eventType: "수납기준일원복", targetType: "학생", targetId: studentId,
        studentId: studentId, field: "일할 기준일 해제",
        before: currentBaseDay, after: desiredBaseDay,
        effectiveDate: effectiveDate, refId: String(targetPayId),
        memo: "일할 수납을 일반 수납으로 변경"
      });
    }
    tx.invalidate([SHEET_NAMES.STUDENTS, SHEET_NAMES.EVENTS]);
    return desiredBaseDay;
  }
  throw new Error("수납 학생을 명단에서 찾을 수 없습니다.");
}

function PaymentLifecycle_updatePayment_(form) {
  form = form || {};
  return MutationPipeline_run_({ operation: "수납내역변경" }, function(tx) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var paySheet = ss.getSheetByName(SHEET_NAMES.PAYMENTS);
    PaymentDomain_ensurePaymentSchema_(paySheet, tx);
    var targetId = String(form.payId || "").trim();
    if (!targetId || targetId === "undefined") throw new Error("수정/삭제할 수납 고유 ID가 전달되지 않았습니다.");

    var found = PaymentLifecycle_findPayment_(paySheet, targetId);
    if (!found) throw new Error("해당 수납 내역을 찾을 수 없습니다. (ID: " + targetId + ")");
    var oldRow = found.row;
    var studentId = oldRow[IDX.PAYMENT.STUDENT_ID];
    var studentName = oldRow[IDX.PAYMENT.STUDENT_NAME];
    var oldMonth = oldRow[IDX.PAYMENT.MONTH];
    var oldAmount = oldRow[IDX.PAYMENT.AMOUNT];
    var savedMemo = oldRow[IDX.PAYMENT.MEMO];
    var savedCalcType = oldRow[IDX.PAYMENT.CALC_TYPE];

    if (form.mode === "DELETE") {
      tx.invalidateMonths([oldMonth, MonthlySnapshot_monthString_(oldRow[IDX.PAYMENT.PAY_DATE])]);
      if (String(savedCalcType) === "PRORATED" || String(savedMemo || "").indexOf("[일할]") !== -1) tx.invalidateAllMonths();
      var trashResult = PaymentLifecycle_moveToTrash_(tx, paySheet, found.rowNumber, form.deleteReason || "수납 내역 삭제");
      var restoredDay = null;
      if (String(savedCalcType) === "PRORATED" || String(savedMemo || "").indexOf("[일할]") !== -1) {
        restoredDay = PaymentLifecycle_revertBaseDay_(tx, studentName, studentId, targetId);
      }
      return "✅ 수납 내역을 휴지통으로 이동했습니다.\n영구 삭제 예정일: " + trashResult.purgeAt +
        (restoredDay ? "\n\n📅 기준일을 '" + restoredDay + "'로 복구했습니다." : "");
    }

    var payDate = requireDateString_(form.payDate, "납부일");
    var month = requireMonthString_(form.month, "귀속월");
    var amount = requireMoney_(form.amount, "수납 금액", 0, 100000000);
    var method = requirePaymentMethod_(form.method);
    var memo = safeSheetText_(form.memo, 500);
    var updatedCore = oldRow.slice(2, 10);
    updatedCore[0] = payDate;
    updatedCore[3] = month;
    updatedCore[6] = amount;
    updatedCore[7] = method;
    tx.writeRange(paySheet, found.rowNumber, COL.PAYMENT.PAY_DATE, [updatedCore]);
    tx.writeRange(paySheet, found.rowNumber, COL.PAYMENT.MEMO, [[memo]]);
    // 빠른 수정 화면처럼 계산 메타데이터를 보내지 않는 호출자는 기존 값을 보존합니다.
    // 전체 수정 화면은 calcType을 명시하므로 종전처럼 7개 계산 열을 함께 갱신합니다.
    var hasCalculationMetadata = Object.prototype.hasOwnProperty.call(form, "calcType");
    if (hasCalculationMetadata) {
      var calculation = PaymentLifecycle_prepareCalculationMetadata_(form);
      if (calculation.calcType === "PRORATED") {
        if (month !== calculation.calcStart.substring(0, 7) || month !== calculation.calcEnd.substring(0, 7)) {
          throw new Error("일할 계산 기간과 귀속월이 다릅니다. 다시 계산해주세요.");
        }
        var studentMatches = LookupIndex_findRowsForValues_(SHEET_NAMES.STUDENTS, COL.STUDENT.ID, [studentId], true);
        if (!studentMatches.length) throw new Error("수납 학생 정보를 찾을 수 없습니다.");
        var studentHistories = buildStudentChangeHistory_(EventRepository_getLegacyRowsForStudents_([String(studentId)]));
        var monthLastDay = new Date(Number(month.substring(0,4)), Number(month.substring(5,7)), 0).getDate();
        var state = resolveStudentStateAtDate_(studentMatches[0].row, studentHistories,
          parseDateOnly_(month + "-" + (monthLastDay < 10 ? "0" : "") + monthLastDay));
        var adjustedFee = PaymentDomain_adjustMonthlyFee(state.fee, calculation.siblingDiscount, calculation.otherDiscount);
        var verified = PaymentDomain_calculateProratedPeriod_(adjustedFee,
          parseDateOnly_(calculation.calcStart), parseDateOnly_(calculation.calcEnd),
          calculation.vacationApplied ? PaymentDomain_getStudentVacations_(studentId) : []);
        if (calculation.activeDays !== verified.activeDays || calculation.billingDays !== verified.billingDays) {
          throw new Error("일할 날짜·휴가·적용일수가 최신 정보와 다릅니다. 다시 계산해주세요.");
        }
        var editDifference = PaymentDomain_prorationDifference_(amount, verified.amount);
        if (editDifference.exceeds) {
          var editDifferenceLabel = isFinite(editDifference.percent) ? editDifference.percent.toFixed(1) + "%" : "계산 불가";
          throw new Error("일할 입력액이 서버 계산액과 " + editDifferenceLabel + " 차이납니다. 계산액 " +
            verified.amount.toLocaleString() + "원 / 입력액 " + amount.toLocaleString() + "원입니다. 금액을 확인해주세요.");
        }
      }
      tx.writeRange(paySheet, found.rowNumber, COL.PAYMENT.CALC_TYPE, [[
        calculation.calcType, calculation.calcStart, calculation.calcEnd,
        calculation.activeDays, calculation.billingDays,
        calculation.siblingDiscount, calculation.otherDiscount
      ]]);
      PaymentLifecycle_replaceProratedBaseDay_(tx, paySheet, oldRow, targetId, calculation, payDate);
      if (calculation.calcType === "PRORATED" || PaymentLifecycle_isProratedRow_(oldRow)) tx.invalidateAllMonths();
    }
    tx.queueEvent({
      eventType: "수납내역수정", targetType: "수납", targetId: targetId,
      studentId: studentId, field: "수납내역",
      before: JSON.stringify({ payDate: formatDateOnly_(parseDateOnly_(oldRow[IDX.PAYMENT.PAY_DATE])), month: oldMonth, amount: oldAmount, method: oldRow[IDX.PAYMENT.METHOD], memo: savedMemo }),
      after: JSON.stringify({ payDate: payDate, month: month, amount: amount, method: method, memo: memo }),
      refId: targetId
    });
    tx.invalidateMonths([oldMonth, month, MonthlySnapshot_monthString_(oldRow[IDX.PAYMENT.PAY_DATE]), payDate.substring(0, 7)]);
    tx.invalidate([SHEET_NAMES.PAYMENTS, SHEET_NAMES.EVENTS]);
    return "✅ 수납 내역을 수정했습니다.";
  });
}

function updatePaymentData(form) {
  requireSuperAdmin_();
  return PaymentLifecycle_updatePayment_(form);
}

function PaymentLifecycle_reapplyBaseDay_(tx, originalRow, trashRow) {
  if (String(originalRow[IDX.PAYMENT.CALC_TYPE] || "") !== "PRORATED" &&
      String(originalRow[IDX.PAYMENT.MEMO] || "").indexOf("[일할]") === -1) return null;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var studentSheet = ss.getSheetByName(SHEET_NAMES.STUDENTS);
  if (!studentSheet) return null;
  var recordId = String(trashRow[4]);
  var baseDayChange = EventRepository_findBaseDayChange_(trashRow[5], recordId);
  if (!baseDayChange) return null;
  var studentMatches = LookupIndex_findRows_(
    SHEET_NAMES.STUDENTS, COL.STUDENT.ID, String(trashRow[5]), false
  );
  if (!studentMatches.length) {
    studentMatches = LookupIndex_findRows_(
      SHEET_NAMES.STUDENTS, COL.STUDENT.ID, String(trashRow[5]), true
    );
  }
  for (var s = 0; s < studentMatches.length; s++) {
      if (String(studentMatches[s].row[IDX.STUDENT.BASE_DAY]) !== String(baseDayChange.before)) continue;
      tx.writeRange(studentSheet, studentMatches[s].rowNumber, COL.STUDENT.BASE_DAY, [[baseDayChange.after]]);
      tx.queueEvent({
        eventType: "기준일재적용", targetType: "학생", targetId: String(trashRow[5]),
        studentId: String(trashRow[5]), field: "수강료기준일",
        before: baseDayChange.before, after: baseDayChange.after, refId: recordId,
        memo: "일할 수납 복구"
      });
      tx.invalidate([SHEET_NAMES.STUDENTS, SHEET_NAMES.EVENTS]);
      return baseDayChange.after;
  }
  return null;
}

function PaymentLifecycle_assertTrashRowBinding_(sourceSheetName, recordId, trashStudentId, originalRow) {
  if (!Array.isArray(originalRow)) throw new Error("휴지통 원문 형식이 손상되었습니다.");
  var idIndex, studentIndex;
  if (sourceSheetName === SHEET_NAMES.PAYMENTS) {
    idIndex = IDX.PAYMENT.ID;
    studentIndex = IDX.PAYMENT.STUDENT_ID;
  } else if (sourceSheetName === SHEET_NAMES.VACATIONS) {
    idIndex = IDX.VACATION.ID;
    studentIndex = IDX.VACATION.STUDENT_ID;
  } else {
    throw new Error("지원하지 않는 원본 시트입니다.");
  }
  var originalId = String(originalRow[idIndex] || "").trim();
  var originalStudentId = String(originalRow[studentIndex] || "").trim();
  if (!originalId || originalId !== String(recordId || "").trim()) {
    throw new Error("휴지통 기록 ID와 복구 원문이 일치하지 않습니다.");
  }
  if (String(trashStudentId || "").trim() &&
      originalStudentId !== String(trashStudentId || "").trim()) {
    throw new Error("휴지통 학생 정보와 복구 원문이 일치하지 않습니다.");
  }
  return { recordId:originalId, studentId:originalStudentId };
}

function restoreTrashItem(trashId) {
  return MutationPipeline_run_({ operation: "수납휴지통복구" }, function(tx) {
    var targetTrashId = String(trashId || "").trim();
    if (!targetTrashId) throw new Error("복구할 휴지통 ID가 없습니다.");
    var trashSheet = PaymentLifecycle_getTrashSheet_(tx);
    var trashMatches = LookupIndex_findRows_(SHEET_NAMES.TRASH, 1, targetTrashId, false);
    if (!trashMatches.length) {
      trashMatches = LookupIndex_findRows_(SHEET_NAMES.TRASH, 1, targetTrashId, true);
    }
    for (var i = 0; i < trashMatches.length; i++) {
      var trashRow = trashMatches[i].row;
      if (String(trashRow[0]) !== targetTrashId || String(trashRow[10]) !== "보관중") continue;
      var sourceSheetName = String(trashRow[3]);
      var recordId = String(trashRow[4]);
      var originalRow = Trash_deserializeRow_(trashRow[9]);
      var binding = PaymentLifecycle_assertTrashRowBinding_(sourceSheetName, recordId, trashRow[5], originalRow);
      if (sourceSheetName === SHEET_NAMES.PAYMENTS) {
        var paySheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.PAYMENTS);
        PaymentDomain_ensurePaymentSchema_(paySheet, tx);
        var paymentStudentRows = binding.studentId
          ? LookupIndex_findRows_(SHEET_NAMES.STUDENTS, COL.STUDENT.ID, binding.studentId, false) : [];
        if (binding.studentId && !paymentStudentRows.length) {
          paymentStudentRows = LookupIndex_findRows_(SHEET_NAMES.STUDENTS, COL.STUDENT.ID, binding.studentId, true);
        }
        if (!binding.studentId || !paymentStudentRows.length) throw new Error("수납을 복구할 학생이 현재 명단에 없습니다.");
        originalRow[PAYMENT_RETIRED_GROUP_COLUMN - 1] = "";
        if (PaymentLifecycle_findPayment_(paySheet, recordId)) throw new Error("같은 수납 ID가 이미 원본 시트에 있습니다.");
        tx.appendRows(paySheet, [originalRow]);
        PaymentLifecycle_reapplyBaseDay_(tx, originalRow, trashRow);
      } else if (sourceSheetName === SHEET_NAMES.VACATIONS) {
        var vacationSheet = VacationDomain_getOrCreateSheet_(tx);
        if (VacationDomain_findPeriod_(vacationSheet, recordId)) throw new Error("같은 기간 ID가 이미 원본 시트에 있습니다.");
        var restoredStudentId = String(originalRow[IDX.VACATION.STUDENT_ID] || "").trim();
        var studentRows = restoredStudentId
          ? LookupIndex_findRows_(SHEET_NAMES.STUDENTS, COL.STUDENT.ID, restoredStudentId, false) : [];
        if (restoredStudentId && !studentRows.length) {
          studentRows = LookupIndex_findRows_(SHEET_NAMES.STUDENTS, COL.STUDENT.ID, restoredStudentId, true);
        }
        if (!studentRows.length) throw new Error("휴가를 복구할 학생이 현재 명단에 없습니다.");
        var restoredStart = parseDateOnly_(originalRow[IDX.VACATION.START_DATE]);
        var restoredEnd = parseDateOnly_(originalRow[IDX.VACATION.END_DATE]);
        if (!restoredStart || !restoredEnd || restoredStart > restoredEnd) throw new Error("복구할 휴가 기간이 올바르지 않습니다.");
        var existingPeriods = LookupIndex_findRows_(
          SHEET_NAMES.VACATIONS, COL.VACATION.STUDENT_ID, restoredStudentId, false
        ).map(function(item) { return item.row; });
        for (var vp = 0; vp < existingPeriods.length; vp++) {
          var existingStart = parseDateOnly_(existingPeriods[vp][IDX.VACATION.START_DATE]);
          var existingEnd = parseDateOnly_(existingPeriods[vp][IDX.VACATION.END_DATE]);
          if (existingStart && existingEnd && restoredStart <= existingEnd && restoredEnd >= existingStart) {
            throw new Error("현재 등록된 다른 휴가·퇴원공백과 기간이 겹쳐 복구할 수 없습니다.");
          }
        }
        tx.appendRows(vacationSheet, [originalRow]);
      } else {
        throw new Error("지원하지 않는 원본 시트입니다.");
      }
      var user = requireAuthorizedUser_();
      tx.writeRange(trashSheet, trashMatches[i].rowNumber, 11, [["복구됨", new Date(), user.email]]);
      tx.queueEvent({
        eventType: sourceSheetName === SHEET_NAMES.PAYMENTS ? "수납복구" : "휴가기간복구",
        targetType: sourceSheetName === SHEET_NAMES.PAYMENTS ? "수납" : "기간", targetId: recordId,
        studentId: trashRow[5], field: "삭제상태", before: "휴지통", after: "사용중", refId: targetTrashId
      });
      tx.invalidate([sourceSheetName, SHEET_NAMES.TRASH, SHEET_NAMES.EVENTS]);
      return sourceSheetName === SHEET_NAMES.PAYMENTS ? "수납 내역을 복구했습니다." : "휴가·퇴원공백을 복구했습니다.";
    }
    throw new Error("복구 가능한 휴지통 항목을 찾을 수 없습니다.");
  });
}

function purgeExpiredTrash() {
  requireSuperAdmin_();
  return PaymentLifecycle_purgeExpiredTrash_();
}

function PaymentLifecycle_purgeExpiredTrash_() {
  try { Mutation_retryPendingEvents_(); } catch (retryError) { logError_("휴지통 정리 전 대기 이벤트 재시도", retryError); }
  return MutationPipeline_run_({ operation: "휴지통영구정리", automationAuthorized:true }, function(tx) {
    var sheet = PaymentLifecycle_getTrashSheet_(tx);
    var rows = sheet.getDataRange().getValues();
    var now = new Date();
    var purged = 0;
    for (var i = rows.length - 1; i >= 1; i--) {
      var purgeAt = rows[i][2] instanceof Date ? rows[i][2] : parseDateOnly_(rows[i][2]);
      if (String(rows[i][10]) !== "보관중" || !purgeAt || isNaN(purgeAt.getTime()) || purgeAt > now) continue;
      tx.queueEvent({
        eventType: "휴지통영구삭제",
        targetType: String(rows[i][3]) === SHEET_NAMES.PAYMENTS ? "수납" : "기간", targetId: String(rows[i][4]),
        studentId: String(rows[i][5]), field: "삭제상태", before: "휴지통", after: "영구삭제", refId: String(rows[i][0])
      });
      tx.deleteRows(sheet, i + 1, 1);
      purged++;
    }
    if (purged) tx.invalidate([SHEET_NAMES.TRASH, SHEET_NAMES.EVENTS]);
    return "휴지통 " + purged + "건을 영구 삭제했습니다.";
  });
}
