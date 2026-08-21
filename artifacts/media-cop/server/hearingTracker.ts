// =============================================================================
// HASC / SASC committee hearing tracker (Task #1077).
//
// C-SPAN polling was removed (server IPs are 403-blocked), so congressional
// testimony by KEY US defense leaders had no dedicated pickup path. This module
// goes committee-direct:
//   1. Hourly poll of both Armed Services Committee hearing calendars
//      (armedservices.house.gov + armed-services.senate.gov) — parse upcoming
//      hearings (title, date/time, witnesses, posted testimony PDFs) and store
//      them in committee_hearings, keyed on the detail-page URL.
//   2. Detection keys on the WITNESS LIST matching a key-leader roster
//      (SecDef, CJCS/VCJCS, service secretaries/chiefs, combatant commanders).
//      Non-leader hearings are stored with empty trackedLeaders and ignored
//      downstream.
//   3. Matched hearings feed the existing curated live-broadcast banner
//      (server/liveBroadcastStatus.ts reads committee_hearings — real startsAt
//      for the "upcoming" cue; live via the committee's own YouTube /live page).
//   4. Posted written-testimony documents are admitted through the NORMAL
//      curated intake gate (admitCuratedCandidates, mode 'gate') — full AI
//      relevance scoring, URL dedup, telemetry. Nothing bypasses lane rules.
//
// LANE ISOLATION: writes only committee_hearings + (via the normal gate)
// curated_items. Never touches headlines / Classic / Visual / custom MCOPs /
// the public API.
//
// Out of scope by design: C-SPAN (blocked), full transcripts, other committees.
// =============================================================================
import * as cheerio from "cheerio";
import { storage } from "./storage";
import { fetchWithResilience } from "./resilientFetch";
import { admitCuratedCandidates, type CuratedIntakeCandidate } from "./curatedIngest";
import { isAIIntegrationsDisabled } from "./aiClient";
import type { InsertCommitteeHearing } from "@shared/schema";

const HASC_BASE = "https://armedservices.house.gov";
const HASC_LIST_URL = `${HASC_BASE}/committee-activity/hearings`;
const SASC_BASE = "https://www.armed-services.senate.gov";
const SASC_LIST_URL = `${SASC_BASE}/hearings`;

// Committee YouTube live pages for the banner's keyless live check. HASC streams
// on @HouseArmedServices (verified reachable). NO public SASC channel was found
// from this infrastructure — SASC hearings get the "upcoming" cue only, with the
// hearing page itself (which embeds the committee's own player) as watchUrl.
export const COMMITTEE_YOUTUBE_LIVE: Record<string, string | null> = {
  HASC: "https://www.youtube.com/@HouseArmedServices/live",
  SASC: null,
};

export const COMMITTEE_FULL_NAME: Record<string, string> = {
  HASC: "House Armed Services Committee",
  SASC: "Senate Armed Services Committee",
};

// How far ahead to detail-fetch hearings (calendar pages list months out; only
// near-term ones need witness lists + times).
const DETAIL_LOOKAHEAD_MS = 21 * 24 * 60 * 60 * 1000; // 21 days
// How far back a hearing stays interesting (testimony PDFs are often posted
// the morning of, sometimes a day or two after).
const DETAIL_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
// Testimony admission window: hearing day ±.
const TESTIMONY_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
const TESTIMONY_LOOKAHEAD_MS = 1 * 24 * 60 * 60 * 1000;
// Cap detail fetches per committee per poll (politeness + bounded runtime).
const MAX_DETAIL_FETCHES = 12;

