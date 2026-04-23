/**
 * ============================================================
 * FollowUp.gs — Threaded LLM follow-up composer (2026 rewrite)
 *
 * What changed vs. the legacy engine:
 *   1. Cadence is anchored to SENT_DATE (the day the user actually
 *      sent the initial), NOT to dossier-generation time. Follow-ups
 *      never fire for leads whose initial draft was never sent.
 *   2. Generation emits OFFSET DAYS (3 / 7 / 14 from send), not
 *      absolute dates. The absolute fire time is computed when the
 *      daily trigger runs, from parentLead.sentDate + offsetDays.
 *   3. Body is composed by Claude with signal rotation: each stage
 *      anchors on a DIFFERENT signal from the dossier (funding,
 *      LinkedIn post, hiring, press, launch, talk). Fixes the
 *      "[PROOF_POINT]" placeholder leak from the static template.
 *   4. Rate-limiting + threading go through createFollowUpDraft
 *      (which uses thread.createDraftReply) — no raw GmailApp.createDraft
 *      in processScheduledFollowUps anymore.
 *
 * Research anchors:
 *   - Instantly 2026 State-of-Cold-Email report: 4–7 touches maximize
 *     reply rate, with 58% from step 1 and ~42% distributed across
 *     follow-ups. 3-7-14 gives a conservative 3-touch sequence.
 *   - Lavender 231,818-email study: operations-segment emails hit
 *     5.4% reply rate at 90+ content-quality score; signal freshness
 *     materially drives follow-up reply rate.
 *   - Gmail/Yahoo 2026 bulk-sender rules: 25/day cap stays well under
 *     the 5k/day "bulk sender" threshold, so deliverability overhead
 *     (SPF/DKIM/DMARC + RFC 8058 one-click unsubscribe) is optional.
 * ============================================================
 */

// ─── STAGE METADATA (intent, not templates) ───────────────
// Templates are gone — Claude composes each body from scratch using
// the intent + rotated signal below. Kept as a map so
// _getFrameworkForStage() still returns something useful to the
// prompt builder and the fallback path.
var FOLLOWUP_FRAMEWORKS = {
  VALUE_ADD: {
    stage: 1,
    name: 'VALUE_ADD',
    intent: 'Share a fresh, specific observation about the recipient\'s company or role. No "bumping this" energy. One line → one insight → one soft ask.'
  },
  SOCIAL_PROOF: {
    stage: 2,
    name: 'SOCIAL_PROOF',
    intent: 'Anchor on a comparable company or verified Gaurav metric. Use one concrete number; tie it to the recipient\'s likely pain. End with a low-commitment question.'
  },
  BREAK_UP: {
    stage: 3,
    name: 'BREAK_UP',
    intent: 'Graceful close. Acknowledge timing may be wrong. Leave the door open but do NOT ask for anything. Two short paragraphs max.'
  }
};

// ─── GENERATE FOLLOW-UP SEQUENCE ──────────────────────────

/**
 * Builds the 3-touch follow-up sequence for a lead. Output is a list
 * of OFFSET specs — absolute fire times are computed at trigger time
 * from the parent lead's SENT_DATE.
 *
 * @param {Object} lead
 * @param {string} originalSubject
 * @param {Object} dossier
 * @param {Object} classification
 * @returns {Array<Object>} [{ stage, offsetDays, subject, body, framework, signalUsed }, ...]
 */
