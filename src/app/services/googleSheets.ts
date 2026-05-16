import { google } from 'googleapis';
import { Lead, DailyCounters, AccountCounters, EmailAccount } from '@/types';
import { CONFIG } from '../../config/config';
import { StatusTransitionValidator } from './workflowProcessor';
import { LeadLockService } from './leadLockService';
import fs from 'fs';
import path from 'path';

export class GoogleSheetsService {
  private sheets: any;
  private auth: any;
  private isInitialized: boolean = false;
  private initializationPromise: Promise<void> | null = null;
  private leadLockService: LeadLockService;

  constructor() {
    // Don't initialize in constructor - defer to first use
    this.leadLockService = LeadLockService.getInstance();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    // Prevent multiple simultaneous initialization attempts
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    try {
      this.initializationPromise = this.initializeAuth();
      await this.initializationPromise;
    } catch (error) {
      console.error('❌ Failed to initialize Google Sheets service:', error);
      // Reset initialization promise so it can be retried
      this.initializationPromise = null;
      throw new Error(`Google Sheets initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

    private async initializeAuth(): Promise<void> {
    try {
      // Use environment-based path resolution for cloud deployment compatibility
      const credentialsPath = CONFIG.GOOGLE_CREDENTIALS_PATH.startsWith('/') 
        ? CONFIG.GOOGLE_CREDENTIALS_PATH 
        : path.resolve(process.cwd(), CONFIG.GOOGLE_CREDENTIALS_PATH);

      // Check if credentials file exists
      if (!fs.existsSync(credentialsPath)) {
        throw new Error(`Google credentials file not found at: ${credentialsPath}`);
      }

      const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
      
      this.auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });
      
      this.sheets = google.sheets({ version: 'v4', auth: this.auth });
      this.isInitialized = true;

    } catch (error) {
      console.error('❌ Failed to initialize Google Sheets auth:', error);
      this.isInitialized = false;
      this.initializationPromise = null;
      throw new Error(`Google Sheets authentication failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getLeadsByStatus(status: string): Promise<Lead[]> {
    await this.ensureInitialized();
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: CONFIG.SHEETS.SPREADSHEET_ID,
        range: CONFIG.SHEETS.RANGES.LEADS,
      });

      const rows = response.data.values || [];
      if (rows.length === 0) {
        console.log('No data found in sheets');
        return [];
      }

      const headers = rows[0];
      const dataRows = rows.slice(1);

      return dataRows
        .map((row: any[]) => this.rowToLead(headers, row))
        .filter((lead: Lead | null) => {
          // Filter out invalid leads
          if (!lead) return false;
          
          // Normalize status for comparison (handle manual edits)
          const normalizedStatus = this.normalizeStatus(lead.status);
          const normalizedTargetStatus = this.normalizeStatus(status);
          
          // First check if status matches
          if (normalizedStatus !== normalizedTargetStatus) {
            return false;
          }
          
          // ✅ NEW: Exclude leads that have retryAfter timestamp in the future
          // This prevents processing leads that are waiting for their retry time
          if (lead.retryAfter) {
            const retryTime = new Date(lead.retryAfter);
            const now = new Date();
            
            // If retry time hasn't passed yet, exclude this lead from processing
            if (retryTime > now) {
              console.log(`⏰ Excluding lead ${lead.firstName} ${lead.lastName} from processing - retry scheduled for ${lead.retryAfter}`);
              return false;
            }
          }
          
          return true;
        })
        .filter(Boolean) as Lead[];
    } catch (error) {
      console.error('Error fetching leads by status:', error);
      return [];
    }
  }

