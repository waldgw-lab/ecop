import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

// Curated-view ONLY. A short, plain-language explainer of what the Curated view
// shows and what its terms mean. Reachable from the Curated page footer link AND
// from the per-section info (i) icons / section-header tooltips inside the
// Curated page, which deep-link to a named section via ?section=<slug>. No data
// fetching, no shared-feed deps.
//
// Layout mirrors the editable methodology deck (MCOP Version 3.0): the
// conceptual sections sit in the left column; the per-feature explainers (the
// ones surfaced as on-page tooltips) are grouped under "Features" on the right.

interface Section {
  // Stable anchor used for deep-linking from the Curated tooltips / info icons
  // (?section=<slug>). Keep these slugs stable — Curated.tsx references them.
  slug: string;
  title: string;
  body: React.ReactNode;
}

// Left column — the conceptual walkthrough.
const MAIN_SECTIONS: Section[] = [
  {
    slug: "what-youre-looking-at",
    title: "What you're looking at",
    body: (
      <p>
        The Curated view is a single, scannable picture of the defense and
        national-security news that matters right now. Instead of a raw firehose,
        it groups coverage into <span className="font-medium text-foreground">stories</span>{" "}
        and ranks them so the most important items sit at the top.
      </p>
    ),
  },
  {
    slug: "top-stories-and-ranking",
    title: "Top stories and ranking",
    body: (
      <>
        <p>
          Stories are ordered by a mix of how important and how fresh they are.
          As a story ages, it gradually settles down the list, letting newer
          developments rise. Top stories can show two kinds of items:{" "}
          <span className="font-medium text-foreground">Single-source items</span>{" "}
          and <span className="font-medium text-foreground">Clustered stories</span>.
        </p>
        <p className="mt-2">
          <span className="font-medium text-foreground">Single-source items</span>{" "}
          are individual media content items — articles, videos, or podcasts —
          that arrive timely, high-priority, or operationally relevant. These are
          shown as single reports until enough trusted coverage exists to form a
          story.
        </p>
        <p className="mt-2">
          <span className="font-medium text-foreground">Clustered stories</span>{" "}
          are formed when multiple trusted reporting sources cover the same event.
          MCOP pulls those reports into one card so you can see the event, the
          shared facts, and the range of coverage without reading ten
          near-duplicate headlines.
        </p>
      </>
    ),
  },
  {
    // Slug kept stable: the story-popup "Corroborated Facts" / "Attributed
    // Claims" info icons deep-link here via ?section=how-a-story-is-built.
    slug: "how-a-story-is-built",
    title: "How a \u201cclustered story\u201d is built",
    body: (
      <>
        <p>
          A clustered story forms when the same event is reported by{" "}
          <span className="font-medium text-foreground">two or more trusted outlets</span>.
          We pull those reports together into one card so you can see the whole
          event at a glance rather than ten near-duplicate headlines.
        </p>
        <p className="mt-2">
          The cluster's headline and short summary on each card are written to be
          neutral — a plain description of what happened, drawn from across all
          the sources that covered it.
        </p>
      </>
    ),
  },
  {
    // Slug kept stable: the story-popup "Contributing Sources" / "Flagged
    // Sources" info icons deep-link here via
    // ?section=contributing-vs-attached-sources.
    slug: "contributing-vs-attached-sources",
    title: "Source Types (Contributing vs Attached)",
    body: (
      <>
        <p>
          A clustered story shows how individual sources{" "}
          <span className="font-medium text-foreground">framed</span> the event,
          so you can see the spread of coverage — not just a single take. Every
          source on a story is one of two types, which determines how much weight
          it carries.
        </p>
        <p className="mt-2">
          <span className="font-medium text-foreground">Contributing</span> sources
          are the trusted, reporting outlets that allow a legitimate story to form
          in the first place. They rate consistently for high or very-high
          factuality across published media-assessment references — Media
          Bias/Fact Check and Ad Fontes Media — confirmed by MCOP's own editorial
          review, and they are genuine reporting outlets rather than opinion
          shops, social accounts, or state-controlled media.
        </p>
        <p className="mt-2">
          Different outlets often describe the same facts in different ways.
          Sources with mixed or lower factuality, biased or state ownership, or
          opinion and social formats can still appear on a story —{" "}
          <span className="font-medium text-foreground">attached</span>, for
          context and contrast — but they never alter the corroborated facts and
          never form a cluster on their own.
        </p>
        <p className="mt-2">
          For less-established or state-controlled outlets, the story also
          estimates how much of that source's coverage{" "}
          <span className="font-medium text-foreground">lines up with the
          corroborated reporting</span>, shown as a rough percentage, and points
          out where it diverges — added spin, one-sided emphasis, or details it
          leaves out. The percentage is an overall read of the source's framing,
          not a simple count of points, so a lower number flags coverage that
          pulls away from what the trusted sources agree on.
        </p>
        <p className="mt-2">
          <span className="font-medium text-foreground">Attached</span> sources can
          join an existing story to add context, but they can never create one on
          their own. These may include opinion pieces, social posts, videos,
          Dataminr alerts, official statements, less-established outlets, or other
          material that adds context, attribution, early warning, visual evidence,
          or framing.
        </p>
        <p className="mt-2">
          Official releases and statements are a special case — as the origin
          point of the news they can{" "}
          <span className="font-medium text-foreground">anchor</span> a story, but
          like other attached sources they never inform the corroborated facts.
        </p>
      </>
    ),
  },
  {
    slug: "content-metadata",
    title: "Content metadata (Topic \u00b7 Focus \u00b7 Time \u00b7 Source Count)",
    body: (
      <>
        <p>
          Just above each story's headline is a single line of small print that packs
          several facts together, separated by dots — for example:
        </p>
        <div className="mt-2 font-mono text-xs">
          <span className="text-[#5FA8C4]">Military Ops</span>
          <span className="text-muted-foreground"> · Indo-Pacific · 2h ago · 4 sources</span>
        </div>
        <p className="mt-2">
          The first two parts are the story's{" "}
          <span className="font-medium text-foreground">Topic · Focus</span>: a
          high-level Topic for what kind of story it is, and a Focus for which part of
          the world it affects. The rest of the line shows where the story came from —
          the outlet for a single report, or how many sources back a multi-source
          story — and when it was published or last updated.
        </p>
        <div className="mt-2">
          The <span className="font-medium text-foreground">Topic</span> comes first —
          for example <span className="font-mono text-foreground">Military Ops</span> —
          and tags the story by subject. Topics are drawn from a fixed list of about
          twenty high-level subjects, so the same kind of story is always labeled the
          same way and the list stays short enough to scan for what you care about.
          There is one catch-all,{" "}
          <span className="font-mono text-foreground">Other / Emerging</span>, kept
          deliberately small for genuinely new subjects that none of the real buckets
          fit — the system actively avoids parking a story there when a proper subject
          bucket applies.
        </div>
        <div className="mt-2">
          A Topic describes a story's <span className="font-medium text-foreground">subject,
          not its importance</span>. A story gets its true subject even if it scored low
          or wasn't judged strategically relevant — a public-health, natural-disaster,
          severe-weather, or environmental story is tagged{" "}
          <span className="font-mono text-foreground">Disaster &amp; Health</span>{" "}
          rather than dropped into the catch-all just because it sits lower in the feed.
        </div>
        <div className="mt-2">
          How the Topic is set depends on where the story came from. For stories the
          team submits, a person picks the Topic from the same fixed list. For
          everything else the AI assigns it from that list, with a safety net that
          re-routes an over-vague label to the right bucket when the subject clearly
          matches one. A Topic is set{" "}
          <span className="font-medium text-foreground">once</span>, and a person's
          choice is never overwritten.
        </div>
        <div className="mt-2">
          The <span className="font-medium text-foreground">Focus</span> follows the
          Topic — a region such as{" "}
          <span className="font-mono text-foreground">Indo-Pacific</span>, a country
          such as <span className="font-mono text-foreground">Taiwan</span>, or
          sometimes a two-country pair. It marks where the story's{" "}
          <span className="font-medium text-foreground">impact</span> lands: what
          actually happened and where, not where the outlet that reported it is based.
          The Focus is always worked out automatically from the article's content.
        </div>
        <div className="mt-2">
          Elsewhere on the page, a{" "}
          <span className="font-medium text-foreground">Blind spot</span> tag
          appears when a story the wider press is covering heavily is missing from our
          feed. It is flagged rather than hidden, so nothing important slips by
          unnoticed.
        </div>
      </>
    ),
  },
];

