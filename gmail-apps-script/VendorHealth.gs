/**
 * ============================================================
 * VendorHealth.gs — Per-Provider Circuit Breaker (Phase 2.2)
 * ============================================================
 *
 * Closes archetype A22 (QUOTA_TRACKER_NO_VENDOR_RESET). Provides per-vendor
 * isolation against quota / auth / network failures so the selector and
 * enrichment cascade can pre-flight around dead vendors without burning
 * quota on calls that will fail.
 *
 * STATE MACHINE per provider:
 *
 *     HEALTHY ──3 consecutive 5xx/timeout──► DEGRADED
 *        ▲                                       │
 *        │                                       │ any 403/429/quota/credits response
 *        │                                       ▼
 *        │                                     OPEN ──at nextProbeAt──► HALF_OPEN
 *        │                                       ▲                          │
 *        │                                       │  probe fail               │ probe success
 *        │                                       └───────(extended cooldown)─┴──► HEALTHY
 *        │                                                                       │
 *        └───────────────────────────────────────────────────────────────────────┘
 *
 * PERSISTENCE:
 *   ScriptProperty `vendorHealth` as schema-versioned JSON:
 *   {
 *     "version": 1,
 *     "providers": {
 *       "reoon":  { "state":"OPEN", "lastTransitionAt":1747920000000,
 *                   "lastError":"403 Not enough credits",
 *                   "consecutiveFailures":3, "nextProbeAt":1747977600000 },
 *       "hunter": { ... },
 *       "claude": { ... },
 *       "apollo": { ... }
 *     }
 *   }
 *
 * PROVIDER-AWARE COOL-DOWN:
 *   reoon  → next IST midnight (00:00 IST = 18:30 UTC) — matches vendor quota epoch
 *   hunter → 24 hours (configurable, ~next billing cycle)
 *   claude → 30 min
 *   apollo → 30 min
 *
 * CONCURRENT WRITERS:
 *   Optimistic-lock-via-LockService. Two writers racing to flip state both
 *   call _vhPersistTransition; one acquires the script lock, the other
 *   waits then re-reads. Loser-no-op rather than loser-throw. Tested via
 *   `vendorHealth_concurrent_writers_optimistic_lock`.
 *
 * PRE-FLIGHT INTEGRATION:
 *   Production caller pattern (NOT YET migrated into EmailEnricher.gs in
 *   Phase 2; that's Phase 2.6+ work):
 *
 *     if (vendorHealthShouldSkip('reoon')) {
 *       return { status: 'skipped', reason: 'vendor_circuit_open' };
 *     }
 *     var resp = _svc('UrlFetch').fetch(url, opts);
 *     vendorHealthRecordResult('reoon', resp.getResponseCode(),
 *                              resp.getContentText());
 *
 * SCHEMA VERSIONING:
 *   `version: 1` ships now. Future v2 readers must handle missing fields
 *   from v1 records gracefully. `_vhReadState` always normalises to the
 *   current version on read, never throws on shape mismatch.
 *
 * ============================================================
 */

// ─── CONSTANTS ──────────────────────────────────────────────────────────────

var VH_STATE_PROPERTY_KEY = 'vendorHealth';
var VH_SCHEMA_VERSION = 1;

var VH_STATES = {
  HEALTHY:   'HEALTHY',
  DEGRADED:  'DEGRADED',
  OPEN:      'OPEN',
  HALF_OPEN: 'HALF_OPEN'
};

// Number of consecutive transient failures (5xx, timeout) before HEALTHY→DEGRADED
var VH_DEGRADE_THRESHOLD = 3;

// HALF_OPEN extended cool-down multiplier on probe failure
var VH_EXTENDED_COOLDOWN_MULTIPLIER = 2;

// Default cool-down per provider (ms)
var VH_PROVIDER_COOLDOWNS_MS = {
  reoon:  null,        // computed dynamically — next IST midnight
  hunter: 24 * 60 * 60 * 1000,
  claude: 30 * 60 * 1000,
  apollo: 30 * 60 * 1000,
  gemini: 30 * 60 * 1000
};

// HTTP status code → state-transition intent
var VH_QUOTA_ERROR_PATTERNS = /not enough credits|quota exhausted|quota exceeded|too many requests|monthly quota|billing cycle|payment required/i;

// ─── PUBLIC API ─────────────────────────────────────────────────────────────

/**
 * Pre-flight: should we skip calling this provider right now?
 * Returns true if circuit is OPEN AND nextProbeAt has not yet been reached.
 * Returns false otherwise — caller may proceed with the live call.
 *
 * @param {string} provider — 'reoon' | 'hunter' | 'claude' | 'apollo' | 'gemini'
 * @returns {boolean} true if caller should skip
 */
function vendorHealthShouldSkip(provider) {
  var st = vendorHealthGetState(provider);
  if (!st) return false;
  if (st.state !== VH_STATES.OPEN) return false;
  // OPEN but cool-down may have elapsed → caller should transition to HALF_OPEN
  // on its own call; for pre-flight purposes "skip" means "don't fire yet".
  var nowMs = _vhClockNow();
  return (st.nextProbeAt > nowMs);
}