  async updateLeadStatus(leadId: string, newStatus: string, additionalData?: any): Promise<void> {
    // 🔒 Use lead-level lock to prevent concurrent updates
    return this.leadLockService.withLeadLock(leadId, async () => {
      await this.ensureInitialized();
      try {
        const leads = await this.getAllLeads();
        const leadIndex = leads.findIndex(lead => lead && lead.id === leadId);
        
        if (leadIndex === -1) {
          console.warn(`Lead with ID ${leadId} not found - may have been manually deleted`);
          return;
        }

        const existingLead = leads[leadIndex];
        if (!existingLead) {
          console.warn(`Lead at index ${leadIndex} is invalid`);
          return;
        }

        const normalizedNewStatus = this.normalizeStatus(newStatus) as Lead['status'];
        
        // 🔥 ADD STATUS TRANSITION VALIDATION
        const transition = StatusTransitionValidator.validateTransition(
          existingLead.status, 
          normalizedNewStatus
        );

        if (!transition.isValid) {
          console.error(`❌ Status transition blocked: ${transition.reason}`);
          console.error(`   Lead: ${existingLead.firstName} ${existingLead.lastName} (${leadId})`);
          throw new Error(`Invalid status transition: ${transition.reason}`);
        }

        // Continue with update if transition is valid
        const updatedLead = {
          ...existingLead,
          status: normalizedNewStatus,
          updatedAt: new Date().toISOString(),
          ...additionalData
        };

        await this.updateLeadRow(leadIndex + 2, updatedLead); // +2 for header and 1-based indexing
        console.log(`✅ Valid status transition: ${existingLead.status} → ${normalizedNewStatus} for ${existingLead.firstName}`);
        
      } catch (error) {
        console.error('Error updating lead status:', error);
        throw error;
      }
    });
  }

  async addLead(lead: Lead): Promise<void> {
    await this.ensureInitialized();
    try {
      // Validate lead before adding
      const validatedLead = this.validateLead(lead);
      if (!validatedLead) {
        console.error('Invalid lead data, skipping:', lead);
        return;
      }

      // Check for duplicates before adding
      const isDuplicate = await this.checkForDuplicate(validatedLead);
      if (isDuplicate) {
        console.log(`⚠️ Duplicate lead detected, skipping: ${validatedLead.firstName} ${validatedLead.lastName} (${validatedLead.email})`);
        return;
      }

      const values = [this.leadToRow(validatedLead)];
      
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: CONFIG.SHEETS.SPREADSHEET_ID,
        range: CONFIG.SHEETS.RANGES.LEADS,
        valueInputOption: 'RAW',
        resource: { values }
      });
      
