/**
 * ============================================================
 * PreSendVerifier.gs — Recipient-side deliverability gate
 * (Patch 2026-05-12, no-Findymail design)
 *
 * Run BEFORE GmailApp.createDraft. Catches ~5-10% of auto-picked
 * pattern emails that would hard-bounce, using ONLY signals already
 * available (Reoon + Hunter Verifier + Apollo email_status + DNS).
 *
 * Composite scoring → 0-100. Below 50 routes to NEEDS_PRE_SEND_REVIEW.
 *
 * Entry: preSendVerify(email, lead)
 * Returns: { ok, confidence, reasons[], blockers[], retryAfterMs }
 * ============================================================
 */

var PSV_THRESHOLD = 50;
var PSV_HUNTER_BUDGET_KEY_PREFIX = 'PSV_HUNTER_USED_';

// PATCH 2026-05-18: bound the REOON_RETRY_PENDING loop so persistently-UNKNOWN
// Reoon results (typical for large corporate domains like flipkart.com,
// where SMTP banners are intentionally ambiguous) don't recycle indefinitely.
// After this many retries, the lead escalates to NEEDS_PRE_SEND_REVIEW so a
// human picks send-anyway vs hold. Was: unbounded loop burning quota.
var PSV_MAX_REOON_RETRIES = 3;

// PATCH 2026-05-18: when Reoon is the ONLY weak signal but the rest of the
// envelope is strong (well-known corporate domain with MX + DMARC + SPF +
// age > 180d + zero bounce history), allow PASS at threshold confidence.
// Rationale: corporate domains where Reoon=unknown almost always reject at
// SMTP time if the address is bad (soft-bounce → bouncedDomains tracks).
// The alternative (current behavior) is the lead never sending at all —
// strictly worse than a slightly-elevated bounce risk.
var PSV_CORP_SOFTPASS_MIN_AGE_DAYS = 180;

