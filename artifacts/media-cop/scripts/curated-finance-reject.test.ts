/**
 * Regression test for the Curated personal/consumer-finance RELEVANCE reject.
 *
 * isCuratedNonRelevantConsumerFinance is a deterministic, curated-lane ONLY
 * backstop in the Curated ingest path: a personal/consumer-finance &
 * money-management HOW-TO ("4 bank accounts to put your money", best credit
 * cards, savings / retirement / budgeting tips, "where to put your money") has
 * no national-security bearing and must be REJECTED at the early relevance gate
 * — it is dropped before the AI batch and applies to BOTH 'gate' and 'reuse'
 * intake modes (reuse / Meltwater / social has no AI gate at all).
 *
 * Genuine economic STATECRAFT (sanctions, tariffs, trade war, export controls,
 * supply chains, defense-industrial finance) is protected by a strategic guard
 * that fires FIRST, so a real statecraft story sharing a money word is never
 * rejected. Macro-economic coverage (central banks, interest rates, inflation,
 * sovereign debt) does not match the narrow personal-finance patterns at all.
 *
 * This locks that behavior so a future tweak can't silently re-open the leak
 * (the prompting CNBC "Just graduated college? Here are 4 bank accounts..." P67
 * admission) or, conversely, start rejecting real economic statecraft.
 *
 * No test framework is configured in this repo — run directly with tsx:
 *   npx tsx scripts/curated-finance-reject.test.ts
 * Exits non-zero on any failure.
 */
import { isCuratedNonRelevantConsumerFinance } from "../server/scoreAdjustments";

interface Case {
  title: string;
  expected: boolean; // true = should be REJECTED from curated
  why: string;
}

const cases: Case[] = [
  // ---- Personal/consumer-finance how-to that MUST be rejected ----
  {
    title: "Just graduated college? Here are 4 bank accounts to put your money before real life hits",
    expected: true,
    why: "the prompting CNBC case — consumer bank-account how-to, no NatSec bearing",
  },
  {
    title: "The best high-yield savings accounts for 2026",
    expected: true,
    why: "high-yield savings accounts — personal-finance service journalism",
  },
  {
    title: "5 credit cards with the best travel rewards right now",
    expected: true,
    why: "best credit cards — consumer-credit how-to",
  },
  {
    title: "How to save for retirement in your 20s",
    expected: true,
    why: "how to save / retirement — money-management how-to",
  },
  {
    title: "Roth IRA vs 401(k): which retirement account is right for you",
    expected: true,
    why: "roth ira / 401(k) / retirement account — personal retirement advice",
  },
  {
    title: "Personal finance tips every new grad should know",
    expected: true,
    why: "personal finance + tips — explicit money advice",
  },
  {
    title: "Where to park your cash when interest rates fall",
    expected: true,
    why: "'park your cash' — consumer money-placement advice (interest rates is not a guard term)",
  },
  {
    title: "The best banks for college students this year",
    expected: true,
    why: "best banks — consumer banking roundup",
  },
  {
    title: "How to build credit fast with a secured credit card",
    expected: true,
    why: "how to build credit + credit card — consumer-credit how-to",
  },
  {
    title: "Mortgage rates dip: should you refinance now?",
    expected: true,
    why: "mortgage rates — personal-finance consumer angle",
  },

  // ---- Economic STATECRAFT that MUST NOT be rejected (guard protects) ----
  {
    title: "US imposes new sanctions freezing Russian central bank accounts",
    expected: false,
    why: "'bank accounts' present, but guard (sanctions) protects economic statecraft",
  },
  {
    title: "Treasury sanctions network laundering money through shell bank accounts",
    expected: false,
    why: "'bank accounts' present, but guard (sanctions) protects a sanctions-enforcement story",
  },
  {
    title: "China dumps US Treasuries as trade war with Washington escalates",
    expected: false,
    why: "'trade war' (via 'war' guard) protects a strategic-economics story",
  },
  {
    title: "New export controls target Chinese chipmaker credit card payment networks",
    expected: false,
    why: "'credit card' present, but guard (export controls / chipmaker) protects critical-tech statecraft",
  },
  {
    title: "North Korea hackers drained bank accounts to fund weapons program",
    expected: false,
    why: "'bank accounts' present, but guard (weapons) protects a proliferation-financing story",
  },
  {
    title: "Defense contractor expands 401(k) and retirement accounts for new hires",
    expected: false,
    why: "'retirement accounts' / 401(k) present, but guard (defense contractor) protects it",
  },

  // ---- Guard-gap regressions (terms added after review) — MUST NOT reject ----
  {
    title: "EU freezes Russian central bank accounts in latest measures",
    expected: false,
    why: "'central bank' + 'freeze/frozen' guard protects an asset-freeze story (no 'sanctions' word)",
  },
  {
    title: "OFAC targets laundering network using shell bank accounts",
    expected: false,
    why: "guard (ofac / money laundering) protects an illicit-finance enforcement story",
  },
  {
    title: "Tariffs squeeze 401(k) retirement accounts as markets tumble",
    expected: false,
    why: "plural 'tariffs' now guarded (singular regex would have missed it) — statecraft kept",
  },
  {
    title: "Treasury department freezes oligarch bank accounts overseas",
    expected: false,
    why: "guard (treasury department / frozen accounts) protects an enforcement story",
  },
  {
    title: "China imposes capital controls as foreign reserves dwindle",
    expected: false,
    why: "guard (capital controls / foreign reserves) protects a macro-statecraft story",
  },
  {
    title: "Russia cut off from SWIFT payment network over invasion",
    expected: false,
    why: "guard (SWIFT network) protects a financial-statecraft story (no personal-finance pattern anyway)",
  },
  {
    title: "BRICS push de-dollarization to dethrone the reserve currency",
    expected: false,
    why: "guard (de-dollarization / reserve currency) protects a monetary-statecraft story",
  },
  {
    title: "Swiss bank accounts of sanctioned officials frozen by regulators",
    expected: false,
    why: "guard (sanctioned / frozen accounts) — and 'Swiss' is not a consumer qualifier, so the bank-account pattern no longer fires",
  },

  // ---- Macro-economy: not statecraft-guarded, but no personal-finance pattern ----
  {
    title: "Federal Reserve raises interest rates to combat inflation",
    expected: false,
    why: "macro-economic story matches NO narrow personal-finance pattern — never rejected",
  },
  {
    title: "Eurozone slides toward recession as central bank holds rates",
    expected: false,
    why: "macro central-bank coverage matches no personal-finance pattern",
  },

  // ---- Defense / unrelated: no personal-finance pattern ----
  {
    title: "Pentagon budget tips toward record spending on hypersonics",
    expected: false,
    why: "'budget' (not 'budgeting'+tips) + guard (pentagon/hypersonic) — not a money how-to",
  },
  {
    title: "Ukraine launches major offensive to retake territory",
    expected: false,
    why: "combat story — no personal-finance pattern at all",
  },
  {
    title: "",
    expected: false,
    why: "empty title — never rejected",
  },
];

let pass = 0;
const failures: string[] = [];
for (const c of cases) {
  const got = isCuratedNonRelevantConsumerFinance(c.title);
  const ok = got === c.expected;
  if (ok) {
    pass++;
    console.log(`PASS [${c.why}]`);
  } else {
    failures.push(
      `FAIL [${c.why}] got=${got} expected=${c.expected} :: "${c.title}"`,
    );
    console.log(failures[failures.length - 1]);
  }
}

console.log(`\n${pass}/${cases.length} passed`);
if (failures.length) {
  console.error(`\n${failures.length} failure(s).`);
  process.exit(1);
}
