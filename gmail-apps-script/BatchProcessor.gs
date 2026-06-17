/**
 * ============================================================
 * BatchProcessor.gs — Batch Orchestration with Triggers
 * Handles the 6-minute GAS execution limit by processing
 * leads in batches of 5 with time-based trigger chaining.
 * Uses LockService to prevent concurrent execution.
 * ============================================================
 */

/**
 * PATCH 2026-05-18: row-identity-safe wrapper around updateLeadFields.
 *
 * All in-pipeline state writes go through this helper. It passes the
 * lead's linkedinUrl to updateLeadFields so the underlying writer can
 * verify the row's current LinkedIn URL matches before writing — and
 * re-locate the row if Sheet1 changed during processing.
 *
 * This closes the Sheet1↔Sheet2 desync class of bug where a multi-stage
 * pipeline reads lead@rowNum, makes external API calls (during which
 * Sheet1 mutates and UNIQUE() shifts rows), then writes state back to
 * the now-different row. Sheet2Realigner cleans up existing damage;
 * this helper prevents new damage.
 *
 * Backwards-safe — if lead.linkedinUrl is missing (e.g., transient
 * pipeline objects), falls back to the raw rowNum write (no verification).
 */
function _uf(lead, updates) {
  if (!lead || lead.rowNum === undefined) return false;
  // CRITICAL: these calls MUST be to updateLeadFields, NOT _uf.
  // A previous bulk replace_all (`updateLeadFields(lead.rowNum, ` → `_uf(lead,`)
  // accidentally matched this function's own body and turned it into
  // unbounded recursion — 31 leads errored with "Maximum call stack
  // size exceeded" between 2026-05-18 and 2026-05-19. Restored 2026-05-19.
  // If you ever need to bulk-replace updateLeadFields calls again,
  // exclude this file's _uf body or use a more specific pattern.
  //
  // Phase 3 (LEAD_UID): if lead.leadUid is populated, pass it as verifyUid.
  // updateLeadFields rejects writes if the row's stored UID exists AND
  // doesn't match — protecting against Sheet1↔Sheet2 desync that corrupts
  // identity. Legacy rows (no UID) bypass the check.
  var opts = {};
  if (lead.linkedinUrl) opts.verifyUrl = lead.linkedinUrl;
  if (lead.leadUid)     opts.verifyUid = lead.leadUid;
  if (Object.keys(opts).length > 0) {
    return updateLeadFields(lead.rowNum, updates, opts);
  }
  return updateLeadFields(lead.rowNum, updates);
}

/**
 * PATCH 2026-06-12-errretry-preserve: seed-or-preserve for the bounded-retry
 * token. Every failure write in this file composes NOTES wholesale
 * (updateLeadFields REPLACES the cell — it does not merge tokens), and the
 * old hardcoded `errRetry:0/2` seed wiped the increment that Scanner.gs
 * _bumpErrRetryOnError had just written: compose-fail seeds 0/2 → scanner
 * bump writes 1/2 → next failing cycle reseeds 0/2 → bump writes 1/2 → …
 * The counter plateaued at 1/2, N never reached M, and
 * scoreStuckAutoRecoverEligible kept the row eligible on every tick —
 * unbounded re-dispatch at full compose cost.
 *
 * This helper carries forward the FIRST errRetry:N/M token found in the
 * caller-held scan-time NOTES (same token format other code grep-depends on,
 * Inventory §9.2) and falls back to the caller-supplied seed token only when
 * the row has no token yet. Pure function — no sheet I/O; callers pass
 * lead.notes (populated by _rowToLeadProfile, and by the scanner's dispatch
 * lead since this patch). An exhausted token (e.g. 2/2) is deliberately
 * preserved as-is: the next scanner bump then terminates the row at ERROR
 * instead of silently granting a fresh budget.
 *
 * @param {string|null|undefined} existingNotes — row NOTES as read at scan time
 * @param {string} baseMsg — failure message WITHOUT a retry token
 * @param {string} seedToken — token to seed when none exists, e.g. 'errRetry:0/2'
 * @returns {string} composed NOTES: baseMsg + ' ' + token + '.'
 */
function _seedOrPreserveErrRetry(existingNotes, baseMsg, seedToken) {
  var notesStr = (existingNotes === null || existingNotes === undefined) ? '' : String(existingNotes);
  var m = notesStr.match(/errRetry:(\d+)\/(\d+)/);
  var token = m ? m[0] : (seedToken || 'errRetry:0/2');
  return baseMsg + ' ' + token + '.';
}

/**
 * PATCH 2026-06-13-transient-draft: pure helper — classify Gmail error strings.
 *
 * Returns true for short-window rate-limit errors (transient) that are NOT the
 * lead's fault and should NOT burn an errRetry credit. Returns false for all
 * other errors (genuine content/API failures that should use the normal
 * DRAFT_FAILED + errRetry:0/2 + bump-to-ERROR path).
 *
 * Transient signatures:
 *   "Service invoked too many times" (NOT followed by "for one day") — GAS short-window rate cap
 *   "rate limit"                       — generic rate limit message
 *   "user-rate limit exceeded"         — per-user rate cap
 *   "too many requests"                — HTTP 429 class
 *
 * Non-transient (daily exhaustion): "Service invoked too many times for one day"
 * This string is explicitly excluded — it represents a genuine daily limit and
 * must go through the daily-flag path in GmailDrafter.gs, not the transient park.
 *
 * @param {string} errStr — error message string (already coerced to string by caller)
 * @returns {boolean}
 */
function _isTransientGmailError(errStr) {
  var s = errStr.toLowerCase();
  // "service invoked too many times for one day" → daily exhaustion, NOT transient
  if (s.indexOf('for one day') >= 0) return false;
  return /service invoked too many times|rate limit|user-rate limit exceeded|too many requests/.test(s);
}

/**
 * Phase 3 — Ensure the Sheet2 row has a LEAD_UID. Three resolution paths:
 *
 *   1. Sheet2 col CONFIG.COLUMNS.LEAD_UID (28) already populated → return that.
 *   2. Sheet2 UID empty + Sheet1 has a row with same linkedinUrl → copy that UID
 *      to Sheet2 col 28 (atomic write under existing batch lock).
 *   3. No Sheet1 match → generate fresh UUID, write to Sheet2 col 28.
 *
 * Idempotent: subsequent calls on a row that already has a UID return immediately.
 *
 * @param {Object} lead — must have rowNum, linkedinUrl
 * @returns {string} the assigned UID
 */
function _ensureLeadUid(lead) {
  if (!lead || !lead.rowNum) return '';
  var sheetsApp = (typeof _svc === 'function') ? _svc('Sheets') : SpreadsheetApp;
  var ss = sheetsApp.openById(CONFIG.SHEET_ID);
  var sheet2 = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet2) return '';
  var uidCol = CONFIG.COLUMNS.LEAD_UID;  // 28
  var existing;
  try {
    existing = (sheet2.getRange(lead.rowNum, uidCol).getValue() || '').toString().trim();
  } catch (_) { existing = ''; }
  if (existing) {
    Logger.log('[LeadUid] Row ' + lead.rowNum + ' already has UID ' + existing);
    return existing;
  }
  // Path 2: lookup in Sheet1
  var sheet1 = ss.getSheetByName('Sheet1');
  var copiedUid = '';
  if (sheet1 && lead.linkedinUrl) {
    try {
      copiedUid = _lookupUidInSheet1(sheet1, lead.linkedinUrl);
    } catch (_) {}
  }
  var uid = copiedUid || _generateLeadUidForBatch();
  // Write back to Sheet2 col 28
  try {
    sheet2.getRange(lead.rowNum, uidCol).setValue(uid);
    Logger.log('[LeadUid] Row ' + lead.rowNum + ' assigned UID ' + uid +
               ' (source: ' + (copiedUid ? 'sheet1_copy' : 'fresh_gen') + ')');
  } catch (e) {
    Logger.log('[LeadUid] Could not write UID to row ' + lead.rowNum + ': ' + e.message);
  }
  return uid;
}

/**
 * Scan Sheet1 for the FIRST row matching `linkedinUrl`; return its LEAD_UID
 * (col 13). Returns '' if no match or no UID populated.
 */
function _lookupUidInSheet1(sheet1, linkedinUrl) {
  if (!sheet1 || !linkedinUrl) return '';
  var lastRow = sheet1.getLastRow();
  if (lastRow < 2) return '';
  var rows = sheet1.getRange(2, 1, lastRow - 1, CONFIG.SHEET1_COL_COUNT).getValues();
  for (var i = 0; i < rows.length; i++) {
    var rowUrl = (rows[i][CONFIG.SHEET1_COLUMNS.LINKEDIN_URL - 1] || '').toString().trim();
    if (rowUrl === linkedinUrl) {
      var uid = (rows[i][CONFIG.SHEET1_COLUMNS.LEAD_UID - 1] || '').toString().trim();
      if (uid) return uid;
    }
  }
  return '';
}

/**
 * Generate a fresh UUID. Same as WebApp.gs:_generateLeadUid but scoped to
 * BatchProcessor for separation of concerns. Mockable via _svc('Utilities').
 */
function _generateLeadUidForBatch() {
  if (typeof _svc === 'function') {
    try { return _svc('Utilities').getUuid(); } catch (_) {}
  }
  return Utilities.getUuid();
}

/**
 * IDENTITY RECOVERY (Patch 2026-05-19, no-termination mode):
 * When a row arrives with no fullName + no organization, attempt to
 * recover identity from the LinkedIn URL via 4 paths in priority order:
 *
 *   1. Apollo /people/match by URL → authoritative person + employer
 *   2. URL fragment hint + Apollo /organizations/search → company name
 *   3. URL slug name extraction → firstName/lastName from "in/jane-doe-123"
 *   4. Defensive placeholders for the absolute worst case
 *
 * @param {Object} lead
 * @returns {Object} {fullName, firstName, lastName, organization, designation,
 *                    source, fullNameFallback, firstNameFallback, organizationFallback}
 */
