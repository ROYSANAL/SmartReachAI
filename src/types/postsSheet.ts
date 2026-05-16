
// Post record in the Posts sheet
export interface PostRecord {
  linkedinUrn: string;          // A: Foreign key to link with leads
  postId: string;               // B: Clean LinkedIn post ID
  postContent: string;          // C: Full content for comment generation
  authorName: string;           // D: Post author name
  authorId: string;             // E: Post author LinkedIn ID
  postType: 'original' | 'repost'; // F: Type of post
  relevanceScore: number;       // G: Our calculated relevance score
  engagementScore: number;      // H: LinkedIn engagement (likes + comments + shares)
  isLiked: boolean;            // I: Whether we liked this post
  isCommented: boolean;        // J: Whether we commented on this post
  commentText: string;         // K: The comment we made (if any)
  likedAt: string;             // L: When we liked it (ISO timestamp)
  commentedAt: string;         // M: When we commented (ISO timestamp)
  createdAt: string;           // N: When the post was originally created
  canComment: boolean;         // O: Whether we can comment on this post
  shareUrl: string;            // P: LinkedIn URL to the post
  repostCommentary: string;    // Q: If repost, what the reposter added
  daysOld: number;             // R: How many days since post was created
}

// Input data for creating a post record
export interface PostRecordInput {
  linkedinUrn: string;
  postId: string;
  postContent: string;
  authorName: string;
  authorId: string;
  postType: 'original' | 'repost';
  relevanceScore: number;
  engagementScore: number;
  canComment: boolean;
  shareUrl: string;
  repostCommentary?: string;
  daysOld: number;
  originalCreatedAt: string;
}

// Query filters for getting posts
export interface PostQuery {
  linkedinUrn?: string;
  isLiked?: boolean;
  isCommented?: boolean;
  canComment?: boolean;
  minRelevanceScore?: number;
}

// Post actions result
export interface PostActionResult {
  success: boolean;
  postId: string;
  action: 'like' | 'comment';
  timestamp: string;
  error?: string;
}

// Summary stats for a lead's posts
export interface LeadPostStats {
  linkedinUrn: string;
  totalPosts: number;
  likedPosts: number;
  commentedPosts: number;
  avgRelevanceScore: number;
  lastActivity: string;
}