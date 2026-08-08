/**
 * Regression gate: bridge-faithful attach recommendation in the scoring-radar
 * payload (Task #923).
 *
 * Asserts that `classifyAttachCandidate` (the pure function the radar payload
 * builder uses) produces the same outcome as `selectAttachClusterId` across
 * four representative cases:
 *
 *   (a) single match        → reason: 'would-auto-attach', matchCount: 1
 *   (b) ≥2 matches          → reason: 'ambiguous',         matchCount: ≥2
 *   (c) zero matches        → reason: 'no-match',          matchCount: 0
 *   (d) thin token set      → reason: 'no-match',          matchCount: 0
 *
 * Also asserts that the `isAdversaryNewsContrast` guard (used to derive
 * 'manual-only' in routes.ts) correctly identifies CPC vs non-CPC contrast.
 *
 * Pure + deterministic — no DB, no network, no AI. Safe to run as a blocking CI gate.
 *
 * Usage: npx tsx scripts/curated-radar-attach-reason.test.ts
 */

import {
  classifyAttachCandidate,
  selectAttachClusterId,
  isAdversaryNewsContrast,
  type AttachCandidate,
  type AttachClusterInfo,
} from '../server/curatedIncrementalAttach';
import { significantTitleTokens } from '../server/curatedCluster';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[attach-reason] OK   ${name}`);
  } else {
    console.error(`[attach-reason] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

// A formed cluster about "Ukraine troop withdrawal talks in Geneva":
const clusterGeneva: AttachClusterInfo = {
  clusterId: 'cluster-geneva',
  repTokens: significantTitleTokens('Ukraine Russia ceasefire talks Geneva diplomats'),
  repPublishedAt: new Date('2025-01-10T12:00:00Z'),
  category: 'Diplomacy & International Law',
  contributingCount: 3,
  contributing: [
    {
      tokens: significantTitleTokens('Ukraine Russia Geneva ceasefire diplomats meet'),
      publishedAt: new Date('2025-01-10T10:00:00Z'),
    },
    {
      tokens: significantTitleTokens('Geneva talks Ukraine Russia truce diplomacy'),
      publishedAt: new Date('2025-01-10T11:00:00Z'),
    },
    {
      tokens: significantTitleTokens('Ukraine Russia peace negotiations Geneva'),
      publishedAt: new Date('2025-01-10T12:30:00Z'),
    },
  ],
};

// A second, unrelated formed cluster about "North Korea missile launch":
const clusterNK: AttachClusterInfo = {
  clusterId: 'cluster-nk',
  repTokens: significantTitleTokens('North Korea launches ballistic missile Japan condemns'),
  repPublishedAt: new Date('2025-01-10T08:00:00Z'),
  category: 'Military & Defense',
  contributingCount: 2,
  contributing: [
    {
      tokens: significantTitleTokens('North Korea missile launch Pacific Japan'),
      publishedAt: new Date('2025-01-10T07:00:00Z'),
    },
    {
      tokens: significantTitleTokens('North Korea ICBM launch US response Seoul'),
      publishedAt: new Date('2025-01-10T08:30:00Z'),
    },
  ],
};

// Candidate that clearly belongs to the Geneva cluster (single match).
const candGeneva: AttachCandidate = {
  key: 'curated:a1',
  tokens: significantTitleTokens('Ukraine Russia Geneva talks ceasefire agreement'),
  publishedAt: new Date('2025-01-10T13:00:00Z'),
  category: 'Diplomacy & International Law',
};

