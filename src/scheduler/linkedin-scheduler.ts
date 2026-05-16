import { WorkflowProcessor } from '../app/services/workflowProcessor.js';
import { RateLimiterService } from '../app/services/rateLimiter.js';
import { DelayManager } from '../app/services/delayManager.js';
import { TimeUtils } from '../app/utils/timeUtils.js';
import { SchedulerStatusService } from '../app/services/schedulerStatusService.js';
import moment from 'moment';
import 'dotenv/config';

class LinkedInScheduler {
  private workflowProcessor: WorkflowProcessor;
  private rateLimiter: RateLimiterService;
  private statusService: SchedulerStatusService;
  private isRunning: boolean = false;
  private lastCleanupTime: string = new Date().toISOString();
  private shouldStop: boolean = false;
  private currentTimeout: NodeJS.Timeout | null = null;
  private activePromises: Set<Promise<void>> = new Set();

  constructor() {
    this.workflowProcessor = new WorkflowProcessor();
    this.rateLimiter = new RateLimiterService();
    this.statusService = new SchedulerStatusService();
    this.setupGracefulShutdown();
  }

  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      console.log(`\n🛑 LinkedIn Scheduler received ${signal}. Gracefully shutting down...`);
      await this.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGUSR1', () => shutdown('SIGUSR1'));
    process.on('SIGUSR2', () => shutdown('SIGUSR2'));
    
    process.on('uncaughtException', async (error) => {
      console.error('💥 LinkedIn Scheduler - Uncaught Exception:', error);
      await this.stop();
      process.exit(1);
    });

    process.on('unhandledRejection', async (reason, promise) => {
      console.error('💥 LinkedIn Scheduler - Unhandled Rejection at:', promise, 'reason:', reason);
      await this.stop();
      process.exit(1);
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('⚠️ LinkedIn Scheduler already running');
      return;
    }

    console.log('🚀 📋 LinkedIn Outreach Scheduler Started');
    console.log('📋 LinkedIn workflow: Every 6-11 minutes');
    console.log('⏰ Working hours: Respecting configured time limits');
    console.log('🎯 Features: Lead enrichment, post interactions, invitations, messaging');
    console.log('📋 Press Ctrl+C for graceful shutdown');
    console.log('═'.repeat(60));
    
    // Initialize Google Sheets status tracking
    await this.statusService.initializeSheet();
    console.log('📊 Google Sheets status tracking initialized');
    
    this.shouldStop = false;
    
    try {
      await this.runSchedulerLoop();
    } catch (error) {
      console.error('💥 Fatal LinkedIn scheduler error:', error);
      await this.stop();
      throw error;
    }
  }

  private async runSchedulerLoop(): Promise<void> {
    while (!this.shouldStop) {
      try {
        const cyclePromise = this.runCycle();
        this.activePromises.add(cyclePromise);
        
        try {
          await cyclePromise;
        } finally {
          this.activePromises.delete(cyclePromise);
        }
        
        if (this.shouldStop) break;
        
        // Wait for random interval before next cycle
        const nextInterval = DelayManager.getRandomInterval();
        const minutes = Math.round(nextInterval / 1000 / 60);
        console.log(`📋 ⏰ Next LinkedIn cycle in ${minutes} minutes`);
        
        // Use interruptible delay
        await this.interruptibleDelay(nextInterval);
        
      } catch (error) {
        if (this.shouldStop) break;
        
        console.error('❌ Error in LinkedIn scheduler cycle:', error);
        
        // Wait 5 minutes before retrying on error (interruptible)
        console.log('🔄 Retrying LinkedIn cycle in 5 minutes...');
        await this.interruptibleDelay(5 * 60 * 1000);
      }
    }
    
    console.log('✅ LinkedIn scheduler loop ended gracefully');
  }

  private async interruptibleDelay(ms: number): Promise<void> {
    if (this.shouldStop) return;
    
    return new Promise((resolve) => {
      this.currentTimeout = setTimeout(() => {
        this.currentTimeout = null;
        resolve();
      }, ms);
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning && this.activePromises.size === 0) {
      console.log('✅ LinkedIn scheduler already stopped');
      return;
    }

    console.log('🛑 Stopping LinkedIn scheduler...');
    this.shouldStop = true;
    
    // Clear any pending timeout
    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout);
      this.currentTimeout = null;
    }

