/**
 * Gate: public-feed-strip (Task #898)
 *
 * Static leak guard for BRAND-NEW public feed endpoints. Task #780 stripped
 * curated-lane/internal article fields (attributedClaims, contentKind,
 * fullText) from every EXISTING public feed that spreads a raw
 * getPrimaryFeed row, and the isolation harness Phase 8 guards that FIXED
 * list of surfaces. But that guard is surface-enumerated: a future endpoint
 * added to server/routes.ts that spreads a raw feed row (`...h`) would leak
 * the same fields and never be tested.
 *
 * This gate closes the hole statically:
 *   1. Split server/routes.ts into blocks at each route registration
 *      (`app.<method>(`) or top-level `const <name> = async` helper.
 *   2. For each block that calls `storage.getPrimaryFeed(`, taint-track the
 *      feed variable (including Promise.all destructuring and derived
 *      consts) down to per-row iteration variables (.map/.forEach/for-of).
 *   3. FAIL if a tainted row variable is OBJECT-spread (`{ ...h }`) into a
 *      payload without first passing through stripInternalArticleFields.
 *      (Array spreads `[...rows]` and explicit field projections
 *      `{ id: h.id, ... }` are safe and never flagged.)
 *
 * False-positive safety:
 *   - Blocks whose route registration includes a curated gate
 *     (requireCuratedView / requireCuratedAccess / requireCuratedEditor) are
 *     exempt — the curated lane is ALLOWED to serialize these fields.
 *   - An explicit allowlist annotation `// feed-strip-exempt: <reason>`
 *     anywhere in the block exempts it (for deliberate, reviewed cases).
 *
 * Vacuous-pass protection (harness-reliability convention):
 *   - Sanity asserts the analyzer still SEES the known strip sites and feed
 *     call sites in the real routes.ts (if refactoring renames the helper or
 *     the storage method, this gate fails loudly instead of silently
 *     analyzing nothing).
 *   - A built-in synthetic self-test feeds the analyzer a known-leaking
 *     route and a known-safe route; the gate fails if the analyzer stops
 *     flagging the leak or starts flagging the safe pattern.
 *
 * Exit codes: 0 = pass, 1 = fail. Purely static + deterministic (no exit 3).
 */

import * as fs from 'fs';
import * as path from 'path';

const STRIP_FN = 'stripInternalArticleFields';
const FEED_CALL = /storage\.getPrimaryFeed\s*\(/;
const CURATED_GATES = /require(?:CuratedView|CuratedAccess|CuratedEditor)/;
const EXEMPT_ANNOTATION = /feed-strip-exempt:/;

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error(`FAIL: ${msg}`);
};
const ok = (msg: string) => console.log(`ok: ${msg}`);

// ---------------------------------------------------------------------------
// Lightweight scanner: walks code once, tracking string/comment/template
// state and a bracket stack, and reports every `...ident` spread with the
// kind of enclosing bracket (`{` = object spread — the dangerous one).
// ---------------------------------------------------------------------------
interface SpreadSite {
  index: number;
  line: number;
  target: string; // e.g. "h" or "x.h"
  objectSpread: boolean;
}

function findSpreads(code: string): SpreadSite[] {
  const sites: SpreadSite[] = [];
  const stack: string[] = [];
  let i = 0;
  let line = 1;
  type Mode = 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template';
  const modeStack: Mode[] = ['code'];
  const mode = () => modeStack[modeStack.length - 1];

  while (i < code.length) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '\n') line++;

    const m = mode();
    if (m === 'line-comment') {
      if (c === '\n') modeStack.pop();
      i++;
      continue;
    }
    if (m === 'block-comment') {
      if (c === '*' && next === '/') { modeStack.pop(); i += 2; continue; }
      i++;
      continue;
    }
    if (m === 'single' || m === 'double') {
      if (c === '\\') { i += 2; continue; }
      if ((m === 'single' && c === "'") || (m === 'double' && c === '"')) modeStack.pop();
      i++;
      continue;
    }
    if (m === 'template') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { modeStack.pop(); i++; continue; }
      if (c === '$' && next === '{') { modeStack.push('code'); stack.push('${'); i += 2; continue; }
      i++;
      continue;
    }

    // mode === 'code'
    if (c === '/' && next === '/') { modeStack.push('line-comment'); i += 2; continue; }
    if (c === '/' && next === '*') { modeStack.push('block-comment'); i += 2; continue; }
    if (c === "'") { modeStack.push('single'); i++; continue; }
    if (c === '"') { modeStack.push('double'); i++; continue; }
    if (c === '`') { modeStack.push('template'); i++; continue; }
    if (c === '{' || c === '[' || c === '(') { stack.push(c); i++; continue; }
    if (c === '}' || c === ']' || c === ')') {
      const top = stack[stack.length - 1];
      if (c === '}' && top === '${') {
        stack.pop();
        modeStack.pop(); // back into the template literal
        i++;
        continue;
      }
      stack.pop();
      i++;
      continue;
    }
    if (c === '.' && next === '.' && code[i + 2] === '.') {
      const rest = code.slice(i + 3, i + 120);
      const mm = /^\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/.exec(rest);
      if (mm) {
        // nearest enclosing REAL bracket (skip template-interp markers)
        let top: string | undefined;
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s] !== '${') { top = stack[s]; break; }
        }
        sites.push({ index: i, line, target: mm[1], objectSpread: top === '{' });
      }
      i += 3;
      continue;
    }
    i++;
  }
  return sites;
}

