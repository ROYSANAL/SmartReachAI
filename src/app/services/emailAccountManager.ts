import { EmailAccount } from '@/types';
import { GoogleSheetsService } from './googleSheets';
import { EmailDelayManager } from './emailDelayManager';
import { google } from 'googleapis';
import { getTokenRefreshManager, TokenRefreshManager, type TokenRefreshResult } from './tokenRefreshManager';
import { CONFIG } from '@/config/config';

export class EmailAccountManager {
  private static instance: EmailAccountManager;
  private sheetsService: GoogleSheetsService;
  private accountsCache: EmailAccount[] = [];
  private lastCacheUpdate: number = 0;
  private readonly CACHE_TTL = 10 * 60 * 1000; // 10 minute

  private constructor() {
    this.sheetsService = new GoogleSheetsService();
  }

  static getInstance(): EmailAccountManager {
    if (!EmailAccountManager.instance) {
      EmailAccountManager.instance = new EmailAccountManager();
    }
    return EmailAccountManager.instance;
  }

  /**
   * Get all active email accounts with valid authentication
   */
  async getActiveAccounts(): Promise<EmailAccount[]> {
    try {
      // Always get fresh data for counter accuracy
      const allAccounts = await this.sheetsService.getAllEmailAccounts();
      
      const activeAccounts = allAccounts.filter(account => 
        account.isActive && 
        account.accessToken && // Has access token instead of checking authStatus
        account.refreshToken && // Has refresh token
        !account.warmupPhase &&
        account.reputation !== 'poor'
      );

      console.log(`📧 Found ${activeAccounts.length} active email accounts`);
      return activeAccounts;
    } catch (error) {
      console.error('❌ Error fetching active email accounts:', error);
      throw new Error(`Failed to get active accounts: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get the best available email account for sending (round-robin with health checks)
   * Returns account ready to send immediately, or null if all accounts need delays
   */
  async getAvailableAccountForSending(): Promise<EmailAccount | null> {
    try {
      const activeAccounts = await this.getActiveAccounts();
      
      if (activeAccounts.length === 0) {
        console.warn('⚠️ No active email accounts available');
        return null;
      }

    // Filter accounts that haven't exceeded daily/hourly limits and respect delays
    const availableAccounts = activeAccounts.filter(account => {
      // Check if counters should be considered reset
      const now = new Date();
      const lastSentTime = account.lastEmailSent ? new Date(account.lastEmailSent) : new Date(0);
      
      const shouldResetDaily = now.toDateString() !== lastSentTime.toDateString();
      const shouldResetHourly = now.getHours() !== lastSentTime.getHours() || shouldResetDaily;
      
      // Use effective counts (reset if time period changed)
      const effectiveDailyCount = shouldResetDaily ? 0 : account.sentToday;
      const effectiveHourlyCount = shouldResetHourly ? 0 : account.sentThisHour;
      
      const dailyOk = effectiveDailyCount < account.dailyLimit;
      const hourlyOk = effectiveHourlyCount < account.hourlyLimit;
      const delayOk = EmailDelayManager.canSendEmailNow(account);
      
      return dailyOk && hourlyOk && delayOk;
    });

    if (availableAccounts.length === 0) {
      // Provide detailed info about why accounts are unavailable
      const delayedAccounts = activeAccounts.filter(account => !EmailDelayManager.canSendEmailNow(account));
      const limitReachedAccounts = activeAccounts.filter(account => 
        account.sentToday >= account.dailyLimit || account.sentThisHour >= account.hourlyLimit
      );
      
      if (delayedAccounts.length > 0) {
        console.warn('⏰ All email accounts are in delay period (8-12 min between emails)');
        delayedAccounts.forEach(account => {
          const waitTime = EmailDelayManager.getWaitTimeString(account);
          console.warn(`   ${account.emailAddress}: ${waitTime}`);
        });
      } else if (limitReachedAccounts.length > 0) {
        console.warn('⚠️ All email accounts have reached their daily/hourly limits');
      } else {
        console.warn('⚠️ No email accounts available for sending');
      }
      
      return null;
    }

      // Sort by usage (least used first) and reputation (best first)
      availableAccounts.sort((a, b) => {
        // Primary: reputation (good > warning > poor)
        const reputationScore = (rep: string) => rep === 'good' ? 3 : rep === 'warning' ? 2 : 1;
        const repDiff = reputationScore(b.reputation) - reputationScore(a.reputation);
        if (repDiff !== 0) return repDiff;
        
        // Secondary: least used today
        return a.sentToday - b.sentToday;
      });

      return availableAccounts[0];
    } catch (error) {
      console.error('❌ Error getting available account for sending:', error);
      throw new Error(`Failed to get available account: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get the best account for sending, waiting for delays if necessary
   * This method will wait for an account to become available instead of returning null
   */
  async getNextAvailableAccountForSending(): Promise<EmailAccount | null> {
    const activeAccounts = await this.getActiveAccounts();
    
    if (activeAccounts.length === 0) {
      console.warn('⚠️ No active email accounts available');
      return null;
    }

    // Filter accounts that haven't exceeded daily/hourly limits (ignore delays for now)
    const limitOkAccounts = activeAccounts.filter(account => {
      const dailyOk = account.sentToday < account.dailyLimit;
      const hourlyOk = account.sentThisHour < account.hourlyLimit;
      
      return dailyOk && hourlyOk;
    });

    if (limitOkAccounts.length === 0) {
      console.warn('⚠️ All email accounts have reached their daily/hourly limits');
      return null;
    }

    // Sort by usage and reputation (same logic as before)
    limitOkAccounts.sort((a, b) => {
      // Primary: reputation (good > warning > poor)
      const reputationScore = (rep: string) => rep === 'good' ? 3 : rep === 'warning' ? 2 : 1;
      const repDiff = reputationScore(b.reputation) - reputationScore(a.reputation);
      if (repDiff !== 0) return repDiff;
      
      // Secondary: least used today
      return a.sentToday - b.sentToday;
    });

    // Return the best account (caller will handle delay if needed)
    return limitOkAccounts[0];
  }

  /**
   * Update account usage after sending an email using atomic operations
   */
  async updateAccountUsage(accountId: string, success: boolean = true): Promise<void> {
    try {
      console.log(`🔄 Updating account usage for ID: ${accountId}, success: ${success}`);
      
      if (success) {
        // Use atomic counter update to prevent race conditions
        await this.sheetsService.atomicCounterUpdate(accountId);
      } else {
        // For failures, just update reputation without affecting counters
        console.log(`❌ Email send failed, updating reputation for ${accountId}`);
        await this.sheetsService.updateEmailAccount(accountId, {
          reputation: 'warning'
        });
      }
      
      // Invalidate cache to ensure fresh data on next read
      this.accountsCache = [];
      this.lastCacheUpdate = 0;
      
      console.log(`✅ Account usage update completed for ${accountId}`);
    } catch (error) {
      console.error('Error updating account usage:', error);
      throw new Error(`Failed to update account usage for ${accountId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Refresh OAuth2 access token for an account
   */
  async refreshAccessToken(accountId: string): Promise<boolean> {
    try {
      const account = this.accountsCache.find(acc => acc.id === accountId);
      if (!account) {
        console.error(`Email account ${accountId} not found`);
        return false;
      }

      if (!account.refreshToken || !account.clientId || !account.clientSecret) {
        console.error(`Missing OAuth2 credentials for account ${account.emailAddress}`);
        return false;
      }

      // Create OAuth2 client
      const oauth2Client = new google.auth.OAuth2(
        account.clientId,
        account.clientSecret,
        'http://localhost:3000/api/auth/callback' // This will be configurable
      );

      oauth2Client.setCredentials({
        refresh_token: account.refreshToken
      });

      // Refresh the token
      const { credentials } = await oauth2Client.refreshAccessToken();
      
      if (!credentials.access_token) {
        throw new Error('Failed to refresh access token');
      }

      // Update account with new token
      const updates: Partial<EmailAccount> = {
        accessToken: credentials.access_token,
        tokenExpiry: credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : ''
      };

      await this.sheetsService.updateEmailAccount(accountId, updates);
      
      // Update cache
      Object.assign(account, updates);
      
      console.log(`✅ Refreshed access token for ${account.emailAddress}`);
      return true;

    } catch (error) {
      console.error(`❌ Failed to refresh token for account ${accountId}:`, error);
      
      // Mark account as inactive on token failure
      await this.sheetsService.updateEmailAccount(accountId, {
        isActive: false
      });

      return false;
    }
  }

  /**
   * Check and refresh tokens for accounts that are expiring soon
   * Uses optimized TokenRefreshManager with proper error handling
   */
  async checkAndRefreshTokens(): Promise<void> {
    try {
      console.log('🔍 Starting token refresh check for email accounts...');
      
      // Get token refresh manager instance
      const tokenRefreshManager = getTokenRefreshManager();
      
      // Ensure we have fresh account data
      await this.refreshAccountsCache();
      
      // Find active accounts with expiring tokens (5-minute buffer for consistency)
      const accountsNeedingRefresh = this.getAccountsNeedingRefresh();
      
      if (accountsNeedingRefresh.length === 0) {
        console.log('✅ All active email accounts have valid tokens');
        return;
      }
      
      console.log(`🔄 Found ${accountsNeedingRefresh.length} accounts needing token refresh`);
      
      // Process token refreshes with proper error handling
      const refreshResults = await this.processTokenRefreshes(tokenRefreshManager, accountsNeedingRefresh);
      
      // Log summary of refresh operations
      this.logRefreshSummary(refreshResults);
      
    } catch (error) {
      console.error('❌ Critical error in token refresh process:', error);
      throw new Error(`Token refresh process failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Filter accounts that need token refresh
   */
  private getAccountsNeedingRefresh(): EmailAccount[] {
    return this.accountsCache.filter(account => {
      if (!account.isActive) {
        return false;
      }
      
      const needsRefresh = TokenRefreshManager.needsRefresh(account.tokenExpiry, 5);
      
      if (needsRefresh) {
        console.log(`⏰ Account ${account.emailAddress} needs token refresh`);
      }
      
      return needsRefresh;
    });
  }

  /**
   * Process token refreshes for multiple accounts with rate limiting
   */
  private async processTokenRefreshes(
    tokenRefreshManager: TokenRefreshManager,
    accounts: EmailAccount[]
  ): Promise<Array<{ account: EmailAccount; result: TokenRefreshResult; error?: Error }>> {
    const results: Array<{ account: EmailAccount; result: TokenRefreshResult; error?: Error }> = [];
    const redirectUri = CONFIG.OAUTH?.REDIRECT_URI || 'http://localhost:3000/api/auth/email/callback';
    
    for (const account of accounts) {
      try {
        console.log(`🔄 Refreshing token for ${account.emailAddress}...`);
        
        const refreshResult = await tokenRefreshManager.refreshTokenSafely(account, redirectUri);
        
        if (refreshResult.success && refreshResult.accessToken && refreshResult.tokenExpiry) {
          // Update account tokens in database and cache
          await this.updateAccountTokens(account.id, {
            accessToken: refreshResult.accessToken,
            tokenExpiry: refreshResult.tokenExpiry
          });
          
          console.log(`✅ Successfully refreshed token for ${account.emailAddress}`);
          results.push({ account, result: refreshResult });
        } else {
          const error = new Error(refreshResult.error || 'Unknown refresh error');
          console.error(`❌ Token refresh failed for ${account.emailAddress}: ${refreshResult.error}`);
          results.push({ account, result: refreshResult, error });
        }
      } catch (error) {
        const refreshError = error instanceof Error ? error : new Error(String(error));
        console.error(`❌ Exception during token refresh for ${account.emailAddress}:`, refreshError.message);
        
        // Create failed result for logging
        const failedResult: TokenRefreshResult = {
          success: false,
          error: refreshError.message
        };
        
        results.push({ account, result: failedResult, error: refreshError });
      }
      
      // Rate limiting: delay between refresh attempts
      if (accounts.indexOf(account) < accounts.length - 1) {
        await this.delay(1000); // 1 second delay between refreshes
      }
    }
    
    return results;
  }

  /**
   * Log summary of token refresh operations
   */
  private logRefreshSummary(results: Array<{ account: EmailAccount; result: TokenRefreshResult; error?: Error }>): void {
    const successful = results.filter(r => r.result.success);
    const failed = results.filter(r => !r.result.success);
    
    console.log(`📊 Token refresh summary:`);
    console.log(`  ✅ Successful: ${successful.length}`);
    console.log(`  ❌ Failed: ${failed.length}`);
    
    if (failed.length > 0) {
      console.log(`  📋 Failed accounts:`);
      failed.forEach(f => {
        console.log(`    - ${f.account.emailAddress}: ${f.result.error}`);
      });
    }
  }

  /**
   * Utility method for delays
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get account health summary
   */
  async getAccountHealthSummary(): Promise<{
    total: number;
    active: number;
    warning: number;
    poor: number;
    expired: number;
    warmingUp: number;
  }> {
    await this.refreshAccountsCache();
    
    const summary = {
      total: this.accountsCache.length,
      active: 0,
      warning: 0,
      poor: 0,
      expired: 0,
      warmingUp: 0
    };

    this.accountsCache.forEach(account => {
      if (account.warmupPhase) {
        summary.warmingUp++;
      } else if (!account.accessToken || !account.refreshToken) {
        summary.expired++;
      } else if (account.reputation === 'poor') {
        summary.poor++;
      } else if (account.reputation === 'warning') {
        summary.warning++;
      } else if (account.isActive) {
        summary.active++;
      }
    });

    return summary;
  }

  /**
   * Refresh accounts cache from database
   */
  private async refreshAccountsCache(): Promise<void> {
    const now = Date.now();
    
    // Skip refresh if cache is still fresh
    if (this.accountsCache.length > 0 && (now - this.lastCacheUpdate) < this.CACHE_TTL) {
      return;
    }

    try {
      this.accountsCache = await this.sheetsService.getAllEmailAccounts();
      this.lastCacheUpdate = now;
      console.log(`📧 Refreshed email accounts cache: ${this.accountsCache.length} accounts`);
    } catch (error) {
      console.error('Error refreshing email accounts cache:', error);
      throw new Error(`Failed to refresh email accounts cache: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get account by ID
   */
  async getAccountById(accountId: string): Promise<EmailAccount | null> {
    try {
      await this.refreshAccountsCache();
      const account = this.accountsCache.find(account => account.id === accountId) || null;
      
      if (!account) {
        console.warn(`⚠️ Email account not found: ${accountId}`);
      }
      
      return account;
    } catch (error) {
      console.error(`❌ Error getting account by ID ${accountId}:`, error);
      throw new Error(`Failed to get account by ID: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get accounts by email address (for OAuth2 setup)
   */
  async getAccountByEmail(emailAddress: string): Promise<EmailAccount | null> {
    try {
      await this.refreshAccountsCache();
      const account = this.accountsCache.find(account => account.emailAddress === emailAddress) || null;
      
      if (!account) {
        console.warn(`⚠️ Email account not found for address: ${emailAddress}`);
      }
      
      return account;
    } catch (error) {
      console.error(`❌ Error getting account by email ${emailAddress}:`, error);
      throw new Error(`Failed to get account by email: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Update account tokens after successful refresh
   */
  async updateAccountTokens(accountId: string, tokenData: { accessToken: string; tokenExpiry: string }): Promise<void> {
    try {
      console.log(`🔄 Updating tokens for account ID: ${accountId}`);
      
      // Update in database
      await this.sheetsService.updateEmailAccount(accountId, {
        accessToken: tokenData.accessToken,
        tokenExpiry: tokenData.tokenExpiry
      });
      
      // Update cache to maintain consistency
      const cacheIndex = this.accountsCache.findIndex(acc => acc.id === accountId);
      if (cacheIndex >= 0) {
        this.accountsCache[cacheIndex].accessToken = tokenData.accessToken;
        this.accountsCache[cacheIndex].tokenExpiry = tokenData.tokenExpiry;
        console.log(`✅ Updated tokens in cache for ${this.accountsCache[cacheIndex].emailAddress}`);
      } else {
        // Force cache refresh if account not found in cache
        console.log(`🔄 Account not in cache, forcing refresh...`);
        await this.refreshAccountsCache();
      }
      
    } catch (error) {
      console.error(`❌ Failed to update tokens for account ${accountId}:`, error);
      throw new Error(`Token update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Create or update email account during OAuth2 flow
   */
  async createOrUpdateAccount(accountData: Partial<EmailAccount>): Promise<EmailAccount> {
    try {
      // Check if account exists
      let existingAccount = null;
      if (accountData.emailAddress) {
        existingAccount = await this.getAccountByEmail(accountData.emailAddress);
      }

      if (existingAccount) {
        // Update existing account
        const updates = {
          ...accountData,
          isActive: true // Mark as active when OAuth is successful
        };

        await this.sheetsService.updateEmailAccount(existingAccount.id, updates);
        
        // Update cache
        const updatedAccount = { ...existingAccount, ...updates };
        const cacheIndex = this.accountsCache.findIndex(acc => acc.id === existingAccount.id);
        if (cacheIndex >= 0) {
          this.accountsCache[cacheIndex] = updatedAccount;
        }

        console.log(`✅ Updated email account: ${updatedAccount.emailAddress}`);
        return updatedAccount;
      } else {
        // Create new account
        const newAccount: EmailAccount = {
          id: `email_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
          emailAddress: accountData.emailAddress || '',
          displayName: accountData.displayName || '',
          provider: accountData.provider || 'gmail',
          clientId: accountData.clientId || '',
          clientSecret: accountData.clientSecret || '',
          refreshToken: accountData.refreshToken || '',
          accessToken: accountData.accessToken || '',
          tokenExpiry: accountData.tokenExpiry || '',
          dailyLimit: accountData.dailyLimit || 50, // Conservative default
          hourlyLimit: accountData.hourlyLimit || 10,
          sentToday: 0,
          sentThisHour: 0,
          reputation: 'good',
          isActive: true,
          warmupPhase: true // New accounts start in warmup
        };

        await this.sheetsService.addEmailAccount(newAccount);
        
        // Add to cache
        this.accountsCache.push(newAccount);

        console.log(`✅ Created new email account: ${newAccount.emailAddress}`);
        return newAccount;
      }
    } catch (error) {
      console.error('Error creating/updating email account:', error);
      throw error;
    }
  }
}

export const getEmailAccountManager = (): EmailAccountManager => {
  return EmailAccountManager.getInstance();
};