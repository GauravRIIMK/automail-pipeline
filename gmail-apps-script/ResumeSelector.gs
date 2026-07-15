/**
 * ============================================================
 * ResumeSelector.gs — AutoMail Pipeline: Automatic Resume Variant Selection Engine
 *
 * Selects the optimal resume variant for each lead based on:
 * - Lead classification & role fit
 * - Industry & function alignment
 * - Seniority level matching
 * - Personalization hooks
 * - Edge case adjustments (HR vs Founders)
 * - LLM tiebreaker when close (Gemini)
 * ============================================================
 */

// ─── RESUME VARIANT CONFIGURATION ──────────────────────────
// Defined once and used across all matching functions.
// NOTE: 'any' wildcard REMOVED from OPS industries (was causing OPS to always win).
//       Generalist fallback now handled explicitly in _scoreContextFit() below.
var RESUME_PROFILES = {
  GROWTH_MARKETING: {
    id: 'GROWTH_MARKETING',
    label: 'Growth Marketing Resume',
    driveIdKey: 'RESUME_DRIVE_ID_GROWTH',
    fileName: 'Resume_Gaurav_Growth_Marketing_2page.pdf',
    strengths: ['marketing', 'growth', 'acquisition', 'product launch', 'analytics', 'conversion'],
    industries: ['saas', 'marketplace', 'consumer', 'b2c', 'fintech', 'healthtech', 'd2c', 'e-commerce', 'quick commerce', 'edtech', 'foodtech'],
    hookKeywords: ['growth', 'scaling', 'acquisition', 'marketing', 'product-market fit', 'gtm', 'conversion', 'referral', 'dau', 'cac']
  },
  OPS_CONSULTING: {
    id: 'OPS_CONSULTING',
    label: 'Ops/Consulting Resume',
    driveIdKey: 'RESUME_DRIVE_ID_OPS',
    fileName: 'Resume_Gaurav_Ops_Consulting_Generalist_2page.pdf',
    strengths: ['operations', 'strategy', 'process', 'efficiency', 'consulting', 'general management', 'p&l', 'supply chain'],
    industries: ['enterprise', 'manufacturing', 'logistics', 'real estate', 'healthcare', 'retail', 'cpg', 'hospitality', 'cloud kitchen', 'dark store', 'warehousing'],
    hookKeywords: ['operations', 'strategy', 'efficiency', 'process', 'management', 'sla', 'p&l', 'margin', 'unit economics', 'supply chain']
  },
  PRODUCT_AI_STRATEGY: {
    id: 'PRODUCT_AI_STRATEGY',
    label: 'Product/AI/Strategy Resume',
    driveIdKey: 'RESUME_DRIVE_ID_PRODUCT',
    fileName: 'Resume_Gaurav_Product_AI_Strategy_2page.pdf',
    strengths: ['product', 'ai', 'strategy', 'technical', 'engineering', 'data', 'llm', 'rag'],
    industries: ['ai/ml', 'saas', 'deep tech', 'fintech', 'enterprise software', 'developer tools', 'genai', 'devtools', 'b2b saas', 'platform'],
    hookKeywords: ['product', 'ai', 'strategy', 'technical', 'engineering', 'data', 'machine learning', 'llm', 'rag', 'agent', 'automation', 'platform']
  }
};

// ─── DIRECT FUNCTION → VARIANT MAP ─────────────────────────
// Primary signal. Uses lead.function_ enum from SheetReader._parseFunction().
// Returns {primary, secondary} variant IDs with confidence scores.
var FUNCTION_VARIANT_MAP = {
  HR:          { primary: null,                  fallback: 'GROWTH_MARKETING' }, // HR requires company-context routing
  MARKETING:   { primary: 'GROWTH_MARKETING',    secondary: 'PRODUCT_AI_STRATEGY' },
  SALES:       { primary: 'GROWTH_MARKETING',    secondary: 'OPS_CONSULTING' },
  PRODUCT:     { primary: 'PRODUCT_AI_STRATEGY', secondary: 'GROWTH_MARKETING' },
  ENGINEERING: { primary: 'PRODUCT_AI_STRATEGY', secondary: 'OPS_CONSULTING' },
  DATA:        { primary: 'PRODUCT_AI_STRATEGY', secondary: 'GROWTH_MARKETING' },
  OPERATIONS:  { primary: 'OPS_CONSULTING',      secondary: 'GROWTH_MARKETING' },
  FINANCE:     { primary: 'OPS_CONSULTING',      secondary: 'PRODUCT_AI_STRATEGY' },
  CONSULTING:  { primary: 'OPS_CONSULTING',      secondary: 'PRODUCT_AI_STRATEGY' },
  LEADERSHIP:  { primary: null,                  fallback: 'GROWTH_MARKETING' }, // CEO/Founder: route by company context
  GENERAL:     { primary: null,                  fallback: 'GROWTH_MARKETING' }
};

