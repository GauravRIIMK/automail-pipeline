/**
 * ============================================================
 * ReviewRowBackfill.gs — Create Gmail drafts for existing REVIEW rows
 * (Patch 2026-05-19)
 * ============================================================
 *
 * Companion to the 2026-05-19 BatchProcessor change that removed the
 * quality.score >= 0.8 gate. Existing rows that landed at STATUS=REVIEW
 * (21+) or NEEDS_REVIEW (2) BEFORE that fix have their full email body
 * + subject stored in Sheet2 (cols L/M) but never had a Gmail draft
 * created — leaving the user with zero actionable artifacts.
 *
 * This function scans those rows, reads the stored body/subject from
 * the sheet, and creates a Gmail draft via the regular createDraft()
 * path. After backfill, every REVIEW/NEEDS_REVIEW row has a draftId
 * and the user can find the corresponding draft in Gmail.
 *
 * Idempotent: skips rows that already have a draftId.
 *
 * Endpoint:
 *   /exec?action=backfill_review_drafts&dryRun=1&token=<ADMIN>   ← preview
 *   /exec?action=backfill_review_drafts&token=<ADMIN>            ← live
 *   /exec?action=backfill_review_drafts&statuses=REVIEW,NEEDS_REVIEW&token=<ADMIN>
 */

