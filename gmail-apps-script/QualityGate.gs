/**
 * ════════════════════════════════════════════════════════════════════════════
 * QualityGate.gs — Email Quality Validation & Cold Email Deliverability (2026)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Comprehensive quality checks for cold emails covering:
 * - Anti-pattern detection (spam triggers, phishing indicators)
 * - Spam trigger word scanning (Gmail 2026 filters)
 * - Email length optimization (50-125 word sweet spot for job-seeking)
 * - Link-to-text ratio and phishing detection
 * - Personalization depth (you/your vs I/my ratio)
 * - Tone and structure analysis
 * - Overall deliverability score
 *
 * Updated for 2026 cold email best practices, job-seeking context, and Gmail spam filter behavior.
 */

/**
 * Main quality gate function - runs all checks and returns pass/fail decision.
 * @param {string} subjectLine - Email subject line
 * @param {string} emailBody - Email body
 * @param {Object} lead - Lead object with fullName, email, etc.
 * @param {Object} classification - Classification result with archetype, template, etc.
 * @returns {Object} { passed: boolean, score: number (0-1), feedback: string, details: Object }
 */
function runQualityGate(subjectLine, emailBody, lead, classification) {
  if (!subjectLine || !emailBody) {
    return { passed: false, score: 0, feedback: 'Missing subject or body', details: {} };
  }

  var checks = {};
  var deductions = 0;
  var warnings = [];
  var optimizations = [];

  // ─── Stage 1: Anti-Pattern Detection ──────────────────────────────────────
  checks.antiPatterns = _runAntiPatternScan(subjectLine, emailBody);
  if (!checks.antiPatterns.passed) {
    deductions += checks.antiPatterns.severity; // 0.15 or 0.25 for high severity
    if (checks.antiPatterns.severity > 0.15) {
      warnings.push('Anti-pattern detected: ' + checks.antiPatterns.details);
    }
  }

  // ─── Stage 2: Spam Trigger Word Scanning (2026) ──────────────────────────
  checks.spamTriggers = _scanSpamTriggers(subjectLine, emailBody);
  if (checks.spamTriggers.triggered) {
    // Deduct based on risk level: HIGH = 0.2, MEDIUM = 0.1, LOW = 0.05
    var spamDeduction = checks.spamTriggers.riskLevel === 'HIGH' ? 0.2 :
                        checks.spamTriggers.riskLevel === 'MEDIUM' ? 0.1 : 0.05;
    deductions += spamDeduction;

    var spamMsg = 'Spam trigger words (' + checks.spamTriggers.riskLevel + '): ' +
      checks.spamTriggers.words.slice(0, 3).join(', ');
    if (checks.spamTriggers.riskLevel === 'HIGH') {
      warnings.push(spamMsg);
    } else {
      optimizations.push(spamMsg + ' (consider removing for better deliverability)');
    }

    logPipelineEvent(lead.rowNum, 'QUALITY',
      'Spam triggers detected (' + checks.spamTriggers.riskLevel + '): ' + checks.spamTriggers.words.join(', '),
      checks.spamTriggers.riskLevel === 'HIGH' ? 'WARN' : 'INFO');
  }

  // ─── Stage 3: Email Length Optimization (BULLET_V1: 80-220 sweet spot) ────
  // The 2026 reference-format restructure raises the cap because bullet lists
  // mirror the candidate's two best-performing emails (Kapture / MAS) which
  // both run 150-200 words. Sub-80 words now indicates an empty bullet list.
  var maxLen = (typeof CONFIG !== 'undefined' && CONFIG.EMAIL_FORMAT && CONFIG.EMAIL_FORMAT.bodyWordCountMax) || 220;
  var minLen = (typeof QUALITY_GATES !== 'undefined' && QUALITY_GATES.minLengthWords) || 80;
  checks.length = _analyzeEmailLength(emailBody);
  if (checks.length.wordCount > maxLen) {
    // Soft deduction for going over the bullet-format cap
    deductions += 0.05;
    optimizations.push(
      '[OPTIMIZATION] Email is ' + checks.length.wordCount + ' words (cap: ' + maxLen + '). ' +
      'Trim a bullet body or skip the motivation paragraph for tighter delivery.'
    );
  }
  if (checks.length.wordCount > maxLen + 60) {
    // Hard penalty for blowing past the cap by a lot
    deductions += 0.10;
    warnings.push('Email is ' + checks.length.wordCount + ' words — significantly over cap. Trim hard.');
  }
  if (checks.length.wordCount < minLen) {
    warnings.push('Email is too short (' + checks.length.wordCount + ' words) — bullet list likely empty or too sparse');
    deductions += 0.1;
  }

  // ─── Stage 4: Link-to-Text Ratio & Phishing Detection ──────────────────────
  checks.links = _analyzeLinks(subjectLine, emailBody);
  if (checks.links.phishingRisk > 0) {
    deductions += checks.links.phishingRisk;
    warnings.push('Link mismatch detected - ensure link text matches destination domain');
  }
  if (checks.links.tooManyLinks) {
    deductions += 0.1;
    warnings.push('Too many links (' + checks.links.count + ') - limit to 1-2 for cold email');
  }

  // ─── Stage 5: Personalization Ratio (you/your vs I/my) ──────────────────────
  checks.personalization = _analyzePersonalizationRatio(emailBody);
  var personalScore = checks.personalization.score;

  // Add feedback on personalization
  if (checks.personalization.score < 0.3 && checks.personalization.score >= 0) {
    optimizations.push(
      '[OPTIMIZATION] Personalization ratio is ' + (checks.personalization.ratio.toFixed(2)) + ':1 ' +
      '(you/I ratio). Focus more on recipient needs (increase "you/your" mentions).'
    );
  }

  // ─── Stage 6: Subject Line Quality ────────────────────────────────────────
  checks.subject = _analyzeSubject(subjectLine);
  if (!checks.subject.passed) {
    deductions += 0.1;
    warnings.push('Subject line issue: ' + checks.subject.feedback);
  }

  // ─── Stage 7: Tone & Structure ───────────────────────────────────────────
  checks.tone = _analyzeTone(emailBody);
  if (checks.tone.hasSuspiciousTone) {
    deductions += 0.15;
    warnings.push('Tone detection: ' + checks.tone.feedback);
  }

  // ─── Calculate Final Score ─────────────────────────────────────────────────
  var baseScore = 1.0;
  var finalScore = Math.max(0, baseScore - deductions);
  finalScore = Math.min(1.0, finalScore); // Cap at 1.0

  // Determine pass/fail: 0.75+ passes, but HIGH spam triggers always fail
  var passed = finalScore >= 0.75 && checks.spamTriggers.riskLevel !== 'HIGH';

  // Generate comprehensive feedback
  var feedback = _generateFeedback(
    passed, finalScore, warnings, optimizations,
    checks.spamTriggers, checks.length, checks.personalization, checks.links
  );

  return {
    passed: passed,
    score: finalScore,
    feedback: feedback,
    details: {
      antiPatterns: checks.antiPatterns,
      spamTriggers: checks.spamTriggers,
      length: checks.length,
      links: checks.links,
      personalization: checks.personalization,
      subject: checks.subject,
      tone: checks.tone
    }
  };
}

