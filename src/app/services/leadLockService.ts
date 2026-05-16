// Lead-level concurrency control to prevent race conditions
export class LeadLockService {
  private static instance: LeadLockService;
  private leadLocks: Map<string, Promise<void>> = new Map();
  
  static getInstance(): LeadLockService {
    if (!LeadLockService.instance) {
      LeadLockService.instance = new LeadLockService();
    }
    return LeadLockService.instance;
  }
  
  /**
   * Execute an operation with exclusive lock on a lead
   * Prevents multiple concurrent updates to the same lead
   */
  async withLeadLock<T>(leadId: string, operation: () => Promise<T>): Promise<T> {
    // Wait for any existing operation on this lead to complete
    if (this.leadLocks.has(leadId)) {
      await this.leadLocks.get(leadId);
    }
    
    // Create a new promise for this operation
    let resolvePromise: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    
    // Store the lock
    this.leadLocks.set(leadId, lockPromise);
    
    try {
      // Execute the operation
      const result = await operation();
      return result;
    } finally {
      // Release the lock
      this.leadLocks.delete(leadId);
      resolvePromise!();
    }
  }
  
  /**
   * Check if a lead is currently locked
   */
  isLeadLocked(leadId: string): boolean {
    return this.leadLocks.has(leadId);
  }
  
  /**
   * Get count of currently locked leads
   */
  getLockedLeadsCount(): number {
    return this.leadLocks.size;
  }
  
  /**
   * Clear all locks (emergency use only)
   */
  clearAllLocks(): void {
    console.warn('🚨 Emergency: Clearing all lead locks');
    this.leadLocks.clear();
  }
}