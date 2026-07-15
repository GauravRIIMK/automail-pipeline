/**
 * ============================================================
 * DomainPatternDiscovery.gs — Dynamic email-pattern research
 * (Patch 2026-05-12)
 *
 * THE PROBLEM:
 *   The MSD's curated DOMAIN_PATTERN_MAP has top-100 employers, but the
 *   long tail of small/medium companies is unknown. For an unknown domain
 *   like "buybuyhome.in" or "axeloop.co", MSD can't auto-pick because no
 *   curated pattern exists.
 *
 * THE SOLUTION:
 *   When MSD encounters an uncached domain, dynamically discover its
 *   email pattern via:
 *     1. Hunter Domain Search (already in pipeline) — public-web-scraped
 *     2. GitHub commit-email mining — employees commit with corp emails
 *     3. Gemini grounded research — LLM web search for "email format used
 *        by employees at <domain>"
 *   Ensemble: if ≥2 sources agree, confidence is high (0.80+). Store the
 *   result in the DomainPatterns sheet so the next lookup is instant.
 *
 * SELF-GROWING: every new domain you encounter gets researched ONCE then
 *   cached forever. Over time, the dynamic-learned map will dwarf the
 *   static curated map and accuracy compounds.
 *
 * Entry: discoverDomainPattern(domain) → { pattern, confidence, sources, cached }
 *
 * Cached results in `DomainPatterns` sheet:
 *   [Domain, Pattern, Confidence, Sources, Discovered_At, Sample_Emails]
 * ============================================================
 */

var DOMAIN_PATTERNS_SHEET = 'DomainPatterns';
var DDPD_TTL_DAYS = 90;      // re-discover positive (pattern found) entries older than this
var DDPD_NEG_TTL_DAYS = 1;   // re-discover negative (no pattern) entries after just 1 day

// ─── PUBLIC ENTRY ─────────────────────────────────────────────────────────

/**
 * Returns the email pattern for a domain. Lookup chain:
 *   1. Static DOMAIN_PATTERN_MAP (MultiSignalDisambiguator.gs)
 *   2. Cached DomainPatterns sheet (dynamic-learned)
 *   3. Live discovery via Hunter + GitHub + Gemini grounded research
 *
 * @param {string} domain  e.g., 'amazon.com'
 * @returns {Object|null} { pattern, confidence, sources, cached, sampleEmails }
 */
function discoverDomainPattern(domain, lookupOnly) {
  if (!domain) return null;
  domain = domain.toLowerCase().trim();

  // ─── Tier 1: static curated map (instant) ──
  if (typeof DOMAIN_PATTERN_MAP !== 'undefined' && DOMAIN_PATTERN_MAP[domain]) {
    return {
      pattern: DOMAIN_PATTERN_MAP[domain].pattern,
      confidence: DOMAIN_PATTERN_MAP[domain].confidence,
      sources: ['curated'],
      cached: true,
      tier: 'curated'
    };
  }

  // ─── Tier 2: dynamic-learned cache ──
  var cached = _ddpdLoadFromSheet(domain);
  if (cached) {
    // ★SELF-OBSERVED GROUND TRUTH (2026-06-24): a pattern inferred from one of OUR OWN
    // pipeline-confirmed addresses (Reoon 'safe' on a real mailbox, or a human-locked
    // email) is ground truth, not a web guess. It NEVER expires and always wins — a
    // later Hunter/Gemini guess must not override what we have directly observed.
    if ((cached.sources || []).indexOf('self_observed') >= 0 && cached.pattern) {
      cached.cached = true;
      cached.tier = 'self_observed';
      return cached;
    }
    // Honor TTL — positive hits (pattern found) expire after DDPD_TTL_DAYS (90d);
    // negative hits (no pattern) expire after DDPD_NEG_TTL_DAYS (1d) so a new
    // employer email format discovered tomorrow doesn't stay suppressed for 90 days.
    var cachedPattern = cached.pattern;
    var ttlDays = (cachedPattern && cachedPattern.length > 0) ? DDPD_TTL_DAYS : DDPD_NEG_TTL_DAYS;
    var ageDays = (Date.now() - cached.discoveredAtMs) / (86400 * 1000);
    if (ageDays < ttlDays) {
      cached.cached = true;
      cached.tier = 'dynamic_cached';
      return cached;
    }
    Logger.log('[DDPD] cached entry for ' + domain + ' is ' + ageDays.toFixed(0) + 'd old' +
               ' (ttl=' + ttlDays + 'd, ' + (cachedPattern ? 'positive' : 'negative') + '), re-discovering');
  }

  // ─── LOOKUP-ONLY (2026-06-24): callers on a hot/fallback path (e.g. the email
  // finalizer's constructed tier) want only the CHEAP cached/curated answer — they
  // must NOT trigger live Hunter/GitHub/Gemini discovery (slow + spends API quota)
  // and must NOT write a negative-cache row. Return null so the caller falls back. ──
  if (lookupOnly) return null;

  // ─── Tier 3: live ensemble discovery ──
  var discovery = _ddpdLiveDiscover(domain);
  if (discovery && discovery.pattern) {
    _ddpdSaveToSheet(domain, discovery);
    discovery.cached = false;
    discovery.tier = 'live_discovered';
    return discovery;
  }

  // Negative-cache: record that we tried and failed (1-day TTL on negatives)
  _ddpdSaveToSheet(domain, { pattern: null, confidence: 0, sources: ['no_signal'],
                              sampleEmails: [], discoveredAtMs: Date.now() });
  return null;
}

