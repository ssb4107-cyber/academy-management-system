/** 학생의 과거/현재/미래 값을 DB_이벤트 호환 행으로 재생하는 단일 시점 서비스 */
function StudentTimeline_buildHistories(logData) {
  var histories = {};
  if (!logData) return histories;
  for (var i = 1; i < logData.length; i++) {
    var studentId = String(logData[i][IDX.LOG.STUDENT_ID] || "").trim();
    var item = String(logData[i][IDX.LOG.ITEM] || "").trim();
    var effectiveDate = parseDateOnly_(logData[i][IDX.LOG.EFFECTIVE_DATE]);
    if (!studentId || !effectiveDate) continue;
    var field = item === "수강료 변경" ? "fee"
      : item === "상태 변경" ? "status"
      : (item === "담당 원장 변경" || item === "담당 강사 변경") ? "teacher"
      : (item === "형제할인액" || item === "형제 할인 변경" || item === "형제할인액 변경") ? "discount"
      : (item === "수강형태 변경" || item === "수강 형태 변경") ? "courseMode" : "";
    if (!field) continue;
    if (!histories[studentId]) histories[studentId] = { fee: [], status: [], teacher: [], discount: [], courseMode: [] };
    var createdValue = logData[i][IDX.LOG.CREATED_AT];
    var createdDate = createdValue instanceof Date ? createdValue : new Date(createdValue);
    histories[studentId][field].push({
      effectiveDate: effectiveDate,
      createdAt: !isNaN(createdDate.getTime()) ? createdDate.getTime() : i,
      rowOrder: i,
      before: logData[i][IDX.LOG.BEFORE],
      after: logData[i][IDX.LOG.AFTER],
      // 담당 원장 변경 이벤트는 변경 후 원장 ID를 참조 ID에 보관합니다.
      refId: String(logData[i][IDX.LOG.REF_ID] || "").trim()
    });
  }
  return histories;
}

function StudentTimeline_resolveValue(currentValue, history, asOfDate) {
  var entries = (history || []).slice();
  if (!entries.length) return currentValue;
  var firstCreated = entries.slice().sort(function(a, b) {
    return (a.createdAt - b.createdAt) || (a.rowOrder - b.rowOrder);
  })[0];
  var value = firstCreated.before;
  entries.sort(function(a, b) {
    return (a.effectiveDate - b.effectiveDate) || (a.createdAt - b.createdAt) || (a.rowOrder - b.rowOrder);
  });
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].effectiveDate > asOfDate) break;
    value = entries[i].after;
  }
  return value;
}

function StudentTimeline_resolveValueBeforeDate_(currentValue, history, effectiveDateText) {
  var effectiveDate = parseDateOnly_(effectiveDateText);
  if (!effectiveDate) return currentValue;
  return StudentTimeline_resolveValue(currentValue, history, new Date(effectiveDate.getTime() - 1));
}

function StudentTimeline_withPendingChange_(history, change) {
  var entries = (history || []).slice();
  var effectiveDate = parseDateOnly_(change.effectiveDate);
  if (!effectiveDate) return entries;

  // 실제 로그 upsert와 동일하게 같은 적용일의 마지막 행을 교체합니다.
  var replaceIndex = -1;
  for (var i = entries.length - 1; i >= 0; i--) {
    if (entries[i].effectiveDate && entries[i].effectiveDate.getTime() === effectiveDate.getTime()) {
      replaceIndex = i;
      break;
    }
  }
  var pending = {
    effectiveDate: effectiveDate,
    createdAt: change.createdAt instanceof Date ? change.createdAt.getTime() : Number(change.createdAt) || Date.now(),
    rowOrder: Number.MAX_SAFE_INTEGER,
    before: change.before,
    after: change.after,
    refId: String(change.refId || "").trim()
  };
  if (replaceIndex === -1) entries.push(pending);
  else entries[replaceIndex] = pending;
  return entries;
}

function StudentTimeline_resolveTeacher_(studentRow, history, asOfDate, teacherIdByName) {
  var teacherName = String(StudentTimeline_resolveValue(
    studentRow[IDX.STUDENT.TEACHER], history, asOfDate
  ) || "").trim();
  var rowTeacherName = String(studentRow[IDX.STUDENT.TEACHER] || "").trim();
  var rowTeacherId = String(studentRow[IDX.STUDENT.TEACHER_ID] || "").trim();
  var entries = (history || []).slice().sort(function(a, b) {
    return (a.effectiveDate - b.effectiveDate) || (a.createdAt - b.createdAt) || (a.rowOrder - b.rowOrder);
  });
  var appliedEvent = null;
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].effectiveDate > asOfDate) break;
    appliedEvent = entries[i];
  }
  var teacherId = appliedEvent ? String(appliedEvent.refId || "").trim() : "";
  // 이벤트가 없거나 최종 계획값과 같은 경우에는 명단의 정규 원장 ID가 기준입니다.
  if (!teacherId && teacherName === rowTeacherName) teacherId = rowTeacherId;
  // 과거 첫 이벤트 이전 값은 기존 이벤트 스키마에 beforeId가 없으므로 고유 원장명으로만 복원합니다.
  if (!teacherId && teacherIdByName) teacherId = String(teacherIdByName[teacherName] || "").trim();
  return { teacher: teacherName, teacherId: teacherId };
}

function StudentTimeline_resolveState(studentRow, histories, asOfDate, options) {
  options = options || {};
  var studentId = String(studentRow[IDX.STUDENT.ID] || "").trim();
  var history = histories[studentId] || { fee: [], status: [], teacher: [], discount: [], courseMode: [] };
  var teacherState = StudentTimeline_resolveTeacher_(studentRow, history.teacher, asOfDate, options.teacherIdByName);
  var courseMode = normalizeStudentCourseMode_(StudentTimeline_resolveValue(
    studentRow[IDX.STUDENT.COURSE_MODE], history.courseMode, asOfDate
  ));
  var fee = Number(String(StudentTimeline_resolveValue(studentRow[IDX.STUDENT.FEE], history.fee, asOfDate)).replace(/,/g, "")) || 0;
  if (courseMode === STUDENT_COURSE_MODES.SPECIAL_ONLY) fee = 0;
  return {
    fee: fee,
    status: String(StudentTimeline_resolveValue(studentRow[IDX.STUDENT.STATUS], history.status, asOfDate) || "").trim(),
    teacher: teacherState.teacher,
    teacherId: teacherState.teacherId,
    siblingDiscount: Number(String(StudentTimeline_resolveValue(
      studentRow[IDX.STUDENT.FAMILY_DISCOUNT], history.discount, asOfDate
    )).replace(/,/g, "")) || 0,
    courseMode: courseMode
  };
}

function StudentTimeline_normalizeFeeEffectiveDate(requestedDate, baseDay) {
  var requested = parseDateOnly_(requireDateString_(requestedDate, "수강료 적용일"));
  var day = requireNumberInRange_(baseDay, "수강료 기준일", 1, 31);
  var lastDay = new Date(requested.getFullYear(), requested.getMonth() + 1, 0).getDate();
  return formatDateOnly_(new Date(requested.getFullYear(), requested.getMonth(), Math.min(day, lastDay)));
}
