/**
 * ============================================================
 * GmailDrafter.gs — AutoMail Pipeline: Gmail Draft Creation
 * Handles draft creation with HTML formatting, resume attachment,
 * follow-up drafts, and deliverability protection with daily limits.
 * ============================================================
 */

// ─── RESUME DRIVE ID MAPPING ──────────────────────────────────
var RESUME_DRIVE_KEYS = {
  GROWTH_MARKETING: 'RESUME_DRIVE_ID_GROWTH',
  OPS_CONSULTING: 'RESUME_DRIVE_ID_OPS',
  PRODUCT_AI_STRATEGY: 'RESUME_DRIVE_ID_PRODUCT'
};

var RESUME_FILE_NAMES = {
  GROWTH_MARKETING: 'Resume_Gaurav_Growth_Marketing.pdf',
  OPS_CONSULTING: 'Resume_Gaurav_Ops_Consulting.pdf',
  PRODUCT_AI_STRATEGY: 'Resume_Gaurav_Product_AI_Strategy.pdf'
};

// ─── MAIN DRAFT CREATION FUNCTION ──────────────────────────

/**
 * Creates a Gmail draft with HTML formatting and resume attachment.
 * @param {Object} lead - Lead object with email, fullName, etc.
 * @param {string} subjectLine - Email subject line
 * @param {string} emailBody - Email body content (HTML formatted)
 * @param {Object} metadata - { variantId: 'GROWTH_MARKETING' | 'OPS_CONSULTING' | 'PRODUCT_AI_STRATEGY' }
 * @returns {Object} { success: boolean, draftId: string, threadId: string, error: string }
 */
function createDraft(lead, subjectLine, emailBody, metadata) {
  // ── PATCH `-p5-latency-instrument` (Phase 2a): per-stage timers ──
  // Zero behavior change. Each major stage emits [LATENCY row=N stage=NAME ms=X]
  // log line. User greps the post-scan execution log to identify the dominant
  // sink. The 1:35 PM run showed a 193s silent gap between "Banner image loaded"
  // and "Tracking injection failed" — these timers will name where the time went.
  var __t0 = Date.now();
  var __tPrev = __t0;
  function __lat(stage) {
    var dt = Date.now() - __tPrev;
    Logger.log('[LATENCY row=' + ((lead && lead.rowNum) || '?') + ' stage=draft_' + stage + ' ms=' + dt + ']');
    __tPrev = Date.now();
    return dt;
  }

  // Validate inputs
  if (!lead || !lead.email || !subjectLine || !emailBody) {
    return {
      success: false,
      draftId: '',
      threadId: '',
      error: 'Missing required draft fields: lead, email, subject, or body'
    };
  }
  __lat('validate_inputs');

  // Check daily draft limit to protect deliverability
  var dailyCheck = _checkDailyDraftLimit();
  if (dailyCheck.exceeded) {
    logPipelineEvent(lead.rowNum, 'DRAFT', dailyCheck.message, 'WARN');
    return { success: false, draftId: '', threadId: '', error: dailyCheck.message };
  }

  // Sanitize email address
  var cleanEmail = lead.email.trim().toLowerCase();

  // Validate email format (basic)
  if (!cleanEmail.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
    var errorMsg = 'Invalid email format: ' + cleanEmail;
    logPipelineEvent(lead.rowNum, 'DRAFT', errorMsg, 'ERROR');
    return { success: false, draftId: '', threadId: '', error: errorMsg };
  }

  // ── PATCH 2026-05-12: Pre-send deliverability gate ──
  // Composite signal score from Reoon + Hunter Verifier + Apollo email_status +
  // DMARC/SPF/RDAP + bounce history. Catches the ~5-10% auto-pick false
  // positives that would hard-bounce. Fails open on internal errors.
  if (typeof preSendVerify === 'function') {
    // PATCH 2026-05-18: parse the previous retry-count from NOTES so PSV
    // can bound the REOON_RETRY_PENDING loop. NOTES carries `retryCount:N`
    // after each PSV failure. PSV reads it via lead._psvRetryCount, applies
    // exponential backoff, and after PSV_MAX_REOON_RETRIES (=3) refuses to
    // schedule another retry (signals manual escalation).
    var previousRetryCount = 0;
    try {
      var existingNotesForRetry = '';
      try {
        var preSs = SpreadsheetApp.openById(CONFIG.SHEET_ID);
        var preSheet = preSs.getSheetByName(CONFIG.DATA_SHEET);
        if (preSheet && lead.rowNum) {
          existingNotesForRetry = (preSheet.getRange(lead.rowNum, CONFIG.COLUMNS.NOTES).getValue() || '').toString();
        }
      } catch (_) {}
      var rcMatch = existingNotesForRetry.match(/retryCount:(\d+)/);
      if (rcMatch) previousRetryCount = parseInt(rcMatch[1], 10) || 0;
    } catch (_) {}
    lead._psvRetryCount = previousRetryCount;

    var psv;
    try { psv = preSendVerify(cleanEmail, lead); }
    catch (psvErr) {
      Logger.log('[GmailDrafter] PSV threw — failing open: ' + psvErr.message);
      psv = { ok: true, confidence: 50, reasons: ['PSV_ERROR_SKIPPED'], blockers: [], retryAfterMs: null,
              attemptCount: previousRetryCount };
    }
    Logger.log('[GmailDrafter] PSV ' + cleanEmail + ': ok=' + psv.ok +
               ' conf=' + psv.confidence + ' attempt=' + (previousRetryCount + 1) +
               ' blockers=' + (psv.blockers || []).join(','));

    // PATCH 2026-05-20 (no-termination mode): PSV is now ADVISORY ONLY.
    // Previously: !psv.ok parked the row at NEEDS_PRE_SEND_REVIEW or
    // REOON_RETRY_PENDING and returned failure — no draft created. This
    // killed Matt Kaufman / Ayushi Gupta / Navneet Sharma class even after
    // the unified selector verified their emails (Matt: tier=verified
    // conf=0.91, PSV blocked at composite 49 because Reoon=catch_all
    // counted as suspect).
    //
    // New behaviour: run PSV (still useful for the audit trail + risk
    // flags), annotate the lead's notes + riskFlags, but ALWAYS proceed
    // to create the draft. The body-header risk panel surfaces the PSV
    // verdict to the user when they open the draft in Gmail. They are
    // the final gate.
    //
    // The PSV verdict still informs:
    //   - riskFlags propagated to draft header colour (yellow / red)
    //   - NOTES annotation with full PSV reasons (audit trail)
    //   - retryCount counter (so we don't recurse infinitely)
    if (!psv.ok) {
      try {
        var psvSs = SpreadsheetApp.openById(CONFIG.SHEET_ID);
        var psvSheet = psvSs.getSheetByName(CONFIG.DATA_SHEET);
        if (psvSheet && lead.rowNum) {
          var existingNotes = (psvSheet.getRange(lead.rowNum, CONFIG.COLUMNS.NOTES).getValue() || '').toString();
          var cleanedNotes = existingNotes.replace(/\s*\|?\s*\[PSV_FAIL[^\]]*\][^|]*/g, '').replace(/\s*\|?\s*\[PSV_ADVISORY[^\]]*\][^|]*/g, '').replace(/\s*\|?\s*retryCount:\d+/g, '').trim();
          var nextRetryCount = previousRetryCount + 1;
          var psvNote = '[PSV_ADVISORY conf=' + psv.confidence +
                        ' blockers=' + (psv.blockers || []).join(';') +
                        ' reasons=' + (psv.reasons || []).slice(0, 6).join('|') + ']' +
                        ' (no-termination mode: draft proceeded regardless)' +
                        ' retryCount:' + nextRetryCount;
          psvSheet.getRange(lead.rowNum, CONFIG.COLUMNS.NOTES).setValue(
            (cleanedNotes ? cleanedNotes + ' | ' : '') + psvNote);
        }
      } catch (sheetErr) {
        Logger.log('[GmailDrafter] PSV note write failed (non-blocking): ' + sheetErr.message);
      }

      // Propagate PSV verdict to the lead's riskFlags so the body-header
      // injector escalates the warning panel colour (low_confidence → red).
      lead.riskFlags = lead.riskFlags || [];
      var psvFlagAdded = false;
      if ((psv.blockers || []).length > 0) {
        if (lead.riskFlags.indexOf('psv_blocker_' + psv.blockers[0]) < 0) {
          lead.riskFlags.push('psv_blocker_' + psv.blockers[0]);
          psvFlagAdded = true;
        }
      } else if (psv.confidence < 50) {
        if (lead.riskFlags.indexOf('psv_low_confidence_' + psv.confidence) < 0) {
          lead.riskFlags.push('psv_low_confidence_' + psv.confidence);
          psvFlagAdded = true;
        }
      }
      // If the lead was Tier 0 verified but PSV disputed, downgrade tier
      // so the body-header panel actually renders. (Verified tier suppresses
      // the panel entirely; this PSV signal is too important to hide.)
      if (psvFlagAdded && lead.selectionTier === 'verified') {
        lead.selectionTier = 'low_confidence';
      }

      logPipelineEvent(lead.rowNum, 'DRAFT',
        'PSV advisory: conf=' + psv.confidence +
        ' blockers=' + (psv.blockers || []).join('; ') +
        ' — DRAFT PROCEEDING (no-termination mode); user is final gate', 'WARN');
      // Intentionally do NOT return failure here. Fall through to draft creation.
    }
  }
  __lat('psv');

  try {
    // ── Resolve resume attachment ──
    // 2026-05-11 AUDIT FIX (#5): track attachment success so a "draft with no
    // resume" can be distinguished from "draft with resume" downstream.
    var attachments = [];
    var attachmentFlags = { resume: 'MISSING', lor: 'MISSING' };
    var variantId = (metadata && metadata.variantId) ? metadata.variantId : 'GROWTH_MARKETING';
    var driveKey = RESUME_DRIVE_KEYS[variantId] || RESUME_DRIVE_KEYS.GROWTH_MARKETING;
    var resumeFileName = RESUME_FILE_NAMES[variantId] || RESUME_FILE_NAMES.GROWTH_MARKETING;

    var props = PropertiesService.getScriptProperties();
    var driveFileId = props.getProperty(driveKey);

    if (driveFileId) {
      try {
        var file = DriveApp.getFileById(driveFileId);
        var blob = file.getBlob().setName(resumeFileName);
        attachments.push(blob);
        attachmentFlags.resume = 'ATTACHED';
        Logger.log('[GmailDrafter] Resume attached: ' + resumeFileName + ' (Drive ID: ' + driveFileId + ')');
      } catch (driveErr) {
        attachmentFlags.resume = 'DRIVE_ERROR';
        Logger.log('[GmailDrafter] WARNING: Could not attach resume — ' + driveErr.toString());
        logPipelineEvent(lead.rowNum, 'DRAFT', 'Resume attachment failed: ' + driveErr.message + '. Draft created without attachment.', 'WARN');
      }
    } else {
      attachmentFlags.resume = 'NO_DRIVE_ID';
      Logger.log('[GmailDrafter] No Drive ID found for key: ' + driveKey + '. Set it in Script Properties.');
      logPipelineEvent(lead.rowNum, 'DRAFT', 'No resume Drive ID for ' + driveKey + '. Set in Script Properties > Project Settings.', 'WARN');
    }
    __lat('attach_resume');

    // ── Attach Letter of Recommendation (Thoughtworks, Soumyajit Dey) ──
    // Mandatory on every email per user policy (scope=a). Drive ID stored in
    // Script Properties under CONFIG.PROPERTY_KEYS.LOR_DRIVE_ID. Inline mention
    // of "(LOR attached)" in the email body is handled separately by the
    // bullet-list HTML builder using metadata.archetype.
    var lorKeyName = (CONFIG && CONFIG.PROPERTY_KEYS && CONFIG.PROPERTY_KEYS.LOR_DRIVE_ID) || 'LOR_DRIVE_ID';
    var lorDriveId = props.getProperty(lorKeyName);
    if (lorDriveId) {
      try {
        var lorFile = DriveApp.getFileById(lorDriveId);
        var lorBlob = lorFile.getBlob().setName('LOR_Gaurav_Thoughtworks.pdf');
        attachments.push(lorBlob);
        attachmentFlags.lor = 'ATTACHED';
        Logger.log('[GmailDrafter] LOR attached: LOR_Gaurav_Thoughtworks.pdf (Drive ID: ' + lorDriveId + ')');
      } catch (lorErr) {
        attachmentFlags.lor = 'DRIVE_ERROR';
        Logger.log('[GmailDrafter] WARNING: Could not attach LOR — ' + lorErr.toString());
        logPipelineEvent(lead.rowNum, 'DRAFT', 'LOR attachment failed: ' + lorErr.message + '. Draft created without LOR.', 'WARN');
      }
    } else {
      attachmentFlags.lor = 'NO_DRIVE_ID';
      Logger.log('[GmailDrafter] No LOR_DRIVE_ID in Script Properties. Skipping LOR attachment.');
    }
    __lat('attach_lor');

    // Stamp attachment status into a note suffix so it's visible in Sheet2.
    // Visible string: "ATTACH=resume:ATTACHED,lor:ATTACHED" or "ATTACH=resume:NO_DRIVE_ID,lor:ATTACHED"
    metadata = metadata || {};
    metadata.attachmentFlags = attachmentFlags;

    // ── Resolve banner inline image ──
    // PATCH 2026-06-11-eq8-deliv-v2 (T2): when FORMAT_DELIV_V2 is ON, the
    // HTML body already contains a CSS table header (via _delivBannerHtml) —
    // no CID blob is needed. Skipping the Drive fetch saves one Drive API op
    // per draft and ensures no orphan cid:emailBanner reference exists in the
    // HTML (the CSS path never emits one). FLAG OFF → legacy path unchanged.
    var inlineImages = {};
    var _delivV2BannerOn = (typeof _enrichmentFlag === 'function') && _enrichmentFlag('FORMAT_DELIV_V2');
    if (!_delivV2BannerOn) {
      var bannerDriveId = props.getProperty('BANNER_DRIVE_ID');
      if (bannerDriveId) {
        try {
          var bannerFile = DriveApp.getFileById(bannerDriveId);
          var bannerBlob = bannerFile.getBlob();
          // Gmail inline images require the blob name to match the CID key
          bannerBlob.setName('emailBanner');
          inlineImages.emailBanner = bannerBlob;
          Logger.log('[GmailDrafter] Banner image loaded (Drive ID: ' + bannerDriveId + ')');
        } catch (bannerErr) {
          Logger.log('[GmailDrafter] WARNING: Could not load banner — ' + bannerErr.toString());
          logPipelineEvent(lead.rowNum, 'DRAFT', 'Banner load failed: ' + bannerErr.message + '. Draft created without banner.', 'WARN');
        }
      } else {
        Logger.log('[GmailDrafter] No BANNER_DRIVE_ID in Script Properties. Banner will show alt text only.');
      }
    } else {
      Logger.log('[GmailDrafter] FORMAT_DELIV_V2=ON: CSS header active; banner blob attach SKIPPED (no Drive op, no orphan CID).');
    }
    __lat('attach_banner');

    // ── Patch 2026-05-11: inject email tracking (open pixel + link wrap) ──
    // - Generates a UUID tracking_id
    // - Rewrites all <a href> to go through /exec?action=track_click
    // - Appends a 1x1 invisible pixel that fires /exec?action=track_open
    // - Persists (tracking_id, link_id, original_url, lead_row, linkedin_url)
    //   to TrackingLinks sheet so the redirect handler + summary endpoint work
    var trackingId = '';
    var trackedBody = emailBody;
    try {
      if (typeof newTrackingId === 'function') {
        trackingId = newTrackingId(lead.rowNum || 0, '', '', lead.linkedinUrl || '');
        trackedBody = rewriteLinksForTracking(emailBody, trackingId, lead.rowNum || 0, lead.linkedinUrl || '');
        var pixelTag = buildPixelTag(trackingId);
        if (pixelTag) {
          // Append pixel right before </body> if present, else end of string
          if (/<\/body>/i.test(trackedBody)) {
            trackedBody = trackedBody.replace(/<\/body>/i, pixelTag + '</body>');
          } else {
            trackedBody = trackedBody + pixelTag;
          }
        }
        Logger.log('[GmailDrafter] Tracking enabled: ' + trackingId.substring(0, 8) + '… for row ' + (lead.rowNum || 'n/a'));
      }
    } catch (trackErr) {
      Logger.log('[GmailDrafter] Tracking injection failed (continuing without): ' + trackErr.message);
      trackedBody = emailBody;
      trackingId = '';
    }
    __lat('tracking_injection');

    // ── Build draft options ──
    var draftOptions = {
      htmlBody: trackedBody,
      name: 'Gaurav Rathore'
    };

    if (attachments.length > 0) {
      draftOptions.attachments = attachments;
    }

    // Add inline images (banner) if available
    var hasInlineImages = false;
    for (var k in inlineImages) {
      if (inlineImages.hasOwnProperty(k)) { hasInlineImages = true; break; }
    }
    if (hasInlineImages) {
      draftOptions.inlineImages = inlineImages;
    }

    // PATCH 2026-06-11-eq8-deliv-v2 (T3): mirrored plain-text MIME part.
    // Avoids MPART_ALT_DIFF (SpamAssassin 2.2-2.8 pts) — mismatched alt parts
    // score WORSE than no plain part. When FLAG ON, generate the plain part
    // from the final HTML body via _htmlToMirrorText. FLAG OFF stays ''.
    // Click-tracking pixel excluded from plain text (image reference only).
    var _plainTextBody = '';
    if ((typeof _enrichmentFlag === 'function') && _enrichmentFlag('FORMAT_DELIV_V2') &&
        typeof _htmlToMirrorText === 'function') {
      try {
        _plainTextBody = _htmlToMirrorText(trackedBody);
      } catch (_ptErr) {
        Logger.log('[GmailDrafter] _htmlToMirrorText failed (using empty plain part): ' + _ptErr.message);
        _plainTextBody = '';
      }
    }
    // Create draft: GmailApp.createDraft(to, subject, plainTextFallback, options)
    // The plain-text part (3rd arg) is now mirrored from HTML when V2 is ON.
    var draft = GmailApp.createDraft(cleanEmail, subjectLine, _plainTextBody, draftOptions);
    __lat('createDraft_api');

    // Small delay between drafts to avoid rate limiting
    var delay = CONFIG.MIN_DELAY_BETWEEN_DRAFTS_MS || 3000;
    if (delay > 0) {
      Utilities.sleep(delay);
    }
    __lat('rate_limit_sleep');

    // Increment daily counter
    _incrementDailyDraftCount();

    // Extract string ID from GmailDraft object
    var draftId = draft.getId();

    // ── FIX #1: Capture thread + RFC-2822 Message-ID so follow-ups thread ──
    // Canonical Apps Script pattern: draft.getMessage() gives the live GmailMessage,
    // which exposes both the thread handle and raw header values. Follow-ups
    // reference threadId for GmailApp.getThreadById() + thread.createDraftReply(),
    // and the Message-ID header is the RFC-compliant fallback for any recipient
    // client that doesn't re-thread on Gmail's internal thread ID alone.
    var threadId = '';
    var rfc822MessageId = '';
    try {
      var msg = draft.getMessage();
      threadId = msg.getThread().getId();
      rfc822MessageId = msg.getHeader('Message-ID') || msg.getHeader('Message-Id') || '';
    } catch (idErr) {
      Logger.log('[GmailDrafter] Warning: could not extract thread/message ID — ' + idErr.message);
    }

    // Patch 2026-05-11: stamp thread_id onto every TrackingLinks row for this
    // tracking_id. Lets /exec?action=tracking_summary return a Gmail deep-link
    // (mail.google.com/mail/u/0/#inbox/<threadId>) for the in-app tracking screen.
    // [2026-06-12-fcm-name-fix] Pass lead.rowNum + lead.linkedinUrl so
    // _trackingStampThreadId can populate col D/E on meta-only rows (emails whose
    // links were all CTA-exempt or had no hrefs). Without this, the FCM name
    // resolver receives leadRow='' and falls back to 'a lead'.
    // [activates at next deploy post-version-prune]
    if (trackingId && threadId && typeof _trackingStampThreadId === 'function') {
      try { _trackingStampThreadId(trackingId, threadId, draftId,
                                   lead.rowNum || 0, lead.linkedinUrl || ''); }
      catch (stampErr) { Logger.log('[GmailDrafter] thread_id stamp failed: ' + stampErr.message); }
    }

    __lat('post_create_meta');

    // Log success
    var logMsg = 'Draft created' +
                 (attachments.length > 0 ? ' + resume (' + resumeFileName + ')' : '') +
                 (hasInlineImages ? ' + banner' : '') +
                 (threadId ? ' [thread=' + threadId.substring(0, 10) + '…]' : '') +
                 ' — Daily: ' + getDailyDraftStatus().count + '/' + getDailyDraftStatus().limit;
    logPipelineEvent(lead.rowNum, 'DRAFT', logMsg, 'SUCCESS');

    // ── Total latency summary for this createDraft invocation ──
    Logger.log('[LATENCY row=' + ((lead && lead.rowNum) || '?') +
               ' stage=draft_TOTAL ms=' + (Date.now() - __t0) + ']');

    return {
      success: true,
      draftId: draftId,
      threadId: threadId,
      rfc822MessageId: rfc822MessageId,
      error: ''
    };

  } catch (error) {
    var errorMsg = 'Failed to create draft: ' + error.toString();
    logPipelineEvent(lead.rowNum, 'DRAFT', errorMsg, 'ERROR');

    // ── PATCH `-p5-composer-preflight-amend` (Phase 2b amend-1): trip the
    // Gmail-quota circuit breaker if Gmail itself signalled exhaustion.
    //
    // Why this matters: our application-level counter (DAILY_DRAFTS_<date>)
    // is incremented AFTER a successful createDraft. When every createDraft
    // attempt fails, the counter stays at 0 and the L1 guard in
    // _processOneLead lets the next lead through — burning ~5K Claude tokens
    // before failing again. By detecting the Gmail-side quota error here
    // (the exception message contains 'too many times for one day') and
    // setting a separate property flag, _checkDailyDraftLimit can read the
    // flag and trip L1 even when the success counter is 0.
    //
    // The flag is date-keyed in PT (via _ptDateKey() below) so it auto-clears at
    // midnight US-Pacific — the same reset point as Gmail's hard quota (quota-tz-align).
    //
    // PATCH 2026-06-13-quota-transient: distinguish transient burst vs true daily
    // exhaustion. If today's total Gmail ops (QuotaMeter) < GMAIL_TRANSIENT_OPS_THRESHOLD
    // AND draft count < ~150, the error is a short-window rate burst. Flag is typed
    // 'transient' so probe-through fires in 3 min (GMAIL_TRANSIENT_CLEAR_MS) instead
    // of 60 min. Format: '1|<ts>|<type:transient|daily>|<errstr>'.
    // Old format '1|<ts>|<errstr>' parses as daily (backward-compatible).
    try {
      var errStr = String(error && error.message ? error.message : error);
      if (/too many times for one day/i.test(errStr) ||
          /service invoked too many times/i.test(errStr) ||
          /quota.*exceed/i.test(errStr)) {
        var qProps = PropertiesService.getScriptProperties();
        // PATCH 2026-06-13-quota-tz-align: use _ptDateKey() so this flag is keyed
        // on the same PT date as the counter and the limit-read — all three agree.
        var qToday = _ptDateKey();
        var qKey = 'GMAIL_QUOTA_EXHAUSTED_' + qToday;
        // Determine transient vs daily: read QuotaMeter total + daily draft count.
        var _qOpsTotal = 0;
        var _qDraftCount = 0;
        try {
          var _qAllProps = qProps.getProperties();
          var _qTotKey = 'GMAIL_OPS_' + qToday;
          _qOpsTotal = parseInt(_qAllProps[_qTotKey] || '0', 10) || 0;
          var _qDailyKey = 'DAILY_DRAFTS_' + qToday;
          _qDraftCount = parseInt(_qAllProps[_qDailyKey] || '0', 10) || 0;
        } catch (_qReadErr) { /* non-fatal — default to daily (safe side) */ }
        var _transientThreshold = (CONFIG && CONFIG.GMAIL_TRANSIENT_OPS_THRESHOLD) || 15000;
        var _flagType = (_qOpsTotal < _transientThreshold && _qDraftCount < 150) ? 'transient' : 'daily';
        qProps.setProperty(qKey, '1|' + Date.now() + '|' + _flagType + '|' + errStr.substring(0, 180));
        Logger.log('[GmailDrafter/quota-transient] GMAIL_QUOTA_EXHAUSTED flag SET type=' + _flagType +
                   ' ops=' + _qOpsTotal + ' drafts=' + _qDraftCount +
                   ' threshold=' + _transientThreshold + ' for PT-day ' + qToday +
                   ' — L1 guard will short-circuit subsequent leads this cron.');
      }
    } catch (_qFlagErr) {
      Logger.log('[GmailDrafter/Phase2b-amend1] failed to set quota flag (non-blocking): ' + _qFlagErr.message);
    }

    return {
      success: false,
      draftId: '',
      threadId: '',
      rfc822MessageId: '',
      error: errorMsg
    };
  }
}

