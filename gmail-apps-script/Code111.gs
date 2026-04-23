/**
 * ============================================================
 * Code111.gs — LinkedIn Data Agent (Web App Endpoint)
 * Receives LinkedIn profile data from Android app via doPost().
 * Writes to Sheet1 (raw LinkedIn data) AND syncs to Sheet2
 * (AutoMail pipeline) with duplicate detection.
 * ============================================================
 */

// ─── WEB APP ENDPOINTS ──────────────────────────────────────

/**
 * Handles POST requests from the LinkedIn Android app.
 * Writes data to Sheet1 and optionally syncs to Sheet2 for AutoMail.
 */
function doPost(e) {
  try {
    var ss = SpreadsheetApp.openById('YOUR_GOOGLE_SHEET_ID');
    var data = JSON.parse(e.postData.contents);

    // ─── SHEET1: Raw LinkedIn Data ────────────────────────────
    var sheet1 = ss.getSheetByName('Sheet1');
    if (!sheet1) {
      sheet1 = ss.insertSheet('Sheet1');
    }

    // Create headers if sheet is empty
    if (sheet1.getLastRow() === 0) {
      sheet1.appendRow([
        'Timestamp', 'LinkedIn_URL', 'Full_Name', 'Headline',
        'Designation', 'Organization', 'Email', 'Phone',
        'Website', 'Location', 'Connection', 'Confidence'
      ]);
      sheet1.getRange(1, 1, 1, 12).setFontWeight('bold');
    }

    // Write LinkedIn data to Sheet1
    sheet1.appendRow([
      data.timestamp || new Date().toISOString(),
      data.linkedinUrl || '',
      data.fullName || '',
      data.headline || '',
      data.currentDesignation || data.designation || '',
      data.currentOrganization || data.organization || '',
      data.email || '',
      data.phone || '',
      data.website || '',
      data.location || '',
      data.connectionDegree || '',
      data.confidence || ''
    ]);

    // ─── SHEET2: AutoMail Pipeline Sync ───────────────────────
    // Only sync if email exists (required for outreach)
    var syncStatus = 'skipped';
    if (data.email && data.email.trim() !== '') {
      try {
        var pipelineSheet = ss.getSheetByName('Sheet2');
        if (!pipelineSheet) {
          // Create Sheet2 with headers if it doesn't exist
          pipelineSheet = ss.insertSheet('Sheet2');
          pipelineSheet.appendRow([
            'LinkedIn_URL', 'Full_Name', 'Headline', 'Designation',
            'Organization', 'Email', 'Pipeline_Status', 'Research_JSON',
            'Archetype', 'Template', 'Resume_Variant', 'Subject_Line',
            'Email_Body', 'Quality_Score', 'Draft_ID', 'Followup_Stage',
            'Response_Status', 'Notes', 'Sent_Date', 'Followup_Dates',
            'Last_Updated'
          ]);
          pipelineSheet.getRange(1, 1, 1, 21).setFontWeight('bold');
        }

        // Check for duplicate email in Sheet2
        var lastRow = pipelineSheet.getLastRow();
        var isDuplicate = false;

        if (lastRow > 1) {
          var emailCol = 6; // Column F = Email
          var existingEmails = pipelineSheet.getRange(2, emailCol, lastRow - 1, 1).getValues();
          var newEmail = data.email.trim().toLowerCase();

          for (var i = 0; i < existingEmails.length; i++) {
            if (existingEmails[i][0] && existingEmails[i][0].toString().trim().toLowerCase() === newEmail) {
              isDuplicate = true;
              break;
            }
          }
        }

        if (!isDuplicate) {
          // Append to Sheet2 — columns A through F, matches CONFIG.COLUMNS order
          pipelineSheet.appendRow([
            data.linkedinUrl || '',                                  // A: LinkedIn_URL
            data.fullName || '',                                     // B: Full_Name
            data.headline || '',                                     // C: Headline
            data.currentDesignation || data.designation || '',       // D: Designation
            data.currentOrganization || data.organization || '',     // E: Organization
            data.email || ''                                         // F: Email
          ]);
          syncStatus = 'synced';
        } else {
          syncStatus = 'duplicate';
        }
      } catch (syncErr) {
        Logger.log('AutoMail sync error: ' + syncErr.message);
        syncStatus = 'error: ' + syncErr.message;
      }
    }

    return ContentService
      .createTextOutput(JSON.stringify({
        status: 'success',
        message: 'Data received',
        automail_sync: syncStatus
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('doPost error: ' + err.message);
    return ContentService
      .createTextOutput(JSON.stringify({
        status: 'error',
        message: err.message
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Health check endpoint for the web app.
 */
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({
      status: 'active',
      version: '2.0',
      features: ['linkedin_capture', 'automail_sync'],
      timestamp: new Date().toISOString()
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Manual trigger: Sync all Sheet1 leads with email to Sheet2.
 * Useful for backfilling existing LinkedIn data into the pipeline.
 */
function syncSheet1ToSheet2() {
  var ss = SpreadsheetApp.openById('YOUR_GOOGLE_SHEET_ID');
  var sheet1 = ss.getSheetByName('Sheet1');
  var sheet2 = ss.getSheetByName('Sheet2');

  if (!sheet1 || !sheet2) {
    Logger.log('syncSheet1ToSheet2: Sheet1 or Sheet2 not found');
    return;
  }

  var lastRow1 = sheet1.getLastRow();
  if (lastRow1 < 2) {
    Logger.log('syncSheet1ToSheet2: No data in Sheet1');
    return;
  }

  // Get existing emails in Sheet2 for dedup
  var existingEmails = {};
  var lastRow2 = sheet2.getLastRow();
  if (lastRow2 > 1) {
    var emailData = sheet2.getRange(2, 6, lastRow2 - 1, 1).getValues(); // Column F = Email
    for (var i = 0; i < emailData.length; i++) {
      if (emailData[i][0]) {
        existingEmails[emailData[i][0].toString().trim().toLowerCase()] = true;
      }
    }
  }

  // Read Sheet1 data (columns: Timestamp, LinkedIn_URL, Full_Name, Headline, Designation, Organization, Email, ...)
  var data1 = sheet1.getRange(2, 1, lastRow1 - 1, 12).getValues();
  var synced = 0;
  var skipped = 0;

  for (var j = 0; j < data1.length; j++) {
    var row = data1[j];
    var email = (row[6] || '').toString().trim(); // Column G = Email (index 6)

    if (!email) { skipped++; continue; }

    if (existingEmails[email.toLowerCase()]) { skipped++; continue; }

    // Append to Sheet2 — matches CONFIG.COLUMNS order: LinkedIn_URL, Full_Name, Headline, Designation, Organization, Email
    sheet2.appendRow([
      row[1] || '',   // A: LinkedIn_URL (Sheet1 index 1)
      row[2] || '',   // B: Full_Name (Sheet1 index 2)
      row[3] || '',   // C: Headline (Sheet1 index 3)
      row[4] || '',   // D: Designation (Sheet1 index 4)
      row[5] || '',   // E: Organization (Sheet1 index 5)
      email            // F: Email (Sheet1 index 6)
    ]);

    existingEmails[email.toLowerCase()] = true;
    synced++;
  }

  Logger.log('syncSheet1ToSheet2: Synced ' + synced + ' leads, skipped ' + skipped);

  try {
    SpreadsheetApp.getUi().alert(
      'Sync Complete',
      'Synced ' + synced + ' new leads to Sheet2 (pipeline).\nSkipped ' + skipped + ' (no email or duplicate).',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (e) {
    // UI not available (running from trigger)
  }
}
