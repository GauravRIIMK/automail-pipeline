/**
 * ============================================================
 * Classifier.gs — Stage 2.5: Adaptive Lead Classifier
 * Analyzes lead profiles and dossiers to select email template,
 * determine archetype, detect edge cases, and set approach.
 * REFRAMED FOR: Job-seeking cold emails (Gaurav seeking roles at Indian startups)
 * ============================================================
 */

// ─── ARCHETYPE DETECTION REGEXES (PATCH 2026-05-13) ──────────
// HR_TITLE_REGEX catches Recruiter / TA / People-Ops roles by title/headline.
// CXO_TITLE_REGEX — TIGHTENED 2026-05-13: only matches TRUE super-senior titles.
//
// Why so conservative:
//   - Titles can be misleading. "Head of Growth" at a 30-person startup is
//     Senior-Director-equivalent, not C-Suite. They benefit from the STANDARD
//     pitch with the 3 AI projects bullet block, not the brief CXO_SHORT shape.
//   - "VP <function>" is functional leadership, not board-adjacent. STANDARD
//     applies. Same logic for CTO/CMO of <100-person companies.
//   - Solo / bootstrap founders need full credentials + AI projects to build
//     trust; they're not "too senior to read a long email."
//
// Removed from CXO route: 'cto', 'cmo', 'vp ', 'svp ', 'evp ', 'head of',
// 'founder', 'co-founder', 'cofounder', and bare 'chief' (substring of many
// titles). The remaining regex catches only board-and-above titles.
var HR_TITLE_REGEX = /\b(recruiter|recruiting|talent acquisition|talent partner|people ops|people operations|people & culture|hr manager|hr lead|hrbp|hr business partner|ta lead|ta manager|staffing|head of people|head of talent)\b/i;
var CXO_TITLE_REGEX = /\b(ceo|cfo|coo|chief\s+\w+(?:\s+\w+)?\s+officer|chairman|chairperson|chairwoman|president|managing\s+director|managing\s+partner)\b/i;

// ─── COMPANY STAGE ROUTING ─────────────────────────────────
// Maps company stage to template/approach preferences
// REFRAMED: Tone adjustments emphasize team expansion, growth needs, hiring signals
var COMPANY_STAGE_ROUTES = {
  SEED: {
    stage: 'SEED',
    templates: ['T5_HIRING_GROWTH', 'T4_TRIGGER_EVENT', 'T3_SHARED_BACKGROUND'],
    toneAdjustment: 'entrepreneurial, builder-to-builder tone, emphasize Gaurav\'s startup versatility',
    expectedResponse: 'high'
  },
  SERIES_A: {
    stage: 'SERIES_A',
    templates: ['T4_TRIGGER_EVENT', 'T2_DOMAIN_EXPERT', 'T3_SHARED_BACKGROUND'],
    toneAdjustment: 'growth-focused, show scaling experience, emphasize GTM and ops',
    expectedResponse: 'medium-high'
  },
  SERIES_B: {
    stage: 'SERIES_B',
    templates: ['T2_DOMAIN_EXPERT', 'T4_TRIGGER_EVENT', 'T1_FOUNDER_NO_ROLE'],
    toneAdjustment: 'strategic, show P&L and process thinking, emphasize structured execution',
    expectedResponse: 'medium'
  },
  SERIES_C_PLUS: {
    stage: 'SERIES_C_PLUS',
    templates: ['T1_FOUNDER_NO_ROLE', 'T2_DOMAIN_EXPERT', 'T6_MUTUAL_CONNECTION'],
    toneAdjustment: 'executive-level, brief, high-signal credentials only',
    expectedResponse: 'low-medium'
  },
  PROFITABLE: {
    stage: 'PROFITABLE',
    templates: ['T1_FOUNDER_NO_ROLE', 'T2_DOMAIN_EXPERT', 'T6_MUTUAL_CONNECTION'],
    toneAdjustment: 'mature, business-value focused, emphasis on strategic impact',
    expectedResponse: 'low'
  },
  PUBLIC: {
    stage: 'PUBLIC',
    templates: ['T6_MUTUAL_CONNECTION', 'T2_DOMAIN_EXPERT', 'T1_FOUNDER_NO_ROLE'],
    toneAdjustment: 'ultra-concise, institutional credibility (IIMK, Zomato), respectful of process',
    expectedResponse: 'very-low'
  }
};

