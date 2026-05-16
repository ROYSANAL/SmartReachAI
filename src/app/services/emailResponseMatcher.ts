import { Lead, EmailAccount } from '@/types';
import { GoogleSheetsService } from './googleSheets';

export interface EmailMatchResult {
  lead: Lead | null;
  confidence: 'high' | 'medium' | 'low';
  matchMethod: string;
  reason?: string;
}

export interface EmailResponseContext {
  fromEmail: string;
  subject: string;
  threadId: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  receivedAt: string;
}

export class EmailResponseMatcher {
  private sheetsService: GoogleSheetsService;

  constructor() {
    this.sheetsService = new GoogleSheetsService();
  }

  /**
   * Enhanced lead matching with multiple fallback strategies
   */
  async findMatchingLead(
    emailAccount: EmailAccount,
    context: EmailResponseContext
  ): Promise<EmailMatchResult> {
    const leads = await this.sheetsService.getAllLeads();
    const activeLeads = leads.filter((lead): lead is NonNullable<typeof lead> => 
      lead !== null && 
      lead.assignedEmailAccount === emailAccount.id &&
      lead.emailStatus !== 'response_received' // Don't process multiple responses
    );

    console.log(`🔍 Searching for matching lead among ${activeLeads.length} active leads for account ${emailAccount.emailAddress}`);

    // Strategy 1: Exact thread ID match (highest confidence)
    if (context.threadId) {
      const threadMatch = activeLeads.find(lead => lead.emailThreadId === context.threadId);
      if (threadMatch) {
        console.log(`✅ Thread ID match found for ${context.fromEmail} (thread: ${context.threadId})`);
        return {
          lead: threadMatch,
          confidence: 'high',
          matchMethod: 'thread_id_exact'
        };
      }
    }

    // Strategy 2: Exact email match with recent email activity
    const exactEmailMatches = activeLeads.filter(lead => 
      this.normalizeEmail(lead.email) === this.normalizeEmail(context.fromEmail)
    );

    if (exactEmailMatches.length === 1) {
      const lead = exactEmailMatches[0];
      
      // Check if email was sent recently (within last 30 days)
      const recentEmailActivity = this.hasRecentEmailActivity(lead);
      if (recentEmailActivity) {
        console.log(`✅ Exact email match with recent activity: ${context.fromEmail}`);
        return {
          lead,
          confidence: 'high',
          matchMethod: 'email_exact_recent'
        };
      } else {
        console.log(`⚠️ Exact email match but no recent activity: ${context.fromEmail}`);
        return {
          lead,
          confidence: 'medium',
          matchMethod: 'email_exact_old',
          reason: 'No recent email activity - may be delayed response'
        };
      }
    }

    if (exactEmailMatches.length > 1) {
      console.warn(`⚠️ Multiple leads found for email ${context.fromEmail}, trying additional criteria`);
      
      // Try to narrow down by most recent email activity
      const sortedByActivity = exactEmailMatches.sort((a, b) => {
        const aTime = a.lastEmailSentAt ? new Date(a.lastEmailSentAt).getTime() : 0;
        const bTime = b.lastEmailSentAt ? new Date(b.lastEmailSentAt).getTime() : 0;
        return bTime - aTime; // Most recent first
      });

      return {
        lead: sortedByActivity[0],
        confidence: 'medium',
        matchMethod: 'email_exact_multiple_recent',
        reason: `Multiple matches found, selected most recent activity (${exactEmailMatches.length} total)`
      };
    }

    // Strategy 3: Fuzzy email matching (handle email aliases, +suffixes, etc.)
    const fuzzyMatches = activeLeads.filter(lead => 
      this.isFuzzyEmailMatch(lead.email, context.fromEmail)
    );

    if (fuzzyMatches.length === 1) {
      console.log(`🔍 Fuzzy email match found: ${context.fromEmail} ≈ ${fuzzyMatches[0].email}`);
      return {
        lead: fuzzyMatches[0],
        confidence: 'medium',
        matchMethod: 'email_fuzzy',
        reason: `Fuzzy match between ${context.fromEmail} and ${fuzzyMatches[0].email}`
      };
    }

    // Strategy 4: Subject line analysis for forwarded emails
    const subjectMatches = this.findLeadsBySubjectAnalysis(activeLeads, context.subject);
    if (subjectMatches.length > 0) {
      console.log(`🔍 Subject line analysis match found for: ${context.subject}`);
      return {
        lead: subjectMatches[0],
        confidence: 'low',
        matchMethod: 'subject_analysis',
        reason: 'Matched based on subject line analysis - may be forwarded email'
      };
    }

    // Strategy 5: Check for domain matches (same company, different person)
    const domainMatches = this.findLeadsByDomain(activeLeads, context.fromEmail);
    if (domainMatches.length > 0) {
      console.log(`🔍 Domain match found for: ${context.fromEmail}`);
      return {
        lead: domainMatches[0],
        confidence: 'low',
        matchMethod: 'domain_match',
        reason: 'Same domain as existing lead - may be colleague response'
      };
    }

    console.log(`❌ No matching lead found for ${context.fromEmail} from account ${emailAccount.emailAddress}`);
    return {
      lead: null,
      confidence: 'low',
      matchMethod: 'no_match',
      reason: 'No matching lead found with any strategy'
    };
  }

