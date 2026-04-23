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
    .replace(/[\u2014\u2015]/g, ' - ')                          // — ― → " - " (STRICT: no em-dash ever)
    .replace(/[\u2013]/g, '-')                                  // – → plain hyphen
    .replace(/\u2026/g, '...')                                  // … → ...
    .replace(/[""]/g, '"')                                      // Fullwidth quotes → straight
    .replace(/['']/g, "'");                                     // Fullwidth single → straight
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

  // Build context with resume highlights and org challenges
  var context = _buildCompositionContext(lead, dossier, classification, resumeSelection);

  // Build system + user prompts
  var systemPrompt = _buildSystemPrompt(template, classification.approach);
  var userPrompt = _buildUserPrompt(template, lead, context, classification, resumeSelection);

  // Call Claude API
  var result = callClaude(userPrompt, {
    systemPrompt: systemPrompt,
    temperature: 0.7,
    maxTokens: 1200
  });

  if (!result.success) {
    return { success: false, qualityNotes: 'Claude API call failed: ' + result.error };
  }

  // Parse JSON response
  var parsed = _parseCompositionResponse(result.data);
  if (!parsed) {
    return { success: false, qualityNotes: 'Failed to parse Claude response as JSON' };
  }

  // Quick validation
  var validation = _quickValidate(parsed, lead);

  // Auto-fix critical issues (attachment mentions, direct job-asking)
  if (validation.issues.some(function(i) {
    return i.indexOf('FATAL') >= 0 || i.indexOf('Spam trigger') >= 0;
  })) {
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
  }

  // Only FATAL issues block the pipeline
  var fatalIssues = validation.issues.filter(function(i) { return i.indexOf('FATAL') >= 0; });

  // ── Build HTML email ──
  var htmlBody = _buildHtmlEmail(parsed, lead, resumeSelection);

  // ── Structural verification (cold email compliance check) ──
  var structureCheck = _verifyEmailStructure(htmlBody, parsed);
  if (structureCheck.issues.length > 0) {
    logPipelineEvent(lead.rowNum, 'COMPOSE', 'Structure check: ' + structureCheck.issues.join('; '), 'WARN');
  }

  // ── Build subject line with job-application context ──
  var finalSubject = _buildSubjectLine(parsed.subjectLine, lead, context);

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
function _buildHtmlEmail(parsed, lead, resumeSelection) {
  var s = EMAIL_STYLE;

  // ── SAFETY NET: run dedup again at render time in case parsed was mutated
  // by any downstream stage (quality gate, fix loop, recomposition).
  // This is idempotent — if already dedup'd, no-op.
  _dedupParsedComposition(parsed);

  // Signature uses GAURAV_FACTS for verified credentials (no misleading role taglines)
  var facts = (typeof GAURAV_FACTS !== 'undefined') ? GAURAV_FACTS : {};
  var linkedinUrl = facts.linkedin || 'https://www.linkedin.com/in/gaurav1-grow-learn-together';
  var credentialLine = facts.signatureLine1 || 'MBA, IIM Kozhikode | B.E., Thapar University';

  // Greeting (sanitize curly quotes)
  var greeting = _sanitizeText(parsed.greeting || ('Hi ' + (lead.fullName ? lead.fullName.split(' ')[0] : '') + ','));

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
    '<a href="' + linkedinUrl + '" style="color:' + s.linkColor + ';text-decoration:none;">LinkedIn Profile</a></td>\n' +
    '  </tr>\n' +
    '</table>\n';

  // P.S. block (sanitize)
  var psHtml = '';
  if (parsed.psLine) {
    var cleanPs = _sanitizeText(parsed.psLine);
    psHtml =
      '<p style="margin:20px 0 0 0;font-family:' + s.fontFamily + ';font-size:13px;font-style:italic;color:' + s.psColor + ';border-left:3px solid #d0d0d0;padding-left:12px;">' +
      '<strong>P.S.</strong> ' + cleanPs +
      '</p>\n';
  }

  // ── Banner image (inline CID — loaded by GmailDrafter from Drive) ──
  // Uses cid:emailBanner which GmailDrafter maps to the banner blob via inlineImages.
  // If no banner is configured, the img tag gracefully hides (alt text only).
  var bannerHtml =
    '<div style="margin:0 0 20px 0;text-align:center;">\n' +
    '  <img src="cid:emailBanner" alt="Gaurav Rathore - Strategy, Operations & Growth" ' +
    'width="600" style="max-width:100%;height:auto;display:block;border:0;border-radius:6px;" />\n' +
    '</div>\n';

  // Assemble full email: Banner → Greeting → Body → CTA → Signature → P.S.
  var html =
    '<div style="font-family:' + s.fontFamily + ';font-size:' + s.fontSize + ';line-height:' + s.lineHeight + ';color:' + s.color + ';max-width:600px;">\n' +
    bannerHtml +
    '<p style="margin:0 0 12px 0;font-family:' + s.fontFamily + ';font-size:' + s.fontSize + ';color:' + s.color + ';">' + greeting + '</p>\n' +
    bodyHtml +
    signatureHtml +
    psHtml +
    '</div>';

  return html;
}