function _recoverIdentityFromUrl(lead) {
  var out = { source: '' };
  if (!lead || !lead.linkedinUrl) {
    out.fullNameFallback = 'there';
    out.firstNameFallback = 'there';
    out.organizationFallback = 'their company';
    out.source = 'no_url_full_placeholders';
    return out;
  }

  // Path 1: Apollo /people/match
  if (typeof resolveLeadApolloMatch === 'function') {
    try {
      var apolloMatch = resolveLeadApolloMatch(lead.linkedinUrl);
      if (apolloMatch) {
        if (apolloMatch.fullName) {
          out.fullName = apolloMatch.fullName;
          out.firstName = apolloMatch.firstName || apolloMatch.fullName.split(' ')[0];
          out.lastName = apolloMatch.lastName ||
                         (apolloMatch.fullName.split(' ').slice(1).join(' '));
        }
        if (apolloMatch.organizationName) out.organization = apolloMatch.organizationName;
        if (apolloMatch.title) out.designation = apolloMatch.title;
        if (out.fullName || out.organization) {
          out.source = 'apollo_people_match';
        }
      }
    } catch (_) {}
  }

  // Path 2: URL fragment hint → Apollo orgs (only if org still missing)
  if (!out.organization && typeof _extractOrgHintFromLinkedInUrl === 'function') {
    var hint = _extractOrgHintFromLinkedInUrl(lead.linkedinUrl);
    if (hint && typeof resolveDomainApolloOrgs === 'function') {
      try {
        var apolloOrgs = resolveDomainApolloOrgs(hint, {
          linkedinUrl: lead.linkedinUrl,
          headline: lead.headline || ''
        });
        var pickedOrg = null;
        if (apolloOrgs && apolloOrgs.name) pickedOrg = apolloOrgs;
        else if (Array.isArray(apolloOrgs) && apolloOrgs[0]) pickedOrg = apolloOrgs[0];
        if (pickedOrg && pickedOrg.name) {
          out.organization = pickedOrg.name;
          out.source = (out.source || '') + (out.source ? '+' : '') + 'url_hint_apollo_orgs';
        }
      } catch (_) {}
    }
  }

  // Path 3: URL slug → name (if name still missing)
  if (!out.fullName) {
    var m = lead.linkedinUrl.match(/linkedin\.com\/in\/([^\/?#]+)/i);
    if (m) {
      var slug = m[1].toLowerCase().replace(/-[a-f0-9]{6,}(?:-[a-f0-9]+)*$/i, '');
      var parts = slug.split('-').filter(function(p) {
        return p && !/^\d+$/.test(p) && p.length >= 2;
      });
      if (parts.length >= 2) {
        out.firstName = _capitalize(parts[0]);
        out.lastName = _capitalize(parts.slice(1, parts.length - 1).join(' ') || parts[1]);
        // If last segment was a company hint, drop it from the last name
        if (parts.length >= 3 && !out.organization) {
          var lastSeg = parts[parts.length - 1];
          if (lastSeg.length >= 3) {
            // Heuristic: if it looks like a brand (no vowel cluster + caps probability)
            // keep it as part of the name. We'll let Path 2 above own the org hint.
            out.lastName = _capitalize(parts.slice(1, parts.length - 1).join(' '));
          }
        }
        out.fullName = (out.firstName + ' ' + (out.lastName || '')).trim();
        out.source = (out.source || '') + (out.source ? '+' : '') + 'url_slug_name';
      } else if (parts.length === 1) {
        out.firstName = _capitalize(parts[0]);
        out.fullName = out.firstName;
        out.source = (out.source || '') + (out.source ? '+' : '') + 'url_slug_firstname_only';
      }
    }
  }

  // Defensive placeholders for whatever still didn't recover
  out.fullNameFallback = 'there';
  out.firstNameFallback = 'there';
  out.organizationFallback = 'their company';
  if (!out.source) out.source = 'placeholders_only';
  return out;
}

function _capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * STUB DOSSIER (Patch 2026-05-19, no-termination mode):
 * When researchLead throws, we still need a dossier shape so the
 * classifier + composer don't NPE. Provides a minimal dossier with
 * generic hooks tied to whatever fields we DO have on the lead.
 */
function _stubDossierForLead(lead) {
  var org = (lead && lead.organization) || 'their company';
  var role = (lead && lead.designation) || (lead && lead.headline) || 'their role';
  return {
    organization: org,
    designation: role,
    industry: (lead && lead.industry) || '',
    hooks: [
      'Generic outreach to ' + org + ' (research dossier unavailable for this run)'
    ],
    triggerEvents: [],
    latestNews: '',
    bestHookAngle: '',
    linkedInActivity: '',
    sharedBackground: [],
    orgChallenges: [],
    bridgeStatements: [],
    decisionPower: 'unknown',
    stubReason: 'research_threw_or_dossier_missing'
  };
}

/**
 * DEFAULT CLASSIFICATION (Patch 2026-05-19, no-termination mode):
 * When classifyLead throws, return a safe default. Title-aware where
 * possible: detects CEO/CFO/Founder titles → CXO_SHORT; explicit HR/
 * Recruiter → HR_PARTNERSHIP; everything else → STANDARD.
 */
function _defaultClassificationForLead(lead) {
  var title = ((lead && lead.designation) || (lead && lead.headline) || '').toLowerCase();
  var template = 'STANDARD';
  var archetype = 'MID_MANAGEMENT';
  if (/(\bceo\b|\bcfo\b|\bcoo\b|\bcto\b|\bchief\s+\w+\s+officer\b|managing\s+director|founder|president)/i.test(title)) {
    template = 'CXO_SHORT';
    archetype = 'C_SUITE';
  } else if (/(recruit|talent\s+acq|hr\s+|human\s+resources|people\s+team)/i.test(title)) {
    template = 'HR_PARTNERSHIP';
    archetype = 'HR_RECRUITER';
  }
  return {
    template: template,
    archetype: archetype,
    seniority: archetype,
    industry: (lead && lead.industry) || '',
    approach: 'professional, peer-to-peer',
    reasoning: 'default_classification_due_to_classifier_failure'
  };
}

/**
 * SYNTHESIZE MINIMAL EMAIL (Patch 2026-05-19, no-termination mode):
 * Final fallback when composeEmail returns success=false OR throws AND
 * Tier 3 deterministic fallback ALSO fails. Produces a minimal-but-valid
 * email payload so the draft still gets created. The risk-header panel
 * injected later will warn the user this needs heavy editing.
 *
 * This is intentionally generic — the goal is "draft exists", not
 * "draft is good". The user reads the body header, knows it's a stub,
 * and either deletes the draft or rewrites it manually.
 */
function _synthesizeMinimalEmail(lead, classification) {
  var first = (lead && lead.firstName) || (lead && lead.fullName ? lead.fullName.split(' ')[0] : 'there');
  var org = (lead && lead.organization) || 'your team';
  var role = (lead && lead.designation) || (lead && lead.headline) || 'your work';

  var subject = 'Note from Gaurav Rathore - 4.5+ years operating reality at ' + org;
  var bodyHtml =
    '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#222;">' +
    '<p>Hi ' + first + ',</p>' +
    '<p>Brief note: I have been following work at ' + org +
    ' and wanted to reach out. With 4.5+ years across ed-tech and quick-commerce - ' +
    'including 0-to-1 referral funnel scaling at upGrad (Rs 15 Cr in 4 months) and ' +
    'station P&L across ~50 cloud kitchens at Blinkit Bistro - I think there may be ' +
    'a useful overlap with what your team is building.</p>' +
    '<p>Would 15 minutes work to compare notes?</p>' +
    '<p>Thanks and regards,<br/><strong>Gaurav Rathore</strong><br/>' +
    'ex-Great Learning | ex-upGrad | Blinkit Bistro | MBA, IIM Kozhikode<br/>' +
    '<a href="https://www.linkedin.com/in/gaurav1-grow-learn-together/">LinkedIn Profile</a></p>' +
    '</div>';

  return {
    success: true,
    subjectLine: subject,
    emailBody: bodyHtml,
    parsed: {
      subjectLine: subject,
      greeting: 'Hi ' + first + ',',
      hookParagraph: 'Synthesized minimal hook — compose layer was unavailable for this run.',
      motivationParagraph: 'Pulled from canonical credentials.',
      bridgeSentence: '',
      experienceBullets: [],
      closingLogistics: 'Would 15 minutes work to compare notes?',
      closingResume: '',
      psLine: '',
      signoffText: 'Thanks and regards',
      tier: 'TIER_4_SYNTHESIZED'
    },
    qualityNotes: 'TIER 4 SYNTHESIZED FALLBACK - composeEmail unavailable. Draft minimal-but-valid; user must rewrite manually before sending.',
    tier: 'TIER_4_SYNTHESIZED'
  };
}

// ─── MAIN BATCH PROCESSOR ──────────────────────────────────

/**
 * Processes the next batch of NEW leads through the full pipeline.
 * Each lead goes: Research → Classify → Resume Select → Compose → Humanize → Quality Gate → Draft
 * @param {boolean} [force] - Skip timing checks
 */
function processNextBatch(force) {
  // Phase 3: lock acquisition migrated to _svc('Lock') for mockability.
  // The GAS script lock is still script-wide (single primitive); the
  // `lockKey` recorded below is a SEMANTIC label written to ScriptProperties
  // for diagnostic observability (test: leaduid_lock_keyed_on_uid_prevents_collision).
  //
  // Composite key format `row:<n>:uid:<u>` mixes both stable (uid) and
  // ephemeral (row) identifiers. New code records both; old code only
  // records `row:<n>`. Cross-version observability through this string.
  // Real per-identity correctness comes from verifyUid in updateLeadFields,
  // NOT from a new lock primitive (GAS LockService has no named locks).
  var lockService = (typeof _svc === 'function') ? _svc('Lock') : LockService;
  var lock = lockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    Logger.log('BatchProcessor: Could not acquire lock. Another batch is running.');
    return;
  }
  // Diagnostic: stamp who's currently holding (no race — we hold the lock).
  try {
    var props = (typeof _svc === 'function') ? _svc('Properties') : PropertiesService.getScriptProperties();
    props.setProperty('_BATCH_LOCK_OWNER', 'batch:' + new Date().toISOString());
  } catch (_) {}

  var startTime = new Date().getTime();

  try {
    // Start pipeline run tracking
    startPipelineRun('BATCH');

    // Check timing (unless forced)
    if (!force) {
      var timing = checkSendTiming();
      if (!timing.isGood) {
        Logger.log('BatchProcessor: Skipping — ' + timing.note);
        endPipelineRun();
        lock.releaseLock();
        return;
      }
    }

    // Get next batch
    var leads = getNextBatch(CONFIG.BATCH_SIZE, STATUS.NEW);

    if (leads.length === 0) {
      Logger.log('BatchProcessor: No NEW leads to process.');
      endPipelineRun();
      lock.releaseLock();
      _cleanupBatchTrigger();
      return;
    }

    Logger.log('BatchProcessor: Processing batch of ' + leads.length + ' leads');

    var processed = 0;
    var errors = 0;

    for (var i = 0; i < leads.length; i++) {
      // Time check — stop if approaching limit
      var elapsed = new Date().getTime() - startTime;
      if (elapsed > CONFIG.MAX_RUNTIME_MS) {
        Logger.log('BatchProcessor: Time limit approaching (' + elapsed + 'ms). Processed ' + processed + '/' + leads.length);
        break;
      }

      var lead = leads[i];
      try {
        _processOneLead(lead);
        processed++;
        // Increment lead count after successful processing
        _PIPELINE_RUN.leadCount++;
      } catch (e) {
        errors++;
        logPipelineEvent(lead.rowNum, 'BATCH', 'Lead processing failed: ' + e.message, 'ERROR');
        // PATCH Phase 5.2a Bug #5 FIX (per Inventory §7 #5): initialize the
        // `errRetry:0/2` token alongside STATUS=ERROR so Loop B's auto-recover
        // whitelist respects the bounded-retry contract. Without this init,
        // an ERROR row had no retry counter; Loop B's parse at line 1968 fell
        // through to "yes, pick up" causing potential infinite re-process
        // (bounded by 2-min dedupe but still wasteful + creates duplicate drafts).
        //
        // Loop B's logic at line 2049+ will INCREMENT this counter on
        // subsequent error retries, hitting STATUS=ERROR (permanent) once N=M.
        // PATCH 2026-06-12-errretry-preserve: compose via the seed-or-preserve
        // helper — the hardcoded seed here rewrote NOTES wholesale and reset a
        // scanner-bumped errRetry:N/M back to 0/2 every failing cycle, so the
        // budget plateaued at 1/2 and never exhausted.
        _uf(lead,{
          STATUS: STATUS.ERROR,
          NOTES: _seedOrPreserveErrRetry(lead.notes, 'Pipeline error: ' + e.message + ' |', 'errRetry:0/2')
        });
      }
    }

    Logger.log('BatchProcessor: Batch complete. Processed: ' + processed + ', Errors: ' + errors);

    // Check if more leads remain
    var remaining = getNextBatch(1, STATUS.NEW);
    if (remaining.length > 0) {
      _scheduleBatchTrigger();
      Logger.log('BatchProcessor: More leads remain. Next batch scheduled.');
    } else {
      _cleanupBatchTrigger();
      Logger.log('BatchProcessor: All leads processed. Trigger cleaned up.');
    }

  } catch (e) {
    Logger.log('BatchProcessor: Fatal error: ' + e.message);
  } finally {
    endPipelineRun();
    lock.releaseLock();
  }
}

// ─── SINGLE LEAD PIPELINE ─────────────────────────────────

/**
 * PATCH 2026-06-12-recomp-bullets: format guard for the two recomposition
 * score-comparison sites inside _processOneLead. A recomposition candidate may
 * replace the original draft only if it does not DOWNGRADE the body
 * architecture: when the original carries the bullet-table markup of the
 * unified BULLET_V1 template, a candidate without it is a prose-shaped
 * regression and must lose the comparison regardless of score.
 *
 * Detection token: the experience-bullet glyph cell ('width:28px') is emitted
 * ONLY by the bullet renderers (_buildHtmlEmailBulletV1 + the Tier-3 bullet
 * variants) — never by the legacy prose renderer and never by the banner
 * (which uses other widths). Same fingerprint DraftAudit.gs counts and the
 * template_unify render-contract test pins. Pure + deterministic so the
 * pinned regression test can exercise it directly against real renderer
 * output.
 *
 * @param {string} originalHtml  - body HTML of the email being defended
 * @param {string} candidateHtml - body HTML of the recomposition candidate
 * @returns {boolean} true when the candidate may participate in the score
 *                    comparison; false when it must forfeit (prose downgrade)
 */
function _recompFormatGuard(originalHtml, candidateHtml) {
  var orig = (originalHtml === null || originalHtml === undefined) ? '' : String(originalHtml);
  var cand = (candidateHtml === null || candidateHtml === undefined) ? '' : String(candidateHtml);
  var token = 'width:28px';
  if (orig.indexOf(token) >= 0 && cand.indexOf(token) < 0) return false;
  return true;
}

/**
 * Processes one lead through all pipeline stages.
 * @param {Object} lead - LeadProfile
 */
// ─── PATCH 2026-06-17-employer-reconcile ─────────────────────────────────────
// 2nd-order data-correctness fix (live incident: lead "Samarth Masson", row 331).
// The APK captures the CURRENT role into LinkedIn's curated `headline`
// ("GTM (...) at Anthropic") but its designation/organization/email extraction
// grabbed a PAST experience entry (Amazon/AWS, samarmas@amazon.com). The pipeline
// trusted org/email blindly → wrong domain for email-finding, wrong org-gate,
// wrong draft positioning. Principle: the headline is the most reliable CURRENT
// employer signal (people curate it); experience-derived "current org" can be
// stale/mis-ordered. When the headline names a clear company that CONFLICTS with
// the extracted org, the headline wins — and the stale designation + old-company
// email are dropped so the whole identity stays consistent with the real employer.
// Conservative: only fires on an UNAMBIGUOUS "at <Co>" / "@<Co>" with zero token
// overlap with org (excludes ex-/former/previously). Logged. Kill-switch:
// ScriptProperty EMPLOYER_RECONCILE_ENABLED=0.

function _employerReconcileEnabled_() {
  try {
    return PropertiesService.getScriptProperties().getProperty('EMPLOYER_RECONCILE_ENABLED') !== '0';
  } catch (_) { return true; }  // default ON; fail-open
}

// Pure: extract a high-confidence CURRENT company from a LinkedIn headline, or ''.
function _extractHeadlineCurrentCompany(headline) {
  var h = (headline || '').toString().trim();
  if (!h) return '';
  var STOP = { 'scale':1,'heart':1,'home':1,'work':1,'large':1,'once':1,'last':1,
               'least':1,'best':1,'all':1,'speed':1,'hand':1,'times':1,'present':1,
               'core':1,'a':1,'the':1,'my':1,'your':1,'it':1,'scale.':1 };
  function clean(seg) {
    seg = (seg || '').replace(/^[\s:>\-–—]+/, '');
    var cut = seg.search(/[|•·;,\/()]|\s[-–—]\s/);   // stop at first hard delimiter
    if (cut >= 0) seg = seg.substring(0, cut);
    return seg.replace(/[\s.,;:!]+$/, '').trim();
  }
  function valid(co) {
    if (!co || co.length < 2 || co.length > 40) return false;
    if (!/[A-Z]/.test(co)) return false;              // proper noun / acronym must have a capital
    if (STOP[co.toLowerCase()]) return false;
    return true;
  }
  // PRIMARY: the LAST " at <Company>" not preceded by a past-role marker = current.
  var atRe = /\bat\s+/gi, m, best = '';
  while ((m = atRe.exec(h)) !== null) {
    var pre = h.substring(Math.max(0, m.index - 14), m.index).toLowerCase();
    if (/(ex[-\s]|formerly|former|previously|previous|prev\b|was\b)\s*$/.test(pre)) continue;
    var cand = clean(h.substring(m.index + m[0].length));
    if (valid(cand)) best = cand;                     // keep last valid → most current
  }
  if (best) return best;
  // SECONDARY: "@<Company>" (e.g. "Category Leader @Anthropic").
  var at = h.match(/@\s*([A-Za-z][A-Za-z0-9&.\- ]{1,39})/);
  if (at) { var c2 = clean(at[1]); if (valid(c2)) return c2; }
  return '';
}

// Pure: normalize a company name for comparison (strip suffixes/punct/parens).
function _normCompanyName(s) {
  return (s || '').toString().toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|technologies|technology|labs|web services|pvt|private|the)\b/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Pure: true when headlineCo and org are clearly DIFFERENT companies.
function _companiesConflict(headlineCo, org) {
  var a = _normCompanyName(headlineCo), b = _normCompanyName(org);
  if (!a || !b || a === b) return false;
  if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return false;   // one contains the other
  var at = {}; a.split(' ').forEach(function(t){ if (t.length >= 4) at[t] = 1; });
  var shared = b.split(' ').some(function(t){ return t.length >= 4 && at[t]; });
  return !shared;                                              // no shared significant token → conflict
}

// Mutates lead.organization / lead.designation / lead.email on a confident conflict.
// Returns an audit object describing what (if anything) was corrected.
function _reconcileCurrentEmployer(lead) {
  var out = { corrected: false, oldOrg: (lead && lead.organization) || '', newOrg: '',
              headlineCompany: '', clearedEmail: false, clearedDesignation: false, reason: '' };
  if (!lead) return out;
  var hc = _extractHeadlineCurrentCompany(lead.headline);
  out.headlineCompany = hc;
  if (!hc || !_companiesConflict(hc, lead.organization)) return out;

  var oldOrg = lead.organization || '';
  lead.organization = hc;
  out.newOrg = hc;
  out.corrected = true;

  // Stale designation belonged to the wrong employer → drop it so the composer
  // falls back to the (current) headline as the role descriptor.
  if (lead.designation) { lead.designation = ''; out.clearedDesignation = true; }

  // Stale email: clear ONLY if its domain belongs to the OLD employer (wrong-company
  // address). A personal/freemail address is left intact for the waterfall to judge.
  var email = (lead.email || '').toString(), at = email.indexOf('@');
  if (at > 0) {
    var domainCore = email.substring(at + 1).toLowerCase().split('.')[0];
    var oldOk = _normCompanyName(oldOrg).split(' ').some(function(t){ return t.length >= 4 && domainCore.indexOf(t) >= 0; });
    if (oldOk) { lead.email = ''; out.clearedEmail = true; }
  }
  out.reason = 'headline current employer "' + hc + '" conflicts with captured org "' + oldOrg +
               '"; org corrected' + (out.clearedDesignation ? ', stale designation cleared' : '') +
               (out.clearedEmail ? ', stale ' + oldOrg + ' email cleared' : '') + '.';
  return out;
}

function _processOneLead(lead) {
  // ── SHEET-TRUTH HYDRATION (2026-06-12-sheet-truth) ─────────────────────────
  // Scanner.gs builds a MINIMAL lead object {rowNum, linkedinUrl, leadUid,
  // fullName, notes} — it does NOT populate lead.email (col F), lead.organization,
  // lead.designation, lead.headline, lead.firstName, lead.lastName. Without this
  // hydration step, the S1 SHEET_EMAIL_PRECEDENCE block in finalizeEmailSelection
  // would always see lead.email=undefined and skip the col-F authoritative path.
  // Fix: if lead.email AND lead.organization are both absent, load the full row
  // via getLeadByRow so all downstream stages (enricher, finalizer, researcher,
  // composer) see the correct sheet truth values.
  // Guard: only fire when key fields are missing AND rowNum is present (avoids
  // re-firing for the old BatchProcessor path which already calls getLeadByRow).
  // PATCH 2026-06-12-dispatch-truth: the scanner now builds the dispatch lead
  // from the full in-memory row snapshot, so this guard normally no-ops and
  // remains purely as defense-in-depth for any future minimal-lead caller.
  if (lead && lead.rowNum && lead.rowNum >= 2 &&
      !lead.email && !lead.organization &&
      typeof getLeadByRow === 'function') {
    try {
      var _fullLead = getLeadByRow(lead.rowNum);
      if (_fullLead) {
        // Merge all fields from the full profile onto the minimal lead object.
        // Preserve rowNum, linkedinUrl, leadUid, fullName, notes from the scanner
        // object (they are already correct); fill in everything else.
        var _preserveKeys = { rowNum: 1, linkedinUrl: 1, leadUid: 1, notes: 1 };
        for (var _k in _fullLead) {
          if (!_preserveKeys[_k] || !lead[_k]) {
            lead[_k] = _fullLead[_k];
          }
        }
        Logger.log('[BatchProcessor] SHEET_TRUTH_HYDRATE row=' + lead.rowNum +
                   ' email="' + (lead.email||'') + '" org="' + (lead.organization||'') + '"');
      }
    } catch (_hydrErr) {
      Logger.log('[BatchProcessor] SHEET_TRUTH_HYDRATE failed (non-fatal): ' + _hydrErr.message);
    }
  }
  // ── END SHEET-TRUTH HYDRATION ─────────────────────────────────────────────

  // ── EMPLOYER RECONCILIATION (2026-06-17-employer-reconcile) ───────────────
  // Correct a stale current-employer mismatch (headline = current truth) BEFORE
  // email-finding / org-gate / composition consume lead.organization. Fixes the
  // class of bug where the APK captured a PAST experience entry as the current
  // org (live: "Samarth Masson" — headline Anthropic, captured org Amazon/AWS,
  // email samarmas@amazon.com). See _reconcileCurrentEmployer. Conservative +
  // logged; kill-switch ScriptProperty EMPLOYER_RECONCILE_ENABLED=0.
  if (_employerReconcileEnabled_() && typeof _reconcileCurrentEmployer === 'function') {
    try {
      // Defensive: ensure the headline is present (older minimal-lead callers may
      // omit it) — the reconciliation is a no-op without it.
      if (lead && !lead.headline && lead.rowNum && lead.rowNum >= 2 && typeof getLeadByRow === 'function') {
        var _hl = getLeadByRow(lead.rowNum);
        if (_hl && _hl.headline) lead.headline = _hl.headline;
      }
      var _emp = _reconcileCurrentEmployer(lead);
      if (_emp.corrected) {
        Logger.log('[BatchProcessor] EMPLOYER_RECONCILE row=' + (lead.rowNum || '?') + ' — ' + _emp.reason);
        lead.notes = ((lead.notes || '') + ' [EMPLOYER_RECONCILED] ' + _emp.oldOrg + '→' + _emp.newOrg).trim();
      }
    } catch (_empErr) {
      Logger.log('[BatchProcessor] EMPLOYER_RECONCILE failed (non-fatal): ' + _empErr.message);
    }
  }

  // ── PATCH `-p5-latency-instrument` (Phase 2a): per-stage timers ──
  // Zero behavior change. Emits [LATENCY row=N stage=NAME ms=X] per stage.
  // Pairs with GmailDrafter's draft_* stage timers for end-to-end view.
  var __t0 = Date.now();
  var __tPrev = __t0;
  function __lat(stage) {
    var dt = Date.now() - __tPrev;
    Logger.log('[LATENCY row=' + ((lead && lead.rowNum) || '?') + ' stage=' + stage + ' ms=' + dt + ']');
    __tPrev = Date.now();
    return dt;
  }

  Logger.log('Processing lead: ' + lead.fullName + ' (Row ' + lead.rowNum + ')');

  // ── PATCH `-p5-composer-preflight` (Phase 2b L1): pre-Claude quota guard ──
  //
  // Root cause this fixes: when daily Gmail draft quota is exhausted,
  // `createDraft` returns `{ success: false }` after the FULL pipeline has
  // run (enrich + research + classify + Claude compose + humanize). The
  // terminal STATUS=DRAFT_CREATED write at line ~1209 is gated by
  // `if (draftResult.success)`, so it never fires. The row stays at the
  // last intermediate STATUS the pipeline wrote (typically COMPOSING).
  // COMPOSING IS in the `isStuckAutoRecover` whitelist (line ~2009) per
  // the no-termination-mode patch (2026-05-19), so the scanner re-picks
  // the row on the next cron, burns ~5K Claude tokens again, fails
  // silently again, ad infinitum.
  //
  // The fix: check daily quota BEFORE any Gemini/Claude call. If exhausted,
  // park the row at STATUS=PENDING_QUOTA_RESET (in whitelist with L1
  // re-gating tomorrow) and return. Zero token spend per parked lead.
  // Estimated saving: 95%+ of Claude/Gemini tokens when quota is hit.
  if (typeof _checkDailyDraftLimit === 'function') {
    var __p2bQuota = null;
    try { __p2bQuota = _checkDailyDraftLimit(); }
    catch (__qErr) {
      Logger.log('[Phase2b/L1] _checkDailyDraftLimit threw — failing open (pipeline proceeds): ' + __qErr.message);
    }
    if (__p2bQuota && __p2bQuota.exceeded) {
      // PATCH `-eq3-logfix`: distinguish the TWO trip causes so the log is not
      // misleading. The counter (count/limit) and the Gmail-side flag are
      // independent triggers — printing "(0/100)" when the real blocker is the
      // Gmail flag caused a "why is it exhausted at 0/100?" diagnosis dead-end.
      var __p2bCause = __p2bQuota.gmailFlagSet
        ? ('GMAIL-SIDE FLAG SET (counter is only ' + __p2bQuota.count + '/' + __p2bQuota.limit +
           ' — the real blocker is Gmail itself refusing drafts: "' +
           (__p2bQuota.message || 'GMAIL_QUOTA_EXHAUSTED flag') + '"). This is Gmail\'s own ' +
           'rolling 24h send/draft limit, NOT our counter. Clear via menuClearGmailQuotaFlag ' +
           'once Gmail recovers.')
        : ('DAILY COUNTER reached (' + __p2bQuota.count + '/' + __p2bQuota.limit +
           ' — our own per-day cap; resets at script-TZ midnight).');
      Logger.log('[Phase2b/L1] Draft quota guard tripped — ' + __p2bCause +
                 ' SKIPPING Claude/Gemini calls for row ' + lead.rowNum +
                 ' (' + (lead.fullName || 'unknown') + '). STATUS -> PENDING_QUOTA_RESET. ' +
                 'Lead re-evaluated on the next cron tick once the block clears.');
      try {
        var __p2bOpts = (lead.linkedinUrl)
          ? { verifyUrl: lead.linkedinUrl, verifyUid: lead.leadUid }
          : undefined;
        updateLeadFields(lead.rowNum, { STATUS: STATUS.PENDING_QUOTA_RESET }, __p2bOpts);
      } catch (__sErr) {
        Logger.log('[Phase2b/L1] STATUS write failed (non-blocking, row may reprocess): ' + __sErr.message);
      }
      Logger.log('[LATENCY row=' + ((lead && lead.rowNum) || '?') +
                 ' stage=lead_TOTAL_QUOTA_GUARD ms=' + (Date.now() - __t0) + ']');
      return;
    }
  }

  // ── PATCH `-p5-vendorresilience-gemini` (Phase 2c L1.5): Gemini-backoff guard ──
  //
  // Sibling to L1 (Gmail quota). If the Gemini circuit breaker is active
  // (set by `_setGeminiBackoff` in ApiClients.gs when a 429 fires), every
  // Gemini call this lead would make returns `{ success: false, error: 'GEMINI_BACKED_OFF' }`
  // immediately. The pipeline could still run end-to-end with degraded
  // data, but stage4_compose would then invoke Claude on garbage research —
  // burning ~5K Claude tokens to produce a draft based on empty enrichment.
  //
  // Park the lead at PENDING_GEMINI_BACKOFF instead. The scanner whitelist
  // includes this state, so the next cron re-picks it. By then either:
  //   - the 30s backoff has expired (L1.5 passes, pipeline runs normally)
  //   - 429 is still firing (L1.5 trips again, lead stays parked)
  //
  // Zero token spend per parked lead. Net effect: token waste during a
  // Gemini rate-limit storm drops from "~5K Claude/lead" to "~0".
  if (typeof _geminiBackoffCheck === 'function') {
    var __p2cBackoff = null;
    try { __p2cBackoff = _geminiBackoffCheck(); }
    catch (__bErr) {
      Logger.log('[Phase2c/L1.5] _geminiBackoffCheck threw — failing open: ' + __bErr.message);
    }
    if (__p2cBackoff && __p2cBackoff.active) {
      Logger.log('[Phase2c/L1.5] Gemini circuit breaker ACTIVE for ' + __p2cBackoff.remainingMs +
                 'ms (until ' + __p2cBackoff.untilISO + '). SKIPPING all Gemini/Claude calls for row ' +
                 lead.rowNum + ' (' + (lead.fullName || 'unknown') +
                 '). STATUS -> PENDING_GEMINI_BACKOFF. Next cron will retry after backoff expires.');
      try {
        var __p2cOpts = (lead.linkedinUrl)
          ? { verifyUrl: lead.linkedinUrl, verifyUid: lead.leadUid }
          : undefined;
        updateLeadFields(lead.rowNum, { STATUS: STATUS.PENDING_GEMINI_BACKOFF }, __p2cOpts);
      } catch (__bsErr) {
        Logger.log('[Phase2c/L1.5] STATUS write failed (non-blocking): ' + __bsErr.message);
      }
      Logger.log('[LATENCY row=' + ((lead && lead.rowNum) || '?') +
                 ' stage=lead_TOTAL_GEMINI_BACKOFF ms=' + (Date.now() - __t0) + ']');
      return;
    }
  }

  // ── PATCH `-p5-composer-preflight` (Phase 2b L2): DRAFT_CREATED idempotency ──
  //
  // Defense-in-depth for the case where a row with STATUS=DRAFT_CREATED ends
  // up in the candidate pool (shouldn't happen under current whitelist, but
  // a future patch or manual user action could). If the row already has a
  // draft ID and DRAFT_CREATED status, return without burning tokens.
  if (lead.status === STATUS.DRAFT_CREATED && lead.draftId) {
    Logger.log('[Phase2b/L2] Row ' + lead.rowNum + ' (' + (lead.fullName || 'unknown') +
               ') is already DRAFT_CREATED with draftId=' + lead.draftId +
               '. Skipping — no Claude/Gemini spend, no overwrite.');
    Logger.log('[LATENCY row=' + ((lead && lead.rowNum) || '?') +
               ' stage=lead_TOTAL_IDEMPOTENT ms=' + (Date.now() - __t0) + ']');
    return;
  }

  // ── PATCH `-p5-composer-preflight` (Phase 2b L3): track real outcome ──
  // Used by the completion log at the bottom to surface the actual status,
  // not the previously-hardcoded "DRAFT_CREATED". Updated when createDraft
  // returns success or when a deterministic path lands.
  var __p2bDraftOutcome = 'UNKNOWN_NO_DRAFT_ATTEMPTED';

  // Phase 3 (LEAD_UID): ensure the lead has a stable UID. Three paths:
  //   1. Sheet2 col 28 (LEAD_UID) already populated → use it
  //   2. Empty Sheet2 UID; matching Sheet1 row found → copy from Sheet1
  //   3. No Sheet1 match (legacy or orphan) → generate fresh UUID
  // Once assigned, the UID is written to col 28 + becomes lead.leadUid for
  // every downstream call (NOTES tag, verifyUid, audit log).
  if (!lead.leadUid) {
    lead.leadUid = _ensureLeadUid(lead);
  }
  // Composite diagnostic key — recorded for observability across versions.
  // GAS LockService has no named-lock primitive; the real per-identity
  // protection is verifyUid in updateLeadFields (Phase 3.5).
  var lockKey = 'row:' + lead.rowNum + ':uid:' + (lead.leadUid || 'NONE');
  try {
    var pps = (typeof _svc === 'function') ? _svc('Properties') : PropertiesService.getScriptProperties();
    pps.setProperty('_ACTIVE_LEAD_LOCK_KEY', lockKey);
  } catch (_) {}

  // PATCH 2026-05-13 (AUDIT F9 / R3): close the 5-s race window where a
  // concurrent observer (safety-net cron, onSheetEdit, onChange, manual
  // menuProcessCurrentRow) could see STATUS still NEW and re-invoke
  // _processOneLead on the same row, producing duplicate Gmail drafts.
  //
  // The first sheet write inside this function used to be the enrichment
  // result at line ~151 (col X only; status unchanged). For the ~5 seconds
  // it takes the enricher to complete, the row remained at STATUS=NEW and
  // was visible to every scanner.
  //
  // Setting STATUS=RESEARCHING as the FIRST write moves the row out of the
  // NEW pool immediately. The scanner whitelist (NEW / empty /
  // REOON_RETRY_PENDING) skips RESEARCHING. Per AUDIT m1, RESEARCHING was
  // a phantom status before — now it has a real writer.
  //
  // Note: every error path below already writes STATUS=ERROR/REVIEW/etc.,
  // and the success path writes RESEARCH_DONE → REVIEW → DRAFT_CREATED.
  // So RESEARCHING is always overwritten on completion; it never leaks.
  // The only way to leak HUMANIZING-style is GAS execution timeout — for
  // that, AUDIT M3 (time-budget) is the orthogonal fix.
  try {
    _uf(lead,{ STATUS: STATUS.RESEARCHING });
  } catch (markErr) {
    Logger.log('[BatchProcessor] Could not mark row RESEARCHING (continuing): ' + markErr.message);
  }

  // ── Stage 0: Input Validation & Email Enrichment ──
  //
  // PATCH 2026-05-19 (no-termination mode): when both name AND org are
  // missing, the pipeline previously parked at NEEDS_EMAIL_REVIEW awaiting
  // human edit. New behaviour: attempt recovery via URL slug + URL fragment
  // hint + Apollo /people/match. If recovery succeeds, mutate lead in place
  // and continue. If recovery still fails, continue ANYWAY with placeholder
  // values so the pipeline produces a draft (with risk header).
  if (!lead.fullName && !lead.organization) {
    Logger.log('[BatchProcessor] Row ' + lead.rowNum + ': both fullName + org missing — attempting URL-based recovery');
    var recovered = _recoverIdentityFromUrl(lead);
    if (recovered.fullName) lead.fullName = recovered.fullName;
    if (recovered.firstName && !lead.firstName) lead.firstName = recovered.firstName;
    if (recovered.lastName && !lead.lastName) lead.lastName = recovered.lastName;
    if (recovered.organization) lead.organization = recovered.organization;
    if (recovered.designation && !lead.designation) lead.designation = recovered.designation;

    // Persist recovered values back to sheet so subsequent reads see them
    var persistUpdates = {};
    if (recovered.organization) persistUpdates.ORGANIZATION = recovered.organization;
    if (recovered.designation && !lead.designation) persistUpdates.DESIGNATION = recovered.designation;
    if (Object.keys(persistUpdates).length > 0) {
      persistUpdates.NOTES = 'IDENTITY RECOVERY (no-termination mode): both Full_Name + Organization were blank; ' +
                             'recovered ' + Object.keys(recovered).filter(function(k){return !!recovered[k];}).join(',') +
                             ' via ' + (recovered.source || 'URL_fallback') + '. Pipeline continues.';
      try { _uf(lead, persistUpdates); } catch (_) {}
    }

    // Even after recovery, if we STILL have nothing, fall back to safe defaults.
    // The downstream stages tolerate missing fields (greeting falls back to
    // "Hi there,", compose uses placeholder context). Finalizer will pick a
    // last-resort placeholder email and the draft will carry a strong warning.
    if (!lead.fullName) {
      lead.fullName = recovered.fullNameFallback || 'there';
      lead.firstName = recovered.firstNameFallback || 'there';
    }
    if (!lead.organization) {
      lead.organization = recovered.organizationFallback || 'their company';
    }
    logPipelineEvent(lead.rowNum, 'ENRICH',
      'IDENTITY_RECOVERY: name=' + lead.fullName + ', org=' + lead.organization +
      ' (source=' + (recovered.source || 'placeholders') + ')', 'WARN');
  }
  if (!lead.fullName) {
    Logger.log('[BatchProcessor] Row ' + lead.rowNum + ': fullName missing/invalid. Will use "Hi Team ' + lead.organization + '," fallback for greeting.');
    // Tag a note so the user can spot it in the sheet
    _uf(lead,{
      NOTES: 'Note: Full_Name column was empty or failed validation (digits/phone/junk). Pipeline used team-style greeting.'
    });
  }
  if (!lead.organization) {
    Logger.log('[BatchProcessor] Row ' + lead.rowNum + ': No organization found in column E. Research quality may be limited.');
  }

  // ── PATCH 2026-05-19 (Ranjan/HSBC RCA): Org repair against title-noise ──
  // Some leads land in Sheet2 with the ORGANIZATION column holding a TITLE
  // fragment (e.g. "Chief of Staff - India") instead of a company name —
  // an extraction-time data-mapping bug from the LinkedIn extension/APK
  // share path. Without repair, enrichEmail tries to resolve the title as
  // a company, all paths fail, and the row dies at NEEDS_EMAIL forever.
  //
  // repairLeadOrgIfTitleNoise runs two recovery paths in order:
  //   (A) URL fragment hint -> Apollo /organizations/search
  //   (B) Apollo /people/match by LinkedIn URL directly
  // Mutates lead.organization in place AND persists the corrected value
  // back to the sheet, so subsequent runs (and human readers) see the fix.
  if (typeof repairLeadOrgIfTitleNoise === 'function') {
    try {
      var orgRepair = repairLeadOrgIfTitleNoise(lead);
      if (orgRepair && orgRepair.repaired) {
        logPipelineEvent(lead.rowNum, 'ENRICH',
          'OrgRepair: "' + orgRepair.oldOrg + '" -> "' + orgRepair.newOrg +
          '" via ' + orgRepair.source + (orgRepair.hint ? ' (hint="' + orgRepair.hint + '")' : ''),
          'INFO');
      }
    } catch (orgRepairErr) {
      Logger.log('[BatchProcessor] OrgRepair threw (non-fatal): ' + orgRepairErr.message);
    }
  }

  // Email enrichment gate: classify free vs. corporate, verify MX, guess patterns if missing.
  // Routes low-confidence / missing emails to NEEDS_EMAIL_REVIEW (human pick) or NEEDS_EMAIL (dead end)
  // instead of letting them pollute the pipeline with guaranteed bounces.
  try {
    var enrichment = (typeof enrichEmail === 'function') ? enrichEmail(lead) : { status: 'VERIFIED', email: lead.email, classification: 'CORPORATE', source: 'INPUT' };
    logPipelineEvent(lead.rowNum, 'ENRICH', 'status=' + enrichment.status + ' class=' + (enrichment.classification || '-') + ' src=' + (enrichment.source || '-') + (enrichment.reason ? ' reason=' + enrichment.reason : ''));

    // Persist enrichment results (cols X–Z) when we have useful data
    var enrichUpdates = {};
    if (enrichment.email)  enrichUpdates.ENRICHED_EMAIL = enrichment.email;
    if (enrichment.source) enrichUpdates.EMAIL_SOURCE   = enrichment.source;
    if (typeof enrichment.confidence === 'number') enrichUpdates.EMAIL_CONFIDENCE = enrichment.confidence.toFixed(2);
    if (Object.keys(enrichUpdates).length) _uf(lead,enrichUpdates);

    // Mirror confidence onto the lead so downstream stages (composition, draft) see it
    if (typeof enrichment.confidence === 'number') lead.emailConfidence = enrichment.confidence;
    if (enrichment.reoonStatus) lead.reoonStatus = enrichment.reoonStatus;

    // PATCH 2026-05-17: backfill organization + designation from Apollo
    // /people/match when Sheet2 columns were blank (typical when APK Vision
    // failed and the lead arrived URL-only — e.g., Jaspreetsidhana, Rahat).
    // Apollo returns authoritative organizationName + title alongside the
    // verified email. Without this backfill, Stage 2 research has no
    // company context and produces a degraded dossier; with it, the pipeline
    // runs end-to-end as if the APK had extracted the data correctly.
    //
    // In-memory mutation only (Sheet1/Sheet2 col E is formula-driven from
    // Sheet1!F). The Apollo-derived org propagates through research →
    // classify → compose → draft. A NOTES annotation records the recovery.
    if (enrichment.apolloMatch) {
      var recoveredFields = [];
      if (!lead.organization && enrichment.apolloMatch.organizationName) {
        lead.organization = enrichment.apolloMatch.organizationName;
        recoveredFields.push('organization=' + lead.organization);
      }
      if (!lead.designation && enrichment.apolloMatch.title) {
        lead.designation = enrichment.apolloMatch.title;
        recoveredFields.push('designation=' + lead.designation);
      }
      // Also backfill firstName/lastName if we only had the URL-slug-decoded
      // fullName (which usually has no space — e.g., "Jaspreetsidhana"). Apollo
      // returns properly-cased name parts.
      if (enrichment.apolloMatch.fullName && (!lead.fullName || lead.fullName.indexOf(' ') < 0)) {
        lead.fullName = enrichment.apolloMatch.fullName;
        var nameParts = lead.fullName.split(' ');
        lead.firstName = nameParts[0] || lead.firstName || '';
        lead.lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : (lead.lastName || '');
        recoveredFields.push('fullName=' + lead.fullName);
      }
      if (recoveredFields.length > 0) {
        Logger.log('[BatchProcessor] Row ' + lead.rowNum + ' — recovered from Apollo: ' + recoveredFields.join(', '));
        logPipelineEvent(lead.rowNum, 'ENRICH',
          'Apollo-recovered: ' + recoveredFields.join(', '), 'INFO');
        // Best-effort NOTES annotation so the user sees the recovery in the sheet
        try {
          _uf(lead,{
            NOTES: 'Apollo-recovered fields (' + recoveredFields.join(', ') +
                   ') — Sheet1 still shows blank from APK extraction; pipeline used Apollo data.'
          });
        } catch (_) {}
      }
    }

    // PATCH 2026-05-17 (Tier-recovery layer 3): if the cascade exited at
    // 'no_org_to_guess_from' (Apollo missed + lead.organization blank +
    // lead.email blank — typical URL-only lead from broken APK Vision),
    // try one Gemini grounded-search call to recover the org from public
    // web data, then re-run enrichment with the recovered org as input.
    //
    // Why this is safe:
    //   - Only fires when enrichment ALREADY exited with no_org_to_guess_from
    //   - Single grounded call (~$0.0001, ~10-20s latency)
    //   - Recovered fields are clearly annotated in NOTES as "web-search-derived"
    //   - Pipeline still routes to NEEDS_EMAIL_REVIEW if downstream verification
    //     can't confirm email — user always reviews before send
    //
    // Why this beats current behavior:
    //   - Without it: every Apollo-missed URL-only lead lands at NEEDS_EMAIL
    //     forever until manual org paste
    //   - With it: Gemini recovers org from public LinkedIn snippets / news
    //     → cascade gets a domain → pattern-guesses email → Reoon verifies
    //     → draft created (Tier 1 or Tier 3 depending on Claude health)
    if (enrichment.status === 'NEEDS_EMAIL' && enrichment.reason === 'no_org_to_guess_from'
        && lead.linkedinUrl && /linkedin\.com\/in\//i.test(lead.linkedinUrl)
        && typeof _recoverLeadFromLinkedInUrl === 'function') {
      try {
        Logger.log('[BatchProcessor] Row ' + lead.rowNum + ': no_org — trying Gemini-grounded URL→org recovery');
        var grounded = _recoverLeadFromLinkedInUrl(lead.linkedinUrl, lead.fullName);
        if (grounded && grounded.organization && grounded.organization.length > 1) {
          // Update lead in memory
          lead.organization = grounded.organization;
          if (!lead.designation && grounded.designation) lead.designation = grounded.designation;
          if (grounded.fullName && (!lead.fullName || lead.fullName.indexOf(' ') < 0)) {
            lead.fullName = grounded.fullName;
            var gp = grounded.fullName.split(' ');
            lead.firstName = gp[0] || lead.firstName || '';
            lead.lastName = gp.length > 1 ? gp.slice(1).join(' ') : (lead.lastName || '');
          }
          logPipelineEvent(lead.rowNum, 'ENRICH',
            'Gemini-grounded URL recovery: org=' + grounded.organization +
            ', conf=' + (grounded.confidence || 'unknown'), 'WARN');
          // Re-run enrichment with the recovered org
          var enrichment2 = enrichEmail(lead);
          logPipelineEvent(lead.rowNum, 'ENRICH',
            'Post-recovery: status=' + enrichment2.status + ' src=' + (enrichment2.source || '-'));
          if (enrichment2.email)  enrichUpdates.ENRICHED_EMAIL = enrichment2.email;
          if (enrichment2.source) enrichUpdates.EMAIL_SOURCE   = enrichment2.source;
          if (typeof enrichment2.confidence === 'number') enrichUpdates.EMAIL_CONFIDENCE = enrichment2.confidence.toFixed(2);
          if (Object.keys(enrichUpdates).length) _uf(lead,enrichUpdates);
          if (typeof enrichment2.confidence === 'number') lead.emailConfidence = enrichment2.confidence;
          if (enrichment2.reoonStatus) lead.reoonStatus = enrichment2.reoonStatus;
          // Annotate so user knows fields came from web-search, not authoritative
          _uf(lead,{
            NOTES: 'Gemini-grounded recovery (conf=' + (grounded.confidence || 'unknown') + '): ' +
                   'org=' + grounded.organization +
                   (grounded.designation ? ', role=' + grounded.designation : '') +
                   '. Web-search-derived — verify recipient details before send.'
          });
          // Re-throw the original enrichment outcome with new data
          enrichment = enrichment2;
        } else {
          Logger.log('[BatchProcessor] Row ' + lead.rowNum + ': Gemini-grounded returned no usable org');
        }
      } catch (groundErr) {
        Logger.log('[BatchProcessor] Gemini-grounded recovery threw (non-fatal): ' + groundErr.message);
      }
    }

    // ── PATCH 2026-05-19 (NO-TERMINATION MODE): finalizer-driven progression.
    //
    // User mandate: "I do not want any process termination or human/manual
    // intervention. For confidence score 0.30-0.55 and <0.30 make changes
    // and make it choose the most best and accurate email ID and continue
    // the process end to end on its own."
    //
    // Implementation: route the enrichment result through finalizeEmailSelection
    // which applies a 5-tier ladder and ALWAYS returns a usable email. The
    // tier label drives a risk-warning header injected into the draft body
    // when the user opens it in Gmail (verified tier: no header; lower tiers:
    // colored INTERNAL NOTE box at the top of the body).
    //
    //   Tier 0 verified         conf >= 0.55, selector winner, no risk header
    //   Tier 1 low_confidence   conf 0.30-0.55, selector winner, yellow header
    //   Tier 2 best_of_available conf <0.30 but candidates exist, heuristic pick, orange header
    //   Tier 3 constructed      no candidates, primitive construction, red header
    //   Tier 4 last_resort      no domain resolvable, .invalid placeholder, pink header
    //
    // ALL tiers proceed to research / compose / draft. STATUS will be
    // DRAFT_CREATED in every case.
    if (typeof finalizeEmailSelection === 'function') {
      var finalized = finalizeEmailSelection(lead, enrichment);
      // finalizeEmailSelection already mutated lead.email + lead.emailConfidence
      // + lead.selectionTier + lead.riskFlags. Persist to sheet.
      var finalizerNotes = 'FINALIZER tier=' + finalized.tier +
                           ' conf=' + finalized.confidence.toFixed(2) +
                           ' email=' + finalized.email +
                           ' source=' + finalized.source +
                           ' reasoning=' + finalized.reasoning;
      if (finalized.riskFlags && finalized.riskFlags.length > 0) {
        finalizerNotes += ' | risks=[' + finalized.riskFlags.join(',') + ']';
      }
      logPipelineEvent(lead.rowNum, 'ENRICH', finalizerNotes, finalized.tier === 'verified' ? 'INFO' : 'WARN');
      try {
        _uf(lead, {
          ENRICHED_EMAIL:   finalized.email,
          EMAIL_SOURCE:     finalized.source,
          EMAIL_CONFIDENCE: finalized.confidence.toFixed(2),
          NOTES: finalizerNotes
        });
      } catch (writeErr) {
        Logger.log('[BatchProcessor] Finalizer-result write failed: ' + writeErr.message);
      }
      // ORG_DOMAIN_GATE (2026-06-12-org-domain-gate): when all candidates were
      // rejected by the org-domain consistency gate, the finalizer returns
      // status='NEEDS_EMAIL_REVIEW'. Abort this lead's pipeline run and write
      // the gate notes so the user can inspect and supply a corrected email.
      if (finalized.orgDomainGateBlocked) {
        var _gateWriteNotes = finalized.orgDomainGateNotes ||
          '[ORG_DOMAIN_GATE] all candidates mismatched sheet org — human review';
        Logger.log('[BatchProcessor] ORG_DOMAIN_GATE blocked row ' + lead.rowNum +
                   ': ' + _gateWriteNotes);
        logPipelineEvent(lead.rowNum, 'ENRICH', _gateWriteNotes, 'WARN');
        try {
          _uf(lead, {
            ENRICHED_EMAIL:   '',
            EMAIL_SOURCE:     'org_domain_gate_all_rejected',
            EMAIL_CONFIDENCE: '0',
            STATUS:           'NEEDS_EMAIL_REVIEW',
            NOTES:            _gateWriteNotes
          });
        } catch (_gateWriteErr) {
          Logger.log('[BatchProcessor] ORG_DOMAIN_GATE write failed: ' + _gateWriteErr.message);
        }
        return;  // abort pipeline for this row — no draft created
      }

      // PATCH 2026-06-12-handoff-fix: umbrella abort for ALL other finalizer
      // return shapes that yield status='NEEDS_EMAIL_REVIEW' (sheetEmailUndeliverable
      // and funnelLastResortOrgPresent). These paths mutate lead.email='' before
      // returning but were not guarded here, so the pipeline fell through with
      // lead.email='' into compose→createDraft which then rejected with
      // "Missing required draft fields: lead, email, subject, or body".
      // Root cause: S1 sheet_captured Reoon hard-reject (or funnel last-resort with
      // org present) set lead.email='' — BatchProcessor only checked orgDomainGateBlocked.
      // Fix: check finalized.status !== 'VERIFIED' after the orgDomainGateBlocked branch
      // (which already returned) — any remaining NEEDS_EMAIL_REVIEW shape is caught here.
      if (finalized.status === 'NEEDS_EMAIL_REVIEW') {
        var _nrNotes = (finalized.sheetEmailUndeliverableNotes || finalized.funnelLastResortNotes ||
          finalized.reasoning || '[HANDOFF_FIX] finalizer returned NEEDS_EMAIL_REVIEW — human review required');
        Logger.log('[BatchProcessor] NEEDS_EMAIL_REVIEW abort row ' + lead.rowNum +
                   ' (sheetEmailUndeliverable=' + !!finalized.sheetEmailUndeliverable +
                   ' funnelLastResortOrgPresent=' + !!finalized.funnelLastResortOrgPresent + '): ' + _nrNotes);
        logPipelineEvent(lead.rowNum, 'ENRICH', _nrNotes, 'WARN');
        try {
          _uf(lead, {
            ENRICHED_EMAIL:   '',
            EMAIL_SOURCE:     finalized.source || 'finalizer_needs_email_review',
            EMAIL_CONFIDENCE: '0',
            STATUS:           'NEEDS_EMAIL_REVIEW',
            NOTES:            _nrNotes.substring(0, 1900)
          });
        } catch (_nrWriteErr) {
          Logger.log('[BatchProcessor] NEEDS_EMAIL_REVIEW write failed: ' + _nrWriteErr.message);
        }
        return;  // abort pipeline for this row — lead.email is empty, no draft possible
      }

      // PATCH `-eq8-content-fix` (#6): stash the enrichment-resolved domain on
      // the lead so the research stage can anchor its grounded search to the
      // RIGHT company. Without this, research queried the bare org name and
      // Gemini's web search returned the most SEO-prominent same-named entity
      // (e.g. "Bistro" → a Slovak firm), producing wrong-company email bodies.
      try {
        var _rd = (finalized.email || '').toString().split('@')[1] || '';
        // Don't anchor on the placeholder domain — it's not a real company domain.
        if (_rd && _rd.indexOf('placeholder.invalid') < 0) lead.resolvedDomain = _rd;
      } catch (_) {}
      // Continue to Stage 2 regardless of tier.
    } else if (enrichment.email && enrichment.email !== lead.email) {
      // Finalizer unavailable (deployment lag). Fall back to legacy swap.
      lead.email = enrichment.email;
      if (typeof enrichment.confidence === 'number') lead.emailConfidence = enrichment.confidence;
    }
  } catch (enrichErr) {
    // PATCH 2026-05-19 (no-termination mode): enrichEmail blew up entirely
    // (Apollo+Reoon+Hunter network failure, recursion guard tripped, etc.).
    // Previously: STATUS=ERROR + throw — kills the row and crashes the run.
    // New: route through finalizer which always returns a usable email
    // (even if it's a Tier 4 placeholder). Pipeline continues to compose.
    Logger.log('[BatchProcessor] enrichEmail threw for row ' + lead.rowNum + ': ' + enrichErr.message +
               ' — engaging finalizer fallback');
    logPipelineEvent(lead.rowNum, 'ENRICH',
      'EMAIL_ENRICH_THREW: ' + enrichErr.message + ' — finalizer fallback engaged', 'ERROR');
    if (typeof finalizeEmailSelection === 'function') {
      try {
        var finalizedFallback = finalizeEmailSelection(lead);
        // PATCH 2026-06-12-e2e-hardening: stash resolvedDomain from the
        // fallback finalizer's chosen email so researchLead has a domain anchor.
        // The happy-path stash at line ~900 only runs inside the enrichment
        // success branch; without this mirror, every lead whose enrichEmail
        // throws runs research without domain anchoring — Gemini resolves
        // ambiguous org names to the most SEO-prominent entity.
        try {
          var _rdFallback = (finalizedFallback.email || '').toString().split('@')[1] || '';
          if (_rdFallback && _rdFallback.indexOf('placeholder.invalid') < 0) {
            lead.resolvedDomain = _rdFallback;
          }
        } catch (_) {}
        try {
          _uf(lead, {
            ENRICHED_EMAIL:   finalizedFallback.email,
            EMAIL_SOURCE:     finalizedFallback.source + '_post_enrich_throw',
            EMAIL_CONFIDENCE: finalizedFallback.confidence.toFixed(2),
            NOTES: 'EMAIL_ENRICH_THREW + FINALIZER_FALLBACK: enrichEmail threw "' +
                   enrichErr.message + '". Finalizer picked tier=' + finalizedFallback.tier +
                   ' email=' + finalizedFallback.email + ' source=' + finalizedFallback.source +
                   '. Pipeline continues to draft.'
          });
        } catch (_) {}
      } catch (finErr) {
        Logger.log('[BatchProcessor] Finalizer fallback also threw: ' + finErr.message);
        // Last-ditch: synthesize a placeholder so pipeline continues
        lead.email = lead.email || ('recipient-needs-fix-row' + lead.rowNum + '@placeholder.invalid');
        lead.emailConfidence = 0.05;
        lead.selectionTier = 'last_resort';
        lead.riskFlags = ['placeholder_recipient', 'enrichment_threw', 'finalizer_also_threw'];
      }
    } else {
      // Finalizer not deployed yet — last-ditch placeholder
      lead.email = lead.email || ('recipient-needs-fix-row' + lead.rowNum + '@placeholder.invalid');
      lead.emailConfidence = 0.05;
      lead.selectionTier = 'last_resort';
      lead.riskFlags = ['placeholder_recipient', 'finalizer_unavailable'];
    }
  }

  __lat('stage0_enrich');

  // ── Stage 1: Already done (lead parsed from sheet) ──

  // ── Stage 2: Research ──
  // PATCH 2026-05-19 (no-termination mode): research failure is no longer
  // terminal. Use a minimal stub dossier and continue to classify/compose.
  // The downstream compose stage tolerates empty dossiers (falls back to
  // generic hook). User still gets a draft.
  var dossier;
  try {
    dossier = researchLead(lead);
    _uf(lead,{
      RESEARCH_JSON: typeof dossier === 'string' ? dossier : JSON.stringify(dossier),
      STATUS: STATUS.RESEARCH_DONE
    });
    logStageError(lead.rowNum, 'RESEARCH', null, { success: true });
  } catch (e) {
    logStageError(lead.rowNum, 'RESEARCH', e, { lead: lead.fullName });
    Logger.log('[BatchProcessor] Research threw for row ' + lead.rowNum +
               ': ' + e.message + ' — using stub dossier, continuing to classify');
    logPipelineEvent(lead.rowNum, 'RESEARCH',
      'RESEARCH_THREW_USING_STUB: ' + e.message + ' — pipeline continues to compose with minimal context', 'WARN');
    dossier = _stubDossierForLead(lead);
    try {
      _uf(lead, {
        RESEARCH_JSON: JSON.stringify(dossier),
        STATUS: STATUS.RESEARCH_DONE,
        NOTES: 'RESEARCH_STUB: real research call threw (' + e.message + '). Minimal stub dossier used; ' +
               'compose will produce a generic-hook email. Tier set to ' + (lead.selectionTier || '?') + '.'
      });
    } catch (_) {}
  }
  __lat('stage2_research');

  // ── Stage 2.5: Classify ──
  // PATCH 2026-05-19 (no-termination mode): classification failure is no
  // longer terminal. Fall back to a safe default classification
  // (STANDARD template, mid-management seniority) and continue.
  var classification;
  var compressedDossier;
  try {
    compressedDossier = decompressDossier(
      _getDataSheet().getRange(lead.rowNum, CONFIG.COLUMNS.RESEARCH_JSON).getValue()
    );

    // PATCH -eq8-draftpolish (F3): ORG_MISMATCH_GATE
    // If research described a different company (zero token overlap with lead.organization),
    // discard the dossier and use a stub so the wrong-company copy never reaches compose.
    // Check both compressedDossier._orgMismatch (top-level) and compressedDossier.company._orgMismatch
    // to handle both compressed-then-decompressed and already-full-dossier shapes.
    var _mismatch = compressedDossier && (
      compressedDossier._orgMismatch ||
      (compressedDossier.company && compressedDossier.company._orgMismatch)
    );
    if (_mismatch) {
      var _mismatchDetail = (compressedDossier._orgMismatchDetail) ||
        (compressedDossier.company && compressedDossier.company._orgMismatchDetail) || '';
      Logger.log('[BatchProcessor] ORG_MISMATCH_GATE: research described "' + _mismatchDetail +
                 '" — discarding dossier, using stub (row ' + lead.rowNum + ')');
      logPipelineEvent(lead.rowNum, 'CLASSIFY',
        'ORG_MISMATCH_GATE: research described "' + _mismatchDetail +
        '" — discarding dossier, using stub', 'WARN');
      compressedDossier = _stubDossierForLead(lead);
    }

    classification = classifyLead(lead, compressedDossier);
    logStageError(lead.rowNum, 'CLASSIFY', null, { archetype: classification.archetype });
  } catch (e) {
    logStageError(lead.rowNum, 'CLASSIFY', e, { lead: lead.fullName });
    Logger.log('[BatchProcessor] Classify threw for row ' + lead.rowNum +
               ': ' + e.message + ' — using default classification, continuing');
    logPipelineEvent(lead.rowNum, 'CLASSIFY',
      'CLASSIFY_THREW_USING_DEFAULT: ' + e.message + ' — STANDARD template assumed', 'WARN');
    classification = _defaultClassificationForLead(lead);
    if (!compressedDossier) compressedDossier = dossier || _stubDossierForLead(lead);
    try {
      _uf(lead, {
        ARCHETYPE: classification.archetype || '',
        TEMPLATE:  classification.template  || '',
        NOTES: 'CLASSIFY_DEFAULT: real classifier threw (' + e.message + '). ' +
               'Defaulted to ' + (classification.template || 'STANDARD') + '. Pipeline continues.'
      });
    } catch (_) {}
    // No return — continue with default classification to Stage 3.
  }

  // Check if should be skipped
  // PATCH 2026-05-19 (no-termination mode): if the classifier marked SKIPPED
  // (e.g. profile is clearly junk), we still create a low-priority draft
  // so the user has visibility instead of a silent skip. Convert to a soft
  // archetype downgrade rather than a hard skip.
  if (classification.archetype === 'SKIPPED') {
    Logger.log('[BatchProcessor] Row ' + lead.rowNum + ': classifier said SKIPPED (' +
               classification.reasoning + ') — downgrading to STANDARD with risk note');
    logPipelineEvent(lead.rowNum, 'CLASSIFY',
      'CLASSIFY_SKIPPED_DOWNGRADED: ' + classification.reasoning + ' — continuing with default classification', 'WARN');
    classification = _defaultClassificationForLead(lead);
    if (!lead.riskFlags) lead.riskFlags = [];
    if (lead.riskFlags.indexOf('classifier_flagged_skip') < 0) {
      lead.riskFlags.push('classifier_flagged_skip');
    }
  }
  // (Legacy SKIPPED hard-stop removed 2026-05-19 — no-termination mode
  // converts skip signals to risk flags instead. See Patch 2026-05-19.)
  if (classification.archetype === '__never_should_match__') {
    // Sentinel: code unreachable. Placeholder retained so subsequent re-shapes
    // don't accidentally reintroduce hard SKIPPED termination.
    logPipelineEvent(lead.rowNum, 'BATCH', 'Sentinel branch reached (impossible)');
    return;
  }
  __lat('stage2.5_classify');

  // ── Stage 3: Resume Selection ──
  var resumeSelection;
  try {
    resumeSelection = selectResume(lead, compressedDossier, classification);
    logStageError(lead.rowNum, 'RESUME_SELECT', null, { variant: resumeSelection.variantId });
  } catch (e) {
    logStageError(lead.rowNum, 'RESUME_SELECT', e, { lead: lead.fullName });
    // PATCH 2026-05-13 (AUDIT I8 / R31): archetype-aware default. Previously
    // every selectResume failure fell back to GROWTH_MARKETING regardless of
    // classification.archetype — wrong for CXO_SHORT at ops-heavy companies
    // or HR_PARTNERSHIP at consulting firms. Pick a sensible default by
    // archetype/template; GROWTH_MARKETING is the catch-all.
    var fallbackVariant = 'GROWTH_MARKETING';
    if (classification && classification.template === 'HR_PARTNERSHIP') {
      fallbackVariant = 'GROWTH_MARKETING'; // HR teams hire across; growth resume is most legible
    } else if (classification && classification.template === 'CXO_SHORT') {
      fallbackVariant = 'PRODUCT_AI_STRATEGY'; // C-Suite often interested in product/AI strategy
    } else if (classification && classification.archetype &&
               /OPS|OPERATIONS|CONSULTING|STRATEGY/i.test(classification.archetype)) {
      fallbackVariant = 'OPS_CONSULTING';
    }
    resumeSelection = { variantId: fallbackVariant };
    logPipelineEvent(lead.rowNum, 'RESUME_SELECT',
      'Fallback to ' + fallbackVariant + ' (archetype=' + (classification && classification.archetype) +
      ', template=' + (classification && classification.template) + ')', 'WARN');
  }
  __lat('stage3_resume');

  // ── Stage 4: Email Composition ──
  // PATCH 2026-05-19 (no-termination mode): compose failure is no longer
  // terminal. If composeEmail returns success=false (FATAL validation
  // unfixable) OR throws, we synthesize a minimal-but-shippable email so
  // the draft still gets created. STATUS=ERROR is reserved for catastrophic
  // sheet-write failures; everything else routes to DRAFT_CREATED.
  var composed;
  try {
    composed = composeEmail(lead, compressedDossier, classification, resumeSelection);
    if (!composed || !composed.success) {
      var failNote = (composed && composed.qualityNotes) || 'compose returned success=false';
      logStageError(lead.rowNum, 'COMPOSE', new Error(failNote), {});
      Logger.log('[BatchProcessor] Compose returned non-success for row ' + lead.rowNum +
                 ': ' + failNote + ' — synthesizing minimal email so pipeline continues');
      logPipelineEvent(lead.rowNum, 'COMPOSE',
        'COMPOSE_NON_SUCCESS_FALLBACK: ' + failNote + ' — minimal email synthesized', 'WARN');
      composed = _synthesizeMinimalEmail(lead, classification);
    }
    if (composed.tier === 'DETERMINISTIC_FALLBACK') {
      logPipelineEvent(lead.rowNum, 'COMPOSE',
        'Tier 3 DETERMINISTIC FALLBACK engaged — Claude unreachable, static template used', 'WARN');
    } else if (composed.tier === 'TIER_4_SYNTHESIZED') {
      logPipelineEvent(lead.rowNum, 'COMPOSE',
        'Tier 4 SYNTHESIZED — minimal valid email generated post-compose-failure', 'WARN');
    }
    logStageError(lead.rowNum, 'COMPOSE', null, { success: true, tier: composed.tier || 'TIER_1' });
  } catch (e) {
    logStageError(lead.rowNum, 'COMPOSE', e, { lead: lead.fullName });
    Logger.log('[BatchProcessor] Compose threw for row ' + lead.rowNum +
               ': ' + e.message + ' — synthesizing minimal email so pipeline continues');
    logPipelineEvent(lead.rowNum, 'COMPOSE',
      'COMPOSE_THREW_FALLBACK: ' + e.message + ' — minimal email synthesized', 'ERROR');
    composed = _synthesizeMinimalEmail(lead, classification);
  }
  __lat('stage4_compose');

  // ── Stage 5: Humanization ──
  var humanized;
  try {
    humanized = humanizeEmail(composed.emailBody, composed.subjectLine, lead, compressedDossier);
    logStageError(lead.rowNum, 'HUMANIZE', null, { subjectLength: humanized.subjectLine.length });
  } catch (e) {
    logStageError(lead.rowNum, 'HUMANIZE', e, { lead: lead.fullName });
    // Non-critical - use composed version and continue
    humanized = composed;
  }
  __lat('stage5_humanize');

  // ── Stage 6: Quality Gate ──
  var quality;
  try {
    quality = runQualityGate(humanized.subjectLine, humanized.emailBody, lead, classification);
    logStageError(lead.rowNum, 'QUALITY_GATE', null, { score: quality.score.toFixed(2) });
  } catch (e) {
    logStageError(lead.rowNum, 'QUALITY_GATE', e, { lead: lead.fullName });
    // Non-critical - use default score and continue
    quality = { passed: false, score: 0.5, feedback: '' };
  }

  var finalSubject = humanized.subjectLine;
  var finalBody = humanized.emailBody;

  // If quality gate fails, attempt recomposition (one retry)
  if (!quality.passed) {
    logPipelineEvent(lead.rowNum, 'BATCH', 'Quality gate failed (score: ' + quality.score.toFixed(2) + '). Attempting recomposition.');

    var recomp = attemptRecomposition(humanized.emailBody, humanized.subjectLine, quality.feedback, lead);
    if (recomp) {
      // Re-humanize the recomposed version
      var reHumanized = humanizeEmail(recomp.emailBody, recomp.subjectLine, lead, compressedDossier);
      var reQuality = runQualityGate(reHumanized.subjectLine, reHumanized.emailBody, lead, classification);

      // PATCH 2026-06-12-recomp-bullets: a candidate that drops the bullet
      // architecture can never replace a bullet-shaped original, even on a
      // better score. Belt-and-suspenders behind the contract fix inside
      // attemptRecomposition itself.
      var recompShapeOk = _recompFormatGuard(humanized.emailBody, reHumanized.emailBody);
      if (!recompShapeOk) {
        logPipelineEvent(lead.rowNum, 'BATCH',
          'Recomposition rejected by format guard: prose-shaped candidate cannot replace bullet-shaped original', 'WARN');
      }
      if (recompShapeOk && (reQuality.passed || reQuality.score > quality.score)) {
        finalSubject = reHumanized.subjectLine;
        finalBody = reHumanized.emailBody;
        quality = reQuality;
        logPipelineEvent(lead.rowNum, 'BATCH', 'Recomposition improved quality to ' + reQuality.score.toFixed(2));
      }
    }
  }
  __lat('stage6_quality');

  // ── Stage 6.5: Master Validator (final gate) ──────────────────
  // Runs comprehensive checks beyond QualityGate: grammar, recency, resume
  // alignment, event grounding, HTML structure, cross-field uniqueness,
  // and an LLM-as-judge critic pass. If verdict is RECOMPOSE, invokes one
  // additional targeted recomposition using the validator's rewrite notes.
  try {
    var mvVerdict = masterValidate(
      finalSubject, finalBody, lead, compressedDossier,
      classification, resumeSelection, composed ? composed.parsed : null
    );
    logPipelineEvent(lead.rowNum, 'MASTER_VALIDATE',
      'verdict=' + mvVerdict.verdict + ' score=' + mvVerdict.score.toFixed(2) +
      ' fatal=' + mvVerdict.fatalIssues.length + ' warn=' + mvVerdict.warnings.length +
      (mvVerdict.criticUsed ? ' critic=yes' : ' critic=no'),
      mvVerdict.fatalIssues.length > 0 ? 'WARN' : 'INFO');

    // Combine master validator score with QualityGate score (weighted average)
    //
    // PATCH 2026-05-13 (AUDIT I1 / R10): NaN guard. Previously if MV's
    // scoreDeductions accumulated to NaN (e.g. `scoreDeductions += undefined`
    // when a metric extractor returned undefined), `mvVerdict.score` could
    // be NaN. `quality.score * 0.45 + NaN * 0.55 = NaN`. Downstream
    // `quality.score.toFixed(2)` threw TypeError caught by Stage 7's catch,
    // and the lead silently never drafted with no failure logged. New
    // guards: validate both inputs, default each to 0.75 (median-quality)
    // if invalid, log when forced.
    var qScore = (typeof quality.score === 'number' && !isNaN(quality.score)) ? quality.score : 0.75;
    var mvScore = (mvVerdict && typeof mvVerdict.score === 'number' && !isNaN(mvVerdict.score)) ? mvVerdict.score : 0.75;
    if (qScore !== quality.score || (mvVerdict && mvScore !== mvVerdict.score)) {
      logPipelineEvent(lead.rowNum, 'MASTER_VALIDATE',
        'Score NaN guard fired: qg=' + quality.score + ' mv=' + (mvVerdict ? mvVerdict.score : 'n/a') +
        ' → coerced to (qg=' + qScore + ', mv=' + mvScore + ')', 'WARN');
    }
    var combinedScore = (qScore * 0.45) + (mvScore * 0.55);
    if (isNaN(combinedScore)) combinedScore = mvScore; // last-resort fallback
    quality.score = combinedScore;

    // If master validator says RECOMPOSE, run one extra targeted recomposition
    if (mvVerdict.verdict === 'RECOMPOSE') {
      logPipelineEvent(lead.rowNum, 'BATCH',
        'MasterValidator requested recomposition. Issues: ' + mvVerdict.fatalIssues.slice(0, 2).join('; '));
      var mvRecomp = attemptRecomposition(finalBody, finalSubject, mvVerdict.feedbackForRecompose, lead);
      if (mvRecomp) {
        var mvRehum = humanizeEmail(mvRecomp.emailBody, mvRecomp.subjectLine, lead, compressedDossier);
        // Re-validate the recomposed version
        var mvReverdict = masterValidate(
          mvRehum.subjectLine, mvRehum.emailBody, lead, compressedDossier,
          classification, resumeSelection, null
        );
        // PATCH 2026-06-12-recomp-bullets: same format guard as the
        // quality-gate recomposition site above — no prose-shaped downgrades.
        var mvShapeOk = _recompFormatGuard(finalBody, mvRehum.emailBody);
        if (!mvShapeOk) {
          logPipelineEvent(lead.rowNum, 'BATCH',
            'MasterValidator recomposition rejected by format guard: prose-shaped candidate cannot replace bullet-shaped original', 'WARN');
        }
        if (mvShapeOk && mvReverdict.score > mvVerdict.score) {
          finalSubject = mvRehum.subjectLine;
          finalBody = mvRehum.emailBody;
          quality.score = (quality.score * 0.3) + (mvReverdict.score * 0.7);
          logPipelineEvent(lead.rowNum, 'BATCH',
            'MasterValidator recomp improved score to ' + mvReverdict.score.toFixed(2));
        }
      }
    }

    // PATCH 2026-05-19 (no-termination mode): BLOCK verdict no longer prevents
    // the draft. Tag the lead's risk flags + notes so the user sees the issue
    // when they open the draft (the body-header risk panel renders these),
    // and continue. Quality score IS held down so STATUS routing reflects it.
    if (mvVerdict.verdict === 'BLOCK') {
      quality.passed = false;
      quality.score = Math.min(quality.score, 0.4);
      lead.riskFlags = lead.riskFlags || [];
      if (lead.riskFlags.indexOf('master_validator_block') < 0) {
        lead.riskFlags.push('master_validator_block');
      }
      _uf(lead,{
        NOTES: 'BLOCKED by MasterValidator (continuing in no-termination mode): ' +
               mvVerdict.fatalIssues.slice(0, 2).join('; ')
      });
    }

    // REVIEW / RECOMPOSE verdict → write fatalIssues + warnings to NOTES so the
    // user can see exactly WHY the lead stalled without digging through logs.
    if (mvVerdict.verdict === 'REVIEW' || mvVerdict.verdict === 'RECOMPOSE') {
      var mvNotesText = '[MV ' + mvVerdict.verdict + ' score=' + mvVerdict.score.toFixed(2) + ']\n';
      if (mvVerdict.fatalIssues && mvVerdict.fatalIssues.length > 0) {
        mvNotesText += 'FATAL:\n  - ' + mvVerdict.fatalIssues.slice(0, 5).join('\n  - ') + '\n';
      }
      if (mvVerdict.warnings && mvVerdict.warnings.length > 0) {
        mvNotesText += 'WARN:\n  - ' + mvVerdict.warnings.slice(0, 3).join('\n  - ');
      }
      // Truncate to 1500 chars to fit cell
      if (mvNotesText.length > 1500) mvNotesText = mvNotesText.substring(0, 1500) + '... [truncated]';
      _uf(lead,{ NOTES: mvNotesText });
    }
  } catch (mvErr) {
    logPipelineEvent(lead.rowNum, 'MASTER_VALIDATE', 'Validator failed (non-blocking): ' + mvErr.message, 'ERROR');
  }

  // PATCH 2026-05-15 (v2 Track D): Tier 3 deterministic fallback handling.
  // If the composer returned tier='DETERMINISTIC_FALLBACK', we want:
  //   - Status: NEEDS_REVIEW (distinct from REVIEW; explicit "human edit needed")
  //   - Draft IS created in Gmail (so user sees something)
  //   - quality.score forced to 0.7 (below 0.8 auto-draft gate so we don't ship
  //     a generic email assuming it's high-quality, but high enough to still
  //     create the draft via the Stage 8 path — actually wait, we need to FORCE
  //     draft creation regardless of score here; see Stage 8 patch below)
  //   - NOTES tells the user what happened
  var isTier3 = composed && composed.tier === 'DETERMINISTIC_FALLBACK';
  if (isTier3) {
    // Override score to a known-deterministic value so dashboard shows it consistently
    quality.score = 0.65;
    quality.passed = false; // not "passed" per validator; passed our hand-off threshold instead
    // PATCH `-postsprint-batch1-amend`: NOTES now records the SPECIFIC reason
    // for Tier-3 engagement (was hardcoded "Claude composer unreachable" for
    // every cause). The fallbackReason + fallbackDetail are set by EmailComposer
    // at each of the three Tier-3 entry paths. tier1_fallback_stats reads
    // these markers for accurate bucketing.
    var reasonCode = (composed && composed.fallbackReason) || 'unknown';
    var reasonDetail = (composed && composed.fallbackDetail) || '';
    var reasonHuman = ({
      'claude_api_error':       'Claude API error',
      'claude_unparseable':     'Claude returned unparseable JSON twice',
      'fatal_em_dash':          'FATAL: em-dash/en-dash survived inline fix',
      'fatal_word_count':       'FATAL: word-count validation failed',
      'fatal_typography':       'FATAL: smart-quote/ellipsis violation',
      'fatal_validation_other': 'FATAL: other validation issue',
      'unknown':                'Claude composer unreachable'
    })[reasonCode] || reasonCode;
    var t3Notes = '[Tier 3 DETERMINISTIC FALLBACK reason=' + reasonCode + '] ' +
                  reasonHuman + '; generic template used. ' +
                  (reasonDetail ? 'Detail: ' + reasonDetail + '. ' : '') +
                  'Verify recipient-specific details and personalize the hook/P.S. before sending. ' +
                  'Draft created for editing.';
    try {
      _uf(lead,{ NOTES: t3Notes });
    } catch (_) {}
  }

  // ── Stage 6.8: Inject risk-warning header into draft body when tier != verified
  // PATCH 2026-05-19 (no-termination mode): drafts of any non-verified email
  // selection tier carry a coloured "INTERNAL NOTE" panel at the top of the
  // body so the user knows what they're looking at when they open the draft
  // in Gmail. Header is plain HTML — Gmail renders it correctly, the user
  // deletes the box before sending.
  try {
    if (typeof buildRiskHeaderHtml === 'function' &&
        lead.selectionTier && lead.selectionTier !== 'verified') {
      var riskHeader = buildRiskHeaderHtml(lead.selectionTier, lead.riskFlags || [], lead);
      if (riskHeader) {
        finalBody = riskHeader + finalBody;
        logPipelineEvent(lead.rowNum, 'COMPOSE',
          'RISK_HEADER_INJECTED: tier=' + lead.selectionTier +
          ' flags=' + ((lead.riskFlags || []).join(',') || 'none'), 'INFO');
      }
    }
  } catch (riskHeaderErr) {
    Logger.log('[BatchProcessor] Risk-header injection failed (non-fatal): ' + riskHeaderErr.message);
  }

  // ── Stage 6.9: Org-Recipient mismatch advisory (c3-watch) ──────────────────
  // PATCH 2026-06-11-eq8-finalpolish: cheap pre-draft guard. When subject-org
  // (lead.organization) and recipient domain (lead.resolvedDomain) share zero
  // alpha tokens of >=4 chars, the subject line likely names a DIFFERENT company
  // than the one the email is actually going to (e.g., subject: Proofpoint, but
  // recipient: nidhi.shah@puma.com). This does NOT block — just appends an
  // ORG_RECIPIENT_MISMATCH_ADVISORY to NOTES and pushes riskFlag 'org_recipient_mismatch'
  // so the risk header surfaces it if selectionTier is non-verified.
  // Token overlap: split org name and domain sld on non-alpha chars; >=4-char tokens;
  // overlap = any common token (case-insensitive). Zero overlap → advisory fires.
  try {
    if (lead.resolvedDomain && lead.organization && String(lead.organization).trim()) {
      var _orgTokens = (String(lead.organization) + '').toLowerCase()
        .split(/[^a-z]+/)
        .filter(function(t) { return t.length >= 4; });
      // Use the second-level domain from resolvedDomain as the token source
      var _domainSld = (typeof _baseDomain === 'function')
        ? _baseDomain(lead.resolvedDomain)
        : lead.resolvedDomain;
      var _domainTokens = (_domainSld + '').toLowerCase()
        .split(/[^a-z]+/)
        .filter(function(t) { return t.length >= 4; });
      var _hasOverlap = _orgTokens.some(function(ot) {
        return _domainTokens.some(function(dt) { return ot === dt; });
      });
      if (!_hasOverlap && _orgTokens.length > 0 && _domainTokens.length > 0) {
        var _orgMismatchNote = 'ORG_RECIPIENT_MISMATCH_ADVISORY: subject-org "' +
          lead.organization + '" vs recipient-domain "' + lead.resolvedDomain + '"';
        Logger.log('[BatchProcessor] ' + _orgMismatchNote + ' row=' + lead.rowNum);
        // Append to NOTES (best-effort; non-blocking)
        // PATCH 2026-06-12-e2e-hardening: read current NOTES from the sheet
        // rather than using stale lead.notes (which was populated once at
        // sheet-read time and never updated in memory). Using lead.notes here
        // overwrites all intermediate NOTES writes (finalizer tier/confidence,
        // research-stub, classify-default) that were made during this run via
        // _uf — exactly the rows that are most suspicious (mismatched org) and
        // most need their diagnostic trace preserved.
        try {
          var _liveNotes = '';
          try {
            var _sheetsAppN = (typeof _svc === 'function') ? _svc('Sheets') : SpreadsheetApp;
            var _ssN = _sheetsAppN.openById(CONFIG.SHEET_ID);
            var _shN = _ssN.getSheetByName(CONFIG.DATA_SHEET);
            if (_shN) {
              _liveNotes = (_shN.getRange(lead.rowNum, CONFIG.COLUMNS.NOTES).getValue() || '').toString().trim();
            }
          } catch (_readErr) {
            // If live read fails, fall back to in-memory notes (better than nothing)
            _liveNotes = (lead.notes || '').toString().trim();
          }
          var _existingNotes = _liveNotes ? (_liveNotes + ' | ') : '';
          _uf(lead, { NOTES: _existingNotes + _orgMismatchNote });
        } catch (_) {}
        // Push riskFlag so the risk header renders it for non-verified tiers
        lead.riskFlags = lead.riskFlags || [];
        if (lead.riskFlags.indexOf('org_recipient_mismatch') < 0) {
          lead.riskFlags.push('org_recipient_mismatch');
        }
      }
    }
  } catch (_orgMismatchErr) {
    Logger.log('[BatchProcessor] org_recipient_mismatch check failed (non-blocking): ' + _orgMismatchErr.message);
  }

  // ── Stage 7: Write Results ──
  // PATCH 2026-05-19 (no-termination mode): write composed payload at
  // STATUS=COMPOSING (in-flight). Stage 8 promotes to DRAFT_CREATED after
  // Gmail draft is confirmed. If Stage 8 fails, the scanner picks up
  // COMPOSING rows on the next tick and retries.
  try {
    writeEmailResult(lead.rowNum, {
      archetype: classification.archetype,
      template: classification.template,
      resumeVariant: resumeSelection.variantId,
      subjectLine: finalSubject,
      emailBody: finalBody,
      qualityScore: quality.score,
      status: STATUS.COMPOSING
    });
  } catch (e) {
    logStageError(lead.rowNum, 'DRAFT_CREATE', e, { stage: 'writeEmailResult' });
  }
  __lat('stage7_writeResults');

  // ── Stage 8: Gmail Draft creation ──
  //
  // PATCH 2026-05-19 (no-termination mode): ALWAYS create the draft. The
  // previous belt-and-suspenders gates are gone:
  //   - No quality.score >= 0.3 threshold (low-quality drafts still ship; the
  //     risk panel injected above explains it to the user)
  //   - No _preDraftDeliverabilityGate call (the finalizer already picked
  //     the best available recipient; the gate would just reject again)
  //   - No three-way STATUS routing (everything = DRAFT_CREATED)
  // The only way a draft fails to materialize is a Gmail API throw, which
  // we catch and log without blocking the rest of the batch.
  // PATCH `-eq8-content-fix` (#2): a `.invalid` placeholder recipient cannot be
  // drafted (Gmail rejects it) — drafting it just burns a call and falls into
  // the silent catch below, stranding the row at COMPOSING. Route it to an
  // explicit NEEDS_EMAIL terminal instead (human must supply a real address).
  if (/\.invalid\s*$/i.test((lead.email || '').toString())) {
    Logger.log('[BatchProcessor] Row ' + lead.rowNum + ' has placeholder .invalid recipient (' +
               lead.email + ') — cannot draft. STATUS -> NEEDS_EMAIL (was silently stranding at COMPOSING).');
    // PATCH 2026-06-12-needs-email-errretry: include errRetry:0/2 token —
    // NEEDS_EMAIL is in STUCK_AUTO_RECOVER_STATUSES, so a token-less NOTES
    // write makes scoreStuckAutoRecoverEligible return
    // 'stuck_no_retry_token_yet' → eligible:true on every scanner tick =
    // unbounded re-dispatch with no budget. Same fix as both DRAFT_FAILED
    // write paths below (PATCH 2026-06-12-e2e-hardening).
    // PATCH 2026-06-12-errretry-preserve: seed via the helper — the inline
    // seed reset a scanner-bumped token to 0/2 on every failing cycle.
    try {
      updateLeadFields(lead.rowNum, {
        STATUS: STATUS.NEEDS_EMAIL,
        NOTES: _seedOrPreserveErrRetry(lead.notes,
          'DRAFT_SKIPPED_PLACEHOLDER_RECIPIENT: enrichment could not resolve a real address (' +
          lead.email + '). Supply a recipient and re-run. Compose succeeded; only the address is missing.',
          'errRetry:0/2')
      }, lead.linkedinUrl ? { verifyUrl: lead.linkedinUrl, verifyUid: lead.leadUid } : undefined);
    } catch (_) {}
    __p2bDraftOutcome = 'DRAFT_SKIPPED_PLACEHOLDER_RECIPIENT';
  } else if (true) {
    // __draftFailError: if set after the try/catch, we throw it so Scanner.gs
    // executeDispatch catch block calls _bumpErrRetryOnError and the errRetry
    // budget actually increments across cycles. Both DRAFT_FAILED paths (success:false
    // and threw) write STATUS+NOTES inside the try/catch, then propagate the error
    // outward here — not by throwing inside the catch block which would double-write.
    var __draftFailError = null;
    try {
      var draftMeta = {
        variantId: resumeSelection.variantId,
        archetype: classification.archetype,
        emailConfidence: lead.emailConfidence,
        selectionTier: lead.selectionTier || 'verified',
        riskFlags: lead.riskFlags || []
      };
      var draftResult = createDraft(lead, finalSubject, finalBody, draftMeta);
      // Phase 2b L3: record real outcome for the completion log
      __p2bDraftOutcome = draftResult.success
        ? STATUS.DRAFT_CREATED
        : ('DRAFT_FAILED:' + (draftResult.error || 'unknown'));

      if (draftResult.success) {
        // PATCH 2026-05-19: unified STATUS = DRAFT_CREATED for every draft-bearing row.
        // Tier + risk flags are surfaced via NOTES + the body-header panel, not STATUS.
        var draftUpdates = {
          DRAFT_ID: draftResult.draftId,
          STATUS:   STATUS.DRAFT_CREATED
        };
        // Persist threadId + RFC 2822 Message-ID so follow-ups thread natively
        if (draftResult.threadId)       draftUpdates.THREAD_ID         = draftResult.threadId;
        if (draftResult.rfc822MessageId) draftUpdates.RFC822_MESSAGE_ID = draftResult.rfc822MessageId;
        _uf(lead,draftUpdates);
        logStageError(lead.rowNum, 'DRAFT_CREATE', null, { draftId: draftResult.draftId, threadId: draftResult.threadId || '' });

        // Mirror threadId onto the lead object so generateFollowUps / _persistFollowUps see it
        lead.threadId       = draftResult.threadId || lead.threadId || '';
        lead.rfc822MessageId = draftResult.rfc822MessageId || lead.rfc822MessageId || '';

        // ── Generate and persist follow-up sequence ──
        try {
          var followUps = generateFollowUps(lead, finalSubject, compressedDossier, classification);
          if (followUps && followUps.length > 0) {
            _persistFollowUps(lead, followUps);
            // New offset-based payload — no absolute dates stored here, since send time
            // is computed from SENT_DATE + offsetDays at trigger firing.
            _uf(lead,{
              FOLLOWUP_DATES: JSON.stringify(followUps.map(function(f) {
                return { stage: f.stage, offsetDays: f.offsetDays, framework: f.framework };
              }))
            });
          }
          logStageError(lead.rowNum, 'FOLLOWUP_GEN', null, { count: followUps ? followUps.length : 0 });
        } catch (e) {
          logStageError(lead.rowNum, 'FOLLOWUP_GEN', e, { lead: lead.fullName });
          // Non-critical - continue
        }
      } else {
        // createDraft returned success:false.
        // PATCH 2026-06-13-transient-draft: if the failure is a transient rate-limit
        // (short-window burst, NOT the lead's fault), park the lead at
        // PENDING_QUOTA_RESET WITHOUT burning an errRetry credit and WITHOUT
        // throwing (so _bumpErrRetryOnError is never reached). The lead will be
        // re-queued on the next scanner tick (~5 min) once the burst subsides.
        // Only non-transient failures fall through to DRAFT_FAILED + errRetry burn.
        var _failErrStr = (draftResult.error || 'unknown').toString();
        if (_isTransientGmailError(_failErrStr)) {
          Logger.log('[BatchProcessor] createDraft TRANSIENT rate-limit (success:false) for row ' + lead.rowNum +
                     ': ' + _failErrStr + ' — STATUS -> PENDING_QUOTA_RESET (no errRetry burn)');
          try {
            updateLeadFields(lead.rowNum, {
              STATUS: 'PENDING_QUOTA_RESET',
              NOTES:  '[TRANSIENT_RATELIMIT] createDraft rate-limited; re-queued, no retry burn. ' + _failErrStr.substring(0, 120)
            }, lead.linkedinUrl ? { verifyUrl: lead.linkedinUrl, verifyUid: lead.leadUid } : undefined);
          } catch (_) {}
          // Do NOT set __draftFailError — transient park does not throw.
        } else {
          // Non-transient failure: write DRAFT_FAILED and stash the error to throw
          // AFTER the try/catch — throwing here would fall into the catch below
          // and double-write the NOTES.
          Logger.log('[BatchProcessor] createDraft returned failure for row ' + lead.rowNum +
                     ': ' + _failErrStr + ' — STATUS -> DRAFT_FAILED');
          var _failMsg = _seedOrPreserveErrRetry(lead.notes,
            'DRAFT_FAILED: createDraft returned failure (' + _failErrStr + '). Compose succeeded; the Gmail draft did not materialize.',
            'errRetry:0/2');
          try {
            updateLeadFields(lead.rowNum, {
              STATUS: STATUS.DRAFT_FAILED,
              NOTES:  _failMsg
            }, lead.linkedinUrl ? { verifyUrl: lead.linkedinUrl, verifyUid: lead.leadUid } : undefined);
          } catch (_) {}
          __draftFailError = new Error(_failMsg);
        }
      }
    } catch (e) {
      logStageError(lead.rowNum, 'DRAFT_CREATE', e, { lead: lead.fullName });
      // createDraft THREW.
      // PATCH 2026-06-13-transient-draft: if the exception is a transient rate-limit
      // (short-window burst, NOT the lead's fault), park at PENDING_QUOTA_RESET
      // WITHOUT burning an errRetry credit and WITHOUT setting __draftFailError
      // (so _bumpErrRetryOnError is never reached). Next scanner tick re-queues.
      // Non-transient throws keep the original DRAFT_FAILED + errRetry burn behavior.
      var _threwErrStr = (e.message || e).toString();
      if (_isTransientGmailError(_threwErrStr)) {
        Logger.log('[BatchProcessor] createDraft TRANSIENT rate-limit (threw) for row ' + lead.rowNum +
                   ': ' + _threwErrStr + ' — STATUS -> PENDING_QUOTA_RESET (no errRetry burn)');
        __p2bDraftOutcome = 'PENDING_QUOTA_RESET:transient_ratelimit';
        try {
          updateLeadFields(lead.rowNum, {
            STATUS: 'PENDING_QUOTA_RESET',
            NOTES:  '[TRANSIENT_RATELIMIT] createDraft rate-limited; re-queued, no retry burn. ' + _threwErrStr.substring(0, 120)
          }, lead.linkedinUrl ? { verifyUrl: lead.linkedinUrl, verifyUid: lead.leadUid } : undefined);
        } catch (_) {}
        // Do NOT set __draftFailError — transient park does not propagate to _bumpErrRetryOnError.
      } else {
        // Non-transient throw: write DRAFT_FAILED and stash the error to throw after.
        __p2bDraftOutcome = 'DRAFT_FAILED:' + _threwErrStr;
        var _draftThrewNote = _seedOrPreserveErrRetry(lead.notes,
          'DRAFT_FAILED (threw): ' + _threwErrStr.substring(0, 180) + '.',
          'errRetry:0/2');
        try {
          updateLeadFields(lead.rowNum, {
            STATUS: STATUS.DRAFT_FAILED,
            NOTES:  _draftThrewNote
          }, lead.linkedinUrl ? { verifyUrl: lead.linkedinUrl, verifyUid: lead.leadUid } : undefined);
        } catch (_) {}
        __draftFailError = e;
      }
    }
    // Throw after the try/catch so Scanner.gs executeDispatch catch block receives
    // the error and calls _bumpErrRetryOnError — this is the only path that
    // increments the errRetry counter and eventually exhausts the budget.
    if (__draftFailError) throw __draftFailError;
  }

  // PATCH 2026-05-19 (no-termination mode): unified completion log.
  // PATCH `-p5-composer-preflight` (Phase 2b L3): replaced the hardcoded
  // `Status: DRAFT_CREATED` lie with the real outcome from createDraft.
  // The previous version always claimed DRAFT_CREATED regardless of
  // whether a draft actually shipped, which masked the daily-quota silent-
  // fail loop for weeks. Truthful log lets us notice next time.
  var tierLabel = lead.selectionTier || 'verified';
  var riskCount = (lead.riskFlags || []).length;
  Logger.log('Lead ' + lead.fullName + ' complete. Status: ' + __p2bDraftOutcome + ', ' +
    'Tier: ' + tierLabel + ', Risk-flags: ' + riskCount +
    ', Quality: ' + ((quality && quality.score) || 0).toFixed(2));

  // PATCH Phase 2a (latency-instrument): total wall-clock for this lead.
  Logger.log('[LATENCY row=' + ((lead && lead.rowNum) || '?') +
             ' stage=lead_TOTAL ms=' + (Date.now() - __t0) + ']');
}

// ─── RESUME-ONLY PIPELINE (for leads already researched) ──

/**
 * Processes leads that have research but no email yet.
 */
function processResearchedLeads() {
  // PATCH Phase 5.2a (_svc migration): route lock through registry
  var lockService = (typeof _svc === 'function') ? _svc('Lock') : LockService;
  var lock = lockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) return;

  // PATCH 2026-06-12-researched-errretry: function-scoped stash for a
  // createDraft failure inside the per-lead forEach below. The per-lead catch
  // swallows everything (correct for batch continuation), so a draft failure
  // is stashed here instead and propagated by the re-throw at the bottom of
  // this function — after the finally has released the lock — so a caller's
  // catch (Scanner.gs executeDispatch) can bump the bounded retry budget.
  var __draftFailError = null;
  try {
    // Start pipeline run tracking
    startPipelineRun('RESEARCHED_BATCH');

    var leads = getNextBatch(CONFIG.BATCH_SIZE, STATUS.RESEARCH_DONE);
    if (leads.length === 0) {
      endPipelineRun();
      lock.releaseLock();
      return;
    }

    leads.forEach(function(lead) {
      try {
        var dossier = decompressDossier(lead.researchJSON);
        if (!dossier) return;

        var classification = classifyLead(lead, dossier);
        if (classification.archetype === 'SKIPPED') return;

        var resumeSelection = selectResume(lead, dossier, classification);
        var composed = composeEmail(lead, dossier, classification, resumeSelection);
        if (!composed.success) return;

        var humanized = humanizeEmail(composed.emailBody, composed.subjectLine, lead, dossier);
        var quality = runQualityGate(humanized.subjectLine, humanized.emailBody, lead, classification);

        // Always start at REVIEW; upgrade to DRAFT_CREATED only after draft confirmed
        writeEmailResult(lead.rowNum, {
          archetype: classification.archetype,
          template: classification.template,
          resumeVariant: resumeSelection.variantId,  // use .variantId not .label
          subjectLine: humanized.subjectLine,
          emailBody: humanized.emailBody,
          qualityScore: quality.score,
          status: STATUS.REVIEW
        });

        // Create Gmail draft and schedule follow-ups if quality is high enough
        if (quality.score >= 0.8) {
          // Same pre-draft deliverability gate as the main pipeline above
          var preDraftSkip2 = _preDraftDeliverabilityGate(lead);
          if (preDraftSkip2) return;

          var draftMeta2 = {
            variantId: resumeSelection.variantId,
            archetype: classification.archetype,
            emailConfidence: lead.emailConfidence
          };
          // PATCH 2026-06-12-researched-errretry: mirror _processOneLead's
          // bounded-retry handling (PATCH 2026-06-12-readiness-fixes). A
          // createDraft failure here previously wrote no terminal status and
          // no retry token, and the per-lead catch below swallowed any throw —
          // the scanner never saw an error, never bumped the retry budget, and
          // a persistently failing row could re-compose (Claude spend) on
          // every pick without bound. Both failure shapes (threw, and returned
          // success:false) now write the token-bearing terminal status, stash
          // the error, and rely on the function-level re-throw at the bottom.
          var draftResult;
          try {
            draftResult = createDraft(lead, humanized.subjectLine, humanized.emailBody, draftMeta2);
          } catch (eDraft) {
            logStageError(lead.rowNum, 'DRAFT_CREATE', eDraft, { lead: lead.fullName });
            __p2bDraftOutcome = 'DRAFT_FAILED:' + (eDraft.message || eDraft);
            var _researchedThrewNote = _seedOrPreserveErrRetry(lead.notes,
              'DRAFT_FAILED (threw): ' + (eDraft.message || eDraft).toString().substring(0, 180) + '.',
              'errRetry:0/2');
            try {
              updateLeadFields(lead.rowNum, {
                STATUS: STATUS.DRAFT_FAILED,
                NOTES:  _researchedThrewNote
              }, lead.linkedinUrl ? { verifyUrl: lead.linkedinUrl, verifyUid: lead.leadUid } : undefined);
            } catch (_) {}
            __draftFailError = eDraft;
            return;
          }
          // Phase 2b L3: record real outcome for the completion log (NEEDS_REVIEW fallback path)
          __p2bDraftOutcome = draftResult.success
            ? STATUS.DRAFT_CREATED
            : ('DRAFT_FAILED:' + (draftResult.error || 'unknown'));
          if (draftResult.success) {
            var rUpd = {
              DRAFT_ID: draftResult.draftId,
              STATUS: STATUS.DRAFT_CREATED
            };
            if (draftResult.threadId)        rUpd.THREAD_ID         = draftResult.threadId;
            if (draftResult.rfc822MessageId) rUpd.RFC822_MESSAGE_ID = draftResult.rfc822MessageId;
            _uf(lead,rUpd);

            lead.threadId        = draftResult.threadId || lead.threadId || '';
            lead.rfc822MessageId = draftResult.rfc822MessageId || lead.rfc822MessageId || '';

            var followUps = generateFollowUps(lead, humanized.subjectLine, dossier, classification);
            if (followUps && followUps.length > 0) {
              _persistFollowUps(lead, followUps);
              _uf(lead,{
                FOLLOWUP_DATES: JSON.stringify(followUps.map(function(f) {
                  return { stage: f.stage, offsetDays: f.offsetDays, framework: f.framework };
                }))
              });
            }
          } else {
            // PATCH 2026-06-12-researched-errretry: returned-failure shape.
            // Write the same token-bearing terminal as _processOneLead so the
            // scanner's stuck-auto-recover sees a budget instead of a token-
            // less row that is eligible on every tick.
            Logger.log('[BatchProcessor] createDraft returned failure for row ' + lead.rowNum +
                       ' (researched batch): ' + (draftResult.error || 'unknown') + ' — STATUS -> DRAFT_FAILED');
            var _researchedFailMsg = _seedOrPreserveErrRetry(lead.notes,
              'DRAFT_FAILED: createDraft returned failure (' + (draftResult.error || 'unknown') + '). Compose succeeded; the Gmail draft did not materialize.',
              'errRetry:0/2');
            try {
              updateLeadFields(lead.rowNum, {
                STATUS: STATUS.DRAFT_FAILED,
                NOTES:  _researchedFailMsg
              }, lead.linkedinUrl ? { verifyUrl: lead.linkedinUrl, verifyUid: lead.leadUid } : undefined);
            } catch (_) {}
            __draftFailError = new Error(_researchedFailMsg);
          }
        }

        _PIPELINE_RUN.leadCount++;
      } catch (e) {
        logStageError(lead.rowNum, 'RESEARCHED_BATCH', e, { lead: lead.fullName });
      }
    });
  } catch (e) {
    Logger.log('processResearchedLeads: Fatal error: ' + e.message);
  } finally {
    endPipelineRun();
    lock.releaseLock();
  }
  // PATCH 2026-06-12-researched-errretry: propagate the stashed draft failure
  // to the caller now that the lock is released and the run is closed — this
  // is what lets a dispatching caller's catch (Scanner.gs executeDispatch ->
  // _bumpErrRetryOnError) increment the bounded retry budget.
  if (__draftFailError) throw __draftFailError;
}

// ─── RUN TRACKING & DIAGNOSTICS ────────────────────────────

/**
 * Global object to track current pipeline run.
 */
var _PIPELINE_RUN = {
  runId: null,
  type: null,
  startTime: null,
  leadCount: 0
};

/**
 * Starts a pipeline run with tracking.
 * @param {string} type - 'BATCH' or 'RESEARCHED_BATCH'
 */
function startPipelineRun(type) {
  _PIPELINE_RUN = {
    runId: 'RUN_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMddHHmmss') + '_' + Math.random().toString(36).substring(7),
    type: type,
    startTime: new Date(),
    leadCount: 0
  };
  Logger.log('Pipeline run started: ' + _PIPELINE_RUN.runId + ' (' + type + ')');
}

