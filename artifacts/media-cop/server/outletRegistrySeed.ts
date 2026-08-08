// =============================================================================
// Outlet Registry seed — hand-curated canonical knowledge for every outlet MCOP
// ingests, plus the starter "aperture" set (chosen adversary outlets, the
// international/regional + mainstream B-list, and the quarantined low-cred +
// social buckets). This is a LABELING layer only — never an admission gate.
//
// On boot we upsert these rows by `key` (normalized canonical name). The seed is
// the source of truth for this task; a later enrichment/oversight task may layer
// edits on top.
// =============================================================================
import { sql } from "drizzle-orm";
import { db } from "./db";
import { outletRegistry } from "@shared/schema";
import {
  normalizeOutletName,
  type SourceIdentifier,
  type OtherSourceType,
} from "@shared/outletRegistry";

type Role = "contributing" | "attach-only";

interface OutletSeed {
  canonicalName: string;
  // Human-readable display name for handle-keyed rows (canonicalName = exact
  // scraper handle). DISPLAY-ONLY: never used for resolution/tiering/Coverage.
  displayName?: string;
  aliases?: string[];
  domains?: string[];
  logoSlug?: string;
  logoBrandColor?: string;
  logoObjectFit?: "cover" | "contain";
  originCountry?: string;
  originRegion?: string;
  factuality?: string; // very-high | high | mixed | low | very-low | n/a
  role: Role;
  // Behavior-engine identity. Every outlet sets one explicitly — it is the sole
  // input (alongside factuality + blocked) to deriveBehavior.
  sourceIdentifier: SourceIdentifier;
  otherSourceType?: OtherSourceType;
  ownership?: string[];
  blocked?: boolean;
}

