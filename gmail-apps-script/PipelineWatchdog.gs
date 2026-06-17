/**
 * ============================================================
 * PipelineWatchdog.gs - Self-healing pipeline supervisor
 * (Patch 2026-05-20)
 * ============================================================
 *
 * Runs every 30 minutes via its own time-based trigger. Five jobs:
 *
 *   1. TRIGGER HEALTH
 *      Verifies every critical handler is installed (onSheetChange,
 *      onSheetEdit, autoProcessSafetyNet). Re-installs anything missing.
 *      This is the fix for the recurring failure mode "rows added but
 *      never processed" — usually the scanner trigger silently dropped
 *      after an Apps Script quota event or auth re-grant.
 *
 *   2. STUCK-TRANSIENT RESET
 *      Rows that have been at RESEARCHING / COMPOSING / HUMANIZING /
 *      QUALITY_CHECK for more than 30 minutes are stale — the run that
 *      was processing them crashed silently. Reset to NEW so the next
 *      scanner tick picks them up under the no-termination pipeline.
 *
 *   3. STALE-TERMINAL AUTO-RETRY
 *      Rows that landed at NEEDS_EMAIL / NEEDS_EMAIL_REVIEW / NEEDS_REVIEW /
 *      REVIEW / ERROR more than 6 hours ago get auto-reset to NEW so they
 *      re-flow under the latest pipeline logic. Bounded by errRetry counter
 *      (max 2) — exhausted rows are left for human inspection.
 *
 *   4. SHEET2 DESYNC DETECTION
 *      For every row, compare the lead's LinkedIn URL against the
 *      ENRICHED_EMAIL domain. If the email's local-part doesn't look
 *      like the lead's name AND the domain doesn't match the lead's
 *      organization, flag as desync candidate. Top 5 candidates get
 *      their state columns cleared (ENRICHED_EMAIL, EMAIL_SOURCE,
 *      EMAIL_CONFIDENCE, DRAFT_ID) and STATUS reset to NEW. Pipeline
 *      re-enriches under URL-keyed defensive writes.
 *
 *   5. API HEALTH LOG
 *      Probes Reoon + Apollo + Hunter live with cached credentials.
 *      Result written to script properties + a daily audit log row.
 *      No alert wiring — visible via diagnose_pipeline_health endpoint.
 *
 * INSTALL: call `installPipelineWatchdog()` once. The function will
 * (a) install its own 30-min trigger, (b) install all required scanner
 * triggers, (c) seed the audit log property.
 */

// ─── PUBLIC ENTRY POINT ────────────────────────────────────────────────────

/**
 * The 30-min cron. Idempotent — safe to call manually any time.
 * Returns a summary object for the admin endpoint to surface.
 */
function pipelineWatchdog() {
  var startTime = Date.now();
  var report = {
    timestamp: new Date().toISOString(),
    triggers: { ok: 0, repaired: [], failures: [] },
    transientResets: 0,
    staleTerminalResets: 0,
    desyncFixed: 0,
    apiHealth: {},
    elapsedMs: 0,
    errors: []
  };

  // Job 1: trigger health
  try {
    var triggerReport = _wdEnsureTriggersHealthy();
    report.triggers = triggerReport;
  } catch (e) {
    report.errors.push('trigger_health: ' + e.message);
  }

  // Job 2: stuck-transient reset
  try {
    report.transientResets = _wdResetStuckTransient();
  } catch (e) {
    report.errors.push('transient_reset: ' + e.message);
  }

  // Job 3: stale-terminal auto-retry
  try {
    report.staleTerminalResets = _wdAutoRetryStaleTerminals();
  } catch (e) {
    report.errors.push('stale_terminal_retry: ' + e.message);
  }

  // Job 4: Sheet2 desync detection (top 5 candidates per run, bounded cost)
  try {
    report.desyncFixed = _wdDetectAndFixSheet2Desync(5);
  } catch (e) {
    report.errors.push('desync_detection: ' + e.message);
  }

  // Job 5: API health probe (cached if run within last 6 hours)
  try {
    report.apiHealth = _wdProbeApiHealthCached();
  } catch (e) {
    report.errors.push('api_health: ' + e.message);
  }

  // Job 6 (Phase 8 audit, F-25): ScriptProperties cleanup. The pipeline writes
  // dedupe + depth-guard keys that have no built-in expiry. ScriptProperties has
  // a hard 512 KB ceiling — at ~600-800 leads cumulative, untouched keys can fill
  // the budget and break the dedupe lock + depth guard simultaneously. Sweep:
  //   - AUTO_PROCESSED_ROW_* keys older than 24h
  //   - AUTO_EDIT_ROW_* keys older than 24h
  //   - ENRICH_DEPTH_*_<minuteEpoch> keys older than 1h (always stale by then)
  //   - REOON_VERIFY_<email> keys with `ts` older than 30 days
  // Bounded to ~500 deletions per run to stay well inside the 6-min budget.
  try {
    report.propsCleanup = _wdCleanupStaleProperties();
  } catch (e) {
    report.errors.push('props_cleanup: ' + e.message);
  }

  // Job 7 (Phase 2b amend2-3, `-p5-pipelinelog-trim`; tightened in
  // `-p5-pipelinelog-trim-amend`): PipelineLog retention.
  //
  // Live diagnosis on 2026-06-09 (initial): PipelineLog grew to 370,157
  // rows × 26 cols (9.6M cells — 96% of the workbook's 10M cell hard limit)
  // with no retention. Once at the cell ceiling, ALL appendRow operations
  // across the workbook fail silently.
  //
  // First trim (keepDays=30) only cut ~13K rows because the user generates
  // ~12K log lines/day; 30 days = 357K rows = still 93% of limit. Amend3
  // tightens to keepDays=7 AND maxRows=50000 (whichever is more aggressive)
  // AND trimColumns=true (the 6-col schema in a 26-col physical sheet wastes
  // 77% of every row's cell budget). Combined effect at 12K rows/day rate:
  //   - keepDays=7   → 84K rows (above maxRows cap)
  //   - maxRows=50K  → caps at 50K rows
  //   - cols 26→6    → 4.3× reduction in per-row footprint
  //   - net: 50K × 6 = 300K cells (3% of limit), worst case
  try {
    if (typeof menuTrimPipelineLog === 'function') {
      report.logTrim = menuTrimPipelineLog(7, 1000, 50000, true);
    } else {
      report.logTrim = { skipped: 'menuTrimPipelineLog not in scope' };
    }
  } catch (e) {
    report.errors.push('log_trim: ' + e.message);
  }

  // Job 8 (Phase 4 prelude, `-p5-phase4-prelude`): vendor-cache TTL purge.
  //
  // Live diagnosis on 2026-06-09: 1,228 ScriptProperties, 96% of them vendor
  // caches (REOON_VERIFY, APOLLO_MATCH, APOLLO_ORGS, SNOV_PRESENCE, etc.)
  // with no auto-expiry. The 50-property UI limit is unmanageable. This job
  // bulk-purges entries beyond their natural TTLs once per watchdog tick;
  // each entry costs O(1) so the run is O(N) over ~1200 keys — well within
  // the 6-min budget even on a cold start.
  try {
    if (typeof menuPurgeStaleVendorCaches === 'function') {
      report.cachePurge = menuPurgeStaleVendorCaches();
    } else {
      report.cachePurge = { skipped: 'menuPurgeStaleVendorCaches not in scope' };
    }
  } catch (e) {
    report.errors.push('cache_purge: ' + e.message);
  }

  // Job 9 (2026-06-12-fcm-name-fix): backfill missing leadRow in TrackingLinks.
  //
  // Before the fcm-name-fix patch, emails whose links were all CTA-exempt
  // (calendly/github direct) or had no <a href> were stored in TrackingLinks with
  // leadRow=0 / linkedinUrl=''. When the pixel fires, _trackingResolveFcmName gets
  // rowNum=0 and falls back to slug or 'a lead'. This job repairs existing rows by
  // joining via LinkedIn URL (TrackingLinks col E or TrackingLog col G) → Sheet2.
  // Bounded to 200 rows/tick; self-terminates when nothing left.
  // Once all rows are backfilled this job becomes a cheap no-op (all skipped).
  try {
    if (typeof _trackingBackfillLeadRow === 'function') {
      report.fcmNameBackfill = _trackingBackfillLeadRow(200);
    } else {
      report.fcmNameBackfill = { skipped: '_trackingBackfillLeadRow not in scope' };
    }
  } catch (e) {
    report.errors.push('fcm_name_backfill: ' + e.message);
  }

  report.elapsedMs = Date.now() - startTime;
  Logger.log('[PipelineWatchdog] Done in ' + report.elapsedMs + 'ms: ' + JSON.stringify({
    transientResets: report.transientResets,
    staleTerminalResets: report.staleTerminalResets,
    desyncFixed: report.desyncFixed,
    apiOk: report.apiHealth.allOk,
    triggersRepaired: report.triggers.repaired.length
  }));

  // Persist the last report to script properties so the endpoint can show it
  try {
    PropertiesService.getScriptProperties().setProperty(
      'WATCHDOG_LAST_REPORT', JSON.stringify(report).substring(0, 9000)
    );
  } catch (_) {}

  // If anything was reset this run, kick the scanner so the reset rows
  // process immediately instead of waiting 5 min for the safety-net trigger.
  if (report.transientResets + report.staleTerminalResets + report.desyncFixed > 0) {
    try {
      if (typeof _scanAndProcessNewRows === 'function') {
        _scanAndProcessNewRows('WATCHDOG');
      }
    } catch (scannerErr) {
      report.errors.push('scanner_invoke: ' + scannerErr.message);
    }
  }

  return report;
}

