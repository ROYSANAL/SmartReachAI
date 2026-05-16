// src/types/postFilter.ts

// Input from Unipile API
export interface UnipilePost {
  id: string;
  social_id: string;
  text: string;
  share_url: string;
  date: string;
  parsed_datetime: string;
  reaction_counter: number;
  comment_counter: number;
  repost_counter: number;
  author: {
    id: string;
    name: string;
    headline?: string;
  };
  permissions: {
    can_post_comments: boolean;
    can_react: boolean;
    can_share: boolean;
  };
  is_repost: boolean;
  repost_content?: {
    id: string;
    text: string;
    author: {
      id: string;
      name: string;
    };
  };
}

// Filtered and scored post
export interface FilteredPost {
  postId: string;                    // Clean post ID (without URN prefix)
  content: string;                   // Content to use for comment generation
  originalText: string;              // Original post text (for reposts)
  authorName: string;                // Post author name
  authorId: string;                  // Post author ID
  postType: 'original' | 'repost';   // Type of post
  engagementScore: number;           // Total engagement (likes + comments + reposts)
  daysOld: number;                   // How many days since posted
  relevanceScore: number;            // Our calculated relevance score
  canComment: boolean;               // Whether we can comment on this post
  shareUrl: string;                  // LinkedIn URL to the post
  repostCommentary?: string;         // If repost, what the reposter added
  timestamp: string;                 // ✅ ADDED: Original post creation timestamp (ISO string)
  originalCreatedAt: string;         // ✅ ADDED: Calculated creation date for storage
}

// Filter result
export interface PostFilterResult {
  totalPosts: number;
  filteredPosts: FilteredPost[];
  relevantPosts: FilteredPost[];     // Top scored posts
  processingDate: string;
  filterCriteria: {
    avoidsCount: number;
    preferredCount: number;
    businessTopicsCount: number;
    minimumScore: number;
  };
}

// For storing in Google Sheets
export interface PostForCommenting {
  postId: string;
  content: string;                   // The content to generate comments from
  authorName: string;
  postType: 'original' | 'repost';
  relevanceScore: number;
}

// Compact format for Google Sheets storage
export interface LeadPostData {
  relevantPostsData: PostForCommenting[];  // Array of posts ready for commenting
  lastPostFilter: string;                  // When posts were last filtered
  totalPostsChecked: number;               // How many posts were analyzed
}