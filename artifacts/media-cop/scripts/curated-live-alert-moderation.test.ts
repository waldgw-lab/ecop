import fs from "node:fs";
import {
  applyLiveBroadcastModeration,
  deriveLiveBroadcastEventKey,
  isCurrentLiveBroadcastEvent,
  resolveLiveBroadcastEventKey,
  validateLiveBroadcastOverrides,
} from "../server/liveBroadcastModeration";
import type { LiveBroadcastStatus } from "../server/liveBroadcastStatus";
import { LIVE_ALERT_REASON_KEYS } from "../shared/curatedReasonVocab";

let pass = 0;
let fail = 0;
function check(label: string, condition: boolean) {
  if (condition) {
    pass++;
    console.log(`PASS [${label}]`);
  } else {
    fail++;
    console.error(`FAIL [${label}]`);
  }
}

function throws(label: string, fn: () => unknown) {
  let rejected = false;
  try { fn(); } catch { rejected = true; }
  check(label, rejected);
}

const upcoming: LiveBroadcastStatus = {
  state: "upcoming",
  leader: "President",
  title: "President to deliver remarks",
  watchUrl: "https://www.whitehouse.gov/live/",
  startsAt: "2026-08-04T17:00:00.000Z",
};
const live: LiveBroadcastStatus = {
  state: "live",
  leader: "President",
  title: "President delivers remarks live",
  watchUrl: "https://www.whitehouse.gov/live/",
  since: "2026-08-04T17:01:00.000Z",
};

const firstKey = deriveLiveBroadcastEventKey(upcoming, Date.parse(upcoming.startsAt!));
check("event key is state-independent and namespaced", firstKey.startsWith("live-alert:") && !firstKey.includes("upcoming"));
check(
  "restart/state transition reuses recent event key by Watch destination",
  resolveLiveBroadcastEventKey(live, Date.parse(live.since!), [{
    eventKey: firstKey,
    state: upcoming.state,
    leader: upcoming.leader,
    title: upcoming.title,
    watchUrl: upcoming.watchUrl,
    startsAt: upcoming.startsAt,
    firstObservedAt: "2026-08-04T16:55:00.000Z",
  }]) === firstKey,
);
check(
  "different leader cannot inherit prior moderation key",
  resolveLiveBroadcastEventKey({ ...live, leader: "Secretary of State" }, Date.parse(live.since!), [{
    eventKey: firstKey,
    state: upcoming.state,
    leader: upcoming.leader,
    title: upcoming.title,
    watchUrl: upcoming.watchUrl,
    startsAt: upcoming.startsAt,
    firstObservedAt: "2026-08-04T16:55:00.000Z",
  }]) !== firstKey,
);
const laterSameDay: LiveBroadcastStatus = {
  ...live,
  title: "President speaks at a separate evening event",
  since: "2026-08-04T22:01:00.000Z",
};
check(
  "reused canonical Watch URL does not inherit a prior event hours later",
  resolveLiveBroadcastEventKey(laterSameDay, Date.parse(laterSameDay.since!), [{
    eventKey: firstKey,
    state: "recently_ended",
    leader: upcoming.leader,
    title: upcoming.title,
    watchUrl: upcoming.watchUrl,
    firstObservedAt: "2026-08-04T17:01:00.000Z",
    endedAt: "2026-08-04T17:30:00.000Z",
  }]) !== firstKey,
);
const repeatedTitleLater: LiveBroadcastStatus = {
  ...live,
  title: upcoming.title,
  since: "2026-08-04T20:01:00.000Z",
};
check(
  "same-day repeated generic title gets a distinct event identity",
  deriveLiveBroadcastEventKey(repeatedTitleLater, Date.parse(repeatedTitleLater.since!)) !== firstKey,
);
check(
  "same-state restart does not reuse URL without matching event content",
  resolveLiveBroadcastEventKey({ ...live, title: "President hosts a Cabinet meeting" }, Date.parse(live.since!), [{
    eventKey: firstKey,
    state: "live",
    leader: live.leader,
    title: "President addresses military families",
    watchUrl: live.watchUrl,
    firstObservedAt: "2026-08-04T17:00:00.000Z",
  }]) !== firstKey,
);
check(
  "in-process recently-ended to new-live transition cannot reuse canonical Watch URL",
  resolveLiveBroadcastEventKey({
    ...live,
    title: "President hosts a new economic roundtable",
    since: "2026-08-04T17:40:00.000Z",
  }, Date.parse("2026-08-04T17:40:00.000Z"), [{
    eventKey: firstKey,
    state: "recently_ended",
    leader: live.leader,
    title: "President concludes earlier military remarks",
    watchUrl: live.watchUrl,
    firstObservedAt: "2026-08-04T17:00:00.000Z",
    endedAt: "2026-08-04T17:30:00.000Z",
  }]) !== firstKey,
);

const statusSource = fs.readFileSync("server/liveBroadcastStatus.ts", "utf8");
check(
  "in-process firing continuity routes through strict resolver with active status",
  statusSource.includes("recent.push({") &&
    statusSource.includes("_activeDetectorStatus.state") &&
    statusSource.includes("_activeEventKey = resolveLiveBroadcastEventKey(status, observedAt, recent)") &&
    !statusSource.includes("isSameLiveBroadcastEvent"),
);

