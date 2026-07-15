/**
 * ============================================================
 * WebApp.gs — Unified doPost / doGet for THREE source surfaces:
 *
 *   1. LinkedIn Data Agent Android APK (v1.0 / v1.1) — sends the FULL profile
 *      payload (fullName, headline, designation, organization, email, phone,
 *      website, location, connectionDegree, confidence). Writes BOTH:
 *        - Sheet1 (raw audit log, all 12 fields)
 *        - Sheet2 (pipeline, 6 canonical input cols A-F) with email dedup
 *
 *   2. Chrome extension right-click context menu — sends minimal
 *      { linkedinUrl, source, sharedAt }. Writes a single Sheet2 row at
 *      status=NEW so the enrichment + research pipeline picks it up.
 *
 *   3. Android PWA share-target — same minimal shape as #2.
 *
 * Why one handler:
 *   Apps Script projects expose exactly ONE doPost(e). The previous setup
 *   had two (Code111.gs/doPost for the APK, WebApp.gs/doPost for the new
 *   surfaces) and the second silently shadowed the first — so the APK's
 *   rich payload was being dropped at the receiving end.
 *
 * Deployment:
 *   Apps Script editor → Deploy → New deployment → Web app
 *     - Execute as: Me
 *     - Who has access: Anyone, even anonymous
 *   Paste the resulting /exec URL into:
 *     (a) Android app → Settings → Apps Script Web App URL
 *     (b) Chrome extension popup → Settings → AutoMail Pipeline
 *     (c) PWA index.html config field
 *
 * Security:
 *   Optional shared-secret check via Script Property AUTOMAIL_WEBAPP_SECRET.
 *   If set, every POST must include `"secret": "<value>"` in the body or
 *   `?secret=<value>` in the query string. Skipped silently if unset
 *   (development mode). The APK does NOT send a secret today — leave the
 *   property unset until you upgrade the APK to support it.
 * ============================================================
 */

// ─── AUTH HELPERS ───────────────────────────────────────────

/**
 * Returns the admin token from Script Properties.
 * Set it once with: PropertiesService.getScriptProperties().setProperty('ADMIN_TOKEN', '<random-32-char-secret>');
 */
function _adminToken_() {
  var t = PropertiesService.getScriptProperties().getProperty('ADMIN_TOKEN');
  if (!t || t.length < 16) {
    throw new Error('ADMIN_TOKEN not configured in Script Properties (need 16+ chars). See SetupOneShot.gs.');
  }
  return t;
}

/**
 * Token gate for read-only sensitive endpoints (lead_dashboard, leads, raw, etc).
 * Returns true if request has a valid token. Returns false (and sets caller's response)
 * if missing or wrong. Uses ADMIN_TOKEN by default.
 */
function _checkAuthToken_(e) {
  var t = (e && e.parameter) ? (e.parameter.token || e.parameter.t || '') : '';
  if (!t) return false;
  try { return t === _adminToken_(); } catch (err) { return false; }
}

/**
 * PATCH 2026-05-13 (AUDIT F10 / R4): mutex wrapper for state-mutating admin
 * endpoints (force_reenrich, force_recompose, reset_stuck_leads,
 * set_lead_field, delete_lead).
 *
 * Why: these handlers write to Sheet1/Sheet2 with no LockService, racing
 * the active batch (which DOES use LockService) and the safety-net cron.
 * Two concrete failure modes were observed in audit:
 *   1. force_recompose on row N at the same moment the batch is writing
 *      writeEmailResult on row N → batch writes REVIEW + email body; admin
 *      overwrites status to RESEARCH_DONE simultaneously → safety-net
 *      re-composes → duplicate draft.
 *   2. set_lead_field with chained ?then=force_reenrich double-fires on
 *      user double-click → concurrent Apollo + Reoon credit burn.
 *
 * The wrapper acquires getScriptLock() with a 10-second tryLock window
 * (matches the batch's typical hold time per CONFIG.LOCK_TIMEOUT_MS=5s,
 * with margin). On timeout, returns a clean "busy" response instead of
 * racing. Per Google docs + Tanaike's concurrent-write benchmark:
 * https://developers.google.com/apps-script/reference/lock/lock-service
 * https://tanaikech.github.io/2021/09/15/benchmark-concurrent-writing-to-google-spreadsheet-using-form/
 *
 * Usage:
 *   if (action === 'force_recompose' && _checkAuthToken_(e)) {
 *     return _webAppRespond(_adminMutex_('force_recompose', e, _handleForceRecompose));
 *   }
 *
 * @param {string} actionName  for telemetry / error message
 * @param {Object} e            the doGet event
 * @param {Function} handlerFn  the handler — called as handlerFn(e)
 * @returns {Object}            handler's return value, or a busy/error object
 */
function _adminMutex_(actionName, e, handlerFn) {
  // PATCH 2026-06-15-authgate-hygiene: validate the admin token BEFORE taking the
  // pipeline lock. Previously the lock was acquired first and the token was checked
  // inside each handler, so an unauthenticated caller could contend for (and briefly
  // hold) the script mutex via clear_pending_followups / set_followup_time /
  // trigger_send_now — they route here with no dispatch-level gate. Auth-first closes
  // that contention window; the per-handler checks stay as defense-in-depth.
  if (!_checkAuthToken_(e)) {
    return { status: 'error', error: 'authentication_required', action: actionName };
  }
  var lock = LockService.getScriptLock();
  // 10-second wait — long enough to ride out a typical batch run-segment,
  // short enough to fail fast if there's a genuine deadlock or stuck cron.
  if (!lock.tryLock(10000)) {
    Logger.log('[WebApp] admin handler ' + actionName + ' could not acquire script lock within 10s — busy');
    return {
      status: 'busy',
      error: 'pipeline_busy',
      message: 'Another pipeline run is in progress. Retry in 1-2 minutes.',
      action: actionName
    };
  }
  try {
    return handlerFn(e);
  } catch (err) {
    Logger.log('[WebApp] admin handler ' + actionName + ' threw: ' + err.message);
    return { status: 'error', error: err.message, action: actionName, stack: (err.stack || '').substring(0, 400) };
  } finally {
    lock.releaseLock();
  }
}

// ─── ENTRY POINT ────────────────────────────────────────────

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      _auditCapture_({}, e, 'NO_BODY');
      return _webAppRespond({ status: 'error', error: 'no_post_body' });
    }

    var body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      _auditCapture_({ _raw: String(e.postData.contents || '').substring(0, 200) }, e, 'BAD_JSON');
      return _webAppRespond({ status: 'error', error: 'invalid_json: ' + parseErr.message });
    }

    // Optional shared-secret check (skipped if AUTOMAIL_WEBAPP_SECRET unset)
    var secretCheckResult = _verifySharedSecret(body, e);
    if (secretCheckResult.rejected) {
      // PATCH 2026-06-17-capture-audit: a rejected capture used to vanish with
      // only a Logger.log. Now the full payload is logged to CaptureAudit so the
      // lead is recoverable and the exact rejection cause (which auth field the
      // client did/didn't send) is visible. See _auditCapture_.
      _auditCapture_(body, e, 'REJECTED_UNAUTHORIZED');
      return _webAppRespond({ status: 'error', error: 'unauthorized' });
    }

    // Test ping (extension's "Test Connection" button)
    if (body.test === true) {
      return _webAppRespond({ status: 'ok', message: 'test_ok' });
    }

    // ── Payload-shape detection — route to the right handler ──
    // The APK sends fullName + currentDesignation + email etc. — rich payload.
    // The Chrome extension and PWA send only { linkedinUrl, source, sharedAt }.
    var isApkPayload = !!(body.fullName || body.currentDesignation || body.headline);
    _auditCapture_(body, e, isApkPayload ? 'APK_ACCEPTED' : 'MINIMAL_ACCEPTED');

    if (isApkPayload) {
      return _handleApkPayload(body);
    }
    return _handleMinimalPayload(body);

  } catch (err) {
    Logger.log('[WebApp] doPost fatal: ' + err.message + ' | stack: ' + (err.stack || ''));
    return _webAppRespond({ status: 'error', error: 'internal: ' + err.message });
  }
}

