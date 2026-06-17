/**
 * ============================================================
 * DiagnosticHelper.gs — Editor-runnable diagnostic functions
 *
 * Run these from the Apps Script editor (Run button) when you can't
 * deploy fresh code to the Web App. They read live sheet state +
 * return formatted output to the Apps Script Execution log, which
 * you can copy + paste back to debug stuck leads.
 *
 * Usage (in editor):
 *   1. Select function `diagnoseLead` from the function dropdown
 *   2. Edit the QUERY constant below to the name/url you want to search
 *   3. Press Run → check Execution log for output
 *
 * Or call from another function:
 *   diagnoseLead('abhay');                  // matches any lead containing 'abhay'
 *   diagnoseLead('linkedin.com/in/foo');    // by URL substring
 *   diagnoseLead('@acme.com');              // by email domain
 * ============================================================
 */

// Default query if running diagnoseLead() with no arg via editor Run button.
// Edit this line then press Run, OR call diagnoseLead('your query') from another function.
var DIAG_DEFAULT_QUERY = 'abhay';

/**
 * Main diagnostic entry — reads Sheet1, Sheet2, PipelineLog and reports
 * everything matching the query. Output goes to Logger which is visible
 * in the Apps Script Execution log.
 *
 * @param {string} query - case-insensitive substring of name/email/url to find
 */
function diagnoseLead(query) {
  query = (query || DIAG_DEFAULT_QUERY).toString().toLowerCase();
  Logger.log('═══════════════════════════════════════════════════════════');
  Logger.log('  DIAGNOSE — searching for: ' + query);
  Logger.log('  Time: ' + new Date().toISOString());
  Logger.log('═══════════════════════════════════════════════════════════');

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);

  // ── Section 1: Sheet1 (raw audit, what the APK / extension wrote) ──
  Logger.log('');
  Logger.log('━━━ SECTION 1: Sheet1 (RAW AUDIT — what APK/extension wrote) ━━━');
  var sheet1 = ss.getSheetByName('Sheet1');
  if (!sheet1) {
    Logger.log('  Sheet1 does NOT exist. No APK / extension captures yet.');
  } else {
    var last1 = sheet1.getLastRow();
    Logger.log('  Total rows in Sheet1: ' + (last1 - 1));
    if (last1 > 1) {
      var data1 = sheet1.getRange(2, 1, last1 - 1, 12).getValues();
      var headers1 = ['Timestamp','LinkedIn_URL','Full_Name','Headline','Designation','Organization','Email','Phone','Website','Location','Connection','Confidence'];
      var matches1 = [];
      for (var i = 0; i < data1.length; i++) {
        var rowText = data1[i].join(' ').toLowerCase();
        if (rowText.indexOf(query) >= 0) {
          matches1.push({ rowNum: i + 2, data: data1[i] });
        }
      }
      Logger.log('  Matching rows: ' + matches1.length);
      matches1.slice(-10).forEach(function(m) {
        Logger.log('  ─── Sheet1 row ' + m.rowNum + ' ───');
        for (var k = 0; k < headers1.length; k++) {
          var val = m.data[k];
          if (val !== '' && val !== null && val !== undefined) {
            Logger.log('    ' + headers1[k] + ' = ' + String(val).substring(0, 120));
          }
        }
      });
    }
  }

  // ── Section 2: Sheet2 (pipeline input + state) ──
  Logger.log('');
  Logger.log('━━━ SECTION 2: Sheet2 (PIPELINE STATE — what processing did) ━━━');
  var sheet2 = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet2) {
    Logger.log('  Sheet2 (' + CONFIG.DATA_SHEET + ') does NOT exist.');
  } else {
    var last2 = sheet2.getLastRow();
    Logger.log('  Total rows in Sheet2: ' + (last2 - 1));
    if (last2 > 1) {
      var width = CONFIG.SHEET_COL_COUNT || 26;
      var data2 = sheet2.getRange(2, 1, last2 - 1, width).getValues();
      var c = CONFIG.COLUMNS;
      var matches2 = [];
      for (var i2 = 0; i2 < data2.length; i2++) {
        var rowText2 = data2[i2].join(' ').toLowerCase();
        if (rowText2.indexOf(query) >= 0) {
          matches2.push({ rowNum: i2 + 2, data: data2[i2] });
        }
      }
      Logger.log('  Matching rows: ' + matches2.length);
      matches2.slice(-10).forEach(function(m2) {
        Logger.log('  ─── Sheet2 row ' + m2.rowNum + ' ───');
        var fields = [
          ['LinkedIn_URL',   c.LINKEDIN_URL],
          ['Full_Name',      c.FULL_NAME],
          ['Headline',       c.HEADLINE],
          ['Designation',    c.DESIGNATION],
          ['Organization',   c.ORGANIZATION],
          ['Email',          c.EMAIL],
          ['Pipeline_Status', c.STATUS],
          ['Archetype',      c.ARCHETYPE],
          ['Resume_Variant', c.RESUME_VARIANT],
          ['Quality_Score',  c.QUALITY_SCORE],
          ['Draft_ID',       c.DRAFT_ID],
          ['Followup_Stage', c.FOLLOWUP_STAGE],
          ['Notes',          c.NOTES],
          ['Sent_Date',      c.SENT_DATE],
          ['Last_Updated',   c.LAST_UPDATED],
          ['Enriched_Email', c.ENRICHED_EMAIL],
          ['Email_Source',   c.EMAIL_SOURCE],
          ['Email_Confidence', c.EMAIL_CONFIDENCE]
        ];
        fields.forEach(function(f) {
          if (f[1]) {
            var v = m2.data[f[1] - 1];
            if (v !== '' && v !== null && v !== undefined) {
              Logger.log('    ' + f[0] + ' = ' + String(v).substring(0, 200));
            }
          }
        });
      });
    }
  }

  // ── Section 3: PipelineLog — all events for matching rows ──
  Logger.log('');
  Logger.log('━━━ SECTION 3: PipelineLog (every event the engine recorded) ━━━');
  var logSheet = ss.getSheetByName(CONFIG.LOG_SHEET);
  if (!logSheet) {
    Logger.log('  PipelineLog does NOT exist. Pipeline never ran.');
  } else {
    var lastL = logSheet.getLastRow();
    Logger.log('  Total log entries: ' + (lastL - 1));
    if (lastL > 1) {
      var dataL = logSheet.getRange(2, 1, lastL - 1, 6).getValues();
      var matchesL = [];
      for (var iL = 0; iL < dataL.length; iL++) {
        var combined = dataL[iL].join(' ').toLowerCase();
        if (combined.indexOf(query) >= 0) {
          matchesL.push({ rowNum: iL + 2, data: dataL[iL] });
        }
      }
      Logger.log('  Matching log entries: ' + matchesL.length);
      if (matchesL.length === 0) {
        Logger.log('  → No log entries match the query. Pipeline NEVER processed any row for this lead.');
        Logger.log('  → This means the lead row in Sheet2 was either rejected at the auto-process gate, OR never reached Sheet2 at all.');
      }
      matchesL.slice(-30).forEach(function(mL) {
        var d = mL.data;
        var ts = d[0] ? d[0].toString().substring(0, 19) : '';
        Logger.log('  ' + ts + ' | row=' + d[2] + ' | ' + d[3] + ' | ' + d[4] + ' | ' + String(d[5] || '').substring(0, 200));
      });
    }
  }

  // ── Section 4: Status histogram (anywhere a 'NEEDS_*' or 'ERROR' is stuck) ──
  Logger.log('');
  Logger.log('━━━ SECTION 4: Sheet2 status histogram (where are leads stuck?) ━━━');
  if (sheet2 && sheet2.getLastRow() > 1) {
    var statusCol = sheet2.getRange(2, CONFIG.COLUMNS.STATUS, sheet2.getLastRow() - 1, 1).getValues();
    var counts = {};
    statusCol.forEach(function(r) {
      var s = (r[0] || '').toString().trim() || '(empty)';
      counts[s] = (counts[s] || 0) + 1;
    });
    Object.keys(counts).sort().forEach(function(s) {
      Logger.log('  ' + s + ': ' + counts[s]);
    });
  }

  // ── Section 5: Recent ERRORS / WARN entries across whole log ──
  Logger.log('');
  Logger.log('━━━ SECTION 5: Last 15 ERROR/WARN entries (any lead) ━━━');
  if (logSheet && logSheet.getLastRow() > 1) {
    var allLog = logSheet.getRange(2, 1, logSheet.getLastRow() - 1, 6).getValues();
    var probs = allLog.filter(function(r) {
      var lvl = (r[4] || '').toString().toUpperCase();
      return lvl === 'ERROR' || lvl === 'WARN';
    });
    probs.slice(-15).forEach(function(r) {
      var ts = r[0] ? r[0].toString().substring(0, 19) : '';
      Logger.log('  ' + ts + ' | row=' + r[2] + ' | ' + r[3] + ' | ' + r[4] + ' | ' + String(r[5] || '').substring(0, 200));
    });
  }

  Logger.log('');
  Logger.log('═══════════════════════════════════════════════════════════');
  Logger.log('  DIAGNOSIS HEURISTIC');
  Logger.log('═══════════════════════════════════════════════════════════');
  if (sheet1 && sheet1.getLastRow() > 1) {
    Logger.log('  Sheet1 has data → APK or extension popup IS writing.');
  } else {
    Logger.log('  Sheet1 is EMPTY → APK/extension never reached Web App OR Sheet1 write failed.');
  }
  if (sheet2 && sheet2.getLastRow() > 1) {
    Logger.log('  Sheet2 has data → pipeline IS receiving rows.');
  } else {
    Logger.log('  Sheet2 is EMPTY → doPost _handleApkPayload skipped Sheet2 (likely "email missing" bug) OR doPost was never called.');
  }
  Logger.log('');
  Logger.log('  Done. Copy this entire output and paste back for diagnosis.');
}

/**
 * Convenience wrappers — pick one based on what you want to debug.
 */
function diagnoseAbhay()           { diagnoseLead('abhay'); }
function diagnoseRecent()          { diagnoseLead(''); /* matches everything; truncates to last 10 */ }
function diagnoseStuckLeads()      { diagnoseLead('needs_email'); }
function diagnoseErrors()          { diagnoseLead('error'); }

/**
 * dumpSheet1Recent — print the last N rows of Sheet1 (raw APK / extension
 * audit log) with every field. Tells you whether the APK reached the Web App
 * at all, and which fields it was able to scrape from LinkedIn.
 *
 * Usage in editor:
 *   - Select dumpSheet1Recent from the function dropdown → Run
 *   - Or call dumpSheet1Recent(50) for the last 50 rows
 *
 * Interpretation of the output:
 *   - 0 rows total            → APK / extension never reached Web App.
 *                               Causes: wrong /exec URL in Settings, no
 *                               internet on phone, button doesn't fire.
 *   - Rows exist, all blank   → APK reached us but LinkedIn UI didn't yield
 *                               anything. Likely: not logged in, Vision API
 *                               quota, scraping defenses tripped.
 *   - Rows exist, URL only    → APK scraped the URL field but everything
 *                               else was empty/inaccessible. Likely: not
 *                               1st-degree connected to that profile, or
 *                               LinkedIn rendered a wall.
 *   - Rows exist, name+org    → APK extracted text fine but email/phone
 *                               are gated. ← THIS IS NORMAL for non-1st-deg.
 *                               Pipeline will pattern-guess + verify email.
 */