// Right column — the per-feature explainers surfaced as on-page tooltips.
const FEATURE_SECTIONS: Section[] = [
  {
    // Slug referenced by the IE Highlights pane header tooltip in Curated.tsx
    // via ?section=ie-highlights. Keep it stable.
    slug: "ie-highlights",
    title: "IE Highlights",
    body: (
      <>
        <p>
          <span className="font-medium text-foreground">IE</span> stands for{" "}
          <span className="font-medium text-foreground">Information Environment</span>{" "}
          — a recurring summary of the biggest narratives shaping defense and
          national-security news, drawn from the latest news scrub.
        </p>
        <p className="mt-2">
          The Morning and Evening News Scrubs are a twice-daily media-analysis
          product, produced Monday through Friday at roughly 6:30 AM and 5:00 PM
          ET (times vary). On Saturdays only the morning scrub is produced, and on
          Sundays only the evening scrub.
        </p>
      </>
    ),
  },
  {
    // Slug referenced by the MCOP Highlights pane header tooltip in Curated.tsx
    // via ?section=mcop-highlights. Keep it stable.
    slug: "mcop-highlights",
    title: "MCOP Highlights",
    body: (
      <p>
        These are the top and emerging stories currently surfaced from across
        MCOP's own coverage, split into{" "}
        <span className="font-medium text-foreground">U.S. Domestic</span> and{" "}
        <span className="font-medium text-foreground">International</span>{" "}
        buckets by media ecosystem — what is most prominent in the U.S.
        mainstream press vs. the international mainstream press (state-media
        contrast sources are never included).
      </p>
    ),
  },
  {
    // Slug referenced by the Aerial View section header tooltip in Curated.tsx
    // via ?section=aerial-view. Keep it stable.
    slug: "aerial-view",
    title: "Aerial View",
    body: (
      <p>
        The stories the wider press is covering most right now — independent of
        MCOP ranking. Anything not already in your feed is tagged a{" "}
        <span className="text-[#5FA8C4]">blind spot</span>.
      </p>
    ),
  },
  {
    // Slug referenced by the Custom Feed section header info icon in Curated.tsx
    // via ?section=custom-feed. Keep it stable.
    slug: "custom-feed",
    title: "Custom Feed",
    body: (
      <>
        <p>
          Custom Feed lets you build your own filtered view of the same curated
          stories. You can narrow what you see by{" "}
          <span className="font-medium text-foreground">topic</span>,{" "}
          <span className="font-medium text-foreground">region or country</span>,{" "}
          <span className="font-medium text-foreground">time window</span>,{" "}
          <span className="font-medium text-foreground">source type</span>, and{" "}
          <span className="font-medium text-foreground">keywords</span>.
        </p>
        <p className="mt-2">
          It is a filter, not a different feed. It only narrows the stories that
          are already in the Curated view — it does{" "}
          <span className="font-medium text-foreground">not</span> change how
          stories are ranked or clustered, and it does not affect any other
          section on the page.
        </p>
        <p className="mt-2">
          When you're signed in with Replit, your saved views, keywords, and
          Curated layout settings are saved to your account and follow you
          across devices and browsers. Password-only visitors keep their
          settings on the current browser only.
        </p>
      </>
    ),
  },
  {
    // Slug referenced by the State Controlled Narratives rotating-column header
    // info icon in Curated.tsx via ?section=state-controlled-narratives. Keep it
    // stable.
    slug: "state-controlled-narratives",
    title: "State Controlled Narratives",
    body: (
      <>
        <p>
          This section shows coverage from{" "}
          <span className="font-medium text-foreground">state-controlled
          outlets</span>, grouped by the country behind them. It rotates
          through one country at a time so you can scan how each is framing events.
        </p>
        <p className="mt-2">
          These outlets are{" "}
          <span className="font-medium text-foreground">flagged, attached
          sources</span>. They can join an existing story to show how it is being
          spun, but they never form a story on their own.
        </p>
        <p className="mt-2">
          The <span className="font-medium text-foreground">Topic and Focus</span>{" "}
          shown for each item describe the{" "}
          <span className="font-medium text-foreground">story's content</span> —
          what happened and where it lands — not the nationality of the outlet
          that reported it.
        </p>
      </>
    ),
  },
  {
    // Slug referenced by Truth Social section-heading tooltip in Curated.tsx
    // via ?section=truth-social. Keep it stable.
    slug: "truth-social",
    title: "Truth Social",
    body: (
      <>
        <p>
          Posts from Truth Social, a social-media platform used by U.S.
          political figures including the President. It is a primary channel for
          official statements and policy signals.
        </p>
        <p className="mt-2">
          These posts are shown for situational awareness and are{" "}
          <span className="font-medium text-foreground">not fact-checked news</span>.
          They appear as{" "}
          <span className="font-medium text-foreground">attached sources</span> —
          they can join an existing story for context, but they never form a
          story on their own or alter corroborated facts.
        </p>
      </>
    ),
  },
  {
    // Slug referenced by U.S. X Feed, OSINT X Feed, and Press X Feed
    // section-heading tooltips in Curated.tsx via ?section=x-feed. Keep it stable.
    slug: "x-feed",
    title: "X Feeds (U.S. · OSINT · Press)",
    body: (
      <>
        <p>
          Three curated X (formerly Twitter) feeds from distinct vantage points:
        </p>
        <p className="mt-2">
          <span className="font-medium text-foreground">U.S. X Feed</span> —
          posts from U.S. officials, senior military leaders, and key
          national-security figures. A direct window into official statements and
          policy positions as they are made.
        </p>
        <p className="mt-2">
          <span className="font-medium text-foreground">OSINT X Feed</span> —
          posts from open-source intelligence analysts, defense-focused military
          accounts, and combatant commands. Early signals, imagery, and
          situational awareness that often precede formal reporting.
        </p>
        <p className="mt-2">
          <span className="font-medium text-foreground">Press X Feed</span> —
          posts from defense and national-security journalists and correspondents.
          Reporter-level alerts, breaking coverage, and story leads.
        </p>
        <p className="mt-2">
          All three feeds are curated and{" "}
          <span className="font-medium text-foreground">not fact-checked</span>.
          They surface as attached sources and never form clustered stories on
          their own.
        </p>
      </>
    ),
  },
  {
    // Slug referenced by the DATAMINR section-heading tooltip in Curated.tsx
    // via ?section=dataminr. Keep it stable.
    slug: "dataminr",
    title: "DATAMINR First Alert",
    body: (
      <>
        <p>
          DataMinr First Alert is a commercial AI-powered early-warning service
          that surfaces breaking events from open data — social media, public
          sensors, and other real-time signals — often{" "}
          <span className="font-medium text-foreground">before traditional
          news outlets publish</span>.
        </p>
        <p className="mt-2">
          Alerts are shown as{" "}
          <span className="font-medium text-foreground">attached context</span>.
          They can join an existing story for added early-warning detail, but
          they never form a clustered story on their own and never alter
          corroborated facts.
        </p>
      </>
    ),
  },
];

