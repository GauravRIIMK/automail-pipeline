/**
 * ============================================================
 * ResearchEngine.gs — Lead Research & Dossier Building (v2.1)
 * Two-pass research: Pass 1 uses Gemini + Google Search grounding
 * for real-time web data; Pass 2 structures into JSON.
 * Includes LinkedIn activity analysis, resume cross-validation,
 * freshness scoring, and multi-signal hook discovery.
 * REFRAMED FOR: Job-seeking cold emails (Gaurav seeking Strategy/Ops/Growth roles)
 * ============================================================
 */

// ─── MAIN RESEARCH ENTRY POINT ──────────────────────────────

/**
 * Main entry point: researches a lead and builds a research dossier.
 * Calls company research, individual research, resume cross-validation,
 * hook discovery, trigger identification, and scores quality.
 * Compresses final output for storage in spreadsheet.
 *
 * @param {Object} lead - Lead object with { rowNum, fullName, organization, email, designation, headline, linkedinUrl }
 * @returns {Object} Compressed dossier for spreadsheet storage
 */
function researchLead(lead) {
  logPipelineEvent(lead.rowNum, 'RESEARCH', 'Starting research for ' + lead.fullName + ' at ' + lead.organization, 'INFO');

  var dossier = {
    lead: lead,
    company: null,
    individual: null,
    hooks: [],
    triggerEvents: [],
    resumeCrossValidation: null,
    timestamp: new Date().toISOString()
  };

  // 1. Deep company research (latest news, funding, market moves, hiring)
  dossier.company = _researchCompany(lead);
  if (!dossier.company) {
    logPipelineEvent(lead.rowNum, 'RESEARCH', 'Company research failed, using fallback', 'WARN');
    dossier.company = _fallbackCompanyProfile(lead);
  }

  // 2. Deep individual research (LinkedIn activity, posts, thought leadership)
  dossier.individual = _researchIndividual(lead);
  if (!dossier.individual) {
    logPipelineEvent(lead.rowNum, 'RESEARCH', 'Individual research failed, using fallback', 'WARN');
    dossier.individual = _fallbackIndividualProfile(lead);
  }

  // 3. Cross-validate Gaurav's resume against lead/org context
  dossier.resumeCrossValidation = _crossValidateResume(lead, dossier.company, dossier.individual);

  // 4. Discover hooks (conversation starters) — now uses cross-validation too
  dossier.hooks = _discoverHooks(lead, dossier.company, dossier.individual, dossier.resumeCrossValidation);

  // 5. Identify trigger events with recency awareness
  dossier.triggerEvents = _identifyTriggers(lead, dossier.company);

  // 6. Build shared background array for downstream consumers
  dossier.sharedBackground = _findSharedBackground(lead, dossier.individual);

  // 7. Score research quality
  var qualityScore = _scoreResearchQuality(dossier);
  dossier.qualityScore = qualityScore.score;
  dossier.qualityIssues = qualityScore.issues;

  if (qualityScore.score < 0.3) {
    logPipelineEvent(lead.rowNum, 'RESEARCH', 'Low quality score (' + qualityScore.score.toFixed(2) + '): ' + qualityScore.issues.join(', '), 'WARN');
  } else {
    logPipelineEvent(lead.rowNum, 'RESEARCH', 'Research complete. Quality: ' + qualityScore.score.toFixed(2) + ' | Hooks: ' + dossier.hooks.length + ' | Triggers: ' + dossier.triggerEvents.length, 'INFO');
  }

  // 8. Compress for storage
  var compressed = _compressDossier(dossier);
  return compressed;
}

// ─── COMPANY RESEARCH ───────────────────────────────────────

/**
 * Researches a company using a TWO-PASS approach:
 *   Pass 1: Gemini + Google Search grounding → raw real-time research text
 *   Pass 2: Gemini + JSON schema → structured company profile from raw text
 *
 * Why two passes? Google Search grounding cannot be combined with responseSchema
 * in the same API call. Pass 1 gets FRESH web data; Pass 2 structures it.
 * Falls back to single-pass (no grounding) if Pass 1 fails.
 *
 * @param {Object} lead - Lead object containing company name
 * @returns {Object} Company profile or null
 */
function _researchCompany(lead) {
  // S3 (2026-06-12-sheet-truth): research companyName MUST be the SHEET ORGANIZATION
  // verbatim (lead.organization). Old code also fell back to lead.company which could
  // be dossier-derived or vendor-derived from a wrong-org enrichment path.
  // lead.organization is populated directly from col E (sheet truth) in SheetReader.gs.
  var companyName = (lead.organization || '').toString().trim() || (lead.company || '').toString().trim();
  if (!companyName) {
    return null;
  }

  var today = new Date().toISOString().split('T')[0];

  // ── PASS 1: Grounded research (Gemini + Google Search) ──
  // This call has real-time web access but returns unstructured text.
  var rawResearch = _groundedCompanyResearch(lead, companyName, today);

  // ── PASS 2: Structure the research into JSON ──
  var parsed = null;
  if (rawResearch) {
    parsed = _structureCompanyResearch(lead, companyName, rawResearch, today);
  }

  // ── FALLBACK: Single-pass structured call (no grounding) ──
  if (!parsed) {
    logPipelineEvent(lead.rowNum, 'RESEARCH', 'Two-pass failed, falling back to single-pass structured research', 'WARN');
    parsed = _singlePassCompanyResearch(lead, companyName, today);
  }

  if (parsed) {
    // Validate required fields
    if (!parsed.name || !parsed.industry) {
      logPipelineEvent(lead.rowNum, 'RESEARCH', 'Company research missing required fields, merging with fallback', 'WARN');
      var fallback = _fallbackCompanyProfile(lead);
      for (var key in fallback) {
        if (!parsed[key] || parsed[key] === '') {
          parsed[key] = fallback[key];
        }
      }
    }
    parsed.stage = _normalizeCompanyStage(parsed.stage);

    // Score research freshness (penalize stale/generic, reward dated/specific)
    var freshness = _scoreResearchFreshness(parsed);
    parsed._freshnessScore = freshness.score;
    parsed._freshnessNotes = freshness.notes;

    // Log research depth
    var depthScore = 0;
    if (parsed.recentNews && parsed.recentNews.length > 20) depthScore++;
    if (parsed.latestFundingRound && parsed.latestFundingRound.length > 10) depthScore++;
    if (parsed.challenges && parsed.challenges.length > 20) depthScore++;
    if (parsed.hiringSignals && parsed.hiringSignals.length > 10) depthScore++;
    if (parsed.recentProductLaunches && parsed.recentProductLaunches.length > 10) depthScore++;
    logPipelineEvent(lead.rowNum, 'RESEARCH', 'Company depth: ' + depthScore + '/5 fields | Freshness: ' + freshness.score + '/5', 'INFO');

    // PATCH `-eq8-content-fix` (#6): post-research entity-mismatch guard. If the
    // company Gemini described is named substantially differently from the
    // lead's org, the grounded search likely resolved the wrong entity. Flag it
    // (token-overlap test after stripping legal suffixes) so the composer/
    // reviewer can treat the dossier as suspect. Conservative — flags only when
    // there is ZERO token overlap (won't false-positive on "Mosaic" vs
    // "Mosaic Inc"). Same-name-different-entity is handled upstream by the
    // domain anchor in _groundedCompanyResearch.
    try {
      var _strip = function(s) {
        return (s || '').toString().toLowerCase()
          .replace(/\b(pvt|private|ltd|limited|inc|incorporated|corp|corporation|llc|llp|gmbh|technologies|technology|labs|solutions|services|group|holdings|global|india|co)\b/g, ' ')
          .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      };
      var _qTokens = _strip(companyName).split(' ').filter(function(t) { return t.length >= 3; });
      var _rTokens = _strip(parsed.name).split(' ').filter(function(t) { return t.length >= 3; });
      if (_qTokens.length && _rTokens.length) {
        var _overlap = _qTokens.some(function(t) { return _rTokens.indexOf(t) >= 0; });
        if (!_overlap) {
          parsed._orgMismatch = true;
          parsed._orgMismatchDetail = 'queried "' + companyName + '" got "' + parsed.name + '"';
          logPipelineEvent(lead.rowNum, 'RESEARCH',
            'POSSIBLE ENTITY MISMATCH: ' + parsed._orgMismatchDetail +
            ' — research may describe the wrong company. Dossier flagged _orgMismatch.', 'WARN');
        }
      }
    } catch (_) {}

    return parsed;
  }

  return null;
}

