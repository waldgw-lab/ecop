// ---------------------------------------------------------------------------
// Gate: serialized feed serving is byte-identical to express res.json
// (Task #1023).
//
// The feed coalescer now caches the SERIALIZED response (body string + weak
// ETag) alongside the payload object, so warm hits, coalesced waiters, and
// 304 revalidations never re-stringify a multi-hundred-KB feed on the single
// prod event loop. That is only safe if the pre-built bytes are EXACTLY what
// express would have produced via res.json(payload):
//   - body === JSON.stringify(payload)  (no `json spaces` app override exists)
//   - etag === etag(body, { weak: true })  (express's own etag default)
// If either drifts (someone adds a json-spaces override, swaps the etag mode,
// or the serializer changes), cached bytes would differ from bypass/fresh
// bytes and client-side If-None-Match revalidation would break silently.
//
// Also proves the prewarm path: prewarmFeed fills the cache AND pre-serializes
// so the first request after a prewarm pays neither compute nor stringify,
// respects the min-age guard, and never stacks onto an in-flight compute.
//
// Exit codes: 0 = pass, 1 = fail (deterministic — no exit 3).
// ---------------------------------------------------------------------------
import generateETag from "etag";
import { createFeedCoalescer, FEED_PREWARM_MIN_AGE_MS } from "../server/feedCoalesce";