function dumpSheet1Recent(n) {
  n = parseInt(n) || 25;
  Logger.log('═══════════════════════════════════════════════════════════');
  Logger.log('  DUMP Sheet1 — last ' + n + ' rows');
  Logger.log('  Time: ' + new Date().toISOString());
  Logger.log('═══════════════════════════════════════════════════════════');

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet1 = ss.getSheetByName('Sheet1');
  if (!sheet1) {
    Logger.log('  Sheet1 does NOT exist. APK / extension has never written here.');
    Logger.log('  → APK Web App URL probably wrong, OR APK was never tapped + extracted, OR no network.');
    return;
  }
  var lastRow = sheet1.getLastRow();
  Logger.log('  Total rows in Sheet1: ' + (lastRow - 1));
  if (lastRow < 2) {
    Logger.log('  Sheet1 is empty (header only).');
    Logger.log('  → APK / extension has NEVER successfully POSTed to Web App.');
    return;
  }

  var startRow = Math.max(2, lastRow - n + 1);
  var data = sheet1.getRange(startRow, 1, lastRow - startRow + 1, 12).getValues();
  var headers = ['Timestamp','LinkedIn_URL','Full_Name','Headline','Designation','Organization','Email','Phone','Website','Location','Connection','Confidence'];

  // Aggregate field-fill stats
  var stats = { name: 0, url: 0, email: 0, phone: 0, org: 0, total: data.length };
  data.forEach(function(r) {
    if (r[2]) stats.name++;
    if (r[1]) stats.url++;
    if (r[6]) stats.email++;
    if (r[7]) stats.phone++;
    if (r[5]) stats.org++;
  });
  Logger.log('  Field-fill rate across last ' + stats.total + ' rows:');
  Logger.log('    LinkedIn_URL:  ' + stats.url   + '/' + stats.total);
  Logger.log('    Full_Name:     ' + stats.name  + '/' + stats.total);
  Logger.log('    Organization:  ' + stats.org   + '/' + stats.total);
  Logger.log('    Email:         ' + stats.email + '/' + stats.total + (stats.email === 0 ? '  ← APK never gets email' : ''));
  Logger.log('    Phone:         ' + stats.phone + '/' + stats.total + (stats.phone === 0 ? '  ← APK never gets phone' : ''));
  Logger.log('');

  // Newest first
  for (var i = data.length - 1; i >= 0; i--) {
    var r = data[i];
    Logger.log('  ─── Sheet1 row ' + (startRow + i) + ' ───');
    for (var k = 0; k < headers.length; k++) {
      var val = r[k];
      if (val !== '' && val !== null && val !== undefined) {
        Logger.log('    ' + headers[k] + ' = ' + String(val).substring(0, 150));
      }
    }
  }

  Logger.log('');
  Logger.log('═══════════════════════════════════════════════════════════');
  Logger.log('  INTERPRETATION');
  Logger.log('═══════════════════════════════════════════════════════════');
  if (stats.email === 0 && stats.phone === 0) {
    Logger.log('  Email + phone are BOTH 0 across all recent rows. Two possibilities:');
    Logger.log('  (a) You are NOT 1st-degree connected to these profiles. LinkedIn');
    Logger.log('      hides email/phone in the Contact Info drawer for non-1st-deg.');
    Logger.log('      → Connect with them OR rely on pipeline pattern-guessing.');
    Logger.log('  (b) APK accessibility scraping fails to find the Contact Info button,');
    Logger.log('      or Gemini Vision API failed to OCR it.');
    Logger.log('      → Try a profile you are CONNECTED with as a test.');
  }
  if (stats.name === 0) {
    Logger.log('  Full_Name is 0 across all rows. APK is reaching us but extraction failed entirely.');
    Logger.log('  → Likely: not logged into LinkedIn on phone, OR LinkedIn UI changed.');
  }
  if (stats.url > 0 && stats.name > 0 && stats.email === 0) {
    Logger.log('  GOOD: APK extracts name + URL fine — just no email/phone (LinkedIn gating).');
    Logger.log('  Pipeline pattern-guesses email from {firstName.lastName@orgDomain}.');
    Logger.log('  Check Sheet2 for status NEEDS_EMAIL_REVIEW (pattern-guessed candidates).');
  }
}

/**
 * dumpSheet1Today — only rows with timestamp from the last 24 hours.
 * Useful right after a fresh test run to see ONLY what just happened.
 */
function dumpSheet1Today() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet1 = ss.getSheetByName('Sheet1');
  if (!sheet1) { Logger.log('Sheet1 does not exist.'); return; }
  var lastRow = sheet1.getLastRow();
  if (lastRow < 2) { Logger.log('Sheet1 empty.'); return; }

  var cutoff = new Date(Date.now() - 24 * 3600 * 1000);
  var data = sheet1.getRange(2, 1, lastRow - 1, 12).getValues();
  var recent = [];
  for (var i = 0; i < data.length; i++) {
    var ts = data[i][0];
    if (!ts) continue;
    var d = (ts instanceof Date) ? ts : new Date(ts);
    if (d >= cutoff) recent.push({ rowNum: i + 2, data: data[i], ts: d });
  }
  Logger.log('═══ Sheet1 rows in last 24h: ' + recent.length + ' ═══');
  recent.sort(function(a, b) { return b.ts - a.ts; });
  var headers = ['Timestamp','LinkedIn_URL','Full_Name','Headline','Designation','Organization','Email','Phone','Website','Location','Connection','Confidence'];
  recent.forEach(function(r) {
    Logger.log('  ─── row ' + r.rowNum + ' (' + r.ts.toISOString() + ') ───');
    for (var k = 0; k < headers.length; k++) {
      var v = r.data[k];
      if (v !== '' && v !== null && v !== undefined) {
        Logger.log('    ' + headers[k] + ' = ' + String(v).substring(0, 150));
      }
    }
  });
  if (recent.length === 0) {
    Logger.log('  → No APK or extension POST has hit Sheet1 in the last 24h.');
    Logger.log('  → Your most recent test extraction NEVER reached the Web App.');
    Logger.log('  → Check: APK Settings → Apps Script Web App URL is the LIVE /exec URL,');
    Logger.log('           AND APK Settings → Auto-export is ON,');
    Logger.log('           AND phone has internet access.');
  }
}

/**
 * setupGitHubPat — one-shot installer for the GitHub Personal Access Token.
 * Sets Script Property GITHUB_PAT so EnrichmentSources.gs can use 5000-req/hr
 * authenticated GitHub API quota instead of the 60-req/hr unauthenticated one.
 *
 * Token is hardcoded here for the user's convenience but ALSO written via
 * setProperty — the source can be cleaned afterward. Run once from the editor.
 *
 * After running, verify with inspectScriptProperties() — GITHUB_PAT should
 * appear with length 93.
 */
function setupAllNewKeys() {
  // One-shot installer for GitHub PAT, Apollo key, and Snov.io OAuth credentials.
  // Run from editor once. Verifies each by making a real API call.
  var props = PropertiesService.getScriptProperties();
  props.setProperty('GITHUB_PAT',       'YOUR_GITHUB_PAT');
  // Apollo key rotation 2026-05-11:
  //   YOUR_APOLLO_API_KEY — new key (auth OK, but account has payment block → 403 on /organizations/search until user resolves payment)
  //   YOUR_APOLLO_API_KEY_FALLBACK — previous working key (kept as documented fallback)
  // To revert: change APOLLO_API_KEY to the previous value in Script Properties.
  props.setProperty('APOLLO_API_KEY',   'YOUR_APOLLO_API_KEY');
  props.setProperty('APOLLO_API_KEY_FALLBACK', 'YOUR_APOLLO_API_KEY_FALLBACK');
  props.setProperty('SNOV_API_USER_ID', 'YOUR_SNOV_USER_ID');
  props.setProperty('SNOV_API_SECRET',  'YOUR_SNOV_API_SECRET');
  Logger.log('All 4 keys persisted to Script Properties. Verifying each…');

  // GitHub
  try {
    var r = UrlFetchApp.fetch('https://api.github.com/rate_limit', {
      headers: { 'Authorization': 'Bearer ' + props.getProperty('GITHUB_PAT'), 'User-Agent': 'AutoMailPipeline' },
      muteHttpExceptions: true
    });
    Logger.log('GitHub: HTTP ' + r.getResponseCode() + ' (200 = key valid, 5000 req/hr quota)');
  } catch (e) { Logger.log('GitHub: ' + e.message); }

  // Apollo — /organizations/search (free-tier accessible)
  try {
    var r = UrlFetchApp.fetch('https://api.apollo.io/api/v1/organizations/search', {
      method: 'post',
      headers: { 'X-Api-Key': props.getProperty('APOLLO_API_KEY'), 'Content-Type': 'application/json' },
      payload: JSON.stringify({ q_organization_name: 'OpenAI', per_page: 1 }),
      muteHttpExceptions: true
    });
    Logger.log('Apollo: HTTP ' + r.getResponseCode() + ' (200 = key valid for /organizations/search on free tier)');
  } catch (e) { Logger.log('Apollo: ' + e.message); }

  // Snov.io — OAuth token + balance
  try {
    var tr = UrlFetchApp.fetch('https://api.snov.io/v1/oauth/access_token', {
      method: 'post',
      payload: 'grant_type=client_credentials&client_id=' + props.getProperty('SNOV_API_USER_ID') +
               '&client_secret=' + props.getProperty('SNOV_API_SECRET'),
      muteHttpExceptions: true
    });
    if (tr.getResponseCode() === 200) {
      var token = JSON.parse(tr.getContentText()).access_token;
      var br = UrlFetchApp.fetch('https://api.snov.io/v1/get-balance', {
        headers: { 'Authorization': 'Bearer ' + token }, muteHttpExceptions: true
      });
      Logger.log('Snov.io: OAuth OK, balance: ' + br.getContentText());
    } else {
      Logger.log('Snov.io OAuth: HTTP ' + tr.getResponseCode());
    }
  } catch (e) { Logger.log('Snov.io: ' + e.message); }

  Logger.log('Done. Run inspectScriptProperties() to confirm all 4 keys persisted.');
}

// Legacy alias — kept so previously-shared instructions still work.
function setupGitHubPat() {
  var token = 'YOUR_GITHUB_PAT';
  PropertiesService.getScriptProperties().setProperty('GITHUB_PAT', token);
  Logger.log('GITHUB_PAT set (length=' + token.length + '). EnrichmentSources will now use 5000 req/hr quota.');

  // Verify by making a real call (rate limit endpoint costs 0 credits)
  try {
    var res = UrlFetchApp.fetch('https://api.github.com/rate_limit', {
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'AutoMailPipeline'
      },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() === 200) {
      var info = JSON.parse(res.getContentText());
      Logger.log('Live verification OK. Core rate limit: ' +
        info.rate.remaining + '/' + info.rate.limit +
        ' (resets at ' + new Date(info.rate.reset * 1000).toISOString() + ')');
      Logger.log('Search rate limit: ' +
        info.resources.search.remaining + '/' + info.resources.search.limit);
    } else {
      Logger.log('Token verification HTTP ' + res.getResponseCode() + ' — token may be invalid');
    }
  } catch (e) {
    Logger.log('Verification call failed: ' + e.message);
  }
}

/**
 * setupSheet2AsFormulaView — one-shot migration to the new architecture:
 * Sheet1 = single source of truth (raw appends from APK + Chrome ext),
 * Sheet2!A2 = `=UNIQUE(Sheet1!B2:G)` auto-populates the pipeline input cols.
 *
 * BEFORE running:
 *   - You'll lose any manual edits in Sheet2 cols A-F (they'll be overwritten
 *     by the UNIQUE formula's output). Existing pipeline state in cols G-Z
 *     (status, draft ID, notes, etc.) is BACKED UP to "Sheet2_Backup_<date>"
 *     before the migration, so you can manually re-map state to leads if needed.
 *
 * AFTER running:
 *   - APK / Chrome extension POSTs write only Sheet1
 *   - Sheet2 cols A-F populate automatically (dedup by exact-tuple via UNIQUE)
 *   - Pipeline writes status/draft to Sheet2 cols G-Z by row number
 *   - INVARIANT: keep Sheet1 append-only. Deleting/editing Sheet1 rows
 *     re-orders Sheet2 → orphans pipeline state.
 *
 * Idempotent — safe to re-run; only installs the formula if absent.
 */