function preSendVerify(email, lead) {
  email = (email || '').toString().trim().toLowerCase();
  lead = lead || {};

  var score = 0;
  var reasons = [];
  var blockers = [];
  var onlyReoonUnknown = false;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, confidence: 0, reasons: ['BAD_FORMAT'],
             blockers: ['BAD_FORMAT: ' + email], retryAfterMs: null };
  }
  var domain = email.split('@')[1];

  // ── Signal 1: MX (hard block if absent) ──
  var mx;
  try { mx = verifyMxRecord(domain); } catch (e) { mx = { hasMx: false }; }
  if (!mx || !mx.hasMx) {
    return { ok: false, confidence: 0, reasons: reasons,
             blockers: ['NO_MX: ' + domain], retryAfterMs: null };
  }
  score += 20;
  reasons.push('MX_OK +20');

  // ── Signal 2: Reoon Power Mode ──
  var rv;
  try { rv = verifyEmailDeliverable(email); } catch (e) { rv = { status: 'skipped' }; }
  var REOON_HARD = { invalid: 1, disabled: 1, spamtrap: 1, disposable: 1 };
  if (REOON_HARD[rv.status]) {
    return { ok: false, confidence: 0, reasons: reasons,
             blockers: ['REOON_' + rv.status.toUpperCase()], retryAfterMs: null };
  }
  var reoonMap = { safe: 40, role_account: 30, catch_all: 20, unknown: 10, skipped: 0 };
  var rp = reoonMap[rv.status] || 0;
  if (rv.status === 'skipped' || rv.status === 'error') {
    rp = 0;
  }
  score += rp;
  reasons.push('REOON_' + (rv.status || 'none').toUpperCase() + ' +' + rp);
  onlyReoonUnknown = (rv.status === 'unknown' || rv.status === 'skipped');

  // ── Signal 3: Hunter Verifier (tie-breaker for Reoon=unknown, quota-guarded) ──
  //
  // PATCH 2026-05-18: simplified gate. Previous logic gated on `lead.autoPicked
  // || onlyReoonUnknown || ...` which still required the caller to pass
  // `autoPicked` correctly. Now: ANY time Reoon doesn't give a strong signal,
  // we ALWAYS try Hunter as tie-breaker. Hunter's monthly budget (60 calls
  // for free plan) is plenty for the volume this pipeline does (~5-15
  // leads/day). When budget is exhausted we log it explicitly in `reasons`
  // so the gap is visible (vs the previous silent skip).
  var hunterStatus = null;  // hoisted for blocker check below
  var hunterCalled = false;
  var needsHunterTiebreak = lead.autoPicked || onlyReoonUnknown
    || rv.status === 'catch_all' || rv.status === 'skipped' || rv.status === 'error'
    || (lead.source && (lead.source.indexOf('auto_pick') >= 0
        || lead.source === 'guessed_pattern_unverified'
        || lead.source === 'msd_ranked_review'
        || lead.source === 'multi_signal_disambiguator'));
  if (needsHunterTiebreak) {
    if (_psvHunterBudgetRemains()) {
      var hv = _psvCallHunterVerifier(email);
      if (hv) {
        hunterCalled = true;
        hunterStatus = hv.status;
        _psvIncrementHunterUsage();
        if (hv.status === 'invalid') {
          return { ok: false, confidence: 0, reasons: reasons,
                   blockers: ['HUNTER_INVALID score=' + hv.score], retryAfterMs: null };
        }
        var hp = (hv.status === 'valid' && hv.score >= 70) ? 20
          : (hv.status === 'valid' && hv.score >= 40) ? 10
          : (hv.status === 'accept_all') ? 10 : 0;
        score += hp;
        reasons.push('HUNTER_' + hv.status.toUpperCase() + '_score=' + hv.score + ' +' + hp);
        if (hv.status !== 'unknown') onlyReoonUnknown = false;
      } else {
        // Hunter returned null — either the key isn't set, the API errored,
        // or we got a non-200. Make this visible.
        reasons.push('HUNTER_UNAVAILABLE +0');
      }
    } else {
      // Budget exhausted for the month. Don't pretend we tried — log it.
      reasons.push('HUNTER_BUDGET_EXHAUSTED +0');
    }
  }

  // ── Signal 4: Apollo email_status (from lead, no API call) ──
  var apolloStatus = null;
  var apolloVerified = false;
  if (lead.apolloMatch && lead.apolloMatch.originalStatus) {
    apolloStatus = lead.apolloMatch.originalStatus;
  } else if (lead.reoonStatus && typeof lead.reoonStatus === 'string'
             && lead.reoonStatus.indexOf('apollo_') === 0) {
    apolloStatus = lead.reoonStatus.replace('apollo_', '');
  }
  if (apolloStatus) {
    if (apolloStatus === 'bounced') {
      return { ok: false, confidence: 0, reasons: reasons,
               blockers: ['APOLLO_BOUNCED'], retryAfterMs: null };
    }
    apolloVerified = (apolloStatus === 'verified');
    var apolloMap = { verified: 20, 'likely to engage': 15, likely_to_engage: 15,
                      unverified: 5, extrapolated: 5, unavailable: 0 };
    var ap = apolloMap[apolloStatus] || 0;
    score += ap;
    if (ap > 0) reasons.push('APOLLO_' + apolloStatus.toUpperCase().replace(/ /g, '_') + ' +' + ap);
  }

  // ── Reoon-skipped blocker: if no high-confidence fallback signal, block send ──
  if (rv.status === 'skipped' || rv.status === 'error') {
    if (!(hunterStatus === 'valid' || apolloVerified === true)) {
      blockers.push('reoon_unavailable_and_no_other_high_confidence_signal');
    }
  }

  // ── Signal 5: DMARC ──
  try {
    if (typeof domainDmarcStrictness === 'function') {
      var dp = domainDmarcStrictness(domain);
      var dpts = dp === 'reject' ? 8 : dp === 'quarantine' ? 4 : 0;
      score += dpts;
      if (dpts > 0) reasons.push('DMARC_' + dp.toUpperCase() + ' +' + dpts);
    }
  } catch (_) {}

  // ── Signal 6: SPF ──
  if (_psvCheckSpf(domain)) {
    score += 5;
    reasons.push('SPF_PRESENT +5');
  }

  // ── Signal 7: Domain age via RDAP (penalty if <90d) ──
  try {
    var ageDays = _psvDomainAgeDays(domain);
    if (ageDays !== null && ageDays < 90) {
      score -= 25;
      reasons.push('DOMAIN_AGE_' + ageDays + 'd -25');
    }
  } catch (_) {}

  // ── Signal 8: Pattern consistency (±5) ──
  var pd = _psvPatternCheck(email, lead, domain);
  if (pd !== 0) {
    score += pd;
    reasons.push('PATTERN_' + (pd > 0 ? 'MATCH +5' : 'MISMATCH -5'));
  }

  // ── Signal 9: bouncedDomains history (penalty + hard suppress) ──
  try {
    var bouncePenalty = (typeof _getDomainBouncePenalty === 'function')
      ? _getDomainBouncePenalty(domain) : 0;
    var bpp = Math.min(40, Math.round(bouncePenalty * 200));
    if (bpp > 0) {
      score -= bpp;
      reasons.push('BOUNCE_HISTORY -' + bpp);
      var hbc = _psvGetHardBounceCount(domain);
      if (hbc >= 3) blockers.push('DOMAIN_SUPPRESSED: ' + domain + ' has ' + hbc + ' hard bounces');
    }
  } catch (_) {}

  // ── Signal 10: Org-vs-email-domain mismatch backstop (PATCH 2026-05-18) ──
  //
  // Catch the Harsh-Singh-class defect: lead.organization is "Flipkart" but
  // email points to "@4700bc.com" (ex-employer, stale Apollo data). The
  // EmailEnricher Apollo block has a primary guard for this, but it's gated
  // on resolved-domain confidence ≥ 0.50 — for new/obscure orgs the resolver
  // may not be confident enough to act. This backstop fires here as a
  // last line of defense AFTER the primary guard, with a softer penalty
  // (no hard block) so we don't false-positive on subsidiary-uses-parent-
  // domain edge cases (Instagram employee at @fb.com).
  //
  // The penalty is -15 (intentionally weaker than soft-pass's +15 boost)
  // so a strong-corporate-signal email at an ex-employer can still pass
  // PSV if every other signal is green. The goal is to nudge marginal
  // cases into NEEDS_PRE_SEND_REVIEW, not to block aggressively.
  try {
    if (lead.organization && typeof resolveDomainContextual === 'function') {
      var ctxHints10 = {
        firstName: lead.firstName,
        lastName: lead.lastName,
        linkedinUrl: lead.linkedinUrl || '',
        headline: lead.headline || ''
      };
      var orgRes10 = resolveDomainContextual(lead.organization, ctxHints10);
      if (orgRes10 && orgRes10.domain && (orgRes10.confidence || 0) >= 0.50) {
        var expected10 = orgRes10.domain.toLowerCase().trim();
        function _base10(d) {
          var parts = d.split('.');
          if (parts.length <= 2) return d;
          var last2 = parts.slice(-2).join('.');
          var ccTld2 = { 'co.uk': 1, 'co.in': 1, 'com.au': 1, 'com.br': 1, 'co.jp': 1, 'co.kr': 1 };
          if (ccTld2[last2]) return parts.slice(-3).join('.');
          return last2;
        }
        if (_base10(domain) !== _base10(expected10)) {
          score -= 15;
          reasons.push('PATTERN_ORG_MISMATCH -15 (org=' + lead.organization +
            ' expected=' + expected10 + ' got=' + domain + ')');
        }
      }
    }
  } catch (_) {}

  var finalScore = Math.max(0, Math.min(100, score));
  var ok = blockers.length === 0 && finalScore >= PSV_THRESHOLD;

  // ── PATCH 2026-05-19: Hunter-Valid authority pass ─────────────────────
  //
  // When Hunter Email Verifier explicitly returns `valid` for an address,
  // that's a stronger deliverability signal than any aggregate score we
  // compute. Hunter has actually probed the SMTP server and confirmed the
  // mailbox accepts mail. We should treat this as an authoritative pass
  // independent of the 50-point threshold.
  //
  // Real-world case (2026-05-19 backfill): 6 corporate emails at well-
  // established domains (amazon.com, uber.com, blinkit.com) where Reoon
  // returned `unknown` (these orgs run aggressive anti-bot SMTP banners)
  // and Hunter said `valid` with score 40-69 → total 49, just under
  // threshold → ALL 6 blocked despite Hunter confirming deliverability.
  //
  // Gate: Hunter must be valid AND no hard blockers AND score must be
  // meaningfully above zero (>=30 means at least MX + Reoon-some-signal
  // are present, ruling out garbage rows).
  if (!ok && blockers.length === 0 && hunterStatus === 'valid' && finalScore >= 30) {
    var boost = Math.max(0, PSV_THRESHOLD - finalScore);
    score = PSV_THRESHOLD;
    finalScore = PSV_THRESHOLD;
    ok = true;
    reasons.push('HUNTER_VALID_AUTHORITY_PASS +' + boost +
      ' (Hunter says address is deliverable; trumps aggregate score)');
  }

  // ── PATCH 2026-05-18: Corporate soft-pass ─────────────────────────────
  //
  // The Sourav-Ghosh/Flipkart class: corporate email where Reoon returns
  // unknown but every other deliverability signal is strong. Without this
  // override the lead is permanently stuck because Reoon will keep returning
  // unknown on every retry. The override is gated tightly so it can't help
  // a sketchy free-mail or freshly-registered domain slip through.
  //
  // Gating conjunction (all must hold):
  //   - onlyReoonUnknown (the only deficit is Reoon's verdict)
  //   - no Hunter signal counted against the score (didn't fail outright)
  //   - MX records present (already required to reach this point)
  //   - Domain age >= 180 days
  //   - Zero hard-bounce history at this domain
  //   - At least one of DMARC reject/quarantine OR SPF present
  //   - finalScore is in [35, 49] — close to threshold but not catastrophic
  //
  // Effect: bumps score to PSV_THRESHOLD with an explicit reason marker.
  // Bounce handler will catch any false positives and add to bouncedDomains,
  // which automatically suppresses future sends to that domain via Signal 9.
  if (!ok && blockers.length === 0 && onlyReoonUnknown
      && finalScore >= 35 && finalScore < PSV_THRESHOLD
      && hunterStatus !== 'invalid') {
    var hasDmarcOrSpf = reasons.some(function(r) {
      return r.indexOf('DMARC_REJECT') >= 0 || r.indexOf('DMARC_QUARANTINE') >= 0
          || r.indexOf('SPF_PRESENT') >= 0;
    });
    var hasBounceHistory = reasons.some(function(r) { return r.indexOf('BOUNCE_HISTORY') >= 0; });
    var ageDays = null;
    try { ageDays = _psvDomainAgeDays(domain); } catch (_) {}
    var domainOldEnough = (ageDays === null) || (ageDays >= PSV_CORP_SOFTPASS_MIN_AGE_DAYS);
    if (hasDmarcOrSpf && !hasBounceHistory && domainOldEnough) {
      var softPassBoost = PSV_THRESHOLD - finalScore;
      score = PSV_THRESHOLD;
      finalScore = PSV_THRESHOLD;
      ok = true;
      reasons.push('CORP_SOFTPASS_+'  + softPassBoost
        + '_age=' + (ageDays === null ? 'unknown' : ageDays + 'd'));
    }
  }

  // ── Retry-after with attempt bound ────────────────────────────────────
  //
  // PATCH 2026-05-18: bound REOON_RETRY_PENDING attempts. The caller
  // (GmailDrafter) parses retryCount from existing NOTES and passes it as
  // lead._psvRetryCount. After PSV_MAX_REOON_RETRIES, we DROP retryAfterMs
  // and DROP onlyReoonUnknown from the result — that signals GmailDrafter
  // to escalate to NEEDS_PRE_SEND_REVIEW instead of REOON_RETRY_PENDING.
  // Each retry has its own exponential backoff (1h, 3h, 6h) so flaky
  // domains get more recovery time without choking the batch.
  var retryAfterMs = null;
  var attemptCount = (typeof lead._psvRetryCount === 'number') ? lead._psvRetryCount : 0;
  if (!ok && blockers.length === 0 && onlyReoonUnknown && finalScore < PSV_THRESHOLD) {
    if (attemptCount < PSV_MAX_REOON_RETRIES) {
      // Backoff schedule: attempt 0 → 1h, 1 → 3h, 2 → 6h
      var backoffMs = [3600000, 10800000, 21600000][attemptCount] || 3600000;
      retryAfterMs = backoffMs;
      reasons.push('RETRY_' + (attemptCount + 1) + '_OF_' + PSV_MAX_REOON_RETRIES
        + '_AFTER_' + Math.round(backoffMs / 60000) + 'min');
    } else {
      // Exhausted retries — DON'T set retryAfterMs. GmailDrafter sees
      // (retryAfterMs == null && !ok) → routes to NEEDS_PRE_SEND_REVIEW.
      reasons.push('RETRIES_EXHAUSTED_' + PSV_MAX_REOON_RETRIES + '_escalating_to_manual');
    }
  }

  return { ok: ok, confidence: finalScore, reasons: reasons,
           blockers: blockers, retryAfterMs: retryAfterMs,
           attemptCount: attemptCount };
}

