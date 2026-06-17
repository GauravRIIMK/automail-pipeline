/**
 * ============================================================
 * MultiSignalDisambiguator.gs — Smart ranking of email-pattern
 * candidates when SMTP probing fails (Reoon all-unknown case)
 * (Patch 2026-05-12)
 *
 * THE PROBLEM:
 *   Apollo + Hunter miss the lead. Pipeline produces N pattern guesses
 *   (e.g., aditya.puri@amazon.com, apuri@amazon.com, adityapuri@amazon.com).
 *   Reoon returns `unknown` for all because Amazon blocks external SMTP probes.
 *   We need to pick the most likely correct one WITHOUT bouncing emails
 *   to wrong addresses (which degrades sender reputation).
 *
 * THE APPROACH:
 *   Ensemble scoring across 7 signals that don't require SMTP. Each
 *   candidate gets a 0-100 score. Top candidate is auto-picked only if:
 *     (a) score >= 50  AND
 *     (b) gap to 2nd place >= 15 points
 *   Otherwise: ranked candidates exposed in NEEDS_EMAIL_REVIEW notes so the
 *   user can pick with one tap (the highest-ranked is presented as
 *   "Top guess (XX% conf)").
 *
 * SELF-IMPROVING: Signals (6) and (7) read RepliedLog + BounceLog to learn
 *   from real-world feedback. The more emails you send, the smarter the
 *   ranker gets — REPLIED leads reinforce the winning pattern at that
 *   domain; BOUNCED leads penalize the losing pattern.
 *
 * Entry: multiSignalRank(domain, firstName, lastName, candidates, leadContext)
 * Returns: { ranked, best, bestScore, gap, confidence, shouldAutoPick, breakdown }
 * ============================================================
 */

// ─── SIGNAL 1: Curated domain → pattern map ──────────────────────────────
// Manually maintained from industry knowledge. Patterns use these tokens:
//   {first}     → lowercase first name with non-alpha stripped
//   {last}      → lowercase last name with non-alpha stripped
//   {f}         → first initial (lowercase)
//   {l}         → last initial (lowercase)
//   {first.last}, {firstlast}, {f.last}, {flast}, {first_last}, {first}
//
// Add new domains over time as you encounter them. Higher confidence =
// stronger signal weight in the ensemble.

