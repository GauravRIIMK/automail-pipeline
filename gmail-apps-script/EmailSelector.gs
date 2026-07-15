/**
 * ============================================================
 * EmailSelector.gs — Unified multi-signal email selection
 * (Patch 2026-05-19)
 * ============================================================
 *
 * SINGLE DECISION POINT for picking the best email address for a lead.
 * Replaces the previous N-path cascade where each path had independent
 * thresholds. Now: gather all candidates from all sources, gather all
 * signals once, score each candidate with explicit weighted reasons,
 * pick the highest-scoring survivor.
 *
 * Design principles:
 *
 *   1. ALWAYS produce an email if any plausibly-real candidate exists.
 *      Confidence reflects trust level; status drives review/send routing.
 *
 *   2. Treat each external verifier as ADVISORY, not authoritative.
 *      Reoon, Hunter, Apollo each contribute weighted points. No single
 *      source can independently reject a candidate (except hard signals:
 *      spamtraps, disposables, explicit Hunter-invalid, suppressed domains).
 *
 *   3. DOMAIN-AWARE scoring — well-known corporate domains with aggressive
 *      anti-bot SMTP defenses (Amazon, PhonePe, Uber, top Indian fintech)
 *      get reduced Reoon-invalid penalty because their false-negative
 *      rate is empirically high. Tuned from real bounce + reply data.
 *
 *   4. MULTI-SOURCE CONSENSUS bonus — when 2+ independent sources
 *      converge on the same email, score gets boosted. This catches the
 *      "Apollo and Hunter and pattern-guess all agree" case as highest
 *      confidence even if each individual signal is moderate.
 *
 *   5. NAME-PATTERN VALIDATION — the local-part should look like the
 *      person's name (first.last, flast, etc.). Catches stale-Apollo
 *      and same-domain-wrong-person cases.
 *
 *   6. EXPLICIT REASONS — every score component is logged in the
 *      `reasons[]` array so debugging is trivial. No more "why did
 *      this lead end at NEEDS_EMAIL?" mysteries.
 *
 * Entry point:  selectBestEmail(lead) → enrichEmail-compatible result
 * Diagnostic:   diagnoseEmailSelection(lead) → full scoring trace for inspection
 */

// ─── DOMAIN KNOWLEDGE LAYER ───────────────────────────────────────────────
//
// Empirically-known corporate domains where Reoon's SMTP probe is
// consistently rejected by anti-bot defenses, yielding false-negative
// `invalid` verdicts for legitimate addresses. For these domains, we
// apply a SOFT penalty (-5) instead of the HARD penalty (-20) used for
// truly-unknown domains.
//
// Maintenance: when a real bounce comes back for one of these, downgrade
// or remove the entry. When false negatives are observed at a new domain,
// add it. Dynamic version (TODO): learn from bounce + reply history.

var REOON_FALSE_NEGATIVE_DOMAINS = {
  // Big Tech (aggressive bot detection)
  'amazon.com': 1, 'amazon.in': 1, 'aws.amazon.com': 1, 'microsoft.com': 1,
  'apple.com': 1, 'google.com': 1, 'meta.com': 1, 'fb.com': 1,
  'linkedin.com': 1, 'salesforce.com': 1, 'oracle.com': 1, 'adobe.com': 1,
  'ibm.com': 1, 'nvidia.com': 1, 'netflix.com': 1, 'uber.com': 1,
  'airbnb.com': 1, 'stripe.com': 1, 'twilio.com': 1, 'atlassian.com': 1,

  // Indian fintech + commerce
  'phonepe.com': 1, 'paytm.com': 1, 'razorpay.com': 1, 'cred.club': 1,
  'cashfree.com': 1, 'kreditbee.in': 1, 'jupiter.money': 1, 'fi.money': 1,
  'flipkart.com': 1, 'myntra.com': 1, 'meesho.com': 1, 'snapdeal.com': 1,
  'blinkit.com': 1, 'zeptonow.com': 1, 'instamart.swiggy.in': 1,
  'swiggy.in': 1, 'zomato.com': 1, 'urbancompany.com': 1,
  'ola.com': 1, 'olacabs.com': 1, 'rapido.bike': 1, 'makemytrip.com': 1,

  // Consulting (heavy compliance / mail filtering)
  'mckinsey.com': 1, 'bcg.com': 1, 'bain.com': 1, 'kpmg.com': 1,
  'deloitte.com': 1, 'ey.com': 1, 'pwc.com': 1, 'accenture.com': 1,
  'thoughtworks.com': 1, 'cognizant.com': 1, 'infosys.com': 1,
  'tcs.com': 1, 'wipro.com': 1, 'capgemini.com': 1,

  // Banking + finance (high security mail infra)
  'jpmorgan.com': 1, 'jpmorganchase.com': 1, 'goldmansachs.com': 1,
  'morganstanley.com': 1, 'citigroup.com': 1, 'wellsfargo.com': 1,
  'hdfcbank.com': 1, 'icicibank.com': 1, 'kotak.com': 1, 'axisbank.com': 1
};

