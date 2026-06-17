/**
 * ============================================================
 * DraftStateMonitor.gs — Lifecycle nudges for unsent drafts
 * (Patch 2026-05-19)
 * ============================================================
 *
 * Problem solved: drafts that get created by the pipeline but sit in
 * Gmail Drafts forever because the user never clicks Send. Previously
 * these were invisible to the rest of the pipeline — no follow-ups
 * could fire (gated on SENT), no notifications surfaced.
 *
 * This monitor runs once a day and applies graduated nudges:
 *
 *   Age 3 days:  FCM nudge (gentle)    — "Draft for <name> ready 3d"
 *   Age 7 days:  FCM nudge (firmer)    — "Draft for <name> waiting 1w"
 *   Age 14 days: STATUS=DRAFT_STALE    — FCM with action hint
 *   Age 30 days: STATUS=DRAFT_ABANDONED — auto-archive (still in Gmail)
 *
 * Idempotency: tracks last-nudged timestamp per stage in NOTES via
 * `nudge<DAYS>d:<iso>` markers, so re-running on the same day produces
 * no duplicate notifications.
 *
 * Reversibility: any DRAFT_STALE or DRAFT_ABANDONED row can be restored
 * by manually flipping STATUS back to DRAFT_CREATED. If the user
 * actually clicks Send during the staleness window, the next syncSentDrafts
 * cron run will catch it and flip to SENT normally (syncer doesn't care
 * about staleness state).
 *
 * All scenarios handled gracefully:
 *   - Sent right away    → syncSentDrafts catches within 15 min, normal flow
 *   - Sent days later    → syncSentDrafts 90-day window catches it, normal flow
 *   - Sent weeks later   → syncSentDrafts catches up to 90 days post-creation
 *   - Sent very late     → admin can run sync_sent_drafts with &searchDays=180
 *   - Deleted before send → syncSentDrafts flips to DRAFT_DELETED + FCM
 *   - Kept in drafts     → DraftStateMonitor nudges then archives gracefully
 */

var DRAFT_STATE_NUDGE_STAGES = [
  { days: 3,  flipTo: null,                  fcmTitle: 'Draft ready 3 days',
    fcmBody: 'Your AutoMail draft for <NAME> at <ORG> has been ready for 3 days. Open Gmail to send, edit, or skip.' },
  { days: 7,  flipTo: null,                  fcmTitle: 'Draft waiting a week',
    fcmBody: 'Your AutoMail draft for <NAME> at <ORG> has been waiting 7 days. Send it before the trigger event becomes stale.' },
  { days: 14, flipTo: 'DRAFT_STALE',         fcmTitle: 'Draft marked stale',
    fcmBody: 'Draft for <NAME> at <ORG> sat 14 days. Marked DRAFT_STALE — research signals may be outdated. Re-trigger via force_recompose or send as-is.' },
  { days: 30, flipTo: 'DRAFT_ABANDONED',     fcmTitle: 'Draft auto-archived',
    fcmBody: 'Draft for <NAME> at <ORG> sat 30 days without action. Marked DRAFT_ABANDONED. Edit status to DRAFT_CREATED to revive.' }
];

/**
 * Daily nudge sweep. Walks every DRAFT_CREATED + DRAFT_STALE row, computes
 * age from LAST_UPDATED, applies the appropriate stage.
 *
 * @param {Object} [options]
 *   {boolean} dryRun       — scan + report but don't mutate / FCM
 *   {number}  fcmThrottleMs — minimum gap between FCM sends to the same lead
 *                             (default: 20h — prevents rapid re-nudge if you run
 *                             this manually multiple times the same day)
 *
 * @returns {Object} { scanned, nudged, flippedStale, flippedAbandoned, fcmsSent, dryRun, results }
 */
