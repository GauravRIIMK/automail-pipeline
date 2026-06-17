/**
 * ============================================================
 * EmailEnricher.gs — Stage 0: Email Validation + Enrichment + SMTP Verify
 *
 * Multi-source cascade that classifies the email in column F, verifies MX,
 * runs SMTP-level deliverability via Reoon Email Verifier (Power Mode),
 * and — when the sheet email is missing/free/dead — pattern-guesses
 * corporate addresses, verifies each through Reoon, and auto-picks the
 * deliverable one. Returns a 0.0-1.0 confidence score per result.
 *
 * 2026 cascade order:
 *   1. Sheet email present + corporate? → MX check → Reoon Power Mode
 *      → "safe" gives confidence 0.95 (highest)
 *   2. Sheet email free/invalid → infer org domain (probe .com/.in/.io/.ai/.co)
 *      → for each of top 5 guessed patterns, Reoon-verify until "safe"
 *      → confidence 0.85
 *   3. Catch-all domain or all "unknown" → return top-3 candidates as
 *      NEEDS_EMAIL_REVIEW with confidence 0.5
 *   4. No domain inferable / no MX / no candidates → NEEDS_EMAIL (0.0)
 *
 * Reoon free tier: 600 credits/month (~20/day). 30-day per-email cache
 * keeps actual API usage well under budget. Unknown results don't consume
 * credits. If REOON_API_KEY is unset, falls back to MX-only verification
 * (confidence 0.5 max).
 *
 * Research anchors:
 *   - Reoon Power Mode: https://www.reoon.com/articles/api-documentation-of-reoon-email-verifier/
 *   - Google Public DNS over HTTPS: https://dns.google/resolve (free, CORS-enabled)
 *   - Dropcontact 2026 benchmark: `first.last@` pattern covers ~35% of corporate
 *     emails, 14 patterns cover the long tail.
 *   - Gmail/Yahoo 2026 bulk-sender rules: corporate-domain delivery has materially
 *     higher inbox rate than free-provider sends for cold outreach.
 * ============================================================
 */

// ─── FREE EMAIL PROVIDERS (domain blocklist) ───────────────
// Lower-cased. Any address @ one of these is treated as personal,
// not usable for cold outreach to a company contact.
var FREE_EMAIL_DOMAINS = {
  'gmail.com': true, 'googlemail.com': true,
  'yahoo.com': true, 'yahoo.co.in': true, 'yahoo.co.uk': true, 'ymail.com': true, 'rocketmail.com': true,
  'hotmail.com': true, 'hotmail.co.uk': true, 'hotmail.co.in': true,
  'outlook.com': true, 'outlook.in': true, 'live.com': true, 'msn.com': true,
  'aol.com': true, 'aim.com': true,
  'icloud.com': true, 'me.com': true, 'mac.com': true,
  'protonmail.com': true, 'proton.me': true, 'pm.me': true,
  'mail.com': true, 'email.com': true,
  'zoho.com': true, 'zohomail.com': true,
  'yandex.com': true, 'yandex.ru': true,
  'gmx.com': true, 'gmx.net': true, 'gmx.de': true,
  'tutanota.com': true, 'tutanota.de': true,
  'fastmail.com': true, 'fastmail.fm': true,
  'rediffmail.com': true, 'rediff.com': true,
  'in.com': true, 'indiatimes.com': true,
  'edu.in': true
};

// ─── ORG-NAME → DOMAIN suffix list (stripped before domain guess) ─
//
// 2026-05-11 AUDIT FIX (reviewer finding #9): removed 'ai', 'io', 'app', 'apps'
// from the noise list. These tokens are part of the brand for the very segment
// we target (Indian AI / SaaS startups: "OpenAI" → was getting mangled to
// "open.com"; "Koo.io" → "koo.com"; "Notion.so" — same class of bug).
// Only legal-form / generic-descriptor suffixes belong here.
var ORG_SUFFIX_NOISE = [
  'inc', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'gmbh', 'ag', 'sa',
  'pvt', 'private', 'co', 'company', 'holdings', 'group',
  'technologies', 'technology', 'softwares', 'software',
  'labs', 'systems', 'solutions', 'services', 'industries', 'enterprises',
  'digital', 'global', 'worldwide', 'india'
];

// ─── PUBLIC ENTRY: ENRICH A LEAD'S EMAIL ────────────────────

/**
 * Classifies the email on a lead, verifies MX + SMTP deliverability, and —
 * if the address is missing / free-provider / dead — proposes ranked corporate
 * candidates and Reoon-verifies them in turn until a deliverable one is found.
 *
 * Confidence semantics (0.0-1.0):
 *   0.95  — sheet email + corporate MX + Reoon "safe"
 *   0.85  — guessed pattern + corporate MX + Reoon "safe"
 *   0.70  — sheet/guessed + Reoon "catch_all" or "role_account" (deliverable but risky)
 *   0.55  — sheet email + corporate MX + Reoon unknown / API down
 *   0.50  — guessed pattern + MX only (no Reoon verification)
 *   0.30  — NEEDS_EMAIL_REVIEW (candidates exist but none verified safe)
 *   0.00  — NEEDS_EMAIL (no usable address, no domain to guess from)
 *
 * @param {Object} lead - LeadProfile (needs email, firstName, lastName, organization)
 * @returns {Object} {
 *   status: 'VERIFIED' | 'NEEDS_EMAIL' | 'NEEDS_EMAIL_REVIEW',
 *   email: string,            // the address to use when status=VERIFIED
 *   classification: 'CORPORATE' | 'FREE' | 'INVALID',
 *   confidence: number,       // 0.0-1.0 actual deliverability confidence
 *   reason: string,
 *   reoonStatus: string,      // 'safe' | 'catch_all' | 'role_account' | 'unknown' | 'invalid' | 'skipped'
 *   candidates: Array<string>,// ranked replacements when review needed
 *   originalEmail: string,
 *   source: string,           // 'sheet_corporate' | 'reoon_verified_guess' | 'guessed_pattern_unverified' | 'rejected'
 *   domain: string
 * }
 */