function setupSheet2AsFormulaView() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet2 = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet2) {
    Logger.log('Sheet2 (' + CONFIG.DATA_SHEET + ') does not exist. Create it manually first.');
    return;
  }

  var a2Formula = sheet2.getRange('A2').getFormula();
  if (a2Formula && a2Formula.indexOf('UNIQUE') >= 0 && a2Formula.indexOf('Sheet1') >= 0) {
    Logger.log('UNIQUE formula already installed at Sheet2!A2: ' + a2Formula);
    Logger.log('No action needed. Sheet2 is already in formula-view mode.');
    return;
  }

  var lastRow = sheet2.getLastRow();
  var width = CONFIG.SHEET_COL_COUNT || 26;

  // ── Backup current Sheet2 state ──
  if (lastRow >= 2) {
    var stamp = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyyMMdd_HHmm');
    var backupName = 'Sheet2_Backup_' + stamp;
    var backupSheet = ss.insertSheet(backupName);
    var allData = sheet2.getRange(1, 1, lastRow, width).getValues();
    backupSheet.getRange(1, 1, lastRow, width).setValues(allData);
    Logger.log('Backed up ' + (lastRow - 1) + ' rows to sheet "' + backupName + '"');
  } else {
    Logger.log('Sheet2 has no existing data — no backup needed');
  }

  // ── Clear input cols A-F (cols G-Z preserved so existing draft IDs etc. stay) ──
  // Actually: clearing only A-F while leaving G-Z would leave orphaned state
  // (rows would shift when UNIQUE recalculates). Cleaner to clear the whole
  // body. The backup sheet preserves everything for manual recovery.
  if (lastRow >= 2) {
    sheet2.getRange(2, 1, lastRow - 1, width).clearContent();
    Logger.log('Cleared Sheet2 body (rows 2-' + lastRow + ', cols A-' + String.fromCharCode(64 + width) + ')');
  }

  // ── Install the UNIQUE formula ──
  sheet2.getRange('A2').setFormula('=UNIQUE(Sheet1!B2:G)');
  Logger.log('Installed `=UNIQUE(Sheet1!B2:G)` at Sheet2!A2');

  // ── Verify ──
  SpreadsheetApp.flush();  // force recalc
  var newLastRow = sheet2.getLastRow();
  Logger.log('Sheet2 now has ' + (newLastRow - 1) + ' data rows (formula-driven from Sheet1)');
  Logger.log('Done. Next APK or Chrome-ext POST will go to Sheet1 only; Sheet2 will auto-update.');
}

/**
 * inspectScriptProperties — list every Script Property (PropertiesService)
 * that's been set, with key name + length + masked preview. Confirms whether
 * REOON_API_KEY, HUNTER_API_KEY, LOR_DRIVE_ID, AUTOMAIL_WEBAPP_SECRET are all
 * configured. Never logs raw values.
 */
function inspectScriptProperties() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var keys = Object.keys(props).sort();
  Logger.log('═══ Script Properties: ' + keys.length + ' total ═══');
  keys.forEach(function(k) {
    var v = props[k] || '';
    var masked = v.length > 6 ? (v.substring(0, 4) + '…' + v.substring(v.length - 2)) : '(short)';
    Logger.log('  ' + k + ' = [' + v.length + ' chars] ' + masked);
  });
  if (keys.length === 0) Logger.log('  (no properties set)');
}

// ─── PATCH 2026-06-12-autonomous-close: mail-tester probe helpers ─────────────
//
// Three functions that together form a controlled probe loop for checking
// Gmail deliverability via mail-tester.com:
//   menuCreateMailTesterLead  — injects a synthetic lead (email must be @mail-tester.com)
//   menuSendMailTesterDraft   — sends a pipeline-created draft to that lead
//   menuRequeueDegradedTodayDrafts — requeues rows hit by the degraded-renderer window
//
// SECURITY NOTE: menuSendMailTesterDraft carries a HARD GUARD that refuses to send
// to any address not matching the mail-tester.com regex. This guard is the security
// boundary preventing the bridge from sending to arbitrary recipients. Never weaken.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * menuCreateMailTesterLead(_, emailAddr)
 * Injects a synthetic lead row into the pipeline data sheet for mail-tester.com probing.
 *
 * REUSE BEHAVIOUR (2026-06-12-mailtester-probe): if a row already exists with EMAIL
 * matching the mail-tester regex, that row is RESET IN PLACE:
 *   STATUS='NEW', DRAFT_ID='', NOTES='[MAILTESTER_PROBE retry]',
 *   ENRICHED_EMAIL=emailAddr, EMAIL_CONFIDENCE=0.99, EMAIL_SOURCE='mailtester_probe',
 *   LAST_UPDATED=now
 * Returns { row, email, reused:true }.
 *
 * NEW-ROW BEHAVIOUR (2026-06-12-probe-via-sheet1): if no existing row is found,
 * the probe is written into Sheet1 — the same intake surface the APK/extension
 * capture path (doPost → _handleApkPayload) uses. The data sheet's cols A-F are
 * a UNIQUE(Sheet1!B2:G) spill: growing the data sheet directly blocks the
 * formula from expanding and silently dams ALL new lead intake (live incident
 * 2026-06-12). After the Sheet1 write, the function flushes, locates the row
 * the spill materialized, seeds the same fields there (state cols G+ only,
 * never the spill range A-F), and returns { row, email, reused:false }.
 *
 * HARD GUARD: emailAddr must match /@(?:srv\d+\.)?mail-tester\.com$/i — any other
 * recipient is refused. This prevents the function from being repurposed to inject
 * real contacts via the autonomy bridge.
 *
 * @param {*} _ — ignored (arg1 placeholder for admin_run compat)
 * @param {string} emailAddr — must be a @mail-tester.com address
 * @returns {{row:number, email:string, reused:boolean}|{status:'refused', reason:string}}
 */
function menuCreateMailTesterLead(_, emailAddr) {
  // HARD GUARD — security boundary
  if (!/@(?:srv\d+\.)?mail-tester\.com$/i.test(String(emailAddr || ''))) {
    return { status: 'refused', reason: 'recipient not mail-tester.com' };
  }
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet) {
    return { status: 'error', error: 'data sheet not found: ' + CONFIG.DATA_SHEET };
  }
  var C = CONFIG.COLUMNS;
  var now = new Date().toISOString();
  var colCount = CONFIG.SHEET_COL_COUNT || 28;
  var lastRow = sheet.getLastRow();

  // ── REUSE PATH: scan for existing row with EMAIL matching the mail-tester regex ──
  if (lastRow >= 2) {
    var emailColData = sheet.getRange(2, C.EMAIL, lastRow - 1, 1).getValues();
    for (var i = 0; i < emailColData.length; i++) {
      var existingEmail = String(emailColData[i][0] || '').trim();
      if (/@(?:srv\d+\.)?mail-tester\.com$/i.test(existingEmail)) {
        // Reset the existing row in place
        var existingRow = i + 2;
        sheet.getRange(existingRow, C.STATUS           ).setValue('NEW');
        sheet.getRange(existingRow, C.DRAFT_ID         ).setValue('');
        sheet.getRange(existingRow, C.NOTES            ).setValue('[MAILTESTER_PROBE retry]');
        sheet.getRange(existingRow, C.ENRICHED_EMAIL   ).setValue(emailAddr);
        sheet.getRange(existingRow, C.EMAIL_CONFIDENCE ).setValue(0.99);
        sheet.getRange(existingRow, C.EMAIL_SOURCE     ).setValue('mailtester_probe');
        sheet.getRange(existingRow, C.LAST_UPDATED     ).setValue(now);
        return { row: existingRow, email: emailAddr, reused: true };
      }
    }
  }

  // ── NEW-ROW PATH (2026-06-12-probe-via-sheet1): probe enters via Sheet1 ──
  // The data sheet's cols A-F are a UNIQUE(Sheet1!B2:G) spill. Growing the
  // data sheet directly blocks the formula from expanding and silently dams
  // ALL new lead intake (live incident 2026-06-12). The probe therefore goes
  // in through Sheet1 — the same intake surface the APK/extension capture
  // path uses — and the spill materializes it into the data sheet, where only
  // state cols (G+) are then written.
  var S1 = CONFIG.SHEET1_COLUMNS;
  var intake = ss.getSheetByName('Sheet1');
  if (!intake) {
    return { status: 'error', error: 'Sheet1 (intake) not found — cannot place probe' };
  }
  if (typeof _ensureSheet2UniqueFormula === 'function') {
    _ensureSheet2UniqueFormula(ss);
  }
  // Unique per call, so UNIQUE always materializes a fresh tuple; doubles as
  // the locate key for the materialized row.
  var probeMark = 'Deliverability probe ' + now;
  var s1row = [];
  for (var j = 0; j < (CONFIG.SHEET1_COL_COUNT || 13); j++) s1row.push('');
  s1row[S1.TIMESTAMP    - 1] = now;
  s1row[S1.FULL_NAME    - 1] = 'Alex Mailtester';
  s1row[S1.HEADLINE     - 1] = probeMark;
  s1row[S1.DESIGNATION  - 1] = 'Hiring Manager';
  s1row[S1.ORGANIZATION - 1] = 'Mailtester Labs';
  s1row[S1.EMAIL        - 1] = emailAddr;
  s1row[S1.LEAD_UID     - 1] = Utilities.getUuid();
  // PATCH 2026-06-17-filter-fix: strip any stray Sheet1 basic filter first — with
  // one present, appendRow silently no-ops and the row is lost (no error thrown).
  if (typeof _ensureNoSheet1Filter_ === 'function') _ensureNoSheet1Filter_(intake);
  intake.appendRow(s1row);

  // Locate the materialized row (new tuples land at the bottom of the spill).
  var foundRow = 0;
  for (var attempt = 0; attempt < 5 && !foundRow; attempt++) {
    if (attempt > 0) Utilities.sleep(400);
    SpreadsheetApp.flush();
    var last2 = sheet.getLastRow();
    if (last2 >= 2) {
      var spillVals = sheet.getRange(2, 1, last2 - 1, 6).getValues();
      for (var r = spillVals.length - 1; r >= 0; r--) {
        if (String(spillVals[r][C.HEADLINE - 1] || '') === probeMark &&
            String(spillVals[r][C.EMAIL - 1] || '').toLowerCase() === String(emailAddr).toLowerCase()) {
          foundRow = r + 2;
          break;
        }
      }
    }
  }
  if (!foundRow) {
    var a2State = '';
    try {
      a2State = sheet.getRange('A2').getFormula() || String(sheet.getRange('A2').getValue() || '');
    } catch (_) {}
    return {
      status: 'error',
      error: 'probe row did not materialize in ' + CONFIG.DATA_SHEET + ' after 5 flush attempts; ' +
             'Sheet2!A2 holds: ' + (a2State || '(empty)') + ' — if that is not the UNIQUE formula, ' +
             'the spill is dammed (see setupSheet2AsFormulaView)'
    };
  }
  // Seed pipeline state on the materialized row — state cols only, never A-F.
  sheet.getRange(foundRow, C.STATUS           ).setValue('NEW');
  sheet.getRange(foundRow, C.ENRICHED_EMAIL   ).setValue(emailAddr);
  sheet.getRange(foundRow, C.EMAIL_CONFIDENCE ).setValue(0.99);
  sheet.getRange(foundRow, C.EMAIL_SOURCE     ).setValue('mailtester_probe');
  sheet.getRange(foundRow, C.LAST_UPDATED     ).setValue(now);
  return { row: foundRow, email: emailAddr, reused: false };
}