function runDraftStateMonitor(options) {
  options = options || {};
  var dryRun = !!options.dryRun;
  var fcmThrottleMs = options.fcmThrottleMs || (20 * 3600 * 1000);

  Logger.log('[DraftStateMonitor] Starting at ' + new Date().toISOString() + ' dryRun=' + dryRun);

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet) return _draftMonitorEmpty(dryRun);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return _draftMonitorEmpty(dryRun);

  var c = CONFIG.COLUMNS;
  var data = sheet.getRange(2, 1, lastRow - 1, CONFIG.SHEET_COL_COUNT).getValues();
  var now = Date.now();

  var scanned = 0;
  var nudged = 0;
  var flippedStale = 0;
  var flippedAbandoned = 0;
  var fcmsSent = 0;
  var results = [];

  // Acquire script lock so we don't race with the syncer or batch
  var lock = LockService.getScriptLock();
  var lockHeld = false;
  if (!dryRun) {
    lockHeld = lock.tryLock(10000);
    if (!lockHeld) {
      Logger.log('[DraftStateMonitor] Could not acquire lock — aborting');
      return _draftMonitorEmpty(dryRun, 'lock_busy');
    }
  }

  try {
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      var rowNum = i + 2;
      var status = (row[c.STATUS - 1] || '').toString().trim();
      // Only operate on draft-state rows that aren't already terminal
      if (status !== STATUS.DRAFT_CREATED && status !== STATUS.DRAFT_STALE) continue;
      scanned++;

      var lastUpd = row[c.LAST_UPDATED - 1];
      var ageMs = 0;
      if (lastUpd) {
        try {
          var ts = (lastUpd instanceof Date) ? lastUpd : new Date(lastUpd);
          if (!isNaN(ts.getTime())) ageMs = now - ts.getTime();
        } catch (_) {}
      }
      if (ageMs <= 0) continue;  // can't determine age — skip

      var ageDays = Math.floor(ageMs / 86400000);
      var fullName = (row[c.FULL_NAME - 1] || '').toString().trim() || '(unnamed)';
      var orgName  = (row[c.ORGANIZATION - 1] || '').toString().trim() || 'their team';
      var notes    = (row[c.NOTES - 1] || '').toString();

      // Determine the highest stage this row qualifies for that hasn't
      // already been nudged today.
      var applicableStage = null;
      for (var s = DRAFT_STATE_NUDGE_STAGES.length - 1; s >= 0; s--) {
        var st = DRAFT_STATE_NUDGE_STAGES[s];
        if (ageDays < st.days) continue;
        // Check if we already nudged at this stage in the throttle window
        var nudgeKey = 'nudge' + st.days + 'd:';
        var nudgeMatch = notes.match(new RegExp(nudgeKey + '([0-9TZ:\\-.]+)'));
        if (nudgeMatch) {
          var lastNudgeIso = nudgeMatch[1];
          var lastNudgeMs = 0;
          try { lastNudgeMs = new Date(lastNudgeIso).getTime(); } catch (_) {}
          if (lastNudgeMs && (now - lastNudgeMs) < fcmThrottleMs) {
            // Already nudged at this stage within the throttle window
            continue;
          }
        }
        applicableStage = st;
        break;
      }

      if (!applicableStage) continue;

      var rec = {
        rowNum: rowNum,
        fullName: fullName,
        organization: orgName,
        ageDays: ageDays,
        nudgeStage: applicableStage.days + 'd',
        flipTo: applicableStage.flipTo || null,
        action: dryRun ? 'would_nudge' : 'nudged'
      };

      if (!dryRun) {
        // 1) Status flip (if this stage prescribes one)
        try {
          if (applicableStage.flipTo === 'DRAFT_STALE') {
            sheet.getRange(rowNum, c.STATUS).setValue(STATUS.DRAFT_STALE);
            flippedStale++;
          } else if (applicableStage.flipTo === 'DRAFT_ABANDONED') {
            sheet.getRange(rowNum, c.STATUS).setValue(STATUS.DRAFT_ABANDONED);
            flippedAbandoned++;
          }
        } catch (statusErr) {
          rec.statusError = statusErr.message;
        }

        // 2) FCM push
        try {
          var fcmBody = applicableStage.fcmBody
            .replace(/<NAME>/g, fullName)
            .replace(/<ORG>/g, orgName);
          if (typeof sendFcmBroadcast === 'function') {
            var fcmResult = sendFcmBroadcast(applicableStage.fcmTitle, fcmBody, {
              event: 'draft_state_nudge',
              stage: String(applicableStage.days) + 'd',
              leadRow: String(rowNum),
              flipTo: applicableStage.flipTo || ''
            });
            if (fcmResult && fcmResult.sent > 0) {
              fcmsSent += fcmResult.sent;
              rec.fcmsSent = fcmResult.sent;
            } else {
              rec.fcmsSent = 0;
              rec.fcmDetail = (fcmResult && fcmResult.reason) || 'no_send';
            }
          }
        } catch (fcmErr) {
          rec.fcmError = fcmErr.message;
        }

        // 3) Annotate NOTES with the nudge timestamp + cleaned previous
        try {
          var cleanedNotes = notes.replace(new RegExp('nudge' + applicableStage.days + 'd:[^\\s|]+\\s*\\|?\\s*', 'g'), '').trim();
          var marker = 'nudge' + applicableStage.days + 'd:' + new Date().toISOString();
          var newNote = '[' + marker + ' ' +
                        (applicableStage.flipTo ? '→ ' + applicableStage.flipTo : 'FCM nudge') + '] ' +
                        'Draft age ' + ageDays + 'd. Sent FCM "' + applicableStage.fcmTitle + '". ' +
                        (cleanedNotes ? 'Previous: ' + cleanedNotes.substring(0, 1200) : '');
          sheet.getRange(rowNum, c.NOTES).setValue(newNote.substring(0, 1900));
          sheet.getRange(rowNum, c.LAST_UPDATED).setValue(new Date().toISOString());
        } catch (notesErr) {
          rec.notesError = notesErr.message;
        }

        nudged++;
      }

      results.push(rec);
    }
  } finally {
    if (lockHeld) lock.releaseLock();
  }

  Logger.log('[DraftStateMonitor] Done. scanned=' + scanned + ' nudged=' + nudged +
             ' fcmsSent=' + fcmsSent + ' stale=' + flippedStale + ' abandoned=' + flippedAbandoned +
             ' dryRun=' + dryRun);

  try {
    if (typeof logPipelineEvent === 'function' && nudged > 0) {
      logPipelineEvent(null, 'DRAFT_MONITOR',
        'Nudged ' + nudged + ' drafts (' + fcmsSent + ' FCMs, ' +
        flippedStale + ' stale-flipped, ' + flippedAbandoned + ' abandoned)' +
        (dryRun ? ' (dry-run)' : ''), 'INFO');
    }
  } catch (_) {}

  return {
    scanned: scanned,
    nudged: nudged,
    fcmsSent: fcmsSent,
    flippedStale: flippedStale,
    flippedAbandoned: flippedAbandoned,
    dryRun: dryRun,
    results: results,
    timestamp: new Date().toISOString()
  };
}

function _draftMonitorEmpty(dryRun, aborted) {
  return {
    scanned: 0, nudged: 0, fcmsSent: 0,
    flippedStale: 0, flippedAbandoned: 0,
    dryRun: dryRun, results: [],
    aborted: aborted || null
  };
}

/**
 * Installer for the daily cron at 10 AM. Idempotent.
 */
function installDraftStateMonitorTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'runDraftStateMonitor') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('runDraftStateMonitor')
    .timeBased()
    .atHour(10)
    .everyDays(1)
    .create();
  Logger.log('[DraftStateMonitor] Trigger installed: runDraftStateMonitor daily @ 10 AM');
  return 'installed_daily_10am';
}
