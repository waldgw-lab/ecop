// Focused offline regression gate for Curated steering provenance and the narrow
// direct-U.S.-implication tie-break. No database writes or network calls.
import { readFileSync } from 'node:fs';
import { evalCuratedDirectUsImplicationTieBreak } from '../server/scoreAdjustments';
import { normalizeIdentityUrl } from '../server/urlIdentity';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  PASS ${name}`);
  else { failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('[1] direct U.S.-implication tie-break');
const direct = evalCuratedDirectUsImplicationTieBreak(
  'Pentagon announces new air defense deployment for Ukraine amid Russian missile strikes',
  '',
  70,
);
check('direct U.S. force-posture connection gets bounded nudge',
  direct.applied && direct.score === 73 && direct.reason === 'direct-us-conflict-implication');
const noUs = evalCuratedDirectUsImplicationTieBreak(
  'Russian forces advance near Pokrovsk as Ukraine prepares new defenses', '', 70,
);
check('ordinary Russia–Ukraine battlefield reporting is unchanged', !noUs.applied && noUs.score === 70);
const incidental = evalCuratedDirectUsImplicationTieBreak(
  'U.S. media cover Russian strikes on Ukraine overnight', '', 70,
);
check('incidental U.S. media mention is rejected', !incidental.applied && incidental.score === 70);
const capped = evalCuratedDirectUsImplicationTieBreak(
  'U.S. troops deploy new air defense system to Ukraine after Russian strikes', '', 84,
);
check('tie-break stays bounded below priority ceiling', capped.applied && capped.score === 85);

console.log('[2] canonical identity and exact-only correlation wiring');
check('tracking variants share identity',
  normalizeIdentityUrl('https://example.com/a?utm_source=rss&id=1') === normalizeIdentityUrl('https://example.com/a?id=1'));
check('identity keeps meaningful query parameters',
  normalizeIdentityUrl('https://example.com/a?id=1') !== normalizeIdentityUrl('https://example.com/a?id=2'));
const routes = readFileSync('server/routes.ts', 'utf8');
const ingest = readFileSync('server/curatedIngest.ts', 'utf8');
const schema = readFileSync('shared/schema.ts', 'utf8');
const migrate = readFileSync('server/migrate.ts', 'utf8');
const joe = readFileSync('server/joePriorityMatcher.ts', 'utf8');
check('override capture persists canonical identity', routes.includes('canonicalUrl: normalizeIdentityUrl(itemUrl)'));
check('report requires decision before action and seven-day bound',
  routes.includes('decisionAt <= actionAt') && routes.includes('7 * 24 * 60 * 60 * 1000'));
check('legacy events without persisted canonical identity remain unknown',
  routes.includes('const identity = e.canonicalUrl;') &&
  !routes.includes('const identity = e.canonicalUrl || normalizeIdentityUrl(e.itemUrl);'));
check('steering decisions carry canonical URL and rescue outcomes',
  ingest.includes('canonicalUrl: steeringCanonicalUrl') && ingest.includes('boloBudgetBlocked'));
check('telemetry has an idempotent decision key',
  schema.includes('eventKey: varchar("event_key").unique()') &&
  migrate.includes('CREATE UNIQUE INDEX IF NOT EXISTS watch_topic_telemetry_event_key_unique ON watch_topic_telemetry (event_key)`'));
check('archive report looks back from its oldest event, not reset time',
  routes.includes('oldestArchiveEvent ? new Date(oldestArchiveEvent.getTime() - 7 * 24 * 60 * 60 * 1000) : ack'));

console.log('[3] headline-only matcher contract completeness');
check('Curated matcher explicitly supplies headline only',
  /matchWatchTopics\(watchTopics, c\.title\)/.test(ingest));
check('boot repair compiles boolean keyword boxes',
  migrate.includes('or_keywords, and_keywords, not_keywords') && migrate.includes('orKeywords: t.or_keywords'));
check('Joe prompt exposes all boolean keyword clauses',
  joe.includes('OR: ${subject.orKeywords.join') && joe.includes('AND: ${subject.andKeywords.join') && joe.includes('NOT: ${subject.notKeywords.join'));

if (failures) {
  console.error(`\n[curated-steering-attribution] FAIL — ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\n[curated-steering-attribution] PASS');