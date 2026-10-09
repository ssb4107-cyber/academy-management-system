/**
 * 👨‍👩‍👦 [관리자] 형제/자매 관리 팝업 열기
 */
function openSiblingManager() {
  requireSpreadsheetManagerPermission_("SIBLING_MANAGER");
  requireSuperAdmin_();
  var html = HtmlService.createTemplateFromFile('SiblingManager').evaluate()
      .setWidth(700)
      .setHeight(600);
  SpreadsheetApp.getUi().showModalDialog(html, '👨‍👩‍👦 형제/자매 관계 설정');
}
/**
 * 🔍 [조회] 학생 명단 불러오기 (형제 관리용) - N열(관계명) 추가
 */
function getStudentListForManager() {
  var access = requireManagerPermission_("SIBLING_MANAGER");
  var context = DataRepository_loadContext_([SHEET_NAMES.STUDENTS, SHEET_NAMES.LOGS], { required: false });
  var data = context[SHEET_NAMES.STUDENTS] || [];
  var histories = buildStudentChangeHistory_(context[SHEET_NAMES.LOGS] || []);
  var asOfDate = new Date(); asOfDate.setHours(23, 59, 59, 999);
  var teacherIdByName = TeacherDirectory_buildLookup_().idByName;
  
  var list = [];
  // 1행(헤더) 건너뛰고 스캔
  for (var i = 1; i < data.length; i++) {
    var sId = data[i][IDX.STUDENT.ID];
    var sName = data[i][IDX.STUDENT.NAME];
    var sGrade = data[i][IDX.STUDENT.GRADE];
    var resolvedState = resolveStudentStateAtDate_(data[i], histories, asOfDate, { teacherIdByName:teacherIdByName });
    var sStatus = resolvedState.status;
    // M열(12): 가족ID, N열(13): 관계명
    var sFamId = (data[i].length > IDX.STUDENT.FAMILY_ID) ? String(data[i][IDX.STUDENT.FAMILY_ID]) : ""; 
    var sRelName = (data[i].length > IDX.STUDENT.FAMILY_NAME) ? String(data[i][IDX.STUDENT.FAMILY_NAME]) : ""; 

    if (sId && sName) {
      list.push({ 
        row: i + 1, 
        id: sId, 
        name: sName, 
        grade: sGrade, 
        status: sStatus,
        teacherId: resolvedState.teacherId,
        famId: sFamId,
        relName: sRelName, // 관계명 추가
        siblingDiscount: Number(resolveStudentStateAtDate_(data[i], histories, asOfDate).siblingDiscount) || 0
      });
    }
  }
  return AccessControl_filterStudentList_(list, access);
}