// Source weight when a candidate originates from a particular signal.
// Higher = more trustworthy origin.
//
// PATCH 2026-05-20 (user-mandated reorder): the hierarchy is now
// Apollo > Hunter > internal pattern engine > APK DOM.
//
// Rationale:
//   - Apollo (B2B authoritative DB, URL-keyed lookups) is the strongest
//     signal because /people/match resolves the exact person+employer
//     unambiguously from a LinkedIn URL.
//   - Hunter (B2B email-finder, MX-aware) is second — independent corpus,
//     own pattern intelligence, but no URL-keyed lookup.
//   - Internal pattern-guess engine (our "Lusha-level" stack: pattern
//     first.last/flast/firstlast @ resolved domain, MX-validated, Reoon-
//     verified) is third — heuristic + verified-deliverability stack.
//   - APK DOM (User-extracted via the LinkedIn app) is LOWEST because
//     the LinkedIn "Contact info" section often holds a personal Gmail
//     rather than the recipient's work email. APK is useful as a CROSS-
//     CHECK (when it agrees with Apollo/Hunter, that's diversity), not
//     as an authoritative source on its own.
var SOURCE_WEIGHTS = {
  // Apollo — highest trust (URL-keyed, authoritative B2B database)
  apollo_verified:         42,
  apollo_likely_to_engage: 36,
  apollo_unverified:       24,
  apollo_extrapolated:     16,

  // Hunter — second-tier authoritative external source
  hunter_finder:           32,

  // Internal pattern engine ("Lusha-level") — heuristic + MX + Reoon stack
  pattern_first_last:      14,
  pattern_flast:           10,
  pattern_firstlast:       10,
  pattern_first:            6,
  pattern_other:            3,

  // APK DOM — lowest trust (often personal email, not work address)
  // Score deliberately low so APK alone cannot drive a Tier 0 ship.
  // When APK matches an authoritative source, diversity boost handles it.
  apk_provided:             4
};

// ─── PUBLIC ENTRY POINT ────────────────────────────────────────────────────

/**
 * Returns the best email for this lead, with full scoring trace.
 *
 * Result shape (matches enrichEmail's contract):
 *   {
 *     status:       'VERIFIED' | 'NEEDS_EMAIL_REVIEW' | 'NEEDS_EMAIL',
 *     email:        '<chosen address>' | '',
 *     confidence:   0.0 - 1.0,
 *     score:        raw scoring sum (typically -50 to +120),
 *     reasons:      [string]  — every score component, in order
 *     source:       'unified_selector_<primary_origin>',
 *     domain:       parsed domain,
 *     candidates:   top 5 considered (winner first),
 *     runnerUps:    next-3 with their scores + sources,
 *     originalEmail: lead.email (APK-provided, if any),
 *     classification: 'CORPORATE' | 'FREE' | 'INVALID',
 *     reoonStatus:  for compatibility with downstream PSV
 *   }
 */
