/**
 * ============================================================
 * PipelineHealthDiagnostic.gs — one-call full system diagnostic
 * (Patch 2026-05-19)
 * ============================================================
 *
 * Why this exists: when the user says "no drafts in Gmail", the gap
 * could be anywhere — owner-account mismatch, all leads dying pre-
 * compose, drafts created but immediately deleted, or a quiet code
 * path failure. This endpoint surfaces every relevant signal in
 * ONE response so the diagnosis is one round-trip:
 *
 *   1. Script owner email vs effective user (owner-account mismatch
 *      explains the "no drafts in my mailbox" complaint when drafts
 *      ARE being created — just in a different Google account)
 *   2. Gmail Drafts count + the 5 most-recent subjects/recipients
 *      (proves whether drafts exist at all in the script-owner's Gmail)
 *   3. Last N leads with status + key state fields + notes preview
 *      (so we can see exactly where in the pipeline they exited)
 *   4. Status distribution across the whole sheet
 *   5. Recent Apps Script execution summary (timestamp of last
 *      successful pipeline run, if visible)
 *   6. The CONFIG.PROPERTY_KEYS values masked (proves key presence)
 *
 * Endpoint: /exec?action=diagnose_pipeline_health&token=<ADMIN>
 *           /exec?action=diagnose_pipeline_health&n=10&token=<ADMIN>
 */

function diagnosePipelineHealth(options) {
  options = options || {};
  var n = options.n || 5;

  var result = {
    timestamp: new Date().toISOString(),
    accountInfo: _diagAccountInfo(),
    gmailDrafts: _diagGmailDrafts(),
    lastNLeads: _diagLastNLeads(n),
    statusDistribution: _diagStatusDistribution(),
    apiKeyPresence: _diagApiKeyPresence(),
    triggerHealth: _diagTriggerHealth(),
    recentErrors: _diagRecentErrors()
  };

  // Auto-synthesized verdict
  result.verdict = _diagSynthesizeVerdict(result);

  return result;
}

// ─── DIAGNOSTIC COMPONENTS ────────────────────────────────────────────────

function _diagAccountInfo() {
  var info = {};
  try {
    info.scriptOwnerViaDriveAccess = '<cannot probe>';
    // Use Session.getEffectiveUser (often returns owner in trigger context)
    try { info.effectiveUser = Session.getEffectiveUser().getEmail() || '<empty>'; }
    catch (e) { info.effectiveUser = '<threw: ' + e.message + '>'; }
    // Active user (current invoker — usually empty in trigger contexts)
    try { info.activeUser = Session.getActiveUser().getEmail() || '<empty>'; }
    catch (e) { info.activeUser = '<threw: ' + e.message + '>'; }
    // Gmail aliases — proves Gmail-side identity
    try { info.gmailAliases = GmailApp.getAliases() || []; }
    catch (e) { info.gmailAliases = '<threw: ' + e.message + '>'; }
    // Where Gmail thinks "my email" is — used to identify drafts the script created
    try {
      // The first sent message in the script-owner's Gmail
      var sentSample = GmailApp.search('in:sent', 0, 1);
      if (sentSample.length > 0) {
        var firstMsg = sentSample[0].getMessages()[0];
        info.gmailFromHeader = firstMsg.getFrom() || '<empty>';
      } else {
        info.gmailFromHeader = '<no_sent_messages_in_account>';
      }
    } catch (e) {
      info.gmailFromHeader = '<threw: ' + e.message + '>';
    }
  } catch (outerErr) {
    info.error = outerErr.message;
  }
  return info;
}

function _diagGmailDrafts() {
  var info = { totalCount: 0, recentSubjects: [], error: null };
  try {
    var drafts = GmailApp.getDrafts();
    info.totalCount = drafts.length;
    var sample = drafts.slice(-10).reverse();  // most recent 10
    sample.forEach(function(d) {
      try {
        var msg = d.getMessage();
        info.recentSubjects.push({
          draftId: d.getId(),
          subject: (msg.getSubject() || '<no subject>').substring(0, 120),
          to: (msg.getTo() || '<no to>').substring(0, 80),
          date: msg.getDate().toISOString()
        });
      } catch (innerErr) {
        info.recentSubjects.push({ draftId: d.getId(), error: innerErr.message });
      }
    });
  } catch (e) {
    info.error = e.message;
  }
  return info;
}