function updateSiblingDiscount(studentId, amount, effectiveMonth) {
  var requestUser = requireAuthorizedUser_();
  if (ChangeRequest_isManager_(requestUser)) AccessControl_requireStudentDataAccess_(requestUser);
  if (ChangeRequest_isManager_(requestUser)) return ChangeRequest_submit_("SIBLING_DISCOUNT", {
    studentId:studentId, amount:amount, effectiveMonth:effectiveMonth
  }, { studentIds:[studentId], targetId:studentId, summary:"형제 할인 변경" }).message;
  return MutationPipeline_run_({ operation: "형제할인변경" }, function(tx) {
    studentId = requireText_(studentId, "학생 ID", 100);
    amount = requireMoney_(amount, "형제 할인액", 0, 10000000);
    effectiveMonth = requireMonthString_(effectiveMonth, "할인 적용 월");
    var effectiveDate = effectiveMonth + "-01";
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.STUDENTS);
    PaymentDomain_ensureStudentDiscountSchema_(sheet, tx);
    var studentMatches = LookupIndex_findRows_(SHEET_NAMES.STUDENTS, COL.STUDENT.ID, studentId, false);
    if (!studentMatches.length) {
      studentMatches = LookupIndex_findRows_(SHEET_NAMES.STUDENTS, COL.STUDENT.ID, studentId, true);
    }
    var histories = buildStudentChangeHistory_(EventRepository_getLegacyRowsForStudents_([studentId], false));
    for (var i = 0; i < studentMatches.length; i++) {
      var studentRow = studentMatches[i].row;
      if (!String(studentRow[IDX.STUDENT.FAMILY_ID] || "").trim()) throw new Error("형제 그룹에 속한 학생만 할인액을 설정할 수 있습니다.");
      var studentHistory = histories[studentId] || { fee: [], status: [], teacher: [], discount: [] };
      var before = Number(StudentTimeline_resolveValueBeforeDate_(
        studentRow[IDX.STUDENT.FAMILY_DISCOUNT], studentHistory.discount, effectiveDate
      )) || 0;
      // 기존 셀에만 할인액이 있고 이력이 없으면 선택한 월을 실제 할인 시작 월로 봅니다.
      if (!(studentHistory.discount || []).length && amount > 0 &&
          Number(studentRow[IDX.STUDENT.FAMILY_DISCOUNT]) === amount) {
        before = 0;
      }
      var pendingHistory = StudentTimeline_withPendingChange_(studentHistory.discount || [], {
        effectiveDate: effectiveDate, before: before, after: amount, createdAt: new Date()
      });
      var plannedAmount = Number(StudentTimeline_resolveValue(
        studentRow[IDX.STUDENT.FAMILY_DISCOUNT], pendingHistory, new Date(9999, 11, 31)
      )) || 0;
      tx.writeRange(sheet, studentMatches[i].rowNumber, COL.STUDENT.FAMILY_DISCOUNT, [[plannedAmount]]);
      tx.queueEvent({
        eventType: "형제할인변경", targetType: "학생", targetId: studentId, studentId: studentId,
        field: "형제할인액", before: before, after: amount, effectiveDate: effectiveDate
      });
      tx.invalidate([SHEET_NAMES.STUDENTS, SHEET_NAMES.EVENTS]);
      return effectiveMonth + "부터 형제 할인액 " + amount.toLocaleString() + "원을 적용합니다.";
    }
    throw new Error("학생을 찾을 수 없습니다.");
  });
}

/**
 * 💾 [저장] 형제 그룹 설정 (관계명 N열 저장 추가)
 */
function SiblingDomain_expandAffectedStudentIdsFromRows_(studentIds, mode, rows) {
  var selected = {}, affected = [];
  if (!Array.isArray(studentIds)) return affected;
  studentIds.forEach(function(id) {
    id = String(id || "").trim();
    if (!id || selected[id]) return;
    selected[id] = true;
    affected.push(id);
  });
  if (String(mode || "") !== "UNGROUP" || !affected.length) return affected;

  var familyMembers = {};
  for (var i = 1; i < (rows || []).length; i++) {
    var studentId = String(rows[i][IDX.STUDENT.ID] || "").trim();
    var familyId = String(rows[i][IDX.STUDENT.FAMILY_ID] || "").trim();
    if (!studentId || !familyId) continue;
    if (!familyMembers[familyId]) familyMembers[familyId] = [];
    familyMembers[familyId].push(studentId);
  }
  Object.keys(familyMembers).forEach(function(familyId) {
    var members = familyMembers[familyId];
    if (!members.some(function(id) { return !!selected[id]; })) return;
    var remaining = members.filter(function(id) { return !selected[id]; });
    // 실제 저장 본체는 해제 뒤 한 명만 남으면 그 학생도 함께 해제합니다.
    // 승인 요청 단계에서도 이 자동 변경 대상을 범위 검사와 원본 지문에 포함합니다.
    if (remaining.length === 1 && !selected[remaining[0]]) {
      selected[remaining[0]] = true;
      affected.push(remaining[0]);
    }
  });
  return affected;
}

function SiblingDomain_expandSnapshotStudentIdsFromRows_(studentIds, mode, rows) {
  var selected = {}, snapshotIds = [];
  (studentIds || []).forEach(function(id) {
    id = String(id || "").trim();
    if (!id || selected[id]) return;
    selected[id] = true;
    snapshotIds.push(id);
  });
  if (String(mode || "") !== "UNGROUP" || !snapshotIds.length) return snapshotIds;
  var selectedFamilyIds = {};
  for (var i = 1; i < (rows || []).length; i++) {
    var studentId = String(rows[i][IDX.STUDENT.ID] || "").trim();
    var familyId = String(rows[i][IDX.STUDENT.FAMILY_ID] || "").trim();
    if (studentId && familyId && selected[studentId]) selectedFamilyIds[familyId] = true;
  }
  for (var r = 1; r < (rows || []).length; r++) {
    var relatedId = String(rows[r][IDX.STUDENT.ID] || "").trim();
    var relatedFamilyId = String(rows[r][IDX.STUDENT.FAMILY_ID] || "").trim();
    if (!relatedId || !selectedFamilyIds[relatedFamilyId] || selected[relatedId]) continue;
    selected[relatedId] = true;
    snapshotIds.push(relatedId);
  }
  return snapshotIds;
}

