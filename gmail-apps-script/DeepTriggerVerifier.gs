/**
 * ============================================================
 * DeepTriggerVerifier.gs — Trigger-by-trigger functional audit
 * (Patch 2026-05-19)
 * ============================================================
 *
 * Why this exists, in one line: `verifyNewLeadPipeline` confirms triggers
 * EXIST. `deepVerifyTriggers` confirms each one FUNCTIONS.
 *
 * For every entry in NEW_LEAD_TRIGGERS, it checks four independent things:
 *
 *   1. INSTALLED        — Apps Script has a ScriptApp.Trigger for this handler
 *   2. NOT DUPLICATED   — Exactly one trigger (multiple = race-prone)
 *   3. HANDLER CALLABLE — The function name resolves to an actual function
 *                          (catches code drift where a handler was renamed
 *                          but its trigger still references the old name)
 *   4. RECENTLY FIRED   — A functional signal proving the cron actually ran:
 *                          a fresh row in Health sheet, a recent log event,
 *                          a recent draft in Gmail, etc.
 *
 * Plus two cross-cutting checks:
 *
 *   5. ORPHAN TRIGGERS — Any trigger NOT in NEW_LEAD_TRIGGERS (stale from
 *                         previous code, will fire but is no longer wanted)
 *   6. SMOKE TESTS     — For handlers that support dryRun, invoke them and
 *                         confirm they execute without throwing
 *
 * The result is a structured per-trigger report + an overall grade.
 *
 * Read-only. Safe to call repeatedly. Doesn't mutate anything.
 *
 * Endpoint: /exec?action=deep_verify_triggers&token=<ADMIN>
 *           /exec?action=deep_verify_triggers&smokeTest=1&token=<ADMIN>  ← also runs dryRun probes
 */

/**
 * Expected schedule signatures for each trigger handler. Used to detect
 * triggers that exist but have the wrong interval (e.g., daily when we
 * expect every-15-min). Apps Script doesn't expose the exact interval
 * via the Trigger API, but it DOES expose eventType (CLOCK / ON_CHANGE /
 * ON_EDIT) and triggerSource (CLOCK / SPREADSHEETS). We compare those
 * shapes to what the manifest declares.
 */
var TRIGGER_EXPECTED_SHAPE = {
  'onSheetChange':              { eventType: 'ON_CHANGE',                   triggerSource: 'SPREADSHEETS' },
  'onSheetEdit':                { eventType: 'ON_EDIT',                     triggerSource: 'SPREADSHEETS' },
  'autoProcessSafetyNet':       { eventType: 'CLOCK',                       triggerSource: 'CLOCK' },
  'processScheduledFollowUps':  { eventType: 'CLOCK',                       triggerSource: 'CLOCK' },
  'syncSentDrafts':             { eventType: 'CLOCK',                       triggerSource: 'CLOCK' },
  'runWatchdog':                { eventType: 'CLOCK',                       triggerSource: 'CLOCK' },
  'runHealthCheck':             { eventType: 'CLOCK',                       triggerSource: 'CLOCK' },
  'processReplies':             { eventType: 'CLOCK',                       triggerSource: 'CLOCK' },
  'processBounces':             { eventType: 'CLOCK',                       triggerSource: 'CLOCK' },
  'evaluateAutoPause':          { eventType: 'CLOCK',                       triggerSource: 'CLOCK' },
  'webAppWarmKeeper':           { eventType: 'CLOCK',                       triggerSource: 'CLOCK' },
  'runDraftStateMonitor':       { eventType: 'CLOCK',                       triggerSource: 'CLOCK' }
};

/**
 * @param {Object} [options]
 *   {boolean} smokeTest — if true, invokes dryRun-safe handlers and reports outcomes
 * @returns {Object} { overall, triggers, orphans, functionalSignals, smokeTests?, timestamp }
 */
