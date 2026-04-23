/**
 * ============================================================
 * Config.gs — AutoMail Pipeline: Configuration Constants
 * Reframed for JOB-SEEKING cold emails to Indian startup leaders
 * ============================================================
 */

// ─── SPREADSHEET SETUP ──────────────────────────────────────
var CONFIG = {
  // Sheet IDs and names
  SHEET_ID: 'YOUR_GOOGLE_SHEET_ID',
  DATA_SHEET: 'Sheet2',             // Main data sheet with lead list
  LOG_SHEET: 'PipelineLog',         // Log sheet for debugging

  // ─── PIPELINE PROCESSING ───────────────────────────────────

  // Batch processing
  BATCH_SIZE: 5,                    // Leads to process per trigger execution
  MAX_RUNTIME_MS: 300000,           // 5 minutes (safety margin under 6 min GAS limit)
  LOCK_TIMEOUT_MS: 5000,            // Lock wait time to prevent concurrent runs
  TRIGGER_INTERVAL_MIN: 2,          // Minutes between batch triggers

  // Deliverability safety
  DAILY_DRAFT_LIMIT: 25,            // Max drafts per day (Gmail personal safety)
  DAILY_SEND_LIMIT: 20,             // Recommended max sends per day
  MIN_DELAY_BETWEEN_DRAFTS_MS: 3000,// 3 second delay between draft creation

  // ─── AI MODELS ─────────────────────────────────────────────
  GEMINI_MODEL: 'gemini-2.5-flash',    // Update here when Google deprecates a model
  CLAUDE_MODEL: 'claude-sonnet-4-5-20250929',  // Sonnet 4.5/4.6 respects negative constraints best (used by FollowUp LLM composer)

  // ─── GEMINI AI SYSTEM PROMPT ───────────────────────────────
  // Reframed: Job-seeking research expert who analyzes role-fit signals
  GEMINI_SYSTEM_PROMPT: 'You are an expert job-seeking research analyst with deep knowledge of Indian startup ecosystems, organizational challenges, and strategic fit assessment. Your role is to help identify role-fit signals, understand org-specific challenges that match Gaurav\'s expertise, and uncover natural conversation hooks. Focus on: (1) Identifying growth/operations/strategy challenges the company faces, (2) Finding trigger events (funding, launches, expansion) that suggest staffing needs, (3) Locating authentic connection points based on shared background or mutual connections, (4) Assessing organizational maturity and decision-making structure to inform outreach approach.',

  // ─── SHEET COLUMNS (1-indexed) ─────────────────────────────
  // Matches LinkedIn Agent (Sheet1) column order for seamless sync
  COLUMNS: {
    // Input columns (Cols A-F) — matches Code111 / LinkedIn Agent format
    LINKEDIN_URL: 1,       // A: LinkedIn URL
    FULL_NAME: 2,          // B: Full Name
    HEADLINE: 3,           // C: Headline/Summary
    DESIGNATION: 4,        // D: Designation/Title
    ORGANIZATION: 5,       // E: Organization
    EMAIL: 6,              // F: Email

    // Pipeline state columns (Cols G-U)
    STATUS: 7,             // G: Pipeline_Status
    RESEARCH_JSON: 8,      // H: Research_JSON (compressed)
    ARCHETYPE: 9,          // I: Archetype
    TEMPLATE: 10,          // J: Template
    RESUME_VARIANT: 11,    // K: Resume_Variant
    SUBJECT_LINE: 12,      // L: Subject_Line
    EMAIL_BODY: 13,        // M: Email_Body
    QUALITY_SCORE: 14,     // N: Quality_Score
    DRAFT_ID: 15,          // O: Draft_ID
    FOLLOWUP_STAGE: 16,    // P: Followup_Stage
    RESPONSE_STATUS: 17,   // Q: Response_Status
    NOTES: 18,             // R: Notes
    // Bug #9 fix: Add missing columns referenced by SheetReader.gs
    SENT_DATE: 19,           // S: Sent_Date
    FOLLOWUP_DATES: 20,      // T: Followup_Dates
    LAST_UPDATED: 21,        // U: Last_Updated
    // 2026 rewrite — Gmail threading + email enrichment columns
    THREAD_ID: 22,           // V: Gmail thread ID captured from createDraft (enables threaded follow-ups)
    RFC822_MESSAGE_ID: 23,   // W: RFC 2822 Message-ID header (fallback for cross-client threading)
    ENRICHED_EMAIL: 24,      // X: Verified/guessed email used by the pipeline (kept alongside original in F)
    EMAIL_SOURCE: 25         // Y: 'sheet_corporate' | 'guessed_pattern' | 'rejected' — audit trail
  },
  // Total width (used by SheetReader getRange calls). Bump when new columns are added.
  SHEET_COL_COUNT: 25
};

