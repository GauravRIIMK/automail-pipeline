/**
 * ============================================================
 * SheetReader.gs — Stage 1: Sheet Reader & Lead Parser
 * Reads Sheet2 data, creates LeadProfile objects, manages
 * pipeline status columns, and handles batch selection.
 * ============================================================
 */

// ─── CORE: GET LEADS FOR PROCESSING ────────────────────────

/**
 * Fetches the next batch of leads ready for processing.
 * @param {number} [batchSize] - Override CONFIG.BATCH_SIZE
 * @param {string} [targetStatus] - Status to filter (default: NEW)
 * @returns {Array<Object>} Array of LeadProfile objects with row numbers
 */
function getNextBatch(batchSize, targetStatus) {
  batchSize = batchSize || CONFIG.BATCH_SIZE;
  targetStatus = targetStatus || STATUS.NEW;

  var sheet = _getDataSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return []; // No data rows

  var data = sheet.getRange(2, 1, lastRow - 1, CONFIG.SHEET_COL_COUNT || 25).getValues();
  var leads = [];

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var status = (row[CONFIG.COLUMNS.STATUS - 1] || '').toString().trim();

    // Pick leads that match target status, or NEW (empty status)
    if (status === targetStatus || (targetStatus === STATUS.NEW && status === '')) {
      var lead = _rowToLeadProfile(row, i + 2); // +2 because row 1 is header, array is 0-indexed
      if (lead && (lead.email || lead.fullName)) {
        leads.push(lead);
        if (leads.length >= batchSize) break;
      }
    }
  }

  return leads;
}

/**
 * Gets a single lead by row number.
 * @param {number} rowNum - 1-indexed row number
 * @returns {Object|null} LeadProfile or null
 */
function getLeadByRow(rowNum) {
  var sheet = _getDataSheet();
  if (rowNum < 2) return null;
  var row = sheet.getRange(rowNum, 1, 1, CONFIG.SHEET_COL_COUNT || 25).getValues()[0];
  return _rowToLeadProfile(row, rowNum);
}

/**
 * Gets all leads with a specific status.
 * @param {string} status
 * @returns {Array<Object>}
 */
function getLeadsByStatus(status) {
  var sheet = _getDataSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var data = sheet.getRange(2, 1, lastRow - 1, CONFIG.SHEET_COL_COUNT || 25).getValues();
  var leads = [];

  for (var i = 0; i < data.length; i++) {
    var rowStatus = (data[i][CONFIG.COLUMNS.STATUS - 1] || '').toString().trim();
    if (rowStatus === status) {
      var lead = _rowToLeadProfile(data[i], i + 2);
      if (lead) leads.push(lead);
    }
  }

  return leads;
}

// ─── LEAD PROFILE CONSTRUCTOR ──────────────────────────────

/**
 * Converts a sheet row into a structured LeadProfile object.
 * @param {Array} row - Raw row data
 * @param {number} rowNum - 1-indexed row number
 * @returns {Object} LeadProfile
 */