function selectBestEmail(lead) {
  var startTime = Date.now();
  if (!lead) return _selectorNoResult('no_lead_object');

  Logger.log('[EmailSelector] Starting selection for row ' + (lead.rowNum || '?') +
             ' (' + (lead.fullName || 'unknown') + ' @ ' + (lead.organization || 'unknown') + ')');

  // ── PHASE 1: Gather all candidates from all sources ─────────────────
  var gathering = _gatherCandidates(lead);
  if (gathering.candidates.length === 0) {
    Logger.log('[EmailSelector] No candidates gathered — terminal NEEDS_EMAIL');
    return _selectorNoResult('no_candidates_from_any_source', gathering);
  }

  Logger.log('[EmailSelector] Gathered ' + gathering.candidates.length +
             ' candidates across ' + gathering.sourcesContributed.length + ' sources');

  // ── PHASE 2: Gather all signals once (avoid redundant API calls) ────
  var signals = _gatherSignals(lead, gathering);

  // ── PHASE 3: Score each candidate ──────────────────────────────────
  gathering.candidates.forEach(function(c) {
    var s = _scoreCandidate(c, lead, signals);
    c.score = s.score;
    c.reasons = s.reasons;
    c.hardRejected = s.hardRejected;
  });

  // ── PHASE 4: Filter hard-rejected (spamtrap, hunter_invalid, etc.) ──
  var alive = gathering.candidates.filter(function(c) {
    return !c.hardRejected && c.score > 0;
  });
  if (alive.length === 0) {
    Logger.log('[EmailSelector] All ' + gathering.candidates.length +
               ' candidates hard-rejected or zero-scored');
    return _selectorNoResult('all_candidates_rejected', {
      candidates: gathering.candidates.map(function(c) {
        return { email: c.email, score: c.score, hardRejected: c.hardRejected, reasons: c.reasons };
      })
    });
  }

  // ── PHASE 5: Apply DIVERSITY-WEIGHTED consensus boost ───────────────
  //
  // PATCH 2026-05-20 (consensus-first selection): the previous +7/+15
  // bonus was too weak — when 3 different SOURCE TYPES (Apollo + APK +
  // Hunter + pattern) agreed on the same email, the boost was small
  // relative to single-source signal weight, and confidence still
  // landed sub-0.55. That's why the system "needed a human" to pick.
  //
  // Logic: cluster sources by TYPE (apollo / apk / hunter / pattern).
  // Distinct types agreeing = strong independent corroboration:
  //   - 1 type only            : no boost
  //   - 2 distinct types agree : score *= 1.4 + floor at 55 (VERIFIED)
  //   - 3 distinct types agree : score *= 1.8 + floor at 75
  //   - 4+ distinct types agree: score *= 2.2 + floor at 90
  //
  // Multiple pattern variants (first.last + flast + first) at the same
  // domain count as ONE type because they share the same domain hypothesis.
  // Apollo verified + Apollo extrapolated likewise count as one type.
  alive.forEach(function(c) {
    var typeSet = {};
    c.sources.forEach(function(s) {
      var t = _sourceType(s.name);
      if (t) typeSet[t] = true;
    });
    c.diversity = Object.keys(typeSet).length;
    c.diversityTypes = Object.keys(typeSet);
    var beforeBoost = c.score;
    if (c.diversity >= 4) {
      c.score = Math.max(Math.round(c.score * 2.2), 90);
      c.reasons.push('diversity_4plus_types_x2.2_floor90 (' + c.diversityTypes.join('+') + ')');
    } else if (c.diversity >= 3) {
      c.score = Math.max(Math.round(c.score * 1.8), 75);
      c.reasons.push('diversity_3types_x1.8_floor75 (' + c.diversityTypes.join('+') + ')');
    } else if (c.diversity === 2) {
      c.score = Math.max(Math.round(c.score * 1.4), 55);
      c.reasons.push('diversity_2types_x1.4_floor55 (' + c.diversityTypes.join('+') + ')');
    } else {
      c.reasons.push('diversity_1type_no_boost (' + c.diversityTypes.join(',') + ')');
    }
    if (c.score !== beforeBoost) {
      Logger.log('[EmailSelector] Diversity boost for ' + c.email +
                 ': ' + beforeBoost + ' -> ' + c.score + ' (' + c.diversity + ' types: ' +
                 c.diversityTypes.join('+') + ')');
    }
  });

  // ── PHASE 6: Sort and pick winner ──────────────────────────────────
  // LEGACY: diversity DESC, then score DESC (cross-source agreement first).
  // G1 (ENRICHMENT_SORT_V2): score DESC first, diversity as tiebreak. Research
  // §1b: bounce risk tracks the verification verdict (reoon_safe <2% vs
  // unverified/catch-all ~30%), NOT how many sources proposed the address. A
  // verified single source must outrank weak unverified consensus. The +20
  // reoon_safe / +25 hunter weights already make verified candidates score
  // higher, so score-first naturally promotes them.
  var _sortV2 = _enrichmentFlag('ENRICHMENT_SORT_V2');
  alive.sort(function(a, b) {
    if (_sortV2) {
      if (b.score !== a.score) return b.score - a.score;
      return b.diversity - a.diversity;
    }
    if (b.diversity !== a.diversity) return b.diversity - a.diversity;
    return b.score - a.score;
  });
  var winner = alive[0];

  // ── PHASE 7: Diversity-aware confidence computation ───────────────
  // Confidence floor by diversity. G1 (ENRICHMENT_SORT_V2): gate the floor on
  // the winner having >=1 VERIFIED signal (reoon_safe / hunter_valid). The
  // floor must not force confidence UP on source-count alone (research §4 —
  // "decoupled from bounce probability, backwards"). Flag OFF → floor always
  // applies (legacy).
  var confidence = Math.max(0, Math.min(1.0, winner.score / 100));
  var _winnerVerified = /reoon_safe|hunter_valid/.test((winner.reasons || []).join('|'));
  var _applyFloor = (!_sortV2) || _winnerVerified;
  if (_applyFloor) {
    if (winner.diversity >= 4) {
      confidence = Math.max(confidence, 0.90);
    } else if (winner.diversity >= 3) {
      confidence = Math.max(confidence, 0.80);
    } else if (winner.diversity >= 2) {
      confidence = Math.max(confidence, 0.65);
    }
  }
  // No floor for single-source — they keep their raw signal-based score.

  var status;
  if (confidence >= 0.55)      status = 'VERIFIED';
  else                         status = 'NEEDS_EMAIL_REVIEW';

  var elapsed = Date.now() - startTime;
  Logger.log('[EmailSelector] Winner: ' + winner.email + ' score=' + winner.score +
             ' conf=' + confidence.toFixed(2) + ' diversity=' + winner.diversity +
             ' (' + (winner.diversityTypes || []).join('+') + ') source=' + winner.primarySource +
             ' (elapsed ' + elapsed + 'ms)');

  // G6 (ENRICHMENT_CLASSIFY_V2): classify from the WINNING domain rather than
  // hardcoding CORPORATE. Freemail winner → 'FREE'; role-account local-part →
  // roleAccount flag for downstream. Flag OFF → legacy 'CORPORATE', no flag.
  var _classifyV2 = _enrichmentFlag('ENRICHMENT_CLASSIFY_V2');
  var _winnerLocal = (winner.email || '').split('@')[0].toLowerCase();
  var _winnerDom = (winner.domain || '').toLowerCase();
  var _classification = 'CORPORATE';
  if (_classifyV2 && typeof FREE_EMAIL_DOMAINS !== 'undefined' && FREE_EMAIL_DOMAINS[_winnerDom]) {
    _classification = 'FREE';
  }
  var _roleAccount = _classifyV2 &&
    /^(info|hr|jobs|careers|recruiting|recruitment|support|admin|contact|hello|team|sales|help|office|noreply|no-reply)$/.test(_winnerLocal);

  return {
    status: status,
    email: winner.email,
    confidence: confidence,
    score: winner.score,
    diversity: winner.diversity,
    diversityTypes: winner.diversityTypes,
    reasons: winner.reasons,
    source: 'unified_selector_' + winner.primarySource,
    domain: winner.domain,
    classification: _classification,
    roleAccount: _roleAccount,
    reoonStatus: signals.reoonByEmail[winner.email] ? signals.reoonByEmail[winner.email].status : 'not_verified',
    candidates: alive.slice(0, 5).map(function(c) { return c.email; }),
    runnerUps: alive.slice(1, 4).map(function(c) {
      return { email: c.email, score: c.score, diversity: c.diversity, source: c.primarySource };
    }),
    originalEmail: lead.email || '',
    selectorElapsedMs: elapsed
  };
}