// ─── JOB 1: TRIGGER HEALTH ─────────────────────────────────────────────────

function _wdEnsureTriggersHealthy() {
  // PATCH 2026-06-12-sent-sync: added syncSentDrafts to the repair list so a dropped
  // 15-min syncer trigger self-heals within one watchdog cycle (30 min) forever.
  // Previously only the four sheet/safety triggers were guarded here; the syncer was
  // installed once by installGmailDraftSyncerTrigger but never re-installed on drop
  // — exactly the failure mode that caused the 5-hour detection lag for jaspreet
  // (row 185, 2026-06-12).
  // PATCH 2026-06-13-final-cert: (a) added runWatchdog to required[] so a dropped
  // 15-min transient-state watchdog self-heals (pipelineWatchdog had a 30-min backstop
  // but a 20-min gap window remained); (b) added dedup sweep — if any handler has
  // count > 1, delete extras to prevent trigger-cap accumulation;
  // (c) hard-fail-loud alert when total time-driven count > 17.
  var required = ['onSheetChange', 'onSheetEdit', 'autoProcessSafetyNet', 'pipelineWatchdog', 'syncSentDrafts', 'runWatchdog'];
  var allTriggers = ScriptApp.getProjectTriggers();
  var installed = {};
  allTriggers.forEach(function(t) {
    var h = t.getHandlerFunction();
    installed[h] = (installed[h] || 0) + 1;
  });

  var repaired = [];
  var failures = [];

  // ── Phase A: reinstall missing required triggers (pre-existing logic) ──
  required.forEach(function(handler) {
    if (installed[handler] > 0) return;
    try {
      _wdInstallTrigger(handler);
      repaired.push(handler);
      Logger.log('[PipelineWatchdog] Re-installed missing trigger: ' + handler);
    } catch (e) {
      failures.push(handler + ': ' + e.message);
    }
  });

  // ── Phase B: dedup sweep — keep exactly ONE per required handler ──
  // PATCH 2026-06-13-final-cert: one-shot accumulation (autoProcessSafetyNet=6)
  // consumed trigger-cap slots; the watchdog only checked for absence, never excess.
  // This sweep deletes extras (slice(1) keeps the first/oldest, removes the rest).
  // Skips spreadsheet-bound triggers (onSheetChange/onSheetEdit) — those are not
  // time-driven and do not count toward the 20-slot time-driven cap.
  var timeBasedHandlers = ['autoProcessSafetyNet', 'pipelineWatchdog', 'syncSentDrafts', 'runWatchdog'];
  var byHandler = {};
  allTriggers.forEach(function(t) {
    var h = t.getHandlerFunction();
    if (!byHandler[h]) byHandler[h] = [];
    byHandler[h].push(t);
  });
  timeBasedHandlers.forEach(function(h) {
    if (byHandler[h] && byHandler[h].length > 1) {
      // Keep index 0 (oldest in the array order), delete the rest.
      byHandler[h].slice(1).forEach(function(t) {
        try {
          ScriptApp.deleteTrigger(t);
          repaired.push('DEDUP:' + h);
          Logger.log('[PipelineWatchdog] Deleted duplicate trigger for: ' + h);
        } catch (dedupErr) {
          failures.push('DEDUP:' + h + ': ' + dedupErr.message);
        }
      });
    }
  });

  // ── Phase C: total trigger count alert ──
  // PATCH 2026-06-13-final-cert: GAS time-driven cap is 20. Alert when approaching.
  var currentTotal = ScriptApp.getProjectTriggers().length;
  var alertMsg = null;
  if (currentTotal > 17) {
    alertMsg = '[PipelineWatchdog] ALERT: total trigger count=' + currentTotal +
               ' exceeds 17 (GAS time-driven cap=20). New trigger installs will fail. ' +
               'Run menuReconcileTriggers to dedup.';
    Logger.log(alertMsg);
  }

  return {
    ok: Object.keys(installed).length,
    installed: installed,
    repaired: repaired,
    failures: failures,
    totalTriggerCount: currentTotal,
    triggerCountAlert: alertMsg
  };
}

