import { CONFIG } from '../../config/config';

export interface ApolloSearchParams {
  personTitles?: string[];
  personLocations?: string[];
  seniorities?: string[];
  technologies?: string[];
  includeSimilarTitles?: boolean;
  contactEmailStatus?: string[];
  organizationEmployeeRanges?: string[];
  revenueMin?: number;
  revenueMax?: number;
  perPage?: number;
}

export interface ApolloResponse {
  people?: any[];
  pagination?: {
    page: number;
    per_page: number;
    total_entries: number;
    total_pages: number;
  };
  breadcrumbs?: any[];
}

export class ApolloService {
  private apiKey: string;
  private baseUrl: string;
  private currentPage: number = 1;
  private fetchedLeadIds: Set<string> = new Set();
  private existingApolloIds: Set<string> = new Set();
  private lastSheetCheckTime: number = 0;
  private sheetCheckInterval: number = 5 * 60 * 1000; // 5 minutes

  constructor() {
    this.apiKey = CONFIG.APOLLO_API_KEY;
    this.baseUrl = 'https://api.apollo.io/api/v1';
    
    if (!this.apiKey) {
      throw new Error('Apollo API key is required');
    }
  }

  /**
   * Set existing Apollo IDs from Google Sheets to prevent duplicates
   * This should be called by the workflow processor before fetching leads
   */
  setExistingApolloIds(apolloIds: string[]): void {
    this.existingApolloIds = new Set(apolloIds.filter(id => id && id.trim()));
    this.lastSheetCheckTime = Date.now();
    console.log(`📋 Loaded ${this.existingApolloIds.size} existing Apollo IDs from sheet for duplicate checking`);
  }

  /**
   * Check if sheet data should be refreshed (called periodically)
   */
  shouldRefreshSheetData(): boolean {
    return Date.now() - this.lastSheetCheckTime > this.sheetCheckInterval;
  }

  /**
   * Simple URL normalization for LinkedIn URLs
   */
  private normalizeLinkedInUrl(url: string): string {
    if (!url || typeof url !== 'string') {
      return '';
    }

    let cleanUrl = url.trim();
    
    // Remove tracking parameters and fragments
    cleanUrl = cleanUrl.split('?')[0].split('#')[0];
    
    // Add https if missing
    if (!cleanUrl.startsWith('http')) {
      cleanUrl = `https://${cleanUrl}`;
    }

    try {
      const urlObj = new URL(cleanUrl);
      // Normalize to standard LinkedIn format
      if (urlObj.hostname.includes('linkedin.com')) {
        return `https://www.linkedin.com${urlObj.pathname}`;
      }
    } catch (error) {
      console.warn(`⚠️ Could not normalize URL: ${url}`);
    }

    return cleanUrl;
  }

  /**
   * Get basic lead data from Apollo API - only essential fields
   * Uses pagination to avoid fetching duplicate leads
   * Trusts Apollo's data quality for LinkedIn URLs
   * Automatically advances pages when duplicates are found to ensure new leads
   */
  async getLeads(limit: number = 50): Promise<any[]> {
    const params = {
      personTitles: [
        'VP Growth',
        'Head Of Marketing', 
        'Director of eCommerce',
        'Chief Marketing Officer',
        'Chief Product Officer',
        'VP of Content',
        'CEO',
        'CTO', 
        'Founder',
        'VP'
      ],
      personLocations: ['USA', 'India'],
      seniorities: ['director', 'vp', 'head', 'manager', 'c_suite'],
      technologies: [
        'Shopify',
        'Klaviyo', 
        'Woo Commerce',
        'Magento',
        'Big Commerce',
        'Adobe Commerce'
      ],
      includeSimilarTitles: true,
      contactEmailStatus: ['verified'],
      organizationEmployeeRanges: ['51-1000'],
      revenueMin: 5000000,
      revenueMax: 500000000,
      perPage: Math.max(limit, 20), // Fetch more per page to reduce API calls
      page: this.currentPage
    };

    const allNewLeads: any[] = [];
    let attempts = 0;
    const maxAttempts = 10; // Prevent infinite loops
    let totalPages = 1;

    console.log(`🔍 Starting Apollo search from page ${this.currentPage}, targeting ${limit} new leads`);

    try {
      while (allNewLeads.length < limit && attempts < maxAttempts) {
        attempts++;
        
        // Update page in params for current request
        params.page = this.currentPage;
        
        const queryString = this.buildQueryString(params);
        const apiUrl = `${this.baseUrl}/mixed_people/search?${queryString}`;

        console.log(`📄 Apollo API - Attempt ${attempts}, Page ${this.currentPage}`);

        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'x-api-key': this.apiKey,
            'Accept': 'application/json',
            'Cache-Control': 'no-cache',
          },
        });