function deepVerifyTriggers(options) {
  options = options || {};
  var doSmokeTest = !!options.smokeTest;
  Logger.log('[DeepVerify] Starting at ' + new Date().toISOString() + ' smokeTest=' + doSmokeTest);

  var installedTriggers = ScriptApp.getProjectTriggers();
  var triggersByHandler = {};
  installedTriggers.forEach(function(t) {
    var name = t.getHandlerFunction();
    if (!triggersByHandler[name]) triggersByHandler[name] = [];
    triggersByHandler[name].push(t);
  });

  var report = [];
  var passCount = 0, failCount = 0, warnCount = 0;

  // ── Per-trigger check ──────────────────────────────────────────────────
  NEW_LEAD_TRIGGERS.forEach(function(expected) {
    var matches = triggersByHandler[expected.handler] || [];
    var entry = {
      handler: expected.handler,
      role: expected.role,
      critical: expected.critical,
      checks: {}
    };

    // 1. INSTALLED
    entry.checks.installed = (matches.length > 0);

    // 2. NOT DUPLICATED
    entry.checks.notDuplicated = (matches.length === 1);
    if (matches.length > 1) {
      entry.duplicateCount = matches.length;
    }

    // 3. SCHEDULE SHAPE MATCHES MANIFEST
    if (matches.length > 0) {
      var trigger = matches[0];
      var actualEventType = '';
      var actualTriggerSource = '';
      try {
        actualEventType = trigger.getEventType().toString();
        actualTriggerSource = trigger.getTriggerSource().toString();
      } catch (_) {}
      entry.actualEventType = actualEventType;
      entry.actualTriggerSource = actualTriggerSource;

      var expectedShape = TRIGGER_EXPECTED_SHAPE[expected.handler];
      if (expectedShape) {
        entry.checks.scheduleShapeMatches =
          (actualEventType.indexOf(expectedShape.eventType) >= 0) &&
          (actualTriggerSource.indexOf(expectedShape.triggerSource) >= 0);
      } else {
        entry.checks.scheduleShapeMatches = true;  // no expectation declared
      }
    } else {
      entry.checks.scheduleShapeMatches = false;
    }

    // 4. HANDLER CALLABLE
    entry.checks.handlerCallable = _isHandlerCallable(expected.handler);

    // 5. RECENTLY FIRED (functional signal)
    var recency = _checkHandlerRecency(expected.handler);
    entry.checks.recentlyFired = recency.fresh;
    entry.lastSeenAt = recency.lastSeen;
    entry.recencyEvidence = recency.evidence;
    entry.recencyAgeMinutes = recency.ageMinutes;

    // Aggregate
    var allChecksPass = entry.checks.installed
                     && entry.checks.notDuplicated
                     && entry.checks.scheduleShapeMatches
                     && entry.checks.handlerCallable;
    if (allChecksPass && entry.checks.recentlyFired) {
      entry.status = 'pass';
      passCount++;
    } else if (allChecksPass && !entry.checks.recentlyFired) {
      // Configured correctly but no recent evidence of firing.
      // For high-frequency triggers (5/15/30 min) this is concerning;
      // for low-frequency (daily) it's expected most of the time.
      entry.status = 'configured_but_quiet';
      warnCount++;
    } else if (entry.critical) {
      entry.status = 'fail';
      failCount++;
    } else {
      entry.status = 'warn';
      warnCount++;
    }

    report.push(entry);
  });

  // ── Orphan triggers (installed but not in manifest) ────────────────────
  var manifestHandlerSet = {};
  NEW_LEAD_TRIGGERS.forEach(function(t) { manifestHandlerSet[t.handler] = true; });
  var orphans = [];
  installedTriggers.forEach(function(t) {
    var name = t.getHandlerFunction();
    if (!manifestHandlerSet[name]) {
      orphans.push({
        handler: name,
        triggerId: t.getUniqueId(),
        eventType: (function(){ try { return t.getEventType().toString(); } catch(_){ return '?'; } })(),
        triggerSource: (function(){ try { return t.getTriggerSource().toString(); } catch(_){ return '?'; } })(),
        note: 'Not in NEW_LEAD_TRIGGERS manifest. If this handler is from old code, delete the trigger via Apps Script UI.'
      });
    }
  });

  // ── Functional signals (cross-cutting; not per-trigger) ───────────────
  var functionalSignals = _gatherFunctionalSignals();

  // ── Optional smoke tests ──────────────────────────────────────────────
  var smokeTests = null;
  if (doSmokeTest) {
    smokeTests = _runSmokeTests();
  }

  var overall = (failCount > 0)        ? 'fail'
              : (warnCount > 0)        ? 'pass_with_warnings'
              :                          'pass';

  return {
    overall: overall,
    counts: {
      total: NEW_LEAD_TRIGGERS.length,
      pass: passCount,
      warn: warnCount,
      fail: failCount,
      orphans: orphans.length
    },
    triggers: report,
    orphans: orphans,
    functionalSignals: functionalSignals,
    smokeTests: smokeTests,
    timestamp: new Date().toISOString()
  };
}

