/**
 * ============================================================
 * Watchdog.gs — Stuck-State Resumability (v2 Track G)
 * ============================================================
 *
 * Closes the resumability gap (invariant I9): without a watchdog, leads
 * stuck in transient processing states (RESEARCHING, CLASSIFYING, COMPOSING,
 * HUMANIZING) due to crashes or GAS time-outs sat indefinitely, requiring
 * manual `reset_stuck_leads` intervention. Watchdog runs every 15 minutes
 * via installable trigger, detects rows in transient states older than
 * 10 minutes, and resets them to NEW so the safety-net scanner picks them up.
 *
 * Intentional non-actions:
 *   - Does NOT touch terminal states: DRAFT_CREATED, SENT, FOLLOWUP_*,
 *     RESPONDED, SKIPPED, NEEDS_EMAIL, NEEDS_EMAIL_REVIEW, NEEDS_REVIEW
 *     (Tier 3 deterministic fallback — requires human action, not retry)
 *   - Does NOT touch ERROR rows (those are legitimately failed and need
 *     human inspection; reset_stuck_leads remains the escape hatch)
 *   - Does NOT touch REVIEW (validator decided to flag for human review)
 *   - Does NOT touch REOON_RETRY_PENDING (has its own retry-after timestamp)
 *
 * What it DOES reset:
 *   - RESEARCHING, CLASSIFYING, COMPOSING, HUMANIZING — transient processing
 *     states that should never persist >10 min. If they do, the lead was
 *     left stranded by a process kill (GAS 6-min limit hit, exception
 *     swallowed without rollback, etc.)
 *
 * Idempotent: re-running on the same sheet a second later produces no
 * additional resets because the rows are now STATUS=NEW.
 */

var WATCHDOG_TRANSIENT_STATES = ['RESEARCHING', 'CLASSIFYING', 'COMPOSING', 'HUMANIZING'];
var WATCHDOG_STUCK_THRESHOLD_MS = 10 * 60 * 1000;   // 10 minutes

// PATCH 2026-05-18: stale REOON_RETRY_PENDING sweep. A lead in this state
// has its own retry-after timestamp embedded in NOTES (`retryAfter:<ms>`)
// and the scanner waits for that. But if the scanner is starved (heavy
// load) or the timestamp got corrupted, the lead can sit indefinitely.
// This sweep catches REOON_RETRY_PENDING rows whose LAST_UPDATED is older
// than 24 hours and escalates them to NEEDS_PRE_SEND_REVIEW (manual decision).
var WATCHDOG_REOON_STALE_MS = 24 * 60 * 60 * 1000;   // 24 hours

/**
 * Scans Sheet2 for stuck transient rows, resets to NEW. Installable trigger
 * runs this every 15 minutes via `installWatchdogTrigger()`. Manual invocation
 * also safe.
 *
 * Detection uses the LAST_UPDATED column (CONFIG.COLUMNS.LAST_UPDATED, col U).
 * If that's blank, falls back to assuming the row is stuck (worst case: a
 * new row is reset within seconds — harmless, scanner picks it up immediately).
 *
 * @returns {Object} { scanned, resetCount, resetRows: [{rowNum, prevStatus, ageMin}] }
 */