// ---------------------------------------------------------------------------
// Split a routes file into blocks. A block starts at a route registration or
// a top-level (2-space indented) `const <name> = async` helper inside
// registerRoutes. Everything until the next block start belongs to it.
// ---------------------------------------------------------------------------
interface Block {
  header: string;   // first line (route registration / helper decl)
  startLine: number; // 1-based
  code: string;
}

function splitBlocks(source: string): Block[] {
  const lines = source.split('\n');
  const startRe = /^ {0,2}(?:app\.(?:get|post|put|patch|delete|use)\s*\(|(?:export\s+)?const\s+\w+\s*=\s*async\b|(?:export\s+)?async\s+function\s+\w+)/;
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) starts.push(i);
  }
  const blocks: Block[] = [];
  for (let b = 0; b < starts.length; b++) {
    const from = starts[b];
    const to = b + 1 < starts.length ? starts[b + 1] : lines.length;
    blocks.push({
      header: lines[from],
      startLine: from + 1,
      code: lines.slice(from, to).join('\n'),
    });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Given a block's code, find the variable names bound to getPrimaryFeed
// results (direct await or Promise.all destructuring).
// ---------------------------------------------------------------------------
function findFeedVars(code: string): string[] {
  const vars: string[] = [];

  // const feed = await storage.getPrimaryFeed(...)
  for (const m of code.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+storage\.getPrimaryFeed\s*\(/g)) {
    vars.push(m[1]);
  }

  // const [a, b, c] = await Promise.all([ ...storage.getPrimaryFeed(...)... ])
  for (const m of code.matchAll(/const\s*\[([^\]]*)\]\s*=\s*await\s+Promise\.all\s*\(\s*\[/g)) {
    const names = m[1].split(',').map(s => s.trim());
    // Walk the array body, splitting on top-level commas, to find which
    // element index contains the getPrimaryFeed call.
    const bodyStart = m.index! + m[0].length;
    let depth = 1; // we are inside the outer `[`
    let elem = '';
    let idx = 0;
    for (let i = bodyStart; i < code.length && depth > 0; i++) {
      const c = code[i];
      if (c === '[' || c === '(' || c === '{') depth++;
      else if (c === ']' || c === ')' || c === '}') {
        depth--;
        if (depth === 0) {
          if (FEED_CALL.test(elem) && names[idx]) vars.push(names[idx]);
          break;
        }
      }
      if (depth === 1 && c === ',') {
        if (FEED_CALL.test(elem) && names[idx]) vars.push(names[idx]);
        elem = '';
        idx++;
        continue;
      }
      elem += c;
    }
  }
  return Array.from(new Set(vars));
}

// ---------------------------------------------------------------------------
// Analyze one block: returns violation messages (empty = clean).
// ---------------------------------------------------------------------------
function analyzeBlock(block: Block): string[] {
  const { code } = block;

  // Tainted ARRAY variables (hold feed rows).
  const taintedArrays = new Set<string>(findFeedVars(code));
  if (taintedArrays.size === 0) {
    // getPrimaryFeed referenced but result not captured in a recognizable
    // form — fail closed so a novel binding style gets a human look.
    return [
      `block at line ${block.startLine} calls storage.getPrimaryFeed but the ` +
      `gate could not identify the result variable (unrecognized binding); ` +
      `either use "const x = await storage.getPrimaryFeed(...)" / Promise.all ` +
      `destructuring, or annotate with "// feed-strip-exempt: <reason>".`,
    ];
  }

  // Propagate taint through derived consts: const Y = <tainted><chain>
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of code.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*\(?\s*(?:[^=;\n]*?[?:]\s*)?([A-Za-z_$][\w$]*)\s*[\n)]?\s*[.[\n;]/g)) {
      const [, lhs, rhs] = m;
      if (taintedArrays.has(rhs) && !taintedArrays.has(lhs)) {
        taintedArrays.add(lhs);
        changed = true;
      }
    }
  }

  // Tainted ROW (element) variables: params of iteration over tainted arrays.
  // Precise chain-walk from each tainted identifier: only method calls in the
  // SAME expression chain (feed.sort(...).slice(...).map(h => ...)) count, so
  // an unrelated `.map(p => ...)` later in the statement is never mis-tainted.
  const taintedRows = new Set<string>();
  for (const arr of taintedArrays) {
    const occRe = new RegExp(`\\b${arr}\\b`, 'g');
    for (const occ of code.matchAll(occRe)) {
      let i = occ.index! + arr.length;
      // Allow closing parens right after the identifier — covers
      // `(cond ? [] : feed).map(h => ...)` ternary wrappers.
      let guard = 0;
      while (i < code.length && guard++ < 500) {
        while (i < code.length && /\s/.test(code[i])) i++;
        if (code[i] === ')') { i++; continue; }
        if (code[i] !== '.') break;
        i++;
        const mm = /^([A-Za-z_$][\w$]*)/.exec(code.slice(i, i + 40));
        if (!mm) break;
        const method = mm[1];
        i += method.length;
        while (i < code.length && /\s/.test(code[i])) i++;
        if (code[i] !== '(') break; // property access ends the chain walk
        if (method === 'map' || method === 'forEach' || method === 'flatMap') {
          const pm = /^\(\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)/.exec(code.slice(i, i + 80));
          if (pm) taintedRows.add(pm[1]);
        }
        // Skip the balanced argument list, then continue the chain.
        let depth = 0;
        while (i < code.length) {
          const c = code[i];
          if (c === '(') depth++;
          else if (c === ')') { depth--; if (depth === 0) { i++; break; } }
          i++;
        }
      }
    }
    const forOfRe = new RegExp(`for\\s*\\(\\s*(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s+of\\s+${arr}\\b`, 'g');
    for (const m of code.matchAll(forOfRe)) taintedRows.add(m[1]);
  }

  // Clean aliases: const C = stripInternalArticleFields(row)
  const cleanVars = new Set<string>();
  for (const m of code.matchAll(new RegExp(`const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${STRIP_FN}\\s*\\(\\s*([A-Za-z_$][\\w$]*)`, 'g'))) {
    cleanVars.add(m[1]);
  }
  // Tainted aliases: const C = row  (plain alias, no strip)
  for (const m of code.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*(?:as\s+\w+)?\s*;/g)) {
    if (taintedRows.has(m[2]) && !cleanVars.has(m[1])) taintedRows.add(m[1]);
  }

  const violations: string[] = [];
  for (const spread of findSpreads(code)) {
    if (!spread.objectSpread) continue; // [...rows] array spreads are fine
    const base = spread.target.split('.')[0];
    if (cleanVars.has(base)) continue;
    if (taintedRows.has(base) || taintedArrays.has(spread.target)) {
      violations.push(
        `line ~${block.startLine + spread.line - 1}: object-spread "...${spread.target}" of a ` +
        `getPrimaryFeed row without ${STRIP_FN} — internal fields ` +
        `(attributedClaims, contentKind, fullText) would leak into this response. ` +
        `Route the row through ${STRIP_FN}(...) before spreading, or (if this ` +
        `surface is deliberately allowed) add "// feed-strip-exempt: <reason>".`,
      );
    }
  }
  return violations;
}