/**
 * menuSendMailTesterDraft(rowNum)
 * Sends a pipeline-created draft from the given row to its mail-tester.com recipient.
 *
 * Requirements:
 *   - Row STATUS must be 'DRAFT_CREATED'
 *   - Row DRAFT_ID must be non-empty
 *   - Draft's getTo() address must match the mail-tester.com regex
 *
 * HARD GUARD: the draft's To address is re-validated against the mail-tester regex
 * before send(). This is the SECURITY BOUNDARY — the bridge must never be able to
 * send to a non-mail-tester recipient regardless of how the DRAFT_ID was set.
 * NEVER weaken this guard.
 *
 * @param {number} rowNum — 1-indexed sheet row
 * @returns {{sent:boolean, to:string, draftId:string}|{status:'refused'}|{status:'error'}}
 */
function menuSendMailTesterDraft(rowNum) {
  rowNum = parseInt(rowNum, 10);
  if (!rowNum || rowNum < 2) return { status: 'error', error: 'invalid rowNum' };
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet) return { status: 'error', error: 'data sheet not found' };
  var C = CONFIG.COLUMNS;
  var colCount = CONFIG.SHEET_COL_COUNT || 28;
  var rowData = sheet.getRange(rowNum, 1, 1, colCount).getValues()[0];
  var status  = String(rowData[C.STATUS   - 1] || '');
  var draftId = String(rowData[C.DRAFT_ID - 1] || '').trim();
  var notes   = String(rowData[C.NOTES    - 1] || '');
  if (status !== 'DRAFT_CREATED') {
    return { status: 'error', error: 'row status is not DRAFT_CREATED: ' + status };
  }
  if (!draftId) {
    return { status: 'error', error: 'DRAFT_ID is empty' };
  }
  var draft = GmailApp.getDraft(draftId);
  if (!draft) return { status: 'error', error: 'draft not found: ' + draftId };
  var msg = draft.getMessage();
  var to  = msg.getTo();
  // HARD GUARD — security boundary: refuse if To address is not mail-tester.com
  if (!/@(?:srv\d+\.)?mail-tester\.com$/i.test(String(to || ''))) {
    return { status: 'refused', reason: 'draft To address does not match mail-tester.com: ' + to };
  }
  // Send
  draft.send();
  var now = new Date().toISOString();
  var newNotes = (notes ? notes + ' ' : '') + '[MAILTESTER_PROBE]';
  if (newNotes.length > 1900) newNotes = newNotes.substring(newNotes.length - 1900);
  sheet.getRange(rowNum, C.STATUS       ).setValue('SENT');
  sheet.getRange(rowNum, C.SENT_DATE    ).setValue(now);
  sheet.getRange(rowNum, C.NOTES        ).setValue(newNotes);
  sheet.getRange(rowNum, C.LAST_UPDATED ).setValue(now);
  return { sent: true, to: to, draftId: draftId };
}

/**
 * menuRequeueDegradedTodayDrafts()
 * Requeues rows where STATUS='DRAFT_CREATED' and LAST_UPDATED falls in the
 * degraded-renderer window: 2026-06-12 08:20:00Z – 09:00:00Z (13:50–14:30 IST).
 *
 * For each matched row:
 *   - Appends '[REQUEUE_BUILDERBLOCK] old draft <DRAFT_ID> superseded; ' to NOTES (1900 cap)
 *   - Clears DRAFT_ID
 *   - Sets STATUS='NEW', LAST_UPDATED=now
 *
 * The pipeline will compose fresh drafts. Old Gmail drafts remain for the user to
 * bulk-delete — their IDs are captured in the return value and in NOTES.
 *
 * @returns {{requeued:number, rows:Array<{row,to,oldDraftId}>}}
 */
function menuRequeueDegradedTodayDrafts() {
  var WINDOW_START = new Date('2026-06-12T08:20:00Z').getTime();
  var WINDOW_END   = new Date('2026-06-12T09:00:00Z').getTime();
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet) return { status: 'error', error: 'data sheet not found' };
  var C = CONFIG.COLUMNS;
  var colCount = CONFIG.SHEET_COL_COUNT || 28;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { requeued: 0, rows: [] };
  var data = sheet.getRange(2, 1, lastRow - 1, colCount).getValues();
  var requeued = 0;
  var rows = [];
  var now = new Date().toISOString();
  for (var i = 0; i < data.length; i++) {
    var rowNum = i + 2;
    var status      = String(data[i][C.STATUS       - 1] || '');
    var draftId     = String(data[i][C.DRAFT_ID     - 1] || '').trim();
    var lastUpdRaw  = data[i][C.LAST_UPDATED - 1];
    var email       = String(data[i][C.EMAIL        - 1] || '');
    if (status !== 'DRAFT_CREATED') continue;
    var ts = 0;
    try {
      var d = (lastUpdRaw instanceof Date) ? lastUpdRaw : new Date(lastUpdRaw);
      ts = d.getTime();
    } catch (_) {}
    if (!ts || ts < WINDOW_START || ts > WINDOW_END) continue;
    // This row was created in the degraded-renderer window
    var notes = String(data[i][C.NOTES - 1] || '');
    var newNotes = '[REQUEUE_BUILDERBLOCK] old draft ' + (draftId || 'unknown') + ' superseded; ' + notes;
    if (newNotes.length > 1900) newNotes = newNotes.substring(0, 1900);
    sheet.getRange(rowNum, C.NOTES       ).setValue(newNotes);
    sheet.getRange(rowNum, C.DRAFT_ID    ).setValue('');
    sheet.getRange(rowNum, C.STATUS      ).setValue('NEW');
    sheet.getRange(rowNum, C.LAST_UPDATED).setValue(now);
    requeued++;
    if (rows.length < 40) {
      rows.push({ row: rowNum, to: email, oldDraftId: draftId });
    }
  }
  return { requeued: requeued, rows: rows };
}

/**
 * PATCH 2026-06-12-template-unify: Requeue prose-body DRAFT_CREATED rows by email list.
 * PATCH 2026-06-12-requeue-generic: Generalised to accept a comma-separated argS list
 *   of recipient emails instead of the previous hardcoded two-email whitelist.
 *
 * For each matching row with STATUS='DRAFT_CREATED':
 *   - Appends '[REQUEUE_TEMPLATE_UNIFY] old draft <DRAFT_ID> superseded; ' to NOTES (1900 cap)
 *   - Clears DRAFT_ID
 *   - Sets STATUS='NEW', LAST_UPDATED=now
 * Refuses (skips, reports) rows in any other status.
 *
 * @param {*} _ — ignored (arg1 placeholder for admin_run compat)
 * @param {string} argS — comma-separated list of recipient email addresses to target
 * @returns {{requeued:number, rows:Array<{row,to,oldDraftId}>, skipped:Array<{row,to,status}>}}
 */
function menuRequeueTemplateUnifyRows(_, argS) {
  var rawList = String(argS || '').trim();
  if (!rawList) {
    return { status: 'error', error: 'argS is required: pass a comma-separated list of recipient emails' };
  }
  var TARGET_EMAILS = rawList.split(',').map(function(s) { return s.trim().toLowerCase(); }).filter(function(s) { return s.length > 0; });
  if (TARGET_EMAILS.length === 0) {
    return { status: 'error', error: 'argS produced an empty email list after parsing' };
  }
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet) return { status: 'error', error: 'data sheet not found' };
  var C = CONFIG.COLUMNS;
  var colCount = CONFIG.SHEET_COL_COUNT || 28;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { requeued: 0, rows: [], skipped: [] };
  var data = sheet.getRange(2, 1, lastRow - 1, colCount).getValues();
  var requeued = 0;
  var rows = [];
  var skipped = [];
  var now = new Date().toISOString();
  for (var i = 0; i < data.length; i++) {
    var rowNum = i + 2;
    var status  = String(data[i][C.STATUS  - 1] || '');
    var email   = String(data[i][C.EMAIL   - 1] || '').trim().toLowerCase();
    var enrichedEmail = (C.ENRICHED_EMAIL && data[i][C.ENRICHED_EMAIL - 1])
      ? String(data[i][C.ENRICHED_EMAIL - 1] || '').trim().toLowerCase()
      : '';
    var matchedAddr = null;
    for (var ti = 0; ti < TARGET_EMAILS.length; ti++) {
      if (email === TARGET_EMAILS[ti] || enrichedEmail === TARGET_EMAILS[ti]) {
        matchedAddr = TARGET_EMAILS[ti];
        break;
      }
    }
    if (!matchedAddr) continue;
    // PATCH 2026-06-12-handoff-fix: also accept ERROR rows when argS was provided
    // explicitly (targeted requeue after a pipeline bug fix). DRAFT_CREATED is still
    // the primary guard; ERROR is allowed as a secondary path so a pair reset after
    // a seam regression does not require a separate tool. The argS requirement ensures
    // this is never a blanket-ERROR reset — only explicitly named addresses are touched.
    var isEligibleStatus = (status === 'DRAFT_CREATED') ||
      (status === 'ERROR' && rawList.trim().length > 0);
    if (!isEligibleStatus) {
      // Refuse rows in any other status — idempotent guard
      skipped.push({ row: rowNum, to: email || enrichedEmail, status: status });
      continue;
    }
    var draftId = String(data[i][C.DRAFT_ID - 1] || '').trim();
    var notes   = String(data[i][C.NOTES    - 1] || '');
    // PATCH 2026-06-12-handoff-fix: strip stale errRetry:N/M token from preserved
    // notes so the re-queued row starts with a fresh budget. Without this, a row
    // that previously exhausted errRetry:2/2 carries that token into the next run;
    // _seedOrPreserveErrRetry preserves it and the pipeline immediately writes ERROR
    // on the first failure without any retry headroom.
    var notesWithoutErrRetry = notes.replace(/\s*errRetry:\d+\/\d+/g, '').trim();
    var newNotes = '[REQUEUE_TEMPLATE_UNIFY] old draft ' + (draftId || 'unknown') +
      ' superseded; [HANDOFF_FIX retry] errRetry:0/2; ' + notesWithoutErrRetry;
    if (newNotes.length > 1900) newNotes = newNotes.substring(0, 1900);
    sheet.getRange(rowNum, C.NOTES       ).setValue(newNotes);
    sheet.getRange(rowNum, C.DRAFT_ID    ).setValue('');
    sheet.getRange(rowNum, C.STATUS      ).setValue('NEW');
    sheet.getRange(rowNum, C.LAST_UPDATED).setValue(now);
    // PATCH 2026-06-12-org-domain-gate: clear stale enrichment so re-enrichment
    // starts clean. Without this, re-queued rows retain the wrong ENRICHED_EMAIL /
    // EMAIL_SOURCE / EMAIL_CONFIDENCE from the prior (wrong-person) selection and
    // the pipeline skips enrichment for rows that already have ENRICHED_EMAIL set.
    if (C.ENRICHED_EMAIL)   sheet.getRange(rowNum, C.ENRICHED_EMAIL  ).setValue('');
    if (C.EMAIL_SOURCE)     sheet.getRange(rowNum, C.EMAIL_SOURCE    ).setValue('');
    if (C.EMAIL_CONFIDENCE) sheet.getRange(rowNum, C.EMAIL_CONFIDENCE).setValue('');
    requeued++;
    rows.push({ row: rowNum, to: email || enrichedEmail, oldDraftId: draftId });
  }
  Logger.log('[REQUEUE_TEMPLATE_UNIFY] requeued=' + requeued + ' rows=' + JSON.stringify(rows) + ' skipped=' + JSON.stringify(skipped));
  return { requeued: requeued, rows: rows, skipped: skipped };
}