function generateFollowUps(lead, originalSubject, dossier, classification) {
  if (!lead || !originalSubject) {
    Logger.log('[FollowUp] Missing lead or originalSubject');
    return [];
  }

  var cadence = (typeof CONFIG !== 'undefined' && CONFIG.FOLLOWUP_CADENCE)
    ? CONFIG.FOLLOWUP_CADENCE
    : { offsetDaysByStage: { 1: 3, 2: 7, 3: 14 }, sendHour: 9, frameworkByStage: { 1: 'VALUE_ADD', 2: 'SOCIAL_PROOF', 3: 'BREAK_UP' } };

  // Pre-compute a signal pool once per lead so we can deterministically
  // rotate a fresh signal into each stage without repeating.
  var signalPool = _buildSignalPool(dossier);

  var stages = [1, 2, 3];
  var followUps = [];

  for (var i = 0; i < stages.length; i++) {
    var stage = stages[i];
    var offsetDays = cadence.offsetDaysByStage[stage];
    var framework = _getFrameworkForStage(stage);

    // Pick a DIFFERENT signal per stage (rotation). Falls back to
    // recycling if the pool is smaller than the stage count.
    var signal = signalPool.length > 0 ? signalPool[i % signalPool.length] : null;

    var composed = _composeFollowUp(lead, originalSubject, dossier, classification, framework, stage, signal);
    if (!composed) composed = _fallbackFollowUp(lead, originalSubject, stage);
    if (!composed) continue;

    followUps.push({
      stage: composed.stage,
      offsetDays: offsetDays,
      subject: composed.subject || '',
      body: composed.body || '',
      framework: composed.framework || framework.name,
      signalUsed: composed.signalUsed || (signal ? signal.type : 'none')
    });
  }

  return followUps;
}

// ─── LLM COMPOSER (replaces static template replace) ─────

/**
 * Calls Claude with a role-framed, XML-tagged prompt. Negative
 * constraints ("do NOT include placeholder tokens") are placed in
 * <rules> because Sonnet 4.5/4.6 respects them more reliably than
 * inline negation in free-text.
 *
 * Returns null on LLM error so the caller can use _fallbackFollowUp.
 *
 * @param {Object} lead
 * @param {string} originalSubject
 * @param {Object} dossier
 * @param {Object} classification
 * @param {Object} framework   - { name, intent }
 * @param {number} stage       - 1, 2, or 3
 * @param {Object|null} signal - { type, text } from _buildSignalPool
 * @returns {Object|null}
 */
function _composeFollowUp(lead, originalSubject, dossier, classification, framework, stage, signal) {
  if (!framework) return null;

  var firstName = lead.firstName || (lead.fullName || '').split(' ')[0] || 'there';
  var company = lead.organization || 'your company';
  var offsetDay = (CONFIG.FOLLOWUP_CADENCE && CONFIG.FOLLOWUP_CADENCE.offsetDaysByStage[stage]) || (stage === 1 ? 3 : stage === 2 ? 7 : 14);

  // Pull the single best pain point + insight from the dossier for context
  var topPain = (dossier && dossier.painPoints && dossier.painPoints.length > 0) ? dossier.painPoints[0] : '';
  var topInsight = (dossier && dossier.insights && dossier.insights.length > 0) ? dossier.insights[0] : '';

  var prompt = [
    '<role>You are Gaurav Rathore writing a Day-' + offsetDay + ' follow-up in an existing email thread. The recipient got your initial email ' + offsetDay + ' days ago and did not reply.</role>',
    '',
    '<recipient>',
    '  <name>' + firstName + '</name>',
    '  <company>' + company + '</company>',
    '  <role>' + (lead.designation || 'leader') + '</role>',
    '</recipient>',
    '',
    '<framework>',
    '  <stage>' + stage + ' of 3</stage>',
    '  <name>' + framework.name + '</name>',
    '  <intent>' + framework.intent + '</intent>',
    '</framework>',
    '',
    '<original_subject>' + originalSubject + '</original_subject>',
    '',
    signal ? ('<signal_to_anchor_on type="' + signal.type + '">' + signal.text + '</signal_to_anchor_on>') : '<signal_to_anchor_on>none — use a general observation about ' + company + '</signal_to_anchor_on>',
    topPain ? ('<recipient_pain_point>' + topPain + '</recipient_pain_point>') : '',
    topInsight ? ('<dossier_insight>' + topInsight + '</dossier_insight>') : '',
    '',
    '<rules>',
    '  - Body length: 50–90 words. Plain text only (no HTML, no markdown, no emoji).',
    '  - Open with ONE sentence that references the signal_to_anchor_on concretely. Do NOT say "following up", "bumping this", "circling back", or "checking in".',
    '  - Middle sentence: tie the signal to the recipient\'s likely pain or opportunity. If stage=2, cite ONE specific metric from Gaurav\'s verified achievements (e.g., "94% complaint drop on 121K orders at Blinkit Bistro").',
    '  - Close with ONE low-commitment question the recipient can answer in 15 seconds, OR (if stage=3) a graceful door-closer with no ask.',
    '  - Do NOT include ANY placeholder tokens like [NAME], [COMPANY], [INSIGHT], [PROOF_POINT], [FINAL_CTA]. Write the actual text.',
    '  - Do NOT repeat the original subject line or phrases from the original email.',
    '  - Sign off: "Gaurav" on its own line. No title, no LinkedIn URL (the signature is added separately).',
    '</rules>',
    '',
    '<output_format>',
    '  First line: SUBJECT: <6 words or fewer, no "Re:" prefix — the threaded reply inherits subject from the parent thread; this field is metadata only and may be blank if you have nothing distinctive>',
    '  Blank line.',
    '  Body text (50–90 words).',
    '  Blank line.',
    '  Last line: Gaurav',
    '</output_format>'
  ].filter(Boolean).join('\n');

  try {
    // callClaude is defined in ApiClients.gs. Low temp so follow-ups stay tight.
    if (typeof callClaude !== 'function') {
      Logger.log('[FollowUp] callClaude not available — using fallback');
      return null;
    }
    var result = callClaude(prompt, { temperature: 0.45, maxTokens: 400 });
    if (!result || !result.success || !result.data) {
      Logger.log('[FollowUp] Claude call failed for stage ' + stage + ': ' + (result && result.error));
      return null;
    }

    var parsed = _parseFollowUpOutput(result.data);
    if (!parsed.body || parsed.body.length < 30) {
      Logger.log('[FollowUp] Claude returned unusably short body for stage ' + stage);
      return null;
    }

    return {
      stage: stage,
      subject: parsed.subject || '',   // blank is fine — threaded reply inherits parent
      body: parsed.body,
      framework: framework.name,
      signalUsed: signal ? signal.type : 'none'
    };
  } catch (e) {
    Logger.log('[FollowUp] _composeFollowUp exception for stage ' + stage + ': ' + e.message);
    return null;
  }
}

