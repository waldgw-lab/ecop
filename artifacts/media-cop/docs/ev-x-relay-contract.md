# Evangelist Vortex (EV) → MCOP X/Twitter Relay Contract

EV is an external service (VM) that scrapes X/Twitter and pushes posts into MCOP
over an authenticated webhook. It mirrors the proven Truth Social relay: when EV
is healthy, MCOP's own Playwright X scrapers become backfill-only watchdogs
(dedup-by-postId skips anything EV already delivered); when EV goes stale
(>15 min with no delivery) the scrapers resume PRIMARY full-scrape duty
automatically. No new tables — EV posts land in the same lane tables the
scrapers populate.

## Endpoint

```
POST https://<mcop-host>/api/webhooks/x-relay
```

## Authentication

Send the shared secret in the `X-Api-Key` header. Requests without a matching
key get `401 Unauthorized`.

```
X-Api-Key: <EV_RELAY_API_KEY>
Content-Type: application/json
```

The key is stored in MCOP as the `EV_RELAY_API_KEY` secret.

## Pause switch

Set the `X_RELAY_PAUSED=true` env var in MCOP to make the webhook accept and
acknowledge requests **without** processing posts or updating the heartbeat
(the scrapers then run as PRIMARY). Remove it / set to anything else to resume.

## Request body

The webhook accepts any of these shapes (all unwrapped to a list of posts):

- a bare JSON array: `[ {post}, {post}, ... ]`
- a wrapper object with any of these array fields: `posts`, `data`, `items`,
  `tweets`, `results`, `records`
- a single post object

### Post fields (tolerant — first present wins)

Only `handle` is strictly required. Everything else has fallbacks; media-only
posts may send empty/absent `content`.

| Concept   | Accepted keys (any one) |
|-----------|-------------------------|
| handle*   | `handle`, `username`, `account`, `sourceAccount`, `source_account`, `screen_name`, `screenName`, `user`, `author`, `authorHandle` |
| content   | `content`, `text`, `body`, `message`, `status`, `description`, `post_content`, `post_text`, `full_text`, `tweet`, `tweet_text`, `note` |
| post id   | `postId`, `post_id`, `id`, `statusId`, `status_id`, `tweetId`, `tweet_id`, `externalId`, `external_id`, `uid` |
| timestamp | `postedAt`, `posted_at`, `created_at`, `createdAt`, `timestamp`, `date`, `published_at`, `publishedAt`, `time` |
| url       | `xUrl`, `x_url`, `url`, `link`, `post_url`, `permalink`, `href`, `tweet_url`, `tweetUrl`, `source_url` |
| image     | `imageUrl`, `image_url`, `image`, `media_url`, `photo`, `photo_url`, `picture`, `thumbnail`, `thumb`, `media_image` |
| video     | `videoUrl`, `video_url`, `video`, `media_video`, `video_link` |
| retweet   | `isRetweet`, `is_retweet`, `isRepost`, `is_repost`, `retweet`, `repost` (truthy) |
| rt source | `retweetedFrom`, `retweeted_from`, `repostedFrom`, `reposted_from`, `rt_from` |

`*` required.

A `media_attachments` / `mediaAttachments` / `attachments` / `media` array is
also unwrapped: the first `image`/`photo` element fills the image, the first
`video`/`gifv`/`animated_gif` element fills the video.

Fallbacks when fields are absent:
- **post id** → `xrelay-<sha256(content)[:16]>` (stable per content)
- **url** → `https://x.com/<handle>/status/<postId>`
- **timestamp** → now (unparseable values also fall back to now)

### Minimal example

```json
{
  "posts": [
    {
      "handle": "SecWar",
      "tweet_id": "1934567890123456789",
      "tweet_text": "Statement on today's operations.",
      "created_at": "2026-06-11T14:03:00Z",
      "media_attachments": [{ "type": "photo", "url": "https://pbs.twimg.com/media/abc.jpg" }]
    }
  ]
}
```

## Handle → lane routing

The handle (case-insensitive, leading `@` tolerated) decides which lane table
the post lands in. The registry is built from MCOP's canonical account lists, so
EV and the scrapers always agree on routing. **Unknown handles are logged and
skipped (fail-closed) — never written into the wrong lane.**

| Lane            | Table                    | Source list |
|-----------------|--------------------------|-------------|
| x-default       | `x_posts` (category `default`)     | `X_POSTS_ACCOUNTS` (xScraper.ts) |
| x-influencer    | `x_posts` (category `influencer`)  | `INFLUENCER_X_HANDLES` (shared/influencerXAccounts) |
| osint           | `osint_posts`            | `OSINT_ACCOUNTS` (osintScraper.ts) |
| journalist      | `journalist_posts`       | `JOURNALIST_ACCOUNTS` (osintScraper.ts) |
| rapidresponse   | `rapidresponse_posts`    | `Rapidresponse47` |
| dowresponse     | `dow_response_posts`     | `DOWResponse` |
| sentdefender    | `sentdefender_posts`     | `sentdefender` |

Dedicated single-handle lanes win over any overlap; first registration wins so
routing is deterministic regardless of list ordering.

## Response

`200 OK` with per-batch counts:

```json
{
  "status": "ok",
  "received": 3,
  "new": 2,
  "duplicates": 1,
  "unknownHandle": 0,
  "invalid": 0,
  "errors": 0
}
```

- `duplicates` — postId already present in the lane table (also covers a
  concurrent-scraper unique-constraint race).
- `unknownHandle` — handle not in the registry (skipped, fail-closed).
- `invalid` — payload missing a usable handle (skipped).

When paused: `{ "status": "paused", "heartbeat": false, "received": 0, "new": 0 }`.

## Status / observability

- `GET /api/admin/x-relay-status` (admin) and `GET /api/team/x-relay-status`
  (team) return `{ relayHealthy, lastHeartbeat, lastHeartbeatAgeSeconds,
  scraperMode }`.
- `scraperMode` is `WATCHDOG` while EV is healthy (heartbeat < 15 min old),
  `PRIMARY` otherwise. The scheduler also logs the current mode before each X
  scrape chain.

To keep MCOP in WATCHDOG mode, EV should deliver (or at least ping the webhook)
at least every 15 minutes.