/**
 * ============================================================
 * MAIN SELECTOR: selectResume(lead, dossier, classification)
 * ============================================================
 * Main entry point. Scores all variants and returns the best match.
 *
 * @param {Object} lead - Lead basic info (fullName, email, designation, organization, headline)
 * @param {Object} dossier - Research dossier (company, role, industry, signals, hooks, seniority)
 * @param {Object} classification - Lead archetype classification (archetype, hooks, function)
 * @returns {Object} { variantId: 'GROWTH_MARKETING', score: 87.5, reason: '...' }
 */
function selectResume(lead, dossier, classification) {
  try {
    // Validate inputs
    if (!lead || !dossier || !classification) {
      Logger.log('[ResumeSelector] Missing inputs, defaulting to GROWTH_MARKETING');
      return {
        variantId: 'GROWTH_MARKETING',
        score: 0,
        reason: 'Insufficient data for selection'
      };
    }

    // HARD OVERRIDE #1: HR/Recruiter routing — never default to OPS.
    // Route based on company context (what role is this HR hiring for?).
    if (lead.isHR || /HR_RECRUITER/i.test(classification.archetype || '')) {
      var hrWinner = _routeHRProfile(lead, dossier, classification);
      Logger.log('[ResumeSelector] HR routing → ' + hrWinner);
      return {
        variantId: hrWinner,
        score: 100,
        scores: {},
        reason: 'HR/Recruiter profile routed by company context: ' + hrWinner
      };
    }

    // Score all three variants
    var scores = {};
    var variants = Object.keys(RESUME_PROFILES);

    for (var i = 0; i < variants.length; i++) {
      var variantKey = variants[i];
      scores[variantKey] = _scoreVariant(variantKey, lead, dossier, classification);
    }

    // Find winner (break ties deterministically by canonical order)
    var canonicalOrder = ['PRODUCT_AI_STRATEGY', 'GROWTH_MARKETING', 'OPS_CONSULTING'];
    var winner = canonicalOrder[0];
    var maxScore = scores[winner];
    for (var k = 1; k < canonicalOrder.length; k++) {
      if (scores[canonicalOrder[k]] > maxScore) {
        winner = canonicalOrder[k];
        maxScore = scores[winner];
      }
    }

    // Collect close contenders (within 8% of winner) for LLM tiebreaker
    var runners = [];
    for (var j = 0; j < canonicalOrder.length; j++) {
      var vKey = canonicalOrder[j];
      if (vKey !== winner && maxScore > 0 && scores[vKey] >= maxScore * 0.92) {
        runners.push({ variant: vKey, score: scores[vKey] });
      }
    }

    // Tiebreaker: if another variant is within 8%, use LLM
    if (runners.length > 0 && maxScore > 0) {
      Logger.log('[ResumeSelector] Close scores (within 8%): ' + JSON.stringify(scores) + ' → invoking LLM tiebreaker');
      winner = _llmTiebreaker(lead, dossier, winner, runners[0].variant);
    }

    // Build result
    var result = {
      variantId: winner || 'GROWTH_MARKETING',
      score: maxScore,
      scores: scores,
      reason: _buildSelectionReason(winner, scores, dossier)
    };

    Logger.log('[ResumeSelector] Selected ' + result.variantId + ' with score ' + result.score);
    return result;

  } catch (err) {
    Logger.log('[ResumeSelector] Error in selectResume: ' + err.message);
    return {
      variantId: 'GROWTH_MARKETING',
      score: 0,
      reason: 'Error in selector: ' + err.message
    };
  }
}