/**
 * Extracts SUBJECT and body from Claude's formatted output.
 * Tolerant of model variation: also handles no "SUBJECT:" line.
 */
function _parseFollowUpOutput(raw) {
  if (!raw) return { subject: '', body: '' };
  var text = raw.toString().trim();

  var subject = '';
  var body = text;

  var subjMatch = text.match(/^\s*SUBJECT\s*:\s*(.+?)\s*(?:\r?\n|$)/i);
  if (subjMatch) {
    subject = subjMatch[1].trim();
    // Strip the subject line (and any blank line after it) from the body
    body = text.substring(subjMatch.index + subjMatch[0].length).replace(/^\s*\n/, '').trim();
  }

  return { subject: subject, body: body };
}

// ─── SIGNAL POOL (rotation source) ───────────────────────

/**
 * Pulls all usable signals from the dossier in priority order.
 * Each stage picks a DIFFERENT signal so the 3 follow-ups don't all
 * anchor on the same funding round.
 *
 * Recognized dossier fields (from researchLead output):
 *   recentFunding, latestFundingRound, recentProductLaunches,
 *   hiringSignals, recentNews, leadershipChanges, marketMoves,
 *   recentLinkedInPosts, recentActivity, publishedContent,
 *   thoughtLeadershipTopics, recentCareerMoves, growthSignals
 */
function _buildSignalPool(dossier) {
  if (!dossier) return [];
  var pool = [];

  var pushIfPresent = function(type, value) {
    if (value === null || value === undefined) return;
    var text = '';
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      text = value[0];
    } else {
      text = value.toString();
    }
    text = (text || '').trim();
    if (text && text.toLowerCase() !== 'n/a' && text.toLowerCase() !== 'none' && text.length > 8) {
      pool.push({ type: type, text: text.substring(0, 280) });
    }
  };

  pushIfPresent('funding', dossier.latestFundingRound || dossier.recentFunding || dossier.fundingInfo);
  pushIfPresent('product_launch', dossier.recentProductLaunches || dossier.recentLaunch);
  pushIfPresent('hiring', dossier.hiringSignals);
  pushIfPresent('linkedin_post', dossier.recentLinkedInPosts || dossier.recentPost);
  pushIfPresent('press', dossier.pressRelease || dossier.recentNews);
  pushIfPresent('leadership_change', dossier.leadershipChanges);
  pushIfPresent('market_move', dossier.marketMoves);
  pushIfPresent('thought_leadership', dossier.thoughtLeadershipTopics || dossier.publishedContent);
  pushIfPresent('career_move', dossier.recentCareerMoves);
  pushIfPresent('growth_signal', dossier.growthSignals);
  pushIfPresent('activity', dossier.recentActivity);

  return pool;
}