/**
 * Source-type classifier (Patch 2026-05-20 consensus scoring).
 * Maps a candidate's source name to a high-level INDEPENDENT TYPE.
 * Multiple variants within the same type count as one for diversity.
 *
 *   apollo_*          → apollo   (Apollo people/orgs — one upstream API)
 *   apk_provided      → pattern  (F4 2026-06-23: collapsed into 'pattern' — a DOM-scraped
 *                                 email is correlated with a same-address pattern guess,
 *                                 NOT independent corroboration. Unconditional, not flag-gated.)
 *   hunter_finder     → hunter   (Hunter Email Finder API)
 *   pattern_*         → pattern  (Heuristic pattern guess at resolved domain)
 *   mx_dominant       → mx       (Dominant pattern observed at the domain)
 */
function _sourceType(sourceName) {
  if (!sourceName) return '';
  var n = sourceName.toString().toLowerCase();
  if (n.indexOf('apollo') === 0) return 'apollo';
  if (n.indexOf('apk') === 0) {
    // PATCH 2026-06-23 (F4 email-core): collapse apk -> 'pattern' UNCONDITIONALLY.
    // A DOM-scraped APK email and a pattern guess that produce the SAME address are
    // CORRELATED (both reflect the dominant-pattern hypothesis at the resolved
    // domain), not independent corroboration. Counting them as 2 distinct types
    // manufactured a false diversity-2 boost (x1.4 + floor 0.55) -> shipping Tier0
    // VERIFIED with NO [VERIFY] prefix despite zero independent confirmation (the
    // A16 class; the largest high-confidence-bounce risk in the 2026-06-23
    // baseline). This was previously gated on the ENRICHMENT_SOURCETYPE_V2
    // ScriptProperty being promoted; making it the CODE DEFAULT means a property
    // reset can no longer silently re-open the hole. apk + apollo (genuinely
    // independent) still counts as 2 types and still earns the boost.
    return 'pattern';
  }
  if (n.indexOf('hunter') === 0) return 'hunter';
  if (n.indexOf('pattern') === 0) return 'pattern';
  if (n.indexOf('mx') === 0 || n.indexOf('dominant') >= 0) return 'mx';
  return n;
}

/**
 * Read-only diagnostic — returns full reasoning trace for one lead WITHOUT
 * affecting any state. Use to inspect why a specific lead got the email it did.
 */
function diagnoseEmailSelection(lead) {
  var result = selectBestEmail(lead);
  return {
    chosenEmail: result.email,
    chosenScore: result.score,
    chosenConfidence: result.confidence,
    chosenReasons: result.reasons,
    chosenSource: result.source,
    runnerUps: result.runnerUps,
    originalEmail: result.originalEmail,
    elapsedMs: result.selectorElapsedMs
  };
}

// ─── PHASE 1 — CANDIDATE GATHERING ────────────────────────────────────────

