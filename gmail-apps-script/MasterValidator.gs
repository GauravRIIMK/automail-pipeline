/**
 * ════════════════════════════════════════════════════════════════════════════
 * MasterValidator.gs — Comprehensive Post-Composition Validator (2026)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Runs AFTER humanization and the existing QualityGate, as the FINAL gate
 * before a Gmail draft is created. Complements QualityGate (spam/length/tone)
 * with dimensions QualityGate doesn't cover:
 *
 *   1. English sanity: double-spaces, repeated adjacent words, broken
 *      capitalization, mismatched punctuation, empty HTML paragraphs.
 *   2. Semantic coherence: flags paragraphs that don't advance the narrative
 *      (via LLM-as-judge critic pass, temperature=0).
 *   3. Factual recency: no dated facts from before 2026 framed as "recent",
 *      "latest", "just", "this month"; knowledge cutoff guardrail.
 *   4. Cold job-application framing: peer-level, no begging, no sales,
 *      honest intent, no attachment mentions, no placeholder leaks.
 *   5. Event grounding: any specific number/proper-noun in the opening hook
 *      must appear in the research dossier (no hallucinated metrics).
 *   6. Resume-to-job alignment: any metric Gaurav cites about his own work
 *      must match GAURAV_ACHIEVEMENT_BANK; institutions must match
 *      GAURAV_FACTS.alumniKeywords; no claims about companies he didn't work at.
 *   7. HTML formatting: banner, greeting, body paragraph count, bold CTA,
 *      signature block, P.S., no tag imbalances, no collapsed margins.
 *   8. Cross-field uniqueness: no duplicate sentences across
 *      body/CTA/PS (also enforced at parse time in EmailComposer).
 *
 * Architecture (jury-of-critics pattern inspired by Evidently AI's 2025 work):
 *   - Fast deterministic pass (regex + string matching) — runs always.
 *   - Single LLM critic pass — runs only if deterministic pass is clean.
 *   - Returns a unified verdict the BatchProcessor uses to decide
 *     {approve / recompose / block / send-to-review}.
 *
 * The validator is DEFENSIVE: any failure inside validation never blocks
 * the pipeline on its own — it returns a conservative verdict the caller
 * can choose to act on. All issues are logged via logPipelineEvent.
 */

// ─── PUBLIC ENTRY POINT ───────────────────────────────────────────────

/**
 * @param {string} subject - Final subject line (with "Job Application:" prefix)
 * @param {string} htmlBody - Final HTML email body
 * @param {Object} lead - LeadProfile
 * @param {Object} dossier - Research dossier
 * @param {Object} classification - Classification result
 * @param {Object} resumeSelection - {variantId, ...}
 * @param {Object} parsedComposition - Parsed composition {bodyParagraphs, cta, psLine, ...} (optional)
 * @returns {Object} verdict: {
 *   verdict: 'APPROVE' | 'RECOMPOSE' | 'REVIEW' | 'BLOCK',
 *   score: number (0..1),
 *   fatalIssues: string[],
 *   warnings: string[],
 *   rewriteNotes: string[],     // Specific instructions for recomposition
 *   dimensions: { english, coherence, recency, framing, grounding, structure, alignment } (0..10)
 * }
 */
