/**
     * ============================================================
     * Code.gs — AutoMail Pipeline: Main Entry Point & Orchestrator
     * Custom menu, setup wizard, single-lead processing,
     * dashboard, and all user-facing functions.
     * ============================================================
     */

// ─── CUSTOM MENU ───────────────────────────────────────────

function onOpen() {
  // PATCH Phase 8 (F-29 fix): bootstrap the PipelineWatchdog trigger if it has
  // been silently dropped (auth re-grant, quota event, manual menu removal).
  // onOpen runs in AuthMode.LIMITED but ScriptApp.getProjectTriggers() and
  // newTrigger().create() are reachable at that scope. Failures are silent —
  // the user still gets the menu; just the auto-heal didn't kick in. The
  // explicit menu "Setup Auto-Process Trigger" remains as the escape hatch.
  try {
    var hasWatchdog = ScriptApp.getProjectTriggers().some(function(t) {
      return t.getHandlerFunction() === 'pipelineWatchdog';
    });
    if (!hasWatchdog && typeof installPipelineWatchdog === 'function') {
      installPipelineWatchdog();
    }
  } catch (_) {
    // Silent — onOpen MUST NOT throw or the menu disappears
  }

  var ui = SpreadsheetApp.getUi();
  ui.createMenu('AutoMail Pipeline')
    .addItem('Run Pipeline (Next Batch)', 'menuRunBatch')
    .addItem('Process Single Lead (Current Row)', 'menuProcessCurrentRow')
    .addSeparator()
    .addItem('Create Draft for Current Row', 'menuCreateDraftCurrentRow')
    .addItem('Open Pipeline Dashboard (Sidebar)', 'showSidebar')
    .addItem('View Pipeline Dashboard (Modal)', 'menuShowDashboard')
    .addSeparator()
    .addSubMenu(ui.createMenu('Setup')
      .addItem('⚡ Quick Setup (Columns + Keys)', 'menuQuickSetup')
      .addSeparator()
      .addItem('1. Initialize Pipeline Columns', 'initializePipelineColumns')
      .addItem('2. Set API Keys', 'menuSetApiKeys')
      .addItem('3. Set Resume Drive IDs', 'menuSetResumeDriveIds')
      .addItem('4. Test API Connections', 'testApiConnections')
      .addItem('5. Setup Follow-Up Trigger', 'setupFollowUpTrigger')
      .addItem('6. Setup Auto-Process Trigger (Sheet2 onEdit)', 'setupAutoProcessTrigger')
      .addItem('7. Bootstrap Reoon + LOR + Web App Secret', 'menuBootstrapReoonLor')
      .addItem('8. Clear Reoon Verify Cache', 'clearReoonCache')
      .addItem('9. Install WebApp Warm-Keeper (fixes Tracking-tab timeout)', 'menuInstallWarmKeeper'))
    .addSubMenu(ui.createMenu('Tools')
      .addItem('Research Only (Current Row)', 'menuResearchCurrentRow')
      .addItem('Classify Only (Current Row)', 'menuClassifyCurrentRow')
      .addItem('Check Send Timing', 'menuCheckTiming')
      .addItem('View Company Clusters', 'menuShowClusters')
      .addItem('List Pipeline Drafts', 'menuListDrafts')
      .addItem('Reset Current Row Status', 'menuResetCurrentRow')
      .addSeparator()
      .addItem('View Run Diagnostics', 'menuViewDiagnostics')
      .addItem('View Errors for Current Row', 'menuViewRowErrors')
      .addSeparator()
      // PATCH Phase 1 remediation sprint (A13 closure): Tests.gs harness wiring.
      // runAllTests() is the spine for the entire remediation sprint TDD discipline.
      .addItem('🧪 Run all tests', 'menuRunAllTests')
      .addItem('🧪 Run smoke tests only', 'menuRunSmokeTests'))
    .addSeparator()
    .addItem('Remove All Triggers (Emergency)', 'removeAllTriggers')
    .addToUi();
}

// ─── QUICK SETUP ──────────────────────────────────────────

/**
 * One-click setup: initializes columns, sets API keys, and tests connections.
 * Run this once after deploying the project.
 */
