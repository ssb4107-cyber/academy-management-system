/** 데이터 변경, 이벤트 기록, 캐시 무효화를 묶는 공통 실행기 */
function MutationPipeline_run_(options, executor) {
  options = options || {};
  var authorizedUser = null;
  var suppliedUser = options.authorizedUser || null;
  // 일반 관리자는 승인요청 전용 파이프라인만 사용할 수 있습니다.
  if (options.automationAuthorized === true) {
    // 뒤에 밑줄이 붙은 내부 함수에서, 자동 실행 인증을 먼저 마친 경우에만 사용합니다.
  } else if (suppliedUser) {
    if (!suppliedUser.email) throw new Error("인증된 작업자 정보를 확인할 수 없습니다.");
    if (options.allowManagerPortal === true) {
      if (!suppliedUser.bootstrap && suppliedUser.role !== ACCESS_CONTROL.ROLES.MANAGER) {
        throw new Error("이 작업을 수행할 권한이 없습니다.");
      }
    } else if (!suppliedUser.bootstrap && suppliedUser.role !== ACCESS_CONTROL.ROLES.SUPER_ADMIN) {
      throw new Error("이 작업을 수행할 권한이 없습니다.");
    }
    authorizedUser = suppliedUser;
  } else if (options.allowManagerPortal === true) authorizedUser = requireRole_([ACCESS_CONTROL.ROLES.MANAGER]);
  else authorizedUser = requireSuperAdmin_();
  return withDocumentLock_(function() {
    // 모든 변경은 감사 이벤트를 남기므로, 실제 데이터에 손대기 전에 이벤트 스키마부터 검증합니다.
    if (!options.skipSchemaPreflight) {
      DataSchema_assertManagedStructure_();
      DataSchema_ensureSheet_(SHEET_NAMES.EVENTS);
    }
    var rollbackActions = [];
    var auditEvents = [];
    var invalidations = {};
    var touchedSheetNames = {};
    var invalidatedMonths = {};
    var invalidateAllMonthlyData = false;

    function addRollback(action) {
      if (typeof action === "function") rollbackActions.push(action);
    }

    function markTouched(sheet) {
      try {
        var sheetName = sheet && sheet.getName ? sheet.getName() : "";
        if (sheetName) touchedSheetNames[sheetName] = true;
      } catch (ignoredSheetNameError) {}
    }

    function writeRange(sheet, row, column, values) {
      if (!sheet) throw new Error("변경 대상 시트를 찾을 수 없습니다.");
      if (!values || !values.length || !values[0].length) return;
      var range = sheet.getRange(row, column, values.length, values[0].length);
      var before = range.getValues();
      addRollback(function() { range.setValues(before); });
      range.setValues(values);
      markTouched(sheet);
    }

    function appendRows(sheet, rows) {
      if (!sheet) throw new Error("기록 대상 시트를 찾을 수 없습니다.");
      if (!rows || !rows.length) return null;
      var startRow = sheet.getLastRow() + 1;
      var requiredLastRow = startRow + rows.length - 1;
      var insertedRows = Math.max(0, requiredLastRow - sheet.getMaxRows());
      if (insertedRows) {
        sheet.insertRowsAfter(sheet.getMaxRows(), insertedRows);
        markTouched(sheet);
        addRollback(function() {
          sheet.deleteRows(sheet.getMaxRows() - insertedRows + 1, insertedRows);
        });
      }
      var range = sheet.getRange(startRow, 1, rows.length, rows[0].length);
      var before = range.getValues();
      addRollback(function() { range.setValues(before); });
      range.setValues(rows);
      markTouched(sheet);
      return { startRow: startRow, count: rows.length };
    }

    function deleteRows(sheet, startRow, count) {
      if (!sheet) throw new Error("삭제 대상 시트를 찾을 수 없습니다.");
      count = count || 1;
      var width = sheet.getLastColumn();
      var before = sheet.getRange(startRow, 1, count, width).getValues();
      sheet.deleteRows(startRow, count);
      markTouched(sheet);
      addRollback(function() {
        if (startRow <= sheet.getMaxRows()) sheet.insertRowsBefore(startRow, count);
        else sheet.insertRowsAfter(sheet.getMaxRows(), count);
        sheet.getRange(startRow, 1, count, width).setValues(before);
      });
      return before;
    }

    function queueEvent(event) {
      auditEvents.push(event);
    }

    function invalidate(sheetNames) {
      (sheetNames || []).forEach(function(sheetName) { invalidations[sheetName] = true; });
    }

    function invalidateMonths(months) {
      (months || []).forEach(function(month) {
        var ym = MonthlySnapshot_monthString_(month);
        if (ym) invalidatedMonths[ym] = true;
      });
    }

    function invalidateAllMonths() { invalidateAllMonthlyData = true; }

    var context = {
      addRollback: addRollback,
      writeRange: writeRange,
      appendRows: appendRows,
      deleteRows: deleteRows,
      queueEvent: queueEvent,
      invalidate: invalidate,
      invalidateMonths: invalidateMonths,
      invalidateAllMonths: invalidateAllMonths
    };

    try {
      var result = executor(context);
      Mutation_recordEvents_(auditEvents, authorizedUser);
      Object.keys(invalidations).forEach(function(sheetName) {
        try { DataRepository_clearCache_(sheetName); } catch (cacheError) { logError_("변경 후 캐시 삭제 " + sheetName, cacheError); }
      });
      if (invalidations[SHEET_NAMES.STUDENTS] || invalidations[SHEET_NAMES.PAYMENTS] || invalidations[SHEET_NAMES.VACATIONS]) {
        var months = Object.keys(invalidatedMonths);
        if (!invalidateAllMonthlyData && months.length) MonthlyCache_markMonthsDirty_(months);
        else MonthlyCache_markAllDirty_();
        // 학생 변경은 학생 시트 세대번호로 자동 구분됩니다. 월별 파생값에 직접
        // 영향을 주는 휴가만 별도 스냅샷 세대를 갱신하여 수납 변경 때문에 학생
        // 파생 스냅샷까지 불필요하게 재생성되지 않도록 합니다.
        if (invalidations[SHEET_NAMES.VACATIONS]) {
          if (!invalidateAllMonthlyData && months.length) MonthlySnapshotStore_markMonthsStale_(months);
          else MonthlySnapshotStore_markAllStale_();
        }
      }
      if (Object.keys(invalidations).length) markHomeDashboardDirty_();
      return result;
    } catch (error) {
      var rollbackErrors = [];
      for (var r = rollbackActions.length - 1; r >= 0; r--) {
        try { rollbackActions[r](); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      var rollbackCacheTargets = {};
      Object.keys(invalidations).concat(Object.keys(touchedSheetNames)).forEach(function(sheetName) {
        rollbackCacheTargets[sheetName] = true;
      });
      Object.keys(rollbackCacheTargets).forEach(function(sheetName) {
        try { DataRepository_clearCache_(sheetName); } catch (ignoredCacheError) {}
      });
      if (rollbackErrors.length) {
        // 일부 원본이 복구되지 않았을 수 있으므로 영향 월을 추정하지 않고 전체 결과를 폐기합니다.
        try { MonthlyCache_markAllDirty_(); } catch (ignoredMonthlyCacheError) {}
        try { MonthlySnapshotStore_markAllStale_(); } catch (ignoredSnapshotCacheError) {}
        try { markHomeDashboardDirty_(); } catch (ignoredHomeCacheError) {}
        logError_("변경 작업 자동복구 일부 실패 " + (options.operation || ""), rollbackErrors[0]);
        throw new Error((error && error.message ? error.message : error) + " (자동복구 일부 실패: 관리자 확인 필요)");
      }
      throw error;
    }
  });
}