function _wdInstallTrigger(handler) {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  if (handler === 'onSheetChange') {
    ScriptApp.newTrigger('onSheetChange').forSpreadsheet(ss).onChange().create();
  } else if (handler === 'onSheetEdit') {
    ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(ss).onEdit().create();
  } else if (handler === 'autoProcessSafetyNet') {
    ScriptApp.newTrigger('autoProcessSafetyNet').timeBased().everyMinutes(5).create();
  } else if (handler === 'pipelineWatchdog') {
    ScriptApp.newTrigger('pipelineWatchdog').timeBased().everyMinutes(30).create();
  } else if (handler === 'syncSentDrafts') {
    // PATCH 2026-06-12-sent-sync: 15-min cadence matches installGmailDraftSyncerTrigger.
    ScriptApp.newTrigger('syncSentDrafts').timeBased().everyMinutes(15).create();
  } else if (handler === 'runWatchdog') {
    // PATCH 2026-06-13-final-cert: 15-min cadence matches installWatchdogTrigger (Watchdog.gs).
    // runWatchdog resets transient-stuck leads (RESEARCHING/COMPOSING/HUMANIZING) at 10-min
    // threshold; pipelineWatchdog does the same at 30-min — the gap was 20 min if runWatchdog
    // dropped. Adding it to required[] closes that gap with auto-heal.
    ScriptApp.newTrigger('runWatchdog').timeBased().everyMinutes(15).create();
  } else {
    throw new Error('unknown handler: ' + handler);
  }
}

// ─── JOB 2: STUCK-TRANSIENT RESET ──────────────────────────────────────────

function _wdResetStuckTransient() {
  var TRANSIENT_STATUSES = {
    'RESEARCHING': 30 * 60 * 1000,    // 30 min
    'COMPOSING':   30 * 60 * 1000,
    'HUMANIZING':  30 * 60 * 1000,
    'QUALITY_CHECK': 30 * 60 * 1000,
    'CLASSIFYING': 30 * 60 * 1000
  };
  return _wdResetByStatusAgeMap(TRANSIENT_STATUSES, '[WATCHDOG_TRANSIENT_RESET]');
}

// ─── JOB 3: STALE-TERMINAL AUTO-RETRY ──────────────────────────────────────

function _wdAutoRetryStaleTerminals() {
  // After 6 hours at a terminal-ish status, attempt re-processing under the
  // current (no-termination + consensus-first) pipeline. Bounded by errRetry.
  // PATCH 2026-05-20: extended to SKIPPED + DRAFT_DELETED + STALE_RECIPIENT_REVIEW
  // per the user's no-termination mandate. The pre-patch SKIPPED logic
  // permanently parked ~150 rows because the classifier said "not worth
  // pursuing"; under the new philosophy every lead should produce a draft
  // and the user decides whether to send. DRAFT_DELETED rows that are still
  // semantically "open" (no SENT_DATE) get retried so the pipeline produces
  // a fresh draft. STALE_RECIPIENT_REVIEW is the same pattern — old gate that
  // parked rows pre-no-termination.
  // PATCH 2026-06-12-deleted-stays-deleted (Class-B invert of the 2026-05-20
  // extension above): the two user-rejection statuses are REMOVED from this
  // map. The user's explicit mandate (2026-06-12): deleting a draft in Gmail
  // is a PERMANENT rejection of that lead — the pipeline must never
  // re-compose it. The old behavior also burned Claude tokens re-composing
  // leads the user had already turned down (94 deleted rows observed live),
  // unbounded whenever the re-compose succeeded (errRetry only increments on
  // failure). Rows resurrected before this patch are repaired by
  // menuRestoreResurrectedDeletedDrafts below.
  // PATCH 2026-06-12-handoff-fix: targeted 5-min early retry for ERROR rows
  // whose NOTES contain 'Missing required draft fields'. These rows were stranded
  // by the handoff-fix regression (lead.email='' reaching createDraft). The fix
  // is live in HEAD after the clasp push; these rows need a fast re-dispatch (5 min
  // instead of the standard 6h) to converge quickly. Self-cleaning: once the fix
  // is live, re-processing succeeds → STATUS=DRAFT_CREATED, and these rows leave
  // the ERROR pool; the targeted path never fires again for them.
  // Note: errRetry budget is also checked by _wdResetByStatusAgeMap — rows that
  // exhaust their budget are not retried (same safety bound as the standard path).
  _wdResetByStatusAgeMapWithNotesFilter(
    { 'ERROR': 5 * 60 * 1000 },
    '[WATCHDOG_HANDOFF_FIX_RETRY] 2026-06-12',
    'Missing required draft fields'
  );

  var TERMINAL_STATUSES = {
    'NEEDS_EMAIL':            6 * 60 * 60 * 1000,
    'NEEDS_EMAIL_REVIEW':     6 * 60 * 60 * 1000,
    'NEEDS_REVIEW':           6 * 60 * 60 * 1000,
    'REVIEW':                 6 * 60 * 60 * 1000,
    'NEEDS_PRE_SEND_REVIEW':  6 * 60 * 60 * 1000,
    'REOON_RETRY_PENDING':    1 * 60 * 60 * 1000,
    'ERROR':                  6 * 60 * 60 * 1000,
    'SKIPPED':               24 * 60 * 60 * 1000,  // longer cooldown — these were classified out
    'STALE_RECIPIENT_REVIEW': 6 * 60 * 60 * 1000
  };
  return _wdResetByStatusAgeMap(TERMINAL_STATUSES, '[WATCHDOG_STALE_TERMINAL_RETRY]');
}