// ─── FOLLOW-UP DRAFT CREATION ──────────────────────────────

/**
 * FIX 2026-06-13-followup-thread: HTML formatter for plain-text follow-up bodies.
 * Converts a plain-text block (from LLM or fallback) into deliverable HTML paragraphs:
 *   - HTML-escapes <, >, &, "
 *   - Blank lines (one or more) → paragraph boundaries (<p style="margin:0 0 12px">)
 *   - Single newlines within a paragraph → <br>
 *
 * Pure helper — no Gmail calls, no side effects. Testable in isolation.
 *
 * @param {string} text - Plain text follow-up body
 * @returns {string} HTML string
 */
function _fuPlainToHtml(text) {
  if (!text) return '';
  // HTML-escape
  var escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  // Split on blank-line boundaries (one or more blank lines)
  var paragraphs = escaped.split(/\n{2,}/);
  return paragraphs.map(function(para) {
    // Within each paragraph, single newlines → <br>
    var inner = para.replace(/\n/g, '<br>');
    return '<p style="margin:0 0 12px">' + inner + '</p>';
  }).join('');
}

/**
 * FIX 2026-06-13-followup-thread: Thread-resolution ladder for follow-up creation.
 * Returns { thread, via } where via is one of:
 *   'getById'  — resolved via GmailApp.getThreadById(threadId) [O(1), preferred]
 *   'rfc822'   — resolved via GmailApp.search('rfc822msgid:...') [fallback if id present]
 *   'email'    — resolved via GmailApp.search('to:email in:sent') [last resort]
 *   null       — no thread found (caller must defer, not create standalone)
 *
 * Pure helper in terms of logic — Gmail calls are inside but structure lets
 * source-anchor tests verify the ladder exists and standalone createDraft is absent.
 *
 * @param {string} threadId   - Gmail thread ID (may be empty/null)
 * @param {string} email      - Recipient email address (clean, lower-case)
 * @param {string} rfcMsgId   - RFC 2822 Message-ID header (may be empty/null)
 * @returns {{ thread: GmailThread|null, via: string|null }}
 */
function _fuResolveThread(threadId, email, rfcMsgId) {
  // (a) Direct getById — O(1), no search quota
  if (threadId) {
    try {
      var t = GmailApp.getThreadById(threadId);
      if (t) return { thread: t, via: 'getById' };
      Logger.log('[FollowUp] getThreadById(' + threadId + ') returned null, trying fallbacks');
    } catch (e) {
      Logger.log('[FollowUp] getThreadById(' + threadId + ') threw: ' + e.message);
    }
  }

  // (b) RFC 2822 Message-ID search
  if (rfcMsgId) {
    try {
      var rfcClean = rfcMsgId.toString().trim().replace(/^<|>$/g, '');
      if (rfcClean) {
        var rfcThreads = GmailApp.search('rfc822msgid:' + rfcClean);
        if (rfcThreads && rfcThreads.length > 0) {
          return { thread: rfcThreads[0], via: 'rfc822' };
        }
      }
    } catch (rfcErr) {
      Logger.log('[FollowUp] rfc822msgid search failed: ' + rfcErr.message);
    }
  }

  // (c) Sent-folder email search — most-recent matching thread
  if (email) {
    try {
      var sentThreads = GmailApp.search('to:' + email + ' in:sent newer_than:30d');
      if (sentThreads && sentThreads.length > 0) {
        return { thread: sentThreads[0], via: 'email' };
      }
    } catch (sentErr) {
      Logger.log('[FollowUp] sent-folder search for ' + email + ' failed: ' + sentErr.message);
    }
  }

  return { thread: null, via: null };
}

/**
 * Creates a threaded follow-up reply.
 *
 * FIX 2026-06-13-followup-thread:
 *   - Path B (standalone GmailApp.createDraft with "Re:") has been REMOVED.
 *   - A thread-resolution ladder (_fuResolveThread) replaces the simple getById call.
 *   - If no thread resolves, returns { success:false, deferred:true, reason:'no_thread_for_followup' }
 *     and creates NOTHING.
 *   - When thread is found via rfc822 or email search, BACKFILLS col V THREAD_ID on
 *     the parent row (opportunistic, try/catch — same pattern as fcm-name backfill).
 *   - Body is converted from plain text to proper HTML via _fuPlainToHtml before
 *     tracking injection. thread.createDraftReply never receives options.subject
 *     (it inherits from the thread natively).
 *
 * @param {Object} lead         - Lead object (uses lead.email, lead.rowNum, lead.threadId,
 *                                lead.rfc822MessageId, lead.linkedinUrl)
 * @param {string|number} stage - Follow-up stage number (1, 2, or 3)
 * @param {string} subjectLine  - Vestigial param (ignored — thread inherits subject)
 * @param {string} emailBody    - Follow-up body in PLAIN TEXT (converted to HTML here)
 * @param {string} [threadId]   - Gmail thread ID (also read from lead.threadId)
 * @returns {Object} { success, draftId, threadId, error } or { success:false, deferred:true, reason }
 */
function createFollowUpDraft(lead, stage, subjectLine, emailBody, threadId) {
  if (!lead || !lead.email || !emailBody) {
    return { success: false, draftId: '', threadId: '', error: 'Missing required follow-up fields (email or body)' };
  }

  var dailyCheck = _checkDailyDraftLimit();
  if (dailyCheck.exceeded) {
    return { success: false, draftId: '', threadId: threadId || '', error: dailyCheck.message };
  }

  var cleanEmail = lead.email.toString().trim().toLowerCase();
  var resolveThreadId = threadId || lead.threadId || '';
  var rfcMsgId = lead.rfc822MessageId || '';

  // FIX 2 (2026-06-13-followup-thread): Convert plain-text body to HTML paragraphs
  // BEFORE tracking injection. _fuPlainToHtml handles blank-line→<p>, newline→<br>,
  // and HTML-escaping. Tracking then rewrites links within the already-HTML body.
  var htmlBody = _fuPlainToHtml(emailBody);

  // PATCH 2026-05-12: tracking injection for follow-ups (parity with initial draft).
  // Each follow-up gets its OWN tracking_id so we can distinguish stage-1/2/3 opens
  // in the dashboard. Append stage suffix to tracking_id for traceability.
  var trackingId = '';
  var trackedHtml = htmlBody;
  try {
    if (typeof newTrackingId === 'function') {
      trackingId = newTrackingId(lead.rowNum || 0, '', resolveThreadId || '', lead.linkedinUrl || '');
      trackedHtml = rewriteLinksForTracking(htmlBody, trackingId, lead.rowNum || 0, lead.linkedinUrl || '');
      var pixelTag = buildPixelTag(trackingId);
      if (pixelTag) {
        if (/<\/body>/i.test(trackedHtml)) {
          trackedHtml = trackedHtml.replace(/<\/body>/i, pixelTag + '</body>');
        } else {
          trackedHtml = trackedHtml + pixelTag;
        }
      }
      Logger.log('[GmailDrafter] Follow-up tracking enabled: ' + trackingId.substring(0, 8) +
                 '... stage=' + stage + ' row=' + (lead.rowNum || 'n/a'));
    }
  } catch (trackErr) {
    Logger.log('[GmailDrafter] Follow-up tracking injection failed (continuing without): ' + trackErr.message);
    trackedHtml = htmlBody;
    trackingId = '';
  }

  // Plain-text mirror part (for MPART_ALT_DIFF deliverability — FORMAT_DELIV_V2 parity)
  var _fuPlainText = '';
  if ((typeof _enrichmentFlag === 'function') && _enrichmentFlag('FORMAT_DELIV_V2') &&
      typeof _htmlToMirrorText === 'function') {
    try {
      _fuPlainText = _htmlToMirrorText(trackedHtml);
    } catch (_fuPtErr) {
      Logger.log('[GmailDrafter] Follow-up _htmlToMirrorText failed (using empty plain part): ' + _fuPtErr.message);
      _fuPlainText = '';
    }
  }

  try {
    // ── FIX 1 (2026-06-13-followup-thread): Thread-resolution ladder ──
    // Path B (standalone "Re:" draft) has been REMOVED.
    // If no thread resolves, defer rather than create a standalone draft.
    var resolved = _fuResolveThread(resolveThreadId, cleanEmail, rfcMsgId);
    var thread = resolved.thread;
    var threadVia = resolved.via;

    if (!thread) {
      Logger.log('[FollowUp] deferred row ' + (lead.rowNum || 'n/a') + ' — no resolvable thread');
      return { success: false, deferred: true, reason: 'no_thread_for_followup' };
    }

    // Opportunistic backfill: if we resolved via rfc822 or email search AND the
    // parent row is known, write THREAD_ID (col V) so next run is O(1).
    // Mirror of the fcm-name backfill pattern — opportunistic, try/catch.
    if (threadVia !== 'getById' && lead.rowNum && lead.rowNum > 1) {
      try {
        var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
        var dataSheet = ss.getSheetByName(CONFIG.DATA_SHEET);
        if (dataSheet) {
          var backfillThreadId = thread.getId();
          dataSheet.getRange(lead.rowNum, CONFIG.COLUMNS.THREAD_ID).setValue(backfillThreadId);
          Logger.log('[GmailDrafter] Backfilled THREAD_ID col V row ' + lead.rowNum +
                     ' via=' + threadVia + ' id=' + backfillThreadId.substring(0, 12) + '...');
        }
      } catch (bfErr) {
        Logger.log('[GmailDrafter] THREAD_ID backfill failed (non-critical): ' + bfErr.message);
      }
    }

    // ── Threaded reply — the ONLY draft-creation call ──
    // createDraftReply inherits recipient + subject + In-Reply-To/References headers.
    // Do NOT pass options.subject — thread inherits it natively.
    var draft = thread.createDraftReply(_fuPlainText, {
      htmlBody: trackedHtml,
      name: 'Gaurav Rathore'
    });

    // Rate limit
    var delay = CONFIG.MIN_DELAY_BETWEEN_DRAFTS_MS || 3000;
    if (delay > 0) Utilities.sleep(delay);

    _incrementDailyDraftCount();

    var draftId = draft.getId();
    var actualThreadId = '';
    try {
      actualThreadId = draft.getMessage().getThread().getId();
    } catch (_) { /* non-critical */ }

    // Stamp thread_id onto the follow-up's tracking row so /exec?action=tracking_summary
    // returns the Gmail deep-link for this specific follow-up.
    // [2026-06-12-fcm-name-fix] Pass lead.rowNum + lead.linkedinUrl (follow-up parity).
    if (trackingId && actualThreadId && typeof _trackingStampThreadId === 'function') {
      try { _trackingStampThreadId(trackingId, actualThreadId, draftId,
                                   lead.rowNum || 0, lead.linkedinUrl || ''); }
      catch (stampErr) { Logger.log('[GmailDrafter] FU thread_id stamp failed: ' + stampErr.message); }
    }

    logPipelineEvent(lead.rowNum, 'FOLLOWUP_' + stage,
                     'Follow-up draft created [threaded_reply via=' + threadVia + ']' +
                     (trackingId ? ' tracking=' + trackingId.substring(0, 8) : ''), 'SUCCESS');

    return { success: true, draftId: draftId, threadId: actualThreadId, error: '' };

  } catch (error) {
    var errorMsg = 'Failed to create follow-up draft: ' + error.toString();
    logPipelineEvent(lead.rowNum, 'FOLLOWUP_' + stage, errorMsg, 'ERROR');
    return { success: false, draftId: '', threadId: resolveThreadId || '', error: errorMsg };
  }
}

// ─── DAILY DRAFT LIMIT PROTECTION ─────────────────────────

/**
 * Returns today's date in America/Los_Angeles (PT) as 'yyyy-MM-dd'.
 * PATCH 2026-06-13-quota-tz-align: shared builder so _checkDailyDraftLimit,
 * _incrementDailyDraftCount, getDailyDraftStatus, and the GMAIL_QUOTA_EXHAUSTED
 * flag all use the SAME PT-keyed date — matching QuotaMeter._gmPtDate() exactly.
 * This aligns the soft 200-cap reset with Gmail's hard quota PT-midnight reset.
 * Previously all three functions used Session.getScriptTimeZone() (IST), which
 * caused the counter to roll ~12h BEFORE Gmail's quota replenished, showing
 * "0/200 fresh capacity" while Gmail was still throttled (the recurring
 * 'fresh day but stuck' user confusion).
 * @param {Date=} d  Optional date; defaults to now.
 * @returns {string}
 */
