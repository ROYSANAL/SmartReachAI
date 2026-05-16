import { google } from 'googleapis';
import { EmailAccount } from '@/types';
import { GoogleSheetsService } from './googleSheets';

export interface TokenRefreshResult {
  success: boolean;
  accessToken?: string;
  tokenExpiry?: string;
  error?: string;
}

export class TokenRefreshManager {
  private static instance: TokenRefreshManager;
  private refreshLocks = new Map<string, Promise<TokenRefreshResult>>();
  private recentRefreshes = new Map<string, number>(); // Track recently refreshed accounts
  private sheetsService: GoogleSheetsService;

  private constructor() {
    this.sheetsService = new GoogleSheetsService();
    
    // Clean up old refresh records every 10 minutes
    setInterval(() => {
      this.cleanupOldRefreshRecords();
    }, 10 * 60 * 1000);
  }

  /**
   * Clean up refresh records older than 5 minutes
   */
  private cleanupOldRefreshRecords(): void {
    const now = Date.now();
    const cleanupThreshold = 5 * 60 * 1000; // 5 minutes
    
    for (const [accountId, refreshTime] of this.recentRefreshes.entries()) {
      if (now - refreshTime > cleanupThreshold) {
        this.recentRefreshes.delete(accountId);
      }
    }
  }

  static getInstance(): TokenRefreshManager {
    if (!TokenRefreshManager.instance) {
      TokenRefreshManager.instance = new TokenRefreshManager();
    }
    return TokenRefreshManager.instance;
  }

  /**
   * Refresh OAuth2 token with proper locking and retry logic
   */
  async refreshTokenSafely(emailAccount: EmailAccount, redirectUri: string): Promise<TokenRefreshResult> {
    const lockKey = emailAccount.id;
    const now = Date.now();

    // Check if token was recently refreshed (within last 2 minutes)
    const recentRefreshTime = this.recentRefreshes.get(lockKey);
    if (recentRefreshTime && (now - recentRefreshTime) < 2 * 60 * 1000) {
      console.log(`⚡ Token recently refreshed for ${emailAccount.emailAddress}, skipping refresh`);
      return {
        success: true,
        accessToken: emailAccount.accessToken,
        tokenExpiry: emailAccount.tokenExpiry
      };
    }

    // Check if refresh is already in progress for this account
    if (this.refreshLocks.has(lockKey)) {
      console.log(`⏳ Token refresh already in progress for ${emailAccount.emailAddress}, waiting...`);
      return await this.refreshLocks.get(lockKey)!;
    }

    // Create refresh promise and add to locks
    const refreshPromise = this.performTokenRefresh(emailAccount, redirectUri);
    this.refreshLocks.set(lockKey, refreshPromise);

    try {
      const result = await refreshPromise;
      
      // Record successful refresh time
      if (result.success) {
        this.recentRefreshes.set(lockKey, Date.now());
        console.log(`⚡ Recorded successful refresh for ${emailAccount.emailAddress}`);
      }
      
      return result;
    } finally {
      // Always clean up the lock
      this.refreshLocks.delete(lockKey);
    }
  }

