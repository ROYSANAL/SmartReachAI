import moment from 'moment';
import { CONFIG } from '../../config/config';

export class TimeUtils {
  static isWorkingHours(): boolean {
    const now = moment();
    
    if (CONFIG.WORKING_HOURS.WEEKDAYS_ONLY) {
      const dayOfWeek = now.day(); // 0 = Sunday, 6 = Saturday
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        return false; // Weekend
      }
    }

    const hour = now.hour();
    return hour >= CONFIG.WORKING_HOURS.START && hour < CONFIG.WORKING_HOURS.END;
  }

  static getNextWorkingHour(): moment.Moment {
    let next = moment();
    const maxIterations = 24 * 7; // Prevent infinite loops (1 week max)
    let iterations = 0;
    
    while (!this.isWorkingHoursForTime(next) && iterations < maxIterations) {
      next = next.add(1, 'hour').startOf('hour');
      iterations++;
    }
    
    if (iterations >= maxIterations) {
      // Fallback: return next Monday 10 AM if no working hours found
      return moment().startOf('isoWeek').add(1, 'week').hour(CONFIG.WORKING_HOURS.START).minute(0).second(0);
    }
    
    return next;
  }

  private static isWorkingHoursForTime(time: moment.Moment): boolean {
    if (CONFIG.WORKING_HOURS.WEEKDAYS_ONLY) {
      const dayOfWeek = time.day(); // 0 = Sunday, 6 = Saturday
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        return false; // Weekend
      }
    }

    const hour = time.hour();
    return hour >= CONFIG.WORKING_HOURS.START && hour < CONFIG.WORKING_HOURS.END;
  }

  static isNewDay(lastRun: string): boolean {
    const lastRunDate = moment(lastRun).format('YYYY-MM-DD');
    const today = moment().format('YYYY-MM-DD');
    return lastRunDate !== today;
  }
}