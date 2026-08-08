/**
 * Curated recall diagnostic (Task #441) — READ-ONLY.
 *
 * Measures how much "recall" the curated lane is currently leaving on the table:
 * standalone single-source items that — under the SAME strict same-event matcher
 * the clustering pass and the #439 incremental-attach bridge use — clearly belong
 * to an ALREADY-FORMED Top Story but are still sitting alone. It answers "is the
 * bridge / clustering pass missing obvious joins, and by how much?" WITHOUT
 * changing anything.
 *
 * Reports:
 *   - raw volume: cluster members, total vs. formed (>= 2 contributing) clusters,
 *     candidate feed + curated-store items, distinct sources among candidates;
 *   - missed-attach rate (ALL roles): standalone items that strictly match exactly
 *     one formed cluster, ignoring outlet behavior — the theoretical ceiling;
 *   - missed-attach rate (CONTRIBUTING only): the same, restricted to trusted
 *     contributing outlets — exactly what the #439 bridge is allowed to fold in,
 *     i.e. the recall it should actually be capturing each run;
 *   - standalone-should-merge-strict rate: standalone items that — under the SAME
 *     strict same-event matcher (looksSameEvent + withinSameEventWindow + a
 *     category veto) — group with at least one OTHER standalone from a DISTINCT
 *     source, i.e. >= 2 single-source rows that should have FORMED a new Top Story
 *     together but are each still sitting alone. This is the merge/duplicate-quality
 *     axis the #423 verification could not measure (missed-attach only covers
 *     joining an ALREADY-formed cluster; this covers the cluster that never formed);
 *   - a sample of the strongest would-attach pairs and would-merge groups.
 *
 * Every rate is printed ALONGSIDE its raw numerator/denominator and the distinct-
 * source volume, so a future re-run can tell a real regression apart from a pure
 * volume swing (the ambiguity that blocked the #423 recall conclusion).
 *
 * Strictly read-only and CURATED-LANE ONLY: it reuses the bridge's pure matchers
 * and the curated/main candidate readers, performs ZERO writes, and never touches
 * the Classic/Visual/custom-MCOP/public surfaces.
 *
 *   npx tsx scripts/curated-recall-diagnostic.ts
 */
import { storage } from '../server/storage';
import {
  buildAttachClusters,
  selectAttachClusterId,
  type AttachCandidate,
} from '../server/curatedIncrementalAttach';
import {
  significantTitleTokens,
  looksSameEvent,
  withinSameEventWindow,
} from '../server/curatedCluster';
import {
  buildOutletIndex,
  findOutlet,
  deriveOutletBehavior,
  deriveBehavior,
  isSocialFlashOutlet,
} from '@shared/outletRegistry';
import { isSingleWellFormedHttpUrl } from '../server/curatedIngest';
import { normalizeIdentityUrl } from '../server/urlIdentity';

const WINDOW_HOURS = 24;

interface Standalone {
  key: string;
  title: string;
  source: string;
  url: string;
  role: string;
  blocked: boolean;
  social: boolean;
  cand: AttachCandidate;
}

