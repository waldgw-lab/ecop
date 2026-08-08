import * as cheerio from 'cheerio';
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

export async function scrapeTruthSocialPrimary(): Promise<TruthSocialPostData[]> {
  const posts: TruthSocialPostData[] = [];
  const seenPostIds = new Set<string>();
  
  try {
    const response = await fetch('https://trumpstruth.org/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch: ${response.status}`);
    }
    
    const html = await response.text();
    const $ = cheerio.load(html);
    
    $('.status').each((_, element) => {
      const statusDiv = $(element);
      
      const statusLink = statusDiv.find('a[href*="/statuses/"]').first();
      const statusHref = statusLink.attr('href') || '';
      const postIdMatch = statusHref.match(/\/statuses\/(\d+)/);
      
      if (!postIdMatch) return;
      const postId = postIdMatch[1];
      
      if (seenPostIds.has(postId)) return;
      seenPostIds.add(postId);
      
      const originalLink = statusDiv.find('a[href^="https://truthsocial.com"]').first();
      const truthSocialUrl = originalLink.attr('href') || '';
      if (!truthSocialUrl) return;
      
      // Check for reblog/ReTruth indicator
      let isReblog = false;
      let rebloggedFrom: string | null = null;
      
      // Look for reblog prepend text (e.g., "ReTruthed by @realDonaldTrump")
      const prepend = statusDiv.find('.status__prepend, .status__prepend-icon-wrapper').first();
      if (prepend.length > 0) {
        const prependText = prepend.text().trim().toLowerCase();
        if (prependText.includes('retruthed') || prependText.includes('reblog') || prependText.includes('boosted')) {
          isReblog = true;
          // Try to extract the original author from the URL or content
          const authorMatch = truthSocialUrl.match(/truthsocial\.com\/@([^\/]+)/);
          if (authorMatch && authorMatch[1].toLowerCase() !== 'realdonaldtrump') {
            rebloggedFrom = authorMatch[1];
          }
        }
      }
      
      // Also check if the post URL indicates it's from someone else (not Trump's own post)
      if (!isReblog) {
        const urlAuthorMatch = truthSocialUrl.match(/truthsocial\.com\/@([^\/]+)/);
        if (urlAuthorMatch && urlAuthorMatch[1].toLowerCase() !== 'realdonaldtrump') {
          isReblog = true;
          rebloggedFrom = urlAuthorMatch[1];
        }
      }
      
      let content = '';
      const statusContent = statusDiv.find('.status__content').first();
      if (statusContent.length > 0) {
        const paragraphs: string[] = [];
        statusContent.children('p').each((_, p) => {
          const text = $(p).text().trim();
          if (text && text.length > 10) {
            paragraphs.push(text);
          }
        });
        if (paragraphs.length > 0) {
          // Join all paragraphs to get full content instead of just the first one
          content = paragraphs.join('\n\n');
        }
        
        if (!content) {
          content = statusContent.text().trim();
        }
      }
      
      let imageUrl: string | null = null;
      const mediaAttachment = statusDiv.find('.media-gallery img, .attachment img, img.u-photo')
        .not('.h-card img, .account__avatar img, .p-author img, .avatar img, .account__header img');
      if (mediaAttachment.length > 0) {
        const src = mediaAttachment.first().attr('src') || '';
        const isVideo = /\.(mp4|mov|webm|avi|mkv)(\?|$)/i.test(src);
        const isLinkPreview = statusDiv.find('.status-card, .link-preview, .preview-card').find('img').is(mediaAttachment.first());
        const isTinyIcon = /\/(favicon|apple-touch-icon|site-icon|icons?)(\/|\.|\?|$)/i.test(src) ||
          /logo\.clearbit\.com/i.test(src) || /gstatic\.com\/faviconV2/i.test(src);
        const isAvatar = /\/(avatars?|accounts?\/avatars?|profile_images?|headers?)\//i.test(src);
        if (!isVideo && !isLinkPreview && !isTinyIcon && !isAvatar && src) {
          imageUrl = src;
        }
      }

      let videoUrl: string | null = null;
      let videoThumbnailUrl: string | null = null;
      const videoElement = statusDiv.find('video');
      if (videoElement.length > 0) {
        const src = videoElement.attr('src') || '';
        const sourceTag = videoElement.find('source').attr('src') || '';
        videoUrl = src || sourceTag || null;
        videoThumbnailUrl = videoElement.attr('poster') || null;
      }
      if (!videoUrl) {
        const videoLink = statusDiv.find('a[href*=".mp4"], a[href*=".mov"], a[href*=".webm"]');
        if (videoLink.length > 0) {
          videoUrl = videoLink.first().attr('href') || null;
        }
      }
      if (!videoUrl) {
        const videoPlayerDiv = statusDiv.find('.media-gallery__item--video, .video-player');
        if (videoPlayerDiv.length > 0) {
          const bgStyle = videoPlayerDiv.attr('style') || '';
          const bgMatch = bgStyle.match(/url\(['"]?([^'")\s]+)['"]?\)/);
          if (bgMatch) {
            videoThumbnailUrl = bgMatch[1];
          }
        }
      }

      const hasVideo = !!videoUrl;
      if (!hasVideo && !content && !imageUrl) return;
      if (!content || content.length < 10) {
        if (!hasVideo && !imageUrl) return;
        if (!content) content = '[Media attachment]';
      }
      
      if (content.toLowerCase().includes('click to view')) {
        console.log(`Skipping placeholder post ${postId}`);
        return;
      }
      
      const timestampLink = statusDiv.find('a[href*="/statuses/' + postId + '"]').first();
      const timestampText = timestampLink.text().trim();
      
      let postedAt: Date;
      try {
        // Determine correct Eastern timezone (EST vs EDT) based on the date
        // US Eastern DST: 2nd Sunday of March 2AM to 1st Sunday of November 2AM
        const naiveDate = new Date(timestampText);
        const tzAbbr = isEasternDST(naiveDate) ? 'EDT' : 'EST';
        postedAt = new Date(`${timestampText} ${tzAbbr}`);
        
        if (isNaN(postedAt.getTime())) {
          // Try the other timezone as fallback
          const fallbackTz = tzAbbr === 'EDT' ? 'EST' : 'EDT';
          postedAt = new Date(`${timestampText} ${fallbackTz}`);
        }
        
        if (isNaN(postedAt.getTime())) {
          console.warn(`Failed to parse timestamp: ${timestampText}`);
          return;
        }
      } catch (e) {
        console.warn(`Error parsing timestamp: ${timestampText}`);
        return;
      }
      
      posts.push({
        postId,
        content,
        postedAt,
        truthSocialUrl,
        imageUrl,
        videoUrl,
        videoThumbnailUrl,
        isReblog,
        rebloggedFrom,
      });
    });
    
    console.log(`Primary source: Scraped ${posts.length} Truth Social posts`);
    return posts;
    
  } catch (error) {
    console.error('Primary scraper error:', error);
    return [];
  }
}