function doGet(e) {
  // Route by action parameter for diagnostic endpoints
  var action = (e && e.parameter && e.parameter.action) || '';
  // PATCH 2026-05-13 (AUDIT F11 / R4, R7): every PII-exposing diagnostic
  // endpoint now requires the admin token. The Web App is deployed with
  // access=ANYONE_ANONYMOUS, so without these guards, anyone hitting /exec
  // could enumerate leads, read draft IDs, replay tracking links, and
  // download the full Sheet via `raw`. These are *internal* tools, not
  // public surfaces.
  function _gate(handler) {
    if (!_checkAuthToken_(e)) {
      return ContentService.createTextOutput(JSON.stringify({
        status: 'error', error: 'authentication_required',
        message: 'Pass &token=<ADMIN_TOKEN> in the query string'
      })).setMimeType(ContentService.MimeType.JSON);
    }
    return handler(e);
  }
  if (action === 'logs') return _gate(_handleLogsRequest);
  if (action === 'leads') return _gate(_handleLeadsRequest);
  if (action === 'raw')  return _gate(_handleRawRequest);
  if (action === 'props') return _gate(_handlePropsRequest);
  if (action === 'leadstatus') return _gate(_handleLeadStatusRequest);
  if (action === 'bounces') {
    try {
      var snap = (typeof getBouncedDomainsSnapshot === 'function')
        ? getBouncedDomainsSnapshot()
        : { domains: {}, count: 0, error: 'BounceProcessor.gs not loaded' };
      return _webAppRespond({ status: 'ok', bouncedDomains: snap.domains, count: snap.count });
    } catch (err) {
      return _webAppRespond({ status: 'error', error: err.message, where: 'bounces' });
    }
  }
  // Patch 2026-05-11: email tracking endpoints (Tracking.gs)
  if (action === 'track_open' && typeof trackingHandleOpen === 'function') {
    return trackingHandleOpen(e);
  }
  if (action === 'track_click' && typeof trackingHandleClick === 'function') {
    return trackingHandleClick(e);
  }
  if (action === 'tracking_summary' && typeof trackingHandleSummary === 'function') {
    // PATCH 2026-05-13 (AUDIT F11 / R7): tracking_summary leaks threadId,
    // linkedinUrl, open timestamps via ?url=<...>. Gating it.
    if (!_checkAuthToken_(e)) {
      return ContentService.createTextOutput(JSON.stringify({
        status: 'error', error: 'authentication_required'
      })).setMimeType(ContentService.MimeType.JSON);
    }
    return trackingHandleSummary(e);
  }
  // Patch 2026-05-12: APK Tracking screen + follow-up surfaces
  // PATCH 2026-05-13 (AUDIT F11): added gate to followups_due, test_enrichment,
  // poll_events — all expose lead PII / engagement data or fire paid APIs.
  // lead_dashboard, lead_search, send_draft are already token-gated inside
  // their handlers; left as-is.
  if (action === 'lead_dashboard') return _handleLeadDashboardRequest(e);
  if (action === 'followups_due') return _gate(_handleFollowupsDueRequest);
  if (action === 'lead_search') return _handleLeadSearchRequest(e);
  if (action === 'test_enrichment') return _gate(_handleTestEnrichmentRequest);
  if (action === 'send_draft') return _handleSendDraftRequest(e);
  if (action === 'poll_events') return _gate(_handlePollEventsRequest);
  if (action === 'install_triggers' && _checkAuthToken_(e)) {
    var out = { bounce: null, reply: null, weekly: null, sendQueue: null, autoPause: null, warmKeeper: null,
                healthCheck: null, watchdog: null };
    try { out.bounce      = (typeof installBounceTrigger === 'function')           ? installBounceTrigger()           : 'fn missing'; } catch (er) { out.bounce      = 'ERR ' + er.message; }
    try { out.reply       = (typeof installReplyDetectorTrigger === 'function')    ? installReplyDetectorTrigger()    : 'fn missing'; } catch (er) { out.reply       = 'ERR ' + er.message; }
    try { out.weekly      = (typeof installWeeklyDigestTrigger === 'function')     ? installWeeklyDigestTrigger()     : 'fn missing'; } catch (er) { out.weekly      = 'ERR ' + er.message; }
    try { out.sendQueue   = (typeof installSendQueueTrigger === 'function')        ? installSendQueueTrigger()        : 'fn missing'; } catch (er) { out.sendQueue   = 'ERR ' + er.message; }
    try { out.autoPause   = (typeof installAutoPauseTrigger === 'function')        ? installAutoPauseTrigger()        : 'fn missing'; } catch (er) { out.autoPause   = 'ERR ' + er.message; }
    // PATCH 2026-05-15: warm-keeper trigger — fixes APK Tracking-tab cold-start
    try { out.warmKeeper  = (typeof installWebAppWarmKeeperTrigger === 'function') ? installWebAppWarmKeeperTrigger() : 'fn missing'; } catch (er) { out.warmKeeper  = 'ERR ' + er.message; }
    // PATCH 2026-05-15 (v2 Tracks F+G): health check + watchdog
    try { out.healthCheck = (typeof installHealthCheckTrigger === 'function')      ? installHealthCheckTrigger()      : 'fn missing'; } catch (er) { out.healthCheck = 'ERR ' + er.message; }
    try { out.watchdog    = (typeof installWatchdogTrigger === 'function')         ? installWatchdogTrigger()         : 'fn missing'; } catch (er) { out.watchdog    = 'ERR ' + er.message; }
    return _webAppRespond({ status: 'ok', installed: out });
  }
  // PATCH 2026-05-12: Send-time scheduler, AutoPause, FCM, Reply analytics
  if (action === 'schedule_send' && typeof enqueueScheduledSend === 'function') {
    if (!_checkAuthToken_(e)) {
      return ContentService.createTextOutput(JSON.stringify({
        status: 'error', error: 'authentication_required',
        message: 'Pass &token=<ADMIN_TOKEN> in the query string'
      })).setMimeType(ContentService.MimeType.JSON);
    }
    return _webAppRespond(enqueueScheduledSend(
      e.parameter.draftId, e.parameter.sendAt,
      parseInt(e.parameter.leadRow) || 0,
      e.parameter.leadEmail || ''));
  }
  if (action === 'send_queue' && typeof listSendQueue === 'function') {
    if (!_checkAuthToken_(e)) {
      return ContentService.createTextOutput(JSON.stringify({
        status: 'error', error: 'authentication_required',
        message: 'Pass &token=<ADMIN_TOKEN> in the query string'
      })).setMimeType(ContentService.MimeType.JSON);
    }
    return _webAppRespond(listSendQueue());
  }
  if (action === 'autopause_state' && typeof getAutoPauseState === 'function'
      && _checkAuthToken_(e)) {
    // PATCH 2026-06-15-authgate-hygiene: token-gate the pause/resume state read so
    // anonymous callers can't enumerate pipeline pause state. Mirrors the sibling
    // autopause_override gate immediately below.
    return _webAppRespond(getAutoPauseState());
  }
  if (action === 'autopause_override' && typeof setAutoPauseOverride === 'function'
      && _checkAuthToken_(e)) {
    return _webAppRespond(setAutoPauseOverride((e.parameter.state || '').toUpperCase()));
  }
  if (action === 'register_fcm_token' && typeof registerFcmTokenForUser === 'function') {
    // token=ADMIN_TOKEN (auth), fcm=<device FCM token>, email=<user email>
    // Also accepts POST body: { token: ADMIN_TOKEN, fcm: <device FCM token>, email: <email> }
    if (!_checkAuthToken_(e)) {
      return ContentService.createTextOutput(JSON.stringify({
        status: 'error', error: 'authentication_required',
        message: 'Pass &token=<ADMIN_TOKEN>&fcm=<device_fcm_token>&email=<email>'
      })).setMimeType(ContentService.MimeType.JSON);
    }
    var fcmDeviceToken = (e.parameter.fcm || e.parameter.fcm_token || e.parameter.device_token || '').toString();
    return _webAppRespond(registerFcmTokenForUser(fcmDeviceToken, e.parameter.email));
  }
  // Follow-up management endpoints (2026-05-12)
  // PATCH 2026-05-13 (Phase 9 verifier follow-up): trigger_send_now and
  // set_followup_time are state-mutating (trigger_send_now creates Gmail
  // drafts via createFollowUpDraft; set_followup_time writes sheet state).
  // Both need _adminMutex_ to prevent the same admin-vs-batch race that
  // F10 closed for the other 5 mutating handlers. clear_pending_followups
  // and get_followup_draft are lower-risk (read-mostly), but wrapping
  // them too costs nothing and is consistent.
  if (action === 'clear_pending_followups') return _webAppRespond(_adminMutex_('clear_pending_followups', e, _handleClearPendingFollowups));
  if (action === 'set_followup_time')       return _webAppRespond(_adminMutex_('set_followup_time', e, _handleSetFollowupTime));
  if (action === 'trigger_send_now')        return _webAppRespond(_adminMutex_('trigger_send_now', e, _handleTriggerSendNow));
  if (action === 'get_followup_draft')      return _handleGetFollowupDraft(e);  // read-only, no mutex needed

  if (action === 'reply_analytics') return _gate(_handleReplyAnalyticsRequest);
  // PATCH 2026-05-13 (AUDIT F11 / R6): msd_test + ddpd_test are unauthenticated
  // external-API proxies (Snov/Hunter/Apollo upstream calls). Gating them.
  if (action === 'msd_test' && typeof msdTest === 'function') {
    if (!_checkAuthToken_(e)) {
      return ContentService.createTextOutput(JSON.stringify({
        status: 'error', error: 'authentication_required'
      })).setMimeType(ContentService.MimeType.JSON);
    }
    var p = e.parameter;
    return _webAppRespond(msdTest(p.firstName || '', p.lastName || '', p.domain || '',
      (p.candidates || '').toString()));
  }
  if (action === 'ddpd_test' && typeof ddpdTest === 'function') {
    // PATCH 2026-05-13 (AUDIT F11 / R6): ddpd_test is an external-API proxy. Gating.
    if (!_checkAuthToken_(e)) {
      return ContentService.createTextOutput(JSON.stringify({
        status: 'error', error: 'authentication_required'
      })).setMimeType(ContentService.MimeType.JSON);
    }
    return _webAppRespond(ddpdTest(e.parameter.domain || ''));
  }
  // PATCH 2026-05-13 (AUDIT F10): all state-mutating admin endpoints now
  // wrapped via _adminMutex_ to acquire LockService.getScriptLock before
  // sheet writes. Closes the admin-vs-batch race described in audit R4.
  if (action === 'force_reenrich' && _checkAuthToken_(e)) {
    return _webAppRespond(_adminMutex_('force_reenrich', e, _handleForceReenrichRequest));
  }
  if (action === 'force_recompose' && _checkAuthToken_(e)) {
    return _webAppRespond(_adminMutex_('force_recompose', e, _handleForceRecompose));
  }
  // PATCH 2026-05-12: bulk-recovery for leads stuck at terminal states
  // (ERROR, REOON_RETRY_PENDING, REVIEW). Resets to NEW so safety-net cron
  // picks them up. Optional ?statuses=ERROR,REOON_RETRY_PENDING (comma list).
  if (action === 'reset_stuck_leads' && _checkAuthToken_(e)) {
    return _webAppRespond(_adminMutex_('reset_stuck_leads', e, _handleResetStuckLeads));
  }
  // PATCH 2026-05-12: permanent removal of a lead. Clears the row from
  // Sheet2 (pipeline state) AND removes the matching row from Sheet1 (the
  // raw lead store), keyed on linkedinUrl. Use ?action=delete_lead&rowNum=N
  if (action === 'delete_lead' && _checkAuthToken_(e)) {
    return _webAppRespond(_adminMutex_('delete_lead', e, _handleDeleteLead));
  }
  // PATCH 2026-05-13: render diagnostic — returns the rendered HTML email
  // body from Sheet2 column M (EMAIL_BODY) for a given row so we can inspect
  // structure without opening the Gmail draft. Useful for debugging missing
  // AI tools block, missing bullets, or other render-time regressions.
  // Usage: /exec?action=get_email_body&rowNum=N&token=<ADMIN>
  if (action === 'get_email_body' && _checkAuthToken_(e)) {
    return _webAppRespond(_handleGetEmailBody(e));
  }
  // PATCH 2026-05-13: admin field-override endpoint. Lets us fix a single
  // Sheet1 cell (organization, email, fullName, etc.) when the APK extracted
  // junk data and the pipeline got stuck. Updating Sheet1 propagates to
  // Sheet2 via the UNIQUE() formula on next recalc.
  //
  // Usage:
  //   /exec?action=set_lead_field&rowNum=166&field=organization&value=Nothing&token=<ADMIN>
  //
  // Allowed fields: fullName, headline, designation, organization, email
  //
  // After updating, optionally chain ?then=force_reenrich to re-trigger
  // enrichment on the corrected lead in the same request.
  if (action === 'set_lead_field' && _checkAuthToken_(e)) {
    return _webAppRespond(_adminMutex_('set_lead_field', e, _handleSetLeadField));
  }
  // PATCH 2026-05-18: stale-Apollo sweep — flag DRAFT_CREATED rows whose
  // Apollo-sourced email points to an ex-employer's domain. Idempotent.
  //
  // Usage:
  //   /exec?action=sweep_stale_apollo_drafts&token=<ADMIN>
  //   /exec?action=sweep_stale_apollo_drafts&dryRun=1&token=<ADMIN>
  //   /exec?action=sweep_stale_apollo_drafts&maxAgeDays=90&token=<ADMIN>
  if (action === 'sweep_stale_apollo_drafts' && _checkAuthToken_(e)) {
    return _webAppRespond(_adminMutex_('sweep_stale_apollo_drafts', e, function(ee) {
      var opts = {
        dryRun: (ee && ee.parameter && (ee.parameter.dryRun === '1' || ee.parameter.dryRun === 'true')),
        maxAgeDays: (ee && ee.parameter && ee.parameter.maxAgeDays)
          ? parseInt(ee.parameter.maxAgeDays, 10) : 60
      };
      var result = sweepStaleApolloDrafts(opts);
      return { status: 'ok', sweep: result };
    }));
  }
  // PATCH 2026-05-18 (second): Sheet2 realignment — fixes the Sheet1↔Sheet2
  // desync class of bug where state columns (G-Z) get bound to a different
  // row's identity (A-F) after Sheet1 modifications cause UNIQUE() to shift
  // rows. Classifies each row's email-vs-name relationship and:
  //   • clears state on misaligned rows (resets to NEW for reprocessing)
  //   • flips false-positive subsidiary/alias rows back from
  //     STALE_RECIPIENT_REVIEW to DRAFT_CREATED
  //   • leaves genuine stale-Apollo cases as STALE_RECIPIENT_REVIEW for
  //     manual user decision
  //
  // Usage:
  //   /exec?action=realign_sheet2_state&dryRun=1&token=<ADMIN>   ← always first
  //   /exec?action=realign_sheet2_state&token=<ADMIN>            ← live
  if (action === 'realign_sheet2_state' && _checkAuthToken_(e)) {
    return _webAppRespond(_adminMutex_('realign_sheet2_state', e, function(ee) {
      var opts = {
        dryRun: (ee && ee.parameter && (ee.parameter.dryRun === '1' || ee.parameter.dryRun === 'true'))
      };
      var result = realignSheet2State(opts);
      return { status: 'ok', realign: result };
    }));
  }
  // PATCH 2026-05-18: detect manual Gmail sends (drafts the user sent
  // directly from Gmail UI without going through the APK's Send button).
  // Without this, those drafts stayed at STATUS=DRAFT_CREATED forever,
  // and the follow-up cron skipped them at the SENT-status gate → zero
  // follow-up drafts created, zero FCM notifications. Idempotent.
  //
  // Usage:
  //   /exec?action=sync_sent_drafts&dryRun=1&token=<ADMIN>   ← scan only
  //   /exec?action=sync_sent_drafts&token=<ADMIN>            ← flip
  //   /exec?action=sync_sent_drafts&limit=100&token=<ADMIN>  ← bigger batch
  if (action === 'sync_sent_drafts' && _checkAuthToken_(e)) {
    return _webAppRespond(_adminMutex_('sync_sent_drafts', e, function(ee) {
      var opts = {
        dryRun: (ee && ee.parameter && (ee.parameter.dryRun === '1' || ee.parameter.dryRun === 'true')),
        limit:  (ee && ee.parameter && ee.parameter.limit)
          ? parseInt(ee.parameter.limit, 10) : undefined,
        searchDays: (ee && ee.parameter && ee.parameter.searchDays)
          ? parseInt(ee.parameter.searchDays, 10) : undefined
      };
      var result = syncSentDrafts(opts);
      return { status: 'ok', sync: result };
    }));
  }
  // PATCH 2026-05-18: install the 15-min cron for syncSentDrafts. Run
  // ONCE from the editor or this endpoint after deploy.
  //
  // Usage:
  //   /exec?action=install_gmail_syncer_trigger&token=<ADMIN>
  if (action === 'install_gmail_syncer_trigger' && _checkAuthToken_(e)) {
    return _webAppRespond(_adminMutex_('install_gmail_syncer_trigger', e, function() {
      var result = installGmailDraftSyncerTrigger();
      return { status: 'ok', trigger: result };
    }));
  }
  // PATCH 2026-05-18: comprehensive new-lead-pipeline setup. Installs
  // every trigger required for the end-to-end flow (initial draft →
  // manual send → status flip → follow-up draft → FCM notify → reply
  // cancellation). Idempotent — safe to re-run.
  //
  // Usage:  /exec?action=setup_new_lead_pipeline&token=<ADMIN>
  if (action === 'setup_new_lead_pipeline' && _checkAuthToken_(e)) {
    return _webAppRespond(_adminMutex_('setup_new_lead_pipeline', e, function() {
      return { status: 'ok', setup: setupNewLeadPipeline() };
    }));
  }
  // PATCH 2026-05-18: read-only health check across the new-lead flow.
  // Verifies triggers, FCM config, FCM tokens, Claude reachability,
  // Gemini config, presence of SENT rows, FollowUps sheet, lock state.
  // Returns a detailed pass/fail report + concrete next steps.
  //
  // Usage:  /exec?action=verify_new_lead_pipeline&token=<ADMIN>
  if (action === 'verify_new_lead_pipeline' && _checkAuthToken_(e)) {
    return _webAppRespond({ status: 'ok', verify: verifyNewLeadPipeline() });
  }
  // PATCH 2026-05-18: DESTRUCTIVE end-to-end follow-up test. Picks a
  // DRAFT_CREATED row, temporarily mutates STATUS+SENT_DATE to fake a
  // 4-day-old send, runs processScheduledFollowUps, verifies a follow-
  // up draft was created in the thread, then restores the original
  // state. WARNING: creates a real Gmail draft (won't auto-delete).
  //
  // Usage:
  //   /exec?action=e2e_followup_test&token=<ADMIN>            ← picks first DRAFT_CREATED
  //   /exec?action=e2e_followup_test&rowNum=178&token=<ADMIN> ← targets a specific row
  if (action === 'e2e_followup_test' && _checkAuthToken_(e)) {
    return _webAppRespond(_adminMutex_('e2e_followup_test', e, function(ee) {
      var opts = {};
      if (ee && ee.parameter && ee.parameter.rowNum) {
        opts.rowNum = parseInt(ee.parameter.rowNum, 10);
      }
      return { status: 'ok', e2e: runE2EFollowupTest(opts) };
    }));
  }
  // PATCH 2026-05-19: reset STATUS=ERROR rows back to NEW so the scanner
  // re-runs them. Bounded retry semantics: errRetry:N counter is preserved
  // by default (so a row that exhausted retries stays exhausted unless you
  // pass resetRetryCount=1). Use messageFilter to target specific error
  // classes (e.g., "Maximum call stack" after deploying a fix).
  //
  // Usage:
  //   ?action=reprocess_error_rows&dryRun=1&token=<ADMIN>
  //   ?action=reprocess_error_rows&messageFilter=Maximum%20call%20stack&token=<ADMIN>
  //   ?action=reprocess_error_rows&resetRetryCount=1&token=<ADMIN>
  if (action === 'reprocess_error_rows' && _checkAuthToken_(e)) {
    return _webAppRespond(_adminMutex_('reprocess_error_rows', e, function(ee) {
      var opts = {
        dryRun: (ee && ee.parameter && (ee.parameter.dryRun === '1' || ee.parameter.dryRun === 'true')),
        messageFilter: (ee && ee.parameter && ee.parameter.messageFilter) || '',
        resetRetryCount: (ee && ee.parameter && (ee.parameter.resetRetryCount === '1' || ee.parameter.resetRetryCount === 'true'))
      };
      return { status: 'ok', reprocess: reprocessErrorRows(opts) };
    }));
  }
  // PATCH 2026-05-19: manual run of the daily draft-state monitor. Use to
  // force a sweep without waiting for tomorrow 10 AM (e.g., right after
  // deploy or to verify behavior).
  //
  // Usage:
  //   ?action=run_draft_monitor&dryRun=1&token=<ADMIN>
  //   ?action=run_draft_monitor&token=<ADMIN>
  if (action === 'run_draft_monitor' && _checkAuthToken_(e)) {
    return _webAppRespond(_adminMutex_('run_draft_monitor', e, function(ee) {
      var opts = {
        dryRun: (ee && ee.parameter && (ee.parameter.dryRun === '1' || ee.parameter.dryRun === 'true'))
      };
      return { status: 'ok', monitor: runDraftStateMonitor(opts) };
    }));
  }
  // PATCH 2026-05-19: live-test the currently-installed REOON_API_KEY by
  // calling Reoon's verifier on a known-good test mailbox. Use after
  // rotating the key to confirm it works without waiting for the next
  // batch to fail with 401s.
  //
  // Usage:  /exec?action=test_reoon_key&token=<ADMIN>
  if (action === 'test_reoon_key' && _checkAuthToken_(e)) {
    return _webAppRespond((function() {
      var props = PropertiesService.getScriptProperties();
      var key = props.getProperty('REOON_API_KEY') || '';
      if (!key) {
        return { status: 'fail', reason: 'REOON_API_KEY not set in Script Properties' };
      }
      var testEmail = 'postmaster@gmail.com';
      var url = 'https://emailverifier.reoon.com/api/v1/verify?email=' +
                encodeURIComponent(testEmail) +
                '&key=' + encodeURIComponent(key) +
                '&mode=quick';
      try {
        var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
        var code = res.getResponseCode();
        var bodyExcerpt = (res.getContentText() || '').substring(0, 300);
        return {
          status: code === 200 ? 'ok' : 'fail',
          keyPreview: key.substring(0, 6) + '... (length ' + key.length + ')',
          testEmail: testEmail,
          httpCode: code,
          response: bodyExcerpt
        };
      } catch (err) {
        return { status: 'fail', reason: 'test_threw', error: err.message };
      }
    })());
  }
  // PATCH 2026-05-19: generic Script-Property setter, whitelist-gated.
  // Lets you rotate any pipeline credential without code changes. The
  // whitelist prevents arbitrary properties (especially security-relevant
  // ones like ADMIN_TOKEN) from being mutated via this endpoint.
  //
  // Usage:
  //   /exec?action=set_script_property&name=REOON_API_KEY&value=<NEW>&token=<ADMIN>
  //
  // Allowed names: REOON_API_KEY, HUNTER_API_KEY, APOLLO_API_KEY,
  // APOLLO_API_KEY_FALLBACK, CLAUDE_API_KEY, CLAUDE_API_KEY_BACKUP,
  // GEMINI_API_KEY, AUTOMAIL_WEBAPP_SECRET, LOR_DRIVE_ID.
  //
  // ADMIN_TOKEN itself is intentionally NOT in the whitelist — rotating
  // the admin token via the admin endpoint would create a self-revoke
  // race. Rotate ADMIN_TOKEN via Apps Script editor's setupOneShot only.
  // PATCH 2026-05-19: deep trigger verifier — per-handler functional audit.
  // Goes beyond verify_new_lead_pipeline (which just checks existence) and
  // confirms each cron actually fires, has the right schedule shape, and
  // its handler is callable. Reports orphan triggers (installed but not
  // in manifest) so you can clean up code drift.
  //
  // Usage:
  //   ?action=deep_verify_triggers&token=<ADMIN>                ← read-only audit
  //   ?action=deep_verify_triggers&smokeTest=1&token=<ADMIN>    ← also invoke dryRun-safe handlers
  if (action === 'deep_verify_triggers' && _checkAuthToken_(e)) {
    return _webAppRespond({
      status: 'ok',
      verify: deepVerifyTriggers({
        smokeTest: (e && e.parameter && (e.parameter.smokeTest === '1' || e.parameter.smokeTest === 'true'))
      })
    });
  }
  // PATCH 2026-05-19: inspect why specific rows are stuck pre-processing.
  // Returns per-row why-not analysis: candidate-gate eval, dedupe cache age,
  // last-updated age, transient-state staleness. Read-only.
  //
  // Usage:  /exec?action=inspect_stuck_rows&token=<ADMIN>
  //         /exec?action=inspect_stuck_rows&statuses=NEW,RESEARCHING&token=<ADMIN>
  // PATCH 2026-05-19: full-system diagnostic. Surfaces everything in one
  // response: script owner identity, actual Gmail drafts count + recent
  // subjects, last N leads' full state, status distribution, API key
  // presence, trigger summary, and recent errors. Auto-synthesized verdict
  // points at the most likely root cause.
  //
  // Usage:  /exec?action=diagnose_pipeline_health&token=<ADMIN>
  //         /exec?action=diagnose_pipeline_health&n=10&token=<ADMIN>
  // PATCH 2026-05-19: backfill Gmail drafts for existing REVIEW / NEEDS_REVIEW
  // rows whose email body was composed and stored in the sheet but no Gmail
  // draft was ever created (due to the now-removed quality.score >= 0.8 gate).
  // Idempotent: skips rows that already have a live draftId.
  //
  // Usage:
  //   ?action=backfill_review_drafts&dryRun=1&token=<ADMIN>   ← preview
  //   ?action=backfill_review_drafts&token=<ADMIN>            ← live
  //   ?action=backfill_review_drafts&statuses=REVIEW&token=<ADMIN>  ← scope
  if (action === 'backfill_review_drafts' && _checkAuthToken_(e)) {
    return _webAppRespond(_adminMutex_('backfill_review_drafts', e, function(ee) {
      var opts = {
        dryRun: (ee && ee.parameter && (ee.parameter.dryRun === '1' || ee.parameter.dryRun === 'true')),
        statuses: (ee && ee.parameter && ee.parameter.statuses)
          ? ee.parameter.statuses.split(',').map(function(s){ return s.trim(); })
          : undefined
      };
      return { status: 'ok', backfill: backfillReviewDrafts(opts) };
    }));
  }
  // PATCH 2026-05-19: diagnose what the unified email selector picks for a
  // specific lead (by rowNum). Returns full scoring trace so you can see
  // exactly which signals contributed which points and which candidates
  // were considered.
  //
  // Usage:  /exec?action=diagnose_email_selector&rowNum=203&token=<ADMIN>
  // PATCH 2026-05-19: one-call recovery for every stuck-at-pre-fix-state lead.
  // Resets NEEDS_EMAIL / NEEDS_EMAIL_REVIEW / NEEDS_PRE_SEND_REVIEW /
  // REOON_RETRY_PENDING so they re-flow under the new pipeline (unified
  // selector + Reoon-advisory + Hunter-Valid PSV pass + draft-creation-no-gate).
  //
  // Smart routing:
  //   - Rows with no good email   → STATUS=NEW (full re-pipeline)
  //   - Rows with email + dossier → STATUS=RESEARCH_DONE (skip to compose+draft)
  //
  // Usage:
  //   ?action=unified_recovery&dryRun=1&token=<ADMIN>   ← preview
  //   ?action=unified_recovery&token=<ADMIN>            ← live
  //   ?action=unified_recovery&statuses=NEEDS_EMAIL&token=<ADMIN>  ← scope
  if (action === 'unified_recovery' && _checkAuthToken_(e)) {
    return _webAppRespond(_adminMutex_('unified_recovery', e, function(ee) {
      var opts = {
        dryRun: (ee && ee.parameter && (ee.parameter.dryRun === '1' || ee.parameter.dryRun === 'true')),
        statuses: (ee && ee.parameter && ee.parameter.statuses)
          ? ee.parameter.statuses.split(',').map(function(s){ return s.trim(); })
          : undefined
      };
      return { status: 'ok', recovery: unifiedRecovery(opts) };
    }));
  }
  // PATCH 2026-05-19: look up a lead's rowNum by name or LinkedIn URL fragment.
  // Saves you scrolling Sheet2 to find which row Navneet (or anyone) is on.
  //
  // Usage:  /exec?action=find_lead&q=Navneet&token=<ADMIN>
  if (action === 'find_lead' && _checkAuthToken_(e)) {
    var q = (e && e.parameter && e.parameter.q) || '';
    return _webAppRespond({ status: 'ok', find: findLeadByQuery(q) });
  }
  if (action === 'diagnose_email_selector' && _checkAuthToken_(e)) {
    return _webAppRespond((function() {
      var rowNum = (e && e.parameter && e.parameter.rowNum) ? parseInt(e.parameter.rowNum, 10) : 0;
      if (!rowNum || rowNum < 2) {
        return { status: 'error', error: 'rowNum required (>=2)' };
      }
      var lead = (typeof getLeadByRow === 'function') ? getLeadByRow(rowNum) : null;
      if (!lead) return { status: 'error', error: 'lead not found at row ' + rowNum };
      if (typeof selectBestEmail !== 'function') {
        return { status: 'error', error: 'selectBestEmail not defined — selector not deployed?' };
      }
      var result = selectBestEmail(lead);
      return { status: 'ok', selector: result };
    })());
  }
  // PATCH 2026-05-19: verify the new CXO/Leadership Master Template is wired
  // correctly. Reads the live system + user prompts, confirms forbidden
  // "youngest" phrases are absent, the Subject Line Bank is present, and
  // banner/closingResume suppression flags are in place. Read-only — no
  // side effects.
  //
  // Usage:  /exec?action=verify_cxo_template&token=<ADMIN>
  if (action === 'verify_cxo_template' && _checkAuthToken_(e)) {
    return _webAppRespond((function() {
      var report = {
        deploymentStamp: '2026-06-13-sheet1-search',
        timestamp: new Date().toISOString(),
        checks: {}
      };
      try {
        var sysPrompt = (typeof _buildCxoSystemPrompt === 'function')
          ? _buildCxoSystemPrompt('peer-to-peer, high signal density') : '';
        var usrPrompt = (typeof _buildCxoUserPrompt === 'function')
          ? _buildCxoUserPrompt(
              { fullName: 'Test User', firstName: 'Test', designation: 'CEO', organization: 'AcmeCo', industry: 'SaaS' },
              { organization: 'AcmeCo', dossierSummary: 'sample dossier', triggerEvents: ['Series A close'], latestNews: 'launched X', bestHookAngle: 'creator-ops scaling', orgChallenges: ['scaling cross-border ops'] },
              { template: 'CXO_SHORT', seniority: 'C_SUITE' },
              { variantId: 'PRODUCT_AI_STRATEGY' }
            ) : '';
        var hrPrompt = (typeof _buildHrUserPrompt === 'function')
          ? _buildHrUserPrompt(
              { fullName: 'HR Test', firstName: 'HR', designation: 'HR Director', organization: 'AcmeCo', industry: 'SaaS' },
              { organization: 'AcmeCo', latestNews: 'recent partnership', bestHookAngle: 'hiring growth' },
              { template: 'HR_PARTNERSHIP' },
              { variantId: 'GROWTH_MARKETING' }
            ) : '';
        // ── Required positive signals (must be PRESENT) ──
        report.checks.systemPromptHasFiveLineMaster = /CANONICAL STRUCTURE\s*[—-]\s*5\s+sections/i.test(sysPrompt);
        report.checks.systemPromptHasSubjectBank   = /SUBJECT LINE BANK/i.test(sysPrompt);
        report.checks.systemPromptHasNeverList     = /NEVER INCLUDE/i.test(sysPrompt);
        report.checks.systemPromptForbidsYoungest  = /youngest[\s\S]{0,80}STRICTLY FORBIDDEN/i.test(sysPrompt);
        report.checks.userPromptHasCredentialBank  = /BRAND-ANCHORED CREDENTIAL BANK/i.test(usrPrompt);
        report.checks.userPromptHasPsOptions       = /P\.S\.\s+OPTIONS/i.test(usrPrompt);
        report.checks.userPromptHasFinalCheck      = /FINAL CHECK BEFORE OUTPUT/i.test(usrPrompt);
        // ── Required negative signals (must be ABSENT) ──
        report.checks.cxoSystemPromptNoYoungestExample =
          !/youngest\s+(?:department|dept)\s+lead/i.test(sysPrompt) || /STRICTLY FORBIDDEN/i.test(sysPrompt);
        report.checks.cxoUserPromptNoYoungestCredential =
          !/Great Learning[^.]*youngest\s+(?:dept|department)\s+lead/i.test(usrPrompt);
        report.checks.hrPromptNoYoungestCredential =
          !/Great Learning[^.]*youngest\s+(?:dept|department)\s+lead/i.test(hrPrompt);
        // ── Score ──
        var passed = 0, total = 0;
        Object.keys(report.checks).forEach(function(k) {
          total++;
          if (report.checks[k] === true) passed++;
        });
        report.summary = passed + ' / ' + total + ' checks passed';
        report.allPassed = (passed === total);
        return { status: 'ok', verify: report };
      } catch (err) {
        return { status: 'error', error: 'verify threw: ' + err.message, stack: err.stack };
      }
    })());
  }
  // PATCH 2026-05-20: clear the cached API-health probe so the next
  // run_watchdog call returns fresh data. Useful right after a deploy
  // that changes verifyEmailDeliverable behaviour.
  //
  // Usage:  /exec?action=clear_api_health_cache&token=<ADMIN>
  if (action === 'clear_api_health_cache' && _checkAuthToken_(e)) {
    return _webAppRespond((function() {
      if (typeof clearWatchdogApiHealthCache !== 'function') {
        return { status: 'error', error: 'clearWatchdogApiHealthCache not defined' };
      }
      return { status: 'ok', clear: clearWatchdogApiHealthCache() };
    })());
  }
  // PATCH Phase 5.2a-amend2 (observability): shadow_diff_summary endpoint.
  //
  // Returns aggregate counts from the shadow-mode run to disambiguate "never
  // ran" from "ran and agreed" — the empty-tab ambiguity finding #15. Reads
  // from ScriptProperties heartbeat + the scanner_shadow_diff sheet.
  //
  // Usage:
  //   GET /exec?action=shadow_diff_summary&token=<ADMIN>
  //
  // Returns:
  //   {
  //     shadow_scan_count:    N,   // total scanAndDispatch invocations since deploy
  //     shadow_last_ran_at:   ISO, // most recent invocation timestamp
  //     shadow_last_source:   '...',  // source tag of most recent invocation
  //     total_rows_compared:  N,
  //     agree_rows:           N,
  //     diff_rows:            N,
  //     diff_rows_in_sheet:   N,   // actual rows present in scanner_shadow_diff
  //     diffs_by_category: {
  //       expected_bug_1_classifying:   N,
  //       expected_bug_5_errretry_init: N,
  //       expected_bug_6_uid_dedupe:    N,
  //       unexplained:                  N
  //     },
  //     promotion_ready: boolean,   // true iff shadow_scan_count >= 200 AND unexplained === 0
  //     reason:          'string'
  //   }
  if (action === 'shadow_diff_summary' && _checkAuthToken_(e)) {
    return _webAppRespond((function() {
      var report = {
        shadow_scan_count: 0,
        shadow_last_ran_at: null,
        shadow_last_source: null,
        total_rows_compared: 0,
        agree_rows: 0,
        diff_rows: 0,
        diff_rows_in_sheet: 0,
        diffs_by_category: {
          expected_bug_1_classifying:   0,
          expected_bug_5_errretry_init: 0,
          expected_bug_6_uid_dedupe:    0,
          unexplained:                  0
        },
        promotion_ready: false,
        reason: 'init'
      };
      try {
        var props = PropertiesService.getScriptProperties();
        report.shadow_scan_count   = parseInt(props.getProperty('SHADOW_SCAN_COUNT') || '0', 10);
        report.shadow_last_ran_at  = props.getProperty('SHADOW_LAST_RAN_AT') || null;
        report.shadow_last_source  = props.getProperty('SHADOW_LAST_SOURCE') || null;
        report.total_rows_compared = parseInt(props.getProperty('SHADOW_TOTAL_COMPARED') || '0', 10);
        report.agree_rows          = parseInt(props.getProperty('SHADOW_TOTAL_AGREE') || '0', 10);
        report.diff_rows           = parseInt(props.getProperty('SHADOW_TOTAL_DIFF') || '0', 10);
      } catch (propsErr) {
        report.reason = 'props_read_error: ' + propsErr.message;
      }
      // Read scanner_shadow_diff sheet for categorized diffs
      try {
        var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
        var sheet = ss.getSheetByName('scanner_shadow_diff');
        if (sheet && sheet.getLastRow() > 1) {
          var lastRow = sheet.getLastRow();
          // Columns: ts | source | row | leadUid | status | legacy_kind | legacy_reason | new_kind | new_reason | diff | category
          var rows = sheet.getRange(2, 1, lastRow - 1, 11).getValues();
          report.diff_rows_in_sheet = rows.length;
          rows.forEach(function(r) {
            var cat = (r[10] || 'unexplained').toString();
            if (report.diffs_by_category[cat] !== undefined) {
              report.diffs_by_category[cat]++;
            } else {
              report.diffs_by_category.unexplained++;
            }
          });
        }
      } catch (sheetErr) {
        report.reason = (report.reason === 'init' ? '' : report.reason + ' | ') +
                        'shadow_sheet_read_error: ' + sheetErr.message;
      }
      // Promotion readiness
      var hasMinScans = report.shadow_scan_count >= 200;
      var noUnexplained = report.diffs_by_category.unexplained === 0;
      report.promotion_ready = hasMinScans && noUnexplained;
      report.reason = (report.reason === 'init') ?
        (report.promotion_ready ? 'ready_to_promote' :
          (!hasMinScans ? 'need_more_scans (' + report.shadow_scan_count + '/200)' :
           'unexplained_diffs_present (' + report.diffs_by_category.unexplained + ')')) :
        report.reason;
      return { status: 'ok', shadow: report, timestamp: new Date().toISOString() };
    })());
  }

  // PATCH Phase 2 remediation sprint (Section 2.5): stamp_check endpoint.
  //
  // Verifies that the live Web App's deploymentStamp matches the expected
  // stamp. Critical for catching "clasp deploy -i strips Web App access" and
  // similar deploy-version drift (per MEMORY.md feedback_clasp_redeploy_gotcha).
  //
  // Usage:
  //   /exec?action=stamp_check&expected=2026-06-11-eq8-draftpolish&token=<ADMIN>
  //
  // Returns:
  //   { status: 'ok', match: true,  actual: '...', expected: '...' } — stamps match
  //   { status: 'ok', match: false, actual: '...', expected: '...', drift: '...' } — mismatch
  //   { status: 'error', error: 'expected query parameter is required' } — bad input
  //
  // Why a separate endpoint vs. reading /exec?action=diagnose_pipeline_health:
  // stamp_check is intended for cheap polling (no sheet reads, no API calls).
  // CI / deploy scripts call this after `clasp push` to confirm the stamp
  // updated before declaring the deploy successful.
  if (action === 'stamp_check' && _checkAuthToken_(e)) {
    return _webAppRespond((function() {
      var expected = (e && e.parameter && e.parameter.expected) || '';
      if (!expected) {
        return { status: 'error', error: 'expected query parameter is required' };
      }
      // Source of truth: this file's own constant on the line below.
      var actual = '2026-06-13-sheet1-search';
      var match = (actual === expected);
      var resp = {
        status: 'ok',
        match: match,
        actual: actual,
        expected: expected,
        timestamp: new Date().toISOString()
      };
      if (!match) {
        resp.drift = 'Live stamp "' + actual + '" does not equal expected "' + expected + '". ' +
                     'Most likely cause: clasp push has not been run since the source was bumped, ' +
                     'OR clasp deploy -i created a new deployment (Web App access reset).';
      }
      return resp;
    })());
  }

  // ── PATCH `-postsprint-batch1` (P6 — Send queue observability): ──
  //
  // Returns drafts that are ready to ship — STATUS=DRAFT_CREATED, quality
  // above floor, not Tier-3, has draft_id. OBSERVABILITY ONLY — does NOT
  // trigger send. Pair with /exec?action=send_draft for per-draft approval.
  //
  // Usage:
  //   /exec?action=send_ready_drafts&token=<ADMIN>           — default minQuality=0.80
  //   /exec?action=send_ready_drafts&min=0.85&token=<ADMIN>  — custom floor
  if (action === 'send_ready_drafts' && _checkAuthToken_(e)) {
    return _webAppRespond((function() {
      if (typeof menuShowSendReadyDrafts !== 'function') {
        return { status: 'error', error: 'menuShowSendReadyDrafts not defined' };
      }
      var minQ = parseFloat((e && e.parameter && e.parameter.min) || '0.80');
      var result = menuShowSendReadyDrafts(minQ) || { totalScanned: 0, ready: [], summary: {} };
      return { status: 'ok',
               totalScanned: result.totalScanned,
               readyCount: result.readyCount,
               ready: result.ready,
               summary: result.summary,
               minQuality: result.minQuality,
               timestamp: new Date().toISOString() };
    })());
  }

  // ── PATCH `-postsprint-batch1` (P8 — Tier-1 fallback analysis): ──
  //
  // Aggregates NOTES across Sheet2 to surface WHY the pipeline falls back
  // to Tier-3. Buckets: em_dash, claude_unreachable, claude_quota,
  // generic_tier3. Use to identify the highest-value fix.
  //
  // Usage:
  //   /exec?action=tier1_fallback_stats&token=<ADMIN>
  if (action === 'tier1_fallback_stats' && _checkAuthToken_(e)) {
    return _webAppRespond((function() {
      if (typeof menuAnalyzeTier1Fallback !== 'function') {
        return { status: 'error', error: 'menuAnalyzeTier1Fallback not defined' };
      }
      var result = menuAnalyzeTier1Fallback() || { totalScanned: 0, anyTier3Count: 0, byCause: {} };
      return { status: 'ok',
               totalScanned: result.totalScanned,
               anyTier3Count: result.anyTier3Count,
               byCause: result.byCause,
               timestamp: new Date().toISOString() };
    })());
  }

  // ── PATCH `-p5-phase4-decisions` (Phase 4): tier3_drafts endpoint ──
  //
  // Surfaces the list of drafts that came from the Tier-3 deterministic
  // fallback path. The user humanizes these before sending; Tier-1
  // (Claude) drafts can ship as-is.
  //
  // Usage:
  //   /exec?action=tier3_drafts&token=<ADMIN>
  //
  // Returns { totalScanned, tier3: [...] }
  if (action === 'tier3_drafts' && _checkAuthToken_(e)) {
    return _webAppRespond((function() {
      if (typeof menuListTier3Drafts !== 'function') {
        return { status: 'error', error: 'menuListTier3Drafts not defined' };
      }
      // PATCH `-p5-phase4-decisions-amend`: query param `&include=all` to
      // show the full historical view; default is actionable-only.
      // Usage:
      //   /exec?action=tier3_drafts&token=<ADMIN>            → actionable only
      //   /exec?action=tier3_drafts&include=all&token=<ADMIN> → all history
      var includeAll = (e && e.parameter && e.parameter.include === 'all');
      var result = menuListTier3Drafts(!includeAll) || { totalScanned: 0, tier3: [], summary: {} };
      return {
        status: 'ok',
        totalScanned: result.totalScanned,
        tier3: result.tier3,
        summary: result.summary,
        actionableOnly: result.actionableOnly,
        timestamp: new Date().toISOString()
      };
    })());
  }

  // ── PATCH `-eq8-g9-bouncefix`: REMOTE EXECUTION BRIDGE (autonomy) ─────────
  //
  // Lets the development assistant run the diagnostic/maintenance helpers via
  // curl instead of asking the user to click Run in the GAS editor each time.
  //
  //   /exec?action=admin_run&fn=<name>&arg1=<num?>&token=<ADMIN>
  //
  // SECURITY: token-gated (same _checkAuthToken_ as every admin endpoint) AND
  // the fn name resolves against a HARDCODED whitelist — no eval, no arbitrary
  // function execution, no destructive operations. Whitelist policy: read-only
  // diagnostics + idempotent maintenance (bounce sweep, trigger install).
  // Anything that composes/sends/deletes mail is deliberately NOT here.
  if (action === 'admin_run' && _checkAuthToken_(e)) {
    return _webAppRespond((function() {
      var fnName = (e && e.parameter && e.parameter.fn) || '';
      var arg1raw = (e && e.parameter && e.parameter.arg1) || '';
      var arg1 = arg1raw !== '' ? parseFloat(arg1raw) : undefined;
      // PATCH 2026-06-12-autonomous-close: string arg for fns that need a non-numeric param
      var argS = (e && e.parameter && e.parameter.argS) || '';

      // PATCH 2026-06-12-e2e-hardening: inline LockService guard for
      // state-mutating WHITELIST entries. processBounces and menuBackfillBounces30d
      // write BouncedDomains sheet (_bouncedDomainsSave deletes+rewrites) and
      // mark lead rows BOUNCED — the same concurrent-write race that the F10
      // audit closed for force_recompose/force_reenrich/etc. via _adminMutex_.
      // admin_run itself is NOT wrapped in _adminMutex_ (it serves read-only
      // diagnostics that need no lock). The two sheet-mutating entries acquire
      // the script lock individually so they don't race the 30-min trigger.
      function _adminRunWithLock_(fn) {
        var lk = LockService.getScriptLock();
        if (!lk.tryLock(10000)) {
          return { status: 'busy', error: 'pipeline_busy',
                   message: 'Another pipeline run is in progress. Retry in 1-2 minutes.' };
        }
        try { return fn(); } finally { lk.releaseLock(); }
      }
      var WHITELIST = {
        // Diagnostics (read-only)
        'menuDiagnoseDispatch':            function() { return menuDiagnoseDispatch(); },
        // PATCH 2026-06-23 (archetype-override): pin a lead's archetype when the scraped
        // title is ambiguous (e.g. campus recruiting mislabeled "Campus & Alternate Channels").
        // ScriptProperty write only (ARCHETYPE_OVERRIDES) — not a mail send/delete op.
        'menuSetArchetypeOverride':        function(a, s) { return menuSetArchetypeOverride(a, s); },
        // PATCH 2026-06-23 (operator candidate email): set a TENTATIVE recipient address
        // (drafts with [VERIFY], never verified/blind-sent). ScriptProperty write only.
        'menuSetCandidateEmail':           function(a, s) { return menuSetCandidateEmail(a, s); },
        'menuSampleNewRows':               function() { return menuSampleNewRows(); },
        'menuEQ2_TrimWindowCheck':         function() { return menuEQ2_TrimWindowCheck(); },
        'menuEQ2_BaselineReport':          function(a) { return menuEQ2_BaselineReport(a); },
        'menuEQ2_AttributeBouncesToRows':  function() { return menuEQ2_AttributeBouncesToRows(); },
        'menuShowDailyDraftStatus':        function() { return (typeof getDailyDraftStatus === 'function') ? getDailyDraftStatus() : null; },
        'menuShowGmailOpsMeter':           function() { return (typeof menuShowGmailOpsMeter === 'function') ? menuShowGmailOpsMeter() : null; },
        'diagnosePipelineHealth':          function(a) { return diagnosePipelineHealth({ n: a || 5 }); },
        // Shadow compare (observational; vendor calls mostly cache-hit)
        'menuEnrichmentShadowSample':      function(a) { return menuEnrichmentShadowSample(a); },
        // Maintenance (state-mutating — lock-guarded to prevent race with 30-min trigger)
        'processBounces':                  function() { return _adminRunWithLock_(function() { return { bounces: (processBounces() || []).length }; }); },
        'menuDumpOneNdrSample':            function() { return menuDumpOneNdrSample(); },
        'menuInspectRecentDrafts':         function(a) { return menuInspectRecentDrafts(a); },
        'menuAuditLast10Drafts':           function() { return menuAuditLast10Drafts(); },
        'menuBackfillBounces30d':          function() { return _adminRunWithLock_(function() { return { bounces: (menuBackfillBounces30d() || []).length }; }); },
        'installBounceTrigger':            function() { installBounceTrigger(); return { installed: true }; },
        // PATCH 2026-06-12-prop-quota-relief: the ScriptProperties store hit
        // its hard key/size cap (set_enrichment_flag threw "exceeded the
        // property storage quota"), blocking every property write in the
        // pipeline. These four maintenance helpers (GmailDrafter.gs) let the
        // bridge inventory and prune the unbounded vendor-cache keys without
        // an editor session. Property-cache eviction is idempotent and is NOT
        // a mail send/delete operation — within whitelist policy.
        'menuListAllScriptProperties':     function() { return menuListAllScriptProperties(); },
        'menuPurgeStaleVendorCaches':      function() { return menuPurgeStaleVendorCaches(); },
        'menuPurgeAggressive':             function(a) { return menuPurgeAggressive(typeof a === 'number' ? a : 3); },
        'menuCleanStaleAutoProcessedProperties': function() { return menuCleanStaleAutoProcessedProperties(); },
        // PATCH 2026-07-06-cellceiling-relief: the workbook hit the 10,000,000-cell
        // hard limit (runHealthCheck append threw "would increase the number of cells
        // above the limit of 10000000 cells"), which silently freezes ALL intake
        // appendRow. These two GmailDrafter helpers let the bridge (a) inventory
        // per-sheet cell usage to confirm the bloat source [read-only], and (b) trim
        // the unbounded PipelineLog to its 7-day / 50k-row retention [deletes log rows
        // only — no lead/draft data]. Trim is lock-guarded like the other sheet-mutating
        // entries so it can't race the 30-min watchdog auto-trim.
        'menuShowSheetCellUsage':          function() { return menuShowSheetCellUsage(); },
        'menuTrimPipelineLog':             function(a) { return _adminRunWithLock_(function() { return menuTrimPipelineLog(typeof a === 'number' ? a : undefined); }); },
        // The actual 10M-cell bloat was scanner_shadow_diff (~9.3M cells, dead
        // post-promotion), NOT PipelineLog. This clears it (delete+recreate with
        // header); self-gated to refuse while USE_LEGACY_SCANNER !== false.
        'menuClearScannerShadowDiff':      function() { return _adminRunWithLock_(function() { return menuClearScannerShadowDiff(); }); },
        // PATCH 2026-06-12-deleted-stays-deleted: idempotent repair sweep —
        // reverts rows the watchdog resurrected from user-deleted drafts
        // before deletion became permanent. Sheet STATUS writes only, so it
        // takes the script lock like the other sheet-mutating entries.
        'menuRestoreResurrectedDeletedDrafts': function() { return _adminRunWithLock_(function() { return menuRestoreResurrectedDeletedDrafts(); }); },
        // PATCH 2026-06-12-autonomous-close: mail-tester.com probe helpers.
        // menuCreateMailTesterLead injects a synthetic lead (email hard-guarded to
        // @mail-tester.com); menuSendMailTesterDraft sends a pipeline draft (its own
        // guard re-validates the To address before send); menuRequeueDegradedTodayDrafts
        // resets rows from the 08:20-09:00Z degraded-renderer window. All three are
        // state-mutating and take the script lock.
        'menuCreateMailTesterLead':         function(a, s) { return menuCreateMailTesterLead(a, s); },
        'menuSendMailTesterDraft':          function(a)    { return _adminRunWithLock_(function() { return menuSendMailTesterDraft(a); }); },
        'menuRequeueDegradedTodayDrafts':   function()     { return _adminRunWithLock_(function() { return menuRequeueDegradedTodayDrafts(); }); },
        // PATCH 2026-06-12-template-unify: requeue prose-body rows by email whitelist.
        // PATCH 2026-06-12-requeue-generic: generalised to accept argS (comma-separated email list).
        'menuRequeueTemplateUnifyRows':     function(a, s) { return _adminRunWithLock_(function() { return menuRequeueTemplateUnifyRows(a, s); }); },
        // PATCH 2026-06-12-dup-lead-guard: read-only diagnostic — find all Sheet2 rows
        // whose EMAIL/ENRICHED_EMAIL contains argS substring (case-insensitive).
        // No lock needed — purely reads sheet data.
        'menuFindLeadRows':                 function(a, s) { return menuFindLeadRows(a, s); },
        // PATCH 2026-06-12-sent-sync: force an immediate syncSentDrafts pass to flip
        // stuck DRAFT_CREATED rows whose Gmail draft was already manually sent.
        // Lock-guarded because it mutates STATUS, SENT_DATE, THREAD_ID, NOTES.
        'menuRunDraftSyncerNow':            function() { return _adminRunWithLock_(function() { return menuRunDraftSyncerNow(); }); },
        // PATCH 2026-06-13-op-budget (Phase 3): reset ERROR rows whose errRetry was
        // exhausted by Gmail quota failures (not content failures). These rows have
        // SKIP_FALL_THROUGH:no_whitelist_match because errRetry:2/2 blocks
        // scoreStuckAutoRecoverEligible — ERROR IS in STUCK_AUTO_RECOVER_STATUSES,
        // so there is no whitelist gap. This function resets only quota-caused ERRORs.
        // After reset, they re-attempt when Gmail quota resets at midnight PT.
        'menuResetQuotaExhaustedErrorRows': function() { return _adminRunWithLock_(function() { return menuResetQuotaExhaustedErrorRows(); }); },
        // PATCH 2026-06-13-followup-thread: follow-up subsystem audit + duplicate purge.
        // menuFollowupAudit is read-only (counts + stats, no writes) — no lock needed.
        // menuPurgeDuplicateFollowups is write (cancels duplicate PENDING rows) — lock-guarded.
        'menuFollowupAudit':               function() { return menuFollowupAudit(); },
        'menuPurgeDuplicateFollowups':     function() { return _adminRunWithLock_(function() { return menuPurgeDuplicateFollowups(); }); },
        // PATCH -p7-followup-identity: follow-up row dump (read-only) + cross-email
        // duplicate cleanup (cancels a lead's 2nd follow-up set scheduled under a
        // corrected email — the Samriddhi Wishlink→Lendbox class). argS='execute' writes.
        'menuFollowupsForLead':            function(a, s) { return menuFollowupsForLead(a, s); },
        'menuCleanupCrossEmailFollowups':  function(a, s) { return _adminRunWithLock_(function() { return menuCleanupCrossEmailFollowups(a, s); }); },
        // PATCH 2026-06-13-final-cert: trigger dedup + reconcile. Deletes extras (one-shot
        // accumulation root cause), reinstalls any missing canonical time-driven triggers,
        // brings total count under 17 (3 headroom). NOT a send/delete mail operation.
        'menuReconcileTriggers':           function() { return menuReconcileTriggers(); },
        // PATCH 2026-06-13-snov-ping: free, uncached, read-only Snov balance probe.
        // Confirms credits are live after a refill without consuming enrichment credits.
        // Does NOT write to the SNOV_400 breaker — pure diagnostic. No lock needed.
        'menuPingSnov':                    function() { return menuPingSnov(); },
        // PATCH -p5-vendorfailover: vendor account + circuit-breaker diagnostics.
        // menuCheckVendorAccounts is read-only (Hunter /account + Apollo /auth/health
        // — Apollo health does NOT consume credits — + breaker snapshot). No lock.
        // menuResetVendorBreaker(argS=provider) resets a circuit after a top-up; the
        // vendorHealth property is self-locked (LockService), so no admin mutex needed.
        'menuCheckVendorAccounts':         function() { return menuCheckVendorAccounts(); },
        'menuResetVendorBreaker':          function(a, s) { return menuResetVendorBreaker(s || a); },
        // PATCH -p6-accuracy-ledger: read-only ground-truth accuracy report —
        // joins STATUS outcome × EMAIL_SOURCE × confidence band into bounce/reply/
        // delete rates per source. arg1 = days window (0/blank = all-time). No lock.
        'menuAccuracyLedger':              function(a) { return menuAccuracyLedger(a); },
        // PATCH 2026-06-13-orggate-substr: reset leads stranded by the old exact-token
        // org-domain gate (notes contain [ORG_DOMAIN_GATE] or NEEDS_EMAIL_REVIEW +
        // empty enrichedEmail). Clears enrichment cols, sets STATUS=NEW so the scanner
        // re-dispatches them under the fixed substring gate. Lock-guarded (sheet writes).
        'menuRequeueOrgGateStranded':      function() { return _adminRunWithLock_(function() { return menuRequeueOrgGateStranded(); }); },
        // PATCH 2026-06-13-quota-transient: force-clear the GMAIL_QUOTA_EXHAUSTED_<today>
        // flag on demand (e.g. when a transient burst was mis-typed as daily, or the flag
        // age hasn't reached its typed clear interval yet but ops confirm the burst subsided).
        // Clears only the PT-date-keyed key for today via _ptDateKey() — idempotent,
        // no lock needed (property delete only; no sheet or mail mutation).
        'menuClearGmailQuotaFlag':         function() { return menuClearGmailQuotaFlag(); },
        // PATCH 2026-06-13-sheetmail-fallthrough: reset NEEDS_EMAIL_REVIEW leads (and
        // any with [SHEET_EMAIL_UNDELIVERABLE] / [ORG_DOMAIN_GATE] / no-enrichedEmail)
        // to STATUS=NEW so the full vendor waterfall re-runs under the fallthrough fix.
        // Lock-guarded (sheet writes). Idempotent: rows already in NEW are skipped.
        'menuRequeueReviewLeads':          function() { return _adminRunWithLock_(function() { return menuRequeueReviewLeads(); }); },
        // PATCH 2026-06-13-followup-ops: orphan purge + on-demand follow-up runner.
        // menuPurgeOrphanFollowUps cancels PENDING follow-up rows whose parent lead is
        // in a terminal/non-send state (DRAFT_DELETED, BOUNCED_*, DUPLICATE, SKIPPED,
        // ERROR, RESPONDED). Bounded (≤2000/run), idempotent. Lock-guarded (sheet writes).
        // menuRunFollowUpsNow calls processScheduledFollowUps on-demand (not waiting for
        // the 9am cron). Lock is internal to processScheduledFollowUps.
        // menuRunDraftSyncerNow already whitelisted at -sent-sync; listed here for clarity.
        'menuPurgeOrphanFollowUps':        function() { return _adminRunWithLock_(function() { return menuPurgeOrphanFollowUps(); }); },
        'menuRunFollowUpsNow':             function() { return menuRunFollowUpsNow(); },
        // PATCH 2026-06-13-sheet1-search: read-only Sheet1 search for intake-gap diagnosis.
        // Reads Sheet1 (APK raw capture tab) directly — bypasses the Sheet2 UNIQUE view.
        // No lock needed: pure read, no sheet/mail mutation.
        'menuSearchSheet1':                function(a, s) { return menuSearchSheet1(a, s); },
        // PATCH 2026-06-17-capture-audit: capture observability + manual rescue.
        // menuShowCaptureAudit is read-only (reads the CaptureAudit tab). menuInjectLeadFromUrl
        // appends ONE lead to Sheet1 via the intake surface (bypasses APK + shared-secret gate),
        // letting the pipeline enrich+draft a lead the app couldn't deliver. Not a mail
        // send/delete op — within whitelist policy; admin-token gated.
        'menuShowCaptureAudit':            function(a, s) { return menuShowCaptureAudit(a, s); },
        'menuInjectLeadFromUrl':           function(a, s) { return menuInjectLeadFromUrl(a, s); },
        // PATCH 2026-06-17-capture-audit: Sheet1 append-freeze diagnostic (within-execution probe).
        'menuDiagSheet1Append':            function() { return menuDiagSheet1Append(); },
        // PATCH 2026-06-17-filter-fix: remove the stray Sheet1 basic filter that silently
        // froze ALL lead intake (appendRow no-op) from 2026-06-15. Idempotent; no data loss.
        'menuRemoveSheet1Filter':          function() { return menuRemoveSheet1Filter(); },
        // PATCH 2026-06-17-employer-reconcile: reset one lead (arg1=rowNum) to NEW so the
        // scanner reprocesses it with current logic (e.g. after the headline-vs-org fix).
        'menuResetLeadToNew':              function(a) { return _adminRunWithLock_(function() { return menuResetLeadToNew(a); }); },
        // PATCH 2026-06-17-verify-email-hold: promote a VERIFY_EMAIL-held lead (arg1=rowNum)
        // to NEW once the user has confirmed the guessed address — bypasses the hold gate.
        'menuPromoteEmailVerify':          function(a) { return _adminRunWithLock_(function() { return menuPromoteEmailVerify(a); }); },
        // PATCH 2026-06-19-email-lock: correct a held lead's address to a human-verified one
        // and promote SAFELY (writes [EMAIL_LOCKED] so the finalizer won't re-derive a wrong guess).
        'menuCorrectAndPromoteEmail':      function(a, s) { return _adminRunWithLock_(function() { return menuCorrectAndPromoteEmail(a, s); }); },
        // PATCH 2026-06-19-trust-org: toggle headline→org override; unlock+hold a suspect lead.
        'menuSetEmployerReconcileEnabled': function(a) { return _adminRunWithLock_(function() { return menuSetEmployerReconcileEnabled(a); }); },
        'menuUnlockEmailAndHold':          function(a, s) { return _adminRunWithLock_(function() { return menuUnlockEmailAndHold(a, s); }); },
        // PATCH 2026-06-19-org-override: set a human-verified employer + email and promote (fixes body AND recipient).
        'menuFixEmployerAndPromote':       function(a, s) { return _adminRunWithLock_(function() { return menuFixEmployerAndPromote(a, s); }); },
        // PATCH 2026-06-20-sheet2-spill: diagnose (arg1=0) / repair (arg1=1) a stalled UNIQUE(Sheet1) spill.
        'menuRepairSheet2Spill':           function(a) { return _adminRunWithLock_(function() { return menuRepairSheet2Spill(a); }); },
        // PATCH 2026-06-20-fu-scrub: delete pre-fix self-addressed follow-up drafts + reset rows to regen (arg1=1).
        'menuScrubSelfAddressedFollowups': function(a) { return _adminRunWithLock_(function() { return menuScrubSelfAddressedFollowups(a); }); },
        // PATCH 2026-06-20-purge-stale: delete unsent drafts older than arg1 days (default 5); argS='execute' to delete.
        'menuPurgeStaleUnsentDrafts':      function(a, s) { return _adminRunWithLock_(function() { return menuPurgeStaleUnsentDrafts(a, s); }); },
        // PATCH 2026-06-20-leadphones: compile captured (Sheet1 H) + reply-signature phones into a LeadPhones sheet (arg1=1 writes).
        'menuCompileLeadPhones':           function(a) { return _adminRunWithLock_(function() { return menuCompileLeadPhones(a); }); },
        // PATCH 2026-06-20-leaddiag: read-only deep lookup of a lead by name across Sheet1 + Sheet2 (argS=name).
        'menuDiagnoseLeadByName':          function(a, s) { return menuDiagnoseLeadByName(s); },
        // PATCH 2026-06-18-draftsync-probe: read-only — test whether stored DRAFT_IDs still
        // resolve via getDraft (true deletion vs false DRAFT_DELETED from a transient error).
        'menuProbeDraftId':                function(a, s) { return menuProbeDraftId(a, s); },
        // PATCH 2026-06-18-draftsync-transient: RECOVERY — restore leads falsely marked
        // DRAFT_DELETED whose Gmail draft still exists. arg1 = max probes/run (default 300).
        'menuRestoreFalseDeletedDrafts':   function(a) { return _adminRunWithLock_(function() { return menuRestoreFalseDeletedDrafts(a); }); },
        // PATCH 2026-06-19-whoami: which Gmail account holds the drafts (read-only).
        'menuWhoAmI':                      function() { return menuWhoAmI(); },
        // PATCH 2026-06-19-fu-thread: show a lead's thread + its pending follow-up reply drafts (read-only).
        'menuShowFollowUpThread':          function(a, s) { return menuShowFollowUpThread(a, s); },
        // PATCH 2026-06-19-fu-recipient: probe whether createDraftReply(+to) / createDraftReplyAll
        // address the LEAD vs self on a self-started thread; creates+deletes probe drafts (read-only).
        'menuTestReplyTo':                 function(a, s) { return menuTestReplyTo(a, s); },
        // PATCH 2026-06-19-fu-recipient: verify the FIXED path — Advanced-Service threaded draft
        // addressed to the recipient (not self) + GmailApp draftId resolvability; auto-deletes probe.
        'menuTestGmailApiDraft':           function(a, s) { return menuTestGmailApiDraft(a, s); },
        // PATCH 2026-06-19-email-accuracy: READ-ONLY shadow of the current-employer-domain-anchored
        // email selection — reports what the durable fix would change vs the current pick. No writes.
        'menuShadowEmailDiff':             function(a, s) { return menuShadowEmailDiff(a, s); },
        // PATCH 2026-06-19-headline-exseg: READ-ONLY — show the keystone parser's current-employer
        // extraction per recent lead + which rows it would override (eyeball before relying on it).
        'menuShadowEmployerParse':         function(a, s) { return menuShadowEmployerParse(a, s); }
      };

      if (!fnName || !WHITELIST.hasOwnProperty(fnName)) {
        return { status: 'error', error: 'fn not in whitelist', allowed: Object.keys(WHITELIST) };
      }
      try {
        var result = WHITELIST[fnName](arg1, argS);
        return { status: 'ok', fn: fnName, arg1: (arg1 === undefined ? null : arg1), argS: argS || null, result: result,
                 timestamp: new Date().toISOString() };
      } catch (runErr) {
        return { status: 'error', fn: fnName, error: runErr.message, stack: (runErr.stack || '').substring(0, 500) };
      }
    })());
  }

  // ── PATCH `-eq8-g9-bouncefix`: bounded flag promotion endpoint ────────────
  //
  //   /exec?action=set_enrichment_flag&flag=<ENRICHMENT_*_V2>&value=0|1&token=<ADMIN>
  //
  // ONLY the five EQ.7 enrichment flags are settable — not arbitrary
  // ScriptProperties. Promotion/rollback without a code push.
  if (action === 'set_enrichment_flag' && _checkAuthToken_(e)) {
    return _webAppRespond((function() {
      var flag = (e && e.parameter && e.parameter.flag) || '';
      var value = (e && e.parameter && e.parameter.value) || '';
      var ALLOWED_FLAGS = ['ENRICHMENT_MX_V2', 'ENRICHMENT_SOURCETYPE_V2', 'ENRICHMENT_SORT_V2',
                           'ENRICHMENT_CLASSIFY_V2', 'ENRICHMENT_BOUNCE_V2'];
      if (ALLOWED_FLAGS.indexOf(flag) < 0) {
        return { status: 'error', error: 'flag not allowed', allowed: ALLOWED_FLAGS };
      }
      if (value !== '0' && value !== '1') {
        return { status: 'error', error: 'value must be 0 or 1' };
      }
      var props = PropertiesService.getScriptProperties();
      var was = props.getProperty(flag);
      if (value === '1') props.setProperty(flag, '1');
      else props.deleteProperty(flag);  // delete → falls back to CONFIG default (false)
      return { status: 'ok', flag: flag, value: value, was: was,
               nowEffective: (typeof _enrichmentFlag === 'function') ? _enrichmentFlag(flag) : null,
               timestamp: new Date().toISOString() };
    })());
  }

  // ── PATCH `-p5-phase4-decisions` (Phase 4): pipeline_dashboard endpoint ──
  //
  // One-shot summary of every circuit breaker + resource counter the
  // pipeline tracks. Useful for daily ops "is everything fine?" check
  // without 7 separate menu invocations.
  //
  // Usage:
  //   /exec?action=pipeline_dashboard&token=<ADMIN>
  //
  // Returns:
  //   {
  //     gmail: { count, limit, remaining, flagSet },
  //     gemini: { backoffActive, remainingMs },
  //     reoon: { exhausted, date },
  //     snov: { backoffActive, count, lastCause, lastReason },
  //     tracking: { configured, value },
  //     properties: { total },
  //     tier3_drafts: { totalScanned, tier3Count, list[] },
  //     timestamp
  //   }
  if (action === 'pipeline_dashboard' && _checkAuthToken_(e)) {
    return _webAppRespond((function() {
      var dash = { timestamp: new Date().toISOString() };
      var props = PropertiesService.getScriptProperties();

      // Gmail quota
      try {
        if (typeof getDailyDraftStatus === 'function') {
          dash.gmail = getDailyDraftStatus();
        }
      } catch (e1) { dash.gmail = { error: e1.message }; }

      // Gemini backoff
      try {
        if (typeof _geminiBackoffCheck === 'function') {
          dash.gemini = _geminiBackoffCheck();
        }
      } catch (e2) { dash.gemini = { error: e2.message }; }

      // Reoon quota
      try {
        if (typeof _reoonQuotaCheck === 'function') {
          dash.reoon = _reoonQuotaCheck();
        }
      } catch (e3) { dash.reoon = { error: e3.message }; }

      // Snov backoff
      try {
        if (typeof _snovBackoffCheck === 'function') {
          var sb = _snovBackoffCheck();
          dash.snov = {
            backoffActive: !!sb.active,
            remainingMs: sb.remainingMs || 0,
            count: parseInt(props.getProperty('SNOV_400_COUNT') || '0', 10),
            lastCause: props.getProperty('SNOV_400_LAST_CAUSE') || '',
            lastReasonExcerpt: (props.getProperty('SNOV_400_LAST_REASON') || '').substring(0, 120)
          };
        }
      } catch (e4) { dash.snov = { error: e4.message }; }

      // TRACKING_WEBAPP_BASE
      dash.tracking = {
        configured: !!props.getProperty('TRACKING_WEBAPP_BASE'),
        value: props.getProperty('TRACKING_WEBAPP_BASE') || ''
      };

      // ScriptProperty count
      try {
        dash.properties = { total: Object.keys(props.getProperties()).length };
      } catch (e5) { dash.properties = { error: e5.message }; }

      // Tier-3 drafts
      try {
        if (typeof menuListTier3Drafts === 'function') {
          var tier3 = menuListTier3Drafts() || { totalScanned: 0, tier3: [] };
          dash.tier3_drafts = {
            totalScanned: tier3.totalScanned,
            tier3Count: tier3.tier3.length,
            list: tier3.tier3
          };
        }
      } catch (e6) { dash.tier3_drafts = { error: e6.message }; }

      return { status: 'ok', dashboard: dash };
    })());
  }

  // ── PATCH `-p5-phase4-prelude`: set_tracking_base endpoint ──
  //
  // Captures the /exec URL of the running deployment and writes it to the
  // TRACKING_WEBAPP_BASE script property. Calling this via HTTP /exec
  // ensures ScriptApp.getService().getUrl() returns the published /exec
  // URL (not the /dev URL it returns when called from the editor).
  //
  // Usage:
  //   /exec?action=set_tracking_base&token=<ADMIN>
  //
  // Returns:
  //   { status: 'ok', set: 'TRACKING_WEBAPP_BASE', value: 'https://.../exec' }
  if (action === 'set_tracking_base' && _checkAuthToken_(e)) {
    return _webAppRespond((function() {
      var url = '';
      try { url = ScriptApp.getService().getUrl(); }
      catch (urlErr) {
        return { status: 'error', error: 'ScriptApp.getService().getUrl() threw: ' + urlErr.message };
      }
      if (!url) {
        return { status: 'error', error: 'getUrl() returned empty string — script may not be deployed' };
      }
      // Sanity-check that we got an /exec URL (not /dev — guard against the same trap)
      if (!/\/exec(\?|$)/.test(url)) {
        return { status: 'error',
                 error: 'getUrl() returned "' + url + '" — expected /exec endpoint. Was this called from the published Web App?' };
      }
      PropertiesService.getScriptProperties().setProperty('TRACKING_WEBAPP_BASE', url);
      return {
        status: 'ok',
        set: 'TRACKING_WEBAPP_BASE',
        value: url,
        note: 'Drafts created from the next pipeline run onward will include open-pixel + click-redirect tracking.'
      };
    })());
  }

  // PATCH Phase 1 remediation sprint (A13 closure): Tests.gs harness URL endpoint.
  //
  // Usage:
  //   /exec?action=run_all_tests&token=<ADMIN>             — full suite
  //   /exec?action=run_all_tests&tags=smoke&token=<ADMIN>  — subset by tag (CSV)
  //   /exec?action=run_all_tests&verbose=1&token=<ADMIN>   — include diff in failure output
  //
  // Returns structured report (see Tests.gs runAllTests for shape).
  if (action === 'run_all_tests' && _checkAuthToken_(e)) {
    return _webAppRespond((function() {
      if (typeof runAllTests !== 'function') {
        return { status: 'error', error: 'runAllTests not defined - Tests.gs not deployed?' };
      }
      var tagsParam = (e && e.parameter && e.parameter.tags) || '';
      var tags = tagsParam ? tagsParam.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; }) : [];
      var verbose = !!(e && e.parameter && (e.parameter.verbose === '1' || e.parameter.verbose === 'true'));
      var report = runAllTests({ tags: tags, verbose: verbose });
      return { status: 'ok', tests: report };
    })());
  }
  // PATCH 2026-05-20: report current Reoon Quick-mode daily quota usage.
  // The pipeline waterfalls Power -> Quick automatically on 403. Quick mode
  // gives 13 free verifications today (resets at UTC midnight) + ~600/month.
  // This endpoint exposes how much of the daily allowance has been spent.
  //
  // Usage:  /exec?action=reoon_quota&token=<ADMIN>
  if (action === 'reoon_quota' && _checkAuthToken_(e)) {
    return _webAppRespond((function() {
      if (typeof getReoonQuickQuotaStatus !== 'function') {
        return { status: 'error', error: 'getReoonQuickQuotaStatus not defined - waterfall patch not deployed' };
      }
      return { status: 'ok', quota: getReoonQuickQuotaStatus() };
    })());
  }
  // PATCH 2026-05-20: install the PipelineWatchdog + all required triggers.
  // Idempotent: existing triggers are reported, missing ones installed.
  // Run once per deployment; the watchdog itself then re-installs anything
  // that goes missing afterwards (every 30 min check).
  //
  // Usage:  /exec?action=install_watchdog&token=<ADMIN>
  if (action === 'install_watchdog' && _checkAuthToken_(e)) {
    return _webAppRespond(_adminMutex_('install_watchdog', e, function(ee) {
      if (typeof installPipelineWatchdog !== 'function') {
        return { status: 'error', error: 'installPipelineWatchdog not defined - PipelineWatchdog.gs not deployed?' };
      }
      var result = installPipelineWatchdog();
      // Also run the watchdog once immediately so the first-tick benefits land now
      var firstRun = null;
      try {
        if (typeof pipelineWatchdog === 'function') firstRun = pipelineWatchdog();
      } catch (e) { firstRun = { error: e.message }; }
      return { status: 'ok', install: result, firstRun: firstRun };
    }));
  }
  // PATCH 2026-05-20: manually run the PipelineWatchdog once. Useful for
  // verifying behaviour or kicking a recovery cycle outside the 30-min cadence.
  //
  // Usage:  /exec?action=run_watchdog&token=<ADMIN>
  if (action === 'run_watchdog' && _checkAuthToken_(e)) {
    return _webAppRespond(_adminMutex_('run_watchdog', e, function(ee) {
      if (typeof pipelineWatchdog !== 'function') {
        return { status: 'error', error: 'pipelineWatchdog not defined' };
      }
      return { status: 'ok', report: pipelineWatchdog() };
    }));
  }
  // PATCH 2026-05-20: view the last watchdog report without running it
  // (cached in script properties on every run).
  //
  // Usage:  /exec?action=last_watchdog_report&token=<ADMIN>
  if (action === 'last_watchdog_report' && _checkAuthToken_(e)) {
    return _webAppRespond((function() {
      var raw = PropertiesService.getScriptProperties().getProperty('WATCHDOG_LAST_REPORT');
      if (!raw) return { status: 'ok', report: null, message: 'No watchdog run has been recorded yet' };
      try { return { status: 'ok', report: JSON.parse(raw) }; }
      catch (e) { return { status: 'ok', report: raw, parseError: e.message }; }
    })());
  }
  // PATCH 2026-05-20: force a SINGLE row through the full pipeline RIGHT NOW.
  // Bypasses the per-row dedupe + the lock + the scanner cadence — useful
  // when scanner triggers are misbehaving or you want to verify a fix on a
  // specific lead without waiting 5 min for the next safety-net tick.
  //
  // Reset STATUS to NEW first (if not already), clear dedupe key, then
  // invoke _processSingleRow synchronously. Returns the resulting STATUS +
  // ENRICHED_EMAIL + DRAFT_ID + any pipeline-event notes captured.
  //
  // Usage:  /exec?action=force_rerun_row&rowNum=<ROW>&token=<ADMIN>
  if (action === 'force_rerun_row' && _checkAuthToken_(e)) {
    return _webAppRespond(_adminMutex_('force_rerun_row', e, function(ee) {
      var rowNum = (ee && ee.parameter && ee.parameter.rowNum) ? parseInt(ee.parameter.rowNum, 10) : 0;
      if (!rowNum || rowNum < 2) return { status: 'error', error: 'rowNum required (>=2)' };
      var lead = (typeof getLeadByRow === 'function') ? getLeadByRow(rowNum) : null;
      if (!lead) return { status: 'error', error: 'lead not found at row ' + rowNum };
      var beforeStatus = lead.status || '<blank>';

      // Clear per-row dedupe so the scanner-equivalent doesn't skip
      try {
        PropertiesService.getScriptProperties().deleteProperty('AUTO_PROCESSED_ROW_' + rowNum);
      } catch (_) {}

      // Reset to NEW so identity/dossier writes look "fresh" to the pipeline
      try {
        if (typeof updateLeadFields === 'function') {
          updateLeadFields(rowNum, {
            STATUS: 'NEW',
            NOTES: '[FORCE_RERUN ' + new Date().toISOString() + '] Was ' + beforeStatus +
                   ' -> NEW (force_rerun_row endpoint). Pipeline running synchronously now.'
          }, { verifyUrl: lead.linkedinUrl });
        }
      } catch (resetErr) {
        return { status: 'error', error: 'reset_failed: ' + resetErr.message };
      }

      // Re-fetch with the NEW status so _processOneLead sees a clean lead
      var freshLead = (typeof getLeadByRow === 'function') ? getLeadByRow(rowNum) : lead;
      if (!freshLead) return { status: 'error', error: 'lead refetch failed' };

      // Synchronously run the pipeline against this single row.
      // PATCH 2026-05-20: actual function name is _processOneLead (not
      // _processSingleRow as documentation suggested). Try both for
      // belt-and-suspenders so this works across refactors.
      var pipelineError = null;
      try {
        if (typeof _processOneLead === 'function') {
          _processOneLead(freshLead);
        } else if (typeof _processSingleRow === 'function') {
          _processSingleRow(freshLead);
        } else {
          return { status: 'error', error: 'neither _processOneLead nor _processSingleRow defined - BatchProcessor.gs may be out of date' };
        }
      } catch (procErr) {
        pipelineError = procErr.message + ' || stack: ' + (procErr.stack || '').substring(0, 600);
      }

      // Re-fetch to report the final state
      var finalLead = (typeof getLeadByRow === 'function') ? getLeadByRow(rowNum) : null;
      return {
        status: 'ok',
        rowNum: rowNum,
        beforeStatus: beforeStatus,
        afterStatus: finalLead ? (finalLead.status || '<blank>') : '<refetch_failed>',
        pipelineError: pipelineError,
        enrichedEmail: finalLead && finalLead.enrichedEmail,
        emailSource: finalLead && finalLead.emailSource,
        emailConfidence: finalLead && finalLead.emailConfidence,
        draftId: finalLead && finalLead.draftId,
        selectionTier: finalLead && finalLead.selectionTier,
        riskFlags: finalLead && finalLead.riskFlags,
        notesPreview: finalLead && finalLead.notes ? finalLead.notes.toString().substring(0, 500) : ''
      };
    }));
  }
  // PATCH 2026-05-19 (no-termination mode): preview what tier the email
  // finalizer would assign to a specific lead + which recipient it would pick.
  // Read-only — runs selectBestEmail internally (Apollo + Reoon + Hunter
  // calls, all cached) but does not mutate the sheet.
  //
  // Usage:  /exec?action=diagnose_email_finalizer&rowNum=<ROW>&token=<ADMIN>
  if (action === 'diagnose_email_finalizer' && _checkAuthToken_(e)) {
    return _webAppRespond((function() {
      var rowNum = (e && e.parameter && e.parameter.rowNum) ? parseInt(e.parameter.rowNum, 10) : 0;
      if (!rowNum || rowNum < 2) return { status: 'error', error: 'rowNum required (>=2)' };
      var lead = (typeof getLeadByRow === 'function') ? getLeadByRow(rowNum) : null;
      if (!lead) return { status: 'error', error: 'lead not found at row ' + rowNum };
      if (typeof diagnoseEmailFinalizer !== 'function') {
        return { status: 'error', error: 'diagnoseEmailFinalizer not defined - EmailFinalizer.gs not deployed?' };
      }
      return { status: 'ok', finalizer: diagnoseEmailFinalizer(lead) };
    })());
  }
  // PATCH 2026-05-19 (no-termination mode): force-reset every row that ended
  // in a previously-terminal status to STATUS=NEW so the scanner re-runs them
  // under the new always-progress pipeline. After running this, the next
  // scanner tick (within 5 min) will produce drafts for every reset row.
  //
  // Usage:  /exec?action=retry_all_stuck&dryRun=1&token=<ADMIN>   ← preview
  //         /exec?action=retry_all_stuck&token=<ADMIN>            ← live
  if (action === 'retry_all_stuck' && _checkAuthToken_(e)) {
    return _webAppRespond(_adminMutex_('retry_all_stuck', e, function(ee) {
      var dryRun = (ee && ee.parameter && (ee.parameter.dryRun === '1' || ee.parameter.dryRun === 'true'));
      var TERMINAL_STATUSES = [
        'NEEDS_EMAIL', 'NEEDS_EMAIL_REVIEW', 'NEEDS_REVIEW', 'REVIEW',
        'COMPOSING', 'HUMANIZING', 'QUALITY_CHECK', 'ERROR',
        'NEEDS_PRE_SEND_REVIEW', 'REOON_RETRY_PENDING'
      ];
      var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
      var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
      if (!sheet) return { status: 'error', error: 'data sheet missing' };
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) return { status: 'ok', scanned: 0, reset: 0 };
      var c = CONFIG.COLUMNS;
      var data = sheet.getRange(2, 1, lastRow - 1, CONFIG.SHEET_COL_COUNT).getValues();
      var scanned = 0, reset = 0, results = [];
      for (var i = 0; i < data.length; i++) {
        var row = data[i];
        var rowNum = i + 2;
        var status = (row[c.STATUS - 1] || '').toString().trim();
        if (TERMINAL_STATUSES.indexOf(status) < 0) continue;
        scanned++;
        var fullName = (row[c.FULL_NAME - 1] || '').toString();
        results.push({ rowNum: rowNum, fullName: fullName, prevStatus: status, action: dryRun ? 'would_reset' : 'reset_to_NEW' });
        if (!dryRun) {
          try {
            sheet.getRange(rowNum, c.STATUS).setValue('NEW');
            var prevNotes = (row[c.NOTES - 1] || '').toString().substring(0, 800);
            sheet.getRange(rowNum, c.NOTES).setValue(
              '[NO_TERMINATION_RETRY ' + new Date().toISOString() + '] Was ' + status +
              ' → NEW. Re-processing under no-termination pipeline. Previous: ' + prevNotes
            );
            sheet.getRange(rowNum, c.LAST_UPDATED).setValue(new Date().toISOString());
            PropertiesService.getScriptProperties().deleteProperty('AUTO_PROCESSED_ROW_' + rowNum);
            reset++;
          } catch (writeErr) {
            results[results.length - 1].action = 'write_error: ' + writeErr.message;
          }
        }
      }
      // Invoke scanner so resets process immediately (next tick is 5 min away)
      var scannerInvoked = null;
      if (!dryRun && reset > 0 && typeof _scanAndProcessNewRows === 'function') {
        try { _scanAndProcessNewRows('NO_TERMINATION_RETRY'); scannerInvoked = 'invoked'; }
        catch (err) { scannerInvoked = 'threw: ' + err.message; }
      }
      return {
        status: 'ok',
        dryRun: dryRun,
        scanned: scanned,
        reset: reset,
        scannerInvoked: scannerInvoked,
        results: results.slice(0, 50)
      };
    }));
  }
  // PATCH 2026-05-19: live API health probe. Each enrichment + research +
  // composition vendor is called with a known-safe probe payload. Reports
  // HTTP status, response shape, and any quota-exhaustion / 401 / 403 /
  // payment-block signals. This is the "are my APIs actually alive?" check
  // that key-presence diagnostics can't answer.
  //
  // Usage:  /exec?action=live_api_health&token=<ADMIN>
  if (action === 'live_api_health' && _checkAuthToken_(e)) {
    return _webAppRespond((function() {
      var report = {
        timestamp: new Date().toISOString(),
        deploymentStamp: '2026-06-13-sheet1-search',
        results: {}
      };
      var props = PropertiesService.getScriptProperties();

      // ─── Reoon (Power→Quick waterfall) ───
      try {
        var reoonKey = props.getProperty('REOON_API_KEY') || '';
        if (!reoonKey) {
          report.results.reoon = { ok: false, reason: 'key_unset' };
        } else {
          var reoonProbe = { activeMode: 'none' };
          // Step 1: try Power
          var rPRes = UrlFetchApp.fetch(
            'https://emailverifier.reoon.com/api/v1/verify?email=test%40gmail.com&key=' +
            encodeURIComponent(reoonKey) + '&mode=power',
            { muteHttpExceptions: true });
          var rPCode = rPRes.getResponseCode();
          var rPText = rPRes.getContentText() || '';
          reoonProbe.powerHttpCode = rPCode;
          if (rPCode === 200) {
            var rPJson = null; try { rPJson = JSON.parse(rPText); } catch (_) {}
            reoonProbe.ok = !!(rPJson && rPJson.status);
            reoonProbe.activeMode = 'power';
            reoonProbe.status = rPJson && rPJson.status;
          } else if (rPCode === 403) {
            // Step 2: fall back to Quick
            var rQRes = UrlFetchApp.fetch(
              'https://emailverifier.reoon.com/api/v1/verify?email=test%40gmail.com&key=' +
              encodeURIComponent(reoonKey) + '&mode=quick',
              { muteHttpExceptions: true });
            var rQCode = rQRes.getResponseCode();
            var rQText = rQRes.getContentText() || '';
            reoonProbe.quickHttpCode = rQCode;
            if (rQCode === 200) {
              var rQJson = null; try { rQJson = JSON.parse(rQText); } catch (_) {}
              reoonProbe.ok = !!(rQJson && rQJson.status);
              reoonProbe.activeMode = 'quick';
              reoonProbe.degradedToQuick = true;
              reoonProbe.status = rQJson && rQJson.status;
            } else {
              reoonProbe.ok = false;
              reoonProbe.errorPreview = rQText.substring(0, 200);
            }
          } else {
            reoonProbe.ok = false;
            reoonProbe.errorPreview = rPText.substring(0, 250);
          }
          // Show quota status alongside
          if (typeof getReoonQuickQuotaStatus === 'function') {
            try { reoonProbe.quickQuotaToday = getReoonQuickQuotaStatus(); } catch (_) {}
          }
          report.results.reoon = reoonProbe;
        }
      } catch (e) {
        report.results.reoon = { ok: false, reason: 'threw: ' + e.message };
      }

      // ─── Apollo /organizations/search (free tier endpoint) ───
      try {
        var apolloKey = props.getProperty('APOLLO_API_KEY') || '';
        if (!apolloKey) {
          report.results.apollo = { ok: false, reason: 'key_unset' };
        } else {
          var aRes = UrlFetchApp.fetch('https://api.apollo.io/api/v1/organizations/search', {
            method: 'post',
            contentType: 'application/json',
            headers: { 'Cache-Control': 'no-cache', 'X-Api-Key': apolloKey },
            payload: JSON.stringify({ q_organization_name: 'Stripe', per_page: 1 }),
            muteHttpExceptions: true
          });
          var aCode = aRes.getResponseCode();
          var aText = aRes.getContentText() || '';
          var aJson = null;
          try { aJson = JSON.parse(aText); } catch (_) {}
          var orgCount = (aJson && aJson.organizations && aJson.organizations.length) || 0;
          // PATCH 2026-05-20: paymentBlock detector is now strict — only fires
          // on Apollo's actual error message format (errors[].message contains
          // "payment" / "subscription" / "billing"). Previously matched any
          // occurrence of those words anywhere in the response, which produced
          // false positives because Apollo's success responses can contain
          // feature-flag strings like "payments_industry".
          var paymentBlockDetected = false;
          if (aCode !== 200) {
            paymentBlockDetected = /payment\s+required|subscription\s+(expired|required)|billing\s+(issue|required)|account\s+suspended/i.test(aText);
          } else if (aJson && aJson.error) {
            paymentBlockDetected = /payment|subscription|billing/i.test(JSON.stringify(aJson.error));
          }
          report.results.apollo_orgs = {
            ok: aCode === 200 && orgCount > 0,
            httpCode: aCode,
            orgsReturned: orgCount,
            firstResult: orgCount > 0 ? { name: aJson.organizations[0].name, domain: aJson.organizations[0].primary_domain } : null,
            errorPreview: aCode !== 200 ? aText.substring(0, 300) : null,
            paymentBlock: paymentBlockDetected
          };
        }
      } catch (e) {
        report.results.apollo_orgs = { ok: false, reason: 'threw: ' + e.message };
      }

      // ─── Apollo /people/match (paid tier endpoint) ───
      try {
        var apolloKey2 = props.getProperty('APOLLO_API_KEY') || '';
        if (!apolloKey2) {
          report.results.apollo_people = { ok: false, reason: 'key_unset' };
        } else {
          // Use a public LinkedIn profile that has been around for years
          var pRes = UrlFetchApp.fetch('https://api.apollo.io/api/v1/people/match', {
            method: 'post',
            contentType: 'application/json',
            headers: { 'X-Api-Key': apolloKey2 },
            payload: JSON.stringify({ linkedin_url: 'https://www.linkedin.com/in/williamhgates' }),
            muteHttpExceptions: true
          });
          var pCode = pRes.getResponseCode();
          var pText = pRes.getContentText() || '';
          var pJson = null;
          try { pJson = JSON.parse(pText); } catch (_) {}
          var hasPerson = !!(pJson && pJson.person);
          // Same strict detector as apollo_orgs above
          var pPaymentBlock = false;
          var pPaidPlanRequired = false;
          if (pCode !== 200) {
            pPaymentBlock = /payment\s+required|subscription\s+(expired|required)|billing\s+(issue|required)|account\s+suspended/i.test(pText);
            pPaidPlanRequired = /paid\s+plan\s+required|upgrade\s+(your\s+plan|required)|feature\s+requires/i.test(pText);
          } else if (pJson && pJson.error) {
            pPaymentBlock = /payment|subscription|billing/i.test(JSON.stringify(pJson.error));
          }
          report.results.apollo_people = {
            ok: pCode === 200 && hasPerson,
            httpCode: pCode,
            personReturned: hasPerson,
            personName: hasPerson ? pJson.person.name : null,
            paidPlanRequired: pPaidPlanRequired,
            paymentBlock: pPaymentBlock,
            errorPreview: pCode !== 200 ? pText.substring(0, 300) : null
          };
        }
      } catch (e) {
        report.results.apollo_people = { ok: false, reason: 'threw: ' + e.message };
      }

      // ─── Hunter Email Verifier ───
      try {
        var hunterKey = props.getProperty('HUNTER_API_KEY') || '';
        if (!hunterKey) {
          report.results.hunter = { ok: false, reason: 'key_unset' };
        } else {
          var hRes = UrlFetchApp.fetch('https://api.hunter.io/v2/email-verifier?email=patrick@stripe.com&api_key=' +
                                       encodeURIComponent(hunterKey), { muteHttpExceptions: true });
          var hCode = hRes.getResponseCode();
          var hText = hRes.getContentText() || '';
          var hJson = null;
          try { hJson = JSON.parse(hText); } catch (_) {}
          report.results.hunter = {
            ok: hCode === 200 && hJson && hJson.data,
            httpCode: hCode,
            status: hJson && hJson.data && hJson.data.status,
            score: hJson && hJson.data && hJson.data.score,
            quotaUsed: hJson && hJson.meta && hJson.meta.requests,
            quotaTotal: hJson && hJson.meta && hJson.meta.params && hJson.meta.params.requests_available,
            errorPreview: hCode !== 200 ? hText.substring(0, 250) : null
          };
        }
      } catch (e) {
        report.results.hunter = { ok: false, reason: 'threw: ' + e.message };
      }

      // ─── Claude (Anthropic) ───
      try {
        var claudeKey = props.getProperty('CLAUDE_API_KEY') || '';
        if (!claudeKey) {
          report.results.claude = { ok: false, reason: 'key_unset' };
        } else {
          var cRes = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
            method: 'post',
            contentType: 'application/json',
            headers: {
              'x-api-key': claudeKey,
              'anthropic-version': '2023-06-01'
            },
            payload: JSON.stringify({
              model: 'claude-haiku-4-5',
              max_tokens: 10,
              messages: [{ role: 'user', content: 'reply with the single word: OK' }]
            }),
            muteHttpExceptions: true
          });
          var cCode = cRes.getResponseCode();
          var cText = cRes.getContentText() || '';
          var cJson = null;
          try { cJson = JSON.parse(cText); } catch (_) {}
          report.results.claude = {
            ok: cCode === 200,
            httpCode: cCode,
            modelUsed: cJson && cJson.model,
            reply: cJson && cJson.content && cJson.content[0] && cJson.content[0].text,
            errorPreview: cCode !== 200 ? cText.substring(0, 250) : null
          };
        }
      } catch (e) {
        report.results.claude = { ok: false, reason: 'threw: ' + e.message };
      }

      // ─── Synthesis ───
      var failed = [];
      Object.keys(report.results).forEach(function(k) {
        if (!report.results[k].ok) failed.push(k);
      });
      report.summary = {
        totalProbed: Object.keys(report.results).length,
        liveCount: Object.keys(report.results).length - failed.length,
        failedServices: failed,
        verdict: failed.length === 0
          ? 'ALL APIS HEALTHY'
          : 'FAILURES: ' + failed.join(', ') + ' — these explain why enrichment is starving'
      };
      return { status: 'ok', health: report };
    })());
  }
  // PATCH 2026-05-19: read-only diagnostic for OrgRepair (Ranjan/HSBC RCA).
  // Reports whether a specific row's ORGANIZATION column would be flagged
  // as title-noise + what URL-fragment hint would be extracted. No API
  // calls, no sheet writes.
  //
  // Usage:  /exec?action=diagnose_org_repair&rowNum=<ROW>&token=<ADMIN>
  if (action === 'diagnose_org_repair' && _checkAuthToken_(e)) {
    return _webAppRespond((function() {
      var rowNum = (e && e.parameter && e.parameter.rowNum) ? parseInt(e.parameter.rowNum, 10) : 0;
      if (!rowNum || rowNum < 2) return { status: 'error', error: 'rowNum required (>=2)' };
      var lead = (typeof getLeadByRow === 'function') ? getLeadByRow(rowNum) : null;
      if (!lead) return { status: 'error', error: 'lead not found at row ' + rowNum };
      if (typeof diagnoseOrgRepair !== 'function') {
        return { status: 'error', error: 'diagnoseOrgRepair not defined - OrgRepair.gs not deployed?' };
      }
      return { status: 'ok', diagnose: diagnoseOrgRepair(lead) };
    })());
  }
  // PATCH 2026-05-19: force-run the OrgRepair on a specific row (LIVE — makes
  // Apollo calls + writes to sheet). Use this to manually unblock a known-
  // noisy row (e.g. Ranjan) without waiting for the scanner to pick it up.
  //
  // Usage:  /exec?action=force_org_repair&rowNum=<ROW>&token=<ADMIN>
  if (action === 'force_org_repair' && _checkAuthToken_(e)) {
    return _webAppRespond(_adminMutex_('force_org_repair', e, function(ee) {
      var rowNum = (ee && ee.parameter && ee.parameter.rowNum) ? parseInt(ee.parameter.rowNum, 10) : 0;
      if (!rowNum || rowNum < 2) return { status: 'error', error: 'rowNum required (>=2)' };
      var lead = (typeof getLeadByRow === 'function') ? getLeadByRow(rowNum) : null;
      if (!lead) return { status: 'error', error: 'lead not found at row ' + rowNum };
      if (typeof repairLeadOrgIfTitleNoise !== 'function') {
        return { status: 'error', error: 'repairLeadOrgIfTitleNoise not defined - OrgRepair.gs not deployed?' };
      }
      var result = repairLeadOrgIfTitleNoise(lead);
      return { status: 'ok', repair: result, leadAfter: { organization: lead.organization, orgDomain: lead.orgDomain, designation: lead.designation } };
    }));
  }
  // PATCH 2026-05-19: dry-run compose a CXO email for a specific lead, without
  // touching the sheet or creating a Gmail draft. Returns the parsed structure,
  // the rendered HTML, and any validator issues — so you can preview what the
  // new Leadership Master Template produces.
  //
  // Usage:  /exec?action=preview_cxo_email&rowNum=203&token=<ADMIN>
  if (action === 'preview_cxo_email' && _checkAuthToken_(e)) {
    return _webAppRespond((function() {
      var rowNum = (e && e.parameter && e.parameter.rowNum) ? parseInt(e.parameter.rowNum, 10) : 0;
      if (!rowNum || rowNum < 2) return { status: 'error', error: 'rowNum required (>=2)' };
      var lead = (typeof getLeadByRow === 'function') ? getLeadByRow(rowNum) : null;
      if (!lead) return { status: 'error', error: 'lead not found at row ' + rowNum };
      var dossier = {};
      try {
        if (lead.researchJson && lead.researchJson.length > 10) {
          dossier = JSON.parse(lead.researchJson);
        }
      } catch (_) { /* no dossier — Tier 3 will fill in */ }
      // Force CXO_SHORT classification regardless of the lead's natural
      // archetype, so the preview tests the new template wiring.
      var classification = {
        template: 'CXO_SHORT',
        archetype: 'C_SUITE',
        seniority: 'C_SUITE',
        approach: 'executive brief, peer-to-peer, high signal density',
        industry: lead.industry || ''
      };
      var resumeSelection = { variantId: 'PRODUCT_AI_STRATEGY' };
      try {
        var composed = composeEmail(lead, dossier, classification, resumeSelection);
        var parsed = composed && composed.parsed ? composed.parsed : null;
        return {
          status: 'ok',
          preview: {
            rowNum: rowNum,
            fullName: lead.fullName,
            organization: lead.organization,
            success: !!(composed && composed.success),
            qualityNotes: composed && composed.qualityNotes,
            subjectLine: composed && composed.subjectLine,
            youngestInBody: parsed ? /youngest/i.test([parsed.hookParagraph, parsed.motivationParagraph, parsed.bridgeSentence, parsed.psLine, parsed.closingLogistics].join(' ')) : null,
            bannerPresent: !!(composed && composed.emailBody && composed.emailBody.indexOf('cid:emailBanner') >= 0),
            closingResumePresent: !!(parsed && parsed.closingResume && parsed.closingResume.length > 0),
            bodyWordCount: parsed && parsed.emailBody ? parsed.emailBody.split(/\s+/).filter(function(w){return w.length>0;}).length : null,
            parsed: parsed ? {
              subjectLine: parsed.subjectLine,
              greeting: parsed.greeting,
              hookParagraph: parsed.hookParagraph,
              motivationParagraph: parsed.motivationParagraph,
              bridgeSentence: parsed.bridgeSentence,
              closingLogistics: parsed.closingLogistics,
              closingResume: parsed.closingResume,
              signoffText: parsed.signoffText,
              psLine: parsed.psLine,
              experienceBullets: (parsed.experienceBullets || []).length,
              showAiToolsBlock: parsed.showAiToolsBlock,
              _injectedFields: parsed._injectedFields || []
            } : null,
            htmlPreview: composed && composed.emailBody ? composed.emailBody.substring(0, 4000) : ''
          }
        };
      } catch (err) {
        return { status: 'error', error: 'preview threw: ' + err.message, stack: err.stack };
      }
    })());
  }
  if (action === 'diagnose_pipeline_health' && _checkAuthToken_(e)) {
    return _webAppRespond({
      status: 'ok',
      diagnostic: diagnosePipelineHealth({
        n: (e && e.parameter && e.parameter.n) ? parseInt(e.parameter.n, 10) : 5
      })
    });
  }
  if (action === 'inspect_stuck_rows' && _checkAuthToken_(e)) {
    return _webAppRespond({
      status: 'ok',
      inspect: inspectStuckRows({
        limit: (e && e.parameter && e.parameter.limit) ? parseInt(e.parameter.limit, 10) : undefined,
        statuses: (e && e.parameter && e.parameter.statuses)
          ? e.parameter.statuses.split(',').map(function(s){ return s.trim(); })
          : undefined
      })
    });
  }
  // PATCH 2026-05-19: clears dedupe cache for stuck rows + resets stale
  // transient-state rows + invokes scanner synchronously. Use when verify
  // shows NEW/RESEARCHING rows that haven't moved despite triggers being
  // installed and functional.
  //
  // Usage:  /exec?action=force_scan_stuck&dryRun=1&token=<ADMIN>   ← preview
  //         /exec?action=force_scan_stuck&token=<ADMIN>            ← live
  if (action === 'force_scan_stuck' && _checkAuthToken_(e)) {
    return _webAppRespond(_adminMutex_('force_scan_stuck', e, function(ee) {
      var opts = {
        dryRun: (ee && ee.parameter && (ee.parameter.dryRun === '1' || ee.parameter.dryRun === 'true')),
        skipForceScanInvocation: (ee && ee.parameter && (ee.parameter.skipScan === '1'))
      };
      return { status: 'ok', force: forceScanStuckRows(opts) };
    }));
  }
  if (action === 'set_script_property' && _checkAuthToken_(e)) {
    return _webAppRespond(_adminMutex_('set_script_property', e, function(ee) {
      var name  = (ee && ee.parameter && ee.parameter.name)  || '';
      var value = (ee && ee.parameter && ee.parameter.value) || '';
      var ALLOWED = {
        'REOON_API_KEY': 1, 'HUNTER_API_KEY': 1,
        'APOLLO_API_KEY': 1, 'APOLLO_API_KEY_FALLBACK': 1,
        'CLAUDE_API_KEY': 1, 'CLAUDE_API_KEY_BACKUP': 1,
        'GEMINI_API_KEY': 1,
        'AUTOMAIL_WEBAPP_SECRET': 1,
        'LOR_DRIVE_ID': 1,
        'RESUME_DRIVE_ID_GROWTH': 1,
        'RESUME_DRIVE_ID_OPS': 1,
        'RESUME_DRIVE_ID_PRODUCT': 1
      };
      if (!name || !ALLOWED[name]) {
        return { status: 'fail', reason: 'name not in whitelist',
                 allowed: Object.keys(ALLOWED) };
      }
      if (!value || value.length < 4) {
        return { status: 'fail', reason: 'value missing or too short' };
      }
      var props = PropertiesService.getScriptProperties();
      var oldVal = props.getProperty(name) || '';
      props.setProperty(name, value);
      return {
        status: 'ok',
        property: name,
        previousPreview: oldVal ? (oldVal.substring(0, 6) + '... length=' + oldVal.length) : '<unset>',
        newPreview: value.substring(0, 6) + '... length=' + value.length
      };
    }));
  }
  // PATCH 2026-05-15: on-demand health-check trigger. Lets you verify all
  // 4 probes (Claude / Gemini / Gmail / Drive) by URL after a key rotation
  // or redeploy, without waiting for the 6-hour cron. Writes results to
  // Health sheet AND returns them inline so you can see immediately.
  if (action === 'run_health_check' && _checkAuthToken_(e)) {
    if (typeof runHealthCheck !== 'function') {
      return _webAppRespond({ status: 'error', error: 'runHealthCheck_not_loaded' });
    }
    try {
      var hc = runHealthCheck();
      return _webAppRespond({ status: 'ok', ts: hc.ts, results: hc.results });
    } catch (hcErr) {
      return _webAppRespond({ status: 'error', error: hcErr.message });
    }
  }
  // One-shot setup endpoint — guarded by a fixed token. After running once,
  // remove this dispatch line (or rotate the token) to prevent unauthorized
  // reconfiguration. Token chosen 2026-05-12; not committed elsewhere.
  if (action === 'setup_install_keys' && _checkAuthToken_(e)) {
    if (typeof installForcedApiKeys2026_05_12 === 'function') {
      return _webAppRespond(installForcedApiKeys2026_05_12());
    }
    return _webAppRespond({ status: 'error', error: 'setup_function_missing' });
  }
  if (action === 'setup_install_fcm' && _checkAuthToken_(e)) {
    if (typeof installFcmServiceAccount === 'function') {
      return _webAppRespond(installFcmServiceAccount());
    }
    return _webAppRespond({ status: 'error', error: 'fcm_install_fn_missing' });
  }
  if (action === 'verify_fcm' && _checkAuthToken_(e)) {
    if (typeof verifyFcmSetup === 'function') return _webAppRespond(verifyFcmSetup());
    return _webAppRespond({ status: 'error', error: 'verify_fcm_fn_missing' });
  }
  if (action === 'fcm_test_push' && _checkAuthToken_(e)) {
    if (typeof sendFcmBroadcast === 'function') {
      return _webAppRespond(sendFcmBroadcast('🧪 FCM test push',
        'If you see this on your phone, FCM is live end-to-end.',
        { event: 'test', ts: new Date().toISOString() }));
    }
    return _webAppRespond({ status: 'error', error: 'sendFcmBroadcast_missing' });
  }

  var props = PropertiesService.getScriptProperties();
  var K = (CONFIG && CONFIG.PROPERTY_KEYS) || {};

  return ContentService.createTextOutput(JSON.stringify({
    status: 'active',
    service: 'AutoMail Pipeline Web App',
    version: '3.0',
    // PATCH 2026-05-15: deploymentStamp — bumped manually with every UI
    // redeploy. After clasp push + UI redeploy, hit the default GET and
    // confirm this string matches the latest source commit. If it shows an
    // older value, the UI redeploy didn't take. The string is a free-form
    // human label, format: YYYY-MM-DD-shorttag. Update on every meaningful
    // server-side change you intend to deploy.
    deploymentStamp: '2026-06-13-sheet1-search',
    features: ['linkedin_apk_capture', 'extension_share', 'pwa_share', 'automail_sync'],
    deployed: true,
    config: {
      secretConfigured: !!props.getProperty(K.AUTOMAIL_WEBAPP_SECRET || 'AUTOMAIL_WEBAPP_SECRET'),
      reoonConfigured:  !!props.getProperty(K.REOON_API_KEY || 'REOON_API_KEY'),
      hunterConfigured: !!props.getProperty(K.HUNTER_API_KEY || 'HUNTER_API_KEY'),
      lorConfigured:    !!props.getProperty(K.LOR_DRIVE_ID || 'LOR_DRIVE_ID'),
      sheetId:          CONFIG.SHEET_ID,
      dataSheet:        CONFIG.DATA_SHEET,
      colCount:         CONFIG.SHEET_COL_COUNT
    },
    accepts: {
      apk: '{timestamp, linkedinUrl, fullName, headline, currentDesignation, currentOrganization, email, phone, website, location, connectionDegree, confidence}',
      extensionOrPwa: '{linkedinUrl, source, sharedAt, [secret]}'
    },
    timestamp: new Date().toISOString()
  })).setMimeType(ContentService.MimeType.JSON);
}

