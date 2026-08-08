/**
 * Curated archive-grace recall + honest-status regression (Part B / Part A).
 *
 * The defect: a curated "Top Stories" cluster that drops out of the live feed for
 * a SINGLE transient clustering pass — but whose articles are still fresh — was
 *   (A) mislabeled in the archive as "Phased out" (it was merely not surfaced), and
 *   (B) unable to re-surface, because none of its still-fresh members re-entered
 *       the next clustering payload (they sit below the priority cap).
 *
 * The fix:
 *   Part A — `archiveMembersPhasedOut` derives an HONEST status from the stored
 *            members so a still-fresh, still-eligible story reads 'active', and a
 *            genuinely aged-out story reads 'phased_out'.
 *   Part B — `buildArchiveGraceMemberUrls` collects the normalized URLs of the
 *            CONTRIBUTING members of recently-missed, still-fresh archive rows, and
 *            `selectCandidateNodes` rescues a live candidate matching one of those
 *            URLs via a bounded (a2) sub-lane that is COUNTED INSIDE RESCUE_BUDGET —
 *            so HARD_NODE_CEILING is unchanged.
 *
 * Pure, deterministic (no network / DB / LLM). Exits non-zero on any violation so
 * it can run as a regression gate.
 *
 * Usage:  tsx scripts/curated-archive-grace.test.ts
 */

import {
  selectCandidateNodes,
  buildArchiveGraceMemberUrls,
  type LaneNode,
} from '../server/curatedCluster';
import { archiveMembersPhasedOut } from '../server/curatedStaleness';
import { normalizeMemberUrl } from '../server/curatedSynthesis';
import type { CuratedArchiveMember } from '@shared/schema';

const HOUR = 3_600_000;
const MAX_NODES = 140;
const RESCUE_BUDGET = 60;
const TOTAL_RESCUE_CEILING = 100;
const MANUAL_LINK_HEADROOM = 100;
// Mirrors server/curatedCluster.ts (starvation fix). Restated (not imported) so
// this test also pins the constants' INTENT: if the ceiling math changes, revisit.
const HARD_NODE_CEILING =
  MAX_NODES + RESCUE_BUDGET + TOTAL_RESCUE_CEILING + MANUAL_LINK_HEADROOM;
const ARCHIVE_GRACE_ADMIT_MAX = 30;

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[grace] OK   ${name}`);
  } else {
    console.error(`[grace] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const now = Date.now();

function member(
  partial: Partial<CuratedArchiveMember> & { url: string },
): CuratedArchiveMember {
  return {
    source: partial.source ?? 'Test Wire',
    title: partial.title ?? 'A reported headline about something happening today',
    url: partial.url,
    behaviorClass: partial.behaviorClass ?? 'corroborating',
    behaviorLabel: partial.behaviorLabel ?? null,
    spin: partial.spin ?? null,
    // Respect an EXPLICIT null (legacy/unknown-date member) — `??` would coalesce
    // it back to the default, hiding the no-freshness-evidence path.
    publishedAt: 'publishedAt' in partial ? partial.publishedAt : new Date(now - 2 * HOUR).toISOString(),
  } as CuratedArchiveMember;
}

// ---------------------------------------------------------------------------
// PART A — honest archive status (archiveMembersPhasedOut).
// ---------------------------------------------------------------------------

// A fresh story (all members ~2h old) is NOT phased out — it is 'active'.
const freshMembers = [
  member({ url: 'https://a.example.com/fresh-1', publishedAt: new Date(now - 2 * HOUR).toISOString() }),
  member({ url: 'https://a.example.com/fresh-2', publishedAt: new Date(now - 3 * HOUR).toISOString() }),
];
check(
  'PART A: a still-fresh story reads ACTIVE (not phased out)',
  archiveMembersPhasedOut(freshMembers, now) === false,
  'fresh members were mislabeled phased_out',
);

// A genuinely aged-out story (all members ~30h old, past the 22h hard cap) IS
// phased out — no fresh contributing update to hold it open.
const agedMembers = [
  member({ url: 'https://b.example.com/aged-1', publishedAt: new Date(now - 30 * HOUR).toISOString() }),
  member({ url: 'https://b.example.com/aged-2', publishedAt: new Date(now - 31 * HOUR).toISOString() }),
];
check(
  'PART A: a genuinely aged-out story reads PHASED OUT',
  archiveMembersPhasedOut(agedMembers, now) === true,
  'aged members were not recognized as phased_out',
);

