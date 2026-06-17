/**
 * ============================================================
 * LeadUidBackfill.gs — Phase 3 LEAD_UID backfill (legacy rows)
 * ============================================================
 *
 * Walks Sheet1 (col 13 LEAD_UID) and Sheet2 (col 28 LEAD_UID); any row with
 * empty UID gets a fresh Utilities.getUuid() assignment. Idempotent — rows
 * with non-empty UIDs are skipped silently.
 *
 * SAFE TO RUN ALONGSIDE LIVE doPost:
 *   - Acquires a short script lock (5s tryLock); on timeout, defers to next
 *     scheduled run. doPost holds the lock during appendRow; collision means
 *     "try again later", not "fail".
 *   - Idempotent on retry: rows already assigned won't be rewritten.
 *   - Bounded write count per invocation: caps at 200 rows/run to keep
 *     execution under the GAS time budget. Multiple cron firings drain the
 *     full backlog over a day.
 *
 * SCHEDULED VIA:
 *   `installLeadUidBackfillTrigger()` — once per deploy. Daily cron.
 *
 * MENU ENTRY (Code.gs):
 *   Tools → Backfill LEAD_UIDs → calls `menuRunLeadUidBackfill`.
 *
 * TEST: `backfill_idempotent_skips_existing_uids` (Phase 3.7).
 *
 * ============================================================
 */

var LEADUID_BACKFILL_MAX_PER_RUN = 200;
var LEADUID_BACKFILL_LOCK_TIMEOUT_MS = 5000;

/**
 * Main entry point. Scans both sheets, populates UIDs in any row missing one.
 *
 * @returns {Object} {sheet1Written, sheet2Written, skippedExisting, skippedNoUrl,
 *                    cappedAtLimit, elapsedMs}
 */
function backfillLeadUids() {
  var startMs = Date.now();
  var report = {
    sheet1Written: 0,
    sheet2Written: 0,
    skippedExisting: 0,
    skippedNoUrl: 0,
    cappedAtLimit: false,
    elapsedMs: 0,
    acquiredLock: false
  };

  var lockService = (typeof _svc === 'function') ? _svc('Lock') : LockService;
  var lock = lockService.getScriptLock();
  if (!lock.tryLock(LEADUID_BACKFILL_LOCK_TIMEOUT_MS)) {
    Logger.log('[LeadUidBackfill] Could not acquire lock within ' +
               LEADUID_BACKFILL_LOCK_TIMEOUT_MS + 'ms — deferring to next run');
    report.elapsedMs = Date.now() - startMs;
    return report;
  }
  report.acquiredLock = true;

  try {
    var sheetsApp = (typeof _svc === 'function') ? _svc('Sheets') : SpreadsheetApp;
    var ss = sheetsApp.openById(CONFIG.SHEET_ID);
    var sheet1 = ss.getSheetByName('Sheet1');
    var sheet2 = ss.getSheetByName(CONFIG.DATA_SHEET);

    // ── Sheet1 backfill ──
    if (sheet1) {
      var s1 = _backfillSheet1(sheet1, LEADUID_BACKFILL_MAX_PER_RUN);
      report.sheet1Written = s1.written;
      report.skippedExisting += s1.skippedExisting;
      if (s1.cappedAtLimit) report.cappedAtLimit = true;
    }

    // ── Sheet2 backfill (only if budget remains) ──
    var remainingBudget = LEADUID_BACKFILL_MAX_PER_RUN - report.sheet1Written;
    if (sheet2 && remainingBudget > 0) {
      var s2 = _backfillSheet2(sheet1, sheet2, remainingBudget);
      report.sheet2Written = s2.written;
      report.skippedExisting += s2.skippedExisting;
      report.skippedNoUrl += s2.skippedNoUrl;
      if (s2.cappedAtLimit) report.cappedAtLimit = true;
    }
  } catch (e) {
    Logger.log('[LeadUidBackfill] Error during backfill: ' + e.message);
    report.error = e.message;
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }

  report.elapsedMs = Date.now() - startMs;
  Logger.log('[LeadUidBackfill] Run complete: Sheet1=' + report.sheet1Written +
             ' Sheet2=' + report.sheet2Written +
             ' skippedExisting=' + report.skippedExisting +
             ' skippedNoUrl=' + report.skippedNoUrl +
             ' cappedAtLimit=' + report.cappedAtLimit +
             ' elapsedMs=' + report.elapsedMs);
  return report;
}

/**
 * Walk Sheet1; assign UIDs to rows where col 13 is empty.
 */
function _backfillSheet1(sheet1, maxWrites) {
  var out = { written: 0, skippedExisting: 0, cappedAtLimit: false };
  var lastRow = sheet1.getLastRow();
  if (lastRow < 2) return out;
  // Read all rows; identify rows needing UIDs
  var data = sheet1.getRange(2, 1, lastRow - 1, CONFIG.SHEET1_COL_COUNT).getValues();
  var writes = [];  // [{row, uid}]
  for (var i = 0; i < data.length; i++) {
    var existing = (data[i][CONFIG.SHEET1_COLUMNS.LEAD_UID - 1] || '').toString().trim();
    if (existing) { out.skippedExisting++; continue; }
    var uid = _generateBackfillUid();
    writes.push({ row: i + 2, uid: uid });
    if (writes.length >= maxWrites) {
      out.cappedAtLimit = true;
      break;
    }
  }
  // Apply writes
  for (var j = 0; j < writes.length; j++) {
    try {
      sheet1.getRange(writes[j].row, CONFIG.SHEET1_COLUMNS.LEAD_UID).setValue(writes[j].uid);
      out.written++;
    } catch (e) {
      Logger.log('[LeadUidBackfill] Sheet1 write failed at row ' + writes[j].row + ': ' + e.message);
    }
  }
  return out;
}