// ─── EDGE CASE DEFINITIONS ────────────────────────────────
// REFRAMED: All edge cases now evaluated in job-seeking context
var EDGE_CASES = {
  HR_RECRUITER: {
    detection: 'HR role detected',
    action: 'professional, role-focused, mention specific skills match',
    skipIfFounderExists: true,
    maxPerCompany: 1,
    templateOverride: 'HR_PARTNERSHIP'
  },
  SAME_COMPANY_CLUSTER: {
    detection: 'Multiple leads from same organization',
    action: 'prioritize seniority, skip junior if senior exists',
    maxPerWeek: 2,
    skipIfSeniorExists: true
  },
  VIP_HIGH_VOLUME: {
    detection: 'High-profile name or massive company (>10k employees)',
    action: 'ultra-brief, single credential, question-based CTA',
    emailWordLimit: 100,
    expectedResponse: 'very-low'
  },
  JUNIOR_PEER: {
    detection: 'Junior role at target company with shared background',
    action: 'peer-to-peer tone',
    toneAdjustment: 'equal, collaborative, peer builder conversation',
    expectedResponse: 'high'
  },
  DOMAIN_MISMATCH: {
    detection: 'Company domain does not match organization field',
    action: 'research mismatch reason, may indicate recent job change',
    riskLevel: 'medium'
  },
  RECENTLY_FUNDED: {
    detection: 'Funding event mentioned in dossier.triggers',
    action: 'company expanding → teams growing → natural timing for outreach',
    templateOverride: 'T4_TRIGGER_EVENT',
    expectedResponse: 'high'
  },
  ALUMNI_NETWORK: {
    detection: 'Shared university or school background',
    action: 'open with alma mater connection',
    templateOverride: 'T3_SHARED_BACKGROUND',
    expectedResponse: 'medium-high'
  },
  CONTENT_CREATOR: {
    detection: 'Published content (blogs, papers, talks) detected',
    action: 'earned compliment about their content → ask for conversation',
    templateOverride: 'T2_DOMAIN_EXPERT',
    expectedResponse: 'high'
  },
  STEALTH_STARTUP: {
    detection: 'Early-stage founder at unfunded or hidden-stage company',
    action: 'founder-to-founder tone',
    toneAdjustment: 'peer, respect for bootstrapping',
    expectedResponse: 'medium'
  },
  CAREER_SWITCH_TARGET: {
    detection: 'Career pivot in last 2 years + hiring signals',
    action: 'new growth opportunity focus',
    templateOverride: 'T5_HIRING_GROWTH',
    expectedResponse: 'medium-high'
  },
  FOUNDER_LEAD: {
    detection: 'CEO/Founder/Co-founder title',
    action: 'peer-to-peer builder conversation, not pitching services',
    templateOverride: 'T1_FOUNDER_NO_ROLE',
    expectedResponse: 'medium'
  }
};

// ─── MAIN CLASSIFIER FUNCTION ──────────────────────────────

/**
 * Main classification function. Analyzes a lead and dossier,
 * returns a comprehensive ClassificationResult.
 *
 * @param {Object} lead - LeadProfile from SheetReader
 * @param {Object} dossier - Research result from ResearchEngine with
 *                            structure: { co: {stage, size}, triggers: [], ... }
 * @returns {Object} ClassificationResult
 */
function classifyLead(lead, dossier) {
  try {
    // Detect edge cases first
    var edgeCases = _detectEdgeCases(lead, dossier);

    // Get company stage routing
    var stageRoute = _getCompanyStageRoute(dossier);

    // Select template based on lead profile + edge cases + triggers
    var template = _selectTemplate(lead, dossier, edgeCases, stageRoute);

    // Determine archetype from template + seniority
    var archetype = _determineArchetype(lead, dossier, { template: template });

    // Apply edge case adjustments (tone, length, etc.)
    var result = {
      archetype: archetype,
      template: template,
      edgeCases: edgeCases,
      approach: _buildApproachString(lead, template, edgeCases),
      confidence: _calculateConfidence(lead, dossier, edgeCases),
      sniperVsBatch: _classifySniperBatch(lead, dossier, { template: template }),
      status: STATUS.CLASSIFYING,
      timestamp: new Date().toISOString()
    };

    // Apply edge case adjustments
    result = _applyEdgeCaseAdjustments(result, lead, dossier);

    // Log result
    logPipelineEvent(lead.rowNum, 'CLASSIFY',
      'Classified as ' + result.archetype + ', template: ' + result.template +
      ', edge cases: ' + result.edgeCases.join('; '));

    return result;

  } catch (e) {
    // Fallback: informational template
    logPipelineEvent(lead.rowNum, 'CLASSIFY',
      'Classification failed: ' + e.message + ' — falling back to T8_INFORMATIONAL', 'ERROR');

    return {
      archetype: 'UNKNOWN',
      template: 'T8_INFORMATIONAL',
      edgeCases: [],
      approach: 'Generic informational approach',
      confidence: 0.3,
      sniperVsBatch: 'BATCH',
      status: STATUS.CLASSIFYING,
      error: e.message,
      timestamp: new Date().toISOString()
    };
  }
}