function menuQuickSetup() {
  var ui = SpreadsheetApp.getUi();
  var log = [];

  // Step 1: Initialize columns
  try {
    initializePipelineColumns();
    log.push('✓ Pipeline columns initialized');
  } catch (e) {
    log.push('✗ Column setup failed: ' + e.message);
  }

  // Step 2: Auto-set API keys
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('CLAUDE_API_KEY')) {
    props.setProperty('CLAUDE_API_KEY', 'YOUR_CLAUDE_API_KEY');
    log.push('✓ Claude API key set');
  } else {
    log.push('✓ Claude API key (already set)');
  }

  if (!props.getProperty('GEMINI_API_KEY')) {
    props.setProperty('GEMINI_API_KEY', 'YOUR_GEMINI_API_KEY');
    log.push('✓ Gemini API key set');
  } else {
    log.push('✓ Gemini API key (already set)');
  }

  // Step 2.5: Auto-discover resume Drive IDs from Google Drive
  try {
    var resumeMap = {
      'RESUME_DRIVE_ID_GROWTH': 'Resume_Gaurav_Growth_Marketing_2page.pdf',
      'RESUME_DRIVE_ID_OPS': 'Resume_Gaurav_Ops_Consulting_Generalist_2page.pdf',
      'RESUME_DRIVE_ID_PRODUCT': 'Resume_Gaurav_Product_AI_Strategy_2page.pdf'
    };
    var resumeFound = 0;
    for (var propKey in resumeMap) {
      if (!props.getProperty(propKey)) {
        var files = DriveApp.getFilesByName(resumeMap[propKey]);
        if (files.hasNext()) {
          var file = files.next();
          props.setProperty(propKey, file.getId());
          log.push('✓ ' + resumeMap[propKey] + ' found in Drive (ID: ' + file.getId().substring(0, 8) + '...)');
          resumeFound++;
        } else {
          log.push('⚠ ' + resumeMap[propKey] + ' not found in Drive — upload it first');
        }
      } else {
        log.push('✓ ' + propKey + ' (already set)');
        resumeFound++;
      }
    }
  } catch (e) {
    log.push('⚠ Resume auto-discovery failed: ' + e.message);
  }

  // Step 3: Test API connections
  try {
    var geminiResult = callGemini('Reply with exactly: OK', { temperature: 0, maxTokens: 10 });
    log.push(geminiResult.success ? '✓ Gemini API connected' : '✗ Gemini: ' + geminiResult.error);
  } catch (e) {
    log.push('✗ Gemini test failed: ' + e.message);
  }

  try {
    var claudeResult = callClaude('Reply with exactly: OK', { temperature: 0, maxTokens: 10 });
    log.push(claudeResult.success ? '✓ Claude API connected' : '✗ Claude: ' + claudeResult.error);
  } catch (e) {
    log.push('✗ Claude test failed: ' + e.message);
  }

  // Step 4: Create PipelineLog sheet if missing
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    if (!ss.getSheetByName(CONFIG.LOG_SHEET)) {
      var logSheet = ss.insertSheet(CONFIG.LOG_SHEET);
      logSheet.appendRow(['Timestamp', 'Run_ID', 'Row', 'Stage', 'Level', 'Message']);
      logSheet.getRange(1, 1, 1, 6).setFontWeight('bold');
      log.push('✓ PipelineLog sheet created');
    } else {
      log.push('✓ PipelineLog sheet exists');
    }

    // Step 4b: Create FollowUps sheet if missing
    if (!ss.getSheetByName('FollowUps')) {
      var fuSheet = ss.insertSheet('FollowUps');
      fuSheet.appendRow(['Email', 'ScheduledDate', 'Subject', 'Body', 'Status', 'LeadName', 'Stage']);
      fuSheet.getRange(1, 1, 1, 7).setFontWeight('bold');
      log.push('✓ FollowUps sheet created');
    } else {
      log.push('✓ FollowUps sheet exists');
    }
  } catch (e) {
    log.push('⚠ Sheet creation failed: ' + e.message);
  }

  ui.alert('Quick Setup Complete', log.join('\n'), ui.ButtonSet.OK);
}