function masterValidate(subject, htmlBody, lead, dossier, classification, resumeSelection, parsedComposition) {
  var fatalIssues = [];
  var warnings = [];
  var rewriteNotes = [];
  var scoreDeductions = 0;

  // Strip HTML tags ONCE for text-level checks
  var plainText = _stripHtml(htmlBody);
  var normalized = plainText.toLowerCase().replace(/\s+/g, ' ').trim();

  // ── Stage 1: Placeholder leak check (fatal, cheap) ─────────────────
  var placeholderIssues = _checkPlaceholderLeaks(subject, htmlBody);
  if (placeholderIssues.length > 0) {
    fatalIssues = fatalIssues.concat(placeholderIssues);
    scoreDeductions += 0.30;
    rewriteNotes.push('Replace all placeholder tokens ({...}, [...], TODO, Lorem) with real content.');
  }

  // ── Stage 2: English sanity check (warnings) ───────────────────────
  var englishIssues = _checkEnglishSanity(plainText);
  warnings = warnings.concat(englishIssues.map(function(i) { return 'English: ' + i; }));
  scoreDeductions += englishIssues.length * 0.03;
  if (englishIssues.length >= 2) {
    rewriteNotes.push('Clean up English issues: ' + englishIssues.slice(0, 3).join('; ') + '.');
  }

  // ── Stage 3: Factual recency (fatal for egregious stale-as-recent) ─
  var recencyIssues = _checkRecency(plainText);
  if (recencyIssues.length > 0) {
    fatalIssues = fatalIssues.concat(recencyIssues);
    scoreDeductions += 0.20;
    rewriteNotes.push('Remove dated claims from before 2026 framed as "recent" / "latest" / "just".');
  }

  // ── Stage 4: Cold job-application framing (fatal for begging/sales) ─
  // Pass parsedComposition so the attachment-mention check can exclude closingResume.
  var framingIssues = _checkColdJobFraming(plainText, normalized, parsedComposition);
  if (framingIssues.fatal.length > 0) {
    fatalIssues = fatalIssues.concat(framingIssues.fatal);
    scoreDeductions += 0.20;
    rewriteNotes.push('Rewrite with peer-level, honest job-application tone — no begging, no sales, no "please hire me" language.');
  }
  warnings = warnings.concat(framingIssues.warnings);

  // ── Stage 5: Event grounding — numbers/proper-nouns in hook ─────────
  // Scope ONLY to the hook paragraph when available (BULLET_V1 format puts
  // Gaurav's verified resume metrics in the experience bullets, which are
  // legitimately not in the lead's dossier — checking them as "ungrounded"
  // generates false positives).
  var hookZoneText = (parsedComposition && parsedComposition.hookParagraph)
    ? parsedComposition.hookParagraph
    : plainText;
  var groundingIssues = _checkEventGrounding(hookZoneText, dossier);
  if (groundingIssues.length > 0) {
    // Grounding failures are warnings (not fatal) because dossier may not have
    // every hook fact even when it's real — but we still flag.
    warnings = warnings.concat(groundingIssues.map(function(i) { return 'Grounding: ' + i; }));
    scoreDeductions += groundingIssues.length * 0.05;
    if (groundingIssues.length >= 2) {
      rewriteNotes.push('Remove unverifiable numbers/claims about ' + (lead.organization || 'the company') + ' that aren\'t in the research dossier.');
    }
  }

  // ── Stage 6: Resume-to-job alignment (fatal for fabricated Gaurav claims) ─
  var alignmentIssues = _checkResumeAlignment(plainText, normalized, resumeSelection);
  if (alignmentIssues.fatal.length > 0) {
    fatalIssues = fatalIssues.concat(alignmentIssues.fatal);
    scoreDeductions += 0.25;
    rewriteNotes.push('Replace fabricated Gaurav achievements with verified ones from his ' + (resumeSelection ? resumeSelection.variantId : '') + ' resume variant.');
  }
  warnings = warnings.concat(alignmentIssues.warnings);

  // ── Stage 7: HTML structure (fatal for broken structure) ────────────
  var structureIssues = _checkHtmlStructure(htmlBody, parsedComposition);
  if (structureIssues.fatal.length > 0) {
    fatalIssues = fatalIssues.concat(structureIssues.fatal);
    scoreDeductions += 0.15;
    rewriteNotes.push('Fix HTML structure: ' + structureIssues.fatal.slice(0, 2).join('; ') + '.');
  }
  warnings = warnings.concat(structureIssues.warnings);

  // ── Stage 8: Cross-field uniqueness (redundant belt-check) ─────────
  if (parsedComposition) {
    var dupIssues = _checkCrossFieldUniqueness(parsedComposition);
    if (dupIssues.length > 0) {
      fatalIssues = fatalIssues.concat(dupIssues);
      scoreDeductions += 0.15;
      rewriteNotes.push('Remove duplicate sentences across body/CTA/PS fields.');
    }
  }

  // ── Stage 9: LLM critic pass (only if deterministic is clean enough) ─
  //
  // PATCH 2026-05-13 (D7 latency): also skip critic when the deterministic
  // stages already produce a high score (scoreDeductions ≤ 0.10, meaning
  // ≥0.90 composite). The critic adds ~10s of Claude latency and is
  // most useful on borderline emails. For emails that already pass all
  // 8 deterministic gates cleanly, the critic almost always agrees and
  // saves a wasted round-trip. Borderline emails (score 0.75-0.90) still
  // get the critic. Logged for telemetry so we can audit decisions.
  var criticDimensions = null;
  var criticUsed = false;
  var deterministicScoreOk = (scoreDeductions <= 0.10);
  if (fatalIssues.length === 0 && !deterministicScoreOk) {
    try {
      criticDimensions = _invokeLlmCritic(subject, plainText, lead, dossier, classification, resumeSelection);
      criticUsed = !!criticDimensions;
      if (criticDimensions) {
        // Fold critic scores into deductions
        var avgCritic = _avgDimensions(criticDimensions);
        if (avgCritic < 6.0) {
          scoreDeductions += 0.20;
          fatalIssues.push('LLM critic rated composition below 6/10 (avg: ' + avgCritic.toFixed(1) + ')');
        } else if (avgCritic < 7.5) {
          scoreDeductions += 0.10;
          warnings.push('LLM critic rated composition ' + avgCritic.toFixed(1) + '/10 — acceptable but improvable');
        }
        // Append critic's rewrite notes if present
        if (criticDimensions.rewriteNotes && criticDimensions.rewriteNotes.length > 0) {
          rewriteNotes = rewriteNotes.concat(criticDimensions.rewriteNotes);
        }
      }
    } catch (criticErr) {
      Logger.log('[MasterValidator] LLM critic pass failed (non-blocking): ' + criticErr.message);
    }
  } else if (fatalIssues.length === 0 && deterministicScoreOk) {
    // Telemetry: critic skipped because deterministic stages were clean.
    // We expect to skip ~20% of emails this way.
    Logger.log('[MasterValidator] Critic SKIPPED (deterministic score ≥0.90, no fatal issues) — saved ~10s');
  }

  // ── Final score + verdict ──────────────────────────────────────────
  var score = Math.max(0, 1.0 - scoreDeductions);
  score = Math.min(1.0, score);

  var verdict;
  if (fatalIssues.length > 0 && score < 0.55) {
    verdict = 'RECOMPOSE';
  } else if (fatalIssues.length > 0) {
    verdict = 'REVIEW';
  } else if (score < 0.75) {
    verdict = 'REVIEW';
  } else {
    verdict = 'APPROVE';
  }

  // Block only on catastrophic failures (e.g., fabricated education, prohibited content)
  var hasCatastrophic = fatalIssues.some(function(i) {
    return i.indexOf('CATASTROPHIC') >= 0 || i.indexOf('BLOCK') >= 0;
  });
  if (hasCatastrophic) verdict = 'BLOCK';

  return {
    verdict: verdict,
    score: score,
    fatalIssues: fatalIssues,
    warnings: warnings,
    rewriteNotes: rewriteNotes,
    criticUsed: criticUsed,
    dimensions: criticDimensions,
    feedbackForRecompose: _buildRecomposeFeedback(fatalIssues, warnings, rewriteNotes)
  };
}

