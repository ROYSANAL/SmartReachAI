import { Lead, LeadStatus } from '@/types';
import { EmailErrorClassification } from './emailErrorClassifier';
import moment from 'moment';

export interface RetryConfig {
  maxRetries: number;
  baseRetryDelay: number;    // Base delay in minutes
  exponentialBackoff: boolean;
  retryDelays: {             // Different delays per step type
    enrichment: number;      // Minutes to wait before retrying enrichment
    interaction: number;     // Minutes for post liking/commenting
    connection: number;      // Minutes for invitations
    messaging: number;       // Minutes for messaging
    email: number;           // Minutes for email sending
  };
}

export class FailureManager {
  private static readonly DEFAULT_CONFIG: RetryConfig = {
    maxRetries: 3,
    baseRetryDelay: 30,
    exponentialBackoff: true,
    retryDelays: {
      enrichment: 60,      // 1 hour
      interaction: 120,    // 2 hours
      connection: 240,     // 4 hours
      messaging: 480,      // 8 hours
      email: 60,           // 1 hour for email failures
    }
  };

  private config: RetryConfig;

  constructor(config?: Partial<RetryConfig>) {
    this.config = { ...FailureManager.DEFAULT_CONFIG, ...config };
  }

  /**
   * Enhanced email failure handler with error classification support
   * Returns the appropriate email status and additional data to store
   */
  handleEmailFailure(
    lead: Lead, 
    failedEmailStep: string, // e.g., 'day_1_email', 'day_2_email', etc.
    errorMessage: string,
    errorClassification?: EmailErrorClassification
  ): { shouldRetry: boolean; additionalData: Partial<Lead> } {
    const now = moment();
    const emailRetryCount = (lead.emailRetryCount || 0) + 1;
    
    // Use error classification if provided for intelligent retry decisions
    if (errorClassification) {
      console.log(`🔍 Using error classification for failure handling: ${errorClassification.type} (${errorClassification.severity})`);
      
      // Check if error should not be retried based on classification
      if (!errorClassification.retryable) {
        const additionalData: Partial<Lead> = {
          emailRetryCount,
          lastEmailFailureAt: now.toISOString(),
          lastEmailFailureReason: `${errorMessage} [${errorClassification.type}]`,
          lastEmailFailureStep: failedEmailStep,
          emailStatus: 'failed',
          nextEmailScheduledFor: '', // No more retries
        };
        
        console.log(`❌ Email permanently failed for ${lead.firstName} ${lead.lastName} at step '${failedEmailStep}': ${errorClassification.type} (non-retryable)`);
        return { shouldRetry: false, additionalData };
      }
      
      // Use classification-specific retry limits and delays
      const maxRetries = errorClassification.maxRetries || this.config.maxRetries;
      const shouldRetry = emailRetryCount < maxRetries;
      
      if (shouldRetry) {
        const delayMinutes = errorClassification.delayMinutes || this.calculateEmailRetryDelay(emailRetryCount);
        const retryAfter = now.clone().add(delayMinutes, 'minutes').toISOString();
        
        const additionalData: Partial<Lead> = {
          emailRetryCount,
          lastEmailFailureAt: now.toISOString(),
          lastEmailFailureReason: `${errorMessage} [${errorClassification.type}]`,
          lastEmailFailureStep: failedEmailStep,
          nextEmailScheduledFor: retryAfter,
        };
        
        console.log(`🔄 Email will retry for ${lead.firstName} ${lead.lastName} at step '${failedEmailStep}' in ${delayMinutes} minutes (attempt ${emailRetryCount}/${maxRetries}) - Error: ${errorClassification.type}`);
        return { shouldRetry: true, additionalData };
      } else {
        const additionalData: Partial<Lead> = {
          emailRetryCount,
          lastEmailFailureAt: now.toISOString(),
          lastEmailFailureReason: `${errorMessage} [${errorClassification.type}]`,
          lastEmailFailureStep: failedEmailStep,
          emailStatus: 'failed',
          nextEmailScheduledFor: '',
        };
        
        console.log(`❌ Email permanently failed for ${lead.firstName} ${lead.lastName} at step '${failedEmailStep}' after ${emailRetryCount} attempts - Error: ${errorClassification.type}`);
        return { shouldRetry: false, additionalData };
      }
    }
    
    // Fallback to original logic if no error classification provided
    const retryDelayMinutes = this.calculateEmailRetryDelay(emailRetryCount);
    const retryAfter = now.clone().add(retryDelayMinutes, 'minutes').toISOString();
    const shouldRetry = emailRetryCount < this.config.maxRetries;
    
    const additionalData: Partial<Lead> = {
      emailRetryCount,
      lastEmailFailureAt: now.toISOString(),
      lastEmailFailureReason: errorMessage,
      lastEmailFailureStep: failedEmailStep,
      nextEmailScheduledFor: shouldRetry ? retryAfter : '',
    };
    
    if (!shouldRetry) {
      additionalData.emailStatus = 'failed';
      console.log(`❌ Email permanently failed for ${lead.firstName} ${lead.lastName} at step '${failedEmailStep}' after ${emailRetryCount} attempts`);
    } else {
      console.log(`🔄 Email failed for ${lead.firstName} ${lead.lastName} at step '${failedEmailStep}', will retry in ${retryDelayMinutes} minutes (attempt ${emailRetryCount}/${this.config.maxRetries})`);
    }
    
    return { shouldRetry, additionalData };
  }