function _ptDateKey(d) {
  return Utilities.formatDate(d || new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
}

/**
 * PATCH 2026-06-13-quota-transient: pure helper — returns the ms to wait before
 * auto-clearing the GMAIL_QUOTA_EXHAUSTED flag, based on the flag's recorded type.
 *
 * Flag format (new): '1|<ts>|<type:transient|daily>|<errstr>'
 * Flag format (legacy): '1|<ts>|<errstr>'   (parts[2] is not 'transient'/'daily')
 *
 * Rules:
 *   - type === 'transient' → GMAIL_TRANSIENT_CLEAR_MS (default 180000 = 3 min)
 *   - type === 'daily' OR legacy/unparseable → 3600000 (60 min, original probe-through)
 *
 * @param {string} flagValue  The raw ScriptProperties value of GMAIL_QUOTA_EXHAUSTED_*
 * @param {number=} nowMs     Current epoch ms (defaults to Date.now()); unused in the
 *                            threshold computation but included for testability.
 * @returns {number}  Clear interval in ms.
 */
function _gmailFlagClearMs(flagValue, nowMs) {
  try {
    var parts = (flagValue || '').split('|');
    // parts[0] = '1', parts[1] = <ts>, parts[2] = type or start-of-errstr
    var typeField = (parts.length >= 4) ? parts[2] : '';
    if (typeField === 'transient') {
      return (CONFIG && CONFIG.GMAIL_TRANSIENT_CLEAR_MS) || 180000;
    }
  } catch (_) { /* fall through to safe daily default */ }
  return 3600000; // 60 min — daily or legacy
}

/**
 * Checks if daily draft creation limit has been reached.
 * @returns {Object} { exceeded: boolean, count: number, limit: number, message: string }
 */
function _checkDailyDraftLimit() {
  var props = PropertiesService.getScriptProperties();
  // PATCH 2026-06-13-quota-tz-align: switched from Session.getScriptTimeZone() (IST)
  // to America/Los_Angeles (PT) via shared _ptDateKey() helper — mirrors QuotaMeter
  // exactly so the soft 200-cap resets in lockstep with Gmail's hard PT-midnight quota.
  // Previously used IST (PATCH 2026-05-13 AUDIT I6/R27): that fixed UTC→IST skew but
  // left a ~12h window where the counter showed fresh capacity while Gmail was still
  // throttled from the prior PT day.
  var today = _ptDateKey();
  var key = 'DAILY_DRAFTS_' + today;
  var count = parseInt(props.getProperty(key)) || 0;
  var limit = CONFIG.DAILY_DRAFT_LIMIT || 25;

  // ── PATCH `-p5-composer-preflight-amend` (Phase 2b amend-2): also trip on
  // Gmail-side quota signal.
  //
  // Why this is necessary: the application counter `count` is only
  // incremented when a draft is SUCCESSFULLY created (see
  // `_incrementDailyDraftCount` below — called after the `GmailApp.createDraft`
  // line). When every createDraft attempt fails with the Gmail "Service
  // invoked too many times for one day" error, the counter stays at 0 forever
  // and L1 lets every lead through. The amend-1 catch in createDraft sets
  // `GMAIL_QUOTA_EXHAUSTED_<today>` when it sees that error. Reading it here
  // short-circuits L1 correctly.
  //
  // The flag is date-keyed with the SAME PT key (via _ptDateKey) so it
  // auto-clears at PT-midnight along with the counter.
  var gmailFlagKey = 'GMAIL_QUOTA_EXHAUSTED_' + today;
  var gmailFlag = props.getProperty(gmailFlagKey);
  if (gmailFlag) {
    // ── PATCH `-eq8-quota-relief`: PT-midnight auto-expiry ──────────────────
    // Google's daily Gmail pool resets at midnight US-Pacific (= 12:30 PM IST
    // during PDT), NOT at script-TZ midnight. The flag is IST-date-keyed, so a
    // flag set in the IST morning used to keep leads parked ~11.5h AFTER the
    // real pool had already refilled. Fix: the flag value stores its set-time
    // ('1|<ms>|<err>'); if the PT calendar date has rolled since it was set,
    // the pool refilled — expire the flag and let the pipeline retry.
    var __flagSetMs = parseInt((gmailFlag.split('|')[1] || '0'), 10);
    var __ptNow = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
    var __ptSet = __flagSetMs
      ? Utilities.formatDate(new Date(__flagSetMs), 'America/Los_Angeles', 'yyyy-MM-dd')
      : __ptNow;  // unparseable legacy value → conservative: treat as set today
    // PATCH `-eq8-quota-probe`: PROBE-THROUGH. The PT-day expiry alone has a
    // boundary hole: Google's pool replenishes LAGGED (observed 12:30→13:36 PM
    // IST), so a draft attempt INSIDE the lag window re-arms the flag with the
    // NEW PT-day → everything blocks until tomorrow even though the pool came
    // back an hour later (exactly what stranded 219 leads on 2026-06-11; flag
    // set 12:45 PM). Fix: if the flag age exceeds its typed clear interval, clear
    // it and let ONE lead probe. Success → pipeline flows; Gmail still dead →
    // createDraft's catch re-arms with a fresh timestamp → next probe on schedule.
    // PATCH 2026-06-13-quota-transient: clear interval is type-dependent:
    //   transient → GMAIL_TRANSIENT_CLEAR_MS (~3 min, one scanner tick)
    //   daily/legacy → 3600000 (60 min, original probe-through)
    var __flagAgeMs = __flagSetMs ? (Date.now() - __flagSetMs) : 0;
    var __clearMs = _gmailFlagClearMs(gmailFlag, Date.now());
    if (__ptSet < __ptNow) {
      props.deleteProperty(gmailFlagKey);
      Logger.log('[DailyDraftQuota] GMAIL_QUOTA_EXHAUSTED flag auto-expired — set on PT-day ' +
                 __ptSet + ', now PT-day ' + __ptNow + ' (pool refilled at midnight PT). Proceeding.');
    } else if (__flagAgeMs > __clearMs) {
      props.deleteProperty(gmailFlagKey);
      Logger.log('[DailyDraftQuota] GMAIL_QUOTA_EXHAUSTED flag is ' + Math.round(__flagAgeMs / 60000) +
                 ' min old (clearMs=' + Math.round(__clearMs / 60000) + 'min)' +
                 ' — PROBE-THROUGH: clearing to let one lead test whether the rate limit lifted. ' +
                 'If Gmail still refuses, the flag re-arms (next probe in ~' +
                 Math.round(__clearMs / 60000) + 'min).');
    } else {
      return {
        exceeded: true,
        count: count,
        limit: limit,
        gmailFlagSet: true,
        gmailFlagValue: gmailFlag,
        message: 'Gmail-side quota exhausted (GMAIL_QUOTA_EXHAUSTED_' + today + '=' +
                 gmailFlag.substring(0, 60) + '...). Pool refills at midnight US-Pacific (~12:30 PM IST).'
      };
    }
  }

  if (count >= limit) {
    return {
      exceeded: true,
      count: count,
      limit: limit,
      gmailFlagSet: false,
      message: 'Daily draft limit reached (' + count + '/' + limit + '). Resume tomorrow to protect deliverability.'
    };
  }

  return { exceeded: false, count: count, limit: limit, gmailFlagSet: false, message: '' };
}

/**
 * Increments the daily draft counter.
 */
function _incrementDailyDraftCount() {
  var props = PropertiesService.getScriptProperties();
  // PATCH 2026-06-13-quota-tz-align: use _ptDateKey() (America/Los_Angeles) instead of
  // Session.getScriptTimeZone() (IST) — mirrors QuotaMeter so counter and hard quota
  // reset at the same PT midnight. Previously PATCH 2026-05-13 AUDIT I6/R27 fixed
  // UTC→IST skew; this patch fixes the remaining IST→PT 12h misalignment.
  var today = _ptDateKey();
  var key = 'DAILY_DRAFTS_' + today;
  var count = parseInt(props.getProperty(key)) || 0;
  // MID-DAY KEY TRANSITION NOTE (2026-06-13-quota-tz-align): if this deploy
  // happens during IST daytime before ~12:30 PM IST (= PT midnight), drafts
  // created earlier today under the old IST-keyed key are not carried over —
  // the new PT-keyed counter starts at 0. This is acceptable: the soft cap
  // self-corrects within 24h and any prior IST count is visible in old keys.
  // HONESTY: this fix aligns the COUNTER's clock only — it does NOT refill
  // Gmail's hard quota. Parked leads auto-recover at the actual PT-midnight
  // Gmail reset (~12:30 PM IST). If count is unexpectedly 0 on first use
  // after deploy, that is the mid-day transition — not a bug.
  if (count === 0) {
    Logger.log('[DailyDraftQuota/quota-tz-align] New PT-keyed counter starting at 0 for key=' + key +
               '. Mid-day deploy: earlier IST-keyed drafts not carried over (acceptable; self-corrects).');
  }
  props.setProperty(key, (count + 1).toString());

  // Clean up old date counters (keep only last 7 days)
  var allProps = props.getProperties();
  for (var propKey in allProps) {
    if (propKey.indexOf('DAILY_DRAFTS_') === 0 && propKey !== key) {
      var dateStr = propKey.replace('DAILY_DRAFTS_', '');
      var propDate = new Date(dateStr);
      var daysAgo = (new Date() - propDate) / (1000 * 60 * 60 * 24);
      if (daysAgo > 7) {
        props.deleteProperty(propKey);
      }
    }
  }
}

/**
 * Returns current daily draft usage for dashboard display.
 * @returns {Object} { count, limit, remaining, date }
 */
function getDailyDraftStatus() {
  var props = PropertiesService.getScriptProperties();
  // PATCH 2026-06-13-quota-tz-align: use _ptDateKey() (America/Los_Angeles) so the
  // `date` field returned here (and shown by menuShowDailyDraftStatus) matches the
  // QuotaMeter ptDate — both now reflect the same PT calendar day.
  var today = _ptDateKey();
  var key = 'DAILY_DRAFTS_' + today;
  var count = parseInt(props.getProperty(key)) || 0;
  var limit = CONFIG.DAILY_DRAFT_LIMIT || 25;
  // PATCH `-p5-composer-preflight-amend` (Phase 2b amend-2): surface Gmail flag too
  var gmailFlagKey = 'GMAIL_QUOTA_EXHAUSTED_' + today;
  var gmailFlag = props.getProperty(gmailFlagKey);
  return {
    count: count,
    limit: limit,
    remaining: Math.max(0, limit - count),
    date: today,
    gmailFlagSet: !!gmailFlag,
    gmailFlagValue: gmailFlag || ''
  };
}

/**
 * PATCH `-p5-composer-preflight` (Phase 2b L5): Logger-loud wrapper around
 * `getDailyDraftStatus`. The plain function returns an object but doesn't
 * log it — when the user runs it from the Apps Script editor, the
 * Executions log shows only "started" / "completed" lines, which is
 * indistinguishable from a no-op. This wrapper writes the structured
 * status to Logger.log so it surfaces in the Executions panel.
 *
 * Returns the same object as `getDailyDraftStatus` so it composes.
 *
 * PATCH `-p5-composer-preflight-amend` (Phase 2b amend-2): also surfaces
 * the Gmail-side quota flag. Both signals matter — our app counter and
 * Gmail's own quota response can disagree (counter says 0/25 while Gmail
 * is throwing "too many invocations" — the case that motivated this
 * amend in the first place).
 */
function menuShowDailyDraftStatus() {
  var status = getDailyDraftStatus();
  var parts = ['[DailyDraftQuota] date=' + status.date,
               ' count=' + status.count + '/' + status.limit,
               ' remaining=' + status.remaining];
  if (status.gmailFlagSet) {
    parts.push(' GMAIL_QUOTA_FLAG=SET (' + status.gmailFlagValue.substring(0, 80) + '...)');
  } else {
    parts.push(' GMAIL_QUOTA_FLAG=clear');
  }
  if (status.remaining === 0 || status.gmailFlagSet) {
    parts.push(' [L1 WILL PARK NEW LEADS AT PENDING_QUOTA_RESET — zero token spend]');
  }
  Logger.log(parts.join(''));
  return status;
}

/**
 * PATCH `-p5-composer-preflight-amend` (Phase 2b amend-2): manual override
 * to clear the Gmail quota flag. Use only if you've verified quota is
 * actually available (e.g. you waited overnight and tested a draft
 * manually). The flag self-clears at midnight script-TZ; this is for
 * the edge case where the cron interval and the midnight rollover
 * intersect awkwardly.
 */
/**
 * PATCH `-p5-vendorresilience-config` (Phase 2e): Snov 400-backoff status.
 * Reports whether the 1h Snov 400-backoff is active + current failure count.
 */
function menuShowSnovStatus() {
  if (typeof _snovBackoffCheck !== 'function') {
    Logger.log('[SnovBackoff] _snovBackoffCheck not in scope — EnrichmentSources.gs not deployed?');
    return null;
  }
  var st = _snovBackoffCheck();
  var props = PropertiesService.getScriptProperties();
  var count = parseInt(props.getProperty('SNOV_400_COUNT') || '0', 10);
  var lastReason = props.getProperty('SNOV_400_LAST_REASON') || '';
  // PATCH `-p5-vendorresilience-config-amend`: surface cause label (credits-out
  // vs request-shape) so the user knows whether to top up Snov or fix code.
  var lastCause = props.getProperty('SNOV_400_LAST_CAUSE') || '';
  var causeNote = lastCause === 'credits_out'
    ? ' [CAUSE: vendor credits exhausted — top up at snov.io]'
    : (lastCause === 'request_shape_or_other'
        ? ' [CAUSE: request shape / unknown — investigate code]'
        : '');
  if (st.active) {
    Logger.log('[SnovBackoff] ACTIVE — remaining ' + Math.round(st.remainingMs / 1000) + 's (until ' +
               st.untilISO + ')' + causeNote +
               '. Last reason: ' + lastReason.substring(0, 160));
  } else {
    Logger.log('[SnovBackoff] clear — failure count=' + count + '/5 (threshold).' + causeNote +
               (count > 0 ? ' Last reason: ' + lastReason.substring(0, 120) : ' No recent 400s.'));
  }
  return st;
}

function menuClearSnovBackoff() {
  var props = PropertiesService.getScriptProperties();
  ['SNOV_400_BACKOFF_UNTIL', 'SNOV_400_COUNT', 'SNOV_400_LAST_REASON'].forEach(function(k) {
    if (props.getProperty(k)) {
      props.deleteProperty(k);
      Logger.log('[SnovBackoff] CLEARED ' + k);
    }
  });
}

/**
 * PATCH `-p5-vendorresilience-config-amend` (Phase 3c amend): auto-detect
 * the current deployment's Web App URL and write it to TRACKING_WEBAPP_BASE.
 *
 * Why this exists: the Apps Script "Script Properties" UI becomes read-only
 * when the project has >50 properties (Google's product limit). A user
 * already at the limit cannot manually add new properties via the UI, so
 * they need a programmatic path. `ScriptApp.getService().getUrl()` returns
 * the URL of the currently-published Web App — no input required.
 *
 * Run once from the Apps Script editor after redeploying. The pipeline
 * picks it up on the next draft creation; the "Tracking injection failed"
 * warning disappears.
 */
function menuSetTrackingWebappBaseFromDeployment() {
  var url = '';
  try {
    url = ScriptApp.getService().getUrl();
  } catch (e) {
    Logger.log('[TrackingWebappBase/auto] ScriptApp.getService().getUrl() threw: ' + e.message);
    Logger.log('[TrackingWebappBase/auto] The script may not be published as a Web App, OR the deployment URL is not yet bound.');
    Logger.log('[TrackingWebappBase/auto] Verify: Deploy → Manage deployments → confirm an active Web App deployment exists.');
    return;
  }
  if (!url) {
    Logger.log('[TrackingWebappBase/auto] ScriptApp.getService().getUrl() returned empty string. Web App may not be deployed yet.');
    return;
  }
  // PATCH `-p5-phase4-prelude`: when run from the Apps Script editor,
  // getUrl() returns the /dev URL (editor preview) instead of the published
  // /exec URL. Detect and refuse to set — the /dev URL won't reach tracking
  // recipients. Two alternative paths offered.
  if (/\/dev(\?|$)/.test(url)) {
    Logger.log('[TrackingWebappBase/auto] WARN: getUrl() returned a /dev URL — that is the editor preview, NOT your published Web App.');
    Logger.log('[TrackingWebappBase/auto]   Got: ' + url);
    Logger.log('[TrackingWebappBase/auto] Two fix paths:');
    Logger.log('[TrackingWebappBase/auto]   (A) Call the /exec endpoint instead — runs in the right context:');
    Logger.log('[TrackingWebappBase/auto]       https://script.google.com/macros/s/<YOUR_ID>/exec?action=set_tracking_base&token=<ADMIN>');
    Logger.log('[TrackingWebappBase/auto]   (B) Run menuSetTrackingWebappBaseManually — paste your /exec URL into the function source');
    Logger.log('[TrackingWebappBase/auto] NOT setting TRACKING_WEBAPP_BASE — aborting to avoid storing the wrong URL.');
    return null;
  }
  PropertiesService.getScriptProperties().setProperty('TRACKING_WEBAPP_BASE', url);
  Logger.log('[TrackingWebappBase/auto] SET TRACKING_WEBAPP_BASE = ' + url);
  Logger.log('[TrackingWebappBase/auto] Drafts created from the next pipeline run onward will include open-pixel + click-redirect tracking.');
  return url;
}

/**
 * PATCH `-p5-vendorresilience-config-amend`: list ALL script properties,
 * sorted + grouped by prefix. The Apps Script "Script Properties" UI is
 * read-only when the project has >50 properties — this helper provides
 * visibility for cleanup decisions when the UI is locked.
 *
 * Output is split into:
 *   1. Total count + per-prefix summary (quick "where is the bloat?")
 *   2. Full key listing with value preview (60-char excerpt per value)
 */
function menuListAllScriptProperties() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var keys = Object.keys(all).sort();
  Logger.log('[ScriptProperties] Total: ' + keys.length + ' properties (UI is read-only above 50)');

  // Group by underscore-prefix for cleanup decisions
  var groups = {};
  keys.forEach(function(k) {
    var prefix = k.split('_').slice(0, 2).join('_');  // e.g. "AUTO_PROCESSED" not just "AUTO"
    groups[prefix] = (groups[prefix] || 0) + 1;
  });
  Logger.log('[ScriptProperties] Grouped by 2-token prefix:');
  Object.keys(groups).sort(function(a, b) { return groups[b] - groups[a]; }).forEach(function(p) {
    Logger.log('  ' + p + ': ' + groups[p]);
  });

  Logger.log('[ScriptProperties] Full listing (alphabetical):');
  keys.forEach(function(k) {
    var v = String(all[k] || '');
    var preview = v.length > 60 ? v.substring(0, 60) + '...' : v;
    Logger.log('  ' + k + ' = ' + preview);
  });
  return { total: keys.length, groups: groups };
}

/**
 * PATCH `-p5-phase4-decisions` (Phase 4 — Decisions to Surface): list drafts
 * that came from the Tier-3 deterministic fallback path so the user can
 * prioritize manual humanization before sending.
 *
 * Why this exists: when Claude is unreachable (quota, network, MAX_TOKENS,
 * em-dash validation fail), `EmailComposer` falls back to a static template
 * (`_composeDeterministicFallback_*`). The resulting draft IS created in
 * Gmail, but it reads stiff and template-like. Without surfacing which
 * drafts went through this path, the user can't tell which to edit.
 *
 * Detection signals (in order of precedence):
 *   1. STATUS column = NEEDS_REVIEW (the unambiguous Tier-3 marker per
 *      Config.gs:184)
 *   2. NOTES contains "DETERMINISTIC_FALLBACK" or "Tier 3" markers
 *
 * Returns a structured list AND logs a readable table to Executions.
 * Each row includes a Gmail draft deep-link when DRAFT_ID is available
 * so the user can one-click to humanize.
 */
function menuListTier3Drafts(actionableOnly) {
  // PATCH `-p5-phase4-decisions-amend` (precision filter): default to
  // actionable-only. Live verification on 2026-06-09 returned 17 Tier-3
  // matches — but 11 of them were historical (SENT / DRAFT_DELETED / NEW)
  // and only 6 needed user action. The default narrows to
  // STATUS in (DRAFT_CREATED, NEEDS_REVIEW) so the list is directly
  // actionable. Pass `false` to see the full historical view.
  actionableOnly = (actionableOnly === false) ? false : true;

  var ssId = (typeof CONFIG !== 'undefined' && CONFIG.SHEET_ID) ? CONFIG.SHEET_ID : null;
  var sheetName = (typeof CONFIG !== 'undefined' && CONFIG.DATA_SHEET) ? CONFIG.DATA_SHEET : 'Sheet2';
  if (!ssId) {
    Logger.log('[Tier3Drafts] CONFIG.SHEET_ID not set; aborting');
    return null;
  }
  var ss = SpreadsheetApp.openById(ssId);
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    Logger.log('[Tier3Drafts] Sheet "' + sheetName + '" not found');
    return null;
  }
  var c = CONFIG.COLUMNS;
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    Logger.log('[Tier3Drafts] No data rows in ' + sheetName);
    return { totalScanned: 0, tier3: [], summary: {}, actionableOnly: actionableOnly };
  }

  // Read columns we need in one shot (fastest pattern for ~200-row sheets)
  var maxCol = Math.max(c.STATUS, c.NOTES, c.DRAFT_ID, c.FULL_NAME, c.EMAIL);
  var data = sheet.getRange(2, 1, lastRow - 1, maxCol).getValues();

  // Statuses that mean "user can act on this draft right now"
  var ACTIONABLE_STATUSES = {};
  ACTIONABLE_STATUSES[STATUS.DRAFT_CREATED] = true;
  ACTIONABLE_STATUSES[STATUS.NEEDS_REVIEW] = true;

  var tier3 = [];
  var summary = {};  // status → count, for the breakdown
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var rowNum = i + 2;  // 1-indexed; +1 for header
    var status = (row[c.STATUS - 1] || '').toString();
    var notes = (row[c.NOTES - 1] || '').toString();
    var name = (row[c.FULL_NAME - 1] || '').toString();
    var email = (row[c.EMAIL - 1] || '').toString();
    var draftId = (row[c.DRAFT_ID - 1] || '').toString();

    var isTier3Status = (status === STATUS.NEEDS_REVIEW);
    var isTier3Notes = /DETERMINISTIC_FALLBACK|Tier 3|Tier3.Dispatch/i.test(notes);

    if (!isTier3Status && !isTier3Notes) continue;

    // Always count for the summary breakdown
    summary[status] = (summary[status] || 0) + 1;

    // Skip non-actionable rows when filter is on (the default)
    if (actionableOnly && !ACTIONABLE_STATUSES[status]) continue;

    var draftUrl = draftId
      ? 'https://mail.google.com/mail/u/0/#drafts/' + draftId
      : '';
    tier3.push({
      row: rowNum,
      name: name,
      email: email,
      status: status,
      draftId: draftId,
      draftUrl: draftUrl,
      notesExcerpt: notes.length > 120 ? notes.substring(0, 120) + '...' : notes,
      classifiedBy: isTier3Status && isTier3Notes ? 'status+notes'
                  : isTier3Status ? 'status_only'
                  : 'notes_only'
    });
  }

  var totalMatched = Object.keys(summary).reduce(function(acc, k) { return acc + summary[k]; }, 0);
  Logger.log('[Tier3Drafts] Scanned ' + data.length + ' data rows; ' + totalMatched +
             ' historical Tier-3 matches; ' + tier3.length +
             (actionableOnly ? ' ACTIONABLE (filter on):' : ' returned (filter off — all history):'));
  Logger.log('[Tier3Drafts] Breakdown by status:');
  Object.keys(summary).sort().forEach(function(s) {
    var actionableMark = ACTIONABLE_STATUSES[s] ? ' ← actionable' : '';
    Logger.log('  ' + s + ': ' + summary[s] + actionableMark);
  });
  Logger.log('[Tier3Drafts] Items to act on:');
  tier3.forEach(function(t) {
    Logger.log('  Row ' + t.row + ' | ' + t.name + ' <' + t.email + '> | status=' + t.status +
               ' | by=' + t.classifiedBy +
               (t.draftUrl ? ' | draft=' + t.draftUrl : ' | NO DRAFT ID'));
  });
  if (tier3.length === 0) {
    Logger.log('[Tier3Drafts] No actionable Tier-3 drafts — every Tier-3 lead has been handled (sent/deleted) or is awaiting reprocess.');
  }
  return { totalScanned: data.length, tier3: tier3, summary: summary,
           actionableOnly: actionableOnly };
}

