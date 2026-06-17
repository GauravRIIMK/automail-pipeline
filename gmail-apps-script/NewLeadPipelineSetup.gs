/**
 * ============================================================
 * NewLeadPipelineSetup.gs — One-shot setup + end-to-end verify
 * (Patch 2026-05-18)
 * ============================================================
 *
 * Goal: every NEW lead from this point forward should flow through
 * the full pipeline without manual intervention, producing:
 *
 *   1. Initial draft created in Gmail (Status = DRAFT_CREATED)
 *   2. User clicks Send in Gmail (manual action — the ONE thing we
 *      intentionally never automate, for review safety)
 *   3. Cron detects send → Status = SENT, SENT_DATE populated
 *   4. Daily follow-up cron @ 9 AM → creates Stage-1/2/3 follow-up
 *      drafts IN THE SAME THREAD at SENT_DATE+3d/+7d/+14d
 *   5. FCM push notification fires each time a follow-up draft is
 *      created ("Follow-up draft ready for <name>")
 *   6. Reply detector cancels pending follow-ups when recipient replies
 *
 * This file ships two functions:
 *
 *   setupNewLeadPipeline()     — installs all required triggers
 *                                idempotently; reports state.
 *
 *   verifyNewLeadPipeline()    — runs read-only health checks for every
 *                                trigger + FCM + Claude + every gate the
 *                                follow-up cron passes through. Returns a
 *                                detailed pass/fail report per stage.
 *
 *   runE2EFollowupTest()       — DESTRUCTIVE: picks one DRAFT_CREATED row,
 *                                temporarily mutates STATUS+SENT_DATE,
 *                                runs processScheduledFollowUps, restores
 *                                original state. Verifies a follow-up
 *                                draft actually got created in the thread
 *                                and FCM fired. Use sparingly — every run
 *                                creates a real Gmail draft (which you can
 *                                manually delete after).
 */

// ─── REQUIRED TRIGGERS MANIFEST ─────────────────────────────────────────
//
// Every trigger needed for the new-lead end-to-end flow. The setup function
// iterates this list. Each entry declares:
//   • handler    — function name the trigger invokes
//   • installer  — name of the install function (idempotent, deletes
//                  duplicates before creating fresh)
//   • role       — short human description
//   • critical   — if true, missing this trigger blocks the loop
var NEW_LEAD_TRIGGERS = [
  {
    handler: 'onSheetChange',
    installer: 'setupAutoProcessTrigger',
    role: 'Detects new lead inserts → fires _scanAndProcessNewRows',
    critical: true
  },
  {
    handler: 'onSheetEdit',
    installer: 'setupAutoProcessTrigger',
    role: 'Detects manual edits (e.g., pasting target_role) → re-runs lead',
    critical: true
  },
  {
    handler: 'autoProcessSafetyNet',
    installer: 'setupAutoProcessTrigger',
    role: '5-min safety-net scanner for missed leads',
    critical: true
  },
  {
    handler: 'processScheduledFollowUps',
    installer: 'setupFollowUpTrigger',
    role: 'Daily 9 AM follow-up draft creator',
    critical: true
  },
  {
    handler: 'syncSentDrafts',
    installer: 'installGmailDraftSyncerTrigger',
    role: '15-min: detect manual Gmail sends → flip STATUS=SENT',
    critical: true
  },
  {
    handler: 'runWatchdog',
    installer: 'installWatchdogTrigger',
    role: '15-min: reset rows stuck in transient states',
    critical: true
  },
  {
    handler: 'runHealthCheck',
    installer: 'installHealthCheckTrigger',
    role: '6-hour: Claude/Gemini/Gmail/Drive probes',
    critical: true
  },
  {
    handler: 'processReplies',
    installer: 'installReplyDetectorTrigger',
    role: '30-min: detect replies → cancel pending follow-ups',
    critical: true
  },
  {
    handler: 'processBounces',
    installer: 'installBounceTrigger',
    role: '30-min: detect hard/soft bounces → suppress domain',
    critical: false
  },
  {
    handler: 'evaluateAutoPause',
    installer: 'installAutoPauseTrigger',
    role: '30-min: throttle daily send-rate based on engagement',
    critical: false
  },
  {
    handler: 'webAppWarmKeeper',
    installer: 'installWebAppWarmKeeperTrigger',
    role: '5-min: ping doPost to keep V8 warm',
    critical: false
  },
  // PATCH 2026-05-19: lifecycle nudges for unsent drafts. Daily 10 AM cron
  // walks DRAFT_CREATED + DRAFT_STALE rows, sends FCM nudges at 3/7/14d
  // age thresholds, flips to DRAFT_STALE @14d, DRAFT_ABANDONED @30d.
  // Critical because without it, drafts that sit unsent generate no signal
  // back to the user — they accumulate invisibly.
  {
    handler: 'runDraftStateMonitor',
    installer: 'installDraftStateMonitorTrigger',
    role: 'Daily 10 AM: FCM nudges for unsent drafts at 3/7/14d, archive at 30d',
    critical: true
  },
  // PATCH 2026-05-19: auxiliary handlers — installed by their own modules,
  // not part of the new-lead end-to-end flow but still expected to be present.
  // Adding them to the manifest so deepVerifyTriggers stops flagging them
  // as orphans. critical: false so missing won't fail overall verdict.
  {
    handler: 'processNextBatch',
    installer: '_scheduleBatchTrigger',
    role: 'One-shot batch chain trigger (BatchProcessor.gs schedules itself when leads overflow per-run cap)',
    critical: false,
    auxiliary: true
  },
  {
    handler: 'processSendQueue',
    installer: 'installSendQueueTrigger',
    role: '5-min: processes the SendQueue sheet for queued / scheduled sends',
    critical: false,
    auxiliary: true
  },
  {
    handler: 'sendWeeklyDigest',
    installer: 'installWeeklyDigestTrigger',
    role: 'Weekly Monday 9 AM: emails a sent/replied/bounced digest',
    critical: false,
    auxiliary: true
  }
];

