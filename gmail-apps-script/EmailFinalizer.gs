/**
 * ============================================================
 * EmailFinalizer.gs - Guaranteed email selection (Patch 2026-05-19)
 * ============================================================
 *
 * Single-call entry point: finalizeEmailSelection(lead) -> always returns
 * a usable email address. Never returns empty unless the lead has literally
 * no LinkedIn URL, no name, no org, and no APK email - a case that should
 * not occur in production data.
 *
 * RATIONALE (user mandate 2026-05-19): "I do not want any process termination
 * or human/manual intervention. For confidence score 0.30-0.55 and <0.30 make
 * changes and make it choose the most best and accurate email ID and continue
 * the process end to end on its own."
 *
 * Previously: leads with selector confidence < 0.30 died at NEEDS_EMAIL.
 * Leads with conf 0.30-0.55 progressed but landed at STATUS=NEEDS_REVIEW.
 * Both required human intervention in the sheet.
 *
 * Now: 5-tier guaranteed selection. Every lead exits with an email +
 * confidence + selectionTier + riskFlags. BatchProcessor uses this and
 * proceeds to research/compose/draft unconditionally. Drafts of risky-tier
 * picks carry an internal-only HTML header warning the user when they
 * open the draft in Gmail.
 *
 * ─── TIER LADDER ──────────────────────────────────────────────────────
 *
 *   Tier 0  VERIFIED         selector conf >= 0.55              Ship as-is, no risk annotation
 *   Tier 1  LOW_CONFIDENCE   selector conf 0.30-0.55             Ship, [INTERNAL VERIFY] body header
 *   Tier 2  BEST_OF_AVAIL    selector returned candidates, conf<0.30
 *                            Heuristic pick: APK > Apollo > top pattern
 *                            Synthesize confidence 0.30 floor
 *                            [INTERNAL VERIFY] body header
 *   Tier 3  CONSTRUCTED      Selector returned nothing usable
 *                            Construct from primitives: domain+name+pattern
 *                            Try multiple domain resolution paths in series
 *                            Synthesize confidence 0.20
 *                            [INTERNAL VERIFY-CAREFULLY] body header
 *   Tier 4  LAST_RESORT      No domain resolvable, no candidates
 *                            Synthesize placeholder so pipeline still progresses
 *                            Synthesize confidence 0.05
 *                            [INTERNAL NEEDS-RECIPIENT] body header + bright red
 *                            (Should be extremely rare in practice)
 *
 * The tier label propagates onto the lead object (lead.selectionTier) so
 * downstream renderers can inject the appropriate body header.
 */

// Synthetic confidence floors per tier - downstream gates need these
// numeric values, not categorical labels.
var _FINALIZER_TIER_CONFIDENCE = {
  verified:          0.85,  // floor when selector lands here; actual is selector's value
  low_confidence:    0.40,
  best_of_available: 0.30,
  constructed:       0.20,
  last_resort:       0.05
};

// Risk flags per tier - propagate to draft renderer for body-header injection.
var _FINALIZER_TIER_RISK = {
  verified:          [],
  low_confidence:    ['low_confidence', 'verify_recipient_before_send'],
  best_of_available: ['low_signal', 'verify_recipient_before_send', 'pick_from_weak_candidates'],
  constructed:       ['constructed_pattern', 'verify_recipient_before_send', 'high_bounce_risk', 'pattern_guess_at_resolved_domain'],
  last_resort:       ['placeholder_recipient', 'send_will_fail', 'manual_recipient_required']
};

// ─── MAILTESTER PROBE HELPERS (2026-06-12-mailtester-probe) ─────────────────
//
// Domain-locked deliverability probe path. A mail-tester.com address is an
// unverifiable robot address that the unified selector and Reoon will reject.
// The bypass below lets it flow to compose untouched so a spam-score check
// can be run against the live pipeline output. This path is DOMAIN-LOCKED:
// _isMailTesterProbe returns true only for @mail-tester.com or @srv<N>.mail-tester.com.
// It can never affect real leads.

/**
 * Pure predicate: returns true only for @mail-tester.com or @srv<N>.mail-tester.com.
 * Anchored at both start-of-domain and end-of-string to resist subdomain spoofing
 * (e.g. mail-tester.com.evil.com must return false).
 *
 * @param {string} addr
 * @returns {boolean}
 */
function _isMailTesterProbe(addr) {
  return /@(?:srv\d+\.)?mail-tester\.com$/i.test(String(addr || ''));
}

// ─── ORG-DOMAIN SELECTION GATE (2026-06-12-org-domain-gate) ─────────────────
//
// Hard selection gate: when the sheet ORGANIZATION is non-empty AND the
// winning candidate domain is corporate (not freemail) AND org↔domain share
// ZERO alpha-token overlap, the candidate is REJECTED and the pipeline falls
// through to the next candidate or NEEDS_EMAIL_REVIEW.
//
// This closes the "wrong-person enrichment" failure mode where a name-based
// vendor lookup (Apollo, Hunter) returned a DIFFERENT person at a different
// company, the selector accepted that candidate based on vendor 'verified'
// status, and the resolvedDomain stash then anchored research to the SELECTED
// email's domain — faithfully amplifying the wrong selection into a coherent
// wrong-company draft.
//
// Token overlap algorithm (2026-06-13-orggate-substr): extended from exact-token
// equality to substring containment. An org token (len>=4) is considered to
// overlap the domain core if:
//   (a) the org token is a SUBSTRING of any domain token (e.g. "mesa" ⊂ "mesaschool")
//   (b) any domain token is a SUBSTRING of the org token (e.g. "uber" ⊂ "uber")
//   (c) any domain token is a SUBSTRING of the concatenated org tokens
// This fixes the "Mesa School of Business" + mesaschool.co false-reject while
// keeping the Uber / offerx.co.uk true-reject (uber not ⊂ offerx; offerx not ⊂ uber).
//
// The shared pure helper _orgTokenOverlapSubstr implements this; call it from
// _orgDomainGateRejects, _domainHasOrgOverlap, and _snovBoostCorroboratesOrg
// so all three seams stay in sync with a single implementation.
//
// Exemptions:
//   - org empty → pass (gate cannot function without org context)
//   - freemail domain → pass (founders use gmail, freemail check is NOT the
//     right mechanism; the downstream classification handles this)
//   - mail-tester.com → pass (covered separately by _isMailTesterProbe)
//   - placeholder.invalid → pass (last-resort placeholder; never a real email)
//
// References:
//   FREE_EMAIL_DOMAINS (EmailEnricher.gs) — reused for freemail check
//
// @param {string} org - lead.organization (sheet value, may be empty)
// @param {string} email - candidate email address
// @param {*} vendorMeta - reserved for future LinkedIn-URL identity
//                         corroboration (unused for now, must remain param for
//                         API stability)
// @returns {boolean} true = REJECT the candidate, false = pass

