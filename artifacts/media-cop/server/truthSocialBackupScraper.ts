import { isEasternDST } from './timezoneUtils';

export interface TruthSocialPostData {
  postId: string;
  content: string;
  postedAt: Date;
  truthSocialUrl: string;
  imageUrl?: string | null;
  videoUrl?: string | null;
  videoThumbnailUrl?: string | null;
  isReblog?: boolean;
  rebloggedFrom?: string | null;
}

interface CivicTrackerPost {
  id: number;
  platform: string;
  post_id: string;
  content: string;
  posted_at: string;
  media_urls: string[];
  original_url: string;
  has_media: boolean;
  official_uuid: string;
  official_name: string;
  username: string;
  official_type: string;
  is_deleted: boolean;
}

interface CivicTrackerResponse {
  posts: CivicTrackerPost[];
}

const TRUMP_UUID = '3094abf7-4a95-4b8d-8c8d-af7d1c3747a1';
const CIVICTRACKER_API = 'https://civictracker.us/wp-json/civictracker/v1/proxy/social-posts';

export async function scrapeTruthSocialBackup(): Promise<TruthSocialPostData[]> {
  const posts: TruthSocialPostData[] = [];
  
  try {
    console.log('Starting CivicTracker backup scraper (API mode)...');
    
    const url = new URL(CIVICTRACKER_API);
    url.searchParams.set('official_uuid', TRUMP_UUID);
    url.searchParams.set('limit', '24');
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    
    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      console.error(`CivicTracker API returned status ${response.status}`);
      return [];
    }
    
    const data = await response.json() as CivicTrackerResponse;
    
    if (!data?.posts || !Array.isArray(data.posts)) {
      console.log('CivicTracker API returned no posts');
      return [];
    }
    
    console.log(`CivicTracker API: Found ${data.posts.length} posts`);
    
    for (const post of data.posts) {
      if (post.platform !== 'Truth Social') {
        continue;
      }
      
      if (post.is_deleted) {
        continue;
      }
      
      let content = post.content?.trim() || '';
      
      if (content.length < 5 && !post.has_media) {
        continue;
      }
      
      // CivicTracker returns timestamps - treat as Eastern Time to match primary scraper
      let postedAt: Date;
      const postedAtStr = post.posted_at;
      
      // If timestamp already has timezone info (Z or +/-), parse directly as UTC
      if (postedAtStr.endsWith('Z') || postedAtStr.includes('+') || (postedAtStr.includes('-') && postedAtStr.lastIndexOf('-') > 9)) {
        postedAt = new Date(postedAtStr);
      } else {
        // No timezone — treat as Eastern Time, correctly determining EST vs EDT
        const cleanStr = postedAtStr.replace('T', ' ').replace(/\.\d+$/, '');
        const naiveDate = new Date(cleanStr);
        const tzAbbr = isEasternDST(naiveDate) ? 'EDT' : 'EST';
        postedAt = new Date(`${cleanStr} ${tzAbbr}`);
        
        if (isNaN(postedAt.getTime())) {
          postedAt = new Date(postedAtStr);
        }
      }
      
      if (isNaN(postedAt.getTime())) {
        console.warn(`Invalid date for post ${post.post_id}: ${post.posted_at}`);
        continue;
      }
      
      const videoExtensions = /\.(mp4|mov|webm|avi|mkv)(\?|$)/i;

      let videoUrl: string | null = null;
      let videoThumbnailUrl: string | null = null;
      let imageUrl: string | null = null;

      if (post.has_media && post.media_urls?.length > 0) {
        const videoUrls = post.media_urls.filter((url: string) => videoExtensions.test(url));
        const imageUrls = post.media_urls.filter((url: string) => !videoExtensions.test(url));
        if (videoUrls.length > 0) {
          videoUrl = videoUrls[0];
        }
        const isTinyIcon = (url: string) =>
          /\/(favicon|apple-touch-icon|site-icon|icons?)(\/|\.|\?|$)/i.test(url) ||
          /logo\.clearbit\.com/i.test(url) || /gstatic\.com\/faviconV2/i.test(url);
        const validImageUrls = imageUrls.filter((url: string) => !isTinyIcon(url));
        if (validImageUrls.length > 0) {
          if (videoUrl) {
            videoThumbnailUrl = validImageUrls[0];
          } else {
            imageUrl = validImageUrls[0];
          }
        }
      }

      if (!content || content.length < 5) {
        if (!videoUrl && !imageUrl) continue;
        if (!content) content = '[Media attachment]';
      }

      let displayContent = content;
      
      // Detect reblog/ReTruth - check if the URL points to a different user
      let isReblog = false;
      let rebloggedFrom: string | null = null;
      const originalUrl = post.original_url || '';
      const urlAuthorMatch = originalUrl.match(/truthsocial\.com\/@([^\/]+)/);
      if (urlAuthorMatch && urlAuthorMatch[1].toLowerCase() !== 'realdonaldtrump') {
        isReblog = true;
        rebloggedFrom = urlAuthorMatch[1];
      }
      
      posts.push({
        postId: post.post_id,
        content: displayContent,
        postedAt,
        truthSocialUrl: post.original_url || `https://truthsocial.com/@realDonaldTrump/posts/${post.post_id}`,
        imageUrl,
        videoUrl,
        videoThumbnailUrl,
        isReblog,
        rebloggedFrom,
      });
    }
    
    console.log(`CivicTracker backup: Scraped ${posts.length} Truth Social posts`);
    return posts;
    
  } catch (error: unknown) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        console.error('CivicTracker API request timed out');
      } else {
        console.error('CivicTracker API error:', error.message);
      }
    } else {
      console.error('Backup scraper error:', error);
    }
    return [];
  }
}

export async function forceCloseBrowser() {
}