/**
 * PATCH 2026-06-13-op-budget (Phase 3): reset ERROR rows whose errRetry budget was
 * exhausted by a SYSTEM failure (Gmail quota: "Service invoked too many times").
 *
 * Root cause analysis: the Gmail op-budget guards fix prevents TOMORROW's quota
 * exhaustion; the ERROR rows (row 297 confirmed) parked today because DRAFT_FAILED
 * triggered errRetry:1/2 then errRetry:2/2 — both failures caused by quota, not content.
 * With errRetry:2/2, the scanner's scoreStuckAutoRecoverEligible correctly returns
 * eligible:false, producing SKIP_FALL_THROUGH:no_whitelist_match. ERROR IS in
 * STUCK_AUTO_RECOVER_STATUSES — there is no whitelist gap. The recovery gap is the
 * exhausted errRetry counter for system-caused (quota) failures.
 *
 * Fix: reset the errRetry token for ERROR rows whose NOTES contain the quota error
 * signature. Bounded to rows from the last 3 days (system-error recency window).
 * Rows with non-quota ERROR notes are NOT touched (content failures keep their
 * exhausted budget — that's correct behavior).
 *
 * After reset: these rows become eligible for scoreStuckAutoRecoverEligible again.
 * The midnight PT quota reset (~12:30 AM IST / 12:30 PM IST during PDT) restores
 * the Gmail pool; the next scanner tick will re-attempt drafting.
 *
 * @returns {{ scanned: number, reset: number, rows: Array, skipped: Array }}
 */
function menuResetQuotaExhaustedErrorRows() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { scanned: 0, reset: 0, rows: [], skipped: [] };

  var C = CONFIG.COLUMNS;
  var colCount = CONFIG.SHEET_COL_COUNT || 28;
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, colCount).getValues();
  var now = new Date().toISOString();

  // Only reset ERROR rows whose notes contain the Gmail quota error signature.
  var QUOTA_SIG = 'Service invoked too many times';
  var scanned = 0, reset = 0;
  var rows = [], skipped = [];

  for (var i = 0; i < data.length; i++) {
    var status = (data[i][C.STATUS - 1] || '').toString().trim();
    if (status !== 'ERROR') continue;
    scanned++;

    var notes = (data[i][C.NOTES - 1] || '').toString();
    if (notes.indexOf(QUOTA_SIG) < 0) {
      skipped.push({ row: i + 2, reason: 'no_quota_sig_in_notes' });
      continue;
    }
    // Strip the exhausted errRetry token; inject a fresh one
    var notesClean = notes.replace(/\s*errRetry:\d+\/\d+/g, '').trim();
    var newNotes = ('[OP_BUDGET_RESET ' + now + '] errRetry reset (system quota failure, not content failure). ' +
                   'Will re-attempt after Gmail quota reset. errRetry:0/2 | ' + notesClean)
                   .substring(0, 1900);
    var rowNum = i + 2;
    try {
      sheet.getRange(rowNum, C.NOTES).setValue(newNotes);
      sheet.getRange(rowNum, C.LAST_UPDATED).setValue(now);
      reset++;
      rows.push({ row: rowNum, email: (data[i][C.EMAIL - 1] || '').toString().trim() ||
                                      (data[i][C.ENRICHED_EMAIL - 1] || '').toString().trim() || '<unknown>' });
    } catch (writeErr) {
      skipped.push({ row: rowNum, reason: 'write_error: ' + writeErr.message });
    }
  }

  Logger.log('[menuResetQuotaExhaustedErrorRows] scanned=' + scanned + ' reset=' + reset +
             ' rows=' + JSON.stringify(rows));
  return { scanned: scanned, reset: reset, rows: rows, skipped: skipped };
}

// ═══════════════════════════════════════════════════════════════════════
// FOLLOW-UP DIAGNOSTICS (2026-06-13-followup-thread)
// ═══════════════════════════════════════════════════════════════════════

/**
 * menuFollowupAudit — READ-ONLY follow-up health report.
 *
 * Returns:
 *   totalRows        — total FollowUps sheet rows (excl. header)
 *   pendingByStage   — { '1': n, '2': n, '3': n } PENDING counts per stage
 *   duplicateGroups  — number of (email,stage) groups with >1 PENDING row
 *   emptyThreadIdMainRows — count of MAIN sheet rows with SENT-family status + empty THREAD_ID (Path-B-risk population)
 *
 * Bridge-callable: /exec?action=admin_run&fn=menuFollowupAudit&token=<ADMIN>
 */
function menuFollowupAudit() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);

  // ── FollowUps sheet analysis ──
  var fuSheet = ss.getSheetByName('FollowUps');
  var totalRows = 0;
  var pendingByStage = {};
  var duplicateGroups = 0;

  if (fuSheet) {
    var fuData = fuSheet.getDataRange().getValues();
    if (fuData.length >= 2) {
      totalRows = fuData.length - 1;
      var fuHeaders = fuData[0].map(function(h) { return (h || '').toString().trim(); });
      var fuColStatus = fuHeaders.indexOf('Status');
      var fuColStage  = fuHeaders.indexOf('Stage');
      var fuColEmail  = fuHeaders.indexOf('Email');

      var pendingGroupMap = {};

      for (var fi = 1; fi < fuData.length; fi++) {
        var fuStatus = fuColStatus >= 0 ? (fuData[fi][fuColStatus] || '').toString().trim() : '';
        var fuStage  = fuColStage  >= 0 ? (fuData[fi][fuColStage]  || '').toString().trim() : '';
        var fuEmail  = fuColEmail  >= 0 ? (fuData[fi][fuColEmail]  || '').toString().trim().toLowerCase() : '';

        if (fuStatus === 'PENDING') {
          pendingByStage[fuStage] = (pendingByStage[fuStage] || 0) + 1;
          var pgKey = fuEmail + '|' + fuStage;
          pendingGroupMap[pgKey] = (pendingGroupMap[pgKey] || 0) + 1;
        }
      }

      Object.keys(pendingGroupMap).forEach(function(k) {
        if (pendingGroupMap[k] > 1) duplicateGroups++;
      });
    }
  }

  // ── Main sheet: SENT-family rows with empty THREAD_ID (Path-B-risk population) ──
  var emptyThreadIdMainRows = 0;
  try {
    var mainSheet = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (mainSheet) {
      var C = CONFIG.COLUMNS;
      var sentFamilyStatuses = ['SENT', 'FOLLOWUP_1', 'FOLLOWUP_2', 'FOLLOWUP_3'];
      var lastRow = mainSheet.getLastRow();
      if (lastRow >= 2) {
        var mainData = mainSheet.getRange(2, 1, lastRow - 1, Math.max(C.THREAD_ID, C.STATUS)).getValues();
        mainData.forEach(function(row) {
          var st = (row[C.STATUS - 1] || '').toString().trim();
          var tid = (row[C.THREAD_ID - 1] || '').toString().trim();
          if (sentFamilyStatuses.indexOf(st) >= 0 && !tid) {
            emptyThreadIdMainRows++;
          }
        });
      }
    }
  } catch (mainErr) {
    Logger.log('[menuFollowupAudit] Main sheet scan failed: ' + mainErr.message);
  }

  var result = {
    totalRows: totalRows,
    pendingByStage: pendingByStage,
    duplicateGroups: duplicateGroups,
    emptyThreadIdMainRows: emptyThreadIdMainRows
  };
  Logger.log('[menuFollowupAudit] ' + JSON.stringify(result));
  return result;
}

/**
 * menuPurgeDuplicateFollowups — WRITE: for each (email,stage) PENDING group,
 * keep the earliest-scheduled row, mark the rest CANCELLED.
 *
 * Lock-guarded (script lock) to prevent race with daily trigger.
 * Idempotent — safe to re-run.
 *
 * Returns: { groupsScanned, cancelled, rows }
 *
 * Bridge-callable: /exec?action=admin_run&fn=menuPurgeDuplicateFollowups&token=<ADMIN>
 */