// THE crux of the bug: a story that ORIGINATED long ago but is STILL being
// reported by trusted (contributing) outlets within the active gap must stay
// 'active' (the general actively-updating extension), never be retired mid-update.
const stillUpdatingMembers = [
  member({ url: 'https://c.example.com/orig-1', publishedAt: new Date(now - 30 * HOUR).toISOString() }),
  member({ url: 'https://c.example.com/orig-2', publishedAt: new Date(now - 28 * HOUR).toISOString() }),
  member({ url: 'https://c.example.com/upd-1', publishedAt: new Date(now - 2 * HOUR).toISOString() }),
  member({ url: 'https://c.example.com/upd-2', publishedAt: new Date(now - 3 * HOUR).toISOString() }),
];
check(
  'PART A: a story still being updated by trusted outlets stays ACTIVE',
  archiveMembersPhasedOut(stillUpdatingMembers, now) === false,
  'an actively-updating story was wrongly retired as phased_out',
);

// ---------------------------------------------------------------------------
// PART B.1 — buildArchiveGraceMemberUrls: only CONTRIBUTING members of recent,
// still-fresh, in-episode rows yield rescue URLs.
// ---------------------------------------------------------------------------

const contribUrlA = 'https://grace.example.com/eligible-contrib-A';
const contribUrlB = 'https://grace.example.com/eligible-contrib-B';
const attachUrl = 'https://grace.example.com/attach-only-C';
const anchorUrl = 'https://grace.example.com/anchor-only-D';
const phasedUrl = 'https://grace.example.com/phased-out-E';
const staleEpisodeUrl = 'https://grace.example.com/out-of-episode-F';
const mixedContribUrl = 'https://grace.example.com/mixed-contrib-G';
const mixedAttachUrl = 'https://grace.example.com/mixed-attach-H';
const noDateUrl = 'https://grace.example.com/legacy-no-date-I';

const graceRows = [
  // Eligible: recent origination, fresh members, contributing -> URLs included.
  {
    firstSeenAt: new Date(now - 3 * HOUR),
    members: [
      member({ url: contribUrlA, behaviorClass: 'corroborating' }),
      member({ url: contribUrlB, behaviorClass: 'corroborating' }),
    ],
  },
  // Fresh + in-episode but NON-contributing (attach / anchor-only) -> no URLs.
  {
    firstSeenAt: new Date(now - 3 * HOUR),
    members: [
      member({ url: attachUrl, behaviorClass: 'attach' }),
      member({ url: anchorUrl, behaviorClass: 'anchor-only' }),
    ],
  },
  // Genuinely phased out (aged members) -> excluded entirely.
  {
    firstSeenAt: new Date(now - 3 * HOUR),
    members: [
      member({ url: phasedUrl, behaviorClass: 'corroborating', publishedAt: new Date(now - 30 * HOUR).toISOString() }),
      member({ url: phasedUrl + '-2', behaviorClass: 'corroborating', publishedAt: new Date(now - 31 * HOUR).toISOString() }),
    ],
  },
  // Out-of-episode: origination far in the past (different episode) -> excluded
  // even though its members happen to be fresh.
  {
    firstSeenAt: new Date(now - 500 * HOUR),
    members: [member({ url: staleEpisodeUrl, behaviorClass: 'corroborating' })],
  },
  // Mixed: only the CONTRIBUTING member yields a URL; the attach member does not.
  {
    firstSeenAt: new Date(now - 3 * HOUR),
    members: [
      member({ url: mixedContribUrl, behaviorClass: 'corroborating' }),
      member({ url: mixedAttachUrl, behaviorClass: 'attach' }),
    ],
  },
  // Legacy/unknown-date: a contributing member with NO usable publishedAt. The
  // staleness rule returns "not phased out" only because it has no basis, so this
  // row carries no freshness evidence -> fail-closed, no rescue URL.
  {
    firstSeenAt: new Date(now - 3 * HOUR),
    members: [member({ url: noDateUrl, behaviorClass: 'corroborating', publishedAt: null })],
  },
];

const graceUrls = buildArchiveGraceMemberUrls(graceRows, now);
const expectIn = [contribUrlA, contribUrlB, mixedContribUrl].map(u => normalizeMemberUrl(u));
const expectOut = [attachUrl, anchorUrl, phasedUrl, staleEpisodeUrl, mixedAttachUrl, noDateUrl].map(u => normalizeMemberUrl(u));

check(
  'PART B.1: contributing members of fresh, in-episode rows yield rescue URLs',
  expectIn.every(u => !!u && graceUrls.has(u)),
  `missing=${expectIn.filter(u => !graceUrls.has(u as string)).join(', ')}`,
);
check(
  'PART B.1: phased-out / out-of-episode / attach / anchor-only / no-date members yield NO rescue URL',
  expectOut.every(u => !u || !graceUrls.has(u)),
  `unexpectedly present=${expectOut.filter(u => u && graceUrls.has(u)).join(', ')}`,
);

// ---------------------------------------------------------------------------
// PART B.2 — selectCandidateNodes (a2) sub-lane: a still-fresh member of a
// missed-pass story (below the priority cap, unique title so no other lane can
// admit it) is rescued ONLY when its URL is in the archive-grace set.
// ---------------------------------------------------------------------------

