import { GoogleSheetsService } from './googleSheets';
import { ApolloService } from './apollo';
import { ApifyService } from './apify';
import { UnipileService } from './unipile';
import { LLMService } from './llm';
import { RateLimiterService } from './rateLimiter';
import { DelayManager } from './delayManager';
import { FailureManager } from './failureManager';
import { getAccountManager } from './accountManager';
import { Lead, PipelineStatus } from '@/types';
import { CONFIG } from '../../config/config';
import moment from 'moment';
import { PostsSheetService } from './postsSheet';
import { PostRecordInput } from '@/types/postsSheet';
import { UnipilePost } from '@/types/postFilter';
import { EnhancedPostFilterService } from './enhancedPostFilter';

interface StatusTransition {
  from: Lead['status'];
  to: Lead['status'];
  isValid: boolean;
  reason?: string;
}

export class StatusTransitionValidator {
  private static readonly VALID_TRANSITIONS: Record<Lead['status'], Lead['status'][]> = {
    new: ['lead_enriched', 'new', 'failed'],
    lead_enriched: ['posts_liked', 'posts_commented', 'failed', 'lead_enriched'], // Allow retry from earlier step
    posts_liked: ['posts_commented', 'failed', 'posts_liked' ], // Allow retry from earlier step
    posts_commented: ['invitation_sent', 'failed', 'posts_commented'], // Allow retry from earlier step
    invitation_sent: ['connected', 'failed', 'invitation_sent'], // Allow retry from earlier step
    connected: ['first_message_sent', 'failed', 'connected'], // Allow retry from earlier step
    first_message_sent: ['completed', 'failed', 'first_message_sent'], // Allow retry from earlier step
    completed: [], // Terminal state
    failed: [
      'new',
      'lead_enriched',
      'posts_liked',
      'posts_commented',
      'invitation_sent',
      'connected',
      'first_message_sent',
    ], // Can restart from any step
  };

  // Special validation for retry scenarios
  private static readonly RETRY_TRANSITIONS: Record<Lead['status'], Lead['status'][]> = {
    new: ['new'], // Can retry enrichment
    lead_enriched: ['new', 'lead_enriched'], // Can retry enrichment or post liking
    posts_liked: ['lead_enriched', 'posts_liked'], // Can retry from enrichment or post liking
    posts_commented: ['posts_liked', 'posts_commented'], // Can retry from post liking or commenting
    invitation_sent: ['posts_commented', 'invitation_sent'], // Can retry from commenting or invitations
    connected: ['invitation_sent', 'connected'], // Can retry from invitations or connection check
    first_message_sent: ['connected', 'first_message_sent'], // Can retry from connection or messaging
    completed: [],
    failed: [
      'new',
      'lead_enriched',
      'posts_liked',
      'posts_commented',
      'invitation_sent',
      'connected',
      'first_message_sent',
    ],
  };

  static validateTransition(
    currentStatus: Lead['status'],
    newStatus: Lead['status']
  ): StatusTransition {
    const validNextStates = this.VALID_TRANSITIONS[currentStatus] || [];

    if (validNextStates.includes(newStatus)) {
      return { from: currentStatus, to: newStatus, isValid: true };
    }

    return {
      from: currentStatus,
      to: newStatus,
      isValid: false,
      reason: `Invalid transition from '${currentStatus}' to '${newStatus}'. Valid next states: ${validNextStates.join(
        ', '
      )}`,
    };
  }

  static getValidNextStates(currentStatus: Lead['status']): Lead['status'][] {
    return this.VALID_TRANSITIONS[currentStatus] || [];
  }

  static isValidNextStatus(currentStatus: Lead['status'], newStatus: Lead['status']): boolean {
    return this.validateTransition(currentStatus, newStatus).isValid;
  }

  // Special validation for retry scenarios - more lenient
  static validateRetryTransition(
    currentStatus: Lead['status'],
    newStatus: Lead['status'],
    isRetry: boolean = false
  ): StatusTransition {
    if (!isRetry) {
      return this.validateTransition(currentStatus, newStatus);
    }

    // For retry scenarios, use the more lenient RETRY_TRANSITIONS
    const validRetryStates = this.RETRY_TRANSITIONS[currentStatus] || [];

    if (validRetryStates.includes(newStatus)) {
      return { from: currentStatus, to: newStatus, isValid: true };
    }

    // Fall back to normal validation
    return this.validateTransition(currentStatus, newStatus);
  }

  static isValidRetryTransition(currentStatus: Lead['status'], newStatus: Lead['status']): boolean {
    return this.validateRetryTransition(currentStatus, newStatus, true).isValid;
  }
}

export class WorkflowProcessor {
  private sheetsService: GoogleSheetsService;
  private apolloService: ApolloService;
  private apifyService: ApifyService;
  private unipileService: UnipileService;
  private llmService: LLMService;
  private rateLimiter: RateLimiterService;
  private failureManager: FailureManager;
  private postsSheetService: PostsSheetService;
  private enhancedPostFilterService: EnhancedPostFilterService;

  constructor() {
    this.sheetsService = new GoogleSheetsService();
    this.apolloService = new ApolloService();
    this.apifyService = new ApifyService();
    this.unipileService = new UnipileService();
    this.llmService = new LLMService();
    this.rateLimiter = new RateLimiterService();
    this.failureManager = new FailureManager();
    this.postsSheetService = new PostsSheetService();
    this.enhancedPostFilterService = new EnhancedPostFilterService(this.llmService);
  }

  // Smart cycle that processes existing leads before adding new ones
  async runSmartCycle(): Promise<void> {
    console.log('🤖 Running smart processing cycle...');

    try {
      // 0. Process retry-ready failed leads first (highest priority)
      await this.processRetryableLeads();

      // 1. Check pipeline status
      const pipelineStatus = await this.analyzePipeline();

      // 2. Process existing leads by priority
      await this.processExistingLeads(pipelineStatus);

      // 3. Only add new leads if pipeline needs them
      await this.addLeadsIfNeeded(pipelineStatus);

      console.log('✅ Smart cycle completed successfully');
    } catch (error) {
      console.error('❌ Error in smart cycle:', error);
    }
  }