  private async performTokenRefresh(emailAccount: EmailAccount, redirectUri: string): Promise<TokenRefreshResult> {
    const maxRetries = 3;
    const baseDelay = 1000; // 1 second

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔄 Token refresh attempt ${attempt}/${maxRetries} for ${emailAccount.emailAddress}`);

        // Validate required credentials
        if (!emailAccount.refreshToken || !emailAccount.clientId || !emailAccount.clientSecret) {
          return {
            success: false,
            error: `Missing OAuth2 credentials for ${emailAccount.emailAddress}`
          };
        }

        // Create OAuth2 client
        const oauth2Client = new google.auth.OAuth2(
          emailAccount.clientId,
          emailAccount.clientSecret,
          redirectUri
        );

        oauth2Client.setCredentials({
          refresh_token: emailAccount.refreshToken
        });

        // Attempt token refresh
        const { credentials } = await oauth2Client.refreshAccessToken();
        
        // Validate new token
        if (!credentials.access_token) {
          throw new Error('No access token returned from refresh');
        }

        if (!credentials.expiry_date) {
          throw new Error('No expiry date returned from refresh');
        }

        // Validate token is actually new (not same as existing)
        if (credentials.access_token === emailAccount.accessToken) {
          console.warn(`⚠️ Refresh returned same token for ${emailAccount.emailAddress}`);
        }

        // Calculate new expiry with safety buffer
        const newExpiry = new Date(credentials.expiry_date);
        const now = new Date();
        const tokenLifetime = newExpiry.getTime() - now.getTime();

        if (tokenLifetime <= 0) {
          throw new Error('Refreshed token is already expired');
        }

        if (tokenLifetime < 10 * 60 * 1000) { // Less than 10 minutes
          console.warn(`⚠️ Short token lifetime (${Math.round(tokenLifetime / 60000)} minutes) for ${emailAccount.emailAddress}`);
        }

        // Update account with new credentials
        const updates = {
          accessToken: credentials.access_token,
          tokenExpiry: newExpiry.toISOString()
        };

        await this.sheetsService.updateEmailAccount(emailAccount.id, updates);

        console.log(`✅ Token refreshed successfully for ${emailAccount.emailAddress} (expires: ${newExpiry.toLocaleString()})`);
        
        return {
          success: true,
          accessToken: credentials.access_token,
          tokenExpiry: newExpiry.toISOString()
        };

      } catch (error) {
        const isLastAttempt = attempt === maxRetries;
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        console.error(`❌ Token refresh attempt ${attempt} failed for ${emailAccount.emailAddress}: ${errorMessage}`);

        // Check for permanent failures that shouldn't be retried
        if (this.isPermanentTokenError(errorMessage)) {
          console.error(`🚫 Permanent token error detected, marking account as inactive: ${errorMessage}`);
          
          // Mark account as inactive
          await this.sheetsService.updateEmailAccount(emailAccount.id, {
            isActive: false
          });

          return {
            success: false,
            error: `Permanent token error: ${errorMessage}`
          };
        }

        if (isLastAttempt) {
          // Final attempt failed, mark account with warning
          await this.sheetsService.updateEmailAccount(emailAccount.id, {
            reputation: 'warning'
          });

          return {
            success: false,
            error: `Token refresh failed after ${maxRetries} attempts: ${errorMessage}`
          };
        }

        // Wait before retry with exponential backoff
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.log(`⏳ Retrying token refresh in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    return {
      success: false,
      error: 'Token refresh failed - should not reach here'
    };
  }

  /**
   * Check if error indicates permanent token failure
   */
  private isPermanentTokenError(errorMessage: string): boolean {
    const permanentErrors = [
      'invalid_grant',
      'invalid_client',
      'unauthorized_client',
      'unsupported_grant_type',
      'invalid_scope',
      'refresh token is invalid',
      'token has been expired or revoked'
    ];

    return permanentErrors.some(error => 
      errorMessage.toLowerCase().includes(error.toLowerCase())
    );
  }

  /**
   * Check if token needs refresh (with buffer)
   */
  static needsRefresh(tokenExpiry: string | null | undefined, bufferMinutes: number = 5): boolean {
    if (!tokenExpiry) {
      console.log('🔍 Token refresh needed: No token expiry found');
      return true;
    }
    
    const expiry = new Date(tokenExpiry);
    const now = new Date();
    const buffer = bufferMinutes * 60 * 1000;
    
    const needsRefresh = (now.getTime() + buffer) >= expiry.getTime();
    
    if (needsRefresh) {
      const minutesToExpiry = Math.round((expiry.getTime() - now.getTime()) / (60 * 1000));
      console.log(`🔍 Token refresh needed: Expires in ${minutesToExpiry} minutes (buffer: ${bufferMinutes} min)`);
    } else {
      const minutesToExpiry = Math.round((expiry.getTime() - now.getTime()) / (60 * 1000));
      console.log(`🔍 Token still valid: ${minutesToExpiry} minutes remaining (buffer: ${bufferMinutes} min)`);
    }
    
    return needsRefresh;
  }

}

export const getTokenRefreshManager = (): TokenRefreshManager => {
  return TokenRefreshManager.getInstance();
};