var DOMAIN_PATTERN_MAP = {
  // ─── Big tech (FAANG+) ──
  'amazon.com':     { pattern: '{first}.{last}', confidence: 0.95 },
  'amazon.in':      { pattern: '{first}.{last}', confidence: 0.90 },
  'aws.com':        { pattern: '{first}.{last}', confidence: 0.92 },
  'microsoft.com':  { pattern: '{first}.{last}', confidence: 0.95 },
  'meta.com':       { pattern: '{f}{last}',      confidence: 0.85 },
  'google.com':     { pattern: '{first}.{last}', confidence: 0.85 }, // mixed; first.last dominant
  'apple.com':      { pattern: '{f}{last}',      confidence: 0.78 },
  'netflix.com':    { pattern: '{first}.{last}', confidence: 0.88 },

  // ─── Consulting ──
  'mckinsey.com':   { pattern: '{first}_{last}', confidence: 0.92 },
  'bcg.com':        { pattern: '{first}.{last}', confidence: 0.92 },
  'bain.com':       { pattern: '{first}.{last}', confidence: 0.92 },
  'deloitte.com':   { pattern: '{first}{last}',  confidence: 0.80 },
  'accenture.com':  { pattern: '{first}.{last}', confidence: 0.85 },
  'ey.com':         { pattern: '{first}.{last}', confidence: 0.85 },
  'kpmg.com':       { pattern: '{first}.{last}', confidence: 0.85 },
  'pwc.com':        { pattern: '{first}.{last}', confidence: 0.85 },

  // ─── Banks ──
  'jpmorgan.com':       { pattern: '{first}.{last}', confidence: 0.85 },
  'gs.com':             { pattern: '{first}.{last}', confidence: 0.85 },
  'morganstanley.com':  { pattern: '{first}.{last}', confidence: 0.82 },
  'citi.com':           { pattern: '{first}.{last}', confidence: 0.82 },
  'hsbc.com':           { pattern: '{first}.{last}', confidence: 0.82 },

  // ─── Indian unicorns / tech ──
  'flipkart.com':   { pattern: '{first}.{last}',  confidence: 0.92 },
  'swiggy.in':      { pattern: '{first}.{last}',  confidence: 0.92 },
  'zomato.com':     { pattern: '{first}.{last}',  confidence: 0.88 },
  'paytm.com':      { pattern: '{first}.{last}',  confidence: 0.85 },
  'hotstar.com':    { pattern: '{first}.{last}',  confidence: 0.85 },
  'razorpay.com':   { pattern: '{first}.{last}',  confidence: 0.82 },
  'cred.club':      { pattern: '{first}.{last}',  confidence: 0.80 },
  'zerodha.com':    { pattern: '{first}',         confidence: 0.75 },
  'meesho.com':     { pattern: '{first}.{last}',  confidence: 0.80 },
  'phonepe.com':    { pattern: '{first}.{last}',  confidence: 0.80 },

  // ─── Indian IT services ──
  'infosys.com':    { pattern: '{first}_{last}',  confidence: 0.90 },
  'tcs.com':        { pattern: '{first}.{last}',  confidence: 0.82 },
  'wipro.com':      { pattern: '{first}.{last}',  confidence: 0.82 },
  'hcltech.com':    { pattern: '{first}.{last}',  confidence: 0.82 },
  'thoughtworks.com': { pattern: '{first}.{last}', confidence: 0.88 },
  'mindtree.com':   { pattern: '{first}.{last}',  confidence: 0.78 },

  // ─── SaaS ──
  'salesforce.com': { pattern: '{first}.{last}',  confidence: 0.85 },
  'oracle.com':     { pattern: '{first}.{last}',  confidence: 0.85 },
  'adobe.com':      { pattern: '{first}{last}',   confidence: 0.80 },
  'sap.com':        { pattern: '{first}.{last}',  confidence: 0.80 },
  'workday.com':    { pattern: '{first}.{last}',  confidence: 0.80 },

  // ─── Media / FMCG / consumer ──
  'unilever.com':       { pattern: '{first}.{last}',  confidence: 0.90 },
  'pg.com':             { pattern: '{first}.{last}',  confidence: 0.85 }, // P&G
  'cocacola.com':       { pattern: '{first}.{last}',  confidence: 0.82 },
  'coca-cola.com':      { pattern: '{first}.{last}',  confidence: 0.82 },
  'nestle.com':         { pattern: '{first}.{last}',  confidence: 0.85 },
  'mondelezinternational.com': { pattern: '{first}.{last}', confidence: 0.82 },
  'disney.com':         { pattern: '{f}{last}',       confidence: 0.75 },
  'starbucks.com':      { pattern: '{first}.{last}',  confidence: 0.80 },
  'reliancejio.com':    { pattern: '{first}.{last}',  confidence: 0.78 },
  'tatacliq.com':       { pattern: '{first}.{last}',  confidence: 0.78 },
  'delhivery.com':      { pattern: '{first}.{last}',  confidence: 0.82 },

  // ─── Ride / mobility ──
  'uber.com':       { pattern: '{first}',         confidence: 0.75 }, // single name dominant
  'lyft.com':       { pattern: '{first}',         confidence: 0.72 },
  'cars24.com':     { pattern: '{first}.{last}',  confidence: 0.80 }
};

// ─── SIGNAL 4: Global pattern frequency prior ─────────────────────────────
// Empirical: across general B2B corporate domains, this is the rough
// distribution. Used as a fallback signal when other signals are weak.
var GLOBAL_PATTERN_PRIORS = {
  '{first}.{last}': 0.38,    // dominant in mid-large enterprises
  '{f}{last}':       0.22,   // dominant in some F500
  '{first}{last}':   0.12,
  '{first}_{last}':  0.06,
  '{first}':         0.12,   // smaller companies, single-name policies
  '{f}.{last}':      0.04,
  '{last}.{first}':  0.03,
  '{last}{f}':       0.02,
  '{first}.{l}':     0.01
};

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Score and rank a set of pattern-guessed candidates using non-SMTP signals.
 *
 * @param {string} domain        e.g., 'amazon.com'
 * @param {string} firstName     e.g., 'Aditya'
 * @param {string} lastName      e.g., 'Puri'
 * @param {Array<string>} candidates  ['aditya.puri@amazon.com', 'apuri@...', ...]
 * @param {Object} [leadContext] optional — { organization, headline, ... }
 * @returns {Object} { ranked, best, bestScore, gap, confidence, shouldAutoPick, breakdown }
 */