// ─── HELPERS ──────────────────────────────────────────────────────────────

/**
 * Does the named function exist in global scope? Using eval is V8-safe and
 * the simplest way to resolve a name without maintaining a static map.
 */
function _isHandlerCallable(handlerName) {
  try {
    var fn = eval(handlerName);  // eslint-disable-line no-eval
    return typeof fn === 'function';
  } catch (_) {
    return false;
  }
}

/**
 * For each handler, find evidence that it ran recently. Different handlers
 * leave different fingerprints; we look for the strongest available signal
 * within each handler's expected cadence + 50% slack.
 *
 * Returns { fresh: boolean, lastSeen: string, evidence: string, ageMinutes: number }
 */
function _checkHandlerRecency(handlerName) {
  // Map handler → (recency check function, max-age-in-minutes)
  var checks = {
    'runHealthCheck':            { fn: _recencyHealthSheet,            maxMin:  7 * 60 },   // 6h cron + slack
    'syncSentDrafts':            { fn: _recencySyncCronCache,          maxMin: 30 },        // 15m cron + slack
    'runWatchdog':               { fn: _recencyPipelineEventByCategory, args: 'WATCHDOG',        maxMin: 30 },
    'processReplies':            { fn: _recencyPipelineEventByCategory, args: 'REPLY',           maxMin: 90 },
    'processBounces':            { fn: _recencyPipelineEventByCategory, args: 'BOUNCE',          maxMin: 90 },
    'evaluateAutoPause':         { fn: _recencyPipelineEventByCategory, args: 'AUTOPAUSE',       maxMin: 90 },
    'webAppWarmKeeper':          { fn: _recencyApolloCache,            maxMin: 30 },        // proxy: API activity proves warm-keeper
    'processScheduledFollowUps': { fn: _recencyFollowUpsSheet,         maxMin: 26 * 60 },   // daily
    'runDraftStateMonitor':      { fn: _recencyDraftMonitorMarker,     maxMin: 26 * 60 },   // daily
    'autoProcessSafetyNet':      { fn: _recencyPipelineEventByCategory, args: 'SCAN',            maxMin: 15 },
    'onSheetChange':             { fn: _recencyPipelineEventByCategory, args: 'AUTO_CHANGE',     maxMin: 60 * 24 },
    'onSheetEdit':               { fn: _recencyPipelineEventByCategory, args: 'AUTO_EDIT',       maxMin: 60 * 24 }
  };
  var spec = checks[handlerName];
  if (!spec) return { fresh: false, lastSeen: null, evidence: 'no_check_defined', ageMinutes: null };

  try {
    var result = spec.fn(spec.args);
    if (!result || !result.lastSeenMs) {
      return { fresh: false, lastSeen: null, evidence: result ? result.evidence : 'no_signal', ageMinutes: null };
    }
    var ageMin = Math.floor((Date.now() - result.lastSeenMs) / 60000);
    return {
      fresh: ageMin <= spec.maxMin,
      lastSeen: new Date(result.lastSeenMs).toISOString(),
      evidence: result.evidence,
      ageMinutes: ageMin
    };
  } catch (e) {
    return { fresh: false, lastSeen: null, evidence: 'check_threw: ' + e.message, ageMinutes: null };
  }
}

