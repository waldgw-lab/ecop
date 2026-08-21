import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import {
  searchArchive,
  listSourcesInWindow,
  getFullTextByRefs,
  ALL_SOURCE_TABLES,
  SOURCE_TABLE_DESCRIPTIONS,
  type SourceTable,
  type ArchiveItem,
} from './mcopBotArchive';
import { filterCuratedStories, type CuratedStoryForModel } from './mcopBotCurated';
import { assertAIIntegrationsEnabled, isAIIntegrationsDisabled } from './aiClient';

// Curated-view awareness. When (and ONLY when) the route authorizes curated mode
// it injects a provider that returns the trust-tagged curated Top Stories
// (see server/mcopBotCurated.ts). Off every non-curated surface the provider is
// absent, the curated tool is not offered, and the base prompt/tools are used
// verbatim — so Stream/Team/custom-MCOP behavior is byte-identical.
export type CuratedStoriesProvider = () => Promise<CuratedStoryForModel[]>;

// Prefer OpenRouter (via Replit AI Integrations) so we can use Claude Haiku 4.5 with tool use.
// Fall back to direct Anthropic if OpenRouter isn't configured.
const OPENROUTER_BASE_URL = process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL;
const OPENROUTER_API_KEY = process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY;
const OPENROUTER_MODEL = 'anthropic/claude-haiku-4.5';

const openrouter = (!isAIIntegrationsDisabled() && OPENROUTER_BASE_URL && OPENROUTER_API_KEY)
  ? new OpenAI({ baseURL: OPENROUTER_BASE_URL, apiKey: OPENROUTER_API_KEY })
  : null;

// Constructed lazily: the Anthropic SDK throws in its constructor when no API
// key is present, so building it at import time would make this module (and its
// pure tool/prompt builders below) un-importable in a keyless context such as
// the gate harness. Only the legacy fallback path actually needs it.
let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  assertAIIntegrationsEnabled();
  if (!_anthropic) {
    _anthropic = new Anthropic({
      apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
    });
  }
  return _anthropic;
}

const MAX_TOOL_ITERATIONS = 6;
const MAX_FULL_TEXT_FETCHES = 25;

const SOURCE_ENUM = ALL_SOURCE_TABLES;

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'searchByDate',
      description:
        'Search the news archive by date window. Returns recent items across all source tables (Truth Social, X posts, Dataminr first alerts, headlines, team submissions, quotes, etc.) within the given range. Use when the user asks about a specific date, day, or window.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'ISO 8601 start datetime (UTC), inclusive. Example: 2026-04-23T00:00:00Z' },
          to: { type: 'string', description: 'ISO 8601 end datetime (UTC), inclusive. Example: 2026-04-23T23:59:59Z' },
          sources: {
            type: 'array',
            items: { type: 'string', enum: SOURCE_ENUM },
            description: 'Optional: restrict to specific source tables.',
          },
          authors: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional: filter by author / source-account / speaker. Recognized aliases: POTUS, Trump, Hegseth, SecWar, Parnell, sentdefender, RapidResponse, DoW, CENTCOM. Free-form names also work (substring match).',
          },
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional keyword/phrase substring filters (case-insensitive).',
          },
          perTableLimit: { type: 'number', description: 'Max rows per source table (default 60, max 200).' },
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchByKeyword',
      description:
        'Search the archive by keywords / phrases across content fields, optionally constrained by date or sources. Use for topic questions ("what about Iran sanctions") or when the user names an entity.',
      parameters: {
        type: 'object',
        properties: {
          keywords: { type: 'array', items: { type: 'string' }, description: 'Required keyword/phrase list (OR-combined, substring match).' },
          from: { type: 'string', description: 'Optional ISO start datetime.' },
          to: { type: 'string', description: 'Optional ISO end datetime.' },
          sources: { type: 'array', items: { type: 'string', enum: SOURCE_ENUM } },
          authors: { type: 'array', items: { type: 'string' } },
          perTableLimit: { type: 'number' },
        },
        required: ['keywords'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getFullText',
      description: 'Fetch the untruncated body for one or more refIds returned by searchByDate or searchByKeyword. Use when you need the verbatim text of a Truth Social post, X post, article, etc.',
      parameters: {
        type: 'object',
        properties: {
          refIds: { type: 'array', items: { type: 'string' }, description: 'List of refIds (e.g. "truth_social:abc-123").' },
        },
        required: ['refIds'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listSourcesInWindow',
      description:
        'For a given date window, returns the count of items in EACH source table. Use this BEFORE writing your final answer so you can explicitly enumerate which sources had hits and which had zero matches (e.g., "no Dataminr alerts on this date").',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'ISO start datetime.' },
          to: { type: 'string', description: 'ISO end datetime.' },
        },
        required: ['from', 'to'],
      },
    },
  },
];

