import { NextResponse } from 'next/server';
import { GoogleSheetsService } from '../../services/googleSheets';
import { RateLimiterService } from '../../services/rateLimiter';
import { TimeUtils } from '../../utils/timeUtils';
import { CONFIG } from '../../../config/config';
import moment from 'moment';

const sheetsService = new GoogleSheetsService();
const rateLimiter = new RateLimiterService();

export async function GET() {
  try {
    // Get counts by status
    const statuses = [
      'new', 'lead_enriched', 'posts_liked', 'posts_commented',
      'invitation_sent', 'connected', 'first_message_sent'
    ];

    const statusCounts: { [key: string]: number } = {};
    
    for (const status of statuses) {
      const leads = await sheetsService.getLeadsByStatus(status);
      statusCounts[status] = leads.length;
    }

    // Get daily counters
    const today = moment().format('YYYY-MM-DD');
    const counters = await rateLimiter.getDailyCounters(today);
    
    // Build rate limits from config + current counters
    const rateLimits = {
      postsLiked: { 
        max: CONFIG.DAILY_LIMITS.POSTS_LIKED, 
        current: counters.postsLiked 
      },
      postsCommented: { 
        max: CONFIG.DAILY_LIMITS.POSTS_COMMENTED, 
        current: counters.postsCommented 
      },
      invitationsSent: { 
        max: CONFIG.DAILY_LIMITS.INVITATIONS_SENT, 
        current: counters.invitationsSent 
      },
      messagesSent: { 
        max: CONFIG.DAILY_LIMITS.MESSAGES_SENT, 
        current: counters.messagesSent 
      }
    };

    // System status
    const systemStatus = {
      isWorkingHours: TimeUtils.isWorkingHours(),
      nextWorkingHour: TimeUtils.isWorkingHours() ? null : TimeUtils.getNextWorkingHour().toISOString(),
      currentTime: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    };

    return NextResponse.json({
      statusCounts,
      counters,
      rateLimits,
      systemStatus
    });
  } catch (error) {
    console.error('Status API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}