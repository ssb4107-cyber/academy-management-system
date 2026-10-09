/** 원장 명부·드롭다운·관리 화면 서비스 */
function prepareTeacherDirectoryData() {
  requireSuperAdmin_();
  return MutationPipeline_run_({ operation: "원장데이터준비" }, function(tx) {
    var sheet = DataSchema_ensureSheet_(SHEET_NAMES.TEACHERS, tx).sheet;
    var report = Management_seedTeachers_(sheet, tx);
    tx.queueEvent({
      eventType: "원장데이터준비", targetType: "원장", targetId: "TEACHER_DIRECTORY",
      field: "원장명부", before: "", after: report.addedNames.length + "명 추가/" + report.repairedNames.length + "명 보완",
      memo: JSON.stringify({
        addedCount: report.addedNames.length,
        repairedCount: report.repairedNames.length,
        duplicateNames: report.duplicateNames.slice(0, 10),
        duplicateIds: report.duplicateIds.slice(0, 10),
        blankNameRows: report.blankNameRows.slice(0, 20)
      })
    });
    tx.invalidate([SHEET_NAMES.TEACHERS, SHEET_NAMES.EVENTS]);
    report.totalTeachers = Math.max(0, sheet.getLastRow() - 1);
    report.message = "원장 데이터 준비 완료: 신규 " + report.addedNames.length + "명, 보완 " + report.repairedNames.length + "명" +
      (report.duplicateNames.length ? ", 중복 이름 " + report.duplicateNames.length + "건" : "") +
      (report.duplicateIds.length ? ", 중복 ID " + report.duplicateIds.length + "건" : "") +
      (report.blankNameRows.length ? ", 이름 없는 행 " + report.blankNameRows.length + "건" : "");
    return report;
  });
}

function prepareTeacherDirectoryDataFromMenu() {
  requireSpreadsheetSuperAdmin_();
  var report = prepareTeacherDirectoryData();
  SpreadsheetApp.getUi().alert(report.message +
    (report.addedNames.length ? "\n\n추가: " + report.addedNames.join(", ") : "") +
    (report.duplicateNames.length ? "\n\n⚠️ 중복 이름: " + report.duplicateNames.join(", ") : "") +
    (report.duplicateIds.length ? "\n⚠️ 중복 ID: " + report.duplicateIds.join(", ") : "") +
    (report.blankNameRows.length ? "\n⚠️ 이름 없는 행: " + report.blankNameRows.join(", ") : ""));
}

function TeacherIdMigration_normalizeUserName_(value) {
  return String(value || "").replace(/\s+/g, "").replace(/원장님?$/, "");
}

function TeacherIdMigration_ensureStudentIdColumn_(tx) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAMES.STUDENTS);
  if (!sheet) throw new Error("DB_명단 시트를 찾을 수 없습니다.");
  var requiredColumn = COL.STUDENT.TEACHER_ID;
  if (sheet.getMaxColumns() < requiredColumn) {
    var beforeMaxColumns = sheet.getMaxColumns();
    var inserted = requiredColumn - beforeMaxColumns;
    sheet.insertColumnsAfter(beforeMaxColumns, inserted);
    tx.addRollback(function() {
      if (sheet.getMaxColumns() >= beforeMaxColumns + inserted) sheet.deleteColumns(beforeMaxColumns + 1, inserted);
    });
  }
  var currentHeader = String(sheet.getRange(1, requiredColumn).getValue() || "").trim();
  if (currentHeader && currentHeader !== "담당원장ID") {
    throw new Error("DB_명단 " + requiredColumn + "열을 담당원장ID로 사용할 수 없습니다. 현재 헤더: " + currentHeader);
  }
  if (!currentHeader) tx.writeRange(sheet, 1, requiredColumn, [["담당원장ID"]]);
  return sheet;
}

/**
 * 기존 이름 기반 자료를 원장 ID 체계로 안전하게 보완합니다.
 * 이름이 유일하게 일치하는 행만 수정하고, 불명확하거나 기존 ID와 충돌하는 행은 보고만 합니다.
 */