// ─── PIPELINE STATUS CONSTANTS ──────────────────────────────
var STATUS = {
  NEW: 'NEW',                                // Unprocessed lead
  NEEDS_EMAIL: 'NEEDS_EMAIL',                // Email gate: no usable address; no enrichment candidates possible
  NEEDS_EMAIL_REVIEW: 'NEEDS_EMAIL_REVIEW',  // Email gate: candidates proposed; user must pick one and re-run
  RESEARCHING: 'RESEARCHING',                // Currently researching
  RESEARCH_DONE: 'RESEARCH_DONE',            // Research complete, ready to classify
  CLASSIFYING: 'CLASSIFYING',                // Analyzing lead fit
  COMPOSING: 'COMPOSING',                    // Writing email
  HUMANIZING: 'HUMANIZING',                  // Making it more natural
  QUALITY_CHECK: 'QUALITY_CHECK',            // QualityGate review
  REVIEW: 'REVIEW',                          // Manual review needed (flag for user)
  DRAFT_CREATED: 'DRAFT_CREATED',            // Gmail draft ready
  SENT: 'SENT',                              // Email sent (anchors follow-up countdown)
  FOLLOWUP_1: 'FOLLOWUP_1',                  // First follow-up sent
  FOLLOWUP_2: 'FOLLOWUP_2',                  // Second follow-up sent
  FOLLOWUP_3: 'FOLLOWUP_3',                  // Third follow-up sent
  RESPONDED: 'RESPONDED',                    // Lead responded
  SKIPPED: 'SKIPPED',                        // Lead skipped (not a fit)
  ERROR: 'ERROR'                             // Processing error
};

// ─── DELIVERABILITY SETTINGS ───────────────────────────────
var DELIVERABILITY = {
  maxDailyDrafts: 25,
  maxDailySends: 20,
  minInterDraftDelayMs: 3000,
  warmupSchedule: {      // Gradual ramp-up for new senders
    week1: 5,
    week2: 10,
    week3: 15,
    week4: 20,
    week5Plus: 25
  },
  trackingProperty: 'DAILY_DRAFTS_'  // Property key prefix for daily count
};

