import { LLMService } from "./llm";
import { UnipilePost, FilteredPost, PostFilterResult } from "../../types/postFilter";

// Enhanced PostFilterService with LLM integration
export class EnhancedPostFilterService {
  private llmService: LLMService;
  private readonly MINIMUM_CONFIDENCE = 5; // Only engage with high-confidence business content
  private readonly MAX_POSTS_TO_RETURN = 2;

  constructor(llmService: LLMService) {
    this.llmService = llmService;
  }

  /**
   * LLM-powered strict business filtering
   */
  async filterBusinessRelevantPosts(posts: UnipilePost[]): Promise<PostFilterResult> {
    console.log(`🤖 Starting LLM classification for ${posts.length} posts...`);

    const relevantPosts: FilteredPost[] = [];
    const rejectedPosts: Array<{content: string, reason: string}> = [];

    // Process posts with rate limiting
    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      
      try {
        // Basic content validation
        const textToAnalyze = post.is_repost && post.repost_content 
          ? post.repost_content.text || post.text || ''
          : post.text || '';

        if (!textToAnalyze || textToAnalyze.length < 30) {
          rejectedPosts.push({
            content: textToAnalyze.substring(0, 50),
            reason: 'Content too short'
          });
          continue;
        }

        // LLM Classification
        console.log(`🔍 Analyzing post ${i + 1}/${posts.length}: "${textToAnalyze.substring(0, 60)}..."`);
        
        const classificationResponse = await this.llmService.classifyBusinessPost(
          textToAnalyze, 
          post.author?.name || 'Unknown'
        );

        const classification = this.parseClassification(classificationResponse);

        // Decision logic
        if (classification.shouldEngage && 
            classification.confidence >= this.MINIMUM_CONFIDENCE &&
            ['business_insight', 'thought_leadership', 'industry_trend'].includes(classification.category)) {
          
          const filteredPost = this.createFilteredPost(post, classification);
          if (filteredPost) {
            relevantPosts.push(filteredPost);
            console.log(`✅ APPROVED: "${textToAnalyze.substring(0, 50)}..." (${classification.category}, confidence: ${classification.confidence})`);
            console.log(`   Reasoning: ${classification.reasoning}`);
          }
        } else {
          rejectedPosts.push({
            content: textToAnalyze.substring(0, 50),
            reason: `${classification.category} (confidence: ${classification.confidence}) - ${classification.reasoning}`
          });
          console.log(`❌ REJECTED: "${textToAnalyze.substring(0, 50)}..." (${classification.category})`);
          console.log(`   Reasoning: ${classification.reasoning}`);
        }

        // Rate limiting delay between LLM calls
        if (i < posts.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500)); // 0.5 second delay
        }

      } catch (error) {
        console.error(`Error processing post ${i + 1}:`, error);
        rejectedPosts.push({
          content: post.text?.substring(0, 50) || 'Unknown',
          reason: 'LLM processing error'
        });
      }
    }

    // Sort by confidence and engagement potential
    const sortedPosts = relevantPosts.sort((a, b) => b.relevanceScore - a.relevanceScore);
    const finalPosts = sortedPosts.slice(0, this.MAX_POSTS_TO_RETURN);

    // Summary logging
    console.log(`\n🎯 LLM FILTERING SUMMARY:`);
    console.log(`   📊 Total posts analyzed: ${posts.length}`);
    console.log(`   ✅ Business relevant: ${relevantPosts.length}`);
    console.log(`   ❌ Filtered out: ${rejectedPosts.length}`);
    console.log(`   🎪 Final selection: ${finalPosts.length}`);
    
    console.log(`\n📋 REJECTION BREAKDOWN:`);
    const rejectionStats = rejectedPosts.reduce((acc, post) => {
      const category = post.reason.split('(')[0].trim();
      acc[category] = (acc[category] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    Object.entries(rejectionStats).forEach(([reason, count]) => {
      console.log(`   • ${reason}: ${count} posts`);
    });

    return {
      totalPosts: posts.length,
      filteredPosts: sortedPosts,
      relevantPosts: finalPosts,
      processingDate: new Date().toISOString(),
      filterCriteria: {
        avoidsCount: rejectedPosts.length,
        preferredCount: relevantPosts.length,
        businessTopicsCount: finalPosts.length,
        minimumScore: this.MINIMUM_CONFIDENCE
      }
    };
  }

  private parseClassification(response: string): {
    shouldEngage: boolean;
    confidence: number;
    category: string;
    reasoning: string;
    engagementType: string;
  } {
    try {
      // Clean response
      const cleanResponse = response
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
      
      const parsed = JSON.parse(cleanResponse);
      
      return {
        shouldEngage: parsed.shouldEngage || false,
        confidence: Math.max(1, Math.min(10, parsed.confidence || 1)),
        category: parsed.category || 'unknown',
        reasoning: parsed.reasoning || 'No reasoning provided',
        engagementType: parsed.engagementType || 'skip'
      };
    } catch (error) {
      console.error('Failed to parse LLM classification:', error);
      console.error('Raw response:', response);
      
      // Conservative fallback
      return {
        shouldEngage: false,
        confidence: 1,
        category: 'parsing_error',
        reasoning: 'Failed to parse LLM response',
        engagementType: 'skip'
      };
    }
  }

  private createFilteredPost(post: UnipilePost, classification: any): FilteredPost | null {
    const textToAnalyze = post.is_repost && post.repost_content 
      ? post.repost_content.text || post.text || ''
      : post.text || '';

    if (!textToAnalyze) return null;

    const postDate = new Date(post.parsed_datetime || post.date);
    const daysOld = Math.round((new Date().getTime() - postDate.getTime()) / (1000 * 60 * 60 * 24));

    return {
      postId: post.social_id || post.id,
      content: textToAnalyze,
      originalText: post.text || '',
      authorName: post.author?.name || 'Unknown',
      authorId: post.author?.id || 'Unknown',
      postType: post.is_repost ? 'repost' : 'original',
      engagementScore: (post.reaction_counter || 0) + (post.comment_counter || 0) + (post.repost_counter || 0),
      daysOld,
      relevanceScore: classification.confidence, // Use LLM confidence as relevance score
      canComment: post.permissions?.can_post_comments || false,
      shareUrl: post.share_url || '',
      repostCommentary: post.is_repost ? post.text : undefined,
      timestamp: post.parsed_datetime || post.date || '',
      originalCreatedAt: postDate.toISOString()
    };
  }

}