function multiSignalRank(domain, firstName, lastName, candidates, leadContext) {
  if (!domain || !firstName || !candidates || candidates.length === 0) {
    return { ranked: [], best: null, bestScore: 0, gap: 0, confidence: 0, shouldAutoPick: false };
  }
  domain = domain.toLowerCase().trim();
  var f = (firstName || '').toLowerCase().replace(/[^a-z]/g, '');
  var l = (lastName || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!f) return { ranked: [], best: null, bestScore: 0, gap: 0, confidence: 0, shouldAutoPick: false };

  // Pre-compute domain-level signals once (not per-candidate)
  var domainSignals = _msdComputeDomainSignals(domain, f, l, leadContext);

  var scored = candidates.map(function(email) {
    var localPart = (email || '').toLowerCase().split('@')[0];
    var pattern = _msdDetectPattern(localPart, f, l);
    var breakdown = {
      curatedDomain:     _msdScoreCuratedDomain(localPart, pattern, domain, domainSignals),
      dynamicDiscovered: _msdScoreDynamicDiscovered(localPart, pattern, domain, domainSignals),
      historicalDomain:  _msdScoreHistoricalDomain(localPart, pattern, domain, domainSignals),
      hunterPattern:     _msdScoreHunterPattern(localPart, pattern, domain, domainSignals),
      globalPrior:       _msdScoreGlobalPrior(pattern),
      llmJudgment:       0,  // populated below if Gemini available
      replyHistory:      _msdScoreReplyHistory(localPart, pattern, domain, domainSignals),
      bounceHistory:     _msdScoreBouncePenalty(email, domain, domainSignals)
    };
    var rawScore = breakdown.curatedDomain
                 + breakdown.dynamicDiscovered
                 + breakdown.historicalDomain
                 + breakdown.hunterPattern
                 + breakdown.globalPrior
                 + breakdown.replyHistory
                 + breakdown.bounceHistory;  // already negative if applicable
    return { email: email, pattern: pattern, score: rawScore, breakdown: breakdown };
  });

  // ─── Optional LLM judgment (Gemini) — single call, ranks all candidates ──
  // Only run if Gemini is configured AND we have at least 2 candidates AND
  // the existing signals haven't already produced a strong winner.
  try {
    var preliminaryTop = scored.slice().sort(function(a,b){return b.score-a.score;});
    var preGap = preliminaryTop.length >= 2 ? preliminaryTop[0].score - preliminaryTop[1].score : 0;
    if (preGap < 25 && scored.length >= 2 && _msdHasGeminiKey()) {
      var llmRanks = _msdGeminiJudgment(candidates, firstName, lastName, domain, leadContext);
      // llmRanks: { 'email1': 25, 'email2': 10, ... } — points to add per candidate
      scored.forEach(function(s) {
        var pts = llmRanks[s.email] || 0;
        s.breakdown.llmJudgment = pts;
        s.score += pts;
      });
    }
  } catch (e) {
    Logger.log('[MSD] LLM judgment skipped: ' + e.message);
  }

  // Clamp + sort
  scored.forEach(function(s) {
    s.score = Math.max(0, Math.min(100, s.score));
  });
  scored.sort(function(a, b) { return b.score - a.score; });

  var best = scored[0];
  var second = scored[1];
  var gap = second ? best.score - second.score : best.score;

  // ── Auto-pick gate ────────────────────────────────────────────────────
  //
  // STRICT gate (always-on):  top score >= 50 AND gap >= 15
  //   → high confidence auto-pick; produces conf 0.45-0.78
  //
  // PATCH 2026-05-18 (LENIENT gate for dominant-pattern domains):
  //   top score >= 40 AND gap >= 10 AND dominantPatternSignal=true
  //   → conditional auto-pick; produces conf 0.40-0.55
  //
  // A dominantPatternSignal exists when the domain has a CURATED pattern
  // entry, a Hunter Email Finder pattern with confidence >= 0.50, or a
  // dynamic-discovered pattern with tier 'high'. These signals make the
  // top-ranked candidate the statistically-likeliest format for the
  // domain — well-suited for auto-pick + downstream Hunter Verifier
  // tie-break in PSV (which now ALWAYS fires when source=multi_signal_
  // disambiguator per the 2026-05-18 PSV ordering fix).
  //
  // Why this is safe:
  //   - autoPicked=true flag flows to PSV, which gates Hunter Verifier
  //     for risky paths — Hunter has the final say on validity
  //   - Bounce-handler updates bouncedDomains on soft/hard bounces,
  //     which Signal 9 in PSV uses to suppress future picks at that
  //     domain (auto-correcting feedback loop)
  //   - The conf cap of 0.55 stays below verified-Apollo's 0.95, so
  //     downstream consumers can still distinguish guess from verified
  //
  // Why the previous strict-only gate was wrong:
  //   - Rahat/EMB Global class: 5 candidates with similar MSD scores
  //     (gap ~5-10) but the top-ranked perfectly matches the dominant
  //     "first.last" pattern. Strict gate refused auto-pick → lead sat
  //     at NEEDS_EMAIL_REVIEW forever requiring manual click.
  //   - The "perfectly aligned with domain pattern" condition is exactly
  //     what humans look at when picking from the review list — encoding
  //     it as a gate is the systemic fix.
  var dominantPatternSignal = false;
  var dominantSource = null;
  if (domainSignals.curated && best.pattern && domainSignals.curated[best.pattern]) {
    dominantPatternSignal = true; dominantSource = 'curated';
  } else if (domainSignals.hunter && domainSignals.hunter.pattern
             && best.pattern === domainSignals.hunter.pattern
             && (domainSignals.hunter.confidence || 0) >= 0.50) {
    dominantPatternSignal = true; dominantSource = 'hunter';
  } else if (domainSignals.dynamicDiscovered && domainSignals.dynamicDiscovered.pattern
             && best.pattern === domainSignals.dynamicDiscovered.pattern
             && domainSignals.dynamicDiscovered.tier === 'high') {
    dominantPatternSignal = true; dominantSource = 'dynamic_discovered';
  } else if (domainSignals.historical && domainSignals.historical.pattern
             && best.pattern === domainSignals.historical.pattern
             && (domainSignals.historical.sampleSize || 0) >= 3) {
    dominantPatternSignal = true; dominantSource = 'historical';
  }

  var strictAutoPick  = best.score >= 50 && gap >= 15;
  var lenientAutoPick = !strictAutoPick && best.score >= 40 && gap >= 10 && dominantPatternSignal;
  var shouldAutoPick  = strictAutoPick || lenientAutoPick;

  // Map to confidence:
  //   strict path  → 0.45-0.78
  //   lenient path → 0.40-0.55 (lower ceiling — must clear PSV Hunter tie-break)
  //   no-pick path → 0.20-0.40 (review)
  var confidence = 0;
  if (strictAutoPick) {
    confidence = 0.45 + Math.min(0.33, (best.score - 50) * 0.005 + gap * 0.005);
  } else if (lenientAutoPick) {
    confidence = 0.40 + Math.min(0.15, (best.score - 40) * 0.005 + gap * 0.005);
  } else {
    confidence = Math.min(0.40, 0.20 + best.score * 0.003);
  }

  if (lenientAutoPick) {
    Logger.log('[MSD] LENIENT auto-pick triggered: best=' + best.email
      + ' score=' + best.score + ' gap=' + gap
      + ' dominantSource=' + dominantSource + ' conf=' + confidence.toFixed(2));
  }

  return {
    ranked: scored,
    best: best.email,
    bestScore: best.score,
    bestPattern: best.pattern,
    gap: gap,
    confidence: confidence,
    shouldAutoPick: shouldAutoPick,
    autoPickPath: strictAutoPick ? 'strict' : (lenientAutoPick ? 'lenient_dominant_pattern' : 'no_pick'),
    dominantPatternSignal: dominantPatternSignal,
    dominantSource: dominantSource,
    breakdown: best.breakdown,
    runner_up: second ? { email: second.email, score: second.score } : null,
    domainSignals: domainSignals
  };
}

