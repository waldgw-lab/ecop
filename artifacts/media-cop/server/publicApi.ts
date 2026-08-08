import type { Express, Request, Response, NextFunction } from "express";
import { db } from "./db";
import { htmlToSmsText } from "./lib/htmlToSmsText";
import { desc, gte, eq, sql, and, isNull, count, inArray, notInArray, ilike } from "drizzle-orm";
import { CURATED_ONLY_OSINT_HANDLES } from "./curatedOnlyOsint";
import { storage } from "./storage";
import { normalizeIdentityUrl } from "./urlIdentity";
import { isRoundupDigestTitle } from "@shared/contentKind";
import {
  buildOutletIndex,
  findOutlet,
  deriveOutletBehavior,
  ADVERSARY_COUNTRIES,
  adversaryCountryToken,
} from "@shared/outletRegistry";
import {
  headlines,
  teamSubmissions,
  teamSubjects,
  firstAlerts,
  truthSocialPosts,
  xPosts,
  osintPosts,
  sentDefenderPosts,
  rapidResponsePosts,
  dowResponsePosts,
  scrapeMetadata,
} from "@shared/schema";

const VALID_SOURCE_TYPES = ["team_submission", "headline"] as const;
const VALID_PLATFORMS = ["truth-social", "x-twitter", "osint", "sentinel-defender", "rapid-response", "dow-response"] as const;

// The Curated store is a BOUNDED, aged-out store (wiped + rebuilt each clustering
// pass; standalone rows age out), so it stays small — low thousands. This is a
// pure SAFETY CEILING on rows scanned per build, NOT a windowing cap: rows are
// ordered newest-first, so even in the unlikely event the store ever grows past
// this, the freshest adversary items are the ones returned — qualifying records
// are never silently dropped out of the middle of the lane.
const STATE_MEDIA_SCAN_CEILING = 50_000;

// Short-TTL process cache for the built lane. Both /api/v1/status and
// /api/v1/state-media call buildStateMediaRecords(); without a cache each request
// re-scans the curated store and re-resolves the whole registry. The lane only
// changes as fast as curated ingest (minutes), so a short TTL is invisible to
// consumers while collapsing the repeat work and keeping the status count cheap.
// Mirrors the per-process feed/curated read caches (correct because the deploy is
// single-instance) and honors an x-mcop-no-cache bypass so the isolation /
// leak-regression harnesses always force a fresh compute.
const STATE_MEDIA_CACHE_TTL_MS = 30_000;
let stateMediaCache: { at: number; data: StateMediaRecord[] } | null = null;

interface StateMediaRecord {
  id: string;
  // Explicit adversary marker so the consumer can never mistake this for
  // trusted/main-feed content.
  stateMedia: true;
  source: string;
  title: string;
  summary: string | null;
  bullets: string[] | null;
  url: string;
  language: string;
  // Outlet origin country as a stable lowercase token (e.g. "iran",
  // "north-korea") — this is the country OF ORIGIN (outlet nationality), NOT the
  // story's content geography.
  country: string;
  originCountry: string;
  publishedAt: string | null;
}

// The English editions of these adversary outlets are what gets ingested into the
// curated store, so language is deterministically "en". Kept as a function so a
// non-English edition could be overridden here if one is ever added.
function deriveStateMediaLanguage(_source: string, _originCountry: string): string {
  return "en";
}

/**
 * Build the public adversary state-media lane from the live Curated store.
 *
 * Fail-closed and isolation-preserving: resolves each curated row's outlet via
 * the SAME shared registry helpers the internal /api/curated/state-narratives
 * lens uses, and keeps ONLY rows whose derived behavior is "contrast" AND whose
 * origin country is a designated adversary state. Trusted outlets, Curated "Top
 * Stories"/trusted content, social posts, and non-article media never appear.
 * De-duplicates by normalized identity URL (keeps the higher-priority copy of a
 * dual-keyed main:/curated: article). Sorted newest-first by published date.
 */