function _diagLastNLeads(n) {
  var result = { count: 0, leads: [] };
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (!sheet || sheet.getLastRow() < 2) return result;
    var c = CONFIG.COLUMNS;
    var lastRow = sheet.getLastRow();
    var startRow = Math.max(2, lastRow - n + 1);
    var data = sheet.getRange(startRow, 1, lastRow - startRow + 1, CONFIG.SHEET_COL_COUNT).getValues();
    for (var i = data.length - 1; i >= 0; i--) {  // most recent first
      var row = data[i];
      var rowNum = startRow + i;
      result.leads.push({
        rowNum: rowNum,
        linkedinUrl: (row[c.LINKEDIN_URL - 1] || '').toString().substring(0, 120),
        fullName: (row[c.FULL_NAME - 1] || '').toString(),
        organization: (row[c.ORGANIZATION - 1] || '').toString(),
        email: (row[c.EMAIL - 1] || '').toString(),
        status: (row[c.STATUS - 1] || '<blank>').toString(),
        archetype: (row[c.ARCHETYPE - 1] || '').toString(),
        template: (row[c.TEMPLATE - 1] || '').toString(),
        draftId: (row[c.DRAFT_ID - 1] || '').toString(),
        threadId: (row[c.THREAD_ID - 1] || '').toString(),
        enrichedEmail: (row[c.ENRICHED_EMAIL - 1] || '').toString(),
        emailSource: (row[c.EMAIL_SOURCE - 1] || '').toString(),
        emailConfidence: (row[c.EMAIL_CONFIDENCE - 1] || '').toString(),
        sentDate: (row[c.SENT_DATE - 1] || '').toString(),
        lastUpdated: (row[c.LAST_UPDATED - 1] || '').toString(),
        notesPreview: (row[c.NOTES - 1] || '').toString().substring(0, 400)
      });
    }
    result.count = result.leads.length;
  } catch (e) {
    result.error = e.message;
  }
  return result;
}

function _diagStatusDistribution() {
  var result = { total: 0, dist: {} };
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (!sheet || sheet.getLastRow() < 2) return result;
    var statuses = sheet.getRange(2, CONFIG.COLUMNS.STATUS, sheet.getLastRow() - 1, 1).getValues();
    statuses.forEach(function(r) {
      var s = (r[0] || '<blank>').toString().trim() || '<blank>';
      result.dist[s] = (result.dist[s] || 0) + 1;
      result.total++;
    });
  } catch (e) {
    result.error = e.message;
  }
  return result;
}

function _diagApiKeyPresence() {
  var props = PropertiesService.getScriptProperties();
  var keys = ['APOLLO_API_KEY', 'APOLLO_API_KEY_FALLBACK', 'HUNTER_API_KEY',
              'REOON_API_KEY', 'CLAUDE_API_KEY', 'GEMINI_API_KEY',
              'AUTOMAIL_WEBAPP_SECRET', 'ADMIN_TOKEN',
              'LOR_DRIVE_ID', 'RESUME_DRIVE_ID_GROWTH',
              'RESUME_DRIVE_ID_OPS', 'RESUME_DRIVE_ID_PRODUCT',
              'FCM_SERVICE_ACCOUNT_JSON'];
  var out = {};
  keys.forEach(function(k) {
    var v = props.getProperty(k) || '';
    out[k] = v ? { set: true, length: v.length, preview: v.substring(0, 6) + '...' }
               : { set: false };
  });
  return out;
}

function _diagTriggerHealth() {
  var triggers = ScriptApp.getProjectTriggers();
  var summary = {};
  triggers.forEach(function(t) {
    var name = t.getHandlerFunction();
    summary[name] = (summary[name] || 0) + 1;
  });
  return { totalInstalled: triggers.length, byHandler: summary };
}

function _diagRecentErrors() {
  // Scan last 30 rows of the data sheet for any with STATUS=ERROR or RETRIES_EXHAUSTED markers
  var result = { count: 0, recent: [] };
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (!sheet || sheet.getLastRow() < 2) return result;
    var c = CONFIG.COLUMNS;
    var lastRow = sheet.getLastRow();
    var startRow = Math.max(2, lastRow - 30);
    var data = sheet.getRange(startRow, 1, lastRow - startRow + 1, CONFIG.SHEET_COL_COUNT).getValues();
    for (var i = 0; i < data.length; i++) {
      var status = (data[i][c.STATUS - 1] || '').toString().trim();
      var notes = (data[i][c.NOTES - 1] || '').toString();
      if (status === 'ERROR' || notes.indexOf('RETRIES_EXHAUSTED') >= 0 || notes.indexOf('FATAL') >= 0) {
        result.recent.push({
          rowNum: startRow + i,
          status: status,
          notesExcerpt: notes.substring(0, 400)
        });
        result.count++;
      }
    }
  } catch (e) {
    result.error = e.message;
  }
  return result;
}

