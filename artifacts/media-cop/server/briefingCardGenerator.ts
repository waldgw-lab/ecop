import { db } from "./db";
import { storage } from "./storage";
import { teamSubmissions, teamSubjects } from "@shared/schema";
import { eq, and, gte, lte, isNull, desc, sql } from "drizzle-orm";
import {
  Document, Packer, Paragraph, TextRun, ExternalHyperlink,
  AlignmentType, PageOrientation, convertInchesToTwip,
} from "docx";
import { openai } from './aiClient';
import { formatInTimeZone } from "date-fns-tz";
import { stripBriefingPreamble } from './summarySanitizer';
import { normalizeIdentityUrl } from './urlIdentity';
import {
  buildOutletIndex, findOutlet, deriveOutletBehavior, deriveBehavior,
  ADVERSARY_COUNTRIES, isSocialFlashOutlet,
} from '@shared/outletRegistry';
import type { CuratedItem, TruthSocialPost, XPost, CompetingCoverageItem } from '@shared/schema';

const EASTERN_TZ = 'America/New_York';
const PURPLE_COLOR = "6B21A8";

// ──────────────────────────────────────────────────────────────────────────────
// Section keys
// ──────────────────────────────────────────────────────────────────────────────

export type SectionKey =
  | 'priorityBriefing'
  | 'topNarratives'
  | 'stateNarratives'
  | 'potusMessaging'
  | 'aerialView'
  | 'additionalIntelligence';

export const ALL_SECTIONS: SectionKey[] = [
  'priorityBriefing',
  'topNarratives',
  'stateNarratives',
  'potusMessaging',
  'aerialView',
  'additionalIntelligence',
];

export const SECTION_LABELS: Record<SectionKey, string> = {
  priorityBriefing: 'PRIORITY BRIEFING',
  topNarratives: 'TOP NARRATIVES',
  stateNarratives: 'STATE-CONTROLLED NARRATIVES',
  potusMessaging: 'POTUS & OFFICIAL MESSAGING',
  aerialView: 'AERIAL VIEW',
  additionalIntelligence: 'ADDITIONAL INTELLIGENCE',
};

// ──────────────────────────────────────────────────────────────────────────────
// Story / item interfaces
// ──────────────────────────────────────────────────────────────────────────────

interface BriefingStory {
  headline: string;
  bullets: string[];
  sourceName: string;
  sourceUrl: string;
  prominenceScore: number;
  attribution?: string;
}

interface SubmissionForBriefing {
  id: string;
  headline: string;
  summary: string;
  fullText: string | null;
  sourceUrl: string;
  sourceName: string | null;
  sourceType: string;
  priorityScore: number;
  publishedAt: Date | null;
  createdAt: Date;
  topicName: string;
}

interface AIAnalysisResult {
  priorityStories: BriefingStory[];
  additionalStories: BriefingStory[];
}

// ──────────────────────────────────────────────────────────────────────────────
// Cross-section deduplication registry
// ──────────────────────────────────────────────────────────────────────────────

class DeduplicationRegistry {
  private claimedUrls = new Set<string>();
  private claimedTokenSets: Array<Set<string>> = [];

  claim(url: string, title: string): void {
    const norm = normalizeIdentityUrl(url);
    if (norm) this.claimedUrls.add(norm);
    const tokens = this.tokenize(title);
    if (tokens.size >= 3) this.claimedTokenSets.push(tokens);
  }

  isAvailable(url: string, title: string): boolean {
    const norm = normalizeIdentityUrl(url);
    if (norm && this.claimedUrls.has(norm)) return false;
    const tokens = this.tokenize(title);
    if (tokens.size >= 3) {
      for (const claimed of this.claimedTokenSets) {
        if (tokenOverlap(tokens, claimed) >= 0.65) return false;
      }
    }
    return true;
  }

  private tokenize(title: string): Set<string> {
    const STOP = new Set(['a','an','the','in','on','at','to','of','for','is','are','was','were','with','by','as','and','or','but','it','its']);
    return new Set(
      title.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/)
        .filter(t => t.length >= 3 && !STOP.has(t))
    );
  }
}