// ─── APK PAYLOAD HANDLER (writes Sheet1 raw + Sheet2 pipeline) ─────

// ─── Confidence normalization helper (Patch 2026-05-11) ────────────────────
//
// APK sends `confidence` as integer 0-100 (since 2026-05-11). Older APK builds
// sent 0-1 float. Server pipeline downstream uses 0-1 floats. Normalize on
// input so Sheet1 always stores 0-100 (matching what users see in the app)
// and the pipeline reads a consistent shape regardless of source. Accepts:
//   - int/float 0-1   → multiplies by 100
//   - int 1-100       → kept as-is
//   - "92%" string    → parsed
//   - null/missing    → empty string

function _normalizeConfidence(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'string') {
    v = v.replace('%', '').trim();
    if (!v) return '';
    v = parseFloat(v);
  }
  if (!isFinite(v)) return '';
  if (v <= 1.0 && v > 0) return Math.round(v * 100);
  if (v < 0) return 0;
  if (v > 100) return 100;
  return Math.round(v);
}

function _handleApkPayload(data) {
  // ═══════════════════════════════════════════════════════════════════
  // 2026-05-11 SERVER-SIDE SANITY PASS (belt-and-suspenders).
  //
  // The Chrome extension does its own sanitization (sanitizeExtractedProfile)
  // BEFORE POSTing, but the APK + older extensions don't. Server-side defense
  // catches the same wrong-field-mapping patterns observed in production:
  //   - fullName containing a URL → move to linkedinUrl, blank fullName
  //   - email = "• 2nd" or any string without @ → blank email
  //   - organization = "• 2nd" → blank organization
  //   - any field with trailing "• 2nd" connection-degree noise → strip
  //
  // This means even an unpatched APK/extension can't poison Sheet1/Sheet2.
  // ═══════════════════════════════════════════════════════════════════
  data = _sanitizeIncomingPayload(data || {});

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);

  // ── Sheet1: raw audit log of every APK capture, regardless of email ──
  var sheet1 = ss.getSheetByName('Sheet1');
  if (!sheet1) {
    sheet1 = ss.insertSheet('Sheet1');
  }
  if (sheet1.getLastRow() === 0) {
    // Phase 3: Sheet1 now has a 13th column for LEAD_UID.
    sheet1.appendRow([
      'Timestamp', 'LinkedIn_URL', 'Full_Name', 'Headline',
      'Designation', 'Organization', 'Email', 'Phone',
      'Website', 'Location', 'Connection', 'Confidence',
      'Lead_UID'
    ]);
    sheet1.getRange(1, 1, 1, 13).setFontWeight('bold');
  }

  // Phase 3 — Resolution A dedup, now atomic (QC1): if the same linkedinUrl was
  // captured within LEAD_UID_DEDUP_WINDOW_MS (5 min), reuse its UID and skip the
  // appendRow. The lookup + append run under a short script lock so two
  // concurrent same-URL captures (APK burst) cannot both append a row.
  // Tests: leaduid_dedup_same_url_within_window_reuses_uid (logic),
  //        webapp_dedup_concurrent_same_url_appends_one_row (race).
  var linkedinUrl = data.linkedinUrl || '';
  // VERIFY-FIX (2026-07-06-apk-guess-gate): the app's never-blank fallback POSTs a LOW-
  // confidence pattern GUESS (emailSource='pattern_guess_unverified'). Sheet1's 12-col
  // schema can't carry the source, so writing that guess into col G lets EmailFinalizer's
  // S1 sheet-email precedence finalize it as source='sheet_captured' tier='verified' with
  // NO [VERIFY] flag (worse while the Reoon breaker is skipped). Drop the guess here so the
  // server re-derives + Reoon-gates + [VERIFY]-flags it. The app still DISPLAYS its guess
  // on-device — this only governs what the pipeline treats as a captured address.
  // Kill-switch: APK_GUESS_EMAIL_GATE_ENABLED='0' restores the raw pass-through.
  var _apkEmailSrc = String(data.emailSource || '').toLowerCase();
  var _apkGuessGateOn = PropertiesService.getScriptProperties()
                          .getProperty('APK_GUESS_EMAIL_GATE_ENABLED') !== '0';
  var _apkEmailIsGuess = _apkGuessGateOn &&
        (_apkEmailSrc.indexOf('guess') !== -1 || _apkEmailSrc.indexOf('unverified') !== -1);
  var _apkEmailForSheet = _apkEmailIsGuess ? '' : (data.email || '');
  if (_apkEmailIsGuess) {
    Logger.log('[WebApp] APK pattern-guess email dropped from col G (source=' + _apkEmailSrc +
               '); server will enrich + [VERIFY]. was: ' + (data.email || ''));
  }
  var capture = _resolveCaptureUid_(sheet1, linkedinUrl, function(uid) {
    return [
      data.timestamp || new Date().toISOString(),
      linkedinUrl,
      data.fullName || '',
      data.headline || '',
      data.currentDesignation || data.designation || '',
      data.currentOrganization || data.organization || '',
      _apkEmailForSheet,
      data.phone || '',
      data.website || '',
      data.location || '',
      data.connectionDegree || '',
      _normalizeConfidence(data.confidence || data.confidenceScore || data.extractionConfidence),
      uid
    ];
  });
  var leadUid = capture.leadUid;
  if (capture.dedup) {
    Logger.log('[WebApp] APK dedup: same URL captured within ' +
               (CONFIG.LEAD_UID_DEDUP_WINDOW_MS / 60000) + 'm; reusing UID ' + leadUid);
  }

  // ── Sheet2: AUTO-POPULATED FROM SHEET1 VIA `=UNIQUE(Sheet1!B2:G)` FORMULA ──
  //
  // 2026-05-11 ARCHITECTURE CHANGE: Sheet1 is now the SINGLE SOURCE OF TRUTH.
  // Sheet2 cell A2 holds `=UNIQUE(Sheet1!B2:G)` which spills into Sheet2!A2:F[N]
  // with one unique-tuple row per real lead. WebApp no longer writes Sheet2
  // directly — that's the formula's job. Pipeline still writes state to cols
  // G-Z keyed by row number (UNIQUE preserves input order so additive Sheet1
  // writes keep state stable).
  //
  // INVARIANT: callers must keep Sheet1 append-only. DELETING or EDITING Sheet1
  // rows reorders UNIQUE → orphans G-Z pipeline state. This is documented in
  // setupSheet2AsFormulaView() in DiagnosticHelper.gs.
  //
  // Best-effort: ensure the formula exists. If user hasn't run the migration
  // helper, install the formula on the fly (idempotent — never overwrites).
  var syncStatus = 'sheet1_only';
  var pipelineRow = 0;
  try {
    _ensureSheet2UniqueFormula(ss);
    // Look up the row that UNIQUE will park this lead at, for the response.
    // Formula recalc is async on the next read — we approximate by counting
    // Sheet2's lastRow + 1 (since UNIQUE appends new tuples at the bottom).
    var sheet2Lookup = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (sheet2Lookup) pipelineRow = sheet2Lookup.getLastRow();  // approximate
  } catch (formulaErr) {
    Logger.log('[WebApp] Sheet2 formula ensure error: ' + formulaErr.message);
    syncStatus = 'sheet1_only_formula_check_failed';
  }

  Logger.log('[WebApp] APK payload processed — Sheet1 logged, Sheet2 ' + syncStatus +
             (pipelineRow ? ' (~ row ' + pipelineRow + ')' : ''));

  // PATCH 2026-05-13 (immediate-trigger fix): kick off the pipeline right
  // now instead of waiting for cron / onChange. Flushes Sheet2 UNIQUE()
  // formula then directly invokes the scanner. See _kickoffAfterCapture
  // for the full diagnosis + rationale.
  _kickoffAfterCapture('APK');

  // Return the EXACT response shape the APK expects (per README):
  //   { "status": "success", "automail_sync": "synced" }
  // Phase 3: leadUid surfaced for client-side correlation. dedup=true means
  // we reused an existing capture's UID; false means a fresh row was appended.
  return _webAppRespond({
    status: 'success',
    message: 'Data received',
    automail_sync: syncStatus,
    pipelineRow: pipelineRow,
    leadUid: leadUid,
    dedup: capture.dedup,
    kickoff: 'queued'   // PATCH 2026-06-12-fast-ack: pipeline queued via async trigger (not in-request)
  });
}

