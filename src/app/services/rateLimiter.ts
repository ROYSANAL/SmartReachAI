import { DailyCounters, AccountCounters } from '@/types';
import { CONFIG } from '../../config/config';
import { GoogleSheetsService } from './googleSheets';
import { getAccountManager } from './accountManager';
import moment from 'moment';

export class RateLimiterService {
  private sheetsService: GoogleSheetsService;
  private accountManager = getAccountManager();
  private pendingOperations: Map<string, Promise<void>> = new Map();

  constructor() {
    this.sheetsService = new GoogleSheetsService();
  }

  async canPerformAction(actionType: keyof DailyCounters): Promise<boolean> {
    if (actionType === 'date') return false;

    const today = moment().format('YYYY-MM-DD');
    const counters = await this.getDailyCounters(today);
    const limits = CONFIG.DAILY_LIMITS;

    switch (actionType) {
      case 'postsLiked':
        return counters.postsLiked < limits.POSTS_LIKED;
      case 'postsCommented':
        return counters.postsCommented < limits.POSTS_COMMENTED;
      case 'invitationsSent':
        return counters.invitationsSent < limits.INVITATIONS_SENT;
      case 'messagesSent':
        return counters.messagesSent < limits.MESSAGES_SENT;
      default:
        return false;
    }
  }


  /**
   * Record a successful action - only increments counter after operation succeeds
   */
  async recordSuccessfulAction(actionType: keyof DailyCounters): Promise<void> {
    if (actionType === 'date') return;

    const today = moment().format('YYYY-MM-DD');
    const operationKey = `${today}-${actionType}`;

    // Prevent concurrent operations for same action type on same day
    if (this.pendingOperations.has(operationKey)) {
      await this.pendingOperations.get(operationKey);
    }

    const operation = this.atomicIncrement(today, actionType);
    this.pendingOperations.set(operationKey, operation);

    try {
      await operation;
    } finally {
      this.pendingOperations.delete(operationKey);
    }
  }

  private async atomicIncrement(date: string, actionType: keyof DailyCounters): Promise<void> {
    try {
      // Get current counters
      const counters = await this.getDailyCounters(date);
      const limits = CONFIG.DAILY_LIMITS;

      let currentValue: number;
      let limit: number;

      switch (actionType) {
        case 'postsLiked':
          currentValue = counters.postsLiked;
          limit = limits.POSTS_LIKED;
          break;
        case 'postsCommented':
          currentValue = counters.postsCommented;
          limit = limits.POSTS_COMMENTED;
          break;
        case 'invitationsSent':
          currentValue = counters.invitationsSent;
          limit = limits.INVITATIONS_SENT;
          break;
        case 'messagesSent':
          currentValue = counters.messagesSent;
          limit = limits.MESSAGES_SENT;
          break;
        default:
          return;
      }

      // Increment the counter
      counters[actionType] = (currentValue + 1) as number;
      await this.sheetsService.updateDailyCounters(counters);
      
      console.log(`✅ Recorded successful ${actionType}: ${counters[actionType]}/${limit}`);

    } catch (error) {
      console.error(`❌ Error recording successful ${actionType}:`, error);
      throw error;
    }
  }

  async getDailyCounters(date: string): Promise<DailyCounters> {
    // Delegate to GoogleSheetsService
    return await this.sheetsService.getDailyCounters(date);
  }