// ─── SHARED PURE HELPER: substring-aware org↔domain overlap (2026-06-13-orggate-substr) ──
//
// Returns true when there IS meaningful overlap between the org name tokens and the
// domain token list — i.e. the candidate domain plausibly belongs to the org.
// Returns false when zero overlap is confirmed → caller should REJECT.
//
// Overlap conditions (ANY one is sufficient):
//   1. Exact token match: any org token equals any domain token (e.g. razorpay↔razorpay)
//   2. Org token is a substring of a domain token, len(orgToken)>=4:
//      "mesa" ⊂ "mesaschool", "school" ⊂ "mesaschool" → PASS
//   3. Domain token is a substring of an org token, len(orgToken)>=4:
//      "publicis" ⊂ "publicismedia" → not relevant in that direction, but catches cases
//      where domain is shorter.  Actually: domain token "publicismedia" is NOT a substring
//      of org token "publicis". Covered by rule 2 instead.
//   4. Any domain token (len>=4) is a substring of the CONCATENATED org tokens string.
//      This catches e.g. publicismedia ⊂ "publicismedia" (concat of "publicis"+"media").
//
// Guard against false positives: only org tokens of length >= 4 participate in
// substring matching — short tokens ("co", "of", "the") cannot anchor a match.
//
// This function is PURE (no Logger, no PropertiesService) so it can be unit-tested
// and called from both EmailFinalizer.gs and EnrichmentSources.gs without side effects.
// It is defined here (EmailFinalizer.gs) because that is the first file in alphabetical
// load order that needs it; EnrichmentSources.gs references it by global name.
//
// @param {Array<string>} orgTokens - alpha tokens from org name, already filtered len>=4, lowercased
// @param {Array<string>} domainTokens - alpha parts of domain, already filtered len>=4, lowercased
// @returns {boolean} true = overlap found (PASS); false = zero overlap (REJECT)
function _orgTokenOverlapSubstr(orgTokens, domainTokens) {
  if (!orgTokens || orgTokens.length === 0) return true;   // no org context — pass
  if (!domainTokens || domainTokens.length === 0) return true;  // undecidable — pass

  // Precompute the concatenated org tokens string for rule 4 matching
  var orgConcat = orgTokens.join('');

  for (var oi = 0; oi < orgTokens.length; oi++) {
    var ot = orgTokens[oi];  // length >= 4 already guaranteed by caller filter
    for (var di = 0; di < domainTokens.length; di++) {
      var dt = domainTokens[di];
      // Rule 1: exact match
      if (ot === dt) return true;
      // Rule 2: org token is substring of domain token (mesa ⊂ mesaschool)
      if (dt.indexOf(ot) >= 0) return true;
      // Rule 3: domain token is substring of org token (org token wraps the domain)
      if (ot.indexOf(dt) >= 0) return true;
    }
  }
  // Rule 4: any domain token (len>=4) is substring of concatenated org tokens
  // (catches publicismedia ⊂ "publicismedia"; mesaschool ⊂ "mesaschoolbusiness")
  for (var di2 = 0; di2 < domainTokens.length; di2++) {
    if (orgConcat.indexOf(domainTokens[di2]) >= 0) return true;
  }

  return false;  // zero overlap confirmed
}

function _orgDomainGateRejects(org, email, vendorMeta) {
  // Exemption 1: no org context — gate cannot decide
  var orgStr = String(org || '').trim();
  if (!orgStr) return false;

  // Exemption 2: malformed email — gate cannot parse domain
  var emailStr = String(email || '').trim().toLowerCase();
  var atIdx = emailStr.indexOf('@');
  if (atIdx < 1) return false;
  var domain = emailStr.slice(atIdx + 1);
  if (!domain || domain.indexOf('.') < 0) return false;

  // Exemption 3: last-resort placeholder domain
  if (domain === 'placeholder.invalid' || domain.indexOf('placeholder.invalid') >= 0) return false;

  // Exemption 4: mail-tester probe domain (handled separately by _isMailTesterProbe)
  if (_isMailTesterProbe(emailStr)) return false;

  // Exemption 5: freemail domain — pass through; not the gate's concern
  if (typeof FREE_EMAIL_DOMAINS !== 'undefined' && FREE_EMAIL_DOMAINS[domain]) return false;

  // Token extraction: split org name and domain on non-alpha chars; keep tokens >= 4 chars.
  var orgTokens = orgStr.toLowerCase().split(/[^a-z]+/).filter(function(t) { return t.length >= 4; });
  if (orgTokens.length === 0) return false;  // org tokenizes to nothing >= 4 chars — pass

  // Extract domain token list (all parts >= 4 chars — covers co.uk, com.au multi-TLDs)
  var domainParts = domain.split('.');
  var domainTokens = domainParts.filter(function(t) { return t.length >= 4; });

  // If the domain has no tokens >= 4 chars (e.g., "x.io"), cannot conclude mismatch — pass
  if (domainTokens.length === 0) return false;

  // Substring-containment overlap check (2026-06-13-orggate-substr):
  // shared pure helper so all three gate seams stay in sync.
  var hasOverlap = _orgTokenOverlapSubstr(orgTokens, domainTokens);

  if (hasOverlap) return false;  // org matches domain — pass

  // Zero overlap AND domain is corporate AND org is non-empty → REJECT
  Logger.log('[ORG_DOMAIN_GATE] rejected ' + emailStr + ' for org "' + orgStr + '"' +
             ' (org tokens: [' + orgTokens.join(',') + '] — domain tokens: [' + domainTokens.join(',') + '] — zero overlap)');
  return true;
}

// ─── PUBLIC ENTRY POINT ────────────────────────────────────────────────────

/**
 * Guaranteed email selection. Always returns a usable email + tier metadata.
 * Mutates `lead.email`, `lead.emailConfidence`, `lead.selectionTier`,
 * `lead.riskFlags` in place. Caller may also use the returned object directly.
 *
 * @param {Object} lead - LeadProfile (mutated)
 * @param {Object} [enrichment] - Optional pre-computed enrichEmail() result.
 *                                If absent, the function will call enrichEmail
 *                                / selectBestEmail itself.
 * @returns {Object} { email, confidence, tier, riskFlags[], source, reasoning,
 *                     domain, candidates[], runnerUps[], synthetic: bool }
 */