// ─── HELPERS ────────────────────────────────────────────────

function _psvCallHunterVerifier(email) {
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('HUNTER_API_KEY');
  if (!apiKey) return null;

  var cacheKey = 'PSV_HV_' + email.replace(/[^\w@.]/g, '_').substring(0, 200);
  var cachedHv = _vendorCacheGet(cacheKey);
  if (cachedHv && Date.now() - cachedHv.ts < 7 * 24 * 3600 * 1000) return cachedHv.data;

  try {
    var url = 'https://api.hunter.io/v2/email-verifier?email=' +
              encodeURIComponent(email) + '&api_key=' + encodeURIComponent(apiKey);
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    var json = JSON.parse(res.getContentText());
    var data = (json && json.data) || {};
    var result = { status: data.status || 'unknown', score: data.score || 0 };
    _vendorCachePut(cacheKey, { data: result, ts: Date.now() }, 7 * 86400);
    return result;
  } catch (e) {
    Logger.log('[PSV] Hunter verifier error: ' + e.message);
    return null;
  }
}

function _psvCheckSpf(domain) {
  try {
    var url = 'https://dns.google/resolve?name=' + encodeURIComponent(domain) + '&type=TXT';
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return false;
    var json = JSON.parse(res.getContentText());
    var ans = json.Answer || [];
    for (var i = 0; i < ans.length; i++) {
      if (ans[i].data && ans[i].data.indexOf('v=spf1') >= 0) return true;
    }
  } catch (_) {}
  return false;
}

