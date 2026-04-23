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

  // ─── Stage 3: Email Length Optimization (2026 optimal: 50-125 words) ────────
  checks.length = _analyzeEmailLength(emailBody);
  if (checks.length.wordCount > 125) {
    // Slight deduction for over 125 words
    deductions += 0.05;
    optimizations.push(
      '[OPTIMIZATION] Email is ' + checks.length.wordCount + ' words. ' +
      'Emails under 125 words see 15% higher reply rates.'
    );
  }
  if (checks.length.wordCount < 30) {
    warnings.push('Email is too short (' + checks.length.wordCount + ' words) - add more detail');
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

  var optimal = wordCount >= 50 && wordCount <= 125;
  var tooShort = wordCount < 30;
  var tooLong = wordCount > 150;

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
 * Called by BatchProcessor._processOneLead when quality gate fails.
 *
 * @param {string} originalBody - The email body that failed quality gate
 * @param {string} originalSubject - The subject line that failed
 * @param {string} feedback - Quality gate feedback explaining what failed
 * @param {Object} lead - Lead object with fullName, email, designation, etc.
 * @returns {Object|null} { subjectLine, emailBody } on success, null on failure
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
      '- Keep 50-125 words, 2-4 word subject line\n' +
      '- Never ask for a job directly — ask for a conversation\n' +
      '- Include a P.S. line as a second hook\n' +
      '- No banned openers: "I hope this email finds you well", "My name is", "I\'m reaching out because", "I wanted to reach out"\n\n' +
      'INSTRUCTIONS:\n' +
      '- Fix ALL issues mentioned in the feedback\n' +
      '- Keep the same general message and personalization hooks\n' +
      '- Keep under 125 words for optimal deliverability\n' +
      '- Maintain a professional, human tone\n' +
      '- Do NOT use spam trigger words (free, guaranteed, act now, etc.)\n' +
      '- Focus on the recipient (more "you/your" than "I/my")\n' +
      '- Email body is now HTML-formatted — use <p> tags to separate paragraphs\n\n' +
      'Return ONLY valid JSON with the following format:\n' +
      '{\n' +
      '  "subjectLine": "revised subject line",\n' +
      '  "bodyParagraphs": ["paragraph 1", "paragraph 2", "paragraph 3"],\n' +
      '  "cta": "call to action text",\n' +
      '  "psLine": "P.S. line"\n' +
      '}\n\n' +
      'CRITICAL: The CTA text must appear ONLY in the "cta" field — NEVER inside bodyParagraphs. ' +
      'Each field (bodyParagraphs, cta, psLine) must contain UNIQUE content; do not repeat the same sentence across fields.';

    var response = callClaude(prompt, {
      temperature: 0.7,
      maxTokens: 1000
    });

    if (!response.success) {
      logPipelineEvent(lead.rowNum, 'RECOMPOSE', 'Claude API call failed: ' + (response.error || 'unknown'), 'ERROR');
      return null;
    }

    // Parse the JSON response
    var text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

    // Extract JSON from potential markdown code blocks
    var jsonMatch = text.match(/\{[\s\S]*"subjectLine"[\s\S]*"bodyParagraphs"[\s\S]*\}/);
    if (!jsonMatch) {
      logPipelineEvent(lead.rowNum, 'RECOMPOSE', 'Failed to parse recomposition response', 'ERROR');
      return null;
    }

    var parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.subjectLine || !parsed.bodyParagraphs || !Array.isArray(parsed.bodyParagraphs)) {
      logPipelineEvent(lead.rowNum, 'RECOMPOSE', 'Recomposition missing subject, bodyParagraphs, or invalid format', 'ERROR');
      return null;
    }

    // Normalize + dedupe before reconstruction (defend against model re-emitting CTA in body).
    // Uses _dedupParsedComposition from EmailComposer.gs (shared helper).
    parsed.bodyParagraphs = parsed.bodyParagraphs.map(function(p) { return (p || '').toString().trim(); }).filter(function(p) { return p.length > 0; });
    parsed.cta = (parsed.cta || '').toString().trim();
    parsed.psLine = (parsed.psLine || '').toString().trim();
    if (typeof _dedupParsedComposition === 'function') {
      _dedupParsedComposition(parsed);
    }

    // Reconstruct HTML email from paragraphs, CTA, and P.S.
    var emailParts = [];
    parsed.bodyParagraphs.forEach(function(para) {
      emailParts.push('<p>' + para + '</p>');
    });
    if (parsed.cta) {
      emailParts.push('<p><strong>' + parsed.cta + '</strong></p>');
    }
    if (parsed.psLine) {
      emailParts.push('<p><strong>P.S.</strong> ' + parsed.psLine + '</p>');
    }
    var emailBody = emailParts.join('\n');

    logPipelineEvent(lead.rowNum, 'RECOMPOSE', 'Successfully recomposed email', 'INFO');
    return {
      subjectLine: parsed.subjectLine.trim(),
      emailBody: emailBody
    };

  } catch (e) {
    logPipelineEvent(lead.rowNum, 'RECOMPOSE', 'Recomposition error: ' + e.message, 'ERROR');
    return null;
  }
}
