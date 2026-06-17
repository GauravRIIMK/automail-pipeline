/**
 * ReplyDetector.gs — Auto-mark leads as REPLIED + cancel pending follow-ups
 * (Patch 2026-05-12)
 *
 * 30-minute trigger scans Sent threads from the last 60 days. For each:
 *  - If a NEWER inbound message exists on the thread (someone replied)
 *  - AND the thread maps to a Sheet2 row (via DRAFT_ID or TrackingLinks)
 *  - Update Sheet2 STATUS → REPLIED
 *  - Cancel pending follow-ups for that lead (so we don't double-poke)
 *  - Append to RepliedLog for analytics + weekly digest
 *
 * Idempotent: each thread carries a Gmail label `automail-reply-detected`
 * after first detection; subsequent runs skip already-processed threads.
 */

var REPLY_PROCESSED_LABEL = 'automail-reply-detected';
var REPLIED_LOG_SHEET = 'RepliedLog';

function processReplies() {
  var startedAt = Date.now();

  // ── PATCH 2026-06-13-op-budget: DAILY OP BUDGET GUARD ──────────────────
  // Cap reply.scan Gmail ops to REPLY_DAILY_GMAIL_OP_BUDGET/day. The
  // ReplyDetector consumed 3,232 ops/day (7.5× its 30-min cadence × ~67 ops/tick)
  // before this guard. Budget: 1500 = 7.5% of the ~20K pool.
  // Override: ScriptProperty REPLY_DAILY_GMAIL_OP_BUDGET (integer string).
  (function() {
    try {
      var bRaw = PropertiesService.getScriptProperties().getProperty('REPLY_DAILY_GMAIL_OP_BUDGET');
      var budget = (bRaw && parseInt(bRaw, 10) > 0) ? parseInt(bRaw, 10) : REPLY_DAILY_GMAIL_OP_BUDGET;
      var remaining = (typeof _gmOpBudgetRemaining === 'function')
        ? _gmOpBudgetRemaining('reply.scan', budget) : budget;
      if (remaining <= 0) {
        Logger.log('[ReplyDetector] daily op budget ' + budget + ' reached — skipping to protect draft creation');
        return { status: 'skipped', reason: 'daily_op_budget_reached' };
      }
    } catch (_) {}
  })();
  // Note: the IIFE above cannot early-return from processReplies directly in GAS;
  // instead we re-check the budget inline below before the search.
  var _replyBudget = (function() {
    try {
      var bRaw = PropertiesService.getScriptProperties().getProperty('REPLY_DAILY_GMAIL_OP_BUDGET');
      return (bRaw && parseInt(bRaw, 10) > 0) ? parseInt(bRaw, 10) : REPLY_DAILY_GMAIL_OP_BUDGET;
    } catch (_) { return REPLY_DAILY_GMAIL_OP_BUDGET; }
  })();
  if (typeof _gmOpBudgetRemaining === 'function' && _gmOpBudgetRemaining('reply.scan', _replyBudget) <= 0) {
    Logger.log('[ReplyDetector] daily op budget ' + _replyBudget + ' reached — skipping to protect draft creation');
    return { status: 'skipped', reason: 'daily_op_budget_reached',
             threadsScanned: 0, newRepliesMarked: 0, skipped: 0, durationMs: Date.now() - startedAt };
  }

  var label = GmailApp.getUserLabelByName(REPLY_PROCESSED_LABEL) ||
              GmailApp.createLabel(REPLY_PROCESSED_LABEL);

  // Query: threads I sent to in last 60 days that have at least one reply,
  // excluding ones we've already processed.
  // "in:sent" → I sent at least one message. "newer_than:60d" → recent.
  // We then filter in-script for threads with >1 message (i.e., a reply exists).
  var query = 'in:sent newer_than:60d -label:' + REPLY_PROCESSED_LABEL;
  var threads;
  try {
    threads = GmailApp.search(query, 0, 100);
    if (typeof _gmOps === 'function') _gmOps('reply.scan', 1 + threads.length);
  } catch (e) {
    Logger.log('[ReplyDetector] search failed: ' + e.message);
    return { error: e.message };
  }

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet2 = ss.getSheetByName(CONFIG.DATA_SHEET);
  var logSheet = _replyEnsureLogSheet(ss);
  var processed = 0;
  var marked = 0;
  var skipped = 0;
  var c = CONFIG.COLUMNS;
  var width = CONFIG.SHEET_COL_COUNT || 26;

  for (var t = 0; t < threads.length; t++) {
    if (Date.now() - startedAt > 280000) {  // soft 4m 40s budget
      Logger.log('[ReplyDetector] time budget reached at thread ' + t);
      break;
    }
    var thread = threads[t];
    var messages = thread.getMessages();
    if (messages.length < 2) {
      // Only my outbound message — no reply yet. Don't label; we'll re-check next run.
      skipped++;
      continue;
    }

    // Determine if any message after our own is INBOUND (not from me).
    // GmailApp doesn't expose "from me" directly. We check getFrom() for the user's email.
    var myEmail = Session.getEffectiveUser().getEmail().toLowerCase();
    var inboundFound = false;
    var firstReplyTs = null;
    var firstReplyFrom = '';
    var firstReplySnippet = '';
    for (var m = 1; m < messages.length; m++) {  // skip [0] (original send)
      var msg = messages[m];
      var fromAddr = _extractEmail(msg.getFrom() || '').toLowerCase();
      if (fromAddr && fromAddr !== myEmail) {
        // Skip auto-generated messages (vacation responders, NDRs, OOO, mailing-list
        // confirmations). RFC 3834 defines Auto-Submitted: auto-replied / auto-generated.
        // A value of "no" (or absent) means the message was sent by a human.
        var autoSubmitted = '';
        try { autoSubmitted = msg.getHeader('Auto-Submitted') || ''; } catch (_) {}
        if (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') {
          Logger.log('[ReplyDetector] Skipping auto-reply for thread ' + thread.getId() +
                     ' (Auto-Submitted=' + autoSubmitted + ')');
          continue;
        }
        inboundFound = true;
        firstReplyTs = msg.getDate().toISOString();
        firstReplyFrom = fromAddr;
        firstReplySnippet = (msg.getPlainBody() || '').substring(0, 300).replace(/\s+/g, ' ');
        break;
      }
    }

    if (!inboundFound) {
      // All messages still outbound (resends, drafts, no reply). Skip — don't label.
      skipped++;
      continue;
    }

    var threadId = thread.getId();
    var row = _findSheet2RowByThreadId(sheet2, threadId, c, width);
    if (row < 2) {
      // Reply on a thread we don't track (e.g., personal email) — skip + label
      // so we don't re-scan.
      try { thread.addLabel(label); } catch (_) {}
      skipped++;
      continue;
    }

    var existingStatus = (sheet2.getRange(row, c.STATUS).getValue() || '').toString();
    // PATCH 2026-05-13 (AUDIT F12 / R46): use STATUS.RESPONDED constant
    // (value 'RESPONDED') instead of literal 'REPLIED'. The literal string
    // diverged from Config.gs STATUS enum, so any code checking
    // STATUS.RESPONDED missed all replies detected here. The dashboard at
    // Code.gs:613 lists RESPONDED in statusOrder (not REPLIED), so the UI
    // was also missing these rows. Backward-compat: also accept either
    // legacy value when re-checking existing rows.
    var alreadyMarked = (existingStatus === STATUS.RESPONDED || existingStatus === 'REPLIED');
    if (!alreadyMarked) {
      sheet2.getRange(row, c.STATUS).setValue(STATUS.RESPONDED);
      try { sheet2.getRange(row, c.LAST_UPDATED).setValue(new Date().toISOString()); } catch (_) {}
      // Append reply context to NOTES (truncated)
      try {
        var existingNotes = (sheet2.getRange(row, c.NOTES).getValue() || '').toString();
        var replyNote = '[REPLY ' + firstReplyTs.substring(0, 10) + ' from ' + firstReplyFrom +
                        '] ' + firstReplySnippet.substring(0, 200);
        sheet2.getRange(row, c.NOTES).setValue(
          (existingNotes ? existingNotes + ' | ' : '') + replyNote
        );
      } catch (_) {}
      marked++;
      Logger.log('[ReplyDetector] Marked row ' + row + ' REPLIED (from ' + firstReplyFrom + ')');
    }

    // Cancel pending follow-ups for this lead
    _cancelPendingFollowupsForRow(ss, row);

    // Append RepliedLog entry
    var leadFullName = sheet2.getRange(row, c.FULL_NAME).getValue();
    logSheet.appendRow([
      new Date().toISOString(),
      threadId,
      row,
      leadFullName,
      firstReplyFrom,
      firstReplyTs,
      firstReplySnippet
    ]);

    // PATCH 2026-05-12: FCM push — replies are the highest-signal event
    try {
      if (typeof sendFcmBroadcast === 'function') {
        sendFcmBroadcast('💬 Reply received',
          (leadFullName || firstReplyFrom) + ' replied to your email',
          { event: 'reply', threadId: threadId, leadRow: String(row),
            replyFrom: firstReplyFrom });
      }
    } catch (fcmErr) { Logger.log('[FCM] reply push failed: ' + fcmErr.message); }

    try { thread.addLabel(label); } catch (_) {}
    processed++;
  }

  var summary = {
    status: 'ok',
    threadsScanned: threads.length,
    newRepliesMarked: marked,
    skipped: skipped,
    durationMs: Date.now() - startedAt
  };
  Logger.log('[ReplyDetector] ' + JSON.stringify(summary));
  return summary;
}

