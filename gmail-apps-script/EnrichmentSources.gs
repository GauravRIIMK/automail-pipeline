/**
 * ============================================================================
 * EnrichmentSources.gs — Multi-source domain + pattern resolvers
 * ----------------------------------------------------------------------------
 * Free-only stack assembled from R3 (domain resolvers) and R4 (pattern intel)
 * research. Each source caches independently. All callable from EmailEnricher.
 *
 * DOMAIN RESOLVERS (Stage 2 of the new cascade):
 *   1. resolveDomainClearbit(orgName)
 *      Clearbit Autocomplete — free, no auth. ~70% global hit rate. ~100ms.
 *      Note: Clearbit LOGO API died Dec 2025; AUTOCOMPLETE still live.
 *
 *   2. resolveDomainDuckDuckGo(orgName)
 *      DuckDuckGo Instant Answer `OfficialSite` — free, no auth. ~60% for
 *      Wikipedia-notable companies. ~200ms.
 *
 *   3. resolveDomainGitHub(orgName, [pat])
 *      GitHub Orgs API `blog` field. 60 req/hr unauth, 5000 with PAT.
 *      ~65% for tech / SaaS companies. ~150ms.
 *
 *   4. resolveDomainGeminiGrounded(orgName)  [in EmailEnricher.gs already as
 *      _geminiEmailIntelligence — kept as final fallback]
 *
 * PATTERN INTELLIGENCE (Stage 3):
 *   5. fetchHunterPattern(domain)
 *      Hunter Domain Search `data.pattern`. 25 free/month.
 *
 *   6. fetchPatternFromGithubCommits(domain)
 *      GitHub `search/commits?q=author-email:@<domain>` — extracts real
 *      employee emails from public commits, scores 12 patterns. Highest-
 *      leverage free signal for tech companies.
 *
 *   7. fetchPatternFromWebsiteMailtos(domain)
 *      Fetch domain homepage + /team + /about + /contact, regex for
 *      mailto: links + bare @<domain> emails. Free.
 *
 * UTILITY:
 *   8. resolveDomainMultiSource(orgName)
 *      The orchestrator — runs sources in cost-ascending order, votes
 *      across results, returns the highest-confidence domain.
 *
 *   9. loadDisposableDomainBlocklist()
 *      Loads disposable-email-domains list from GitHub, caches 7 days.
 *
 *  10. domainDmarcStrictness(domain)
 *      Queries _dmarc.<domain> TXT, returns 'reject' / 'quarantine' / 'none'.
 *
 *  11. mxRankBonus(mxRecords)
 *      Returns +0.03 if MX matches Google Workspace or Microsoft 365.
 * ============================================================================
 */

// ─── 0. VENDOR CACHE HELPERS — CacheService-backed ─────────────────────────
//
// PATCH 2026-06-12-cacheservice-migration: the ScriptProperties store hit its
// hard quota on 2026-06-12 (~1,039 keys) and every property write in the
// pipeline threw "exceeded the property storage quota". Per-domain/per-email
// vendor caches were the dominant filler, so they now live in
// CacheService.getScriptCache(): separate quota, 100KB/value, native TTL,
// auto-eviction. ScriptProperties holds config + state only; vendor-cache
// keys still found there are legacy residue (see menuPurgeStaleVendorCaches).
//
// Trade-off accepted 2026-06-12: CacheService caps TTL at 21600s (6h) vs the
// old 1-30 day property TTLs. These caches mostly prevent same-batch
// re-lookups; long-lived per-domain intel (HUNTER_PATTERN_, DMARC_) simply
// re-fetches after expiry. Callers pass their LOGICAL TTL in seconds and the
// clamp guard enforces the platform cap.
//
// All sites preserve their existing JSON value shapes ({result|pattern|
// policy|hash|value, ts}) so read-side freshness checks and legacy tooling
// keep working unchanged. Access goes through _svc('Cache') (Services.gs)
// so tests can mock the backend.

var VENDOR_CACHE_MAX_TTL_SECONDS = 21600;  // CacheService hard cap (6h)

// Pure guard (unit-tested directly): normalize a requested TTL into the
// range CacheService accepts. Invalid or absent input falls back to the cap.
function _vendorCacheClampTtl(ttlSeconds) {
  var n = Number(ttlSeconds);
  if (!isFinite(n) || n <= 0) return VENDOR_CACHE_MAX_TTL_SECONDS;
  return Math.max(1, Math.min(VENDOR_CACHE_MAX_TTL_SECONDS, Math.floor(n)));
}

// Read a vendor-cache entry. Returns the parsed object, or null on miss /
// corrupt JSON / backend failure — callers treat null as "re-fetch".
function _vendorCacheGet(cacheKey) {
  try {
    var raw = _svc('Cache').get(cacheKey);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

// Write a vendor-cache entry. Never throws into enrichment: returns false on
// oversize values (>100KB), serialization failure, or backend errors.
function _vendorCachePut(cacheKey, valueObj, ttlSeconds) {
  try {
    _svc('Cache').put(cacheKey, JSON.stringify(valueObj), _vendorCacheClampTtl(ttlSeconds));
    return true;
  } catch (_) {
    return false;
  }
}

// ─── 1. CLEARBIT AUTOCOMPLETE ──────────────────────────────────────────────
//
// Endpoint: https://autocomplete.clearbit.com/v1/companies/suggest?query=<name>
// Response: [{ name, domain, logo }] — `logo` is null post-Dec-2025 but
// `domain` is unaffected. Free, no auth, no published rate limit.
function resolveDomainClearbit(orgName) {
  if (!orgName) return null;
  var cached = _getDomainCache('CB_', orgName);
  if (cached !== undefined) return cached;

  var url = 'https://autocomplete.clearbit.com/v1/companies/suggest?query=' +
            encodeURIComponent(orgName);
  try {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      _setDomainCache('CB_', orgName, null, 1);  // short cache for HTTP errors
      return null;
    }
    var arr = JSON.parse(res.getContentText());
    if (!Array.isArray(arr) || arr.length === 0) {
      _setDomainCache('CB_', orgName, null, 7);
      return null;
    }

    // PATCH 2026-05-13: name-similarity guard.
    //
    // Clearbit's autocomplete returns the most-popular companies first,
    // ranked by their internal popularity index. For generic English-word
    // brand names ("Nothing", "Notion", "Square", "Stripe"), the top hit
    // is frequently NOT the intended company — Clearbit may return a 100x
    // bigger company whose name happens to contain the query as a substring.
    //
    // The fix: walk the result list and pick the FIRST entry whose name,
    // when normalized, contains the normalized query as a whole-word match
    // (or equals it). Fall back to arr[0] only when no match is found AND
    // the query is so unique (>=8 chars) that fuzzy match is unlikely to
    // help anyway. Drop confidence from 0.85 → 0.70 for non-exact matches
    // so downstream voting prefers Apollo / DDG / GitHub when they agree.
    var queryNorm = (orgName || '').toString().toLowerCase().replace(/[^a-z0-9]/g, '');
    var pick = null;
    var matchType = 'first';  // 'exact' | 'whole-word' | 'first'
    for (var i = 0; i < arr.length; i++) {
      var c = arr[i];
      var nameNorm = ((c && c.name) || '').toString().toLowerCase().replace(/[^a-z0-9]/g, '');
      if (nameNorm === queryNorm) { pick = c; matchType = 'exact'; break; }
    }
    if (!pick) {
      for (var j = 0; j < arr.length; j++) {
        var c2 = arr[j];
        var name2 = ((c2 && c2.name) || '').toString().toLowerCase();
        var hasWholeWord = new RegExp('\\b' + (orgName || '').toString().toLowerCase() + '\\b').test(name2);
        if (hasWholeWord) { pick = c2; matchType = 'whole-word'; break; }
      }
    }
    if (!pick) {
      // No similarity match. Only fall back to arr[0] when query is long
      // enough that Clearbit's fuzzy autocomplete is plausibly meaningful.
      if (queryNorm.length >= 8) {
        pick = arr[0];
        matchType = 'first-long-query';
      } else {
        Logger.log('[Sources/Clearbit] ' + orgName + ' → rejected (no name-similarity match in top ' +
                   arr.length + ' results; first was "' + (arr[0] && arr[0].name) + '")');
        _setDomainCache('CB_', orgName, null, 7);
        return null;
      }
    }

    var domain = pick && pick.domain ? pick.domain.toString().toLowerCase().trim() : null;
    if (domain && /^[a-z0-9][a-z0-9.\-]*\.[a-z]{2,}$/i.test(domain)) {
      // Confidence varies by match strength
      var confidence = (matchType === 'exact') ? 0.90
                     : (matchType === 'whole-word') ? 0.80
                     : 0.65;  // first-long-query fallback
      Logger.log('[Sources/Clearbit] ' + orgName + ' → ' + domain +
                 ' (match=' + matchType + ', name="' + pick.name + '", conf=' + confidence + ')');
      _setDomainCache('CB_', orgName, { domain: domain, source: 'clearbit', name: pick.name, matchType: matchType }, 30);
      return { domain: domain, source: 'clearbit', confidence: confidence, raw: pick };
    }
    _setDomainCache('CB_', orgName, null, 7);
    return null;
  } catch (e) {
    Logger.log('[Sources/Clearbit] error: ' + e.message);
    return null;
  }
}

// ─── 2. DUCKDUCKGO INSTANT ANSWER ──────────────────────────────────────────
//
// Endpoint: https://api.duckduckgo.com/?q=<name>&format=json&no_html=1&skip_disambig=1
// Response field: `OfficialSite` (the company homepage URL). Free, no auth.
function resolveDomainDuckDuckGo(orgName) {
  if (!orgName) return null;
  var cached = _getDomainCache('DDG_', orgName);
  if (cached !== undefined) return cached;

  var url = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(orgName) +
            '&format=json&no_html=1&skip_disambig=1';
  try {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      _setDomainCache('DDG_', orgName, null, 1);
      return null;
    }
    var json = JSON.parse(res.getContentText());
    var site = (json && json.OfficialSite) ? json.OfficialSite.toString() : '';
    if (!site) {
      _setDomainCache('DDG_', orgName, null, 7);
      return null;
    }
    // Extract domain from URL
    var match = site.match(/^https?:\/\/(?:www\.)?([^\/]+)/i);
    var domain = match ? match[1].toLowerCase() : null;
    if (domain && /^[a-z0-9][a-z0-9.\-]*\.[a-z]{2,}$/i.test(domain)) {
      Logger.log('[Sources/DDG] ' + orgName + ' → ' + domain);
      _setDomainCache('DDG_', orgName, { domain: domain, source: 'duckduckgo' }, 30);
      return { domain: domain, source: 'duckduckgo', confidence: 0.80, raw: { officialSite: site } };
    }
    _setDomainCache('DDG_', orgName, null, 7);
    return null;
  } catch (e) {
    Logger.log('[Sources/DDG] error: ' + e.message);
    return null;
  }
}

