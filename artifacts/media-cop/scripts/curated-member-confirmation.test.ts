/**
 * Curated cross-pass member-confirmation hysteresis (Task #645).
 *
 * Borderline additions — the between-passes incremental-attach bridge and the
 * per-pass semantic adversary-attach — are VOLATILE: a member either path adds
 * can vanish again on the very next clustering pass if the recomputation no
 * longer agrees. Showing it immediately and then yanking it a few seconds
 * later ("flapping") is the bug this task fixes. The fix is a confirmation
 * streak: only the two volatile writers ever stamp provisional:true, and a
 * provisional member is displayed only once it has PERSISTED for >= 2
 * consecutive passes (confirmedStreak >= CURATED_MEMBER_CONFIRM_THRESHOLD).
 * Core Phase-A grouped members (the trusted corroborating set that formed the
 * story) are never provisional and are always shown immediately.
 *
 * This pins the PURE, deterministic gate — isConfirmedCuratedMember — used by
 * BOTH curated read paths in server/routes.ts (the embedded top-stories
 * member list that also drives the header sourceCount, and the
 * /api/curated/cluster-members by-clusterId fetch), so header count and body
 * membership can never drift out of sync. No DB / no LLM / no network.
 *
 * Exits non-zero on any violation.  Usage:  tsx scripts/curated-member-confirmation.test.ts
 */
import { isConfirmedCuratedMember, CURATED_MEMBER_CONFIRM_THRESHOLD } from '../server/curatedCluster';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`[confirm] OK   ${name}`);
  } else {
    console.error(`[confirm] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// ===========================================================================
// (1) Core (non-provisional) members are ALWAYS shown, regardless of streak.
//     This is the trusted corroborating set that satisfied the formation gate
//     at cluster-creation time — it must never wait on confirmation.
// ===========================================================================
check(
  '(1) core member (provisional:false) shown at streak 0',
  isConfirmedCuratedMember({ provisional: false, confirmedStreak: 0 }) === true,
);
check(
  '(1) core member with no confirmedStreak field at all is shown',
  isConfirmedCuratedMember({ provisional: false }) === true,
);
check(
  '(1) legacy row with provisional undefined (pre-migration) is shown',
  isConfirmedCuratedMember({}) === true,
);

// ===========================================================================
// (2) A ONE-PASS-ONLY provisional addition (streak === 1, i.e. it just
//     appeared this pass and has not yet survived a second pass) MUST be
//     WITHHELD. This is the exact flapping scenario: the bridge or semantic
//     attach adds a borderline member on pass N; if it is not corroborated on
//     pass N+1 it disappears — so it must never have been shown in pass N.
// ===========================================================================
check(
  '(2) one-pass-only provisional member (streak=1) is WITHHELD',
  isConfirmedCuratedMember({ provisional: true, confirmedStreak: 1 }) === false,
  'expected withheld',
);
check(
  '(2) brand-new provisional member (streak=0, default) is WITHHELD',
  isConfirmedCuratedMember({ provisional: true, confirmedStreak: 0 }) === false,
);
check(
  '(2) provisional member with missing confirmedStreak defaults to withheld',
  isConfirmedCuratedMember({ provisional: true }) === false,
);

// ===========================================================================
// (3) A CROSS-PASS-CONFIRMED provisional member (streak >= threshold, i.e. it
//     persisted across >= 2 consecutive passes) MUST be SHOWN. This proves the
//     hysteresis actually promotes a member once corroborated, rather than
//     withholding it forever.
// ===========================================================================
check(
  `(3) cross-pass-confirmed provisional member (streak=${CURATED_MEMBER_CONFIRM_THRESHOLD}) is SHOWN`,
  isConfirmedCuratedMember({ provisional: true, confirmedStreak: CURATED_MEMBER_CONFIRM_THRESHOLD }) === true,
);
check(
  '(3) provisional member with a streak well past the threshold stays SHOWN',
  isConfirmedCuratedMember({ provisional: true, confirmedStreak: CURATED_MEMBER_CONFIRM_THRESHOLD + 5 }) === true,
);

// ===========================================================================
// (4) Exact boundary: threshold - 1 withheld, threshold shown. Proves the gate
//     is a clean >= comparison, not an off-by-one that either shows one pass
//     too early (flapping survives) or requires one pass too many (real
//     corroborating angles are delayed longer than intended).
// ===========================================================================
check(
  '(4) streak = threshold - 1 is still WITHHELD',
  isConfirmedCuratedMember({ provisional: true, confirmedStreak: CURATED_MEMBER_CONFIRM_THRESHOLD - 1 }) === false,
);
check(
  '(4) streak = threshold is the first SHOWN value',
  isConfirmedCuratedMember({ provisional: true, confirmedStreak: CURATED_MEMBER_CONFIRM_THRESHOLD }) === true,
);

// ===========================================================================
// (5) Simulated multi-pass timeline for a single borderline member, mirroring
//     how curatedCluster.ts / curatedIncrementalAttach.ts stamp confirmedStreak
//     pass-over-pass: it must be invisible while its streak is below
//     threshold and only become visible once confirmed, never toggling back
//     off while its streak keeps climbing (monotonic display once earned).
// ===========================================================================
{
  const passStreaks = [0, 1, 2, 3]; // streak snapshot written at the END of each pass
  const visibility = passStreaks.map((streak) => isConfirmedCuratedMember({ provisional: true, confirmedStreak: streak }));
  check(
    '(5) pass 1 (streak=0) withheld',
    visibility[0] === false,
  );
  check(
    '(5) pass 2 (streak=1) still withheld — matches the one-pass-only bug scenario',
    visibility[1] === false,
  );
  check(
    '(5) pass 3 (streak=2) becomes visible — confirmed by 2 consecutive passes',
    visibility[2] === true,
  );
  check(
    '(5) pass 4 (streak=3) remains visible',
    visibility[3] === true,
  );
  check(
    '(5) once confirmed, visibility never flips back off as the streak grows',
    visibility.slice(2).every((v) => v === true),
  );
}

console.log(`\n[confirm] ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