/**
 * Get the current circuit state for a provider. Returns null if no record
 * exists (provider has never been used through the breaker yet).
 *
 * @param {string} provider
 * @returns {Object|null} provider state {state, lastTransitionAt, lastError,
 *                        consecutiveFailures, nextProbeAt}
 */
function vendorHealthGetState(provider) {
  var allState = _vhReadState();
  return allState.providers[provider] || null;
}

/**
 * Record the outcome of a vendor API call. Triggers state transitions per
 * the state machine. Caller MUST call this after every UrlFetch attempt
 * against the protected vendor.
 *
 * @param {string} provider
 * @param {number} httpCode — HTTP status code from the response
 * @param {string} [errorMessage] — body text or extracted error message
 * @returns {Object} updated provider state
 */
function vendorHealthRecordResult(provider, httpCode, errorMessage) {
  errorMessage = errorMessage || '';
  var classification = _vhClassifyResult(httpCode, errorMessage);
  return _vhApplyTransition(provider, classification, httpCode, errorMessage);
}

/**
 * Manual reset of a provider's circuit state. Use sparingly — primarily
 * for admin recovery after a manual vendor recharge.
 *
 * @param {string} provider
 * @returns {Object} reset state
 */
function vendorHealthResetProvider(provider) {
  var fresh = _vhFreshProviderState();
  return _vhPersistTransition(provider, fresh);
}

/**
 * Read all provider states as a snapshot. Useful for diagnostics and the
 * live API health endpoint.
 *
 * @returns {Object} {version, providers: {provider: state}}
 */
function vendorHealthSnapshot() {
  return _vhReadState();
}

// ─── INTERNAL: STATE TRANSITION LOGIC ──────────────────────────────────────

/**
 * Classify an HTTP response into a transition intent.
 *
 * @returns {string} 'success' | 'quota_or_auth_fail' | 'transient_fail'
 */
function _vhClassifyResult(httpCode, errorMessage) {
  // Success: 2xx
  if (httpCode >= 200 && httpCode < 300) return 'success';
  // Quota / auth: 401, 402, 403, 429, OR any 4xx body matching quota pattern
  if (httpCode === 401 || httpCode === 402 || httpCode === 403 || httpCode === 429) {
    return 'quota_or_auth_fail';
  }
  if (httpCode >= 400 && httpCode < 500 && VH_QUOTA_ERROR_PATTERNS.test(errorMessage)) {
    return 'quota_or_auth_fail';
  }
  // Transient: 5xx, network timeout, anything else
  return 'transient_fail';
}

/**
 * Apply state transition based on classification. Returns the new provider
 * state.
 */
function _vhApplyTransition(provider, classification, httpCode, errorMessage) {
  var current = vendorHealthGetState(provider) || _vhFreshProviderState();

  if (classification === 'success') {
    // Success from any state → HEALTHY, reset counters
    if (current.state !== VH_STATES.HEALTHY) {
      var updated = _vhFreshProviderState();
      updated.state = VH_STATES.HEALTHY;
      updated.lastTransitionAt = _vhClockNow();
      updated.priorState = current.state;
      _vhLog(provider, 'transition', current.state + '→HEALTHY (success)');
      return _vhPersistTransition(provider, updated).providers[provider];
    }
    // Already healthy — just reset failure counter quietly without persisting
    // (avoid churn on every healthy call)
    if (current.consecutiveFailures > 0) {
      current.consecutiveFailures = 0;
      return _vhPersistTransition(provider, current).providers[provider];
    }
    return current;
  }

  if (classification === 'quota_or_auth_fail') {
    // Any quota/auth fail → OPEN immediately, regardless of prior state
    var openState = _vhFreshProviderState();
    openState.state = VH_STATES.OPEN;
    openState.lastTransitionAt = _vhClockNow();
    openState.lastError = 'HTTP ' + httpCode + ' ' + (errorMessage.substring(0, 200) || '');
    openState.consecutiveFailures = (current.consecutiveFailures || 0) + 1;
    openState.priorState = current.state;
    // Extended cool-down if this is a re-fail in HALF_OPEN
    var extended = (current.state === VH_STATES.HALF_OPEN);
    openState.nextProbeAt = _vhComputeNextProbeAt(provider, extended);
    _vhLog(provider, 'transition', current.state + '→OPEN (' + classification + ')');
    return _vhPersistTransition(provider, openState).providers[provider];
  }

  // classification === 'transient_fail'
  var newFailures = (current.consecutiveFailures || 0) + 1;
  var transientState = {
    state: current.state,
    lastTransitionAt: current.lastTransitionAt,
    lastError: 'HTTP ' + httpCode + ' ' + (errorMessage.substring(0, 200) || ''),
    consecutiveFailures: newFailures,
    nextProbeAt: current.nextProbeAt,
    priorState: current.state
  };
  if (current.state === VH_STATES.HEALTHY && newFailures >= VH_DEGRADE_THRESHOLD) {
    transientState.state = VH_STATES.DEGRADED;
    transientState.lastTransitionAt = _vhClockNow();
    _vhLog(provider, 'transition', 'HEALTHY→DEGRADED (' + newFailures + ' consecutive failures)');
  }
  return _vhPersistTransition(provider, transientState).providers[provider];
}