  /**
   * Get current rate limit status for monitoring
   */
  async getRateLimitStatus(date?: string): Promise<{
    date: string;
    counters: DailyCounters;
    limits: Record<keyof Omit<DailyCounters, 'date'>, number>;
    remaining: Record<keyof Omit<DailyCounters, 'date'>, number>;
    percentUsed: Record<keyof Omit<DailyCounters, 'date'>, number>;
  }> {
    const targetDate = date || moment().format('YYYY-MM-DD');
    const counters = await this.getDailyCounters(targetDate);
    const limits = CONFIG.DAILY_LIMITS;

    const remaining = {
      postsLiked: Math.max(0, limits.POSTS_LIKED - counters.postsLiked),
      postsCommented: Math.max(0, limits.POSTS_COMMENTED - counters.postsCommented),
      invitationsSent: Math.max(0, limits.INVITATIONS_SENT - counters.invitationsSent),
      messagesSent: Math.max(0, limits.MESSAGES_SENT - counters.messagesSent)
    };

    const percentUsed = {
      postsLiked: Math.round((counters.postsLiked / limits.POSTS_LIKED) * 100),
      postsCommented: Math.round((counters.postsCommented / limits.POSTS_COMMENTED) * 100),
      invitationsSent: Math.round((counters.invitationsSent / limits.INVITATIONS_SENT) * 100),
      messagesSent: Math.round((counters.messagesSent / limits.MESSAGES_SENT) * 100)
    };

    return {
      date: targetDate,
      counters,
      limits: {
        postsLiked: limits.POSTS_LIKED,
        postsCommented: limits.POSTS_COMMENTED,
        invitationsSent: limits.INVITATIONS_SENT,
        messagesSent: limits.MESSAGES_SENT
      },
      remaining,
      percentUsed
    };
  }

  /**
   * Log current rate limit status
   */
  async logRateLimitStatus(): Promise<void> {
    try {
      const status = await this.getRateLimitStatus();
      
      console.log(`📊 Rate Limit Status for ${status.date}:`);
      console.log(`   👍 Posts Liked: ${status.counters.postsLiked}/${status.limits.postsLiked} (${status.percentUsed.postsLiked}%) - ${status.remaining.postsLiked} remaining`);
      console.log(`   💬 Posts Commented: ${status.counters.postsCommented}/${status.limits.postsCommented} (${status.percentUsed.postsCommented}%) - ${status.remaining.postsCommented} remaining`);
      console.log(`   🤝 Invitations Sent: ${status.counters.invitationsSent}/${status.limits.invitationsSent} (${status.percentUsed.invitationsSent}%) - ${status.remaining.invitationsSent} remaining`);
      console.log(`   💌 Messages Sent: ${status.counters.messagesSent}/${status.limits.messagesSent} (${status.percentUsed.messagesSent}%) - ${status.remaining.messagesSent} remaining`);

    } catch (error) {
      console.error('❌ Error getting rate limit status:', error);
    }
  }

  // Account-specific rate limiting methods
  async canPerformActionForAccount(unipileAccountId: string, actionType: keyof Omit<AccountCounters, 'unipileAccountId' | 'date'>): Promise<boolean> {
    const today = moment().format('YYYY-MM-DD');
    const counters = await this.getAccountCounters(unipileAccountId, today);
    const limits = this.accountManager.getAccountLimits(unipileAccountId);

    switch (actionType) {
      case 'postsLiked':
        return counters.postsLiked < limits.POSTS_LIKED;
      case 'postsCommented':
        return counters.postsCommented < limits.POSTS_COMMENTED;
      case 'invitationsSent':
        return counters.invitationsSent < limits.INVITATIONS_SENT;
      case 'messagesSent':
        return counters.messagesSent < limits.MESSAGES_SENT;
      default:
        return false;
    }
  }

  async recordSuccessfulActionForAccount(unipileAccountId: string, actionType: keyof Omit<AccountCounters, 'unipileAccountId' | 'date'>): Promise<void> {
    const today = moment().format('YYYY-MM-DD');
    const operationKey = `${unipileAccountId}-${today}-${actionType}`;

    // Prevent concurrent operations for same account/action/day
    if (this.pendingOperations.has(operationKey)) {
      await this.pendingOperations.get(operationKey);
    }

    const operation = this.atomicIncrementForAccount(unipileAccountId, today, actionType);
    this.pendingOperations.set(operationKey, operation);

    try {
      await operation;
    } finally {
      this.pendingOperations.delete(operationKey);
    }
  }

