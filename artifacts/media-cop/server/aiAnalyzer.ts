import { openai, isTransientAIError, parseAiJson, salvageJsonObjectArray, parseBatchResultArray, aiResponseSnippet } from './aiClient';
import { withAiTimeout, AI_CALL_TIMEOUT_MS, AI_CALL_BACKSTOP_MS } from './aiTimeout';
import { fetchViaPaywallBypass } from './paywallBypass';
import { ANALYZER_SYSTEM_PROMPT, CURATED_ANALYZER_SYSTEM_PROMPT, MAIN_FEED_PROMOTION_THRESHOLD } from './relevanceDefinition';
import { getCurrentContextBlock } from './strategicContext';
import { resolveAiScore } from './scoreAdjustments';
import { matchesEscalationPattern } from './escalationSignals';
import {
  coercePrimaryTopic,
  coerceConflictTrack,
  coerceScope,
  coerceCountryPair,
  inferConflictTrack,
  remapLegacyCategory,
  OTHER_EMERGING,
  type PrimaryTopic,
  type ConflictTrack,
  type Scope,
} from '@shared/classificationVocab';

interface AnalysisResult {
  title: string;
  is_relevant: boolean;
  reason: string;
  tags: string[];
  priority_score: number; // 1-100 scale, with 100 being most critical
}

// Curated lane — extends the base analysis with CONTENT-BASED classification
// (subject + geography of the story, never the outlet's geography). `country` is
// the single dominant country when one clearly dominates; null → show region.
//
// Task #336: also carries the controlled-vocabulary classification object —
// `primaryTopic` (enforced enum), `scope`, `conflictTrack`, and `proposedTopic`
// (the off-list label the model would add, for the human-gated proposals log).
// `category` is retained as the legacy free-form sub-label / audit fallback.
export interface CuratedAnalysisResult extends AnalysisResult {
  category: string;
  region: string | null;
  country: string | null;
  primaryTopic: PrimaryTopic;
  scope: Scope | null;
  conflictTrack: ConflictTrack | null;
  // Two FULL country names for a bilateral story (Topic·Focus model); else null.
  countryPair: string[] | null;
  proposedTopic: string | null;
}

interface HeadlineCluster {
  representative: string;
  headlines: string[];
  keywords: Set<string>;
}

// Extract key terms from headline for clustering
function extractKeywords(title: string): Set<string> {
  const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'be', 'has', 'have', 'had', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'must', 'new', 'says', 'say', 'after', 'over', 'more', 'than', 'into', 'through', 'up', 'out', 'it', 'its']);
  
  const normalized = title.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));
  
  return new Set(normalized);
}

// Calculate similarity between two headline keyword sets
function calculateSimilarity(keywords1: Set<string>, keywords2: Set<string>): number {
  const arr1 = Array.from(keywords1);
  const arr2 = Array.from(keywords2);
  const intersection = new Set(arr1.filter(k => keywords2.has(k)));
  const union = new Set([...arr1, ...arr2]);
  
  if (union.size === 0) return 0;
  
  // Jaccard similarity
  return intersection.size / union.size;
}

// --- Statecraft+escalation detector (clustering protection only) -------------
// Task #593: clusterHeadlines folds near-duplicate headlines and only sends the
// cluster REPRESENTATIVE to the AI, so every folded member silently INHERITS the
// representative's score. If a strong statecraft+escalation story folds into a
// cluster whose representative is a WEAKER variant, that important story is
// demoted with no trace — the exact silent-demotion risk Task #592 guards.
//
// This detector deterministically recognizes the three escalation patterns the
// removed Task #590 floor used to protect (mirroring the HIGH-band bullet in
// server/relevanceDefinition.ts). It is used ONLY to keep these headlines from
// folding into another cluster (see clusterHeadlines) — it is NOT a score floor:
// the AI still scores every escalation headline on its own merits. The only
// behavior change is that an escalation headline is always its OWN representative
// (scored directly), so it can never inherit a weaker neighbor's score.
// The escalation term lists + matchesEscalationPattern now live in the shared
// server/escalationSignals.ts module (imported above) so the adversary / force
// vocabularies can never drift between the main feed and the curated lane's
// U.S./coalition-casualty carve-out detector.

// Cluster headlines by topic similarity
function clusterHeadlines(titles: string[], similarityThreshold: number = 0.25): HeadlineCluster[] {
  const clusters: HeadlineCluster[] = [];
  let escalationStandalone = 0;
  
  for (const title of titles) {
    const keywords = extractKeywords(title);

    // Task #593: a statecraft+escalation headline is NEVER folded into another
    // cluster — it always becomes its OWN representative so the AI scores it
    // directly and it can never inherit a weaker representative's score. (It can
    // still ABSORB later non-escalation near-duplicates, since an escalation
    // representative is a safe, directly-scored anchor for those folds.)
    const isEscalation = matchesEscalationPattern(title);

    // Find existing cluster with similar keywords
    let assignedToCluster = false;
    if (!isEscalation) {
      for (const cluster of clusters) {
        const similarity = calculateSimilarity(keywords, cluster.keywords);

        if (similarity >= similarityThreshold) {
          // Add to existing cluster
          cluster.headlines.push(title);
          // Merge keywords
          keywords.forEach(k => cluster.keywords.add(k));
          assignedToCluster = true;
          break;
        }
      }
    }
    
    // Create new cluster if no similar cluster found (or this is an escalation
    // headline, which is always kept standalone as its own representative).
    if (!assignedToCluster) {
      if (isEscalation) escalationStandalone++;
      clusters.push({
        representative: title,
        headlines: [title],
        keywords: keywords,
      });
    }
  }
  
  console.log(`Clustered ${titles.length} headlines into ${clusters.length} distinct topic groups (${escalationStandalone} escalation headlines kept standalone for direct scoring)`);
  return clusters;
}

const SYSTEM_PROMPT = ANALYZER_SYSTEM_PROMPT;

// Task #1093: append the dynamic CURRENT CONTEXT block (today's date + the
// auto-derived current strategic picture) to the frozen rubric at call time.
// Fail-open: worst case is a date-only block; kill switch yields '' and the
// prompt is byte-identical to the pre-#1093 rubric. Curated-lane prompts are
// deliberately NOT wired through this (out of scope).
async function systemPromptWithContext(): Promise<string> {
  const ctx = await getCurrentContextBlock();
  return ctx ? `${SYSTEM_PROMPT}\n\n${ctx}` : SYSTEM_PROMPT;
}

// Batch analyzer output budget (Task #673). The two MAIN-FEED batch analyzers
// (analyzeBatchHeadlines / scoreHeadlinePrioritiesBatch) previously set NO
// explicit max_tokens and relied on the provider default, so a large batch's
// per-item reply (echoed title + reason + tags + scores) routinely hit the
// output cap and truncated mid-JSON — the salvage/tolerant-parse net (Task #642)
// then RECOVERED the items that came back but the tail was lost that pass and
// re-run the next cycle. Sizing the cap to the batch keeps a normal-size batch
// from truncating at all; salvage stays as the safety net for the rare
// oversize/anomalous reply.
//
// ~260 tokens/item is generous (mirrors the curated lane's 240/item at
// max_tokens:6000 for a 25-item chunk) since each object carries the echoed
// title, a free-text reason, a tags array and two scores. A base covers the
// JSON envelope. gpt-4o-mini caps output at 16384, so stay safely under it.
const BATCH_ANALYZER_TOKENS_PER_ITEM = 260;
const BATCH_ANALYZER_TOKENS_BASE = 512;
const BATCH_ANALYZER_TOKENS_CAP = 16000;
function batchAnalyzerMaxTokens(itemCount: number): number {
  return Math.min(
    BATCH_ANALYZER_TOKENS_CAP,
    BATCH_ANALYZER_TOKENS_BASE + BATCH_ANALYZER_TOKENS_PER_ITEM * Math.max(1, itemCount),
  );
}

// Chunk size for the two MAIN-FEED batch analyzers (Task #673). Sizing
// max_tokens to the batch stops a normal batch from truncating, but an
// unusually large batch (~60+ items) still exceeds BATCH_ANALYZER_TOKENS_CAP,
// and a very large single reply is inherently more failure-prone. Splitting the
// batch into bounded chunks keeps EVERY reply small enough to complete — the
// same defense the curated lane uses (CURATED_ANALYZE_CHUNK_SIZE = 25). Chunks
// run SEQUENTIALLY here rather than concurrently: the shared aiClient already
// throttles globally, the common batch is a single chunk (identical to the old
// one-call path), and serial keeps rate pressure + ordering predictable. Salvage
// stays the per-chunk safety net for a rare anomalous reply.
const BATCH_ANALYZER_CHUNK_SIZE = 25;