// ─── FALLBACK (when LLM unavailable or fails) ────────────

function _fallbackFollowUp(lead, originalSubject, stage) {
  var firstName = lead.firstName || (lead.fullName || '').split(' ')[0] || 'there';
  var company = lead.organization || 'your company';

  var subject = '';
  var body = '';

  if (stage === 1) {
    subject = 'One thought on ' + company;
    body = 'Hi ' + firstName + ',\n\n' +
           'Sent you a note last week — realized it might have landed at a bad moment.\n\n' +
           'Been tracking how ' + company + ' is scaling and had one concrete thought I didn\'t fit into the first email. Happy to share in 3 lines if useful.\n\n' +
           'Worth a reply?\n\nGaurav';
  } else if (stage === 2) {
    subject = 'Quick number, ' + firstName;
    body = 'Hi ' + firstName + ',\n\n' +
           'Quick one. At Blinkit Bistro I cut complaint rate 94% across 121K orders by tightening 13 margin levers — closed a 40% quality gap in 2.5 weeks.\n\n' +
           'If anything adjacent is on your plate at ' + company + ', I\'d be happy to walk through what moved the needle. 15 min?\n\nGaurav';
  } else {
    subject = 'Closing the loop';
    body = 'Hi ' + firstName + ',\n\n' +
           'Last note — won\'t keep pinging. If the timing isn\'t right, no worries.\n\n' +
           'If ' + company + ' ever needs a set of eyes on ops, growth, or AI workflows, my door\'s open. Rooting for what you\'re building.\n\nGaurav';
  }

  return {
    stage: stage,
    subject: subject,
    body: body,
    framework: _getFrameworkForStage(stage).name,
    signalUsed: 'fallback',
    isFallback: true
  };
}

// ─── PROCESS DUE FOLLOW-UPS (daily trigger entry point) ──

/**
 * Daily 9 AM trigger handler. Scans the FollowUps sheet, and for each
 * PENDING row: looks up the parent lead, verifies the parent was
 * actually SENT, recomputes the fire date as (parentLead.sentDate +
 * offsetDays), and if due → creates a threaded reply draft via
 * createFollowUpDraft (which goes through the daily 25-draft gate).
 */