  //  Analyze current pipeline status
  private async analyzePipeline(): Promise<PipelineStatus> {
    console.log('📊 Analyzing pipeline status...');

    const statusCounts = {
      new: (await this.sheetsService.getLeadsByStatus('new')).length,
      lead_enriched: (await this.sheetsService.getLeadsByStatus('lead_enriched')).length,
      posts_liked: (await this.sheetsService.getLeadsByStatus('posts_liked')).length,
      posts_commented: (await this.sheetsService.getLeadsByStatus('posts_commented')).length,
      invitation_sent: (await this.sheetsService.getLeadsByStatus('invitation_sent')).length,
      connected: (await this.sheetsService.getLeadsByStatus('connected')).length,
    };

    const totalInPipeline = Object.values(statusCounts).reduce((a, b) => a + b, 0);
    const needsNewLeads = totalInPipeline < CONFIG.PIPELINE.MIN_LEADS_IN_PIPELINE;

    console.log('📈 Pipeline Status:', statusCounts);
    console.log(`📊 Total leads in pipeline: ${totalInPipeline}`);
    console.log(`🎯 Needs new leads: ${needsNewLeads ? 'Yes' : 'No'}`);

    return {
      counts: statusCounts,
      total: totalInPipeline,
      needsNewLeads,
      processingPriority: this.determinePriority(statusCounts),
    };
  }

