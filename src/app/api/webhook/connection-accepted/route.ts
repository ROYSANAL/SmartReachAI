import { NextRequest, NextResponse } from 'next/server';
import { WebhookService } from '@/app/services/webhookService';

// Unipile webhook payload interface based on actual payload structure
interface UnipileWebhookPayload {
  event: string;
  account_id: string;
  account_type: string;
  webhook_name: string;
  user_full_name: string;
  user_provider_id: string;
  user_public_identifier: string;
  user_profile_url: string;
  user_picture_url?: string;
}

export async function POST(request: NextRequest) {
  try {
    console.log('🔔 Received connection acceptance webhook');
    console.log('📍 Request headers:', Object.fromEntries(request.headers.entries()));
    console.log('📍 Request URL:', request.url);
    
    // Parse the webhook payload
    const payload = await request.json() as UnipileWebhookPayload;
    console.log('📨 Raw payload:', payload);
    
    // Return success immediately if we've already processed this connection
    // This prevents duplicate processing if Unipile retries the webhook
    
    // Validate webhook payload structure
    const validation = WebhookService.validateWebhookPayload(payload);
    if (!validation.isValid) {
      console.warn('⚠️ Invalid webhook payload:', validation.errors);
      return NextResponse.json({ 
        error: 'Invalid payload', 
        details: validation.errors 
      }, { status: 400 });
    }

    const { account_id, user_full_name, user_public_identifier, user_profile_url, user_provider_id } = payload;
    
    console.log(`📨 Processing connection acceptance:`);
    console.log(`   Account ID: ${account_id}`);
    console.log(`   User: ${user_full_name}`);
    console.log(`   LinkedIn ID: ${user_public_identifier}`);
    console.log(`   Profile URL: ${user_profile_url}`);
    console.log(`   Provider ID: ${user_provider_id}`);

    // Process the connection acceptance using WebhookService
    const webhookService = new WebhookService();
    const result = await webhookService.processConnectionAcceptance({
      unipileAccountId: account_id,
      acceptedAt: new Date().toISOString(),
      invitedUser: user_full_name,
      linkedinPublicId: user_public_identifier,
      profileUrl: user_profile_url,
      userProviderId: user_provider_id
    });

    if (result.success) {
      return NextResponse.json({
        success: true,
        message: result.message,
        data: {
          leadId: result.leadId,
          leadName: result.leadName,
          linkedinPublicId: user_public_identifier,
          linkedinAccount: result.linkedinAccountName,
          processedAt: new Date().toISOString()
        }
      });
    } else {
      // Determine appropriate status code
      let statusCode = 400;
      if (result.error?.includes('not found')) {
        statusCode = 404; // Lead not found - don't retry
      } else if (result.error?.includes('Unknown Unipile account')) {
        statusCode = 422; // Unprocessable Entity - don't retry
      }
      
      console.warn(`⚠️ Webhook processing failed: ${result.error}`);
      
      return NextResponse.json({ 
        error: result.error,
        user_public_identifier,
        webhook_advice: statusCode === 404 ? 'Lead not found - webhook will not be retried' : 'Invalid data - webhook will not be retried'
      }, { status: statusCode });
    }

  } catch (error) {
    console.error('❌ Error processing connection acceptance webhook:', error);
    
    return NextResponse.json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}


// Handle OPTIONS request for CORS
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}