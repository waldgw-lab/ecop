/**
 * Regression gate: POTUS Truth Social has one canonical account identity image
 * across the registry, live/archive Curated details, and the dedicated feed.
 * Post attachment media remains separate from that avatar.
 *
 * Pure and deterministic: source-contract checks only; no DB, network, or AI.
 */
import { readFileSync } from "node:fs";
import { OUTLET_SEED } from "../server/outletRegistrySeed";

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`[potus-truth-avatar] OK   ${name}`);
  } else {
    console.error(`[potus-truth-avatar] FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

const canonicalName = "POTUS (Truth Social)";
const canonicalSlug = "potus-truth-social";
const potusSeed = OUTLET_SEED.find((outlet) => outlet.canonicalName === canonicalName);

check("POTUS registry identity exists exactly once", !!potusSeed && OUTLET_SEED.filter(
  (outlet) => outlet.canonicalName === canonicalName,
).length === 1);
check(
  "POTUS registry identity points to the presidential-seal slug",
  potusSeed?.logoSlug === canonicalSlug,
  `got ${JSON.stringify(potusSeed?.logoSlug)}`,
);
check("POTUS seal uses non-cropping object fit", potusSeed?.logoObjectFit === "contain");

const logoSource = readFileSync("client/src/lib/outletLogos.ts", "utf8");
check(
  "canonical POTUS slug maps to the bundled presidential-seal asset",
  logoSource.includes('import potusSeal from "@assets/avatars/potus.png"') &&
    logoSource.includes("[POTUS_TRUTH_SOCIAL_LOGO_SLUG]: POTUS_TRUTH_SOCIAL_LOGO"),
);
const potusOverrideIndex = logoSource.indexOf(
  "outlet.canonicalName === POTUS_TRUTH_SOCIAL_CANONICAL_NAME",
);
const uploadPrecedenceIndex = logoSource.indexOf("if (outlet.logoUrl) return outlet.logoUrl");
check(
  "POTUS canonical identity wins before uploaded-logo precedence",
  potusOverrideIndex >= 0 &&
    uploadPrecedenceIndex >= 0 &&
    potusOverrideIndex < uploadPrecedenceIndex,
);
check(
  "ordinary outlets retain uploaded-logo precedence",
  logoSource.includes("if (outlet.logoUrl) return outlet.logoUrl") &&
    logoSource.includes("return outlet.logoSlug ? LOGO_ASSETS[outlet.logoSlug] : undefined"),
);

const seedSource = readFileSync("server/outletRegistrySeed.ts", "utf8");
check(
  "boot transition clears only the exact POTUS registry upload",
  seedSource.includes('normalizeOutletName("POTUS (Truth Social)")') &&
    seedSource.includes("SET logo_url = NULL") &&
    seedSource.includes("AND logo_url IS NOT NULL"),
);

for (const file of [
  "client/src/pages/Curated.tsx",
  "client/src/pages/CuratedArchive.tsx",
]) {
  const source = readFileSync(file, "utf8");
  check(`${file} routes source identities through shared OutletLogo`, source.includes("<OutletLogo"));
  check(`${file} does not resolve logoUrl directly`, !source.includes("outlet?.logoUrl"));
}

const feedSource = readFileSync("client/src/components/TruthSocialFeed.tsx", "utf8");
check(
  "dedicated Truth feed uses the same canonical identity resolver",
  (feedSource.match(/<OutletLogo/g) ?? []).length === 2 &&
    feedSource.includes("POTUS_TRUTH_SOCIAL_CANONICAL_NAME") &&
    feedSource.includes("POTUS_TRUTH_SOCIAL_LOGO_SLUG"),
);
check(
  "default Dashboard feed cannot fall back to the legacy DJT-only avatar",
  !feedSource.includes('className="text-xs font-bold text-primary">DJT</span>') &&
    !feedSource.includes("bg-primary/10 flex items-center justify-center flex-shrink-0"),
);
const avatarStart = feedSource.indexOf("<OutletLogo");
const avatarEnd = feedSource.indexOf("/>", avatarStart);
const avatarMarkup = feedSource.slice(avatarStart, avatarEnd + 2);
check(
  "Truth post attachment media is not passed into the account avatar",
  avatarStart >= 0 &&
    avatarEnd > avatarStart &&
    !avatarMarkup.includes("post.imageUrl") &&
    !avatarMarkup.includes("post.video"),
);
check(
  "Truth post attachment remains rendered separately from the avatar",
  feedSource.includes("post.imageUrl && !post.videoUrl") &&
    feedSource.indexOf("post.imageUrl && !post.videoUrl") > avatarEnd,
);

const sharedLogoSource = readFileSync("client/src/components/OutletLogo.tsx", "utf8");
check(
  "failed identity images switch to an accessible fallback",
  sharedLogoSource.includes("onError={() => setImageFailed(true)}") &&
    sharedLogoSource.includes('role="img"') &&
    sharedLogoSource.includes("identity image unavailable"),
);

if (failures.length > 0) {
  console.error(`\n[potus-truth-avatar] FAIL — ${failures.length} assertion(s) failed`);
  process.exit(1);
}
console.log("\n[potus-truth-avatar] PASS — POTUS Truth identity is canonical and media-safe");