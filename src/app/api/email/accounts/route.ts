import { NextRequest, NextResponse } from 'next/server';
import { getEmailAccountManager } from '../../../services/emailAccountManager';
import { GoogleSheetsService } from '../../../services/googleSheets';

export async function GET(request: NextRequest) {
  try {
    const emailAccountManager = getEmailAccountManager();
    const searchParams = request.nextUrl.searchParams;
    const includeInactive = searchParams.get('includeInactive') === 'true';

    // Get accounts based on filter
    let accounts;
    if (includeInactive) {
      const sheetsService = new GoogleSheetsService();
      accounts = await sheetsService.getAllEmailAccounts();
    } else {
      accounts = await emailAccountManager.getActiveAccounts();
    }

    // Get health summary
    const healthSummary = await emailAccountManager.getAccountHealthSummary();

    // Sanitize accounts (remove sensitive data)
    const sanitizedAccounts = accounts.map(account => ({
      id: account.id,
      emailAddress: account.emailAddress,
      displayName: account.displayName,
      provider: account.provider,
      dailyLimit: account.dailyLimit,
      hourlyLimit: account.hourlyLimit,
      sentToday: account.sentToday,
      sentThisHour: account.sentThisHour,
      reputation: account.reputation,
      isActive: account.isActive,
      warmupPhase: account.warmupPhase,
    }));

    return NextResponse.json({
      accounts: sanitizedAccounts,
      healthSummary,
      total: accounts.length
    });

  } catch (error) {
    console.error('❌ Error fetching email accounts:', error);
    return NextResponse.json(
      { error: 'Failed to fetch email accounts' },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json() as {
      accountId: string;
      updates: {
        isActive?: boolean;
        dailyLimit?: number;
        hourlyLimit?: number;
        warmupPhase?: boolean;
        reputation?: 'good' | 'warning' | 'poor';
      };
    };

    const { accountId, updates } = body;

    if (!accountId || !updates) {
      return NextResponse.json(
        { error: 'Missing accountId or updates' },
        { status: 400 }
      );
    }

    // Validate updates
    const allowedFields = ['isActive', 'dailyLimit', 'hourlyLimit', 'warmupPhase', 'reputation'];
    const invalidFields = Object.keys(updates).filter(key => !allowedFields.includes(key));
    
    if (invalidFields.length > 0) {
      return NextResponse.json(
        { error: `Invalid fields: ${invalidFields.join(', ')}` },
        { status: 400 }
      );
    }

    // Validate limits
    if (updates.dailyLimit && (updates.dailyLimit < 1 || updates.dailyLimit > 300)) {
      return NextResponse.json(
        { error: 'Daily limit must be between 1 and 300' },
        { status: 400 }
      );
    }

    if (updates.hourlyLimit && (updates.hourlyLimit < 1 || updates.hourlyLimit > 50)) {
      return NextResponse.json(
        { error: 'Hourly limit must be between 1 and 50' },
        { status: 400 }
      );
    }

    // Update account
    const sheetsService = new GoogleSheetsService();
    await sheetsService.updateEmailAccount(accountId, updates);

    console.log(`✅ Updated email account ${accountId}:`, updates);

    return NextResponse.json({
      success: true,
      message: 'Email account updated successfully'
    });

  } catch (error) {
    console.error('❌ Error updating email account:', error);
    return NextResponse.json(
      { error: 'Failed to update email account' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      action: 'refresh_tokens' | 'test_account';
      accountId?: string;
    };

    const { action, accountId } = body;

    const emailAccountManager = getEmailAccountManager();

    switch (action) {
      case 'refresh_tokens':
        if (accountId) {
          // Refresh single account
          const success = await emailAccountManager.refreshAccessToken(accountId);
          return NextResponse.json({
            success,
            message: success ? 'Token refreshed successfully' : 'Failed to refresh token'
          });
        } else {
          // Refresh all accounts
          await emailAccountManager.checkAndRefreshTokens();
          return NextResponse.json({
            success: true,
            message: 'All tokens checked and refreshed'
          });
        }

      case 'test_account':
        if (!accountId) {
          return NextResponse.json(
            { error: 'accountId required for test_account action' },
            { status: 400 }
          );
        }

        // Get account and test if it's available for sending
        const account = await emailAccountManager.getAccountById(accountId);
        if (!account) {
          return NextResponse.json(
            { error: 'Account not found' },
            { status: 404 }
          );
        }

        const availableAccount = await emailAccountManager.getAvailableAccountForSending();
        const isAvailable = availableAccount?.id === accountId;

        return NextResponse.json({
          success: true,
          account: {
            id: account.id,
            emailAddress: account.emailAddress,
            isAvailable,
            reputation: account.reputation,
            sentToday: account.sentToday,
            dailyLimit: account.dailyLimit,
            sentThisHour: account.sentThisHour,
            hourlyLimit: account.hourlyLimit
          }
        });

      default:
        return NextResponse.json(
          { error: 'Invalid action' },
          { status: 400 }
        );
    }

  } catch (error) {
    console.error('❌ Error in email account action:', error);
    return NextResponse.json(
      { error: 'Failed to perform action' },
      { status: 500 }
    );
  }
}