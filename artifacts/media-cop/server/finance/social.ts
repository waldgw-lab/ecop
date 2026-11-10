import type { FinancialSocialFeed } from "../../shared/financeSocial";
import { downloadPublicText } from "./publicData";
import { financeStoreReady, readState, readStories, saveState } from "./store";
import { dataminrSocialPosts, parseBlueskyPosts, PUBLIC_SOCIAL_ACCOUNTS } from "./socialParsing";

const REFRESH_MS = 15 * 60_000;
type Snapshot = Pick<FinancialSocialFeed, "posts" | "updatedAt" | "sources"> & { attemptedAt: string };
let running: Promise<void> | null = null;

export function refreshSocial(): Promise<void> {
  if (running) return running;
  if (!financeStoreReady()) return Promise.resolve();
  running = (async () => {
    const old = await readState<Snapshot>("socialSnapshot");
    if (old && Date.now() - Date.parse(old.attemptedAt) < REFRESH_MS) return;
    const now = Date.now();
    const stamp = new Date(now).toISOString();
    const result = await Promise.all(PUBLIC_SOCIAL_ACCOUNTS.map(async account => {
      try {
        const url = new URL("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed");
        url.searchParams.set("actor", account.handle);
        url.searchParams.set("limit", "50");
        url.searchParams.set("filter", "posts_no_replies");
        const posts = parseBlueskyPosts(JSON.parse(await downloadPublicText(url.href)), account, now);
        return { posts, source: { name: account.name, status: "healthy" as const, message: `Public Bluesky account @${account.handle}; financially relevant original posts. Publisher attribution does not independently verify a claim.` } };
      } catch {
        return {
          posts: (old?.posts ?? []).filter(p => p.handle === account.handle),
          source: { name: account.name, status: "error" as const, message: "Public feed could not be refreshed; any retained posts keep their original dates." },
        };
      }
    }));
    await saveState("socialSnapshot", {
      attemptedAt: stamp, updatedAt: result.some(r => r.source.status === "healthy") ? stamp : old?.updatedAt ?? null,
      posts: result.flatMap(r => r.posts).filter(p => Date.parse(p.publishedAt) >= now - 7 * 86_400_000),
      sources: result.map(r => r.source),
    } satisfies Snapshot);
  })().finally(() => { running = null; });
  return running;
}

export async function getSocialFeed(): Promise<FinancialSocialFeed> {
  const [snapshot, stories] = await Promise.all([readState<Snapshot>("socialSnapshot"), readStories()]);
  const dedup = new Map([...dataminrSocialPosts(stories), ...snapshot?.posts ?? []].map(p => [p.url, p]));
  const now = Date.now();
  const score = (p: FinancialSocialFeed["posts"][number]) => p.impact * Math.pow(0.5, Math.max(0, now - Date.parse(p.publishedAt)) / (72 * 3_600_000));
  return {
    posts: [...dedup.values()].filter(p => Date.parse(p.publishedAt) >= now - 7 * 86_400_000)
      .sort((a, b) => score(b) - score(a) || b.publishedAt.localeCompare(a.publishedAt)).slice(0, 100),
    updatedAt: snapshot?.updatedAt ?? null, refreshing: !!running,
    sources: snapshot?.sources ?? PUBLIC_SOCIAL_ACCOUNTS.map(a => ({ name: a.name, status: "unavailable", message: "Waiting for initial public-feed collection." })),
    meltwater: {
      configured: !!process.env.MELTWATER_API_KEY, status: process.env.MELTWATER_API_KEY ? "Search setup needed" : "Not configured",
      message: "Meltwater Listening needs a dedicated financial-social saved search and account export/search entitlement. Existing searches have not been changed. X text may require separate authorized X access; no Meltwater posts are claimed here.",
    },
  };
}