// --- Key-leader roster -------------------------------------------------------
// Matched against the WITNESS block text (names + role lines). Title-based so
// it survives personnel changes; incumbent surnames included only where the
// title alone may be absent. Ordered: vice-chairman MUST be tested before
// chairman (substring).
export const KEY_LEADER_ROSTER: { key: string; re: RegExp }[] = [
  { key: "secdef", re: /\bsecretary\s+of\s+(?:defense|war)\b|\bpete\s+hegseth\b/i },
  { key: "vcjcs", re: /\bvice\s+chairman\s+of\s+the\s+joint\s+chiefs\b/i },
  { key: "cjcs", re: /(?<!vice\s)\bchairman\s+of\s+the\s+joint\s+chiefs\b/i },
  { key: "service-secretary", re: /\bsecretary\s+of\s+the\s+(?:army|navy|air\s+force)\b/i },
  {
    key: "service-chief",
    re: /\bchief\s+of\s+staff\s+of\s+the\s+(?:army|air\s+force)\b|\bchief\s+of\s+naval\s+operations\b|\bcommandant\s+of\s+the\s+marine\s+corps\b|\bchief\s+of\s+space\s+operations\b/i,
  },
  {
    key: "cocom",
    re: /\bcommander\b[^\n,]{0,40}?,?\s+(?:u\.?\s?s\.?|united\s+states)\s+(?:central|indo[-\s]?pacific|european|africa|southern|northern|space|special\s+operations|strategic|transportation|cyber)\s+command\b/i,
  },
];

/** Roster keys matched in a witness-block text. Pure; exported for tests. */
export function matchKeyLeaders(witnessText: string): string[] {
  const t = witnessText || "";
  return KEY_LEADER_ROSTER.filter(({ re }) => re.test(t)).map(({ key }) => key);
}

// Banner mapping is deliberately FAIL-CLOSED and precise: only witnesses whose
// role maps to an exact banner label may light the curated banner. SecDef →
// "Secretary of War" (existing covered leader); CJCS → the new "Chairman of the
// Joint Chiefs" label. All other roster matches (VCJCS, service secretaries/
// chiefs, COCOMs) are tracked + testimony-ingested but never light the banner —
// a mislabeled banner is worse than a missed one (house precision rule).
export function bannerLeaderForRoster(keys: string[]): string | null {
  if (keys.includes("secdef")) return "Secretary of War";
  if (keys.includes("cjcs")) return "Chairman of the Joint Chiefs";
  return null;
}