/**
 * ─── ANTI-PATTERN DETECTION ─────────────────────────────────────────────────
 *
 * Detects common email anti-patterns that reduce deliverability and engagement.
 */
function _runAntiPatternScan(subjectLine, emailBody) {
  var antiPatterns = {
    // [Pattern, Severity (0.15 or 0.25 for HIGH), Description]
    // NOTE: 'html-tags' removed — emails now intentionally use HTML formatting
    'all-caps': { regex: /^[A-Z\s\.,!?]{20,}$/gm, severity: 0.15, desc: 'All caps text block' },
    'excessive-punctuation': { regex: /[!]{3,}|[\?]{3,}/g, severity: 0.15, desc: 'Excessive punctuation (!!!!)' },
    'multiple-links-same-line': { regex: /https?.*https?/gm, severity: 0.2, desc: 'Multiple links on one line' },
    'unsubscribe-in-subject': { regex: /unsubscribe/i, severity: 0.2, desc: 'Unsubscribe in subject line' },
    'hope-this-email-finds-you': { regex: /I hope this (email|message) finds you|I hope you are doing well|hope this finds you well/i, severity: 0.15, desc: 'Banned opener per playbook (dead list)' },
    'my-name-is': { regex: /^My name is/i, severity: 0.15, desc: 'Banned opener per playbook (dead list)' },
    'reaching-out-because': { regex: /I\'m reaching out because|I am reaching out because/i, severity: 0.15, desc: 'Banned opener per playbook (dead list)' },
    'wanted-to-reach-out': { regex: /I wanted to reach out|I wanted to connect/i, severity: 0.15, desc: 'Banned opener per playbook (dead list)' },
    'saw-your-profile': { regex: /I (saw|came across) your profile/i, severity: 0.15, desc: 'Banned opener per playbook (dead list)' },
    'sorry-to-bother': { regex: /sorry to bother you/i, severity: 0.15, desc: 'Banned opener per playbook (dead list)' },
    'know-youre-busy': { regex: /I know you(\'re| are) busy/i, severity: 0.15, desc: 'Banned opener per playbook (dead list)' },
    'just-following-up-first-touch': { regex: /^Just following up/i, severity: 0.15, desc: 'Banned opener per playbook (dead list)' }
  };

  var fullText = subjectLine + '\n' + emailBody;
  var triggered = [];
  var highestSeverity = 0;

  for (var pattern in antiPatterns) {
    var check = antiPatterns[pattern];
    if (check.regex.test(fullText)) {
      triggered.push(check.desc);
      highestSeverity = Math.max(highestSeverity, check.severity);
    }
  }

  return {
    passed: triggered.length === 0,
    triggered: triggered,
    severity: highestSeverity,
    details: triggered.length > 0 ? triggered[0] : null
  };
}

/**
 * ─── SPAM TRIGGER WORD SCANNER (2026) ──────────────────────────────────────
 *
 * Scans email for words/phrases known to trigger Gmail spam filters (2026 list).
 * Research shows Gmail's 2026 spam filters are highly sensitive to specific trigger words.
 *
 * @param {string} subject
 * @param {string} body
 * @returns {Object} { triggered: boolean, words: string[], riskLevel: string, count: number }
 */
function _scanSpamTriggers(subject, body) {
  var fullText = (subject + ' ' + body).toLowerCase();
  var triggered = [];

  // High-risk spam trigger words (2026 Gmail filter list)
  // These alone can cause emails to be flagged or rejected
  var highRisk = [
    'act now', 'limited time', 'urgent', 'buy now', 'free', 'winner',
    'congratulations', 'click here', 'subscribe', 'unsubscribe',
    'no obligation', 'risk free', 'guaranteed', 'double your',
    'earn money', 'make money', 'cash bonus', 'discount',
    'lowest price', 'special promotion', 'order now', 'don\'t delete',
    'apply now', 'dear friend', 'once in a lifetime', 'act immediately',
    'xxx rated', 'webcam', 'nigerian prince', 'viagra', 'cialis',
    'weight loss', 'work from home', 'financial freedom'
  ];

  // Medium-risk (contextual - okay in some cases, flagged in cold outreach)
  var mediumRisk = [
    'no cost', 'obligation', 'offer', 'deal', 'exclusive',
    'incredible', 'amazing', 'best price', 'bargain', 'bonus',
    'clearance', 'drastically', 'reduced', 'save big', 'limited offer'
  ];

  highRisk.forEach(function(word) {
    // Word boundary matching to avoid false positives
    var regex = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
    if (regex.test(fullText)) {
      triggered.push({ word: word, risk: 'high' });
    }
  });

  mediumRisk.forEach(function(word) {
    var regex = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
    if (regex.test(fullText)) {
      triggered.push({ word: word, risk: 'medium' });
    }
  });

  var highCount = triggered.filter(function(t) { return t.risk === 'high'; }).length;
  var riskLevel = highCount > 0 ? 'HIGH' : (triggered.length > 2 ? 'MEDIUM' : 'LOW');

  return {
    triggered: triggered.length > 0,
    words: triggered.map(function(t) { return t.word + ' (' + t.risk + ')'; }),
    riskLevel: riskLevel,
    count: triggered.length,
    highRiskCount: highCount,
    mediumRiskCount: triggered.filter(function(t) { return t.risk === 'medium'; }).length
  };
}

/**
 * ─── EMAIL LENGTH OPTIMIZATION (2026) ──────────────────────────────────────
 *
 * Analyzes email length. 2026 research shows optimal cold email length is 50-125 words.
 * Emails under 125 words see 15% higher reply rates than longer emails.
 *
 * NOTE: Properly strips HTML tags before counting words using regex /<[^>]*>/g
 * This works correctly for HTML-formatted emails.
 */
function _analyzeEmailLength(emailBody) {
  // Remove HTML tags, URLs, and extra whitespace
  var text = emailBody
    .replace(/<[^>]*>/g, '')  // Remove all HTML tags
    .replace(/https?:\/\/\S+/gi, '')  // Remove URLs
    .replace(/\s+/g, ' ')  // Collapse whitespace
    .trim();

  var words = text.split(/\s+/).filter(function(w) { return w.length > 0; });
  var wordCount = words.length;

  // BULLET_V1 reference-format ranges (2026)
  var optimal = wordCount >= 80 && wordCount <= 220;
  var tooShort = wordCount < 50;
  var tooLong = wordCount > 280;

  return {
    wordCount: wordCount,
    optimal: optimal,
    tooShort: tooShort,
    tooLong: tooLong,
    category: tooShort ? 'SHORT' : (optimal ? 'OPTIMAL' : (tooLong ? 'LONG' : 'ACCEPTABLE'))
  };
}

/**
 * ─── LINK ANALYSIS & PHISHING DETECTION ────────────────────────────────────
 *
 * Checks:
 * - Link count (should be 0-2 in cold email)
 * - Link text vs actual URL domain match (phishing indicator)
 * - Link safety (no shortened URLs for cold outreach)
 */
function _analyzeLinks(subjectLine, emailBody) {
  var linkRegex = /https?:\/\/([^\s<>]+)/gi;
  var linkTextRegex = /\[([^\]]+)\]\s*\(?(https?:\/\/[^\s<>)]+)\)?/gi;

  var links = [];
  var linkText = [];
  var match;

  // Extract URLs
  while ((match = linkRegex.exec(emailBody)) !== null) {
    links.push(match[1]);
  }

  // Extract link text + URL pairs
  linkTextRegex.lastIndex = 0;
  while ((match = linkTextRegex.exec(emailBody)) !== null) {
    linkText.push({ text: match[1], url: match[2] });
  }

  var tooManyLinks = links.length > 2;
  var phishingRisk = 0;
  var shortUrlDetected = false;

  // Check for phishing indicators: link text doesn't match URL domain
  linkText.forEach(function(lt) {
    var urlDomain = lt.url.replace(/^https?:\/\/(www\.)?([^\/]+).*/, '$2').toLowerCase();
    var textLower = lt.text.toLowerCase();

    // If link text looks like a URL but doesn't match domain, flag it
    if ((textLower.indexOf('http') >= 0 || textLower.indexOf('.') >= 0) && textLower.indexOf(urlDomain) < 0) {
      phishingRisk += 0.15;
    }
  });

  // Detect shortened URLs (bit.ly, tinyurl, etc.)
  links.forEach(function(link) {
    if (/bit\.ly|tinyurl|short\.link|ow\.ly|goo\.gl/i.test(link)) {
      shortUrlDetected = true;
    }
  });

  if (shortUrlDetected) {
    phishingRisk += 0.1; // Shortened URLs trigger spam filters in cold email
  }

  return {
    count: links.length,
    tooManyLinks: tooManyLinks,
    phishingRisk: Math.min(phishingRisk, 0.25), // Cap at 0.25
    shortUrlDetected: shortUrlDetected,
    links: links
  };
}

/**
 * ─── PERSONALIZATION RATIO ANALYSIS ────────────────────────────────────────
 *
 * Analyzes you/your vs I/my ratio. Cold emails should focus on the recipient (you).
 * Optimal ratio: 3:1 (3 "you" mentions per 1 "I" mention) or higher.
 */
function _analyzePersonalizationRatio(emailBody) {
  var text = emailBody.toLowerCase();

  // Count mentions (word boundaries)
  var youCount = (text.match(/\byou\b|\byour\b|\byours\b/g) || []).length;
  var iCount = (text.match(/\bi\b|\bmy\b|\bmine\b/g) || []).length;

  var ratio = iCount > 0 ? youCount / iCount : (youCount > 0 ? youCount : 1);
  var score = Math.min(1.0, ratio / 5.0); // Perfect score at 5:1 or higher

  // Flags
  var tooMuchI = iCount > youCount * 1.5;
  var enoughPersonalization = youCount >= 3;

  return {
    youCount: youCount,
    iCount: iCount,
    ratio: ratio,
    score: score,
    tooMuchI: tooMuchI,
    enoughPersonalization: enoughPersonalization,
    feedback: ratio >= 3 ? 'Good personalization focus' :
              ratio >= 1.5 ? 'Moderate personalization' :
              'Could focus more on recipient'
  };
}

/**
 * ─── SUBJECT LINE ANALYSIS ────────────────────────────────────────────────
 *
 * Checks subject line quality:
 * - Word count check: 2-7 words (flag if outside)
 * - Character count: under 40 chars ideal (warning if over 50)
 * - Job-seeking blacklist: "job inquiry", "seeking opportunities", "resume attached", etc.
 * - No all caps
 * - No excessive punctuation
 * - No spam trigger words
 */
function _analyzeSubject(subjectLine) {
  var issues = [];

  // Strip the canonical "Job Application: ... | Gaurav Rathore" wrapper so we only
  // analyze the TOPIC portion Claude produced. This avoids false positives on the
  // deliberate "Job Application" prefix and the " | Gaurav Rathore" signature.
  var topic = subjectLine
    .replace(/^\s*job\s*application\s*:\s*/i, '')
    .replace(/\s*\|\s*gaurav\s+rathore\s*$/i, '')
    .trim();

  // Word count check on TOPIC: 2-7 words (prefix + name excluded)
  var words = topic.split(/\s+/).filter(function(w) { return w.length > 0; }).length;
  if (words < 2 || words > 7) {
    issues.push('Subject topic should be 2-7 words (currently ' + words + '): "' + topic + '"');
  }

  // Character count on FULL subject (Gmail mobile preview truncates ~78 chars,
  // but we allow up to 95 since the prefix + signature are non-negotiable branding)
  if (subjectLine.length > 95) {
    issues.push('Subject too long (' + subjectLine.length + ' chars) - keep under 95');
  }

  // Job-seeking blacklist — applied ONLY to the topic (prefix is allowed by design)
  var jobBlacklist = [
    'job inquiry', 'seeking opportunities', 'resume attached', 'career discussion',
    'looking for work', 'open to roles', 'please hire', 'hire me'
  ];
  var topicLower = topic.toLowerCase();
  for (var i = 0; i < jobBlacklist.length; i++) {
    if (topicLower.indexOf(jobBlacklist[i]) >= 0) {
      issues.push('Subject topic contains blacklisted phrase: "' + jobBlacklist[i] + '"');
      break;
    }
  }

  if (/^[A-Z\s\.,!?]{15,}$/.test(subjectLine)) {
    issues.push('Subject is all caps - reduce caps for better deliverability');
  }

  if (/[!]{2,}|\?{2,}/.test(subjectLine)) {
    issues.push('Excessive punctuation in subject');
  }

  // Check for subject-level spam triggers
  var spamInSubject = /free|buy now|urgent|limited time|act now/i.test(subjectLine);
  if (spamInSubject) {
    issues.push('Subject contains spam trigger words');
  }

  return {
    passed: issues.length === 0,
    feedback: issues.length > 0 ? issues[0] : 'Subject line looks good',
    allIssues: issues
  };
}

/**
 * ─── TONE & STRUCTURE ANALYSIS ────────────────────────────────────────────
 *
 * Detects suspicious tone that might indicate:
 * - Scam patterns
 * - Generic mass email
 * - Overly aggressive sales pitch
 * - Job-seeking anti-patterns (begging, overly formal, direct asking)
 */
function _analyzeTone(emailBody) {
  var text = emailBody.toLowerCase();
  var suspiciousIndicators = 0;

  // Check for job-seeking anti-patterns: begging tone
  // Phrases like "I would be grateful for any opportunity", "please consider me", "I humbly request"
  var beggingPatterns = /I would be grateful for any opportunity|I would be grateful|I humbly request|please consider me|any opportunity to|grateful for the/i;
  if (beggingPatterns.test(emailBody)) {
    suspiciousIndicators += 1;
  }

  // Check for overly formal job-seeking tone
  var overformalPatterns = /I hope this email finds you well|Dear Sir\/Madam|To Whom It May Concern/i;
  if (overformalPatterns.test(emailBody)) {
    suspiciousIndicators += 1;
  }

  // Check for direct job-asking patterns
  var directJobPatterns = /hire me|give me a chance|I need a job|looking for opportunities/i;
  if (directJobPatterns.test(emailBody)) {
    suspiciousIndicators += 1;
  }

  // Check for generic greetings (mass email indicator)
  if (/dear (sir|madam|friend|valued customer)/i.test(emailBody)) {
    suspiciousIndicators += 1;
  }

  // Check for urgency overload
  var urgencyWords = (text.match(/urgent|act now|immediate|asap|today|limited|before/gi) || []).length;
  if (urgencyWords > 2) {
    suspiciousIndicators += 1;
  }

  // Check for money-grab language
  if (/guarantee.*money|earn.*fast|limited.*offer.*today/i.test(emailBody)) {
    suspiciousIndicators += 1;
  }

  // Check for lack of specificity (generic template)
  var emailHasMentionOfRecipient = /their|your company|your work|your expertise/i.test(emailBody);
  if (!emailHasMentionOfRecipient) {
    suspiciousIndicators += 1;
  }

  var hasSuspiciousTone = suspiciousIndicators >= 2;

  return {
    hasSuspiciousTone: hasSuspiciousTone,
    suspiciousIndicators: suspiciousIndicators,
    feedback: hasSuspiciousTone ?
      'Tone detected as potentially suspicious - increase personalization and specificity' :
      'Tone appears professional and personalized'
  };
}

/**
 * ─── QUALITY FEEDBACK GENERATION ─────────────────────────────────────────
 *
 * Generates human-readable feedback for quality gate results.
 */
function _generateFeedback(passed, score, warnings, optimizations, spamCheck, lengthCheck, personalization, links) {
  var feedback = [];

  // Header
  if (passed) {
    feedback.push('PASSED - Email passes quality gate');
  } else {
    feedback.push('FAILED - Email needs revision');
  }

  feedback.push('Score: ' + (score * 100).toFixed(0) + '/100');
  feedback.push('');

  // Warnings (must fix for pass)
  if (warnings.length > 0) {
    feedback.push('WARNINGS (fix these):');
    warnings.forEach(function(w) {
      feedback.push('  - ' + w);
    });
    feedback.push('');
  }

  // Optimizations (nice to have)
  if (optimizations.length > 0) {
    feedback.push('OPTIMIZATIONS (recommended):');
    optimizations.forEach(function(o) {
      feedback.push('  - ' + o);
    });
    feedback.push('');
  }

  // Spam check summary
  if (spamCheck.triggered) {
    feedback.push('Spam Check: ' + spamCheck.count + ' trigger word(s) found (' + spamCheck.riskLevel + ' risk)');
  }

  // Length summary
  feedback.push('Length: ' + lengthCheck.wordCount + ' words (' + lengthCheck.category + ')');

  // Personalization summary
  if (personalization.ratio < 1.5) {
    feedback.push('Personalization: Consider adding more recipient-focused language (you/your mentions)');
  }

  // Links summary
  if (links.count > 0) {
    feedback.push('Links: ' + links.count + ' found' + (links.tooManyLinks ? ' (too many for cold email)' : ''));
  }

  return feedback.join('\n');
}

// ─── RECOMPOSITION (called by BatchProcessor when quality gate fails) ───────

/**
 * Attempts to fix a failed email by asking Claude to revise it based on quality feedback.
 * Called by BatchProcessor._processOneLead when the quality gate fails, and again
 * when MasterValidator verdicts RECOMPOSE.
 *
 * PATCH 2026-06-12-recomp-bullets: the revision contract is now the unified
 * BULLET_V1 shape (greeting / hook / 3 metric-led experience bullets / closing
 * logistics / PS-last) instead of the legacy prose shape. Flow mirrors the
 * primary compose path: _parseCompositionResponse (canonical parse + field
 * injection) -> _normalizeParsedFields -> _quickValidate (any FATAL, including
 * the <2-bullets-non-CXO ship-gate, FORFEITS) -> _buildHtmlEmail (bullet
 * renderer). A forfeit returns null, which makes the recomposition lose both
 * score comparisons in BatchProcessor, so the original ships instead of a
 * prose-shaped draft. (This JSDoc sits outside Function.toString() — the
 * pinned introspection test anchors live in the function body only.)
 *
 * @param {string} originalBody - The email body that failed quality gate
 * @param {string} originalSubject - The subject line that failed
 * @param {string} feedback - Quality gate feedback explaining what failed
 * @param {Object} lead - Lead object with fullName, email, designation, etc.
 * @returns {Object|null} { subjectLine, emailBody } on success, null on failure/forfeit
 */
function attemptRecomposition(originalBody, originalSubject, feedback, lead) {
  try {
    var prompt = 'You are revising a cold outreach email that failed quality checks.\n\n' +
      'RECIPIENT: ' + lead.fullName + ' (' + (lead.designation || '') + ' at ' + (lead.organization || '') + ')\n\n' +
      'ORIGINAL SUBJECT: ' + originalSubject + '\n\n' +
      'ORIGINAL EMAIL:\n' + originalBody + '\n\n' +
      'QUALITY FEEDBACK (issues to fix):\n' + feedback + '\n\n' +
      'COLD EMAIL PLAYBOOK RULES:\n' +
      '- This is a job-seeking cold email, NOT sales outreach\n' +
      '- 2-5 word subject line; body roughly 100-150 words across hook, bullets, and closing\n' +
      '- Never ask for a job directly — ask for a conversation\n' +
      '- Include a P.S. line as a second hook\n' +
      '- No banned openers: "I hope this email finds you well", "My name is", "I\'m reaching out because", "I wanted to reach out"\n\n' +
      'INSTRUCTIONS:\n' +
      '- Fix ALL issues mentioned in the feedback\n' +
      '- Keep the same general message and personalization hooks\n' +
      '- Maintain a professional, human tone\n' +
      '- Do NOT use spam trigger words (free, guaranteed, act now, etc.)\n' +
      '- Focus on the recipient (more "you/your" than "I/my")\n' +
      '- The revised email MUST follow the unified bullet architecture: greeting, hook, EXACTLY 3 metric-led experience bullets, closing logistics with the 15-minute ask, P.S. last\n' +
      '- NEVER collapse the three experience bullets into prose paragraphs\n' +
      '- hookParagraph must NOT start with a greeting; the greeting lives only in the greeting field\n\n' +
      'Return ONLY valid JSON with the following format:\n' +
      '{\n' +
      '  "subjectLine": "2-5 word topic only",\n' +
      '  "greeting": "Hi [FirstName],",\n' +
      '  "hookParagraph": "1-2 sentences tying the recipient\'s org and role to Gaurav\'s background. Under 60 words.",\n' +
      '  "bridgeSentence": "Three 0-to-1 builds that map directly to this role:",\n' +
      '  "experienceBullets": [\n' +
      '    {"label": "Blinkit Bistro (current)", "body": "<metric-led outcome, 18 words or fewer>", "showLorTag": false},\n' +
      '    {"label": "upGrad (2021-23)", "body": "<metric-led outcome, 18 words or fewer>", "showLorTag": false},\n' +
      '    {"label": "Great Learning (2019-20)", "body": "<metric-led outcome, 18 words or fewer>", "showLorTag": false}\n' +
      '  ],\n' +
      '  "showAiToolsBlock": true,\n' +
      '  "motivationParagraph": "The thread across all three: <one-line pattern>",\n' +
      '  "closingLogistics": "Based in Gurgaon and available to start immediately. Would value 15 minutes to discuss how this maps to what your team is building.",\n' +
      '  "signoffText": "Thanks and regards",\n' +
      '  "psLine": "<second concrete signal, 12-28 words, tied to the org or its space>"\n' +
      '}\n\n' +
      'CRITICAL RULES FOR experienceBullets:\n' +
      '- EXACTLY 3 items, company labels EXACTLY as shown above, in that order\n' +
      '- Each body: action verb first, one quantified outcome, 18 words or fewer, never "I"\n' +
      '- Do NOT mention resume/attached/CV in hookParagraph or bullet bodies\n' +
      '- No em-dashes, no smart quotes, plain ASCII only';

    var response = callClaude(prompt, {
      temperature: 0.7,
      maxTokens: 1200
    });

    if (!response.success) {
      logPipelineEvent(lead.rowNum, 'RECOMPOSE', 'Claude API call failed: ' + (response.error || 'unknown'), 'ERROR');
      return null;
    }

    var text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

    // PATCH 2026-06-12-recomp-bullets: the recomposition contract is now the
    // unified bullet shape. Previously this function requested a prose JSON
    // shape, so a winning recomposition rendered through the legacy prose
    // path with no bullet structure - the last path that could ship a
    // non-standard draft (live example: dushyant.panda@razorpay.com /
    // "Growth Marketing Role"). The revised flow mirrors the primary compose
    // path exactly: canonical parse (with canonical-field injection) ->
    // normalize -> shape gate -> canonical render. On any gate failure the
    // recomposition FORFEITS (returns null) so the original email ships and
    // the score comparisons in BatchProcessor never see a prose candidate.
    var parsed = _parseCompositionResponse(text);
    if (!parsed || !parsed.subjectLine) {
      logPipelineEvent(lead.rowNum, 'RECOMPOSE', 'Failed to parse recomposition response via canonical parser', 'ERROR');
      return null;
    }

    // Same normalize-before-validate sequence as the primary compose path
    // (idempotent; the canonical parser already ran it for bullet shapes).
    try { _normalizeParsedFields(parsed); } catch (_normErr) {
      Logger.log('[RECOMPOSE] pre-validate normalize skipped: ' + _normErr.message);
    }

    // Shape gate - the identical validator the primary compose path uses.
    // Its bullet-count ship-gate (<2 bullets on a non-CXO shape) is the
    // specific check this patch exists to enforce on recompositions.
    var validation;
    try {
      validation = _quickValidate(parsed, lead);
    } catch (_valErr) {
      logPipelineEvent(lead.rowNum, 'RECOMPOSE', 'Shape gate threw (' + _valErr.message + ') - recomposition forfeits', 'ERROR');
      return null;
    }
    var fatalIssues = (validation && validation.issues ? validation.issues : []).filter(function(i) {
      return i.indexOf('FATAL') >= 0;
    });
    if (fatalIssues.length > 0) {
      logPipelineEvent(lead.rowNum, 'RECOMPOSE',
        'Recomposition failed shape gate (' + fatalIssues.slice(0, 2).join('; ') + ') - forfeiting so the original ships', 'WARN');
      return null;
    }

    // Canonical render. With the bullet payload present this routes to the
    // unified bullet renderer (banner + bullets + builder block + Calendly
    // CTA + PS-last). The old bare-paragraph fallback is gone on purpose:
    // a render failure forfeits the recomposition instead of shipping
    // unstyled prose.
    var emailBody;
    try {
      emailBody = _buildHtmlEmail(parsed, lead, null);
    } catch (renderErr) {
      logPipelineEvent(lead.rowNum, 'RECOMPOSE',
        'Canonical render failed (' + renderErr.message + ') - recomposition forfeits', 'ERROR');
      return null;
    }

    logPipelineEvent(lead.rowNum, 'RECOMPOSE', 'Successfully recomposed email (bullet contract, canonical renderer)', 'INFO');

    // PATCH 2026-06-12-template-unify: canonicalize the recomposed subject.
    // attemptRecomposition returns raw Claude subject (e.g. "Growth Marketing Role")
    // without the "Job Application: ... | Gaurav Rathore" canonical format.
    // Route through _buildSubjectLine (STANDARD path, isCxoShort=false) so the
    // subject guard (S5) and S4 positioning guard both fire, guaranteeing canonical
    // format regardless of what Claude returned in the recomposition response.
    // _buildSubjectLine lives in EmailComposer.gs — always in scope in GAS.
    var _recompRawSubject = (parsed.subjectLine || '').toString().trim();
    var _recompFinalSubject = _recompRawSubject;
    if (typeof _buildSubjectLine === 'function') {
      try {
        _recompFinalSubject = _buildSubjectLine(_recompRawSubject, lead, {}, false);
      } catch (_recompSubjErr) {
        Logger.log('[RECOMPOSE] _buildSubjectLine threw on recomp subject — using raw: ' + _recompSubjErr.message);
      }
    }

    return {
      subjectLine: _recompFinalSubject,
      emailBody: emailBody
    };

  } catch (e) {
    logPipelineEvent(lead.rowNum, 'RECOMPOSE', 'Recomposition error: ' + e.message, 'ERROR');
    return null;
  }
}
