/**
 * Curated anchor-aware event-identity split backstop regression (attach-vs-spawn).
 *
 * Phase 2 of the better attach-vs-spawn work. AFTER synthesis has produced a
 * formed Curated story's neutral anchor (headline + corroborated facts), the
 * backstop audits whether any member's OVERARCHING TOPIC is a genuinely DIFFERENT
 * event from that anchor and, if so, RELEASES it back to a stand-alone card (the
 * next pass's grouping re-clusters it with its true peers). There is NO in-pass
 * re-formation.
 *
 * `applyAnchorEventSplitDecisions` is the pure, deterministic core of that
 * backstop: given each member's behavior class, distinct-publisher key, and
 * per-member event-identity decision, it RELEASES only the members judged a
 * genuinely DIFFERENT event — and ONLY when the surviving cluster STILL satisfies
 * the formation gate (>= 2 corroborating across >= 2 distinct publishers).
 * Otherwise it VETOES the whole release so the backstop can never dissolve a real
 * story or strand it below the gate.
 *
 * This pins the contract WITHOUT the LLM (no network / DB / live AI), so it can
 * run as a regression gate. Scenarios covered:
 *   (a) developing process (all same_event_attach/contrast) -> nothing released;
 *   (b) one genuinely unrelated event amid a healthy cluster -> released;
 *   (c) adversary SPIN of the same event (same_event_contrast) -> kept;
 *   (d) over-split that would drop kept set below the gate -> VETOED, nothing
 *       released (cluster left intact);
 *   (e) split that would strand the kept set on a SINGLE publisher -> VETOED;
 *   (f) empty membership -> no-op.
 *
 * Exits non-zero on any violation.
 *
 * Usage:  tsx scripts/curated-anchor-split.test.ts
 */

import {
  applyAnchorEventSplitDecisions,
  resolveAnchorSplitCommit,
  type AnchorSplitMemberInput,
} from '../server/curatedCluster';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[anchor-split] OK   ${name}`);
  } else {
    console.error(`[anchor-split] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// (a) DEVELOPING PROCESS — one US-Iran deal story. Every member is the SAME
// overarching event (sanctions relief, inspector access, threats all belong to
// the same deal), so synthesis labels them same_event_attach / same_event_contrast.
// NOTHING is different_event_split -> the backstop releases nothing.
// ---------------------------------------------------------------------------
{
  const members: AnchorSplitMemberInput[] = [
    { key: 'main:1', cls: 'corroborating', publisherKey: 'reuters.com', decision: 'same_event_attach' },
    { key: 'main:2', cls: 'corroborating', publisherKey: 'apnews.com', decision: 'same_event_attach' },
    { key: 'main:3', cls: 'corroborating', publisherKey: 'bbc.com', decision: 'same_event_attach' },
    { key: 'main:4', cls: 'attach', publisherKey: 'presstv.ir', decision: 'same_event_contrast' },
  ];
  const r = applyAnchorEventSplitDecisions(members);
  check(
    '(a) developing process — nothing released, not vetoed',
    r.changed === false && r.releasedKeys.length === 0 && r.vetoed === false,
    JSON.stringify(r),
  );
}

// ---------------------------------------------------------------------------
// (b) ONE GENUINELY UNRELATED EVENT amid a healthy cluster. A China-Taiwan item
// got folded into the US-Iran deal cluster. Releasing it still leaves 3
// corroborating members across 3 distinct publishers -> the cluster STILL forms,
// so the foreign member IS released.
// ---------------------------------------------------------------------------
{
  const members: AnchorSplitMemberInput[] = [
    { key: 'main:1', cls: 'corroborating', publisherKey: 'reuters.com', decision: 'same_event_attach' },
    { key: 'main:2', cls: 'corroborating', publisherKey: 'apnews.com', decision: 'same_event_attach' },
    { key: 'main:3', cls: 'corroborating', publisherKey: 'bbc.com', decision: 'same_event_attach' },
    { key: 'main:99', cls: 'corroborating', publisherKey: 'globaltimes.cn', decision: 'different_event_split' },
  ];
  const r = applyAnchorEventSplitDecisions(members);
  check(
    '(b) unrelated event released, kept set still forms',
    r.changed === true &&
      r.vetoed === false &&
      r.releasedKeys.length === 1 &&
      r.releasedKeys[0] === 'main:99',
    JSON.stringify(r),
  );
}