// --- ET wall time → UTC ms ---------------------------------------------------
// Committee calendars list America/New_York wall times. Convert by computing
// the ET offset at (approximately) the target instant via Intl.
function etOffsetMs(atUtcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(atUtcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - atUtcMs;
}

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

/**
 * Parse a committee-calendar ET wall time into UTC ms.
 *   dateStr: "July 16, 2026" | "Thursday, June 4, 2026"
 *   timeStr: "10:00AM" | "04:15pm" | null (→ null: date known, time not)
 * Pure; exported for tests.
 */
export function parseEtHearingTime(dateStr: string, timeStr: string | null): number | null {
  const m = /([a-z]+)\s+(\d{1,2}),\s*(\d{4})/i.exec(dateStr || "");
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (month === undefined) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (!timeStr) return null;
  const tm = /(\d{1,2}):(\d{2})\s*(am|pm)/i.exec(timeStr);
  if (!tm) return null;
  let hour = Number(tm[1]) % 12;
  if (/pm/i.test(tm[3])) hour += 12;
  const minute = Number(tm[2]);
  // Wall time pretending it's UTC, then subtract the ET offset at that instant.
  const pretendUtc = Date.UTC(year, month, day, hour, minute, 0);
  return pretendUtc - etOffsetMs(pretendUtc);
}

// --- List / detail parsers (pure; exported for tests) -------------------------

export interface HearingListItem {
  title: string;
  eventUrl: string;
  /** "July 16, 2026"-style date text from the list page (no time for SASC). */
  dateText: string | null;
  /** HASC list carries the time too ("Thursday, June 4, 2026 - 10:00AM"). */
  timeText: string | null;
}

/** SASC list page: LegislationList__link anchors + sibling <time datetime="July 16, 2026">. */
export function parseSascList(html: string): HearingListItem[] {
  const $ = cheerio.load(html);
  const out: HearingListItem[] = [];
  const seen = new Set<string>();
  $("a.LegislationList__link, a[class*='LegislationList__link']").each((_, el) => {
    const a = $(el);
    const href = (a.attr("href") || "").trim();
    const title = a.text().replace(/\s+/g, " ").trim();
    if (!href || !title) return;
    const eventUrl = href.startsWith("http") ? href : `${SASC_BASE}${href.startsWith("/") ? "" : "/"}${href}`;
    if (seen.has(eventUrl)) return;
    seen.add(eventUrl);
    // The date lives in the same LegislationList__item row (dateCol), e.g.
    // <time datetime="July 16, 2026"> ... 07/16/26 <br> 09:30am </time>.
    let row = a.closest(".LegislationList__item");
    if (row.length === 0) row = a.closest("li, article, div.row");
    const timeEl = row.find("time").first();
    const dateText = (timeEl.attr("datetime") || "").replace(/\s+/g, " ").trim() || null;
    const timeMatch = /(\d{1,2}:\d{2}\s*(?:am|pm))/i.exec(timeEl.text() || "");
    out.push({ title, eventUrl, dateText, timeText: timeMatch ? timeMatch[1] : null });
  });
  return out;
}

/** HASC list page: EventSingle.aspx?EventID=N anchors + <time class="event-time" datetime="Thursday, June 4, 2026 - 10:00AM">. */
export function parseHascList(html: string): HearingListItem[] {
  const $ = cheerio.load(html);
  const out: HearingListItem[] = [];
  const seen = new Set<string>();
  $("a[href*='EventSingle.aspx?EventID='], a[href*='eventsingle.aspx?EventID=']").each((_, el) => {
    const a = $(el);
    const href = (a.attr("href") || "").trim();
    const idMatch = /EventID=(\d+)/i.exec(href);
    if (!idMatch) return;
    // Canonical detail URL (the list links use a different path that redirects).
    const eventUrl = `${HASC_BASE}/calendar/eventsingle.aspx?EventID=${idMatch[1]}`;
    const title = a.text().replace(/\s+/g, " ").trim();
    if (!title || seen.has(eventUrl)) return;
    seen.add(eventUrl);
    const timeEl = a.closest("li, article, div, tr").find("time.event-time, time").first();
    const raw = (timeEl.attr("datetime") || timeEl.text() || "").replace(/\s+/g, " ").trim();
    // "Thursday, June 4, 2026 - 10:00AM" → date part + time part.
    const parts = raw.split(/\s*-\s*/);
    out.push({
      title,
      eventUrl,
      dateText: parts[0] || null,
      timeText: parts[1] || null,
    });
  });
  return out;
}

export interface HearingDetail {
  timeText: string | null;
  witnesses: string[];
  testimonyUrls: string[];
}

/** SASC detail page: "Time: 04:15pm", a Witnesses block, testimony at /download/... */
export function parseSascDetail(html: string): HearingDetail {
  const $ = cheerio.load(html);
  const bodyText = $("body").text().replace(/[ \t]+/g, " ");
  const timeMatch = /Time:\s*(\d{1,2}:\d{2}\s*(?:am|pm))/i.exec(bodyText);
  // Witness lines: names + roles typically render as headings/paragraphs inside
  // the witness section. Grab the text window after the "Witnesses" marker.
  let witnesses: string[] = [];
  const wIdx = bodyText.search(/\bWitness(?:es)?\b/i);
  if (wIdx >= 0) {
    witnesses = bodyText
      .slice(wIdx, wIdx + 3000)
      .split(/\n+/)
      .map((l) => l.trim())
      .filter((l) => l.length > 3 && l.length < 300)
      .slice(0, 40);
  }
  const testimonyUrls: string[] = [];
  const seen = new Set<string>();
  $("a[href*='/download/'], a[href$='.pdf']").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    if (!href) return;
    const abs = href.startsWith("http") ? href : `${SASC_BASE}${href.startsWith("/") ? "" : "/"}${href}`;
    if (!seen.has(abs)) { seen.add(abs); testimonyUrls.push(abs); }
  });
  return { timeText: timeMatch ? timeMatch[1] : null, witnesses, testimonyUrls };
}