/**
 * ============================================================
 * VARIANT SCORING: _scoreVariant(variantKey, lead, dossier, classification)
 * ============================================================
 * Scores a single variant using 7 weighted factors.
 * Total possible: ~100 (subject to hook cap and adjustments)
 *
 * Weights:
 * - Strong signal matching: 3x (e.g., "hiring" trigger found)
 * - Moderate signal matching: 1.5x
 * - Industry match: 4x
 * - Function match: 5x (highest priority)
 * - Seniority adjustment: 2x
 * - Hook relevance: 2x (capped at 6 points)
 * - Edge case boost/penalty: +/- (HR vs Founder bias)
 *
 * @param {string} variantKey - 'GROWTH_MARKETING', 'OPS_CONSULTING', or 'PRODUCT_AI_STRATEGY'
 * @param {Object} lead
 * @param {Object} dossier
 * @param {Object} classification
 * @returns {number} Score (0-100+)
 */
function _scoreVariant(variantKey, lead, dossier, classification) {
  var score = 0;
  var components = {};

  // 1. RESEARCH SIGNAL (weight: 6) — dossier.relevantVariant from ResearchEngine crossValidate
  //    This is the LLM's own judgment after scoring Gaurav's achievements vs company context.
  //    Strongest single signal because it already considered full company research.
  var researchScore = _scoreResearchSignal(dossier, variantKey);
  score += researchScore * 6;
  components.research = (researchScore * 6).toFixed(1);

  // 2. FUNCTION MATCH (weight: 5) — lead's own function directly maps to a variant
  var functionScore = _scoreFunctionMatch(lead.function_, variantKey, lead, dossier);
  score += functionScore * 5;
  components.func = (functionScore * 5).toFixed(1);

  // 3. COMPANY CONTEXT FIT (weight: 4) — industry + signals describe the company's core business
  var contextScore = _scoreContextFit(dossier, variantKey);
  score += contextScore * 4;
  components.ctx = (contextScore * 4).toFixed(1);

  // 4. SENIORITY FIT (weight: 2) — founder vs manager vs IC preferences per variant
  var seniorityScore = _scoreSeniorityFit(lead.seniority, classification.archetype, variantKey);
  score += seniorityScore * 2;
  components.sen = (seniorityScore * 2).toFixed(1);

  // 5. HOOK RELEVANCE (weight: 2, cap 6) — personalisation hooks match variant themes
  var hookScore = Math.min(_scoreHookRelevance(dossier.hooks || [], variantKey), 3);
  score += hookScore * 2;
  components.hook = (hookScore * 2).toFixed(1);

  // 6. FOUNDER / DECISION-MAKER BOOST — senior leaders get routed by company industry,
  //    not by variant seniority tags (fixes the old "OPS wins all execs" bug)
  var founderAdj = _scoreFounderContextBoost(lead, dossier, classification, variantKey);
  score += founderAdj;
  components.founder = founderAdj.toFixed(1);

  Logger.log('[ResumeSelector] ' + variantKey + ' total=' + score.toFixed(1) + ' ' + JSON.stringify(components));
  return Math.max(0, score);
}

/**
 * ============================================================
 * RESEARCH SIGNAL: _scoreResearchSignal(dossier, variantKey)
 * ============================================================
 * Consumes dossier.relevantVariant — the variant that ResearchEngine._crossValidateResume
 * already picked after scoring Gaurav's achievements against the full company context.
 * This is the strongest signal we have.
 *
 * @returns {number} 1.0 if this variant === relevantVariant, 0.35 otherwise (baseline)
 */
function _scoreResearchSignal(dossier, variantKey) {
  if (!dossier || !dossier.relevantVariant) return 0.35; // Neutral baseline if research hasn't picked
  return dossier.relevantVariant === variantKey ? 1.0 : 0.2;
}

/**
 * ============================================================
 * COMPANY CONTEXT FIT: _scoreContextFit(dossier, variantKey)
 * ============================================================
 * Scores how well the company's industry/signals match the variant's target industries.
 * Replaces the old _matchIndustry() which had the 'any' wildcard bug.
 *
 * Generalist fallback: if no variant matches explicitly, OPS gets a small bonus (0.35)
 * because it's the generalist resume — but NOT enough to outweigh strong signals for others.
 *
 * @returns {number} 0-1.0
 */