// ─── BOOTSTRAP REOON + LOR + WEB APP SECRET ────────────────
//
// Two callable forms:
//   menuBootstrapReoonLor()           — interactive (Browser.inputBox prompts)
//   _bootstrapSecrets(reoon, lor, sec)— headless (clasp run --params [...])
//
// Both write to PropertiesService.getScriptProperties() so the literal
// values never live in source. menuBootstrapReoonLor() also prompts a
// Quick Setup re-run so the resume IDs and base API keys are set in one go.

/**
 * Interactive bootstrap — prompts for Reoon API key, LOR Drive ID, and Web App secret.
 * Call this from the AutoMail Pipeline → Setup menu.
 */
function menuBootstrapReoonLor() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();

  // Reoon API key
  var reoonKeyName = (CONFIG.PROPERTY_KEYS && CONFIG.PROPERTY_KEYS.REOON_API_KEY) || 'REOON_API_KEY';
  var existing = props.getProperty(reoonKeyName);
  var promptMsg = existing
    ? 'Reoon API key is already set (length=' + existing.length + '). Paste a new key to replace it, or click Cancel to keep.'
    : 'Paste your Reoon Email Verifier API key (looks like ak_XXXXXXXXXXXX). Get one at reoon.com — free tier is 600 verifications/month.';
  var resp = ui.prompt('Reoon API Key', promptMsg, ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() === ui.Button.OK) {
    var k = resp.getResponseText().trim();
    if (k && k.length > 8) {
      props.setProperty(reoonKeyName, k);
      ui.alert('Reoon key saved.');
    }
  }

  // Hunter.io API key (optional fallback for hard-to-find emails)
  var hunterKeyName = (CONFIG.PROPERTY_KEYS && CONFIG.PROPERTY_KEYS.HUNTER_API_KEY) || 'HUNTER_API_KEY';
  var existingHunter = props.getProperty(hunterKeyName);
  var hunterMsg = existingHunter
    ? 'Hunter.io API key is set (length=' + existingHunter.length + '). Paste a new key to replace, or click Cancel to keep.'
    : '(Optional) Paste your Hunter.io API key for the Email Finder fallback — kicks in only when Reoon can\'t verify any of the 5 guessed patterns. Free tier is 25 lookups/month at hunter.io. Click Cancel to skip.';
  var hresp = ui.prompt('Hunter.io API Key (optional)', hunterMsg, ui.ButtonSet.OK_CANCEL);
  if (hresp.getSelectedButton() === ui.Button.OK) {
    var hk = hresp.getResponseText().trim();
    if (hk && hk.length > 8) {
      props.setProperty(hunterKeyName, hk);
      ui.alert('Hunter.io key saved.');
    }
  }

  // LOR Drive ID
  var lorKeyName = (CONFIG.PROPERTY_KEYS && CONFIG.PROPERTY_KEYS.LOR_DRIVE_ID) || 'LOR_DRIVE_ID';
  var existingLor = props.getProperty(lorKeyName);
  var lorMsg = existingLor
    ? 'LOR Drive ID is set (' + existingLor.substring(0, 12) + '...). Paste a new ID to replace.'
    : 'Paste the Drive file ID for your Letter of Recommendation PDF.\n\nTo get it: open the LOR in Drive → Share → Copy link → take the segment between /d/ and /view.';
  var lresp = ui.prompt('LOR Drive ID', lorMsg, ui.ButtonSet.OK_CANCEL);
  if (lresp.getSelectedButton() === ui.Button.OK) {
    var lid = lresp.getResponseText().trim();
    if (lid && lid.length > 10) {
      props.setProperty(lorKeyName, lid);
      ui.alert('LOR Drive ID saved.');
    }
  }

  // Web App secret — auto-generate if not set
  var secKeyName = (CONFIG.PROPERTY_KEYS && CONFIG.PROPERTY_KEYS.AUTOMAIL_WEBAPP_SECRET) || 'AUTOMAIL_WEBAPP_SECRET';
  var existingSec = props.getProperty(secKeyName);
  if (!existingSec) {
    var newSec = Utilities.getUuid();
    props.setProperty(secKeyName, newSec);
    ui.alert(
      'Web App secret generated',
      'A shared secret has been generated for the share-target Web App.\n\n' +
      'You DO NOT need to memorize it — it lives in Script Properties.\n\n' +
      'When you deploy the Web App (Tools → Deploy → New deployment → Web app), the URL is what you paste into:\n' +
      '  • Chrome extension popup → Settings → AutoMail Pipeline\n' +
      '  • PWA index.html configuration\n\n' +
      'Both clients send the secret automatically once you save it via the popup.\n\n' +
      'To rotate the secret later, run this menu item again.',
      ui.ButtonSet.OK
    );
  } else {
    ui.alert('Web App secret already set (length ' + existingSec.length + '). Keeping existing value.');
  }
}