/**
 * Pass 1: Calls Gemini WITH Google Search grounding (real-time web access).
 * Returns raw text research — no JSON schema (incompatible with grounding).
 *
 * @param {Object} lead - Lead object
 * @param {string} companyName - Company name
 * @param {string} today - Today's date string
 * @returns {string|null} Raw research text or null
 */
function _groundedCompanyResearch(lead, companyName, today) {
  // PATCH `-eq8-content-fix` (#6): anchor the grounded search to the SPECIFIC
  // company via its resolved domain + the lead's LinkedIn URL. A bare name
  // ("Bistro", "Mosaic", "Atlas") lets Gemini's web search resolve to the most
  // prominent same-named entity — producing research about the wrong company.
  // The domain (from enrichment) and the person's LinkedIn URL uniquely pin it.
  //
  // S3 (2026-06-12-sheet-truth): resolvedDomain passes only as a CORROBORATING
  // HINT and ONLY when it passes the org-domain gate vs sheet org (else omitted).
  // The email domain extracted from lead.email (col F) is also gated — if it
  // doesn't match the org it may be from a wrong-path enrichment and must not
  // anchor research to the wrong company.
  var _rawDomain = (lead.resolvedDomain || (lead.email && lead.email.indexOf('@') > 0 ? lead.email.split('@')[1] : '') || '').toString().trim();
  // Gate: only use the domain hint when it has org-token overlap with sheet org.
  // _orgDomainGateRejects returns true when there is NO overlap (reject) — negate for "has overlap".
  var _domainHint = '';
  if (_rawDomain && _rawDomain.indexOf('placeholder.invalid') < 0) {
    var _domainPassesOrgGate = (typeof _orgDomainGateRejects !== 'function') ||
                               !_orgDomainGateRejects(lead.organization, 'x@' + _rawDomain, null);
    if (_domainPassesOrgGate) {
      _domainHint = _rawDomain;
    } else {
      Logger.log('[RESEARCH_S3] omitting domain hint "' + _rawDomain + '" — no org overlap with "' +
                 (lead.organization || '') + '" (sheet org: "' + companyName + '")');
    }
  }
  var _anchor = '';
  if (_domainHint) _anchor += ' Their official website/email domain is "' + _domainHint + '" — research THIS specific company (the one at that domain), not any other company with a similar name.';
  if (lead.linkedinUrl) _anchor += ' The target person\'s LinkedIn is ' + lead.linkedinUrl + ' (use it to confirm the exact employer).';

  var prompt = 'Today is ' + today + '. Research "' + companyName + '"' +
    (_domainHint ? ' (domain: ' + _domainHint + ')' : '') + ' thoroughly using web search.' + _anchor + '\n\n' +
    'I need the LATEST, most CURRENT information. Search the web for:\n\n' +
    '1. LATEST NEWS (last 3-6 months): Funding rounds (amount, investors, date), product launches, ' +
    'partnerships, acquisitions, leadership hires/departures, layoffs, pivots, awards. ' +
    'Include SPECIFIC dates, numbers, and names.\n\n' +
    '2. COMPANY OVERVIEW: Industry, sub-industry, funding stage, employee count, founded year, ' +
    'headquarters, what they do (2-3 sentences).\n\n' +
    '3. CURRENT CHALLENGES: What specific problems does ' + companyName + ' face RIGHT NOW? ' +
    'Think: unit economics, competition, scaling ops, talent gaps, tech debt, regulatory pressure.\n\n' +
    '4. GROWTH & HIRING: Revenue/user milestones, growth rate, hiring velocity. ' +
    'Are they hiring for Strategy/Operations/Growth/GTM/BizOps roles?\n\n' +
    '5. TEAM STRUCTURE: Do they have Ops, Strategy, Growth, or GTM teams? ' +
    'Who leads them? What functions report to CEO vs COO vs VP?\n\n' +
    '6. MARKET POSITION: Top 3-5 competitors, how they differentiate, recent competitive moves.\n\n' +
    '7. RECENT PRODUCT LAUNCHES: New products, features, or services in last 6 months.\n\n' +
    '8. LEADERSHIP CHANGES: C-suite or VP-level changes in last 6-12 months.\n\n' +
    'Be SPECIFIC. Use real dates, real numbers, real names. Do NOT make up information. ' +
    'If you cannot find recent information about a topic, say "No recent data found" for that section.';

  var result = callGeminiGrounded(prompt, {
    temperature: 0.1,
    maxTokens: 4000
  });

  if (result.success && result.data && result.data.length > 100) {
    logPipelineEvent(lead.rowNum, 'RESEARCH', 'Grounded research returned ' + result.data.length + ' chars', 'INFO');
    return result.data;
  }

  logPipelineEvent(lead.rowNum, 'RESEARCH', 'Grounded research failed: ' + (result.error || 'insufficient data'), 'WARN');
  return null;
}

/**
 * Pass 2: Takes raw research text and structures it into JSON using Gemini + responseSchema.
 *
 * @param {Object} lead - Lead object
 * @param {string} companyName - Company name
 * @param {string} rawResearch - Raw text from grounded research
 * @param {string} today - Today's date
 * @returns {Object|null} Structured company profile or null
 */
function _structureCompanyResearch(lead, companyName, rawResearch, today) {
  // PATCH 2026-06-11-eq8-contentguards (T4): anchor Pass-2 to the EXACT company.
  // When the Pass-1 raw research accidentally describes a different company (same name,
  // different entity), Pass-2 must return empty strings rather than the wrong company's
  // data. The domain hint pins the identity.
  // S3 (2026-06-12-sheet-truth): same org-gate guard as Pass 1 — only use domain hint
  // when it passes the org-domain overlap check vs sheet org (lead.organization).
  var _p2RawDomain = (lead.resolvedDomain || (lead.email && lead.email.indexOf('@') > 0 ? lead.email.split('@')[1] : '') || '').toString().trim();
  var _p2Domain = '';
  if (_p2RawDomain && _p2RawDomain.indexOf('placeholder.invalid') < 0) {
    var _p2PassesGate = (typeof _orgDomainGateRejects !== 'function') ||
                        !_orgDomainGateRejects(lead.organization, 'x@' + _p2RawDomain, null);
    if (_p2PassesGate) _p2Domain = _p2RawDomain;
  }
  var _p2Anchor = _p2Domain ? ' (domain: ' + _p2Domain + ')' : '';
  var prompt = 'The company being researched is EXACTLY "' + companyName + '"' + _p2Anchor + '. ' +
    'If the raw research below describes a DIFFERENT company, output empty strings for all fields rather than the wrong company\'s data.\n\n' +
    'Extract and structure the following research about "' + companyName + '" into the required JSON format.\n' +
    'Today is ' + today + '.\n\n' +
    '## RAW RESEARCH DATA\n' + rawResearch + '\n\n' +
    '## ADDITIONAL ANALYSIS NEEDED\n' +
    'Based on the research above, also provide:\n' +
    '- relevanceToGaurav: How could someone with expertise in operations (P&L, supply chain, quality), ' +
    'growth marketing (GTM, CAC optimization, referral programs), and AI/product strategy (RAG pipelines, automation) ' +
    'specifically help ' + companyName + '? Map skills to their actual problems.\n' +
    '- culture: Work culture, values, pace.\n' +
    '- techStack: Known technology stack.\n\n' +
    'RULES:\n' +
    '- Use ONLY facts from the raw research above. Do NOT invent information.\n' +
    '- If a field has no data, use an empty string.\n' +
    '- For recentNews, include dates and specifics from the research.\n' +
    '- For challenges, be specific to THIS company, not generic industry challenges.';

  var result = callGemini(prompt, {
    temperature: 0.1,
    maxTokens: 3000,
    responseFormat: 'json',
    responseSchema: getCompanyResearchSchema()
  });

  if (!result.success) {
    logPipelineEvent(lead.rowNum, 'RESEARCH', 'Structure pass failed: ' + result.error, 'WARN');
    return null;
  }

  var parsed = result.data;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch (e) { return null; }
  }

  return parsed;
}

/**
 * Fallback: Single-pass structured research without grounding.
 * Used when the two-pass approach fails.
 *
 * @param {Object} lead - Lead object
 * @param {string} companyName - Company name
 * @param {string} today - Today's date
 * @returns {Object|null} Structured company profile or null
 */