function chunkArray<T>(arr: T[], size: number): T[][] {
  if (arr.length <= size) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Analyze ONE chunk of cluster representatives. Returns the parsed results, or
// null when the reply can't be parsed into any result (so analyzeBatchHeadlines
// can apply its fail-open/closed policy per chunk instead of losing the whole
// batch). Throws only on transport/timeout errors, caught by the caller.
async function analyzeRepresentativeChunk(chunkReps: string[]): Promise<AnalysisResult[] | null> {
  const systemPrompt = await systemPromptWithContext();
  const response = await withAiTimeout(openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Analyze ALL ${chunkReps.length} headlines and assign appropriate strategic tags to each. Mark is_relevant=true for military/strategic topics, false for non-military topics:\n\n${chunkReps.map((title, idx) => `${idx + 1}. ${title}`).join('\n')}`,
      },
    ],
    temperature: 0.3,
    max_tokens: batchAnalyzerMaxTokens(chunkReps.length),
    response_format: { type: 'json_object' },
  }, { timeout: AI_CALL_TIMEOUT_MS, maxRetries: 0 }), AI_CALL_BACKSTOP_MS, 'analyzeBatchHeadlines');

  const content = response.choices[0].message.content;
  if (!content) throw new Error('No response from OpenAI');

  // Tolerant parse: recover the complete result objects even if the reply was
  // truncated/malformed. With chunking this should almost never trigger now.
  const { results: batchResults, salvaged } = parseBatchResultArray(content);
  if (salvaged) {
    console.log(`[FUNNEL:AI] SALVAGED ${batchResults.length}/${chunkReps.length} result(s) from a truncated/malformed reply (would previously have failed the whole batch)`);
  }
  if (!Array.isArray(batchResults) || batchResults.length === 0) {
    // MALFORMED reply (parseable-as-nothing), distinct from a transport error
    // (which throws above and is caught by analyzeBatchHeadlines). Emit a
    // distinct marker + raw snippet so operators can tell a bad AI payload apart
    // from an API/network failure in the logs. Returning null hands control back
    // to the caller, which applies the documented per-chunk fallback (fail-open →
    // unscored placeholders for the scraper, fail-closed → drop the chunk).
    console.error(`[FUNNEL:AI] MALFORMED AI response (nothing parseable) in analyzeBatchHeadlines chunk of ${chunkReps.length} :: ${aiResponseSnippet(content)}`);
    return null;
  }
  return batchResults.map(result => ({
    title: result.title || '',
    is_relevant: result.is_relevant !== undefined ? result.is_relevant : true,
    reason: result.reason || 'Analyzed for strategic importance',
    tags: Array.isArray(result.tags) ? result.tags : [],
    priority_score: resolveAiScore(result.priority_score, 50),
  }));
}

export async function analyzeHeadlineRelevance(title: string): Promise<AnalysisResult> {
  try {
    const systemPrompt = await systemPromptWithContext();
    const response = await withAiTimeout(openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: `Analyze this headline:\n\nTitle: ${title}`,
        },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }, { timeout: AI_CALL_TIMEOUT_MS, maxRetries: 0 }), AI_CALL_BACKSTOP_MS, 'analyzeHeadlineRelevance');

    const content = response.choices[0].message.content;
    if (!content) {
      throw new Error('No response from OpenAI');
    }

    // Parse errors are handled SEPARATELY from API/network errors (which are
    // thrown by the create() call above and caught by the outer catch below). A
    // malformed / wrong-shape reply gets a distinct "Malformed AI response"
    // marker + raw snippet, then falls CLOSED (treat as not relevant) — the same
    // disposition as an API error, so a bad payload can never flood the main
    // feed with un-vetted items. parseAiJson tolerates a fenced/whitespace reply.
    const result = parseAiJson<AnalysisResult>(content);
    if (!result || typeof result.is_relevant !== 'boolean') {
      console.error(`[FUNNEL:AI-MALFORMED] failClosed=true disposition=irrelevant reason=parse/shape :: reply=${aiResponseSnippet(content)} :: "${(title || '').substring(0, 80)}"`);
      return {
        title,
        is_relevant: false,
        reason: 'Malformed AI response',
        tags: [],
        priority_score: 1,
      };
    }

    return {
      title: result.title || title,
      is_relevant: result.is_relevant,
      reason: result.reason || 'No reason provided',
      tags: Array.isArray(result.tags) ? result.tags : [],
      priority_score: resolveAiScore(result.priority_score, 50),
    };
  } catch (error) {
    // API/network error (the create() call threw). Distinct from the malformed
    // parse path above so operators can tell an outage apart from a bad payload.
    console.error('Error analyzing headline with AI (API/network):', error);
    // FAIL-CLOSED on AI error: treat as not relevant so a transient AI failure
    // can never flood the main feed with un-vetted items. Task #444, Step 1: emit
    // a DISTINCT marker so an error-driven "irrelevant" is auditable and is never
    // confused with a genuine gate reject (which carries a real `reason`). Kept
    // fail-CLOSED — the disposition is unchanged, only its visibility improves.
    console.log(`[FUNNEL:AI-ERROR] failClosed=true disposition=irrelevant :: "${(title || '').substring(0, 80)}"`);
    return {
      title,
      is_relevant: false,
      reason: 'Analysis error',
      tags: [],
      priority_score: 1,
    };
  }
}

export async function analyzeBatchHeadlines(
  titles: string[],
  opts: { failOpenUnscored?: boolean } = {},
): Promise<AnalysisResult[]> {
  // failOpenUnscored: when true (scraper only), an AI failure returns one
  // unscored entry per title so the scraper's no-tags path can re-route them to
  // the curated lane instead of silently dropping the whole batch. Default
  // false keeps the original fail-CLOSED contract (return []), so bot fallback
  // scorers and manual/team callers do NOT mistake an AI outage for a real
  // score — critically, this stops unscored bot items from auto-promoting into
  // the main feed at the promotion bar during an AI cooldown burst.
  const { failOpenUnscored = false } = opts;
  if (titles.length === 0) {
    return [];
  }
  
  try {
    // STEP 1: Cluster headlines by topic similarity to ensure diversity
    const clusters = clusterHeadlines(titles, 0.25);
    
    // STEP 2: Send ALL cluster representatives to AI for tagging (no filtering to top 4)
    const representatives = clusters.map(c => c.representative);
    // Split into bounded chunks (Task #673) so a large representative set never
    // exceeds the output cap; each chunk is sized + parsed independently.
    const repChunks = chunkArray(representatives, BATCH_ANALYZER_CHUNK_SIZE);
    console.log(`Clustered into ${clusters.length} topics. Sending ${representatives.length} representatives to AI in ${repChunks.length} chunk(s) for strategic tagging...`);

    // STEP 3: Run each chunk, keeping successful chunks even if a sibling chunk
    // fails — partial recovery instead of losing the whole batch. Per chunk the
    // fail policy matches the single-call path: fail-open routes the chunk's
    // representatives as unscored (scraper only), fail-closed drops them so the
    // caller keeps its unscored default. Fail-open placeholders are collected
    // SEPARATELY so they never perturb declumpScores over the real scores.
    const results: AnalysisResult[] = [];
    const failOpenPlaceholders: AnalysisResult[] = [];
    let failedChunks = 0;
    for (const chunkReps of repChunks) {
      let chunkResults: AnalysisResult[] | null = null;
      let chunkErr: string | null = null;
      try {
        chunkResults = await analyzeRepresentativeChunk(chunkReps);
      } catch (error) {
        chunkErr = error instanceof Error ? error.message : 'unknown error';
      }
      if (chunkResults && chunkResults.length > 0) {
        results.push(...chunkResults);
        continue;
      }
      failedChunks++;
      const reason = chunkErr ? `"${chunkErr}"` : 'non-array-response';
      if (failOpenUnscored) {
        failOpenPlaceholders.push(...chunkReps.map(t => ({ title: t, is_relevant: true, reason: 'AI unavailable', tags: [] as string[], priority_score: 50 })));
        console.log(`[FUNNEL:AI] CHUNK FAILED reps=${chunkReps.length} reason=${reason} fail-open (routed as unscored)`);
      } else {
        console.log(`[FUNNEL:AI] CHUNK FAILED reps=${chunkReps.length} reason=${reason} fail-closed (dropped)`);
      }
    }

    // Every chunk failed → preserve the original total-outage contract exactly:
    // fail-open routes ALL titles as unscored (max recall to the curated lane),
    // fail-closed returns [] so score-reading callers keep their defaults.
    if (results.length === 0) {
      if (failOpenUnscored) {
        console.log(`[FUNNEL:AI] BATCH FAILED titlesIn=${titles.length} representativesSent=${representatives.length} chunks=${repChunks.length} fail-routing=${titles.length} as unscored`);
        return titles.map(t => ({ title: t, is_relevant: true, reason: 'AI unavailable', tags: [], priority_score: 50 }));
      }
      console.log(`[FUNNEL:AI] BATCH FAILED titlesIn=${titles.length} representativesSent=${representatives.length} chunks=${repChunks.length} returning=0 (fail-closed)`);
      return [];
    }
    if (failedChunks > 0) {
      console.log(`[FUNNEL:AI] partial batch: ${failedChunks}/${repChunks.length} chunk(s) failed, ${results.length} result(s) kept${failOpenPlaceholders.length ? `, ${failOpenPlaceholders.length} routed as unscored` : ''}`);
    }

    // In-batch de-clump (Task #444, Step 2). The baseline measured the main
    // `headlines` lane piling 41% of items at exactly 50 and 65% on round numbers;
    // identical scores make the downstream priority cut arbitrary. Spread any tie
    // deterministically downward — pure post-processing, NO extra AI call. A
    // single-item batch (the news bots' path) is a no-op, so only the multi-item
    // batch routes are affected; human/upstream scores are not touched here.
    declumpScores(results);

    console.log(`AI analyzed ${results.length} headlines for strategic tagging`);
    console.log(`[FUNNEL:AI] titlesIn=${titles.length} clusters=${clusters.length} representativesSent=${representatives.length} aiReturned=${results.length} foldedIntoReps=${titles.length - representatives.length}`);
    const relevantCount = results.filter(r => r.is_relevant).length;
    console.log(`${relevantCount} headlines marked as relevant`);
    
    // Show priority distribution
    const critical = results.filter(r => r.priority_score >= 90).length;
    const high = results.filter(r => r.priority_score >= 70 && r.priority_score < 90).length;
    const moderate = results.filter(r => r.priority_score >= 50 && r.priority_score < 70).length;
    const low = results.filter(r => r.priority_score < 50).length;
    console.log(`Priority distribution: ${critical} critical (90+), ${high} high (70-89), ${moderate} moderate (50-69), ${low} low (<50)`);
    
    // DEBUG: Show all high-priority headlines (70-89 scores) to identify mis-scoring
    if (high > 0) {
      const highPriorityHeadlines = results
        .filter(r => r.priority_score >= 70 && r.priority_score < 90)
        .map(r => ({
          title: r.title,
          score: r.priority_score,
          tags: r.tags,
          reason: r.reason
        }));
      console.log('HIGH PRIORITY HEADLINES (70-89):');
      console.log(JSON.stringify(highPriorityHeadlines, null, 2));
    }
    
    // DEBUG: Show all critical headlines (90+) if any
    if (critical > 0) {
      const criticalHeadlines = results
        .filter(r => r.priority_score >= 90)
        .map(r => ({
          title: r.title,
          score: r.priority_score,
          tags: r.tags,
          reason: r.reason
        }));
      console.log('CRITICAL HEADLINES (90+):');
      console.log(JSON.stringify(criticalHeadlines, null, 2));
    }
    
    console.log('Sample tags and priorities:', results.slice(0, 5).map(r => ({ 
      title: r.title.substring(0, 50), 
      tags: r.tags,
      priority: r.priority_score 
    })));
    // Append any fail-open placeholders AFTER declump/logging so a partial-chunk
    // failure still routes those representatives (unscored, tag-less) to the
    // scraper's curated-reroute path instead of silently dropping them. Empty on
    // the common all-chunks-succeeded path, so behavior is unchanged there.
    return failOpenPlaceholders.length > 0 ? [...results, ...failOpenPlaceholders] : results;
    
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'unknown error';
    console.error('Error analyzing headlines with AI:', error);
    if (failOpenUnscored) {
      // Fail-open (scraper only): return an unscored entry per title so the
      // scraper's existing no-tags path can re-route them to the curated lane —
      // never silently discard an entire batch on a timeout or cooldown burst.
      // Items without tags flow to curatedRejects, which applies the curated
      // admission gate and keeps the lane fed even when scoring can't run.
      console.log(`[FUNNEL:AI] BATCH FAILED titlesIn=${titles.length} reason="${errMsg}" fail-routing=${titles.length} as unscored (curated-lane via caller)`);
      return titles.map(t => ({ title: t, is_relevant: true, reason: 'AI unavailable', tags: [], priority_score: 50 }));
    }
    // Fail-closed (default): drop the batch so callers that read priority_score
    // (bot fallback scorers, manual/team) keep their UNSCORED defaults instead of
    // mistaking an outage for a real, promotable score (would auto-promote to
    // the main feed at the bar during an AI cooldown burst).
    console.log(`[FUNNEL:AI] BATCH FAILED titlesIn=${titles.length} reason="${errMsg}" returning=0 (fail-closed, caller keeps unscored default)`);
    return [];
  }
}

// Body-aware single-link priority scoring (interactive review only). Reuses the
// EXACT same rubric/scale as the headline analyzer (ANALYZER_SYSTEM_PROMPT) but
// feeds the article BODY so the score reflects the full story rather than the
// headline alone. Returns null on any failure / thin body so the caller keeps
// the already-streamed headline-based score. This is a standalone helper for the
// Team review dialog — it does NOT touch the main/Classic feed scoring pipeline.
export async function analyzeLinkPriorityWithBody(
  headline: string,
  bodyText: string,
): Promise<{ priority_score: number; tags: string[] } | null> {
  const title = (headline || '').trim();
  const body = (bodyText || '').trim();
  if (!title || body.length < 50) return null;
  try {
    const systemPrompt = await systemPromptWithContext();
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Analyze this single news article and assign its strategic tags AND priority score based on the FULL story (headline + article body), not the headline alone:\n\nHeadline: ${title}\n\nArticle body:\n${body.slice(0, 3000)}`,
        },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    });
    const content = response.choices[0]?.message?.content;
    if (!content) return null;
    // Parse failures are separated from API/network errors (caught below). A
    // malformed reply gets a distinct "Malformed AI response" marker + snippet
    // and returns null, which is FAIL-OPEN here — the caller keeps the already-
    // streamed headline-based score rather than dropping it. parseAiJson
    // tolerates a fenced reply instead of throwing on a stray backtick.
    const parsed = parseAiJson<any>(content);
    if (!parsed) {
      console.error(`[LinkPriority] Malformed AI response (unparseable) — keeping headline score :: ${aiResponseSnippet(content)}`);
      return null;
    }
    const arr = parsed.results || parsed.headlines || parsed.analyses || [];
    const r = Array.isArray(arr) && arr.length > 0 ? arr[0] : parsed;
    const score = typeof r?.priority_score === 'number' ? r.priority_score : null;
    if (score === null) return null;
    return {
      priority_score: Math.min(100, Math.max(1, score)),
      tags: Array.isArray(r?.tags) ? r.tags : [],
    };
  } catch (error) {
    // API/network error (the create() call threw). FAIL-OPEN: return null so the
    // caller keeps the headline-based score. Distinct from the malformed parse
    // path above so an outage is not confused with a bad payload in the logs.
    console.error('Error scoring link priority with body (API/network):', error);
    return null;
  }
}

