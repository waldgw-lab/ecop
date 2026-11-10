import Parser from "rss-parser";
import { load } from "cheerio";
import { FINANCE_SOURCES, REFRESH_MS } from "./config";
import { classifyFinance, financeId, rankFinanceStories } from "./scoring";
import { downloadPublicText } from "./publicData";
import { financeStoreReady, readState, readStories, saveState, saveStories, type FinanceHealthStore } from "./store";
import { indicatorsRefreshing, refreshIndicators } from "./indicators";
import { scrapeFirstAlerts } from "../firstAlertScraper";
import type { FinanceDashboard, FinanceSourceHealth, FinanceStory } from "../../shared/finance";
import { FINANCE_REGIONS, FINANCE_TOPICS } from "../../shared/finance";

const parser = new Parser();
let refreshing: Promise<void> | null = null;
let nextRefreshAt: string | null = null;
let started = false;
export const dataminrConfigured = () => !!(process.env.DATAMINR_API_USER_ID && process.env.DATAMINR_API_PASSWORD);
const plain = (input: string | undefined) => load(`<div>${input ?? ""}</div>`).text().replace(/\s+/g, " ").trim();
const initialHealth = (): FinanceHealthStore => Object.fromEntries([
  ...FINANCE_SOURCES.map(s => [s.id, { ...s, status: "unavailable", lastAttemptAt: null, lastSuccessAt: null, latestPublicationAt: null, received: 0, relevant: 0, message: "Waiting for initial collection." }]),
  ["dataminr", { id: "dataminr", name: "Dataminr First Alert", kind: "dataminr", url: "https://www.dataminr.com/products/first-alert/", status: "unavailable", lastAttemptAt: null, lastSuccessAt: null, latestPublicationAt: null, received: 0, relevant: 0, message: "Waiting to check the existing connection." }],
]) as FinanceHealthStore;