// ─── Domain-level signal precomputation ───────────────────────────────────

function _msdComputeDomainSignals(domain, f, l, leadContext) {
  var sigs = {
    curated: DOMAIN_PATTERN_MAP[domain] || null,
    dynamicDiscovered: null,
    historical: null,
    hunter: null,
    bouncedAtDomain: 0,
    repliedAtDomain: []
  };

  // PATCH 2026-05-12: dynamic pattern discovery. Only fires when domain
  // is NOT in the curated map (else we already have a high-confidence pattern).
  // Caches to DomainPatterns sheet so the next lookup is instant.
  if (!sigs.curated) {
    try {
      if (typeof discoverDomainPattern === 'function') {
        sigs.dynamicDiscovered = discoverDomainPattern(domain);
        if (sigs.dynamicDiscovered) {
          Logger.log('[MSD] DDPD result for ' + domain + ': pattern=' + sigs.dynamicDiscovered.pattern +
                     ' conf=' + sigs.dynamicDiscovered.confidence +
                     ' tier=' + sigs.dynamicDiscovered.tier +
                     ' sources=' + (sigs.dynamicDiscovered.sources || []).join(','));
        }
      }
    } catch (e) { Logger.log('[MSD] DDPD failed: ' + e.message); }
  }

  // Historical learning: scan Sheet2 for same-domain SENT/REPLIED emails
  try {
    sigs.historical = _msdHistoricalDomainPattern(domain);
  } catch (e) { Logger.log('[MSD] historical scan failed: ' + e.message); }

  // Hunter pattern (reuse existing fetch)
  try {
    if (typeof fetchHunterPattern === 'function') {
      var hp = fetchHunterPattern(domain);
      if (hp) sigs.hunter = hp;
    }
  } catch (e) { Logger.log('[MSD] hunter pattern fetch failed: ' + e.message); }

  // Bounce history at this domain
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var bd = ss.getSheetByName('BouncedDomains');
    if (bd && bd.getLastRow() >= 2) {
      var rows = bd.getRange(2, 1, bd.getLastRow() - 1, 2).getValues();
      for (var i = 0; i < rows.length; i++) {
        if ((rows[i][0] || '').toString().toLowerCase() === domain) {
          sigs.bouncedAtDomain = parseInt(rows[i][1]) || 0;
          break;
        }
      }
    }
  } catch (e) {}

  // Reply history at this domain
  try {
    var ss2 = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var rl = ss2.getSheetByName('RepliedLog');
    if (rl && rl.getLastRow() >= 2) {
      var rrows = rl.getDataRange().getValues();
      for (var j = 1; j < rrows.length; j++) {
        var rf = (rrows[j][4] || '').toString().toLowerCase();
        if (rf.indexOf('@' + domain) > 0) {
          var localPart = rf.split('@')[0];
          sigs.repliedAtDomain.push(localPart);
        }
      }
    }
  } catch (e) {}

  return sigs;
}