function _singlePassCompanyResearch(lead, companyName, today) {
  var prompt = 'Research "' + companyName + '" for job-fit analysis. Today is ' + today + '.\n\n' +
    'Provide ALL of the following with MAXIMUM specificity and recency:\n' +
    '- Company basics: name, industry, sub-industry, stage, employee range, founded, HQ, description\n' +
    '- recentNews: 2-3 most significant recent events with dates and specifics\n' +
    '- latestFundingRound: amount, round, investors, date\n' +
    '- recentProductLaunches: new products/features in last 6 months\n' +
    '- leadershipChanges: C-suite/VP changes in last 6-12 months\n' +
    '- marketMoves: expansion, pivots, new verticals\n' +
    '- challenges: Top 2-3 SPECIFIC current business challenges (not generic)\n' +
    '- growthSignals: concrete evidence (numbers, milestones)\n' +
    '- hiringSignals: open roles especially Strategy/Ops/Growth/GTM\n' +
    '- teamStructure: Strategy/Ops/Growth/GTM teams, reporting structure\n' +
    '- competitors, keyProducts, culture, techStack\n' +
    '- relevanceToGaurav: how operations/growth/AI skills map to their problems\n\n' +
    'If you cannot find specific information, say "No data found" rather than guessing.';

  var result = callGemini(prompt, {
    temperature: 0.2,
    maxTokens: 3000,
    responseFormat: 'json',
    responseSchema: getCompanyResearchSchema()
  });

  if (!result.success) {
    logPipelineEvent(lead.rowNum, 'RESEARCH', 'Single-pass company research failed: ' + result.error, 'WARN');
    return null;
  }

  var parsed = result.data;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch (e) { return null; }
  }

  return parsed;
}

/**
 * Scores research freshness — penalizes generic/stale content, rewards specific/dated findings.
 * Score 0-5 where 5 = very fresh and specific.
 *
 * @param {Object} parsed - Parsed company research
 * @returns {Object} { score: number, notes: string[] }
 */
function _scoreResearchFreshness(parsed) {
  var score = 0;
  var notes = [];

  // Check for date mentions (strong freshness signal)
  // 2026-05-11 AUDIT FIX: previously 2024 scored as "fresh" — now ~18mo stale.
  // Use the last full year + current year as the freshness window so a 2026
  // cold email doesn't open with "as you announced in 2024…" framing.
  var currentYear = new Date().getFullYear();
  var freshYears = '(?:' + (currentYear - 1) + '|' + currentYear + ')';
  var allText = JSON.stringify(parsed).toLowerCase();
  var datePatterns = [
    new RegExp('\\b(january|february|march|april|may|june|july|august|september|october|november|december)\\s+' + freshYears, 'gi'),
    new RegExp('\\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\\s+' + freshYears, 'gi'),
    new RegExp('\\bq[1-4]\\s+' + freshYears, 'gi'),
    new RegExp('\\b' + freshYears + '\\b', 'g')
  ];

  var dateCount = 0;
  datePatterns.forEach(function(pattern) {
    var matches = allText.match(pattern);
    if (matches) dateCount += matches.length;
  });

  if (dateCount >= 3) {
    score += 2;
    notes.push('Multiple dated references found (' + dateCount + ')');
  } else if (dateCount >= 1) {
    score += 1;
    notes.push('Some dated references (' + dateCount + ')');
  } else {
    notes.push('No date references - research may be stale');
  }

  // Check for specific numbers (dollar amounts, percentages, user counts)
  var numberPatterns = [
    /\$[\d,.]+[mb]?\b/gi,
    /\b\d+%/g,
    /\b\d+[mk]?\s*(users|customers|employees|cities|stores|downloads)/gi,
    /\b(rs|inr|usd)\s*[\d,.]+\s*(cr|crore|lakh|million|billion)/gi
  ];

  var numberCount = 0;
  numberPatterns.forEach(function(pattern) {
    var matches = allText.match(pattern);
    if (matches) numberCount += matches.length;
  });

  if (numberCount >= 3) {
    score += 1.5;
    notes.push('Rich specifics (' + numberCount + ' data points)');
  } else if (numberCount >= 1) {
    score += 0.5;
    notes.push('Some specifics (' + numberCount + ' data points)');
  } else {
    notes.push('Lacks specific numbers - may be generic');
  }

  // Check for named entities (real people, investors, competitors)
  var hasNamedEntities = /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/.test(parsed.leadershipChanges || '') ||
    /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/.test(parsed.latestFundingRound || '');
  if (hasNamedEntities) {
    score += 1;
    notes.push('Named entities found (people/investors)');
  }

  // Penalize "no data" or "no recent" flags
  var noDataCount = (allText.match(/no (data|recent|information) (found|available)/gi) || []).length;
  if (noDataCount >= 3) {
    score -= 1;
    notes.push('Multiple "no data" flags (' + noDataCount + ')');
  }

  // Penalize very short fields
  if (parsed.recentNews && parsed.recentNews.length < 30) {
    score -= 0.5;
    notes.push('Recent news too short');
  }

  return { score: Math.max(0, Math.min(5, score)), notes: notes };
}

/**
 * Normalizes company stage to standard values.
 * @param {string} stage - Raw stage string from research
 * @returns {string} Normalized stage
 */
function _normalizeCompanyStage(stage) {
  if (!stage) return 'UNKNOWN';

  var lower = stage.toLowerCase();
  if (lower.includes('pre-seed') || lower.includes('preseed')) return 'PRE_SEED';
  if (lower.includes('seed')) return 'SEED';
  if (lower.includes('series a')) return 'SERIES_A';
  if (lower.includes('series b')) return 'SERIES_B';
  if (lower.includes('series c')) return 'SERIES_C_PLUS';
  if (lower.includes('late stage') || lower.includes('late-stage')) return 'SERIES_C_PLUS';
  if (lower.includes('public')) return 'PUBLIC';
  return 'UNKNOWN';
}

/**
 * Fallback company profile when API fails or returns insufficient data.
 * @param {Object} lead - Lead object
 * @returns {Object} Minimal but valid company profile
 */
function _fallbackCompanyProfile(lead) {
  return {
    name: lead.organization || lead.company || 'Unknown',
    industry: 'Unknown',
    subIndustry: '',
    stage: 'UNKNOWN',
    employeeRange: 'Unknown',
    founded: '',
    headquarters: '',
    description: '',  // PATCH `-eq8-content-fix` (#5): was 'No data available' — that literal leaked into email bodies. Empty string is handled by composer; the refusal-phrase string is not.
    recentNews: '',
    latestFundingRound: '',
    recentProductLaunches: '',
    leadershipChanges: '',
    marketMoves: '',
    fundingInfo: '',
    competitors: [],
    keyProducts: [],
    challenges: '',
    growthSignals: '',
    hiringSignals: '',
    teamStructure: '',
    culture: '',
    techStack: '',
    relevanceToGaurav: ''
  };
}

// ─── INDIVIDUAL RESEARCH ────────────────────────────────────

/**
 * Researches an individual using Gemini API with deep LinkedIn-activity-focused prompts.
 * Asks for recent posts, thought leadership, speaking engagements, career moves,
 * professional interests, and communication patterns.
 *
 * @param {Object} lead - Lead object containing name and title
 * @returns {Object} Individual profile or null
 */