// Candidate that matches BOTH clusters (ambiguous - shares generic war tokens).
// We need a title that matches both clusters enough. Let's craft it carefully:
// Shares "Ukraine" with Geneva and "missile" doesn't appear there — instead,
// use a title that actually overlaps both by having matching tokens to both.
// Geneva tokens: ukraine, russia, ceasefire, talks, geneva, diplomats
// NK tokens: north, korea, launches, ballistic, missile, japan, condemns
// For ambiguity we need one candidate that matches BOTH — this is tricky with
// real token matching. Let's create a second cluster specifically for ambiguity:
const clusterGenevaAlt: AttachClusterInfo = {
  clusterId: 'cluster-geneva-alt',
  repTokens: significantTitleTokens('Ukraine Russia ceasefire talks extended diplomats'),
  repPublishedAt: new Date('2025-01-10T12:00:00Z'),
  category: 'Diplomacy & International Law',
  contributingCount: 2,
  contributing: [
    {
      tokens: significantTitleTokens('Ukraine Russia Geneva ceasefire extended'),
      publishedAt: new Date('2025-01-10T10:00:00Z'),
    },
    {
      tokens: significantTitleTokens('Geneva talks Ukraine Russia truce extended'),
      publishedAt: new Date('2025-01-10T11:00:00Z'),
    },
  ],
};

// Candidate whose title overlaps BOTH clusterGeneva and clusterGenevaAlt
// (they are about the same topic so a matching candidate would hit both).
const candAmbiguous: AttachCandidate = {
  key: 'curated:a2',
  tokens: significantTitleTokens('Ukraine Russia Geneva talks ceasefire diplomats truce'),
  publishedAt: new Date('2025-01-10T13:30:00Z'),
  category: 'Diplomacy & International Law',
};

// Candidate that matches NOTHING (completely unrelated topic).
const candUnrelated: AttachCandidate = {
  key: 'curated:a3',
  tokens: significantTitleTokens('Federal Reserve interest rate decision quarterly review'),
  publishedAt: new Date('2025-01-10T13:00:00Z'),
  category: 'Economics & Trade',
};

// Candidate with too-thin token set (below MIN_CANDIDATE_TOKENS=2).
const candThin: AttachCandidate = {
  key: 'curated:a4',
  tokens: significantTitleTokens('War'), // only one significant token
  publishedAt: new Date('2025-01-10T13:00:00Z'),
  category: null,
};

// ---------------------------------------------------------------------------
// (a) SINGLE MATCH → would-auto-attach
// ---------------------------------------------------------------------------
{
  const clusters = [clusterGeneva, clusterNK];
  const rec = classifyAttachCandidate(candGeneva, clusters);
  const sel = selectAttachClusterId(candGeneva, clusters);
  check(
    '(a) single match reason = would-auto-attach',
    rec.reason === 'would-auto-attach',
    `got: ${rec.reason}`,
  );
  check(
    '(a) single match matchCount = 1',
    rec.matchCount === 1,
    `got: ${rec.matchCount}`,
  );
  check(
    '(a) single match matchedClusterId is defined',
    typeof rec.matchedClusterId === 'string',
    `got: ${rec.matchedClusterId}`,
  );
  // The recommendation must agree with the bridge's own selectAttachClusterId.
  check(
    '(a) agree with selectAttachClusterId: both pick the same cluster',
    rec.matchedClusterId === sel,
    `classifyAttachCandidate chose ${rec.matchedClusterId}, selectAttachClusterId chose ${sel}`,
  );
}

// ---------------------------------------------------------------------------
// (b) ≥2 MATCHES → ambiguous
// Clusters intentionally share near-identical representative tokens so the
// candidate matches both.
// ---------------------------------------------------------------------------
{
  const clusters = [clusterGeneva, clusterGenevaAlt];
  const rec = classifyAttachCandidate(candAmbiguous, clusters);
  const sel = selectAttachClusterId(candAmbiguous, clusters);
  check(
    '(b) ambiguous reason = ambiguous',
    rec.reason === 'ambiguous',
    `got: ${rec.reason}`,
  );
  check(
    '(b) ambiguous matchCount ≥ 2',
    rec.matchCount >= 2,
    `got: ${rec.matchCount}`,
  );
  // The bridge fail-closes on ambiguity (returns null). classifyAttachCandidate
  // should also reflect that — bridge returns null and our reason is ambiguous.
  check(
    '(b) agree with selectAttachClusterId: bridge returns null on ambiguity',
    sel === null,
    `selectAttachClusterId should return null for ambiguous; got: ${sel}`,
  );
  check(
    '(b) matchedClusterId absent on ambiguous',
    rec.matchedClusterId === undefined,
    `should be undefined; got: ${rec.matchedClusterId}`,
  );
}