// ─── Individual signal scoring ────────────────────────────────────────────

function _msdScoreCuratedDomain(localPart, pattern, domain, sigs) {
  if (!sigs.curated) return 0;
  if (sigs.curated.pattern === pattern) {
    return Math.round(60 * sigs.curated.confidence);  // up to 57 points
  }
  return 0;
}

// PATCH 2026-05-12: dynamic-discovery signal. Scores in 0-50 range based on
// confidence of the ensemble research (Hunter + GitHub + Gemini).
function _msdScoreDynamicDiscovered(localPart, pattern, domain, sigs) {
  if (!sigs.dynamicDiscovered || !sigs.dynamicDiscovered.pattern) return 0;
  if (sigs.dynamicDiscovered.pattern === pattern) {
    return Math.round(50 * sigs.dynamicDiscovered.confidence);  // up to 45 points
  }
  return 0;
}

function _msdScoreHistoricalDomain(localPart, pattern, domain, sigs) {
  if (!sigs.historical) return 0;
  if (sigs.historical.dominantPattern === pattern && sigs.historical.confidence >= 0.5) {
    return Math.round(40 * sigs.historical.confidence);  // up to 40 points
  }
  return 0;
}

function _msdScoreHunterPattern(localPart, pattern, domain, sigs) {
  if (!sigs.hunter) return 0;
  // Normalize Hunter's pattern string ({first}.{last}, etc.) to our tokens
  var hp = (sigs.hunter || '').toString();
  if (hp === pattern) return 50;  // strong if exact match
  return 0;
}