/** HASC detail page: witness lines + testimony PDFs under /UploadedFiles/. */
export function parseHascDetail(html: string): HearingDetail {
  const $ = cheerio.load(html);
  const bodyText = $("body").text().replace(/[ \t]+/g, " ");
  const timeMatch = /(\d{1,2}:\d{2}\s*(?:am|pm))/i.exec(bodyText);
  let witnesses: string[] = [];
  const wIdx = bodyText.search(/\bWitness(?:es)?\b/i);
  const windowText = wIdx >= 0 ? bodyText.slice(wIdx, wIdx + 3000) : bodyText;
  witnesses = windowText
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 3 && l.length < 300)
    .slice(0, 40);
  const testimonyUrls: string[] = [];
  const seen = new Set<string>();
  $("a[href*='UploadedFiles'], a[href$='.pdf']").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    if (!href || !/\.pdf(\?|$)/i.test(href)) return;
    const abs = href.startsWith("http") ? href : `${HASC_BASE}${href.startsWith("/") ? "" : "/"}${href}`;
    if (!seen.has(abs)) { seen.add(abs); testimonyUrls.push(abs); }
  });
  return { timeText: timeMatch ? timeMatch[1] : null, witnesses, testimonyUrls };
}

// --- Poll orchestration --------------------------------------------------------