// Curated-only tool. Appended to TOOLS ONLY when the route injects a curated
// provider (i.e. on the Curated view for a viewer with access). It never touches
// the shared archive tables; it returns the trust-tagged curated Top Stories.
const CURATED_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'searchCuratedTopStories',
    description:
      'Search the CURATED "Top Stories" — the AI-clustered, corroboration-checked stories currently shown on the Curated view the user is looking at. Each returned story SEPARATES `corroboratedFacts`/`summary` (cross-checked across multiple independent trusted outlets — you MAY state these as fact) from `attributedClaims` and per-source `spin` (single-source, official-primary, opinion/social, or adversary/state-media framing — you MUST attribute these by outlet and NEVER present them as verified fact). Each source carries `trustClass` and `verifiedForFacts`. Use this for any question about the current curated Top Stories / what the curated view is showing.',
    parameters: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional case-insensitive keyword/phrase filters (matched over headline, facts, claims, and source). Omit to list all current curated Top Stories.',
        },
      },
    },
  },
};

/**
 * Assemble the tool list. When `hasCurated` is false this returns the SAME base
 * TOOLS reference used everywhere else (byte-identical on Stream/Team/custom
 * MCOP). The curated tool is only appended when a provider is present.
 */
export function buildMcopBotTools(hasCurated: boolean): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return hasCurated ? [...TOOLS, CURATED_TOOL] : TOOLS;
}

