/**
 * ============================================================
 * ApiClients.gs — API Client Handlers for Claude & Gemini
 * Manages API calls with retry logic, response validation,
 * quota tracking, structured output support, and error handling.
 * ============================================================
 */

// ─── GEMINI API CLIENT ──────────────────────────────────────

/**
 * Calls the Google Gemini API with advanced configuration.
 * Supports JSON response format with optional response schema for structured output.
 *
 * @param {string} prompt - The prompt to send to Gemini
 * @param {Object} [options] - Configuration options
 *   - model: overrides CONFIG.GEMINI_MODEL (default) for this call only
 *   - temperature: 0.0-1.0 (default 0.7)
 *   - maxTokens: max response tokens (default 2000)
 *   - responseFormat: 'text' or 'json' (default 'text')
 *   - responseSchema: JSON schema object for structured output (only when responseFormat='json')
 *   - systemPrompt: system instruction (default from CONFIG)
 *   - timeout: request timeout in ms (default 30000)
 * @returns {Object} { success: boolean, data: string|object, error?: string }
 */
function callGemini(prompt, options) {
  options = options || {};

  // PATCH Phase 8 (Improvement #9 / security): hardcoded fallback removed.
  // Previously a literal Gemini API key was stored in source as a fallback —
  // a credential exposure risk visible to anyone with read access to the .gs
  // file or to a copy of the project. Now: fail loudly if the key isn't set.
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    Logger.log('[ApiClients] GEMINI_API_KEY script property is not set — Gemini calls will fail.');
    return { success: false, error: 'Gemini API key not configured (set GEMINI_API_KEY script property)' };
  }

  // ── PATCH `-p5-vendorresilience-gemini` (Phase 2c circuit-breaker check) ──
  //
  // If a previous Gemini call hit HTTP 429 within the last 30 seconds, the
  // backoff property is set to (now + 30000). Short-circuit immediately
  // without making the network round-trip — saves ~7s of retry latency
  // per call AND avoids piling on the rate limit. The PROPERTY name
  // GEMINI_429_BACKOFF_UNTIL_MS is set by _fetchWithRetry on the response
  // path below (also Phase 2c).
  var bk = _geminiBackoffCheck();
  if (bk.active) {
    Logger.log('[ApiClients/Phase2c] callGemini short-circuit — backoff active for ' +
               bk.remainingMs + 'ms (until ' + bk.untilISO + ')');
    return {
      success: false,
      error: 'GEMINI_BACKED_OFF',
      backoffActive: true,
      backoffRemainingMs: bk.remainingMs
    };
  }

  // Track API call
  _trackApiCall('Gemini');

  var model = options.model || CONFIG.GEMINI_MODEL;
  var temperature = options.temperature !== undefined ? options.temperature : 0.7;
  var maxTokens = options.maxTokens || 2000;
  var responseFormat = options.responseFormat || 'text';
  var systemPrompt = options.systemPrompt || CONFIG.GEMINI_SYSTEM_PROMPT;

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey;

  var payload = {
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    contents: [{
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      temperature: temperature,
      maxOutputTokens: maxTokens
    }
  };

  // Add JSON response format configuration
  if (responseFormat === 'json') {
    payload.generationConfig.responseMimeType = 'application/json';

    // Add response schema if provided (ensures valid JSON output)
    if (options.responseSchema) {
      payload.generationConfig.responseSchema = options.responseSchema;
    }

    // For Gemini 2.5 thinking models: disable thinking for structured JSON output
    // to avoid empty responses where all content goes into thought parts
    if (model.indexOf('2.5') >= 0) {
      payload.generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }
  }

  // ── PATCH `-p5-vendorresilience-config` (Phase 3a): explicit thinkingBudget ──
  // Callers can pass `thinkingBudget: 0` to disable thinking even for text
  // responses (e.g., ResumeSelector tiebreaker which expects a single char
  // and previously got eaten by thinking tokens). Honored only on
  // gemini-2.5+ models — older models ignore the field. If both
  // responseFormat==='json' and options.thinkingBudget are set, the caller's
  // explicit value wins.
  if (typeof options.thinkingBudget === 'number' && model.indexOf('2.5') >= 0) {
    payload.generationConfig.thinkingConfig = { thinkingBudget: options.thinkingBudget };
  }

  try {
    var response = _fetchWithRetry(url, {
      method: 'post',
      payload: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
      muteHttpExceptions: true,
      timeout: options.timeout || 30000
    });

    return _parseApiResponse(response, responseFormat === 'json');
  } catch (e) {
    logPipelineEvent(0, 'API', 'Gemini call failed: ' + e.message, 'ERROR');
    return { success: false, error: 'Gemini API call failed: ' + e.message };
  }
}