// ─── DETERMINISTIC CHECKS ─────────────────────────────────────────────

/**
 * Detects placeholder leaks: {company}, [name], TODO, Lorem ipsum, <FIRST_NAME>, etc.
 * Any of these indicates the template-fill step missed a slot.
 */
function _checkPlaceholderLeaks(subject, body) {
  var issues = [];
  var fullText = subject + ' ' + body;
  var patterns = [
    { re: /\{[a-zA-Z_][a-zA-Z0-9_]*\}/g, label: 'curly-brace placeholder' },
    { re: /\[(first_?name|name|company|org|role|designation|title)\]/gi, label: 'bracket placeholder' },
    { re: /<[A-Z_]{3,}>/g, label: 'angle-bracket placeholder' },
    { re: /\bTODO\b|\bTBD\b|\bFIXME\b|\bLOREM IPSUM\b/i, label: 'stub/placeholder text' },
    { re: /\bplaceholder\b/i, label: 'literal "placeholder" word' },
    { re: /\bXXX+\b/g, label: 'XXX marker' },
    { re: /\.\.\.\s*fill in/i, label: '"fill in" instruction' },
    // PATCH `-eq8-content-fix` (#5): belt-and-suspenders for LLM refusal strings
    // that somehow survive the composer's _quickValidate FATAL guard.
    { re: /\b(there is no hook|no data available|no match found|as an ai\b|unable to (find|provide|generate)|insufficient data|i don'?t have)\b/i, label: 'LLM refusal/no-data string' }
  ];
  patterns.forEach(function(p) {
    var m = fullText.match(p.re);
    if (m && m.length > 0) {
      issues.push('FATAL: Placeholder leak (' + p.label + '): "' + m[0] + '"');
    }
  });
  return issues;
}

/**
 * English sanity: double spaces, repeated adjacent words, broken sentence caps,
 * missing spaces after punctuation, dangling punctuation.
 */
function _checkEnglishSanity(plainText) {
  var issues = [];
  if (!plainText || plainText.length < 20) return issues;

  // Double spaces inside sentences (excluding indentation)
  if (/[a-z]\s{2,}[a-z]/i.test(plainText)) {
    issues.push('double-space inside sentence');
  }

  // Repeated adjacent words: "the the", "and and"
  var repeatMatch = plainText.match(/\b(\w{3,})\s+\1\b/gi);
  if (repeatMatch && repeatMatch.length > 0) {
    // Filter out legitimate repeats like "had had"
    var real = repeatMatch.filter(function(m) {
      var word = m.split(/\s+/)[0].toLowerCase();
      return ['had', 'that', 'is'].indexOf(word) < 0;
    });
    if (real.length > 0) issues.push('repeated word: "' + real[0] + '"');
  }

  // Missing space after punctuation: "hello,world" / "end.Next"
  if (/[a-z][.,;:!?][A-Z]/.test(plainText)) {
    issues.push('missing space after punctuation');
  }

  // Broken capitalization: sentence starting with lowercase after a period
  var sentences = plainText.split(/(?<=[.!?])\s+/);
  for (var s = 0; s < sentences.length; s++) {
    var first = sentences[s].replace(/^[^a-zA-Z]+/, '');
    if (first.length > 3 && /^[a-z]/.test(first)) {
      issues.push('sentence starts with lowercase: "' + sentences[s].substring(0, 30) + '..."');
      break;
    }
  }

  // Excessive ellipsis
  if (/\.{4,}/.test(plainText)) {
    issues.push('excessive ellipsis (4+ dots)');
  }

  // Unbalanced parens/quotes
  var openParens = (plainText.match(/\(/g) || []).length;
  var closeParens = (plainText.match(/\)/g) || []).length;
  if (openParens !== closeParens) {
    issues.push('unbalanced parentheses');
  }
  var quoteCount = (plainText.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    issues.push('unbalanced double quotes');
  }

  return issues;
}

/**
 * Factual recency: no dated facts from before 2026 framed as "recent".
 * Today's date is configurable via global CURRENT_YEAR (default 2026).
 */
function _checkRecency(plainText) {
  var issues = [];
  var currentYear = (typeof CURRENT_YEAR !== 'undefined') ? CURRENT_YEAR : 2026;

  // Find any 4-digit year references
  var yearMatches = plainText.match(/\b(19|20)\d{2}\b/g) || [];
  yearMatches.forEach(function(yStr) {
    var y = parseInt(yStr, 10);
    if (y < currentYear - 1 && y >= 2000) {
      // Check if paired with "recent/latest/just/this year/last week"
      var recencyPattern = new RegExp('(recent|recently|latest|just|last\\s+(week|month|quarter)|this\\s+(year|month|quarter|week))[^.]{0,80}' + yStr, 'i');
      var recencyPatternReverse = new RegExp(yStr + '[^.]{0,60}(recent|recently|latest|just|last\\s+(week|month|quarter)|this\\s+(year|month|quarter))', 'i');
      if (recencyPattern.test(plainText) || recencyPatternReverse.test(plainText)) {
        issues.push('FATAL: Stale fact — "' + yStr + '" framed as recent (today is ' + currentYear + ')');
      }
    }
  });

  // "Over the last X years" where X pushes us pre-2026
  var overLast = plainText.match(/(over|in|during)\s+the\s+(last|past)\s+(\d+)\s+(year|month)/i);
  // (intentionally permissive — this is a soft check, no issue added)

  return issues;
}

/**
 * Cold job-application framing checks. Returns {fatal, warnings}.
 * @param {string} plainText - Full plain-text body (used for framing patterns)
 * @param {string} normalized - Lowercased+whitespace-normalised version of plainText
 * @param {Object} [parsedComposition] - Optional parsed composition fields; used to
 *   exclude closingResume content from the attachment-mention check so that the
 *   canonical "Resume attached for further context" closer doesn't trip the FATAL.
 */
function _checkColdJobFraming(plainText, normalized, parsedComposition) {
  var fatal = [];
  var warnings = [];

  var fatalPatterns = [
    { re: /\bplease (hire|consider|give me)\b/i, label: 'begging language ("please hire/consider me")' },
    { re: /\b(desperate|desperately|badly need|really need this job)\b/i, label: 'desperate framing' },
    { re: /\bi am (the best|perfect for|your ideal)\b/i, label: 'over-assertive self-claim' },
    { re: /\bguaranteed (results?|roi|growth|success)\b/i, label: 'sales-promise language (guaranteed results)' },
    { re: /\bproven track record\b/i, label: 'buzzword cliche ("proven track record")' },
    { re: /\bsynergies?\b/i, label: 'corporate buzzword ("synergy")' },
    { re: /\bas discussed\b/i, label: 'fake prior-conversation framing ("as discussed")' },
    { re: /\bper my previous email\b/i, label: 'fake prior-email framing' }
  ];
  fatalPatterns.forEach(function(p) {
    if (p.re.test(plainText)) {
      fatal.push('FATAL: Framing violation — ' + p.label);
    }
  });

  // Build a scanText that EXCLUDES closingResume — the canonical template legitimately
  // says "Resume attached for further context. Would welcome the chance..." there;
  // flagging it as a body attachment-mention is a false positive.
  // Also excludes closingResume from the em-dash check (defensive, for future templates).
  var scanText = [
    parsedComposition && parsedComposition.hookParagraph    ? parsedComposition.hookParagraph    : '',
    parsedComposition && parsedComposition.bridgeSentence   ? parsedComposition.bridgeSentence   : '',
    parsedComposition && parsedComposition.experienceBullets
      ? (parsedComposition.experienceBullets || []).map(function(b) { return (b.label || '') + ': ' + (b.body || ''); }).join(' ')
      : '',
    parsedComposition && parsedComposition.currentRoleParagraph  ? parsedComposition.currentRoleParagraph  : '',
    parsedComposition && parsedComposition.motivationParagraph   ? parsedComposition.motivationParagraph   : '',
    parsedComposition && parsedComposition.closingLogistics      ? parsedComposition.closingLogistics      : ''
    // EXCLUDED: parsedComposition.closingResume — the canonical template legitimately
    // says "Resume attached for further context" here; don't flag it as
    // self-mentioning attachment in the body.
  ].join(' ');
  // Fall back to full plainText when no parsedComposition is available (legacy callers)
  var attachmentScanTarget = (parsedComposition ? scanText : plainText);

  // Attachment mentions — check only the scoped body (not closingResume)
  if (/\b(attached|attachment|please find|enclosed)\b/i.test(attachmentScanTarget) &&
      !/\bnot attached\b/i.test(attachmentScanTarget)) {
    fatal.push('FATAL: Body mentions attachment — resume is auto-attached, do not reference it');
  }

  // Warning-level: sales-y words that aren't fatal but lower quality
  var warnPatterns = [
    { re: /\bi can (help|deliver|bring|offer)\b/i, label: 'leads with "I can" (flip to "you/your")' },
    { re: /\blet me (know|share|explain)\b/i, label: 'weak closer ("let me know")' },
    { re: /\bquick (chat|call|question)\b/i, label: '"quick chat" (specify 15-min instead)' }
  ];
  warnPatterns.forEach(function(p) {
    if (p.re.test(plainText)) warnings.push('Framing: ' + p.label);
  });

  return { fatal: fatal, warnings: warnings };
}

/**
 * Event grounding: every specific NUMBER (not % or year) and every PROPER-NOUN claim
 * about the LEAD's company/role in the opening hook should map to something in the
 * dossier. Unverified claims are flagged.
 */
function _checkEventGrounding(plainText, dossier) {
  var issues = [];
  if (!dossier) return issues;

  // Serialize dossier to a searchable text blob
  var dossierBlob = JSON.stringify(dossier).toLowerCase();

  // The caller now passes the scoped hook text (BULLET_V1) or full plainText
  // (legacy). Take the first 250 chars in either case to keep the regex cheap.
  var hookZone = plainText.substring(0, 250).toLowerCase();

  // Find number patterns: "189%", "₹5.76 Cr", "$12M", "Series B", "120 employees"
  var numberPatterns = hookZone.match(/(\d+\.?\d*)\s*(%|cr|crore|lakh|lakhs|l\b|m\b|mn|million|bn|billion|k\b|employees|users?|stores?|cities|months?|weeks?|quarters?)/gi) || [];

  numberPatterns.forEach(function(token) {
    // Extract just the number portion
    var num = token.match(/\d+\.?\d*/);
    if (!num) return;
    var numStr = num[0];
    // If the number appears in the dossier, it's grounded
    if (dossierBlob.indexOf(numStr) >= 0) return;
    // If token (with unit) appears, also grounded
    if (dossierBlob.indexOf(token.toLowerCase().trim()) >= 0) return;
    // Otherwise flag
    issues.push('Ungrounded hook metric: "' + token.trim() + '" not found in dossier');
  });

  return issues;
}

/**
 * Resume alignment: any metric/institution/company Gaurav cites about HIMSELF
 * must exist in GAURAV_ACHIEVEMENT_BANK / GAURAV_FACTS.
 * Returns {fatal, warnings}.
 */
function _checkResumeAlignment(plainText, normalized, resumeSelection) {
  var fatal = [];
  var warnings = [];

  // ── Fabricated education: Gaurav claims alumni of an institution not in his list ──
  if (typeof GAURAV_FACTS !== 'undefined' && GAURAV_FACTS.notAlumniOf) {
    GAURAV_FACTS.notAlumniOf.forEach(function(fakeInst) {
      if (normalized.indexOf(fakeInst) >= 0) {
        // Only flag if paired with alumni claim language ABOUT Gaurav
        var contextRe = new RegExp('\\b(i|my|we both|fellow alum(ni)?|alma mater|studied at|attended)\\b[^.]{0,80}' + fakeInst, 'i');
        var contextReRev = new RegExp(fakeInst + '[^.]{0,60}\\b(alum|graduate|studied|attended|degree)\\b', 'i');
        if (contextRe.test(plainText) || contextReRev.test(plainText)) {
          fatal.push('CATASTROPHIC: Fabricated education — email claims Gaurav alum of "' + fakeInst + '". Real: IIM Kozhikode + Thapar University.');
        }
      }
    });
  }

  // ── Company name misattribution: "I worked at X" where X is not in his history ──
  if (typeof GAURAV_FACTS !== 'undefined' && GAURAV_FACTS.companies) {
    // Pattern: "At {Company}," or "I worked at {Company}"
    var workClaimRe = /\b(at|worked at|while at|during my time at|my time at)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})\b/g;
    var verifiedCompaniesLower = GAURAV_FACTS.companies.map(function(c) { return c.toLowerCase(); });
    var m;
    while ((m = workClaimRe.exec(plainText)) !== null) {
      var claimedCompany = m[2].toLowerCase().trim();
      // Skip if this matches a verified company (partial match acceptable)
      var matched = verifiedCompaniesLower.some(function(vc) {
        return claimedCompany.indexOf(vc) >= 0 || vc.indexOf(claimedCompany) >= 0;
      });
      if (!matched) {
        // Also skip if it refers to the lead's company (legitimate "at their company")
        // We can't always know without lead context — leave as warning only if nonobvious
        warnings.push('Alignment: "At ' + m[2] + '" may be unverified Gaurav work claim');
      }
    }
  }

  // ── Metric verification: numeric claims about Gaurav's work should map to bank ──
  if (typeof GAURAV_ACHIEVEMENT_BANK !== 'undefined') {
    // Build union of all aliases from all achievements
    var allAchievementPhrases = [];
    Object.keys(GAURAV_ACHIEVEMENT_BANK).forEach(function(k) {
      var entry = GAURAV_ACHIEVEMENT_BANK[k];
      if (entry.aliases) allAchievementPhrases = allAchievementPhrases.concat(entry.aliases);
    });

    // Extract sentences that talk about Gaurav's work ("I", "At Blinkit", "led", "built", etc.)
    var sentences = plainText.split(/(?<=[.!?])\s+/);
    sentences.forEach(function(sent) {
      var sentLower = sent.toLowerCase();
      var selfReferential = /\b(i |my |at blinkit|at zomato|at thoughtworks|at upgrad|at shiprocket|i led|i built|i managed|i scaled|i ran|i drove)\b/i.test(sent);
      if (!selfReferential) return;
      // Find numbers in this sentence
      var nums = sentLower.match(/\b\d+\.?\d*[a-z]?\b/g) || [];
      nums.forEach(function(n) {
        var clean = n.replace(/[^0-9.]/g, '');
        if (!clean || clean.length === 0) return;
        // If the number exists in the whitelist, OK
        if (GAURAV_METRIC_WHITELIST && GAURAV_METRIC_WHITELIST.indexOf(n) >= 0) return;
        if (GAURAV_METRIC_WHITELIST && GAURAV_METRIC_WHITELIST.indexOf(clean) >= 0) return;
        // If a known achievement phrase is nearby, it's fine
        var phraseNearby = allAchievementPhrases.some(function(p) { return sentLower.indexOf(p) >= 0; });
        if (!phraseNearby && parseFloat(clean) > 1 && parseFloat(clean) < 99999) {
          warnings.push('Alignment: Unverified number "' + n + '" in self-referential claim: "' + sent.substring(0, 60) + '..."');
        }
      });
    });
  }

  return { fatal: fatal, warnings: warnings };
}

