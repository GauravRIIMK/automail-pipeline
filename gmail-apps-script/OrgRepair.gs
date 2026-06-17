/**
 * ============================================================
 * OrgRepair.gs - Defense against title-noise in ORGANIZATION column
 * (Patch 2026-05-19 — Ranjan/HSBC RCA)
 * ============================================================
 *
 * Recurring failure mode: the LinkedIn-extension / APK share path writes
 * a TITLE FRAGMENT into the ORGANIZATION column instead of a company name.
 *
 * Example (Ranjan Bhattacharya, HSBC):
 *   FULL_NAME       = "Ranjan Bhattacharya"
 *   LINKEDIN_URL    = "linkedin.com/in/ranjanbhattacharya-hsbc"
 *   DESIGNATION     = "Managing Director - Head of Strategy for Middle East and India"
 *   ORGANIZATION    = "Chief of Staff - India"            ← TITLE NOISE, not a company
 *   STATUS          = (blank)
 *
 * Downstream consequence:
 *   - enrichEmail tries to resolve "Chief of Staff - India" as a company
 *   - Apollo /organizations/search returns nothing usable
 *   - Pattern guessing has no domain to anchor on → all_patterns_undeliverable
 *   - Row lands at NEEDS_EMAIL forever
 *
 * Fix strategy (defense in depth, three paths):
 *   1. Heuristically detect title-noise in the ORGANIZATION value
 *   2. If detected, extract the URL fragment hint (e.g., "-hsbc" → "hsbc")
 *      and resolve via Apollo /organizations/search
 *   3. If hint resolution fails, fall back to Apollo /people/match by
 *      LinkedIn URL directly (paid plan, but already in this pipeline)
 *   4. Persist the repaired ORGANIZATION back to the sheet so subsequent
 *      runs see the corrected value
 *
 * Hook point: called from BatchProcessor._processSingleRow() BEFORE
 * enrichEmail() so the cascade gets the right org from the start.
 */

// ─── 1. TITLE-NOISE DETECTOR ───────────────────────────────────────

/**
 * Heuristic: does the ORGANIZATION column hold a title fragment instead of
 * a company name?
 *
 * Logic:
 *   - Real-company markers (Inc/Ltd/LLC/Technologies/…) → NOT noise
 *   - Title-start patterns (Chief of Staff/Head of/VP/Managing Director/…)
 *     with NO company marker → IS noise
 *   - " - <Region>" suffix with no company brand → IS noise
 *
 * Empty values are NOT classified as noise — the existing pipeline already
 * handles the no-org case via Apollo /people/match backfill.
 *
 * @param {string} orgValue
 * @returns {boolean}
 */
function _isOrgFieldTitleNoise(orgValue) {
  if (!orgValue) return false;
  var v = orgValue.toString().trim();
  if (v.length < 2) return true;

  // Strong negative signal — recognized company markers
  var companyMarkers = /\b(inc|corp|corporation|llc|ltd|limited|gmbh|llp|plc|nv|sa|ag|kg|kk|pty|technologies|labs|systems|group|holdings|partners|capital|ventures|industries|enterprises|solutions|services|consulting|associates|media|networks|software|digital|bank|financial|fintech|insurance|university|institute|college)\b/i;
  if (companyMarkers.test(v)) return false;

  // Strong negative signal — known mega-brands (one-token, no suffix)
  var megaBrandList = /^(amazon|google|microsoft|meta|apple|nvidia|tesla|netflix|uber|stripe|shopify|salesforce|oracle|sap|adobe|atlassian|figma|notion|slack|zoom|hubspot|asana|databricks|snowflake|openai|anthropic|spacex|airbnb|doordash|instacart|coinbase|robinhood|paypal|visa|mastercard|hsbc|jpmorgan|citi|barclays|deutsche|goldman|morgan|reliance|tata|wipro|infosys|tcs|hcl|paytm|phonepe|flipkart|myntra|zepto|blinkit|swiggy|zomato|ola|byju|unacademy|upgrad|nykaa|cred|razorpay)$/i;
  if (megaBrandList.test(v.toLowerCase())) return false;

  // Positive signal — starts with a pure-title fragment
  var titleStartPatterns = [
    /^chief\s+of\s+staff/i,
    /^chief\s+\w+(\s+\w+)?\s+officer/i,
    /^head\s+of\s+/i,
    /^vp\s+/i,
    /^vice\s+president/i,
    /^managing\s+director/i,
    /^managing\s+partner/i,
    /^director\b/i,
    /^senior\s+(director|manager|vp|lead|principal|partner)/i,
    /^founder\b/i,
    /^co-?founder\b/i,
    /^ceo\b|^cfo\b|^coo\b|^cto\b|^cmo\b|^cpo\b|^chro\b|^cio\b/i,
    /^president\b/i,
    /^chairman\b|^chairperson\b|^chairwoman\b/i
  ];
  for (var i = 0; i < titleStartPatterns.length; i++) {
    if (titleStartPatterns[i].test(v)) return true;
  }

  // Positive signal — " - <Region>" tail with no company brand
  if (/\s+-\s+(india|middle\s+east|apac|emea|us|usa|uk|europe|asia|americas|global|north\s+america|south\s+america|latam|mena|anz|sea|china|japan)$/i.test(v)) {
    return true;
  }

  return false;
}