// ─── Live discovery engine (the ensemble) ─────────────────────────────────

function _ddpdLiveDiscover(domain) {
  var signals = [];

  // ── Signal A: Hunter Domain Search ──
  try {
    if (typeof fetchHunterPattern === 'function') {
      var hp = fetchHunterPattern(domain);
      if (hp) {
        signals.push({ source: 'hunter', pattern: _ddpdNormalizePattern(hp), weight: 0.45 });
      }
    }
  } catch (e) { Logger.log('[DDPD] hunter failed: ' + e.message); }

  // ── Signal B: GitHub commit-email mining ──
  try {
    if (typeof fetchPatternFromGithubCommits === 'function') {
      var gh = fetchPatternFromGithubCommits(domain);
      if (gh && gh.pattern) {
        signals.push({ source: 'github', pattern: _ddpdNormalizePattern(gh.pattern), weight: 0.35 });
      }
    }
  } catch (e) { Logger.log('[DDPD] github failed: ' + e.message); }

  // ── Signal C: Gemini grounded research ──
  try {
    var llm = _ddpdGeminiResearch(domain);
    if (llm && llm.pattern) {
      signals.push({ source: 'gemini', pattern: llm.pattern, weight: 0.35,
                     sampleEmails: llm.sampleEmails || [] });
    }
  } catch (e) { Logger.log('[DDPD] gemini failed: ' + e.message); }

  if (signals.length === 0) return null;

  // ─── Ensemble: vote by pattern, weighted by source ──
  var patternVotes = {};
  var sampleEmails = [];
  signals.forEach(function(s) {
    patternVotes[s.pattern] = (patternVotes[s.pattern] || 0) + s.weight;
    if (s.sampleEmails) sampleEmails = sampleEmails.concat(s.sampleEmails.slice(0, 3));
  });

  var winningPattern = null;
  var winningScore = 0;
  Object.keys(patternVotes).forEach(function(p) {
    if (patternVotes[p] > winningScore) {
      winningPattern = p;
      winningScore = patternVotes[p];
    }
  });
  if (!winningPattern) return null;

  // Confidence:
  //   - 3 sources agree on same pattern → 0.90
  //   - 2 sources agree                  → 0.78
  //   - 1 source                          → 0.62 (with the source's intrinsic credibility)
  var agreeingCount = signals.filter(function(s) { return s.pattern === winningPattern; }).length;
  var confidence;
  if (agreeingCount >= 3)      confidence = 0.90;
  else if (agreeingCount === 2) confidence = 0.78;
  else                          confidence = 0.62;

  return {
    pattern: winningPattern,
    confidence: confidence,
    sources: signals.filter(function(s){return s.pattern===winningPattern;}).map(function(s){return s.source;}),
    sampleEmails: sampleEmails.slice(0, 5),
    allSignals: signals,
    discoveredAtMs: Date.now()
  };
}

// ─── Gemini-based grounded research ──────────────────────────────────────
// Asks Gemini what email format the domain uses, with structured-JSON response.
// In ideal world we'd use grounded search but Apps Script can't enable it
// through UrlFetchApp — Gemini's own knowledge cutoff covers most well-known
// employers, plus the model can reason about pattern based on org type.