/**
 * PATCH `-postsprint-batch1` (P6 — Send queue observability): list drafts
 * that are READY TO SHIP per quality + tier + state criteria.
 *
 * Filter:
 *   - STATUS === DRAFT_CREATED (draft exists in Gmail)
 *   - QUALITY_SCORE >= 0.80 (high-confidence composition)
 *   - NOTES does NOT contain Tier-3 markers (Tier-1/2 only; Tier-3 needs
 *     manual humanization first — see menuListTier3Drafts)
 *   - DRAFT_ID present (so we have a real Gmail handle)
 *
 * Returns rows you can confidently send without further editing. Click the
 * `draftUrl` to open in Gmail, eyeball it, then either edit or hit Send.
 *
 * This is OBSERVABILITY ONLY — it does NOT call sendDraft. The actual send
 * is gated by /exec?action=send_draft or your manual Gmail click. Shipping
 * batch-send code without explicit per-message approval is too irreversible.
 *
 * @param {number} [minQuality=0.80] - quality-score floor
 * @returns {Object} - { totalScanned, readyCount, ready: [...], summary }
 */
function menuShowSendReadyDrafts(minQuality) {
  minQuality = (typeof minQuality === 'number' && minQuality > 0) ? minQuality : 0.80;

  var ssId = (typeof CONFIG !== 'undefined' && CONFIG.SHEET_ID) ? CONFIG.SHEET_ID : null;
  var sheetName = (typeof CONFIG !== 'undefined' && CONFIG.DATA_SHEET) ? CONFIG.DATA_SHEET : 'Sheet2';
  if (!ssId) { Logger.log('[SendReady] CONFIG.SHEET_ID not set'); return null; }
  var ss = SpreadsheetApp.openById(ssId);
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) { Logger.log('[SendReady] Sheet not found'); return null; }
  var c = CONFIG.COLUMNS;
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { totalScanned: 0, readyCount: 0, ready: [] };

  var maxCol = Math.max(c.STATUS, c.QUALITY_SCORE, c.DRAFT_ID, c.NOTES, c.FULL_NAME, c.EMAIL, c.SUBJECT_LINE);
  var data = sheet.getRange(2, 1, lastRow - 1, maxCol).getValues();

  var ready = [];
  var summary = { scanned: data.length, draft_created: 0, has_draft_id: 0,
                  quality_above_floor: 0, not_tier3: 0, ready: 0 };

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var status = (row[c.STATUS - 1] || '').toString();
    if (status !== STATUS.DRAFT_CREATED) continue;
    summary.draft_created++;

    var draftId = (row[c.DRAFT_ID - 1] || '').toString();
    if (!draftId) continue;
    summary.has_draft_id++;

    var quality = parseFloat(row[c.QUALITY_SCORE - 1]) || 0;
    if (quality < minQuality) continue;
    summary.quality_above_floor++;

    var notes = (row[c.NOTES - 1] || '').toString();
    var isTier3 = /DETERMINISTIC_FALLBACK|Tier 3|Tier3.Dispatch/i.test(notes);
    if (isTier3) continue;
    summary.not_tier3++;

    ready.push({
      row: i + 2,
      name: (row[c.FULL_NAME - 1] || '').toString(),
      email: (row[c.EMAIL - 1] || '').toString(),
      subject: (row[c.SUBJECT_LINE - 1] || '').toString().substring(0, 80),
      quality: quality,
      draftId: draftId,
      draftUrl: 'https://mail.google.com/mail/u/0/#drafts/' + draftId
    });
    summary.ready++;
  }

  // Sort by quality descending — highest-confidence first
  ready.sort(function(a, b) { return b.quality - a.quality; });

  Logger.log('[SendReady] Filter chain (each step narrows the pool):');
  Logger.log('  scanned: ' + summary.scanned);
  Logger.log('  → status=DRAFT_CREATED: ' + summary.draft_created);
  Logger.log('  → has draft_id: ' + summary.has_draft_id);
  Logger.log('  → quality >= ' + minQuality + ': ' + summary.quality_above_floor);
  Logger.log('  → not Tier-3: ' + summary.not_tier3);
  Logger.log('  → READY TO SHIP: ' + summary.ready);
  Logger.log('');
  Logger.log('Drafts ready to ship (sorted by quality desc):');
  ready.forEach(function(r) {
    Logger.log('  Row ' + r.row + ' | q=' + r.quality.toFixed(2) +
               ' | ' + r.name + ' <' + r.email + '> | ' + r.subject +
               ' | ' + r.draftUrl);
  });
  if (ready.length === 0) {
    Logger.log('[SendReady] No drafts pass all criteria. Either none have shipped yet (DRAFT_CREATED count=' +
               summary.draft_created + ') or all in-flight drafts are Tier-3 / low-quality.');
  }
  return { totalScanned: data.length, readyCount: ready.length, ready: ready, summary: summary,
           minQuality: minQuality };
}

/**
 * PATCH `-eq0-preflight` (EQ.0 — enrichment quality go/no-go scan).
 *
 * Wrapper that surfaces _diagStatusDistribution() to the execution log
 * (Run -> diagnosePipelineHealth dumps the JSON into the void unless you
 * Logger.log it explicitly) AND computes the EQ.0 go/no-go ratios in one
 * shot so you don't have to do arithmetic on the response.
 *
 * Buckets (per EQ.0.1 of the enrichment-quality sub-sprint prompt):
 *   A = total leads
 *   B = NEEDS_EMAIL + NEEDS_EMAIL_REVIEW   (enrichment unresolved)
 *   C = NEEDS_PRE_SEND_REVIEW              (enrichment shipped, PSV blocked)
 *   D = SKIPPED                            (you manually declined)
 *   E = SENT                               (denominator for bounce rate)
 *
 * Also runs a Gmail search for mailer-daemon / postmaster in the last 30
 * days to surface the bounce count without manual grepping.
 *
 * Decision tree applied at the end:
 *   (B+C)/A >= 20%        -> GO (enrichment is a clear bottleneck)
 *   10% <= (B+C)/A < 20%  -> GO with caveat (timebox)
 *   (B+C)/A < 10% AND bounce==0 -> NO-GO (defer; enrichment looks fine)
 *   D/A >= 15%            -> GO regardless (skip rate signal)
 *   bounces > 0           -> GO with bounce-capture priority
 */
function menuShowStatusDistribution() {
  var out = { ts: new Date().toISOString() };

  // ── 1. Status distribution via existing helper ──
  var dist = {};
  var total = 0;
  try {
    var raw = _diagStatusDistribution();
    dist = (raw && raw.dist) || {};
    total = (raw && raw.total) || 0;
  } catch (e) {
    Logger.log('[EQ0] _diagStatusDistribution threw: ' + e.message);
    return { error: e.message };
  }

  // ── 2. EQ.0 buckets ──
  var A = total;
  var B = (dist['NEEDS_EMAIL'] || 0) + (dist['NEEDS_EMAIL_REVIEW'] || 0);
  var C = (dist['NEEDS_PRE_SEND_REVIEW'] || 0);
  var D = (dist['SKIPPED'] || 0);
  var E = (dist['SENT'] || 0);

  // ── 3. Bounce scan (last 30 days, capped at 50 hits) ──
  var bounceCount = 0;
  var bounceSample = [];
  var bounceErr = null;
  try {
    var q = 'from:(mailer-daemon OR postmaster) newer_than:30d';
    var threads = GmailApp.search(q, 0, 50);
    bounceCount = threads.length;
    for (var bi = 0; bi < Math.min(5, threads.length); bi++) {
      try {
        var m = threads[bi].getMessages()[0];
        bounceSample.push({
          subject: (m.getSubject() || '').substring(0, 100),
          date: m.getDate().toISOString()
        });
      } catch (mErr) { /* skip */ }
    }
  } catch (e) {
    bounceErr = e.message;
  }

  // ── 4. Ratios ──
  var ratioBC = A > 0 ? ((B + C) / A) : 0;
  var ratioD = A > 0 ? (D / A) : 0;
  var ratioSendBounce = E > 0 ? (bounceCount / E) : 0;

  // ── 5. Decision tree ──
  var verdict;
  var reason;
  if (bounceCount > 0 && E > 0 && ratioSendBounce >= 0.05) {
    verdict = 'GO';
    reason = 'Bounce rate ' + (ratioSendBounce * 100).toFixed(1) + '% of SENT is above the 5% deliverability threshold — enrichment accuracy needs work.';
  } else if (ratioBC >= 0.20) {
    verdict = 'GO';
    reason = '(B+C)/A = ' + (ratioBC * 100).toFixed(1) + '% — enrichment review-queue burden is dominant.';
  } else if (ratioD >= 0.15) {
    verdict = 'GO';
    reason = 'SKIPPED rate = ' + (ratioD * 100).toFixed(1) + '% — high manual reject signal worth algorithmic fix.';
  } else if (ratioBC >= 0.10) {
    verdict = 'GO_WITH_CAVEAT';
    reason = '(B+C)/A = ' + (ratioBC * 100).toFixed(1) + '% — meaningful but not dominant; timebox EQ.4 research, skip EQ.9.5 stress test if no bounces.';
  } else if (bounceCount > 0) {
    verdict = 'GO_BOUNCE_CAPTURE';
    reason = 'Low review-queue burden but ' + bounceCount + ' bounces observed — EQ.2 must capture bounce data BEFORE algorithm changes.';
  } else {
    verdict = 'NO_GO';
    reason = '(B+C)/A = ' + (ratioBC * 100).toFixed(1) + '%, SKIPPED = ' + (ratioD * 100).toFixed(1) + '%, bounces = 0. Enrichment appears healthy; defer sub-sprint and pivot to next priority.';
  }

  // ── 6. Print ──
  Logger.log('=== EQ.0 PREFLIGHT — status distribution ===');
  Logger.log('Total leads (A): ' + A);
  Logger.log('');
  Logger.log('EQ.0 buckets:');
  Logger.log('  B = NEEDS_EMAIL + NEEDS_EMAIL_REVIEW : ' + B + '  (' + (A > 0 ? (B / A * 100).toFixed(1) : '0.0') + '%)');
  Logger.log('  C = NEEDS_PRE_SEND_REVIEW           : ' + C + '  (' + (A > 0 ? (C / A * 100).toFixed(1) : '0.0') + '%)');
  Logger.log('  D = SKIPPED                          : ' + D + '  (' + (A > 0 ? (D / A * 100).toFixed(1) : '0.0') + '%)');
  Logger.log('  E = SENT                             : ' + E + '  (' + (A > 0 ? (E / A * 100).toFixed(1) : '0.0') + '%)');
  Logger.log('');
  Logger.log('Ratios:');
  Logger.log('  (B+C)/A = ' + (ratioBC * 100).toFixed(2) + '%  (enrichment review burden)');
  Logger.log('  D/A     = ' + (ratioD * 100).toFixed(2) + '%  (manual skip rate)');
  Logger.log('  bounce/SENT = ' + (ratioSendBounce * 100).toFixed(2) + '%  (' + bounceCount + ' bounce-back threads / ' + E + ' sent)');
  if (bounceErr) Logger.log('  [bounce scan error: ' + bounceErr + ']');
  Logger.log('');
  if (bounceSample.length > 0) {
    Logger.log('Recent bounce samples (subject / date):');
    bounceSample.forEach(function(b) {
      Logger.log('  - ' + b.subject + '  @ ' + b.date);
    });
    Logger.log('');
  }
  Logger.log('Full status distribution (raw):');
  Object.keys(dist).sort().forEach(function(k) {
    Logger.log('  ' + k + ': ' + dist[k]);
  });
  Logger.log('');
  Logger.log('=== EQ.0 VERDICT: ' + verdict + ' ===');
  Logger.log('Reason: ' + reason);
  Logger.log('');
  Logger.log('CAVEATS:');
  Logger.log('  1. Degraded vendor state contaminates B. Recent Reoon/Snov/Gemini throttling inflates the enrichment-failure ratio. Real algorithmic quality may be better than these numbers show.');
  Logger.log('  2. D (SKIPPED) has noise unrelated to enrichment (bad content, wrong timing, lead not a fit). Treat as soft signal.');
  Logger.log('  3. Bounce scan covers last 30 days only and may miss bounces routed to Spam.');

  out.A = A; out.B = B; out.C = C; out.D = D; out.E = E;
  out.ratioBC = ratioBC; out.ratioD = ratioD; out.ratioSendBounce = ratioSendBounce;
  out.bounceCount = bounceCount; out.bounceSample = bounceSample;
  out.dist = dist;
  out.verdict = verdict; out.reason = reason;
  return out;
}

/**
 * PATCH `-postsprint-batch1` (P8 — Tier-1 fallback rate analysis): scan
 * NOTES across Sheet2 and aggregate by fallback cause so you see WHY the
 * pipeline falls back to Tier-3 most often.
 *
 * Buckets (recognized via NOTES regex):
 *   - em_dash: "[EmailComposer] FATAL validation issues survived inline fix: FATAL: Em-dash"
 *   - claude_unreachable: "Claude composer unreachable"
 *   - claude_quota: "Claude.*quota|429" (Claude 429 / quota exhaustion)
 *   - generic: "[Tier 3" without a more-specific marker
 *
 * Returns counts per cause + the offending rows so you can drill into the
 * worst offenders. Use this to decide which fix is highest-value:
 *   - em_dash dominating → tighten the composer's em-dash sanitizer
 *   - claude_unreachable dominating → check Claude API key + network
 *   - claude_quota dominating → raise Claude tier OR shift to Gemini-only
 */

// ═══════════════════════════════════════════════════════════════════════════
// EQ.2 baseline measurement helpers (stamp -eq2-baseline)
//
// Three helpers that surface the enrichment-quality baseline numbers from
// already-persisted data (Sheet2 NOTES + cols X/Y/Z/R/S + BounceLog sheet).
//
// No fresh vendor calls. Read-only. Per the EQ.2 prompt constraint.
//
// Run order recommended:
//   1. menuEQ2_TrimWindowCheck()       — confirm PipelineLog has enough history
//   2. menuEQ2_BaselineReport(30)      — main metrics
//   3. menuEQ2_AttributeBouncesToRows()— detailed bounce attribution table
//
// Methodology spec: 22_enrichment_baseline.md
// ═══════════════════════════════════════════════════════════════════════════

/**
 * EQ.2 helper #1: PipelineLog coverage check.
 *
 * The default trim window for PipelineLog is 7 days (`menuTrimPipelineLog`).
 * The baseline cohort is 30 days. Confirm log has enough history before
 * relying on it for vendor-degraded-window reconstruction.
 */
function menuEQ2_TrimWindowCheck() {
  var ssId = (typeof CONFIG !== 'undefined' && CONFIG.SHEET_ID) ? CONFIG.SHEET_ID : null;
  if (!ssId) { Logger.log('[EQ2-Trim] CONFIG.SHEET_ID not set'); return null; }
  var ss = SpreadsheetApp.openById(ssId);
  var sheet = ss.getSheetByName('PipelineLog');
  if (!sheet) { Logger.log('[EQ2-Trim] PipelineLog sheet not found'); return null; }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('[EQ2-Trim] PipelineLog is empty');
    return { rows: 0, oldestTs: null, newestTs: null, daysCovered: 0 };
  }

  // Read first column (Timestamp) only
  var timestamps = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var oldest = null, newest = null;
  for (var i = 0; i < timestamps.length; i++) {
    var raw = timestamps[i][0];
    if (!raw) continue;
    var t = (raw instanceof Date) ? raw.getTime() : Date.parse(raw.toString());
    if (isNaN(t)) continue;
    if (oldest === null || t < oldest) oldest = t;
    if (newest === null || t > newest) newest = t;
  }
  var daysCovered = (oldest !== null && newest !== null)
    ? Math.round((newest - oldest) / (24 * 60 * 60 * 1000) * 10) / 10
    : 0;

  Logger.log('=== EQ.2 — PipelineLog coverage check ===');
  Logger.log('Row count: ' + (lastRow - 1));
  Logger.log('Oldest:    ' + (oldest ? new Date(oldest).toISOString() : '<none>'));
  Logger.log('Newest:    ' + (newest ? new Date(newest).toISOString() : '<none>'));
  Logger.log('Coverage:  ' + daysCovered + ' days');
  Logger.log('');
  if (daysCovered < 30) {
    Logger.log('CAVEAT: < 30 days of log history. Vendor-degraded-window reconstruction may be incomplete.');
    Logger.log('Baseline will still work — Sheet2 NOTES is the primary data source. PipelineLog is supplementary.');
  } else {
    Logger.log('OK: ' + daysCovered + ' days covers the 30-day baseline window.');
  }

  return { rows: lastRow - 1, oldestTs: oldest, newestTs: newest, daysCovered: daysCovered };
}

/**
 * EQ.2 helper #2: composite baseline report.
 *
 * Reads Sheet2 + BounceLog. Produces the 4 metrics defined in
 * `22_enrichment_baseline.md §4`:
 *   - email quality distribution (tier × confidence)
 *   - source distribution
 *   - review-queue load
 *   - bounce rate by tier + by source
 *
 * @param {number} daysBack — cohort window (default 30). Cohort = rows with
 *                            SENT_DATE >= TODAY() - daysBack.
 */
