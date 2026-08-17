// =============================================================================
// Outlet Registry helpers — normalization + lookup.
//
// These are SHARED between server (seeding + lookup) and client (Curated view
// resolution) so a source string / domain is matched to a registry row the same
// way everywhere. The registry is a LABELING layer only; nothing here gates
// admission into any feed.
// =============================================================================
import type { OutletRegistry } from "./schema";

/**
 * Normalize an outlet display name into its canonical match key.
 * - lowercases
 * - strips channel suffixes like "(DM)", "(X)", "(Truth Social)"
 * - converts "&" to "and" so "Stars & Stripes" === "Stars and Stripes"
 * - collapses punctuation/whitespace to single spaces
 * - drops a leading "the " ("The Washington Post" === "Washington Post")
 */
export function normalizeOutletName(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw).toLowerCase().trim();
  s = s.replace(/\s*\((?:dm|x|twitter|truth social)\)\s*/g, " ");
  s = s.replace(/&/g, " and ");
  s = s.replace(/[^a-z0-9]+/g, " ").trim();
  s = s.replace(/\s+/g, " ");
  s = s.replace(/^the\s+/, "");
  return s.trim();
}

/**
 * Extract a registrable domain from a source string or URL. Returns null when
 * the input is a plain display name (no dot).
 */
export function extractOutletDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).trim().toLowerCase();
  if (s.includes("://")) {
    try {
      s = new URL(s).hostname;
    } catch {
      /* fall through to manual parse */
    }
  }
  s = s.split("/")[0].split("?")[0];
  if (!s.includes(".")) return null;
  s = s.replace(/^www\./, "");
  return s || null;
}

export interface OutletIndex {
  byKey: Map<string, OutletRegistry>;
  byDomain: Map<string, OutletRegistry>;
}

/** Build fast lookup maps from registry rows (name keys + domains). */
export function buildOutletIndex(rows: OutletRegistry[]): OutletIndex {
  const byKey = new Map<string, OutletRegistry>();
  const byDomain = new Map<string, OutletRegistry>();
  for (const row of rows) {
    const keys = [
      row.key,
      normalizeOutletName(row.canonicalName),
      ...((row.aliases ?? []).map(normalizeOutletName)),
    ];
    for (const k of keys) {
      if (k && !byKey.has(k)) byKey.set(k, row);
    }
    for (const d of row.domains ?? []) {
      const dom = extractOutletDomain(d) || d.toLowerCase().trim();
      if (dom && !byDomain.has(dom)) byDomain.set(dom, row);
    }
  }
  return { byKey, byDomain };
}

/**
 * Resolve a registry row from a source string (and optional URL). Tries the
 * normalized name first, then falls back to domain matching, progressively
 * stripping subdomain labels (feeds.apnews.com -> apnews.com).
 */
export function findOutlet(
  index: OutletIndex,
  source: string | null | undefined,
  url?: string | null,
): OutletRegistry | undefined {
  const nameKey = normalizeOutletName(source);
  if (nameKey && index.byKey.has(nameKey)) return index.byKey.get(nameKey);

  for (const candidate of [source, url]) {
    const dom = extractOutletDomain(candidate);
    if (!dom) continue;
    let d = dom;
    while (d.includes(".")) {
      if (index.byDomain.has(d)) return index.byDomain.get(d);
      d = d.slice(d.indexOf(".") + 1);
    }
  }
  return undefined;
}

// =============================================================================
// Behavior derivation — the curated-lane "trust engine".
//
// Every outlet resolves to ONE of three behavior classes (plus a hard Blocked
// state). This is the single source of truth, shared by ingest, clustering,
// synthesis and the oversight dialog so the same row always behaves identically
// everywhere. It is PURE (no DB, no IO) — feed it the outlet's labeling fields.
//
//   - CORROBORATING : trusted News that may inform corroborated facts, counts
//                     toward the >=2 story-formation gate, and is anchor-eligible.
//   - ANCHOR-ONLY   : may anchor / be the representative of a story ("X stated…")
//                     but NEVER touches the corroborated facts and carries NO
//                     formation weight. Two sub-labels:
//                       * primary  — official Social / Release (the origin of the
//                                    news itself), anchor-eligible as the headline.
//                       * contrast — adversary / low-factuality coverage shown
//                                    for contrast; never the headline.
//   - ATTACH        : may only JOIN an already-formed story; never anchors, never
//                     facts (video / podcast / unofficial social / opinion / …).
//
// CPC/SWL/EPC alignment forces ANCHOR-ONLY/contrast (the red section). Any
// other News/Social/Release with <= "mixed" factuality is demoted to ATTACH
// ("Additional coverage") — it never informs facts, but it is NOT shown in the
// contrast section, which is reserved for designated adversary state media.
// Blocked is a hard, everywhere exclusion handled by callers.
// =============================================================================

export const SOURCE_IDENTIFIERS = [
  "news-us-domestic",
  "news-international",
  "news-cpc",
  "social-us-official",
  "social-international",
  "social-cpc",
  "release-us-official",
  "release-international",
  "release-cpc",
  "other",
] as const;
export type SourceIdentifier = (typeof SOURCE_IDENTIFIERS)[number];

