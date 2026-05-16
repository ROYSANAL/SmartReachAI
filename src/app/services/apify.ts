import axios, { AxiosResponse } from 'axios';
import { CONFIG } from '../../config/config';

interface ApifyRunResponse {
  data: {
    id: string;
    status?: string;
    defaultDatasetId?: string;
    statusMessage?: string;
  };
}

type ApifyDatasetResponse = unknown[];

export class ApifyService {
  private apiKey: string;
  private baseUrl = 'https://api.apify.com/v2';
  private actorId = 'dev_fusion~linkedin-profile-scraper';

  constructor() {
    this.apiKey = CONFIG.APIFY_API_KEY;
  }

  async enrichLeadData(linkedinUrl: string): Promise<unknown> {
    const startTime = Date.now();
    const maxWaitTime = 8 * 60 * 1000; // 8 minutes absolute timeout
    
    try {
      console.log(`🚀 Starting Apify enrichment for: ${linkedinUrl}`);
      
      // Validate LinkedIn URL format
      if (!this.isValidLinkedInUrl(linkedinUrl)) {
        throw new Error(`Invalid LinkedIn URL format: ${linkedinUrl}`);
      }

      // FIX 1: Use the correct API endpoint structure
      // First start the actor run
      const runResponse = await Promise.race([
        axios.post(
          `${this.baseUrl}/acts/${this.actorId}/runs?token=${this.apiKey}`,
          {
            // FIX 2: Use the correct input format for this specific scraper
            "profileUrls": [linkedinUrl], // Array of URLs, not objects
            // proxyConfiguration: { 
            //   useApifyProxy: true,
            //   groups: ['RESIDENTIAL'] // Use residential proxies for better success rate
            // },
            maxRequestRetries: 3,
            requestHandlerTimeoutSecs: 60
          },
          { 
            timeout: 30000,
            headers: {
              'Content-Type': 'application/json'
            }
          }
        ),
        new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error('Apify start request timeout')), 35000)
        )
      ]) as AxiosResponse<ApifyRunResponse>;

      if (!runResponse.data?.data?.id) {
        console.error('Invalid Apify response:', runResponse.data);
        throw new Error('Invalid response from Apify start request');
      }

      const runId = runResponse.data.data.id;
      console.log(`⏳ Apify run started, ID: ${runId}`);
      
      // Wait for completion and get results
      let attempts = 0;
      const maxAttempts = 48; // 8 minutes max (10 seconds * 48)
      const pollInterval = 10000; // 10 seconds

      while (attempts < maxAttempts) {
        // Check absolute timeout
        if (Date.now() - startTime > maxWaitTime) {
          throw new Error('Absolute timeout reached (8 minutes)');
        }

        await this.delay(pollInterval);
        attempts++;
        
        try {
          const statusResponse = await Promise.race([
            axios.get(
              `${this.baseUrl}/actor-runs/${runId}?token=${this.apiKey}`,
              { timeout: 15000 }
            ),
            new Promise<never>((_, reject) => 
              setTimeout(() => reject(new Error('Status check timeout')), 20000)
            )
          ]) as AxiosResponse<ApifyRunResponse>;

          if (!statusResponse.data?.data) {
            console.warn(`⚠️ Invalid status response on attempt ${attempts}, retrying...`);
            continue;
          }

          const status = statusResponse.data.data.status;
          console.log(`🔍 Apify status check ${attempts}/${maxAttempts}: ${status}`);

          if (status === 'SUCCEEDED') {
            console.log(`✅ Apify enrichment completed successfully`);
            
            // Get dataset items
            const datasetId = statusResponse.data.data.defaultDatasetId;
            if (!datasetId) {
              throw new Error('No dataset ID returned from successful run');
            }

            const itemsResponse = await Promise.race([
              axios.get(
                `${this.baseUrl}/datasets/${datasetId}/items?token=${this.apiKey}&format=json`, 
                { 
                  timeout: 15000,
                  headers: {
                    'Accept': 'application/json'
                  }
                }
              ),
              new Promise<never>((_, reject) => 
                setTimeout(() => reject(new Error('Dataset fetch timeout')), 20000)
              )
            ]) as AxiosResponse<ApifyDatasetResponse>;

            if (!itemsResponse.data || itemsResponse.data.length === 0) {
              console.warn('⚠️ No data returned from Apify, but run was successful');
              return null;
            }

            const enrichedData = itemsResponse.data[0];
            console.log(`📊 Retrieved enriched data with ${Object.keys(enrichedData as object).length} fields`);
            
            // Log some key fields for debugging (without exposing sensitive data)
            const data = enrichedData as any;
            console.log(`📋 Profile data preview: ${data.fullName || data.name || 'N/A'}, ${data.headline || 'N/A'}`);
            
            return enrichedData;
            
          } else if (status === 'FAILED') {
            const errorMessage = statusResponse.data.data.statusMessage || 'Unknown failure';
            console.error(`❌ Apify run failed: ${errorMessage}`);
            
            // Try to get more error details from the dataset
            const datasetId = statusResponse.data.data.defaultDatasetId;
            if (datasetId) {
              try {
                const errorResponse = await axios.get(
                  `${this.baseUrl}/datasets/${datasetId}/items?token=${this.apiKey}&format=json`
                );
                if (errorResponse.data && errorResponse.data.length > 0) {
                  console.error('Error details from dataset:', errorResponse.data[0]);
                }
              } catch (e) {
                // Ignore errors when trying to fetch error details
              }
            }
            
            throw new Error(`Apify scraping failed: ${errorMessage}`);
            
          } else if (status === 'TIMED-OUT') {
            throw new Error('Apify scraping timed out on server side');
            
          } else if (status === 'ABORTED') {
            throw new Error('Apify scraping was aborted');
            
          } else if (['READY', 'RUNNING'].includes(status as string)) {
            // Still processing, continue polling
            console.log(`⏳ Still processing... (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);
            continue;
            
          } else {
            console.warn(`⚠️ Unknown Apify status: ${status}, continuing to poll...`);
            continue;
          }
          
        } catch (statusError) {
          const errorMessage = statusError instanceof Error ? statusError.message : 'Unknown error';
          console.warn(`⚠️ Status check failed on attempt ${attempts}:`, errorMessage);
          
          // If we're near the end, fail. Otherwise, retry.
          if (attempts >= maxAttempts - 2) {
            throw new Error(`Status check failed repeatedly: ${errorMessage}`);
          }
          continue;
        }
      }

      throw new Error(`Polling timeout after ${attempts} attempts (${Math.round((Date.now() - startTime) / 1000)}s)`);
      
    } catch (error) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`❌ Apify enrichment failed after ${elapsed}s:`, errorMessage);
      
      // Log the full error for debugging
      if (axios.isAxiosError(error)) {
        console.error('Axios error details:', {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
          url: error.config?.url
        });
      }
      
      // Return null for recoverable errors, throw for config errors
      if (errorMessage.includes('Invalid LinkedIn URL') || 
          errorMessage.includes('token') || 
          errorMessage.includes('API key') ||
          errorMessage.includes('401') ||
          errorMessage.includes('403')) {
        throw error; // Re-throw configuration errors
      }
      
      return null; // Return null for timeout/network errors
    }
  }

  // FIX 3: Alternative method using the synchronous endpoint (faster but with limitations)
  async enrichLeadDataSync(linkedinUrl: string): Promise<unknown> {
    try {
      console.log(`🚀 Starting Apify SYNC enrichment for: ${linkedinUrl}`);
      
      if (!this.isValidLinkedInUrl(linkedinUrl)) {
        throw new Error(`Invalid LinkedIn URL format: ${linkedinUrl}`);
      }

      const response = await axios.post(
        `${this.baseUrl}/acts/${this.actorId}/run-sync-get-dataset-items?token=${this.apiKey}`,
        {
          startUrls: [linkedinUrl], // Array of URLs directly
          proxyConfiguration: { 
            useApifyProxy: true,
            groups: ['RESIDENTIAL']
          },
          maxRequestRetries: 2
        },
        { 
          timeout: 120000, // 2 minute timeout for sync request
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      if (!response.data || response.data.length === 0) {
        console.warn('⚠️ No data returned from sync Apify request');
        return null;
      }

      const enrichedData = response.data[0];
      console.log(`📊 Retrieved sync enriched data with ${Object.keys(enrichedData as object).length} fields`);
      
      return enrichedData;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`❌ Apify sync enrichment failed:`, errorMessage);
      
      if (axios.isAxiosError(error)) {
        console.error('Sync error details:', {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
          url: error.config?.url
        });
      }
      
      return null;
    }
  }

  private isValidLinkedInUrl(url: string): boolean {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.includes('linkedin.com') && 
             (urlObj.pathname.includes('/in/') || urlObj.pathname.includes('/pub/'));
    } catch {
      return false;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Helper method to test the API connection
  async testConnection(): Promise<boolean> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/acts/${this.actorId}?token=${this.apiKey}`,
        { timeout: 10000 }
      );
      
      console.log('✅ Apify connection test successful');
      console.log('Actor info:', {
        name: response.data.name,
        title: response.data.title,
        isPublic: response.data.isPublic
      });
      
      return true;
    } catch (error) {
      console.error('❌ Apify connection test failed:', error);
      return false;
    }
  }
}