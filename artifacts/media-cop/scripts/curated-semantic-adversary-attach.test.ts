/**
 * Post-formation semantic adversary-angle attach — regression test.
 *
 * GOAL (approved enhancement): surface SEVERAL adversary / state-media angles
 * (RT / TASS / Sputnik / CGTN / Press TV — classified contrast / attach-only) on
 * each formed curated story, matched BY MEANING rather than by literal keyword
 * overlap. The matching itself is the LLM's job; this test pins the PURE,
 * deterministic post-filter (selectSemanticAdversaryAttachments) that turns the
 * model's answer into the attachments actually applied, enforcing every safety
 * bound so a future tweak can't silently re-open them:
 *   - a semantic match with ZERO shared title tokens still attaches (the helper
 *     trusts the model's meaning-match; it does NOT re-impose a token gate);
 *   - an out-of-time-window match is rejected (deterministic same-event guard);
 *   - the per-story cap is enforced (breadth bounded);
 *   - each adversary item attaches at most once;
 *   - "story":0 (= no match) and out-of-range indices are skipped;
 *   - a node the story already carries is not re-added.
 *
 * PURE, deterministic check (no network, no DB, no LLM). Exits non-zero on any
 * failure so it can run as a regression gate.
 *
 * Usage:  npx tsx scripts/curated-semantic-adversary-attach.test.ts
 */

import { selectSemanticAdversaryAttachments } from '../server/curatedCluster';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[semantic-attach] OK   ${name}`);
  } else {
    console.error(`[semantic-attach] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const yes = () => true;
const no = () => false;

// ---------------------------------------------------------------------------
// 1. A semantic match with ZERO shared words still attaches. The helper does
//    NOT re-impose a token gate — that's the whole point of the meaning-match
//    pass (the old token-overlap rescue is what under-surfaced adversary).
// ---------------------------------------------------------------------------
{
  const out = selectSemanticAdversaryAttachments(
    [{ adversary: 1, story: 1 }],
    { storyCount: 2, candidateCount: 3, perStoryCap: 4, withinWindow: yes, alreadyMember: no },
  );
  check(
    'semantic match attaches (no token gate)',
    out.length === 1 && out[0].candidateIdx === 0 && out[0].storyIdx === 0,
    JSON.stringify(out),
  );
}

// ---------------------------------------------------------------------------
// 2. Out-of-time-window match is rejected even though the model asserted it.
// ---------------------------------------------------------------------------
{
  const out = selectSemanticAdversaryAttachments(
    [{ adversary: 1, story: 1 }],
    { storyCount: 2, candidateCount: 3, perStoryCap: 4, withinWindow: no, alreadyMember: no },
  );
  check('out-of-window match rejected', out.length === 0, JSON.stringify(out));
}

// ---------------------------------------------------------------------------
// 3. Per-story cap enforced. Six matches to story 1, cap 4 -> only 4 attach,
//    and they are the FIRST four in `matches` order (deterministic cap).
// ---------------------------------------------------------------------------
{
  const matches = [1, 2, 3, 4, 5, 6].map(a => ({ adversary: a, story: 1 }));
  const out = selectSemanticAdversaryAttachments(matches, {
    storyCount: 1,
    candidateCount: 6,
    perStoryCap: 4,
    withinWindow: yes,
    alreadyMember: no,
  });
  const capped = out.length === 4;
  const firstFour = out.map(o => o.candidateIdx).join(',') === '0,1,2,3';
  check('per-story cap enforced (keeps first 4)', capped && firstFour, JSON.stringify(out));
}

// ---------------------------------------------------------------------------
// 4. Cap is PER story — two stories each get up to the cap independently.
// ---------------------------------------------------------------------------
{
  const matches = [
    { adversary: 1, story: 1 },
    { adversary: 2, story: 1 },
    { adversary: 3, story: 2 },
    { adversary: 4, story: 2 },
    { adversary: 5, story: 2 },
  ];
  const out = selectSemanticAdversaryAttachments(matches, {
    storyCount: 2,
    candidateCount: 5,
    perStoryCap: 2,
    withinWindow: yes,
    alreadyMember: no,
  });
  const s1 = out.filter(o => o.storyIdx === 0).length;
  const s2 = out.filter(o => o.storyIdx === 1).length;
  check('cap applied per story', s1 === 2 && s2 === 2 && out.length === 4, `s1=${s1} s2=${s2}`);
}

// ---------------------------------------------------------------------------
// 5. Each adversary item attaches at most once (a model echoing the same item
//    against two stories must not double-count).
// ---------------------------------------------------------------------------
{
  const out = selectSemanticAdversaryAttachments(
    [
      { adversary: 1, story: 1 },
      { adversary: 1, story: 2 },
    ],
    { storyCount: 2, candidateCount: 2, perStoryCap: 4, withinWindow: yes, alreadyMember: no },
  );
  check('one attach per adversary item', out.length === 1 && out[0].storyIdx === 0, JSON.stringify(out));
}

// ---------------------------------------------------------------------------
// 6. "story":0 means "matches NO story" and is skipped; out-of-range and
//    non-integer indices are skipped too (defensive against model noise).
// ---------------------------------------------------------------------------
{
  const out = selectSemanticAdversaryAttachments(
    [
      { adversary: 1, story: 0 }, // explicit no-match
      { adversary: 2, story: 9 }, // story out of range
      { adversary: 9, story: 1 }, // adversary out of range
      { adversary: NaN as unknown as number, story: 1 },
      { adversary: 3, story: 1 }, // the only valid one
    ],
    { storyCount: 2, candidateCount: 3, perStoryCap: 4, withinWindow: yes, alreadyMember: no },
  );
  check(
    'no-match / out-of-range / NaN skipped',
    out.length === 1 && out[0].candidateIdx === 2 && out[0].storyIdx === 0,
    JSON.stringify(out),
  );
}

// ---------------------------------------------------------------------------
// 7. A node the story already carries is not re-added (dedup belt-and-suspenders
//    on top of the assignedKeys claim).
// ---------------------------------------------------------------------------
{
  const out = selectSemanticAdversaryAttachments(
    [{ adversary: 1, story: 1 }],
    {
      storyCount: 1,
      candidateCount: 2,
      perStoryCap: 4,
      withinWindow: yes,
      alreadyMember: (ci, si) => ci === 0 && si === 0, // already a member
    },
  );
  check('already-member match skipped', out.length === 0, JSON.stringify(out));
}

// ---------------------------------------------------------------------------
// 8. Empty / malformed match list -> attach nothing (fail-closed parity).
// ---------------------------------------------------------------------------
{
  const out = selectSemanticAdversaryAttachments([], {
    storyCount: 3,
    candidateCount: 3,
    perStoryCap: 4,
    withinWindow: yes,
    alreadyMember: no,
  });
  check('empty matches attach nothing', out.length === 0, JSON.stringify(out));
}

if (failures > 0) {
  console.error(`\n[semantic-attach] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\n[semantic-attach] all checks passed');
