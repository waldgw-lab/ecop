import type { FinancialSocialPost } from "../../shared/financeSocial";
import type { FinanceStory } from "../../shared/finance";
import { classifyFinance } from "./scoring";

export { PUBLIC_SOCIAL_ACCOUNTS } from "../../shared/financeSocial";
type Account = { handle: string; name: string };

export function parseBlueskyPosts(payload: unknown, account: Account, now = Date.now()): FinancialSocialPost[] {
  const feed = (payload as { feed?: unknown[] })?.feed;
  if (!Array.isArray(feed)) throw new Error("Public social feed did not contain a post list");
  const posts: FinancialSocialPost[] = [];
  for (const entry of feed) {
    const p = (entry as { post?: { uri?: string; author?: { handle?: string; did?: string }; record?: { text?: string; createdAt?: string; reply?: unknown } } })?.post;
    const text = p?.record?.text;
    const published = Date.parse(p?.record?.createdAt ?? "");
    // Only original posts from the named domain account, never reposts or replies
    // by unrelated authors. Use publication time, not Bluesky's indexing time.
    if (p?.author?.handle !== account.handle || p.record?.reply || typeof text !== "string" || !text.trim() ||
      !Number.isFinite(published) || published > now + 300_000 || published < now - 7 * 86_400_000) continue;
    const match = p.uri?.match(/^at:\/\/(did:[a-z0-9:._%-]+)\/app\.bsky\.feed\.post\/([a-zA-Z0-9]+)$/);
    if (!match || match[1] !== p.author.did) continue;
    const url = `https://bsky.app/profile/${encodeURIComponent(match[1])}/post/${match[2]}`;
    const story = classifyFinance({
      title: text.slice(0, 200), summary: text, url, source: account.name, owner: account.name,
      kind: "social", publishedAt: new Date(published).toISOString(),
    });
    if (!story) continue;
    posts.push({
      id: p.uri!, text: text.slice(0, 3000), author: account.name, handle: account.handle, platform: "Bluesky",
      url, publishedAt: story.publishedAt, collectedAt: new Date(now).toISOString(),
      via: "Public Bluesky", impact: story.impact, topic: story.topic, verification: "Publisher account",
    });
  }
  return posts;
}

export function dataminrSocialPosts(stories: FinanceStory[]): FinancialSocialPost[] {
  return stories.filter(s => s.kind === "dataminr").flatMap(s => {
    let u: URL;
    try { u = new URL(s.url); } catch { return []; }
    if (u.protocol !== "https:" || u.username || u.password) return [];
    const x = /^(www\.)?(x\.com|twitter\.com)$/.test(u.hostname) && /^\/[A-Za-z0-9_]+\/status\/\d+\/?$/.test(u.pathname);
    const bluesky = u.hostname === "bsky.app" && /^\/profile\/[^/]+\/post\/[A-Za-z0-9]+\/?$/.test(u.pathname);
    if (!x && !bluesky) return [];
    return [{
      id: s.id, text: `${s.title}${s.summary ? `\n${s.summary}` : ""}`, author: "Dataminr report",
      handle: x ? u.pathname.split("/")[1] : null, platform: x ? "X" as const : "Bluesky" as const,
      url: s.url, publishedAt: s.publishedAt, collectedAt: s.observedAt, via: "Dataminr" as const,
      impact: s.impact, topic: s.topic, verification: "Unconfirmed signal" as const,
    }];
  });
}