function _scoreContextFit(dossier, variantKey) {
  if (!dossier) return 0.3;

  var profile = RESUME_PROFILES[variantKey];
  var industry = (dossier.industry || '').toLowerCase();
  var companyName = (dossier.co && dossier.co.name) ? dossier.co.name.toLowerCase() : '';
  var challenges = (dossier.co && dossier.co.challenges) ? String(dossier.co.challenges).toLowerCase() : '';
  var growth = (dossier.co && dossier.co.growthSignals) ? String(dossier.co.growthSignals).toLowerCase() : '';
  var contextBlob = industry + ' ' + companyName + ' ' + challenges + ' ' + growth;

  // Exact industry match
  for (var i = 0; i < profile.industries.length; i++) {
    var ind = profile.industries[i].toLowerCase();
    if (industry.indexOf(ind) >= 0 || ind.indexOf(industry) >= 0 && industry.length > 2) {
      return 1.0;
    }
  }

  // Keyword/phrase match against hookKeywords in company context blob
  var kwHits = 0;
  for (var j = 0; j < profile.hookKeywords.length; j++) {
    var kw = profile.hookKeywords[j].toLowerCase();
    if (contextBlob.indexOf(kw) >= 0) kwHits++;
  }
  if (kwHits >= 2) return 0.75;
  if (kwHits === 1) return 0.5;

  // Partial industry match (first word)
  for (var m = 0; m < profile.industries.length; m++) {
    var firstWord = profile.industries[m].split(/[\s/]/)[0].toLowerCase();
    if (firstWord.length > 3 && industry.indexOf(firstWord) >= 0) {
      return 0.5;
    }
  }

  // Generalist fallback: OPS gets a small bonus when nothing else matched
  // (replaces old 'any' wildcard, but only fires when variant has NO specific match)
  if (variantKey === 'OPS_CONSULTING' && industry) {
    return 0.35;
  }

  return 0.2;
}

/**
 * ============================================================
 * FUNCTION MATCH: _scoreFunctionMatch(leadFunction, variantKey, lead, dossier)
 * ============================================================
 * Directly maps lead.function_ (SheetReader enum: HR, MARKETING, PRODUCT, etc.)
 * to a variant using FUNCTION_VARIANT_MAP.
 *
 * HR/LEADERSHIP/GENERAL have null primary and require context routing —
 * those are delegated to _scoreFounderContextBoost / _routeHRProfile.
 *
 * @param {string} leadFunction - Enum value from lead.function_
 * @param {string} variantKey
 * @param {Object} lead
 * @param {Object} dossier
 * @returns {number} 0-1.0
 */
function _scoreFunctionMatch(leadFunction, variantKey, lead, dossier) {
  if (!leadFunction) return 0.3;

  var fnKey = String(leadFunction).toUpperCase().trim();
  var map = FUNCTION_VARIANT_MAP[fnKey];

  // Unknown function enum → infer from free text
  if (!map) {
    var fn = String(leadFunction).toLowerCase();
    if (/market|growth|brand|content|seo|acquis/.test(fn))       return variantKey === 'GROWTH_MARKETING' ? 1.0 : 0.3;
    if (/product|ai|ml|data|engineer|tech|platform|rag/.test(fn))return variantKey === 'PRODUCT_AI_STRATEGY' ? 1.0 : 0.3;
    if (/operat|strategy|consult|process|finance|p&l/.test(fn))  return variantKey === 'OPS_CONSULTING' ? 1.0 : 0.3;
    return 0.35;
  }

  // Function has no clear primary (HR, LEADERSHIP, GENERAL) → flat baseline
  // Real routing happens via _routeHRProfile or _scoreFounderContextBoost
  if (!map.primary) {
    return variantKey === map.fallback ? 0.55 : 0.4;
  }

  if (variantKey === map.primary)   return 1.0;
  if (variantKey === map.secondary) return 0.55;
  return 0.2;
}

/**
 * ============================================================
 * SENIORITY FIT: _scoreSeniorityFit(seniority, archetype, variantKey)
 * ============================================================
 * Uses lead.seniority ENUM values from SheetReader._parseSeniority:
 *   C_SUITE, VP_DIRECTOR, SENIOR_MANAGER, MANAGER, JUNIOR, UNKNOWN
 *
 * CRITICAL FIX: senior levels NO LONGER give OPS a free pass.
 * Instead they give modest, balanced scores across variants, with the
 * founder/decision-maker routing happening in _scoreFounderContextBoost.
 *
 * @returns {number} 0-1.0
 */
