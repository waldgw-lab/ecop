/**
 * scripts/curated-editorial-evidence.test.ts
 *
 * Pure-data gate for the Task #1180 editorial-evidence contract
 * (shared/editorialEvidence.ts). No DB, no network, no AI, no clock — every
 * assertion runs against deterministic in-memory fixtures, so this gate is
 * fully offline and reproducible.
 *
 * Coverage (per Task #1180 "Done looks like" + Step 8):
 *   - identity normalization (URL / outlet / story / member),
 *   - reason validation keyed to action family,
 *   - episode collapse of rapid retries / follow-up score edits into ONE
 *     episode WHILE contradictory-direction edits SEPARATE,
 *   - grouping-label semantics (positive only from link/merge; negative only
 *     from explicit incorrect-grouping on evict/move/unlink/undo; evolution/
 *     supersede recorded as lineage, never a rejection),
 *   - supersede/undo lineage preserved,
 *   - redaction (editor identity + credentials/session/private keys excluded;
 *     ambiguous/unverified excluded by default and reported separately),
 *   - packet reproducibility (byte-for-byte identical on repeat + insertion
 *     order independent).
 *
 * Run directly with tsx:  npx tsx scripts/curated-editorial-evidence.test.ts
 * Exit 0 = PASS, exit 1 = FAIL.
 */