// ---------------------------------------------------------------------------
// (c) ADVERSARY SPIN of the same event. State-media alarmist framing of the SAME
// deal is same_event_contrast, NEVER different_event_split -> kept (no release).
// ---------------------------------------------------------------------------
{
  const members: AnchorSplitMemberInput[] = [
    { key: 'main:1', cls: 'corroborating', publisherKey: 'reuters.com', decision: 'same_event_attach' },
    { key: 'main:2', cls: 'corroborating', publisherKey: 'apnews.com', decision: 'same_event_attach' },
    { key: 'main:3', cls: 'corroborating', publisherKey: 'bbc.com', decision: 'same_event_attach' },
    { key: 'main:4', cls: 'attach', publisherKey: 'tass.com', decision: 'same_event_contrast' },
    { key: 'main:5', cls: 'attach', publisherKey: 'rt.com', decision: 'same_event_contrast' },
  ];
  const r = applyAnchorEventSplitDecisions(members);
  check(
    '(c) adversary spin kept (contrast, never split)',
    r.changed === false && r.releasedKeys.length === 0 && r.vetoed === false,
    JSON.stringify(r),
  );
}

// ---------------------------------------------------------------------------
// (d) OVER-SPLIT VETO. The model (wrongly) marks most members as different events
// such that releasing them would leave < 2 corroborating members. The backstop
// must VETO the entire release and leave the cluster exactly as synthesis formed
// it — it can never dissolve a cluster.
// ---------------------------------------------------------------------------
{
  const members: AnchorSplitMemberInput[] = [
    { key: 'main:1', cls: 'corroborating', publisherKey: 'reuters.com', decision: 'same_event_attach' },
    { key: 'main:2', cls: 'corroborating', publisherKey: 'apnews.com', decision: 'different_event_split' },
    { key: 'main:3', cls: 'corroborating', publisherKey: 'bbc.com', decision: 'different_event_split' },
  ];
  const r = applyAnchorEventSplitDecisions(members);
  check(
    '(d) over-split VETOED — nothing released, cluster intact',
    r.changed === false && r.releasedKeys.length === 0 && r.vetoed === true,
    JSON.stringify(r),
  );
}

// ---------------------------------------------------------------------------
// (e) SINGLE-PUBLISHER STRAND VETO. After release, 2 corroborating members would
// remain but they share ONE publisher (same wire syndicated twice). The distinct-
// publisher gate is not met -> VETO (mirrors formation: breadth, not raw count).
// ---------------------------------------------------------------------------
{
  const members: AnchorSplitMemberInput[] = [
    { key: 'main:1', cls: 'corroborating', publisherKey: 'reuters.com', decision: 'same_event_attach' },
    { key: 'main:2', cls: 'corroborating', publisherKey: 'reuters.com', decision: 'same_event_attach' },
    { key: 'main:3', cls: 'corroborating', publisherKey: 'apnews.com', decision: 'different_event_split' },
  ];
  const r = applyAnchorEventSplitDecisions(members);
  check(
    '(e) single-publisher kept set VETOED',
    r.changed === false && r.releasedKeys.length === 0 && r.vetoed === true,
    JSON.stringify(r),
  );
}

// ---------------------------------------------------------------------------
// (f) EMPTY membership -> no-op (no crash, nothing released, not vetoed).
// ---------------------------------------------------------------------------
{
  const r = applyAnchorEventSplitDecisions([]);
  check(
    '(f) empty membership no-op',
    r.changed === false && r.releasedKeys.length === 0 && r.vetoed === false,
    JSON.stringify(r),
  );
}

// ---------------------------------------------------------------------------
// (g) MULTIPLE genuinely-different events released at once, kept set still forms.
// Two foreign items released; 3 corroborating across 3 publishers remain.
// ---------------------------------------------------------------------------
{
  const members: AnchorSplitMemberInput[] = [
    { key: 'main:1', cls: 'corroborating', publisherKey: 'reuters.com', decision: 'same_event_attach' },
    { key: 'main:2', cls: 'corroborating', publisherKey: 'apnews.com', decision: 'same_event_attach' },
    { key: 'main:3', cls: 'corroborating', publisherKey: 'bbc.com', decision: 'uncertain_keep' },
    { key: 'main:8', cls: 'corroborating', publisherKey: 'globaltimes.cn', decision: 'different_event_split' },
    { key: 'main:9', cls: 'attach', publisherKey: 'xinhua.com', decision: 'different_event_split' },
  ];
  const r = applyAnchorEventSplitDecisions(members);
  check(
    '(g) two foreign events released, kept set forms',
    r.changed === true &&
      r.vetoed === false &&
      r.releasedKeys.length === 2 &&
      r.releasedKeys.includes('main:8') &&
      r.releasedKeys.includes('main:9'),
    JSON.stringify(r),
  );
}

