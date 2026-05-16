// src/app/services/postsSheetService.ts

import { google } from 'googleapis';
import { CONFIG } from '../../config/config';
import { 
  PostRecord, 
  PostRecordInput, 
  PostQuery, 
  PostActionResult, 
  LeadPostStats 
} from '@/types/postsSheet';
import fs from 'fs';
import path from 'path';

export class PostsSheetService {
  private sheets: any;
  private auth: any;
  private isInitialized: boolean = false;
  private initializationPromise: Promise<void> | null = null;
  private readonly POSTS_SHEET_NAME = 'Posts';
  
  // Sheet headers - Row 1 (A1:R1)
  private readonly HEADERS = [
    'linkedinUrn',      // A
    'postId',           // B  
    'postContent',      // C
    'authorName',       // D
    'authorId',         // E
    'postType',         // F
    'relevanceScore',   // G
    'engagementScore',  // H
    'isLiked',          // I
    'isCommented',      // J
    'commentText',      // K
    'likedAt',          // L
    'commentedAt',      // M
    'createdAt',        // N
    'canComment',       // O
    'shareUrl',         // P
    'repostCommentary', // Q
    'daysOld'           // R
  ];

  constructor() {
    // Don't initialize in constructor - defer to first use
  }

  private async ensureInitialized(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    // Prevent multiple simultaneous initialization attempts
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this.initializeAuth();
    return this.initializationPromise;
  }

  private async initializeAuth(): Promise<void> {
    try {
      // Use environment-based path resolution for cloud deployment compatibility
      const credentialsPath = CONFIG.GOOGLE_CREDENTIALS_PATH.startsWith('/') 
        ? CONFIG.GOOGLE_CREDENTIALS_PATH 
        : path.resolve(process.cwd(), CONFIG.GOOGLE_CREDENTIALS_PATH);

      // Check if credentials file exists
      if (!fs.existsSync(credentialsPath)) {
        throw new Error(`Google credentials file not found at: ${credentialsPath}`);
      }

      const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
      
      this.auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });
      
      this.sheets = google.sheets({ version: 'v4', auth: this.auth });
      this.isInitialized = true;
      
      // Ensure Posts sheet exists after authentication
      await this.ensurePostsSheetExists();
      