function _researchIndividual(lead) {
  var name = lead.fullName || lead.name || '';
  var title = lead.designation || lead.title || '';
  var company = lead.organization || lead.company || '';
  var headline = lead.headline || '';
  var linkedinUrl = lead.linkedinUrl || '';

  if (!name) {
    return null;
  }

  var today = new Date().toISOString().split('T')[0];

  // PATCH 2026-06-11-eq8-contentguards (T4): anchor individual research to THIS
  // specific person at THIS specific company. Without this anchor, Gemini grounded
  // search can profile a different person with the same name or describe their
  // PREVIOUS employer (e.g. "Your recent move to KnowledgeHut" when the recipient
  // actually works at Apple). Mirrors the domain-anchor added to _groundedCompanyResearch.
  var _indivDomain = (lead.resolvedDomain || (lead.email && lead.email.indexOf('@') > 0 ? lead.email.split('@')[1] : '') || '').toString().trim();
  var _indivAnchor = '';
  if (_indivDomain) _indivAnchor += ' Their current employer\'s email domain is "' + _indivDomain + '" — this is THEIR CURRENT company, research must confirm they work there NOW.';
  if (linkedinUrl)  _indivAnchor += ' Their LinkedIn profile URL is ' + linkedinUrl + ' — use it to confirm current role and employer before citing any fact.';
  if (company)      _indivAnchor += ' The CRM record shows their current employer as "' + company + '". If search results describe them at a DIFFERENT company, that data is stale; output empty strings for those fields rather than citing an old employer.';

  var prompt = 'You are profiling "' + name + '" for personalized job-seeking outreach.' + _indivAnchor + '\n' +
    'Today is ' + today + '. Focus on the LATEST and most SPECIFIC information.\n\n' +
    '## PERSON DETAILS\n' +
    'Name: ' + name + '\n' +
    'Title: ' + title + '\n' +
    'Company: ' + company + '\n' +
    (headline ? 'LinkedIn Headline: ' + headline + '\n' : '') +
    (linkedinUrl ? 'LinkedIn URL: ' + linkedinUrl + '\n' : '') + '\n' +
    '## ROLE & RESPONSIBILITIES\n' +
    'Provide roleKPIs: 4-6 specific responsibilities and KPIs this person likely manages. ' +
    'Be specific to their title and company context. For example, if they are VP Growth at an edtech, ' +
    'their KPIs would be CAC, LTV, activation rate, referral rate, not generic "drive growth".\n\n' +
    '## PAIN POINTS & CHALLENGES\n' +
    'Provide painPoints: 3-5 specific challenges this person faces in their role at ' + company + '. ' +
    'Think about what keeps them up at night: scaling team, hitting targets, cross-functional alignment, ' +
    'resource constraints, competitive pressure, tech limitations.\n\n' +
    '## LINKEDIN ACTIVITY & THOUGHT LEADERSHIP (CRITICAL for personalization)\n' +
    'Research this person\'s public professional activity:\n' +
    '- recentLinkedInPosts: Summarize 2-3 of their most recent or notable LinkedIn posts/articles. ' +
    'What topics did they write about? What opinions did they share? Include approximate dates if possible.\n' +
    '- publishedContent: Any blog posts, articles, podcast appearances, conference talks, or media mentions. ' +
    'Be specific about topics and platforms.\n' +
    '- thoughtLeadershipTopics: 3-5 topics this person actively talks about or cares about professionally. ' +
    'Infer from their posts, headline, and career trajectory.\n' +
    '- recentCareerMoves: Any recent role changes, promotions, or company switches in the last 12 months.\n\n' +
    '## PROFESSIONAL NETWORK & BACKGROUND\n' +
    '- careerTrajectory: Brief career path showing progression and key transitions.\n' +
    '- alumniNetworks: Educational institutions and notable company alumni networks they belong to.\n' +
    '- interestTopics: 3-5 professional interests beyond their current role.\n\n' +
    '## OUTREACH INTELLIGENCE\n' +
    '- decisionPower: Can this person influence hiring or team-building? (high/medium/low) with reasoning.\n' +
    '- communicationStyle: Based on their LinkedIn activity, how do they communicate? Formal/casual, ' +
    'data-driven/narrative, brief/detailed? What tone would resonate?\n' +
    '- bestHookAngle: What is the single best conversation opener for this specific person? ' +
    'Consider: their recent posts, company news, shared background, or a specific challenge you could discuss.\n' +
    '- estimatedEmailVolume: How many cold emails does this person likely receive daily? (Low/Medium/High/Very High)';

  // 2026-05-11 AUDIT FIX: switch to grounded search for individual research.
  // Previous ungrounded Gemini call hallucinated LinkedIn posts + thought-
  // leadership topics, which fed straight into hook generation and the email
  // body. Reviewer flagged this as the highest-damage finding in the post-
  // enrichment audit. Grounded Gemini uses Google Search to anchor claims.
  // Falls back to ungrounded if grounded is unavailable.
  var groundedRes = null;
  try {
    if (typeof callGeminiGrounded === 'function' && linkedinUrl) {
      groundedRes = callGeminiGrounded(prompt + '\n\nUse Google Search to ground your claims about LinkedIn posts, public statements, and career moves. If you cannot find concrete evidence for a claim, write "" (empty string) for that field rather than inventing a plausible answer.', {
        temperature: 0.2,
        maxTokens: 3000
      });
    }
  } catch (gErr) {
    Logger.log('[ResearchEngine] Grounded individual research failed: ' + gErr.message);
  }

  var result;
  if (groundedRes && groundedRes.success && groundedRes.data) {
    // Re-extract JSON from the grounded text reply (grounded mode returns plain text + citations).
    try {
      var jsonMatch = groundedRes.data.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result = { success: true, data: JSON.parse(jsonMatch[0]), source: 'grounded' };
        Logger.log('[ResearchEngine] Individual research: grounded JSON parse OK');
      } else {
        // Grounded returned narrative — convert to structured via ungrounded second pass
        var followup = callGemini('Convert the following research notes into strict JSON matching the schema:\n\n' + groundedRes.data, {
          temperature: 0.0, maxTokens: 3000, responseFormat: 'json', responseSchema: getIndividualResearchSchema()
        });
        result = followup.success ? followup : null;
        if (result) result.source = 'grounded_then_structured';
      }
    } catch (parseErr) {
      Logger.log('[ResearchEngine] Grounded result parse failed: ' + parseErr.message);
      result = null;
    }
  }

  // Fallback: ungrounded structured-output if grounded failed or returned nothing
  if (!result || !result.success) {
    result = callGemini(prompt + '\n\nIMPORTANT: if you cannot verify a LinkedIn post or public statement from training data, write "" for that field. Do NOT invent plausible-sounding posts.', {
      temperature: 0.3,
      maxTokens: 3000,
      responseFormat: 'json',
      responseSchema: getIndividualResearchSchema()
    });
    if (result.success) result.source = 'ungrounded_with_anti_hallucination_directive';
  }

  // Check for empty response
  if (result.success && (!result.data || (typeof result.data === 'string' && result.data.trim().length === 0))) {
    result.success = false;
    result.error = 'Empty response from Gemini';
  }

  if (!result.success) {
    logPipelineEvent(lead.rowNum, 'RESEARCH', 'Individual API call failed: ' + result.error, 'WARN');
    return null;
  }

  var parsed = result.data;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (e) {
      logPipelineEvent(lead.rowNum, 'RESEARCH', 'Failed to parse individual JSON: ' + e.message, 'WARN');
      return null;
    }
  }

  if (parsed) {
    // Validate required fields
    if (!parsed.roleKPIs || parsed.roleKPIs.length === 0) {
      logPipelineEvent(lead.rowNum, 'RESEARCH', 'Individual research missing roleKPIs, using partial + fallback', 'WARN');
      var fallback = _fallbackIndividualProfile(lead);
      for (var key in fallback) {
        if (!parsed[key] || (Array.isArray(parsed[key]) && parsed[key].length === 0) || parsed[key] === '') {
          parsed[key] = fallback[key];
        }
      }
    }

    // Log LinkedIn activity depth
    var linkedInDepth = 0;
    if (parsed.recentLinkedInPosts && parsed.recentLinkedInPosts.length > 20) linkedInDepth++;
    if (parsed.publishedContent && parsed.publishedContent.length > 10) linkedInDepth++;
    if (parsed.thoughtLeadershipTopics && parsed.thoughtLeadershipTopics.length > 0) linkedInDepth++;
    if (parsed.bestHookAngle && parsed.bestHookAngle.length > 10) linkedInDepth++;
    logPipelineEvent(lead.rowNum, 'RESEARCH', 'Individual research depth: ' + linkedInDepth + '/4 LinkedIn fields populated', 'INFO');

    return parsed;
  }

  return null;
}

/**
 * Fallback individual profile when API fails or returns insufficient data.
 * @param {Object} lead - Lead object
 * @returns {Object} Minimal but valid individual profile
 */
function _fallbackIndividualProfile(lead) {
  return {
    roleKPIs: ['Manage operations', 'Drive growth', 'Build team'],
    painPoints: ['Resource constraints', 'Efficiency challenges'],
    recentLinkedInPosts: '',
    recentActivity: 'No data available',
    publishedContent: '',
    thoughtLeadershipTopics: [],
    recentCareerMoves: '',
    careerTrajectory: lead.designation || lead.title || 'Professional',
    decisionPower: 'medium',
    communicationStyle: 'email',
    bestHookAngle: '',
    interestTopics: [],
    alumniNetworks: [],
    estimatedEmailVolume: 'High'
  };
}

// ─── RESUME CROSS-VALIDATION ────────────────────────────────

/**
 * Cross-validates Gaurav's resume achievements against the lead's organization context.
 * Maps specific GAURAV_PROFILE achievements to the company's challenges, industry needs,
 * and the individual's pain points. Produces targeted "bridge" statements that connect
 * Gaurav's proven results to the org's specific situation.
 *
 * @param {Object} lead - Lead object
 * @param {Object} company - Company research result
 * @param {Object} individual - Individual research result
 * @returns {Object} { topMatches: [], bridgeStatements: [], relevantVariant: string }
 */
