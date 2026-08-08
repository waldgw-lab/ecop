import { readFileSync } from "node:fs";

const action = readFileSync("client/src/components/CuratedSocialCardAction.tsx", "utf8");
const truth = readFileSync("client/src/components/TruthSocialFeed.tsx", "utf8");
const xFeed = readFileSync("client/src/components/XPostsFeed.tsx", "utf8");
const osint = readFileSync("client/src/components/SentDefenderFeed.tsx", "utf8");
const page = readFileSync("client/src/pages/Curated.tsx", "utf8");
const routes = readFileSync("server/routes.ts", "utf8");

const failures: string[] = [];
function check(label: string, ok: boolean) {
  console.log(`[social-card-attach] ${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) failures.push(label);
}

check(
  "public mode preserves the existing direct copy component",
  action.includes("if (!editor)") && action.includes("<CopyShareButton"),
);
check(
  "editor trigger uses the same compact three-pixel icon footprint",
  action.includes('<ChevronDown className="h-3 w-3"') &&
    action.includes("inline-flex items-center justify-center rounded-sm text-muted-foreground"),
);
check(
  "editor menu offers rich Copy and light-blue Attach",
  action.includes("copyRichText(buildHtml(), toast)") &&
    action.includes("text-[#5FA8C4]") &&
    action.includes('"Attach"'),
);
check(
  "already-attached posts use a dulled blue destination action",
  action.includes("text-[#789BA9]") &&
    action.includes('"Attached · View story"') &&
    action.includes("onOpenAttachedStory();"),
);
check(
  "active story membership drives attached status and opens the existing story detail",
  page.includes("const attachedSocialStories = useMemo") &&
    page.includes("map.set(normalizeCuratedIdentityUrl(member.url), story)") &&
    page.includes("if (story) setSelectedStory(story)") &&
    (page.match(/findAttachedStory=\{findAttachedStory\}/g) ?? []).length === 4 &&
    (page.match(/onOpenAttachedStory=\{openAttachedStory\}/g) ?? []).length === 4,
);
check(
  "social story details suppress repeated summary text",
  page.includes("const showMemberSummary =") &&
    page.includes('kind === "article" && !isSocialPostIdentityUrl(a.url)') &&
    page.includes("{showMemberSummary &&"),
);
check(
  "card and portal interactions stop click-through",
  (action.match(/stopPropagation\(\)/g) ?? []).length >= 5,
);
check(
  "picker covers loading, failure, ineligible, empty and active target states",
  [
    "Refreshing approved post and active stories",
    "Could not refresh the attachment options",
    "social-attach-ineligible",
    "No active formed stories",
    "button-social-attach-target-",
  ].every((text) => action.includes(text)),
);
check(
  "card mutation is an explicit soft link carrying canonical social and cluster identity",
  action.includes('kind: "link"') &&
    action.includes("fromSocialCard: true") &&
    action.includes("socialUrl: eligibleCandidate.url") &&
    action.includes("targetClusterId: target.clusterId"),
);
check(
  "success refreshes affected Curated queries",
  [
    "/api/curated/top-stories",
    "/api/curated/cluster-members",
    "/api/curated/attach-targets",
    "/api/curated/social-link-candidates",
    "/api/curated/manual-links",
  ].every((key) => action.includes(key)),
);
check(
  "all four Curated social card lanes receive effective editor access",
  (page.match(/canAttachSocialPosts=\{effectiveAccess\}/g) ?? []).length === 4,
);
check(
  "Truth, official/response X, OSINT and Press cards pass their stable identity URL",
  truth.includes("identityUrl={post.truthSocialUrl}") &&
    xFeed.includes("identityUrl={post.xUrl}") &&
    osint.includes("identityUrl={post.xUrl}"),
);
check(
  "server revalidates the approved/current social candidate at commit time",
  routes.includes("getEligibleCuratedSocialLinkCandidates()") &&
    routes.includes("This social post is not currently approved and available in Curated"),
);
check(
  "server revalidates an active formed target and rejects social merge promotion",
  routes.includes("story?.clusterId === targetClusterId") &&
    routes.includes("Number(story?.sourceCount ?? 0) >= 2") &&
    routes.includes("Social posts can only be attached with a soft link"),
);
check(
  "shared candidate builder retains the Curated-item identity boundary",
  routes.includes("curatedIdentityUrls.has(identityUrl)") &&
    routes.includes("isApprovedCuratedAttachmentAccount(p.sourceAccount, 'x-default')"),
);

if (failures.length) {
  console.error(`\n[social-card-attach] ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\n[social-card-attach] PASS");