// ─── GAURAV PROFILE: Resume Highlights by Variant ──────────
var GAURAV_PROFILE = {
  GROWTH_MARKETING: {
    variant: 'GROWTH_MARKETING',
    title: 'Growth & Operations Lead',
    achievements: [
      'Senior Manager at Blinkit Bistro (Zomato): Scaled ~50 cloud kitchens across 4 cities with end-to-end P&L ownership and SLA management',
      'Profitability Waterfall: 13 margin interventions generating Rs 5.7L/month (~Rs 68L annualized)',
      'Quality Crisis Resolution: Cut complaint rate by 94% across 121K orders, closed 40% of quality gap in 2.5 weeks',
      'At Thoughtworks: Built AI-powered email system reducing drafting by 85%, managed 8 MarTech tools, achieved 25% APAC conversion lift and 30% CAC reduction',
      'At Blinkit Growth: GTM launch for 38 dark stores, doubled DAUs YoY growth rate to 15%, reduced marketing costs 40%',
      'At upGrad: Built referral program from 0 to Rs 15Cr in 4 months with 100+ successful career transitions'
    ]
  },
  OPS_CONSULTING: {
    variant: 'OPS_CONSULTING',
    title: 'Operations & Strategy Consultant',
    achievements: [
      'Station P&L Ownership: End-to-end profit/loss, inventory, quality, and SLA management for 50+ cloud kitchens across 4 cities',
      'Inventory Optimization: QR-based putaway system with 10-15 min SLA, ~200 daily restocking cycles at ~100% adherence',
      'Analytics & Reporting: Built 8-tab quality analytics dashboard integrating 30+ cross-functional stakeholders',
      'Quality & Compliance: Managed cold-chain audits, FEFO workflows, GRN processes, and SLA scorecards — reduced complaints 94%',
      'P&L Workbook: Created 35K-formula workbook for real-time unit economics across all stations',
      'Stakeholder Management: Coordinated ops, supply chain, quality, and vendor teams to execute 40% quality gap closure in 2.5 weeks'
    ]
  },
  PRODUCT_AI_STRATEGY: {
    variant: 'PRODUCT_AI_STRATEGY',
    title: 'Product & AI Strategy Lead',
    achievements: [
      '6-Component AI Pipeline: Domain-restricted RAG system on Weaviate for B2B email generation, 800K+ character output with LangChain and Python',
      '85% Drafting Reduction: Automated routine email workflows for 8 MarTech tools, cut manual effort by 85%',
      '25% Conversion Boost: Predictive lead scoring and B2B segmentation (4x5x3x4 matrix) adopted globally across Thoughtworks APAC',
      'GTM Strategy & Unit Economics: P&L modeling, customer segmentation, and pricing strategy for SaaS products',
      'Tech Stack: Expertise in Jasper AI, LangChain, Weaviate RAG, DSPy prompt engineering, Sheets/Docs API integration',
      'Product Roadmap & Execution: Led product launches (38 dark stores GTM), feature prioritization, and stakeholder alignment'
    ]
  }
};

// ─── TEMPORAL CONSTANTS (used by recency validator) ─────
// Today's date reference for "is this fact stale?" checks. Update once a year.
var CURRENT_YEAR = 2026;

// ─── GAURAV EXHAUSTIVE ACHIEVEMENT BANK (for validator fact-checks) ─────
// Each metric claim below is a VERIFIED fact from Gaurav's resumes. The validator
// uses this bank to confirm that any specific number / achievement / tool / role
// Claude emits in an email actually maps to a real line item. Anything not listed
// here is treated as unverified and flagged.
//
// Shape: each entry is a free-text achievement + a machine-readable "metrics" array
// of numeric/proper-noun tokens that MUST appear in the email text when citing this
// achievement, and an "aliases" array of alternate phrasings. The validator
// matches against normalized (lowercased, punctuation-stripped) body text.
var GAURAV_ACHIEVEMENT_BANK = {
  // ── Blinkit Bistro / Zomato (Cloud Kitchens) ──
  'blinkit_bistro_scale':        { metrics: ['50', '4 cities', 'cloud kitchens', 'p&l'], aliases: ['50 cloud kitchens', 'cloud kitchen', 'dark kitchen', 'bistro'], role: 'Senior Manager', org: 'Blinkit Bistro' },
  'blinkit_bistro_margin':       { metrics: ['13', '5.7', '68'],                          aliases: ['margin interventions', 'profitability waterfall', '68L', '68 lakh', '5.7L'], role: 'Senior Manager', org: 'Blinkit Bistro' },
  'blinkit_bistro_quality':      { metrics: ['94', '121', '40', '2.5'],                   aliases: ['complaint rate', 'quality gap', '121K orders', '94%', '2.5 weeks'], role: 'Senior Manager', org: 'Blinkit Bistro' },
  'blinkit_bistro_inventory':    { metrics: ['10', '15', '200'],                          aliases: ['qr-based putaway', 'qr putaway', 'restocking cycles', 'sla adherence', 'fefo', 'grn'], role: 'Senior Manager', org: 'Blinkit Bistro' },
  'blinkit_bistro_workbook':     { metrics: ['35', '35k'],                                aliases: ['35K formula', '35k-formula', 'p&l workbook', 'unit economics workbook'], role: 'Senior Manager', org: 'Blinkit Bistro' },
  'blinkit_bistro_dashboard':    { metrics: ['8', '30'],                                  aliases: ['8-tab', 'quality dashboard', 'cross-functional stakeholders'], role: 'Senior Manager', org: 'Blinkit Bistro' },

  // ── Blinkit Growth ──
  'blinkit_growth_launch':       { metrics: ['38'],                                       aliases: ['38 dark stores', 'dark stores', 'gtm launch', 'store launch'], role: 'Growth Manager', org: 'Blinkit' },
  'blinkit_growth_dau':          { metrics: ['15'],                                       aliases: ['dau', 'daily active', 'yoy growth', 'doubled dau'], role: 'Growth Manager', org: 'Blinkit' },
  'blinkit_growth_cac':          { metrics: ['40'],                                       aliases: ['marketing cost', 'cac reduction', '40% cac', 'acquisition cost'], role: 'Growth Manager', org: 'Blinkit' },

  // ── Thoughtworks ──
  'thoughtworks_ai_pipeline':    { metrics: ['6', '800'],                                 aliases: ['6-component', 'ai pipeline', 'rag', 'weaviate', 'langchain', 'b2b email'], role: 'Consultant', org: 'Thoughtworks' },
  'thoughtworks_drafting':       { metrics: ['85', '8'],                                  aliases: ['85% drafting', 'email system', 'martech tools', 'drafting by 85'], role: 'Consultant', org: 'Thoughtworks' },
  'thoughtworks_conversion':     { metrics: ['25', '30'],                                 aliases: ['apac conversion', 'conversion lift', 'cac reduction', 'lead scoring', 'b2b segmentation', '4x5x3x4'], role: 'Consultant', org: 'Thoughtworks' },

  // ── upGrad ──
  'upgrad_referral':             { metrics: ['15', '100', '0', '4'],                      aliases: ['referral program', '15cr', '15 cr', '100+ career transitions', 'career transitions', 'from 0 to'], role: 'Growth Lead', org: 'upGrad' },

  // ── Tech Stack / Tools (verified) ──
  'tools_stack':                 { metrics: [],                                            aliases: ['jasper ai', 'langchain', 'weaviate', 'dspy', 'python', 'sheets api', 'docs api', 'apps script', 'rag system', 'prompt engineering'], role: 'Cross-cutting', org: 'Cross-cutting' }
};

