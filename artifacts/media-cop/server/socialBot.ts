import { storage } from './storage';
import { matchOrCreateSubject, FLASH_TOPIC_NAME, qualifiesForFlashTopStories, CJCS_TOPIC_NAME, detectCJCSMention } from './subjectMatcher';
import { UNSCORED_BOT_PRIORITY } from './relevanceDefinition';
import { scoreHeadlinePrioritiesBatch } from './aiAnalyzer';
import { htmlToSmsText } from './lib/htmlToSmsText';

const SOCIAL_BOT_USER_ID = 'social-bot-system';
const SOCIAL_BOT_USER_NAME = 'Social Bot';

interface SocialPost {
  id: string;
  postId: string;
  content: string;
  postedAt: Date;
  url: string;
  source: 'POTUS' | 'SecWar';
  sourceName: string;
}

function truncateContent(content: string, maxLength: number = 200): string {
  if (content.length <= maxLength) return content;
  return content.substring(0, maxLength).trim() + '...';
}

function extractHeadlineFromContent(content: string): string {
  const firstLine = content.split('\n')[0].trim();
  const cleaned = firstLine.replace(/^["'"']|["'"']$/g, '').trim();
  const headline = cleaned.length > 150 ? cleaned.substring(0, 147) + '...' : cleaned;
  return headline || truncateContent(content, 100);
}

async function postSocialToTeamChat(post: SocialPost, precomputedPriority?: number | null): Promise<boolean> {
  try {
    const isAlreadyPosted = await storage.isSocialPostReposted(post.postId, post.source);
    if (isAlreadyPosted) {
      console.log(`[SocialBot] Skipping already posted: ${post.source} - ${post.postId}`);
      return false;
    }

    const isBlocked = await storage.isBotContentBlocked(post.url);
    if (isBlocked) {
      console.log(`[SocialBot] Skipping blocked content: ${post.source} - ${post.postId}`);
      return false;
    }

    const headline = extractHeadlineFromContent(post.content);
    const summary = truncateContent(post.content, 300);
    
    const message = `**${post.sourceName} Post**\n\n${post.content}\n\n${post.url}`;

    const chatMessage = await storage.addChatMessage({
      userId: SOCIAL_BOT_USER_ID,
      userName: SOCIAL_BOT_USER_NAME,
      userProfileImage: null,
      message,
    });

    try {
      await storage.addSocialBotPost({
        postId: post.postId,
        source: post.source,
        chatMessageId: chatMessage.id,
      });
    } catch (dbError: any) {
      if (dbError?.code === '23505') {
        console.log(`[SocialBot] Skipping duplicate (constraint): ${post.source} - ${post.postId}`);
        return false;
      }
      throw dbError;
    }

    try {
      const existingSubmission = await storage.getSubmissionByUrl(post.url);
      if (!existingSubmission) {
        const { subjectName } = await matchOrCreateSubject(headline, summary, 'SocialBot');
        const subject = await storage.findOrCreateSubject(subjectName, SOCIAL_BOT_USER_ID);

        // POTUS Truth Social posts are intentionally NOT priority-scored: they
        // always render in the Truth Social panel + Team chat regardless, and
        // social posts can never auto-promote to the main headline feed anyway
        // (qualifiesForMainFeedPromotion requires sourceType 'news'). The only
        // thing a score ever did for them was FLASH placement at 66+, which the
        // user chose to drop. priorityScore stays NULL = honest "not scored"
        // (never the misleading UNSCORED_BOT_PRIORITY fallback), and null never
        // qualifies for FLASH. Editors can still set a score manually.
        // SecWar posts keep the existing batch-scored behavior.
        const priorityScore: number | null = post.source === 'POTUS'
          ? null
          : (typeof precomputedPriority === 'number' ? precomputedPriority : UNSCORED_BOT_PRIORITY);

        let flashSubjectId: string | null = null;
        if (qualifiesForFlashTopStories(priorityScore)) {
          console.log(`[SocialBot] HIGH PRIORITY (${priorityScore}) - Adding to FLASH: TOP STORIES`);
          const flashSubject = await storage.getSubjectByName(FLASH_TOPIC_NAME);
          if (flashSubject) {
            flashSubjectId = flashSubject.id;
          }
        }

        // Check for CJCS (Chairman Caine) mentions
        let cjcsSubjectId: string | null = null;
        const mentionsCJCS = await detectCJCSMention(headline, summary);
        if (mentionsCJCS) {
          console.log(`[SocialBot] CJCS MENTION DETECTED - Adding to CJCS MENTIONS`);
          const cjcsSubject = await storage.getSubjectByName(CJCS_TOPIC_NAME);
          if (cjcsSubject) {
            cjcsSubjectId = cjcsSubject.id;
          }
        }

        const submission = await storage.addSubmission({
          chatMessageId: chatMessage.id,
          submittedBy: SOCIAL_BOT_USER_ID,
          submittedByName: SOCIAL_BOT_USER_NAME,
          sourceType: 'social_media',
          sourceUrl: post.url,
          headline,
          summary,
          status: 'processed',
          priorityScore,
        });

        await storage.finalizeSubmissionAnalysis(submission.id, {
          headline,
          summary,
          sourceType: 'social_media',
          subjectId: subject.id,
          sourceName: post.sourceName,
          publishedAt: post.postedAt,
          fullText: post.content,
          // For POTUS (null) omit the score entirely so the inserted NULL is
          // preserved instead of being overwritten.
          priorityScore: priorityScore ?? undefined,
          flashSubjectId,
          cjcsSubjectId,
        });
      }
    } catch (submissionError) {
      console.error(`[SocialBot] Error creating submission:`, submissionError);
    }

    console.log(`[SocialBot] Posted: ${post.source} - ${headline.substring(0, 50)}...`);
    return true;
  } catch (error) {
    console.error(`[SocialBot] Error posting to team chat:`, error);
    return false;
  }
}

export async function runSocialBot(): Promise<{ posted: number; skipped: number; errors: number }> {
  console.log('[SocialBot] Starting social media repost scan...');
  const startTime = Date.now();

  let posted = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    console.log('[SocialBot] Fetching recent Truth Social posts (POTUS)...');
    const truthPosts = await storage.getTruthSocialPostsSince(twentyFourHoursAgo);
    console.log(`[SocialBot] Found ${truthPosts.length} recent POTUS posts`);

    console.log('[SocialBot] Fetching recent SecWar posts...');
    const xPosts = await storage.getXPostsSince(twentyFourHoursAgo, 'SecWar');
    console.log(`[SocialBot] Found ${xPosts.length} recent SecWar posts`);

    const allPosts: SocialPost[] = [
      ...truthPosts.map(post => ({
        id: post.id,
        postId: post.postId,
        content: htmlToSmsText(post.content),
        postedAt: post.postedAt,
        url: post.truthSocialUrl,
        source: 'POTUS' as const,
        sourceName: 'POTUS (Truth Social)',
      })),
      ...xPosts.map(post => ({
        id: post.id,
        postId: post.postId,
        content: post.content,
        postedAt: post.postedAt,
        url: post.xUrl,
        source: 'SecWar' as const,
        sourceName: 'SecWar / Pete Hegseth (X)',
      })),
    ];

    // Score every SecWar post's priority in ONE batched AI call per cycle.
    // POTUS Truth Social posts are excluded from scoring entirely (see
    // postSocialToTeamChat): they surface in the Truth Social panel + Team chat
    // regardless of any score, so scoring them was wasted AI calls plus noise.
    let priorityMap = new Map<string, number>();
    const scorablePosts = allPosts.filter(p => p.source !== 'POTUS');
    if (scorablePosts.length > 0) {
      try {
        priorityMap = await scoreHeadlinePrioritiesBatch(
          scorablePosts.map(p => extractHeadlineFromContent(p.content)),
        );
      } catch (analyzeError) {
        console.error('[SocialBot] Error batch-scoring priorities:', analyzeError);
      }
    }

    for (const socialPost of allPosts) {
      const headline = extractHeadlineFromContent(socialPost.content);
      const success = await postSocialToTeamChat(socialPost, priorityMap.get(headline));
      if (success) {
        posted++;
      } else {
        skipped++;
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[SocialBot] Completed in ${duration}s - Posted: ${posted}, Skipped: ${skipped}, Errors: ${errors}`);

    return { posted, skipped, errors };
  } catch (error) {
    console.error('[SocialBot] Fatal error:', error);
    return { posted, skipped, errors: errors + 1 };
  }
}