async function buildStateMediaRecords(): Promise<StateMediaRecord[]> {
  const [rows, registry] = await Promise.all([
    storage.getCuratedItemsForStateMedia(STATE_MEDIA_SCAN_CEILING),
    storage.getOutletRegistry(),
  ]);
  const outletIndex = buildOutletIndex(registry);
  const byUrl = new Map<string, StateMediaRecord & { priorityScore: number }>();

  for (const c of rows) {
    if (!c.title || !c.url) continue;
    const outlet = findOutlet(outletIndex, c.source, c.url);
    if (!outlet) continue; // fail-closed: unknown outlet -> no origin country
    const origin = outlet.originCountry;
    if (!origin || !ADVERSARY_COUNTRIES.includes(origin)) continue;
    const behavior = deriveOutletBehavior(outlet);
    if (behavior.blocked) continue; // hard-excluded everywhere
    // Only adversary STATE MEDIA (contrast class). Trusted reporting that happens
    // to be based in one of these countries never appears here.
    if (behavior.label !== "contrast") continue;
    // Social posts and non-article media are not narrative articles — skip.
    const sid = outlet.sourceIdentifier;
    if (typeof sid === "string" && sid.startsWith("social-")) continue;
    if (c.contentKind === "video" || c.contentKind === "audio" || c.contentKind === "podcast") continue;
    if (isRoundupDigestTitle(c.title)) continue;

    const key = normalizeIdentityUrl(c.url);
    const existing = byUrl.get(key);
    if (existing && existing.priorityScore >= c.priorityScore) continue;

    // Use the article's displayed published date, falling back to first-seen.
    // Defensive parse: a single row with an unparseable date must never throw
    // "RangeError: Invalid time value" and take down the whole lane — it yields
    // null (sorts last) instead.
    const published = c.articlePublishedAt ?? c.scrapedAt;
    const publishedMs = published != null ? new Date(published).getTime() : NaN;
    const publishedAt = Number.isNaN(publishedMs)
      ? null
      : new Date(publishedMs).toISOString();
    const token = adversaryCountryToken(origin);
    byUrl.set(key, {
      id: c.id,
      stateMedia: true,
      source: outlet.canonicalName || c.source,
      title: c.title,
      summary: c.summary && c.summary.trim() ? c.summary.trim() : null,
      bullets:
        Array.isArray(c.summaryBullets) && c.summaryBullets.length > 0
          ? c.summaryBullets
          : null,
      url: c.url,
      language: deriveStateMediaLanguage(c.source, origin),
      country: token,
      originCountry: token,
      publishedAt,
      priorityScore: c.priorityScore,
    });
  }

  return Array.from(byUrl.values())
    .sort(
      (a, b) =>
        new Date(b.publishedAt || 0).getTime() -
        new Date(a.publishedAt || 0).getTime(),
    )
    .map(({ priorityScore: _priorityScore, ...rest }) => rest);
}

/**
 * Cached accessor for the state-media lane. Returns the same immutable snapshot
 * to every caller within the TTL; callers must treat the array as read-only
 * (they already do — both endpoints `.filter()`/`.slice()` into fresh arrays and
 * never mutate). Pass `bypassCache` (set from the x-mcop-no-cache header) so the
 * isolation / leak-regression harnesses always see a freshly-built lane.
 */
async function getStateMediaRecords(bypassCache = false): Promise<StateMediaRecord[]> {
  if (
    !bypassCache &&
    stateMediaCache &&
    Date.now() - stateMediaCache.at < STATE_MEDIA_CACHE_TTL_MS
  ) {
    return stateMediaCache.data;
  }
  const data = await buildStateMediaRecords();
  stateMediaCache = { at: Date.now(), data };
  return data;
}

function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers["x-api-key"];
  const expectedKey = process.env.MCOP_API_KEY;

  if (!expectedKey) {
    return res.status(503).json({ success: false, error: "API not configured" });
  }

  if (!apiKey || apiKey !== expectedKey) {
    return res.status(401).json({ success: false, error: "Invalid or missing API key" });
  }

  next();
}

function parseQueryInt(val: any, defaultVal: number, max?: number): number {
  const parsed = parseInt(val, 10);
  if (isNaN(parsed) || parsed < 0) return defaultVal;
  if (max && parsed > max) return max;
  return parsed;
}