import {
  EDITORIAL_EVIDENCE_SCHEMA_VERSION,
  ACTION_FAMILY,
  actionFamily,
  PRIORITY_REASONS,
  PRIORITY_REASON_KEYS,
  CLUSTER_REASONS,
  CLUSTER_REASON_KEYS,
  INCORRECT_GROUPING_REASON_KEYS,
  validateReason,
  fallbackNormalizeUrl,
  normalizeOutletIdentity,
  normalizeStoryIdentity,
  normalizeMemberIdentity,
  collapseEpisodes,
  priorityDirection,
  episodeKey,
  groupingLabel,
  redactNote,
  REDACTED_FIELDS,
  filterEpisodes,
  isAmbiguousOrUnverified,
  buildJsonPacket,
  buildMarkdownPacket,
  stableStringify,
  type RawEditorialAction,
  type EditorialActionKind,
} from '../shared/editorialEvidence';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  PASS: ${name}`);
  } else {
    failures++;
    console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function raw(partial: Partial<RawEditorialAction> & { id: string; kind: EditorialActionKind; at: number }): RawEditorialAction {
  return partial;
}

// ===========================================================================
console.log('[1] Action families + vocabularies');
// ===========================================================================
check('every kind maps to a family', Object.keys(ACTION_FAMILY).length === 12);
check('link/merge are grouping-positive',
  actionFamily('link') === 'grouping-positive' && actionFamily('merge') === 'grouping-positive');
check('evict/move/unlink are grouping-negative',
  actionFamily('evict') === 'grouping-negative' &&
  actionFamily('move') === 'grouping-negative' &&
  actionFamily('unlink') === 'grouping-negative');
check('undo is lineage', actionFamily('undo') === 'lineage');
check('priority-adjust/hide are priority',
  actionFamily('priority-adjust') === 'priority' && actionFamily('hide') === 'priority');

// Exact priority vocabulary from the task.
const EXPECTED_PRIORITY = [
  'us-allied-consequence', 'leadership-watch-interest', 'operational-readiness-impact',
  'imminence-freshness', 'novelty', 'comparative-ranking', 'aftermath-downstream',
  'decay-error', 'other',
];
check('priority vocab exact set',
  EXPECTED_PRIORITY.every((k) => PRIORITY_REASON_KEYS.has(k)) &&
  PRIORITY_REASONS.length === EXPECTED_PRIORITY.length,
  JSON.stringify(PRIORITY_REASONS.map((r) => r.key)));

const EXPECTED_CLUSTER = [
  'same-event-process', 'different-incident', 'different-phase-time-location',
  'downstream-consequence', 'story-evolution', 'mistaken-prior-edit', 'mechanical-supersede',
];
check('cluster vocab exact set',
  EXPECTED_CLUSTER.every((k) => CLUSTER_REASON_KEYS.has(k)) &&
  CLUSTER_REASONS.length === EXPECTED_CLUSTER.length,
  JSON.stringify(CLUSTER_REASONS.map((r) => r.key)));

check('incorrect-grouping reasons are the different-incident family only',
  INCORRECT_GROUPING_REASON_KEYS.has('different-incident') &&
  INCORRECT_GROUPING_REASON_KEYS.has('different-phase-time-location') &&
  !INCORRECT_GROUPING_REASON_KEYS.has('story-evolution') &&
  !INCORRECT_GROUPING_REASON_KEYS.has('mechanical-supersede'));

// ===========================================================================
console.log('[2] Reason validation');
// ===========================================================================
check('priority-adjust requires a priority reason',
  validateReason('priority-adjust', 'us-allied-consequence').valid &&
  !validateReason('priority-adjust', 'same-event-process').valid &&
  !validateReason('priority-adjust', '').valid);
check('link requires a cluster reason',
  validateReason('link', 'same-event-process').valid &&
  !validateReason('link', 'us-allied-consequence').valid);
check('metadata kinds need no controlled reason',
  validateReason('headline', null).valid && !validateReason('headline', null).required &&
  validateReason('image', '').valid && validateReason('classify', undefined).valid);
check('hide carries free note only (no controlled reason)',
  validateReason('hide', null).valid && !validateReason('hide', null).required);

// ===========================================================================
console.log('[3] Identity normalization');
// ===========================================================================
check('url identity strips tracking + fragment + trailing slash + lowercases',
  fallbackNormalizeUrl('https://BBC.com/News/x/?utm_source=rss&at_medium=RSS#top/') ===
  'https://bbc.com/news/x');
check('url identity keeps identifying params sorted',
  fallbackNormalizeUrl('https://abc.com/a?id=5&p=2&utm_x=1') === 'https://abc.com/a?id=5&p=2');
check('outlet identity normalizes',
  normalizeOutletIdentity('The New York Times') === 'new york times' &&
  normalizeOutletIdentity('Associated Press (X)') === 'associated press');
check('story identity prefers clusterId over url',
  normalizeStoryIdentity({ clusterId: 'C7', primaryUrl: 'https://x.com/a' }) === 'cluster:c7' &&
  normalizeStoryIdentity({ clusterId: null, primaryUrl: 'https://x.com/a/' }) === 'url:https://x.com/a');
check('member identity uses url normalizer',
  normalizeMemberIdentity('https://Y.com/z/?utm_a=1') === 'https://y.com/z');

// ===========================================================================
console.log('[4] Episode collapse — rapid retries + follow-up score edits → ONE');
// ===========================================================================
const T0 = 1_000_000_000_000;
const min = 60_000;
{
  const actions = [
    raw({ id: 'a1', kind: 'priority-adjust', at: T0, editorId: 'ed1', clusterId: 'C1', beforeScore: 40, requestedScore: 60, reasonKey: 'novelty', verified: true, outcome: 'applied' }),
    // retry 1 minute later, same up-direction, follow-up score bump
    raw({ id: 'a2', kind: 'priority-adjust', at: T0 + 1 * min, editorId: 'ed1', clusterId: 'C1', beforeScore: 60, requestedScore: 70, reasonKey: 'novelty', verified: true, outcome: 'applied' }),
    raw({ id: 'a3', kind: 'priority-adjust', at: T0 + 2 * min, editorId: 'ed1', clusterId: 'C1', beforeScore: 70, requestedScore: 75, reasonKey: 'novelty', verified: true, outcome: 'applied' }),
  ];
  const eps = collapseEpisodes(actions);
  check('three same-direction rapid edits collapse into one episode', eps.length === 1, `got ${eps.length}`);
  check('collapsed episode retains all raw ids', eps[0].rawActionIds.join(',') === 'a1,a2,a3');
  check('collapsed episode keeps first before + last requested',
    eps[0].beforeScore === 40 && eps[0].requestedScore === 75, JSON.stringify(eps[0]));
}

// ===========================================================================
console.log('[5] Episode collapse — contradictory direction SEPARATES');
// ===========================================================================
{
  const actions = [
    raw({ id: 'b1', kind: 'priority-adjust', at: T0, editorId: 'ed1', clusterId: 'C2', beforeScore: 40, requestedScore: 60, reasonKey: 'novelty', verified: true, outcome: 'applied' }),
    // 1 minute later editor REVERSES: score down (contradictory)
    raw({ id: 'b2', kind: 'priority-adjust', at: T0 + 1 * min, editorId: 'ed1', clusterId: 'C2', beforeScore: 60, requestedScore: 30, reasonKey: 'decay-error', verified: true, outcome: 'applied' }),
  ];
  const eps = collapseEpisodes(actions);
  check('contradictory up-then-down forms two episodes', eps.length === 2, `got ${eps.length}`);
  check('directions are up then down',
    priorityDirection(actions[0]) === 'up' && priorityDirection(actions[1]) === 'down');

  // Crossing the window also separates even if same direction.
  const windowed = [
    raw({ id: 'w1', kind: 'priority-adjust', at: T0, editorId: 'ed1', clusterId: 'C3', beforeScore: 40, requestedScore: 60, reasonKey: 'novelty', verified: true }),
    raw({ id: 'w2', kind: 'priority-adjust', at: T0 + 6 * min, editorId: 'ed1', clusterId: 'C3', beforeScore: 60, requestedScore: 70, reasonKey: 'novelty', verified: true }),
  ];
  check('same direction beyond 5-min window separates', collapseEpisodes(windowed).length === 2);

  // The same intent from different editors is one episode; editor identity is
  // counted durably, not used to manufacture independent votes.
  const twoEditors = [
    raw({ id: 'e1', kind: 'priority-adjust', at: T0, editorId: 'ed1', clusterId: 'C4', beforeScore: 40, requestedScore: 60, reasonKey: 'novelty', verified: true }),
    raw({ id: 'e2', kind: 'priority-adjust', at: T0 + min, editorId: 'ed2', clusterId: 'C4', beforeScore: 60, requestedScore: 70, reasonKey: 'novelty', verified: true }),
  ];
  const crossEditor = collapseEpisodes(twoEditors);
  check('different editors collapse onto the same intent episode',
    crossEditor.length === 1 && crossEditor[0].rawCount === 2);

  check('episode key excludes direction (contradiction handled by split)',
    episodeKey(actions[0]) === episodeKey(actions[1]));
}

// ===========================================================================
console.log('[6] Grouping label semantics');
// ===========================================================================
{
  const linkEp = collapseEpisodes([
    raw({ id: 'g1', kind: 'link', at: T0, editorId: 'ed1', clusterId: 'C5', reasonKey: 'same-event-process', verified: true, outcome: 'applied' }),
  ])[0];
  check('link → positive label', groupingLabel(linkEp) === 'positive');

  const mergeEp = collapseEpisodes([
    raw({ id: 'g2', kind: 'merge', at: T0, editorId: 'ed1', clusterId: 'C6', reasonKey: 'same-event-process', verified: true }),
  ])[0];
  check('merge → positive label', groupingLabel(mergeEp) === 'positive');

  // evict WITH explicit incorrect-grouping flag → negative
  const evictNeg = collapseEpisodes([
    raw({ id: 'g3', kind: 'evict', at: T0, editorId: 'ed1', clusterId: 'C7', reasonKey: 'different-incident', explicitIncorrectGrouping: true, verified: true }),
  ])[0];
  check('evict + explicit incorrect grouping → negative label', groupingLabel(evictNeg) === 'negative');

  // evict with different-incident reason alone → negative (reason implies it)
  const evictReason = collapseEpisodes([
    raw({ id: 'g4', kind: 'unlink', at: T0, editorId: 'ed1', clusterId: 'C8', reasonKey: 'different-phase-time-location', verified: true }),
  ])[0];
  check('unlink + different-phase reason → negative label', groupingLabel(evictReason) === 'negative');

  // move due to story-evolution → lineage, NOT negative
  const moveEvolution = collapseEpisodes([
    raw({ id: 'g5', kind: 'move', at: T0, editorId: 'ed1', clusterId: 'C9', reasonKey: 'story-evolution', verified: true }),
  ])[0];
  check('move + story-evolution → lineage (NOT rejection)', groupingLabel(moveEvolution) === 'lineage');

  // mechanical supersede undo → lineage
  const undoMech = collapseEpisodes([
    raw({ id: 'g6', kind: 'undo', at: T0, editorId: 'ed1', clusterId: 'C10', reasonKey: 'mechanical-supersede', verified: true }),
  ])[0];
  check('undo + mechanical-supersede → lineage (NOT rejection)', groupingLabel(undoMech) === 'lineage');

  // priority action → no grouping label
  const prio = collapseEpisodes([
    raw({ id: 'g7', kind: 'priority-adjust', at: T0, editorId: 'ed1', clusterId: 'C11', beforeScore: 40, requestedScore: 50, reasonKey: 'novelty', verified: true }),
  ])[0];
  check('priority action → no grouping label', groupingLabel(prio) === 'none');
}

// ===========================================================================
console.log('[7] Supersede / undo lineage');
// ===========================================================================
{
  const eps = collapseEpisodes([
    raw({ id: 'l2', kind: 'undo', at: T0 + min, editorId: 'ed1', clusterId: 'C12', reasonKey: 'mistaken-prior-edit', supersedesEpisodeId: 'ep:l1', verified: true }),
  ]);
  check('undo episode retains supersedesEpisodeId', eps[0].supersedesEpisodeId === 'ep:l1');
}

// ===========================================================================
console.log('[8] Redaction — notes + fields');
// ===========================================================================
check('redactNote scrubs api-key style token', redactNote('key sk-ABCDEFGHIJKLMNOPQRST12345') === '[redacted]');
check('redactNote scrubs PEM private key', redactNote('-----BEGIN RSA PRIVATE KEY-----').includes('redacted') || redactNote('-----BEGIN RSA PRIVATE KEY-----') === '[redacted]');
check('redactNote scrubs bearer token', redactNote('Authorization: Bearer abcdef123456ghijkl') === '[redacted]');
check('redactNote passes a benign note', redactNote('AI split this incorrectly, same summit') === 'AI split this incorrectly, same summit');
check('redactNote empty → null', redactNote('   ') === null);
check('REDACTED_FIELDS includes editorId + credentials',
  REDACTED_FIELDS.includes('editorId') && REDACTED_FIELDS.includes('sessionId') &&
  REDACTED_FIELDS.includes('privateKey') && REDACTED_FIELDS.includes('token'));

// ===========================================================================
console.log('[9] Filtering — ambiguous/unverified excluded by default + reported');
// ===========================================================================
{
  const eps = collapseEpisodes([
    raw({ id: 'f1', kind: 'link', at: T0, editorId: 'ed1', clusterId: 'F1', reasonKey: 'same-event-process', verified: true, outcome: 'applied' }),
    raw({ id: 'f2', kind: 'link', at: T0 + 10 * min, editorId: 'ed1', clusterId: 'F2', reasonKey: 'same-event-process', verified: false, outcome: 'requested' }),
    raw({ id: 'f3', kind: 'merge', at: T0 + 20 * min, editorId: 'ed1', clusterId: 'F3', reasonKey: 'same-event-process', verified: true, outcome: 'conflicted' }),
  ]);
  const res = filterEpisodes(eps);
  check('verified+applied included', res.included.length === 1 && res.included[0].clusterId === 'F1');
  check('unverified + conflicted excluded as ambiguous', res.excludedAmbiguous.length === 2, `got ${res.excludedAmbiguous.length}`);
  check('isAmbiguousOrUnverified flags unverified', isAmbiguousOrUnverified(eps[1]));
  check('isAmbiguousOrUnverified flags conflicted', isAmbiguousOrUnverified(eps[2]));

  // commentedOnly + representative sampling
  const withNotes = collapseEpisodes([
    raw({ id: 'n1', kind: 'link', at: T0, editorId: 'ed1', clusterId: 'N1', reasonKey: 'same-event-process', note: 'a', verified: true, outcome: 'applied' }),
    raw({ id: 'n2', kind: 'link', at: T0 + 10 * min, editorId: 'ed1', clusterId: 'N2', reasonKey: 'same-event-process', verified: true, outcome: 'applied' }),
  ]);
  check('commentedOnly filters to noted episodes', filterEpisodes(withNotes, { commentedOnly: true }).included.length === 1);

  const many = collapseEpisodes(Array.from({ length: 5 }, (_, i) =>
    raw({ id: `s${i}`, kind: 'link', at: T0 + i * 10 * min, editorId: 'ed1', clusterId: `S${i}`, reasonKey: 'same-event-process', verified: true, outcome: 'applied' })));
  const sampled = filterEpisodes(many, { representativeLimitPerFamily: 2 });
  check('representative sampling caps per family + reports excess',
    sampled.included.length === 2 && sampled.excludedBySampling.length === 3);
}

// ===========================================================================
console.log('[10] Packet — schema, counts, no editor identity, reproducibility');
// ===========================================================================
{
  const actions: RawEditorialAction[] = [
    raw({ id: 'p1', kind: 'priority-adjust', at: T0, editorId: 'secret-editor-jane', clusterId: 'P1', beforeScore: 40, requestedScore: 70, actualScore: 68, reasonKey: 'us-allied-consequence', note: 'clear allied impact', memberUrls: ['https://reuters.com/x?utm_a=1'], memberOutlets: ['Reuters'], headlines: ['Talks collapse'], provenance: { model: 'm1', promptVersion: 'v3', clusterRevision: 'r9', surface: 'curated-detail' }, verified: true, outcome: 'persisted' }),
    raw({ id: 'p2', kind: 'link', at: T0 + 30 * min, editorId: 'secret-editor-jane', clusterId: 'P2', reasonKey: 'same-event-process', memberUrls: ['https://apnews.com/y'], memberOutlets: ['Associated Press'], verified: true, outcome: 'applied' }),
    raw({ id: 'p3', kind: 'evict', at: T0 + 60 * min, editorId: 'secret-editor-jane', clusterId: 'P3', reasonKey: 'different-incident', explicitIncorrectGrouping: true, verified: true, outcome: 'applied' }),
    // unverified — should be excluded + reported
    raw({ id: 'p4', kind: 'merge', at: T0 + 90 * min, editorId: 'secret-editor-jane', clusterId: 'P4', reasonKey: 'same-event-process', verified: false, outcome: 'requested' }),
  ];
  const eps = collapseEpisodes(actions);
  const json = buildJsonPacket(eps, { scopeLabel: 'since 2025-01-01' });

  check('packet schema version present', json.schemaVersion === EDITORIAL_EVIDENCE_SCHEMA_VERSION);
  check('packet reports raw-vs-episode counts',
    json.counts.episodeCount === 4 && json.counts.includedCount === 3 && json.counts.excludedAmbiguousCount === 1);
  check('packet action breakdown correct',
    json.counts.byAction['priority-adjust'] === 1 && json.counts.byAction['link'] === 1 && json.counts.byAction['evict'] === 1);
  check('packet label breakdown correct',
    json.counts.byLabel.positive === 1 && json.counts.byLabel.negative === 1 && json.counts.byLabel.none === 1);
  check('packet reports excluded ambiguous ids only',
    json.excludedAmbiguous.length === 1 && json.excludedAmbiguous[0].reason === 'unverified');

  const asText = JSON.stringify(json);
  check('packet contains NO editor identity', !asText.includes('secret-editor-jane'));
  check('packet declares redacted fields', json.redactedFields.includes('editorId'));
  check('packet keeps provenance + normalized urls',
    asText.includes('curated-detail') && asText.includes('https://reuters.com/x') && !asText.includes('utm_a'));

  // Markdown packet excludes identity too, includes fenced JSON.
  const md = buildMarkdownPacket(eps, { scopeLabel: 'since 2025-01-01' });
  check('markdown packet excludes editor identity', !md.includes('secret-editor-jane'));
  check('markdown packet embeds fenced JSON + schema', md.includes('```json') && md.includes(EDITORIAL_EVIDENCE_SCHEMA_VERSION));
  check('markdown states exclusion contract', md.toLowerCase().includes('excluded by contract'));

  // Reproducibility: identical input → byte-identical packet.
  const json2 = buildJsonPacket(eps, { scopeLabel: 'since 2025-01-01' });
  check('json packet reproducible', stableStringify(json) === stableStringify(json2));
  const md2 = buildMarkdownPacket(eps, { scopeLabel: 'since 2025-01-01' });
  check('markdown packet reproducible', md === md2);

  // Insertion-order independence: shuffle raw input → identical packet.
  const shuffled = [actions[2], actions[0], actions[3], actions[1]];
  const jsonShuffled = buildJsonPacket(collapseEpisodes(shuffled), { scopeLabel: 'since 2025-01-01' });
  check('packet is insertion-order independent', stableStringify(json) === stableStringify(jsonShuffled));
}

// ===========================================================================
if (failures === 0) {
  console.log('\n[editorial-evidence] ALL CHECKS PASSED');
  process.exit(0);
} else {
  console.error(`\n[editorial-evidence] ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