// ─── 2. URL-FRAGMENT HINT EXTRACTOR ─────────────────────────────────

/**
 * Extract the trailing company-hint segment from a LinkedIn URL slug.
 *
 *   linkedin.com/in/ranjanbhattacharya-hsbc           → "hsbc"
 *   linkedin.com/in/john-doe-google                   → "google"
 *   linkedin.com/in/john-doe-12345                    → "" (numeric)
 *   linkedin.com/in/john-doe                          → "" (no hint segment)
 *   linkedin.com/in/john-doe-mba                      → "" (degree, not company)
 *   linkedin.com/in/jane-smith-a1b2c3d4               → "" (LinkedIn hash)
 *
 * The function deliberately rejects ambiguous/false-positive segments —
 * a wrong hint produces a wrong company, which is worse than no hint.
 *
 * @param {string} linkedinUrl
 * @returns {string} Lowercase hint or empty string
 */
// PATCH P1-RATIFY: promoted from local var to module-level so it's also
// reachable by the multi-token-bschool check below (e.g., 'iim'+'k'='iimk').
var NON_COMPANY_HINTS = {
  // Degrees / certifications
  'mba': 1, 'mbb': 1, 'phd': 1, 'md': 1, 'msc': 1, 'mtech': 1, 'btech': 1,
  'be': 1, 'ms': 1, 'ma': 1, 'ba': 1, 'pmp': 1, 'cfa': 1, 'cpa': 1, 'fca': 1,
  'cisa': 1, 'cissp': 1, 'pmi': 1, 'scrum': 1, 'agile': 1,
  // Titles
  'ceo': 1, 'cto': 1, 'cfo': 1, 'coo': 1, 'cmo': 1, 'chro': 1, 'cio': 1, 'cpo': 1,
  // Generational / nominal suffixes
  'jr': 1, 'sr': 1, 'ii': 1, 'iii': 1, 'iv': 1, 'v': 1,
  // Generic English
  'official': 1, 'real': 1, 'the': 1, 'a': 1, 'an': 1, 'in': 1, 'at': 1, 'of': 1,
  // Indian B-schools (IIMs, IITs, ISB and variants)
  'iim': 1, 'iima': 1, 'iimb': 1, 'iimc': 1, 'iiml': 1, 'iimk': 1, 'iimi': 1,
  'iimudaipur': 1, 'iimt': 1, 'iimr': 1, 'iimv': 1,
  'iit': 1, 'iitb': 1, 'iitd': 1, 'iitk': 1, 'iitm': 1, 'iitkgp': 1, 'iitr': 1,
  'iitg': 1, 'iitbhu': 1, 'iitp': 1, 'iith': 1,
  'isb': 1, 'mdi': 1, 'xlri': 1, 'fms': 1, 'sjmsom': 1, 'iift': 1, 'spjimr': 1,
  // International B-schools
  'harvard': 1, 'hbs': 1, 'stanford': 1, 'wharton': 1, 'insead': 1, 'lbs': 1,
  'kellogg': 1, 'mit': 1, 'cmu': 1, 'columbia': 1,
  // Ambiguous brand-or-credential
  'sap': 1
};

