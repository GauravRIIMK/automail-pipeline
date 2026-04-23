/**
 * HUMANIZATION_RULES — shared lookup for all 3 humanization layers.
 * contractionMap: used by _applyContractions (fallback if not defined here)
 * patternReplacements: AI phrase → human phrase, applied in Layer 2
 */
var HUMANIZATION_RULES = {
  contractionMap: {
    'I am': "I'm", 'you are': "you're", 'it is': "it's",
    'we are': "we're", 'they are': "they're", 'he is': "he's", 'she is': "she's",
    'cannot': "can't", 'will not': "won't", 'do not': "don't",
    'does not': "doesn't", 'did not': "didn't", 'have not': "haven't",
    'has not': "hasn't", 'had not': "hadn't", 'should not': "shouldn't",
    'would not': "wouldn't", 'could not': "couldn't", 'is not': "isn't",
    'are not': "aren't", 'was not': "wasn't", 'were not': "weren't",
    'I would': "I'd", 'I will': "I'll", 'I have': "I've",
    'you will': "you'll", 'you have': "you've"
  },
  patternReplacements: {
    'I hope this (email|message) finds you well\\.?': '',
    'I am writing to express my interest': "I noticed",
    'I am (very |extremely )?interested in': "I'm curious about",
    'I believe I (would be|am) a (great|good|strong) (fit|candidate|match)': "my experience in [X] might be relevant",
    'please find (my |the )?attached resume': '',
    'I would love the opportunity to': "I'd enjoy",
    'Thank you for your time and consideration': "Thanks for reading this far",
    'Looking forward to hearing from you': '',
    'I am writing to inform you': "I wanted to share",
    'I am writing to': "I noticed",
    'please feel free to': 'feel free to',
    'do not hesitate to (contact|reach out to) me': "reach out anytime",
    'at your earliest convenience': 'when you get a chance',
    'I would like to': "I'd like to",
    'I am pleased to': "I'm excited to",
    'as per our (previous |last )?conversation': 'following up on our chat',
    'I wanted to (take a moment|reach out) and': 'I wanted to',
    'Best regards,': 'Best,',
    'Kind regards,': 'Best,',
    'Warm regards,': 'Best,',
    'Sincerely,': 'Best,'
  }
};

/**
 * Humanizer.gs - 3-Layer Email Humanization Engine
 *
 * Transforms AI-generated emails to sound naturally human:
 * Layer 1: Structural Variation (sentence breaking, contractions, paragraphs)
 * Layer 2: Pattern Replacement (AI phrases → human phrasing)
 * Layer 3: Personalization Verification (name, company, metrics, anchors)
 */

/**
 * Main humanization function - applies all 3 layers
 * @param {string} emailBody - The email body to humanize
 * @param {string} subjectLine - The email subject line
 * @param {object} lead - Lead object with name, company, etc.
 * @param {object} dossier - Lead dossier with context/metrics
 * @returns {object} - {body, subject, score, timestamp}
 */
