import { EmailWorkflowProcessor } from '../app/services/emailWorkflowProcessor.js';
import { DelayManager } from '../app/services/delayManager.js';
import { TimeUtils } from '../app/utils/timeUtils.js';
import { SchedulerStatusService } from '../app/services/schedulerStatusService.js';
import 'dotenv/config';

class EmailScheduler {
  private emailWorkflowProcessor: EmailWorkflowProcessor;
  private statusService: SchedulerStatusService;
  private isRunning: boolean = false;
  private shouldStop: boolean = false;
  private currentTimeout: NodeJS.Timeout | null = null;
  private activePromises: Set<Promise<void>> = new Set();

  constructor() {
    this.emailWorkflowProcessor = new EmailWorkflowProcessor();
    this.statusService = new SchedulerStatusService();
    this.setupGracefulShutdown();
  }

  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      console.log(`\n🛑 Email Scheduler received ${signal}. Gracefully shutting down...`);
      await this.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGUSR1', () => shutdown('SIGUSR1'));
    process.on('SIGUSR2', () => shutdown('SIGUSR2'));
    
    process.on('uncaughtException', async (error) => {
      console.error('💥 Email Scheduler - Uncaught Exception:', error);
      await this.stop();
      process.exit(1);
    });

    process.on('unhandledRejection', async (reason, promise) => {
      console.error('💥 Email Scheduler - Unhandled Rejection at:', promise, 'reason:', reason);
      await this.stop();
      process.exit(1);
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('⚠️ Email Scheduler already running');
      return;
    }

    console.log('🚀 📧 Email Outreach Scheduler Started');
    console.log('📧 Email workflow: Every 15-25 minutes');
    console.log('⏰ Working hours: Respecting configured time limits');
    console.log('📋 Press Ctrl+C for graceful shutdown');
    console.log('═'.repeat(60));
    
    // Initialize Google Sheets status tracking
    await this.statusService.initializeSheet();
    console.log('📊 Google Sheets status tracking initialized');
    
    this.shouldStop = false;
    
    try {
      await this.runEmailSchedulerLoop();
    } catch (error) {
      console.error('💥 Fatal email scheduler error:', error);
      await this.stop();
      throw error;
    }
  }

  private async runEmailSchedulerLoop(): Promise<void> {
    while (!this.shouldStop) {
      try {
        const emailCyclePromise = this.runEmailCycle();
        this.activePromises.add(emailCyclePromise);
        
        try {
          await emailCyclePromise;
        } finally {
          this.activePromises.delete(emailCyclePromise);
        }
        
        if (this.shouldStop) break;
        
        // Wait for random email interval before next cycle
        const nextInterval = DelayManager.getRandomEmailInterval();
        const minutes = Math.round(nextInterval / 1000 / 60);
        console.log(`📧 ⏰ Next email cycle in ${minutes} minutes`);
        
        // Use interruptible delay
        await this.interruptibleDelay(nextInterval);
        
      } catch (error) {
        if (this.shouldStop) break;
        
        console.error('❌ Error in email scheduler cycle:', error);
        
        // Wait 10 minutes before retrying on error (interruptible)
        console.log('🔄 Retrying email cycle in 10 minutes...');
        await this.interruptibleDelay(10 * 60 * 1000);
      }
    }
    
    console.log('✅ Email scheduler loop ended gracefully');
  }

  private async runEmailCycle(): Promise<void> {
    if (this.isRunning) {
      console.log('📧 Previous email cycle still running, skipping...');
      return;
    }

    if (!TimeUtils.isWorkingHours()) {
      console.log('📧 🕐 Outside working hours, skipping email cycle...');
      return;
    }

    this.isRunning = true;
    console.log(`\n📧 ═══ Starting Email Automation Cycle ═══`);
    console.log(`📧 🕐 Time: ${new Date().toISOString()}`);

    try {
      // Update email run timestamp in Google Sheets
      await this.updateSchedulerStatus('email', 'running');
      console.log('📧 📝 Updated email scheduler status in Google Sheets');

      // Process email workflow (includes retry processing internally)
      await this.emailWorkflowProcessor.processEmailWorkflow();

      // Update completion status
      await this.updateSchedulerStatus('email', 'completed');
      
      console.log('📧 ✅ Email cycle completed successfully');
      console.log(`📧 ${'═'.repeat(50)}\n`);
    } catch (error) {
      // Update error status with error message
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.updateSchedulerStatus('email', 'error', errorMessage);
      console.error('📧 ❌ Error in email workflow cycle:', error);
    } finally {
      this.isRunning = false;
    }
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
      console.log('✅ Email scheduler already stopped');
      return;
    }

    console.log('🛑 Stopping email scheduler...');
    this.shouldStop = true;
    
    // Clear any pending timeout
    if (this.currentTimeout) {
      clearTimeout(this.currentTimeout);
      this.currentTimeout = null;
    }

    // Wait for active operations to complete (with timeout)
    if (this.activePromises.size > 0) {
      console.log(`⏳ Waiting for ${this.activePromises.size} email operations to complete...`);
      
      try {
        await Promise.race([
          Promise.allSettled(Array.from(this.activePromises)),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Email scheduler shutdown timeout')), 30000)
          )
        ]);
      } catch (error) {
        console.warn('⚠️ Forced email scheduler shutdown due to timeout');
      }
    }

    // Clear the promises set
    this.activePromises.clear();
    
    // Update status to stopped
    await this.updateSchedulerStatus('email', 'stopped');
    
    console.log('✅ Email scheduler stopped gracefully');
  }

  private async updateSchedulerStatus(schedulerType: 'email' | 'linkedin', status: 'running' | 'completed' | 'error' | 'stopped', errorMessage?: string): Promise<void> {
    try {
      // Update status in Google Sheets
      await this.statusService.updateStatus(schedulerType, status, errorMessage);
    } catch (error) {
      console.error('Error updating scheduler status:', error);
      // Fallback to console logging if Google Sheets fails
      console.log(`📧 📊 ${schedulerType} scheduler: ${status} at ${new Date().toISOString()}`);
    }
  }
}

// Entry point for email scheduler
if (import.meta.url === `file://${process.argv[1]}`) {
  const scheduler = new EmailScheduler();
  scheduler.start().catch(console.error);
}

export default EmailScheduler;