// ─── GEMINI GROUNDED SEARCH CLIENT ─────────────────────────

/**
 * Calls Gemini API WITH Google Search grounding for real-time web data.
 * Returns plain text (not JSON) because grounding is incompatible with responseSchema.
 * Used for Pass 1 of two-pass research to get fresh, web-sourced information.
 *
 * @param {string} prompt - The research prompt
 * @param {Object} [options] - { temperature, maxTokens, timeout }
 * @returns {Object} { success: boolean, data: string, error?: string }
 */
function callGeminiGrounded(prompt, options) {
  options = options || {};

  // PATCH Phase 8 (Improvement #9 / security): hardcoded fallback removed.
  // Previously a literal Gemini API key was stored in source as a fallback —
  // a credential exposure risk visible to anyone with read access to the .gs
  // file or to a copy of the project. Now: fail loudly if the key isn't set.
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    Logger.log('[ApiClients] GEMINI_API_KEY script property is not set — Gemini calls will fail.');
    return { success: false, error: 'Gemini API key not configured (set GEMINI_API_KEY script property)' };
  }

  // PATCH `-p5-vendorresilience-gemini` (Phase 2c circuit-breaker check)
  var bkG = _geminiBackoffCheck();
  if (bkG.active) {
    Logger.log('[ApiClients/Phase2c] callGeminiGrounded short-circuit — backoff active for ' +
               bkG.remainingMs + 'ms (until ' + bkG.untilISO + ')');
    return {
      success: false,
      error: 'GEMINI_BACKED_OFF',
      backoffActive: true,
      backoffRemainingMs: bkG.remainingMs
    };
  }

  _trackApiCall('Gemini');

  var model = options.model || CONFIG.GEMINI_MODEL;
  var temperature = options.temperature !== undefined ? options.temperature : 0.2;
  var maxTokens = options.maxTokens || 4000;
  var systemPrompt = CONFIG.GEMINI_SYSTEM_PROMPT || '';

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey;

  var payload = {
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    contents: [{
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      temperature: temperature,
      maxOutputTokens: maxTokens
    },
    // Google Search grounding: gives Gemini real-time web access.
    // Gemini 2.x uses "googleSearch" tool; older models used "googleSearchRetrieval".
    // Using the 2.x format since CONFIG.GEMINI_MODEL is gemini-2.5-flash.
    tools: [{
      googleSearch: {}
    }]
  };

  // Note: Do NOT add responseMimeType or responseSchema here.
  // Google Search grounding is incompatible with structured JSON output.
  // Also skip thinkingConfig — grounding works better without it.

  try {
    var response = _fetchWithRetry(url, {
      method: 'post',
      payload: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
      muteHttpExceptions: true,
      timeout: options.timeout || 45000
    });

    var parsed = _parseApiResponse(response, false);

    // Log grounding metadata if available
    if (parsed.success) {
      Logger.log('[ApiClients] Grounded Gemini response: ' + (parsed.data || '').substring(0, 200) + '...');
    }

    return parsed;
  } catch (e) {
    logPipelineEvent(0, 'API', 'Grounded Gemini call failed: ' + e.message, 'ERROR');
    return { success: false, error: 'Grounded Gemini call failed: ' + e.message };
  }
}

// ─── CLAUDE API CLIENT ──────────────────────────────────────