/**
 * Persist a provider's state. Uses LockService to serialize concurrent
 * writers — losing writer no-ops gracefully (returns {ok:false,
 * reason:'lock_busy'}) rather than throwing.
 *
 * @param {string} provider
 * @param {Object} providerState
 * @returns {Object} {ok, allState, reason?}
 */
function _vhPersistTransition(provider, providerState) {
  var lockService = (typeof _svc === 'function') ? _svc('Lock') : LockService;
  var lock = lockService.getScriptLock();
  var acquired = false;
  try {
    acquired = lock.tryLock(500);  // 500ms — vendorHealth writes are infrequent
    if (!acquired) {
      _vhLog(provider, 'concurrent_writer_skip',
             'lock contention; no-op so the winning writer can complete');
      // Return a snapshot that includes the unmodified target provider state
      // so callers that read the return value get a consistent shape.
      var current = _vhReadState();
      return {
        ok: false,
        reason: 'lock_busy',
        providers: current.providers,
        version: current.version
      };
    }
    var all = _vhReadState();
    all.providers[provider] = providerState;
    all.version = VH_SCHEMA_VERSION;
    _vhWriteState(all);
    return { ok: true, providers: all.providers, version: all.version };
  } finally {
    if (acquired) lock.releaseLock();
  }
}

// ─── INTERNAL: PERSISTENCE ─────────────────────────────────────────────────

function _vhReadState() {
  var props = (typeof _svc === 'function') ? _svc('Properties') : PropertiesService.getScriptProperties();
  var raw = props.getProperty(VH_STATE_PROPERTY_KEY);
  if (!raw) return { version: VH_SCHEMA_VERSION, providers: {} };
  try {
    var parsed = JSON.parse(raw);
    // Normalize: v1 may be missing fields; future v2 readers handle gracefully.
    if (!parsed.providers) parsed.providers = {};
    if (!parsed.version) parsed.version = VH_SCHEMA_VERSION;
    return parsed;
  } catch (e) {
    _vhLog('_vhReadState', 'parse_error', 'corrupt vendorHealth property; resetting. ' + e.message);
    return { version: VH_SCHEMA_VERSION, providers: {} };
  }
}

function _vhWriteState(allState) {
  var props = (typeof _svc === 'function') ? _svc('Properties') : PropertiesService.getScriptProperties();
  try {
    props.setProperty(VH_STATE_PROPERTY_KEY, JSON.stringify(allState));
    return true;
  } catch (e) {
    _vhLog('_vhWriteState', 'write_error', e.message);
    return false;
  }
}

function _vhFreshProviderState() {
  return {
    state: VH_STATES.HEALTHY,
    lastTransitionAt: _vhClockNow(),
    lastError: '',
    consecutiveFailures: 0,
    nextProbeAt: 0,
    priorState: null
  };
}

// ─── INTERNAL: COOL-DOWN COMPUTATION ───────────────────────────────────────

/**
 * Compute the next probe time for a provider that just transitioned to
 * OPEN. Provider-aware — Reoon uses IST midnight, others use fixed
 * durations.
 *
 * @param {string} provider
 * @param {boolean} extended — if true (HALF_OPEN→OPEN re-fail), use
 *                             extended cool-down multiplier
 */
function _vhComputeNextProbeAt(provider, extended) {
  var nowMs = _vhClockNow();
  if (provider === 'reoon') {
    return _vhNextIstMidnight(nowMs, !!extended);
  }
  var cooldown = VH_PROVIDER_COOLDOWNS_MS[provider] || (30 * 60 * 1000);
  if (extended) cooldown *= VH_EXTENDED_COOLDOWN_MULTIPLIER;
  return nowMs + cooldown;
}

/**
 * Next IST midnight in UTC ms. IST is UTC+5:30, so IST 00:00 = UTC 18:30.
 *
 * If extended (HALF_OPEN re-fail), skip a day (i.e., 2 IST midnights from now).
 */
function _vhNextIstMidnight(nowMs, extended) {
  var d = new Date(nowMs);
  var target = new Date(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    18, 30, 0, 0
  ));
  if (target.getTime() <= nowMs) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  if (extended) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.getTime();
}

// ─── INTERNAL: CLOCK + LOGGING (mockable via _svc) ─────────────────────────

function _vhClockNow() {
  if (typeof _svc === 'function') {
    try { return _svc('Clock').now(); } catch (_) {}
  }
  return Date.now();
}

function _vhLog(provider, event, detail) {
  var msg = '[VendorHealth] ' + provider + ' ' + event + ': ' + detail;
  if (typeof _svc === 'function') {
    try { _svc('Logger').log(msg); return; } catch (_) {}
  }
  Logger.log(msg);
}