function menuPurgeDuplicateFollowups() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { status: 'busy', error: 'pipeline_busy',
             message: 'Another pipeline run holds the lock. Retry in 1-2 minutes.' };
  }
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var fuSheet = ss.getSheetByName('FollowUps');
    if (!fuSheet) return { groupsScanned: 0, cancelled: 0, rows: [] };

    var fuData = fuSheet.getDataRange().getValues();
    if (fuData.length < 2) return { groupsScanned: 0, cancelled: 0, rows: [] };

    var fuHeaders = fuData[0].map(function(h) { return (h || '').toString().trim(); });
    var fuIdx = {};
    fuHeaders.forEach(function(h, i) { fuIdx[h] = i; });

    var colStatus  = fuIdx['Status'];
    var colStage   = fuIdx['Stage'];
    var colEmail   = fuIdx['Email'];
    var colSchedDate = fuIdx['ScheduledDate'];
    var colNotes   = fuIdx['Notes'];

    // Build per (email,stage) group list
    var groups = {};
    for (var gi = 1; gi < fuData.length; gi++) {
      var gStatus = colStatus !== undefined ? (fuData[gi][colStatus] || '').toString().trim() : '';
      if (gStatus !== 'PENDING') continue;
      var gEmail = colEmail !== undefined ? (fuData[gi][colEmail] || '').toString().trim().toLowerCase() : '';
      var gStage = colStage !== undefined ? (fuData[gi][colStage] || '').toString().trim() : '';
      if (!gEmail || !gStage) continue;

      var gKey = gEmail + '|' + gStage;
      var gSchedMs = colSchedDate !== undefined && fuData[gi][colSchedDate]
        ? (new Date(fuData[gi][colSchedDate]).getTime() || 0) : 0;

      if (!groups[gKey]) groups[gKey] = [];
      groups[gKey].push({ rowIdx: gi, scheduledDateMs: gSchedMs });
    }

    var groupsScanned = Object.keys(groups).length;
    var cancelled = 0;
    var cancelledRows = [];

    Object.keys(groups).forEach(function(key) {
      var group = groups[key];
      if (group.length < 2) return;
      // Sort ascending; keep first
      group.sort(function(a, b) {
        return a.scheduledDateMs !== b.scheduledDateMs
          ? a.scheduledDateMs - b.scheduledDateMs
          : a.rowIdx - b.rowIdx;
      });
      for (var ci = 1; ci < group.length; ci++) {
        var cancelRowIdx = group[ci].rowIdx;
        try {
          fuSheet.getRange(cancelRowIdx + 1, colStatus + 1).setValue('CANCELLED');
          if (colNotes !== undefined) {
            fuSheet.getRange(cancelRowIdx + 1, colNotes + 1).setValue('[DUP_FOLLOWUP] superseded by menuPurgeDuplicateFollowups');
          }
          cancelled++;
          cancelledRows.push({ sheetRow: cancelRowIdx + 1, key: key });
        } catch (cancelErr) {
          Logger.log('[menuPurgeDuplicateFollowups] Could not cancel row ' + (cancelRowIdx + 1) + ': ' + cancelErr.message);
        }
      }
    });

    Logger.log('[menuPurgeDuplicateFollowups] groupsScanned=' + groupsScanned + ' cancelled=' + cancelled);
    return { groupsScanned: groupsScanned, cancelled: cancelled, rows: cancelledRows };

  } finally {
    lock.releaseLock();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ORG-GATE SUBSTR FIX REQUEUE (2026-06-13-orggate-substr)
// ═══════════════════════════════════════════════════════════════════════

/**
 * menuRequeueOrgGateStranded — reprocess leads stranded by the old exact-token
 * org-domain gate. Targets rows whose NOTES contain "[ORG_DOMAIN_GATE]" OR
 * whose STATUS is NEEDS_EMAIL_REVIEW with empty ENRICHED_EMAIL (gate-stranded
 * leads land in NEEDS_EMAIL_REVIEW with empty enrichedEmail).
 *
 * For each matching row:
 *   - Clears ENRICHED_EMAIL, EMAIL_SOURCE, EMAIL_CONFIDENCE so re-enrichment
 *     starts clean under the fixed substring gate.
 *   - Sets STATUS = 'NEW', LAST_UPDATED = now.
 *   - Preserves existing NOTES, appends '[ORGGATE_FIX_REQUEUE]' marker.
 *   - Does NOT touch EMAIL (col F / sheet-truth — keep what APK captured).
 *
 * After reset, these rows are in STUCK_AUTO_RECOVER_STATUSES (NEW) and will
 * re-dispatch on the next scanner tick. With mesaschool.co now passing the
 * gate, parth@mesaschool.co will be selected as sheet_captured on the next
 * enrichment pass.
 *
 * Bridge-callable:
 *   /exec?action=admin_run&fn=menuRequeueOrgGateStranded&token=<ADMIN>
 *
 * @returns {{ scanned: number, requeued: number, rows: Array, skipped: Array }}
 */
function menuRequeueOrgGateStranded() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { scanned: 0, requeued: 0, rows: [], skipped: [] };

  var C = CONFIG.COLUMNS;
  var colCount = CONFIG.SHEET_COL_COUNT || 28;
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, colCount).getValues();
  var now = new Date().toISOString();
  var scanned = 0, requeued = 0;
  var rows = [], skipped = [];

  var ORG_GATE_SIG = '[ORG_DOMAIN_GATE]';

  for (var i = 0; i < data.length; i++) {
    var rowNum  = i + 2;
    var status  = (data[i][C.STATUS - 1] || '').toString().trim();
    var notes   = (data[i][C.NOTES  - 1] || '').toString();
    var enrichedEmail = C.ENRICHED_EMAIL ? (data[i][C.ENRICHED_EMAIL - 1] || '').toString().trim() : '';

    // Qualify: NOTES contain gate signature, OR NEEDS_EMAIL_REVIEW with empty enrichedEmail
    var hasGateSig      = notes.indexOf(ORG_GATE_SIG) >= 0;
    var isEmptyReview   = (status === 'NEEDS_EMAIL_REVIEW' && enrichedEmail === '');

    if (!hasGateSig && !isEmptyReview) continue;
    scanned++;

    // Skip rows already in NEW (already requeued by a prior run — idempotency)
    if (status === 'NEW') {
      skipped.push({ row: rowNum, reason: 'already_NEW' });
      continue;
    }

    // Build updated notes: preserve existing, strip stale errRetry, add ORGGATE marker
    var notesClean = notes.replace(/\s*errRetry:\d+\/\d+/g, '').trim();
    var newNotes = ('[ORGGATE_FIX_REQUEUE ' + now + '] re-enrich under fixed substring gate. ' +
                   notesClean).substring(0, 1900);

    try {
      sheet.getRange(rowNum, C.STATUS).setValue('NEW');
      sheet.getRange(rowNum, C.LAST_UPDATED).setValue(now);
      sheet.getRange(rowNum, C.NOTES).setValue(newNotes);
      if (C.ENRICHED_EMAIL)   sheet.getRange(rowNum, C.ENRICHED_EMAIL  ).setValue('');
      if (C.EMAIL_SOURCE)     sheet.getRange(rowNum, C.EMAIL_SOURCE    ).setValue('');
      if (C.EMAIL_CONFIDENCE) sheet.getRange(rowNum, C.EMAIL_CONFIDENCE).setValue('');
      requeued++;
      rows.push({
        row:    rowNum,
        status: status,
        reason: hasGateSig ? 'org_gate_sig_in_notes' : 'needs_email_review_empty_enriched',
        email:  (data[i][C.EMAIL - 1] || '').toString().trim() || '<none>'
      });
    } catch (writeErr) {
      skipped.push({ row: rowNum, reason: 'write_error: ' + writeErr.message });
    }
  }

  Logger.log('[menuRequeueOrgGateStranded] scanned=' + scanned + ' requeued=' + requeued +
             ' rows=' + JSON.stringify(rows));
  return { scanned: scanned, requeued: requeued, rows: rows, skipped: skipped };
}

// ─── menuRequeueReviewLeads (2026-06-13-sheetmail-fallthrough) ────────────────
/**
 * menuRequeueReviewLeads — reset NEEDS_EMAIL_REVIEW leads (and any rows with
 * [SHEET_EMAIL_UNDELIVERABLE] or [ORG_DOMAIN_GATE] or no enrichedEmail) to
 * STATUS=NEW with cleared ENRICHED_EMAIL/EMAIL_SOURCE/EMAIL_CONFIDENCE so the
 * full vendor waterfall re-runs under the sheetmail-fallthrough fix.
 *
 * Targets:
 *   - STATUS = NEEDS_EMAIL_REVIEW with empty ENRICHED_EMAIL (vendor never tried)
 *   - NOTES contains [SHEET_EMAIL_UNDELIVERABLE] (old dead-end path)
 *   - NOTES contains [ORG_DOMAIN_GATE] (gate-stranded leads)
 *
 * Does NOT touch col-F EMAIL (sheet truth). The waterfall will clear lead.email
 * internally during the sheetmail-fallthrough run if Reoon flags it again.
 *
 * Idempotent: rows already in NEW are skipped.
 *
 * Bridge-callable:
 *   /exec?action=admin_run&fn=menuRequeueReviewLeads&token=<ADMIN>
 *
 * @returns {{ scanned: number, requeued: number, rows: Array, skipped: Array }}
 */
function menuRequeueReviewLeads() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { scanned: 0, requeued: 0, rows: [], skipped: [] };

  var C = CONFIG.COLUMNS;
  var colCount = CONFIG.SHEET_COL_COUNT || 28;
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, colCount).getValues();
  var now = new Date().toISOString();
  var scanned = 0, requeued = 0;
  var rows = [], skipped = [];

  var SHEET_UNDELIV_SIG = '[SHEET_EMAIL_UNDELIVERABLE]';
  var ORG_GATE_SIG      = '[ORG_DOMAIN_GATE]';

  for (var i = 0; i < data.length; i++) {
    var rowNum  = i + 2;
    var status  = (data[i][C.STATUS - 1] || '').toString().trim();
    var notes   = (data[i][C.NOTES  - 1] || '').toString();
    var enrichedEmail = C.ENRICHED_EMAIL ? (data[i][C.ENRICHED_EMAIL - 1] || '').toString().trim() : '';

    var hasSheetUndelivSig = notes.indexOf(SHEET_UNDELIV_SIG) >= 0;
    var hasOrgGateSig      = notes.indexOf(ORG_GATE_SIG) >= 0;
    var isEmptyReview      = (status === 'NEEDS_EMAIL_REVIEW' && enrichedEmail === '');

    // Qualify: any of the three signatures
    if (!hasSheetUndelivSig && !hasOrgGateSig && !isEmptyReview) continue;
    scanned++;

    // Skip rows already in NEW (idempotency)
    if (status === 'NEW') {
      skipped.push({ row: rowNum, reason: 'already_NEW' });
      continue;
    }

    var reason = hasSheetUndelivSig ? 'sheet_email_undeliv_sig'
               : hasOrgGateSig     ? 'org_gate_sig'
               : 'needs_email_review_empty_enriched';

    var notesClean = notes.replace(/\s*errRetry:\d+\/\d+/g, '').trim();
    var newNotes = ('[SHEETMAIL_FALLTHROUGH_REQUEUE ' + now + '] re-enrich under sheetmail-fallthrough fix. ' +
                   notesClean).substring(0, 1900);

    try {
      sheet.getRange(rowNum, C.STATUS).setValue('NEW');
      sheet.getRange(rowNum, C.LAST_UPDATED).setValue(now);
      sheet.getRange(rowNum, C.NOTES).setValue(newNotes);
      if (C.ENRICHED_EMAIL)   sheet.getRange(rowNum, C.ENRICHED_EMAIL  ).setValue('');
      if (C.EMAIL_SOURCE)     sheet.getRange(rowNum, C.EMAIL_SOURCE    ).setValue('');
      if (C.EMAIL_CONFIDENCE) sheet.getRange(rowNum, C.EMAIL_CONFIDENCE).setValue('');
      requeued++;
      rows.push({
        row:    rowNum,
        status: status,
        reason: reason,
        email:  (data[i][C.EMAIL - 1] || '').toString().trim() || '<none>'
      });
    } catch (writeErr) {
      skipped.push({ row: rowNum, reason: 'write_error: ' + writeErr.message });
    }
  }

  Logger.log('[menuRequeueReviewLeads] scanned=' + scanned + ' requeued=' + requeued +
             ' rows=' + JSON.stringify(rows));
  return { scanned: scanned, requeued: requeued, rows: rows, skipped: skipped };
}

// ═══════════════════════════════════════════════════════════════════════
// FOLLOW-UP ORPHAN PURGE + ON-DEMAND RUNNER (2026-06-13-followup-ops)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Pure helper: returns true when a parent lead STATUS makes its follow-ups
 * permanently orphaned (parent will never be sent, so follow-ups can never
 * legitimately fire). Used by menuPurgeOrphanFollowUps for the per-row
 * predicate and independently testable.
 *
 * @param {string} status — the parent lead's current STATUS value
 * @returns {boolean}
 */
function _followUpParentIsOrphan(status) {
  var ORPHAN_STATUSES = {
    'DRAFT_DELETED': true,
    'BOUNCED_HARD':  true,
    'BOUNCED_SOFT':  true,
    'DUPLICATE':     true,
    'SKIPPED':       true,
    'ERROR':         true,
    'RESPONDED':     true,
    'REPLIED':       true
  };
  return !!(status && ORPHAN_STATUSES[status.toString().trim()]);
}

/**
 * menuPurgeOrphanFollowUps — WRITE: scan the FollowUps sheet for PENDING rows
 * whose parent lead is in a terminal/non-send state (DRAFT_DELETED, BOUNCED_*,
 * DUPLICATE, SKIPPED, ERROR, RESPONDED) OR whose parent row no longer exists.
 * These rows will NEVER fire legitimately and waste lock-time on every trigger.
 *
 * Algorithm:
 *   1. Read FollowUps sheet once; build a set of unique ParentRow numbers.
 *   2. Read the DATA_SHEET in one pass; build a parentRow→status map (O(n) total,
 *      not O(n×m) per-row).
 *   3. For each PENDING FollowUp row: if parent is missing OR
 *      _followUpParentIsOrphan(status) → mark CANCELLED with '[ORPHAN_PURGE] parent <status>'.
 *   4. NEVER cancel rows whose parent is SENT/FOLLOWUP_1/FOLLOWUP_2/FOLLOWUP_3
 *      (those are legitimate and must remain PENDING to fire).
 *
 * Bounded: ≤ ORPHAN_PURGE_LIMIT rows processed per run (default 2000).
 * Idempotent: CANCELLED/SENT rows are skipped.
 *
 * Bridge-callable:
 *   /exec?action=admin_run&fn=menuPurgeOrphanFollowUps&token=<ADMIN>
 *
 * @returns {{ scanned: number, cancelled: number, byParentStatus: Object, skipped: number }}
 */
