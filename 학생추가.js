// [함수 1] 시트 위의 '학생 추가' 버튼에 연결할 함수
function stu_add() {
  requireSpreadsheetManagerPermission_("STUDENT_ADD");
  var template = HtmlService.createTemplateFromFile('StudentAddUI');
  template.embedded = false;
  var html = template.evaluate()
      .setWidth(350)  // 입력 항목이 늘어나서 가로폭 약간 확대
      .setHeight(620); // 일할 예상액 안내 영역까지 충분히 표시
  SpreadsheetApp.getUi().showModalDialog(html, ' ');
}

/**
 * 대시보드 간편등록 모달용 HTML입니다.
 * 웹 앱 URL을 iframe으로 다시 여는 방식은 /dev 실행에서 Drive 오류가 날 수 있어
 * 현재 실행 중인 대시보드 안에 동일 템플릿을 직접 주입합니다.
 */
function getStudentAddEmbeddedContent() {
  requireManagerPermission_("STUDENT_ADD");
  var template = HtmlService.createTemplateFromFile('StudentAddUI');
  template.embedded = true;
  return template.evaluate().getContent();
}





/**
 * 📋 [등록용] 기존 선생님 목록 가져오기 (중복 제거)
 * - 신규 등록 시 '자동완성'을 돕기 위해 사용됩니다.
 */
function getExistingTeachers() {
  return getTeacherOptionsForStudentAdd().map(function(item) { return item.name; });
}



/**
 * [최적화됨] 학생 등록 함수
 * 변경점: HTML에서 계산된 'grade' 값을 그대로 받아 저장하도록 수정 (누락 방지)
 */