function _psvDomainAgeDays(domain) {
  try {
    var url = 'https://rdap.org/domain/' + encodeURIComponent(domain);
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() !== 200) return null;
    var json = JSON.parse(res.getContentText());
    var events = json.events || [];
    for (var i = 0; i < events.length; i++) {
      if (events[i].eventAction === 'registration' && events[i].eventDate) {
        var regDate = new Date(events[i].eventDate);
        if (!isNaN(regDate)) {
          return Math.floor((Date.now() - regDate.getTime()) / 86400000);
        }
      }
    }
  } catch (_) {}
  return null;
}

function _psvPatternCheck(email, lead, domain) {
  if (!lead.firstName || !lead.lastName) return 0;
  try {
    if (typeof fetchHunterPattern !== 'function') return 0;
    var pattern = fetchHunterPattern(domain);
    if (!pattern) return 0;
    var f = lead.firstName.toLowerCase().replace(/[^a-z]/g, '');
    var l = lead.lastName.toLowerCase().replace(/[^a-z]/g, '');
    var expected = pattern.replace('{first}', f).replace('{last}', l)
                          .replace('{f}', f.charAt(0) || '').replace('{l}', l.charAt(0) || '');
    var localPart = email.split('@')[0];
    return localPart === expected ? 5 : -5;
  } catch (_) { return 0; }
}

