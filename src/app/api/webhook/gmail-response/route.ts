import { NextRequest, NextResponse } from 'next/server';
import { google } from 'googleapis';
import { GoogleSheetsService } from '@/app/services/googleSheets';
import { EmailResponseMatcher } from '@/app/services/emailResponseMatcher';
import { EmailAccount } from '@/types';

// Gmail Pub/Sub webhook payload interface
interface GmailPubSubPayload {
  message: {
    data: string; // Base64 encoded JSON
    messageId: string;
    publishTime: string;
  };
  subscription: string;
}

// Gmail push notification data structure
interface GmailPushData {
  emailAddress: string;
  historyId: string;
}

// Email response processing service
class EmailResponseService {
  private sheetsService: GoogleSheetsService;
  private emailMatcher: EmailResponseMatcher;
  private gmail: any;

  constructor() {
    this.sheetsService = new GoogleSheetsService();
    this.emailMatcher = new EmailResponseMatcher();
  }

  private async initializeGmailClient(emailAccount: EmailAccount) {
    const oauth2Client = new google.auth.OAuth2(
      emailAccount.clientId,
      emailAccount.clientSecret,
      process.env.OAUTH_REDIRECT_URI
    );

    oauth2Client.setCredentials({
      access_token: emailAccount.accessToken,
      refresh_token: emailAccount.refreshToken,
    });

    // Refresh token if expired
    const tokenInfo = await oauth2Client.getAccessToken();
    if (tokenInfo.token && tokenInfo.token !== emailAccount.accessToken) {
      await this.sheetsService.updateEmailAccount(emailAccount.id, {
        accessToken: tokenInfo.token,
        tokenExpiry: new Date(Date.now() + 3600000).toISOString() // 1 hour from now
      });
    }

    this.gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  }