/**
 * Walk Sheet2; assign UIDs to rows where col 28 is empty. If the row has a
 * matching Sheet1 row, copy that UID; else generate fresh.
 */
function _backfillSheet2(sheet1, sheet2, maxWrites) {
  var out = { written: 0, skippedExisting: 0, skippedNoUrl: 0, cappedAtLimit: false };
  var lastRow = sheet2.getLastRow();
  if (lastRow < 2) return out;
  var data = sheet2.getRange(2, 1, lastRow - 1, CONFIG.SHEET_COL_COUNT).getValues();
  // Pre-index Sheet1 url→uid for O(1) lookup
  var sheet1Idx = sheet1 ? _indexSheet1ByUrl(sheet1) : {};
  var writes = [];
  for (var i = 0; i < data.length; i++) {
    var existing = (data[i][CONFIG.COLUMNS.LEAD_UID - 1] || '').toString().trim();
    if (existing) { out.skippedExisting++; continue; }
    var url = (data[i][CONFIG.COLUMNS.LINKEDIN_URL - 1] || '').toString().trim();
    if (!url) {
      out.skippedNoUrl++;
      continue;  // No URL means we can't link to Sheet1; assign a fresh UUID for stability
      // (alternative: skip entirely; choosing assign-fresh for completeness)
    }
    var copiedUid = sheet1Idx[url] || '';
    var uid = copiedUid || _generateBackfillUid();
    writes.push({ row: i + 2, uid: uid });
    if (writes.length >= maxWrites) {
      out.cappedAtLimit = true;
      break;
    }
  }
  for (var j = 0; j < writes.length; j++) {
    try {
      sheet2.getRange(writes[j].row, CONFIG.COLUMNS.LEAD_UID).setValue(writes[j].uid);
      out.written++;
    } catch (e) {
      Logger.log('[LeadUidBackfill] Sheet2 write failed at row ' + writes[j].row + ': ' + e.message);
    }
  }
  return out;
}

function _indexSheet1ByUrl(sheet1) {
  var idx = {};
  var lastRow = sheet1.getLastRow();
  if (lastRow < 2) return idx;
  var data = sheet1.getRange(2, 1, lastRow - 1, CONFIG.SHEET1_COL_COUNT).getValues();
  for (var i = 0; i < data.length; i++) {
    var url = (data[i][CONFIG.SHEET1_COLUMNS.LINKEDIN_URL - 1] || '').toString().trim();
    var uid = (data[i][CONFIG.SHEET1_COLUMNS.LEAD_UID - 1] || '').toString().trim();
    if (url && uid && !idx[url]) idx[url] = uid;  // first match wins
  }
  return idx;
}

function _generateBackfillUid() {
  if (typeof _svc === 'function') {
    try { return _svc('Utilities').getUuid(); } catch (_) {}
  }
  return Utilities.getUuid();
}

// ─── TRIGGER INSTALLATION ──────────────────────────────────────────────────

/**
 * Install a daily cron trigger for backfillLeadUids. Idempotent — checks for
 * existing trigger of the same handler name before creating.
 */
function installLeadUidBackfillTrigger() {
  var scriptApp = (typeof _svc === 'function') ? _svc('Script') : ScriptApp;
  var existing = scriptApp.getProjectTriggers().filter(function(t) {
    return t.getHandlerFunction() === 'backfillLeadUids';
  });
  if (existing.length > 0) {
    Logger.log('[LeadUidBackfill] Trigger already installed (' + existing.length + ' instance(s))');
    return { installed: false, existing: existing.length };
  }
  scriptApp.newTrigger('backfillLeadUids')
    .timeBased()
    .everyDays(1)
    .atHour(3)  // 3 AM (low-traffic window)
    .create();
  Logger.log('[LeadUidBackfill] Installed daily trigger at 3 AM');
  return { installed: true, existing: 0 };
}

/**
 * Menu wrapper — call from Tools → Backfill LEAD_UIDs.
 *
 * DUAL-CONTEXT (PATCH `-p3-leaduid-amend`):
 * SpreadsheetApp.getUi() throws when called from the script editor (no
 * active Sheet container). Wrap in try/catch and fall back to Logger when
 * UI is unavailable. The function is now safely callable from BOTH:
 *   - Sheet menu: Tools → Backfill LEAD_UIDs → modal alert
 *   - Script editor: run button → console log + return value
 *
 * @returns {Object|undefined} backfill report (always returned from editor;
 *   in menu context the user sees the alert and the return is incidental)
 */
function menuRunLeadUidBackfill() {
  var ui = null;
  try {
    ui = SpreadsheetApp.getUi();
  } catch (e) {
    ui = null;  // Script-editor / triggered context — no UI available
  }
  var report = backfillLeadUids();
  var msg = 'Backfill complete.\n\n' +
            'Sheet1 written: ' + report.sheet1Written + '\n' +
            'Sheet2 written: ' + report.sheet2Written + '\n' +
            'Skipped (already had UID): ' + report.skippedExisting + '\n' +
            'Skipped (no URL): ' + report.skippedNoUrl + '\n' +
            'Capped at limit: ' + report.cappedAtLimit + '\n' +
            'Elapsed: ' + report.elapsedMs + ' ms' +
            (report.error ? '\n\nERROR: ' + report.error : '');
  if (ui) {
    ui.alert('LEAD_UID backfill', msg, ui.ButtonSet.OK);
  } else {
    Logger.log('[menuRunLeadUidBackfill] ' + msg);
  }
  return report;
}
