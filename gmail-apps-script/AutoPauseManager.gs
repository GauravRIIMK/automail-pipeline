/**
 * ============================================================
 * AutoPauseManager.gs — Self-protective pause when reply-rate
 * drops, signalling deliverability or list-quality issues
 * (Patch 2026-05-12)
 *
 * Rolling 7-day calculation:
 *   reply_rate = replies_received / emails_sent
 *   bounce_rate = hard_bounces / emails_sent
 *
 * Pause conditions (ANY triggers pause):
 *   - emails_sent >= 10 AND reply_rate < 0.02  (2 %)
 *   - hard_bounce_rate > 0.05                  (5 %)
 *
 * Stored: ScriptProperty AUTO_PAUSE_STATE = JSON
 *   { paused: bool, since: iso, reason: str, replyRate: num,
 *     bounceRate: num, emailsSent: int, evaluatedAt: iso }
 *
 * 30-min trigger: evaluateAutoPause() refreshes the state.
 * Read API: isPipelinePaused() → boolean, used by SendQueue +
 *   GmailDrafter to short-circuit sending when paused.
 *
 * Notification: when state flips OFF→ON, emails the project owner.
 * Manual override: setAutoPauseOverride(reasonString) /
 *   clearAutoPauseOverride() — for after the user has fixed the
 *   underlying issue and wants to resume sending.
 * ============================================================
 */

var AUTO_PAUSE_STATE_KEY = 'AUTO_PAUSE_STATE';
var AUTO_PAUSE_OVERRIDE_KEY = 'AUTO_PAUSE_OVERRIDE';

var PAUSE_MIN_VOLUME = 50;          // min emails sent before reply-rate triggers (was 10)
var PAUSE_MIN_AGE_DAYS = 7;         // campaign must be at least this old before reply-rate triggers
var PAUSE_REPLY_RATE_THRESHOLD = 0.02;
var PAUSE_BOUNCE_RATE_THRESHOLD = 0.05;

function evaluateAutoPause() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sevenDayAgo = Date.now() - 7 * 86400 * 1000;

  var emailsSent = 0;
  var replies = 0;
  var hardBounces = 0;

  // Count emails sent in last 7d from SendQueue (where Status=SENT) + Sheet2 (STATUS=SENT)
  // Prefer Sheet2 STATUS over SendQueue because manual sends bypass SendQueue.
  var sheet2 = ss.getSheetByName(CONFIG.DATA_SHEET);
  var c = CONFIG.COLUMNS;
  if (sheet2 && sheet2.getLastRow() >= 2) {
    var data = sheet2.getRange(2, 1, sheet2.getLastRow() - 1, CONFIG.SHEET_COL_COUNT || 26).getValues();
    for (var i = 0; i < data.length; i++) {
      var status = (data[i][c.STATUS - 1] || '').toString();
      var lastUpdated = data[i][c.LAST_UPDATED - 1];
      if (!lastUpdated) continue;
      var ts;
      try { ts = new Date(lastUpdated).getTime(); } catch (_) { continue; }
      if (ts < sevenDayAgo) continue;
      if (status === 'SENT' || status === 'REPLIED' || status.indexOf('BOUNCED') === 0) {
        emailsSent++;
      }
    }
  }

  // Replies in last 7d from RepliedLog
  var rlog = ss.getSheetByName('RepliedLog');
  if (rlog && rlog.getLastRow() >= 2) {
    var rd = rlog.getDataRange().getValues();
    for (var j = 1; j < rd.length; j++) {
      try { if (new Date(rd[j][0]).getTime() >= sevenDayAgo) replies++; } catch (_) {}
    }
  }

  // Hard bounces in last 7d from BounceLog
  var blog = ss.getSheetByName('BounceLog');
  if (blog && blog.getLastRow() >= 2) {
    var bd = blog.getDataRange().getValues();
    for (var k = 1; k < bd.length; k++) {
      try {
        if (new Date(bd[k][0]).getTime() < sevenDayAgo) continue;
        if ((bd[k][3] || '').toString() === 'hard') hardBounces++;
      } catch (_) {}
    }
  }

  var replyRate = emailsSent > 0 ? replies / emailsSent : 0;
  var bounceRate = emailsSent > 0 ? hardBounces / emailsSent : 0;

  var shouldPause = false;
  var pauseReason = '';
  if (emailsSent >= PAUSE_MIN_VOLUME) {
    if (replyRate < PAUSE_REPLY_RATE_THRESHOLD) {
      // Age guard: skip reply-rate trigger if campaign is less than PAUSE_MIN_AGE_DAYS old
      var earliestSendMs = _getEarliestSendTs(sheet2, c);
      var ageMs = Date.now() - earliestSendMs;
      if (ageMs < PAUSE_MIN_AGE_DAYS * 86400000) {
        Logger.log('[AutoPause] campaign age <' + PAUSE_MIN_AGE_DAYS + 'd (' +
                   Math.round(ageMs / 86400000) + 'd), skipping reply-rate trigger');
      } else {
        shouldPause = true;
        pauseReason = 'reply_rate_' + replyRate.toFixed(3) + '_below_' + PAUSE_REPLY_RATE_THRESHOLD;
      }
    }
    if (bounceRate > PAUSE_BOUNCE_RATE_THRESHOLD) {
      shouldPause = true;
      pauseReason = (pauseReason ? pauseReason + '__AND__' : '') +
                    'bounce_rate_' + bounceRate.toFixed(3) + '_above_' + PAUSE_BOUNCE_RATE_THRESHOLD;
    }
  }

  var props = PropertiesService.getScriptProperties();
  var previousRaw = props.getProperty(AUTO_PAUSE_STATE_KEY);
  var previous = previousRaw ? JSON.parse(previousRaw) : { paused: false };

  var newState = {
    paused: shouldPause,
    since: shouldPause ? (previous.paused ? previous.since : new Date().toISOString()) : null,
    reason: pauseReason,
    replyRate: replyRate,
    bounceRate: bounceRate,
    emailsSent: emailsSent,
    replies: replies,
    hardBounces: hardBounces,
    evaluatedAt: new Date().toISOString()
  };
  props.setProperty(AUTO_PAUSE_STATE_KEY, JSON.stringify(newState));

  // Notify on flip OFF→ON
  if (shouldPause && !previous.paused) {
    try {
      var owner = Session.getEffectiveUser().getEmail();
      GmailApp.sendEmail(owner, '⚠ AutoMail PAUSED — deliverability alert',
        'Cold-email auto-pause triggered.\n\n' +
        'Reason: ' + pauseReason + '\n' +
        'Emails sent (7d): ' + emailsSent + '\n' +
        'Replies: ' + replies + ' (rate ' + (replyRate * 100).toFixed(1) + '%)\n' +
        'Hard bounces: ' + hardBounces + ' (rate ' + (bounceRate * 100).toFixed(1) + '%)\n\n' +
        'All scheduled sends are HELD until you resolve the issue.\n' +
        'Resume manually via: /exec?action=resume_pipeline (TBD endpoint).\n\n' +
        'Next evaluation in 30 min.',
        { name: 'AutoMail AutoPause' });
    } catch (e) {
      Logger.log('[AutoPause] notify-email failed: ' + e.message);
    }
  }

  Logger.log('[AutoPause] ' + JSON.stringify(newState));
  return newState;
}