function _rowToLeadProfile(row, rowNum) {
  var c = CONFIG.COLUMNS;

  // Read columns using CONFIG.COLUMNS indices
  // Column order: A=LinkedIn_URL, B=Full_Name, C=Headline, D=Designation, E=Organization, F=Email
  var linkedinUrl  = (row[c.LINKEDIN_URL - 1] || '').toString().trim();
  var fullName     = (row[c.FULL_NAME - 1] || '').toString().trim();
  var headline     = (row[c.HEADLINE - 1] || '').toString().trim();
  var designation  = (row[c.DESIGNATION - 1] || '').toString().trim();
  var organization = (row[c.ORGANIZATION - 1] || '').toString().trim();
  var email        = (row[c.EMAIL - 1] || '').toString().trim();

  // Skip rows with no name or email
  if (!fullName && !email) return null;

  // Parse name parts
  var nameParts = fullName.split(' ');
  var firstName = nameParts[0] || '';
  var lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

  // Validation: warn if email doesn't look right
  if (email && email.indexOf('@') < 0) {
    Logger.log('[SheetReader] Row ' + rowNum + ' WARNING: email column value "' + email + '" has no @ sign. Check column order.');
  }

  // Parse sentDate safely (can be ISO string, Date, or empty)
  var sentDateRaw = row[c.SENT_DATE - 1];
  var sentDate = null;
  if (sentDateRaw) {
    if (sentDateRaw instanceof Date) {
      sentDate = sentDateRaw;
    } else {
      var parsed = new Date(sentDateRaw);
      if (!isNaN(parsed.getTime())) sentDate = parsed;
    }
  }

  return {
    // Core data (from smart detection above, not raw row indices)
    rowNum: rowNum,
    linkedinUrl: linkedinUrl,
    fullName: fullName,
    firstName: firstName,
    lastName: lastName,
    headline: headline,
    designation: designation,
    organization: organization,
    email: email,

    // Derived from headline parsing
    seniority: _parseSeniority(designation, headline),
    function_: _parseFunction(designation, headline),
    isHR: _isHRRole(designation, headline),
    isFounder: _isFounderRole(designation, headline),

    // Pipeline state (these columns G-U are never affected by the A-F reorder)
    status: (row[c.STATUS - 1] || '').toString().trim() || STATUS.NEW,
    researchJSON: (row[c.RESEARCH_JSON - 1] || '').toString().trim(),
    archetype: (row[c.ARCHETYPE - 1] || '').toString().trim(),
    template: (row[c.TEMPLATE - 1] || '').toString().trim(),
    resumeVariant: (row[c.RESUME_VARIANT - 1] || '').toString().trim(),
    subjectLine: (row[c.SUBJECT_LINE - 1] || '').toString().trim(),
    emailBody: (row[c.EMAIL_BODY - 1] || '').toString().trim(),
    qualityScore: parseFloat(row[c.QUALITY_SCORE - 1]) || 0,
    draftId: (row[c.DRAFT_ID - 1] || '').toString().trim(),
    followupStage: parseInt(row[c.FOLLOWUP_STAGE - 1]) || 0,
    responseStatus: (row[c.RESPONSE_STATUS - 1] || '').toString().trim(),
    notes: (row[c.NOTES - 1] || '').toString().trim(),
    sentDate: sentDate,
    followupDates: (row[c.FOLLOWUP_DATES - 1] || '').toString().trim(),
    lastUpdated: (row[c.LAST_UPDATED - 1] || '').toString().trim(),

    // Threading & enrichment (columns V-Y, added 2026-04)
    threadId: c.THREAD_ID ? (row[c.THREAD_ID - 1] || '').toString().trim() : '',
    rfc822MessageId: c.RFC822_MESSAGE_ID ? (row[c.RFC822_MESSAGE_ID - 1] || '').toString().trim() : '',
    enrichedEmail: c.ENRICHED_EMAIL ? (row[c.ENRICHED_EMAIL - 1] || '').toString().trim() : '',
    emailSource: c.EMAIL_SOURCE ? (row[c.EMAIL_SOURCE - 1] || '').toString().trim() : ''
  };
}

// ─── SENIORITY & FUNCTION PARSERS ──────────────────────────

function _parseSeniority(designation, headline) {
  var combined = (designation + ' ' + headline).toLowerCase();

  if (/\b(ceo|cto|coo|cfo|cmo|cpo|founder|co-founder|cofounder|managing director|md)\b/.test(combined)) {
    return 'C_SUITE';
  }
  if (/\b(vp|vice president|svp|evp|avp|senior vice|head of|director|senior director)\b/.test(combined)) {
    return 'VP_DIRECTOR';
  }
  if (/\b(senior manager|sr\. manager|sr manager|principal|lead|team lead|associate director)\b/.test(combined)) {
    return 'SENIOR_MANAGER';
  }
  if (/\b(manager|program manager|product manager)\b/.test(combined)) {
    return 'MANAGER';
  }
  if (/\b(associate|analyst|executive|coordinator|specialist|intern)\b/.test(combined)) {
    return 'JUNIOR';
  }
  return 'UNKNOWN';
}

function _parseFunction(designation, headline) {
  var combined = (designation + ' ' + headline).toLowerCase();

  if (/\b(hr|human resource|talent|recruit|people|hiring)\b/.test(combined)) return 'HR';
  if (/\b(market|growth|brand|demand gen|digital|content|seo|sem|performance)\b/.test(combined)) return 'MARKETING';
  if (/\b(product|pm|product management)\b/.test(combined)) return 'PRODUCT';
  if (/\b(engineer|developer|software|tech lead|architect|devops|sre|backend|frontend|fullstack)\b/.test(combined)) return 'ENGINEERING';
  if (/\b(data|analytics|data science|ml|ai|machine learning)\b/.test(combined)) return 'DATA';
  if (/\b(operat|supply chain|logistics|procurement|warehouse)\b/.test(combined)) return 'OPERATIONS';
  if (/\b(sales|business develop|bd|account|revenue)\b/.test(combined)) return 'SALES';
  if (/\b(finance|accounting|cfo|controller|treasury)\b/.test(combined)) return 'FINANCE';
  if (/\b(consult|strateg|advisory)\b/.test(combined)) return 'CONSULTING';
  if (/\b(ceo|founder|co-founder|managing director|general manager|gm)\b/.test(combined)) return 'LEADERSHIP';
  return 'GENERAL';
}