// ─── Sheet2 UNIQUE-formula installer (idempotent) ─────────────────────────
//
// Verifies Sheet2!A2 contains `=UNIQUE(Sheet1!B2:G)`. If empty or different,
// installs the formula WITHOUT overwriting any pipeline state in cols G-Z.
// Called best-effort from doPost handlers so that new deployments don't
// require a separate user action to "wire up" the architecture.
function _ensureSheet2UniqueFormula(ss) {
  var sheet2 = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet2) return;  // header init happens elsewhere on first APK call
  var existing = sheet2.getRange('A2').getFormula();
  if (existing && existing.indexOf('UNIQUE') >= 0 && existing.indexOf('Sheet1') >= 0) {
    return;  // already wired
  }
  // Only auto-install when A2 is empty — never clobber manual data.
  var a2Value = sheet2.getRange('A2').getValue();
  if (a2Value !== '' && a2Value !== null) return;
  sheet2.getRange('A2').setFormula('=UNIQUE(Sheet1!B2:G)');
  Logger.log('[WebApp] Installed `=UNIQUE(Sheet1!B2:G)` at Sheet2!A2');
}

// ─── MINIMAL PAYLOAD HANDLER (Chrome ext, PWA) ─────────────────────

function _handleMinimalPayload(body) {
  var url = (body.linkedinUrl || '').toString().trim();
  if (!url) {
    return _webAppRespond({ status: 'error', error: 'missing_linkedinUrl' });
  }
  if (!/^https?:\/\/([a-z]+\.)?linkedin\.com\/in\/[^\s/?#]+/i.test(url)) {
    return _webAppRespond({ status: 'error', error: 'not_a_linkedin_profile_url' });
  }

  var source = (body.source || 'unknown').toString().substring(0, 60);
  var sharedAt = body.sharedAt ? new Date(body.sharedAt) : new Date();

  // 2026-05-11 ARCHITECTURE CHANGE: write Sheet1 only. Sheet2!A2 =
  // UNIQUE(Sheet1!B2:G) will auto-pull this URL into Sheet2 cols A-F.
  // For URL-only captures, the name/headline/org/email columns will be empty
  // strings → Sheet2 will show the URL with blank context. The pipeline's
  // scanner reads Sheet2 + enricher handles empty-context rows gracefully
  // (returns NEEDS_EMAIL_REVIEW or NEEDS_EMAIL).
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);

  var sheet1 = ss.getSheetByName('Sheet1');
  if (!sheet1) {
    sheet1 = ss.insertSheet('Sheet1');
    // Phase 3: Sheet1 13-column header (LEAD_UID at col 13/M).
    sheet1.appendRow([
      'Timestamp', 'LinkedIn_URL', 'Full_Name', 'Headline',
      'Designation', 'Organization', 'Email', 'Phone',
      'Website', 'Location', 'Connection', 'Confidence',
      'Lead_UID'
    ]);
    sheet1.getRange(1, 1, 1, 13).setFontWeight('bold');
  }

  // Phase 3 — Resolution A dedup, now atomic (QC1): same URL within window →
  // reuse UID, no new row. Lookup + append run under a short script lock so two
  // concurrent same-URL captures cannot both append.
  // Tests: leaduid_dedup_same_url_within_window_reuses_uid (logic),
  //        webapp_dedup_concurrent_same_url_appends_one_row (race).
  var capture = _resolveCaptureUid_(sheet1, url, function(uid) {
    return [
      new Date().toISOString(),
      url,
      '',  // fullName
      '',  // headline
      '',  // designation
      '',  // organization
      '',  // email
      '',  // phone
      '',  // website
      '',  // location
      '',  // connection
      '',  // confidence
      uid
    ];
  });
  var leadUid = capture.leadUid;
  var newSheet1Row = sheet1.getLastRow();  // dedup branch: last row is not this lead's row (approximate, response-only)
  if (capture.dedup) {
    Logger.log('[WebApp] Minimal dedup: same URL within ' +
               (CONFIG.LEAD_UID_DEDUP_WINDOW_MS / 60000) + 'm; reusing UID ' + leadUid);
  }

  // Best-effort: ensure Sheet2 UNIQUE formula is wired
  try { _ensureSheet2UniqueFormula(ss); } catch (_) {}

  Logger.log('[WebApp] Minimal payload: appended ' + url + ' from ' + source +
             ' → Sheet1 row ' + newSheet1Row + ' (URL-only, UNIQUE will pull to Sheet2)' +
             (capture.dedup ? ' [DEDUP — UID ' + leadUid + ']' : ' [NEW — UID ' + leadUid + ']'));

  // PATCH 2026-05-13 (immediate-trigger fix): same kickoff as APK path.
  _kickoffAfterCapture('MINIMAL:' + source);

  return _webAppRespond({
    status: 'ok',
    message: 'Sheet1 row ' + newSheet1Row + ' written; Sheet2 will auto-populate via UNIQUE formula',
    sheet1Row: newSheet1Row,
    url: url,
    leadUid: leadUid,
    dedup: capture.dedup,
    kickoff: 'queued'   // PATCH 2026-06-15-authgate-hygiene: queued via async trigger, matching the APK path (one-shot removed at final-cert; the in-request literal was stale)
  });
}

// ─── Phase 3: LEAD_UID helpers ──────────────────────────────────────────────

/**
 * Generate a stable UUID for a lead. Mockable via _svc('Utilities') for test
 * determinism — tests can inject `{ getUuid: function(){ return 'fixed-uid'; } }`.
 * Production: Utilities.getUuid() returns RFC4122 v4 string-form UUID.
 */
function _generateLeadUid() {
  if (typeof _svc === 'function') {
    try { return _svc('Utilities').getUuid(); } catch (_) {}
  }
  return Utilities.getUuid();
}

/**
 * Resolution A: scan Sheet1 backwards for a row matching `linkedinUrl` with
 * timestamp within `CONFIG.LEAD_UID_DEDUP_WINDOW_MS`. If found, return the
 * row's LEAD_UID (col 13). If not, return null — caller appends a new row.
 *
 * Scan strategy: read the LAST ~50 rows only (most recent captures). The
 * dedup window is 5 min, so anything older won't match. Bounded read prevents
 * full-sheet scans on every doPost.
 *
 * Returns: string UID or null.
 */
