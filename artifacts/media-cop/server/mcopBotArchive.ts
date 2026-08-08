import { db } from './db';
import { sql, and, gte, lte, or, ilike, inArray, notInArray, desc, eq, isNull } from 'drizzle-orm';
import { CURATED_ONLY_OSINT_HANDLES } from './curatedOnlyOsint';
import {
  teamSubmissions,
  manualSubmissions,
  headlines,
  rssBotPosts,
  truthSocialPosts,
  relayTruthSocialPosts,
  xPosts,
  rapidResponsePosts,
  dowResponsePosts,
  sentDefenderPosts,
  osintPosts,
  flightTrackingPosts,
  firstAlerts,
  articleQuotes,
} from '@shared/schema';

export type SourceTable =
  | 'team_submission'
  | 'mcop_feed'
  | 'headline'
  | 'rss_bot'
  | 'truth_social'
  | 'truth_social_relay'
  | 'x_post'
  | 'rapid_response'
  | 'dow_response'
  | 'sentdefender'
  | 'osint'
  | 'flight_tracking'
  | 'first_alert'
  | 'article_quote';

export const ALL_SOURCE_TABLES: SourceTable[] = [
  'team_submission',
  'mcop_feed',
  'headline',
  'rss_bot',
  'truth_social',
  'truth_social_relay',
  'x_post',
  'rapid_response',
  'dow_response',
  'sentdefender',
  'osint',
  'flight_tracking',
  'first_alert',
  'article_quote',
];

export const SOURCE_TABLE_DESCRIPTIONS: Record<SourceTable, string> = {
  team_submission: 'Team-submitted articles (analyst-curated, has full text)',
  mcop_feed: 'Manual MCOP feed submissions',
  headline: 'Scraped headlines (Drudge, Fox, AP, Reuters, BBC, NPR, etc.)',
  rss_bot: 'RSS Feed Monitor bot posts (curated defense/military RSS)',
  truth_social: 'Donald Trump (POTUS) posts on Truth Social — scraped',
  truth_social_relay: 'Donald Trump (POTUS) posts on Truth Social — Google VM relay (primary)',
  x_post: 'X/Twitter posts from official accounts (SecWar, Hegseth, Parnell, etc.)',
  rapid_response: 'White House Rapid Response 47 X posts',
  dow_response: 'Department of War (DoW) response X posts',
  sentdefender: 'sentdefender milblog X posts (open-source military monitoring)',
  osint: 'OSINT-category X posts',
  flight_tracking: 'Flight-tracker X posts',
  first_alert: 'Dataminr First Alert API alerts',
  article_quote: 'AI-extracted quotes from team submissions (speaker, quote, context)',
};

export interface ArchiveItem {
  refId: string;
  sourceTable: SourceTable;
  source: string;
  author: string | null;
  title: string;
  summary: string | null;
  fullText: string | null;
  url: string;
  date: Date;
  priorityScore: number | null;
}

export interface SearchOptions {
  fromDate?: Date;
  toDate?: Date;
  sources?: SourceTable[];
  authors?: string[];
  keywords?: string[];
  perTableLimit?: number;
  totalLimit?: number;
}

const DEFAULT_PER_TABLE_LIMIT = 60;
const DEFAULT_TOTAL_LIMIT = 250;
const SNIPPET_LEN = 280;

