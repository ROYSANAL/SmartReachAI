import { WorkflowProcessor } from '../app/services/workflowProcessor.js';
import { EmailWorkflowProcessor } from '../app/services/emailWorkflowProcessor.js';
import { RateLimiterService } from '../app/services/rateLimiter.js';
import { DelayManager } from '../app/services/delayManager.js';
import { TimeUtils } from '../app/utils/timeUtils.js';
import fs from 'fs-extra';
import path from 'path';
import moment from 'moment';
import 'dotenv/config';

class MainScheduler {
  private workflowProcessor: WorkflowProcessor;
  private emailWorkflowProcessor: EmailWorkflowProcessor;
  private rateLimiter: RateLimiterService;
  private isRunning: boolean = false;
  private emailIsRunning: boolean = false;
  private lastRunFile: string;
  private lastCleanupFile: string;
  private lastEmailRunFile: string;
  private shouldStop: boolean = false;
  private currentTimeout: NodeJS.Timeout | null = null;
  private currentEmailTimeout: NodeJS.Timeout | null = null;
  private activePromises: Set<Promise<void>> = new Set();

  constructor() {
    this.workflowProcessor = new WorkflowProcessor();
    this.emailWorkflowProcessor = new EmailWorkflowProcessor();
    this.rateLimiter = new RateLimiterService();
    this.lastRunFile = path.join(process.cwd(), 'data', 'last-run.json');
    this.lastCleanupFile = path.join(process.cwd(), 'data', 'last-cleanup.json');
    this.lastEmailRunFile = path.join(process.cwd(), 'data', 'last-email-run.json');
    this.ensureDataDirectory();
    this.setupGracefulShutdown();
  }

  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      console.log(`\n🛑 Received ${signal}. Gracefully shutting down...`);
      await this.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGUSR1', () => shutdown('SIGUSR1'));
    process.on('SIGUSR2', () => shutdown('SIGUSR2'));
    
    // Handle uncaught exceptions
    process.on('uncaughtException', async (error) => {
      console.error('💥 Uncaught Exception:', error);
      await this.stop();
      process.exit(1);
    });

    process.on('unhandledRejection', async (reason, promise) => {
      console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
      await this.stop();
      process.exit(1);
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('⚠️ Scheduler already running');
      return;
    }

    console.log('🚀 LinkedIn & Email Automation Scheduler started');
    console.log('📋 LinkedIn workflow: Every 6-11 minutes');
    console.log('📧 Email workflow: Every 15-25 minutes');
    console.log('📋 Press Ctrl+C for graceful shutdown');
    
    this.shouldStop = false;
    
    try {
      // Start both schedulers in parallel
      const linkedinPromise = this.runSchedulerLoop();
      const emailPromise = this.runEmailSchedulerLoop();
      
      // Wait for both to complete (they run indefinitely until stopped)
      await Promise.all([linkedinPromise, emailPromise]);
    } catch (error) {
      console.error('💥 Fatal scheduler error:', error);
      await this.stop();
      throw error;
    }
  }