function analyzeSource(source: string): { analyzed: number; exempt: number; violations: string[] } {
  const violations: string[] = [];
  let analyzed = 0;
  let exempt = 0;
  for (const block of splitBlocks(source)) {
    if (!FEED_CALL.test(block.code)) continue;
    analyzed++;
    // Curated-gated handlers may serialize internal fields by design.
    if (CURATED_GATES.test(block.header)) { exempt++; continue; }
    if (EXEMPT_ANNOTATION.test(block.code)) { exempt++; continue; }
    violations.push(...analyzeBlock(block).map(v => `[${block.header.trim().slice(0, 80)}] ${v}`));
  }
  return { analyzed, exempt, violations };
}

// ---------------------------------------------------------------------------
// 1) Synthetic self-test: the analyzer must flag a known leak and pass a
//    known-safe route (guards against the analyzer rotting into a no-op).
// ---------------------------------------------------------------------------
function selfTest() {
  const leaking = `
  app.get("/api/new-shiny-feed", guard, async (req, res) => {
    const feed = await storage.getPrimaryFeed(12);
    res.json(feed.map(h => ({ ...h, extra: 1 })));
  });
`;
  const r1 = analyzeSource(leaking);
  if (r1.violations.length === 1) ok('self-test: direct raw spread is flagged');
  else fail(`self-test: expected 1 violation for raw spread, got ${r1.violations.length}`);

  const leakingChained = `
  app.get("/api/new-feed-2", guard, async (req, res) => {
    const [rows, other] = await Promise.all([
      storage.getPrimaryFeed(18, 20),
      storage.getOther(),
    ]);
    const sorted = rows.sort((a, b) => b.p - a.p).slice(0, 8);
    res.json(sorted.map(item => ({ ...item, imageUrl: item.ogImageUrl })));
  });
`;
  const r2 = analyzeSource(leakingChained);
  if (r2.violations.length === 1) ok('self-test: Promise.all + chained spread is flagged');
  else fail(`self-test: expected 1 violation for chained spread, got ${r2.violations.length}`);

  const safe = `
  app.get("/api/safe-feed", guard, async (req, res) => {
    const feed = await storage.getPrimaryFeed(12);
    res.json(feed.map(h => {
      const rest = stripInternalArticleFields(h as any);
      return { ...rest, imageUrl: h.ogImageUrl };
    }));
  });
  app.get("/api/safe-projection", guard, async (req, res) => {
    const feed = await storage.getPrimaryFeed(12);
    const others = [{ a: 1 }];
    res.json({ items: feed.map(h => ({ id: h.id, title: h.title })), merged: [...feed, ...others] });
  });
  app.get("/api/curated/thing", requireCuratedView, async (req, res) => {
    const feed = await storage.getPrimaryFeed(12);
    res.json(feed.map(h => ({ ...h })));
  });
`;
  const r3 = analyzeSource(safe);
  if (r3.violations.length === 0) ok('self-test: stripped spread / projection / curated-gated all pass');
  else fail(`self-test: expected 0 violations on safe source, got:\n  ${r3.violations.join('\n  ')}`);
}