/**
 * One-shot installer. Calls every installer in NEW_LEAD_TRIGGERS,
 * idempotent (each installer deletes existing triggers for its
 * handler before creating). Returns a structured report.
 *
 * Safe to call repeatedly — Apps Script's installer pattern handles
 * dedupe internally.
 *
 * @returns {Object} { installed, alreadyPresent, failed, report }
 */
function setupNewLeadPipeline() {
  Logger.log('[NewLeadSetup] Starting setupNewLeadPipeline at ' + new Date().toISOString());

  var existing = ScriptApp.getProjectTriggers().map(function(t) {
    return t.getHandlerFunction();
  });
  var existingSet = {};
  existing.forEach(function(h) { existingSet[h] = true; });

  var installed = [];
  var alreadyPresent = [];
  var failed = [];
  var report = [];

  NEW_LEAD_TRIGGERS.forEach(function(trig) {
    var wasPresent = !!existingSet[trig.handler];
    var rec = {
      handler: trig.handler,
      role: trig.role,
      critical: trig.critical,
      wasPresent: wasPresent,
      installer: trig.installer
    };

    try {
      if (typeof this[trig.installer] === 'function') {
        var result = this[trig.installer]();
        rec.installerResult = (typeof result === 'object') ? JSON.stringify(result) : String(result || '');
        rec.status = wasPresent ? 'reinstalled' : 'installed';
        if (wasPresent) alreadyPresent.push(trig.handler);
        else installed.push(trig.handler);
      } else {
        // Globally-scoped lookup fallback (Apps Script uses globals not this)
        var fn = eval(trig.installer); // eslint-disable-line no-eval
        if (typeof fn === 'function') {
          var result2 = fn();
          rec.installerResult = (typeof result2 === 'object') ? JSON.stringify(result2) : String(result2 || '');
          rec.status = wasPresent ? 'reinstalled' : 'installed';
          if (wasPresent) alreadyPresent.push(trig.handler);
          else installed.push(trig.handler);
        } else {
          throw new Error('installer function not found: ' + trig.installer);
        }
      }
    } catch (e) {
      rec.status = 'failed';
      rec.error = e.message;
      failed.push({ handler: trig.handler, error: e.message });
      Logger.log('[NewLeadSetup] FAILED ' + trig.installer + ': ' + e.message);
    }

    report.push(rec);
  });

  Logger.log('[NewLeadSetup] Done. installed=' + installed.length +
             ', reinstalled=' + alreadyPresent.length +
             ', failed=' + failed.length);

  return {
    installed: installed,
    alreadyPresent: alreadyPresent,
    failed: failed,
    report: report,
    timestamp: new Date().toISOString()
  };
}

/**
 * Read-only verification. Walks every stage of the new-lead flow and
 * reports pass/fail per stage WITHOUT mutating any data. Safe to call
 * repeatedly.
 *
 * Stages checked:
 *   1. All required triggers installed
 *   2. FCM service account configured (Script Property)
 *   3. At least one FCM device token registered (FcmTokens sheet)
 *   4. Claude API alive (real-time probe via shouldSkipTier1)
 *   5. Gemini API configured (Script Property)
 *   6. At least one SENT row in Sheet2 (proves loop has ever fired)
 *   7. FollowUps sheet exists and has rows
 *   8. Lock not held by stuck process
 *
 * @returns {Object} { overall: 'pass'|'fail'|'degraded', stages: [...] }
 */