function _gatherCandidates(lead) {
  var candidates = {};  // email → { email, sources: [...], sourceCount, primarySource, ... }
  var sourcesContributed = [];

  function _addCandidate(email, sourceName, sourceWeight, meta) {
    if (!email || email.indexOf('@') < 0) return;
    email = email.toString().toLowerCase().trim();
    if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) return;
    if (!candidates[email]) {
      candidates[email] = {
        email: email,
        domain: email.split('@')[1],
        sources: [],
        sourceCount: 0,
        primarySource: sourceName,
        meta: {}
      };
      if (sourcesContributed.indexOf(sourceName) < 0) sourcesContributed.push(sourceName);
    }
    candidates[email].sources.push({ name: sourceName, weight: sourceWeight, meta: meta || {} });
    candidates[email].sourceCount = candidates[email].sources.length;
    // Update primary source if this one has higher weight
    var current = candidates[email].sources.reduce(function(best, s) {
      return s.weight > best.weight ? s : best;
    }, candidates[email].sources[0]);
    candidates[email].primarySource = current.name;
    Object.keys(meta || {}).forEach(function(k) { candidates[email].meta[k] = meta[k]; });
  }

  // ── Source 1: Apollo /people/match ─────────────────────────────────
  if (lead.linkedinUrl && typeof resolveLeadApolloMatch === 'function') {
    try {
      var apolloMatch = resolveLeadApolloMatch(lead.linkedinUrl);
      if (apolloMatch && apolloMatch.email) {
        var apolloStatus = (apolloMatch.emailStatus || '').toLowerCase();
        var apolloSource = 'apollo_' + (apolloStatus.replace(/\s+/g, '_') || 'unknown');
        var apolloWeight = SOURCE_WEIGHTS['apollo_' + apolloStatus.replace(/\s+/g, '_')] ||
                           SOURCE_WEIGHTS.apollo_unverified;
        _addCandidate(apolloMatch.email, apolloSource, apolloWeight, {
          apolloStatus: apolloStatus,
          apolloOrgName: apolloMatch.organizationName,
          apolloDomain: apolloMatch.domain
        });
      }
    } catch (e) {
      Logger.log('[EmailSelector] Apollo gather failed: ' + e.message);
    }
  }

  // ── Source 2: APK-provided email (lead.email) ──────────────────────
  if (lead.email && lead.email.indexOf('@') > 0) {
    _addCandidate(lead.email, 'apk_provided', SOURCE_WEIGHTS.apk_provided, {
      providedByAPK: true
    });
  }

  // ── Source 3+: Pattern guesses at resolved org domain ──────────────
  // Resolve org → domain via existing contextual resolver
  var orgDomain = '';
  var orgDomainConfidence = 0;
  if (lead.organization && typeof resolveDomainContextual === 'function') {
    try {
      var resolved = resolveDomainContextual(lead.organization, {
        firstName: lead.firstName,
        lastName: lead.lastName,
        linkedinUrl: lead.linkedinUrl || '',
        headline: lead.headline || ''
      });
      if (resolved && resolved.domain) {
        orgDomain = resolved.domain.toLowerCase();
        orgDomainConfidence = resolved.confidence || 0;
      }
    } catch (e) {
      Logger.log('[EmailSelector] resolveDomainContextual failed: ' + e.message);
    }
  }
  if (!orgDomain && typeof _organizationToDomain === 'function') {
    try { orgDomain = _organizationToDomain(lead.organization); } catch (_) {}
  }

  // Pattern guesses if we have a domain + first name
  if (orgDomain && lead.firstName) {
    try {
      var patternEmails = guessProfessionalEmail(lead.firstName, lead.lastName || '', orgDomain);
      // Map pattern position → semantic source name + weight
      var patternKeys = ['pattern_first_last', 'pattern_flast', 'pattern_firstlast',
                         'pattern_first', 'pattern_other'];
      patternEmails.slice(0, 5).forEach(function(em, idx) {
        var sourceName = patternKeys[idx] || 'pattern_other';
        var weight = SOURCE_WEIGHTS[sourceName] || SOURCE_WEIGHTS.pattern_other;
        _addCandidate(em, sourceName, weight, {
          patternRank: idx,
          orgDomain: orgDomain,
          orgDomainConfidence: orgDomainConfidence
        });
      });
    } catch (e) {
      Logger.log('[EmailSelector] guessProfessionalEmail failed: ' + e.message);
    }
  }

  // ── Source 4: Hunter Email Finder (paid call — quota-gated) ────────
  // Only fire if we have firstName + lastName + domain AND no high-weight
  // source has already produced a candidate. Saves quota on easy wins.
  var hunterFinderUsed = false;
  if (lead.firstName && lead.lastName && orgDomain && typeof _selectorHunterFinderFallback === 'function') {
    var alreadyHighConf = Object.keys(candidates).some(function(em) {
      return candidates[em].sources.some(function(s) {
        return s.weight >= SOURCE_WEIGHTS.apollo_verified;
      });
    });
    if (!alreadyHighConf) {
      try {
        var hunterEmail = _selectorHunterFinderFallback(lead.firstName, lead.lastName, orgDomain);
        if (hunterEmail) {
          _addCandidate(hunterEmail, 'hunter_finder', SOURCE_WEIGHTS.hunter_finder, {
            hunterFinderHit: true
          });
          hunterFinderUsed = true;
        }
      } catch (e) {
        Logger.log('[EmailSelector] Hunter Email Finder failed: ' + e.message);
      }
    }
  }

  return {
    candidates: Object.keys(candidates).map(function(k) { return candidates[k]; }),
    sourcesContributed: sourcesContributed,
    orgDomain: orgDomain,
    orgDomainConfidence: orgDomainConfidence,
    hunterFinderUsed: hunterFinderUsed
  };
}

// ─── PHASE 2 — SIGNAL GATHERING ───────────────────────────────────────────