// ---------------------------------------------------------------------------
// 2) Real scan of server/routes.ts
// ---------------------------------------------------------------------------
function realScan() {
  const routesPath = path.resolve(process.cwd(), 'server/routes.ts');
  const source = fs.readFileSync(routesPath, 'utf8');

  // Sanity: the helper and the storage method must still exist under these
  // names, or this gate is analyzing nothing (vacuous-pass guard).
  if (!source.includes(`const ${STRIP_FN}`)) {
    fail(`sanity: ${STRIP_FN} helper not found in server/routes.ts — if it was renamed/moved, update this gate.`);
    return;
  }
  const feedCallCount = (source.match(/storage\.getPrimaryFeed\s*\(/g) || []).length;
  if (feedCallCount < 3) {
    fail(`sanity: expected >=3 storage.getPrimaryFeed call sites in server/routes.ts, found ${feedCallCount} — if the feed accessor was renamed, update this gate.`);
    return;
  }

  const { analyzed, exempt, violations } = analyzeSource(source);
  if (analyzed < 3) {
    fail(`sanity: block splitter only matched ${analyzed} getPrimaryFeed blocks (expected >=3) — the route-registration pattern may have changed; update this gate.`);
    return;
  }
  console.log(`[gate] analyzed ${analyzed} getPrimaryFeed block(s) (${exempt} curated/annotation-exempt)`);
  if (violations.length === 0) {
    ok('server/routes.ts: every public getPrimaryFeed spread routes through stripInternalArticleFields');
  } else {
    for (const v of violations) fail(v);
  }
}

selfTest();
realScan();

if (failures > 0) {
  console.error(`\npublic-feed-strip gate FAILED (${failures} problem(s))`);
  process.exit(1);
}
console.log('\n[gate] public-feed-strip: all checks passed');
process.exit(0);