/**
 * HTML structure checks. Returns {fatal, warnings}.
 * Largely mirrors _verifyEmailStructure but focused on deliverability-critical items.
 */
function _checkHtmlStructure(html, parsedComposition) {
  var fatal = [];
  var warnings = [];
  if (!html) { fatal.push('FATAL: HTML body is empty'); return { fatal: fatal, warnings: warnings }; }

  // PATCH 2026-05-19: detect CXO_SHORT (Leadership Master Template) — it ships
  // intentionally without a banner per Founder-Grade Playbook ("banners read
  // junior to Director+"). Skip banner warning for CXO shape.
  var _mvCxoBullets = (parsedComposition && Array.isArray(parsedComposition.experienceBullets))
    ? parsedComposition.experienceBullets.length : 0;
  var _mvIsCxoShort = (_mvCxoBullets === 0)
    && !!(parsedComposition && parsedComposition.motivationParagraph
          && parsedComposition.motivationParagraph.toString().trim());

  // Banner image (STANDARD/HR only — CXO_SHORT deliberately omits banner)
  if (!_mvIsCxoShort && html.indexOf('cid:emailBanner') < 0) {
    warnings.push('Structure: Banner image CID missing');
  }

  // Greeting
  if (!/Hi\s+|Hello\s+|Hey\s+/.test(html)) {
    fatal.push('FATAL: No greeting detected in email');
  }

  // Body paragraph count
  var pOpen = (html.match(/<p\b/gi) || []).length;
  var pClose = (html.match(/<\/p>/gi) || []).length;
  if (pOpen !== pClose) {
    fatal.push('FATAL: Unbalanced <p> tags (' + pOpen + ' open, ' + pClose + ' close)');
  }
  if (pOpen < 3) {
    warnings.push('Structure: Only ' + pOpen + ' paragraph tags — minimum 3 recommended (greeting + 2 body)');
  }

  // Empty paragraphs
  if (/<p[^>]*>\s*<\/p>/i.test(html)) {
    warnings.push('Structure: Empty <p> tag detected');
  }

  // Bold CTA
  if (html.indexOf('<strong>') < 0) {
    warnings.push('Structure: No bold CTA (<strong>) found');
  }

  // Signature
  if (html.indexOf('Gaurav Rathore') < 0) {
    fatal.push('FATAL: Signature name "Gaurav Rathore" missing');
  }
  if (html.indexOf('IIM Kozhikode') < 0 && html.indexOf('IIM K') < 0) {
    warnings.push('Structure: MBA credential missing from signature');
  }
  if (!/linkedin/i.test(html)) {
    warnings.push('Structure: LinkedIn link missing from signature');
  }

  // P.S.
  if (html.indexOf('P.S.') < 0) {
    warnings.push('Structure: P.S. line missing');
  }

  // Div balance
  var dOpen = (html.match(/<div\b/gi) || []).length;
  var dClose = (html.match(/<\/div>/gi) || []).length;
  if (dOpen !== dClose) {
    fatal.push('FATAL: Unbalanced <div> tags (' + dOpen + ' open, ' + dClose + ' close)');
  }

  // Exclude closingResume from em-dash / curly-quote scan — future template variants
  // may legitimately use these characters only in the closing resume sentence.
  var htmlForEmDashCheck = html;
  if (parsedComposition && parsedComposition.closingResume) {
    var closingResumeEscaped = parsedComposition.closingResume.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    htmlForEmDashCheck = html.replace(new RegExp(closingResumeEscaped, 'g'), '');
  }

  // Em-dash / curly quotes (scoped to htmlForEmDashCheck, not full html)
  if (/[\u2014\u2015]/.test(htmlForEmDashCheck)) {
    fatal.push('FATAL: Em-dash detected — must use " - " or plain hyphen');
  }
  if (/[\u201C\u201D\u2018\u2019]/.test(htmlForEmDashCheck)) {
    warnings.push('Structure: Curly/smart quotes detected');
  }

  return { fatal: fatal, warnings: warnings };
}