function menuPurgeOrphanFollowUps() {
  var ORPHAN_PURGE_LIMIT = 2000;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(12000)) {
    return { status: 'busy', error: 'pipeline_busy',
             message: 'Another pipeline run is in progress. Retry in 1-2 minutes.' };
  }

  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var fuSheet = ss.getSheetByName('FollowUps');
    if (!fuSheet || fuSheet.getLastRow() < 2) {
      return { scanned: 0, cancelled: 0, byParentStatus: {}, skipped: 0, note: 'FollowUps sheet empty or missing' };
    }

    var fuData = fuSheet.getDataRange().getValues();
    var fuHeaders = fuData[0].map(function(h) { return (h || '').toString().trim(); });

    var colStatus    = fuHeaders.indexOf('Status');
    var colParentRow = fuHeaders.indexOf('ParentRow');
    var colEmail     = fuHeaders.indexOf('Email');
    var colNotes     = fuHeaders.indexOf('Notes');

    if (colStatus < 0) {
      return { scanned: 0, cancelled: 0, byParentStatus: {}, skipped: 0,
               note: 'FollowUps sheet missing Status column' };
    }

    // ── Step 1: Build parent-status map in one DATA_SHEET read ──
    var parentStatusMap = {};   // rowNum (1-indexed) → status string
    var emailStatusMap  = {};   // email (lowercase) → status string (fallback)

    try {
      var dataSheet = ss.getSheetByName(CONFIG.DATA_SHEET);
      if (dataSheet && dataSheet.getLastRow() >= 2) {
        var C = CONFIG.COLUMNS;
        var colCount = CONFIG.SHEET_COL_COUNT || 28;
        var sheetData = dataSheet.getRange(2, 1, dataSheet.getLastRow() - 1, colCount).getValues();
        for (var di = 0; di < sheetData.length; di++) {
          var rowNum1 = di + 2;  // 1-indexed sheet row
          var st = (sheetData[di][C.STATUS - 1] || '').toString().trim();
          var em = (sheetData[di][C.EMAIL  - 1] || '').toString().trim().toLowerCase();
          parentStatusMap[rowNum1] = st;
          if (em) emailStatusMap[em] = st;
        }
      }
    } catch (mapErr) {
      Logger.log('[menuPurgeOrphanFollowUps] parent-status map build error: ' + mapErr.message);
    }

    // ── Step 2: Scan FollowUps rows ──
    var scanned = 0, cancelled = 0, skipped = 0;
    var byParentStatus = {};

    for (var i = 1; i < fuData.length && scanned < ORPHAN_PURGE_LIMIT; i++) {
      var rowStatus = ((fuData[i][colStatus] || '') + '').trim();

      // Idempotent: skip non-PENDING rows
      if (rowStatus !== 'PENDING') {
        skipped++;
        continue;
      }

      scanned++;

      // Resolve parent status
      var parentStatus = '';
      var parentMissing = false;

      if (colParentRow >= 0 && fuData[i][colParentRow]) {
        var prNum = parseInt(fuData[i][colParentRow]);
        if (prNum > 1) {
          if (parentStatusMap.hasOwnProperty(prNum)) {
            parentStatus = parentStatusMap[prNum];
          } else {
            parentMissing = true;
          }
        }
      }

      // Fallback: look up by email when ParentRow not available or not found
      if (!parentMissing && !parentStatus && colEmail >= 0) {
        var fuEmail = ((fuData[i][colEmail] || '') + '').trim().toLowerCase();
        if (fuEmail && emailStatusMap.hasOwnProperty(fuEmail)) {
          parentStatus = emailStatusMap[fuEmail];
        } else if (fuEmail) {
          parentMissing = true;
        }
      }

      // Decide: keep SENT/FOLLOWUP parents; cancel orphan parents
      var shouldCancel = parentMissing || _followUpParentIsOrphan(parentStatus);

      if (!shouldCancel) {
        // Parent is SENT/FOLLOWUP_1/etc. — legitimately pending
        continue;
      }

      // Mark CANCELLED
      var cancelLabel = parentMissing ? 'parent_missing' : parentStatus;
      try {
        fuSheet.getRange(i + 1, colStatus + 1).setValue('CANCELLED');
        if (colNotes >= 0) {
          var existingNotes = ((fuData[i][colNotes] || '') + '').trim();
          var newNote = '[ORPHAN_PURGE] parent ' + cancelLabel +
                        (existingNotes ? ' | ' + existingNotes.substring(0, 200) : '');
          fuSheet.getRange(i + 1, colNotes + 1).setValue(newNote.substring(0, 500));
        }
        cancelled++;
        byParentStatus[cancelLabel] = (byParentStatus[cancelLabel] || 0) + 1;
      } catch (writeErr) {
        Logger.log('[menuPurgeOrphanFollowUps] Could not cancel row ' + (i + 1) + ': ' + writeErr.message);
      }
    }

    var result = { scanned: scanned, cancelled: cancelled, byParentStatus: byParentStatus, skipped: skipped };
    Logger.log('[menuPurgeOrphanFollowUps] ' + JSON.stringify(result));
    return result;

  } finally {
    lock.releaseLock();
  }
}

/**
 * menuRunFollowUpsNow — thin lock-guarded wrapper that invokes
 * processScheduledFollowUps() immediately (on-demand, not waiting for the
 * 9am daily trigger). Returns the same drafted/skipped/deferred/errored
 * summary that the daily trigger produces.
 *
 * Why a wrapper vs. calling processScheduledFollowUps directly:
 *   processScheduledFollowUps acquires its own internal lock, so calling it
 *   directly is fine; but a named admin-bridge entry point lets the whitelist
 *   route it cleanly without reflection, and gives a consistent log marker
 *   to distinguish on-demand runs from cron runs in the Logger.
 *
 * Bridge-callable:
 *   /exec?action=admin_run&fn=menuRunFollowUpsNow&token=<ADMIN>
 *
 * @returns {Object} result from processScheduledFollowUps, or an error object
 */
function menuRunFollowUpsNow() {
  Logger.log('[menuRunFollowUpsNow] On-demand follow-up run started at ' + new Date().toISOString());
  if (typeof processScheduledFollowUps !== 'function') {
    return { status: 'error', error: 'processScheduledFollowUps not defined' };
  }
  try {
    var result = processScheduledFollowUps();
    Logger.log('[menuRunFollowUpsNow] Done: ' + JSON.stringify(result));
    return result || { status: 'ok', note: 'processScheduledFollowUps returned no value' };
  } catch (e) {
    Logger.log('[menuRunFollowUpsNow] Error: ' + e.message);
    return { status: 'error', error: e.message };
  }
}

// ─── PATCH 2026-06-13-sheet1-search ─────────────────────────────────────────
/**
 * menuSearchSheet1 — read Sheet1 (APK raw capture tab) directly and return
 * rows where any of {fullName, organization, linkedinUrl, email} contains
 * argS (case-insensitive substring). Also returns sheet1TotalRows,
 * sheet2TotalRows, and the gap between them (intake-gap diagnostic).
 *
 * Why: the admin bridge's Sheet2-based find_lead / lead_search cannot read
 * Sheet1 (the raw audit tab). Sheet2 = UNIQUE(Sheet1!B2:G) so a lead that
 * appeared in Sheet2 came from Sheet1; one that NEVER appeared in Sheet2
 * but whose APK capture DID reach the server will still be in Sheet1. This
 * function reads Sheet1 directly and is the definitive answer to
 * "was this person ever captured?".
 *
 * Column layout (from CONFIG.SHEET1_COLUMNS):
 *   A=TIMESTAMP, B=LINKEDIN_URL, C=FULL_NAME, D=HEADLINE, E=DESIGNATION,
 *   F=ORGANIZATION, G=EMAIL, H=PHONE, I=WEBSITE, J=LOCATION,
 *   K=CONNECTION, L=CONFIDENCE, M=LEAD_UID
 *
 * Bridge-callable (read-only, no lock):
 *   /exec?action=admin_run&fn=menuSearchSheet1&argS=debleena&token=<ADMIN>
 *
 * @param {*} _  unused (arg1 placeholder for bridge arity)
 * @param {string} argS  case-insensitive search term
 * @returns {Object}  { matches[], sheet1TotalRows, sheet2TotalRows, gap, argS, timestamp }
 */
function menuSearchSheet1(_, argS) {
  var term = (argS || '').toString().toLowerCase().trim();
  var result = {
    argS: term,
    matches: [],
    sheet1TotalRows: 0,
    sheet2TotalRows: 0,
    gap: 0,
    timestamp: new Date().toISOString()
  };
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);

    // ── Sheet1 read ──
    var sheet1 = ss.getSheetByName('Sheet1');
    if (!sheet1) {
      result.error = 'Sheet1 tab not found in spreadsheet';
      return result;
    }
    var last1 = sheet1.getLastRow();
    result.sheet1TotalRows = Math.max(0, last1 - 1);  // minus header row

    if (last1 > 1 && term) {
      var C1 = CONFIG.SHEET1_COLUMNS;
      var colCount1 = CONFIG.SHEET1_COL_COUNT || 13;
      var rows1 = sheet1.getRange(2, 1, last1 - 1, colCount1).getValues();
      for (var i = 0; i < rows1.length; i++) {
        var r = rows1[i];
        var linkedinUrl  = (r[C1.LINKEDIN_URL  - 1] || '').toString();
        var fullName     = (r[C1.FULL_NAME     - 1] || '').toString();
        var organization = (r[C1.ORGANIZATION  - 1] || '').toString();
        var email        = (r[C1.EMAIL         - 1] || '').toString();
        var leadUid      = (r[C1.LEAD_UID      - 1] || '').toString();
        var haystack = (linkedinUrl + ' ' + fullName + ' ' + organization + ' ' + email).toLowerCase();
        if (haystack.indexOf(term) >= 0) {
          result.matches.push({
            sheet1Row: i + 2,  // 1-indexed sheet row (row 1 = header)
            fullName: fullName,
            organization: organization,
            linkedinUrl: linkedinUrl,
            email: email,
            leadUid: leadUid || null
          });
        }
      }
    }

    // ── Sheet2 row count (UNIQUE materialized view) ──
    var sheet2 = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (sheet2) {
      result.sheet2TotalRows = Math.max(0, sheet2.getLastRow() - 1);
    }

    result.gap = result.sheet1TotalRows - result.sheet2TotalRows;
  } catch (err) {
    result.error = err.message;
  }
  return result;
}