function finalizeEmailSelection(lead, enrichment) {
  if (!lead) {
    return _finalizerEmptyResult('no_lead_object', 'last_resort');
  }

  // MAILTESTER PROBE BYPASS (2026-06-12-mailtester-probe):
  // A mail-tester.com address is a robot deliverability probe address that the
  // unified selector and Reoon reject as unverifiable. Rather than letting it die
  // at NEEDS_EMAIL, we short-circuit the entire selection ladder and return a
  // finalized verified-equivalent result so the row flows straight to compose.
  // DOMAIN-LOCKED: _isMailTesterProbe only matches @mail-tester.com /
  // @srv<N>.mail-tester.com — cannot affect real leads. See _isMailTesterProbe.
  var _probeAddr = String(lead.email || lead.enrichedEmail || '');
  if (_isMailTesterProbe(_probeAddr)) {
    Logger.log('[EmailFinalizer] MAILTESTER_PROBE bypass for row ' + (lead.rowNum || '?') +
               ' addr=' + _probeAddr + ' — short-circuiting to verified-equivalent tier');
    return _finalize(lead, {
      email:      _probeAddr,
      confidence: 0.99,
      tier:       'verified',
      source:     'mailtester_probe',
      domain:     _probeAddr.split('@')[1] || '',
      candidates: [_probeAddr],
      runnerUps:  [],
      reoonStatus: 'mailtester_probe_bypass',
      reasoning:  'mailtester_probe_domain_locked_bypass',
      synthetic:  false
    });
  }

  // ── SHEET-EMAIL PRECEDENCE (2026-06-12-sheet-truth, S1) ──────────────────
  //
  // When the sheet EMAIL (col F, lead.email) is non-empty, syntactically valid,
  // NOT freemail, NOT placeholder/.invalid, and PASSES the org-domain gate against
  // the sheet org → it becomes the AUTHORITATIVE winner with source='sheet_captured',
  // confidence >= 0.90, selected BEFORE any vendor identity lookups.
  //
  // Rationale: the gsheet is the SOURCE OF TRUTH. APK-captured emails (col F)
  // are typed/extracted directly from the lead's LinkedIn profile — they are
  // MORE authoritative than a vendor guess. The previous flow treated them
  // as just another low-weight candidate (apk_provided weight=4), so a spurious
  // Apollo/Snov name-collision could beat them. This block promotes sheet truth
  // to the entrance of selection, not a late filter.
  //
  // Vendors may still VERIFY deliverability (Reoon on this address only).
  // Reoon safe/catch_all/unknown → use address (varying confidence).
  // Reoon hard-undeliverable (invalid/disabled/spamtrap/disposable) →
  //   FALL THROUGH to the vendor waterfall (2026-06-13-sheetmail-fallthrough):
  //   do NOT dead-end to NEEDS_EMAIL_REVIEW — attempt Apollo/Hunter/Snov to find
  //   a deliverable alternative. Only if the vendor waterfall also yields nothing
  //   → THEN NEEDS_EMAIL_REVIEW with a note distinguishing 'sheet email flagged
  //   AND no vendor alternative found'. The alternative must still pass org-domain
  //   gate and Reoon verification (existing tier-ladder guards handle this).
  // Vendors NEVER replace the address if it is clean; only when sheet email is flagged.
  var _sheetEmail = String(lead.email || '').toLowerCase().trim();
  var _sheetEmailIsCandidate = (
    _sheetEmail.length > 0 &&
    _sheetEmail.indexOf('@') > 0 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(_sheetEmail) &&
    // Must not be placeholder
    _sheetEmail.indexOf('placeholder.invalid') < 0 &&
    // Must not be freemail
    (typeof FREE_EMAIL_DOMAINS === 'undefined' || !FREE_EMAIL_DOMAINS[_sheetEmail.split('@')[1]]) &&
    // Must pass org-domain gate (reuse existing helper)
    !_orgDomainGateRejects(lead.organization, _sheetEmail, null)
  );
  // _sheetEmailFlagged: set when the sheet email is present but Reoon flagged it
  // as undeliverable. When true, the S1 block falls through to the vendor waterfall
  // instead of returning NEEDS_EMAIL_REVIEW directly. The note is carried into
  // the vendor waterfall reasoning so the final NEEDS_EMAIL_REVIEW (if vendors
  // also fail) distinguishes "flagged + no vendor alternative" from a plain miss.
  var _sheetEmailFlagged = false;
  var _sheetEmailFlaggedNote = '';
  if (_sheetEmailIsCandidate) {
    var _sheetDomain = _sheetEmail.split('@')[1] || '';
    // Verify deliverability with Reoon (advisory only — never replaces address)
    var _sheetReoonStatus = 'not_verified';
    var _sheetConf = 0.92;
    try {
      if (typeof verifyEmailDeliverable === 'function') {
        var _sheetRV = verifyEmailDeliverable(_sheetEmail);
        if (_sheetRV) {
          _sheetReoonStatus = _sheetRV.status || 'unknown';
          if (_sheetRV.status === 'safe') {
            _sheetConf = 0.97;
          } else if (_sheetRV.status === 'catch_all' || _sheetRV.status === 'role_account') {
            _sheetConf = 0.90;
          } else if (_sheetRV.status === 'unknown') {
            _sheetConf = 0.90;
          } else if (_sheetRV.status === 'invalid' || _sheetRV.status === 'disabled') {
            // ── SHEETMAIL-FALLTHROUGH (2026-06-13-sheetmail-fallthrough) ──────────
            // Sheet email is hard-undeliverable (invalid/disabled). Previously this
            // dead-ended to NEEDS_EMAIL_REVIEW without trying vendors. Now: set flag
            // and fall through to the normal vendor waterfall (selectBestEmail / tier
            // ladder) so Apollo/Hunter/Snov can find a deliverable alternative.
            // The col-F email is cleared from lead.email so selectBestEmail treats
            // it as a no-apk-provided lead and calls Apollo people-match by LinkedIn URL.
            _sheetEmailFlagged = true;
            _sheetEmailFlaggedNote = '[SHEET_EMAIL_UNDELIVERABLE] Reoon marked ' + _sheetEmail +
              ' as ' + _sheetRV.status + ' — falling through to vendor waterfall for alternative.';
            Logger.log('[EmailFinalizer] SHEETMAIL_FALLTHROUGH row ' + (lead.rowNum || '?') +
                       ': sheet=' + _sheetEmail + ' reoon=' + _sheetRV.status +
                       ' — clearing apk email, falling through to vendor waterfall');
            lead.email = '';  // clear so selectBestEmail uses Apollo/Hunter, not the flagged apk
          }
          // spamtrap/disposable — also fall through to vendor waterfall
          if (!_sheetEmailFlagged &&
              (_sheetRV.status === 'spamtrap' || _sheetRV.status === 'disposable')) {
            _sheetEmailFlagged = true;
            _sheetEmailFlaggedNote = '[SHEET_EMAIL_UNDELIVERABLE] Reoon flagged ' + _sheetEmail +
              ' as ' + _sheetRV.status + ' (spamtrap/disposable) — falling through to vendor waterfall.';
            Logger.log('[EmailFinalizer] SHEETMAIL_FALLTHROUGH row ' + (lead.rowNum || '?') +
                       ': sheet=' + _sheetEmail + ' reoon=' + _sheetRV.status +
                       ' — clearing apk email, falling through to vendor waterfall');
            lead.email = '';  // clear so selectBestEmail uses Apollo/Hunter, not the flagged apk
          }
        }
      }
    } catch (_reoonErr) {
      // Reoon lookup failure is non-fatal — proceed with base confidence
      Logger.log('[EmailFinalizer] Reoon check for sheet email failed: ' + _reoonErr.message);
    }
    if (!_sheetEmailFlagged) {
      // Sheet email is clean — use it directly (sheet_captured path).
      Logger.log('[EmailFinalizer] SHEET_EMAIL_PRECEDENCE row ' + (lead.rowNum || '?') +
                 ' addr=' + _sheetEmail + ' reoon=' + _sheetReoonStatus +
                 ' conf=' + _sheetConf.toFixed(2) + ' — short-circuiting to sheet_captured');
      return _finalize(lead, {
        email:      _sheetEmail,
        confidence: _sheetConf,
        tier:       'verified',
        source:     'sheet_captured',
        domain:     _sheetDomain,
        candidates: [_sheetEmail],
        runnerUps:  [],
        reoonStatus: _sheetReoonStatus,
        reasoning:  'sheet_email_precedence_s1 reoon=' + _sheetReoonStatus +
                    ' org=' + (lead.organization || '') +
                    ' conf=' + _sheetConf.toFixed(2),
        synthetic:  false
      });
    }
    // _sheetEmailFlagged=true → fall through below to vendor waterfall.
    // lead.email was cleared above so selectBestEmail queries Apollo/Hunter by
    // LinkedIn URL, not the flagged apk address. The org-domain gate and Reoon
    // verification in the tier ladder still apply to any alternative found.
    Logger.log('[EmailFinalizer] SHEETMAIL_FALLTHROUGH row ' + (lead.rowNum || '?') +
               ' proceeding to vendor waterfall. note=' + _sheetEmailFlaggedNote);
  }
  // ── END SHEET-EMAIL PRECEDENCE ────────────────────────────────────────────

  // Step 1: get the unified selector's view (if not provided)
  var selectorResult = null;
  if (enrichment && enrichment.email && typeof enrichment.confidence === 'number') {
    // Caller already ran enrichEmail - reuse its result as the selector's view
    selectorResult = {
      email: enrichment.email,
      confidence: enrichment.confidence,
      candidates: enrichment.candidates || [enrichment.email],
      runnerUps: enrichment.runnerUps || [],
      source: enrichment.source || 'enrichment',
      domain: enrichment.domain || (enrichment.email.indexOf('@') >= 0 ? enrichment.email.split('@')[1] : ''),
      reoonStatus: enrichment.reoonStatus
    };
  } else if (typeof selectBestEmail === 'function') {
    try {
      var sel = selectBestEmail(lead);
      if (sel && sel.email) {
        selectorResult = sel;
      } else if (sel && sel.candidates && sel.candidates.length > 0) {
        selectorResult = sel;  // has candidates even if email empty
      }
    } catch (selErr) {
      Logger.log('[EmailFinalizer] selectBestEmail threw: ' + selErr.message);
    }
  }

  // PATCH 2026-05-20 (consensus-first selection): tier promotion when 2+
  // independent source TYPES agree. The selector now boosts confidence
  // when diversity >= 2 — we still tier it explicitly here so the
  // risk-header injector knows when to suppress the warning entirely.
  var selectorDiversity = (selectorResult && typeof selectorResult.diversity === 'number')
                          ? selectorResult.diversity : 0;

  // Tier 0: verified.
  // LEGACY: conf >= 0.55 OR diversity >= 2 — a diversity-2 result ships Tier 0
  // (risk header suppressed) at ANY confidence, compounding the G1 sort bug.
  // G1 (ENRICHMENT_SORT_V2): Tier 0 requires conf >= 0.55 (the diversity floor
  // is now verification-gated in the selector, so a verified diversity-2 still
  // reaches 0.55+, while an UNVERIFIED diversity-2 keeps its raw conf and drops
  // to Tier 1 WITH a risk header instead of silently Tier 0). Flag OFF → legacy.
  var _tier0Qualifies = _enrichmentFlag('ENRICHMENT_SORT_V2')
    ? (selectorResult && selectorResult.email && selectorResult.confidence >= 0.55)
    : (selectorResult && selectorResult.email &&
       (selectorResult.confidence >= 0.55 || selectorDiversity >= 2));
  if (_tier0Qualifies) {
    // ORG_DOMAIN_GATE (2026-06-12-org-domain-gate): reject if org↔domain have zero token overlap
    if (_orgDomainGateRejects(lead.organization, selectorResult.email, null)) {
      logPipelineEvent(lead.rowNum, 'ENRICH',
        '[ORG_DOMAIN_GATE] Tier-0 candidate ' + selectorResult.email +
        ' rejected for org "' + (lead.organization || '') + '" — falling through', 'WARN');
      _tier0Qualifies = false;  // fall through to lower tiers
    } else {
      return _finalize(lead, {
        email: selectorResult.email,
        confidence: selectorResult.confidence,
        tier: 'verified',
        source: selectorResult.source || 'unified_selector',
        domain: selectorResult.domain || '',
        candidates: selectorResult.candidates || [selectorResult.email],
        runnerUps: selectorResult.runnerUps || [],
        reoonStatus: selectorResult.reoonStatus,
        reasoning: 'selector_verified conf=' + selectorResult.confidence.toFixed(2) +
                   ' diversity=' + selectorDiversity +
                   (selectorResult.diversityTypes ? ' types=' + selectorResult.diversityTypes.join('+') : ''),
        synthetic: false,
        diversity: selectorDiversity,
        diversityTypes: selectorResult.diversityTypes || []
      });
    }
  }

  // Tier 1: low_confidence — single-type source with conf 0.30-0.55. No
  // cross-source corroboration but the one signal is strong enough to ship.
  if (selectorResult && selectorResult.email && selectorResult.confidence >= 0.30) {
    // ORG_DOMAIN_GATE (2026-06-12-org-domain-gate): reject if org↔domain have zero token overlap
    if (_orgDomainGateRejects(lead.organization, selectorResult.email, null)) {
      logPipelineEvent(lead.rowNum, 'ENRICH',
        '[ORG_DOMAIN_GATE] Tier-1 candidate ' + selectorResult.email +
        ' rejected for org "' + (lead.organization || '') + '" — falling through', 'WARN');
      // fall through to Tier 2 / 3 / 4
    } else {
      return _finalize(lead, {
        email: selectorResult.email,
        confidence: selectorResult.confidence,
        tier: 'low_confidence',
        source: selectorResult.source || 'unified_selector',
        domain: selectorResult.domain || '',
        candidates: selectorResult.candidates || [selectorResult.email],
        runnerUps: selectorResult.runnerUps || [],
        reoonStatus: selectorResult.reoonStatus,
        reasoning: 'selector_low_conf single-type conf=' + selectorResult.confidence.toFixed(2) +
                   ' diversity=' + selectorDiversity,
        synthetic: false,
        diversity: selectorDiversity,
        diversityTypes: selectorResult.diversityTypes || []
      });
    }
  }

  // Tier 2: best_of_available - selector returned candidates but all sub-0.30
  if (selectorResult && (selectorResult.candidates || []).length > 0) {
    var bestOf = _bestOfAvailable(lead, selectorResult);
    if (bestOf.email) {
      // ORG_DOMAIN_GATE (2026-06-12-org-domain-gate): reject if org↔domain have zero token overlap
      if (_orgDomainGateRejects(lead.organization, bestOf.email, null)) {
        logPipelineEvent(lead.rowNum, 'ENRICH',
          '[ORG_DOMAIN_GATE] Tier-2 candidate ' + bestOf.email +
          ' rejected for org "' + (lead.organization || '') + '" — falling through', 'WARN');
        // fall through to Tier 3 / 4
      } else {
        return _finalize(lead, {
          email: bestOf.email,
          confidence: _FINALIZER_TIER_CONFIDENCE.best_of_available,
          tier: 'best_of_available',
          source: 'finalizer_best_of_available_' + bestOf.method,
          domain: bestOf.email.split('@')[1] || '',
          candidates: selectorResult.candidates || [bestOf.email],
          runnerUps: selectorResult.runnerUps || [],
          reoonStatus: selectorResult.reoonStatus,
          reasoning: 'best_of_available_' + bestOf.method + '_from_' +
                     (selectorResult.candidates || []).length + '_candidates',
          synthetic: true,
          originalConfidence: selectorResult.confidence
        });
      }
    }
  }

  // Tier 3: constructed - synthesize email from primitives
  var constructed = _constructFromPrimitives(lead);
  if (constructed.email) {
    // ORG_DOMAIN_GATE (2026-06-12-org-domain-gate): reject if org↔domain have zero token overlap
    if (_orgDomainGateRejects(lead.organization, constructed.email, null)) {
      logPipelineEvent(lead.rowNum, 'ENRICH',
        '[ORG_DOMAIN_GATE] Tier-3 constructed candidate ' + constructed.email +
        ' rejected for org "' + (lead.organization || '') + '" — all candidates mismatched, setting NEEDS_EMAIL_REVIEW', 'WARN');
      // All candidates exhausted — return NEEDS_EMAIL_REVIEW without calling
      // _finalize (which hardcodes status: 'VERIFIED'). BatchProcessor checks
      // finalized.orgDomainGateBlocked to write NEEDS_EMAIL_REVIEW + notes.
      var _errToken = (typeof _seedOrPreserveErrRetry === 'function')
                      ? _seedOrPreserveErrRetry(lead) : (lead.errRetry || 1);
      // (2026-06-13-sheetmail-fallthrough): carry flagged-sheet note when applicable.
      var _gateSuffix = _sheetEmailFlagged
        ? ' | ' + _sheetEmailFlaggedNote + ' | sheet_email_flagged_vendor_alt_orggate_blocked'
        : '';
      var _gateNotes = '[ORG_DOMAIN_GATE] all candidates mismatched sheet org — human review | errRetry=' + _errToken + _gateSuffix;
      // Mutate lead state so downstream is consistent with NEEDS_EMAIL_REVIEW
      lead.email = '';
      lead.emailConfidence = 0;
      lead.selectionTier = 'needs_email_review';
      lead.riskFlags = _sheetEmailFlagged
        ? ['sheet_email_undeliverable', 'org_domain_gate_blocked', 'sheet_email_flagged_no_vendor_alternative', 'needs_human_review']
        : ['org_domain_gate_blocked', 'needs_human_review'];
      return {
        status:             'NEEDS_EMAIL_REVIEW',
        email:              '',
        confidence:         0,
        tier:               'needs_email_review',
        riskFlags:          lead.riskFlags,
        source:             'org_domain_gate_all_rejected',
        domain:             '',
        candidates:         [],
        runnerUps:          [],
        reoonStatus:        'org_domain_gate_blocked',
        reasoning:          _gateNotes,
        synthetic:          true,
        placeholder:        false,
        orgDomainGateBlocked: true,
        orgDomainGateNotes: _gateNotes,
        sheetEmailUndeliverable: !!_sheetEmailFlagged,
        sheetEmailFlaggedNoVendorAlternative: !!_sheetEmailFlagged
      };
    } else {
      return _finalize(lead, {
        email: constructed.email,
        confidence: _FINALIZER_TIER_CONFIDENCE.constructed,
        tier: 'constructed',
        source: 'finalizer_constructed_' + constructed.method,
        domain: constructed.domain || (constructed.email.split('@')[1] || ''),
        candidates: [constructed.email],
        runnerUps: [],
        reasoning: 'constructed_via_' + constructed.method + '_using_' + (constructed.domainSource || 'unknown_domain_source'),
        synthetic: true,
        domainConfidence: constructed.domainConfidence || 0
      });
    }
  }

  // Tier 4: last_resort
  // (2026-06-12-funnel-truth F1) When the lead has a non-empty org, fabricating a
  // placeholder.invalid address is worse than routing to human review: a placeholder
  // never reaches anyone, wastes a Gmail quota slot, and poisons the lead row with a
  // fake address that lingers. Route to NEEDS_EMAIL_REVIEW so the user can supply the
  // real address. Placeholder remains ONLY when org is also absent (truly no-identity
  // case where even human review can't help).
  var _t4OrgStr = String(lead && lead.organization || '').trim();
  if (_t4OrgStr) {
    // Org is known — vendors were blocked or gate-rejected all candidates; human review.
    var _t4ErrToken = (typeof _seedOrPreserveErrRetry === 'function')
                      ? _seedOrPreserveErrRetry(lead && lead.notes, '', 'errRetry:0/2').trim()
                      : 'errRetry:0/2';
    // (2026-06-13-sheetmail-fallthrough): if the waterfall was triggered by a flagged
    // sheet email, distinguish this in the notes so the user knows the sheet address
    // was tried and vendors couldn't find an alternative either.
    var _t4SheetSuffix = _sheetEmailFlagged
      ? ' | ' + _sheetEmailFlaggedNote + ' | sheet_email_flagged_and_no_vendor_alternative'
      : '';
    var _t4Notes = '[FUNNEL] last_resort_blocked: vendors_blocked or no_domain_resolvable for org="' +
                  _t4OrgStr + '"; routing to NEEDS_EMAIL_REVIEW for human review. ' + _t4ErrToken +
                  _t4SheetSuffix;
    lead.email = '';
    lead.emailConfidence = 0;
    lead.selectionTier = 'needs_email_review';
    lead.riskFlags = _sheetEmailFlagged
      ? ['sheet_email_undeliverable', 'sheet_email_flagged_no_vendor_alternative', 'needs_human_review']
      : ['funnel_last_resort_org_present', 'needs_human_review'];
    return {
      status:             'NEEDS_EMAIL_REVIEW',
      email:              '',
      confidence:         0,
      tier:               'needs_email_review',
      riskFlags:          lead.riskFlags,
      source:             _sheetEmailFlagged ? 'sheet_flagged_no_vendor_alternative' : 'funnel_last_resort_needs_review',
      domain:             '',
      candidates:         [],
      runnerUps:          [],
      reoonStatus:        'funnel_no_domain',
      reasoning:          _t4Notes,
      synthetic:          true,
      placeholder:        false,
      funnelLastResortOrgPresent: true,
      funnelLastResortNotes:      _t4Notes,
      sheetEmailUndeliverable:    !!_sheetEmailFlagged,
      sheetEmailFlaggedNoVendorAlternative: !!_sheetEmailFlagged
    };
  }
  // No org, no identity at all — placeholder is unavoidable so pipeline records the row.
  var placeholder = _lastResortPlaceholder(lead);
  return _finalize(lead, {
    email: placeholder.email,
    confidence: _FINALIZER_TIER_CONFIDENCE.last_resort,
    tier: 'last_resort',
    source: 'finalizer_last_resort_placeholder',
    domain: placeholder.email.split('@')[1] || '',
    candidates: [placeholder.email],
    runnerUps: [],
    reasoning: 'no_domain_resolvable_no_org_placeholder_used',
    synthetic: true,
    placeholder: true
  });
}