function enrichEmail(lead) {
  if (!lead) {
    return { status: 'NEEDS_EMAIL', reason: 'no_lead_object', confidence: 0, candidates: [] };
  }

  // PATCH 2026-05-12: Normalize the LinkedIn URL first. Apollo /people/match
  // and downstream lookups all reject URLs with utm_*/share-tracking params.
  // The Android LinkedIn "Share via" flow appends these. Strip them here so
  // the entire cascade gets a canonical URL.
  if (lead.linkedinUrl) {
    var rawUrl = lead.linkedinUrl.toString();
    var cleanUrl = _normalizeLinkedInUrl(rawUrl);
    if (cleanUrl !== rawUrl) {
      Logger.log('[EmailEnricher] URL normalized: "' + rawUrl + '" → "' + cleanUrl + '"');
      lead.linkedinUrl = cleanUrl;
    }
  }

  // PATCH 2026-05-12: Recover truncated last names from URL slug.
  // LinkedIn's UI shows "Aditi B" (single-letter surname for privacy)
  // but the URL slug encodes the full surname (e.g. "aditibiswas1").
  // When lastName ≤ 2 chars, extend it via the slug so Hunter/Snov/MSD
  // get a real name. No-op if slug doesn't match the first name.
  if (lead.linkedinUrl && (!lead.lastName || lead.lastName.toString().length <= 2)) {
    var _combined = _emCombineNameWithSlug(lead.firstName, lead.lastName, lead.linkedinUrl);
    if (_combined && _combined.lastName && _combined.lastName.length >= 3) {
      Logger.log('[EmailEnricher] Slug-combine: "' + (lead.firstName || '') + ' ' +
                 (lead.lastName || '') + '" → "' + _combined.firstName + ' ' + _combined.lastName +
                 '" (via ' + lead.linkedinUrl + ')');
      lead.firstName = _combined.firstName;
      lead.lastName  = _combined.lastName;
      lead.fullName  = _combined.firstName + ' ' + _combined.lastName;
    }
  }

  var original = (lead.email || '').toString().trim();
  var primary = classifyEmail(original);

  // ── PATCH 2026-05-19: Unified Email Selector — PRIMARY PATH ──────────────
  //
  // The single decision point for email selection. Gathers candidates from
  // ALL sources (Apollo /people/match, APK email, Hunter Finder, pattern
  // guesses), gathers signals once (Reoon, Hunter Verifier, MX, DMARC, SPF,
  // bounce history, dominant pattern), and scores each candidate with
  // explicit weighted reasons. Picks the highest-scoring survivor.
  //
  // Domain-aware: well-known corporate domains with aggressive anti-bot
  // SMTP defenses (Amazon, PhonePe, Uber, top Indian fintechs) get
  // reduced Reoon-invalid penalty (-5 instead of -15) to handle the
  // false-negative pattern that killed Navneet @ PhonePe earlier today.
  //
  // Multi-source consensus bonus: 2+ sources agreeing = +7, 3+ = +15.
  //
  // If the selector produces confidence >= 0.30, we use its result.
  // Otherwise fall through to the legacy cascade for a second opinion.
  // The cascade has its own last-resort APK fallback so leads with
  // any plausibly-real email STILL produce drafts.
  if (typeof selectBestEmail === 'function') {
    try {
      var selected = selectBestEmail(lead);
      if (selected && selected.confidence >= 0.30 && selected.email) {
        Logger.log('[EmailEnricher] Unified selector decision: ' + selected.email +
                   ' (conf=' + selected.confidence.toFixed(2) + ', score=' + selected.score +
                   ', primarySource=' + (selected.source || '?') + ')');
        return selected;
      } else if (selected && selected.email && selected.confidence > 0) {
        Logger.log('[EmailEnricher] Selector low-conf (' + selected.confidence.toFixed(2) +
                   ' < 0.30), falling through to cascade for second opinion.');
      } else {
        Logger.log('[EmailEnricher] Selector returned no candidate, falling through to cascade.');
      }
    } catch (selErr) {
      Logger.log('[EmailEnricher] Selector threw: ' + selErr.message + ' — falling through.');
    }
  }

  // ── PATCH 2026-05-19: per-lead call-depth guard ─────────────────────────
  //
  // Defense against the "Maximum call stack size exceeded" failure class
  // (Pradeep/Aqil/Sukhada/Matt/Ayushi, 2026-05-18). The exact recursion
  // path is unknown until the new error-handler stack capture surfaces a
  // sample, but in the meantime this guard prevents enrichEmail from being
  // re-entered for the same lead more than 3 times within 60 seconds.
  //
  // Mechanism: a script-property counter `ENRICH_DEPTH_<rowNum>_<minuteEpoch>`.
  // Bumped on entry, checked at 4+, returns NEEDS_EMAIL_REVIEW with explicit
  // reason. Cron retries on the next tick (after 2-min dedupe expiry).
  //
  // The guard only fires for repeat-entry within 1 minute; normal sequential
  // processing (one call per lead per batch) never triggers it.
  try {
    if (lead && lead.rowNum) {
      var depthKey = 'ENRICH_DEPTH_' + lead.rowNum + '_' + Math.floor(Date.now() / 60000);
      var props_ = PropertiesService.getScriptProperties();
      var depth = parseInt(props_.getProperty(depthKey) || '0', 10) + 1;
      props_.setProperty(depthKey, String(depth));
      if (depth > 3) {
        Logger.log('[EmailEnricher] CALL DEPTH GUARD tripped for row ' + lead.rowNum +
                   ' (depth=' + depth + '). Returning NEEDS_EMAIL_REVIEW to break the loop.');
        return {
          status: 'NEEDS_EMAIL_REVIEW',
          email: '',
          candidates: [],
          confidence: 0,
          classification: 'INVALID',
          reoonStatus: 'guard_tripped',
          reason: 'enrich_depth_guard_tripped_depth_' + depth,
          source: 'depth_guard',
          originalEmail: original
        };
      }
    }
  } catch (_) {}

  // ── Path 0.5: APOLLO /people/match (paid plan) — direct LinkedIn-URL lookup.
  //    The killer endpoint. Apollo's paid plan returns the person's verified
  //    work email + employer-of-record directly from their LinkedIn URL,
  //    eliminating same-name disambiguation entirely. When this hits with
  //    email_status="verified", we short-circuit the rest of the cascade
  //    because no other source can produce a higher-quality signal.
  //
  // ── PATCH 2026-05-18 (Apollo stale-email guard) ─────────────────────────
  //
  // Apollo's people-record returns the CURRENT employer correctly (Apollo
  // sources LinkedIn-style employment history) but the EMAIL field is the
  // last verified address Apollo has on file — which can lag months when
  // someone changes jobs. The Harsh-Singh-class defect: lead.organization
  // = "Flipkart" (truth, from APK Vision of the LinkedIn profile) but
  // Apollo returns email = "harshvardhan.singh@4700bc.com" (his ex-employer
  // 4700BC) at confidence 0.95. Apollo's emailStatus="verified" was correct
  // AT THE TIME OF VERIFICATION but the address is now dead/deactivated.
  //
  // Gate: BEFORE returning VERIFIED from Apollo, resolve lead.organization
  // to its expected domain. If Apollo's email-domain disagrees AND we have
  // high confidence in the resolved domain (≥0.50), route to the redirect
  // helper: try pattern-guess at the CURRENT org's domain + Reoon-verify;
  // if that succeeds, return VERIFIED with source=apollo_redirected_pattern_guess;
  // if it fails, return NEEDS_EMAIL_REVIEW exposing both candidates with
  // explicit notes — user picks Apollo's stale email or the pattern-guess
  // at the current org.
  if (lead.linkedinUrl && typeof resolveLeadApolloMatch === 'function') {
    try {
      var apolloMatch = resolveLeadApolloMatch(lead.linkedinUrl);
      if (apolloMatch && apolloMatch.email) {

        // ─── STALE-EMAIL DETECTION (2026-05-18) ──────────────────────────
        var staleCheck = _detectStaleApolloEmail(apolloMatch, lead);
        if (staleCheck.stale) {
          Logger.log('[EmailEnricher] Apollo email DOMAIN MISMATCH detected: '
            + 'apollo_email=' + apolloMatch.email
            + ' apollo_org=' + (apolloMatch.organizationName || '-')
            + ' lead_org=' + (lead.organization || '-')
            + ' expected_domain=' + staleCheck.expectedDomain
            + ' (conf=' + staleCheck.expectedDomainConfidence.toFixed(2)
            + ', sources=' + (staleCheck.expectedDomainSources || []).join('+') + ')');
          var redirect = _attemptApolloEmailRedirect(lead, apolloMatch, staleCheck);
          if (redirect) return redirect;
          // _attemptApolloEmailRedirect ALWAYS returns an enrichment object
          // (either VERIFIED via pattern-guess or NEEDS_EMAIL_REVIEW exposing
          // both candidates). Reaching this point means a code bug.
          Logger.log('[EmailEnricher] _attemptApolloEmailRedirect returned null unexpectedly — falling through to legacy Apollo path');
        }

        // If Apollo says "verified", we trust it and skip our own Reoon roundtrip.
        // For "unverified"/"extrapolated", we re-verify through Reoon to confirm.
        if (apolloMatch.emailStatus === 'verified' || apolloMatch.emailStatus === 'likely to engage') {
          Logger.log('[EmailEnricher] Apollo /people/match VERIFIED: ' + apolloMatch.email +
                     ' for ' + lead.linkedinUrl + ' (conf ' + apolloMatch.confidence.toFixed(2) + ')');
          return {
            status: 'VERIFIED',
            email: apolloMatch.email,
            classification: 'CORPORATE',
            confidence: apolloMatch.confidence,
            domain: apolloMatch.domain,
            reoonStatus: 'apollo_' + apolloMatch.emailStatus,
            reason: 'apollo_people_match_' + apolloMatch.emailStatus,
            source: 'apollo_people_match',
            candidates: [apolloMatch.email],
            originalEmail: original,
            apolloMatch: {
              organizationName: apolloMatch.organizationName,
              title: apolloMatch.title,
              fullName: apolloMatch.fullName
            }
          };
        }
        // Unverified/extrapolated: re-verify via Reoon
        Logger.log('[EmailEnricher] Apollo returned ' + apolloMatch.emailStatus +
                   ' email ' + apolloMatch.email + ' — re-verifying via Reoon');
        var rv = verifyEmailDeliverable(apolloMatch.email);
        if (rv.status === 'safe' || rv.status === 'catch_all' || rv.status === 'role_account') {
          var baseConfApollo = _confidenceFromReoonStatus(rv.status, 'guess');
          var modApollo = (typeof _applyDeliverabilityModifiers === 'function') ?
            _applyDeliverabilityModifiers(Math.max(baseConfApollo, apolloMatch.confidence), {
              domain: apolloMatch.domain,
              mxRecords: (verifyMxRecord(apolloMatch.domain) || {}).records || [],
              localPart: apolloMatch.email.split('@')[0]
            }) : { confidence: Math.max(baseConfApollo, apolloMatch.confidence), modifiers: {} };
          return {
            status: 'VERIFIED',
            email: apolloMatch.email,
            classification: 'CORPORATE',
            confidence: modApollo.confidence,
            domain: apolloMatch.domain,
            reoonStatus: rv.status,
            reason: 'apollo_match_reoon_' + rv.status,
            source: 'apollo_people_match',
            candidates: [apolloMatch.email],
            originalEmail: original,
            apolloMatch: {
              organizationName: apolloMatch.organizationName,
              title: apolloMatch.title,
              fullName: apolloMatch.fullName,
              originalStatus: apolloMatch.emailStatus
            },
            deliverabilityModifiers: modApollo.modifiers
          };
        }
        // Reoon explicitly rejected the Apollo email — fall through
        Logger.log('[EmailEnricher] Reoon rejected Apollo email ' + apolloMatch.email +
                   ' (' + rv.status + ') — falling through to cascade');
      }
    } catch (apErr) {
      Logger.log('[EmailEnricher] Apollo match error: ' + apErr.message + ' — falling through');
    }
  }

  // ── Path 1: sheet has a corporate address — MX gate then Reoon ──
  if (primary.valid && primary.classification === 'CORPORATE') {
    var mx = verifyMxRecord(primary.domain);
    if (mx.hasMx) {
      var rv = verifyEmailDeliverable(primary.email);
      var baseConf1 = _confidenceFromReoonStatus(rv.status, 'sheet');
      var mod1 = (typeof _applyDeliverabilityModifiers === 'function') ?
                 _applyDeliverabilityModifiers(baseConf1, {
                   domain: primary.domain,
                   mxRecords: mx.records,
                   localPart: primary.email.split('@')[0]
                 }) : { confidence: baseConf1, modifiers: {} };
      var conf = mod1.confidence;
      // PATCH 2026-05-19: Reoon rejection is now ADVISORY, not authoritative.
      //
      // Real-world case: Navneet Sharma @ PhonePe. APK provided
      // navneet.sharma@phonepe.com (structurally perfect: first.last @
      // major-fintech-domain). Reoon returned `invalid` — almost certainly
      // a false negative caused by PhonePe's anti-bot SMTP defenses
      // returning "user unknown" to Reoon's probes. The OLD code dropped
      // the email and tried pattern-guessing, which ALSO hit PhonePe's
      // SMTP wall → all_patterns_undeliverable → STATUS=NEEDS_EMAIL.
      // Lead died despite having a structurally-correct email.
      //
      // New behavior: when Reoon disputes, DON'T drop the email. Instead:
      //   - If MX records exist (proves domain is real)
      //   - AND email is structurally valid (already past primary.valid check)
      //   - AND local-part matches a common pattern at this domain
      // → Keep the email at low confidence (0.40), mark explicitly as
      //   "Reoon-disputed" so user sees the risk, and let downstream stages
      //   create a draft they can review.
      //
      // This is correct because:
      //   1. Corporate SMTP servers commonly false-negative deliverability
      //      probes for legitimate addresses
      //   2. The pattern-guess fallback hits the SAME SMTP defenses
      //   3. STATUS=REVIEW with a draft is strictly better than NEEDS_EMAIL
      //      with no actionable artifact
      //   4. User review before send catches genuine bad addresses
      if (rv.status === 'invalid' || rv.status === 'disabled' || rv.status === 'spamtrap' || rv.status === 'disposable') {
        Logger.log('[EmailEnricher] Reoon disputed sheet email ' + primary.email +
                   ' (' + rv.status + '). Checking if structurally salvageable.');

        // Structural sanity: looks like a name-based pattern at this domain?
        var localPart = primary.email.split('@')[0].toLowerCase();
        var firstName = (lead.firstName || '').toLowerCase().replace(/[^a-z]/g, '');
        var lastName = (lead.lastName || '').toLowerCase().replace(/[^a-z]/g, '');
        var matchesNamePattern = (
          // first.last, first_last, first-last, firstlast
          (firstName && lastName && (
            localPart === firstName + '.' + lastName ||
            localPart === firstName + '_' + lastName ||
            localPart === firstName + '-' + lastName ||
            localPart === firstName + lastName ||
            // f.last, flast
            localPart === firstName.charAt(0) + '.' + lastName ||
            localPart === firstName.charAt(0) + lastName ||
            // first.l, firstl
            localPart === firstName + '.' + lastName.charAt(0) ||
            localPart === firstName + lastName.charAt(0)
          )) ||
          // Just first name (very common for execs / small companies)
          (firstName && localPart === firstName) ||
          // Local-part contains both names as substrings
          (firstName.length >= 3 && lastName.length >= 3 &&
           localPart.indexOf(firstName) >= 0 && localPart.indexOf(lastName) >= 0)
        );

        // Also check spamtrap/disposable separately — these are higher-confidence
        // rejections and SHOULD drop the email (spamtraps damage sender reputation).
        var isHardReject = (rv.status === 'spamtrap' || rv.status === 'disposable');

        if (!isHardReject && matchesNamePattern) {
          Logger.log('[EmailEnricher] Keeping Reoon-disputed email — matches name pattern. ' +
                     primary.email + ' → conf 0.40 + REVIEW flag.');
          return {
            status: 'VERIFIED',
            email: primary.email,
            classification: 'CORPORATE',
            confidence: 0.40,  // low — flag for human review before send
            domain: primary.domain,
            reoonStatus: rv.status,
            reason: 'sheet_corporate_reoon_disputed_but_structurally_valid',
            source: 'sheet_corporate_reoon_disputed',
            candidates: [primary.email],
            originalEmail: original,
            note: 'Reoon returned ' + rv.status + ' but email matches name pattern at corporate domain — common false-negative pattern for anti-bot SMTP defenses (Amazon, PhonePe, Uber, etc.). Human review recommended before send.'
          };
        }
        Logger.log('[EmailEnricher] Sheet email Reoon-rejected AND failed structural pattern check — falling through.');
        // fall through — keep pattern-guess path below
      } else {
        return {
          status: 'VERIFIED',
          email: primary.email,
          classification: 'CORPORATE',
          confidence: conf,
          domain: primary.domain,
          reoonStatus: rv.status,
          reason: 'sheet_corporate_' + rv.status,
          source: 'sheet_corporate',
          candidates: [],
          originalEmail: original
        };
      }
    } else {
      Logger.log('[EmailEnricher] Corporate address but no MX: ' + primary.domain + '. Attempting pattern guess.');
    }
  }

  // ── Path 2: infer org domain — MULTI-SOURCE RESOLVER ──
  //
  // 2026-05-11 LUSHA-CLASS UPGRADE: previously this used only the naive
  // `<org>.com` + TLD probe. R1-R6 research identified that the highest-
  // impact win is multi-source domain resolution: Clearbit Autocomplete +
  // DuckDuckGo + GitHub Orgs + Gemini grounded, voting across sources.
  //
  // For "Pronto" (the user's test case), naive gives pronto.com (wrong
  // company); multi-source vote returns pronto.io with high confidence.
  var orgDomain = '';
  var domainConfidence = 0.5;
  var domainSources = [];
  var allDomainCandidates = [];

  // Build context for disambiguation (LinkedIn URL + headline + designation + location)
  var contextHints = {
    firstName: lead.firstName,
    lastName: lead.lastName,
    linkedinUrl: lead.linkedinUrl || '',
    headline: lead.headline || '',
    designation: lead.designation || lead.currentDesignation || '',
    location: lead.location || ''
  };

  try {
    // Prefer the new contextual resolver — disambiguates same-name companies
    // via Apollo /organizations/search + Snov.io B2B presence + multi-source vote.
    var contextRes = (typeof resolveDomainContextual === 'function') ?
                     resolveDomainContextual(lead.organization, contextHints) : null;
    if (contextRes && contextRes.domain) {
      orgDomain = contextRes.domain;
      domainConfidence = contextRes.confidence || 0.75;
      domainSources = contextRes.sources || [];
      allDomainCandidates = contextRes.allCandidates || [];
      Logger.log('[EmailEnricher] Contextual resolver: ' + lead.organization + ' → ' + orgDomain +
                 ' (confidence ' + domainConfidence.toFixed(2) + ', sources=' + domainSources.join('+') +
                 ', alternatives=' + (allDomainCandidates.length - 1) + ')');
    } else if (typeof resolveDomainMultiSource === 'function') {
      // Legacy multi-source as fallback (no Apollo or Snov keys present)
      var multiResult = resolveDomainMultiSource(lead.organization, lead.firstName, lead.lastName);
      if (multiResult && multiResult.domain) {
        var multiMx = verifyMxRecord(multiResult.domain);
        if (multiMx.hasMx) {
          orgDomain = multiResult.domain;
          domainConfidence = multiResult.confidence || 0.75;
          domainSources = multiResult.sources || [];
          Logger.log('[EmailEnricher] Legacy multi-source: ' + lead.organization + ' → ' + orgDomain);
        }
      }
    }
  } catch (msErr) {
    Logger.log('[EmailEnricher] Domain resolver error: ' + msErr.message + ' — falling through');
  }

  // Legacy path 2 — still useful when multi-source missed everything (e.g.,
  // very small company with no web presence). Plus a final Gemini fallback.
  if (!orgDomain) orgDomain = _organizationToDomain(lead.organization);
  if (orgDomain) {
    var orgMx = verifyMxRecord(orgDomain);
    if (!orgMx.hasMx) {
      var probed = _probeDomainTlds(lead.organization);
      if (probed) {
        orgDomain = probed;
        domainSources.push('tld_probe');
        Logger.log('[EmailEnricher] Probe found TLD: ' + orgDomain);
      } else {
        // ── Path 2.5: Gemini email intelligence — last-chance domain resolution.
        //    The naive `<org>.com` + TLD probe missed (company has a non-obvious
        //    domain, e.g. "Pronto" → pronto.io, or "Acme Health" → acmehealth.co).
        //    Ask Gemini for likely corporate domain + email patterns based on
        //    its training knowledge of real companies + naming conventions.
        var gem = _geminiEmailIntelligence(lead.firstName, lead.lastName, lead.organization);
        if (gem && gem.domain) {
          var gemMx = verifyMxRecord(gem.domain);
          if (gemMx.hasMx) {
            orgDomain = gem.domain;
            Logger.log('[EmailEnricher] Gemini resolved domain: ' + orgDomain + ' (MX ok)');
          } else {
            Logger.log('[EmailEnricher] Gemini suggested ' + gem.domain + ' but no MX. Trying TLD probe on Gemini name.');
            var reProbed = _probeDomainTlds(gem.domain.replace(/\.[a-z]+$/i, ''));
            if (reProbed) {
              orgDomain = reProbed;
              Logger.log('[EmailEnricher] Probe rescued Gemini domain → ' + orgDomain);
            }
          }
        }
        if (!orgDomain) {
          return {
            status: 'NEEDS_EMAIL',
            reason: 'no_corporate_domain_resolves_for_' + (lead.organization || 'unknown'),
            confidence: 0,
            candidates: [],
            originalEmail: original,
            classification: primary.classification || 'INVALID'
          };
        }
      }
    }
  } else {
    return {
      status: 'NEEDS_EMAIL',
      reason: 'no_org_to_guess_from',
      confidence: 0,
      candidates: [],
      originalEmail: original,
      classification: primary.classification || 'INVALID'
    };
  }

  // ── Path 3: PATTERN INTELLIGENCE — query free sources for the company's
  //    actual email format BEFORE generating naive permutations. Cuts the
  //    Reoon-verify queue from 5 candidates to 1-2 in most cases.
  //
  //    R4 finding: GitHub commit search + Hunter pattern field together cover
  //    most companies with a public footprint.
  var dominantPattern = null;
  var patternSource = null;
  var patternConfidence = 0;
  try {
    // Hunter is the most authoritative (its DB is curated). Try first.
    if (typeof fetchHunterPattern === 'function') {
      var hp = fetchHunterPattern(orgDomain);
      if (hp) {
        dominantPattern = hp;
        patternSource = 'hunter_domain_search';
        patternConfidence = 0.85;
      }
    }
    // GitHub commit mining if Hunter missed (and for cross-validation when it didn't).
    if (typeof fetchPatternFromGithubCommits === 'function') {
      var ghp = fetchPatternFromGithubCommits(orgDomain);
      if (ghp && ghp.pattern && ghp.confidence >= 0.4) {
        if (!dominantPattern) {
          dominantPattern = ghp.pattern;
          patternSource = 'github_commits';
          patternConfidence = ghp.confidence;
        } else if (ghp.pattern === dominantPattern) {
          // Both sources agree → boost confidence
          patternConfidence = Math.min(0.95, patternConfidence + 0.05);
          patternSource = 'hunter+github';
        }
      }
    }
    if (dominantPattern) {
      Logger.log('[EmailEnricher] Pattern intel for ' + orgDomain + ': ' + dominantPattern +
                 ' (source=' + patternSource + ', conf=' + patternConfidence.toFixed(2) + ')');
    }
  } catch (patErr) {
    Logger.log('[EmailEnricher] Pattern intel error: ' + patErr.message);
  }

  var candidates = guessProfessionalEmail(lead.firstName, lead.lastName, orgDomain);

  // If we have a high-confidence pattern, build that candidate first
  if (dominantPattern && lead.firstName && lead.lastName) {
    var first = lead.firstName.toLowerCase();
    var last = lead.lastName.toLowerCase();
    var built = dominantPattern
      .replace('{first}', first)
      .replace('{last}', last)
      .replace('{f}', first[0])
      .replace('{l}', last[0]);
    if (built && built.indexOf('{') < 0) {  // all placeholders resolved
      var patternEmail = built + '@' + orgDomain;
      // Prepend (de-dup)
      candidates = [patternEmail].concat(candidates.filter(function(c) {
        return c.toLowerCase() !== patternEmail.toLowerCase();
      }));
      Logger.log('[EmailEnricher] Pattern-guided top candidate: ' + patternEmail);
    }
  }

  // ── Gemini augmentation: prepend Gemini's top picks if it ran successfully.
  //    These tend to be smarter than naive permutations (Gemini knows the
  //    company's actual pattern preferences from its training data). De-dup
  //    while preserving Gemini ranking first.
  //
  // 2026-05-11 AUDIT FIX (reviewer finding #6): only merge Gemini candidates
  // when Gemini's resolved domain matches the final orgDomain we're using.
  // If the TLD probe rescued us with a different domain, Gemini's emails (at
  // its hypothesized domain) are stale and would inject the wrong @ part.
  if (typeof gem !== 'undefined' && gem && gem.candidates && gem.candidates.length &&
      gem.domain && gem.domain.toLowerCase() === orgDomain.toLowerCase()) {
    var seen = {};
    var combined = [];
    gem.candidates.forEach(function(c) {
      if (c && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c) && !seen[c.toLowerCase()]) {
        seen[c.toLowerCase()] = true;
        combined.push(c.toLowerCase());
      }
    });
    candidates.forEach(function(c) {
      if (c && !seen[c.toLowerCase()]) {
        seen[c.toLowerCase()] = true;
        combined.push(c.toLowerCase());
      }
    });
    candidates = combined;
    Logger.log('[EmailEnricher] Gemini augmented candidates (top 5): ' + candidates.slice(0, 5).join(', '));
  } else if (typeof gem !== 'undefined' && gem && gem.domain && orgDomain &&
             gem.domain.toLowerCase() !== orgDomain.toLowerCase()) {
    Logger.log('[EmailEnricher] Gemini suggested ' + gem.domain + ' but final domain is ' +
               orgDomain + ' (probe rescue) — discarding Gemini candidates to avoid wrong-domain mixing');
  }

  if (candidates.length === 0) {
    return {
      status: 'NEEDS_EMAIL',
      reason: 'no_name_to_guess_from',
      confidence: 0,
      candidates: [],
      originalEmail: original,
      classification: primary.classification || 'INVALID'
    };
  }

  // ── Path 3: walk top-5 patterns through Reoon, pick first "safe" ──
  // Cap at 5 to protect free-tier credit budget. Most names resolve in <=2 calls.
  var topN = candidates.slice(0, 5);
  var firstCatchAll = null; // remember first deliverable-but-risky for fallback
  var anyUnknown = false;

  // MX records of orgDomain (for MX-rank bonus on every candidate)
  var orgMxRecords = (verifyMxRecord(orgDomain) || {}).records || [];

  for (var i = 0; i < topN.length; i++) {
    var addr = topN[i];
    var v = verifyEmailDeliverable(addr);
    if (v.status === 'safe') {
      var baseConfSafe = _confidenceFromReoonStatus('safe', 'guess');
      var modSafe = (typeof _applyDeliverabilityModifiers === 'function') ?
        _applyDeliverabilityModifiers(baseConfSafe, {
          domain: orgDomain,
          mxRecords: orgMxRecords,
          localPart: addr.split('@')[0]
        }) : { confidence: baseConfSafe, modifiers: {} };
      return {
        status: 'VERIFIED',
        email: addr,
        classification: 'CORPORATE',
        confidence: modSafe.confidence,
        domain: orgDomain,
        reoonStatus: 'safe',
        reason: 'reoon_safe_pattern_rank_' + (i + 1) +
                (patternSource ? ' (pattern via ' + patternSource + ')' : ''),
        source: 'reoon_verified_guess',
        candidates: topN,
        originalEmail: original,
        deliverabilityModifiers: modSafe.modifiers,
        domainSources: domainSources,
        patternSource: patternSource
      };
    }
    if (v.status === 'catch_all' && !firstCatchAll) {
      firstCatchAll = { addr: addr, rank: i + 1 };
    }
    if (v.status === 'unknown' || v.status === 'skipped') {
      anyUnknown = true;
    }
    // invalid/disabled/disposable/spamtrap → keep iterating
  }

  // ── Catch-all domain: NOT a verified-deliverable signal ──
  //
  // 2026-05-11 AUDIT FIX (reviewer finding #3): catch-all servers accept any
  // mailbox at the domain (including `zzznobody@`). Calling this "VERIFIED"
  // and drafting against it causes real bounces in production. We now route
  // catch-all results to NEEDS_EMAIL_REVIEW so the user (or a downstream
  // human-in-the-loop signal) can confirm before sending. The pre-draft
  // gate (Config.EMAIL_FORMAT.minDraftConfidence) decides whether the
  // 0.55-confidence candidate proceeds to draft or stops.
  if (firstCatchAll) {
    return {
      status: 'NEEDS_EMAIL_REVIEW',
      email: firstCatchAll.addr,
      classification: 'CORPORATE',
      confidence: _confidenceFromReoonStatus('catch_all', 'guess'),
      domain: orgDomain,
      reoonStatus: 'catch_all',
      reason: 'catch_all_domain_top_pattern_rank_' + firstCatchAll.rank +
              ' — NOT actually verified, top candidate held for review',
      source: 'reoon_catch_all_unverified',
      candidates: topN,
      originalEmail: original,
      needsReview: true
    };
  }

  // ── Path 4 fallback: Reoon couldn't verify any pattern → try Hunter Email Finder ──
  // Hunter has its own pattern database scraped from public web; given a domain
  // + first/last name, it returns the most likely email. We then re-verify
  // via Reoon to confirm. Only fires when (a) Reoon returned all-unknown for
  // our 5 patterns AND (b) we have first+last name to give Hunter.
  // Free tier: 25 lookups/month. Skipped silently if HUNTER_API_KEY unset.
  if (anyUnknown && lead.firstName && lead.lastName) {
    var hunterResult = _hunterEmailFinder(orgDomain, lead.firstName, lead.lastName);
    if (hunterResult && hunterResult.email) {
      // Re-verify Hunter's pick with Reoon
      var reoonOnHunter = verifyEmailDeliverable(hunterResult.email);
      if (reoonOnHunter.status === 'safe' || reoonOnHunter.status === 'catch_all' || reoonOnHunter.status === 'role_account') {
        Logger.log('[EmailEnricher] Hunter found ' + hunterResult.email + ' (score ' + hunterResult.score + '); Reoon=' + reoonOnHunter.status);
        return {
          status: 'VERIFIED',
          email: hunterResult.email,
          classification: 'CORPORATE',
          confidence: Math.min(0.92, _confidenceFromReoonStatus(reoonOnHunter.status, 'guess') + (hunterResult.score / 1000)),
          domain: orgDomain,
          reoonStatus: reoonOnHunter.status,
          hunterScore: hunterResult.score,
          reason: 'hunter_found_reoon_' + reoonOnHunter.status,
          source: 'hunter_email_finder',
          candidates: topN,
          originalEmail: original
        };
      }
      // Hunter found something but Reoon rejected — treat as low-confidence candidate
      Logger.log('[EmailEnricher] Hunter found ' + hunterResult.email + ' but Reoon=' + reoonOnHunter.status + ' — adding to review pool');
      topN.unshift(hunterResult.email);  // prepend so it shows first in review
    }
  }

  // ── Tier-2.5: Snov.io B2B email search (before Findymail) ──────────────────
  // Snov's email-finder endpoint returns the most likely email for a person at a
  // domain based on its B2B index. We insert it BEFORE Findymail so that a direct
  // email hit from Snov is preferred over catch-all resolution.
  if (anyUnknown && lead.firstName && lead.lastName) {
    try {
      var props = PropertiesService.getScriptProperties();
      var snovUserId = props.getProperty('SNOV_API_USER_ID') || props.getProperty('SNOV_CLIENT_ID');
      var snovSecret = props.getProperty('SNOV_API_SECRET') || props.getProperty('SNOV_CLIENT_SECRET');
      if (snovUserId && snovSecret) {
        Logger.log('[EmailEnricher] Cascade: trying Snov for ' + lead.firstName + ' ' + lead.lastName + ' @ ' + orgDomain);
        var snovEmail = _callSnov(lead.firstName, lead.lastName, orgDomain);
        if (snovEmail && _isValidEmail(snovEmail)) {
          var reoonOnSnov = verifyEmailDeliverable(snovEmail);
          if (reoonOnSnov.status === 'safe' || reoonOnSnov.status === 'catch_all' || reoonOnSnov.status === 'role_account') {
            Logger.log('[EmailEnricher] Snov found ' + snovEmail + '; Reoon=' + reoonOnSnov.status);
            return {
              status: 'VERIFIED',
              email: snovEmail,
              classification: 'CORPORATE',
              confidence: 0.65,
              domain: orgDomain,
              reoonStatus: reoonOnSnov.status,
              reason: 'snov_found_reoon_' + reoonOnSnov.status,
              source: 'snov',
              candidates: topN,
              originalEmail: original
            };
          }
          Logger.log('[EmailEnricher] Snov found ' + snovEmail + ' but Reoon=' + reoonOnSnov.status + ' — adding to review pool');
          topN.unshift(snovEmail);
        }
      }
    } catch (snovErr) {
      Logger.log('[EmailEnricher] Snov failed: ' + snovErr.message);
    }
  }

  // ── Tier-3 catch-all resolver: Findymail (Patch 2026-05-11) ──────────────
  //
  // Findymail's /api/verify resolves the catch-all-vs-real-mailbox question
  // that Reoon can't (e.g., hotstar.com SMTP returns 250 for everything).
  // Their proprietary deep-verification engine returns a binary verified:
  // true/false — true means the mailbox is genuinely real even on a catch-all
  // server. We invoke it ONLY when Reoon went all-unknown AND we have a
  // shortlist worth checking (top 3 candidates).
  //
  // Credit cost: 1 verifier credit per call, charged only when a result is
  // returned (200 OK). We call up to 3 top patterns sequentially and stop at
  // the first verified=true. Cap budget at 3 calls per lead.
  //
  // If FINDYMAIL_KEY is unset, this path is a no-op.
  if (anyUnknown && topN.length > 0) {
    try {
      var findymailKey = PropertiesService.getScriptProperties().getProperty('FINDYMAIL_KEY');
      if (findymailKey) {
        var maxToTry = Math.min(3, topN.length);
        for (var fi = 0; fi < maxToTry; fi++) {
          var candidate = topN[fi];
          var fmResult = _findymailVerify(candidate, findymailKey);
          if (fmResult && fmResult.verified === true) {
            Logger.log('[EmailEnricher] FINDYMAIL VERIFIED catch-all: ' + candidate +
                       ' (provider=' + fmResult.provider + ', rank=' + (fi + 1) + ')');
            return {
              status: 'VERIFIED',
              email: candidate,
              classification: 'CORPORATE',
              confidence: 0.78,  // High but not Reoon-safe (0.85) — Findymail trust
              domain: orgDomain,
              reoonStatus: 'findymail_verified',
              reason: 'findymail_resolved_catch_all_rank_' + (fi + 1),
              source: 'findymail_catch_all_resolver',
              candidates: topN.slice(0, 3),
              originalEmail: original,
              findymailProvider: fmResult.provider,
              patternSource: patternSource
            };
          }
          if (fmResult && fmResult.verified === false) {
            Logger.log('[EmailEnricher] Findymail REJECTED ' + candidate +
                       ' — continuing to next candidate');
          }
        }
        Logger.log('[EmailEnricher] Findymail exhausted ' + maxToTry +
                   ' top candidates without a verified hit');
      } else {
        Logger.log('[EmailEnricher] FINDYMAIL_KEY not set — skipping tier-3 catch-all resolver');
      }
    } catch (fmErr) {
      Logger.log('[EmailEnricher] Findymail error: ' + fmErr.message + ' — falling through to auto-pick');
    }
  }

  // ── Reoon unavailable or all unknown: fall back to MX-only top-3 review ──
  //
  // 2026-05-11 PATCH (Vidhi Shah class): For enterprise domains that block
  // external SMTP probing (Hotstar, many large Indian enterprises, government
  // domains, etc.), Reoon legitimately can't verify and returns `unknown` for
  // every candidate. Pre-patch, this routed straight to NEEDS_EMAIL_REVIEW
  // even when (a) the domain resolved with very high confidence via Apollo
  // orgs + Snov B2B + Clearbit votes, AND (b) Hunter or GitHub commits
  // confirmed the dominant `first.last` pattern for THIS domain.
  //
  // When both signals agree strongly, the top candidate is far more likely
  // correct than wrong — auto-pick it at moderate confidence (0.55) so the
  // pre-draft gate (minDraftConfidence=0.50) still proceeds to draft. Worst
  // case: a hard bounce (recoverable). Best case: ~30-40% of enterprise
  // leads that previously sat in NEEDS_EMAIL_REVIEW now ship to draft.
  if (anyUnknown) {
    // PATCH 2026-05-11: Bounce-feedback gate — if we've already seen hard
    // bounces from THIS domain, downgrade confidence so the pre-draft gate
    // routes the lead to NEEDS_EMAIL_REVIEW instead of auto-shipping.
    var domainBouncePenalty = _getDomainBouncePenalty(orgDomain);
    var hasStrongDomain = (typeof domainConfidence === 'number') && domainConfidence >= 0.75;
    var hasPatternConfirmation = !!patternSource;  // Hunter or GitHub confirmed format
    if (hasStrongDomain && hasPatternConfirmation && topN.length > 0) {
      var topCandidate = topN[0];
      var autoPickConfidence = 0.55 - domainBouncePenalty;  // Bounce feedback gate
      if (domainBouncePenalty > 0) {
        Logger.log('[EmailEnricher] Domain ' + orgDomain + ' has bounce history (penalty ' +
                   domainBouncePenalty.toFixed(2) + ') — confidence ' + autoPickConfidence.toFixed(2));
      }
      // If penalty drops us below the 0.50 draft gate, route to review instead of auto-shipping
      if (autoPickConfidence < 0.50) {
        Logger.log('[EmailEnricher] AUTO-PICK suppressed: bounce-penalized confidence ' +
                   autoPickConfidence.toFixed(2) + ' < 0.50 draft gate → review');
        return {
          status: 'NEEDS_EMAIL_REVIEW',
          candidates: topN.slice(0, 3),
          confidence: autoPickConfidence,
          originalEmail: original,
          classification: 'CORPORATE',
          domain: orgDomain,
          reoonStatus: 'unknown_bounce_blocked',
          reason: 'auto_pick_blocked_by_bounce_history_penalty_' + domainBouncePenalty.toFixed(2),
          source: 'guessed_pattern_unverified_bounce_blocked',
          allDomainCandidates: allDomainCandidates,
          domainSources: domainSources,
          domainConfidence: domainConfidence
        };
      }
      Logger.log('[EmailEnricher] AUTO-PICK (Vidhi-class): all-unknown + domain conf ' +
                 domainConfidence.toFixed(2) + ' + pattern via ' + patternSource +
                 ' → picking ' + topCandidate + ' at ' + autoPickConfidence.toFixed(2));
      return {
        status: 'VERIFIED',
        email: topCandidate,
        classification: 'CORPORATE',
        confidence: autoPickConfidence,
        domain: orgDomain,
        reoonStatus: 'unknown_auto_picked',
        reason: 'unknown_auto_picked_strong_domain_and_pattern',
        source: 'guessed_pattern_auto_picked',
        candidates: topN.slice(0, 3),
        originalEmail: original,
        autoPicked: true,
        patternSource: patternSource,
        domainConfidence: domainConfidence,
        bouncePenalty: domainBouncePenalty,
        allDomainCandidates: allDomainCandidates,
        domainSources: domainSources
      };
    }

    // ── PATCH 2026-05-12: Multi-Signal Disambiguator (MSD) ──
    // The original auto-pick block above requires BOTH high domain confidence
    // AND a Hunter/GitHub patternSource. When neither prerequisite is met
    // (e.g., Apollo missed the lead entirely so we have no Hunter pattern),
    // run an ensemble ranker over the candidates using non-SMTP signals:
    //   - curated domain → pattern map (top-100 employers)
    //   - historical learning from prior SENT/REPLIED leads at this domain
    //   - Hunter Domain Search pattern (if available)
    //   - global pattern frequency prior
    //   - Gemini LLM disambiguation (when other signals tied)
    //   - reply-history positive signal
    //   - bounce-history negative signal
    //
    // Auto-picks only when top score >= 50 AND gap to runner-up >= 15 points
    // (avoids damaging sender reputation with confident wrong picks).
    if (typeof multiSignalRank === 'function' && topN.length >= 1
        && lead.firstName && lead.lastName) {
      try {
        var msd = multiSignalRank(orgDomain, lead.firstName, lead.lastName,
                                   topN.slice(0, 5), { organization: lead.organization || '' });
        Logger.log('[EmailEnricher] MSD: best=' + msd.best + ' score=' + msd.bestScore +
                   ' gap=' + msd.gap + ' shouldAutoPick=' + msd.shouldAutoPick +
                   ' breakdown=' + JSON.stringify(msd.breakdown));
        if (msd.shouldAutoPick && msd.best) {
          // PATCH 2026-05-18: flag autoPicked + autoPickPath so PSV's
          // Hunter-Verifier tie-breaker always fires for lenient picks.
          // The lenient path (lowered threshold via dominant pattern signal)
          // is by construction lower-confidence than strict, so Hunter's
          // verdict becomes the final gate. Strict picks also flag autoPicked
          // for consistency, but were already high-confidence enough that
          // PSV typically passes without needing Hunter.
          return {
            status: 'VERIFIED',
            email: msd.best,
            classification: 'CORPORATE',
            confidence: msd.confidence,
            domain: orgDomain,
            reoonStatus: 'unknown_msd_picked',
            reason: 'msd_' + (msd.autoPickPath || 'auto') + '_pick_score_' + msd.bestScore + '_gap_' + msd.gap
                    + (msd.dominantSource ? '_pattern=' + msd.dominantSource : ''),
            source: 'multi_signal_disambiguator',
            autoPicked: true,
            autoPickPath: msd.autoPickPath,
            candidates: msd.ranked.map(function(r) { return r.email; }),
            originalEmail: original,
            msdScore: msd.bestScore,
            msdGap: msd.gap,
            msdBreakdown: msd.breakdown,
            msdRanked: msd.ranked,
            allDomainCandidates: allDomainCandidates,
            domainSources: domainSources
          };
        }
        // MSD didn't auto-pick. Two-stage degrade:
        //
        // PATCH 2026-05-18: pre-fill ENRICHED_EMAIL with the MSD top guess
        // (returned via `email`) but mark status NEEDS_EMAIL_REVIEW so the
        // user can either approve (one-click into col F) or replace with
        // another candidate from the suggested list. Previously the field
        // was blank and the user had to mentally compare 5 strings; now the
        // most-likely answer is pre-filled.
        //
        // BatchProcessor will see `status: NEEDS_EMAIL_REVIEW` and skip
        // composition, but the ENRICHED_EMAIL field carries the pre-filled
        // candidate forward for visibility. _persistEnrichmentResults
        // (caller) writes enrichment.email into col X (ENRICHED_EMAIL).
        return {
          status: 'NEEDS_EMAIL_REVIEW',
          email: msd.best || '',        // ← pre-filled top guess
          candidates: msd.ranked.map(function(r) { return r.email; }),
          confidence: msd.confidence,
          originalEmail: original,
          classification: 'CORPORATE',
          domain: orgDomain,
          reoonStatus: 'unknown_msd_ranked',
          reason: 'msd_ranked_top_' + msd.bestScore + '_no_clear_winner_gap_' + msd.gap
                  + (msd.dominantPatternSignal ? ' (pattern=' + msd.dominantSource + ')' : ' (no_dominant_pattern)'),
          source: 'msd_ranked_review',
          msdBestGuess: msd.best,
          msdBestScore: msd.bestScore,
          msdRanked: msd.ranked,
          allDomainCandidates: allDomainCandidates,
          domainSources: domainSources,
          domainConfidence: domainConfidence
        };
      } catch (msdErr) {
        Logger.log('[EmailEnricher] MSD failed (falling through to plain review): ' + msdErr.message);
      }
    }

    return {
      status: 'NEEDS_EMAIL_REVIEW',
      candidates: topN.slice(0, 3),
      confidence: 0.30,
      originalEmail: original,
      classification: primary.classification || 'INVALID',
      domain: orgDomain,
      reoonStatus: 'unknown',
      reason: 'reoon_unknown_user_pick',
      source: 'guessed_pattern_unverified',
      // NEW: expose alternate candidate domains so user can pick the right
      // employer when multiple companies share the same name ("Pronto").
      allDomainCandidates: allDomainCandidates,
      domainSources: domainSources,
      domainConfidence: domainConfidence
    };
  }

  // PATCH 2026-05-19: ABSOLUTE LAST-RESORT — if we got here with all paths
  // exhausted but the user/APK provided an email AND that email is at a
  // real domain (MX present) AND it's structurally valid, KEEP IT at
  // very low confidence rather than dying with NEEDS_EMAIL.
  //
  // Rationale: when we reach this point, EVERY enrichment strategy has
  // failed against Reoon — strongly suggesting the domain's SMTP server
  // is uniformly hostile to deliverability probes (not that the addresses
  // are bad). The originally-provided email is more likely correct than
  // any pattern guess, because the user/APK had a specific reason to
  // believe it was the right address.
  //
  // STATUS=NEEDS_EMAIL_REVIEW (not VERIFIED) so user MUST review before
  // send. Downstream gates still allow the draft to be created so the
  // user has an editable artifact instead of an empty row.
  if (original && original.indexOf('@') > 0) {
    var origDomain = original.split('@')[1].toLowerCase().trim();
    try {
      var origMx = verifyMxRecord(origDomain);
      if (origMx.hasMx) {
        Logger.log('[EmailEnricher] LAST-RESORT: keeping APK-provided email ' + original +
                   ' (all enrichment paths failed Reoon, but domain has MX). conf=0.25');
        return {
          status: 'NEEDS_EMAIL_REVIEW',
          email: original,
          confidence: 0.25,
          candidates: [original].concat(topN.slice(0, 3)),
          originalEmail: original,
          classification: primary.classification || 'CORPORATE',
          domain: origDomain,
          reoonStatus: 'reoon_uniformly_disputed',
          reason: 'all_paths_reoon_disputed_falling_back_to_apk_email',
          source: 'apk_email_last_resort',
          note: 'Every verified-deliverability check failed — likely false negatives from corporate SMTP defenses. Original APK-provided email kept for review. Verify recipient address before sending.'
        };
      }
    } catch (_) {}
  }

  // True dead end — no email available anywhere
  return {
    status: 'NEEDS_EMAIL',
    confidence: 0,
    candidates: topN.slice(0, 3),
    originalEmail: original,
    classification: primary.classification || 'INVALID',
    domain: orgDomain,
    reoonStatus: 'invalid',
    reason: 'all_patterns_undeliverable_no_fallback_email',
    source: 'rejected'
  };
}