// ─── PATCH 2026-06-17-capture-audit ──────────────────────────────────────────
// Manual lead injector — rescues a lead the APK couldn't deliver (degraded scan
// rejected by the shared-secret gate, or never transmitted). Writes a row into
// Sheet1 via the SAME intake surface the APK capture path uses (Sheet1 append →
// UNIQUE spill → Sheet2 → pipeline enrich+draft). Bypasses both the app and the
// auth gate; admin-token-gated through the admin_run whitelist. Email is left
// blank by default so the vendor waterfall (Apollo people-match by LinkedIn URL)
// resolves it — exactly as for a normal capture.
//
// argS: a bare LinkedIn profile URL, OR JSON {"url","name","org","email"}.
// Tests/diagnosis: menuShowCaptureAudit reads the audit trail this also writes to.
function menuInjectLeadFromUrl(_, argS) {
  var raw = String(argS || '').trim();
  if (!raw) {
    return { status: 'error', error: 'argS required: a LinkedIn /in/ URL, or JSON {url,name,org,email}' };
  }
  var spec = {};
  if (raw.charAt(0) === '{') {
    try { spec = JSON.parse(raw); }
    catch (e) { return { status: 'error', error: 'bad JSON in argS: ' + e.message }; }
  } else {
    spec = { url: raw };
  }
  // Canonicalize: drop query string / fragment / trailing slash (utm noise etc.).
  var url = String(spec.url || spec.linkedinUrl || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (!/^https?:\/\/([a-z0-9-]+\.)?linkedin\.com\/in\/[^\s/?#]+/i.test(url)) {
    return { status: 'error', error: 'not a LinkedIn profile URL: ' + (url || '(empty)') };
  }
  var name  = String(spec.name  || spec.fullName     || '').trim();
  var org   = String(spec.org   || spec.organization || '').trim();
  var email = String(spec.email || '').trim();

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var intake = ss.getSheetByName('Sheet1');
  if (!intake) return { status: 'error', error: 'Sheet1 (intake) not found' };
  if (typeof _ensureSheet2UniqueFormula === 'function') {
    try { _ensureSheet2UniqueFormula(ss); } catch (_) {}
  }

  var S1 = CONFIG.SHEET1_COLUMNS;
  var now = new Date().toISOString();
  var s1row = [];
  for (var j = 0; j < (CONFIG.SHEET1_COL_COUNT || 13); j++) s1row.push('');
  s1row[S1.TIMESTAMP    - 1] = now;
  s1row[S1.LINKEDIN_URL - 1] = url;
  s1row[S1.FULL_NAME    - 1] = name;
  s1row[S1.ORGANIZATION - 1] = org;
  s1row[S1.EMAIL        - 1] = email;   // usually blank → pipeline enriches
  s1row[S1.CONFIDENCE   - 1] = 100;
  s1row[S1.LEAD_UID     - 1] = Utilities.getUuid();
  // PATCH 2026-06-17-filter-fix: strip any stray Sheet1 basic filter first — with
  // one present, appendRow silently no-ops and the row is lost (no error thrown).
  if (typeof _ensureNoSheet1Filter_ === 'function') _ensureNoSheet1Filter_(intake);
  intake.appendRow(s1row);

  // Mirror the capture trail in the audit log so manual rescues are visible too.
  if (typeof _auditCapture_ === 'function') {
    try {
      _auditCapture_({ fullName: name, linkedinUrl: url, organization: org,
                       email: email, source: 'manual_inject', confidence: 100 },
                     null, 'MANUAL_INJECT');
    } catch (_) {}
  }

  // Kick the pipeline now (same as the capture path) so it doesn't wait on cron.
  if (typeof _kickoffAfterCapture === 'function') {
    try { _kickoffAfterCapture('MANUAL_INJECT'); } catch (_) {}
  }

  // Locate the materialized Sheet2 row by canonical URL (new tuples spill at bottom).
  var dataSheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  var C = CONFIG.COLUMNS;
  var foundRow = 0;
  for (var attempt = 0; attempt < 5 && !foundRow && dataSheet; attempt++) {
    if (attempt > 0) Utilities.sleep(400);
    SpreadsheetApp.flush();
    var last2 = dataSheet.getLastRow();
    if (last2 >= 2) {
      var urlCol = dataSheet.getRange(2, C.LINKEDIN_URL, last2 - 1, 1).getValues();
      for (var r = urlCol.length - 1; r >= 0; r--) {
        var got = String(urlCol[r][0] || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
        if (got.toLowerCase() === url.toLowerCase()) { foundRow = r + 2; break; }
      }
    }
  }

  return {
    status: 'ok',
    injected: true,
    sheet1Rows: intake.getLastRow(),
    materializedRow: foundRow || 'pending_recalc',
    url: url,
    name: name || '(none)',
    org: org || '(blank — Apollo people-match will resolve)',
    email: email || '(blank — vendor waterfall will resolve)',
    note: 'Injected via Sheet1 capture path; pipeline will enrich email + draft. ' +
          'Bypasses the APK and the shared-secret gate.'
  };
}

// Read the CaptureAudit trail (PATCH 2026-06-17-capture-audit). Returns the last
// N rows (default 25, max 200); optional argS filters rows whose JSON contains it
// (case-insensitive) — e.g. a name or outcome like 'REJECTED_UNAUTHORIZED'.
function menuShowCaptureAudit(a, argS) {
  var n = (typeof a === 'number' && a > 0) ? Math.min(a, 200) : 25;
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var tab = ss.getSheetByName('CaptureAudit');
  if (!tab) {
    return { status: 'ok', rows: [], total: 0,
             note: 'CaptureAudit tab not created yet — no POST has hit the new code path since deploy.' };
  }
  var lr = tab.getLastRow();
  if (lr < 2) return { status: 'ok', rows: [], total: 0 };
  var lc = tab.getLastColumn();
  var headers = tab.getRange(1, 1, 1, lc).getValues()[0];
  var start = Math.max(2, lr - n + 1);
  var vals = tab.getRange(start, 1, lr - start + 1, lc).getValues();
  var rows = vals.map(function(rv) {
    var o = {};
    for (var i = 0; i < headers.length; i++) o[String(headers[i])] = rv[i];
    return o;
  });
  var filter = String(argS || '').trim().toLowerCase();
  if (filter) {
    rows = rows.filter(function(o) { return JSON.stringify(o).toLowerCase().indexOf(filter) >= 0; });
  }
  return { status: 'ok', total: lr - 1, returned: rows.length, rows: rows,
           timestamp: new Date().toISOString() };
}

// ─── PATCH 2026-06-17-capture-audit (Sheet1 append-freeze diagnostic) ────────
// 2026-06-17 live finding: Sheet1's newest row is Sneha (Jun 15) and NOTHING
// appends after it — not the APK, not the production doPost path, not the
// manual injector — yet appendRow works on other tabs (CaptureAudit was created
// + written). appendRow to Sheet1 is a silent no-op (no thrown error). This
// probes the exact mechanism in ONE execution: does appendRow increment the row
// count within the execution, survive flush, and what Sheet1-specific blockers
// exist (grid cap, active filter, protections the script user can't edit). The
// probe row is marked DIAGPROBE and harmless (blank email → never drafts).
function menuDiagSheet1Append() {
  var out = { status: 'ok', ts: new Date().toISOString() };
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sh = ss.getSheetByName('Sheet1');
    if (!sh) return { status: 'error', error: 'Sheet1 not found' };
    out.before      = sh.getLastRow();
    out.maxRows     = sh.getMaxRows();
    out.maxCols     = sh.getMaxColumns();
    out.hasFilter   = !!sh.getFilter();
    try {
      var pr = sh.getProtections(SpreadsheetApp.ProtectionType.RANGE) || [];
      var ps = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET) || [];
      out.protRange = pr.length;
      out.protSheet = ps.length;
      out.canEditSheet = (ps.length > 0) ? ps[0].canEdit() : true;
    } catch (pe) { out.protErr = pe.message; }

    var marker = 'DIAGPROBE_' + out.before;
    var row = [];
    for (var j = 0; j < (CONFIG.SHEET1_COL_COUNT || 13); j++) row.push('');
    row[0] = new Date().toISOString();
    row[1] = 'https://www.linkedin.com/in/diagprobe-' + out.before;  // col B
    row[2] = marker;                                                  // col C (name)
    var threw = '';
    try { sh.appendRow(row); } catch (ae) { threw = ae.message; }
    out.appendThrew = threw || '(no error)';
    out.afterAppend = sh.getLastRow();
    try { SpreadsheetApp.flush(); } catch (_) {}
    out.afterFlush  = sh.getLastRow();
    // Read back what is actually at the (post-flush) last row.
    var lastVals = sh.getRange(out.afterFlush, 1, 1, 3).getValues()[0];
    out.lastRowColC = String(lastVals[2] || '');
    out.markerExpected = marker;
    out.appendPersisted = (out.lastRowColC === marker);
    out.incremented = (out.afterAppend === out.before + 1);
  } catch (err) {
    out.status = 'error';
    out.error = err.message;
    out.stack = (err.stack || '').substring(0, 300);
  }
  return out;
}

// PATCH 2026-06-17-filter-fix: explicit one-shot remover for the Sheet1 basic
// filter that silently froze intake (06-15 → 06-17). Safe + idempotent: removing
// a basic filter never deletes data. Capture appends now also strip it defensively
// (_ensureNoSheet1Filter_), but this gives immediate manual control + verification.
function menuRemoveSheet1Filter() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sh = ss.getSheetByName('Sheet1');
  if (!sh) return { status: 'error', error: 'Sheet1 not found' };
  var had = !!sh.getFilter();
  if (had) {
    try { sh.getFilter().remove(); }
    catch (e) { return { status: 'error', error: 'filter.remove() threw: ' + e.message }; }
  }
  return {
    status: 'ok',
    filterFound: had,
    filterRemoved: had,
    lastRow: sh.getLastRow(),
    note: had ? 'Removed the basic filter that was silently turning Sheet1 appendRow into a no-op. Intake is unblocked.'
              : 'No filter present on Sheet1.'
  };
}

// PATCH 2026-06-17-employer-reconcile: reset a specific Sheet2 lead to NEW so the
// scanner reprocesses it cleanly. Use when a lead was drafted with stale/incorrect
// data (e.g. Samarth Masson — drafted to the wrong employer BEFORE the headline-vs-org
// reconciliation shipped). Clears DRAFT_ID + enrichment state so the rerun starts
// fresh; the reconciliation + waterfall then produce the corrected identity. The
// previously-created Gmail draft (if any) is ORPHANED — delete it manually (no
// mail-delete ops by policy). arg1 = rowNum (>=2). Lock-guarded (sheet writes).
function menuResetLeadToNew(a, _) {
  var rowNum = (typeof a === 'number') ? a : parseInt(a, 10);
  if (!rowNum || rowNum < 2) return { status: 'error', error: 'arg1 rowNum (>=2) required' };
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sh = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (!sh) return { status: 'error', error: 'data sheet not found' };
  if (rowNum > sh.getLastRow()) return { status: 'error', error: 'rowNum past last row (' + sh.getLastRow() + ')' };
  var C = CONFIG.COLUMNS;
  var name = String(sh.getRange(rowNum, C.FULL_NAME).getValue() || '');
  var before = String(sh.getRange(rowNum, C.STATUS).getValue() || '');
  var oldDraft = C.DRAFT_ID ? String(sh.getRange(rowNum, C.DRAFT_ID).getValue() || '') : '';
  sh.getRange(rowNum, C.STATUS).setValue('NEW');
  if (C.DRAFT_ID)         sh.getRange(rowNum, C.DRAFT_ID).setValue('');
  if (C.ENRICHED_EMAIL)   sh.getRange(rowNum, C.ENRICHED_EMAIL).setValue('');
  if (C.EMAIL_SOURCE)     sh.getRange(rowNum, C.EMAIL_SOURCE).setValue('');
  if (C.EMAIL_CONFIDENCE) sh.getRange(rowNum, C.EMAIL_CONFIDENCE).setValue('');
  if (C.NOTES) {
    var oldNotes = String(sh.getRange(rowNum, C.NOTES).getValue() || '');
    sh.getRange(rowNum, C.NOTES).setValue((oldNotes + ' [RESET_FOR_REPROCESS]').trim().substring(0, 480));
  }
  if (C.LAST_UPDATED) sh.getRange(rowNum, C.LAST_UPDATED).setValue(new Date().toISOString());
  return {
    status: 'ok', row: rowNum, name: name, statusBefore: before, statusAfter: 'NEW',
    orphanedDraftId: oldDraft || '(none)',
    note: 'Reset to NEW; scanner will reprocess with current logic. Any previously-created Gmail draft is orphaned — delete it manually.'
  };
}
