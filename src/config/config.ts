import 'dotenv/config';

export const CONFIG = {
  // Working hours (10 AM to 7 PM on weekdays)
  WORKING_HOURS: {
    START: 0,
    END: 24,
    WEEKDAYS_ONLY: true
  },

  // Random intervals (5-10 minutes)
  SCHEDULER_INTERVAL: {
    MIN: 6 * 60 * 1000, // 6 minutes
    MAX: 11 * 60 * 1000  // 11 minutes
  },

  // Email workflow scheduling intervals (separate from LinkedIn)
  EMAIL_SCHEDULER_INTERVAL: {
    MIN: 5 * 60 * 1000, // 15 minutes
    MAX: 10 * 60 * 1000  // 25 minutes
  },

  // Daily limits for LinkedIn actions
  DAILY_LIMITS: {
    POSTS_LIKED: 20,
    POSTS_COMMENTED: 20,
    INVITATIONS_SENT: 10,
    MESSAGES_SENT: 10
  },

  // Email outreach configuration
  EMAIL: {
    // Default limits for new email accounts (conservative values)
    DEFAULT_DAILY_LIMIT: 50,
    DEFAULT_HOURLY_LIMIT: 6,
    
    // Warmup phase settings for new accounts
    WARMUP: {
      ENABLED: true,
      DURATION_DAYS: 1, // How long to keep accounts in warmup
      DAILY_LIMIT_WARMUP: 1, // Lower limit during warmup
      HOURLY_LIMIT_WARMUP: 2
    },

    // Email sequence timing (in days from start)
    SEQUENCE_DAYS: [1, 2, 4, 6, 8],
    
    // Retry settings for failed emails
    RETRY: {
      MAX_RETRIES: 3,
      RETRY_DELAYS: [30, 60, 180], // Minutes between retries
      FAILURE_THRESHOLD: 5 // Mark account as warning after this many failures
    },

    // Email account health thresholds
    HEALTH: {
      POOR_REPUTATION_THRESHOLD: 10, // Consecutive failures to mark as poor
      WARNING_REPUTATION_THRESHOLD: 5, // Consecutive failures to mark as warning
      TOKEN_REFRESH_BUFFER: 60 // Minutes before expiry to refresh tokens
    },

    // Email template variables
    DEFAULT_VARIABLES: {
      companyName: process.env.COMPANY_NAME || 'Our Company',
      ourCompanyWebsite: process.env.OUR_COMPANY_WEBSITE || 'ourcompany.com',
      supportEmail: process.env.SUPPORT_EMAIL || 'support@ourcompany.com'
    }
  },


    PIPELINE: {
    MIN_LEADS_IN_PIPELINE: 0,    // Fetch new leads if below this
    MAX_LEADS_IN_PIPELINE: 0,    // Stop fetching if above this
    LEADS_TO_FETCH: 5,            // How many to fetch when needed
    SKIP_APOLLO_IF_BUSY: true     // Skip Apollo if processing backlog
  },

    ACTION_DELAYS: {
    LIKE_POST: { MIN: 56, MAX: 167 },
    COMMENT_POST: { MIN: 87, MAX: 298 },
    SEND_INVITATION: { MIN: 137, MAX: 368 },
    SEND_MESSAGE: { MIN: 211, MAX: 536 }
  },

    LEAD_PROCESSING_DELAYS: {
    AFTER_ENRICHMENT: { MIN: 27, MAX: 69 },
    AFTER_LIKING: { MIN: 31, MAX: 94 },
    AFTER_COMMENTING: { MIN: 44, MAX: 127 },
    AFTER_INVITATION: { MIN: 29, MAX: 71 },
    AFTER_MESSAGING: { MIN: 33, MAX: 107 }
  },

    PRIORITY_STEP_DELAYS: {
    AFTER_CONNECTIONS_CHECK: { MIN: 9, MAX: 27 },
    AFTER_MESSAGING: { MIN: 28, MAX: 63 },
    AFTER_INVITATIONS: { MIN: 21, MAX: 75 },
    AFTER_COMMENTING: { MIN: 38, MAX: 99 },
    AFTER_LIKING: { MIN: 20, MAX: 76 },
    AFTER_ENRICHMENT: { MIN: 14, MAX: 48 }
  },

  // Google Sheets configuration
  SHEETS: {
    SPREADSHEET_ID: process.env.GOOGLE_SPREADSHEET_ID || '',
    RANGES: {
      LEADS: 'Leads!A1:AZ',      // ← UPDATED: A to AY columns (51 columns) - added email failure tracking fields
      COUNTERS: 'Counters!A1:E',
      ACCOUNT_COUNTERS: 'AccountCounters!A1:F', // ← NEW: Per-account daily counters
      POSTS: 'Posts!A1:R',        // ← UPDATED: A to R columns (18 columns)
      // Email outreach sheets (simplified)
      EMAIL_ACCOUNTS: 'EmailAccounts!A1:R',  // Email account OAuth2 management
      SCHEDULER_STATUS: 'SchedulerStatus!A1:E', // Scheduler run timestamps and status
    }
  },

  // API Keys
  APOLLO_API_KEY: process.env.APOLLO_API_KEY || '',
  APIFY_API_KEY: process.env.APIFY_API_KEY || '',
  UNIPILE_API_KEY: process.env.UNIPILE_API_KEY || '',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  
  // OAuth2 Configuration
  OAUTH: {
    REDIRECT_URI: process.env.OAUTH_REDIRECT_URI || `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/api/auth/email/callback`,
  },
  
  // Multi-account LinkedIn configuration
  LINKEDIN_ACCOUNTS: JSON.parse(process.env.LINKEDIN_ACCOUNTS || '[]'),
  
  UNIPILE_BASE_URL: process.env.UNIPILE_BASE_URL || '',
  
  // Google credentials path - Cloud deployment compatible
  GOOGLE_CREDENTIALS_PATH: process.env.GOOGLE_CREDENTIALS_PATH || 
                          './googleSheetsKey.json'
};