function parseQueryDate(val: any): Date | null {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

export function registerPublicApi(app: Express) {
  app.use("/api/v1", requireApiKey);

  app.get("/api/v1/status", async (req: Request, res: Response) => {
    try {
      const bypassCache = !!req.headers["x-mcop-no-cache"];
      const [
        [articleCount],
        [headlineCount],
        [alertCount],
        [truthCount],
        [xCount],
        [osintCount],
        [sentDefCount],
        [rapidCount],
        [dowCount],
        meta,
        stateMediaRecords,
      ] = await Promise.all([
        db.select({ value: count() }).from(teamSubmissions).where(isNull(teamSubmissions.deletedAt)),
        db.select({ value: count() }).from(headlines),
        db.select({ value: count() }).from(firstAlerts),
        db.select({ value: count() }).from(truthSocialPosts),
        db.select({ value: count() }).from(xPosts),
        db.select({ value: count() }).from(osintPosts).where(notInArray(osintPosts.sourceAccount, [...CURATED_ONLY_OSINT_HANDLES])),
        db.select({ value: count() }).from(sentDefenderPosts),
        db.select({ value: count() }).from(rapidResponsePosts),
        db.select({ value: count() }).from(dowResponsePosts),
        db.select().from(scrapeMetadata).where(eq(scrapeMetadata.id, "global")).limit(1),
        getStateMediaRecords(bypassCache),
      ]);

      res.json({
        success: true,
        count: 5,
        data: {
          endpoints: [
            { path: "/api/v1/articles", description: "News articles from team submissions and scraped headlines. Add include_full_text=true to include stored full article text on headline rows." },
            { path: "/api/v1/alerts", description: "DataMinr First Alert breaking news alerts" },
            { path: "/api/v1/social", description: "Social media posts (Truth Social, X/Twitter, OSINT)" },
            { path: "/api/v1/state-media", description: "Adversary state-media articles (quarantined, labeled; Iran/Russia/China/Cuba/North Korea)" },
            { path: "/api/v1/status", description: "This endpoint — API status and record counts" },
          ],
          counts: {
            articles: {
              teamSubmissions: articleCount.value,
              headlines: headlineCount.value,
            },
            alerts: alertCount.value,
            social: {
              truthSocial: truthCount.value,
              xTwitter: xCount.value,
              osint: osintCount.value,
              sentinelDefender: sentDefCount.value,
              rapidResponse: rapidCount.value,
              dowResponse: dowCount.value,
            },
            stateMedia: stateMediaRecords.length,
          },
          lastScrapeTime: meta[0]?.lastScrapeTime ?? null,
        },
      });
    } catch (error) {
      console.error("[Public API] Status error:", error);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  });

  app.get("/api/v1/articles", async (req: Request, res: Response) => {
    try {
      const limit = parseQueryInt(req.query.limit, 50, 500);
      const offset = parseQueryInt(req.query.offset, 0);
      const since = parseQueryDate(req.query.since);
      const sourceType = req.query.sourceType as string | undefined;
      const source = req.query.source as string | undefined;
      const priorityMin = req.query.priority_min ? parseInt(req.query.priority_min as string, 10) : null;
      // Official opt-in flag (Task #780 follow-through): when set, headline
      // rows include their stored full article text. Off by default so
      // existing consumers see no payload-size change; team submissions have
      // always included fullText regardless.
      const includeFullText =
        req.query.include_full_text === "true" || req.query.include_full_text === "1";

      if (sourceType && !VALID_SOURCE_TYPES.includes(sourceType as any)) {
        return res.status(400).json({ success: false, error: `Invalid sourceType. Valid values: ${VALID_SOURCE_TYPES.join(", ")}` });
      }

      const results: any[] = [];

      if (!sourceType || sourceType === "team_submission") {
        const conditions: any[] = [isNull(teamSubmissions.deletedAt)];
        if (since) conditions.push(gte(teamSubmissions.createdAt, since));
        if (source) conditions.push(eq(teamSubmissions.submittedByName, source));
        if (priorityMin !== null && !isNaN(priorityMin)) conditions.push(gte(teamSubmissions.priorityScore, priorityMin));

        const subs = await db
          .select({
            id: teamSubmissions.id,
            headline: teamSubmissions.headline,
            summary: teamSubmissions.summary,
            fullText: teamSubmissions.fullText,
            sourceUrl: teamSubmissions.sourceUrl,
            sourceName: teamSubmissions.sourceName,
            submittedBy: teamSubmissions.submittedByName,
            sourceType: teamSubmissions.sourceType,
            priorityScore: teamSubmissions.priorityScore,
            ogImageUrl: teamSubmissions.ogImageUrl,
            subjectId: teamSubmissions.subjectId,
            createdAt: teamSubmissions.createdAt,
          })
          .from(teamSubmissions)
          .where(and(...conditions))
          .orderBy(desc(teamSubmissions.createdAt))
          .limit(sourceType ? limit : limit + offset)
          .offset(sourceType ? offset : 0);

        const subjectIds = [...new Set(subs.filter(s => s.subjectId).map(s => s.subjectId!))];
        let subjectMap: Record<string, string> = {};
        if (subjectIds.length > 0) {
          const subjects = await db
            .select({ id: teamSubjects.id, name: teamSubjects.name })
            .from(teamSubjects)
            .where(inArray(teamSubjects.id, subjectIds));
          subjectMap = Object.fromEntries(subjects.map(s => [s.id, s.name]));
        }

        for (const sub of subs) {
          results.push({
            id: sub.id,
            dataSource: "team_submission",
            title: sub.headline,
            summary: sub.summary,
            fullText: sub.fullText || null,
            url: sub.sourceUrl,
            source: sub.sourceName || sub.submittedBy,
            submittedBy: sub.submittedBy,
            contentType: sub.sourceType,
            priority: sub.priorityScore,
            topic: sub.subjectId ? (subjectMap[sub.subjectId] || null) : null,
            imageUrl: sub.ogImageUrl || null,
            publishedAt: sub.createdAt,
          });
        }
      }

      if (!sourceType || sourceType === "headline") {
        const conditions: any[] = [
          // Exclude warfighter-only outlets (Blaze, Epoch, Daily Wire) from the
          // public API — they only belong on /mcop/warfighter.
          isNull(headlines.restrictedToMcops),
        ];
        if (since) conditions.push(gte(headlines.scrapedAt, since));
        if (source) conditions.push(eq(headlines.source, source));
        if (priorityMin !== null && !isNaN(priorityMin)) conditions.push(gte(headlines.priorityScore, priorityMin));

        const hdls = await db
          .select({
            id: headlines.id,
            title: headlines.title,
            url: headlines.url,
            source: headlines.source,
            category: headlines.category,
            summary: headlines.summary,
            priorityScore: headlines.priorityScore,
            tags: headlines.tags,
            ogImageUrl: headlines.ogImageUrl,
            summaryBullets: headlines.summaryBullets,
            scrapedAt: headlines.scrapedAt,
            articlePublishedAt: headlines.articlePublishedAt,
            ...(includeFullText ? { fullText: headlines.fullText } : {}),
          })
          .from(headlines)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(headlines.scrapedAt))
          .limit(sourceType ? limit : limit + offset)
          .offset(sourceType ? offset : 0);

        for (const h of hdls) {
          results.push({
            id: h.id,
            dataSource: "headline",
            title: h.title,
            summary: h.summary,
            fullText: includeFullText ? ((h as any).fullText ?? null) : null,
            url: h.url,
            source: h.source,
            submittedBy: null,
            contentType: h.category,
            priority: h.priorityScore,
            topic: null,
            tags: h.tags,
            bullets: h.summaryBullets || null,
            imageUrl: h.ogImageUrl || null,
            publishedAt: h.articlePublishedAt || h.scrapedAt,
          });
        }
      }

      results.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

      const paginated = sourceType ? results : results.slice(offset, offset + limit);

      res.json({ success: true, count: paginated.length, data: paginated });
    } catch (error) {
      console.error("[Public API] Articles error:", error);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  });

  app.get("/api/v1/alerts", async (req: Request, res: Response) => {
    try {
      const limit = parseQueryInt(req.query.limit, 50, 500);
      const offset = parseQueryInt(req.query.offset, 0);
      const since = parseQueryDate(req.query.since);
      const alertType = req.query.alertType as string | undefined;
      const topic = req.query.topic as string | undefined;

      const conditions: any[] = [];
      if (since) conditions.push(gte(firstAlerts.publishedAt, since));
      if (alertType) conditions.push(eq(firstAlerts.alertType, alertType));
      if (topic) {
        conditions.push(sql`EXISTS (SELECT 1 FROM unnest(${firstAlerts.alertTopics}) AS t WHERE t ILIKE ${'%' + topic + '%'})`);
      }

      const rows = await db
        .select()
        .from(firstAlerts)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(firstAlerts.publishedAt))
        .limit(limit)
        .offset(offset);

      const data = rows.map(r => ({
        id: r.id,
        alertId: r.alertId,
        headline: r.headline,
        subHeadline: r.subHeadline || null,
        url: r.url,
        publishedAt: r.publishedAt,
        alertType: r.alertType || null,
        topics: r.alertTopics,
        lists: r.alertLists,
        location: r.location || null,
        latitude: r.latitude || null,
        longitude: r.longitude || null,
        publicPostLink: r.publicPostLink || null,
        publicPostText: r.publicPostText || null,
      }));

      res.json({ success: true, count: data.length, data });
    } catch (error) {
      console.error("[Public API] Alerts error:", error);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  });

  app.get("/api/v1/social", async (req: Request, res: Response) => {
    try {
      const limit = parseQueryInt(req.query.limit, 50, 500);
      const offset = parseQueryInt(req.query.offset, 0);
      const since = parseQueryDate(req.query.since);
      const platform = req.query.platform as string | undefined;
      const sourceAccount = req.query.sourceAccount as string | undefined;

      if (platform && !VALID_PLATFORMS.includes(platform as any)) {
        return res.status(400).json({ success: false, error: `Invalid platform. Valid values: ${VALID_PLATFORMS.join(", ")}` });
      }

      const fetchLimit = platform ? limit : limit + offset;
      const results: any[] = [];

      if (!platform || platform === "truth-social") {
        const conditions: any[] = [eq(truthSocialPosts.isHidden, false)];
        if (since) conditions.push(gte(truthSocialPosts.postedAt, since));

        const posts = await db
          .select()
          .from(truthSocialPosts)
          .where(and(...conditions))
          .orderBy(desc(truthSocialPosts.postedAt))
          .limit(platform ? limit : fetchLimit)
          .offset(platform ? offset : 0);

        for (const p of posts) {
          results.push({
            id: p.id,
            platform: "truth-social",
            sourceAccount: "POTUS",
            content: htmlToSmsText(p.content),
            url: p.truthSocialUrl,
            imageUrl: p.imageUrl || null,
            videoUrl: p.videoUrl || null,
            isRepost: p.isReblog,
            repostedFrom: p.rebloggedFrom || null,
            postedAt: p.postedAt,
          });
        }
      }

      if (!platform || platform === "x-twitter") {
        const conditions: any[] = [eq(xPosts.isHidden, false)];
        if (since) conditions.push(gte(xPosts.postedAt, since));
        if (sourceAccount) conditions.push(eq(xPosts.sourceAccount, sourceAccount));

        const posts = await db
          .select()
          .from(xPosts)
          .where(and(...conditions))
          .orderBy(desc(xPosts.postedAt))
          .limit(platform ? limit : fetchLimit)
          .offset(platform ? offset : 0);

        for (const p of posts) {
          results.push({
            id: p.id,
            platform: "x-twitter",
            sourceAccount: p.sourceAccount,
            content: p.content,
            url: p.xUrl,
            imageUrl: p.imageUrl || null,
            videoUrl: null,
            isRepost: p.isRetweet,
            repostedFrom: p.retweetedFrom || null,
            postedAt: p.postedAt,
          });
        }
      }

      if (!platform || platform === "osint") {
        const conditions: any[] = [
          eq(osintPosts.isHidden, false),
          // Combatant-command handles are curated-only — never expose via public API.
          notInArray(osintPosts.sourceAccount, [...CURATED_ONLY_OSINT_HANDLES]),
        ];
        if (since) conditions.push(gte(osintPosts.postedAt, since));
        if (sourceAccount) conditions.push(eq(osintPosts.sourceAccount, sourceAccount));

        const posts = await db
          .select()
          .from(osintPosts)
          .where(and(...conditions))
          .orderBy(desc(osintPosts.postedAt))
          .limit(platform ? limit : fetchLimit)
          .offset(platform ? offset : 0);

        for (const p of posts) {
          results.push({
            id: p.id,
            platform: "osint",
            sourceAccount: p.sourceAccount,
            content: p.content,
            url: p.xUrl,
            imageUrl: p.imageUrl || null,
            videoUrl: p.videoUrl || null,
            isRepost: false,
            repostedFrom: null,
            postedAt: p.postedAt,
          });
        }
      }

      if (!platform || platform === "sentinel-defender") {
        const conditions: any[] = [eq(sentDefenderPosts.isHidden, false)];
        if (since) conditions.push(gte(sentDefenderPosts.postedAt, since));

        const posts = await db
          .select()
          .from(sentDefenderPosts)
          .where(and(...conditions))
          .orderBy(desc(sentDefenderPosts.postedAt))
          .limit(platform ? limit : fetchLimit)
          .offset(platform ? offset : 0);

        for (const p of posts) {
          results.push({
            id: p.id,
            platform: "sentinel-defender",
            sourceAccount: "SentDefender",
            content: p.content,
            url: p.xUrl,
            imageUrl: p.imageUrl || null,
            videoUrl: p.videoUrl || null,
            isRepost: false,
            repostedFrom: null,
            postedAt: p.postedAt,
          });
        }
      }

      if (!platform || platform === "rapid-response") {
        const conditions: any[] = [eq(rapidResponsePosts.isHidden, false)];
        if (since) conditions.push(gte(rapidResponsePosts.postedAt, since));

        const posts = await db
          .select()
          .from(rapidResponsePosts)
          .where(and(...conditions))
          .orderBy(desc(rapidResponsePosts.postedAt))
          .limit(platform ? limit : fetchLimit)
          .offset(platform ? offset : 0);

        for (const p of posts) {
          results.push({
            id: p.id,
            platform: "rapid-response",
            sourceAccount: "RapidResponse",
            content: p.content,
            url: p.xUrl,
            imageUrl: p.imageUrl || null,
            videoUrl: null,
            isRepost: false,
            repostedFrom: null,
            postedAt: p.postedAt,
          });
        }
      }

      if (!platform || platform === "dow-response") {
        const conditions: any[] = [eq(dowResponsePosts.isHidden, false)];
        if (since) conditions.push(gte(dowResponsePosts.postedAt, since));

        const posts = await db
          .select()
          .from(dowResponsePosts)
          .where(and(...conditions))
          .orderBy(desc(dowResponsePosts.postedAt))
          .limit(platform ? limit : fetchLimit)
          .offset(platform ? offset : 0);

        for (const p of posts) {
          results.push({
            id: p.id,
            platform: "dow-response",
            sourceAccount: "DOWResponse",
            content: p.content,
            url: p.xUrl,
            imageUrl: p.imageUrl || null,
            videoUrl: null,
            isRepost: false,
            repostedFrom: null,
            postedAt: p.postedAt,
          });
        }
      }

      results.sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime());

      const paginated = platform ? results : results.slice(offset, offset + limit);

      res.json({ success: true, count: paginated.length, data: paginated });
    } catch (error) {
      console.error("[Public API] Social error:", error);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  });

  // Quarantined, clearly-labeled adversary state-media lane. Exposes ONLY the
  // already-isolated Curated adversary/contrast content (Iran/Russia/China/Cuba/
  // North Korea state media), unmistakably flagged. The main feeds and the other
  // public endpoints (/articles, /social, /alerts) stay completely clean and are
  // unaffected — this is a separate door, never a blend.
  app.get("/api/v1/state-media", async (req: Request, res: Response) => {
    try {
      const limit = parseQueryInt(req.query.limit, 50, 500);
      const offset = parseQueryInt(req.query.offset, 0);
      const since = parseQueryDate(req.query.since);
      const country = req.query.country as string | undefined;

      const validTokens = ADVERSARY_COUNTRIES.map(adversaryCountryToken);
      let countryToken: string | null = null;
      if (country) {
        countryToken = adversaryCountryToken(country);
        if (!validTokens.includes(countryToken)) {
          return res.status(400).json({ success: false, error: `Invalid country. Valid values: ${validTokens.join(", ")}` });
        }
      }

      let records = await getStateMediaRecords(!!req.headers["x-mcop-no-cache"]);
      if (countryToken) records = records.filter((r) => r.country === countryToken);
      if (since) {
        const sinceMs = since.getTime();
        records = records.filter((r) => r.publishedAt && new Date(r.publishedAt).getTime() >= sinceMs);
      }

      const paginated = records.slice(offset, offset + limit);
      res.json({ success: true, count: paginated.length, data: paginated });
    } catch (error) {
      console.error("[Public API] State-media error:", error);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  });

  console.log("[Public API] Registered /api/v1/ endpoints (articles, alerts, social, state-media, status)");
}
