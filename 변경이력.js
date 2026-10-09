function openChangeLogViewer() {
  requireSpreadsheetSuperAdmin_();
  var html = HtmlService.createTemplateFromFile('ChangeLogViewer').evaluate()
      .setWidth(1100)
      .setHeight(760);
  SpreadsheetApp.getUi().showModalDialog(html, '변경 이력 뷰어');
}

function getChangeLogData(filters) {
  var startedAt = Date.now();
  requireSuperAdmin_();
  filters = filters || {};
  var values = DataRepository_getRows_(SHEET_NAMES.LOGS, { required: false });
  if (values.length <= 1) {
    return { rows: [], types: [], message: "변경 이력이 없습니다." };
  }

  var tz = Session.getScriptTimeZone();
  var q = String(filters.query || "").replace(/\s+/g, "").toLowerCase();
  var typeFilter = String(filters.type || "ALL");
  var from = filters.from ? new Date(filters.from + "T00:00:00") : null;
  var to = filters.to ? new Date(filters.to + "T23:59:59") : null;
  var types = {};
  var matchedRows = [];
  var pageSize = Math.max(20, Math.min(200, Number(filters.pageSize) || 100));
  var page = Math.max(1, Math.floor(Number(filters.page) || 1));
  var studentNameById = {};
  var studentRows = DataRepository_getRows_(SHEET_NAMES.STUDENTS, { required: false });
  for (var s = 1; s < studentRows.length; s++) {
    studentNameById[String(studentRows[s][IDX.STUDENT.ID] || "").trim()] =
      String(studentRows[s][IDX.STUDENT.NAME] || "");
  }

  for (var i = values.length - 1; i >= 1; i--) {
    var row = values[i];
    var created = row[IDX.LOG.CREATED_AT];
    var createdDate = created instanceof Date ? created : new Date(created);
    var item = String(row[IDX.LOG.ITEM] || "");
    var studentId = String(row[IDX.LOG.STUDENT_ID] || "");
    var name = String(row[IDX.LOG.STUDENT_NAME] || studentNameById[studentId] || "");

    if (item) types[item] = true;
    if (typeFilter !== "ALL" && item !== typeFilter) continue;
    if (from && !isNaN(createdDate.getTime()) && createdDate < from) continue;
    if (to && !isNaN(createdDate.getTime()) && createdDate > to) continue;

    if (q) {
      var haystack = (name + studentId + item + row[IDX.LOG.BEFORE] + row[IDX.LOG.AFTER]).replace(/\s+/g, "").toLowerCase();
      if (haystack.indexOf(q) === -1) continue;
    }

    matchedRows.push({
      rowNumber: i + 1,
      createdAt: createdDate instanceof Date && !isNaN(createdDate.getTime())
        ? Utilities.formatDate(createdDate, tz, "yyyy-MM-dd HH:mm")
        : String(created || ""),
      studentName: name,
      studentId: studentId,
      item: item,
      before: String(row[IDX.LOG.BEFORE] || ""),
      after: String(row[IDX.LOG.AFTER] || ""),
      effectiveDate: formatLogDate_(row[IDX.LOG.EFFECTIVE_DATE], tz)
    });

  }

  var total = matchedRows.length;
  var totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (page > totalPages) page = totalPages;
  var offset = (page - 1) * pageSize;
  var rows = matchedRows.slice(offset, offset + pageSize);

  var result = {
    rows: rows,
    types: Object.keys(types).sort(),
    total: total,
    page: page,
    pageSize: pageSize,
    totalPages: totalPages,
    hasPrevious: page > 1,
    hasNext: page < totalPages,
    message: total ? "총 " + total + "건 중 " + (offset + 1) + "~" + (offset + rows.length) + "건" : ""
  };
  console.log("[변경 이력 조회 성능] " + JSON.stringify({
    page: page, pageSize: pageSize, total: total, returned: rows.length,
    responseChars: JSON.stringify(result).length,
    totalMs: Date.now() - startedAt
  }));
  return result;
}

function formatLogDate_(value, tz) {
  if (!value) return "";
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, tz, "yyyy-MM-dd");
  }
  return String(value);
}
