/**
 * ============================================================
 * StuckRowDiagnostics.gs — diagnose + unstick pre-processing rows
 * (Patch 2026-05-19)
 * ============================================================
 *
 * When the deepVerifyTriggers report shows a healthy infrastructure
 * (all 12 triggers present + smoke tests pass) BUT the status
 * distribution shows rows stuck at NEW / blank / RESEARCHING, the
 * problem isn't with the triggers — it's that something is blocking
 * specific rows from being picked up by the scanner.
 *
 * Common causes:
 *   1. Per-row dedupe cache (`AUTO_PROCESSED_ROW_<rowNum>`) keeps
 *      refreshing because a previous run failed mid-processing,
 *      blocking the next scanner cycle.
 *   2. Scanner hits time budget (5-min cron, 6-min Apps Script limit)
 *      before reaching some rows — they re-queue but never get processed.
 *   3. processNextBatch chained trigger is holding the lock while
 *      _scanAndProcessNewRows tries to acquire.
 *   4. Row has malformed data that triggers an early exception before
 *      the state write — error gets swallowed, no notes left.
 *
 * Two functions:
 *
 *   inspectStuckRows(options)   — diagnostic. For each row at NEW/blank/
 *                                  RESEARCHING, dumps every relevant piece
 *                                  of state: status, last_updated age,
 *                                  dedupe cache age, candidate criteria
 *                                  evaluation, notes.
 *
 *   forceScanStuckRows(options) — destructive. Clears dedupe cache for
 *                                  every stuck row + invokes scanner
 *                                  synchronously with extended time budget.
 *                                  If a row STILL fails, the error gets
 *                                  captured by the new stack-trace handler.
 */

/**
 * Read-only diagnostic. Returns a per-row analysis of why each
 * NEW/blank/RESEARCHING row hasn't moved.
 *
 * @param {Object} [options]
 *   {number}  limit            — max rows to inspect (default 50)
 *   {Array<string>} statuses   — which statuses to inspect (default
 *                                 ['NEW', '', 'RESEARCHING', 'CLASSIFYING',
 *                                  'COMPOSING', 'HUMANIZING'])
 * @returns {Object} { scanned, results }
 */
