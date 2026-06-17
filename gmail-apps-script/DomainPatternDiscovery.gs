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
function discoverDomainPattern(domain) {
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
