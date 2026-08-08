// One-off dev utility: seed the curated Story Archive from the clusters that are
// CURRENTLY formed in the DB (curated_cluster_members + curated_story_synthesis),
// without running a clustering/LLM pass. Useful when the archive shipped after the
// last successful pass (e.g. while OpenAI quota was exhausted) so it starts empty.
//
// Reuses the exact live archive logic (archiveFormedStories) so the snapshot is
// identical to what a normal cron pass would write. Curated-lane only — touches
// nothing outside curated_story_archive.
//
// Run: npx tsx scripts/backfill-curated-archive.ts

import { storage } from '../server/storage';
import { archiveFormedStories } from '../server/curatedCluster';

async function main() {
  // Wide window so we catch the last formed pass regardless of when it ran.
  const members = await storage.getCuratedClusterMembers(24 * 90);
  const clusters = new Set(members.map((m) => m.clusterId));
  console.log(
    `[backfill] Found ${members.length} cluster members across ${clusters.size} formed clusters.`,
  );

  if (members.length === 0) {
    console.log('[backfill] Nothing currently formed — archive unchanged.');
    process.exit(0);
  }

  await archiveFormedStories(members);

  const { items, total } = await storage.searchCuratedStoryArchive({ limit: 100, offset: 0 });
  console.log(`[backfill] Archive now holds ${total} stories.`);
  for (const it of items.slice(0, 20)) {
    const geo = [it.region, it.country].filter(Boolean).join(' / ') || '—';
    console.log(`  • [${it.sourceCount} src] ${it.headline}  (${it.category ?? '—'} | ${geo})`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill] Failed:', err);
  process.exit(1);
});