/**
 * Ends the current pipeline run and logs summary.
 */
function endPipelineRun() {
  if (!_PIPELINE_RUN.runId) return;

  var endTime = new Date();
  var duration = (endTime.getTime() - _PIPELINE_RUN.startTime.getTime()) / 1000;

  logPipelineEvent(0, _PIPELINE_RUN.type, 'Run completed: ' + _PIPELINE_RUN.leadCount + ' leads in ' + duration.toFixed(1) + 's', 'INFO');
  Logger.log('Pipeline run ended: ' + _PIPELINE_RUN.runId + ' | Leads: ' + _PIPELINE_RUN.leadCount + ' | Duration: ' + duration.toFixed(1) + 's');

  _PIPELINE_RUN = { runId: null, type: null, startTime: null, leadCount: 0 };
}

/**
 * Logs errors for a specific pipeline stage.
 * @param {number} rowNum - Lead row number
 * @param {string} stageName - Stage name (RESEARCH, CLASSIFY, etc.)
 * @param {Error} error - Error object (null if successful)
 * @param {Object} contextInfo - Additional context
 */
function logStageError(rowNum, stageName, error, contextInfo) {
  var logMsg = stageName;
  if (error) {
    logMsg += ' [ERROR]: ' + error.message;
  } else {
    logMsg += ' [OK]';
  }

  if (contextInfo && Object.keys(contextInfo).length > 0) {
    logMsg += ' (' + JSON.stringify(contextInfo).substring(0, 100) + ')';
  }

  var status = error ? 'ERROR' : 'SUCCESS';
  // logPipelineEvent takes 4 args (rowNum, stage, message, level).
  // RunId is handled internally by logPipelineEvent via _PIPELINE_RUN.
  logPipelineEvent(rowNum, stageName, logMsg, status);
}

