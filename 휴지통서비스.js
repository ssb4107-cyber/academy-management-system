var TRASH_HEADERS = ["휴지통ID", "삭제일시", "영구삭제예정일", "원본시트", "레코드ID", "학생ID", "학생명", "삭제자", "삭제사유", "원본행JSON", "상태", "복구일시", "복구자"];

function Trash_serializeRow_(row) {
  return JSON.stringify(row.map(function(value) {
    return value instanceof Date ? { __trashDate: value.toISOString() } : value;
  }));
}

function Trash_deserializeRow_(text) {
  return JSON.parse(text).map(function(value) {
    return value && value.__trashDate ? new Date(value.__trashDate) : value;
  });
}

function Trash_addMonthsClamped_(date, months) {
  var targetMonthStart = new Date(date.getFullYear(), date.getMonth() + months, 1);
  var lastDay = new Date(targetMonthStart.getFullYear(), targetMonthStart.getMonth() + 1, 0).getDate();
  return new Date(targetMonthStart.getFullYear(), targetMonthStart.getMonth(), Math.min(date.getDate(), lastDay), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
}

function openTrashManager() {
  requireSpreadsheetSuperAdmin_();
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createTemplateFromFile("TrashManager").evaluate().setWidth(700).setHeight(600), "휴지통");
}

function getTrashItems() {
  requireSuperAdmin_();
  var rows = DataRepository_getRows_(SHEET_NAMES.TRASH, { required: false });
  return rows.slice(1).filter(function(row) { return row[10] === "보관중"; }).map(function(row) {
    return { trashId: row[0], deletedAt: String(row[1]), purgeAt: formatDateOnly_(parseDateOnly_(row[2])), sourceSheet: row[3], recordId: row[4], studentId: row[5], studentName: row[6], deletedBy: row[7], reason: row[8] };
  });
}

function installTrashCleanupTrigger() {
  requireSuperAdmin_();
  // 예전에 이 함수를 직접 실행한 경우에도 통합 운영 트리거를 설치합니다.
  return installMaintenanceTrigger();
}
