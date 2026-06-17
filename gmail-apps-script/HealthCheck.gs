/**
 * ============================================================
 * HealthCheck.gs — API + Service Health Probe (v2 Track F)
 * ============================================================
 *
 * Periodically probes every external dependency the pipeline relies on,
 * records pass/fail/latency per service to a "Health" sheet, and exposes
 * a pre-flight lookup so the composer can route Tier 3 directly when
 * Claude is known-down (avoiding wasted API calls + retry delay).
 *
 * Services probed:
 *   - Claude API   (Anthropic)   — minimal completion call
 *   - Gemini API   (Google AI)   — minimal generation call
 *   - Gmail        (Apps Script) — Session.getActiveUser
 *   - Drive        (Apps Script) — DriveApp.getRootFolder + LOR_DRIVE_ID read
 *
 * Schedule: installable daily trigger via `installHealthCheckTrigger()`.
 * Manual run: `runHealthCheck()` from menu / admin endpoint.
 *
 * Health sheet schema (auto-created on first run):
 *   A Timestamp     B Service       C Status        D LatencyMs     E Excerpt
 *
 *   Status values:
 *     alive            — call succeeded within budget
 *     auth_failed      — 401/403 / API key invalid
 *     quota_exhausted  — 429 / billing exceeded
 *     timeout          — exceeded HTTP timeout
 *     unreachable      — network error, DNS fail
 *     unknown          — non-2xx without clear classification
 *
 * Pre-flight rule (used by composeEmail at start of execution):
 *   - Read last Health row for service=Claude within last 6 hours.
 *   - If status ∈ {auth_failed, quota_exhausted}: SKIP Tier 1, GO DIRECT to Tier 3.
 *   - If status === 'alive' OR row is stale (>6 hr) OR no row: proceed Tier 1 normally.
 *   - Telemetry: log every pre-flight decision so we can audit.
 */

var HEALTH_SHEET_NAME = 'Health';
var HEALTH_STALE_HOURS = 6;   // ages past which we treat the last reading as unknown

// PATCH 2026-05-18: real-time freshness window for the inline pre-compose
// probe. When `shouldSkipTier1` is called and the latest probe is older than
// HEALTH_REFRESH_MINUTES, we re-probe Claude and cache for that long. This
// closes the 6-hour stale-data gap that caused Sourav's lead to silently
// fall to Tier 3 — by the time the next scheduled 6h probe ran, hours of
// leads had already been wasted on the bad path.
var HEALTH_REFRESH_MINUTES = 30;
var HEALTH_REFRESH_CACHE_KEY = '_HEALTH_INLINE_REFRESH_TS';
var HEALTH_LAST_STATE_KEY_PREFIX = '_HEALTH_LAST_STATE_';

// ─── MAIN PROBE FUNCTIONS ───────────────────────────────────────────────

/**
 * Runs all probes, writes results to Health sheet. Idempotent — safe to call
 * manually any time. Installable trigger calls this daily.
 *
 * @returns {Object} { ts, results: [{service, status, latencyMs, excerpt}, ...] }
 */
function runHealthCheck() {
  var ts = new Date().toISOString();
  Logger.log('[HealthCheck] Starting at ' + ts);
  // PATCH `-p5-vendorresilience-config` (Phase 3b): extend coverage to all
  // pipeline-critical vendors. Previously only Claude/Gemini/Gmail/Drive
  // were probed — Reoon/Snov/Hunter/Apollo failures had to be inferred from
  // pipeline logs. Each new probe is small (~50ms each on success).
  var results = [
    _probeClaude(),
    _probeGemini(),
    _probeGmail(),
    _probeDrive(),
    _probeReoon(),
    _probeSnov(),
    _probeHunter(),
    _probeApollo()
  ];
  _writeHealthRows(ts, results);
  Logger.log('[HealthCheck] Complete. Results: ' + results.map(function(r) {
    return r.service + '=' + r.status;
  }).join(', '));
  return { ts: ts, results: results };
}