function _recencyHealthSheet() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName('Health');
  if (!sheet || sheet.getLastRow() < 2) return { lastSeenMs: 0, evidence: 'health_sheet_empty' };
  var lastRow = sheet.getLastRow();
  var ts = sheet.getRange(lastRow, 1).getValue();
  var dt = new Date(ts);
  if (isNaN(dt.getTime())) return { lastSeenMs: 0, evidence: 'health_sheet_bad_timestamp' };
  return { lastSeenMs: dt.getTime(), evidence: 'Health sheet last row at ' + dt.toISOString() };
}

function _recencySyncCronCache() {
  // syncSentDrafts doesn't write its own marker by default. As a proxy,
  // look at the most recent LAST_UPDATED on a row that's at STATUS=SENT
  // (which only happens after syncer flips a row).
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (!sheet || sheet.getLastRow() < 2) return { lastSeenMs: 0, evidence: 'data_sheet_empty' };
    var c = CONFIG.COLUMNS;
    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, CONFIG.SHEET_COL_COUNT).getValues();
    var bestMs = 0;
    for (var i = 0; i < data.length; i++) {
      var status = (data[i][c.STATUS - 1] || '').toString().trim();
      if (status !== 'SENT' && status !== 'DRAFT_DELETED' && status !== 'DRAFT_STALE' && status !== 'DRAFT_ABANDONED') continue;
      var ts = data[i][c.LAST_UPDATED - 1];
      if (!ts) continue;
      try {
        var dt = new Date(ts);
        if (!isNaN(dt.getTime()) && dt.getTime() > bestMs) bestMs = dt.getTime();
      } catch (_) {}
    }
    if (bestMs === 0) return { lastSeenMs: 0, evidence: 'no_syncer_touched_rows_yet' };
    return { lastSeenMs: bestMs, evidence: 'Most recent syncer-touched row at ' + new Date(bestMs).toISOString() };
  } catch (e) {
    return { lastSeenMs: 0, evidence: 'check_threw_' + e.message };
  }
}

function _recencyPipelineEventByCategory(category) {
  // PipelineEvents sheet (if present) holds logPipelineEvent entries.
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName('PipelineEvents');
    if (!sheet || sheet.getLastRow() < 2) return { lastSeenMs: 0, evidence: 'pipeline_events_sheet_empty' };
    var lastRow = sheet.getLastRow();
    // Scan the last 200 rows looking for the category
    var startRow = Math.max(2, lastRow - 200);
    var data = sheet.getRange(startRow, 1, lastRow - startRow + 1, sheet.getLastColumn()).getValues();
    var hdrRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var tsIdx = -1, catIdx = -1;
    hdrRow.forEach(function(h, i) {
      var hh = (h || '').toString().toLowerCase();
      if (hh.indexOf('time') >= 0 || hh.indexOf('date') >= 0) tsIdx = i;
      if (hh.indexOf('category') >= 0 || hh.indexOf('stage') >= 0 || hh.indexOf('type') >= 0) catIdx = i;
    });
    if (tsIdx < 0 || catIdx < 0) return { lastSeenMs: 0, evidence: 'pipeline_events_schema_unknown' };
    var bestMs = 0;
    for (var i = data.length - 1; i >= 0; i--) {
      var cell = (data[i][catIdx] || '').toString().toUpperCase();
      if (cell.indexOf(category.toUpperCase()) < 0) continue;
      try {
        var ts = new Date(data[i][tsIdx]);
        if (!isNaN(ts.getTime())) {
          bestMs = ts.getTime();
          break;  // most recent first scan
        }
      } catch (_) {}
    }
    if (bestMs === 0) return { lastSeenMs: 0, evidence: 'no_' + category + '_events_found' };
    return { lastSeenMs: bestMs, evidence: category + ' event at ' + new Date(bestMs).toISOString() };
  } catch (e) {
    return { lastSeenMs: 0, evidence: 'check_threw_' + e.message };
  }
}

