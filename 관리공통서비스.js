/** 원장·사용자·급여 기록을 관리하는 공통 서비스입니다. */
function Management_toBoolean_(value) {
  if (value === true || value === 1) return true;
  var text = String(value == null ? "" : value).trim().toUpperCase();
  return text === "TRUE" || text === "Y" || text === "1" || text === "활성" || text === "예";
}

function Management_ensureInfrastructure_() {
  var teacherSheet = DataSchema_ensureSheet_(SHEET_NAMES.TEACHERS).sheet;
  var userSheet = DataSchema_ensureSheet_(SHEET_NAMES.USERS).sheet;
  DataSchema_ensureSheet_(SHEET_NAMES.SETTINGS);
  DataSchema_ensureSheet_(SHEET_NAMES.SALARY_SETTLEMENTS);
  DataSchema_ensureSheet_(SHEET_NAMES.SALARY_ENTRIES);
  Management_seedBootstrapUsers_(userSheet);
  Management_seedTeachers_(teacherSheet);
}

function Management_seedBootstrapUsers_(sheet) {
  var existing = {};
  var existingRows = [];
  var repaired = false;
  if (sheet.getLastRow() > 1) {
    existingRows = sheet.getRange(2, 1, sheet.getLastRow() - 1, COL.USER.STUDENT_SCOPE).getValues();
    existingRows.forEach(function(row) {
      var email = String(row[IDX.USER.EMAIL] || "").trim().toLowerCase();
      existing[email] = true;
      if (ACCESS_CONTROL.ADMIN_EMAILS.indexOf(email) === -1) return;
      var displayName = ACCESS_CONTROL.ADMIN_DISPLAY_NAMES[email] || email;
      if (String(row[IDX.USER.ROLE] || "") !== ACCESS_CONTROL.ROLES.SUPER_ADMIN ||
          !Management_toBoolean_(row[IDX.USER.ACTIVE]) || String(row[IDX.USER.PERMISSIONS] || "") !== "*" ||
          !String(row[IDX.USER.NAME] || "").trim() ||
          String(row[IDX.USER.STUDENT_SCOPE] || "") !== STUDENT_ACCESS_SCOPES.ALL_STUDENTS) {
        if (!String(row[IDX.USER.NAME] || "").trim()) row[IDX.USER.NAME] = displayName;
        row[IDX.USER.ROLE] = ACCESS_CONTROL.ROLES.SUPER_ADMIN;
        row[IDX.USER.ACTIVE] = true;
        row[IDX.USER.PERMISSIONS] = "*";
        row[IDX.USER.STUDENT_SCOPE] = STUDENT_ACCESS_SCOPES.ALL_STUDENTS;
        row[IDX.USER.UPDATED_AT] = new Date();
        row[IDX.USER.UPDATED_BY] = "SYSTEM_RECOVERY_PROTECTION";
        repaired = true;
      }
    });
    if (repaired) sheet.getRange(2, 1, existingRows.length, COL.USER.STUDENT_SCOPE).setValues(existingRows);
  }
  var now = new Date();
  var rows = [];
  ACCESS_CONTROL.ADMIN_EMAILS.forEach(function(email) {
    if (existing[email]) return;
    rows.push([createUniqueId_("USR"), email, ACCESS_CONTROL.ADMIN_DISPLAY_NAMES[email] || email, ACCESS_CONTROL.ROLES.SUPER_ADMIN, true, "*", now, now, email, "", STUDENT_ACCESS_SCOPES.ALL_STUDENTS]);
  });
  if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  if (repaired || rows.length) DataRepository_clearCache_(SHEET_NAMES.USERS);
}

