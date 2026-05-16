import { EmailAccount } from '@/types';

export class EmailDelayManager {
  // Minimum delay between emails from same account (8 minutes in ms)
  private static readonly MIN_DELAY = 8 * 60 * 1000;
  
  // Maximum delay between emails from same account (12 minutes in ms)
  private static readonly MAX_DELAY = 12 * 60 * 1000;

  /**
   * Generate a random delay between 8-12 minutes
   */
  static generateRandomDelay(): number {
    const min = EmailDelayManager.MIN_DELAY;
    const max = EmailDelayManager.MAX_DELAY;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Check if enough time has passed since last email from this account
   */
  static canSendEmailNow(account: EmailAccount): boolean {
    if (!account.lastEmailSent) {
      return true; // No previous emails, can send immediately
    }

    const lastSent = new Date(account.lastEmailSent).getTime();
    const now = Date.now();
    const timeSinceLastEmail = now - lastSent;
    
    // Require at least 8 minutes between emails
    return timeSinceLastEmail >= EmailDelayManager.MIN_DELAY;
  }

  /**
   * Calculate how many milliseconds to wait before this account can send again
   */
  static getTimeUntilCanSend(account: EmailAccount): number {
    if (!account.lastEmailSent) {
      return 0; // Can send immediately
    }

    const lastSent = new Date(account.lastEmailSent).getTime();
    const now = Date.now();
    const timeSinceLastEmail = now - lastSent;
    
    if (timeSinceLastEmail >= EmailDelayManager.MIN_DELAY) {
      return 0; // Can send now
    }
    
    return EmailDelayManager.MIN_DELAY - timeSinceLastEmail;
  }

  /**
   * Get a human-readable string of how long to wait
   */
  static getWaitTimeString(account: EmailAccount): string {
    const waitTime = EmailDelayManager.getTimeUntilCanSend(account);
    
    if (waitTime === 0) {
      return 'Can send now';
    }
    
    const minutes = Math.ceil(waitTime / (60 * 1000));
    return `Wait ${minutes} minutes`;
  }

  /**
   * Sleep for the minimum required time for this account
   */
  static async waitUntilCanSend(account: EmailAccount): Promise<void> {
    const waitTime = EmailDelayManager.getTimeUntilCanSend(account);
    
    if (waitTime === 0) {
      return; // Can send immediately
    }
    
    const minutes = Math.ceil(waitTime / (60 * 1000));
    console.log(`⏱️ Account ${account.emailAddress} needs to wait ${minutes} minutes before next email...`);
    
    return new Promise(resolve => setTimeout(resolve, waitTime));
  }
}