function backfillReviewDrafts(options) {
  options = options || {};
  var dryRun = !!options.dryRun;
  var targetStatuses = options.statuses || ['REVIEW', 'NEEDS_REVIEW'];
  var targetSet = {};
  targetStatuses.forEach(function(s) { targetSet[s] = true; });

  Logger.log('[ReviewBackfill] Starting at ' + new Date().toISOString() +
             ' dryRun=' + dryRun + ' targetStatuses=' + targetStatuses.join(','));

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet) return { error: 'data sheet missing' };
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { scanned: 0, drafted: 0, skipped: 0, errored: 0, results: [] };

  var c = CONFIG.COLUMNS;
  var data = sheet.getRange(2, 1, lastRow - 1, CONFIG.SHEET_COL_COUNT).getValues();

  var scanned = 0;
  var drafted = 0;
  var skipped = 0;
  var errored = 0;
  var results = [];

  // Acquire lock so we don't race with active scanner
  var lock = LockService.getScriptLock();
  var lockHeld = false;
  if (!dryRun) {
    lockHeld = lock.tryLock(15000);
    if (!lockHeld) {
      return { aborted: 'lock_busy', message: 'Cannot acquire lock — wait 2 min and retry' };
    }
  }

  try {
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      var rowNum = i + 2;
      var status = (row[c.STATUS - 1] || '').toString().trim();
      if (!targetSet[status]) continue;
      scanned++;

      var existingDraftId = (row[c.DRAFT_ID - 1] || '').toString().trim();
      var subjectLine = (row[c.SUBJECT_LINE - 1] || '').toString();
      var emailBody = (row[c.EMAIL_BODY - 1] || '').toString();
      var fullName = (row[c.FULL_NAME - 1] || '').toString();
      var enrichedEmail = (row[c.ENRICHED_EMAIL - 1] || row[c.EMAIL - 1] || '').toString().trim();
      var archetype = (row[c.ARCHETYPE - 1] || '').toString();
      var variantId = (row[c.RESUME_VARIANT - 1] || 'GROWTH_MARKETING').toString();

      var rec = {
        rowNum: rowNum,
        fullName: fullName,
        email: enrichedEmail,
        status: status,
        action: ''
      };

      // ── Skip if draft already exists ─────────────────────────────────
      if (existingDraftId) {
        // Verify it actually exists in Gmail (not deleted)
        var draftAlive = false;
        try {
          var d = GmailApp.getDraft(existingDraftId);
          draftAlive = !!d;
        } catch (_) { draftAlive = false; }
        if (draftAlive) {
          rec.action = 'skipped_draft_already_exists';
          rec.existingDraftId = existingDraftId;
          skipped++;
          results.push(rec);
          continue;
        }
        // Existing draftId is dead (user deleted) — proceed to recreate
        rec.note = 'existing draftId ' + existingDraftId + ' no longer in Gmail — recreating';
      }

      // ── Skip if essentials missing ───────────────────────────────────
      if (!subjectLine || !emailBody || !enrichedEmail) {
        rec.action = 'skipped_missing_essentials';
        rec.missing = {
          subject: !subjectLine,
          body: !emailBody,
          email: !enrichedEmail
        };
        skipped++;
        results.push(rec);
        continue;
      }

      // ── Dry-run reporting ───────────────────────────────────────────
      if (dryRun) {
        rec.action = 'would_create_draft';
        rec.subjectPreview = subjectLine.substring(0, 80);
        rec.bodyLength = emailBody.length;
        results.push(rec);
        continue;
      }

      // ── Live: reconstruct lead object + create draft ────────────────
      var lead = {
        rowNum: rowNum,
        fullName: fullName,
        email: enrichedEmail,
        organization: (row[c.ORGANIZATION - 1] || '').toString(),
        linkedinUrl: (row[c.LINKEDIN_URL - 1] || '').toString(),
        emailConfidence: parseFloat(row[c.EMAIL_CONFIDENCE - 1]) || 0,
        archetype: archetype
      };
      var metadata = {
        variantId: variantId,
        archetype: archetype,
        emailConfidence: lead.emailConfidence
      };

      try {
        var draftResult = createDraft(lead, subjectLine, emailBody, metadata);
        if (draftResult && draftResult.success) {
          drafted++;
          rec.action = 'draft_created';
          rec.draftId = draftResult.draftId;
          rec.threadId = draftResult.threadId || '';
          // Update sheet: DRAFT_ID + THREAD_ID + RFC822_MESSAGE_ID, preserve STATUS
          sheet.getRange(rowNum, c.DRAFT_ID).setValue(draftResult.draftId);
          if (draftResult.threadId) sheet.getRange(rowNum, c.THREAD_ID).setValue(draftResult.threadId);
          if (draftResult.rfc822MessageId) sheet.getRange(rowNum, c.RFC822_MESSAGE_ID).setValue(draftResult.rfc822MessageId);
          // Append a note to NOTES without overwriting existing
          var existingNotes = (row[c.NOTES - 1] || '').toString();
          var stamp = '[Backfill ' + new Date().toISOString() + '] Draft retroactively created from stored email body. ' +
                      'Original status preserved (' + status + ' — needs your review before send).';
          var newNotes = (stamp + (existingNotes ? ' | Previous: ' + existingNotes : '')).substring(0, 1900);
          sheet.getRange(rowNum, c.NOTES).setValue(newNotes);
          sheet.getRange(rowNum, c.LAST_UPDATED).setValue(new Date().toISOString());
        } else {
          errored++;
          rec.action = 'draft_creation_failed';
          rec.error = draftResult ? draftResult.error : 'no_result';
        }
      } catch (createErr) {
        errored++;
        rec.action = 'draft_creation_threw';
        rec.error = createErr.message;
      }

      results.push(rec);
    }
  } finally {
    if (lockHeld) lock.releaseLock();
  }

  Logger.log('[ReviewBackfill] Done. scanned=' + scanned + ' drafted=' + drafted +
             ' skipped=' + skipped + ' errored=' + errored + ' dryRun=' + dryRun);
  try {
    if (typeof logPipelineEvent === 'function' && drafted > 0) {
      logPipelineEvent(null, 'BACKFILL',
        'Backfilled ' + drafted + ' drafts from stored email bodies' +
        (dryRun ? ' (dry-run)' : ''), 'INFO');
    }
  } catch (_) {}

  return {
    scanned: scanned,
    drafted: drafted,
    skipped: skipped,
    errored: errored,
    dryRun: dryRun,
    results: results,
    timestamp: new Date().toISOString()
  };
}
