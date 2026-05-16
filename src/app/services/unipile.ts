import axios, { AxiosError } from 'axios';
import { CONFIG } from '../../config/config';
import { LinkedInPost } from '@/types';
import { UnipilePost } from '@/types/postFilter';

export class UnipileService {
  private apiKey: string;
  private baseUrl: string;

  constructor() {
    this.apiKey = CONFIG.UNIPILE_API_KEY;
    this.baseUrl = process.env.UNIPILE_BASE_URL || " ";
  }


  async getUserPosts(linkedinUrn: string, linkedinAccountId: string, limit: number = 10): Promise<UnipilePost[]> {
  try {
    console.log(`🔍 Fetching ${limit} posts with full data for user: ${linkedinUrn}`);
    
    const response = await axios.get(
      `${this.baseUrl}/users/${linkedinUrn}/posts`,
      {
        headers: {
          'X-API-KEY': this.apiKey,
          'accept': 'application/json'
        },
        params: {
          account_id: linkedinAccountId,
          limit
        },
        timeout: 30000
      }
    );

    if (!response.data?.items || !Array.isArray(response.data.items)) {
      console.warn(`⚠️ No posts found for ${linkedinUrn}`);
      return [];
    }

    const posts: UnipilePost[] = response.data.items.map((post: any) => ({
      id: post.id || '',
      social_id: post.social_id || '',
      text: post.text || '',
      share_url: post.share_url || '',
      date: post.date || '',
      parsed_datetime: post.parsed_datetime || post.date || '',
      reaction_counter: post.reaction_counter || 0,
      comment_counter: post.comment_counter || 0,
      repost_counter: post.repost_counter || 0,
      author: {
        id: post.author?.id || '',
        name: post.author?.name || '',
        headline: post.author?.headline || ''
      },
      permissions: {
        can_post_comments: post.permissions?.can_post_comments || false,
        can_react: post.permissions?.can_react || false,
        can_share: post.permissions?.can_share || false
      },
      is_repost: post.is_repost || false,
      repost_content: post.repost_content ? {
        id: post.repost_content.id || '',
        text: post.repost_content.text || '',
        author: {
          id: post.repost_content.author?.id || '',
          name: post.repost_content.author?.name || ''
        }
      } : undefined
    }));

    console.log(`✅ Retrieved ${posts.length} posts with full data for ${linkedinUrn}`);
    return posts;

  } catch (error) {
    console.error(`❌ Error fetching full post data for ${linkedinUrn}:`, error);
    
    if (axios.isAxiosError(error)) {
      // ✅ ENHANCED: Capture full error details for debugging
      const errorDetails = {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        url: error.config?.url,
        method: error.config?.method,
        requestBody: error.config?.data,
        timestamp: new Date().toISOString(),
        type: 'get_user_posts'
      };

      console.error('📋 Full Get User Posts API Error Details:', errorDetails);

      const status = error.response?.status;
      const responseData = error.response?.data;

      switch (status) {
        case 400:
          console.warn(`⚠️ Bad Request (400) for fetching posts from ${linkedinUrn}: ${responseData?.message || 'Invalid request'}`);
          throw new Error(`POSTS_ERROR_400: ${responseData}`);

        case 401:
          console.warn(`⚠️ Unauthorized (401) for fetching posts from ${linkedinUrn}: Invalid API credentials`);
          throw new Error(`POSTS_ERROR_401: ${responseData}`);

        case 403:
          console.warn(`⚠️ Forbidden (403) for fetching posts from ${linkedinUrn}: ${responseData?.message || 'Access denied'}`);
          throw new Error(`POSTS_ERROR_403: ${responseData}`);

        case 404:
          console.warn(`⚠️ User Not Found (404): ${linkedinUrn} - ${responseData?.message || 'User not found'}`);
          throw new Error(`POSTS_ERROR_404: ${responseData}`);

        case 429:
          console.warn(`⚠️ Rate Limited (429) for fetching posts from ${linkedinUrn}: ${responseData?.message || 'API rate limit exceeded'}`);
          throw new Error(`POSTS_ERROR_429: ${responseData}`);

        case 500:
          console.warn(`⚠️ Server Error (500) for fetching posts from ${linkedinUrn}: ${responseData?.message || 'Unipile server error'}`);
          throw new Error(`POSTS_ERROR_500: ${responseData}`);

        case 502:
        case 503:
        case 504:
          console.warn(`⚠️ Service Unavailable (${status}) for fetching posts from ${linkedinUrn}: ${responseData?.message || 'LinkedIn API unavailable'}`);
          throw new Error(`POSTS_ERROR_${status}: ${responseData}`);

        default:
          console.warn(`⚠️ Unknown Error (${status || 'UNKNOWN'}) for fetching posts from ${linkedinUrn}: ${responseData?.message || 'Unknown error'}`);
          throw new Error(`POSTS_ERROR_${status || 'UNKNOWN'}: ${responseData}`);
      }
    }
    
    // Non-axios errors (network issues, timeouts, etc.)
    const networkError = {
      error: error instanceof Error ? error.message : String(error),
      linkedinUrn,
      timestamp: new Date().toISOString(),
      type: 'posts_network_error'
    };
    console.error('🌐 Posts Fetch Network Error Details:', networkError);
    throw new Error(`POSTS_NETWORK_ERROR: ${JSON.stringify(networkError)}`);
  }
  }