/**
 * Maps Reoon Power Mode status → confidence score, weighted by source
 * (sheet email is more reliable than a guess at the same status).
 *
 * @param {string} reoonStatus  'safe' | 'catch_all' | 'role_account' | 'unknown' | 'invalid' | etc.
 * @param {string} source       'sheet' | 'guess'
 * @returns {number} 0.0-1.0
 */
function _confidenceFromReoonStatus(reoonStatus, source) {
  var map = {
    sheet: { safe: 0.95, role_account: 0.80, catch_all: 0.70, unknown: 0.55, skipped: 0.55 },
    guess: { safe: 0.85, role_account: 0.65, catch_all: 0.55, unknown: 0.40, skipped: 0.50 }
  };
  var bucket = map[source] || map.guess;
  return bucket[reoonStatus] || 0.30;
}

/**
 * Apply deliverability-signal modifiers to a base confidence.
 *
 * Per R6 research, the strongest free signals beyond Reoon are:
 *   + DMARC strictness  ( p=reject +0.05, p=quarantine +0.02 )
 *   + MX rank           ( Google Workspace / M365 +0.03 )
 *   - Disposable domain ( -0.50 — should never have reached here, defense-in-depth )
 *   - Role account      ( -0.10 — local-part is info / hr / support / etc. )
 *
 * @param {number} baseConf    Output of _confidenceFromReoonStatus
 * @param {Object} signals     { domain, mxRecords, localPart }
 * @returns {Object} { confidence, modifiers: {...} }
 */