// All verified numbers/metrics across all roles (for quick "is this number real?" lookup)
var GAURAV_METRIC_WHITELIST = [
  '50', '4', '13', '5.7', '68', '94', '121', '40', '2.5', '10', '15', '200', '35', '8', '30',
  '38', '6', '800', '85', '25', '800k', '35k', '15cr', '68l', '5.7l', '121k',
  '0', '100', '4x5x3x4'
];

// Verified roles Gaurav has held (for "I led X" / "As a Y" verification)
var GAURAV_VERIFIED_ROLES = [
  'senior manager', 'growth manager', 'consultant', 'growth lead',
  'operations lead', 'strategy lead', 'product lead', 'p&l owner',
  'manager', 'lead', 'consultant', 'analyst'
];

// ─── GAURAV VERIFIED FACTS (anti-hallucination ground truth) ─────
// Used by EmailComposer to fact-check Claude's output before sending.
// Any claim about Gaurav's background MUST match one of these entries.
var GAURAV_FACTS = {
  // ─── Education (ONLY these institutions) ──
  education: [
    { institution: 'IIM Kozhikode', degree: 'MBA', type: 'postgrad' },
    { institution: 'Thapar University', degree: 'B.E.', type: 'undergrad' }
  ],
  // Keywords that identify his ACTUAL alma maters (for regex matching)
  alumniKeywords: ['iim kozhikode', 'iim k', 'iimk', 'thapar university', 'thapar'],

  // ─── Work History (ONLY these companies) ──
  companies: ['Blinkit', 'Blinkit Bistro', 'Zomato', 'Thoughtworks', 'upGrad', 'Shiprocket'],

  // ─── FALSE alumni claims to catch ──
  // These are institutions/orgs often confused with lead orgs.
  // If Claude claims "fellow alum" of any of these, it's hallucination.
  notAlumniOf: [
    'great lakes', 'great learning', 'iim bangalore', 'iim ahmedabad',
    'iim calcutta', 'iim lucknow', 'iim indore', 'iit', 'bits pilani',
    'xlri', 'fms', 'isb', 'sp jain', 'nmims', 'symbiosis', 'christ university',
    'manipal', 'amity', 'lovely professional'
  ],

  // ─── Current identity for signature ──
  fullName: 'Gaurav Rathore',
  signatureLine1: 'MBA, IIM Kozhikode | B.E., Thapar University',
  linkedin: 'https://www.linkedin.com/in/gaurav1-grow-learn-together'
};

