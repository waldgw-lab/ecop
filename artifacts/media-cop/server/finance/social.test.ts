import { test } from "node:test";
import assert from "node:assert/strict";
import { dataminrSocialPosts, parseBlueskyPosts } from "./socialParsing";
import type { FinanceStory } from "../../shared/finance";

const now = Date.parse("2026-11-10T22:00:00Z");
const account = { name: "Financial Times", handle: "financialtimes.com" };
const record = (text = "Oil supply disruption raises inflation and fuel costs") => ({
  post: {
    uri: "at://did:plc:example/app.bsky.feed.post/abc123",
    author: { did: "did:plc:example", handle: account.handle },
    record: { text, createdAt: "2026-11-10T21:00:00Z" },
  },
});
test("public social parser retains original publisher text, publication date and attribution", () => {
  const [p] = parseBlueskyPosts({ feed: [record()] }, account, now);
  assert.equal(p.platform, "Bluesky");
  assert.equal(p.handle, account.handle);
  assert.equal(p.publishedAt, "2026-11-10T21:00:00.000Z");
  assert.equal(p.collectedAt, "2026-11-10T22:00:00.000Z");
  assert.equal(p.url, "https://bsky.app/profile/did%3Aplc%3Aexample/post/abc123");
  assert.equal(p.verification, "Publisher account");
});
test("social parser excludes unrelated posts, wrong authors, replies and spoofed post identities", () => {
  const wrong = record(); wrong.post.author.handle = "unrelated.example";
  const spoofed = record(); spoofed.post.uri = "at://did:plc:other/app.bsky.feed.post/abc";
  const reply = record() as ReturnType<typeof record> & { post: { record: { reply?: unknown } } };
  reply.post.record.reply = { parent: {} };
  assert.equal(parseBlueskyPosts({ feed: [record("Football championship final"), wrong, spoofed, reply] }, account, now).length, 0);
  assert.throws(() => parseBlueskyPosts({}, account, now), /post list/);
});
test("social publication dates are neither replaced by fetch time nor allowed beyond the freshness window", () => {
  const old = record(); old.post.record.createdAt = "2026-10-01T00:00:00Z";
  const future = record(); future.post.record.createdAt = "2026-11-11T00:00:00Z";
  const missing = record(); missing.post.record.createdAt = "";
  assert.equal(parseBlueskyPosts({ feed: [old, future, missing] }, account, now).length, 0);
});
test("only actual social permalinks become Dataminr social cards, and claims remain unconfirmed", () => {
  const base: FinanceStory = {
    id: "alert", title: "Bank liquidity emergency", summary: "Alert excerpt, not the original post text",
    url: "https://x.com/example/status/1234567", source: "Dataminr", owner: "Dataminr", kind: "dataminr",
    publishedAt: "2026-11-10T21:00:00Z", observedAt: "2026-11-10T21:05:00Z",
    topic: "Banking & liquidity", region: "Global", impact: 75, confidence: "Unconfirmed signal", reasons: [], evidence: [], sourceCount: 1, relatedSources: [],
  };
  const [post] = dataminrSocialPosts([base]);
  assert.equal(post.verification, "Unconfirmed signal");
  assert.equal(post.via, "Dataminr");
  assert.equal(post.author, "Dataminr report");
  assert.equal(dataminrSocialPosts([{ ...base, url: "https://app.dataminr.com/alert/123" }]).length, 0);
  assert.equal(dataminrSocialPosts([{ ...base, url: "https://x.com.attacker.invalid/example/status/1234" }]).length, 0);
});