function menuEQ2_BaselineReport(daysBack) {
  daysBack = (typeof daysBack === 'number' && daysBack > 0) ? daysBack : 30;
  var ssId = (typeof CONFIG !== 'undefined' && CONFIG.SHEET_ID) ? CONFIG.SHEET_ID : null;
  var sheetName = (typeof CONFIG !== 'undefined' && CONFIG.DATA_SHEET) ? CONFIG.DATA_SHEET : 'Sheet2';
  if (!ssId) { Logger.log('[EQ2-Baseline] CONFIG.SHEET_ID not set'); return null; }
  var ss = SpreadsheetApp.openById(ssId);
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) { Logger.log('[EQ2-Baseline] Sheet not found'); return null; }
  var c = CONFIG.COLUMNS;
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) { Logger.log('[EQ2-Baseline] Sheet empty'); return null; }

  var maxCol = Math.max(c.STATUS, c.NOTES, c.SENT_DATE, c.ENRICHED_EMAIL,
                        c.EMAIL_SOURCE, c.EMAIL_CONFIDENCE, c.EMAIL);
  var rows = sheet.getRange(2, 1, lastRow - 1, maxCol).getValues();

  var cutoffMs = Date.now() - daysBack * 24 * 60 * 60 * 1000;

  // Bucket counters
  var cohortSize = 0, preSyncerExcluded = 0;
  var byTier = { verified: 0, low_confidence: 0, best_of_available: 0,
                 constructed: 0, last_resort: 0, unknown: 0 };
  var byConfBucket = { '0.00-0.30': 0, '0.30-0.55': 0, '0.55-0.75': 0, '0.75-1.00': 0, 'no-conf': 0 };
  var bySource = {};
  var reviewQueue = { NEEDS_EMAIL_REVIEW: 0, NEEDS_PRE_SEND_REVIEW: 0,
                      STALE_RECIPIENT_REVIEW: 0, PENDING_QUOTA_RESET: 0,
                      NEEDS_EMAIL: 0 };
  var totalSheetRows = rows.length;
  // For per-row tier/source mapping — used in bounce join
  var rowMeta = {};  // ENRICHED_EMAIL -> { rowNum, tier, conf, source }

  // FINALIZER regex
  var finalizerRe = /FINALIZER\s+tier=(\S+)\s+conf=([\d.]+)\s+email=(\S+)\s+source=(\S+)/;

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var rowNum = i + 2;
    var status = (row[c.STATUS - 1] || '').toString().trim();
    var sentDateRaw = row[c.SENT_DATE - 1];
    var notes = (row[c.NOTES - 1] || '').toString();
    var enrichedEmail = (row[c.ENRICHED_EMAIL - 1] || '').toString().trim().toLowerCase();
    var emailSource = (row[c.EMAIL_SOURCE - 1] || '').toString().trim();
    var emailConf = parseFloat(row[c.EMAIL_CONFIDENCE - 1]);

    // Review-queue counts (across ALL rows, not just cohort)
    if (reviewQueue.hasOwnProperty(status)) reviewQueue[status]++;

    // Cohort eligibility: SENT_DATE present and within window
    var sentMs = null;
    if (sentDateRaw) {
      sentMs = (sentDateRaw instanceof Date) ? sentDateRaw.getTime() : Date.parse(sentDateRaw.toString());
    }
    if (!sentMs || isNaN(sentMs)) {
      if (status === 'SENT') preSyncerExcluded++;
      continue;
    }
    if (sentMs < cutoffMs) continue;

    cohortSize++;

    // Parse FINALIZER tag
    var m = notes.match(finalizerRe);
    var tier = 'unknown';
    if (m) {
      tier = m[1];
      // Normalize tier name
      if (!byTier.hasOwnProperty(tier)) tier = 'unknown';
    }
    byTier[tier]++;

    // Confidence bucket (use col Z if numeric; else parse from FINALIZER if present)
    var conf = isNaN(emailConf) ? (m ? parseFloat(m[2]) : NaN) : emailConf;
    if (isNaN(conf)) byConfBucket['no-conf']++;
    else if (conf < 0.30) byConfBucket['0.00-0.30']++;
    else if (conf < 0.55) byConfBucket['0.30-0.55']++;
    else if (conf < 0.75) byConfBucket['0.55-0.75']++;
    else byConfBucket['0.75-1.00']++;

    // Source distribution (group by prefix)
    var srcKey = _eq2GroupSourcePrefix(emailSource);
    bySource[srcKey] = (bySource[srcKey] || 0) + 1;

    // Stash per-row meta for bounce join
    if (enrichedEmail) {
      rowMeta[enrichedEmail] = {
        rowNum: rowNum, tier: tier, conf: isNaN(conf) ? null : conf,
        source: emailSource, srcGroup: srcKey
      };
    }
  }

  // BounceLog join
  var bounceSheet = ss.getSheetByName('BounceLog');
  var bouncesByTier = {};
  var bouncesBySource = {};
  var totalHardBounces = 0, totalSoftBounces = 0, bouncesMatchedToCohort = 0, bouncesUnmatched = 0;
  if (bounceSheet && bounceSheet.getLastRow() >= 2) {
    var blRows = bounceSheet.getRange(2, 1, bounceSheet.getLastRow() - 1, 4).getValues();
    // BounceLog columns: A=Timestamp B=Email C=Domain D=Category
    for (var bi = 0; bi < blRows.length; bi++) {
      var blEmail = (blRows[bi][1] || '').toString().trim().toLowerCase();
      var blCategory = (blRows[bi][3] || '').toString().toLowerCase();
      var blTsRaw = blRows[bi][0];
      var blMs = blTsRaw ? ((blTsRaw instanceof Date) ? blTsRaw.getTime() : Date.parse(blTsRaw.toString())) : null;
      // Window filter — only count bounces within the cohort window
      if (blMs && blMs < cutoffMs) continue;

      if (blCategory.indexOf('hard') >= 0) totalHardBounces++;
      else if (blCategory.indexOf('soft') >= 0) totalSoftBounces++;

      var meta = rowMeta[blEmail];
      if (meta) {
        bouncesMatchedToCohort++;
        if (blCategory.indexOf('hard') >= 0) {
          bouncesByTier[meta.tier] = (bouncesByTier[meta.tier] || 0) + 1;
          bouncesBySource[meta.srcGroup] = (bouncesBySource[meta.srcGroup] || 0) + 1;
        }
      } else {
        bouncesUnmatched++;
      }
    }
  }

  // ── Print ──
  Logger.log('═══════════════════════════════════════════════════════════════');
  Logger.log('EQ.2 BASELINE REPORT — last ' + daysBack + ' days');
  Logger.log('Generated: ' + new Date().toISOString());
  Logger.log('Cohort: Sheet2 rows where SENT_DATE >= ' + new Date(cutoffMs).toISOString());
  Logger.log('═══════════════════════════════════════════════════════════════');
  Logger.log('');
  Logger.log('Cohort size:                       ' + cohortSize);
  Logger.log('Pre-syncer SENT rows excluded:     ' + preSyncerExcluded);
  Logger.log('Total Sheet2 rows:                 ' + totalSheetRows);
  Logger.log('');

  Logger.log('--- §1. Email quality distribution (tier) ---');
  Object.keys(byTier).forEach(function(k) {
    var pct = cohortSize > 0 ? (byTier[k] / cohortSize * 100).toFixed(1) : '0.0';
    Logger.log('  ' + _eq2Pad(k, 22) + ' ' + _eq2Pad(byTier[k], 4) + ' (' + pct + '%)');
  });
  Logger.log('');
  Logger.log('Confidence histogram:');
  Object.keys(byConfBucket).forEach(function(k) {
    var pct = cohortSize > 0 ? (byConfBucket[k] / cohortSize * 100).toFixed(1) : '0.0';
    Logger.log('  ' + _eq2Pad(k, 14) + ' ' + _eq2Pad(byConfBucket[k], 4) + ' (' + pct + '%)');
  });
  Logger.log('');

  Logger.log('--- §2. Source distribution (top 10) ---');
  var srcEntries = Object.keys(bySource).map(function(k) { return [k, bySource[k]]; });
  srcEntries.sort(function(a, b) { return b[1] - a[1]; });
  for (var si = 0; si < Math.min(10, srcEntries.length); si++) {
    var pct = cohortSize > 0 ? (srcEntries[si][1] / cohortSize * 100).toFixed(1) : '0.0';
    Logger.log('  ' + _eq2Pad(srcEntries[si][0], 36) + ' ' + _eq2Pad(srcEntries[si][1], 4) + ' (' + pct + '%)');
  }
  Logger.log('');

  Logger.log('--- §3. Review-queue load (across ALL rows) ---');
  Object.keys(reviewQueue).forEach(function(k) {
    var pct = totalSheetRows > 0 ? (reviewQueue[k] / totalSheetRows * 100).toFixed(1) : '0.0';
    Logger.log('  ' + _eq2Pad(k, 24) + ' ' + _eq2Pad(reviewQueue[k], 4) + ' (' + pct + '% of all rows)');
  });
  var totalReview = reviewQueue.NEEDS_EMAIL_REVIEW + reviewQueue.NEEDS_PRE_SEND_REVIEW +
                    reviewQueue.STALE_RECIPIENT_REVIEW + reviewQueue.PENDING_QUOTA_RESET +
                    reviewQueue.NEEDS_EMAIL;
  var totalPct = totalSheetRows > 0 ? (totalReview / totalSheetRows * 100).toFixed(1) : '0.0';
  Logger.log('  TOTAL review/parked              ' + _eq2Pad(totalReview, 4) + ' (' + totalPct + '%)');
  Logger.log('');

  Logger.log('--- §4. Bounce rate (cohort window) ---');
  Logger.log('  BounceLog hard bounces in window: ' + totalHardBounces);
  Logger.log('  BounceLog soft bounces in window: ' + totalSoftBounces);
  Logger.log('  Matched to cohort:                ' + bouncesMatchedToCohort);
  Logger.log('  Unmatched (no Sheet2 row):        ' + bouncesUnmatched);
  var hardRate = cohortSize > 0 ? (totalHardBounces / cohortSize * 100).toFixed(2) : '0.00';
  Logger.log('  Overall hard-bounce rate:         ' + hardRate + '% (' + totalHardBounces + ' / ' + cohortSize + ')');
  Logger.log('');
  Logger.log('Bounce rate by tier:');
  Object.keys(byTier).forEach(function(t) {
    if (byTier[t] === 0) return;
    var hb = bouncesByTier[t] || 0;
    var rate = (hb / byTier[t] * 100).toFixed(2);
    Logger.log('  ' + _eq2Pad(t, 22) + ' ' + _eq2Pad(hb, 4) + ' / ' + _eq2Pad(byTier[t], 4) + ' = ' + rate + '%');
  });
  Logger.log('');
  Logger.log('Bounce rate by source (top 5 by bounces):');
  var bounceSrcEntries = Object.keys(bouncesBySource).map(function(k) { return [k, bouncesBySource[k]]; });
  bounceSrcEntries.sort(function(a, b) { return b[1] - a[1]; });
  for (var bsi = 0; bsi < Math.min(5, bounceSrcEntries.length); bsi++) {
    var src = bounceSrcEntries[bsi][0];
    var sb = bounceSrcEntries[bsi][1];
    var ss_ = bySource[src] || 0;
    var srcRate = ss_ > 0 ? (sb / ss_ * 100).toFixed(2) : 'n/a';
    Logger.log('  ' + _eq2Pad(src, 36) + ' ' + _eq2Pad(sb, 3) + ' / ' + _eq2Pad(ss_, 4) + ' = ' + srcRate + '%');
  }
  Logger.log('');

  Logger.log('CAVEATS:');
  Logger.log('  - Cohort excludes ' + preSyncerExcluded + ' SENT rows with empty SENT_DATE (pre-syncer).');
  Logger.log('  - NOTES col is overwritten on row re-process; tier reflects LAST enrichment decision per row.');
  Logger.log('  - BounceLog requires processBounces() trigger active; bounces detected after the fact.');
  Logger.log('  - Degraded-vendor windows (Reoon/Snov/Gemini throttling) contaminate this measurement.');
  Logger.log('═══════════════════════════════════════════════════════════════');

  return {
    cohortSize: cohortSize, preSyncerExcluded: preSyncerExcluded, totalSheetRows: totalSheetRows,
    byTier: byTier, byConfBucket: byConfBucket, bySource: bySource,
    reviewQueue: reviewQueue, totalReview: totalReview,
    totalHardBounces: totalHardBounces, totalSoftBounces: totalSoftBounces,
    bouncesMatchedToCohort: bouncesMatchedToCohort, bouncesUnmatched: bouncesUnmatched,
    bouncesByTier: bouncesByTier, bouncesBySource: bouncesBySource,
    hardBounceRate: cohortSize > 0 ? totalHardBounces / cohortSize : 0,
    daysBack: daysBack, generated: new Date().toISOString()
  };
}

/**
 * EQ.2 helper #3: detailed bounce-to-row attribution table.
 *
 * For each BounceLog entry, look up the Sheet2 row via ENRICHED_EMAIL (col X)
 * first, then EMAIL (col F). Print the full provenance: row, tier_at_send,
 * confidence, source, bounce category. Bounces with no matching row are
 * listed separately.
 */
function menuEQ2_AttributeBouncesToRows() {
  var ssId = (typeof CONFIG !== 'undefined' && CONFIG.SHEET_ID) ? CONFIG.SHEET_ID : null;
  var sheetName = (typeof CONFIG !== 'undefined' && CONFIG.DATA_SHEET) ? CONFIG.DATA_SHEET : 'Sheet2';
  if (!ssId) { Logger.log('[EQ2-Bounce] CONFIG.SHEET_ID not set'); return null; }
  var ss = SpreadsheetApp.openById(ssId);
  var sheet = ss.getSheetByName(sheetName);
  var bounceSheet = ss.getSheetByName('BounceLog');
  if (!sheet) { Logger.log('[EQ2-Bounce] Sheet2 not found'); return null; }
  if (!bounceSheet || bounceSheet.getLastRow() < 2) {
    Logger.log('[EQ2-Bounce] BounceLog empty — no bounces to attribute.');
    return { totalBounces: 0, matched: [], unmatched: [] };
  }
  var c = CONFIG.COLUMNS;
  var maxCol = Math.max(c.NOTES, c.ENRICHED_EMAIL, c.EMAIL, c.EMAIL_SOURCE, c.EMAIL_CONFIDENCE, c.STATUS, c.FULL_NAME);
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, maxCol).getValues();

  // Build email -> row index
  var byEnriched = {}, byEmail = {};
  for (var i = 0; i < rows.length; i++) {
    var er = (rows[i][c.ENRICHED_EMAIL - 1] || '').toString().trim().toLowerCase();
    var em = (rows[i][c.EMAIL - 1] || '').toString().trim().toLowerCase();
    if (er && !byEnriched[er]) byEnriched[er] = i + 2;
    if (em && !byEmail[em]) byEmail[em] = i + 2;
  }

  var finalizerRe = /FINALIZER\s+tier=(\S+)\s+conf=([\d.]+)\s+email=(\S+)\s+source=(\S+)/;
  var blRows = bounceSheet.getRange(2, 1, bounceSheet.getLastRow() - 1, 6).getValues();
  // BounceLog: A=Timestamp B=Email C=Domain D=Category E=StatusCode F=Reason

  var matched = [], unmatched = [];

  for (var bi = 0; bi < blRows.length; bi++) {
    var blTs = blRows[bi][0];
    var blEmail = (blRows[bi][1] || '').toString().trim().toLowerCase();
    var blDomain = (blRows[bi][2] || '').toString();
    var blCategory = (blRows[bi][3] || '').toString();
    var blStatusCode = (blRows[bi][4] || '').toString();

    var rowNum = byEnriched[blEmail] || byEmail[blEmail] || null;
    if (!rowNum) {
      unmatched.push({ email: blEmail, domain: blDomain, category: blCategory,
                       statusCode: blStatusCode, ts: blTs });
      continue;
    }
    var srcRow = rows[rowNum - 2];
    var notes = (srcRow[c.NOTES - 1] || '').toString();
    var fullName = (srcRow[c.FULL_NAME - 1] || '').toString();
    var status = (srcRow[c.STATUS - 1] || '').toString();
    var source = (srcRow[c.EMAIL_SOURCE - 1] || '').toString();
    var conf = parseFloat(srcRow[c.EMAIL_CONFIDENCE - 1]);
    var tier = 'unknown';
    var m = notes.match(finalizerRe);
    if (m) tier = m[1];

    matched.push({
      bouncedEmail: blEmail, rowNum: rowNum, fullName: fullName,
      currentStatus: status, tier: tier,
      confidence: isNaN(conf) ? null : conf, source: source,
      category: blCategory, statusCode: blStatusCode, ts: blTs
    });
  }

  Logger.log('=== EQ.2 BOUNCE ATTRIBUTION TABLE ===');
  Logger.log('Total BounceLog entries: ' + blRows.length);
  Logger.log('Matched to Sheet2 rows:  ' + matched.length);
  Logger.log('Unmatched (no row):      ' + unmatched.length);
  Logger.log('');
  Logger.log('Matched bounces (newest first):');
  matched.sort(function(a, b) {
    var ta = a.ts ? ((a.ts instanceof Date) ? a.ts.getTime() : Date.parse(a.ts)) : 0;
    var tb = b.ts ? ((b.ts instanceof Date) ? b.ts.getTime() : Date.parse(b.ts)) : 0;
    return tb - ta;
  });
  matched.forEach(function(r) {
    var confStr = (r.confidence !== null) ? r.confidence.toFixed(2) : 'n/a';
    Logger.log('  row=' + r.rowNum + ' name=' + (r.fullName || '?') +
               ' email=' + r.bouncedEmail + ' tier=' + r.tier +
               ' conf=' + confStr + ' source=' + r.source +
               ' category=' + r.category + ' code=' + r.statusCode);
  });
  if (unmatched.length > 0) {
    Logger.log('');
    Logger.log('Unmatched bounces (no Sheet2 row — may be pre-pipeline test sends or deleted rows):');
    unmatched.slice(0, 20).forEach(function(r) {
      Logger.log('  email=' + r.email + ' category=' + r.category +
                 ' code=' + r.statusCode + ' domain=' + r.domain);
    });
    if (unmatched.length > 20) Logger.log('  ... (' + (unmatched.length - 20) + ' more)');
  }

  return { totalBounces: blRows.length, matched: matched, unmatched: unmatched };
}

// Internal helper: group EMAIL_SOURCE strings by prefix for distribution analysis
function _eq2GroupSourcePrefix(src) {
  if (!src) return '<empty>';
  src = src.toString();
  // unified_selector_apollo_verified -> unified_selector_apollo
  // unified_selector_pattern_first_last -> unified_selector_pattern
  var m = src.match(/^(unified_selector_(?:apollo|hunter|pattern|apk|snov))/);
  if (m) return m[1];
  // cascade-side: keep specific names that matter for diagnostics
  if (src.indexOf('apollo_people_match') >= 0) return 'cascade.apollo_people_match';
  if (src.indexOf('reoon_verified_guess') >= 0) return 'cascade.reoon_verified_guess';
  if (src.indexOf('findymail') >= 0) return 'cascade.findymail';
  if (src.indexOf('hunter') >= 0) return 'cascade.hunter';
  if (src.indexOf('snov') >= 0) return 'cascade.snov';
  if (src.indexOf('msd') >= 0) return 'cascade.msd';
  if (src.indexOf('last_resort') >= 0) return 'cascade.last_resort';
  if (src.indexOf('apk') >= 0) return 'cascade.apk';
  return src;  // unknown — surface verbatim
}

// Internal: right-pad helper for clean Logger.log columns
function _eq2Pad(val, width) {
  var s = val.toString();
  while (s.length < width) s += ' ';
  return s;
}

function menuAnalyzeTier1Fallback() {
  var ssId = (typeof CONFIG !== 'undefined' && CONFIG.SHEET_ID) ? CONFIG.SHEET_ID : null;
  var sheetName = (typeof CONFIG !== 'undefined' && CONFIG.DATA_SHEET) ? CONFIG.DATA_SHEET : 'Sheet2';
  if (!ssId) { Logger.log('[FallbackStats] CONFIG.SHEET_ID not set'); return null; }
  var ss = SpreadsheetApp.openById(ssId);
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) { Logger.log('[FallbackStats] Sheet not found'); return null; }
  var c = CONFIG.COLUMNS;
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { totalScanned: 0, byCause: {} };

  var maxCol = Math.max(c.NOTES, c.STATUS, c.FULL_NAME);
  var data = sheet.getRange(2, 1, lastRow - 1, maxCol).getValues();

  var byCause = {
    // Phase-amend buckets that match the NEW reasonCode emission from
    // BatchProcessor.gs:1237 (reason=<code> tag in NOTES)
    fatal_em_dash:           { count: 0, rows: [] },
    fatal_word_count:        { count: 0, rows: [] },
    fatal_typography:        { count: 0, rows: [] },
    fatal_validation_other:  { count: 0, rows: [] },
    claude_api_error:        { count: 0, rows: [] },
    claude_unparseable:      { count: 0, rows: [] },
    // Legacy buckets — match historical NOTES that don't have reason= tag
    legacy_em_dash:          { count: 0, rows: [] },
    legacy_claude_unreachable: { count: 0, rows: [] },
    legacy_unknown:          { count: 0, rows: [] }
  };
  var anyTier3Count = 0;

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var notes = (row[c.NOTES - 1] || '').toString();
    var name = (row[c.FULL_NAME - 1] || '').toString();
    var rowNum = i + 2;
    var hasTier3 = /DETERMINISTIC_FALLBACK|Tier 3|Tier3.Dispatch/i.test(notes);
    if (!hasTier3) continue;
    anyTier3Count++;

    // PATCH `-postsprint-batch1-amend`: prefer the explicit reason= marker
    // (new format) over heuristic body inspection (legacy fallback).
    var reasonMatch = notes.match(/reason=([a-z_]+)/i);
    if (reasonMatch && byCause[reasonMatch[1]]) {
      byCause[reasonMatch[1]].count++;
      byCause[reasonMatch[1]].rows.push({ row: rowNum, name: name });
      continue;
    }

    // Legacy heuristic fallback for old NOTES (no reason= tag)
    if (/em-?dash|en-?dash/i.test(notes)) {
      byCause.legacy_em_dash.count++;
      byCause.legacy_em_dash.rows.push({ row: rowNum, name: name });
    } else if (/Claude.*unreachable|claude.*timeout|claude.*5\d\d/i.test(notes)) {
      byCause.legacy_claude_unreachable.count++;
      byCause.legacy_claude_unreachable.rows.push({ row: rowNum, name: name });
    } else {
      byCause.legacy_unknown.count++;
      byCause.legacy_unknown.rows.push({ row: rowNum, name: name });
    }
  }

  Logger.log('[FallbackStats] Scanned ' + data.length + ' rows; ' + anyTier3Count + ' had Tier-3 marker:');
  Object.keys(byCause).sort(function(a, b) { return byCause[b].count - byCause[a].count; }).forEach(function(cause) {
    var pct = anyTier3Count > 0 ? Math.round((byCause[cause].count / anyTier3Count) * 100) : 0;
    Logger.log('  ' + cause + ': ' + byCause[cause].count + ' (' + pct + '%)');
    byCause[cause].rows.slice(0, 5).forEach(function(r) {
      Logger.log('    row ' + r.row + ' — ' + r.name);
    });
    if (byCause[cause].rows.length > 5) {
      Logger.log('    ...and ' + (byCause[cause].rows.length - 5) + ' more');
    }
  });
  return { totalScanned: data.length, anyTier3Count: anyTier3Count, byCause: byCause };
}

