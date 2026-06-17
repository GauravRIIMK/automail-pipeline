/**
 * ============================================================
 * SendQueue.gs — Scheduled-send for cold outreach (Patch 2026-05-12)
 *
 * Lets the APK schedule a draft to be sent at a future timestamp (e.g.,
 * 9am tomorrow recipient-local) rather than firing GmailApp.send() now.
 * Uses a SendQueue sheet + 5-min trigger to fire pending sends.
 *
 * Endpoints (in WebApp.gs):
 *   POST /exec?action=schedule_send → enqueue {draftId, sendAt}
 *   GET  /exec?action=send_queue → list pending entries
 *
 * Cron: processSendQueue() — every 5 min trigger fires sends whose time
 * has come. AutoPauseManager.isPaused() gate is checked first.
 * ============================================================
 */

var SEND_QUEUE_SHEET = 'SendQueue';

function _sendQueueEnsureSheet(ss) {
  var sheet = ss.getSheetByName(SEND_QUEUE_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SEND_QUEUE_SHEET);
    sheet.appendRow([
      'Enqueued_At', 'Draft_ID', 'Send_At', 'Status', 'Lead_Row',
      'Lead_Email', 'Sent_Message_ID', 'Sent_At', 'Error'
    ]);
    sheet.getRange(1, 1, 1, 9).setFontWeight('bold');
  }
  return sheet;
}

/** Public: enqueue. Called by WebApp.gs action=schedule_send. */
function enqueueScheduledSend(draftId, sendAtIso, leadRow, leadEmail) {
  if (!draftId || !sendAtIso) {
    return { status: 'error', error: 'missing_draftId_or_sendAt' };
  }
  var sendAtTs;
  try { sendAtTs = new Date(sendAtIso).getTime(); }
  catch (e) { return { status: 'error', error: 'invalid_sendAt: ' + e.message }; }
  if (!isFinite(sendAtTs) || sendAtTs < Date.now() - 60000) {
    return { status: 'error', error: 'sendAt_in_past' };
  }
  // Validate the draft exists before queueing
  try { GmailApp.getDraft(draftId); }
  catch (e) { return { status: 'error', error: 'draft_not_found: ' + e.message }; }

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = _sendQueueEnsureSheet(ss);
  // Idempotent: if this draft is already queued, update instead of duplicate
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] === draftId && data[i][3] === 'PENDING') {
      sheet.getRange(i + 1, 3).setValue(new Date(sendAtTs).toISOString());
      return { status: 'ok', action: 'updated', rowNum: i + 1, sendAt: new Date(sendAtTs).toISOString() };
    }
  }
  sheet.appendRow([
    new Date().toISOString(),
    draftId,
    new Date(sendAtTs).toISOString(),
    'PENDING',
    leadRow || '',
    leadEmail || '',
    '', '', ''
  ]);
  Logger.log('[SendQueue] Enqueued draft ' + draftId.substring(0, 12) + '… for ' + new Date(sendAtTs).toISOString());
  return { status: 'ok', action: 'queued', sendAt: new Date(sendAtTs).toISOString() };
}

/** Cron handler: every 5 min, fire any PENDING sends whose time has come. */
function processSendQueue() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SEND_QUEUE_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { sent: 0 };

  // Auto-pause guard — if the rolling reply-rate dropped too low, hold all sends
  if (typeof isPipelinePaused === 'function' && isPipelinePaused()) {
    Logger.log('[SendQueue] Pipeline auto-paused — holding all pending sends');
    return { sent: 0, paused: true };
  }

  var data = sheet.getDataRange().getValues();
  var nowMs = Date.now();
  var sentCount = 0;
  var failedCount = 0;

  for (var i = 1; i < data.length; i++) {
    var status = (data[i][3] || '').toString();
    if (status !== 'PENDING') continue;
    var sendAtTs;
    try { sendAtTs = new Date(data[i][2]).getTime(); } catch (_) { continue; }
    if (!isFinite(sendAtTs) || sendAtTs > nowMs) continue;

    var draftId = data[i][1];
    if (!draftId) continue;

    try {
      var draft = GmailApp.getDraft(draftId);
      if (!draft) {
        sheet.getRange(i + 1, 4).setValue('FAILED');
        sheet.getRange(i + 1, 9).setValue('draft_not_found_at_send_time');
        failedCount++;
        continue;
      }
      var msg = draft.send();
      sheet.getRange(i + 1, 4).setValue('SENT');
      sheet.getRange(i + 1, 7).setValue(msg.getId());
      sheet.getRange(i + 1, 8).setValue(new Date().toISOString());

      // Update Sheet2 STATUS = SENT for the matching lead row
      var leadRow = parseInt(data[i][4]);
      if (leadRow > 1) {
        try {
          var sheet2 = ss.getSheetByName(CONFIG.DATA_SHEET);
          if (sheet2) {
            sheet2.getRange(leadRow, CONFIG.COLUMNS.STATUS).setValue('SENT');
            sheet2.getRange(leadRow, CONFIG.COLUMNS.LAST_UPDATED).setValue(new Date().toISOString());
          }
        } catch (s2err) {
          Logger.log('[SendQueue] Sheet2 update failed for row ' + leadRow + ': ' + s2err.message);
        }
      }
      sentCount++;
      Logger.log('[SendQueue] Sent draft ' + draftId.substring(0, 12) + '… (scheduled ' + data[i][2] + ')');
    } catch (sendErr) {
      sheet.getRange(i + 1, 4).setValue('FAILED');
      sheet.getRange(i + 1, 9).setValue(sendErr.message.substring(0, 200));
      failedCount++;
      Logger.log('[SendQueue] Send failed for draft ' + draftId + ': ' + sendErr.message);
    }
  }
  return { status: 'ok', sent: sentCount, failed: failedCount };
}

/** Install the 5-min trigger. Call once. Idempotent. */
function installSendQueueTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'processSendQueue') ScriptApp.deleteTrigger(existing[i]);
  }
  ScriptApp.newTrigger('processSendQueue').timeBased().everyMinutes(5).create();
  return { status: 'ok', schedule: '5min' };
}

function listSendQueue() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(SEND_QUEUE_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { count: 0, queue: [] };
  var data = sheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    out.push({
      rowNum: i + 1,
      enqueuedAt: data[i][0] ? data[i][0].toString() : '',
      draftId: data[i][1],
      sendAt: data[i][2] ? data[i][2].toString() : '',
      status: data[i][3],
      leadRow: data[i][4],
      leadEmail: data[i][5],
      sentMessageId: data[i][6],
      sentAt: data[i][7] ? data[i][7].toString() : '',
      error: data[i][8]
    });
  }
  return { count: out.length, queue: out };
}