check(
  "suppression removes only the active Curated status",
  applyLiveBroadcastModeration(live, { suppressed: true, overrides: {} }) === null,
);
const corrected = applyLiveBroadcastModeration(live, {
  suppressed: false,
  overrides: {
    state: "recently_ended",
    leader: "Vice President",
    title: "Corrected event title",
    watchUrl: "https://www.youtube.com/watch?v=abc123",
    endsAt: "2026-08-04T17:30:00.000Z",
  },
});
check(
  "corrections replace display/status fields and Watch destination",
  corrected?.state === "recently_ended" &&
    corrected.leader === "Vice President" &&
    corrected.title === "Corrected event title" &&
    corrected.watchUrl.includes("youtube.com") &&
    corrected.endsAt === "2026-08-04T17:30:00.000Z" &&
    corrected.since === undefined,
);
check(
  "no moderation leaves detector output unchanged",
  JSON.stringify(applyLiveBroadcastModeration(live, null)) === JSON.stringify(live),
);
const correctedToUpcoming = applyLiveBroadcastModeration(live, {
  suppressed: false,
  overrides: {
    state: "upcoming",
    leader: "President",
    title: "President to deliver remarks at 3:00 PM",
    watchUrl: "https://www.whitehouse.gov/live/",
    startsAt: "2026-08-04T19:00:00.000Z",
    since: null,
    endsAt: null,
  },
});
check(
  "active LIVE correction immediately resolves to Starting soon with scheduled time",
  correctedToUpcoming?.state === "upcoming" &&
    correctedToUpcoming.startsAt === "2026-08-04T19:00:00.000Z" &&
    correctedToUpcoming.since === undefined,
);
check(
  "only the exact active event key may control the current banner",
  isCurrentLiveBroadcastEvent(firstKey, firstKey) &&
    !isCurrentLiveBroadcastEvent(firstKey, "live-alert:another-event") &&
    !isCurrentLiveBroadcastEvent(firstKey, null),
);

const valid = validateLiveBroadcastOverrides({
  state: "live",
  leader: "Secretary of State",
  title: "Secretary delivers remarks",
  watchUrl: "https://www.youtube.com/watch?v=safe",
  since: "2026-08-04T17:01:00Z",
  startsAt: null,
  endsAt: null,
});
check("valid correction is normalized", valid.since === "2026-08-04T17:01:00.000Z");
throws("javascript Watch URL rejected", () => validateLiveBroadcastOverrides({ ...valid, watchUrl: "javascript:alert(1)" }));
throws("credential-bearing Watch URL rejected", () => validateLiveBroadcastOverrides({ ...valid, watchUrl: "https://user:pass@example.com/live" }));
throws("private-network Watch URL rejected", () => validateLiveBroadcastOverrides({ ...valid, watchUrl: "http://127.0.0.1:5000/live" }));
throws("relative Watch URL rejected", () => validateLiveBroadcastOverrides({ ...valid, watchUrl: "/live" }));
throws("state-incompatible timestamp rejected", () => validateLiveBroadcastOverrides({ ...valid, state: "live", startsAt: "2026-08-04T18:00:00Z" }));
throws("Starting soon correction without a real scheduled start is rejected", () => validateLiveBroadcastOverrides({
  state: "upcoming",
  leader: "President",
  title: "President to deliver remarks",
  watchUrl: "https://www.whitehouse.gov/live/",
}));
throws("unknown leader rejected", () => validateLiveBroadcastOverrides({ ...valid, leader: "Press Secretary" }));
check("live-alert reason vocabulary includes false-alert evidence", LIVE_ALERT_REASON_KEYS.has("irrelevant-alert"));
check("live-alert reason vocabulary includes bad-link evidence", LIVE_ALERT_REASON_KEYS.has("bad-watch-link"));

const routes = fs.readFileSync("server/routes.ts", "utf8");
for (const action of ["hide", "restore", "edit"]) {
  const pattern = new RegExp(
    `app\\.post\\(\"/api/curated/live-status/firings/:id/${action}\",\\s*requireCuratedEditor`,
  );
  check(`${action} endpoint is editor-gated`, pattern.test(routes));
}
check("firing history remains view-gated", /app\.get\("\/api\/curated\/live-status\/firings",\s*requireCuratedView/.test(routes));
check("public status uses moderated resolver", routes.includes("await getModeratedLiveBroadcastStatus()"));
check(
  "each moderation save re-resolves only the Curated active overlay",
  routes.includes("await refreshModeratedLiveBroadcastStatus()") &&
    routes.includes("isCurrentBannerEvent: isCurrentLiveBroadcastEvent(firing.eventKey, activeBanner.eventKey)") &&
    routes.includes("selectedEvent: liveFiringSnapshot(firing)") &&
    (routes.match(/await liveAlertMutationResponse\(firing, moderation\)/g)?.length ?? 0) === 3,
);
check("Classic/public routes do not reference moderation overlay", !fs.readFileSync("server/publicApi.ts", "utf8").includes("LiveBroadcastModeration"));

const schema = fs.readFileSync("shared/schema.ts", "utf8");
check("detector firing keeps immutable fields beside stable event key", schema.includes('eventKey: text("event_key").notNull()'));
check("moderation lives in a separate Curated-only overlay", schema.includes('pgTable("curated_live_broadcast_moderations"'));
check("audit events preserve machine-readable before/after", schema.includes('beforeValue: jsonb("before_value")') && schema.includes('afterValue: jsonb("after_value")'));
check("all three intervention actions enter adjustment history", ["live-alert-hide", "live-alert-restore", "live-alert-edit"].every((a) => routes.includes(`action: "${a}"`)));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);