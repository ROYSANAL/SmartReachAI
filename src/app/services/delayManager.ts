import { CONFIG } from '../../config/config';

export class DelayManager {
  static async randomDelay(actionType: keyof typeof CONFIG.ACTION_DELAYS): Promise<void> {
    const delayConfig = CONFIG.ACTION_DELAYS[actionType];
    const min = delayConfig.MIN * 1000; // Convert to milliseconds
    const max = delayConfig.MAX * 1000;
    
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    
    console.log(`Applying random delay for ${actionType}: ${delay / 1000}s`);
    return new Promise(resolve => setTimeout(resolve, delay));
  }

  static async fixedDelay(seconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
  }

  static getRandomInterval(): number {
    const min = CONFIG.SCHEDULER_INTERVAL.MIN;
    const max = CONFIG.SCHEDULER_INTERVAL.MAX;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  static getRandomEmailInterval(): number {
    const min = CONFIG.EMAIL_SCHEDULER_INTERVAL.MIN;
    const max = CONFIG.EMAIL_SCHEDULER_INTERVAL.MAX;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  static async randomLeadProcessingDelay(delayType: keyof typeof CONFIG.LEAD_PROCESSING_DELAYS): Promise<void> {
    const delayConfig = CONFIG.LEAD_PROCESSING_DELAYS[delayType];
    const min = delayConfig.MIN * 1000; // Convert to milliseconds
    const max = delayConfig.MAX * 1000;
    
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    
    console.log(`🕒 Random lead processing delay for ${delayType}: ${delay / 1000}s`);
    return new Promise(resolve => setTimeout(resolve, delay));
  }

  static async randomPriorityStepDelay(delayType: keyof typeof CONFIG.PRIORITY_STEP_DELAYS): Promise<void> {
    const delayConfig = CONFIG.PRIORITY_STEP_DELAYS[delayType];
    const min = delayConfig.MIN * 1000; // Convert to milliseconds
    const max = delayConfig.MAX * 1000;
    
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    
    console.log(`⏳ Random priority step delay for ${delayType}: ${delay / 1000}s`);
    return new Promise(resolve => setTimeout(resolve, delay));
  }

  static async customRandomDelay(minSeconds: number, maxSeconds: number, description?: string): Promise<void> {
    const min = minSeconds * 1000;
    const max = maxSeconds * 1000;
    
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    
    const desc = description || 'custom delay';
    console.log(`⏱️ Random ${desc}: ${delay / 1000}s`);
    return new Promise(resolve => setTimeout(resolve, delay));
  }
}