// ─── INDIVIDUAL PROBES ──────────────────────────────────────────────────

function _probeClaude() {
  var start = Date.now();
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('CLAUDE_API_KEY');
  if (!key) {
    return { service: 'Claude', status: 'auth_failed', latencyMs: 0, excerpt: 'CLAUDE_API_KEY not set' };
  }
  try {
    // Minimal completion — 1 token output to minimize cost (~$0.00001 per probe)
    var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }]
      }),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    var elapsed = Date.now() - start;
    var bodyExcerpt = (res.getContentText() || '').substring(0, 200);
    if (code >= 200 && code < 300) {
      return { service: 'Claude', status: 'alive', latencyMs: elapsed, excerpt: bodyExcerpt.substring(0, 100) };
    } else if (code === 401 || code === 403) {
      return { service: 'Claude', status: 'auth_failed', latencyMs: elapsed, excerpt: bodyExcerpt };
    } else if (code === 429) {
      return { service: 'Claude', status: 'quota_exhausted', latencyMs: elapsed, excerpt: bodyExcerpt };
    } else {
      return { service: 'Claude', status: 'unknown', latencyMs: elapsed, excerpt: 'HTTP ' + code + ': ' + bodyExcerpt };
    }
  } catch (e) {
    var elapsed2 = Date.now() - start;
    var msg = (e.message || '').toLowerCase();
    var status = msg.indexOf('timed out') >= 0 || msg.indexOf('timeout') >= 0
        ? 'timeout' : 'unreachable';
    return { service: 'Claude', status: status, latencyMs: elapsed2, excerpt: e.message };
  }
}

function _probeGemini() {
  var start = Date.now();
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('GEMINI_API_KEY');
  if (!key) {
    return { service: 'Gemini', status: 'auth_failed', latencyMs: 0, excerpt: 'GEMINI_API_KEY not set' };
  }
  try {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + key;
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        contents: [{ parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 1 }
      }),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    var elapsed = Date.now() - start;
    var bodyExcerpt = (res.getContentText() || '').substring(0, 200);
    if (code >= 200 && code < 300) {
      return { service: 'Gemini', status: 'alive', latencyMs: elapsed, excerpt: bodyExcerpt.substring(0, 100) };
    } else if (code === 401 || code === 403) {
      return { service: 'Gemini', status: 'auth_failed', latencyMs: elapsed, excerpt: bodyExcerpt };
    } else if (code === 429) {
      return { service: 'Gemini', status: 'quota_exhausted', latencyMs: elapsed, excerpt: bodyExcerpt };
    } else {
      return { service: 'Gemini', status: 'unknown', latencyMs: elapsed, excerpt: 'HTTP ' + code + ': ' + bodyExcerpt };
    }
  } catch (e) {
    var elapsed2 = Date.now() - start;
    var msg = (e.message || '').toLowerCase();
    var status = msg.indexOf('timed out') >= 0 ? 'timeout' : 'unreachable';
    return { service: 'Gemini', status: status, latencyMs: elapsed2, excerpt: e.message };
  }
}

