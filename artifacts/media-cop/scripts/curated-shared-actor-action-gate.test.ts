/**
 * Shared-actor action-and-subject gate regression.
 *
 * Pure/deterministic: both existing Curated AI calls use the completion test seam;
 * there is no live model, database, persistence, or non-Curated surface involved.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  __setCuratedClusterCompletionForTest,
  identifyCuratedClusters,
  pruneIncoherentClusters,
  type LaneNode,
} from '../server/curatedCluster';

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (ok) {
    console.log(`[shared-actor-action-gate] OK   ${name}`);
  } else {
    failures++;
    console.error(`[shared-actor-action-gate] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function response(content: string): any {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

const publishedAt = new Date('2026-08-03T12:00:00Z');
function node(key: string, title: string, source: string): LaneNode {
  return {
    key,
    itemType: 'curated',
    itemId: key,
    source,
    url: `https://example.test/${key}`,
    category: 'general',
    label: null,
    cls: 'corroborating',
    role: 'contributing',
    blocked: false,
    priority: 75,
    ogImageUrl: null,
    publishedAt,
    sourceIdentifier: null,
    factuality: null,
    ownership: [],
    summary: null,
    bullets: null,
  } as LaneNode;
}

const nodes = [
  node('retreat-1', 'Chinese leaders gather in Beidaihe for annual policy retreat', 'Outlet A'),
  node('retreat-2', 'Beidaihe meeting brings senior officials together to set domestic priorities', 'Outlet B'),
  node('cable-surveillance', 'Chinese maritime surveillance reported near US-Taiwan undersea cable', 'Outlet C'),
  node('budget-address', 'Country A leader opens domestic budget address before parliament', 'Outlet D'),
  node('overseas-patrol', 'Country A navy begins overseas patrol near a foreign port', 'Outlet E'),
  node('attack', 'Country B launches missiles at Capital City overnight', 'Outlet F'),
  node('interception', 'Air defenses intercept missiles during the Capital City attack', 'Outlet G'),
  node('reaction', 'President condemns the overnight missile attack on Capital City', 'Outlet H'),
  node('proceeding-1', 'Parliament blocks annual defense bill in procedural vote', 'Outlet I'),
  node('proceeding-2', 'Lawmakers stall Pentagon authorization measure over voting rules', 'Outlet J'),
  node('operation-start', 'Country C begins Operation Harbor Shield against coastal launch sites', 'Outlet K'),
  node('operation-update', 'Country C completes second round of Harbor Shield strikes on the same launch sites', 'Outlet L'),
  node('operation-aftermath', 'Damage assessment follows Harbor Shield operation at coastal launch sites', 'Outlet M'),
  node('unrelated-procurement', 'Country C approves a new long-range surveillance aircraft purchase', 'Outlet N'),
];

const prompts: string[] = [];
const completionBodies: any[] = [];
let calls = 0;

__setCuratedClusterCompletionForTest(async (body: any) => {
  calls++;
  completionBodies.push(body);
  const prompt = String(body?.messages?.[0]?.content ?? '');
  prompts.push(prompt);

  if (prompt.startsWith('Analyze these news items')) {
    // Simulate the legacy grouping mistake for the reported 2+1 shape and an
    // analogous shared-country pair. Positive same-incident controls also pass
    // through to the existing coherence call.
    return response(JSON.stringify({
      clusters: [
        { indices: [1, 2, 3] },
        { indices: [4, 5] },
        { indices: [6, 7, 8] },
        { indices: [9, 10] },
        { indices: [11, 12, 13, 14] },
      ],
    }));
  }

  if (prompt.startsWith('Each cluster below is SUPPOSED')) {
    return response(JSON.stringify({
      clusters: [
        { cluster: 1, remove: [3] },
        { cluster: 2, remove: [1, 2] },
        { cluster: 3, remove: [] },
        { cluster: 4, remove: [] },
        { cluster: 5, remove: [4] },
      ],
    }));
  }

  throw new Error(`Unexpected prompt: ${prompt.slice(0, 80)}`);
});

try {
  const grouped = await identifyCuratedClusters(nodes);
  check('grouping call returns the five stubbed candidate groups', grouped?.length === 5,
    `got ${JSON.stringify(grouped)}`);

  const nodeByKey = new Map(nodes.map(n => [n.key, n]));
  const pruned = await pruneIncoherentClusters(grouped ?? [], nodeByKey);

  check('reported Beidaihe pair remains together',
    JSON.stringify(pruned[0]?.keys) === JSON.stringify(['retreat-1', 'retreat-2']),
    `got ${JSON.stringify(pruned[0]?.keys)}`);
  check('unrelated same-country maritime report is removed from the dominant pair',
    !pruned.some(g => g.keys.includes('cable-surveillance')));
  check('analogous shared-country pair is dissolved',
    pruned.some(g => g.keys.length === 0) &&
      !pruned.some(g => g.keys.includes('budget-address') || g.keys.includes('overseas-patrol')));
  check('attack, interception, and reaction to one incident remain together',
    pruned.some(g => JSON.stringify(g.keys) === JSON.stringify(['attack', 'interception', 'reaction'])));
  check('different wording for one named proceeding remains together',
    pruned.some(g => JSON.stringify(g.keys) === JSON.stringify(['proceeding-1', 'proceeding-2'])));
  check('a developing operation keeps occurrence, next phase, and aftermath together',
    pruned.some(g => JSON.stringify(g.keys) === JSON.stringify([
      'operation-start',
      'operation-update',
      'operation-aftermath',
    ])));
  check('same-country procurement is removed from the developing operation',
    !pruned.some(g => g.keys.includes('unrelated-procurement')));

  check('exactly the existing grouping and coherence calls run', calls === 2, `got ${calls}`);
  check('both calls retain the same model routing placeholder',
    completionBodies.length === 2 && completionBodies.every(body => body.model === 'gpt-4o'));
  check('both calls retain the JSON output contract and their bounded token budgets',
    completionBodies.length === 2 &&
      completionBodies[0]?.max_tokens === 6000 &&
      completionBodies[1]?.max_tokens === 4000 &&
      completionBodies.every(body => body.response_format?.type === 'json_object'));
} finally {
  __setCuratedClusterCompletionForTest(null);
}

const src = readFileSync(join(process.cwd(), 'server', 'curatedCluster.ts'), 'utf8');
const eventGuidance = readFileSync(
  join(process.cwd(), 'server', 'curatedEventIdentityGuidance.ts'),
  'utf8',
);
check('grouping prompt has a member-by-member action-and-subject gate',
  src.includes('${CURATED_EVENT_IDENTITY_GUIDANCE}') &&
    eventGuidance.includes('MEMBER-BY-MEMBER EVENT GATE') &&
    eventGuidance.includes('EVOLVING EVENT ENVELOPE'));
check('grouping prompt treats event identity as evolving rather than a frozen verb',
  eventGuidance.includes('not a frozen headline verb') &&
    eventGuidance.includes('Those developments may use different actions while preserving one event identity'));
check('grouping prompt says shared geography and backdrop are insufficient',
  eventGuidance.includes('broad security theme, or geopolitical backdrop NEVER establishes that continuity'));
check('grouping prompt contains the domestic-proceeding vs overseas-operation contrast',
  eventGuidance.includes("annual domestic retreat to set economic priorities") &&
    eventGuidance.includes('maritime-surveillance aircraft near Country B'));
check('coherence prompt makes a dominant same-event pair establish the anchor',
  src.includes('A clear pair or larger set describing the SAME specific event establishes the EVENT ANCHOR'));
check('coherence prompt decisively removes a different-action/different-subject minority',
  src.includes('a minority item whose concrete ACTION AND SUBJECT are both different') &&
    src.includes('has no explicit continuity'));
check('coherence prompt preserves valid phase changes within one event',
  src.includes('Do NOT freeze the anchor to one headline verb') &&
    src.includes('continuous operation or allowed multi-round campaign'));
check('coherence prompt preserves genuinely ambiguous same-incident angles',
  src.includes('could genuinely be another phase or angle inside the anchored event envelope') &&
    src.includes('do NOT flag it'));

const callSites = src.match(/await createCuratedClusterCompletion\(/g) ?? [];
check('existing cluster-completion call-site total is unchanged', callSites.length === 5,
  `found ${callSites.length} total existing call sites`);

if (checks < 20) {
  console.error(`[shared-actor-action-gate] INCOMPLETE — only ${checks}/20 checks ran`);
  process.exit(1);
}

console.log(failures === 0
  ? `[shared-actor-action-gate] ALL PASS (${checks} checks)`
  : `[shared-actor-action-gate] ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);