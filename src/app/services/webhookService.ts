import { GoogleSheetsService } from './googleSheets';
import { getAccountManager } from './accountManager';
import { Lead } from '@/types';

export interface ConnectionAcceptanceEvent {
  unipileAccountId: string;
  acceptedAt: string;
  invitedUser?: string;
  linkedinPublicId?: string;
  profileUrl?: string;
  userProviderId?: string;  // The LinkedIn URN from user_provider_id
}

export class WebhookService {
  private sheetsService: GoogleSheetsService;
  private accountManager = getAccountManager();

  constructor() {
    this.sheetsService = new GoogleSheetsService();
  }

  /**
   * Process connection acceptance event from webhook
   */
  async processConnectionAcceptance(event: ConnectionAcceptanceEvent): Promise<{
    success: boolean;
    leadId?: string;
    leadName?: string;
    linkedinAccountName?: string;
    message?: string;
    error?: string;
  }> {
    try {
      console.log('🔄 Processing connection acceptance event:', {
        userProviderId: event.userProviderId,
        linkedinPublicId: event.linkedinPublicId,
        unipileAccountId: event.unipileAccountId,
        acceptedAt: event.acceptedAt
      });

      // Verify this is a valid unipile account ID
      if (!this.isValidUnipileAccountId(event.unipileAccountId)) {
        const error = `Unknown Unipile account ID: ${event.unipileAccountId}`;
        console.warn(`⚠️ ${error}`);
        return { success: false, error };
      }

      const linkedinAccountName = this.accountManager.getAccountName(event.unipileAccountId);
      console.log(`🎯 Mapped to LinkedIn account: ${linkedinAccountName}`);

      // Find the lead with this user provider ID (LinkedIn URN)
      const lead = await this.findLeadByUserProviderId(event.userProviderId || '');
      
      if (!lead) {
        const error = `No lead found with user provider ID: ${event.userProviderId}`;
        console.warn(`⚠️ ${error}`);
        return { success: false, error };
      }

      console.log(`✅ Found lead: ${lead.firstName} ${lead.lastName} (${lead.id})`);

      // Check if lead is already connected (duplicate webhook)
      if (lead.status === 'connected') {
        console.log(`🔄 Lead ${lead.firstName} ${lead.lastName} is already connected - webhook duplicate detected`);
        return {
          success: true,
          leadId: lead.id,
          leadName: `${lead.firstName} ${lead.lastName}`,
          linkedinAccountName,
          message: `Lead already connected - duplicate webhook ignored`
        };
      }

      // Validate lead status
      if (lead.status !== 'invitation_sent') {
        console.warn(`⚠️ Lead ${lead.firstName} has unexpected status: ${lead.status} (expected: invitation_sent)`);
      }

      // Update lead status to 'connected'
      await this.sheetsService.updateLeadStatus(lead.id, 'connected', {
        connectedAt: event.acceptedAt,
        connectionAcceptedViaWebhook: true,
        webhookProcessedAt: new Date().toISOString(),
        // Clear any retry/failure tracking data since connection was successful
        retryAfter: '',
        failureCount: 0,
        lastFailureStep: '',
        lastFailureReason: '',
        lastFailureAt: ''
      });

      const leadName = `${lead.firstName} ${lead.lastName}`;
      console.log(`🤝 Successfully updated ${leadName} to 'connected' status`);

      return {
        success: true,
        leadId: lead.id,
        leadName,
        linkedinAccountName,
        message: `Connection acceptance processed successfully for ${leadName}`
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('❌ Error processing connection acceptance:', error);
      
      return {
        success: false,
        error: `Processing failed: ${errorMessage}`
      };
    }
  }

  /**
   * Find lead by user provider ID (LinkedIn URN)
   */
  private async findLeadByUserProviderId(userProviderId: string): Promise<Lead | null> {
    try {
      const allLeads = await this.sheetsService.getAllLeads();
      const validLeads = allLeads.filter((lead): lead is Lead => lead !== null);

      // Find the lead with matching LinkedIn URN (user_provider_id)
      const lead = validLeads.find(lead => 
        lead.linkedinUrn === userProviderId
      );
      
      console.log(`🔍 Searching for lead with URN: ${userProviderId}`);
      console.log(`📊 Found ${validLeads.length} total leads to search through`);
      
      if (lead) {
        console.log(`✅ Found matching lead: ${lead.firstName} ${lead.lastName} (${lead.id})`);
      } else {
        console.log(`❌ No lead found with URN: ${userProviderId}`);
      }
      
      return lead || null;
    } catch (error) {
      console.error('❌ Error finding lead by user provider ID:', error);
      throw error;
    }
  }

  /**
   * Check if unipileAccountId is valid (exists in our active accounts)
   */
  private isValidUnipileAccountId(unipileAccountId: string): boolean {
    const activeAccounts = this.accountManager.getActiveAccounts();
    
    return activeAccounts.some(account => 
      account.unipileAccountId === unipileAccountId
    );
  }

  /**
   * Get webhook statistics
   */
  async getWebhookStats(): Promise<{
    totalConnectionsProcessed: number;
    lastProcessedAt?: string;
    recentConnections: Array<{
      leadName: string;
      connectedAt: string;
      linkedinAccount: string;
    }>;
  }> {
    try {
      const allLeads = await this.sheetsService.getAllLeads();
      const validLeads = allLeads.filter((lead): lead is Lead => lead !== null);

      // Find leads that were connected via webhook
      const webhookConnections = validLeads.filter(lead => 
        lead.status === 'connected' && 
        (lead as any).connectionAcceptedViaWebhook === true
      );

      const recentConnections = webhookConnections
        .sort((a, b) => new Date((b as any).connectedAt || b.updatedAt).getTime() - 
                       new Date((a as any).connectedAt || a.updatedAt).getTime())
        .slice(0, 10)
        .map(lead => ({
          leadName: `${lead.firstName} ${lead.lastName}`,
          connectedAt: (lead as any).connectedAt || lead.updatedAt,
          linkedinAccount: this.accountManager.getAccountName(lead.linkedinAccountId || 'unknown')
        }));

      const lastProcessedAt = webhookConnections.length > 0 
        ? Math.max(...webhookConnections.map(lead => 
            new Date((lead as any).webhookProcessedAt || lead.updatedAt).getTime()
          ))
        : undefined;

      return {
        totalConnectionsProcessed: webhookConnections.length,
        lastProcessedAt: lastProcessedAt ? new Date(lastProcessedAt).toISOString() : undefined,
        recentConnections
      };
    } catch (error) {
      console.error('❌ Error getting webhook stats:', error);
      return {
        totalConnectionsProcessed: 0,
        recentConnections: []
      };
    }
  }

  /**
   * Validate webhook payload structure
   */
  static validateWebhookPayload(payload: any): {
    isValid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    if (!payload.event) {
      errors.push('Missing event');
    } else if (payload.event !== 'new_relation') {
      errors.push(`Invalid event: ${payload.event} (expected: new_relation)`);
    }

    if (!payload.account_id) {
      errors.push('Missing account_id');
    }

    if (!payload.user_full_name) {
      errors.push('Missing user_full_name');
    }

    if (!payload.user_public_identifier) {
      errors.push('Missing user_public_identifier');
    }

    if (!payload.account_type || payload.account_type !== 'LINKEDIN') {
      errors.push('Missing or invalid account_type (expected: LINKEDIN)');
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }
}