export function refreshFinance(): Promise<void> {
  if (refreshing) return refreshing;
  if (!financeStoreReady()) return Promise.reject(new Error("Financial database initialization has not completed"));
  refreshing = (async () => {
    const health = { ...initialHealth(), ...await readState<FinanceHealthStore>("sources") };
    const saveHealth = async (value: FinanceSourceHealth) => {
      health[value.id] = value;
      await saveState("sources", health);
    };
    // Each source has a timeout; parallel groups keep ingestion responsive without flooding publishers.
    for (let i = 0; i < FINANCE_SOURCES.length; i += 4) {
      await Promise.all(FINANCE_SOURCES.slice(i, i + 4).map(async source => {
        const last = health[source.id];
        const attempt = new Date().toISOString();
        try {
          const feed = await parser.parseString(await downloadPublicText(source.url));
          const stories: FinanceStory[] = [];
          let latest: string | null = null;
          for (const item of feed.items.slice(0, 60)) {
            const timestamp = Date.parse(item.isoDate ?? item.pubDate ?? "");
            // Never replace an absent publish time with the fetch time.
            if (!Number.isFinite(timestamp) || timestamp > Date.now() + 300_000) continue;
            const publishedAt = new Date(timestamp).toISOString();
            if (!latest || publishedAt > latest) latest = publishedAt;
            if (timestamp < Date.now() - 7 * 86_400_000 || !item.title || !item.link) continue;
            const story = classifyFinance({ title: plain(item.title), summary: plain(item.contentSnippet ?? item.summary ?? item.content).slice(0, 700), url: item.link, source: source.name, owner: source.owner, kind: source.kind, publishedAt });
            if (story) stories.push(story);
          }
          await saveStories(stories);
          await saveHealth({ ...last, ...source, status: "healthy", lastAttemptAt: attempt, lastSuccessAt: new Date().toISOString(), latestPublicationAt: latest, received: feed.items.length, relevant: stories.length, message: latest && Date.parse(latest) < Date.now() - 7 * 86_400_000 ? "Feed accessible; newest publication is more than seven days old." : "Public feed metadata and publisher-provided excerpts. Full articles may require a subscription." });
        } catch (error) {
          await saveHealth({ ...last, status: "error", lastAttemptAt: attempt, message: error instanceof Error ? error.message : "Source collection failed" });
        }
      }));
    }
    const last = health.dataminr;
    if (!dataminrConfigured()) {
      await saveHealth({ ...last, status: "unavailable", lastAttemptAt: new Date().toISOString(), message: "The existing Dataminr credentials are not available to this runtime." });
    } else {
      try {
        // Reuse the existing authorized First Alert API; no new paid connection or upstream watchlist mutation.
        const stories: FinanceStory[] = [];
        const alerts = await scrapeFirstAlerts(true, {
          financial: true,
          cursor: await readState<string>("dataminrCursor"),
          onParsed: async (batch, cursor) => {
            for (const alert of batch) {
              const publishedAt = new Date(alert.publishedAt).toISOString();
              if (Date.parse(publishedAt) < Date.now() - 7 * 86_400_000) continue;
              const story = classifyFinance({
                id: financeId(`dataminr:${alert.alertId}`), title: alert.headline,
                summary: [alert.subHeadline, alert.publicPostText].filter(Boolean).join(" ").slice(0, 700),
                url: alert.publicPostLink ?? alert.url, source: "Dataminr First Alert", owner: "Dataminr",
                kind: "dataminr", publishedAt, alertType: alert.alertType, terms: alert.termsOfUse,
              });
              if (story) stories.push(story);
            }
            await saveStories(stories);
            if (cursor) await saveState("dataminrCursor", cursor);
          },
        });
        await saveHealth({ ...last, status: "healthy", lastAttemptAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), latestPublicationAt: alerts.map(a => new Date(a.publishedAt).toISOString()).sort().at(-1) ?? last.latestPublicationAt, received: alerts.length, relevant: stories.length, message: `Existing account watchlists; ${alerts.length} alerts received, ${stories.length} finance-relevant. Account/watchlist settings were not changed. An alert is an attributed signal, not independent confirmation.` });
      } catch (error) {
        await saveHealth({ ...last, status: "error", lastAttemptAt: new Date().toISOString(), message: `${error instanceof Error ? error.message : "Dataminr collection failed"}. Existing watchlists and account permissions may limit coverage.` });
      }
    }
    // Final snapshot avoids out-of-order concurrent per-source writes leaving old status behind.
    await saveState("sources", health);
    await saveState("lastRefresh", new Date().toISOString());
    nextRefreshAt = new Date(Date.now() + REFRESH_MS).toISOString();
  })().finally(() => { refreshing = null; });
  return refreshing;
}
export function startFinanceCollection() {
  if (started) return;
  started = true;
  const collect = () => {
    void refreshFinance().catch(error => console.error("[Finance] Collection failed:", error.message));
    void refreshIndicators().catch(error => console.error("[Finance] Indicator refresh failed:", error.message));
  };
  collect();
  setInterval(collect, REFRESH_MS).unref();
}
export async function getFinanceDashboard(): Promise<FinanceDashboard> {
  const health = { ...initialHealth(), ...await readState<FinanceHealthStore>("sources") };
  const items = await readStories();
  return {
    stories: rankFinanceStories(items.filter(s => s.kind === "reporting" || s.kind === "official")).slice(0, 150),
    signals: rankFinanceStories(items.filter(s => s.kind === "dataminr" || s.kind === "social")).slice(0, 100),
    sources: Object.values(health), topics: FINANCE_TOPICS, regions: FINANCE_REGIONS,
    updatedAt: await readState<string>("lastRefresh"), refreshing: !!refreshing || indicatorsRefreshing(), nextRefreshAt,
    dataminr: { configured: dataminrConfigured(), status: health.dataminr.status, message: health.dataminr.message },
    socialAccounts: [
      { name: "Federal Reserve", handle: "federalreserve", focus: "U.S. monetary policy and banking", role: "Institution", status: "Via public releases" },
      { name: "European Central Bank", handle: "ecb", focus: "Euro-area monetary and banking conditions", role: "Institution", status: "Via public releases" },
      { name: "U.S. EIA", handle: "EIAgov", focus: "Energy supply, inventories and prices", role: "Institution", status: "Via public releases" },
      { name: "U.S. Treasury", handle: "USTreasury", focus: "Fiscal policy and economic sanctions", role: "Institution", status: "Not directly collected" },
      { name: "IMF", handle: "IMFNews", focus: "Sovereign financing and global stability", role: "Institution", status: "Not directly collected" },
      { name: "Nick Timiraos", handle: "NickTimiraos", focus: "Federal Reserve reporting", role: "Journalist", status: "Not directly collected" },
      { name: "Javier Blas", handle: "JavierBlas", focus: "Energy and commodities reporting", role: "Journalist", status: "Not directly collected" },
      { name: "Brad Setser", handle: "Brad_Setser", focus: "Sovereign debt and capital flows analysis", role: "Analyst", status: "Not directly collected" },
    ].map(a => ({ ...a, url: `https://x.com/${a.handle}` })) as FinanceDashboard["socialAccounts"],
    methodology: {
      title: "Stability-impact screening · rules, not predictions",
      description: "Transparent keyword screening ranks potential financial/security consequences, not investment opportunity. High impact means importance, not necessarily worsening conditions: relief or de-escalation can also be consequential. Impact decays with a 72-hour half-life; the evidence breakdown shows the original score. Confidence is kept separate. Similar headlines are conservatively grouped, not treated as independent confirmation.",
      weights: [{ label: "Systemic consequence", maximum: 35 }, { label: "Potential reach", maximum: 20 }, { label: "Immediacy / abnormality", maximum: 20 }, { label: "Security / critical supplies", maximum: 15 }, { label: "Persistence / escalation", maximum: 10 }],
      limitations: [
        "AI processing remains disabled by the existing operator setting. Scores and geographic/topic labels are deterministic screening, not analyst-verified forecasts.",
        "Dataminr uses existing account watchlists. No new financial watchlists, subscriptions or account changes were made; coverage may remain military-heavy.",
        "The social roster is a watchlist, not a claim of direct X collection. Institutional coverage uses public releases; social links appearing in Dataminr remain attributed early-warning signals.",
        "Different publication owners or near-identical headlines do not prove independent corroboration. Critical signals require human verification.",
        "Only public feed excerpts are stored, not paywalled full articles. Some feeds/series may be delayed, stale or unavailable. This mirror does not run the original military scrapers or notifications.",
      ],
    },
  };
}
