/**
 * ============================================================
 * EmailComposer.gs — AI-Powered Job-Seeking Email Composition
 * Generates personalized HTML outreach emails using Claude API
 * with deliverability validation, spam filtering, and tone optimization.
 * ============================================================
 */

// ─── HTML EMAIL STYLE CONSTANTS ─────────────────────────────

/**
 * Sanitizes text by removing curly/smart quotes and replacing with straight quotes.
 * Also strips other typographic characters that break plain email rendering.
 * @param {string} text - Input text
 * @returns {string} Cleaned text with only straight quotes
 */
function _sanitizeText(text) {
  if (!text) return text;
  return text
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')   // " " „ ‟ ″ ‶ → straight "
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")   // ' ' ‚ ‛ ′ ‵ → straight '
    // REMOVED -p4-cxotier3-enrich-amend: em-dash normalization dropped per playbook authority.
    // Em-dashes are standard professional writing; the previous "  -  " was a worse tell.
    // See `12b_variant_design_decisions.md`.
    // PATCH `-promote-scanner-emdash-fix` (2026-06-09): RESTORED em-dash normalization.
    // The earlier removal was correct in theory ('em-dashes are professional writing')
    // but the validator at line ~1195 still flags em-dashes as FATAL -> Tier-3 fallback.
    // Live Phase 8 analysis (2026-06-09) showed em-dash as the FATAL cause for Row 56
    // (Ishaan Makker) and likely most of the 17 historical Tier-3 fallbacks whose root
    // cause was masked by hardcoded NOTES text. Converts em-dash (U+2014) and horizontal
    // bar (U+2015) to single-space hyphen ' - ' (matches the prompt instructions:
    // 'Use " - " or commas instead'). The collapse-double-space line below catches any
    // '  -  ' patterns produced by adjacent replacements.
    .replace(/[—―]/g, ' - ')                       // — ― → " - "
    .replace(/[\u2013]/g, '-')                                  // – → plain hyphen
    .replace(/\u2026/g, '...')                                  // … → ...
    .replace(/[""]/g, '"')                                      // Fullwidth quotes → straight
    .replace(/['']/g, "'")                                      // Fullwidth single → straight
    .replace(/ {2,}/g, ' ');                                    // Collapse any double-spaces (catches "  -  " from em-dash replacement)
}

var EMAIL_STYLE = {
  fontFamily: 'Calibri, Arial, Helvetica, sans-serif',
  fontSize: '14px',
  lineHeight: '1.6',
  color: '#1a1a1a',
  signatureColor: '#555555',
  psColor: '#2c2c2c',
  linkColor: '#0b66c3'
};

// ─── DELIVERABILITY V2: CSS/TABLE TEXT HEADER (T2) ────────────────────────
// Returns the banner HTML appropriate for the FORMAT_DELIV_V2 flag state.
//
// FLAG ON  (default): table-based text header — zero image bytes, zero Drive
//   op, zero CID blob. Gmail+Outlook-safe (table/td bgcolor renders in all
//   six Outlooks; avoids div-only/flex). Background #1a3c6e matches GAURAV
//   brand colors. Eliminates the HTML_IMAGE_ONLY SpamAssassin trigger and
//   removes one Drive round-trip per draft.
//
// FLAG OFF: legacy cid:emailBanner <img> wrapper (pre-deliv-v2 behavior).
//   The caller in GmailDrafter must still attach the banner blob when OFF.
//
// Usage: var bannerHtml = _delivBannerHtml();
//        When FLAG ON and caller is GmailDrafter, skip attaching the banner
//        blob (inlineImages remains empty for the emailBanner key).
function _delivBannerHtml() {
  if (_enrichmentFlag('FORMAT_DELIV_V2')) {
    // PATCH 2026-06-11-eq8-deliv-v2 (T2): CSS table header replaces cid img.
    // Research-verified: table/td bgcolor works in all six Outlooks + Gmail.
    // Colors match existing brand: #1a3c6e (navy) from CONFIG EMAIL_STYLE.
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
           'style="margin:0 0 20px 0;">' +
           '<tr><td style="background:#1a3c6e;padding:14px 18px;border-radius:6px;">' +
           '<span style="font-family:Georgia,serif;font-size:20px;font-weight:bold;' +
           'color:#ffffff;">Gaurav Rathore</span><br>' +
           '<span style="font-family:Arial,sans-serif;font-size:12px;color:#cfe0f5;' +
           'letter-spacing:1px;">STRATEGY &nbsp;&bull;&nbsp; MARKETING &nbsp;&bull;&nbsp; GROWTH</span>' +
           '</td></tr></table>\n';
  }
  // Legacy: cid:emailBanner (FLAG OFF)
  return '<div style="margin:0 0 20px 0;text-align:center;">\n' +
    '  <img src="cid:emailBanner" alt="Gaurav Rathore - Strategy, Marketing &amp; Growth" ' +
    'width="600" style="max-width:100%;height:auto;display:block;border:0;border-radius:6px;" />\n' +
    '</div>\n';
}

// ─── MAIN COMPOSITION FUNCTION ────────────────────────────

/**
 * Composes a personalized job-seeking email using Claude AI.
 * Returns HTML-formatted email body with signature and P.S. block.
 * @param {Object} lead - LeadProfile
 * @param {Object} dossier - Compressed research dossier
 * @param {Object} classification - Lead classification
 * @param {Object} resumeSelection - Selected resume variant
 * @returns {Object} {success, subjectLine, emailBody (HTML), qualityNotes}
 */
function composeEmail(lead, dossier, classification, resumeSelection) {
  Logger.log('Composing job-seeking email for ' + lead.fullName);

  var template = classification.template;
  if (!template) {
    return { success: false, qualityNotes: 'No template selected for composition' };
  }

  // PATCH 2026-05-15 (v2 Track F): pre-flight health check on Claude.
  // If the last health probe shows Claude auth_failed or quota_exhausted
  // (within the last 6 hours), skip the Tier 1 attempt entirely and go
  // straight to Tier 3 deterministic fallback. Saves the wasted API call
  // + retry latency. Telemetry logs the decision so we can audit.
  if (typeof shouldSkipTier1 === 'function') {
    try {
      var preflight = shouldSkipTier1();
      if (preflight.skipTier1) {
        Logger.log('[EmailComposer] Pre-flight SKIP_TIER_1: ' + preflight.reason);
        logPipelineEvent(lead.rowNum, 'COMPOSE',
          'Pre-flight skip to Tier 3 — Claude unhealthy (' + preflight.reason + ')', 'WARN');
        // Phase 4: route by classification template (CXO_SHORT / HR_RECRUITER / STANDARD)
        return _routeDeterministicFallback(lead, dossier, classification, resumeSelection);
      }
      // Telemetry: log decision even on proceed for first few leads after deploy
      // (silenced if reason looks routine — health is alive)
      if (preflight.reason.indexOf('alive') < 0 && preflight.reason.indexOf('no_health_data') < 0) {
        Logger.log('[EmailComposer] Pre-flight PROCEED_TIER_1: ' + preflight.reason);
      }
    } catch (preflightErr) {
      // Pre-flight is non-fatal — if it fails, just proceed normally
      Logger.log('[EmailComposer] Pre-flight check threw (proceeding normally): ' + preflightErr.message);
    }
  }

  // Sanitize dossier — strip phone numbers from all text fields before they
  // ever reach Claude's prompt context. Prevents the lead's personal mobile
  // (or scraped company-page numbers) from appearing in the rendered email.
  var safeDossier = _sanitizeDossierForPrompt(dossier);

  // Build context with resume highlights and org challenges (using sanitized dossier)
  var context = _buildCompositionContext(lead, safeDossier, classification, resumeSelection);

  // Hook rotation directive — kills 1-2 hook bias by forbidding recently-used tiers
  var rotationDirective = _buildHookRotationDirective();

  // PATCH 2026-05-16 (Option 5 / Sub-option 4): outreach-framing directive.
  // PREPENDED to the system prompt so it sits at the top of context — LLMs
  // respect early instructions more reliably than mid-prompt overrides. The
  // directive flips the default from "applying to a role" to "informational
  // outreach", and conditionally re-enables applying framing when the lead
  // has a TARGET_ROLE filled in. Solves the core issue: 184+ existing leads
  // have no JD attached, but the system was hallucinating a role for each.
  var framingDirective = _buildOutreachFramingDirective(context);

  // PATCH 2026-05-18 (improvement #3): research-signal directive. Prepended
  // alongside the framing directive so recipient decision power +
  // communication style guide Claude's opening sentence + metric density.
  // Empty string when no signals fire (default for medium-strength leads).
  var researchSignalDirective = _buildResearchSignalDirective(context);

  // Build system + user prompts
  var systemPrompt = framingDirective + researchSignalDirective
                   + _buildSystemPrompt(template, classification.approach)
                   + rotationDirective;
  var userPrompt = _buildUserPrompt(template, lead, context, classification, resumeSelection);

  // Call Claude API
  var result = callClaude(userPrompt, {
    systemPrompt: systemPrompt,
    temperature: 0.7,
    // PATCH 2026-05-12: 1500 → 1800. Canonical BULLET_V1 template (hook +
    // 3 experience bullets + synthesis + 3 AI tool bullets + GitHub line +
    // closing logistics + resume note + signature) was getting clipped.
    maxTokens: 1800
  });

  if (!result.success) {
    // PATCH 2026-05-15 (v2 Track D): Claude unreachable → Tier 3 deterministic fallback.
    // Previously returned {success:false} which BatchProcessor wrote as STATUS=ERROR
    // (silent error queue requiring manual reset_stuck_leads). Now we attempt the
    // static-template path which produces a valid (if generic) draft flagged
    // NEEDS_REVIEW. User sees something they can edit instead of nothing.
    Logger.log('[EmailComposer] Tier 1 (Claude) failed: ' + result.error + ' — engaging Tier 3 deterministic fallback');
    logPipelineEvent(lead.rowNum, 'COMPOSE', 'Claude unreachable (' + result.error + ') — Tier 3 fallback', 'WARN');
    try {
      // PATCH `-postsprint-batch1-amend`: attach fallbackReason so the NOTES
      // text downstream can record WHY Tier-3 fired (vs hardcoded "unreachable").
      // Reasons differ across the three Tier-3 entry paths:
      //   - claude_api_error: Claude returned an error (this branch)
      //   - claude_unparseable: Claude returned but JSON couldn't parse
      //   - fatal_validation: Claude succeeded but post-validation rejected
      //     (e.g., em-dash survived inline fix)
      var t3result = _routeDeterministicFallback(lead, dossier, classification, resumeSelection);
      if (t3result) {
        t3result.fallbackReason = 'claude_api_error';
        t3result.fallbackDetail = (result.error || '').substring(0, 120);
      }
      return t3result;
    } catch (t3Err) {
      Logger.log('[EmailComposer] Tier 3 ALSO threw: ' + t3Err.message);
      return { success: false, qualityNotes: 'Claude unreachable AND Tier 3 fallback failed: ' + t3Err.message };
    }
  }

  // Parse JSON response
  var parsed = _parseCompositionResponse(result.data);
  if (!parsed) {
    // PATCH 2026-05-15 (v2 Track D): Claude returned but output was unparseable.
    // This is a different failure class than "Claude unreachable" — the API call
    // succeeded but emitted malformed JSON. We try ONE more time before falling
    // to Tier 3 (one retry catches transient response truncation; persistent
    // unparseable output suggests a deeper Claude issue → Tier 3).
    Logger.log('[EmailComposer] Tier 1 parse failed — retrying once with stricter prompt before Tier 3');
    logPipelineEvent(lead.rowNum, 'COMPOSE', 'Claude returned unparseable JSON — single retry', 'WARN');
    var retryResult = callClaude(userPrompt, {
      systemPrompt: systemPrompt + '\n\n[STRICT] Output MUST be a single JSON object, no markdown fences, no prose, no trailing commentary. The schema is defined above. Failure to comply will cause the email to fail to ship.',
      temperature: 0.3,   // lower temp on retry
      maxTokens: 1800
    });
    if (retryResult.success) {
      parsed = _parseCompositionResponse(retryResult.data);
    }
    if (!parsed) {
      Logger.log('[EmailComposer] Tier 1 retry also unparseable — engaging Tier 3');
      logPipelineEvent(lead.rowNum, 'COMPOSE', 'Claude unparseable twice — Tier 3 fallback', 'WARN');
      try {
        // PATCH `-postsprint-batch1-amend`: attach fallbackReason
        var t3resultB = _routeDeterministicFallback(lead, dossier, classification, resumeSelection);
        if (t3resultB) {
          t3resultB.fallbackReason = 'claude_unparseable';
          t3resultB.fallbackDetail = 'JSON parse failed on initial attempt and one retry';
        }
        return t3resultB;
      } catch (t3Err) {
        return { success: false, qualityNotes: 'Claude unparseable AND Tier 3 failed: ' + t3Err.message };
      }
    }
  }

  // Record the hook tier Claude selected so the next email avoids it (anti-bias).
  // The model returns selectedHookTier as 1-6; falls back to 0 if missing (no rotation pressure).
  if (typeof parsed.selectedHookTier === 'number') {
    _recordHookTier(parsed.selectedHookTier);
    Logger.log('[EmailComposer] Recorded hook tier ' + parsed.selectedHookTier + ' for ' + lead.fullName);
  }

  // PATCH 2026-06-11-eq8-c4strong: run normalize BEFORE _quickValidate so the
  // new FATAL (bullet-less non-CXO) sees the post-rescue bullet count, not the
  // pre-rescue empty array. _normalizeParsedFields is idempotent — safe to call
  // again even if _parseCompositionResponse already ran it for BULLET_V1 shapes.
  try { _normalizeParsedFields(parsed); } catch (_preValNorm) {
    Logger.log('[EmailComposer] pre-validate normalize skipped: ' + _preValNorm.message);
  }

  // Quick validation
  var validation = _quickValidate(parsed, lead);

  // Auto-fix critical issues (attachment mentions, direct job-asking)
  // PATCH 2026-06-12-e2e-hardening: skip inline fix when the ONLY/primary
  // FATAL is 'bullet-shape email with <2 experienceBullets'. The inline fix
  // prompt returns PROSE_V0 JSON (no experienceBullets), which _parseComposition
  // Response routes to the legacy branch — reValidation immediately re-fires the
  // same bullet-count FATAL. This burns one Claude API call and produces nothing
  // useful before Tier 3 fires anyway. Gate: if EVERY fatal issue contains
  // 'bullet-shape', skip the inline fix entirely and let Tier 3 handle it.
  var _hasBulletShapeFatal = validation.issues.some(function(i) {
    return i.indexOf('bullet-shape email with <2 experienceBullets') >= 0;
  });
  var _needsInlineFix = !_hasBulletShapeFatal && validation.issues.some(function(i) {
    return i.indexOf('FATAL') >= 0 || i.indexOf('Spam trigger') >= 0;
  });
  if (_needsInlineFix) {
    logPipelineEvent(lead.rowNum, 'COMPOSE', 'Critical issues found, attempting inline fix: ' + validation.issues.join('; '));

    var fixPrompt = 'The email below has these issues:\n' + validation.issues.join('\n') +
      '\n\nFix ALL issues. Return corrected JSON: {"subjectLine":"...","greeting":"...","bodyParagraphs":["..."],"cta":"...","psLine":"..."}\n\n' +
      'Original subject: ' + parsed.subjectLine + '\nOriginal body paragraphs:\n' + (parsed.bodyParagraphs || []).join('\n');

    var fixResult = callClaude(fixPrompt, {
      systemPrompt: 'Fix this job-seeking email. Return only JSON. No attachment mentions in body. No direct job-asking language. Include psLine. P.S. rules: 12-28 words, one professional sentence tied to the SAME company/role/industry as the body, NEVER personal small-talk or weekend greetings, NEVER sycophantic ("huge fan"), NEVER emojis, NEVER sales closers. P.S. must add a concrete observation about the company or space — not pleasantries.',
      temperature: 0.4,
      maxTokens: 1000
    });

    if (fixResult.success) {
      var fixParsed = _parseCompositionResponse(fixResult.data);
      if (fixParsed && fixParsed.subjectLine && fixParsed.bodyParagraphs) {
        var reValidation = _quickValidate(fixParsed, lead);
        if (reValidation.issues.length < validation.issues.length) {
          parsed = fixParsed;
          validation = reValidation;
          logPipelineEvent(lead.rowNum, 'COMPOSE', 'Inline fix improved: ' + validation.issues.length + ' remaining issues');
        }
      }
    }
  } else if (_hasBulletShapeFatal) {
    logPipelineEvent(lead.rowNum, 'COMPOSE',
      'bullet-shape FATAL detected — skipping inline fix (PROSE_V0 fix incompatible with BULLET_V1 gate); routing directly to Tier 3', 'WARN');
  }

  // Only FATAL issues block the pipeline
  var fatalIssues = validation.issues.filter(function(i) { return i.indexOf('FATAL') >= 0; });

  // ── PATCH 2026-05-19: Tier 3 fallback for unfixable FATAL issues ─────────
  //
  // When Claude produces output that survives the inline fix-prompt with
  // FATAL flags still present (e.g., em-dash + word-count violation that
  // Claude keeps regenerating despite explicit instructions — see Akshat
  // Soni row 163 case from 2026-05-19), previously the row died at
  // STATUS=ERROR. Now: fall through to Tier 3 deterministic template,
  // which uses pre-sanitized static content (no em-dashes, fixed word
  // count, known-good structure). User gets a usable draft flagged
  // NEEDS_REVIEW; no dead leads.
  //
  // Three Tier 3 entry paths now exist (mirror at line ~117, ~152, here):
  //   1. Claude API unreachable (network / auth / quota)
  //   2. Claude returned but JSON unparseable
  //   3. Claude succeeded but validation has unfixable FATAL issues  ← NEW
  if (fatalIssues.length > 0) {
    Logger.log('[EmailComposer] FATAL validation issues survived inline fix: ' +
               fatalIssues.join('; ') + ' — engaging Tier 3 deterministic fallback');
    logPipelineEvent(lead.rowNum, 'COMPOSE',
      'Tier 1 had FATAL issues: ' + fatalIssues.slice(0, 3).join('; ') +
      ' — falling to Tier 3', 'WARN');
    try {
      // Phase 4: route by classification template
      var t3 = _routeDeterministicFallback(lead, dossier, classification, resumeSelection);
      // Annotate the Tier 3 result so we can audit the FATAL issues that triggered it
      if (t3) {
        var t3Notes = (t3.qualityNotes || '') +
          ' | Tier 1 FATAL issues (not fixable): ' + fatalIssues.slice(0, 3).join('; ');
        t3.qualityNotes = t3Notes;
        // PATCH `-postsprint-batch1-amend`: classify cause precisely so the
        // tier1_fallback_stats analysis isn't bucket-collapsed
        var joinedIssues = fatalIssues.join(' ').toLowerCase();
        if (/em-?dash|en-?dash/.test(joinedIssues)) {
          t3.fallbackReason = 'fatal_em_dash';
        } else if (/word.?count|length/.test(joinedIssues)) {
          t3.fallbackReason = 'fatal_word_count';
        } else if (/smart.?quote|ellipsis/.test(joinedIssues)) {
          t3.fallbackReason = 'fatal_typography';
        } else {
          t3.fallbackReason = 'fatal_validation_other';
        }
        t3.fallbackDetail = fatalIssues.slice(0, 3).join(' | ').substring(0, 200);
      }
      return t3;
    } catch (t3Err) {
      Logger.log('[EmailComposer] Tier 3 ALSO threw on FATAL-validation fallback: ' + t3Err.message);
      // Fall through to legacy error path below
    }
  }

  // ── PATCH 2026-06-11-eq8-finalpolish: run normalization + rescue for ALL parsed paths.
  // _normalizeParsedFields is called inside _parseCompositionResponse only for the
  // BULLET_V1 branch. Legacy PROSE_V0 objects arrive here without normalization, so
  // STANDARD_BULLET_RESCUE never fires. This belt-and-suspenders call is idempotent.
  try { _normalizeParsedFields(parsed); } catch (_nErr) {
    Logger.log('[EmailComposer] _normalizeParsedFields pre-build skipped: ' + _nErr.message);
  }

  // ── Build HTML email ──
  var htmlBody = _buildHtmlEmail(parsed, lead, resumeSelection);

  // ── Structural verification (cold email compliance check) ──
  var structureCheck = _verifyEmailStructure(htmlBody, parsed);
  if (structureCheck.issues.length > 0) {
    logPipelineEvent(lead.rowNum, 'COMPOSE', 'Structure check: ' + structureCheck.issues.join('; '), 'WARN');
  }

  // ── Build subject line with job-application context ──
  // PATCH 2026-05-19: detect CXO_SHORT shape (0 experience bullets + populated
  // motivationParagraph) so the Leadership template skips the "Job Application:"
  // prefix per the Founder-Grade Playbook.
  var _bullets = Array.isArray(parsed.experienceBullets) ? parsed.experienceBullets.length : 0;
  var _isCxoSubject = (_bullets === 0)
                    && !!(parsed.motivationParagraph && parsed.motivationParagraph.toString().trim());
  var finalSubject = _buildSubjectLine(parsed.subjectLine, lead, context, _isCxoSubject);

  var allNotes = validation.issues.concat(structureCheck.issues);
  return {
    success: fatalIssues.length === 0,
    subjectLine: finalSubject,
    emailBody: htmlBody,
    parsed: parsed,   // expose parsed {bodyParagraphs, cta, psLine, greeting} for downstream validators
    qualityNotes: allNotes.length > 0 ? allNotes.join('; ') : 'Passed all checks'
  };
}

// ─── DEDUP HELPERS ───────────────────────────────────────────

/**
 * Normalizes text for comparison: lowercase, strip punctuation, collapse whitespace.
 * Used to detect near-duplicate paragraphs / CTA / P.S. regardless of minor punctuation or spacing.
 * @param {string} s
 * @returns {string}
 */
