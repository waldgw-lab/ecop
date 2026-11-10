// This mirrored product is financial-only. Legacy military tables remain untouched.
export const FINANCIAL_MODE = true;
export const REFRESH_MS = 5 * 60_000;
export const FINANCE_SOURCES = [
  { id: "fed", name: "Federal Reserve", owner: "Federal Reserve", kind: "official" as const, url: "https://www.federalreserve.gov/feeds/press_all.xml" },
  { id: "ecb", name: "European Central Bank", owner: "ECB", kind: "official" as const, url: "https://www.ecb.europa.eu/rss/press.html" },
  { id: "eia", name: "U.S. Energy Information Administration", owner: "U.S. EIA", kind: "official" as const, url: "https://www.eia.gov/rss/press_rss.xml" },
  { id: "cnbc", name: "CNBC Economy", owner: "NBCUniversal", kind: "reporting" as const, url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258" },
  { id: "bloomberg", name: "Bloomberg Economics", owner: "Bloomberg", kind: "reporting" as const, url: "https://feeds.bloomberg.com/economics/news.rss" },
  { id: "ft", name: "Financial Times", owner: "Nikkei", kind: "reporting" as const, url: "https://www.ft.com/world?format=rss" },
  { id: "bbc", name: "BBC Business", owner: "BBC", kind: "reporting" as const, url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
  { id: "guardian", name: "Guardian Business", owner: "Guardian Media Group", kind: "reporting" as const, url: "https://www.theguardian.com/business/rss" },
];