/**
 * Curated lane (Task #89) — relevance + priority gate for the SEPARATE curated
 * store. Uses the LOOSER CURATED_ANALYZER_SYSTEM_PROMPT (wider aperture) and is
 * NEVER used by the main headlines feed. Unlike analyzeBatchHeadlines it does
 * NOT cluster/dedupe — every supplied title is judged so the curated ingest can
 * keep adversary/opinion/international items the tight brief would drop.
 */
// Deterministic FNV-1a string hash → used only to break ties stably (same title
// always sorts the same way), never for security.
function stableStrHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// In-batch de-clump (Task #248). Even after the relative-scoring prompt, the
// model still tends to pile multiple kept items at the same round number
// (especially 90). Because priority decides which items even enter the curated
// clustering candidate pool, identical scores make that selection arbitrary and
// split related stories into duplicate standalone rows.
//
// REGRESSION GUARD: scripts/score-spread.test.ts (validation step
// `test-score-spread`) locks the spread behavior of this helper and resolveAiScore
// deterministically (no AI key needed). Run it after ANY edit to the scoring
// rubric (server/relevanceDefinition.ts) or these helpers — a change that
// flattens the spread back to one value would make Curated Top Stories candidate
// selection meaningless:
//   npx tsx scripts/score-spread.test.ts
//
// Generic in-batch de-clump over any result carrying a title + priority_score.
// Mutates `results` in place: any group of RELEVANT items that landed on the SAME
// score is spread downward by small deterministic decrements so the batch returns
// a differentiated ranking instead of ties. Only ever LOWERS the lower-ranked
// members of a tie (the top keeps its score), stays inside a bounded window so a
// band is never crossed wholesale, and is fully deterministic (stable title hash).
// No extra AI call — pure post-processing of the existing batch response.
export function declumpScores<T extends { title: string; is_relevant: boolean; priority_score: number }>(
  results: T[],
): void {
  const byScore = new Map<number, T[]>();
  for (const r of results) {
    if (!r.is_relevant) continue;
    const s = r.priority_score;
    const arr = byScore.get(s);
    if (arr) arr.push(r); else byScore.set(s, [r]);
  }
  for (const [score, group] of Array.from(byScore.entries())) {
    if (group.length < 2) continue;
    // Deterministic order: stable hash of the title decides who keeps the top.
    group.sort((a, b) => stableStrHash(a.title) - stableStrHash(b.title));
    // Spread the tie evenly across a bounded window below the shared score,
    // floored at 1, so even a large tie never re-clumps at the floor.
    const window = Math.min(group.length - 1, 12);
    const floor = Math.max(1, score - window);
    for (let i = 0; i < group.length; i++) {
      const offset = Math.round((i * window) / (group.length - 1));
      group[i].priority_score = Math.max(floor, score - offset);
    }
  }
}

// Curated-lane de-clump (Task #248). Thin wrapper over declumpScores; kept as a
// named entry point so the curated call site reads clearly.
function declumpCuratedScores(results: CuratedAnalysisResult[]): void {
  declumpScores(results);
}

// Max titles per analyzer LLM call. The per-item analysis object is large, so a
// single call over a big batch (the RSS pass can hand in 100+ fresh titles) blows
// past the token cap, truncates the reply mid-JSON, and (even with salvage) loses
// the tail of the batch — the LAST feeds in the list silently stop delivering and
// read as "silent sources". Chunking to a modest size keeps every reply well
// inside the cap so no feed is starved by position in the batch.
const CURATED_ANALYZE_CHUNK_SIZE = 25;