function processScheduledFollowUps() {
  Logger.log('[FollowUp] processScheduledFollowUps started at ' + new Date().toISOString());

  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var followupsSheet = ss.getSheetByName('FollowUps');
    if (!followupsSheet) {
      Logger.log('[FollowUp] FollowUps sheet not found');
      return;
    }

    var data = followupsSheet.getDataRange().getValues();
    if (data.length < 2) {
      Logger.log('[FollowUp] No follow-up rows to process');
      return;
    }

    // Map headers so the code is resilient to column reordering
    var headers = data[0].map(function(h) { return (h || '').toString().trim(); });
    var col = {
      email:          headers.indexOf('Email'),
      scheduledDate:  headers.indexOf('ScheduledDate'),
      subject:        headers.indexOf('Subject'),
      body:           headers.indexOf('Body'),
      status:         headers.indexOf('Status'),
      leadName:       headers.indexOf('LeadName'),
      stage:          headers.indexOf('Stage'),
      offsetDays:     headers.indexOf('OffsetDays'),
      parentRow:      headers.indexOf('ParentRow')
    };

    // Back-compat: if OffsetDays / ParentRow aren't there (old sheets),
    // fall back to the legacy behaviour of firing by ScheduledDate alone.
    var hasOffsetSchema = col.offsetDays >= 0 && col.parentRow >= 0;
    var now = new Date();
    var drafted = 0, skipped = 0, errored = 0;

    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var status = ((row[col.status] || '') + '').trim();
      if (status === 'SENT' || status === 'CANCELLED') continue;

      var leadEmail = (row[col.email] || '').toString().trim();
      var subject   = (row[col.subject] || '').toString();
      var body      = (row[col.body] || '').toString();
      var stage     = parseInt(row[col.stage]) || 1;

      if (!leadEmail || !body) { skipped++; continue; }

      // Look up parent lead — new path via ParentRow, legacy path via email scan
      var parentLead = null;
      if (hasOffsetSchema && row[col.parentRow]) {
        var parentRowNum = parseInt(row[col.parentRow]);
        if (parentRowNum > 1) parentLead = getLeadByRow(parentRowNum);
      }
      if (!parentLead) parentLead = _findLeadByEmail(leadEmail);

      if (!parentLead) {
        Logger.log('[FollowUp] Skipping row ' + (i + 1) + ': parent lead not found for ' + leadEmail);
        skipped++;
        continue;
      }

      // ── Gate: initial must be SENT ──
      if (parentLead.status !== STATUS.SENT &&
          parentLead.status !== STATUS.FOLLOWUP_1 &&
          parentLead.status !== STATUS.FOLLOWUP_2 &&
          parentLead.status !== STATUS.FOLLOWUP_3) {
        // Silently skip — if the user never sent the initial, don't send follow-ups
        skipped++;
        continue;
      }

      // ── If the recipient already replied, cancel the follow-up ──
      if (parentLead.status === STATUS.RESPONDED) {
        followupsSheet.getRange(i + 1, col.status + 1).setValue('CANCELLED');
        skipped++;
        continue;
      }

      // ── Compute real fire date from sentDate + offsetDays ──
      var fireDate;
      if (hasOffsetSchema && parentLead.sentDate) {
        var offsetDays = parseInt(row[col.offsetDays]) || 0;
        fireDate = new Date(new Date(parentLead.sentDate).getTime() + (offsetDays * 86400000));
        fireDate = _adjustToSendDay(fireDate);
      } else if (row[col.scheduledDate]) {
        fireDate = new Date(row[col.scheduledDate]);
      } else {
        skipped++;
        continue;
      }

      if (fireDate > now) continue;  // not yet due

      // ── Create threaded follow-up via unified rate-limited path ──
      try {
        var result = createFollowUpDraft(
          parentLead,
          stage,
          subject || parentLead.subjectLine || '',
          body,
          parentLead.threadId
        );

        if (result.success) {
          followupsSheet.getRange(i + 1, col.status + 1).setValue('SENT');
          if (col.scheduledDate >= 0) {
            followupsSheet.getRange(i + 1, col.scheduledDate + 1).setValue(fireDate);
          }

          // Update parent lead's follow-up stage status in DATA_SHEET
          var nextStatus = STATUS['FOLLOWUP_' + stage] || parentLead.status;
          updateLeadFields(parentLead.rowNum, { STATUS: nextStatus, FOLLOWUP_STAGE: stage });

          drafted++;
        } else {
          Logger.log('[FollowUp] createFollowUpDraft failed for row ' + (i + 1) + ': ' + result.error);
          errored++;
        }
      } catch (drErr) {
        Logger.log('[FollowUp] Exception for row ' + (i + 1) + ': ' + drErr.message);
        errored++;
      }
    }

    Logger.log('[FollowUp] Done. Drafted=' + drafted + ', skipped=' + skipped + ', errored=' + errored);
  } catch (e) {
    Logger.log('[FollowUp] Fatal in processScheduledFollowUps: ' + e.toString());
  }
}

// ─── HELPERS ─────────────────────────────────────────────

function _getFrameworkForStage(stage) {
  if (stage === 1) return FOLLOWUP_FRAMEWORKS.VALUE_ADD;
  if (stage === 2) return FOLLOWUP_FRAMEWORKS.SOCIAL_PROOF;
  if (stage === 3) return FOLLOWUP_FRAMEWORKS.BREAK_UP;
  return FOLLOWUP_FRAMEWORKS.VALUE_ADD;
}

/**
 * Adjusts a date to the configured send hour (default 9 AM local) with
 * zeroed seconds/ms for clean sheet display.
 */