function _gatherSignals(lead, gathering) {
  var signals = {
    reoonByEmail: {},
    hunterByEmail: {},
    mxByDomain: {},
    mxStateByDomain: {},        // G3: 'present' | 'absent' (genuine) | 'transient' (DNS fail)
    dmarcByDomain: {},
    spfByDomain: {},
    bounceHistoryByDomain: {},
    hardBounceByDomain: {},
    hardBounceByAddress: {},    // G4: per-address hard-bounce count (populated once G9 captures bounces)
    dominantPatternByDomain: {},
    orgDomain: gathering.orgDomain
  };

  // G3 (2026-06-22): populate per-address hard-bounce suppression from the durable
  // store so the selector never re-drafts an exact previously-bounced mailbox.
  try {
    var _bouncedAddrs = (typeof getBouncedAddressesMap === 'function') ? getBouncedAddressesMap() : {};
    Object.keys(_bouncedAddrs).forEach(function(_a) {
      var _h = (_bouncedAddrs[_a] && _bouncedAddrs[_a].hard) || 0;
      if (_h >= 1) { signals.hardBounceByAddress[_a] = _h; }
    });
  } catch (_bErr) {}

  // Collect unique domains to query
  var uniqueDomains = {};
  gathering.candidates.forEach(function(c) { uniqueDomains[c.domain] = true; });
  var domainList = Object.keys(uniqueDomains);

  // ── MX records per domain (cached internally by verifyMxRecord) ────
  // G3: also classify the failure into a tri-state. verifyMxRecord returns
  // {hasMx, reason} where reason ∈ 'no_mx_records' (genuine) / 'dns_error:*' /
  // 'dns_http_*' (transient). The boolean is kept for the legacy (flag-off) path.
  domainList.forEach(function(d) {
    try {
      var mx = (typeof verifyMxRecord === 'function') ? verifyMxRecord(d) : null;
      signals.mxByDomain[d] = !!(mx && mx.hasMx);
      if (mx && mx.hasMx) {
        signals.mxStateByDomain[d] = 'present';
      } else {
        var rsn = (mx && mx.reason) ? mx.reason.toString().toLowerCase() : '';
        if (rsn.indexOf('dns_error') >= 0 || rsn.indexOf('dns_http') >= 0 ||
            rsn.indexOf('timeout') >= 0 || rsn.indexOf('timed out') >= 0) {
          signals.mxStateByDomain[d] = 'transient';
        } else {
          signals.mxStateByDomain[d] = 'absent';  // genuine no-MX (or unknown → conservative -50)
        }
      }
    } catch (e) {
      // An exception here is itself a transient lookup failure, not proof of no-MX.
      signals.mxByDomain[d] = false;
      signals.mxStateByDomain[d] = 'transient';
    }
  });

  // ── DMARC + SPF per domain ─────────────────────────────────────────
  domainList.forEach(function(d) {
    try {
      signals.dmarcByDomain[d] = (typeof domainDmarcStrictness === 'function')
        ? domainDmarcStrictness(d) : null;
    } catch (_) {}
    try {
      signals.spfByDomain[d] = (typeof _psvCheckSpf === 'function') ? _psvCheckSpf(d) : false;
    } catch (_) {}
  });

  // ── Bounce history per domain ──────────────────────────────────────
  domainList.forEach(function(d) {
    try {
      signals.bounceHistoryByDomain[d] = (typeof _getDomainBouncePenalty === 'function')
        ? (_getDomainBouncePenalty(d) || 0) : 0;
    } catch (_) {}
    try {
      signals.hardBounceByDomain[d] = (typeof _psvGetHardBounceCount === 'function')
        ? (_psvGetHardBounceCount(d) || 0) : 0;
    } catch (_) {}
  });

  // ── Dominant pattern per domain (Hunter pattern + curated map) ─────
  domainList.forEach(function(d) {
    try {
      if (typeof DOMAIN_PATTERN_MAP !== 'undefined' && DOMAIN_PATTERN_MAP[d]) {
        signals.dominantPatternByDomain[d] = DOMAIN_PATTERN_MAP[d].pattern;
      } else if (typeof fetchHunterPattern === 'function') {
        var hp = fetchHunterPattern(d);
        if (hp) signals.dominantPatternByDomain[d] = hp;
      }
    } catch (_) {}
  });

  // ── Reoon verification for ALL candidates (cached 30 days) ─────────
  // Cap at 8 to keep quota use predictable
  gathering.candidates.slice(0, 8).forEach(function(c) {
    try {
      if (typeof verifyEmailDeliverable === 'function') {
        signals.reoonByEmail[c.email] = verifyEmailDeliverable(c.email) || { status: 'skipped' };
      }
    } catch (_) {}
  });

  // ── Hunter Verifier for top candidates ONLY (1 credit each) ────────
  // Skip if Apollo already said verified (don't double-spend quota)
  gathering.candidates.slice(0, 3).forEach(function(c) {
    var hasApolloVerified = c.sources.some(function(s) {
      return s.name === 'apollo_verified';
    });
    if (hasApolloVerified) return;
    try {
      if (typeof _psvCallHunterVerifier === 'function' &&
          typeof _psvHunterBudgetRemains === 'function' &&
          _psvHunterBudgetRemains()) {
        var hv = _psvCallHunterVerifier(c.email);
        if (hv) {
          signals.hunterByEmail[c.email] = hv;
          if (typeof _psvIncrementHunterUsage === 'function') _psvIncrementHunterUsage();
        }
      }
    } catch (_) {}
  });

  return signals;
}

// ─── PHASE 3 — PER-CANDIDATE SCORING ──────────────────────────────────────