function _msdScoreGlobalPrior(pattern) {
  var prior = GLOBAL_PATTERN_PRIORS[pattern] || 0;
  return Math.round(15 * prior * 2.5);  // {first}.{last} → 15*0.38*2.5 ≈ 14
}

function _msdScoreReplyHistory(localPart, pattern, domain, sigs) {
  if (!sigs.repliedAtDomain || sigs.repliedAtDomain.length === 0) return 0;
  // If past REPLIED emails at this domain share the same pattern shape,
  // strong positive signal that this domain uses this pattern.
  var matching = 0;
  sigs.repliedAtDomain.forEach(function(lp) {
    // Detect pattern of the past replied local-part
    // We don't have first/last for that historical lead, so we approximate:
    // count dots/underscores. If both have same separator structure, count it.
    var sepShape = function(s) {
      if (s.indexOf('.') >= 0) return 'dot';
      if (s.indexOf('_') >= 0) return 'underscore';
      return 'plain';
    };
    if (sepShape(lp) === sepShape(localPart)) matching++;
  });
  if (matching === 0) return 0;
  // Up to 20 points if 3+ historical replies share the same separator shape
  return Math.min(20, matching * 7);
}

function _msdScoreBouncePenalty(email, domain, sigs) {
  // Per-domain bounce history is a NEGATIVE signal.
  // 1 bounce → -5, 2 → -10, 3+ → -20 cap.
  var b = sigs.bouncedAtDomain || 0;
  if (b <= 0) return 0;
  return -Math.min(20, b * 5);
}

// ─── SIGNAL 2: Historical-domain pattern learning ─────────────────────────
// Scan Sheet2 for prior leads at the same domain whose status is SENT or
// REPLIED (meaning the email made it out + wasn't hard-bounced). Detect
// the dominant pattern.

function _msdHistoricalDomainPattern(domain) {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return null;
  var c = CONFIG.COLUMNS;
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, CONFIG.SHEET_COL_COUNT || 26).getValues();
  var patternCounts = {};
  var hits = 0;
  for (var i = 0; i < rows.length; i++) {
    var status = (rows[i][c.STATUS - 1] || '').toString();
    if (status !== 'SENT' && status !== 'REPLIED' && status !== 'DRAFT_CREATED') continue;
    var email = (rows[i][c.ENRICHED_EMAIL ? c.ENRICHED_EMAIL - 1 : c.EMAIL - 1] || '').toString().toLowerCase().trim();
    if (!email || email.indexOf('@' + domain) < 0) continue;
    var localPart = email.split('@')[0];
    var fullName = (rows[i][c.FULL_NAME - 1] || '').toString().toLowerCase();
    if (!fullName) continue;
    var nameParts = fullName.split(/\s+/).filter(Boolean);
    if (nameParts.length < 2) continue;
    var nf = nameParts[0].replace(/[^a-z]/g, '');
    var nl = nameParts[nameParts.length - 1].replace(/[^a-z]/g, '');
    if (!nf || !nl) continue;
    var detected = _msdDetectPattern(localPart, nf, nl);
    if (detected !== 'unknown') {
      patternCounts[detected] = (patternCounts[detected] || 0) + 1;
      hits++;
    }
  }
  if (hits < 2) return null;  // need at least 2 data points to claim a pattern
  // Find dominant
  var dominant = null, dominantCount = 0;
  Object.keys(patternCounts).forEach(function(p) {
    if (patternCounts[p] > dominantCount) {
      dominant = p;
      dominantCount = patternCounts[p];
    }
  });
  return {
    dominantPattern: dominant,
    confidence: dominantCount / hits,
    sampleSize: hits,
    breakdown: patternCounts
  };
}

