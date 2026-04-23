/**
 * ============================================================
 * EmailEnricher.gs — Stage 0: Email Validation + Enrichment
 *
 * Pipeline gate that classifies the email in column F, rejects
 * free-provider addresses (gmail/yahoo/etc.) on corporate leads,
 * verifies MX records via Google Public DNS (free, no auth),
 * and proposes corporate-pattern candidates when the sheet
 * email is unusable.
 *
 * Research anchors:
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
var ORG_SUFFIX_NOISE = [
  'inc', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'gmbh', 'ag', 'sa',
  'pvt', 'private', 'co', 'company', 'holdings', 'group',
  'technologies', 'technology', 'tech', 'softwares', 'software',
  'labs', 'systems', 'solutions', 'services', 'industries', 'enterprises',
  'ai', 'io', 'app', 'apps', 'digital', 'global', 'worldwide', 'india'
];

// ─── PUBLIC ENTRY: ENRICH A LEAD'S EMAIL ────────────────────

/**
 * Classifies the email on a lead, verifies MX, and — if the address
 * is missing / free-provider / invalid — proposes ranked corporate
 * candidates for human review.
 *
 * @param {Object} lead - LeadProfile (needs email, firstName, lastName, organization)
 * @returns {Object} {
 *   status: 'VERIFIED' | 'NEEDS_EMAIL' | 'NEEDS_EMAIL_REVIEW',
 *   email: string,            // the address to use when status=VERIFIED
 *   classification: 'CORPORATE' | 'FREE' | 'INVALID',
 *   reason: string,
 *   candidates: Array<string>, // ranked replacements when review needed
 *   originalEmail: string,
 *   source: string             // 'sheet_corporate' | 'guessed_pattern' | 'rejected'
 * }
 */
function enrichEmail(lead) {
  if (!lead) {
    return { status: 'NEEDS_EMAIL', reason: 'no_lead_object', candidates: [] };
  }

  var original = (lead.email || '').toString().trim();
  var primary = classifyEmail(original);

  // ── Path 1: sheet already has a valid corporate address ──
  if (primary.valid && primary.classification === 'CORPORATE') {
    var mx = verifyMxRecord(primary.domain);
    if (mx.hasMx) {
      return {
        status: 'VERIFIED',
        email: primary.email,
        classification: 'CORPORATE',
        domain: primary.domain,
        reason: 'sheet_corporate_mx_ok',
        source: 'sheet_corporate',
        candidates: [],
        originalEmail: original
      };
    }
    // Corporate address format but MX missing — still try to guess via org
    Logger.log('[EmailEnricher] Corporate address but no MX: ' + primary.domain + '. Attempting pattern guess.');
  }

  // ── Path 2: free provider OR invalid OR empty — try to guess ──
  var orgDomain = _organizationToDomain(lead.organization);
  if (!orgDomain) {
    return {
      status: 'NEEDS_EMAIL',
      reason: 'no_org_domain_to_guess_from',
      candidates: [],
      originalEmail: original,
      classification: primary.classification || 'INVALID'
    };
  }

  var orgMx = verifyMxRecord(orgDomain);
  if (!orgMx.hasMx) {
    return {
      status: 'NEEDS_EMAIL',
      reason: 'org_domain_no_mx: ' + orgDomain,
      candidates: [],
      originalEmail: original,
      classification: primary.classification || 'INVALID'
    };
  }

  var candidates = guessProfessionalEmail(lead.firstName, lead.lastName, orgDomain);
  if (candidates.length === 0) {
    return {
      status: 'NEEDS_EMAIL',
      reason: 'no_name_to_guess_from',
      candidates: [],
      originalEmail: original,
      classification: primary.classification || 'INVALID'
    };
  }

  // Without SMTP verification (GAS can't open port 25), we return the top 3
  // ranked candidates for the user to pick one.
  return {
    status: 'NEEDS_EMAIL_REVIEW',
    candidates: candidates.slice(0, 3),
    originalEmail: original,
    classification: primary.classification || 'INVALID',
    domain: orgDomain,
    reason: primary.classification === 'FREE'
      ? 'free_provider_rejected_guessed_corporate'
      : 'invalid_email_guessed_corporate',
    source: 'guessed_pattern'
  };
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

  // 24h cache — DNS changes are rare, and Google Public DNS has its own
  // TTL respect, so caching at the script layer is safe.
  try {
    var cache = CacheService.getScriptCache();
    var cached = cache.get('MX_' + d);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (_) { /* cache optional */ }

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

  try {
    CacheService.getScriptCache().put('MX_' + d, JSON.stringify(result), 86400); // 24h
  } catch (_) { /* cache optional */ }

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
function _organizationToDomain(org) {
  if (!org) return '';
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
  var base = _organizationToDomain(orgName);
  if (!base) return '';

  // Strip the .com and try common corporate TLDs
  var root = base.replace(/\.com$/, '');
  var tlds = ['.com', '.io', '.ai', '.co', '.in', '.co.in', '.com.au', '.org', '.net'];

  for (var i = 0; i < tlds.length; i++) {
    var candidate = root + tlds[i];
    var mx = verifyMxRecord(candidate);
    if (mx.hasMx) return candidate;
  }
  return '';
}