// ─── COLD EMAIL PLAYBOOK RULES ─────────────────────────────
var COLD_EMAIL_RULES = {
  // Subject line constraints
  subjectLineWordCount: {
    min: 2,
    max: 4
  },
  subjectLineCharacters: {
    max: 40
  },

  // Body constraints
  bodyWordCount: {
    min: 50,
    max: 125
  },

  // Banned opening lines (2026 research-backed dead list — Prospeo, Digital Bloom, Woodpecker)
  bannedOpeners: [
    'I hope this email finds you well',
    'I hope you are doing well',
    'My name is',
    'I\'m reaching out because',
    'I am reaching out because',
    'I wanted to reach out',
    'I wanted to connect',
    'I believe you might be interested',
    'I came across your profile',
    'I saw your profile',
    'Sorry to bother you',
    'I know you are busy',
    'Just following up',
    'Dear [Name]'
  ],

  // Banned subject lines
  bannedSubjectPatterns: [
    'job inquiry',
    'seeking opportunities',
    'resume attached',
    'employment opportunity',
    'career change',
    'looking for a role'
  ],

  // Opening archetypes (choose one per email)
  archetypes: [
    'Earned Compliment — genuine praise for specific work/decision',
    'Shared Connection — mutual contact or overlapping background',
    'Observation — specific insight about their company/market',
    'Provocative Question — challenge their thinking on a topic',
    'Relevant Metric — data point that ties to their domain',
    'Trigger Event — funding, launch, expansion announcement',
    'Contrarian Insight — thoughtful disagreement or alternative view'
  ],

  // CTA frameworks (choose one)
  ctaFrameworks: [
    'Interest-based: "Would it be useful if I shared..."',
    'Time-based: "15 min this week?"',
    'Question-based: "What\'s your take on...?"'
  ],

  // Email structure: BAB / PAS / Timeline Hook
  frameworkOptions: [
    'BAB: Before-After-Bridge (contrast, resolution, call-to-action)',
    'PAS: Problem-Agitate-Solve (identify pain, deepen concern, propose conversation)',
    'Timeline Hook: Time-sensitive reason for conversation now'
  ],

  // Signature format
  signatureFormat: 'Gaurav Rathore\n[One-line capability]\nlinkedin.com/in/gaurav1-grow-learn-together',

  // Mandatory rules
  mandatoryRules: [
    'NO HTML formatting',
    'NO attachments mentioned (first email never includes attachments)',
    'NO direct job-asking language (hire me, job opportunity, position)',
    'Every sentence passes "so what?" filter',
    'Include P.S. line as second hook',
    'Frame as exploring role-fit based on company challenges, NOT selling services',
    'Ask for conversation, NOT a job directly'
  ]
};

// ─── SPAM TRIGGER WORDS (2026 Gmail filter list) ────────────
var SPAM_TRIGGER_WORDS = {
  fatal: [
    'act now', 'limited time offer', 'buy now', 'click here', 'free gift',
    'winner', 'congratulations', 'no obligation', 'risk free',
    'double your income', 'earn money', 'cash bonus', 'order now',
    'apply now', 'dear friend', 'once in a lifetime', 'act immediately',
    'million dollars', 'special offer'
  ],
  warning: [
    'exclusive deal', 'incredible', 'amazing offer', 'best price',
    'bargain', 'bonus', 'clearance', 'drastically reduced',
    'save big', 'lowest price', 'subscribe now', 'opt in'
  ]
};

// ─── SUBJECT LINE BLACKLIST ────────────────────────────────
var SUBJECT_BLACKLIST = [
  'free', 'urgent', 'act now', 'limited time', 'exclusive', 'guaranteed',
  'congratulations', 'winner', 'discount', 'promotion', 'claim now',
  'for a limited time only', 'hurry', 'asap', 'before it\'s too late',
  'last chance', 'don\'t miss out', 'unbelievable', 'incredible', 'amazing',
  'shocking', 'secret', 'no catch', 'risk-free', 'money-back guarantee',
  'satisfaction guaranteed'
];

