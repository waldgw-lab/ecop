/**
 * Curated money-figure de-bridge regression (multi-crisis over-merge, lever D).
 *
 * On a busy news day several UNRELATED stories each carry a large dollar figure
 * ("$100 billion"): a chip-fab investment, an oil-tanker deal, a Pentagon
 * program. Each figure used to tokenize into a 3+ digit number token PLUS a
 * magnitude token ("100" + "billion"), so two unrelated money stories shared
 * {100, billion} — exactly 2 shared distinctive tokens — and cleared the
 * looksSameEvent / looksRelatedToStory recall bar, welding distinct events into
 * one topically-incoherent megacluster (the prod US-Iran "Military Ops" card
 * that swallowed TSMC's $100bn, an oil-tanker deal, and Russia-drone reports).
 *
 * canonicalizeMoneyFigures (run inside significantTitleTokens) now collapses a
 * money figure to a SINGLE token, and — OUTSIDE a defense-spending context —
 * removes it entirely, so a bare dollar amount can never be the SECOND shared
 * token the >= 2 bar needs. Mechanism mirrors the casualty/displacement passes
 * (single-token fusion, context-gated) but the intent is PRECISION (de-bridge)
 * not recall: in a defense-spending context the amount keeps ONE shared token
 * so two reports of the SAME budget/procurement/arms deal still corroborate.
 *
 * PURE, deterministic (no DB / no LLM / no network).
 *
 * Usage:  tsx scripts/curated-money-debridge.test.ts
 * Exit:   0 = all pass, 1 = a check failed.
 */
import { significantTitleTokens, looksSameEvent, looksRelatedToStory } from '../server/curatedCluster';