// ─── 3. GITHUB ORGS BLOG FIELD ─────────────────────────────────────────────
//
// Endpoint: https://api.github.com/orgs/<slug> — returns `blog` (homepage URL).
// 60 req/hr unauth, 5000 with PAT. Try slug variants.
function resolveDomainGitHub(orgName) {
  if (!orgName) return null;
  var cached = _getDomainCache('GH_', orgName);
  if (cached !== undefined) return cached;

  // Generate slug variants: lowercase, no spaces, hyphenated
  var raw = orgName.toString().toLowerCase().trim();
  var slugs = [
    raw.replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, ''),
    raw.replace(/\s+/g, '').replace(/[^a-z0-9]/g, ''),
    raw.split(/\s+/)[0].replace(/[^a-z0-9]/g, '')  // first word only
  ];
  var seen = {};
  slugs = slugs.filter(function(s) { if (!s || seen[s]) return false; seen[s] = true; return true; });

  var props = PropertiesService.getScriptProperties();
  var pat = props.getProperty('GITHUB_PAT') || '';
  var headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'AutoMailPipeline' };
  if (pat) headers['Authorization'] = 'Bearer ' + pat;

  for (var i = 0; i < slugs.length; i++) {
    var slug = slugs[i];
    var url = 'https://api.github.com/orgs/' + encodeURIComponent(slug);
    try {
      var res = UrlFetchApp.fetch(url, { headers: headers, muteHttpExceptions: true });
      var code = res.getResponseCode();
      if (code === 404) continue;
      if (code === 403) {
        Logger.log('[Sources/GitHub] rate-limited (set GITHUB_PAT to extend to 5000/hr)');
        return null;
      }
      if (code !== 200) continue;
      var json = JSON.parse(res.getContentText());
      var blog = json.blog ? json.blog.toString() : '';
      if (!blog) continue;
      var m = blog.match(/^https?:\/\/(?:www\.)?([^\/]+)/i);
      var domain = m ? m[1].toLowerCase() : null;
      if (domain && /^[a-z0-9][a-z0-9.\-]*\.[a-z]{2,}$/i.test(domain)) {
        Logger.log('[Sources/GitHub] ' + orgName + ' (slug=' + slug + ') → ' + domain);
        _setDomainCache('GH_', orgName, { domain: domain, source: 'github_orgs', slug: slug }, 30);
        return { domain: domain, source: 'github_orgs', confidence: 0.85, raw: { slug: slug, blog: blog } };
      }
    } catch (e) {
      Logger.log('[Sources/GitHub] error for slug ' + slug + ': ' + e.message);
    }
  }
  _setDomainCache('GH_', orgName, null, 7);
  return null;
}

// ─── 8. MULTI-SOURCE DOMAIN RESOLVER — the orchestrator ────────────────────
//
// Calls all four sources, votes across them, returns winning domain with a
// confidence score. The vote-aggregation pattern aligns with R1's "waterfall
// enrichment" finding (multi-source averaging beats single-source claims).
//
// Returns { domain, confidence, sources: [...], votes: { d: count } }
function resolveDomainMultiSource(orgName, firstName, lastName) {
  if (!orgName) return null;
  var cached = _getDomainCache('MULTI_', orgName);
  if (cached !== undefined) return cached;

  var results = [];

  // Layer 1: Clearbit (highest hit rate global)
  var r = resolveDomainClearbit(orgName);
  if (r) results.push(r);

  // Layer 2: DuckDuckGo (Wikipedia-notable fallback)
  r = resolveDomainDuckDuckGo(orgName);
  if (r) results.push(r);

  // Layer 3: GitHub Orgs (tech / SaaS companies)
  r = resolveDomainGitHub(orgName);
  if (r) results.push(r);

  // Layer 4: Gemini grounded (the existing _geminiEmailIntelligence)
  // — only call if first 3 layers all missed (Gemini quota is the most precious)
  if (results.length === 0) {
    try {
      var gem = _geminiEmailIntelligence(firstName, lastName, orgName);
      if (gem && gem.domain) {
        results.push({ domain: gem.domain.toLowerCase(), source: 'gemini', confidence: 0.75,
                       raw: { candidates: gem.candidates } });
      }
    } catch (_) {}
  }

  if (results.length === 0) {
    _setDomainCache('MULTI_', orgName, null, 7);
    return null;
  }

  // Vote across sources — domain with most independent confirmations wins.
  // Single-source results are kept but lower-confidence.
  var votes = {};
  results.forEach(function(r) {
    votes[r.domain] = (votes[r.domain] || 0) + 1;
  });
  var winner = null;
  var maxVotes = 0;
  Object.keys(votes).forEach(function(d) {
    if (votes[d] > maxVotes) { maxVotes = votes[d]; winner = d; }
  });

  // Confidence: base 0.65 single-source, +0.10 each additional confirming source
  var confidence = Math.min(0.95, 0.65 + (maxVotes - 1) * 0.10);
  // If Clearbit was one of the sources, +0.05 (highest accuracy per R3)
  if (results.some(function(r) { return r.domain === winner && r.source === 'clearbit'; })) {
    confidence = Math.min(0.95, confidence + 0.05);
  }

  var out = {
    domain: winner,
    confidence: confidence,
    sources: results.filter(function(r) { return r.domain === winner; }).map(function(r) { return r.source; }),
    votes: votes,
    rawResults: results
  };
  Logger.log('[Sources/Multi] ' + orgName + ' → ' + winner + ' (confidence=' + confidence.toFixed(2) +
             ', sources=' + out.sources.join('+') + ')');
  _setDomainCache('MULTI_', orgName, out, 30);
  return out;
}