// ---------------------------------------------------------------------------
// (c) ZERO MATCHES → no-match
// ---------------------------------------------------------------------------
{
  const clusters = [clusterGeneva, clusterNK];
  const rec = classifyAttachCandidate(candUnrelated, clusters);
  const sel = selectAttachClusterId(candUnrelated, clusters);
  check(
    '(c) no-match reason = no-match',
    rec.reason === 'no-match',
    `got: ${rec.reason}`,
  );
  check(
    '(c) no-match matchCount = 0',
    rec.matchCount === 0,
    `got: ${rec.matchCount}`,
  );
  check(
    '(c) agree with selectAttachClusterId: both return null/no-match',
    sel === null,
    `selectAttachClusterId should return null; got: ${sel}`,
  );
}

// ---------------------------------------------------------------------------
// (d) THIN TOKEN SET → no-match (bridge can't match < MIN_CANDIDATE_TOKENS)
// ---------------------------------------------------------------------------
{
  const clusters = [clusterGeneva, clusterNK];
  const rec = classifyAttachCandidate(candThin, clusters);
  const sel = selectAttachClusterId(candThin, clusters);
  check(
    '(d) thin tokens reason = no-match',
    rec.reason === 'no-match',
    `got: ${rec.reason}`,
  );
  check(
    '(d) thin tokens matchCount = 0',
    rec.matchCount === 0,
    `got: ${rec.matchCount}`,
  );
  check(
    '(d) agree with selectAttachClusterId: both return null/no-match for thin',
    sel === null,
    `selectAttachClusterId should return null; got: ${sel}`,
  );
}

// ---------------------------------------------------------------------------
// (e) isAdversaryNewsContrast — manual-only determination
// CPC news-contrast qualifies; non-CPC contrast does not.
// ---------------------------------------------------------------------------
{
  // Adversary state-media CPC contrast (RT, TASS, Sputnik profile).
  const cpsBehavior = { role: 'anchor-only' as const, label: 'contrast' as const };
  const cpcOutlet = { sourceIdentifier: 'news-cpc' };
  check(
    '(e) adversary CPC contrast qualifies (not manual-only)',
    isAdversaryNewsContrast(cpsBehavior, cpcOutlet) === true,
    'expected true',
  );
  // Social CPC does NOT qualify.
  const socialCpcOutlet = { sourceIdentifier: 'social-cpc' };
  check(
    '(e) social CPC contrast does not qualify',
    isAdversaryNewsContrast(cpsBehavior, socialCpcOutlet) === false,
    'expected false',
  );
  // Non-CPC mixed-factuality contrast.
  const nonCpcOutlet = { sourceIdentifier: 'news-trusted' };
  check(
    '(e) non-CPC contrast does not qualify',
    isAdversaryNewsContrast(cpsBehavior, nonCpcOutlet) === false,
    'expected false',
  );
  // Contributing role — never qualifies.
  const contributingBehavior = { role: 'contributing' as const, label: null as any };
  check(
    '(e) contributing role never qualifies',
    isAdversaryNewsContrast(contributingBehavior, cpcOutlet) === false,
    'expected false',
  );
}

// ---------------------------------------------------------------------------
// (f) Category veto — different known categories never match.
// ---------------------------------------------------------------------------
{
  const candEcon: AttachCandidate = {
    key: 'curated:a5',
    tokens: significantTitleTokens('Ukraine Russia Geneva talks ceasefire diplomats'),
    publishedAt: new Date('2025-01-10T13:00:00Z'),
    // Known category that conflicts with the Geneva cluster's Diplomacy category
    // — but actually "Economics & Trade" does conflict with "Diplomacy" so the
    // category veto fires and the match is blocked.
    category: 'Economics & Trade',
  };
  const clusters = [clusterGeneva];
  const rec = classifyAttachCandidate(candEcon, clusters);
  check(
    '(f) category veto blocks match across known-different categories',
    rec.reason === 'no-match',
    `got: ${rec.reason} (category veto should block Diplomacy vs Economics)`,
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n[attach-reason] ${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log('\n[attach-reason] all checks passed.');
  process.exit(0);
}