  /**
   * Handle a failure for a specific lead and step
   * Returns the appropriate status to set and additional data to store
   */
  handleFailure(
    lead: Lead, 
    failedStep: LeadStatus, 
    errorMessage: string
  ): { newStatus: LeadStatus; additionalData: Partial<Lead> } {
    const now = moment();
    const failureCount = (lead.failureCount || 0) + 1;
    const stepFailures = lead.stepFailures || {};
    
    // Update step-specific failure tracking
    const currentStepFailure = stepFailures[failedStep] || { count: 0, lastFailure: '', lastReason: '' };
    stepFailures[failedStep] = {
      count: currentStepFailure.count + 1,
      lastFailure: now.toISOString(),
      lastReason: errorMessage
    };

    // Calculate retry delay based on step type and failure count
    const retryDelayMinutes = this.calculateRetryDelay(failedStep, currentStepFailure.count + 1);
    const retryAfter = now.clone().add(retryDelayMinutes, 'minutes').toISOString();

    // Determine if we should retry or permanently fail
    const shouldRetry = this.shouldRetry(failedStep, currentStepFailure.count + 1, failureCount);

    const additionalData: Partial<Lead> = {
      failureCount,
      lastFailureStep: failedStep,
      lastFailureReason: errorMessage,
      lastFailureAt: now.toISOString(),
      retryAfter: shouldRetry ? retryAfter : undefined,
      maxRetries: this.config.maxRetries,
      stepFailures
    };

    // Determine new status
    let newStatus: LeadStatus;
    if (!shouldRetry) {
      newStatus = 'failed'; // Permanently failed
      console.log(`❌ Lead ${lead.firstName} ${lead.lastName} permanently failed at step '${failedStep}' after ${currentStepFailure.count + 1} attempts`);
    } else {
      // Keep current status but mark for retry
      newStatus = lead.status;
      console.log(`🔄 Lead ${lead.firstName} ${lead.lastName} failed at step '${failedStep}', will retry in ${retryDelayMinutes} minutes (attempt ${currentStepFailure.count + 1}/${this.config.maxRetries})`);
    }

    return { newStatus, additionalData };
  }

  /**
   * Check if a lead is ready to be retried
   */
  isReadyForRetry(lead: Lead): boolean {
    // If no retry timestamp, not eligible for retry
    if (!lead.retryAfter) {
      return false;
    }

    // If permanently failed (no retryAfter), skip
    if (lead.status === 'failed' && !lead.retryAfter) {
      return false;
    }

    // Check if enough time has passed
    const now = moment();
    const retryTime = moment(lead.retryAfter);
    
    return now.isAfter(retryTime);
  }