function _applyDeliverabilityModifiers(baseConf, signals) {
  signals = signals || {};
  var conf = baseConf;
  var mods = {};

  // DMARC bonus
  if (typeof domainDmarcStrictness === 'function' && signals.domain) {
    try {
      var policy = domainDmarcStrictness(signals.domain);
      if (policy === 'reject') { conf += 0.05; mods.dmarc = '+0.05 (p=reject)'; }
      else if (policy === 'quarantine') { conf += 0.02; mods.dmarc = '+0.02 (p=quarantine)'; }
      else { mods.dmarc = '0 (p=' + (policy || 'none/missing') + ')'; }
    } catch (_) {}
  }

  // MX rank bonus
  if (typeof mxRankBonus === 'function' && signals.mxRecords) {
    try {
      var bonus = mxRankBonus(signals.mxRecords);
      if (bonus > 0) { conf += bonus; mods.mxRank = '+' + bonus.toFixed(2); }
    } catch (_) {}
  }

  // Disposable domain penalty (hard cap)
  if (typeof isDisposableDomain === 'function' && signals.domain) {
    try {
      if (isDisposableDomain(signals.domain)) {
        conf -= 0.50;
        mods.disposable = '-0.50 (domain on disposable blocklist)';
      }
    } catch (_) {}
  }

  // Role-account penalty
  if (signals.localPart) {
    var roleRe = /^(info|hr|contact|support|admin|noreply|no-reply|careers?|billing|team|sales|hello|hi|press)$/i;
    if (roleRe.test(signals.localPart)) {
      conf -= 0.10;
      mods.roleAccount = '-0.10 (' + signals.localPart + ')';
    }
  }

  // Clamp
  var clamped = Math.max(0.0, Math.min(0.95, conf));
  return { confidence: clamped, raw: conf, modifiers: mods };
}

// ─── STEP 1: CLASSIFY ───────────────────────────────────────

/**
 * Validates format and classifies an email as CORPORATE / FREE / INVALID.
 * @param {string} rawEmail
 * @returns {Object}
 */
function classifyEmail(rawEmail) {
  if (!rawEmail) {
    return { valid: false, classification: 'INVALID', reason: 'empty' };
  }
  var email = rawEmail.toString().trim().toLowerCase();

  // RFC 5322-ish format gate (not full spec; cold-email grade)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { valid: false, classification: 'INVALID', reason: 'format', email: email };
  }

  var domain = email.split('@')[1];

  if (FREE_EMAIL_DOMAINS[domain]) {
    return {
      valid: false,
      email: email,
      domain: domain,
      classification: 'FREE',
      reason: 'free_provider'
    };
  }

  return {
    valid: true,
    email: email,
    domain: domain,
    classification: 'CORPORATE',
    reason: 'corporate_format_ok'
  };
}

// ─── STEP 2: VERIFY MX VIA GOOGLE PUBLIC DNS ────────────────

/**
 * Confirms the domain resolves to at least one MX record.
 * Uses https://dns.google/resolve (no auth, no quota, CORS-safe).
 * Caches results in ScriptCache for 24h to avoid repeat lookups
 * on re-runs of the same lead list.
 *
 * @param {string} domain  e.g. "acme.com"
 * @returns {Object} { hasMx: boolean, records?: Array, reason?: string }
 */
function verifyMxRecord(domain) {
  if (!domain) return { hasMx: false, reason: 'empty_domain' };
  var d = domain.toLowerCase().trim();

  // Cached at the script layer — DNS changes are rare, and Google Public DNS
  // has its own TTL respect. 2026-06-12-cacheservice-migration: routed through
  // the _vendorCache helpers; the old direct put requested 86400s, above the
  // 21600s CacheService cap, so it was rejected at runtime and MX results were
  // silently never cached. The helper clamps to the cap, so caching now works.
  var cachedMx = _vendorCacheGet('MX_' + d);
  if (cachedMx) return cachedMx;

  var result;
  try {
    var url = 'https://dns.google/resolve?name=' + encodeURIComponent(d) + '&type=MX';
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var code = res.getResponseCode();
    if (code !== 200) {
      result = { hasMx: false, reason: 'dns_http_' + code };
    } else {
      var json = JSON.parse(res.getContentText());
      // Status 0 = NOERROR; Answer array present = MX records returned
      var hasMx = json.Status === 0 && Array.isArray(json.Answer) && json.Answer.length > 0;
      result = { hasMx: hasMx, records: json.Answer || [], reason: hasMx ? 'ok' : 'no_mx_records' };
    }
  } catch (e) {
    result = { hasMx: false, reason: 'dns_error: ' + e.message };
  }

  _vendorCachePut('MX_' + d, result, 86400);

  return result;
}