function _scoreCandidate(candidate, lead, signals) {
  var score = 0;
  var reasons = [];
  var hardRejected = false;

  var domain = candidate.domain;
  var localPart = candidate.email.split('@')[0];

  // ── Source-weight contribution (use BEST source if multi-source) ───
  var bestSourceWeight = candidate.sources.reduce(function(max, s) {
    return Math.max(max, s.weight);
  }, 0);
  score += bestSourceWeight;
  reasons.push(candidate.primarySource + ' +' + bestSourceWeight);

  // ── Reoon signal (domain-aware) ────────────────────────────────────
  // (2026-06-12-funnel-truth F3): When Reoon quota is exhausted or the vendor
  // circuit-breaker is OPEN, pattern candidates at an org-matching domain should
  // not receive a score-killing invalid penalty — Reoon couldn't actually check
  // them, so the result is unreliable. Retain a mid-tier score so an org-correct
  // pattern beats a wrong-person verified match from another vendor.
  var _reoonBreakerOn = false;
  try {
    _reoonBreakerOn = (typeof vendorHealthShouldSkip === 'function' && vendorHealthShouldSkip('reoon')) ||
                      (typeof _reoonQuickQuotaExhausted === 'function' && _reoonQuickQuotaExhausted());
  } catch (_) {}

  var rv = signals.reoonByEmail[candidate.email];
  if (rv) {
    var isKnownFalseNegDomain = !!REOON_FALSE_NEGATIVE_DOMAINS[domain];
    if (rv.status === 'safe') {
      score += 20; reasons.push('reoon_safe +20');
    } else if (rv.status === 'role_account') {
      score += 10; reasons.push('reoon_role_account +10');
    } else if (rv.status === 'catch_all') {
      score += 3;  reasons.push('reoon_catch_all +3');
    } else if (rv.status === 'unknown') {
      score += 0;  reasons.push('reoon_unknown +0');
    } else if (rv.status === 'invalid' || rv.status === 'disabled') {
      // (2026-06-12-funnel-truth F3): breaker-on + pattern candidate at org domain →
      // skip the invalid penalty; mark as pattern_unverified so scoring is honest.
      var _isPatternSrc = candidate.sources.some(function(s) {
        return (s.name || '').indexOf('pattern_') === 0 || s.name === 'apk_provided';
      });
      var _domainMatchesOrg = signals.orgDomain && (_baseDomain(domain) === _baseDomain(signals.orgDomain));
      if (_reoonBreakerOn && _isPatternSrc && _domainMatchesOrg) {
        score += 0; reasons.push('reoon_skipped_breaker_on_pattern_unverified +0');
      } else if (isKnownFalseNegDomain) {
        score -= 5;  reasons.push('reoon_disputed_known_false_neg_domain -5');
      } else {
        score -= 15; reasons.push('reoon_invalid -15');
      }
    } else if (rv.status === 'spamtrap' || rv.status === 'disposable') {
      hardRejected = true; reasons.push('reoon_hard_reject_spamtrap_or_disposable');
    }
  }

  // ── Hunter Verifier signal ─────────────────────────────────────────
  var hv = signals.hunterByEmail[candidate.email];
  if (hv) {
    if (hv.status === 'valid' && hv.score >= 70) {
      score += 25; reasons.push('hunter_valid_high +25');
    } else if (hv.status === 'valid' && hv.score >= 40) {
      score += 15; reasons.push('hunter_valid_mid +15');
    } else if (hv.status === 'valid') {
      score += 8;  reasons.push('hunter_valid_low +8');
    } else if (hv.status === 'accept_all') {
      score += 10; reasons.push('hunter_accept_all +10');
    } else if (hv.status === 'invalid') {
      hardRejected = true; reasons.push('hunter_hard_reject_invalid');
    }
  }

  // ── MX records (hard signal) ───────────────────────────────────────
  // G3 (ENRICHMENT_MX_V2): distinguish transient DNS failure from genuine
  // no-MX. Legacy: any !hasMx → -50 (a DNS timeout silently kills a good
  // candidate, sending the lead to NEEDS_EMAIL). V2: present +8 / genuine
  // absent -50 / transient 0 (no penalty — retry next tick). Flag OFF → legacy.
  if (_enrichmentFlag('ENRICHMENT_MX_V2')) {
    var _mxState = (signals.mxStateByDomain && signals.mxStateByDomain[domain]) ||
                   (signals.mxByDomain[domain] ? 'present' : 'absent');
    if (_mxState === 'present') { score += 8; reasons.push('mx_present +8'); }
    else if (_mxState === 'transient') { reasons.push('mx_transient_unknown_0'); }
    else { score -= 50; reasons.push('no_mx -50'); }
  } else {
    if (signals.mxByDomain[domain]) {
      score += 8; reasons.push('mx_present +8');
    } else {
      score -= 50; reasons.push('no_mx -50');
    }
  }

  // ── DMARC + SPF ────────────────────────────────────────────────────
  var dmarc = signals.dmarcByDomain[domain];
  if (dmarc === 'reject') { score += 4; reasons.push('dmarc_reject +4'); }
  else if (dmarc === 'quarantine') { score += 2; reasons.push('dmarc_quarantine +2'); }
  if (signals.spfByDomain[domain]) { score += 2; reasons.push('spf_present +2'); }

  // ── Name pattern match (local-part looks like the person's name) ───
  var nameMatch = _localPartNameMatch(localPart, lead.firstName, lead.lastName);
  if (nameMatch === 'exact') { score += 10; reasons.push('name_exact_match +10'); }
  else if (nameMatch === 'partial') { score += 5; reasons.push('name_partial_match +5'); }
  else if (nameMatch === 'no_match') { score -= 8; reasons.push('name_no_match -8'); }

  // ── Dominant pattern at domain ─────────────────────────────────────
  var dominantPattern = signals.dominantPatternByDomain[domain];
  if (dominantPattern && lead.firstName) {
    var matchesDominant = _localPartMatchesPattern(localPart, lead.firstName, lead.lastName, dominantPattern);
    if (matchesDominant) {
      score += 8; reasons.push('matches_dominant_pattern_' + dominantPattern.replace(/[{}]/g, '') + ' +8');
    }
  }

  // ── Org-domain consistency (catches stale-Apollo ex-employer case) ─
  if (lead.organization && signals.orgDomain) {
    if (_baseDomain(domain) !== _baseDomain(signals.orgDomain)) {
      var relation = _domainRelation(domain, signals.orgDomain);
      if (relation === 'related_alias_or_subsidiary') {
        score -= 3; reasons.push('subsidiary_or_alias_domain -3');
      } else {
        score -= 20; reasons.push('email_at_ex_employer_or_unrelated -20');
      }
    } else {
      score += 3; reasons.push('domain_matches_org +3');
    }
  }

  // ── Bounce history penalty ─────────────────────────────────────────
  // G4 (ENRICHMENT_BOUNCE_V2): per-ADDRESS permanent suppression + domain SOFT
  // penalty only (no domain-level nuke). Research §5: industry standard is
  // permanent per-address suppression; permanent domain-level reject on >=3
  // bounces is over-aggressive (one bad mailbox suppresses every future lead
  // at the domain, no decay). INERT until G9 populates the bounce store.
  // Flag OFF → legacy domain-level nuke.
  var bouncePen = signals.bounceHistoryByDomain[domain] || 0;
  if (bouncePen > 0) {
    var bp = Math.min(30, Math.round(bouncePen * 200));
    score -= bp; reasons.push('bounce_history -' + bp);
  }
  // G3 (2026-06-22): UNCONDITIONAL per-ADDRESS hard-bounce suppression — never
  // re-draft an exact address that previously hard-bounced (reputation). Additive
  // and independent of the domain-level ENRICHMENT_BOUNCE_V2 flag, so the
  // conservative domain nuke (flag OFF) still stands alongside it.
  if (signals.hardBounceByAddress && (signals.hardBounceByAddress[candidate.email] || 0) >= 1) {
    hardRejected = true; reasons.push('address_suppressed_hard_bounced');
  }
  if (_enrichmentFlag('ENRICHMENT_BOUNCE_V2')) {
    // Per-address: only the exact mailbox that hard-bounced is suppressed.
    if (signals.hardBounceByAddress && (signals.hardBounceByAddress[candidate.email] || 0) >= 1) {
      hardRejected = true; reasons.push('address_suppressed_hard_bounced');
    }
    // No domain-wide hard reject — the soft bounce_history penalty above stands.
  } else {
    if ((signals.hardBounceByDomain[domain] || 0) >= 3) {
      hardRejected = true; reasons.push('domain_suppressed_3plus_hard_bounces');
    }
  }

  return { score: score, reasons: reasons, hardRejected: hardRejected };
}