// ─── EDGE CASE DETECTION ──────────────────────────────────

/**
 * Detects 11 edge cases that modify approach.
 * @param {Object} lead
 * @param {Object} dossier
 * @returns {Array<string>} Array of detected edge case keys
 */
function _detectEdgeCases(lead, dossier) {
  var detected = [];

  // 0. CXO_SHORT — checked BEFORE HR so a VP of HR is routed as CXO first.
  //
  // PATCH 2026-05-13: tightened gating so STANDARD becomes the default. We now
  // require BOTH a true C-Suite title (per the tightened CXO_TITLE_REGEX above)
  // AND a "mature" company context. Title alone is insufficient — a CEO of a
  // 10-person startup still benefits from STANDARD's full pitch.
  //
  // "Mature" company = any of:
  //   - dossier.co.stage in {SERIES_C_PLUS, PROFITABLE, PUBLIC}
  //   - dossier.co.size >= 500 employees
  //   - lead.seniority === 'C_SUITE' (explicit upstream signal)
  //
  // Everything else (including VP, Director, Head Of, small-company founder)
  // falls through to STANDARD with the canonical 3 AI projects bullet block.
  //
  // PATCH 2026-05-18 (improvement #3): also accept VP_DIRECTOR with
  // explicit "high" dossier.decisionPower as a third path into CXO_SHORT.
  // Catches the "Head Of <X> at large enterprise who's actually a decision-
  // maker" case that title-regex alone misses. Conservative — junior /
  // manager seniority levels do NOT qualify even with high decision power
  // (decision-power claims at lower seniority are usually Gemini overstating).
  var isCxoTitle = CXO_TITLE_REGEX.test(lead.designation || '')
      || CXO_TITLE_REGEX.test(lead.headline || '');
  var hasCSuiteSeniority = (lead.seniority === 'C_SUITE');
  var stageMature = false;
  if (dossier && dossier.co && dossier.co.stage) {
    var coStage = (dossier.co.stage || '').toString().toUpperCase();
    stageMature = (coStage === 'SERIES_C_PLUS' || coStage === 'PROFITABLE' || coStage === 'PUBLIC');
  }
  var companyLarge = !!(dossier && dossier.co && dossier.co.size && dossier.co.size >= 500);
  var hasHighDecisionPower = !!(dossier && dossier.decisionPower
      && /^(very[\s-]?high|high)\b/i.test(dossier.decisionPower.toString().trim()));
  var isExecutiveSeniority = (lead.seniority === 'C_SUITE' || lead.seniority === 'VP_DIRECTOR');
  var isCxo = hasCSuiteSeniority
      || (isCxoTitle && (stageMature || companyLarge))
      || (hasHighDecisionPower && isExecutiveSeniority);
  if (isCxo) {
    detected.push('CXO_SHORT');
  }

  // 1. HR_RECRUITER — flag-based OR title/headline regex (PATCH 2026-05-12)
  var isHrByFlag  = !!lead.isHR;
  var isHrByTitle = HR_TITLE_REGEX.test(lead.designation || '') || HR_TITLE_REGEX.test(lead.headline || '');
  if (isHrByFlag || isHrByTitle) {
    detected.push('HR_RECRUITER');
  }

  // 2. SAME_COMPANY_CLUSTER
  var clusterSkip = checkClusterSkip(lead);
  if (clusterSkip && clusterSkip.skip) {
    detected.push('SAME_COMPANY_CLUSTER');
  }

  // 3. VIP_HIGH_VOLUME
  if (dossier && dossier.co && dossier.co.size && dossier.co.size >= 10000) {
    detected.push('VIP_HIGH_VOLUME');
  }

  // 4. JUNIOR_PEER
  if (lead.seniority === 'JUNIOR' && lead.function_ === 'ENGINEERING' &&
      dossier && dossier.co && dossier.co.stage &&
      ['SEED', 'SERIES_A'].indexOf(dossier.co.stage) >= 0) {
    detected.push('JUNIOR_PEER');
  }

  // 5. DOMAIN_MISMATCH
  if (lead.email && dossier && dossier.co && dossier.co.domain) {
    var leadDomain = lead.email.split('@')[1];
    if (leadDomain && dossier.co.domain && leadDomain !== dossier.co.domain) {
      detected.push('DOMAIN_MISMATCH');
    }
  }

  // 6. RECENTLY_FUNDED
  // Trigger objects from _identifyTriggers have .event field, not .type
  if (dossier && dossier.triggers && dossier.triggers.length > 0) {
    var hasFundingTrigger = dossier.triggers.some(function(t) {
      var searchStr = (t.event || t.type || '');
      return /fund|series|raised/i.test(searchStr);
    });
    if (hasFundingTrigger) {
      detected.push('RECENTLY_FUNDED');
    }
  }

  // 7. ALUMNI_NETWORK — dossier.education is null after decompression;
  // use lead.headline directly (always available)
  if (lead.headline && /stanford|harvard|mit|iit|delhi|bombay|iimk|kozhikode/i.test(lead.headline)) {
    detected.push('ALUMNI_NETWORK');
  }

  // 8. CONTENT_CREATOR
  if (dossier && dossier.contentLinks && dossier.contentLinks.length > 0) {
    detected.push('CONTENT_CREATOR');
  }

  // 9. STEALTH_STARTUP
  if (lead.isFounder && dossier && dossier.co && dossier.co.stage === 'STEALTH') {
    detected.push('STEALTH_STARTUP');
  }

  // 10. CAREER_SWITCH_TARGET
  if (dossier && dossier.recentCareerSwitch && dossier.co && dossier.co.hiringSignals) {
    detected.push('CAREER_SWITCH_TARGET');
  }

  // 11. FOUNDER_LEAD
  if (lead.isFounder) {
    detected.push('FOUNDER_LEAD');
  }

  // ── PATCH 2026-05-18: dossier-derived signals (improvement #3) ──
  //
  // ResearchEngine populates dossier.decisionPower and dossier.communicationStyle
  // for every lead, but they were never read by the classifier — wasted
  // intelligence. These two signals carry information that title-regex
  // alone misses, especially for:
  //   • "Director / Head Of / Senior IC" roles where the title ambiguously
  //     spans low- to high-authority depending on company structure
  //   • Recipients whose LinkedIn style flags a tone preference (data-first
  //     vs narrative-first) that should drive the opening sentence
  //
  // 12. HIGH_DECISION_POWER — research dossier explicitly classifies this
  //     person as a decision-maker. Acts as a tone modulator + (when
  //     combined with VP_DIRECTOR seniority) as a soft CXO_SHORT eligibility
  //     signal. Conservative: requires explicit "high" string, ignores
  //     fuzzy or "medium-high" because Gemini emits those generously.
  if (dossier && dossier.decisionPower
      && /^(very[\s-]?high|high)\b/i.test(dossier.decisionPower.toString().trim())) {
    detected.push('HIGH_DECISION_POWER');
  }

  // 13. DATA_DRIVEN_STYLE — recipient's communication style is metric-led /
  //     analytical. Composer should lead with a number in the hook.
  if (dossier && dossier.communicationStyle
      && /\b(data[\s-]?driven|analytical|quantitative|metric|results[\s-]?oriented|numbers[\s-]?first)\b/i
          .test(dossier.communicationStyle.toString())) {
    detected.push('DATA_DRIVEN_STYLE');
  }

  // 14. NARRATIVE_STYLE — recipient prefers story / context / vision framing
  //     over hard numbers. Composer should soften the metric-density and
  //     lean on the "thread across all three" synthesis.
  if (dossier && dossier.communicationStyle
      && /\b(narrative|story|vision|thoughtful|reflective|conceptual|big[\s-]?picture)\b/i
          .test(dossier.communicationStyle.toString())) {
    detected.push('NARRATIVE_STYLE');
  }

  return detected;
}