function humanizeEmail(emailBody, subjectLine, lead, dossier) {
  try {
    // Bug #3 fix: updateLeadStatus takes rowNum, not email
    updateLeadStatus(lead.rowNum, STATUS.HUMANIZING);
    // Bug #4 fix: logPipelineEvent signature is (rowNum, stage, message, level)
    logPipelineEvent(lead.rowNum, 'HUMANIZE', 'Starting humanization (body: ' + emailBody.length + ' chars)', 'INFO');

    // ── HTML Detection: Skip body transformations for HTML emails ──
    // EmailComposer now outputs professionally formatted HTML. Regex-based text
    // transformations (contractions, structural variation) would corrupt HTML tags.
    // Only humanize the subject line; pass HTML body through untouched.
    var isHtml = /<[a-z][\s\S]*>/i.test(emailBody);
    if (isHtml) {
      var humanizedSubject = _humanizeSubject(subjectLine);
      logPipelineEvent(lead.rowNum, 'HUMANIZE', 'HTML body detected — subject humanized, body passed through', 'SUCCESS');
      return {
        emailBody: emailBody,
        subjectLine: humanizedSubject,
        aiScore: 0.15,
        personalizationValid: true,
        timestamp: new Date().toISOString()
      };
    }

    // ── Plain text path (legacy fallback) ──

    // Layer 1: Structural Variation
    var humanizedBody = _applyStructuralVariation(emailBody);

    // Layer 2: Pattern Replacement
    humanizedBody = _applyPatternReplacement(humanizedBody);

    // Layer 3: Personalization Verification
    var personalizationCheck = _verifyPersonalization(humanizedBody, lead, dossier);
    if (!personalizationCheck.isValid) {
      // Bug #4 fix: correct logPipelineEvent signature
      logPipelineEvent(lead.rowNum, 'HUMANIZE', 'Personalization issues: ' + personalizationCheck.issues.join('; '), 'WARN');
    }

    // Humanize subject line (lighter touch)
    var humanizedSubject = _humanizeSubject(subjectLine);

    // Final cleanup
    var finalBody = _cleanupEmail(humanizedBody);

    // Score AI detection to measure humanization
    var aiScore = _scoreAIDetection(finalBody);

    // Bug #4 fix: correct logPipelineEvent signature
    logPipelineEvent(lead.rowNum, 'HUMANIZE', 'Complete (aiScore: ' + aiScore + ', personalizationValid: ' + personalizationCheck.isValid + ')', 'SUCCESS');

    // Bug #2 fix: Return {emailBody, subjectLine} to match BatchProcessor expectations
    return {
      emailBody: finalBody,
      subjectLine: humanizedSubject,
      aiScore: aiScore,
      personalizationValid: personalizationCheck.isValid,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    // Bug #4 fix: correct logPipelineEvent signature
    logPipelineEvent(lead.rowNum, 'HUMANIZE', 'Error: ' + error.message, 'ERROR');
    throw error;
  }
}

/**
 * Layer 1: Apply Structural Variation
 * Breaks up AI-like patterns through sentence breaking, contractions, paragraph structure
 */
function _applyStructuralVariation(text) {
  // Step 1: Split sentences
  var sentences = _splitSentences(text);

  // Step 2: Break long sentences
  sentences = sentences.map(function(sentence) {
    if (sentence.length > 25) {
      return _breakLongSentence(sentence);
    }
    return sentence;
  }).reduce(function(a, b) { return a.concat(b); }, []);

  // Step 3: Apply contractions (~40% rate)
  var withContractions = _applyContractions(sentences.join(' '));

  // Step 4: Ensure paragraph breaks
  var withParagraphs = _ensureParagraphBreaks(withContractions);

  return withParagraphs;
}

/**
 * Split text on sentence boundaries
 * Handles: . ! ? followed by space
 */
function _splitSentences(text) {
  // Match sentence ending punctuation followed by space and capital letter
  var sentencePattern = /([.!?])\s+(?=[A-Z])/g;

  var sentences = text.split(sentencePattern);

  // Reconstruct sentences with their punctuation
  var result = [];
  for (var i = 0; i < sentences.length; i += 2) {
    if (sentences[i]) {
      var sentence = sentences[i].trim() + (sentences[i + 1] || '.');
      if (sentence.trim().length > 0) {
        result.push(sentence.trim());
      }
    }
  }

  return result.length > 0 ? result : [text];
}

/**
 * Break sentences longer than 25 words
 * Strategy: Find natural breaking points (conjunctions, commas)
 */
function _breakLongSentence(sentence) {
  var words = sentence.split(/\s+/);

  if (words.length <= 25) {
    return sentence;
  }

  // Find comma positions for breaking
  var commaPattern = /,/g;
  var commaMatches = [];
  var match;
  while ((match = commaPattern.exec(sentence)) !== null) {
    commaMatches.push(match.index);
  }

  var broken = [];
  var currentChunk = '';
  var currentWordCount = 0;

  for (var i = 0; i < words.length; i++) {
    currentChunk += (currentChunk ? ' ' : '') + words[i];
    currentWordCount++;

    // Break if we hit ~15 words or find a natural break
    if (currentWordCount >= 15 && (words[i].indexOf(',') >= 0 || i === words.length - 1)) {
      broken.push(currentChunk.trim());
      currentChunk = '';
      currentWordCount = 0;
    }
  }

  if (currentChunk.trim()) {
    broken.push(currentChunk.trim());
  }

  return broken;
}

/**
 * Apply contractions at ~40% rate
 * Makes text sound more natural and less formal
 */
function _applyContractions(text) {
  var contractionRules = HUMANIZATION_RULES.contractionMap || {
    'I am': "I'm",
    'you are': "you're",
    'he is': "he's",
    'she is': "she's",
    'it is': "it's",
    'we are': "we're",
    'they are': "they're",
    'cannot': "can't",
    'will not': "won't",
    'do not': "don't",
    'does not': "doesn't",
    'did not': "didn't",
    'have not': "haven't",
    'has not': "hasn't",
    'had not': "hadn't",
    'should not': "shouldn't",
    'would not': "wouldn't",
    'could not': "couldn't",
    'is not': "isn't",
    'are not': "aren't",
    'was not': "wasn't",
    'were not': "weren't"
  };

  var result = text;

  for (var original in contractionRules) {
    var contraction = contractionRules[original];
    // Apply with 40% random probability
    if (Math.random() < 0.4) {
      var regex = new RegExp('\\b' + _escapeRegex(original) + '\\b', 'gi');
      result = result.replace(regex, function(match) {
        // Preserve original case for first character
        if (match[0] === match[0].toUpperCase()) {
          return contraction.charAt(0).toUpperCase() + contraction.slice(1);
        }
        return contraction;
      });
    }
  }

  return result;
}

/**
 * Ensure text has 2-4 paragraph breaks
 * Splits long text into natural paragraphs
 */
function _ensureParagraphBreaks(text) {
  // Remove existing excessive breaks
  var cleaned = text.replace(/\n{3,}/g, '\n\n');

  // If no paragraph breaks, add them
  if (cleaned.indexOf('\n\n') < 0) {
    var sentences = _splitSentences(cleaned);

    if (sentences.length <= 4) {
      return cleaned; // Too short to break into paragraphs
    }

    // Target 2-4 paragraphs
    var targetParagraphs = Math.max(2, Math.min(4, Math.ceil(sentences.length / 5)));
    var sentencesPerPara = Math.ceil(sentences.length / targetParagraphs);

    var paragraphs = [];
    for (var i = 0; i < sentences.length; i += sentencesPerPara) {
      var chunk = sentences.slice(i, i + sentencesPerPara).join(' ');
      paragraphs.push(chunk);
    }

    return paragraphs.join('\n\n');
  }

  return cleaned;
}

/**
 * Layer 2: Apply Pattern Replacement
 * Replace AI-like phrases with human equivalents using HUMANIZATION_RULES
 */
function _applyPatternReplacement(text) {
  var patternReplacements = HUMANIZATION_RULES.patternReplacements || {};

  var result = text;

  for (var pattern in patternReplacements) {
    var replacement = patternReplacements[pattern];
    try {
      // Create regex with case-insensitive flag
      var regex = new RegExp(pattern, 'gi');
      result = result.replace(regex, replacement);
    } catch (e) {
      // Bug #4 fix: correct logPipelineEvent signature (rowNum, stage, message, level)
      logPipelineEvent(0, 'HUMANIZE', 'Pattern replacement error for "' + pattern + '": ' + e.message, 'WARN');
    }
  }

  return result;
}

/**
 * Helper: Escape special regex characters
 */
function _escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Layer 3: Personalization Verification
 * Checks that personalization is present and contextual
 */
function _verifyPersonalization(text, lead, dossier) {
  var issues = [];
  var isValid = true;

  // Check 1: Name should appear at least once
  // Bug #5 fix: LeadProfile uses fullName, not name
  var leadName = lead.fullName || lead.name || '';
  if (leadName.length > 0) {
    var firstName = leadName.split(' ')[0];
    if (text.indexOf(firstName) < 0 && text.indexOf(leadName) < 0) {
      issues.push('Name not found in email body');
    }
  }

  // Check 2: Company should appear if provided
  // Bug #5 fix: LeadProfile uses organization, not company
  var leadCompany = lead.organization || lead.company || '';
  if (leadCompany.length > 0) {
    if (text.indexOf(leadCompany) < 0) {
      issues.push('Company "' + leadCompany + '" not mentioned');
    }
  }

  // Check 3: Metrics/anchors should be present if in dossier
  if (dossier && dossier.metrics) {
    var metricKeys = [];
    for (var key in dossier.metrics) {
      metricKeys.push(key);
    }
    var metricsFound = 0;

    for (var i = 0; i < metricKeys.length; i++) {
      var key = metricKeys[i];
      var value = dossier.metrics[key];
      if (value && text.indexOf(String(value)) >= 0) {
        metricsFound++;
      }
    }

    // At least 1 metric should be referenced
    if (metricsFound === 0 && metricKeys.length > 0) {
      issues.push('No metrics from dossier referenced in email');
    }
  }

  // Check 4: Personalization anchors (specific references)
  if (dossier && dossier.anchors && dossier.anchors.length) {
    var anchorsFound = 0;
    for (var i = 0; i < dossier.anchors.length; i++) {
      var anchor = dossier.anchors[i];
      if (text.indexOf(anchor) >= 0) {
        anchorsFound++;
      }
    }

    if (anchorsFound === 0 && dossier.anchors.length > 0) {
      issues.push('No personalization anchors found');
    }
  }

  isValid = issues.length === 0;

  return {
    isValid: isValid,
    issues: issues,
    timestamp: new Date().toISOString()
  };
}

/**
 * Humanize subject line with lighter touch
 * Just removes obvious AI markers, keeps it concise
 */
function _humanizeSubject(subject) {
  var humanized = subject;

  // Remove common AI patterns (but preserve "Application:" prefix — intentional for job-seeking)
  var aiPatterns = [
    /^(RE:|FW:)\s*/i,
    /\[Important\]\s*/i,
    /\[Action Required\]\s*/i,
    /Your\s+personalized/i,
    /We wanted to reach out/i,
    /Exciting opportunity/i,
    /^(Job |Career )/i
  ];

  for (var i = 0; i < aiPatterns.length; i++) {
    humanized = humanized.replace(aiPatterns[i], '');
  }

  // Trim and ensure reasonable length
  humanized = humanized.trim();

  if (humanized.length > 85) {
    // Truncate intelligently at word boundary (allow up to 85 for "Application: ... — Gaurav Rathore")
    humanized = humanized.substring(0, 82).split(' ').slice(0, -1).join(' ') + '...';
  }

  return humanized;
}

/**
 * Score email for AI detection
 * Returns 0 (human) to 1 (AI)
 * Looks for: excessive formality, perfect grammar, corporate buzzwords, etc.
 */
function _scoreAIDetection(text) {
  var aiScore = 0;
  var signalCount = 0;

  // Signal 1: Corporate buzzwords
  var buzzwords = [
    'synergize',
    'leverage',
    'paradigm shift',
    'low-hanging fruit',
    'move the needle',
    'circle back',
    'touch base',
    'take it offline',
    'value add',
    'bandwidth',
    'drill down',
    'ping you',
    'at the end of the day',
    'per our conversation',
    'per my last email'
  ];

  for (var i = 0; i < buzzwords.length; i++) {
    var word = buzzwords[i];
    if (text.toLowerCase().indexOf(word) >= 0) {
      aiScore += 0.15;
      signalCount++;
    }
  }

  // Signal 2: No contractions (formal writing indicator)
  var contractionPattern = /\b(I'm|you're|he's|she's|it's|we're|they're|can't|won't|don't|doesn't|didn't|haven't|hasn't|hadn't|shouldn't|wouldn't|couldn't|isn't|aren't|wasn't|weren't)\b/gi;
  if (!contractionPattern.test(text)) {
    aiScore += 0.1;
    signalCount++;
  }

  // Signal 3: Perfect punctuation, no ellipses or dashes
  if (text.indexOf('...') < 0 && text.indexOf('—') < 0 && text.indexOf('--') < 0) {
    aiScore += 0.05;
  }

  // Signal 4: Excessive use of exclamation marks (overly enthusiastic)
  var exclamationCount = (text.match(/!/g) || []).length;
  if (exclamationCount > text.split('.').length * 0.3) {
    aiScore += 0.1;
    signalCount++;
  }

  // Signal 5: Very long, perfectly formed sentences
  var sentences = _splitSentences(text);
  var avgSentenceLength = 0;
  var sentenceParts = text.split(/[.!?]/);
  var totalWords = 0;
  for (var i = 0; i < sentenceParts.length; i++) {
    totalWords += sentenceParts[i].split(/\s+/).length;
  }
  avgSentenceLength = totalWords / Math.max(1, sentences.length);
  if (avgSentenceLength > 25) {
    aiScore += 0.1;
    signalCount++;
  }

  // Signal 6: Generic greetings
  var genericGreetings = ['Dear Sir or Madam', 'To Whom It May Concern', 'Hello there', 'Hi there'];
  for (var i = 0; i < genericGreetings.length; i++) {
    var greeting = genericGreetings[i];
    if (text.indexOf(greeting) >= 0) {
      aiScore += 0.2;
      signalCount++;
    }
  }

  // Signal 7: AI sign-off patterns
  var aiSignoffs = [
    'Best regards',
    'Warm regards',
    'Kind regards',
    'Looking forward to your response',
    'Thank you for your time'
  ];
  for (var i = 0; i < aiSignoffs.length; i++) {
    var signoff = aiSignoffs[i];
    if (text.toLowerCase().indexOf(signoff.toLowerCase()) >= 0) {
      aiScore += 0.1;
      signalCount++;
    }
  }

  // Normalize to 0-1 range
  aiScore = Math.min(1, aiScore);

  return Math.round(aiScore * 100) / 100;
}

/**
 * Final cleanup of email text
 * Removes formatting artifacts, normalizes spacing
 */
function _cleanupEmail(text) {
  var cleaned = text;

  // Remove multiple spaces
  cleaned = cleaned.replace(/\s{2,}/g, ' ');

  // Remove bullet points and replace with natural text
  cleaned = cleaned.replace(/^[\s]*[•\-\*]\s*/gm, '');

  // Remove excessive formatting
  cleaned = cleaned.replace(/_{2,}/g, '');
  cleaned = cleaned.replace(/\*{2,}([^*]+)\*{2,}/g, '$1');

  // Fix spacing around punctuation
  cleaned = cleaned.replace(/\s+([.!?,;:])/g, '$1');
  cleaned = cleaned.replace(/([.!?,;:])\s*([a-z])/g, '$1 $2');

  // Normalize line breaks
  cleaned = cleaned.replace(/\n{4,}/g, '\n\n\n');
  cleaned = cleaned.replace(/\n{2,}(?=\n)/g, '');

  // Remove leading/trailing whitespace
  cleaned = cleaned.trim();

  return cleaned;
}
