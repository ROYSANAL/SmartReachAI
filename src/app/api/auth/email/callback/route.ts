import { NextRequest, NextResponse } from 'next/server';
import { google } from 'googleapis';
import { getEmailAccountManager } from '../../../../services/emailAccountManager';
import { GoogleSheetsService } from '../../../../services/googleSheets';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    // Handle OAuth2 errors
    if (error) {
      console.error('❌ OAuth2 error:', error);
      return NextResponse.json(
        { error: `OAuth2 authorization failed: ${error}` },
        { status: 400 }
      );
    }

    if (!code || !state) {
      return NextResponse.json(
        { error: 'Missing authorization code or state parameter' },
        { status: 400 }
      );
    }

    // Decode state parameter
    let stateData: any;
    try {
      stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    } catch {
      return NextResponse.json(
        { error: 'Invalid state parameter' },
        { status: 400 }
      );
    }

    const { emailAddress, clientId, clientSecret, salesPersonId, timestamp } = stateData;

    // Check if state is not too old (5 minutes max)
    const maxAge = 5 * 60 * 1000; // 5 minutes
    if (Date.now() - timestamp > maxAge) {
      return NextResponse.json(
        { error: 'Authorization session expired. Please try again.' },
        { status: 400 }
      );
    }

    // Create OAuth2 client
    const oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/api/auth/email/callback`
    );

    // Exchange authorization code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    
    if (!tokens.access_token || !tokens.refresh_token) {
      throw new Error('Failed to obtain required tokens');
    }

    // Set credentials to get user info
    oauth2Client.setCredentials(tokens);

    // Get user profile information
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    
    const actualEmail = userInfo.data.email;
    const displayName = userInfo.data.name || userInfo.data.email || '';

    // Verify the email matches what was requested
    if (actualEmail !== emailAddress) {
      console.warn(`⚠️ Email mismatch: requested ${emailAddress}, got ${actualEmail}`);
    }

    // Create or update email account
    const emailAccountManager = getEmailAccountManager();
    const emailAccount = await emailAccountManager.createOrUpdateAccount({
      emailAddress: actualEmail || emailAddress,
      displayName,
      provider: 'gmail',
      clientId,
      clientSecret,
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : '',
      dailyLimit: 50, // Conservative default for new accounts
      hourlyLimit: 10,
      isActive: true,
      warmupPhase: true // New accounts start in warmup mode
    });

    console.log(`✅ OAuth2 setup completed for ${emailAccount.emailAddress}`);

    // Return success response (could redirect to a success page)
    return NextResponse.json({
      success: true,
      message: 'Email account authenticated successfully',
      account: {
        id: emailAccount.id,
        emailAddress: emailAccount.emailAddress,
        displayName: emailAccount.displayName,
        isActive: emailAccount.isActive,
        warmupPhase: emailAccount.warmupPhase
      }
    });

  } catch (error) {
    console.error('❌ Error in OAuth2 callback:', error);
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    return NextResponse.json(
      { 
        error: 'Failed to complete OAuth2 authentication',
        details: errorMessage
      },
      { status: 500 }
    );
  }
}