function _ddpdGeminiResearch(domain) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) return null;
  var prompt = 'You are an email-pattern researcher for B2B sales outreach.\n\n' +
    'Domain: ' + domain + '\n\n' +
    'Task: identify the email format this company uses for employee addresses.\n' +
    'Common patterns:\n' +
    '  {first}.{last}   → john.doe@domain\n' +
    '  {f}{last}        → jdoe@domain  (first-initial + lastname, no separator)\n' +
    '  {first}{last}    → johndoe@domain (concatenated, no separator)\n' +
    '  {first}_{last}   → john_doe@domain\n' +
    '  {first}.{l}      → john.d@domain\n' +
    '  {first}          → john@domain (single name policy)\n' +
    '  {last}.{first}   → doe.john@domain\n' +
    '\n' +
    'Consider: company name, geography (Indian companies often use first.last; ' +
    'McKinsey uses underscores; Meta uses flast), employee count (small startups ' +
    'often use first@), industry conventions.\n\n' +
    'Return ONLY this JSON shape (no prose, no markdown):\n' +
    '{"pattern":"<one of the patterns above>","confidence":<0.0-1.0>,"reasoning":"<one short sentence>","sampleEmails":["<example>","<example>"]}\n\n' +
    'If you genuinely have no idea, return {"pattern":null,"confidence":0,"reasoning":"unknown"}.';

  try {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(apiKey);
    var payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 400 }
    };
    var res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify(payload), muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      Logger.log('[DDPD-Gemini] HTTP ' + res.getResponseCode() + ': ' + res.getContentText().substring(0, 200));
      return null;
    }
    var json = JSON.parse(res.getContentText());
    var txt = json && json.candidates && json.candidates[0]
            && json.candidates[0].content && json.candidates[0].content.parts
            && json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text;
    if (!txt) return null;
    var parsed = JSON.parse(txt);
    if (!parsed.pattern) return null;
    return {
      pattern: _ddpdNormalizePattern(parsed.pattern),
      confidence: parseFloat(parsed.confidence) || 0.5,
      reasoning: parsed.reasoning || '',
      sampleEmails: parsed.sampleEmails || []
    };
  } catch (e) {
    Logger.log('[DDPD-Gemini] error: ' + e.message);
    return null;
  }
}

// ─── Normalize various pattern representations to our canonical tokens ───

function _ddpdNormalizePattern(p) {
  if (!p) return null;
  p = (p + '').toLowerCase().trim();
  // Hunter often returns {first}.{last}; sometimes 'first.last' or 'fl' shorthand
  if (p === 'first.last' || p === '{first}.{last}') return '{first}.{last}';
  if (p === 'flast' || p === 'fl' || p === '{f}{last}') return '{f}{last}';
  if (p === 'firstlast' || p === '{first}{last}') return '{first}{last}';
  if (p === 'first_last' || p === '{first}_{last}') return '{first}_{last}';
  if (p === 'first' || p === '{first}') return '{first}';
  if (p === 'first.l' || p === '{first}.{l}') return '{first}.{l}';
  if (p === 'last.first' || p === '{last}.{first}') return '{last}.{first}';
  if (p === 'f.last' || p === '{f}.{last}') return '{f}.{last}';
  if (p === 'lastf' || p === '{last}{f}') return '{last}{f}';
  // Pass through if already canonical
  if (p.indexOf('{') >= 0) return p;
  return null;
}

// ─── DomainPatterns sheet — dynamic-learned cache ────────────────────────

function _ddpdEnsureSheet(ss) {
  var sheet = ss.getSheetByName(DOMAIN_PATTERNS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(DOMAIN_PATTERNS_SHEET);
    sheet.appendRow(['Domain', 'Pattern', 'Confidence', 'Sources', 'Discovered_At', 'Sample_Emails']);
    sheet.getRange(1, 1, 1, 6).setFontWeight('bold');
  }
  return sheet;
}

function _ddpdLoadFromSheet(domain) {
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = _ddpdEnsureSheet(ss);
    if (sheet.getLastRow() < 2) return null;
    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues();
    for (var i = 0; i < data.length; i++) {
      if ((data[i][0] || '').toString().toLowerCase().trim() === domain) {
        var pattern = (data[i][1] || '').toString() || null;
        return {
          pattern: pattern,
          confidence: parseFloat(data[i][2]) || 0,
          sources: (data[i][3] || '').toString().split(',').map(function(s){return s.trim();}).filter(Boolean),
          discoveredAtMs: data[i][4] ? new Date(data[i][4]).getTime() : 0,
          sampleEmails: (data[i][5] || '').toString().split('|').map(function(s){return s.trim();}).filter(Boolean)
        };
      }
    }
  } catch (e) { Logger.log('[DDPD] load failed: ' + e.message); }
  return null;
}