async function main() {
  console.log(`\n=== Curated recall diagnostic (read-only, last ${WINDOW_HOURS}h) ===\n`);

  const [members, registry, feed, curatedStore] = await Promise.all([
    storage.getCuratedClusterMembers(WINDOW_HOURS),
    storage.getOutletRegistry(),
    storage.getPrimaryFeed(WINDOW_HOURS),
    storage.getCuratedStoreItems(WINDOW_HOURS),
  ]);

  const allClusterIds = new Set(members.map((m) => m.clusterId));
  const formed = buildAttachClusters(members);
  const outletIndex = buildOutletIndex(registry);

  // Identity sets of everything already mapped (member key + normalized URL).
  const memberKeys = new Set<string>();
  const memberUrls = new Set<string>();
  for (const m of members) {
    memberKeys.add(`${m.itemType}:${m.itemId}`);
    const nu = normalizeIdentityUrl(m.url);
    if (nu) memberUrls.add(nu);
  }

  // Classification overlay for the content-based category veto.
  const classUrls = Array.from(
    new Set([...feed.map((f) => f.url), ...curatedStore.map((c) => c.url)]),
  );
  const classMap = await storage.getCuratedClassificationsByUrls(classUrls);

  // Assemble standalone candidates (not already a cluster member).
  const standalones: Standalone[] = [];
  const distinctSources = new Set<string>();
  const pushRaw = (
    itemType: 'main' | 'curated',
    itemId: string,
    title: string,
    source: string,
    url: string,
    category: string | null,
    publishedAt: Date | null,
  ) => {
    const key = `${itemType}:${itemId}`;
    if (memberKeys.has(key)) return;
    if (!isSingleWellFormedHttpUrl(url)) return;
    const nu = normalizeIdentityUrl(url);
    if (nu && memberUrls.has(nu)) return;
    if (!source || source === 'Unknown Source') return;
    distinctSources.add(source);
    const outlet = findOutlet(outletIndex, source, url);
    const behavior = outlet ? deriveOutletBehavior(outlet) : deriveBehavior({});
    standalones.push({
      key,
      title,
      source,
      url,
      role: behavior.role,
      blocked: behavior.blocked,
      social: isSocialFlashOutlet(outlet),
      cand: {
        key,
        tokens: significantTitleTokens(title),
        publishedAt,
        category: classMap.get(url)?.category ?? category ?? null,
      },
    });
  };

  for (const f of feed) {
    pushRaw('main', f.id, f.title, f.source, f.url, f.category ?? null, f.articlePublishedAt ?? f.scrapedAt ?? null);
  }
  for (const c of curatedStore) {
    pushRaw('curated', c.id, c.title, c.source, c.url, c.category ?? null, c.articlePublishedAt ?? c.scrapedAt ?? null);
  }

  // Evaluate would-attach under both lenses.
  interface Hit {
    s: Standalone;
    clusterId: string;
  }
  const hitsAll: Hit[] = [];
  const hitsContributing: Hit[] = [];
  for (const s of standalones) {
    const target = selectAttachClusterId(s.cand, formed);
    if (!target) continue;
    hitsAll.push({ s, clusterId: target });
    if (!s.blocked && !s.social && s.role === 'contributing') {
      hitsContributing.push({ s, clusterId: target });
    }
  }

  // ---------------------------------------------------------------------------
  // Standalone-should-merge-strict (the merge / duplicate-quality axis).
  //
  // Among the standalone items, find connected groups under the SAME strict
  // same-event rule the clustering pass uses — looksSameEvent(token overlap) AND
  // withinSameEventWindow(time) AND a category veto (both known + different =>
  // never merge). A group that spans >= 2 DISTINCT sources is a Top Story that
  // SHOULD have formed (>= 2 distinct publishers corroborating the same event)
  // but didn't — every member is still a single-source row sitting alone. This is
  // intentionally distinct from missed-attach: missed-attach joins an
  // ALREADY-formed cluster, this measures the cluster that never formed at all.
  //
  // Transitive single-link union (any pair in the group strict-matches) mirrors
  // buildSameEventBuckets' BFS chaining, so a string of same-event reports where
  // no single pair spans the whole set still counts as ONE would-merge story
  // instead of fragmenting. The distinct-source requirement is what makes it
  // "strict" (and excludes same-outlet near-dupes, a separate concern).
  const categoryVetoes = (a: string | null, b: string | null): boolean => {
    const known = (c: string | null): c is string => {
      if (!c) return false;
      const v = c.trim().toLowerCase();
      return v !== '' && v !== 'general' && v !== 'other' && v !== 'other / emerging';
    };
    return known(a) && known(b) && a.trim().toLowerCase() !== b.trim().toLowerCase();
  };
  const strictSameEvent = (a: Standalone, b: Standalone): boolean =>
    !categoryVetoes(a.cand.category, b.cand.category) &&
    withinSameEventWindow(a.cand.publishedAt, b.cand.publishedAt) &&
    looksSameEvent(a.cand.tokens, b.cand.tokens);

  // Union-find over standalones.
  const parent = standalones.map((_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const nx = parent[x];
      parent[x] = r;
      x = nx;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < standalones.length; i++) {
    for (let j = i + 1; j < standalones.length; j++) {
      if (strictSameEvent(standalones[i], standalones[j])) union(i, j);
    }
  }
  const groupMembers = new Map<number, number[]>();
  for (let i = 0; i < standalones.length; i++) {
    const r = find(i);
    const arr = groupMembers.get(r);
    if (arr) arr.push(i);
    else groupMembers.set(r, [i]);
  }
  // A "should-merge" group: >= 2 members spanning >= 2 DISTINCT sources.
  interface MergeGroup {
    idxs: number[];
    sources: Set<string>;
  }
  const mergeGroups: MergeGroup[] = [];
  for (const idxs of Array.from(groupMembers.values())) {
    if (idxs.length < 2) continue;
    const sources = new Set(idxs.map((i) => standalones[i].source));
    if (sources.size < 2) continue;
    mergeGroups.push({ idxs, sources });
  }
  mergeGroups.sort((a, b) => b.idxs.length - a.idxs.length);
  const itemsInMergeGroups = mergeGroups.reduce((n, g) => n + g.idxs.length, 0);

  const pct = (n: number, d: number) => (d === 0 ? '0.0' : ((100 * n) / d).toFixed(1));

  console.log('--- raw volume ---');
  console.log(`cluster members (24h):            ${members.length}`);
  console.log(`distinct clusters:                ${allClusterIds.size}`);
  console.log(`formed clusters (>=2 contributing): ${formed.length}`);
  console.log(`primary-feed candidates:          ${feed.length}`);
  console.log(`curated-store candidates:         ${curatedStore.length}`);
  console.log(`standalone (not yet clustered):   ${standalones.length}`);
  console.log(`distinct sources among standalone: ${distinctSources.size}`);

  console.log('\n--- missed-attach (recall left on the table) ---');
  console.log(
    `ALL roles:           ${hitsAll.length} / ${standalones.length} standalone would strict-attach (${pct(hitsAll.length, standalones.length)}%)`,
  );
  const contribStandalone = standalones.filter((s) => !s.blocked && !s.social && s.role === 'contributing');
  console.log(
    `CONTRIBUTING only:   ${hitsContributing.length} / ${contribStandalone.length} trusted standalone would attach (${pct(hitsContributing.length, contribStandalone.length)}%)`,
  );
  console.log(
    `  (CONTRIBUTING hits are exactly what the #439 bridge folds in each run; a persistently high count = clustering recall gap.)`,
  );

  console.log('\n--- standalone-should-merge-strict (cluster that never formed) ---');
  console.log(
    `would-merge groups:  ${mergeGroups.length} (>=2 distinct-source standalone clusters that didn't form)`,
  );
  console.log(
    `items involved:      ${itemsInMergeGroups} / ${standalones.length} standalone (${pct(itemsInMergeGroups, standalones.length)}%)`,
  );
  console.log(
    `  (each group = >= 2 single-source rows from distinct outlets that strict-match the SAME event but never clustered;`,
  );
  console.log(
    `   read the rate ALONGSIDE the standalone + distinct-source volume above so a volume swing isn't mistaken for a regression.)`,
  );

  // Sample the largest would-merge groups for human eyeballing.
  const mergeSample = mergeGroups.slice(0, 8);
  if (mergeSample.length > 0) {
    console.log('\n--- sample would-merge groups ---');
    for (const g of mergeSample) {
      console.log(`  • group of ${g.idxs.length} (${g.sources.size} sources):`);
      for (const i of g.idxs.slice(0, 4)) {
        console.log(`      [${standalones[i].source}] "${truncate(standalones[i].title)}"`);
      }
      if (g.idxs.length > 4) console.log(`      … +${g.idxs.length - 4} more`);
    }
  }

  // Sample the strongest would-attach pairs for human eyeballing.
  const sample = hitsContributing.slice(0, 12);
  if (sample.length > 0) {
    console.log('\n--- sample would-attach (contributing) ---');
    const repByCluster = new Map(formed.map((f) => [f.clusterId, f]));
    for (const h of sample) {
      const cl = repByCluster.get(h.clusterId);
      console.log(`  • [${h.s.source}] "${truncate(h.s.title)}"`);
      console.log(`      -> cluster ${h.clusterId} (${cl?.contributingCount ?? '?'} src, cat=${cl?.category ?? '—'})`);
    }
  }

  console.log('\n(diagnostic only — no rows were written.)\n');
  process.exit(0);
}

function truncate(s: string, n = 72): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

main().catch((err) => {
  console.error('[curated-recall-diagnostic] error:', err);
  process.exit(1);
});