// ---------------------------------------------------------------------------
// COMMIT-GATING contract (resolveAnchorSplitCommit). The release math above only
// DECIDES which members are different events; the backstop may only COMMIT that
// release after the shrunken story is re-synthesized AND persisted. FAIL-OPEN: if
// re-synthesis returns null or the persist throws, NOTHING is released (a member
// is never dropped while a stale synthesis still describes the larger cluster).
// ---------------------------------------------------------------------------

// (h) RE-SYNTHESIS FAILED (returned null / persist threw) -> release NOTHING and
// touch no dissolved verdict. This is the regression for the fail-open defect:
// previously the release was committed before re-synthesis was proven to succeed.
{
  const c = resolveAnchorSplitCommit({
    releasedKeys: ['main:99'],
    resynthPersisted: false,
    corroborated: null,
    signature: 'sig-abc',
  });
  check(
    '(h) re-synth failed -> nothing released, no dissolved delta',
    c.commitReleased.length === 0 && c.dissolvedAdd === null && c.dissolvedRemove === null,
    JSON.stringify(c),
  );
}

// (h2) OVERSIZED + re-synth failed -> STILL release (mega-cluster resilience), but
// touch no dissolved verdict (no fresh corroboration read in the degraded path).
// This is the fix for the mega-cluster trap: a "dumping-ground" cluster must be
// able to shed classifier-flagged different-event members even when synthesis is
// unavailable (e.g. an AI-provider stall), or it absorbs unrelated info forever.
{
  const c = resolveAnchorSplitCommit({
    releasedKeys: ['main:99', 'main:100'],
    resynthPersisted: false,
    corroborated: null,
    signature: 'sig-abc',
    oversized: true,
  });
  check(
    '(h2) oversized + re-synth failed -> released anyway, no dissolved delta',
    c.commitReleased.length === 2 && c.dissolvedAdd === null && c.dissolvedRemove === null,
    JSON.stringify(c),
  );
}

// (h3) OVERSIZED but nothing to release -> still a no-op (the oversized path must
// never invent a release out of an empty set).
{
  const c = resolveAnchorSplitCommit({
    releasedKeys: [],
    resynthPersisted: false,
    corroborated: null,
    signature: 'sig-abc',
    oversized: true,
  });
  check(
    '(h3) oversized + empty release -> no-op',
    c.commitReleased.length === 0 && c.dissolvedAdd === null && c.dissolvedRemove === null,
    JSON.stringify(c),
  );
}

// (i) RE-SYNTHESIS PERSISTED + shrunken set STILL corroborated -> commit the
// release and UN-dissolve (story stays a valid Top Story with a fresh anchor).
{
  const c = resolveAnchorSplitCommit({
    releasedKeys: ['main:8', 'main:9'],
    resynthPersisted: true,
    corroborated: true,
    signature: 'sig-abc',
  });
  check(
    '(i) re-synth persisted + corroborated -> released, un-dissolved',
    c.commitReleased.length === 2 &&
      c.dissolvedAdd === null &&
      c.dissolvedRemove === 'sig-abc',
    JSON.stringify(c),
  );
}

// (j) RE-SYNTHESIS PERSISTED but shrinking REVEALED a false merge (corroborated
// === false) -> commit the release AND add the signature to the dissolved set.
// This defers to the EXISTING corroboration quality gate on fresh content; the
// release math itself never dissolves (see veto cases d/e).
{
  const c = resolveAnchorSplitCommit({
    releasedKeys: ['main:8'],
    resynthPersisted: true,
    corroborated: false,
    signature: 'sig-xyz',
  });
  check(
    '(j) re-synth persisted + false-merge -> released, dissolved',
    c.commitReleased.length === 1 &&
      c.dissolvedAdd === 'sig-xyz' &&
      c.dissolvedRemove === null,
    JSON.stringify(c),
  );
}

// (k) PERSISTED but nothing to release -> no-op (defensive; the caller already
// guards rel.length === 0, but the commit gate must never invent a release).
{
  const c = resolveAnchorSplitCommit({
    releasedKeys: [],
    resynthPersisted: true,
    corroborated: true,
    signature: 'sig-abc',
  });
  check(
    '(k) persisted but empty release -> no-op',
    c.commitReleased.length === 0 && c.dissolvedAdd === null && c.dissolvedRemove === null,
    JSON.stringify(c),
  );
}

if (failures > 0) {
  console.error(`\n[anchor-split] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\n[anchor-split] all checks passed');