function _ddpdSaveToSheet(domain, discovery) {
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = _ddpdEnsureSheet(ss);
    var lastRow = sheet.getLastRow();
    // Upsert: find existing row OR append new
    var existingRow = 0;
    if (lastRow >= 2) {
      var keys = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      for (var i = 0; i < keys.length; i++) {
        if ((keys[i][0] || '').toString().toLowerCase().trim() === domain) {
          existingRow = i + 2;
          break;
        }
      }
    }
    var row = [
      domain,
      discovery.pattern || '',
      discovery.confidence || 0,
      (discovery.sources || []).join(','),
      new Date(discovery.discoveredAtMs || Date.now()).toISOString(),
      (discovery.sampleEmails || []).slice(0, 5).join(' | ')
    ];
    if (existingRow > 0) {
      // ★PRESERVE GROUND TRUTH (2026-06-24): never let a non-self_observed discovery
      // (Hunter/GitHub/Gemini guess) overwrite a self_observed (pipeline-confirmed)
      // pattern. Self_observed → self_observed is allowed (refresh sample/timestamp).
      var _existingSources = (sheet.getRange(existingRow, 4).getValue() || '').toString();
      var _incomingIsSelf = (discovery.sources || []).indexOf('self_observed') >= 0;
      if (_existingSources.indexOf('self_observed') >= 0 && !_incomingIsSelf) {
        Logger.log('[DDPD] preserving self_observed pattern for ' + domain +
                   ' — refused overwrite by [' + (discovery.sources || []).join(',') + ']');
        return;
      }
      // ★CONFLICT GUARD (adversarial-review @286): two self_observed observations at the
      // same domain with DIFFERENT inferred patterns → KEEP THE FIRST. Last-write-wins would
      // let one unusual address (a contractor, a legacy mailbox) flip an established pattern
      // with no majority vote. Identical pattern → harmless refresh, allowed.
      if (_existingSources.indexOf('self_observed') >= 0 && _incomingIsSelf) {
        var _existingPattern = (sheet.getRange(existingRow, 2).getValue() || '').toString();
        var _incomingPattern = (discovery.pattern || '').toString();
        if (_existingPattern && _incomingPattern && _existingPattern !== _incomingPattern) {
          Logger.log('[DDPD] self_observed CONFLICT for ' + domain + ': keeping "' + _existingPattern +
                     '", refused replacement by "' + _incomingPattern + '" (sample ' +
                     ((discovery.sampleEmails || [])[0] || '?') + ')');
          return;
        }
      }
      sheet.getRange(existingRow, 1, 1, 6).setValues([row]);
    } else {
      sheet.appendRow(row);
    }
  } catch (e) { Logger.log('[DDPD] save failed: ' + e.message); }
}

// ─── Diagnostic — call from /exec?action=ddpd_test ───────────────────────

function ddpdTest(domain) {
  var result = discoverDomainPattern(domain);
  return {
    domain: domain,
    discovery: result,
    cachedNow: !!(result && result.cached)
  };
}

// ─── PATTERN ↔ EMAIL (2026-06-24, accuracy increment #1) ─────────────────────
//
// Two pure helpers + a self-learning recorder that, together, let the email
// finalizer's constructed tier build the RIGHT local-part format for a domain
// (from its KNOWN pattern) instead of a blind {first}.{last}, AND grow the
// pattern map from our own pipeline-confirmed addresses (self_observed).

/**
 * Build an email address from a canonical pattern token + name parts.
 * Returns '' when it can't (no first name / unknown token / no domain).
 * The token vocabulary matches _ddpdNormalizePattern's canonical outputs.
 *
 * @param {string} pattern  e.g. '{first}.{last}'
 * @param {string} fn        first name (already lowercased a-z, but we re-clean)
 * @param {string} ln        last name (may be empty)
 * @param {string} domain    e.g. 'acme.com'
 * @returns {string} 'john.doe@acme.com' or ''
 */
function _applyEmailPattern(pattern, fn, ln, domain) {
  if (!pattern || !domain) return '';
  fn = (fn || '').toString().toLowerCase().replace(/[^a-z]/g, '');
  ln = (ln || '').toString().toLowerCase().replace(/[^a-z]/g, '');
  if (!fn) return '';
  var fi = fn.charAt(0);
  var li = ln ? ln.charAt(0) : '';
  var lp;
  switch (pattern) {
    case '{first}.{last}': lp = ln ? (fn + '.' + ln) : fn; break;
    case '{f}{last}':      lp = ln ? (fi + ln) : fn; break;
    case '{first}{last}':  lp = ln ? (fn + ln) : fn; break;
    case '{first}_{last}': lp = ln ? (fn + '_' + ln) : fn; break;
    case '{first}.{l}':    lp = ln ? (fn + '.' + li) : fn; break;
    case '{last}.{first}': lp = ln ? (ln + '.' + fn) : fn; break;
    case '{f}.{last}':     lp = ln ? (fi + '.' + ln) : fn; break;
    case '{last}{f}':      lp = ln ? (ln + fi) : fn; break;
    case '{first}':        lp = fn; break;
    default: return '';   // unknown token → caller falls back to its default
  }
  return lp + '@' + domain.toString().toLowerCase().trim();
}

