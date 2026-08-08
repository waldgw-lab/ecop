/**
 * Direct DEV-database regression for strict editorial-evidence atomicity.
 *
 * The callback creates the durable episode and event link after the raw override
 * event has already been inserted, then deliberately throws. PostgreSQL must
 * roll all three writes back. Exit 3 means the database/schema is unavailable.
 */
import { eq, or, sql } from 'drizzle-orm';
import { db } from '../server/db';
import { storage } from '../server/storage';
import { captureEditorialEpisode } from '../server/editorialEvidenceCapture';
import {
  curatedEditorialEpisodeEvents,
  curatedEditorialEpisodes,
  curatedOverrideEvents,
  type InsertCuratedEditorialEpisode,
} from '../shared/schema';

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_INCONCLUSIVE = 3;
const marker = `__evidence_atomicity_${Date.now()}_${Math.random().toString(36).slice(2, 8)}__`;
const signature = `${marker}:episode`;

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) console.log(`[evidence-atomicity] OK   ${label}`);
  else {
    failures++;
    console.error(`[evidence-atomicity] FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function cleanup() {
  const episodes = await db
    .select({ id: curatedEditorialEpisodes.id })
    .from(curatedEditorialEpisodes)
    .where(eq(curatedEditorialEpisodes.createdBy, marker));
  for (const episode of episodes) {
    await db
      .delete(curatedEditorialEpisodeEvents)
      .where(eq(curatedEditorialEpisodeEvents.episodeId, episode.id));
  }
  await db.delete(curatedEditorialEpisodes)
    .where(eq(curatedEditorialEpisodes.createdBy, marker));
  await db
    .delete(curatedOverrideEvents)
    .where(or(
      eq(curatedOverrideEvents.editor, marker),
      eq(curatedOverrideEvents.newValue, marker),
    ));
}

async function main() {
  try {
    try {
      await db.execute(sql`SELECT 1 FROM curated_override_events LIMIT 1`);
      await db.execute(sql`SELECT 1 FROM curated_editorial_episodes LIMIT 1`);
      await db.execute(sql`SELECT 1 FROM curated_editorial_episode_events LIMIT 1`);
    } catch (error) {
      console.error(`[evidence-atomicity] INCONCLUSIVE — database/schema unavailable: ${(error as Error).message}`);
      process.exit(EXIT_INCONCLUSIVE);
    }

    await cleanup();
    let threw = false;
    try {
      await storage.captureCuratedOverrideEvidenceAtomic({
        action: 'manual-link',
        editor: marker,
        newValue: marker,
        itemUrl: `https://example.test/${marker}`,
        canonicalUrl: `https://example.test/${marker}`,
      }, async (eventId, transactionStorage) => {
        const txStorage = transactionStorage as {
          upsertCuratedEditorialEpisode(
            row: InsertCuratedEditorialEpisode,
            options?: { collapse?: boolean },
          ): Promise<{ id: string }>;
          attachCuratedEditorialEpisodeEvents(
            episodeId: string,
            events: Array<{
              eventId: string;
              eventAction?: string | null;
              eventEditor?: string | null;
              eventAt?: Date | null;
            }>,
          ): Promise<unknown>;
        };
        const episode = await txStorage.upsertCuratedEditorialEpisode({
          signature,
          actionFamily: 'grouping-positive',
          action: 'link',
          direction: 'link',
          lifecycle: 'open',
          outcome: 'requested',
          createdBy: marker,
        }, { collapse: true });
        await txStorage.attachCuratedEditorialEpisodeEvents(episode.id, [{
          eventId,
          eventAction: 'link',
          eventEditor: marker,
          eventAt: new Date(0),
        }]);
        throw new Error('forced post-attachment rollback');
      });
    } catch {
      threw = true;
    }
    check('forced post-attachment failure propagates', threw);

    const [rawRows, episodeRows] = await Promise.all([
      db.select({ id: curatedOverrideEvents.id })
        .from(curatedOverrideEvents)
        .where(eq(curatedOverrideEvents.editor, marker)),
      db.select({ id: curatedEditorialEpisodes.id })
        .from(curatedEditorialEpisodes)
        .where(eq(curatedEditorialEpisodes.signature, signature)),
    ]);
    const linkRows = await db
      .select({ id: curatedEditorialEpisodeEvents.id })
      .from(curatedEditorialEpisodeEvents)
      .where(eq(curatedEditorialEpisodeEvents.eventEditor, marker));

    check('raw override event rolled back', rawRows.length === 0, String(rawRows.length));
    check('durable episode rolled back', episodeRows.length === 0, String(episodeRows.length));
    check('episode-event link rolled back', linkRows.length === 0, String(linkRows.length));

    // A coordinated pre-apply undo is only a REQUEST. It must not mark the prior
    // landed episode undone before the authoritative overlay revoke succeeds.
    const prior = await storage.upsertCuratedEditorialEpisode({
      signature: `${marker}:prior`,
      actionFamily: 'grouping-positive',
      action: 'link',
      canonicalUrl: `https://example.test/${marker}/lineage`,
      storyKey: `story:${marker}`,
      direction: 'link',
      lifecycle: 'open',
      outcome: 'persisted',
      createdBy: marker,
    }, { collapse: true });
    let requestedEpisodeId: string | null = null;
    await storage.captureCuratedOverrideEvidenceAtomic({
      action: 'manual-unlink-undo',
      editor: marker,
      newValue: `requested undo ${marker}`,
      itemUrl: `https://example.test/${marker}/lineage`,
      canonicalUrl: `https://example.test/${marker}/lineage`,
    }, async (eventId, transactionStorage) => {
      requestedEpisodeId = await captureEditorialEpisode(transactionStorage, {
        sourceEventId: eventId,
        kind: 'undo',
        editor: marker,
        primaryUrl: `https://example.test/${marker}/lineage`,
        memberUrls: [`https://example.test/${marker}/lineage`],
        requestedContext: { undoOfOverlayId: marker },
        outcome: 'requested',
        surface: 'gate',
        atMs: Date.now(),
      }, { strict: true });
      return requestedEpisodeId;
    });
    const [priorAfter, requestedAfter] = await Promise.all([
      storage.getCuratedEditorialEpisodeById(prior.id),
      requestedEpisodeId
        ? storage.getCuratedEditorialEpisodeById(requestedEpisodeId)
        : Promise.resolve(undefined),
    ]);
    check(
      'requested undo leaves prior episode lineage untouched',
      priorAfter?.lifecycle === 'open'
        && priorAfter.outcome === 'persisted'
        && !priorAfter.undoneByEventId
        && !priorAfter.supersededById,
      JSON.stringify(priorAfter),
    );
    check(
      'requested undo episode remains pending and unverified',
      requestedAfter?.outcome === 'requested'
        && requestedAfter.lifecycle === 'open'
        && requestedAfter.verified === false
        && !requestedAfter.contradictsEpisodeId,
      JSON.stringify(requestedAfter),
    );
  } catch (error) {
    failures++;
    console.error('[evidence-atomicity] FAIL unexpected error:', error);
  } finally {
    try {
      await cleanup();
    } catch (error) {
      failures++;
      console.error('[evidence-atomicity] FAIL cleanup:', error);
    }
  }

  console.log(`[evidence-atomicity] ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? EXIT_PASS : EXIT_FAIL);
}

void main();