  //  Process existing leads in smart order
  private async processExistingLeads(status: PipelineStatus): Promise<void> {
    console.log('⚡ Processing existing leads by priority...');

    // 1. Connection checking is now handled by webhooks automatically  
    // Connections are processed in real-time via /api/webhook/connection-accepted
    // No polling needed - webhook system provides instant updates

    // 2. Send messages (if 1+ hour passed and within rate limit)
    if (status.counts.connected > 0) {
      console.log('💌 Priority 1: Sending messages...');
      await this.processSendMessages();
      await DelayManager.randomPriorityStepDelay('AFTER_MESSAGING');
    }

    // 3. Send invitations (if 30+ min passed and within rate limit)  
    if (status.counts.posts_commented > 0) {
      console.log('🤝 Priority 2: Sending invitations...');
      try {
        await this.processSendInvitations();
      } catch (error) {
        console.error('❌ Error sending invitations:', error);
        throw new Error(
          `Failed to send invitations: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      //not needed but lets keep it for consistency
      await DelayManager.randomPriorityStepDelay('AFTER_INVITATIONS');
    }

    // 4. Comment on posts (within rate limit)
    if (status.counts.posts_liked > 0) {
      console.log('💬 Priority 3: Commenting on posts...');
      await this.processPostCommenting();
      await DelayManager.randomPriorityStepDelay('AFTER_COMMENTING');
    }

    // 5. Like posts (within rate limit)
    if (status.counts.lead_enriched > 0) {
      console.log('👍 Priority 4: Liking posts...');
      await this.processPostLiking();
      await DelayManager.randomPriorityStepDelay('AFTER_LIKING');
    }

    // 6. Enrich leads (if we have new leads waiting)
    if (status.counts.new > 0) {
      console.log('🔍 Priority 6: Enriching leads...');
      await this.processLeadEnrichment();
    }
  }

  //  Add leads only when pipeline needs them
  private async addLeadsIfNeeded(status: PipelineStatus): Promise<void> {
    if (status.needsNewLeads) {
      console.log(
        `📥 Pipeline needs fresh leads (${status.total} < ${CONFIG.PIPELINE.MIN_LEADS_IN_PIPELINE})`
      );
      console.log('🔄 Fetching new leads from Apollo...');
      await this.processNewLeads();
    } else {
      console.log(
        `📊 Pipeline has enough leads (${status.total} >= ${CONFIG.PIPELINE.MIN_LEADS_IN_PIPELINE})`
      );
      console.log('⏭️  Skipping Apollo fetch this cycle');
    }
  }

  //  Determine processing priority based on pipeline status
  private determinePriority(counts: PipelineStatus['counts']): string[] {
    const priority = [];

    if (counts.invitation_sent > 0) priority.push('check_connections');
    if (counts.connected > 0) priority.push('send_messages');
    if (counts.posts_commented > 0) priority.push('send_invitations');
    if (counts.posts_liked > 0) priority.push('comment_posts');
    if (counts.lead_enriched > 0) priority.push('like_posts');
    if (counts.new > 0) priority.push('enrich_leads');

    return priority;
  }

  // Run before each workflow to handle manual changes
  private async performHealthCheck(): Promise<void> {
    try {
      console.log('🔍 Performing health check on Google Sheets data...');
      await this.sheetsService.detectManualChanges();
    } catch (error) {
      console.warn('Health check failed, continuing with caution:', error);
    }
  }

  //  Enhanced to prevent Apollo ID duplicates and handle LinkedIn URL validation
  async processNewLeads(): Promise<void> {
    console.log('Processing new leads...');
    await this.performHealthCheck();

    try {
      // Check if we should limit the number of leads to fetch
      const leadsToFetch = CONFIG.PIPELINE.LEADS_TO_FETCH || 10;

      // Get existing Apollo IDs from Google Sheets to prevent duplicates
      console.log('🔍 Checking Google Sheets for existing Apollo IDs...');
      
      // Check if Apollo service needs a refresh of sheet data
      if (this.apolloService.shouldRefreshSheetData()) {
        console.log('⏰ Apollo service sheet data is stale, refreshing...');
      }
      
      const allExistingLeads = (await this.sheetsService.getAllLeads()).filter(lead => lead !== null);
      const existingApolloIds = allExistingLeads
        .map((lead: any) => lead.apolloId)
        .filter((id: string) => id && id.trim());
      
      console.log(`📋 Found ${existingApolloIds.length} existing Apollo IDs in Google Sheets`);
      
      // Set existing Apollo IDs in Apollo service for duplicate checking
      this.apolloService.setExistingApolloIds(existingApolloIds);

      // Fetch basic leads from Apollo (only leads with valid LinkedIn URLs and not in sheets)
      const apolloLeads = await this.apolloService.getLeads(leadsToFetch);

      if (apolloLeads.length === 0) {
        console.log('⚠️ No new leads returned from Apollo');
        console.log('   - All leads may be duplicates already in Google Sheets');
        console.log('   - Or all LinkedIn URLs may be invalid');
        console.log('   - Consider adjusting search criteria or clearing Apollo cache');
        return;
      }

      let addedCount = 0;
      let skippedCount = 0;

      for (const apolloLead of apolloLeads) {
        // Validate required fields before processing
        if (!apolloLead.first_name || !apolloLead.email || !apolloLead.linkedin_url) {
          console.warn('Skipping Apollo lead with missing required fields:', {
            id: apolloLead.id,
            hasFirstName: !!apolloLead.first_name,
            hasEmail: !!apolloLead.email,
            hasLinkedInUrl: !!apolloLead.linkedin_url
          });
          skippedCount++;
          continue;
        }

        // Double-check Apollo ID doesn't exist (backup check)
        const isDuplicate = existingApolloIds.includes(apolloLead.id);
        if (isDuplicate) {
          console.warn(`⚠️ Skipping duplicate Apollo ID ${apolloLead.id} for ${apolloLead.first_name} ${apolloLead.last_name}`);
          skippedCount++;
          continue;
        }

        // Create lead with only Apollo basic data (account assignment happens during enrichment)
        const lead: Lead = {
          id: `lead_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
          firstName: apolloLead.first_name || '',
          lastName: apolloLead.last_name || '',
          fullName: apolloLead.full_name || `${apolloLead.first_name} ${apolloLead.last_name}`,
          email: apolloLead.email || '',
          phone: apolloLead.phone || '', // Basic phone from Apollo
          linkedinUrl: apolloLead.linkedin_url || '', // Already validated and normalized by Apollo service
          status: 'new',
          apolloId: apolloLead.id, // This is the key field for duplicate checking
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          linkedinUrn: '',
        };

        await this.sheetsService.addLead(lead);
        //await this.apolloService.updateLeadStatus(apolloLead.id, 'new');

        console.log(`✅ Added new lead: ${lead.firstName} ${lead.lastName} (Apollo ID: ${lead.apolloId}) - Account will be assigned during enrichment`);
        addedCount++;

        // Small delay between adding leads
        await DelayManager.fixedDelay(2);
      }

      console.log(`📈 Lead processing summary:`);
      console.log(`   ✅ Added to sheet: ${addedCount}`);
      console.log(`   ⚠️ Skipped (missing data): ${skippedCount}`);
      console.log(`   📊 Total valid from Apollo: ${apolloLeads.length}`);
      console.log(`   🔍 Existing in sheet: ${existingApolloIds.length}`);
      
      if (addedCount === 0) {
        console.warn('⚠️ No leads were added to the pipeline. Possible reasons:');
        console.warn('   - All leads from Apollo already exist in Google Sheets');
        console.warn('   - All leads have invalid LinkedIn URLs');
        console.warn('   - Apollo search criteria may need adjustment');
        
        // Check if we should suggest cache reset
        if (this.apolloService.shouldConsiderCacheReset()) {
          console.warn('   - Consider calling apolloService.resetLeadFetching() to restart with fresh leads');
        }
      }
      
    } catch (error) {
      console.error('Error processing new leads:', error);
      throw new Error(`Failed to process new leads: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async processLeadEnrichment(): Promise<void> {
    console.log('Processing lead enrichment...');
    await this.performHealthCheck();

    const newLeads = await this.sheetsService.getLeadsByStatus('new');
    console.log(`Found ${newLeads.length} leads with 'new' status`);

    for (const lead of newLeads.slice(0, 5)) {
      try {
        // ✅ ADD STATUS VALIDATION
        if (!StatusTransitionValidator.isValidNextStatus(lead.status, 'lead_enriched')) {
          console.warn(
            `⚠️ Skipping ${lead.firstName} - invalid status for enrichment: ${lead.status}`
          );
          console.warn(
            `   Valid next states: ${StatusTransitionValidator.getValidNextStates(lead.status).join(
              ', '
            )}`
          );
          continue;
        }

        // Validate lead has required data before enriching
        if (!lead.linkedinUrl || !lead.id) {
          console.warn(`Skipping lead enrichment - missing data:`, {
            id: lead.id,
            hasLinkedinUrl: !!lead.linkedinUrl,
          });
          continue;
        }

        console.log(`Enriching lead: ${lead.firstName} ${lead.lastName}`);
        const enrichedData = await this.apifyService.enrichLeadData(lead.linkedinUrl);

        if (enrichedData) {
          // Cast enriched data to a safe type
          const data = enrichedData as Record<string, unknown>;
          const currentPos = data.currentPosition as Record<string, unknown> | undefined;

          // Parse comprehensive data from Apify
          const parsedData = {
            linkedinProfileData: enrichedData, // Full JSON backup
            email: (data.email as string)?.trim() || lead.email || '',
            // Core LinkedIn data
            linkedinUrn: this.extractLinkedInUrn(data),
            profileHeadline: (data.headline as string) || (data.description as string) || '',

            // Job and company information (Apify takes priority over Apollo)
            jobTitle:
              (data.jobTitle as string) ||
              
              (currentPos?.title as string) ||
              (data.position as string) ||
              (data.occupation as string) ||
              '',

            company:
              (data.companyName as string) ||
              (currentPos?.companyName as string) ||
              (data.company as string) ||
              (data.organization as string) ||
              '',

            companyWebsite:
              (data.companyWebsite as string) ||
              (currentPos?.companyWebsite as string) ||
              (data.website as string) ||
              '',

            companyIndustry:
              (data.companyIndustry as string) ||
              (currentPos?.industry as string) ||
              '',

            companySize: this.formatCompanySize(
              data.companySize || currentPos?.companySize || data.employeeCount
            ),

            // Social metrics
            connectionCount: this.parseNumber(
              data.connectionsCount || data.connections || data.networkSize
            ),

            followerCount: this.parseNumber(
              data.followersCount || data.followers || data.followerCount
            ),

            // Phone priority: Apify first, then Apollo
            phone: (data.mobileNumber as string) || lead.phone || '',
          };

          // ✅ NEW: Clear failure data if this lead had previous failures for this step
          const clearFailureData = this.failureManager.clearFailureData(lead, 'lead_enriched');
          
          // Assign LinkedIn account after successful enrichment
          const assignedAccountId = getAccountManager().assignAccountToLead();
          console.log(`🎯 Assigned LinkedIn account: ${getAccountManager().getAccountName(assignedAccountId)}`);
          
          // Get sales person info from LinkedIn account config
          const linkedinAccounts = CONFIG.LINKEDIN_ACCOUNTS;
          const assignedAccount = linkedinAccounts.find((acc: any) => acc.unipileAccountId === assignedAccountId);
          const salesPersonEmail = assignedAccount?.emailAddress || '';
          const salesPersonName = assignedAccount?.name || '';
          
          // Find matching email account for this sales person
          const emailAccounts = await this.sheetsService.getAllEmailAccounts();
          const matchingEmailAccount = emailAccounts.find(emailAcc => 
            emailAcc.emailAddress === salesPersonEmail && emailAcc.isActive
          );
          
          const assignedEmailAccount = matchingEmailAccount?.id || '';
          
          if (assignedEmailAccount) {
            console.log(`📧 Assigned email account: ${salesPersonEmail}`);
          } else {
            console.warn(`⚠️ No active email account found for sales person: ${salesPersonEmail}`);
          }
          
          await this.sheetsService.updateLeadStatus(lead.id, 'lead_enriched', {
            ...parsedData,
            ...clearFailureData, // Clear any retry/failure tracking data
            linkedinAccountId: assignedAccountId,
            assignedSalesPerson: salesPersonName,
            assignedEmailAccount: assignedEmailAccount,
            emailStatus: 'not_started' // Initialize email status
          });
          console.log(`✅ Enriched lead: ${lead.firstName} ${lead.lastName} → ${getAccountManager().getAccountName(assignedAccountId)}`);

          // Log key extracted data for verification
          console.log(`   🏢 Company: ${parsedData.company} (${parsedData.companyIndustry})`);
          console.log(`   💼 Title: ${parsedData.jobTitle}`);
          console.log(
            `   🔗 Social: ${parsedData.connectionCount} connections, ${parsedData.followerCount} followers`
          );
          console.log(`   📞 Phone: ${parsedData.phone ? 'Found' : 'Not found'}`);
        } else {
          console.warn(`No enriched data returned for ${lead.firstName}`);
          // Handle failure using FailureManager
          const { newStatus, additionalData } = this.failureManager.handleFailure(
            lead,
            'lead_enriched',
            'No data returned from Apify'
          );
          await this.sheetsService.updateLeadStatus(lead.id, newStatus, additionalData);
        }
      } catch (error) {
        console.error(`❌ Error enriching lead ${lead.id}:`, error);

        // Handle failure using FailureManager
        const { newStatus, additionalData } = this.failureManager.handleFailure(
          lead,
          'lead_enriched',
          `Enrichment failed: ${error instanceof Error ? error.message : String(error)}`
        );
        await this.sheetsService.updateLeadStatus(lead.id, newStatus, additionalData);
      }
    }
  }

    // 2. Update processPostLiking method
  async processPostLiking(): Promise<void> {
    console.log('🔍 Processing post liking with LLM-powered strict filtering...');
    await this.performHealthCheck();

    const enrichedLeads = await this.sheetsService.getLeadsByStatus('lead_enriched');
    console.log(`Found ${enrichedLeads.length} leads ready for intelligent post analysis`);

    for (const lead of enrichedLeads.slice(0, 3)) {
      if (!StatusTransitionValidator.isValidNextStatus(lead.status, 'posts_liked')) {
        console.warn(`⚠️ Skipping ${lead.firstName} - invalid status for post liking: ${lead.status}`);
        continue;
      }

      if (!(await this.rateLimiter.canPerformAction('postsLiked'))) {
        console.log('⏸️ Daily limit reached for post liking');
        break;
      }

      try {
        if (!lead.linkedinUrn || !lead.id) {
          console.warn(`Skipping post liking - missing linkedinUrn or id for ${lead.firstName}`);
          continue;
        }

        console.log(`🤖 Step 1: Fetching and LLM-analyzing posts for ${lead.firstName} ${lead.lastName}`);

        // Fetch posts from LinkedIn API
        let allPosts: UnipilePost[];
        try {
          allPosts = await this.unipileService.getUserPosts(lead.linkedinUrn, lead.linkedinAccountId!, 10);
        } catch (error) {
          console.error(`❌ Error fetching posts for ${lead.firstName}:`, error);
          const { newStatus, additionalData } = this.failureManager.handleFailure(
            lead,
            'posts_liked',
            `Failed to fetch posts: ${error instanceof Error ? error.message : String(error)}`
          );
          await this.sheetsService.updateLeadStatus(lead.id, newStatus, additionalData);
          continue;
        }

        // 🤖 LLM-powered strict filtering
        console.log(`🧠 Step 2: LLM analyzing ${allPosts.length} posts for business relevance...`);
        const filterResult = await this.enhancedPostFilterService.filterBusinessRelevantPosts(allPosts);

        if (filterResult.relevantPosts.length === 0) {
          console.warn(`🚫 No business-relevant posts found for ${lead.firstName} after LLM analysis of ${filterResult.totalPosts} posts`);
          
          // Skip to next workflow step with detailed reason
          await this.skipPostInteractionSteps(
            lead,
            `LLM analysis: No business-relevant posts found (analyzed ${filterResult.totalPosts} posts, all filtered out)`
          );
          continue;
        }

        console.log(`✅ LLM approved ${filterResult.relevantPosts.length} high-quality business posts for ${lead.firstName}`);

        // Store in Posts sheet
        console.log(`📝 Step 3: Storing LLM-approved posts in Posts sheet...`);
        const postsToStore: PostRecordInput[] = filterResult.relevantPosts.map((post) => {
          const originalCreatedAt = new Date();
          originalCreatedAt.setDate(originalCreatedAt.getDate() - post.daysOld);

          return {
            linkedinUrn: lead.linkedinUrn!,
            postId: post.postId,
            postContent: post.content,
            authorName: post.authorName,
            authorId: post.authorId,
            postType: post.postType,
            relevanceScore: post.relevanceScore,
            engagementScore: post.engagementScore,
            canComment: post.canComment,
            shareUrl: post.shareUrl,
            repostCommentary: post.repostCommentary,
            daysOld: post.daysOld,
            originalCreatedAt: originalCreatedAt.toISOString(),
          };
        });

        await this.postsSheetService.storePosts(postsToStore);

        // Like the LLM-approved posts
        console.log(`👍 Step 4: Liking LLM-approved business posts for ${lead.firstName}...`);
        const likedPostIds: string[] = [];
        const likeResults: any[] = [];
        const maxPostsToLike = Math.min(filterResult.relevantPosts.length, 2);

        for (let i = 0; i < maxPostsToLike; i++) {
          const post = filterResult.relevantPosts[i];

          if (!(await this.rateLimiter.canPerformActionForAccount(lead.linkedinAccountId!, 'postsLiked'))) {
            console.log(`⏸️ Rate limit reached, stopping at ${likedPostIds.length} posts for ${lead.firstName}`);
            break;
          }

          try {
            const success = await this.unipileService.likePost(post.postId, lead.linkedinAccountId!);

            if (success) {
              await this.rateLimiter.recordSuccessfulActionForAccount(lead.linkedinAccountId!, 'postsLiked');
              likedPostIds.push(post.postId);
              likeResults.push({ success: true, postId: post.postId });

              // Mark in Posts sheet
              await this.postsSheetService.markPostAsLiked(lead.linkedinUrn, post.postId);
              
              console.log(`✅ Liked high-quality business post from ${post.authorName} (LLM confidence: ${post.relevanceScore}/10)`);
              await DelayManager.randomDelay('LIKE_POST');
            } else {
              likeResults.push({ success: false, postId: post.postId, error: 'API returned false' });
            }
          } catch (likeError) {
            console.error(`❌ Error liking post ${post.postId}:`, likeError);
            likeResults.push({ 
              success: false, 
              postId: post.postId, 
              error: likeError instanceof Error ? likeError.message : String(likeError)
            });
          }
        }

        // Update lead status based on results
        const successfulLikes = likeResults.filter(r => r.success).length;
        const totalPostsAttempted = likeResults.length;

        if (successfulLikes > 0) {
          // ✅ NEW: Clear failure data if this lead had previous failures for this step
          const clearFailureData = this.failureManager.clearFailureData(lead, 'posts_liked');
          
          await this.sheetsService.updateLeadStatus(lead.id, 'posts_liked', {
            likedPostIds,
            postsAnalyzed: filterResult.totalPosts,
            llmApprovedPosts: filterResult.relevantPosts.length,
            postsLiked: successfulLikes,
            totalPostsAttempted,
            lastPostAnalysis: new Date().toISOString(),
            filteringMethod: 'LLM_enhanced',
            ...clearFailureData // Clear any retry/failure tracking data
          });

          console.log(`🎯 Completed LLM-enhanced post liking for ${lead.firstName}: ${successfulLikes}/${totalPostsAttempted} posts liked successfully`);
        } else if (totalPostsAttempted > 0) {
          const failureDetails = likeResults.map(r => `${r.postId}: ${r.error}`).join('; ');
          const { newStatus, additionalData } = this.failureManager.handleFailure(
            lead,
            'posts_liked',
            `All ${totalPostsAttempted} LLM-approved posts failed to like: ${failureDetails}`
          );

          await this.sheetsService.updateLeadStatus(lead.id, newStatus, {
            ...additionalData,
            likedPostIds: [],
            postsAnalyzed: filterResult.totalPosts,
            llmApprovedPosts: filterResult.relevantPosts.length,
            totalPostsAttempted,
            failedLikeDetails: failureDetails,
          });
        }

      } catch (error) {
        console.error(`❌ Error in LLM-enhanced post liking workflow for lead ${lead.id}:`, error);
        
        const { newStatus, additionalData } = this.failureManager.handleFailure(
          lead,
          'posts_liked',
          `LLM post liking workflow failed: ${error instanceof Error ? error.message : String(error)}`
        );

        await this.sheetsService.updateLeadStatus(lead.id, newStatus, {
          ...additionalData,
          likedPostIds: [],
        });
      }

      // Random delay between leads
      await DelayManager.randomLeadProcessingDelay('AFTER_LIKING');
    }
  }

  /**
   * Updated processPostCommenting with 2-sheet architecture
   */
  async processPostCommenting(): Promise<void> {
    console.log('💬 Processing post commenting with 2-sheet architecture...');
    await this.performHealthCheck();

    const likedLeads = await this.sheetsService.getLeadsByStatus('posts_liked');
    console.log(`Found ${likedLeads.length} leads ready for post commenting`);

    for (const lead of likedLeads.slice(0, 2)) {
      // Process 2 leads at a time for commenting
      if (!StatusTransitionValidator.isValidNextStatus(lead.status, 'posts_commented')) {
        console.warn(
          `⚠️ Skipping ${lead.firstName} - invalid status for commenting: ${lead.status}`
        );
        continue;
      }

      if (!(await this.rateLimiter.canPerformActionForAccount(lead.linkedinAccountId!, 'postsCommented'))) {
        console.log('⏸️ Daily limit reached for post commenting');
        break;
      }

      try {
        if (!lead.linkedinUrn) {
          console.warn(`Skipping commenting - missing linkedinUrn for ${lead.firstName}`);
          continue;
        }

        // ✅ STEP 1: Get posts ready for commenting from Posts sheet
        console.log(`📋 Step 1: Getting posts ready for commenting for ${lead.firstName}...`);

        const postsForCommenting = await this.postsSheetService.getPostsForCommenting(
          lead.linkedinUrn,
          2 // Comment on only 2 post to be conservative
        );

        if (postsForCommenting.length === 0) {
          console.warn(`No posts available for commenting for ${lead.firstName}`);

          // Move to next step anyway
          await this.sheetsService.updateLeadStatus(lead.id, 'posts_commented', {
            commentedPostIds: [],
            skippedReason: 'No posts available for commenting',
            skippedAt: new Date().toISOString(),
          });
          continue;
        }

        console.log(
          `💬 Found ${postsForCommenting.length} posts ready for commenting for ${lead.firstName}`
        );

        const commentedPostIds: string[] = [];
        const commentResults: { success: boolean; postId: string; error?: string; comment?: string }[] = [];

        // ✅ STEP 2: Comment on each post - collect all results first
        for (const postRecord of postsForCommenting) {
          // ✅ NEW PATTERN: Check rate limit but don't reserve yet
          if (!(await this.rateLimiter.canPerformAction('postsCommented'))) {
            console.log(`⏸️ Rate limit reached for commenting, stopping for ${lead.firstName}`);
            break;
          }

          try {
            // ✅ STEP 3: Generate contextual comment using stored post content
            console.log(
              `🤖 Step 3: Generating comment for ${postRecord.postType} post by ${postRecord.authorName}...`
            );

            const postForLLM = {
              postId: postRecord.postId,
              content: postRecord.postContent,
              authorName: postRecord.authorName,
              postType: postRecord.postType,
              relevanceScore: postRecord.relevanceScore,
            };

            const comment = await this.llmService.generateComment(postForLLM);

            if (!comment) {
              console.warn(`Failed to generate comment for post ${postRecord.postId}`);
              commentResults.push({ 
                success: false, 
                postId: postRecord.postId, 
                error: 'Failed to generate comment' 
              });
              continue;
            }

            // ✅ STEP 4: Post comment on LinkedIn
            console.log(`📝 Step 4: Posting comment on LinkedIn...`);
            const success = await this.unipileService.commentOnPost(postRecord.postId, comment, lead.linkedinAccountId!);

            if (success) {
              // ✅ SUCCESS: Record the action only after it succeeds
              await this.rateLimiter.recordSuccessfulActionForAccount(lead.linkedinAccountId!, 'postsCommented');
              
              commentedPostIds.push(postRecord.postId);
              commentResults.push({ 
                success: true, 
                postId: postRecord.postId, 
                comment 
              });

              // ✅ STEP 5: Mark post as commented in Posts sheet
              await this.postsSheetService.markPostAsCommented(
                lead.linkedinUrn,
                postRecord.postId,
                comment
              );

              console.log(
                `✅ Successfully commented on ${postRecord.postType} post by ${postRecord.authorName}`
              );
              console.log(
                `   Score: ${postRecord.relevanceScore}, Comment: "${comment.substring(0, 50)}..."`
              );

              await DelayManager.randomDelay('COMMENT_POST');
            } else {
              // ✅ FAILURE: Don't record action, just track the failure
              console.warn(`❌ Failed to post comment on ${postRecord.postId}`);
              commentResults.push({ 
                success: false, 
                postId: postRecord.postId, 
                error: 'Unipile comment API returned false' 
              });
            }
          } catch (commentError) {
            // ✅ FAILURE: Don't record action, just track the error
            console.error(`Error commenting on post ${postRecord.postId}:`, commentError);
            commentResults.push({ 
              success: false, 
              postId: postRecord.postId, 
              error: commentError instanceof Error ? commentError.message : String(commentError)
            });
          }
        }

        // ✅ DECISION LOGIC: Only after processing ALL posts
        const successfulComments = commentResults.filter(r => r.success).length;
        const totalPostsAttempted = commentResults.length;

        if (successfulComments > 0) {
          // At least one success = move to posts_commented
          // ✅ NEW: Clear failure data if this lead had previous failures for this step
          const clearFailureData = this.failureManager.clearFailureData(lead, 'posts_commented');
          
          await this.sheetsService.updateLeadStatus(lead.id, 'posts_commented', {
            commentedPostIds,
            postsCommentedCount: successfulComments,
            totalPostsAttempted,
            commentingCompleted: new Date().toISOString(),
            ...clearFailureData // Clear any retry/failure tracking data
          });

          console.log(
            `✅ Completed intelligent commenting for ${lead.firstName}: ${successfulComments}/${totalPostsAttempted} comments posted successfully`
          );
        } else if (totalPostsAttempted > 0) {
          // All posts failed = use FailureManager for retry logic
          const failureDetails = commentResults.map(r => `${r.postId}: ${r.error}`).join('; ');
          
          const { newStatus, additionalData } = this.failureManager.handleFailure(
            lead,
            'posts_commented',
            `All ${totalPostsAttempted} posts failed to comment: ${failureDetails}`
          );

          await this.sheetsService.updateLeadStatus(lead.id, newStatus, {
            ...additionalData,
            commentedPostIds: [],
            totalPostsAttempted,
            failedCommentDetails: failureDetails,
          });

          console.log(
            `❌ All commenting attempts failed for ${lead.firstName}. Status: ${newStatus}`
          );
        } else {
          // No posts were attempted (likely due to rate limiting)
          console.log(`⏸️ No posts were attempted for commenting for ${lead.firstName} (rate limit reached)`);
        }
      } catch (error) {
        console.error(`❌ Error in post commenting workflow for lead ${lead.id}:`, error);

        try {
          const { newStatus, additionalData } = this.failureManager.handleFailure(
            lead,
            'posts_commented',
            `Post commenting workflow failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );

          await this.sheetsService.updateLeadStatus(lead.id, newStatus, {
            ...additionalData,
            commentedPostIds: [],
          });
        } catch (statusError) {
          console.error(`Failed to update lead status for ${lead.firstName}:`, statusError);
          throw new Error(
            `Failed to update lead status for ${lead.firstName}: ${
              statusError instanceof Error ? statusError.message : String(statusError)
            }`
          );
        }
        throw new Error(
          `Post commenting workflow failed for ${lead.firstName}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }

      // Random delay between leads
      await DelayManager.randomLeadProcessingDelay('AFTER_COMMENTING');
    }
  }

  async processSendInvitations(): Promise<void> {
    console.log('Processing send invitations...');
    await this.performHealthCheck();

    // Wait some time after commenting before sending invitations
    const commentedLeads = await this.sheetsService.getLeadsByStatus('posts_commented');
    console.log(`Found ${commentedLeads.length} leads ready for invitations`);

    for (const lead of commentedLeads.slice(0, 2)) {
      // Process 2 at a time
      // ✅ ADD STATUS VALIDATION
      if (!StatusTransitionValidator.isValidNextStatus(lead.status, 'invitation_sent')) {
        console.warn(
          `⚠️ Skipping ${lead.firstName} - invalid status for invitations: ${lead.status}`
        );
        console.warn(
          `   Valid next states: ${StatusTransitionValidator.getValidNextStates(lead.status).join(
            ', '
          )}`
        );
        continue;
      }

      try {
        // Validate lead data
        if (!lead.linkedinUrl || !lead.id || !lead.firstName) {
          console.warn(`Skipping invitation - invalid lead data:`, lead.id);
          continue;
        }

        // Check if enough time has passed since commenting (optional delay)
        const updatedAt = moment(lead.updatedAt);
        const minutesPassed = moment().diff(updatedAt, 'minutes');

        if (minutesPassed < 3) {
          console.log(
            `⏰ Waiting to send invitation to ${lead.firstName} (commented ${minutesPassed}m ago)`
          );
          continue;
        }

        // ✅ NEW PATTERN: Check rate limit but don't reserve yet
        if (!(await this.rateLimiter.canPerformActionForAccount(lead.linkedinAccountId!, 'invitationsSent'))) {
          console.log(`⏸️ Rate limit reached for invitations, skipping ${lead.firstName}`);
          continue;
        }

        console.log(`Sending invitation to: ${lead.firstName} ${lead.lastName}`);
        
        const invitationId = await this.unipileService.sendConnectionRequestWithoutMessage(
          lead.linkedinUrn,
          lead.linkedinAccountId!
        );

        if (invitationId && invitationId!== ''&& invitationId !== null) {
          // ✅ SUCCESS: Record the action only after it succeeds
          await this.rateLimiter.recordSuccessfulActionForAccount(lead.linkedinAccountId!, 'invitationsSent');
          
          // ✅ NEW: Clear failure data if this lead had previous failures for this step
          const clearFailureData = this.failureManager.clearFailureData(lead, 'invitation_sent');
          
          await this.sheetsService.updateLeadStatus(lead.id, 'invitation_sent', {
            invitationId,
            invitationSentAt: new Date().toISOString(),
            // invitationTemplate: templateName,
            // invitationMessage: invitationMessage,
            ...clearFailureData // Clear any retry/failure tracking data
          });

          //console.log(`✅ Sent invitation to ${lead.firstName} using "${templateName}" template`);
          await DelayManager.randomDelay('SEND_INVITATION');
        } else {
          // ✅ FAILURE: Don't record action, just handle the failure
          console.warn(`❌ Failed to send invitation to ${lead.firstName}`);

          // Handle invitation failure using FailureManager
          const { newStatus, additionalData } = this.failureManager.handleFailure(
            lead,
            'invitation_sent',
            'Failed to send invitation - API returned null invitationId'
          );

          await this.sheetsService.updateLeadStatus(lead.id, newStatus, additionalData);
        }
      } catch (error) {
        console.error(`❌ Error sending invitation to lead ${lead.id}:`, error);

        // Handle API error using FailureManager
        const { newStatus, additionalData } = this.failureManager.handleFailure(
          lead,
          'invitation_sent',
          `Invitation API error: ${error instanceof Error ? error.message : String(error)}`
        );

        await this.sheetsService.updateLeadStatus(lead.id, newStatus, additionalData);
      }
    }

    //Not Needed but lets keep it for consistency
    await DelayManager.randomLeadProcessingDelay('AFTER_INVITATION');
  }


  async processSendMessages(): Promise<void> {
    console.log('Processing send messages...');
    await this.performHealthCheck();

    const connectedLeads = await this.sheetsService.getLeadsByStatus('connected');
    console.log(`Found ${connectedLeads.length} connected leads for messaging`);

    for (const lead of connectedLeads.slice(0, 2)) {
      // Process 2 at a time
      // ✅ ADD STATUS VALIDATION
      if (!StatusTransitionValidator.isValidNextStatus(lead.status, 'first_message_sent')) {
        console.warn(
          `⚠️ Skipping ${lead.firstName} - invalid status for messaging: ${lead.status}`
        );
        console.warn(
          `   Valid next states: ${StatusTransitionValidator.getValidNextStates(lead.status).join(
            ', '
          )}`
        );
        continue;
      }

      try {
        // Validate lead data
        if (!lead.linkedinUrn || !lead.id || !lead.firstName) {
          console.warn(`Skipping messaging - invalid lead data:`, lead.id);
          continue;
        }

        // Wait 1 hour after connection before messaging (currently disabled)
        const connectedAt = lead.updatedAt; // When status changed to 'connected'
        const updatedAt = moment(connectedAt);
        const hoursPassed = moment().diff(updatedAt, 'hours');

        if (hoursPassed < 1) {
          console.log(`⏰ Waiting to message ${lead.firstName} (connected ${hoursPassed}h ago)`);
          continue;
        }

        // ✅ NEW PATTERN: Check rate limit but don't reserve yet
        if (!(await this.rateLimiter.canPerformActionForAccount(lead.linkedinAccountId!, 'messagesSent'))) {
          console.log(`⏸️ Rate limit reached for messages, skipping ${lead.firstName}`);
          continue;
        }

        console.log(`Sending message to: ${lead.firstName} ${lead.lastName}`);

        const personalizedMessage = await this.llmService.generatePersonalizedMessage(lead, {
          company: 'Live2.ai',
          position: 'Business Development',
          industry: 'UGC Commerce',
        });

        const response = await this.unipileService.sendMessage(
          lead.linkedinUrn, // This should be connection ID in practice
          personalizedMessage,
          lead.linkedinAccountId!
        );

        if (response && response.chatId) {
          // ✅ SUCCESS: Record the action only after it succeeds
          await this.rateLimiter.recordSuccessfulActionForAccount(lead.linkedinAccountId!, 'messagesSent');
          
          // ✅ NEW: Clear failure data if this lead had previous failures for this step
          const clearFailureData = this.failureManager.clearFailureData(lead, 'first_message_sent');
          
          await this.sheetsService.updateLeadStatus(lead.id, 'first_message_sent', {
            chatId: response.chatId,
            messageSentAt: new Date().toISOString(),
            ...clearFailureData // Clear any retry/failure tracking data
          });

          console.log(`✅ Sent message to ${lead.firstName}`);
          await DelayManager.randomDelay('SEND_MESSAGE');
        } else {
          // ✅ FAILURE: Don't record action, just handle the failure
          console.warn(`❌ Failed to send message to ${lead.firstName}`);

          // Handle message failure using FailureManager
          const { newStatus, additionalData } = this.failureManager.handleFailure(
            lead,
            'first_message_sent',
            'Failed to send message - API returned null or missing chatId'
          );

          await this.sheetsService.updateLeadStatus(lead.id, newStatus, additionalData);
        }
      } catch (error) {
        console.error(`❌ Error sending message to lead ${lead.id}:`, error);

        // Handle API error using FailureManager
        const { newStatus, additionalData } = this.failureManager.handleFailure(
          lead,
          'first_message_sent',
          `Message API error: ${error instanceof Error ? error.message : String(error)}`
        );

        await this.sheetsService.updateLeadStatus(lead.id, newStatus, additionalData);
      }
    }
    await DelayManager.randomLeadProcessingDelay('AFTER_MESSAGING');
  }

  // Method to handle manual status overrides
  async handleManualStatusChanges(): Promise<void> {
    console.log('🔄 Checking for manual status changes...');

    try {
      // This could be expanded to detect leads that were manually moved to different statuses
      // and handle any necessary cleanup or validation
      await this.sheetsService.detectManualChanges();

      // You could add logic here to handle specific manual interventions
      // For example, if someone manually marks a lead as 'failed', skip processing it
    } catch (error) {
      console.error('Error handling manual status changes:', error);
    }
  }

  // Get comprehensive retry statistics for monitoring
  async getRetryStatistics(): Promise<any> {
    try {
      const allLeads = (await this.sheetsService.getAllLeads()).filter(
        (lead) => lead !== null
      ) as Lead[];
      const retryStats = this.failureManager.getRetryStats(allLeads);
      const retryableLeads = this.failureManager.getRetryableLeads(allLeads);

      return {
        ...retryStats,
        retryableByStep: Object.entries(retryableLeads).reduce((acc, [step, leads]) => {
          acc[step] = leads.length;
          return acc;
        }, {} as Record<string, number>),
      };
    } catch (error) {
      console.error('Error getting retry statistics:', error);
      return null;
    }
  }

  //  Process leads that are ready for retry
  private async processRetryableLeads(): Promise<void> {
    console.log('🔄 Processing retryable leads...');

    try {
      // Get all leads to find retryable ones
      const allLeads = (await this.sheetsService.getAllLeads()).filter(
        (lead) => lead !== null
      ) as Lead[];
      const retryableLeads = this.failureManager.getRetryableLeads(allLeads);

      if (Object.keys(retryableLeads).length === 0) {
        console.log('📋 No leads ready for retry at this time');
        return;
      }

      // Get retry statistics
      const retryStats = this.failureManager.getRetryStats(allLeads);
      console.log('📊 Retry Statistics:');
      console.log(`  💔 Total failed leads: ${retryStats.totalFailed}`);
      console.log(`  ⏰ Awaiting retry: ${retryStats.awaitingRetry}`);
      console.log(`  ✅ Ready for retry: ${retryStats.readyForRetry}`);
      console.log(`  ⚰️ Permanently failed: ${retryStats.permanentlyFailed}`);

      // Process retryable leads by step priority
      const stepPriority: (keyof typeof retryableLeads)[] = [
        'connected', // Check connections (no API cost)
        'first_message_sent', // Send messages
        'invitation_sent', // Send invitations
        'posts_commented', // Comment on posts
        'posts_liked', // Like posts
        'lead_enriched', // Enrich leads
        'new', // Re-fetch from Apollo
      ];

      for (const step of stepPriority) {
        const leadsForStep = retryableLeads[step];
        if (!leadsForStep || leadsForStep.length === 0) continue;

        console.log(`♻️ Retrying ${leadsForStep.length} leads at step '${step}'`);

        // Prepare leads for retry (reset their status)
        for (const lead of leadsForStep.slice(0, 3)) {
          // Limit retries per cycle
          try {
            const { newStatus, additionalData } = this.failureManager.prepareForRetry(lead);

            // Use special retry validation
            const transition = StatusTransitionValidator.validateRetryTransition(
              lead.status,
              newStatus,
              true // This is a retry
            );

            if (transition.isValid) {
              await this.sheetsService.updateLeadStatus(lead.id, newStatus, additionalData);
              console.log(
                `✅ Lead ${lead.firstName} ${lead.lastName} prepared for retry at step '${newStatus}'`
              );
            } else {
              console.warn(`⚠️ Cannot retry lead ${lead.firstName}: ${transition.reason}`);
            }
          } catch (error) {
            console.error(`❌ Error preparing lead ${lead.id} for retry:`, error);
          }
        }
      }
    } catch (error) {
      console.error('❌ Error processing retryable leads:', error);
    }
  }

  /**
   * Helper method to skip post interaction steps
   */
  private async skipPostInteractionSteps(lead: Lead, reason: string): Promise<void> {
    console.log(`⏭️ Skipping post interactions for ${lead.firstName}: ${reason}`);

    // Skip directly to invitation step
    await this.sheetsService.updateLeadStatus(lead.id, 'posts_commented', {
      likedPostIds: [],
      commentedPostIds: [],
      skippedReason: reason,
      skippedAt: new Date().toISOString(),
    });
  }

  // Helper method to extract LinkedIn URN from various possible fields
  private extractLinkedInUrn(enrichedData: Record<string, unknown>): string {
    return (enrichedData.urn as string) || '';
  }

  // Helper method to format company size consistently
  private formatCompanySize(companySize: unknown): string {
    if (!companySize) return '';

    // Handle different formats: number, string, object
    if (typeof companySize === 'number') {
      return this.formatEmployeeCount(companySize);
    }

    if (typeof companySize === 'string') {
      // Clean up string formats
      return companySize.trim();
    }

    if (typeof companySize === 'object' && companySize !== null) {
      const sizeObj = companySize as Record<string, unknown>;
      return (
        (sizeObj.range as string) ||
        (sizeObj.size as string) ||
        (sizeObj.employees as string) ||
        (sizeObj.employeeCount as string) ||
        ''
      );
    }

    return String(companySize).trim();
  }

  // Helper method to format employee count into ranges
  private formatEmployeeCount(count: number): string {
    if (count <= 0) return '';
    if (count <= 50) return '1-50';
    if (count <= 200) return '51-200';
    if (count <= 500) return '201-500';
    if (count <= 1000) return '501-1000';
    if (count <= 5000) return '1001-5000';
    if (count <= 10000) return '5001-10000';
    return '10000+';
  }

  // Helper method to safely parse numbers from various formats
  private parseNumber(value: unknown): number {
    if (typeof value === 'number') return value;

    if (typeof value === 'string') {
      // Handle strings like "500+", "1.2K", "1,234", etc.
      const cleanValue = value.replace(/[^\d.]/g, '');
      let parsed = parseFloat(cleanValue);

      if (value.toLowerCase().includes('k')) {
        parsed = parsed * 1000;
      } else if (value.toLowerCase().includes('m')) {
        parsed = parsed * 1000000;
      }

      return isNaN(parsed) ? 0 : Math.round(parsed);
    }

    return 0;
  }

  /**
   * Generate a random invitation message from predefined templates
   */
  private generateInvitationMessage(lead: Lead): { message: string; templateName: string } {
    const templates = [
      // Original Template
      {
        name: 'Original',
        message: `Hi ${lead.firstName},
        I'm ${getAccountManager().getAccountName(lead.linkedinAccountId!)}. Always keen to connect with leaders in ${lead.companyIndustry || "the space"} and exchange perspectives.
        Best,
        ${getAccountManager().getAccountName(lead.linkedinAccountId!)}`
      },
      
      // Variation A: Formal and Value-Focused
      {
        name: 'Formal Value-Focused',
        message: `Hi ${lead.firstName},
        I'm ${getAccountManager().getAccountName(lead.linkedinAccountId!)} at Live2.ai. We help brands scale authentic social commerce with AI-powered content. Would love to connect and share insights relevant to ${lead.company}.
        Best,
        ${getAccountManager().getAccountName(lead.linkedinAccountId!)}`
      },
      
      // Variation B: Casual and Friendly
      {
        name: 'Casual Friendly',
        message: `Hi ${lead.firstName},
        I'm ${getAccountManager().getAccountName(lead.linkedinAccountId!)} from Live2.ai. Noticed your work at ${lead.company} and thought we should connect! Looking forward to sharing ideas.
        Cheers,
        ${getAccountManager().getAccountName(lead.linkedinAccountId!)}`
      },
      
      // Variation C: Very Brief and Networking Focused
      {
        name: 'Brief Networking',
        message: `Hi ${lead.firstName},
        I'm ${getAccountManager().getAccountName(lead.linkedinAccountId!)}. I'd love to connect and stay updated on trends in ${lead.companyIndustry || "your field"}.
        Thanks,
        ${getAccountManager().getAccountName(lead.linkedinAccountId!)}`
      },
      
      // Variation D: Question to Spark Engagement
      {
        name: 'Engagement Question',
        message: `Hi ${lead.firstName},
        I'm ${getAccountManager().getAccountName(lead.linkedinAccountId!)}. How does ${lead.company} approach social commerce? Would be great to connect and exchange ideas.
        Best regards,
        ${getAccountManager().getAccountName(lead.linkedinAccountId!)}`
      }
    ];

    // Randomly select a template
    const randomIndex = Math.floor(Math.random() * templates.length);
    const selectedTemplate = templates[randomIndex];
    
    console.log(`🎯 Selected invitation template: "${selectedTemplate.name}" for ${lead.firstName}`);
    
    return {
      message: selectedTemplate.message,
      templateName: selectedTemplate.name
    };
  }

  /**
   * Cleanup old posts (maintenance method)
   */
  async cleanupOldPosts(): Promise<void> {
    try {
      console.log('🧹 Cleaning up old posts...');
      const deletedCount = await this.postsSheetService.deleteOldPosts(30); // Delete posts older than 30 days
      console.log(`✅ Cleaned up ${deletedCount} old posts`);
    } catch (error) {
      console.error('❌ Error cleaning up old posts:', error);
    }
  }

}