function _probeGmail() {
  var start = Date.now();
  // PATCH 2026-05-15 (post-Tier-3-smoke-test): probe the API the pipeline
  // actually uses (GmailApp), NOT Session.getActiveUser().
  //
  // Previous probe used Session.getActiveUser().getEmail() which:
  //   1. Tests a different OAuth scope (userinfo.email) than the actual
  //      pipeline (gmail.compose/modify via GmailApp).
  //   2. Returns empty string in trigger context where there's no active user.
  //   3. Can THROW in trigger context if re-auth window hasn't closed.
  // Result: false-positive 'unreachable' even when GmailApp.createDraft
  // works fine (which it did — the smoke-test draft was created successfully).
  //
  // GmailApp.getAliases() exercises the same scope as createDraft, is one of
  // the cheapest GmailApp calls, runs cleanly in trigger context with
  // executeAs:USER_DEPLOYING, and only throws on real auth failure.
  // Returns array; empty array is fine (just means no alternate send-as
  // addresses configured) and still proves Gmail API is reachable.
  try {
    var aliases = GmailApp.getAliases();
    var elapsed = Date.now() - start;
    return {
      service: 'Gmail',
      status: 'alive',
      latencyMs: elapsed,
      excerpt: 'aliases=' + (aliases ? aliases.length : 0)
    };
  } catch (e) {
    var msg = (e.message || '').toLowerCase();
    // Classify error type so the pre-flight logic can decide whether to act
    var status = (msg.indexOf('permission') >= 0 || msg.indexOf('access denied') >= 0 || msg.indexOf('not authorized') >= 0)
        ? 'auth_failed'
        : (msg.indexOf('timed out') >= 0 ? 'timeout' : 'unreachable');
    return { service: 'Gmail', status: status, latencyMs: Date.now() - start, excerpt: e.message };
  }
}

function _probeDrive() {
  var start = Date.now();
  try {
    // Probe by reading the LOR file (which the pipeline depends on for every draft)
    var lorId = PropertiesService.getScriptProperties().getProperty('LOR_DRIVE_ID');
    if (!lorId) {
      return { service: 'Drive', status: 'auth_failed', latencyMs: Date.now() - start, excerpt: 'LOR_DRIVE_ID not set' };
    }
    var file = DriveApp.getFileById(lorId);
    var name = file.getName();
    return { service: 'Drive', status: 'alive', latencyMs: Date.now() - start, excerpt: 'lor=' + name };
  } catch (e) {
    var msg = (e.message || '').toLowerCase();
    var status = (msg.indexOf('permission') >= 0 || msg.indexOf('access denied') >= 0)
        ? 'auth_failed' : 'unreachable';
    return { service: 'Drive', status: status, latencyMs: Date.now() - start, excerpt: e.message };
  }
}

// ─── PATCH `-p5-vendorresilience-config` (Phase 3b): VENDOR PROBES ──────────
//
// Per master prompt: "extend runHealthCheck to Reoon/Snov/Hunter/Apollo".
// Each probe follows the same convention as Claude/Gemini above:
//   - alive: HTTP 2xx — vendor reachable, key valid, quota available
//   - auth_failed: HTTP 401/403 with credential-looking body
//   - quota_exhausted: HTTP 429 OR 403 with body matching /credits|recharge/i
//   - unknown: any other non-2xx
//   - timeout/unreachable: transport-layer failure
//
// Cost per probe is minimal (1 lightweight API call). All probes also
// respect the Phase 2c/2d/2e circuit breakers — if the breaker is tripped,
// the probe returns the breaker status directly without re-firing the call.