// ─── HELPERS ──────────────────────────────────────────────────────────────

function _selectorNoResult(reason, extra) {
  var out = {
    status: 'NEEDS_EMAIL',
    email: '',
    confidence: 0,
    score: 0,
    reasons: [reason],
    source: 'unified_selector_no_result',
    domain: '',
    classification: 'INVALID',
    reoonStatus: 'not_attempted',
    candidates: [],
    runnerUps: [],
    originalEmail: '',
    selectorElapsedMs: 0
  };
  if (extra) out.detail = extra;
  return out;
}

function _localPartNameMatch(localPart, firstName, lastName) {
  if (!firstName) return 'unknown';
  var lp = (localPart || '').toLowerCase().replace(/\d+$/, '');
  var f = (firstName || '').toLowerCase().replace(/[^a-z]/g, '');
  var l = (lastName || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!f) return 'unknown';

  if (l) {
    // Exact patterns
    var exactPatterns = [
      f + '.' + l, f + '_' + l, f + '-' + l, f + l,
      f.charAt(0) + l, f.charAt(0) + '.' + l,
      l + '.' + f, l + f,
      f + '.' + l.charAt(0), f + l.charAt(0)
    ];
    if (exactPatterns.indexOf(lp) >= 0) return 'exact';
    // Substring presence (both names appear)
    if (l.length >= 3 && lp.indexOf(l) >= 0 && f.length >= 3 && lp.indexOf(f) >= 0) return 'exact';
    // Last name alone or first name alone present
    if (l.length >= 3 && lp.indexOf(l) >= 0) return 'partial';
    if (f.length >= 3 && lp.indexOf(f) >= 0) return 'partial';
  } else {
    if (f.length >= 3 && lp.indexOf(f) >= 0) return 'exact';
  }
  return 'no_match';
}

function _localPartMatchesPattern(localPart, firstName, lastName, pattern) {
  if (!pattern || !firstName) return false;
  var f = (firstName || '').toLowerCase().replace(/[^a-z]/g, '');
  var l = (lastName || '').toLowerCase().replace(/[^a-z]/g, '');
  var expected = pattern.replace('{first}', f).replace('{last}', l)
                        .replace('{f}', f.charAt(0) || '').replace('{l}', l.charAt(0) || '');
  return (localPart || '').toLowerCase() === expected;
}

function _baseDomain(d) {
  if (!d) return '';
  var parts = d.split('.');
  if (parts.length <= 2) return d;
  var last2 = parts.slice(-2).join('.');
  var ccTld2 = { 'co.uk': 1, 'co.in': 1, 'com.au': 1, 'com.br': 1, 'co.jp': 1, 'co.kr': 1 };
  if (ccTld2[last2]) return parts.slice(-3).join('.');
  return last2;
}

function _domainRelation(d1, d2) {
  if (!d1 || !d2) return 'unknown';
  if (d1 === d2) return 'identical';
  var e = (d1.split('.')[0] || '');
  var x = (d2.split('.')[0] || '');
  if (e.length < 4 || x.length < 4) return 'unrelated';
  if (e.indexOf(x) === 0 || x.indexOf(e) === 0) return 'related_alias_or_subsidiary';
  var prefixLen = 6;
  if (e.length >= prefixLen && x.length >= prefixLen &&
      e.substring(0, prefixLen) === x.substring(0, prefixLen)) {
    return 'related_alias_or_subsidiary';
  }
  return 'unrelated';
}

// Hunter Email Finder fallback shim — returns email string or null.
//
// RENAMED at 2026-06-12-cacheservice-migration: this used to be declared as
// _hunterEmailFinder(firstName, lastName, domain), which SHADOWED the real
// _hunterEmailFinder(domain, firstName, lastName) in EmailEnricher.gs (this
// file loads later, and in Apps Script the last same-named global wins).
// Since fetchHunterEmailFinder was never defined, the shim always returned
// null — silently disabling the real Hunter finder (and its HUNTER_FIND_
// cache) for every caller in the project. The rename restores the real
// function for EmailEnricher.gs / WebApp.gs callers; this selector-local
// fallback keeps its original always-null-unless-defined semantics.
function _selectorHunterFinderFallback(firstName, lastName, domain) {
  // If the project has a fetchHunterEmailFinder function, use it. Else null.
  if (typeof fetchHunterEmailFinder === 'function') {
    try {
      var r = fetchHunterEmailFinder(firstName, lastName, domain);
      return (r && r.email) ? r.email : null;
    } catch (_) {}
  }
  return null;
}