// ─── STEP 3: GUESS CORPORATE EMAIL PATTERNS ─────────────────

/**
 * Generates ranked corporate email candidates for a person at a domain.
 * Ranking reflects 2026 corporate email-pattern prevalence (Dropcontact
 * benchmark on 20k contacts): first.last@ is the most common, followed
 * by flast@, fl@, etc.
 *
 * @param {string} firstName
 * @param {string} lastName
 * @param {string} domain  e.g. "acme.com"
 * @returns {Array<string>}  ["john.doe@acme.com", "jdoe@acme.com", ...]
 */
function guessProfessionalEmail(firstName, lastName, domain) {
  if (!firstName || !domain) return [];

  var f = (firstName || '').toString().toLowerCase().replace(/[^a-z]/g, '');
  var l = (lastName || '').toString().toLowerCase().replace(/[^a-z]/g, '');

  if (!f) return [];

  // If we don't have a last name, the best we can do is a first-name guess.
  if (!l) {
    return [f + '@' + domain, (f[0] || '') + '@' + domain];
  }

  // Ranked patterns by prevalence (approximate % share shown in comments)
  var locals = [
    f + '.' + l,          // john.doe     — ~35%
    f[0] + l,             // jdoe         — ~11%
    f + l,                // johndoe      — ~10%
    f,                    // john         — ~9%
    f + '_' + l,          // john_doe     — ~6%
    f[0] + '.' + l,       // j.doe        — ~4%
    f + l[0],             // johnd        — ~4%
    l + '.' + f,          // doe.john     — ~3%
    f + '-' + l,          // john-doe     — ~2%
    l,                    // doe          — ~2%
    f + '.' + l[0],       // john.d       — ~2%
    l + f,                // doejohn      — ~1%
    l + f[0],             // doej         — ~1%
    f[0] + l[0]           // jd           — ~1%
  ];

  var seen = {};
  var out = [];
  for (var i = 0; i < locals.length; i++) {
    var addr = locals[i] + '@' + domain;
    if (!seen[addr]) {
      seen[addr] = true;
      out.push(addr);
    }
  }
  return out;
}

// ─── STEP 4: INFER DOMAIN FROM ORG NAME ─────────────────────

/**
 * Tries to produce a plausible corporate domain from a company name.
 * Strips common suffixes ("Inc", "Pvt Ltd", "Technologies"...) and
 * punctuation/whitespace, then appends .com.
 *
 * Limitation: picks .com blindly. If the organization uses .io, .ai,
 * .co, .in, .co.in, etc., the caller should verify MX on several
 * TLDs. This function returns the single best guess; verifyMxRecord
 * will reject the guess if the .com doesn't resolve.
 *
 * Optionally reads lead.dossier.website if present (set by
 * researchLead) — that's the most reliable source.
 *
 * @param {string} org
 * @returns {string}  e.g. "acmetech.com"  or  ""
 */
// ─── APOLLO STALE-EMAIL GUARD (PATCH 2026-05-18) ──────────────────────────
//
// Two helpers that defend the Apollo /people/match happy-path against the
// "current org, stale email" failure class. Documented in detail at the
// call-site (Path 0.5 in enrichEmail) and in DEPLOY_2026-05-18-stale-apollo.md.
//
// _detectStaleApolloEmail: returns {stale, expectedDomain, expectedDomainConfidence, sources}
// _attemptApolloEmailRedirect: returns an enrichment object (VERIFIED or NEEDS_EMAIL_REVIEW)

/**
 * Decide whether Apollo's returned email domain disagrees with the lead's
 * CURRENT employer's expected domain. The lead's organization (from APK
 * Vision OCR of the current LinkedIn profile) is the authoritative source
 * of truth for current employer; Apollo's email field is best-effort and
 * can lag job changes by months. When these disagree, the Apollo email
 * is likely deactivated at the previous employer.
 *
 * Why we don't just use apolloMatch.domain: Apollo's `domain` field comes
 * from the person's "organization" block which Apollo *also* sometimes
 * sets to the previous employer (especially for recently-changed jobs
 * where Apollo updated employment_history but not the primary org link).
 * The LinkedIn-scraped lead.organization is more current.
 *
 * @returns {Object} { stale: boolean, expectedDomain?, expectedDomainConfidence?, expectedDomainSources? }
 */
function _detectStaleApolloEmail(apolloMatch, lead) {
  if (!apolloMatch || !apolloMatch.email || !lead || !lead.organization) {
    return { stale: false };
  }
  var apolloEmailDomain = (apolloMatch.email.split('@')[1] || '').toLowerCase().trim();
  if (!apolloEmailDomain) return { stale: false };

  // Resolve lead.organization → expected domain via the existing multi-source
  // resolver. We require confidence ≥ 0.50 to act — below that we don't trust
  // the resolution enough to flag Apollo's email as stale (avoids false
  // positives for obscure orgs the resolver can't pin down).
  var contextHints = {
    firstName: lead.firstName,
    lastName: lead.lastName,
    linkedinUrl: lead.linkedinUrl || '',
    headline: lead.headline || '',
    designation: lead.designation || lead.currentDesignation || '',
    location: lead.location || ''
  };
  var resolved = null;
  try {
    if (typeof resolveDomainContextual === 'function') {
      resolved = resolveDomainContextual(lead.organization, contextHints);
    } else if (typeof resolveDomainMultiSource === 'function') {
      resolved = resolveDomainMultiSource(lead.organization, lead.firstName, lead.lastName);
    }
  } catch (_) {}

  if (!resolved || !resolved.domain || (resolved.confidence || 0) < 0.50) {
    return { stale: false };
  }
  var expected = resolved.domain.toLowerCase().trim();

  // Domains match (allowing for subdomain prefixes like mail.x.com vs x.com)
  function _baseDomain(d) {
    var parts = d.split('.');
    // Naive eTLD+1: keep the last two parts for typical TLDs, last three for
    // .co.uk / .co.in / .com.au patterns. Good enough for the disagreement
    // check; misses some edge cases (e.g., .gov.uk → keeps gov.uk).
    if (parts.length <= 2) return d;
    var last2 = parts.slice(-2).join('.');
    var ccTld2 = { 'co.uk': 1, 'co.in': 1, 'com.au': 1, 'com.br': 1, 'co.jp': 1, 'co.kr': 1 };
    if (ccTld2[last2]) return parts.slice(-3).join('.');
    return last2;
  }
  if (_baseDomain(apolloEmailDomain) === _baseDomain(expected)) {
    return { stale: false };
  }

  return {
    stale: true,
    expectedDomain: expected,
    expectedDomainConfidence: resolved.confidence,
    expectedDomainSources: resolved.sources || []
  };
}

/**
 * When Apollo's email is stale, try to recover a fresh email at the lead's
 * current employer's domain via pattern-guess + Reoon. Returns:
 *
 *   - VERIFIED at conf 0.55, source='apollo_redirected_pattern_guess'
 *     when at least one pattern-guess Reoon-verifies as safe/role_account/catch_all
 *
 *   - NEEDS_EMAIL_REVIEW exposing BOTH the stale Apollo email and the
 *     pattern-guess candidates at the current org, with explicit notes
 *     when no guess verifies (so the human picks knowing the trade-off)
 *
 * This helper NEVER returns null on its happy path. Returning null means
 * the helper was called with missing prerequisites (no firstName, no
 * domain) — caller falls back to the legacy Apollo path.
 */
function _attemptApolloEmailRedirect(lead, apolloMatch, staleCheck) {
  if (!lead.firstName || !staleCheck.expectedDomain) return null;
  var expectedDomain = staleCheck.expectedDomain;
  var apolloEmail = apolloMatch.email;
  // `original` is the pre-enrichment email from the sheet (may equal
  // apolloEmail if the APK wrote Apollo's stale address into col F via
  // the sheet_corporate path). Helper-scope variable so we don't capture
  // enrichEmail()'s local.
  var original = (lead.email || '').toString().trim();

  // Sanity: verify the expected domain has MX records. If we can't reach
  // the current-org domain at all, the redirect would fail anyway —
  // surface that explicitly to the user.
  var expectedMx;
  try { expectedMx = verifyMxRecord(expectedDomain); } catch (_) { expectedMx = { hasMx: false }; }
  if (!expectedMx.hasMx) {
    Logger.log('[EmailEnricher] Apollo redirect: expected domain ' + expectedDomain + ' has no MX; ' +
               'surfacing both candidates for manual review');
    return {
      status: 'NEEDS_EMAIL_REVIEW',
      email: apolloEmail,                    // pre-fill the stale one (least worst default)
      candidates: [apolloEmail],
      confidence: 0.30,
      originalEmail: original,
      classification: 'CORPORATE',
      domain: (apolloMatch.email.split('@')[1] || '').toLowerCase(),
      reoonStatus: 'apollo_stale_no_redirect_mx',
      reason: 'apollo_email_at_ex_employer_and_current_org_domain_unreachable',
      source: 'apollo_stale_no_redirect',
      apolloMatch: {
        organizationName: apolloMatch.organizationName,
        title: apolloMatch.title,
        fullName: apolloMatch.fullName,
        emailStale: true,
        expectedDomain: expectedDomain,
        expectedDomainConfidence: staleCheck.expectedDomainConfidence
      },
      notes: 'Apollo returned ' + apolloEmail + ' but lead.organization=' + lead.organization +
             ' resolves to ' + expectedDomain + ' (no MX). Manually verify recipient.'
    };
  }

  // Generate pattern-guess candidates at the current-org domain. Use the
  // existing guessProfessionalEmail() for consistency with the rest of
  // the cascade (same patterns, same ranking order).
  var candidates = guessProfessionalEmail(lead.firstName, lead.lastName || '', expectedDomain);
  if (!candidates || candidates.length === 0) {
    Logger.log('[EmailEnricher] Apollo redirect: no pattern candidates generated for ' + expectedDomain);
    return null;
  }

  // Reoon-verify the top 3 candidates (cap to keep cost bounded — guess gen
  // produces 14 ranked candidates, but the first three cover ~56% of corporate
  // patterns per Dropcontact benchmark).
  var topGuesses = candidates.slice(0, 3);
  for (var i = 0; i < topGuesses.length; i++) {
    var guess = topGuesses[i];
    var rvg;
    try { rvg = verifyEmailDeliverable(guess); } catch (_) { rvg = { status: 'error' }; }
    Logger.log('[EmailEnricher] Apollo redirect: ' + guess + ' → ' + rvg.status);
    if (rvg.status === 'safe' || rvg.status === 'role_account') {
      // Strong signal — Reoon confirms deliverable at current org.
      return {
        status: 'VERIFIED',
        email: guess,
        classification: 'CORPORATE',
        confidence: 0.62,
        domain: expectedDomain,
        reoonStatus: rvg.status,
        reason: 'apollo_redirected_pattern_guess_reoon_' + rvg.status,
        source: 'apollo_redirected_pattern_guess',
        candidates: [guess, apolloEmail].concat(topGuesses.slice(0, 3).filter(function(g){ return g !== guess; })),
        originalEmail: original,
        autoPicked: true,    // makes PSV's Hunter Verifier fire as backstop
        apolloMatch: {
          organizationName: apolloMatch.organizationName,
          title: apolloMatch.title,
          fullName: apolloMatch.fullName,
          emailStale: true,
          staleEmail: apolloEmail,
          expectedDomain: expectedDomain,
          expectedDomainConfidence: staleCheck.expectedDomainConfidence
        },
        notes: 'Apollo returned stale ' + apolloEmail + ' (ex-employer). Redirected to ' + guess +
               ' (Reoon ' + rvg.status + ') at current org ' + lead.organization + '.'
      };
    }
    if (rvg.status === 'catch_all') {
      // Catch-all means we can't distinguish, but the address might work.
      // Lower confidence and continue to next guess in case a non-catch-all
      // pattern verifies more strongly.
      if (i === topGuesses.length - 1) {
        return {
          status: 'VERIFIED',
          email: guess,
          classification: 'CORPORATE',
          confidence: 0.48,
          domain: expectedDomain,
          reoonStatus: 'catch_all',
          reason: 'apollo_redirected_pattern_guess_catch_all',
          source: 'apollo_redirected_pattern_guess',
          candidates: [guess, apolloEmail].concat(topGuesses.slice(0, 3).filter(function(g){ return g !== guess; })),
          originalEmail: original,
          autoPicked: true,
          apolloMatch: {
            organizationName: apolloMatch.organizationName,
            title: apolloMatch.title,
            fullName: apolloMatch.fullName,
            emailStale: true,
            staleEmail: apolloEmail,
            expectedDomain: expectedDomain,
            expectedDomainConfidence: staleCheck.expectedDomainConfidence
          },
          notes: 'Apollo returned stale ' + apolloEmail + ' (ex-employer). Redirected to ' + guess +
                 ' at current org ' + lead.organization + ' (catch-all domain — PSV Hunter will tie-break).'
        };
      }
    }
    if (rvg.status === 'invalid' || rvg.status === 'disabled') {
      // Hard reject this candidate, keep trying
      continue;
    }
  }

  // No guess Reoon-verified strongly → surface both Apollo and pattern
  // candidates for manual review. Pre-fill ENRICHED_EMAIL with the top
  // pattern guess (statistically likeliest current address) rather than
  // the known-stale Apollo email.
  return {
    status: 'NEEDS_EMAIL_REVIEW',
    email: topGuesses[0],                     // pre-fill top guess at CURRENT org
    candidates: [topGuesses[0], apolloEmail].concat(topGuesses.slice(1)),
    confidence: 0.32,
    originalEmail: original,
    classification: 'CORPORATE',
    domain: expectedDomain,
    reoonStatus: 'apollo_stale_no_strong_redirect',
    reason: 'apollo_email_at_ex_employer_no_pattern_verifies_strongly_at_current_org',
    source: 'apollo_stale_needs_review',
    apolloMatch: {
      organizationName: apolloMatch.organizationName,
      title: apolloMatch.title,
      fullName: apolloMatch.fullName,
      emailStale: true,
      staleEmail: apolloEmail,
      expectedDomain: expectedDomain,
      expectedDomainConfidence: staleCheck.expectedDomainConfidence
    },
    notes: 'Apollo returned ' + apolloEmail + ' (likely ex-employer). Patterns at current org ' +
           lead.organization + ' (' + expectedDomain + ') tried: ' + topGuesses.join(', ') +
           ' — none Reoon-verified strongly. Pick the most-likely candidate manually.'
  };
}