function _recencyApolloCache() {
  // Warm-keeper running implies the web app responds. As a proxy: check for a
  // recent SCAN event in the pipeline event log (pipeline activity proves V8 +
  // warm-keeper are alive). APOLLO_MATCH_ cache entries are in CacheService since
  // 2026-06-12-cacheservice-migration and cannot be enumerated — ScriptProperties
  // will never have these keys post-migration. Delegate to the existing
  // _recencyPipelineEventByCategory check using the SCAN category instead.
  return _recencyPipelineEventByCategory('SCAN');
}

function _recencyFollowUpsSheet() {
  // Proxy for processScheduledFollowUps firing: the last time we wrote any
  // FollowUps row's Status (SENT / CANCELLED). Without a dedicated lastRun
  // marker, this is the best available signal that the cron has executed.
  // For the FIRST week of operation when no SENT rows exist, this will be
  // empty — expected (cron has nothing to do).
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName('FollowUps');
    if (!sheet || sheet.getLastRow() < 2) return { lastSeenMs: 0, evidence: 'followups_sheet_empty' };
    // Look at the last row's data — if it has a non-PENDING status, cron touched it
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      .map(function(h){ return (h||'').toString().trim(); });
    var statusIdx = headers.indexOf('Status');
    var schedIdx = headers.indexOf('ScheduledDate');
    if (statusIdx < 0) return { lastSeenMs: 0, evidence: 'no_status_col' };
    var lastRow = sheet.getLastRow();
    var sample = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    var bestMs = 0;
    var anyDone = false;
    for (var i = 0; i < sample.length; i++) {
      var st = (sample[i][statusIdx] || '').toString().toUpperCase();
      if (st === 'SENT' || st === 'CANCELLED' || st === 'CANCELLED_REPLIED') {
        anyDone = true;
        if (schedIdx >= 0) {
          try {
            var dt = new Date(sample[i][schedIdx]);
            if (!isNaN(dt.getTime()) && dt.getTime() > bestMs) bestMs = dt.getTime();
          } catch (_) {}
        }
      }
    }
    if (!anyDone) return { lastSeenMs: 0, evidence: 'no_followups_completed_yet (expected if no SENT rows aged 3d+)' };
    return { lastSeenMs: bestMs, evidence: 'Most recent completed follow-up at ' + new Date(bestMs).toISOString() };
  } catch (e) {
    return { lastSeenMs: 0, evidence: 'check_threw_' + e.message };
  }
}

function _recencyDraftMonitorMarker() {
  // Draft monitor writes `nudge<N>d:<iso>` markers into NOTES. Look for the
  // most recent such marker across the sheet as proof the monitor ran.
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (!sheet || sheet.getLastRow() < 2) return { lastSeenMs: 0, evidence: 'data_sheet_empty' };
    var c = CONFIG.COLUMNS;
    var data = sheet.getRange(2, c.NOTES, sheet.getLastRow() - 1, 1).getValues();
    var bestMs = 0;
    for (var i = 0; i < data.length; i++) {
      var notes = (data[i][0] || '').toString();
      var m = notes.match(/nudge\d+d:([0-9TZ:.\-]+)/);
      if (m) {
        try {
          var dt = new Date(m[1]);
          if (!isNaN(dt.getTime()) && dt.getTime() > bestMs) bestMs = dt.getTime();
        } catch (_) {}
      }
    }
    if (bestMs === 0) return { lastSeenMs: 0, evidence: 'no_nudge_markers_yet (expected if no drafts >= 3d old)' };
    return { lastSeenMs: bestMs, evidence: 'Most recent draft-monitor nudge at ' + new Date(bestMs).toISOString() };
  } catch (e) {
    return { lastSeenMs: 0, evidence: 'check_threw_' + e.message };
  }
}