let pass = 0;
let fail = 0;
function check(name: string, actual: any, expected: any = true) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS ${name}`);
    pass++;
  } else {
    console.log(`  FAIL ${name}\n    expected: ${e}\n    actual:   ${a}`);
    fail++;
  }
}

function makeReq(bypass = false) {
  return { headers: bypass ? { 'x-mcop-no-cache': '1' } : {} } as any;
}
function makeRes() {
  const res: any = {
    jsonPayloads: [] as any[],
    sendBodies: [] as string[],
    headers: {} as Record<string, string>,
    statusCode: 200,
    ended: false,
  };
  res.json = (payload: any) => { res.jsonPayloads.push(payload); return res; };
  res.set = (name: string, value: string) => { res.headers[name.toLowerCase()] = value; return res; };
  res.type = (_t: string) => res;
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.send = (body: string) => { res.sendBodies.push(body); return res; };
  res.end = () => { res.ended = true; return res; };
  return res;
}

// A realistic feed-shaped payload: nested arrays/objects, unicode, quotes,
// nulls, numbers — the shapes that would expose any serializer divergence.
const PAYLOAD = {
  topStories: [
    { id: 'a1', title: 'Iran–Israel strikes "escalate" — 3 killed', priority: 87.5, imageUrl: null },
    { id: 'b2', title: 'NATO summit: <script>alert(1)</script> & more', tags: ['NATO', 'Europe'], nested: { deep: [1, 2, { three: true }] } },
  ],
  xPosts: [{ handle: '@SecWar', text: 'Ünïcödé — 中文 emoji-free', isRetweet: false }],
  firstAlerts: [],
  count: 3,
};

async function run() {
  console.log('feed-serialized-serve gate');

  // -------------------------------------------------------------------------
  // 1. Leader serve: body === JSON.stringify(payload), etag === express default
  // -------------------------------------------------------------------------
  {
    const c = createFeedCoalescer();
    const res = makeRes();
    await c.serveCoalescedFeed(makeReq(), res, 'stream', async () => PAYLOAD);

    const expectedBody = JSON.stringify(PAYLOAD);
    const expectedETag = generateETag(expectedBody, { weak: true });
    check('exactly one serialized body served', res.sendBodies.length, 1);
    check('body is byte-identical to JSON.stringify(payload) (what res.json sends)',
      res.sendBodies[0] === expectedBody, true);
    check('body parses back to a deep-equal payload', JSON.parse(res.sendBodies[0]), PAYLOAD);
    check('ETag matches etag(body, {weak:true}) — express\'s exact default', res.headers['etag'], expectedETag);
    check('ETag is weak (W/ prefix)', /^W\/"/.test(res.headers['etag']), true);

    // Warm hit reuses the SAME string instance (no re-stringify).
    const res2 = makeRes();
    await c.serveCoalescedFeed(makeReq(), res2, 'stream', async () => { throw new Error('must not compute'); });
    check('warm hit served without compute', res2.sendBodies.length, 1);
    check('warm hit reuses the exact cached string (no re-serialization)',
      res2.sendBodies[0] === res.sendBodies[0], true);

    // getFeedCache still returns the raw OBJECT (data semantics preserved for
    // the non-serialized call sites in routes.ts).
    check('getFeedCache still returns the raw payload object', c.getFeedCache(makeReq(), 'stream'), PAYLOAD);

    // 304 revalidation with matching If-None-Match.
    const reqFresh = makeReq();
    reqFresh.headers['if-none-match'] = expectedETag;
    reqFresh.fresh = true;
    const res304 = makeRes();
    await c.serveCoalescedFeed(reqFresh, res304, 'stream', async () => { throw new Error('must not compute'); });
    check('If-None-Match revalidation → 304 with no body',
      { status: res304.statusCode, ended: res304.ended, bodies: res304.sendBodies.length }, { status: 304, ended: true, bodies: 0 });
  }

  // -------------------------------------------------------------------------
  // 2. Bypass (x-mcop-no-cache) serves via res.json with the SAME payload the
  //    cached path serializes — parity between the two paths.
  // -------------------------------------------------------------------------
  {
    const c = createFeedCoalescer();
    const resCached = makeRes();
    await c.serveCoalescedFeed(makeReq(), resCached, 'headline-feed:18:all', async () => PAYLOAD);
    const resBypass = makeRes();
    await c.serveCoalescedFeed(makeReq(true), resBypass, 'headline-feed:18:all', async () => PAYLOAD);
    check('bypass served via res.json (payload object, not bytes)', resBypass.jsonPayloads.length, 1);
    check('bypass never sent pre-serialized bytes', resBypass.sendBodies.length, 0);
    check('express would serialize the bypass payload to the same bytes',
      JSON.stringify(resBypass.jsonPayloads[0]) === resCached.sendBodies[0], true);
  }

  // -------------------------------------------------------------------------
  // 3. prewarmFeed: fills + pre-serializes; min-age + in-flight guards hold.
  // -------------------------------------------------------------------------
  {
    const c = createFeedCoalescer();
    let computes = 0;
    const compute = async () => { computes++; return PAYLOAD; };

    await c.prewarmFeed('stream', compute);
    check('prewarm ran the compute once', computes, 1);

    // First request after prewarm: warm hit, no compute, correct bytes.
    const res = makeRes();
    await c.serveCoalescedFeed(makeReq(), res, 'stream', compute);
    check('request after prewarm is a warm hit (no compute)', computes, 1);
    check('request after prewarm served the prewarmed bytes',
      res.sendBodies[0] === JSON.stringify(PAYLOAD), true);
    check('prewarmed ETag matches express default',
      res.headers['etag'], generateETag(JSON.stringify(PAYLOAD), { weak: true }));

    // Min-age guard: an immediate re-prewarm is a no-op.
    await c.prewarmFeed('stream', compute);
    check('re-prewarm within min-age is a no-op', computes, 1);
    check('min-age export sane (>0, < cache TTL)', FEED_PREWARM_MIN_AGE_MS > 0 && FEED_PREWARM_MIN_AGE_MS < 25_000, true);

    // In-flight guard: prewarm while a leader compute is running is a no-op.
    let release!: (v: any) => void;
    const gate = new Promise((r) => { release = r; });
    let slowComputes = 0;
    const slow = async () => { slowComputes++; await gate; return PAYLOAD; };
    const resLeader = makeRes();
    const pLeader = c.serveCoalescedFeed(makeReq(), resLeader, 'war-feed', slow);
    await new Promise((r) => setImmediate(r));
    await c.prewarmFeed('war-feed', slow);
    check('prewarm during an in-flight compute is a no-op', slowComputes, 1);
    release(null);
    await pLeader;

    // Prewarm failure is swallowed (best-effort) and does not poison the key.
    await c.prewarmFeed('failing-key', async () => { throw new Error('boom'); });
    const resAfterFail = makeRes();
    await c.serveCoalescedFeed(makeReq(), resAfterFail, 'failing-key', async () => PAYLOAD);
    check('key still serves normally after a failed prewarm', resAfterFail.sendBodies.length, 1);
    check('in-flight map drained after failed prewarm', c._inFlightSize(), 0);
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