  async likePost(postId: string, linkedinAccountId: string): Promise<boolean> {
    try {
      console.log(`👍 Liking post: ${postId}`);
      
      const response = await axios.post(
        `${this.baseUrl}/posts/reaction`, // ✅ FIXED: Correct endpoint
        {
          // ✅ FIXED: Correct request body structure
          reaction_type: "like",
          account_id: linkedinAccountId,
          post_id: postId
        },
        {
          headers: {
            // ✅ FIXED: Use X-API-KEY instead of Authorization Bearer
            'X-API-KEY': this.apiKey,
            'accept': 'application/json',
            'content-type': 'application/json'
          },
          timeout: 15000
        }
      );

      if (response.status === 200 || response.status === 201) {
        console.log(`✅ Successfully liked post: ${postId}`);
        return true;
      } else {
        console.warn(`⚠️ Unexpected response status ${response.status} for liking post ${postId}`);
        return false;
      }

    } catch (error) {
      console.error(`❌ Error liking post ${postId}:`, error);
      
      if (axios.isAxiosError(error)) {
        // ✅ ENHANCED: Capture full error details for debugging
        const errorDetails = {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
          url: error.config?.url,
          method: error.config?.method,
          requestBody: error.config?.data,
          timestamp: new Date().toISOString(),
          type: 'like_post'
        };

        console.error('📋 Full Like Post API Error Details:', errorDetails);

        const status = error.response?.status;
        const responseData = error.response?.data;

        switch (status) {
          case 400:
            console.warn(`⚠️ Bad Request (400) for liking post ${postId}: ${responseData?.message || 'Invalid request'}`);
            throw new Error(`LIKE_ERROR_400: ${responseData}`);

          case 401:
            console.warn(`⚠️ Unauthorized (401) for liking post ${postId}: Invalid API credentials`);
            throw new Error(`LIKE_ERROR_401: ${responseData}`);

          case 403:
            console.warn(`⚠️ Forbidden (403) for liking post ${postId}: ${responseData?.message || 'Access denied'}`);
            throw new Error(`LIKE_ERROR_403: ${responseData}`);

          case 404:
            console.warn(`⚠️ Post Not Found (404): ${postId} - ${responseData?.message || 'Post not found or deleted'}`);
            throw new Error(`LIKE_ERROR_404: ${responseData}`);

          case 409:
            console.warn(`⚠️ Conflict (409) for liking post ${postId}: ${responseData?.message || 'Post already liked'}`);
            throw new Error(`LIKE_ERROR_409: ${responseData}`);

          case 422:
            console.warn(`⚠️ Unprocessable Entity (422) for liking post ${postId}: ${responseData?.message || 'Cannot like this post'}`);
            throw new Error(`LIKE_ERROR_422: ${responseData}`);

          case 429:
            console.warn(`⚠️ Rate Limited (429) for liking post ${postId}: ${responseData?.message || 'API rate limit exceeded'}`);
            throw new Error(`LIKE_ERROR_429: ${responseData}`);

          case 500:
            console.warn(`⚠️ Server Error (500) for liking post ${postId}: ${responseData?.message || 'Unipile server error'}`);
            throw new Error(`LIKE_ERROR_500: ${responseData}`);

          case 502:
          case 503:
          case 504:
            console.warn(`⚠️ Service Unavailable (${status}) for liking post ${postId}: ${responseData?.message || 'LinkedIn API unavailable'}`);
            throw new Error(`LIKE_ERROR_${status}: ${responseData}`);

          default:
            console.warn(`⚠️ Unknown Error (${status || 'UNKNOWN'}) for liking post ${postId}: ${responseData?.message || 'Unknown error'}`);
            throw new Error(`LIKE_ERROR_${status || 'UNKNOWN'}: ${responseData}`);
        }
      }
      
      // Non-axios errors (network issues, timeouts, etc.)
      const networkError = {
        error: error instanceof Error ? error.message : String(error),
        postId,
        timestamp: new Date().toISOString(),
        type: 'like_post_network_error'
      };
      console.error('🌐 Like Post Network Error Details:', networkError);
      throw new Error(`LIKE_NETWORK_ERROR: ${JSON.stringify(networkError)}`);
    }
  }