function _findRecentSheet1UidForUrl(sheet1, linkedinUrl) {
  if (!linkedinUrl) return null;
  var lastRow = sheet1.getLastRow();
  if (lastRow < 2) return null;
  // Tail-scan up to 50 rows (or all if fewer)
  var scanCount = Math.min(50, lastRow - 1);
  var startRow = lastRow - scanCount + 1;
  if (startRow < 2) startRow = 2;
  var rows = sheet1.getRange(startRow, 1, lastRow - startRow + 1,
                              CONFIG.SHEET1_COL_COUNT).getValues();
  var windowMs = CONFIG.LEAD_UID_DEDUP_WINDOW_MS;
  var nowMs = Date.now();
  // Iterate newest-to-oldest (reverse) so we return the most recent match
  for (var i = rows.length - 1; i >= 0; i--) {
    var row = rows[i];
    var rowUrl = (row[CONFIG.SHEET1_COLUMNS.LINKEDIN_URL - 1] || '').toString().trim();
    if (rowUrl !== linkedinUrl) continue;
    // Timestamp check
    var ts = row[CONFIG.SHEET1_COLUMNS.TIMESTAMP - 1];
    var tsMs = 0;
    if (ts) {
      try {
        tsMs = (ts instanceof Date) ? ts.getTime() : new Date(ts.toString()).getTime();
      } catch (_) {}
    }
    if (tsMs && (nowMs - tsMs) <= windowMs) {
      var uid = (row[CONFIG.SHEET1_COLUMNS.LEAD_UID - 1] || '').toString().trim();
      if (uid) return uid;
    }
  }
  return null;
}

/**
 * Phase 3 QC1 follow-up — close the lookup-then-append TOCTOU race in doPost.
 *
 * THE RACE: two doPost executions for the SAME linkedinUrl arriving within
 * milliseconds (APK "share" burst, or APK + Chrome-extension double capture)
 * each run _findRecentSheet1UidForUrl BEFORE either appends. Both see no match,
 * both _generateLeadUid(), both sheet1.appendRow() → two Sheet1 rows → two
 * Sheet2 UNIQUE() rows → two pipeline runs for one human. The 5-min temporal
 * dedup window (_findRecentSheet1UidForUrl) does NOT cover this: it is itself a
 * check-then-act, and the second execution's "check" races the first's "act".
 *
 * THE FIX: serialize the check-then-act with a short SCRIPT lock. Apps Script
 * dispatches concurrent doPost invocations as separate executions;
 * getScriptLock() is the documented cross-execution mutex. The second execution
 * blocks on tryLock until the first releases (find+append is fast), THEN runs
 * its find — which now sees the first's appended row → reuses its UID → no
 * second row. Routed through _svc('Lock') for the same mockability the rest of
 * the pipeline uses (BatchProcessor/Scanner/LeadUidBackfill).
 *
 * SCOPE: the lock wraps ONLY find+append. Callers run _kickoffAfterCapture (the
 * scanner — which takes its OWN script lock and runs for seconds) AFTER this
 * returns. Holding across kickoff would serialize the whole pipeline behind
 * every capture and risk self-contention.
 *
 * DEGRADED PATH: if tryLock times out (sustained contention beyond the window),
 * log and PROCEED with the append rather than drop the capture. A rare
 * duplicate is recoverable; a lost lead is not. Strict improvement over the
 * always-racy status quo, with no lead-loss failure mode added.
 *
 * Tests: webapp_dedup_concurrent_same_url_appends_one_row (race + fix),
 *        webapp_capture_lock_timeout_proceeds_unlocked (degraded path),
 *        webapp_dopost_paths_route_through_capture_lock (wiring).
 *
 * @param {Sheet}    sheet1       resolved Sheet1 object
 * @param {string}   linkedinUrl  capture URL (dedup key)
 * @param {Function} rowBuilder   fn(uid) → 13-col row to append when no recent
 *                                 same-URL match exists
 * @returns {{leadUid: string, dedup: boolean, lockAcquired: boolean}}
 */
// PATCH 2026-06-17-filter-fix: a basic filter on Sheet1 turns appendRow into a
// SILENT no-op (no thrown error, getLastRow never advances) — it froze ALL lead
// intake from 2026-06-15 (last good row: Sneha) until found 2026-06-17 via the
// menuDiagSheet1Append probe (hasFilter:true, incremented:false). Sheet1 is a
// machine-managed, append-only intake tab and must NEVER carry a filter. Strip
// any stray filter defensively before every capture append so a manual "Create
// filter" click in the Sheets UI can never silently kill intake again.
// Returns true if a filter was found and removed.
function _ensureNoSheet1Filter_(sheet1) {
  try {
    if (sheet1 && sheet1.getFilter()) {
      sheet1.getFilter().remove();
      Logger.log('[WebApp] Removed stray basic filter on Sheet1 — it was silently turning appendRow into a no-op.');
      return true;
    }
  } catch (e) {
    try { Logger.log('[WebApp] _ensureNoSheet1Filter_ non-fatal: ' + e.message); } catch (_) {}
  }
  return false;
}

function _resolveCaptureUid_(sheet1, linkedinUrl, rowBuilder) {
  var lockService = (typeof _svc === 'function') ? _svc('Lock') : LockService;
  var lock = lockService.getScriptLock();
  var timeoutMs = (CONFIG && CONFIG.CAPTURE_LOCK_TIMEOUT_MS) || 500;
  var lockAcquired = false;
  try {
    lockAcquired = lock.tryLock(timeoutMs);
  } catch (lockErr) {
    Logger.log('[WebApp] capture lock tryLock threw: ' + lockErr.message + ' — proceeding unlocked');
  }
  if (!lockAcquired) {
    Logger.log('[WebApp] capture lock not acquired within ' + timeoutMs + 'ms for "' +
               linkedinUrl + '" — proceeding unlocked (best-effort; rare dup risk)');
  }
  try {
    var existingUid = _findRecentSheet1UidForUrl(sheet1, linkedinUrl);
    if (existingUid) {
      return { leadUid: existingUid, dedup: true, lockAcquired: lockAcquired };
    }
    var newUid = _generateLeadUid();
    // PATCH 2026-06-17-filter-fix: strip any stray basic filter first — with one
    // present, this appendRow silently no-ops and the capture is lost (no error).
    _ensureNoSheet1Filter_(sheet1);
    sheet1.appendRow(rowBuilder(newUid));
    return { leadUid: newUid, dedup: false, lockAcquired: lockAcquired };
  } finally {
    // Only release a lock we actually hold — LockService.releaseLock() on an
    // unheld lock throws in production.
    if (lockAcquired) {
      try { lock.releaseLock(); } catch (_) {}
    }
  }
}

// ─── HELPERS ───────────────────────────────────────────────

function _webAppRespond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * PATCH 2026-05-13 (POST-AUDIT immediate-trigger fix).
 *
 * Forces the new lead to enter the pipeline immediately instead of waiting
 * 2-5 minutes for cron / debounced onChange. Called from both doPost
 * handlers (APK rich payload + extension/PWA minimal payload) AFTER the
 * Sheet1 appendRow but BEFORE returning the HTTP response.
 *
 * Failure-mode diagnosis (the user-reported "trigger isn't starting
 * immediately"):
 *   1. doPost appends to Sheet1 then returns.
 *   2. Sheet2 cell A2 = =UNIQUE(Sheet1!B2:G) needs a recalc to spill the
 *      new row into Sheet2. Without SpreadsheetApp.flush(), this is async.
 *   3. The onSheetChange handler fires from the Sheet1 write but reads
 *      Sheet2 — and Sheet2 may not have spilled yet → scanner returns 0
 *      candidates → no processing.
 *   4. Even when onChange does see the row, its 15-second debounce was
 *      swallowing back-to-back leads.
 *   5. Apps Script's onChange queue itself has 30s-2min delivery latency.
 *
 * Fix strategy:
 *   1. SpreadsheetApp.flush() forces UNIQUE() to recompute now (synchronous).
 *   2. Directly invoke _scanAndProcessNewRows() within the doPost — bypasses
 *      the entire onChange queue delay.
 *   3. Bounded by the scanner's own LockService + time budget, so this
 *      won't block the HTTP response longer than ~60-90s under normal load.
 *   4. Wrapped in try/catch so any scanner failure still returns clean
 *      HTTP 200 to the APK (the cron will catch the row later).
 *
 * Trade-off was: HTTP response is slower (the APK waits for processing).
 *
 * PATCH 2026-06-12-fast-ack (mobile timeout fix): Android HTTP clients fire a
 * "Sheet Export failed: Timeout" / "sheet sync error: Timeout" if the doPost
 * response exceeds ~30-60s. The synchronous _scanAndProcessNewRows call inside
 * the HTTP request was the sole cause — full research+compose pipeline takes
 * ~100s/lead and dispatched for up to 240s. The lead WAS captured (Sheet1
 * appendRow succeeded before kickoff); only the ack was delayed.
 *
 * Redundancy evidence (why dropping the in-request scan is safe):
 *   1. onSheetChange (installable onChange, BatchProcessor.gs) fires on the
 *      Sheet1 appendRow with a 3s debounce → _dispatchScanner('AUTO_CHANGE').
 *   2. autoProcessSafetyNet runs every 5 minutes → _dispatchScanner('SAFETY_NET').
 * Both paths carry the row independently; the in-request scan was redundant for
 * correctness and only bought latency / mobile timeouts.
 *
 * Belt-and-suspenders: a one-shot 5-second trigger for autoProcessSafetyNet is
 * created here to handle the rare case where the onChange event misses the row
 * (changeType=OTHER filtered, or debounce collision).
 *
 * PATCH 2026-06-12-fastack-guard (standing-cron protection): the old guard
 * deleted ALL CLOCK-based autoProcessSafetyNet triggers before creating a new
 * one-shot, which could delete the standing 5-minute recurring cron during a
 * capture burst (no reliable way to distinguish one-shot vs recurring via the
 * ScriptApp API without inspecting trigger IDs). Fix: coalesce — skip creating
 * a new one-shot when one was created <60s ago, tracked via ScriptProperty
 * FASTACK_LAST_ONESHOT_MS. GAS one-shot after() triggers auto-delete after
 * firing, so orphan one-shots from earlier burst captures self-expire without
 * any explicit cleanup. The standing cron is NEVER touched by this path.
 */

/**
 * Pure helper — returns true if a one-shot was already created within the last
 * `windowMs` milliseconds (default 60000). Reads ScriptProperty
 * FASTACK_LAST_ONESHOT_MS. Throws nothing; returns false on any error so the
 * caller always proceeds safely.
 * @param {number} [windowMs]
 * @return {boolean}
 */
function _isOneShotRecentEnough(windowMs) {
  try {
    var w = (typeof windowMs === 'number' && windowMs > 0) ? windowMs : 60000;
    var raw = PropertiesService.getScriptProperties().getProperty('FASTACK_LAST_ONESHOT_MS');
    if (!raw) return false;
    var last = parseInt(raw, 10);
    if (!isFinite(last)) return false;
    return (Date.now() - last) < w;
  } catch (_) {
    return false;
  }
}

function _kickoffAfterCapture(sourceLabel) {
  try {
    // Step 1: commit Sheet1 write + force Sheet2 UNIQUE() recalc (keep — needed
    // so the UNIQUE formula materializes before any async trigger reads Sheet2).
    SpreadsheetApp.flush();
  } catch (flushErr) {
    Logger.log('[WebApp/kickoff] flush failed (non-fatal): ' + flushErr.message);
  }
  // Step 2 (PATCH 2026-06-12-fast-ack): do NOT call _scanAndProcessNewRows here.
  // The synchronous scan blocked the HTTP response for up to ~100s, causing mobile
  // clients to fire "Timeout" even though the lead was already captured. The
  // onChange trigger + 5-min safety-net cron carry processing asynchronously.
  //
  // PATCH 2026-06-12-fastack-guard: belt-and-suspenders one-shot was created here,
  // but a coalesce guard (FASTACK_LAST_ONESHOT_MS) was insufficient: the property
  // write was inside a silently-swallowed catch, and concurrent doPost executions
  // could race through the guard before any one wrote the timestamp. Both failures
  // allowed one-shot accumulation (live: autoProcessSafetyNet=6, total=22 triggers,
  // hitting GAS 20-slot time-driven cap).
  //
  // PATCH 2026-06-13-final-cert (Option A — drop one-shots): The one-shot was
  // redundant per the comment block above _kickoffAfterCapture: onSheetChange fires
  // on the appendRow and the 5-min cron covers everything else. The ~4.5-minute
  // latency difference vs the trigger-cap breach risk is the wrong trade-off.
  // One-shot creation removed entirely. The standing 5-min cron is the sole fallback.
  Logger.log('[WebApp/kickoff] capture processed (flush done; onChange + 5-min cron will process) source=' +
             (sourceLabel || 'unknown'));
}

// ─── DIAGNOSTIC ENDPOINTS — read-only views into the pipeline ──────────
//
// These let you query the live pipeline state without trusting my code-trace
// analysis. The /exec URL serves them via the same auth model as doPost
// (URL is the credential; no secret required for read-only GETs).
//
// Usage:
//   /exec?action=logs                  — last 50 PipelineLog rows
//   /exec?action=logs&limit=20         — last 20 PipelineLog rows
//   /exec?action=logs&filter=email     — last 50 rows where message contains "email"
//   /exec?action=leads                 — last 25 Sheet2 rows with status + email + confidence
//   /exec?action=leads&status=NEEDS_EMAIL_REVIEW — only rows with that status
//   /exec?action=leads&limit=10

function _handleLogsRequest(e) {
  if (!_checkAuthToken_(e)) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error', error: 'authentication_required',
      message: 'Pass &token=<ADMIN_TOKEN> in the query string'
    })).setMimeType(ContentService.MimeType.JSON);
  }
  try {
    var p = (e && e.parameter) || {};
    var limit = parseInt(p.limit) || 50;
    if (limit < 1) limit = 1;
    if (limit > 200) limit = 200;
    var filter = (p.filter || '').toString().toLowerCase();

    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var logSheet = ss.getSheetByName(CONFIG.LOG_SHEET);
    if (!logSheet) {
      return _webAppRespond({ status: 'ok', logs: [], message: 'PipelineLog sheet does not exist yet' });
    }
    var lastRow = logSheet.getLastRow();
    if (lastRow < 2) {
      return _webAppRespond({ status: 'ok', logs: [], message: 'No log entries' });
    }
    // Read all rows (will be limited by GAS execution time, but PipelineLog
    // grows linearly; for very large logs we read just the last `limit + buffer` rows)
    var startRow = Math.max(2, lastRow - (limit * 4));  // 4x buffer for filter
    var data = logSheet.getRange(startRow, 1, lastRow - startRow + 1, 6).getValues();
    // Columns: Timestamp, Run_ID, Row, Stage, Level, Message
    var rows = data.map(function(r) {
      return {
        ts:    r[0] ? r[0].toString() : '',
        runId: r[1] ? r[1].toString() : '',
        row:   r[2],
        stage: r[3] ? r[3].toString() : '',
        level: r[4] ? r[4].toString() : '',
        msg:   r[5] ? r[5].toString().substring(0, 400) : ''
      };
    });
    if (filter) {
      rows = rows.filter(function(r) {
        return (r.stage + ' ' + r.level + ' ' + r.msg).toLowerCase().indexOf(filter) >= 0;
      });
    }
    // Return newest first, capped at `limit`
    rows = rows.reverse().slice(0, limit);

    return _webAppRespond({
      status: 'ok',
      sheet: CONFIG.LOG_SHEET,
      totalRowsInSheet: lastRow - 1,
      returnedCount: rows.length,
      filter: filter || '(none)',
      logs: rows
    });
  } catch (err) {
    return _webAppRespond({ status: 'error', error: err.message, where: '_handleLogsRequest' });
  }
}

function _handleLeadsRequest(e) {
  if (!_checkAuthToken_(e)) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error', error: 'authentication_required',
      message: 'Pass &token=<ADMIN_TOKEN> in the query string'
    })).setMimeType(ContentService.MimeType.JSON);
  }
  try {
    var p = (e && e.parameter) || {};
    var limit = parseInt(p.limit) || 25;
    if (limit < 1) limit = 1;
    if (limit > 100) limit = 100;
    var filterStatus = (p.status || '').toString();

    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (!sheet) {
      return _webAppRespond({ status: 'error', error: 'data_sheet_missing' });
    }
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return _webAppRespond({ status: 'ok', leads: [], message: 'Sheet2 is empty' });
    }
    var width = CONFIG.SHEET_COL_COUNT || 26;
    var startRow = Math.max(2, lastRow - (limit * 3));  // 3x buffer for filter
    var data = sheet.getRange(startRow, 1, lastRow - startRow + 1, width).getValues();
    var c = CONFIG.COLUMNS;
    var rows = data.map(function(r, i) {
      return {
        rowNum: startRow + i,
        linkedinUrl:     (r[c.LINKEDIN_URL - 1]   || '').toString().substring(0, 80),
        fullName:        (r[c.FULL_NAME - 1]      || '').toString(),
        organization:    (r[c.ORGANIZATION - 1]   || '').toString(),
        email:           (r[c.EMAIL - 1]          || '').toString(),
        status:          (r[c.STATUS - 1]         || '').toString(),
        enrichedEmail:   c.ENRICHED_EMAIL ? (r[c.ENRICHED_EMAIL - 1] || '').toString() : '',
        emailSource:     c.EMAIL_SOURCE   ? (r[c.EMAIL_SOURCE - 1]   || '').toString() : '',
        emailConfidence: c.EMAIL_CONFIDENCE ? (r[c.EMAIL_CONFIDENCE - 1] || '').toString() : '',
        draftId:         (r[c.DRAFT_ID - 1]       || '').toString().substring(0, 40),
        notes:           (r[c.NOTES - 1]          || '').toString().substring(0, 200),
        lastUpdated:     (r[c.LAST_UPDATED - 1]   || '').toString()
      };
    });
    if (filterStatus) {
      rows = rows.filter(function(r) { return r.status === filterStatus; });
    }
    rows = rows.reverse().slice(0, limit);

    // Summary counts
    var allStatuses = data.map(function(r) { return (r[c.STATUS - 1] || '').toString(); });
    var counts = {};
    allStatuses.forEach(function(s) { if (s) counts[s] = (counts[s] || 0) + 1; });

    return _webAppRespond({
      status: 'ok',
      totalLeadsInSheet: lastRow - 1,
      returnedCount: rows.length,
      statusCounts: counts,
      filterStatus: filterStatus || '(none)',
      leads: rows
    });
  } catch (err) {
    return _webAppRespond({ status: 'error', error: err.message, where: '_handleLeadsRequest' });
  }
}

// ─── INCOMING PAYLOAD SANITIZER ────────────────────────────────────
//
// Mirrors the Chrome extension's sanitizeExtractedProfile in content.js but
// runs server-side as a safety net. Catches the wrong-field-mapping patterns
// observed in production logs (e.g., fullName=URL, email='• 2nd').

function _sanitizeIncomingPayload(data) {
  if (!data || typeof data !== 'object') return data;
  var p = {};
  for (var k in data) p[k] = data[k];

  // Helpers
  var isUrl = function(s) { return s && /^https?:\/\//i.test(s.toString().trim()); };
  var isEmail = function(s) { return s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.toString().trim()); };
  var isConnDegree = function(s) {
    if (!s) return false;
    var t = s.toString().trim();
    return /^[•·\s]*\d(?:st|nd|rd|th)?(?:\s+degree)?(?:\s+connection)?$/i.test(t)
        || /^out\s+of\s+network$/i.test(t)
        || t === '•' || t === '2nd' || t === '3rd' || t === '1st';
  };
  var isLikelyName = function(s) {
    if (!s) return false;
    var t = s.toString().trim();
    if (t.length < 2 || t.length > 80) return false;
    if (isUrl(t) || t.indexOf('@') >= 0 || isConnDegree(t)) return false;
    try { return /^\p{L}[\p{L}\s'.\-]{1,}$/u.test(t); }
    catch (_) { return /^[A-Za-zÀ-ſ][A-Za-zÀ-ſ\s'.\-]{1,}$/.test(t); }
  };
  var stripDegree = function(s) {
    if (!s) return s;
    return s.toString()
      .replace(/[•·]\s*\d(?:st|nd|rd|th)?\s*(?:degree)?\s*(?:connection)?$/i, '')
      .replace(/\s+[•·]\s*\d(?:st|nd|rd|th)?\b.*$/i, '')
      .replace(/\s+(?:1st|2nd|3rd)\s+degree\s+connection.*$/i, '')
      .trim();
  };

  // 1. fullName cross-wiring repair
  if (p.fullName) {
    if (isUrl(p.fullName)) {
      p.linkedinUrl = p.linkedinUrl || p.fullName;
      p.fullName = '';
      Logger.log('[WebApp] _sanitize: fullName was URL — moved to linkedinUrl');
    } else if (isConnDegree(p.fullName)) {
      p.fullName = '';
      Logger.log('[WebApp] _sanitize: fullName was connection-degree text — blanked');
    }
  }

  // 2-3. If headline / currentDesignation looks like a name AND fullName empty, promote
  if (!p.fullName && p.headline && isLikelyName(p.headline)) {
    p.fullName = stripDegree(p.headline);
    p.headline = '';
    Logger.log('[WebApp] _sanitize: headline was actually the name — promoted to fullName');
  }
  if (!p.fullName && (p.currentDesignation || p.designation) && isLikelyName(p.currentDesignation || p.designation)) {
    p.fullName = stripDegree(p.currentDesignation || p.designation);
    p.currentDesignation = '';
    p.designation = '';
    Logger.log('[WebApp] _sanitize: designation was actually the name — promoted to fullName');
  }

  // 4. Email must have @
  if (p.email && !isEmail(p.email)) {
    Logger.log('[WebApp] _sanitize: email "' + p.email + '" not valid — blanked');
    p.email = '';
  }

  // 5. Organization junk — basic check (connection-degree text, URLs)
  if (p.currentOrganization && (isConnDegree(p.currentOrganization) || isUrl(p.currentOrganization))) {
    Logger.log('[WebApp] _sanitize: organization junk ("' + p.currentOrganization + '") — blanked');
    p.currentOrganization = '';
  }
  if (p.organization && (isConnDegree(p.organization) || isUrl(p.organization))) {
    p.organization = '';
  }

  // 5a. PATCH 2026-05-13 — HEADLINE-AS-ORG junk detection.
  //
  // The APK's Gemini Vision call occasionally dumps the headline string into
  // the currentOrganization slot when no Experience section is visible. The
  // Arjun Juneja / Nothing failure had org = "GTM & Strategy; ex Google,
  // BharatPe" — pure headline content. The downstream enricher then guessed
  // emails at a fake domain (gtmstrategy.com) and the lead landed at
  // NEEDS_EMAIL_REVIEW with wrong-domain candidates.
  //
  // Detection: blank the org when ANY of these headline-junk signatures hit:
  //   (a) Equals the headline string (case-insensitive)
  //   (b) Contains "ex " or "ex-" former-employer marker
  //   (c) Contains a semicolon (rare in brand names, common in headlines)
  //   (d) Longer than 50 chars (real brand names are short)
  //
  // After blanking, section 5b (server headline parse) runs and substitutes
  // a clean org name via _extractOrgFromHeadlineServer.
  function _looksLikeHeadlineJunkOrg(orgStr, headlineStr) {
    if (!orgStr) return false;
    var o = orgStr.toString().trim();
    if (!o) return false;
    var oLower = o.toLowerCase();
    var hLower = (headlineStr || '').toString().trim().toLowerCase();
    if (hLower && oLower === hLower) return true;
    if (/\bex[\s\-:]+[a-z]/i.test(o)) return true;
    if (o.indexOf(';') >= 0) return true;
    if (o.length > 50) return true;
    return false;
  }
  if (_looksLikeHeadlineJunkOrg(p.currentOrganization, p.headline)) {
    Logger.log('[WebApp] _sanitize: headline-junk org detected ("' + p.currentOrganization + '") — blanked');
    p.currentOrganization = '';
  }
  if (_looksLikeHeadlineJunkOrg(p.organization, p.headline)) {
    Logger.log('[WebApp] _sanitize: headline-junk org detected ("' + p.organization + '") — blanked');
    p.organization = '';
  }

  // 5a-2. 2026-06-22 — blank a NON-COMPANY org (tagline / program / education) that
  // the old-APK headline fallback emits NON-empty (so 5a above misses it). The email
  // engine would derive a junk domain from it; blanking parks the lead at NEEDS_EMAIL
  // instead of emailing a wrong recipient. App-side v1.0.15 fixes the capture; this is
  // the server safety net for pre-v1.0.15 captures.
  if (_looksLikeNonCompanyOrg(p.currentOrganization)) {
    Logger.log('[WebApp] _sanitize: non-company org detected ("' + p.currentOrganization + '") — blanked');
    p.currentOrganization = '';
  }
  if (_looksLikeNonCompanyOrg(p.organization)) {
    Logger.log('[WebApp] _sanitize: non-company org detected ("' + p.organization + '") — blanked');
    p.organization = '';
  }

  // 5b. REMOVED 2026-06-24 — server-side headline→organization derivation deleted.
  //
  // RCA (S. Roy "STAN" / Nikhil alma-mater / "ex-<Company>" class): the headline is
  // marketing copy, and deriving a current employer from it is a recurring WRONG-ORG
  // source. The current employer now comes ONLY from the APK's Experience-section
  // "Present" read (org-from-headline was removed app-side in the same 2026-06-24
  // patch). When organization is blank we now LEAVE it blank, so the lead PARKS at a
  // review status (NEEDS_EMAIL / VERIFY) rather than being drafted to a guessed
  // recipient — empty-the-server-can-flag beats a confidently-wrong tuple.
  // _extractOrgFromHeadlineServer is hard-retired below in the same patch.
  // (The _looksLikeNonCompanyOrg blank-guard above is RETAINED — it still strips a
  // non-company org the APK might emit, e.g. an alma mater read in error.)

  // 6. Strip trailing connection-degree noise from text fields
  ['fullName','headline','currentDesignation','currentOrganization','designation','organization','location']
    .forEach(function(k) { if (p[k]) p[k] = stripDegree(p[k]); });

  return p;
}

/**
 * PATCH 2026-05-13: server-side headline → organization extractor.
 *
 * Mirrors the Android APK's `extractOrgFromHeadline` but lives on the server
 * so the pipeline is resilient to APK extraction bugs (e.g., the Gemini Vision
 * JSON parse failure we hit on Arjun Juneja / Nothing).
 *
 * Patterns (ordered by precedence):
 *   1. " at <Org>"     — e.g. "Senior PM at Nothing"
 *   2. " @ <Org>"      — e.g. "PM @ Linear"
 *   3. Single separator (comma, pipe, en-dash, bullet) — take the segment
 *      that looks most like an org (capitalized, not a known job title).
 *
 * Returns '' when no plausible org can be extracted.
 *
 * @param {string} headline
 * @returns {string} extracted org name or ''
 */
// 2026-06-22 (server intake guard, RCA wrong-org/headline-derived): blank a
// currentOrganization that is NOT a real company — a motivational headline
// tagline, a program/event, or an education institution (alma mater). The
// pre-v1.0.15 APK headline-fallback emits these NON-EMPTY, so the legacy
// _looksLikeHeadlineJunkOrg / OrgRepair guards pass them through; the email
// engine then derives a junk domain (buildingteamsthatwin.com, jaipuria.ac.in,
// girlscript.tech) and drafts a wrong recipient. Blanking parks the lead at
// NEEDS_EMAIL instead. Conservative: a genuine corporate-form marker
// (Ltd/Inc/Technologies/Enterprises/…) is a HARD negative override, and short
// (<4-word) brand names with no education token are never touched.
function _looksLikeNonCompanyOrg(orgStr) {
  var s = ((orgStr || '') + '').trim();
  if (!s) return false;
  var lower = s.toLowerCase();
  var words = s.split(/\s+/).filter(function (w) { return w.length > 0; });
  // Negative override: a genuine corporate-form suffix means it IS a real company.
  // (Deliberately excludes ambiguous tokens like 'institute'/'consulting'/'research'
  // — those are exactly why the legacy guards let education/advisory orgs through.)
  var corpMarker = /\b(inc|llc|ltd|limited|pvt|private|corp|corporation|gmbh|plc|company|technologies|labs|systems|solutions|industries|enterprises?|ventures|holdings|networks|software|motors|pharma|retail|digital|studios?|bank|media|airlines|telecom|infotech|consultancy)\b/i;
  if (corpMarker.test(lower)) return false;
  // (a) education / program tokens — an alma mater or program is NOT current employment.
  var eduProgram = /(\bsummer of code\b|\binstitute of (management|technology|science|engineering)\b|\bschool of (management|business|law|engineering|design)\b|\bcollege\b|\buniversity\b|\bvishwavidyalaya\b|\bvidyalaya\b|\bmahavidyalaya\b|\bgurukul\b|\bpolytechnic\b|\bacademy\b)/i;
  if (eduProgram.test(lower)) return true;
  // (b) motivational-tagline shape: >=4 words with a tagline verb/pronoun, no corp marker.
  var taglineVerb = /\b(building|helping|inspiring|hir(e|ing)|grow(ing)?|transform(ing)?|empower(ing)?|enabl(e|ing)|driv(e|ing)|creat(e|ing)|deliver(ing)?|making|we|your)\b/i;
  if (words.length >= 4 && taglineVerb.test(lower)) return true;
  return false;
}

function _extractOrgFromHeadlineServer(headline) {
  // RETIRED 2026-06-24 — server-side headline→org derivation was a recurring wrong-org
  // source (S. Roy "STAN" / alma-mater / "ex-<Company>" class). Hard-stubbed to ALWAYS
  // return '' so it can never resurrect the behavior even if a stale caller reappears.
  // The original parser body below is intentionally unreachable; pinned by a test.
  return '';
  /* eslint-disable no-unreachable */
  if (!headline) return '';
  var h = headline.toString().trim();
  if (h.length < 3) return '';

  // Words that look like job titles, not orgs — reject these as org candidates
  var titleStopWords = [
    'engineer','manager','director','lead','founder','co-founder','cofounder',
    'ceo','cto','cfo','coo','cmo','vp','svp','evp','president','head','chief',
    'principal','staff','senior','junior','intern','consultant','analyst',
    'designer','developer','architect','specialist','strategist','associate',
    'product','growth','marketing','sales','operations','ops','finance','hr',
    'people','talent','recruiter','recruiting','technical','program','project',
    'opportunities','seeking','open','available','helping','building'
  ];
  function isJobTitleSegment(seg) {
    if (!seg) return true;
    var t = seg.toLowerCase().replace(/[^a-z\s]/g, '').trim();
    if (!t) return true;
    var firstWord = t.split(/\s+/)[0];
    return titleStopWords.indexOf(firstWord) >= 0;
  }
  function looksLikeOrg(seg) {
    if (!seg) return false;
    var t = seg.trim();
    if (t.length < 2 || t.length > 50) return false;
    // Reject if starts lowercase (orgs are usually capitalized; exception: lowercase brands like "upGrad" still start with letter)
    if (!/^[A-Za-z0-9]/.test(t)) return false;
    // Reject pure-digit segments
    if (/^\d+$/.test(t)) return false;
    // Reject URLs, emails, phone-like
    if (/^https?:/i.test(t) || /@/.test(t) || /^\+?\d{6,}/.test(t)) return false;
    // Reject if looks like a job title
    if (isJobTitleSegment(t)) return false;
    return true;
  }

  // Pattern 1: " at <Org>" — most common LinkedIn headline shape
  var atMatch = h.match(/\s(?:at|@)\s+([A-Z0-9][\w\s&\.\-]{1,49})(?:\s*[,|·•\-—]|$)/);
  if (atMatch && atMatch[1]) {
    var cand = atMatch[1].trim().replace(/[,|·•\-—].*$/, '').trim();
    if (looksLikeOrg(cand)) return cand;
  }

  // Pattern 2: " @ <Org>" — duplicate of pattern 1 with stricter @ usage
  // (already covered above)

  // Pattern 3: split on separators, find the segment most likely to be the org.
  //
  // Heuristic rules:
  //   - If 2 segments: "<JobTitle>, <Org>" → take segment 2 (the last).
  //   - If 3+ segments: "<JobTitle> | <Org> | <Location>" → take middle
  //     segments first (positions 1..N-2), since position 0 is usually a
  //     job title and the last position is usually a location.
  //   - Reject segments that look like locations (city/state/country tokens).
  var commonLocationTokens = [
    'india','bengaluru','bangalore','mumbai','delhi','gurgaon','gurugram',
    'noida','hyderabad','chennai','pune','kolkata','goa',
    'san francisco','sf','sfo','new york','nyc','ny','los angeles','la',
    'seattle','austin','boston','chicago','london','dublin','berlin',
    'paris','singapore','sg','tokyo','dubai','toronto','remote',
    'united states','usa','us','uk','europe','asia','apac','emea',
    'silicon valley','bay area'
  ];
  function looksLikeLocation(seg) {
    if (!seg) return false;
    var t = seg.toLowerCase().trim();
    for (var i = 0; i < commonLocationTokens.length; i++) {
      if (t === commonLocationTokens[i]) return true;
    }
    return false;
  }

  var separators = /[,|·•]|(?:\s[-—]\s)/g;
  var segments = h.split(separators).map(function(s) { return (s || '').trim(); }).filter(Boolean);

  if (segments.length === 2) {
    // 2-segment shape: "<JobTitle><sep><Org>" — take segment 2 if it looks like org
    var s2 = segments[1];
    if (looksLikeOrg(s2) && !looksLikeLocation(s2)) return s2;
    // Fallback: maybe inverted "<Org><sep><JobTitle>"
    var s1 = segments[0];
    if (looksLikeOrg(s1) && !looksLikeLocation(s1)) return s1;
  } else if (segments.length >= 3) {
    // 3+ segment shape: middle segments most likely contain org.
    // Try positions [1 .. N-2] first, then fall back to position [0] and [N-1].
    for (var mid = 1; mid <= segments.length - 2; mid++) {
      var sm = segments[mid];
      if (looksLikeOrg(sm) && !looksLikeLocation(sm)) return sm;
    }
    // Fallback: walk from last to first, skipping locations
    for (var iLast = segments.length - 1; iLast >= 0; iLast--) {
      var sl = segments[iLast];
      if (looksLikeOrg(sl) && !looksLikeLocation(sl)) return sl;
    }
  }

  return '';
}

// ─── Per-row enrichment status endpoint — for client polling ──────────────
//
// Used by the Chrome extension popup (and optionally the APK) to poll the
// enrichment outcome after a successful POST. Returns the lead row's email,
// confidence, status, source, and any candidate alternates so the client can
// display "we found `abhay@pronto.io` (87% confident, Snov.io verified)" or
// "no email yet — pipeline finding…".
//
// Usage:
//   GET /exec?action=leadstatus&rowNum=151
//   GET /exec?action=leadstatus&url=https%3A%2F%2Flinkedin.com%2Fin%2Fabhay

function _handleLeadStatusRequest(e) {
  try {
    var p = (e && e.parameter) || {};
    var rowNum = parseInt(p.rowNum) || 0;
    var url = (p.url || '').toString().trim().toLowerCase().replace(/\/$/, '');

    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (!sheet) return _webAppRespond({ status: 'error', error: 'data_sheet_missing' });

    var c = CONFIG.COLUMNS;
    var width = CONFIG.SHEET_COL_COUNT || 26;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return _webAppRespond({ status: 'ok', found: false });

    var values, foundRow;
    if (rowNum && rowNum >= 2 && rowNum <= lastRow) {
      values = sheet.getRange(rowNum, 1, 1, width).getValues()[0];
      foundRow = rowNum;
    } else if (url) {
      var allUrls = sheet.getRange(2, c.LINKEDIN_URL, lastRow - 1, 1).getValues();
      for (var i = 0; i < allUrls.length; i++) {
        var v = (allUrls[i][0] || '').toString().toLowerCase().replace(/\/$/, '');
        if (v === url) { foundRow = i + 2; break; }
      }
      if (!foundRow) return _webAppRespond({ status: 'ok', found: false, queried: url });
      values = sheet.getRange(foundRow, 1, 1, width).getValues()[0];
    } else {
      return _webAppRespond({ status: 'error', error: 'must_provide_rowNum_or_url' });
    }

    var pipelineStatus = (values[c.STATUS - 1] || '').toString();
    var draftId = (values[c.DRAFT_ID - 1] || '').toString();
    var enrichedEmail = c.ENRICHED_EMAIL ? (values[c.ENRICHED_EMAIL - 1] || '').toString() : '';
    var emailConf = c.EMAIL_CONFIDENCE ? (values[c.EMAIL_CONFIDENCE - 1] || '').toString() : '';
    var emailSource = c.EMAIL_SOURCE ? (values[c.EMAIL_SOURCE - 1] || '').toString() : '';
    var notes = (values[c.NOTES - 1] || '').toString();
    var sheetEmail = (values[c.EMAIL - 1] || '').toString();

    // Decide a "pipeline phase" the client can show to the user
    var phase = 'unknown';
    if (pipelineStatus === 'NEW') phase = 'queued';
    else if (pipelineStatus === 'NEEDS_EMAIL') phase = 'no_email_found';
    else if (pipelineStatus === 'NEEDS_EMAIL_REVIEW') phase = 'needs_review';
    else if (pipelineStatus === 'RESEARCH_DONE') phase = 'researched';
    else if (pipelineStatus === 'DRAFT_CREATED' || draftId) phase = 'draft_ready';
    else if (pipelineStatus === 'ERROR') phase = 'error';

    return _webAppRespond({
      status: 'ok',
      found: true,
      rowNum: foundRow,
      pipelineStatus: pipelineStatus,
      phase: phase,
      email: enrichedEmail || sheetEmail || '',
      emailConfidence: parseFloat(emailConf) || 0,
      emailSource: emailSource,
      draftId: draftId,
      // Help client display candidate alternates when status is NEEDS_EMAIL_REVIEW.
      // Notes encode them as "Pattern-guessed candidates ... | Alternate domains found: …".
      notes: notes.substring(0, 600),
      candidates: _extractCandidatesFromNotes(notes),
      alternateDomains: _extractAlternateDomainsFromNotes(notes)
    });
  } catch (err) {
    return _webAppRespond({ status: 'error', error: err.message, where: '_handleLeadStatusRequest' });
  }
}

function _extractCandidatesFromNotes(notes) {
  if (!notes) return [];
  var m = notes.match(/candidates[^:]*:\s*([^|]+(?:\|[^|]+)*?)(?:\s*\|\s*Alternate|$)/i);
  if (!m) return [];
  return m[1].split('|').map(function(s) { return s.trim(); }).filter(function(s) { return s && s.indexOf('@') > 0; });
}

function _extractAlternateDomainsFromNotes(notes) {
  if (!notes) return [];
  var m = notes.match(/Alternate domains found:\s*(.+)$/i);
  if (!m) return [];
  return m[1].split('/').map(function(s) { return s.trim(); }).filter(Boolean);
}

// ─── Sheet1 raw audit log endpoint — what APK / extension actually sent ────
//
// Sheet2 is the canonical pipeline subset. Sheet1 is the FULL audit log of
// every POST from the APK / extension regardless of whether it had enough
// signal to enter the pipeline. Useful for diagnosing "did the APK reach the
// Web App at all" — empty/zero rows = network/URL issue, populated rows with
// blank fields = APK reached us but couldn't scrape the LinkedIn UI.
//
// Usage:
//   /exec?action=raw           — last 25 Sheet1 rows
//   /exec?action=raw&limit=10
//   /exec?action=raw&since=2026-05-07T00:00:00Z

function _handleRawRequest(e) {
  if (!_checkAuthToken_(e)) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error', error: 'authentication_required',
      message: 'Pass &token=<ADMIN_TOKEN> in the query string'
    })).setMimeType(ContentService.MimeType.JSON);
  }
  try {
    var p = (e && e.parameter) || {};
    var limit = parseInt(p.limit) || 25;
    if (limit < 1) limit = 1;
    if (limit > 200) limit = 200;
    var since = p.since ? new Date(p.since) : null;

    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName('Sheet1');
    if (!sheet) {
      return _webAppRespond({ status: 'ok', rows: [], message: 'Sheet1 does not exist yet' });
    }
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return _webAppRespond({ status: 'ok', rows: [], message: 'Sheet1 is empty (no APK/extension captures yet)' });
    }
    var startRow = Math.max(2, lastRow - (limit * 3));
    var data = sheet.getRange(startRow, 1, lastRow - startRow + 1, 12).getValues();
    // Columns: Timestamp, LinkedIn_URL, Full_Name, Headline, Designation,
    //          Organization, Email, Phone, Website, Location, Connection, Confidence
    var rows = data.map(function(r, i) {
      return {
        rowNum:       startRow + i,
        timestamp:    r[0] ? r[0].toString() : '',
        linkedinUrl:  (r[1] || '').toString().substring(0, 100),
        fullName:     (r[2] || '').toString(),
        headline:     (r[3] || '').toString().substring(0, 100),
        designation:  (r[4] || '').toString(),
        organization: (r[5] || '').toString(),
        email:        (r[6] || '').toString(),
        phone:        (r[7] || '').toString(),
        website:      (r[8] || '').toString(),
        location:     (r[9] || '').toString(),
        connection:   (r[10] || '').toString(),
        confidence:   (r[11] || '').toString()
      };
    });
    if (since) {
      rows = rows.filter(function(r) {
        if (!r.timestamp) return false;
        try { return new Date(r.timestamp) >= since; } catch (_) { return false; }
      });
    }
    rows = rows.reverse().slice(0, limit);

    // Field-fill stats — how many of the returned rows have each field populated
    var stats = { rowsConsidered: rows.length, hasName: 0, hasEmail: 0, hasPhone: 0, hasOrg: 0, hasUrl: 0 };
    rows.forEach(function(r) {
      if (r.fullName)     stats.hasName++;
      if (r.email)        stats.hasEmail++;
      if (r.phone)        stats.hasPhone++;
      if (r.organization) stats.hasOrg++;
      if (r.linkedinUrl)  stats.hasUrl++;
    });

    return _webAppRespond({
      status: 'ok',
      sheet: 'Sheet1',
      totalRowsInSheet: lastRow - 1,
      returnedCount: rows.length,
      since: since ? since.toISOString() : '(none)',
      fieldFillStats: stats,
      rows: rows
    });
  } catch (err) {
    return _webAppRespond({ status: 'error', error: err.message, where: '_handleRawRequest' });
  }
}