// ─── COMPANY STAGE ROUTING ────────────────────────────────

/**
 * Gets the company stage route from dossier.co.stage
 * @param {Object} dossier
 * @returns {Object} COMPANY_STAGE_ROUTES entry
 */
function _getCompanyStageRoute(dossier) {
  if (!dossier || !dossier.co || !dossier.co.stage) {
    return COMPANY_STAGE_ROUTES.SERIES_A; // Default fallback
  }

  var stage = dossier.co.stage.toUpperCase();
  return COMPANY_STAGE_ROUTES[stage] || COMPANY_STAGE_ROUTES.SERIES_A;
}

// ─── TEMPLATE SELECTION ────────────────────────────────────

/**
 * _t4TriggerQualifies(edgeCases, triggers) — PURE helper (no side-effects).
 * PATCH 2026-06-12-autonomous-close: determines whether a trigger set justifies
 * the T4_TRIGGER_EVENT template under strict mode.
 *
 * Returns true if:
 *   (a) edgeCases contains 'RECENTLY_FUNDED', OR
 *   (b) the first trigger's event/type matches a qualifying funding/expansion keyword.
 *
 * Generic triggers ('new office plant', 'team outing', etc.) return false, letting
 * T1/T2/T3/T5 win their natural cases instead of always forcing T4.
 *
 * @param {Array} edgeCases
 * @param {Array} triggers — each has .event and/or .type
 * @returns {boolean}
 */