  async commentOnPost(postId: string, comment: string, linkedinAccountId: string): Promise<boolean> {
    try {
      console.log(`💬 Commenting on post: ${postId}`);
      console.log(`📝 Comment text: "${comment.substring(0, 50)}..."`);
      
      const response = await axios.post(
        `${this.baseUrl}/posts/${postId}/comments`, 
        {
          account_id: linkedinAccountId,
          text: comment
        },
        {
          headers: {
            
            'X-API-KEY': this.apiKey,
            'accept': 'application/json',
            'content-type': 'application/json'
          },
          timeout: 20000
        }
      );

      if (response.status === 200 || response.status === 201) {
        console.log(`✅ Successfully commented on post: ${postId}`);
        return true;
      } else {
        console.warn(`⚠️ Unexpected response status ${response.status} for commenting on post ${postId}`);
        return false;
      }

    } catch (error) {
      console.error(`❌ Error commenting on post ${postId}:`, error);
      
      if (axios.isAxiosError(error)) {
        // ✅ ENHANCED: Capture full error details for debugging
        const errorDetails = {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
          url: error.config?.url,
          method: error.config?.method,
          requestBody: error.config?.data,
          timestamp: new Date().toISOString(),
          type: 'comment_on_post'
        };

        console.error('📋 Full Comment API Error Details:', errorDetails);

        const status = error.response?.status;
        const responseData = error.response?.data;

        switch (status) {
          case 400:
            console.warn(`⚠️ Bad Request (400) for commenting on post ${postId}: ${responseData?.message || 'Invalid comment content'}`);
            throw new Error(`COMMENT_ERROR_400: ${responseData}`);

          case 401:
            console.warn(`⚠️ Unauthorized (401) for commenting on post ${postId}: Invalid API credentials`);
            throw new Error(`COMMENT_ERROR_401: ${responseData}`);

          case 403:
            console.warn(`⚠️ Forbidden (403) for commenting on post ${postId}: ${responseData?.message || 'Access denied or comments disabled'}`);
            throw new Error(`COMMENT_ERROR_403: ${responseData}`);

          case 404:
            console.warn(`⚠️ Post Not Found (404): ${postId} - ${responseData?.message || 'Post not found or deleted'}`);
            throw new Error(`COMMENT_ERROR_404: ${responseData}`);

          case 409:
            console.warn(`⚠️ Conflict (409) for commenting on post ${postId}: ${responseData?.message || 'Duplicate comment or conflict'}`);
            throw new Error(`COMMENT_ERROR_409: ${responseData}`);

          case 422:
            console.warn(`⚠️ Unprocessable Entity (422) for commenting on post ${postId}: ${responseData?.message || 'Comment content rejected'}`);
            throw new Error(`COMMENT_ERROR_422: ${responseData}`);

          case 429:
            console.warn(`⚠️ Rate Limited (429) for commenting on post ${postId}: ${responseData?.message || 'API rate limit exceeded'}`);
            throw new Error(`COMMENT_ERROR_429: ${responseData}`);

          case 500:
            console.warn(`⚠️ Server Error (500) for commenting on post ${postId}: ${responseData?.message || 'Unipile server error'}`);
            throw new Error(`COMMENT_ERROR_500: ${responseData}`);

          case 502:
          case 503:
          case 504:
            console.warn(`⚠️ Service Unavailable (${status}) for commenting on post ${postId}: ${responseData?.message || 'LinkedIn API unavailable'}`);
            throw new Error(`COMMENT_ERROR_${status}: ${responseData}`);

          default:
            console.warn(`⚠️ Unknown Error (${status || 'UNKNOWN'}) for commenting on post ${postId}: ${responseData?.message || 'Unknown error'}`);
            throw new Error(`COMMENT_ERROR_${status || 'UNKNOWN'}: ${responseData}`);
        }
      }
      
      // Non-axios errors (network issues, timeouts, etc.)
      const networkError = {
        error: error instanceof Error ? error.message : String(error),
        postId,
        comment: comment.substring(0, 100), // First 100 chars for debugging
        timestamp: new Date().toISOString(),
        type: 'comment_post_network_error'
      };
      console.error('🌐 Comment Post Network Error Details:', networkError);
      throw new Error(`COMMENT_NETWORK_ERROR: ${JSON.stringify(networkError)}`);
    }
  }