// ─── VERDICT SYNTHESIZER ──────────────────────────────────────────────────

function _diagSynthesizeVerdict(d) {
  var verdict = { headline: '', primaryConcerns: [], suggestedActions: [] };

  // Account-mismatch check
  var aliases = Array.isArray(d.accountInfo.gmailAliases) ? d.accountInfo.gmailAliases : [];
  var fromHeader = (d.accountInfo.gmailFromHeader || '').toString();
  if (aliases.length === 0 && fromHeader.indexOf('<empty>') < 0 && fromHeader.indexOf('<threw') < 0) {
    verdict.primaryConcerns.push('No Gmail aliases registered — script may be running as a different account than you check for drafts');
  }

  // Draft count check
  var draftCount = d.gmailDrafts.totalCount || 0;
  if (draftCount === 0) {
    verdict.primaryConcerns.push('ZERO drafts in script-owner\'s Gmail. Either no draft was ever created, or the script owns a different Gmail account than you check.');
    verdict.suggestedActions.push('Verify Apps Script project owner matches your Gmail by visiting Apps Script project settings');
  } else {
    verdict.primaryConcerns.push(draftCount + ' drafts exist in script-owner\'s Gmail. Check Drafts in the account: ' + (d.accountInfo.effectiveUser || '<unknown>'));
  }

  // Status distribution
  var dist = d.statusDistribution.dist || {};
  var draftCreatedCount = dist['DRAFT_CREATED'] || 0;
  var needsReviewCount = dist['NEEDS_REVIEW'] || 0;
  var reviewCount = dist['REVIEW'] || 0;
  var expectsDraft = draftCreatedCount + needsReviewCount + reviewCount;
  if (expectsDraft === 0) {
    verdict.primaryConcerns.push('No leads have reached DRAFT_CREATED/NEEDS_REVIEW/REVIEW status. Compose stage is never producing drafts.');
  } else if (expectsDraft !== draftCount) {
    verdict.primaryConcerns.push('Status sheet says ' + expectsDraft + ' rows should have drafts (DRAFT_CREATED+NEEDS_REVIEW+REVIEW), but Gmail has ' + draftCount + ' drafts. Mismatch.');
  }

  // API key presence — quick sniff for the obvious
  var ak = d.apiKeyPresence;
  if (ak.CLAUDE_API_KEY && !ak.CLAUDE_API_KEY.set) verdict.primaryConcerns.push('CLAUDE_API_KEY not set — compose will fail');
  if (ak.GEMINI_API_KEY && !ak.GEMINI_API_KEY.set) verdict.primaryConcerns.push('GEMINI_API_KEY not set — research will fail');
  if (ak.APOLLO_API_KEY && !ak.APOLLO_API_KEY.set) verdict.primaryConcerns.push('APOLLO_API_KEY not set — primary enrichment unavailable');
  if (ak.REOON_API_KEY && !ak.REOON_API_KEY.set) verdict.primaryConcerns.push('REOON_API_KEY not set — email verification disabled');

  // Recent errors
  if (d.recentErrors.count > 0) {
    verdict.primaryConcerns.push(d.recentErrors.count + ' recent rows with ERROR / FATAL / RETRIES_EXHAUSTED notes');
  }

  // Lead-level analysis
  var leadsAtEnrichmentExit = (dist['NEEDS_EMAIL'] || 0) + (dist['NEEDS_EMAIL_REVIEW'] || 0);
  if (leadsAtEnrichmentExit > 5 && draftCreatedCount === 0) {
    verdict.primaryConcerns.push('Most leads are exiting at email-enrichment (' + leadsAtEnrichmentExit + ' at NEEDS_EMAIL/NEEDS_EMAIL_REVIEW). Suggests Apollo + Hunter + pattern-guess all failing on these. Verify keys are live with test_reoon_key + APOLLO test.');
  }

  // Headline
  if (verdict.primaryConcerns.length === 0) {
    verdict.headline = 'No obvious issues detected. Pipeline appears healthy.';
  } else {
    verdict.headline = 'Likely root cause: ' + verdict.primaryConcerns[0];
  }

  return verdict;
}