/**
 * PATCH 2026-06-12-deleted-stays-deleted: idempotent repair sweep. Job 3
 * used to resurrect user-deleted/abandoned drafts after 24h; any row it
 * already flipped carries the Job 3 note tag plus a "Was <status> for" marker
 * in NOTES. This sweep reverts such rows to their original rejection status
 * unless they have since legitimately progressed (draft re-created, sent, or
 * bounced — those are left alone; with the map fix above, deleting the
 * re-created draft now parks the row permanently).
 */
function menuRestoreResurrectedDeletedDrafts() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { scanned: 0, restored: 0, rows: [] };
  var c = CONFIG.COLUMNS;
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, CONFIG.SHEET_COL_COUNT).getValues();
  var PROTECT = { 'DRAFT_CREATED': 1, 'SENT': 1, 'DRAFT_DELETED': 1, 'DRAFT_ABANDONED': 1,
                  'BOUNCED_HARD': 1, 'BOUNCED_SOFT': 1 };
  var restored = 0;
  var byRow = [];
  for (var i = 0; i < data.length; i++) {
    var status = (data[i][c.STATUS - 1] || '').toString().trim();
    if (PROTECT[status]) continue;
    var notes = (data[i][c.NOTES - 1] || '').toString();
    if (notes.indexOf('[WATCHDOG_STALE_TERMINAL_RETRY]') < 0) continue;
    var m = notes.match(/Was (DRAFT_DELETED|DRAFT_ABANDONED) for/);
    if (!m) continue;
    var rowNum = i + 2;
    try {
      sheet.getRange(rowNum, c.STATUS).setValue(m[1]);
      sheet.getRange(rowNum, c.NOTES).setValue(('[RESTORE_DELETED] ' + new Date().toISOString() +
        ' resurrection reverted; deletion is a permanent user decision. ' + notes).substring(0, 1900));
      sheet.getRange(rowNum, c.LAST_UPDATED).setValue(new Date().toISOString());
      restored++;
      byRow.push(rowNum + ':' + m[1]);
    } catch (_) {}
  }
  Logger.log('[RestoreDeleted] restored=' + restored + ' rows=' + byRow.join(','));
  return { scanned: data.length, restored: restored, rows: byRow.slice(0, 60) };
}

// Common reset helper used by Jobs 2 + 3.
function _wdResetByStatusAgeMap(statusAgeMap, noteTag) {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return 0;
  var c = CONFIG.COLUMNS;
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, CONFIG.SHEET_COL_COUNT).getValues();
  var now = Date.now();
  var resetCount = 0;

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var status = (row[c.STATUS - 1] || '').toString().trim();
    if (!statusAgeMap[status]) continue;

    var lastUpdated = row[c.LAST_UPDATED - 1];
    var lastUpdatedMs = 0;
    if (lastUpdated) {
      try {
        lastUpdatedMs = (lastUpdated instanceof Date) ? lastUpdated.getTime()
                                                       : new Date(lastUpdated.toString()).getTime();
      } catch (_) {}
    }
    if (!lastUpdatedMs) continue;  // can't determine age, skip

    if ((now - lastUpdatedMs) < statusAgeMap[status]) continue;

    // PATCH 2026-06-12-fresh-first (M3): 10-day age gate for watchdog resets.
    // Old leads whose LAST_UPDATED is > CONFIG.LEAD_MAX_AGE_DAYS old must NOT
    // re-enter the pipeline via watchdog resets (Jobs 2 + 3). Without this gate,
    // stale leads that the scanner correctly skips (SKIP_STALE_LEAD) would be
    // silently revived by the watchdog on every 30-min tick.
    // Missing/unparseable LAST_UPDATED → allow (same missing-date policy as _leadWithinAgeWindow).
    if (typeof _leadWithinAgeWindow === 'function') {
      if (!_leadWithinAgeWindow(row, c, now)) {
        Logger.log('[WatchdogReset] Skipping stale row ' + (i + 2) +
                   ' (LAST_UPDATED > ' + ((CONFIG && CONFIG.LEAD_MAX_AGE_DAYS) || 10) + ' days)');
        continue;
      }
    }

    // Check retry budget
    var prevNotes = (row[c.NOTES - 1] || '').toString();
    var retryMatch = prevNotes.match(/errRetry:(\d+)\/(\d+)/);
    var retriesSoFar = retryMatch ? parseInt(retryMatch[1], 10) : 0;
    var retryMax = retryMatch ? parseInt(retryMatch[2], 10) : 2;
    if (retriesSoFar >= retryMax) continue;

    var rowNum = i + 2;
    var ageMin = Math.round((now - lastUpdatedMs) / 60000);
    var newNote = noteTag + ' ' + new Date().toISOString() + ' Was ' + status +
                  ' for ' + ageMin + ' min -> NEW. Auto-retry under current pipeline. ' +
                  'Previous notes: ' + prevNotes.substring(0, 500);
    try {
      sheet.getRange(rowNum, c.STATUS).setValue('NEW');
      sheet.getRange(rowNum, c.NOTES).setValue(newNote.substring(0, 1900));
      sheet.getRange(rowNum, c.LAST_UPDATED).setValue(new Date().toISOString());
      // PATCH P2 (_svc migration): route Properties writes through registry
      // so cleanup-cron tests can assert no side-effects on a mock store.
      ((typeof _svc === 'function') ? _svc('Properties') : PropertiesService.getScriptProperties())
        .deleteProperty('AUTO_PROCESSED_ROW_' + rowNum);
      resetCount++;
    } catch (_) {}
  }
  return resetCount;
}

/**
 * PATCH 2026-06-12-handoff-fix: variant of _wdResetByStatusAgeMap that adds a
 * NOTES substring filter. Only rows whose NOTES contain notesSubstring are
 * eligible for reset; all other criteria (age, errRetry budget, freshness window)
 * are identical to _wdResetByStatusAgeMap. Used for the targeted 5-min early-
 * retry of handoff-fix ERROR rows without changing the standard 6h ERROR path.
 *
 * @param {Object} statusAgeMap  - { STATUS: ageThresholdMs }
 * @param {string} noteTag       - prefix written to NOTES on reset
 * @param {string} notesSubstring - NOTES must contain this string for the row
 *                                  to be eligible
 * @returns {number} count of rows reset
 */
