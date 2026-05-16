import { NextRequest, NextResponse } from 'next/server';
import { google } from 'googleapis';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      emailAddress: string;
      clientId: string;
      clientSecret: string;
      salesPersonId?: string;
    };

    const { emailAddress, clientId, clientSecret, salesPersonId } = body;

    if (!emailAddress || !clientId || !clientSecret) {
      return NextResponse.json(
        { error: 'Missing required fields: emailAddress, clientId, clientSecret' },
        { status: 400 }
      );
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(emailAddress)) {
      return NextResponse.json(
        { error: 'Invalid email address format' },
        { status: 400 }
      );
    }

    // Create OAuth2 client
    const oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/api/auth/email/callback`
    );

    // Define required scopes for Gmail API
    const scopes = [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ];

    // Generate authorization URL with state parameter
    const state = Buffer.from(JSON.stringify({
      emailAddress,
      clientId,
      clientSecret,
      salesPersonId,
      timestamp: Date.now()
    })).toString('base64');

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline', // Required for refresh tokens
      scope: scopes,
      state,
      prompt: 'consent', // Force consent screen to ensure refresh token
      include_granted_scopes: true
    });

    console.log(`🔗 Generated OAuth2 URL for ${emailAddress}`);

    return NextResponse.json({
      authUrl,
      emailAddress,
      message: 'Navigate to the auth URL to complete OAuth2 setup'
    });

  } catch (error) {
    console.error('❌ Error starting OAuth2 flow:', error);
    return NextResponse.json(
      { error: 'Failed to start OAuth2 flow' },
      { status: 500 }
    );
  }
}