// ─── Script Properties inventory — confirm keys/IDs are set ──────────
// Read-only listing of WHICH script properties are configured. Returns only
// presence + length, never the raw value (so the /exec URL log doesn't leak
// secrets).

function _handlePropsRequest(e) {
  if (!_checkAuthToken_(e)) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error', error: 'authentication_required',
      message: 'Pass &token=<ADMIN_TOKEN> in the query string'
    })).setMimeType(ContentService.MimeType.JSON);
  }
  try {
    var props = PropertiesService.getScriptProperties().getProperties();
    var inventory = {};
    Object.keys(props).sort().forEach(function(k) {
      var v = props[k];
      inventory[k] = {
        set: !!v,
        length: v ? v.length : 0,
        preview: v ? (v.substring(0, 4) + '…' + v.substring(Math.max(4, v.length - 2))) : ''
      };
    });
    return _webAppRespond({
      status: 'ok',
      count: Object.keys(inventory).length,
      properties: inventory
    });
  } catch (err) {
    return _webAppRespond({ status: 'error', error: err.message, where: '_handlePropsRequest' });
  }
}

function _verifySharedSecret(body, e) {
  var keyName = (CONFIG && CONFIG.PROPERTY_KEYS && CONFIG.PROPERTY_KEYS.AUTOMAIL_WEBAPP_SECRET) || 'AUTOMAIL_WEBAPP_SECRET';
  var expected = PropertiesService.getScriptProperties().getProperty(keyName);
  if (!expected) return { rejected: false }; // dev mode — no secret enforced

  var provided = body.secret || (e && e.parameter && e.parameter.secret) || '';
  if (provided === expected) return { rejected: false };

  // ─── Exemptions for legitimate sources that don't send the secret ──────
  //
  // PATCH 2026-05-13 (AUDIT F11 / R5): tightened from 3 exemptions to 1.
  //
  // The previous 3-exemption design effectively voided the shared-secret
  // gate: any payload claiming `source:"chrome-extension"` or `test:true`
  // was accepted, both of which are caller-controlled fields with no HMAC
  // or signature. An attacker reading the public Web App URL could inject
  // arbitrary leads into Sheet1 by setting those fields, then ride the
  // pipeline for free Apollo/Hunter/Snov/Gemini/Claude credits.
  //
  // KEPT: the APK rich-payload exemption. The APK ships baked-in and can't
  // easily ship a secret across users; its payload shape (fullName + LinkedIn
  // URL + confidence as a number) is structural and cannot be forged
  // accidentally. This exemption is also logged for audit visibility.
  //
  // REMOVED: chrome-extension/source-string exemption — the extension can
  // be updated to send the secret; we'll roll out via extension v2.3.
  // REMOVED: test:true bypass — test connection should use ?secret= in the
  // query string instead.

  // APK rich payload: fullName + LinkedIn URL + numeric confidence — kept
  var looksLikeApk = !!(
    body.fullName &&
    body.linkedinUrl &&
    typeof body.confidence === 'number' &&
    body.confidence >= 0 &&
    body.confidence <= 100
  );
  if (looksLikeApk) {
    Logger.log('[WebApp] No-secret exemption: APK payload shape (' + (body.source || 'apk') + ')');
    return { rejected: false };
  }

  Logger.log('[WebApp] Rejected POST — secret mismatch (source=' + (body.source || 'unknown') +
    ', url=' + (body.linkedinUrl || 'none') + ', testFlag=' + !!body.test + ')');
  return { rejected: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── CAPTURE AUDIT (PATCH 2026-06-17-capture-audit) ──────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
//
// Records EVERY incoming doPost — accepted AND rejected — to a 'CaptureAudit'
// tab. Root cause addressed (2026-06-17 live incident, lead "Debleena Das"):
// when the shared-secret gate (_verifySharedSecret) rejects a DEGRADED APK
// capture (the looksLikeApk exemption needs fullName + linkedinUrl + numeric
// confidence; a bad scan that drops the URL or confidence fails it), the lead
// vanished with only a Logger.log — invisible to the user and unrecoverable.
// This makes every rejection VISIBLE, the payload RECOVERABLE (promote via
// menuInjectLeadFromUrl), and reveals exactly which auth field (if any) the APK
// sends so AUTOMAIL_WEBAPP_SECRET can be aligned. Fail-safe: never throws into
// doPost (a logging failure must not break capture). The auth value is MASKED
// (first 3 + last 2 + length) — never stored in clear. Tab ring-trimmed to ~800.
function _maskSecret_(v) {
  v = (v === undefined || v === null) ? '' : String(v);
  if (!v) return '';
  if (v.length <= 5) return '*****(len' + v.length + ')';
  return v.substring(0, 3) + '…' + v.substring(v.length - 2) + '(len' + v.length + ')';
}

function _auditCapture_(payload, e, outcome) {
  try {
    var p = payload || {};
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var tab = ss.getSheetByName('CaptureAudit');
    if (!tab) {
      tab = ss.insertSheet('CaptureAudit');
      tab.appendRow(['Timestamp', 'Outcome', 'Source', 'FullName', 'LinkedInURL',
                     'Organization', 'Email', 'Confidence', 'ConfidenceType',
                     'AuthFieldsSeen', 'AuthPreview', 'PayloadKeys']);
      tab.getRange(1, 1, 1, 12).setFontWeight('bold');
    }
    var authSeen = [];
    var authVal = '';
    if (p.secret !== undefined && p.secret !== '') { authSeen.push('body.secret'); authVal = authVal || p.secret; }
    if (p.token  !== undefined && p.token  !== '') { authSeen.push('body.token');  authVal = authVal || p.token; }
    if (e && e.parameter && e.parameter.secret)    { authSeen.push('query.secret'); authVal = authVal || e.parameter.secret; }
    if (e && e.parameter && e.parameter.token)     { authSeen.push('query.token');  authVal = authVal || e.parameter.token; }
    var conf = (p.confidence !== undefined) ? p.confidence
             : (p.confidenceScore !== undefined) ? p.confidenceScore
             : (p.extractionConfidence !== undefined) ? p.extractionConfidence : '';
    var keys = '';
    try { keys = Object.keys(p).slice(0, 30).join(','); } catch (_) {}
    tab.appendRow([
      new Date().toISOString(),
      String(outcome || ''),
      String(p.source || '').substring(0, 40),
      String(p.fullName || '').substring(0, 80),
      String(p.linkedinUrl || '').substring(0, 200),
      String(p.currentOrganization || p.organization || '').substring(0, 80),
      String(p.email || '').substring(0, 120),
      conf,
      typeof p.confidence,
      authSeen.join('|') || 'NONE',
      _maskSecret_(authVal),
      keys
    ]);
    var lr = tab.getLastRow();
    if (lr > 900) { tab.deleteRows(2, lr - 800); }
  } catch (auditErr) {
    try { Logger.log('[WebApp] _auditCapture_ non-fatal: ' + auditErr.message); } catch (_) {}
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── APK Tracking screen endpoints (Patch 2026-05-12) ─────────────────────
// ═══════════════════════════════════════════════════════════════════════════
//
// The Android app's Tracking screen polls these to render a unified list of
// every lead with its: pipeline status, draft state, email tracking (opens +
// clicks), follow-up schedule, and a Gmail-deep-link to the thread. One
// endpoint per use case so the client can paginate cheaply.

// Build the best-available Gmail web deep link for a draft/thread.
// ★RESEARCH 2026-06-24 (deep-research, 100 agents): the Gmail Android app has NO public
// deep-link to a specific thread/message, and Android App Links STRIP the URL #fragment —
// so the legacy "#inbox/<threadId>" URL lands on the Gmail INBOX HOME instead of the
// conversation (the user's recurring complaint). The ONLY URL that reliably resolves to the
// conversation is the rfc822msgid SEARCH URL, keyed by the true RFC-2822 Message-ID header
// (NOT Gmail's internal hex thread-id); web Gmail renders the single matching result as the
// conversation. We prefer it whenever the Message-ID is known (captured at draft time in
// GmailDrafter, col W RFC822_MESSAGE_ID). The #inbox/<threadId> form is a last-resort fallback
// for legacy rows that predate Message-ID capture. Angle brackets are stripped; the id is
// URL-encoded (defensive, per a working community implementation).
function _gmailThreadDeepLink_(rfc822MessageId, threadId) {
  var msgid = (rfc822MessageId || '').toString().trim().replace(/^<|>$/g, '');
  if (msgid) {
    return 'https://mail.google.com/mail/u/0/#search/rfc822msgid:' + encodeURIComponent(msgid);
  }
  if (threadId) {
    return 'https://mail.google.com/mail/u/0/#inbox/' + threadId;
  }
  return null;
}

function _handleLeadDashboardRequest(e) {
  if (!_checkAuthToken_(e)) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error', error: 'authentication_required',
      message: 'Pass &token=<ADMIN_TOKEN> in the query string'
    })).setMimeType(ContentService.MimeType.JSON);
  }
  try {
    var p = (e && e.parameter) || {};
    var limit = parseInt(p.limit) || 25;
    if (limit < 1) limit = 1;
    if (limit > 100) limit = 100;
    var statusFilter = (p.status || '').toString().trim();
    var query = (p.q || '').toString().trim().toLowerCase();

    // PATCH 2026-05-12: rolling-7d cutoff. Old DRAFT_CREATED leads from
    // before the tracking+thread-stamping patches (no threadId →
    // "Thread URL: null" UX) get filtered out. Default = now - 7 days,
    // overridable via Script Property DASHBOARD_MIN_DATE (absolute ISO)
    // or per-request &since=<iso>, or &days=<N> for rolling window override.
    // include_legacy=1 disables the filter entirely.
    var includeLegacy = (p.include_legacy === '1' || p.include_legacy === 'true');
    var sinceParam = (p.since || '').toString().trim();
    var daysParam = parseInt(p.days);
    var sinceMs;
    if (sinceParam) {
      try { sinceMs = new Date(sinceParam).getTime(); } catch (_) { sinceMs = 0; }
    } else if (daysParam > 0 && daysParam < 365) {
      sinceMs = Date.now() - daysParam * 86400 * 1000;
    } else {
      var configured = PropertiesService.getScriptProperties().getProperty('DASHBOARD_MIN_DATE');
      if (configured) {
        try { sinceMs = new Date(configured).getTime(); } catch (_) {}
      }
      // Default: rolling 7 days back from now
      if (!sinceMs || !isFinite(sinceMs)) sinceMs = Date.now() - 7 * 86400 * 1000;
    }

    // PATCH 2026-06-12-fast-ack (H2 fix): cache dashboard reads in CacheService
    // (TTL 60s) so APK poll calls are O(cache-read) and immune to document lock
    // contention from concurrent batch executions. Cache key includes all params
    // that affect the response shape. Admin diagnostics (admin_run, run_all_tests,
    // stamp_check) are NOT cached — only this app-facing read endpoint.
    var _cacheKey = 'lead_dashboard:' + limit + ':' + statusFilter + ':' + query + ':' +
                    Math.floor(sinceMs / 60000) + ':' + (includeLegacy ? '1' : '0');
    try {
      var _scriptCache = CacheService.getScriptCache();
      var _cached = _scriptCache.get(_cacheKey);
      if (_cached) {
        // Cache hit: return immediately, no sheet reads required.
        return ContentService.createTextOutput(_cached).setMimeType(ContentService.MimeType.JSON);
      }
    } catch (_cacheReadErr) {
      // Cache failure is non-fatal — fall through to compute path.
      Logger.log('[Dashboard/cache] read failed (non-fatal): ' + _cacheReadErr.message);
    }

    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet2 = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (!sheet2) return _webAppRespond({ status: 'error', error: 'data_sheet_missing' });
    var lastRow = sheet2.getLastRow();
    if (lastRow < 2) return _webAppRespond({ status: 'ok', leads: [], total: 0 });

    var c = CONFIG.COLUMNS;
    var width = CONFIG.SHEET_COL_COUNT || 26;
    // Load larger window because we now filter by date (most recent rows are at bottom).
    var startRow = Math.max(2, lastRow - Math.max(limit * 8, 80));
    var rows = sheet2.getRange(startRow, 1, lastRow - startRow + 1, width).getValues();
    // Walk newest→oldest so date-filter short-circuits early
    rows.reverse();
    var startRowReversed = lastRow;  // first row in `rows` after reverse is `lastRow`

    // Mutable cache used by _resolveThreadIdForLegacy (in-memory + sheet-back)
    var threadIdCache = _dashLoadThreadIdCache(ss);

    // Bulk-load all tracking events so we don't re-query per lead
    var trackingByUrl = _bulkLoadTrackingByUrl(ss);
    var followupsByEmail = _bulkLoadFollowupsByEmail(ss);

    var leads = [];
    var droppedLegacyCount = 0;
    var droppedDateFilteredCount = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var rowNum = startRowReversed - i;  // we reversed, so this is the actual sheet row
      var linkedinUrl = (r[c.LINKEDIN_URL - 1] || '').toString();
      var fullName = (r[c.FULL_NAME - 1] || '').toString();
      var org = (r[c.ORGANIZATION - 1] || '').toString();
      var status = (r[c.STATUS - 1] || '').toString();
      var draftId = (r[c.DRAFT_ID - 1] || '').toString();
      var lastUpdatedRaw = r[c.LAST_UPDATED - 1];
      var lastUpdatedMs = 0;
      try { lastUpdatedMs = lastUpdatedRaw ? new Date(lastUpdatedRaw).getTime() : 0; } catch (_) {}

      // PATCH 2026-05-12: date filter — skip leads updated before cutoff.
      // Override via include_legacy=1 if you ever need to see archived rows.
      if (!includeLegacy && lastUpdatedMs && lastUpdatedMs < sinceMs) {
        droppedDateFilteredCount++;
        continue;
      }

      // Apply filters
      if (statusFilter && status !== statusFilter) continue;
      if (query) {
        var hay = (fullName + ' ' + org + ' ' + linkedinUrl).toLowerCase();
        if (hay.indexOf(query) < 0) continue;
      }

      var leadEmail = (r[c.EMAIL - 1] || '').toString();
      var enrichedEmail = c.ENRICHED_EMAIL ? (r[c.ENRICHED_EMAIL - 1] || '').toString() : '';
      var effectiveEmail = enrichedEmail || leadEmail;

      var urlKey = linkedinUrl.toLowerCase().replace(/\/$/, '');
      var track = trackingByUrl[urlKey] || { opens: 0, clicks: 0, scanClicks: 0, threadId: '', trackingId: '' };

      // ── PATCH 2026-05-12: thread-id resolution for legacy drafts ──
      // TrackingLinks col H is empty for any draft created before the
      // _trackingStampThreadId hook. Resolve on-the-fly via GmailApp.getDraft
      // and cache the result. This makes the "Open in Gmail" button work for
      // every DRAFT_CREATED lead, not just post-patch ones.
      var threadId = track.threadId || '';
      if (!threadId && draftId) {
        threadId = _resolveThreadIdForLegacy(ss, draftId, threadIdCache);
      }

      var followups = followupsByEmail[effectiveEmail.toLowerCase()] || [];
      var nextFollowupAt = null;
      var followupSummary = followups.map(function(f) {
        if (f.status === 'PENDING' && (!nextFollowupAt || f.scheduledDate < nextFollowupAt)) {
          nextFollowupAt = f.scheduledDate;
        }
        return { stage: f.stage, scheduledDate: f.scheduledDate, status: f.status, sentAt: f.sentAt };
      });

      leads.push({
        rowNum: rowNum,
        fullName: fullName,
        organization: org,
        linkedinUrl: linkedinUrl,
        email: effectiveEmail,
        emailSource: c.EMAIL_SOURCE ? (r[c.EMAIL_SOURCE - 1] || '').toString() : '',
        emailConfidence: c.EMAIL_CONFIDENCE ? parseFloat(r[c.EMAIL_CONFIDENCE - 1] || 0) : 0,
        pipelineStatus: status,
        draftId: draftId,
        threadId: threadId,
        gmailThreadUrl: _gmailThreadDeepLink_(
          (c.RFC822_MESSAGE_ID ? (r[c.RFC822_MESSAGE_ID - 1] || '') : ''), threadId),
        tracking: {
          trackingId: track.trackingId || null,
          opens: track.opens,
          firstOpenAt: track.firstOpenAt || null,
          lastOpenAt: track.lastOpenAt || null,
          clicks: track.clicks,
          scanClicks: track.scanClicks,
          clicksPerLink: track.clicksPerLink || {}
        },
        followups: followupSummary,
        nextFollowupAt: nextFollowupAt,
        lastUpdated: lastUpdatedRaw ? lastUpdatedRaw.toString() : ''
      });
      if (leads.length >= limit) break;
    }

    // Persist any newly resolved thread IDs back so we don't re-call Gmail next time
    try { _dashSaveThreadIdCache(ss, threadIdCache); } catch (_) {}

    var _dashPayload = {
      status: 'ok',
      totalInSheet: lastRow - 1,
      returnedCount: leads.length,
      filter: {
        status: statusFilter || null,
        query: query || null,
        sinceMs: sinceMs,
        sinceIso: new Date(sinceMs).toISOString(),
        includeLegacy: includeLegacy,
        droppedDateFiltered: droppedDateFilteredCount
      },
      leads: leads
    };

    // PATCH 2026-06-12-fast-ack: store result in CacheService (TTL 60s).
    // Only cache if payload is under 100KB to stay within CacheService limits.
    try {
      var _payloadStr = JSON.stringify(_dashPayload);
      if (_payloadStr.length <= 100000) {
        CacheService.getScriptCache().put(_cacheKey, _payloadStr, 60);
      } else {
        // Truncate: drop oldest leads (already reversed newest-first) until under limit.
        var _truncated = JSON.parse(_payloadStr);
        while (JSON.stringify(_truncated).length > 100000 && _truncated.leads.length > 1) {
          _truncated.leads.pop();
          _truncated.truncated = true;
        }
        var _truncStr = JSON.stringify(_truncated);
        if (_truncStr.length <= 100000) {
          CacheService.getScriptCache().put(_cacheKey, _truncStr, 60);
        }
      }
    } catch (_cacheWriteErr) {
      // Cache write failure is non-fatal — response still returns correctly.
      Logger.log('[Dashboard/cache] write failed (non-fatal): ' + _cacheWriteErr.message);
    }

    return _webAppRespond(_dashPayload);
  } catch (err) {
    return _webAppRespond({ status: 'error', error: err.message, where: 'lead_dashboard', stack: (err.stack || '').substring(0, 400) });
  }
}

// ─── Thread-id resolution cache for legacy DRAFT_CREATED leads ─────────────
// Pre-tracking-patch drafts had no TrackingLinks row → null threadId in the
// dashboard. We look it up via GmailApp.getDraft once and cache in a sheet
// `ThreadIdCache` so subsequent dashboard calls don't pay the Gmail API cost.

function _dashLoadThreadIdCache(ss) {
  var sheet = ss.getSheetByName('ThreadIdCache');
  var map = { dirty: false };
  if (!sheet || sheet.getLastRow() < 2) return map;
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  for (var i = 0; i < data.length; i++) {
    var draftId = (data[i][0] || '').toString().trim();
    var threadId = (data[i][1] || '').toString().trim();
    if (draftId) map[draftId] = threadId;
  }
  return map;
}

function _dashSaveThreadIdCache(ss, cache) {
  if (!cache || !cache.dirty) return;
  var sheet = ss.getSheetByName('ThreadIdCache');
  if (!sheet) {
    sheet = ss.insertSheet('ThreadIdCache');
    sheet.appendRow(['Draft_ID', 'Thread_ID', 'Resolved_At']);
    sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
  }
  var rows = Object.keys(cache).filter(function(k) { return k !== 'dirty'; }).map(function(k) {
    return [k, cache[k] || '', new Date().toISOString()];
  });
  if (rows.length === 0) return;
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.deleteRows(2, lastRow - 1);
  sheet.getRange(2, 1, rows.length, 3).setValues(rows);
}

function _resolveThreadIdForLegacy(ss, draftId, cache) {
  if (!draftId) return '';
  if (cache.hasOwnProperty(draftId)) return cache[draftId];  // cached negative or positive
  var resolved = '';
  try {
    var draft = GmailApp.getDraft(draftId);
    if (draft) {
      try { resolved = draft.getMessage().getThread().getId() || ''; }
      catch (e2) { Logger.log('[Dashboard] threadId resolve inner failed for ' + draftId + ': ' + e2.message); }
    }
  } catch (e) {
    // Draft no longer exists (sent + thread closed, or manually deleted).
    // Cache the negative so we don't keep paying the Gmail API cost.
    Logger.log('[Dashboard] threadId resolve failed for ' + draftId + ': ' + e.message);
  }
  cache[draftId] = resolved;
  cache.dirty = true;
  return resolved;
}

function _handleFollowupsDueRequest(e) {
  try {
    var p = (e && e.parameter) || {};
    var withinHours = parseInt(p.within_hours) || 24;
    if (withinHours < 1) withinHours = 1;
    if (withinHours > 168) withinHours = 168;  // 7-day cap

    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName('FollowUps');
    if (!sheet) return _webAppRespond({ status: 'ok', due: [], count: 0, message: 'FollowUps sheet not initialized' });
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return _webAppRespond({ status: 'ok', due: [], count: 0 });

    var data = sheet.getDataRange().getValues();
    var headers = data[0].map(function(h) { return (h || '').toString().trim(); });
    var idx = {
      email: headers.indexOf('Email'),
      scheduledDate: headers.indexOf('ScheduledDate'),
      subject: headers.indexOf('Subject'),
      body: headers.indexOf('Body'),
      status: headers.indexOf('Status'),
      leadName: headers.indexOf('LeadName'),
      stage: headers.indexOf('Stage'),
      parentRow: headers.indexOf('ParentRow')
    };

    var now = Date.now();
    var deadline = now + withinHours * 3600 * 1000;
    var due = [];
    var nowPending = [];
    var sentRecent = [];

    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var status = ((row[idx.status] || '') + '').trim();
      var scheduledRaw = row[idx.scheduledDate];
      var scheduledTs = null;
      try { scheduledTs = new Date(scheduledRaw).getTime(); } catch (_) {}

      if (!scheduledTs) continue;

      var entry = {
        rowNum: i + 1,
        leadName: (row[idx.leadName] || '').toString(),
        email: (row[idx.email] || '').toString(),
        stage: parseInt(row[idx.stage]) || 1,
        scheduledDate: scheduledRaw ? new Date(scheduledRaw).toISOString() : null,
        status: status,
        parentRow: idx.parentRow >= 0 ? (row[idx.parentRow] || null) : null
      };

      if (status === 'SENT') {
        if (scheduledTs > now - 24 * 3600 * 1000) sentRecent.push(entry);
        continue;
      }
      if (status === 'CANCELLED') continue;

      if (scheduledTs <= deadline && scheduledTs >= now - 7 * 24 * 3600 * 1000) {
        if (scheduledTs <= now) nowPending.push(entry);
        else due.push(entry);
      }
    }

    return _webAppRespond({
      status: 'ok',
      withinHours: withinHours,
      pendingNowCount: nowPending.length,
      dueWithinWindowCount: due.length,
      recentSentCount: sentRecent.length,
      pendingNow: nowPending,
      dueWithinWindow: due,
      recentSent: sentRecent
    });
  } catch (err) {
    return _webAppRespond({ status: 'error', error: err.message, where: 'followups_due' });
  }
}