function _scoreSeniorityFit(seniority, archetype, variantKey) {
  var sen = String(seniority || '').toUpperCase();
  var arch = String(archetype || '').toUpperCase();

  // Founders / C-Suite: balanced across variants (context boost picks the winner)
  if (sen === 'C_SUITE' || /FOUNDER|DECISION_MAKER/.test(arch)) {
    return 0.7; // Balanced baseline — no variant dominates on seniority alone
  }

  // VP / Director: PRODUCT_AI and OPS both credible (strategy layer), GROWTH slightly less
  if (sen === 'VP_DIRECTOR' || arch === 'EXECUTIVE') {
    if (variantKey === 'OPS_CONSULTING')      return 0.85;
    if (variantKey === 'PRODUCT_AI_STRATEGY') return 0.85;
    return 0.7; // GROWTH
  }

  // Senior Manager / Manager: all three credible; matches Gaurav's current level best
  if (sen === 'SENIOR_MANAGER' || sen === 'MANAGER' || arch === 'MANAGER') {
    return 0.9; // All variants equally credible at this level
  }

  // Junior / IC
  if (sen === 'JUNIOR' || arch === 'INDIVIDUAL_CONTRIBUTOR' || arch === 'PEER_CONTRIBUTOR') {
    return 0.75;
  }

  return 0.5;
}

/**
 * ============================================================
 * FOUNDER / DECISION-MAKER CONTEXT BOOST
 * ============================================================
 * When the lead is a founder/CEO/VP, their company's core business determines
 * which resume tells the right story:
 *   - AI/SaaS/DevTools company → PRODUCT_AI_STRATEGY wins
 *   - Consumer/D2C/Marketplace/EdTech → GROWTH_MARKETING wins
 *   - Enterprise/Logistics/Retail/Manufacturing → OPS_CONSULTING wins
 *
 * Applies only for senior leaders (C_SUITE, VP_DIRECTOR, founder archetype).
 * For ICs/Managers, their own function is the primary signal (via FunctionMatch).
 *
 * @returns {number} Adjustment points (not multiplied)
 */
function _scoreFounderContextBoost(lead, dossier, classification, variantKey) {
  var sen = String(lead.seniority || '').toUpperCase();
  var arch = String((classification && classification.archetype) || '').toUpperCase();
  var isSeniorLeader = lead.isFounder || sen === 'C_SUITE' || sen === 'VP_DIRECTOR' ||
                       /FOUNDER|DECISION_MAKER|EXECUTIVE/.test(arch);

  if (!isSeniorLeader) return 0;
  if (!dossier) return 0;

  var industry = String(dossier.industry || '').toLowerCase();
  var companyName = (dossier.co && dossier.co.name) ? String(dossier.co.name).toLowerCase() : '';
  var challenges = (dossier.co && dossier.co.challenges) ? String(dossier.co.challenges).toLowerCase() : '';
  var blob = industry + ' ' + companyName + ' ' + challenges;

  // AI / Product / Platform company signals
  if (/\b(ai|ml|llm|gen-?ai|rag|agent|platform|devtools?|developer tools|saas|deep tech|infra|api)\b/.test(blob)) {
    if (variantKey === 'PRODUCT_AI_STRATEGY') return 4;
    if (variantKey === 'OPS_CONSULTING') return -2;
    return 0;
  }

  // Consumer / Growth company signals
  if (/\b(d2c|b2c|consumer|marketplace|quick commerce|e-?commerce|edtech|foodtech|fintech|healthtech|dtc)\b/.test(blob)) {
    if (variantKey === 'GROWTH_MARKETING') return 4;
    if (variantKey === 'OPS_CONSULTING') return -1;
    return 0;
  }

  // Operations-heavy company signals
  if (/\b(logistics|manufacturing|retail|cpg|hospitality|warehous|supply chain|dark store|cloud kitchen|real estate|enterprise)\b/.test(blob)) {
    if (variantKey === 'OPS_CONSULTING') return 3;
    return 0;
  }

  // B2B SaaS ambiguous → slight PRODUCT_AI preference
  if (/\b(b2b|saas|enterprise software)\b/.test(blob)) {
    if (variantKey === 'PRODUCT_AI_STRATEGY') return 2;
    if (variantKey === 'GROWTH_MARKETING') return 1;
    return 0;
  }

  return 0;
}