function _normalizeForCompare(s) {
  if (!s) return '';
  return s.toString()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns a similarity ratio (0..1) between two strings using token-overlap Jaccard.
 * Cheap and effective for catching Claude reusing the CTA inside bodyParagraphs.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function _textSimilarity(a, b) {
  var na = _normalizeForCompare(a);
  var nb = _normalizeForCompare(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  // Containment check (either string contains the other's core)
  if (na.length > 10 && nb.indexOf(na) >= 0) return 1;
  if (nb.length > 10 && na.indexOf(nb) >= 0) return 1;

  var aTokens = na.split(' ').filter(function(t) { return t.length > 2; });
  var bTokens = nb.split(' ').filter(function(t) { return t.length > 2; });
  if (aTokens.length === 0 || bTokens.length === 0) return 0;

  var aSet = {};
  aTokens.forEach(function(t) { aSet[t] = true; });
  var inter = 0;
  bTokens.forEach(function(t) { if (aSet[t]) inter++; });
  var union = aTokens.length + bTokens.length - inter;
  return union === 0 ? 0 : (inter / union);
}

/**
 * Removes duplicate/near-duplicate content across bodyParagraphs, cta, and psLine.
 * Rules:
 *   - Drop any bodyParagraph that is substantially identical (>=0.85 similarity) to the cta.
 *   - Drop any bodyParagraph that is substantially identical to a prior bodyParagraph.
 *   - If psLine is substantially identical to cta or any bodyParagraph, clear it (don't emit garbage).
 *   - If cta is empty but last bodyParagraph looks like a CTA (ends with "?", contains "15 min"/"chat"/"call"),
 *     promote it to cta and drop from paragraphs.
 * @param {Object} parsed - {subjectLine, greeting, bodyParagraphs[], cta, psLine}
 * @returns {Object} - Mutated parsed (also returned) + .dedupNotes array if dedup happened
 */
function _dedupParsedComposition(parsed) {
  if (!parsed) return parsed;
  parsed.dedupNotes = parsed.dedupNotes || [];
  var paras = (parsed.bodyParagraphs || []).slice();
  var cta = (parsed.cta || '').trim();

  // 1. If no cta field but last paragraph looks like a CTA, promote it
  if (!cta && paras.length > 0) {
    var last = paras[paras.length - 1].trim();
    var lastLower = last.toLowerCase();
    var looksLikeCta = /\?\s*$/.test(last) &&
      (lastLower.indexOf('15 min') >= 0 || lastLower.indexOf('15-min') >= 0 ||
       lastLower.indexOf(' chat') >= 0 || lastLower.indexOf(' call') >= 0 ||
       lastLower.indexOf('conversation') >= 0 || lastLower.indexOf('open to') >= 0);
    if (looksLikeCta) {
      cta = last;
      paras.pop();
      parsed.dedupNotes.push('Promoted trailing body paragraph to CTA field');
    }
  }

  // 2. Drop any paragraph that is substantially identical to cta
  if (cta) {
    var keep = [];
    for (var i = 0; i < paras.length; i++) {
      var sim = _textSimilarity(paras[i], cta);
      if (sim >= 0.85) {
        parsed.dedupNotes.push('Removed body paragraph duplicating CTA (sim=' + sim.toFixed(2) + ')');
      } else {
        keep.push(paras[i]);
      }
    }
    paras = keep;
  }

  // 3. Drop consecutive / near-duplicate body paragraphs
  var deduped = [];
  for (var j = 0; j < paras.length; j++) {
    var isDupe = false;
    for (var k = 0; k < deduped.length; k++) {
      if (_textSimilarity(paras[j], deduped[k]) >= 0.85) {
        parsed.dedupNotes.push('Removed duplicate body paragraph #' + (j + 1));
        isDupe = true;
        break;
      }
    }
    if (!isDupe) deduped.push(paras[j]);
  }
  paras = deduped;

  // 4. Clear psLine if it duplicates cta or any body paragraph
  if (parsed.psLine) {
    var psSimToCta = cta ? _textSimilarity(parsed.psLine, cta) : 0;
    if (psSimToCta >= 0.80) {
      parsed.dedupNotes.push('Cleared psLine duplicating CTA');
      parsed.psLine = '';
    } else {
      for (var m = 0; m < paras.length; m++) {
        if (_textSimilarity(parsed.psLine, paras[m]) >= 0.80) {
          parsed.dedupNotes.push('Cleared psLine duplicating body paragraph #' + (m + 1));
          parsed.psLine = '';
          break;
        }
      }
    }
  }

  parsed.bodyParagraphs = paras;
  parsed.cta = cta;
  return parsed;
}

// ─── HTML EMAIL BUILDER ──────────────────────────────────────

/**
 * Builds a professionally formatted HTML email from parsed components.
 * @param {Object} parsed - {subjectLine, greeting, bodyParagraphs[], cta, psLine}
 * @param {Object} lead - LeadProfile
 * @param {Object} resumeSelection - {variantId}
 * @returns {string} Complete HTML email string
 */
// PATCH 2026-06-12-template-unify: The legacy PROSE_V0 renderer below (lines
// starting from the `var s = EMAIL_STYLE;` block) is effectively DEAD for all
// standard cold-mail templates (T1/T2/T3/T4/T5/T6/T8 + HR_RECRUITER). All these
// templates now use the unified BULLET_V1 contract and route through
// _buildHtmlEmailBulletV1. The PROSE_V0 path is intentionally retained for:
//   - QualityGate.gs:attemptRecomposition (prose recomp on quality-gate failure)
//   - Follow-up emails and other callers that pass bodyParagraphs-only objects
//   - Any legacy test fixtures that mock PROSE_V0 objects
// DO NOT delete this renderer. DO NOT redirect standard cold mails here.
function _buildHtmlEmail(parsed, lead, resumeSelection) {
  // 2026 reference-format dispatch: if BULLET_V1 is enabled AND the parsed
  // payload includes the new bullet-list fields, render the reference-style
  // email. Otherwise fall through to the legacy prose builder for backward
  // compatibility (older composer outputs, tests, etc.).
  var formatVersion = (CONFIG && CONFIG.EMAIL_FORMAT && CONFIG.EMAIL_FORMAT.version) || 'PROSE_V0';
  // PATCH 2026-05-12: route via _buildHtmlEmailBulletV1 for ALL modern shapes:
  //   - STANDARD/HR_PARTNERSHIP: >=2 experienceBullets
  //   - CXO_SHORT: 0 bullets but has motivationParagraph (credential thesis)
  // The bullet renderer guards every section with `if (field)` so empty
  // bridgeSentence/experienceBullets/currentRoleParagraph are silently skipped.
  // This gives CXO emails the modern signature, "Looking forward..." line,
  // and underlined-link formatting.
  if (formatVersion === 'BULLET_V1' && parsed && Array.isArray(parsed.experienceBullets)) {
    var hasBullets = parsed.experienceBullets.length >= 2;
    var hasCxoShape = parsed.experienceBullets.length === 0 && !!parsed.motivationParagraph;
    // PATCH 2026-06-11-eq8-hrbullets: HR_RECRUITER Tier-1 path — always route to
    // bullet renderer when templateId marks the shape, regardless of motivationParagraph.
    // _normalizeParsedFields guarantees experienceBullets.length >= 2 before we arrive
    // here (rescue logic above), so this condition fires only on genuine HR shapes.
    var hasHrShape = parsed.templateId === 'HR_RECRUITER' && parsed.experienceBullets.length >= 2;
    if (hasBullets || hasCxoShape || hasHrShape) {
      return _buildHtmlEmailBulletV1(parsed, lead, resumeSelection);
    }
  }

  var s = EMAIL_STYLE;

  // ── SAFETY NET: run dedup again at render time in case parsed was mutated
  // by any downstream stage (quality gate, fix loop, recomposition).
  // This is idempotent — if already dedup'd, no-op.
  _dedupParsedComposition(parsed);

  // Signature uses GAURAV_FACTS for verified credentials (no misleading role taglines)
  var facts = (typeof GAURAV_FACTS !== 'undefined') ? GAURAV_FACTS : {};
  var linkedinUrl = facts.linkedin || 'https://www.linkedin.com/in/gaurav1-grow-learn-together/';
  var credentialLine = facts.signatureLine1 || 'MBA, IIM Kozhikode | B.E., Thapar University';

  // Greeting (sanitize curly quotes)
  // Hardened greeting: validates Claude's output AND falls back through name → org → generic.
  // Defends against (a) Claude passing through bad fullName ("Hi 9876543210,"),
  // (b) empty greeting from Claude, (c) blank firstName ("Hi ,").
  var greeting = _sanitizeText(_resolveGreeting(parsed.greeting, lead));

  // Body paragraphs (sanitize each)
  var bodyHtml = '';
  var paragraphs = parsed.bodyParagraphs || [];
  if (paragraphs.length === 0 && parsed.emailBody) {
    paragraphs = parsed.emailBody.split(/\n\n|\n/).filter(function(p) { return p.trim().length > 0; });
  }

  for (var i = 0; i < paragraphs.length; i++) {
    var cleanPara = _sanitizeText(paragraphs[i]);
    bodyHtml += '<p style="margin:0 0 12px 0;font-family:' + s.fontFamily + ';font-size:' + s.fontSize + ';line-height:' + s.lineHeight + ';color:' + s.color + ';">' + cleanPara + '</p>\n';
  }

  // CTA paragraph (sanitize + bold for emphasis)
  var cta = _sanitizeText(parsed.cta || '');
  if (cta) {
    bodyHtml += '<p style="margin:0 0 12px 0;font-family:' + s.fontFamily + ';font-size:' + s.fontSize + ';line-height:' + s.lineHeight + ';color:' + s.color + ';"><strong>' + cta + '</strong></p>\n';
  }

  // Signature block — factual credentials only (name, education, LinkedIn)
  var signatureHtml =
    '<table cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;border-top:1px solid #e0e0e0;padding-top:16px;">\n' +
    '  <tr>\n' +
    '    <td style="font-family:' + s.fontFamily + ';font-size:' + s.fontSize + ';color:' + s.color + ';font-weight:bold;">Gaurav Rathore</td>\n' +
    '  </tr>\n' +
    '  <tr>\n' +
    '    <td style="font-family:' + s.fontFamily + ';font-size:12px;color:' + s.signatureColor + ';padding-top:2px;">' + credentialLine + '</td>\n' +
    '  </tr>\n' +
    '  <tr>\n' +
    '    <td style="font-family:' + s.fontFamily + ';font-size:12px;color:' + s.signatureColor + ';padding-top:2px;">' +
    '<a href="' + linkedinUrl + '" style="color:' + s.linkColor + ';text-decoration:underline;">LinkedIn Profile</a></td>\n' +
    '  </tr>\n' +
    '</table>\n';

  // P.S. block (sanitize)
  var psHtml = '';
  if (parsed.psLine) {
    var cleanPs = _sanitizeText(parsed.psLine).replace(/^P\.?\s?S\.?\s*[:\-]?\s*/i, '');
    psHtml =
      '<p style="margin:20px 0 0 0;font-family:' + s.fontFamily + ';font-size:13px;font-style:italic;color:' + s.psColor + ';border-left:3px solid #d0d0d0;padding-left:12px;">' +
      '<strong>P.S.</strong> ' + cleanPs +
      '</p>\n';
  }

  // ── Banner (PATCH 2026-06-11-eq8-deliv-v2 T2): dispatched via _delivBannerHtml().
  // FLAG ON: CSS table header (zero image bytes, zero Drive op, zero CID).
  // FLAG OFF: legacy cid:emailBanner <img> wrapper.
  var bannerHtml = _delivBannerHtml();

  // Assemble full email: Banner → Greeting → Body → CTA → Signature → P.S.
  // PATCH `-eq8-content-fix` (#4): removed the outer-wrapper 600px width cap
  // (same narrow-left-column bug as the BulletV1 renderer). Banner img scales
  // on its own; body text now follows the mail client's natural margins.
  // (Comment deliberately avoids the literal CSS token — the regression test
  // greps Function.toString(), which includes comments.)
  var html =
    '<div style="font-family:' + s.fontFamily + ';font-size:' + s.fontSize + ';line-height:' + s.lineHeight + ';color:' + s.color + ';">\n' +
    bannerHtml +
    '<p style="margin:0 0 12px 0;font-family:' + s.fontFamily + ';font-size:' + s.fontSize + ';color:' + s.color + ';">' + greeting + '</p>\n' +
    bodyHtml +
    signatureHtml +
    psHtml +
    '</div>';

  // PATCH 2026-06-11-eq8-contentguards (T3): Greeting integrity normalizer — legacy renderer.
  // Same logic as BulletV1: deduplicate or inject greeting so exactly 1 appears.
  (function() {
    var _greetReL = /<p[^>]*>\s*(Hi|Hello|Hey)\s+[^<,]{1,30},?\s*<\/p>/gi;
    var _greetMatchesL = html.match(_greetReL) || [];
    if (_greetMatchesL.length >= 2) {
      var _firstKeptL = false;
      html = html.replace(_greetReL, function(m) {
        if (!_firstKeptL) { _firstKeptL = true; return m; }
        Logger.log('[LegacyRenderer] T3-greeting: removing duplicate greeting: ' + m.substring(0, 60));
        return '';
      });
    } else if (_greetMatchesL.length === 0) {
      // Inject after the first </div> (banner)
      var _injFirstName = (lead && lead.firstName) ? lead.firstName.toString().trim() : '';
      if (!_injFirstName && lead && lead.fullName) {
        var _injFn = lead.fullName.toString().trim().split(/\s+/)[0] || '';
        if (/^[A-Za-zÀ-ſ][A-Za-z'.\-]{1,}$/.test(_injFn)) _injFirstName = _injFn;
      }
      var _injGreet = _injFirstName
        ? ('<p style="margin:0 0 12px 0;">Hi ' + _injFirstName + ',</p>\n')
        : ('<p style="margin:0 0 12px 0;">Hi,</p>\n');
      var _bannerEndL = html.indexOf('</div>');
      if (_bannerEndL > 0 && _bannerEndL < 400) {
        html = html.substring(0, _bannerEndL + 6) + '\n' + _injGreet + html.substring(_bannerEndL + 6);
      } else {
        html = _injGreet + html;
      }
    }
  })();

  // PATCH 2026-06-11-eq8-c6cal (S2): Unconditional Calendly link guarantee —
  // legacy prose renderer. Hardened to use lastIndexOf('</div>') instead of
  // the fragile .replace('</div>') (first-occurrence replace) which would
  // silently inject into a nested div rather than the closing outer wrapper.
  // Inject-if-absent only — never double-link.
  if (html.indexOf('calendly.com/speak-to-gaurav/30min') < 0) {
    if (/15 minutes to discuss/i.test(html)) {
      html = html.replace(/15 minutes to discuss/gi,
        '<a href="https://calendly.com/speak-to-gaurav/30min" style="color:#1a73e8;text-decoration:underline;">15 minutes to discuss</a>');
    } else {
      // Inject before the FINAL </div> of the outer wrapper.
      var _legacyCalLine = '<p style="margin:0 0 12px 0;">Happy to walk through specifics — ' +
        '<a href="https://calendly.com/speak-to-gaurav/30min" style="color:#1a73e8;text-decoration:underline;">grab 15 minutes here</a>.</p>\n';
      var _legacyCalIdx = html.lastIndexOf('</div>');
      if (_legacyCalIdx >= 0) {
        html = html.substring(0, _legacyCalIdx) + _legacyCalLine + html.substring(_legacyCalIdx);
      } else {
        html += _legacyCalLine;
      }
    }
  }

  // PATCH 2026-06-11-eq8-finalpolish (S3): Unconditional GitHub link guarantee —
  // legacy prose renderer. Inject-if-absent only. Same lastIndexOf hardening.
  if (html.indexOf('github.com/GauravRIIMK') < 0) {
    var _legacyGhLine = '<p style="margin:0 0 12px 0;">Builder side — three AI tools shipped independently (all live). ' +
      '<a href="https://github.com/GauravRIIMK" style="color:#1a73e8;text-decoration:underline;">github.com/GauravRIIMK</a></p>\n';
    var _legacyGhIdx = html.lastIndexOf('</div>');
    if (_legacyGhIdx >= 0) {
      html = html.substring(0, _legacyGhIdx) + _legacyGhLine + html.substring(_legacyGhIdx);
    } else {
      html += _legacyGhLine;
    }
  }

  // PATCH 2026-06-11-eq8-contentguards (T2): GitHub link deduplication — legacy renderer.
  // Some legacy prose paths also produce >1 occurrence (Config.gs signatureLine2 may already
  // contain the text, and the S3 inject-if-absent can add a second). Keep only first.
  (function() {
    var _ghToken = 'github.com/GauravRIIMK';
    var _ghCount = (html.split(_ghToken).length - 1);
    if (_ghCount > 1) {
      var _firstFound = false;
      html = html.replace(/<a\s[^>]*github\.com\/GauravRIIMK[^>]*>[^<]*<\/a>/gi, function(m) {
        if (!_firstFound) { _firstFound = true; return m; }
        return '';
      });
      Logger.log('[LegacyRenderer] T2-dedup: reduced github.com/GauravRIIMK from ' + _ghCount + ' to 1 occurrence');
    }
  })();

  return html;
}

// ─── SUBJECT LINE BUILDER ────────────────────────────────────

/**
 * Builds the final subject line.
 *
 * STANDARD / HR templates: "Job Application: [topic] | Gaurav Rathore"
 *   Rationale: explicit "Job Application" prefix helps recruiters/hiring
 *   managers triage cold inbound, signals intent clearly, and keeps the
 *   personalized topic (2-5 words from Claude) as the differentiator.
 *
 * CXO_SHORT (Patch 2026-05-19): Leadership Master Template explicitly
 *   FORBIDS the "Job Application:" prefix — it routes leadership emails
 *   to recruiter piles instead of the leader's primary inbox. Claude
 *   emits a full Subject Line Bank pattern (e.g. "Myntra's affiliate
 *   engine - the ops problem most teams miss in year one") and we ship
 *   it as-is after light sanitisation. The " | Gaurav Rathore" suffix
 *   is also dropped — peer-tone subjects don't sign themselves.
 *
 * @param {string} claudeSubject - Topic text from Claude
 * @param {Object} lead - LeadProfile
 * @param {Object} context - Composition context
 * @param {boolean} [isCxoShort] - Skip Job-Application prefix + suffix for leadership template
 * @returns {string} Final subject line
 */
function _buildSubjectLine(claudeSubject, lead, context, isCxoShort) {
  // Sanitize curly quotes first, then strip any prefix Claude may have added
  // (covers "Application:", "Job Application:", "Re:", "Fwd:")
  // PATCH 2026-05-19: For CXO_SHORT, "Re:" is a VALID Subject Line Bank
  // pattern (Pattern C), so do NOT strip it. Strip the other prefixes.
  var rawSubject = _sanitizeText(claudeSubject);
  var clean = isCxoShort
    ? rawSubject.replace(/^(fwd:|job\s*application[:\-]?\s*|application[:\-]?\s*)/i, '').trim()
    : rawSubject.replace(/^(re:|fwd:|job\s*application[:\-]?\s*|application[:\-]?\s*)/i, '').trim();

  // PATCH 2026-06-11-eq8-finalpolish (D2): Org-placeholder blacklist.
  // Claude sometimes writes "at their company" / "at your team" when org context
  // is absent, producing subjects like "Product-Led Growth at their company | ...".
  // Strip the " at <placeholder>" tail from clean so a placeholder org NEVER enters
  // the template. Applied before the fallback so even fallback-built cleans are safe.
  // Also applied inside the S4 guard below (after _orgTail extraction).
  var _PLACEHOLDER_ORG_RE = /^(?:their|your|the|our)\s+(?:company|team|org(?:anization)?|firm)$|^(?:unknown|n\/a|company|team)$/i;
  // Strip " at <placeholder>" from clean if the org part is a known placeholder.
  // Use the same greedy split as S4: last " at " segment.
  (function() {
    var _atIdx = clean.search(/\s+at\s+/i);
    if (_atIdx >= 0) {
      var _roleClean = clean.substring(0, _atIdx).trim();
      var _orgClean  = clean.replace(/^.+?\s+at\s+/i, '').trim();
      if (_PLACEHOLDER_ORG_RE.test(_orgClean)) {
        Logger.log('[SUBJECT_POSITIONING] PATCH eq8-finalpolish (D2): stripped placeholder org "' +
                   _orgClean + '" from subject clean; keeping role-only "' + _roleClean + '"');
        clean = _roleClean;
      }
    }
  })();

  // Fallback topic if Claude returned empty
  if (!clean) {
    var _fbOrg = (lead && lead.organization && !_PLACEHOLDER_ORG_RE.test(lead.organization.trim()))
      ? lead.organization : '';
    clean = isCxoShort
      ? ('Note on ' + (_fbOrg || 'your team') + ' - from a 0-to-1 operator')
      : (_fbOrg ? ('Strategy & Growth at ' + _fbOrg) : 'Strategy & Growth');
  }

  if (isCxoShort) {
    // Leadership subject — Claude already emitted a full Subject Line Bank
    // pattern. Ship as-is after capping length. Mobile truncation hits ~60
    // chars on a clean leader inbox; cap defensively at 70 to leave headroom.
    var CXO_MAX = 70;
    if (clean.length > CXO_MAX) {
      // Truncate at the last sensible boundary (space or hyphen) under the cap
      var truncated = clean.substring(0, CXO_MAX);
      var lastBreak = Math.max(truncated.lastIndexOf(' '), truncated.lastIndexOf(' - '));
      if (lastBreak > CXO_MAX * 0.6) {
        clean = truncated.substring(0, lastBreak).trim();
      } else {
        clean = truncated.trim();
      }
    }
    return clean;
  }

  // STANDARD / HR path — keep "Job Application:" prefix + " | Gaurav Rathore" suffix.
  var PREFIX = 'Job Application: ';
  var SUFFIX = ' | Gaurav Rathore';
  var subject = PREFIX + clean + SUFFIX;

  // Safety: cap at 85 chars (Gmail truncates around 78 on mobile preview, but
  // "Job Application:" + name is the priority content — topic gets trimmed first)
  var MAX_LEN = 85;
  if (subject.length > MAX_LEN) {
    var topicBudget = MAX_LEN - PREFIX.length - SUFFIX.length;
    subject = PREFIX + clean.substring(0, topicBudget).trim() + SUFFIX;
  }

  // PATCH 2026-06-12-template-unify (S5): Thin-subject guard.
  // Fires when the assembled subject lacks the canonical "Job Application:" prefix
  // (e.g. from recomposition paths that return raw Claude subject) OR is < 30 chars
  // total (e.g. "Growth Marketing Role" — thin, no org, no suffix).
  // Rebuild from canonical generator using org from lead when available.
  // Must run BEFORE S4 so S4 sees the fully-prefixed subject string.
  if (subject.indexOf('Job Application:') < 0 || subject.length < 30) {
    Logger.log('[SUBJECT_POSITIONING] PATCH template-unify (S5): thin/non-canonical subject detected — rebuilding. ' +
               'Input: "' + subject + '"');
    var _orgForRebuild = (lead && lead.organization && !_PLACEHOLDER_ORG_RE.test((lead.organization || '').trim()))
      ? lead.organization.trim() : '';
    // Preserve existing clean topic if it contains growth/marketing/strategy keywords
    var _rebuildTopic;
    if (/growth|marketing|strategy/i.test(clean)) {
      _rebuildTopic = clean;
    } else if (_orgForRebuild) {
      _rebuildTopic = 'Growth & Strategy at ' + _orgForRebuild;
    } else {
      _rebuildTopic = 'Growth & Strategy';
    }
    // Re-strip PREFIX if it somehow already got on the topic from the original clean
    _rebuildTopic = _rebuildTopic.replace(/^job\s*application[:\-]?\s*/i, '').trim();
    subject = PREFIX + _rebuildTopic + SUFFIX;
    Logger.log('[SUBJECT_POSITIONING] PATCH template-unify (S5): rebuilt to "' + subject + '"');
  }

  // PATCH 2026-06-11-eq8-finalpolish (S4 / c7): Subject positioning guard.
  // Production evidence (2026-06-11): 4/8 Tier-1 STANDARD subjects violated the
  // Growth/Marketing/Strategy-only rule ("3P Account Management at Amazon",
  // "Direct Sales Scale", "Ops Scale for Global Centers").
  // Conservative guard: only fires when:
  //   (a) the role segment (clean) does NOT contain growth|marketing|strategy,
  //   (b) we are in the STANDARD/HR path (CXO already returned above).
  // Replacement: rebuild subject with 'Growth & Strategy' as role, preserving
  // the " at <Org>" part extracted from `clean` (e.g. "3P Account Management at Amazon"
  // → role="3P Account Management", org="Amazon" → "Growth & Strategy at Amazon").
  // NEVER rewrite if keywords already present. Org extraction uses a greedy
  // " at <last token(s)>" split on the clean string.
  if (!/growth|marketing|strategy/i.test(clean)) {
    // Try to extract an " at <ORG>" tail from the role string
    var _cleanAtMatch = clean.match(/^(.+?)\s+at\s+(.+)$/i);
    if (_cleanAtMatch) {
      var _origRole = (_cleanAtMatch[1] || '').trim();
      var _orgTail  = (_cleanAtMatch[2] || '').trim();
      // PATCH 2026-06-11-eq8-finalpolish (D2): also blacklist placeholder orgs inside S4.
      if (_PLACEHOLDER_ORG_RE.test(_orgTail)) {
        subject = PREFIX + 'Growth & Strategy' + SUFFIX;
        Logger.log('[SUBJECT_POSITIONING] PATCH eq8-finalpolish (D2): S4 placeholder org "' +
                   _orgTail + '" suppressed; subject = role-only Growth & Strategy');
      } else {
        subject = PREFIX + 'Growth & Strategy at ' + _orgTail + SUFFIX;
        Logger.log('[SUBJECT_POSITIONING] PATCH eq8-c6cal-c4strong: replaced role "' + _origRole +
                   '" → "Growth & Strategy" at "' + _orgTail + '"');
      }
    } else if (clean.length > 0) {
      // No "at Org" pattern — clean is just a role phrase; swap the whole thing
      subject = PREFIX + 'Growth & Strategy' + SUFFIX;
      Logger.log('[SUBJECT_POSITIONING] PATCH eq8-c6cal-c4strong: replaced role-only "' + clean +
                 '" → "Growth & Strategy" (no org found)');
    } else {
      // Subject doesn't match any job-application shape — log WARN but do not touch
      Logger.log('[SUBJECT_POSITIONING] WARN eq8-c6cal-c4strong: subject lacks growth/marketing/strategy keywords ' +
                 'but clean is empty — left unchanged: ' + subject);
    }
  }

  return subject;
}

// ─── CONTEXT BUILDING ──────────────────────────────────────

/**
 * Builds context object for composition, including resume highlights.
 */
function _buildCompositionContext(lead, dossier, classification, resumeSelection) {
  // Extract hooks (now with type metadata for richer context)
  var hooks = [];
  if (dossier && dossier.hooks) {
    hooks = dossier.hooks.slice(0, 5).map(function(h) {
      if (typeof h === 'object') {
        var prefix = h.type ? '[' + h.type + '] ' : '';
        return prefix + (h.text || '');
      }
      return String(h);
    });
  }

  var triggerEvents = [];
  if (dossier && dossier.triggerEvents) {
    triggerEvents = dossier.triggerEvents.slice(0, 3).map(function(t) {
      return typeof t === 'object' ? (t.event || '') : String(t);
    });
  }

  var sharedBackground = [];
  if (dossier && dossier.sharedBackground) {
    sharedBackground = dossier.sharedBackground.slice(0, 2);
  }

  // Get resume highlights from GAURAV_PROFILE (defined in Config.gs)
  var resumeVariantId = (resumeSelection && resumeSelection.variantId) || 'GROWTH_MARKETING';
  var gauravAchievements = [];
  if (typeof GAURAV_PROFILE !== 'undefined' && GAURAV_PROFILE[resumeVariantId]) {
    gauravAchievements = GAURAV_PROFILE[resumeVariantId].achievements.slice(0, 6);
  }

  // Canonical 3 work experiences for the template (fixed companies + dates + metrics).
  // The user prompt instructs Claude to keep these and only re-label the category angle.
  var canonicalExperiences = [
    {
      company: 'Blinkit Bistro',
      label: 'current',
      metrics: [
        '~50 cloud kitchens, 4 cities, P&L ownership',
        'Complaint rate cut 94% across 121K orders in 2.5 weeks',
        '13 margin interventions, Rs 5.7L/month uplift',
        '30+ cross-functional stakeholders, 8-tab analytics dashboard'
      ]
    },
    {
      company: 'upGrad',
      label: '2021-23',
      metrics: [
        'Referral funnel 0 to Rs 1.5 Cr in 4 months',
        '100+ career transitions via ABM + MarTech',
        'Cross-functional GTM: product, content, partnerships'
      ]
    },
    {
      company: 'Great Learning',
      label: '2019-20',
      metrics: [
        'B2B partnership pipeline, enterprise clients in first quarter',
        'Revenue from partnerships drove measurable contribution to target',
        'Early-career scale-up in ed-tech sector'
      ]
    }
  ];

  // Extract org challenges
  var orgChallenges = [];
  if (dossier && dossier.company && dossier.company.challenges) {
    var raw = dossier.company.challenges;
    if (typeof raw === 'string') {
      orgChallenges = raw ? [raw] : [];
    } else if (Array.isArray(raw)) {
      orgChallenges = raw.slice(0, 2);
    }
  }

  // NEW: Extract latest news for Claude to use as opening hook material
  var latestNews = '';
  if (dossier && dossier.company && dossier.company.recentNews) {
    latestNews = dossier.company.recentNews;
  } else if (dossier && dossier.recentNews) {
    latestNews = dossier.recentNews;
  }

  // NEW: Extract LinkedIn activity for personalization
  var linkedInActivity = '';
  if (dossier && dossier.recentLinkedInPosts) {
    linkedInActivity = dossier.recentLinkedInPosts;
  }

  // NEW: Bridge statements from resume cross-validation
  var bridgeStatements = [];
  if (dossier && dossier.bridgeStatements && dossier.bridgeStatements.length > 0) {
    bridgeStatements = dossier.bridgeStatements.slice(0, 2);
  }

  // NEW: Best hook angle from AI research
  var bestHookAngle = '';
  if (dossier && dossier.bestHookAngle) {
    bestHookAngle = dossier.bestHookAngle;
  }

  // PATCH 2026-05-16 (Option 5 / Sub-options 2+4): target role intent.
  // Empty → composer frames email as INFORMATIONAL outreach about the
  //   function area. Never claims a specific role is open. CTA is a low-
  //   commitment chat that leaves door open for either info OR role discussion.
  // Non-empty → composer switches to APPLYING framing referencing this role
  //   title. Accepts a job title string OR a JD URL (composer detects).
  var targetRole = (lead && lead.targetRole) ? lead.targetRole.toString().trim() : '';
  var hasTargetRole = !!targetRole;

  // PATCH 2026-05-18 (improvement #3): pull research-derived signals from
  // the classification result so the system prompt can modulate tone /
  // structure based on the recipient's decision power and communication
  // style. Conservative shape: all fields default to safe no-op values
  // so downstream prompt builders can read them without nil checks.
  var researchSignals = (classification && classification.researchSignals) || {};
  var toneAdjustment = (classification && classification.toneAdjustment) || '';

  return {
    leadName: lead.fullName,
    firstName: lead.fullName ? lead.fullName.split(' ')[0] : '',
    designation: lead.designation || 'Professional',
    organization: lead.organization || 'their company',
    archetype: classification.archetype,
    hooks: hooks,
    triggerEvents: triggerEvents,
    sharedBackground: sharedBackground,
    resumeVariant: resumeVariantId,
    industry: dossier && dossier.company ? dossier.company.industry : 'general',
    gauravAchievements: gauravAchievements,
    orgChallenges: orgChallenges,
    // New enriched context
    latestNews: latestNews,
    linkedInActivity: linkedInActivity,
    bridgeStatements: bridgeStatements,
    bestHookAngle: bestHookAngle,
    // Canonical 3-experience bank for the template (companies + dates + metrics)
    canonicalExperiences: canonicalExperiences,
    // PATCH 2026-05-16: target-role intent
    targetRole: targetRole,
    hasTargetRole: hasTargetRole,
    // PATCH 2026-05-18: research-derived signals + accumulated tone overlay
    researchSignals: researchSignals,
    toneAdjustment: toneAdjustment
  };
}

/**
 * PATCH 2026-05-18 (improvement #3): build a focused directive from the
 * research-derived signals. Prepended to the system prompt so it sits
 * at the top of context (LLMs respect early instructions more reliably).
 *
 * Output is intentionally short — 1-3 lines max. The signals modulate
 * existing template behavior, they don't replace it. When no signals
 * fire (medium decision power, generic comm style), returns empty
 * string so the prompt is unchanged from baseline.
 *
 * @param {Object} context - From _buildCompositionContext
 * @returns {string} directive block or empty string
 */
function _buildResearchSignalDirective(context) {
  if (!context || !context.researchSignals) return '';
  var s = context.researchSignals;
  var lines = [];

  if (s.highDecisionPower) {
    lines.push('• RECIPIENT DECISION POWER: HIGH. Open with the strongest '
      + 'concrete signal in sentence 1. Skip throat-clearing ("I noticed", '
      + '"I came across", "I\'ve been following") — they read for substance, '
      + 'not preamble.');
  }
  if (s.dataDrivenStyle) {
    lines.push('• RECIPIENT COMM STYLE: DATA-DRIVEN. The hook paragraph MUST '
      + 'include one specific number (revenue / growth % / headcount / year) '
      + 'in the first two sentences. Bullet metrics stay non-negotiable.');
  }
  if (s.narrativeStyle) {
    lines.push('• RECIPIENT COMM STYLE: NARRATIVE. Lead each experience bullet '
      + 'with the category-label theme (the "why") BEFORE the metric. The '
      + '"thread across all three" synthesis line carries extra weight — make '
      + 'it specific to the recipient\'s strategic concern, not generic.');
  }

  if (lines.length === 0) return '';
  return '## RECIPIENT-AWARE TONE OVERLAY (research-derived, 2026-05-18)\n'
    + 'These are research signals about THIS specific recipient. Apply them '
    + 'WITHIN the canonical template structure — do NOT change the template '
    + 'sections, only modulate the prose:\n'
    + lines.join('\n')
    + '\n\n';
}

// ─── SYSTEM PROMPT ────────────────────────────────────────

/**
 * Builds system prompt for job-seeking cold emails.
 * Enforces the canonical 11-section template structure.
 */
function _buildSystemPrompt(template, approach) {
  // PATCH 2026-05-12: archetype-aware template dispatch
  if (template === 'HR_PARTNERSHIP') return _buildHrSystemPrompt(approach);
  if (template === 'CXO_SHORT')      return _buildCxoSystemPrompt(approach);
  // ...existing STANDARD (BULLET_V1) return follows
  return 'You are a precise job-application cold-email composer. You write personalized cold emails for Gaurav Rathore that follow a CANONICAL TEMPLATE exactly.\n\n' +
    '## CRITICAL: Canonical Template Structure\n' +
    'Every email MUST follow this exact 11-section structure — no exceptions, no reordering:\n\n' +
    'SECTION 1 — GREETING: "Hi <FirstName>," — first name only, no honorifics.\n\n' +
    'SECTION 2 — HOOK PARAGRAPH: Identifies 2-3 SPECIFIC responsibilities from the JD/role posting and threads them with ONE unifying theme. MUST end with the phrase: "...has been my operating reality across N+ years in <industries>." N is derived from Gaurav\'s relevant experience (use 4.5 for ed-tech/quick-commerce, 5 for general ops/strategy). Name the exact responsibilities from the role — do not paraphrase generically.\n\n' +
    'SECTION 3 — BODY HEADER: The bridgeSentence field MUST be the exact phrase "Three 0-to-1 builds that map directly to this role:" (or "Three 0-to-1 builds that most directly answer your ask:" — "Three 0-to-1 builds" is the SIGNATURE phrasing and must appear).\n\n' +
    'SECTION 4 — THREE EXPERIENCE BULLETS (exactly 3, no more, no fewer):\n' +
    '  - The 3 companies are ALWAYS: Blinkit Bistro, upGrad, Great Learning. In that order.\n' +
    '  - Each bullet: label = "<Company> (<years>)", body = "<Category Label>: <role + scope>. <Achievement with quantified metric>. <Cross-functional detail>."\n' +
    '  - The CATEGORY LABEL is the dynamic part — rephrase it to fit the target role angle. Examples:\n' +
    '      For P&L/Account Management roles: "P&L Ownership & Team Scale", "Category Growth & Stakeholder Mgmt", "Scaling Through Partnerships"\n' +
    '      For Ops/Strategy roles: "Station Operations & Margin", "Growth Operations", "B2B Partnership Scale"\n' +
    '      For Growth/GTM roles: "Dark Store GTM & Growth", "Referral Funnel 0-to-1", "EdTech Partnership Funnel"\n' +
    '  - Company 1: label = "Blinkit Bistro (current)" — use Blinkit Bistro achievements from the Key Achievements list.\n' +
    '  - Company 2: label = "upGrad (2021-23)" — use upGrad achievements.\n' +
    '  - Company 3: label = "Great Learning (2019-20)" — use Great Learning / early-career achievements.\n' +
    '  - showLorTag: false for all 3 bullets in this template.\n\n' +
    'SECTION 5 — SYNTHESIS LINE: "The thread across all three: <one-line pattern statement summing up ownership/cross-functional/execution theme>." This MUST appear as a standalone paragraph in motivationParagraph OR as a final line in the last bullet body.\n\n' +
    'SECTION 6 — BUILDER SECTION HEADER: The currentRoleParagraph field MUST be: "On the builder side, three AI tools shipped independently (all live):"\n' +
    '(The 3 tool bullets are rendered automatically — do NOT put tool content in your JSON fields.)\n\n' +
    'SECTION 7 — THREE AI TOOL BULLETS: Rendered automatically from REFERENCE_BLOCKS. Set showAiToolsBlock = true.\n\n' +
    'SECTION 8 — GITHUB LINE: Rendered automatically from REFERENCE_BLOCKS. Do NOT include in your fields.\n\n' +
    'SECTION 9 — CLOSING ASK: closingLogistics = "Based in Gurgaon and available to start immediately. Would value 15 minutes to discuss how this maps to what your team is building at <Company>."\n' +
    '  Replace <Company> with the actual organization name from the lead data.\n\n' +
    'SECTION 10 — RESUME NOTE (fixed): closingResume = "Please find my resume attached below for further details. Would welcome the chance to discuss how this background aligns with what your team is building."\n' +
    '  Use this exact wording every time. Do not paraphrase.\n\n' +
    'SECTION 11 — SIGNOFF: signoffText = "Thanks and regards"\n\n' +
    '## HOOK SELECTION PLAYBOOK — RESEARCH-BACKED RANKING (2026 data)\n' +
    'The hook paragraph (Section 2) identifies role responsibilities AND uses research for the opening angle.\n' +
    'Walk tiers until you find usable concrete material:\n' +
    'TIER 1 — CONTENT/QUOTE HOOK (32% reply): Quote a SPECIFIC line from a LinkedIn post/talk by the lead in last 90 days.\n' +
    'TIER 2 — TRIGGER EVENT HOOK (15-25% reply): Name a specific recent event (funding round, product launch, market entry) from latest news.\n' +
    'TIER 3 — TIMELINE/MILESTONE HOOK (10% reply): Compressed time-bounded growth metric about their org.\n' +
    'TIER 4 — NUMBERS/METRIC HOOK (8.57% reply): One specific quantified public data point.\n' +
    'TIER 5 — INDUSTRY INSIGHT HOOK: Only for C-suite/Founder.\n' +
    'HARD-AVOID: Generic compliments, vague market hooks, problem-callouts without metrics, life-story openers.\n' +
    'NOTE: The hook angle flows INTO the hook paragraph but the hook paragraph still follows the "N+ years in <industries>" ending rule.\n\n' +
    '## OUTPUT FORMAT — STRICT JSON SCHEMA — EVERY FIELD MANDATORY\n' +
    'Return EXACTLY this JSON shape. EVERY field below is MANDATORY — never omit any. Empty strings are NOT acceptable for required fields.\n' +
    'CRITICAL — NEVER verbalize the absence of data. Do NOT write "there is no hook", "No data available", ' +
    '"No match", "N/A", "insufficient data", "as an AI", or any statement that you could not generate content. ' +
    'If the research is thin for a field, write a concrete, true CAPABILITY statement about Gaurav relevant to the ' +
    'recipient\'s function (see HOOK SELECTION PLAYBOOK Tier 5) instead. Every field MUST be present and MUST contain ' +
    'real sendable copy — never a meta-comment about missing data.\n\n' +
    'MANDATORY fields (NEVER omit):\n' +
    '  - subjectLine\n' +
    '  - greeting\n' +
    '  - hookParagraph\n' +
    '  - bridgeSentence (exact text: "Three 0-to-1 builds that map directly to this role:")\n' +
    '  - experienceBullets (exactly 3 items)\n' +
    '  - motivationParagraph (the "thread across all three" synthesis)\n' +
    '  - currentRoleParagraph (exact text: "On the builder side, three AI tools shipped independently (all live):")\n' +
    '  - showAiToolsBlock (boolean, MUST be true for STANDARD)\n' +
    '  - closingLogistics\n' +
    '  - closingResume (exact text: "Please find my resume attached below for further details. Would welcome the chance to discuss how this background aligns with what your team is building.")\n' +
    '  - signoffText (always "Thanks and regards")\n' +
    '  - psLine\n' +
    '  - selectedHookTier (number 1-6)\n\n' +
    'Below is the JSON schema. Match it EXACTLY:\n' +
    '{\n' +
    '  "subjectLine": "2-5 word TOPIC only (no \'Job Application:\' prefix — added automatically)",\n' +
    '  "greeting": "Hi [FirstName]," — first name only. Use "Hi Team [Org]," only if no clean alphabetic first name available. NEVER emit digits or empty names.\n' +
    '  "hookParagraph": "2-3 sentences identifying 2-3 specific JD responsibilities + one unifying theme. MUST end: \'...has been my operating reality across [N]+ years in [industries].\' Under 60 words.",\n' +
    '  "bridgeSentence": "Three 0-to-1 builds that map directly to this role:",\n' +
    '  "experienceBullets": [\n' +
    '    {"label": "Blinkit Bistro (current)", "body": "[Category Label]: [role+scope]. [Achievement with metric]. [Cross-functional detail].", "showLorTag": false},\n' +
    '    {"label": "upGrad (2021-23)", "body": "[Category Label]: [role description]. [Quantified achievement]. [Cross-functional coordination scope].", "showLorTag": false},\n' +
    '    {"label": "Great Learning (2019-20)", "body": "[Category Label]: [role]. [Specific scope detail]. [Why this maps to what target org needs].", "showLorTag": false}\n' +
    '  ],\n' +
    '  "showAiToolsBlock": true,\n' +
    '  "currentRoleParagraph": "On the builder side, three AI tools shipped independently (all live):",\n' +
    '  "motivationParagraph": "The thread across all three: [one-line pattern — ownership/cross-functional/execution].",\n' +
    '  "closingLogistics": "Based in Gurgaon and available to start immediately. Would value 15 minutes to discuss how this maps to what your team is building at [ORG].",\n' +
    '  "closingResume": "Please find my resume attached below for further details. Would welcome the chance to discuss how this background aligns with what your team is building.",\n' +
    '  "signoffText": "Thanks and regards",\n' +
    '  "psLine": "Second concrete signal different from opening hook. 12-28 words. Tied to the org or its space. Peer-level, no sycophancy.",\n' +
    '  "selectedHookTier": 1|2|3|4|5|6\n' +
    '}\n\n' +
    '## EXPERIENCE BULLET RULES\n' +
    '- COMPANY NAME RULES (CRITICAL — DO NOT VIOLATE):\n' +
    '  * The first company is ALWAYS "Blinkit Bistro" — write it as TWO words together.\n' +
    '    NEVER write "Blinkit" alone. NEVER write "Bistro" alone. Both words appear together every time.\n' +
    '  * Tenure at Blinkit Bistro: ~1 year (joined 2025). DO NOT write "three years at Blinkit" or any inflated duration.\n' +
    '  * The second company is "upGrad" (lowercase \'u\', capital \'G\'). Years: 2021-23.\n' +
    '  * The third company is "Great Learning". Years: 2019-20.\n' +
    '  * If the hookParagraph or any bullet body refers back to a past company informally, still use the full name "Blinkit Bistro" — not "Blinkit".\n' +
    '- Exactly 3 bullets. Always the same 3 companies in the same order: Blinkit Bistro, upGrad, Great Learning.\n' +
    '- The ONLY dynamic part is the Category Label at the start of each body. Rephrase it to angle toward the target role.\n' +
    '- Do NOT change the company names, dates, or the quantified metrics — only rephrase the category label and framing.\n' +
    '- Each body: Category Label first (2-4 words, title-case), then colon, then role scope, then 1-2 quantified achievements.\n' +
    '- showLorTag = false for all 3 bullets.\n' +
    '- Pull metrics from the Key Achievements list in the user prompt — do not invent new numbers.\n' +
    '- DO NOT use Markdown emphasis. Plain prose only.\n' +
    '\n' +
    'CORRECT EXAMPLES:\n' +
    '  {"label": "Blinkit Bistro (current)", "body": "P&L Ownership & Team Scale: Senior Manager owning station P&L across ~50 cloud kitchens in 4 cities. Resolved multi-city quality crisis; complaint rate cut by 94%. Coordinated ops, supply chain, and quality teams across 30+ stakeholders.", "showLorTag": false}\n' +
    '  {"label": "upGrad (2021-23)", "body": "Category Growth & Stakeholder Mgmt: Growth Lead building referral funnels from 0 to Rs 1.5 Cr in 4 months. Drove 100+ career transitions via ABM + MarTech. Managed cross-functional GTM across product, content, and partnerships.", "showLorTag": false}\n' +
    '  {"label": "Great Learning (2019-20)", "body": "Scaling Through Partnerships: Built B2B partnership pipeline reaching 3 enterprise clients in first quarter. Revenue from partnerships contributed 20% of target. Maps directly to what you are scaling at [ORG].", "showLorTag": false}\n' +
    '\n' +
    '## STATIC BLOCKS (rendered automatically — do NOT regenerate in your JSON)\n' +
    '- AI Tools bullets (LinkedIn Data Agent / Job Scraping Mailer / Scalar BDA CRM with exact URLs) — rendered when showAiToolsBlock=true.\n' +
    '- GitHub line ("Here\'s what my GitHub has been since Claude Code dropped: github.com/GauravRIIMK") — rendered automatically.\n' +
    '- Resume-attached sentence is in closingResume — use the exact wording from Section 10 above.\n' +
    '- Signature block (Gaurav Rathore, MBA IIM Kozhikode, Thapar, LinkedIn) — rendered automatically.\n\n' +
    '## STYLE RULES\n' +
    '- Direct, no fluff. Action verbs at sentence start (Led, Built, Resolved, Managed, Directed, Drove, Shipped).\n' +
    '- Every claim has a number where possible.\n' +
    '- Signal phrases to keep: "cross-functional", "ownership", "0-to-1".\n' +
    '- No em-dashes. Use " - " or commas instead.\n' +
    '- No "passionate about" or "excited to" type filler.\n' +
    '- Confident but not boastful: facts over adjectives.\n' +
    '- HUMBLE TONE (CRITICAL — 2026-05-12): Minimize first-person pronouns. \n' +
    '  • In experience bullets: START WITH AN ACTION VERB, never with "I". Wrong: "I led the migration". Right: "Led the migration".\n' +
    '  • In hookParagraph: at most ONE "my" or "I" (e.g. "my operating reality" is fine; "I am" / "I have" / "I have been" is NOT).\n' +
    '  • In psLine: prefer noun phrases or impersonal constructions over "I am" / "I have".\n' +
    '  • Forbidden phrasings: "I am excited", "I would love", "I am looking", "I have been", "I want to", "I hope", "I believe". Replace with impersonal alternatives (e.g., "Would value", "Open to", "Available immediately").\n' +
    '  • Goal: the email reads as humble + respectful, like presenting facts rather than self-promoting.\n' +
    '- Tone: ' + (approach || 'professional') + '\n\n' +
    '## GRAMMAR DISCIPLINE (PATCH 2026-05-13)\n' +
    '- Every sentence must parse cleanly. Read each bullet aloud — if it stumbles, rewrite.\n' +
    '- No run-ons. Max 22 words per sentence. Break with periods, not commas.\n' +
    '- Subject-verb agreement: "GTM execution that maps to" (singular) vs "Builds that map to" (plural).\n' +
    '- Tense consistency within a bullet: past-tense achievements stay past tense; do not flip to present halfway through.\n' +
    '- Article discipline: "led the migration" not "led migration"; "owned the P&L" not "owned P&L".\n' +
    '- Comma splice forbidden: do NOT join two independent clauses with a comma. Use a period or semicolon.\n' +
    '- Bullet body shape MUST be: "<Category Label>: <Role + Scope>. <Quantified Achievement>. <Cross-functional Detail>." — three crisp sentences, period-separated. Never one giant run-on.\n' +
    '- No vague qualifiers: "various", "several", "many", "some" — replace with a number or remove.\n' +
    '- No nominalizations: prefer verbs ("scaled the team") over nouns ("the scaling of the team").\n' +
    '- Parallel structure across the 3 bullets: if bullet 1 starts with "P&L Ownership & Team Scale", bullets 2 and 3 also start with title-case noun phrases of similar length.\n\n' +
    '## STRICT FORMATTING\n' +
    '- NEVER use em-dash (use " - " or comma).\n' +
    '- NEVER use curly/smart quotes. Straight quotes only.\n' +
    '- Plain ASCII only.\n\n' +
    '## BANNED CONTENT\n' +
    '- "hire me", "please consider me", "looking for a position", "give me a chance"\n' +
    '- Banned openers: "I hope this email finds you well", "My name is", "I am reaching out because", "I wanted to reach out", "I came across your profile", "Sorry to bother you"\n' +
    '- Phone numbers of any kind in body, greeting, P.S., or subject\n' +
    '- Any mention of "attached", "resume", "CV", "pdf" in hookParagraph, bridgeSentence, or experienceBullets bodies\n' +
    '- Spam words: free, urgent, act now, guaranteed, click here\n\n' +
    '## ANTI-HALLUCINATION\n' +
    'Gaurav\'s ONLY educational institutions: IIM Kozhikode (MBA), Thapar University (B.E.).\n' +
    'Gaurav\'s work history: Blinkit Bistro/Zomato (current), upGrad (2021-23), Great Learning (2019-20), Shiprocket.\n' +
    'NEVER claim alumni connection to any other institution.\n' +
    'If research mentions "Great Learning" as the LEAD\'s company — that is the lead\'s employer, NOT a confusion with Gaurav\'s past role. Gaurav did work at Great Learning 2019-20; reference it as such.\n\n' +
    // PATCH -eq8-draftpolish (F7): hard role-positioning constraint
    // PATCH 2026-06-12-strategy-tilt: strengthened to explicit Strategy/Marketing/Growth-first mandate;
    // Operations is supporting evidence only — never subject-line or lead descriptor.
    '## ROLE POSITIONING (STRICT)\n' +
    'Position Gaurav as a STRATEGY, MARKETING & GROWTH leader. Operations is supporting evidence only — NEVER in the subject line, NEVER the lead descriptor of his profile. ' +
    'Subject line AND body must target Strategy, Marketing, and Growth functions first. ' +
    'NEVER position for: pure operations/supply-chain roles, engineering, product management, data science, HR, finance. ' +
    'If the lead\'s function is outside Growth/Marketing/Strategy, bridge to how Growth/Marketing/Strategy expertise serves THEIR org.\n\n' +
    // PATCH 2026-06-23 (identity-wall-standard): the STANDARD path lacked the identity
    // wall the HR prompt has, so the composer MIRRORED the recipient's specialized
    // function onto Gaurav (Suma "Campus & Alternate Channels" -> the whole email framed
    // around "talent pipeline / talent acquisition", misrepresenting Gaurav as doing
    // talent ops). This wall generalizes the HR guard to EVERY non-HR/non-CXO lead.
    '## IDENTITY WALL (CRITICAL — THE RECIPIENT\'S FUNCTION NEVER BECOMES GAURAV\'S)\n' +
    'The recipient\'s role facts describe THEM, not Gaurav. Gaurav\'s REAL domains are ONLY: strategy, ' +
    'growth, marketing, quick-commerce operations (Blinkit Bistro), and ed-tech (upGrad / Great Learning). ' +
    'He has ZERO experience in any specialized function outside those — e.g. talent acquisition / recruiting / ' +
    'campus hiring / people-ops / HR, L&D, finance, legal, engineering, product management, data science, or ' +
    'pure supply-chain.\n' +
    '- NEVER attribute the recipient\'s specialized function to Gaurav and NEVER frame his relevance AS that ' +
    'function. WRONG (the Suma failure): "expanding the talent pipeline... has been my operating reality"; ' +
    '"campus and alternate channels become the front line for talent acquisition at scale". Gaurav does NOT do ' +
    'talent acquisition, recruiting, or campus hiring.\n' +
    '- Bridge ONLY via TRANSFERABLE skills (GTM, funnel velocity, channel partnerships, P&L, stakeholder ' +
    'coordination, 0-to-1 builds) and how they SERVE the recipient\'s org — never claim Gaurav performs the ' +
    'recipient\'s job.\n' +
    '- Do NOT relabel an ambiguous recipient title into a specialized function it does not explicitly state. ' +
    '"Campus & Alternate Channels" is a CHANNELS / GTM / distribution role unless the headline LITERALLY says ' +
    'recruiting / talent / hiring — do not turn it into "talent acquisition" or "talent pipeline".\n' +
    '- The "...has been my operating reality across N+ years in ed-tech and quick-commerce" clause describes ' +
    'GAURAV\'s real domains — it must NEVER be bent to describe the recipient\'s function.\n' +
    '- FORBIDDEN first-person attributions (any phrasing): talent acquisition, talent pipeline, recruiting, ' +
    'sourcing, hiring pipeline, employer brand, people ops, HR — and any other function that is not ' +
    'strategy / growth / marketing / quick-commerce-ops / ed-tech.\n';
}

// ─── ARCHETYPE SYSTEM PROMPTS (PATCH 2026-05-12) ────────────

/**
 * HR/Recruiter-archetype system prompt.
 * Frames Gaurav as a CANDIDATE for Growth/Marketing/Ops roles their team hires for.
 */
function _buildHrSystemPrompt(approach) {
  return 'You are a precise cold-email composer. The recipient is an HR / Talent / People-Ops contact at the target organization. Gaurav Rathore is pitching himself as a CANDIDATE for Growth, Marketing, or Operations roles their team typically hires for — NOT pitching them on their own job.\n\n' +
    '## STRUCTURE (7 sections)\n' +
    'SECTION 1 — GREETING: "Hi <FirstName>,"\n' +
    'SECTION 2 — HOOK: 1-2 sentences referencing the type of Growth/Marketing/Ops roles their team typically scales. Keep it generic enough to span Growth Manager / Marketing Lead / Ops Lead / Strategy Manager.\n' +
    'SECTION 3 — CANDIDATE FRAME: 1 sentence — "4.5+ years across quick-commerce ops and ed-tech growth — the kind of operator profile that fits Growth Manager / Marketing Lead / Ops Lead roles at Series B/C+ orgs."\n' +
    'SECTION 4 — THREE BULLETS (same companies, reframed for candidate angle): Blinkit Bistro / upGrad / Great Learning. Each bullet MUST be metric-led and MUST be 18 words or fewer. Format: "<Category Label>: <quantified outcome>. <cross-functional scope>." No prose paragraphs — structured bullets only.\n' +
    'SECTION 5 — AI TOOLS BLOCK: include only if the org has an obvious tech/product layer. Set showAiToolsBlock based on dossier. If org is non-tech (consulting, BFSI ops), set false.\n' +
    'SECTION 6 — CTA: "If Growth, Marketing, or Operations roles are open or upcoming on your team, happy to send across a resume and connect for 10 minutes."\n' +
    'SECTION 7 — SIGNOFF (Thanks and regards,) + signature appended automatically.\n\n' +
    '## OUTPUT JSON\n' +
    '{\n' +
    '  "subjectLine": "<2-5 word topic — e.g. \'Growth / Ops candidate for [ORG]\' or \'Re: Growth Manager openings\'>",\n' +
    '  "greeting": "Hi [FirstName],",\n' +
    '  "hookParagraph": "<1-2 sentences about Growth/Marketing/Ops roles they hire for>",\n' +
    '  "bridgeSentence": "Three 0-to-1 builds that show what this looks like in practice:",\n' +
    '  "experienceBullets": [\n' +
    '    {"label": "Blinkit Bistro (current)", "body": "<category label>: <metric-led outcome, max 18 words>", "showLorTag": false},\n' +
    '    {"label": "upGrad (2021-23)", "body": "<category label>: <metric-led outcome, max 18 words>", "showLorTag": false},\n' +
    '    {"label": "Great Learning (2019-20)", "body": "<category label>: <metric-led outcome, max 18 words>", "showLorTag": false}\n' +
    '  ],\n' +
    '  "showAiToolsBlock": true,\n' +
    '  "currentRoleParagraph": "On the builder side, three AI tools shipped independently (all live):",\n' +
    '  "motivationParagraph": "",\n' +
    '  "closingLogistics": "If Growth, Marketing, or Operations roles are open or upcoming at <ORG>, happy to send across a resume and connect for 10 minutes.",\n' +
    '  "closingResume": "Please find my resume attached below for further details. Would welcome the chance to discuss how this background aligns with what your team is building.",\n' +
    '  "signoffText": "Thanks and regards",\n' +
    '  "psLine": "<one concrete signal about org or recent hiring pattern>",\n' +
    '  "selectedHookTier": 1,\n' +
    '  "templateId": "HR_RECRUITER"\n' +
    '}\n\n' +
    '## EXPERIENCE BULLETS (CRITICAL — DO NOT OMIT)\n' +
    '- experienceBullets MUST contain EXACTLY 3 items — one per role: Blinkit Bistro, upGrad, Great Learning.\n' +
    '- Each item MUST be a JSON object with "label" and "body" fields.\n' +
    '- Each body MUST be metric-led and MUST be 18 words or fewer. No prose paragraphs. No full sentences — short quantified bullets.\n' +
    '- NEVER collapse all three roles into a single prose paragraph.\n' +
    '- NEVER return experienceBullets as an empty array [].\n' +
    '- NEVER put experience prose in bodyParagraphs — use experienceBullets exclusively.\n\n' +
    '## COMPANY NAME RULES (CRITICAL — DO NOT VIOLATE)\n' +
    '- The first company is ALWAYS "Blinkit Bistro" — write it as TWO words together.\n' +
    '  NEVER write "Blinkit" alone. NEVER write "Bistro" alone. Both words appear together every time.\n' +
    '- Tenure at Blinkit Bistro: ~1 year (joined 2025). DO NOT write "three years at Blinkit" or any inflated duration.\n' +
    '- The second company is "upGrad" (lowercase \'u\', capital \'G\'). Years: 2021-23.\n' +
    '- The third company is "Great Learning". Years: 2019-20.\n' +
    '- If the hookParagraph or any bullet body refers back to a past company informally, still use the full name "Blinkit Bistro" — not "Blinkit".\n\n' +
    // PATCH 2026-06-12-strategy-tilt: TA identity wall — recipient facts describe THEM, never Gaurav.
    '## IDENTITY WALL — CRITICAL: RECIPIENT DOMAIN NEVER BECOMES GAURAV\'S DOMAIN\n' +
    'The recipient is a recruiter/TA/HR professional. Their job facts describe THEM, NOT Gaurav.\n' +
    'Gaurav is a CANDIDATE writing TO a recruiter — he has ZERO recruiting, talent-acquisition, employer-branding, ' +
    'hiring-pipeline, or sourcing-pipeline experience and you must NEVER attribute the recipient\'s domain to him.\n' +
    'His hook must reference HIS real domains: strategy, growth, marketing, quick-commerce (Blinkit Bistro), ' +
    'ed-tech (upGrad / Great Learning) and why he would be a strong candidate for roles THEY hire for.\n' +
    'NEVER write first-person sentences that claim Gaurav has TA/talent-acquisition/recruiting experience.\n' +
    'FORBIDDEN patterns (any form): "Scaling TA functions", "driving employer brand", "coordinating hiring pipelines", ' +
    '"my operating reality in talent acquisition", "sourcing pipelines", "recruitment experience".\n\n' +
    '## STYLE RULES\n' +
    '- Frame Gaurav as a CANDIDATE, not as someone pitching the HR person directly.\n' +
    '- Mention specific role TYPES the org hires for (Growth Manager, Marketing Lead, Ops Manager, Strategy Lead, Generalist).\n' +
    '- Humble tone: minimize "I" pronouns. Action verbs at bullet start.\n' +
    '- No fluff. Every claim has a number where possible.\n' +
    '- NEVER pitch the HR person on their own role.\n' +
    '- No em-dashes. Straight quotes only. Plain ASCII.\n' +
    '- Tone: ' + (approach || 'professional, respectful, candidate-positioned') + '\n';
}

/**
 * CXO/Founder-archetype system prompt (Patch 2026-05-19 — Leadership Master Template).
 *
 * Rewritten to match the Founder-Grade Playbook research (2023-2025) audit:
 *   - 5 lines of body, 95-115 words total, ONE CTA, ONE P.S., NO banner.
 *   - Sentence-case subject from the 10-pattern Subject Line Bank (NO
 *     "Job Application:" prefix — that routes leadership emails to recruiter
 *     piles instead of the leader's primary inbox).
 *   - Closing resume mention is CUT for CXO (one CTA principle — Calendly
 *     already lowered cost of replying; redundant resume ask reduces response).
 *   - Single-source-of-truth structure: HOOK -> CREDIBILITY -> BRIDGE -> ASK.
 */
function _buildCxoSystemPrompt(approach) {
  return 'You are a precise cold-email composer for Founders, CXOs, VPs and Heads-Of. They have ~16 seconds of attention on first read. Every line must earn its place by (a) proving research, (b) proving capability, or (c) lowering their cost of replying. Etiquette padding is rude — it costs THEIR time.\n\n' +
    '## CANONICAL STRUCTURE — 5 sections, total body 95-115 words\n' +
    'SECTION 1 — GREETING: "Hi <FirstName>,"\n' +
    'SECTION 2 — HOOK (hookParagraph field) — 1 sentence, 18-22 words. Anchor in something SPECIFIC they just did: a launch, a hire, a public statement, a funding round, a regional move. Frame the second-order implication you noticed — the part most people miss.\n' +
    'SECTION 3 — CREDIBILITY (motivationParagraph field) — 1-2 sentences, 30-40 words. Two brand-anchored, numeric outcomes. Lead with the recognisable brand name + number. End with one short phrase on the kind of operator you are (e.g. "Builder who ships the ops layer most teams don\'t see until it breaks." or "Generalist who owns numbers, builds the team, and automates the manual layer in parallel.").\n' +
    'SECTION 4 — BRIDGE (bridgeSentence field) — 1 sentence, 15-20 words. Why YOU are the lever for THEIR specific problem. Format: "If <Company> is looking for someone who can <specific verb + scope>, <low-friction value offer like one-page memo or first-30-days plan>."\n' +
    'SECTION 5 — THE ONE ASK (closingLogistics field) — 1 sentence, 12-18 words. Two-option, low-cost, time-bounded. Format: "15 minutes Tue or Thu — happy to share what I\'d build in the first 30 days, whichever is easier."\n\n' +
    'SIGNATURE (rendered separately, do NOT emit in any field): provenance line + LinkedIn.\n' +
    'P.S. (psLine field) — 12-25 words. ONE memorable differentiator — numeric if possible. This is the most under-utilised real estate in cold email — make it forwardable.\n\n' +
    // PATCH 2026-06-12-strategy-tilt: updated CXO JSON contract to include
    // experienceBullets (2-3 metric-led, ≤18 words each) + templateId discriminator.
    '## OUTPUT JSON (return ONLY this object, no markdown, no code blocks)\n' +
    '{\n' +
    '  "subjectLine": "<pattern from the Subject Line Bank below — sentence case, under 60 chars, NO \'Job Application:\' prefix>",\n' +
    '  "greeting": "Hi <FirstName>,",\n' +
    '  "hookParagraph": "<HOOK — 1 sentence, 18-22 words, specific trigger + second-order implication>",\n' +
    '  "bridgeSentence": "<BRIDGE — 1 sentence, 15-20 words, \'If <Company> is looking for someone who can ...\'>",\n' +
    '  "experienceBullets": [\n' +
    '    {"label": "<Company name>", "body": "<metric-led outcome, ≤18 words>", "showLorTag": false},\n' +
    '    {"label": "<Company name>", "body": "<metric-led outcome, ≤18 words>", "showLorTag": false}\n' +
    '  ],\n' +
    '  "showAiToolsBlock": false,\n' +
    '  "currentRoleParagraph": "",\n' +
    '  "motivationParagraph": "<CREDIBILITY operator phrase — 1 sentence, ≤20 words, summarises the pattern across the bullets above>",\n' +
    '  "closingLogistics": "<ASK — 1 sentence, 12-18 words, two-option low-cost time-bounded>",\n' +
    '  "closingResume": "",\n' +
    '  "signoffText": "Thanks and regards",\n' +
    '  "psLine": "<P.S. — 12-25 words, ONE memorable differentiator, numeric if possible>",\n' +
    '  "selectedHookTier": 1,\n' +
    '  "templateId": "CXO_SHORT"\n' +
    '}\n\n' +
    '## EXPERIENCE BULLETS FOR CXO (2-3 items)\n' +
    '- Emit 2-3 experienceBullets from Gaurav\'s three companies (upGrad, Blinkit Bistro, Great Learning).\n' +
    '- Each bullet: {"label": "<company name>", "body": "<metric-led outcome, ≤18 words>"}.\n' +
    '- Pick the 2-3 outcomes that MOST directly map to the recipient\'s org/function.\n' +
    '- motivationParagraph becomes a 1-sentence operator-phrase summary of the pattern across bullets (≤20 words), NOT a restatement of the bullets.\n' +
    '- showAiToolsBlock MUST be false — no AI tools block for CXO.\n\n' +
    '## SUBJECT LINE BANK — pick the pattern that best fits the recipient signal\n' +
    'A. {Their trigger event} - {one-line implication}        e.g. "Myntra\'s affiliate engine - the ops problem most teams miss in year one"\n' +
    'B. {First} | Gaurav intro - {role / sharp credential}    e.g. "Saumya | Gaurav intro - built creator ops infra at upGrad + Blinkit Bistro"\n' +
    'C. Re: {their content reference}                          e.g. "Re: your Inc42 piece on affiliate margins - a builder\'s note"\n' +
    'D. {Specific role / function angle}                       e.g. "Founding ops hire for creator infrastructure - track record attached"\n' +
    'E. {Your Co} <> {Their Co} - {bold one-line thesis}      e.g. "upGrad ops <> Myntra creator economy - the next AI-native wedge"\n' +
    'F. {Public milestone} - perspective from someone who\'s lived it\n' +
    'G. Quick note before {their event / launch / quarter}\n' +
    'H. {Number / metric} that explains {their problem}        e.g. "3 reasons creator-led GMV plateaus at scale - and the fix"\n' +
    'I. One question on {their function / strategy}            e.g. "One question on Myntra\'s affiliate take-rate model"\n' +
    'J. {Mutual context} - {sharp credential}                  e.g. "IIM-K + ex-Great Learning - note on Myntra creator ops"\n\n' +
    'SUBJECT RULES (must comply ALL):\n' +
    '- Under 60 characters (mobile truncates beyond that).\n' +
    '- Sentence case only. Title Case Reads Salesy.\n' +
    '- Zero exclamation marks, zero emoji, zero ALL-CAPS, zero "[!]" / "!!" patterns.\n' +
    '- NEVER start with "Job Application:" — it routes you to a recruiter pile, not the leader\'s inbox.\n' +
    '- When uncertain between two patterns, pick the MORE SPECIFIC one. Specificity always wins over cleverness.\n\n' +
    '## COMPANY NAME RULES (CRITICAL — DO NOT VIOLATE)\n' +
    '- The first company is ALWAYS "Blinkit Bistro" — write it as TWO words together.\n' +
    '  NEVER write "Blinkit" alone. NEVER write "Bistro" alone. Both words appear together every time.\n' +
    '- Tenure at Blinkit Bistro: ~1 year (joined 2025). DO NOT write "three years at Blinkit" or any inflated duration.\n' +
    '- The second company is "upGrad" (lowercase \'u\', capital \'G\'). Years: 2021-23.\n' +
    '- The third company is "Great Learning". Years: 2019-20.\n\n' +
    '## NEVER INCLUDE (auto-rejection patterns — burn the email if any appear)\n' +
    '- "I hope this email finds you well." — Dead phrase. Wastes your only first line.\n' +
    '- "My name is Gaurav and I am looking for opportunities..." — Zero signal. Self-referential opener.\n' +
    '- "Please find my resume attached for further details." — Self-evident; cuts into your one CTA.\n' +
    '- "Would welcome the chance to discuss..." — Vague. Passive. Replace with a specific time ask.\n' +
    '- "Looking forward to hearing from you." — Generic closer that suppresses reply rates.\n' +
    '- "youngest department lead at Great Learning" / "youngest to lead at Great Learning" / any "youngest" framing about Great Learning. STRICTLY FORBIDDEN. Use any OTHER memorable credential in P.S. instead.\n' +
    '- "Sir/Ma\'am", "sincerely yours", Caps Lock blocks, multiple emojis.\n' +
    '- Banner image / illustration / GIF references in any field.\n' +
    '- More than ONE CTA. The closingLogistics field IS the CTA. No redundant ask paragraph.\n\n' +
    '## STYLE RULES\n' +
    '- Target body word count: 95-115 words (excluding greeting + signoff + signature + P.S.).\n' +
    '- NO experience bullets. NO AI-tools block header. NO "Three 0-to-1 builds" phrase. NO "On the builder side..." header. Those belong to the STANDARD template, not the CXO/leadership template.\n' +
    '- The credentials live INLINE in motivationParagraph as brand-anchored numeric outcomes — not as bullets.\n' +
    '- Each sentence in the body must earn its place by (a) demonstrating research, (b) proving capability, or (c) lowering cost of replying.\n' +
    '- Plain ASCII only. No em-dashes (use " - " or hyphen). No smart quotes. No ellipsis characters.\n' +
    '- Humble tone: minimise "I" pronouns. Action verbs at sentence start where possible.\n' +
    '- Every claim has a number where one exists. Brand + number > adjective + adjective.\n' +
    '- Tone: ' + (approach || 'executive brief, peer-to-peer, high signal density') + '\n\n' +
    // PATCH 2026-06-23 (identity-wall-cxo): same wall as STANDARD/HR — the recipient's
    // specialized function never becomes Gaurav's (closes the cross-template mirroring root).
    '## IDENTITY WALL (CRITICAL — RECIPIENT\'S FUNCTION NEVER BECOMES GAURAV\'S)\n' +
    'Gaurav\'s REAL domains are ONLY strategy, growth, marketing, quick-commerce ops (Blinkit Bistro), and ' +
    'ed-tech (upGrad / Great Learning). NEVER attribute the recipient\'s specialized function (e.g. talent ' +
    'acquisition / recruiting / campus hiring / HR, finance, legal, engineering, product, data science, pure ' +
    'supply-chain) to Gaurav or frame his relevance AS it. "Mapping to their org" means showing how his GTM / ' +
    'growth / strategy / ops track record SERVES their org — never claiming he performs their job. Do not ' +
    'relabel an ambiguous recipient title into a specialized function its headline does not state.\n';
}

// ─── ARCHETYPE USER PROMPTS (PATCH 2026-05-12) ────────────

/**
 * HR/Recruiter-archetype user prompt.
 * Builds lead context + canonical experience bank for the HR email.
 */
function _buildHrUserPrompt(lead, context, classification, resumeSelection) {
  var org = context.organization || lead.organization || '<their org>';
  var first = (lead.fullName || '').split(' ')[0] || lead.firstName || 'there';
  // PATCH 2026-06-11-eq8-contentguards (T4): canonical facts prepended first.
  var prompt = _buildCanonicalRecipientFacts(lead);
  prompt += 'Compose an HR/Recruiter cold email per the system prompt structure.\n\n' +
    'LEAD CONTEXT:\n' +
    '  Name: ' + (lead.fullName || '') + '\n' +
    '  Title: ' + (lead.designation || lead.headline || '') + '\n' +
    '  Org: ' + org + '\n' +
    '  Industry: ' + (lead.industry || (classification && classification.industry) || '') + '\n\n' +
    'CANONICAL EXPERIENCE BANK (3 companies, dates, metrics — reframe category labels per HR template):\n' +
    '  - Blinkit Bistro (current): P&L across ~50 cloud kitchens, 4 cities; complaint rate -74%; 30+ cross-functional stakeholders\n' +
    '  - upGrad (2021-23): Referral funnel 0 to Rs 1.5 Cr in 4 months; 14 cross-functional teams; 11 hybrid convocations 150%+ R2A\n' +
    '  - Great Learning (2019-20): B2B partnerships across 50+ nations; built the international vertical from zero; led university + enterprise channel partnerships end-to-end (NEVER use the word "youngest" anywhere — strictly forbidden)\n\n';

  // Inject available research signals
  if (context.latestNews && context.latestNews.length > 10) {
    prompt += 'LATEST NEWS (for psLine): ' + context.latestNews + '\n';
  }
  if (context.bestHookAngle && context.bestHookAngle.length > 10) {
    prompt += 'HOOK ANGLE: ' + context.bestHookAngle + '\n';
  }

  prompt += '\nOUTPUT: valid JSON only, matching the system-prompt schema for HR_PARTNERSHIP. Greeting "Hi ' + first + ',".';
  return prompt;
}

/**
 * CXO/Founder-archetype user prompt (Patch 2026-05-19 — Leadership Master Template).
 *
 * Builds lead context + brand-anchored numeric credential bank for the
 * 5-line leadership email. The credential bank is curated for CREDIBILITY
 * (motivationParagraph) — pick 2 outcomes that map best to the recipient's
 * org/function, then add the operator phrase.
 *
 * FORBIDDEN: any "youngest" framing about Great Learning anywhere in the
 * output. The system prompt enforces this; the user prompt deliberately
 * omits that framing from the credential bank so the model has no anchor
 * to fall back on.
 */
function _buildCxoUserPrompt(lead, context, classification, resumeSelection) {
  var org = context.organization || lead.organization || '<their org>';
  var first = (lead.fullName || '').split(' ')[0] || lead.firstName || 'there';
  var industry = (lead.industry || (classification && classification.industry) || 'their space').toString();
  var seniority = (classification && classification.seniority) || '';
  // PATCH 2026-06-11-eq8-contentguards (T4): canonical facts prepended first.
  var prompt = _buildCanonicalRecipientFacts(lead);
  prompt += 'Compose a leadership cold email per the system prompt — 5 body lines, 95-115 words, ONE CTA, ONE P.S., NO banner, NO resume mention paragraph (Calendly already lowered cost of replying).\n\n' +
    'LEAD CONTEXT:\n' +
    '  Name: ' + (lead.fullName || '') + '\n' +
    '  Title: ' + (lead.designation || lead.headline || '') + '\n' +
    '  Seniority: ' + seniority + '\n' +
    '  Org: ' + org + '\n' +
    '  Industry: ' + industry + '\n' +
    '  Recent signals: ' + (context.dossierSummary || context.bestHookAngle || context.latestNews || 'unknown') + '\n\n' +
    'BRAND-ANCHORED CREDENTIAL BANK (pick the 2 outcomes that map BEST to ' + org + '\'s current problem; lead motivationParagraph with the recognisable brand + number):\n' +
    '  - upGrad (2021-23): Built 0-to-1 referral funnel to Rs 1.5 Cr in 4 months; ~6% incremental monthly revenue; 14 cross-functional teams; 100+ career transitions via ABM + MarTech.\n' +
    '  - Blinkit Bistro (current): Senior Manager P&L across ~50 cloud kitchens in 4 cities; complaint rate cut 94% across 121K orders; 30+ cross-functional stakeholders; 13 margin interventions.\n' +
    '  - Great Learning (2019-20): Built the international vertical from zero; B2B partnerships scaling across 50+ countries; led enterprise channel and university partnerships end-to-end. (NEVER use the word "youngest" — strictly forbidden.)\n' +
    '  - Builder/AI angle (use sparingly, only when relevant to the recipient): 3 AI tools shipped solo (LinkedIn Data Agent, Job Scraping Mailer, Scalar BDA CRM); GitHub.com/GauravRIIMK.\n\n' +
    'OPERATOR-PHRASE OPTIONS for ending the CREDIBILITY paragraph (pick or remix; keep humble, no superlatives):\n' +
    '  - "Generalist who owns the number, builds the team around it, and automates the manual layer in parallel."\n' +
    '  - "Builder who ships the operating layer most teams don\'t see until it breaks."\n' +
    '  - "Operator who has scaled zero-to-one across borders, categories, and stakeholders without dedicated tooling."\n' +
    '  - "Hands-on operator on the number, hands-on builder on the system around it."\n\n' +
    'BRIDGE-SENTENCE TEMPLATES (pick the one that matches recipient seniority, then specialise the verb + scope to their org):\n' +
    '  - "If ' + org + ' is hiring someone to own <function> end-to-end, happy to share what I\'d build in the first 30 days."\n' +
    '  - "If you\'re thinking about a founding-ops or BD hire in the next two quarters, would 15 minutes be useful?"\n' +
    '  - "If the team is hiring for a senior IC or manager who can own the ops + automation stack from day one, I\'d value 15 minutes to learn what you\'re solving."\n\n' +
    'ASK-LINE TEMPLATES (pick or remix; must be two-option, low-cost, time-bounded — NEVER add a second CTA):\n' +
    '  - "15 minutes Tue or Thu - happy to share the first-30-days plan, whichever is easier."\n' +
    '  - "Tue or Thu next week — or happy to send a one-page memo on <topic>, whichever is easier."\n' +
    '  - "Worth 15 minutes? Or a one-page memo on <topic> if that is faster for you."\n\n' +
    'P.S. OPTIONS (pick ONE, 12-25 words, must be NUMERIC if possible, must NOT mention "youngest"):\n' +
    '  - "Built upGrad\'s referral funnel from 0 to Rs 1.5 Cr in 4 months - same zero-to-one playbook for ' + org + '\'s <function>."\n' +
    '  - "Ran ops for ~50 cloud kitchens at Blinkit Bistro across 4 cities and 30+ stakeholders without dedicated tooling."\n' +
    '  - "Scaled B2B partnerships across 50+ countries at Great Learning - operator who has shipped cross-border before."\n' +
    '  - "3 AI tools shipped solo this year (LinkedIn Data Agent, Job Scraping Mailer, Scalar BDA CRM) - building the partner-ops layer leaders ask about."\n\n' +
    'SUBJECT LINE — pick the SINGLE best pattern from the Subject Line Bank in the system prompt (sentence case, under 60 chars, NO "Job Application:" prefix). Specificity > cleverness. If unsure, default to Pattern A or B for founders, C or D for VPs/CXOs.\n\n';

  // Inject trigger events if available
  if (context.triggerEvents && context.triggerEvents.length > 0) {
    prompt += 'TRIGGER EVENTS (use ONE for HOOK — strongest specific signal wins): ' + context.triggerEvents.join(' | ') + '\n';
  }
  if (context.latestNews && context.latestNews.length > 10) {
    prompt += 'LATEST NEWS (alternate HOOK source): ' + context.latestNews + '\n';
  }
  if (context.linkedInActivity && context.linkedInActivity.length > 10) {
    prompt += 'LEAD LINKEDIN ACTIVITY (best when specific): ' + context.linkedInActivity + '\n';
  }
  if (context.bestHookAngle && context.bestHookAngle.length > 10) {
    prompt += 'RESEARCHED HOOK ANGLE: ' + context.bestHookAngle + '\n';
  }
  if (context.orgChallenges && context.orgChallenges.length > 0) {
    prompt += 'ORG CHALLENGES (use for BRIDGE second-order implication): ' + context.orgChallenges.join(' | ') + '\n';
  }

  prompt += '\nFINAL CHECK BEFORE OUTPUT — ALL must be true:\n' +
    '  1. Body word count between 95 and 115 (excludes greeting, signoff, signature, P.S.).\n' +
    '  2. Subject line does NOT start with "Job Application:" — must be a Subject Line Bank pattern.\n' +
    '  3. Hook references something SPECIFIC about ' + org + ' — not generic role/function.\n' +
    '  4. CREDIBILITY paragraph has 2 brand-anchored NUMERIC outcomes + 1 operator phrase.\n' +
    '  5. BRIDGE sentence begins "If ' + org + ' ..." or "If you ..." — sets up the ask without being the ask itself.\n' +
    '  6. closingLogistics is the ONLY ask. closingResume MUST be empty string "".\n' +
    '  7. P.S. has NO mention of "youngest" anywhere. STRICTLY FORBIDDEN. Use a different credential.\n' +
    '  8. Body contains NO em-dashes, NO smart quotes, NO ellipsis, NO banner reference, NO bullet block.\n' +
    '\nOUTPUT: valid JSON only matching the CXO leadership schema. Greeting "Hi ' + first + ',". Body 95-115 words.';
  return prompt;
}

// ─── USER PROMPT ──────────────────────────────────────────

/**
 * Builds user prompt with research context, canonical experience bank, and
 * dynamic re-labeling instructions.
 */
/**
 * PATCH 2026-06-11-eq8-contentguards (T4): Canonical recipient facts block.
 * Injected at the top of EVERY user prompt (STANDARD / HR / CXO) so the model
 * always sees authoritative name/org/designation from the CRM sheet — never
 * from dossier research which may describe a different person or company.
 * @param {Object} lead - LeadProfile
 * @returns {string} Facts block ending with two newlines
 */
function _buildCanonicalRecipientFacts(lead) {
  var fullName    = (lead && lead.fullName)     ? lead.fullName.toString().trim()     : '';
  var org         = (lead && lead.organization) ? lead.organization.toString().trim() : '';
  var designation = (lead && lead.designation)  ? lead.designation.toString().trim()  : '';
  if (!designation && lead && lead.title) designation = lead.title.toString().trim();
  if (!fullName && !org) return '';  // nothing useful to assert

  var block = '## CANONICAL RECIPIENT FACTS (verbatim from CRM — NEVER contradict or substitute)\n';
  if (fullName)    block += 'Name: ' + fullName + '\n';
  if (org)         block += 'Company: ' + org + '\n';
  if (designation) block += 'Title: ' + designation + '\n';
  if (org)         block += 'The recipient works at ' + org + ' TODAY. ';
  block += 'NEVER state or imply they work anywhere else; other companies may appear ONLY as competitors/market context.\n';
  block += 'NEVER fabricate a different employer, title, or name — the CRM row above is the authoritative source.\n\n';
  return block;
}

function _buildUserPrompt(template, lead, context, classification, resumeSelection) {
  // PATCH 2026-05-12: archetype-aware user prompt dispatch
  if (template === 'HR_PARTNERSHIP') return _buildHrUserPrompt(lead, context, classification, resumeSelection);
  if (template === 'CXO_SHORT')      return _buildCxoUserPrompt(lead, context, classification, resumeSelection);
  // ...existing STANDARD (BULLET_V1) logic follows
  var org = context.organization || 'their company';

  // PATCH 2026-06-12-template-unify: per-template ANGLE instructions.
  // All standard templates share ONE BULLET_V1 body architecture. Template-specific
  // flavor goes INTO the angle block here (hook framing, bridge framing, subject hint)
  // rather than maintaining divergent contracts or separate prompts. The JSON schema
  // and renderer are identical across T1/T2/T3/T4/T5/T6/T8.
  var _angleBlock = '';
  if (template === 'T1_FOUNDER_NO_ROLE') {
    _angleBlock = '## TEMPLATE ANGLE: T1_FOUNDER_NO_ROLE (Founder / No open role)\n' +
      'The recipient is a founder or senior operator. No specific JD is attached.\n' +
      'ANGLE: Hook must reference a SPECIFIC recent company move, product launch, or market observation you can anchor to ' + org + '\'s trajectory. Bridge as an informational peer note — "if [ORG] is scaling [function], what I built at upGrad/Blinkit Bistro maps directly."\n' +
      'Subject hint: "Strategy & Growth at ' + org + '" or "Growth & Ops Note — ' + org + '". Keep it peer-level.\n\n';
  } else if (template === 'T2_DOMAIN_EXPERT') {
    _angleBlock = '## TEMPLATE ANGLE: T2_DOMAIN_EXPERT (Domain expert / published content)\n' +
      'The recipient has published content, runs a product/engineering function, or is a recognized domain expert.\n' +
      'ANGLE: Hook MUST reference their specific published content, talk, LinkedIn post, or domain insight — the most concrete signal available. Bridge: "the same zero-to-one execution I ran at [company] is exactly the operating layer [ORG]\'s [function] needs."\n' +
      'Subject hint: "Growth & Strategy for ' + org + '" or "Note on ' + org + '\'s [domain]". Specificity wins.\n\n';
  } else if (template === 'T3_SHARED_BACKGROUND') {
    _angleBlock = '## TEMPLATE ANGLE: T3_SHARED_BACKGROUND (Alumni / shared background)\n' +
      'A shared institution, employer, or background connection exists.\n' +
      'ANGLE: If a shared background signal is available (same alumni network, same prior employer), open with that authentic connection in ONE sentence, then pivot immediately to capability. Do NOT spend more than one line on the connection — the rest must be value-forward.\n' +
      'Subject hint: "Growth & Marketing Intro — ' + org + '" or "IIM-K connection — note on ' + org + '". Keep the connection natural.\n\n';
  } else if (template === 'T5_HIRING_GROWTH') {
    _angleBlock = '## TEMPLATE ANGLE: T5_HIRING_GROWTH (Marketing / Sales / Growth function)\n' +
      'The recipient works in Growth, Marketing, or Sales — a peer function to Gaurav\'s background.\n' +
      'ANGLE: Hook must speak their language — lead with a GTM/growth/funnel metric that mirrors their world. Bridge: "if [ORG]\'s [growth/marketing] team is scaling [X], the 0-to-1 funnel build at upGrad and the GTM at Blinkit Bistro are directly relevant." Use growth vocabulary: CAC, LTV, funnel, GTM, acquisition, retention.\n' +
      'Subject hint: "Growth & Marketing at ' + org + '" or "GTM Strategy — ' + org + '".\n\n';
  } else if (template === 'T6_MUTUAL_CONNECTION') {
    _angleBlock = '## TEMPLATE ANGLE: T6_MUTUAL_CONNECTION (Mutual connection / warm intro)\n' +
      'A mutual connection exists or the outreach has a warm-intro framing.\n' +
      'ANGLE: If mutual connection data is available in the research context, name them or reference the connection in the hook. If not, frame as peer-level peer note rather than cold outreach. Bridge: "the reason [mutual connection] thought this would be relevant: [specific function capability]."\n' +
      'Subject hint: "Introduction via [mutual] — Growth & Strategy" or "Growth & Marketing — note re ' + org + '".\n\n';
  } else if (template === 'T8_INFORMATIONAL') {
    _angleBlock = '## TEMPLATE ANGLE: T8_INFORMATIONAL (Pure informational outreach)\n' +
      'No specific role. Pure informational outreach — building a relationship or exploring future fit.\n' +
      'ANGLE: Hook must be observation-first (something notable about ' + org + '\'s trajectory, a market shift, or a specific challenge they face). Do NOT mention a role. Bridge: "if [ORG] is thinking about [function] scaling, I\'d value 15 minutes to explore whether there\'s a fit."\n' +
      'Subject hint: "Growth & Strategy — ' + org + ' note" or "Marketing & Ops — quick note".\n\n';
  }
  // T4_TRIGGER_EVENT and all other tags: no additional angle block (STANDARD prompt is sufficient)

  // PATCH 2026-06-11-eq8-contentguards (T4): Prepend canonical facts so model
  // never substitutes dossier-inferred employer/name.
  var prompt = _buildCanonicalRecipientFacts(lead);
  prompt += _angleBlock;
  prompt += 'Compose a job-seeking cold email to ' + context.leadName + ', ' + context.designation + ' at ' + org + '.\n\n' +
    'Target Role / Template tag: ' + template + '\n' +
    'Approach: ' + (classification.approach || 'professional') + '\n\n' +
    '## CANONICAL EXPERIENCE BANK — USE THESE EXACTLY (re-label only)\n' +
    'The 3 companies, dates, and metrics below are FIXED. You MUST use all 3 in this order.\n' +
    'The only part you change is the Category Label (2-4 words at the start of each body).\n\n' +
    'EXPERIENCE 1: Blinkit Bistro (current)\n' +
    '  Verified metrics: ~50 cloud kitchens, 4 cities, P&L ownership, complaint rate cut 94%, 121K orders, 13 margin interventions, Rs 5.7L/month, 30+ cross-functional stakeholders, 35K-formula P&L workbook, 8-tab analytics dashboard.\n' +
    '  Sample body (angle = P&L & team scale): "P&L Ownership & Team Scale: Senior Manager owning station P&L across ~50 cloud kitchens in 4 cities. Resolved multi-city quality crisis - complaint rate cut by 94% across 121K orders in 2.5 weeks. Coordinated ops, supply chain, and quality across 30+ stakeholders."\n\n' +
    'EXPERIENCE 2: upGrad (2021-23)\n' +
    '  Verified metrics: referral funnel 0 to Rs 1.5 Cr in 4 months, 100+ career transitions, ABM + MarTech, cross-functional GTM across product + content + partnerships.\n' +
    '  Sample body (angle = category growth): "Category Growth & Stakeholder Mgmt: Growth Lead building referral funnels from 0 to Rs 1.5 Cr in 4 months. Drove 100+ career transitions via ABM + MarTech stack. Managed cross-functional GTM across product, content, and partnership teams."\n\n' +
    'EXPERIENCE 3: Great Learning (2019-20)\n' +
    '  Verified metrics: B2B partnership pipeline, enterprise clients, early-career scale-up, maps to org\'s partnership/channel needs.\n' +
    '  Sample body (angle = partnerships): "Scaling Through Partnerships: Built B2B partnership pipeline reaching enterprise clients in first quarter. Revenue from partnerships drove measurable contribution to target. Directly maps to channel-build priorities at ' + org + '."\n\n' +
    '## DYNAMIC RE-LABELING INSTRUCTION\n' +
    'For the target role "' + context.designation + '" at ' + org + ':\n' +
    '1. Read the 2-3 specific responsibilities mentioned in the role/JD below.\n' +
    '2. Pick category labels that angle Blinkit Bistro, upGrad, and Great Learning toward those responsibilities.\n' +
    '3. The body sentences stay close to the samples above; only the category label and the final framing sentence change.\n' +
    '4. Rephrasing examples for different role angles:\n' +
    '   - Account Management / P&L: "P&L Ownership & Team Scale" | "Category Growth & Stakeholder Mgmt" | "Scaling Through Partnerships"\n' +
    '   - Strategy / GM: "Station P&L & Multi-City Ops" | "Growth Strategy & Funnel Build" | "B2B Channel Expansion"\n' +
    '   - Growth / GTM: "Dark Store GTM & Growth Loops" | "Referral Funnel 0-to-1" | "EdTech Partnership Funnel"\n' +
    '   - Ops / Supply Chain: "Multi-Station Operations" | "Growth Operations" | "B2B Ops & Partnership Scale"\n\n' +
    '## GAURAV\'S INDUSTRY EXPERIENCE (for hook paragraph)\n' +
    'Gaurav has 4.5+ years spanning quick-commerce, ed-tech, and B2B GTM.\n' +
    'Hook paragraph MUST end: "...has been my operating reality across [N]+ years in [relevant industries]."\n' +
    'Use N=4.5 for quick-commerce/ed-tech angle; N=5 for general ops/strategy angle.\n\n' +
    '## LEAD & ORG RESEARCH CONTEXT\n';

  // Latest news (strongest opening material)
  if (context.latestNews && context.latestNews.length > 10) {
    prompt += 'LATEST NEWS (use for hook if specific): ' + context.latestNews + '\n';
  }
  if (context.linkedInActivity && context.linkedInActivity.length > 10) {
    prompt += 'LEAD LINKEDIN ACTIVITY (great for personalized opening): ' + context.linkedInActivity + '\n';
  }
  if (context.bestHookAngle && context.bestHookAngle.length > 10) {
    prompt += 'AI-RECOMMENDED OPENING ANGLE: ' + context.bestHookAngle + '\n';
  }
  if (context.hooks && context.hooks.length > 0) {
    prompt += 'Research Hooks: ' + context.hooks.join(' | ') + '\n';
  }
  if (context.triggerEvents && context.triggerEvents.length > 0) {
    prompt += 'Trigger Events: ' + context.triggerEvents.join(' | ') + '\n';
  }
  if (context.sharedBackground && context.sharedBackground.length > 0) {
    prompt += 'Shared Background: ' + context.sharedBackground.join(', ') + '\n';
  }
  if (context.orgChallenges && context.orgChallenges.length > 0) {
    prompt += 'Org Challenges: ' + context.orgChallenges.join(' | ') + '\n';
  }
  if (context.bridgeStatements && context.bridgeStatements.length > 0) {
    prompt += 'RESUME-TO-ORG BRIDGES (pre-validated):\n';
    context.bridgeStatements.forEach(function(bridge) {
      prompt += '- ' + bridge + '\n';
    });
  }

  prompt += '\n## REQUIREMENTS\n' +
    '1. hookParagraph: 2-3 sentences naming 2-3 SPECIFIC responsibilities from the JD + one unifying theme. Use the best available concrete research signal. MUST end: "...has been my operating reality across [N]+ years in [industries]."\n' +
    '2. bridgeSentence: MUST be "Three 0-to-1 builds that map directly to this role:" (exact phrase with "Three 0-to-1 builds").\n' +
    '3. experienceBullets: exactly 3 bullets, Blinkit Bistro then upGrad then Great Learning. Category label is the ONLY creative part.\n' +
    '4. motivationParagraph: "The thread across all three: [one-line pattern — ownership/cross-functional/execution]."\n' +
    '5. currentRoleParagraph: "On the builder side, three AI tools shipped independently (all live):" — use this exact text.\n' +
    '6. showAiToolsBlock: true (always, unless role is pure finance with no tech angle).\n' +
    '7. closingLogistics: "Based in Gurgaon and available to start immediately. Would value 15 minutes to discuss how this maps to what your team is building at ' + org + '."\n' +
    '8. closingResume: "Please find my resume attached below for further details. Would welcome the chance to discuss how this background aligns with what your team is building."\n' +
    '9. signoffText: "Thanks and regards"\n' +
    '10. psLine: 12-28 words, different concrete signal from opening hook, tethered to ' + org + ' or its space. Peer-level tone. No sycophancy, no weekend greetings.\n' +
    '11. subjectLine: 2-5 words VALUE TOPIC only (no "Job Application:" prefix — added automatically). Example: "Account Management at ' + org + '" or "Growth Ops for ' + org + '".\n' +
    '12. Return ONLY the JSON object, no markdown, no code blocks.\n' +
    '13. Do NOT mention resume/CV/attached in hookParagraph, bridgeSentence, or bullet bodies.\n' +
    '14. Each JSON field must have UNIQUE content — no sentence duplicated across fields.\n';

  return prompt;
}

// ─── RESPONSE PARSING ─────────────────────────────────────

/**
 * Parses Claude's JSON response with the new structured format.
 * @param {string} text - Raw Claude response
 * @returns {Object|null} Parsed object or null
 */
function _parseCompositionResponse(text) {
  if (!text) return null;

  var jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    var json = JSON.parse(jsonMatch[0]);

    // ── 2026 BULLET_V1 format (new) ──
    // Detected by presence of experienceBullets array. Carries the new
    // reference-style fields alongside the legacy bodyParagraphs (which we
    // synthesize for plaintext fallback so QualityGate's word-count + spam
    // checks still see meaningful content).
    //
    // PATCH 2026-05-12: ALSO triggers for CXO_SHORT which has 0 experienceBullets
    // but uses hookParagraph + motivationParagraph + closingLogistics as its
    // body. Without this, CXO_SHORT emails parsed to empty body and were dropped.
    //
    // PATCH 2026-06-12-strategy-tilt: CXO now emits 2-3 experienceBullets alongside
    // motivationParagraph (new JSON contract). hasCxoShape now also accepts
    // templateId === 'CXO_SHORT' with bullets, so the parser routes correctly.
    var hasBullets = Array.isArray(json.experienceBullets) && json.experienceBullets.length > 0;
    var hasCxoShape = !!json.hookParagraph && !!json.motivationParagraph && !!json.closingLogistics
                    && (!Array.isArray(json.experienceBullets) || json.experienceBullets.length === 0);
    // CXO with bullets (new contract): templateId='CXO_SHORT' + bullets present
    var hasCxoWithBullets = (json.templateId === 'CXO_SHORT') && hasBullets;
    if (json.subjectLine && (hasBullets || hasCxoShape || hasCxoWithBullets)) {
      // Migrate legacy `cta` to closingLogistics if Claude emitted the old shape
      var migratedClosingLogistics = (json.closingLogistics || json.cta || '').toString().trim();

      var bulletResult = {
        subjectLine: json.subjectLine.trim(),
        greeting: (json.greeting || '').trim(),
        hookParagraph: (json.hookParagraph || '').trim(),
        bridgeSentence: (json.bridgeSentence || '').trim(),
        experienceBullets: json.experienceBullets.map(function(b) {
          return {
            label: (b.label || '').toString().trim(),
            body:  (b.body  || '').toString().trim(),
            showLorTag: !!b.showLorTag
          };
        }).filter(function(b) { return b.label && b.body; }),
        showAiToolsBlock: json.showAiToolsBlock !== false,
        currentRoleParagraph: (json.currentRoleParagraph || '').trim(),
        motivationParagraph: (json.motivationParagraph || '').trim(),
        closingLogistics: migratedClosingLogistics,
        closingResume: (json.closingResume || '').toString().trim(),
        signoffText: (json.signoffText || 'Thanks and regards').toString().trim(),
        // cta intentionally left EMPTY for BULLET_V1 — closingLogistics owns the
        // 15-min ask now, and mirroring it into cta would cause _checkCrossFieldUniqueness
        // to fire a false-positive duplicate (since closingLogistics is also in
        // the synthesized bodyParagraphs below).
        cta: '',
        psLine: (json.psLine || '').trim(),
        selectedHookTier: typeof json.selectedHookTier === 'number' ? json.selectedHookTier : null,
        // PATCH 2026-06-11-eq8-hrbullets: preserve templateId so _normalizeParsedFields
        // and _buildHtmlEmail can detect HR_RECRUITER shape without signature re-plumbing.
        templateId: (json.templateId || '').toString().trim(),
        // Synthesize a bodyParagraphs view for legacy validators
        bodyParagraphs: [],
        emailBody: ''
      };
      // PATCH 2026-05-12: inject canonical fields FIRST so the synthesized
      // bodyParagraphs below contains the injected content too (otherwise
      // validators that scan bodyParagraphs miss injected fields).
      _injectCanonicalFields(bulletResult);

      // PATCH 2026-05-15 (Abhishek RCA — core architectural fix):
      // Normalize cosmetic LLM-tell characters (em-dashes, en-dashes, smart
      // quotes, ellipsis, NBSPs) BEFORE the validator runs. _sanitizeText
      // already does this at render time, but the validator at line 1391
      // ("FATAL: Em-dash or en-dash detected") runs against the raw parsed
      // fields and FATALs before rendering ever happens — killing the lead
      // for a cosmetic slip the renderer would have auto-fixed seconds later.
      //
      // Architecture: parse → inject → NORMALIZE → validate → render.
      // The normalizer is idempotent — running it twice is a no-op. The
      // render-time _sanitizeText calls stay as belt-and-suspenders.
      _normalizeParsedFields(bulletResult);

      // Synthesize plaintext bodyParagraphs from the structured fields so
      // QualityGate.gs / MasterValidator.gs (which use bodyParagraphs.join)
      // see meaningful text for word-count, you/I ratio, and spam checks.
      var bodyParts = [];
      if (bulletResult.hookParagraph) bodyParts.push(bulletResult.hookParagraph);
      if (bulletResult.bridgeSentence) bodyParts.push(bulletResult.bridgeSentence);
      bulletResult.experienceBullets.forEach(function(b) {
        bodyParts.push(b.label + ': ' + b.body);
      });
      if (bulletResult.currentRoleParagraph) bodyParts.push(bulletResult.currentRoleParagraph);
      if (bulletResult.motivationParagraph) bodyParts.push(bulletResult.motivationParagraph);
      if (bulletResult.closingLogistics) bodyParts.push(bulletResult.closingLogistics);
      if (bulletResult.closingResume) bodyParts.push(bulletResult.closingResume);
      bulletResult.bodyParagraphs = bodyParts;
      bulletResult.emailBody = bodyParts.join('\n\n');
      return bulletResult;
    }

    // ── Legacy prose format (PROSE_V0) ──
    if (json.subjectLine && json.bodyParagraphs && Array.isArray(json.bodyParagraphs)) {
      var result = {
        subjectLine: json.subjectLine.trim(),
        greeting: json.greeting ? json.greeting.trim() : '',
        bodyParagraphs: json.bodyParagraphs.map(function(p) { return p.trim(); }).filter(function(p) { return p.length > 0; }),
        cta: json.cta ? json.cta.trim() : '',
        psLine: json.psLine ? json.psLine.trim() : '',
        emailBody: ''
      };
      // Dedupe BEFORE emailBody assembly so fallback plain-text matches the HTML
      _dedupParsedComposition(result);
      result.emailBody = result.bodyParagraphs.join('\n\n');
      return result;
    }

    // Fallback: old format {subjectLine, emailBody}
    if (json.subjectLine && json.emailBody) {
      var paragraphs = json.emailBody.split(/\n\n|\n/).filter(function(p) { return p.trim().length > 0; });
      var legacyResult = {
        subjectLine: json.subjectLine.trim(),
        greeting: '',
        bodyParagraphs: paragraphs,
        cta: '',
        psLine: json.psLine ? json.psLine.trim() : '',
        emailBody: json.emailBody.trim()
      };
      _dedupParsedComposition(legacyResult);
      return legacyResult;
    }
  } catch (e) {
    Logger.log('Failed to parse JSON: ' + e.message);
  }

  return null;
}

// ─── CANONICAL FIELD INJECTION ────────────────────────────

/**
 * PATCH 2026-05-12: Defensive field injection.
 * Claude is occasionally sloppy about emitting every canonical field. Rather
 * than depending on render-time fallbacks (which are duplicated logic), inject
 * canonical values at parse time so the downstream validator AND renderer
 * always see a complete object. Tracks injected fields in parsed._injectedFields
 * for debugging.
 */
function _injectCanonicalFields(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  var refBlocks = (typeof REFERENCE_BLOCKS !== 'undefined') ? REFERENCE_BLOCKS : null;
  var injected = [];

  // PATCH 2026-05-13: shape-detect CXO_SHORT instead of bullet-counting STANDARD.
  // PATCH 2026-06-12-strategy-tilt: templateId === 'CXO_SHORT' is now the PRIMARY
  // discriminator (set by Tier-1 CXO prompt + Tier-3 fallback). The zero-bullets +
  // motivationParagraph heuristic is RETAINED as a legacy fallback for objects that
  // predate the templateId contract (parsed before this stamp).
  //
  // New routing:
  //   - CXO_SHORT = templateId==='CXO_SHORT' OR (0 bullets + motivationParagraph).
  //     Skip AI tools / resume injection; CXO emails are brief.
  //   - Everything else = STANDARD/HR_PARTNERSHIP. Inject the 3 AI projects
  //     header + GitHub footer + resume mention unconditionally.
  var bulletCount = Array.isArray(parsed.experienceBullets) ? parsed.experienceBullets.length : 0;
  var isCxoShort = (parsed.templateId === 'CXO_SHORT')
                 || ((bulletCount === 0) && !!(parsed.motivationParagraph && parsed.motivationParagraph.trim()));

  if (!parsed.signoffText || parsed.signoffText.trim() === '') {
    parsed.signoffText = 'Thanks and regards';
    injected.push('signoffText');
  }

  if (!isCxoShort) {
    // STANDARD / HR_PARTNERSHIP path — full canonical structure.
    if (!parsed.bridgeSentence || parsed.bridgeSentence.trim() === '') {
      parsed.bridgeSentence = 'Three 0-to-1 builds that map directly to this role:';
      injected.push('bridgeSentence');
    }
    if (!parsed.currentRoleParagraph || parsed.currentRoleParagraph.trim() === '') {
      if (refBlocks && refBlocks.aiTools && refBlocks.aiTools.header) {
        parsed.currentRoleParagraph = refBlocks.aiTools.header;
        injected.push('currentRoleParagraph');
      }
    }
    if (!parsed.closingResume || parsed.closingResume.trim() === '') {
      if (refBlocks && refBlocks.resumeMention) {
        parsed.closingResume = refBlocks.resumeMention;
        injected.push('closingResume');
      }
    }
    // Force showAiToolsBlock=true unconditionally on non-CXO shapes — the
    // 3 AI projects + GitHub footer are part of the canonical template.
    if (parsed.showAiToolsBlock !== true) {
      parsed.showAiToolsBlock = true;
      injected.push('showAiToolsBlock');
    }
  } else {
    // CXO_SHORT (Leadership Master Template, Patch 2026-05-19) —
    // brief shape that explicitly suppresses:
    //   (a) the AI tools block / 3-project bullet list,
    //   (b) the closingResume "Please find my resume attached..." paragraph.
    // Per the Founder-Grade Playbook audit: "Cut. You already asked once via
    // Calendly. Two CTAs reduces response. Resume attachment is self-evident
    // from the file name." Leadership emails ship with ONE CTA only.
    if (parsed.showAiToolsBlock !== false) {
      parsed.showAiToolsBlock = false;
      injected.push('showAiToolsBlock(suppressed-cxo)');
    }
    // Force closingResume EMPTY — drop whatever Claude emitted, drop whatever
    // refBlocks.resumeMention would inject. The renderer also re-enforces this
    // (see _buildHtmlEmail) but we strip at parse time so downstream validators
    // and the synthesized bodyParagraphs reflect the actual rendered shape.
    if (parsed.closingResume && parsed.closingResume.toString().trim() !== '') {
      parsed.closingResume = '';
      injected.push('closingResume(stripped-cxo)');
    }
  }

  // REVERSED in Phase 4-Enrich (stamp -p4-cxotier3-enrich):
  //   The PATCH 2026-05-19 "youngest" scrub is REMOVED here. Two authoritative
  //   playbook PDFs (Recruiter §6 + Leadership §2) lock the P.S. text as:
  //     "Youngest department lead at Great Learning — scaled B2B partnerships
  //      across 50+ countries before turning 25."
  //   The Recruiter playbook §4.2 also uses "youngest department lead" in
  //   one of the 4 HR proof bullets. The earlier session's "do not use
  //   youngest" instruction is superseded by the playbook authority and
  //   this prompt's Sections 4.6 + 5.6.
  //
  //   Documented reversal in `08_changelog.md` Phase 4-Enrich entry and in
  //   `12b_variant_design_decisions.md` design-decision table.
  //
  //   If a future user instruction explicitly reinstates the prohibition,
  //   the scrub can be restored from git history at this stamp.

  if (injected.length > 0) {
    Logger.log('[EmailComposer] Injected canonical fields (' +
               (isCxoShort ? 'CXO_SHORT' : 'STANDARD') + '): ' + injected.join(', '));
    parsed._injectedFields = injected;
    parsed._injectedShape = isCxoShort ? 'CXO_SHORT' : 'STANDARD';
  }
  return parsed;
}

// ─── COSMETIC-CHARACTER NORMALIZATION (PATCH 2026-05-15) ──────────────
//
// The validator at _quickValidate (line ~1390) FATAL-checks for em-dash,
// en-dash, and curly quotes in the RAW Claude-emitted JSON fields.
// Meanwhile _sanitizeText (line 17) auto-normalizes the same characters
// at HTML-render time. Without this normalizer, Claude's cosmetic slips
// (one em-dash in a 374-word email) FATAL the entire composition before
// the renderer's auto-fix gets a chance to run. That was the Abhishek
// Saha / Amazon "STATUS=ERROR Composition failed" symptom.
//
// Architectural intent (audit 2026-05-15):
//   parse → inject canonical fields → NORMALIZE → validate → render
//
// This normalizer walks every string field on the parsed object — top-level
// strings AND nested objects/arrays (experienceBullets[i].label/.body) —
// and applies the SAME character replacements as _sanitizeText. Idempotent.
//
// What it does NOT touch: structure (bullet count, missing sections, banned
// phrases, attachment mentions). Those are the validator's job. This is
// purely cosmetic-character cleanup so Claude's "—" doesn't kill a lead.
//
// @param {Object} parsed - parsed composition (mutated in place)
// @returns {Object} the same parsed object
function _normalizeParsedFields(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;

  // Inner helper — mirrors _sanitizeText character mapping exactly.
  // If _sanitizeText is updated, update this too (or refactor to share).
  function normalize(text) {
    if (text === null || text === undefined) return text;
    if (typeof text !== 'string') return text;
    return text
      .replace(/[“”„‟″‶]/g, '"')   // smart double → straight
      .replace(/[‘’‚‛′‵]/g, "'")   // smart single → straight
      // PATCH 2026-06-12-e2e-hardening: RESTORED em-dash normalization.
      // The -p4-cxotier3-enrich-amend removal left _quickValidate’s em-dash
      // FATAL active while this normalizer was blind to em-dashes. Any
      // Claude-emitted em-dash in hookParagraph/bridgeSentence/bodyParagraphs
      // survived into _quickValidate → FATAL → Tier 3 fallback, silently
      // wasting the Claude call. Mirrors _sanitizeText (line 34) exactly.
      .replace(/[—―]/g, ' - ')                          // em-dash / horizontal-bar → “ - “
      .replace(/[–]/g, '-')                                  // en-dash → hyphen
      .replace(/…/g, '...')                                  // ellipsis → ...
      .replace(/ /g, ' ')                                    // NBSP → space (new — not in _sanitizeText but valuable here)
      .replace(/[""]/g, '"')
      .replace(/['']/g, "'");
  }

  // Top-level string fields likely to contain LLM-emitted prose.
  // Listing explicitly (not iterating all keys) so we don't accidentally
  // normalize the timestamp, URLs, or internal metadata like _injectedFields.
  var STRING_FIELDS = [
    'subjectLine', 'greeting', 'hookParagraph', 'bridgeSentence',
    'motivationParagraph', 'currentRoleParagraph',
    'closingLogistics', 'closingResume', 'signoffText',
    'cta', 'psLine', 'emailBody'
  ];
  STRING_FIELDS.forEach(function(field) {
    if (typeof parsed[field] === 'string') {
      parsed[field] = normalize(parsed[field]);
    }
  });

  // bodyParagraphs (array of strings, used by legacy path + synthesized for BULLET_V1)
  if (Array.isArray(parsed.bodyParagraphs)) {
    parsed.bodyParagraphs = parsed.bodyParagraphs.map(normalize);
  }

  // PATCH 2026-06-12-builderblock-v2: scrub the "Here's what my GitHub has been
  // since Claude Code dropped" sentence from all Claude-path fields. The canonical
  // copy lives ONLY in REFERENCE_BLOCKS.aiTools.githubFooter and is emitted once
  // by the renderer. If Claude writes this sentence into any field, it causes a
  // duplicate when the footer renders. Strip the sentence (and any bare-URL
  // fragment that follows it if the field would become empty) from:
  //   hookParagraph, bodyParagraphs[], bridgeSentence, currentRoleParagraph,
  //   motivationParagraph, closingLogistics, psLine.
  // Pattern matches contractions with or without apostrophe, trailing colon optional,
  // followed by optional whitespace.
  var _ghSentenceRe = /Here'?s what my GitHub has been since Claude Code dropped:?\s*/gi;
  var _SCRUB_FIELDS = [
    'hookParagraph', 'bridgeSentence', 'currentRoleParagraph',
    'motivationParagraph', 'closingLogistics', 'psLine'
  ];
  _SCRUB_FIELDS.forEach(function(f) {
    if (typeof parsed[f] === 'string') {
      var cleaned = parsed[f].replace(_ghSentenceRe, '').trim();
      // If the field collapses to only a bare github.com URL after the sentence is removed,
      // drop it entirely (the footer will emit the canonical linked version).
      if (/^https?:\/\/github\.com\/GauravRIIMK\S*$/.test(cleaned)) cleaned = '';
      parsed[f] = cleaned;
    }
  });
  if (Array.isArray(parsed.bodyParagraphs)) {
    parsed.bodyParagraphs = parsed.bodyParagraphs.map(function(p) {
      if (typeof p !== 'string') return p;
      var cleaned = p.replace(_ghSentenceRe, '').trim();
      if (/^https?:\/\/github\.com\/GauravRIIMK\S*$/.test(cleaned)) return '';
      return cleaned;
    }).filter(function(p) { return p !== ''; });
  }

  // PATCH 2026-06-12-hr-layout: paraphrase scrub (defense-in-depth).
  // Strips Claude-authored variant paraphrases of canonical blocks from all
  // prose fields. Two target patterns:
  //   (a) "Builder side —" lines: any sentence starting with "builder side"
  //       (case-insensitive) that also contains the github.com/GauravRIIMK
  //       token OR mentions "AI tools shipped" or tool-count language.
  //       Canonical block renders from REFERENCE_BLOCKS.aiTools — Claude's
  //       copy is always an unlinked duplicate.
  //   (b) Calendly-paraphrase CTA lines: "grab 15 minutes here", "book 15
  //       minutes here", "find 15 minutes here" and similar.  The canonical
  //       anchored CTA renders from closingLogistics + F6/S2 — Claude's copy
  //       renders as plain text after the PS when it leaks into psLine.
  // Applied to: psLine, closingLogistics, bodyParagraphs[], hookParagraph,
  // bridgeSentence, motivationParagraph.
  var _PARAPHRASE_SCRUB_FIELDS = [
    'psLine', 'closingLogistics', 'hookParagraph', 'bridgeSentence', 'motivationParagraph'
  ];
  function _scrubParaphrases(text) {
    if (typeof text !== 'string') return text;
    // (a) Builder-side paraphrase: any clause starting with "builder side"
    //     (case-insensitive) that references github.com/GauravRIIMK, "AI tools
    //     shipped", or "three AI tools" / "independently" within 250 chars.
    //     Uses [^\n]{0,250} to allow periods inside the sentence (e.g.
    //     "...independently (all live). github.com/GauravRIIMK").
    //     Stops at newline so it does not bleed across paragraph boundaries.
    var _builderSideRe = /\bbuilder\s+side\b[^\n]{0,250}(?:github\.com\/GauravRIIMK|AI\s+tools?\s+shipped|three\s+AI\s+tools?|independently\s*\(all\s+live\))[^\n]{0,100}/gi;
    text = text.replace(_builderSideRe, '').trim();
    // (b) Calendly-paraphrase CTA: "(grab|book|find) 15 min(ute)?s? here"
    var _calParaRe = /(?:grab|book|find)\s+15\s+min(?:ute)?s?\s+here\.?/gi;
    text = text.replace(_calParaRe, '').trim();
    // (c) Variant: "Happy to walk through specifics" — fallback phrase injected
    //     by S2 guard that leaks into psLine/closingLogistics if Claude includes
    //     the plain-text phrase.
    var _happyWalkRe = /Happy\s+to\s+walk\s+through\s+specifics[^\n]{0,120}/gi;
    text = text.replace(_happyWalkRe, '').trim();
    return text;
  }
  _PARAPHRASE_SCRUB_FIELDS.forEach(function(f) {
    if (typeof parsed[f] === 'string') {
      parsed[f] = _scrubParaphrases(parsed[f]);
    }
  });
  if (Array.isArray(parsed.bodyParagraphs)) {
    parsed.bodyParagraphs = parsed.bodyParagraphs.map(function(p) {
      return typeof p === 'string' ? _scrubParaphrases(p) : p;
    }).filter(function(p) { return p !== ''; });
  }

  // experienceBullets — array of {label, body, showLorTag}
  if (Array.isArray(parsed.experienceBullets)) {
    parsed.experienceBullets.forEach(function(b) {
      if (b && typeof b === 'object') {
        if (typeof b.label === 'string') b.label = normalize(b.label);
        if (typeof b.body === 'string')  b.body  = normalize(b.body);
      }
    });
  }

  // PATCH 2026-06-11-eq8-hrbullets: HR_RECRUITER rescue.
  // When the model returns templateId:'HR_RECRUITER' but experienceBullets is
  // empty (model drift — experience prose ended up in bodyParagraphs or hookParagraph
  // instead of the structured array), reconstruct a minimal 3-item bullet array
  // from known canonical role names so _buildHtmlEmail can route to the table-
  // bullet renderer (_buildHtmlEmailBulletV1).  This guarantees rendering is
  // always bullets-based regardless of whether Claude followed the schema exactly.
  //
  // Detection: templateId === 'HR_RECRUITER' AND experienceBullets.length < 2.
  // Source prose: bodyParagraphs joined, or hookParagraph as fallback.
  // The canonical company labels are hard-coded (they are invariants of the
  // HR template — Blinkit Bistro / upGrad / Great Learning always appear).
  if (parsed.templateId === 'HR_RECRUITER' &&
      (!Array.isArray(parsed.experienceBullets) || parsed.experienceBullets.length < 2)) {
    var CANONICAL_HR_BULLETS = [
      { label: 'Blinkit Bistro (current)',  anchor: /blinkit\s*bistro/i,
        fallback: 'Senior Manager P&L across ~50 cloud kitchens in 4 cities. Complaint rate cut 94% across 121K orders. 30+ cross-functional stakeholders, 13 margin interventions.' },
      { label: 'upGrad (2021-23)',          anchor: /upgrad/i,
        fallback: 'Category Growth & Stakeholder Mgmt: Growth Lead building referral funnels from 0 to Rs 1.5 Cr in 4 months. Drove 100+ career transitions via ABM + MarTech. Managed cross-functional GTM across product, content, and partnerships.' },
      { label: 'Great Learning (2019-20)',  anchor: /great\s*learning/i,
        fallback: 'Scaling Through Partnerships: Built B2B partnership pipeline reaching 3 enterprise clients in first quarter. Revenue from partnerships contributed 20% of target.' }
    ];
    // Collect candidate prose: bodyParagraphs first, then hookParagraph
    var proseSections = [];
    if (Array.isArray(parsed.bodyParagraphs) && parsed.bodyParagraphs.length > 0) {
      proseSections = parsed.bodyParagraphs;
    } else if (parsed.hookParagraph && parsed.hookParagraph.trim()) {
      // Split hookParagraph by sentence boundaries as last resort
      proseSections = parsed.hookParagraph.split(/(?<=[.!?])\s+/);
    }
    var rescuedBullets = [];
    CANONICAL_HR_BULLETS.forEach(function(def) {
      // Find the prose section that best matches this company anchor
      var bestSection = '';
      for (var si = 0; si < proseSections.length; si++) {
        if (def.anchor.test(proseSections[si])) {
          bestSection = proseSections[si];
          break;
        }
      }
      // If no section matched, use canonical fallback so structure is preserved
      if (!bestSection) {
        bestSection = def.fallback || (def.label + ': experience driving growth and operational outcomes.');
      }
      // PATCH 2026-06-11-eq8-finalpolish (D1): strip leading label-ish prefix from
      // extracted prose body so the renderer does NOT double-emit the company name.
      // Real-draft evidence: body was "Blinkit Bistro (current): Senior Manager owning..."
      // → renderer prepended bold label → "Blinkit Bistro (current): Blinkit Bistro (current): ..."
      // Strip up to 3 iterations (label can appear twice in extracted prose).
      var _hrBodyToStore = bestSection.trim();
      var _hrLabelStripRe = /^\s*(?:Blinkit\s*Bistro|upGrad|Great\s*Learning)[^:]{0,40}:\s*/i;
      for (var _si = 0; _si < 3; _si++) {
        if (_hrLabelStripRe.test(_hrBodyToStore)) {
          _hrBodyToStore = _hrBodyToStore.replace(_hrLabelStripRe, '');
        } else { break; }
      }
      rescuedBullets.push({ label: def.label, body: normalize(_hrBodyToStore), showLorTag: false });
    });
    // PATCH 2026-06-11-eq8-c4strong: Rescue floor — guarantee EXACTLY 3 bullets,
    // each body >=30 chars. Top up from canonical fallback if needed.
    while (rescuedBullets.length < 3) {
      var _hrMissingDef = CANONICAL_HR_BULLETS[rescuedBullets.length];
      rescuedBullets.push({ label: _hrMissingDef.label, body: normalize(_hrMissingDef.fallback), showLorTag: false });
    }
    rescuedBullets.forEach(function(rb, ri) {
      if (!rb.body || rb.body.length < 30) {
        rb.body = normalize(CANONICAL_HR_BULLETS[ri] ? CANONICAL_HR_BULLETS[ri].fallback : rb.body || '');
      }
    });

    parsed.experienceBullets = rescuedBullets;
    parsed.formatVersion = 'BULLET_V1';
    Logger.log('[EmailComposer] PATCH eq8-c4strong — HR_RECRUITER bullet rescue: rebuilt ' +
               rescuedBullets.length + ' bullets from prose fields');
  }

  // PATCH 2026-06-11-eq8-finalpolish: STANDARD bullet rescue.
  // Mirror of the HR rescue above, but NOT gated on templateId. Fires for ALL
  // non-HR shapes (STANDARD / HR_PARTNERSHIP / etc.) when:
  //   (a) experienceBullets is empty or < 2 items (model drift — prose landed
  //       in bodyParagraphs instead of the structured bullet array), AND
  //   (b) bodyParagraphs text contains Blinkit Bistro OR upGrad mentions
  //       (presence of canonical brand names confirms this is Gaurav's email,
  //       not a test stub or a template without experience content).
  //
  // Live evidence (2026-06-11): 8 Tier-1 STANDARD drafts composed 15:32-15:46
  // all rendered via the legacy prose path — zero contained 'width:28px' (the
  // BulletV1 renderer signature). Their bodies mentioned Blinkit Bistro / upGrad
  // as plain text. Root cause: Claude returned hasBullets=false (empty or <2
  // bullets), hasCxoShape=false → fell through to legacy PROSE_V0 branch in
  // _parseCompositionResponse; the parsed object arrived in _buildHtmlEmail with
  // experienceBullets missing entirely. This rescue corrects that after the fact.
  //
  // Fallback bullet bodies: if a prose section matches the anchor, use it verbatim.
  // If not found, use the same canonical bodies used in _composeDeterministicFallback
  // (the Tier-3 path) so structure is always preserved.
  if (parsed.templateId !== 'HR_RECRUITER' &&
      (!Array.isArray(parsed.experienceBullets) || parsed.experienceBullets.length < 2)) {
    // Only activate when brand signal confirms this is experience content (not empty stub)
    var _stdProseJoined = (Array.isArray(parsed.bodyParagraphs) ? parsed.bodyParagraphs.join(' ') : '') +
                          (parsed.hookParagraph || '') + (parsed.emailBody || '');
    if (/blinkit\s*bistro/i.test(_stdProseJoined) || /upgrad/i.test(_stdProseJoined)) {
      var CANONICAL_STD_BULLETS = [
        {
          label: 'Blinkit Bistro (current)',
          anchor: /blinkit\s*bistro/i,
          fallback: 'Senior Manager P&L across ~50 cloud kitchens in 4 cities. Complaint rate cut 94% across 121K orders. 30+ cross-functional stakeholders, 13 margin interventions.'
        },
        {
          label: 'upGrad (2021-23)',
          anchor: /upgrad/i,
          fallback: 'Category Growth & Stakeholder Mgmt: Growth Lead building referral funnels from 0 to Rs 1.5 Cr in 4 months. Drove 100+ career transitions via ABM + MarTech. Managed cross-functional GTM across product, content, and partnerships.'
        },
        {
          label: 'Great Learning (2019-20)',
          anchor: /great\s*learning/i,
          fallback: 'Scaling Through Partnerships: Built B2B partnership pipeline reaching 3 enterprise clients in first quarter. Revenue from partnerships contributed 20% of target.'
        }
      ];
      // Collect candidate prose: bodyParagraphs first, then hookParagraph
      var _stdProseSections = [];
      if (Array.isArray(parsed.bodyParagraphs) && parsed.bodyParagraphs.length > 0) {
        _stdProseSections = parsed.bodyParagraphs;
      } else if (parsed.hookParagraph && parsed.hookParagraph.trim()) {
        _stdProseSections = parsed.hookParagraph.split(/(?<=[.!?])\s+/);
      }
      var _stdRescuedBullets = [];
      CANONICAL_STD_BULLETS.forEach(function(def) {
        var bestSection = '';
        for (var si = 0; si < _stdProseSections.length; si++) {
          if (def.anchor.test(_stdProseSections[si])) {
            bestSection = _stdProseSections[si];
            break;
          }
        }
        if (!bestSection) {
          bestSection = def.fallback;
        }
        // PATCH 2026-06-11-eq8-finalpolish (D1): strip leading label-ish prefix from
        // extracted prose body so the renderer does NOT double-emit the company name.
        // Same fix as the HR rescue block above. Strip up to 3 iterations.
        var _stdBodyToStore = bestSection.trim();
        var _stdLabelStripRe = /^\s*(?:Blinkit\s*Bistro|upGrad|Great\s*Learning)[^:]{0,40}:\s*/i;
        for (var _ssi = 0; _ssi < 3; _ssi++) {
          if (_stdLabelStripRe.test(_stdBodyToStore)) {
            _stdBodyToStore = _stdBodyToStore.replace(_stdLabelStripRe, '');
          } else { break; }
        }
        _stdRescuedBullets.push({ label: def.label, body: normalize(_stdBodyToStore), showLorTag: false });
      });
      // PATCH 2026-06-11-eq8-c4strong: Rescue floor — guarantee EXACTLY 3 bullets,
      // each body >=30 chars. If Claude returned 2 (or fewer), top up from canonical.
      // If a bullet body is <30 chars, pad from the canonical fallback text.
      while (_stdRescuedBullets.length < 3) {
        var _missingDef = CANONICAL_STD_BULLETS[_stdRescuedBullets.length];
        _stdRescuedBullets.push({ label: _missingDef.label, body: normalize(_missingDef.fallback), showLorTag: false });
      }
      _stdRescuedBullets.forEach(function(rb, ri) {
        if (!rb.body || rb.body.length < 30) {
          rb.body = normalize(CANONICAL_STD_BULLETS[ri] ? CANONICAL_STD_BULLETS[ri].fallback : rb.body || '');
        }
      });

      parsed.experienceBullets = _stdRescuedBullets;
      parsed.formatVersion = 'BULLET_V1';
      if (!parsed.showAiToolsBlock) parsed.showAiToolsBlock = true;
      Logger.log('[STANDARD_BULLET_RESCUE] PATCH eq8-c4strong — STANDARD bullet rescue: rebuilt ' +
                 _stdRescuedBullets.length + ' bullets from prose fields');
    }
  }

  // Telemetry: if anything was actually changed, log it so we can audit
  // how often Claude is slipping cosmetic characters. Detection: hash the
  // input vs output would be exact, but a cheap proxy is "does any field
  // still contain em-dash after normalize?" (which would mean a bug).
  // Skip the verbose log unless we detect a leak.
  var leak = (parsed.bodyParagraphs || []).concat([
    parsed.subjectLine, parsed.psLine, parsed.cta
  ]).join(' ');
  // PATCH -p4-cxotier3-enrich-amend2: em-dashes EXCLUDED from leak detection (now intentional per 12b doc)
  if (/[–“”‘’… ]/.test(leak || '')) {
    Logger.log('[EmailComposer] WARN — _normalizeParsedFields completed but cosmetic chars still present (em-dashes excluded; intentional). Possible new char class to add.');
  }

  return parsed;
}

// ═══════════════════════════════════════════════════════════════════════
// ─── TIER 3 DETERMINISTIC FALLBACK (PATCH 2026-05-15, v2 Track D) ──────
// ═══════════════════════════════════════════════════════════════════════
//
// Closes the "all-LLMs-down → silent ERROR queue" resilience hole (v2 I2).
//
// Design context:
//   - Tier 1: Claude composer with full personalization (existing).
//   - Tier 1b: One Claude recomposition pass on validator FATALs (existing).
//   - Tier 2 (Gemini composer): DEFERRED — see master prompt. Trigger to
//     revisit: ≥ 2 weeks of observed Claude flakiness in production logs.
//   - Tier 3 (this): DETERMINISTIC TEMPLATE — assembles the parsed-JSON
//     shape from static building blocks (GAURAV_PROFILE achievements,
//     REFERENCE_BLOCKS canonical content). Engages when Claude is
//     unreachable (network error / auth / quota). Produces a draft that
//     is FLAGGED NEEDS_REVIEW so the user personalizes before send.
//
// Output contract: returns the SAME parsed-JSON shape that Claude's
// composer produces, plus a `tier: 'DETERMINISTIC_FALLBACK'` marker.
// The existing renderer `_buildHtmlEmailBulletV1` consumes it unchanged.
//
// Personalization floor (intentionally minimal):
//   - Recipient first name (from lead.fullName, with fallback chain)
//   - Recipient company name (from lead.organization)
//   - Recipient role/function (from classification or lead.designation)
//   - Everything else is canonical/static — explicitly NOT lead-specific
//
// Why this is acceptable for a fallback:
//   - User receives an HTML draft in Gmail (not nothing)
//   - Draft has correct structure, branding, signature, and attachments
//   - STATUS=NEEDS_REVIEW + NOTES make the degraded state visible
//   - User edits to add lead-specific hook before sending
//   - Vastly better than: lead sits at silent ERROR for hours/days
//
// @param {Object} lead - LeadProfile
// @param {Object} dossier - Compressed research dossier (may be incomplete)
// @param {Object} classification - {template, archetype, approach}
// PATCH 2026-05-18: smooth hook-seed so the Tier 3 graft reads naturally.
//
// Input examples (real dossier.bestHookAngle strings):
//   "A discussion around the evolving landscape of embedded insurance in
//    e-commerce, specifically referencing Flipkart's strategy and potential
//    challenges in scaling adoption and managing diverse product portfolios."
//   "Their recent expansion into quick commerce — specifically the launch
//    of Flipkart Minutes — and how the team is approaching the dark-store
//    economics."
//
// Output: short subject-phrase ready to graft into "specifically <X>.":
//   "the evolving landscape of embedded insurance in e-commerce"
//   "their recent expansion into quick commerce"
//
// Rules:
//   1. Strip leading "A discussion around / about / on" (case-insensitive)
//   2. Strip leading "specifically" (avoids "specifically specifically X")
//   3. Strip leading "referencing" (same reason)
//   4. Trim to first clause — everything up to first ", specifically" or
//      first comma followed by another long clause, or first full-stop
//   5. Drop the trailing org-name mention if present and the graft would
//      duplicate it (we already say "at <Org>" in the template)
//   6. Cap to 18 words to keep the opening sentence punchy
function _smoothTier3HookSeed(seed, orgName) {
  if (!seed || typeof seed !== 'string') return '';
  var s = seed.trim();

  // Rule 1: strip "A discussion around/about/on/regarding"
  s = s.replace(/^\s*(a\s+)?(brief\s+)?discussion\s+(around|about|on|regarding|of)\s+/i, '');
  // Rule 2-3: strip leading "specifically" / "referencing"
  s = s.replace(/^\s*(specifically|referencing)\s+/i, '');

  // Rule 4: first-clause trim. Prefer split at ", specifically" or
  // ", referencing" or first sentence break.
  var clauseSplit = s.search(/,\s*(specifically|referencing|and how|—|–)/i);
  if (clauseSplit > 20) {
    s = s.substring(0, clauseSplit);
  } else {
    var sentSplit = s.search(/[.!?]/);
    if (sentSplit > 20) s = s.substring(0, sentSplit);
  }

  // Rule 5: strip trailing org-name mention if redundant
  if (orgName && s.length > orgName.length + 10) {
    // Patterns like "...for Flipkart's strategy" or "...at Flipkart"
    var orgRe = new RegExp(
      '\\s*(for|at|in|by|with|about)\\s+' + orgName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') +
      "(\\'s)?\\s*[a-z\\s,]*$", 'i');
    s = s.replace(orgRe, '');
  }

  // Rule 6: word cap (18 words)
  var words = s.trim().split(/\s+/);
  if (words.length > 18) {
    s = words.slice(0, 18).join(' ');
  }

  s = s.replace(/[\s,;:—–-]+$/, '').trim();

  // Sanity: require at least 4 words to be useful (else return empty
  // so the no-hook path takes over)
  if (s.split(/\s+/).length < 4) return '';
  return s;
}

// @param {Object} resumeSelection - {variantId}
// @returns {Object} { success, subjectLine, emailBody, parsed, qualityNotes, tier }
function _composeDeterministicFallback(lead, dossier, classification, resumeSelection) {
  Logger.log('[Tier3] Deterministic fallback engaged for ' + lead.fullName +
             ' (row ' + lead.rowNum + ') — Claude unreachable, assembling static template');

  var refBlocks = (typeof REFERENCE_BLOCKS !== 'undefined') ? REFERENCE_BLOCKS : {};
  var profile = (typeof GAURAV_PROFILE !== 'undefined') ? GAURAV_PROFILE : {};
  var template = (classification && classification.template) || 'STANDARD';
  var variant  = (resumeSelection && resumeSelection.variantId) || 'GROWTH_MARKETING';
  var variantData = profile[variant] || profile.GROWTH_MARKETING || { achievements: [] };

  // Personalization floor — pull what's available from the doPost payload
  var orgName = (lead && lead.organization) ? lead.organization.toString().trim() : 'your team';
  var firstName = '';
  if (lead && lead.firstName) firstName = lead.firstName.toString().trim();
  else if (lead && lead.fullName) {
    var fn = lead.fullName.toString().trim().split(/\s+/)[0];
    if (/^[A-Za-zÀ-ſ][A-Za-zÀ-ſ'.\-]{1,}$/.test(fn)) firstName = fn;
  }
  var greetingTarget = firstName || ('Team ' + orgName);
  // PATCH 2026-05-16 (Option 5 / Sub-option 1): NO LONGER use lead.designation
  // as a role-hint for the hook. The recipient's designation is biographical
  // context (who they are), NOT a posted role Gaurav is applying to. Treating
  // it as a role hallucinated openings that don't exist ("The Senior Director -
  // Myntra Fashion Brands role at Myntra caught my attention" for Shubham —
  // Senior Director was Shubham's own title, not a posted opening).
  //
  // Tier 3 fallback now follows the same dual framing as Tier 1:
  //   - If lead.targetRole is set → applying framing referencing that role
  //   - Otherwise → informational framing (default for all leads without JD)
  var targetRole = (lead && lead.targetRole) ? lead.targetRole.toString().trim() : '';
  var hasTargetRole = !!targetRole;

  // ── Tier 3 parsed-JSON assembly ──
  // Hook paragraph — pure string assembly (no LLM, no hallucination)
  var hookParagraph;
  if (hasTargetRole) {
    // APPLYING framing — user has identified a specific role for this lead
    hookParagraph = 'Reaching out about the ' + targetRole + ' opportunity at ' + orgName + '. '
        + 'Owning P&L across multi-city operations, launching GTM for new verticals from zero, '
        + 'and driving growth through cross-functional execution has been my operating reality '
        + 'across 4.5+ years in quick-commerce and ed-tech.';
  } else {
    // INFORMATIONAL framing — default. No role claimed. Hook seed (from
    // sub-option B's logic) injected when dossier has a usable hook angle.
    //
    // PATCH 2026-05-18 (Tier 3 hook smoothing): the previous graft produced
    // sentences like "Reaching out about opportunities on your team at
    // Flipkart - specifically a discussion around the evolving landscape of
    // embedded insurance in e-commerce, specifically referencing Flipkart's
    // strategy and potential challenges in scaling adoption and managing
    // diverse product portfolios." That has three problems:
    //   1. "specifically" twice (once from template, once from hookSeed)
    //   2. The org name appears twice ("at Flipkart" + "Flipkart's strategy")
    //   3. Run-on length kills the cold-email opening rhythm
    //
    // The new path applies three normalizations to hookSeed before graft:
    //   - strip leading "A discussion around / about" → reduces to the
    //     subject phrase ("the evolving landscape of embedded insurance...")
    //   - strip leading "specifically" / "referencing" repetition
    //   - cap to first clause (everything up to first comma or full-stop)
    //     so the grafted sentence stays ≤ 25 words
    //   - drop the second org-name mention if the seed already contains it
    //     and the resulting sentence would have it twice
    // PATCH 2026-06-11-eq8-contentguards (T1):
    // The previous template spliced dossier.bestHookAngle (advisory research text
    // written as third-person advice: "a compelling hook would be to reference...")
    // verbatim into sendable copy, producing meta-advice leakage. Two fixes:
    //   (a) NEVER use advisory/bestHookAngle fields as sendable copy — Tier-3
    //       informational hook is now purely first-person canonical capability text,
    //       parameterised by a REAL org name only (placeholder org = no org clause).
    //   (b) Apply _PLACEHOLDER_ORG_RE to the BODY org token — "at your team"
    //       must never render in a hook.
    var _TIER3_PLACEHOLDER_ORG_RE = /^(?:their|your|the|our)\s+(?:company|team|org(?:anization)?|firm)$|^(?:unknown|n\/a|company|team)$/i;
    var orgClause = (orgName && !_TIER3_PLACEHOLDER_ORG_RE.test(orgName.trim()))
        ? ' at ' + orgName : '';
    hookParagraph = 'Owning P&L across multi-city operations, launching GTM for new verticals from zero, '
        + 'and driving growth through cross-functional execution has been my operating reality '
        + 'across 4.5+ years in quick-commerce and ed-tech — '
        + 'and it maps directly to what teams' + orgClause + ' are building.';
  }

  // Three experience bullets — static, from GAURAV_PROFILE for the chosen variant
  // Each pulled deterministically; no LLM judgment on framing.
  var experienceBullets = [
    {
      label: 'Blinkit Bistro (current)',
      body: 'Senior Manager owning station P&L across ~50 cloud kitchens in 4 cities. '
          + 'Resolved multi-city quality crisis - complaint rate cut by 94% across 121K orders in 2.5 weeks. '
          + 'Coordinated ops, supply chain, and quality teams across 30+ stakeholders.',
      showLorTag: false
    },
    {
      label: 'upGrad (2021-23)',
      body: 'Growth Lead building referral funnels from 0 to Rs 1.5 Cr in 4 months. '
          + 'Drove 100+ career transitions via ABM + MarTech stack, optimizing acquisition costs across channels. '
          + 'Managed cross-functional GTM across product, content, and partnership teams.',
      showLorTag: false
    },
    {
      label: 'Great Learning (2019-20)',
      body: 'Built B2B partnership pipeline reaching 3 enterprise clients in first quarter. '
          + 'Revenue from partnerships contributed 20% of target. '
          + 'Channel-expansion playbook directly applicable to scaling industry partnerships.',
      showLorTag: false
    }
  ];

  // PATCH at stamp -p4-cxotier3-enrich-amend: em-dash normalization removed.
  // Template strings now ship with em-dashes intact (standard professional
  // writing). En-dash → hyphen kept (these are typos, not intentional).
  experienceBullets.forEach(function(b) {
    b.body = b.body.replace(/[–]/g, '-');
  });

  // Build subject — deterministic.
  // PATCH 2026-05-16 (Option 5 / Sub-option 1): NO LONGER uses lead.designation
  // as subject topic. That produced subjects like "Senior Director - Myntra
  // Fashion Brands at Myntra" — framing the recipient's title as the role
  // being applied to. Informational default uses function-area phrasing.
  // Applying mode uses target_role.
  var subjectTopic = hasTargetRole ? targetRole : 'Growth & Operations';
  // _buildSubjectLine will add the "Job Application: " prefix + " — Gaurav Rathore" suffix
  var rawSubject = subjectTopic + ' at ' + orgName;

  var parsed = {
    subjectLine: rawSubject,
    greeting: 'Hi ' + greetingTarget + ',',
    hookParagraph: hookParagraph,
    bridgeSentence: 'Three 0-to-1 builds that map directly to this role:',
    experienceBullets: experienceBullets,
    motivationParagraph: 'The thread across all three: launching new verticals from zero, '
                       + 'optimizing unit economics under growth pressure, and coordinating '
                       + 'cross-functional teams to deliver measurable outcomes.',
    // currentRoleParagraph is the AI-tools-block header — pulled from REFERENCE_BLOCKS
    currentRoleParagraph: (refBlocks.aiTools && refBlocks.aiTools.header)
        ? refBlocks.aiTools.header
        // PATCH -eq8-draftpolish (F5): colon → period + GitHub link (mirrors Config.gs REFERENCE_BLOCKS)
        : 'On the builder side, three AI tools shipped independently (all live). <a href="https://github.com/GauravRIIMK" style="color:#1a73e8;text-decoration:underline;">github.com/GauravRIIMK</a>',
    showAiToolsBlock: true,    // renderer pulls the 3 AI bullets + GitHub footer from REFERENCE_BLOCKS
    // PATCH 2026-05-16 (Option 5 / Sub-option 4 — informational CTA):
    // Applying-framed closer used to assume a specific role context. Now:
    //   - applying mode (target_role set) → "discuss this role" specifically
    //   - informational mode (default) → hybrid: informational OR specific roles,
    //     whichever is useful to the recipient. Sub-option 4 CTA picked.
    closingLogistics: hasTargetRole
        ? ('Based in Gurgaon and available to start immediately. '
            + 'Would value 15 minutes to discuss the ' + targetRole + ' opportunity at ' + orgName + ' in detail.')
        : ('Based in Gurgaon and available to start immediately. '
            + 'Open to 15 minutes — could be an informational chat about the space, or about specific '
            + 'roles your team at ' + orgName + ' is hiring for, depending on what is most useful.'),
    closingResume: (refBlocks.resumeMention)
        ? refBlocks.resumeMention
        : 'Please find my resume attached below for further details. Would welcome the chance to discuss how this background aligns with what your team is building.',
    signoffText: 'Thanks and regards',
    psLine: 'Looking forward to learning more about how ' + orgName + ' is approaching this space.',
    cta: '',
    selectedHookTier: 0,
    bodyParagraphs: [],
    emailBody: '',
    // Marker — downstream code keys on this to route to NEEDS_REVIEW
    tier: 'DETERMINISTIC_FALLBACK',
    _injectedShape: 'DETERMINISTIC_FALLBACK'
  };

  // Run the same canonical-field injection + normalization that Claude path uses,
  // so the parsed object is indistinguishable in shape downstream.
  try { _injectCanonicalFields(parsed); } catch (e) { Logger.log('[Tier3] _injectCanonicalFields skipped: ' + e.message); }
  try { _normalizeParsedFields(parsed); } catch (e) { Logger.log('[Tier3] _normalizeParsedFields skipped: ' + e.message); }

  // Synthesize bodyParagraphs (mirrors the Claude-path synthesis at line ~1037)
  var bodyParts = [];
  if (parsed.hookParagraph)        bodyParts.push(parsed.hookParagraph);
  if (parsed.bridgeSentence)       bodyParts.push(parsed.bridgeSentence);
  parsed.experienceBullets.forEach(function(b) { bodyParts.push(b.label + ': ' + b.body); });
  if (parsed.currentRoleParagraph) bodyParts.push(parsed.currentRoleParagraph);
  if (parsed.motivationParagraph)  bodyParts.push(parsed.motivationParagraph);
  if (parsed.closingLogistics)     bodyParts.push(parsed.closingLogistics);
  if (parsed.closingResume)        bodyParts.push(parsed.closingResume);
  parsed.bodyParagraphs = bodyParts;
  parsed.emailBody = bodyParts.join('\n\n');

  // Render via the existing canonical HTML builder — same path as Tier 1
  var htmlBody;
  try {
    htmlBody = _buildHtmlEmail(parsed, lead, resumeSelection);
  } catch (renderErr) {
    Logger.log('[Tier3] CRITICAL — _buildHtmlEmail threw on deterministic template: ' + renderErr.message);
    // Last-resort minimal HTML so we never return empty
    htmlBody = '<p>Hi ' + greetingTarget + ',</p>'
             + '<p>' + hookParagraph + '</p>'
             + '<p>' + parsed.motivationParagraph + '</p>'
             + '<p>' + parsed.closingLogistics + '</p>'
             + '<p>' + parsed.closingResume + '</p>'
             + '<p>Thanks and regards,<br/><strong>Gaurav Rathore</strong></p>';
  }

  // Build final subject line via the existing prefix logic
  var finalSubject;
  try {
    finalSubject = _buildSubjectLine(parsed.subjectLine, lead, {});
  } catch (subjErr) {
    finalSubject = 'Job Application: ' + rawSubject + ' | Gaurav Rathore';
  }

  Logger.log('[Tier3] Deterministic draft assembled — subject: "' + finalSubject + '", body length: ' + htmlBody.length);

  return {
    success: true,
    subjectLine: finalSubject,
    emailBody: htmlBody,
    parsed: parsed,
    qualityNotes: 'DETERMINISTIC FALLBACK (Tier 3 STANDARD) — Claude composer unreachable; deterministic template used. Verify and personalize before send.',
    tier: 'DETERMINISTIC_FALLBACK',
    tier3Variant: 'STANDARD'  // Phase 4 marker — routing dispatch records which variant rendered
  };
}

// ─── PHASE 4 — CLASSIFICATION-AWARE TIER 3 DISPATCH ─────────────────────────
//
// Routes the deterministic-fallback path by classification template:
//   - CXO_SHORT       → _composeDeterministicFallback_CXO_SHORT (peer-to-peer, no bullets)
//   - HR_RECRUITER    → _composeDeterministicFallback_HR        (process-led bullets)
//   - STANDARD (default for anything else, including '' or undefined) → _composeDeterministicFallback
//
// Phase 4 closure spec (master prompt Section 3.5):
//   if (tier1FailedTwice || allCandidatesFailValidation) {
//     switch (classification.template) {
//       case 'CXO_SHORT':    return _composeDeterministicFallback_CXO_SHORT(...)
//       case 'HR_RECRUITER': return _composeDeterministicFallback_HR(...)
//       default:             return _composeDeterministicFallback(...)  // STANDARD
//     }
//   }
//
// Concerns surfaced per master prompt Section 4.5: ambiguous archetype
// (lead.archetype = "" for legacy rows OR classification undefined) → routes
// to STANDARD, NOT to CXO. Documented as the safer default — a not-senior-
// enough framing landing on a CXO is acceptable degradation; a CXO-framed
// email landing on an analyst breaks the social contract harder.

function _routeDeterministicFallback(lead, dossier, classification, resumeSelection) {
  var template = (classification && classification.template) ? classification.template.toString().trim() : '';
  Logger.log('[Tier3.Dispatch] classification.template="' + template +
             '" lead.archetype="' + (lead && lead.archetype || '') + '" row=' + (lead && lead.rowNum || '?'));
  if (template === 'CXO_SHORT') {
    return _composeDeterministicFallback_CXO_SHORT(lead, dossier, classification, resumeSelection);
  }
  if (template === 'HR_RECRUITER') {
    return _composeDeterministicFallback_HR(lead, dossier, classification, resumeSelection);
  }
  // Default safe path: STANDARD
  return _composeDeterministicFallback(lead, dossier, classification, resumeSelection);
}

// ─── PHASE 4-ENRICH — CXO_SHORT TIER 3 (5-line Leadership format) ───────────
//
// Stamp `-p4-cxotier3-enrich`. Refactored per Leadership playbook §2:
// signal-density-first, peer-tone, 90-125 word body target.
//
// 5-line structure:
//   1. Hook       (18-22 words): anchor + 2nd-order implication
//   2. Credibility (30-40 words): 3 brand-anchored outcomes, AI tools UNNAMED
//   3. Bridge     (15-20 words): problem-shape framing for {{company_name}}
//   4. Ask        (12-18 words): single CTA with Calendly anchor
//   5. P.S.       (~25 words): single strongest differentiator (shared with HR)
//
// Renderer leverage: `_buildHtmlEmailBulletV1` (line 2698) detects CXO shape
// by `bullets.length === 0 && motivationParagraph populated`. We preserve
// that detector by using motivationParagraph for the credibility line.
//
// Banner: STRIPPED per Leadership §1 audit ("reads junior to Director+").
// AI tools block: SUPPRESSED via showAiToolsBlock=false.
// closingResume: EMPTY per Leadership §1 ("single CTA only; resume self-evident").
// Signature: single-line provenance (ex-Great Learning · ex-upGrad · Blinkit Bistro).
// Subject: Pattern B "{{first_name}} | Gaurav — note on {{company_name}} growth & ops"

function _composeDeterministicFallback_CXO_SHORT(lead, dossier, classification, resumeSelection) {
  Logger.log('[Tier3.CXO_SHORT] Engaged for ' + (lead && lead.fullName || 'unknown') +
             ' (row ' + (lead && lead.rowNum || '?') + ')');

  var profile = (typeof GAURAV_PROFILE !== 'undefined') ? GAURAV_PROFILE : {};
  var cxo = profile.cxoVariant || {};

  // Personalization floor — orgName + firstName from doPost payload
  var orgName = (lead && lead.organization) ? lead.organization.toString().trim() : 'your team';
  var firstName = '';
  if (lead && lead.firstName) firstName = lead.firstName.toString().trim();
  else if (lead && lead.fullName) {
    var fn = lead.fullName.toString().trim().split(/\s+/)[0];
    if (/^[A-Za-zÀ-ſ][A-Za-zÀ-ſ'.\-]{1,}$/.test(fn)) firstName = fn;
  }
  var greetingTarget = firstName || ('Team ' + orgName);

  // ── 5-line content assembly per Leadership playbook §2 ────────────────
  // Substitution helper — both {{first_name}} and {{company_name}}
  function _sub(template) {
    return (template || '').toString()
      .replace(/\{\{company_name\}\}/g, orgName)
      .replace(/\{\{first_name\}\}/g, firstName || 'there');
  }

  // Line 1: Hook (18-22 words)
  var hookParagraph = _sub(cxo.hookFragment);
  if (!hookParagraph) {
    hookParagraph = orgName + ' is at a scale where growth, strategy, and marketing usually ' +
                    'blur into one problem — that overlap is where I do my best work.';
  }

  // PATCH 2026-06-12-strategy-tilt: Work-experience bullets (2-3, metric-led, ≤18 words each).
  // Rendered compactly between hook and bridge/ask per Mandate 4.
  // Uses cxoVariant.experienceBullets from Config.gs (3 verified entries).
  var cxoExpBullets = [];
  if (cxo.experienceBullets && cxo.experienceBullets.length >= 2) {
    cxoExpBullets = cxo.experienceBullets.map(function(b) {
      return { label: b.label || '', body: b.body || '', showLorTag: false };
    });
  } else {
    // Inline fallback (matches cxoVariant entries verbatim)
    cxoExpBullets = [
      { label: 'upGrad',         body: 'Built referral funnel from 0 to ₹1.5 Cr in 4 months across 14 cross-functional teams.', showLorTag: false },
      { label: 'Blinkit Bistro', body: 'Ran P&L for ~50 cloud kitchens, 4 cities; cut complaint rate 94% across 121K orders.', showLorTag: false },
      { label: 'Great Learning', body: 'Scaled B2B partnerships across 50+ countries; built international vertical from zero.', showLorTag: false }
    ];
  }

  // Line 2: Credibility operator phrase — short summary (≤20 words), NOT a restatement of bullets.
  // motivationParagraph now plays this role for the CXO email after bullets are rendered.
  var motivationParagraph = (cxo.credibilityParagraph || '').toString() ||
    'Builder who ships the operating layer most teams don\'t see until it breaks.';

  // Line 3: Bridge (15-20 words) — problem-shape framing
  var bridgeSentence = _sub(cxo.bridgeFragment);
  if (!bridgeSentence) {
    bridgeSentence = 'If ' + orgName + ' is hiring a founding operator to own the ' +
                     'AI-native strategy and growth layer, worth 15 minutes?';
  }

  // Line 4: Ask (12-18 words) — single CTA with inline Calendly anchor.
  // _buildHtmlEmailBulletV1 renders closingLogistics as plain text; we embed
  // the Calendly URL inline as plain text + HTML anchor (renderer handles both).
  var calendlyUrl = (cxo.askCalendlyUrl || 'https://calendly.com/speak-to-gaurav/30min');
  var askText = (cxo.askFragment || '15 minutes Tue or Thu?').toString();
  // Plain-text form preserved in closingLogistics; the HTML render gets an
  // anchored Calendly link automatically via the existing renderer logic
  // (REFERENCE_BLOCKS.calendlyAnchor injection in _buildHtmlEmailBulletV1).
  var closingLogistics = askText + ' → Schedule via Calendly: ' + calendlyUrl;

  // Subject — Pattern B: "{{first_name}} | Gaurav — note on {{company_name}} strategy & growth"
  // PATCH 2026-06-12-strategy-tilt: defaulted to "strategy & growth" (was "growth & ops")
  var rawSubject = _sub(cxo.subjectTemplate || '{{first_name}} | Gaurav — note on {{company_name}} strategy & growth');

  var parsed = {
    subjectLine: rawSubject,
    greeting: 'Hi ' + greetingTarget + ',',
    hookParagraph: hookParagraph,
    bridgeSentence: bridgeSentence,
    motivationParagraph: motivationParagraph,
    // PATCH 2026-06-12-strategy-tilt: CXO now ships 2-3 compact work-ex bullets.
    // templateId discriminator set so all shape detectors route correctly.
    experienceBullets: cxoExpBullets,
    currentRoleParagraph: '',
    showAiToolsBlock: false,
    templateId: 'CXO_SHORT',
    closingLogistics: closingLogistics,
    // Resume mention SUPPRESSED — Leadership §1: "Single CTA. Resume self-evident."
    closingResume: '',
    signoffText: 'Thanks and regards',
    psLine: (cxo.psFragment || ''),
    cta: '',
    selectedHookTier: 0,
    bodyParagraphs: [],
    emailBody: '',
    tier: 'DETERMINISTIC_FALLBACK',
    _injectedShape: 'CXO_SHORT'
  };

  // Run canonical-field injection + normalization
  try { _injectCanonicalFields(parsed); } catch (e) { Logger.log('[Tier3.CXO_SHORT] _injectCanonicalFields skipped: ' + e.message); }
  try { _normalizeParsedFields(parsed); } catch (e) { Logger.log('[Tier3.CXO_SHORT] _normalizeParsedFields skipped: ' + e.message); }

  // Synthesize bodyParagraphs in CXO order: hook → bullets → motivation phrase → bridge → ask
  // PATCH 2026-06-12-strategy-tilt: bullets now present; include them in synthesized text
  var bodyParts = [];
  if (parsed.hookParagraph) bodyParts.push(parsed.hookParagraph);
  if (parsed.experienceBullets && parsed.experienceBullets.length > 0) {
    parsed.experienceBullets.forEach(function(b) {
      bodyParts.push((b.label ? b.label + ': ' : '') + b.body);
    });
  }
  if (parsed.motivationParagraph) bodyParts.push(parsed.motivationParagraph);
  if (parsed.bridgeSentence)      bodyParts.push(parsed.bridgeSentence);
  if (parsed.closingLogistics)    bodyParts.push(parsed.closingLogistics);
  parsed.bodyParagraphs = bodyParts;
  parsed.emailBody = bodyParts.join('\n\n');

  var htmlBody;
  try {
    htmlBody = _buildHtmlEmail(parsed, lead, resumeSelection);
  } catch (renderErr) {
    Logger.log('[Tier3.CXO_SHORT] CRITICAL — _buildHtmlEmail threw: ' + renderErr.message);
    htmlBody = '<p>Hi ' + greetingTarget + ',</p>' +
               '<p>' + hookParagraph + '</p>' +
               '<p>' + motivationParagraph + '</p>' +
               '<p>' + bridgeSentence + '</p>' +
               '<p>' + closingLogistics + '</p>' +
               '<p>Thanks and regards,<br/><strong>Gaurav Rathore</strong></p>';
  }

  // Subject: NO "Job Application:" prefix — _buildSubjectLine with isCxoShort=true skips it
  var finalSubject;
  try {
    finalSubject = _buildSubjectLine(parsed.subjectLine, lead, {}, /*isCxoShort=*/true);
  } catch (subjErr) {
    finalSubject = rawSubject + ' | Gaurav Rathore';
  }

  Logger.log('[Tier3.CXO_SHORT] Draft assembled — subject: "' + finalSubject +
             '", body length: ' + htmlBody.length);

  return {
    success: true,
    subjectLine: finalSubject,
    emailBody: htmlBody,
    parsed: parsed,
    // Updated NEEDS_REVIEW note per Section 7 spec — 4-step reviewer checklist
    qualityNotes: '[TIER3_FALLBACK_CXO] Claude composition unavailable. Signal-density CXO variant used. ' +
                  'BEFORE SEND, verify and personalize: ' +
                  '1) Replace the hook line with a researched second-order observation about the recipient\'s recent activity (Leadership playbook §7 — 2-minute method). ' +
                  '2) Verify subject line first-name + company-name substitutions reflect the actual recipient. ' +
                  '3) Confirm the bridge line maps to a real problem shape this recipient owns. ' +
                  '4) Confirm Calendly link reflects current availability window.',
    tier: 'DETERMINISTIC_FALLBACK',
    tier3Variant: 'CXO_SHORT'
  };
}

// ─── PHASE 4-ENRICH — HR_RECRUITER TIER 3 (Recruiter-playbook compact) ──────
//
// Stamp `-p4-cxotier3-enrich`. Refactored per Recruiter playbook §4-§8:
// identity-statement-first, 4 brand-anchored proof bullets (AI bullet LAST),
// India screening block with [VERIFY] placeholders. 150-200 word body target.
//
// Structure (Recruiter §6):
//   Banner image (kept — recruiters expect visual marker)
//   Greeting
//   Hook (1 sentence with {{company_name}})
//   Locked identity statement (verbatim, never paraphrased — §5)
//   4 proof bullets, AI bullet LAST (§4 Rule 1: outcome before AI)
//   Closing line — "problem-shape, not title" (§5)
//   India screening block (§11.1 — omitting CTC/notice triggers silent skip)
//   P.S. — shared with cxoVariant (single strongest line)
//   Multi-line signature (§6 — IIM-K is anchor)
//
// Subject: Pattern A "AI-native Growth & Strategy operator — ex-upGrad (₹1.5 Cr funnel) | Gaurav Rathore"
//   Identity-led, 82 chars (mobile-safe). NO {{company_name}} substitution.
//   NO "Job Application:" prefix.
//
// HTML built INLINE here (does NOT route through _buildHtmlEmail) because:
//   - _buildHtmlEmail auto-injects AI tools block + closing resume mention
//   - HR_RECRUITER compact format explicitly omits those
//   - Reusing _buildHtmlEmail would produce ~7900-char output (5x target)
//   - Inline build uses the same EMAIL_STYLE constants + sanitize helpers

function _composeDeterministicFallback_HR(lead, dossier, classification, resumeSelection) {
  Logger.log('[Tier3.HR] Engaged for ' + (lead && lead.fullName || 'unknown') +
             ' (row ' + (lead && lead.rowNum || '?') + ')');

  var profile = (typeof GAURAV_PROFILE !== 'undefined') ? GAURAV_PROFILE : {};
  var hr = profile.hrVariant || {};
  var s = (typeof EMAIL_STYLE !== 'undefined') ? EMAIL_STYLE :
    { fontFamily: 'Arial, sans-serif', fontSize: '15px', lineHeight: '1.55', color: '#222' };

  // Personalization floor
  var orgName = (lead && lead.organization) ? lead.organization.toString().trim() : 'your team';
  var firstName = '';
  if (lead && lead.firstName) firstName = lead.firstName.toString().trim();
  else if (lead && lead.fullName) {
    var fn = lead.fullName.toString().trim().split(/\s+/)[0];
    if (/^[A-Za-zÀ-ſ][A-Za-zÀ-ſ'.\-]{1,}$/.test(fn)) firstName = fn;
  }
  var greetingTarget = firstName || ('Team ' + orgName);

  // Hook with {{company_name}} substitution
  var hookParagraph = (hr.hookFragment || '').toString()
    .replace(/\{\{company_name\}\}/g, orgName);
  if (!hookParagraph) {
    hookParagraph = 'I have been following ' + orgName + '\'s recent activity — there are usually ' +
                    'a few growth, lifecycle, and strategy/ops surfaces where an AI-native operator ' +
                    'can compress what a team used to do.';
  }

  // Locked identity statement (verbatim per Recruiter §5)
  var identityStatement = (hr.identityStatement || '').toString() ||
    'I am a growth & strategy operator who builds AI systems so lean teams ' +
    'deliver what normally takes 3-5x the headcount.';

  // 4 proof bullets, AI bullet LAST (Recruiter §4 Rule 1)
  var hrBullets = (hr.bullets && hr.bullets.length === 4) ? hr.bullets : [
    'upGrad — built the 0-to-1 referral funnel to ₹1.5 Cr in 4 months.',
    'Blinkit Bistro — ran ops for ~50 cloud kitchens across 4 cities, 30+ stakeholders.',
    'Great Learning — scaled B2B partnerships across 50+ countries; youngest department lead in the company\'s history.',
    'Shipped 3 production AI tools solo — automating sourcing, outreach and CRM end-to-end.'
  ];

  // Closing line (Recruiter §5 — problem-shape framing)
  var closingLine = (hr.closingLine || '').toString() ||
    'I am exploring roles across growth, lifecycle marketing, and strategy & ops — ' +
    'anywhere an AI-native operator can compress what a team used to do. Glad to be considered ' +
    'for any current or upcoming fit.';

  // India screening block (Recruiter §11.1)
  var indiaContextBlock = (hr.indiaContextBlock || '').toString() ||
    'Quick context for screening:\n' +
    '- Total experience: 4.5+ years | Currently: Senior Manager, Blinkit Bistro\n' +
    '- Notice period: [VERIFY BEFORE SEND] | Location: Gurgaon; open to NCR / Mumbai / Bengaluru / Hybrid / Remote\n' +
    '- Expected CTC: [VERIFY BEFORE SEND]';

  // P.S. — shared with cxoVariant
  var psLine = (hr.psFragment || '').toString() ||
    'Youngest department lead at Great Learning — scaled B2B partnerships across 50+ countries before turning 25.';

  // Subject — Pattern A (Recruiter §8), identity-led, 82 chars
  var rawSubject = (hr.subjectTemplate || '').toString() ||
    'AI-native Growth & Strategy operator — ex-upGrad (₹1.5 Cr funnel) | Gaurav Rathore';

  // Build subject — bypass _buildSubjectLine to avoid "Job Application:" prefix
  var finalSubject = rawSubject;

  // ── Inline HTML build ────────────────────────────────────────────────
  var pStyle = 'margin:0 0 12px 0;font-family:' + s.fontFamily + ';font-size:' + s.fontSize +
               ';line-height:' + s.lineHeight + ';color:' + s.color + ';';
  var liStyle = 'margin:0 0 8px 0;font-family:' + s.fontFamily + ';font-size:' + s.fontSize +
                ';line-height:' + s.lineHeight + ';color:' + s.color + ';';
  var contextStyle = 'margin:0 0 12px 0;font-family:' + s.fontFamily + ';font-size:14px' +
                     ';line-height:1.5;color:#555;background:#f6f6f6;padding:10px 12px;border-radius:4px;';
  var psStyle = 'margin:18px 0 0 0;font-family:' + s.fontFamily + ';font-size:14px' +
                ';line-height:' + s.lineHeight + ';color:#555;font-style:italic;';
  var sigStyle = 'margin:18px 0 0 0;font-family:' + s.fontFamily + ';font-size:14px' +
                 ';line-height:1.5;color:#333;';

  // Banner — KEEP per Recruiter playbook; dispatched via _delivBannerHtml().
  // PATCH 2026-06-11-eq8-deliv-v2 (T2): FLAG ON uses CSS table header.
  // FLAG OFF: legacy cid:emailBanner img.
  var bannerHtml = _delivBannerHtml();

  // Greeting + hook + identity
  var html = bannerHtml +
    '<p style="' + pStyle + '">Hi ' + _sanitizeText(greetingTarget) + ',</p>\n' +
    '<p style="' + pStyle + '">' + _sanitizeText(hookParagraph) + '</p>\n' +
    '<p style="' + pStyle + '">' + _sanitizeText(identityStatement) + '</p>\n';

  // 4 proof bullets (table-based markup matching _buildHtmlEmailBulletV1 pattern)
  // PATCH `-hr-cxo-template-polish` (2026-06-09): improved indentation +
  // inter-bullet spacing. Previously bullets used `padding:0 6px 0 12px` (12px
  // left indent) and `margin:0 0 8px 0` (8px between bullets) — looked
  // cramped and barely indented. New values: `padding:0 8px 0 24px` (24px
  // left indent matches standard list semantics) and `margin:0 0 12px 0`
  // (12px between bullets for readability). Bullet column widened from 22px
  // to 28px so the `&bull;` glyph sits in a stable column even on narrow
  // viewports. Single wrapping <table> with multiple rows instead of 4
  // separate tables — DOM is tighter, vertical rhythm is consistent across
  // bullets.
  var tdBase = 'font-family:' + s.fontFamily + ';font-size:' + s.fontSize +
               ';line-height:' + s.lineHeight + ';color:' + s.color + ';';
  html += '<table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px 0;width:100%;">\n';
  hrBullets.forEach(function(bulletText) {
    html += '  <tr>\n' +
            '    <td valign="top" style="' + tdBase + 'width:28px;padding:0 8px 8px 24px;">&bull;</td>\n' +
            '    <td valign="top" style="' + tdBase + 'padding:0 0 8px 0;">' + _sanitizeText(bulletText) + '</td>\n' +
            '  </tr>\n';
  });
  html += '</table>\n';

  // Closing line
  html += '<p style="' + pStyle + 'margin-top:12px;">' + _sanitizeText(closingLine) + '</p>\n';

  // India screening block — styled distinctly so [VERIFY BEFORE SEND] markers stand out
  var contextLines = indiaContextBlock.split('\n').map(function(line) {
    return _sanitizeText(line);
  });
  html += '<div style="' + contextStyle + '">\n' +
          '  <strong>' + contextLines[0] + '</strong><br/>\n';
  for (var i = 1; i < contextLines.length; i++) {
    if (contextLines[i].trim()) {
      html += '  ' + contextLines[i] + '<br/>\n';
    }
  }
  html += '</div>\n';

  // Signature
  // PATCH `-hr-cxo-template-polish` (2026-06-09) + `-amend2` (2026-06-09):
  // LinkedIn + github are now real <a href> hyperlinks. Previously the line
  // `LinkedIn | github.com/GauravRIIMK` shipped as plain text — "LinkedIn"
  // was just a literal word, github MIGHT auto-link in some Gmail clients
  // but not reliably.
  //
  // amend2 fix: canonical URLs live in `GAURAV_FACTS`, not `GAURAV_PROFILE`.
  // Read from the right object (was incorrectly reading from `profile.*` in
  // the original polish patch — worked only because of the || fallback
  // literal, but didn't actually pull from Config as intended).
  var facts = (typeof GAURAV_FACTS !== 'undefined') ? GAURAV_FACTS : {};
  var sigLine1 = (hr.signatureLine1 || 'MBA, IIM Kozhikode | B.E., Thapar University');
  var sigPhone = (hr.signaturePhone || '+91-[VERIFY]');
  var canonicalLinkedIn = (facts.linkedin || 'https://www.linkedin.com/in/gaurav1-grow-learn-together/');
  var canonicalGithub = (facts.githubUrl || 'https://github.com/GauravRIIMK');
  var linkColor = (typeof EMAIL_STYLE !== 'undefined' && EMAIL_STYLE.linkColor) ? EMAIL_STYLE.linkColor : '#0b66c3';
  var sigLine2Html = '<a href="' + canonicalLinkedIn + '" style="color:' + linkColor +
                     ';text-decoration:underline;">LinkedIn</a>' +
                     ' | <a href="' + canonicalGithub + '" style="color:' + linkColor +
                     ';text-decoration:underline;">github.com/GauravRIIMK</a>';

  html += '<p style="' + sigStyle + '">' +
          '<strong>Thanks and regards,</strong><br/>\n' +
          '<strong>Gaurav Rathore</strong><br/>\n' +
          _sanitizeText(sigLine1) + '<br/>\n' +
          _sanitizeText(sigPhone) + ' | ' + sigLine2Html +
          '</p>\n';

  // P.S.
  html += '<p style="' + psStyle + '">P.S. ' + _sanitizeText(psLine) + '</p>\n';

  // Synthesize plain-text body for parsed.emailBody (used by validators)
  var bodyParts = [
    'Hi ' + greetingTarget + ',',
    hookParagraph,
    identityStatement
  ];
  hrBullets.forEach(function(b) { bodyParts.push('• ' + b); });
  bodyParts.push(closingLine);
  bodyParts.push(indiaContextBlock);
  bodyParts.push('Thanks and regards,\nGaurav Rathore');
  bodyParts.push('P.S. ' + psLine);

  var parsed = {
    subjectLine: rawSubject,
    greeting: 'Hi ' + greetingTarget + ',',
    hookParagraph: hookParagraph,
    bridgeSentence: '',
    experienceBullets: hrBullets.map(function(b) {
      var firstColon = b.indexOf('—');
      if (firstColon > 0) {
        return { label: b.substring(0, firstColon).trim(),
                 body: b.substring(firstColon + 1).trim(),
                 showLorTag: false };
      }
      return { label: 'Experience', body: b, showLorTag: false };
    }),
    motivationParagraph: identityStatement,
    currentRoleParagraph: '',
    showAiToolsBlock: false,
    closingLogistics: closingLine,
    closingResume: indiaContextBlock,  // routed into closingResume slot for downstream visibility
    signoffText: 'Thanks and regards',
    psLine: psLine,
    cta: '',
    selectedHookTier: 0,
    bodyParagraphs: bodyParts,
    emailBody: bodyParts.join('\n\n'),
    tier: 'DETERMINISTIC_FALLBACK',
    _injectedShape: 'HR_RECRUITER'
  };

  // PATCH 2026-06-12-e2e-hardening: normalize parsed fields so em-dashes and
  // typographic chars in psLine/hookParagraph/bullets are stripped consistently
  // with the CXO path (which calls _normalizeParsedFields at its line 2567).
  // Without this, hrResult.parsed.psLine retains the raw em-dash from
  // CONFIG.TIER3_VARIANTS.hrVariant.psFragment while cxoResult.parsed.psLine
  // is normalized — causing tier3_both_variants_share_ps assertEqual to fail.
  try { _normalizeParsedFields(parsed); } catch (_hrNormErr) {
    Logger.log('[Tier3.HR] _normalizeParsedFields skipped: ' + _hrNormErr.message);
  }

  Logger.log('[Tier3.HR] Draft assembled — subject: "' + finalSubject +
             '", body length: ' + html.length);

  return {
    success: true,
    subjectLine: finalSubject,
    emailBody: html,
    parsed: parsed,
    // Updated NEEDS_REVIEW note per Section 7 spec — 4-step reviewer checklist
    qualityNotes: '[TIER3_FALLBACK_HR] Claude composition unavailable. Standardized HR variant used. ' +
                  'BEFORE SEND, verify and personalize: ' +
                  '1) Replace the hook line with one sentence tying your profile to this company\'s recent signal (Recruiter playbook §7 — 2-minute method). ' +
                  '2) Fill in notice period in screening block (currently [VERIFY BEFORE SEND]). ' +
                  '3) Fill in expected CTC in screening block (use range, never "negotiable" alone). ' +
                  '4) Verify phone number in signature.',
    tier: 'DETERMINISTIC_FALLBACK',
    tier3Variant: 'HR_RECRUITER'
  };
}

// ─── QUICK VALIDATION ─────────────────────────────────────

/**
 * Validates email for spam, banned openers, attachment mentions, and word counts.
 * @param {Object} parsed - Parsed composition response
 * @param {Object} lead - LeadProfile
 * @returns {Object} {issues: []}
 */
/**
 * PATCH `-eq8-content-fix` (#5): LLM refusal / no-data leak guard (pure).
 * The model sometimes verbalizes its inability ("there is no hook", "No data
 * available", "No match", "as an AI", "unable to…") directly into a field.
 * FATAL-flag those so the Tier-3 deterministic ladder engages and the lead
 * gets a clean fallback draft instead of a refusal string in the hook.
 * Pure over `parsed` — no lead/sheet access — so it is unit-testable alone.
 */
function _refusalPhraseIssues(parsed) {
  var out = [];
  if (!parsed) return out;
  var fields = {
    hookParagraph: parsed.hookParagraph,
    psLine: parsed.psLine,
    motivationParagraph: parsed.motivationParagraph,
    subjectLine: parsed.subjectLine
  };
  // Word-anchored phrases. NOTE (-eq8-content-fix-amend2): bracket literals
  // CANNOT live inside the \b group — there is no word boundary before "[",
  // so /\b\[hook\]/ never matches. They are checked separately below.
  var re = /\b(there is no hook|no hook (available|found|here)|no data available|no relevant (data|hook|information)|no match found|no match\b|insufficient data|as an ai\b|i (cannot|can't|am unable to|don'?t have)|unable to (find|provide|generate)|not available\b|n\/a\b|no information (available|found))/i;
  var literals = ['[fill from canonical]', '[hook]'];
  Object.keys(fields).forEach(function(f) {
    var v = (fields[f] || '').toString();
    if (!v) return;
    var hit = null;
    if (re.test(v)) {
      var m = v.match(re);
      hit = m ? m[0] : 'refusal-phrase';
    } else {
      var lower = v.toLowerCase();
      for (var li = 0; li < literals.length; li++) {
        if (lower.indexOf(literals[li]) >= 0) { hit = literals[li]; break; }
      }
    }
    if (hit) {
      out.push('FATAL: Refusal/no-data text in ' + f + ' ("' + hit +
               '") — model declined to generate sendable copy; routing to Tier 3.');
    }
  });
  return out;
}

/**
 * PATCH 2026-06-11-eq8-contentguards (T1):
 * Detects meta-advice / advisory / third-person leakage in parsed fields.
 * These patterns indicate dossier advisory text (bestHookAngle, hooks[],
 * relevanceToGaurav written as "a compelling hook would be...") was spliced
 * verbatim into sendable copy — ships nonsense to recipients.
 *
 * Pure over `parsed` — no lead/sheet access — independently unit-testable.
 * All patterns are FATAL → route to Tier-3 deterministic fallback.
 *
 * @param {Object} parsed - Composition fields object
 * @returns {string[]} Array of FATAL issue strings (empty if clean)
 */
function _metaAdviceIssues(parsed) {
  var out = [];
  if (!parsed) return out;
  var fields = {
    hookParagraph:       parsed.hookParagraph,
    psLine:              parsed.psLine,
    motivationParagraph: parsed.motivationParagraph,
    subjectLine:         parsed.subjectLine
  };
  // Patterns that indicate advisory/meta text leaked into sendable copy.
  var metaPatterns = [
    // "a compelling hook would be to reference..." / "a strong opening would be..."
    /\ba (compelling|personalized|strong|good|great|effective) (hook|message|opening|intro|introduction)\b/i,
    // "would be to reference/mention/highlight ..."
    /\bwould be to (reference|mention|highlight|discuss|address|leverage|emphasize)\b/i,
    // "referencing a recent..." / "referencing a specific..."
    /\breferencing a (recent|specific|key|notable|particular)\b/i,
    // truncated sentence ending — "demonstrating an." or "demonstrating a potential."
    /\bdemonstrating an?\s*\.?\s*$/i,
    // third-person advice about what Gaurav should say
    /\byour profile (shows|suggests|indicates|reveals)\b/i,
    // advisory phrasing: "this could be a hook" / "this is a hook angle"
    /\bthis (could be|would be|is) (a|the) (hook|opening|angle|intro)\b/i,
    // "hook angle" appears literally in sendable copy
    /\bhook angle\b/i
  ];
  Object.keys(fields).forEach(function(f) {
    var v = (fields[f] || '').toString();
    if (!v) return;
    metaPatterns.forEach(function(re) {
      if (re.test(v)) {
        var m = v.match(re);
        out.push('FATAL: Meta-advice/advisory text in ' + f + ' ("' + (m ? m[0] : 'pattern') +
                 '") — dossier advisory field spliced into sendable copy; routing to Tier 3.');
      }
    });
  });
  return out;
}

/**
 * PATCH 2026-06-12-strategy-tilt: Identity-mirror hallucination gate.
 * Detects first-person claims that Gaurav has recruiting/TA/talent-acquisition
 * experience — caused by the model mirroring the RECIPIENT's profession
 * (HR/Recruiter) into the SENDER's claimed background, fusing it with his real
 * 4.5yr quick-commerce/ed-tech tenure.
 *
 * Pure over `parsed` — no lead/sheet access — independently unit-testable.
 * All patterns are FATAL → route to Tier-3 deterministic fallback.
 *
 * Scopes: hookParagraph, bodyParagraphs, bridgeSentence, motivationParagraph.
 *
 * @param {Object} parsed - Composition fields object
 * @returns {string[]} Array of FATAL issue strings (empty if clean)
 */
function _identityMirrorIssues(parsed) {
  var out = [];
  if (!parsed) return out;
  // Scan all body-copy fields where the hallucination could appear
  var scanFields = {
    hookParagraph:       parsed.hookParagraph,
    motivationParagraph: parsed.motivationParagraph,
    bridgeSentence:      parsed.bridgeSentence
  };
  // Also scan bodyParagraphs joined
  var bodyJoined = Array.isArray(parsed.bodyParagraphs) ? parsed.bodyParagraphs.join(' ') : '';
  if (bodyJoined) scanFields.bodyParagraphs = bodyJoined;

  // Two patterns for identity-mirror hallucination:
  // Pattern A: first-person prefix followed by TA domain (e.g. "my experience in talent acquisition")
  // Pattern B: TA domain statement followed by first-person ownership phrase
  //   (e.g. "Scaling TA functions...has been my operating reality")
  var taPatternA = /(my|I have|I've|I bring|my operating reality|my experience)[^.]{0,90}(talent acquisition|\bTA\b(?!\s+\w{4})|recruit(ing|ment)|employer brand|hiring pipeline|sourcing pipeline)/i;
  // Pattern B: TA domain FIRST, ownership language following (lookahead removed for \bTA\b —
  // Pattern B already constrains false positives via the trailing ownership phrase requirement).
  var taPatternB = /(talent acquisition|\bTA\b|recruit(ing|ment)|employer brand|hiring pipeline|sourcing pipeline)[^.]{0,120}(has been my|my operating reality|my experience|I have)/i;
  var taPattern = { test: function(v) { return taPatternA.test(v) || taPatternB.test(v); }, exec: function(v) { return taPatternA.exec(v) || taPatternB.exec(v); } };

  Object.keys(scanFields).forEach(function(f) {
    var v = (scanFields[f] || '').toString();
    if (!v) return;
    if (taPattern.test(v)) {
      var m = taPattern.exec(v);
      out.push('FATAL: Identity-mirror hallucination in ' + f + ' — Gaurav has ZERO TA/recruiting experience; ' +
               'model mirrored recipient\'s domain onto sender. Matched: "' + (m ? m[0].substring(0, 80) : 'pattern') +
               '". Routing to Tier 3.');
    }
  });
  return out;
}

function _quickValidate(parsed, lead) {
  var issues = [];

  // Combine body text for scanning
  var bodyText = (parsed.bodyParagraphs || []).join(' ') + ' ' + (parsed.cta || '');
  var bodyLower = bodyText.toLowerCase();
  var subjLower = parsed.subjectLine.toLowerCase();

  // ── PATCH `-eq8-content-fix` (#5): LLM refusal / no-data leak guard ──────
  // Extracted to _refusalPhraseIssues (pure, independently testable) at
  // `-eq8-content-fix-amend` — the inline version couldn't be unit-tested
  // without satisfying ALL of _quickValidate's downstream field requirements.
  issues = issues.concat(_refusalPhraseIssues(parsed));

  // ── PATCH 2026-06-11-eq8-contentguards (T1): meta-advice / advisory leak guard ──
  // Advisory dossier fields (bestHookAngle, hooks[], relevanceToGaurav) are
  // written as third-person advice ("a compelling hook would be to reference...").
  // They must NEVER reach sendable copy. _metaAdviceIssues is pure and testable.
  issues = issues.concat(_metaAdviceIssues(parsed));

  // ── PATCH 2026-06-12-strategy-tilt: identity-mirror hallucination gate (FATAL) ──
  // Model mirrors HR/Recruiter recipient's profession into Gaurav's claimed background.
  // FATAL → Tier-3 where HR variant text is verified clean.
  issues = issues.concat(_identityMirrorIssues(parsed));

  // ── PATCH 2026-06-12-strategy-tilt: ops/operations in subject line (WARN) ──
  // Subject must lead with Strategy/Marketing/Growth. "Ops"/"Operations" as the
  // headline is a signal the S4 guard wasn't sufficient. WARN only (not FATAL)
  // so Tier-3 fallbacks are not burned on a subject-word concern alone.
  if (/\b(ops|operations)\b/i.test(parsed.subjectLine)) {
    issues.push('WARN: Subject line contains "ops"/"operations" — subject should lead with Strategy/Marketing/Growth per role-positioning mandate. Subject: "' + parsed.subjectLine + '"');
  }

  // Check for attachment mentions in BODY (FATAL).
  // EXCEPTION: closingResume is allowed to reference "resume/attached/please find" — it is the
  // canonical template's fixed footer sentence ("Please find my resume attached below...").
  // Build a scrubbed version of bodyText that excludes the closingResume content before scanning.
  //
  // PATCH 2026-05-13 (AUDIT R20): switched from literal-string replace to a
  // regex that matches any paraphrase of the canonical resume-mention. The
  // literal replace silently did nothing when Claude rephrased "Please find
  // my resume attached" (word order change, punctuation diff), causing the
  // body scanner to detect "resume" + "attached" and FATAL-loop into a
  // recompose. The regex anchors on the unmistakable opening phrase
  // "please find my resume attached" (case-insensitive, allowing any
  // intervening content up to 300 chars) which is the canonical signature
  // of the closing-resume sentence.
  var bodyLowerForAttachCheck = bodyLower.replace(
    /please find my resume attached[\s\S]{0,300}/i,
    ' '
  );
  // Belt-and-suspenders: also strip the exact closingResume content if it
  // was provided in parsed (catches paraphrases that don't start with
  // "please find").
  var closingResumeContent = (parsed.closingResume || '').toLowerCase();
  if (closingResumeContent) {
    bodyLowerForAttachCheck = bodyLowerForAttachCheck.replace(closingResumeContent, ' ');
  }

  var attachmentKeywords = ['attached', 'attachment', 'please find', 'resume', 'cv', 'enclosed'];
  attachmentKeywords.forEach(function(kw) {
    if (bodyLowerForAttachCheck.indexOf(kw) >= 0) {
      issues.push('FATAL: Body mentions "' + kw + '" — resume is auto-attached, do not reference it in hook/bullet/bridge');
    }
  });

  // Check for direct job-asking language (FATAL)
  var jobAskingPatterns = ['hire me', 'job opportunity', 'looking for a position', 'looking for a role',
    'employment opportunity', 'hiring manager', 'job application'];
  jobAskingPatterns.forEach(function(pattern) {
    if (bodyLower.indexOf(pattern) >= 0) {
      issues.push('FATAL: Direct job-asking language "' + pattern + '" — ask for conversation instead');
    }
  });

  // Check for banned openers in first paragraph (2026 research-backed dead list)
  var bannedOpenerPhrases = [
    'i hope this email finds you well',
    'i hope you are doing well',
    'hope this finds you well',
    'my name is',
    'i\'m reaching out because',
    'i am reaching out because',
    'i wanted to reach out',
    'i wanted to connect',
    'i believe you might be interested',
    'i came across your profile',
    'i saw your profile',
    'sorry to bother you',
    'i know you are busy',
    'i know you\'re busy',
    'just following up',
    'dear sir', 'dear madam'
  ];
  var firstPara = (parsed.bodyParagraphs && parsed.bodyParagraphs.length > 0)
    ? parsed.bodyParagraphs[0].toLowerCase() : bodyLower.substring(0, 200);

  bannedOpenerPhrases.forEach(function(opener) {
    var pos = firstPara.indexOf(opener);
    // indexOf returns -1 when not found; must check pos >= 0
    if (pos >= 0 && pos < 15) {
      issues.push('FATAL: Banned opener "' + opener + '" — use playbook archetype instead');
    }
  });

  // Spam trigger words check
  var spamWords = ['free', 'act now', 'limited time', 'guaranteed', 'no obligation',
    'click here', 'subscribe', 'winner', 'congratulations', 'earn money',
    'urgent', 'discount', 'special offer', 'risk free'];
  spamWords.forEach(function(sw) {
    if (bodyLower.indexOf(sw) >= 0 || subjLower.indexOf(sw) >= 0) {
      issues.push('Spam trigger: "' + sw + '" — may hurt deliverability');
    }
  });

  // You/Your vs I/My ratio check.
  // PATCH 2026-05-12: scoped to the HOOK PARAGRAPH only when BULLET_V1 is in
  // play. BULLET_V1's experience bullets naturally read in first person but
  // start with action verbs (no "I"); the closingLogistics/closingResume are
  // already impersonal. Globally measuring "I" count on the rendered body
  // produces false positives. For non-BULLET templates, keep the global check.
  var isBulletV1 = Array.isArray(parsed.experienceBullets) && parsed.experienceBullets.length > 0;
  var ratioScope = isBulletV1
    ? (parsed.hookParagraph || '')
    : bodyText;
  var iCount = (ratioScope.match(/\bI\b/g) || []).length;
  var youCount = (ratioScope.match(/\byou\b|\byour\b/gi) || []).length;
  if (iCount > 1 && youCount < iCount) {
    issues.push((isBulletV1 ? 'Hook self-centered: ' : 'Self-centered: ')
      + iCount + ' "I" vs ' + youCount + ' "you/your" - flip the ratio');
  }

  // Body word count check.
  // BULLET_V1 format includes closingResume + closingLogistics in bodyParagraphs,
  // so word count is naturally higher than the old 50-120 prose limit.
  // New range: 80-300 words (matching CONFIG.EMAIL_FORMAT.bodyWordCountMax = 220 + closing sections).
  var wordCount = bodyText.split(/\s+/).filter(function(w) { return w.length > 0; }).length;
  if (wordCount < 40) {
    issues.push('Email too short: ' + wordCount + ' words — aim for 80+');
  }
  if (wordCount > 300) {
    issues.push('Email too long: ' + wordCount + ' words — trim to under 300');
  }

  // Check for ALL CAPS words in subject
  var capsWords = parsed.subjectLine.match(/\b[A-Z]{4,}\b/g) || [];
  if (capsWords.length > 0) {
    issues.push('Subject has ALL CAPS words: ' + capsWords.join(', '));
  }

  // ── Duplicate-content guard (final safety — parser already dedup'd, this catches edge cases) ──
  var dupParas = parsed.bodyParagraphs || [];
  for (var dp = 0; dp < dupParas.length; dp++) {
    if (parsed.cta && _textSimilarity(dupParas[dp], parsed.cta) >= 0.80) {
      issues.push('FATAL: Body paragraph #' + (dp + 1) + ' duplicates the CTA — CTA must appear ONLY in the cta field');
    }
    for (var dq = dp + 1; dq < dupParas.length; dq++) {
      if (_textSimilarity(dupParas[dp], dupParas[dq]) >= 0.80) {
        issues.push('FATAL: Body paragraphs #' + (dp + 1) + ' and #' + (dq + 1) + ' are near-duplicates');
      }
    }
  }
  if (parsed.dedupNotes && parsed.dedupNotes.length > 0) {
    issues.push('Info: Dedup applied — ' + parsed.dedupNotes.join('; '));
  }

  // Check that P.S. line exists + passes professionalism/body-coupling guardrails
  if (!parsed.psLine || parsed.psLine.length === 0) {
    issues.push('Warning: P.S. line missing — recommended as second hook');
  } else {
    var psIssues = _validatePsLine(parsed.psLine, parsed, lead);
    for (var pi = 0; pi < psIssues.length; pi++) {
      issues.push(psIssues[pi]);
    }
  }

  // ── FACT-CHECK: Catch hallucinated alumni/shared background claims ──
  // Claude often fabricates "fellow alum" connections (e.g., confusing "Great Learning" with "Great Lakes").
  // Cross-check ALL text against GAURAV_FACTS.notAlumniOf and alumniKeywords.
  if (typeof GAURAV_FACTS !== 'undefined') {
    var allText = bodyLower + ' ' + (parsed.psLine || '').toLowerCase();

    // Check for false alumni claims
    var alumniPhrases = ['fellow alum', 'fellow alumni', 'same alma mater', 'we both studied',
      'we both attended', 'shared alma', 'fellow grad', 'fellow graduate', 'alum here',
      'alumni here', 'same college', 'same university', 'same school', 'same institute',
      'both from', 'both went to', 'co-alum'];

    var claimsAlumni = alumniPhrases.some(function(phrase) {
      return allText.indexOf(phrase) >= 0;
    });

    if (claimsAlumni) {
      // Verify the email doesn't claim alumni status with a wrong institution
      var mentionsRealAlma = GAURAV_FACTS.alumniKeywords.some(function(kw) {
        return allText.indexOf(kw) >= 0;
      });

      var mentionsFakeAlma = GAURAV_FACTS.notAlumniOf.some(function(fake) {
        return allText.indexOf(fake) >= 0;
      });

      if (mentionsFakeAlma) {
        issues.push('FATAL: Hallucinated alumni claim — Gaurav is NOT an alum of the institution mentioned. Only IIM Kozhikode and Thapar University.');
      }
      if (!mentionsRealAlma && !mentionsFakeAlma) {
        // Claims alumni but doesn't name a specific institution — risky, flag as warning
        issues.push('FATAL: Unverifiable alumni claim — if claiming shared background, must reference IIM Kozhikode or Thapar University specifically');
      }
    }

    // Also catch lead's org name being confused with an institution
    // e.g., "Great Learning" (org) ≠ "Great Lakes" (business school)
    var notAlumniMatches = GAURAV_FACTS.notAlumniOf.filter(function(fake) {
      return allText.indexOf(fake) >= 0;
    });
    notAlumniMatches.forEach(function(match) {
      if (allText.indexOf('alum') >= 0 || allText.indexOf('fellow') >= 0) {
        issues.push('FATAL: False claim — mentions "' + match + '" with alumni language. Gaurav did NOT attend ' + match);
      }
    });
  }

  // ── EM-DASH & SPECIAL CHARACTER CHECK ──
  var fullText = (parsed.bodyParagraphs || []).join(' ') + ' ' + (parsed.cta || '') + ' ' + (parsed.psLine || '') + ' ' + parsed.subjectLine;
  if (/[\u2014\u2015\u2013]/.test(fullText)) {
    issues.push('FATAL: Em-dash or en-dash detected — strict rule: use " - " or hyphen instead');
  }
  if (/[\u201C\u201D\u201E\u201F\u2018\u2019\u201A\u201B]/.test(fullText)) {
    issues.push('FATAL: Curly/smart quotes detected — must use straight quotes only');
  }

  // ── CANONICAL TEMPLATE STRUCTURE CHECKS (11 structural rules) ──
  // Only runs on BULLET_V1 format (experienceBullets present).
  var isV1 = Array.isArray(parsed.experienceBullets) && parsed.experienceBullets.length > 0;

  // PATCH 2026-05-12: Derive whether this is the STANDARD BULLET_V1 template or
  // an archetype-specific one (HR_PARTNERSHIP / CXO_SHORT). Proxy: only the STANDARD
  // template has "Gurgaon" in closingLogistics. HR and CXO use different CTAs.
  // CXO_SHORT has 0 bullets (isV1=false) so it never enters this block anyway.
  var isStandardTemplate = isV1 && (parsed.closingLogistics || '').toLowerCase().indexOf('gurgaon') >= 0;

  if (isStandardTemplate) {
    // Rule 1: Greeting is "Hi <FirstName>,"
    var greetingRawT = (parsed.greeting || '').trim();
    if (!/^Hi\s+[A-Za-z]/i.test(greetingRawT)) {
      issues.push('TEMPLATE: Greeting must be "Hi <FirstName>," -- got: ' + greetingRawT);
    }

    // Rule 2: Hook paragraph ends with "operating reality"
    var hookParaT = (parsed.hookParagraph || '').trim().toLowerCase();
    if (hookParaT && hookParaT.indexOf('operating reality') < 0) {
      issues.push('TEMPLATE: hookParagraph must end "...has been my operating reality across N+ years in <industries>"');
    }

    // Rule 3: Bridge sentence contains "Three 0-to-1 builds"
    var bridgeSentT = (parsed.bridgeSentence || '').trim().toLowerCase();
    if (bridgeSentT && bridgeSentT.indexOf('0-to-1') < 0) {
      issues.push('TEMPLATE: bridgeSentence must contain "Three 0-to-1 builds" -- got: ' + (parsed.bridgeSentence || ''));
    }

    // Rule 4: Exactly 3 experience bullets
    var bulletCountT = parsed.experienceBullets.length;
    if (bulletCountT !== 3) {
      issues.push('TEMPLATE: Exactly 3 experience bullets required -- got ' + bulletCountT);
    }

    // Rule 4b: Bullet labels contain the 3 canonical companies
    var bulletLabelsT = parsed.experienceBullets.map(function(b) { return (b.label || '').toLowerCase(); });
    ['blinkit', 'upgrad', 'great learning'].forEach(function(co) {
      var foundT = bulletLabelsT.some(function(lbl) { return lbl.indexOf(co) >= 0; });
      if (!foundT) {
        issues.push('TEMPLATE: Experience bullet missing for company "' + co + '"');
      }
    });

    // Rule 5: Synthesis line "The thread across all three"
    var motivParaT = (parsed.motivationParagraph || '').trim().toLowerCase();
    if (!motivParaT || motivParaT.indexOf('thread across all three') < 0) {
      issues.push('TEMPLATE: motivationParagraph must contain "The thread across all three: <pattern>"');
    }

    // Rule 6: Builder section header in currentRoleParagraph
    var currentRoleParaT = (parsed.currentRoleParagraph || '').trim().toLowerCase();
    if (currentRoleParaT && currentRoleParaT.indexOf('builder side') < 0) {
      issues.push('TEMPLATE: currentRoleParagraph must be "On the builder side, three AI tools shipped independently (all live):"');
    }

    // Rule 7+8: showAiToolsBlock should be true. PATCH 2026-05-12: downgraded
    // from FATAL to INFO because the injection layer (line ~1043) now forces
    // showAiToolsBlock=true on STANDARD path (>=2 bullets), and the renderer
    // also has a defensive force-override. Keeping this as FATAL would trigger
    // an unnecessary recompose loop when Claude returned false but the injector
    // already corrected it.
    if (parsed.showAiToolsBlock === false) {
      issues.push('INFO: showAiToolsBlock was false — injection layer forced to true');
    }

    // Rule 9: Closing ask has Gurgaon + 15 minutes + "building at"
    var closingLogT = (parsed.closingLogistics || '').trim().toLowerCase();
    if (closingLogT) {
      if (closingLogT.indexOf('gurgaon') < 0) {
        issues.push('TEMPLATE: closingLogistics must mention "Gurgaon"');
      }
      if (closingLogT.indexOf('15 minute') < 0 && closingLogT.indexOf('15-min') < 0 && closingLogT.indexOf('15 min') < 0) {
        issues.push('TEMPLATE: closingLogistics must contain "15 minutes" ask');
      }
      if (closingLogT.indexOf('building at') < 0) {
        issues.push('TEMPLATE: closingLogistics must end "...what your team is building at <Company>"');
      }
    } else {
      issues.push('TEMPLATE: closingLogistics is required (Gurgaon + 15 min + building at <Company>)');
    }

    // Rule 10: Resume note presence — hybrid polite + humble phrasing (2026-05-12).
    // Accept either "Please find my resume attached" (canonical) or just
    // "resume attached" (transitional shape) — checks at least one match.
    var closingResT = (parsed.closingResume || '').trim().toLowerCase();
    var hasPolite = closingResT.indexOf('please find my resume attached') >= 0;
    var hasShort  = closingResT.indexOf('resume attached') >= 0;
    if (!closingResT || (!hasPolite && !hasShort)) {
      issues.push('TEMPLATE: closingResume must start "Please find my resume attached below for further details. Would welcome the chance to discuss how this background aligns with what your team is building."');
    }

    // Rule 11: Signoff warning if not canonical
    var signoffT = (parsed.signoffText || '').trim().toLowerCase();
    if (signoffT && signoffT !== 'thanks and regards') {
      issues.push('TEMPLATE warn: signoffText should be "Thanks and regards" -- got: ' + (parsed.signoffText || ''));
    }
  }

  // ── INJECTED FIELDS SIGNAL (non-blocking, informational) ──
  // PATCH 2026-05-12: Surface canonical fields that were injected at parse time
  // because Claude omitted them. Non-fatal — parse layer already corrected the object.
  if (Array.isArray(parsed._injectedFields) && parsed._injectedFields.length > 0) {
    issues.push('INFO: Canonical fields injected (Claude omitted): ' + parsed._injectedFields.join(', '));
  }

  // PATCH 2026-06-11-eq8-c4strong (T2b): Ship-gate FATAL — bullet-shaped email
  // with insufficient bullets. Fires for non-CXO shapes only.
  // PATCH 2026-06-12-strategy-tilt: CXO is now identified by templateId='CXO_SHORT'
  // (primary) OR zero-bullets+motivationParagraph (legacy). CXO with bullets is valid.
  // _normalizeParsedFields has already run by the time _quickValidate is called.
  var _isCxoShape = (parsed.templateId === 'CXO_SHORT')
                  || !!(parsed.motivationParagraph && String(parsed.motivationParagraph).trim()
                        && Array.isArray(parsed.experienceBullets) && parsed.experienceBullets.length === 0);
  if (!_isCxoShape && (!parsed.experienceBullets || parsed.experienceBullets.length < 2)) {
    issues.push('FATAL: bullet-shape email with <2 experienceBullets — routing to Tier 3');
  }

  return { issues: issues };
}

// ─── P.S. LINE VALIDATION ────────────────────────────────────

/**
 * Validates the P.S. line against professionalism + body-coupling rules.
 * Returns an array of issue strings (empty if clean).
 *
 * Rules enforced:
 *  (1) Length: 8-40 words (hard cap — too short = throwaway, too long = rambling).
 *  (2) Single sentence ideally (max 2 short sentences).
 *  (3) Banned patterns: personal small-talk, sycophancy, generic pleasantries, emojis, sales-closers.
 *  (4) Body coupling: MUST reference the company name OR a topic keyword from the body/CTA/subject.
 *  (5) No direct job-asking language (keeps parity with body rules).
 *
 * @param {string} psLine - P.S. text (without "P.S." prefix)
 * @param {Object} parsed - Full parsed composition {subjectLine, bodyParagraphs, cta, psLine}
 * @param {Object} lead - LeadProfile (for company/name context)
 * @returns {string[]} Array of issue strings
 */
function _validatePsLine(psLine, parsed, lead) {
  var issues = [];
  if (!psLine) return issues;
  var ps = psLine.toString().trim();
  var psLower = ps.toLowerCase();

  // (1) Length check
  var wc = ps.split(/\s+/).filter(function(w) { return w.length > 0; }).length;
  if (wc < 8) {
    issues.push('P.S. too short: ' + wc + ' words — aim for 12-28 to add real signal');
  }
  if (wc > 40) {
    issues.push('P.S. too long: ' + wc + ' words — trim to 12-28, one sentence');
  }

  // (2) Sentence count — roughly by terminal punctuation
  var sentenceCount = (ps.match(/[.!?]+\s+[A-Z]/g) || []).length + 1;
  if (sentenceCount > 2) {
    issues.push('P.S. has ' + sentenceCount + ' sentences — keep to 1, max 2 short');
  }

  // (3) Banned patterns — personal small-talk, sycophancy, fluff
  var bannedPatterns = [
    { re: /\bhope (you|your) (had|have|are)\b/i, label: 'personal greeting ("hope you had...")', fatal: true },
    { re: /\bgreat (weekend|evening|morning|day|week)\b/i, label: 'weekend/day pleasantry', fatal: true },
    { re: /\benjoy (your|the) (weekend|evening|day|holiday)/i, label: 'personal enjoyment wish', fatal: true },
    { re: /\bhuge fan\b/i, label: 'sycophancy ("huge fan")', fatal: true },
    { re: /\blove your work\b/i, label: 'sycophancy ("love your work")', fatal: true },
    { re: /\bbig (admirer|fan)\b/i, label: 'sycophancy ("big fan/admirer")', fatal: true },
    { re: /\blooking forward to (hearing|connecting|your response|chatting)\b/i, label: 'generic sales closer', fatal: false },
    { re: /\bhave a (great|good|nice) (day|one|week)\b/i, label: 'generic pleasantry', fatal: true },
    { re: /\bjust (wanted|following up|checking)\b/i, label: 'weak opener ("just wanted/following up")', fatal: false },
    { re: /\b(hobby|hobbies|hiking|running|cycling|cooking|traveling|travel plans|pets?|dogs?|kids|children|vacation)\b/i, label: 'personal-life reference', fatal: true },
    { re: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, label: 'emoji (banned in professional outreach)', fatal: true },
    { re: /\bopen (to|for) (a|an) (offer|opportunity|role)\b/i, label: 'direct job-asking language', fatal: true },
    { re: /\bplease consider (me|my)\b/i, label: 'begging tone', fatal: true },
    { re: /\bwould love (to|a) (chat|call|opportunity|chance)\b/i, label: 'generic closer ("would love to chat")', fatal: false }
  ];
  for (var b = 0; b < bannedPatterns.length; b++) {
    if (bannedPatterns[b].re.test(ps)) {
      var prefix = bannedPatterns[b].fatal ? 'FATAL: ' : '';
      issues.push(prefix + 'P.S. banned pattern — ' + bannedPatterns[b].label + '. Rewrite with a concrete company/industry observation.');
    }
  }

  // (4) Body coupling — must reference company OR a content-keyword from body/CTA/subject
  var org = (lead && lead.organization) ? lead.organization.toString().toLowerCase() : '';
  var orgTokens = org.split(/\s+/).filter(function(t) { return t.length >= 4; });
  var mentionsCompany = false;
  for (var o = 0; o < orgTokens.length; o++) {
    if (psLower.indexOf(orgTokens[o]) >= 0) { mentionsCompany = true; break; }
  }

  if (!mentionsCompany) {
    // Fallback: find a meaningful keyword shared with body/cta/subject
    var bodyBlob = ((parsed.bodyParagraphs || []).join(' ') + ' ' + (parsed.cta || '') + ' ' + (parsed.subjectLine || '')).toLowerCase();
    var stopwords = {the:1,and:1,for:1,with:1,that:1,this:1,your:1,from:1,have:1,been:1,they:1,their:1,what:1,when:1,would:1,could:1,about:1,which:1,into:1,just:1,also:1,than:1,then:1,like:1,very:1,most:1,some:1,more:1,over:1,such:1,will:1,onto:1,upon:1,here:1,there:1,these:1,those:1};
    var psTokens = psLower.replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(function(t) { return t.length >= 5 && !stopwords[t]; });
    var bodyHasKeywordOverlap = false;
    for (var k = 0; k < psTokens.length; k++) {
      if (bodyBlob.indexOf(psTokens[k]) >= 0) { bodyHasKeywordOverlap = true; break; }
    }
    if (!bodyHasKeywordOverlap) {
      issues.push('P.S. disconnected from body — does not reference ' + (lead.organization || 'the company') + ' or any body topic. Rewrite to reinforce the same thread.');
    }
  }

  // (5) Flag if P.S. literally repeats a phrase verbatim from the opening hook
  var firstParagraph = ((parsed.bodyParagraphs || [])[0] || '').toLowerCase();
  if (firstParagraph.length > 20) {
    // check for 6-word overlap
    var firstWords = firstParagraph.replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(function(w) { return w.length > 2; });
    for (var f = 0; f < firstWords.length - 5; f++) {
      var chunk = firstWords.slice(f, f + 6).join(' ');
      if (chunk.length > 15 && psLower.indexOf(chunk) >= 0) {
        issues.push('P.S. repeats opening hook phrase verbatim — use a different angle');
        break;
      }
    }
  }

  return issues;
}

// ─── EMAIL STRUCTURE VERIFICATION ────────────────────────────

/**
 * Verifies the final HTML email has all required structural components
 * for a professional cold email job application.
 *
 * Checks:
 * 1. Banner image present (cid:emailBanner)
 * 2. Greeting exists and addresses recipient by first name
 * 3. Body has 2-3 substantive paragraphs (not empty/trivial)
 * 4. CTA is present and uses bold emphasis
 * 5. Signature block with name, tagline, and LinkedIn
 * 6. P.S. line present as second hook
 * 7. No broken HTML (unclosed tags, malformed attributes)
 * 8. Proper spacing between sections (no collapsed margins)
 *
 * @param {string} html - Final HTML email body
 * @param {Object} parsed - Original parsed response for cross-check
 * @returns {Object} {passed: boolean, issues: string[]}
 */
function _verifyEmailStructure(html, parsed) {
  var issues = [];

  // PATCH 2026-05-19: CXO_SHORT (Leadership Master Template) deliberately ships
  // WITHOUT a banner image — per Founder-Grade Playbook, banners read junior
  // to Director+ recipients. Detect CXO shape so we skip the banner check.
  // PATCH 2026-06-12-strategy-tilt: templateId === 'CXO_SHORT' is the primary discriminator.
  var _structBullets = Array.isArray(parsed.experienceBullets) ? parsed.experienceBullets.length : 0;
  var _isCxoStruct = (parsed.templateId === 'CXO_SHORT')
                   || ((_structBullets === 0)
                       && !!(parsed.motivationParagraph && parsed.motivationParagraph.toString().trim()));

  // 1. Banner (STANDARD/HR only — CXO_SHORT deliberately omits banner)
  // PATCH 2026-06-11-eq8-deliv-v2 (T2): FLAG ON emits a CSS table header
  // (no cid:emailBanner); accept either form so the validator stays green.
  if (!_isCxoStruct) {
    var _hasCidBanner = html.indexOf('cid:emailBanner') >= 0;
    var _hasCssBanner = html.indexOf('STRATEGY') >= 0 && html.indexOf('MARKETING') >= 0;
    if (!_hasCidBanner && !_hasCssBanner) {
      issues.push('STRUCT: Banner missing — check _delivBannerHtml / _buildHtmlEmail');
    }
  }

  // 2. Greeting
  if (html.indexOf('Hi ') < 0 && html.indexOf('Hello ') < 0 && html.indexOf('Hey ') < 0) {
    issues.push('STRUCT: No greeting detected — email should open with personal address');
  }

  // 3. Body paragraph count (count <p> tags in body, excluding greeting/PS/signature)
  var pTags = html.match(/<p\s[^>]*>/gi) || [];
  // Subtract 1 for greeting, 1 for PS if present
  var bodyParagraphCount = pTags.length - 1 - (parsed.psLine ? 1 : 0);
  if (bodyParagraphCount < 2) {
    issues.push('STRUCT: Only ' + bodyParagraphCount + ' body paragraph(s) — need 2-3 for substance');
  }

  // 4. CTA with bold
  if (html.indexOf('<strong>') < 0) {
    issues.push('STRUCT: No bold CTA found — CTA should be emphasized');
  }

  // 5. Signature block
  if (html.indexOf('Gaurav Rathore') < 0) {
    issues.push('STRUCT: Signature name missing');
  }
  if (html.indexOf('LinkedIn') < 0 && html.indexOf('linkedin') < 0) {
    issues.push('STRUCT: LinkedIn link missing from signature');
  }
  if (html.indexOf('IIM Kozhikode') < 0 && html.indexOf('IIM K') < 0) {
    issues.push('STRUCT: MBA credential missing from signature');
  }

  // 6. P.S. line
  if (html.indexOf('P.S.') < 0) {
    issues.push('STRUCT: P.S. line missing — required as second hook per playbook');
  }

  // 7. Basic HTML integrity — check open/close tag balance for key elements
  var openDivs = (html.match(/<div[\s>]/gi) || []).length;
  var closeDivs = (html.match(/<\/div>/gi) || []).length;
  if (openDivs !== closeDivs) {
    issues.push('STRUCT: Mismatched <div> tags (' + openDivs + ' open, ' + closeDivs + ' close)');
  }

  var openTables = (html.match(/<table[\s>]/gi) || []).length;
  var closeTables = (html.match(/<\/table>/gi) || []).length;
  if (openTables !== closeTables) {
    issues.push('STRUCT: Mismatched <table> tags (' + openTables + ' open, ' + closeTables + ' close)');
  }

  // 8. Section spacing — signature should have margin-top
  if (html.indexOf('margin-top:24px') < 0 && html.indexOf('margin-top:20px') < 0) {
    issues.push('STRUCT: Signature may lack proper top spacing');
  }

  // 9. Word count check on visible text (strip HTML)
  var visibleText = html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  var wordCount = visibleText.split(/\s+/).filter(function(w) { return w.length > 0; }).length;
  if (wordCount < 40) {
    issues.push('STRUCT: Visible text too sparse (' + wordCount + ' words) — email may look empty');
  }
  if (wordCount > 420) {
    // PATCH 2026-05-15 (Abhishek RCA): raised 350 → 420. The canonical
    // BULLET_V1 template (hook + bridge + 3 experience bullets with metrics
    // + AI tools header + 3 AI bullets with descriptions + GitHub line +
    // closing logistics + calendly anchor + resume mention + signature +
    // P.S.) naturally lands at 330-400 words on rich-context leads (Amazon,
    // Microsoft, etc. where Gaurav has deep cross-functional bullets).
    // Abhishek hit 374 → was flagged at the old 350 cap; the actual content
    // was correct. 420 keeps the guard active for runaway compositions
    // (>10% over typical) without blocking legitimate dense leads.
    issues.push('STRUCT: Visible text too dense (' + wordCount + ' words) — trim for cold email brevity');
  }

  // 10. Canonical template checks on the rendered HTML
  // GitHub URL presence
  if (html.indexOf('github.com/GauravRIIMK') < 0) {
    issues.push('STRUCT: GitHub URL "github.com/GauravRIIMK" missing from email');
  }
  // 3 AI tool URLs
  var expectedToolUrls = [
    'automail-pipeline',
    'linkedin-jobs-scraper-public',
    'scaler-sales-agent'
  ];
  expectedToolUrls.forEach(function(slug) {
    if (html.indexOf(slug) < 0) {
      issues.push('STRUCT: AI tool URL missing — expected slug "' + slug + '" in href');
    }
  });
  // PATCH 2026-05-13 (D4): calendly anchor must appear in STANDARD drafts.
  // Check is INFO-level (push as warning, not FATAL) so legacy emails without
  // calendly don't fail-block — but new emails get caught by the validator.
  if (html.indexOf('calendly.com/speak-to-gaurav') < 0) {
    issues.push('STRUCT: Calendly link "calendly.com/speak-to-gaurav/30min" missing from closing');
  }
  // LinkedIn profile URL (canonical)
  // PATCH 2026-06-12-e2e-hardening: updated from stale gaurav-rathore-iimk (404)
  // to live handle gaurav1-grow-learn-together. Config.gs was corrected at
  // -hr-cxo-template-polish (2026-06-09) but the verifier was not updated,
  // causing every rendered email to produce a permanent false-positive STRUCT
  // warning that buried real structural failures in structureCheck.issues.
  if (html.indexOf('gaurav1-grow-learn-together') < 0) {
    issues.push('STRUCT: Signature LinkedIn URL should be "gaurav1-grow-learn-together"');
  }

  return {
    passed: issues.length === 0,
    issues: issues
  };
}

// ─── HOOK ROTATION (anti-bias across consecutive emails) ─────────────
//
// The 1-2 hook bias the user reported comes from Claude converging on the
// highest-density tier in each dossier (usually Tier 2 trigger events or
// Tier 4 metric hooks). We track which tier was used for the last N emails
// in Script Properties and inject "AVOID these tiers" pressure into the
// system prompt. Cap = CONFIG.HOOK_ROTATION.queueDepth (default 5).

/**
 * Reads the rolling list of hook tiers from Script Properties.
 * @returns {number[]} Most recent first; empty array if no history yet.
 */
function _getRecentHookTiers() {
  try {
    var keyName = (CONFIG.PROPERTY_KEYS && CONFIG.PROPERTY_KEYS.HOOK_ROTATION_QUEUE) || 'HOOK_ROTATION_QUEUE';
    var raw = PropertiesService.getScriptProperties().getProperty(keyName);
    if (!raw) return [];
    var arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    Logger.log('[EmailComposer] _getRecentHookTiers parse failed: ' + e.message);
    return [];
  }
}

/**
 * Pushes the most-recent tier onto the queue (FIFO, cap N).
 * @param {number} tier 1..6
 */
function _recordHookTier(tier) {
  if (typeof tier !== 'number' || tier < 1 || tier > 6) return;
  try {
    var keyName = (CONFIG.PROPERTY_KEYS && CONFIG.PROPERTY_KEYS.HOOK_ROTATION_QUEUE) || 'HOOK_ROTATION_QUEUE';
    var depth = (CONFIG.HOOK_ROTATION && CONFIG.HOOK_ROTATION.queueDepth) || 5;
    var current = _getRecentHookTiers();
    current.unshift(tier);                  // newest at index 0
    while (current.length > depth) current.pop();
    PropertiesService.getScriptProperties().setProperty(keyName, JSON.stringify(current));
  } catch (e) {
    Logger.log('[EmailComposer] _recordHookTier failed: ' + e.message);
  }
}

/**
 * Builds the "AVOID these tiers" string injected into the system prompt.
 * Returns empty string if rotation is disabled or queue is empty.
 *
 * Logic:
 *   - If avoidConsecutiveTier and queue has at least 1 entry: forbid tier[0]
 *   - If maxSameTierIn5 reached for any tier in the queue: forbid that tier too
 * @returns {string}
 */
/**
 * PATCH 2026-05-16 (Option 5 / Sub-option 4):
 * Outreach-framing directive — prepended to every system prompt. Flips the
 * default cold-email frame from "applying to a specific role" (the broken
 * Tier 1+Tier 3 default that hallucinated roles) to "informational outreach
 * about the function area at the recipient's company." Conditionally
 * re-enables applying framing when the lead's TARGET_ROLE field is set
 * (Sub-option 2 — Sheet2 col AA).
 *
 * Why prepend (not append):
 *   Sonnet 4.5 respects top-of-prompt instructions more reliably than
 *   mid/bottom overrides. The existing 3 system prompts (STANDARD / HR /
 *   CXO) have detailed instructions about "the role" — without this
 *   preamble at the top, Claude tends to invent a role even with no JD.
 *   With the preamble at top, Claude defaults to informational and only
 *   shifts to applying when target_role is in user prompt context.
 *
 * @param {Object} context - From _buildCompositionContext; reads
 *                          context.targetRole, context.hasTargetRole,
 *                          context.organization
 * @returns {string} Preamble text ending with two newlines
 */
function _buildOutreachFramingDirective(context) {
  var orgName = (context && context.organization) || 'the recipient\'s company';
  var hasTarget = !!(context && context.hasTargetRole);
  var targetRole = (context && context.targetRole) ? context.targetRole.toString().trim() : '';

  if (hasTarget) {
    // APPLYING framing — Gaurav HAS identified a specific role/JD for this lead
    return '## OUTREACH FRAMING (READ FIRST — OVERRIDES EVERYTHING BELOW)\n' +
           'This email IS an application for a specific role at ' + orgName + '.\n' +
           'The target role is: ' + targetRole + '\n' +
           '\n' +
           'Frame the email as:\n' +
           '  - A direct application to "' + targetRole + '" at ' + orgName + '.\n' +
           '  - The hook references this specific role AND a recent company signal.\n' +
           '  - The closing CTA is a 15-minute conversation to discuss this role specifically.\n' +
           '  - The recipient is positioned as a hiring manager / decision-maker / referrer for this role.\n' +
           '\n' +
           'CRITICAL: do NOT replace "' + targetRole + '" with the recipient\'s own current title.\n' +
           'The recipient\'s designation in the context is biographical (who they are, what their function is) —\n' +
           'NOT the role being applied to. Only the target_role above is the role being applied to.\n' +
           '\n';
  }

  // INFORMATIONAL framing — default for 184+ existing leads with no JD attached
  return '## OUTREACH FRAMING (READ FIRST — OVERRIDES EVERYTHING BELOW)\n' +
         'This email is an INFORMATIONAL outreach. The recipient has NOT posted a role for Gaurav to apply to.\n' +
         'Do NOT frame this as an application to any specific role.\n' +
         '\n' +
         'Specifically:\n' +
         '  - CRITICAL: NEVER write "The [recipient title] role at [company] caught my attention." The recipient\'s\n' +
         '    job title is biographical context describing who they are. It is NOT a job posting Gaurav is applying to.\n' +
         '    There is no posted role here. Inventing one is a hallucination that damages credibility immediately.\n' +
         '  - The hook paragraph references the COMPANY\'s recent situation (news / launch / funding / leadership move\n' +
         '    / market move from the dossier hooks) + how Gaurav\'s work maps to that situation. Do NOT name any\n' +
         '    specific role. Phrasing like "your team\'s work on X" / "how ' + orgName + ' is approaching Y" is good;\n' +
         '    phrasing like "the X role at ' + orgName + '" is forbidden.\n' +
         '  - The closing CTA (closingLogistics field) is INFORMATIONAL — leaves the door open for either an\n' +
         '    information-gathering chat OR a role discussion, depending on what\'s useful to the recipient.\n' +
         '    Canonical phrasing:\n' +
         '      "Based in Gurgaon and available immediately. Open to 15 minutes — could be an informational chat\n' +
         '      about the space, or about specific roles your team is hiring for, depending on what\'s most useful."\n' +
         '  - Tone: peer-curious, not applicant-hopeful. Gaurav has 4.5+ years operating reality; he\'s exploring\n' +
         '    fit, not begging for a role. Confidence without aggression.\n' +
         '\n' +
         'The 14-section canonical skeleton from the rest of this prompt still applies (banner, greeting, hook,\n' +
         'bridge, 3 bullets, AI tools block, GitHub line, closing, resume mention, signature, P.S.). Only the\n' +
         'FRAMING of those sections shifts — informational instead of applying.\n' +
         '\n';
}

function _buildHookRotationDirective() {
  var rot = CONFIG.HOOK_ROTATION || { queueDepth: 5, avoidConsecutiveTier: true, maxSameTierIn5: 3 };
  var recent = _getRecentHookTiers();
  if (recent.length === 0) return '';

  var avoid = {};
  if (rot.avoidConsecutiveTier && recent[0]) avoid[recent[0]] = true;

  // Count occurrences in queue
  var counts = {};
  recent.forEach(function(t) { counts[t] = (counts[t] || 0) + 1; });
  for (var t in counts) {
    if (counts[t] >= (rot.maxSameTierIn5 || 3)) avoid[t] = true;
  }

  var avoidList = Object.keys(avoid).map(Number).sort();
  if (avoidList.length === 0) return '';

  return '\n## HOOK ROTATION DIRECTIVE (anti-bias)\n' +
         'Recent hook tiers used (newest first): [' + recent.join(', ') + ']\n' +
         'You MUST pick a hook tier OTHER than: ' + avoidList.join(', ') + '\n' +
         'If the only signal-rich tier is on the avoid list, prefer a SHORTER email built on the next-best tier rather than reusing the avoided one.\n';
}

// ─── BULLET-LIST EMAIL BUILDER (2026 reference format) ───────────────
//
// Mirrors the structure of Gaurav's two reference emails (Kapture / MAS):
//   Banner → Greeting → Hook → Bridge → Experience bullets → AI tools
//   → (Optional) Current role → (Optional) Motivation → CTA
//   → Resume mention → Signature → P.S.
//
// Activated when CONFIG.EMAIL_FORMAT.version === 'BULLET_V1'.
//
// Expected parsed fields:
//   greeting, hookParagraph, bridgeSentence, experienceBullets[],
//   showAiToolsBlock, currentRoleParagraph, motivationParagraph,
//   cta, psLine, selectedHookTier
//
// Each experience bullet is {label, body, showLorTag (bool)}.

/**
 * Builds the reference-style HTML email with bullet list of credentials.
 * @param {Object} parsed - {greeting, hookParagraph, bridgeSentence, experienceBullets, showAiToolsBlock, currentRoleParagraph, motivationParagraph, cta, psLine}
 * @param {Object} lead - LeadProfile
 * @param {Object} resumeSelection - {variantId}
 * @returns {string} Complete HTML email string
 */
function _buildHtmlEmailBulletV1(parsed, lead, resumeSelection) {
  var s = EMAIL_STYLE;
  _dedupParsedComposition(parsed); // safety net

  var facts = (typeof GAURAV_FACTS !== 'undefined') ? GAURAV_FACTS : {};
  var refBlocks = (typeof REFERENCE_BLOCKS !== 'undefined') ? REFERENCE_BLOCKS : null;
  var linkedinUrl = facts.linkedin || 'https://www.linkedin.com/in/gaurav1-grow-learn-together/';
  var credentialLine = facts.signatureLine1 || 'MBA, IIM Kozhikode | B.E., Thapar University';

  // Hardened greeting: validates Claude's output AND falls back through name → org → generic.
  // Defends against (a) Claude passing through bad fullName ("Hi 9876543210,"),
  // (b) empty greeting from Claude, (c) blank firstName ("Hi ,").
  var greeting = _sanitizeText(_resolveGreeting(parsed.greeting, lead));
  var hookPara = _sanitizeText(parsed.hookParagraph || '');
  var bridge   = _sanitizeText(parsed.bridgeSentence || '');
  var motiv    = _sanitizeText(parsed.motivationParagraph || '');
  var currentRole = _sanitizeText(parsed.currentRoleParagraph || '');
  // Note: BULLET_V1 no longer uses a separate bold CTA paragraph. The 15-min
  // ask is woven into closingLogistics (rendered as plain text) — matches both
  // reference emails (Kapture, MAS).
  var bullets  = Array.isArray(parsed.experienceBullets) ? parsed.experienceBullets : [];

  // PATCH 2026-05-19 (Leadership Master Template): detect CXO_SHORT shape
  // EARLY so banner suppression + render-order swap + signature override
  // can all use the same flag. Shape detector mirrors _injectCanonicalFields.
  // PATCH 2026-06-12-strategy-tilt: templateId === 'CXO_SHORT' is the PRIMARY
  // discriminator; zero-bullets heuristic retained as legacy fallback.
  var isCxoShortRender = (parsed.templateId === 'CXO_SHORT')
                       || ((bullets.length === 0)
                           && !!(parsed.motivationParagraph && parsed.motivationParagraph.toString().trim()));

  // CXO-specific signature line per Founder-Grade Playbook audit.
  // Format: provenance + degree (one row inside the existing 3-row signature
  // table). The 3-row layout stays the same; only the middle row swaps.
  if (isCxoShortRender) {
    credentialLine = 'ex-Great Learning | ex-upGrad | Blinkit Bistro | MBA, IIM Kozhikode';
  }

  var pStyle = 'margin:0 0 12px 0;font-family:' + s.fontFamily + ';font-size:' + s.fontSize +
               ';line-height:' + s.lineHeight + ';color:' + s.color + ';';
  var liStyle = 'margin:0 0 8px 0;font-family:' + s.fontFamily + ';font-size:' + s.fontSize +
                ';line-height:' + s.lineHeight + ';color:' + s.color + ';';

  // Banner — CXO_SHORT: always suppressed (Founder-Grade Playbook: reads junior to Director+).
  // STANDARD/HR: dispatched via _delivBannerHtml().
  // PATCH 2026-06-11-eq8-deliv-v2 (T2): FLAG ON yields CSS table header (no CID img).
  // FLAG OFF: legacy cid:emailBanner img. CXO suppression takes precedence over flag.
  var bannerHtml = isCxoShortRender ? '' : _delivBannerHtml();

  // Greeting + hook (both templates render these in the same position)
  var html = bannerHtml +
    '<p style="' + pStyle + '">' + greeting + '</p>\n' +
    (hookPara ? '<p style="' + pStyle + '">' + hookPara + '</p>\n' : '');

  // PATCH 2026-05-19: Render-order swap for CXO_SHORT.
  // PATCH 2026-06-12-strategy-tilt: new CXO render order:
  //   CXO:      hook -> bullets (2-3 compact, metric-led) -> motivation phrase -> bridge -> ask
  //   STANDARD: hook -> bridge -> bullets -> motivation -> AI block -> ask -> resume
  // For CXO with bullets (new contract), we skip motiv+bridge here and inject them
  // AFTER the bullets table block below (see _cxoBulletsDeferred flag).
  // For legacy CXO (0 bullets), motiv+bridge still render here as before.
  var _cxoBulletsDeferred = isCxoShortRender && bullets.length > 0;
  if (isCxoShortRender && !_cxoBulletsDeferred) {
    // Legacy CXO: 0 bullets — render motiv + bridge here as before
    if (motiv) html += '<p style="' + pStyle + '">' + motiv + '</p>\n';
    if (bridge) html += '<p style="' + pStyle + '">' + bridge + '</p>\n';
  } else if (!isCxoShortRender) {
    if (bridge) html += '<p style="' + pStyle + '">' + bridge + '</p>\n';
  }

  // ── Experience bullets — TABLE-BASED markup (PATCH 2026-05-13) ──
  //
  // Gmail Compose mode strips <ul>/<li> styling aggressively, often resulting
  // in flat indented paragraphs with NO bullet character visible. The user-
  // reported regression ("neither the pointers had bullets nor were they
  // indented properly") happens specifically in the Drafts pane.
  //
  // Solution: 2-column <table> per bullet. Column 1 holds an explicit "•"
  // character (always renders, can't be stripped). Column 2 holds the
  // <b>label</b>: body content. Tables are the only universally reliable
  // primitive across Gmail (web/iOS/Android), Outlook, Apple Mail, and Yahoo.
  //
  // Each bullet is its OWN <table> rather than one big table with N rows —
  // Gmail's "remove formatting" pass treats per-bullet tables as atomic
  // paragraphs, preserving spacing even when CSS is stripped.
  if (bullets.length > 0) {
    // PATCH `-hr-cxo-template-polish` (2026-06-09): bullet padding/margin
    // tightened to match HR Tier-3 variant. Was `padding:0 6px 0 12px` +
    // `margin:0 0 8px 0` (12px indent, 8px gap). Now `padding:0 8px 0 24px`
    // + `margin:0 0 12px 0` per bullet (24px indent, consistent with
    // standard email list semantics, 12px gap between bullets for
    // readability). Single wrapping table instead of N tables (one per
    // bullet) — tighter DOM, consistent vertical rhythm. Affects every
    // STANDARD-shape draft (Tier 1 and Tier 3 STANDARD).
    var tdBase = 'font-family:' + s.fontFamily + ';font-size:' + s.fontSize +
                 ';line-height:' + s.lineHeight + ';color:' + s.color + ';';
    html += '<table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px 0;width:100%;">\n';
    bullets.forEach(function(b) {
      var raw = _normalizeBulletLabelBody(b.label, b.body);
      var label = _convertMarkdownInline(_sanitizeText(raw.label));
      var body  = _convertMarkdownInline(_sanitizeText(raw.body));
      var tag   = b.showLorTag ? ' (' + (refBlocks ? refBlocks.lorInlineTagText.replace(/^\(|\)$/g, '') : 'LOR attached') + ')' : '';
      html += '  <tr>\n' +
              '    <td valign="top" style="' + tdBase + 'width:28px;padding:0 8px 8px 24px;">&bull;</td>\n' +
              '    <td valign="top" style="' + tdBase + 'padding:0 0 8px 0;"><b style="font-weight:bold;color:' + s.color + ';">' +
                     label + ':</b> ' + body + tag + '</td>\n' +
              '  </tr>\n';
    });
    html += '</table>\n';
  }

  // PATCH 2026-06-12-strategy-tilt: CXO with bullets — deferred motiv phrase + bridge
  // render AFTER the bullets table (correct order: hook → bullets → operator phrase → bridge).
  if (_cxoBulletsDeferred) {
    if (motiv) html += '<p style="' + pStyle + '">' + motiv + '</p>\n';
    if (bridge) html += '<p style="' + pStyle + '">' + bridge + '</p>\n';
  }

  // PATCH 2026-05-13: STANDARD/HR templates ALWAYS render the AI tools block.
  // Detection is now shape-based and matches _injectCanonicalFields:
  //   - CXO_SHORT (templateId or zero-bullets heuristic) → suppress AI tools
  //   - Anything else = STANDARD/HR_PARTNERSHIP → render AI tools block.
  // PATCH 2026-06-12-strategy-tilt: isCxoShortRender now also covers CXO with bullets.
  // Previously this gated on bullets.length >= 2, which silently dropped the
  // 3 AI projects + GitHub footer when Claude returned a sparse STANDARD
  // response (0 or 1 bullets). That was the Mayurika-draft regression.
  // PATCH 2026-05-19: isCxoShortRender already computed at the top of this
  // function (see banner-suppression block). Just enforce showAiToolsBlock here.
  if (!isCxoShortRender && parsed.showAiToolsBlock !== true) {
    parsed.showAiToolsBlock = true;
  }
  if (isCxoShortRender && parsed.showAiToolsBlock !== false) {
    parsed.showAiToolsBlock = false;
  }

  // PATCH 2026-06-12-builderblock-v2 — Canonical render order:
  //   1. Experience bullets (above)
  //   2. Motivation paragraph (synthesis line — "The thread across all three")
  //   3. AI tools block HEADER — rendered from REFERENCE_BLOCKS.aiTools.header (canonical, hyperlinked).
  //      Claude's currentRoleParagraph is NOT rendered when showAiToolsBlock=true; the canonical
  //      header replaces it entirely. When showAiToolsBlock=false (CXO), Claude's currentRoleParagraph
  //      is rendered as before (unchanged CXO behavior).
  //   4. AI tools list (3 bullets)
  //   5. GitHub footer (sentence emitted ONCE here; _normalizeParsedFields scrubs any Claude copies)
  //   (then closingLogistics, closingResume, Looking forward, signoff)

  // 2. Motivation paragraph (synthesis line)
  // PATCH 2026-05-19: CXO_SHORT renders motivationParagraph (CREDIBILITY) in
  // the upper block AFTER hook + BEFORE bridge — see render-order swap above.
  // Skip here so CXO doesn't double-render. STANDARD keeps motivation here as
  // the synthesis line ("The thread across all three: ...").
  if (motiv && !isCxoShortRender) {
    html += '<p style="' + pStyle + '">' + motiv + '</p>\n';
  }

  // 3. Block header paragraph.
  // When showAiToolsBlock=true (STANDARD/HR): always render the CANONICAL ai.header
  // from REFERENCE_BLOCKS (hyperlinked, exact wording). Claude's currentRoleParagraph
  // is silently dropped — it was an unreliable paraphrase that arrived unlinked and
  // sometimes duplicated the GitHub sentence. The canonical header IS the block intro.
  // When showAiToolsBlock=false (CXO_SHORT): render Claude's currentRoleParagraph as
  // before (CXO has no AI tools block, so the paragraph serves a different purpose).
  if (parsed.showAiToolsBlock !== false) {
    // STANDARD/HR: use canonical header — always linked, always exact wording.
    var _canonicalAiHeader = (refBlocks && refBlocks.aiTools && refBlocks.aiTools.header)
      ? refBlocks.aiTools.header
      : '';
    if (_canonicalAiHeader) {
      html += '<p style="' + pStyle + '">' + _canonicalAiHeader + '</p>\n';
    }
  } else {
    // CXO_SHORT: render Claude's currentRoleParagraph (unchanged behavior).
    if (currentRole) {
      html += '<p style="' + pStyle + '">' + currentRole + '</p>\n';
    }
  }

  // 4. AI tools list — TABLE-BASED markup (PATCH 2026-05-13).
  //    Same Gmail-compose-safe pattern as experience bullets above. Label
  //    becomes a bold hyperlink when item.url is populated.
  //    ai.header rendered above (section 3) as the canonical block header paragraph.
  if (parsed.showAiToolsBlock !== false && refBlocks && refBlocks.aiTools) {
    var ai = refBlocks.aiTools;
    var aiTdBase = 'font-family:' + s.fontFamily + ';font-size:' + s.fontSize +
                   ';line-height:' + s.lineHeight + ';color:' + s.color + ';';
    ai.items.forEach(function(it) {
      var aiLabelText = _sanitizeText(it.label);
      var aiBody      = _convertMarkdownInline(_sanitizeText(it.body));
      var aiUrl       = it.url || '';
      // Render label as bold hyperlink when URL present; plain bold otherwise
      var aiLabelHtml = aiUrl
        ? '<b style="font-weight:bold;"><a href="' + aiUrl + '" style="color:' + s.linkColor + ';text-decoration:underline;">' + aiLabelText + '</a></b>'
        : '<b style="font-weight:bold; color:' + s.color + ';">' + aiLabelText + '</b>';
      html += '<table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px 0;width:100%;">\n' +
              '  <tr>\n' +
              '    <td valign="top" style="' + aiTdBase + 'width:22px;padding:0 6px 0 12px;">&bull;</td>\n' +
              '    <td valign="top" style="' + aiTdBase + '">' + aiLabelHtml + ': ' + aiBody + '</td>\n' +
              '  </tr>\n' +
              '</table>\n';
    });
    // NOTE 2026-06-12-fresh-first (user mandate): githubFooter line REMOVED.
    // The sentence "Here's what my GitHub has been since Claude Code dropped:"
    // was dangling linkless in T2 dedup edge cases and is removed at user request.
    // The canonical github.com/GauravRIIMK link is preserved in aiTools.header above.
    // REFERENCE_BLOCKS.aiTools.githubFooter value retained in Config.gs for
    // reference — UNUSED since 2026-06-12-fresh-first (user mandate: line removed from emails).
  }

  // ── Closing logistics (Claude-generated: location + 15-min ask, NO bold) ──
  // Canonical (humble 2026-05-12): "Based in Gurgaon and available to start
  // immediately. Would value 15 minutes to discuss how this maps to what your
  // team is building at {ORG}."
  //
  // PATCH 2026-05-13 (D4 acceptance test): calendly link in every draft.
  // PATCH -eq8-draftpolish (F6): hyperlink ONLY the words "15 minutes to discuss"
  // inside the closingLogistics text instead of appending a separate anchor after it.
  // This matches the brief spec and keeps a single clean hyperlink inline.
  var closingLogistics = _sanitizeText(parsed.closingLogistics || '');
  if (closingLogistics) {
    var calendlyAnchorHtml = '<a href="https://calendly.com/speak-to-gaurav/30min" style="color:#1a73e8;text-decoration:underline;">15 minutes to discuss</a>';
    // Replace "15 minutes to discuss" phrase with the hyperlinked version (case-insensitive)
    var linkedClosing = closingLogistics.replace(/15 minutes to discuss/i, calendlyAnchorHtml);
    // If the phrase was NOT found (different wording), fall back to appending the anchor
    if (linkedClosing === closingLogistics) {
      var fallbackCalendly = (refBlocks && refBlocks.calendlyAnchor && refBlocks.calendlyAnchor.html)
        ? ' &mdash; ' + refBlocks.calendlyAnchor.html
        : '';
      linkedClosing = closingLogistics + fallbackCalendly;
    }
    html += '<p style="' + pStyle + '">' + linkedClosing + '</p>\n';
  }

  // ── Closing resume mention ──
  // Canonical (hybrid polite + humble): "Please find my resume attached below
  // for further details. Would welcome the chance to discuss how this background
  // aligns with what your team is building."
  // PATCH 2026-05-12: fall back to refBlocks.resumeMention when Claude omits this
  // field — the canonical template requires the resume mention every time. The
  // STANDARD path (>=2 bullets) gets this fallback unconditionally.
  // PATCH 2026-05-19 (Leadership Master Template): SKIP closingResume entirely
  // for CXO_SHORT. Per the Founder-Grade Playbook audit: "You already asked
  // once via Calendly. Two CTAs reduces response. Resume attachment is
  // self-evident from the file name." STANDARD/HR continue to render this.
  if (!isCxoShortRender) {
    var closingResume = _sanitizeText(parsed.closingResume || '');
    if (!closingResume && refBlocks && refBlocks.resumeMention) {
      closingResume = _sanitizeText(refBlocks.resumeMention);
    }
    if (closingResume) {
      html += '<p style="' + pStyle + '">' + closingResume + '</p>\n';
    }
  }

  // PATCH 2026-05-13 (AUDIT R2): removed hardcoded "Looking forward to hearing
  // from you." paragraph. Research (Prospeo 2026, Lavender benchmark report,
  // Boomerang 350K-thread study) classifies it as a banned generic closer
  // that suppresses reply rates in cold outreach — it imposes obligation
  // without offering reason to reply. `closingLogistics` already carries the
  // specific 15-min ask (e.g. "Would value 15 minutes to discuss how this
  // maps to what your team is building at [ORG]") which is the modern
  // best-practice closer per the same sources.

  // ── Signoff line (matches references: "Thanks and regards," or "Regards,") ──
  // Defends against Claude omitting it: defaults to "Thanks and regards" — the
  // warmer of the two reference patterns.
  var signoffText = _sanitizeText(parsed.signoffText || 'Thanks and regards');
  // Strip any trailing punctuation Claude may have added, then add canonical comma
  signoffText = signoffText.replace(/[,.;:!?]+$/, '').trim();
  html += '<p style="' + pStyle + '">' + signoffText + ',</p>\n';

  // ── Signature block (static — name, credentials, LinkedIn) ──
  html +=
    '<table cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;">\n' +
    '  <tr><td style="font-family:' + s.fontFamily + ';font-size:' + s.fontSize + ';color:' + s.color + ';font-weight:bold;">Gaurav Rathore</td></tr>\n' +
    '  <tr><td style="font-family:' + s.fontFamily + ';font-size:12px;color:' + s.signatureColor + ';padding-top:2px;">' + credentialLine + '</td></tr>\n' +
    '  <tr><td style="font-family:' + s.fontFamily + ';font-size:12px;color:' + s.signatureColor + ';padding-top:2px;">' +
    '<a href="' + linkedinUrl + '" style="color:' + s.linkColor + ';text-decoration:underline;">LinkedIn Profile</a></td></tr>\n' +
    '</table>\n';

  // PATCH 2026-06-12-hr-layout: RENDER-ORDER INVARIANT.
  // psLine block REMOVED from this position — moved AFTER all guards below.
  // All guards (S2 Calendly, S3 GitHub, T2 dedup, T3 greeting) now run on
  // `html` BEFORE psLine is appended.  psLine is appended AFTER all guards
  // complete, making it the absolute last content before the signature block
  // is wrapped in the outer div.  This prevents S2's fallback inject (which
  // uses lastIndexOf to find the closing anchor) from landing after the PS.
  //
  // Canonical render order enforced:
  //   greeting → hook → bullets → motivation/bridge → aiTools block
  //   (canonical header + 3 items + githubFooter) → closingLogistics WITH
  //   canonical Calendly anchor → closingResume → signoff → signature
  //   → [S2/S3/T2/T3 guards run here on bodyHtml] → psLine → outer div.

  // PATCH 2026-06-11-eq8-contentguards (T3): Greeting integrity normalizer — BulletV1.
  // Defects: (a) model includes "Hi Name," in its hookParagraph or first bodyParagraph AND
  // the renderer also emits a <p> greeting → double greeting in output.
  // (b) some paths produce zero greetings (hook rendered directly, greeting empty).
  // Fix: after full html assembly (pre-psLine), count greeting <p> tags, enforce exactly 1.
  //   - >= 2: keep FIRST, strip remaining greeting paragraphs.
  //   - 0: inject canonical greeting after banner div (or at start if no banner).
  (function() {
    var _greetRe = /<p[^>]*>\s*(Hi|Hello|Hey)\s+[^<,]{1,30},?\s*<\/p>/gi;
    var _greetMatches = html.match(_greetRe) || [];
    if (_greetMatches.length >= 2) {
      // Keep first greeting, strip subsequent ones
      var _firstKept = false;
      html = html.replace(_greetRe, function(m) {
        if (!_firstKept) { _firstKept = true; return m; }
        Logger.log('[BulletV1] T3-greeting: removing duplicate greeting: ' + m.substring(0, 60));
        return '';
      });
    } else if (_greetMatches.length === 0) {
      // No greeting found — inject canonical greeting
      var _greetFirstName = (lead && lead.firstName) ? lead.firstName.toString().trim() : '';
      if (!_greetFirstName && lead && lead.fullName) {
        var _gfn = lead.fullName.toString().trim().split(/\s+/)[0] || '';
        if (/^[A-Za-zÀ-ſ][A-Za-z'.\-]{1,}$/.test(_gfn)) _greetFirstName = _gfn;
      }
      var _injectedGreeting = _greetFirstName
        ? ('<p style="' + pStyle + '">Hi ' + _greetFirstName + ',</p>\n')
        : ('<p style="' + pStyle + '">Hi,</p>\n');
      // Inject after banner div if present, else at start
      var _bannerEnd = html.indexOf('</div>');
      if (_bannerEnd > 0 && _bannerEnd < 400) {
        // Banner div is close to the start — insert after it
        html = html.substring(0, _bannerEnd + 6) + '\n' + _injectedGreeting + html.substring(_bannerEnd + 6);
      } else {
        html = _injectedGreeting + html;
      }
      Logger.log('[BulletV1] T3-greeting: injected missing greeting for ' + (_greetFirstName || 'anon'));
    }
  })();

  // PATCH 2026-06-11-eq8-c6cal (S2): Unconditional Calendly link guarantee — BulletV1.
  // PATCH 2026-06-12-hr-layout: S2 now runs on intermediate `html` BEFORE psLine
  // is appended. This prevents the fallback inject from landing after the PS.
  // Strategy (inject-if-absent only — never double-link):
  //   (a) If /15 minutes to discuss/i is present, wrap with the anchor.
  //   (b) Else inject a canonical Calendly paragraph using the canonical
  //       "Schedule a call here" anchor (not the "grab 15 minutes" paraphrase).
  //       Insert before the signoff <p> so it lands in the body, not after PS.
  if (html.indexOf('calendly.com/speak-to-gaurav/30min') < 0) {
    if (/15 minutes to discuss/i.test(html)) {
      html = html.replace(/15 minutes to discuss/gi,
        '<a href="https://calendly.com/speak-to-gaurav/30min" style="color:#1a73e8;text-decoration:underline;">15 minutes to discuss</a>');
    } else if (/10 minutes/i.test(html)) {
      // HR closingLogistics says "connect for 10 minutes" — hyperlink that phrase
      // with the canonical Calendly URL so the link is present without adding
      // a second CTA paragraph. Only the first occurrence is linked.
      html = html.replace(/10 minutes/i,
        '<a href="https://calendly.com/speak-to-gaurav/30min" style="color:#1a73e8;text-decoration:underline;">10 minutes</a>');
    } else {
      // No time-ask phrase found — insert canonical Calendly anchor paragraph
      // before the signoff <p> so it appears in body, not after PS.
      var _calSignoffHtml = '<p style="' + pStyle + '">Open to ' +
        '<a href="https://calendly.com/speak-to-gaurav/30min" style="color:#1a73e8;text-decoration:underline;">scheduling a call</a>' +
        ' if that is easier.</p>\n';
      var _calSignoffIdx = html.lastIndexOf('<p style="' + pStyle + '">');
      if (_calSignoffIdx >= 0) {
        html = html.substring(0, _calSignoffIdx) + _calSignoffHtml + html.substring(_calSignoffIdx);
      } else {
        html += _calSignoffHtml;
      }
    }
  }

  // PATCH 2026-06-11-eq8-finalpolish (S3): Unconditional GitHub link guarantee —
  // BulletV1 renderer. PATCH 2026-06-12-hr-layout: runs before psLine.
  // For STANDARD/HR shapes: the aiTools header already contains the link — this
  // guard is a safety net for any path where showAiToolsBlock was false or null.
  // PATCH 2026-06-13-final-cert: exclude CXO_SHORT — showAiToolsBlock is
  // intentionally false for CXO (Founder-Grade Playbook bans the AI-tools header
  // and "On the builder side..." phrase for Director+ recipients). Without this
  // guard the S3 block fired on every CXO output and injected the banned phrase
  // after the signature. isCxoShortRender is declared at line 4047.
  if (!isCxoShortRender && html.indexOf('github.com/GauravRIIMK') < 0) {
    // Inject canonical builder header with hyperlink — NOT the "Builder side —"
    // paraphrase. Use the REFERENCE_BLOCKS canonical header when available.
    var _canonicalGhHeader = (refBlocks && refBlocks.aiTools && refBlocks.aiTools.header)
      ? refBlocks.aiTools.header
      : 'On the builder side, three AI tools shipped independently (all live). <a href="https://github.com/GauravRIIMK" style="color:#1a73e8;text-decoration:underline;">github.com/GauravRIIMK</a>';
    var _ghLine = '<p style="' + pStyle + '">' + _canonicalGhHeader + '</p>\n';
    // Insert after experience bullets block (before motivation/AI header).
    var _ghBulletsEnd = html.lastIndexOf('</table>');
    if (_ghBulletsEnd > 0) {
      var _ghInsertPos = _ghBulletsEnd + '</table>'.length;
      html = html.substring(0, _ghInsertPos) + '\n' + _ghLine + html.substring(_ghInsertPos);
    } else {
      // Fallback: before signoff paragraph
      var _ghSignoffIdx = html.lastIndexOf('<p style="' + pStyle + '">');
      if (_ghSignoffIdx > 0) {
        html = html.substring(0, _ghSignoffIdx) + _ghLine + html.substring(_ghSignoffIdx);
      } else {
        html += _ghLine;
      }
    }
  }

  // PATCH 2026-06-11-eq8-contentguards (T2): GitHub link deduplication — BulletV1.
  // PATCH 2026-06-12-builderblock-v2: narrowed regex; PATCH 2026-06-12-hr-layout:
  // runs before psLine.
  (function() {
    var _ghStandaloneRe = /<a\s[^>]*href="https?:\/\/github\.com\/GauravRIIMK"[^>]*>github\.com\/GauravRIIMK<\/a>/gi;
    var _standaloneMatches = html.match(_ghStandaloneRe) || [];
    if (_standaloneMatches.length > 1) {
      var _firstFound = false;
      html = html.replace(_ghStandaloneRe, function(m) {
        if (!_firstFound) { _firstFound = true; return m; }
        return '';  // strip 2nd+ standalone anchor
      });
      Logger.log('[BulletV1] T2-dedup: reduced standalone github.com/GauravRIIMK anchors from ' +
        _standaloneMatches.length + ' to 1');
    }
  })();

  // PATCH 2026-06-12-hr-layout: psLine appended LAST — after all guards.
  // This is the render-order invariant: nothing renders after psLine except
  // the outer div wrapper. Guards above (S2, S3, T2, T3) all operate on
  // `html` before this point so they cannot inject content after the PS.
  if (parsed.psLine) {
    var cleanPs = _sanitizeText(parsed.psLine).replace(/^P\.?\s?S\.?\s*[:\-]?\s*/i, '');
    if (cleanPs) {
      html +=
        '<p style="margin:20px 0 0 0;font-family:' + s.fontFamily + ';font-size:13px;font-style:italic;color:' + s.psColor + ';border-left:3px solid #d0d0d0;padding-left:12px;">' +
        '<strong>P.S.</strong> ' + cleanPs +
        '</p>\n';
    }
  }

  // PATCH `-eq8-content-fix` (#4): REMOVED the outer-wrapper max-width.
  // PATCH 2026-06-12-hr-layout: finalHtml assembled after all guards+psLine.
  // No S2 re-check on finalHtml needed — S2 ran on `html` above.
  var finalHtml = '<div style="font-family:' + s.fontFamily + ';font-size:' + s.fontSize +
                  ';line-height:' + s.lineHeight + ';color:' + s.color + ';">\n' +
                  html + '</div>';

  return finalHtml;
}

// ─── DEFENSIVE HELPERS — name + phone sanitation ─────────────────────
//
// These guard against the 2026-05 production bugs where:
//   (1) "Hi <Name>" rendered as "Hi 9876543210," or "Hi ," — phone numbers
//       or empty strings landed in lead.fullName via LinkedIn extension
//       column-shift or DOM scrape grabbing the wrong element.
//   (2) Phone numbers from scraped LinkedIn posts / company news leaked into
//       the email body when Claude treated them as legitimate hooks.
//
// Layer them at every boundary where untrusted text flows into the prompt
// or the rendered email.

// PATCH -eq8-draftpolish (F2): safe first-name extractor used by _resolveGreeting.
// Derives a validated first name from lead.firstName → lead.fullName first token.
// Returns '' when no clean alphabetic name is available, so callers can choose
// a safe generic greeting instead of emitting a placeholder or junk token.
//
// @param {Object} lead - LeadProfile
// @returns {string} Validated first name, or '' if none extractable
function _safeFirstName(lead) {
  // Try lead.firstName first
  var fn = (lead && lead.firstName) ? lead.firstName.toString().trim() : '';
  if (fn && /^[A-Za-zÀ-ſ][A-Za-z'.\-]{1,}$/.test(fn)) return fn;
  // Fall back to first token of fullName
  if (lead && lead.fullName) {
    var token = lead.fullName.toString().trim().split(/\s+/)[0] || '';
    if (/^[A-Za-zÀ-ſ][A-Za-z'.\-]{1,}$/.test(token)) return token;
  }
  return '';
}

/**
 * Resolves the greeting through a safe fallback chain:
 *   1. Claude's parsed.greeting if it looks like a real greeting
 *      ("Hi <AlphaWord>," or "Hi Team <AlphaWord>,") — DOES NOT contain
 *      runs of digits, @, http, placeholder tokens ("there", "[Name]"), or be just "Hi ,"
 *   2. "Hi <firstName>," if lead.firstName is alphabetic (via _safeFirstName)
 *   3. "Hi Team <Org>," if lead.organization is present (mirrors reference-1
 *      "Hi Team Kapture CX,")
 *   4. "Hi," as last resort (NEVER "Hi there," or placeholder)
 *
 * PATCH -eq8-draftpolish (F2): added rejection of /hi\s*(there|\[?name\]?)/i patterns
 * so Claude emitting "Hi There," or "Hi [Name]," no longer slips through validation.
 * Falls back through _safeFirstName → org → bare "Hi," (no junk placeholder).
 *
 * @param {string} claudeGreeting   - parsed.greeting from Claude
 * @param {Object} lead             - LeadProfile
 * @returns {string} A safe greeting ending with ","
 */
function _resolveGreeting(claudeGreeting, lead) {
  var raw = (claudeGreeting || '').toString().trim();

  // PATCH -eq8-draftpolish (F2): reject placeholder/junk greetings before the
  // broader validity check. "Hi There," and "Hi [Name]," are LLM-emitted junk
  // that pass the old digit/@ guards because "There" is alphabetic.
  var isPlaceholderGreeting = /^(hi|hello|hey)\s*(there|\[?name\]?)/i.test(raw);

  // Validate Claude's greeting:
  //  - Must start with a hi/hello/hey-style salutation
  //  - Must NOT be a placeholder (there / [name])
  //  - Must NOT contain runs of digits, @, http, or be just "Hi ," (empty name)
  //  - Must end with comma after a real word
  var validClaude = (
    !isPlaceholderGreeting &&
    /^(hi|hello|hey)\s+/i.test(raw) &&
    !/\d{3,}/.test(raw) &&
    !/@/.test(raw) &&
    !/https?:/i.test(raw) &&
    /[A-Za-z]{2,}/.test(raw.replace(/^(hi|hello|hey)\s+/i, '').replace(/^team\s+/i, '')) &&
    raw.length >= 5 && raw.length <= 60
  );
  if (validClaude) {
    return raw.endsWith(',') ? raw : (raw + ',');
  }

  // Fallback via _safeFirstName (covers both lead.firstName and fullName first token)
  var fn = _safeFirstName(lead);
  if (fn) {
    return 'Hi ' + fn + ',';
  }

  // Fallback to "Hi Team <Org>," — matches the reference-email pattern
  // for emails where the recipient is a team or named contact wasn't extractable.
  var org = (lead && lead.organization) ? lead.organization.toString().trim() : '';
  if (org && /[A-Za-z]/.test(org) && org.length < 40) {
    // Strip Inc/Ltd/Pvt suffixes for cleaner "Hi Team {clean},"
    var cleanOrg = org.replace(/\b(inc|llc|ltd|limited|corp|corporation|pvt|private|technologies|technology)\.?$/i, '').trim();
    if (cleanOrg) return 'Hi Team ' + cleanOrg + ',';
  }

  // Last resort — PATCH -eq8-draftpolish (F2): 'Hi there,' is itself a
  // placeholder; use bare 'Hi,' so nothing junk leaks into the sent email.
  return 'Hi,';
}

/**
 * Strips phone-number-like strings from arbitrary text. Used on dossier text
 * fields (hooks, recentNews, recentLinkedInPosts, sharedBackground, challenges)
 * before they're fed to Claude — Claude has no business knowing the lead's
 * personal phone number, and citing it in the email is creepy + non-compliant.
 *
 * Patterns removed:
 *   - International: +91 98765 43210, +1 (415) 555-1234, +44.20.1234.5678
 *   - National: 9876543210, 987-654-3210, (987) 654 3210
 *   - Loose digit runs of 7+ characters surrounded by spaces or punctuation
 *
 * Years (4 digits, 1900-2099) and 3-4 digit numbers in normal text are preserved.
 *
 * @param {string} text
 * @returns {string} Text with phone-likely substrings replaced by " "
 */
function _stripPhoneNumbers(text) {
  if (!text) return text;
  var s = text.toString();
  // International with leading +
  s = s.replace(/\+\d{1,3}[\s\-.()]*\d{1,4}[\s\-.()]*\d{1,4}[\s\-.()]*\d{1,4}[\s\-.()]*\d{0,4}/g, ' ');
  // North American style with parens
  s = s.replace(/\(?\b\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}\b/g, ' ');
  // Long digit run (7+ contiguous)
  s = s.replace(/\b\d{7,}\b/g, ' ');
  // Common Indian-mobile pattern: 10 digits with possible spaces/dashes between groups
  s = s.replace(/\b[6-9]\d{2}[\s\-]?\d{3}[\s\-]?\d{4}\b/g, ' ');
  return s.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Walks the dossier and applies _stripPhoneNumbers + name-validation to every
 * text field that gets passed to Claude. Mutates a SHALLOW COPY of the dossier
 * (does not modify the original — research data stays intact for audit).
 *
 * @param {Object} dossier
 * @returns {Object} Sanitized copy
 */
function _sanitizeDossierForPrompt(dossier) {
  if (!dossier || typeof dossier !== 'object') return dossier;
  var clone = {};
  for (var k in dossier) clone[k] = dossier[k];

  // Sanitize string fields
  ['recentNews', 'recentLinkedInPosts', 'bestHookAngle'].forEach(function(field) {
    if (typeof clone[field] === 'string') clone[field] = _stripPhoneNumbers(clone[field]);
  });

  // Hooks array — each hook may be an object with .text or a raw string
  if (Array.isArray(clone.hooks)) {
    clone.hooks = clone.hooks.map(function(h) {
      if (typeof h === 'string') return _stripPhoneNumbers(h);
      if (h && typeof h === 'object' && h.text) {
        return Object.assign({}, h, { text: _stripPhoneNumbers(h.text) });
      }
      return h;
    });
  }

  // Trigger events
  if (Array.isArray(clone.triggerEvents)) {
    clone.triggerEvents = clone.triggerEvents.map(function(t) {
      if (typeof t === 'string') return _stripPhoneNumbers(t);
      if (t && typeof t === 'object' && t.event) {
        return Object.assign({}, t, { event: _stripPhoneNumbers(t.event) });
      }
      return t;
    });
  }

  // Shared background
  if (Array.isArray(clone.sharedBackground)) {
    clone.sharedBackground = clone.sharedBackground.map(function(x) {
      return typeof x === 'string' ? _stripPhoneNumbers(x) : x;
    });
  }

  // Bridge statements
  if (Array.isArray(clone.bridgeStatements)) {
    clone.bridgeStatements = clone.bridgeStatements.map(function(x) {
      return typeof x === 'string' ? _stripPhoneNumbers(x) : x;
    });
  }

  // Company subtree
  if (clone.company && typeof clone.company === 'object') {
    var co = {};
    for (var ck in clone.company) co[ck] = clone.company[ck];
    if (typeof co.recentNews === 'string') co.recentNews = _stripPhoneNumbers(co.recentNews);
    if (typeof co.challenges === 'string') co.challenges = _stripPhoneNumbers(co.challenges);
    if (typeof co.growthSignals === 'string') co.growthSignals = _stripPhoneNumbers(co.growthSignals);
    if (typeof co.hiringSignals === 'string') co.hiringSignals = _stripPhoneNumbers(co.hiringSignals);
    clone.company = co;
  }

  return clone;
}

// ─── BULLET STRUCTURE NORMALIZERS — render-time defensive layer ──────
//
// Claude is inconsistent about how it splits experience bullets into
// {label, body}. These helpers normalize the data right before HTML render
// so the bold/bullet rendering matches the reference emails exactly.

/**
 * Normalizes a {label, body} pair into a clean (label, body) where:
 *   - label ends with the closing paren (if any company period is given)
 *   - label has NO trailing colon (added by renderer)
 *   - body starts with the action verb / past-tense statement
 *   - colons that Claude put on the wrong side are corrected
 *
 * Examples it handles:
 *   {"upGrad", "(2021-23): Built two..."}      → {"upGrad (2021-23)", "Built two..."}
 *   {"upGrad (2021-23):", "Built two..."}      → {"upGrad (2021-23)", "Built two..."}
 *   {"upGrad (2021-23)", ": Built two..."}     → {"upGrad (2021-23)", "Built two..."}
 *   {"upGrad (2021-23)", "Built two..."}       → unchanged (already correct)
 *
 * @param {string} rawLabel
 * @param {string} rawBody
 * @returns {{label: string, body: string}}
 */
function _normalizeBulletLabelBody(rawLabel, rawBody) {
  var label = (rawLabel || '').toString().trim();
  var body  = (rawBody  || '').toString().trim();

  // Strip any trailing colon/whitespace on label
  label = label.replace(/[:\s]+$/, '');

  // Strip any leading colon/whitespace on body
  body = body.replace(/^[:\s]+/, '');

  // If body starts with "(...)" and label has no closing paren, merge.
  // Limit to first 50 chars so we don't accidentally absorb a long parenthetical mid-sentence.
  if (body.charAt(0) === '(' && label.indexOf(')') < 0) {
    var closeIdx = body.indexOf(')');
    if (closeIdx > 0 && closeIdx < 50) {
      label = label + ' ' + body.substring(0, closeIdx + 1);
      body  = body.substring(closeIdx + 1).replace(/^[:\s]+/, '');
    }
  }

  // Final tidy
  label = label.replace(/\s{2,}/g, ' ').trim();
  body  = body.replace(/\s{2,}/g, ' ').trim();
  return { label: label, body: body };
}

/**
 * Converts Markdown emphasis Claude may have emitted into HTML tags.
 * Only handles **bold** and __bold__ — italic conversion is skipped because
 * single-asterisk patterns are too common in legitimate prose (e.g. "saw a
 * 4*5*3 segmentation matrix").
 *
 * @param {string} text
 * @returns {string}
 */
function _convertMarkdownInline(text) {
  if (!text) return text;
  return text.toString()
    .replace(/\*\*([^*\n]+?)\*\*/g, '<b style="font-weight:bold;">$1</b>')
    .replace(/__([^_\n]+?)__/g, '<b style="font-weight:bold;">$1</b>');
}

// ─── API INTEGRATION ──────────────────────────────────────
// Note: callClaude is defined in ApiClients.gs