export const OUTLET_SEED: OutletSeed[] = [
  // ---------------------------------------------------------------------------
  // Wire services (contributing)
  // ---------------------------------------------------------------------------
  {
    canonicalName: "Associated Press",
    aliases: ["AP News", "AP", "AP News (DM)"],
    domains: ["apnews.com"],
    logoSlug: "associated-press",
    logoObjectFit: "contain",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "Reuters",
    domains: ["reuters.com", "reutersagency.com"],
    logoSlug: "reuters",
    logoObjectFit: "contain",
    originCountry: "United Kingdom",
    originRegion: "Europe",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    canonicalName: "Bloomberg",
    domains: ["bloomberg.com"],
    logoSlug: "bloomberg",
    logoBrandColor: "#000000",
    logoObjectFit: "cover",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },

  // ---------------------------------------------------------------------------
  // US major broadcast / print (contributing)
  // ---------------------------------------------------------------------------
  {
    canonicalName: "Fox News",
    domains: ["foxnews.com"],
    logoSlug: "fox-news",
    logoBrandColor: "#06294E",
    logoObjectFit: "cover",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "mixed",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "CNN",
    domains: ["cnn.com"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "NBC News",
    aliases: ["NBC"],
    domains: ["nbcnews.com"],
    logoSlug: "nbc-news",
    logoObjectFit: "contain",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "CBS News",
    aliases: ["CBS"],
    domains: ["cbsnews.com"],
    logoSlug: "cbs-news",
    logoBrandColor: "#000000",
    logoObjectFit: "cover",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "ABC News",
    domains: ["abcnews.go.com", "abcnews.com"],
    logoSlug: "abc-news",
    logoObjectFit: "contain",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "NPR",
    domains: ["npr.org"],
    logoSlug: "npr",
    logoObjectFit: "contain",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "MSNBC",
    domains: ["msnbc.com"],
    logoSlug: "msnbc",
    logoObjectFit: "contain",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "mixed",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "opinion",
  },
  {
    canonicalName: "CNBC",
    domains: ["cnbc.com"],
    logoSlug: "cnbc",
    logoBrandColor: "#0E2350",
    logoObjectFit: "cover",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "USA Today",
    domains: ["usatoday.com"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "NewsNation",
    aliases: ["News Nation"],
    domains: ["newsnationnow.com"],
    logoSlug: "newsnation",
    logoObjectFit: "contain",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "The New York Times",
    aliases: ["NYT", "New York Times"],
    domains: ["nytimes.com"],
    logoSlug: "new-york-times",
    logoObjectFit: "contain",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "The Washington Post",
    aliases: ["Washington Post", "WaPo"],
    domains: ["washingtonpost.com"],
    logoSlug: "washington-post",
    logoObjectFit: "contain",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "The Wall Street Journal",
    aliases: ["Wall Street Journal", "WSJ"],
    domains: ["wsj.com"],
    logoSlug: "wall-street-journal",
    logoObjectFit: "contain",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },

  // ---------------------------------------------------------------------------
  // US politics / beltway (contributing)
  // ---------------------------------------------------------------------------
  {
    canonicalName: "Politico",
    domains: ["politico.com"],
    logoSlug: "politico",
    logoBrandColor: "#C9382E",
    logoObjectFit: "cover",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    // Curated-only US mainstream source (Task #151). Contributing so Axios can
    // form/contribute to curated stories; it rides the curated RSS feed
    // (api.axios.com/feed) and is isolated to the curated lane only.
    canonicalName: "Axios",
    domains: ["axios.com"],
    logoSlug: "axios",
    logoBrandColor: "#000000",
    logoObjectFit: "contain",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "The Hill",
    domains: ["thehill.com"],
    logoSlug: "the-hill",
    logoBrandColor: "#0C4A8A",
    logoObjectFit: "cover",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "Washington Times",
    domains: ["washingtontimes.com"],
    logoSlug: "washington-times",
    logoBrandColor: "#C8102E",
    logoObjectFit: "cover",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "mixed",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "Washington Examiner",
    domains: ["washingtonexaminer.com"],
    logoSlug: "washington-examiner",
    logoObjectFit: "contain",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "mixed",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },

  // ---------------------------------------------------------------------------
  // US national outlets surfaced by the Curated Coverage review (Task #347).
  // Both were already REACHING the curated store but had NO Source Oversight
  // row, so findOutlet() fail-closed them to attach-only (ride-along only,
  // never tiered). Registering them hands tiering to the live trust engine.
  // Both are mixed-factuality US national news → news-us-domestic + "mixed",
  // which deriveBehavior renders as contrast/anchor-only (shown for contrast,
  // never a plain headline) — consistent with Fox News / Washington Times /
  // Washington Examiner (also mixed, news-us-domestic). Labeling only; the
  // curated lane stays isolated (never the main feed / Classic / Visual /
  // custom-MCOP / public API). No bundled logo asset yet → initials fallback.
  // ---------------------------------------------------------------------------
  {
    canonicalName: "New York Post",
    aliases: ["NY Post", "NYPost"],
    domains: ["nypost.com"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "mixed",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "Newsweek",
    domains: ["newsweek.com"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "mixed",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },

  // ---------------------------------------------------------------------------
  // The Straits Times (Singapore) — registered per operator direction so that
  // Team-page submissions of its articles tier correctly when they enter the
  // curated reuse-intake. Without a Source Oversight row, a submitted article
  // fail-closes to attach-only; registering it lets the trust engine tier it.
  // Reputable Singapore daily: high factuality + news-international, which
  // deriveBehavior renders as "contributing". Labeling only; the curated lane
  // stays isolated (never main feed / Classic / Visual / custom-MCOP / public
  // API). No bundled logo asset yet → initials fallback.
  // ---------------------------------------------------------------------------
  {
    canonicalName: "The Straits Times",
    aliases: ["Straits Times"],
    domains: ["straitstimes.com"],
    originCountry: "Singapore",
    originRegion: "Asia",
    factuality: "high",
    role: "contributing",
    sourceIdentifier: "news-international",
  },

  // ---------------------------------------------------------------------------
  // Defense / military trade + analysis (contributing)
  // ---------------------------------------------------------------------------
  {
    canonicalName: "Breaking Defense",
    domains: ["breakingdefense.com"],
    logoSlug: "breaking-defense",
    logoObjectFit: "contain",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "Defense One",
    domains: ["defenseone.com"],
    logoSlug: "defense-one",
    logoBrandColor: "#F7CE00",
    logoObjectFit: "cover",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "Defense News",
    domains: ["defensenews.com"],
    logoSlug: "defense-news",
    logoObjectFit: "contain",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "Inside Defense",
    aliases: ["InsideDefense", "InsideDefense.com", "Inside the Pentagon"],
    domains: ["insidedefense.com"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "Military Times",
    domains: ["militarytimes.com"],
    logoSlug: "military-times",
    logoObjectFit: "contain",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "Military.com",
    domains: ["military.com"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "Task & Purpose",
    aliases: ["Task and Purpose"],
    domains: ["taskandpurpose.com"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "Stars and Stripes",
    aliases: ["Stars & Stripes"],
    domains: ["stripes.com"],
    logoSlug: "stars-and-stripes",
    logoObjectFit: "contain",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "The War Zone",
    aliases: ["War Zone", "TWZ"],
    domains: ["twz.com", "thedrive.com"],
    logoSlug: "war-zone",
    logoObjectFit: "contain",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "War on the Rocks",
    domains: ["warontherocks.com"],
    logoSlug: "war-on-the-rocks",
    logoObjectFit: "contain",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "Foreign Policy",
    domains: ["foreignpolicy.com"],
    logoSlug: "foreign-policy",
    logoBrandColor: "#EF4B2A",
    logoObjectFit: "cover",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "The Diplomat",
    aliases: ["Diplomat"],
    domains: ["thediplomat.com"],
    logoSlug: "the-diplomat",
    logoBrandColor: "#000000",
    logoObjectFit: "cover",
    originCountry: "United States",
    originRegion: "East Asia",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "Al-Monitor",
    aliases: ["Al Monitor"],
    domains: ["al-monitor.com"],
    logoSlug: "al-monitor",
    logoObjectFit: "contain",
    originCountry: "United States",
    originRegion: "Middle East",
    factuality: "very-high",
    role: "contributing",
    // US-owned but a Middle-East-focused publication — it is NOT part of the
    // US-domestic mainstream press corps, so it must not compete in the
    // "U.S. Domestic" media-ecosystem bucket (user call, July 2026).
    sourceIdentifier: "news-international",
  },

  // ---------------------------------------------------------------------------
  // Think tanks (contributing)
  // ---------------------------------------------------------------------------
  {
    canonicalName: "CSIS",
    aliases: ["CSIS Futures Lab", "Center for Strategic and International Studies"],
    domains: ["csis.org"],
    logoSlug: "csis",
    logoBrandColor: "#14284B",
    logoObjectFit: "cover",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "Atlantic Council",
    aliases: ["DFRLab", "Digital Forensic Research Lab"],
    domains: ["atlanticcouncil.org"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "RAND",
    aliases: ["RAND Corporation"],
    domains: ["rand.org"],
    logoSlug: "rand",
    logoBrandColor: "#6633CC",
    logoObjectFit: "cover",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },
  {
    canonicalName: "Brookings",
    aliases: ["Brookings Institution"],
    domains: ["brookings.edu"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-us-domestic",
  },

  // ---------------------------------------------------------------------------
  // International / regional B-list (contributing)
  // ---------------------------------------------------------------------------
  {
    canonicalName: "BBC News",
    aliases: ["BBC"],
    domains: ["bbc.com", "bbc.co.uk"],
    logoSlug: "bbc-news",
    logoBrandColor: "#B80000",
    logoObjectFit: "cover",
    originCountry: "United Kingdom",
    originRegion: "Europe",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    canonicalName: "The Guardian",
    aliases: ["Guardian"],
    domains: ["theguardian.com", "guardian.co.uk"],
    logoSlug: "the-guardian",
    logoBrandColor: "#052962",
    logoObjectFit: "cover",
    originCountry: "United Kingdom",
    originRegion: "Europe",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    canonicalName: "France 24",
    domains: ["france24.com"],
    logoSlug: "france-24",
    logoBrandColor: "#2C9DD7",
    logoObjectFit: "cover",
    originCountry: "France",
    originRegion: "Europe",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    canonicalName: "Deutsche Welle",
    aliases: ["DW"],
    domains: ["dw.com"],
    logoSlug: "deutsche-welle",
    logoBrandColor: "#002B5C",
    logoObjectFit: "contain",
    originCountry: "Germany",
    originRegion: "Europe",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    canonicalName: "Le Monde",
    domains: ["lemonde.fr"],
    logoSlug: "le-monde",
    logoObjectFit: "contain",
    originCountry: "France",
    originRegion: "Europe",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    canonicalName: "Der Spiegel",
    aliases: ["Spiegel"],
    domains: ["spiegel.de"],
    logoSlug: "der-spiegel",
    logoBrandColor: "#E64415",
    logoObjectFit: "contain",
    originCountry: "Germany",
    originRegion: "Europe",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    canonicalName: "El País",
    aliases: ["El Pais"],
    domains: ["elpais.com"],
    logoSlug: "el-pais",
    logoObjectFit: "contain",
    originCountry: "Spain",
    originRegion: "Europe",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    canonicalName: "Times of Israel",
    domains: ["timesofisrael.com"],
    logoSlug: "times-of-israel",
    logoBrandColor: "#00548C",
    logoObjectFit: "cover",
    originCountry: "Israel",
    originRegion: "Middle East",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    canonicalName: "The Jerusalem Post",
    aliases: ["Jerusalem Post"],
    domains: ["jpost.com"],
    logoSlug: "jerusalem-post",
    logoObjectFit: "contain",
    originCountry: "Israel",
    originRegion: "Middle East",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    canonicalName: "Haaretz",
    domains: ["haaretz.com"],
    logoSlug: "haaretz",
    logoObjectFit: "contain",
    originCountry: "Israel",
    originRegion: "Middle East",
    factuality: "very-high",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    canonicalName: "Ynetnews",
    aliases: ["Ynet"],
    domains: ["ynetnews.com"],
    originCountry: "Israel",
    originRegion: "Middle East",
    factuality: "high",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    canonicalName: "Israel Hayom",
    domains: ["israelhayom.com"],
    originCountry: "Israel",
    originRegion: "Middle East",
    factuality: "mixed",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    canonicalName: "Arab News",
    domains: ["arabnews.com"],
    originCountry: "Saudi Arabia",
    originRegion: "Middle East",
    factuality: "mixed",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    canonicalName: "Gulf News",
    domains: ["gulfnews.com"],
    logoSlug: "gulf-news",
    logoBrandColor: "#000000",
    logoObjectFit: "contain",
    originCountry: "United Arab Emirates",
    originRegion: "Middle East",
    factuality: "high",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    canonicalName: "The National",
    domains: ["thenationalnews.com"],
    logoSlug: "the-national",
    logoObjectFit: "contain",
    originCountry: "United Arab Emirates",
    originRegion: "Middle East",
    factuality: "high",
    role: "contributing",
    sourceIdentifier: "news-cpc",
  },
  {
    canonicalName: "The Daily Star",
    aliases: ["Daily Star Lebanon"],
    domains: ["dailystar.com.lb"],
    originCountry: "Lebanon",
    originRegion: "Middle East",
    factuality: "high",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    canonicalName: "The Jordan Times",
    aliases: ["Jordan Times"],
    domains: ["jordantimes.com"],
    originCountry: "Jordan",
    originRegion: "Middle East",
    factuality: "high",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    canonicalName: "Al Arabiya",
    domains: ["alarabiya.net", "english.alarabiya.net"],
    originCountry: "Saudi Arabia",
    originRegion: "Middle East",
    factuality: "mixed",
    role: "contributing",
    sourceIdentifier: "news-cpc",
  },
  {
    canonicalName: "Al Jazeera",
    domains: ["aljazeera.com"],
    logoSlug: "al-jazeera",
    logoBrandColor: "#EE8019",
    logoObjectFit: "cover",
    originCountry: "Qatar",
    originRegion: "Middle East",
    factuality: "mixed",
    role: "contributing",
    sourceIdentifier: "news-cpc",
  },

  // ---------------------------------------------------------------------------
  // International expansion (Task #231) — Group 1 (also on the main RSS bot:
  // Yonhap, AFP, Foreign Affairs) + Group 2 (curated-lane only). All trusted
  // news → contributing. Kyiv Post is mixed factuality → derives to contrast.
  // ---------------------------------------------------------------------------
  {
    canonicalName: "Yonhap News Agency",
    aliases: ["Yonhap", "Yonhap News"],
    domains: ["yna.co.kr", "en.yna.co.kr"],
    originCountry: "South Korea",
    originRegion: "East Asia",
    factuality: "high",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    canonicalName: "Agence France-Presse",
    aliases: ["AFP", "AFP News"],
    domains: ["afp.com"],
    originCountry: "France",
    originRegion: "Europe",
    factuality: "high",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    canonicalName: "Foreign Affairs",
    domains: ["foreignaffairs.com"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "high",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    canonicalName: "Taipei Times",
    domains: ["taipeitimes.com"],
    originCountry: "Taiwan",
    originRegion: "East Asia",
    factuality: "high",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    canonicalName: "The Hindu",
    domains: ["thehindu.com"],
    originCountry: "India",
    originRegion: "South Asia",
    factuality: "high",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    canonicalName: "Kyiv Post",
    domains: ["kyivpost.com"],
    originCountry: "Ukraine",
    originRegion: "Europe",
    factuality: "mixed",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    canonicalName: "The Japan Times",
    aliases: ["Japan Times"],
    domains: ["japantimes.co.jp"],
    originCountry: "Japan",
    originRegion: "East Asia",
    factuality: "high",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    canonicalName: "ABC News (Australia)",
    aliases: ["ABC News Australia", "ABC Australia", "ABC (Australia)"],
    domains: ["abc.net.au"],
    originCountry: "Australia",
    originRegion: "Oceania",
    factuality: "high",
    role: "contributing",
    sourceIdentifier: "news-international",
  },

  // ---------------------------------------------------------------------------
  // Adversary / state-controlled (attach-only)
  // ---------------------------------------------------------------------------
  {
    canonicalName: "RT",
    aliases: ["Russia Today"],
    domains: ["rt.com"],
    logoSlug: "rt",
    logoBrandColor: "#8CC63F",
    logoObjectFit: "cover",
    originCountry: "Russia",
    originRegion: "Eurasia",
    factuality: "low",
    role: "attach-only",
    sourceIdentifier: "news-cpc",
  },
  {
    canonicalName: "Sputnik",
    aliases: ["Sputnik News", "Sputnik Globe"],
    domains: ["sputnikglobe.com", "sputniknews.com"],
    originCountry: "Russia",
    originRegion: "Eurasia",
    factuality: "low",
    role: "attach-only",
    sourceIdentifier: "news-cpc",
  },
  {
    canonicalName: "TASS",
    domains: ["tass.com", "tass.ru"],
    originCountry: "Russia",
    originRegion: "Eurasia",
    factuality: "mixed",
    role: "attach-only",
    sourceIdentifier: "news-cpc",
  },
  {
    canonicalName: "RIA Novosti",
    aliases: ["RIA"],
    domains: ["ria.ru"],
    originCountry: "Russia",
    originRegion: "Eurasia",
    factuality: "low",
    role: "attach-only",
    sourceIdentifier: "news-cpc",
  },
  {
    canonicalName: "Global Times",
    domains: ["globaltimes.cn"],
    logoSlug: "global-times",
    logoBrandColor: "#E60012",
    logoObjectFit: "cover",
    originCountry: "China",
    originRegion: "East Asia",
    factuality: "low",
    role: "attach-only",
    sourceIdentifier: "news-cpc",
  },
  {
    canonicalName: "Xinhua",
    aliases: ["Xinhua News Agency", "Xinhua Net", "Xinhuanet"],
    domains: ["news.cn", "xinhuanet.com", "chinaview.cn"],
    originCountry: "China",
    originRegion: "East Asia",
    factuality: "mixed",
    role: "attach-only",
    sourceIdentifier: "news-cpc",
  },
  {
    canonicalName: "China Daily",
    domains: ["chinadaily.com.cn"],
    originCountry: "China",
    originRegion: "East Asia",
    factuality: "mixed",
    role: "attach-only",
    sourceIdentifier: "news-cpc",
  },
  {
    canonicalName: "People's Daily",
    aliases: ["Peoples Daily"],
    domains: ["en.people.cn", "people.cn"],
    originCountry: "China",
    originRegion: "East Asia",
    factuality: "low",
    role: "attach-only",
    sourceIdentifier: "news-cpc",
  },
  {
    canonicalName: "Press TV",
    domains: ["presstv.ir"],
    logoSlug: "press-tv",
    logoObjectFit: "contain",
    originCountry: "Iran",
    originRegion: "Middle East",
    factuality: "very-low",
    role: "attach-only",
    sourceIdentifier: "news-cpc",
  },
  {
    canonicalName: "Tehran Times",
    domains: ["tehrantimes.com"],
    originCountry: "Iran",
    originRegion: "Middle East",
    factuality: "low",
    role: "attach-only",
    sourceIdentifier: "news-cpc",
  },
  {
    canonicalName: "IRNA",
    aliases: ["Islamic Republic News Agency"],
    domains: ["irna.ir", "en.irna.ir"],
    originCountry: "Iran",
    originRegion: "Middle East",
    factuality: "low",
    role: "attach-only",
    sourceIdentifier: "news-cpc",
  },
  {
    canonicalName: "Fars News",
    aliases: ["Fars News Agency", "Fars"],
    domains: ["farsnews.ir", "farsnews.com"],
    originCountry: "Iran",
    originRegion: "Middle East",
    factuality: "low",
    role: "attach-only",
    sourceIdentifier: "news-cpc",
  },
  // Adversary expansion (Task #231) — Group 3 (curated-lane only). All news-cpc
  // → contrast: ride-along only, never seed/anchor/represent a curated story.
  {
    canonicalName: "KCNA",
    aliases: ["KCNA Watch", "Korean Central News Agency", "KCNA (DPRK)"],
    domains: ["kcna.kp", "kcnawatch.org"],
    originCountry: "North Korea",
    originRegion: "East Asia",
    factuality: "very-low",
    role: "attach-only",
    sourceIdentifier: "news-cpc",
  },
  {
    canonicalName: "China Military Online",
    aliases: ["PLA Daily", "China Military", "81.cn"],
    domains: ["chinamil.com.cn", "eng.chinamil.com.cn", "81.cn"],
    originCountry: "China",
    originRegion: "East Asia",
    factuality: "low",
    role: "attach-only",
    sourceIdentifier: "news-cpc",
  },
  {
    canonicalName: "CGTN",
    aliases: ["China Global Television Network"],
    domains: ["cgtn.com"],
    originCountry: "China",
    originRegion: "East Asia",
    factuality: "low",
    role: "attach-only",
    sourceIdentifier: "news-cpc",
  },
  {
    canonicalName: "Tasnim News Agency",
    aliases: ["Tasnim News", "Tasnim"],
    domains: ["tasnimnews.com"],
    originCountry: "Iran",
    originRegion: "Middle East",
    factuality: "low",
    role: "attach-only",
    sourceIdentifier: "news-cpc",
  },
  {
    canonicalName: "Mehr News Agency",
    aliases: ["Mehr News", "Mehr"],
    domains: ["mehrnews.com", "en.mehrnews.com"],
    originCountry: "Iran",
    originRegion: "Middle East",
    factuality: "low",
    role: "attach-only",
    sourceIdentifier: "news-cpc",
  },
  {
    canonicalName: "Prensa Latina",
    aliases: ["Prensa Latina (PL)"],
    domains: ["plenglish.com", "prensa-latina.cu"],
    originCountry: "Cuba",
    originRegion: "Latin America",
    factuality: "low",
    role: "attach-only",
    sourceIdentifier: "news-cpc",
  },
  {
    canonicalName: "teleSUR",
    aliases: ["teleSUR English", "telesur"],
    domains: ["telesurenglish.net", "telesurtv.net"],
    originCountry: "Venezuela",
    originRegion: "Latin America",
    factuality: "very-low",
    role: "attach-only",
    sourceIdentifier: "news-cpc",
  },
  // ---------------------------------------------------------------------------
  // Warfighter-only opinion outlets (attach-only)
  // ---------------------------------------------------------------------------
  {
    canonicalName: "The Blaze",
    aliases: ["Blaze"],
    domains: ["theblaze.com"],
    logoSlug: "the-blaze",
    logoObjectFit: "contain",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "mixed",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "opinion",
  },
  {
    canonicalName: "The Epoch Times",
    aliases: ["Epoch Times"],
    domains: ["theepochtimes.com"],
    logoSlug: "epoch-times",
    logoBrandColor: "#12386B",
    logoObjectFit: "cover",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "mixed",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "opinion",
  },
  {
    canonicalName: "The Daily Wire",
    aliases: ["Daily Wire"],
    domains: ["dailywire.com"],
    logoSlug: "daily-wire",
    logoObjectFit: "contain",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "mixed",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "opinion",
  },
  {
    // Task #837 — curated-only magazine / periodical (no main-feed/RSS-roster
    // presence by design; see server/curatedFeeds.ts MAGAZINE_FEEDS). Attach-only:
    // articles can join already-formed curated stories but never anchor, form, or
    // stand alone as headlines. No logoSlug: omit until an asset is supplied
    // (SourceIcon/registry handle a missing logo gracefully, per HuffPost
    // precedent below).
    canonicalName: "The Atlantic",
    aliases: ["Atlantic", "TheAtlantic"],
    domains: ["theatlantic.com"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "high",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "magazine",
  },

  {
    // Task #662 — curated-only (no main-feed/RSS-roster presence by design; see
    // server/curatedFeeds.ts OPINION_FEEDS). No logoSlug: omit until an asset is
    // supplied (SourceIcon/registry handle a missing logo gracefully, like
    // Breitbart above).
    canonicalName: "HuffPost",
    aliases: ["Huffington Post", "The Huffington Post"],
    domains: ["huffpost.com", "huffingtonpost.com"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "mixed",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "opinion",
  },

  // ---------------------------------------------------------------------------
  // Quarantined low-credibility bucket (attach-only) — never published, mirrors
  // BLOCKED_MEDIA_OUTLET_NAMES + non-credible buckets in server/scraper.ts.
  // ---------------------------------------------------------------------------
  {
    canonicalName: "The Sun",
    domains: ["thesun.co.uk"],
    originCountry: "United Kingdom",
    originRegion: "Europe",
    factuality: "low",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "tabloid",
  },
  {
    canonicalName: "Breitbart",
    aliases: ["Breitbart News"],
    domains: ["breitbart.com"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "low",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "opinion",
  },
  {
    canonicalName: "Infowars",
    domains: ["infowars.com"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-low",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "opinion",
  },
  {
    canonicalName: "The Gateway Pundit",
    aliases: ["Gateway Pundit"],
    domains: ["thegatewaypundit.com"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-low",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "opinion",
  },
  {
    canonicalName: "National Enquirer",
    domains: ["nationalenquirer.com"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-low",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "tabloid",
  },
  {
    canonicalName: "WND",
    aliases: ["WorldNetDaily"],
    domains: ["wnd.com"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "very-low",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "opinion",
  },

  // ---------------------------------------------------------------------------
  // UK broadsheets / tabloids reaching Curated (Task #1052) — registered so
  // the trust engine can tier their content. Never main-feed; curated-lane only.
  // ---------------------------------------------------------------------------
  {
    canonicalName: "The Telegraph",
    aliases: ["Telegraph"],
    domains: ["telegraph.co.uk"],
    originCountry: "United Kingdom",
    originRegion: "Europe",
    factuality: "high",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    // the-express.com is the modern domain for The Express (formerly Daily
    // Express), a UK tabloid. Mixed factuality → deriveBehavior renders as
    // contrast/anchor-only (ride-along only for context, not a headline anchor).
    canonicalName: "Daily Express",
    aliases: ["The Express", "Express"],
    domains: ["the-express.com", "express.co.uk"],
    originCountry: "United Kingdom",
    originRegion: "Europe",
    factuality: "mixed",
    role: "contributing",
    sourceIdentifier: "news-international",
  },
  {
    // Daily Mirror / The Mirror US (Task #1115) — Reach plc's red-top; the US
    // edition (themirror.com, delivered as raw source "Themirror" via the
    // Meltwater general-press pipe) reached Curated with no registry row, so
    // the Coverage tab flagged it "unresolved". One brand-family row covers
    // both editions — the exact precedent is Daily Express above (US domain
    // the-express.com + UK express.co.uk in one row). The "Themirror" alias is
    // required for name-first resolution: normalizeOutletName("Themirror") is
    // the single token "themirror" (no leading-"the " strip without a space),
    // which no other key produces. Mixed factuality → deriveBehavior renders
    // contrast/anchor-only (shown for contrast, never a headline), matching
    // the Daily Express treatment of the same market segment.
    canonicalName: "Daily Mirror",
    aliases: ["The Mirror", "Mirror", "The Mirror US", "Themirror"],
    domains: ["themirror.com", "mirror.co.uk"],
    originCountry: "United Kingdom",
    originRegion: "Europe",
    factuality: "mixed",
    role: "contributing",
    sourceIdentifier: "news-international",
  },

  // ---------------------------------------------------------------------------
  // Yahoo News (Task #1052) — syndication aggregator that surfaces in Curated
  // items. Attribute to the real publisher where detectable; this entry covers
  // items whose source resolves only to Yahoo itself. Treat as an aggregator:
  // attach-only, n/a factuality (content quality varies by syndicated source).
  // ---------------------------------------------------------------------------
  {
    canonicalName: "Yahoo News",
    aliases: ["Yahoo", "Yahoo! News"],
    domains: ["yahoo.com", "news.yahoo.com"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "aggregator",
  },

  // ---------------------------------------------------------------------------
  // Aggregators / alerting / official (attach-only or government)
  // ---------------------------------------------------------------------------
  {
    canonicalName: "Drudge Report",
    aliases: ["Drudge"],
    domains: ["drudgereport.com"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "aggregator",
  },
  {
    // DataMinr First Alert wire (Task #138). Flash tip service admitted to
    // curated as ATTACH (other/social): may JOIN a formed story but never seeds
    // or corroborates. Name-first resolution keeps an alert that links to a news
    // article classified as DataMinr (attach), not as the linked outlet.
    canonicalName: "Dataminr",
    aliases: ["DataMinr", "Dataminr First Alert", "First Alert"],
    domains: ["dataminr.com"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "social",
  },
  {
    canonicalName: "Pentagon",
    aliases: ["Department of Defense", "DoD", "U.S. Department of War"],
    domains: ["defense.gov", "war.gov"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "release-us-official",
  },

  // ---------------------------------------------------------------------------
  // Social buckets (attach-only) — accounts MCOP ingests via X/Truth Social.
  // ---------------------------------------------------------------------------
  {
    canonicalName: "POTUS (Truth Social)",
    aliases: ["POTUS", "Donald Trump", "Truth Social"],
    logoSlug: "potus-truth-social",
    logoObjectFit: "contain",
    originCountry: "United States",
    originRegion: "North America",
    factuality: "n/a",
    role: "attach-only",
    // Official US head-of-state social account — attach-only Additional Coverage.
    sourceIdentifier: "social-us-official",
  },
  {
    canonicalName: "SecWar / Pete Hegseth (X)",
    aliases: ["SecWar", "Pete Hegseth", "PeteHegseth", "SecDef"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "social-us-official",
  },
  {
    canonicalName: "RapidResponse47",
    displayName: "Rapid Response 47",
    aliases: ["Rapid Response 47"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "social-us-official",
  },
  {
    canonicalName: "DOWResponse",
    displayName: "DOW Rapid Response",
    aliases: ["DOW Response", "Department of War Response"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "social-us-official",
  },
  {
    canonicalName: "DoW CIO Kirsten Davies",
    aliases: ["DoWCIODavies", "Kirsten Davies", "DoW CIO"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "social-us-official",
  },
  {
    canonicalName: "sentdefender",
    displayName: "OSINTdefender",
    aliases: ["Sentinel Defender", "OSINTdefender"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "social",
  },
  // ---------------------------------------------------------------------------
  // OSINT-analyst X handles (Task #1115) — high-volume curated OSINT X Feed
  // accounts that reach the curated store via the social intake
  // (curatedIngest SOCIAL_OSINT_ACCOUNTS, source = exact scraper handle) but
  // had NO registry row, so the Coverage tab flagged them "unresolved" every
  // pass and their lane tier fell through to the fail-closed unknown-source
  // default. Registering them follows the sentdefender pattern (unofficial
  // OSINT analyst => other/social): deriveBehavior still renders ATTACH
  // (ride-along only — never seeds, anchors, corroborates, or supplies media),
  // so admission/tiering behavior is unchanged; the tier is now legitimately
  // derived and the handles resolve in the Coverage roster. Labeling only;
  // canonicalName = exact handle so name-first resolution matches the stored
  // source string. Geographic AOR carried as originRegion (command-handle
  // convention); no country claim for the anonymous MATA_osint account.
  // ---------------------------------------------------------------------------
  {
    canonicalName: "Osint613",
    displayName: "Open Source Intel",
    aliases: ["OSINT613"],
    originCountry: "Israel",
    originRegion: "Middle East",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "social",
  },
  {
    canonicalName: "Osinttechnical",
    displayName: "OSINTtechnical",
    aliases: ["OSINTtechnical"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "social",
  },
  {
    canonicalName: "MATA_osint",
    displayName: "Military Air Tracking Alliance",
    aliases: ["MATA OSINT"],
    originRegion: "Middle East",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "social",
  },
  // Remaining OSINT analysts and journalist X handles are curated social
  // sources. Their exact scraper handles are canonical names so name-first
  // resolution recognizes rows already stored in the curated lane. Like
  // sentdefender and the earlier OSINT analyst entries, these are labels only:
  // social posts remain attach-only and cannot form, anchor, or represent a
  // story.
  {
    canonicalName: "FirstSquawk",
    displayName: "First Squawk",
    aliases: ["FirstSquawk"],
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "social",
  },
  {
    canonicalName: "AggregateOsint",
    displayName: "Aggregate OSINT",
    aliases: ["Aggregate OSINT"],
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "social",
  },
  {
    canonicalName: "pizzintwatch",
    displayName: "Pizzint Watch",
    aliases: ["Pizzint Watch"],
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "social",
  },
  {
    canonicalName: "Global_Mil_Info",
    displayName: "Global Military Info",
    aliases: ["Global Military Info"],
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "social",
  },
  {
    canonicalName: "BarakRavid",
    displayName: "Barak Ravid",
    aliases: ["Barak Ravid"],
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "social",
  },
  {
    canonicalName: "jeremybob1",
    displayName: "Jeremy Bob",
    aliases: ["Jeremy Bob"],
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "social",
  },
  {
    canonicalName: "phildstewart",
    displayName: "Phil Stewart",
    aliases: ["Phil Stewart"],
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "social",
  },
  {
    canonicalName: "EricSchmittNYT",
    displayName: "Eric Schmitt",
    aliases: ["Eric Schmitt"],
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "social",
  },
  {
    canonicalName: "alexbward",
    displayName: "Alex Ward",
    aliases: ["Alex Ward"],
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "other",
    otherSourceType: "social",
  },
  {
    canonicalName: "CENTCOM",
    displayName: "U.S. Central Command",
    aliases: ["U.S. Central Command"],
    originCountry: "United States",
    originRegion: "Middle East",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "release-us-official",
  },
  {
    canonicalName: "SOUTHCOM",
    displayName: "U.S. Southern Command",
    aliases: ["U.S. Southern Command"],
    originCountry: "United States",
    originRegion: "Latin America",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "release-us-official",
  },
  // Combatant command X accounts (Task #282) — curated-only, folded into the
  // U.S. X Feed alongside CENTCOM/SOUTHCOM. Geographic commands carry their AOR
  // as originRegion; functional/global commands default to North America.
  {
    canonicalName: "U.S. European Command",
    aliases: ["US_EUCOM", "EUCOM"],
    originCountry: "United States",
    originRegion: "Europe",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "release-us-official",
  },
  {
    // The curated U.S. X Feed handle was changed to @USPACOM ("U.S. Pacific
    // Command"). The registry row deliberately keeps its stable canonical
    // name/key — renaming it would orphan the existing (read-only) prod row and
    // split the INDOPACOM alias across two rows — but adds @USPACOM and the
    // Pacific Command name as aliases so both the new and legacy handles resolve
    // to this same attach-only combatant-command entry.
    canonicalName: "U.S. Indo-Pacific Command",
    aliases: ["USPACOM", "INDOPACOM", "U.S. Pacific Command"],
    originCountry: "United States",
    originRegion: "Asia",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "release-us-official",
  },
  {
    canonicalName: "U.S. Africa Command (AFRICOM)",
    aliases: ["USAfricaCommand", "AFRICOM", "U.S. Africa Command"],
    originCountry: "United States",
    originRegion: "Africa",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "release-us-official",
  },
  {
    canonicalName: "U.S. Northern Command",
    aliases: ["USNorthernCmd", "NORTHCOM"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "release-us-official",
  },
  {
    canonicalName: "U.S. Space Command",
    aliases: ["US_SpaceCom", "SPACECOM"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "release-us-official",
  },
  {
    canonicalName: "U.S. Cyber Command",
    aliases: ["US_CYBERCOM", "CYBERCOM"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "release-us-official",
  },
  {
    canonicalName: "USSOCOM",
    aliases: ["USSOCOM", "US_SpecialOperationsCommand", "U.S. Special Operations Command", "SOCOM"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "release-us-official",
  },
  {
    canonicalName: "United States Strategic Command",
    aliases: ["US_STRATCOM", "STRATCOM"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "release-us-official",
  },
  {
    canonicalName: "USTRANSCOM",
    aliases: ["US_TRANSCOM", "U.S. Transportation Command", "TRANSCOM"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "release-us-official",
  },
  // Official US government X accounts scraped into the shared x_posts table.
  // Each handle resolves here so its curated rows derive social-us-official =>
  // ATTACH-ONLY: visible as attributed Additional Coverage, but excluded from
  // formation, survival, facts, representation, media, priority, and freshness.
  // Aliases include the exact scraper handle so findOutlet matches by name.
  {
    canonicalName: "The White House (X)",
    aliases: ["WhiteHouse", "The White House", "White House"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "social-us-official",
  },
  {
    canonicalName: "PressSec (X)",
    aliases: ["PressSec", "White House Press Secretary"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "social-us-official",
  },
  {
    canonicalName: "The Joint Staff (X)",
    aliases: ["TheJointStaff", "Joint Staff", "Joint Chiefs of Staff"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "social-us-official",
  },
  {
    canonicalName: "Secretary of the Army (X)",
    aliases: ["SecArmy", "Secretary of the Army"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "social-us-official",
  },
  {
    canonicalName: "Secretary of the Air Force (X)",
    aliases: ["SecAFOfficial", "Secretary of the Air Force"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "social-us-official",
  },
  {
    canonicalName: "Sean Parnell (X)",
    aliases: ["SeanParnellASW", "Sean Parnell"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "social-us-official",
  },
  {
    canonicalName: "Marco Rubio (X)",
    aliases: ["SecRubio", "SenMarcoRubio", "Marco Rubio", "Secretary of State Rubio"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "social-us-official",
  },
  {
    canonicalName: "U.S. Department of State (X)",
    aliases: ["StateDept", "Department of State", "State Department", "U.S. Department of State"],
    originCountry: "United States",
    originRegion: "North America",
    factuality: "n/a",
    role: "attach-only",
    sourceIdentifier: "social-us-official",
  },
];

/**
 * Upsert the hand-curated seed into outlet_registry. Idempotent: rerunning on
 * each boot keeps the registry in sync with this file (the source of truth).
 */
export async function seedOutletRegistry(): Promise<void> {
  try {
    let count = 0;
    for (const seed of OUTLET_SEED) {
      const key = normalizeOutletName(seed.canonicalName);
      if (!key) continue;
      const aliases = Array.from(
        new Set((seed.aliases ?? []).map((a) => a.trim()).filter(Boolean)),
      );
      const domains = Array.from(
        new Set((seed.domains ?? []).map((d) => d.toLowerCase().trim()).filter(Boolean)),
      );
      const now = new Date();
      // Hand-curated descriptive fields are stamped with "seed" provenance so the
      // oversight UI can show where each value came from. Enrichment/manual edits
      // overwrite these entries later.
      const sourceIdentifier = seed.sourceIdentifier;
      const otherSourceType =
        seed.otherSourceType ??
        (sourceIdentifier === "other" ? "unknown" : null);

      const seededProvenance: Record<string, { source: string; at: string }> = {};
      for (const f of ["originCountry", "originRegion", "factuality", "role"] as const) {
        if (seed[f] !== undefined && seed[f] !== null) {
          seededProvenance[f] = { source: "seed", at: now.toISOString() };
        }
      }
      seededProvenance["sourceIdentifier"] = { source: "seed", at: now.toISOString() };
      if (otherSourceType) seededProvenance["otherSourceType"] = { source: "seed", at: now.toISOString() };

      // Identity + bundled-logo columns are safe to refresh on every boot.
      const identityValues = {
        canonicalName: seed.canonicalName,
        displayName: seed.displayName ?? null,
        aliases,
        domains,
        logoSlug: seed.logoSlug ?? null,
        logoBrandColor: seed.logoBrandColor ?? null,
        logoObjectFit: seed.logoObjectFit ?? null,
      };

      // Descriptive/enrichment columns are ONLY written when the row is first
      // inserted. On conflict we deliberately leave them untouched so a later
      // enrichment pass or a human's manual override is never clobbered by a
      // reboot. The seed is the initial source of truth; ownership then passes
      // to the enrichment + oversight layer.
      const insertValues = {
        key,
        ...identityValues,
        originCountry: seed.originCountry ?? null,
        originRegion: seed.originRegion ?? null,
        factuality: seed.factuality ?? null,
        sourceIdentifier,
        otherSourceType,
        ownership: seed.ownership ?? [],
        blocked: seed.blocked ?? false,
        role: seed.role,
        confirmationStatus: "confirmed" as const,
        enrichmentProvenance: seededProvenance,
        manualOverrides: {},
      };

      await db
        .insert(outletRegistry)
        .values(insertValues)
        .onConflictDoUpdate({
          target: outletRegistry.key,
          // Identity columns refresh every boot. The behavior-engine identity is
          // back-filled ONLY where it is still null (new columns on pre-existing
          // rows) — a human/enrichment value already present is never clobbered.
          set: {
            ...identityValues,
            updatedAt: now,
          },
        });
      count++;
    }
    console.log(`✅ Seeded outlet registry (${count} outlets)`);

    // One-time vocabulary cleanup for the retired "mostly-factual" factuality
    // label (renamed to "high" in the current 5-tier scale: very-high · high ·
    // mixed · low · very-low). Enrichment intentionally never touches a manually
    // overridden field, so manual "mostly-factual" picks would otherwise stay
    // frozen under a label that no longer exists in the Source Oversight
    // dropdown. We translate ONLY this retired value — in both the column and
    // the manual_overrides JSON — preserving the manual override (same trust
    // tier, just the new name). We deliberately do NOT touch "high" values: the
    // new dropdown can produce a legitimate "high" pick, so blindly bumping it
    // to "very-high" would corrupt fresh overrides. Idempotent: once no
    // "mostly-factual" rows remain this is a no-op.
    // One-time reclassification: Al-Monitor was seeded "news-us-domestic" but is
    // a Middle-East-focused publication (US-owned) — it does not belong to the
    // US-domestic mainstream press corps, which now drives the Top Narratives /
    // MCOP Highlights ecosystem bucketing. Heal the pre-existing row (seed only
    // writes descriptive cols on first insert). Guarded so a human's explicit
    // Source Oversight pick is never clobbered. Idempotent: no-op once healed.
    const alMonitorHeal = await db.execute(sql`
      UPDATE outlet_registry
      SET source_identifier = 'news-international', updated_at = NOW()
      WHERE key = ${normalizeOutletName("Al-Monitor")}
        AND source_identifier = 'news-us-domestic'
        AND manual_overrides->>'sourceIdentifier' IS NULL
    `);
    if (((alMonitorHeal as { rowCount?: number }).rowCount ?? 0) > 0) {
      console.log('✅ Reclassified Al-Monitor → news-international (ecosystem bucketing)');
    }

    const factualityCol = await db.execute(sql`
      UPDATE outlet_registry
      SET factuality = 'high', updated_at = NOW()
      WHERE factuality = 'mostly-factual'
    `);
    const factualityOverride = await db.execute(sql`
      UPDATE outlet_registry
      SET manual_overrides = jsonb_set(COALESCE(manual_overrides, '{}'::jsonb), '{factuality}', '"high"'),
          updated_at = NOW()
      WHERE manual_overrides->>'factuality' = 'mostly-factual'
    `);
    const colCount = (factualityCol as { rowCount?: number }).rowCount ?? 0;
    const ovrCount = (factualityOverride as { rowCount?: number }).rowCount ?? 0;
    if (colCount > 0 || ovrCount > 0) {
      console.log(
        `✅ Normalized retired "mostly-factual" → "high" (columns: ${colCount}, manual overrides: ${ovrCount})`,
      );
    }

    // Vocabulary heal for the new "aggregator" other-source type: Yahoo News and
    // Drudge Report were originally seeded with otherSourceType "unknown"
    // (attach-only syndication fallbacks), which looks like an un-triaged
    // outlet in Source Oversight. The seed above only writes descriptive
    // columns on first insert, so already-seeded rows must be flipped here.
    // Scope: EXACTLY these canonical outlets, only where the column still says
    // "unknown", and never where a human manually overrode the field
    // (manual_overrides carries 'otherSourceType'). Idempotent: a no-op once
    // flipped. Follows the "mostly-factual" migration pattern above.
    const aggregatorKeys = ["Yahoo News", "Drudge Report"].map((n) =>
      normalizeOutletName(n),
    );
    const aggregatorHeal = await db.execute(sql`
      UPDATE outlet_registry
      SET other_source_type = 'aggregator', updated_at = NOW()
      WHERE key IN (${sql.join(aggregatorKeys.map((k) => sql`${k}`), sql`, `)})
        AND other_source_type = 'unknown'
        AND NOT (COALESCE(manual_overrides, '{}'::jsonb) ? 'otherSourceType')
    `);
    const aggCount = (aggregatorHeal as { rowCount?: number }).rowCount ?? 0;
    if (aggCount > 0) {
      console.log(
        `✅ Normalized aggregator outlets "unknown" → "aggregator" (rows: ${aggCount})`,
      );
    }

    // POTUS Truth Social has one application-owned identity image: the bundled
    // presidential seal. Clear only this exact registry row's legacy uploaded
    // logo so an old flag upload cannot override that canonical identity. Other
    // outlets retain normal uploaded-logo precedence. Removing stale provenance
    // keeps Source Oversight from claiming the cleared upload is still active.
    // Idempotent: once null, subsequent boots update zero rows.
    const potusLogoHeal = await db.execute(sql`
      UPDATE outlet_registry
      SET logo_url = NULL,
          enrichment_provenance = COALESCE(enrichment_provenance, '{}'::jsonb) - 'logoUrl',
          manual_overrides = COALESCE(manual_overrides, '{}'::jsonb) - 'logoUrl',
          updated_at = NOW()
      WHERE key = ${normalizeOutletName("POTUS (Truth Social)")}
        AND logo_url IS NOT NULL
    `);
    const potusLogoCount = (potusLogoHeal as { rowCount?: number }).rowCount ?? 0;
    if (potusLogoCount > 0) {
      console.log('✅ Restored POTUS Truth Social canonical presidential-seal identity');
    }
  } catch (err) {
    console.error("[Startup] seedOutletRegistry error:", err);
  }
}