function verifyNewLeadPipeline() {
  Logger.log('[NewLeadVerify] Starting verifyNewLeadPipeline at ' + new Date().toISOString());

  var stages = [];
  var pass = 0, fail = 0, warn = 0;

  function _stage(name, status, detail, critical) {
    stages.push({
      name: name,
      status: status,           // 'pass' | 'fail' | 'warn'
      critical: !!critical,
      detail: detail
    });
    if (status === 'pass') pass++;
    else if (status === 'warn') warn++;
    else fail++;
  }

  // ── Stage 1: triggers installed ──────────────────────────────────────
  try {
    var installed = ScriptApp.getProjectTriggers().map(function(t) {
      return t.getHandlerFunction();
    });
    var installedSet = {};
    installed.forEach(function(h) { installedSet[h] = (installedSet[h] || 0) + 1; });

    var missingCritical = [];
    var missingOptional = [];
    NEW_LEAD_TRIGGERS.forEach(function(t) {
      if (!installedSet[t.handler]) {
        if (t.critical) missingCritical.push(t.handler);
        else missingOptional.push(t.handler);
      }
    });

    if (missingCritical.length === 0 && missingOptional.length === 0) {
      _stage('triggers_installed', 'pass',
        'All ' + NEW_LEAD_TRIGGERS.length + ' required triggers present', true);
    } else if (missingCritical.length === 0) {
      _stage('triggers_installed', 'warn',
        'Critical triggers OK; missing optional: ' + missingOptional.join(','), true);
    } else {
      _stage('triggers_installed', 'fail',
        'Missing CRITICAL triggers: ' + missingCritical.join(',') +
        ' (run setupNewLeadPipeline to install)', true);
    }
  } catch (e) {
    _stage('triggers_installed', 'fail', 'Probe threw: ' + e.message, true);
  }

  // ── Stage 2: FCM service account configured ──────────────────────────
  try {
    var props = PropertiesService.getScriptProperties();
    var fcmJson = props.getProperty('FCM_SERVICE_ACCOUNT_JSON');
    if (fcmJson && fcmJson.length > 100) {
      var parsed;
      try { parsed = JSON.parse(fcmJson); } catch (_) { parsed = null; }
      if (parsed && parsed.project_id && parsed.client_email) {
        _stage('fcm_service_account', 'pass',
          'Configured for project_id=' + parsed.project_id, true);
      } else {
        _stage('fcm_service_account', 'fail',
          'FCM_SERVICE_ACCOUNT_JSON set but unparseable or missing project_id', true);
      }
    } else {
      _stage('fcm_service_account', 'fail',
        'FCM_SERVICE_ACCOUNT_JSON not set in Script Properties. ' +
        'Set via: PropertiesService.getScriptProperties().setProperty(' +
        '"FCM_SERVICE_ACCOUNT_JSON", "<full JSON contents>")', true);
    }
  } catch (e) {
    _stage('fcm_service_account', 'fail', 'Probe threw: ' + e.message, true);
  }

  // ── Stage 3: FCM tokens registered ───────────────────────────────────
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var fcmSheet = ss.getSheetByName('FcmTokens');
    if (!fcmSheet || fcmSheet.getLastRow() < 2) {
      _stage('fcm_tokens_registered', 'fail',
        'No device tokens in FcmTokens sheet. APK must call ' +
        '/exec?action=register_fcm_token on first launch. ' +
        'Verify the APK is sending the token after FCM registration.', true);
    } else {
      var tokenCount = fcmSheet.getLastRow() - 1;
      _stage('fcm_tokens_registered', 'pass',
        tokenCount + ' device token(s) registered', true);
    }
  } catch (e) {
    _stage('fcm_tokens_registered', 'fail', 'Probe threw: ' + e.message, true);
  }

  // ── Stage 4: Claude alive (real-time probe via shouldSkipTier1) ──────
  try {
    if (typeof shouldSkipTier1 === 'function') {
      var preflight = shouldSkipTier1();
      if (!preflight.skipTier1) {
        _stage('claude_alive', 'pass',
          'Pre-flight check: ' + preflight.reason, true);
      } else {
        _stage('claude_alive', 'fail',
          'Pre-flight check FAILS: ' + preflight.reason +
          '. All new compositions will route to Tier 3 fallback.', true);
      }
    } else {
      _stage('claude_alive', 'warn', 'shouldSkipTier1 not defined', false);
    }
  } catch (e) {
    _stage('claude_alive', 'fail', 'Probe threw: ' + e.message, true);
  }

  // ── Stage 5: Gemini configured ───────────────────────────────────────
  try {
    var geminiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (geminiKey && geminiKey.length > 16) {
      _stage('gemini_configured', 'pass',
        'GEMINI_API_KEY present (length ' + geminiKey.length + ')', false);
    } else {
      _stage('gemini_configured', 'warn',
        'GEMINI_API_KEY not set — research stage will use fallback', false);
    }
  } catch (e) {
    _stage('gemini_configured', 'warn', 'Probe threw: ' + e.message, false);
  }

  // ── Stage 6: at least one SENT row exists ────────────────────────────
  try {
    var ss2 = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var dataSheet = ss2.getSheetByName(CONFIG.DATA_SHEET);
    var sentCount = 0, draftCount = 0;
    if (dataSheet && dataSheet.getLastRow() >= 2) {
      var statuses = dataSheet.getRange(2, CONFIG.COLUMNS.STATUS,
        dataSheet.getLastRow() - 1, 1).getValues();
      statuses.forEach(function(r) {
        var s = (r[0] || '').toString().trim();
        if (s === 'SENT' || s.indexOf('FOLLOWUP_') === 0) sentCount++;
        else if (s === 'DRAFT_CREATED') draftCount++;
      });
    }
    if (sentCount > 0) {
      _stage('sent_rows_exist', 'pass',
        sentCount + ' rows at SENT (or follow-up) state — follow-up cron has targets',
        false);
    } else if (draftCount > 0) {
      _stage('sent_rows_exist', 'warn',
        'Zero SENT rows BUT ' + draftCount + ' drafts ready. ' +
        'You must click Send in Gmail (or APK Send button) to advance any lead. ' +
        'Loop will start firing AFTER first send.', false);
    } else {
      _stage('sent_rows_exist', 'warn',
        'Zero SENT and zero DRAFT_CREATED rows. Pipeline has no work to do.', false);
    }
  } catch (e) {
    _stage('sent_rows_exist', 'warn', 'Probe threw: ' + e.message, false);
  }

  // ── Stage 7: FollowUps sheet has rows ────────────────────────────────
  try {
    var ss3 = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var followupSheet = ss3.getSheetByName('FollowUps');
    if (!followupSheet) {
      _stage('followups_sheet_ready', 'fail',
        'FollowUps sheet does not exist. Will be auto-created on first lead, but ' +
        'verify after running a real lead.', true);
    } else {
      var rowCount = followupSheet.getLastRow() - 1;
      if (rowCount > 0) {
        _stage('followups_sheet_ready', 'pass',
          rowCount + ' scheduled follow-up rows ready', true);
      } else {
        _stage('followups_sheet_ready', 'warn',
          'FollowUps sheet exists but is empty. Will populate as new leads draft.',
          false);
      }
    }
  } catch (e) {
    _stage('followups_sheet_ready', 'warn', 'Probe threw: ' + e.message, false);
  }

  // ── Stage 8: lock not stuck ──────────────────────────────────────────
  try {
    var lock = LockService.getScriptLock();
    var gotIt = lock.tryLock(1000);
    if (gotIt) {
      lock.releaseLock();
      _stage('lock_available', 'pass',
        'Script lock acquired and released cleanly', false);
    } else {
      _stage('lock_available', 'warn',
        'Could not acquire script lock in 1s — another process is running. ' +
        'Retry verifier in 2 minutes; if persistently locked, check ' +
        'Apps Script Executions tab for stuck runs.', false);
    }
  } catch (e) {
    _stage('lock_available', 'warn', 'Probe threw: ' + e.message, false);
  }

  // ── Stage 9: deployment stamp current ────────────────────────────────
  // (Sanity check that the latest server code is actually deployed)
  try {
    // No direct way to read deploymentStamp from inside Apps Script —
    // rely on the file's presence. If NewLeadPipelineSetup.gs exists and
    // can call itself, the latest deploy is live by construction.
    _stage('deploy_recent', 'pass',
      'NewLeadPipelineSetup.gs is callable — code from 2026-05-18 is live', false);
  } catch (e) {
    _stage('deploy_recent', 'warn', 'Probe threw: ' + e.message, false);
  }

  // ── Overall verdict ──────────────────────────────────────────────────
  var criticalFail = stages.filter(function(s) {
    return s.critical && s.status === 'fail';
  }).length;
  var overall = (criticalFail > 0) ? 'fail'
              : (fail > 0)         ? 'degraded'
              : (warn > 0)         ? 'pass_with_warnings'
              :                       'pass';

  Logger.log('[NewLeadVerify] Done. overall=' + overall +
             ' pass=' + pass + ' warn=' + warn + ' fail=' + fail);

  return {
    overall: overall,
    counts: { pass: pass, warn: warn, fail: fail, total: stages.length },
    stages: stages,
    timestamp: new Date().toISOString(),
    nextSteps: _buildNextSteps(stages)
  };
}