// ─── SUBJECT LINE BUILDER ────────────────────────────────────

/**
 * Builds a clear job-application subject line.
 * Format: "Job Application: [Claude's topic] | Gaurav Rathore"
 * Playbook rationale: explicit "Job Application" prefix helps recruiters/hiring
 * managers triage cold inbound, signals intent clearly, and keeps the personalized
 * topic (2-5 words from Claude) as the differentiator that drives open rate.
 * @param {string} claudeSubject - Topic text from Claude (2-5 words)
 * @param {Object} lead - LeadProfile
 * @param {Object} context - Composition context
 * @returns {string} Final subject line
 */
function _buildSubjectLine(claudeSubject, lead, context) {
  // Sanitize curly quotes first, then strip any prefix Claude may have added
  // (covers "Application:", "Job Application:", "Re:", "Fwd:")
  var clean = _sanitizeText(claudeSubject)
    .replace(/^(re:|fwd:|job\s*application[:\-]?\s*|application[:\-]?\s*)/i, '')
    .trim();

  // Fallback topic if Claude returned empty
  if (!clean) {
    var org = (lead && lead.organization) ? lead.organization : 'your team';
    clean = 'Strategy & Growth at ' + org;
  }

  // Build final: "Job Application: [topic] | Gaurav Rathore" (no em-dash — strict rule)
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
    gauravAchievements = GAURAV_PROFILE[resumeVariantId].achievements.slice(0, 3);
  }

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
    bestHookAngle: bestHookAngle
  };
}

// ─── SYSTEM PROMPT ────────────────────────────────────────

/**
 * Builds system prompt for job-seeking cold emails.
 */