  //   /**
  //  * @param linkedinUrn - The LinkedIn URN (provider_id) - NOT the full URL
  //  * @param message - Optional invitation message
  //  * @returns invitation_id if successful, null if failed
  //  */
  // async sendConnectionRequest(linkedinUrn: string, linkedinAccountId: string, message?: string): Promise<string | null> {
  //   try {
  //     console.log(`📨 Sending invitation to: ${linkedinUrn}`);
  //     console.log(`💬 Message: "${message || 'Default connection request'}"`);
      
  //     const response = await axios.post(
  //       `${this.baseUrl}/users/invite`, // ✅ FIXED: Correct endpoint
  //       {
  //         // ✅ FIXED: Correct request body structure
  //         message: message || "Hi! I'd like to connect with you on LinkedIn.",
  //         account_id: linkedinAccountId,
  //         provider_id: linkedinUrn // ✅ FIXED: Use linkedinUrn as provider_id
  //       },
  //       {
  //         headers: {
  //           // ✅ FIXED: Use X-API-KEY instead of Authorization Bearer
  //           'X-API-KEY': this.apiKey,
  //           'accept': 'application/json',
  //           'content-type': 'application/json'
  //           // ✅ REMOVED: X-Account-ID header (now in request body)
  //         },
  //         timeout: 20000
  //       }
  //     );

  //     // ✅ FIXED: Parse response according to correct structure
  //     if (response.status === 200 || response.status === 201) {
  //       const invitationId = response.data?.invitation_id;
  //       const usage = response.data?.usage || 0;
        