function snippet(text: string | null | undefined, n = SNIPPET_LEN): string {
  if (!text) return '';
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function authorMatchesIlike(authorCol: any, authors: string[]) {
  return or(...authors.map(a => ilike(authorCol, `%${a}%`)));
}

function keywordOr(cols: any[], keywords: string[]) {
  const clauses: any[] = [];
  for (const k of keywords) {
    const term = `%${k}%`;
    for (const c of cols) clauses.push(ilike(c, term));
  }
  return or(...clauses);
}

const CANONICAL_AUTHOR_ALIASES: Record<string, { sourceTable: SourceTable; match: string }[]> = {
  potus: [
    { sourceTable: 'truth_social', match: 'realDonaldTrump' },
    { sourceTable: 'truth_social_relay', match: 'realDonaldTrump' },
  ],
  trump: [
    { sourceTable: 'truth_social', match: 'realDonaldTrump' },
    { sourceTable: 'truth_social_relay', match: 'realDonaldTrump' },
  ],
  hegseth: [{ sourceTable: 'x_post', match: 'PeteHegseth' }],
  'sec war': [{ sourceTable: 'x_post', match: 'SecWar' }],
  secwar: [{ sourceTable: 'x_post', match: 'SecWar' }],
  parnell: [{ sourceTable: 'x_post', match: 'SeanParnellASW' }],
  sentdefender: [{ sourceTable: 'sentdefender', match: '' }],
  'rapid response': [{ sourceTable: 'rapid_response', match: '' }],
  rapidresponse: [{ sourceTable: 'rapid_response', match: '' }],
  dow: [{ sourceTable: 'dow_response', match: '' }],
  centcom: [
    { sourceTable: 'x_post', match: 'CENTCOM' },
    { sourceTable: 'osint', match: 'CENTCOM' },
  ],
};

export function expandAuthors(
  authors: string[] | undefined
): { sourceFilter?: SourceTable[]; authorTerms: string[] } {
  if (!authors || authors.length === 0) return { authorTerms: [] };
  const sourceFilter = new Set<SourceTable>();
  const authorTerms = new Set<string>();
  let hadAlias = false;
  for (const a of authors) {
    const key = a.toLowerCase().trim();
    const alias = CANONICAL_AUTHOR_ALIASES[key];
    if (alias) {
      hadAlias = true;
      for (const m of alias) {
        sourceFilter.add(m.sourceTable);
        if (m.match) authorTerms.add(m.match);
      }
    } else {
      authorTerms.add(a);
    }
  }
  return {
    sourceFilter: hadAlias ? Array.from(sourceFilter) : undefined,
    authorTerms: Array.from(authorTerms),
  };
}

function makeRefId(table: SourceTable, id: string): string {
  return `${table}:${id}`;
}

export function parseRefId(refId: string): { table: SourceTable; id: string } | null {
  const i = refId.indexOf(':');
  if (i < 0) return null;
  const table = refId.slice(0, i) as SourceTable;
  const id = refId.slice(i + 1);
  if (!ALL_SOURCE_TABLES.includes(table)) return null;
  return { table, id };
}

export async function searchArchive(opts: SearchOptions): Promise<ArchiveItem[]> {
  const fromDate = opts.fromDate;
  const toDate = opts.toDate;
  const perTableLimit = Math.min(opts.perTableLimit ?? DEFAULT_PER_TABLE_LIMIT, 200);
  const totalLimit = Math.min(opts.totalLimit ?? DEFAULT_TOTAL_LIMIT, 800);

  const expandedAuthors = expandAuthors(opts.authors);
  let activeSources: SourceTable[] = opts.sources && opts.sources.length > 0
    ? opts.sources.filter(s => ALL_SOURCE_TABLES.includes(s))
    : [...ALL_SOURCE_TABLES];
  if (expandedAuthors.sourceFilter) {
    const restrict = new Set(expandedAuthors.sourceFilter);
    activeSources = activeSources.filter(s => restrict.has(s));
  }
  const authorTerms = expandedAuthors.authorTerms;
  const keywords = (opts.keywords ?? []).filter(k => k && k.trim().length >= 2);

  const results: ArchiveItem[] = [];
  const queries: Promise<ArchiveItem[]>[] = [];

  const addRange = (col: any, conditions: any[]) => {
    if (fromDate) conditions.push(gte(col, fromDate));
    if (toDate) conditions.push(lte(col, toDate));
  };

  // team_submissions
  if (activeSources.includes('team_submission')) {
    queries.push((async () => {
      const where: any[] = [isNull(teamSubmissions.deletedAt), eq(teamSubmissions.isQuestionable, false)];
      addRange(teamSubmissions.createdAt, where);
      if (authorTerms.length) where.push(authorMatchesIlike(teamSubmissions.submittedByName, authorTerms));
      if (keywords.length) where.push(keywordOr([teamSubmissions.headline, teamSubmissions.summary, teamSubmissions.fullText], keywords));
      const rows = await db.select({
        id: teamSubmissions.id,
        title: teamSubmissions.headline,
        summary: teamSubmissions.summary,
        fullText: teamSubmissions.fullText,
        url: teamSubmissions.sourceUrl,
        source: teamSubmissions.sourceName,
        author: teamSubmissions.submittedByName,
        date: teamSubmissions.createdAt,
        priorityScore: teamSubmissions.priorityScore,
      }).from(teamSubmissions).where(and(...where)).orderBy(desc(teamSubmissions.createdAt)).limit(perTableLimit);
      return rows.map(r => ({
        refId: makeRefId('team_submission', r.id),
        sourceTable: 'team_submission' as SourceTable,
        source: r.source || 'Team Submission',
        author: r.author,
        title: r.title,
        summary: r.summary,
        fullText: r.fullText,
        url: r.url,
        date: r.date || new Date(),
        priorityScore: r.priorityScore,
      }));
    })());
  }

  // manual_submissions
  if (activeSources.includes('mcop_feed')) {
    queries.push((async () => {
      const where: any[] = [];
      addRange(manualSubmissions.submittedAt, where);
      if (authorTerms.length) where.push(authorMatchesIlike(manualSubmissions.submittedBy, authorTerms));
      if (keywords.length) where.push(keywordOr([manualSubmissions.title, manualSubmissions.summary], keywords));
      const q = db.select({
        id: manualSubmissions.id,
        title: manualSubmissions.title,
        summary: manualSubmissions.summary,
        url: manualSubmissions.url,
        source: manualSubmissions.source,
        author: manualSubmissions.submittedBy,
        date: manualSubmissions.submittedAt,
        priorityScore: manualSubmissions.priorityScore,
      }).from(manualSubmissions);
      const rows = await (where.length ? q.where(and(...where)) : q).orderBy(desc(manualSubmissions.submittedAt)).limit(perTableLimit);
      return rows.map(r => ({
        refId: makeRefId('mcop_feed', r.id),
        sourceTable: 'mcop_feed' as SourceTable,
        source: r.source,
        author: r.author,
        title: r.title,
        summary: r.summary,
        fullText: null,
        url: r.url,
        date: r.date || new Date(),
        priorityScore: r.priorityScore,
      }));
    })());
  }

  // headlines
  if (activeSources.includes('headline')) {
    queries.push((async () => {
      const where: any[] = [
        // Exclude headlines restricted to a specific MCOP (e.g. Warfighter-only
        // outlets like The Blaze/Epoch Times/Daily Wire) from the global bot
        // archive — they should only appear inside their own MCOP surface.
        sql`${headlines.restrictedToMcops} IS NULL`,
      ];
      addRange(headlines.scrapedAt, where);
      if (authorTerms.length) where.push(authorMatchesIlike(headlines.source, authorTerms));
      if (keywords.length) where.push(keywordOr([headlines.title, headlines.summary], keywords));
      const q = db.select({
        id: headlines.id,
        title: headlines.title,
        summary: headlines.summary,
        url: headlines.url,
        source: headlines.source,
        date: headlines.scrapedAt,
        priorityScore: headlines.priorityScore,
      }).from(headlines);
      const rows = await q.where(and(...where)).orderBy(desc(headlines.scrapedAt)).limit(perTableLimit);
      return rows.map(r => ({
        refId: makeRefId('headline', r.id),
        sourceTable: 'headline' as SourceTable,
        source: r.source,
        author: null,
        title: r.title,
        summary: r.summary,
        fullText: null,
        url: r.url,
        date: r.date || new Date(),
        priorityScore: r.priorityScore,
      }));
    })());
  }

  // rss_bot_posts
  if (activeSources.includes('rss_bot')) {
    queries.push((async () => {
      const where: any[] = [];
      addRange(rssBotPosts.postedAt, where);
      if (authorTerms.length) where.push(authorMatchesIlike(rssBotPosts.sourceName, authorTerms));
      if (keywords.length) where.push(keywordOr([rssBotPosts.articleTitle, rssBotPosts.summary], keywords));
      const q = db.select({
        id: rssBotPosts.id,
        title: rssBotPosts.articleTitle,
        summary: rssBotPosts.summary,
        url: rssBotPosts.articleUrl,
        source: rssBotPosts.sourceName,
        date: rssBotPosts.postedAt,
      }).from(rssBotPosts);
      const rows = await (where.length ? q.where(and(...where)) : q).orderBy(desc(rssBotPosts.postedAt)).limit(perTableLimit);
      return rows.map(r => ({
        refId: makeRefId('rss_bot', r.id),
        sourceTable: 'rss_bot' as SourceTable,
        source: r.source,
        author: null,
        title: r.title,
        summary: r.summary,
        fullText: null,
        url: r.url,
        date: r.date || new Date(),
        priorityScore: null,
      }));
    })());
  }

  // truth_social_posts
  if (activeSources.includes('truth_social')) {
    queries.push((async () => {
      const where: any[] = [eq(truthSocialPosts.isHidden, false)];
      addRange(truthSocialPosts.postedAt, where);
      if (keywords.length) where.push(keywordOr([truthSocialPosts.content, truthSocialPosts.extractedImageText], keywords));
      const rows = await db.select({
        id: truthSocialPosts.id,
        content: truthSocialPosts.content,
        url: truthSocialPosts.truthSocialUrl,
        date: truthSocialPosts.postedAt,
        extractedImageText: truthSocialPosts.extractedImageText,
        isReblog: truthSocialPosts.isReblog,
        rebloggedFrom: truthSocialPosts.rebloggedFrom,
      }).from(truthSocialPosts).where(and(...where)).orderBy(desc(truthSocialPosts.postedAt)).limit(perTableLimit);
      return rows.map(r => {
        const fullText = (r.content || '') + (r.extractedImageText ? `\n[Image text: ${r.extractedImageText}]` : '');
        return {
          refId: makeRefId('truth_social', r.id),
          sourceTable: 'truth_social' as SourceTable,
          source: 'Truth Social',
          author: r.isReblog && r.rebloggedFrom ? `realDonaldTrump (reblog of ${r.rebloggedFrom})` : 'realDonaldTrump',
          title: snippet(fullText, 120),
          summary: null,
          fullText,
          url: r.url,
          date: r.date,
          priorityScore: null,
        };
      });
    })());
  }

  // relay_truth_social_posts
  if (activeSources.includes('truth_social_relay')) {
    queries.push((async () => {
      const where: any[] = [];
      addRange(relayTruthSocialPosts.postedAt, where);
      if (keywords.length) where.push(keywordOr([relayTruthSocialPosts.content], keywords));
      const q = db.select({
        id: relayTruthSocialPosts.id,
        content: relayTruthSocialPosts.content,
        url: relayTruthSocialPosts.truthSocialUrl,
        date: relayTruthSocialPosts.postedAt,
        isReblog: relayTruthSocialPosts.isReblog,
        rebloggedFrom: relayTruthSocialPosts.rebloggedFrom,
      }).from(relayTruthSocialPosts);
      const rows = await (where.length ? q.where(and(...where)) : q).orderBy(desc(relayTruthSocialPosts.postedAt)).limit(perTableLimit);
      return rows.map(r => ({
        refId: makeRefId('truth_social_relay', r.id),
        sourceTable: 'truth_social_relay' as SourceTable,
        source: 'Truth Social (Relay)',
        author: r.isReblog && r.rebloggedFrom ? `realDonaldTrump (reblog of ${r.rebloggedFrom})` : 'realDonaldTrump',
        title: snippet(r.content, 120),
        summary: null,
        fullText: r.content,
        url: r.url,
        date: r.date,
        priorityScore: null,
      }));
    })());
  }

  // x_posts
  if (activeSources.includes('x_post')) {
    queries.push((async () => {
      const where: any[] = [eq(xPosts.isHidden, false)];
      addRange(xPosts.postedAt, where);
      if (authorTerms.length) where.push(authorMatchesIlike(xPosts.sourceAccount, authorTerms));
      if (keywords.length) where.push(keywordOr([xPosts.content], keywords));
      const rows = await db.select({
        id: xPosts.id,
        content: xPosts.content,
        url: xPosts.xUrl,
        date: xPosts.postedAt,
        sourceAccount: xPosts.sourceAccount,
      }).from(xPosts).where(and(...where)).orderBy(desc(xPosts.postedAt)).limit(perTableLimit);
      return rows.map(r => ({
        refId: makeRefId('x_post', r.id),
        sourceTable: 'x_post' as SourceTable,
        source: `X/${r.sourceAccount}`,
        author: r.sourceAccount,
        title: snippet(r.content, 120),
        summary: null,
        fullText: r.content,
        url: r.url,
        date: r.date,
        priorityScore: null,
      }));
    })());
  }

  // simple X-style tables: rapid_response, dow_response, sentdefender, osint, flight_tracking
  const simpleXTables: Array<{
    src: SourceTable;
    tbl: any;
    label: string;
    author: string;
    sourceAccountCol?: any;
  }> = [
    { src: 'rapid_response', tbl: rapidResponsePosts, label: 'X/RapidResponse47', author: 'RapidResponse47' },
    { src: 'dow_response', tbl: dowResponsePosts, label: 'X/DeptofWar', author: 'DeptofWar' },
    { src: 'sentdefender', tbl: sentDefenderPosts, label: 'X/sentdefender', author: 'sentdefender' },
    { src: 'osint', tbl: osintPosts, label: 'X/OSINT', author: 'OSINT', sourceAccountCol: osintPosts.sourceAccount },
    { src: 'flight_tracking', tbl: flightTrackingPosts, label: 'X/FlightTracking', author: 'FlightTracking', sourceAccountCol: flightTrackingPosts.sourceAccount },
  ];
  for (const t of simpleXTables) {
    if (!activeSources.includes(t.src)) continue;
    queries.push((async () => {
      const where: any[] = [];
      // isHidden col exists on these tables
      if ('isHidden' in t.tbl) where.push(eq((t.tbl as any).isHidden, false));
      addRange(t.tbl.postedAt, where);
      // Combatant-command handles are curated-only — exclude from MCOP Bot search.
      if (t.src === 'osint') where.push(notInArray(osintPosts.sourceAccount, [...CURATED_ONLY_OSINT_HANDLES]));
      if (authorTerms.length && t.sourceAccountCol) {
        where.push(authorMatchesIlike(t.sourceAccountCol, authorTerms));
      }
      if (keywords.length) where.push(keywordOr([t.tbl.content], keywords));
      const q = db.select({
        id: t.tbl.id,
        content: t.tbl.content,
        url: t.tbl.xUrl,
        date: t.tbl.postedAt,
        sourceAccount: t.sourceAccountCol ?? sql<string>`${t.author}`.as('source_account'),
      }).from(t.tbl);
      const rows = await (where.length ? q.where(and(...where)) : q).orderBy(desc(t.tbl.postedAt)).limit(perTableLimit);
      return rows.map((r: any) => ({
        refId: makeRefId(t.src, r.id),
        sourceTable: t.src,
        source: t.label,
        author: (r.sourceAccount as string) || t.author,
        title: snippet(r.content, 120),
        summary: null,
        fullText: r.content,
        url: r.url,
        date: r.date,
        priorityScore: null,
      }));
    })());
  }

  // first_alerts
  if (activeSources.includes('first_alert')) {
    queries.push((async () => {
      const where: any[] = [];
      addRange(firstAlerts.publishedAt, where);
      if (keywords.length) where.push(keywordOr([firstAlerts.headline, firstAlerts.subHeadline, firstAlerts.publicPostText, firstAlerts.location], keywords));
      const q = db.select({
        id: firstAlerts.id,
        title: firstAlerts.headline,
        sub: firstAlerts.subHeadline,
        url: firstAlerts.url,
        date: firstAlerts.publishedAt,
        location: firstAlerts.location,
        publicPostText: firstAlerts.publicPostText,
        alertType: firstAlerts.alertType,
      }).from(firstAlerts);
      const rows = await (where.length ? q.where(and(...where)) : q).orderBy(desc(firstAlerts.publishedAt)).limit(perTableLimit);
      return rows.map(r => {
        const parts = [r.sub, r.location ? `Location: ${r.location}` : '', r.publicPostText ? `Public post: ${r.publicPostText}` : ''].filter(Boolean);
        const fullText = parts.join('\n');
        return {
          refId: makeRefId('first_alert', r.id),
          sourceTable: 'first_alert' as SourceTable,
          source: r.alertType ? `Dataminr First Alert (${r.alertType})` : 'Dataminr First Alert',
          author: null,
          title: r.title,
          summary: r.sub,
          fullText: fullText || null,
          url: r.url,
          date: r.date,
          priorityScore: null,
        };
      });
    })());
  }

  // article_quotes
  if (activeSources.includes('article_quote')) {
    queries.push((async () => {
      const where: any[] = [];
      const dateCol = sql`COALESCE(${articleQuotes.dateSpoken}, ${articleQuotes.createdAt})`;
      if (fromDate) where.push(gte(dateCol as any, fromDate));
      if (toDate) where.push(lte(dateCol as any, toDate));
      if (authorTerms.length) where.push(authorMatchesIlike(articleQuotes.normalizedSpeaker, authorTerms.map(a => a.toLowerCase())));
      if (keywords.length) where.push(keywordOr([articleQuotes.quoteText, articleQuotes.context, articleQuotes.event], keywords));
      const q = db.select({
        id: articleQuotes.id,
        quote: articleQuotes.quoteText,
        speaker: articleQuotes.speakerName,
        speakerTitle: articleQuotes.speakerTitle,
        location: articleQuotes.location,
        event: articleQuotes.event,
        context: articleQuotes.context,
        url: articleQuotes.sourceUrl,
        dateSpoken: articleQuotes.dateSpoken,
        createdAt: articleQuotes.createdAt,
      }).from(articleQuotes);
      const rows = await (where.length ? q.where(and(...where)) : q).orderBy(desc(sql`COALESCE(${articleQuotes.dateSpoken}, ${articleQuotes.createdAt})`)).limit(perTableLimit);
      return rows.map(r => {
        const fullText = `"${r.quote}"\n— ${r.speaker}${r.speakerTitle ? `, ${r.speakerTitle}` : ''}${r.event ? ` (${r.event})` : ''}${r.location ? ` — ${r.location}` : ''}\nContext: ${r.context}`;
        return {
          refId: makeRefId('article_quote', r.id),
          sourceTable: 'article_quote' as SourceTable,
          source: 'Article Quote',
          author: r.speaker,
          title: `${r.speaker}: "${snippet(r.quote, 100)}"`,
          summary: r.context,
          fullText,
          url: r.url,
          date: r.dateSpoken || r.createdAt,
          priorityScore: null,
        };
      });
    })());
  }

  const settled = await Promise.allSettled(queries);
  for (const s of settled) {
    if (s.status === 'fulfilled') results.push(...s.value);
    else console.error('[mcopBotArchive] sub-query failed:', s.reason);
  }

  results.sort((a, b) => b.date.getTime() - a.date.getTime());
  return results.slice(0, totalLimit);
}

export async function listSourcesInWindow(fromDate?: Date, toDate?: Date): Promise<Record<SourceTable, number>> {
  const counts: Record<string, number> = {};
  for (const t of ALL_SOURCE_TABLES) counts[t] = 0;

  const tableMeta: Array<{ src: SourceTable; tbl: any; dateCol: any }> = [
    { src: 'team_submission', tbl: teamSubmissions, dateCol: teamSubmissions.createdAt },
    { src: 'mcop_feed', tbl: manualSubmissions, dateCol: manualSubmissions.submittedAt },
    { src: 'headline', tbl: headlines, dateCol: headlines.scrapedAt },
    { src: 'rss_bot', tbl: rssBotPosts, dateCol: rssBotPosts.postedAt },
    { src: 'truth_social', tbl: truthSocialPosts, dateCol: truthSocialPosts.postedAt },
    { src: 'truth_social_relay', tbl: relayTruthSocialPosts, dateCol: relayTruthSocialPosts.postedAt },
    { src: 'x_post', tbl: xPosts, dateCol: xPosts.postedAt },
    { src: 'rapid_response', tbl: rapidResponsePosts, dateCol: rapidResponsePosts.postedAt },
    { src: 'dow_response', tbl: dowResponsePosts, dateCol: dowResponsePosts.postedAt },
    { src: 'sentdefender', tbl: sentDefenderPosts, dateCol: sentDefenderPosts.postedAt },
    { src: 'osint', tbl: osintPosts, dateCol: osintPosts.postedAt },
    { src: 'flight_tracking', tbl: flightTrackingPosts, dateCol: flightTrackingPosts.postedAt },
    { src: 'first_alert', tbl: firstAlerts, dateCol: firstAlerts.publishedAt },
    { src: 'article_quote', tbl: articleQuotes, dateCol: sql`COALESCE(${articleQuotes.dateSpoken}, ${articleQuotes.createdAt})` },
  ];

  await Promise.all(tableMeta.map(async ({ src, tbl, dateCol }) => {
    try {
      const where: any[] = [];
      if (fromDate) where.push(gte(dateCol as any, fromDate));
      if (toDate) where.push(lte(dateCol as any, toDate));
      // Combatant-command handles are curated-only — exclude from MCOP Bot source counts.
      if (src === 'osint') where.push(notInArray(osintPosts.sourceAccount, [...CURATED_ONLY_OSINT_HANDLES]));
      const q = db.select({ c: sql<number>`count(*)::int` }).from(tbl);
      const rows = where.length ? await q.where(and(...where)) : await q;
      counts[src] = Number(rows[0]?.c ?? 0);
    } catch (e) {
      console.error(`[mcopBotArchive] count ${src} failed:`, e);
      counts[src] = 0;
    }
  }));

  return counts as Record<SourceTable, number>;
}

export async function getFullTextByRefs(refIds: string[]): Promise<ArchiveItem[]> {
  const grouped = new Map<SourceTable, string[]>();
  for (const r of refIds.slice(0, 30)) {
    const parsed = parseRefId(r);
    if (!parsed) continue;
    if (!grouped.has(parsed.table)) grouped.set(parsed.table, []);
    grouped.get(parsed.table)!.push(parsed.id);
  }
  const out: ArchiveItem[] = [];
  const tasks: Promise<void>[] = [];

  const fetch = async (table: SourceTable, ids: string[]) => {
    const items = await searchArchive({ sources: [table], perTableLimit: 200, totalLimit: 200 });
    for (const it of items) {
      const idOnly = it.refId.split(':').slice(1).join(':');
      if (ids.includes(idOnly)) out.push(it);
    }
  };

  // Direct fetch by id is faster — do it per table
  for (const [table, ids] of Array.from(grouped.entries())) {
    tasks.push((async () => {
      try {
        const items = await fetchByIds(table, ids);
        out.push(...items);
      } catch (e) {
        console.error(`[mcopBotArchive] fetch ${table} ids failed`, e);
      }
    })());
  }
  await Promise.all(tasks);
  return out;
}

async function fetchByIds(table: SourceTable, ids: string[]): Promise<ArchiveItem[]> {
  if (ids.length === 0) return [];
  switch (table) {
    case 'team_submission': {
      const rows = await db.select().from(teamSubmissions).where(inArray(teamSubmissions.id, ids));
      return rows.map(r => ({
        refId: makeRefId(table, r.id), sourceTable: table, source: r.sourceName || 'Team Submission',
        author: r.submittedByName, title: r.headline, summary: r.summary, fullText: r.fullText,
        url: r.sourceUrl, date: r.createdAt || new Date(), priorityScore: r.priorityScore,
      }));
    }
    case 'mcop_feed': {
      const rows = await db.select().from(manualSubmissions).where(inArray(manualSubmissions.id, ids));
      return rows.map(r => ({
        refId: makeRefId(table, r.id), sourceTable: table, source: r.source,
        author: r.submittedBy, title: r.title, summary: r.summary, fullText: null,
        url: r.url, date: r.submittedAt || new Date(), priorityScore: r.priorityScore,
      }));
    }
    case 'headline': {
      const rows = await db.select().from(headlines).where(inArray(headlines.id, ids));
      return rows.map(r => ({
        refId: makeRefId(table, r.id), sourceTable: table, source: r.source,
        author: null, title: r.title, summary: r.summary, fullText: null,
        url: r.url, date: r.scrapedAt || new Date(), priorityScore: r.priorityScore,
      }));
    }
    case 'rss_bot': {
      const rows = await db.select().from(rssBotPosts).where(inArray(rssBotPosts.id, ids));
      return rows.map(r => ({
        refId: makeRefId(table, r.id), sourceTable: table, source: r.sourceName,
        author: null, title: r.articleTitle, summary: r.summary, fullText: null,
        url: r.articleUrl, date: r.postedAt || new Date(), priorityScore: null,
      }));
    }
    case 'truth_social': {
      const rows = await db.select().from(truthSocialPosts).where(inArray(truthSocialPosts.id, ids));
      return rows.map(r => {
        const fullText = (r.content || '') + (r.extractedImageText ? `\n[Image text: ${r.extractedImageText}]` : '');
        return {
          refId: makeRefId(table, r.id), sourceTable: table, source: 'Truth Social',
          author: r.isReblog && r.rebloggedFrom ? `realDonaldTrump (reblog of ${r.rebloggedFrom})` : 'realDonaldTrump',
          title: snippet(fullText, 120), summary: null, fullText,
          url: r.truthSocialUrl, date: r.postedAt, priorityScore: null,
        };
      });
    }
    case 'truth_social_relay': {
      const rows = await db.select().from(relayTruthSocialPosts).where(inArray(relayTruthSocialPosts.id, ids));
      return rows.map(r => ({
        refId: makeRefId(table, r.id), sourceTable: table, source: 'Truth Social (Relay)',
        author: r.isReblog && r.rebloggedFrom ? `realDonaldTrump (reblog of ${r.rebloggedFrom})` : 'realDonaldTrump',
        title: snippet(r.content, 120), summary: null, fullText: r.content,
        url: r.truthSocialUrl, date: r.postedAt, priorityScore: null,
      }));
    }
    case 'x_post': {
      const rows = await db.select().from(xPosts).where(inArray(xPosts.id, ids));
      return rows.map(r => ({
        refId: makeRefId(table, r.id), sourceTable: table, source: `X/${r.sourceAccount}`,
        author: r.sourceAccount, title: snippet(r.content, 120), summary: null, fullText: r.content,
        url: r.xUrl, date: r.postedAt, priorityScore: null,
      }));
    }
    case 'rapid_response': case 'dow_response': case 'sentdefender': case 'osint': case 'flight_tracking': {
      const tbl = ({ rapid_response: rapidResponsePosts, dow_response: dowResponsePosts, sentdefender: sentDefenderPosts, osint: osintPosts, flight_tracking: flightTrackingPosts } as any)[table];
      const ftWhere: any[] = [inArray(tbl.id, ids)];
      // Combatant-command handles are curated-only — never retrievable via MCOP Bot getFullText.
      if (table === 'osint') ftWhere.push(notInArray(osintPosts.sourceAccount, [...CURATED_ONLY_OSINT_HANDLES]));
      const rows: any[] = await db.select().from(tbl).where(and(...ftWhere));
      const labels: Record<string, string> = { rapid_response: 'X/RapidResponse47', dow_response: 'X/DeptofWar', sentdefender: 'X/sentdefender', osint: 'X/OSINT', flight_tracking: 'X/FlightTracking' };
      const defaults: Record<string, string> = { rapid_response: 'RapidResponse47', dow_response: 'DeptofWar', sentdefender: 'sentdefender', osint: 'OSINT', flight_tracking: 'FlightTracking' };
      return rows.map(r => ({
        refId: makeRefId(table, r.id), sourceTable: table, source: labels[table],
        author: r.sourceAccount || defaults[table], title: snippet(r.content, 120), summary: null,
        fullText: r.content, url: r.xUrl, date: r.postedAt, priorityScore: null,
      }));
    }
    case 'first_alert': {
      const rows = await db.select().from(firstAlerts).where(inArray(firstAlerts.id, ids));
      return rows.map(r => {
        const parts = [r.subHeadline, r.location ? `Location: ${r.location}` : '', r.publicPostText ? `Public post: ${r.publicPostText}` : ''].filter(Boolean);
        const fullText = parts.join('\n');
        return {
          refId: makeRefId(table, r.id), sourceTable: table,
          source: r.alertType ? `Dataminr First Alert (${r.alertType})` : 'Dataminr First Alert',
          author: null, title: r.headline, summary: r.subHeadline, fullText: fullText || null,
          url: r.url, date: r.publishedAt, priorityScore: null,
        };
      });
    }
    case 'article_quote': {
      const rows = await db.select().from(articleQuotes).where(inArray(articleQuotes.id, ids));
      return rows.map(r => {
        const fullText = `"${r.quoteText}"\n— ${r.speakerName}${r.speakerTitle ? `, ${r.speakerTitle}` : ''}${r.event ? ` (${r.event})` : ''}${r.location ? ` — ${r.location}` : ''}\nContext: ${r.context}`;
        return {
          refId: makeRefId(table, r.id), sourceTable: table, source: 'Article Quote',
          author: r.speakerName, title: `${r.speakerName}: "${snippet(r.quoteText, 100)}"`,
          summary: r.context, fullText, url: r.sourceUrl, date: r.dateSpoken || r.createdAt, priorityScore: null,
        };
      });
    }
    default:
      return [];
  }
}