// ─── Pattern detection — given a local-part + name, infer the pattern ────

function _msdDetectPattern(localPart, f, l) {
  if (!localPart || !f) return 'unknown';
  // Try in order of specificity
  if (l && localPart === f + '.' + l) return '{first}.{last}';
  if (l && localPart === f + '_' + l) return '{first}_{last}';
  if (l && localPart === f + l)       return '{first}{last}';
  if (l && localPart === f[0] + l)    return '{f}{last}';
  if (l && localPart === f[0] + '.' + l) return '{f}.{last}';
  if (l && localPart === f + '.' + l[0]) return '{first}.{l}';
  if (l && localPart === l + '.' + f) return '{last}.{first}';
  if (l && localPart === l + f[0])    return '{last}{f}';
  if (localPart === f) return '{first}';
  if (l && localPart === l) return '{last}';
  return 'unknown';
}

// ─── SIGNAL 5: Gemini LLM disambiguation ──────────────────────────────────
// One call per lead, only when other signals haven't produced a strong winner.
// Gemini reasons over: name structure, domain conventions, candidate quality.

function _msdHasGeminiKey() {
  var k = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  return !!k;
}

function _msdGeminiJudgment(candidates, firstName, lastName, domain, leadContext) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) return {};

  var prompt = 'You are an email-pattern disambiguator for cold B2B outreach.\n\n' +
    'Lead: ' + firstName + ' ' + (lastName || '') +
    (leadContext && leadContext.organization ? ' (works at ' + leadContext.organization + ')' : '') + '\n' +
    'Domain: ' + domain + '\n\n' +
    'Candidate emails (one of these is the real address; pick the most likely):\n' +
    candidates.map(function(e, i) { return (i + 1) + '. ' + e; }).join('\n') + '\n\n' +
    'Consider: the specific company\'s known email conventions (e.g., Amazon, Microsoft, McKinsey all use distinct patterns), ' +
    'Indian vs. Western name conventions (Indian names typically retain separators), ' +
    'and how this domain\'s emails typically look in the wild.\n\n' +
    'Respond with ONLY a JSON object mapping each candidate email to a score 0-100 (higher = more likely real).\n' +
    'Example: {"aditya.puri@amazon.com": 85, "apuri@amazon.com": 25, "adityapuri@amazon.com": 15}\n' +
    'No prose, no markdown — just the JSON object.';

  try {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(apiKey);
    var payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 400 }
    };
    var res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify(payload), muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      Logger.log('[MSD-Gemini] HTTP ' + res.getResponseCode() + ': ' + res.getContentText().substring(0, 200));
      return {};
    }
    var json = JSON.parse(res.getContentText());
    var txt = json && json.candidates && json.candidates[0] && json.candidates[0].content
            && json.candidates[0].content.parts && json.candidates[0].content.parts[0]
            && json.candidates[0].content.parts[0].text;
    if (!txt) return {};
    var parsed = JSON.parse(txt);
    // Convert 0-100 score → bonus points (max 30 for 100, scaled)
    var bonus = {};
    Object.keys(parsed).forEach(function(email) {
      var s = parseFloat(parsed[email]) || 0;
      bonus[email] = Math.round(s * 0.30);  // max 30 bonus
    });
    Logger.log('[MSD-Gemini] judgment: ' + JSON.stringify(parsed));
    return bonus;
  } catch (e) {
    Logger.log('[MSD-Gemini] error: ' + e.message);
    return {};
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test harness — call from /exec?action=msd_test
// ═══════════════════════════════════════════════════════════════════════════

function msdTest(firstName, lastName, domain, candidates) {
  // candidates can be a comma-separated string or array
  if (typeof candidates === 'string') {
    candidates = candidates.split(',').map(function(s) { return s.trim(); });
  }
  if (!candidates || candidates.length === 0) {
    // Auto-generate candidates from name+domain using the standard 14 patterns
    if (typeof guessProfessionalEmail === 'function') {
      candidates = guessProfessionalEmail(firstName, lastName, domain);
    }
  }
  return multiSignalRank(domain, firstName, lastName, candidates, { organization: '' });
}
