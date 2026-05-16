import { google } from 'googleapis';
import { GoogleSheetsService } from './src/app/services/googleSheets.js';
import 'dotenv/config';

/**
 * Set up Gmail Pub/Sub webhooks for all email accounts
 * 
 * This script configures Gmail push notifications to your Pub/Sub topic
 * so you get real-time notifications when emails are received.
 */

class GmailPubSubSetup {
  private sheetsService: GoogleSheetsService;

  constructor() {
    this.sheetsService = new GoogleSheetsService();
  }

  async setupGmailWebhooks(): Promise<void> {
    console.log('🔧 Setting up Gmail Pub/Sub webhooks');
    console.log('═'.repeat(50));

    // Validate environment variables
    const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
    const topicName = process.env.PUBSUB_TOPIC_NAME || 'gmail-email-responses';

    if (!projectId || projectId === 'your-project-id') {
      console.error('❌ Please set GOOGLE_CLOUD_PROJECT_ID in your .env file');
      return;
    }

    console.log(`📋 Configuration:`);
    console.log(`   Project ID: ${projectId}`);
    console.log(`   Topic Name: ${topicName}`);
    console.log(`   Webhook URL: ${process.env.NEXT_PUBLIC_BASE_URL}/api/webhook/gmail-response`);
    console.log();

    // Get all active email accounts
    const emailAccounts = await this.sheetsService.getAllEmailAccounts();
    const activeAccounts = emailAccounts.filter(acc => acc.isActive);

    if (activeAccounts.length === 0) {
      console.error('❌ No active email accounts found');
      console.log('💡 Make sure you have email accounts set up in your Google Sheets');
      return;
    }

    console.log(`📧 Found ${activeAccounts.length} active email accounts`);
    console.log();

    // Set up webhook for each account
    let successCount = 0;
    for (const account of activeAccounts) {
      try {
        await this.setupAccountWebhook(account, projectId, topicName);
        successCount++;
        console.log(`✅ Webhook setup completed for ${account.emailAddress}`);
      } catch (error) {
        console.error(`❌ Failed to setup webhook for ${account.emailAddress}:`);
        console.error(`   ${error instanceof Error ? error.message : String(error)}`);
      }
      console.log();
    }

    if (successCount > 0) {
      console.log(`🎉 Successfully set up webhooks for ${successCount}/${activeAccounts.length} accounts!`);
      console.log('\n📝 Next steps:');
      console.log('1. Make sure your webhook endpoint is publicly accessible');
      console.log('2. Test by sending emails to your accounts');
      console.log('3. Monitor webhook logs for incoming notifications');
    } else {
      console.error('❌ Failed to set up any webhooks');
    }
  }