function _probeReoon() {
  var start = Date.now();
  // If the Phase 2d hard-trip breaker is active, surface that directly
  // (don't re-burn an API call we already know will 403)
  if (typeof _reoonQuotaCheck === 'function') {
    var rq = _reoonQuotaCheck();
    if (rq.exhausted) {
      return { service: 'Reoon', status: 'quota_exhausted', latencyMs: Date.now() - start,
               excerpt: 'circuit breaker tripped: ' + (rq.value || '').substring(0, 100) };
    }
  }
  var props = PropertiesService.getScriptProperties();
  var keyName = (CONFIG && CONFIG.PROPERTY_KEYS && CONFIG.PROPERTY_KEYS.REOON_API_KEY) || 'REOON_API_KEY';
  var key = props.getProperty(keyName);
  if (!key) {
    return { service: 'Reoon', status: 'auth_failed', latencyMs: 0, excerpt: keyName + ' not set' };
  }
  try {
    // Reoon doesn't have a dedicated /ping — verifying a known-good throwaway
    // address (test@example.com) costs 1 quick-mode credit but gives a real
    // signal. Use Quick mode to minimize cost.
    var url = 'https://emailverifier.reoon.com/api/v1/verify?email=test%40example.com&key=' +
              encodeURIComponent(key) + '&mode=quick';
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var code = res.getResponseCode();
    var elapsed = Date.now() - start;
    var body = (res.getContentText() || '').substring(0, 200);
    if (code >= 200 && code < 300) {
      return { service: 'Reoon', status: 'alive', latencyMs: elapsed, excerpt: body.substring(0, 100) };
    }
    if (code === 403 && /credits|recharge/i.test(body)) {
      return { service: 'Reoon', status: 'quota_exhausted', latencyMs: elapsed, excerpt: body };
    }
    if (code === 401 || code === 403) {
      return { service: 'Reoon', status: 'auth_failed', latencyMs: elapsed, excerpt: body };
    }
    if (code === 429) {
      return { service: 'Reoon', status: 'quota_exhausted', latencyMs: elapsed, excerpt: body };
    }
    return { service: 'Reoon', status: 'unknown', latencyMs: elapsed, excerpt: 'HTTP ' + code + ': ' + body };
  } catch (e) {
    var msg = (e.message || '').toLowerCase();
    var status = msg.indexOf('timed out') >= 0 ? 'timeout' : 'unreachable';
    return { service: 'Reoon', status: status, latencyMs: Date.now() - start, excerpt: e.message };
  }
}