  //       if (invitationId && invitationId !== "" && invitationId !== "null") {
  //         return invitationId;
  //       } else {
  //         console.warn(`⚠️ Invitation sent but no invitation_id returned`);
  //         console.warn('Response data:', response.data);
  //         return null; // Return something to indicate success
  //       }
  //     } else {
  //       console.warn(`⚠️ Unexpected response status ${response.status} for invitation`);
  //       console.warn('Response data:', response.data);
  //       return null;
  //     }

  //   } catch (error) {
  //     console.error(`❌ Error sending invitation to ${linkedinUrn}:`, error);
      
  //     if (axios.isAxiosError(error)) {
  //       // ✅ ENHANCED: Capture full error details for debugging
  //       const errorDetails = {
  //         status: error.response?.status,
  //         statusText: error.response?.statusText,
  //         data: error.response?.data,
  //         url: error.config?.url,
  //         method: error.config?.method,
  //         requestBody: error.config?.data,
  //         timestamp: new Date().toISOString()
  //       };

  //       console.error('📋 Full Invitation API Error Details:', errorDetails);

  //       // ✅ ENHANCED: Comprehensive error handling based on HTTP status codes
  //       const status = error.response?.status;
  //       const responseData = error.response?.data;
  //       const fullErrorData = JSON.stringify(errorDetails);

  //       switch (status) {
  //         case 400:
  //           // Bad Request - Invalid request format, missing required fields, invalid provider_id
  //           console.warn(`⚠️ Bad Request (400) for ${linkedinUrn}: ${responseData?.message || 'Invalid request'}`);
  //           throw new Error(`INVITATION_ERROR_400: ${fullErrorData}`);

  //         case 401:
  //           // Unauthorized - Invalid API key, expired token
  //           console.warn(`⚠️ Unauthorized (401) for ${linkedinUrn}: Invalid API credentials`);
  //           throw new Error(`INVITATION_ERROR_401: ${fullErrorData}`);

  //         case 403:
  //           // Forbidden - Access denied, account suspended, insufficient permissions
  //           console.warn(`⚠️ Forbidden (403) for ${linkedinUrn}: ${responseData?.message || 'Access denied'}`);
  //           throw new Error(`INVITATION_ERROR_403: ${fullErrorData}`);

  //         case 404:
  //           // Not Found - User doesn't exist, invalid provider_id
  //           console.warn(`⚠️ User Not Found (404): ${linkedinUrn} - ${responseData?.message || 'User not found'}`);
  //           throw new Error(`INVITATION_ERROR_404: ${fullErrorData}`);

  //         case 409:
  //           // Conflict - Already connected, invitation already sent, user blocked you
  //           console.warn(`⚠️ Conflict (409) for ${linkedinUrn}: ${responseData?.message || 'Already connected or invitation pending'}`);
  //           throw new Error(`INVITATION_ERROR_409: ${fullErrorData}`);

  //         case 422:
  //           // Unprocessable Entity - Rate limits, LinkedIn restrictions, message too long
  //           console.warn(`⚠️ Unprocessable Entity (422) for ${linkedinUrn}: ${responseData?.message || 'Rate limit or LinkedIn restriction'}`);
  //           // Keep special handling for 422 to trigger fallback to no-message invitations
  //           throw new Error('INVITATION_LIMIT_422'); // Special error code for workflow logic

  //         case 429:
  //           // Too Many Requests - API rate limiting
  //           console.warn(`⚠️ Rate Limited (429) for ${linkedinUrn}: ${responseData?.message || 'API rate limit exceeded'}`);
  //           throw new Error(`INVITATION_ERROR_429: ${fullErrorData}`);

  //         case 500:
  //           // Internal Server Error - Unipile server issues
  //           console.warn(`⚠️ Server Error (500) for ${linkedinUrn}: ${responseData?.message || 'Unipile server error'}`);
  //           throw new Error(`INVITATION_ERROR_500: ${fullErrorData}`);