      console.log('✅ Posts Sheet service initialized successfully');
      
    } catch (error) {
      console.error('❌ Failed to initialize Posts Sheet service:', error);
      this.isInitialized = false;
      this.initializationPromise = null;
      throw new Error(`Posts Sheet service initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Ensure the Posts sheet exists with proper headers
   */
  private async ensurePostsSheetExists(): Promise<void> {
    try {
      // Check if sheet exists
      const response = await this.sheets.spreadsheets.get({
        spreadsheetId: CONFIG.SHEETS.SPREADSHEET_ID
      });

      const existingSheets = response.data.sheets || [];
      const postsSheetExists = existingSheets.some(
        (sheet: any) => sheet.properties.title === this.POSTS_SHEET_NAME
      );

      if (!postsSheetExists) {
        console.log(`📋 Creating ${this.POSTS_SHEET_NAME} sheet...`);
        
        // Create the sheet
        await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: CONFIG.SHEETS.SPREADSHEET_ID,
          resource: {
            requests: [{
              addSheet: {
                properties: {
                  title: this.POSTS_SHEET_NAME,
                  gridProperties: {
                    rowCount: 1000,
                    columnCount: this.HEADERS.length
                  }
                }
              }
            }]
          }
        });

        // Add headers
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: CONFIG.SHEETS.SPREADSHEET_ID,
          range: `${this.POSTS_SHEET_NAME}!A1:${String.fromCharCode(65 + this.HEADERS.length - 1)}1`,
          valueInputOption: 'RAW',
          resource: {
            values: [this.HEADERS]
          }
        });

        console.log(`✅ ${this.POSTS_SHEET_NAME} sheet created with headers`);
      } else {
        console.log(`✅ ${this.POSTS_SHEET_NAME} sheet already exists`);
      }
    } catch (error) {
      console.error(`❌ Error ensuring ${this.POSTS_SHEET_NAME} sheet exists:`, error);
      throw error;
    }
  }

  /**
   * Store multiple filtered posts for a lead
   */
  async storePosts(posts: PostRecordInput[]): Promise<void> {
    if (posts.length === 0) return;

    await this.ensureInitialized();

    try {
      console.log(`📝 Storing ${posts.length} posts in ${this.POSTS_SHEET_NAME} sheet...`);

      const rows = posts.map(post => this.postToRow({
        ...post,
        isLiked: false,
        isCommented: false,
        commentText: '',
        likedAt: '',
        commentedAt: '',
        createdAt: post.originalCreatedAt,
        repostCommentary: post.repostCommentary || ''
      }));

      await this.sheets.spreadsheets.values.append({
        spreadsheetId: CONFIG.SHEETS.SPREADSHEET_ID,
        range: `${this.POSTS_SHEET_NAME}!A:R`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        resource: {
          values: rows
        }
      });

      console.log(`✅ Stored ${posts.length} posts for ${posts[0].linkedinUrn}`);
      
    } catch (error) {
      console.error('❌ Error storing posts:', error);
      throw error;
    }
  }

  /**
   * Get posts based on query filters
   */
  async getPosts(query: PostQuery): Promise<PostRecord[]> {
    await this.ensureInitialized();

    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: CONFIG.SHEETS.SPREADSHEET_ID,
        range: `${this.POSTS_SHEET_NAME}!A:R`
      });

      if (!response.data.values || response.data.values.length <= 1) {
        return [];
      }

      // Skip header row and convert to PostRecord objects
      const posts = response.data.values.slice(1)
        .filter((row: any[]) => row.length > 0 && row[0]) // Filter out empty rows
        .map((row: any[]) => this.rowToPost(row));

      // Apply filters
      return posts.filter((post: { linkedinUrn: string; isLiked: boolean; isCommented: boolean; canComment: boolean; relevanceScore: number; }) => {
        if (query.linkedinUrn && post.linkedinUrn !== query.linkedinUrn) return false;
        if (query.isLiked !== undefined && post.isLiked !== query.isLiked) return false;
        if (query.isCommented !== undefined && post.isCommented !== query.isCommented) return false;
        if (query.canComment !== undefined && post.canComment !== query.canComment) return false;
        if (query.minRelevanceScore && post.relevanceScore < query.minRelevanceScore) return false;
        return true;
      });

    } catch (error) {
      console.error('❌ Error getting posts:', error);
      return [];
    }
  }

  /**
   * Get posts ready for commenting for a specific lead
   */
  async getPostsForCommenting(linkedinUrn: string, limit: number = 2): Promise<PostRecord[]> {
    const posts = await this.getPosts({
      linkedinUrn,
      isLiked: true,
      isCommented: false,
      canComment: true
    });

    // Sort by relevance score and return top posts
    return posts
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, limit);
  }

  /**
   * Mark post as liked
   */
  async markPostAsLiked(linkedinUrn: string, postId: string): Promise<PostActionResult> {
    try {
      const result = await this.updatePostField(linkedinUrn, postId, {
        isLiked: true,
        likedAt: new Date().toISOString()
      });

      return {
        success: result,
        postId,
        action: 'like',
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      return {
        success: false,
        postId,
        action: 'like',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Mark post as commented
   */
  async markPostAsCommented(
    linkedinUrn: string, 
    postId: string, 
    commentText: string
  ): Promise<PostActionResult> {
    try {
      const result = await this.updatePostField(linkedinUrn, postId, {
        isCommented: true,
        commentedAt: new Date().toISOString(),
        commentText
      });

      return {
        success: result,
        postId,
        action: 'comment',
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      return {
        success: false,
        postId,
        action: 'comment',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Update specific fields for a post
   */
  private async updatePostField(
    linkedinUrn: string, 
    postId: string, 
    updates: Partial<PostRecord>
  ): Promise<boolean> {
    await this.ensureInitialized();

    try {
      // Get all rows to find the target post
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: CONFIG.SHEETS.SPREADSHEET_ID,
        range: `${this.POSTS_SHEET_NAME}!A:R`
      });

      if (!response.data.values || response.data.values.length <= 1) {
        return false;
      }

      // Find the row index (skip header)
      const rowIndex = response.data.values.slice(1).findIndex((row: any[]) => 
        row[0] === linkedinUrn && row[1] === postId
      );

      if (rowIndex === -1) {
        console.warn(`Post not found: ${postId} for ${linkedinUrn}`);
        return false;
      }

      // Get current row data
      const actualRowIndex = rowIndex + 2; // +1 for header, +1 for 0-based to 1-based
      const currentRow = response.data.values[rowIndex + 1];
      const currentPost = this.rowToPost(currentRow);

      // Apply updates
      const updatedPost = { ...currentPost, ...updates };
      const updatedRow = this.postToRow(updatedPost);

      // Update the specific row
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: CONFIG.SHEETS.SPREADSHEET_ID,
        range: `${this.POSTS_SHEET_NAME}!A${actualRowIndex}:R${actualRowIndex}`,
        valueInputOption: 'RAW',
        resource: {
          values: [updatedRow]
        }
      });

      return true;

    } catch (error) {
      console.error(`❌ Error updating post ${postId}:`, error);
      return false;
    }
  }

  /**
   * Get statistics for a lead's posts
   */
  async getLeadPostStats(linkedinUrn: string): Promise<LeadPostStats> {
    const posts = await this.getPosts({ linkedinUrn });

    if (posts.length === 0) {
      return {
        linkedinUrn,
        totalPosts: 0,
        likedPosts: 0,
        commentedPosts: 0,
        avgRelevanceScore: 0,
        lastActivity: ''
      };
    }

    const likedPosts = posts.filter(p => p.isLiked).length;
    const commentedPosts = posts.filter(p => p.isCommented).length;
    const avgRelevanceScore = posts.reduce((sum, p) => sum + p.relevanceScore, 0) / posts.length;
    
    // Find last activity
    const activities = [
      ...posts.filter(p => p.likedAt).map(p => p.likedAt),
      ...posts.filter(p => p.commentedAt).map(p => p.commentedAt)
    ].sort().reverse();

    return {
      linkedinUrn,
      totalPosts: posts.length,
      likedPosts,
      commentedPosts,
      avgRelevanceScore: Math.round(avgRelevanceScore * 100) / 100,
      lastActivity: activities[0] || ''
    };
  }

  /**
   * Delete old posts (cleanup)
   */
  async deleteOldPosts(daysOld: number = 30): Promise<number> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);

      const allPosts = await this.getPosts({});
      const oldPosts = allPosts.filter(post => {
        const postDate = new Date(post.createdAt);
        return postDate < cutoffDate;
      });

      if (oldPosts.length === 0) {
        return 0;
      }

      // Implementation for batch deletion would go here
      // For now, we'll just log the count
      console.log(`Found ${oldPosts.length} posts older than ${daysOld} days to delete`);
      
      return oldPosts.length;

    } catch (error) {
      console.error('❌ Error deleting old posts:', error);
      return 0;
    }
  }

  /**
   * Force update lead status with transition validation bypass
   */
  async forceUpdatePostStatus(
    linkedinUrn: string,
    postId: string,
    updates: Partial<PostRecord>,
    reason: string
  ): Promise<void> {
    await this.ensureInitialized();

    try {
      console.log(`🔧 Force updating post ${postId} for ${linkedinUrn}: ${reason}`);
      
      const success = await this.updatePostField(linkedinUrn, postId, updates);
      
      if (success) {
        console.log(`✅ Force updated post ${postId} successfully`);
      } else {
        console.warn(`⚠️ Force update failed for post ${postId}`);
      }
      
    } catch (error) {
      console.error(`❌ Error in force update for post ${postId}:`, error);
      throw error;
    }
  }

  /**
   * Convert PostRecord to sheet row
   */
  private postToRow(post: PostRecord): any[] {
    return [
      post.linkedinUrn,           // A
      post.postId,                // B
      post.postContent,           // C
      post.authorName,            // D
      post.authorId,              // E
      post.postType,              // F
      post.relevanceScore,        // G
      post.engagementScore,       // H
      post.isLiked,               // I
      post.isCommented,           // J
      post.commentText,           // K
      post.likedAt,               // L
      post.commentedAt,           // M
      post.createdAt,             // N
      post.canComment,            // O
      post.shareUrl,              // P
      post.repostCommentary,      // Q
      post.daysOld                // R
    ];
  }

  /**
   * Convert sheet row to PostRecord
   */
  private rowToPost(row: any[]): PostRecord {
    return {
      linkedinUrn: row[0] || '',
      postId: row[1] || '',
      postContent: row[2] || '',
      authorName: row[3] || '',
      authorId: row[4] || '',
      postType: (row[5] || 'original') as 'original' | 'repost',
      relevanceScore: parseFloat(row[6]) || 0,
      engagementScore: parseInt(row[7]) || 0,
      isLiked: row[8] === 'TRUE' || row[8] === true,
      isCommented: row[9] === 'TRUE' || row[9] === true,
      commentText: row[10] || '',
      likedAt: row[11] || '',
      commentedAt: row[12] || '',
      createdAt: row[13] || '',
      canComment: row[14] === 'TRUE' || row[14] === true,
      shareUrl: row[15] || '',
      repostCommentary: row[16] || '',
      daysOld: parseInt(row[17]) || 0
    };
  }

  /**
   * Log sheet metadata for debugging
   */
  private async logSheetMetadata(): Promise<void> {
    try {
      const response = await this.sheets.spreadsheets.get({
        spreadsheetId: CONFIG.SHEETS.SPREADSHEET_ID
      });
      
      const sheetNames = response.data.sheets?.map((sheet: any) => sheet.properties.title) || [];
      console.log(`📊 Available sheets: ${sheetNames.join(', ')}`);
      
      if (sheetNames.includes(this.POSTS_SHEET_NAME)) {
        console.log(`✅ ${this.POSTS_SHEET_NAME} sheet confirmed`);
      }
      
    } catch (error) {
      console.warn('⚠️ Could not log sheet metadata:', error);
    }
  }
}