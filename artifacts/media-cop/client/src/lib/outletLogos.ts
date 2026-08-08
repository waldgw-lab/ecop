// Shared bundled outlet-logo assets, keyed by the registry `logoSlug`.
// Used by both the Curated view (SourceIcon) and the Team → Source Oversight
// dialog so the two never drift apart. An uploaded `logoUrl` (object-storage
// PUBLIC URL) wins over the bundled slug asset for ordinary outlets; POTUS Truth
// Social is the one identity-owned exception and always uses its canonical seal.
import logoAlJazeera from "@assets/Al_Jazeera_1780625350880.png";
import logoAssociatedPress from "@assets/Associated_Press_1780625350881.png";
import logoBbcNews from "@assets/image_1780672824347.png";
import logoFrance24 from "@assets/France24_1780625350881.png";
import logoWashingtonExaminer from "@assets/washington-examiner_1780625350882.jpg";
import logoTheHill from "@assets/The_Hill_(2020-01-15).svg_1780625489222.png";
import logoNyTimes from "@assets/image_1780773422623.png";
import logoWashingtonPost from "@assets/washington_post_trimmed.png";
import logoReuters from "@assets/image_1780625560283.png";
import logoAbcNews from "@assets/image_1780626537401.png";
import logoTimesOfIsrael from "@assets/image_1780625676674.png";
import logoCbsNews from "@assets/image_1780625705918.png";
import logoFoxNews from "@assets/image_1780625826053.png";
import logoNbcNews from "@assets/image_1780625853810.png";
import logoDeutscheWelle from "@assets/image_1780625881391.png";
import logoPolitico from "@assets/image_1780626066877.png";
import logoBloomberg from "@assets/image_1780626855536.png";
import logoNpr from "@assets/image_1780626144882.png";
import logoMilitaryTimes from "@assets/image_1780626874236.png";
import logoStarsAndStripes from "@assets/image_1780626893419.png";
import logoCnbc from "@assets/image_1780626946429.png";
import logoForeignPolicy from "@assets/image_1780626994920.png";
import logoWsj from "@assets/image_1780627133220.png";
import logoWarOnTheRocks from "@assets/war_on_the_rocks_trimmed.png";
import logoDailyWire from "@assets/daily_wire_trimmed.png";
import logoTheBlaze from "@assets/the_blaze_trimmed.png";
import logoJerusalemPost from "@assets/jerusalem_post_trimmed.png";
import logoDefenseNews from "@assets/defense_news_trimmed.png";
import logoWarZone from "@assets/war_zone_trimmed.png";
import logoNewsNation from "@assets/newsnation_trimmed.png";
import logoBreakingDefense from "@assets/image_1780626555661.png";
import logoDiplomat from "@assets/image_1780626372664.png";
import logoAlMonitor from "@assets/image_1780683467638.png";
import logoGuardian from "@assets/image_1780684236067.png";
import logoCsis from "@assets/image_1780684239777.png";
import logoDefenseOne from "@assets/image_1780684544995.png";
import logoWashingtonTimes from "@assets/image_1780684611717.png";
import logoMsnbc from "@assets/image_1780684648807.png";
import logoRand from "@assets/image_1780684676264.png";
import logoEpochTimes from "@assets/image_1780684697153.png";
import logoPressTv from "@assets/image_1780773128280.png";
import logoGlobalTimes from "@assets/image_1780773202705.png";
import logoRt from "@assets/image_1780773262541.png";
import logoHaaretz from "@assets/image_1780773308627.png";
import logoLeMonde from "@assets/image_1780773363097.png";
import logoDerSpiegel from "@assets/image_1780773489548.png";
import logoElPais from "@assets/image_1780775341053.png";
import logoGulfNews from "@assets/image_1780775448066.png";
import logoTheNational from "@assets/image_1780775504791.png";
import potusSeal from "@assets/avatars/potus.png";

export const POTUS_TRUTH_SOCIAL_CANONICAL_NAME = "POTUS (Truth Social)";
export const POTUS_TRUTH_SOCIAL_LOGO_SLUG = "potus-truth-social";
export const POTUS_TRUTH_SOCIAL_LOGO = potusSeal;

export const LOGO_ASSETS: Record<string, string> = {
  "al-jazeera": logoAlJazeera,
  "associated-press": logoAssociatedPress,
  "bbc-news": logoBbcNews,
  "france-24": logoFrance24,
  "washington-examiner": logoWashingtonExaminer,
  "the-hill": logoTheHill,
  "new-york-times": logoNyTimes,
  "washington-post": logoWashingtonPost,
  "reuters": logoReuters,
  "abc-news": logoAbcNews,
  "times-of-israel": logoTimesOfIsrael,
  "cbs-news": logoCbsNews,
  "fox-news": logoFoxNews,
  "nbc-news": logoNbcNews,
  "deutsche-welle": logoDeutscheWelle,
  "politico": logoPolitico,
  "bloomberg": logoBloomberg,
  "npr": logoNpr,
  "military-times": logoMilitaryTimes,
  "stars-and-stripes": logoStarsAndStripes,
  "cnbc": logoCnbc,
  "foreign-policy": logoForeignPolicy,
  "wall-street-journal": logoWsj,
  "war-on-the-rocks": logoWarOnTheRocks,
  "daily-wire": logoDailyWire,
  "the-blaze": logoTheBlaze,
  "jerusalem-post": logoJerusalemPost,
  "defense-news": logoDefenseNews,
  "war-zone": logoWarZone,
  "newsnation": logoNewsNation,
  "breaking-defense": logoBreakingDefense,
  "the-diplomat": logoDiplomat,
  "al-monitor": logoAlMonitor,
  "the-guardian": logoGuardian,
  "csis": logoCsis,
  "defense-one": logoDefenseOne,
  "washington-times": logoWashingtonTimes,
  "msnbc": logoMsnbc,
  "rand": logoRand,
  "epoch-times": logoEpochTimes,
  "press-tv": logoPressTv,
  "global-times": logoGlobalTimes,
  "rt": logoRt,
  "haaretz": logoHaaretz,
  "le-monde": logoLeMonde,
  "der-spiegel": logoDerSpiegel,
  "el-pais": logoElPais,
  "gulf-news": logoGulfNews,
  "the-national": logoTheNational,
  [POTUS_TRUTH_SOCIAL_LOGO_SLUG]: POTUS_TRUTH_SOCIAL_LOGO,
};

// Resolve the icon URL for an outlet row: an uploaded logo wins over the
// bundled slug asset; returns undefined when neither exists (caller shows
// an initials fallback).
export function resolveOutletLogo(
  outlet: {
    canonicalName?: string | null;
    logoUrl?: string | null;
    logoSlug?: string | null;
    logoBrandColor?: string | null;
    logoObjectFit?: string | null;
  } | null | undefined,
): string | undefined {
  if (!outlet) return undefined;
  if (
    outlet.canonicalName === POTUS_TRUTH_SOCIAL_CANONICAL_NAME ||
    outlet.logoSlug === POTUS_TRUTH_SOCIAL_LOGO_SLUG
  ) {
    return POTUS_TRUTH_SOCIAL_LOGO;
  }
  if (outlet.logoUrl) return outlet.logoUrl;
  return outlet.logoSlug ? LOGO_ASSETS[outlet.logoSlug] : undefined;
}