/**
 * Cross-field uniqueness — no duplicate sentences across body/CTA/PS fields.
 * Uses _textSimilarity from EmailComposer.gs if available.
 */
function _checkCrossFieldUniqueness(parsed) {
  var issues = [];
  if (!parsed || typeof _textSimilarity !== 'function') return issues;

  var paras = parsed.bodyParagraphs || [];
  var cta = parsed.cta || '';
  var ps = parsed.psLine || '';

  // Body vs CTA
  for (var i = 0; i < paras.length; i++) {
    if (cta && _textSimilarity(paras[i], cta) >= 0.80) {
      issues.push('FATAL: Body paragraph #' + (i + 1) + ' duplicates CTA');
    }
    if (ps && _textSimilarity(paras[i], ps) >= 0.80) {
      issues.push('FATAL: Body paragraph #' + (i + 1) + ' duplicates P.S.');
    }
  }
  if (cta && ps && _textSimilarity(cta, ps) >= 0.80) {
    issues.push('FATAL: CTA and P.S. are near-duplicates');
  }

  // Body paragraph internal dedup
  for (var j = 0; j < paras.length; j++) {
    for (var k = j + 1; k < paras.length; k++) {
      if (_textSimilarity(paras[j], paras[k]) >= 0.80) {
        issues.push('FATAL: Body paragraphs #' + (j + 1) + ' and #' + (k + 1) + ' are near-duplicates');
      }
    }
  }

  return issues;
}