function SiblingDomain_managerRequestContext_(studentIds, mode) {
  var rows = DataRepository_getRows_(SHEET_NAMES.STUDENTS, { required:true });
  return {
    affectedStudentIds:SiblingDomain_expandAffectedStudentIdsFromRows_(studentIds, mode, rows),
    snapshotStudentIds:SiblingDomain_expandSnapshotStudentIdsFromRows_(studentIds, mode, rows)
  };
}

function updateSiblingGroup(studentIds, mode, customName) {
  var requestUser = requireAuthorizedUser_();
  if (ChangeRequest_isManager_(requestUser)) AccessControl_requireStudentDataAccess_(requestUser);
  if (ChangeRequest_isManager_(requestUser)) {
    var requestContext = SiblingDomain_managerRequestContext_(studentIds, mode);
    return ChangeRequest_submit_("SIBLING_GROUP", {
      studentIds:studentIds, mode:mode, customName:customName
    }, { studentIds:requestContext.affectedStudentIds, snapshotStudentIds:requestContext.snapshotStudentIds,
      targetId:(studentIds || [])[0], targetName:customName,
      summary:mode === "GROUP" ? "형제 그룹 설정" : "형제 그룹 해제" }).message;
  }
  return MutationPipeline_run_({ operation: "형제관계변경" }, function(tx) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAMES.STUDENTS);
  if (!sheet) throw new Error("학생 명단 시트를 찾을 수 없습니다.");
  if (["GROUP", "UNGROUP"].indexOf(String(mode)) === -1) throw new Error("형제 그룹 처리 방식이 올바르지 않습니다.");
  if (!Array.isArray(studentIds)) throw new Error("학생 선택 정보가 올바르지 않습니다.");

  var selectedMap = {};
  studentIds.forEach(function(id) {
    var cleanId = requireText_(id, "학생 ID", 100);
    selectedMap[cleanId] = true;
  });
  var selectedIds = Object.keys(selectedMap);
  if (mode === "GROUP" && selectedIds.length < 2) throw new Error("형제로 묶으려면 서로 다른 학생 2명 이상이 필요합니다.");
  var safeGroupName = mode === "GROUP" ? safeSheetText_(requireText_(customName, "가족 그룹명", 40), 40) : "";
  var data = sheet.getDataRange().getValues();
  var discountHistories = buildStudentChangeHistory_(DataRepository_getRows_(SHEET_NAMES.LOGS, { required: false }));
  var now = new Date(); now.setHours(23, 59, 59, 999);
  var todayText = formatDateOnly_(now);
  var existingIds = {};
  var familyMembers = {};
  for (var i = 1; i < data.length; i++) {
    var rowStudentId = String(data[i][IDX.STUDENT.ID]).trim();
    if (rowStudentId) existingIds[rowStudentId] = true;
    var rowFamilyId = String(data[i][IDX.STUDENT.FAMILY_ID] || "").trim();
    if (rowFamilyId) {
      if (!familyMembers[rowFamilyId]) familyMembers[rowFamilyId] = [];
      familyMembers[rowFamilyId].push(rowStudentId);
    }
  }

  selectedIds.forEach(function(id) {
    if (!existingIds[id]) throw new Error("존재하지 않는 학생 ID가 포함되어 있습니다: " + id);
  });

  if (mode === "GROUP") {
    // 기존 가족 일부만 다른 그룹으로 이동해 단방향 관계가 생기는 것을 차단합니다.
    for (var g = 1; g < data.length; g++) {
      var selectedStudentId = String(data[g][IDX.STUDENT.ID]).trim();
      var selectedFamilyId = String(data[g][IDX.STUDENT.FAMILY_ID] || "").trim();
      if (!selectedMap[selectedStudentId] || !selectedFamilyId) continue;
      var missingMember = familyMembers[selectedFamilyId].some(function(memberId) { return !selectedMap[memberId]; });
      if (missingMember) throw new Error("기존 가족을 변경하려면 해당 가족 구성원을 모두 선택해주세요.");
    }
  }

  var newFamId = mode === "GROUP" ? createUniqueId_("FAM") : "";
  var familyValues = [];
  var changedStudents = [];
  for (var r = 1; r < data.length; r++) {
    var sid = String(data[r][IDX.STUDENT.ID]).trim();
    var oldFamId = String(data[r][IDX.STUDENT.FAMILY_ID] || "");
    var oldFamName = String(data[r][IDX.STUDENT.FAMILY_NAME] || "");
    var nextFamId = oldFamId;
    var nextFamName = oldFamName;
    if (selectedMap[sid]) {
      nextFamId = newFamId;
      nextFamName = safeGroupName;
    }
    familyValues.push([nextFamId, nextFamName]);
    if (oldFamId !== nextFamId || oldFamName !== nextFamName) {
      changedStudents.push({ id: sid, name: data[r][IDX.STUDENT.NAME], before: oldFamId + "/" + oldFamName, after: nextFamId + "/" + nextFamName });
    }
  }

  // 선택 해제로 기존 가족이 한 명만 남으면 관계 의미가 없으므로 함께 해제합니다.
  if (mode === "UNGROUP") {
    var remainingCounts = {};
    familyValues.forEach(function(value) { if (value[0]) remainingCounts[value[0]] = (remainingCounts[value[0]] || 0) + 1; });
    familyValues.forEach(function(value, index) {
      if (value[0] && remainingCounts[value[0]] < 2) {
        var sourceRow = data[index + 1];
        changedStudents.push({ id: sourceRow[IDX.STUDENT.ID], name: sourceRow[IDX.STUDENT.NAME], before: value[0] + "/" + value[1], after: "/" });
        value[0] = ""; value[1] = "";
      }
    });
  }

  if (familyValues.length) tx.writeRange(sheet, 2, COL.STUDENT.FAMILY_ID, familyValues);
  if (familyValues.length) {
    var discountValues = familyValues.map(function(value, index) {
      return [value[0] ? (Number(data[index + 1][IDX.STUDENT.FAMILY_DISCOUNT]) || 0) : 0];
    });
    tx.writeRange(sheet, 2, COL.STUDENT.FAMILY_DISCOUNT, discountValues);
    if (mode === "UNGROUP") {
      familyValues.forEach(function(value, index) {
        if (value[0] || !String(data[index + 1][IDX.STUDENT.FAMILY_ID] || "").trim()) return;
        var sourceRow = data[index + 1];
        var sourceId = String(sourceRow[IDX.STUDENT.ID] || "").trim();
        if (!sourceId) return;
        var history = (discountHistories[sourceId] || {}).discount || [];
        var currentDiscount = Number(StudentTimeline_resolveValue(
          sourceRow[IDX.STUDENT.FAMILY_DISCOUNT], history, now
        )) || 0;
        if (currentDiscount !== 0) {
          tx.queueEvent({
            eventType: "형제할인종료", targetType: "학생", targetId: sourceId, studentId: sourceId,
            field: "형제할인액", before: currentDiscount, after: 0, effectiveDate: todayText,
            memo: "형제 관계 해제"
          });
        }
        history.filter(function(event) { return event.effectiveDate > now; }).forEach(function(event) {
          tx.queueEvent({
            eventType: "형제할인예약취소", targetType: "학생", targetId: sourceId, studentId: sourceId,
            field: "형제할인액", before: event.after, after: 0,
            effectiveDate: formatDateOnly_(event.effectiveDate), memo: "형제 관계 해제로 미래 할인 무효화"
          });
        });
      });
    }
  }
  changedStudents.forEach(function(change) {
    tx.queueEvent({
      eventType: "형제관계변경", targetType: "학생", targetId: change.id, studentId: change.id,
      field: "형제관계", before: change.before, after: change.after,
      refId: newFamId, groupId: newFamId
    });
  });

  tx.invalidate([SHEET_NAMES.STUDENTS, SHEET_NAMES.EVENTS]);
  
  return (mode === "GROUP") 
    ? "✅ '" + safeGroupName + "' 그룹으로 묶었습니다." 
    : "🗑️ 관계를 해제했습니다.";
  });
}