/**
 * ============================================================
 * HR / RECRUITER ROUTING: _routeHRProfile(lead, dossier, classification)
 * ============================================================
 * HR profiles should NOT default to OPS. Pick the variant that matches
 * the ROLE being hired for, inferred from company context.
 *
 * Logic:
 *   1. If research picked a relevantVariant → trust it
 *   2. Else match company industry to variant
 *   3. Else default to GROWTH_MARKETING (Gaurav's strongest generalist story with metrics)
 *
 * @returns {string} variantId
 */
function _routeHRProfile(lead, dossier, classification) {
  // Trust research signal first
  if (dossier && dossier.relevantVariant && RESUME_PROFILES[dossier.relevantVariant]) {
    return dossier.relevantVariant;
  }

  if (!dossier) return 'GROWTH_MARKETING';

  var industry = String(dossier.industry || '').toLowerCase();
  var companyName = (dossier.co && dossier.co.name) ? String(dossier.co.name).toLowerCase() : '';
  var hiring = (dossier.co && dossier.co.hiringSignals) ? String(dossier.co.hiringSignals).toLowerCase() : '';
  var blob = industry + ' ' + companyName + ' ' + hiring;

  // AI/Tech HR → PRODUCT_AI
  if (/\b(ai|ml|llm|deep tech|saas|platform|devtools?|genai|infra)\b/.test(blob)) {
    return 'PRODUCT_AI_STRATEGY';
  }

  // Ops-heavy HR → OPS
  if (/\b(logistics|manufacturing|retail|cpg|warehous|supply chain|cloud kitchen|dark store|hospitality)\b/.test(blob)) {
    return 'OPS_CONSULTING';
  }

  // Consumer/Marketplace/Growth HR → GROWTH
  if (/\b(d2c|b2c|consumer|marketplace|e-?commerce|quick commerce|edtech|foodtech|fintech)\b/.test(blob)) {
    return 'GROWTH_MARKETING';
  }

  // Check hiring signals for specific role hints
  if (/\b(marketing|growth|brand|demand|performance)\b/.test(hiring))    return 'GROWTH_MARKETING';
  if (/\b(product|engineer|data|ai|ml|technical)\b/.test(hiring))         return 'PRODUCT_AI_STRATEGY';
  if (/\b(operat|strategy|consult|finance|supply)\b/.test(hiring))        return 'OPS_CONSULTING';

  // Final default: GROWTH_MARKETING (strongest metric-backed generalist story)
  return 'GROWTH_MARKETING';
}

/**
 * ============================================================
 * HOOK RELEVANCE: _scoreHookRelevance(hooks, variantKey)
 * ============================================================
 * Measures keyword match between research hooks and variant strengths.
 * Each match = +1, capped at 3 (which becomes 6 points with 2x weight)
 *
 * @param {Array} hooks - Personalization hooks from research (e.g., ['growth hacking', 'series a'])
 * @param {string} variantKey
 * @returns {number} 0-3 (0-6 when weighted by 2x)
 */
function _scoreHookRelevance(hooks, variantKey) {
  if (!hooks || hooks.length === 0) return 0;

  var profile = RESUME_PROFILES[variantKey];
  var matches = 0;

  // Check each hook against variant keywords
  for (var i = 0; i < hooks.length; i++) {
    var hookText = (typeof hooks[i] === 'object' ? hooks[i].text : hooks[i]) || '';
    var hook = hookText.toLowerCase();
    for (var j = 0; j < profile.hookKeywords.length; j++) {
      var keyword = profile.hookKeywords[j].toLowerCase();
      if (hook.indexOf(keyword) >= 0 || keyword.indexOf(hook) >= 0) {
        matches++;
        break; // Count once per hook
      }
    }
  }

  return Math.min(matches, 3); // Cap at 3 for 2x weighting = max 6
}

// NOTE: _edgeCaseAdjustment() was removed — its HR=>OPS and founder biases are
// now handled properly by _routeHRProfile() (hard override) and
// _scoreFounderContextBoost() (company-context-aware, not flat bias).