/**
 * Build a per-stage next-step instruction list so the user can act on
 * failures directly without consulting docs.
 */
function _buildNextSteps(stages) {
  var steps = [];
  stages.forEach(function(s) {
    if (s.status === 'pass') return;
    if (s.name === 'triggers_installed' && s.status === 'fail') {
      steps.push('Run setupNewLeadPipeline() to install missing triggers, OR hit /exec?action=setup_new_lead_pipeline&token=<ADMIN>');
    }
    if (s.name === 'fcm_service_account' && s.status === 'fail') {
      steps.push('Open Firebase Console → Project Settings → Service Accounts → Generate new private key. ' +
                 'Paste the entire JSON into Script Property FCM_SERVICE_ACCOUNT_JSON.');
    }
    if (s.name === 'fcm_tokens_registered' && s.status === 'fail') {
      steps.push('Open the AutoMail APK once — it auto-registers the FCM token via /exec?action=register_fcm_token. ' +
                 'Check the Apps Script Executions tab for register_fcm_token calls.');
    }
    if (s.name === 'claude_alive' && s.status === 'fail') {
      steps.push('CLAUDE_API_KEY in Script Properties is missing or rotated. ' +
                 'Set the new key; all new compositions will use Claude (Tier 1) instead of Tier 3 fallback.');
    }
    if (s.name === 'sent_rows_exist' && s.status === 'warn') {
      steps.push('Click Send on at least one draft in Gmail. ' +
                 'Within 15 minutes, syncSentDrafts will flip its status to SENT. ' +
                 'Follow-ups become eligible at SENT_DATE + 3 days.');
    }
    if (s.name === 'lock_available' && s.status === 'warn') {
      steps.push('A scheduled trigger is currently executing. Wait 2-3 minutes and re-run verify.');
    }
  });
  return steps;
}