/**
 * Reverse of _applyEmailPattern: given a CONFIRMED address + the person's name,
 * infer which canonical pattern produced it. Returns null when the local-part
 * doesn't match any known pattern (nickname / random / role account) — we
 * deliberately DON'T learn from those (they'd pollute the map for other people).
 *
 * @param {string} email   'john.doe@acme.com'
 * @param {string} fn      first name
 * @param {string} ln      last name (may be empty)
 * @returns {string|null}  '{first}.{last}' etc., or null
 */
function _inferEmailPattern_(email, fn, ln) {
  if (!email) return null;
  var _rawLp = (email.toString().split('@')[0] || '').toLowerCase();
  // A digit in the local-part is almost always a personal DISAMBIGUATION suffix
  // (john.doe2, rkumar7) — NOT a company-wide format. Don't learn/generalize from it
  // (adversarial-review @286: stripping digits would mis-learn 'john1' as '{first}').
  if (/[0-9]/.test(_rawLp)) return null;
  var lp = _rawLp.replace(/[^a-z._]/g, '');
  fn = (fn || '').toString().toLowerCase().replace(/[^a-z]/g, '');
  ln = (ln || '').toString().toLowerCase().replace(/[^a-z]/g, '');
  if (!lp || !fn) return null;
  var fi = fn.charAt(0);
  var li = ln ? ln.charAt(0) : '';
  if (ln) {
    if (lp === fn + '.' + ln) return '{first}.{last}';
    if (lp === fi + ln)       return '{f}{last}';
    if (lp === fn + ln)       return '{first}{last}';
    if (lp === fn + '_' + ln) return '{first}_{last}';
    if (lp === fn + '.' + li) return '{first}.{l}';
    if (lp === ln + '.' + fn) return '{last}.{first}';
    if (lp === fi + '.' + ln) return '{f}.{last}';
    if (lp === ln + fi)       return '{last}{f}';
  }
  if (lp === fn) return '{first}';
  return null;
}

/**
 * Learn the email pattern for a domain from a GROUND-TRUTH-confirmed address
 * (Reoon-'safe' mailbox, or a human-locked email). Upserts the DomainPatterns
 * sheet with source 'self_observed' (highest trust, non-expiring). Cheap:
 *   - dedup-guarded to at most one learn-write per domain per 12h (CacheService)
 *   - skips unrecognized local-parts (nicknames) so the map stays clean
 *   - skips if the same self_observed pattern is already recorded
 *
 * @returns {boolean} true if a new/updated self_observed row was written
 */
function _recordObservedPattern_(domain, fn, ln, email) {
  if (!domain || !email) return false;
  domain = domain.toString().toLowerCase().trim();
  var guardKey = 'OBSPAT_' + domain;
  try {
    if (typeof CacheService !== 'undefined') {
      var c0 = CacheService.getScriptCache();
      if (c0 && c0.get(guardKey)) return false;   // learned for this domain recently
    }
  } catch (_g) {}

  var pat = _inferEmailPattern_(email, fn, ln);
  if (!pat) return false;   // unrecognized local-part — don't pollute the map

  // Don't churn the sheet if this exact self_observed pattern is already recorded.
  try {
    var existing = (typeof _ddpdLoadFromSheet === 'function') ? _ddpdLoadFromSheet(domain) : null;
    if (existing && existing.pattern === pat &&
        (existing.sources || []).indexOf('self_observed') >= 0) {
      try { CacheService.getScriptCache().put(guardKey, '1', 12 * 3600); } catch (_p1) {}
      return false;
    }
  } catch (_e1) {}

  try {
    _ddpdSaveToSheet(domain, {
      pattern: pat,
      confidence: 0.95,
      sources: ['self_observed'],
      sampleEmails: [email.toString().toLowerCase()],
      discoveredAtMs: Date.now()
    });
    try { CacheService.getScriptCache().put(guardKey, '1', 12 * 3600); } catch (_p2) {}
    Logger.log('[DDPD] self_observed pattern LEARNED: ' + domain + ' → ' + pat + ' (from ' + email + ')');
    return true;
  } catch (e) {
    Logger.log('[DDPD] self_observed save failed for ' + domain + ': ' + e.message);
    return false;
  }
}