/**
 * Headless bootstrap — invoked via `clasp run _bootstrapSecrets --params [...]`.
 * Order: [reoonApiKey, lorDriveId, webAppSecret?]. webAppSecret auto-generates if omitted.
 *
 * @param {string} reoonApiKey
 * @param {string} lorDriveId
 * @param {string} [webAppSecret]
 * @returns {Object} status report
 */
function _bootstrapSecrets(reoonApiKey, lorDriveId, webAppSecret) {
  var props = PropertiesService.getScriptProperties();
  var report = { reoon: false, lor: false, secret: false };

  var keys = (CONFIG.PROPERTY_KEYS) || {
    REOON_API_KEY: 'REOON_API_KEY',
    LOR_DRIVE_ID: 'LOR_DRIVE_ID',
    AUTOMAIL_WEBAPP_SECRET: 'AUTOMAIL_WEBAPP_SECRET'
  };

  if (reoonApiKey && typeof reoonApiKey === 'string' && reoonApiKey.length > 8) {
    props.setProperty(keys.REOON_API_KEY, reoonApiKey.trim());
    report.reoon = true;
  }
  if (lorDriveId && typeof lorDriveId === 'string' && lorDriveId.length > 10) {
    props.setProperty(keys.LOR_DRIVE_ID, lorDriveId.trim());
    report.lor = true;
  }
  var sec = (webAppSecret && webAppSecret.length > 16) ? webAppSecret : Utilities.getUuid();
  if (!props.getProperty(keys.AUTOMAIL_WEBAPP_SECRET)) {
    props.setProperty(keys.AUTOMAIL_WEBAPP_SECRET, sec);
    report.secret = true;
  } else {
    report.secret = 'kept_existing';
  }

  Logger.log('[Bootstrap] ' + JSON.stringify(report));
  return report;
}

// ─── MENU ACTIONS ──────────────────────────────────────────

/**
 * Runs the next batch of leads through the pipeline.
 */
function menuRunBatch() {
  var ui = SpreadsheetApp.getUi();
  var counts = getLeadStatusCounts();
  var newCount = counts[STATUS.NEW] || counts[''] || 0;

  if (newCount === 0) {
    ui.alert('No Leads', 'No NEW leads found in Sheet2. All leads have been processed or are in progress.', ui.ButtonSet.OK);
    return;
  }

  var response = ui.alert(
    'Run Pipeline',
    'Found ' + newCount + ' NEW leads.\nProcess next batch of ' + Math.min(newCount, CONFIG.BATCH_SIZE) + '?\n\n' +
    'This will: Research → Classify → Select Resume → Compose Email → Humanize → Quality Check → Create Gmail Drafts',
    ui.ButtonSet.YES_NO
  );

  if (response === ui.Button.YES) {
    ui.alert('Pipeline Started', 'Processing batch in background. Check the Pipeline_Status column for progress.', ui.ButtonSet.OK);
    Logger.log('[Code.gs] Starting menu batch run with context: MENU_BATCH');
    processNextBatch(true); // force=true to bypass timing check for manual runs
  }
}

/**
 * Processes the single lead in the currently selected row.
 */