function _t4TriggerQualifies(edgeCases, triggers) {
  if (edgeCases && edgeCases.indexOf('RECENTLY_FUNDED') >= 0) return true;
  if (!triggers || !triggers.length) return false;
  var firstEvent = String((triggers[0].event || triggers[0].type || '')).toLowerCase();
  return /fund|rais|series\s+[a-z]\b|ipo|acquisi|launch|expan|partner/i.test(firstEvent);
}

/**
 * Priority-based template selection.
 * CRITICAL: T4 trigger events handled in single if/else if block
 * to prevent duplicate T4 selection.
 *
 * @param {Object} lead
 * @param {Object} dossier
 * @param {Array} edgeCases
 * @param {Object} stageRoute
 * @returns {string} Template name (e.g., 'T1_FOUNDER_NO_ROLE')
 */
function _selectTemplate(lead, dossier, edgeCases, stageRoute) {
  var candidates = [];

  // Priority 1: Specific edge case overrides (CXO before HR — VP of HR is CXO first)
  if (edgeCases.indexOf('CXO_SHORT') >= 0) {
    return 'CXO_SHORT';
  }

  if (edgeCases.indexOf('HR_RECRUITER') >= 0) {
    return 'HR_PARTNERSHIP';
  }

  if (edgeCases.indexOf('CONTENT_CREATOR') >= 0) {
    candidates.push({ template: 'T2_DOMAIN_EXPERT', priority: 1, reasoning: 'Published content detected' });
  }

  if (edgeCases.indexOf('ALUMNI_NETWORK') >= 0) {
    candidates.push({ template: 'T3_SHARED_BACKGROUND', priority: 2, reasoning: 'Alumni network connection' });
  }

  // Priority 2: Founder-specific handling
  // CRITICAL FIX: null-safe guard for T1_FOUNDER_NO_ROLE
  if (edgeCases.indexOf('FOUNDER_LEAD') >= 0 && !(dossier && dossier.co && dossier.co.hiringSignals)) {
    candidates.push({ template: 'T1_FOUNDER_NO_ROLE', priority: 2, reasoning: 'Founder with no active hiring' });
  }

  // Priority 3: Trigger events — CRITICAL FIX: Single if/else if block
  // PATCH 2026-06-12-autonomous-close: TEMPLATE_TRIGGER_STRICT gate (default STRICT=true).
  // When strict, only push T4 if RECENTLY_FUNDED edgeCase is present OR the first
  // trigger's event/type matches a qualifying funding/expansion keyword. Generic triggers
  // (e.g. 'new office plant') no longer force T4 when strict, letting T1/T2/T3/T5 win.
  // Rollback: set CONFIG.TEMPLATE_TRIGGER_STRICT = false (no code push needed).
  var _trigStrict = !(CONFIG && CONFIG.TEMPLATE_TRIGGER_STRICT === false);
  if (dossier && dossier.triggers && dossier.triggers.length > 0) {
    if (!_trigStrict || _t4TriggerQualifies(edgeCases, dossier.triggers)) {
      var triggerReasoning = edgeCases.indexOf('RECENTLY_FUNDED') >= 0
        ? 'Recent funding event detected'
        : 'Trigger event: ' + (dossier.triggers[0].event || dossier.triggers[0].type || '');
      candidates.push({ template: 'T4_TRIGGER_EVENT', priority: 3, reasoning: triggerReasoning });
    }
  } else if (edgeCases.indexOf('RECENTLY_FUNDED') >= 0) {
    candidates.push({ template: 'T4_TRIGGER_EVENT', priority: 3, reasoning: 'Recent funding event detected' });
  }

  // Priority 4: Role/function matching
  if (lead.seniority === 'C_SUITE' || lead.seniority === 'VP_DIRECTOR') {
    candidates.push({ template: 'T1_FOUNDER_NO_ROLE', priority: 4, reasoning: 'Executive seniority' });
  }

  if (lead.function_ === 'PRODUCT' || lead.function_ === 'ENGINEERING') {
    candidates.push({ template: 'T2_DOMAIN_EXPERT', priority: 4, reasoning: 'Technical function match' });
  }

  if (lead.function_ === 'MARKETING' || lead.function_ === 'SALES') {
    candidates.push({ template: 'T5_HIRING_GROWTH', priority: 4, reasoning: 'Growth function match' });
  }

  // Priority 5: Company stage preference
  if (stageRoute && stageRoute.templates && stageRoute.templates.length > 0) {
    candidates.push({
      template: stageRoute.templates[0],
      priority: 5,
      reasoning: 'Company stage preference: ' + stageRoute.stage
    });
  }

  // Priority 6: Fallback by seniority
  if (lead.seniority === 'MANAGER' || lead.seniority === 'SENIOR_MANAGER') {
    candidates.push({ template: 'T3_SHARED_BACKGROUND', priority: 6, reasoning: 'Manager-level: shared background' });
  }

  if (lead.seniority === 'JUNIOR') {
    candidates.push({ template: 'T3_SHARED_BACKGROUND', priority: 6, reasoning: 'Junior: peer approach' });
  }

  // Default if no candidates
  if (candidates.length === 0) {
    candidates.push({ template: 'T3_SHARED_BACKGROUND', priority: 10, reasoning: 'Default fallback' });
  }

  // Sort by priority and return top candidate
  candidates.sort(function(a, b) { return a.priority - b.priority; });
  return candidates[0].template;
}