/**
 * Generates a diagnostic report for the most recent run(s).
 * @param {number} [runCount] Number of recent runs to show (default: 3)
 * @returns {string} Formatted report
 */
function getRunDiagnostics(runCount) {
  runCount = runCount || 3;
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var logSheet = ss.getSheetByName(CONFIG.LOG_SHEET);
  if (!logSheet) return 'No PipelineLog sheet found. Run the pipeline first.';

  var lastRow = logSheet.getLastRow();
  if (lastRow < 2) return 'No log entries found.';

  // Read all log entries
  var data = logSheet.getRange(2, 1, lastRow - 1, 6).getValues();

  // Find unique run IDs (most recent first)
  var runs = {};
  for (var i = data.length - 1; i >= 0; i--) {
    var runId = data[i][1] || 'NO_RUN_ID';
    if (!runs[runId]) {
      runs[runId] = { entries: [], errors: [], startTime: null, endTime: null };
    }
    runs[runId].entries.push(data[i]);
    if (data[i][4] === 'ERROR') {
      runs[runId].errors.push(data[i]);
    }
    // Track time range
    var ts = data[i][0];
    if (!runs[runId].startTime || ts < runs[runId].startTime) runs[runId].startTime = ts;
    if (!runs[runId].endTime || ts > runs[runId].endTime) runs[runId].endTime = ts;
  }

  // Build report for recent runs
  var runIds = Object.keys(runs).filter(function(r) { return r !== 'NO_RUN_ID'; });
  var recentRuns = runIds.slice(0, runCount);

  var report = '═══ PIPELINE DIAGNOSTICS ═══\n\n';

  recentRuns.forEach(function(runId) {
    var run = runs[runId];
    report += '▸ ' + runId + '\n';
    report += '  Entries: ' + run.entries.length + ' | Errors: ' + run.errors.length + '\n';
    if (run.errors.length > 0) {
      report += '  ── Errors ──\n';
      run.errors.forEach(function(err) {
        report += '  Row ' + err[2] + ' [' + err[3] + ']: ' + (err[5] || '').substring(0, 120) + '\n';
      });
    }
    report += '\n';
  });

  if (recentRuns.length === 0) {
    report += 'No tracked runs found. Run IDs appear after using the pipeline menu.\n';
  }

  return report;
}