function StudentIdentity_normalizeName_(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function StudentIdentity_normalizeGuardianPhone_(value) {
  return String(value || "").replace(/^'/, "").replace(/[^0-9]/g, "");
}

/** 같은 이름과 같은 보호자 전화가 모두 있을 때만 동일 학생으로 판정합니다. */
function StudentIdentity_findDuplicate_(name, parentPhone, rows) {
  var normalizedName = StudentIdentity_normalizeName_(name);
  var normalizedPhone = StudentIdentity_normalizeGuardianPhone_(parentPhone);
  if (!normalizedName || !normalizedPhone) return null;
  rows = rows || DataRepository_getRows_(SHEET_NAMES.STUDENTS, { required:false, fresh:true, cache:false });
  for (var i = 1; i < rows.length; i++) {
    if (StudentIdentity_normalizeName_(rows[i][IDX.STUDENT.NAME]) !== normalizedName) continue;
    if (StudentIdentity_normalizeGuardianPhone_(rows[i][IDX.STUDENT.PHONE]) !== normalizedPhone) continue;
    return { id:String(rows[i][IDX.STUDENT.ID] || ""), name:String(rows[i][IDX.STUDENT.NAME] || "") };
  }
  return null;
}

function StudentIdentity_assertNoDuplicate_(name, parentPhone) {
  var duplicate = StudentIdentity_findDuplicate_(name, parentPhone);
  if (duplicate) throw new Error("같은 이름과 보호자 전화번호로 등록된 학생이 이미 있습니다. 기존 학생 정보를 확인해주세요.");
}

function createStudent(data) {
  var requestUser = requireAuthorizedUser_();
  if (ChangeRequest_isManager_(requestUser)) AccessControl_requireStudentDataAccess_(requestUser);
  data = data || {};
  var submittedName = requireText_(data.name, "학생 이름", 40);
  var submittedParentPhone = optionalText_(data.parentPhone, 30);
  // 하위관리자 요청 단계와 최고관리자 직접 등록 단계 모두에서 먼저 확인합니다.
  StudentIdentity_assertNoDuplicate_(submittedName, submittedParentPhone);
  if (ChangeRequest_isManager_(requestUser)) return ChangeRequest_submit_("STUDENT_CREATE", data || {}, {
    targetName:submittedName, summary:"학생 신규 등록"
  }).message;
  return MutationPipeline_run_({ operation: "학생등록" }, function(tx) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var listSheet = DataSchema_ensureSheet_(SHEET_NAMES.STUDENTS, tx).sheet;

  var name = submittedName;
  var managedTeacher = TeacherDirectory_getById_(requireText_(data.teacherId, "담당 원장 ID", 120));
  if (!managedTeacher || !managedTeacher.active) throw new Error("활성 상태로 등록된 원장을 선택해주세요.");
  var teacher = managedTeacher.name;
  var gradeStr = requireText_(data.grade, "학년", 30);
  var firstDate = requireDateString_(data.firstDate, "첫 수업일");
  var courseMode = normalizeStudentCourseMode_(data.courseMode);
  var submittedFee = requireMoney_(data.fee, "수강료", 0, 10000000);
  var fee = courseMode === "특강전용" ? 0 : submittedFee;
  var baseDayVal = data.baseDay ? requireNumberInRange_(data.baseDay, "수강료 기준일", 1, 31) : Number(firstDate.substring(8, 10));
  // 신규 학생의 배분율은 화면 입력값이 아니라 원장 관리의 기본값을 서버에서 확정합니다.
  var distRate = requireNumberInRange_(managedTeacher.defaultRate, "배분률", 0, 100) + "%";
  var parentPhone = submittedParentPhone;
  // 요청 후 승인 전 사이에 동일 학생이 추가되는 경쟁 상황도 다시 차단합니다.
  StudentIdentity_assertNoDuplicate_(name, parentPhone);
  var uniqueId = createUniqueId_("S");
  var phoneValue = parentPhone ? "'" + parentPhone.replace(/^'/, "") : "";

  // 데이터 저장
  tx.appendRows(listSheet, [[
    uniqueId,           // A
    safeSheetText_(name, 40), // B
    safeSheetText_(gradeStr, 30), // C
    "재원",              // D
    safeSheetText_(teacher, 40), // E
    firstDate,          // F
    "",                 // G
    baseDayVal,         // H
    distRate,           // I
    phoneValue,         // J
    fee,                // K
    "", "", "", "", "", "", "", // L~R: 기존 확장 열
    courseMode,         // S
    managedTeacher.id   // T: 담당 원장 ID
  ]]);

  tx.queueEvent({
    eventType: "학생등록", targetType: "학생", targetId: uniqueId, studentId: uniqueId,
    field: "학생등록", before: "", after: name + "/" + gradeStr + "/" + courseMode, effectiveDate: firstDate
  });
  tx.invalidate([SHEET_NAMES.STUDENTS, SHEET_NAMES.EVENTS]);
  
  // 완료 토스트 메시지
  return "학생 '" + name + "' 등록 완료 (" + gradeStr + ")";
  });
}



/**
 * 🔍 [등록용] 동명이인 확인 함수
 * 신규 등록 시, 이미 존재하는 이름인지(퇴원생 포함) 확인하여 경고를 줍니다.
 */
function checkNameDuplicate(name) {
  var access = requireManagerPermission_("STUDENT_ADD");
  if (!AccessControl_hasStudentDataAccess_(access)) {
    return { exists:false, status:"", grade:"", canOpenEdit:false, noStudentAccess:true };
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAMES.STUDENTS);
  if (!sheet) throw new Error("학생 명단 시트를 찾을 수 없습니다.");
  var matchingStudents = LookupIndex_findRows_(
    SHEET_NAMES.STUDENTS, COL.STUDENT.NAME, requireText_(name, "학생 이름", 40), false
  ).map(function(item) { return item.row; });
  var result = { exists: false, status: "", grade: "", canOpenEdit:AccessControl_hasPermission_(access, "STUDENT_EDIT") };
  if (!matchingStudents.length) return result;
  var matchingIds = matchingStudents.map(function(row) { return row[IDX.STUDENT.ID]; });
  var histories = buildStudentChangeHistory_(EventRepository_getLegacyRowsForStudents_(matchingIds, false));
  var asOfDate = new Date(); asOfDate.setHours(23, 59, 59, 999);
  var timelineOptions = { teacherIdByName:TeacherDirectory_buildLookup_().idByName };

  for (var i = 0; i < matchingStudents.length; i++) {
    var dbName = String(matchingStudents[i][IDX.STUDENT.NAME]).replace(/\s+/g, "");
    var inputName = String(name).replace(/\s+/g, "");
    
    if (dbName === inputName) {
      result.exists = true;
      var duplicateState = resolveStudentStateAtDate_(matchingStudents[i], histories, asOfDate, timelineOptions);
      if (ChangeRequest_isManager_(access) &&
          AccessControl_getStudentScope_(access) === STUDENT_ACCESS_SCOPES.LINKED_TEACHER &&
          String(duplicateState.teacherId || "") !== String(access.teacherId)) {
        result.outOfScope = true;
        result.canOpenEdit = false;
      } else {
        result.grade = matchingStudents[i][IDX.STUDENT.GRADE];
        result.status = duplicateState.status;
      }
      break; // 발견하면 즉시 중단
    }
  }
  return result;
}