  private async runSchedulerLoop(): Promise<void> {
    while (!this.shouldStop) {
      try {
        const cyclePromise = this.runCycle();
        this.activePromises.add(cyclePromise);
        
        await cyclePromise;
        
        this.activePromises.delete(cyclePromise);
        
        if (this.shouldStop) break;
        
        // Wait for random interval before next cycle
        const nextInterval = DelayManager.getRandomInterval();
        const minutes = Math.round(nextInterval / 1000 / 60);
        console.log(`⏰ Next LinkedIn cycle in ${minutes} minutes`);
        
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

  private async runEmailSchedulerLoop(): Promise<void> {
    while (!this.shouldStop) {
      try {
        const emailCyclePromise = this.runEmailCycle();
        this.activePromises.add(emailCyclePromise);
        
        await emailCyclePromise;
        
        this.activePromises.delete(emailCyclePromise);
        
        if (this.shouldStop) break;
        
        // Wait for random email interval before next cycle
        const nextInterval = DelayManager.getRandomEmailInterval();
        const minutes = Math.round(nextInterval / 1000 / 60);
        console.log(`📧 Next email cycle in ${minutes} minutes`);
        
        // Use interruptible delay
        await this.interruptibleEmailDelay(nextInterval);
        
      } catch (error) {
        if (this.shouldStop) break;
        
        console.error('❌ Error in email scheduler cycle:', error);
        
        // Wait 10 minutes before retrying on error (interruptible)
        console.log('🔄 Retrying email cycle in 10 minutes...');
        await this.interruptibleEmailDelay(10 * 60 * 1000);
      }
    }
    
    console.log('✅ Email scheduler loop ended gracefully');
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

  private async interruptibleEmailDelay(ms: number): Promise<void> {
    if (this.shouldStop) return;
    
    return new Promise((resolve) => {
      this.currentEmailTimeout = setTimeout(() => {
        this.currentEmailTimeout = null;
        resolve();
      }, ms);
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning && this.activePromises.size === 0) {
      console.log('✅ Scheduler already stopped');
      return;
    }

    console.log('🛑 Stopping scheduler...');
    this.shouldStop = true;
    
    // Clear any pending timeouts
    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout);
      this.currentTimeout = null;
    }
    
    if (this.currentEmailTimeout) {
      clearTimeout(this.currentEmailTimeout);
      this.currentEmailTimeout = null;
    }

    // Wait for active operations to complete (with timeout)
    if (this.activePromises.size > 0) {
      console.log(`⏳ Waiting for ${this.activePromises.size} active operations to complete...`);
      
      try {
        await Promise.race([
          Promise.allSettled(Array.from(this.activePromises)),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Shutdown timeout')), 30000)
          )
        ]);
      } catch (error) {
        console.warn('⚠️ Forced shutdown due to timeout');
      }
    }

    // Clear the promises set
    this.activePromises.clear();
    
    console.log('✅ Scheduler stopped gracefully');
  }

  private async runCycle(): Promise<void> {
    if (this.isRunning) {
      console.log('Previous cycle still running, skipping...');
      return;
    }

    if (!TimeUtils.isWorkingHours()) {
      console.log('Outside working hours, waiting...');
      return;
    }

    this.isRunning = true;
    console.log(`\n=== Starting smart automation cycle at ${new Date().toISOString()} ===`);

    try {
      // ✅ UPDATE TIMESTAMP AT START: Record when scheduler begins processing
      await this.updateLastRun();
      console.log('📝 Updated last-run timestamp at cycle start');

      // Check if it's a new day and reset counters
      await this.checkAndResetDailyCounters();

      // Run periodic cleanup once per hour
      await this.runPeriodicCleanup();

      // Run smart cycle instead of individual workflow steps
      await this.workflowProcessor.runSmartCycle();

      console.log('=== Smart cycle completed successfully ===\n');
    } catch (error) {
      console.error('Error in smart workflow cycle:', error);
    } finally {
      this.isRunning = false;
    }
  }

  private async runEmailCycle(): Promise<void> {
    if (this.emailIsRunning) {
      console.log('Previous email cycle still running, skipping...');
      return;
    }

    if (!TimeUtils.isWorkingHours()) {
      console.log('Outside working hours, skipping email cycle...');
      return;
    }

    this.emailIsRunning = true;
    console.log(`\n📧 === Starting email automation cycle at ${new Date().toISOString()} ===`);

    try {
      // Update email run timestamp
      await this.updateLastEmailRun();
      console.log('📝 Updated last-email-run timestamp at cycle start');

      // Process email workflow (includes retry processing internally)
      await this.emailWorkflowProcessor.processEmailWorkflow();

      console.log('📧 === Email cycle completed successfully ===\n');
    } catch (error) {
      console.error('Error in email workflow cycle:', error);
    } finally {
      this.emailIsRunning = false;
    }
  }

  private async checkAndResetDailyCounters(): Promise<void> {
    try {
      const lastRun = await this.getLastRun();
      
      if (TimeUtils.isNewDay(lastRun.timestamp)) {
        console.log('New day detected, resetting daily counters for all accounts');
       // await this.rateLimiter.resetDailyCounters();
        await this.rateLimiter.resetAllAccountCounters();
      }
    } catch (error) {
      console.error('Error checking daily counters:', error);
    }
  }

  private async runPeriodicCleanup(): Promise<void> {
    try {
      const lastCleanup = await this.getLastCleanup();
      const hoursPassed = moment().diff(moment(lastCleanup.timestamp), 'hours');
      
      if (hoursPassed >= 1) {
        console.log('🧹 Running periodic data cleanup...');
        await this.workflowProcessor.handleManualStatusChanges();
        await this.updateLastCleanup();
      }
    } catch (error) {
      console.error('Error in periodic cleanup:', error);
    }
  }

  private async getLastRun(): Promise<{ timestamp: string }> {
    try {
      await fs.ensureFile(this.lastRunFile);
      const data = await fs.readJson(this.lastRunFile).catch(() => ({}));
      return { timestamp: data.timestamp || new Date().toISOString() };
    } catch (_error) {
      return { timestamp: new Date().toISOString() };
    }
  }

  private async getLastCleanup(): Promise<{ timestamp: string }> {
    try {
      await fs.ensureFile(this.lastCleanupFile);
      const data = await fs.readJson(this.lastCleanupFile).catch(() => ({}));
      return { timestamp: data.timestamp || new Date().toISOString() };
    } catch (_error) {
      return { timestamp: new Date().toISOString() };
    }
  }

  private async getLastEmailRun(): Promise<{ timestamp: string }> {
    try {
      await fs.ensureFile(this.lastEmailRunFile);
      const data = await fs.readJson(this.lastEmailRunFile).catch(() => ({}));
      return { timestamp: data.timestamp || new Date().toISOString() };
    } catch (_error) {
      return { timestamp: new Date().toISOString() };
    }
  }

  private async updateLastRun(): Promise<void> {
    try {
      await fs.writeJson(this.lastRunFile, {
        timestamp: new Date().toISOString()
      }, { spaces: 2 });
    } catch (error) {
      console.error('Error updating last run timestamp:', error);
    }
  }

  private async updateLastCleanup(): Promise<void> {
    try {
      await fs.writeJson(this.lastCleanupFile, {
        timestamp: new Date().toISOString()
      }, { spaces: 2 });
    } catch (error) {
      console.error('Error updating last cleanup timestamp:', error);
    }
  }

  private async updateLastEmailRun(): Promise<void> {
    try {
      await fs.writeJson(this.lastEmailRunFile, {
        timestamp: new Date().toISOString()
      }, { spaces: 2 });
    } catch (error) {
      console.error('Error updating last email run timestamp:', error);
    }
  }

  private ensureDataDirectory(): void {
    const dataDir = path.join(process.cwd(), 'data');
    fs.ensureDirSync(dataDir);
  }
}

// // Entry point for scheduler
// if (require.main === module) {
//   const scheduler = new MainScheduler();
//   scheduler.start().catch(console.error);
// }
// Entry point for scheduler - ES module compatible
if (import.meta.url === `file://${process.argv[1]}`) {
  const scheduler = new MainScheduler();
  scheduler.start().catch(console.error);
}

export default MainScheduler;