  /**
   * Normalize email address for comparison
   */
  private normalizeEmail(email: string): string {
    return email.toLowerCase().trim();
  }

  /**
   * Check if lead has recent email activity (within 30 days)
   */
  private hasRecentEmailActivity(lead: Lead): boolean {
    if (!lead.lastEmailSentAt && !lead.emailSequenceStartDate) {
      return false;
    }

    const lastActivity = lead.lastEmailSentAt || lead.emailSequenceStartDate;
    if (!lastActivity) return false;

    const activityDate = new Date(lastActivity);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    
    return activityDate >= thirtyDaysAgo;
  }

  /**
   * Fuzzy email matching to handle aliases and variations
   */
  private isFuzzyEmailMatch(leadEmail: string, responseEmail: string): boolean {
    const leadNorm = this.normalizeEmail(leadEmail);
    const responseNorm = this.normalizeEmail(responseEmail);
    
    if (leadNorm === responseNorm) return true;

    // Extract parts
    const leadParts = leadNorm.split('@');
    const responseParts = responseNorm.split('@');
    
    if (leadParts.length !== 2 || responseParts.length !== 2) return false;

    const [leadLocal, leadDomain] = leadParts;
    const [responseLocal, responseDomain] = responseParts;

    // Same domain required
    if (leadDomain !== responseDomain) return false;

    // Check for common variations
    // Remove dots (gmail ignores dots in local part)
    if (leadLocal.replace(/\./g, '') === responseLocal.replace(/\./g, '')) return true;

    // Remove + suffixes (gmail alias feature)
    const leadClean = leadLocal.split('+')[0];
    const responseClean = responseLocal.split('+')[0];
    if (leadClean === responseClean) return true;

    // Check if one is a substring of the other (handle middle names, initials)
    if (leadClean.includes(responseClean) || responseClean.includes(leadClean)) {
      const lengthDiff = Math.abs(leadClean.length - responseClean.length);
      // Only match if difference is small (likely initials/middle names)
      return lengthDiff <= 3;
    }

    return false;
  }

  /**
   * Find leads by analyzing subject line for patterns
   */
  private findLeadsBySubjectAnalysis(leads: Lead[], subject: string): Lead[] {
    const subjectLower = subject.toLowerCase();
    
    // Look for "re:" indicating a reply
    if (!subjectLower.startsWith('re:') && !subjectLower.includes('reply')) {
      return [];
    }

    // Extract potential company names or keywords from subject
    const matches: Lead[] = [];
    
    for (const lead of leads) {
      if (lead.company && lead.company.length > 3) {
        const companyLower = lead.company.toLowerCase();
        if (subjectLower.includes(companyLower)) {
          matches.push(lead);
        }
      }
      
      // Check for first name mentions
      if (lead.firstName && lead.firstName.length > 2) {
        const nameLower = lead.firstName.toLowerCase();
        if (subjectLower.includes(nameLower)) {
          matches.push(lead);
        }
      }
    }

    // Remove duplicates and sort by most recent activity
    const uniqueMatches = Array.from(new Set(matches));
    return uniqueMatches.sort((a, b) => {
      const aTime = a.lastEmailSentAt ? new Date(a.lastEmailSentAt).getTime() : 0;
      const bTime = b.lastEmailSentAt ? new Date(b.lastEmailSentAt).getTime() : 0;
      return bTime - aTime;
    });
  }

  /**
   * Find leads by domain match (colleague responses)
   */
  private findLeadsByDomain(leads: Lead[], fromEmail: string): Lead[] {
    const fromDomain = this.extractDomain(fromEmail);
    if (!fromDomain) return [];

    return leads.filter(lead => {
      const leadDomain = this.extractDomain(lead.email);
      return leadDomain === fromDomain;
    }).sort((a, b) => {
      const aTime = a.lastEmailSentAt ? new Date(a.lastEmailSentAt).getTime() : 0;
      const bTime = b.lastEmailSentAt ? new Date(b.lastEmailSentAt).getTime() : 0;
      return bTime - aTime;
    });
  }

  /**
   * Extract domain from email address
   */
  private extractDomain(email: string): string | null {
    const parts = email.split('@');
    return parts.length === 2 ? parts[1].toLowerCase() : null;
  }

  /**
   * Log match result for debugging and monitoring
   */
  logMatchResult(context: EmailResponseContext, result: EmailMatchResult): void {
    const logData = {
      timestamp: new Date().toISOString(),
      fromEmail: context.fromEmail,
      threadId: context.threadId,
      matchFound: !!result.lead,
      confidence: result.confidence,
      method: result.matchMethod,
      reason: result.reason,
      leadId: result.lead?.id,
      leadEmail: result.lead?.email,
      leadName: result.lead ? `${result.lead.firstName} ${result.lead.lastName}` : null
    };

    if (result.lead) {
      console.log(`✅ Lead match result:`, logData);
    } else {
      console.warn(`❌ No lead match:`, logData);
    }
  }
}

export default EmailResponseMatcher;