function _psvGetHardBounceCount(domain) {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('bouncedDomains');
    if (!raw) return 0;
    var map = JSON.parse(raw);
    var entry = map[domain.toLowerCase()];
    return entry ? (entry.hard || 0) : 0;
  } catch (_) { return 0; }
}

function _psvHunterBudgetRemains() {
  var month = new Date().toISOString().substring(0, 7);
  var used = parseInt(PropertiesService.getScriptProperties()
    .getProperty(PSV_HUNTER_BUDGET_KEY_PREFIX + month) || '0', 10);
  return used < 60;  // free plan: 50 credits/month × 2 (verifier = 0.5 each), reserve some for finder
}

function _psvIncrementHunterUsage() {
  var month = new Date().toISOString().substring(0, 7);
  var key = PSV_HUNTER_BUDGET_KEY_PREFIX + month;
  var props = PropertiesService.getScriptProperties();
  var used = parseInt(props.getProperty(key) || '0', 10);
  props.setProperty(key, (used + 1).toString());
}

/**
 * Standalone diagnostic — call from editor or via clasp run to test the
 * verifier against a real email without creating a draft.
 */
function testPreSendVerifyFor(email, firstName, lastName, organization) {
  var fakeLead = {
    firstName: firstName || '',
    lastName: lastName || '',
    organization: organization || '',
    autoPicked: true,
    source: 'guessed_pattern_unverified'
  };
  return preSendVerify(email, fakeLead);
}
