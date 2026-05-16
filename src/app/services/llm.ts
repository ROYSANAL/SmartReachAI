import OpenAI from 'openai';
import { CONFIG } from '../../config/config';
import { PostForCommenting } from '@/types/postFilter';
import { PostRecord } from '@/types/postsSheet';

export class LLMService {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      apiKey: CONFIG.OPENAI_API_KEY
    });
  }

  async generatePersonalizedMessage(leadProfile: any, userProfile: any): Promise<string> {
    try {
      const prompt = this.buildMessagePrompt(leadProfile, userProfile);
      
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4.1-2025-04-14',
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 200,
        temperature: 0.7
      });
      if (!response.choices || response.choices.length === 0) {
        throw new Error('No response from OpenAI');
      }
      return response.choices[0]?.message?.content?.trim() ?? ''

    } catch (error) {
      console.error('Error generating personalized message:', error);
        throw new Error('Failed to generate personalized message');}
  }

  private buildMessagePrompt(leadProfile: any, userProfile: any): string {
      return `
      Lead Information:
      - Name: ${leadProfile.firstName} ${leadProfile.lastName}
      - Title: ${leadProfile.profileHeadline || 'N/A'}
      - Company: ${leadProfile.company || 'N/A'}
      - Industry: ${leadProfile.companyIndustry || 'N/A'}
      
  You are a LinkedIn outreach specialist creating the first message after connection acceptance. You must generate messages that match EXACTLY the proven templates below, using the specific statistics, case studies, and formatting provided.

  **CORE REQUIREMENTS:**

  1. **Data Usage**: Use ONLY the exact information provided in the prospect data
  2. **Template Matching**: Generate messages that mirror the exact structure, tone, and content of the templates below
  3. **Statistics**: Use the EXACT statistics and case studies provided - never change numbers or company names
  4. **Length**: Keep messages between 45-65 words
  5. **Single Output**: Generate exactly ONE message with no explanations

  **ICP CLASSIFICATION RULES:**

  Classify the prospect into ONE of these ICPs based on their profile:

  **ICP 1: Enterprise Consumer Brands (Beauty, Fashion, Wellness)**
  - Keywords in company/industry: Beauty, Fashion, Cosmetics, Skincare, Wellness, Lifestyle, Consumer Goods, FMCG, Personal Care, Apparel, Retail
  - Company indicators: Consumer-facing brands, B2C companies, retail chains
  - Title indicators: Brand Manager, Product Marketing, Digital Marketing, E-commerce, Consumer Marketing

  **ICP 2: Global Enterprise Marketing Teams (Multi-brand, Multi-region)**
  - Keywords in company/industry: Enterprise, Global, International, Multinational, Conglomerate, Holding Company
  - Company indicators: Large corporations with multiple brands/subsidiaries
  - Title indicators: Marketing Director, Global Marketing, Regional Marketing, Campaign Manager, Marketing Operations, Multi-brand

  **ICP 3: C-Suite / Industry Leaders (Thought Leadership)**
  - Keywords in title: CEO, CTO, CMO, VP, President, Director, Head of, Chief, Founder, Partner
  - Seniority indicators: Executive level positions, leadership roles, decision makers

  **EXACT TEMPLATES TO USE:**

  **FOR ICP 1 (Enterprise Consumer Brands):**
  "Thanks for connecting, ${leadProfile.firstName}! Many ${leadProfile.companyIndustry || 'industry'} brands tell me their biggest challenge isn't traffic, but conversion over 70% of brand content sees no meaningful engagement. Schwarzkopf solved this issue with Live2.ai, achieving a 16% CTR uplift and a 13% bounce rate reduction. Curious if ${leadProfile.company || 'your company'} faces similar challenges?"

  **FOR ICP 2 (Global Enterprise Marketing Teams):**
  "Great to connect, ${leadProfile.firstName}! Most enterprise teams lose days coordinating campaigns across regions. Henkel solved this with Live2.ai, managing 1,700+ social handles with 56% faster rollouts and 16% higher organic reach. Would this be relevant for ${leadProfile.company || 'your company'}?"

  **FOR ICP 3 (C-Suite / Industry Leaders):**
  "Appreciate the connection, ${leadProfile.firstName}! Only 1% of LinkedIn's 1B users post weekly — yet consistent thought leadership drives brand preference for 63% of decision-makers. Live2.ai helps execs post in their authentic voice without the time drain. Want me to show you a sample 2-week content plan in your style?"

  **TEMPLATE SELECTION LOGIC:**

  1. **First Priority**: Check title for C-suite keywords → Use ICP 3 template
  2. **Second Priority**: Check for enterprise/global/multi-brand indicators → Use ICP 2 template  
  3. **Default**: Check for consumer brand industry → Use ICP 1 template
  4. **Fallback**: If unclear, default to ICP 1 template

  **MANDATORY ELEMENTS (DO NOT CHANGE):**

  - **ICP 1 Statistics**: "70% of brand content sees no meaningful engagement", "Schwarzkopf", "16% CTR uplift", "13% bounce rate reduction"
  - **ICP 2 Statistics**: "1,700+ social handles", "Henkel", "56% faster rollouts", "16% higher organic reach" 
  - **ICP 3 Statistics**: "1% of LinkedIn's 1B users post weekly", "63% of decision-makers", "2-week content plan"

  **FORMATTING RULES:**

  1. Start with connection appreciation using exact wording from templates
  2. Include the industry-specific challenge/statistic
  3. Reference the exact case study (Schwarzkopf or Henkel) with precise numbers
  4. End with the specific question format from the template
  5. Use ${leadProfile.firstName} for personalization
  6. Use ${leadProfile.company} or ${leadProfile.companyIndustry} where specified
  7. If company/industry is null, use 'your company' or  'your industry' as fallback

  **STRICT PROHIBITIONS:**

  - Do NOT change any statistics or percentages
  - Do NOT modify case study company names (Schwarzkopf, Henkel)
  - Do NOT alter the opening phrases ("Thanks for connecting", "Great to connect", "Appreciate the connection")
  - Do NOT change the question structure at the end
  - Do NOT add extra content or explanations
  - Do NOT modify the Live2.ai references

  **CLASSIFICATION DECISION TREE:**

  1. Does title contain: CEO, CTO, CMO, VP, President, Director, Head of, Chief, Founder? → ICP 3
  2. Does company/industry contain: Enterprise, Global, Multinational, Multi-brand? → ICP 2  
  3. Does industry contain: Beauty, Fashion, Consumer, Retail, Wellness, FMCG? → ICP 1
  4. Default fallback → ICP 1

  **OUTPUT REQUIREMENT:**
  Return ONLY the final message text using the exact template format for the identified ICP. No explanations, no alternatives, no additional commentary.

  Analyze the lead profile and generate the appropriate template-based message now:
      `;
  }

    /**
   * Generate comment for post from Posts sheet
   */
  async generateCommentFromPostRecord(postRecord: PostRecord): Promise<string | null> {
    // Convert PostRecord to PostForCommenting format for existing method
    const postForLLM: PostForCommenting = {
      postId: postRecord.postId,
      content: postRecord.postContent,
      authorName: postRecord.authorName,
      postType: postRecord.postType,
      relevanceScore: postRecord.relevanceScore
    };

    return this.generateComment(postForLLM);
  }

  /**
   * Enhanced generateComment with additional context from Posts sheet
   */
  async generateComment(postData: PostForCommenting): Promise<string | null> {
    try {
      console.log(`🤖 Generating comment for ${postData.postType} post by ${postData.authorName} (score: ${postData.relevanceScore})`);
      
      const prompt = this.buildEnhancedCommentPrompt(postData);
      
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4.1-2025-04-14',
        messages: [
          {
            role: 'system',
            content: this.getCommentSystemPrompt()
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 150,
        temperature: 0.7,
        presence_penalty: 0.6,
        frequency_penalty: 0.3
      });

      const comment = response.choices[0]?.message?.content?.trim();
      
      if (!comment) {
        console.warn('❌ No comment generated by LLM');
        return null;
      }

      if (!this.isValidComment(comment, postData)) {
        console.warn('❌ Generated comment failed validation');
        return null;
      }

      console.log(`✅ Generated comment (${comment.length} chars): "${comment.substring(0, 50)}..."`);
      return comment;

    } catch (error) {
      console.error('❌ Error generating comment:', error);
      return null;
    }
  }


  private getRelevanceContext(score: number): string {
  if (score >= 8) return "highly relevant to your work and expertise";
  if (score >= 6) return "moderately relevant with good connection points";
  if (score >= 4) return "generally relevant to professional interests";
  return "broad professional interest";
  }

  private getStyleGuidance(relevanceScore: number): string {
  if (relevanceScore >= 8) {
    return `**HIGH RELEVANCE APPROACH:**
    This post is highly relevant to your work. Show deep understanding and expertise. Ask sophisticated questions that demonstrate your industry knowledge. This is your chance to really shine as someone worth connecting with.`;
      } else if (relevanceScore >= 6) {
        return `**MODERATE RELEVANCE APPROACH:**
    This post has good relevance. Show genuine professional interest and ask thoughtful questions. Find the angle that connects to your expertise and demonstrate value as a network connection.`;
      } else if (relevanceScore >= 4) {
        return `**GENERAL PROFESSIONAL APPROACH:**
    This post has some relevance. Focus on showing genuine curiosity and professional interest. Ask broader questions that show you're an engaged, thoughtful professional worth knowing.`;
      } else {
        return `**BROAD NETWORKING APPROACH:**
    Lower direct relevance but still professionally interesting. Show general business acumen and curiosity. Focus on being memorable as a smart, engaged professional they'd want in their network.`;
      }
  }

  /**
   * Enhanced comment validation with relevance scoring
   */
  private isValidComment(comment: string, postData: PostForCommenting): boolean {
    // Length check
    const wordCount = comment.split(' ').length;
    if (wordCount < 5 || wordCount > 100) {
      console.warn(`Comment length invalid: ${wordCount} words`);
      return false;
    }

    // Generic comment detection (stricter for high-relevance posts)
    const genericPhrases = [
      'great post', 'thanks for sharing', 'interesting', 'nice post', 'good point', 'well said'
    ];

    const lowerComment = comment.toLowerCase();
    const hasOnlyGenericPhrases = genericPhrases.some(phrase => 
      lowerComment.includes(phrase) && comment.length < 40
    );

    // Be stricter with high-relevance posts
    if (hasOnlyGenericPhrases && postData.relevanceScore >= 6) {
      console.warn('Comment too generic for high-relevance post');
      return false;
    }

    // Spam/sales detection
    const spamKeywords = [
      'buy', 'sell', 'click here', 'visit our', 'contact me', 'dm me', 
      'check out', 'special offer', 'free trial', 'book a call', 'schedule a demo'
    ];

    if (spamKeywords.some(keyword => lowerComment.includes(keyword))) {
      console.warn('Comment contains potentially spammy keywords');
      return false;
    }

    // Content relevance check for high-score posts
    if (postData.relevanceScore >= 7) {
      const postWords = postData.content.toLowerCase()
        .split(/\W+/)
        .filter(word => word.length > 4);
      
      const commentWords = lowerComment.split(/\W+/);
      const hasRelevantTerms = postWords.some(word => 
        commentWords.some(cWord => 
          cWord.includes(word) || word.includes(cWord)
        )
      );

      if (!hasRelevantTerms && postData.content.length > 100) {
        console.warn(`High-relevance comment may not relate to post content`);
        // Don't reject but note the issue
      }
    }

    return true;
  }

  /**
   * Generate multiple comments and pick the best one for high-value posts
   */
  async generateBestComment(postData: PostForCommenting): Promise<string | null> {
    try {
      // For high-relevance posts, generate multiple options
      const numOptions = postData.relevanceScore >= 7 ? 3 : 2;
      
      console.log(`🎯 Generating ${numOptions} comment options for high-value post (score: ${postData.relevanceScore})`);

      const commentPromises = Array(numOptions).fill(0).map(() => 
        this.generateComment(postData)
      );

      const comments = await Promise.all(commentPromises);
      const validComments = comments.filter(comment => 
        comment && this.isValidComment(comment, postData)
      );

      if (validComments.length === 0) {
        return null;
      }

      // Pick the best comment based on length and specificity
      const bestComment = validComments.reduce((best, current) => {
        if (!best) return current;
        if (!current) return best;
        
        // For high-relevance posts, prefer longer, more specific comments
        if (postData.relevanceScore >= 7) {
          if (current.length > best.length) return current;
        }
        
        // For moderate relevance, prefer medium-length comments
        const idealLength = 50;
        const bestDiff = Math.abs(best.length - idealLength);
        const currentDiff = Math.abs(current.length - idealLength);
        
        return currentDiff < bestDiff ? current : best;
      });

      console.log(`✅ Selected best comment from ${validComments.length} options`);
      return bestComment;

    } catch (error) {
      console.error('Error generating best comment:', error);
      return this.generateComment(postData);
    }
  }

  /**
   * Batch comment generation for multiple posts
   */
  async generateCommentsForPosts(posts: PostRecord[]): Promise<Array<{postId: string, comment: string | null}>> {
    const results = [];

    for (const post of posts) {
      try {
        const postForLLM: PostForCommenting = {
          postId: post.postId,
          content: post.postContent,
          authorName: post.authorName,
          postType: post.postType,
          relevanceScore: post.relevanceScore
        };

        const comment = post.relevanceScore >= 7 
          ? await this.generateBestComment(postForLLM)
          : await this.generateComment(postForLLM);

        results.push({
          postId: post.postId,
          comment
        });

        // Delay between generations to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        console.error(`Error generating comment for post ${post.postId}:`, error);
        results.push({
          postId: post.postId,
          comment: null
        });
      }
    }

    return results;
  }

  private getCommentSystemPrompt(): string {
  return `You are a seasoned B2B professional writing LinkedIn comments as part of a relationship-building strategy. 
  Your comments serve as the first touchpoint before sending connection requests, 
  so they must warm up prospects and create positive first impressions.

**PRIMARY OBJECTIVES:**
1. Create authentic human connection and rapport
2. Position yourself as a knowledgeable, valuable professional in your network
3. Demonstrate genuine interest in their work and insights
4. Build trust and credibility that makes them receptive to future connection requests
5. Add meaningful value to the conversation without being promotional

**CRITICAL SUCCESS FACTORS:**

**HUMAN-LIKE WRITING:**
- Write exactly how a real professional would comment naturally
- Use everyday business language, not corporate jargon or buzzwords
- Include natural speech patterns and conversational flow
- Vary sentence structure and avoid robotic patterns
- Sound like genuine human interest, not AI-generated text

**RELATIONSHIP WARMTH:**
- Show authentic appreciation for their insights
- Demonstrate that you actually read and understood their content
- Express curiosity about their perspective or experience
- Create a foundation for future professional relationship
- Make them think "this person seems interesting and worth knowing"

**STRATEGIC POSITIONING:**
- Subtly demonstrate your industry knowledge and expertise
- Position yourself as a peer worth connecting with
- Show you bring value to professional conversations
- Create intrigue about your background without being direct about it
- Plant seeds that make them curious about who you are

**TONE & STYLE REQUIREMENTS:**
- Professional yet warm and approachable
- Conversational, like talking to a colleague at a networking event
- Confident but not arrogant
- Curious and inquisitive
- Supportive and collaborative
- Simple, clear English that feels natural

**STRICT FORMATTING RULES:**
- LENGTH: Exactly 25-50 words - count every word precisely
- No emojis or special characters
- No links or promotional content
- Natural punctuation and capitalization
- Single paragraph format

**WHAT MAKES PROSPECTS WANT TO CONNECT:**
- Feeling understood and heard
- Recognizing shared professional interests
- Sensing expertise that could benefit them
- Appreciating thoughtful, non-generic engagement
- Curiosity about your background and perspective
- Feeling like you're someone worth knowing in their network

**FORBIDDEN ELEMENTS:**
- Generic phrases ("Great post!", "Thanks for sharing!", "Couldn't agree more!")
- Obviously AI-generated language patterns
- Sales language or promotional content
- Overly complex vocabulary or corporate speak
- Template-like structures that feel copy-pasted
- Direct asks for connections, meetings, or business
- Self-promotional statements about your work or company
- Buzzwords like "leverage," "synergy," "disrupt," "game-changer"
- Questions that feel like sales qualification

**ENGAGEMENT STRATEGIES:**
- Reference specific details from their post content
- Ask thoughtful follow-up questions that show deep thinking
- Share brief, relevant perspective without making it about you
- Acknowledge the value of their insights
- Connect their ideas to broader industry trends
- Show appreciation for their thought leadership`;
  }

  private buildEnhancedCommentPrompt(postData: PostForCommenting): string {
    const postTypeContext = postData.postType === 'repost' 
      ? 'This is a reposted/shared content. The person shared this with their network, adding their own perspective.'
      : 'This is original content created by the author sharing their thoughts and insights.';

    const relevanceContext = this.getRelevanceContext(postData.relevanceScore);

    return `
  **POST ANALYSIS & COMMENT GENERATION**

  **POST DETAILS:**
  Content: "${postData.content}"
  Author: ${postData.authorName}
  Type: ${postTypeContext}
  Relevance Score: ${postData.relevanceScore}/10 (${relevanceContext})

  **YOUR MISSION:**
  Generate a comment that will make ${postData.authorName} think "This person seems knowledgeable and interesting -
  I'd be open to connecting with them." Your comment is the crucial first step in building a relationship that
    leads to a successful connection request.

  **MANDATORY REQUIREMENTS:**

  **WORD COUNT:** Exactly 25-50 words. Count precisely - this is non-negotiable.

  **HUMAN AUTHENTICITY CHECKLIST:**
  - ✅ Sounds like something you'd naturally say in a face-to-face conversation
  - ✅ Uses simple, everyday business language
  - ✅ Flows naturally without robotic patterns
  - ✅ Shows genuine human curiosity and interest
  - ✅ Feels spontaneous, not pre-planned or templated

  **RELATIONSHIP BUILDING STRATEGY:**
  ${this.getStyleGuidance(postData.relevanceScore)}

  **CONTENT REQUIREMENTS:**
  1. **Specific Reference**: Mention a particular point, insight, or detail from their post
  2. **Value Addition**: Either ask a thoughtful question OR share a brief relevant perspective
  3. **Genuine Interest**: Show authentic curiosity about their work or insights
  4. **Professional Positioning**: Subtly demonstrate your industry knowledge
  5. **Connection Readiness**: Make them curious enough to want you in their network

  **COMMENT STRUCTURE OPTIONS:**

  **Option A - Insight + Question:**
  "[Specific reference to their content]. [Brief insight/perspective]. [Thoughtful question about their experience/opinion]?"

  **Option B - Perspective + Appreciation:**
  "[Specific reference]. [Your relevant perspective without being promotional]. [Acknowledgment of their insight/expertise]."

  **Option C - Question + Context:**
  "[Thoughtful question based on their content]. [Brief context for why you're asking]. [Appreciation for their viewpoint]."

  **LANGUAGE QUALITY STANDARDS:**
  - Use contractions where natural (can't, don't, I've, etc.)
  - Include conversational connectors (actually, really, especially, particularly)
  - Vary sentence lengths for natural flow
  - Use active voice primarily
  - Keep vocabulary at business professional level, not academic
  - Sound confident but not arrogant

  **RED FLAGS TO AVOID:**
  ❌ Starting with "Great post" or "Thanks for sharing"
  ❌ Using phrases like "I'd love to connect" or "Let's chat"
  ❌ Corporate buzzwords that sound artificial
  ❌ Questions that feel like sales qualification
  ❌ Overly enthusiastic language that seems fake
  ❌ Generic comments that could apply to any post

  **POST-SPECIFIC GUIDANCE:**
  ${postData.postType === 'repost' 
    ? 'Since this is shared content, acknowledge both the original insight and their perspective on sharing it. Show you understand why they found it valuable enough to share.'
    : 'Since this is original content, engage directly with their thoughts and expertise. Show appreciation for their unique insights and perspective.'}

  **SUCCESS CRITERIA:**
  Your comment should make them think:
  - "This person actually read and understood my post"
  - "They seem knowledgeable about this topic"
  - "I'm curious about their background and experience"
  - "They'd be a valuable addition to my network"
  - "I should accept their connection request when it comes"

  **FINAL VALIDATION:**
  Before submitting, ensure your comment:
  - Is exactly 25-40 words
  - Sounds completely human and natural
  - References specific content from their post
  - Positions you as a knowledgeable peer
  - Creates warmth and connection
  - Makes them receptive to future outreach

  Generate one authentic, relationship-building comment now:`;
  }


  async classifyBusinessPost(postContent: string, authorName: string): Promise<string> {
  try {
    const prompt = `
You are a B2B sales professional deciding whether to engage with this LinkedIn post. 

POST CONTENT:
"${postContent}"

AUTHOR: ${authorName}

CLASSIFICATION RULES:

✅ ENGAGE WITH (Business Relevant):
- Business strategy, operations, or market analysis
- Industry trends, insights, or data-driven content  
- Leadership lessons, management experiences, or team building
- Technology innovations, digital transformation, or automation
- Professional challenges, solutions, or best practices
- Company growth, funding news, or business milestones (if insightful)
- Thought leadership on business topics
- Process improvements, productivity tips, or operational insights

❌ DO NOT ENGAGE (Inappropriate for B2B):
- Personal life updates, family events, or social activities
- Holiday greetings, national celebrations, or cultural events
- Health initiatives, charity drives, or social causes (blood donation, etc.)
- Political opinions, controversial statements, or divisive content
- Pure self-promotion, product launches, or sales pitches
- Hiring announcements or recruitment posts
- Generic motivational quotes without business context
- Personal achievements without business learnings
- Entertainment, sports, or lifestyle content
- Visual merchandising or product showcases without insights

TONE CONSIDERATIONS:
- Avoid controversial or polarizing content
- Skip overly promotional or sales-focused posts
- Avoid posts that might generate negative discussions
- Skip personal opinions that could be divisive

ENGAGEMENT VALUE:
Rate posts that would generate meaningful professional discussion and add value to business relationships.

Respond with ONLY a JSON object:
{
  "shouldEngage": boolean,
  "confidence": number (1-10),
  "category": "business_insight" | "thought_leadership" | "industry_trend" | "personal_content" | "promotional" | "controversial" | "social_cause" | "celebration",
  "reasoning": "Brief explanation",
  "engagementType": "comment" | "like_only" | "skip"
}

Be very conservative - when in doubt, classify as DO NOT ENGAGE.`;

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4.1-2025-04-14',
      messages: [
        {
          role: 'system',
          content: 'You are a professional B2B sales expert. Respond only with valid JSON. Be very strict about business relevance.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 300,
      temperature: 0.1, // Very low for consistent classification
    });

    return response.choices[0]?.message?.content?.trim() || '';
  } catch (error) {
    console.error('Error in LLM post classification:', error);
    throw error;
  }
}
}