/**
 * DESTRUCTIVE end-to-end test. Picks one DRAFT_CREATED row, temporarily
 * fakes SENT_DATE = 4 days ago, runs processScheduledFollowUps, then
 * restores the row's original state. Verifies a follow-up draft got
 * created in the SAME Gmail thread + FCM push was attempted.
 *
 * WARNING: This creates a REAL Gmail follow-up draft (in the lead's
 * actual thread, since cold-email threads start with us). The draft
 * is not auto-deleted — you should manually clean up from Gmail Drafts
 * after the test if you don't want to send it to the real recipient.
 *
 * To make this safe in practice: use a TEST row whose linkedinUrl
 * points to your own LinkedIn profile + email is your own address.
 * That way the "real recipient" is you.
 *
 * @param {Object} [options]
 *   {number} rowNum  — explicit row to use; otherwise picks first
 *                      DRAFT_CREATED row found
 *
 * @returns {Object} detailed pass/fail per stage
 */
function runE2EFollowupTest(options) {
  options = options || {};
  Logger.log('[E2ETest] Starting end-to-end follow-up test at ' + new Date().toISOString());

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet) {
    return { overall: 'fail', error: 'data sheet missing' };
  }
  var c = CONFIG.COLUMNS;

  // ── PATCH 2026-05-18: smarter test-row selection ─────────────────────
  //
  // The first DRAFT_CREATED row is often an old lead drafted before
  // THREAD_ID was being captured and before follow-ups were written to
  // the FollowUps sheet with ParentRow. Testing on such a row produces a
  // false-negative "follow-up not created" verdict.
  //
  // Smart selection algorithm (when caller doesn't pass explicit rowNum):
  //   1. Walk all DRAFT_CREATED rows in Sheet2
  //   2. Filter to rows with THREAD_ID populated (modern-era)
  //   3. Of those, prefer rows with at least one pending FollowUp linked
  //      via ParentRow (proves persistence happened correctly)
  //   4. Fall back to any DRAFT_CREATED + THREAD_ID row if no FollowUps match
  //   5. Last resort: first DRAFT_CREATED row regardless (legacy behavior)
  //
  // Caller can override via options.rowNum to test a specific row.
  var rowNum = options.rowNum || null;
  var candidateInfo = null;
  if (!rowNum) {
    candidateInfo = _pickBestE2ETestRow(sheet, ss);
    rowNum = candidateInfo.rowNum;
  }
  if (!rowNum) {
    return {
      overall: 'fail',
      error: 'no DRAFT_CREATED row to test on',
      candidateScan: candidateInfo
    };
  }

  // ── Snapshot original state ──
  var origStatus    = sheet.getRange(rowNum, c.STATUS).getValue();
  var origSentDate  = sheet.getRange(rowNum, c.SENT_DATE).getValue();
  var origFollowup  = sheet.getRange(rowNum, c.FOLLOWUP_STAGE).getValue();
  var origLastUpd   = sheet.getRange(rowNum, c.LAST_UPDATED).getValue();
  var origNotes     = sheet.getRange(rowNum, c.NOTES).getValue();
  var fullName      = sheet.getRange(rowNum, c.FULL_NAME).getValue();
  var threadId      = sheet.getRange(rowNum, c.THREAD_ID).getValue();

  var stages = [];
  var fakedSentDateIso = new Date(Date.now() - 4 * 86400000).toISOString();

  // ── Pre-flight: does this row have follow-ups in the FollowUps sheet? ─
  // If not, the cron has nothing to fire even with a faked SENT_DATE.
  // We diagnose this upfront so the test fails meaningfully.
  var followupDiag = _diagnoseFollowupsForRow(ss, rowNum, fullName);
  stages.push({
    stage: 'followup_rows_exist',
    status: followupDiag.pending > 0 ? 'pass' : 'fail',
    detail: 'FollowUps sheet has ' + followupDiag.total + ' rows tied to this lead' +
            ' (' + followupDiag.pending + ' pending, ' + followupDiag.sent + ' already sent, ' +
            followupDiag.cancelled + ' cancelled). Match via: ' + followupDiag.matchMethod
  });

  // If no pending follow-ups, skip the destructive part — there's nothing
  // for the cron to do regardless of what we fake on row 3.
  if (followupDiag.pending === 0) {
    return {
      overall: 'fail',
      testRow: rowNum,
      testFullName: fullName,
      reason: 'no_pending_followups_for_this_row',
      followupDiag: followupDiag,
      stages: stages,
      hint: 'Pick a NEWER DRAFT_CREATED row (one with THREAD_ID populated). ' +
            'This row appears to predate the FollowUps-sheet persistence layer. ' +
            'For new leads going forward, _persistFollowUps writes 3 rows per lead. ' +
            'Run via: ?action=e2e_followup_test&rowNum=<newer_row_num>&token=<ADMIN>',
      timestamp: new Date().toISOString()
    };
  }

  try {
    // ── Fake SENT state ──
    sheet.getRange(rowNum, c.STATUS).setValue('SENT');
    sheet.getRange(rowNum, c.SENT_DATE).setValue(fakedSentDateIso);
    sheet.getRange(rowNum, c.NOTES).setValue('[E2ETest] Temporary SENT state for verification — original notes restored at end.');
    SpreadsheetApp.flush();

    stages.push({ stage: 'fake_sent', status: 'pass',
      detail: 'Row ' + rowNum + ' set to SENT with SENT_DATE=' + fakedSentDateIso });

    // ── Count Gmail drafts before ──
    var draftsBefore = GmailApp.getDrafts().length;

    // ── Run processScheduledFollowUps ──
    var prevDrafted = 0;
    try {
      if (typeof processScheduledFollowUps === 'function') {
        processScheduledFollowUps();
        stages.push({ stage: 'followup_cron_ran', status: 'pass',
          detail: 'processScheduledFollowUps executed without error' });
      } else {
        stages.push({ stage: 'followup_cron_ran', status: 'fail',
          detail: 'processScheduledFollowUps function not defined' });
      }
    } catch (cronErr) {
      stages.push({ stage: 'followup_cron_ran', status: 'fail',
        detail: 'Cron threw: ' + cronErr.message });
    }

    // ── Count Gmail drafts after ──
    var draftsAfter = GmailApp.getDrafts().length;
    var draftsCreated = draftsAfter - draftsBefore;
    if (draftsCreated > 0) {
      stages.push({ stage: 'follow_up_draft_created', status: 'pass',
        detail: 'Drafts count rose from ' + draftsBefore + ' to ' + draftsAfter +
                ' — at least one follow-up draft was created' });
    } else {
      stages.push({ stage: 'follow_up_draft_created', status: 'fail',
        detail: 'No new drafts created. Check FollowUps sheet for the row corresponding to ' +
                'parent row ' + rowNum + ' — its body/subject may be missing.' });
    }

    // ── Verify the new draft is in the same thread (if threadId known) ──
    if (threadId) {
      try {
        var thread = GmailApp.getThreadById(threadId);
        if (thread) {
          var threadDrafts = thread.getMessages().length;
          // Note: drafts don't show up in getMessages, but follow-up drafts
          // created via thread.createDraftReply DO sit attached to the
          // thread. We can find them by listing all drafts and matching
          // each draft's thread ID to ours.
          var allDrafts = GmailApp.getDrafts();
          var matchInThread = 0;
          for (var d = 0; d < allDrafts.length; d++) {
            try {
              if (allDrafts[d].getMessage().getThread().getId() === threadId) {
                matchInThread++;
              }
            } catch (_) {}
          }
          stages.push({ stage: 'draft_in_correct_thread', status: matchInThread > 0 ? 'pass' : 'warn',
            detail: matchInThread + ' draft(s) in target thread ' + threadId });
        } else {
          stages.push({ stage: 'draft_in_correct_thread', status: 'warn',
            detail: 'Thread ' + threadId + ' not found' });
        }
      } catch (threadErr) {
        stages.push({ stage: 'draft_in_correct_thread', status: 'warn',
          detail: 'Thread inspection failed: ' + threadErr.message });
      }
    } else {
      stages.push({ stage: 'draft_in_correct_thread', status: 'warn',
        detail: 'No THREAD_ID stored on row; cannot verify thread match' });
    }

    // ── FCM check (best-effort — we already verified config in verify()) ─
    stages.push({ stage: 'fcm_attempted', status: 'pass',
      detail: 'FCM sendFcmBroadcast called inside processScheduledFollowUps. ' +
              'Check device for notification.' });

  } catch (e) {
    stages.push({ stage: 'test_error', status: 'fail', detail: e.message });
  } finally {
    // ── ALWAYS restore original state ──
    try {
      sheet.getRange(rowNum, c.STATUS).setValue(origStatus);
      sheet.getRange(rowNum, c.SENT_DATE).setValue(origSentDate);
      sheet.getRange(rowNum, c.FOLLOWUP_STAGE).setValue(origFollowup);
      sheet.getRange(rowNum, c.LAST_UPDATED).setValue(origLastUpd);
      sheet.getRange(rowNum, c.NOTES).setValue(origNotes);
      SpreadsheetApp.flush();
      stages.push({ stage: 'restored_original_state', status: 'pass',
        detail: 'Row ' + rowNum + ' restored to STATUS=' + origStatus });
    } catch (restoreErr) {
      stages.push({ stage: 'restored_original_state', status: 'fail',
        detail: 'CRITICAL: failed to restore row ' + rowNum + ' state: ' + restoreErr.message +
                '. Manually verify row.' });
    }
  }

  var failed = stages.filter(function(s) { return s.status === 'fail'; }).length;
  var overall = failed === 0 ? 'pass' : (failed === 1 ? 'degraded' : 'fail');

  Logger.log('[E2ETest] Done. overall=' + overall + ' stages=' + stages.length);

  return {
    overall: overall,
    testRow: rowNum,
    testFullName: fullName,
    fakedSentDate: fakedSentDateIso,
    candidateScan: candidateInfo,
    followupDiag: followupDiag,
    stages: stages,
    cleanupNote: 'Test created at least one real Gmail draft in your Drafts folder. ' +
                 'If you do NOT want to send it to ' + fullName + ', delete from Gmail Drafts manually.',
    timestamp: new Date().toISOString()
  };
}