function tokenOverlap(a: Set<string>, b: Set<string>): number {
  let common = 0;
  for (const t of Array.from(a)) if (b.has(t)) common++;
  return common / Math.max(a.size, b.size, 1);
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function formatDateHeader(d: Date): string {
  return formatInTimeZone(d, EASTERN_TZ, 'MMM d, yyyy').toUpperCase();
}

/** Compute hours back from now needed to cover fromDate, with 1h headroom. */
function hoursBack(fromDate: Date): number {
  return Math.ceil((Date.now() - fromDate.getTime()) / (60 * 60 * 1000)) + 1;
}

/** Effective date for a curated item (mirrors storage getCuratedStoreItems). */
function effectiveDate(item: Pick<CuratedItem, 'articlePublishedAt' | 'scrapedAt'>): Date {
  return (item.articlePublishedAt as Date | null) ?? (item.scrapedAt as Date);
}

/** Filter curated items to the [fromDate, toDate] window. */
function inWindow(item: Pick<CuratedItem, 'articlePublishedAt' | 'scrapedAt'>, from: Date, to: Date): boolean {
  const d = effectiveDate(item);
  return d >= from && d <= to;
}

// ──────────────────────────────────────────────────────────────────────────────
// Data fetching
// ──────────────────────────────────────────────────────────────────────────────

async function fetchSubmissionsForBriefing(fromDate: Date, toDate: Date): Promise<SubmissionForBriefing[]> {
  const submissions = await db
    .select({
      id: teamSubmissions.id,
      headline: teamSubmissions.headline,
      summary: teamSubmissions.summary,
      fullText: teamSubmissions.fullText,
      sourceUrl: teamSubmissions.sourceUrl,
      sourceName: teamSubmissions.sourceName,
      sourceType: teamSubmissions.sourceType,
      priorityScore: teamSubmissions.priorityScore,
      publishedAt: teamSubmissions.publishedAt,
      createdAt: teamSubmissions.createdAt,
      topicName: teamSubjects.name,
    })
    .from(teamSubmissions)
    .leftJoin(teamSubjects, eq(teamSubmissions.subjectId, teamSubjects.id))
    .where(and(
      gte(teamSubmissions.createdAt, fromDate),
      lte(teamSubmissions.createdAt, toDate),
      eq(teamSubmissions.status, 'processed'),
      isNull(teamSubmissions.deletedAt)
    ))
    .orderBy(desc(teamSubmissions.priorityScore));

  return submissions.map(s => ({
    id: s.id,
    headline: s.headline || "Untitled",
    summary: s.summary || "",
    fullText: s.fullText,
    sourceUrl: s.sourceUrl,
    sourceName: s.sourceName,
    sourceType: s.sourceType,
    priorityScore: s.priorityScore || 0,
    publishedAt: s.publishedAt,
    createdAt: s.createdAt,
    topicName: s.topicName || "Uncategorized",
  }));
}

// ──────────────────────────────────────────────────────────────────────────────
// AI analysis (with deterministic fallback)
// ──────────────────────────────────────────────────────────────────────────────

async function analyzeStoriesWithAI(
  stories: Array<{ headline: string; summary: string; fullText?: string | null; sourceUrl: string; sourceName: string; priorityScore: number; bullets?: string[]; attribution?: string }>,
  bolo?: string,
): Promise<AIAnalysisResult> {
  if (stories.length === 0) return { priorityStories: [], additionalStories: [] };

  const storiesContext = stories.map((s, idx) => `Story ${idx + 1}:
Headline: ${s.headline}
Source: ${s.sourceName}
URL: ${s.sourceUrl}
Priority Score: ${s.priorityScore}
Summary: ${s.summary}
Key Bullets: ${(s.bullets ?? []).slice(0, 3).join(' | ') || 'None'}
Full Text (excerpt): ${s.fullText?.substring(0, 1500) || 'Not available'}
---`).join('\n\n');

  const boloSection = bolo ? `\nBE ON THE LOOKOUT FOR (prioritize if found):\n${bolo}\n` : '';

  const prompt = `You are an intelligence analyst preparing a defense-news briefing for senior military leadership.
${boloSection}
Analyze these news stories and identify:
1. The 4 MOST IMPORTANT stories by strategic national-security importance
2. Additional important stories that didn't make the top 4

Ranking criteria:
- Strategic importance to US national security and military operations
- Mentions of senior US leadership (President, SecDef, CJCS, combatant commanders)
- Breaking news or developing situations
- Impact on military readiness or operations
- International relations affecting US military posture
${bolo ? '- PRIORITIZE any stories related to the "Be on the Lookout" topics above' : ''}

For each story provide:
- Headline (edited for clarity/brevity; no audience labels, no preamble)
- 1-2 bullet points as plain prose only: no heading, no label, no preamble, never name or address an audience
- Include exact quotes from officials when available, with attribution
- Source outlet name exactly as given

${storiesContext}

Respond in this exact JSON format:
{
  "priorityStories": [
    {
      "headline": "Clear headline text",
      "bullets": ["First bullet with any quotes attributed", "Second bullet"],
      "sourceName": "Reuters",
      "sourceUrl": "https://...",
      "prominenceScore": 95
    }
  ],
  "additionalStories": [
    {
      "headline": "Clear headline text",
      "bullets": ["Key point with context"],
      "sourceName": "CNN",
      "sourceUrl": "https://...",
      "prominenceScore": 75
    }
  ]
}

Return exactly 4 priority stories (or fewer if not enough relevant stories) and up to 6 additional stories.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4000,
      temperature: 0.3,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("No response from AI");

    const result = JSON.parse(content) as AIAnalysisResult;

    for (const story of [...result.priorityStories, ...result.additionalStories]) {
      story.headline = stripBriefingPreamble(story.headline);
      story.bullets = story.bullets
        .map(b => stripBriefingPreamble(b))
        .filter((b): b is string => b !== '');
    }
    return result;
  } catch (error) {
    console.error("[BriefingCard] AI analysis failed, using deterministic fallback:", error);
    const sorted = [...stories].sort((a, b) => b.priorityScore - a.priorityScore);
    return {
      priorityStories: sorted.slice(0, 4).map(s => ({
        headline: s.headline,
        bullets: s.bullets?.length ? s.bullets.slice(0, 2) : [s.summary || 'No summary available'],
        sourceName: s.sourceName,
        sourceUrl: s.sourceUrl,
        prominenceScore: s.priorityScore,
      })),
      additionalStories: sorted.slice(4, 10).map(s => ({
        headline: s.headline,
        bullets: s.bullets?.length ? s.bullets.slice(0, 2) : [s.summary || 'No summary available'],
        sourceName: s.sourceName,
        sourceUrl: s.sourceUrl,
        prominenceScore: s.priorityScore,
      })),
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Priority Briefing: curated Top Stories merged with Team submissions
// ──────────────────────────────────────────────────────────────────────────────

interface PriorityBriefingResult {
  priorityStories: BriefingStory[];
  unmatchedSubmissions: SubmissionForBriefing[];
}

async function buildPriorityBriefing(
  fromDate: Date,
  toDate: Date,
  bolo: string | undefined,
  dedup: DeduplicationRegistry,
): Promise<PriorityBriefingResult> {
  const hours = hoursBack(fromDate);

  const [curatedRaw, clusterMembers, synthesisMap, submissions] = await Promise.all([
    storage.getCuratedStoreItems(hours),
    storage.getCuratedClusterMembers(hours),
    storage.getCuratedStorySynthesisMap(),
    fetchSubmissionsForBriefing(fromDate, toDate),
  ]);

  // Build outlet index once for social filtering
  const registry = await storage.getOutletRegistry();
  const outletIndex = buildOutletIndex(registry);

  // Social filter helper — social posts must appear only in POTUS/Official Messaging
  const isSocialItem = (source: string, url: string): boolean => {
    const o = findOutlet(outletIndex, source, url);
    return o ? isSocialFlashOutlet(o) : false;
  };

  const curatedInWindow = curatedRaw
    .filter(item => inWindow(item, fromDate, toDate))
    .filter(item => !isSocialItem(item.source, item.url)); // exclude social from news sections

  // Group cluster members by clusterId for the window
  const clusterToMembers = new Map<string, typeof clusterMembers>();
  for (const m of clusterMembers) {
    const curatedItem = curatedRaw.find(c => c.id === m.itemId && m.itemType === 'curated');
    if (!curatedItem || !inWindow(curatedItem, fromDate, toDate)) continue;
    const arr = clusterToMembers.get(m.clusterId) ?? [];
    arr.push(m);
    clusterToMembers.set(m.clusterId, arr);
  }

  // Build candidate pool from curated items
  type CandidateStory = {
    headline: string;
    summary: string;
    bullets: string[];
    sourceUrl: string;
    sourceName: string;
    priorityScore: number;
    sourceCount: number;
    clusterId: string | null;
    attribution?: string;
  };

  const candidates: CandidateStory[] = [];
  const seenUrls = new Set<string>();
  const CONTRIBUTING_THRESHOLD = 60; // minimum score for standalone curated item

  // --- Formed clusters (≥2 contributing sources) ---
  const processedClusters = new Set<string>();
  for (const item of curatedInWindow) {
    const membersForItem = Array.from(clusterToMembers.entries()).find(([, mbs]) =>
      mbs.some(m => m.itemType === 'curated' && m.itemId === item.id)
    );
    if (!membersForItem) continue;

    const [clusterId, members] = membersForItem;
    if (processedClusters.has(clusterId)) continue;

    const contributing = members.filter(m => m.role === 'contributing');
    if (contributing.length < 2) continue;

    processedClusters.add(clusterId);

    // Find the best representative (highest priority score in cluster)
    const repItems = members
      .filter(m => m.itemType === 'curated')
      .map(m => curatedInWindow.find(c => c.id === m.itemId))
      .filter((c): c is CuratedItem => !!c);

    const rep = repItems.sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0))[0] ?? item;

    if (!rep.title) continue;
    const normUrl = normalizeIdentityUrl(rep.url);
    if (normUrl && seenUrls.has(normUrl)) continue;
    if (normUrl) seenUrls.add(normUrl);

    // Try synthesis map for bullets
    const synthBullets: string[] = [];
    for (const [, synth] of Array.from(synthesisMap.entries())) {
      if (synth.facts && synth.facts.length > 0) {
        // Use facts as bullets if available (rough match by headline tokens)
        const synthTokens = Array.from(new Set((synth.headline?.toLowerCase().split(/\s+/) ?? [])));
        const repTokens = new Set(rep.title.toLowerCase().split(/\s+/));
        const overlap = synthTokens.filter(t => repTokens.has(t) && t.length > 4).length;
        if (overlap >= 3 && synth.facts.length > 0) {
          synthBullets.push(...synth.facts.slice(0, 3));
          break;
        }
      }
    }

    const bullets = synthBullets.length > 0
      ? synthBullets
      : (rep.summaryBullets as string[] | null)?.filter(Boolean) ?? (rep.summary ? [rep.summary] : []);

    const sourceCount = contributing.length;
    candidates.push({
      headline: (rep.title ?? '').trim(),
      summary: rep.summary ?? '',
      bullets: bullets.slice(0, 3).map(b => stripBriefingPreamble(b)).filter(Boolean) as string[],
      sourceUrl: rep.url,
      sourceName: rep.source ?? 'Unknown',
      priorityScore: rep.priorityScore ?? 0,
      sourceCount,
      clusterId,
      attribution: `Corroborated by ${sourceCount} source${sourceCount !== 1 ? 's' : ''}`,
    });
  }

  // --- Standalone curated items ---
  for (const item of curatedInWindow) {
    if (!item.title || (item.priorityScore ?? 0) < CONTRIBUTING_THRESHOLD) continue;
    const normUrl = normalizeIdentityUrl(item.url);
    if (normUrl && seenUrls.has(normUrl)) continue;
    if (normUrl) seenUrls.add(normUrl);

    const bullets = (item.summaryBullets as string[] | null)?.filter(Boolean)
      ?? (item.summary ? [item.summary] : []);

    candidates.push({
      headline: item.title.trim(),
      summary: item.summary ?? '',
      bullets: bullets.slice(0, 2).map(b => stripBriefingPreamble(b)).filter(Boolean) as string[],
      sourceUrl: item.url,
      sourceName: item.source ?? 'Unknown',
      priorityScore: item.priorityScore ?? 0,
      sourceCount: 1,
      clusterId: null,
    });
  }

  // --- Team submissions: merge into curated candidates or keep standalone ---
  // Folding uses URL-identity match first, then falls back to title-token
  // similarity (≥0.55 overlap) so near-identical articles from different source
  // URLs still fold rather than creating a duplicate priority slot.
  const newsSubmissions = submissions.filter(s => s.sourceType !== 'social_media');
  const matchedSubmissionIds = new Set<string>();

  const TITLE_FOLD_THRESHOLD = 0.55;
  const titleTokens = (t: string): Set<string> => {
    const STOP = new Set(['a','an','the','in','on','at','to','of','for','is','are','was','were','with','by','as','and','or','but','it','its']);
    return new Set(t.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(tok => tok.length >= 3 && !STOP.has(tok)));
  };

  for (const sub of newsSubmissions) {
    const subNorm = normalizeIdentityUrl(sub.sourceUrl);

    // 1. Exact URL-identity match
    let matched = subNorm
      ? candidates.find(c => normalizeIdentityUrl(c.sourceUrl) === subNorm)
      : null;

    // 2. Near-title match as fallback
    if (!matched) {
      const subToks = titleTokens(sub.headline);
      if (subToks.size >= 3) {
        matched = candidates.find(c => {
          const cToks = titleTokens(c.headline);
          let common = 0;
          for (const t of Array.from(subToks)) if (cToks.has(t)) common++;
          return common / Math.max(subToks.size, cToks.size, 1) >= TITLE_FOLD_THRESHOLD;
        });
      }
    }

    if (matched) {
      // Fold into the curated candidate — take the higher score
      matched.priorityScore = Math.max(matched.priorityScore, sub.priorityScore);
      if (!matched.bullets.length && sub.summary) {
        matched.bullets = [sub.summary];
      }
      matchedSubmissionIds.add(sub.id);
    }
  }

  // Unmatched high-priority submissions also compete for priority slots
  const unmatchedSubs = newsSubmissions.filter(s => !matchedSubmissionIds.has(s.id));
  const submissionCandidates = unmatchedSubs
    .filter(s => s.priorityScore >= 50)
    .map(s => ({
      headline: s.headline,
      summary: s.summary,
      bullets: s.summary ? [s.summary] : [],
      sourceUrl: s.sourceUrl,
      sourceName: s.sourceName ?? 'Unknown',
      priorityScore: s.priorityScore,
      sourceCount: 1,
      clusterId: null as string | null,
      fullText: s.fullText,
    }));

  const allCandidates = [...candidates, ...submissionCandidates];

  if (allCandidates.length === 0) {
    return { priorityStories: [], unmatchedSubmissions: unmatchedSubs };
  }

  // AI selection
  const aiInput = allCandidates.map(c => ({
    headline: c.headline,
    summary: c.summary,
    bullets: c.bullets,
    sourceUrl: c.sourceUrl,
    sourceName: c.sourceName,
    priorityScore: c.priorityScore,
    fullText: 'fullText' in c ? (c as any).fullText : null,
  }));

  const aiResult = await analyzeStoriesWithAI(aiInput, bolo);

  // Map AI results back to find attributions, then apply dedup
  const mapToStory = (s: BriefingStory): BriefingStory => {
    const norm = normalizeIdentityUrl(s.sourceUrl);
    const orig = allCandidates.find(c =>
      normalizeIdentityUrl(c.sourceUrl) === norm || c.headline === s.headline
    );
    const attribution = orig && 'attribution' in orig ? (orig as CandidateStory).attribution : undefined;
    return { ...s, attribution };
  };

  const priorityStories: BriefingStory[] = [];
  for (const s of aiResult.priorityStories) {
    const story = mapToStory(s);
    if (dedup.isAvailable(story.sourceUrl, story.headline)) {
      dedup.claim(story.sourceUrl, story.headline);
      priorityStories.push(story);
    }
  }

  // Unmatched subs that didn't make priority go to additional intelligence
  const priorityUrlSet = new Set(priorityStories.map(s => normalizeIdentityUrl(s.sourceUrl)));
  const remainingUnmatched = unmatchedSubs.filter(
    s => !priorityUrlSet.has(normalizeIdentityUrl(s.sourceUrl))
  );

  return { priorityStories, unmatchedSubmissions: remainingUnmatched };
}

// ──────────────────────────────────────────────────────────────────────────────
// Top Narratives section
// ──────────────────────────────────────────────────────────────────────────────

interface NarrativesResult {
  domestic: Array<{ headline: string; source: string; sourceCount?: number; url: string }>;
  international: Array<{ headline: string; source: string; sourceCount?: number; url: string }>;
}

const FOREIGN_GEO_TOKENS = new Set([
  'venezuela','maduro','iran','tehran','iranian','israel','israeli','gaza','netanyahu',
  'hamas','hezbollah','russia','russian','ukraine','ukrainian','putin','zelensky',
  'moscow','kyiv','kremlin','china','chinese','beijing','taiwan','north korea','south korea',
  'pyongyang','india','pakistan','mexico','brazil','colombia','africa','sahel',
  'sudan','somalia','ethiopia','libya','saudi','syria','iraq','yemen','houthi',
  'lebanon','europe','european','nato','germany','france','britain','british',
  'poland','afghanistan','taliban','japan','philippines','australia','greenland',
]);

const US_GEO_TOKENS = new Set([
  'united states','american','washington','white house','congress','pentagon',
  'homeland','national guard','trump','senate','capitol hill','state department',
  'supreme court','border patrol','immigration',
]);

function geoBucketFromText(title: string): 'domestic' | 'international' | null {
  const hay = ` ${title.toLowerCase()} `;
  for (const k of Array.from(FOREIGN_GEO_TOKENS)) if (hay.includes(k)) return 'international';
  for (const k of Array.from(US_GEO_TOKENS)) if (hay.includes(k)) return 'domestic';
  return null;
}

async function buildTopNarratives(
  fromDate: Date,
  toDate: Date,
  dedup: DeduplicationRegistry,
): Promise<NarrativesResult> {
  const hours = hoursBack(fromDate);
  const [curatedRaw, clusterMembers, registry] = await Promise.all([
    storage.getCuratedStoreItemsForNarratives(hours),
    storage.getCuratedClusterMembers(hours),
    storage.getOutletRegistry(),
  ]);

  const outletIndex = buildOutletIndex(registry);

  // Build a clusterId → contributing-member count map so each narrative entry
  // can surface the correct corroboration count (mirrors Priority Briefing logic)
  const clusterSourceCount = new Map<string, number>();
  for (const m of clusterMembers) {
    if (m.role === 'contributing') {
      clusterSourceCount.set(m.clusterId, (clusterSourceCount.get(m.clusterId) ?? 0) + 1);
    }
  }
  // Map curated item id → clusterId for fast lookup
  const itemCluster = new Map<string, string>();
  for (const m of clusterMembers) {
    if (m.itemType === 'curated') itemCluster.set(m.itemId, m.clusterId);
  }

  const curatedInWindow = curatedRaw.filter(item => inWindow(item, fromDate, toDate));

  // Use curated_classifications region/country for authoritative Domestic/International bucketing
  // (same overlay used by Top Stories and State Narratives in the live curated UI)
  const classMap = await storage.getCuratedClassificationsByUrls(
    curatedInWindow.map(c => c.url).filter((u, i, a) => a.indexOf(u) === i),
  );

  // Geo bucket from content-based classification first, keyword heuristic as fallback
  const geoBucket = (item: { title: string; url: string }): 'domestic' | 'international' | null => {
    const cls = classMap.get(item.url);
    if (cls?.country) {
      const country = cls.country.toLowerCase();
      if (country === 'united states' || country === 'us') return 'domestic';
      return 'international';
    }
    if (cls?.region) {
      const region = cls.region.toLowerCase();
      if (region === 'united states' || region === 'domestic' || region === 'north america') return 'domestic';
      return 'international';
    }
    // Fallback: keyword heuristic
    return geoBucketFromText(item.title);
  };

  const domestic: NarrativesResult['domestic'] = [];
  const international: NarrativesResult['international'] = [];
  const seen = new Set<string>();

  for (const item of curatedInWindow) {
    if (!item.title) continue;
    const o = findOutlet(outletIndex, item.source, item.url);
    const behavior = o ? deriveOutletBehavior(o) : deriveBehavior({ factuality: null });
    // Exclude adversary media and social-only outlets from Top Narratives
    if (behavior.label === 'contrast') continue;
    if (o && isSocialFlashOutlet(o)) continue;

    const norm = normalizeIdentityUrl(item.url);
    if (norm && seen.has(norm)) continue;
    if (!dedup.isAvailable(item.url, item.title)) continue;
    if (norm) seen.add(norm);

    const bucket = geoBucket(item);
    if (!bucket) continue;

    // Claim so later sections don't repeat this story
    dedup.claim(item.url, item.title);

    const clusterId = itemCluster.get(item.id);
    const sourceCount = (clusterId ? clusterSourceCount.get(clusterId) : undefined) ?? 1;
    const entry = { headline: item.title.trim(), source: item.source ?? 'Unknown', sourceCount, url: item.url };
    if (bucket === 'domestic' && domestic.length < 6) {
      domestic.push(entry);
    } else if (bucket === 'international' && international.length < 6) {
      international.push(entry);
    }

    if (domestic.length >= 6 && international.length >= 6) break;
  }

  return { domestic, international };
}

// ──────────────────────────────────────────────────────────────────────────────
// State-Controlled Narratives section
// ──────────────────────────────────────────────────────────────────────────────

interface StateNarrativesResult {
  byCountry: Map<string, Array<{ headline: string; source: string; url: string; attribution: string }>>;
}

async function buildStateNarratives(
  fromDate: Date,
  toDate: Date,
  dedup: DeduplicationRegistry,
): Promise<StateNarrativesResult> {
  const hours = hoursBack(fromDate);
  const [curatedRaw, registry] = await Promise.all([
    storage.getCuratedStoreItemsForNarratives(hours),
    storage.getOutletRegistry(),
  ]);

  const outletIndex = buildOutletIndex(registry);
  const byCountry = new Map<string, Array<{ headline: string; source: string; url: string; attribution: string }>>();

  for (const item of curatedRaw) {
    if (!item.title || !inWindow(item, fromDate, toDate)) continue;

    const o = findOutlet(outletIndex, item.source, item.url);
    if (!o) continue;

    const behavior = o ? deriveOutletBehavior(o) : deriveBehavior({ factuality: null });
    if (behavior.label !== 'contrast') continue;
    // Social sources must not appear in news sections (only in POTUS/Official Messaging)
    if (isSocialFlashOutlet(o)) continue;

    const country = (o.originCountry || '').trim();
    if (!country || !ADVERSARY_COUNTRIES.includes(country)) continue;

    // Respect cross-section dedup — state narratives are lower priority than Priority/Top Narratives
    if (!dedup.isAvailable(item.url, item.title)) continue;

    const arr = byCountry.get(country) ?? [];
    if (arr.length >= 4) continue; // cap per country

    const norm = normalizeIdentityUrl(item.url);
    if (norm && arr.some(a => normalizeIdentityUrl(a.url) === norm)) continue;

    // Attribute-only framing
    const attribution = `${item.source} reports: "${item.title.trim()}"`;

    // Claim so later sections (Aerial View, Additional Intel) don't repeat
    dedup.claim(item.url, item.title);

    arr.push({
      headline: item.title.trim(),
      source: item.source ?? 'Unknown',
      url: item.url,
      attribution,
    });
    byCountry.set(country, arr);
  }

  return { byCountry };
}

// ──────────────────────────────────────────────────────────────────────────────
// POTUS & Official Messaging section
// ──────────────────────────────────────────────────────────────────────────────

interface MessagingPost {
  kind: 'potus' | 'official';
  handle: string;
  content: string;
  postedAt: Date;
  url: string;
}

async function buildPotusMessaging(
  fromDate: Date,
  toDate: Date,
): Promise<MessagingPost[]> {
  // Use date-bounded queries (getTruthSocialPostsSince / getXPostsSince) so
  // historical windows are served correctly. The recency-capped curated
  // accessors (getRecentXPostsForCurated) pre-filter to hours-old posts before
  // the in-memory [fromDate,toDate] window is applied, so older in-window posts
  // are silently dropped when newer posts exhaust the limit. The Since variants
  // fetch all rows from fromDate with no row cap, then we apply the same
  // quality/visibility filters as the curated accessors do in SQL.
  const [truthRaw, xRaw] = await Promise.all([
    storage.getTruthSocialPostsSince(fromDate),
    storage.getXPostsSince(fromDate),
  ]);

  const posts: MessagingPost[] = [];

  for (const p of truthRaw) {
    const postedAt = p.postedAt as Date;
    if (postedAt > toDate) continue;                              // outside window
    if ((p as any).isHidden) continue;                           // mirror curated filter
    if (!p.content || p.content.trim().length < 20) continue;
    posts.push({
      kind: 'potus',
      handle: '@realDonaldTrump',
      content: p.content.trim(),
      postedAt,
      url: p.truthSocialUrl,
    });
  }

  for (const p of xRaw) {
    const postedAt = p.postedAt as Date;
    if (postedAt > toDate) continue;                              // outside window
    if ((p as any).isHidden) continue;                           // mirror curated filter
    if ((p as any).accountCategory === 'influencer') continue;   // exclude influencers
    if (!p.content || p.content.trim().length < 20) continue;
    posts.push({
      kind: 'official',
      handle: `@${p.sourceAccount}`,
      content: p.content.trim(),
      postedAt,
      url: p.xUrl,
    });
  }

  // Sort by posted time desc, take top 8
  posts.sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime());
  return posts.slice(0, 8);
}

// ──────────────────────────────────────────────────────────────────────────────
// Aerial View section
// ──────────────────────────────────────────────────────────────────────────────

interface AerialViewResult {
  domestic: CompetingCoverageItem[];
  international: CompetingCoverageItem[];
  buzz: CompetingCoverageItem[];
  updatedAt: number | null;
  outOfWindow: boolean; // true when toDate is too far in the past for cached radar data
}

// Competing coverage cache is a real-time snapshot (no per-item timestamps).
// When the selected window ends more than 6 hours ago the cache reflects a
// DIFFERENT moment than the requested period — surface that as outOfWindow so
// the render can note it gracefully rather than silently showing stale data.
const AERIAL_VIEW_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

async function buildAerialView(
  toDate: Date,
  dedup: DeduplicationRegistry,
): Promise<AerialViewResult> {
  const now = Date.now();
  const outOfWindow = now - toDate.getTime() > AERIAL_VIEW_MAX_AGE_MS;

  if (outOfWindow) {
    return { domestic: [], international: [], buzz: [], updatedAt: null, outOfWindow: true };
  }

  const { domestic, international, buzz, updatedAt } = await storage.getCompetingCoverage();

  // Aerial View is a "public news radar" lens. Claim items that pass the
  // availability check so that Additional Intelligence (which runs after Aerial
  // View in the serialized priority chain) cannot re-emit the same story. This
  // enforces the cross-section "one story never appears twice" rule through the
  // full builder sequence: Priority → TopNarratives → StateNarratives →
  // AerialView → AdditionalIntelligence.
  const filterItems = (items: CompetingCoverageItem[], cap = 6): CompetingCoverageItem[] => {
    const out: CompetingCoverageItem[] = [];
    for (const item of items) {
      if (!item.headline) continue;
      if (!dedup.isAvailable(item.url ?? '', item.headline ?? '')) continue;
      dedup.claim(item.url ?? '', item.headline ?? '');
      out.push(item);
      if (out.length >= cap) break;
    }
    return out;
  };

  return {
    domestic: filterItems(domestic),
    international: filterItems(international),
    buzz: filterItems(buzz, 2),
    updatedAt,
    outOfWindow: false,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Additional Intelligence: remaining team submissions
// ──────────────────────────────────────────────────────────────────────────────

async function buildAdditionalIntelligence(
  submissions: SubmissionForBriefing[],
  dedup: DeduplicationRegistry,
  bolo?: string,
): Promise<BriefingStory[]> {
  const newsSubmissions = submissions.filter(s => s.sourceType !== 'social_media');
  const available = newsSubmissions.filter(s => dedup.isAvailable(s.sourceUrl, s.headline));

  if (available.length === 0) return [];

  const aiInput = available.map(s => ({
    headline: s.headline,
    summary: s.summary,
    bullets: [] as string[],
    sourceUrl: s.sourceUrl,
    sourceName: s.sourceName ?? 'Unknown',
    priorityScore: s.priorityScore,
    fullText: s.fullText,
  }));

  const result = await analyzeStoriesWithAI(aiInput, bolo);
  return [...result.priorityStories, ...result.additionalStories]
    .filter(s => dedup.isAvailable(s.sourceUrl, s.headline))
    .slice(0, 8);
}

// ──────────────────────────────────────────────────────────────────────────────
// DOCX rendering helpers
// ──────────────────────────────────────────────────────────────────────────────

const PAGE_PROPS = {
  page: {
    size: {
      width: convertInchesToTwip(5.5),
      height: convertInchesToTwip(8.5),
      orientation: PageOrientation.PORTRAIT,
    },
    margin: {
      top: convertInchesToTwip(0.5),
      bottom: convertInchesToTwip(0.5),
      left: convertInchesToTwip(0.5),
      right: convertInchesToTwip(0.5),
    },
  },
};

function sectionHeader(title: string, dateHeader: string): Paragraph[] {
  return [
    new Paragraph({
      children: [new TextRun({ text: title, bold: true, size: 32 })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
    }),
    new Paragraph({
      children: [new TextRun({ text: dateHeader, bold: true, size: 24 })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 300 },
    }),
  ];
}

function emptyNoteParagraph(msg: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text: msg, italics: true, size: 20 })],
    spacing: { before: 200, after: 200 },
    alignment: AlignmentType.CENTER,
  });
}

function storyDocx(story: BriefingStory, index: number, numbered = true): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const label = numbered ? `${index}. ${story.headline}` : story.headline;

  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: label, bold: true, color: PURPLE_COLOR, size: 22 })],
      spacing: { before: 200, after: 100 },
    })
  );

  for (const bullet of story.bullets) {
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: `• ${bullet}`, size: 20 })],
        spacing: { after: 80 },
        indent: { left: convertInchesToTwip(0.25) },
      })
    );
  }

  if (story.attribution) {
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: story.attribution, italics: true, size: 18, color: '555555' })],
        spacing: { after: 60 },
        indent: { left: convertInchesToTwip(0.25) },
      })
    );
  }

  paragraphs.push(
    new Paragraph({
      children: [
        new ExternalHyperlink({
          children: [new TextRun({ text: story.sourceName, style: "Hyperlink", size: 18, italics: true })],
          link: story.sourceUrl,
        }),
      ],
      spacing: { after: 150 },
      indent: { left: convertInchesToTwip(0.25) },
    })
  );

  return paragraphs;
}

// ──────────────────────────────────────────────────────────────────────────────
// HTML rendering helpers
// ──────────────────────────────────────────────────────────────────────────────

function htmlPageOpen(title: string, dateHeader: string): string {
  return `<div class="page">
    <h1>${escapeHtml(title)}</h1>
    <h2>${escapeHtml(dateHeader)}</h2>`;
}

function htmlPageClose(): string {
  return `</div>`;
}

function storyHtml(story: BriefingStory, index: number, numbered = true): string {
  const label = numbered ? `${index}. ${escapeHtml(story.headline)}` : escapeHtml(story.headline);
  const bullets = story.bullets.map(b => `<p class="bullet">&bull; ${escapeHtml(b)}</p>`).join('');
  const attribution = story.attribution
    ? `<p class="attribution">${escapeHtml(story.attribution)}</p>` : '';
  return `<div class="story">
      <h3 class="headline">${label}</h3>
      ${bullets}
      ${attribution}
      <p class="source"><a href="${escapeHtml(story.sourceUrl)}">${escapeHtml(story.sourceName)}</a></p>
    </div>`;
}

const HTML_STYLES = `
    @page { size: 5.5in 8.5in; margin: 0.5in; }
    body { font-family: 'Times New Roman', serif; font-size: 11pt; line-height: 1.4; margin: 0; padding: 0.5in; width: 4.5in; }
    .page { page-break-after: always; min-height: 7in; }
    .page:last-child { page-break-after: avoid; }
    h1 { text-align: center; font-size: 16pt; font-weight: bold; margin-bottom: 0.15in; }
    h2 { text-align: center; font-size: 12pt; font-weight: bold; margin-bottom: 0.25in; }
    h3 { text-align: center; font-size: 11pt; font-weight: bold; margin: 0.15in 0 0.05in; color: #444; }
    .story { margin-bottom: 0.2in; }
    .headline { color: #6B21A8; font-size: 11pt; font-weight: bold; margin-bottom: 0.1in; text-align: left; }
    .bullet { margin: 0 0 0.05in 0.25in; font-size: 10pt; }
    .attribution { margin: 0 0 0.03in 0.25in; font-size: 9pt; color: #555; font-style: italic; }
    .source { margin-left: 0.25in; font-size: 9pt; font-style: italic; }
    .source a { color: #0000EE; text-decoration: underline; }
    .no-stories { font-style: italic; text-align: center; margin-top: 0.3in; color: #666; }
    .section-label { font-size: 9pt; font-weight: bold; color: #888; text-transform: uppercase; margin: 0.1in 0 0.05in; letter-spacing: 0.05em; }
    .narrative-item { margin-bottom: 0.1in; font-size: 10pt; }
    .narrative-source { font-size: 9pt; color: #555; font-style: italic; margin-left: 0.15in; }
    .state-country { font-size: 11pt; font-weight: bold; color: #6B21A8; margin: 0.15in 0 0.05in; }
    .state-item { margin-bottom: 0.1in; font-size: 10pt; }
    .state-source { font-size: 9pt; color: #800000; font-style: italic; margin-left: 0.15in; }
    .social-post { margin-bottom: 0.15in; border-left: 2pt solid #6B21A8; padding-left: 0.1in; }
    .social-handle { font-size: 9pt; font-weight: bold; color: #6B21A8; }
    .social-time { font-size: 8pt; color: #666; margin-left: 0.1in; }
    .social-content { font-size: 10pt; margin: 0.05in 0; }
    .aerial-item { font-size: 10pt; margin-bottom: 0.08in; }
    .aerial-source { font-size: 9pt; color: #555; font-style: italic; margin-left: 0.1in; }
    .blind-spot { color: #B45309; font-size: 8pt; margin-left: 0.05in; }
    @media print { body { padding: 0; } }`;

// ──────────────────────────────────────────────────────────────────────────────
// Main generator functions
// ──────────────────────────────────────────────────────────────────────────────

export async function generateBriefingCard(
  fromDate: Date,
  toDate: Date,
  bolo?: string,
  sectionsInput?: SectionKey[],
): Promise<Buffer> {
  // Normalize and validate: filter out any unknown keys so callers cannot pass
  // arbitrary strings that silently expand section logic.
  const validSections = sectionsInput
    ? sectionsInput.filter((k): k is SectionKey => (ALL_SECTIONS as string[]).includes(k))
    : ALL_SECTIONS;
  const sections = new Set<SectionKey>(validSections);
  const dateHeader = formatDateHeader(toDate);
  const dedup = new DeduplicationRegistry();

  // Priority Briefing: only run (and claim dedup) when the section is selected.
  // If the user deselects priorityBriefing but keeps additionalIntelligence, we
  // must NOT run buildPriorityBriefing — it would claim curated stories into the
  // shared dedup registry and silently suppress them from sections that ARE shown.
  // Additional Intelligence uses allSubmissions directly when Priority is off.
  const [priorityResult, allSubmissions] = await Promise.all([
    sections.has('priorityBriefing')
      ? buildPriorityBriefing(fromDate, toDate, bolo, dedup).catch(e => {
          console.error('[BriefingCard] Priority briefing error:', e);
          return { priorityStories: [], unmatchedSubmissions: [] as SubmissionForBriefing[] };
        })
      : Promise.resolve({ priorityStories: [] as BriefingStory[], unmatchedSubmissions: [] as SubmissionForBriefing[] }),
    sections.has('additionalIntelligence')
      ? fetchSubmissionsForBriefing(fromDate, toDate)
      : Promise.resolve([] as SubmissionForBriefing[]),
  ]);

  // POTUS messaging does not read or write dedup — start it in the background
  // so its latency overlaps with the serialized dedup-sensitive builders below.
  const messagingPostsPromise = sections.has('potusMessaging')
    ? buildPotusMessaging(fromDate, toDate).catch(e => {
        console.error('[BriefingCard] POTUS messaging error:', e);
        return [] as MessagingPost[];
      })
    : Promise.resolve([] as MessagingPost[]);

  // Dedup-sensitive builders MUST run serially in priority order so each
  // higher-priority section claims its stories before lower-priority ones
  // see them. Running these in Promise.all would make ownership timing-
  // dependent and allow a lower-priority section to win a story race.
  const narrativesResult = sections.has('topNarratives')
    ? await buildTopNarratives(fromDate, toDate, dedup).catch(e => {
        console.error('[BriefingCard] Top narratives error:', e);
        return { domestic: [], international: [] } as NarrativesResult;
      })
    : { domestic: [], international: [] } as NarrativesResult;

  const stateResult = sections.has('stateNarratives')
    ? await buildStateNarratives(fromDate, toDate, dedup).catch(e => {
        console.error('[BriefingCard] State narratives error:', e);
        return { byCountry: new Map() } as StateNarrativesResult;
      })
    : { byCountry: new Map() } as StateNarrativesResult;

  const aerialResult = sections.has('aerialView')
    ? await buildAerialView(toDate, dedup).catch(e => {
        console.error('[BriefingCard] Aerial view error:', e);
        return { domestic: [], international: [], buzz: [], updatedAt: null, outOfWindow: false } as AerialViewResult;
      })
    : { domestic: [], international: [], buzz: [], updatedAt: null, outOfWindow: false } as AerialViewResult;

  // When Priority ran: always use unmatchedSubmissions (even when empty —
  // empty means everything was folded and Additional Intelligence is empty).
  // Never fall back to allSubmissions while Priority is selected, or matched
  // items reappear and violate the cross-section deconfliction contract.
  const additionalStories = sections.has('additionalIntelligence')
    ? await buildAdditionalIntelligence(
        sections.has('priorityBriefing')
          ? priorityResult.unmatchedSubmissions
          : allSubmissions,
        dedup,
        bolo,
      ).catch(e => {
        console.error('[BriefingCard] Additional intelligence error:', e);
        return [] as BriefingStory[];
      })
    : [] as BriefingStory[];

  const messagingPosts = await messagingPostsPromise;

  // Build DOCX sections
  const documentSections: any[] = [];

  const addSection = (children: Paragraph[]) => {
    documentSections.push({ properties: PAGE_PROPS, children });
  };

  // Priority Briefing
  if (sections.has('priorityBriefing')) {
    const children: Paragraph[] = [...sectionHeader(SECTION_LABELS.priorityBriefing, dateHeader)];
    if (priorityResult.priorityStories.length === 0) {
      children.push(emptyNoteParagraph('No curated top stories available for the selected time period.'));
    } else {
      priorityResult.priorityStories.forEach((s, i) => children.push(...storyDocx(s, i + 1, true)));
    }
    addSection(children);
  }

  // Top Narratives
  if (sections.has('topNarratives')) {
    const children: Paragraph[] = [...sectionHeader(SECTION_LABELS.topNarratives, dateHeader)];
    const hasContent = narrativesResult.domestic.length > 0 || narrativesResult.international.length > 0;
    if (!hasContent) {
      children.push(emptyNoteParagraph('No narrative coverage available for the selected time period.'));
    } else {
      if (narrativesResult.domestic.length > 0) {
        children.push(new Paragraph({
          children: [new TextRun({ text: 'U.S. Domestic', bold: true, size: 22, color: PURPLE_COLOR })],
          spacing: { before: 100, after: 80 },
        }));
        for (const item of narrativesResult.domestic) {
          const srcLine = item.sourceCount && item.sourceCount > 1
            ? `${item.source}  ·  ${item.sourceCount} sources`
            : item.source;
          children.push(new Paragraph({
            children: [new TextRun({ text: `• ${item.headline}`, size: 20 })],
            spacing: { after: 60 },
            indent: { left: convertInchesToTwip(0.15) },
          }));
          children.push(new Paragraph({
            children: [new TextRun({ text: srcLine, italics: true, size: 18, color: '666666' })],
            spacing: { after: 80 },
            indent: { left: convertInchesToTwip(0.3) },
          }));
        }
      }
      if (narrativesResult.international.length > 0) {
        children.push(new Paragraph({
          children: [new TextRun({ text: 'International', bold: true, size: 22, color: PURPLE_COLOR })],
          spacing: { before: 150, after: 80 },
        }));
        for (const item of narrativesResult.international) {
          const srcLine = item.sourceCount && item.sourceCount > 1
            ? `${item.source}  ·  ${item.sourceCount} sources`
            : item.source;
          children.push(new Paragraph({
            children: [new TextRun({ text: `• ${item.headline}`, size: 20 })],
            spacing: { after: 60 },
            indent: { left: convertInchesToTwip(0.15) },
          }));
          children.push(new Paragraph({
            children: [new TextRun({ text: srcLine, italics: true, size: 18, color: '666666' })],
            spacing: { after: 80 },
            indent: { left: convertInchesToTwip(0.3) },
          }));
        }
      }
    }
    addSection(children);
  }

  // State-Controlled Narratives
  if (sections.has('stateNarratives')) {
    const children: Paragraph[] = [...sectionHeader(SECTION_LABELS.stateNarratives, dateHeader)];
    if (stateResult.byCountry.size === 0) {
      children.push(emptyNoteParagraph('No state-controlled narrative coverage for the selected time period.'));
    } else {
      for (const [country, items] of Array.from(stateResult.byCountry.entries())) {
        children.push(new Paragraph({
          children: [new TextRun({ text: country.toUpperCase(), bold: true, size: 22, color: PURPLE_COLOR })],
          spacing: { before: 150, after: 80 },
        }));
        for (const item of items) {
          children.push(new Paragraph({
            children: [new TextRun({ text: `${item.source}: `, bold: true, size: 18, color: '800000' },
            ), new TextRun({ text: `"${item.headline}"`, size: 18 })],
            spacing: { after: 80 },
            indent: { left: convertInchesToTwip(0.15) },
          }));
        }
      }
    }
    addSection(children);
  }

  // POTUS & Official Messaging
  if (sections.has('potusMessaging')) {
    const children: Paragraph[] = [...sectionHeader(SECTION_LABELS.potusMessaging, dateHeader)];
    if (messagingPosts.length === 0) {
      children.push(emptyNoteParagraph('No official messaging in the selected time period.'));
    } else {
      for (const post of messagingPosts) {
        const timeStr = formatInTimeZone(post.postedAt, EASTERN_TZ, 'MMM d HH:mm');
        const snippet = post.content.length > 280 ? post.content.slice(0, 280) + '…' : post.content;
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: post.handle, bold: true, color: PURPLE_COLOR, size: 20 }),
              new TextRun({ text: `  ${timeStr} ET`, italics: true, size: 18, color: '666666' }),
            ],
            spacing: { before: 150, after: 60 },
          }),
          new Paragraph({
            children: [new TextRun({ text: snippet, size: 19 })],
            spacing: { after: 100 },
            indent: { left: convertInchesToTwip(0.2) },
            border: { left: { color: '6B21A8', size: 12, style: 'single', space: 6 } },
          }),
        );
      }
    }
    addSection(children);
  }

  // Aerial View
  if (sections.has('aerialView')) {
    const children: Paragraph[] = [...sectionHeader(SECTION_LABELS.aerialView, dateHeader)];
    const hasAerial = aerialResult.domestic.length > 0 || aerialResult.international.length > 0;
    if (!hasAerial) {
      const aerialNote = aerialResult.outOfWindow
        ? 'Aerial View reflects the current public news radar — not available for historical time windows.'
        : 'Aerial View data unavailable. Check back after the next refresh cycle.';
      children.push(emptyNoteParagraph(aerialNote));
    } else {
      const renderAerialBucket = (label: string, items: CompetingCoverageItem[]) => {
        if (!items.length) return;
        children.push(new Paragraph({
          children: [new TextRun({ text: label, bold: true, size: 22, color: PURPLE_COLOR })],
          spacing: { before: 100, after: 80 },
        }));
        for (const item of items) {
          children.push(new Paragraph({
            children: [
              new TextRun({ text: `• ${item.headline}`, size: 19 }),
              ...(item.blindSpot ? [new TextRun({ text: ' [blind spot]', size: 16, color: 'B45309', italics: true })] : []),
            ],
            spacing: { after: 50 },
            indent: { left: convertInchesToTwip(0.15) },
          }));
          if (item.source) {
            children.push(new Paragraph({
              children: [new TextRun({ text: item.source, italics: true, size: 17, color: '666666' })],
              spacing: { after: 60 },
              indent: { left: convertInchesToTwip(0.3) },
            }));
          }
        }
      };

      renderAerialBucket('U.S. Domestic Coverage', aerialResult.domestic);
      renderAerialBucket('International Coverage', aerialResult.international);
      if (aerialResult.buzz.length > 0) {
        renderAerialBucket('Trending', aerialResult.buzz);
      }
    }
    addSection(children);
  }

  // Additional Intelligence
  if (sections.has('additionalIntelligence')) {
    const children: Paragraph[] = [...sectionHeader(SECTION_LABELS.additionalIntelligence, dateHeader)];
    if (additionalStories.length === 0) {
      children.push(emptyNoteParagraph('No additional intelligence stories available for the selected time period.'));
    } else {
      for (const story of additionalStories) {
        children.push(...storyDocx(story, 0, false));
      }
    }
    addSection(children);
  }

  if (documentSections.length === 0) {
    documentSections.push({
      properties: PAGE_PROPS,
      children: [
        ...sectionHeader('BRIEFING CARD', dateHeader),
        emptyNoteParagraph('No sections selected.'),
      ],
    });
  }

  const doc = new Document({ sections: documentSections });
  return Packer.toBuffer(doc);
}

export async function generateBriefingCardHtml(
  fromDate: Date,
  toDate: Date,
  bolo?: string,
  sectionsInput?: SectionKey[],
): Promise<string> {
  // Normalize and validate: filter out any unknown keys so callers cannot pass
  // arbitrary strings that silently expand section logic.
  const validSections = sectionsInput
    ? sectionsInput.filter((k): k is SectionKey => (ALL_SECTIONS as string[]).includes(k))
    : ALL_SECTIONS;
  const sections = new Set<SectionKey>(validSections);
  const dateHeader = formatDateHeader(toDate);
  const dedup = new DeduplicationRegistry();

  // Same gate as the DOCX path: Priority only runs (and claims dedup) when
  // the section is selected. Deselecting priorityBriefing must not suppress
  // stories from the sections that ARE shown via hidden dedup side-effects.
  const [priorityResult, allSubmissions] = await Promise.all([
    sections.has('priorityBriefing')
      ? buildPriorityBriefing(fromDate, toDate, bolo, dedup).catch(e => {
          console.error('[BriefingCard HTML] Priority briefing error:', e);
          return { priorityStories: [] as BriefingStory[], unmatchedSubmissions: [] as SubmissionForBriefing[] };
        })
      : Promise.resolve({ priorityStories: [] as BriefingStory[], unmatchedSubmissions: [] as SubmissionForBriefing[] }),
    sections.has('additionalIntelligence')
      ? fetchSubmissionsForBriefing(fromDate, toDate)
      : Promise.resolve([] as SubmissionForBriefing[]),
  ]);

  // POTUS messaging does not read or write dedup — start it in the background.
  const messagingPostsPromise = sections.has('potusMessaging')
    ? buildPotusMessaging(fromDate, toDate).catch(() => [] as MessagingPost[])
    : Promise.resolve([] as MessagingPost[]);

  // Dedup-sensitive builders serialized in priority order (TopNarratives →
  // StateNarratives → AerialView → AdditionalIntelligence) so higher-priority
  // sections always claim stories before lower-priority ones see them.
  const narrativesResult = sections.has('topNarratives')
    ? await buildTopNarratives(fromDate, toDate, dedup).catch(() => ({ domestic: [], international: [] } as NarrativesResult))
    : { domestic: [], international: [] } as NarrativesResult;

  const stateResult = sections.has('stateNarratives')
    ? await buildStateNarratives(fromDate, toDate, dedup).catch(() => ({ byCountry: new Map() } as StateNarrativesResult))
    : { byCountry: new Map() } as StateNarrativesResult;

  const aerialResult = sections.has('aerialView')
    ? await buildAerialView(toDate, dedup).catch(() => ({ domestic: [], international: [], buzz: [], updatedAt: null, outOfWindow: false } as AerialViewResult))
    : { domestic: [], international: [], buzz: [], updatedAt: null, outOfWindow: false } as AerialViewResult;

  // Same contract as DOCX path: Priority ran → always use unmatchedSubmissions.
  const additionalStories = sections.has('additionalIntelligence')
    ? await buildAdditionalIntelligence(
        sections.has('priorityBriefing')
          ? priorityResult.unmatchedSubmissions
          : allSubmissions,
        dedup,
        bolo,
      ).catch(() => [] as BriefingStory[])
    : [] as BriefingStory[];

  const messagingPosts = await messagingPostsPromise;

  const pages: string[] = [];

  const addPage = (title: string, body: string) => {
    pages.push(`${htmlPageOpen(title, dateHeader)}
    ${body}
  ${htmlPageClose()}`);
  };

  // Priority Briefing
  if (sections.has('priorityBriefing')) {
    if (priorityResult.priorityStories.length === 0) {
      addPage(SECTION_LABELS.priorityBriefing,
        '<p class="no-stories">No curated top stories available for the selected time period.</p>');
    } else {
      const body = priorityResult.priorityStories
        .map((s, i) => storyHtml(s, i + 1, true)).join('');
      addPage(SECTION_LABELS.priorityBriefing, body);
    }
  }

  // Top Narratives
  if (sections.has('topNarratives')) {
    const hasContent = narrativesResult.domestic.length > 0 || narrativesResult.international.length > 0;
    if (!hasContent) {
      addPage(SECTION_LABELS.topNarratives,
        '<p class="no-stories">No narrative coverage available for the selected time period.</p>');
    } else {
      let body = '';
      const renderNarrativeItem = (item: { headline: string; source: string; sourceCount?: number; url: string }) => {
        const srcLabel = item.sourceCount && item.sourceCount > 1
          ? `${escapeHtml(item.source)} &middot; ${item.sourceCount} sources`
          : escapeHtml(item.source);
        return `<div class="narrative-item">&bull; ${escapeHtml(item.headline)}
          <div class="narrative-source">${srcLabel}</div></div>`;
      };
      if (narrativesResult.domestic.length > 0) {
        body += `<h3>U.S. Domestic</h3>`;
        for (const item of narrativesResult.domestic) body += renderNarrativeItem(item);
      }
      if (narrativesResult.international.length > 0) {
        body += `<h3>International</h3>`;
        for (const item of narrativesResult.international) body += renderNarrativeItem(item);
      }
      addPage(SECTION_LABELS.topNarratives, body);
    }
  }

  // State-Controlled Narratives
  if (sections.has('stateNarratives')) {
    if (stateResult.byCountry.size === 0) {
      addPage(SECTION_LABELS.stateNarratives,
        '<p class="no-stories">No state-controlled narrative coverage for the selected time period.</p>');
    } else {
      let body = '';
      for (const [country, items] of Array.from(stateResult.byCountry.entries())) {
        body += `<p class="state-country">${escapeHtml(country.toUpperCase())}</p>`;
        for (const item of items) {
          body += `<div class="state-item">
            <span class="state-source">${escapeHtml(item.source)}:</span>
            &ldquo;${escapeHtml(item.headline)}&rdquo;
          </div>`;
        }
      }
      addPage(SECTION_LABELS.stateNarratives, body);
    }
  }

  // POTUS & Official Messaging
  if (sections.has('potusMessaging')) {
    if (messagingPosts.length === 0) {
      addPage(SECTION_LABELS.potusMessaging,
        '<p class="no-stories">No official messaging in the selected time period.</p>');
    } else {
      const body = messagingPosts.map(post => {
        const timeStr = formatInTimeZone(post.postedAt, EASTERN_TZ, 'MMM d HH:mm');
        const snippet = post.content.length > 280 ? post.content.slice(0, 280) + '…' : post.content;
        return `<div class="social-post">
          <span class="social-handle">${escapeHtml(post.handle)}</span>
          <span class="social-time">${escapeHtml(timeStr)} ET</span>
          <div class="social-content">${escapeHtml(snippet)}</div>
        </div>`;
      }).join('');
      addPage(SECTION_LABELS.potusMessaging, body);
    }
  }

  // Aerial View
  if (sections.has('aerialView')) {
    const hasAerial = aerialResult.domestic.length > 0 || aerialResult.international.length > 0;
    if (!hasAerial) {
      const aerialNote = aerialResult.outOfWindow
        ? 'Aerial View reflects the current public news radar — not available for historical time windows.'
        : 'Aerial View data unavailable. Check back after the next refresh cycle.';
      addPage(SECTION_LABELS.aerialView, `<p class="no-stories">${aerialNote}</p>`);
    } else {
      let body = '';
      const renderBucket = (label: string, items: CompetingCoverageItem[]) => {
        if (!items.length) return;
        body += `<h3>${escapeHtml(label)}</h3>`;
        for (const item of items) {
          const blindSpot = item.blindSpot ? ' <span class="blind-spot">[blind spot]</span>' : '';
          const src = item.source ? `<div class="aerial-source">${escapeHtml(item.source)}</div>` : '';
          body += `<div class="aerial-item">&bull; ${escapeHtml(item.headline)}${blindSpot}${src}</div>`;
        }
      };
      renderBucket('U.S. Domestic Coverage', aerialResult.domestic);
      renderBucket('International Coverage', aerialResult.international);
      if (aerialResult.buzz.length > 0) renderBucket('Trending', aerialResult.buzz);
      addPage(SECTION_LABELS.aerialView, body);
    }
  }

  // Additional Intelligence
  if (sections.has('additionalIntelligence')) {
    if (additionalStories.length === 0) {
      addPage(SECTION_LABELS.additionalIntelligence,
        '<p class="no-stories">No additional intelligence stories available for the selected time period.</p>');
    } else {
      const body = additionalStories.map(s => storyHtml(s, 0, false)).join('');
      addPage(SECTION_LABELS.additionalIntelligence, body);
    }
  }

  if (pages.length === 0) {
    pages.push(`${htmlPageOpen('BRIEFING CARD', dateHeader)}
      <p class="no-stories">No sections selected.</p>
    ${htmlPageClose()}`);
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Briefing Card - ${dateHeader}</title>
  <style>${HTML_STYLES}</style>
</head>
<body>
  ${pages.join('\n  ')}
  <script>window.onload = function() { window.print(); };</script>
</body>
</html>`;
}