  private async setupAccountWebhook(
    account: any, 
    projectId: string, 
    topicName: string
  ): Promise<void> {
    console.log(`🔧 Setting up webhook for ${account.emailAddress}...`);

    // Initialize Gmail API client
    const oauth2Client = new google.auth.OAuth2(
      account.clientId,
      account.clientSecret,
      process.env.OAUTH_REDIRECT_URI
    );

    oauth2Client.setCredentials({
      access_token: account.accessToken,
      refresh_token: account.refreshToken,
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    try {
      // First, stop any existing watch
      try {
        await gmail.users.stop({ userId: 'me' });
        console.log('   📴 Stopped existing watch (if any)');
      } catch (error) {
        // It's OK if there's no existing watch
        console.log('   📄 No existing watch to stop');
      }

      // Set up new watch
      const topicPath = `projects/${projectId}/topics/${topicName}`;
      
      const watchRequest = {
        userId: 'me',
        requestBody: {
          topicName: topicPath,
          labelIds: ['INBOX'], // Only watch INBOX messages
          labelFilterAction: 'include'
        }
      };

      console.log(`   📡 Setting up watch for topic: ${topicPath}`);
      
      const watchResponse = await gmail.users.watch(watchRequest);
      
      console.log('   ✅ Gmail watch established successfully');
      console.log(`   📧 History ID: ${watchResponse.data.historyId}`);
      
      if (watchResponse.data.expiration) {
        const expirationDate = new Date(Number(watchResponse.data.expiration));
        console.log(`   ⏰ Expires: ${expirationDate.toLocaleString()}`);
      }

      // Update account with latest historyId for tracking
      await this.sheetsService.updateEmailAccount(account.id, {
        lastHistoryId: watchResponse.data.historyId as string
      });

    } catch (error: any) {
      console.error('   ❌ Gmail API error details:');
      
      if (error.code === 400) {
        console.error('   • Bad Request - Check your topic name and permissions');
      } else if (error.code === 403) {
        console.error('   • Forbidden - Check Gmail API permissions and OAuth scopes');
      } else if (error.code === 404) {
        console.error('   • Not Found - Check if Pub/Sub topic exists');
      }
      
      console.error(`   • Error: ${error.message}`);
      throw error;
    }
  }

  async checkPrerequisites(): Promise<boolean> {
    console.log('🔍 Checking prerequisites...');
    
    let allGood = true;

    // Check environment variables
    if (!process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT_ID === 'your-project-id') {
      console.error('❌ GOOGLE_CLOUD_PROJECT_ID not set in .env file');
      allGood = false;
    }

    if (!process.env.NEXT_PUBLIC_BASE_URL) {
      console.error('❌ NEXT_PUBLIC_BASE_URL not set in .env file');
      allGood = false;
    }

    // Check if webhook endpoint is accessible
    try {
      const webhookUrl = `${process.env.NEXT_PUBLIC_BASE_URL}/api/webhook/gmail-response`;
      console.log(`🌐 Testing webhook endpoint: ${webhookUrl}`);
      
      const response = await fetch(webhookUrl, { method: 'GET' });
      if (response.ok) {
        console.log('✅ Webhook endpoint is accessible');
      } else {
        console.error('❌ Webhook endpoint returned error:', response.status);
        allGood = false;
      }
    } catch (error) {
      console.error('❌ Webhook endpoint not accessible:', error);
      console.error('💡 Make sure your Next.js server is running and publicly accessible');
      allGood = false;
    }

    return allGood;
  }

  async showManualSteps(): Promise<void> {
    console.log('\n📖 Manual Setup Steps (if you prefer manual setup):');
    console.log('═'.repeat(60));
    
    console.log('\n1. Create Pub/Sub topic:');
    console.log('   gcloud pubsub topics create gmail-email-responses');
    
    console.log('\n2. Grant Gmail service account permissions:');
    console.log('   gcloud pubsub topics add-iam-policy-binding gmail-email-responses \\');
    console.log('     --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \\');
    console.log('     --role=roles/pubsub.publisher');
    
    console.log('\n3. Set up Gmail watch for each account using Gmail API:');
    console.log('   POST https://gmail.googleapis.com/gmail/v1/users/me/watch');
    console.log('   {');
    console.log('     "topicName": "projects/YOUR-PROJECT-ID/topics/gmail-email-responses",');
    console.log('     "labelIds": ["INBOX"]');
    console.log('   }');
    
    console.log('\n4. Your webhook endpoint:');
    console.log(`   ${process.env.NEXT_PUBLIC_BASE_URL}/api/webhook/gmail-response`);
  }
}

// Main execution
async function main() {
  const setup = new GmailPubSubSetup();
  
  console.log('🚀 Gmail Pub/Sub Webhook Setup');
  console.log(`📅 ${new Date().toLocaleString()}`);
  console.log();

  // Check prerequisites first
  const prerequisitesOk = await setup.checkPrerequisites();
  if (!prerequisitesOk) {
    console.log('\n❌ Prerequisites not met. Please fix the issues above and try again.');
    return;
  }

  console.log('✅ Prerequisites check passed\n');

  // Set up webhooks
  await setup.setupGmailWebhooks();
  
  // Show manual steps for reference
  await setup.showManualSteps();
}

// Run the setup
main().catch(console.error);