function Management_seedTeachers_(sheet, tx) {
  var existing = {};
  var duplicateNames = [];
  var duplicateIds = [];
  var blankNameRows = [];
  var existingIds = {};
  var repairedNames = [];
  var existingRows = [];
  var now = new Date();
  var actor = getCurrentUserEmail_() || "SYSTEM";
  if (sheet.getLastRow() > 1) {
    existingRows = sheet.getRange(2, 1, sheet.getLastRow() - 1, COL.TEACHER.UPDATED_BY).getValues();
    existingRows.forEach(function(row, rowIndex) {
      var name = String(row[IDX.TEACHER.NAME] || "").trim();
      if (!name) { blankNameRows.push(rowIndex + 2); return; }
      var id = String(row[IDX.TEACHER.ID] || "").trim();
      if (id && existingIds[id]) duplicateIds.push(id);
      if (id) existingIds[id] = true;
      if (existing[name]) duplicateNames.push(name);
      existing[name] = true;
      var repaired = false;
      if (!String(row[IDX.TEACHER.ID] || "").trim()) { row[IDX.TEACHER.ID] = createUniqueId_("TCH"); repaired = true; }
      if (String(row[IDX.TEACHER.DEFAULT_RATE] == null ? "" : row[IDX.TEACHER.DEFAULT_RATE]).trim() === "") {
        row[IDX.TEACHER.DEFAULT_RATE] = 60; repaired = true;
      }
      if (String(row[IDX.TEACHER.ACTIVE] == null ? "" : row[IDX.TEACHER.ACTIVE]).trim() === "") {
        row[IDX.TEACHER.ACTIVE] = true; repaired = true;
      }
      if (String(row[IDX.TEACHER.SALARY_TARGET] == null ? "" : row[IDX.TEACHER.SALARY_TARGET]).trim() === "") {
        row[IDX.TEACHER.SALARY_TARGET] = true; repaired = true;
      }
      if (!row[IDX.TEACHER.CREATED_AT]) { row[IDX.TEACHER.CREATED_AT] = now; repaired = true; }
      if (repaired) {
        row[IDX.TEACHER.UPDATED_AT] = now;
        row[IDX.TEACHER.UPDATED_BY] = actor;
        repairedNames.push(name);
      }
    });
    if (repairedNames.length) {
      if (tx) tx.writeRange(sheet, 2, 1, existingRows);
      else sheet.getRange(2, 1, existingRows.length, COL.TEACHER.UPDATED_BY).setValues(existingRows);
    }
  }
  var studentSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.STUDENTS);
  var names = {};
  var currentNames = {};
  var historicalNames = {};
  if (studentSheet && studentSheet.getLastRow() >= 2) {
    studentSheet.getRange(2, COL.STUDENT.TEACHER, studentSheet.getLastRow() - 1, 1).getValues().forEach(function(row) {
      var name = String(row[0] || "").trim();
      if (name) { names[name] = true; currentNames[name] = true; }
    });
  }
  // 현재 담당자가 아닌 과거 담당자도 과거 급여 조회에서 사라지지 않도록 변경 이력을 함께 반영합니다.
  try {
    var logRows = DataRepository_getRows_(SHEET_NAMES.LOGS, { required: false });
    for (var l = 1; l < logRows.length; l++) {
      var item = String(logRows[l][IDX.LOG.ITEM] || "");
      if (item !== "담당 원장 변경" && item !== "담당 강사 변경" && item !== "담당자 변경") continue;
      [logRows[l][IDX.LOG.BEFORE], logRows[l][IDX.LOG.AFTER]].forEach(function(value) {
        var historicalName = String(value || "").trim();
        if (historicalName) { names[historicalName] = true; historicalNames[historicalName] = true; }
      });
    }
  } catch (historyError) {
    logError_("과거 원장 명부 초기화", historyError);
  }
  var addedNames = Object.keys(names).sort().filter(function(name) { return !existing[name]; });
  var rows = addedNames.map(function(name) {
    return [createUniqueId_("TCH"), name, true, 60, true, "", "", "기존 학생 자료에서 자동 등록", now, now, actor];
  });
  if (rows.length) {
    if (tx) tx.appendRows(sheet, rows);
    else sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
  if (!tx && (repairedNames.length || rows.length)) {
    // 초기화·조회 중 직접 보완된 원장 정보도 급여 및 월별 담당자 계산에 즉시 반영합니다.
    DataRepository_clearCache_(SHEET_NAMES.TEACHERS);
    MonthlyCache_markAllDirty_();
    MonthlySnapshotStore_markAllStale_();
    markHomeDashboardDirty_();
  }
  return {
    candidateNames: Object.keys(names).sort(),
    currentNames: Object.keys(currentNames).sort(),
    historicalNames: Object.keys(historicalNames).sort(),
    addedNames: addedNames,
    repairedNames: repairedNames,
    duplicateNames: duplicateNames.filter(function(name, index, list) { return list.indexOf(name) === index; }),
    duplicateIds: duplicateIds.filter(function(id, index, list) { return list.indexOf(id) === index; }),
    blankNameRows: blankNameRows
  };
}

/** 기존 학생·담당 변경 이력으로 DB_원장을 생성·보완하고 결과를 보고합니다. */