export function buildSystemPrompt(hasCurated: boolean = false): string {
  const sourceList = ALL_SOURCE_TABLES.map(s => `- \`${s}\` — ${SOURCE_TABLE_DESCRIPTIONS[s]}`).join('\n');
  const today = new Date().toISOString();
  const base = `You are MCOP Bot, an AI news analyst for U.S. military leadership. Your archive contains news headlines, team-submitted articles, presidential and senior-leader social media posts, Dataminr alerts, and AI-extracted quotes. Today is ${today}.

You answer questions by ITERATIVELY querying the archive with tools, then synthesizing a precise, source-cited answer.

## Available source tables
${sourceList}

## Method (ALWAYS follow)
1. Parse the question for a date window. If the user says "on April 23, 2026" → from=2026-04-23T00:00:00Z, to=2026-04-23T23:59:59Z. If they say "this week" use the past 7 days. If no time is implied, default to the past 7 days.
2. Parse the question for entities (POTUS, Hegseth, CENTCOM, sentdefender, etc.) — pass them as \`authors\`. Use canonical aliases listed in the tool description.
3. Call \`searchByDate\` and/or \`searchByKeyword\` to gather candidate items. You may call them multiple times with different filters (e.g., once for POTUS Truth Social, again for X spokespersons, again for headlines).
4. Call \`getFullText\` for the most relevant refIds (max ${MAX_FULL_TEXT_FETCHES}) so you can quote VERBATIM rather than from snippets.
5. Call \`listSourcesInWindow\` if the question is date-bounded — use the result to explicitly state which source tables had ZERO matches in that window.
6. Compose the final answer in Markdown.

## Answer format (REQUIRED)
- Use \`## H2\` section headers organized by source class (e.g., "POTUS (Truth Social)", "Senior military / White House echo", "CENTCOM-attributed reporting", "Dataminr First Alerts", "News headlines").
- Quote presidential, secretary, or CENTCOM statements VERBATIM with timestamp and date.
- Distinguish PRIMARY statements (POTUS, official CENTCOM/DoW/SecWar releases) from AMPLIFICATION (spokespersons, milblog accounts, news echo).
- After every section, list sources as bullets:
  \`- Source Name (date, time if same-day) - URL\`
- Always include the full https:// URL.
- If a source table you queried had ZERO matches in the window, state that explicitly in a "## Source coverage" section at the end. Example: "No Dataminr first alerts matched on April 23, 2026."
- Conclude with a short "## Bottom line" paragraph.
- Never invent quotes, URLs, or events. If something isn't in the archive, say so.
- Do NOT use emojis.

## Limits
- Max ${MAX_TOOL_ITERATIONS} tool iterations per question. Be efficient.
- Max ${MAX_FULL_TEXT_FETCHES} getFullText fetches per question.`;

  if (!hasCurated) return base;

  // Curated-view awareness + the misinformation safety contract. Appended ONLY
  // when the curated tool is available (route-authorized curated viewer).
  return base + `

## Curated Top Stories (you are on the Curated view)
You ALSO have \`searchCuratedTopStories\`, which returns the AI-clustered curated "Top Stories" currently shown on this view. For any question about the curated view or "the top stories right now", use this tool FIRST (the shared archive tools remain available for everything else).

Each curated story is trust-tagged. You MUST honor these tags — this is a hard safety rule, not a style preference:
- \`summary\` and \`corroboratedFacts\` were cross-checked across multiple independent, trusted outlets. You MAY state these as fact.
- \`attributedClaims\`, and anything traceable ONLY to a source whose \`trustClass\` is "attributed" (i.e. \`verifiedForFacts: false\` — single-source, official-primary, opinion/social, or adversary/state-media outlets), are NOT verified. You MUST present them as attributed statements and NEVER as verified fact. Say e.g. "According to <outlet>, ..." or "Iranian state media claimed ...".
- A source's \`spin\` is that outlet's own framing of the story. It is attribute-only; report it as "<outlet> framed this as ..." — never merge it into a factual assertion.
- NEVER present adversary, state-media, contrast, or low-factuality content as fact, and never blend an unverified claim into a corroborated one. When corroboration is thin or a claim comes only from an "attributed" source, say so explicitly.
- Cite outlet names from the \`sources\` list; include \`url\` when available.`;
}

interface ToolCallArgs {
  from?: string;
  to?: string;
  sources?: string[];
  authors?: string[];
  keywords?: string[];
  perTableLimit?: number;
  refIds?: string[];
}

function parseDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d;
}

function formatItemForModel(it: ArchiveItem): any {
  return {
    refId: it.refId,
    sourceTable: it.sourceTable,
    source: it.source,
    author: it.author,
    title: it.title,
    summary: it.summary || undefined,
    snippet: it.fullText ? (it.fullText.length > 400 ? it.fullText.slice(0, 400) + '…' : it.fullText) : undefined,
    url: it.url,
    date: it.date instanceof Date ? it.date.toISOString() : it.date,
    priorityScore: it.priorityScore ?? undefined,
  };
}

function formatFullItemForModel(it: ArchiveItem): any {
  return {
    refId: it.refId,
    sourceTable: it.sourceTable,
    source: it.source,
    author: it.author,
    title: it.title,
    summary: it.summary || undefined,
    fullText: it.fullText,
    url: it.url,
    date: it.date instanceof Date ? it.date.toISOString() : it.date,
  };
}