function _isHRRole(designation, headline) {
  var combined = (designation + ' ' + headline).toLowerCase();
  return /\b(hr|human resource|talent|recruit|people ops|hiring manager|ta |talent acquisition)\b/.test(combined);
}

function _isFounderRole(designation, headline) {
  var combined = (designation + ' ' + headline).toLowerCase();
  return /\b(founder|co-founder|cofounder|ceo)\b/.test(combined);
}

// ─── STATUS & DATA UPDATE METHODS ──────────────────────────

/**
 * Updates the status of a lead in the sheet.
 * @param {number} rowNum
 * @param {string} newStatus
 */
function updateLeadStatus(rowNum, newStatus) {
  var sheet = _getDataSheet();
  sheet.getRange(rowNum, CONFIG.COLUMNS.STATUS).setValue(newStatus);
  sheet.getRange(rowNum, CONFIG.COLUMNS.LAST_UPDATED).setValue(new Date().toISOString());
}

/**
 * Writes multiple pipeline fields for a lead back to the sheet.
 * @param {number} rowNum
 * @param {Object} updates - Key-value pairs matching CONFIG.COLUMNS keys
 */
function updateLeadFields(rowNum, updates) {
  var sheet = _getDataSheet();
  var c = CONFIG.COLUMNS;

  for (var key in updates) {
    if (c[key] && updates[key] !== undefined) {
      sheet.getRange(rowNum, c[key]).setValue(updates[key]);
    }
  }
  // Always update timestamp
  sheet.getRange(rowNum, c.LAST_UPDATED).setValue(new Date().toISOString());
}

/**
 * Writes the full email result back to the sheet.
 * @param {number} rowNum
 * @param {Object} result - { archetype, template, resumeVariant, subjectLine, emailBody, qualityScore, draftId }
 */
function writeEmailResult(rowNum, result) {
  var c = CONFIG.COLUMNS;
  var sheet = _getDataSheet();
  var now = new Date().toISOString();

  // Batch write contiguous pipeline columns (ARCHETYPE=9 through DRAFT_ID=15)
  sheet.getRange(rowNum, c.ARCHETYPE, 1, 7).setValues([[
    result.archetype || '',
    result.template || '',
    result.resumeVariant || '',
    result.subjectLine || '',
    result.emailBody || '',
    result.qualityScore || 0,
    result.draftId || ''
  ]]);

  // STATUS (col 7) and LAST_UPDATED are non-contiguous — write separately
  sheet.getRange(rowNum, c.STATUS).setValue(result.status || STATUS.REVIEW);
  sheet.getRange(rowNum, c.LAST_UPDATED).setValue(now);

  // Threading IDs (cols V-W) — written when draft creation returns them
  if (c.THREAD_ID && result.threadId) {
    sheet.getRange(rowNum, c.THREAD_ID).setValue(result.threadId);
  }
  if (c.RFC822_MESSAGE_ID && result.rfc822MessageId) {
    sheet.getRange(rowNum, c.RFC822_MESSAGE_ID).setValue(result.rfc822MessageId);
  }
}

// ─── SHEET INITIALIZATION ──────────────────────────────────

/**
 * Ensures pipeline tracking columns have headers.
 * Run once during setup.
 */