function inspectStuckRows(options) {
  options = options || {};
  var limit = options.limit || 50;
  var targetStatuses = options.statuses || ['NEW', '', 'RESEARCHING', 'CLASSIFYING', 'COMPOSING', 'HUMANIZING'];
  var targetSet = {};
  targetStatuses.forEach(function(s) { targetSet[s] = true; });

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet) return { scanned: 0, results: [], error: 'data sheet missing' };
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { scanned: 0, results: [] };

  var c = CONFIG.COLUMNS;
  var data = sheet.getRange(2, 1, lastRow - 1, CONFIG.SHEET_COL_COUNT).getValues();
  var now = Date.now();
  var ps = PropertiesService.getScriptProperties();

  var results = [];
  var scanned = 0;

  for (var i = 0; i < data.length && results.length < limit; i++) {
    var row = data[i];
    var rowNum = i + 2;
    var status = (row[c.STATUS - 1] || '').toString().trim();
    if (!targetSet[status]) continue;
    scanned++;

    // ── Candidate-criteria evaluation (mirrors _scanAndProcessNewRows) ──
    var linkedinUrl = (row[c.LINKEDIN_URL - 1] || '').toString().trim();
    var fullName = (row[c.FULL_NAME - 1] || '').toString().trim();
    var organization = (row[c.ORGANIZATION - 1] || '').toString().trim();
    var email = (row[c.EMAIL - 1] || '').toString().trim();
    var hasUsableEmail = !!(email && email.indexOf('@') > 0);
    var canGuessEmail = !!(fullName && organization);
    var hasUrlPath = !!(linkedinUrl && /linkedin\.com\/in\//i.test(linkedinUrl));
    var wouldBeCandidate = hasUsableEmail || canGuessEmail || hasUrlPath;

    // ── Dedupe cache ──
    var dedupeKey = 'AUTO_PROCESSED_ROW_' + rowNum;
    var dedupeTs = parseInt(ps.getProperty(dedupeKey) || '0', 10);
    var dedupeAgeMs = dedupeTs > 0 ? (now - dedupeTs) : null;
    var dedupeBlocks = dedupeAgeMs !== null && dedupeAgeMs < 120000;

    // ── LAST_UPDATED age ──
    var lastUpd = row[c.LAST_UPDATED - 1];
    var lastUpdMs = null;
    if (lastUpd) {
      try {
        var ts = (lastUpd instanceof Date) ? lastUpd : new Date(lastUpd);
        if (!isNaN(ts.getTime())) lastUpdMs = ts.getTime();
      } catch (_) {}
    }
    var lastUpdAgeMinutes = lastUpdMs !== null ? Math.floor((now - lastUpdMs) / 60000) : null;

    // ── Why-not synthesis ──
    var blockedBy = [];
    if (!wouldBeCandidate) {
      blockedBy.push('candidate_gate (no usable email, no name+org, no LinkedIn URL)');
    }
    if (dedupeBlocks) {
      blockedBy.push('dedupe_cache (last attempted ' + Math.floor(dedupeAgeMs / 1000) + 's ago)');
    }
    if (status === 'RESEARCHING' && lastUpdAgeMinutes !== null && lastUpdAgeMinutes < 10) {
      blockedBy.push('watchdog_threshold (transient < 10min, will reset later)');
    }
    if (blockedBy.length === 0) {
      blockedBy.push('eligible_should_process_next_tick');
    }

    var fullNameDisplay = fullName || '(no name)';
    var notes = (row[c.NOTES - 1] || '').toString().substring(0, 200);

    results.push({
      rowNum: rowNum,
      status: status || '<blank>',
      fullName: fullNameDisplay,
      organization: organization || '(no org)',
      linkedinUrl: linkedinUrl || '(no URL)',
      candidateCriteria: {
        hasUsableEmail: hasUsableEmail,
        canGuessEmail: canGuessEmail,
        hasUrlPath: hasUrlPath,
        wouldBeCandidate: wouldBeCandidate
      },
      dedupe: {
        keyExists: dedupeTs > 0,
        ageMs: dedupeAgeMs,
        blocksNow: dedupeBlocks
      },
      lastUpdated: {
        raw: lastUpd ? lastUpd.toString() : null,
        ageMinutes: lastUpdAgeMinutes
      },
      blockedBy: blockedBy,
      notesPreview: notes
    });
  }

  return {
    scanned: scanned,
    eligibleCount: results.filter(function(r) {
      return r.blockedBy[0] === 'eligible_should_process_next_tick';
    }).length,
    candidateGateBlocked: results.filter(function(r) {
      return r.blockedBy.some(function(b) { return b.indexOf('candidate_gate') === 0; });
    }).length,
    dedupeBlocked: results.filter(function(r) {
      return r.blockedBy.some(function(b) { return b.indexOf('dedupe_cache') === 0; });
    }).length,
    results: results,
    timestamp: new Date().toISOString()
  };
}

/**
 * Destructive recovery: clears the dedupe cache for every stuck row,
 * resets RESEARCHING rows that are >5 min old back to NEW, then forces
 * a scanner cycle.
 *
 * @param {Object} [options]
 *   {boolean} dryRun                  — scan + report but don't mutate
 *   {boolean} skipForceScanInvocation — clear dedupe only, don't invoke
 *                                       scanner (useful if the cron is
 *                                       guaranteed to fire within 5 min)
 *
 * @returns {Object} { dedupeCleared, transientReset, scannerInvoked, results }
 */