function _crossValidateResume(lead, company, individual) {
  var result = {
    topMatches: [],
    bridgeStatements: [],
    relevantVariant: 'GROWTH_MARKETING'
  };

  if (!company || typeof GAURAV_PROFILE === 'undefined') {
    return result;
  }

  // Collect org context signals
  var orgContext = '';
  if (company.challenges) orgContext += 'Challenges: ' + company.challenges + '. ';
  if (company.growthSignals) orgContext += 'Growth: ' + company.growthSignals + '. ';
  if (company.hiringSignals) orgContext += 'Hiring: ' + company.hiringSignals + '. ';
  if (company.recentNews) orgContext += 'News: ' + company.recentNews + '. ';
  if (company.recentProductLaunches) orgContext += 'Launches: ' + company.recentProductLaunches + '. ';
  if (company.teamStructure) orgContext += 'Teams: ' + company.teamStructure + '. ';

  var individualContext = '';
  if (individual) {
    if (individual.painPoints && individual.painPoints.length > 0) {
      individualContext += 'Their pain points: ' + individual.painPoints.join(', ') + '. ';
    }
    if (individual.roleKPIs && individual.roleKPIs.length > 0) {
      individualContext += 'Their KPIs: ' + individual.roleKPIs.join(', ') + '. ';
    }
  }

  // Score each resume variant against org context using keyword matching
  var variants = ['GROWTH_MARKETING', 'OPS_CONSULTING', 'PRODUCT_AI_STRATEGY'];
  var bestVariant = 'GROWTH_MARKETING';
  var bestScore = 0;
  var allMatches = [];

  var contextLower = (orgContext + ' ' + individualContext).toLowerCase();

  variants.forEach(function(variantId) {
    var profile = GAURAV_PROFILE[variantId];
    if (!profile) return;

    var variantScore = 0;
    var variantMatches = [];

    profile.achievements.forEach(function(achievement) {
      var matchScore = _scoreAchievementRelevance(achievement, contextLower, company);
      if (matchScore > 0) {
        variantMatches.push({
          achievement: achievement,
          variant: variantId,
          relevanceScore: matchScore
        });
        variantScore += matchScore;
      }
    });

    if (variantScore > bestScore) {
      bestScore = variantScore;
      bestVariant = variantId;
    }

    allMatches = allMatches.concat(variantMatches);
  });

  // Sort by relevance and take top 4
  allMatches.sort(function(a, b) { return b.relevanceScore - a.relevanceScore; });
  result.topMatches = allMatches.slice(0, 4);
  result.relevantVariant = bestVariant;

  // Generate bridge statements using Gemini for the top matches
  if (result.topMatches.length > 0 && orgContext.length > 30) {
    var bridgeStatements = _generateBridgeStatements(lead, result.topMatches, orgContext, individualContext);
    if (bridgeStatements) {
      result.bridgeStatements = bridgeStatements;
    }
  }

  logPipelineEvent(lead.rowNum, 'RESEARCH',
    'Resume cross-validation: best variant=' + bestVariant + ', top matches=' + result.topMatches.length +
    ', bridges=' + result.bridgeStatements.length, 'INFO');

  return result;
}

/**
 * Scores how relevant a specific achievement is to the org context.
 * Uses keyword overlap and domain signal matching.
 *
 * @param {string} achievement - A single achievement string from GAURAV_PROFILE
 * @param {string} contextLower - Lowercased org + individual context
 * @param {Object} company - Company research object
 * @returns {number} Relevance score (0-10)
 */
function _scoreAchievementRelevance(achievement, contextLower, company) {
  var score = 0;
  var achLower = achievement.toLowerCase();

  // Domain keyword groups and their matching context signals
  var domainSignals = [
    { keywords: ['p&l', 'profitability', 'margin', 'unit economics', 'revenue'], contextHints: ['profitability', 'revenue', 'margin', 'p&l', 'unit economics', 'pricing', 'monetization'] },
    { keywords: ['growth', 'dau', 'acquisition', 'cac', 'conversion', 'referral'], contextHints: ['growth', 'acquisition', 'cac', 'conversion', 'user', 'retention', 'activation', 'referral', 'ltv'] },
    { keywords: ['operations', 'supply chain', 'inventory', 'quality', 'sla', 'logistics'], contextHints: ['operations', 'supply chain', 'inventory', 'logistics', 'quality', 'sla', 'delivery', 'fulfillment', 'warehouse'] },
    { keywords: ['ai', 'automation', 'rag', 'pipeline', 'langchain', 'ml'], contextHints: ['ai', 'automation', 'machine learning', 'data', 'tech', 'platform', 'saas', 'product'] },
    { keywords: ['gtm', 'launch', 'market', 'dark store', 'expansion'], contextHints: ['gtm', 'launch', 'expansion', 'new market', 'go-to-market', 'scaling', 'new city', 'new vertical'] },
    { keywords: ['marketing', 'martech', 'email', 'segmentation', 'apac'], contextHints: ['marketing', 'martech', 'email', 'segmentation', 'b2b', 'b2c', 'brand', 'content'] },
    { keywords: ['cloud kitchen', 'food', 'blinkit', 'zomato', 'quick commerce'], contextHints: ['food', 'restaurant', 'kitchen', 'delivery', 'quick commerce', 'q-commerce', 'grocery', 'hyperlocal'] },
    { keywords: ['stakeholder', 'cross-functional', 'dashboard', 'analytics'], contextHints: ['stakeholder', 'cross-functional', 'analytics', 'dashboard', 'reporting', 'data-driven'] }
  ];

  domainSignals.forEach(function(domain) {
    var achHasDomain = domain.keywords.some(function(kw) { return achLower.indexOf(kw) >= 0; });
    if (achHasDomain) {
      var contextMatches = domain.contextHints.filter(function(hint) { return contextLower.indexOf(hint) >= 0; });
      score += contextMatches.length * 1.5;
    }
  });

  // Industry match bonus
  if (company && company.industry) {
    var industryLower = company.industry.toLowerCase();
    if (achLower.indexOf('edtech') >= 0 && industryLower.indexOf('ed') >= 0) score += 2;
    if (achLower.indexOf('food') >= 0 && (industryLower.indexOf('food') >= 0 || industryLower.indexOf('commerce') >= 0)) score += 2;
    if (achLower.indexOf('saas') >= 0 && industryLower.indexOf('saas') >= 0) score += 2;
    if (achLower.indexOf('b2b') >= 0 && industryLower.indexOf('b2b') >= 0) score += 2;
  }

  // Stage match bonus — scaling companies value ops/growth more
  if (company && company.stage) {
    var stage = company.stage;
    if ((stage === 'SERIES_A' || stage === 'SERIES_B') && (achLower.indexOf('scale') >= 0 || achLower.indexOf('gtm') >= 0 || achLower.indexOf('launch') >= 0)) {
      score += 1.5;
    }
    if ((stage === 'SERIES_C_PLUS' || stage === 'PUBLIC') && (achLower.indexOf('p&l') >= 0 || achLower.indexOf('profitability') >= 0)) {
      score += 1.5;
    }
  }

  return score;
}

/**
 * Uses Gemini to generate bridge statements connecting Gaurav's achievements
 * to the org's specific challenges.
 *
 * @param {Object} lead - Lead object
 * @param {Array} topMatches - Top achievement matches
 * @param {string} orgContext - Org context string
 * @param {string} individualContext - Individual context string
 * @returns {Array} Array of bridge statement strings
 */
function _generateBridgeStatements(lead, topMatches, orgContext, individualContext) {
  var achievementList = topMatches.map(function(m) { return m.achievement; }).join('\n- ');

  var prompt = 'Generate 2-3 bridge statements that connect these proven achievements to the company\'s specific situation.\n\n' +
    'Company: ' + (lead.organization || '') + '\n' +
    'Org Context: ' + orgContext + '\n' +
    (individualContext ? 'Lead Context: ' + individualContext + '\n' : '') +
    '\nGaurav\'s relevant achievements:\n- ' + achievementList + '\n\n' +
    'Each bridge statement should be 1 sentence, format: "[Gaurav\'s specific result] maps directly to [company\'s specific need]".\n' +
    'Be concrete. Use numbers from the achievements. Reference the company\'s actual challenges.\n' +
    'Return a JSON array of 2-3 strings.';

  var result = callGemini(prompt, {
    temperature: 0.3,
    maxTokens: 500,
    responseFormat: 'json',
    responseSchema: {
      type: 'ARRAY',
      items: { type: 'STRING' }
    }
  });

  if (result.success && result.data) {
    var parsed = result.data;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch (e) { return []; }
    }
    if (Array.isArray(parsed)) {
      return parsed.slice(0, 3);
    }
  }

  return [];
}