function menuProcessCurrentRow() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSheet();
  var rowNum = sheet.getActiveCell().getRow();

  if (rowNum < 2) {
    ui.alert('Please select a data row (row 2 or below).');
    return;
  }

  var lead = getLeadByRow(rowNum);
  if (!lead || !lead.email) {
    ui.alert('No valid lead data found in row ' + rowNum + '. Ensure Name and Email are filled.');
    return;
  }

  var response = ui.alert(
    'Process Lead',
    'Process ' + lead.fullName + ' (' + lead.designation + ' @ ' + lead.organization + ')?\n\nEmail: ' + lead.email,
    ui.ButtonSet.YES_NO
  );

  if (response === ui.Button.YES) {
    startPipelineRun('SINGLE_ROW_' + rowNum);
    try {
      updateLeadStatus(rowNum, STATUS.NEW);
      _processOneLead(lead);
      ui.alert('Done', 'Lead processed. Check columns G-U for results.', ui.ButtonSet.OK);
    } catch (e) {
      ui.alert('Error', 'Processing failed: ' + e.message, ui.ButtonSet.OK);
    } finally {
      endPipelineRun();
    }
  }
}

/**
 * Creates a Gmail draft for the current row (if email exists).
 */
function menuCreateDraftCurrentRow() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSheet();
  var rowNum = sheet.getActiveCell().getRow();

  if (rowNum < 2) {
    ui.alert('Please select a data row.');
    return;
  }

  var lead = getLeadByRow(rowNum);
  if (!lead || !lead.subjectLine || !lead.emailBody) {
    ui.alert('No composed email found for this row. Run the full pipeline first.');
    return;
  }

  var response = ui.alert(
    'Create Draft',
    'Create Gmail draft for ' + lead.fullName + '?\n\n' +
    'To: ' + lead.email + '\n' +
    'Subject: ' + lead.subjectLine + '\n' +
    'Quality Score: ' + lead.qualityScore,
    ui.ButtonSet.YES_NO
  );

  if (response === ui.Button.YES) {
    var resumeVariantId = _getVariantIdFromLabel(lead.resumeVariant);
    var result = createDraft(lead, lead.subjectLine, lead.emailBody, { variantId: resumeVariantId });

    if (result.success) {
      // PATCH Phase 8 (F-10 fix): URL-keyed write protects against Sheet2 desync.
      var _menuOpts = lead.linkedinUrl ? { verifyUrl: lead.linkedinUrl } : undefined;
      updateLeadFields(rowNum, { DRAFT_ID: result.draftId, STATUS: STATUS.DRAFT_CREATED }, _menuOpts);
      ui.alert('Draft Created', 'Gmail draft created. ID: ' + result.draftId + '\nCheck your Gmail Drafts folder.', ui.ButtonSet.OK);
    } else {
      ui.alert('Error', 'Draft creation failed: ' + result.error, ui.ButtonSet.OK);
    }
  }
}

// ─── TOOL FUNCTIONS ────────────────────────────────────────

function menuResearchCurrentRow() {
  var ui = SpreadsheetApp.getUi();
  var rowNum = SpreadsheetApp.getActiveSheet().getActiveCell().getRow();
  if (rowNum < 2) { ui.alert('Select a data row.'); return; }

  var lead = getLeadByRow(rowNum);
  if (!lead) { ui.alert('No lead in this row.'); return; }

  ui.alert('Researching', 'Researching ' + lead.fullName + '...', ui.ButtonSet.OK);
  var compressed = researchLead(lead);
  var dossier = decompressDossier(JSON.stringify(compressed));

  var summary = 'Research Complete for ' + lead.fullName + '\n\n' +
    'Company: ' + (dossier.company ? (dossier.company.name || dossier.company) + ' (' + (dossier.industry || 'N/A') + ')' : 'N/A') + '\n' +
    'Hooks found: ' + (dossier.hooks ? dossier.hooks.length : 0) + '\n' +
    'Trigger events: ' + (dossier.triggerEvents ? dossier.triggerEvents.length : 0) + '\n' +
    'Shared background: ' + (dossier.sharedBackground ? dossier.sharedBackground.join(', ') : 'None');

  ui.alert('Research Results', summary, ui.ButtonSet.OK);
}