// ─── ARCHETYPE DETERMINATION ──────────────────────────────

/**
 * Maps template + seniority to archetype labels.
 * @param {Object} lead
 * @param {Object} dossier
 * @param {Object} classification
 * @returns {string} Archetype label
 */
function _determineArchetype(lead, dossier, classification) {
  var template = classification.template || '';
  var seniority = lead.seniority || 'UNKNOWN';

  // Template-based archetypes
  if (template === 'T1_FOUNDER_NO_ROLE') {
    return 'FOUNDER_DIRECT';
  }
  if (template === 'T2_DOMAIN_EXPERT') {
    return 'DOMAIN_EXPERT';
  }
  if (template === 'T3_SHARED_BACKGROUND') {
    return 'PEER_CONTRIBUTOR';
  }
  if (template === 'T4_TRIGGER_EVENT') {
    return 'OPPORTUNITY_SEEKER';
  }
  if (template === 'T5_HIRING_GROWTH') {
    return 'GROWTH_PARTNER';
  }
  if (template === 'T6_MUTUAL_CONNECTION') {
    return 'CONNECTOR';
  }
  if (template === 'HR_PARTNERSHIP') {
    return 'HR_RECRUITER';
  }
  if (template === 'CXO_SHORT') {
    return 'CXO_SHORT';
  }

  // Fallback by seniority
  if (seniority === 'C_SUITE') {
    return 'DECISION_MAKER';
  }
  if (seniority === 'VP_DIRECTOR') {
    return 'EXECUTIVE';
  }
  if (seniority === 'MANAGER' || seniority === 'SENIOR_MANAGER') {
    return 'MANAGER';
  }
  if (seniority === 'JUNIOR') {
    return 'INDIVIDUAL_CONTRIBUTOR';
  }

  return 'GENERAL_PROFESSIONAL';
}

// ─── EDGE CASE ADJUSTMENTS ────────────────────────────────

/**
 * Applies adjustments to result based on edge cases.
 * E.g., VIP: shorter email, HR: more formal, etc.
 *
 * @param {Object} result - ClassificationResult
 * @param {Object} lead
 * @param {Object} dossier
 * @returns {Object} Adjusted result
 */