// ─── SHARED BACKGROUND FINDER ───────────────────────────────

/**
 * Finds shared background elements between Gaurav and the lead.
 * Only returns VERIFIED shared elements using GAURAV_FACTS.
 *
 * @param {Object} lead - Lead object
 * @param {Object} individual - Individual research result
 * @returns {Array} Array of shared background strings
 */
function _findSharedBackground(lead, individual) {
  var shared = [];
  if (!individual) return shared;

  var facts = (typeof GAURAV_FACTS !== 'undefined') ? GAURAV_FACTS : {};
  var alumniKeywords = facts.alumniKeywords || [];
  var gauravCompanies = facts.companies || [];

  // Check alumni networks
  if (individual.alumniNetworks && individual.alumniNetworks.length > 0) {
    individual.alumniNetworks.forEach(function(network) {
      var networkLower = network.toLowerCase();
      var isMatch = alumniKeywords.some(function(kw) {
        return networkLower.indexOf(kw) >= 0;
      });
      if (isMatch) {
        shared.push('Shared alumni network: ' + network);
      }
    });
  }

  // Check career trajectory for overlapping companies
  if (individual.careerTrajectory) {
    var trajectoryLower = individual.careerTrajectory.toLowerCase();
    gauravCompanies.forEach(function(company) {
      if (trajectoryLower.indexOf(company.toLowerCase()) >= 0) {
        shared.push('Both worked at ' + company);
      }
    });
  }

  // Check shared domain keywords from headline/interests
  var sharedDomains = ['startup', 'growth', 'operations', 'strategy', 'mba', 'product management', 'ai'];
  var headline = (lead.headline || '').toLowerCase();
  sharedDomains.forEach(function(domain) {
    if (headline.indexOf(domain) >= 0) {
      shared.push('Shared domain: ' + domain);
    }
  });

  return shared.slice(0, 3);
}

// ─── HOOK DISCOVERY ─────────────────────────────────────────

/**
 * Discovers conversation starters (hooks) based on company research,
 * individual research, LinkedIn activity, and resume cross-validation.
 * Prioritizes hooks that are RECENT, SPECIFIC, and PERSONALIZED.
 *
 * @param {Object} lead - Lead object
 * @param {Object} company - Company research result
 * @param {Object} individual - Individual research result
 * @param {Object} crossValidation - Resume cross-validation result
 * @returns {Array} Array of hooks { text: string, strength: 'STRONG'|'MEDIUM'|'WEAK', type: string }
 */
function _discoverHooks(lead, company, individual, crossValidation) {
  var hooks = [];

  if (!company && !individual) {
    return hooks;
  }

  // ── TIER 1: STRONGEST hooks (recent, specific, personalized) ──

  // Hook: Lead's recent LinkedIn post/thought leadership (most personal, highest response rate)
  if (individual && individual.recentLinkedInPosts && individual.recentLinkedInPosts.length > 20) {
    hooks.push({
      text: 'LinkedIn activity: ' + individual.recentLinkedInPosts.substring(0, 120),
      strength: 'STRONG',
      type: 'LINKEDIN_POST'
    });
  }

  // Hook: Lead's published content or thought leadership
  if (individual && individual.publishedContent && individual.publishedContent.length > 10) {
    hooks.push({
      text: 'Published content: ' + individual.publishedContent.substring(0, 100),
      strength: 'STRONG',
      type: 'THOUGHT_LEADERSHIP'
    });
  }

  // Hook: AI-suggested best hook angle for this specific person
  if (individual && individual.bestHookAngle && individual.bestHookAngle.length > 10) {
    hooks.push({
      text: 'Best angle: ' + individual.bestHookAngle.substring(0, 120),
      strength: 'STRONG',
      type: 'AI_RECOMMENDED'
    });
  }

  // Hook: Recent company news (specific, timely)
  if (company && company.recentNews && company.recentNews.length > 20) {
    hooks.push({
      text: 'Recent news: ' + company.recentNews.substring(0, 120),
      strength: 'STRONG',
      type: 'COMPANY_NEWS'
    });
  }

  // Hook: Latest funding round (very strong timing signal)
  if (company && company.latestFundingRound && company.latestFundingRound.length > 10 &&
      company.latestFundingRound.toLowerCase().indexOf('no ') !== 0) {
    hooks.push({
      text: 'Funding: ' + company.latestFundingRound.substring(0, 100),
      strength: 'STRONG',
      type: 'FUNDING'
    });
  }

  // ── TIER 2: GOOD hooks (contextual, relevant) ──

  // Hook: Resume-to-challenge bridge (shows you understand their problems)
  if (crossValidation && crossValidation.bridgeStatements && crossValidation.bridgeStatements.length > 0) {
    hooks.push({
      text: 'Skills bridge: ' + crossValidation.bridgeStatements[0].substring(0, 120),
      strength: 'STRONG',
      type: 'RESUME_BRIDGE'
    });
  }

  // Hook: Recent product launches
  if (company && company.recentProductLaunches && company.recentProductLaunches.length > 10) {
    hooks.push({
      text: 'New launch: ' + company.recentProductLaunches.substring(0, 100),
      strength: 'MEDIUM',
      type: 'PRODUCT_LAUNCH'
    });
  }

  // Hook: Leadership changes (good timing for team restructuring)
  if (company && company.leadershipChanges && company.leadershipChanges.length > 10) {
    hooks.push({
      text: 'Leadership change: ' + company.leadershipChanges.substring(0, 100),
      strength: 'MEDIUM',
      type: 'LEADERSHIP_CHANGE'
    });
  }

  // Hook: Shared alumni background (VERIFIED only)
  if (individual && individual.alumniNetworks && individual.alumniNetworks.length > 0) {
    var facts = (typeof GAURAV_FACTS !== 'undefined') ? GAURAV_FACTS : {};
    var alumniKeywords = facts.alumniKeywords || [];
    individual.alumniNetworks.forEach(function(network) {
      var networkLower = network.toLowerCase();
      var isVerified = alumniKeywords.some(function(kw) { return networkLower.indexOf(kw) >= 0; });
      if (isVerified) {
        hooks.push({
          text: 'Verified shared alumni: ' + network,
          strength: 'STRONG',
          type: 'SHARED_ALUMNI'
        });
      }
    });
  }

  // Hook: Company challenges that map to Gaurav's skills
  if (company && company.challenges && company.challenges.length > 20) {
    hooks.push({
      text: 'Org challenges: ' + company.challenges.substring(0, 100),
      strength: 'MEDIUM',
      type: 'ORG_CHALLENGE'
    });
  }

  // Hook: Active hiring in relevant domains
  if (company && company.hiringSignals && company.hiringSignals.length > 10) {
    hooks.push({
      text: 'Hiring signals: ' + company.hiringSignals.substring(0, 100),
      strength: 'MEDIUM',
      type: 'HIRING'
    });
  }

  // ── TIER 3: SUPPORTING hooks ──

  // Hook: Market expansion or strategic pivot
  if (company && company.marketMoves && company.marketMoves.length > 10) {
    hooks.push({
      text: 'Market move: ' + company.marketMoves.substring(0, 80),
      strength: 'MEDIUM',
      type: 'MARKET_MOVE'
    });
  }

  // Hook: Growth signals
  if (company && company.growthSignals && company.growthSignals.length > 10) {
    hooks.push({
      text: 'Growth: ' + company.growthSignals.substring(0, 80),
      strength: 'MEDIUM',
      type: 'GROWTH'
    });
  }

  // Hook: Industry trend + person's interest overlap
  if (company && company.industry && individual && individual.thoughtLeadershipTopics &&
      individual.thoughtLeadershipTopics.length > 0) {
    hooks.push({
      text: company.industry + ' trend: ' + individual.thoughtLeadershipTopics[0],
      strength: 'WEAK',
      type: 'INDUSTRY_TREND'
    });
  }

  // Hook: Relevance to Gaurav (Gemini's analysis of job fit)
  if (company && company.relevanceToGaurav && company.relevanceToGaurav.length > 20) {
    hooks.push({
      text: 'Job fit: ' + company.relevanceToGaurav.substring(0, 100),
      strength: 'MEDIUM',
      type: 'JOB_FIT'
    });
  }

  // ── Research-backed strength upgrade pass ──
  // Per 2025-2026 benchmarks (Digital Bloom, Prospeo, Woodpecker 20M-email study):
  // signal-based hooks containing a concrete TIME-BOUNDED METRIC or NAMED QUANTIFIER
  // hit 15-25% reply rates vs 3-5% for generic. So we upgrade any hook whose text
  // carries that signature to STRONG, regardless of its base tier.
  hooks.forEach(function(h) {
    if (!h || !h.text) return;
    if (_hasSignalSignature(h.text)) {
      h.strength = 'STRONG';
      // Mark hooks that carry a time-bounded metric as a timeline sub-type
      // (the empirically highest-performing opener per Digital Bloom 2025 data)
      if (_hasTimelineSignature(h.text) && h.type && h.type.indexOf('TIMELINE') < 0) {
        h.type = h.type + '_TIMELINE';
      }
    }
  });

  // Sort: STRONG first, then MEDIUM, then WEAK
  var strengthOrder = { STRONG: 0, MEDIUM: 1, WEAK: 2 };
  hooks.sort(function(a, b) {
    return (strengthOrder[a.strength] || 2) - (strengthOrder[b.strength] || 2);
  });

  return hooks;
}

