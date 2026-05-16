const fs = require('fs-extra');
const path = require('path');

// async function setupProject() {

//   console.log('Setting up LinkedIn Automation System...');

//   // Create data directory
//   const dataDir = path.join(process.cwd(), 'data');
//   await fs.ensureDir(dataDir);
//   console.log('✓ Created data directory');

//   // Create initial counter file
//   const countersFile = path.join(dataDir, 'daily-counters.json');
//   if (!(await fs.pathExists(countersFile))) {
//     await fs.writeJson(countersFile, {}, { spaces: 2 });
//     console.log('✓ Created daily counters file');
//   }

//   // Create initial rate limits file
//   const rateLimitsFile = path.join(dataDir, 'rate-limits.json');
//   if (!(await fs.pathExists(rateLimitsFile))) {
//     await fs.writeJson(rateLimitsFile, {}, { spaces: 2 });
//     console.log('✓ Created rate limits file');
//   }

//   // Create last run file
//   const lastRunFile = path.join(dataDir, 'last-run.json');
//   if (!(await fs.pathExists(lastRunFile))) {
//     await fs.writeJson(lastRunFile, {
//       timestamp: new Date().toISOString()
//     }, { spaces: 2 });
//     console.log('✓ Created last run file');
//   }

//   // Create logs directory
//   const logsDir = path.join(process.cwd(), 'logs');
//   await fs.ensureDir(logsDir);
//   console.log('✓ Created logs directory');

//   console.log('\nSetup completed! Next steps:');
//   console.log('1. Copy .env.example to .env and fill in your API keys');
//   console.log('2. Add your Google service account credentials as credentials.json');
//   console.log('3. Set up your Google Sheets with the required columns');
//   console.log('4. Run "npm run dev" to start the development server');
//   console.log('5. Run "npm run scheduler" to start the automation scheduler');
// }

// setupProject().catch(console.error);

async function setupProject() {
  console.log('Setting up LinkedIn Automation System...');

  try {
    // Create data directory
    const dataDir = path.join(process.cwd(), 'data');
    await fs.ensureDir(dataDir);
    console.log('✓ Created data directory');

    // Create last run file (for scheduler tracking)
    const lastRunFile = path.join(dataDir, 'last-run.json');
    if (!(await fs.pathExists(lastRunFile))) {
      await fs.writeJson(lastRunFile, {
        timestamp: new Date().toISOString()
      }, { spaces: 2 });
      console.log('✓ Created last run file');
    } else {
      console.log('✓ Last run file already exists');
    }

    // Create last cleanup file (for periodic cleanup tracking)
    const lastCleanupFile = path.join(dataDir, 'last-cleanup.json');
    if (!(await fs.pathExists(lastCleanupFile))) {
      await fs.writeJson(lastCleanupFile, {
        timestamp: new Date().toISOString()
      }, { spaces: 2 });
      console.log('✓ Created last cleanup file');
    } else {
      console.log('✓ Last cleanup file already exists');
    }

    // Create logs directory
    const logsDir = path.join(process.cwd(), 'logs');
    await fs.ensureDir(logsDir);
    console.log('✓ Created logs directory');

    // Verify environment variables (production check)
    if (process.env.NODE_ENV === 'production') {
      const requiredEnvVars = [
        'APOLLO_API_KEY',
        'APIFY_API_KEY', 
        'UNIPILE_API_KEY',
        'OPENAI_API_KEY',
        'GOOGLE_SPREADSHEET_ID'
      ];

      const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
      
      if (missingVars.length > 0) {
        console.warn('⚠️  Missing environment variables:', missingVars.join(', '));
      } else {
        console.log('✓ All required environment variables present');
      }

      // Check Google credentials
      const credentialsPath = process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json';
      if (await fs.pathExists(credentialsPath)) {
        console.log('✓ Google credentials file found');
      } else {
        console.warn('⚠️  Google credentials file not found at:', credentialsPath);
      }
    }

    console.log('\n🎉 Setup completed successfully!');
    console.log('\n📋 Next steps:');
    console.log('1. Copy .env.example to .env and fill in your API keys');
    console.log('2. Add your Google service account credentials as credentials.json');
    console.log('3. Set up your Google Sheets with these tabs:');
    console.log('   - "Leads" tab with columns: id, firstName, lastName, email, company, position, linkedinUrl, status, etc.');
    console.log('   - "Counters" tab with columns: date, postsLiked, postsCommented, invitationsSent, messagesSent');
    console.log('4. Run "npm start" to begin automation');
    
    if (process.env.NODE_ENV !== 'production') {
      console.log('\n💡 Development tip: Use Postman to test API endpoints first!');
    }

  } catch (error) {
    console.error('❌ Setup failed:', error.message);
    process.exit(1);
  }
}

setupProject().catch(console.error);