function _organizationToDomain(org) {
  if (!org) return '';

  // PATCH 2026-05-13: consult the manual-override table first so consumer
  // brands like "Nothing" → nothing.tech are caught before the heuristic
  // generates a wrong .com guess.
  var override = _resolveManualDomainOverride(org);
  if (override) return override;

  var cleaned = org.toString().toLowerCase();

  // Remove common legal-form suffixes (word-boundary to avoid mangling names like "Incorporated Inc.")
  ORG_SUFFIX_NOISE.forEach(function(suffix) {
    cleaned = cleaned.replace(new RegExp('\\b' + suffix + '\\.?\\b', 'g'), '');
  });

  // Drop non-alphanumerics
  cleaned = cleaned.replace(/[^a-z0-9]/g, '').trim();

  if (!cleaned) return '';
  return cleaned + '.com';
}

// ─── REOON POWER MODE: SMTP-LEVEL DELIVERABILITY ────────────

/**
 * Verifies an email via Reoon Email Verifier Power Mode (SMTP RCPT TO check).
 * Cached per-email for 30 days to stay well under the 600 credit/month free tier.
 *
 * Returns a normalized status:
 *   'safe'         — mailbox accepts mail at SMTP layer
 *   'catch_all'    — domain accepts everything (every guess returns "yes")
 *   'role_account' — info@ / contact@ / hr@ — deliverable but generic
 *   'disabled'     — mailbox explicitly rejected
 *   'invalid'      — syntax / domain problem
 *   'disposable'   — temp-mail provider
 *   'spamtrap'     — known honeypot
 *   'unknown'      — server didn't return verdict (Reoon doesn't charge for these)
 *   'skipped'      — REOON_API_KEY not configured; skipping to MX-only mode
 *
 * @param {string} email
 * @returns {Object} { status: string, raw?: Object }
 */
function verifyEmailDeliverable(email) {
  if (!email) return { status: 'invalid', reason: 'empty' };
  var addr = email.toString().trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
    return { status: 'invalid', reason: 'bad_format' };
  }

  // Fetch API key from Script Properties (never hardcoded)
  var props = PropertiesService.getScriptProperties();
  var keyName = (CONFIG && CONFIG.PROPERTY_KEYS && CONFIG.PROPERTY_KEYS.REOON_API_KEY) || 'REOON_API_KEY';
  var apiKey = props.getProperty(keyName);
  if (!apiKey) {
    return { status: 'skipped', reason: 'reoon_api_key_unset' };
  }

  // ── PATCH `-p5-vendorresilience-reoon` (Phase 2d circuit-breaker check) ──
  //
  // Per the master prompt's failure-mode rule: "403 'no credits' = HARD trip".
  // Live diagnosis on 2026-06-09 showed Row 32 burning 12 Reoon 403s (6 power
  // → 6 quick fallback), each returning the body
  // `{"reason":"Not enough credits available. Please recharge.","status":"error"}`.
  // The whole Reoon account is exhausted; the Power→Quick waterfall doesn't
  // help because Quick is also 403'ing.
  //
  // The 2d patch trips a date-keyed property (REOON_QUOTA_EXHAUSTED_<YYYY-MM-DD>)
  // on the FIRST credits-exhausted 403 of the day. Subsequent verifyEmailDeliverable
  // calls in the same UTC day short-circuit to `skipped` immediately — saves
  // ~500ms × ~12 calls = 6s/lead, AND avoids hammering the vendor when we know
  // they'll just 403 again.
  //
  // The flag is set in the response-handling block below, then checked here on
  // the next call. Date-keyed for automatic reset at UTC midnight (matches
  // Reoon's own quota window).
  var reoonFlagCheck = _reoonQuotaCheck();
  if (reoonFlagCheck.exhausted) {
    return {
      status: 'skipped',
      reason: 'reoon_daily_quota_exhausted',
      reoonFlagDate: reoonFlagCheck.date,
      reoonFlagValue: reoonFlagCheck.value
    };
  }

  // 30-day per-email cache. Reoon results don't change often; reverify periodically
  // by clearing this cache via clearReoonCache() helper below.
  var cachePrefix = (CONFIG && CONFIG.PROPERTY_KEYS && CONFIG.PROPERTY_KEYS.REOON_VERIFY_CACHE_PREFIX) || 'REOON_VERIFY_';
  var cacheKey = cachePrefix + addr;

  try {
    // 2026-05-11 AUDIT FIX (reviewer finding #4): split cache TTL by status type.
    // Reoon "unknown" can be transient (greylisting, server timeout, DNS hiccup)
    // — we used to cache it for 30 days which locked leads into NEEDS_EMAIL_REVIEW.
    // New policy:
    //   - safe / role_account / catch_all: 30 days (these don't flip)
    //   - invalid / disabled / spamtrap / disposable: 30 days (deliberately
    //     persistent; bad addresses don't repair themselves)
    //   - unknown / skipped: 6 hours (retry on next batch run)
    // 2026-06-12-cacheservice-migration: the entry now lives in CacheService,
    // whose 6h platform cap bounds the long_30d branch in practice; the split
    // is still applied at write time via the TTL argument.
    var parsed = _vendorCacheGet(cacheKey);
    if (parsed) {
      var ageHours = (Date.now() - parsed.ts) / (1000 * 60 * 60);
      var transient = (parsed.status === 'unknown' || parsed.status === 'skipped');
      var ttlHours = transient ? 6 : (30 * 24);
      if (ageHours < ttlHours) {
        return { status: parsed.status, raw: parsed.raw, cached: true,
                 ageHours: ageHours.toFixed(1), ttlPolicy: transient ? 'short_6h' : 'long_30d' };
      }
    }
  } catch (_) { /* cache optional */ }

  // ── Live API call — POWER → QUICK waterfall ──
  // PATCH 2026-05-20: Reoon's Power mode (full SMTP probe, ~600/mo free) is
  // the default. When it returns 403 (key denied / payment / IP block / per-
  // endpoint restriction), automatically fall back to Quick mode (lighter
  // syntax+MX+blacklist check, 13/day free + 600/month). Quick mode keeps
  // the pipeline running while Power-mode access is resolved on the vendor
  // side.
  //
  // Per-call mode is recorded in the cached result so the upstream selector
  // / PSV can weight Quick-mode "safe" slightly lower than Power-mode "safe"
  // if it ever needs to. The on-the-wire response shape is identical between
  // modes — only the verification depth differs.
  //
  // Daily quota of Quick mode is tracked in a script property
  // (REOON_QUICK_QUOTA_USED + REOON_QUICK_QUOTA_DAY) so we don't burn through
  // it pointlessly. When Quick quota is exhausted we return 'skipped' with
  // reason='reoon_quick_quota_exhausted'.
  var quickQuotaExhausted = _reoonQuickQuotaExhausted();

  var attempts = [];
  var modes = ['power', 'quick'];
  for (var mi = 0; mi < modes.length; mi++) {
    var mode = modes[mi];
    if (mode === 'quick' && quickQuotaExhausted) {
      attempts.push({ mode: mode, skipped: true, reason: 'quota_exhausted' });
      continue;
    }

    var url = 'https://emailverifier.reoon.com/api/v1/verify' +
      '?email=' + encodeURIComponent(addr) +
      '&key=' + encodeURIComponent(apiKey) +
      '&mode=' + mode;

    try {
      var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      var code = res.getResponseCode();
      var bodyText = res.getContentText() || '';
      attempts.push({ mode: mode, httpCode: code });

      if (code === 200) {
        var raw = null;
        try { raw = JSON.parse(bodyText); } catch (_) {}
        var status = (raw && (raw.status || '').toString().toLowerCase()) || 'unknown';
        Logger.log('[EmailEnricher] Reoon ' + mode + ' OK for ' + addr + ': ' + status);

        // Track Quick-mode usage against daily quota
        if (mode === 'quick') {
          _reoonQuickQuotaIncrement();
        }

        // Persist with the mode used so downstream code can introspect.
        // Transient statuses keep the short TTL; stable ones request the long
        // TTL and accept the CacheService 6h cap.
        var cacheTtlSeconds = (status === 'unknown' || status === 'skipped') ? 6 * 3600 : 30 * 86400;
        if (!_vendorCachePut(cacheKey, {
              status: status, raw: raw, ts: Date.now(), mode: mode, attempts: attempts
            }, cacheTtlSeconds)) {
          Logger.log('[EmailEnricher] Cache write failed (CacheService put rejected)');
        }
        return { status: status, raw: raw, cached: false, mode: mode, attempts: attempts };
      }

      // ── PATCH `-p5-vendorresilience-reoon` (Phase 2d circuit-breaker trip) ──
      //
      // 403 with "Not enough credits" body → trip the daily breaker so the
      // rest of today's verifyEmailDeliverable calls short-circuit at entry.
      // We check the body text because Reoon's 403 is overloaded:
      //   - "Not enough credits available. Please recharge." → quota exhausted (HARD trip)
      //   - "Access denied" / "IP blocked" → access issue (don't trip; might
      //     resolve next call)
      //   - "Per-endpoint restriction" → key not approved for this mode
      //     (Power-only restriction; let waterfall to Quick handle it)
      //
      // Conservative trigger: body matches /credits|recharge/i AND code === 403.
      if (code === 403 && /credits|recharge/i.test(bodyText)) {
        try { _setReoonQuotaExhausted(bodyText.substring(0, 120)); } catch (_setErr) {}
      }

      // 403 from Power mode → waterfall to Quick. Any other non-200 is a
      // transport error — propagate as 'unknown' so the selector treats it
      // as advisory (no penalty in REOON_FALSE_NEGATIVE_DOMAINS).
      if (code === 403 && mode === 'power') {
        Logger.log('[EmailEnricher] Reoon Power mode 403 for ' + addr +
                   ' → falling back to Quick mode. Body: ' + bodyText.substring(0, 200));
        continue;  // next iteration tries Quick
      }

      // Non-403 non-200, or 403 from Quick mode → exit waterfall
      Logger.log('[EmailEnricher] Reoon ' + mode + ' HTTP ' + code + ' for ' + addr +
                 ' (no waterfall path remaining). Body: ' + bodyText.substring(0, 200));
      return { status: 'unknown', reason: 'reoon_http_' + code + '_mode_' + mode, attempts: attempts };
    } catch (e) {
      attempts.push({ mode: mode, threw: e.message });
      Logger.log('[EmailEnricher] Reoon ' + mode + ' threw for ' + addr + ': ' + e.message);
      if (mi === modes.length - 1) {
        return { status: 'unknown', reason: 'reoon_threw_all_modes', attempts: attempts };
      }
      // Else try the next mode
    }
  }

  // All modes failed / skipped
  return { status: 'unknown', reason: 'reoon_all_modes_failed', attempts: attempts };
}

// ─── REOON QUICK-MODE DAILY QUOTA TRACKER ──────────────────────────────────
//
// Reoon's Quick mode gives 13 free verifications today + ~600/month free,
// reset daily at UTC midnight. We track usage in a script property so we
// don't burn through quota pointlessly on cached emails.
//
// PROPERTY_KEYS:
//   REOON_QUICK_QUOTA_USED  → integer count for today
//   REOON_QUICK_QUOTA_DAY   → 'YYYY-MM-DD' UTC date the count applies to
//
// When the UTC date changes, we reset the counter.

function _reoonQuickQuotaUtcDateKey() {
  var d = new Date();
  return d.getUTCFullYear() + '-' +
         String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
         String(d.getUTCDate()).padStart(2, '0');
}

// ── PATCH `-p5-vendorresilience-reoon` (Phase 2d): HARD-TRIP CIRCUIT BREAKER ──
//
// Distinct from `_reoonQuickQuotaExhausted` (which tracks our internal counter
// against the 13/day Quick-mode quota). This one fires when the VENDOR itself
// signals "no credits" via a 403 + "credits"/"recharge" body — meaning Reoon's
// entire account balance is depleted, not just our local Quick-mode counter.
//
// Property: REOON_QUOTA_EXHAUSTED_<YYYY-MM-DD UTC> = '<short reason from body>'
// Date-keyed UTC so the flag auto-clears at midnight (matches Reoon's own
// quota window).
//
// Live diagnosis on 2026-06-09 showed Row 32 burning 12 successive 403s
// for raj@ey-parthenon.nl, raj.dhoreliya@parthenon.ey.com, etc. — 6 power
// then 6 quick fallback, all 403'ing with the same "Not enough credits"
// body. Each waste: ~500ms. Total ~6s/lead of demonstrably-pointless calls.

function _reoonQuotaCheck() {
  try {
    var props = (typeof _svc === 'function') ? _svc('Properties') : PropertiesService.getScriptProperties();
    var today = _reoonQuickQuotaUtcDateKey();  // re-uses the same UTC date helper
    var key = 'REOON_QUOTA_EXHAUSTED_' + today;
    var val = props.getProperty(key);
    if (val) {
      return { exhausted: true, date: today, value: val };
    }
    return { exhausted: false, date: today, value: null };
  } catch (e) {
    // Permissive on tracker errors — better to make the call than to
    // silently skip when we can't read the flag
    return { exhausted: false, date: null, value: null, error: e.message };
  }
}

function _setReoonQuotaExhausted(reasonText) {
  try {
    var props = (typeof _svc === 'function') ? _svc('Properties') : PropertiesService.getScriptProperties();
    var today = _reoonQuickQuotaUtcDateKey();
    var key = 'REOON_QUOTA_EXHAUSTED_' + today;
    // Idempotent: only log on the FIRST trip of the day. Subsequent calls
    // overwrite silently (still updates the timestamp/reason if it changed).
    var existing = props.getProperty(key);
    props.setProperty(key, (reasonText || '').substring(0, 200) + '|' + Date.now());
    if (!existing) {
      Logger.log('[EmailEnricher/Phase2d] Reoon HARD-TRIP circuit breaker SET for ' + today +
                 ' — all verifyEmailDeliverable calls today will skip until UTC midnight reset. ' +
                 'Reason: ' + (reasonText || '(none)').substring(0, 120));
    }
  } catch (e) {
    Logger.log('[EmailEnricher/Phase2d] _setReoonQuotaExhausted failed (non-blocking): ' + e.message);
  }
}

function _reoonQuickQuotaExhausted() {
  try {
    // PATCH P2 (_svc migration): PropertiesService access goes through the
    // registry so tests can inject a mocked store + Clock for deterministic
    // quota-reset behavior across UTC midnight.
    var props = (typeof _svc === 'function') ? _svc('Properties') : PropertiesService.getScriptProperties();
    var today = _reoonQuickQuotaUtcDateKey();
    var storedDay = props.getProperty('REOON_QUICK_QUOTA_DAY') || '';
    var used = parseInt(props.getProperty('REOON_QUICK_QUOTA_USED') || '0', 10);
    if (storedDay !== today) {
      // Reset for new day
      props.setProperty('REOON_QUICK_QUOTA_DAY', today);
      props.setProperty('REOON_QUICK_QUOTA_USED', '0');
      return false;
    }
    return used >= 13;
  } catch (_) {
    return false;  // be permissive on tracker errors
  }
}