let failures = 0;
let ran = 0;
function check(name: string, ok: boolean, detail = '') {
  ran++;
  if (ok) {
    console.log(`[money-debridge] OK   ${name}`);
  } else {
    console.error(`[money-debridge] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// (1) THE WELDING REGRESSION — two UNRELATED money stories whose ONLY shared
// distinctive tokens were the dollar figure {100, billion} must no longer
// looksSameEvent OR looksRelatedToStory. This is the exact over-merge vector.
// ---------------------------------------------------------------------------
{
  const tsmc = significantTitleTokens('TSMC to invest $100 billion in Arizona chip plants');
  const tanker = significantTitleTokens('Greek shipping firm orders $100 billion oil tanker fleet');
  check(
    '(1) chip-fab and oil-tanker $100 billion tokens carry no money bridge token',
    !tsmc.has('billion') && !tsmc.has('100') && !tsmc.has('moneyfigure') &&
      !tanker.has('billion') && !tanker.has('100') && !tanker.has('moneyfigure'),
    `tsmc=${[...tsmc].join(',')} | tanker=${[...tanker].join(',')}`,
  );
  check('(1) the two unrelated money stories do NOT looksSameEvent', looksSameEvent(tsmc, tanker) === false);
  check('(1) the two unrelated money stories do NOT looksRelatedToStory', looksRelatedToStory(tsmc, tanker) === false);
}

// ---------------------------------------------------------------------------
// (2) ACCEPTANCE — "$100bn" (chips, out of context) and "$100 bln" (military
// cost, in a defense-spending context) no longer share a money token. The
// out-of-context figure contributes ZERO money tokens; the in-context figure
// fuses to the single shared "moneyfigure" token.
// ---------------------------------------------------------------------------
{
  const chips = significantTitleTokens('Startup raises $100bn in a record funding round');
  const military = significantTitleTokens('Pentagon missile defense program to cost $100 bln');
  check(
    '(2) out-of-context "$100bn" leaves no money token at all',
    !chips.has('moneyfigure') && !chips.has('100bn') && !chips.has('billion') && !chips.has('100'),
    `chips=${[...chips].join(',')}`,
  );
  check(
    '(2) in-context "$100 bln" fuses to the shared moneyfigure token (no bare number/word)',
    military.has('moneyfigure') && !military.has('bln') && !military.has('100'),
    `military=${[...military].join(',')}`,
  );
  check(
    '(2) chips and military figures share NO money token',
    !(chips.has('moneyfigure') && military.has('moneyfigure')),
  );
}

// ---------------------------------------------------------------------------
// (3) RECALL PRESERVED (in defense-spending context) — two reports of the SAME
// defense-budget story keep the shared moneyfigure token and still merge.
// ---------------------------------------------------------------------------
{
  const a = significantTitleTokens('Pentagon requests $100 billion for a new missile defense shield');
  const b = significantTitleTokens("Congress approves Pentagon's $100 billion missile defense budget");
  check('(3) both same-budget reports carry the shared moneyfigure token', a.has('moneyfigure') && b.has('moneyfigure'));
  check('(3) two reports of the SAME defense budget still looksSameEvent', looksSameEvent(a, b) === true);
}

// ---------------------------------------------------------------------------
// (4) PRECISION GUARDRAIL — two DIFFERENT defense-spending stories that share
// ONLY the moneyfigure token must NOT looksSameEvent. Single-token fusion means
// the money token alone can never force a merge (>= 2 shared tokens still
// required), exactly like casualtycount / displacecount.
// ---------------------------------------------------------------------------
{
  const jets = significantTitleTokens('Pentagon awards $100 billion jet fighter production contract');
  const subs = significantTitleTokens('Navy submarine program to cost $100 billion over a decade');
  check('(4) both distinct defense outlays carry moneyfigure', jets.has('moneyfigure') && subs.has('moneyfigure'));
  check(
    '(4) two DIFFERENT defense outlays sharing only moneyfigure do NOT looksSameEvent',
    looksSameEvent(jets, subs) === false,
    `jets=${[...jets].join(',')} | subs=${[...subs].join(',')}`,
  );
}

// ---------------------------------------------------------------------------
// (5) HUMAN-COUNT PROTECTION — a bare "<N> million" (people, refugees,
// subscribers) is NOT money: no "$" and "million" is excluded from the no-$
// magnitude rule, so a large human count is left completely untouched (never
// mistaken for a dollar figure).
// ---------------------------------------------------------------------------
{
  const subscribers = significantTitleTokens('Streaming service passes 2 million subscribers milestone');
  check(
    '(5) bare "2 million subscribers" keeps "million" and is not money',
    subscribers.has('million') && !subscribers.has('moneyfigure'),
    `subscribers=${[...subscribers].join(',')}`,
  );
  const refugees = significantTitleTokens('War forces 3 million refugees to cross the border');
  check(
    '(5) bare "3 million refugees" keeps "million" and is not money',
    refugees.has('million') && !refugees.has('moneyfigure'),
    `refugees=${[...refugees].join(',')}`,
  );
}

// ---------------------------------------------------------------------------
// (6) FORM VARIANTS — trillion / bn / no-"$" magnitude money all de-bridge the
// same way (removed out of context, one token in context).
// ---------------------------------------------------------------------------
{
  const trillion = significantTitleTokens('US defense budget balloons to $1.5 trillion next year');
  check('(6) in-context "$1.5 trillion" fuses to moneyfigure (no leftover "trillion")',
    trillion.has('moneyfigure') && !trillion.has('trillion'), `trillion=${[...trillion].join(',')}`);

  const green = significantTitleTokens('China pledges 100 billion in green energy investment');
  check('(6) out-of-context no-"$" "100 billion" is removed entirely',
    !green.has('billion') && !green.has('100') && !green.has('moneyfigure'), `green=${[...green].join(',')}`);

  const bond = significantTitleTokens('Treasury sells $50bn in bonds to fund the deficit');
  check('(6) out-of-context "$50bn" leaves no money token', !bond.has('moneyfigure') && !bond.has('50bn'),
    `bond=${[...bond].join(',')}`);
}

// ---------------------------------------------------------------------------
// (7) NON-MONEY BARE NUMBERS untouched — a squadron / route / vote number that
// is not a dollar figure and not an impact count must survive unchanged (the
// money pass must never eat a plain number).
// ---------------------------------------------------------------------------
{
  const jet = significantTitleTokens('Air Force grounds its F35 fighter fleet after engine fault');
  check('(7) a non-money model number ("f35") is left untouched', jet.has('f35') && !jet.has('moneyfigure'));
}

// ---------------------------------------------------------------------------
// Completion sentinel — guard against a vacuous exit-0 if the file threw or an
// import silently no-op'd before the checks ran.
// ---------------------------------------------------------------------------
const EXPECTED_MIN_CHECKS = 15;
if (ran < EXPECTED_MIN_CHECKS) {
  console.error(`\n[money-debridge] INCOMPLETE — only ${ran}/${EXPECTED_MIN_CHECKS} checks ran (vacuous pass guard)`);
  process.exit(1);
}

if (failures > 0) {
  console.error(`\n[money-debridge] ${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log(`\n[money-debridge] ALL PASS (${ran} checks)`);
}