/**
 * PATCH `-hr-cxo-template-polish-amend` (2026-06-09): force-set the Gemini
 * API key to a known canonical value. UNCONDITIONAL — overwrites any
 * existing value (unlike `bootstrapApiKeys`/`runSetupOneShot` which use
 * `if (!getProperty(...))` and only set when missing).
 *
 * Use this when:
 *   - You rotated keys in AI Studio and need to push the new one across
 *   - You suspect a stale or corrupted key in Script Properties
 *   - You want to verify what's currently stored vs what should be there
 *
 * After force-set:
 *   - All 5 Gemini consumer sites (callGemini, callGeminiGrounded,
 *     _probeGemini, MultiSignalDisambiguator, DomainPatternDiscovery) read
 *     from PropertiesService — so updating the property updates ALL of them
 *     atomically. No code path uses a hardcoded key (the security comment in
 *     ApiClients.gs:29-37 enforces this).
 *
 * Output: fingerprint before, fingerprint after, probe result.
 */
function menuForceGeminiApiKey() {
  var EXPECTED_KEY = 'YOUR_GEMINI_API_KEY';
  var props = PropertiesService.getScriptProperties();

  // Read the BEFORE state — safe fingerprint only, never log the full secret
  var beforeRaw = props.getProperty('GEMINI_API_KEY');
  var beforeFp = beforeRaw
    ? (beforeRaw.substring(0, 6) + '...(' + beforeRaw.length + ' chars)...' + beforeRaw.substring(beforeRaw.length - 4))
    : '(not set)';
  var beforeMatches = (beforeRaw === EXPECTED_KEY);

  Logger.log('[GeminiKey/Force] BEFORE: ' + beforeFp + ' — ' +
             (beforeMatches ? 'already matches expected ✓'
                            : (beforeRaw ? 'DIFFERENT from expected — will overwrite'
                                          : 'not set — will set')));

  // FORCE SET — unconditional, overwrites any existing value
  props.setProperty('GEMINI_API_KEY', EXPECTED_KEY);
  var afterRaw = props.getProperty('GEMINI_API_KEY');
  var afterFp = afterRaw.substring(0, 6) + '...(' + afterRaw.length + ' chars)...' + afterRaw.substring(afterRaw.length - 4);
  var afterMatches = (afterRaw === EXPECTED_KEY);

  Logger.log('[GeminiKey/Force] AFTER:  ' + afterFp + ' — ' +
             (afterMatches ? 'matches expected ✓ FORCED' : 'WRITE FAILED, value differs'));

  // Probe Gemini directly to confirm the key is live and rate-limit clear
  var probeUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + EXPECTED_KEY;
  var startMs = Date.now();
  var probe;
  try {
    probe = UrlFetchApp.fetch(probeUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        contents: [{ parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 1 }
      }),
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log('[GeminiKey/Force] PROBE THREW: ' + e.message);
    return { keyForced: afterMatches, probeError: e.message };
  }
  var code = probe.getResponseCode();
  var body = (probe.getContentText() || '').substring(0, 300);
  var elapsed = Date.now() - startMs;
  Logger.log('[GeminiKey/Force] PROBE: HTTP ' + code + ' in ' + elapsed + 'ms');
  Logger.log('[GeminiKey/Force] PROBE body: ' + body);

  if (code >= 200 && code < 300) {
    Logger.log('[GeminiKey/Force] STATUS: alive — key works AND quota available.');
  } else if (code === 401 || code === 403) {
    Logger.log('[GeminiKey/Force] STATUS: auth_failed — key invalid. Check AI Studio.');
  } else if (code === 429) {
    Logger.log('[GeminiKey/Force] STATUS: rate_limited — key valid but at quota limit (60 RPM on free tier).');
  } else {
    Logger.log('[GeminiKey/Force] STATUS: unknown — see body above.');
  }

  // Also clear any active Gemini backoff so the next pipeline call doesn't short-circuit
  if (typeof menuClearGeminiBackoff === 'function') {
    Logger.log('[GeminiKey/Force] Clearing any active Gemini backoff flag...');
    menuClearGeminiBackoff();
  }

  return {
    expectedKey: EXPECTED_KEY.substring(0, 6) + '...' + EXPECTED_KEY.substring(EXPECTED_KEY.length - 4),
    beforeFingerprint: beforeFp,
    afterFingerprint: afterFp,
    forced: !beforeMatches,
    probeHttp: code,
    probeLatencyMs: elapsed
  };
}

/**
 * PATCH `-hr-cxo-template-polish-amend`: verify Reoon credits restored after
 * a top-up. Clears the daily HARD-TRIP flag (set when credits ran out),
 * then probes with a real verification call against a throwaway address.
 * If credits are back, probe returns alive + the next pipeline call works.
 * If still empty, the probe trips the flag again — loud, not silent.
 */
function menuVerifyReoonAfterTopUp() {
  Logger.log('[ReoonVerify] Step 1: clearing the daily hard-trip flag...');
  if (typeof menuClearReoonQuotaFlag === 'function') {
    menuClearReoonQuotaFlag();
  } else {
    Logger.log('[ReoonVerify] WARN: menuClearReoonQuotaFlag not in scope; falling back to direct deleteProperty');
    var props = PropertiesService.getScriptProperties();
    var today = (typeof _reoonQuickQuotaUtcDateKey === 'function')
      ? _reoonQuickQuotaUtcDateKey()
      : Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
    try { props.deleteProperty('REOON_QUOTA_EXHAUSTED_' + today); } catch (_) {}
  }

  Logger.log('[ReoonVerify] Step 2: probing Reoon with throwaway address...');
  if (typeof _probeReoon !== 'function') {
    Logger.log('[ReoonVerify] _probeReoon not in scope — HealthCheck.gs not deployed?');
    return null;
  }
  var result = _probeReoon();
  Logger.log('[ReoonVerify] Result: status=' + result.status +
             ' latency=' + result.latencyMs + 'ms');
  Logger.log('[ReoonVerify] Excerpt: ' + (result.excerpt || '').substring(0, 200));

  if (result.status === 'alive') {
    Logger.log('[ReoonVerify] ✓ CREDITS RESTORED — verifyEmailDeliverable calls will now resolve. ' +
               'Next lead through the pipeline gets a real "valid/catch_all/invalid" signal ' +
               'instead of "skipped". Expect confidence to jump from ~50% to 80%+ for leads where ' +
               'Reoon agrees with the Hunter pattern guess.');
  } else if (result.status === 'quota_exhausted') {
    Logger.log('[ReoonVerify] ⚠ STILL EXHAUSTED — top-up may not have processed yet, or applied ' +
               'to a different account. Check the Reoon dashboard. The hard-trip flag has been ' +
               'set again automatically.');
  } else {
    Logger.log('[ReoonVerify] ⚠ Status=' + result.status + ' — investigate before retrying. ' +
               'See excerpt above.');
  }
  return result;
}

/**
 * PATCH `-hr-cxo-template-polish-amend`: combined one-shot refresh.
 * Force-sets Gemini key + verifies Reoon + probes all 8 vendors via
 * runHealthCheck. Use after any major vendor change (key rotation, credit
 * top-up, plan upgrade).
 */
function menuRefreshAllVendorState() {
  Logger.log('═══ Vendor State Refresh ═══');
  Logger.log('');
  Logger.log('── 1. Gemini API key (force-set) ──');
  if (typeof menuForceGeminiApiKey === 'function') menuForceGeminiApiKey();
  Logger.log('');
  Logger.log('── 2. Reoon (post-top-up verification) ──');
  if (typeof menuVerifyReoonAfterTopUp === 'function') menuVerifyReoonAfterTopUp();
  Logger.log('');
  Logger.log('── 3. Full health probe (all 8 vendors) ──');
  if (typeof runHealthCheck === 'function') runHealthCheck();
  Logger.log('');
  Logger.log('═══ Refresh complete ═══');
}

/**
 * PATCH `-promote-scanner-emdash-fix` (2026-06-09): Claude API key + network
 * diagnostic. The dashboard's `Claude=unknown` result is opaque — it could
 * mean transient 5xx, auth_failed with non-standard body, or actual outage.
 * This helper fires a probe and logs the full HTTP code + body excerpt so
 * the user can see WHAT Claude returned (instead of just classifier output).
 *
 * Cost: 1 token of Claude output (~$0.00001 per call). Safe to run any time.
 *
 * Also reports the key's safe fingerprint (length + first-4 / last-4) so
 * you can quickly compare against the value in your password manager or
 * `.env` file — without revealing the full secret in the log.
 */
function menuShowClaudeApiHealth() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('CLAUDE_API_KEY');

  if (!key) {
    Logger.log('[ClaudeApiHealth] CLAUDE_API_KEY is NOT SET in Script Properties.');
    Logger.log('[ClaudeApiHealth] Fix: Project Settings → Script Properties → add CLAUDE_API_KEY with your sk-ant-api03-... value');
    return { keySet: false };
  }

  // Safe fingerprint — first 4 + length + last 4. NEVER log the full key.
  var fp = key.substring(0, 4) + '...(' + key.length + ' chars)...' + key.substring(key.length - 4);
  Logger.log('[ClaudeApiHealth] CLAUDE_API_KEY fingerprint: ' + fp);
  if (!/^sk-ant-/.test(key)) {
    Logger.log('[ClaudeApiHealth] WARN: key does not start with "sk-ant-" — may be malformed or wrong provider key');
  }

  // Probe with the minimum-cost call (1 token max)
  var start = Date.now();
  var probe;
  try {
    probe = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }]
      }),
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log('[ClaudeApiHealth] Network call THREW: ' + e.message);
    Logger.log('[ClaudeApiHealth] Likely cause: ' +
               (/timed out/i.test(e.message) ? 'Apps Script UrlFetch timeout (rare; check Anthropic status page)'
              : /dns/i.test(e.message) ? 'DNS resolution failure (Apps Script-side issue)'
              : 'unknown network error — log full message above'));
    return { keySet: true, fingerprint: fp, error: e.message };
  }

  var code = probe.getResponseCode();
  var body = (probe.getContentText() || '').substring(0, 400);
  var elapsed = Date.now() - start;

  Logger.log('[ClaudeApiHealth] HTTP ' + code + ' in ' + elapsed + 'ms');
  Logger.log('[ClaudeApiHealth] Body excerpt: ' + body);

  if (code >= 200 && code < 300) {
    Logger.log('[ClaudeApiHealth] STATUS: alive — Claude API responding normally.');
  } else if (code === 401) {
    Logger.log('[ClaudeApiHealth] STATUS: auth_failed — key invalid or expired. Regenerate at console.anthropic.com.');
  } else if (code === 403) {
    Logger.log('[ClaudeApiHealth] STATUS: forbidden — key valid but lacks permission for this model OR billing issue.');
  } else if (code === 429) {
    Logger.log('[ClaudeApiHealth] STATUS: rate_limited — over the rate limit (RPM/TPM). Wait or upgrade tier.');
  } else if (code >= 500 && code < 600) {
    Logger.log('[ClaudeApiHealth] STATUS: server_error — Anthropic-side issue. Check status.anthropic.com.');
  } else {
    Logger.log('[ClaudeApiHealth] STATUS: unknown — see body excerpt above.');
  }
  return { keySet: true, fingerprint: fp, httpCode: code, latencyMs: elapsed, bodyExcerpt: body };
}

/**
 * PATCH `-postsprint-batch1` (P7): wrapper for the existing tracking_summary
 * endpoint. The endpoint at /exec?action=tracking_summary already exists
 * (Tracking.gs); this helper just runs it from the editor for a single
 * lead and Logger.logs the result.
 *
 * Usage: edit the leadRow variable below, then run.
 */
function menuShowTrackingStatsForLead() {
  // ─────────── EDIT THIS LINE — the Sheet2 row number you want stats for ───────────
  var leadRow = 0;
  // ──────────────────────────────────────────────────────────────────────────────────

  if (leadRow === 0) {
    Logger.log('[TrackingStats] Edit the function source: set leadRow to the Sheet2 row number you want tracking stats for, then run.');
    Logger.log('[TrackingStats] Or call the endpoint directly: /exec?action=tracking_summary&row=<N>&token=<ADMIN>');
    return;
  }
  if (typeof getTrackingSummaryForRow !== 'function' && typeof trackingHandleSummary !== 'function') {
    Logger.log('[TrackingStats] No tracking summary function in scope — Tracking.gs not deployed?');
    return;
  }
  // We invoke the underlying summary function directly. Different revisions
  // expose it under different names; try both.
  var stats = null;
  try {
    if (typeof getTrackingSummaryForRow === 'function') {
      stats = getTrackingSummaryForRow(leadRow);
    } else if (typeof trackingHandleSummary === 'function') {
      stats = trackingHandleSummary({ parameter: { row: String(leadRow) } });
    }
  } catch (e) {
    Logger.log('[TrackingStats] Summary call threw: ' + e.message);
    return;
  }
  Logger.log('[TrackingStats] Row ' + leadRow + ' tracking stats: ' + JSON.stringify(stats).substring(0, 2000));
  return stats;
}

/**
 * PATCH `-p5-phase4-decisions`: combined dashboard of all circuit breakers
 * and resource counters in one call. Saves running 7 separate menu helpers.
 */
function menuShowAllBreakers() {
  Logger.log('═══ AutoMail Pipeline Health Dashboard ═══');
  Logger.log('');
  Logger.log('── Vendor circuit breakers ──');
  if (typeof menuShowDailyDraftStatus === 'function') menuShowDailyDraftStatus();
  if (typeof menuShowGeminiBackoffStatus === 'function') menuShowGeminiBackoffStatus();
  if (typeof menuShowReoonQuotaStatus === 'function') menuShowReoonQuotaStatus();
  if (typeof menuShowSnovStatus === 'function') menuShowSnovStatus();
  Logger.log('');
  Logger.log('── Config + tracking ──');
  if (typeof menuShowTrackingWebappBase === 'function') menuShowTrackingWebappBase();
  Logger.log('');
  Logger.log('── Resource health ──');
  if (typeof menuShowSheetCellUsage === 'function') {
    Logger.log('  (running menuShowSheetCellUsage — see lines below)');
    menuShowSheetCellUsage();
  }
  var totalProps = Object.keys(PropertiesService.getScriptProperties().getProperties()).length;
  Logger.log('  Total ScriptProperties: ' + totalProps);
  Logger.log('');
  Logger.log('── Tier-3 outage drafts ──');
  if (typeof menuListTier3Drafts === 'function') menuListTier3Drafts();
}

/**
 * PATCH `-p5-phase4-prelude` (vendor-cache TTL cleanup): purge stale entries
 * across every cache-prefix the pipeline writes to ScriptProperties.
 *
 * Why this exists: live diagnosis on 2026-06-09 showed 1,228 ScriptProperties
 * — 1,178 of them vendor caches:
 *   - REOON_VERIFY: 183 (30-day TTL for stable / 6h for transient)
 *   - APOLLO_MATCH: 151 (per-LinkedIn-URL match results)
 *   - APOLLO_ORGS: 85 (per-company-slug org search results)
 *   - API_CALLS: 94 (daily counters since April 2026 — months stale)
 *   - SNOV_PRESENCE: 55
 *   - HUNTER_PATTERN: 53
 *   - GEMINI_EMAIL: 26
 *   - GHCOMMIT_PATTERN: 26
 *   - DMARC, CB_, DDG_, GH_, MULTI_: ~100 per prefix (per-company)
 *
 * None of the original code paths purge these — they accumulate forever.
 * The 50-property UI limit becomes unmanageable.
 *
 * This helper purges entries older than the prefix's natural TTL:
 *   - REOON_VERIFY, APOLLO_MATCH, APOLLO_ORGS, SNOV_PRESENCE,
 *     HUNTER_PATTERN, GEMINI_EMAIL, GHCOMMIT_PATTERN, DMARC: 30 days
 *   - CB_, GH_, MULTI_: 7 days (per cache config in EnrichmentSources)
 *   - DDG_: 1 day
 *   - API_CALLS_*_<date>: keep last 30 days only
 *
 * The value parsing handles both shapes encountered in live data:
 *   - {ts: 1779...} (epoch ms inside the object — most caches)
 *   - {"ts": 1779...} as JSON (parse first)
 *   - API_CALLS_*_2026-04-04 (date in key)
 *
 * Bounded to MAX_DELETIONS_PER_RUN per run to stay inside the 6-min budget.
 *
 * LEGACY-ONLY since 2026-06-12-cacheservice-migration: live vendor caches
 * moved to CacheService (EnrichmentSources _vendorCacheGet/_vendorCachePut),
 * so ScriptProperties entries under these prefixes are pre-migration residue
 * that no longer refills. Run this to drain what remains; once it reports 0
 * deletions with a low remaining count, the store should stay flat.
 */
function menuPurgeStaleVendorCaches() {
  var MAX_DELETIONS_PER_RUN = 800;
  var DAY_MS = 24 * 60 * 60 * 1000;
  var nowMs = Date.now();

  // Prefix → TTL in days. Order matters only for logging.
  // PATCH 2026-06-12-readiness-fixes: added the 5 families that were migrated to
  // CacheService but omitted from both purge tools, leaving legacy ScriptProperties
  // residue permanently unclearable: HUNTER_FIND_, SNOV_EF_, FINDYMAIL_,
  // DISPOSABLE_LIST_V1, MX_
  var TTL_DAYS = {
    'REOON_VERIFY_':     30,
    'APOLLO_MATCH_':     30,
    'APOLLO_ORGS_':      30,
    'SNOV_PRESENCE_':    30,
    'HUNTER_PATTERN_':   30,
    'HUNTER_FIND_':      60,
    'GEMINI_EMAIL_':     30,
    'GHCOMMIT_PATTERN_': 30,
    'DMARC_':            30,
    'SNOV_EF_':          30,
    'FINDYMAIL_':        30,
    'DISPOSABLE_LIST_V1': 7,
    'MX_':               30,
    'CB_':                7,
    'GH_':                7,
    'MULTI_':             7,
    'DDG_':               1,
    'PSV_HV_':           30
  };

  var props = PropertiesService.getScriptProperties();
  var all;
  try { all = props.getProperties(); }
  catch (e) {
    Logger.log('[PurgeStaleCaches] getProperties failed: ' + e.message);
    return null;
  }

  var deleted = {};
  var totalDeleted = 0;
  var keys = Object.keys(all);

  // ── First pass: prefix-keyed caches with `ts` in value ──
  for (var i = 0; i < keys.length; i++) {
    if (totalDeleted >= MAX_DELETIONS_PER_RUN) break;
    var k = keys[i];
    // Find which prefix applies
    var prefix = null;
    for (var p in TTL_DAYS) {
      if (k.indexOf(p) === 0) { prefix = p; break; }
    }
    if (!prefix) continue;

    var ttlMs = TTL_DAYS[prefix] * DAY_MS;
    var ts = null;
    var raw = all[k];
    if (typeof raw === 'string' && raw.length > 0) {
      try {
        var parsed = JSON.parse(raw);
        // Caches store ts at top-level OR nested (e.g. {result:..., ts:...})
        ts = parsed.ts || (parsed.data && parsed.data.ts) || (parsed.result && parsed.result.ts);
      } catch (_) { /* not JSON or no ts */ }
    }
    if (typeof ts !== 'number' || ts <= 0) continue;  // can't determine age, leave alone
    if ((nowMs - ts) > ttlMs) {
      try {
        props.deleteProperty(k);
        deleted[prefix] = (deleted[prefix] || 0) + 1;
        totalDeleted++;
      } catch (_) {}
    }
  }

  // ── Second pass: API_CALLS_<service>_<YYYY-MM-DD> daily counters ──
  // Keep last 30 days; delete older.
  for (var j = 0; j < keys.length; j++) {
    if (totalDeleted >= MAX_DELETIONS_PER_RUN) break;
    var key = keys[j];
    if (key.indexOf('API_CALLS_') !== 0) continue;
    // Extract YYYY-MM-DD from suffix (after last underscore)
    var parts = key.split('_');
    var dateStr = parts[parts.length - 1];
    var dateMs = Date.parse(dateStr);
    if (isNaN(dateMs)) continue;
    if ((nowMs - dateMs) > 30 * DAY_MS) {
      try {
        props.deleteProperty(key);
        deleted['API_CALLS_'] = (deleted['API_CALLS_'] || 0) + 1;
        totalDeleted++;
      } catch (_) {}
    }
  }

  var remaining = Object.keys(props.getProperties()).length;
  Logger.log('[PurgeStaleCaches] Total deleted: ' + totalDeleted +
             ' (bounded at ' + MAX_DELETIONS_PER_RUN + '/run)');
  Object.keys(deleted).sort().forEach(function(p) {
    Logger.log('  ' + p + ': ' + deleted[p]);
  });
  Logger.log('[PurgeStaleCaches] Properties remaining: ' + remaining +
             (remaining <= 50 ? ' — UI is now writable ✓' : ' — still above 50, run again if needed'));
  Logger.log('[PurgeStaleCaches] Vendor caches are CacheService-backed since ' +
             '2026-06-12-cacheservice-migration; property entries here are legacy residue.');
  return {
    totalDeleted: totalDeleted, deleted: deleted, remaining: remaining,
    propertiesAreLegacyOnly: true,
    note: 'Live vendor caches moved to CacheService at 2026-06-12-cacheservice-migration; ' +
          'ScriptProperties entries under these prefixes are pre-migration residue and no longer refill.'
  };
}

