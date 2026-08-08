import { openai } from './aiClient';
import { withAiTimeout, AI_CALL_TIMEOUT_MS, AI_CALL_BACKSTOP_MS } from './aiTimeout';
import { db } from './db';
import { teamSubjects, teamSubmissions } from '@shared/schema';
import { eq, and, isNull, desc, or, gt } from 'drizzle-orm';
import { compileWatchTopic, hasKeywordGate, matchesTopic, type CompiledWatchTopic } from './watchTopicMatchCore';

// ---------------------------------------------------------------------------
// AI submission tagger for Priority/BOLO topics — KEYWORD-GATED (Task #884).
//
// The pure-AI version of this matcher tagged every defense-adjacent headline
// to a topic (63/63 junk on "Defense Spending Bill"). The deterministic
// keyword gate from watchTopicMatchCore now brackets the AI on BOTH sides:
//
//   1. PRE-GATE:  a submission is only offered to the AI as a candidate for
//      the topics whose compiled watchKeywords gate its HEADLINE passes.
//      A submission that matches no topic's keywords is never sent at all.
//   2. AI CONFIRM: the AI refines among keyword-passing candidates only. The
//      prompt now includes each topic's watchKeywords so the model sees the
//      same definition of "on-topic" the gate enforces.
//   3. POST-VERIFY: an AI match is persisted ONLY if the chosen topic is in
//      that submission's keyword-eligible set (fail-closed against index
//      drift / model creativity).
//
// SYMMETRY: the gate runs on the HEADLINE ONLY — identical to the boot-time
// heal in migrate.ts that clears mis-tagged rows. If either side widened to
// summary text alone, tag→heal→re-tag flip-flop loops would appear.
//
// Topics are selected by the BEHAVIOR FLAGS (isPriorityWatch / isBoloWatch),
// matching the panel endpoint and loadActiveWatchTopics — not the legacy
// category column. Topics without a usable keyword gate are skipped entirely
// (they can never pass the gate, so tagging them would violate rule 1).
// ---------------------------------------------------------------------------

export interface JoePriorityMatchResult {
  // Number of submissions matched to a topic this run.
  matched: number;
  // True only when the matcher actually performed AI scoring work (active topics AND
  // keyword-passing candidates both present). False when it early-returned with nothing
  // to do, so the caller can avoid advancing its cadence window and stay responsive to
  // new topics.
  ranAi: boolean;
}

interface TaggableTopic {
  subject: typeof teamSubjects.$inferSelect;
  gate: CompiledWatchTopic;
}