function migrateLegacyTeacherIds() {
  requireSuperAdmin_();
  var rollbackBackup = Backup_createVerifiedCopy_("원장ID이관전");
  var migrationReport = MutationPipeline_run_({ operation: "기존원장ID이관" }, function(tx) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var actor = requireSuperAdmin_();
    var now = new Date();
    var teacherSheet = DataSchema_ensureSheet_(SHEET_NAMES.TEACHERS, tx).sheet;
    var seedReport = Management_seedTeachers_(teacherSheet, tx);
    if (seedReport.duplicateNames.length || seedReport.duplicateIds.length || seedReport.blankNameRows.length) {
      throw new Error("DB_원장에 중복 이름·ID 또는 이름 없는 행이 있어 ID 이관을 중단했습니다. 원장 데이터 진단을 먼저 확인해주세요.");
    }

    var teacherRows = teacherSheet.getLastRow() > 1
      ? teacherSheet.getRange(2, 1, teacherSheet.getLastRow() - 1, COL.TEACHER.UPDATED_BY).getValues() : [];
    var byName = {};
    var byId = {};
    var byNormalizedName = {};
    teacherRows.forEach(function(row) {
      var teacher = TeacherDirectory_toObject_(row);
      if (!teacher.id || !teacher.name) return;
      byName[teacher.name.trim()] = teacher;
      byId[teacher.id] = teacher;
      var normalized = TeacherIdMigration_normalizeUserName_(teacher.name);
      if (!byNormalizedName[normalized]) byNormalizedName[normalized] = [];
      byNormalizedName[normalized].push(teacher);
    });

    var report = {
      studentsUpdated: 0, usersLinked: 0, userNamesCanonicalized: 0,
      settlementsUpdated: 0, eventsUpdated: 0,
      unresolvedStudents: [], unresolvedUsers: [], unresolvedSettlements: [], unresolvedEvents: [], conflicts: []
    };

    // 이관과 무관한 DB_수납·DB_휴가기간의 과거 헤더 명칭 차이는 이 작업을 막지 않습니다.
    // DB_명단 역시 기존 1~19열을 변경하지 않고 신규 20열만 검증·추가합니다.
    var studentSheet = TeacherIdMigration_ensureStudentIdColumn_(tx);
    if (studentSheet.getLastRow() > 1) {
      var studentCount = studentSheet.getLastRow() - 1;
      var studentRows = studentSheet.getRange(2, 1, studentCount, COL.STUDENT.TEACHER_ID).getValues();
      var studentIdValues = studentRows.map(function(row, index) {
        var name = String(row[IDX.STUDENT.TEACHER] || "").trim();
        var existingId = String(row[IDX.STUDENT.TEACHER_ID] || "").trim();
        var matched = byName[name] || null;
        if (!name || !matched) {
          report.unresolvedStudents.push({ row: index + 2, studentId: String(row[IDX.STUDENT.ID] || ""), studentName: String(row[IDX.STUDENT.NAME] || ""), teacher: name });
          return [existingId];
        }
        if (existingId && (!byId[existingId] || byId[existingId].name !== name)) {
          report.conflicts.push({ sheet: SHEET_NAMES.STUDENTS, row: index + 2, name: name, existingId: existingId, expectedId: matched.id });
          return [existingId];
        }
        if (!existingId) report.studentsUpdated++;
        return [matched.id];
      });
      tx.writeRange(studentSheet, 2, COL.STUDENT.TEACHER_ID, studentIdValues);
    }

    var userSheet = DataSchema_ensureSheet_(SHEET_NAMES.USERS, tx).sheet;
    if (userSheet.getLastRow() > 1) {
      var userRows = userSheet.getRange(2, 1, userSheet.getLastRow() - 1, COL.USER.TEACHER_ID).getValues();
      userRows.forEach(function(row, index) {
        var email = String(row[IDX.USER.EMAIL] || "").trim().toLowerCase();
        var existingId = String(row[IDX.USER.TEACHER_ID] || "").trim();
        var linked = existingId ? byId[existingId] : null;
        if (existingId && !linked) {
          report.conflicts.push({ sheet: SHEET_NAMES.USERS, row: index + 2, email: email, existingId: existingId });
          return;
        }
        if (!existingId && String(row[IDX.USER.ROLE] || "") !== ACCESS_CONTROL.ROLES.SUPER_ADMIN) {
          var candidates = byNormalizedName[TeacherIdMigration_normalizeUserName_(row[IDX.USER.NAME])] || [];
          if (candidates.length === 1) {
            linked = candidates[0];
            row[IDX.USER.TEACHER_ID] = linked.id;
            report.usersLinked++;
          } else {
            report.unresolvedUsers.push({ row: index + 2, email: email, displayName: String(row[IDX.USER.NAME] || ""), matches: candidates.length });
          }
        }
        if (linked && String(row[IDX.USER.NAME] || "") !== linked.name) {
          row[IDX.USER.NAME] = linked.name;
          report.userNamesCanonicalized++;
        }
        if (linked) {
          row[IDX.USER.UPDATED_AT] = now;
          row[IDX.USER.UPDATED_BY] = actor.email;
        }
      });
      tx.writeRange(userSheet, 2, 1, userRows);
    }

    var settlementSheet = DataSchema_ensureSheet_(SHEET_NAMES.SALARY_SETTLEMENTS, tx).sheet;
    if (settlementSheet.getLastRow() > 1) {
      var settlementRows = settlementSheet.getRange(2, 1, settlementSheet.getLastRow() - 1, COL.SALARY_SETTLEMENT.CONFIRMED_BY).getValues();
      settlementRows.forEach(function(row, index) {
        var name = String(row[IDX.SALARY_SETTLEMENT.TEACHER_NAME] || "").trim();
        var existingId = String(row[IDX.SALARY_SETTLEMENT.TEACHER_ID] || "").trim();
        var matched = byName[name] || null;
        if (!matched) {
          report.unresolvedSettlements.push({ row: index + 2, settlementId: String(row[IDX.SALARY_SETTLEMENT.ID] || ""), teacher: name });
          return;
        }
        if (existingId && existingId !== matched.id) {
          report.conflicts.push({ sheet: SHEET_NAMES.SALARY_SETTLEMENTS, row: index + 2, name: name, existingId: existingId, expectedId: matched.id });
          return;
        }
        if (!existingId) {
          row[IDX.SALARY_SETTLEMENT.TEACHER_ID] = matched.id;
          row[IDX.SALARY_SETTLEMENT.UPDATED_AT] = now;
          report.settlementsUpdated++;
        }
      });
      tx.writeRange(settlementSheet, 2, 1, settlementRows);
    }

    var eventSheet = DataSchema_ensureSheet_(SHEET_NAMES.EVENTS, tx).sheet;
    if (eventSheet.getLastRow() > 1) {
      var eventRows = eventSheet.getRange(2, 1, eventSheet.getLastRow() - 1, EVENT_HEADERS.length).getValues();
      eventRows.forEach(function(row, index) {
        var field = String(row[IDX.EVENT.FIELD] || "").trim();
        if (["담당 원장 변경", "담당 강사 변경", "담당자 변경"].indexOf(field) === -1) return;
        var afterName = String(row[IDX.EVENT.AFTER] || "").trim();
        var existingRef = String(row[IDX.EVENT.REF_ID] || "").trim();
        var matched = byName[afterName] || null;
        if (!matched) {
          report.unresolvedEvents.push({ row: index + 2, eventId: String(row[IDX.EVENT.ID] || ""), teacher: afterName });
          return;
        }
        if (existingRef && existingRef !== matched.id) {
          report.conflicts.push({ sheet: SHEET_NAMES.EVENTS, row: index + 2, name: afterName, existingId: existingRef, expectedId: matched.id });
          return;
        }
        if (!existingRef) {
          row[IDX.EVENT.REF_ID] = matched.id;
          report.eventsUpdated++;
        }
      });
      tx.writeRange(eventSheet, 2, 1, eventRows);
    }

    report.unresolvedCount = report.unresolvedStudents.length + report.unresolvedUsers.length + report.unresolvedSettlements.length + report.unresolvedEvents.length;
    report.conflictCount = report.conflicts.length;
    tx.queueEvent({
      eventType: "기존원장ID이관", targetType: "시스템", targetId: "TEACHER_ID_MIGRATION",
      field: "원장ID보완", before: "이름기반", after: "ID기반",
      memo: safeSheetText_(JSON.stringify({
        studentsUpdated: report.studentsUpdated, usersLinked: report.usersLinked,
        settlementsUpdated: report.settlementsUpdated, eventsUpdated: report.eventsUpdated,
        unresolvedCount: report.unresolvedCount, conflictCount: report.conflictCount
      }), 1000)
    });
    tx.invalidate([SHEET_NAMES.STUDENTS, SHEET_NAMES.USERS, SHEET_NAMES.TEACHERS,
      SHEET_NAMES.SALARY_SETTLEMENTS, SHEET_NAMES.EVENTS]);
    return report;
  });
  migrationReport.rollbackBackup = {
    fileId: rollbackBackup.fileId,
    backupName: rollbackBackup.backupName,
    schemaVerified: !!(rollbackBackup.verification && rollbackBackup.verification.valid)
  };
  return migrationReport;
}