function _extractOrgHintFromLinkedInUrl(linkedinUrl) {
  if (!linkedinUrl) return '';
  var m = linkedinUrl.toString().match(/linkedin\.com\/in\/([^\/?#]+)/i);
  if (!m) return '';
  var slug = m[1].toLowerCase();

  // ──────────────────────────────────────────────────────────────────────
  // PATCH P1-RATIFY (Phase 1 ratification — Type A real-bug fix):
  //
  // The Phase-1 smoke test caught a defect in this function that has been
  // silently starving OrgRepair Path A (URL fragment → Apollo /organizations
  // /search) for every LinkedIn URL of the pattern
  // `concatenatedfirstnamelastname-company` (e.g. `ranjanbhattacharya-hsbc`).
  // The docstring on line 101 promises `ranjanbhattacharya-hsbc → "hsbc"`
  // but the prior implementation rejected all 2-part slugs unconditionally
  // because of an over-conservative `parts.length < 3` gate.
  //
  // Three improvements land here under stamp `-p1-ratify`:
  //
  //   1. Trailing pure-numeric IDs of ANY length are now stripped before
  //      splitting (was only 6+ hex chars). Catches `-hsbc-12345` →
  //      strip `-12345` → continue with `-hsbc`.
  //
  //   2. Two-part slugs ("name-hint") are accepted IFF the first part is
  //      ≥ 8 chars (suggests `firstname+lastname` run together as
  //      "ranjanbhattacharya"). Slugs like `john-doe` where both parts
  //      look like names still return empty.
  //
  //   3. Multi-token suffix merge: if the last part is a single letter AND
  //      `parts[N-2] + parts[N-1]` matches the blocklist (e.g. `iim` + `k`
  //      → `iimk`), reject. Locks the `firstname-lastname-iim-k` policy
  //      from Section 2.2 of the ratification prompt.
  // ──────────────────────────────────────────────────────────────────────

  // 1a. Strip trailing LinkedIn hash IDs (hex-only, 6+ chars).
  slug = slug.replace(/-[a-f0-9]{6,}(?:-[a-f0-9]+)*$/i, '');
  // 1b. NEW: Strip trailing pure-numeric suffix of any length.
  //     (Real LinkedIn handles often end in numeric disambiguators.)
  slug = slug.replace(/-\d+$/, '');

  var parts = slug.split('-').filter(function(p) { return p.length > 0; });
  if (parts.length < 2) return '';  // need at minimum name + hint

  var hint = parts[parts.length - 1];

  // 3. Multi-token bschool/credential merge:
  //    parts = [..., 'iim', 'k']  → combined = 'iimk' → in blocklist → reject.
  //    Only fires when last part is a single letter (B-school campus letters
  //    are typically 1 char: a, b, c, k, l, etc.).
  if (parts.length >= 3 && hint.length === 1) {
    var combined = parts[parts.length - 2] + hint;
    if (NON_COMPANY_HINTS[combined]) {
      return '';
    }
  }

  if (!hint || hint.length < 2) return '';
  if (/^\d+$/.test(hint)) return '';
  if (NON_COMPANY_HINTS[hint]) return '';

  // 2. Two-part slug heuristic:
  //    `ranjanbhattacharya-hsbc` (parts[0] = 18 chars) → ACCEPT "hsbc"
  //    `john-doe`               (parts[0] = 4 chars)  → REJECT (both look like names)
  //    `priya-chawla`           (parts[0] = 5 chars)  → REJECT (post-hash-strip
  //                                                              of `priya-chawla-60a44a20`)
  if (parts.length === 2 && parts[0].length < 8) {
    return '';
  }

  return hint;
}

// ─── 3. ORG REPAIR ORCHESTRATION ────────────────────────────────────

/**
 * Pre-enrichment org repair. When the ORGANIZATION column holds title-noise,
 * tries to recover the real company via:
 *   (A) LinkedIn URL fragment hint → Apollo /organizations/search
 *   (B) Apollo /people/match by LinkedIn URL directly (paid plan)
 *
 * Mutates lead in place. Persists the repaired org back to the sheet via
 * the URL-keyed _uf wrapper so subsequent runs read the corrected value.
 *
 * Idempotent: if org is not noisy, returns {repaired:false, reason:'not_noisy'}.
 * Safe to call on every lead at the start of _processSingleRow.
 *
 * @param {Object} lead - LeadProfile (mutated)
 * @returns {Object} {repaired, oldOrg, newOrg, source, hint, reason}
 */
function repairLeadOrgIfTitleNoise(lead) {
  if (!lead) return { repaired: false, reason: 'no_lead' };
  if (!lead.linkedinUrl) return { repaired: false, reason: 'no_url' };
  if (!_isOrgFieldTitleNoise(lead.organization)) {
    return { repaired: false, reason: 'org_not_noisy', org: lead.organization };
  }

  var oldOrg = lead.organization;
  Logger.log('[OrgRepair] Row ' + lead.rowNum + ': "' + oldOrg +
             '" detected as title-noise. Trying recovery (URL=' + lead.linkedinUrl + ')');

  // ── Path A: URL fragment hint → Apollo /organizations/search ──
  var hint = _extractOrgHintFromLinkedInUrl(lead.linkedinUrl);
  if (hint && typeof resolveDomainApolloOrgs === 'function') {
    try {
      var apolloOrgs = resolveDomainApolloOrgs(hint, {
        linkedinUrl: lead.linkedinUrl,
        headline: lead.headline || '',
        designation: lead.designation || ''
      });
      // resolveDomainApolloOrgs returns either a single object {name, domain, ...}
      // or an array of candidates depending on internal logic. Accept both.
      var picked = null;
      if (apolloOrgs && apolloOrgs.name && apolloOrgs.domain) {
        picked = apolloOrgs;
      } else if (Array.isArray(apolloOrgs) && apolloOrgs.length > 0
                 && apolloOrgs[0].name && apolloOrgs[0].domain) {
        picked = apolloOrgs[0];
      }
      if (picked) {
        lead.organization = picked.name;
        if (picked.domain) lead.orgDomain = picked.domain;
        try {
          if (typeof _uf === 'function') {
            _uf(lead, {
              ORGANIZATION: picked.name,
              NOTES: 'OrgRepair (pre-enrich): "' + oldOrg + '" was title-noise. ' +
                     'URL hint "' + hint + '" -> Apollo resolved to "' + picked.name +
                     '" (' + picked.domain + ').'
            });
          }
        } catch (writeErr) {
          Logger.log('[OrgRepair] write failed: ' + writeErr.message);
        }
        Logger.log('[OrgRepair] Row ' + lead.rowNum + ': "' + oldOrg + '" -> "' +
                   picked.name + '" via URL hint "' + hint + '" (Path A)');
        return {
          repaired: true,
          source: 'url_hint_apollo_orgs',
          oldOrg: oldOrg,
          newOrg: picked.name,
          domain: picked.domain,
          hint: hint
        };
      }
    } catch (e) {
      Logger.log('[OrgRepair] Path A (Apollo orgs) threw: ' + e.message);
    }
  }

  // ── Path B: Apollo /people/match by LinkedIn URL (authoritative) ──
  if (typeof resolveLeadApolloMatch === 'function') {
    try {
      var apolloPerson = resolveLeadApolloMatch(lead.linkedinUrl);
      if (apolloPerson && apolloPerson.organizationName && apolloPerson.organizationName.length > 1) {
        lead.organization = apolloPerson.organizationName;
        if (apolloPerson.domain) lead.orgDomain = apolloPerson.domain;
        if (apolloPerson.title && !lead.designation) lead.designation = apolloPerson.title;
        try {
          if (typeof _uf === 'function') {
            _uf(lead, {
              ORGANIZATION: apolloPerson.organizationName,
              NOTES: 'OrgRepair (pre-enrich): "' + oldOrg + '" was title-noise. ' +
                     'Apollo /people/match by LinkedIn URL -> "' + apolloPerson.organizationName +
                     '" (' + (apolloPerson.domain || 'no domain') + ').'
            });
          }
        } catch (writeErr) {
          Logger.log('[OrgRepair] write failed: ' + writeErr.message);
        }
        Logger.log('[OrgRepair] Row ' + lead.rowNum + ': "' + oldOrg + '" -> "' +
                   apolloPerson.organizationName + '" via Apollo people-match (Path B)');
        return {
          repaired: true,
          source: 'apollo_people_match',
          oldOrg: oldOrg,
          newOrg: apolloPerson.organizationName,
          domain: apolloPerson.domain || ''
        };
      }
    } catch (e) {
      Logger.log('[OrgRepair] Path B (Apollo people-match) threw: ' + e.message);
    }
  }

  Logger.log('[OrgRepair] Row ' + lead.rowNum + ': all paths failed, keeping "' + oldOrg + '"');
  return {
    repaired: false,
    reason: 'all_paths_failed',
    oldOrg: oldOrg,
    hint: hint
  };
}

// ─── 4. DIAGNOSTIC HELPER ────────────────────────────────────────────

/**
 * Read-only diagnostic. Returns the title-noise verdict + the hint that
 * would be extracted, without making any API calls or sheet writes.
 *
 * @param {Object} lead - LeadProfile
 * @returns {Object} {isNoisy, hint, would_attempt_paths}
 */
function diagnoseOrgRepair(lead) {
  if (!lead) return { isNoisy: false, reason: 'no_lead' };
  var isNoisy = _isOrgFieldTitleNoise(lead.organization);
  var hint = _extractOrgHintFromLinkedInUrl(lead.linkedinUrl);
  return {
    rowNum: lead.rowNum,
    fullName: lead.fullName,
    linkedinUrl: lead.linkedinUrl,
    currentOrg: lead.organization,
    isNoisy: isNoisy,
    extractedHint: hint,
    wouldAttemptPaths: isNoisy
      ? (hint ? ['url_hint_apollo_orgs', 'apollo_people_match'] : ['apollo_people_match'])
      : []
  };
}