  async processEmailResponse(emailAddress: string, historyId: string): Promise<{
    success: boolean;
    message: string;
    leadId?: string;
    responseType?: string;
  }> {
    try {
      console.log(`📧 Processing email response for ${emailAddress}, historyId: ${historyId}`);

      // Get email account from database
      const emailAccounts = await this.sheetsService.getAllEmailAccounts();
      const emailAccount = emailAccounts.find(acc => acc.emailAddress === emailAddress);
      
      if (!emailAccount) {
        return {
          success: false,
          message: `Email account ${emailAddress} not found in database`
        };
      }

      // Initialize Gmail client for this account
      await this.initializeGmailClient(emailAccount);

      // Get history since last known historyId stored in the account
      const storedHistoryId = emailAccount.lastHistoryId || historyId;
      console.log(`🔍 Fetching history since stored ID: ${storedHistoryId}, current ID: ${historyId}`);
      
      const historyResponse = await this.gmail.users.history.list({
        userId: 'me',
        startHistoryId: storedHistoryId,
        historyTypes: ['messageAdded']
      });

      if (!historyResponse.data.history) {
        console.log('No new messages found in history');
        console.log('🔍 Debug info:');
        console.log('   Stored history ID:', storedHistoryId);
        console.log('   Current history ID:', historyId);
        console.log('   Response:', JSON.stringify(historyResponse.data, null, 2));
        return { success: true, message: 'No new messages to process' };
      }

      // Process each new message
      console.log(`✅ Found ${historyResponse.data.history.length} history items`);
      for (const historyItem of historyResponse.data.history) {
        if (historyItem.messagesAdded) {
          console.log(`📧 Processing ${historyItem.messagesAdded.length} new messages`);
          for (const messageAdded of historyItem.messagesAdded) {
            const messageId = messageAdded.message?.id;
            if (!messageId) continue;

            try {
              // Get full message details with retry logic for race condition
              const message = await this.getMessageWithRetry(messageId);
              
              // Pre-filter: Only process messages that are likely incoming (have INBOX label)
              const messageLabels = message.labelIds || [];
              const isInboxMessage = messageLabels.includes('INBOX');
              const isSentMessage = messageLabels.includes('SENT') || messageLabels.includes('DRAFT');
              
              if (isSentMessage && !isInboxMessage) {
                console.log(`📤 SKIPPING message ${messageId}: Has SENT/DRAFT label, no INBOX label - outgoing email`);
                continue;
              }
              
              await this.processIncomingMessage(message, emailAccount);
              
            } catch (error) {
              console.error(`❌ Failed to process message ${messageId} after retries:`, error);
              console.log(`⏭️ Continuing with next message...`);
              // Continue processing other messages instead of failing the entire webhook
              continue;
            }
          }
        }
      }

      // Update stored history ID to prevent reprocessing same messages
      await this.sheetsService.updateEmailAccount(emailAccount.id, {
        lastHistoryId: historyId
      });

      return {
        success: true,
        message: 'Email responses processed successfully'
      };

    } catch (error) {
      console.error('❌ Error processing email response:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private async processIncomingMessage(message: any, emailAccount: EmailAccount) {
    try {
      const headers = message.payload?.headers || [];
      const fromHeader = headers.find((h: any) => h.name.toLowerCase() === 'from');
      const subjectHeader = headers.find((h: any) => h.name.toLowerCase() === 'subject');
      const inReplyToHeader = headers.find((h: any) => h.name.toLowerCase() === 'in-reply-to');
      const referencesHeader = headers.find((h: any) => h.name.toLowerCase() === 'references');
      
      const threadId = message.threadId;

      if (!fromHeader) return;

      const fromEmail = this.extractEmailFromHeader(fromHeader.value);
      const subject = subjectHeader?.value || '';
      const receivedAt = new Date().toISOString();

      console.log(`📨 Processing message:`);
      console.log(`   From: ${fromEmail}`);
      console.log(`   Subject: ${subject}`);
      console.log(`   Thread ID: ${threadId}`);
      console.log(`   Message ID: ${message.id}`);

      // CRITICAL FIX: Check if this is an outgoing email (sent BY our account) vs incoming (sent TO our account)
      const isOutgoingEmail = this.normalizeEmail(fromEmail) === this.normalizeEmail(emailAccount.emailAddress);
      
      if (isOutgoingEmail) {
        console.log(`📤 SKIPPING: This is an outgoing email sent BY our account (${emailAccount.emailAddress}), not an incoming response`);
        return;
      }

      // Additional verification: Check message labels for SENT vs INBOX
      const messageLabels = message.labelIds || [];
      const isSentMessage = messageLabels.includes('SENT') || messageLabels.includes('DRAFT');
      
      if (isSentMessage) {
        console.log(`📤 SKIPPING: Message has SENT/DRAFT label, confirming it's an outgoing email`);
        return;
      }

      console.log(`📥 CONFIRMED: This is an incoming message from external sender ${fromEmail}`);

      // Create email response context for enhanced matching
      const responseContext = {
        fromEmail,
        subject,
        threadId,
        messageId: message.id,
        inReplyTo: inReplyToHeader?.value,
        references: referencesHeader?.value ? referencesHeader.value.split(/\s+/) : [],
        receivedAt
      };

      // Use enhanced matching to find the lead
      const matchResult = await this.emailMatcher.findMatchingLead(emailAccount, responseContext);
      
      // Log the match result for monitoring
      this.emailMatcher.logMatchResult(responseContext, matchResult);

      if (!matchResult.lead) {
        console.log(`⚠️ No matching lead found for ${fromEmail} with account ${emailAccount.emailAddress}`);
        console.log(`🔍 Match attempt details: ${matchResult.reason || 'No specific reason provided'}`);
        return;
      }

      const matchingLead = matchResult.lead;

      // Get email response content
      const responseBody = this.getMessageBody(message);
      const responseType = this.classifyEmailResponse(subject, responseBody);

      // Update lead EMAIL status to response_received (not the main LinkedIn status)
      await this.sheetsService.updateLeadStatus(matchingLead.id, matchingLead.status, {
        emailStatus: 'response_received',
        emailResponseReceived: true,
        emailResponseDate: receivedAt,
        emailThreadId: threadId,
        lastEmailResponse: responseBody.substring(0, 500), // Store actual response text, not classification
        // Store enhanced response data in note field including match confidence
        note: `EMAIL RESPONSE [${responseType}] - Match: ${matchResult.confidence} confidence via ${matchResult.matchMethod}${matchResult.reason ? ` (${matchResult.reason})` : ''}: ${responseBody.substring(0, 400)}`
      });

      // Log the response activity
      await this.logEmailResponse(matchingLead, emailAccount, {
        fromEmail,
        subject,
        responseType,
        threadId,
        receivedAt,
        messageId: message.id
      });

      console.log(`✅ Processed response from ${matchingLead.firstName} ${matchingLead.lastName} (${responseType})`);

    } catch (error) {
      console.error('❌ Error processing incoming message:', error);
    }
  }

  private extractEmailFromHeader(fromValue: string): string {
    // Extract email from "Name <email@domain.com>" format
    const emailMatch = fromValue.match(/<([^>]+)>/);
    return emailMatch ? emailMatch[1] : fromValue.trim();
  }

  private normalizeEmail(email: string): string {
    return email.toLowerCase().trim();
  }

  /**
   * Get message with retry logic to handle Gmail API race conditions
   * Messages may appear in history before being available via messages.get()
   */
  private async getMessageWithRetry(messageId: string, maxRetries: number = 5): Promise<any> {
    const baseDelay = 1000; // Start with 1 second
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔄 Fetching message ${messageId} (attempt ${attempt}/${maxRetries})`);
        
        const messageResponse = await this.gmail.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'full'
        });
        
        console.log(`✅ Successfully fetched message ${messageId} on attempt ${attempt}`);
        return messageResponse.data;
        
      } catch (error: any) {
        const isNotFound = error?.status === 404 || error?.code === 404;
        
        if (!isNotFound) {
          // Non-404 error, don't retry
          console.error(`❌ Non-404 error fetching message ${messageId}:`, error.message);
          throw error;
        }
        
        if (attempt === maxRetries) {
          // Final attempt failed
          console.error(`❌ Message ${messageId} not found after ${maxRetries} attempts. Skipping.`);
          throw new Error(`Message ${messageId} not available after ${maxRetries} retry attempts`);
        }
        
        // Calculate exponential backoff delay
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.log(`⏳ Message ${messageId} not ready yet, retrying in ${delay}ms... (attempt ${attempt}/${maxRetries})`);
        
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    throw new Error(`Message ${messageId} fetch failed after all retries`);
  }

  private getMessageBody(message: any): string {
    let body = '';
    
    if (message.payload?.parts) {
      // Multipart message
      for (const part of message.payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          body += Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
      }
    } else if (message.payload?.body?.data) {
      // Simple message
      body = Buffer.from(message.payload.body.data, 'base64').toString('utf-8');
    }
    
    return body.toLowerCase();
  }

  private classifyEmailResponse(subject: string, body: string): string {
    const subjectLower = subject.toLowerCase();
    const bodyLower = body.toLowerCase();
    
    // Positive responses
    if (bodyLower.includes('interested') || bodyLower.includes('yes') || 
        bodyLower.includes('tell me more') || bodyLower.includes('share') ||
        bodyLower.includes('demo') || bodyLower.includes('call') ||
        bodyLower.includes('meeting') || bodyLower.includes('discuss')) {
      return 'interested';
    }
    
    // Negative responses
    if (bodyLower.includes('not interested') || bodyLower.includes('no thank') ||
        bodyLower.includes('unsubscribe') || bodyLower.includes('stop') ||
        bodyLower.includes('remove me')) {
      return 'not_interested';
    }
    
    // Out of office
    if (subjectLower.includes('out of office') || subjectLower.includes('automatic reply') ||
        bodyLower.includes('out of office') || bodyLower.includes('vacation') ||
        bodyLower.includes('away from office')) {
      return 'out_of_office';
    }
    
    // Request for more info
    if (bodyLower.includes('more information') || bodyLower.includes('details') ||
        bodyLower.includes('explain') || bodyLower.includes('how does')) {
      return 'requesting_info';
    }
    
    return 'general_response';
  }

  private async logEmailResponse(lead: any, emailAccount: EmailAccount, responseData: {
    fromEmail: string;
    subject: string;
    responseType: string;
    threadId: string;
    receivedAt: string;
    messageId: string;
  }) {
    try {
      // Log to a dedicated email responses sheet or add to existing activity log
      const logEntry = {
        timestamp: responseData.receivedAt,
        leadId: lead.id,
        leadName: `${lead.firstName} ${lead.lastName}`,
        leadEmail: lead.email,
        leadCompany: lead.company,
        emailAccount: emailAccount.emailAddress,
        eventType: 'email_response_received',
        responseType: responseData.responseType,
        subject: responseData.subject,
        threadId: responseData.threadId,
        messageId: responseData.messageId,
        emailSequenceStep: lead.emailStatus || 'unknown'
      };

      console.log(`📝 Email response logged:`, logEntry);
      
      // TODO: Add to Google Sheets activity log if you have one
      // For now, just console log the structured data
      
    } catch (error) {
      console.error('❌ Error logging email response:', error);
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    console.log('📧 Gmail webhook received');
    
    // Parse Gmail Pub/Sub payload
    const payload = await request.json() as GmailPubSubPayload;
    
    if (!payload.message?.data) {
      return NextResponse.json({ error: 'Invalid payload - missing message data' }, { status: 400 });
    }

    // Decode base64 message data
    const decodedData = Buffer.from(payload.message.data, 'base64').toString('utf-8');
    console.log('📨 Decoded message data:', decodedData);
    
    // Handle test messages vs real Gmail notifications
    let messageData: GmailPushData;
    try {
      messageData = JSON.parse(decodedData) as GmailPushData;
    } catch {
      // This might be a test message or invalid format
      console.log('⚠️ Message data is not valid JSON, treating as test message');
      console.log('📄 Raw decoded data:', decodedData);
      
      return NextResponse.json({
        success: true,
        message: 'Test message received successfully',
        data: {
          decodedMessage: decodedData,
          processedAt: new Date().toISOString()
        }
      });
    }

    console.log('📨 Gmail push notification:', {
      emailAddress: messageData.emailAddress,
      historyId: messageData.historyId,
      messageId: payload.message.messageId,
      publishTime: payload.message.publishTime
    });

    // Process the email response
    const responseService = new EmailResponseService();
    const result = await responseService.processEmailResponse(
      messageData.emailAddress,
      messageData.historyId
    );

    if (result.success) {
      return NextResponse.json({
        success: true,
        message: result.message,
        data: {
          emailAddress: messageData.emailAddress,
          processedAt: new Date().toISOString(),
          leadId: result.leadId,
          responseType: result.responseType
        }
      });
    } else {
      console.warn(`⚠️ Gmail webhook processing failed: ${result.message}`);
      return NextResponse.json({ 
        error: result.message,
        emailAddress: messageData.emailAddress
      }, { status: 400 });
    }

  } catch (error) {
    console.error('❌ Error processing Gmail webhook:', error);
    
    return NextResponse.json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}

// Handle GET for webhook verification (Gmail may send verification requests)
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const challenge = searchParams.get('hub.challenge');
  
  if (challenge) {
    console.log('📧 Gmail webhook verification received');
    return new NextResponse(challenge, { status: 200 });
  }
  
  return NextResponse.json({ status: 'Gmail webhook endpoint active' });
}

// Handle OPTIONS request for CORS
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}