// ─── LLM-AS-JUDGE CRITIC ──────────────────────────────────────────────

/**
 * Single-call critic. Returns 0-10 score per dimension + rewriteNotes.
 * Temperature=0 for stable grading. Graceful failure → returns null.
 */
function _invokeLlmCritic(subject, plainText, lead, dossier, classification, resumeSelection) {
  var dossierSummary = _buildCompactDossierSummary(dossier);
  var verifiedAchievements = _buildVerifiedAchievementsBlock(resumeSelection);

  var prompt =
    'You are a strict quality judge for COLD JOB-APPLICATION emails sent by a candidate (Gaurav Rathore) to hiring managers / founders at Indian startups. Today\'s date: 2026.\n\n' +
    'Score this email across 6 dimensions, 0-10 each. Use the FULL range — 5 means average, 7 means good, 9+ only for exceptional.\n\n' +
    'DIMENSIONS:\n' +
    '1. english     — grammar, syntax, tense consistency, flow, zero typos\n' +
    '2. coherence   — does each sentence earn its place, do paragraphs connect, is the thesis clear\n' +
    '3. recency     — all cited facts are current (post-2026-01-01). Past events are explicitly dated\n' +
    '4. framing     — peer-level, honest job-application tone, NOT salesy, NOT begging, NOT over-assertive\n' +
    '5. grounding   — hook facts about the LEAD\'s company match the dossier below (no hallucinations)\n' +
    '6. alignment   — Gaurav\'s metrics match his verified achievements below (no fabricated numbers)\n\n' +
    'EMAIL:\n' +
    'Subject: ' + subject + '\n' +
    'Body:\n' + plainText + '\n\n' +
    '---\n' +
    'LEAD: ' + (lead.fullName || '') + ' — ' + (lead.designation || '') + ' at ' + (lead.organization || '') + '\n\n' +
    'DOSSIER FACTS (for grounding check):\n' + dossierSummary + '\n\n' +
    'GAURAV\'S VERIFIED ACHIEVEMENTS (for alignment check):\n' + verifiedAchievements + '\n\n' +
    '---\n' +
    'Return ONLY JSON: {"english":N,"coherence":N,"recency":N,"framing":N,"grounding":N,"alignment":N,"rewriteNotes":["note1","note2"]}.\n' +
    'rewriteNotes: 1-3 SHORT specific instructions if any dimension < 7. Empty array if all >= 7.';

  var result = callClaude(prompt, {
    systemPrompt: 'You are a terse, honest email quality judge. Score strictly. Return JSON only.',
    temperature: 0,
    maxTokens: 400
  });
  if (!result || !result.success) return null;

  var text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
  var match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    var parsed = JSON.parse(match[0]);
    return {
      english: _clampScore(parsed.english),
      coherence: _clampScore(parsed.coherence),
      recency: _clampScore(parsed.recency),
      framing: _clampScore(parsed.framing),
      grounding: _clampScore(parsed.grounding),
      alignment: _clampScore(parsed.alignment),
      rewriteNotes: Array.isArray(parsed.rewriteNotes) ? parsed.rewriteNotes.slice(0, 4) : []
    };
  } catch (e) {
    Logger.log('[MasterValidator] Critic JSON parse failed: ' + e.message);
    return null;
  }
}