function node(
  partial: Partial<LaneNode> & { key: string; title: string; priority: number },
): LaneNode {
  return {
    itemType: 'curated',
    itemId: partial.key.split(':')[1] ?? partial.key,
    source: partial.source ?? 'Test Wire',
    url: partial.url ?? `https://example.com/${partial.key}`,
    category: 'general',
    cls: partial.cls ?? 'corroborating',
    label: null,
    role: 'contributing',
    blocked: false,
    ogImageUrl: null,
    publishedAt: new Date(now - 2 * HOUR),
    sourceIdentifier: null,
    factuality: null,
    ownership: [],
    summary: null,
    bullets: null,
    ...partial,
  } as LaneNode;
}

// 150 unique-token filler @ priority 90 — fills + overflows the top-140 cut, so
// any priority-40 row lands firmly in the overflow pool, and the unique tokens
// keep the near-dup and same-event-bucket lanes from admitting it.
function buildFiller(): LaneNode[] {
  const filler: LaneNode[] = [];
  for (let i = 0; i < 150; i++) {
    filler.push(
      node({
        key: `curated:fill-${i}`,
        title: `fillalpha${i} fillbeta${i} fillgamma${i}`,
        priority: 90,
      }),
    );
  }
  return filler;
}

const missedUrl = 'https://missed.example.com/transiently-dropped-story';
const missedNode = node({
  key: 'curated:missed-now',
  title: 'uniquezeta uniqueomega uniquetheta',
  priority: 40,
  url: missedUrl,
});

const graceSet = new Set<string>([normalizeMemberUrl(missedUrl) as string]);
const rescued = selectCandidateNodes([...buildFiller(), missedNode], new Set(), new Set(), graceSet);
const rescuedKeys = new Set(rescued.allNodes.map(n => n.key));
check(
  'PART B.2: a missed-pass member is rescued via its archive-grace URL',
  rescuedKeys.has('curated:missed-now') && rescued.rescuedArchiveGrace === 1,
  `admitted=${rescuedKeys.has('curated:missed-now')}, rescuedArchiveGrace=${rescued.rescuedArchiveGrace}`,
);

// Precision control: with NO matching grace URL, the SAME singleton is not
// admitted — the grace lane only rescues genuine missed-pass members.
const noRescue = selectCandidateNodes([...buildFiller(), missedNode], new Set(), new Set(), new Set());
check(
  'PART B.2: the same singleton is NOT rescued without a matching archive-grace URL',
  !new Set(noRescue.allNodes.map(n => n.key)).has('curated:missed-now') &&
    noRescue.rescuedArchiveGrace === 0,
  `admitted=${new Set(noRescue.allNodes.map(n => n.key)).has('curated:missed-now')}, rescuedArchiveGrace=${noRescue.rescuedArchiveGrace}`,
);

// ---------------------------------------------------------------------------
// PART B.3 — the grace lane is BOUNDED: at most ARCHIVE_GRACE_ADMIT_MAX rescues,
// and the payload never exceeds HARD_NODE_CEILING (the lane is counted INSIDE
// RESCUE_BUDGET, so it adds nothing to the ceiling).
// ---------------------------------------------------------------------------

const manyGraceNodes: LaneNode[] = [];
const manyGraceUrls = new Set<string>();
for (let i = 0; i < 40; i++) {
  const u = `https://missed.example.com/many-${i}`;
  manyGraceNodes.push(
    node({
      key: `curated:many-${i}`,
      title: `manyalpha${i} manybeta${i} manygamma${i}`,
      priority: 40,
      url: u,
    }),
  );
  manyGraceUrls.add(normalizeMemberUrl(u) as string);
}
const bounded = selectCandidateNodes([...buildFiller(), ...manyGraceNodes], new Set(), new Set(), manyGraceUrls);
check(
  'PART B.3: archive-grace rescues are sub-capped at ARCHIVE_GRACE_ADMIT_MAX',
  bounded.rescuedArchiveGrace === ARCHIVE_GRACE_ADMIT_MAX,
  `rescuedArchiveGrace=${bounded.rescuedArchiveGrace} (expected ${ARCHIVE_GRACE_ADMIT_MAX})`,
);
check(
  'PART B.3 (INVARIANT): payload never exceeds HARD_NODE_CEILING with the grace lane active',
  bounded.allNodes.length <= HARD_NODE_CEILING,
  `payload=${bounded.allNodes.length} > ${HARD_NODE_CEILING}`,
);
check(
  'PART B.3 (INVARIANT): no duplicate keys in the payload',
  new Set(bounded.allNodes.map(n => n.key)).size === bounded.allNodes.length,
  `${bounded.allNodes.length - new Set(bounded.allNodes.map(n => n.key)).size} duplicate key(s)`,
);

// ---------------------------------------------------------------------------
console.log(failures === 0 ? '[grace] ALL PASS' : `[grace] ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