async function runTool(name: string, args: ToolCallArgs, fullTextBudget: { remaining: number }): Promise<any> {
  try {
    const sources = (args.sources?.filter(s => (ALL_SOURCE_TABLES as string[]).includes(s)) ?? []) as SourceTable[];
    if (name === 'searchByDate') {
      const fromDate = parseDate(args.from);
      const toDate = parseDate(args.to);
      if (!fromDate || !toDate) {
        return { error: "searchByDate requires valid ISO 'from' and 'to' datetimes (e.g. '2026-04-23T00:00:00Z')." };
      }
      if (fromDate > toDate) {
        return { error: "'from' must be <= 'to'." };
      }
      const items = await searchArchive({
        fromDate,
        toDate,
        sources: sources.length ? sources : undefined,
        authors: args.authors,
        keywords: args.keywords,
        perTableLimit: args.perTableLimit,
      });
      return { count: items.length, items: items.map(formatItemForModel) };
    }
    if (name === 'searchByKeyword') {
      const cleanKeywords = (args.keywords || []).map(k => String(k).trim()).filter(k => k.length >= 2);
      if (cleanKeywords.length === 0) {
        return { error: "searchByKeyword requires at least one keyword (>=2 chars)." };
      }
      const fromDate = parseDate(args.from);
      const toDate = parseDate(args.to);
      if ((args.from && !fromDate) || (args.to && !toDate)) {
        return { error: "If provided, 'from' and 'to' must be valid ISO datetimes." };
      }
      if (fromDate && toDate && fromDate > toDate) {
        return { error: "'from' must be <= 'to'." };
      }
      const items = await searchArchive({
        fromDate,
        toDate,
        sources: sources.length ? sources : undefined,
        authors: args.authors,
        keywords: cleanKeywords,
        perTableLimit: args.perTableLimit,
      });
      return { count: items.length, items: items.map(formatItemForModel) };
    }
    if (name === 'getFullText') {
      const refs = (args.refIds || []).filter(r => typeof r === 'string' && r.includes(':'));
      if (refs.length === 0) {
        return { error: "getFullText requires a non-empty refIds array of '<table>:<id>' strings." };
      }
      const requested = refs.slice(0, Math.max(0, fullTextBudget.remaining));
      fullTextBudget.remaining -= requested.length;
      if (requested.length === 0) return { error: 'getFullText budget exhausted for this turn.', items: [] };
      const items = await getFullTextByRefs(requested);
      return { count: items.length, items: items.map(formatFullItemForModel) };
    }
    if (name === 'listSourcesInWindow') {
      const fromDate = parseDate(args.from);
      const toDate = parseDate(args.to);
      if (!fromDate || !toDate) {
        return { error: "listSourcesInWindow requires valid ISO 'from' and 'to' datetimes." };
      }
      if (fromDate > toDate) {
        return { error: "'from' must be <= 'to'." };
      }
      const counts = await listSourcesInWindow(fromDate, toDate);
      return { window: { from: args.from, to: args.to }, counts };
    }
    return { error: `Unknown tool: ${name}` };
  } catch (e: any) {
    console.error(`[MCOPBot] tool ${name} failed:`, e);
    return { error: `Tool ${name} failed: ${e?.message || e}` };
  }
}