/**
 * Calls the Anthropic Claude API with configuration options.
 *
 * @param {string} prompt - The prompt to send to Claude
 * @param {Object} [options] - Configuration options
 *   - model: CONFIG.CLAUDE_MODEL (default, set in Config.gs)
 *   - temperature: 0.0-1.0 (default 0.7)
 *   - maxTokens: max response tokens (default 2000)
 *   - systemPrompt: system instruction
 *   - timeout: request timeout in ms (default 30000)
 * @returns {Object} { success: boolean, data: string, error?: string }
 */
function callClaude(prompt, options) {
  options = options || {};

  var apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY')
    || 'YOUR_CLAUDE_API_KEY';
  if (!apiKey) {
    return { success: false, error: 'Claude API key not configured' };
  }

  // Track API call
  _trackApiCall('Claude');

  var model = options.model || CONFIG.CLAUDE_MODEL;
  var temperature = options.temperature !== undefined ? options.temperature : 0.7;
  var maxTokens = options.maxTokens || 2000;
  var systemPrompt = options.systemPrompt || '';

  var url = 'https://api.anthropic.com/v1/messages';

  var messages = [
    {
      role: 'user',
      content: prompt
    }
  ];

  var payload = {
    model: model,
    max_tokens: maxTokens,
    temperature: temperature,
    messages: messages
  };

  if (systemPrompt) {
    payload.system = systemPrompt;
  }

  var headers = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json'
  };

  try {
    var response = _fetchWithRetry(url, {
      method: 'post',
      payload: JSON.stringify(payload),
      headers: headers,
      muteHttpExceptions: true,
      timeout: options.timeout || 30000
    });

    return _parseApiResponse(response, false);
  } catch (e) {
    logPipelineEvent(0, 'API', 'Claude call failed: ' + e.message, 'ERROR');
    return { success: false, error: 'Claude API call failed: ' + e.message };
  }
}

// ─── RESPONSE SCHEMA HELPERS ────────────────────────────────

/**
 * Returns the JSON schema for company research output.
 * Used by Gemini API to generate structured company data.
 *
 * @returns {Object} JSON schema for company research
 */
function getCompanyResearchSchema() {
  return {
    type: 'OBJECT',
    properties: {
      name: { type: 'STRING' },
      industry: { type: 'STRING' },
      subIndustry: { type: 'STRING' },
      stage: { type: 'STRING' },
      employeeRange: { type: 'STRING' },
      founded: { type: 'STRING' },
      headquarters: { type: 'STRING' },
      description: { type: 'STRING' },
      recentNews: { type: 'STRING' },
      latestFundingRound: { type: 'STRING' },
      recentProductLaunches: { type: 'STRING' },
      leadershipChanges: { type: 'STRING' },
      marketMoves: { type: 'STRING' },
      fundingInfo: { type: 'STRING' },
      competitors: { type: 'ARRAY', items: { type: 'STRING' } },
      keyProducts: { type: 'ARRAY', items: { type: 'STRING' } },
      challenges: { type: 'STRING' },
      growthSignals: { type: 'STRING' },
      hiringSignals: { type: 'STRING' },
      teamStructure: { type: 'STRING' },
      culture: { type: 'STRING' },
      techStack: { type: 'STRING' },
      relevanceToGaurav: { type: 'STRING' }
    },
    required: ['name', 'industry', 'stage', 'description']
  };
}

/**
 * Returns the JSON schema for individual person research output.
 * Used by Gemini API to generate structured individual profile data.
 *
 * @returns {Object} JSON schema for individual research
 */
function getIndividualResearchSchema() {
  return {
    type: 'OBJECT',
    properties: {
      roleKPIs: { type: 'ARRAY', items: { type: 'STRING' } },
      painPoints: { type: 'ARRAY', items: { type: 'STRING' } },
      recentLinkedInPosts: { type: 'STRING' },
      recentActivity: { type: 'STRING' },
      publishedContent: { type: 'STRING' },
      thoughtLeadershipTopics: { type: 'ARRAY', items: { type: 'STRING' } },
      recentCareerMoves: { type: 'STRING' },
      careerTrajectory: { type: 'STRING' },
      decisionPower: { type: 'STRING' },
      communicationStyle: { type: 'STRING' },
      bestHookAngle: { type: 'STRING' },
      interestTopics: { type: 'ARRAY', items: { type: 'STRING' } },
      alumniNetworks: { type: 'ARRAY', items: { type: 'STRING' } },
      estimatedEmailVolume: { type: 'STRING' }
    },
    required: ['roleKPIs', 'decisionPower', 'communicationStyle']
  };
}

