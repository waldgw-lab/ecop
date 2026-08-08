// Task #811 — Re-score team submissions that were buried at the
// UNSCORED_BOT_PRIORITY floor because the AI scorer timed out or returned a
// malformed reply at post time.
//
// Background: when scoreHeadlinePrioritiesBatch (and, for the news bots, the
// inline analyzeBatchHeadlines retry) both fail, the bot writes the item with
// priorityScore = UNSCORED_BOT_PRIORITY (30) and score_source =
// 'unscored_fallback'. That score is below the main-feed promotion bar, so a
// genuinely high-priority story that only failed to SCORE (not to be relevant)
// stays permanently invisible in Team chat. This job finds those flagged rows
// and re-runs the SAME scorer a bounded number of times. When a real score
// comes back it is written through finalizeSubmissionAnalysis — the EXACT same
// promotion path the bots use — so a re-scored item that now clears the bar is
// auto-promoted with no change to promotion logic. When the scorer still fails,
// the attempt counter is bumped so the item is retried next cycle until the cap.

import { storage } from './storage';
import { scoreHeadlinePrioritiesBatch } from './aiAnalyzer';
import { qualifiesForFlashTopStories, FLASH_TOPIC_NAME } from './subjectMatcher';

// Retry at most this many times per row before giving up (leaves score_source
// as 'unscored_fallback' so it stays honestly distinguishable from a real 30,
// but stops churning the AI budget on a title the scorer can't handle).
const MAX_SCORE_RETRIES = 4;
// Only retry rows created within this window; older buried items are left as-is
// so a redeploy can't stampede the whole backlog through the scorer.
const RETRY_WINDOW_HOURS = 48;
// Bound the work per cycle so a large backlog is drained gradually and never
// dominates the AI grid on any single tick.
const MAX_PER_CYCLE = 40;

let isRunning = false;

export async function runScoreRetry(): Promise<{ retried: number; rescored: number; stillFailed: number }> {
  if (isRunning) {
    console.log('[ScoreRetry] Previous run still in progress, skipping');
    return { retried: 0, rescored: 0, stillFailed: 0 };
  }
  isRunning = true;
  const startTime = Date.now();
  let retried = 0;
  let rescored = 0;
  let stillFailed = 0;

  try {
    const pending = await storage.getUnscoredFallbackSubmissions(
      MAX_SCORE_RETRIES,
      RETRY_WINDOW_HOURS,
      MAX_PER_CYCLE,
    );
    if (pending.length === 0) {
      return { retried, rescored, stillFailed };
    }

    console.log(`[ScoreRetry] ${pending.length} unscored-fallback submission(s) to re-score`);

    // Score the whole batch in one LLM call (same chunked scorer the bots use).
    const titles = pending.map(p => p.headline).filter(t => typeof t === 'string' && t.trim().length > 0);
    let scores = new Map<string, number>();
    try {
      scores = await scoreHeadlinePrioritiesBatch(titles);
    } catch (err) {
      // A transport-level failure of the whole batch: bump every row's counter
      // so they retry next cycle, and bail. Never leave the scorer's failure
      // masquerading as a real score.
      console.error('[ScoreRetry] Batch scorer failed entirely, deferring to next cycle:', err);
      for (const row of pending) {
        try { await storage.markScoreRetryFailure(row.id); } catch {}
        retried++;
        stillFailed++;
      }
      return { retried, rescored, stillFailed };
    }

    const flashSubject = await storage.getSubjectByName(FLASH_TOPIC_NAME);
    const flashSubjectId = flashSubject?.id ?? null;

    for (const row of pending) {
      retried++;
      const newScore = scores.get(row.headline);
      if (typeof newScore !== 'number') {
        // Still couldn't score this title — bump the counter and try again later.
        try { await storage.markScoreRetryFailure(row.id); } catch {}
        stillFailed++;
        continue;
      }

      try {
        // Write the real score through the same finalize path the bots use so
        // promotion (and FLASH placement) is handled by existing logic. subjectId
        // is required by finalize; the row already has one from post time.
        await storage.finalizeSubmissionAnalysis(row.id, {
          headline: row.headline,
          summary: row.summary,
          sourceType: row.sourceType,
          subjectId: row.subjectId ?? '',
          sourceName: row.sourceName ?? undefined,
          publishedAt: row.publishedAt ?? undefined,
          priorityScore: newScore,
          scoreSource: 'ai',
          flashSubjectId: qualifiesForFlashTopStories(newScore) ? flashSubjectId : null,
          ogImageUrl: row.ogImageUrl ?? undefined,
        });
        rescored++;
        console.log(`[ScoreRetry] Re-scored "${row.headline.substring(0, 60)}" -> ${newScore} (was UNSCORED floor)`);
      } catch (err) {
        console.error(`[ScoreRetry] Failed to persist re-score for ${row.id}:`, err);
        try { await storage.markScoreRetryFailure(row.id); } catch {}
        stillFailed++;
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[ScoreRetry] Completed in ${duration}s - retried: ${retried}, rescored: ${rescored}, stillFailed: ${stillFailed}`);
    return { retried, rescored, stillFailed };
  } catch (error) {
    console.error('[ScoreRetry] Fatal error:', error);
    return { retried, rescored, stillFailed };
  } finally {
    isRunning = false;
  }
}