function _buildSystemPrompt(template, approach) {
  return 'You are an expert job-application cold-email composer. You write personalized, authentic cold emails for a candidate who is openly exploring roles. The subject line carries an explicit "Job Application:" prefix (added automatically), so the BODY must own the intent gracefully — it is a cold job-application email, not a disguised sales pitch.\n\n' +
    '## CRITICAL: Job-Seeking Context\n' +
    'Gaurav Rathore (MBA IIM Kozhikode, B.E. Thapar University) is seeking Strategy/Operations/Growth/GTM roles at Indian startups (Series A through Pre-IPO).\n' +
    'The reader already knows this is a job application (from the subject). Your job is to earn a reply by proving Gaurav did real research AND can plausibly contribute to a specific challenge they are facing.\n' +
    'Frame: a capable peer introducing themselves for a role-fit conversation — confident, not begging, not salesy.\n\n' +
    '## HOOK SELECTION PLAYBOOK — RESEARCH-BACKED RANKING (2026 data)\n' +
    'Benchmark data (Digital Bloom 2025 × Prospeo 2026 × Woodpecker 20M emails): signal-based openers deliver 15-25% reply rates vs 3-5% for generic ones. For JOB-APPLICATION cold emails (recruiting use-case), the baseline is even higher (10-20% avg). Pick opening in this order, walking down tiers until you find usable material:\n' +
    '\n' +
    'TIER 1 — CONTENT/QUOTE HOOK (32% reply when specific): Quote or paraphrase a SPECIFIC line from a LinkedIn post / podcast / talk / article BY THE LEAD in last 90 days. Mechanism: proof of deep attention, not flattery. Template: "Your {post/talk} on {specific topic} — the point about {specific claim} stuck with me because {why}."\n' +
    '\n' +
    'TIER 2 — TRIGGER EVENT HOOK (15-25% reply): Name a specific recent event (funding round with amount+lead investor, product launch with name, market entry, leadership hire, hiring-spike) from LATEST NEWS / triggerEvents above. Mechanism: implies a hiring or scaling need. Template: "Congrats on {specific event with number/name}. {Function} is usually the next bottleneck after {event type}."\n' +
    '\n' +
    'TIER 3 — TIMELINE/MILESTONE HOOK (10.01% reply, BEST across ICPs per Digital Bloom): Compressed time-bounded achievement about THEIR org — growth rate, headcount jump, user/revenue milestone — with dates. Template: "{Company} went from {X} to {Y} in {Z months}. Growth like that usually breaks {specific system} first."\n' +
    '\n' +
    'TIER 4 — NUMBERS/METRIC HOOK (8.57% reply): Reference ONE specific quantified public data point about their org (funding amount, ARR, open-role count, G2 review pattern, headcount). Template: "Noticed {company} has {specific number} {specific thing} — that\'s the kind of signal that usually means {function} is the next hire."\n' +
    '\n' +
    'TIER 5 — INDUSTRY INSIGHT HOOK (for C-suite/Founder only): Reference a current market shift / regulatory change / category trend they\'ve publicly engaged with. Template: "{Specific market shift} hit in {timeframe}. Most {their category} teams are not ready. You seem to be — especially after {their recent move}."\n' +
    '\n' +
    'HARD-AVOID HOOKS (data-backed kill list):\n' +
    '- Generic compliments ("love what you are building", "impressive work") — reads as flattery, not research\n' +
    '- Vague market hooks ("EdTech is booming", "AI is exciting") — zero signal\n' +
    '- Problem-callout WITHOUT a specific metric ("are you struggling with X?") — baseline 4.39% reply\n' +
    '- Life-story hooks (opening with Gaurav\'s background instead of theirs)\n' +
    '- Competitor-intelligence hooks (high-risk for job apps — reads as manipulative)\n\n' +
    '## BODY STRUCTURE FOR JOB-APPLICATION COLD EMAIL (data-backed)\n' +
    'Top performers keep first-touch emails under 80 words (Prospeo 2026). First sentence must be under 15 words.\n' +
    'Paragraph 1 (Hook, 1-2 sentences, <30 words): Specific research detail from the tier list above. Names the observation. No "I" in this paragraph. Must contain a concrete noun: a number, name, date, quote, or event.\n' +
    'Paragraph 2 (Bridge, 2-3 sentences, ~40-50 words): Connect their situation to Gaurav\'s most relevant achievement with a concrete metric. ONE achievement only — pick the one whose metric-shape matches their situation most closely. Frame: "At {past-company}, I {specific action} and {specific result with number}" — a peer sharing a parallel, not a pitch.\n' +
    'Paragraph 3 (optional, 1 sentence, <20 words): Second relevant signal — only include if it adds a distinct angle (domain expertise, shared context). Skip if email is already at 70+ words.\n' +
    'CTA (1 sentence, <25 words): Explicitly name the role-area ask — "Open to a 15-min chat about whether {Strategy/Ops/Growth/GTM} roles on your team could be a fit?" Direct but low-pressure.\n' +
    'Target body total: 55-90 words. Hard max 120.\n\n' +
    '## OUTPUT FORMAT — MUST FOLLOW EXACTLY\n' +
    'Return ONLY valid JSON with these fields:\n' +
    '{\n' +
    '  "subjectLine": "2-5 word TOPIC only (do NOT include \'Job Application:\' prefix — it is added automatically)",\n' +
    '  "greeting": "Hi [FirstName],",\n' +
    '  "bodyParagraphs": [\n' +
    '    "Hook paragraph: specific research detail",\n' +
    '    "Bridge paragraph: their situation → Gaurav achievement with metric",\n' +
    '    "Optional third paragraph: second signal (skip if email is already tight)"\n' +
    '  ],\n' +
    '  "cta": "Direct role-fit ask for a 15-min conversation",\n' +
    '  "psLine": "Second hook — different angle from opening (news, LinkedIn post, or industry insight)"\n' +
    '}\n\n' +
    '## RULES\n' +
    '- bodyParagraphs: 2-3 paragraphs, total 50-120 words across all paragraphs\n' +
    '- Each paragraph is plain text (NO HTML tags, NO markdown)\n' +
    '- subjectLine: 2-5 words naming the VALUE TOPIC, not the act of applying (e.g., "Growth Ops at Zepto", "EdTech Scale Strategy", "GTM for Series B"). The "Job Application:" prefix is added automatically.\n' +
    '- CTA: Ask for a 15-min conversation AND name the role-area (Strategy / Operations / Growth / GTM) — do NOT ask for a job offer directly\n' +
    '- OK in body: "exploring {function} roles", "role-fit", "contribute to" — these are the job-application frame\n' +
    '- BANNED in body: "hire me", "please consider me", "looking for a position", "give me a chance", "desperate"\n' +
    '- BANNED openers (data-backed dead list, all reduce reply rate): "I hope this email finds you well", "I hope you are doing well", "My name is", "I am reaching out because", "I wanted to reach out", "I wanted to connect", "I came across your profile", "I saw your profile", "Sorry to bother you", "I know you are busy", "Just following up" (as first-touch)\n' +
    '- BANNED in body: any mention of "attached", "resume", "CV", "pdf" (resume is attached separately)\n' +
    '- NO spam words: free, urgent, act now, guaranteed, click here\n' +
    '- Personalization is CRITICAL — reference specific details from research. Generic = auto-fail.\n' +
    '- Sound human and natural — use contractions, short sentences\n' +
    '- Tone: ' + (approach || 'professional') + '\n\n' +
    '## STRICT FORMATTING RULES\n' +
    '- NEVER use em-dash character. Use " - " (space-hyphen-space) or comma instead.\n' +
    '- NEVER use curly/smart quotes. Use straight quotes only.\n' +
    '- Use only plain ASCII characters — no Unicode special characters.\n\n' +
    '## CRITICAL: ACCURACY & ANTI-HALLUCINATION\n' +
    'Gaurav\'s ONLY educational institutions are: IIM Kozhikode (MBA) and Thapar University (B.E.).\n' +
    'Gaurav\'s work history: Blinkit/Zomato, Thoughtworks, upGrad, Shiprocket.\n' +
    'NEVER claim Gaurav is an alumni of any other institution.\n' +
    'NEVER claim shared background unless the research data EXPLICITLY confirms it.\n' +
    'If research mentions "Great Learning" — that is the LEAD\'S COMPANY, NOT Gaurav\'s alma mater. Do NOT confuse it with "Great Lakes" business school.\n' +
    'If you are not 100% certain about a shared connection, DO NOT mention it. Use an industry insight or earned compliment instead.\n';
}