// Loose normalizer for matching a model-echoed title back to the input headline.
// Tolerates case / punctuation / whitespace drift in the echo without being so
// loose that two genuinely different headlines collide.
function normalizeAnalyzerTitle(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Bind a batch of model analysis results back to their input titles by a
 * RELIABLE key, never a blind positional guess. Order of preference:
 *   1. The model-echoed 1-based input `index` (the number shown before each
 *      headline in the prompt) when it is a valid in-range integer pointing at a
 *      still-free slot. This survives the model REORDERING, REFORMATTING, or
 *      DE-DUPLICATING echoed titles.
 *   2. An UNAMBIGUOUS normalized-title match — a faithful echo, exactly one input
 *      with that normalized form, slot still free (so near-identical titles in
 *      the same batch are never bound to the wrong one of the set).
 *   3. Otherwise DROP the result. A dropped input stays unclassified and is
 *      retried on the next pass — a transient miss. The OLD positional fallback
 *      instead smeared another story's analysis onto the wrong headline, and
 *      that WRONG label then LOCKED under the generate-once rule (e.g. US market
 *      stories stamped "South Korea / Semiconductor Cluster"). Missing is safe;
 *      wrong is not.
 * Each bound result has its `title` forced to the exact input string so the
 * downstream URL-keyed match can rely on it. Curated-lane only; pure (exported
 * for tests).
 */
export function alignCuratedAnalyses(
  titles: string[],
  items: Array<{ index?: unknown; result: CuratedAnalysisResult }>,
): CuratedAnalysisResult[] {
  const firstIdxByNorm = new Map<string, number>();
  const normCount = new Map<string, number>();
  titles.forEach((t, idx) => {
    const k = normalizeAnalyzerTitle(t);
    if (!k) return;
    if (!firstIdxByNorm.has(k)) firstIdxByNorm.set(k, idx);
    normCount.set(k, (normCount.get(k) ?? 0) + 1);
  });

  const toInt = (v: unknown): number => {
    if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
    if (typeof v === 'string' && v.trim()) return parseInt(v.trim(), 10);
    return NaN;
  };

  const aligned: (CuratedAnalysisResult | undefined)[] = new Array(titles.length);
  for (const { index, result } of items) {
    // Candidate from the model-echoed 1-based index (valid, in-range, free slot).
    const n = toInt(index);
    const byIndex =
      Number.isInteger(n) && n >= 1 && n <= titles.length && !aligned[n - 1]
        ? n - 1
        : -1;
    // Candidate from an UNAMBIGUOUS normalized-title match (faithful echo, exactly
    // one input with that norm key, free slot).
    const k = normalizeAnalyzerTitle(result.title);
    const titleCand = k ? firstIdxByNorm.get(k) : undefined;
    const byTitle =
      titleCand !== undefined && normCount.get(k) === 1 && !aligned[titleCand]
        ? titleCand
        : -1;

    let idx: number;
    if (byIndex >= 0 && byTitle >= 0 && byIndex !== byTitle) {
      // CONFLICT: the echoed index and a faithful title echo point at DIFFERENT
      // inputs (the model renumbered / reused an index). Trust neither → DROP.
      idx = -1;
    } else if (byIndex >= 0) {
      // Index wins — it survives the model reformatting the echoed title (so the
      // title match is absent) and here it does not contradict a faithful echo.
      idx = byIndex;
    } else {
      idx = byTitle; // -1 when neither resolves → drop
    }
    // Unbindable → drop (retried next pass); never positionally guess.
    if (idx < 0) continue;
    // Clone-on-bind: never mutate the caller's object; force the exact input title
    // so the downstream URL-keyed match can rely on it.
    aligned[idx] = { ...result, title: titles[idx] };
  }
  return aligned.filter((r): r is CuratedAnalysisResult => !!r);
}

/**
 * Analyze a SINGLE chunk (≤ CURATED_ANALYZE_CHUNK_SIZE) of curated candidate
 * titles. Returns one result per INPUT title that the model scored, in input
 * order, with the `title` field FORCED back to the exact input string so callers
 * can match results to candidates reliably.
 *
 * Matching contract: the model echoes a 1-based `index` (the number shown before
 * each headline) plus the verbatim title; binding is delegated to
 * alignCuratedAnalyses (index first, then an unambiguous title match, else DROP —
 * never a positional guess). See that function for the full rationale.
 */
// Curated gate AI call hard time-bound. The curated ingest pass awaits this
// gate; a provider that accepts the request then stalls would otherwise hang the
// await forever and wedge the pass. Two layers bound it: (1) a per-request SDK
// timeout on the OpenRouter path ABORTS the HTTP request at the source (true
// cancellation), and (2) a Promise.race backstop releases the await even on the
// Anthropic fallback path (which ignores per-request options and can't be
// cancelled here). Both are generous so they only trip on a genuine hang, never
// a slow-but-progressing reply. Curated-lane only.
//
// Task #1083 (backlog conversion speed): tightened 60s/75s → 45s/55s. A normal
// 25-item gpt-4o-mini chunk completes well under 45s, so the bound still only
// trips on genuine hangs — but a smaller worst-case in-flight overshoot lets
// curatedIngest shrink its GATE_INSERT_RESERVE_MS in lockstep, widening the
// per-pass analysis window. The backstop is exported so the reserve stays
// mechanically coupled to the real overshoot ceiling instead of drifting.
const CURATED_GATE_AI_TIMEOUT_MS = 45_000;
export const CURATED_GATE_AI_BACKSTOP_MS = 55_000;

// withAiTimeout now lives in ./aiTimeout so the same proven hang-protection is
// shared by the main-feed AI calls (imported at the top of this file).

async function analyzeCuratedChunk(titles: string[]): Promise<CuratedAnalysisResult[]> {
  if (titles.length === 0) return [];
  try {
    const response = await withAiTimeout(
      openai.chat.completions.create({
      model: 'gpt-4o-mini-pinned',
      messages: [
        { role: 'system', content: CURATED_ANALYZER_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Analyze ALL ${titles.length} headlines for the WIDE-APERTURE curated feed. Mark is_relevant=true generously for anything with a national-security / geopolitical / defense / foreign-affairs angle (including adversary framing), false only for pure noise.\n\nSCORE THESE ${titles.length} ITEMS RELATIVE TO EACH OTHER: rank them against one another and SPREAD the priority_score values across the full range so the set has a clear ordering (a handful high, more in the middle, the rest low). Avoid giving many items the same score — especially do not pile multiple items at 90 or other round numbers. If two items aren't truly equal, give them different scores.\n\n${titles.map((t, i) => `${i + 1}. ${t}`).join('\n')}`,
        },
      ],
      temperature: 0.3,
      // Cap generously: the per-item analysis object is large and a chunk can be
      // up to CURATED_ANALYZE_CHUNK_SIZE, so the default (especially the Anthropic
      // fallback's 4096) truncates the reply mid-JSON, leaving an unterminated
      // json fence that fails to parse and drops the WHOLE chunk — items then
      // never get a primary_topic and the Topic chip renders "—". 6000 fits a
      // full 25-item chunk.
      max_tokens: 6000,
      response_format: { type: 'json_object' },
      },
      // Source-level cancellation on the OpenRouter path: abort the HTTP request
      // if the provider stalls. maxRetries:0 so an SDK timeout isn't multiplied
      // by SDK-internal retries (the shared aiClient already handles transient
      // retry/backoff at a higher level).
      { timeout: CURATED_GATE_AI_TIMEOUT_MS, maxRetries: 0 },
      ),
      CURATED_GATE_AI_BACKSTOP_MS,
      'analyzeCuratedChunk',
      // Curated lane MUST stay isolated from the main-feed storm fast-skip: a
      // main-feed AI 429 storm must never cause curated calls to be skipped, and
      // curated failures must never count toward the main-feed cooldown.
      { trackStorm: false },
    );

    const content = response.choices[0].message.content;
    if (!content) {
      // Empty reply is a malformed payload, not an API/network error — log it
      // inline with the distinct marker (consistent with the translate/synthesis
      // sites). Fail-safe: return [] so these titles stay unclassified and retry
      // on the next pass; nothing is dropped from the curated store.
      console.error('[CuratedAnalyzer] MALFORMED AI response (empty content) — titles stay unclassified, retry next pass');
      return [];
    }
    // Tolerate a fenced reply (also sanitized centrally in aiClient). If the
    // reply was STILL truncated at the cap, salvage the COMPLETE result objects
    // that came back so those items are classified now; the remainder stay
    // unclassified and are picked up on the next pass, instead of losing the
    // entire chunk to a single unparseable character.
    let batchResults: any[];
    const parsed = parseAiJson<{ results?: any[]; headlines?: any[]; analyses?: any[] }>(content);
    if (parsed) {
      batchResults = parsed.results || parsed.headlines || parsed.analyses || [];
      if (!Array.isArray(batchResults)) {
        // Parseable JSON but WRONG SHAPE (no results/headlines/analyses array).
        // Distinct malformed-payload marker + bounded snippet so a bad AI shape is
        // told apart from an API/network failure (thrown by create() above and
        // caught below). Fail-safe: return [] so these titles stay unclassified and
        // retry on the next pass — nothing is dropped from the curated store.
        console.error(`[CuratedAnalyzer] MALFORMED AI response (wrong shape, no results array) :: ${aiResponseSnippet(content)}`);
        return [];
      }
    } else {
      batchResults = salvageJsonObjectArray(content);
      if (batchResults.length === 0) {
        // Nothing parseable even after salvage — distinct malformed-payload marker
        // + bounded snippet (vs. an API/network error, thrown and caught below).
        // Fail-safe: return [] so these titles stay unclassified and retry on the
        // next pass; the curated store keeps them, nothing is silently dropped.
        console.error(`[CuratedAnalyzer] MALFORMED AI response (nothing salvageable) :: ${aiResponseSnippet(content)}`);
        return [];
      }
      console.warn(
        `[CuratedAnalyzer] Recovered ${batchResults.length} result(s) from a truncated reply`,
      );
    }
    const mapped: Array<{ index?: unknown; result: CuratedAnalysisResult }> = batchResults.map((result: any) => {
      const title = result.title || '';
      const category = typeof result.category === 'string' && result.category.trim()
        ? result.category.trim() : 'general';
      const region = typeof result.region === 'string' && result.region.trim()
        ? result.region.trim() : null;
      const country = typeof result.country === 'string' && result.country.trim()
        ? result.country.trim() : null;
      // ---- Task #336: enforce the controlled vocabulary in code ----
      // Coerce the model's primary_topic to a canonical enum value; an off-list
      // value falls back to the catch-all and surfaces a proposal.
      const coercedTopic = coercePrimaryTopic(result.primary_topic);
      const rawProposed = typeof result.proposed_topic === 'string' && result.proposed_topic.trim()
        ? result.proposed_topic.trim() : null;
      let primaryTopic: PrimaryTopic;
      let proposedTopic: string | null;
      if (coercedTopic) {
        primaryTopic = coercedTopic;
        proposedTopic = primaryTopic === OTHER_EMERGING ? rawProposed : null;
      } else {
        // Off-list / missing → catch-all; remember what the model wanted to add.
        primaryTopic = OTHER_EMERGING;
        proposedTopic = rawProposed
          ?? (typeof result.primary_topic === 'string' && result.primary_topic.trim()
            ? result.primary_topic.trim() : null);
      }
      // ---- Task #408: deterministic persist-time backstop ----
      // When the model lands on the catch-all but the free-form `category`
      // deterministically maps to a REAL bucket via the shared narrow-label
      // remap (e.g. "Natural Disaster" / "Public Health" / "Wildfire" ->
      // "Public Health, Disaster & Environmental Security"), upgrade the topic
      // here — BEFORE the row is stored — so the correction beats the
      // generate-once lock. Reuses the SAME remap as the historical pass; no
      // parallel mapping. Clear the now-irrelevant proposal. Curated-lane only.
      if (primaryTopic === OTHER_EMERGING) {
        const remapped = remapLegacyCategory(category, title);
        if (remapped.matched && remapped.primaryTopic !== OTHER_EMERGING) {
          primaryTopic = remapped.primaryTopic;
          proposedTopic = null;
        }
      }
      // conflict_track: coerce to the governed list; if absent, infer from the
      // title/category (high-precision keyword inference, never off-list).
      const conflictTrack = coerceConflictTrack(result.conflict_track)
        ?? inferConflictTrack(title, category);
      const scope = coerceScope(result.scope);
      // country_pair: two FULL country names for a bilateral story (Topic·Focus
      // model). Shape-validated only (any country allowed); else null → the focus
      // falls back to the conflict-track pair / single country / region / Global.
      const countryPair = coerceCountryPair(result.country_pair);
      const analysis: CuratedAnalysisResult = {
        title,
        is_relevant: result.is_relevant !== undefined ? result.is_relevant : true,
        reason: result.reason || 'Curated relevance assessment',
        tags: Array.isArray(result.tags) ? result.tags : [],
        priority_score: resolveAiScore(result.priority_score, 50),
        category,
        region,
        country,
        primaryTopic,
        scope,
        conflictTrack,
        countryPair,
        proposedTopic,
      };
      // Carry the model-echoed 1-based input index (when present) so the result
      // can be bound back to its input by a RELIABLE key, not a positional guess.
      return { index: (result as any)?.index, result: analysis };
    });

    // Bind each model result to its input by the echoed index, else an
    // unambiguous title match; DROP anything unbindable (it retries next pass).
    // Never positionally guess — that smeared one story's analysis onto another
    // headline and LOCKED the wrong label under the generate-once rule.
    const results = alignCuratedAnalyses(titles, mapped);

    // Spread any ties the model still returned (esp. clumps at 90) so priority
    // is differentiated before it feeds clustering candidate selection.
    declumpCuratedScores(results);
    const kept = results.filter(r => r.is_relevant).length;
    console.log(`[CuratedAnalyzer] Analyzed ${results.length}/${titles.length} curated candidates, ${kept} kept`);
    return results;
  } catch (error) {
    // API/network/timeout failure (thrown by the create() call above), distinct
    // from the inline malformed-payload markers. Fail-safe: return [] so these
    // titles stay unclassified and retry on the next pass — nothing is dropped.
    console.error('[CuratedAnalyzer] API/network error analyzing curated chunk (fail-safe, retry next pass):', error);
    return [];
  }
}

/**
 * Translate non-English curated headlines to English (Task #656).
 *
 * Used by the curated ingest gate for the handful of sources flagged in
 * CURATED_TITLE_TRANSLATE_SOURCES (e.g. Prensa Latina's Spanish `.cu` feed).
 * Returns a Map keyed by the EXACT original title → its English translation.
 *
 * Fail-safe by design: any error, timeout, refusal, or unparseable reply
 * returns whatever was parsed so far (often an empty Map). The caller keeps the
 * original title for anything missing, so a translation failure only degrades to
 * the raw source-language headline — it never drops the item. Curated-lane only;
 * pinned to gpt-4o-mini (proven on this content, unlike gpt-5 which refuses
 * conflict material) and kept out of the main-feed AI storm accounting.
 *
 * Binding is anti-smear: a translation is applied ONLY when the result's echoed
 * `original` matches an input exactly (whitespace-normalized). A provided-but-
 * non-matching original is dropped (keeps the source-language title), never
 * index-guessed — a garbled echo plus a drifted index is precisely how a
 * translation smears onto the wrong headline. The echoed 1-based index is used
 * as a fallback ONLY when the model omitted the original echo entirely.
 */
export async function translateCuratedTitlesToEnglish(
  titles: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const clean = Array.from(
    new Set(titles.filter((t) => typeof t === 'string' && t.trim().length > 0)),
  );
  if (clean.length === 0) return out;
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ');
  const byNorm = new Map<string, string>(); // normalized original -> exact original
  for (const t of clean) byNorm.set(norm(t), t);
  try {
    const response = await withAiTimeout(
      openai.chat.completions.create(
        {
          model: 'gpt-4o-mini-pinned',
          messages: [
            {
              role: 'system',
              content:
                'You are a professional news headline translator. Translate each numbered headline into concise, natural English. If a headline is already in English, return it verbatim. Preserve proper nouns, names, places and factual meaning exactly; do NOT summarize, editorialize, add commentary, or omit any headline. This is neutral translation of news headlines.',
            },
            {
              role: 'user',
              content:
                `Translate ALL ${clean.length} news headlines below to English.\n\n` +
                `Return ONLY valid JSON, no markdown, of the form:\n` +
                `{"results":[{"index":<the 1-based number shown before the headline, copied EXACTLY>,"original":"<echo the input headline VERBATIM>","english_title":"<the English translation, or the verbatim headline if already English>"}]}\n` +
                `Return one object per input, never null, in the same order.\n\n` +
                clean.map((t, i) => `${i + 1}. ${t}`).join('\n'),
            },
          ],
          temperature: 0.2,
          max_tokens: 3000,
          response_format: { type: 'json_object' },
        },
        { timeout: CURATED_GATE_AI_TIMEOUT_MS, maxRetries: 0 },
      ),
      CURATED_GATE_AI_BACKSTOP_MS,
      'translateCuratedTitlesToEnglish',
      // Curated lane MUST stay isolated from the main-feed storm fast-skip.
      { trackStorm: false },
    );
    const content = response.choices[0]?.message?.content;
    if (!content) {
      console.warn('[CuratedTitleTranslate] MALFORMED AI response (empty content) — keeping original titles');
      return out;
    }
    const parsed = parseAiJson<{ results?: any[] }>(content);
    const arr: any[] = Array.isArray(parsed?.results)
      ? parsed!.results!
      : salvageJsonObjectArray(content);
    if (arr.length === 0) {
      // Parseable-as-nothing: distinct malformed-payload marker + bounded snippet,
      // separate from an API/network failure (thrown by create() above and caught
      // below). Fail-safe: return the (partial/empty) map so the caller keeps every
      // original title — a translation miss only degrades to the source-language
      // headline, it never drops the item.
      console.warn(`[CuratedTitleTranslate] MALFORMED AI response (nothing parseable) — keeping original titles :: ${aiResponseSnippet(content)}`);
      return out;
    }
    for (const r of arr) {
      const en =
        typeof r?.english_title === 'string' ? r.english_title.trim() : '';
      if (en.length < 2) continue;
      // Anti-smear binding. Primary key: exact (normalized) echo of the original
      // headline. A provided `original` that does NOT match any input is treated
      // as an untrustworthy row and DROPPED — we never fall back to the index in
      // that case, because a garbled echo alongside a drifted index is exactly
      // how a translation gets smeared onto the wrong headline. The echoed index
      // is used ONLY when the model omitted the original echo entirely.
      let original: string | undefined;
      const echoedOriginal =
        typeof r?.original === 'string' ? r.original.trim() : '';
      if (echoedOriginal.length > 0) {
        original = byNorm.get(norm(echoedOriginal)); // undefined → drop this row
      } else {
        const idx = Number(r?.index);
        if (Number.isInteger(idx) && idx >= 1 && idx <= clean.length) {
          original = clean[idx - 1];
        }
      }
      if (original && !out.has(original)) out.set(original, en);
    }
  } catch (error) {
    // API/network/timeout failure (thrown by the create() call above), distinct
    // from the inline malformed-payload markers. Fail-safe: return whatever was
    // parsed so far so the caller keeps the original title for anything missing.
    console.error(
      '[CuratedTitleTranslate] API/network error during translation (non-fatal, keeping original titles):',
      (error as Error).message,
    );
  }
  return out;
}

export async function analyzeCuratedBatch(titles: string[]): Promise<CuratedAnalysisResult[]> {
  if (titles.length === 0) return [];
  // Chunk so a large pass never truncates the reply and starves the tail feeds.
  // Each chunk's results carry the exact input title and are index-aligned, so
  // concatenating them preserves overall input order.
  if (titles.length <= CURATED_ANALYZE_CHUNK_SIZE) {
    return analyzeCuratedChunk(titles);
  }
  const all: CuratedAnalysisResult[] = [];
  for (let i = 0; i < titles.length; i += CURATED_ANALYZE_CHUNK_SIZE) {
    const chunk = titles.slice(i, i + CURATED_ANALYZE_CHUNK_SIZE);
    const chunkResults = await analyzeCuratedChunk(chunk);
    all.push(...chunkResults);
  }
  // Each provider chunk is de-clumped independently. Re-run once over the
  // aggregate so repeated chunk-local ladders (the production P66/P62/P58
  // plateaus) are differentiated across the whole intake pass too.
  declumpCuratedScores(all);
  console.log(`[CuratedAnalyzer] Batch complete: ${all.length}/${titles.length} across ${Math.ceil(titles.length / CURATED_ANALYZE_CHUNK_SIZE)} chunk(s)`);
  return all;
}

// Gate-mode chunking bounds (Task #383). The per-item curated analysis object is
// large, so a single analyzeCuratedBatch call is capped around 25 titles before
// the reply risks truncation (see max_tokens note above). When the curated
// ingest gate receives a bigger backlog (e.g. a 60-candidate website-scraper
// run, or many feeds at once), sending it all in ONE call either truncates or
// blocks the whole pipeline on a single serial round-trip. This splits the
// titles into <=CURATED_GATE_CHUNK_SIZE chunks and runs them with bounded
// concurrency so the backlog is metered out instead of stalling.
export const CURATED_GATE_CHUNK_SIZE = 25;
// Keep concurrency small: each chunk's provider call is ALSO metered by the
// shared aiClient (global concurrency limiter + adaptive spacing + circuit
// breaker), so this is a second, conservative bound that lets a few chunks
// overlap without firing a whole backlog at the provider at once.
export const CURATED_GATE_CONCURRENCY = 3;

// Test-only injection seam (Task #733). ESM module bindings are read-only from
// the outside, so tests that need the gate to BLOCK (to prove the ingest hard
// timeout abandons an in-flight AI call) can't stub analyzeCuratedBatch via
// import mutation. This mutable indirection is the sanctioned seam: production
// never calls the setter, so the default path is byte-identical.
let curatedGateAnalyzeImpl: (t: string[]) => Promise<CuratedAnalysisResult[]> = analyzeCuratedBatch;
export function __setCuratedGateAnalyzeForTest(
  fn: ((t: string[]) => Promise<CuratedAnalysisResult[]>) | null,
): void {
  curatedGateAnalyzeImpl = fn ?? analyzeCuratedBatch;
}

// Race a promise against an AbortSignal so a HARD abort (ingest wedge-backstop
// timeout) releases the caller's await immediately with an AbortError instead
// of waiting for a stalled provider call to settle. The underlying request is
// intentionally abandoned (it may still settle in the background — the shared
// aiClient's limiter/breaker meters it); a no-op catch prevents an unhandled
// rejection if the abandoned promise later rejects.
function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    const err = new Error('Curated gate analysis cancelled (signal already aborted)');
    err.name = 'AbortError';
    return Promise.reject(err);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => {});
      const err = new Error('Curated gate analysis cancelled (abort while in flight)');
      err.name = 'AbortError';
      reject(err);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/**
 * Curated gate analysis for an arbitrarily large title list (Task #383).
 *
 * Splits `titles` into bounded chunks and runs analyzeCuratedBatch on them with
 * a small worker pool so a backlog of incoming candidates doesn't block the
 * ingest pipeline on one giant serial call (which would also truncate). Each
 * chunk still flows through the shared rate-limited AI client, so a surge backs
 * off via the client's limiter / breaker rather than exhausting budget.
 *
 * Behavior for a single <=chunk-size batch is unchanged (one call, same result).
 * `_analyze` is an injection seam for tests only; production uses the real path.
 */