// ─── INTERNAL HELPERS ───────────────────────────────────────

/**
 * Fetches from a URL with automatic retry logic for transient failures.
 * Tracks API calls for quota monitoring.
 * Note: GAS UrlFetchApp does not support timeout directly; use muteHttpExceptions.
 *
 * @param {string} url - The URL to fetch
 * @param {Object} options - UrlFetchApp options
 *   - method, payload, headers, muteHttpExceptions, timeout (noted for future reference)
 * @returns {Object} Response object from UrlFetchApp
 */
function _fetchWithRetry(url, options) {
  options = options || {};

  // API name for quota tracking
  var apiName = url.indexOf('anthropic.com') >= 0 ? 'Claude' :
                url.indexOf('generativelanguage.googleapis.com') >= 0 ? 'Gemini' : 'Unknown';

  var maxRetries = 3;
  var backoffMs = 1000; // Start at 1 second

  for (var attempt = 0; attempt < maxRetries; attempt++) {
    try {
      var response = UrlFetchApp.fetch(url, options);
      var responseCode = response.getResponseCode();

      if (responseCode >= 200 && responseCode < 300) {
        return response;
      }

      // Retry on 429 (rate limit) or 5xx errors
      if (responseCode === 429 || responseCode >= 500) {
        // ── PATCH `-p5-vendorresilience-gemini` (Phase 2c): trip the Gemini
        // circuit breaker on any 429 from Gemini. The flag has a 30-second
        // TTL — subsequent Gemini calls within that window short-circuit at
        // the callGemini entry without making the network call. Saves the
        // ~7s of retry latency per call AND prevents piling on the rate
        // limit during the cool-down period.
        //
        // Why we set it ON THE FIRST 429 not after retries: by the time the
        // 3rd retry completes, we've spent ~7s. Setting on first detection
        // means concurrent Gemini calls in the same execution can short-
        // circuit immediately. Claude is unaffected (apiName check).
        if (apiName === 'Gemini' && responseCode === 429) {
          try { _setGeminiBackoff(30000); } catch (_bkErr) {}
        }
        if (attempt < maxRetries - 1) {
          Logger.log('Retry ' + (attempt + 1) + '/' + (maxRetries - 1) + ' for ' + apiName + ' (code: ' + responseCode + ')');
          Utilities.sleep(backoffMs);
          backoffMs *= 2; // Exponential backoff
          continue;
        }
      }

      return response;
    } catch (e) {
      if (attempt < maxRetries - 1) {
        Logger.log('Retry ' + (attempt + 1) + '/' + (maxRetries - 1) + ' for ' + apiName + ' due to: ' + e.message);
        Utilities.sleep(backoffMs);
        backoffMs *= 2;
      } else {
        throw e;
      }
    }
  }
}

// ─── PHASE 2c (`-p5-vendorresilience-gemini`): GEMINI CIRCUIT BREAKER ────────
//
// Two helpers used by callGemini / callGeminiGrounded / _fetchWithRetry:
//   - _geminiBackoffCheck(): read the current backoff state
//   - _setGeminiBackoff(ms): mark Gemini as backed-off for `ms` milliseconds
//
// Property key: GEMINI_429_BACKOFF_UNTIL_MS (epoch ms, integer string)
// TTL: 30 seconds default — chosen to clear a typical 60-RPM-window
// rate-limit without parking the pipeline for too long. Caller can override
// by passing a different `ms` to _setGeminiBackoff.

