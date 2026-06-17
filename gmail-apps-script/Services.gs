/**
 * ============================================================
 * Services.gs — `_svc()` service injection registry (Phase 2.0)
 * ============================================================
 *
 * Single source of truth for Google Apps Script service access.
 * Production code calls `_svc('Properties')` instead of `PropertiesService.getScriptProperties()`;
 * tests inject mocks via `_svc.setMock('Properties', mockFactory)` and the same
 * production code path becomes deterministic.
 *
 * DESIGN PRINCIPLES (per Phase 2.0 spec):
 *
 * 1. **Default returns real services** — production behavior unchanged when
 *    no test mocks are registered. `_svc('Properties')` returns
 *    `PropertiesService.getScriptProperties()` directly.
 *
 * 2. **Per-key mock override** — `_svc.setMock('Properties', factoryFn)`
 *    causes subsequent `_svc('Properties')` calls to return `factoryFn()`.
 *    `_svc.clearMocks()` restores all real services.
 *
 * 3. **Deterministic Clock** — `_svc('Clock').now()` returns `Date.now()`
 *    by default; mock to a fixed timestamp for cool-down + age tests.
 *    Critical for vendorHealth + watchdog deterministic testing.
 *
 * 4. **Incremental migration** — production code only opts in where Phase
 *    2/3/4 tests need to exercise the call site. Other code stays raw.
 *    No big-bang refactor.
 *
 * 5. **Lazy factory pattern** — registered factories are called on each
 *    `_svc(name)` invocation, not cached. Lets tests build per-test state
 *    without polluting subsequent tests.
 *
 * USAGE (production):
 *
 *   var props = _svc('Properties');
 *   props.setProperty('foo', 'bar');
 *
 *   var lock = _svc('Lock').getScriptLock();
 *   if (lock.tryLock(500)) { ... }
 *
 *   var now = _svc('Clock').now();  // returns Date.now()
 *
 * USAGE (tests):
 *
 *   _svc.setMock('Properties', function() { return buildPropsMock({}); });
 *   _svc.setMock('Clock',      function() { return { now: function() { return 1747920000000; } }; });
 *   // production code under test now sees the mocks
 *   ...exercise the function under test...
 *   _svc.clearMocks();  // restore real services
 *
 * SUPPORTED SERVICE KEYS:
 *
 *   'UrlFetch'    → UrlFetchApp                         (real)
 *   'Gmail'       → GmailApp                            (real)
 *   'Drive'       → DriveApp                            (real)
 *   'Sheets'      → SpreadsheetApp                      (real)
 *   'Properties'  → PropertiesService.getScriptProperties()  (real)
 *   'Lock'        → LockService                         (real)
 *   'Clock'       → { now: function() { return Date.now(); } }
 *   'Cache'       → CacheService.getScriptCache()       (real)
 *   'Logger'      → Logger                              (real)
 *   'Utilities'   → Utilities                           (real, added Phase 3)
 *   'Script'      → ScriptApp                           (real, added Phase 3)
 *
 * PHASE 3 ADDITIONS:
 *   `Utilities` lets tests inject deterministic UUIDs via
 *     _svc.setMock('Utilities', function() {
 *       return { getUuid: function() { return 'fixed-uuid'; }, sleep: function(){}, ... };
 *     });
 *   `Script` lets tests inject trigger-list mocks for backfill installation.
 *
 * ============================================================
 */

// ─── REAL SERVICE FACTORIES ────────────────────────────────────────────────

var _SVC_REAL_FACTORIES = {
  'UrlFetch':   function() { return UrlFetchApp; },
  'Gmail':      function() { return GmailApp; },
  'Drive':      function() { return DriveApp; },
  'Sheets':     function() { return SpreadsheetApp; },
  'Properties': function() { return PropertiesService.getScriptProperties(); },
  'Lock':       function() { return LockService; },
  'Clock':      function() { return { now: function() { return Date.now(); } }; },
  'Cache':      function() { return CacheService.getScriptCache(); },
  'Logger':     function() { return Logger; },
  'Utilities':  function() { return Utilities; },
  'Script':     function() { return ScriptApp; }
};

// ─── MOCK REGISTRY ──────────────────────────────────────────────────────────
// Keys present here override the real factory. Tests register/clear via
// `_svc.setMock(name, factory)` and `_svc.clearMocks()`.

var _SVC_MOCK_REGISTRY = {};

// ─── PUBLIC: _svc(name) ─────────────────────────────────────────────────────

/**
 * Get a service by name. Returns the mock-registered factory's output if a
 * mock is registered; otherwise returns the real service.
 *
 * @param {string} name — one of the supported service keys
 * @returns {*} the service (real or mocked)
 * @throws {Error} if name is not a recognized service
 */
function _svc(name) {
  if (_SVC_MOCK_REGISTRY.hasOwnProperty(name)) {
    var mockFactory = _SVC_MOCK_REGISTRY[name];
    return mockFactory();
  }
  if (_SVC_REAL_FACTORIES.hasOwnProperty(name)) {
    return _SVC_REAL_FACTORIES[name]();
  }
  throw new Error('_svc: unknown service name "' + name + '". Supported: ' +
    Object.keys(_SVC_REAL_FACTORIES).join(', '));
}

// ─── MOCK CONTROL API ──────────────────────────────────────────────────────

/**
 * Register a mock factory for a service. Tests call this to inject
 * deterministic behavior; subsequent `_svc(name)` calls return the mock.
 *
 * Idempotent: re-registering overwrites the previous mock.
 *
 * @param {string} name — service key from the supported list
 * @param {function} factory — zero-arg function returning the mock object
 */
_svc.setMock = function(name, factory) {
  if (!_SVC_REAL_FACTORIES.hasOwnProperty(name)) {
    throw new Error('_svc.setMock: unknown service "' + name + '"');
  }
  if (typeof factory !== 'function') {
    throw new Error('_svc.setMock: factory must be a function');
  }
  _SVC_MOCK_REGISTRY[name] = factory;
};

/**
 * Remove all registered mocks, restoring real services.
 * Safe to call when no mocks are registered. The test runner calls this
 * in its `finally` block to guarantee no test bleeds mocks into the next.
 */
_svc.clearMocks = function() {
  _SVC_MOCK_REGISTRY = {};
};

/**
 * Inspect which services are currently mocked. Useful for test assertions
 * and debugging.
 *
 * @returns {string[]} array of mocked service names
 */
_svc.listMocks = function() {
  return Object.keys(_SVC_MOCK_REGISTRY);
};

/**
 * Snapshot + restore pattern for nested test scenarios.
 *   var snap = _svc.snapshotMocks();
 *   _svc.setMock('Clock', ...);
 *   // ... do stuff ...
 *   _svc.restoreMocks(snap);
 */
_svc.snapshotMocks = function() {
  var copy = {};
  for (var k in _SVC_MOCK_REGISTRY) {
    if (_SVC_MOCK_REGISTRY.hasOwnProperty(k)) copy[k] = _SVC_MOCK_REGISTRY[k];
  }
  return copy;
};

_svc.restoreMocks = function(snapshot) {
  _SVC_MOCK_REGISTRY = {};
  for (var k in (snapshot || {})) {
    if (snapshot.hasOwnProperty(k)) _SVC_MOCK_REGISTRY[k] = snapshot[k];
  }
};