function _clampScore(v) {
  var n = Number(v);
  if (isNaN(n)) return 5;
  return Math.max(0, Math.min(10, n));
}

function _avgDimensions(dims) {
  if (!dims) return 7;
  var keys = ['english', 'coherence', 'recency', 'framing', 'grounding', 'alignment'];
  var sum = 0, cnt = 0;
  keys.forEach(function(k) {
    if (typeof dims[k] === 'number') { sum += dims[k]; cnt++; }
  });
  return cnt === 0 ? 7 : (sum / cnt);
}

// ─── HELPERS ──────────────────────────────────────────────────────────

function _stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function _buildCompactDossierSummary(dossier) {
  if (!dossier) return '(no dossier available)';
  var parts = [];
  if (dossier.company) {
    if (dossier.company.industry) parts.push('Industry: ' + dossier.company.industry);
    if (dossier.company.recentNews) parts.push('News: ' + String(dossier.company.recentNews).substring(0, 200));
    if (dossier.company.challenges) parts.push('Challenges: ' + String(dossier.company.challenges).substring(0, 160));
  }
  if (dossier.triggerEvents) {
    var te = (Array.isArray(dossier.triggerEvents) ? dossier.triggerEvents : [dossier.triggerEvents])
      .slice(0, 3).map(function(t) { return typeof t === 'object' ? (t.event || '') : String(t); }).join(' | ');
    if (te) parts.push('Triggers: ' + te);
  }
  if (dossier.hooks) {
    var hooks = (Array.isArray(dossier.hooks) ? dossier.hooks : []).slice(0, 3)
      .map(function(h) { return typeof h === 'object' ? (h.text || '') : String(h); }).join(' | ');
    if (hooks) parts.push('Hooks: ' + hooks);
  }
  return parts.join('\n') || '(dossier empty)';
}