function menuClassifyCurrentRow() {
  var ui = SpreadsheetApp.getUi();
  var rowNum = SpreadsheetApp.getActiveSheet().getActiveCell().getRow();
  if (rowNum < 2) { ui.alert('Select a data row.'); return; }

  var lead = getLeadByRow(rowNum);
  if (!lead || !lead.researchJSON) { ui.alert('Research this lead first.'); return; }

  var dossier = decompressDossier(lead.researchJSON);
  var classification = classifyLead(lead, dossier);

  var summary = 'Classification for ' + lead.fullName + '\n\n' +
    'Archetype: ' + classification.archetype + '\n' +
    'Template: ' + classification.template + '\n' +
    'Approach: ' + classification.approach + '\n' +
    'Edge Cases: ' + (classification.edgeCases.join(', ') || 'None') + '\n' +
    'Reasoning: ' + (classification.reasoning || classification.approach || 'N/A');

  ui.alert('Classification Results', summary, ui.ButtonSet.OK);
}

function menuCheckTiming() {
  var timing = checkSendTiming();
  SpreadsheetApp.getUi().alert('Send Timing', timing.note, SpreadsheetApp.getUi().ButtonSet.OK);
}

function menuShowClusters() {
  var clusters = getCompanyClusters();
  var text = 'Company Clusters (multiple leads):\n\n';

  for (var org in clusters) {
    text += org + ': ' + clusters[org].length + ' leads\n';
    clusters[org].forEach(function(c) {
      text += '  - ' + c.fullName + ' (' + c.designation + ') — ' + c.seniority + '\n';
    });
    text += '\n';
  }

  if (Object.keys(clusters).length === 0) text = 'No company clusters found (all leads from unique companies).';

  SpreadsheetApp.getUi().alert('Company Clusters', text, SpreadsheetApp.getUi().ButtonSet.OK);
}

function menuListDrafts() {
  var drafts = listPipelineDrafts();
  var text = 'Pipeline Drafts (' + drafts.length + '):\n\n';

  drafts.forEach(function(d) {
    text += '- ' + d.fullName + ' (' + d.email + ')\n';
    text += '  Subject: ' + d.subject + '\n';
    text += '  Quality: ' + d.qualityScore + ' | Status: ' + d.status + '\n\n';
  });

  if (drafts.length === 0) text = 'No pipeline drafts found. Run the pipeline first.';

  SpreadsheetApp.getUi().alert('Pipeline Drafts', text, SpreadsheetApp.getUi().ButtonSet.OK);
}

function menuResetCurrentRow() {
  var ui = SpreadsheetApp.getUi();
  var rowNum = SpreadsheetApp.getActiveSheet().getActiveCell().getRow();
  if (rowNum < 2) { ui.alert('Select a data row.'); return; }

  var response = ui.alert('Reset Row', 'Reset all pipeline data for row ' + rowNum + '?\nThis clears status, research, email, and draft ID.', ui.ButtonSet.YES_NO);

  if (response === ui.Button.YES) {
    var sheet = _getDataSheet();
    var c = CONFIG.COLUMNS;
    // Clear columns G through U
    for (var col = c.STATUS; col <= c.LAST_UPDATED; col++) {
      sheet.getRange(rowNum, col).clearContent();
    }
    ui.alert('Row ' + rowNum + ' has been reset.');
  }
}

/**
 * Displays run diagnostics for the last N pipeline runs.
 */