export async function matchSubmissionsToJoePriorities(): Promise<JoePriorityMatchResult> {
  const now = new Date();
  const watchSubjects = await db
    .select()
    .from(teamSubjects)
    .where(and(
      eq(teamSubjects.isActive, true),
      or(eq(teamSubjects.isPriorityWatch, true), eq(teamSubjects.isBoloWatch, true)),
      or(isNull(teamSubjects.estimatedActiveUntil), gt(teamSubjects.estimatedActiveUntil, now)),
    ));

  if (watchSubjects.length === 0) {
    return { matched: 0, ranAi: false };
  }

  // Compile each topic's deterministic keyword gate. A topic that compiles to
  // no usable gate can never be tagged (fail-closed) — skip it.
  const taggable: TaggableTopic[] = [];
  for (const subject of watchSubjects) {
    const gate = compileWatchTopic(subject);
    if (hasKeywordGate(gate)) {
      taggable.push({ subject, gate });
    } else {
      console.log(`[JoePriorityMatcher] Topic "${subject.name}" has no usable watchKeywords — skipping (cannot pass keyword gate)`);
    }
  }
  if (taggable.length === 0) {
    return { matched: 0, ranAi: false };
  }

  const recentSubmissions = await db
    .select()
    .from(teamSubmissions)
    .where(and(
      eq(teamSubmissions.status, 'processed'),
      isNull(teamSubmissions.deletedAt),
      isNull(teamSubmissions.joePrioritySubjectId)
    ))
    .orderBy(desc(teamSubmissions.createdAt))
    .limit(100);

  if (recentSubmissions.length === 0) {
    return { matched: 0, ranAi: false };
  }

  // PRE-GATE: only submissions whose headline passes at least one topic's
  // keyword gate become AI candidates, and each remembers WHICH topics it is
  // eligible for.
  const candidates: Array<{ submission: typeof teamSubmissions.$inferSelect; eligible: number[] }> = [];
  for (const submission of recentSubmissions) {
    const eligible: number[] = [];
    for (let ti = 0; ti < taggable.length; ti++) {
      if (matchesTopic(taggable[ti].gate, submission.headline || '')) {
        eligible.push(ti);
      }
    }
    if (eligible.length > 0) {
      candidates.push({ submission, eligible });
    }
  }

  if (candidates.length === 0) {
    // Nothing passed the keyword gate — no AI spend, cadence window stays open.
    return { matched: 0, ranAi: false };
  }

  const topicList = taggable.map(({ subject }, i) => {
    const kind = subject.isPriorityWatch ? "Joe's Priority" : 'BOLO';
    const clauses = [
      ...(subject.watchKeywords?.length ? [`watch keywords: ${subject.watchKeywords.join(', ')}`] : []),
      ...(subject.orKeywords?.length ? [`OR: ${subject.orKeywords.join(', ')}`] : []),
      ...(subject.andKeywords?.length ? [`AND: ${subject.andKeywords.join(', ')}`] : []),
      ...(subject.notKeywords?.length ? [`NOT: ${subject.notKeywords.join(', ')}`] : []),
    ];
    return `${i}: [${kind}] ${subject.name} - ${subject.description || 'No description'}${clauses.length ? ` (${clauses.join('; ')})` : ''}`;
  }).join('\n');

  const BATCH_SIZE = 20;
  let totalMatched = 0;
  let anyBatchSucceeded = false;

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);

    const submissionsList = batch.map((c, idx) =>
      `${idx}: "${c.submission.headline}" (${c.submission.sourceName || c.submission.sourceType}) [eligible topics: ${c.eligible.join(', ')}]`
    ).join('\n');

    try {
      const response = await withAiTimeout(openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You match news articles/social media posts to priority topics for a military intelligence platform.

PRIORITY TOPICS (each lists the watch keywords that define its scope):
${topicList}

Every submission below has already passed a deterministic keyword screen for the topics listed in its "eligible topics" — you may ONLY match a submission to one of ITS eligible topics, or leave it unmatched.

A match means the article is directly about that topic's subject matter (see its watch keywords), not merely from the same broad domain. Be selective: when in doubt, leave it unmatched.

Return JSON: {"matches": [{"submissionIndex": number, "topicIndex": number}]}
Only include submissions that genuinely match a topic.`
          },
          {
            role: 'user',
            content: `Match these submissions to priority topics:\n${submissionsList}`
          }
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }, { timeout: AI_CALL_TIMEOUT_MS, maxRetries: 0 }), AI_CALL_BACKSTOP_MS, 'joePriorityMatcher');

      anyBatchSucceeded = true;

      const content = response.choices[0]?.message?.content;
      if (!content) continue;

      let parsed: { matches?: Array<{ submissionIndex: number; topicIndex: number }> };
      try {
        parsed = JSON.parse(content);
      } catch (parseError) {
        console.error('[JoePriorityMatcher] Malformed AI response - JSON parse failed. Raw:', content.slice(0, 300), parseError);
        continue;
      }

      const matches = parsed.matches || [];

      for (const match of matches) {
        if (
          typeof match.submissionIndex !== 'number' ||
          typeof match.topicIndex !== 'number' ||
          match.submissionIndex < 0 || match.submissionIndex >= batch.length ||
          match.topicIndex < 0 || match.topicIndex >= taggable.length
        ) {
          continue;
        }
        const candidate = batch[match.submissionIndex];
        // POST-VERIFY: the AI may only assign a topic this submission's
        // headline actually keyword-matched. Anything else is discarded.
        if (!candidate.eligible.includes(match.topicIndex)) {
          console.log(`[JoePriorityMatcher] Discarded AI match outside keyword-eligible set: "${(candidate.submission.headline || '').slice(0, 80)}" -> topic ${match.topicIndex}`);
          continue;
        }
        await db.update(teamSubmissions)
          .set({ joePrioritySubjectId: taggable[match.topicIndex].subject.id })
          .where(eq(teamSubmissions.id, candidate.submission.id));
        totalMatched++;
      }
    } catch (error) {
      console.error('[JoePriorityMatcher] AI call failed for batch:', error);
    }
  }

  if (totalMatched > 0) {
    console.log(`[JoePriorityMatcher] Matched ${totalMatched} submissions to Joe Priority/BOLO topics (${candidates.length}/${recentSubmissions.length} passed keyword gate)`);
  }

  return { matched: totalMatched, ranAi: anyBatchSucceeded };
}