/**
 * ============================================================
 * LLM TIEBREAKER: _llmTiebreaker(lead, dossier, variant1, variant2)
 * ============================================================
 * When two variants score within 10%, use Gemini to pick the best fit.
 * Queries Gemini API with lead context and returns winning variant.
 * Falls back to variant1 if API fails.
 *
 * @param {Object} lead
 * @param {Object} dossier
 * @param {string} variant1 - First variant ID
 * @param {string} variant2 - Second variant ID
 * @returns {string} Winning variant ID
 */
function _llmTiebreaker(lead, dossier, variant1, variant2) {
  try {
    var profile1 = RESUME_PROFILES[variant1];
    var profile2 = RESUME_PROFILES[variant2];

    var prompt = 'You are a resume selector expert. Given a lead\'s profile, pick the best resume to send.\n\n' +
      'LEAD PROFILE:\n' +
      'Name: ' + lead.fullName + '\n' +
      'Title: ' + lead.designation + '\n' +
      'Company: ' + lead.organization + '\n' +
      'Headline: ' + lead.headline + '\n\n' +
      'RESEARCH:\n' +
      'Industry: ' + dossier.industry + '\n' +
      'Company Role: ' + dossier.role + '\n' +
      'Seniority: ' + dossier.seniority + '\n' +
      'Signals: ' + (dossier.signals || []).map(function(s) { return typeof s === 'object' ? (s.event || JSON.stringify(s)) : String(s); }).join(', ') + '\n\n' +
      'RESUME OPTIONS:\n' +
      'Option A (' + variant1 + '): Focused on ' + profile1.strengths.join(', ') + '\n' +
      'Option B (' + variant2 + '): Focused on ' + profile2.strengths.join(', ') + '\n\n' +
      'Which resume is the better fit? Reply ONLY with "A" or "B".';

    // ── PATCH `-p5-vendorresilience-config` (Phase 3a): MAX_TOKENS bump ──
    //
    // The previous maxTokens=5 was correct for the desired OUTPUT (single
    // char "A" or "B" — 1-2 output tokens). But Gemini 2.5+ thinking models
    // consume internal thinking tokens against the same budget BEFORE
    // producing visible output. With maxTokens=5, the model exhausts the
    // budget on internal thinking, returns no visible text, and the
    // tiebreaker silently falls back to variant1 EVERY TIME. That's
    // effectively a dead tiebreaker.
    //
    // Two-part fix:
    //   (a) Bump maxTokens to 64 to leave room for a small thinking budget
    //       + the visible output. Cost increase is trivial (~$0.0001/call).
    //   (b) Set thinkingConfig.thinkingBudget = 0 for the underlying request
    //       — disabling thinking for this single-char-answer use case.
    //       The `callGemini` wrapper applies thinkingConfig only when
    //       responseFormat==='json'; we pass it explicitly here because
    //       this is a text response.
    var result = callGemini(prompt, {
      temperature: 0,
      maxTokens: 64,
      thinkingBudget: 0   // forwarded to generationConfig.thinkingConfig
    });

    if (result.success && result.data) {
      var text = result.data.trim().toUpperCase();
      if (text.indexOf('A') >= 0) {
        Logger.log('[ResumeSelector] LLM tiebreaker chose ' + variant1);
        return variant1;
      } else if (text.indexOf('B') >= 0) {
        Logger.log('[ResumeSelector] LLM tiebreaker chose ' + variant2);
        return variant2;
      }
    }

    Logger.log('[ResumeSelector] LLM tiebreaker failed to parse, defaulting to ' + variant1);
    return variant1;

  } catch (err) {
    Logger.log('[ResumeSelector] LLM tiebreaker error: ' + err.message + ', using ' + variant1);
    return variant1;
  }
}

/**
 * ============================================================
 * HELPER: Build human-readable selection reason
 * ============================================================
 */
function _buildSelectionReason(winner, scores, dossier) {
  var profile = RESUME_PROFILES[winner];
  var reason = winner + ' selected. ';
  reason += 'Strengths: ' + profile.strengths.slice(0, 3).join(', ') + '. ';
  reason += 'Best fit for ' + (dossier.industry || 'industry') + ' role.';
  return reason;
}