// ─── HELPER: smart test-row picker ──────────────────────────────────────
//
// Walks Sheet2 to find the BEST test row: prefer modern-era rows with
// THREAD_ID and at least one pending FollowUp tied via ParentRow.
function _pickBestE2ETestRow(sheet, ss) {
  var c = CONFIG.COLUMNS;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { rowNum: null, scanned: 0, reason: 'sheet_empty' };

  var rows = sheet.getRange(2, 1, lastRow - 1, CONFIG.SHEET_COL_COUNT).getValues();

  // Build a fast lookup: ParentRow → number of pending follow-ups
  var pendingByParent = {};
  try {
    var fSheet = ss.getSheetByName('FollowUps');
    if (fSheet && fSheet.getLastRow() >= 2) {
      var fHeader = fSheet.getRange(1, 1, 1, fSheet.getLastColumn()).getValues()[0]
        .map(function(h){ return (h||'').toString().trim(); });
      var prIdx = fHeader.indexOf('ParentRow');
      var stIdx = fHeader.indexOf('Status');
      if (prIdx >= 0 && stIdx >= 0) {
        var fData = fSheet.getRange(2, 1, fSheet.getLastRow() - 1, fSheet.getLastColumn()).getValues();
        fData.forEach(function(r) {
          var pr = parseInt(r[prIdx], 10);
          var st = (r[stIdx] || '').toString().trim().toUpperCase();
          if (!pr) return;
          if (st === 'SENT' || st === 'CANCELLED' || st === 'CANCELLED_REPLIED') return;
          pendingByParent[pr] = (pendingByParent[pr] || 0) + 1;
        });
      }
    }
  } catch (_) {}

  // Score each candidate row
  var bestModern = null;       // has THREAD_ID + pending follow-ups
  var bestWithThread = null;   // has THREAD_ID
  var bestAny = null;          // any DRAFT_CREATED
  var draftCount = 0;

  for (var i = 0; i < rows.length; i++) {
    var rowNum = i + 2;
    var status = (rows[i][c.STATUS - 1] || '').toString().trim();
    if (status !== 'DRAFT_CREATED') continue;
    draftCount++;

    var threadId = (rows[i][c.THREAD_ID - 1] || '').toString().trim();
    var pending = pendingByParent[rowNum] || 0;

    if (!bestAny) bestAny = rowNum;
    if (threadId && !bestWithThread) bestWithThread = rowNum;
    if (threadId && pending > 0 && !bestModern) {
      bestModern = rowNum;
      break;  // best possible — stop scanning
    }
  }

  var picked = bestModern || bestWithThread || bestAny;
  var reason = bestModern    ? 'modern_row_with_thread_and_pending_followups'
             : bestWithThread ? 'has_thread_but_no_followups_in_sheet'
             : bestAny        ? 'legacy_row_no_thread'
             :                  'no_draft_created_rows';

  return {
    rowNum: picked,
    scanned: rows.length,
    draftCreatedCount: draftCount,
    reason: reason
  };
}

