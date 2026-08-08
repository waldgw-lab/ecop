/**
 * Safety test for the feed request-coalescing helper (Task #687).
 *
 * serveCoalescedFeed (server/feedCoalesce.ts) is single-flight for the heavy
 * public feeds (/api/stream, /api/headline-feed, /api/war/feed): while one
 * "leader" compute is in flight, concurrent cache-miss callers await the SAME
 * promise and serve its payload instead of each launching their own recompute.
 *
 * The dangerous edge — reasoned about but previously untested — is a leader
 * compute FAILURE while N waiters are attached. The intended, isolated behavior:
 *
 *   1. A leader FAILURE must NOT be served to the waiters. Waiters catch the
 *      shared rejection and fall through to compute once themselves, so a
 *      transient DB/AI blip on the leader does NOT cascade into a feed-wide 500.
 *   2. The in-flight key is ALWAYS cleared — on both success and error — so a
 *      failure can never wedge the key (the next caller must be able to lead).
 *   3. `x-mcop-no-cache` ALWAYS bypasses coalescing: such a request neither
 *      joins an existing in-flight promise nor registers one, so it always sees
 *      a fresh, uncoalesced compute (the isolation harness depends on this).
 *   4. A successful leader IS shared with its waiters (the whole point) and the
 *      payload is cached so later callers skip compute entirely.
 */
import { createFeedCoalescer } from '../server/feedCoalesce';