function menuViewDiagnostics() {
  var report = getRunDiagnostics(5);
  SpreadsheetApp.getUi().alert('Pipeline Diagnostics', report, SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * Displays all errors for the currently selected row from the pipeline log.
 */
function menuViewRowErrors() {
  var ui = SpreadsheetApp.getUi();
  var rowNum = SpreadsheetApp.getActiveSheet().getActiveCell().getRow();
  if (rowNum < 2) { ui.alert('Select a data row.'); return; }

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var logSheet = ss.getSheetByName(CONFIG.LOG_SHEET);
  if (!logSheet) { ui.alert('No PipelineLog sheet found.'); return; }

  var lastRow = logSheet.getLastRow();
  if (lastRow < 2) { ui.alert('No log entries.'); return; }

  var data = logSheet.getRange(2, 1, lastRow - 1, 6).getValues();
  var errors = [];

  for (var i = 0; i < data.length; i++) {
    if (data[i][2] == rowNum && data[i][4] === 'ERROR') {
      errors.push(data[i][0] + ' [' + data[i][3] + ']: ' + (data[i][5] || '').substring(0, 150));
    }
  }

  if (errors.length === 0) {
    ui.alert('No Errors', 'No errors found for row ' + rowNum + '.', ui.ButtonSet.OK);
  } else {
    ui.alert('Errors for Row ' + rowNum + ' (' + errors.length + ')', errors.join('\n\n'), ui.ButtonSet.OK);
  }
}

// ─── SETUP WIZARD ──────────────────────────────────────────

function menuSetApiKeys() {
  var ui = SpreadsheetApp.getUi();

  // Auto-populate from embedded keys first
  var props = PropertiesService.getScriptProperties();
  var keysSet = [];

  // Set Claude key if not already set
  if (!props.getProperty('CLAUDE_API_KEY')) {
    props.setProperty('CLAUDE_API_KEY', 'YOUR_CLAUDE_API_KEY');
    keysSet.push('Claude API key (auto-set from embedded key)');
  } else {
    keysSet.push('Claude API key (already configured)');
  }

  // Set Gemini key if not already set
  if (!props.getProperty('GEMINI_API_KEY')) {
    props.setProperty('GEMINI_API_KEY', 'YOUR_GEMINI_API_KEY');
    keysSet.push('Gemini API key (auto-set from embedded key)');
  } else {
    keysSet.push('Gemini API key (already configured)');
  }

  ui.alert('API Keys Configuration',
    keysSet.join('\n') + '\n\nRun "Test API Connections" to verify.',
    ui.ButtonSet.OK);
}

function menuSetResumeDriveIds() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var log = [];

  var variants = [
    { key: 'RESUME_DRIVE_ID_GROWTH', label: 'Growth Marketing', fileName: 'Resume_Gaurav_Growth_Marketing_2page.pdf' },
    { key: 'RESUME_DRIVE_ID_OPS', label: 'Ops/Consulting', fileName: 'Resume_Gaurav_Ops_Consulting_Generalist_2page.pdf' },
    { key: 'RESUME_DRIVE_ID_PRODUCT', label: 'Product/AI/Strategy', fileName: 'Resume_Gaurav_Product_AI_Strategy_2page.pdf' }
  ];

  variants.forEach(function(v) {
    // Try auto-discovery first
    var files = DriveApp.getFilesByName(v.fileName);
    if (files.hasNext()) {
      var file = files.next();
      props.setProperty(v.key, file.getId());
      log.push('✓ ' + v.label + ': Auto-found! (ID: ' + file.getId().substring(0, 12) + '...)');
    } else {
      // Fall back to manual input
      var response = ui.prompt(
        'Set ' + v.label + ' Resume Drive ID',
        '"' + v.fileName + '" was NOT found in your Drive.\n\nUpload it to Drive, then paste the file ID here:\n(File ID = long string in Drive URL after /d/)',
        ui.ButtonSet.OK_CANCEL
      );
      if (response.getSelectedButton() === ui.Button.OK) {
        var fileId = response.getResponseText().trim();
        if (fileId) {
          props.setProperty(v.key, fileId);
          log.push('✓ ' + v.label + ': Manually set');
        } else {
          log.push('⚠ ' + v.label + ': Skipped (no ID entered)');
        }
      } else {
        log.push('⚠ ' + v.label + ': Skipped');
      }
    }
  });

  ui.alert('Resume Drive IDs', log.join('\n'), ui.ButtonSet.OK);
}

// ─── DASHBOARD ─────────────────────────────────────────────

function menuShowDashboard() {
  var counts = getLeadStatusCounts();
  var timing = checkSendTiming();

  var total = 0;
  for (var key in counts) { total += counts[key]; }

  var text = '════════════════════════════════\n' +
    '   AutoMail Pipeline Dashboard\n' +
    '════════════════════════════════\n\n' +
    'Total Leads: ' + total + '\n\n' +
    'Status Breakdown:\n';

  var statusOrder = [STATUS.NEW, STATUS.RESEARCHING, STATUS.RESEARCH_DONE, STATUS.CLASSIFYING,
                     STATUS.COMPOSING, STATUS.HUMANIZING, STATUS.QUALITY_CHECK, STATUS.REVIEW,
                     STATUS.DRAFT_CREATED, STATUS.SENT, STATUS.FOLLOWUP_1, STATUS.FOLLOWUP_2,
                     STATUS.FOLLOWUP_3, STATUS.RESPONDED, STATUS.SKIPPED, STATUS.ERROR];

  statusOrder.forEach(function(s) {
    if (counts[s] && counts[s] > 0) {
      text += '  ' + s + ': ' + counts[s] + '\n';
    }
  });

  text += '\nTiming: ' + timing.note + '\n';
  text += 'Season: ' + timing.season + ' hiring season\n';

  // API key status
  var props = PropertiesService.getScriptProperties();
  text += '\nAPI Keys:\n';
  text += '  Claude: ' + (props.getProperty('CLAUDE_API_KEY') ? 'SET' : 'NOT SET') + '\n';
  text += '  Gemini: ' + (props.getProperty('GEMINI_API_KEY') ? 'SET' : 'NOT SET') + '\n';

  // Resume IDs status
  text += '\nResume Drive IDs:\n';
  text += '  Growth: ' + (props.getProperty('RESUME_DRIVE_ID_GROWTH') ? 'SET' : 'NOT SET') + '\n';
  text += '  Ops: ' + (props.getProperty('RESUME_DRIVE_ID_OPS') ? 'SET' : 'NOT SET') + '\n';
  text += '  Product: ' + (props.getProperty('RESUME_DRIVE_ID_PRODUCT') ? 'SET' : 'NOT SET') + '\n';

  SpreadsheetApp.getUi().alert('Pipeline Dashboard', text, SpreadsheetApp.getUi().ButtonSet.OK);
}

// ─── WARM-KEEPER MENU (PATCH 2026-05-15) ───────────────────────────
//
// One-click installer for the WebApp warm-keeper trigger. Run once after
// deployment to eliminate the APK Tracking-tab cold-start timeout
// ("Couldn't load tracking data" flash on first open).
function menuInstallWarmKeeper() {
  var ui = SpreadsheetApp.getUi();
  try {
    if (typeof installWebAppWarmKeeperTrigger !== 'function') {
      ui.alert('WarmKeeper unavailable',
        'installWebAppWarmKeeperTrigger() is missing — pull the latest BatchProcessor.gs and try again.',
        ui.ButtonSet.OK);
      return;
    }
    var result = installWebAppWarmKeeperTrigger();
    var url = '';
    try { url = ScriptApp.getService().getUrl() || '(not deployed yet)'; } catch (_) {}
    ui.alert('Warm-keeper trigger',
      'Status: ' + result + '\n\n' +
      'The trigger pings the WebApp every 5 min so the V8 container stays\n' +
      'warm. APK Tracking tab will load entries on first open without\n' +
      'showing the "Couldn\'t load" timeout flash.\n\n' +
      'WebApp URL it pings:\n' + url + '\n\n' +
      'Cost: ~288 trivial GETs/day = ~1.5% of the daily UrlFetchApp quota.\n\n' +
      'To remove later: AutoMail Pipeline menu → "Remove All Triggers"\n' +
      '(or in Apps Script editor → Triggers → delete webAppWarmKeeper row).',
      ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Warm-keeper install failed', e.message, ui.ButtonSet.OK);
  }
}

// ─── HELPERS ───────────────────────────────────────────────

function _getVariantIdFromLabel(label) {
  if (!label) return 'GROWTH_MARKETING';
  label = label.toLowerCase();
  if (label.indexOf('growth') >= 0 || label.indexOf('marketing') >= 0) return 'GROWTH_MARKETING';
  if (label.indexOf('ops') >= 0 || label.indexOf('consult') >= 0 || label.indexOf('general') >= 0) return 'OPS_CONSULTING';
  if (label.indexOf('product') >= 0 || label.indexOf('ai') >= 0 || label.indexOf('strategy') >= 0) return 'PRODUCT_AI_STRATEGY';
  return 'GROWTH_MARKETING';
}