function _replyEnsureLogSheet(ss) {
  var sheet = ss.getSheetByName(REPLIED_LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(REPLIED_LOG_SHEET);
    sheet.appendRow([
      'Timestamp', 'Thread_ID', 'Lead_Row', 'Lead_Name',
      'Reply_From', 'Reply_Date', 'Snippet'
    ]);
    sheet.getRange(1, 1, 1, 7).setFontWeight('bold');
  }
  return sheet;
}

function _findSheet2RowByThreadId(sheet2, threadId, c, width) {
  if (!threadId) return -1;
  var lastRow = sheet2.getLastRow();
  if (lastRow < 2) return -1;
  // Strategy A: Sheet2.DRAFT_ID column holds draft id; the draft's threadId
  // matches what we want. To get threadId of a draft, we'd have to call
  // GmailApp.getDraft(draftId).getMessage().getThread().getId() — expensive.
  // Strategy B: Use TrackingLinks (cols H/I store thread_id, draft_id).
  // We pre-load TrackingLinks once. (Caller is in scan loop, but lookup-by-thread
  // is rare — small TrackingLinks sheet means this is fast enough.)
  var ss = sheet2.getParent();
  var links = ss.getSheetByName('TrackingLinks');
  if (links && links.getLastRow() >= 2 && links.getLastColumn() >= 8) {
    var ld = links.getDataRange().getValues();
    for (var i = 1; i < ld.length; i++) {
      if (ld[i][7] === threadId && ld[i][3]) {  // col H = thread_id, col D = lead_row
        var r = parseInt(ld[i][3]);
        if (r >= 2 && r <= lastRow) return r;
      }
    }
  }
  return -1;
}