async function answerWithOpenRouter(query: string, curatedProvider?: CuratedStoriesProvider): Promise<string> {
  if (!openrouter) throw new Error('OpenRouter not configured');
  const hasCurated = !!curatedProvider;
  const tools = buildMcopBotTools(hasCurated);
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(hasCurated) },
    { role: 'user', content: query },
  ];
  const fullTextBudget = { remaining: MAX_FULL_TEXT_FETCHES };
  // Fetch the curated Top Stories at most once per question (lazily, on first
  // use of the curated tool) and reuse across tool iterations.
  let curatedCache: CuratedStoryForModel[] | null = null;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    assertAIIntegrationsEnabled();
    const resp = await openrouter.chat.completions.create({
      model: OPENROUTER_MODEL,
      messages,
      tools,
      tool_choice: iter === MAX_TOOL_ITERATIONS - 1 ? 'none' : 'auto',
      max_tokens: 4096,
    });

    const msg = resp.choices[0]?.message;
    if (!msg) return 'I could not generate a response. Please try again.';

    // Push the assistant message (preserving tool_calls)
    messages.push({
      role: 'assistant',
      content: msg.content || '',
      tool_calls: msg.tool_calls,
    } as any);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content || 'I could not generate a response. Please try again.';
    }

    for (const tc of msg.tool_calls) {
      if ((tc as any).type !== 'function' || !(tc as any).function) continue;
      const fn = (tc as any).function as { name: string; arguments?: string };
      let parsed: ToolCallArgs = {};
      try {
        parsed = JSON.parse(fn.arguments || '{}');
      } catch {
        parsed = {};
      }
      let result: any;
      if (fn.name === 'searchCuratedTopStories' && curatedProvider) {
        // Curated-only tool: never routed through runTool (shared archive) — it
        // reads only the injected, trust-tagged curated Top Stories.
        if (curatedCache === null) {
          try {
            curatedCache = await curatedProvider();
          } catch (e: any) {
            curatedCache = [];
            console.error('[MCOPBot] curated provider failed:', e?.message || e);
          }
        }
        const filtered = filterCuratedStories(curatedCache, parsed.keywords);
        result = { count: filtered.length, stories: filtered };
      } else {
        result = await runTool(fn.name, parsed, fullTextBudget);
      }
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result).slice(0, 80000),
      } as any);
    }
  }

  // Final attempt without tools to force a textual answer
  assertAIIntegrationsEnabled();
  const finalResp = await openrouter.chat.completions.create({
    model: OPENROUTER_MODEL,
    messages,
    max_tokens: 4096,
  });
  return finalResp.choices[0]?.message?.content || 'I could not generate a response after the max tool iterations.';
}

// Legacy fallback: single-shot context blob via direct Anthropic.
async function answerWithLegacyAnthropic(query: string): Promise<string> {
  assertAIIntegrationsEnabled();
  const items = await searchArchive({ perTableLimit: 50, totalLimit: 250 });
  if (items.length === 0) {
    return "I don't have any news articles to search through yet. Once articles are submitted or scraped, I'll be able to answer questions about them.";
  }
  const context = items.slice(0, 200).map((it, idx) => {
    const date = new Date(it.date).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    return `[REF ${idx + 1}] [${it.sourceTable}] ${date}\nSource: ${it.source}${it.author ? ` (${it.author})` : ''}\nTitle: ${it.title}\n${it.summary ? `Summary: ${it.summary}\n` : ''}${it.fullText ? `Text: ${it.fullText.slice(0, 1500)}\n` : ''}URL: ${it.url}`;
  }).join('\n---\n');

  assertAIIntegrationsEnabled();
  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2048,
    system: `You are MCOP Bot. Answer based ONLY on the archive below (${items.length} items). Use Markdown headings, list sources after each section as bullets with full URL, and report absences explicitly.\n\n${context}`,
    messages: [{ role: 'user', content: query }],
  });
  const tc = response.content.find(c => c.type === 'text');
  return tc?.text || "I couldn't generate a response. Please try again.";
}

export async function answerQuestion(
  query: string,
  opts?: { curatedProvider?: CuratedStoriesProvider },
): Promise<string> {
  assertAIIntegrationsEnabled();
  // Curated awareness is opt-in and route-gated: the tool + safety prompt are
  // only active when the route injects a provider. The legacy single-shot
  // fallback stays curated-unaware (it reads only the shared archive) — a safe,
  // fail-closed degrade if OpenRouter is unavailable.
  const curatedProvider = opts?.curatedProvider;
  try {
    if (openrouter) {
      return await answerWithOpenRouter(query, curatedProvider);
    }
    console.warn('[MCOPBot] OpenRouter not configured, falling back to direct Anthropic (no tool use).');
    return await answerWithLegacyAnthropic(query);
  } catch (error: any) {
    console.error('MCOP Bot error:', error);
    if (openrouter) {
      console.warn('[MCOPBot] OpenRouter path failed, attempting legacy fallback…');
      try {
        return await answerWithLegacyAnthropic(query);
      } catch (fallbackErr) {
        console.error('[MCOPBot] legacy fallback also failed:', fallbackErr);
      }
    }
    throw error;
  }
}