function _wdResetByStatusAgeMapWithNotesFilter(statusAgeMap, noteTag, notesSubstring) {
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (!sheet || sheet.getLastRow() < 2) return 0;
    var c = CONFIG.COLUMNS;
    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, CONFIG.SHEET_COL_COUNT).getValues();
    var now = Date.now();
    var resetCount = 0;

    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      var status = (row[c.STATUS - 1] || '').toString().trim();
      if (!statusAgeMap[status]) continue;

      var prevNotes = (row[c.NOTES - 1] || '').toString();
      // Notes-substring filter: skip rows that don't match the targeted pattern
      if (notesSubstring && prevNotes.indexOf(notesSubstring) < 0) continue;

      var lastUpdated = row[c.LAST_UPDATED - 1];
      var lastUpdatedMs = 0;
      if (lastUpdated) {
        try {
          lastUpdatedMs = (lastUpdated instanceof Date) ? lastUpdated.getTime()
                                                         : new Date(lastUpdated.toString()).getTime();
        } catch (_) {}
      }
      if (!lastUpdatedMs) continue;
      if ((now - lastUpdatedMs) < statusAgeMap[status]) continue;

      if (typeof _leadWithinAgeWindow === 'function') {
        if (!_leadWithinAgeWindow(row, c, now)) continue;
      }

      // HANDOFF-FIX: bypass the standard errRetry budget check for pipeline-bug retry
      // passes. The exhausted errRetry:N/M on these rows was from the regression
      // (createDraft failing because lead.email was empty), NOT from content issues.
      // We reset the token to errRetry:0/2 in the new notes so the pipeline gets
      // a fresh budget under the now-fixed code. This targeted bypass applies ONLY
      // to rows that passed the notesSubstring filter above — generic ERROR rows
      // with exhausted budgets are unaffected (they don't match the filter pattern
      // and never reach this code path).
      var rowNum = i + 2;
      var ageMin = Math.round((now - lastUpdatedMs) / 60000);
      // Strip the old exhausted token and inject a fresh one
      var prevNotesClean = prevNotes.replace(/\s*errRetry:\d+\/\d+/g, '').trim();
      var newNote = noteTag + ' ' + new Date().toISOString() + ' Was ' + status +
                    ' for ' + ageMin + ' min -> NEW. Pipeline-bug retry (budget reset). errRetry:0/2. ' +
                    'Previous notes: ' + prevNotesClean.substring(0, 500);
      try {
        sheet.getRange(rowNum, c.STATUS).setValue('NEW');
        sheet.getRange(rowNum, c.NOTES).setValue(newNote.substring(0, 1900));
        sheet.getRange(rowNum, c.LAST_UPDATED).setValue(new Date().toISOString());
        ((typeof _svc === 'function') ? _svc('Properties') : PropertiesService.getScriptProperties())
          .deleteProperty('AUTO_PROCESSED_ROW_' + rowNum);
        resetCount++;
      } catch (_) {}
    }
    Logger.log('[WatchdogHandoffFix] Notes-filter reset count=' + resetCount +
               ' filter="' + notesSubstring + '"');
    return resetCount;
  } catch (_outerErr) {
    Logger.log('[WatchdogHandoffFix] _wdResetByStatusAgeMapWithNotesFilter failed: ' + _outerErr.message);
    return 0;
  }
}

// ─── JOB 4: SHEET2 DESYNC DETECTION ────────────────────────────────────────

/**
 * Pure status-eligibility predicate for Job 4 desync repair.
 *
 * User mandate 2026-06-12-desync-gate: deleting a draft, sending a lead,
 * bouncing, or marking as duplicate are PERMANENT human decisions. Desync
 * repair (which resets STATUS=NEW and clears enriched state) must NEVER apply
 * to rows where such a decision has already been made — doing so silently
 * overrides the user and causes drafts to regenerate for leads that have been
 * explicitly rejected or already contacted.
 *
 * Returns true only for statuses that are genuinely pre-decision: no human
 * action has been taken and no deterministic pipeline outcome has concluded.
 *
 * Uses the shared HUMAN_DECIDED_STATUSES constant from Scanner.gs when
 * available (GAS globals are shared across files). Falls back to an inline
 * set that matches the six human-decided statuses plus DUPLICATE so this
 * guard is self-contained even if Scanner.gs is absent.
 *
 * @param {string} status - the STATUS column value for a row
 * @returns {boolean} true if the row may be desync-repaired; false if it has
 *                    a human-decided or terminal outcome and must be left alone
 */
function _wdDesyncEligibleStatus(status) {
  // Shared constant from Scanner.gs (same GAS script scope).
  // Fallback set covers the user-mandate six for self-containedness.
  var humanDecided = (typeof HUMAN_DECIDED_STATUSES !== 'undefined' && HUMAN_DECIDED_STATUSES)
    || {
      'SENT':           true,
      'DRAFT_DELETED':  true,
      'DRAFT_ABANDONED': true,
      'BOUNCED_HARD':   true,
      'BOUNCED_SOFT':   true,
      'DUPLICATE':      true,
      'DRAFT_CREATED':  true
    };
  // DUPLICATE is always excluded regardless of Scanner.gs version.
  if (status === 'DUPLICATE') return false;
  return !humanDecided[status];
}

/**
 * Detect rows where ENRICHED_EMAIL doesn't match the lead's identity.
 * Heuristic: the email's local part should contain at least one segment
 * of the lead's name OR the email's domain should match the lead's org.
 * If NEITHER holds, the row is likely contaminated (state column attached
 * to wrong identity via a Sheet2 UNIQUE-formula shuffle).
 *
 * Fix: clear ENRICHED_EMAIL, EMAIL_SOURCE, EMAIL_CONFIDENCE, DRAFT_ID,
 * STATUS=NEW. URL-keyed _uf writes prevent future contamination.
 *
 * Eligibility gate (2026-06-12-desync-gate): rows where a human decision
 * or terminal outcome already exists (SENT, DRAFT_DELETED, DRAFT_ABANDONED,
 * BOUNCED_HARD, BOUNCED_SOFT, DUPLICATE) are never candidates. See
 * _wdDesyncEligibleStatus for the predicate and rationale.
 *
 * @param {number} maxFixes - safety cap per run
 */
