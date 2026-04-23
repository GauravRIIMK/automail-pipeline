/**
 * ============================================================
 * BatchProcessor.gs — Batch Orchestration with Triggers
 * Handles the 6-minute GAS execution limit by processing
 * leads in batches of 5 with time-based trigger chaining.
 * Uses LockService to prevent concurrent execution.
 * ============================================================
 */

// ─── MAIN BATCH PROCESSOR ──────────────────────────────────

/**
 * Processes the next batch of NEW leads through the full pipeline.
 * Each lead goes: Research → Classify → Resume Select → Compose → Humanize → Quality Gate → Draft
 * @param {boolean} [force] - Skip timing checks
 */
function processNextBatch(force) {
  // Acquire lock to prevent concurrent execution
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    Logger.log('BatchProcessor: Could not acquire lock. Another batch is running.');
    return;
  }

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
        updateLeadFields(lead.rowNum, {
          STATUS: STATUS.ERROR,
          NOTES: 'Pipeline error: ' + e.message
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
 * Processes one lead through all pipeline stages.
 * @param {Object} lead - LeadProfile
 */
function _processOneLead(lead) {
  Logger.log('Processing lead: ' + lead.fullName + ' (Row ' + lead.rowNum + ')');

  // ── Stage 0: Input Validation & Email Enrichment ──
  // Name is required; email gets classified/verified/guessed below.
  if (!lead.fullName) {
    var errMsg = 'Missing Full_Name for row ' + lead.rowNum + '. Ensure column B contains the person\'s name.';
    updateLeadFields(lead.rowNum, { STATUS: STATUS.ERROR, NOTES: errMsg });
    throw new Error(errMsg);
  }
  if (!lead.organization) {
    Logger.log('[BatchProcessor] Row ' + lead.rowNum + ': No organization found in column E. Research quality may be limited.');
  }

  // Email enrichment gate: classify free vs. corporate, verify MX, guess patterns if missing.
  // Routes low-confidence / missing emails to NEEDS_EMAIL_REVIEW (human pick) or NEEDS_EMAIL (dead end)
  // instead of letting them pollute the pipeline with guaranteed bounces.
  try {
    var enrichment = (typeof enrichEmail === 'function') ? enrichEmail(lead) : { status: 'VERIFIED', email: lead.email, classification: 'CORPORATE', source: 'INPUT' };
    logPipelineEvent(lead.rowNum, 'ENRICH', 'status=' + enrichment.status + ' class=' + (enrichment.classification || '-') + ' src=' + (enrichment.source || '-') + (enrichment.reason ? ' reason=' + enrichment.reason : ''));

    // Persist enrichment results (cols X–Y) when we have useful data
    var enrichUpdates = {};
    if (enrichment.email)  enrichUpdates.ENRICHED_EMAIL = enrichment.email;
    if (enrichment.source) enrichUpdates.EMAIL_SOURCE   = enrichment.source;
    if (Object.keys(enrichUpdates).length) updateLeadFields(lead.rowNum, enrichUpdates);

    if (enrichment.status === 'NEEDS_EMAIL') {
      updateLeadFields(lead.rowNum, {
        STATUS: STATUS.NEEDS_EMAIL || 'NEEDS_EMAIL',
        NOTES: 'No verified email found. ' + (enrichment.reason || 'Provide email in column F, then re-queue.')
      });
      return;
    }
    if (enrichment.status === 'NEEDS_EMAIL_REVIEW') {
      var candidatesStr = (enrichment.candidates || []).join(' | ');
      updateLeadFields(lead.rowNum, {
        STATUS: STATUS.NEEDS_EMAIL_REVIEW || 'NEEDS_EMAIL_REVIEW',
        NOTES: 'Pattern-guessed candidates (pick one into col F): ' + candidatesStr
      });
      return;
    }

    // VERIFIED: swap enriched email onto the lead for downstream stages
    if (enrichment.email && enrichment.email !== lead.email) {
      lead.email = enrichment.email;
    }
  } catch (enrichErr) {
    // Enricher failure must not kill the run; fall back to raw-email sanity check.
    Logger.log('[BatchProcessor] enrichEmail failed for row ' + lead.rowNum + ': ' + enrichErr.message);
    if (!lead.email || lead.email.indexOf('@') < 0) {
      var errMsg2 = 'Invalid or missing email for "' + (lead.fullName || 'Unknown') + '". Got: "' + (lead.email || '(empty)') + '".';
      updateLeadFields(lead.rowNum, { STATUS: STATUS.ERROR, NOTES: errMsg2 });
      throw new Error(errMsg2);
    }
  }

  // ── Stage 1: Already done (lead parsed from sheet) ──

  // ── Stage 2: Research ──
  var dossier;
  try {
    dossier = researchLead(lead);
    // Bug #1 fix: Persist research result to RESEARCH_JSON column
    updateLeadFields(lead.rowNum, {
      RESEARCH_JSON: typeof dossier === 'string' ? dossier : JSON.stringify(dossier),
      STATUS: STATUS.RESEARCH_DONE
    });
    logStageError(lead.rowNum, 'RESEARCH', null, { success: true });
  } catch (e) {
    logStageError(lead.rowNum, 'RESEARCH', e, { lead: lead.fullName });
    updateLeadFields(lead.rowNum, {
      STATUS: STATUS.ERROR,
      NOTES: 'Research failed: ' + e.message
    });
    return; // Critical stage - stop processing
  }

  // ── Stage 2.5: Classify ──
  var classification;
  try {
    var compressedDossier = decompressDossier(
      _getDataSheet().getRange(lead.rowNum, CONFIG.COLUMNS.RESEARCH_JSON).getValue()
    );
    classification = classifyLead(lead, compressedDossier);
    logStageError(lead.rowNum, 'CLASSIFY', null, { archetype: classification.archetype });
  } catch (e) {
    logStageError(lead.rowNum, 'CLASSIFY', e, { lead: lead.fullName });
    updateLeadFields(lead.rowNum, {
      STATUS: STATUS.ERROR,
      NOTES: 'Classification failed: ' + e.message
    });
    return; // Critical stage - stop processing
  }

  // Check if should be skipped
  if (classification.archetype === 'SKIPPED') {
    updateLeadFields(lead.rowNum, {
      STATUS: STATUS.SKIPPED,
      NOTES: classification.reasoning
    });
    logPipelineEvent(lead.rowNum, 'BATCH', 'Lead skipped: ' + classification.reasoning);
    return;
  }

  // ── Stage 3: Resume Selection ──
  var resumeSelection;
  try {
    resumeSelection = selectResume(lead, compressedDossier, classification);
    logStageError(lead.rowNum, 'RESUME_SELECT', null, { variant: resumeSelection.variantId });
  } catch (e) {
    logStageError(lead.rowNum, 'RESUME_SELECT', e, { lead: lead.fullName });
    // Non-critical - use default and continue
    resumeSelection = { variantId: 'GROWTH_MARKETING' };
  }

  // ── Stage 4: Email Composition ──
  var composed;
  try {
    composed = composeEmail(lead, compressedDossier, classification, resumeSelection);
    if (!composed.success) {
      logStageError(lead.rowNum, 'COMPOSE', new Error(composed.qualityNotes), {});
      updateLeadFields(lead.rowNum, {
        STATUS: STATUS.ERROR,
        NOTES: 'Composition failed: ' + composed.qualityNotes
      });
      return; // Critical stage - stop processing
    }
    logStageError(lead.rowNum, 'COMPOSE', null, { success: true });
  } catch (e) {
    logStageError(lead.rowNum, 'COMPOSE', e, { lead: lead.fullName });
    updateLeadFields(lead.rowNum, {
      STATUS: STATUS.ERROR,
      NOTES: 'Composition failed: ' + e.message
    });
    return; // Critical stage - stop processing
  }

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

      if (reQuality.passed || reQuality.score > quality.score) {
        finalSubject = reHumanized.subjectLine;
        finalBody = reHumanized.emailBody;
        quality = reQuality;
        logPipelineEvent(lead.rowNum, 'BATCH', 'Recomposition improved quality to ' + reQuality.score.toFixed(2));
      }
    }
  }

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
    var combinedScore = (quality.score * 0.45) + (mvVerdict.score * 0.55);
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
        if (mvReverdict.score > mvVerdict.score) {
          finalSubject = mvRehum.subjectLine;
          finalBody = mvRehum.emailBody;
          quality.score = (quality.score * 0.3) + (mvReverdict.score * 0.7);
          logPipelineEvent(lead.rowNum, 'BATCH',
            'MasterValidator recomp improved score to ' + mvReverdict.score.toFixed(2));
        }
      }
    }

    // BLOCK verdict → don't create draft, route to REVIEW with full notes
    if (mvVerdict.verdict === 'BLOCK') {
      quality.passed = false;
      quality.score = Math.min(quality.score, 0.4);
      updateLeadFields(lead.rowNum, {
        NOTES: 'BLOCKED by MasterValidator: ' + mvVerdict.fatalIssues.slice(0, 2).join('; ')
      });
    }
  } catch (mvErr) {
    logPipelineEvent(lead.rowNum, 'MASTER_VALIDATE', 'Validator failed (non-blocking): ' + mvErr.message, 'ERROR');
  }

  // ── Stage 7: Write Results ──
  try {
    writeEmailResult(lead.rowNum, {
      archetype: classification.archetype,
      template: classification.template,
      resumeVariant: resumeSelection.variantId,   // selectResume returns .variantId not .label
      subjectLine: finalSubject,
      emailBody: finalBody,
      qualityScore: quality.score,
      status: STATUS.REVIEW
    });
  } catch (e) {
    logStageError(lead.rowNum, 'DRAFT_CREATE', e, { stage: 'writeEmailResult' });
    // Continue anyway - try to save what we can
  }

  // ── Stage 8: Gmail Draft (auto-create if quality score > 0.8) ──
  if (quality.score >= 0.8) {
    try {
      var draftResult = createDraft(lead, finalSubject, finalBody, resumeSelection);

      if (draftResult.success) {
        var draftUpdates = {
          DRAFT_ID: draftResult.draftId,
          STATUS: STATUS.DRAFT_CREATED
        };
        // Persist threadId + RFC 2822 Message-ID so follow-ups thread natively
        if (draftResult.threadId)       draftUpdates.THREAD_ID         = draftResult.threadId;
        if (draftResult.rfc822MessageId) draftUpdates.RFC822_MESSAGE_ID = draftResult.rfc822MessageId;
        updateLeadFields(lead.rowNum, draftUpdates);
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
            updateLeadFields(lead.rowNum, {
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
      }
    } catch (e) {
      logStageError(lead.rowNum, 'DRAFT_CREATE', e, { lead: lead.fullName });
      // Non-critical - draft creation failed but don't fail the whole pipeline
    }
  } else {
    logPipelineEvent(lead.rowNum, 'BATCH',
      'Quality score ' + quality.score.toFixed(2) + ' < 0.8 threshold. Draft NOT auto-created. Set to REVIEW.');
  }

  Logger.log('Lead ' + lead.fullName + ' complete. Status: ' +
    (quality.score >= 0.8 ? 'DRAFT_CREATED' : 'READY_FOR_REVIEW') +
    ', Quality: ' + quality.score.toFixed(2));
}

// ─── RESUME-ONLY PIPELINE (for leads already researched) ──

/**
 * Processes leads that have research but no email yet.
 */
function processResearchedLeads() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) return;

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
          var draftResult = createDraft(lead, humanized.subjectLine, humanized.emailBody, resumeSelection);
          if (draftResult.success) {
            var rUpd = {
              DRAFT_ID: draftResult.draftId,
              STATUS: STATUS.DRAFT_CREATED
            };
            if (draftResult.threadId)        rUpd.THREAD_ID         = draftResult.threadId;
            if (draftResult.rfc822MessageId) rUpd.RFC822_MESSAGE_ID = draftResult.rfc822MessageId;
            updateLeadFields(lead.rowNum, rUpd);

            lead.threadId        = draftResult.threadId || lead.threadId || '';
            lead.rfc822MessageId = draftResult.rfc822MessageId || lead.rfc822MessageId || '';

            var followUps = generateFollowUps(lead, humanized.subjectLine, dossier, classification);
            if (followUps && followUps.length > 0) {
              _persistFollowUps(lead, followUps);
              updateLeadFields(lead.rowNum, {
                FOLLOWUP_DATES: JSON.stringify(followUps.map(function(f) {
                  return { stage: f.stage, offsetDays: f.offsetDays, framework: f.framework };
                }))
              });
            }
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

    var linkedInUrl = (values[CONFIG.COLUMNS.LINKEDIN_URL - 1] || '').toString().trim();
    var fullName    = (values[CONFIG.COLUMNS.FULL_NAME - 1] || '').toString().trim();
    var email       = (values[CONFIG.COLUMNS.EMAIL - 1] || '').toString().trim();
    var status      = (values[CONFIG.COLUMNS.STATUS - 1] || '').toString().trim();

    // Required minimum input: name + valid email (LinkedIn URL optional but preferred)
    if (!fullName || !email || email.indexOf('@') < 0) return;

    // Only trigger for NEW/empty status rows (skip already-processed, ERROR, SENT, etc.)
    if (status !== '' && status !== STATUS.NEW) return;

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
      if (status === '') {
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
      Logger.log('[AutoTrigger] Row ' + row + ' failed: ' + innerErr.message);
      try {
        updateLeadFields(row, {
          STATUS: STATUS.ERROR,
          NOTES: 'Auto-trigger error: ' + innerErr.message
        });
      } catch (uErr) { /* swallow */ }
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

    // Short debounce — the extension often fires multiple change events per lead
    var props = PropertiesService.getScriptProperties();
    var lastChangeTs = parseInt(props.getProperty('AUTO_CHANGE_LAST_TS') || '0', 10);
    var now = new Date().getTime();
    if (now - lastChangeTs < 15000) {
      Logger.log('[AutoChange] Debounced (< 15s since last onChange). Skipping scan.');
      return;
    }
    props.setProperty('AUTO_CHANGE_LAST_TS', String(now));

    Logger.log('[AutoChange] Fired (type=' + changeType + '). Scanning Sheet2 for unprocessed rows...');
    _scanAndProcessNewRows('AUTO_CHANGE');
  } catch (err) {
    Logger.log('[AutoChange] Fatal: ' + err.message);
  }
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
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('[Scan:' + source + '] Another run holds the lock. Scheduling batch trigger as fallback.');
    _scheduleBatchTrigger();
    return;
  }

  var startTime = new Date().getTime();
  var processed = 0, scanned = 0, skipped = 0;

  try {
    startPipelineRun(source);

    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.DATA_SHEET);
    if (!sheet) {
      Logger.log('[Scan:' + source + '] Sheet "' + CONFIG.DATA_SHEET + '" not found.');
      return;
    }

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) { Logger.log('[Scan:' + source + '] No data rows.'); return; }

    var lastCol = CONFIG.SHEET_COL_COUNT || 25;
    var data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

    // Iterate rows; collect candidates first, then process (bounded by time)
    var candidates = [];
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      var rowNum = i + 2;
      var fullName = (row[CONFIG.COLUMNS.FULL_NAME - 1] || '').toString().trim();
      var email    = (row[CONFIG.COLUMNS.EMAIL - 1] || '').toString().trim();
      var status   = (row[CONFIG.COLUMNS.STATUS - 1] || '').toString().trim();

      if (!fullName || !email || email.indexOf('@') < 0) continue;
      if (status !== '' && status !== STATUS.NEW) continue;
      candidates.push({ rowNum: rowNum, fullName: fullName });
    }

    scanned = candidates.length;
    Logger.log('[Scan:' + source + '] Found ' + scanned + ' candidate rows for processing.');

    if (scanned === 0) return;

    // Process up to BATCH_SIZE rows, respecting the 6-min execution ceiling.
    var maxThisRun = Math.min(scanned, CONFIG.BATCH_SIZE || 5);
    for (var j = 0; j < maxThisRun; j++) {
      var elapsed = new Date().getTime() - startTime;
      if (elapsed > (CONFIG.MAX_RUNTIME_MS || 300000)) {
        Logger.log('[Scan:' + source + '] Time budget exhausted at row ' + j + '/' + maxThisRun);
        break;
      }

      var cand = candidates[j];

      // Per-row dedupe — don't reprocess same row within 2 min
      var dedupeKey = 'AUTO_PROCESSED_ROW_' + cand.rowNum;
      var ps = PropertiesService.getScriptProperties();
      var lastTs = parseInt(ps.getProperty(dedupeKey) || '0', 10);
      if (new Date().getTime() - lastTs < 120000) { skipped++; continue; }
      ps.setProperty(dedupeKey, String(new Date().getTime()));

      try {
        // Mark NEW if currently blank so downstream treats it as fresh
        updateLeadFields(cand.rowNum, { STATUS: STATUS.NEW });
        var lead = getLeadByRow(cand.rowNum);
        if (!lead) { Logger.log('[Scan:' + source + '] Null lead for row ' + cand.rowNum); continue; }
        _processOneLead(lead);
        _PIPELINE_RUN.leadCount = (_PIPELINE_RUN.leadCount || 0) + 1;
        processed++;
      } catch (innerErr) {
        Logger.log('[Scan:' + source + '] Row ' + cand.rowNum + ' failed: ' + innerErr.message);
        try {
          updateLeadFields(cand.rowNum, { STATUS: STATUS.ERROR, NOTES: source + ' error: ' + innerErr.message });
        } catch (_) {}
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
}

/**
 * Safety-net handler called by time-based trigger every 5 min.
 * Catches anything missed by onChange/onEdit (extensions sometimes write with
 * changeType='OTHER' that's filtered out, or onChange may have failed silently).
 */
function autoProcessSafetyNet() {
  _scanAndProcessNewRows('SAFETY_NET');
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
