import { Lead, EmailStatus, EmailAccount } from '@/types';
import { GoogleSheetsService } from './googleSheets';
import { getEmailAccountManager } from './emailAccountManager';
import { getTokenRefreshManager, TokenRefreshManager } from './tokenRefreshManager';
import { EmailErrorClassifier } from './emailErrorClassifier';
import { getEmailTemplate, processTemplate, createTemplateVariables } from '@/constants/emailTemplates';
import { FailureManager } from './failureManager';
import { EmailDelayManager } from './emailDelayManager';
import { google } from 'googleapis';
import { CONFIG } from '../../config/config';

interface EmailSendResult {
  success: boolean;
  messageId?: string;
  threadId?: string;
  error?: string;
  errorClassification?: any; // EmailErrorClassification type
}

export class EmailWorkflowProcessor {
  private sheetsService: GoogleSheetsService;
  private emailAccountManager = getEmailAccountManager();
  private failureManager = new FailureManager();
  
  // Email sequence days (Day 1, 2, 4, 6, 8)
  private readonly SEQUENCE_DAYS = [1, 2, 4, 6, 8];
  

  constructor() {
    this.sheetsService = new GoogleSheetsService();
  }

  /**
   * Apply per-account delays to prevent automation detection
   * Each account must wait 8-12 minutes since its last email
   */
  private async applyPerAccountDelay(account: EmailAccount): Promise<void> {
    if (!EmailDelayManager.canSendEmailNow(account)) {
      const waitTime = EmailDelayManager.getTimeUntilCanSend(account);
      const minutes = Math.ceil(waitTime / (60 * 1000));
      
      console.log(`⏰ Account ${account.emailAddress} must wait ${minutes} minutes before next send`);
      console.log('🤖 Applying per-account anti-automation delay...');
      
      await EmailDelayManager.waitUntilCanSend(account);
    }
  }