export const SOURCE_IDENTIFIER_LABELS: Record<SourceIdentifier, string> = {
  "news-us-domestic": "News — US domestic",
  "news-international": "News — international",
  "news-cpc": "News — CPC/SWL/EPC",
  "social-us-official": "Social — US official",
  "social-international": "Social — international",
  "social-cpc": "Social — CPC/SWL/EPC",
  "release-us-official": "Release — US official",
  "release-international": "Release — international",
  "release-cpc": "Release — CPC/SWL/EPC",
  other: "Other source",
};

export const OTHER_SOURCE_TYPES = [
  "video",
  "podcast",
  "social",
  "opinion",
  "tabloid",
  "magazine",
  "journal",
  "aggregator",
  "unknown",
] as const;
export type OtherSourceType = (typeof OTHER_SOURCE_TYPES)[number];

export const OTHER_SOURCE_TYPE_LABELS: Record<OtherSourceType, string> = {
  video: "Video",
  podcast: "Podcast",
  social: "Social (unofficial)",
  opinion: "Opinion / blog",
  tabloid: "Tabloid",
  magazine: "Magazine / Periodical",
  journal: "Journal Article",
  aggregator: "Aggregator / Syndication",
  unknown: "Unknown",
};

// The eight Ownership categories used for fact-diversity weighting + display.
export const OWNERSHIP_CATEGORIES = [
  "Independent",
  "Public broadcaster",
  "State-controlled",
  "Private / family",
  "Public company",
  "Conglomerate",
  "Nonprofit",
  "Government",
] as const;
export type OwnershipCategory = (typeof OWNERSHIP_CATEGORIES)[number];

export type BehaviorClass = "corroborating" | "anchor-only" | "attach";
export type BehaviorLabel = "primary" | "contrast" | null;
// Legacy role values persisted in curated_items.role / outlet_registry.role.
export type BehaviorRole = "contributing" | "anchor-only" | "attach-only";

export interface BehaviorInput {
  sourceIdentifier?: string | null;
  otherSourceType?: string | null;
  factuality?: string | null;
  blocked?: boolean | null;
  // Task #659 editor-feedback learning loop: a human-approved learned rule can
  // flip this outlet's whole behavior class, short-circuiting the normal
  // identifier-based derivation below. Sourced from
  // outletRegistry.manualOverrides.behaviorOverride — the SAME manual-override
  // mechanism every other labeling field already uses. null/undefined = no
  // override (normal derivation). Never overrides a `blocked` outlet.
  behaviorOverride?: "attach" | "corroborating" | null;
}

export interface BehaviorResult {
  cls: BehaviorClass;
  label: BehaviorLabel;
  role: BehaviorRole;
  blocked: boolean;
  reason: string;
}

// Factuality grades that force a News/Social/Release outlet down to contrast.
const LOW_FACTUALITY = new Set(["mixed", "low", "very-low"]);

export function behaviorRole(cls: BehaviorClass): BehaviorRole {
  if (cls === "corroborating") return "contributing";
  if (cls === "anchor-only") return "anchor-only";
  return "attach-only";
}

/**
 * The trust engine. Pure: maps an outlet's labeling fields to its behavior.
 */