// ─── QUALITY GATE THRESHOLDS ───────────────────────────────
var QUALITY_GATES = {
  minPersonalizationScore: 60,     // Min score (0-100) for personalization
  minLengthWords: 50,              // Min words in body
  maxLengthWords: 125,             // Max words in body (job-seeking constraint)
  maxSpamWords: 2,                 // Max fatal spam words allowed
  minSubjectLength: 2,             // Min subject line words
  maxSubjectLength: 4              // Max subject line words (playbook rule)
};

// ─── EMAIL COMPOSING SETTINGS ───────────────────────────────
var EMAIL_CONFIG = {
  // Plain-text signatures (HTML formatting handled by EmailComposer.gs _buildHtmlEmail)
  signatureVariants: {
    growth: 'Gaurav Rathore\nGrowth & Operations Leader',
    ops: 'Gaurav Rathore\nOperations & Strategy Consultant',
    product: 'Gaurav Rathore\nProduct & AI Strategy Lead'
  },

  openingHookPatterns: {
    compliment: 'I\'ve been impressed by [SPECIFIC_ACHIEVEMENT] at [COMPANY]...',
    observation: 'Noticed your recent [TRIGGER_EVENT] — interesting move on [CONTEXT]...',
    shared: 'Saw you worked with [SHARED_CONNECTION] — we share background in [DOMAIN]...',
    question: 'Quick thought: how are you thinking about [ORG_CHALLENGE] as [COMPANY] scales?'
  }
};

// ─── LEAD CLASSIFICATION ARCHETYPES (Job-seeking reframed) ──
var ARCHETYPES = {
  FOUNDER_CEO: {
    roles: ['ceo', 'founder', 'co-founder'],
    hook: 'perspective_advice',
    template: 'FOUNDER_PERSPECTIVE',
    approach: 'Ask for perspective on industry/company direction, frame as learning from their vision'
  },
  VP_DIRECTOR: {
    roles: ['vp', 'svp', 'evp', 'director', 'head of'],
    hook: 'team_challenges',
    template: 'EXEC_TEAM_CHALLENGES',
    approach: 'Discuss team scaling/challenges you can help solve, peer-level conversation'
  },
  MANAGER: {
    roles: ['manager', 'senior manager', 'team lead'],
    hook: 'operational_fit',
    template: 'MANAGER_ROLE_FIT',
    approach: 'Peer-level conversation about shared domain, explore how skills align with team needs'
  },
  FUNCTIONAL_LEAD: {
    roles: ['lead', 'owner', 'principal', 'sr engineer', 'specialist'],
    hook: 'technical_insight',
    template: 'IC_PEER_COLLABORATION',
    approach: 'Humble learning conversation, explore collaboration on specific challenges'
  },
  PEOPLE_OPS: {
    roles: ['recruiter', 'talent', 'people operations', 'hr', 'hiring'],
    hook: 'strategic_fit',
    template: 'PEOPLE_OPS_CONVERSATION',
    approach: 'Explore if there\'s a natural role fit, ask about team needs'
  },
  SKIPPED: {
    roles: ['intern', 'no email', 'duplicate'],
    hook: 'none',
    template: 'SKIP',
    approach: 'log_reason'
  }
};

// ─── COMPANY STAGE DEFINITIONS ─────────────────────────────
var COMPANY_STAGES = {
  SEED: { range: [0, 1], label: 'Seed', growth: 'high-risk/high-reward' },
  SERIES_A: { range: [1, 5], label: 'Series A', growth: 'scaling-fast' },
  SERIES_B: { range: [5, 20], label: 'Series B', growth: 'scaling-steady' },
  SERIES_C_PLUS: { range: [20, 1000], label: 'Series C+', growth: 'mature' },
  PROFITABLE: { range: [0, 1000], label: 'Profitable', growth: 'sustainable' },
  PUBLIC: { range: [1000, 999999], label: 'Public', growth: 'enterprise' }
};

// ─── TRIGGER EVENTS (Role-fit signals) ──────────────────────
var TRIGGER_EVENTS = [
  'Series A', 'Series B', 'Series C', 'raised', 'funding',
  'announced', 'launched', 'new product', 'expansion',
  'scaling team', 'opened office', 'new location',
  'acquired', 'partnership', 'hiring for'
];

