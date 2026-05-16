/**
 * Email Error Classification System
 * Mirrors the LinkedIn retry mechanism structure for consistency
 */

export enum EmailErrorType {
  // Transient errors - can be retried
  RATE_LIMIT = 'RATE_LIMIT',
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  NETWORK_ERROR = 'NETWORK_ERROR',
  SERVER_ERROR = 'SERVER_ERROR',
  TIMEOUT = 'TIMEOUT',
  TOKEN_REFRESH_NEEDED = 'TOKEN_REFRESH_NEEDED',
  
  // Authentication errors - may need token refresh or account action
  AUTH_ERROR = 'AUTH_ERROR',
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  EXPIRED_TOKEN = 'EXPIRED_TOKEN',
  
  // Permanent errors - should not be retried
  INVALID_EMAIL = 'INVALID_EMAIL',
  BLOCKED_RECIPIENT = 'BLOCKED_RECIPIENT',
  ACCOUNT_SUSPENDED = 'ACCOUNT_SUSPENDED',
  INVALID_CONFIG = 'INVALID_CONFIG',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  
  // Content errors
  MESSAGE_TOO_LARGE = 'MESSAGE_TOO_LARGE',
  INVALID_FORMAT = 'INVALID_FORMAT',
  SPAM_DETECTED = 'SPAM_DETECTED',
  
  // Unknown
  UNKNOWN_ERROR = 'UNKNOWN_ERROR'
}

export enum EmailErrorSeverity {
  LOW = 'LOW',           // Retry immediately
  MEDIUM = 'MEDIUM',     // Retry with delay
  HIGH = 'HIGH',         // Retry with longer delay
  CRITICAL = 'CRITICAL'  // Don't retry, escalate
}

export interface EmailErrorClassification {
  type: EmailErrorType;
  severity: EmailErrorSeverity;
  retryable: boolean;
  immediateAction?: string;
  delayMinutes?: number;
  maxRetries?: number;
  escalate?: boolean;
}

export class EmailErrorClassifier {
  