  //         case 502:
  //         case 503:
  //         case 504:
  //           // Bad Gateway / Service Unavailable / Gateway Timeout - LinkedIn API issues
  //           console.warn(`⚠️ Service Unavailable (${status}) for ${linkedinUrn}: ${responseData?.message || 'LinkedIn API unavailable'}`);
  //           throw new Error(`INVITATION_ERROR_${status}: ${fullErrorData}`);

  //         default:
  //           // Unknown status code
  //           console.warn(`⚠️ Unknown Error (${status || 'UNKNOWN'}) for ${linkedinUrn}: ${responseData?.message || 'Unknown error'}`);
  //           throw new Error(`INVITATION_ERROR_${status || 'UNKNOWN'}: ${fullErrorData}`);
  //       }
  //     }
      
  //     // Non-axios errors (network issues, timeouts, etc.)
  //     const networkError = {
  //       error: error instanceof Error ? error.message : String(error),
  //       linkedinUrn,
  //       timestamp: new Date().toISOString(),
  //       type: 'network_error'
  //     };
  //     console.error('🌐 Network Error Details:', networkError);
  //     throw new Error(`INVITATION_NETWORK_ERROR: ${JSON.stringify(networkError)}`);
  //   }
  // }

  /**
   * @param linkedinUrn - The LinkedIn URN (provider_id)
   * @returns invitation_id if successful, null if failed
   */
  async sendConnectionRequestWithoutMessage(linkedinUrn: string, linkedinAccountId: string): Promise<string | null> {
    try {
      console.log(`📨 Sending connection request WITHOUT message to: ${linkedinUrn}`);
      
      const response = await axios.post(
        `${this.baseUrl}/users/invite`, 
        {
          // ✅ NO MESSAGE - just send basic connection request
          account_id: linkedinAccountId,
          provider_id: linkedinUrn
        },
        {
          headers: {
            'X-API-KEY': this.apiKey,
            'accept': 'application/json',
            'content-type': 'application/json'
          },
          timeout: 20000
        }
      );

      if (response.status === 200 || response.status === 201) {
        const invitationId = response.data?.invitation_id;
        
        if (invitationId && invitationId !== "" && invitationId !== "null") {
          console.log(`✅ Successfully sent connection request without message`);
          return invitationId;
        } else {
          console.warn(`⚠️ Connection request sent but no invitation_id returned`);
          console.warn('Response data:', response.data);
          return null;
        }
      } else {
        console.warn(`⚠️ Unexpected response status ${response.status} for connection request`);
        console.warn('Response data:', response.data);
        return null;
      }

    } catch (error) {
      console.error(`❌ Error sending connection request without message to ${linkedinUrn}:`, error);
      
      if (axios.isAxiosError(error)) {
        // ✅ ENHANCED: Capture full error details for debugging
        const errorDetails = {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
          url: error.config?.url,
          method: error.config?.method,
          requestBody: error.config?.data,
          timestamp: new Date().toISOString(),
          type: 'connection_without_message'
        };

        console.error('📋 Full Connection Request (No Message) API Error Details:', errorDetails);

        const status = error.response?.status;
        const responseData = error.response?.data;

        switch (status) {
          case 400:
            console.warn(`⚠️ Bad Request (400) for no-message connection to ${linkedinUrn}: ${responseData?.message || 'Invalid request'}`);
            throw new Error(`CONNECTION_ERROR_400: ${responseData}`);

          case 401:
            console.warn(`⚠️ Unauthorized (401) for no-message connection to ${linkedinUrn}: Invalid API credentials`);
            throw new Error(`CONNECTION_ERROR_401: ${responseData}`);

          case 403:
            console.warn(`⚠️ Forbidden (403) for no-message connection to ${linkedinUrn}: ${responseData?.message || 'Access denied'}`);
            throw new Error(`CONNECTION_ERROR_403: ${responseData}`);

          case 404:
            console.warn(`⚠️ User Not Found (404) for no-message connection: ${linkedinUrn} - ${responseData?.message || 'User not found'}`);
            throw new Error(`CONNECTION_ERROR_404: ${responseData}`);

          case 409:
            console.warn(`⚠️ Conflict (409) for no-message connection to ${linkedinUrn}: ${responseData?.message || 'Already connected or invitation pending'}`);
            throw new Error(`CONNECTION_ERROR_409: ${responseData}`);

          case 422:
            // Special case: Even no-message connections are blocked
            console.warn(`⚠️ 422 error even for connection request without message to ${linkedinUrn}: ${responseData?.message || 'Completely rate limited'}`);
            throw new Error(`CONNECTION_LIMIT_422 : ${responseData}`); // Special error code for workflow logic

          case 429:
            console.warn(`⚠️ Rate Limited (429) for no-message connection to ${linkedinUrn}: ${responseData?.message || 'API rate limit exceeded'}`);
            throw new Error(`CONNECTION_ERROR_429: ${responseData}`);

          case 500:
            console.warn(`⚠️ Server Error (500) for no-message connection to ${linkedinUrn}: ${responseData?.message || 'Unipile server error'}`);
            throw new Error(`CONNECTION_ERROR_500: ${responseData}`);

          case 502:
          case 503:
          case 504:
            console.warn(`⚠️ Service Unavailable (${status}) for no-message connection to ${linkedinUrn}: ${responseData?.message || 'LinkedIn API unavailable'}`);
            throw new Error(`CONNECTION_ERROR_${status}: ${responseData}`);

          default:
            console.warn(`⚠️ Unknown Error (${status || 'UNKNOWN'}) for no-message connection to ${linkedinUrn}: ${responseData?.message || 'Unknown error'}`);
            throw new Error(`CONNECTION_ERROR_${status || 'UNKNOWN'}: ${responseData}`);
        }
      }
      
      // Non-axios errors (network issues, timeouts, etc.)
      const networkError = {
        error: error instanceof Error ? error.message : String(error),
        linkedinUrn,
        timestamp: new Date().toISOString(),
        type: 'connection_network_error'
      };
      console.error('🌐 Connection Request Network Error Details:', networkError);
      throw new Error(`CONNECTION_NETWORK_ERROR: ${JSON.stringify(networkError)}`);
    }
  }