// ─── TIER 2 — BEST-OF-AVAILABLE HEURISTIC ──────────────────────────────────

/**
 * When the selector returned candidates but no high-confidence winner, apply
 * a preference order biased toward LOW-BOUNCE-RISK choices.
 *
 * Preference order (most to least trustworthy when verification is weak):
 *   1. APK-provided email (user themselves extracted it from LinkedIn DOM)
 *   2. Apollo /people/match result (URL-keyed, unambiguous person)
 *   3. Hunter Finder result (Hunter's pattern engine has live MX learning)
 *   4. Pattern guess at the most-confident resolved domain
 *
 * Each preference is applied only if the candidate exists in the selector's
 * returned candidate set (no candidate is fabricated here - Tier 3 does that).
 */
function _bestOfAvailable(lead, selectorResult) {
  var candidates = (selectorResult.candidates || []).map(function(c) {
    return typeof c === 'string' ? c.toLowerCase().trim() : '';
  }).filter(function(c) { return c && c.indexOf('@') > 0; });

  if (candidates.length === 0) return { email: '' };

  // Preference 1: APK-provided email
  var apkEmail = (lead.email || '').toString().toLowerCase().trim();
  if (apkEmail && candidates.indexOf(apkEmail) >= 0) {
    return { email: apkEmail, method: 'apk_provided_in_candidate_set' };
  }

  // Preference 2: Apollo /people/match — check if any candidate's domain
  // matches what Apollo returned for this lead
  if (lead.linkedinUrl && typeof resolveLeadApolloMatch === 'function') {
    try {
      var apolloMatch = resolveLeadApolloMatch(lead.linkedinUrl);
      if (apolloMatch && apolloMatch.email) {
        var apolloEmail = apolloMatch.email.toLowerCase().trim();
        if (candidates.indexOf(apolloEmail) >= 0) {
          return { email: apolloEmail, method: 'apollo_match_in_candidate_set' };
        }
      }
    } catch (_) {}
  }

  // Preference 3: top candidate (already sorted by score in selector)
  // This is the safest default - the selector did its work, we just trust
  // the ordering. If candidates are sorted, [0] is the top scorer.
  return { email: candidates[0], method: 'top_scored_candidate' };
}