function migrateLegacyTeacherIdsFromMenu() {
  requireSpreadsheetSuperAdmin_();
  var ui = SpreadsheetApp.getUi();
  var answer = ui.alert("기존 원장 ID 보완", "기존 학생·사용자·급여·담당 변경 이벤트를 원장 ID 체계로 보완합니다. 이름이 불명확한 자료는 수정하지 않고 결과에 남깁니다. 계속할까요?", ui.ButtonSet.OK_CANCEL);
  if (answer !== ui.Button.OK) return null;
  var report = migrateLegacyTeacherIds();
  ui.alert("원장 ID 보완 완료", [
    "학생 " + report.studentsUpdated + "건",
    "사용자 연결 " + report.usersLinked + "건",
    "급여 정산 " + report.settlementsUpdated + "건",
    "담당 변경 이벤트 " + report.eventsUpdated + "건",
    "자동 보완 제외 " + report.unresolvedCount + "건 / 충돌 " + report.conflictCount + "건",
    "이관 전 백업: " + report.rollbackBackup.backupName + (report.rollbackBackup.schemaVerified ? " (검증 정상)" : " (원본 복사 보존 · 기존 헤더 경고)"),
    report.unresolvedCount || report.conflictCount ? "세부 내용은 실행 로그의 반환값에서 확인해주세요." : "모든 대상이 정상적으로 연결되었습니다."
  ].join("\n"), ui.ButtonSet.OK);
  console.log("[기존 원장 ID 이관] " + JSON.stringify(report));
  return report;
}