/**
 * Detects whether text carries a "signal-based" signature:
 * a specific number, currency, percentage, date, or named entity marker.
 * These are the 2026 data markers that correlate with 15-25% reply rates.
 */
function _hasSignalSignature(text) {
  if (!text) return false;
  // Number + unit ($, %, M, K, Cr, Lakh, x, bn, billion, million)
  var unitMarker = /\$\s?\d|\d+\s?(%|M\b|K\b|Cr\b|Lakh|bn|billion|million|x\b)/i;
  // Any multi-digit number OR a small number followed by a concrete countable noun
  var countMarker = /\b\d{2,}\b|\b\d+\s+(open|role|roles|employees|people|customers|users|hires|reviews|launches|markets|offices|countries|products|teams|months?|weeks?|days?|quarters?|years?)\b/i;
  // Dates or date-like markers (quarter, month, year references)
  var dateMarker = /\b(20\d{2}|Q[1-4]|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i;
  // Specific round markers (Series A/B/C/D, Seed, Pre-IPO)
  var roundMarker = /\b(Series\s?[A-E]|Seed|Pre-?IPO|IPO)\b/i;
  return unitMarker.test(text) || countMarker.test(text) || dateMarker.test(text) || roundMarker.test(text);
}

/**
 * Detects compressed time-bounded growth metrics — the highest-performing
 * opener pattern per Digital Bloom 2025 (10.01% reply, 2.34% meeting rate).
 * Pattern: number + time-unit phrase ("X to Y in Z months", "grew X in Q3", "3x in 6 months").
 */
function _hasTimelineSignature(text) {
  if (!text) return false;
  var patterns = [
    /\bin\s+\d+\s*(day|week|month|quarter|year)s?\b/i,       // "in 6 months"
    /\b\d+\s*(day|week|month|quarter|year)s?\b/i,            // "6 months", "3 weeks"
    /\b\d+x\s+in\b/i,                                        // "3x in"
    /\bfrom\s+\d.*\bto\s+\d/i,                               // "from 10 to 50"
    /\bgrew\s+\d|\b\d+%\s+(growth|increase|rise)\b/i,        // "grew 40%"
    /\bQ[1-4]\s+20\d{2}\b/i                                   // "Q2 2026"
  ];
  for (var i = 0; i < patterns.length; i++) {
    if (patterns[i].test(text)) return true;
  }
  return false;
}

// ─── TRIGGER EVENT IDENTIFICATION ───────────────────────────

/**
 * Identifies trigger events that make now a good time to reach out.
 * Enhanced with recency signals and specificity.
 *
 * @param {Object} lead - Lead object
 * @param {Object} company - Company research result
 * @returns {Array} Array of trigger events { event: string, relevance: string, recency: string }
 */
function _identifyTriggers(lead, company) {
  var triggers = [];

  if (!company) {
    return triggers;
  }

  // Latest funding trigger (most actionable)
  if (company.latestFundingRound && company.latestFundingRound.length > 10 &&
      company.latestFundingRound.toLowerCase().indexOf('no ') !== 0) {
    triggers.push({
      event: 'Funding: ' + company.latestFundingRound.substring(0, 80),
      relevance: 'Post-funding companies actively build Strategy/Ops/Growth teams. Peak hiring window.',
      recency: 'recent'
    });
  }

  // Legacy fundingInfo support
  if (triggers.length === 0 && company.fundingInfo && company.fundingInfo.toLowerCase().indexOf('raised') >= 0) {
    triggers.push({
      event: 'Funding: ' + company.fundingInfo.substring(0, 80),
      relevance: 'Company scaling, likely building out Strategy/Ops/Growth teams',
      recency: 'unknown'
    });
  }

  // Product launch trigger
  if (company.recentProductLaunches && company.recentProductLaunches.length > 10) {
    triggers.push({
      event: 'Launch: ' + company.recentProductLaunches.substring(0, 80),
      relevance: 'New product needs GTM strategy, ops setup, and growth hacking. Direct fit.',
      recency: 'recent'
    });
  }

  // Leadership change trigger
  if (company.leadershipChanges && company.leadershipChanges.length > 10) {
    triggers.push({
      event: 'Leadership: ' + company.leadershipChanges.substring(0, 80),
      relevance: 'New leaders restructure teams and bring in trusted talent. Window of opportunity.',
      recency: 'recent'
    });
  }

  // Market expansion trigger
  if (company.marketMoves && company.marketMoves.length > 10) {
    triggers.push({
      event: 'Market expansion: ' + company.marketMoves.substring(0, 80),
      relevance: 'Expansion requires ops setup, local GTM, and growth experimentation.',
      recency: 'recent'
    });
  }

  // Hiring trigger
  if (company.hiringSignals && company.hiringSignals.length > 10) {
    triggers.push({
      event: 'Hiring: ' + company.hiringSignals.substring(0, 80),
      relevance: 'Active team expansion, optimal timing for outreach.',
      recency: 'current'
    });
  }

  // Growth signals trigger
  if (company.growthSignals && company.growthSignals.length > 10) {
    triggers.push({
      event: 'Growth: ' + company.growthSignals.substring(0, 80),
      relevance: 'Fast growth needs operational infrastructure and strategic hires.',
      recency: 'ongoing'
    });
  }

  return triggers;
}

// ─── RESEARCH QUALITY SCORING ───────────────────────────────

/**
 * Scores research quality with emphasis on recency, specificity, and hook diversity.
 * @param {Object} dossier - Complete research dossier
 * @returns {Object} { score: 0-1, issues: [] }
 */
function _scoreResearchQuality(dossier) {
  var score = 1.0;
  var issues = [];

  // ── Company research quality ──
  if (!dossier.company || dossier.company.stage === 'UNKNOWN') {
    score -= 0.1;
    issues.push('Company stage unknown');
  }
  if (!dossier.company || !dossier.company.industry || dossier.company.industry === 'Unknown') {
    score -= 0.1;
    issues.push('Company industry unknown');
  }
  if (!dossier.company || !dossier.company.description || dossier.company.description.length < 20) {
    score -= 0.05;
    issues.push('Weak company description');
  }

  // Recency signals (important - stale research = bad hooks)
  if (!dossier.company || !dossier.company.recentNews || dossier.company.recentNews.length < 20) {
    score -= 0.1;
    issues.push('No recent news found - hooks may be stale');
  }
  if (!dossier.company || !dossier.company.challenges || dossier.company.challenges.length < 20) {
    score -= 0.1;
    issues.push('No specific org challenges identified');
  }

  // ── Individual research quality ──
  if (!dossier.individual || !dossier.individual.roleKPIs || dossier.individual.roleKPIs.length === 0) {
    score -= 0.1;
    issues.push('No role KPIs identified');
  }

  // LinkedIn activity (critical for personalization)
  if (!dossier.individual || !dossier.individual.recentLinkedInPosts || dossier.individual.recentLinkedInPosts.length < 10) {
    score -= 0.1;
    issues.push('No LinkedIn post data - personalization will be generic');
  }

  // ── Hook quality (critical for cold email success) ──
  if (!dossier.hooks || dossier.hooks.length === 0) {
    score -= 0.15;
    issues.push('No conversation hooks discovered');
  } else {
    var strongHooks = dossier.hooks.filter(function(h) { return h.strength === 'STRONG'; });
    if (strongHooks.length === 0) {
      score -= 0.1;
      issues.push('No strong hooks found');
    }
    // Diversity bonus: hooks from different types are better
    var hookTypes = {};
    dossier.hooks.forEach(function(h) { hookTypes[h.type || 'unknown'] = true; });
    var typeCount = Object.keys(hookTypes).length;
    if (typeCount >= 3) {
      score = Math.min(1.0, score + 0.05);
    }
  }

  // ── Resume cross-validation quality ──
  if (dossier.resumeCrossValidation) {
    if (dossier.resumeCrossValidation.topMatches.length > 0) {
      score = Math.min(1.0, score + 0.05);
    }
    if (dossier.resumeCrossValidation.bridgeStatements.length > 0) {
      score = Math.min(1.0, score + 0.05);
    }
  }

  // ── Trigger events are bonus ──
  if (dossier.triggerEvents && dossier.triggerEvents.length > 0) {
    score = Math.min(1.0, score + 0.05);
  }

  return { score: Math.max(0, score), issues: issues };
}

// ─── DOSSIER COMPRESSION ────────────────────────────────────

/**
 * Compresses research dossier into a compact format for storage in spreadsheet.
 * Enhanced to carry new fields (LinkedIn posts, bridge statements, etc.).
 *
 * @param {Object} dossier - Full research dossier
 * @returns {Object} Compressed dossier suitable for spreadsheet storage
 */
function _compressDossier(dossier) {
  var company = dossier.company || {};
  var individual = dossier.individual || {};
  var hooks = dossier.hooks || [];
  var triggers = dossier.triggerEvents || [];
  var crossVal = dossier.resumeCrossValidation || {};
  var sharedBg = dossier.sharedBackground || [];

  return {
    companyName: company.name || '',
    industryStage: (company.industry || 'Unknown') + ' / ' + (company.stage || 'UNKNOWN'),
    companyDescription: company.description || '',
    // PATCH -eq8-draftpolish (F3): persist entity-mismatch flags so BatchProcessor
    // can gate on them after decompression (compression previously stripped _orgMismatch).
    orgMismatch: company._orgMismatch ? true : false,
    orgMismatchDetail: company._orgMismatchDetail || '',
    // New: richer company context
    recentNews: company.recentNews || '',
    latestFunding: company.latestFundingRound || '',
    recentLaunches: company.recentProductLaunches || '',
    leadershipChanges: company.leadershipChanges || '',
    marketMoves: company.marketMoves || '',
    teamStructure: company.teamStructure || '',
    challenges: company.challenges || '',
    hiringSignals: company.hiringSignals || '',
    growthSignals: company.growthSignals || '',
    relevanceToGaurav: company.relevanceToGaurav || '',
    // Hooks and triggers
    hooksCount: hooks.length,
    hooksJson: JSON.stringify(hooks),
    triggersCount: triggers.length,
    triggersJson: JSON.stringify(triggers),
    // Individual
    roleKPIsJson: JSON.stringify(individual.roleKPIs || []),
    painPointsJson: JSON.stringify(individual.painPoints || []),
    communicationStyle: individual.communicationStyle || '',
    decisionPower: individual.decisionPower || '',
    // New: LinkedIn activity
    recentLinkedInPosts: individual.recentLinkedInPosts || '',
    bestHookAngle: individual.bestHookAngle || '',
    thoughtLeadershipJson: JSON.stringify(individual.thoughtLeadershipTopics || []),
    // New: resume cross-validation (defensive: crossVal may lack these keys)
    bridgeStatementsJson: JSON.stringify((crossVal && crossVal.bridgeStatements) ? crossVal.bridgeStatements : []),
    relevantVariant: (crossVal && crossVal.relevantVariant) ? crossVal.relevantVariant : '',
    // Shared background
    sharedBackgroundJson: JSON.stringify(sharedBg),
    // Quality
    qualityScore: (dossier.qualityScore || 0).toFixed(2),
    qualityIssues: (dossier.qualityIssues || []).join('; '),
    timestamp: dossier.timestamp
  };
}

/**
 * Decompresses a dossier stored as JSON string in the spreadsheet back into a usable object.
 * Handles both JSON strings and already-parsed objects. Reverses _compressDossier().
 * Enhanced to reconstruct new fields (LinkedIn posts, bridge statements, etc.).
 *
 * @param {string|Object} compressed - JSON string or object from RESEARCH_JSON column
 * @returns {Object|null} Decompressed dossier with parsed arrays, or null if invalid
 */
function decompressDossier(compressed) {
  if (!compressed) return null;

  try {
    // Parse if it's a string
    var obj = (typeof compressed === 'string') ? JSON.parse(compressed) : compressed;

    // If it's already a full dossier (has company/individual keys), return as-is
    if (obj.company && obj.individual) return obj;

    // Reconstruct from compressed format
    var industryStage = (obj.industryStage || '').split(' / ');

    var co = {
      name: obj.companyName || '',
      industry: industryStage[0] || 'Unknown',
      stage: industryStage[1] || 'UNKNOWN',
      description: obj.companyDescription || '',
      // New rich fields
      recentNews: obj.recentNews || '',
      latestFundingRound: obj.latestFunding || '',
      recentProductLaunches: obj.recentLaunches || '',
      leadershipChanges: obj.leadershipChanges || '',
      marketMoves: obj.marketMoves || '',
      teamStructure: obj.teamStructure || '',
      challenges: obj.challenges || '',
      hiringSignals: obj.hiringSignals || '',
      growthSignals: obj.growthSignals || '',
      relevanceToGaurav: obj.relevanceToGaurav || '',
      // Legacy compat
      fundingInfo: obj.latestFunding || '',
      size: null,
      domain: null,
      // PATCH -eq8-draftpolish (F3): restore entity-mismatch flags from compressed storage
      _orgMismatch: obj.orgMismatch ? true : false,
      _orgMismatchDetail: obj.orgMismatchDetail || ''
    };
    var hooks = _safeParse(obj.hooksJson, []);
    var triggers = _safeParse(obj.triggersJson, []);
    var roleKPIs = _safeParse(obj.roleKPIsJson, []);
    var painPoints = _safeParse(obj.painPointsJson, []);
    var thoughtLeadership = _safeParse(obj.thoughtLeadershipJson, []);
    var bridgeStatements = _safeParse(obj.bridgeStatementsJson, []);
    var sharedBg = _safeParse(obj.sharedBackgroundJson, []);

    return {
      co: co,
      company: co,
      industry: co.industry,
      hooks: hooks,
      triggers: triggers,
      triggerEvents: triggers,
      roleKPIs: roleKPIs,
      role: roleKPIs,
      painPoints: painPoints,
      communicationStyle: obj.communicationStyle || '',
      decisionPower: obj.decisionPower || '',
      seniority: obj.decisionPower || '',
      signals: triggers,
      // New fields (top-level aliases so EmailComposer can access them directly)
      recentNews: obj.recentNews || '',
      recentLinkedInPosts: obj.recentLinkedInPosts || '',
      bestHookAngle: obj.bestHookAngle || '',
      thoughtLeadershipTopics: thoughtLeadership,
      bridgeStatements: bridgeStatements,
      relevantVariant: obj.relevantVariant || '',
      // Shared background
      sharedBackground: sharedBg,
      // Classifier compat
      education: null,
      contentLinks: null,
      recentCareerSwitch: false,
      // Quality
      qualityScore: parseFloat(obj.qualityScore) || 0,
      qualityIssues: obj.qualityIssues ? obj.qualityIssues.split('; ') : [],
      timestamp: obj.timestamp || null,
      // PATCH -eq8-draftpolish (F3): top-level alias so BatchProcessor gate works
      // whether it checks compressedDossier._orgMismatch or compressedDossier.company._orgMismatch
      _orgMismatch: obj.orgMismatch ? true : false,
      _orgMismatchDetail: obj.orgMismatchDetail || ''
    };
  } catch (e) {
    Logger.log('decompressDossier: Failed to parse - ' + e.message);
    return null;
  }
}

/**
 * Safely parses a JSON string, returning a fallback on failure.
 * @param {string} jsonStr - JSON string to parse
 * @param {*} fallback - Value to return if parsing fails
 * @returns {*} Parsed value or fallback
 */
function _safeParse(jsonStr, fallback) {
  if (!jsonStr) return fallback;
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    return fallback;
  }
}