function _reoonQuickQuotaIncrement() {
  try {
    // PATCH P2 (_svc migration): see _reoonQuickQuotaExhausted comment.
    var props = (typeof _svc === 'function') ? _svc('Properties') : PropertiesService.getScriptProperties();
    var today = _reoonQuickQuotaUtcDateKey();
    var storedDay = props.getProperty('REOON_QUICK_QUOTA_DAY') || '';
    if (storedDay !== today) {
      props.setProperty('REOON_QUICK_QUOTA_DAY', today);
      props.setProperty('REOON_QUICK_QUOTA_USED', '1');
    } else {
      var used = parseInt(props.getProperty('REOON_QUICK_QUOTA_USED') || '0', 10);
      props.setProperty('REOON_QUICK_QUOTA_USED', String(used + 1));
    }
  } catch (_) {}
}

function getReoonQuickQuotaStatus() {
  // PATCH P2 (_svc migration): see _reoonQuickQuotaExhausted comment.
  var props = (typeof _svc === 'function') ? _svc('Properties') : PropertiesService.getScriptProperties();
  var today = _reoonQuickQuotaUtcDateKey();
  var storedDay = props.getProperty('REOON_QUICK_QUOTA_DAY') || today;
  var used = parseInt(props.getProperty('REOON_QUICK_QUOTA_USED') || '0', 10);
  if (storedDay !== today) used = 0;
  return {
    utcDate: today,
    used: used,
    limit: 13,
    remaining: Math.max(0, 13 - used),
    exhausted: used >= 13
  };
}

/**
 * Clears LEGACY Reoon verify cache entries from ScriptProperties.
 *
 * Since 2026-06-12-cacheservice-migration the live Reoon cache is in
 * CacheService, whose entries cannot be enumerated — but they expire on
 * their own within 6 hours, so "wait 6h" is the new "clear the cache".
 * This helper remains useful for reclaiming property storage from
 * pre-migration REOON_VERIFY_* residue.
 */
function clearReoonCache() {
  var props = PropertiesService.getScriptProperties();
  var prefix = (CONFIG && CONFIG.PROPERTY_KEYS && CONFIG.PROPERTY_KEYS.REOON_VERIFY_CACHE_PREFIX) || 'REOON_VERIFY_';
  var all = props.getProperties();
  var cleared = 0;
  for (var k in all) {
    if (k.indexOf(prefix) === 0) {
      props.deleteProperty(k);
      cleared++;
    }
  }
  Logger.log('[EmailEnricher] Cleared ' + cleared + ' Reoon cache entries');
  return cleared;
}

// ─── HUNTER.IO EMAIL FINDER (fallback when Reoon can't verify) ─────────────
//
// Hunter scrapes the public web for email patterns at a given domain and uses
// that to predict the most likely email for a given person. We use it only
// AFTER Reoon has tried our 5 patterns and returned all-unknown — Hunter has
// 25 free lookups/month so we treat it as a precious resource.
//
// Endpoint: GET https://api.hunter.io/v2/email-finder?domain=X&first_name=Y&last_name=Z&api_key=KEY
// Response: { data: { email, score (0-100), sources: [...], ... }, meta: {...} }
//
// Cached for 60 days (longer than Reoon since the result is empirically derived
// from the domain's pattern, which rarely changes).

/**
 * @param {string} domain      e.g. "acme.com"
 * @param {string} firstName
 * @param {string} lastName
 * @returns {Object|null} { email, score (0-100) } or null on failure / no key / no result
 */
function _hunterEmailFinder(domain, firstName, lastName) {
  if (!domain || !firstName || !lastName) return null;

  var props = PropertiesService.getScriptProperties();
  var keyName = (CONFIG.PROPERTY_KEYS && CONFIG.PROPERTY_KEYS.HUNTER_API_KEY) || 'HUNTER_API_KEY';
  var apiKey = props.getProperty(keyName);
  if (!apiKey) {
    Logger.log('[EmailEnricher] Hunter skip: HUNTER_API_KEY not set');
    return null;
  }

  // Cache key: domain + lowercased name (case-insensitive)
  var cachePrefix = (CONFIG.PROPERTY_KEYS && CONFIG.PROPERTY_KEYS.HUNTER_VERIFY_CACHE_PREFIX) || 'HUNTER_FIND_';
  var cacheKey = cachePrefix + domain.toLowerCase() + '|' + firstName.toLowerCase() + '|' + lastName.toLowerCase();

  try {
    var cached = _vendorCacheGet(cacheKey);
    if (cached) {
      var ageDays = (Date.now() - cached.ts) / (1000 * 60 * 60 * 24);
      // 2026-05-11 AUDIT FIX (reviewer finding #5): split TTL by hit/miss.
      // Hunter "null" can mean (a) genuinely no data, or (b) their crawler
      // hasn't indexed this person yet — we used to cache null for 60d which
      // permanently blocked re-query as Hunter's DB grew.
      //   - hit (email returned): 60 days (rarely flips)
      //   - miss (null): 7 days (retry weekly)
      var ttlDays = cached.email ? 60 : 7;
      if (ageDays < ttlDays) {
        Logger.log('[EmailEnricher] Hunter cache hit (' + (cached.email ? 'positive' : 'negative') +
                   ') for ' + firstName + ' ' + lastName + '@' + domain + ' (age ' + ageDays.toFixed(1) + 'd, ttl ' + ttlDays + 'd)');
        return cached.email ? { email: cached.email, score: cached.score, cached: true } : null;
      }
    }
  } catch (_) { /* cache optional */ }

  // ── Live API call ──
  var url = 'https://api.hunter.io/v2/email-finder' +
    '?domain=' + encodeURIComponent(domain) +
    '&first_name=' + encodeURIComponent(firstName) +
    '&last_name=' + encodeURIComponent(lastName) +
    '&api_key=' + encodeURIComponent(apiKey);

  try {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var code = res.getResponseCode();
    if (code === 429) {
      Logger.log('[EmailEnricher] Hunter rate-limited (429) — free tier exhausted this month');
      return null;
    }
    if (code !== 200) {
      Logger.log('[EmailEnricher] Hunter HTTP ' + code + ' for ' + firstName + ' ' + lastName + '@' + domain);
      return null;
    }
    var json = JSON.parse(res.getContentText());
    var email = json.data && json.data.email ? json.data.email : null;
    var score = json.data && typeof json.data.score === 'number' ? json.data.score : 0;

    // Cache result (even null) — null means Hunter doesn't know this person.
    // Hit/miss TTL split preserved at write time (60d hit / 7d miss, 6h cap).
    if (!_vendorCachePut(cacheKey, { email: email, score: score, ts: Date.now() },
                         (email ? 60 : 7) * 86400)) {
      Logger.log('[EmailEnricher] Hunter cache write failed (CacheService put rejected)');
    }

    if (!email || score < 50) {
      Logger.log('[EmailEnricher] Hunter found nothing usable for ' + firstName + ' ' + lastName + '@' + domain + ' (score=' + score + ')');
      return null;
    }

    Logger.log('[EmailEnricher] Hunter found ' + email + ' (score ' + score + ')');
    return { email: email, score: score, cached: false };

  } catch (e) {
    Logger.log('[EmailEnricher] Hunter error: ' + e.message);
    return null;
  }
}

// ─── OPTIONAL: MULTI-TLD DOMAIN PROBE ────────────────────────

/**
 * When a single .com guess fails MX verification, tries a handful of
 * common TLDs and returns the first that has valid MX.
 *
 * Called by enrichEmail() only if the caller explicitly wants a
 * harder search — kept out of the default path to avoid burning
 * DNS lookups on every lead.
 *
 * @param {string} orgName
 * @returns {string} verified domain or ''
 */
function _probeDomainTlds(orgName) {
  // PATCH 2026-05-13: manual override table for high-value brands where the
  // heuristic (organization.toLowerCase() + ".com") is known to be wrong AND
  // none of the external resolvers (Clearbit / DDG / Apollo / GitHub / Gemini)
  // reliably catch them. Add entries here as they surface in production.
  //
  // Key = normalized organization (lowercase, alphanumeric only).
  // Value = the verified corporate domain Reoon/SMTP should accept.
  var override = _resolveManualDomainOverride(orgName);
  if (override) {
    var ovMx = verifyMxRecord(override);
    if (ovMx.hasMx) {
      Logger.log('[EmailEnricher] _probeDomainTlds: manual-override resolved ' +
                 orgName + ' → ' + override);
      return override;
    }
    Logger.log('[EmailEnricher] _probeDomainTlds: manual-override ' + override +
               ' has no MX, falling through to heuristic');
  }

  var base = _organizationToDomain(orgName);
  if (!base) return '';

  // Strip the .com and try common corporate TLDs.
  // PATCH 2026-05-13: expanded TLD list. Added .tech (Nothing, Razorpay, etc),
  // .dev, .xyz, .so, .app — startup-popular endings the old list missed.
  // Order matters: .com first (cheapest hit), then category-popular endings,
  // then long-tail. We stop at the first MX-valid candidate.
  var root = base.replace(/\.com$/, '');
  var tlds = [
    '.com',
    '.io',     '.ai',     '.co',
    '.in',     '.co.in',  '.com.au',
    '.tech',                    // ← Nothing, many consumer-electronics + DTC
    '.dev',                     // ← dev-tools, infra startups
    '.app',                     // ← consumer apps
    '.xyz',                     // ← Web3 / generic
    '.so',                      // ← AI / B2B SaaS
    '.co.uk',                   // ← UK incumbents
    '.org',    '.net'
  ];

  for (var i = 0; i < tlds.length; i++) {
    var candidate = root + tlds[i];
    var mx = verifyMxRecord(candidate);
    if (mx.hasMx) return candidate;
  }
  return '';
}

/**
 * PATCH 2026-05-13: manual-override domain lookup.
 *
 * Consumer-electronics / DTC / unusual-TLD companies that the heuristic
 * "<org>.com" formula gets wrong, AND that the external resolvers either
 * miss entirely or rank below garbage results because the brand name is a
 * common English word ("Nothing", "Notion", "Linear", "Stripe", etc).
 *
 * Keep this list short and high-confidence — anything ambiguous belongs in
 * the resolver cascade, not here. Each entry is a tier-1 outcome.
 *
 * @param {string} orgName  Raw organization string from the lead
 * @returns {string} Verified domain (e.g. "nothing.tech") or ''
 */
function _resolveManualDomainOverride(orgName) {
  if (!orgName) return '';
  var raw = orgName.toString().toLowerCase();

  // PATCH 2026-05-13: try the UN-STRIPPED normalized form first so concatenated
  // brand names like "OpenAI" / "Open AI" → "openai" resolve to openai.com.
  // The suffix-strip path below catches "Nothing Inc" → "nothing" but would
  // incorrectly mangle "Open AI" → "open" (losing the lookup). Trying both
  // shapes catches both cases without conflict.
  var rawNorm = raw.replace(/[^a-z0-9]/g, '');

  // Strip common legal-form suffixes BEFORE normalizing so "Nothing Inc",
  // "Anthropic, Inc.", and "Nothing Limited" all collapse to the same key.
  var stripped = raw;
  var legalSuffixes = [
    'incorporated','inc','llc','ltd','limited','corp','corporation',
    'pvt','private','technologies','technology','company','co',
    'plc','holdings','solutions','services','group','labs','lab','ai'
  ];
  legalSuffixes.forEach(function(suf) {
    stripped = stripped.replace(new RegExp('\\b' + suf + '\\.?\\b', 'g'), ' ');
  });
  var norm = stripped.replace(/[^a-z0-9]/g, '');
  if (!rawNorm && !norm) return '';

  // Curated map. Keys are normalized (lowercase, alphanumeric only).
  // PATCH 2026-05-13: seed entries are the ones we have hit in production.
  // Add more as they surface — each new entry should be MX-verified once
  // manually before being committed here.
  var MANUAL_DOMAIN_OVERRIDES = {
    nothing:       'nothing.tech',     // Carl Pei's consumer electronics co
    oneplus:       'oneplus.com',
    razorpay:      'razorpay.com',
    cred:          'cred.club',
    notion:        'makenotion.com',   // notion.so is the product domain; email is makenotion.com
    linear:        'linear.app',
    figma:         'figma.com',
    superhuman:    'superhuman.com',
    rippling:      'rippling.com',
    cluely:        'cluely.com',
    perplexity:    'perplexity.ai',
    anthropic:     'anthropic.com',
    openai:        'openai.com',
    deepmind:      'deepmind.com',
    midjourney:    'midjourney.com',
    runwayml:      'runwayml.com',
    huggingface:   'huggingface.co',
    replicate:     'replicate.com',
    cohere:        'cohere.com',
    scaleai:       'scale.com',
    pikalabs:      'pika.art',
    krutrim:       'olakrutrim.com',
    sarvam:        'sarvam.ai',
    sarvamai:      'sarvam.ai',
    fractal:       'fractal.ai'
  };

  // Prefer the un-stripped lookup (handles "OpenAI" / "Open AI" → openai)
  // then fall back to the suffix-stripped form (handles "Nothing Inc" → nothing)
  return MANUAL_DOMAIN_OVERRIDES[rawNorm] || MANUAL_DOMAIN_OVERRIDES[norm] || '';
}