function _handleLeadSearchRequest(e) {
  if (!_checkAuthToken_(e)) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error', error: 'authentication_required',
      message: 'Pass &token=<ADMIN_TOKEN> in the query string'
    })).setMimeType(ContentService.MimeType.JSON);
  }
  // Lightweight name/org search — returns just rowNum + name + org + linkedinUrl
  // so the APK search dropdown is fast even on large sheets.
  try {
    var p = (e && e.parameter) || {};
    var q = (p.q || '').toString().trim().toLowerCase();
    if (!q || q.length < 2) return _webAppRespond({ status: 'error', error: 'q_required_min_2_chars' });
    var limit = parseInt(p.limit) || 20;
    if (limit > 50) limit = 50;

    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (!sheet) return _webAppRespond({ status: 'error', error: 'data_sheet_missing' });
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return _webAppRespond({ status: 'ok', matches: [] });

    var c = CONFIG.COLUMNS;
    var matches = [];
    var data = sheet.getRange(2, 1, lastRow - 1, CONFIG.SHEET_COL_COUNT || 26).getValues();
    for (var i = 0; i < data.length; i++) {
      var r = data[i];
      var name = (r[c.FULL_NAME - 1] || '').toString();
      var org = (r[c.ORGANIZATION - 1] || '').toString();
      var url = (r[c.LINKEDIN_URL - 1] || '').toString();
      var hay = (name + ' ' + org + ' ' + url).toLowerCase();
      if (hay.indexOf(q) >= 0) {
        matches.push({
          rowNum: i + 2,
          fullName: name,
          organization: org,
          linkedinUrl: url,
          status: (r[c.STATUS - 1] || '').toString()
        });
        if (matches.length >= limit) break;
      }
    }
    return _webAppRespond({ status: 'ok', query: q, matches: matches });
  } catch (err) {
    return _webAppRespond({ status: 'error', error: err.message, where: 'lead_search' });
  }
}

// ─── Bulk loaders (one Sheet read per request, not per lead) ──────────────

// ─── Test the Lusha-level engine on demand (Patch 2026-05-12) ─────────────
//
// Synchronously runs the full enrichEmail cascade against a synthetic lead so
// you can verify Apollo + Hunter + Findymail + pattern-guess + auto-pick
// behavior without polluting Sheet1/Sheet2 or burning a real outreach slot.
//
// Usage examples:
//   /exec?action=test_enrichment&linkedinUrl=https://www.linkedin.com/in/vidhi127
//   /exec?action=test_enrichment&firstName=Vidhi&lastName=Shah&organization=Hotstar
//   /exec?action=test_enrichment&email=existing@hotstar.com   (verify path)
//
// Returns: { tier_results: [...], final: {...}, ms: N, sources_attempted: [...] }

function _handleTestEnrichmentRequest(e) {
  var startedAt = Date.now();
  try {
    var p = (e && e.parameter) || {};
    var lead = {
      rowNum: 0,
      firstName: (p.firstName || '').toString().trim(),
      lastName: (p.lastName || '').toString().trim(),
      organization: (p.organization || '').toString().trim(),
      linkedinUrl: (p.linkedinUrl || '').toString().trim(),
      email: (p.email || '').toString().trim()
    };
    if (!lead.firstName && !lead.linkedinUrl && !lead.email) {
      return _webAppRespond({
        status: 'error',
        error: 'must_provide_one_of: linkedinUrl | firstName+lastName+organization | email',
        examples: [
          '?action=test_enrichment&linkedinUrl=https://www.linkedin.com/in/vidhi127',
          '?action=test_enrichment&firstName=Vidhi&lastName=Shah&organization=Hotstar',
          '?action=test_enrichment&email=existing@hotstar.com'
        ]
      });
    }

    // Probe what's configured so the response is honest about which tiers can fire
    var props = PropertiesService.getScriptProperties();
    var apiInventory = {
      apollo: !!props.getProperty('APOLLO_API_KEY'),
      hunter: !!props.getProperty('HUNTER_API_KEY'),
      snov_client_id: !!props.getProperty('SNOV_CLIENT_ID'),
      snov_secret: !!props.getProperty('SNOV_CLIENT_SECRET'),
      reoon: !!props.getProperty('REOON_API_KEY'),
      findymail: !!props.getProperty('FINDYMAIL_KEY')
    };

    // ── Run the enricher ──
    var enrichResult = null;
    var enrichError = null;
    try {
      enrichResult = enrichEmail(lead);
    } catch (e2) {
      enrichError = e2.message + ' | ' + (e2.stack || '').substring(0, 400);
    }

    // ── Standalone probes for each tier so the user sees what each source returned ──
    var tierResults = [];
    var tries = function(label, fn) {
      var t0 = Date.now();
      var out, err = null;
      try { out = fn(); } catch (ee) { err = ee.message; }
      tierResults.push({
        tier: label,
        ms: Date.now() - t0,
        ok: !!out,
        error: err,
        result: out
      });
    };

    if (lead.linkedinUrl && apiInventory.apollo && typeof resolveLeadApolloMatch === 'function') {
      tries('apollo_people_match', function() { return resolveLeadApolloMatch(lead.linkedinUrl); });
    }
    if (lead.organization) {
      tries('domain_resolution', function() {
        if (typeof resolveDomainContextual === 'function') return resolveDomainContextual(lead.organization);
        if (typeof resolveDomainMultiSource === 'function') return resolveDomainMultiSource(lead.organization);
        if (typeof _organizationToDomain === 'function') return { domain: _organizationToDomain(lead.organization), source: 'naive' };
        return null;
      });
    }
    if (lead.firstName && lead.lastName && lead.organization && apiInventory.hunter) {
      var domain = (function() {
        try {
          var dr = (typeof _organizationToDomain === 'function') ? _organizationToDomain(lead.organization) : null;
          return dr || (lead.organization.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com');
        } catch (_) { return null; }
      })();
      if (domain && typeof _hunterEmailFinder === 'function') {
        tries('hunter_email_finder', function() { return _hunterEmailFinder(domain, lead.firstName, lead.lastName); });
      }
    }
    if (apiInventory.findymail && typeof _findymailVerify === 'function') {
      var candidateEmail = lead.email || (
        lead.firstName && lead.lastName && lead.organization
          ? (lead.firstName + '.' + lead.lastName + '@' + (lead.organization.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com')).toLowerCase()
          : null
      );
      if (candidateEmail) {
        tries('findymail_verify', function() {
          return _findymailVerify(candidateEmail, props.getProperty('FINDYMAIL_KEY'));
        });
      }
    }
    if (lead.email && apiInventory.reoon && typeof verifyEmailDeliverable === 'function') {
      tries('reoon_verify', function() { return verifyEmailDeliverable(lead.email); });
    }

    return _webAppRespond({
      status: 'ok',
      durationMs: Date.now() - startedAt,
      input: lead,
      apiInventory: apiInventory,
      tierResults: tierResults,
      enrichEmail: enrichResult,
      enrichError: enrichError,
      humanSummary: _humanSummarizeTest(enrichResult, tierResults, apiInventory)
    });
  } catch (err) {
    return _webAppRespond({ status: 'error', error: err.message, where: 'test_enrichment', stack: (err.stack || '').substring(0, 400) });
  }
}

function _humanSummarizeTest(enrich, tiers, inv) {
  var lines = [];
  if (enrich && enrich.email) {
    lines.push('FINAL: ' + enrich.email + ' (' + (enrich.source || '?') +
               ', confidence ' + (enrich.confidence || 0).toFixed(2) +
               ', status ' + enrich.status + ')');
    if (enrich.reason) lines.push('  reason: ' + enrich.reason);
    if (enrich.candidates && enrich.candidates.length > 1) {
      lines.push('  alternates: ' + enrich.candidates.slice(0, 3).join(', '));
    }
  } else if (enrich) {
    lines.push('FINAL: NO EMAIL — status=' + enrich.status + ', reason=' + (enrich.reason || ''));
  } else {
    lines.push('FINAL: enricher returned null (check error)');
  }
  if (!inv.findymail) lines.push('NOTE: FINDYMAIL_KEY unset — catch-all resolver skipped (set in Script Properties to enable).');
  if (!inv.reoon) lines.push('NOTE: REOON_API_KEY unset — deliverability gate skipped.');
  if (!inv.apollo) lines.push('NOTE: APOLLO_API_KEY unset — primary source skipped.');
  tiers.forEach(function(t) {
    if (t.error) lines.push('  ' + t.tier + ' ERROR: ' + t.error);
    else if (!t.ok) lines.push('  ' + t.tier + ': no result');
    else if (t.result && t.result.email) lines.push('  ' + t.tier + ' → ' + t.result.email + ' (' + t.ms + 'ms)');
    else if (t.result && t.result.domain) lines.push('  ' + t.tier + ' → domain ' + t.result.domain + ' (' + t.ms + 'ms)');
    else lines.push('  ' + t.tier + ' → ' + JSON.stringify(t.result).substring(0, 100) + ' (' + t.ms + 'ms)');
  });
  return lines.join('\n');
}

// ─── Send a draft from the APK (Patch 2026-05-12) ────────────────────────
//
// Looks up the GmailDraft by ID and calls .send(). Updates Sheet2 STATUS
// to SENT on success. Idempotent: if draft is already sent (no longer found),
// returns gracefully without error.
//
// GET form is also supported (so curl test works easily); the action is the
// same — there's no body required.

function _handleSendDraftRequest(e) {
  if (!_checkAuthToken_(e)) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error', error: 'authentication_required',
      message: 'Pass &token=<ADMIN_TOKEN> in the query string'
    })).setMimeType(ContentService.MimeType.JSON);
  }
  try {
    var draftId = ((e && e.parameter && e.parameter.draftId) || '').toString().trim();
    if (!draftId) return _webAppRespond({ status: 'error', error: 'draftId_required' });

    var draft;
    try {
      draft = GmailApp.getDraft(draftId);
    } catch (lookupErr) {
      return _webAppRespond({ status: 'error', error: 'draft_not_found', detail: lookupErr.message });
    }
    if (!draft) return _webAppRespond({ status: 'error', error: 'draft_not_found' });

    var messageId, threadId;
    try {
      var msg = draft.send();
      messageId = msg.getId();
      threadId = msg.getThread().getId();
    } catch (sendErr) {
      return _webAppRespond({ status: 'error', error: 'send_failed', detail: sendErr.message });
    }

    // Sheet2 status → SENT for the matching row
    //
    // PATCH 2026-05-18: ALSO write SENT_DATE. Without this, FollowUp.gs's
    // processScheduledFollowUps sees `parentLead.sentDate` empty and falls
    // through to the legacy ScheduledDate path (which was set to
    // draft-creation time, not send time) — follow-ups then fire on a
    // stale schedule. With SENT_DATE properly anchored, the 3/7/14-day
    // offsets compute correctly from the actual send moment.
    var rowsUpdated = 0;
    try {
      var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
      var sheet2 = ss.getSheetByName(CONFIG.DATA_SHEET);
      var c = CONFIG.COLUMNS;
      if (sheet2 && sheet2.getLastRow() >= 2) {
        var data = sheet2.getRange(2, 1, sheet2.getLastRow() - 1, CONFIG.SHEET_COL_COUNT || 26).getValues();
        for (var i = 0; i < data.length; i++) {
          if (data[i][c.DRAFT_ID - 1] === draftId) {
            var sentIso = new Date().toISOString();
            sheet2.getRange(i + 2, c.STATUS).setValue('SENT');
            sheet2.getRange(i + 2, c.SENT_DATE).setValue(sentIso);
            sheet2.getRange(i + 2, c.LAST_UPDATED).setValue(sentIso);
            rowsUpdated++;
            break;
          }
        }
      }
    } catch (sheetErr) {
      Logger.log('[send_draft] Sheet2 update failed: ' + sheetErr.message);
    }

    return _webAppRespond({
      status: 'ok',
      draftId: draftId,
      messageId: messageId,
      threadId: threadId,
      sheet2RowsUpdated: rowsUpdated,
      gmailThreadUrl: 'https://mail.google.com/mail/u/0/#sent/' + threadId
    });
  } catch (err) {
    return _webAppRespond({ status: 'error', error: err.message, where: 'send_draft' });
  }
}

// ─── Unified events poll (Patch 2026-05-12) ─────────────────────────────
//
// Single endpoint the APK's TrackingPollWorker hits every ~15 min to surface
// fresh signals (so it can fire a notification when an email is opened, a
// click happens, a reply arrives, or a follow-up becomes due). Caller passes
// `since=<ISO>` and gets all events newer than that. Calling without `since`
// returns the last 12 hours.

function _handlePollEventsRequest(e) {
  try {
    var p = (e && e.parameter) || {};
    var sinceMs;
    if (p.since) {
      try { sinceMs = new Date(p.since).getTime(); }
      catch (_) { sinceMs = Date.now() - 12 * 3600 * 1000; }
    } else {
      sinceMs = Date.now() - 12 * 3600 * 1000;
    }
    if (!isFinite(sinceMs)) sinceMs = Date.now() - 12 * 3600 * 1000;
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var newOpens = [], newClicks = [], newReplies = [], dueFollowups = [], newBounces = [];

    // Opens + clicks from TrackingLog
    var tlog = ss.getSheetByName('TrackingLog');
    if (tlog && tlog.getLastRow() >= 2) {
      var td = tlog.getDataRange().getValues();
      for (var i = 1; i < td.length; i++) {
        var ts = td[i][0] ? new Date(td[i][0]).getTime() : 0;
        if (ts < sinceMs) continue;
        var evt = td[i][1];
        var entry = {
          ts: td[i][0] ? td[i][0].toString() : '',
          trackingId: td[i][2] || '',
          linkId: td[i][3] || '',
          threadId: td[i][4] || '',
          leadRow: td[i][5] || '',
          linkedinUrl: td[i][6] || ''
        };
        if (evt === 'open') newOpens.push(entry);
        else if (evt === 'click') newClicks.push(entry);
      }
    }

    // Replies from RepliedLog
    var rlog = ss.getSheetByName('RepliedLog');
    if (rlog && rlog.getLastRow() >= 2) {
      var rd = rlog.getDataRange().getValues();
      for (var j = 1; j < rd.length; j++) {
        var rts = rd[j][0] ? new Date(rd[j][0]).getTime() : 0;
        if (rts < sinceMs) continue;
        newReplies.push({
          ts: rd[j][0] ? rd[j][0].toString() : '',
          threadId: rd[j][1] || '',
          leadRow: rd[j][2] || '',
          leadName: rd[j][3] || '',
          replyFrom: rd[j][4] || '',
          snippet: rd[j][6] || ''
        });
      }
    }

    // Bounces from BounceLog
    var blog = ss.getSheetByName('BounceLog');
    if (blog && blog.getLastRow() >= 2) {
      var bd = blog.getDataRange().getValues();
      for (var k = 1; k < bd.length; k++) {
        var bts = bd[k][0] ? new Date(bd[k][0]).getTime() : 0;
        if (bts < sinceMs) continue;
        newBounces.push({
          ts: bd[k][0] ? bd[k][0].toString() : '',
          email: bd[k][1] || '',
          domain: bd[k][2] || '',
          category: bd[k][3] || '',
          reason: bd[k][5] || ''
        });
      }
    }

    // Follow-ups now due (scheduled within next 2 hours OR overdue and not sent)
    var fu = ss.getSheetByName('FollowUps');
    if (fu && fu.getLastRow() >= 2) {
      var fd = fu.getDataRange().getValues();
      var hdr = fd[0].map(function(h) { return (h || '').toString().trim(); });
      var iEmail = hdr.indexOf('Email');
      var iSched = hdr.indexOf('ScheduledDate');
      var iSt = hdr.indexOf('Status');
      var iName = hdr.indexOf('LeadName');
      var iStage = hdr.indexOf('Stage');
      var nowTs = Date.now();
      for (var f = 1; f < fd.length; f++) {
        var st = (fd[f][iSt] || '').toString();
        if (st !== 'PENDING') continue;
        var schedTs;
        try { schedTs = new Date(fd[f][iSched]).getTime(); } catch (_) { continue; }
        if (schedTs <= nowTs + 2 * 3600 * 1000) {
          dueFollowups.push({
            email: fd[f][iEmail],
            leadName: fd[f][iName],
            stage: fd[f][iStage],
            scheduledDate: fd[f][iSched] ? new Date(fd[f][iSched]).toISOString() : null,
            isOverdue: schedTs <= nowTs
          });
        }
      }
    }

    return _webAppRespond({
      status: 'ok',
      since: new Date(sinceMs).toISOString(),
      counts: {
        opens: newOpens.length,
        clicks: newClicks.length,
        replies: newReplies.length,
        bounces: newBounces.length,
        followupsDue: dueFollowups.length
      },
      opens: newOpens,
      clicks: newClicks,
      replies: newReplies,
      bounces: newBounces,
      followupsDue: dueFollowups,
      serverTimestamp: new Date().toISOString()
    });
  } catch (err) {
    return _webAppRespond({ status: 'error', error: err.message, where: 'poll_events' });
  }
}

// ─── Reply analytics endpoint (Patch 2026-05-12) ─────────────────────────
// Powers the in-app Stats tab. Returns rolling 7d / 30d aggregates +
// top engaged leads + per-day buckets for sparkline charts.

function _handleReplyAnalyticsRequest(e) {
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var now = Date.now();
    var win7 = now - 7 * 86400 * 1000;
    var win30 = now - 30 * 86400 * 1000;

    function inWin(tsStr, since) {
      if (!tsStr) return false;
      try { return new Date(tsStr).getTime() >= since; } catch (_) { return false; }
    }

    // Sheet2 — sent + status breakdown
    var sheet2 = ss.getSheetByName(CONFIG.DATA_SHEET);
    var c = CONFIG.COLUMNS;
    var sent7 = 0, sent30 = 0, drafted7 = 0, drafted30 = 0;
    var statusMix = {};
    if (sheet2 && sheet2.getLastRow() >= 2) {
      var rows = sheet2.getRange(2, 1, sheet2.getLastRow() - 1, CONFIG.SHEET_COL_COUNT || 26).getValues();
      for (var i = 0; i < rows.length; i++) {
        var status = (rows[i][c.STATUS - 1] || '').toString();
        statusMix[status] = (statusMix[status] || 0) + 1;
        var lu = rows[i][c.LAST_UPDATED - 1];
        if (status === 'SENT' || status === 'REPLIED' || status.indexOf('BOUNCED') === 0) {
          if (inWin(lu, win7)) sent7++;
          if (inWin(lu, win30)) sent30++;
        }
        if (status === 'DRAFT_CREATED') {
          if (inWin(lu, win7)) drafted7++;
          if (inWin(lu, win30)) drafted30++;
        }
      }
    }

    // Replies + opens + clicks + bounces from event sheets
    var replies7 = 0, replies30 = 0;
    var rlog = ss.getSheetByName('RepliedLog');
    if (rlog && rlog.getLastRow() >= 2) {
      var rd = rlog.getDataRange().getValues();
      for (var j = 1; j < rd.length; j++) {
        if (inWin(rd[j][0], win7)) replies7++;
        if (inWin(rd[j][0], win30)) replies30++;
      }
    }

    var opens7 = 0, opens30 = 0, clicks7 = 0, clicks30 = 0;
    var dailyOpens = {};
    var tlog = ss.getSheetByName('TrackingLog');
    if (tlog && tlog.getLastRow() >= 2) {
      var td = tlog.getDataRange().getValues();
      for (var k = 1; k < td.length; k++) {
        var evt = td[k][1];
        var tsStr = td[k][0] ? td[k][0].toString() : null;
        var ts;
        try { ts = new Date(tsStr).getTime(); } catch (_) { continue; }
        if (evt === 'open') {
          if (ts >= win7) opens7++;
          if (ts >= win30) opens30++;
          // Bucket by day for sparkline (last 14 days)
          if (ts >= now - 14 * 86400 * 1000) {
            var day = new Date(ts).toISOString().substring(0, 10);
            dailyOpens[day] = (dailyOpens[day] || 0) + 1;
          }
        } else if (evt === 'click') {
          if (ts >= win7) clicks7++;
          if (ts >= win30) clicks30++;
        }
      }
    }

    var bouncesHard7 = 0, bouncesHard30 = 0;
    var blog = ss.getSheetByName('BounceLog');
    if (blog && blog.getLastRow() >= 2) {
      var bd = blog.getDataRange().getValues();
      for (var l = 1; l < bd.length; l++) {
        if ((bd[l][3] || '') !== 'hard') continue;
        if (inWin(bd[l][0], win7)) bouncesHard7++;
        if (inWin(bd[l][0], win30)) bouncesHard30++;
      }
    }

    var pauseState = (typeof getAutoPauseState === 'function') ? getAutoPauseState() : { paused: false };

    return _webAppRespond({
      status: 'ok',
      generatedAt: new Date().toISOString(),
      window7d: {
        emailsSent: sent7,
        drafted: drafted7,
        replies: replies7,
        replyRate: sent7 > 0 ? (replies7 / sent7) : 0,
        opens: opens7,
        clicks: clicks7,
        hardBounces: bouncesHard7,
        bounceRate: sent7 > 0 ? (bouncesHard7 / sent7) : 0
      },
      window30d: {
        emailsSent: sent30,
        drafted: drafted30,
        replies: replies30,
        replyRate: sent30 > 0 ? (replies30 / sent30) : 0,
        opens: opens30,
        clicks: clicks30,
        hardBounces: bouncesHard30,
        bounceRate: sent30 > 0 ? (bouncesHard30 / sent30) : 0
      },
      statusBreakdown: statusMix,
      dailyOpensLast14: dailyOpens,
      autoPause: pauseState
    });
  } catch (err) {
    return _webAppRespond({ status: 'error', error: err.message, where: 'reply_analytics' });
  }
}

// ─── Force re-enrichment of a single row (Patch 2026-05-12) ──────────────
// Lets the user push a specific Sheet2 row through the enrichEmail cascade
// again (with current MSD + DDPD logic) without waiting for the 5-min batch
// cron. Writes the new email/source/confidence back to Sheet2 in place.
//
// Usage: /exec?action=force_reenrich&rowNum=152&token=<ADMIN_TOKEN>

function _handleForceReenrichRequest(e) {
  try {
    var rowNum = parseInt((e.parameter.rowNum || '').toString(), 10);
    if (!rowNum || rowNum < 2) {
      return { status: 'error', error: 'rowNum_required_and_>=_2' };
    }
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet2 = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (!sheet2 || sheet2.getLastRow() < rowNum) {
      return { status: 'error', error: 'row_not_found' };
    }
    var c = CONFIG.COLUMNS;
    var width = CONFIG.SHEET_COL_COUNT || 26;
    var rowData = sheet2.getRange(rowNum, 1, 1, width).getValues()[0];

    var lead = {
      rowNum: rowNum,
      linkedinUrl: (rowData[c.LINKEDIN_URL - 1] || '').toString(),
      fullName: (rowData[c.FULL_NAME - 1] || '').toString(),
      email: (rowData[c.EMAIL - 1] || '').toString(),
      organization: (rowData[c.ORGANIZATION - 1] || '').toString(),
      headline: c.HEADLINE ? (rowData[c.HEADLINE - 1] || '').toString() : ''
    };
    // Derive firstName / lastName from fullName
    var parts = (lead.fullName || '').split(/\s+/).filter(Boolean);
    lead.firstName = parts.length > 0 ? parts[0] : '';
    lead.lastName  = parts.length > 1 ? parts[parts.length - 1] : '';

    if (typeof enrichEmail !== 'function') {
      return { status: 'error', error: 'enrichEmail_fn_missing' };
    }
    var before = {
      email: lead.email,
      status: (rowData[c.STATUS - 1] || '').toString(),
      confidence: c.EMAIL_CONFIDENCE ? parseFloat(rowData[c.EMAIL_CONFIDENCE - 1] || 0) : 0,
      source: c.EMAIL_SOURCE ? (rowData[c.EMAIL_SOURCE - 1] || '').toString() : ''
    };
    var result = enrichEmail(lead);

    // Write results back
    var updates = [];
    if (result.email && c.ENRICHED_EMAIL) {
      sheet2.getRange(rowNum, c.ENRICHED_EMAIL).setValue(result.email);
      updates.push('ENRICHED_EMAIL=' + result.email);
    }
    if (c.EMAIL_CONFIDENCE) {
      sheet2.getRange(rowNum, c.EMAIL_CONFIDENCE).setValue(result.confidence || 0);
      updates.push('EMAIL_CONFIDENCE=' + (result.confidence || 0));
    }
    if (c.EMAIL_SOURCE) {
      sheet2.getRange(rowNum, c.EMAIL_SOURCE).setValue(result.source || '');
      updates.push('EMAIL_SOURCE=' + (result.source || ''));
    }
    // Update status: VERIFIED → RESEARCH_DONE (so batch proceeds to draft)
    if (result.status === 'VERIFIED') {
      sheet2.getRange(rowNum, c.STATUS).setValue('RESEARCH_DONE');
      updates.push('STATUS=RESEARCH_DONE');
    } else if (result.status === 'NEEDS_EMAIL_REVIEW') {
      sheet2.getRange(rowNum, c.STATUS).setValue('NEEDS_EMAIL_REVIEW');
      // Append candidates to NOTES
      if (result.candidates && c.NOTES) {
        var noteSuffix = ' [REENRICHED ' + new Date().toISOString().substring(0,10) +
                         ' candidates=' + result.candidates.slice(0, 5).join('|') + ']';
        var existing = (rowData[c.NOTES - 1] || '').toString();
        sheet2.getRange(rowNum, c.NOTES).setValue(existing + noteSuffix);
      }
      updates.push('STATUS=NEEDS_EMAIL_REVIEW');
    }
    sheet2.getRange(rowNum, c.LAST_UPDATED).setValue(new Date().toISOString());

    return {
      status: 'ok',
      rowNum: rowNum,
      lead: { fullName: lead.fullName, linkedinUrl: lead.linkedinUrl, organization: lead.organization },
      before: before,
      after: {
        status: result.status,
        email: result.email,
        confidence: result.confidence,
        source: result.source,
        reason: result.reason,
        msdScore: result.msdScore,
        msdGap: result.msdGap
      },
      updates: updates
    };
  } catch (err) {
    return { status: 'error', error: err.message, where: 'force_reenrich', stack: (err.stack || '').substring(0, 400) };
  }
}

// ─── Force re-compose of a single REVIEW row (Patch 2026-05-12) ───────────
// Resets a REVIEW/stalled lead back to RESEARCH_DONE so the safety-net cron
// will re-run composition. Clears compose-stage fields to avoid stale data.
// Usage: /exec?action=force_recompose&rowNum=166&token=<ADMIN_TOKEN>
function _handleForceRecompose(e) {
  try {
    var p = e.parameter || {};
    var rowNum = parseInt(p.rowNum) || 0;
    if (!rowNum || rowNum < 2) return { status: 'error', error: 'rowNum_required' };
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (!sheet || sheet.getLastRow() < rowNum) return { status: 'error', error: 'row_out_of_range' };
    var c = CONFIG.COLUMNS;
    var before = {
      status: sheet.getRange(rowNum, c.STATUS).getValue(),
      subject: sheet.getRange(rowNum, c.SUBJECT_LINE).getValue(),
      qualityScore: sheet.getRange(rowNum, c.QUALITY_SCORE).getValue(),
      draftId: sheet.getRange(rowNum, c.DRAFT_ID).getValue()
    };
    // Reset compose-stage fields. Status RESEARCH_DONE so safety-net picks it up.
    sheet.getRange(rowNum, c.STATUS).setValue('RESEARCH_DONE');
    sheet.getRange(rowNum, c.SUBJECT_LINE).setValue('');
    sheet.getRange(rowNum, c.EMAIL_BODY).setValue('');
    sheet.getRange(rowNum, c.QUALITY_SCORE).setValue('');
    sheet.getRange(rowNum, c.DRAFT_ID).setValue('');
    sheet.getRange(rowNum, c.NOTES).setValue('[force_recompose ' + new Date().toISOString() + '] cleared compose fields; awaiting safety-net pickup');
    Logger.log('[WebApp] force_recompose row=' + rowNum + ' before=' + JSON.stringify(before));
    return { status: 'ok', rowNum: rowNum, before: before, note: 'Status reset to RESEARCH_DONE. Safety-net cron will re-compose within 5 minutes.' };
  } catch (err) {
    return { status: 'error', error: err.message, stack: err.stack };
  }
}

/**
 * PATCH 2026-05-12: Bulk-recovery for leads stuck at terminal states.
 *
 * The pipeline has 3 statuses that are dead-ends (no scanner picks them up):
 *   - ERROR (set on per-row exception in BatchProcessor; no auto-retry)
 *   - REOON_RETRY_PENDING (set on PSV transient failure; never re-queued)
 *   - REVIEW (validator-flagged; only force_recompose recovers individually)
 *
 * This endpoint resets ALL matching rows to NEW (blank) so _scanAndProcessNewRows
 * picks them up on the next safety-net cron tick (~5 min). Audit-trails the
 * prior status in the NOTES column.
 *
 * Usage:
 *   /exec?action=reset_stuck_leads&token=<ADMIN>
 *     → resets ERROR + REOON_RETRY_PENDING (default — REVIEW NOT touched; use force_recompose for REVIEW)
 *   /exec?action=reset_stuck_leads&statuses=ERROR&token=<ADMIN>
 *     → resets only ERROR
 *   /exec?action=reset_stuck_leads&statuses=ERROR,REOON_RETRY_PENDING,REVIEW&token=<ADMIN>
 *     → resets all 3 statuses
 */
function _handleResetStuckLeads(e) {
  try {
    var p = e.parameter || {};
    var statusesParam = (p.statuses || 'ERROR,REOON_RETRY_PENDING').toString().trim();
    var targetStatuses = statusesParam.split(',').map(function(s) { return s.trim().toUpperCase(); }).filter(Boolean);
    if (targetStatuses.length === 0) {
      return { status: 'error', error: 'no_statuses_specified' };
    }
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (!sheet) return { status: 'error', error: 'data_sheet_missing' };
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { status: 'ok', resetCount: 0, byStatus: {}, message: 'no data rows' };
    var c = CONFIG.COLUMNS;
    var allStatuses = sheet.getRange(2, c.STATUS, lastRow - 1, 1).getValues();
    var nowIso = new Date().toISOString();
    var resetCount = 0;
    var byStatus = {};
    var resetRows = [];
    for (var i = 0; i < allStatuses.length; i++) {
      var st = (allStatuses[i][0] || '').toString().trim().toUpperCase();
      if (targetStatuses.indexOf(st) >= 0) {
        var rowNum = i + 2;
        sheet.getRange(rowNum, c.STATUS).setValue('');  // blank = NEW for the scanner
        sheet.getRange(rowNum, c.NOTES).setValue('[reset_stuck_leads ' + nowIso + '] was: ' + st);
        // Also clear stale draft fields so a fresh attempt won't see ghost data
        try { sheet.getRange(rowNum, c.DRAFT_ID).setValue(''); } catch (_) {}
        resetCount++;
        byStatus[st] = (byStatus[st] || 0) + 1;
        resetRows.push(rowNum);
      }
    }
    // Best-effort: clear live Reoon CacheService entries for the specific emails
    // being reset so that retried PSV probes are fresh, not served from cache.
    // Since 2026-06-12-cacheservice-migration the live Reoon cache is in
    // CacheService (not ScriptProperties). CacheService cannot be enumerated but
    // supports targeted remove(key). We read each reset row's email column and
    // remove its cache key directly. clearReoonCache() only clears legacy
    // ScriptProperties residue and is NOT called here (it cannot touch CacheService).
    var clearedReoon = 0;
    try {
      var cache = (typeof _svc === 'function') ? _svc('Cache') : CacheService.getScriptCache();
      var cachePrefix = (CONFIG && CONFIG.PROPERTY_KEYS && CONFIG.PROPERTY_KEYS.REOON_VERIFY_CACHE_PREFIX) || 'REOON_VERIFY_';
      resetRows.forEach(function(rowNum) {
        try {
          var emailVal = (sheet.getRange(rowNum, c.EMAIL).getValue() || '').toString().trim();
          if (emailVal && emailVal.indexOf('@') > 0) {
            cache.remove(cachePrefix + emailVal);
            clearedReoon++;
          }
        } catch (_) {}
      });
    } catch (re) {
      Logger.log('[WebApp] Reoon CacheService eviction failed (non-blocking): ' + re.message);
    }
    Logger.log('[WebApp] reset_stuck_leads: ' + resetCount + ' rows reset (' + JSON.stringify(byStatus) + '). Rows: ' + resetRows.join(',') + '. Reoon cache keys evicted: ' + clearedReoon);
    return {
      status: 'ok',
      resetCount: resetCount,
      byStatus: byStatus,
      resetRows: resetRows,
      reoonCacheEvicted: clearedReoon,
      message: resetCount > 0
        ? 'Reset rows to NEW. Safety-net cron will re-run within 5 minutes.'
        : 'No rows matched the target statuses.'
    };
  } catch (err) {
    return { status: 'error', error: err.message, stack: err.stack };
  }
}