function _wdDetectAndFixSheet2Desync(maxFixes) {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return 0;
  var c = CONFIG.COLUMNS;
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, CONFIG.SHEET_COL_COUNT).getValues();
  var fixed = 0;

  for (var i = 0; i < data.length && fixed < maxFixes; i++) {
    var row = data[i];
    var status = (row[c.STATUS - 1] || '').toString().trim();
    // 2026-06-12-desync-gate: skip rows with human-decided/terminal status.
    // Sending or deleting a draft is a permanent user decision; desync repair
    // applies only to pre-decision rows.
    if (!_wdDesyncEligibleStatus(status)) continue;
    var fullName = (row[c.FULL_NAME - 1] || '').toString().toLowerCase();
    var org = (row[c.ORGANIZATION - 1] || '').toString().toLowerCase();
    var enriched = (row[c.ENRICHED_EMAIL - 1] || '').toString().toLowerCase();
    if (!enriched || enriched.indexOf('@') < 0) continue;

    var emailParts = enriched.split('@');
    var localPart = emailParts[0] || '';
    var domain = emailParts[1] || '';

    // Heuristic 1: local-part contains any name token >= 3 chars
    var nameTokens = fullName.split(/\s+/).filter(function(t) { return t.length >= 3; });
    var localPartMatchesName = nameTokens.some(function(t) {
      return localPart.indexOf(t) >= 0;
    });
    if (localPartMatchesName) continue;

    // Heuristic 2: domain contains any org token >= 4 chars (excluding common suffixes)
    var orgTokens = org.split(/\s+/).filter(function(t) {
      return t.length >= 4 && ['private', 'limited', 'company', 'corporation', 'holdings'].indexOf(t) < 0;
    });
    var domainMatchesOrg = orgTokens.some(function(t) {
      return domain.indexOf(t) >= 0;
    });
    if (domainMatchesOrg) continue;

    // Neither name nor org matches the enriched email — likely desync.
    var rowNum = i + 2;
    var prevNotes = (row[c.NOTES - 1] || '').toString().substring(0, 500);
    Logger.log('[PipelineWatchdog] Sheet2 desync candidate row ' + rowNum +
               ': name="' + fullName + '" org="' + org + '" enriched=' + enriched +
               ' (neither matches)');
    try {
      sheet.getRange(rowNum, c.STATUS).setValue('NEW');
      sheet.getRange(rowNum, c.ENRICHED_EMAIL).setValue('');
      sheet.getRange(rowNum, c.EMAIL_SOURCE).setValue('');
      sheet.getRange(rowNum, c.EMAIL_CONFIDENCE).setValue('');
      sheet.getRange(rowNum, c.DRAFT_ID).setValue('');
      sheet.getRange(rowNum, c.NOTES).setValue(
        '[WATCHDOG_DESYNC_FIX ' + new Date().toISOString() + '] Cleared contaminated state. ' +
        'Previous enriched=' + enriched + '. Re-enriching under URL-keyed pipeline. ' +
        'Previous notes: ' + prevNotes
      );
      sheet.getRange(rowNum, c.LAST_UPDATED).setValue(new Date().toISOString());
      PropertiesService.getScriptProperties().deleteProperty('AUTO_PROCESSED_ROW_' + rowNum);
      fixed++;
    } catch (_) {}
  }
  return fixed;
}

// ─── JOB 5: API HEALTH PROBE (CACHED) ──────────────────────────────────────

function _wdProbeApiHealthCached(forceRefresh) {
  var props = PropertiesService.getScriptProperties();
  var cacheKey = 'WATCHDOG_API_HEALTH';
  var cacheStaleMs = 6 * 60 * 60 * 1000;  // 6 hours

  // PATCH 2026-05-20: when the deployment stamp changes (new code shipped),
  // we always want a fresh probe — the cached result was for the previous
  // version of verifyEmailDeliverable. Stamp check is cheap and prevents
  // the stale-Reoon-403 confusion that happened post-waterfall deploy.
  var currentStamp = '2026-06-13-sheet1-search';
  if (!forceRefresh) {
    try {
      var cached = props.getProperty(cacheKey);
      if (cached) {
        var parsed = JSON.parse(cached);
        var sameStamp = parsed.deploymentStamp === currentStamp;
        if (sameStamp && (Date.now() - parsed.timestamp) < cacheStaleMs) {
          parsed.fromCache = true;
          return parsed;
        }
      }
    } catch (_) {}
  }

  // Run live probe — light version, no payload-heavy people-match call
  var report = { timestamp: Date.now(), services: {}, allOk: true };

  // Reoon — probe with the same Power→Quick waterfall the live pipeline uses.
  // A 403 on Power followed by a 200 on Quick counts as healthy (waterfall
  // working as designed). Only if BOTH modes fail do we report unhealthy.
  try {
    var reoonKey = props.getProperty('REOON_API_KEY') || '';
    if (reoonKey) {
      var rPowerRes = UrlFetchApp.fetch(
        'https://emailverifier.reoon.com/api/v1/verify?email=test%40gmail.com&key=' +
        encodeURIComponent(reoonKey) + '&mode=power',
        { muteHttpExceptions: true });
      var rPowerCode = rPowerRes.getResponseCode();
      var reoonReport = {
        powerHttpCode: rPowerCode,
        powerOk: rPowerCode === 200
      };
      if (rPowerCode === 200) {
        reoonReport.ok = true;
        reoonReport.activeMode = 'power';
      } else if (rPowerCode === 403) {
        // Try Quick mode fallback
        var rQuickRes = UrlFetchApp.fetch(
          'https://emailverifier.reoon.com/api/v1/verify?email=test%40gmail.com&key=' +
          encodeURIComponent(reoonKey) + '&mode=quick',
          { muteHttpExceptions: true });
        var rQuickCode = rQuickRes.getResponseCode();
        reoonReport.quickHttpCode = rQuickCode;
        reoonReport.quickOk = rQuickCode === 200;
        reoonReport.ok = rQuickCode === 200;
        reoonReport.activeMode = rQuickCode === 200 ? 'quick' : 'none';
        reoonReport.degradedToQuick = rQuickCode === 200;
      } else {
        reoonReport.ok = false;
        reoonReport.activeMode = 'none';
      }
      report.services.reoon = reoonReport;
      if (!reoonReport.ok) report.allOk = false;
    } else {
      report.services.reoon = { ok: false, reason: 'key_unset' };
      report.allOk = false;
    }
  } catch (e) { report.services.reoon = { ok: false, reason: e.message }; report.allOk = false; }

  // Apollo (cheap probe via /organizations/search)
  try {
    var apolloKey = props.getProperty('APOLLO_API_KEY') || '';
    if (apolloKey) {
      var aRes = UrlFetchApp.fetch('https://api.apollo.io/api/v1/organizations/search', {
        method: 'post', contentType: 'application/json',
        headers: { 'X-Api-Key': apolloKey },
        payload: JSON.stringify({ q_organization_name: 'Stripe', per_page: 1 }),
        muteHttpExceptions: true
      });
      var aOk = aRes.getResponseCode() === 200;
      report.services.apollo = { ok: aOk, httpCode: aRes.getResponseCode() };
      if (!aOk) report.allOk = false;
    } else {
      report.services.apollo = { ok: false, reason: 'key_unset' };
      report.allOk = false;
    }
  } catch (e) { report.services.apollo = { ok: false, reason: e.message }; report.allOk = false; }

  // Hunter
  try {
    var hunterKey = props.getProperty('HUNTER_API_KEY') || '';
    if (hunterKey) {
      var hRes = UrlFetchApp.fetch(
        'https://api.hunter.io/v2/email-verifier?email=patrick@stripe.com&api_key=' +
        encodeURIComponent(hunterKey),
        { muteHttpExceptions: true });
      var hOk = hRes.getResponseCode() === 200;
      report.services.hunter = { ok: hOk, httpCode: hRes.getResponseCode() };
      if (!hOk) report.allOk = false;
    } else {
      report.services.hunter = { ok: false, reason: 'key_unset' };
      report.allOk = false;
    }
  } catch (e) { report.services.hunter = { ok: false, reason: e.message }; report.allOk = false; }

  // Stamp the cache entry so we can detect stale-across-deploys results.
  report.deploymentStamp = currentStamp;
  try { props.setProperty(cacheKey, JSON.stringify(report)); } catch (_) {}
  return report;
}