// ─── 5. HUNTER DOMAIN SEARCH — pattern field ───────────────────────────────
//
// 25 free/month. Returns `data.pattern` like "{first}.{last}" — the dominant
// pattern Hunter detected for the domain.
function fetchHunterPattern(domain) {
  if (!domain) return null;
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('HUNTER_API_KEY');
  if (!apiKey) return null;

  var cacheKey = 'HUNTER_PATTERN_' + domain.toLowerCase();
  var p = _vendorCacheGet(cacheKey);
  if (p && (Date.now() - p.ts) / 86400000 < 30) {
    Logger.log('[Sources/HunterPattern] cache hit for ' + domain + ' → ' + (p.pattern || 'null'));
    return p.pattern || null;
  }

  var url = 'https://api.hunter.io/v2/domain-search?domain=' + encodeURIComponent(domain) +
            '&limit=1&api_key=' + encodeURIComponent(apiKey);
  try {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() === 429) {
      Logger.log('[Sources/HunterPattern] quota exhausted (429)');
      return null;
    }
    if (res.getResponseCode() !== 200) return null;
    var json = JSON.parse(res.getContentText());
    var pattern = json.data && json.data.pattern ? json.data.pattern.toString() : null;
    _vendorCachePut(cacheKey, { pattern: pattern, ts: Date.now() }, 30 * 86400);
    if (pattern) {
      Logger.log('[Sources/HunterPattern] ' + domain + ' → ' + pattern);
    }
    return pattern;
  } catch (e) {
    Logger.log('[Sources/HunterPattern] error: ' + e.message);
    return null;
  }
}

