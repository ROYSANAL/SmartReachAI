import { GoogleSheetsService } from './googleSheets.js';
import { CONFIG } from '../../config/config.js';

export interface SchedulerStatus {
  schedulerType: 'linkedin' | 'email';
  status: 'running' | 'completed' | 'error' | 'stopped';
  lastRun: string;
  cycleCount: number;
  lastError: string;
}

export class SchedulerStatusService {
  private sheetsService: GoogleSheetsService;
  private range: string;

  constructor() {
    this.sheetsService = new GoogleSheetsService();
    this.range = CONFIG.SHEETS.RANGES.SCHEDULER_STATUS;
  }

  /**
   * Update scheduler status in Google Sheets
   */
  async updateStatus(schedulerType: 'linkedin' | 'email', status: 'running' | 'completed' | 'error' | 'stopped', errorMessage?: string): Promise<void> {
    try {
      // Get current data
      const currentData = await this.getAllStatuses();
      
      // Find existing row for this scheduler type
      const existingStatus = currentData.find(s => s.schedulerType === schedulerType);
      
      const timestamp = new Date().toISOString();
      
      if (existingStatus) {
        // Update existing scheduler status
        existingStatus.status = status;
        existingStatus.lastRun = timestamp;
        existingStatus.cycleCount = status === 'running' ? existingStatus.cycleCount + 1 : existingStatus.cycleCount;
        existingStatus.lastError = status === 'error' && errorMessage ? errorMessage : (status === 'error' ? 'See logs for details' : '');
      } else {
        // Add new scheduler status
        currentData.push({
          schedulerType,
          status,
          lastRun: timestamp,
          cycleCount: 1,
          lastError: status === 'error' && errorMessage ? errorMessage : (status === 'error' ? 'See logs for details' : '')
        });
      }

      // Write all data back to sheets
      await this.writeAllStatuses(currentData);
      
      console.log(`📊 Updated ${schedulerType} scheduler status: ${status} in Google Sheets`);
    } catch (error) {
      console.error(`❌ Error updating ${schedulerType} scheduler status:`, error);
      // Don't throw - status tracking shouldn't crash the scheduler
    }
  }

  /**
   * Get status for a specific scheduler
   */
  async getStatus(schedulerType: 'linkedin' | 'email'): Promise<SchedulerStatus | null> {
    try {
      const allStatuses = await this.getAllStatuses();
      return allStatuses.find(s => s.schedulerType === schedulerType) || null;
    } catch (error) {
      console.error(`❌ Error getting ${schedulerType} scheduler status:`, error);
      return null;
    }
  }

  /**
   * Get all scheduler statuses
   */
  async getAllStatuses(): Promise<SchedulerStatus[]> {
    try {
      // Use a simple approach - create a temporary lead to trigger initialization and get access
      const allLeads = await this.sheetsService.getAllLeads();
      
      // Access private members through reflection (for now - should be made public in production)
      const sheets = (this.sheetsService as any).sheets;
      const spreadsheetId = (this.sheetsService as any).spreadsheetId || process.env.GOOGLE_SPREADSHEET_ID;
      
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: this.range,
      });

      const rows = response.data.values || [];
      
      // If no data, return empty array
      if (rows.length === 0) {
        return [];
      }

      // If only headers, return empty array
      if (rows.length === 1) {
        return [];
      }

      // Parse data rows (skip header row)
      const statuses: SchedulerStatus[] = [];
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row && row[0]) {
          statuses.push({
            schedulerType: row[0] as 'linkedin' | 'email',
            status: (row[1] || 'stopped') as 'running' | 'completed' | 'error' | 'stopped',
            lastRun: row[2] || '',
            cycleCount: parseInt(row[3]) || 0,
            lastError: row[4] || ''
          });
        }
      }

      return statuses;
    } catch (error) {
      console.error('❌ Error getting scheduler statuses:', error);
      return [];
    }
  }

  /**
   * Write all statuses to Google Sheets
   */
  private async writeAllStatuses(statuses: SchedulerStatus[]): Promise<void> {
    try {
      // Trigger initialization
      await this.sheetsService.getAllLeads();
      
      // Access private members through reflection
      const sheets = (this.sheetsService as any).sheets;
      const spreadsheetId = (this.sheetsService as any).spreadsheetId || process.env.GOOGLE_SPREADSHEET_ID;

      // Prepare headers and data
      const headers = ['schedulerType', 'status', 'lastRun', 'cycleCount', 'lastError'];
      const rows = [headers];
      
      // Add data rows
      statuses.forEach(status => {
        rows.push([
          status.schedulerType,
          status.status,
          status.lastRun,
          status.cycleCount.toString(),
          status.lastError
        ]);
      });

      // Clear and write all data
      await sheets.spreadsheets.values.clear({
        spreadsheetId,
        range: this.range,
      });

      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: this.range,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: rows,
        },
      });

    } catch (error) {
      console.error('❌ Error writing scheduler statuses to Google Sheets:', error);
      throw new Error(`Failed to write scheduler statuses to Google Sheets: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Initialize the SchedulerStatus sheet with headers if it doesn't exist
   */
  async initializeSheet(): Promise<void> {
    try {
      // Try to get existing data
      const existingData = await this.getAllStatuses();
      
      // If we get data back, sheet exists
      if (existingData.length >= 0) {
        console.log('📊 SchedulerStatus sheet already exists');
        return;
      }
    } catch (error) {
      // If error, sheet might not exist, so create it
      console.log('📊 Initializing SchedulerStatus sheet...');
      
      try {
        // Trigger initialization
        await this.sheetsService.getAllLeads();
        
        // Access private members through reflection
        const sheets = (this.sheetsService as any).sheets;
        const spreadsheetId = (this.sheetsService as any).spreadsheetId || process.env.GOOGLE_SPREADSHEET_ID;
        
        const headers = ['schedulerType', 'status', 'lastRun', 'cycleCount', 'lastError'];
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: 'SchedulerStatus!A1:E1',
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [headers],
          },
        });
        console.log('✅ SchedulerStatus sheet initialized');
      } catch (initError) {
        console.error('❌ Error initializing SchedulerStatus sheet:', initError);
        throw new Error(`Failed to initialize SchedulerStatus sheet: ${initError instanceof Error ? initError.message : String(initError)}`);
      }
    }
  }

  /**
   * Get formatted status summary for logging
   */
  async getStatusSummary(): Promise<string> {
    try {
      const statuses = await this.getAllStatuses();
      
      if (statuses.length === 0) {
        return '📊 No scheduler status data found';
      }

      let summary = '📊 Scheduler Status Summary:\n';
      statuses.forEach(status => {
        const emoji = status.status === 'running' ? '🔄' : 
                      status.status === 'completed' ? '✅' : 
                      status.status === 'error' ? '❌' : '⏸️';
        
        summary += `   ${emoji} ${status.schedulerType.toUpperCase()}: ${status.status} (${status.cycleCount} cycles)\n`;
        if (status.lastError) {
          summary += `      ⚠️ Last Error: ${status.lastError}\n`;
        }
      });

      return summary;
    } catch (error) {
      return `📊 Error getting status summary: ${error}`;
    }
  }
}