// ─── FOLLOW-UP PERSISTENCE ─────────────────────────────────

/**
 * Writes generated follow-ups to the FollowUps sheet so
 * processScheduledFollowUps() can find and draft them on schedule.
 * Creates the sheet with headers if it doesn't exist.
 * @param {Object} lead
 * @param {Array} followUps - Output of generateFollowUps()
 */
function _persistFollowUps(lead, followUps) {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName('FollowUps');

  // Target schema (v2): adds OffsetDays + ParentRow + Framework so the processor can
  // compute fire time from SENT_DATE at trigger time (not generation time) and look
  // up the parent lead to gate on replies / skip if parent isn't SENT yet.
  var HEADERS_V2 = [
    'Email', 'ScheduledDate', 'Subject', 'Body', 'Status',
    'LeadName', 'Stage', 'OffsetDays', 'ParentRow', 'Framework'
  ];

  if (!sheet) {
    sheet = ss.insertSheet('FollowUps');
    sheet.appendRow(HEADERS_V2);
    sheet.getRange(1, 1, 1, HEADERS_V2.length).setFontWeight('bold');
  } else {
    // Backward-compatible migration: append missing columns without disturbing existing rows
    var existingHeader = sheet.getLastColumn() > 0
      ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function(h){ return (h||'').toString().trim(); })
      : [];
    var missing = HEADERS_V2.filter(function(h){ return existingHeader.indexOf(h) < 0; });
    missing.forEach(function(h) {
      var col = sheet.getLastColumn() + 1;
      sheet.getRange(1, col).setValue(h).setFontWeight('bold');
    });
  }

  // Rebuild header index after possible migration
  var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function(h){ return (h||'').toString().trim(); });
  var idx = {};
  header.forEach(function(h, i){ idx[h] = i; });

  // FIX 3a (2026-06-13-followup-thread): Write dedup — build existing (email,stage) PENDING set
  // in a single read before appending. O(n) map lookup prevents duplicate rows for same lead+stage.
  var existingPendingSet = {};
  var existingLastRow = sheet.getLastRow();
  if (existingLastRow >= 2 && idx['Email'] !== undefined && idx['Stage'] !== undefined && idx['Status'] !== undefined) {
    try {
      var existingData = sheet.getRange(2, 1, existingLastRow - 1, sheet.getLastColumn()).getValues();
      existingData.forEach(function(row) {
        var rowStatus = (row[idx['Status']] || '').toString().trim();
        if (rowStatus === 'PENDING') {
          var rowEmail = (row[idx['Email']] || '').toString().trim().toLowerCase();
          var rowStage = (row[idx['Stage']] || '').toString().trim();
          if (rowEmail && rowStage) {
            existingPendingSet[rowEmail + '|' + rowStage] = true;
          }
        }
      });
    } catch (dedupReadErr) {
      Logger.log('[_persistFollowUps] Could not read existing rows for dedup (continuing): ' + dedupReadErr.message);
    }
  }

  var now = new Date();
  followUps.forEach(function(f) {
    // Compute placeholder ScheduledDate = now + offsetDays, but real firing uses SENT_DATE + offsetDays
    var placeholderDate;
    if (f.date instanceof Date) {
      placeholderDate = f.date;
    } else if (f.date) {
      placeholderDate = new Date(f.date);
    } else {
      placeholderDate = new Date(now.getTime() + (f.offsetDays || 0) * 86400000);
    }

    // FIX 3a dedup check: skip if PENDING row for same (email, stage) already exists
    var dedupKey = (lead.email || '').toString().trim().toLowerCase() + '|' + (f.stage || '').toString().trim();
    if (existingPendingSet[dedupKey]) {
      Logger.log('[FollowUp] dedup skip email=' + (lead.email || '') + ' stage=' + (f.stage || ''));
      return; // skip appendRow
    }
    existingPendingSet[dedupKey] = true; // mark so subsequent stages in same call don't double-write

    var rowArr = new Array(header.length).fill('');
    rowArr[idx['Email']]         = lead.email || '';
    rowArr[idx['ScheduledDate']] = placeholderDate;
    rowArr[idx['Subject']]       = f.subject || '';
    rowArr[idx['Body']]          = f.body || '';
    rowArr[idx['Status']]        = 'PENDING';
    rowArr[idx['LeadName']]      = lead.fullName || '';
    rowArr[idx['Stage']]         = f.stage || '';
    if (idx['OffsetDays']  !== undefined) rowArr[idx['OffsetDays']]  = f.offsetDays || 0;
    if (idx['ParentRow']   !== undefined) rowArr[idx['ParentRow']]   = lead.rowNum || '';
    if (idx['Framework']   !== undefined) rowArr[idx['Framework']]   = f.framework || '';

    sheet.appendRow(rowArr);
  });
}