let pass = 0;
let fail = 0;
function check(label: string, got: any, want: any) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    console.log(`PASS [${label}]`);
    pass++;
  } else {
    console.log(`FAIL [${label}] expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    fail++;
  }
}

// Minimal Express-Response stub. The coalescer now serves cached/coalesced
// responses as pre-serialized bytes (res.set('ETag') → req.fresh check →
// res.type().send(body)) while the x-mcop-no-cache bypass path still uses
// res.json(payload). The stub captures BOTH:
//   - jsonCalls: the served PAYLOAD (parsed from send() bodies, or the raw
//     res.json argument) — keeps every original assertion meaningful.
//   - sendBodies: raw serialized strings (byte-identity assertions).
//   - jsonOnlyCalls: res.json()-specific count (bypass-path assertions).
//   - headers/statusCode/ended: ETag + 304 assertions.
function makeReq(bypass = false) {
  return { headers: bypass ? { 'x-mcop-no-cache': '1' } : {} } as any;
}
function makeRes() {
  const res: any = {
    jsonCalls: [] as any[],
    sendBodies: [] as string[],
    jsonOnlyCalls: 0,
    headers: {} as Record<string, string>,
    statusCode: 200,
    ended: false,
  };
  res.json = (payload: any) => { res.jsonCalls.push(payload); res.jsonOnlyCalls++; return res; };
  res.set = (name: string, value: string) => { res.headers[name.toLowerCase()] = value; return res; };
  res.type = (_t: string) => res;
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.send = (body: string) => { res.sendBodies.push(body); res.jsonCalls.push(JSON.parse(body)); return res; };
  res.end = () => { res.ended = true; return res; };
  return res;
}
// A controllable compute: resolves/rejects only when the test says so, and
// counts invocations so we can prove coalescing actually collapsed the work.
function deferredCompute() {
  let resolve!: (v: any) => void;
  let reject!: (e: any) => void;
  const gate = new Promise<any>((res, rej) => { resolve = res; reject = rej; });
  let calls = 0;
  const compute = async () => { calls++; return gate; };
  return { compute, resolve, reject, calls: () => calls };
}
const tick = () => new Promise((r) => setImmediate(r));

async function run() {
  // -------------------------------------------------------------------------
  // 1. Leader FAILURE is isolated: waiters recover and DO NOT inherit the error
  // -------------------------------------------------------------------------
  {
    const c = createFeedCoalescer();
    const leader = deferredCompute();

    // Leader starts the compute (cache miss → registers the in-flight promise).
    const resLeader = makeRes();
    const pLeader = c.serveCoalescedFeed(makeReq(), resLeader, 'stream', leader.compute);
    await tick(); // let the leader register its in-flight entry & await compute

    check('leader registered exactly one in-flight key', c._inFlightSize(), 1);

    // A waiter arrives for the SAME key while the leader is still computing.
    // It must NOT start its own compute yet — it awaits the shared promise.
    const waiterCompute = deferredCompute();
    const resWaiter = makeRes();
    const pWaiter = c.serveCoalescedFeed(makeReq(), resWaiter, 'stream', waiterCompute.compute);
    await tick();
    check('waiter did not start its own compute while leader in flight', waiterCompute.calls(), 0);

    // Leader compute FAILS.
    let leaderThrew = false;
    leader.reject(new Error('transient DB blip'));
    try { await pLeader; } catch { leaderThrew = true; }
    check('leader request surfaces its own error (500 for the leader only)', leaderThrew, true);

    // In-flight key must be cleared immediately on failure (no wedge).
    await tick();
    check('in-flight key cleared after leader failure', c._inFlightSize(), 1); // waiter is now leader

    // The waiter fell through and became the new leader — it computes itself.
    check('waiter fell through to compute itself after leader failure', waiterCompute.calls(), 1);

    // Waiter now SUCCEEDS — it must NOT have been served the leader's error.
    waiterCompute.resolve({ ok: true, who: 'waiter' });
    await pWaiter;
    check('waiter served its OWN successful payload, not the leader error',
      resWaiter.jsonCalls, [{ ok: true, who: 'waiter' }]);
    check('leader response never sent a payload (it errored out)', resLeader.jsonCalls, []);
    await tick();
    check('in-flight fully drained after waiter success', c._inFlightSize(), 0);
  }

  // -------------------------------------------------------------------------
  // 2. Multiple waiters on a failing leader ALL recover independently
  // -------------------------------------------------------------------------
  {
    const c = createFeedCoalescer();
    const leader = deferredCompute();
    const resLeader = makeRes();
    const pLeader = c.serveCoalescedFeed(makeReq(), resLeader, 'headline-feed', leader.compute);
    await tick();

    // Three waiters attach to the same in-flight promise.
    const w = [deferredCompute(), deferredCompute(), deferredCompute()];
    const resW = [makeRes(), makeRes(), makeRes()];
    const pW = w.map((x, i) => c.serveCoalescedFeed(makeReq(), resW[i], 'headline-feed', x.compute));
    await tick();
    check('3 waiters attached, none computed yet', w.map((x) => x.calls()), [0, 0, 0]);

    // Leader fails. Exactly ONE waiter should become the next leader; the rest
    // chain-wait on it. No waiter should ever see the leader's rejection served.
    leader.reject(new Error('boom'));
    try { await pLeader; } catch { /* expected */ }
    await tick();

    // Resolve whichever waiter(s) are computing until all three responses land.
    // Each becomes leader in turn (or joins the current in-flight one).
    for (let round = 0; round < 3; round++) {
      for (const x of w) {
        if (x.calls() > 0) x.resolve({ ok: true });
      }
      await tick();
    }
    await Promise.all(pW);

    const allServed = resW.every((r) => r.jsonCalls.length === 1 && r.jsonCalls[0].ok === true);
    check('all 3 waiters recovered with a real payload (no cascaded 500)', allServed, true);
    check('in-flight fully drained after all waiters recover', c._inFlightSize(), 0);
  }

  // -------------------------------------------------------------------------
  // 3. Successful leader IS shared with waiters, and compute runs ONCE
  // -------------------------------------------------------------------------
  {
    const c = createFeedCoalescer();
    const leader = deferredCompute();
    const resLeader = makeRes();
    const pLeader = c.serveCoalescedFeed(makeReq(), resLeader, 'war-feed', leader.compute);
    await tick();

    const waiter = deferredCompute();
    const resWaiter = makeRes();
    const pWaiter = c.serveCoalescedFeed(makeReq(), resWaiter, 'war-feed', waiter.compute);
    await tick();

    leader.resolve({ ok: true, from: 'leader' });
    await Promise.all([pLeader, pWaiter]);

    check('leader served its payload', resLeader.jsonCalls, [{ ok: true, from: 'leader' }]);
    check('waiter served the SAME leader payload (coalesced)', resWaiter.jsonCalls, [{ ok: true, from: 'leader' }]);
    check('waiter compute never ran (work collapsed to one)', waiter.calls(), 0);

    // Serialized-serve invariants (Task #1023): the leader stringifies ONCE and
    // waiters/warm-hits reuse the exact same bytes + ETag.
    check('leader served pre-serialized bytes (send path, not res.json)', resLeader.jsonOnlyCalls, 0);
    check('waiter bytes are byte-identical to leader bytes',
      resWaiter.sendBodies[0] === resLeader.sendBodies[0], true);
    check('leader response carries a weak ETag', /^W\/"/.test(resLeader.headers['etag'] ?? ''), true);
    check('waiter ETag identical to leader ETag', resWaiter.headers['etag'], resLeader.headers['etag']);
    await tick();
    check('in-flight drained after successful coalesced serve', c._inFlightSize(), 0);

    // A later caller hits the warm cache — compute skipped entirely.
    const later = deferredCompute();
    const resLater = makeRes();
    await c.serveCoalescedFeed(makeReq(), resLater, 'war-feed', later.compute);
    check('later caller served from cache', resLater.jsonCalls, [{ ok: true, from: 'leader' }]);
    check('later caller compute never ran (cache hit)', later.calls(), 0);
    check('warm-hit bytes byte-identical to leader bytes',
      resLater.sendBodies[0] === resLeader.sendBodies[0], true);
    check('warm-hit ETag identical to leader ETag', resLater.headers['etag'], resLeader.headers['etag']);
  }

  // -------------------------------------------------------------------------
  // 4. x-mcop-no-cache ALWAYS bypasses coalescing (isolation harness invariant)
  // -------------------------------------------------------------------------
  {
    const c = createFeedCoalescer();
    // A normal leader is in flight for the key...
    const leader = deferredCompute();
    const resLeader = makeRes();
    const pLeader = c.serveCoalescedFeed(makeReq(), resLeader, 'stream', leader.compute);
    await tick();
    check('normal leader registered in-flight', c._inFlightSize(), 1);

    // ...a bypass request for the SAME key must run its OWN compute immediately
    // and must NOT join or register an in-flight promise.
    const bypass = deferredCompute();
    const resBypass = makeRes();
    const pBypass = c.serveCoalescedFeed(makeReq(true), resBypass, 'stream', bypass.compute);
    await tick();
    check('bypass request started its own compute immediately', bypass.calls(), 1);
    check('bypass did NOT add an in-flight entry', c._inFlightSize(), 1); // still just the leader

    bypass.resolve({ ok: true, fresh: true });
    await pBypass;
    check('bypass served its own fresh payload', resBypass.jsonCalls, [{ ok: true, fresh: true }]);
    check('bypass served via res.json (path unchanged for the isolation harness)', resBypass.jsonOnlyCalls, 1);

    // Bypass writes are NOT cached-then-served to others as coalesced; prove a
    // subsequent bypass recomputes rather than reading a cache the bypass wrote.
    const bypass2 = deferredCompute();
    const resBypass2 = makeRes();
    const p2 = c.serveCoalescedFeed(makeReq(true), resBypass2, 'stream', bypass2.compute);
    await tick();
    check('second bypass recomputes (never reads cache)', bypass2.calls(), 1);
    bypass2.resolve({ ok: true, fresh: 2 });
    await p2;

    // Clean up the still-pending normal leader.
    leader.resolve({ ok: true, from: 'leader' });
    await pLeader;
    check('normal leader still resolves & serves after bypass activity', resLeader.jsonCalls, [{ ok: true, from: 'leader' }]);
    await tick();
    check('in-flight drained at end', c._inFlightSize(), 0);
  }

  // -------------------------------------------------------------------------
  // 5. A failed leader does NOT poison the cache (errors are never cached)
  // -------------------------------------------------------------------------
  {
    const c = createFeedCoalescer();
    const leader = deferredCompute();
    const resLeader = makeRes();
    const pLeader = c.serveCoalescedFeed(makeReq(), resLeader, 'stream', leader.compute);
    await tick();
    leader.reject(new Error('leader blew up'));
    try { await pLeader; } catch { /* expected */ }
    await tick();

    // Next caller must recompute (cache was never written on failure).
    const next = deferredCompute();
    const resNext = makeRes();
    const pNext = c.serveCoalescedFeed(makeReq(), resNext, 'stream', next.compute);
    await tick();
    check('next caller recomputes after a failed leader (no poisoned cache)', next.calls(), 1);
    next.resolve({ ok: true, recovered: true });
    await pNext;
    check('next caller served a fresh recovered payload', resNext.jsonCalls, [{ ok: true, recovered: true }]);
  }

  // -------------------------------------------------------------------------
  // 6. Per-MCOP viewer feed coalesces on its viewer key (Task #701)
  //    The custom-MCOP feed (/api/custom-mcops/:slug/feed) now routes its VIEWER
  //    compute through serveCoalescedFeed keyed by `custom-feed:<slug>:viewer`,
  //    so concurrent cache-miss viewers of ONE MCOP collapse to a single heavy
  //    compute, distinct slugs never collide, and x-mcop-no-cache still bypasses.
  // -------------------------------------------------------------------------
  {
    const c = createFeedCoalescer();
    const slugA = 'custom-feed:warfighter:viewer';
    const slugB = 'custom-feed:other:viewer';

    // Two viewers of the SAME MCOP arrive on a cold cache.
    const leaderA = deferredCompute();
    const resLeaderA = makeRes();
    const pLeaderA = c.serveCoalescedFeed(makeReq(), resLeaderA, slugA, leaderA.compute);
    await tick();
    const waiterA = deferredCompute();
    const resWaiterA = makeRes();
    const pWaiterA = c.serveCoalescedFeed(makeReq(), resWaiterA, slugA, waiterA.compute);
    await tick();
    check('same-MCOP viewer waiter did not start its own compute', waiterA.calls(), 0);

    // A viewer of a DIFFERENT MCOP must NOT be coalesced into slug A's compute.
    const leaderB = deferredCompute();
    const resLeaderB = makeRes();
    const pLeaderB = c.serveCoalescedFeed(makeReq(), resLeaderB, slugB, leaderB.compute);
    await tick();
    check('different-MCOP viewer starts its own compute (keys namespaced by slug)', leaderB.calls(), 1);
    check('two distinct in-flight keys (one per MCOP slug)', c._inFlightSize(), 2);

    // A no-cache (isolation harness) viewer of MCOP A bypasses coalescing.
    const bypassA = deferredCompute();
    const resBypassA = makeRes();
    const pBypassA = c.serveCoalescedFeed(makeReq(true), resBypassA, slugA, bypassA.compute);
    await tick();
    check('x-mcop-no-cache viewer runs its own uncoalesced compute', bypassA.calls(), 1);
    check('bypass added no in-flight entry (still two slugs)', c._inFlightSize(), 2);

    // Resolve everything; the same-MCOP waiter must share the leader's payload.
    // Resolve the bypass FIRST so the coalesced leader's cache write lands last
    // (a bypass compute still WRITES the cache — only its READ is bypassed — so
    // resolve order determines the final cached value deterministically).
    bypassA.resolve({ mcop: { slug: 'warfighter' }, fresh: true });
    leaderB.resolve({ mcop: { slug: 'other' }, topStories: ['b'] });
    await tick();
    leaderA.resolve({ mcop: { slug: 'warfighter' }, topStories: ['a'] });
    await Promise.all([pLeaderA, pWaiterA, pLeaderB, pBypassA]);

    check('same-MCOP waiter served the leader payload (work collapsed to one)',
      resWaiterA.jsonCalls, [{ mcop: { slug: 'warfighter' }, topStories: ['a'] }]);
    check('same-MCOP waiter compute never ran', waiterA.calls(), 0);
    check('different-MCOP viewer served its OWN payload',
      resLeaderB.jsonCalls, [{ mcop: { slug: 'other' }, topStories: ['b'] }]);
    check('bypass viewer served its own fresh payload',
      resBypassA.jsonCalls, [{ mcop: { slug: 'warfighter' }, fresh: true }]);
    await tick();
    check('all MCOP in-flight keys drained', c._inFlightSize(), 0);

    // A later same-MCOP viewer now hits the warm viewer cache — no recompute.
    const laterA = deferredCompute();
    const resLaterA = makeRes();
    await c.serveCoalescedFeed(makeReq(), resLaterA, slugA, laterA.compute);
    check('later same-MCOP viewer served from cache', resLaterA.jsonCalls,
      [{ mcop: { slug: 'warfighter' }, topStories: ['a'] }]);
    check('later same-MCOP viewer compute never ran (cache hit)', laterA.calls(), 0);
  }

  // -------------------------------------------------------------------------
  // 7. Conditional GET (If-None-Match) short-circuits to 304 with NO body
  //    (Task #1023). The cached entry's precomputed ETag is set BEFORE the
  //    req.fresh check, so a matching client revalidation costs neither a
  //    compute nor a stringify — res.status(304).end() and nothing else.
  // -------------------------------------------------------------------------
  {
    const c = createFeedCoalescer();
    const leader = deferredCompute();
    const resLeader = makeRes();
    const pLeader = c.serveCoalescedFeed(makeReq(), resLeader, 'stream', leader.compute);
    await tick();
    leader.resolve({ ok: true, big: 'payload' });
    await pLeader;
    const etagValue = resLeader.headers['etag'];
    check('leader response set a weak ETag', /^W\/"/.test(etagValue ?? ''), true);

    // Warm hit with a MATCHING If-None-Match → express marks req.fresh once the
    // response ETag is set; the stub models that with fresh=true.
    const reqFresh = makeReq();
    reqFresh.headers['if-none-match'] = etagValue;
    reqFresh.fresh = true;
    const resFresh = makeRes();
    const freshCompute = deferredCompute();
    await c.serveCoalescedFeed(reqFresh, resFresh, 'stream', freshCompute.compute);
    check('fresh revalidation served 304', resFresh.statusCode, 304);
    check('304 response ended with NO body', { ended: resFresh.ended, bodies: resFresh.sendBodies.length, json: resFresh.jsonOnlyCalls }, { ended: true, bodies: 0, json: 0 });
    check('304 response still carries the same ETag', resFresh.headers['etag'], etagValue);
    check('304 never ran a compute (warm cache)', freshCompute.calls(), 0);

    // A stale/absent If-None-Match still gets the full body.
    const resStale = makeRes();
    const staleCompute = deferredCompute();
    await c.serveCoalescedFeed(makeReq(), resStale, 'stream', staleCompute.compute);
    check('non-conditional warm hit still serves the full body', resStale.jsonCalls, [{ ok: true, big: 'payload' }]);
    check('non-conditional warm hit compute never ran', staleCompute.calls(), 0);
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
