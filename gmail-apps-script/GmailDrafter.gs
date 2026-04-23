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
  // Validate inputs
  if (!lead || !lead.email || !subjectLine || !emailBody) {
    return {
      success: false,
      draftId: '',
      threadId: '',
      error: 'Missing required draft fields: lead, email, subject, or body'
    };
  }

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

  try {
    // ── Resolve resume attachment ──
    var attachments = [];
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
        Logger.log('[GmailDrafter] Resume attached: ' + resumeFileName + ' (Drive ID: ' + driveFileId + ')');
      } catch (driveErr) {
        Logger.log('[GmailDrafter] WARNING: Could not attach resume — ' + driveErr.toString());
        logPipelineEvent(lead.rowNum, 'DRAFT', 'Resume attachment failed: ' + driveErr.message + '. Draft created without attachment.', 'WARN');
      }
    } else {
      Logger.log('[GmailDrafter] No Drive ID found for key: ' + driveKey + '. Set it in Script Properties.');
      logPipelineEvent(lead.rowNum, 'DRAFT', 'No resume Drive ID for ' + driveKey + '. Set in Script Properties > Project Settings.', 'WARN');
    }

    // ── Resolve banner inline image ──
    var inlineImages = {};
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

    // ── Build draft options ──
    var draftOptions = {
      htmlBody: emailBody,
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

    // Create draft: GmailApp.createDraft(to, subject, plainTextFallback, options)
    // The empty string '' is the plain-text fallback; htmlBody in options takes precedence.
    var draft = GmailApp.createDraft(cleanEmail, subjectLine, '', draftOptions);

    // Small delay between drafts to avoid rate limiting
    var delay = CONFIG.MIN_DELAY_BETWEEN_DRAFTS_MS || 3000;
    if (delay > 0) {
      Utilities.sleep(delay);
    }

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

    // Log success
    var logMsg = 'Draft created' +
                 (attachments.length > 0 ? ' + resume (' + resumeFileName + ')' : '') +
                 (hasInlineImages ? ' + banner' : '') +
                 (threadId ? ' [thread=' + threadId.substring(0, 10) + '…]' : '') +
                 ' — Daily: ' + getDailyDraftStatus().count + '/' + getDailyDraftStatus().limit;
    logPipelineEvent(lead.rowNum, 'DRAFT', logMsg, 'SUCCESS');

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
 * Creates a threaded follow-up reply. Uses thread.createDraftReply()
 * whenever threadId is available — this is the canonical Apps Script
 * pattern that natively preserves In-Reply-To, References, and the
 * parent subject, so the draft lands in the SAME conversation in the
 * recipient's inbox (Gmail, Outlook, Fastmail alike).
 *
 * Fallback (no threadId): creates a new draft and prepends "Re:" — this
 * is ONLY hit when the initial draft was deleted before the follow-up
 * fires, which is an edge case. Still goes through the daily draft gate.
 *
 * @param {Object} lead         - Lead object (uses lead.email, lead.rowNum)
 * @param {string|number} stage - Follow-up stage number (1, 2, or 3)
 * @param {string} subjectLine  - Original subject (used only in fallback path)
 * @param {string} emailBody    - Follow-up body (HTML)
 * @param {string} [threadId]   - Gmail thread ID of the initial draft/send
 * @returns {Object} { success, draftId, threadId, error }
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

  try {
    var draft;
    var pathTaken;

    // ── Path A: thread exists → native threaded reply ──
    if (threadId) {
      var thread = null;
      try {
        thread = GmailApp.getThreadById(threadId);
      } catch (tErr) {
        Logger.log('[GmailDrafter] getThreadById(' + threadId + ') threw: ' + tErr.message);
      }

      if (thread) {
        // createDraftReply inherits the recipient + subject + In-Reply-To/References
        // headers from the thread's last message. We pass an empty first arg (plain
        // text fallback) and the HTML body in options — same pattern as createDraft.
        draft = thread.createDraftReply('', {
          htmlBody: emailBody,
          name: 'Gaurav Rathore'
        });
        pathTaken = 'threaded_reply';
      } else {
        Logger.log('[GmailDrafter] Thread ' + threadId + ' not found — falling back to standalone draft');
      }
    }

    // ── Path B: fallback to standalone "Re:" draft ──
    if (!draft) {
      var subjectWithRe = subjectLine ? ('Re: ' + subjectLine.replace(/^re:\s*/i, '')) : 'Re: Following up';
      draft = GmailApp.createDraft(cleanEmail, subjectWithRe, '', {
        htmlBody: emailBody,
        name: 'Gaurav Rathore'
      });
      pathTaken = 'standalone_fallback';
    }

    // Rate limit
    var delay = CONFIG.MIN_DELAY_BETWEEN_DRAFTS_MS || 3000;
    if (delay > 0) Utilities.sleep(delay);

    _incrementDailyDraftCount();

    var draftId = draft.getId();
    var actualThreadId = '';
    try {
      actualThreadId = draft.getMessage().getThread().getId();
    } catch (_) { /* non-critical */ }

    logPipelineEvent(lead.rowNum, 'FOLLOWUP_' + stage,
                     'Follow-up draft created [' + pathTaken + ']', 'SUCCESS');

    return { success: true, draftId: draftId, threadId: actualThreadId, error: '' };

  } catch (error) {
    var errorMsg = 'Failed to create follow-up draft: ' + error.toString();
    logPipelineEvent(lead.rowNum, 'FOLLOWUP_' + stage, errorMsg, 'ERROR');
    return { success: false, draftId: '', threadId: threadId || '', error: errorMsg };
  }
}