function initializePipelineColumns() {
  var sheet = _getDataSheet();
  var c = CONFIG.COLUMNS;
  var colCount = CONFIG.SHEET_COL_COUNT || 25;

  var headers = {};
  // Input columns A-F (matches LinkedIn Agent / Sheet1 format)
  headers[c.LINKEDIN_URL] = 'LinkedIn_URL';
  headers[c.FULL_NAME] = 'Full_Name';
  headers[c.HEADLINE] = 'Headline';
  headers[c.DESIGNATION] = 'Designation';
  headers[c.ORGANIZATION] = 'Organization';
  headers[c.EMAIL] = 'Email';
  // Pipeline tracking columns G-U
  headers[c.STATUS] = 'Pipeline_Status';
  headers[c.RESEARCH_JSON] = 'Research_JSON';
  headers[c.ARCHETYPE] = 'Archetype';
  headers[c.TEMPLATE] = 'Template';
  headers[c.RESUME_VARIANT] = 'Resume_Variant';
  headers[c.SUBJECT_LINE] = 'Subject_Line';
  headers[c.EMAIL_BODY] = 'Email_Body';
  headers[c.QUALITY_SCORE] = 'Quality_Score';
  headers[c.DRAFT_ID] = 'Draft_ID';
  headers[c.FOLLOWUP_STAGE] = 'Followup_Stage';
  headers[c.RESPONSE_STATUS] = 'Response_Status';
  headers[c.NOTES] = 'Notes';
  headers[c.SENT_DATE] = 'Sent_Date';
  headers[c.FOLLOWUP_DATES] = 'Followup_Dates';
  headers[c.LAST_UPDATED] = 'Last_Updated';
  // Threading & enrichment columns V-Y (added 2026-04 for follow-up threading + email verification)
  if (c.THREAD_ID)         headers[c.THREAD_ID]         = 'Thread_ID';
  if (c.RFC822_MESSAGE_ID) headers[c.RFC822_MESSAGE_ID] = 'RFC822_Message_ID';
  if (c.ENRICHED_EMAIL)    headers[c.ENRICHED_EMAIL]    = 'Enriched_Email';
  if (c.EMAIL_SOURCE)      headers[c.EMAIL_SOURCE]      = 'Email_Source';

  for (var col in headers) {
    sheet.getRange(1, parseInt(col)).setValue(headers[col]);
  }

  // Bold all headers across the full pipeline width
  sheet.getRange(1, 1, 1, colCount).setFontWeight('bold');

  Logger.log('Pipeline columns A-' + _colIndexToLetter(colCount) + ' initialized in Sheet2');
  SpreadsheetApp.getUi().alert(
    'All ' + colCount + ' pipeline columns (A-' + _colIndexToLetter(colCount) + ') initialized in Sheet2.\n\n' +
    'Input columns A-F:\n' +
    'A: LinkedIn_URL | B: Full_Name | C: Headline | D: Designation | E: Organization | F: Email\n\n' +
    'Threading columns V-Y:\n' +
    'V: Thread_ID | W: RFC822_Message_ID | X: Enriched_Email | Y: Email_Source'
  );
}