      console.log(`✅ Added new lead: ${validatedLead.firstName} ${validatedLead.lastName}`);
    } catch (error) {
      console.error('Error adding lead:', error);
      throw error;
    }
  }

  private rowToLead(headers: string[], row: any[]): Lead | null {
  try {
    const lead: any = {};
    
    headers.forEach((header, index) => {
      const value = row[index] || '';
      const cleanHeader = header.trim().toLowerCase();
      
      switch (cleanHeader) {
        case 'likedpostids':
        case 'commentedpostids':
          // Handle both JSON array and comma-separated strings
          try {
            lead[header] = value ? JSON.parse(value) : [];
          } catch {
            // Manual edit as comma-separated string
            lead[header] = value ? value.split(',').map((s: string) => s.trim()).filter(Boolean) : [];
          }
          break;
          
        case 'linkedinprofiledata':
          // Handle JSON data safely
          try {
            lead[header] = value ? JSON.parse(value) : null;
          } catch {
            console.warn(`Invalid JSON in linkedinProfileData for row: ${JSON.stringify(row)}`);
            lead[header] = null;
          }
          break;
          
        case 'stepfailures':
          // Handle step failures JSON data
          try {
            lead[header] = value ? JSON.parse(value) : {};
          } catch {
            console.warn(`Invalid JSON in stepFailures for row: ${JSON.stringify(row)}`);
            lead[header] = {};
          }
          break;
          
        case 'status':
          // Normalize status values
          lead[header] = this.normalizeStatus(value);
          break;
          
        case 'connectioncount':
        case 'followercount':
        case 'failurecount':
        case 'maxretries':
        case 'emailssent':
        case 'emailretrycount':
          // Convert to number
          lead[header] = parseInt(value) || 0;
          break;
          
        case 'emailresponsereceived':
          // Convert to boolean
          lead[header] = value.toLowerCase() === 'true';
          break;
          
        case 'lastemailresponse':
          // Email response type
          lead[header] = String(value).trim();
          break;
          
        default:
          lead[header] = String(value).trim();
      }
    });

    // Validate required fields
    if (!lead.id || !lead.firstName || !lead.lastName) {
      console.warn('Lead missing required fields, skipping:', lead);
      return null;
    }

    return lead as Lead;
  } catch (error) {
    console.warn('Error parsing lead row:', row, error);
    return null;
  }
  }

  //  Validate lead data before operations
  private validateLead(lead: Lead): Lead | null {
    try {
      // Check required fields
      if (!lead.id || !lead.firstName || !lead.lastName) {
        return null;
      }

      // Normalize and validate status
      const normalizedStatus = this.normalizeStatus(lead.status);
      const validStatuses = [
        'new', 'lead_enriched', 'posts_liked', 'posts_commented',
        'invitation_sent', 'connected', 'first_message_sent', 'completed', 'failed'
      ];

      if (!validStatuses.includes(normalizedStatus)) {
        console.warn(`Invalid status ${lead.status}, defaulting to 'new'`);
        lead.status = 'new';
      } else {
        lead.status = normalizedStatus as Lead['status'];
      }

      // Ensure arrays are valid
      lead.likedPostIds = Array.isArray(lead.likedPostIds) ? lead.likedPostIds : [];
      lead.commentedPostIds = Array.isArray(lead.commentedPostIds) ? lead.commentedPostIds : [];

      // Ensure timestamps
      if (!lead.createdAt) {
        lead.createdAt = new Date().toISOString();
      }
      if (!lead.updatedAt) {
        lead.updatedAt = new Date().toISOString();
      }

      return lead;
    } catch (error) {
      console.warn('Lead validation failed:', lead, error);
      return null;
    }
  }

  //  Normalize status values to handle manual edits
  private normalizeStatus(status: string): string {
    if (!status) return 'new';
    
    const statusMap: { [key: string]: string } = {
      // Handle various manual entry formats
      'new': 'new',
      'lead enriched': 'lead_enriched',
      'lead_enriched': 'lead_enriched',
      'leadenriched': 'lead_enriched',
      'posts liked': 'posts_liked',
      'posts_liked': 'posts_liked',
      'postsliked': 'posts_liked',
      'posts commented': 'posts_commented',
      'posts_commented': 'posts_commented',
      'postscommented': 'posts_commented',
      'invitation sent': 'invitation_sent',
      'invitation_sent': 'invitation_sent',
      'invitationsent': 'invitation_sent',
      'connected': 'connected',
      'first message sent': 'first_message_sent',
      'first_message_sent': 'first_message_sent',
      'firstmessagesent': 'first_message_sent',
      'completed': 'completed',
      'failed': 'failed'
    };

    const normalized = status.toLowerCase().trim();
    return statusMap[normalized] || 'new';
  }

  //  Get leads with error handling and data cleaning
  async getAllLeads(): Promise<(Lead | null)[]> {
    await this.ensureInitialized();
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: CONFIG.SHEETS.SPREADSHEET_ID,
        range: CONFIG.SHEETS.RANGES.LEADS,
      });

      const rows = response.data.values || [];
      if (rows.length === 0) return [];

      const headers = rows[0];
      const dataRows = rows.slice(1);

      return dataRows.map((row: any[]) => this.rowToLead(headers, row));
    } catch (error) {
      console.error('Error fetching all leads:', error);
      return [];
    }
  }

  private async updateLeadRow(rowIndex: number, lead: Lead): Promise<void> {
    try {
      const validatedLead = this.validateLead(lead);
      if (!validatedLead) {
        throw new Error(`Cannot update invalid lead data for row ${rowIndex}`);
      }

      const values = [this.leadToRow(validatedLead)];
      
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: CONFIG.SHEETS.SPREADSHEET_ID,
        range: `Leads!A${rowIndex}:AZ${rowIndex}`,  // Updated to include email response tracking fields
        valueInputOption: 'RAW',
        resource: { values }
      });
      
      console.log(`✅ Successfully updated lead row ${rowIndex} for lead ${lead.id}`);
    } catch (error) {
      console.error(`❌ Failed to update lead row ${rowIndex} for lead ${lead.id}:`, error);
      throw new Error(`Lead row update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  private leadToRow(lead: Lead): any[] {
    return [
      // A-I: Basic lead info
      lead.id || '',                             // A
      lead.firstName || '',                      // B
      lead.lastName || '',                       // C
      lead.fullName || `${lead.firstName} ${lead.lastName}`,                       // D
      lead.email || '',                          // E
      lead.phone || '',                          // F
      lead.linkedinUrl || '',                    // G
      lead.status || 'new',                      // H
      lead.apolloId || '',                       // I
      
      // J-S: Enriched data from Apify
      lead.linkedinProfileData ? JSON.stringify(lead.linkedinProfileData) : '',  // J
      lead.linkedinUrn || '',                    // K
      lead.profileHeadline || '',                // L
      lead.jobTitle || '',                       // M
      lead.company || '',                        // N
      lead.companyWebsite || '',                 // O
      lead.companyIndustry || '',                // P
      lead.companySize || '',                    // Q
      lead.connectionCount || '',                // R
      lead.followerCount || '',                  // S
      
      // T-Y: Workflow tracking
      Array.isArray(lead.likedPostIds) ? JSON.stringify(lead.likedPostIds) : '[]',           // T
      Array.isArray(lead.commentedPostIds) ? JSON.stringify(lead.commentedPostIds) : '[]',   // U
      lead.invitationId || '',                   // V
      lead.chatId || '',                         // W
      lead.createdAt || new Date().toISOString(), // X
      lead.updatedAt || new Date().toISOString(), // Y
      
      // Z-AJ: Failure tracking, workflow skip tracking, and multi-account support
      lead.failureCount || 0,                    // Z
      lead.lastFailureStep || '',                // AA
      lead.lastFailureReason || '',              // AB
      lead.lastFailureAt || '',                  // AC
      lead.retryAfter || '',                     // AD
      lead.maxRetries || 3,                      // AE
      lead.stepFailures ? JSON.stringify(lead.stepFailures) : '{}', // AF
      lead.skippedReason || '',                  // AG
      lead.skippedAt || '',                      // AH
      lead.note || '',                           // AI
      lead.linkedinAccountId || '',              // AJ - LinkedIn account assignment
      
      // AK-AY: Email outreach tracking (NEW EMAIL COLUMNS)
      lead.emailStatus || 'not_started',         // AK - Email sequence status
      lead.emailSequenceStartDate || '',         // AL - When email sequence started
      lead.lastEmailSentAt || '',                // AM - Last email timestamp
      lead.nextEmailScheduledFor || '',          // AN - Next email scheduled time
      lead.emailResponseReceived || false,       // AO - Has lead responded to emails
      lead.emailResponseDate || '',              // AP - When response was received
      lead.emailThreadId || '',                  // AQ - Gmail thread ID for responses
      lead.lastEmailResponse || '',              // AR - Type of last response
      lead.assignedSalesPerson || '',            // AS - Sales person handling this lead
      lead.assignedEmailAccount || '',           // AT - Email account assigned to this lead
      lead.emailsSent || 0,                      // AU - Total emails sent
      lead.emailRetryCount || 0,                 // AV - Email retry count
      lead.lastEmailFailureStep || '',           // AW - Which email step failed
      lead.lastEmailFailureReason || '',         // AX - Why email failed
      lead.lastEmailFailureAt || '',             // AY - When email failure occurred
      lead.emailRetryAfter || ''                 // AZ - When to retry email next
    ];
  }
  
  async detectManualChanges(): Promise<void> {
    try {
      console.log('Checking for manual changes in Google Sheets...');
      
      const allLeads = await this.getAllLeads();
      const validLeads = allLeads.filter((lead): lead is Lead => lead !== null);
      const invalidCount = allLeads.length - validLeads.length;

      if (invalidCount > 0) {
        console.warn(`Found ${invalidCount} invalid/corrupted lead entries. These will be skipped.`);
      }

      console.log(`Successfully processed ${validLeads.length} valid leads from sheets`);
    } catch (error) {
      console.error('Error detecting manual changes:', error);
    }
  }

  // Check for duplicate leads based on email, LinkedIn URL, and Apollo ID
  private async checkForDuplicate(newLead: Lead): Promise<boolean> {
    try {
      const allLeads = await this.getAllLeads();
      const validLeads = allLeads.filter((lead): lead is Lead => lead !== null);

      // Check for duplicates using multiple criteria
      const duplicateFound = validLeads.some(existingLead => {
        // Check by Apollo ID (primary identifier)
        if (newLead.apolloId && existingLead.apolloId && 
            newLead.apolloId === existingLead.apolloId) {
          console.log(`🔍 Duplicate found by Apollo ID: ${newLead.apolloId}`);
          return true;
        }
        // Check by LinkedIn URL (secondary identifier)
        if (newLead.linkedinUrl && existingLead.linkedinUrl && 
            newLead.linkedinUrl.toLowerCase().trim() === existingLead.linkedinUrl.toLowerCase().trim()) {
          console.log(`🔍 Duplicate found by LinkedIn URL: ${newLead.linkedinUrl}`);
          return true;
        }
        // Check by full name + company combination (fallback for edge cases)
        if (newLead.firstName && newLead.lastName && existingLead.firstName && existingLead.lastName &&
            newLead.firstName.toLowerCase().trim() === existingLead.firstName.toLowerCase().trim() &&
            newLead.lastName.toLowerCase().trim() === existingLead.lastName.toLowerCase().trim() &&
            newLead.company && existingLead.company &&
            newLead.company.toLowerCase().trim() === existingLead.company.toLowerCase().trim()) {
          console.log(`🔍 Duplicate found by name + company: ${newLead.firstName} ${newLead.lastName} at ${newLead.company}`);
          return true;
        }

        return false;
      });

      return duplicateFound;
    } catch (error) {
      console.error('Error checking for duplicates:', error);
      // In case of error, don't block adding the lead
      return false;
    }
  }

  async getDailyCounters(date: string): Promise<DailyCounters> {
    await this.ensureInitialized();
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: CONFIG.SHEETS.SPREADSHEET_ID,
        range: CONFIG.SHEETS.RANGES.COUNTERS,
      });

      const rows = response.data.values || [];
      const todayCounter = rows.find((row: any[]) => row[0] === date);

      if (todayCounter) {
        return {
          date,
          postsLiked: parseInt(todayCounter[1]) || 0,
          postsCommented: parseInt(todayCounter[2]) || 0,
          invitationsSent: parseInt(todayCounter[3]) || 0,
          messagesSent: parseInt(todayCounter[4]) || 0
        };
      }

      // Create new counter for today
      return {
        date,
        postsLiked: 0,
        postsCommented: 0,
        invitationsSent: 0,
        messagesSent: 0
      };
    } catch (error) {
      console.error('Error getting daily counters:', error);
      return {
        date,
        postsLiked: 0,
        postsCommented: 0,
        invitationsSent: 0,
        messagesSent: 0
      };
    }
  }

  async updateDailyCounters(counters: DailyCounters): Promise<void> {
    await this.ensureInitialized();
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: CONFIG.SHEETS.SPREADSHEET_ID,
        range: CONFIG.SHEETS.RANGES.COUNTERS,
      });

      const rows = response.data.values || [];
      const existingIndex = rows.findIndex((row: any[]) => row[0] === counters.date);

      const values = [[
        counters.date,
        counters.postsLiked,
        counters.postsCommented,
        counters.invitationsSent,
        counters.messagesSent
      ]];

      if (existingIndex >= 0) {
        // Update existing row
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: CONFIG.SHEETS.SPREADSHEET_ID,
          range: `Counters!A${existingIndex + 1}:E${existingIndex + 1}`,
          valueInputOption: 'RAW',
          resource: { values }
        });
      } else {
        // Append new row
        await this.sheets.spreadsheets.values.append({
          spreadsheetId: CONFIG.SHEETS.SPREADSHEET_ID,
          range: CONFIG.SHEETS.RANGES.COUNTERS,
          valueInputOption: 'RAW',
          resource: { values }
        });
      }
    } catch (error) {
      console.error('Error updating daily counters:', error);
      throw error;
    }
  }

  // Account-specific counter methods
  async getAccountCounters(unipileAccountId: string, date: string): Promise<AccountCounters> {
    await this.ensureInitialized();
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: CONFIG.SHEETS.SPREADSHEET_ID,
        range: CONFIG.SHEETS.RANGES.ACCOUNT_COUNTERS,
      });

      const rows = response.data.values || [];
      const accountCounter = rows.find((row: any[]) => row[0] === unipileAccountId && row[1] === date);

      if (accountCounter) {
        return {
          unipileAccountId,
          date,
          postsLiked: parseInt(accountCounter[2]) || 0,
          postsCommented: parseInt(accountCounter[3]) || 0,
          invitationsSent: parseInt(accountCounter[4]) || 0,
          messagesSent: parseInt(accountCounter[5]) || 0
        };
      }

      // Create new counter for this account and date
      return {
        unipileAccountId,
        date,
        postsLiked: 0,
        postsCommented: 0,
        invitationsSent: 0,
        messagesSent: 0
      };
    } catch (error) {
      console.error('Error getting account counters:', error);
      return {
        unipileAccountId,
        date,
        postsLiked: 0,
        postsCommented: 0,
        invitationsSent: 0,
        messagesSent: 0
      };
    }
  }

  async updateAccountCounters(counters: AccountCounters): Promise<void> {
    await this.ensureInitialized();
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: CONFIG.SHEETS.SPREADSHEET_ID,
        range: CONFIG.SHEETS.RANGES.ACCOUNT_COUNTERS,
      });

      const rows = response.data.values || [];
      const existingIndex = rows.findIndex((row: any[]) => row[0] === counters.unipileAccountId && row[1] === counters.date);

      const values = [[
        counters.unipileAccountId,
        counters.date,
        counters.postsLiked,
        counters.postsCommented,
        counters.invitationsSent,
        counters.messagesSent
      ]];

      if (existingIndex >= 0) {
        // Update existing row
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: CONFIG.SHEETS.SPREADSHEET_ID,
          range: `AccountCounters!A${existingIndex + 1}:F${existingIndex + 1}`,
          valueInputOption: 'RAW',
          resource: { values }
        });
      } else {
        // Append new row
        await this.sheets.spreadsheets.values.append({
          spreadsheetId: CONFIG.SHEETS.SPREADSHEET_ID,
          range: CONFIG.SHEETS.RANGES.ACCOUNT_COUNTERS,
          valueInputOption: 'RAW',
          resource: { values }
        });
      }
    } catch (error) {
      console.error('Error updating account counters:', error);
      throw error;
    }
  }


  // EMAIL ACCOUNTS MANAGEMENT
  async getAllEmailAccounts(): Promise<EmailAccount[]> {
    await this.ensureInitialized();
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: CONFIG.SHEETS.SPREADSHEET_ID,
        range: CONFIG.SHEETS.RANGES.EMAIL_ACCOUNTS,
      });

      const rows = response.data.values || [];
      if (rows.length === 0) return [];

      const headers = rows[0];
      const dataRows = rows.slice(1);

      return dataRows
        .map((row: any[]) => this.rowToEmailAccount(headers, row))
        .filter(Boolean) as EmailAccount[];
    } catch (error) {
      console.error('Error fetching email accounts:', error);
      return [];
    }
  }

  async addEmailAccount(emailAccount: EmailAccount): Promise<void> {
    await this.ensureInitialized();
    try {
      const values = [this.emailAccountToRow(emailAccount)];
      
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: CONFIG.SHEETS.SPREADSHEET_ID,
        range: CONFIG.SHEETS.RANGES.EMAIL_ACCOUNTS,
        valueInputOption: 'RAW',
        resource: { values }
      });
      
      console.log(`✅ Added email account: ${emailAccount.emailAddress}`);
    } catch (error) {
      console.error('Error adding email account:', error);
      throw error;
    }
  }

  /**
   * Atomic counter update for email accounts to prevent race conditions
   */
  async atomicCounterUpdate(accountId: string): Promise<void> {
    await this.ensureInitialized();
    let retries = 3;
    
    while (retries > 0) {
      try {
        console.log(`🔄 Atomic counter update attempt for ${accountId} (${retries} retries left)`);
        
        // Get fresh account data
        const accounts = await this.getAllEmailAccounts();
        const index = accounts.findIndex(acc => acc.id === accountId);
        
        if (index === -1) {
          throw new Error(`Email account with ID ${accountId} not found`);
        }

        const currentAccount = accounts[index];
        const now = new Date();
        const lastSentTime = currentAccount.lastEmailSent ? new Date(currentAccount.lastEmailSent) : new Date(0);
        
        // Calculate reset logic based on time
        const shouldResetDaily = now.toDateString() !== lastSentTime.toDateString();
        const shouldResetHourly = now.getHours() !== lastSentTime.getHours() || shouldResetDaily;
        
        // Apply atomic counter updates
        const finalUpdates = {
          sentToday: shouldResetDaily ? 1 : (currentAccount.sentToday + 1),
          sentThisHour: shouldResetHourly ? 1 : (currentAccount.sentThisHour + 1),
          lastEmailSent: now.toISOString()
        };
        
        console.log(`📊 Atomic counter update: ${currentAccount.emailAddress}`);
        console.log(`   Daily: ${currentAccount.sentToday} → ${finalUpdates.sentToday} ${shouldResetDaily ? '(RESET)' : ''}`);
        console.log(`   Hourly: ${currentAccount.sentThisHour} → ${finalUpdates.sentThisHour} ${shouldResetHourly ? '(RESET)' : ''}`);

        const updatedAccount = { ...currentAccount, ...finalUpdates };
        const rowIndex = index + 2; // +2 for header and 1-based indexing
        
        const values = [this.emailAccountToRow(updatedAccount)];
        
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: CONFIG.SHEETS.SPREADSHEET_ID,
          range: `EmailAccounts!A${rowIndex}:R${rowIndex}`,
          valueInputOption: 'RAW',
          resource: { values }
        });
        
        console.log(`✅ Atomic counter update successful for ${currentAccount.emailAddress}`);
        return; // Success - exit retry loop
        
      } catch (error) {
        retries--;
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        if (retries > 0) {
          console.warn(`⚠️ Atomic update failed, retrying... Error: ${errorMessage}`);
          // Wait before retry with exponential backoff
          await new Promise(resolve => setTimeout(resolve, (4 - retries) * 1000));
        } else {
          console.error(`❌ Atomic counter update failed after all retries: ${errorMessage}`);
          throw new Error(`Atomic counter update failed: ${errorMessage}`);
        }
      }
    }
  }

  async updateEmailAccount(accountId: string, updates: Partial<EmailAccount>): Promise<void> {
    await this.ensureInitialized();
    try {
      const accounts = await this.getAllEmailAccounts();
      const index = accounts.findIndex(acc => acc.id === accountId);
      
      if (index === -1) {
        console.warn(`Email account with ID ${accountId} not found`);
        return;
      }

      const updatedAccount = { ...accounts[index], ...updates };
      const rowIndex = index + 2; // +2 for header and 1-based indexing
      
      const values = [this.emailAccountToRow(updatedAccount)];
      
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: CONFIG.SHEETS.SPREADSHEET_ID,
        range: `EmailAccounts!A${rowIndex}:R${rowIndex}`,
        valueInputOption: 'RAW',
        resource: { values }
      });

      console.log(`✅ Updated email account: ${updatedAccount.emailAddress}`);
    } catch (error) {
      console.error('Error updating email account:', error);
      throw error;
    }
  }

  private rowToEmailAccount(headers: string[], row: any[]): EmailAccount | null {
    try {
      const acc: any = {};
      
      headers.forEach((header, index) => {
        const value = row[index] || '';
        const cleanHeader = header.trim().toLowerCase();
        
        switch (cleanHeader) {
          case 'dailylimit':
          case 'hourlylimit':
          case 'senttoday':
          case 'sentthishour':
          case 'failurecount':
            acc[header] = parseInt(value) || 0;
            break;
          case 'isactive':
          case 'warmupphase':
            acc[header] = value.toLowerCase() === 'true';
            break;
          case 'reputation':
          case 'authstatus':
          case 'provider':
          case 'lasthistoryid':
            acc[header] = value;
            break;
          default:
            acc[header] = String(value).trim();
        }
      });

      if (!acc.id || !acc.emailAddress) {
        return null;
      }

      return acc as EmailAccount;
    } catch (error) {
      console.warn('Error parsing email account row:', row, error);
      return null;
    }
  }

  private emailAccountToRow(acc: EmailAccount): any[] {
    return [
      acc.id || '',                                              // A
      acc.emailAddress || '',                                    // B
      acc.displayName || '',                                     // C
      acc.provider || '',                                        // D
      acc.clientId || '',                                        // E
      acc.clientSecret || '',                                    // F
      acc.refreshToken || '',                                    // G
      acc.accessToken || '',                                     // H
      acc.tokenExpiry || '',                                     // I
      acc.dailyLimit || 0,                                       // J
      acc.hourlyLimit || 0,                                      // K
      acc.sentToday || 0,                                        // L
      acc.sentThisHour || 0,                                     // M
      acc.reputation || 'good',                                  // N
      acc.isActive ? 'TRUE' : 'FALSE',                          // O
      acc.warmupPhase ? 'TRUE' : 'FALSE',                       // P
      acc.lastEmailSent || '',                                   // Q
      acc.lastHistoryId || ''                                 // R
    ];
  }


}