function _buildVerifiedAchievementsBlock(resumeSelection) {
  var lines = [];
  var variantId = resumeSelection ? resumeSelection.variantId : 'GROWTH_MARKETING';
  if (typeof GAURAV_PROFILE !== 'undefined' && GAURAV_PROFILE[variantId]) {
    var variant = GAURAV_PROFILE[variantId];
    lines.push('Variant: ' + variant.title);
    variant.achievements.forEach(function(a) { lines.push('- ' + a); });
  }
  lines.push('Verified companies: Blinkit, Blinkit Bistro, Zomato, Thoughtworks, upGrad, Shiprocket');
  lines.push('Verified education: IIM Kozhikode (MBA), Thapar University (B.E.) — ONLY these two');
  return lines.join('\n');
}

function _buildRecomposeFeedback(fatalIssues, warnings, rewriteNotes) {
  var parts = [];
  if (fatalIssues.length > 0) {
    parts.push('CRITICAL ISSUES (must fix):');
    fatalIssues.slice(0, 6).forEach(function(i) { parts.push('  - ' + i); });
  }
  if (rewriteNotes.length > 0) {
    parts.push('SPECIFIC REWRITES:');
    rewriteNotes.slice(0, 5).forEach(function(n) { parts.push('  - ' + n); });
  }
  if (warnings.length > 0 && warnings.length <= 3) {
    parts.push('MINOR (improve if easy):');
    warnings.slice(0, 3).forEach(function(w) { parts.push('  - ' + w); });
  }
  return parts.join('\n');
}