// ─── 6. GITHUB COMMIT-EMAIL PATTERN MINING ─────────────────────────────────
//
// GitHub commit search: `q=author-email:@<domain>` returns commits whose
// author email matches the domain. From the email + author-name pairs we
// score 12 candidate patterns and return the dominant one.
//
// This is R4's highest-leverage free signal — for tech-adjacent companies
// it typically yields 0.8+ confidence with 5+ samples.
function fetchPatternFromGithubCommits(domain) {
  if (!domain) return null;
  var props = PropertiesService.getScriptProperties();
  var cacheKey = 'GHCOMMIT_PATTERN_' + domain.toLowerCase();
  var cachedPattern = _vendorCacheGet(cacheKey);
  if (cachedPattern && (Date.now() - cachedPattern.ts) / 86400000 < 14) return cachedPattern.result;

  var pat = props.getProperty('GITHUB_PAT') || '';
  var headers = {
    'Accept': 'application/vnd.github.cloak-preview',
    'User-Agent': 'AutoMailPipeline'
  };
  if (pat) headers['Authorization'] = 'Bearer ' + pat;

  var url = 'https://api.github.com/search/commits?q=' +
            encodeURIComponent('author-email:@' + domain) + '&per_page=30';
  try {
    var res = UrlFetchApp.fetch(url, { headers: headers, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      Logger.log('[Sources/GHCommit] HTTP ' + res.getResponseCode() + ' for ' + domain);
      return null;
    }
    var json = JSON.parse(res.getContentText());
    var commits = (json.items || []);
    if (commits.length === 0) {
      _vendorCachePut(cacheKey, { result: null, ts: Date.now() }, 14 * 86400);
      return null;
    }

    // Collect (email, author name) pairs. Filter out users.noreply.github.com.
    var samples = [];
    commits.forEach(function(c) {
      var email = c.commit && c.commit.author && c.commit.author.email;
      var name  = c.commit && c.commit.author && c.commit.author.name;
      if (!email || !name) return;
      if (email.indexOf('noreply.github.com') >= 0) return;
      if (email.split('@')[1].toLowerCase() !== domain.toLowerCase()) return;
      samples.push({ email: email.toLowerCase(), name: name });
    });
    if (samples.length < 2) {
      Logger.log('[Sources/GHCommit] only ' + samples.length + ' sample(s) for ' + domain + ' — insufficient');
      _vendorCachePut(cacheKey, { result: null, ts: Date.now() }, 14 * 86400);
      return null;
    }

    // Score patterns
    var patterns = [
      '{first}.{last}', '{first}{last}', '{first}', '{f}{last}', '{first}.{l}',
      '{first}_{last}', '{f}.{last}', '{last}.{first}', '{last}', '{f}{l}',
      '{last}{f}', '{last}{first}'
    ];
    var hits = {};
    patterns.forEach(function(p) { hits[p] = 0; });

    samples.forEach(function(s) {
      var nameParts = s.name.toLowerCase().split(/\s+/).filter(function(p) { return p; });
      if (nameParts.length < 2) return;
      var first = nameParts[0];
      var last = nameParts[nameParts.length - 1];
      var f = first[0];
      var l = last[0];
      var local = s.email.split('@')[0];
      patterns.forEach(function(p) {
        var built = p
          .replace('{first}', first)
          .replace('{last}', last)
          .replace('{f}', f)
          .replace('{l}', l);
        if (built === local) hits[p]++;
      });
    });

    // Winner = pattern with most hits, but require ≥40% support
    var winner = null;
    var winnerHits = 0;
    Object.keys(hits).forEach(function(p) {
      if (hits[p] > winnerHits) { winnerHits = hits[p]; winner = p; }
    });
    if (!winner || winnerHits / samples.length < 0.4) {
      Logger.log('[Sources/GHCommit] no dominant pattern for ' + domain + ' (' + samples.length + ' samples)');
      _vendorCachePut(cacheKey, { result: null, ts: Date.now() }, 14 * 86400);
      return null;
    }

    var result = {
      pattern: winner,
      confidence: winnerHits / samples.length,
      samples: samples.length,
      hits: winnerHits
    };
    Logger.log('[Sources/GHCommit] ' + domain + ' → ' + winner + ' (conf=' +
               result.confidence.toFixed(2) + ', ' + winnerHits + '/' + samples.length + ' samples)');
    _vendorCachePut(cacheKey, { result: result, ts: Date.now() }, 14 * 86400);
    return result;
  } catch (e) {
    Logger.log('[Sources/GHCommit] error: ' + e.message);
    return null;
  }
}

// ─── 9. DISPOSABLE DOMAIN BLOCKLIST ────────────────────────────────────────
//
// Fetches the disposable-email-domains list from GitHub, caches 7 days.
// One-time load; O(1) lookup thereafter via an object hash.
function loadDisposableDomainBlocklist() {
  var cacheKey = 'DISPOSABLE_LIST_V1';
  var cachedList = _vendorCacheGet(cacheKey);
  if (cachedList && cachedList.hash && (Date.now() - cachedList.ts) / 86400000 < 7) {
    return cachedList.hash;
  }

  var url = 'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/disposable_email_blocklist.conf';
  try {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return {};
    var text = res.getContentText();
    var hash = {};
    text.split('\n').forEach(function(line) {
      var d = line.trim().toLowerCase();
      if (d && d.indexOf('#') !== 0) hash[d] = true;
    });
    // NOTE: the serialized hash (~4.5K domains) may exceed the 100KB CacheService
    // value cap; the helper returns false in that case and we just re-download
    // next call — same effective behavior as before, when the value never fit
    // the 9KB property limit either.
    _vendorCachePut(cacheKey, { hash: hash, ts: Date.now() }, 7 * 86400);
    Logger.log('[Sources/Disposable] loaded ' + Object.keys(hash).length + ' disposable domains');
    return hash;
  } catch (e) {
    Logger.log('[Sources/Disposable] error: ' + e.message);
    return {};
  }
}

function isDisposableDomain(domain) {
  if (!domain) return false;
  var hash = loadDisposableDomainBlocklist();
  return !!hash[domain.toString().toLowerCase()];
}

// ─── 10. DMARC STRICTNESS ──────────────────────────────────────────────────
//
// Queries _dmarc.<domain> TXT via Google DNS-over-HTTPS.
// Returns 'reject' / 'quarantine' / 'none' / null.
function domainDmarcStrictness(domain) {
  if (!domain) return null;
  var cacheKey = 'DMARC_' + domain.toLowerCase();
  var cachedDmarc = _vendorCacheGet(cacheKey);
  if (cachedDmarc && (Date.now() - cachedDmarc.ts) / 86400000 < 30) return cachedDmarc.policy;

  var url = 'https://dns.google/resolve?name=_dmarc.' + encodeURIComponent(domain) + '&type=TXT';
  try {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    var json = JSON.parse(res.getContentText());
    var answers = json.Answer || [];
    var policy = null;
    for (var i = 0; i < answers.length; i++) {
      var data = (answers[i].data || '').replace(/"/g, '');
      var m = data.match(/p=(reject|quarantine|none)/i);
      if (m) { policy = m[1].toLowerCase(); break; }
    }
    _vendorCachePut(cacheKey, { policy: policy, ts: Date.now() }, 30 * 86400);
    return policy;
  } catch (e) {
    Logger.log('[Sources/DMARC] error: ' + e.message);
    return null;
  }
}

// ─── 11. MX RANK BONUS ─────────────────────────────────────────────────────
//
// +0.03 if MX matches Google Workspace or Microsoft 365 (high-deliverability tier).
function mxRankBonus(mxRecords) {
  if (!mxRecords || !Array.isArray(mxRecords)) return 0;
  for (var i = 0; i < mxRecords.length; i++) {
    var mx = (mxRecords[i] || '').toString().toLowerCase();
    if (mx.indexOf('aspmx.l.google.com') >= 0 ||
        mx.indexOf('smtp.google.com') >= 0 ||
        mx.indexOf('googlemail.com') >= 0) return 0.03;
    if (mx.indexOf('.mail.protection.outlook.com') >= 0) return 0.03;
  }
  return 0;
}

// ─── 12. APOLLO ORGANIZATIONS SEARCH — disambiguation by LinkedIn URL ─────
//
// Apollo's /organizations/search is accessible on the FREE tier (unlike
// /people/match which is paid-only). It returns multiple companies matching
// a name, each with website_url + linkedin_url. We use it to DISAMBIGUATE
// when a company name like "Pronto" matches 1917 different companies.
//
// Match strategy:
//   1. Query org name → up to 10 candidates
//   2. For each candidate, compute a match score based on:
//      - LinkedIn URL match (if person's profile mentions the company's LI URL)
//      - Headline contains apollo's organization name
//      - Location match (best-effort substring)
//   3. Return ranked candidates with their websites
//
// Free tier: ~75 credits/month for /organizations/search per Apollo docs.

function resolveDomainApolloOrgs(orgName, contextHints) {
  if (!orgName) return null;
  contextHints = contextHints || {};
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('APOLLO_API_KEY');
  if (!apiKey) return null;

  var cacheKey = 'APOLLO_ORGS_' + orgName.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 60);
  var cachedOrgs = _vendorCacheGet(cacheKey);
  if (cachedOrgs && (Date.now() - cachedOrgs.ts) < 14 * 86400000) return cachedOrgs.result;

  // Apollo call with automatic fallback. Free-tier accounts hit 403 with
  // "API temporarily unavailable. There is an issue with your payment." if
  // billing is unresolved — when that happens, swap to APOLLO_API_KEY_FALLBACK.
  var res = _apolloFetchWithFallback(apiKey,
    'https://api.apollo.io/api/v1/organizations/search',
    JSON.stringify({ q_organization_name: orgName, per_page: 10 }));

  try {
    if (!res || res.getResponseCode() !== 200) {
      Logger.log('[Sources/ApolloOrgs] HTTP ' + (res ? res.getResponseCode() : 'no response'));
      return null;
    }
    var json = JSON.parse(res.getContentText());
    var orgs = json.organizations || [];
    if (orgs.length === 0) {
      _vendorCachePut(cacheKey, { result: null, ts: Date.now() }, 14 * 86400);
      return null;
    }

    // Score each candidate
    var hintsLowered = {
      linkedinUrl: (contextHints.linkedinUrl || '').toLowerCase(),
      headline: (contextHints.headline || '').toLowerCase(),
      designation: (contextHints.designation || '').toLowerCase(),
      location: (contextHints.location || '').toLowerCase()
    };

    // PATCH 2026-05-13: when context hints are empty (no headline / no location)
    // every candidate scores ~0 and the first Apollo result wins by tiebreak.
    // For brand-name queries like "Nothing", Apollo's first hit is often
    // unrelated. The new scoring adds two structural signals that work even
    // without context:
    //   (1) Domain SLD exactly matches normalized org name → strong bonus
    //   (2) Exact org-name match between Apollo's record and our query
    //
    // These rescue "Nothing" → nothing.tech (SLD match) and similar cases.
    var queryNormForApollo = (orgName || '').toString().toLowerCase().replace(/[^a-z0-9]/g, '');

    var candidates = orgs.map(function(o) {
      var website = (o.website_url || o.primary_domain || '').toString().toLowerCase();
      var domain = '';
      var m = website.match(/^https?:\/\/(?:www\.)?([^\/]+)/i);
      if (m) domain = m[1].toLowerCase();
      else if (website && website.indexOf('.') > 0) domain = website.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

      var liUrl = (o.linkedin_url || '').toString().toLowerCase();
      var orgNameNorm = (o.name || '').toString();
      var orgNameKey = orgNameNorm.toLowerCase().replace(/[^a-z0-9]/g, '');
      var score = 0;
      var reasons = [];

      // Strong signal: headline mentions same org name suffix
      if (hintsLowered.headline && hintsLowered.headline.indexOf(orgNameNorm.toLowerCase()) >= 0) {
        score += 0.20; reasons.push('headline_match');
      }
      // Location match
      var loc = (o.country || '') + ' ' + (o.city || '') + ' ' + (o.state || '');
      if (hintsLowered.location && loc.toLowerCase().indexOf(hintsLowered.location.split(',')[0].trim()) >= 0) {
        score += 0.15; reasons.push('location_match');
      }

      // PATCH 2026-05-13 — context-free signal #1: Apollo record name EXACTLY
      // matches our query. This is the strongest possible signal that Apollo
      // has the company we mean, not a similarly-named one.
      if (orgNameKey && orgNameKey === queryNormForApollo) {
        score += 0.25; reasons.push('exact_name');
      }

      // PATCH 2026-05-13 — context-free signal #2: domain's SLD (the second
      // -level part, e.g. "nothing" in "nothing.tech") equals the normalized
      // query. For brand-name queries this is more reliable than fuzzy
      // company-name matching because companies often register domains that
      // mirror their core brand. Examples that benefit: nothing.tech, cred.club,
      // linear.app, perplexity.ai.
      if (domain) {
        var sld = domain.split('.')[0];
        if (sld && sld === queryNormForApollo) {
          score += 0.20; reasons.push('domain_sld_match');
        }
      }

      // Penalty: domain doesn't contain org name as substring at all
      //
      // PATCH 2026-05-13 (AUDIT R36): the previous regex
      // `!/^[a-z0-9]+\.[a-z]{2,}$/i.test(domain.replace(/\..*/, ''))`
      // was always true because after `.replace(/\..*/, '')` the input is
      // just the SLD (e.g. "fractal" for fractal.ai), which has no dot —
      // the anchor `\.` could never match. Net effect: the penalty fired on
      // EVERY candidate whose domain didn't contain the org-name substring,
      // including correct mappings like Krutrim → olakrutrim.com (does not
      // contain "krutrim" as substring at start) and Fractal Analytics →
      // fractal.ai.
      //
      // New logic: penalize only when the SLD shares NO substring with the
      // normalized org name in EITHER direction. This catches "withpronto"
      // vs "pronto" while sparing "olakrutrim" vs "krutrim".
      if (domain) {
        var sldForPenalty = domain.split('.')[0];
        var orgKeyForPenalty = (orgName || '').toLowerCase().replace(/\s+/g, '');
        if (sldForPenalty && orgKeyForPenalty &&
            sldForPenalty.indexOf(orgKeyForPenalty) < 0 &&
            orgKeyForPenalty.indexOf(sldForPenalty) < 0) {
          score -= 0.05; reasons.push('sld_name_mismatch');
        }
      }
      // Bonus: employee count > 10 (real company)
      if (o.estimated_num_employees && o.estimated_num_employees >= 10) {
        score += 0.05; reasons.push('emp_' + o.estimated_num_employees);
      }
      return {
        name: o.name, domain: domain, website: o.website_url, linkedinUrl: o.linkedin_url,
        employees: o.estimated_num_employees, country: o.country, city: o.city,
        score: score, reasons: reasons
      };
    }).filter(function(c) { return c.domain && /^[a-z0-9][a-z0-9.\-]*\.[a-z]{2,}$/i.test(c.domain); });

    candidates.sort(function(a, b) { return b.score - a.score; });
    var result = { candidates: candidates.slice(0, 5), totalFound: orgs.length };

    Logger.log('[Sources/ApolloOrgs] ' + orgName + ' → ' + result.candidates.length +
               ' candidates (total ' + orgs.length + ' Apollo orgs match name)');
    if (result.candidates[0]) {
      Logger.log('[Sources/ApolloOrgs] top: ' + result.candidates[0].name + ' @ ' +
                 result.candidates[0].domain + ' (score ' + result.candidates[0].score.toFixed(2) +
                 ', reasons=' + result.candidates[0].reasons.join(',') + ')');
    }

    _vendorCachePut(cacheKey, { result: result, ts: Date.now() }, 14 * 86400);
    return result;
  } catch (e) {
    Logger.log('[Sources/ApolloOrgs] error: ' + e.message);
    return null;
  }
}

// ─── 12.5. APOLLO /people/match — DIRECT LINKEDIN-URL LOOKUP (paid plan) ──
//
// Apollo's paid plan unlocks /v1/people/match which accepts a linkedin_url
// directly and returns the person's verified work email + employer.
// This is the highest-quality signal we can produce:
//   - Apollo knows the ACTUAL employer-of-record (not a guess)
//   - `email_status: "verified"` = Apollo verified deliverability themselves
//   - Eliminates same-name disambiguation entirely (URL → exact person)
//
// Confidence mapping when this hits:
//   email_status="verified"             → 0.95
//   email_status="likely to engage"     → 0.90
//   email_status="unverified"           → 0.65
//   email_status="extrapolated"         → 0.55 (Apollo guessed by pattern)
//   No email returned                   → fall through to cascade
//
// Credits: 1 per /people/match call. Cache 14 days per LinkedIn URL.

function resolveLeadApolloMatch(linkedinUrl) {
  if (!linkedinUrl) return null;
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('APOLLO_API_KEY');
  if (!apiKey) return null;

  var cacheKey = 'APOLLO_MATCH_' + linkedinUrl.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 80);
  var cachedMatch = _vendorCacheGet(cacheKey);
  if (cachedMatch && (Date.now() - cachedMatch.ts) < 14 * 86400000) {
    Logger.log('[Sources/ApolloMatch] cache hit for ' + linkedinUrl);
    return cachedMatch.result;
  }

  // Use the fallback-aware fetcher (handles 403 payment-block transparently)
  var res = _apolloFetchWithFallback(apiKey,
    'https://api.apollo.io/api/v1/people/match',
    JSON.stringify({ linkedin_url: linkedinUrl, reveal_personal_emails: true }));

  try {
    if (!res || res.getResponseCode() !== 200) {
      Logger.log('[Sources/ApolloMatch] HTTP ' + (res ? res.getResponseCode() : 'no_response'));
      return null;
    }
    var json = JSON.parse(res.getContentText());
    var person = json.person || null;
    if (!person) {
      Logger.log('[Sources/ApolloMatch] no person record for ' + linkedinUrl);
      _vendorCachePut(cacheKey, { result: null, ts: Date.now() }, 14 * 86400);
      return null;
    }

    // Pull the org domain from the org block or employment_history
    var domain = '';
    var orgName = '';
    if (person.organization) {
      orgName = person.organization.name || '';
      var w = person.organization.website_url || person.organization.primary_domain || '';
      var m = (w || '').match(/^https?:\/\/(?:www\.)?([^\/]+)/i);
      domain = m ? m[1].toLowerCase() : (w || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    }
    // Fallback: derive domain from email if org block missing
    if (!domain && person.email) {
      var em = person.email.split('@');
      if (em.length === 2) domain = em[1].toLowerCase();
    }
    // Fallback: pull org from employment_history current entry
    if (!orgName && Array.isArray(person.employment_history)) {
      for (var i = 0; i < person.employment_history.length; i++) {
        var e = person.employment_history[i];
        if (e.current && e.organization_name) { orgName = e.organization_name; break; }
      }
    }

    var statusMap = {
      verified: 0.95,
      'likely to engage': 0.90,
      unverified: 0.65,
      extrapolated: 0.55
    };
    var status = (person.email_status || '').toString().toLowerCase();
    var confidence = statusMap[status] || (person.email ? 0.50 : 0);

    var result = {
      source: 'apollo_people_match',
      email: person.email || '',
      emailStatus: status,
      confidence: confidence,
      organizationName: orgName,
      domain: domain,
      fullName: person.name || ((person.first_name || '') + ' ' + (person.last_name || '')).trim(),
      firstName: person.first_name || '',
      lastName: person.last_name || '',
      title: person.title || '',
      headline: person.headline || '',
      city: person.city || '',
      state: person.state || '',
      country: person.country || '',
      personalEmails: person.personal_emails || [],
      photoUrl: person.photo_url || ''
    };

    Logger.log('[Sources/ApolloMatch] ' + linkedinUrl + ' → ' + (result.email || '(no email)') +
               ' [' + status + '] @ ' + orgName + ' (' + domain + ') conf=' + confidence.toFixed(2));

    _vendorCachePut(cacheKey, { result: result, ts: Date.now() }, 14 * 86400);
    return result;
  } catch (e) {
    Logger.log('[Sources/ApolloMatch] parse error: ' + e.message);
    return null;
  }
}

// ─── 13. SNOV.IO B2B PRESENCE VERIFIER ─────────────────────────────────────
//
// Given a candidate domain, query Snov.io's domain-emails-with-info endpoint.
//   - If `company_name` is populated AND at least one returned email has a
//     `linkedin_url` source → this is a real B2B company in Snov's DB
//   - If `company_name` is empty AND returned emails look like garbage
//     (5-char placeholders) → not a real B2B match for this domain
//
// Used as the tiebreaker between Apollo Orgs candidates: the candidate with
// Snov.io B2B presence wins.

function verifySnovDomainPresence(domain) {
  if (!domain) return null;
  var cacheKey = 'SNOV_PRESENCE_' + domain.toLowerCase();
  var cachedPresence = _vendorCacheGet(cacheKey);
  if (cachedPresence && (Date.now() - cachedPresence.ts) < 30 * 86400000) return cachedPresence.result;

  // ── PATCH `-p5-vendorresilience-config` (Phase 2e): Snov 400 backoff guard ──
  //
  // Per master-prompt rule "400 = config bug, not quota": when Snov returns
  // 400 we cannot fix the request shape from runtime (it's an auth / endpoint /
  // schema mismatch). But we CAN stop hammering. Live diagnosis on 2026-06-09
  // showed 5 sequential 400s per lead per domain (no successful Snov call ever
  // observed in the latency trace). Each is ~200ms of pointless work.
  //
  // The backoff is HOURLY (vs Reoon's daily) because Snov 400 might be from
  // a transient endpoint change rather than a real config bug. After the
  // backoff window expires, we try once more — if 400 again, re-backoff.
  // Auto-recovers from transient issues; gives up gracefully when truly broken.
  var sbk = _snovBackoffCheck();
  if (sbk.active) {
    // No log line — too noisy when called inside hot enrichment loops
    return null;
  }

  var token = _snovGetToken();
  if (!token) return null;

  try {
    var res = UrlFetchApp.fetch(
      'https://api.snov.io/v2/domain-emails-with-info?domain=' + encodeURIComponent(domain) + '&type=all&limit=5',
      { headers: { 'Authorization': 'Bearer ' + token }, muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) {
      var rcode = res.getResponseCode();
      var rbody = (res.getContentText() || '').substring(0, 240);
      // PATCH `-p5-vendorresilience-config` Phase 2e: log the body too so
      // user can see WHY Snov is 400-ing (was previously code-only — opaque).
      Logger.log('[Sources/SnovPresence] HTTP ' + rcode + ' for ' + domain + ' body=' + rbody);

      // PATCH `-p5-vendorresilience-config-amend` (Phase 2e amend): live
      // diagnosis on 2026-06-09 surfaced that Snov returns the credits-out
      // error wrapped in HTTP 400 (not 402 or 403 as one would expect):
      //   {"errors":[{"user_id":"Sorry, you ran out of credits, please order more credits"}]}
      // So a 400 with "credits" in the body is a vendor-quota issue, not a
      // request-shape config bug. We pass that detection signal into the
      // counter so the trip log labels the cause correctly. The backoff
      // behavior is the same either way (1h), but the diagnostic message
      // changes so the user knows whether to fix code or top up credits.
      if (rcode === 400) {
        var isCreditsOut = /credits|recharge|order more/i.test(rbody);
        try { _snovBumpFailureCounter(rbody, isCreditsOut); } catch (_sbErr) {}
      }
      return null;
    }
    // 200 — reset the failure counter on any success
    try { _snovResetFailureCounter(); } catch (_) {}
    var json = JSON.parse(res.getContentText());
    var companyName = (json.meta && json.meta.company_name) || json.companyName || '';
    var emails = json.data || json.emails || [];
    // Check if any prospect has a linkedin source_page → strong B2B signal
    var realEmployees = emails.filter(function(e) {
      return e.first_name || e.last_name || e.position || e.source_page;
    });
    // Filter garbage placeholder addresses like "6yjh@pronto.com" (≤6 char random local-parts)
    var garbageRe = /^[a-z0-9]{1,6}@/i;
    var realLooking = emails.filter(function(e) {
      return e.email && !garbageRe.test(e.email);
    });

    var presence = {
      domain: domain,
      hasCompanyName: !!companyName,
      companyName: companyName,
      totalEmails: emails.length,
      realEmployees: realEmployees.length,
      realLooking: realLooking.length,
      // Composite: if Snov knows the company name AND has at least 1 real employee, very strong signal
      isRealB2B: !!companyName && realEmployees.length > 0,
      sampleEmployees: realEmployees.slice(0, 3).map(function(e) {
        return { name: (e.first_name || '') + ' ' + (e.last_name || ''),
                 position: e.position || '', email: e.email, sourceLi: e.source_page };
      })
    };
    Logger.log('[Sources/SnovPresence] ' + domain + ' → company=' + (companyName || '(none)') +
               ', realEmps=' + realEmployees.length + '/' + emails.length +
               ', isRealB2B=' + presence.isRealB2B);
    _vendorCachePut(cacheKey, { result: presence, ts: Date.now() }, 30 * 86400);
    return presence;
  } catch (e) {
    Logger.log('[Sources/SnovPresence] error: ' + e.message);
    return null;
  }
}

// Internal: Apollo POST with automatic fallback to the previous-known-good key
// when the primary 403s with a payment / billing-block message.
function _apolloFetchWithFallback(primaryKey, url, payload) {
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      headers: { 'X-Api-Key': primaryKey, 'Content-Type': 'application/json' },
      payload: payload,
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code === 200) return res;
    // Inspect 403 body for payment-block signature
    var body = res.getContentText() || '';
    if (code === 403 && /payment|billing|temporarily unavailable/i.test(body)) {
      var fb = PropertiesService.getScriptProperties().getProperty('APOLLO_API_KEY_FALLBACK');
      if (fb && fb !== primaryKey) {
        Logger.log('[Apollo] Primary key 403/payment-block. Retrying with FALLBACK key.');
        var res2 = UrlFetchApp.fetch(url, {
          method: 'post',
          headers: { 'X-Api-Key': fb, 'Content-Type': 'application/json' },
          payload: payload,
          muteHttpExceptions: true
        });
        return res2;
      }
    }
    return res;
  } catch (e) {
    Logger.log('[Apollo] fetch error: ' + e.message);
    return null;
  }
}