async function fetchHtml(url: string, label: string): Promise<string | null> {
  try {
    const resp = await fetchWithResilience(url, {
      accept: "text/html,application/xhtml+xml,*/*",
      timeoutMs: 20000,
      retries: 1,
      label,
    });
    if (!resp.ok) {
      resp.body?.cancel().catch(() => {});
      console.warn(`[HearingTracker] ${label} HTTP ${resp.status} for ${url}`);
      return null;
    }
    return await resp.text();
  } catch (e) {
    console.warn(`[HearingTracker] ${label} fetch failed for ${url}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

interface CommitteePollResult {
  listed: number;
  detailed: number;
  tracked: number;
  errors: number;
}

async function pollCommittee(committee: "HASC" | "SASC", now: number): Promise<CommitteePollResult> {
  const result: CommitteePollResult = { listed: 0, detailed: 0, tracked: 0, errors: 0 };
  const listUrl = committee === "HASC" ? HASC_LIST_URL : SASC_LIST_URL;
  const html = await fetchHtml(listUrl, `HearingTracker:${committee}:list`);
  if (!html) { result.errors++; return result; }

  const items = committee === "HASC" ? parseHascList(html) : parseSascList(html);
  result.listed = items.length;
  if (items.length === 0) {
    // Fail-loud: an empty parse from a 200 page usually means the site markup
    // changed and the parser is silently broken.
    console.warn(`[HearingTracker] ${committee} list page parsed to 0 hearings — parser may be stale (${listUrl})`);
    return result;
  }

  // Detail-fetch only near-window hearings (bounded).
  let detailBudget = MAX_DETAIL_FETCHES;
  for (const item of items) {
    try {
      // Rough date screen from the list text (date only; time refined below).
      const roughMs = item.dateText
        ? parseEtHearingTime(item.dateText, item.timeText || "12:00pm")
        : null;
      if (roughMs !== null && (roughMs < now - DETAIL_LOOKBACK_MS || roughMs > now + DETAIL_LOOKAHEAD_MS)) {
        continue;
      }
      if (detailBudget <= 0) break;
      detailBudget--;
      const detailHtml = await fetchHtml(item.eventUrl, `HearingTracker:${committee}:detail`);
      if (!detailHtml) { result.errors++; continue; }
      result.detailed++;
      const detail = committee === "HASC" ? parseHascDetail(detailHtml) : parseSascDetail(detailHtml);
      const witnessText = detail.witnesses.join("\n") + "\n" + item.title;
      const trackedLeaders = matchKeyLeaders(witnessText);
      const timeText = item.timeText || detail.timeText;
      const startsMs = item.dateText ? parseEtHearingTime(item.dateText, timeText) : null;
      const hearing: InsertCommitteeHearing = {
        committee,
        title: item.title,
        eventUrl: item.eventUrl,
        startsAt: startsMs !== null ? new Date(startsMs) : null,
        witnesses: detail.witnesses.slice(0, 40),
        trackedLeaders,
        bannerLeader: bannerLeaderForRoster(trackedLeaders),
        testimonyUrls: detail.testimonyUrls.slice(0, 30),
      };
      await storage.upsertCommitteeHearing(hearing);
      if (trackedLeaders.length > 0) result.tracked++;
    } catch (e) {
      result.errors++;
      console.warn(`[HearingTracker] ${committee} item error (${item.eventUrl}):`, e instanceof Error ? e.message : e);
    }
  }
  return result;
}

/**
 * Admit posted testimony documents for TRACKED hearings around hearing day
 * through the NORMAL curated gate. URL dedup inside admitCuratedCandidates
 * makes re-submission across polls free; the AI relevance gate + telemetry run
 * exactly as for every other curated source. Curated lane only.
 */
async function admitPostedTestimony(now: number): Promise<{ ingested: number; skipped: number }> {
  // Keep the non-AI committee poll and hearing storage active, but defer the
  // AI-gated testimony handoff without querying/building candidates or logging a
  // false admission failure on every hourly poll.
  if (isAIIntegrationsDisabled()) {
    return { ingested: 0, skipped: 0 };
  }
  const hearings = await storage.getCommitteeHearingsInWindow(
    now - TESTIMONY_LOOKBACK_MS,
    now + TESTIMONY_LOOKAHEAD_MS,
  );
  const byCommittee: Record<string, CuratedIntakeCandidate[]> = {};
  for (const h of hearings) {
    if (!h.trackedLeaders || h.trackedLeaders.length === 0) continue;
    if (!h.testimonyUrls || h.testimonyUrls.length === 0) continue;
    for (const url of h.testimonyUrls) {
      (byCommittee[h.committee] ||= []).push({
        title: `Written testimony: ${h.title}`,
        url,
        source: COMMITTEE_FULL_NAME[h.committee] || h.committee,
        pubDate: h.startsAt ?? undefined,
        summary: `Prepared testimony posted for the ${COMMITTEE_FULL_NAME[h.committee] || h.committee} hearing "${h.title}" (witnesses include: ${h.witnesses.slice(0, 6).join("; ").slice(0, 400)}).`,
      });
    }
  }
  let ingested = 0, skipped = 0;
  for (const [committee, cands] of Object.entries(byCommittee)) {
    try {
      const r = await admitCuratedCandidates(cands, { mode: "gate", label: "hearing-testimony" });
      ingested += r.ingested;
      skipped += r.skipped;
      if (r.ingested > 0) {
        console.log(`[HearingTracker] ${committee} testimony admitted: ${r.ingested} (skipped ${r.skipped})`);
      }
    } catch (e) {
      console.error(`[HearingTracker] ${committee} testimony admission failed:`, e instanceof Error ? e.message : e);
    }
  }
  return { ingested, skipped };
}

let pollInFlight = false;

/** Hourly entry point (scheduler). Fail-soft per committee; in-flight guarded. */
export async function runHearingTrackerPoll(): Promise<void> {
  if (pollInFlight) {
    console.log("[HearingTracker] Poll already in flight, skipping");
    return;
  }
  pollInFlight = true;
  const now = Date.now();
  try {
    const [hasc, sasc] = await Promise.all([
      pollCommittee("HASC", now).catch((e) => {
        console.error("[HearingTracker] HASC poll failed:", e);
        return { listed: 0, detailed: 0, tracked: 0, errors: 1 } as CommitteePollResult;
      }),
      pollCommittee("SASC", now).catch((e) => {
        console.error("[HearingTracker] SASC poll failed:", e);
        return { listed: 0, detailed: 0, tracked: 0, errors: 1 } as CommitteePollResult;
      }),
    ]);
    console.log(
      `[HearingTracker] Poll complete — HASC listed=${hasc.listed} detailed=${hasc.detailed} tracked=${hasc.tracked} errors=${hasc.errors}; ` +
      `SASC listed=${sasc.listed} detailed=${sasc.detailed} tracked=${sasc.tracked} errors=${sasc.errors}`,
    );
    await admitPostedTestimony(now);
  } finally {
    pollInFlight = false;
  }
}