/**
 * Pure guard (unit-tested directly): true when `key` is a date-keyed counter
 * under `prefix` — API_CALLS_<svc>_<YYYY-MM-DD> (ApiClients._trackApiCall) or
 * DAILY_DRAFTS_<YYYY-MM-DD> (Config.incrementDailyDraftCount) — whose
 * trailing date is more than 30 days before `nowMs`. Malformed or non-date
 * suffixes are never stale: unknown keys are left alone.
 */
function _wdIsStaleDateKeyedCounter(key, prefix, nowMs) {
  if (key.indexOf(prefix) !== 0) return false;
  var parts = key.split('_');
  var dateStr = parts[parts.length - 1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  var dateMs = Date.parse(dateStr);
  if (isNaN(dateMs)) return false;
  return (nowMs - dateMs) > 30 * 24 * 60 * 60 * 1000;
}

/**
 * Job 6 implementation (Phase 8, F-25): ScriptProperties cleanup.
 * Sweeps stale dedupe + depth-guard + verifier-cache keys, plus (since
 * 2026-06-12-cacheservice-migration) the date-keyed daily counters
 * API_CALLS_* and DAILY_DRAFTS_* that previously accumulated one key per
 * service per day forever.
 *
 * Bounded to MAX_DELETIONS per run to stay inside the 6-min execution budget.
 * Deletions are explicit (deleteProperty) — Google's `getProperties()` returns
 * a snapshot, then we iterate keys and delete selectively.
 */
function _wdCleanupStaleProperties() {
  var MAX_DELETIONS = 500;
  var nowMs = Date.now();
  var DAY_MS = 24 * 60 * 60 * 1000;
  var HOUR_MS = 60 * 60 * 1000;
  var THIRTY_DAYS_MS = 30 * DAY_MS;

  var props = PropertiesService.getScriptProperties();
  var all;
  try {
    all = props.getProperties();
  } catch (e) {
    return { error: 'getProperties_failed: ' + e.message };
  }
  var deleted = { auto_processed_row: 0, auto_edit_row: 0, enrich_depth: 0, reoon_verify: 0,
                  api_calls: 0, daily_drafts: 0 };
  var totalDeleted = 0;

  for (var key in all) {
    if (totalDeleted >= MAX_DELETIONS) break;
    if (!all.hasOwnProperty(key)) continue;
    var val = all[key];

    if (key.indexOf('AUTO_PROCESSED_ROW_') === 0) {
      // Value is epoch ms timestamp of last process
      var ts = parseInt(val, 10);
      if (!isNaN(ts) && (nowMs - ts) > DAY_MS) {
        try { props.deleteProperty(key); deleted.auto_processed_row++; totalDeleted++; } catch (_) {}
      }
    } else if (key.indexOf('AUTO_EDIT_ROW_') === 0) {
      var ts2 = parseInt(val, 10);
      if (!isNaN(ts2) && (nowMs - ts2) > DAY_MS) {
        try { props.deleteProperty(key); deleted.auto_edit_row++; totalDeleted++; } catch (_) {}
      }
    } else if (key.indexOf('ENRICH_DEPTH_') === 0) {
      // Key encodes minuteEpoch; if the encoded minute is more than 1 hour
      // in the past, the depth counter is stale — safe to delete.
      var keyParts = key.split('_');
      var minuteEpoch = parseInt(keyParts[keyParts.length - 1], 10);
      if (!isNaN(minuteEpoch)) {
        var keyMs = minuteEpoch * 60 * 1000;
        if ((nowMs - keyMs) > HOUR_MS) {
          try { props.deleteProperty(key); deleted.enrich_depth++; totalDeleted++; } catch (_) {}
        }
      }
    } else if (key.indexOf('REOON_VERIFY_') === 0) {
      // Value is JSON {status, raw, ts, mode}; parse and check ts age.
      // Legacy-only since 2026-06-12-cacheservice-migration (live Reoon cache
      // moved to CacheService) — the sweep drains pre-migration residue.
      try {
        var parsed = JSON.parse(val);
        if (parsed && parsed.ts && (nowMs - parsed.ts) > THIRTY_DAYS_MS) {
          props.deleteProperty(key);
          deleted.reoon_verify++;
          totalDeleted++;
        }
      } catch (_) {
        // Corrupt JSON — best to leave alone (don't delete unparseable values
        // that might be from a future format)
      }
    } else if (_wdIsStaleDateKeyedCounter(key, 'API_CALLS_', nowMs)) {
      // Daily vendor-call counters — the date lives in the KEY, the value is
      // a bare integer. Keep 30 days of history for trend inspection.
      try { props.deleteProperty(key); deleted.api_calls++; totalDeleted++; } catch (_) {}
    } else if (_wdIsStaleDateKeyedCounter(key, 'DAILY_DRAFTS_', nowMs)) {
      // Daily draft counters — previously swept nowhere, so they grew by one
      // key per active day forever.
      try { props.deleteProperty(key); deleted.daily_drafts++; totalDeleted++; } catch (_) {}
    }
  }

  Logger.log('[PipelineWatchdog] Job 6 props cleanup: ' + JSON.stringify(deleted) +
             ' (total=' + totalDeleted + ')');
  return { totalDeleted: totalDeleted, byCategory: deleted };
}

/**
 * Public helper — manually clear the API health cache so the next probe
 * runs live. Useful right after a deploy that changes verifyEmailDeliverable
 * behaviour (e.g. the Power→Quick waterfall).
 */
function clearWatchdogApiHealthCache() {
  try {
    PropertiesService.getScriptProperties().deleteProperty('WATCHDOG_API_HEALTH');
    return { cleared: true };
  } catch (e) {
    return { cleared: false, error: e.message };
  }
}

// ─── ONE-TIME INSTALLER ────────────────────────────────────────────────────

/**
 * Install the watchdog itself + all triggers it depends on.
 * Idempotent — safe to re-run anytime; existing triggers are skipped.
 *
 * Call via the admin endpoint: ?action=install_watchdog&token=<ADMIN>
 */
function installPipelineWatchdog() {
  var summary = { installed: [], existed: [], failed: [] };
  var required = [
    { handler: 'onSheetChange',         install: function() { _wdInstallTrigger('onSheetChange'); } },
    { handler: 'onSheetEdit',           install: function() { _wdInstallTrigger('onSheetEdit'); } },
    { handler: 'autoProcessSafetyNet',  install: function() { _wdInstallTrigger('autoProcessSafetyNet'); } },
    { handler: 'pipelineWatchdog',      install: function() { _wdInstallTrigger('pipelineWatchdog'); } }
  ];
  var existing = {};
  ScriptApp.getProjectTriggers().forEach(function(t) {
    existing[t.getHandlerFunction()] = (existing[t.getHandlerFunction()] || 0) + 1;
  });
  required.forEach(function(item) {
    if (existing[item.handler] > 0) {
      summary.existed.push(item.handler);
    } else {
      try { item.install(); summary.installed.push(item.handler); }
      catch (e) { summary.failed.push(item.handler + ': ' + e.message); }
    }
  });
  return summary;
}

/**
 * PATCH 2026-06-13-final-cert: Idempotent trigger reconciliation.
 * For each required time-driven handler, keeps exactly ONE trigger at the correct
 * cadence and deletes all extras. Also removes any legacy stale one-shots for
 * autoProcessSafetyNet. Brings total trigger count under 20 (GAS hard cap).
 *
 * Bridge-callable: /exec?action=admin_run&fn=menuReconcileTriggers&token=<ADMIN>
 *
 * @returns {{ before: number, after: number, deduped: string[], errors: string[] }}
 */
function menuReconcileTriggers() {
  var TRIGGER_CAP_HARD  = 20;   // GAS time-driven hard cap
  var TRIGGER_CAP_WARN  = 17;   // target ceiling (3 headroom for burst one-shots)

  // Canonical cadence map — these are the only time-driven triggers that should exist.
  var CANONICAL = {
    'autoProcessSafetyNet':     { type: 'everyMinutes', minutes: 5 },
    'pipelineWatchdog':         { type: 'everyMinutes', minutes: 30 },
    'syncSentDrafts':           { type: 'everyMinutes', minutes: 15 },
    'runWatchdog':              { type: 'everyMinutes', minutes: 15 }
    // onSheetChange + onSheetEdit are spreadsheet-bound (not time-driven); not touched here.
    // Other time-driven handlers (processReplies, processBounces, etc.) each have
    // exactly 1 installed — no dedup needed unless probed count > 1.
  };

  var deduped = [];
  var errors  = [];
  var allBefore = ScriptApp.getProjectTriggers();
  var beforeCount = allBefore.length;

  // Group by handler function name.
  var byHandler = {};
  allBefore.forEach(function(t) {
    var h = t.getHandlerFunction();
    if (!byHandler[h]) byHandler[h] = [];
    byHandler[h].push(t);
  });

  // Step 1: dedup every handler that has > 1 trigger — keep index 0 (oldest), delete rest.
  Object.keys(byHandler).forEach(function(h) {
    if (byHandler[h].length > 1) {
      byHandler[h].slice(1).forEach(function(t) {
        try {
          ScriptApp.deleteTrigger(t);
          deduped.push('DELETED_EXTRA:' + h);
          Logger.log('[menuReconcileTriggers] deleted extra trigger for handler: ' + h);
        } catch (e) {
          errors.push('DELETE:' + h + ': ' + e.message);
        }
      });
    }
  });

  // Step 2: ensure each canonical handler has exactly ONE trigger.
  // After dedup above, byHandler[h] has at most 1 entry. Reinstall if missing.
  var afterDedup = ScriptApp.getProjectTriggers();
  var presentAfterDedup = {};
  afterDedup.forEach(function(t) { presentAfterDedup[t.getHandlerFunction()] = true; });

  Object.keys(CANONICAL).forEach(function(h) {
    if (!presentAfterDedup[h]) {
      try {
        _wdInstallTrigger(h);
        deduped.push('REINSTALLED:' + h);
        Logger.log('[menuReconcileTriggers] reinstalled missing canonical trigger: ' + h);
      } catch (e) {
        errors.push('REINSTALL:' + h + ': ' + e.message);
      }
    }
  });

  var afterCount = ScriptApp.getProjectTriggers().length;
  var result = {
    before: beforeCount,
    after:  afterCount,
    deduped: deduped,
    errors:  errors,
    belowHardCap: afterCount <= TRIGGER_CAP_HARD,
    belowWarnCap: afterCount <= TRIGGER_CAP_WARN,
    timestamp: new Date().toISOString()
  };
  Logger.log('[menuReconcileTriggers] complete: before=' + beforeCount + ' after=' + afterCount +
             ' deduped=' + deduped.length + ' errors=' + errors.length);
  return result;
}