// ── PATCH `-p5-vendorresilience-config` (Phase 2e): SNOV 400-BACKOFF HELPERS ──
//
// Three small functions:
//   - _snovBackoffCheck(): is the 1h backoff currently active?
//   - _snovBumpFailureCounter(reason): increment consecutive-400 count;
//     trip backoff if threshold (5) is reached.
//   - _snovResetFailureCounter(): zero the counter on any successful Snov call.
//
// Properties:
//   SNOV_400_COUNT          — integer count of consecutive 400s
//   SNOV_400_BACKOFF_UNTIL  — epoch ms; if now < this, skip Snov calls
//   SNOV_400_LAST_REASON    — last 400 body excerpt (for diagnostics)
//
// Threshold is 5 to allow for transient single-domain weirdness without
// disabling the integration. TTL is 1h to auto-recover from short outages.

var SNOV_400_THRESHOLD = 5;
var SNOV_400_BACKOFF_MS = 60 * 60 * 1000;  // 1 hour

function _snovBackoffCheck() {
  try {
    var props = PropertiesService.getScriptProperties();
    var raw = props.getProperty('SNOV_400_BACKOFF_UNTIL');
    if (!raw) return { active: false, remainingMs: 0, untilISO: '' };
    var until = parseInt(raw, 10);
    var now = Date.now();
    if (isNaN(until) || now >= until) {
      // Auto-clear stale flag
      try {
        props.deleteProperty('SNOV_400_BACKOFF_UNTIL');
        // Also reset counter so the next 400 starts a fresh trip cycle
        props.deleteProperty('SNOV_400_COUNT');
      } catch (_) {}
      return { active: false, remainingMs: 0, untilISO: '' };
    }
    return { active: true, remainingMs: until - now, untilISO: new Date(until).toISOString() };
  } catch (e) {
    return { active: false, remainingMs: 0, untilISO: '', error: e.message };
  }
}

