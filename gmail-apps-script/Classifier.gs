/**
 * ============================================================
 * Classifier.gs — Stage 2.5: Adaptive Lead Classifier
 * Analyzes lead profiles and dossiers to select email template,
 * determine archetype, detect edge cases, and set approach.
 * REFRAMED FOR: Job-seeking cold emails (Gaurav seeking roles at Indian startups)
 * ============================================================
 */

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

  // 1. HR_RECRUITER
  if (lead.isHR) {
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

  // Priority 1: Specific edge case overrides
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
  if (dossier && dossier.triggers && dossier.triggers.length > 0) {
    var triggerReasoning = edgeCases.indexOf('RECENTLY_FUNDED') >= 0
      ? 'Recent funding event detected'
      : 'Trigger event: ' + (dossier.triggers[0].event || dossier.triggers[0].type || '');
    candidates.push({ template: 'T4_TRIGGER_EVENT', priority: 3, reasoning: triggerReasoning });
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