function forceScanStuckRows(options) {
  options = options || {};
  var dryRun = !!options.dryRun;
  var skipScan = !!options.skipForceScanInvocation;

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet) return { error: 'data sheet missing' };
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { dedupeCleared: 0, transientReset: 0, results: [] };

  var c = CONFIG.COLUMNS;
  var data = sheet.getRange(2, 1, lastRow - 1, CONFIG.SHEET_COL_COUNT).getValues();
  var now = Date.now();
  var ps = PropertiesService.getScriptProperties();
  var STUCK_TARGET = { 'NEW': 1, '': 1, 'RESEARCHING': 1, 'CLASSIFYING': 1, 'COMPOSING': 1, 'HUMANIZING': 1 };

  var dedupeCleared = 0;
  var transientReset = 0;
  var results = [];

  // Acquire lock so we don't race with active scanner
  var lock = LockService.getScriptLock();
  var lockHeld = false;
  if (!dryRun) {
    lockHeld = lock.tryLock(15000);
    if (!lockHeld) {
      return { aborted: 'lock_busy', message: 'Cannot acquire script lock — wait 2 min and retry' };
    }
  }

  try {
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      var rowNum = i + 2;
      var status = (row[c.STATUS - 1] || '').toString().trim();
      if (!STUCK_TARGET[status]) continue;

      var dedupeKey = 'AUTO_PROCESSED_ROW_' + rowNum;
      var hadDedupe = !!ps.getProperty(dedupeKey);
      var actions = [];

      // 1. Clear dedupe cache
      if (hadDedupe) {
        if (!dryRun) ps.deleteProperty(dedupeKey);
        actions.push('dedupe_cleared');
        dedupeCleared++;
      }

      // 2. Reset RESEARCHING/etc. rows > 5 min old back to NEW
      var transientStates = { 'RESEARCHING': 1, 'CLASSIFYING': 1, 'COMPOSING': 1, 'HUMANIZING': 1 };
      if (transientStates[status]) {
        var lastUpd = row[c.LAST_UPDATED - 1];
        var ageMs = Infinity;
        if (lastUpd) {
          try {
            var ts = (lastUpd instanceof Date) ? lastUpd : new Date(lastUpd);
            if (!isNaN(ts.getTime())) ageMs = now - ts.getTime();
          } catch (_) {}
        }
        if (ageMs > 5 * 60 * 1000) {
          if (!dryRun) {
            sheet.getRange(rowNum, c.STATUS).setValue('NEW');
            var prevNotes = (row[c.NOTES - 1] || '').toString().substring(0, 300);
            sheet.getRange(rowNum, c.NOTES).setValue(
              ('[forceScanStuckRows ' + new Date().toISOString() + '] Reset transient ' +
               status + ' (age ' + Math.floor(ageMs / 60000) + 'm). Previous: ' + prevNotes).substring(0, 1900));
            sheet.getRange(rowNum, c.LAST_UPDATED).setValue(new Date().toISOString());
          }
          actions.push('transient_reset_to_NEW');
          transientReset++;
        }
      }

      results.push({
        rowNum: rowNum,
        status: status || '<blank>',
        fullName: (row[c.FULL_NAME - 1] || '').toString(),
        actions: actions,
        dryRun: dryRun
      });
    }
  } finally {
    if (lockHeld) lock.releaseLock();
  }

  // 3. Force-invoke the scanner ONCE so eligible rows process immediately
  var scannerResult = null;
  if (!dryRun && !skipScan) {
    try {
      if (typeof _scanAndProcessNewRows === 'function') {
        _scanAndProcessNewRows('FORCED_UNSTICK');
        scannerResult = 'invoked';
      } else {
        scannerResult = 'function_not_found';
      }
    } catch (scanErr) {
      scannerResult = 'threw: ' + scanErr.message;
    }
  }

  Logger.log('[forceScanStuckRows] dedupeCleared=' + dedupeCleared +
             ' transientReset=' + transientReset + ' scanner=' + scannerResult);

  return {
    dedupeCleared: dedupeCleared,
    transientReset: transientReset,
    scannerInvoked: scannerResult,
    dryRun: dryRun,
    results: results,
    timestamp: new Date().toISOString()
  };
}