function _adjustToSendDay(date) {
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) {
    Logger.log('[FollowUp] Invalid date in _adjustToSendDay');
    return new Date();
  }
  var hour = (CONFIG.FOLLOWUP_CADENCE && CONFIG.FOLLOWUP_CADENCE.sendHour) || 9;
  var adjusted = new Date(date.getTime());
  adjusted.setHours(hour, 0, 0, 0);
  return adjusted;
}

/**
 * Scans DATA_SHEET for a lead whose email matches. Returns the first
 * hit (most recent email). Used by processScheduledFollowUps as a
 * fallback when the FollowUps sheet lacks a ParentRow column.
 */
function _findLeadByEmail(email) {
  if (!email) return null;
  try {
    var sheet = _getDataSheet();
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return null;

    var width = (CONFIG.SHEET_COL_COUNT || CONFIG.COLUMNS.RFC822_MESSAGE_ID || 23);
    var data = sheet.getRange(2, 1, lastRow - 1, width).getValues();
    var target = email.toString().trim().toLowerCase();

    // Check both EMAIL (F) and ENRICHED_EMAIL (X) columns
    var emailIdx = CONFIG.COLUMNS.EMAIL - 1;
    var enrichedIdx = (CONFIG.COLUMNS.ENRICHED_EMAIL || 0) - 1;

    for (var i = 0; i < data.length; i++) {
      var rowEmail = (data[i][emailIdx] || '').toString().trim().toLowerCase();
      var rowEnriched = enrichedIdx >= 0 ? (data[i][enrichedIdx] || '').toString().trim().toLowerCase() : '';
      if (rowEmail === target || rowEnriched === target) {
        return _rowToLeadProfile(data[i], i + 2);
      }
    }
  } catch (e) {
    Logger.log('[FollowUp] _findLeadByEmail error: ' + e.message);
  }
  return null;
}

// ─── SEND-TIMING HEURISTIC (unchanged behaviour) ────────

/**
 * Evaluates whether the current moment is a good send window.
 * Not used for follow-up firing (those go by sentDate + offsetDays),
 * but kept here because BatchProcessor.processNextBatch calls it to
 * skip evening/weekend initial-draft creation.
 */
function checkSendTiming() {
  var now = new Date();
  var hour = now.getHours();
  var day = now.getDay();  // 0=Sun, 6=Sat
  var month = now.getMonth();

  var isGood = true;
  var note = '';
  var season = 'normal';

  if (day === 0 || day === 6) {
    isGood = false;
    note = 'Weekend — wait for Monday morning';
  } else if (hour < 8 || hour > 18) {
    isGood = false;
    note = 'Outside business hours (8 AM – 6 PM)';
  } else if (hour >= 9 && hour <= 11) {
    note = 'Prime send window (9–11 AM)';
  } else {
    note = 'Acceptable send window';
  }

  if (month === 11) { season = 'holiday'; note += '. December — lower response rates expected'; }
  if (month === 0 && now.getDate() <= 7) { season = 'new_year'; note += '. Early January — ramp-up period'; }

  // Also surface count of due follow-ups if the sheet exists
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var followupsSheet = ss.getSheetByName('FollowUps');
    if (followupsSheet) {
      var data = followupsSheet.getDataRange().getValues();
      var dueCount = 0;
      var statusIdx = data[0].indexOf('Status');
      var schedIdx = data[0].indexOf('ScheduledDate');
      for (var i = 1; i < data.length; i++) {
        if (schedIdx < 0) break;
        var sched = new Date(data[i][schedIdx]);
        var status = (data[i][statusIdx] || '').toString();
        if (!isNaN(sched.getTime()) && sched <= now && status !== 'SENT' && status !== 'CANCELLED') dueCount++;
      }
      if (dueCount > 0) note += '. ' + dueCount + ' follow-up(s) pending';
    }
  } catch (e) {
    Logger.log('[FollowUp] checkSendTiming follow-up scan error: ' + e.message);
  }

  return {
    isGood: isGood,
    note: note,
    season: season,
    hour: hour,
    day: day,
    timestamp: now.toISOString()
  };
}