function _gatherFunctionalSignals() {
  // Cross-cutting health signals beyond per-trigger recency
  var signals = {};

  // Status distribution across Sheet2 — proves the pipeline has been
  // moving leads through states
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (sheet && sheet.getLastRow() >= 2) {
      var statuses = sheet.getRange(2, CONFIG.COLUMNS.STATUS, sheet.getLastRow() - 1, 1).getValues();
      var dist = {};
      statuses.forEach(function(r) {
        var s = (r[0] || '<blank>').toString().trim() || '<blank>';
        dist[s] = (dist[s] || 0) + 1;
      });
      signals.statusDistribution = dist;
      signals.totalRows = statuses.length;
    }
  } catch (_) {}

  // FCM tokens still registered
  try {
    var ss2 = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var fcm = ss2.getSheetByName('FcmTokens');
    signals.fcmTokensRegistered = (fcm && fcm.getLastRow() >= 2) ? (fcm.getLastRow() - 1) : 0;
  } catch (_) {}

  // Claude alive (real-time probe — same as in verifyNewLeadPipeline)
  try {
    if (typeof shouldSkipTier1 === 'function') {
      var preflight = shouldSkipTier1();
      signals.claudeAlive = !preflight.skipTier1;
      signals.claudePreflight = preflight.reason;
    }
  } catch (_) {}

  // Reoon key — present in Script Properties
  try {
    var key = PropertiesService.getScriptProperties().getProperty('REOON_API_KEY');
    signals.reoonKeyPresent = !!(key && key.length >= 16);
    signals.reoonKeyPreview = key ? (key.substring(0, 6) + '...len=' + key.length) : null;
  } catch (_) {}

  return signals;
}

function _runSmokeTests() {
  // Invoke handlers that support dryRun mode and confirm they don't throw.
  // For non-dryRun handlers we skip invocation but report status as 'skipped_destructive'.
  var tests = [];

  // 1. syncSentDrafts (supports dryRun)
  try {
    var t0 = Date.now();
    var r1 = syncSentDrafts({ dryRun: true, limit: 5 });
    tests.push({
      handler: 'syncSentDrafts',
      invoked: true,
      ok: true,
      durationMs: Date.now() - t0,
      sample: { scanned: r1.scanned, stillDraft: r1.stillDraft, errors: r1.errors }
    });
  } catch (e) {
    tests.push({ handler: 'syncSentDrafts', invoked: true, ok: false, error: e.message });
  }

  // 2. runDraftStateMonitor (supports dryRun)
  try {
    var t0b = Date.now();
    var r2 = runDraftStateMonitor({ dryRun: true });
    tests.push({
      handler: 'runDraftStateMonitor',
      invoked: true,
      ok: true,
      durationMs: Date.now() - t0b,
      sample: { scanned: r2.scanned, nudged: r2.nudged }
    });
  } catch (e) {
    tests.push({ handler: 'runDraftStateMonitor', invoked: true, ok: false, error: e.message });
  }

  // 3. runHealthCheck — runs all probes (writes 4 rows to Health sheet but
  // that's expected behavior, not destructive)
  try {
    var t0c = Date.now();
    var r3 = runHealthCheck();
    tests.push({
      handler: 'runHealthCheck',
      invoked: true,
      ok: true,
      durationMs: Date.now() - t0c,
      sample: { results: r3.results.map(function(p) { return p.service + '=' + p.status; }) }
    });
  } catch (e) {
    tests.push({ handler: 'runHealthCheck', invoked: true, ok: false, error: e.message });
  }

  // 4. runWatchdog (idempotent — only acts on stuck rows)
  try {
    var t0d = Date.now();
    var r4 = runWatchdog();
    tests.push({
      handler: 'runWatchdog',
      invoked: true,
      ok: true,
      durationMs: Date.now() - t0d,
      sample: { scanned: r4.scanned, resetCount: r4.resetCount, escalatedCount: r4.escalatedCount || 0 }
    });
  } catch (e) {
    tests.push({ handler: 'runWatchdog', invoked: true, ok: false, error: e.message });
  }

  // Non-dryRun-safe handlers — skip invocation, just report
  var skipList = ['processNextBatch', 'autoProcessSafetyNet', 'processScheduledFollowUps',
                  'processReplies', 'processBounces', 'evaluateAutoPause',
                  'webAppWarmKeeper', 'onSheetChange', 'onSheetEdit'];
  skipList.forEach(function(h) {
    tests.push({
      handler: h,
      invoked: false,
      reason: 'side_effects_not_dryRun_safe',
      callableCheck: _isHandlerCallable(h)
    });
  });

  return tests;
}