function runWatchdog() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet) {
    Logger.log('[Watchdog] Data sheet missing: ' + CONFIG.DATA_SHEET);
    return { scanned: 0, resetCount: 0, resetRows: [] };
  }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { scanned: 0, resetCount: 0, resetRows: [] };

  var c = CONFIG.COLUMNS;
  var data = sheet.getRange(2, 1, lastRow - 1, CONFIG.SHEET_COL_COUNT).getValues();
  var now = Date.now();
  var scanned = 0, resetCount = 0;
  var resetRows = [];

  // Acquire lock to avoid racing with active batch processor or admin endpoints
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) {
    Logger.log('[Watchdog] Could not acquire lock — skipping this cycle');
    return { scanned: 0, resetCount: 0, resetRows: [], skipped: 'lock_busy' };
  }

  var escalatedRows = [];
  var escalatedCount = 0;

  try {
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      var rowNum = i + 2;
      var status = (row[c.STATUS - 1] || '').toString().trim();

      // ─── Transient-state reset (existing behavior) ────────────────────
      if (WATCHDOG_TRANSIENT_STATES.indexOf(status) >= 0) {
        scanned++;
        // Read LAST_UPDATED to compute age. If missing/unparseable, treat as stuck.
        var lastUpdRaw = row[c.LAST_UPDATED - 1];
        var ageMs = WATCHDOG_STUCK_THRESHOLD_MS + 1;  // default to stuck if undetermined
        if (lastUpdRaw) {
          try {
            var ts = new Date(lastUpdRaw);
            if (!isNaN(ts.getTime())) ageMs = now - ts.getTime();
          } catch (_) {}
        }

        if (ageMs > WATCHDOG_STUCK_THRESHOLD_MS) {
          var ageMin = Math.floor(ageMs / 60000);
          try {
            var prevNotes = (row[c.NOTES - 1] || '').toString().substring(0, 400);
            var newNotes = '[Watchdog reset ' + new Date().toISOString() + '] was=' + status +
                           ' age=' + ageMin + 'min. Previous notes: ' + prevNotes;
            sheet.getRange(rowNum, c.STATUS).setValue(STATUS.NEW);
            sheet.getRange(rowNum, c.NOTES).setValue(newNotes.substring(0, 1500));
            sheet.getRange(rowNum, c.LAST_UPDATED).setValue(new Date().toISOString());
            resetCount++;
            resetRows.push({ rowNum: rowNum, prevStatus: status, ageMin: ageMin });
            Logger.log('[Watchdog] Reset row ' + rowNum + ' (was ' + status + ', age ' + ageMin + ' min)');
          } catch (resetErr) {
            Logger.log('[Watchdog] Reset failed for row ' + rowNum + ': ' + resetErr.message);
          }
        }
        continue;
      }

      // ─── PATCH 2026-05-18: REOON_RETRY_PENDING stale-escalation ──────
      //
      // Defense-in-depth: PSV now caps retries at 3 (PreSendVerifier.gs
      // PSV_MAX_REOON_RETRIES) so most leads exit the retry loop within
      // a few hours. But if the retryCount tracker got corrupted, the
      // retryAfter timestamp got mangled, or a code path bypassed the
      // counter, this sweep is the final backstop. Any REOON_RETRY_PENDING
      // row last updated >24h ago is escalated.
      if (status === 'REOON_RETRY_PENDING') {
        var lastUpdRaw2 = row[c.LAST_UPDATED - 1];
        var ageMs2 = 0;
        if (lastUpdRaw2) {
          try {
            var ts2 = new Date(lastUpdRaw2);
            if (!isNaN(ts2.getTime())) ageMs2 = now - ts2.getTime();
          } catch (_) {}
        } else {
          // No LAST_UPDATED — treat as stale (timestamp probably never written)
          ageMs2 = WATCHDOG_REOON_STALE_MS + 1;
        }

        if (ageMs2 > WATCHDOG_REOON_STALE_MS) {
          var ageHr = Math.floor(ageMs2 / 3600000);
          try {
            var prevNotes2 = (row[c.NOTES - 1] || '').toString().substring(0, 400);
            var newNotes2 = '[Watchdog ESCALATED ' + new Date().toISOString() + '] ' +
                            'REOON_RETRY_PENDING stale for ' + ageHr + 'h — escalating to ' +
                            'NEEDS_PRE_SEND_REVIEW for manual decision. Previous notes: ' + prevNotes2;
            sheet.getRange(rowNum, c.STATUS).setValue('NEEDS_PRE_SEND_REVIEW');
            sheet.getRange(rowNum, c.NOTES).setValue(newNotes2.substring(0, 1500));
            sheet.getRange(rowNum, c.LAST_UPDATED).setValue(new Date().toISOString());
            escalatedCount++;
            escalatedRows.push({ rowNum: rowNum, ageHr: ageHr });
            Logger.log('[Watchdog] Escalated row ' + rowNum + ' (REOON_RETRY_PENDING, age ' + ageHr + 'h)');
          } catch (escErr) {
            Logger.log('[Watchdog] Escalation failed for row ' + rowNum + ': ' + escErr.message);
          }
        }
      }
    }
  } finally {
    lock.releaseLock();
  }

  if (resetCount > 0) {
    logPipelineEvent(null, 'WATCHDOG',
      'Reset ' + resetCount + ' stuck rows: ' + resetRows.map(function(r) {
        return r.rowNum + '(' + r.prevStatus + '/' + r.ageMin + 'min)';
      }).join(', '), 'WARN');
  }
  if (escalatedCount > 0) {
    logPipelineEvent(null, 'WATCHDOG',
      'Escalated ' + escalatedCount + ' stale REOON_RETRY_PENDING rows to manual review: ' +
      escalatedRows.map(function(r) { return r.rowNum + '(' + r.ageHr + 'h)'; }).join(', '),
      'WARN');
  }
  Logger.log('[Watchdog] Cycle done — scanned=' + scanned + ' transient, reset=' + resetCount +
             ', escalated=' + escalatedCount + ' stale REOON_RETRY_PENDING');
  return {
    scanned: scanned,
    resetCount: resetCount,
    resetRows: resetRows,
    escalatedCount: escalatedCount,
    escalatedRows: escalatedRows
  };
}

/**
 * Installs the 15-min watchdog trigger. Idempotent.
 * @returns {string} status
 */
function installWatchdogTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var exists = triggers.some(function(t) {
    return t.getHandlerFunction() === 'runWatchdog';
  });
  if (exists) return 'already_installed';
  ScriptApp.newTrigger('runWatchdog')
    .timeBased()
    .everyMinutes(15)
    .create();
  return 'installed_every_15min';
}