// ─── FOLLOW-UP CADENCE (2026) ─────────────────────────────
// Anchored to SENT_DATE (NOT draft-creation time). Day offsets below are
// added to the day the initial was actually sent. Sweet spot per Instantly
// 2026 report: 4–7 touches; we ship a conservative 3-touch sequence
// (Day 3 / Day 7 / Day 14) that stays well under Gmail bulk-sender limits
// and still captures the ~42% reply-rate lift from follow-ups.
var FOLLOWUP_CADENCE = {
  offsetDaysByStage: { 1: 3, 2: 7, 3: 14 },
  sendHour: 9,  // 9 AM local (prime window per Instantly/Lavender data)
  frameworkByStage: { 1: 'VALUE_ADD', 2: 'SOCIAL_PROOF', 3: 'BREAK_UP' }
};

// ─── SHARED BACKGROUND KEYWORDS ─────────────────────────────
var SHARED_BACKGROUND = [
  'founder',
  'startup',
  'growth',
  'operations',
  'strategy',
  'gtm',
  'product management',
  'ai',
  'automation',
  'android',
  'mba',
  'operations strategy'
];

// ─── EMAIL TEMPLATE EXAMPLES (reference) ───────────────────
var EMAIL_TEMPLATES = {
  FOUNDER_PERSPECTIVE: {
    subject: 'Idea for [COMPANY]',
    hooks: ['Impressed by', 'Saw your recent', 'Been tracking'],
    ending: 'Would love your perspective.'
  },
  EXEC_TEAM_CHALLENGES: {
    subject: '[FUNCTION] challenges at scale?',
    hooks: ['Noticed you\'re scaling', 'Recently worked with', 'Following your growth'],
    ending: 'Curious about your approach — 15 min?'
  },
  MANAGER_ROLE_FIT: {
    subject: 'Quick question, [NAME]',
    hooks: ['Saw your work on', 'Similar background in', 'Interested in how you\'re'],
    ending: 'Would be great to compare notes.'
  },
  IC_PEER_COLLABORATION: {
    subject: 'Thought on [TOPIC]',
    hooks: ['Fellow [ROLE] here', 'Love what you\'re doing', 'Respect your approach'],
    ending: 'Would love your take.'
  },
  PEOPLE_OPS_CONVERSATION: {
    subject: '[COMPANY] team building?',
    hooks: ['Building strong team', 'Impressed with culture', 'Growth stage feels right'],
    ending: 'Worth a quick conversation?'
  }
};

// ─── LOGGING & DEBUGGING ───────────────────────────────────
var DEBUG = {
  enableLogging: true,              // Set to false to reduce log verbosity
  logApi: true,                      // Log API calls
  logStageTransitions: true,        // Log pipeline stage transitions
  maxLogEntries: 1000               // Keep last N log entries
};

// ─── HELPER FUNCTIONS ───────────────────────────────────────

/**
 * Validates that CONFIG.SHEET_ID is set
 * @returns {boolean}
 */
function isConfigured() {
  return CONFIG.SHEET_ID !== 'YOUR_SHEET_ID_HERE';
}

/**
 * Gets current daily draft count for deliverability tracking
 * @returns {number}
 */
function getDailyDraftCount() {
  var today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  var key = DELIVERABILITY.trackingProperty + today;
  var props = PropertiesService.getScriptProperties();
  return parseInt(props.getProperty(key) || 0);
}

/**
 * Increments daily draft count
 * @returns {number} New count
 */
function incrementDailyDraftCount() {
  var today = new Date().toISOString().split('T')[0];
  var key = DELIVERABILITY.trackingProperty + today;
  var props = PropertiesService.getScriptProperties();
  var currentCount = parseInt(props.getProperty(key) || 0);
  var newCount = currentCount + 1;
  props.setProperty(key, newCount.toString());
  return newCount;
}

/**
 * Checks if daily draft limit has been reached
 * @returns {boolean}
 */
function isDailyDraftLimitReached() {
  return getDailyDraftCount() >= CONFIG.DAILY_DRAFT_LIMIT;
}