export async function analyzeCuratedBatchChunked(
  titles: string[],
  opts?: {
    chunkSize?: number;
    concurrency?: number;
    _analyze?: (t: string[]) => Promise<CuratedAnalysisResult[]>;
    // When provided, each chunk worker checks the signal before dequeuing the
    // next chunk so the gate stops issuing new AI calls as soon as the outer
    // ingest timeout aborts the controller. In-flight chunk calls still settle
    // (the underlying HTTP request is already in-flight); only future chunks are
    // skipped. Curated-lane only — callers outside the ingest path do not pass
    // a signal.
    signal?: AbortSignal;
    // Soft per-pass deadline (epoch ms). Like `signal` but graceful: once the
    // ingest pass is past its soft budget, workers stop dequeuing NEW chunks and
    // the merged result is whatever completed so far. The caller's insert loop
    // also breaks on the same deadline, so any un-analyzed titles are simply
    // deferred to the next 5-min cron tick (URL-dedup makes that idempotent).
    // Without this, a large fresh batch could grind the full gate cost past the
    // soft deadline before the insert loop's first check. Curated-lane only.
    deadlineMs?: number;
  },
): Promise<CuratedAnalysisResult[]> {
  const clean = titles.filter((t) => typeof t === 'string' && t.trim().length > 0);
  if (clean.length === 0) return [];

  const chunkSize = Math.max(1, opts?.chunkSize ?? CURATED_GATE_CHUNK_SIZE);
  const concurrency = Math.max(1, opts?.concurrency ?? CURATED_GATE_CONCURRENCY);
  const analyze = opts?._analyze ?? curatedGateAnalyzeImpl;
  const signal = opts?.signal;
  const deadlineMs = opts?.deadlineMs;
  // Graceful soft-deadline check (mirrors isPastDeadline in curatedIngest.ts;
  // inlined to avoid an aiAnalyzer→curatedIngest import cycle).
  const pastDeadline = () => deadlineMs !== undefined && Date.now() >= deadlineMs;

  // Fast path: a single chunk is byte-identical to the old single-call
  // behavior — except that a HARD abort (ingest wedge-backstop timeout) now
  // releases the in-flight await with an AbortError (Task #733) instead of the
  // pass hanging on a stalled provider call until the outer Promise.race gives
  // up. Soft deadline stays graceful and is NOT raced here.
  if (clean.length <= chunkSize) return raceWithAbort(analyze(clean), signal);

  const chunks: string[][] = [];
  for (let i = 0; i < clean.length; i += chunkSize) {
    chunks.push(clean.slice(i, i + chunkSize));
  }

  // Bounded worker pool: results are written back into a per-chunk slot so the
  // merged order matches the input order (deterministic), and one chunk failing
  // never drops the others (analyzeCuratedBatch already fail-soft returns []).
  const out: CuratedAnalysisResult[][] = new Array(chunks.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      // Stop dequeuing new chunks if the ingest-pass timeout has fired (hard),
      // or the soft per-pass deadline has passed (graceful). Either way, any
      // chunk already in-flight continues to settle on its own — we just don't
      // start new ones so the shared AI client isn't hammered further.
      if (signal?.aborted || pastDeadline()) return;
      const idx = next++;
      if (idx >= chunks.length) return;
      try {
        // Race the in-flight chunk call against the HARD abort signal (Task
        // #733): when the ingest wedge-backstop timeout fires mid-call, the
        // await releases immediately with an AbortError (rethrown below so the
        // whole gate settles via the AbortError path) instead of the pass
        // waiting on a stalled provider call.
        out[idx] = await raceWithAbort(analyze(chunks[idx]), signal);
      } catch (error) {
        if ((error as Error).name === 'AbortError') throw error;
        console.error(`[CuratedAnalyzer] Chunk ${idx + 1}/${chunks.length} failed:`, (error as Error).message);
        out[idx] = [];
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, chunks.length) }, worker),
  );

  const merged = out.flatMap((r) => r ?? []);
  // The worker pool returns independently de-clumped chunks. De-clump the merged
  // machine-scored result once more so equal values from different chunks do not
  // re-form large score bands. This only lowers relevant analyzer scores; human
  // and upstream scores never flow through this function.
  declumpCuratedScores(merged);
  console.log(
    `[CuratedAnalyzer] Chunked gate analysis: ${clean.length} titles in ${chunks.length} chunk(s) ` +
      `(concurrency ${concurrency}) → ${merged.length} result(s)`,
  );
  return merged;
}

