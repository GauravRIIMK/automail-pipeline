/**
 * ============================================================
 * Code111.gs — LinkedIn Data Agent integration utilities.
 *
 * As of 2026-05-11, the doPost/doGet handlers that previously lived here
 * have been MERGED into WebApp.gs (single unified handler that routes both
 * the APK rich payload AND the Chrome extension / PWA minimal payload).
 * Apps Script can only have ONE doPost(e) per project — having two caused
 * silent shadowing where the second-loaded file's handler won, dropping
 * the APK's full payload.
 *
 * What's still here: syncSheet1ToSheet2 — useful manual backfill that
 * promotes existing Sheet1 (raw APK capture) rows into Sheet2 (pipeline).
 * Wired to the AutoMail Pipeline menu via Tools → Sync Sheet1 → Sheet2.
 * ============================================================
 */

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