  /**
   * Get leads that are ready for retry, grouped by their current status
   * The workflow will process them and attempt their failed operations
   */
  getRetryableLeads(allLeads: Lead[]): {
    [step in LeadStatus]?: Lead[]
  } {
    const retryableLeads: { [step in LeadStatus]?: Lead[] } = {};

    for (const lead of allLeads) {
      if (this.isReadyForRetry(lead) && lead.lastFailureStep) {
        // ✅ NEW: Group by current status (not retry step)
        // The workflow will process them at their current status and retry the failed operation
        const currentStatus = lead.status;
        if (!retryableLeads[currentStatus]) {
          retryableLeads[currentStatus] = [];
        }
        retryableLeads[currentStatus].push(lead);
      }
    }

    return retryableLeads;
  }

  /**
   * Prepare a lead for retry - clear retry flags WITHOUT changing status
   * The lead stays at current status and workflow retries the failed operation
   */
  prepareForRetry(lead: Lead): { newStatus: LeadStatus; additionalData: Partial<Lead> } {
    console.log(`♻️ Preparing lead ${lead.firstName} ${lead.lastName} for retry:`);
    console.log(`   Failed operation: '${lead.lastFailureStep}' → Will retry from current status: '${lead.status}'`);
    
    // ✅ NEW APPROACH: Keep current status, only clear retry flags
    const additionalData: Partial<Lead> = {
      retryAfter: undefined, // Clear retry timestamp so workflow can attempt the failed operation
      updatedAt: moment().toISOString()
      // NOTE: We don't clear step-specific data or change status
      // The workflow will attempt the failed operation from current status
      // Status will only change upon successful completion of that operation
    };

    // Return current status (no status change)
    return { newStatus: lead.status, additionalData };
  }

  /**
   * Clear email failure data when an email sends successfully after retries
   */
  clearEmailFailureData(lead: Lead): Partial<Lead> {
    console.log(`✅ Clearing email failure data for ${lead.firstName} ${lead.lastName} after successful email send`);
    
    // Only clear if this lead actually had email failures
    if (!lead.emailRetryCount || lead.emailRetryCount === 0) {
      return {}; // No failure data to clear
    }
    
    const clearData: Partial<Lead> = {
      emailRetryCount: 0,
      lastEmailFailureAt: '',
      lastEmailFailureReason: '',
      lastEmailFailureStep: '',
      updatedAt: moment().toISOString()
    };
    
    console.log(`   Cleared email failure data (was ${lead.emailRetryCount} retries)`);
    return clearData;
  }

  /**
   * ✅ NEW: Clear failure tracking data when a step succeeds after retries
   * This prevents infinite retry loops for leads that eventually succeed
   */
  clearFailureData(lead: Lead, succeededStep: LeadStatus): Partial<Lead> {
    console.log(`✅ Clearing failure data for ${lead.firstName} ${lead.lastName} after successful '${succeededStep}'`);
    
    // Only clear if this lead actually had failures
    if (!lead.failureCount || lead.failureCount === 0) {
      return {}; // No failure data to clear
    }

    // Clear step-specific failure for the succeeded step
    const updatedStepFailures = { ...lead.stepFailures };
    if (updatedStepFailures && updatedStepFailures[succeededStep]) {
      delete updatedStepFailures[succeededStep];
      console.log(`   Cleared step failure data for '${succeededStep}'`);
    }

    // If this was the last failure step, clear it
    let clearedLastFailureStep = lead.lastFailureStep;
    if (lead.lastFailureStep === succeededStep) {
      clearedLastFailureStep = undefined;
      console.log(`   Cleared lastFailureStep (was '${succeededStep}')`);
    }

    // Calculate remaining total failure count
    const remainingFailures = Object.values(updatedStepFailures || {})
      .reduce((total, stepFailure) => total + (stepFailure?.count || 0), 0);

    const clearData: Partial<Lead> = {
      // Clear or reduce failure counters
      failureCount: remainingFailures,
      lastFailureStep: clearedLastFailureStep,
      lastFailureReason: remainingFailures > 0 ? lead.lastFailureReason : '',
      lastFailureAt: remainingFailures > 0 ? lead.lastFailureAt : '',
      retryAfter: '', // Always clear retry timestamp on success
      stepFailures: updatedStepFailures,
      updatedAt: moment().toISOString()
    };

    console.log(`   Total remaining failures: ${remainingFailures}`);
    return clearData;
  }