    // Wait for active operations to complete (with timeout)
    if (this.activePromises.size > 0) {
      console.log(`⏳ Waiting for ${this.activePromises.size} LinkedIn operations to complete...`);
      
      try {
        await Promise.race([
          Promise.allSettled(Array.from(this.activePromises)),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('LinkedIn scheduler shutdown timeout')), 30000)
          )
        ]);
      } catch (error) {
        console.warn('⚠️ Forced LinkedIn scheduler shutdown due to timeout');
      }
    }

    // Clear the promises set
    this.activePromises.clear();
    
    // Update status to stopped
    await this.updateSchedulerStatus('linkedin', 'stopped');
    
    console.log('✅ LinkedIn scheduler stopped gracefully');
  }

  private async runCycle(): Promise<void> {
    if (this.isRunning) {
      console.log('📋 Previous LinkedIn cycle still running, skipping...');
      return;
    }

    if (!TimeUtils.isWorkingHours()) {
      console.log('📋 🕐 Outside working hours, waiting...');
      return;
    }

    this.isRunning = true;
    console.log(`\n📋 ═══ Starting LinkedIn Automation Cycle ═══`);
    console.log(`📋 🕐 Time: ${new Date().toISOString()}`);

    try {
      // Update scheduler status
      await this.updateSchedulerStatus('linkedin', 'running');
      console.log('📋 📝 Updated LinkedIn scheduler status');

      // Check if it's a new day and reset counters
      await this.checkAndResetDailyCounters();

      // Run periodic cleanup once per hour
      await this.runPeriodicCleanup();

      // Run smart cycle instead of individual workflow steps
      await this.workflowProcessor.runSmartCycle();

      // Update completion status
      await this.updateSchedulerStatus('linkedin', 'completed');
      
      console.log('📋 ✅ LinkedIn cycle completed successfully');
      console.log(`📋 ${'═'.repeat(50)}\n`);
    } catch (error) {
      // Update error status with error message
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.updateSchedulerStatus('linkedin', 'error', errorMessage);
      console.error('📋 ❌ Error in LinkedIn workflow cycle:', error);
    } finally {
      this.isRunning = false;
    }
  }

  private async checkAndResetDailyCounters(): Promise<void> {
    try {
      // Simple daily reset check - reset at midnight
      const now = new Date();
      const hour = now.getHours();
      const minute = now.getMinutes();
      
      // Reset counters if it's between 12:00 AM and 12:30 AM
      if (hour === 0 && minute < 30) {
        console.log('📋 🗓️ New day detected, resetting daily counters for all accounts');
        await this.rateLimiter.resetAllAccountCounters();
      }
    } catch (error) {
      console.error('📋 ❌ Error checking daily counters:', error);
    }
  }

  private async runPeriodicCleanup(): Promise<void> {
    try {
      const hoursPassed = moment().diff(moment(this.lastCleanupTime), 'hours');
      
      if (hoursPassed >= 1) {
        console.log('📋 🧹 Running periodic data cleanup...');
        await this.workflowProcessor.handleManualStatusChanges();
        this.lastCleanupTime = new Date().toISOString();
      }
    } catch (error) {
      console.error('📋 ❌ Error in periodic cleanup:', error);
    }
  }

  private async updateSchedulerStatus(schedulerType: 'email' | 'linkedin', status: 'running' | 'completed' | 'error' | 'stopped', errorMessage?: string): Promise<void> {
    try {
      // Update status in Google Sheets
      await this.statusService.updateStatus(schedulerType, status, errorMessage);
    } catch (error) {
      console.error('Error updating scheduler status:', error);
      // Fallback to console logging if Google Sheets fails
      console.log(`📋 📊 ${schedulerType} scheduler: ${status} at ${new Date().toISOString()}`);
    }
  }
}

// Entry point for LinkedIn scheduler
if (import.meta.url === `file://${process.argv[1]}`) {
  const scheduler = new LinkedInScheduler();
  scheduler.start().catch(console.error);
}

export default LinkedInScheduler;