// ─── TRIGGER MANAGEMENT ────────────────────────────────────

/**
 * Schedules the next batch trigger.
 */
function _scheduleBatchTrigger() {
  // Check if trigger already exists
  var triggers = ScriptApp.getProjectTriggers();
  var exists = triggers.some(function(t) {
    return t.getHandlerFunction() === 'processNextBatch';
  });

  if (!exists) {
    ScriptApp.newTrigger('processNextBatch')
      .timeBased()
      .after(CONFIG.TRIGGER_INTERVAL_MIN * 60 * 1000)
      .create();
  }
}

/**
 * Removes batch processing triggers.
 */
function _cleanupBatchTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'processNextBatch') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

// ─── WARM-KEEPER (PATCH 2026-05-15) ─────────────────────────────────────
//
// Problem: the APK Tracking tab fires GET /exec?action=lead_dashboard with a
// 15-second HTTP timeout (TrackingActivity.java:645-646). When the Apps
// Script V8 container is cold (no invocation in last ~5-10 min), spinning
// up + loading 33 .gs files + running the bulk-read handler takes 18-30s.
// The APK times out → shows "Couldn't load tracking data" → the auto-refresh
// tick fires moments later against a now-warm container → entries load.
// User-visible result: a "Couldn't load" flash before entries appear.
//
// Fix: a time-based trigger every 5 minutes that hits the WebApp from
// inside Apps Script itself. Keeps the container warm so the first APK
// request always hits a warm container and completes well inside 15s.
//
// Cost: 1 trivial UrlFetchApp call per 5 minutes = 288/day = ~1.5% of the
// 20,000/day UrlFetchApp quota. Negligible.
//
// Alternative considered: bump APK timeout to 30s + auto-retry. Better UX
// but requires APK rebuild. Warm-keeper deploys via clasp + UI redeploy
// alone, no APK touch.

/**
 * Time-trigger target: pings the WebApp's lightweight default GET endpoint
 * (the "status:active" response, NOT the heavy lead_dashboard handler) to
 * keep the V8 container alive. Idempotent. Safe to call manually too.
 *
 * Why ping the default GET (no action param) rather than lead_dashboard:
 *   - default GET only returns a small status JSON — fast even on cold
 *   - lead_dashboard would do the full bulk read = wasted work
 *   - we just need V8 to stay loaded; any execution does that
 */
function webAppWarmKeeper() {
  try {
    var url = ScriptApp.getService().getUrl();
    if (!url) {
      Logger.log('[WarmKeeper] Web App not deployed yet — skipping ping');
      return;
    }
    // We don't await the response or care about content. Just trigger
    // V8 execution to reset the idle timer.
    var res = UrlFetchApp.fetch(url, {
      method: 'get',
      muteHttpExceptions: true,
      followRedirects: true,
      validateHttpsCertificates: true
    });
    Logger.log('[WarmKeeper] Pinged /exec → HTTP ' + res.getResponseCode());
  } catch (err) {
    Logger.log('[WarmKeeper] Ping failed (non-fatal): ' + err.message);
  }
}