function TeacherDirectory_getRows_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.TEACHERS);
  // 일반 목록 조회에서는 사용자·급여 시트와 전체 이벤트까지 다시 점검하지 않습니다.
  // 원장 시트가 실제로 없거나 비어 있을 때만 생성·초기화를 수행합니다.
  if (!sheet) sheet = DataSchema_ensureSheet_(SHEET_NAMES.TEACHERS).sheet;
  if (sheet.getLastRow() < 2) {
    Management_seedTeachers_(sheet);
  }
  if (sheet.getLastRow() < 2) return [];
  var rows = DataRepository_getRows_(SHEET_NAMES.TEACHERS, { required: false });
  return rows.length > 1 ? rows.slice(1).map(function(row) {
    return row.slice(0, COL.TEACHER.UPDATED_BY);
  }) : [];
}

function TeacherDirectory_toObject_(row) {
  var rawDefaultRate = Number(row[IDX.TEACHER.DEFAULT_RATE]);
  return {
    id: String(row[IDX.TEACHER.ID] || ""),
    name: String(row[IDX.TEACHER.NAME] || ""),
    active: Management_toBoolean_(row[IDX.TEACHER.ACTIVE]),
    defaultRate: isFinite(rawDefaultRate) && rawDefaultRate >= 0 ? rawDefaultRate : 60,
    salaryTarget: Management_toBoolean_(row[IDX.TEACHER.SALARY_TARGET]),
    startDate: row[IDX.TEACHER.START_DATE] ? formatDateOnly_(parseDateOnly_(row[IDX.TEACHER.START_DATE])) : "",
    endDate: row[IDX.TEACHER.END_DATE] ? formatDateOnly_(parseDateOnly_(row[IDX.TEACHER.END_DATE])) : "",
    memo: String(row[IDX.TEACHER.MEMO] || "")
  };
}