/**
 * PATCH 2026-05-12: Permanently delete a lead from the pipeline.
 *
 * Removes the row from Sheet2 (pipeline) AND from Sheet1 (raw lead store)
 * keyed on linkedinUrl. Sheet2 is populated from Sheet1 — deleting only
 * Sheet2 wouldn't be permanent if Sheet1 still has the entry.
 *
 * Usage: /exec?action=delete_lead&rowNum=N&token=<ADMIN>
 *   rowNum is the Sheet2 row number (visible in dashboard).
 *
 * Returns: { status, sheet2RowDeleted, sheet1RowDeleted, linkedinUrl }
 */
function _handleDeleteLead(e) {
  try {
    var p = e.parameter || {};
    var rowNum = parseInt(p.rowNum) || 0;
    if (!rowNum || rowNum < 2) {
      return { status: 'error', error: 'rowNum_required (must be >= 2)' };
    }
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet2 = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (!sheet2) return { status: 'error', error: 'sheet2_not_found' };
    if (sheet2.getLastRow() < rowNum) {
      return { status: 'error', error: 'row_out_of_range' };
    }
    var c = CONFIG.COLUMNS;
    // Read identifying fields BEFORE deletion (for Sheet1 lookup + audit)
    var linkedinUrl = (sheet2.getRange(rowNum, c.LINKEDIN_URL).getValue() || '').toString().trim();
    var fullName    = (sheet2.getRange(rowNum, c.FULL_NAME).getValue() || '').toString().trim();
    var email       = (sheet2.getRange(rowNum, c.EMAIL).getValue() || '').toString().trim();

    // Delete the Sheet2 row entirely (shifts rows up — note: this changes
    // row numbers for everything below). The caller should refresh their
    // view after deletion if iterating.
    sheet2.deleteRow(rowNum);

    // Find + delete matching row in Sheet1 by linkedinUrl.
    // PATCH 2026-05-13: Sheet1 column A is TIMESTAMP (not URL — that's column B).
    // Previous code was matching URLs against timestamps and always missed.
    // Now we dynamically locate the URL column from headers + use trim/lowercase/
    // slash-strip/query-param-strip for robust matching.
    var sheet1Deleted = 0;
    if (linkedinUrl) {
      var sheet1 = ss.getSheetByName('Sheet1');
      if (sheet1 && sheet1.getLastRow() > 1) {
        var lastCol = sheet1.getLastColumn();
        var headers = sheet1.getRange(1, 1, 1, lastCol).getValues()[0];
        var urlColIdx = -1;
        for (var k = 0; k < headers.length; k++) {
          var h = (headers[k] || '').toString().toLowerCase().trim();
          if (h === 'linkedinurl' || h === 'linkedin url' || h === 'linkedin_url' || h === 'profile url' || h === 'url') {
            urlColIdx = k;
            break;
          }
        }
        if (urlColIdx < 0) urlColIdx = 1; // fallback: column B
        Logger.log('[delete_lead] Sheet1 urlColIdx=' + urlColIdx + ' header="' + headers[urlColIdx] + '"');
        var s1Data = sheet1.getRange(2, 1, sheet1.getLastRow() - 1, lastCol).getValues();
        var targetNorm = linkedinUrl.toLowerCase().split('?')[0].replace(/\/$/, '').trim();
        for (var i = s1Data.length - 1; i >= 0; i--) {
          var s1Url = (s1Data[i][urlColIdx] || '').toString().trim();
          if (!s1Url) continue;
          var s1Norm = s1Url.toLowerCase().split('?')[0].replace(/\/$/, '').trim();
          if (s1Url === linkedinUrl || s1Norm === targetNorm) {
            sheet1.deleteRow(i + 2);
            sheet1Deleted++;
            Logger.log('[delete_lead] deleted Sheet1 row ' + (i + 2) + ' url=' + s1Url);
          }
        }
      }
    }

    Logger.log('[WebApp] delete_lead row=' + rowNum + ' url=' + linkedinUrl + ' name=' + fullName + ' sheet1Deleted=' + sheet1Deleted);
    return {
      status: 'ok',
      sheet2RowDeleted: rowNum,
      sheet1RowsDeleted: sheet1Deleted,
      linkedinUrl: linkedinUrl,
      fullName: fullName,
      email: email,
      note: sheet1Deleted > 0
        ? 'Removed from both Sheet1 and Sheet2.'
        : 'Removed from Sheet2 only (no matching Sheet1 row found — that\'s OK if Sheet2 is the canonical store).'
    };
  } catch (err) {
    return { status: 'error', error: err.message, stack: err.stack };
  }
}

/**
 * PATCH 2026-05-13: render diagnostic.
 *
 * Returns the rendered email body + key Sheet2 fields for a single row so we
 * can inspect what was actually composed without opening the Gmail draft.
 * Powers the "why is the AI tools block missing?" debug loop.
 *
 * Usage: /exec?action=get_email_body&rowNum=42&token=<ADMIN>
 * Optional flags:
 *   &headOnly=1   → strip the long EMAIL_BODY (col M), return just metadata
 *   &snippet=400  → cap EMAIL_BODY at N characters (default 30000)
 *
 * Returns:
 *   {
 *     status: 'ok',
 *     rowNum, fullName, email, status,
 *     archetype, template, resumeVariant,
 *     subjectLine,
 *     emailBody:    '<rendered HTML>',
 *     emailBodyLen: <full length before truncation>,
 *     truncated:    true|false,
 *     notes
 *   }
 */
function _handleGetEmailBody(e) {
  try {
    var rowNum = parseInt(e.parameter.rowNum, 10);
    if (!rowNum || rowNum < 2) {
      return { status: 'error', error: 'rowNum required (>=2)' };
    }
    var snippetCap = parseInt(e.parameter.snippet, 10);
    if (!snippetCap || snippetCap <= 0) snippetCap = 30000;
    var headOnly = (e.parameter.headOnly === '1' || e.parameter.headOnly === 'true');

    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (!sheet) {
      return { status: 'error', error: 'data_sheet_missing', sheet: CONFIG.DATA_SHEET };
    }
    if (rowNum > sheet.getLastRow()) {
      return { status: 'error', error: 'row_out_of_range', rowNum: rowNum, lastRow: sheet.getLastRow() };
    }

    var c = CONFIG.COLUMNS;
    var row = sheet.getRange(rowNum, 1, 1, CONFIG.SHEET_COL_COUNT).getValues()[0];

    // Safe column extractor — 1-indexed cols, 0-indexed array
    function col(idx) { return (row[idx - 1] || '').toString(); }

    var emailBody = col(c.EMAIL_BODY);
    var emailBodyLen = emailBody.length;
    var truncated = false;
    if (headOnly) {
      emailBody = '';
      truncated = true;
    } else if (emailBody.length > snippetCap) {
      emailBody = emailBody.substring(0, snippetCap);
      truncated = true;
    }

    return {
      status: 'ok',
      rowNum: rowNum,
      fullName:       col(c.FULL_NAME),
      email:          col(c.EMAIL),
      enrichedEmail:  col(c.ENRICHED_EMAIL),
      pipelineStatus: col(c.STATUS),
      archetype:      col(c.ARCHETYPE),
      template:       col(c.TEMPLATE),
      resumeVariant:  col(c.RESUME_VARIANT),
      subjectLine:    col(c.SUBJECT_LINE),
      qualityScore:   col(c.QUALITY_SCORE),
      draftId:        col(c.DRAFT_ID),
      notes:          col(c.NOTES),
      emailBody:      emailBody,
      emailBodyLen:   emailBodyLen,
      truncated:      truncated,
      hasAiToolsBlock: emailBodyLen > 0 && emailBody.indexOf('github.com/GauravRIIMK') >= 0,
      hasBullets:      emailBodyLen > 0 && (emailBody.indexOf('&bull;') >= 0 || emailBody.indexOf('<li') >= 0),
      hasLookingForward: emailBodyLen > 0 && emailBody.indexOf('Looking forward to hearing from you') >= 0
    };
  } catch (err) {
    return { status: 'error', error: err.message, stack: err.stack };
  }
}

/**
 * PATCH 2026-05-13: admin field-override endpoint.
 *
 * Updates a single Sheet1 cell so the broken-data state of a stuck lead can
 * be corrected without re-running the APK. Sheet1 is the canonical store
 * (Sheet2 is its UNIQUE() projection), so writing here propagates downstream
 * automatically on the next formula recalc.
 *
 * Sheet1 schema (1-indexed):
 *   A: Timestamp        B: LinkedIn_URL    C: Full_Name        D: Headline
 *   E: Designation      F: Organization    G: Email            H: Phone
 *   I: Website          J: Location        K: Connection       L: Confidence
 *
 * Important: `rowNum` in the request refers to the SHEET2 row (the pipeline
 * row the user sees), NOT the Sheet1 row. We resolve Sheet1 by matching
 * linkedinUrl from Sheet2's column A.
 *
 * Allowed `field` values map to Sheet1 columns:
 *   fullName     → C (3)
 *   headline     → D (4)
 *   designation  → E (5)
 *   organization → F (6)
 *   email        → G (7)
 *
 * Optional `then=force_reenrich` chains a re-enrich after the update.
 *
 * @returns { status, sheet1Row, oldValue, newValue, [reenrichResult] }
 */
function _handleSetLeadField(e) {
  try {
    var rowNum = parseInt((e.parameter.rowNum || '').toString(), 10);
    var field = ((e.parameter.field || '').toString()).trim().toLowerCase();
    var value = ((e.parameter.value || '').toString());
    var chain = ((e.parameter.then || '').toString()).trim().toLowerCase();

    if (!rowNum || rowNum < 2) {
      return { status: 'error', error: 'rowNum required (>=2)' };
    }
    if (!field) {
      return { status: 'error', error: 'field required (one of: fullName, headline, designation, organization, email)' };
    }

    // Map allowed fields → Sheet1 column index (1-indexed)
    var FIELD_TO_SHEET1_COL = {
      'fullname':     3,
      'headline':     4,
      'designation':  5,
      'organization': 6,
      'email':        7
    };
    // PATCH 2026-05-16 (Option 5 / Sub-option 2): Sheet2-only fields.
    // target_role lives in Sheet2 col 27 (AA) — not in Sheet1, not propagated
    // by the =UNIQUE() formula. These fields are written DIRECTLY to Sheet2
    // (Sheet1 lookup skipped). Allows the user to add a target-role intent
    // to any lead via the same admin endpoint pattern.
    var FIELD_TO_SHEET2_COL = {
      'target_role': CONFIG.COLUMNS.TARGET_ROLE || 27
    };
    var sheet1Col = FIELD_TO_SHEET1_COL[field];
    var sheet2Col = FIELD_TO_SHEET2_COL[field];
    if (!sheet1Col && !sheet2Col) {
      return {
        status: 'error',
        error: 'invalid_field',
        allowed: Object.keys(FIELD_TO_SHEET1_COL).concat(Object.keys(FIELD_TO_SHEET2_COL)),
        received: field
      };
    }

    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet2 = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (!sheet2) return { status: 'error', error: 'sheet2_missing' };

    // Read the lead's linkedinUrl from Sheet2 column A so we can find the
    // matching Sheet1 row (Sheet2 is formula-driven, can't write to it directly)
    var s2Row = sheet2.getRange(rowNum, 1, 1, CONFIG.SHEET_COL_COUNT).getValues()[0];
    var linkedinUrl = (s2Row[0] || '').toString().trim();
    var fullName = (s2Row[1] || '').toString();
    if (!linkedinUrl) {
      return { status: 'error', error: 'lead_has_no_linkedinUrl_in_sheet2', rowNum: rowNum };
    }

    // ── BRANCH: Sheet2-only fields write directly to Sheet2 ─────────────
    // PATCH 2026-05-16: target_role and future Sheet2-only fields. No Sheet1
    // hop. Status update + notes append handled the same way.
    if (sheet2Col) {
      var oldS2Value = (sheet2.getRange(rowNum, sheet2Col).getValue() || '').toString();
      sheet2.getRange(rowNum, sheet2Col).setValue(value);
      Logger.log('[WebApp] set_lead_field (Sheet2-direct): row=' + rowNum + ' col=' + sheet2Col +
                 ' field=' + field + ' "' + oldS2Value + '" → "' + value + '"');
      SpreadsheetApp.flush();

      var sheet2Response = {
        status: 'ok',
        sheet2Row: rowNum,
        fullName: fullName,
        linkedinUrl: linkedinUrl,
        field: field,
        sheet2Col: sheet2Col,
        oldValue: oldS2Value,
        newValue: value,
        scope: 'sheet2_direct'
      };

      // Optional chain — same as Sheet1 path
      if (chain === 'force_reenrich') {
        var fakeE_s2 = { parameter: { rowNum: String(rowNum), token: e.parameter.token } };
        try {
          var rer_s2 = _handleForceReenrichRequest(fakeE_s2);
          sheet2Response.reenrichResult = rer_s2;
        } catch (chainErr_s2) {
          sheet2Response.reenrichResult = { status: 'error', error: chainErr_s2.message };
        }
      } else if (chain === 'force_recompose') {
        var fakeE_s2c = { parameter: { rowNum: String(rowNum), token: e.parameter.token } };
        try {
          var rrc = _handleForceRecompose(fakeE_s2c);
          sheet2Response.recomposeResult = rrc;
        } catch (chainErr_s2c) {
          sheet2Response.recomposeResult = { status: 'error', error: chainErr_s2c.message };
        }
      }
      return sheet2Response;
    }

    // ── Sheet1-backed fields path (unchanged) ───────────────────────────
    var sheet1 = ss.getSheetByName('Sheet1');
    if (!sheet1) return { status: 'error', error: 'sheet1_missing' };

    // Locate the Sheet1 row by linkedinUrl (column B = index 2)
    var lastRow1 = sheet1.getLastRow();
    if (lastRow1 < 2) return { status: 'error', error: 'sheet1_empty' };
    var s1Urls = sheet1.getRange(2, 2, lastRow1 - 1, 1).getValues();
    var targetNorm = linkedinUrl.toLowerCase().split('?')[0].replace(/\/$/, '').trim();
    var sheet1Row = 0;
    for (var i = 0; i < s1Urls.length; i++) {
      var u = (s1Urls[i][0] || '').toString().trim();
      if (!u) continue;
      var uNorm = u.toLowerCase().split('?')[0].replace(/\/$/, '').trim();
      if (uNorm === targetNorm) { sheet1Row = i + 2; break; }
    }
    if (!sheet1Row) {
      return { status: 'error', error: 'sheet1_row_not_found_for_url', linkedinUrl: linkedinUrl };
    }

    var oldValue = (sheet1.getRange(sheet1Row, sheet1Col).getValue() || '').toString();
    sheet1.getRange(sheet1Row, sheet1Col).setValue(value);
    Logger.log('[WebApp] set_lead_field: sheet1 row=' + sheet1Row + ' col=' + sheet1Col +
               ' field=' + field + ' "' + oldValue + '" → "' + value + '"');

    // Force Sheet2 to refresh its formula projection so the change is visible
    // by the next read. We do this by writing a benign value to force recalc.
    SpreadsheetApp.flush();

    var response = {
      status: 'ok',
      sheet1Row: sheet1Row,
      sheet2Row: rowNum,
      fullName: fullName,
      linkedinUrl: linkedinUrl,
      field: field,
      sheet1Col: sheet1Col,
      oldValue: oldValue,
      newValue: value,
      scope: 'sheet1_propagated'
    };

    // Optional chain: re-enrich immediately after the field change
    if (chain === 'force_reenrich') {
      // Fake an `e` object pointing at the same rowNum for the existing handler
      var fakeE = { parameter: { rowNum: String(rowNum), token: e.parameter.token } };
      try {
        var rer = _handleForceReenrichRequest(fakeE);
        response.reenrichResult = rer;
      } catch (chainErr) {
        response.reenrichResult = { status: 'error', error: chainErr.message };
      }
    }

    return response;
  } catch (err) {
    return { status: 'error', error: err.message, stack: (err.stack || '').substring(0, 400) };
  }
}

function _bulkLoadTrackingByUrl(ss) {
  // Returns: { '<linkedinUrlNormalized>': { opens, clicks, scanClicks, lastOpenAt, firstOpenAt, threadId, trackingId } }
  var out = {};
  try {
    var log = ss.getSheetByName('TrackingLog');
    var links = ss.getSheetByName('TrackingLinks');
    if (!log || log.getLastRow() < 2) return out;
    var rows = log.getDataRange().getValues();
    var headerLen = rows[0].length;
    // Schema: Timestamp, Event, Tracking_ID, Link_ID, Thread_ID, Lead_Row, LinkedIn_URL, User_Agent
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      var url = (r[6] || '').toString().toLowerCase().replace(/\/$/, '');
      if (!url) continue;
      if (!out[url]) {
        out[url] = { opens: 0, clicks: 0, scanClicks: 0,
                     lastOpenAt: null, firstOpenAt: null,
                     threadId: r[4] || '', trackingId: r[2] || '',
                     clicksPerLink: {} };
      }
      var ev = r[1];
      var tsStr = r[0] ? r[0].toString() : null;
      if (ev === 'open') {
        out[url].opens++;
        if (!out[url].firstOpenAt) out[url].firstOpenAt = tsStr;
        out[url].lastOpenAt = tsStr;
      } else if (ev === 'click') {
        out[url].clicks++;
        var lid = (r[3] || '').toString();
        if (lid) out[url].clicksPerLink[lid] = (out[url].clicksPerLink[lid] || 0) + 1;
      } else if (ev === 'scan_click') {
        out[url].scanClicks++;
      }
    }
    // Override threadId from TrackingLinks (more reliable — populated post-draft)
    if (links && links.getLastRow() >= 2 && links.getLastColumn() >= 8) {
      var linkData = links.getDataRange().getValues();
      for (var j = 1; j < linkData.length; j++) {
        var lurl = (linkData[j][4] || '').toString().toLowerCase().replace(/\/$/, '');
        var tid = linkData[j][7] || '';
        if (lurl && tid && out[lurl]) out[lurl].threadId = tid;
      }
    }
  } catch (e) {
    Logger.log('[WebApp] _bulkLoadTrackingByUrl error: ' + e.message);
  }
  return out;
}

function _bulkLoadFollowupsByEmail(ss) {
  // Returns: { '<email>': [{stage, scheduledDate, status, sentAt}, ...] }
  var out = {};
  try {
    var sheet = ss.getSheetByName('FollowUps');
    if (!sheet || sheet.getLastRow() < 2) return out;
    var data = sheet.getDataRange().getValues();
    var headers = data[0].map(function(h) { return (h || '').toString().trim(); });
    var ie = headers.indexOf('Email');
    var isched = headers.indexOf('ScheduledDate');
    var ist = headers.indexOf('Status');
    var istg = headers.indexOf('Stage');
    var isent = headers.indexOf('SentAt');
    for (var i = 1; i < data.length; i++) {
      var r = data[i];
      var em = (r[ie] || '').toString().toLowerCase();
      if (!em) continue;
      if (!out[em]) out[em] = [];
      out[em].push({
        stage: parseInt(r[istg]) || 0,
        scheduledDate: r[isched] ? new Date(r[isched]).toISOString() : null,
        status: (r[ist] || '').toString(),
        sentAt: isent >= 0 && r[isent] ? new Date(r[isent]).toISOString() : null
      });
    }
    Object.keys(out).forEach(function(k) {
      out[k].sort(function(a, b) { return a.stage - b.stage; });
    });
  } catch (e) {
    Logger.log('[WebApp] _bulkLoadFollowupsByEmail error: ' + e.message);
  }
  return out;
}

// ─── NEW ENDPOINTS (2026-05-12): follow-up management ────────────────────────

// ── Endpoint: clear_pending_followups ────────────────────────────────────────
// Cancels every FollowUps row whose Status is not SENT/CANCELLED/CANCELLED_REPLIED.
// Optional `leadEmail` param scopes the cancel to one lead.
function _handleClearPendingFollowups(e) {
  if (!_checkAuthToken_(e)) {
    return _webAppRespond({ status: 'error', error: 'authentication_required' });
  }
  try {
    var p = (e && e.parameter) || {};
    var scopeEmail = (p.leadEmail || '').toString().trim().toLowerCase();

    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName('FollowUps');
    if (!sheet || sheet.getLastRow() < 2) {
      return _webAppRespond({ status: 'ok', cancelledCount: 0 });
    }

    var data = sheet.getDataRange().getValues();
    var headers = data[0].map(function(h) { return (h || '').toString().trim(); });
    var iStatus = headers.indexOf('Status');
    var iEmail  = headers.indexOf('Email');
    if (iStatus < 0) {
      return _webAppRespond({ status: 'error', error: 'Status_column_not_found_in_FollowUps_sheet' });
    }

    var TERMINAL = { 'SENT': true, 'CANCELLED': true, 'CANCELLED_REPLIED': true };
    var cancelledCount = 0;

    for (var i = 1; i < data.length; i++) {
      var rowStatus = ((data[i][iStatus] || '') + '').trim();
      if (TERMINAL[rowStatus]) continue;

      if (scopeEmail) {
        var rowEmail = iEmail >= 0 ? ((data[i][iEmail] || '') + '').trim().toLowerCase() : '';
        if (rowEmail !== scopeEmail) continue;
      }

      sheet.getRange(i + 1, iStatus + 1).setValue('CANCELLED');
      cancelledCount++;
    }

    return _webAppRespond({ status: 'ok', cancelledCount: cancelledCount });
  } catch (err) {
    return _webAppRespond({ status: 'error', error: err.message });
  }
}

// ── Endpoint: set_followup_time ───────────────────────────────────────────────
// Sets a custom absolute send time for the earliest PENDING follow-up of a lead.
function _handleSetFollowupTime(e) {
  if (!_checkAuthToken_(e)) {
    return _webAppRespond({ status: 'error', error: 'authentication_required' });
  }
  try {
    var p = (e && e.parameter) || {};
    var leadRow  = parseInt(p.leadRow) || 0;
    var sendAt   = (p.sendAt || '').toString().trim();
    var stageFilter = p.stage ? parseInt(p.stage) : null;

    if (!leadRow || leadRow < 2) {
      return _webAppRespond({ status: 'error', error: 'leadRow_required_and_>=_2' });
    }
    if (!sendAt) {
      return _webAppRespond({ status: 'error', error: 'sendAt_required' });
    }

    var sendAtMs;
    try { sendAtMs = new Date(sendAt).getTime(); } catch (_) { sendAtMs = NaN; }
    if (!isFinite(sendAtMs)) {
      return _webAppRespond({ status: 'error', error: 'sendAt_invalid_iso_timestamp' });
    }
    // Allow 60s of clock skew but reject clear past timestamps
    if (sendAtMs < Date.now() - 60000) {
      return _webAppRespond({ status: 'error', error: 'sendAt_is_in_the_past' });
    }

    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName('FollowUps');
    if (!sheet || sheet.getLastRow() < 2) {
      return _webAppRespond({ status: 'error', error: 'no_pending_followup_for_lead' });
    }

    var data = sheet.getDataRange().getValues();
    var headers = data[0].map(function(h) { return (h || '').toString().trim(); });
    var iStatus    = headers.indexOf('Status');
    var iParentRow = headers.indexOf('ParentRow');
    var iStage     = headers.indexOf('Stage');
    var iSched     = headers.indexOf('ScheduledDate');
    var iOffset    = headers.indexOf('OffsetDays');

    if (iStatus < 0 || iParentRow < 0) {
      return _webAppRespond({ status: 'error', error: 'FollowUps_sheet_missing_required_columns' });
    }

    // Collect PENDING rows for this leadRow, sorted by stage
    var candidates = [];
    for (var i = 1; i < data.length; i++) {
      var rowStatus = ((data[i][iStatus] || '') + '').trim();
      if (rowStatus !== 'PENDING') continue;
      var rowParent = parseInt(data[i][iParentRow]) || 0;
      if (rowParent !== leadRow) continue;
      var rowStage = iStage >= 0 ? (parseInt(data[i][iStage]) || 0) : 0;
      if (stageFilter !== null && rowStage !== stageFilter) continue;
      candidates.push({ sheetRow: i + 1, stage: rowStage });
    }

    if (candidates.length === 0) {
      return _webAppRespond({ status: 'error', error: 'no_pending_followup_for_lead' });
    }

    // Target smallest stage
    candidates.sort(function(a, b) { return a.stage - b.stage; });
    var target = candidates[0];

    if (iSched >= 0) sheet.getRange(target.sheetRow, iSched + 1).setValue(new Date(sendAtMs));
    if (iOffset >= 0) sheet.getRange(target.sheetRow, iOffset + 1).setValue('');

    return _webAppRespond({
      status: 'ok',
      followupRow: target.sheetRow,
      stage: target.stage,
      newScheduledDate: new Date(sendAtMs).toISOString()
    });
  } catch (err) {
    return _webAppRespond({ status: 'error', error: err.message });
  }
}

// ── Endpoint: trigger_send_now ────────────────────────────────────────────────
// Immediately fires createFollowUpDraft for the earliest PENDING follow-up.
function _handleTriggerSendNow(e) {
  if (!_checkAuthToken_(e)) {
    return _webAppRespond({ status: 'error', error: 'authentication_required' });
  }
  try {
    var p = (e && e.parameter) || {};
    var leadRow     = parseInt(p.leadRow) || 0;
    var stageFilter = p.stage ? parseInt(p.stage) : null;

    if (!leadRow || leadRow < 2) {
      return _webAppRespond({ status: 'error', error: 'leadRow_required_and_>=_2' });
    }

    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName('FollowUps');
    if (!sheet || sheet.getLastRow() < 2) {
      return _webAppRespond({ status: 'error', error: 'no_pending_followup_for_lead' });
    }

    var data = sheet.getDataRange().getValues();
    var headers = data[0].map(function(h) { return (h || '').toString().trim(); });
    var iStatus    = headers.indexOf('Status');
    var iParentRow = headers.indexOf('ParentRow');
    var iStage     = headers.indexOf('Stage');
    var iSched     = headers.indexOf('ScheduledDate');
    var iSubject   = headers.indexOf('Subject');
    var iBody      = headers.indexOf('Body');

    if (iStatus < 0 || iParentRow < 0) {
      return _webAppRespond({ status: 'error', error: 'FollowUps_sheet_missing_required_columns' });
    }

    var candidates = [];
    for (var i = 1; i < data.length; i++) {
      var rowStatus = ((data[i][iStatus] || '') + '').trim();
      if (rowStatus !== 'PENDING') continue;
      var rowParent = parseInt(data[i][iParentRow]) || 0;
      if (rowParent !== leadRow) continue;
      var rowStage = iStage >= 0 ? (parseInt(data[i][iStage]) || 0) : 0;
      if (stageFilter !== null && rowStage !== stageFilter) continue;
      candidates.push({
        sheetRow: i + 1,
        stage: rowStage,
        subject: iSubject >= 0 ? (data[i][iSubject] || '').toString() : '',
        body:    iBody    >= 0 ? (data[i][iBody]    || '').toString() : ''
      });
    }

    if (candidates.length === 0) {
      return _webAppRespond({ status: 'error', error: 'no_pending_followup_for_lead' });
    }

    candidates.sort(function(a, b) { return a.stage - b.stage; });
    var target = candidates[0];

    if (typeof getLeadByRow !== 'function') {
      return _webAppRespond({ status: 'error', error: 'getLeadByRow_fn_missing' });
    }
    var parentLead = getLeadByRow(leadRow);
    if (!parentLead) {
      return _webAppRespond({ status: 'error', error: 'parent_lead_not_found_for_row_' + leadRow });
    }

    if (typeof createFollowUpDraft !== 'function') {
      return _webAppRespond({ status: 'error', error: 'createFollowUpDraft_fn_missing' });
    }

    var result = createFollowUpDraft(
      parentLead,
      target.stage,
      target.subject || parentLead.subjectLine || '',
      target.body,
      parentLead.threadId
    );

    if (!result || !result.success) {
      return _webAppRespond({ status: 'error', error: (result && result.error) || 'createFollowUpDraft_failed' });
    }

    // Mark FollowUps row as SENT
    var nowDate = new Date();
    sheet.getRange(target.sheetRow, iStatus + 1).setValue('SENT');
    if (iSched >= 0) sheet.getRange(target.sheetRow, iSched + 1).setValue(nowDate);

    // Update Sheet2 status
    if (typeof updateLeadFields === 'function') {
      var nextStatus = (typeof STATUS !== 'undefined' && STATUS['FOLLOWUP_' + target.stage])
                       || ('FOLLOWUP_' + target.stage);
      updateLeadFields(leadRow, { STATUS: nextStatus, FOLLOWUP_STAGE: target.stage });
    }

    // FCM notification
    if (typeof sendFcmBroadcast === 'function') {
      try {
        sendFcmBroadcast(
          'Follow-up draft ready',
          'Stage-' + target.stage + ' for ' + (parentLead.fullName || ''),
          {
            event: 'followup_draft_created',
            stage: String(target.stage),
            leadRow: String(leadRow),
            draftId: String(result.draftId || '')
          }
        );
      } catch (fcmErr) {
        Logger.log('[trigger_send_now] FCM error (non-fatal): ' + fcmErr.message);
      }
    }

    return _webAppRespond({
      status: 'ok',
      draftId: result.draftId || '',
      threadId: result.threadId || parentLead.threadId || '',
      stage: target.stage
    });
  } catch (err) {
    return _webAppRespond({ status: 'error', error: err.message });
  }
}

// ── Endpoint: get_followup_draft ──────────────────────────────────────────────
// Returns the pending follow-up body text + metadata for preview.
function _handleGetFollowupDraft(e) {
  if (!_checkAuthToken_(e)) {
    return _webAppRespond({ status: 'error', error: 'authentication_required' });
  }
  try {
    var p = (e && e.parameter) || {};
    var leadRow     = parseInt(p.leadRow) || 0;
    var stageFilter = p.stage ? parseInt(p.stage) : null;

    if (!leadRow || leadRow < 2) {
      return _webAppRespond({ status: 'error', error: 'leadRow_required_and_>=_2' });
    }

    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName('FollowUps');
    if (!sheet || sheet.getLastRow() < 2) {
      return _webAppRespond({ status: 'error', error: 'no_pending_followup_for_lead' });
    }

    var data = sheet.getDataRange().getValues();
    var headers = data[0].map(function(h) { return (h || '').toString().trim(); });
    var iStatus    = headers.indexOf('Status');
    var iParentRow = headers.indexOf('ParentRow');
    var iStage     = headers.indexOf('Stage');
    var iSched     = headers.indexOf('ScheduledDate');
    var iSubject   = headers.indexOf('Subject');
    var iBody      = headers.indexOf('Body');
    var iEmail     = headers.indexOf('Email');
    var iLeadName  = headers.indexOf('LeadName');

    if (iStatus < 0 || iParentRow < 0) {
      return _webAppRespond({ status: 'error', error: 'FollowUps_sheet_missing_required_columns' });
    }

    var candidates = [];
    for (var i = 1; i < data.length; i++) {
      var rowStatus = ((data[i][iStatus] || '') + '').trim();
      if (rowStatus !== 'PENDING') continue;
      var rowParent = parseInt(data[i][iParentRow]) || 0;
      if (rowParent !== leadRow) continue;
      var rowStage = iStage >= 0 ? (parseInt(data[i][iStage]) || 0) : 0;
      if (stageFilter !== null && rowStage !== stageFilter) continue;
      candidates.push({
        sheetRow: i + 1,
        stage: rowStage,
        subject:       iSubject  >= 0 ? (data[i][iSubject]  || '').toString() : '',
        body:          iBody     >= 0 ? (data[i][iBody]     || '').toString() : '',
        scheduledDate: iSched    >= 0 ? (data[i][iSched]    ? new Date(data[i][iSched]).toISOString() : null) : null,
        leadEmail:     iEmail    >= 0 ? (data[i][iEmail]    || '').toString() : '',
        leadName:      iLeadName >= 0 ? (data[i][iLeadName] || '').toString() : ''
      });
    }

    if (candidates.length === 0) {
      return _webAppRespond({ status: 'error', error: 'no_pending_followup_for_lead' });
    }

    candidates.sort(function(a, b) { return a.stage - b.stage; });
    var target = candidates[0];

    return _webAppRespond({
      status: 'ok',
      followupRow: target.sheetRow,
      stage: target.stage,
      subject: target.subject,
      body: target.body,
      scheduledDate: target.scheduledDate,
      currentStatus: 'PENDING',
      leadEmail: target.leadEmail,
      leadName: target.leadName
    });
  } catch (err) {
    return _webAppRespond({ status: 'error', error: err.message });
  }
}