/**
 * Installs the warm-keeper time trigger (5-minute interval). Idempotent —
 * if a trigger for webAppWarmKeeper already exists, it's left in place.
 *
 * Returns a short status string for the install_triggers admin endpoint.
 */
function installWebAppWarmKeeperTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var exists = triggers.some(function(t) {
    return t.getHandlerFunction() === 'webAppWarmKeeper';
  });
  if (exists) return 'already_installed';
  ScriptApp.newTrigger('webAppWarmKeeper')
    .timeBased()
    .everyMinutes(5)
    .create();
  return 'installed_5min';
}

/**
 * Removes ALL triggers (emergency cleanup).
 */
function removeAllTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(trigger) {
    ScriptApp.deleteTrigger(trigger);
  });
  Logger.log('All triggers removed. Count: ' + triggers.length);
  SpreadsheetApp.getUi().alert('All triggers removed (' + triggers.length + ')');
}

// ─── AUTO-PROCESS ON SHEET EDIT ────────────────────────────

/**
 * onEdit handler (installable trigger) that auto-processes any NEW row
 * in Sheet2 as soon as the user pastes/types lead data.
 *
 * Trigger fires when:
 *   - Edit happens in DATA_SHEET (Sheet2)
 *   - The edited row has LinkedIn_URL (A), Full_Name (B), and Email (F) populated
 *   - STATUS (G) is empty or NEW
 *   - We haven't already processed/queued this row in the last 60 seconds (dedupe)
 *
 * Why installable (not simple) onEdit:
 *   - UrlFetchApp + ScriptApp + LockService require auth scopes blocked by simple triggers.
 *   - Installable onEdit runs as the installer, with full scopes.
 *
 * 2nd-order safety:
 *   - Acquires lock with short timeout to avoid stacking concurrent processors.
 *   - Uses script properties to dedupe rapid multi-cell paste edits on the same row.
 *   - Processes only that single row synchronously (bounded < 60s per lead typical),
 *     then schedules the normal batch trigger to pick up any remaining NEW rows.
 *
 * @param {GoogleAppsScript.Events.SheetsOnEdit} e - Edit event
 */
function onSheetEdit(e) {
  try {
    if (!e || !e.range) return;
    var sheet = e.range.getSheet();
    if (sheet.getName() !== CONFIG.DATA_SHEET) return;

    var row = e.range.getRow();
    if (row < 2) return; // header row

    // Read the full row to check data completeness
    var lastCol = CONFIG.SHEET_COL_COUNT || 25;
    var values = sheet.getRange(row, 1, 1, lastCol).getValues()[0];

    var linkedInUrl  = (values[CONFIG.COLUMNS.LINKEDIN_URL - 1]  || '').toString().trim();
    var fullName     = (values[CONFIG.COLUMNS.FULL_NAME - 1]     || '').toString().trim();
    var email        = (values[CONFIG.COLUMNS.EMAIL - 1]         || '').toString().trim();
    var organization = (values[CONFIG.COLUMNS.ORGANIZATION - 1]  || '').toString().trim();
    var status       = (values[CONFIG.COLUMNS.STATUS - 1]        || '').toString().trim();

    // 2026-05-11 FIX: process row if email present OR (name + org present).
    // Stage 0 enrichEmail can pattern-guess from name+org when LinkedIn hides the email.
    //
    // PATCH 2026-05-17: ALSO accept URL-only leads with a /in/ slug.
    // Apollo /people/match takes a LinkedIn URL and returns verified email +
    // organization + title at ~0.95 confidence (e.g., the May-15 Razorpay
    // leads worked this way). Previously gated on fullName+organization which
    // blocked URL-only captures (Rahat, Jaspreetsidhana — APK Vision returns
    // blank but the URL is always present). With this relaxation, the lead
    // gets a real Apollo lookup attempt instead of sitting blank forever.
    // If Apollo misses, the lead correctly lands at NEEDS_EMAIL_REVIEW (still
    // better than no-op).
    var hasUsableEmail = email && email.indexOf('@') > 0;
    var canGuessEmail  = fullName && organization;
    var hasUrlPath     = linkedInUrl && /linkedin\.com\/in\//i.test(linkedInUrl);
    if (!hasUsableEmail && !canGuessEmail && !hasUrlPath) return;

    // Only trigger for NEW/empty rows OR rows the user is rescuing manually
    // by filling in email.
    //
    // PATCH 2026-05-13 (AUDIT F7 / R16): also accept NEEDS_EMAIL and
    // NEEDS_EMAIL_REVIEW. These statuses are written when the cascade can't
    // resolve a verified email; the user is expected to manually paste an
    // address into col F. Without this whitelist, the edit trigger would
    // skip those rows entirely and the user would have no auto-recovery
    // path beyond a manual `reset_stuck_leads` call. With it, editing col F
    // on a stuck row immediately re-fires the pipeline.
    var isEditable = (
      status === '' ||
      status === STATUS.NEW ||
      status === STATUS.NEEDS_EMAIL ||
      status === STATUS.NEEDS_EMAIL_REVIEW
    );
    if (!isEditable) return;
    // If user is editing a stuck-status row, reset to NEW so downstream
    // treats it as fresh (per F7 Mod variant from audit fix proposals).
    if (status === STATUS.NEEDS_EMAIL || status === STATUS.NEEDS_EMAIL_REVIEW) {
      Logger.log('[AutoTrigger] Recovering row ' + row + ' from ' + status + ' (user edit detected)');
    }

    // Dedupe: skip if we just processed this row in last 60s
    // (paste operations fire multiple onEdit events in rapid succession)
    var props = PropertiesService.getScriptProperties();
    var dedupeKey = 'AUTO_EDIT_ROW_' + row;
    var lastTs = parseInt(props.getProperty(dedupeKey) || '0', 10);
    var now = new Date().getTime();
    if (now - lastTs < 60000) return;
    props.setProperty(dedupeKey, String(now));

    Logger.log('[AutoTrigger] onSheetEdit fired for row ' + row + ' (' + fullName + ')');

    // Try short lock — if batch is running, fall back to just queuing batch trigger
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) {
      Logger.log('[AutoTrigger] Batch busy, scheduling batch trigger for row ' + row);
      _scheduleBatchTrigger();
      return;
    }

    try {
      startPipelineRun('AUTO_EDIT');

      // Mark as NEW so downstream stages treat it as fresh input
      // PATCH 2026-05-13 (AUDIT F7): also reset NEEDS_EMAIL/NEEDS_EMAIL_REVIEW
      // when user fills in email — the rescue path
      if (status === '' ||
          status === STATUS.NEEDS_EMAIL ||
          status === STATUS.NEEDS_EMAIL_REVIEW) {
        updateLeadFields(row, { STATUS: STATUS.NEW });
      }

      // Build LeadProfile for this row and run the full pipeline
      var lead = getLeadByRow(row);
      if (!lead) {
        Logger.log('[AutoTrigger] getLeadByRow returned null for row ' + row);
        return;
      }

      _processOneLead(lead);
      _PIPELINE_RUN.leadCount = (_PIPELINE_RUN.leadCount || 0) + 1;
      Logger.log('[AutoTrigger] Row ' + row + ' processed end-to-end.');
    } catch (innerErr) {
      // PATCH 2026-05-19: capture stack + bounded auto-retry (mirrors the
      // safety-net path at line ~1465). Without the stack, "Maximum call
      // stack size exceeded" type errors are undiagnosable.
      var stack = (innerErr && innerErr.stack) ? innerErr.stack.toString() : '(no stack)';
      Logger.log('[AutoTrigger] Row ' + row + ' failed: ' + innerErr.message +
                 '\n--- STACK ---\n' + stack);
      try {
        var ss3 = SpreadsheetApp.openById(CONFIG.SHEET_ID);
        var sheet3 = ss3.getSheetByName(CONFIG.DATA_SHEET);
        var prevNotes = (sheet3 && row)
          ? (sheet3.getRange(row, CONFIG.COLUMNS.NOTES).getValue() || '').toString()
          : '';
        var retryMatch = prevNotes.match(/errRetry:(\d+)/);
        var prevRetry = retryMatch ? parseInt(retryMatch[1], 10) : 0;
        var nextRetry = prevRetry + 1;
        var maxRetries = 2;
        var nextStatus = nextRetry <= maxRetries ? STATUS.NEW : STATUS.ERROR;
        var noteVerb = nextRetry <= maxRetries ? 'RETRY_QUEUED' : 'RETRIES_EXHAUSTED';
        var stackExcerpt = stack.substring(0, 600);
        var newNote = '[' + noteVerb + ' ' + new Date().toISOString() + '] ' +
                      'Auto-trigger error: ' + innerErr.message +
                      ' | errRetry:' + nextRetry + '/' + maxRetries +
                      ' | stack: ' + stackExcerpt;
        updateLeadFields(row, { STATUS: nextStatus, NOTES: newNote });
      } catch (uErr) {
        try {
          updateLeadFields(row, {
            STATUS: STATUS.ERROR,
            NOTES: 'Auto-trigger error: ' + innerErr.message + ' | meta-write-failed: ' + uErr.message
          });
        } catch (_) {}
      }
    } finally {
      endPipelineRun();
      lock.releaseLock();
      // In case multiple rows were pasted at once, chain batch trigger for the rest
      _scheduleBatchTrigger();
    }
  } catch (outerErr) {
    Logger.log('[AutoTrigger] onSheetEdit fatal: ' + outerErr.message);
  }
}

/**
 * onChange handler (installable trigger) — fires on ANY structural change to the
 * spreadsheet, INCLUDING writes made by the Sheets API (Chrome extensions, Apps
 * Script batch writes, external automations).
 *
 * CRITICAL: Installable onEdit triggers DO NOT fire for API writes. onChange does.
 * Since the LinkedIn Chrome extension writes via the Sheets API, onChange is the
 * ONLY reliable way to catch those rows.
 *
 * Strategy: don't trust the event payload (onChange's `e` object doesn't tell you
 * which row changed). Instead, scan Sheet2 for rows that have required data
 * (name + email) but empty status, and process them. Dedupe via PropertiesService.
 *
 * @param {GoogleAppsScript.Events.SheetsOnChange} e - Change event
 */
function onSheetChange(e) {
  try {
    if (!e) return;
    // Only care about structural changes that could introduce new leads
    var changeType = e.changeType || '';
    var interesting = ['INSERT_ROW', 'EDIT', 'OTHER', 'INSERT_GRID'];
    if (interesting.indexOf(changeType) < 0) return;

    // Short debounce — the extension often fires multiple change events per lead.
    //
    // PATCH 2026-05-13 (immediate-trigger fix): shrunk from 15s → 3s. The
    // 15-second window was swallowing back-to-back lead captures (user
    // extracting 2 profiles in quick succession). 3s still absorbs the
    // multiple-events-per-single-edit storm but doesn't drop legitimate
    // separate lead captures. Combined with the direct _kickoffAfterCapture
    // path in WebApp.gs, the onChange handler is now mostly a backup for
    // cases where doPost's direct invocation failed.
    var props = PropertiesService.getScriptProperties();
    var lastChangeTs = parseInt(props.getProperty('AUTO_CHANGE_LAST_TS') || '0', 10);
    var now = new Date().getTime();
    if (now - lastChangeTs < 3000) {
      Logger.log('[AutoChange] Debounced (< 3s since last onChange). Skipping scan.');
      return;
    }
    props.setProperty('AUTO_CHANGE_LAST_TS', String(now));

    Logger.log('[AutoChange] Fired (type=' + changeType + '). Auto-syncing Sheet1→Sheet2 then scanning...');

    // ── 2026-05-11 FIX: Auto-sync Sheet1 → Sheet2 BEFORE scanning Sheet2 ──
    // The Chrome extension's popup writes directly to Sheet1 (raw audit, 50
    // cols starting with timestamp). Without auto-sync, those leads never
    // reach the pipeline (which reads Sheet2). The existing manual function
    // syncSheet1ToSheet2() in Code111.gs handles the schema translation; we
    // call it here on every change so newly-extracted leads flow seamlessly.
    try {
      if (typeof syncSheet1ToSheet2 === 'function') {
        syncSheet1ToSheet2();
      }
    } catch (syncErr) {
      Logger.log('[AutoChange] Sheet1→Sheet2 auto-sync failed (non-fatal): ' + syncErr.message);
    }

    // PATCH 2026-05-13 (immediate-trigger fix): force Sheet2 UNIQUE()
    // formula recalc BEFORE scanning. Without flush, Sheet2 may still show
    // pre-change state when _scanAndProcessNewRows reads it, causing the
    // scanner to find 0 candidates (false-negative) and the just-arrived
    // lead to wait for the 5-min safety-net cron instead.
    try { SpreadsheetApp.flush(); } catch (_) { /* best-effort */ }

    _dispatchScanner('AUTO_CHANGE');
  } catch (err) {
    Logger.log('[AutoChange] Fatal: ' + err.message);
  }
}

/**
 * PATCH `-promote-scanner-wiring-fix` (2026-06-09): central dispatch for the
 * scanner entry points (AUTO_CHANGE + SAFETY_NET). Routes to either the new
 * `scanAndDispatch` (Scanner.gs) or the legacy `_scanAndProcessNewRows`
 * based on `CONFIG.USE_LEGACY_SCANNER`.
 *
 * Live verification at promotion stamp `-promote-scanner-emdash-fix` revealed
 * the original gating was insufficient: the flag only gated whether the
 * SHADOW comparison runs inside the legacy function — it never re-routed the
 * primary path. So flipping the flag to `false` silently became a no-op
 * (legacy continued to run, shadow stopped running, new scanner never
 * executed in production). This wrapper closes the gap.
 *
 * Routing semantics:
 *   - USE_LEGACY_SCANNER === false → scanAndDispatch (new path, primary)
 *   - USE_LEGACY_SCANNER === true  → _scanAndProcessNewRows (legacy primary,
 *     new path runs internally as dry-run shadow)
 *
 * Fail-safe: if `scanAndDispatch` is not in scope (Scanner.gs not deployed),
 * falls back to legacy regardless of the flag. The pipeline never silently
 * scans nothing.
 */
function _dispatchScanner(source) {
  if (CONFIG.USE_LEGACY_SCANNER === false && typeof scanAndDispatch === 'function') {
    Logger.log('[_dispatchScanner] route=new (USE_LEGACY_SCANNER=false), source=' + source);
    return scanAndDispatch({ source: source, dryRun: false });
  }
  Logger.log('[_dispatchScanner] route=legacy (USE_LEGACY_SCANNER=' +
             (CONFIG.USE_LEGACY_SCANNER === false ? 'false but scanAndDispatch unavailable'
                                                   : 'true') + '), source=' + source);
  return _scanAndProcessNewRows(source);
}

/**
 * Scans Sheet2 for rows with complete input data but empty/NEW status, and
 * processes them. Used by onChange, by the safety-net time trigger, and can
 * be called manually. Idempotent and lock-protected.
 *
 * 2nd-order safety:
 *   - Caps number of rows processed per invocation (respects GAS 6-min limit)
 *   - Uses LockService so onChange + time trigger + manual batch can't collide
 *   - If time budget runs out, schedules batch trigger to continue
 *
 * @param {string} source - 'AUTO_CHANGE' | 'SAFETY_NET' | 'MANUAL'
 */