// ─── GEMINI EMAIL INTELLIGENCE — Path 2.5 in enrichEmail ──────────────────
//
// When the naive `<org>.com` + TLD probe both fail, ask Gemini 2.5 Flash to
// resolve the actual corporate email domain + generate likely email patterns
// based on its training knowledge of real-world companies.
//
// Strict-JSON response via responseSchema (R2 finding: this guarantees shape
// + null handling; mixing tools with responseSchema is broken — we don't).
//
// Cached per (org|firstName|lastName) tuple for 30 days. Gemini is ~$0.0001
// per call on 2.5-flash, but cache still saves measurable spend over months.
//
// @param {string} firstName
// @param {string} lastName
// @param {string} organization
// @returns {Object|null} { domain: 'pronto.io', candidates: ['abhay@pronto.io', ...] }
//   or null when Gemini unavailable / response unusable.
function _geminiEmailIntelligence(firstName, lastName, organization) {
  if (!organization || !(firstName || lastName)) return null;

  // Cache key — Gemini's answer won't change quickly for the same (name, org)
  var cacheKey = 'GEMINI_EMAIL_' + organization.toLowerCase().replace(/[^a-z0-9]/g, '') +
                 '_' + (firstName || '').toLowerCase() + '_' + (lastName || '').toLowerCase();
  var cachedIntel = _vendorCacheGet(cacheKey);
  if (cachedIntel && cachedIntel.ts && (Date.now() - cachedIntel.ts) < 30 * 24 * 3600 * 1000) {
    Logger.log('[EmailEnricher] Gemini cache hit for ' + cacheKey);
    return cachedIntel.data;
  }

  var prompt = [
    'Task: find the corporate email domain + likely email addresses for one person.',
    '',
    'Person: ' + (firstName || '') + ' ' + (lastName || ''),
    'Company: ' + organization,
    '',
    'Step 1: identify the company\'s real corporate email domain (the one their employees actually use).',
    'Step 2: produce 5 likely email addresses for this person at that domain, ordered by most-to-least likely based on common corporate naming conventions (firstname.lastname > flastname > firstname > firstinitial.lastname > firstname_lastname).',
    '',
    'Output strict JSON only. No prose, no markdown. If you do not know the domain, set domain to null and candidates to an empty array.'
  ].join('\n');

  var schema = {
    type: 'OBJECT',
    properties: {
      domain:     { type: 'STRING', nullable: true, description: 'Corporate email domain, e.g. "stripe.com"' },
      candidates: {
        type: 'ARRAY',
        items: { type: 'STRING' },
        description: 'Up to 5 candidate email addresses ranked most-to-least likely'
      },
      confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] }
    },
    required: ['domain', 'candidates', 'confidence']
  };

  // Use the existing callGemini() in ApiClients.gs (consistent with rest of codebase)
  var resp;
  try {
    resp = callGemini(prompt, {
      temperature: 0.0,
      maxTokens: 400,
      responseFormat: 'json',
      responseSchema: schema,
      systemPrompt: 'You are a corporate email intelligence engine. Output strict JSON only.'
    });
  } catch (e) {
    Logger.log('[EmailEnricher] Gemini call threw: ' + e.message);
    return null;
  }

  if (!resp || !resp.success) {
    Logger.log('[EmailEnricher] Gemini email intel failed: ' + (resp && resp.error));
    return null;
  }

  // resp.data may be the parsed JSON object (responseFormat='json' path)
  var data = resp.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (_) { data = null; }
  }
  if (!data || typeof data !== 'object') {
    Logger.log('[EmailEnricher] Gemini email intel returned non-object: ' + JSON.stringify(resp).substring(0, 200));
    return null;
  }

  // Sanity: domain must look like a domain
  if (data.domain && !/^[a-z0-9][a-z0-9.\-]*\.[a-z]{2,}$/i.test(data.domain.toString())) {
    Logger.log('[EmailEnricher] Gemini returned invalid domain shape: ' + data.domain);
    data.domain = null;
  }

  // Candidates: must all have @, must end in the resolved domain (or be plausible)
  if (Array.isArray(data.candidates)) {
    data.candidates = data.candidates
      .filter(function(c) { return c && typeof c === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c); })
      .map(function(c) { return c.toString().toLowerCase().trim(); })
      .slice(0, 5);
  } else {
    data.candidates = [];
  }

  Logger.log('[EmailEnricher] Gemini email intel for ' + organization + ': domain=' +
    data.domain + ', candidates=' + data.candidates.join(','));

  // Cache for 30 days (logical TTL; CacheService caps at 6h)
  _vendorCachePut(cacheKey, { ts: Date.now(), data: data }, 30 * 86400);

  return data;
}

// ─── Tier-3 catch-all resolver: Findymail (Patch 2026-05-11) ────────────────
//
// Calls Findymail's /api/verify endpoint to resolve catch-all addresses that
// Reoon legitimately can't determine (enterprise mail servers that accept any
// recipient at SMTP). Response is a binary verified:true/false — no separate
// catch-all sub-field exists in Findymail's API (their proprietary engine
// resolves the catch-all problem into a definitive verdict).
//
// API spec (from researcher agent):
//   POST https://app.findymail.com/api/verify
//   Authorization: Bearer <key>
//   Content-Type: application/json
//   Body:    { "email": "vidhi.shah@hotstar.com" }
//   200 OK:  { "email": "...", "verified": true|false, "provider": "Google" }
//   402:     out of verifier credits → fall through
//   429:     rate limited → 1 retry with backoff
//   401/422: credential/format error → caller logs + skips
//
// Cost: 1 verifier credit per 200 response. Free tier ~10 credits (trial).
//
// Per-email + per-domain cache: catch-all status of a server doesn't change
// frequently. Cache positive (verified=true) for 14 days, negative for 7 days.

function _findymailVerify(email, apiKey) {
  if (!email || !apiKey) return null;

  // Cache lookup
  var cacheKey = 'FINDYMAIL_' + email.toLowerCase().replace(/[^\w@.]/g, '_').substring(0, 250);
  var hit = _vendorCacheGet(cacheKey);
  if (hit) {
    var ttlMs = hit.verified === true ? 14 * 86400000 : 7 * 86400000;
    if (Date.now() - hit.ts < ttlMs) {
      Logger.log('[Findymail] cache hit ' + email + ' → verified=' + hit.verified);
      return { email: email, verified: hit.verified, provider: hit.provider || '' };
    }
  }

  var url = 'https://app.findymail.com/api/verify';
  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + apiKey },
    payload: JSON.stringify({ email: email }),
    muteHttpExceptions: true
  };
  try {
    var resp = UrlFetchApp.fetch(url, options);
    var code = resp.getResponseCode();
    var body = JSON.parse(resp.getContentText() || '{}');
    if (code === 200) {
      _vendorCachePut(cacheKey, {
        ts: Date.now(), verified: body.verified, provider: body.provider || ''
      }, (body.verified === true ? 14 : 7) * 86400);
      return body;
    }
    if (code === 429) {
      Utilities.sleep(2000);
      var resp2 = UrlFetchApp.fetch(url, options);
      if (resp2.getResponseCode() === 200) return JSON.parse(resp2.getContentText() || '{}');
    }
    Logger.log('[Findymail] HTTP ' + code + ' for ' + email + ': ' + JSON.stringify(body));
    return null;
  } catch (err) {
    Logger.log('[Findymail] fetch error: ' + err.message);
    return null;
  }
}

// ─── Bounce feedback penalty lookup (Patch 2026-05-11) ──────────────────────
//
// Reads `bouncedDomains` script property (populated by BounceProcessor.gs)
// and returns a confidence penalty in 0.0-0.20 for a domain. Penalty is
// proportional to hard-bounce count, capped so a single bounce doesn't
// blacklist a whole domain (mailbox could be just one bad mailbox).

function _getDomainBouncePenalty(domain) {
  if (!domain) return 0;
  var dl = domain.toLowerCase();
  // PATCH 2026-05-12: prefer BouncedDomains sheet (no 9KB cap), fall back to
  // legacy script property for back-compat / sheet-unavailable cases.
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName('BouncedDomains');
    if (sheet && sheet.getLastRow() >= 2) {
      var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
      for (var i = 0; i < data.length; i++) {
        if ((data[i][0] || '').toString().toLowerCase() === dl) {
          var hard = parseInt(data[i][1]) || 0;
          if (hard <= 0) return 0;
          return Math.min(0.20, hard * 0.05);
        }
      }
    }
  } catch (e) {
    Logger.log('[BounceFeedback] sheet lookup error: ' + e.message);
  }
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('bouncedDomains');
    if (!raw) return 0;
    var map = JSON.parse(raw);
    var entry = map[dl];
    if (!entry) return 0;
    var h = entry.hard || 0;
    return h > 0 ? Math.min(0.20, h * 0.05) : 0;
  } catch (e2) {
    Logger.log('[BounceFeedback] property fallback error: ' + e2.message);
    return 0;
  }
}

// ─── SNOV.IO EMAIL FINDER HELPER ─────────────────────────────────────────────
//
// Calls Snov.io's email-finder endpoint for a given first name, last name, and
// domain. Returns the best email string if one is found, or null otherwise.
// Credentials are read from SNOV_API_USER_ID / SNOV_API_SECRET (preferred) or
// the alternate SNOV_CLIENT_ID / SNOV_CLIENT_SECRET keys set by SetupOneShot.
// Token acquisition is delegated to _snovGetToken() in EnrichmentSources.gs.
// Results are cached for 30 days per (first+last+domain) tuple.

function _callSnov(firstName, lastName, domain) {
  if (!firstName || !lastName || !domain) return null;
  var props = PropertiesService.getScriptProperties();

  // Require credentials to exist before attempting token fetch
  var userId = props.getProperty('SNOV_API_USER_ID') || props.getProperty('SNOV_CLIENT_ID');
  var secret = props.getProperty('SNOV_API_SECRET') || props.getProperty('SNOV_CLIENT_SECRET');
  if (!userId || !secret) return null;

  var cacheKey = 'SNOV_EF_' + domain.toLowerCase() + '|' + firstName.toLowerCase() + '|' + lastName.toLowerCase();
  var cachedSnov = _vendorCacheGet(cacheKey);
  if (cachedSnov) {
    var ageDays = (Date.now() - cachedSnov.ts) / 86400000;
    var ttlDays = cachedSnov.email ? 30 : 7;
    if (ageDays < ttlDays) {
      Logger.log('[Snov] cache hit for ' + firstName + ' ' + lastName + '@' + domain +
                 ' → ' + (cachedSnov.email || 'null'));
      return cachedSnov.email || null;
    }
  }

  // Get OAuth token via shared helper in EnrichmentSources.gs
  var token = (typeof _snovGetToken === 'function') ? _snovGetToken() : null;
  if (!token) return null;

  try {
    // Snov v2 email-finder: POST with JSON body
    var url = 'https://api.snov.io/v2/email-finder';
    var payload = JSON.stringify({ domain: domain, firstName: firstName, lastName: lastName });
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + token },
      payload: payload,
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      Logger.log('[Snov] email-finder HTTP ' + res.getResponseCode() + ' for ' +
                 firstName + ' ' + lastName + '@' + domain);
      return null;
    }
    var json = JSON.parse(res.getContentText());
    // Snov returns: { data: { emails: [{ email, confidence }] } } or similar
    var emails = (json.data && json.data.emails) || json.emails || [];
    var best = null;
    for (var i = 0; i < emails.length; i++) {
      var e = emails[i];
      var addr = (e.email || e.address || '').toString().trim().toLowerCase();
      if (_isValidEmail(addr)) { best = addr; break; }
    }
    _vendorCachePut(cacheKey, { email: best, ts: Date.now() }, (best ? 30 : 7) * 86400);
    Logger.log('[Snov] email-finder result for ' + firstName + ' ' + lastName + '@' + domain +
               ': ' + (best || 'none'));
    return best;
  } catch (e) {
    Logger.log('[Snov] email-finder error: ' + e.message);
    return null;
  }
}

/**
 * Minimal email format check used internally when a found email needs quick
 * validation before being returned to the caller.
 */
function _isValidEmail(addr) {
  if (!addr) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr.toString().trim());
}

/**
 * PATCH 2026-05-12: Combine scraped name with URL slug to recover truncated
 * LinkedIn display names ("Aditi B" + "aditibiswas1" → "Aditi Biswas").
 *
 * Returns { firstName, lastName } if a better decomposition was found, or
 * null otherwise. Conservative: only combines when the slug genuinely extends
 * the scraped first name with alphabetic-only remainder.
 *
 * Test cases (mental):
 *   ("Aditi","B","/in/aditibiswas1")  → {Aditi, Biswas}
 *   ("John","D","/in/johndoe")         → {John, Doe}
 *   ("","","/in/sarahsmith")            → null (no firstName to anchor)
 *   ("Sarah","","/in/sarahsmith")      → {Sarah, Smith}
 *   ("John","Doe","/in/johndoe123")    → not invoked (lastName.length >= 3)
 *   ("Yogja","S","/in/yogja-singh-0ab1915") → {Yogja, Singh} (hyphenated path)
 *   ("Anne","B","/in/maryjones")       → null (slug doesn't start with firstName)
 */
function _emCombineNameWithSlug(firstName, lastName, linkedinUrl) {
  if (!linkedinUrl) return null;
  try {
    var url = linkedinUrl.toString();
    var inIdx = url.indexOf('/in/');
    if (inIdx < 0) return null;
    var start = inIdx + 4;
    var endIdx = url.indexOf('/', start);
    var slug = endIdx > start ? url.substring(start, endIdx) : url.substring(start);
    var q = slug.indexOf('?'); if (q >= 0) slug = slug.substring(0, q);
    var h = slug.indexOf('#'); if (h >= 0) slug = slug.substring(0, h);
    slug = slug.replace(/-\d+$/, '').trim();
    if (!slug) return null;

    // Hyphenated path: split on hyphen, drop hash-shaped/pure-numeric segments
    if (slug.indexOf('-') >= 0) {
      var parts = slug.split('-').filter(function(p) {
        if (!p) return false;
        if (/^\d+$/.test(p)) return false;
        if (p.length >= 6 && /\d/.test(p) && !/[aeiou]/i.test(p)) return false;
        return true;
      });
      if (parts.length >= 2) {
        return {
          firstName: _emTitleCase(parts[0]),
          lastName: _emTitleCase(parts[parts.length - 1])
        };
      }
      return null;
    }

    // Concatenated path: slug = "firstlast" or "firstlast<id>"
    slug = slug.replace(/\d+$/, '').toLowerCase();
    if (!slug) return null;
    var f = (firstName || '').toString().trim();
    if (!f) return null;
    var fLower = f.toLowerCase();
    if (!slug.startsWith(fLower)) return null;
    var remainder = slug.substring(fLower.length);
    if (remainder.length < 3) return null;
    if (!/^[a-z]+$/.test(remainder)) return null;
    return {
      firstName: _emTitleCase(f),
      lastName: _emTitleCase(remainder)
    };
  } catch (e) {
    Logger.log('[EmailEnricher] _emCombineNameWithSlug error: ' + e.message);
    return null;
  }
}

function _emTitleCase(s) {
  if (!s) return '';
  s = s.toString();
  return s.charAt(0).toUpperCase() + s.substring(1).toLowerCase();
}

/**
 * PATCH 2026-05-12: Canonicalize a LinkedIn URL for API lookups. Strips
 * utm_* / tracking query params, fragments, trailing slash. Without this,
 * Apollo /people/match silently returns null for URLs shared via the
 * Android LinkedIn app (which appends utm_source=share_via etc.).
 */
function _normalizeLinkedInUrl(url) {
  if (!url) return '';
  var s = url.toString().trim();
  if (!s) return s;
  var q = s.indexOf('?');
  if (q >= 0) s = s.substring(0, q);
  var h = s.indexOf('#');
  if (h >= 0) s = s.substring(0, h);
  while (s.length > 0 && s.charAt(s.length - 1) === '/') s = s.substring(0, s.length - 1);
  return s;
}
