import { openai } from './aiClient';
import { withAiTimeout, AI_CALL_TIMEOUT_MS, AI_CALL_BACKSTOP_MS } from './aiTimeout';
import { storage } from './storage';
import type { CustomMcop, Headline } from '@shared/schema';


const BASE_INSTRUCTIONS = `You are a custom-priority news classifier. For each headline below, return a priority_score from 1-100 reflecting how important it is RELATIVE TO THIS USER'S PRIORITIES, and is_relevant=true if it should appear in their dashboard at all (false if it should be hidden).

Return JSON: { "results": [ { "title": "...", "is_relevant": true|false, "priority_score": 1-100, "reason": "short" }, ... ] }
The results array MUST be the same length and order as the input headlines.`;

function buildSystemPrompt(mcop: CustomMcop): string {
  const parts = [BASE_INSTRUCTIONS, '', '=== USER PRIORITIES ==='];
  if (mcop.generalPrompt && mcop.generalPrompt.trim()) {
    parts.push('\nGENERAL PRIORITIES:\n' + mcop.generalPrompt.trim());
  }
  if (mcop.lookForNow && mcop.lookForNow.trim()) {
    parts.push('\nWHAT TO LOOK FOR RIGHT NOW (boost these):\n' + mcop.lookForNow.trim());
  }
  if (mcop.exclude && mcop.exclude.trim()) {
    parts.push('\nEXCLUDE / DOWNRANK (mark is_relevant=false or score very low):\n' + mcop.exclude.trim());
  }
  return parts.join('\n');
}

interface ScoringResult {
  is_relevant: boolean;
  priority_score: number;
  reason?: string;
}

async function scoreBatch(mcop: CustomMcop, titles: string[]): Promise<ScoringResult[]> {
  if (titles.length === 0) return [];
  try {
    const response = await withAiTimeout(openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: buildSystemPrompt(mcop) },
        {
          role: 'user',
          content: `Score these ${titles.length} headlines:\n\n${titles.map((t, i) => `${i + 1}. ${t}`).join('\n')}`,
        },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }, { timeout: AI_CALL_TIMEOUT_MS, maxRetries: 0 }), AI_CALL_BACKSTOP_MS, 'customMcopScorer');

    const content = response.choices[0]?.message?.content;
    if (!content) return titles.map(() => ({ is_relevant: true, priority_score: 50 }));

    const parsed = JSON.parse(content);
    const results = parsed.results || parsed.headlines || [];
    if (!Array.isArray(results)) return titles.map(() => ({ is_relevant: true, priority_score: 50 }));

    return titles.map((_, i) => {
      const r = results[i] || {};
      return {
        is_relevant: r.is_relevant !== undefined ? !!r.is_relevant : true,
        priority_score: typeof r.priority_score === 'number' ? Math.max(0, Math.min(100, r.priority_score)) : 50,
        reason: typeof r.reason === 'string' ? r.reason : undefined,
      };
    });
  } catch (err) {
    console.error(`[CustomMcopScorer] Error scoring for ${mcop.slug}:`, err);
    return titles.map(() => ({ is_relevant: true, priority_score: 50 }));
  }
}

// ── Custom-MCOP scoring tunables (Task #484: leaner periodic scoring) ────────
// These three knobs govern the AI load of the PERIODIC scorer
// (scoreNewItemsForAllCustomMcops, driven by its own cron in scheduler.ts).
// They do NOT affect the on-demand rescoreAllForMcop path (prompt-edit rescore).
//
// - BATCH_SIZE: headlines per AI call. 30 keeps each gpt-4o-mini call well
//   within token limits while amortizing the system prompt across many titles.
// - MAX_HEADLINES_PER_RUN: ceiling on NEW (unscored) headlines scored per MCOP
//   per run. It is a safety cap, not a steady-state limit: any headlines beyond
//   it stay unscored and are picked up on the next run while still inside the
//   recency window, so it only ever bites during an unusual ingest spike. Kept
//   at 200 so coverage never silently degrades for an active MCOP.
// - PERIODIC_RECENCY_HOURS: how far back the periodic run looks for new
//   headlines. Each headline is scored exactly once (dedup by already-scored
//   set), so this window only needs to be wide enough that no fresh headline
//   ages out before a run reaches it. With a 30-min cron cadence, 24h gives a
//   ~48x safety margin while roughly halving the candidate set vs the old 48h.
const BATCH_SIZE = 30;
const MAX_HEADLINES_PER_RUN = 200;
const PERIODIC_RECENCY_HOURS = 24;

async function scoreHeadlinesForMcop(mcop: CustomMcop, headlines: Headline[]): Promise<void> {
  if (headlines.length === 0) return;
  const alreadyScored = await storage.getScoredHeadlineIdsForMcop(mcop.id);
  const unscored = headlines.filter(h => !alreadyScored.has(h.id)).slice(0, MAX_HEADLINES_PER_RUN);
  if (unscored.length === 0) {
    console.log(`[CustomMcopScorer] ${mcop.slug}: nothing new to score`);
    return;
  }
  console.log(`[CustomMcopScorer] ${mcop.slug}: scoring ${unscored.length} new headlines`);

  for (let i = 0; i < unscored.length; i += BATCH_SIZE) {
    const batch = unscored.slice(i, i + BATCH_SIZE);
    const titles = batch.map(h => h.title);
    const results = await scoreBatch(mcop, titles);
    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      if (!r) continue;
      try {
        await storage.upsertCustomMcopScore(mcop.id, 'headline', batch[j].id, r.priority_score, r.is_relevant, r.reason ?? null);
      } catch (err) {
        console.error(`[CustomMcopScorer] Failed to upsert score for ${mcop.slug}/${batch[j].id}:`, err);
      }
    }
  }
  console.log(`[CustomMcopScorer] ${mcop.slug}: scored ${unscored.length} headlines`);
}

export async function scoreNewItemsForAllCustomMcops(): Promise<void> {
  try {
    const mcops = await storage.listCustomMcops();
    if (mcops.length === 0) return;
    const headlines = await storage.getRecentHeadlines(PERIODIC_RECENCY_HOURS);
    console.log(`[CustomMcopScorer] Running for ${mcops.length} custom MCOPs over ${headlines.length} recent headlines`);
    for (const mcop of mcops) {
      try {
        await scoreHeadlinesForMcop(mcop, headlines);
      } catch (err) {
        console.error(`[CustomMcopScorer] MCOP ${mcop.slug} failed (continuing):`, err);
      }
    }
  } catch (err) {
    console.error('[CustomMcopScorer] Top-level error:', err);
  }
}

export async function rescoreAllForMcop(mcopId: string): Promise<void> {
  const mcop = await storage.getCustomMcopById(mcopId);
  if (!mcop) return;
  // Clear existing scores so they get recomputed with the new prompt
  const headlines = await storage.getRecentHeadlines(48);
  // Force re-score by upserting fresh values for every headline (skip alreadyScored check)
  console.log(`[CustomMcopScorer] Rescore-all for ${mcop.slug}: ${headlines.length} headlines`);
  for (let i = 0; i < headlines.length; i += BATCH_SIZE) {
    const batch = headlines.slice(i, i + BATCH_SIZE);
    const results = await scoreBatch(mcop, batch.map(h => h.title));
    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      if (!r) continue;
      try {
        await storage.upsertCustomMcopScore(mcop.id, 'headline', batch[j].id, r.priority_score, r.is_relevant, r.reason ?? null);
      } catch {}
    }
  }
}