function TeacherDirectory_getByName_(name) {
  var target = String(name || "").trim();
  var rows = TeacherDirectory_getRows_();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][IDX.TEACHER.NAME] || "").trim() === target) return TeacherDirectory_toObject_(rows[i]);
  }
  return null;
}

function TeacherDirectory_getById_(teacherId) {
  var target = String(teacherId || "").trim();
  if (!target) return null;
  var rows = TeacherDirectory_getRows_();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][IDX.TEACHER.ID] || "").trim() === target) return TeacherDirectory_toObject_(rows[i]);
  }
  return null;
}

function TeacherDirectory_list_(options) {
  options = options || {};
  return TeacherDirectory_getRows_().map(TeacherDirectory_toObject_).filter(function(item) {
    if (options.activeOnly && !item.active) return false;
    if (options.salaryOnly && !item.salaryTarget) return false;
    return true;
  }).sort(function(a, b) {
    return Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, "ko");
  });
}

/** 한 번의 조회 흐름에서 원장명/ID를 반복 탐색하지 않도록 만드는 읽기 전용 인덱스입니다. */
function TeacherDirectory_buildLookup_(options) {
  var list = TeacherDirectory_list_(options);
  var byId = {};
  var byName = {};
  var idByName = {};
  list.forEach(function(item) {
    byId[item.id] = item;
    byName[item.name] = item;
    idByName[item.name] = item.id;
  });
  return { list: list, byId: byId, byName: byName, idByName: idByName };
}

function getTeacherOptionsForStudentAdd() {
  var user = requireManagerPermission_("STUDENT_ADD");
  var list = TeacherDirectory_list_({ activeOnly: true });
  if (AccessControl_getStudentScope_(user) === STUDENT_ACCESS_SCOPES.ALL_STUDENTS) return list;
  return list.filter(function(item) { return String(item.id) === String(user.teacherId); });
}

function getTeacherOptionsForStudentEdit() {
  var user = requireManagerPermission_("STUDENT_EDIT");
  var list = TeacherDirectory_list_();
  if (AccessControl_getStudentScope_(user) === STUDENT_ACCESS_SCOPES.ALL_STUDENTS) return list;
  return list.filter(function(item) { return String(item.id) === String(user.teacherId); });
}

function getManagedTeachers() {
  requireSuperAdmin_();
  return TeacherDirectory_list_();
}