  private async atomicIncrementForAccount(unipileAccountId: string, date: string, actionType: keyof Omit<AccountCounters, 'unipileAccountId' | 'date'>): Promise<void> {
    try {
      // Get current counters for this account
      const counters = await this.getAccountCounters(unipileAccountId, date);
      const limits = this.accountManager.getAccountLimits(unipileAccountId);

      let currentValue: number;
      let limit: number;

      switch (actionType) {
        case 'postsLiked':
          currentValue = counters.postsLiked;
          limit = limits.POSTS_LIKED;
          break;
        case 'postsCommented':
          currentValue = counters.postsCommented;
          limit = limits.POSTS_COMMENTED;
          break;
        case 'invitationsSent':
          currentValue = counters.invitationsSent;
          limit = limits.INVITATIONS_SENT;
          break;
        case 'messagesSent':
          currentValue = counters.messagesSent;
          limit = limits.MESSAGES_SENT;
          break;
        default:
          return;
      }

      // Increment the counter
      counters[actionType] = (currentValue + 1) as number;
      await this.sheetsService.updateAccountCounters(counters);
      
      const accountName = this.accountManager.getAccountName(unipileAccountId);
      console.log(`✅ Recorded successful ${actionType} for ${accountName}: ${counters[actionType]}/${limit}`);

    } catch (error) {
      console.error(`❌ Error recording successful ${actionType} for account ${unipileAccountId}:`, error);
      throw error;
    }
  }

  async getAccountCounters(unipileAccountId: string, date: string): Promise<AccountCounters> {
    return await this.sheetsService.getAccountCounters(unipileAccountId, date);
  }

  async resetAccountCounters(unipileAccountId: string): Promise<void> {
    const today = moment().format('YYYY-MM-DD');
    const resetCounters: AccountCounters = {
      unipileAccountId,
      date: today,
      postsLiked: 0,
      postsCommented: 0,
      invitationsSent: 0,
      messagesSent: 0
    };
    
    await this.sheetsService.updateAccountCounters(resetCounters);
    const accountName = this.accountManager.getAccountName(unipileAccountId);
    console.log(`🔄 Daily counters reset for ${accountName}`);
  }

  async resetAllAccountCounters(): Promise<void> {
    const activeAccounts = this.accountManager.getActiveAccounts();
    
    for (const account of activeAccounts) {
      await this.resetAccountCounters(account.unipileAccountId);
    }
    
    console.log(`🔄 Daily counters reset for all ${activeAccounts.length} active accounts`);
  }

  async logAccountRateLimitStatus(unipileAccountId: string): Promise<void> {
    try {
      const today = moment().format('YYYY-MM-DD');
      const counters = await this.getAccountCounters(unipileAccountId, today);
      const limits = this.accountManager.getAccountLimits(unipileAccountId);
      const accountName = this.accountManager.getAccountName(unipileAccountId);

      const remaining = {
        postsLiked: Math.max(0, limits.POSTS_LIKED - counters.postsLiked),
        postsCommented: Math.max(0, limits.POSTS_COMMENTED - counters.postsCommented),
        invitationsSent: Math.max(0, limits.INVITATIONS_SENT - counters.invitationsSent),
        messagesSent: Math.max(0, limits.MESSAGES_SENT - counters.messagesSent)
      };

      const percentUsed = {
        postsLiked: Math.round((counters.postsLiked / limits.POSTS_LIKED) * 100),
        postsCommented: Math.round((counters.postsCommented / limits.POSTS_COMMENTED) * 100),
        invitationsSent: Math.round((counters.invitationsSent / limits.INVITATIONS_SENT) * 100),
        messagesSent: Math.round((counters.messagesSent / limits.MESSAGES_SENT) * 100)
      };

      console.log(`📊 Rate Limit Status for ${accountName} (${today}):`);
      console.log(`   👍 Posts Liked: ${counters.postsLiked}/${limits.POSTS_LIKED} (${percentUsed.postsLiked}%) - ${remaining.postsLiked} remaining`);
      console.log(`   💬 Posts Commented: ${counters.postsCommented}/${limits.POSTS_COMMENTED} (${percentUsed.postsCommented}%) - ${remaining.postsCommented} remaining`);
      console.log(`   🤝 Invitations Sent: ${counters.invitationsSent}/${limits.INVITATIONS_SENT} (${percentUsed.invitationsSent}%) - ${remaining.invitationsSent} remaining`);
      console.log(`   💌 Messages Sent: ${counters.messagesSent}/${limits.MESSAGES_SENT} (${percentUsed.messagesSent}%) - ${remaining.messagesSent} remaining`);

    } catch (error) {
      console.error(`❌ Error getting rate limit status for account ${unipileAccountId}:`, error);
    }
  }
}