function _applyEdgeCaseAdjustments(result, lead, dossier) {
  var edgeCases = result.edgeCases || [];

  // VIP_HIGH_VOLUME: shorten email, reduce pitch
  if (edgeCases.indexOf('VIP_HIGH_VOLUME') >= 0) {
    result.emailWordLimit = 100;
    result.toneAdjustment = 'ultra-brief, single high-signal credential, question-based opening';
    result.expectedResponse = 'very-low';
  }

  // CXO_SHORT: ultra-brief, high-signal
  if (edgeCases.indexOf('CXO_SHORT') >= 0) {
    result.emailWordLimit = 120;
    result.toneAdjustment = 'executive brief, high-signal, 100-120 words max';
    result.expectedResponse = 'medium';
  }

  // HR_RECRUITER: professional, opportunity-focused
  if (edgeCases.indexOf('HR_RECRUITER') >= 0) {
    result.toneAdjustment = 'professional, role-focused, mention specific skills match';
    result.expectedResponse = 'medium-high';
  }

  // JUNIOR_PEER: peer-to-peer
  if (edgeCases.indexOf('JUNIOR_PEER') >= 0) {
    result.toneAdjustment = 'peer-to-peer, collaborative, builder-to-builder';
    result.expectedResponse = 'high';
  }

  // STEALTH_STARTUP: founder respect
  if (edgeCases.indexOf('STEALTH_STARTUP') >= 0) {
    result.toneAdjustment = 'founder-to-founder, respect for bootstrapping';
    result.expectedResponse = 'medium';
  }

  // RECENTLY_FUNDED: high signal, momentum-focused
  if (edgeCases.indexOf('RECENTLY_FUNDED') >= 0) {
    result.toneAdjustment = 'growth-aware, team expansion momentum, natural timing for conversation';
    result.expectedResponse = 'high';
  }

  // DOMAIN_MISMATCH: flag for review
  if (edgeCases.indexOf('DOMAIN_MISMATCH') >= 0) {
    result.riskFlag = 'DOMAIN_MISMATCH: lead may have changed jobs recently';
  }

  // ── PATCH 2026-05-18 (improvement #3): expose research signals to ──
  // EmailComposer so the composer can modulate prompt tone. Stored on
  // result.researchSignals (consumed by _buildCompositionContext +
  // _buildSystemPrompt). Conservative defaults so absence is a no-op.
  result.researchSignals = {
    highDecisionPower: edgeCases.indexOf('HIGH_DECISION_POWER') >= 0,
    dataDrivenStyle:   edgeCases.indexOf('DATA_DRIVEN_STYLE') >= 0,
    narrativeStyle:    edgeCases.indexOf('NARRATIVE_STYLE') >= 0,
    rawDecisionPower:  (dossier && dossier.decisionPower) ? dossier.decisionPower.toString() : '',
    rawCommStyle:      (dossier && dossier.communicationStyle) ? dossier.communicationStyle.toString() : ''
  };

  // High decision power adds a tone overlay even when the shape didn't
  // change. "Don't bury the lede" → composer should lead with one
  // concrete signal in sentence 1, skip throat-clearing context.
  if (edgeCases.indexOf('HIGH_DECISION_POWER') >= 0
      && edgeCases.indexOf('CXO_SHORT') < 0) {
    var existingTone = result.toneAdjustment || '';
    result.toneAdjustment = (existingTone ? existingTone + '. ' : '')
      + 'Recipient is a decision-maker — open with the strongest concrete '
      + 'signal in sentence 1, skip warm-up framing.';
  }

  // Data-driven style: tighten the first 2 sentences around a metric
  if (edgeCases.indexOf('DATA_DRIVEN_STYLE') >= 0) {
    var existingTone2 = result.toneAdjustment || '';
    result.toneAdjustment = (existingTone2 ? existingTone2 + '. ' : '')
      + 'Recipient is data-driven — hook MUST include one specific number '
      + '(revenue, growth %, headcount, or year) in the first or second sentence.';
  }

  // Narrative style: emphasize the synthesis line, soften metric density
  if (edgeCases.indexOf('NARRATIVE_STYLE') >= 0) {
    var existingTone3 = result.toneAdjustment || '';
    result.toneAdjustment = (existingTone3 ? existingTone3 + '. ' : '')
      + 'Recipient prefers narrative framing — lead bullets with the '
      + 'category-label theme (the "why") before the metric (the "what").';
  }

  return result;
}

// ─── SNIPER VS BATCH CLASSIFICATION ─────────────────────

/**
 * Scores whether lead should be sniped individually (high-touch)
 * or batched (standard). Threshold: 4+ points = SNIPER.
 *
 * @param {Object} lead
 * @param {Object} dossier
 * @param {Object} result
 * @returns {string} 'SNIPER' or 'BATCH'
 */