/**
 * PATCH `-p5-phase4-prelude`: manual override setter for TRACKING_WEBAPP_BASE
 * when ScriptApp.getService().getUrl() returns the wrong URL (e.g. /dev when
 * called from the editor instead of /exec when called from the production
 * Web App deployment).
 *
 * Live diagnosis on 2026-06-09: menuSetTrackingWebappBaseFromDeployment
 * captured https://.../AKfycbzbSF7v75Vg1OJFPj4w1LMPGRElkpqg-EW4FY70Opg/dev
 * — the editor's dev URL, not the user's published /exec URL.
 *
 * USAGE: edit the line marked "EDIT THIS" with your /exec URL, then run.
 */
function menuSetTrackingWebappBaseManually() {
  // ─────────── EDIT THIS LINE — paste your /exec URL ───────────
  var url = 'PASTE_YOUR_EXEC_URL_HERE';
  // ────────────────────────────────────────────────────────────

  if (url === 'PASTE_YOUR_EXEC_URL_HERE' || !url) {
    Logger.log('[TrackingWebappBase/manual] Edit the function source: open GmailDrafter.gs, find menuSetTrackingWebappBaseManually, replace the URL placeholder with your /exec URL, save, run.');
    Logger.log('[TrackingWebappBase/manual] Easier alternative: call the URL endpoint instead:');
    Logger.log('[TrackingWebappBase/manual]   https://script.google.com/macros/s/<YOUR_ID>/exec?action=set_tracking_base&token=<ADMIN>');
    return;
  }
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^\/]+\/exec(\?|$)/.test(url)) {
    Logger.log('[TrackingWebappBase/manual] WARN: URL must be a /exec Web App URL (not /dev). Got: ' + url);
    Logger.log('[TrackingWebappBase/manual] Aborting; fix the URL and run again.');
    return;
  }
  PropertiesService.getScriptProperties().setProperty('TRACKING_WEBAPP_BASE', url);
  Logger.log('[TrackingWebappBase/manual] SET TRACKING_WEBAPP_BASE = ' + url);
}

/**
 * PATCH `-postsprint-batch1` (P5): aggressive purge that ignores TTLs and
 * just keeps the MOST RECENT N entries per cache prefix. Use when the
 * standard TTL-based purge isn't enough (e.g., user has hundreds of fresh
 * caches that just happen to be slowly accumulating).
 *
 * Strategy: for each tracked prefix, parse the `ts` timestamp from each
 * entry's JSON value, sort newest-first, delete everything beyond the
 * keepPerPrefix index.
 *
 * LEGACY-ONLY since 2026-06-12-cacheservice-migration: live vendor caches
 * moved to CacheService, so keepPerPrefix no longer sacrifices warm cache —
 * property entries under these prefixes are pre-migration residue. Safe to
 * run with keepPerPrefix=0 once post-migration enrichment has been verified.
 *
 * @param {number} [keepPerPrefix=20] - retain this many newest entries per prefix
 * @returns {Object} - { totalDeleted, perPrefix, remaining, propertiesAreLegacyOnly, note }
 */
function menuPurgeAggressive(keepPerPrefix) {
  keepPerPrefix = (typeof keepPerPrefix === 'number' && keepPerPrefix >= 0) ? keepPerPrefix : 20;

  // PATCH 2026-06-12-readiness-fixes: added HUNTER_FIND_, SNOV_EF_, FINDYMAIL_,
  // DISPOSABLE_LIST_V1, MX_ — migrated families absent from the original list.
  var PREFIXES = [
    'REOON_VERIFY_', 'APOLLO_MATCH_', 'APOLLO_ORGS_', 'SNOV_PRESENCE_',
    'HUNTER_PATTERN_', 'HUNTER_FIND_', 'GEMINI_EMAIL_', 'GHCOMMIT_PATTERN_', 'DMARC_',
    'SNOV_EF_', 'FINDYMAIL_', 'DISPOSABLE_LIST_V1', 'MX_',
    'CB_', 'GH_', 'MULTI_', 'DDG_', 'PSV_HV_'
  ];

  var props = PropertiesService.getScriptProperties();
  var all;
  try { all = props.getProperties(); }
  catch (e) { Logger.log('[PurgeAggressive] getProperties failed: ' + e.message); return null; }

  var perPrefix = {};
  var totalDeleted = 0;

  PREFIXES.forEach(function(prefix) {
    // Collect all keys for this prefix with their timestamps
    var entries = [];
    for (var k in all) {
      if (k.indexOf(prefix) !== 0) continue;
      var ts = 0;
      try {
        var parsed = JSON.parse(all[k]);
        ts = parsed.ts || (parsed.data && parsed.data.ts) || (parsed.result && parsed.result.ts) || 0;
      } catch (_) {}
      entries.push({ key: k, ts: ts });
    }
    if (entries.length <= keepPerPrefix) {
      perPrefix[prefix] = { had: entries.length, kept: entries.length, deleted: 0 };
      return;
    }
    // Sort newest-first; delete everything beyond keepPerPrefix
    entries.sort(function(a, b) { return b.ts - a.ts; });
    var toDelete = entries.slice(keepPerPrefix);
    var deleted = 0;
    toDelete.forEach(function(e) {
      try { props.deleteProperty(e.key); deleted++; totalDeleted++; } catch (_) {}
    });
    perPrefix[prefix] = { had: entries.length, kept: keepPerPrefix, deleted: deleted };
  });

  var remaining = Object.keys(props.getProperties()).length;
  Logger.log('[PurgeAggressive] Total deleted: ' + totalDeleted + ' (keepPerPrefix=' + keepPerPrefix + ')');
  Object.keys(perPrefix).forEach(function(p) {
    var r = perPrefix[p];
    if (r.deleted > 0) {
      Logger.log('  ' + p + ': had=' + r.had + ' kept=' + r.kept + ' deleted=' + r.deleted);
    }
  });
  Logger.log('[PurgeAggressive] Properties remaining: ' + remaining);
  Logger.log('[PurgeAggressive] Vendor caches are CacheService-backed since ' +
             '2026-06-12-cacheservice-migration; property entries here are legacy residue.');
  return {
    totalDeleted: totalDeleted, perPrefix: perPrefix, remaining: remaining,
    propertiesAreLegacyOnly: true,
    note: 'Live vendor caches moved to CacheService at 2026-06-12-cacheservice-migration; ' +
          'ScriptProperties entries under these prefixes are pre-migration residue and no longer refill.'
  };
}

/**
 * PATCH `-p5-vendorresilience-config-amend`: bulk-delete stale
 * AUTO_PROCESSED_ROW_* and AUTO_EDIT_ROW_* properties. Same logic as
 * PipelineWatchdog Job 6 (_wdCleanupStaleProperties), but invokable on
 * demand so the user can drop below 50 properties immediately without
 * waiting for the watchdog cron.
 *
 * Deletes any key where: prefix matches AND value's epoch-ms timestamp is
 * more than 24h old. Safe to invoke repeatedly.
 */
function menuCleanStaleAutoProcessedProperties() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var DAY_MS = 24 * 60 * 60 * 1000;
  var HOUR_MS = 60 * 60 * 1000;
  var now = Date.now();
  var counts = { auto_processed_row: 0, auto_edit_row: 0, enrich_depth: 0, skipped: 0 };

  Object.keys(all).forEach(function(k) {
    if (k.indexOf('AUTO_PROCESSED_ROW_') === 0) {
      var ts = parseInt(all[k], 10);
      if (!isNaN(ts) && (now - ts) > DAY_MS) {
        try { props.deleteProperty(k); counts.auto_processed_row++; } catch (_) { counts.skipped++; }
      }
    } else if (k.indexOf('AUTO_EDIT_ROW_') === 0) {
      var ts2 = parseInt(all[k], 10);
      if (!isNaN(ts2) && (now - ts2) > DAY_MS) {
        try { props.deleteProperty(k); counts.auto_edit_row++; } catch (_) { counts.skipped++; }
      }
    } else if (k.indexOf('ENRICH_DEPTH_') === 0) {
      // ENRICH_DEPTH keys encode minuteEpoch in their key suffix; stale by ~1h
      var parts = k.split('_');
      var minuteEpoch = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(minuteEpoch)) {
        var keyMs = minuteEpoch * 60 * 1000;
        if ((now - keyMs) > HOUR_MS) {
          try { props.deleteProperty(k); counts.enrich_depth++; } catch (_) { counts.skipped++; }
        }
      }
    }
  });

  var totalDeleted = counts.auto_processed_row + counts.auto_edit_row + counts.enrich_depth;
  var remaining = Object.keys(props.getProperties()).length;
  Logger.log('[ScriptProperties] Bulk cleanup: deleted ' + totalDeleted +
             ' (auto_processed_row=' + counts.auto_processed_row +
             ', auto_edit_row=' + counts.auto_edit_row +
             ', enrich_depth=' + counts.enrich_depth +
             ', skipped=' + counts.skipped + ')');
  Logger.log('[ScriptProperties] Properties remaining: ' + remaining +
             (remaining <= 50 ? ' — UI is now writable ✓' : ' — still above 50, UI remains read-only'));
  return { deleted: totalDeleted, counts: counts, remaining: remaining };
}

/**
 * PATCH `-p5-vendorresilience-config-amend`: edit-then-run helper to set
 * ANY script property programmatically. Used to set new properties when
 * the UI is locked at >50 props.
 *
 * USAGE:
 *   1. In Apps Script editor, open GmailDrafter.gs
 *   2. Find this function's body
 *   3. Edit the two lines marked "EDIT THIS"
 *   4. Save (Ctrl+S), then Run
 *   5. Revert your edit (or leave as-is — it's a no-op until you re-run)
 */
function menuSetScriptProperty() {
  // ─────────── EDIT THIS LINE ───────────
  var key = 'YOUR_PROPERTY_NAME_HERE';
  // ─────────── EDIT THIS LINE ───────────
  var value = 'YOUR_VALUE_HERE';

  if (key === 'YOUR_PROPERTY_NAME_HERE' || value === 'YOUR_VALUE_HERE') {
    Logger.log('[ScriptProperties] menuSetScriptProperty is a template — edit the function source first.');
    Logger.log('[ScriptProperties] Open GmailDrafter.gs → find menuSetScriptProperty → replace the two EDIT THIS lines with the real key/value → save → run.');
    return;
  }

  var props = PropertiesService.getScriptProperties();
  var was = props.getProperty(key);
  props.setProperty(key, value);
  Logger.log('[ScriptProperties] SET "' + key + '" = "' + value.substring(0, 80) +
             (value.length > 80 ? '...' : '') + '"' +
             (was === null ? ' (NEW)' : ' (was: "' + was.substring(0, 80) + '")'));
}

/**
 * PATCH `-p5-vendorresilience-config` (Phase 3c): TRACKING_WEBAPP_BASE
 * diagnostic. Reads the current value and tells the user what to set if
 * it's missing — closes the "Tracking injection failed (continuing without):
 * TRACKING_WEBAPP_BASE not set" warning visible in every draft creation.
 *
 * The value should be the same /exec URL the user calls for stamp_check /
 * run_all_tests. Tracking-pixel and redirect links in outgoing emails go
 * through this URL.
 */
function menuShowTrackingWebappBase() {
  var props = PropertiesService.getScriptProperties();
  var cur = props.getProperty('TRACKING_WEBAPP_BASE');
  if (cur) {
    Logger.log('[TrackingWebappBase] CONFIGURED — current value: ' + cur);
    Logger.log('[TrackingWebappBase] Tracking pixels + click redirects will route through this URL.');
  } else {
    Logger.log('[TrackingWebappBase] NOT SET — emails are being sent without tracking pixels or click redirects.');
    Logger.log('[TrackingWebappBase] To enable tracking:');
    Logger.log('[TrackingWebappBase]   1. Open https://script.google.com/home → AutoMail');
    Logger.log('[TrackingWebappBase]   2. Project Settings → Script Properties');
    Logger.log('[TrackingWebappBase]   3. Add property name "TRACKING_WEBAPP_BASE"');
    Logger.log('[TrackingWebappBase]   4. Value: your active Web App /exec URL (the same one you use for stamp_check)');
    Logger.log('[TrackingWebappBase]   5. Save → drafts created from now on will include tracking');
  }
  return { configured: !!cur, value: cur || null };
}

/**
 * PATCH `-p5-vendorresilience-reoon` (Phase 2d): Logger-loud diagnostic
 * for the Reoon HARD-TRIP circuit breaker. Mirrors the Gemini / Gmail
 * variants. Returns the same shape as `_reoonQuotaCheck()`.
 */
function menuShowReoonQuotaStatus() {
  if (typeof _reoonQuotaCheck !== 'function') {
    Logger.log('[ReoonQuota] _reoonQuotaCheck not in scope — EmailEnricher.gs not deployed?');
    return null;
  }
  var st = _reoonQuotaCheck();
  if (st.exhausted) {
    Logger.log('[ReoonQuota] EXHAUSTED for ' + st.date +
               ' — verifyEmailDeliverable calls will skip until UTC midnight. ' +
               'Stored reason: ' + (st.value || '').substring(0, 120));
  } else {
    Logger.log('[ReoonQuota] clear — date=' + st.date + '. Reoon calls will proceed normally.');
  }
  return st;
}

/**
 * PATCH `-p5-vendorresilience-reoon` (Phase 2d): manual override to clear
 * the Reoon quota flag. Use if you topped up Reoon credits mid-day and
 * want to retry before UTC midnight reset.
 */
function menuClearReoonQuotaFlag() {
  var props = PropertiesService.getScriptProperties();
  // The flag is date-keyed in UTC (matches Reoon's quota window).
  // Re-compute the same key the setter uses, so callers don't need to know.
  if (typeof _reoonQuickQuotaUtcDateKey !== 'function') {
    Logger.log('[ReoonQuota] _reoonQuickQuotaUtcDateKey not in scope; cannot compute current key');
    return;
  }
  var key = 'REOON_QUOTA_EXHAUSTED_' + _reoonQuickQuotaUtcDateKey();
  var was = props.getProperty(key);
  if (was) {
    props.deleteProperty(key);
    Logger.log('[ReoonQuota] CLEARED ' + key + ' (was: ' + was.substring(0, 80) + ')');
  } else {
    Logger.log('[ReoonQuota] ' + key + ' was not set; nothing to clear');
  }
}

/**
 * PATCH `-p5-vendorresilience-gemini` (Phase 2c): Logger-loud diagnostic
 * for the Gemini circuit breaker. Run from the Apps Script editor to see
 * whether Gemini is currently in a backoff window.
 *
 * Returns the same shape as `_geminiBackoffCheck()` so it composes cleanly.
 */
function menuShowGeminiBackoffStatus() {
  if (typeof _geminiBackoffCheck !== 'function') {
    Logger.log('[GeminiBackoff] _geminiBackoffCheck not in scope — ApiClients.gs not deployed?');
    return null;
  }
  var st = _geminiBackoffCheck();
  if (st.active) {
    Logger.log('[GeminiBackoff] ACTIVE — backoff remaining ' + st.remainingMs +
               'ms (until ' + st.untilISO + '). ' +
               'New leads will be parked at PENDING_GEMINI_BACKOFF; zero token spend.');
  } else {
    Logger.log('[GeminiBackoff] clear — no active backoff. Gemini calls will proceed normally.');
  }
  return st;
}

/**
 * PATCH `-p5-vendorresilience-gemini` (Phase 2c): manual override to clear
 * the Gemini backoff flag. Mirrors `menuClearGmailQuotaFlag`. Use only if
 * you're sure Gemini rate-limit has cleared (e.g. you waited > 60s and
 * tested a manual call).
 */
function menuClearGeminiBackoff() {
  var props = PropertiesService.getScriptProperties();
  var was = props.getProperty('GEMINI_429_BACKOFF_UNTIL_MS');
  if (was) {
    props.deleteProperty('GEMINI_429_BACKOFF_UNTIL_MS');
    Logger.log('[GeminiBackoff] CLEARED GEMINI_429_BACKOFF_UNTIL_MS (was: ' + was + ')');
  } else {
    Logger.log('[GeminiBackoff] GEMINI_429_BACKOFF_UNTIL_MS was not set; nothing to clear');
  }
}

function menuClearGmailQuotaFlag() {
  var props = PropertiesService.getScriptProperties();
  // PATCH 2026-06-13-quota-tz-align: use _ptDateKey() — matches the same PT-keyed
  // flag that _checkDailyDraftLimit reads; clears the correct key regardless of
  // whether the user runs this in the IST-afternoon/evening cross-day window.
  var today = _ptDateKey();
  var key = 'GMAIL_QUOTA_EXHAUSTED_' + today;
  var was = props.getProperty(key);
  if (was) {
    props.deleteProperty(key);
    Logger.log('[GmailQuotaFlag] CLEARED ' + key + ' (was: ' + was.substring(0, 80) + ')');
  } else {
    Logger.log('[GmailQuotaFlag] ' + key + ' was not set; nothing to clear');
  }
}

/**
 * PATCH `-p5-composer-preflight-amend` (Phase 2b amend-4): identify which
 * sheet tab is consuming the most cells, so the user can locate what to
 * archive when they hit the 10M workbook cell limit.
 *
 * Why this exists: live diagnosis on 2026-06-09 showed dozens of
 * `Log write failed: This action would increase the number of cells in
 * the workbook above the limit of 10000000 cells.` in the Executions
 * log. Without knowing WHICH sheet is bloated, the user can't fix it.
 *
 * Sums (last_row × last_column) for every sheet tab in CONFIG.SHEET_ID.
 * Sorts descending so the worst offender is at the top. Reports the
 * total + the per-tab breakdown to Logger.log.
 *
 * The 10M cell limit is a Google Sheets HARD LIMIT — once hit, no new
 * cells can be added (only updates to existing cells work). Common
 * culprits in this codebase: PipelineLog (append-only), tracking-link
 * audit sheets, FollowUp persistence.
 *
 * Recovery options after running this:
 *   1. Identify the largest tab
 *   2. Either archive it (copy → new spreadsheet → delete from this one)
 *      or truncate old rows (Edit → Delete rows)
 *   3. Re-run this helper to confirm cells dropped below 10M
 */
/**
 * PATCH `-p5-pipelinelog-trim` (Phase 2b amend2-2) + `-p5-pipelinelog-trim-amend`
 * (Phase 2b amend3-1): trim PipelineLog by date AND by row count AND by column
 * count, whichever produces a tighter bound.
 *
 * Live diagnosis on 2026-06-09:
 *   - INITIAL state: 370,157 rows × 26 physical cols (9.6M cells, 96% of 10M limit)
 *   - AFTER trim(30, 1000): 357,175 rows × 26 cols (9.3M cells, 93% of limit)
 *     — 30-day window was too generous; only ~13K rows older than 30 days
 *   - Schema is 6 columns (Timestamp, RunID, Row, Stage, Level, Message)
 *     but physical is 26 cols. 20 wasted cols × 357K rows = 7.14M reclaimable
 *     cells from column trim ALONE.
 *
 * Amend3 (current revision) tightens the strategy:
 *   1. Trim rows by date (keepDays, default 7) — drop older entries
 *   2. Trim rows by absolute count (maxRows, default 50000) — keeps the
 *      sheet bounded even if 7 days produces > 50K entries
 *   3. Trim physical row count back to (dataAfter + safetyMargin) so
 *      future appends don't re-grow toward the limit
 *   4. Trim wasted columns down to data-used count (typically 6, but
 *      auto-detected) so the 26-col Apps Script default doesn't waste
 *      ~77% of every row's cell budget. The header row is the source
 *      of truth for "how many cols actually carry data"
 *
 * Designed to be safe to invoke repeatedly. If the sheet is already
 * within bounds, this is effectively a no-op.
 *
 * Trim sizing rule of thumb (at 12K log rows/day rate observed live):
 *   - keepDays=7,  maxRows=50000 → ~50K rows × 6 cols = 300K cells (3% of limit)
 *   - keepDays=30, maxRows=50000 → still capped at 50K rows = 300K cells
 *   - keepDays=3,  maxRows=50000 → 36K rows × 6 cols = 216K cells
 *
 * @param {number} [keepDays=7] - retain rows newer than this many days
 *   (amend3: tightened from 30 → 7 to match live log volume)
 * @param {number} [safetyMargin=1000] - empty rows reserved past data tail
 * @param {number} [maxRows=50000] - hard upper bound on data row count;
 *   when keepDays would keep more than this, the oldest rows beyond
 *   `maxRows` get dropped too. Set to 0 to disable the row cap.
 * @param {boolean} [trimColumns=true] - shrink physical column count to
 *   match data-used columns. Default true; pass false if you want to
 *   leave room for future schema changes.
 * @returns {Object} - { dataRowsBefore, dataRowsAfter, physicalRowsBefore,
 *   physicalRowsAfter, colsBefore, colsAfter, cellsReclaimed, cutoffISO }
 */