  /**
   * Classify email error based on error message and context
   */
  static classifyError(error: Error | string): EmailErrorClassification {
    const errorMessage = typeof error === 'string' ? error : error.message;
    const lowerMessage = errorMessage.toLowerCase();

    // Gmail API specific error patterns
    if (lowerMessage.includes('quotaexceeded') || lowerMessage.includes('quota exceeded')) {
      return {
        type: EmailErrorType.QUOTA_EXCEEDED,
        severity: EmailErrorSeverity.HIGH,
        retryable: true,
        delayMinutes: 60, // Wait 1 hour
        maxRetries: 3
      };
    }

    if (lowerMessage.includes('rateLimitExceeded') || lowerMessage.includes('rate limit')) {
      return {
        type: EmailErrorType.RATE_LIMIT,
        severity: EmailErrorSeverity.MEDIUM,
        retryable: true,
        delayMinutes: 15, // Wait 15 minutes
        maxRetries: 5
      };
    }

    // Authentication errors
    if (lowerMessage.includes('unauthorized') || lowerMessage.includes('401')) {
      if (lowerMessage.includes('token') || lowerMessage.includes('expired')) {
        return {
          type: EmailErrorType.EXPIRED_TOKEN,
          severity: EmailErrorSeverity.MEDIUM,
          retryable: true,
          immediateAction: 'refresh_token',
          delayMinutes: 1,
          maxRetries: 2
        };
      }
      
      return {
        type: EmailErrorType.AUTH_ERROR,
        severity: EmailErrorSeverity.HIGH,
        retryable: false,
        escalate: true
      };
    }

    // Invalid credentials
    if (lowerMessage.includes('invalid_client') || 
        lowerMessage.includes('invalid_grant') ||
        lowerMessage.includes('unauthorized_client')) {
      return {
        type: EmailErrorType.INVALID_CREDENTIALS,
        severity: EmailErrorSeverity.CRITICAL,
        retryable: false,
        immediateAction: 'deactivate_account',
        escalate: true
      };
    }

    // Network and server errors
    if (lowerMessage.includes('timeout') || 
        lowerMessage.includes('timed out')) {
      return {
        type: EmailErrorType.TIMEOUT,
        severity: EmailErrorSeverity.LOW,
        retryable: true,
        delayMinutes: 2,
        maxRetries: 3
      };
    }

    if (lowerMessage.includes('network') || 
        lowerMessage.includes('connection') ||
        lowerMessage.includes('enotfound') ||
        lowerMessage.includes('econnreset')) {
      return {
        type: EmailErrorType.NETWORK_ERROR,
        severity: EmailErrorSeverity.LOW,
        retryable: true,
        delayMinutes: 1,
        maxRetries: 3
      };
    }

    if (lowerMessage.includes('500') || 
        lowerMessage.includes('502') || 
        lowerMessage.includes('503') || 
        lowerMessage.includes('504') ||
        lowerMessage.includes('internal server error')) {
      return {
        type: EmailErrorType.SERVER_ERROR,
        severity: EmailErrorSeverity.MEDIUM,
        retryable: true,
        delayMinutes: 5,
        maxRetries: 3
      };
    }

    // Email content/recipient errors
    if (lowerMessage.includes('invalid email') || 
        lowerMessage.includes('bad recipient') ||
        lowerMessage.includes('recipient address rejected')) {
      return {
        type: EmailErrorType.INVALID_EMAIL,
        severity: EmailErrorSeverity.MEDIUM,
        retryable: false,
        immediateAction: 'mark_email_invalid'
      };
    }

    if (lowerMessage.includes('message too large') || 
        lowerMessage.includes('exceeds size limit')) {
      return {
        type: EmailErrorType.MESSAGE_TOO_LARGE,
        severity: EmailErrorSeverity.MEDIUM,
        retryable: false,
        immediateAction: 'reduce_content_size'
      };
    }

    if (lowerMessage.includes('spam') || 
        lowerMessage.includes('blocked') ||
        lowerMessage.includes('reputation')) {
      return {
        type: EmailErrorType.SPAM_DETECTED,
        severity: EmailErrorSeverity.HIGH,
        retryable: false,
        immediateAction: 'review_content_and_account',
        escalate: true
      };
    }

    if (lowerMessage.includes('suspended') || 
        lowerMessage.includes('account disabled')) {
      return {
        type: EmailErrorType.ACCOUNT_SUSPENDED,
        severity: EmailErrorSeverity.CRITICAL,
        retryable: false,
        immediateAction: 'deactivate_account',
        escalate: true
      };
    }

    if (lowerMessage.includes('permission') || 
        lowerMessage.includes('forbidden') ||
        lowerMessage.includes('403')) {
      return {
        type: EmailErrorType.PERMISSION_DENIED,
        severity: EmailErrorSeverity.HIGH,
        retryable: false,
        immediateAction: 'check_account_permissions',
        escalate: true
      };
    }

    // Default classification for unknown errors
    return {
      type: EmailErrorType.UNKNOWN_ERROR,
      severity: EmailErrorSeverity.MEDIUM,
      retryable: true,
      delayMinutes: 5,
      maxRetries: 2,
      escalate: true // Unknown errors should be reviewed
    };
  }

  /**
   * Check if error should trigger account deactivation
   */
  static shouldDeactivateAccount(classification: EmailErrorClassification): boolean {
    return classification.type === EmailErrorType.ACCOUNT_SUSPENDED ||
           classification.type === EmailErrorType.INVALID_CREDENTIALS ||
           (classification.severity === EmailErrorSeverity.CRITICAL && !classification.retryable);
  }

  /**
   * Get human-readable error summary
   */
  static getErrorSummary(classification: EmailErrorClassification): string {
    const action = classification.retryable ? 'will retry' : 'will not retry';
    const delay = classification.delayMinutes ? ` (after ${classification.delayMinutes}min)` : '';
    
    return `${classification.type} (${classification.severity}) - ${action}${delay}`;
  }
}

export default EmailErrorClassifier;