  /**
   * Get retry statistics for monitoring
   */
  getRetryStats(allLeads: Lead[]): {
    totalFailed: number;
    permanentlyFailed: number;
    awaitingRetry: number;
    readyForRetry: number;
    failuresByStep: { [step in LeadStatus]?: number };
  } {
    const stats = {
      totalFailed: 0,
      permanentlyFailed: 0,
      awaitingRetry: 0,
      readyForRetry: 0,
      failuresByStep: {} as { [step in LeadStatus]?: number }
    };

    for (const lead of allLeads) {
      if (lead.failureCount && lead.failureCount > 0) {
        stats.totalFailed++;

        if (lead.status === 'failed' && !lead.retryAfter) {
          stats.permanentlyFailed++;
        } else if (lead.retryAfter) {
          stats.awaitingRetry++;
          
          if (this.isReadyForRetry(lead)) {
            stats.readyForRetry++;
          }
        }

        // Count failures by step
        if (lead.lastFailureStep) {
          stats.failuresByStep[lead.lastFailureStep] = 
            (stats.failuresByStep[lead.lastFailureStep] || 0) + 1;
        }
      }
    }

    return stats;
  }

  private calculateRetryDelay(step: LeadStatus, attemptNumber: number): number {
    let baseDelay: number;

    // Map steps to delay categories
    switch (step) {
      case 'new':
      case 'lead_enriched':
        baseDelay = this.config.retryDelays.enrichment;
        break;
      case 'posts_liked':
      case 'posts_commented':
        baseDelay = this.config.retryDelays.interaction;
        break;
      case 'invitation_sent':
      case 'connected':
        baseDelay = this.config.retryDelays.connection;
        break;
      case 'first_message_sent':
        baseDelay = this.config.retryDelays.messaging;
        break;
      default:
        baseDelay = this.config.baseRetryDelay;
    }

    // Apply exponential backoff if enabled
    if (this.config.exponentialBackoff) {
      return baseDelay * Math.pow(2, attemptNumber - 1);
    }

    return baseDelay;
  }

  private calculateEmailRetryDelay(attemptNumber: number): number {
    const baseDelay = this.config.retryDelays.email;

    // Apply exponential backoff if enabled
    if (this.config.exponentialBackoff) {
      return baseDelay * Math.pow(2, attemptNumber - 1);
    }

    return baseDelay;
  }

  private shouldRetry(step: LeadStatus, stepAttempts: number, _totalFailures: number): boolean {
    // Don't retry if we've exceeded max retries
    if (stepAttempts >= this.config.maxRetries) {
      return false;
    }

    // Special rules for different steps
    switch (step) {
      case 'new':
      case 'lead_enriched':
        // Be more lenient with enrichment failures
        return stepAttempts < this.config.maxRetries;
      
      case 'posts_liked':
      case 'posts_commented':
      case 'invitation_sent':
      case 'first_message_sent':
        // Standard retry for interaction steps
        return stepAttempts < this.config.maxRetries;
      
      case 'connected':
        // Connection checking doesn't usually fail, but if it does, retry quickly
        return stepAttempts < 2; // Lower retry count
      
      default:
        return stepAttempts < this.config.maxRetries;
    }
  }

}