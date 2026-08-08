import { stripBriefingPreamble, stripBriefingPreambleFromMessage } from '../server/summarySanitizer';

let passed = 0;
let failed = 0;

function eq(name: string, got: string | null | undefined, want: string | null | undefined) {
  if (got === want) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`);
  }
}

const BODY = 'An F-16 intercepted a civilian aircraft that violated a VIP flight restriction over Hagerstown, Maryland.';

// --- The reported leak: markdown heading + blank line + body ---
eq(
  'markdown heading + blank line',
  stripBriefingPreamble(`# Summary for Chairman of the Joint Chiefs of Staff\n\n${BODY}`),
  BODY,
);

// --- Heading runs inline into the body (no newline) ---
eq(
  'inline heading, no newline',
  stripBriefingPreamble(`# Summary for Chairman of the Joint Chiefs of Staff ${BODY}`),
  BODY,
);

// --- No '#', plain label + colon ---
eq(
  'plain label with colon',
  stripBriefingPreamble(`Summary for the Chairman of the Joint Chiefs of Staff: ${BODY}`),
  BODY,
);

// --- Briefing-for + CJCS abbreviation ---
eq(
  'briefing for CJCS',
  stripBriefingPreamble(`## Briefing for CJCS\n${BODY}`),
  BODY,
);

// --- "Here is a summary for senior military leadership" ---
eq(
  'here is a summary for senior military leadership',
  stripBriefingPreamble(`Here is a summary for senior military leadership:\n\n${BODY}`),
  BODY,
);

// --- Single newline (not blank line) ---
eq(
  'single newline separator',
  stripBriefingPreamble(`# Summary for Chairman of the Joint Chiefs of Staff\n${BODY}`),
  BODY,
);

// --- Idempotent: running twice yields the same result ---
const once = stripBriefingPreamble(`# Summary for Chairman of the Joint Chiefs of Staff\n\n${BODY}`);
eq('idempotent', stripBriefingPreamble(once), once);

// --- SAFETY: legitimate inline mention of the real CJCS is PRESERVED ---
const legit = 'The Chairman of the Joint Chiefs of Staff briefed the President on Tuesday about troop movements.';
eq('legit inline CJCS mention preserved', stripBriefingPreamble(legit), legit);

const legit2 = 'General Brown, Chairman of the Joint Chiefs of Staff, met allies in Brussels.';
eq('legit mid-sentence CJCS preserved', stripBriefingPreamble(legit2), legit2);

// --- SAFETY: clean prose is unchanged ---
eq('clean prose unchanged', stripBriefingPreamble(BODY), BODY);

// --- SAFETY: a non-heading '#1' is not treated as a heading ---
eq('hash-one is not a heading', stripBriefingPreamble(`#1 threat: ${BODY}`), `#1 threat: ${BODY}`);

// --- Heading-only artifacts (no news body) are dropped to '' ---
eq(
  'pure audience-label artifact -> empty',
  stripBriefingPreamble('# Summary for Chairman of the Joint Chiefs of Staff'),
  '',
);
eq('heading-only "# Key Facts Summary" -> empty', stripBriefingPreamble('# Key Facts Summary'), '');
eq('heading-only "# KEY INTELLIGENCE SUMMARY" -> empty', stripBriefingPreamble('# KEY INTELLIGENCE SUMMARY'), '');
eq(
  'heading-only "# Father\'s Day Summary for Senior Leadership" -> empty',
  stripBriefingPreamble("# Father's Day Summary for Senior Leadership"),
  '',
);
eq('heading-only with trailing newline -> empty', stripBriefingPreamble('# Key Facts Summary\n'), '');

// --- null / undefined / empty passthrough ---
eq('null passthrough', stripBriefingPreamble(null), null);
eq('undefined passthrough', stripBriefingPreamble(undefined), undefined);
eq('empty passthrough', stripBriefingPreamble(''), '');

// ── stripBriefingPreambleFromMessage: composed bot chat messages ──────────────
const TITLE = 'F-16 intercepts civilian aircraft over Maryland';
const URL = 'https://example.com/story/123';

// Leaked heading after the bold title, with body following.
eq(
  'composed message: heading + body stripped, title/url kept',
  stripBriefingPreambleFromMessage(
    `**${TITLE}**\n\n# Summary for Chairman of the Joint Chiefs of Staff\n\n${BODY}\n\n${URL}`,
  ),
  `**${TITLE}**\n\n${BODY}\n\n${URL}`,
);

// Leaked plain label + colon after the bold title.
eq(
  'composed message: plain label stripped',
  stripBriefingPreambleFromMessage(
    `**${TITLE}**\n\nSummary for the Chairman of the Joint Chiefs of Staff: ${BODY}\n\n${URL}`,
  ),
  `**${TITLE}**\n\n${BODY}\n\n${URL}`,
);

// Heading-only summary (no body): the artifact line is removed, url remains.
eq(
  'composed message: heading-only summary collapses to title + url',
  stripBriefingPreambleFromMessage(
    `**${TITLE}**\n\n# Summary for Chairman of the Joint Chiefs of Staff\n\n${URL}`,
  ),
  `**${TITLE}**\n\n${URL}`,
);

// SAFETY: a clean composed message is returned byte-identical.
const cleanMsg = `**${TITLE}**\n\n${BODY}\n\n${URL}`;
eq('composed message: clean message unchanged', stripBriefingPreambleFromMessage(cleanMsg), cleanMsg);

// SAFETY: legitimate inline CJCS mention in the body is preserved.
const legitMsg = `**${TITLE}**\n\nThe Chairman of the Joint Chiefs of Staff briefed the President on Tuesday.\n\n${URL}`;
eq('composed message: legit inline CJCS preserved', stripBriefingPreambleFromMessage(legitMsg), legitMsg);

// SAFETY: a raw social post body (no audience heading) is untouched.
const socialMsg = `**POTUS (Truth Social) Post**\n\nWe are making AMERICA GREAT AGAIN!\n\n${URL}`;
eq('composed message: social post untouched', stripBriefingPreambleFromMessage(socialMsg), socialMsg);

// Idempotent on composed messages.
const onceMsg = stripBriefingPreambleFromMessage(
  `**${TITLE}**\n\n# Summary for Chairman of the Joint Chiefs of Staff\n\n${BODY}\n\n${URL}`,
);
eq('composed message: idempotent', stripBriefingPreambleFromMessage(onceMsg), onceMsg);

// null / undefined / no-blank-line passthrough.
eq('composed message: null passthrough', stripBriefingPreambleFromMessage(null), null);
eq('composed message: undefined passthrough', stripBriefingPreambleFromMessage(undefined), undefined);
eq('composed message: no blank line unchanged', stripBriefingPreambleFromMessage('just one line'), 'just one line');

console.log(`\nsummary-sanitizer: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