function _geminiBackoffCheck() {
  try {
    var props = PropertiesService.getScriptProperties();
    var raw = props.getProperty('GEMINI_429_BACKOFF_UNTIL_MS');
    if (!raw) return { active: false, remainingMs: 0, untilISO: '' };
    var until = parseInt(raw, 10);
    var now = Date.now();
    if (isNaN(until) || now >= until) {
      // Stale — proactively clean up so getProperties() stays lean
      try { props.deleteProperty('GEMINI_429_BACKOFF_UNTIL_MS'); } catch (_) {}
      return { active: false, remainingMs: 0, untilISO: '' };
    }
    return {
      active: true,
      remainingMs: until - now,
      untilISO: new Date(until).toISOString()
    };
  } catch (e) {
    return { active: false, remainingMs: 0, untilISO: '', error: e.message };
  }
}

function _setGeminiBackoff(ms) {
  if (typeof ms !== 'number' || ms <= 0) ms = 30000;
  try {
    var props = PropertiesService.getScriptProperties();
    var until = Date.now() + ms;
    props.setProperty('GEMINI_429_BACKOFF_UNTIL_MS', String(until));
    Logger.log('[ApiClients/Phase2c] Gemini circuit breaker TRIPPED — backoff for ' + ms +
               'ms (until ' + new Date(until).toISOString() + ')');
  } catch (e) {
    Logger.log('[ApiClients/Phase2c] Could not set Gemini backoff: ' + e.message);
  }
}

/**
 * Parses API response and validates content.
 * Auto-detects Gemini vs Claude response structure.
 * Skips Gemini "thinking" parts (gemini-2.5+) to reach actual response.
 *
 * @param {Object} response - UrlFetchApp response object
 * @param {boolean} [expectJson] - Whether to parse the extracted text as JSON
 * @returns {Object} { success: boolean, data: string|object, error?: string }
 */
function _parseApiResponse(response, expectJson) {
  try {
    var responseCode = response.getResponseCode();
    var responseText = response.getContentText();

    // Check for HTTP errors
    if (responseCode < 200 || responseCode >= 300) {
      var errorMsg = 'HTTP ' + responseCode;
      try {
        var errorBody = JSON.parse(responseText);
        if (errorBody.error) {
          errorMsg += ': ' + (errorBody.error.message || JSON.stringify(errorBody.error));
        }
      } catch (e) { /* unparseable error body */ }
      return { success: false, error: errorMsg };
    }

    var data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      return { success: false, error: 'Failed to parse API response body: ' + e.message };
    }

    var text = '';

    // ── Gemini format: { candidates: [{ content: { parts: [...] } }] } ──
    // gemini-2.5+ may prepend "thought" parts; skip them and take the first
    // non-thought part that contains text.
    if (data.candidates && data.candidates[0] && data.candidates[0].content) {
      var parts = data.candidates[0].content.parts || [];

      // Pass 1: prefer non-thought text parts
      for (var i = 0; i < parts.length; i++) {
        if (!parts[i].thought && parts[i].text) {
          text = parts[i].text;
          break;
        }
      }

      // Pass 2 (fallback): Gemini 2.5-flash thinking models may return ALL parts
      // as thought=true, or put the JSON response inside a thought part.
      // Use the LAST part with text content as fallback.
      if (!text || text.trim() === '') {
        for (var j = parts.length - 1; j >= 0; j--) {
          if (parts[j].text && parts[j].text.trim() !== '') {
            text = parts[j].text;
            Logger.log('[ApiClients] Gemini thought-fallback: used part ' + j + ' of ' + parts.length);
            break;
          }
        }
      }

      // Pass 3: If candidates exist but finishReason is not STOP, log it
      if ((!text || text.trim() === '') && data.candidates[0].finishReason) {
        Logger.log('[ApiClients] Gemini finishReason: ' + data.candidates[0].finishReason);
      }
    }
    // ── Gemini error format: { candidates: [], promptFeedback: {...} } ──
    else if (data.candidates && data.candidates.length === 0 && data.promptFeedback) {
      var blockReason = data.promptFeedback.blockReason || 'UNKNOWN';
      return { success: false, error: 'Gemini blocked prompt: ' + blockReason };
    }
    // ── Claude format: { content: [{ text: "..." }] } ──
    else if (data.content && data.content[0] && data.content[0].text) {
      text = data.content[0].text;
    }

    if (!text || text.trim() === '') {
      // Log raw response structure for debugging
      var keys = Object.keys(data);
      var candidateInfo = data.candidates ? ('candidates[' + data.candidates.length + ']') : 'no-candidates';
      var partsInfo = (data.candidates && data.candidates[0] && data.candidates[0].content)
        ? ('parts[' + (data.candidates[0].content.parts || []).length + ']') : 'no-parts';
      Logger.log('[ApiClients] Empty response debug: keys=' + keys.join(',') + ' ' + candidateInfo + ' ' + partsInfo);
      return { success: false, error: 'Empty response from API (' + candidateInfo + ', ' + partsInfo + ')' };
    }

    if (expectJson) {
      try {
        return { success: true, data: JSON.parse(text) };
      } catch (e) {
        return { success: false, error: 'Response is not valid JSON: ' + e.message };
      }
    }

    return { success: true, data: text };

  } catch (e) {
    return { success: false, error: 'Error parsing API response: ' + e.message };
  }
}