function _scanAndProcessNewRows(source) {
  // PATCH Phase 5.2a (_svc migration): lock + sheets through registry
  var lockService = (typeof _svc === 'function') ? _svc('Lock') : LockService;
  var sheetsApp  = (typeof _svc === 'function') ? _svc('Sheets') : SpreadsheetApp;
  var lock = lockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('[Scan:' + source + '] Another run holds the lock. Scheduling batch trigger as fallback.');
    _scheduleBatchTrigger();
    return;
  }

  var startTime = new Date().getTime();
  var processed = 0, scanned = 0, skipped = 0;
  // PATCH `-p5-scannerrefactor-promote-amend3` (Phase 1c): lift `data` to
  // function scope so the shadow wrapper (after the try/finally) can pass
  // the already-read rows to scanAndDispatch instead of triggering a second
  // full-sheet read. Avoids "Service Spreadsheets timed out" at tail of long runs.
  var data = null;

  try {
    startPipelineRun(source);

    var ss = sheetsApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (!sheet) {
      Logger.log('[Scan:' + source + '] Sheet "' + CONFIG.DATA_SHEET + '" not found.');
      return;
    }

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) { Logger.log('[Scan:' + source + '] No data rows.'); return; }

    var lastCol = CONFIG.SHEET_COL_COUNT || 25;
    data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

    // Iterate rows; collect candidates first, then process (bounded by time)
    // 2026-05-11 FIX: previously required BOTH fullName AND email AND email@ —
    // that rejected legitimate captures where LinkedIn hides the email (very
    // common). Stage 0 enrichEmail can pattern-guess + Reoon-verify from
    // (fullName + organization). So we now require AT LEAST ONE of:
    //   (a) fullName + organization → pattern-guess can run
    //   (b) email with @ → direct verification
    // Anything else still drops (no signal to work with).
    var candidates = [];
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      var rowNum = i + 2;
      var fullName     = (row[CONFIG.COLUMNS.FULL_NAME - 1]    || '').toString().trim();
      var email        = (row[CONFIG.COLUMNS.EMAIL - 1]        || '').toString().trim();
      var organization = (row[CONFIG.COLUMNS.ORGANIZATION - 1] || '').toString().trim();
      var linkedinUrl  = (row[CONFIG.COLUMNS.LINKEDIN_URL - 1] || '').toString().trim();
      var status       = (row[CONFIG.COLUMNS.STATUS - 1]       || '').toString().trim();

      // PATCH 2026-05-17: third gate — URL-only leads with /in/ slug.
      // Apollo /people/match takes a LinkedIn URL and returns verified
      // email + org + title at ~0.95 confidence. When APK Vision returns
      // blank (Rahat/Jaspreetsidhana pattern), the row has only URL + name
      // (the name decoded from URL slug). Previous gate (fullName+org)
      // blocked these from entering the pipeline → row sat blank forever.
      // Now we let URL-only leads through; if Apollo misses, the lead
      // correctly lands at NEEDS_EMAIL_REVIEW (still better than no-op).
      var hasUsableEmail = email && email.indexOf('@') > 0;
      var canGuessEmail  = fullName && organization;
      var hasUrlPath     = linkedinUrl && /linkedin\.com\/in\//i.test(linkedinUrl);
      if (!hasUsableEmail && !canGuessEmail && !hasUrlPath) continue;
      // PATCH 2026-05-12: also accept REOON_RETRY_PENDING rows (PSV transient
      // retry was previously a dead-end — no scanner picked them up). The
      // retry-after timestamp is embedded in NOTES as "retryAfter:<ms>"; if
      // the timestamp is missing or the current time is past it, the row is
      // eligible for re-PSV. If not past retryAfter, skip until next tick.
      //
      // PATCH 2026-05-13 (AUDIT F8 / R18): also pick up RESEARCH_DONE rows.
      // force_recompose explicitly writes this status expecting cron pickup,
      // but no scanner was reading it. This made force_recompose silently
      // stall every lead it touched. Adding it here closes the gap.
      var isFresh = (status === '' || status === STATUS.NEW);
      var isReoonRetry = (status === 'REOON_RETRY_PENDING');
      var isResearchDone = (status === STATUS.RESEARCH_DONE);
      // PATCH 2026-05-19 (no-termination mode): auto-retry any row that ended
      // in a previously-terminal state. The pipeline now produces a draft for
      // every plausible lead — so any row stuck at the old NEEDS_EMAIL /
      // NEEDS_EMAIL_REVIEW / NEEDS_REVIEW / REVIEW / COMPOSING / ERROR
      // statuses is a candidate for automatic re-processing under the new
      // logic. Bounded retries (errRetry:N/2) prevent infinite loops.
      // PATCH Phase 5.2a Bug #1 FIX (per Inventory §7 #1): CLASSIFYING added.
      // Phantom-write protection — if a future patch ever writes
      // STATUS=CLASSIFYING, the auto-recover whitelist picks it up instead
      // of silently orphaning the row.
      var isStuckAutoRecover = (
        status === STATUS.NEEDS_EMAIL ||
        status === STATUS.NEEDS_EMAIL_REVIEW ||
        status === STATUS.NEEDS_REVIEW ||
        status === STATUS.REVIEW ||
        status === STATUS.COMPOSING ||
        status === STATUS.CLASSIFYING ||   // Phase 5.2a Bug #1 FIX
        status === STATUS.HUMANIZING ||
        status === STATUS.QUALITY_CHECK ||
        status === STATUS.ERROR ||
        // PATCH `-p5-composer-preflight` (Phase 2b L4): parked-on-quota rows
        // must be re-evaluated each tick. The pipeline's L1 quota guard
        // re-checks daily limit on entry and either proceeds (quota reset
        // overnight) or re-parks at PENDING_QUOTA_RESET. Zero token spend
        // per re-pick. Including this here is what makes the next-day
        // self-heal work.
        status === STATUS.PENDING_QUOTA_RESET ||
        // PATCH `-p5-vendorresilience-gemini` (Phase 2c L1.5): parked rows
        // from Gemini-backoff need the same self-heal treatment, but with a
        // much shorter window (default 30s backoff vs. midnight reset for
        // PENDING_QUOTA_RESET). The pipeline's L1.5 guard re-checks the
        // backoff state on entry and either proceeds or re-parks.
        status === STATUS.PENDING_GEMINI_BACKOFF
      );
      if (isStuckAutoRecover) {
        var notesForRetry = (row[CONFIG.COLUMNS.NOTES - 1] || '').toString();
        var retryMatch2 = notesForRetry.match(/errRetry:(\d+)\/(\d+)/);
        if (retryMatch2) {
          var retriesSoFar = parseInt(retryMatch2[1], 10) || 0;
          var retryMax = parseInt(retryMatch2[2], 10) || 2;
          if (retriesSoFar >= retryMax) {
            // Already exhausted retries — leave for the user to inspect.
            continue;
          }
        }
      }
      if (!isFresh && !isReoonRetry && !isResearchDone && !isStuckAutoRecover) continue;
      if (isReoonRetry) {
        var notes = (row[CONFIG.COLUMNS.NOTES - 1] || '').toString();
        var retryMatch = notes.match(/retryAfter:(\d+)/);
        if (retryMatch) {
          var retryAfter = parseInt(retryMatch[1], 10);
          if (!isNaN(retryAfter) && Date.now() < retryAfter) {
            // Not yet eligible — wait for next tick
            continue;
          }
        }
      }
      candidates.push({ rowNum: rowNum, fullName: fullName || ('(no-name, org=' + organization + ')') });
    }

    scanned = candidates.length;
    Logger.log('[Scan:' + source + '] Found ' + scanned + ' candidate rows for processing.');

    if (scanned === 0) return;

    // Process up to BATCH_SIZE rows, respecting the 6-min execution ceiling.
    // PATCH Phase 5.2a Bug #2 FIX (per Inventory §7 #2): dropped `|| 5` dead
    // fallback. CONFIG.BATCH_SIZE is always defined; the fallback was
    // misleading dead code suggesting the safety-net runs 5-at-a-time when
    // both Loops A and B actually run at CONFIG.BATCH_SIZE = 3.
    var maxThisRun = Math.min(scanned, CONFIG.BATCH_SIZE);
    for (var j = 0; j < maxThisRun; j++) {
      var elapsed = new Date().getTime() - startTime;
      if (elapsed > (CONFIG.MAX_RUNTIME_MS || 300000)) {
        Logger.log('[Scan:' + source + '] Time budget exhausted at row ' + j + '/' + maxThisRun);
        break;
      }

      var cand = candidates[j];

      // Per-row dedupe — don't reprocess same row within 2 min
      // PATCH Phase 5.2a (_svc migration): Properties through registry.
      // Note: Bug #6 (UID-keyed dedupe) is fixed in NEW Scanner.gs; legacy
      // path retains row-keyed for one sprint as rollback compatibility.
      var dedupeKey = 'AUTO_PROCESSED_ROW_' + cand.rowNum;
      var ps = (typeof _svc === 'function') ? _svc('Properties') : PropertiesService.getScriptProperties();
      var lastTs = parseInt(ps.getProperty(dedupeKey) || '0', 10);
      if (new Date().getTime() - lastTs < 120000) { skipped++; continue; }
      ps.setProperty(dedupeKey, String(new Date().getTime()));

      try {
        // Mark NEW if currently blank so downstream treats it as fresh.
        // PATCH Phase 8 (F-10 fix): read the row's linkedinUrl FIRST so the
        // STATUS write can be URL-keyed against UNIQUE() row shuffles.
        var _candLead = getLeadByRow(cand.rowNum);
        var _scanOpts = (_candLead && _candLead.linkedinUrl) ? { verifyUrl: _candLead.linkedinUrl } : undefined;
        updateLeadFields(cand.rowNum, { STATUS: STATUS.NEW }, _scanOpts);
        var lead = _candLead || getLeadByRow(cand.rowNum);
        if (!lead) { Logger.log('[Scan:' + source + '] Null lead for row ' + cand.rowNum); continue; }
        _processOneLead(lead);
        _PIPELINE_RUN.leadCount = (_PIPELINE_RUN.leadCount || 0) + 1;
        processed++;
      } catch (innerErr) {
        // PATCH 2026-05-19: capture the full stack trace + bounded auto-retry.
        // Previously we only captured innerErr.message — for cryptic errors
        // like "Maximum call stack size exceeded" the message alone doesn't
        // point to the offending function. innerErr.stack reveals the file
        // path, line number, and full call chain.
        //
        // We also implement a 2-attempt bounded retry tracked in NOTES via
        // `errRetry:N`. After 2 failures, the row stays at STATUS=ERROR
        // permanently — preserves the "freeze for manual inspection" semantic
        // for genuinely broken rows while letting transient failures self-heal.
        var stack = (innerErr && innerErr.stack) ? innerErr.stack.toString() : '(no stack)';
        Logger.log('[Scan:' + source + '] Row ' + cand.rowNum + ' failed: ' + innerErr.message +
                   '\n--- STACK ---\n' + stack);
        try {
          // Read previous NOTES to extract retry count
          var ss2 = SpreadsheetApp.openById(CONFIG.SHEET_ID);
          var sheet2 = ss2.getSheetByName(CONFIG.DATA_SHEET);
          var prevNotes = (sheet2 && cand.rowNum)
            ? (sheet2.getRange(cand.rowNum, CONFIG.COLUMNS.NOTES).getValue() || '').toString()
            : '';
          var retryMatch = prevNotes.match(/errRetry:(\d+)/);
          var prevRetry = retryMatch ? parseInt(retryMatch[1], 10) : 0;
          var nextRetry = prevRetry + 1;
          var maxRetries = 2;

          var nextStatus;
          var noteVerb;
          if (nextRetry <= maxRetries) {
            // Reset to NEW so the scanner re-picks this row on the next cron.
            // A small delay is implicit via the per-row dedupe (2-min window).
            nextStatus = STATUS.NEW;
            noteVerb = 'RETRY_QUEUED';
          } else {
            // Exhausted retries — freeze for manual inspection.
            nextStatus = STATUS.ERROR;
            noteVerb = 'RETRIES_EXHAUSTED';
          }

          // Build a self-contained NOTES entry with the stack trace excerpt
          // (capped to first ~600 chars so we don't blow past the sheet cell limit)
          var stackExcerpt = stack.substring(0, 600);
          var newNote = '[' + noteVerb + ' ' + new Date().toISOString() + '] ' +
                        source + ' error: ' + innerErr.message +
                        ' | errRetry:' + nextRetry + '/' + maxRetries +
                        ' | stack: ' + stackExcerpt;
          updateLeadFields(cand.rowNum, { STATUS: nextStatus, NOTES: newNote });
        } catch (writeErr) {
          // Last-resort fallback if even the error-status write fails
          try {
            updateLeadFields(cand.rowNum, { STATUS: STATUS.ERROR,
              NOTES: source + ' error: ' + innerErr.message + ' | meta-write-failed: ' + writeErr.message });
          } catch (_) {}
        }
      }
    }

    Logger.log('[Scan:' + source + '] Done. Processed ' + processed + ', skipped (dedupe) ' + skipped + ', remaining ' + (scanned - processed - skipped));

    // If there are still candidates left, schedule batch trigger to chain
    if (scanned - processed - skipped > 0) {
      _scheduleBatchTrigger();
    }
  } catch (err) {
    Logger.log('[Scan:' + source + '] Fatal: ' + err.message);
  } finally {
    endPipelineRun();
    lock.releaseLock();
  }

  // ── PHASE 5.2a — SHADOW-MODE COMPARISON (dryRun, ZERO side effects) ─────
  // After legacy execution completes, invoke Scanner.scanAndDispatch with
  // dryRun=true. The new path computes decisions via the 3-layer architecture
  // (scorers + dispatcher + executor) but the executor's FIRST conditional is
  // `if (opts.dryRun) { _logShadowDiff; return; }` — so NO locks acquired,
  // NO Sheet writes, NO _processOneLead invocations, NO Gmail drafts, NO
  // vendor API calls. The ONLY new-path side effect during shadow is appending
  // diff rows to the `scanner_shadow_diff` sheet when decisions disagree.
  //
  // After 24-48h of zero diffs across ≥200 invocations, Phase 5.2b promotes:
  // flip `CONFIG.USE_LEGACY_SCANNER = false` → new path executes with
  // dryRun=false; legacy retained one sprint.
  //
  // SAFE NO-OP: if Scanner.gs not deployed yet (early in 5.2a deploy), the
  // typeof check skips silently. Production behavior unaffected.
  try {
    if (typeof scanAndDispatch === 'function' && CONFIG.USE_LEGACY_SCANNER !== false) {
      // PATCH amend3 (Phase 1c): pass in-memory `data` already read by legacy
      // scan so the shadow path doesn't trigger a second full-sheet read at
      // the tail of long-running invocations (fixes "Service Spreadsheets
      // timed out" observed in prod logs at 240s+). Also pass legacyStartTime
      // so the shadow path can compute remaining-budget and skip cleanly if
      // < 30s of GAS budget remains (Phase 1d budget guard).
      scanAndDispatch({
        source:           'SHADOW:' + source,
        dryRun:           true,
        legacyRowData:    data,       // null if legacy bailed before reading
        legacyStartTime:  startTime
      });
    }
  } catch (shadowErr) {
    // Shadow runner must NEVER affect production. Catch + log + continue.
    Logger.log('[Scan:' + source + '] Shadow comparison failed (non-fatal): ' + shadowErr.message);
  }
}

/**
 * Safety-net handler called by time-based trigger every 5 min.
 * Catches anything missed by onChange/onEdit (extensions sometimes write with
 * changeType='OTHER' that's filtered out, or onChange may have failed silently).
 */
function autoProcessSafetyNet() {
  _dispatchScanner('SAFETY_NET');
}

/**
 * Installs the FULL autonomous trigger stack:
 *   1. onChange  — catches Sheets API writes (Chrome extension, automation)
 *   2. onEdit    — catches manual paste/type in the browser UI
 *   3. Time-based (every 5 min) — safety net for anything missed
 *
 * All three run in Google's cloud — laptop can be off, internet disconnected,
 * pipeline still fires when new rows land in Sheet2.
 *
 * Safe to re-run: removes old triggers with same handlers before creating new ones.
 */
function setupAutoProcessTrigger() {
  // Remove any existing triggers for these handlers
  var handlers = ['onSheetEdit', 'onSheetChange', 'autoProcessSafetyNet'];
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (handlers.indexOf(t.getHandlerFunction()) >= 0) {
      ScriptApp.deleteTrigger(t);
    }
  });

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);

  // Layer 1: onChange — fires for API writes (the critical one for Chrome extension)
  ScriptApp.newTrigger('onSheetChange')
    .forSpreadsheet(ss)
    .onChange()
    .create();

  // Layer 2: onEdit — fires for manual UI edits (paste, type)
  ScriptApp.newTrigger('onSheetEdit')
    .forSpreadsheet(ss)
    .onEdit()
    .create();

  // Layer 3: time-based safety net — every 5 minutes
  ScriptApp.newTrigger('autoProcessSafetyNet')
    .timeBased()
    .everyMinutes(5)
    .create();

  // Layer 4: daily follow-up processor — fires scheduled follow-ups at the configured hour
  // Without this, generated follow-ups would sit in the FollowUps sheet forever.
  try {
    setupFollowUpTrigger();
  } catch (fuErr) {
    Logger.log('[AutoTrigger] setupFollowUpTrigger failed (non-fatal): ' + fuErr.message);
  }

  Logger.log('[AutoTrigger] Installed 4-layer autonomous trigger stack (onChange + onEdit + 5-min safety net + daily follow-ups).');
  try {
    SpreadsheetApp.getUi().alert(
      'Autonomous Pipeline Activated\n\n' +
      '4 triggers installed (all run in Google Cloud):\n' +
      '  1. onChange  - catches Chrome extension / API writes\n' +
      '  2. onEdit    - catches manual paste/type\n' +
      '  3. Safety net - every 5 min, processes any missed rows\n' +
      '  4. Follow-ups - daily, fires scheduled stage 1/2/3 replies\n\n' +
      'New rows in Sheet2 will now auto-run the pipeline\n' +
      'WITHOUT your laptop needing to be on.\n\n' +
      'To remove: Run "Remove All Triggers (Emergency)" from the menu.'
    );
  } catch (_) { /* no UI context when run from editor */ }
}

/**
 * Sets up a daily trigger for follow-up processing.
 */
/**
 * Pre-draft email-deliverability gate.
 *
 * Called from _processOneLead and processResearchedLeads RIGHT BEFORE
 * createDraft. Returns TRUE to signal "skip draft, don't proceed" — caller
 * should `return`. Returns FALSE to allow draft creation to continue.
 *
 * Three failure modes it catches:
 *   1. Confidence below threshold (0.65 default — covers "catch_all" leads
 *      that Reoon rated as deliverable-but-risky)
 *   2. Confidence missing entirely → just-in-time Reoon verify, reject if
 *      Reoon now says invalid/disabled/spamtrap/disposable
 *   3. Email entirely missing somehow (shouldn't happen after Stage 0 but
 *      defensive belt)
 *
 * @param {Object} lead
 * @returns {boolean} true if draft should be skipped, false if proceed
 */
function _preDraftDeliverabilityGate(lead) {
  // PATCH 2026-05-19 (no-termination mode): gate is now ADVISORY ONLY.
  // It never skips the draft. Returns false always. The finalizer + risk-
  // header injection now own the "warn the user about a risky recipient"
  // job. Keeping the function around (vs deleting) so any caller that still
  // invokes it doesn't ReferenceError, and so the diagnostic log line that
  // records WHAT the gate would have done is preserved for forensics.
  if (!lead || !lead.email) {
    Logger.log('[BatchProcessor] Pre-draft gate ADVISORY: lead has no email (would have skipped pre-2026-05-19) — letting through; finalizer should have set a placeholder');
    return false;
  }
  var advisoryConfFloor = 0.20;
  var advisoryConf = parseFloat(lead.emailConfidence) || 0;
  if (advisoryConf > 0 && advisoryConf < advisoryConfFloor) {
    Logger.log('[BatchProcessor] Pre-draft gate ADVISORY: emailConfidence ' + advisoryConf.toFixed(2) +
               ' < ' + advisoryConfFloor + ' (would have skipped pre-2026-05-19) — letting through');
    logPipelineEvent(lead.rowNum, 'PRE_DRAFT_GATE',
      'ADVISORY_LOW_CONF: emailConfidence ' + advisoryConf.toFixed(2) + ' would have triggered skip, ' +
      'now letting through per no-termination mode. Risk header in body should warn the user.', 'INFO');
  }
  // No-termination mode: never skip the draft.
  return false;
}

function setupFollowUpTrigger() {
  // Remove existing follow-up triggers (avoid duplicates on re-install)
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'processScheduledFollowUps') {
      ScriptApp.deleteTrigger(t);
    }
  });

  var sendHour = (CONFIG.FOLLOWUP_CADENCE && CONFIG.FOLLOWUP_CADENCE.sendHour) || 9;
  ScriptApp.newTrigger('processScheduledFollowUps')
    .timeBased()
    .atHour(sendHour)
    .everyDays(1)
    .create();

  Logger.log('Follow-up trigger set for daily at ' + sendHour + ':00');
}

// ═══════════════════════════════════════════════════════════════════════
// ─── GEMINI-GROUNDED URL→ORG RECOVERY (PATCH 2026-05-17) ──────────────
// ═══════════════════════════════════════════════════════════════════════
//
// Third-tier recovery for URL-only leads when:
//   - APK Vision returned blank (only URL + slug-decoded name posted)
//   - Apollo /people/match doesn't have this person indexed
//   - lead.organization is empty → cascade hits 'no_org_to_guess_from'
//
// Strategy: one Gemini grounded-search call asks the web for the person's
// current organization + designation. Cheap (~$0.0001), single call,
// ~10-20s latency. Recovered fields are explicitly annotated in NOTES as
// "web-search-derived" so the user knows to verify before send.
//
// Why this is appropriate now (not earlier):
//   - Pipeline already has Apollo as Tier 1 of email recovery (authoritative)
//   - Apollo has known weak coverage of India / less-prominent profiles
//   - Without a third layer, those leads sit at NEEDS_EMAIL forever
//   - The cost is bounded (one Gemini call per Apollo-missed lead)
//
// Why NOT use this on EVERY lead:
//   - Apollo is more authoritative and faster when it hits (cached, indexed)
//   - Gemini grounding can produce confident-sounding wrong answers
//     (LinkedIn snippets sometimes show stale orgs from cached pages)
//   - This is a LAST RESORT only, gated to Apollo-missed + org-blank
//
// Returns: { fullName, designation, organization, confidence } or null

function _recoverLeadFromLinkedInUrl(linkedinUrl, hintName) {
  if (typeof callGeminiGrounded !== 'function') {
    Logger.log('[_recoverLeadFromLinkedInUrl] callGeminiGrounded unavailable');
    return null;
  }
  if (!linkedinUrl || !/linkedin\.com\/in\//i.test(linkedinUrl)) return null;

  // Normalize URL (strip utm_, fragments, trailing slash)
  var cleanUrl = linkedinUrl.split('?')[0].split('#')[0].replace(/\/$/, '');

  var prompt =
    'Find the current LinkedIn profile data for: ' + cleanUrl + '\n' +
    (hintName ? 'Suggested name (verify): ' + hintName + '\n' : '') +
    '\n' +
    'Use Google Search to verify. Return STRICT JSON only, no prose, no markdown fences:\n' +
    '{\n' +
    '  "fullName": "person\'s full name as listed on LinkedIn",\n' +
    '  "designation": "their CURRENT job title",\n' +
    '  "organization": "their CURRENT employer — just the company name, no descriptions",\n' +
    '  "confidence": "high" | "medium" | "low"\n' +
    '}\n' +
    '\n' +
    'Rules:\n' +
    '- The "organization" field must be a real company name (e.g., "Razorpay", "Amazon India", "Flipkart").\n' +
    '  NOT a job title. NOT a description. NOT "former" or "ex-" companies.\n' +
    '- If you cannot reliably find this specific person via web search:\n' +
    '  return {"fullName": "", "designation": "", "organization": "", "confidence": "low"}\n' +
    '- "designation" is the CURRENT job title only (e.g., "Senior Product Manager"), no company in it.\n' +
    '- Confidence: "high" if you found multiple corroborating sources; "medium" if one source;\n' +
    '  "low" if uncertain or inferring from sparse data.';

  var result;
  try {
    result = callGeminiGrounded(prompt, { temperature: 0.1, maxTokens: 600 });
  } catch (callErr) {
    Logger.log('[_recoverLeadFromLinkedInUrl] callGeminiGrounded threw: ' + callErr.message);
    return null;
  }

  if (!result || !result.success || !result.data) {
    Logger.log('[_recoverLeadFromLinkedInUrl] No data returned for ' + cleanUrl);
    return null;
  }

  // Parse JSON — Gemini grounded sometimes wraps in prose, so use regex extract
  var text = result.data.toString();
  // Strip markdown fences if present
  text = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
  // Find the first { ... } block containing "organization"
  var jsonMatch = text.match(/\{[\s\S]*?"organization"[\s\S]*?\}/);
  if (!jsonMatch) {
    Logger.log('[_recoverLeadFromLinkedInUrl] Could not extract JSON from Gemini response: ' +
               text.substring(0, 200));
    return null;
  }

  try {
    var parsed = JSON.parse(jsonMatch[0]);
    var org = (parsed.organization || '').toString().trim();
    // Reject low-confidence + empty org responses
    if (!org || org.length < 2) return null;
    // Reject obviously-wrong org strings (Gemini sometimes returns descriptions)
    if (org.length > 80) {
      Logger.log('[_recoverLeadFromLinkedInUrl] Rejecting org > 80 chars (likely description): ' + org);
      return null;
    }
    return {
      fullName: (parsed.fullName || '').toString().trim(),
      designation: (parsed.designation || '').toString().trim(),
      organization: org,
      confidence: (parsed.confidence || 'unknown').toString().toLowerCase()
    };
  } catch (parseErr) {
    Logger.log('[_recoverLeadFromLinkedInUrl] JSON parse failed: ' + parseErr.message +
               ' on text: ' + jsonMatch[0].substring(0, 200));
    return null;
  }
}
