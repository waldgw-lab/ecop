// =============================================================================
// Public-reference outlet dataset.
//
// A bundled, static snapshot of widely-published media-assessment references
// (Media Bias/Fact Check factuality, Ad Fontes reliability). We bundle a derived
// snapshot rather than scraping those sites live: it is deterministic, testable,
// requires no credentials, and respects each reference's terms of use. A licensed
// live feed can be added later as a separate adapter without touching this one.
//
// Keyed by registrable domain (the most stable identifier). The reference
// adapter falls back to alias/name matching when a registry row carries no
// domain.
//
// Field vocabularies (match the seed + outlet_registry):
//   factuality:      very-high | high | mixed | low | very-low
// =============================================================================
import type { OutletEnrichmentFields } from "./types";

export interface ReferenceEntry extends OutletEnrichmentFields {
  /** Registrable domains this entry applies to. */
  domains: string[];
  /** Normalized canonical names / aliases for name-based fallback matching. */
  names?: string[];
}

export const REFERENCE_DATASET: ReferenceEntry[] = [
  // --- Wire services -------------------------------------------------------
  { domains: ["apnews.com"], names: ["associated press", "ap news"], originCountry: "United States", originRegion: "North America", factuality: "very-high" },
  { domains: ["reuters.com", "reutersagency.com"], names: ["reuters"], originCountry: "United Kingdom", originRegion: "Europe", factuality: "very-high" },
  { domains: ["bloomberg.com"], names: ["bloomberg"], originCountry: "United States", originRegion: "North America", factuality: "very-high" },
  { domains: ["afp.com"], names: ["agence france presse", "afp"], originCountry: "France", originRegion: "Europe", factuality: "very-high" },

  // --- US major broadcast / print -----------------------------------------
  { domains: ["foxnews.com"], names: ["fox news"], originCountry: "United States", originRegion: "North America", factuality: "mixed" },
  { domains: ["cnn.com"], names: ["cnn"], originCountry: "United States", originRegion: "North America", factuality: "high" },
  { domains: ["nbcnews.com"], names: ["nbc news", "nbc"], originCountry: "United States", originRegion: "North America", factuality: "high" },
  { domains: ["abcnews.go.com", "abcnews.com"], names: ["abc news"], originCountry: "United States", originRegion: "North America", factuality: "high" },
  { domains: ["cbsnews.com"], names: ["cbs news"], originCountry: "United States", originRegion: "North America", factuality: "high" },
  { domains: ["msnbc.com"], names: ["msnbc"], originCountry: "United States", originRegion: "North America", factuality: "mixed" },
  { domains: ["nytimes.com"], names: ["new york times", "the new york times"], originCountry: "United States", originRegion: "North America", factuality: "very-high" },
  { domains: ["washingtonpost.com"], names: ["washington post", "the washington post"], originCountry: "United States", originRegion: "North America", factuality: "very-high" },
  { domains: ["wsj.com"], names: ["wall street journal", "the wall street journal"], originCountry: "United States", originRegion: "North America", factuality: "very-high" },
  { domains: ["usatoday.com"], names: ["usa today"], originCountry: "United States", originRegion: "North America", factuality: "high" },
  { domains: ["npr.org"], names: ["npr"], originCountry: "United States", originRegion: "North America", factuality: "very-high" },
  { domains: ["pbs.org"], names: ["pbs", "pbs newshour"], originCountry: "United States", originRegion: "North America", factuality: "very-high" },
  { domains: ["cnbc.com"], names: ["cnbc"], originCountry: "United States", originRegion: "North America", factuality: "high" },
  { domains: ["newsnationnow.com"], names: ["newsnation"], originCountry: "United States", originRegion: "North America", factuality: "high" },

  // --- US political / opinion ---------------------------------------------
  { domains: ["politico.com"], names: ["politico"], originCountry: "United States", originRegion: "North America", factuality: "high" },
  { domains: ["thehill.com"], names: ["the hill"], originCountry: "United States", originRegion: "North America", factuality: "high" },
  { domains: ["washingtonexaminer.com"], names: ["washington examiner"], originCountry: "United States", originRegion: "North America", factuality: "mixed" },
  { domains: ["washingtontimes.com"], names: ["washington times", "the washington times"], originCountry: "United States", originRegion: "North America", factuality: "mixed" },
  { domains: ["dailywire.com"], names: ["daily wire", "the daily wire"], originCountry: "United States", originRegion: "North America", factuality: "mixed" },
  { domains: ["theblaze.com"], names: ["the blaze", "blaze"], originCountry: "United States", originRegion: "North America", factuality: "mixed" },
  { domains: ["theepochtimes.com"], names: ["epoch times", "the epoch times"], originCountry: "United States", originRegion: "North America", factuality: "mixed" },
  { domains: ["huffpost.com", "huffingtonpost.com"], names: ["huffpost", "huffington post", "the huffington post"], originCountry: "United States", originRegion: "North America", factuality: "mixed" },

  // --- UK / Europe ---------------------------------------------------------
  { domains: ["bbc.com", "bbc.co.uk"], names: ["bbc", "bbc news"], originCountry: "United Kingdom", originRegion: "Europe", factuality: "very-high" },
  { domains: ["theguardian.com"], names: ["the guardian", "guardian"], originCountry: "United Kingdom", originRegion: "Europe", factuality: "very-high" },
  { domains: ["dw.com"], names: ["deutsche welle", "dw"], originCountry: "Germany", originRegion: "Europe", factuality: "very-high" },
  { domains: ["france24.com"], names: ["france 24", "france24"], originCountry: "France", originRegion: "Europe", factuality: "very-high" },

  // --- State-controlled / adversary ---------------------------------------
  { domains: ["rt.com"], names: ["rt", "russia today"], originCountry: "Russia", originRegion: "Europe", factuality: "very-low" },
  { domains: ["sputniknews.com", "sputnikglobe.com"], names: ["sputnik"], originCountry: "Russia", originRegion: "Europe", factuality: "very-low" },
  { domains: ["tass.com", "tass.ru"], names: ["tass"], originCountry: "Russia", originRegion: "Europe", factuality: "mixed" },
  { domains: ["globaltimes.cn"], names: ["global times"], originCountry: "China", originRegion: "Asia", factuality: "low" },
  { domains: ["xinhuanet.com", "news.cn"], names: ["xinhua"], originCountry: "China", originRegion: "Asia", factuality: "mixed" },
  { domains: ["presstv.ir"], names: ["press tv"], originCountry: "Iran", originRegion: "Middle East", factuality: "very-low" },
  { domains: ["tehrantimes.com"], names: ["tehran times"], originCountry: "Iran", originRegion: "Middle East", factuality: "low" },

  // --- Middle East ---------------------------------------------------------
  { domains: ["aljazeera.com"], names: ["al jazeera"], originCountry: "Qatar", originRegion: "Middle East", factuality: "high" },
  { domains: ["alarabiya.net"], names: ["al arabiya"], originCountry: "Saudi Arabia", originRegion: "Middle East", factuality: "mixed" },
  { domains: ["timesofisrael.com"], names: ["times of israel", "the times of israel"], originCountry: "Israel", originRegion: "Middle East", factuality: "very-high" },
  { domains: ["jpost.com"], names: ["jerusalem post", "the jerusalem post"], originCountry: "Israel", originRegion: "Middle East", factuality: "high" },
  { domains: ["haaretz.com"], names: ["haaretz"], originCountry: "Israel", originRegion: "Middle East", factuality: "very-high" },
  { domains: ["al-monitor.com"], names: ["al-monitor", "al monitor"], originCountry: "United States", originRegion: "Middle East", factuality: "very-high" },

  // --- Defense / security trade -------------------------------------------
  { domains: ["defensenews.com"], names: ["defense news"], originCountry: "United States", originRegion: "North America", factuality: "very-high" },
  { domains: ["militarytimes.com"], names: ["military times"], originCountry: "United States", originRegion: "North America", factuality: "very-high" },
  { domains: ["stripes.com"], names: ["stars and stripes"], originCountry: "United States", originRegion: "North America", factuality: "very-high" },
  { domains: ["breakingdefense.com"], names: ["breaking defense"], originCountry: "United States", originRegion: "North America", factuality: "very-high" },
  { domains: ["defenseone.com"], names: ["defense one"], originCountry: "United States", originRegion: "North America", factuality: "very-high" },
  { domains: ["thedrive.com", "twz.com"], names: ["the war zone", "war zone"], originCountry: "United States", originRegion: "North America", factuality: "very-high" },
  { domains: ["warontherocks.com"], names: ["war on the rocks"], originCountry: "United States", originRegion: "North America", factuality: "very-high" },
  { domains: ["foreignpolicy.com"], names: ["foreign policy"], originCountry: "United States", originRegion: "North America", factuality: "very-high" },
  { domains: ["thediplomat.com"], names: ["the diplomat", "diplomat"], originCountry: "United States", originRegion: "Asia", factuality: "very-high" },

  // --- Think tanks ---------------------------------------------------------
  { domains: ["csis.org"], names: ["csis", "center for strategic and international studies"], originCountry: "United States", originRegion: "North America", factuality: "very-high" },
  { domains: ["rand.org"], names: ["rand", "rand corporation"], originCountry: "United States", originRegion: "North America", factuality: "very-high" },
  { domains: ["atlanticcouncil.org"], names: ["atlantic council", "dfrlab", "digital forensic research lab"], originCountry: "United States", originRegion: "North America", factuality: "very-high" },
  { domains: ["brookings.edu"], names: ["brookings", "brookings institution"], originCountry: "United States", originRegion: "North America", factuality: "very-high" },

  // --- US national outlets -------------------------------------------------
  { domains: ["nypost.com"], names: ["new york post", "ny post", "nypost"], originCountry: "United States", originRegion: "North America", factuality: "mixed" },
  { domains: ["newsweek.com"], names: ["newsweek"], originCountry: "United States", originRegion: "North America", factuality: "mixed" },
  { domains: ["axios.com"], names: ["axios"], originCountry: "United States", originRegion: "North America", factuality: "high" },
  { domains: ["theatlantic.com"], names: ["the atlantic", "atlantic"], originCountry: "United States", originRegion: "North America", factuality: "high" },
  { domains: ["breitbart.com"], names: ["breitbart", "breitbart news"], originCountry: "United States", originRegion: "North America", factuality: "mixed" },
  { domains: ["infowars.com"], names: ["infowars"], originCountry: "United States", originRegion: "North America", factuality: "very-low" },
  { domains: ["thegatewaypundit.com"], names: ["the gateway pundit", "gateway pundit"], originCountry: "United States", originRegion: "North America", factuality: "very-low" },
  { domains: ["wnd.com"], names: ["wnd", "worldnetdaily"], originCountry: "United States", originRegion: "North America", factuality: "very-low" },
  { domains: ["nationalenquirer.com"], names: ["national enquirer"], originCountry: "United States", originRegion: "North America", factuality: "very-low" },

  // --- US defense / security trade -----------------------------------------
  { domains: ["insidedefense.com"], names: ["inside defense", "insidedefense", "inside the pentagon"], originCountry: "United States", originRegion: "North America", factuality: "very-high" },
  { domains: ["military.com"], names: ["military.com"], originCountry: "United States", originRegion: "North America", factuality: "high" },
  { domains: ["taskandpurpose.com"], names: ["task & purpose", "task and purpose"], originCountry: "United States", originRegion: "North America", factuality: "high" },
  { domains: ["foreignaffairs.com"], names: ["foreign affairs"], originCountry: "United States", originRegion: "North America", factuality: "very-high" },

  // --- UK / Europe (extended) ----------------------------------------------
  { domains: ["telegraph.co.uk"], names: ["the telegraph", "telegraph"], originCountry: "United Kingdom", originRegion: "Europe", factuality: "high" },
  { domains: ["the-express.com", "express.co.uk"], names: ["the express", "daily express", "express"], originCountry: "United Kingdom", originRegion: "Europe", factuality: "mixed" },
  { domains: ["thesun.co.uk"], names: ["the sun", "sun uk"], originCountry: "United Kingdom", originRegion: "Europe", factuality: "mixed" },
  { domains: ["lemonde.fr"], names: ["le monde"], originCountry: "France", originRegion: "Europe", factuality: "very-high" },
  { domains: ["spiegel.de"], names: ["der spiegel", "spiegel"], originCountry: "Germany", originRegion: "Europe", factuality: "very-high" },
  { domains: ["elpais.com"], names: ["el país", "el pais"], originCountry: "Spain", originRegion: "Europe", factuality: "very-high" },
  { domains: ["kyivpost.com"], names: ["kyiv post"], originCountry: "Ukraine", originRegion: "Europe", factuality: "mixed" },

  // --- Israel --------------------------------------------------------------
  { domains: ["ynetnews.com"], names: ["ynetnews", "ynet"], originCountry: "Israel", originRegion: "Middle East", factuality: "high" },
  { domains: ["israelhayom.com"], names: ["israel hayom"], originCountry: "Israel", originRegion: "Middle East", factuality: "mixed" },

  // --- Middle East (extended) ----------------------------------------------
  { domains: ["arabnews.com"], names: ["arab news"], originCountry: "Saudi Arabia", originRegion: "Middle East", factuality: "mixed" },
  { domains: ["gulfnews.com"], names: ["gulf news"], originCountry: "United Arab Emirates", originRegion: "Middle East", factuality: "high" },
  { domains: ["thenationalnews.com"], names: ["the national"], originCountry: "United Arab Emirates", originRegion: "Middle East", factuality: "high" },
  { domains: ["dailystar.com.lb"], names: ["the daily star", "daily star lebanon"], originCountry: "Lebanon", originRegion: "Middle East", factuality: "high" },
  { domains: ["jordantimes.com"], names: ["the jordan times", "jordan times"], originCountry: "Jordan", originRegion: "Middle East", factuality: "high" },

  // --- Asia ----------------------------------------------------------------
  { domains: ["yna.co.kr", "en.yna.co.kr"], names: ["yonhap", "yonhap news agency", "yonhap news"], originCountry: "South Korea", originRegion: "East Asia", factuality: "high" },
  { domains: ["taipeitimes.com"], names: ["taipei times"], originCountry: "Taiwan", originRegion: "East Asia", factuality: "high" },
  { domains: ["japantimes.co.jp"], names: ["the japan times", "japan times"], originCountry: "Japan", originRegion: "East Asia", factuality: "high" },
  { domains: ["thehindu.com"], names: ["the hindu"], originCountry: "India", originRegion: "South Asia", factuality: "very-high" },
  { domains: ["straitstimes.com"], names: ["the straits times", "straits times"], originCountry: "Singapore", originRegion: "Asia", factuality: "high" },
  { domains: ["abc.net.au"], names: ["abc news australia", "abc news (australia)", "abc australia", "abc (australia)"], originCountry: "Australia", originRegion: "Oceania", factuality: "high" },

  // --- China (state-controlled, extended) ----------------------------------
  { domains: ["chinadaily.com.cn"], names: ["china daily"], originCountry: "China", originRegion: "East Asia", factuality: "mixed" },
  { domains: ["en.people.cn", "people.cn"], names: ["people's daily", "peoples daily"], originCountry: "China", originRegion: "East Asia", factuality: "low" },
  { domains: ["chinamil.com.cn", "eng.chinamil.com.cn", "81.cn"], names: ["china military online", "pla daily", "china military"], originCountry: "China", originRegion: "East Asia", factuality: "low" },
  { domains: ["cgtn.com"], names: ["cgtn", "china global television network"], originCountry: "China", originRegion: "East Asia", factuality: "low" },

  // --- Iran (state-controlled, extended) -----------------------------------
  { domains: ["irna.ir", "en.irna.ir"], names: ["irna", "islamic republic news agency"], originCountry: "Iran", originRegion: "Middle East", factuality: "low" },
  { domains: ["farsnews.ir", "farsnews.com"], names: ["fars news", "fars news agency", "fars"], originCountry: "Iran", originRegion: "Middle East", factuality: "low" },
  { domains: ["tasnimnews.com"], names: ["tasnim news agency", "tasnim news", "tasnim"], originCountry: "Iran", originRegion: "Middle East", factuality: "low" },
  { domains: ["mehrnews.com", "en.mehrnews.com"], names: ["mehr news agency", "mehr news", "mehr"], originCountry: "Iran", originRegion: "Middle East", factuality: "low" },

  // --- Russia (extended) ---------------------------------------------------
  { domains: ["ria.ru"], names: ["ria novosti", "ria"], originCountry: "Russia", originRegion: "Europe", factuality: "low" },

  // --- Latin America (state-controlled) ------------------------------------
  { domains: ["plenglish.com", "prensa-latina.cu"], names: ["prensa latina", "prensa latina (pl)"], originCountry: "Cuba", originRegion: "Latin America", factuality: "low" },
  { domains: ["telesurenglish.net", "telesurtv.net"], names: ["telesur", "telesur english"], originCountry: "Venezuela", originRegion: "Latin America", factuality: "very-low" },

  // --- North Korea ---------------------------------------------------------
  { domains: ["kcna.kp", "kcnawatch.org"], names: ["kcna", "kcna watch", "korean central news agency"], originCountry: "North Korea", originRegion: "East Asia", factuality: "very-low" },
];