function menuTrimPipelineLog(keepDays, safetyMargin, maxRows, trimColumns) {
  keepDays = (typeof keepDays === 'number' && keepDays > 0) ? keepDays : 7;
  safetyMargin = (typeof safetyMargin === 'number' && safetyMargin > 0) ? safetyMargin : 1000;
  maxRows = (typeof maxRows === 'number' && maxRows >= 0) ? maxRows : 50000;
  trimColumns = (trimColumns === false) ? false : true;

  var ssId = (typeof CONFIG !== 'undefined' && CONFIG.SHEET_ID) ? CONFIG.SHEET_ID : null;
  var sheetName = (typeof CONFIG !== 'undefined' && CONFIG.LOG_SHEET) ? CONFIG.LOG_SHEET : 'PipelineLog';
  if (!ssId) {
    Logger.log('[TrimPipelineLog] CONFIG.SHEET_ID not set; aborting');
    return null;
  }

  var ss;
  try { ss = SpreadsheetApp.openById(ssId); }
  catch (e) {
    Logger.log('[TrimPipelineLog] openById failed: ' + e.message);
    return null;
  }

  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    Logger.log('[TrimPipelineLog] Sheet "' + sheetName + '" not found; nothing to trim');
    return null;
  }

  var physicalRowsBefore = sheet.getMaxRows();
  var dataRowsBefore = sheet.getLastRow();
  var physicalCols = sheet.getMaxColumns();

  // Cutoff timestamp (ISO format matches what logPipelineEvent writes)
  var cutoffMs = Date.now() - (keepDays * 24 * 60 * 60 * 1000);
  var cutoffISO = new Date(cutoffMs).toISOString();

  Logger.log('[TrimPipelineLog] Starting: ' + sheetName + ' has ' + dataRowsBefore +
             ' data rows / ' + physicalRowsBefore + ' physical rows × ' + physicalCols +
             ' cols. Keeping rows newer than ' + cutoffISO + ' (last ' + keepDays + ' days)');

  if (dataRowsBefore <= 1) {
    Logger.log('[TrimPipelineLog] Header-only or empty; nothing to trim');
    return { dataRowsBefore: dataRowsBefore, dataRowsAfter: dataRowsBefore,
             physicalRowsBefore: physicalRowsBefore, physicalRowsAfter: physicalRowsBefore,
             cellsReclaimed: 0, cutoffISO: cutoffISO };
  }

  // ── Step 1: find the first data row whose Timestamp is >= cutoff ──
  //
  // Rows are written in chronological order (appendRow), so we can read
  // column 1 of every data row once and find the boundary. For 370K rows
  // this is ~3-5 MB transfer; tolerable inside the 6-minute budget. We
  // read in one shot rather than per-row to minimize round-trips.
  var timestamps = sheet.getRange(2, 1, dataRowsBefore - 1, 1).getValues();
  var firstKeepRowOffset = -1;  // 0-indexed within the data range
  for (var i = 0; i < timestamps.length; i++) {
    var tsRaw = timestamps[i][0];
    var tsMs;
    if (tsRaw instanceof Date) {
      tsMs = tsRaw.getTime();
    } else {
      // ISO string from logPipelineEvent — Date.parse handles both formats
      tsMs = Date.parse(String(tsRaw));
    }
    if (!isNaN(tsMs) && tsMs >= cutoffMs) {
      firstKeepRowOffset = i;
      break;
    }
  }

  var dataRowsDeleted = 0;
  if (firstKeepRowOffset === -1) {
    // No rows are within the keep window — delete all data rows
    if (dataRowsBefore > 1) {
      sheet.deleteRows(2, dataRowsBefore - 1);
      dataRowsDeleted = dataRowsBefore - 1;
    }
  } else if (firstKeepRowOffset > 0) {
    // Delete rows 2 through (1 + firstKeepRowOffset) — that's firstKeepRowOffset rows
    sheet.deleteRows(2, firstKeepRowOffset);
    dataRowsDeleted = firstKeepRowOffset;
  } else {
    // All data is within the keep window; no data rows deleted
    dataRowsDeleted = 0;
  }

  // ── Step 1b: enforce maxRows cap (PATCH amend3) ──
  //
  // Even after date-based trim, the keep-window may still contain more rows
  // than we want (e.g., 12K rows/day × 7 days = 84K, above default 50K cap).
  // Drop oldest rows beyond `maxRows` so the sheet is never bigger than the
  // explicit upper bound. Data is chronologically ordered (appendRow), so
  // the "oldest beyond cap" are simply rows 2 through (lastRow - maxRows).
  var dataRowsAfterDateTrim = sheet.getLastRow();
  var dataRowsForMax = Math.max(0, dataRowsAfterDateTrim - 1);  // exclude header
  var rowsDeletedByMaxRowsCap = 0;
  if (maxRows > 0 && dataRowsForMax > maxRows) {
    var excessRows = dataRowsForMax - maxRows;
    // Delete rows 2 through (1 + excessRows) — the oldest entries
    sheet.deleteRows(2, excessRows);
    rowsDeletedByMaxRowsCap = excessRows;
    dataRowsDeleted += excessRows;
    Logger.log('[TrimPipelineLog] maxRows cap (' + maxRows + ') dropped ' + excessRows +
               ' additional oldest rows beyond the date-trim window');
  }

  // ── Step 2: shrink physical row count ──
  //
  // After deleteRows, the physical row count drops by the deleted amount.
  // But if the original sheet had bloat from past appendRow-then-cleared
  // operations, we may still have a huge tail of empty physical rows.
  // Trim back to (dataRowsAfter + safetyMargin) so the next ~1000 appendRow
  // calls don't trigger a grow.
  var dataRowsAfter = sheet.getLastRow();
  var physicalRowsAfterDataTrim = sheet.getMaxRows();
  var targetPhysical = dataRowsAfter + safetyMargin;
  var physicalRowsToReclaim = physicalRowsAfterDataTrim - targetPhysical;
  if (physicalRowsToReclaim > 0) {
    sheet.deleteRows(targetPhysical + 1, physicalRowsToReclaim);
  }
  var physicalRowsAfter = sheet.getMaxRows();

  // ── Step 3: shrink physical column count (PATCH amend3) ──
  //
  // The Apps Script default for insertSheet is 1000 rows × 26 cols. PipelineLog
  // only uses 6 cols (Timestamp, RunID, Row, Stage, Level, Message — written
  // by logPipelineEvent in SheetReader.gs). 20 wasted cols × 357K rows = 7.14M
  // dead cells per the live diagnosis. Column-trim is the single biggest
  // reclaim available for sheets with append-only narrow schemas.
  //
  // We detect "used columns" from the header row's getLastColumn() rather
  // than hardcoding 6, so a future schema extension (e.g. adding a 7th col)
  // doesn't get wiped. Pass trimColumns=false to skip this if you want
  // reserved width.
  var colsBefore = physicalCols;
  var colsAfter = colsBefore;
  if (trimColumns) {
    var usedCols = sheet.getLastColumn();
    if (usedCols > 0 && colsBefore > usedCols) {
      var excessCols = colsBefore - usedCols;
      sheet.deleteColumns(usedCols + 1, excessCols);
      colsAfter = sheet.getMaxColumns();
      Logger.log('[TrimPipelineLog] Column trim: dropped ' + excessCols +
                 ' unused columns (was ' + colsBefore + ', now ' + colsAfter + ')');
    }
  }

  // Cells reclaimed: account for BOTH rows and column shrinkage
  var cellsBefore = physicalRowsBefore * colsBefore;
  var cellsAfter = physicalRowsAfter * colsAfter;
  var cellsReclaimed = cellsBefore - cellsAfter;

  Logger.log('[TrimPipelineLog] Done: dataRowsDeleted=' + dataRowsDeleted +
             ' (by_date=' + (dataRowsDeleted - rowsDeletedByMaxRowsCap) +
             ', by_maxRows_cap=' + rowsDeletedByMaxRowsCap + ')' +
             ' physical=' + physicalRowsBefore + '×' + colsBefore +
             '→' + physicalRowsAfter + '×' + colsAfter +
             ' cellsReclaimed=' + cellsReclaimed +
             ' (' + Math.round((cellsReclaimed / 10000000) * 100) + '% of 10M limit)');

  return {
    sheetName: sheetName,
    cutoffISO: cutoffISO,
    keepDays: keepDays,
    maxRows: maxRows,
    safetyMargin: safetyMargin,
    trimColumns: trimColumns,
    dataRowsBefore: dataRowsBefore,
    dataRowsAfter: dataRowsAfter,
    dataRowsDeleted: dataRowsDeleted,
    rowsDeletedByMaxRowsCap: rowsDeletedByMaxRowsCap,
    physicalRowsBefore: physicalRowsBefore,
    physicalRowsAfter: physicalRowsAfter,
    colsBefore: colsBefore,
    colsAfter: colsAfter,
    cellsReclaimed: cellsReclaimed
  };
}

function menuShowSheetCellUsage() {
  var ssId = (typeof CONFIG !== 'undefined' && CONFIG.SHEET_ID) ? CONFIG.SHEET_ID : null;
  if (!ssId) {
    Logger.log('[SheetCellUsage] CONFIG.SHEET_ID not set; cannot inspect workbook');
    return null;
  }
  var ss;
  try { ss = SpreadsheetApp.openById(ssId); }
  catch (e) {
    Logger.log('[SheetCellUsage] openById failed: ' + e.message);
    return null;
  }

  var sheets = ss.getSheets();
  var report = [];
  var totalCells = 0;
  var HARD_LIMIT = 10000000;

  for (var i = 0; i < sheets.length; i++) {
    var sh = sheets[i];
    var rows = sh.getMaxRows();          // physical rows (includes empty trailing)
    var cols = sh.getMaxColumns();       // physical cols
    var cells = rows * cols;
    var lastRow = sh.getLastRow();       // rows with data
    var lastCol = sh.getLastColumn();    // cols with data
    var usedCells = lastRow * lastCol;
    totalCells += cells;
    report.push({
      name: sh.getName(),
      physical_rows: rows,
      physical_cols: cols,
      physical_cells: cells,
      used_rows: lastRow,
      used_cols: lastCol,
      used_cells: usedCells,
      reclaimable: cells - usedCells
    });
  }

  report.sort(function(a, b) { return b.physical_cells - a.physical_cells; });

  Logger.log('[SheetCellUsage] Workbook total physical cells: ' + totalCells +
             ' / ' + HARD_LIMIT + ' (' + Math.round((totalCells / HARD_LIMIT) * 100) + '% of hard limit)');
  Logger.log('[SheetCellUsage] Tabs sorted by physical cell consumption (largest first):');
  for (var j = 0; j < report.length; j++) {
    var r = report[j];
    Logger.log('  ' + (j + 1) + '. "' + r.name + '" — physical=' + r.physical_cells +
               ' (rows=' + r.physical_rows + '×cols=' + r.physical_cols + '), ' +
               'used=' + r.used_cells + ' (rows=' + r.used_rows + '×cols=' + r.used_cols + '), ' +
               'reclaimable_by_trimming=' + r.reclaimable);
  }
  if (totalCells > HARD_LIMIT * 0.9) {
    Logger.log('[SheetCellUsage] ⚠ Workbook is at >90% of the 10M cell limit. ' +
               'Archive or truncate the largest tabs above to restore write capacity.');
  }
  return { totalCells: totalCells, limit: HARD_LIMIT, tabs: report };
}

// ─── DRAFT RETRIEVAL HELPERS ───────────────────────────────

/**
 * Retrieves a draft by ID.
 * @param {string} draftId - Gmail draft ID
 * @returns {Object} Draft message object or null if not found
 */
function getDraftById(draftId) {
  // BONUS 2026-06-13-syncer-targeted: point lookup O(1) vs getDrafts() O(n).
  // GmailApp.getDraft(draftId) fetches only the named draft (no full-list scan).
  try {
    var d = GmailApp.getDraft(draftId);
    if (!d) return null;
    var msgs = d.getMessages ? d.getMessages() : (d.getMessage ? [d.getMessage()] : []);
    return (msgs && msgs.length > 0) ? msgs[0] : null;
  } catch (error) {
    Logger.log('[GmailDrafter] Error retrieving draft: ' + error.toString());
    return null;
  }
}

/**
 * Gets all current draft count.
 * @returns {number} Number of drafts in the account
 */
function getTotalDraftCount() {
  try {
    return GmailApp.getDrafts().length;
  } catch (error) {
    Logger.log('[GmailDrafter] Error getting draft count: ' + error.toString());
    return 0;
  }
}

/**
 * Lists drafts for a specific recipient.
 * @param {string} email - Recipient email address
 * @returns {Array} Array of draft objects for that recipient
 */
function getDraftsForRecipient(email) {
  var cleanEmail = email.trim().toLowerCase();
  try {
    var drafts = GmailApp.getDrafts();
    var results = [];

    for (var i = 0; i < drafts.length; i++) {
      var messages = drafts[i].getMessages();
      if (messages.length > 0) {
        var msg = messages[0];
        if (msg.getTo && msg.getTo().indexOf(cleanEmail) !== -1) {
          results.push({
            draftId: msg.getId(),
            to: msg.getTo(),
            subject: msg.getSubject(),
            date: msg.getDate()
          });
        }
      }
    }

    return results;
  } catch (error) {
    Logger.log('[GmailDrafter] Error getting drafts for recipient: ' + error.toString());
    return [];
  }
}

/**
 * Sends a draft by ID.
 * @param {string} draftId - Draft ID to send
 * @returns {Object} { success: boolean, messageId: string, error: string }
 */
function sendDraft(draftId) {
  // BONUS 2026-06-13-syncer-targeted: point lookup O(1) via GmailApp.getDraft(draftId).
  try {
    var d = GmailApp.getDraft(draftId);
    if (!d) return { success: false, messageId: '', error: 'Draft not found: ' + draftId };
    var msgs = d.getMessages ? d.getMessages() : (d.getMessage ? [d.getMessage()] : []);
    var msgId = (msgs && msgs.length > 0 && msgs[0].getId) ? msgs[0].getId() : '';
    d.send();
    return { success: true, messageId: msgId, error: '' };
  } catch (error) {
    return { success: false, messageId: '', error: error.toString() };
  }
}

/**
 * Deletes a draft by ID.
 * @param {string} draftId - Draft ID to delete
 * @returns {Object} { success: boolean, error: string }
 */
function deleteDraft(draftId) {
  // BONUS 2026-06-13-syncer-targeted: point lookup O(1) via GmailApp.getDraft(draftId).
  // Move draft message to trash (GmailDraft has no direct delete method in GAS).
  try {
    var d = GmailApp.getDraft(draftId);
    if (!d) return { success: false, error: 'Draft not found: ' + draftId };
    var msgs = d.getMessages ? d.getMessages() : (d.getMessage ? [d.getMessage()] : []);
    if (msgs && msgs.length > 0 && msgs[0].moveToTrash) {
      msgs[0].moveToTrash();
    } else {
      return { success: false, error: 'Draft found but could not access message to trash: ' + draftId };
    }
    return { success: true, error: '' };
  } catch (error) {
    return { success: false, error: error.toString() };
  }
}

// ─── LOGGING HELPER ────────────────────────────────────────
// logPipelineEvent is defined in SheetReader.gs (canonical version with RunID support).

// ─── PIPELINE DRAFTS LISTING ─────────────────────────────

/**
 * Lists all leads with DRAFT_CREATED status for the Code.gs menu dashboard.
 * @returns {Array<Object>} Array of { fullName, email, subject, qualityScore, status }
 */
function listPipelineDrafts() {
  var sheet = _getDataSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  var drafts = [];

  data.forEach(function(row) {
    var status = (row[CONFIG.COLUMNS.STATUS - 1] || '').toString().trim();
    if (status === STATUS.DRAFT_CREATED || status === STATUS.REVIEW) {
      drafts.push({
        fullName: row[CONFIG.COLUMNS.FULL_NAME - 1] || '',
        email: row[CONFIG.COLUMNS.EMAIL - 1] || '',
        subject: row[CONFIG.COLUMNS.SUBJECT_LINE - 1] || '',
        qualityScore: row[CONFIG.COLUMNS.QUALITY_SCORE - 1] || 0,
        status: status
      });
    }
  });

  return drafts;
}

// ─── DELIVERABILITY V2: MIRRORED PLAIN-TEXT HELPER (T3) ──────────────────────
/**
 * Convert an HTML email body to a mirrored plain-text MIME part.
 * Purpose: avoid MPART_ALT_DIFF (SpamAssassin 2.2-2.8 pts) which fires when
 * the text/plain part is a stub/empty and the text/html part is rich.
 * A proper mirror scores ZERO on that rule.
 *
 * Algorithm:
 *   1. Strip <style>…</style> blocks entirely.
 *   2. Convert structural tags to line-break equivalents BEFORE stripping tags:
 *        <br>, </p>, </tr>  → newline
 *        <li> or bullet-glyph table rows → '- ' prefix
 *   3. Strip all remaining HTML tags.
 *   4. Decode common HTML entities (&amp; &bull; &nbsp; &#9888; etc.).
 *   5. Collapse blank lines > 2 consecutive.
 *   6. Exclude the tracking pixel reference (image tag already stripped;
 *      but strip any residual '?action=track_open' lines).
 *   7. Inline link URLs for the two CTAs as 'Text (URL)'.
 *
 * @param {string} html - Final HTML body (post tracking injection)
 * @returns {string} Plain-text mirror suitable as GmailApp.createDraft() body arg
 *
 * PATCH 2026-06-11-eq8-deliv-v2 (T3)
 */
function _htmlToMirrorText(html) {
  if (!html) return '';
  var text = html;

  // 1. Strip <style> and <script> blocks entirely
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');

  // 2a. Inline anchors as 'Label (URL)' — preserve link context before stripping
  // Only do this for http(s) links; mailto/tel anchors collapse to their text.
  // PATCH 2026-06-12-e2e-hardening: when the href is a script.google.com
  // redirect URL (action=track_click), output only the label — not the
  // redirect URL. Corporate spam filters (Mimecast, Proofpoint) scan plain-text
  // MIME parts and flag script.google.com redirect destinations as phishing
  // infrastructure. For tracking-rewritten links the plain-text reader does not
  // benefit from the redirect URL — they can't click it. Drop redirect URLs;
  // keep the human-readable label so plain-text is still intelligible.
  text = text.replace(/<a\b[^>]*\bhref\s*=\s*(["'])(https?:\/\/[^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi,
    function(match, q, url, label) {
      var cleanLabel = label.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      // Redirect URL: emit label only (no URL) so plain text doesn't contain
      // script.google.com/macros/s/.../exec?action=track_click&... destinations.
      if (url.indexOf('action=track_click') >= 0) return cleanLabel || '';
      if (!cleanLabel) return url;
      // Avoid duplicating URL when label IS the URL
      if (cleanLabel === url) return url;
      return cleanLabel + ' (' + url + ')';
    });

  // 2b. Block-level → newline
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n');
  text = text.replace(/<\/tr>/gi, '\n');
  text = text.replace(/<\/div>/gi, '\n');
  text = text.replace(/<\/h[1-6]>/gi, '\n');

  // 2c. List items → '- ' bullet
  text = text.replace(/<li\b[^>]*>/gi, '\n- ');

  // 3. Strip all remaining tags
  text = text.replace(/<[^>]+>/g, '');

  // 4. Decode HTML entities
  text = text
    .replace(/&amp;/gi, '&')
    .replace(/&bull;/gi, '•')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#9888;/gi, '⚠')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, function(_, n) {
      try { return String.fromCharCode(parseInt(n, 10)); } catch (_) { return ''; }
    });

  // 5. Strip tracking pixel lines (any line containing 'action=track_open')
  text = text.replace(/[^\n]*action=track_open[^\n]*/gi, '');

  // 6. Collapse excessive blank lines (max 2 consecutive)
  text = text.replace(/\n{3,}/g, '\n\n');

  // 7. Trim leading/trailing whitespace
  text = text.trim();

  return text;
}