function _cancelPendingFollowupsForRow(ss, leadRow) {
  var fu = ss.getSheetByName('FollowUps');
  if (!fu || fu.getLastRow() < 2) return;
  var data = fu.getDataRange().getValues();
  var headers = data[0].map(function(h) { return (h || '').toString().trim(); });
  var iParent = headers.indexOf('ParentRow');
  var iStatus = headers.indexOf('Status');
  if (iParent < 0 || iStatus < 0) return;
  var cancelled = 0;
  for (var i = 1; i < data.length; i++) {
    if (parseInt(data[i][iParent]) === leadRow && (data[i][iStatus] || '') !== 'SENT'
        && (data[i][iStatus] || '') !== 'CANCELLED') {
      fu.getRange(i + 1, iStatus + 1).setValue('CANCELLED_REPLIED');
      cancelled++;
    }
  }
  if (cancelled > 0) {
    Logger.log('[ReplyDetector] Cancelled ' + cancelled + ' pending follow-ups for row ' + leadRow);
  }
}

function _extractEmail(headerValue) {
  if (!headerValue) return '';
  var m = headerValue.match(/<([^>]+)>/);
  if (m) return m[1].trim();
  return headerValue.trim();
}

/**
 * One-shot trigger installer. Run once from editor (or via setup endpoint).
 */
function installReplyDetectorTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'processReplies') ScriptApp.deleteTrigger(existing[i]);
  }
  ScriptApp.newTrigger('processReplies').timeBased().everyMinutes(30).create();
  Logger.log('[ReplyDetector] 30-min trigger installed for processReplies');
  return { status: 'ok', schedule: '30min' };
}
