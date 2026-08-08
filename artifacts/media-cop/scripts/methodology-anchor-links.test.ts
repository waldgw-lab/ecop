// Guards methodology deep-linking: every `?section=<slug>` referenced from the
// Curated page tooltips / info icons must resolve to a real `methodology-<slug>`
// anchor on the methodology page. A typo or a renamed slug would otherwise
// silently scroll to the top of the methodology page instead of the intended
// section, with no visible error. This check fails fast on that mismatch.
//
// Direction of the check:
//   - Forward (hard fail): every slug REFERENCED from Curated.tsx
//     (`section="<slug>"`) must be DEFINED in CuratedMethodology.tsx
//     (`slug: "<slug>"`, which renders an `id="methodology-<slug>"` anchor).
//   - Vice-versa (hard fail): every slug documented as externally referenced in
//     a `?section=<slug>` comment (in either file) must also be DEFINED. This
//     catches a rename on the methodology side that leaves the docs/anchor
//     pointing at a now-missing slug.
//   - Duplicate slug definitions are a hard fail (two sections sharing one
//     anchor id means deep-links land on the wrong one).
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CURATED = resolve(__dirname, "../client/src/pages/Curated.tsx");
const METHODOLOGY = resolve(__dirname, "../client/src/pages/CuratedMethodology.tsx");

const curatedSrc = readFileSync(CURATED, "utf8");
const methodologySrc = readFileSync(METHODOLOGY, "utf8");

function unique(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function matchAll(src: string, re: RegExp): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

// Slugs referenced from Curated.tsx via the `section="<slug>"` prop passed to
// SectionMethodologyTooltip / MethodologyInfoIcon (which build the deep-link).
const referencedFromCurated = unique(
  matchAll(curatedSrc, /\bsection="([a-z0-9-]+)"/g),
);

// Slugs documented as externally referenced via `?section=<slug>` comments in
// either file (the "keep this slug stable" notes next to each section).
const referencedInComments = unique([
  ...matchAll(curatedSrc, /\?section=([a-z0-9-]+)/g),
  ...matchAll(methodologySrc, /\?section=([a-z0-9-]+)/g),
]);

// Slugs DEFINED on the methodology page (each renders an `id` anchor).
const definedSlugsRaw = matchAll(methodologySrc, /\bslug:\s*"([a-z0-9-]+)"/g);
const definedSlugs = new Set(definedSlugsRaw);

let failed = 0;

function fail(msg: string) {
  failed++;
  console.error(`FAIL: ${msg}`);
}

// 1) Forward: referenced (from Curated props) -> defined.
for (const slug of referencedFromCurated) {
  if (!definedSlugs.has(slug)) {
    fail(
      `Curated.tsx references section="${slug}" but CuratedMethodology.tsx has ` +
        `no matching slug (anchor methodology-${slug}). Deep-link would scroll ` +
        `to the top instead of the section.`,
    );
  }
}

// 2) Vice-versa: every documented `?section=<slug>` must also resolve.
for (const slug of referencedInComments) {
  if (!definedSlugs.has(slug)) {
    fail(
      `A ?section=${slug} reference exists but CuratedMethodology.tsx has no ` +
        `matching slug (anchor methodology-${slug}).`,
    );
  }
}

// 3) Duplicate slug definitions collide on the same anchor id.
const seen = new Set<string>();
for (const slug of definedSlugsRaw) {
  if (seen.has(slug)) {
    fail(
      `CuratedMethodology.tsx defines slug "${slug}" more than once; two ` +
        `sections would share anchor id methodology-${slug}.`,
    );
  }
  seen.add(slug);
}

// Informational only (not a failure): methodology sections that no Curated
// tooltip deep-links into. Some intro sections are reached via the general
// "open methodology" button, so this is expected and must not fail the check.
const unreferenced = definedSlugsRaw.filter(
  (slug) => !referencedFromCurated.includes(slug),
);

console.log(
  `Methodology anchor-link check:\n` +
    `  defined slugs:            ${definedSlugsRaw.length}\n` +
    `  referenced from Curated:  ${referencedFromCurated.length} [${referencedFromCurated.join(", ")}]\n` +
    `  referenced in comments:   ${referencedInComments.length}\n` +
    `  not deep-linked (ok):     ${unreferenced.length}${
      unreferenced.length ? ` [${unreferenced.join(", ")}]` : ""
    }`,
);

if (failed > 0) {
  console.error(`\n${failed} methodology anchor-link check(s) failed.`);
  process.exit(1);
}

console.log("\nAll methodology deep-links resolve to a real section anchor.");