function saveManagedTeacher(data) {
  requireSuperAdmin_();
  data = data || {};
  return MutationPipeline_run_({ operation: "원장관리" }, function(tx) {
    var sheet = DataSchema_ensureSheet_(SHEET_NAMES.TEACHERS, tx).sheet;
    var id = optionalText_(data.id, 120);
    var name = requireText_(data.name, "원장명", 40);
    var rate = requireNumberInRange_(data.defaultRate == null ? 60 : data.defaultRate, "신규학생 기본 배분율", 0, 100);
    var active = data.active !== false;
    var salaryTarget = data.salaryTarget !== false;
    var startDate = data.startDate ? requireDateString_(data.startDate, "시작일") : "";
    var endDate = data.endDate ? requireDateString_(data.endDate, "종료일") : "";
    if (startDate && endDate && startDate > endDate) throw new Error("종료일은 시작일보다 빠를 수 없습니다.");
    var memo = safeSheetText_(data.memo, 500);
    var user = requireSuperAdmin_();
    var now = new Date();
    var rows = TeacherDirectory_getRows_();
    var targetRow = -1;
    var idMatchCount = 0;
    for (var i = 0; i < rows.length; i++) {
      var rowId = String(rows[i][IDX.TEACHER.ID] || "");
      var rowName = String(rows[i][IDX.TEACHER.NAME] || "").trim();
      if (id && rowId === id) { targetRow = i + 2; idMatchCount++; }
      if ((!id || rowId !== id) && rowName === name) throw new Error("같은 이름의 원장이 이미 등록되어 있습니다.");
    }
    if (id && idMatchCount === 0) throw new Error("수정할 원장 정보를 찾을 수 없습니다. 목록을 새로고침해 주세요.");
    if (idMatchCount > 1) throw new Error("같은 원장 ID가 여러 행에 있습니다. 데이터 생성/보완 진단 결과를 확인해 주세요.");
    if (id && !active) {
      var userSheet = DataSchema_ensureSheet_(SHEET_NAMES.USERS, tx).sheet;
      var linkedUsers = [];
      if (userSheet.getLastRow() > 1) {
        userSheet.getRange(2, 1, userSheet.getLastRow() - 1, COL.USER.TEACHER_ID).getValues().forEach(function(userRow) {
          if (Management_toBoolean_(userRow[IDX.USER.ACTIVE]) && String(userRow[IDX.USER.TEACHER_ID] || "").trim() === id) {
            linkedUsers.push(String(userRow[IDX.USER.EMAIL] || "").trim());
          }
        });
      }
      if (linkedUsers.length) {
        throw new Error("활성 사용자와 연결된 원장은 비활성화할 수 없습니다. 설정에서 연결 원장을 먼저 변경해 주세요: " + linkedUsers.join(", "));
      }
    }
    if (targetRow > 0) {
      var current = sheet.getRange(targetRow, 1, 1, COL.TEACHER.UPDATED_BY).getValues()[0];
      if (String(current[IDX.TEACHER.NAME] || "").trim() !== name) throw new Error("기존 원장명 변경은 학생 이력과 함께 처리해야 하므로 현재 화면에서는 지원하지 않습니다.");
      current[IDX.TEACHER.ACTIVE] = active;
      current[IDX.TEACHER.DEFAULT_RATE] = rate;
      current[IDX.TEACHER.SALARY_TARGET] = salaryTarget;
      current[IDX.TEACHER.START_DATE] = startDate;
      current[IDX.TEACHER.END_DATE] = endDate;
      current[IDX.TEACHER.MEMO] = memo;
      current[IDX.TEACHER.UPDATED_AT] = now;
      current[IDX.TEACHER.UPDATED_BY] = user.email;
      tx.writeRange(sheet, targetRow, 1, [current]);
    } else {
      id = createUniqueId_("TCH");
      tx.appendRows(sheet, [[id, name, active, rate, salaryTarget, startDate, endDate, memo, now, now, user.email]]);
    }
    tx.queueEvent({ eventType: "원장관리", targetType: "원장", targetId: id, field: "원장설정", before: "", after: name + "/" + rate + "%/급여대상:" + salaryTarget, memo: memo });
    tx.invalidate([SHEET_NAMES.TEACHERS]);
    return { id: id, name: name };
  });
}

function TeacherDirectory_salaryNames_(candidateNames) {
  var rows = TeacherDirectory_getRows_();
  if (!rows.length) return (candidateNames || []).filter(function(name) { return !!String(name || "").trim(); });
  var allowed = {};
  rows.map(TeacherDirectory_toObject_).forEach(function(item) { if (item.salaryTarget) allowed[item.name] = true; });
  return (candidateNames || []).filter(function(name) { return allowed[name]; });
}

function openTeacherManagement() {
  requireSpreadsheetSuperAdmin_();
  Management_ensureInfrastructure_();
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createTemplateFromFile("TeacherManagement").evaluate().setWidth(1100).setHeight(800), "원장 관리");
}