export function deriveBehavior(o: BehaviorInput): BehaviorResult {
  if (o.blocked) {
    return {
      cls: "attach",
      label: null,
      role: "attach-only",
      blocked: true,
      reason: "Blocked — hard-excluded from every surface, including curated.",
    };
  }

  // Task #659: human-approved learned rule flips the whole behavior class,
  // bypassing the identifier-based derivation entirely. Never resurfaces a
  // `label` (primary/contrast) since a flip only ever targets the two
  // non-labeled classes (attach / corroborating).
  if (o.behaviorOverride === "attach") {
    return {
      cls: "attach",
      label: null,
      role: "attach-only",
      blocked: false,
      reason: "Learned rule override — flipped to attach-only from repeated editor hides.",
    };
  }
  if (o.behaviorOverride === "corroborating") {
    return {
      cls: "corroborating",
      label: null,
      role: "contributing",
      blocked: false,
      reason: "Learned rule override — flipped to corroborating from repeated editor confirmations.",
    };
  }

  // Fail-closed: an unrecognized / malformed identifier is treated as "other"
  // (attach), never silently promoted to a primary anchor.
  const rawId = o.sourceIdentifier || "other";
  const id = (SOURCE_IDENTIFIERS as readonly string[]).includes(rawId)
    ? (rawId as SourceIdentifier)
    : ("other" as SourceIdentifier);

  if (id === "other") {
    const t = (o.otherSourceType || "unknown") as OtherSourceType;
    // Aggregators get a self-explanatory reason: they redistribute other
    // publishers' work, so their presence as attach-only fallbacks is by
    // design, not a misconfiguration (Task: aggregator labeling).
    if (t === "aggregator") {
      return {
        cls: "attach",
        label: null,
        role: "attach-only",
        blocked: false,
        reason:
          "Aggregator — redistributes other publishers' work; may join a story but never anchors or informs facts.",
      };
    }
    return {
      cls: "attach",
      label: null,
      role: "attach-only",
      blocked: false,
      reason: `Other source (${OTHER_SOURCE_TYPE_LABELS[t] ?? t}) — may join a story but never anchors or informs facts.`,
    };
  }

  const family = id.split("-")[0]; // news | social | release
  const isCpc = id.endsWith("-cpc");
  const factuality = (o.factuality || "").toLowerCase();
  const lowFactuality = LOW_FACTUALITY.has(factuality);

  // Master switch: CPC alignment OR mixed/low factuality => contrast.
  if (isCpc) {
    return {
      cls: "anchor-only",
      label: "contrast",
      role: "anchor-only",
      blocked: false,
      reason: "CPC/SWL/EPC designation — shown for contrast; never informs facts.",
    };
  }
  // Low factuality WITHOUT CPC/SWL/EPC designation => attach-only ("Additional
  // coverage"). Editorial rule: the red contrast section is reserved for
  // designated adversary state media; grouping ordinary low-factuality outlets
  // there would wrongly imply they are adversary-controlled. They still never
  // anchor, never inform facts, and carry no formation weight.
  if (lowFactuality) {
    return {
      cls: "attach",
      label: null,
      role: "attach-only",
      blocked: false,
      reason: `Factuality "${o.factuality}" — may join a story as additional coverage but never anchors or informs facts.`,
    };
  }

  if (family === "news") {
    return {
      cls: "corroborating",
      label: null,
      role: "contributing",
      blocked: false,
      reason: "Trusted news — informs corroborated facts and counts toward story formation.",
    };
  }

  // Social media (POTUS Truth Social / official-account X / any official social)
  // => attach-only. Product rule: a social media post may NEVER stand alone in
  // Top Stories and may never supply a story's media. It rides along inside a
  // story ONLY by attaching to a cluster of >=2 OTHER trusted (corroborating)
  // sources; it carries no formation weight, never anchors, never informs facts,
  // and is never the representative (so its image — or lack of one — can't become
  // the cluster's face). Handled identically for US-official and international
  // social below; only official Releases stay primary anchors.
  if (family === "social") {
    return {
      cls: "attach",
      label: null,
      role: "attach-only",
      blocked: false,
      reason:
        "Official social — a social media post; may join a story of >=2 trusted sources but never stands alone, anchors, or supplies media.",
    };
  }

  // Official Release with acceptable factuality => primary anchor: may anchor a
  // story but never informs facts or counts toward formation.
  return {
    cls: "anchor-only",
    label: "primary",
    role: "anchor-only",
    blocked: false,
    reason:
      "Official release — the origin of the news; may anchor a story but never informs facts.",
  };
}

// The designated adversary states whose state media is quarantined to the
// curated lane (and the public /api/v1/state-media lane). Venezuela (teleSUR)
// is intentionally excluded by omission. Ordering drives the default lens order.
// Typed as string[] so `.includes(someString)` works without a literal-union cast.
export const ADVERSARY_COUNTRIES: string[] = [
  "Russia",
  "China",
  "Iran",
  "Cuba",
  "North Korea",
];

/**
 * Normalize an adversary origin-country name into its stable lowercase token
 * (e.g. "North Korea" -> "north-korea"). Used as the public-API country marker
 * and the value accepted by the `country` filter param.
 */
export function adversaryCountryToken(country: string): string {
  return country.trim().toLowerCase().replace(/\s+/g, "-");
}

/** Convenience wrapper that reads the fields straight off a registry row. */
export function deriveOutletBehavior(
  row: Pick<OutletRegistry, "factuality"> & {
    sourceIdentifier?: string | null;
    otherSourceType?: string | null;
    blocked?: boolean | null;
    manualOverrides?: Record<string, unknown> | null;
  },
): BehaviorResult {
  const rawOverride = (row as any).manualOverrides?.behaviorOverride;
  const behaviorOverride =
    rawOverride === "attach" || rawOverride === "corroborating" ? rawOverride : null;
  return deriveBehavior({
    sourceIdentifier: (row as any).sourceIdentifier ?? null,
    otherSourceType: (row as any).otherSourceType ?? null,
    factuality: row.factuality ?? null,
    blocked: (row as any).blocked ?? false,
    behaviorOverride,
  });
}

// Is this outlet a social-media / flash post source (X / Truth Social /
// DataMinr)? These are the rows the curated card shows as the post itself —
// never a forced 3-bullet AI summary. Social handles resolve to a `social-*`
// sourceIdentifier; DataMinr resolves to sourceIdentifier `other` with
// otherSourceType `social`. Single source of truth shared by the cluster
// engine, the enrichment worker, and the boot-time heal so they can never
// drift on what counts as "social".
export function isSocialFlashOutlet(
  outlet: { sourceIdentifier?: string | null; otherSourceType?: string | null } | null | undefined,
): boolean {
  const sid = outlet?.sourceIdentifier;
  if (typeof sid === 'string' && sid.startsWith('social-')) return true;
  return sid === 'other' && outlet?.otherSourceType === 'social';
}