// ─── DAILY DRAFT LIMIT PROTECTION ─────────────────────────

/**
 * Checks if daily draft creation limit has been reached.
 * @returns {Object} { exceeded: boolean, count: number, limit: number, message: string }
 */
function _checkDailyDraftLimit() {
  var props = PropertiesService.getScriptProperties();
  var today = new Date().toISOString().split('T')[0];
  var key = 'DAILY_DRAFTS_' + today;
  var count = parseInt(props.getProperty(key)) || 0;
  var limit = CONFIG.DAILY_DRAFT_LIMIT || 25;

  if (count >= limit) {
    return {
      exceeded: true,
      count: count,
      limit: limit,
      message: 'Daily draft limit reached (' + count + '/' + limit + '). Resume tomorrow to protect deliverability.'
    };
  }

  return { exceeded: false, count: count, limit: limit, message: '' };
}

/**
 * Increments the daily draft counter.
 */
function _incrementDailyDraftCount() {
  var props = PropertiesService.getScriptProperties();
  var today = new Date().toISOString().split('T')[0];
  var key = 'DAILY_DRAFTS_' + today;
  var count = parseInt(props.getProperty(key)) || 0;
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
  var today = new Date().toISOString().split('T')[0];
  var key = 'DAILY_DRAFTS_' + today;
  var count = parseInt(props.getProperty(key)) || 0;
  var limit = CONFIG.DAILY_DRAFT_LIMIT || 25;
  return { count: count, limit: limit, remaining: Math.max(0, limit - count), date: today };
}

// ─── DRAFT RETRIEVAL HELPERS ───────────────────────────────

/**
 * Retrieves a draft by ID.
 * @param {string} draftId - Gmail draft ID
 * @returns {Object} Draft message object or null if not found
 */
function getDraftById(draftId) {
  try {
    var drafts = GmailApp.getDrafts();
    for (var i = 0; i < drafts.length; i++) {
      // Check if this draft matches the ID
      var messages = drafts[i].getMessages();
      if (messages.length > 0) {
        var msg = messages[0];
        // Gmail draft IDs are derived from thread and message IDs
        if (msg.getId && msg.getId() === draftId) {
          return msg;
        }
      }
    }
    return null;
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
  try {
    var drafts = GmailApp.getDrafts();
    for (var i = 0; i < drafts.length; i++) {
      var messages = drafts[i].getMessages();
      if (messages.length > 0) {
        var msg = messages[0];
        if (msg.getId && msg.getId() === draftId) {
          // Send the draft
          drafts[i].send();
          return {
            success: true,
            messageId: msg.getId(),
            error: ''
          };
        }
      }
    }
    return { success: false, messageId: '', error: 'Draft not found: ' + draftId };
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
  try {
    var drafts = GmailApp.getDrafts();
    for (var i = 0; i < drafts.length; i++) {
      var messages = drafts[i].getMessages();
      if (messages.length > 0) {
        var msg = messages[0];
        if (msg.getId && msg.getId() === draftId) {
          // Move draft message to trash (GmailDraft has no direct delete method in GAS)
          msg.moveToTrash();
          return { success: true, error: '' };
        }
      }
    }
    return { success: false, error: 'Draft not found: ' + draftId };
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
