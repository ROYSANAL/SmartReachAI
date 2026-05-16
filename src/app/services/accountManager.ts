import { CONFIG } from '../../config/config';

export interface LinkedInAccount {
  name: string;
  unipileAccountId: string;
  dailyLimits: {
    POSTS_LIKED: number;
    POSTS_COMMENTED: number;
    INVITATIONS_SENT: number;
    MESSAGES_SENT: number;
  };
  active: boolean;
  priority: number;
}

export interface AccountCounters {
  unipileAccountId: string;
  date: string;
  postsLiked: number;
  postsCommented: number;
  invitationsSent: number;
  messagesSent: number;
}

export class AccountManager {
  private accounts: Map<string, LinkedInAccount> = new Map();
  private currentAccountIndex: number = 0;

  constructor() {
    this.initializeAccounts();
  }

  private initializeAccounts(): void {
    const accountsConfig = CONFIG.LINKEDIN_ACCOUNTS as LinkedInAccount[];
    
    accountsConfig.forEach(account => {
      if (account.active && account.unipileAccountId) {
        this.accounts.set(account.unipileAccountId, account);
        console.log(`✅ Initialized LinkedIn account: ${account.name} (${account.unipileAccountId})`);
      }
    });

    if (this.accounts.size === 0) {
      throw new Error('No active LinkedIn accounts configured');
    }

    console.log(`📊 Total active LinkedIn accounts: ${this.accounts.size}`);
  }

  /**
   * Assign a LinkedIn account to a new lead using round-robin strategy
   */
  assignAccountToLead(): string {
    const activeAccounts = Array.from(this.accounts.values())
      .filter(account => account.active)
      .sort((a, b) => a.priority - b.priority); // Sort by priority

    if (activeAccounts.length === 0) {
      throw new Error('No active LinkedIn accounts available');
    }

    // Round-robin assignment
    const assignedAccount = activeAccounts[this.currentAccountIndex % activeAccounts.length];
    this.currentAccountIndex++;

    console.log(` ${assignedAccount.name} (${assignedAccount.unipileAccountId})`);
    return assignedAccount.unipileAccountId;
  }

  /**
   * Get account configuration by unipileAccountId
   */
  getAccount(unipileAccountId: string): LinkedInAccount | null {
    return this.accounts.get(unipileAccountId) || null;
  }


  /**
   * Get all active accounts
   */
  getActiveAccounts(): LinkedInAccount[] {
    return Array.from(this.accounts.values()).filter(account => account.active);
  }

  /**
   * Get account daily limits
   */
  getAccountLimits(unipileAccountId: string): LinkedInAccount['dailyLimits'] {
    const account = this.accounts.get(unipileAccountId);
    if (!account) {
      throw new Error(`LinkedIn account not found: ${unipileAccountId}`);
    }
    return account.dailyLimits;
  }

  /**
   * Check if account is active and available
   */
  isAccountActive(unipileAccountId: string): boolean {
    const account = this.accounts.get(unipileAccountId);
    return account ? account.active : false;
  }

  /**
   * Get account display name
   */
  getAccountName(unipileAccountId: string): string {
    const account = this.accounts.get(unipileAccountId);
    return account ? account.name : `Unknown Account (${unipileAccountId})`;
  }

  /**
   * Get total number of active accounts
   */
  getAccountCount(): number {
    return Array.from(this.accounts.values()).filter(account => account.active).length;
  }
}

// Singleton instance
let accountManagerInstance: AccountManager | null = null;

export function getAccountManager(): AccountManager {
  if (!accountManagerInstance) {
    accountManagerInstance = new AccountManager();
  }
  return accountManagerInstance;
}