/** Public read API — called by SendQueue.processSendQueue() before each send. */
function isPipelinePaused() {
  var props = PropertiesService.getScriptProperties();
  // Manual override takes precedence over auto-eval
  var override = props.getProperty(AUTO_PAUSE_OVERRIDE_KEY);
  if (override === 'PAUSED') return true;
  if (override === 'RESUMED') return false;

  var raw = props.getProperty(AUTO_PAUSE_STATE_KEY);
  if (!raw) return false;
  try {
    return JSON.parse(raw).paused === true;
  } catch (_) { return false; }
}

function getAutoPauseState() {
  var raw = PropertiesService.getScriptProperties().getProperty(AUTO_PAUSE_STATE_KEY);
  if (!raw) return { paused: false, never_evaluated: true };
  try { return JSON.parse(raw); }
  catch (_) { return { paused: false, parse_error: true }; }
}

function setAutoPauseOverride(state) {
  if (state !== 'PAUSED' && state !== 'RESUMED' && state !== 'CLEAR') {
    return { status: 'error', error: 'state_must_be_PAUSED_or_RESUMED_or_CLEAR' };
  }
  var props = PropertiesService.getScriptProperties();
  if (state === 'CLEAR') props.deleteProperty(AUTO_PAUSE_OVERRIDE_KEY);
  else props.setProperty(AUTO_PAUSE_OVERRIDE_KEY, state);
  return { status: 'ok', override: state };
}

/**
 * Scans Sheet2 for the earliest LAST_UPDATED timestamp among rows with STATUS=SENT.
 * Returns a millisecond timestamp, or Date.now() if nothing is found (so the age
 * guard never blocks when there are no sent rows).
 */
function _getEarliestSendTs(sheet2, c) {
  if (!sheet2 || sheet2.getLastRow() < 2) return Date.now();
  try {
    var data = sheet2.getRange(2, 1, sheet2.getLastRow() - 1,
                               CONFIG.SHEET_COL_COUNT || 26).getValues();
    var earliest = Infinity;
    for (var i = 0; i < data.length; i++) {
      var status = (data[i][c.STATUS - 1] || '').toString();
      if (status !== 'SENT') continue;
      var ts;
      try { ts = new Date(data[i][c.LAST_UPDATED - 1]).getTime(); } catch (_) { continue; }
      if (!isNaN(ts) && ts < earliest) earliest = ts;
    }
    return isFinite(earliest) ? earliest : Date.now();
  } catch (e) {
    Logger.log('[AutoPause] _getEarliestSendTs error: ' + e.message);
    return Date.now();
  }
}

function installAutoPauseTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'evaluateAutoPause') ScriptApp.deleteTrigger(existing[i]);
  }
  ScriptApp.newTrigger('evaluateAutoPause').timeBased().everyMinutes(30).create();
  return { status: 'ok', schedule: '30min' };
}