function _probeSnov() {
  var start = Date.now();
  // PATCH `-p5-phase4-prelude`: when Phase 2e backoff is active, classify by
  // the recorded cause. credits-out body = quota_exhausted (the truthful
  // label). request-shape / unknown = config_bug (surface as `unknown` so
  // user knows to investigate code). Live diagnosis on 2026-06-09 showed
  // Snov returning `unknown` while SNOV_400_LAST_CAUSE=credits_out — the
  // earlier mapping was just blunt.
  if (typeof _snovBackoffCheck === 'function') {
    var sb = _snovBackoffCheck();
    if (sb.active) {
      var props = PropertiesService.getScriptProperties();
      var lastCause = props.getProperty('SNOV_400_LAST_CAUSE') || '';
      var lastReason = props.getProperty('SNOV_400_LAST_REASON') || '';
      // PATCH `-p5-phase4-decisions`: backward-compat — LAST_CAUSE was added
      // in the amend AFTER the current backoff was tripped, so it may be
      // null even when LAST_REASON contains the credits-out body. Fall back
      // to body inspection so the probe still classifies correctly.
      var isCreditsOut = (lastCause === 'credits_out') ||
                         /credits|recharge|order more/i.test(lastReason);
      var status = isCreditsOut ? 'quota_exhausted' : 'unknown';
      var reason = isCreditsOut
        ? 'backoff active — vendor credits exhausted (top up at snov.io)'
        : 'backoff active — request shape / config issue';
      return { service: 'Snov', status: status, latencyMs: Date.now() - start,
               excerpt: reason + ' (remaining ' + Math.round(sb.remainingMs / 1000) + 's)' };
    }
  }
  var props = PropertiesService.getScriptProperties();
  var userId = props.getProperty('SNOV_API_USER_ID');
  var secret = props.getProperty('SNOV_API_SECRET');
  if (!userId || !secret) {
    return { service: 'Snov', status: 'auth_failed', latencyMs: 0, excerpt: 'SNOV_API_USER_ID or SNOV_API_SECRET not set' };
  }
  try {
    // OAuth token request is the cheapest reachability check and doubles as
    // a credential probe — invalid key → 401/403, valid → 200 with token.
    var res = UrlFetchApp.fetch('https://api.snov.io/v1/oauth/access_token', {
      method: 'post',
      payload: 'grant_type=client_credentials&client_id=' + userId + '&client_secret=' + secret,
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    var elapsed = Date.now() - start;
    var body = (res.getContentText() || '').substring(0, 200);
    if (code >= 200 && code < 300) {
      return { service: 'Snov', status: 'alive', latencyMs: elapsed,
               excerpt: 'oauth ok (token retrieved)' };
    }
    if (code === 401 || code === 403) {
      return { service: 'Snov', status: 'auth_failed', latencyMs: elapsed, excerpt: body };
    }
    if (code === 429) {
      return { service: 'Snov', status: 'quota_exhausted', latencyMs: elapsed, excerpt: body };
    }
    return { service: 'Snov', status: 'unknown', latencyMs: elapsed, excerpt: 'HTTP ' + code + ': ' + body };
  } catch (e) {
    var msg = (e.message || '').toLowerCase();
    var status = msg.indexOf('timed out') >= 0 ? 'timeout' : 'unreachable';
    return { service: 'Snov', status: status, latencyMs: Date.now() - start, excerpt: e.message };
  }
}

function _probeHunter() {
  var start = Date.now();
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('HUNTER_API_KEY');
  if (!key) {
    return { service: 'Hunter', status: 'auth_failed', latencyMs: 0, excerpt: 'HUNTER_API_KEY not set' };
  }
  try {
    // /account is the cheapest Hunter call (no enrichment, no email lookup)
    // and tells us auth status + credit remaining in one round-trip.
    var url = 'https://api.hunter.io/v2/account?api_key=' + encodeURIComponent(key);
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var code = res.getResponseCode();
    var elapsed = Date.now() - start;
    var body = (res.getContentText() || '').substring(0, 240);
    if (code >= 200 && code < 300) {
      // Extract usage stats if present so the excerpt is useful
      var excerpt = body.substring(0, 100);
      try {
        var parsed = JSON.parse(body);
        if (parsed && parsed.data && parsed.data.requests) {
          excerpt = 'searches=' + (parsed.data.requests.searches || {}).used + '/' +
                    (parsed.data.requests.searches || {}).available;
        }
      } catch (_) {}
      return { service: 'Hunter', status: 'alive', latencyMs: elapsed, excerpt: excerpt };
    }
    // PATCH `-p5-phase4-decisions`: live re-verification on 2026-06-09 showed
    // Hunter still returning auth_failed even after the keyword detection —
    // suggesting the response body doesn't match common quota patterns OR
    // the body is empty/JSON-wrapped. Surface the actual body in the log so
    // diagnosis is possible without guessing. Expanded keyword list to catch
    // more shapes Hunter uses across plans:
    //   - "monthly", "limit reached", "quota", "credits", "exhausted"
    //   - "usage", "overage", "rate", "too many", "subscription"
    //   - "plan limit", "calls per", "search limit", "verification limit"
    if (code === 401 || code === 403) {
      Logger.log('[HealthCheck/Hunter] HTTP ' + code + ' body (for diagnosis): ' + body);
      var quotaPatterns = /monthly|limit reached|quota|credits|exhausted|usage|overage|rate|too many|subscription|plan limit|calls per|search limit|verification limit/i;
      if (quotaPatterns.test(body)) {
        return { service: 'Hunter', status: 'quota_exhausted', latencyMs: elapsed, excerpt: body };
      }
      // If the body is empty or doesn't match any pattern, log it explicitly
      // so we can extend the regex next iteration
      return { service: 'Hunter', status: 'auth_failed', latencyMs: elapsed,
               excerpt: 'HTTP ' + code + ' (no quota keywords in body): ' + body };
    }
    if (code === 429 || (code === 402)) {  // Hunter returns 402 for credits exhausted
      return { service: 'Hunter', status: 'quota_exhausted', latencyMs: elapsed, excerpt: body };
    }
    return { service: 'Hunter', status: 'unknown', latencyMs: elapsed, excerpt: 'HTTP ' + code + ': ' + body };
  } catch (e) {
    var msg = (e.message || '').toLowerCase();
    var status = msg.indexOf('timed out') >= 0 ? 'timeout' : 'unreachable';
    return { service: 'Hunter', status: status, latencyMs: Date.now() - start, excerpt: e.message };
  }
}

function _probeApollo() {
  var start = Date.now();
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('APOLLO_API_KEY');
  if (!key) {
    return { service: 'Apollo', status: 'auth_failed', latencyMs: 0, excerpt: 'APOLLO_API_KEY not set' };
  }
  // PATCH `-p5-vendorresilience-config-amend` (Phase 3b amend): live diagnosis
  // on 2026-06-09 returned Apollo=unknown via the /v1/auth/health endpoint —
  // suggesting the endpoint either doesn't exist on this plan, has moved, or
  // returns a non-2xx for a different reason. Try the endpoint that the
  // pipeline ACTUALLY uses for lookups (POST /v1/organizations/search with
  // a no-op payload) as a fallback. If both return non-2xx, surface BOTH
  // HTTP codes in the excerpt so the user can see what Apollo is doing.
  var tries = [
    { name: 'auth_health',  url: 'https://api.apollo.io/v1/auth/health',
      method: 'post', payload: '{}' },
    { name: 'orgs_search',  url: 'https://api.apollo.io/v1/organizations/search',
      method: 'post', payload: JSON.stringify({ page: 1, per_page: 1 }) }
  ];
  var attempts = [];
  for (var i = 0; i < tries.length; i++) {
    var t = tries[i];
    try {
      var res = UrlFetchApp.fetch(t.url, {
        method: t.method,
        headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
        payload: t.payload,
        muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      var body = (res.getContentText() || '').substring(0, 200);
      var elapsed = Date.now() - start;
      attempts.push({ ep: t.name, code: code, body: body.substring(0, 80) });

      if (code >= 200 && code < 300) {
        return { service: 'Apollo', status: 'alive', latencyMs: elapsed,
                 excerpt: t.name + ' ok: ' + body.substring(0, 80) };
      }
      // Body-pattern classifications (Apollo overloads 403 across causes)
      if ((code === 401 || code === 403) && /payment|billing|suspended|temporarily unavailable/i.test(body)) {
        return { service: 'Apollo', status: 'quota_exhausted', latencyMs: elapsed,
                 excerpt: t.name + ' ' + code + ': ' + body };
      }
      if (code === 401 || code === 403) {
        return { service: 'Apollo', status: 'auth_failed', latencyMs: elapsed,
                 excerpt: t.name + ' ' + code + ': ' + body };
      }
      if (code === 429) {
        return { service: 'Apollo', status: 'quota_exhausted', latencyMs: elapsed,
                 excerpt: t.name + ' ' + code + ': ' + body };
      }
      // Non-classified non-2xx — fall through to try the next endpoint
    } catch (e) {
      attempts.push({ ep: t.name, threw: e.message });
    }
  }
  // Both attempts surfaced non-classified non-2xx (or threw)
  var elapsedFinal = Date.now() - start;
  var summary = attempts.map(function(a) {
    return a.ep + (a.threw ? ' threw=' + a.threw : ' code=' + a.code + ' body=' + a.body);
  }).join(' | ');
  return { service: 'Apollo', status: 'unknown', latencyMs: elapsedFinal,
           excerpt: 'tried both endpoints: ' + summary };
}

// ─── HEALTH SHEET WRITES ─────────────────────────────────────────────────

function _writeHealthRows(ts, results) {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(HEALTH_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(HEALTH_SHEET_NAME);
    sheet.appendRow(['Timestamp', 'Service', 'Status', 'LatencyMs', 'Excerpt']);
    sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
  }
  results.forEach(function(r) {
    sheet.appendRow([ts, r.service, r.status, r.latencyMs, (r.excerpt || '').substring(0, 500)]);
  });
}

// ─── PRE-FLIGHT READER (used by composeEmail) ────────────────────────────

/**
 * Returns the most recent Health row for the named service. Used by composeEmail
 * to decide whether to attempt Tier 1 (Claude) or skip to Tier 3.
 *
 * @param {string} service - 'Claude' | 'Gemini' | 'Gmail' | 'Drive'
 * @returns {Object|null} { ts, status, ageHours, latencyMs, excerpt } or null if no data
 */
function getLatestHealthForService(service) {
  try {
    // PATCH `-p3-leaduid-amend2` (Section 2.1): migrated to _svc('Sheets')
    // so the composer behavioral test can inject a synthetic Health sheet
    // with claude=quota_exhausted, triggering shouldSkipTier1=true → Tier 3
    // fallback path → no real Claude probe. RCA in changelog.
    var sheetsApp = (typeof _svc === 'function') ? _svc('Sheets') : SpreadsheetApp;
    var ss = sheetsApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(HEALTH_SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 2) return null;
    // Read last 50 rows, scan backwards for matching service
    var lastRow = sheet.getLastRow();
    var startRow = Math.max(2, lastRow - 50);
    var data = sheet.getRange(startRow, 1, lastRow - startRow + 1, 5).getValues();
    for (var i = data.length - 1; i >= 0; i--) {
      if (data[i][1] === service) {
        var ts = data[i][0];
        var ageHours = 0;
        try {
          var d = new Date(ts);
          if (!isNaN(d.getTime())) ageHours = (Date.now() - d.getTime()) / 3600000;
        } catch (_) {}
        return {
          ts: ts,
          status: data[i][2],
          ageHours: ageHours,
          latencyMs: data[i][3],
          excerpt: data[i][4]
        };
      }
    }
    return null;
  } catch (e) {
    Logger.log('[HealthCheck] getLatestHealthForService error: ' + e.message);
    return null;
  }
}

/**
 * Pre-flight decision for the composer. Returns whether to skip Tier 1 (Claude)
 * and go directly to Tier 3 (deterministic fallback).
 *
 * Rules:
 *   - No health data OR stale (>6 hr): proceed Tier 1 normally (no signal to act on)
 *   - Claude status alive: proceed Tier 1
 *   - Claude status auth_failed / quota_exhausted: SKIP to Tier 3
 *   - Claude status timeout / unreachable: proceed Tier 1 (transient — let composer try)
 *   - Claude status unknown: proceed Tier 1 (don't penalize on ambiguous signal)
 *
 * PATCH 2026-05-18: now triggers an inline refresh-probe when the latest
 * Health row is older than HEALTH_REFRESH_MINUTES. This closes the
 * "Claude broke 6 hours ago and we just noticed via Tier 3 fallback" gap
 * that hit Sourav's lead. Refresh is rate-limited via a script-property
 * timestamp so the probe fires at most once per HEALTH_REFRESH_MINUTES
 * window regardless of how many leads are in the batch.
 *
 * @returns {Object} { skipTier1: boolean, reason: string }
 */
function shouldSkipTier1() {
  var h = getLatestHealthForService('Claude');
  var freshEnough = h && h.ageHours <= (HEALTH_REFRESH_MINUTES / 60);
  if (!freshEnough) {
    var refreshed = _maybeRefreshClaudeHealth();
    if (refreshed) h = refreshed;
  }
  if (!h) return { skipTier1: false, reason: 'no_health_data_proceed_normal' };
  if (h.ageHours > HEALTH_STALE_HOURS) return { skipTier1: false, reason: 'health_data_stale_proceed_normal' };
  if (h.status === 'auth_failed') return { skipTier1: true, reason: 'claude_auth_failed_age_' + h.ageHours.toFixed(1) + 'h' };
  if (h.status === 'quota_exhausted') return { skipTier1: true, reason: 'claude_quota_exhausted_age_' + h.ageHours.toFixed(1) + 'h' };
  return { skipTier1: false, reason: 'claude_' + h.status };
}

/**
 * PATCH 2026-05-18: rate-limited inline Claude health probe.
 *
 * Returns the new health row (in same shape as getLatestHealthForService)
 * if we ran a probe; returns null if we skipped due to rate-limiting. The
 * caller falls back to the stale row in the null case.
 *
 * Probe is gated on a 30-min cache via Script Properties so the cost stays
 * tiny — at most 48 inline probes per day even under heavy batch load,
 * vs ~$0.0005/probe = $0.024/day budget cap.
 *
 * Also detects state TRANSITIONS (alive→unhealthy or vice-versa) and writes
 * a banner to the Health sheet flagged with [TRANSITION] so it's grep-able
 * by both humans and automation. Future: FCM ping on transition.
 */
function _maybeRefreshClaudeHealth() {
  try {
    var props = PropertiesService.getScriptProperties();
    var lastRefresh = parseInt(props.getProperty(HEALTH_REFRESH_CACHE_KEY) || '0', 10);
    var sinceMin = (Date.now() - lastRefresh) / 60000;
    if (sinceMin < HEALTH_REFRESH_MINUTES) {
      // Rate-limited — don't probe
      return null;
    }
    Logger.log('[HealthCheck] Inline refresh probe (last refresh ' + sinceMin.toFixed(1) + ' min ago)');
    var probe = _probeClaude();
    var ts = new Date().toISOString();
    _writeHealthRows(ts, [probe]);
    props.setProperty(HEALTH_REFRESH_CACHE_KEY, String(Date.now()));

    // State-transition detection — compare to last stored state
    var stateKey = HEALTH_LAST_STATE_KEY_PREFIX + 'Claude';
    var lastState = props.getProperty(stateKey) || '';
    if (lastState && lastState !== probe.status) {
      _logHealthTransition('Claude', lastState, probe.status, probe.excerpt);
    }
    props.setProperty(stateKey, probe.status);

    return {
      service: probe.service,
      status: probe.status,
      timestamp: ts,
      ageHours: 0,
      latencyMs: probe.latencyMs,
      excerpt: probe.excerpt
    };
  } catch (refreshErr) {
    Logger.log('[HealthCheck] Inline refresh probe failed: ' + refreshErr.message);
    return null;
  }
}

/**
 * PATCH 2026-05-18: log a high-visibility state transition so the operator
 * notices Claude flipping unhealthy without manual log-trawling. Written as
 * a banner row in the Health sheet with status='[TRANSITION] <from>→<to>'.
 * This makes the transition visible at the very top of the health view AND
 * acts as a forensic timestamp ("when did Claude break?").
 */
function _logHealthTransition(service, fromState, toState, excerpt) {
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(HEALTH_SHEET_NAME);
    if (!sheet) return;
    var ts = new Date().toISOString();
    var transitionLabel = '[TRANSITION] ' + fromState + '→' + toState;
    sheet.appendRow([ts, service, transitionLabel, 0, (excerpt || '').substring(0, 200)]);
    Logger.log('[HealthCheck] *** ' + service + ' state transition: ' + fromState + ' → ' + toState + ' ***');
    // Best-effort telemetry to pipeline log if available
    try {
      if (typeof logPipelineEvent === 'function') {
        logPipelineEvent('-', 'HEALTH', service + ' transitioned ' + fromState + '→' + toState, 'WARN');
      }
    } catch (_) {}
  } catch (e) {
    Logger.log('[HealthCheck] _logHealthTransition failed: ' + e.message);
  }
}

// ─── TRIGGER INSTALLER ──────────────────────────────────────────────────

/**
 * Installs the daily health-check trigger. Idempotent.
 * @returns {string} status
 */
function installHealthCheckTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var exists = triggers.some(function(t) {
    return t.getHandlerFunction() === 'runHealthCheck';
  });
  if (exists) return 'already_installed';
  ScriptApp.newTrigger('runHealthCheck')
    .timeBased()
    .everyHours(6)   // 4x per day — more granular than daily; cheap
    .create();
  return 'installed_every_6h';
}