  /**
   * Main email workflow processor - processes all email sequence steps
   */
  async processEmailWorkflow(): Promise<void> {
    console.log('📧 Starting Email Workflow Processing...');
    
    try {
      // Check and refresh email account tokens
      await this.emailAccountManager.checkAndRefreshTokens();
      
      // Start new email sequences for leads that completed LinkedIn workflow
      await this.startNewEmailSequences();
      
      // Process scheduled follow-up emails
      await this.processScheduledEmails();
      
      // Process email retries
      await this.processEmailRetries();
      
    } catch (error) {
      console.error('❌ Error in email workflow processing:', error);
      throw new Error(`Email workflow processing failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    // Log email retry statistics
    try {
      const allLeads = await this.sheetsService.getAllLeads();
      const emailStats = this.getEmailRetryStats(allLeads.filter(lead => lead !== null) as Lead[]);
      
      if (emailStats.totalEmailFailures > 0) {
        console.log('📊 Email Retry Statistics:');
        console.log(`  💔 Total email failures: ${emailStats.totalEmailFailures}`);
        console.log(`  ❌ Permanently failed emails: ${emailStats.permanentlyFailedEmails}`);
        console.log(`  ⏳ Awaiting email retry: ${emailStats.awaitingEmailRetry}`);
        console.log(`  🔄 Ready for email retry: ${emailStats.readyForEmailRetry}`);
      }
    } catch (error) {
      console.error('❌ Error getting email retry stats:', error);
      // Don't throw here as this is just logging - not critical for workflow
    }
    
    console.log('📧 Email Workflow Processing completed');
  }

  /**
   * Start email sequences for leads that have been enriched (parallel to LinkedIn workflow)
   */
  private async startNewEmailSequences(): Promise<void> {
    console.log('🚀 Starting new email sequences (parallel to LinkedIn workflow)...');
    
    // Get leads that are ready for email sequence - includes leads that completed enrichment
    // and those that have moved through LinkedIn workflow steps
    const emailReadyStatuses = [
      'lead_enriched',    // Fresh leads ready for both LinkedIn and email
      'posts_liked',      // After liking posts
      'posts_commented',  // After commenting on posts  
      'invitation_sent',  // After sending connection request
      'connected',        // After getting connected
      'first_message_sent' // After sending first LinkedIn message
    ];
    
    const allReadyLeads = [];
    
    // Fetch leads from all relevant statuses
    for (const status of emailReadyStatuses) {
      const leadsForStatus = await this.sheetsService.getLeadsByStatus(status);
      allReadyLeads.push(...leadsForStatus);
    }
    
    const readyLeads = allReadyLeads.filter(lead => 
      lead && 
      lead.emailStatus === 'not_started' && 
      lead.assignedEmailAccount && 
      lead.assignedSalesPerson &&
      lead.email &&
      !lead.emailResponseReceived
    );

    console.log(`Found ${readyLeads.length} leads ready to start email sequences`);

    const errors: string[] = [];
    
    for (const lead of readyLeads.slice(0, 10)) { // Process 10 at a time
      try {
        await this.startEmailSequence(lead as Lead);
        
        // Delay between starting sequences
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        const errorMessage = `Failed to start email sequence for lead ${lead?.id}: ${error instanceof Error ? error.message : String(error)}`;
        console.error(`❌ ${errorMessage}`);
        errors.push(errorMessage);
      }
    }
    
    // If all leads failed, throw error
    if (errors.length === readyLeads.length && readyLeads.length > 0) {
      throw new Error(`All email sequence starts failed: ${errors.join('; ')}`);
    }
    
    // If some leads failed, log warning but don't throw
    if (errors.length > 0) {
      console.warn(`⚠️ ${errors.length}/${readyLeads.length} email sequence starts failed`);
    }
  }

  /**
   * Process scheduled follow-up emails
   */
  private async processScheduledEmails(): Promise<void> {
    console.log('⏰ Processing scheduled follow-up emails...');
    
    const now = new Date();
    const allLeads = await this.sheetsService.getAllLeads();
    
    // Find leads with scheduled emails that are due
    const dueLeads = allLeads.filter(lead => {
      if (!lead || !lead.nextEmailScheduledFor) return false;
      
      const scheduledTime = new Date(lead.nextEmailScheduledFor);
      return scheduledTime <= now && 
             lead.emailStatus && 
             !lead.emailResponseReceived &&
             lead.emailStatus !== 'response_received' &&
             lead.emailStatus !== 'sequence_completed' &&
             lead.emailStatus !== 'failed';
    });

    console.log(`Found ${dueLeads.length} leads with emails due`);

    const errors: string[] = [];
    
    for (const lead of dueLeads.slice(0, 10)) { // Process 10 at a time
      try {
        await this.sendNextEmailInSequence(lead as Lead);
        
        // Delay between emails to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 3000));
      } catch (error) {
        const errorMessage = `Failed to send scheduled email for lead ${lead?.id}: ${error instanceof Error ? error.message : String(error)}`;
        console.error(`❌ ${errorMessage}`);
        errors.push(errorMessage);
      }
    }
    
    // If all scheduled emails failed, throw error
    if (errors.length === dueLeads.slice(0, 10).length && dueLeads.length > 0) {
      throw new Error(`All scheduled emails failed: ${errors.join('; ')}`);
    }
    
    // If some emails failed, log warning but don't throw
    if (errors.length > 0) {
      console.warn(`⚠️ ${errors.length}/${Math.min(dueLeads.length, 10)} scheduled emails failed`);
    }
  }

  /**
   * Start email sequence for a lead (send Day 1 email)
   */
  private async startEmailSequence(lead: Lead): Promise<void> {
    console.log(`🚀 Starting email sequence for ${lead.firstName} ${lead.lastName}`);
    
    const result = await this.sendEmailForDay(lead, 1);
    
    if (result.success) {
      // Clear any previous email failure data on success
      const clearFailureData = this.failureManager.clearEmailFailureData(lead);
      
      // Calculate next email date (Day 2 - tomorrow)
      const nextEmailDate = new Date();
      nextEmailDate.setDate(nextEmailDate.getDate() + 1);
      nextEmailDate.setHours(9, 0, 0, 0); // 9 AM
      
      await this.sheetsService.updateLeadStatus(lead.id, lead.status, {
        emailStatus: 'day_1_sent',
        emailSequenceStartDate: new Date().toISOString(),
        lastEmailSentAt: new Date().toISOString(),
        nextEmailScheduledFor: nextEmailDate.toISOString(),
        emailsSent: (lead.emailsSent || 0) + 1,
        emailThreadId: result.threadId || '',
        ...clearFailureData
      });
      
      // Update email account usage
      if (lead.assignedEmailAccount) {
        await this.emailAccountManager.updateAccountUsage(lead.assignedEmailAccount, true);
      }
      
      console.log(`✅ Day 1 email sent to ${lead.firstName} ${lead.lastName}`);
    } else {
      await this.handleEmailFailure(lead, 1, result.error || 'Unknown error', result.errorClassification);
    }
  }

  /**
   * Send the next email in sequence for a lead
   */
  private async sendNextEmailInSequence(lead: Lead): Promise<void> {
    // 🛡️ Safety check: Don't send emails to leads that have already responded
    if (lead.emailResponseReceived || lead.emailStatus === 'response_received') {
      console.log(`🛑 Stopping email sequence - lead ${lead.firstName} ${lead.lastName} has responded`);
      return;
    }

    const currentDay = this.getCurrentSequenceDay(lead.emailStatus);
    const nextDay = this.getNextSequenceDay(currentDay);
    
    if (!nextDay) {
      // Sequence is complete
      await this.sheetsService.updateLeadStatus(lead.id, lead.status, {
        emailStatus: 'sequence_completed',
        nextEmailScheduledFor: ''
      });
      console.log(`✅ Email sequence completed for ${lead.firstName} ${lead.lastName}`);
      return;
    }

    console.log(`📧 Sending Day ${nextDay} email to ${lead.firstName} ${lead.lastName}`);
    
    const result = await this.sendEmailForDay(lead, nextDay);
    
    if (result.success) {
      // Clear any previous email failure data on success
      const clearFailureData = this.failureManager.clearEmailFailureData(lead);
      
      const nextNextDay = this.getNextSequenceDay(nextDay);
      let nextEmailDate = null;
      
      if (nextNextDay) {
        const daysToAdd = nextNextDay - nextDay;
        nextEmailDate = new Date();
        nextEmailDate.setDate(nextEmailDate.getDate() + daysToAdd);
        nextEmailDate.setHours(9, 0, 0, 0);
      }
      
      await this.sheetsService.updateLeadStatus(lead.id, lead.status, {
        emailStatus: this.getEmailStatusForDay(nextDay),
        lastEmailSentAt: new Date().toISOString(),
        nextEmailScheduledFor: nextEmailDate ? nextEmailDate.toISOString() : '',
        emailsSent: (lead.emailsSent || 0) + 1,
        ...clearFailureData
      });
      
      // Update email account usage
      if (lead.assignedEmailAccount) {
        await this.emailAccountManager.updateAccountUsage(lead.assignedEmailAccount, true);
      }
      
      console.log(`✅ Day ${nextDay} email sent to ${lead.firstName} ${lead.lastName}`);
    } else {
      await this.handleEmailFailure(lead, nextDay, result.error || 'Unknown error', result.errorClassification);
    }
  }

  /**
   * Send email for specific day in sequence
   */
  private async sendEmailForDay(lead: Lead, day: number): Promise<EmailSendResult> {
    try {
      // 🛡️ Safety check: Don't send emails to leads that have already responded
      if (lead.emailResponseReceived || lead.emailStatus === 'response_received') {
        console.log(`🛑 Skipping email send - lead ${lead.firstName} ${lead.lastName} has already responded`);
        return { 
          success: false, 
          error: `Lead has already responded - email automation stopped` 
        };
      }

      // Get email template for this day
      const template = getEmailTemplate(day);
      if (!template) {
        return { success: false, error: `No template found for day ${day}` };
      }

      // Get sales person info
      const linkedinAccounts = CONFIG.LINKEDIN_ACCOUNTS;
      const salesPersonInfo = linkedinAccounts.find((acc: any) => acc.name === lead.assignedSalesPerson);
      
      // Create template variables
      const variables = createTemplateVariables(
        lead, 
        lead.assignedSalesPerson || 'Our team',
        salesPersonInfo?.emailAddress || ''
      );

      // Process template
      const subject = processTemplate(template.subject, variables);
      const plainContent = processTemplate(template.content, variables);
      
      // Convert plain text to HTML by replacing newlines with <br> tags
      const htmlContent = plainContent
        .replace(/\n\n/g, '<br><br>') // Double newlines become double breaks
        .replace(/\n/g, '<br>'); // Single newlines become single breaks

      // Get email account
      let emailAccount: EmailAccount | null = null;
      if (lead.assignedEmailAccount) {
        emailAccount = await this.emailAccountManager.getAccountById(lead.assignedEmailAccount);
      }
      
      if (!emailAccount) {
        emailAccount = await this.emailAccountManager.getNextAvailableAccountForSending();
      }

      if (!emailAccount) {
        return { success: false, error: 'No email accounts available for sending' };
      }

      // Apply per-account delays to prevent automation detection
      await this.applyPerAccountDelay(emailAccount);

      // Get fresh account data right before sending to ensure we have latest token info
      const freshEmailAccount = await this.emailAccountManager.getAccountById(emailAccount.id);
      if (!freshEmailAccount) {
        return { success: false, error: 'Email account not found after refresh' };
      }

      // Send email with fresh account data
      const result = await this.sendEmail(freshEmailAccount, lead.email, subject, htmlContent, lead.emailThreadId);
      
      return result;

    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  /**
   * Send email using Gmail API with enhanced error handling and token management
   */
  private async sendEmail(
    emailAccount: EmailAccount, 
    to: string, 
    subject: string, 
    htmlContent: string,
    threadId?: string
  ): Promise<EmailSendResult> {
    try {
      // Handle token refresh with proper locking
      const tokenRefreshManager = getTokenRefreshManager();
      
      // Check if token needs refresh
      if (TokenRefreshManager.needsRefresh(emailAccount.tokenExpiry, 5)) {
        console.log(`🔄 Token refresh needed for ${emailAccount.emailAddress}`);
        
        const refreshResult = await tokenRefreshManager.refreshTokenSafely(
          emailAccount,
          CONFIG.OAUTH.REDIRECT_URI
        );

        if (!refreshResult.success) {
          const error = new Error(`Token refresh failed: ${refreshResult.error}`);
          const classification = EmailErrorClassifier.classifyError(error);
          
          if (EmailErrorClassifier.shouldDeactivateAccount(classification)) {
            console.error(`🚫 Deactivating account ${emailAccount.emailAddress} due to token failure`);
          }
          
          throw error;
        }

        // Update account tokens in both database and cache for consistency
        await this.emailAccountManager.updateAccountTokens(emailAccount.id, {
          accessToken: refreshResult.accessToken!,
          tokenExpiry: refreshResult.tokenExpiry!
        });
        
        // Update local emailAccount object for immediate use
        emailAccount.accessToken = refreshResult.accessToken!;
        emailAccount.tokenExpiry = refreshResult.tokenExpiry!;
      }

      // Create OAuth2 client with current (potentially refreshed) token
      const oauth2Client = new google.auth.OAuth2(
        emailAccount.clientId,
        emailAccount.clientSecret,
        CONFIG.OAUTH.REDIRECT_URI
      );

      oauth2Client.setCredentials({
        access_token: emailAccount.accessToken,
        refresh_token: emailAccount.refreshToken,
        expiry_date: emailAccount.tokenExpiry ? new Date(emailAccount.tokenExpiry).getTime() : undefined
      });

      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      // Create email message
      const rawMessage = this.createRawMessage(
        `${emailAccount.displayName} <${emailAccount.emailAddress}>`,
        to,
        subject,
        htmlContent,
        threadId // This gets used as replyToMessageId for threading
      );

      // Send email
      const response = await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: rawMessage,
          threadId: threadId
        }
      });

      if (!response.data?.id) {
        throw new Error('No message ID returned from Gmail API');
      }

      console.log(`📧 Email sent successfully: ${subject} to ${to}`);

      // Get current Gmail historyId and update email account for webhook tracking
      try {
        const profile = await gmail.users.getProfile({ userId: 'me' });
        const currentHistoryId = profile.data.historyId;
        
        if (currentHistoryId) {
          await this.sheetsService.updateEmailAccount(emailAccount.id, {
            lastHistoryId: currentHistoryId
          });
          console.log(`📊 Updated lastHistoryId to ${currentHistoryId} for ${emailAccount.emailAddress}`);
        }
      } catch (error) {
        console.warn('⚠️ Failed to update lastHistoryId:', error);
        // Don't fail the email send if history update fails
      }

      return {
        success: true,
        messageId: response.data.id,
        threadId: response.data.threadId || undefined
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('❌ Error sending email:', errorMessage);
      
      // Classify error for better handling
      const classification = EmailErrorClassifier.classifyError(error instanceof Error ? error : new Error(errorMessage));
      console.log(`🔍 Error classification: ${EmailErrorClassifier.getErrorSummary(classification)}`);
      
      // Handle immediate actions based on error type
      if (classification.immediateAction) {
        switch (classification.immediateAction) {
          case 'deactivate_account':
            console.warn(`🚫 Deactivating account ${emailAccount.emailAddress} due to critical error`);
            await this.sheetsService.updateEmailAccount(emailAccount.id, { isActive: false });
            break;
          case 'refresh_token':
            console.log(`🔄 Token refresh will be attempted on next send for ${emailAccount.emailAddress}`);
            break;
          case 'review_content_and_account':
            console.warn(`⚠️ Content/account review needed for ${emailAccount.emailAddress}: ${errorMessage}`);
            await this.sheetsService.updateEmailAccount(emailAccount.id, { reputation: 'warning' });
            break;
          case 'mark_email_invalid':
            console.warn(`📧 Invalid email detected, this should be handled at lead level`);
            break;
        }
      }
      
      // Update account failure count only for retryable errors
      // Non-retryable errors shouldn't affect account reputation unfairly
      if (classification.retryable) {
        await this.emailAccountManager.updateAccountUsage(emailAccount.id, false);
      }

      // Include error classification in response for retry logic
      return {
        success: false,
        error: errorMessage,
        errorClassification: classification
      };
    }
  }

  /**
   * Handle email sending failure using FailureManager with error classification
   */
  private async handleEmailFailure(lead: Lead, day: number, errorMessage: string, errorClassification?: any): Promise<void> {
    const failedEmailStep = `day_${day}_email`;
    
    console.error(`❌ Email failed for ${lead.firstName} ${lead.lastName} (Day ${day}): ${errorMessage}`);
    
    const { shouldRetry, additionalData } = this.failureManager.handleEmailFailure(
      lead,
      failedEmailStep,
      errorMessage,
      errorClassification // Pass the error classification for intelligent retry decisions
    );
    
    await this.sheetsService.updateLeadStatus(lead.id, lead.status, additionalData);
    
    // Update email account failure count only for retryable errors
    // Non-retryable errors shouldn't penalize the account unfairly
    if (lead.assignedEmailAccount && (!errorClassification || errorClassification.retryable)) {
      await this.emailAccountManager.updateAccountUsage(lead.assignedEmailAccount, false);
    }
    
    if (!shouldRetry) {
      console.error(`❌ Email permanently failed for ${lead.firstName} ${lead.lastName} at Day ${day}`);
    }
  }

  /**
   * Create raw email message for Gmail API
   */
  private createRawMessage(
    from: string,
    to: string,
    subject: string,
    htmlContent: string,
    threadId?: string
  ): string {
    const boundary = `boundary_${Math.random().toString(36).substring(2, 11)}`;
    
    const message = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`, // Subject is ALWAYS included
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`
    ];

    // Add threading headers for follow-up emails when threadId is provided
    // Note: We don't need In-Reply-To for Gmail threading - threadId in the API call handles it
    // But we can add a Message-ID for better email client compatibility
    if (threadId) {
      const messageId = `${Math.random().toString(36).substring(2, 11)}@gmail.com`;
      message.push(`Message-ID: <${messageId}>`);
    }

    message.push('', `--${boundary}`);

    // Add plain text version
    const textContent = htmlContent.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ');
    message.push(
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 7bit',
      '',
      textContent,
      '',
      `--${boundary}`
    );

    // Add HTML version
    message.push(
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: 7bit',
      '',
      htmlContent,
      '',
      `--${boundary}--`
    );

    return Buffer.from(message.join('\r\n')).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /**
   * Process email retries - handle leads that failed but are ready for retry
   */
  private async processEmailRetries(): Promise<void> {
    console.log('🔄 Processing email retries...');
    
    const allLeads = await this.sheetsService.getAllLeads();
    const leadsWithEmailFailures = allLeads.filter(lead => 
      lead && 
      lead.emailRetryCount && 
      lead.emailRetryCount > 0 && 
      lead.nextEmailScheduledFor &&
      new Date(lead.nextEmailScheduledFor) <= new Date() &&
      lead.emailStatus !== 'failed' &&
      lead.emailStatus !== 'response_received' &&
      lead.emailStatus !== 'sequence_completed' &&
      !lead.emailResponseReceived
    );

    console.log(`Found ${leadsWithEmailFailures.length} leads ready for email retry`);

    for (const lead of leadsWithEmailFailures.slice(0, 5)) { // Process 5 at a time
      if (!lead) continue; // Additional safety check
      
      try {
        // Determine which day to retry based on current email status
        const dayToRetry = this.getCurrentSequenceDay(lead.emailStatus as EmailStatus);
        if (dayToRetry > 0) {
          console.log(`🔄 Retrying Day ${dayToRetry} email for ${lead.firstName} ${lead.lastName}`);
          
          if (dayToRetry === 1) {
            await this.startEmailSequence(lead as Lead);
          } else {
            await this.sendNextEmailInSequence(lead as Lead);
          }
          
          // Delay between retry attempts
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      } catch (error) {
        const errorMessage = `Failed to retry email for lead ${lead?.id}: ${error instanceof Error ? error.message : String(error)}`;
        console.error(`❌ ${errorMessage}`);
        // Store this error to potentially throw later if too many retries fail
        throw new Error(errorMessage);
      }
    }
  }

  /**
   * Get email retry statistics for monitoring
   */
  getEmailRetryStats(allLeads: Lead[]): {
    totalEmailFailures: number;
    permanentlyFailedEmails: number;
    awaitingEmailRetry: number;
    readyForEmailRetry: number;
  } {
    const stats = {
      totalEmailFailures: 0,
      permanentlyFailedEmails: 0,
      awaitingEmailRetry: 0,
      readyForEmailRetry: 0,
    };

    const now = new Date();

    for (const lead of allLeads) {
      if (lead && lead.emailRetryCount && lead.emailRetryCount > 0) {
        stats.totalEmailFailures++;

        if (lead.emailStatus === 'failed') {
          stats.permanentlyFailedEmails++;
        } else if (lead.nextEmailScheduledFor) {
          stats.awaitingEmailRetry++;
          
          if (new Date(lead.nextEmailScheduledFor) <= now) {
            stats.readyForEmailRetry++;
          }
        }
      }
    }

    return stats;
  }
  /**
   * Utility methods
   */
  private getCurrentSequenceDay(emailStatus?: EmailStatus): number {
    switch (emailStatus) {
      case 'day_1_sent': return 1;
      case 'day_2_sent': return 2;
      case 'day_4_sent': return 4;
      case 'day_6_sent': return 6;
      case 'day_8_sent': return 8;
      default: return 0;
    }
  }

  private getNextSequenceDay(currentDay: number): number | null {
    const currentIndex = this.SEQUENCE_DAYS.indexOf(currentDay);
    return currentIndex >= 0 && currentIndex < this.SEQUENCE_DAYS.length - 1 
      ? this.SEQUENCE_DAYS[currentIndex + 1] 
      : null;
  }

  private getEmailStatusForDay(day: number): EmailStatus {
    switch (day) {
      case 1: return 'day_1_sent';
      case 2: return 'day_2_sent';
      case 4: return 'day_4_sent';
      case 6: return 'day_6_sent';
      case 8: return 'day_8_sent';
      default: return 'not_started';
    }
  }
}