function _classifySniperBatch(lead, dossier, result) {
  var score = 0;

  // High seniority: +2
  if (lead.seniority === 'C_SUITE' || lead.seniority === 'VP_DIRECTOR') {
    score += 2;
  }

  // Founder: +2
  if (lead.isFounder) {
    score += 2;
  }

  // Trigger event present: +2
  if (dossier && dossier.triggers && dossier.triggers.length > 0) {
    score += 2;
  }

  // Published content: +1
  if (dossier && dossier.contentLinks && dossier.contentLinks.length > 0) {
    score += 1;
  }

  // Shared background: +1
  // Bug #7 fix: sharedBackground is an array; check length, not truthiness
  if (dossier && dossier.sharedBackground && dossier.sharedBackground.length > 0) {
    score += 1;
  }

  // Junior peer with good company stage: +1
  if (lead.seniority === 'JUNIOR' && dossier && dossier.co &&
      ['SEED', 'SERIES_A'].indexOf(dossier.co.stage) >= 0) {
    score += 1;
  }

  return score >= 4 ? 'SNIPER' : 'BATCH';
}

// ─── CONFIDENCE CALCULATION ───────────────────────────────

/**
 * Calculates confidence (0-1) based on data completeness and signals.
 * @param {Object} lead
 * @param {Object} dossier
 * @param {Array} edgeCases
 * @returns {number} Confidence score 0-1
 */
function _calculateConfidence(lead, dossier, edgeCases) {
  var score = 0.5; // Start at 0.5

  // Data completeness
  if (lead.email) score += 0.1;
  if (lead.designation) score += 0.05;
  if (lead.organization) score += 0.05;

  // Dossier signals
  if (dossier && dossier.co && dossier.co.stage) score += 0.1;
  if (dossier && dossier.triggers && dossier.triggers.length > 0) score += 0.1;
  if (dossier && dossier.contentLinks && dossier.contentLinks.length > 0) score += 0.05;

  // Edge case confidence
  if (edgeCases.indexOf('RECENTLY_FUNDED') >= 0) score += 0.05;
  if (edgeCases.indexOf('ALUMNI_NETWORK') >= 0) score += 0.03;

  // Cap at 1.0
  return Math.min(score, 1.0);
}

// ─── APPROACH STRING BUILDER ───────────────────────────────

/**
 * Builds a human-readable approach string.
 * REFRAMED FOR JOB-SEEKING: Approach descriptions emphasize team expansion,
 * growth opportunities, and natural timing for outreach (not sales solutions).
 * @param {Object} lead
 * @param {string} template
 * @param {Array} edgeCases
 * @returns {string}
 */
function _buildApproachString(lead, template, edgeCases) {
  var parts = [];

  // Base approach by template (reframed for job-seeking)
  switch (template) {
    case 'T1_FOUNDER_NO_ROLE':
      parts.push('Founder conversation about company growth challenges');
      break;
    case 'T2_DOMAIN_EXPERT':
      parts.push('Domain expertise positioning as strategic contributor');
      break;
    case 'T3_SHARED_BACKGROUND':
      parts.push('Peer-to-peer connection from shared experience');
      break;
    case 'T4_TRIGGER_EVENT':
      parts.push('Growth-stage timing: team expansion creates natural fit');
      break;
    case 'T5_HIRING_GROWTH':
      parts.push('Growth-focused discussion: strategic hiring opportunity');
      break;
    case 'T6_MUTUAL_CONNECTION':
      parts.push('Mutual connection introduction for team conversation');
      break;
    case 'HR_PARTNERSHIP':
      parts.push('Role opportunity discussion with hiring team');
      break;
    case 'CXO_SHORT':
      parts.push('Executive brief, high-signal, 100-120 words max');
      break;
    default:
      parts.push('Standard informational approach');
  }

  // Add seniority considerations
  if (lead.seniority === 'C_SUITE') {
    parts.push('Respectful of executive time and priorities');
  } else if (lead.seniority === 'JUNIOR') {
    parts.push('Peer-level engagement and collaboration');
  }

  // Add edge case context (reframed for job-seeking)
  if (edgeCases.indexOf('RECENTLY_FUNDED') >= 0) {
    parts.push('Capitalize on team expansion momentum');
  }
  if (edgeCases.indexOf('CONTENT_CREATOR') >= 0) {
    parts.push('Reference published insights and thought leadership');
  }

  return parts.join('; ');
}
