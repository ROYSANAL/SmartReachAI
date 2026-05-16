// src/types/index.ts
export interface Lead {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;           // ← NEW: From Apollo
  email: string;
  phone?: string;             // Apollo or Apify (Apify takes priority)
  linkedinUrl: string;
  status: LeadStatus;
  apolloId?: string;
  
  // Full JSON backup from Apify
  linkedinProfileData?: any;
  
  // Parsed fields from Apify enrichment
  linkedinUrn : string;           // For Unipile API calls
  profileHeadline?: string;       // LinkedIn headline
  jobTitle?: string;              // Current job title
  company?: string;               // Company name (from Apify, more accurate)
  companyWebsite?: string;        // Company website
  companyIndustry?: string;       // Company industry
  companySize?: string;           // Company size/employee count
  connectionCount?: number;       // LinkedIn connections
  followerCount?: number;         // LinkedIn followers
  
  likedPostIds?: string[];
  commentedPostIds?: string[];
  invitationId?: string;
  chatId?: string;
  createdAt: string;
  updatedAt: string;
  
  // Manual override fields
  manualOverride?: boolean;
  overrideReason?: string;
  
  // Failure tracking fields
  failureCount?: number;           // Total failures across all steps
  lastFailureStep?: LeadStatus;    // Which step failed last time
  lastFailureReason?: string;      // Why it failed
  lastFailureAt?: string;          // When it failed (ISO timestamp)
  retryAfter?: string;             // When to retry next (ISO timestamp)
  maxRetries?: number;             // Maximum retries allowed for this lead
  stepFailures?: {                 // Detailed failure tracking per step
    [key in LeadStatus]?: {
      count: number;
      lastFailure: string;
      lastReason: string;
    }
  };
  
  // Workflow skip tracking fields
  skippedReason?: string;          // Why post interactions were skipped
  skippedAt?: string;              // When post interactions were skipped (ISO timestamp)
  note?: string;                   // General notes about the lead processing
  
  // Multi-account support fields
  linkedinAccountId?: string;      // Which LinkedIn account is assigned to this lead
  
  // Email outreach fields
  emailStatus?: EmailStatus;       // Current email sequence status
  emailSequenceStartDate?: string; // When email sequence started
  lastEmailSentAt?: string;        // Last email timestamp
  nextEmailScheduledFor?: string;  // Next email scheduled time
  emailResponseReceived?: boolean; // Has lead responded to emails
  emailResponseDate?: string;      // When response was received
  emailThreadId?: string;          // Gmail thread ID for responses
  lastEmailResponse?: string;      // Type of last response (interested, not_interested, etc.)
  assignedSalesPerson?: string;    // Sales person handling this lead
  assignedEmailAccount?: string;   // Email account assigned to this lead
  
  // Email analytics
  emailsSent?: number;             // Total emails sent
  emailsOpened?: number;           // Email opens tracked
  emailsClicked?: number;          // Email clicks tracked
  
  // Email retry mechanism (separate from LinkedIn retries)
  emailRetryCount?: number;        // Current retry count for email
  lastEmailFailureStep?: string;   // Which email step failed
  lastEmailFailureReason?: string; // Why email failed
  lastEmailFailureAt?: string;     // When email failure occurred
  emailRetryAfter?: string;        // When to retry email next
}

export interface PipelineStatus {
  counts: {
    new: number;
    lead_enriched: number;
    posts_liked: number;
    posts_commented: number;
    invitation_sent: number;
    connected: number;
  };
  total: number;
  needsNewLeads: boolean;
  processingPriority: string[];
}

export type LeadStatus = 
  | 'new'
  | 'lead_enriched'
  | 'posts_liked'
  | 'posts_commented'
  | 'invitation_sent'
  | 'connected'
  | 'first_message_sent'
  | 'completed'
  | 'failed';

export interface DailyCounters {
  date: string;
  postsLiked: number;
  postsCommented: number;
  invitationsSent: number;
  messagesSent: number;
}

export interface AccountCounters {
  unipileAccountId: string;
  date: string;
  postsLiked: number;
  postsCommented: number;
  invitationsSent: number;
  messagesSent: number;
}

export interface RateLimits {
  postsLiked: { max: number; current: number; resetTime: string };
  postsCommented: { max: number; current: number; resetTime: string };
  invitationsSent: { max: number; current: number; resetTime: string };
  messagesSent: { max: number; current: number; resetTime: string };
}

export interface LinkedInPost {
  id: string;
  content: string;
  author: string;
  timestamp: string;
  relevanceScore?: number;
}

// Email outreach types (simplified)
export type EmailStatus = 
  | 'not_started'
  | 'day_1_sent'
  | 'day_2_sent' 
  | 'day_4_sent'
  | 'day_6_sent'
  | 'day_8_sent'
  | 'response_received'
  | 'sequence_completed'
  | 'failed';

export interface EmailAccount {
  id: string;
  emailAddress: string;
  displayName: string;
  provider: 'gmail' | 'outlook';
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string;
  tokenExpiry: string;
  dailyLimit: number;
  hourlyLimit: number;
  sentToday: number;
  sentThisHour: number;
  reputation: 'good' | 'warning' | 'poor';
  isActive: boolean;
  warmupPhase: boolean;
  lastEmailSent?: string; // ISO timestamp of last email sent
  lastHistoryId?: string; // Gmail history ID for tracking new messages
}