  /**
   * @param attendeeId - The LinkedIn URN of the person to message
   * @param message - The message text to send
   * @returns Object with chat_id and message_id if successful, null if failed
   */
  async sendMessage(attendeeId: string, message: string, linkedinAccountId: string): Promise<{chatId: string, messageId: string} | null> {
    try {
      console.log(`💬 Sending message to: ${attendeeId}`);
      console.log(`📝 Message: "${message.substring(0, 50)}..."`);
      
      // ✅ FIXED: Use multipart/form-data instead of JSON
      const formData = new FormData();
      formData.append('attendees_ids', attendeeId);
      formData.append('text', message);
      formData.append('account_id', linkedinAccountId);

      const response = await axios.post(
        `${this.baseUrl}/chats`, // ✅ FIXED: Correct endpoint
        formData,
        {
          headers: {
            // ✅ FIXED: Use X-API-KEY instead of Authorization Bearer
            'X-API-KEY': this.apiKey,
            'accept': 'application/json'
          },
          timeout: 20000
        }
      );

      // ✅ FIXED: Parse response according to correct structure
      if (response.status === 200 || response.status === 201) {
        const chatId = response.data?.chat_id;
        const messageId = response.data?.message_id;
        
        if (chatId && messageId) {
          console.log(`✅ Successfully sent message`);
          console.log(`📋 Chat ID: ${chatId}`);
          console.log(`📋 Message ID: ${messageId}`);
          
          return {
            chatId: chatId,
            messageId: messageId
          };
        } else {
          console.warn(`⚠️ Message sent but missing chat_id or message_id`);
          console.warn('Response data:', response.data);
          return null;
        }
      } else {
        console.warn(`⚠️ Unexpected response status ${response.status} for message`);
        console.warn('Response data:', response.data);
        return null;
      }

    } catch (error) {
      console.error(`❌ Error sending message to ${attendeeId}:`, error);
      
      if (axios.isAxiosError(error)) {
        // ✅ ENHANCED: Capture full error details for debugging
        const errorDetails = {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
          url: error.config?.url,
          method: error.config?.method,
          requestBody: error.config?.data,
          timestamp: new Date().toISOString(),
          type: 'send_message'
        };

        console.error('📋 Full Send Message API Error Details:', errorDetails);

        const status = error.response?.status;
        const responseData = error.response?.data;

        switch (status) {
          case 400:
            console.warn(`⚠️ Bad Request (400) for sending message to ${attendeeId}: ${responseData?.message || 'Invalid attendee ID or message format'}`);
            throw new Error(`MESSAGE_ERROR_400: ${responseData}`);

          case 401:
            console.warn(`⚠️ Unauthorized (401) for sending message to ${attendeeId}: Invalid API credentials`);
            throw new Error(`MESSAGE_ERROR_401: ${responseData}`);

          case 403:
            console.warn(`⚠️ Forbidden (403) for sending message to ${attendeeId}: ${responseData?.message || 'Not connected or messaging disabled'}`);
            throw new Error(`MESSAGE_ERROR_403: ${responseData}`);

          case 404:
            console.warn(`⚠️ User Not Found (404): ${attendeeId} - ${responseData?.message || 'User not found or not connected'}`);
            throw new Error(`MESSAGE_ERROR_404: ${responseData}`);

          case 409:
            console.warn(`⚠️ Conflict (409) for sending message to ${attendeeId}: ${responseData?.message || 'Message conflict or duplicate'}`);
            throw new Error(`MESSAGE_ERROR_409: ${responseData}`);

          case 422:
            console.warn(`⚠️ Unprocessable Entity (422) for sending message to ${attendeeId}: ${responseData?.message || 'Message content rejected'}`);
            throw new Error(`MESSAGE_ERROR_422: ${responseData}`);

          case 429:
            console.warn(`⚠️ Rate Limited (429) for sending message to ${attendeeId}: ${responseData?.message || 'API rate limit exceeded'}`);
            throw new Error(`MESSAGE_ERROR_429: ${responseData}`);

          case 500:
            console.warn(`⚠️ Server Error (500) for sending message to ${attendeeId}: ${responseData?.message || 'Unipile server error'}`);
            throw new Error(`MESSAGE_ERROR_500: ${responseData}`);

          case 502:
          case 503:
          case 504:
            console.warn(`⚠️ Service Unavailable (${status}) for sending message to ${attendeeId}: ${responseData?.message || 'LinkedIn API unavailable'}`);
            throw new Error(`MESSAGE_ERROR_${status}: ${responseData}`);

          default:
            console.warn(`⚠️ Unknown Error (${status || 'UNKNOWN'}) for sending message to ${attendeeId}: ${responseData?.message || 'Unknown error'}`);
            throw new Error(`MESSAGE_ERROR_${status || 'UNKNOWN'}: ${responseData}`);
        }
      }
      
      // Non-axios errors (network issues, timeouts, etc.)
      const networkError = {
        error: error instanceof Error ? error.message : String(error),
        attendeeId,
        message: message.substring(0, 100), // First 100 chars for debugging
        timestamp: new Date().toISOString(),
        type: 'send_message_network_error'
      };
      console.error('🌐 Send Message Network Error Details:', networkError);
      throw new Error(`MESSAGE_NETWORK_ERROR: ${JSON.stringify(networkError)}`);
    }
  }

}