/**
 * ============================================================
 * RESUME BLOB RETRIEVAL: getResumeBlob(variantId)
 * ============================================================
 * Fetches the resume PDF file blob from Google Drive.
 * Uses the Drive ID stored in Script Properties.
 *
 * @param {string} variantId - Resume variant ID (e.g., 'GROWTH_MARKETING')
 * @returns {Blob} PDF file blob, or null if not found
 */
function getResumeBlob(variantId) {
  try {
    var profile = RESUME_PROFILES[variantId];
    if (!profile) {
      Logger.log('[ResumeSelector] Unknown variant: ' + variantId);
      return null;
    }

    // Get Drive ID from properties
    var props = PropertiesService.getScriptProperties();
    var driveId = props.getProperty(profile.driveIdKey);

    if (!driveId) {
      Logger.log('[ResumeSelector] No Drive ID set for ' + variantId);
      return null;
    }

    // Fetch file by ID
    var file = DriveApp.getFileById(driveId);
    var blob = file.getBlob();

    Logger.log('[ResumeSelector] Retrieved blob for ' + variantId + ' (' + blob.getBytes().length + ' bytes)');
    return blob;

  } catch (err) {
    Logger.log('[ResumeSelector] Error retrieving blob for ' + variantId + ': ' + err.message);
    return null;
  }
}

/**
 * ============================================================
 * RESUME FILENAME: getResumeFileName(variantId)
 * ============================================================
 * Returns the filename for the resume variant (for attachment naming).
 *
 * @param {string} variantId
 * @returns {string} Filename (e.g., 'Resume_Gaurav_Growth_Marketing_2page.pdf')
 */
function getResumeFileName(variantId) {
  var profile = RESUME_PROFILES[variantId];
  if (!profile) {
    Logger.log('[ResumeSelector] Unknown variant for filename: ' + variantId);
    return 'Resume_Default.pdf';
  }
  return profile.fileName;
}

/**
 * ============================================================
 * RESUME HIGHLIGHTS: getResumeHighlights(variantId)
 * ============================================================
 * Returns the top 5 metric-backed achievements for each resume variant.
 * Used by EmailComposer to feed resume content into the Claude prompt.
 *
 * @param {string} variantId - Resume variant ID (e.g., 'GROWTH_MARKETING')
 * @returns {Array<string>} Array of 5 metric-backed achievements
 */
function getResumeHighlights(variantId) {
  var highlights = {
    GROWTH_MARKETING: [
      'Built GTM for 38 dark stores driving 15% YoY expansion and doubling DAUs across 5 cities',
      'Scaled referral program from 0 to Rs 1.5 Cr in 4 months via ABM and MarTech',
      'Architected AI-powered B2B email system cutting drafting time by 85% across 8 MarTech tools',
      'Cut marketing costs by 40% via hyperlocal BTL site selection framework',
      'Improved APAC lead conversion by 25% and reduced CAC by 30% through predictive scoring and A/B testing'
    ],
    OPS_CONSULTING: [
      'Manages P&L, quality, and SLAs across ~50 cloud kitchens in 4 cities at Blinkit Bistro (Zomato)',
      'Built 35,022-formula P&L workbook identifying 13 margin interventions worth Rs 68L annualized',
      'Spearheaded first-ever inventory location migration enabling 10-15 min delivery SLA',
      'Resolved quality crisis: 121K orders analyzed, complaint rate cut by 94%, closed 40% quality gap in 2.5 weeks',
      'Architected KDS-triggered replenishment automating ~200 daily restocking cycles with ~100% adherence'
    ],
    PRODUCT_AI_STRATEGY: [
      'Architected 6-component AI email pipeline at Thoughtworks cutting B2B drafting by 85% and boosting conversion 25%',
      'Built domain-restricted RAG system on Weaviate with predictive lead scoring and behavioral triggers',
      'Developed 800K+ character context-aware email generation system with Python and Google Sheets/Docs API',
      'Created B2B segmentation framework (4x5x3x4) adopted across Thoughtworks global marketing',
      'Built 35,022-formula dynamic P&L workbook with per-dish unit economics and margin interventions'
    ]
  };
  return highlights[variantId] || highlights.GROWTH_MARKETING;
}