        if (!response.ok) {
          throw new Error(`Apollo API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as ApolloResponse;
        
        // Update total pages from first response
        if (data.pagination) {
          totalPages = data.pagination.total_pages;
        }

        if (!data.people || data.people.length === 0) {
          console.log(`📄 No more leads available from Apollo (page ${this.currentPage})`);
          break;
        }

        // Filter out leads that already exist in sheet (by Apollo ID) and in current session
        const filteredPeople = (data.people || [])
          .filter((person: any) => {
            // Check if Apollo ID already exists in Google Sheets
            if (this.existingApolloIds.has(person.id)) {
              return false;
            }
            
            // Check if already fetched in current session
            if (this.fetchedLeadIds.has(person.id)) {
              return false;
            }
            
            // Basic data validation - ensure required fields exist
            if (!person.first_name || !person.email || !person.linkedin_url) {
              console.warn(`⚠️ Skipping lead with missing required fields: ${person.first_name || 'N/A'} ${person.last_name || 'N/A'}`);
              return false;
            }
            
            return true;
          });

        const duplicatesInSheet = data.people.length - filteredPeople.length - (data.people.filter((p: any) => this.fetchedLeadIds.has(p.id)).length);
        const duplicatesInSession = data.people.filter((p: any) => this.fetchedLeadIds.has(p.id)).length;

        console.log(`📊 Page ${this.currentPage}: Found ${data.people.length} total leads`);
        console.log(`   - ${duplicatesInSheet} already in Google Sheets`);
        console.log(`   - ${duplicatesInSession} already in current session`);
        console.log(`   - ${filteredPeople.length} are completely new`);

        // If no new leads on this page, move to next page
        if (filteredPeople.length === 0) {
          console.log(`⏭️ No new leads on page ${this.currentPage}, advancing to next page`);
          this.currentPage++;
          
          // Check if we've reached the end of pages
          if (this.currentPage > totalPages) {
            console.log('🔄 Reached end of Apollo results, resetting to page 1');
            this.currentPage = 1;
            break; // Exit to prevent infinite loop
          }
          continue;
        }

        // Process leads without LinkedIn URL validation - trust Apollo's data
        for (const person of filteredPeople) {
          // Check if we already have enough leads
          if (allNewLeads.length >= limit) {
            break;
          }

          // Track this lead as fetched
          this.fetchedLeadIds.add(person.id);
          
          // Normalize LinkedIn URL but don't validate
          const normalizedLinkedInUrl = this.normalizeLinkedInUrl(person.linkedin_url);
          
          allNewLeads.push({
            id: person.id,
            first_name: person.first_name,
            last_name: person.last_name,
            full_name: `${person.first_name} ${person.last_name}`,
            email: person.email,
            phone: person.organization?.primary_phone?.sanitized_number || '',
            linkedin_url: normalizedLinkedInUrl
          });

          console.log(`✅ Added lead ${allNewLeads.length}/${limit}: ${person.first_name} ${person.last_name}`);
        }

        // Move to next page for subsequent attempts if we need more leads
        if (allNewLeads.length < limit) {
          this.currentPage++;
          
          // Check if we've reached the end of pages
          if (this.currentPage > totalPages) {
            console.log('🔄 Reached end of Apollo results, resetting to page 1');
            this.currentPage = 1;
            break;
          }
        }
      }

      // Update current page for next call (only if we got leads successfully)
      if (allNewLeads.length > 0) {
        this.currentPage++;
        
        // Reset pagination if we reach the end
        if (this.currentPage > totalPages) {
          console.log('🔄 Apollo pagination complete, resetting to page 1 for next cycle');
          this.currentPage = 1;
        }
      }

      console.log(`📊 Apollo search completed: Found ${allNewLeads.length} new leads after ${attempts} page(s)`);
      
      if (allNewLeads.length === 0) {
        console.warn('⚠️ No new leads found after searching multiple pages. Consider:');
        console.warn('   - Clearing fetched leads cache if all leads have been processed');
        console.warn('   - Adjusting search criteria to find new leads');
        console.warn('   - Checking if Apollo has more data available');
        console.warn('   - Note: Trusting Apollo data quality without LinkedIn URL validation');
      }

      return allNewLeads;

    } catch (error) {
      console.error('Error calling Apollo API:', error);
      throw new Error(
        `Failed to fetch leads from Apollo API: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  /**
   * Update lead status in Apollo (for tracking purposes)
   */
  async updateLeadStatus(apolloId: string, status: string): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/contacts/${apolloId}`, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          labels: [status]
        })
      });

      if (!response.ok) {
        console.warn(`Failed to update Apollo lead status: ${response.status}`);
      }
    } catch (error) {
      console.error('Error updating lead status in Apollo:', error);
    }
  }

  /**
   * Build query string from search parameters
   */
  private buildQueryString(params: any): string {
    let queryString = '';
    
    // Handle array parameters
    if (params.personTitles) {
      params.personTitles.forEach((title: string) => {
        queryString += `person_titles[]=${encodeURIComponent(title)}&`;
      });
    }
    
    if (params.personLocations) {
      params.personLocations.forEach((location: string) => {
        queryString += `person_locations[]=${encodeURIComponent(location)}&`;
      });
    }
    
    if (params.seniorities) {
      params.seniorities.forEach((seniority: string) => {
        queryString += `person_seniorities[]=${encodeURIComponent(seniority)}&`;
      });
    }
    
    if (params.technologies) {
      params.technologies.forEach((tech: string) => {
        queryString += `currently_using_any_of_technology_uids[]=${encodeURIComponent(tech)}&`;
      });
    }

    if (params.contactEmailStatus) {
      params.contactEmailStatus.forEach((status: string) => {
        queryString += `contact_email_status[]=${encodeURIComponent(status)}&`;
      });
    }

    if (params.organizationEmployeeRanges) {
      params.organizationEmployeeRanges.forEach((range: string) => {
        queryString += `organization_num_employees_ranges[]=${encodeURIComponent(range)}&`;
      });
    }

    // Handle other parameters
    if (params.includeSimilarTitles !== undefined) {
      queryString += `include_similar_titles=${params.includeSimilarTitles}&`;
    }

    if (params.revenueMin !== undefined) {
      queryString += `revenue_range[min]=${params.revenueMin}&`;
    }

    if (params.revenueMax !== undefined) {
      queryString += `revenue_range[max]=${params.revenueMax}&`;
    }

    if (params.perPage !== undefined) {
      queryString += `per_page=${params.perPage}&`;
    }

    if (params.page !== undefined) {
      queryString += `page=${params.page}&`;
    }

    // Add empty technology filter (as per original curl)
    queryString += 'currently_using_all_of_technology_uids[]=&';

    // Remove trailing '&'
    return queryString.slice(0, -1);
  }

  /**
   * Reset pagination to start from the beginning
   * Useful when you want to start a fresh cycle
   */
  resetPagination(): void {
    this.currentPage = 1;
    console.log('🔄 Apollo pagination reset to page 1');
  }

  /**
   * Clear the cache of fetched lead IDs (session-based)
   * This should be called periodically to avoid memory buildup
   * Call this when you want to restart getting leads from the beginning
   */
  clearFetchedLeadsCache(): void {
    this.fetchedLeadIds.clear();
    console.log('🧹 Apollo session cache cleared');
  }

  /**
   * Clear existing Apollo IDs from sheet (forces refresh from Google Sheets)
   */
  clearExistingApolloIds(): void {
    this.existingApolloIds.clear();
    this.lastSheetCheckTime = 0;
    console.log('🧹 Apollo sheet-based duplicate cache cleared');
  }

  /**
   * Force clear all caches and reset pagination
   * Use this when you want to completely restart the Apollo lead fetching process
   */
  resetLeadFetching(): void {
    this.fetchedLeadIds.clear();
    this.existingApolloIds.clear();
    this.currentPage = 1;
    this.lastSheetCheckTime = 0;
    console.log('🔄 Apollo lead fetching completely reset - all caches cleared and pagination reset to page 1');
  }

  /**
   * Get comprehensive status for debugging
   */
  getPaginationStatus(): { 
    currentPage: number; 
    sessionCacheSize: number;
    sheetCacheSize: number;
    lastSheetCheck: string;
    shouldRefreshSheet: boolean;
  } {
    return {
      currentPage: this.currentPage,
      sessionCacheSize: this.fetchedLeadIds.size,
      sheetCacheSize: this.existingApolloIds.size,
      lastSheetCheck: new Date(this.lastSheetCheckTime).toISOString(),
      shouldRefreshSheet: this.shouldRefreshSheetData()
    };
  }

  /**
   * Check if we might be running out of new leads
   * Returns true if cache is getting large compared to expected results
   */
  shouldConsiderCacheReset(): boolean {
    const sessionCacheSize = this.fetchedLeadIds.size;
    const sheetCacheSize = this.existingApolloIds.size;
    const totalProcessed = sessionCacheSize + sheetCacheSize;
    const threshold = 1000; // Reset if we've processed 1000+ leads
    
    if (totalProcessed >= threshold) {
      console.warn(`⚠️ Large lead cache detected (${totalProcessed} total: ${sessionCacheSize} session + ${sheetCacheSize} sheet).`);
      console.warn(`   Consider calling resetLeadFetching() to restart from fresh leads.`);
      return true;
    }
    
    return false;
  }
}