/**
 * Score a list of headline titles for priority in ONE LLM call, using the same
 * canonical SYSTEM_PROMPT / model / temperature as the per-title path.
 *
 * This exists so the news bots can stop calling analyzeBatchHeadlines([title])
 * once per article (one network round-trip per post) and instead score a whole
 * relevant batch at once. Unlike analyzeBatchHeadlines this does NOT cluster the
 * inputs, so every title gets its own score back (clustering would collapse
 * similar titles and drop scores for the non-representatives).
 *
 * Returns a Map keyed by the original title. Any title the model fails to return
 * is omitted; callers should fall back to their own default (50).
 */
// Score ONE chunk of titles and write results into the shared `scores` map.
// The positional-index fallback is relative to THIS chunk (chunk[idx]), never
// the full input — mixing the two would smear one chunk's scores onto another's
// titles. Returns whether the reply had to be salvaged (for observability).
// Throws only on transport/timeout errors, caught by the caller.
async function scoreHeadlineChunk(chunk: string[], scores: Map<string, number>): Promise<boolean> {
  const systemPrompt = await systemPromptWithContext();
  const response = await withAiTimeout(openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Analyze ALL ${chunk.length} headlines and assign appropriate strategic tags to each. Mark is_relevant=true for military/strategic topics, false for non-military topics:\n\n${chunk.map((title, idx) => `${idx + 1}. ${title}`).join('\n')}`,
      },
    ],
    temperature: 0.3,
    max_tokens: batchAnalyzerMaxTokens(chunk.length),
    response_format: { type: 'json_object' },
  }, { timeout: AI_CALL_TIMEOUT_MS, maxRetries: 0 }), AI_CALL_BACKSTOP_MS, 'scoreHeadlinePrioritiesBatch');

  const content = response.choices[0].message.content;
  if (!content) return false;

  // Tolerant parse (see analyzeBatchHeadlines): recover the complete objects
  // from a reply truncated at the token cap so a partial chunk still scores the
  // items that came back. The positional-index fallback stays valid because
  // salvage returns an in-order prefix.
  const { results: batchResults, salvaged } = parseBatchResultArray(content);
  if (salvaged) {
    console.log(`[FUNNEL:SCORE] SALVAGED ${batchResults.length}/${chunk.length} score(s) from a truncated/malformed reply`);
  }
  if (!Array.isArray(batchResults) || batchResults.length === 0) {
    if (!salvaged) {
      // MALFORMED reply (nothing parseable), distinct from a transport error
      // (which throws above and is caught by scoreHeadlinePrioritiesBatch). No
      // scores are written for this chunk, so the shared `scores` map simply
      // omits these titles and each caller keeps its own default (fail-open at
      // the caller — a MISSING score is not a zero). Snippet aids telling a bad
      // AI payload apart from an API/network failure in the logs.
      console.error(`[FUNNEL:SCORE] MALFORMED AI response (nothing parseable) in scoreHeadlinePrioritiesBatch chunk of ${chunk.length} :: ${aiResponseSnippet(content)}`);
    }
    return salvaged;
  }

  // Map results back to THIS chunk's titles: prefer an exact title match, fall
  // back to positional index (relative to the chunk) when the model echoes a
  // reworded title.
  const remaining = new Set(chunk);
  batchResults.forEach((r: any, idx: number) => {
    const score = typeof r?.priority_score === 'number' ? r.priority_score : null;
    if (score === null) return;
    if (typeof r?.title === 'string' && remaining.has(r.title)) {
      scores.set(r.title, score);
      remaining.delete(r.title);
    } else if (idx < chunk.length && remaining.has(chunk[idx])) {
      scores.set(chunk[idx], score);
      remaining.delete(chunk[idx]);
    }
  });
  return salvaged;
}

export async function scoreHeadlinePrioritiesBatch(titles: string[]): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  const cleaned = titles.filter(t => typeof t === 'string' && t.trim().length > 0);
  if (cleaned.length === 0) {
    return scores;
  }

  // Split into bounded chunks (Task #673) so a large batch never exceeds the
  // output cap. A batch ≤ chunk size is a single chunk = identical to the old
  // single-call path. Sequential; one chunk failing never drops the others.
  const chunks = chunkArray(cleaned, BATCH_ANALYZER_CHUNK_SIZE);
  for (const chunk of chunks) {
    try {
      await scoreHeadlineChunk(chunk, scores);
    } catch (error) {
      console.error('Error scoring headline priorities in batch (chunk skipped):', error);
      // Continue with remaining chunks; unscored titles fall back to the
      // caller's default (50), never mistaken for a real score.
    }
  }

  // [FUNNEL:SCORE] live P-score distribution for the news-bot / RSS-bot path
  // (this is the score that drives the main-feed promotion gate). Observability
  // only — no behavior change. The pass/fail counts track the live
  // MAIN_FEED_PROMOTION_THRESHOLD so this log stays meaningful after the bar
  // is tuned (Task #522).
  if (scores.size > 0) {
    const bar = MAIN_FEED_PROMOTION_THRESHOLD;
    const vals = Array.from(scores.values());
    const geBar = vals.filter(v => v >= bar).length;
    const byTens = new Array(11).fill(0);
    for (const v of vals) byTens[Math.max(0, Math.min(10, Math.floor(v / 10)))]++;
    console.log(`[FUNNEL:SCORE] scored=${scores.size}/${cleaned.length} chunks=${chunks.length} ge${bar}(toMain)=${geBar} lt${bar}(chatOnly)=${scores.size - geBar} byTens=[${byTens.join(',')}]`);
  }

  return scores;
}

// Interface for link analysis results
export interface LinkAnalysisResult {
  headline: string;
  summary: string;
  subject: string;
  sourceType: 'news' | 'social_media' | 'other';
  sourceName: string;
  publishedAt: Date | null;
  ogImageUrl: string | null;
  headlineGenerated: boolean;
  headlineSource: 'scraped' | 'pasted' | 'generated';
}

const HEADLINE_MAX_LEN = 120;

// Strip trailing site-name suffixes from a scraped page title
// e.g. "Swedish jets intercept Russian aircraft – POLITICO" -> "Swedish jets intercept Russian aircraft"
function cleanScrapedHeadline(raw: string): string {
  let h = (raw || '').replace(/\s+/g, ' ').trim();
  if (!h) return '';
  const sepMatch = h.match(/^(.*\S)\s+[|–—\-·»:]\s+(.+)$/);
  if (sepMatch) {
    const head = sepMatch[1].trim();
    const tail = sepMatch[2].trim();
    // Only strip when the head is substantial and the tail looks like a site name (short, few words)
    if (head.length >= 20 && tail.length <= 40 && tail.split(/\s+/).length <= 6) {
      h = head;
    }
  }
  return h;
}

// Extract the first non-empty, non-URL line of the user's submitted message
function extractPastedHeadline(userMessage: string): string {
  if (!userMessage) return '';
  const urlOnly = /^https?:\/\/\S+$/i;
  for (const rawLine of userMessage.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (urlOnly.test(line)) continue;
    // Strip a leading/trailing bare URL token if the line is otherwise prose
    const withoutUrls = line.replace(/https?:\/\/\S+/gi, '').trim();
    if (withoutUrls) return withoutUrls;
  }
  return '';
}

// Shorten an over-long real headline while preserving wording and meaning (no invention)
async function shortenHeadlineWithAI(headline: string): Promise<string> {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You shorten news headlines. Preserve the original wording and meaning as closely as possible, only trimming non-essential words so the result fits the length limit. Do NOT invent new phrasing or add information. Return only the shortened headline, no quotes.'
        },
        { role: 'user', content: `Shorten this headline to at most ${HEADLINE_MAX_LEN} characters, preserving its meaning:\n\n${headline}` }
      ],
      temperature: 0.2,
      max_tokens: 80,
    });
    const out = (response.choices[0]?.message?.content || '').replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim();
    if (out) return out.length > HEADLINE_MAX_LEN ? out.substring(0, HEADLINE_MAX_LEN).trim() : out;
  } catch (err) {
    console.error('[Headline] Failed to shorten headline with AI:', err);
  }
  // Fallback: hard truncate at a word boundary
  const truncated = headline.substring(0, HEADLINE_MAX_LEN);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 40 ? truncated.substring(0, lastSpace) : truncated).trim();
}

// Analyze a submitted link and extract headline, summary, and subject
export async function analyzeSubmittedLink(
  url: string,
  userMessage: string,
  existingSubjects: string[] = [],
  prefetched?: { html: string | null; ok: boolean; status: number },
  opts?: { throwOnTransient?: boolean; deadlineMs?: number }
): Promise<LinkAnalysisResult | null> {
  try {
    // Fetch content from the URL
    let pageContent = '';
    let extractedPublishDate: Date | null = null;
    let extractedOgImageUrl: string | null = null;
    let scrapedHeadline = '';
    try {
      const cheerio = await import('cheerio');
      // Reuse a single page fetch when provided (review flow). Otherwise fetch
      // inline as before. A non-ok prefetch behaves like a failed fetch: no
      // page content is extracted, and the paywall-bypass fallback below runs.
      let html: string | null = null;
      if (prefetched !== undefined) {
        html = prefetched.ok ? prefetched.html : null;
      } else {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          signal: AbortSignal.timeout(10000)
        });
        if (response.ok) {
          html = await response.text();
        }
      }

      if (html) {
        const $ = cheerio.load(html);

        // Extract publication date via the shared, priority-correct extractor
        // (Task #653): only trustworthy "original publish" signals (JSON-LD
        // datePublished, article:published_time, itemprop=datePublished, etc.)
        // are used here. Generic/ambiguous tags (meta[name="date"],
        // meta[name="pubdate"], bare time[datetime]) are deliberately never
        // used — outlets like Reuters are known to overwrite those with the
        // last-UPDATED time, which previously made stale stories look freshly
        // published. When no trustworthy signal exists, extractedPublishDate
        // stays null and the caller/UI honestly falls back to "First seen".
        try {
          const { parseTimestampsFromHtml } = await import('./timestampExtractor');
          extractedPublishDate = parseTimestampsFromHtml($).publishedAt;
        } catch {
          extractedPublishDate = null;
        }

        // Remove scripts and styles
        $('script, style, nav, footer, header, aside').remove();
        
        // Get title
        const title = $('title').text().trim() || 
                     $('h1').first().text().trim() || 
                     $('meta[property="og:title"]').attr('content') || '';
        scrapedHeadline = title;
        
        // Get description
        const description = $('meta[name="description"]').attr('content') || 
                           $('meta[property="og:description"]').attr('content') || '';
        
        extractedOgImageUrl = $('meta[property="og:image"]').attr('content') ||
                              $('meta[name="twitter:image"]').attr('content') || null;
        
        // Get main content (first 2000 chars)
        const bodyText = $('article, main, .content, .post, body').text()
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 2000);
        
        pageContent = `Title: ${title}\nDescription: ${description}\nContent: ${bodyText}`;
      }
    } catch (fetchError) {
      console.log('Could not fetch URL content, using user message only:', fetchError);
    }

    const titleMatch = pageContent.match(/^Title:\s*(.+)/m);
    const extractedTitle = titleMatch ? titleMatch[1].trim() : '';
    const contentTooThin = !pageContent || pageContent.length < 100 || !extractedTitle;
    if (contentTooThin || !extractedOgImageUrl) {
      try {
        // Bound the paywall-bypass timeout to whatever budget is left before the
        // caller's overall deadline (interactive review flow), reserving time for
        // the enrichment AI call below. Without this, the bypass keeps its full
        // 60s default and — after the up-front page fetch already spent time —
        // can consume the caller's entire budget, so the whole auto-fill is
        // killed and NOTHING pre-fills, instead of failing the bypass fast and
        // still returning page/AI-derived metadata. Clamped to a sane floor so a
        // nearly-exhausted budget doesn't starve the bypass to an instant fail.
        const PAYWALL_AI_RESERVE_MS = 12000;
        const PAYWALL_MIN_MS = 8000;
        const PAYWALL_MAX_MS = 60000;
        const remainingForPaywall = typeof opts?.deadlineMs === 'number'
          ? opts.deadlineMs - Date.now() - PAYWALL_AI_RESERVE_MS
          : PAYWALL_MAX_MS;
        // With a deadline, if there isn't even the floor's worth of time left,
        // SKIP the bypass rather than start a doomed attempt that would overrun
        // the deadline and leave no time for the enrichment AI — better to return
        // the page/AI-derived metadata we already have than time out entirely.
        const pwBypass = remainingForPaywall < PAYWALL_MIN_MS
          ? null
          : await fetchViaPaywallBypass(url, Math.min(PAYWALL_MAX_MS, remainingForPaywall));
        if (pwBypass) {
          if (contentTooThin && pwBypass.story) {
            const title = pwBypass.headline || extractedTitle || '';
            const storySnippet = pwBypass.story.substring(0, 2000);
            pageContent = `Title: ${title}\nDescription: \nContent: ${storySnippet}`;
          }
          // Use paywall-bypass headline only as a fallback when nothing was scraped from the page
          if (!scrapedHeadline && pwBypass.headline) {
            scrapedHeadline = pwBypass.headline;
          }
          if (!extractedOgImageUrl && pwBypass.imageUrl) {
            extractedOgImageUrl = pwBypass.imageUrl;
          }
          // Paywall-bypass publishedAt is an external, unverified field — bound
          // it to a plausible range (not in the future, not before 2000) so a
          // malformed/garbage value can't stamp a misleading date (Task #653).
          if (!extractedPublishDate && pwBypass.publishedAt) {
            try {
              const d = new Date(pwBypass.publishedAt);
              if (!isNaN(d.getTime()) && d.getFullYear() > 2000 && d.getTime() <= Date.now() + 24 * 60 * 60 * 1000) {
                extractedPublishDate = d;
              }
            } catch {}
          }
        }
      } catch (pwError) {
        console.log('[PaywallBypass] Fallback failed in analyzeSubmittedLink:', pwError);
      }
    }

    // Determine if it's a social media URL
    const socialMediaDomains = ['twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'truthsocial.com', 'gettr.com', 'parler.com', 'gab.com'];
    const isSocialMedia = socialMediaDomains.some(domain => url.toLowerCase().includes(domain));
    
    // Extract timestamp from X/Twitter post IDs (Twitter Snowflake ID)
    if (!extractedPublishDate && (url.includes('x.com') || url.includes('twitter.com'))) {
      // Extract post ID from URL pattern like /status/1234567890
      const postIdMatch = url.match(/\/status\/(\d+)/);
      if (postIdMatch) {
        try {
          const postId = BigInt(postIdMatch[1]);
          // Twitter Snowflake: timestamp is (id >> 22) + Twitter epoch (1288834974657)
          const twitterEpoch = BigInt(1288834974657);
          const timestamp = Number((postId >> BigInt(22)) + twitterEpoch);
          extractedPublishDate = new Date(timestamp);
          if (isNaN(extractedPublishDate.getTime())) {
            extractedPublishDate = null;
          }
        } catch {
          console.log('Could not extract timestamp from X post ID');
        }
      }
    }

    const existingSubjectsList = existingSubjects.length > 0 
      ? `\n\nEXISTING SUBJECTS (STRONGLY PREFER THESE): ${existingSubjects.join(', ')}`
      : '';

    const prompt = `Analyze this submitted content and extract information for a military leadership intelligence brief.

User's Message: "${userMessage}"
URL: ${url}
${pageContent ? `\nPage Content:\n${pageContent}` : ''}${existingSubjectsList}

Provide analysis in JSON format:
{
  "headline": "A concise, clear headline (max 100 chars)",
  "summary": "A brief 2-3 sentence summary of the content's relevance to military/defense leadership",
  "subject": "A SPECIFIC, NARROW subject - use country names, specific regions, or precise topics",
  "sourceType": "${isSocialMedia ? 'social_media' : 'news'}",
  "sourceName": "The name of the news outlet or source (e.g., 'AP News', 'Reuters', 'The Intercept', 'X/@username')"
}

CRITICAL SUBJECT RULES:
1. If the content relates to an EXISTING SUBJECT listed above, you MUST use that exact subject name
2. Only create a new subject if NONE of the existing subjects apply
3. Use SPECIFIC, NARROW subjects - country names (Iran, Russia, China), regions (Middle East, Indo-Pacific), or precise topics (Border Security, Defense Budget)
4. NEVER use broad categories like "Geopolitics", "International Relations", "Defense Policy"
5. For country-specific news, use ONLY the country name (e.g., "Greenland" not "Greenland Annexation")

Focus on extracting information relevant to senior military leadership.`;

    // AI enrichment (headline polish / summary / subject). The headline, image,
    // source name and publish date are ALL derived from the page itself above
    // WITHOUT any AI, so an AI outage must NOT throw them away. When the AI call
    // fails (rate-limit storm / 5xx / network / open circuit) we fall through
    // with an empty AI result and let the page-derived fields populate — the
    // interactive review dialog stays usable instead of opening completely empty.
    let result: any = {};
    let aiUnavailable = false;
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are an intelligence analyst extracting key information from submitted articles and social media posts for senior military leadership. Always respond with valid JSON only.'
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 500,
        response_format: { type: 'json_object' }
      });

      const content = response.choices[0]?.message?.content;
      if (content) {
        result = JSON.parse(content);
      } else {
        console.error('No response from AI for link analysis — using page metadata only');
        aiUnavailable = true;
      }
    } catch (aiError) {
      // Strict callers (e.g. the manual-submit analysis) opt in to a retryable
      // throw so the route can return a 503 instead of a misleading 422. The
      // interactive review flow (throwOnTransient off) instead degrades to the
      // page-derived metadata so the auto-fill dialog still pre-fills.
      if (opts?.throwOnTransient && isTransientAIError(aiError)) {
        throw aiError;
      }
      console.warn('[analyzeSubmittedLink] AI enrichment unavailable — falling back to page metadata only:', (aiError as Error)?.message ?? aiError);
      aiUnavailable = true;
    }
    
    // Known source mappings for common domains
    const sourceMap: Record<string, string> = {
      'apnews.com': 'AP News',
      'reuters.com': 'Reuters',
      'theintercept.com': 'The Intercept',
      'nytimes.com': 'New York Times',
      'washingtonpost.com': 'Washington Post',
      'wsj.com': 'Wall Street Journal',
      'bbc.com': 'BBC',
      'bbc.co.uk': 'BBC',
      'cnn.com': 'CNN',
      'foxnews.com': 'Fox News',
      'nbcnews.com': 'NBC News',
      'cbsnews.com': 'CBS News',
      'abcnews.go.com': 'ABC News',
      'politico.com': 'Politico',
      'thehill.com': 'The Hill',
      'axios.com': 'Axios',
      'bloomberg.com': 'Bloomberg',
      'theguardian.com': 'The Guardian',
      'dailymail.co.uk': 'Daily Mail',
      'npr.org': 'NPR',
      'pbs.org': 'PBS',
      'aljazeera.com': 'Al Jazeera',
      'x.com': 'X',
      'twitter.com': 'X',
    };
    
    // Fallback source name extraction from URL if AI didn't provide one or gave placeholder
    let sourceName = result.sourceName;
    const isInvalidSource = !sourceName || 
      /^unknown/i.test(sourceName) || 
      /^n\/a$/i.test(sourceName) ||
      sourceName.length < 2;
    
    if (isInvalidSource) {
      try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.replace(/^(www\.|amp\.|m\.|mobile\.)/, '');
        
        // Check known sources first
        if (sourceMap[hostname]) {
          sourceName = sourceMap[hostname];
        } else {
          // Extract domain name and format nicely
          const parts = hostname.split('.');
          const domain = parts[0];
          // Capitalize and clean up
          sourceName = domain.charAt(0).toUpperCase() + domain.slice(1);
          // Handle camelCase domains
          sourceName = sourceName.replace(/([a-z])([A-Z])/g, '$1 $2');
        }
      } catch {
        sourceName = 'News Source';
      }
    }
    
    // Resolve the headline by priority:
    // 1) real scraped headline (cleaned of trailing site-name suffix), shortened only if over-long
    // 2) the first non-URL line the user pasted
    // 3) AI-generated as a last resort (flagged so the UI can indicate it)
    const realHeadline = cleanScrapedHeadline(scrapedHeadline);
    const pastedHeadline = extractPastedHeadline(userMessage);

    let finalHeadline: string;
    let headlineSource: 'scraped' | 'pasted' | 'generated';
    let headlineGenerated = false;

    // Shortening over-long headlines also needs AI; when AI is unavailable,
    // truncate locally so the dialog still gets a clean (if blunt) headline.
    const truncateHeadline = (h: string): string =>
      h.length > HEADLINE_MAX_LEN ? h.slice(0, HEADLINE_MAX_LEN - 1).trimEnd() + '…' : h;

    if (realHeadline) {
      finalHeadline = realHeadline.length > HEADLINE_MAX_LEN
        ? (aiUnavailable ? truncateHeadline(realHeadline) : await shortenHeadlineWithAI(realHeadline))
        : realHeadline;
      headlineSource = 'scraped';
    } else if (pastedHeadline) {
      finalHeadline = pastedHeadline.length > HEADLINE_MAX_LEN
        ? (aiUnavailable ? truncateHeadline(pastedHeadline) : await shortenHeadlineWithAI(pastedHeadline))
        : pastedHeadline;
      headlineSource = 'pasted';
    } else {
      finalHeadline = result.headline || 'Untitled Submission';
      headlineSource = 'generated';
      headlineGenerated = true;
    }

    return {
      headline: finalHeadline,
      summary: result.summary || 'No summary available',
      subject: result.subject || 'General',
      sourceType: result.sourceType || (isSocialMedia ? 'social_media' : 'news'),
      sourceName: sourceName,
      publishedAt: extractedPublishDate,
      ogImageUrl: extractedOgImageUrl,
      headlineGenerated,
      headlineSource,
    };
  } catch (error) {
    console.error('Error analyzing submitted link:', error);
    // A transient AI failure (rate-limit / 5xx / network / open circuit) is NOT
    // the same as "this URL can't be analyzed". When the caller opts in, surface
    // it so the route can return a retryable signal instead of a misleading 422.
    // All other callers keep the original null-on-error behavior unchanged.
    if (opts?.throwOnTransient && isTransientAIError(error)) {
      throw error;
    }
    return null;
  }
}