// ─── API QUOTA TRACKING ─────────────────────────────────────

/**
 * Tracks API calls by counting daily requests.
 * Increments counter in script properties with date-based key.
 *
 * @param {string} apiName - API name ('Claude' or 'Gemini')
 * @returns {number} Total calls made today after increment
 */
function _trackApiCall(apiName) {
  var props = PropertiesService.getScriptProperties();
  var today = new Date().toISOString().split('T')[0];
  var key = 'API_CALLS_' + apiName + '_' + today;
  var count = parseInt(props.getProperty(key)) || 0;
  // Telemetry only — a full property store must never break the API call
  // itself (2026-06-12 incident: quota overflow here surfaced as vendor
  // failures). Stale counters are swept by PipelineWatchdog Job 6.
  try { props.setProperty(key, (count + 1).toString()); } catch (_) {}
  return count + 1;
}

/**
 * Gets API usage statistics for today.
 * Returns count of Claude and Gemini calls made since midnight.
 *
 * @returns {Object} { claude: number, gemini: number, date: string }
 */
function getApiUsageToday() {
  var props = PropertiesService.getScriptProperties();
  var today = new Date().toISOString().split('T')[0];
  return {
    claude: parseInt(props.getProperty('API_CALLS_Claude_' + today)) || 0,
    gemini: parseInt(props.getProperty('API_CALLS_Gemini_' + today)) || 0,
    date: today
  };
}

/**
 * Tests both API connections and reports results.
 * Called from Setup menu to verify keys are working.
 */
function testApiConnections() {
  var ui = SpreadsheetApp.getUi();
  var results = [];

  // Test Gemini
  try {
    var geminiResult = callGemini('Reply with exactly: GEMINI_OK', { temperature: 0, maxTokens: 20 });
    results.push('Gemini: ' + (geminiResult.success ? 'CONNECTED' : 'FAILED — ' + geminiResult.error));
  } catch (e) {
    results.push('Gemini: ERROR — ' + e.message);
  }

  // Test Claude
  try {
    var claudeResult = callClaude('Reply with exactly: CLAUDE_OK', { temperature: 0, maxTokens: 20 });
    results.push('Claude: ' + (claudeResult.success ? 'CONNECTED' : 'FAILED — ' + claudeResult.error));
  } catch (e) {
    results.push('Claude: ERROR — ' + e.message);
  }

  // Test Sheet access
  try {
    var sheet = _getDataSheet();
    results.push('Sheet: CONNECTED (' + sheet.getName() + ', ' + sheet.getLastRow() + ' rows)');
  } catch (e) {
    results.push('Sheet: ERROR — ' + e.message);
  }

  ui.alert('API Connection Test', results.join('\n'), ui.ButtonSet.OK);
}

/**
 * Resets daily API call counters (for testing/maintenance).
 * Use with caution.
 */
function resetApiQuotaCounters() {
  var props = PropertiesService.getScriptProperties();
  var today = new Date().toISOString().split('T')[0];

  var claudeKey = 'API_CALLS_Claude_' + today;
  var geminiKey = 'API_CALLS_Gemini_' + today;

  props.deleteProperty(claudeKey);
  props.deleteProperty(geminiKey);

  Logger.log('API quota counters reset for ' + today);
}