/** Convert 1-indexed column number to A1 letter (25 -> Y, 26 -> Z, 27 -> AA). */
function _colIndexToLetter(n) {
  var s = '';
  while (n > 0) {
    var r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ─── SAME-COMPANY CLUSTER DETECTION ────────────────────────

/**
 * Groups leads by organization for cluster handling.
 * @returns {Object} { orgName: [lead1, lead2, ...], ... }
 */
function getCompanyClusters() {
  var sheet = _getDataSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};

  var data = sheet.getRange(2, 1, lastRow - 1, CONFIG.SHEET_COL_COUNT || 25).getValues();
  var clusters = {};

  for (var i = 0; i < data.length; i++) {
    var org = (data[i][CONFIG.COLUMNS.ORGANIZATION - 1] || '').toString().trim().toLowerCase();
    if (!org) continue;

    if (!clusters[org]) clusters[org] = [];
    clusters[org].push({
      rowNum: i + 2,
      fullName: data[i][CONFIG.COLUMNS.FULL_NAME - 1],
      designation: data[i][CONFIG.COLUMNS.DESIGNATION - 1],
      status: data[i][CONFIG.COLUMNS.STATUS - 1] || STATUS.NEW,
      seniority: _parseSeniority(
        (data[i][CONFIG.COLUMNS.DESIGNATION - 1] || '').toString(),
        (data[i][CONFIG.COLUMNS.HEADLINE - 1] || '').toString()
      )
    });
  }

  // Only return clusters with >1 lead
  var multiClusters = {};
  for (var orgKey in clusters) {
    if (clusters[orgKey].length > 1) {
      multiClusters[orgKey] = clusters[orgKey];
    }
  }

  return multiClusters;
}

/**
 * Checks if a lead should be skipped due to cluster rules.
 * @param {Object} lead
 * @returns {Object} { skip: boolean, reason: string }
 */
function checkClusterSkip(lead) {
  if (!lead.organization) return { skip: false, reason: '' };

  var orgKey = lead.organization.toLowerCase();
  var sheet = _getDataSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { skip: false, reason: '' };

  var data = sheet.getRange(2, 1, lastRow - 1, CONFIG.SHEET_COL_COUNT || 25).getValues();

  // Count how many from same org were emailed this week
  var oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  var recentlySent = 0;
  var seniorExists = false;

  for (var i = 0; i < data.length; i++) {
    var rowOrg = (data[i][CONFIG.COLUMNS.ORGANIZATION - 1] || '').toString().trim().toLowerCase();
    if (rowOrg !== orgKey) continue;

    var rowStatus = (data[i][CONFIG.COLUMNS.STATUS - 1] || '').toString();
    var lastUpdated = data[i][CONFIG.COLUMNS.LAST_UPDATED - 1];

    if ([STATUS.DRAFT_CREATED, STATUS.SENT].indexOf(rowStatus) >= 0 && lastUpdated) {
      var updateDate = new Date(lastUpdated);
      if (updateDate >= oneWeekAgo) recentlySent++;
    }

    // Check if a more senior person from same org already contacted
    var rowSeniority = _parseSeniority(
      (data[i][CONFIG.COLUMNS.DESIGNATION - 1] || '').toString(),
      (data[i][CONFIG.COLUMNS.HEADLINE - 1] || '').toString()
    );
    if (['C_SUITE', 'VP_DIRECTOR'].indexOf(rowSeniority) >= 0 &&
        data[i][CONFIG.COLUMNS.FULL_NAME - 1] !== lead.fullName &&
        [STATUS.DRAFT_CREATED, STATUS.SENT, STATUS.REVIEW].indexOf(rowStatus) >= 0) {
      seniorExists = true;
    }
  }

  // Bug #11 fix: Replace cross-file EDGE_CASES dependency with local constant
  var MAX_PER_COMPANY_PER_WEEK = 2;
  if (recentlySent >= MAX_PER_COMPANY_PER_WEEK) {
    return { skip: true, reason: 'CLUSTER_LIMIT: ' + recentlySent + ' emails already sent to ' + lead.organization + ' this week' };
  }

  // Rule: skip junior HR if senior from same org exists
  if (lead.isHR && lead.seniority === 'JUNIOR' && seniorExists) {
    return { skip: true, reason: 'CLUSTER_PRIORITY: Senior contact already reached at ' + lead.organization };
  }

  return { skip: false, reason: '' };
}

// ─── PIPELINE LOG ──────────────────────────────────────────

/**
 * Logs a pipeline event to the PipelineLog sheet.
 * @param {number} rowNum
 * @param {string} stage
 * @param {string} message
 * @param {string} [level] - INFO, WARN, ERROR
 */
function logPipelineEvent(rowNum, stage, message, level) {
  level = level || 'INFO';
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var logSheet = ss.getSheetByName(CONFIG.LOG_SHEET);

    if (!logSheet) {
      logSheet = ss.insertSheet(CONFIG.LOG_SHEET);
      logSheet.getRange(1, 1, 1, 6).setValues([['Timestamp', 'RunID', 'Row', 'Stage', 'Level', 'Message']]);
    }

    // Second-pass fix: BatchProcessor defines _PIPELINE_RUN.runId, not .id
    var runId = (typeof _PIPELINE_RUN !== 'undefined' && _PIPELINE_RUN && (_PIPELINE_RUN.runId || _PIPELINE_RUN.id)) ? (_PIPELINE_RUN.runId || _PIPELINE_RUN.id) : '';

    logSheet.appendRow([
      new Date().toISOString(),
      runId,
      rowNum,
      stage,
      level,
      message.substring(0, 500) // Truncate long messages
    ]);
  } catch (e) {
    Logger.log('Log write failed: ' + e.message);
  }
}

// ─── HELPERS ───────────────────────────────────────────────

/**
 * Gets the Sheet2 data sheet.
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function _getDataSheet() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  return ss.getSheetByName(CONFIG.DATA_SHEET);
}

/**
 * Counts leads by status for dashboard display.
 * @returns {Object} { NEW: 5, RESEARCH_DONE: 3, ... }
 */
function getLeadStatusCounts() {
  var sheet = _getDataSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};

  var statuses = sheet.getRange(2, CONFIG.COLUMNS.STATUS, lastRow - 1, 1).getValues();
  var counts = {};

  statuses.forEach(function(row) {
    var s = (row[0] || STATUS.NEW).toString().trim() || STATUS.NEW;
    counts[s] = (counts[s] || 0) + 1;
  });

  return counts;
}