function _snovBumpFailureCounter(reasonText, isCreditsOut) {
  try {
    var props = PropertiesService.getScriptProperties();
    var n = parseInt(props.getProperty('SNOV_400_COUNT') || '0', 10) + 1;
    props.setProperty('SNOV_400_COUNT', String(n));
    if (reasonText) {
      props.setProperty('SNOV_400_LAST_REASON', String(reasonText).substring(0, 200));
    }
    if (isCreditsOut) {
      props.setProperty('SNOV_400_LAST_CAUSE', 'credits_out');
    } else {
      props.setProperty('SNOV_400_LAST_CAUSE', 'request_shape_or_other');
    }
    if (n >= SNOV_400_THRESHOLD) {
      var until = Date.now() + SNOV_400_BACKOFF_MS;
      props.setProperty('SNOV_400_BACKOFF_UNTIL', String(until));
      var causeLabel = isCreditsOut
        ? 'CREDITS EXHAUSTED (vendor-side; top up at snov.io)'
        : 'request shape / unknown (likely config bug on our side)';
      Logger.log('[Sources/SnovPresence/Phase2e] Snov 400-backoff TRIPPED after ' + n +
                 ' consecutive 400s — cause: ' + causeLabel +
                 '. Disabling Snov for 1 hour (until ' + new Date(until).toISOString() +
                 '). Last response body: ' + (reasonText || '(none)').substring(0, 160));
    }
  } catch (e) {
    Logger.log('[Sources/SnovPresence/Phase2e] failure-counter bump failed: ' + e.message);
  }
}

function _snovResetFailureCounter() {
  try {
    var props = PropertiesService.getScriptProperties();
    props.deleteProperty('SNOV_400_COUNT');
    // Note: we don't clear SNOV_400_BACKOFF_UNTIL here — that auto-expires
    // via the backoff check. Resetting it on success would let a single
    // 200 immediately undo a deliberate backoff, which could oscillate.
  } catch (_) {}
}