// ─── TIER 3 — CONSTRUCTION FROM PRIMITIVES ─────────────────────────────────

/**
 * When the selector returned nothing usable, construct an email from
 * (firstName, lastName, organization, linkedinUrl). Resolves domain via
 * multiple fallback paths, then synthesizes a pattern email.
 */
function _constructFromPrimitives(lead) {
  // ── Domain resolution cascade ─────────────────────────────────────────
  var domain = '';
  var domainSource = '';
  var domainConfidence = 0;

  // Path 1: existing organization → contextual resolver (Apollo + heuristics)
  if (lead.organization && typeof resolveDomainContextual === 'function') {
    try {
      var resolved = resolveDomainContextual(lead.organization, {
        firstName: lead.firstName,
        lastName: lead.lastName,
        linkedinUrl: lead.linkedinUrl || '',
        headline: lead.headline || ''
      });
      if (resolved && resolved.domain) {
        domain = resolved.domain.toLowerCase();
        domainSource = 'contextual_resolver';
        domainConfidence = resolved.confidence || 0;
      }
    } catch (_) {}
  }

  // Path 2: Apollo /people/match domain (works even when their email is stale/missing)
  if (!domain && lead.linkedinUrl && typeof resolveLeadApolloMatch === 'function') {
    try {
      var apolloMatch = resolveLeadApolloMatch(lead.linkedinUrl);
      if (apolloMatch) {
        // If Apollo returned an email, use it directly (skipping pattern construction)
        if (apolloMatch.email) {
          return {
            email: apolloMatch.email.toLowerCase(),
            method: 'apollo_people_match_direct',
            domain: apolloMatch.domain || apolloMatch.email.split('@')[1],
            domainSource: 'apollo_people_match',
            domainConfidence: 0.9
          };
        }
        // Otherwise just take the domain for pattern construction
        if (apolloMatch.domain) {
          domain = apolloMatch.domain.toLowerCase();
          domainSource = 'apollo_people_match_domain_only';
          domainConfidence = 0.75;
        }
      }
    } catch (_) {}
  }

  // Path 3: URL fragment hint → Apollo /organizations/search
  if (!domain && lead.linkedinUrl && typeof _extractOrgHintFromLinkedInUrl === 'function') {
    var hint = _extractOrgHintFromLinkedInUrl(lead.linkedinUrl);
    if (hint && typeof resolveDomainApolloOrgs === 'function') {
      try {
        var apolloOrgs = resolveDomainApolloOrgs(hint, {
          linkedinUrl: lead.linkedinUrl,
          headline: lead.headline || ''
        });
        var pickedOrg = null;
        if (apolloOrgs && apolloOrgs.domain) pickedOrg = apolloOrgs;
        else if (Array.isArray(apolloOrgs) && apolloOrgs[0] && apolloOrgs[0].domain) {
          pickedOrg = apolloOrgs[0];
        }
        if (pickedOrg) {
          domain = pickedOrg.domain.toLowerCase();
          domainSource = 'url_hint_apollo_orgs';
          domainConfidence = 0.55;
        }
      } catch (_) {}
    }
  }

  // Path 4: heuristic _organizationToDomain (deterministic best-guess)
  if (!domain && lead.organization && typeof _organizationToDomain === 'function') {
    try {
      var heuristicDomain = _organizationToDomain(lead.organization);
      if (heuristicDomain && heuristicDomain.indexOf('.') > 0) {
        domain = heuristicDomain.toLowerCase();
        domainSource = 'heuristic_org_to_domain';
        domainConfidence = 0.35;
      }
    } catch (_) {}
  }

  // Path 5: URL slug fragment + .com fallback
  if (!domain && lead.linkedinUrl) {
    var slugHint = (typeof _extractOrgHintFromLinkedInUrl === 'function')
      ? _extractOrgHintFromLinkedInUrl(lead.linkedinUrl) : '';
    if (slugHint && slugHint.length >= 3) {
      domain = slugHint.replace(/[^a-z0-9]/gi, '').toLowerCase() + '.com';
      domainSource = 'url_slug_dot_com_fallback';
      domainConfidence = 0.20;
    }
  }

  if (!domain) return { email: '' };

  // ── Pattern construction ──────────────────────────────────────────────
  var fn = (lead.firstName || '').toString().toLowerCase().replace(/[^a-z]/g, '');
  var ln = (lead.lastName || '').toString().toLowerCase().replace(/[^a-z]/g, '');

  // Defensive: if firstName missing, try to extract from URL slug
  if (!fn && lead.linkedinUrl) {
    var m = lead.linkedinUrl.match(/linkedin\.com\/in\/([^\/?#\-]+)/i);
    if (m) fn = m[1].toLowerCase().replace(/[^a-z]/g, '').substring(0, 12);
  }
  if (!fn && lead.fullName) {
    fn = lead.fullName.toString().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
  }

  if (fn && ln) {
    return {
      email: fn + '.' + ln + '@' + domain,
      method: 'pattern_first_last_constructed',
      domain: domain,
      domainSource: domainSource,
      domainConfidence: domainConfidence
    };
  }
  if (fn) {
    return {
      email: fn + '@' + domain,
      method: 'pattern_first_only_constructed',
      domain: domain,
      domainSource: domainSource,
      domainConfidence: domainConfidence
    };
  }
  // Domain only - use institutional address
  return {
    email: 'info@' + domain,
    method: 'institutional_info_at_domain',
    domain: domain,
    domainSource: domainSource,
    domainConfidence: domainConfidence
  };
}

// ─── TIER 4 — LAST-RESORT PLACEHOLDER ──────────────────────────────────────

/**
 * Returns a placeholder email so the pipeline still produces a draft. The
 * draft body will carry a high-visibility warning header instructing the
 * user to set the recipient manually.
 *
 * Uses a deliberately non-routable domain (RFC 6761 reserved `.invalid` TLD)
 * so accidental sends fail clean at SMTP time instead of bouncing into
 * someone's actual inbox. The local-part encodes the rowNum for traceability.
 */
function _lastResortPlaceholder(lead) {
  var rowSuffix = (lead && lead.rowNum) ? ('-row' + lead.rowNum) : '';
  var nameHint = '';
  if (lead && lead.fullName) {
    nameHint = lead.fullName.toString().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '').substring(0, 8);
  }
  var localPart = nameHint ? ('recipient-' + nameHint + rowSuffix) : ('recipient-needs-fix' + rowSuffix);
  return {
    email: localPart + '@placeholder.invalid'
  };
}

// ─── COMMON FINALIZER + STATE MUTATION ─────────────────────────────────────

function _finalize(lead, payload) {
  var tier = payload.tier;
  var riskFlags = (_FINALIZER_TIER_RISK[tier] || []).slice();

  // Mutate lead so downstream stages see the chosen email + tier
  lead.email = payload.email;
  lead.emailConfidence = payload.confidence;
  lead.selectionTier = tier;
  lead.riskFlags = riskFlags;
  if (payload.reoonStatus) lead.reoonStatus = payload.reoonStatus;

  Logger.log('[EmailFinalizer] Row ' + (lead.rowNum || '?') + ' tier=' + tier +
             ' conf=' + payload.confidence.toFixed(2) + ' email=' + payload.email +
             ' source=' + payload.source + ' reasoning=' + payload.reasoning);

  return {
    status: 'VERIFIED',  // always VERIFIED status post-finalize so BatchProcessor proceeds
    email: payload.email,
    confidence: payload.confidence,
    tier: tier,
    riskFlags: riskFlags,
    source: payload.source,
    domain: payload.domain,
    candidates: payload.candidates || [payload.email],
    runnerUps: payload.runnerUps || [],
    reoonStatus: payload.reoonStatus || 'finalizer_synthetic',
    reasoning: payload.reasoning,
    synthetic: !!payload.synthetic,
    placeholder: !!payload.placeholder,
    originalConfidence: payload.originalConfidence || payload.confidence,
    domainConfidence: payload.domainConfidence || 0,
    classification: 'CORPORATE'
  };
}

function _finalizerEmptyResult(reason, tier) {
  return {
    status: 'VERIFIED',
    email: 'recipient-needs-fix@placeholder.invalid',
    confidence: 0.05,
    tier: tier || 'last_resort',
    riskFlags: _FINALIZER_TIER_RISK.last_resort.slice(),
    source: 'finalizer_empty_fallback',
    domain: 'placeholder.invalid',
    candidates: [],
    runnerUps: [],
    reoonStatus: 'finalizer_no_input',
    reasoning: reason,
    synthetic: true,
    placeholder: true
  };
}

// ─── DIAGNOSTIC HELPER ─────────────────────────────────────────────────────

/**
 * Read-only diagnostic. Runs finalizeEmailSelection on a lead and returns
 * the tier + reasoning + every candidate considered. No state mutation.
 *
 * NOTE: this DOES call selectBestEmail internally, which itself makes API
 * calls (Apollo, Hunter, Reoon). Cache-friendly because all those calls
 * are themselves cached - but not zero-cost.
 */
function diagnoseEmailFinalizer(lead) {
  if (!lead) return { error: 'no_lead' };
  // Clone the lead so the diagnostic doesn't mutate the real one
  var leadClone = {};
  Object.keys(lead).forEach(function(k) { leadClone[k] = lead[k]; });
  var result = finalizeEmailSelection(leadClone);
  return {
    rowNum: lead.rowNum,
    fullName: lead.fullName,
    organization: lead.organization,
    linkedinUrl: lead.linkedinUrl,
    originalApkEmail: lead.email,
    finalizerVerdict: {
      email: result.email,
      tier: result.tier,
      confidence: result.confidence,
      source: result.source,
      domain: result.domain,
      riskFlags: result.riskFlags,
      reasoning: result.reasoning,
      synthetic: result.synthetic,
      placeholder: result.placeholder,
      candidates: result.candidates,
      runnerUps: result.runnerUps
    }
  };
}

// ─── RISK HEADER HTML (for injection into draft body) ───────────────────────

/**
 * Returns a Gmail-safe HTML block that warns the user about a risky-tier
 * email pick. Injected at the TOP of the email body so the user sees it
 * when opening the draft in Gmail. User should delete this header before
 * sending. The header explicitly says so.
 *
 * Returns empty string for tier='verified' (no warning needed).
 *
 * @param {string} tier
 * @param {Array<string>} riskFlags
 * @param {Object} lead
 * @returns {string} HTML to prepend to email body, or '' for verified tier
 */
function buildRiskHeaderHtml(tier, riskFlags, lead) {
  // PATCH 2026-05-20 (audit Phase 8): risk header now renders for ALL non-verified
  // tiers. Previously, low_confidence and best_of_available were suppressed under
  // the (correct) assumption that consensus boost had already validated them. But
  // there are two paths where the tier is downgraded BELOW that assumption:
  //   (a) GmailDrafter PSV advisory (no-termination mode) downgrades verified →
  //       low_confidence when PSV disputes the address. Without a body header,
  //       the user opens a clean-looking Gmail draft and never sees the PSV warning.
  //   (b) MasterValidator BLOCK verdict marks `master_validator_block` riskFlag
  //       but the tier may remain verified or low_confidence — the warning
  //       was silent unless the tier happened to be constructed/last_resort.
  // The fix: render an appropriate-severity panel for every non-verified tier.
  // The body header is the only point-of-action surface to the user; sheet NOTES
  // are not visible in Gmail.
  if (!tier || tier === 'verified') {
    // Even for verified tier, if PSV pushed an explicit dispute flag, render a
    // yellow advisory. This catches the GmailDrafter PSV-disputed-verified case
    // when riskFlags carry psv_blocker_* or psv_low_confidence_* markers but
    // the tier downgrade didn't happen for some reason.
    var hasPsvDispute = Array.isArray(riskFlags) && riskFlags.some(function(f) {
      return /^psv_(blocker|low_confidence)_/.test(f) || f === 'master_validator_block';
    });
    if (!hasPsvDispute) return '';
    // Fall through with synthetic tier='low_confidence' so the panel renders.
    tier = 'low_confidence';
  }

  // PATCH -eq8-draftpolish (F1): replaced nested-table layout with a single
  // top-level <div> that is trivially deletable. Compact one-liner: tier color
  // preserved; "INTERNAL NOTE" + "VERIFY RECIPIENT BEFORE SENDING" substrings
  // retained so existing regression tests (finalizer_*_renders_header) still pass.
  var bgColor, borderColor, textColor, tierShort;
  if (tier === 'low_confidence') {
    bgColor = '#fff8e1'; borderColor = '#f9a825'; textColor = '#6f4f00';
    tierShort = 'low confidence — VERIFY RECIPIENT BEFORE SENDING';
  } else if (tier === 'best_of_available') {
    bgColor = '#fff3e0'; borderColor = '#ef6c00'; textColor = '#5c2c00';
    tierShort = 'low-signal — verify carefully';
  } else if (tier === 'constructed') {
    bgColor = '#ffebee'; borderColor = '#c62828'; textColor = '#5a0000';
    tierShort = 'pattern-constructed — verify before sending';
  } else if (tier === 'last_resort') {
    bgColor = '#fce4ec'; borderColor = '#ad1457'; textColor = '#560027';
    tierShort = 'no recipient found — set manually or delete draft';
  } else {
    return '';
  }

  var confPct = (lead && lead.emailConfidence !== undefined)
    ? Math.round(lead.emailConfidence * 100) : '?';
  var tierLabel = tier.replace(/_/g, ' ');

  return '<div style="background:' + bgColor + ';border-left:4px solid ' + borderColor +
         ';color:' + textColor + ';padding:6px 12px;margin:0 0 16px 0;' +
         'font-family:Arial,sans-serif;font-size:12px;line-height:1.4;">' +
         '&#9888; INTERNAL NOTE — verify recipient (' + tierLabel + ', conf ' + confPct + '%) — ' +
         tierShort + ' — delete this line before sending.' +
         '</div>';
}