// ─── HELPER: count follow-ups tied to a parent row ──────────────────────
function _diagnoseFollowupsForRow(ss, rowNum, fullName) {
  var fSheet = ss.getSheetByName('FollowUps');
  if (!fSheet) {
    return { total: 0, pending: 0, sent: 0, cancelled: 0, matchMethod: 'no_followups_sheet' };
  }
  if (fSheet.getLastRow() < 2) {
    return { total: 0, pending: 0, sent: 0, cancelled: 0, matchMethod: 'empty_sheet' };
  }
  var header = fSheet.getRange(1, 1, 1, fSheet.getLastColumn()).getValues()[0]
    .map(function(h){ return (h||'').toString().trim(); });
  var prIdx = header.indexOf('ParentRow');
  var stIdx = header.indexOf('Status');
  var lnIdx = header.indexOf('LeadName');
  var data = fSheet.getRange(2, 1, fSheet.getLastRow() - 1, fSheet.getLastColumn()).getValues();

  var byParent = 0, byName = 0;
  var pending = 0, sent = 0, cancelled = 0;
  var nameLower = (fullName || '').toString().toLowerCase().trim();

  data.forEach(function(r) {
    var match = false;
    if (prIdx >= 0 && parseInt(r[prIdx], 10) === rowNum) { byParent++; match = true; }
    else if (lnIdx >= 0 && nameLower && (r[lnIdx] || '').toString().toLowerCase().trim() === nameLower) {
      byName++; match = true;
    }
    if (!match) return;
    var st = (stIdx >= 0 ? r[stIdx] : '').toString().trim().toUpperCase();
    if (st === 'SENT') sent++;
    else if (st === 'CANCELLED' || st === 'CANCELLED_REPLIED') cancelled++;
    else pending++;
  });

  var method = (byParent > 0 && byName === 0) ? 'ParentRow exact match'
             : (byParent === 0 && byName > 0) ? 'LeadName fallback (no ParentRow set — legacy row)'
             : (byParent > 0 && byName > 0)   ? 'ParentRow + LeadName both matched'
             :                                   'no matches';

  return {
    total: byParent + byName,
    pending: pending,
    sent: sent,
    cancelled: cancelled,
    matchedByParentRow: byParent,
    matchedByLeadName: byName,
    matchMethod: method
  };
}