// Internal: get a fresh Snov.io access token (cached for 50 min — tokens valid 60 min)
function _snovGetToken() {
  var props = PropertiesService.getScriptProperties();
  var cached = props.getProperty('SNOV_TOKEN_CACHE');
  if (cached) {
    try {
      var p = JSON.parse(cached);
      if ((Date.now() - p.ts) < 50 * 60000) return p.token;
    } catch (_) {}
  }
  var userId = props.getProperty('SNOV_API_USER_ID');
  var secret = props.getProperty('SNOV_API_SECRET');
  if (!userId || !secret) return null;
  try {
    var res = UrlFetchApp.fetch('https://api.snov.io/v1/oauth/access_token', {
      method: 'post',
      payload: 'grant_type=client_credentials&client_id=' + userId + '&client_secret=' + secret,
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return null;
    var j = JSON.parse(res.getContentText());
    if (!j.access_token) return null;
    try { props.setProperty('SNOV_TOKEN_CACHE', JSON.stringify({ token: j.access_token, ts: Date.now() })); } catch (_) {}
    return j.access_token;
  } catch (e) {
    Logger.log('[Sources/SnovToken] error: ' + e.message);
    return null;
  }
}

// ─── 14. CONTEXT-AWARE MULTI-SOURCE — the new orchestrator ────────────────
//
// Replaces resolveDomainMultiSource() for callers that have richer context.
// Returns the highest-confidence domain by combining:
//   - Apollo organizations search (handles same-name disambiguation)
//   - Snov.io B2B presence (tiebreaker — real company has data)
//   - Multi-source vote (Clearbit + DDG + GitHub + Gemini)
//
// CRITICAL: when multiple candidates score similarly, returns ALL of them in
// `allCandidates[]` so the caller can show user a picker. This is the cure for
// the "Pronto → wrong company" failure mode.
// ── ORG-TOKEN OVERLAP HELPER (S2, 2026-06-12-sheet-truth) ──────────────────
//
// Pure helper: does a candidate domain have any alpha-token overlap with the
// sheet org name? Uses the same algorithm as _orgDomainGateRejects (tokens
// >= 4 chars, alpha-only, case-insensitive) so the two seams stay in sync.
// Returns true when there IS overlap (keep), false when ZERO overlap (drop).
// Reused by resolveDomainContextual to filter candidates at generation time,
// not just at acceptance time — closes the "offerx never competes" case.
//
// PATCH 2026-06-13-orggate-substr: delegates to _orgTokenOverlapSubstr
// (EmailFinalizer.gs) for substring-containment matching so all three gate
// seams (gate, contextual resolver, snov-boost) share one implementation.
//
// @param {string} orgName - sheet ORGANIZATION verbatim
// @param {string} domain  - candidate domain
// @returns {boolean} true = org↔domain overlap; false = zero overlap (drop)
function _domainHasOrgOverlap(orgName, domain) {
  var orgStr = String(orgName || '').trim();
  if (!orgStr) return true;  // no org context — cannot filter
  var domStr = String(domain || '').trim().toLowerCase();
  if (!domStr || domStr.indexOf('.') < 0) return true;  // malformed — pass through
  var orgTokens = orgStr.toLowerCase().split(/[^a-z]+/).filter(function(t) { return t.length >= 4; });
  if (orgTokens.length === 0) return true;  // org tokenizes to nothing — pass through
  var domainParts = domStr.split('.');
  var domainTokens = domainParts.filter(function(t) { return t.length >= 4; });
  if (domainTokens.length === 0) return true;  // short domain tokens — cannot filter
  // Delegate to shared substring-containment helper (2026-06-13-orggate-substr)
  return _orgTokenOverlapSubstr(orgTokens, domainTokens);
}

// ── SNOV-BOOST ORG CORROBORATION (2026-06-12-snov-collision-guard) ─────────
//
// Pure helper: may the Snov B2B-presence score boost apply for this candidate?
// Snov's company index holds many same-named companies, so employee presence
// at a domain — even under a matching company name — is NOT proof the domain
// belongs to the lead org. Tokenization mirrors _orgDomainGateRejects and
// _domainHasOrgOverlap (alpha tokens >= 4 chars, case-insensitive, exact
// equality) so all three seams stay in sync.
//
// Decision ladder (pass-through philosophy mirrors the gate: block only on
// positive zero-overlap evidence, pass when undecidable):
//   1. org empty or tokenizes to nothing → true (cannot decide)
//   2. domain has labels >= 4 chars → the domain decides: overlap → true,
//      zero overlap → false. The record's company name must NOT rescue a
//      mismatched domain — a same-name record at a foreign domain is the
//      collision failure mode itself, not corroboration of the resolution.
//   3. domain undecidable (all labels < 4 chars) → the company name decides:
//      overlap → true, zero overlap → false, name undecidable → true.
//
// @param {string} orgName - sheet ORGANIZATION verbatim
// @param {string} snovCompanyName - company_name from the Snov presence record
// @param {string} domain - candidate domain the presence record describes
// @returns {boolean} true = corroborated (boost may apply); false = collision
function _snovBoostCorroboratesOrg(orgName, snovCompanyName, domain) {
  var orgStr = String(orgName || '').trim();
  if (!orgStr) return true;
  var orgTokens = orgStr.toLowerCase().split(/[^a-z]+/).filter(function(t) { return t.length >= 4; });
  if (orgTokens.length === 0) return true;

  var domStr = String(domain || '').trim().toLowerCase();
  var domainTokens = domStr.split('.').filter(function(t) { return t.length >= 4; });
  if (domainTokens.length > 0) {
    // PATCH 2026-06-13-orggate-substr: use shared substring helper for domain path
    return _orgTokenOverlapSubstr(orgTokens, domainTokens);
  }

  // Domain undecidable (all labels <4): fall back to Snov company-name tokens.
  // Name-based fallback intentionally keeps exact-equality for tokens — the name
  // fallback is a last-ditch check and substring matching on names risks false
  // positives (e.g. "Uber" name-substring-matching "Uberflip" at a foreign domain).
  var nameTokens = String(snovCompanyName || '').toLowerCase().split(/[^a-z]+/).filter(function(t) { return t.length >= 4; });
  if (nameTokens.length === 0) return true;
  return orgTokens.some(function(ot) {
    return nameTokens.some(function(nt) { return ot === nt; });
  });
}

function resolveDomainContextual(orgName, contextHints) {
  if (!orgName) return null;
  contextHints = contextHints || {};

  // Step 1: ask Apollo orgs — most reliable disambiguation (multiple results sorted by Apollo's own internal ranking + our context scoring)
  var apolloOrgs = resolveDomainApolloOrgs(orgName, contextHints);
  var apolloCandidates = (apolloOrgs && apolloOrgs.candidates) || [];

  // Step 2: gather domains from the existing 4 free sources
  var multi = resolveDomainMultiSource(orgName, contextHints.firstName, contextHints.lastName);

  // Step 3: collect ALL unique candidate domains
  // S2 (2026-06-12-sheet-truth): drop zero-org-overlap domains at GENERATION time —
  // before scoring begins. This closes the "offerx.co.uk never competes" case where
  // a Snov name-collision returned a wrong-org domain that then anchored research.
  // Pure log on drop (no throw); if ALL candidates are zero-overlap the resolver
  // returns null → existing NEEDS_EMAIL_REVIEW path in EmailFinalizer.
  var domains = {};  // domain → { sources: [], scoreBoost: 0 }
  apolloCandidates.forEach(function(c) {
    if (!_domainHasOrgOverlap(orgName, c.domain)) {
      Logger.log('[DOMAIN_RESOLVE] dropped ' + c.domain + ' no org overlap (org="' + orgName + '")');
      return;
    }
    if (!domains[c.domain]) domains[c.domain] = { sources: [], score: 0 };
    domains[c.domain].sources.push('apollo_orgs');
    domains[c.domain].score += 0.30 + c.score;  // Apollo is high-trust
    domains[c.domain].apolloMeta = c;
  });
  if (multi && multi.domain) {
    if (_domainHasOrgOverlap(orgName, multi.domain)) {
      if (!domains[multi.domain]) domains[multi.domain] = { sources: [], score: 0 };
      multi.sources.forEach(function(s) {
        if (domains[multi.domain].sources.indexOf(s) < 0) domains[multi.domain].sources.push(s);
      });
      domains[multi.domain].score += multi.confidence;
    } else {
      Logger.log('[DOMAIN_RESOLVE] dropped ' + multi.domain + ' no org overlap (org="' + orgName + '")');
    }
  }
  // Also include all per-source results separately so we don't miss any candidate
  if (multi && multi.rawResults) {
    multi.rawResults.forEach(function(r) {
      if (!_domainHasOrgOverlap(orgName, r.domain)) {
        Logger.log('[DOMAIN_RESOLVE] dropped ' + r.domain + ' no org overlap (org="' + orgName + '")');
        return;
      }
      if (!domains[r.domain]) domains[r.domain] = { sources: [r.source], score: r.confidence };
    });
  }

  if (Object.keys(domains).length === 0) {
    Logger.log('[Sources/Contextual] no candidates for ' + orgName);
    return null;
  }

  // Step 4: Snov.io B2B presence check on each candidate (the tiebreaker)
  var domainKeys = Object.keys(domains);
  for (var i = 0; i < domainKeys.length && i < 6; i++) {  // cap to 6 to protect Snov quota
    var d = domainKeys[i];
    var presence = verifySnovDomainPresence(d);
    if (presence) {
      domains[d].snov = presence;
      if (presence.isRealB2B) {
        // SNOV-COLLISION GUARD (2026-06-12-snov-collision-guard): the presence
        // score boost applies only when the record corroborates the lead org —
        // Snov indexes many same-named companies, and an uncorroborated hit
        // at a foreign domain previously anointed a wrong-org winner.
        if (_snovBoostCorroboratesOrg(orgName, presence.companyName, d)) {
          domains[d].score += 0.40;  // very strong signal
          domains[d].sources.push('snov_b2b_confirmed');
        } else {
          Logger.log('[DOMAIN_RESOLVE] snov collision skipped ' + d +
                     ' (org="' + orgName + '", snov company="' + (presence.companyName || '') + '")');
          domains[d].sources.push('snov_collision_skipped');
        }
      } else if (presence.totalEmails > 0 && presence.realEmployees === 0) {
        // Domain has emails in Snov but none look like real employees — penalty
        domains[d].score -= 0.10;
        domains[d].sources.push('snov_no_real_emps');
      }
    }
  }

  // Step 5: sort, pick winner, return ALL for caller-visible disambiguation
  var sorted = domainKeys.map(function(d) {
    return Object.assign({ domain: d }, domains[d]);
  }).sort(function(a, b) { return b.score - a.score; });

  var winner = sorted[0];

  // MX-gate the winner
  var mxOk = verifyMxRecord(winner.domain);
  if (!mxOk.hasMx) {
    Logger.log('[Sources/Contextual] winner ' + winner.domain + ' has no MX — trying next');
    for (var j = 1; j < sorted.length; j++) {
      var mxNext = verifyMxRecord(sorted[j].domain);
      if (mxNext.hasMx) { winner = sorted[j]; break; }
    }
  }

  Logger.log('[Sources/Contextual] ' + orgName + ' → ' + winner.domain +
             ' (score=' + winner.score.toFixed(2) + ', sources=' + winner.sources.join('+') +
             ', alternatives=' + (sorted.length - 1) + ')');

  return {
    domain: winner.domain,
    confidence: Math.min(0.95, winner.score),
    sources: winner.sources,
    snovPresence: winner.snov,
    apolloMeta: winner.apolloMeta,
    allCandidates: sorted.slice(0, 5).map(function(c) {
      return { domain: c.domain, score: c.score, sources: c.sources };
    })
  };
}

// ─── 15. SNOV BALANCE PROBE — menuPingSnov ────────────────────────────────
//
// PATCH 2026-06-13-snov-ping: free, uncached, read-only probe of the Snov
// balance endpoint to confirm credits are live after a refill.
//
// Reuses _snovGetToken() (defined above) for OAuth — does NOT re-implement auth.
// Calls GET https://api.snov.io/v1/get-balance?access_token=<token>
// which is documented as free (does not consume enrichment credits) and
// directly exposes the remaining credit balance.
//
// Returns a plain object (never throws):
//   {
//     ok:            boolean,   // true = HTTP 200 + balance parseable
//     httpCode:      number,    // raw HTTP response code
//     balance:       number|null, // credits remaining (null if unreadable)
//     creditsOut:    boolean,   // true if response mentions ran-out language
//     tokenObtained: boolean,   // false means SNOV_API_USER_ID/SECRET not set
//     error:         string|null,
//     ts:            string     // ISO timestamp
//   }
//
// Side-effect: NONE — does NOT write to SNOV_400 breaker properties.
// (If you want the breaker state refreshed on a clean success you must call
// _snovResetFailureCounter() separately — this probe deliberately skips it
// so a single balance check cannot clear a deliberate backoff.)
//
function menuPingSnov() {
  var ts = new Date().toISOString();
  try {
    // Step 1: get OAuth token (reuses existing helper — never throws)
    var token = _snovGetToken();
    if (!token) {
      return {
        ok: false,
        httpCode: 0,
        balance: null,
        creditsOut: false,
        tokenObtained: false,
        error: 'could not obtain Snov access token — check SNOV_API_USER_ID / SNOV_API_SECRET in Script Properties',
        ts: ts
      };
    }

    // Step 2: call the balance endpoint — free, does not consume enrichment credits
    var url = 'https://api.snov.io/v1/get-balance?access_token=' + encodeURIComponent(token);
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var code = res.getResponseCode();
    var body = (res.getContentText() || '');

    Logger.log('[SnovPing] HTTP ' + code + ' body=' + body.substring(0, 300));

    // Check for credits-out language (same regex as verifySnovDomainPresence)
    var creditsOut = /credits|recharge|order more/i.test(body);

    if (code !== 200) {
      return {
        ok: false,
        httpCode: code,
        balance: null,
        creditsOut: creditsOut,
        tokenObtained: true,
        error: 'HTTP ' + code + ': ' + body.substring(0, 200),
        ts: ts
      };
    }

    // Parse balance from response.
    // Snov v1/get-balance wraps the value: { "success": true, "data": { "balance": "50.00", ... } }
    // Some API docs show top-level { "balance": <number> } — check both shapes.
    var balance = null;
    var parseError = null;
    try {
      var j = JSON.parse(body);
      if (j && j.data && typeof j.data.balance !== 'undefined') {
        // v1 wrapped shape: { data: { balance: "50.00", ... } }
        balance = parseFloat(j.data.balance);
      } else if (j && typeof j.balance !== 'undefined') {
        // flat shape fallback
        balance = parseFloat(j.balance);
      } else if (j && typeof j.credits !== 'undefined') {
        balance = parseFloat(j.credits);
      } else {
        parseError = 'balance field not found in response: ' + body.substring(0, 120);
      }
    } catch (parseEx) {
      parseError = 'JSON parse failed: ' + parseEx.message + ' body=' + body.substring(0, 120);
    }

    return {
      ok: (balance !== null && !creditsOut),
      httpCode: code,
      balance: balance,
      creditsOut: creditsOut,
      tokenObtained: true,
      error: parseError,
      ts: ts
    };
  } catch (e) {
    return {
      ok: false,
      httpCode: 0,
      balance: null,
      creditsOut: false,
      tokenObtained: false,
      error: 'threw: ' + e.message,
      ts: ts
    };
  }
}

// ─── DOMAIN CACHE HELPERS ──────────────────────────────────────────────────
//
// Generic per-source cache keyed by org name (prefixes CB_, DDG_, GH_,
// MULTI_). Returns undefined on cache miss (so caller can distinguish
// "haven't tried yet" from "tried and got null"). Backed by the
// _vendorCache helpers since 2026-06-12-cacheservice-migration; the
// {value, ts, ttlDays} entry shape is unchanged.

function _getDomainCache(prefix, orgName) {
  var key = prefix + orgName.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 80);
  var p = _vendorCacheGet(key);
  if (!p) return undefined;
  var ttlDays = p.ttlDays || 30;
  var ageDays = (Date.now() - p.ts) / 86400000;
  if (ageDays >= ttlDays) return undefined;
  return p.value;
}

function _setDomainCache(prefix, orgName, value, ttlDays) {
  var key = prefix + orgName.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 80);
  _vendorCachePut(key, {
    value: value,
    ts: Date.now(),
    ttlDays: ttlDays || 30
  }, (ttlDays || 30) * 86400);
}