function SectionBlock({
  section,
  highlight,
}: {
  section: Section;
  highlight: boolean;
}) {
  return (
    <section
      id={`methodology-${section.slug}`}
      className="scroll-mt-6"
      data-testid={`section-methodology-${section.slug}`}
    >
      <h3
        className={`inline-block text-sm font-bold text-foreground${
          highlight ? " methodology-highlight" : ""
        }`}
      >
        {section.title}
      </h3>
      <div className="mt-1.5 text-sm text-muted-foreground leading-relaxed">
        {section.body}
      </div>
    </section>
  );
}

export default function CuratedMethodology() {
  // Deep-link target from the Curated tooltips / info icons (?section=<slug>).
  // Scroll the matching section into view once mounted AND briefly flash its
  // heading so the reader's eye lands on the right place. Read straight off the
  // URL search (wouter's useLocation drops the query string), SSR-guarded.
  const [highlightSlug, setHighlightSlug] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const slug = new URLSearchParams(window.location.search).get("section");
    if (!slug) return;
    const el = document.getElementById(`methodology-${slug}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    // Flash the heading once the smooth scroll has begun so it's in view.
    const start = setTimeout(() => setHighlightSlug(slug), 350);

    // Keep the heading highlighted until the reader scrolls or interacts with the
    // page. Attach the dismiss listeners only after the programmatic smooth-scroll
    // has settled, otherwise the scroll IT triggers would clear it immediately.
    let dismiss = () => {};
    const attach = setTimeout(() => {
      dismiss = () => {
        setHighlightSlug(null);
        window.removeEventListener("wheel", dismiss);
        window.removeEventListener("touchmove", dismiss);
        window.removeEventListener("scroll", dismiss);
        window.removeEventListener("keydown", dismiss);
        window.removeEventListener("pointerdown", dismiss);
      };
      window.addEventListener("wheel", dismiss, { passive: true });
      window.addEventListener("touchmove", dismiss, { passive: true });
      window.addEventListener("scroll", dismiss, { passive: true });
      window.addEventListener("keydown", dismiss);
      window.addEventListener("pointerdown", dismiss);
    }, 1200);

    return () => {
      clearTimeout(start);
      clearTimeout(attach);
      dismiss();
    };
  }, []);

  return (
    <div className="dark fixed inset-0 z-50 overflow-y-auto text-foreground bg-background/80 backdrop-blur-md">
      <div className="max-w-6xl px-6 md:px-12 lg:px-20 py-6">
        {/* Return / back button — top-left. */}
        <div className="mb-5">
          <Link href="/curated">
            <Button variant="ghost" size="sm" className="gap-2" data-testid="button-back-curated">
              <ArrowLeft className="h-4 w-4" />
              Back to Curated
            </Button>
          </Link>
        </div>

        <header className="mb-8 border-b border-border pb-4">
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-methodology-title">
            Methodology — <span className="text-[#5FA8C4]">MCOP Version 3.0: Curated View</span>
          </h1>
        </header>

        {/* Two-column conceptual layout: walkthrough on the left, the per-feature
            explainers (mirrored from the on-page tooltips) grouped under
            "Features" on the right. Collapses to a single column on small
            screens. */}
        <div className="grid grid-cols-1 lg:grid-cols-[1.7fr_1fr] gap-x-12 gap-y-10">
          <div className="space-y-7">
            {MAIN_SECTIONS.map((s) => (
              <SectionBlock key={s.slug} section={s} highlight={highlightSlug === s.slug} />
            ))}
          </div>

          <div className="space-y-7">
            <h2 className="text-base font-bold text-[#5FA8C4]" data-testid="text-methodology-features">
              Features
            </h2>
            {FEATURE_SECTIONS.map((s) => (
              <SectionBlock key={s.slug} section={s} highlight={highlightSlug === s.slug} />
            ))}
          </div>
        </div>

        <p className="text-xs text-muted-foreground mt-12 text-center">
          This guide is a general overview and may be updated as the view evolves.
        </p>
      </div>
    </div>
  );
}