// ─── USER PROMPT ──────────────────────────────────────────

/**
 * Builds user prompt with research context and resume highlights.
 */
function _buildUserPrompt(template, lead, context, classification, resumeSelection) {
  var prompt = 'Compose a job-seeking cold email to ' + context.leadName + ', ' + context.designation + ' at ' + context.organization + '.\n\n' +
    'Template: ' + template + '\n' +
    'Approach: ' + (classification.approach || 'professional') + '\n\n' +
    '## GAURAV\'S RELEVANT BACKGROUND\n' +
    'Resume Variant: ' + context.resumeVariant + '\n';

  if (context.gauravAchievements && context.gauravAchievements.length > 0) {
    prompt += 'Key Achievements (use 1-2 in the email):\n';
    context.gauravAchievements.forEach(function(ach) {
      prompt += '- ' + ach + '\n';
    });
  }

  prompt += '\n## LEAD & ORG CONTEXT\n';

  // Latest news (strongest opening material - RECENT and SPECIFIC)
  if (context.latestNews && context.latestNews.length > 10) {
    prompt += 'LATEST NEWS (use this for opening hook if specific enough): ' + context.latestNews + '\n';
  }

  // LinkedIn activity (highly personal - best for earned compliment opening)
  if (context.linkedInActivity && context.linkedInActivity.length > 10) {
    prompt += 'THEIR LINKEDIN ACTIVITY (great for personalized opening): ' + context.linkedInActivity + '\n';
  }

  // AI-recommended best hook angle
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

  // Bridge statements (pre-validated resume-to-org connections)
  if (context.bridgeStatements && context.bridgeStatements.length > 0) {
    prompt += 'RESUME-TO-ORG BRIDGES (validated connections between Gaurav\'s experience and their needs):\n';
    context.bridgeStatements.forEach(function(bridge) {
      prompt += '- ' + bridge + '\n';
    });
  }

  prompt += '\n## HOOK SELECTION — pick ONE opening hook using this RESEARCH-BACKED ranking (2026 data)\n' +
    'Walk tiers in order; pick the FIRST tier whose data is CONCRETE (names a specific number, name, date, or quote):\n' +
    '  TIER 1 — Content/Quote Hook (32% reply): Use if THEIR LINKEDIN ACTIVITY above quotes a specific post/comment/repost BY THE LEAD with a specific phrase or claim we can paraphrase.\n' +
    '  TIER 2 — Trigger Event Hook (15-25% reply): Use if LATEST NEWS or triggerEvents names a specific funding round (with amount+investor), launch (with product name), market entry, leadership move, or hiring spike.\n' +
    '  TIER 3 — Timeline/Milestone Hook (10% reply): Use if research shows a compressed time-bounded growth metric (employees went X→Y in Z months, ARR grew X in Y quarters, specific expansion timeline).\n' +
    '  TIER 4 — Numbers/Metric Hook (8.57% reply): Use if research names one specific quantified public data point (open-role count, review pattern, funding amount, headcount).\n' +
    '  TIER 5 — Industry Insight Hook: Only for C-suite/Founder when research shows them engaging with a specific market shift.\n' +
    '  TIER 6 — AI-Recommended Angle: Fall back to AI-RECOMMENDED OPENING ANGLE above only if tiers 1-5 are all generic.\n' +
    'DEAD ZONE: If all tiers are weak/generic, prefer a SHORTER email that uses the best available concrete detail over a longer email padded with generic praise. Generic openers auto-fail.\n\n' +
    '## REQUIREMENTS\n' +
    '1. Opening hook MUST come from the selected tier above and name at least ONE concrete noun: number, name, date, event, or direct quote. Generic = auto-fail.\n' +
    '2. First sentence of the body MUST be under 15 words (2026 benchmark for top performers).\n' +
    '3. Bridge paragraph MUST include exactly ONE metric-backed achievement from Gaurav\'s Key Achievements whose METRIC SHAPE matches the hook (growth→growth, ops→ops, GTM→GTM).\n' +
    '4. Weight of voice: use "you/your/{company}" more than "I" in paragraph 1. Paragraph 2 (bridge) is allowed to use "I".\n' +
    '5. Body total: TARGET 55-90 words, hard MAX 120 words across 2-3 paragraphs. Shorter wins.\n' +
    '6. subjectLine: 2-5 words naming the VALUE TOPIC (e.g., "Growth Ops at ' + (context.organization || 'Company') + '", "GTM for Series B"). NEVER include "Job Application" or "Application" — that prefix is added automatically.\n' +
    '7. CTA: Direct role-fit ask — a 15-min conversation to explore Strategy/Ops/Growth/GTM roles. Do NOT ask for a job offer directly. The CTA text MUST appear ONLY in the "cta" JSON field — NEVER repeat it inside bodyParagraphs or psLine. Each JSON field (bodyParagraphs, cta, psLine) must contain UNIQUE content; no sentence should appear in more than one field.\n' +
    '8. psLine: A short, PROFESSIONAL post-script that STAYS ON-TOPIC with this job application. STRICT rules:\n' +
    '   (a) LENGTH: 12-28 words, ONE sentence (rarely two short ones). Never a paragraph.\n' +
    '   (b) MUST be tethered to the email body: reference the SAME company, role area, product, function, or industry theme already discussed. If it could be pasted into a stranger\'s email unchanged, REWRITE it.\n' +
    '   (c) MUST use a DIFFERENT concrete signal than the opening hook — if opening used recent news/funding, P.S. uses a LinkedIn post / product detail / industry data point / shared operator insight about ' + (context.organization || 'their company') + ' or its space. If opening used a LinkedIn post, P.S. uses a news item or metric.\n' +
    '   (d) TONE: peer-level, job-search aligned, curious/observational. NEVER sycophantic ("love your work", "huge fan"), NEVER personal-life ("hope you had a great weekend", "enjoy your evening", family, hobbies, vacations), NEVER generic pleasantries ("looking forward to hearing back", "have a great day"), NEVER flattery of the lead as a person.\n' +
    '   (e) BANNED patterns: weather, weekend/holiday greetings, emojis, "just following up", "by the way I also", "p.s. I noticed you like", personal hobbies of the lead, anything that reads like a sales closer.\n' +
    '   (f) PURPOSE: reinforce role-fit credibility by surfacing ONE extra observation about the company/function/space that proves attention — not to pitch again, not to add small-talk.\n' +
    '   Good examples:\n' +
    '     - "Saw your post last week on unit economics in quick-commerce — the point on dark-store payback periods mirrors what we hit at Blinkit."\n' +
    '     - "Noticed ' + (context.organization || 'the team') + ' is hiring 3 growth roles in Bengaluru — happy to share the GTM playbook that worked for our Tier-2 expansion if useful."\n' +
    '   Bad examples (do NOT emit):\n' +
    '     - "Hope you had a great weekend!"\n' +
    '     - "Huge fan of your work, looking forward to connecting."\n' +
    '     - "P.S. I also love hiking, noticed from your profile."\n' +
    '9. DO NOT mention resume/CV/attached in body text (resume is auto-attached to the email)\n' +
    '10. Return ONLY the JSON object, no markdown, no code blocks\n' +
    '11. If RESUME-TO-ORG BRIDGES are provided above, prefer them for the bridge paragraph — they are pre-validated\n' +
    '12. Prioritize RECENT information (last 90 days) over generic company description in the opening\n' +
    '13. The subject prefix "Job Application:" will be added — make the body own the job-application intent with honest, peer-level language, NOT apologetic or sales-pitch framing\n';

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

    // Handle new structured format
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

// ─── QUICK VALIDATION ─────────────────────────────────────

/**
 * Validates email for spam, banned openers, attachment mentions, and word counts.
 * @param {Object} parsed - Parsed composition response
 * @param {Object} lead - LeadProfile
 * @returns {Object} {issues: []}
 */
function _quickValidate(parsed, lead) {
  var issues = [];

  // Combine body text for scanning
  var bodyText = (parsed.bodyParagraphs || []).join(' ') + ' ' + (parsed.cta || '');
  var bodyLower = bodyText.toLowerCase();
  var subjLower = parsed.subjectLine.toLowerCase();

  // Check for attachment mentions in BODY (FATAL) — subject is fine since we add "Job Application:" prefix
  var attachmentKeywords = ['attached', 'attachment', 'please find', 'resume', 'cv', 'enclosed'];
  attachmentKeywords.forEach(function(kw) {
    if (bodyLower.indexOf(kw) >= 0) {
      issues.push('FATAL: Body mentions "' + kw + '" — resume is auto-attached, do not reference it in body');
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

  // You/Your vs I/My ratio check
  var iCount = (bodyText.match(/\bI\b/g) || []).length;
  var youCount = (bodyText.match(/\byou\b|\byour\b/gi) || []).length;
  if (iCount > 0 && youCount < iCount) {
    issues.push('Self-centered: ' + iCount + ' "I" vs ' + youCount + ' "you/your" — flip the ratio');
  }

  // Body word count check (50-120 words)
  var wordCount = bodyText.split(/\s+/).filter(function(w) { return w.length > 0; }).length;
  if (wordCount < 40) {
    issues.push('Email too short: ' + wordCount + ' words — aim for 50-120');
  }
  if (wordCount > 150) {
    issues.push('Email too long: ' + wordCount + ' words — aim for 50-120');
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

  // 1. Banner image
  if (html.indexOf('cid:emailBanner') < 0) {
    issues.push('STRUCT: Banner image reference missing — check _buildHtmlEmail');
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
  if (wordCount > 200) {
    issues.push('STRUCT: Visible text too dense (' + wordCount + ' words) — trim for cold email brevity');
  }

  return {
    passed: issues.length === 0,
    issues: issues
  };
}

// ─── API INTEGRATION ──────────────────────────────────────
// Note: callClaude is defined in ApiClients.gs
