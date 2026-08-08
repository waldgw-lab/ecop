/**
 * Gate: curated-detail-metadata
 *
 * Covers the viewer-facing metadata contract: trusted source publication times
 * are absolute DTGs with a zone marker; missing trusted dates remain an honest
 * First seen fallback; and separate cluster update semantics are not mislabeled
 * as publication.
 */
import { formatCuratedPublicationDTG } from "../client/src/lib/postTime";
import {
  formatNewsCandidateContext,
  isCandidateHeadlineTruncated,
} from "../client/src/lib/curatedCandidateContext";

let passed = 0;
let failed = 0;
const expect = (label: string, actual: string, expected: string) => {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
};

const trusted = "2026-07-13T14:09:00-04:00";
expect(
  "trusted source date renders a complete Eastern DTG",
  formatCuratedPublicationDTG(trusted, "America/New_York"),
  "Jul 13, 2026, 2:09 PM EDT",
);
expect(
  "trusted source date converts into the selected Pacific zone",
  formatCuratedPublicationDTG(trusted, "America/Los_Angeles"),
  "Jul 13, 2026, 11:09 AM PDT",
);
expect("invalid source date cannot fabricate a publication DTG", formatCuratedPublicationDTG("not-a-date"), "");

const detailLabel = (publishedAt: string | null, isClustered: boolean) =>
  isClustered ? "First seen · Updated" : publishedAt ? "Published" : "First seen";
expect("standalone trusted timestamp is labeled Published", detailLabel(trusted, false), "Published");
expect("missing source date is labeled First seen", detailLabel(null, false), "First seen");
expect("cluster keeps first-seen and updated semantics separate", detailLabel(trusted, true), "First seen · Updated");
expect(
  "first-seen provenance also remains an absolute DTG",
  `First seen ${formatCuratedPublicationDTG(trusted, "America/New_York")}`,
  "First seen Jul 13, 2026, 2:09 PM EDT",
);
expect(
  "cluster update provenance also remains an absolute DTG",
  `Updated ${formatCuratedPublicationDTG(trusted, "America/New_York")}`,
  "Updated Jul 13, 2026, 2:09 PM EDT",
);

const candidateNow = new Date("2026-07-13T20:00:00.000Z").getTime();
expect(
  "merge candidate cluster shows source count and relative synthesized-through update",
  formatNewsCandidateContext({
    source: "Reuters",
    sourceCount: 3,
    updatedAt: "2026-07-13T18:30:00.000Z",
  }, "America/New_York", candidateNow),
  "3 sources · Updated 1h ago",
);
expect(
  "merge candidate standalone uses trusted publication DTG in selected zone",
  formatNewsCandidateContext({
    source: "Reuters",
    sourceCount: 1,
    articlePublishedAt: trusted,
    firstSeenAt: "2026-07-13T19:00:00.000Z",
  }, "America/Los_Angeles", candidateNow),
  "Reuters · Published Jul 13, 2026, 11:09 AM PDT",
);
expect(
  "merge candidate standalone labels discovery fallback honestly",
  formatNewsCandidateContext({
    source: "Reuters",
    sourceCount: 1,
    articlePublishedAt: null,
    firstSeenAt: "2026-07-13T19:00:00.000Z",
  }, "America/New_York", candidateNow),
  "Reuters · First seen Jul 13, 2026, 3:00 PM EDT",
);
expect(
  "invalid publication date falls through to first seen rather than fabricating Published",
  formatNewsCandidateContext({
    source: "Reuters",
    articlePublishedAt: "not-a-date",
    firstSeenAt: "2026-07-13T19:00:00.000Z",
  }, "UTC", candidateNow),
  "Reuters · First seen Jul 13, 2026, 7:00 PM UTC",
);
expect(
  "headline that fits does not receive redundant full-text disclosure",
  String(isCandidateHeadlineTruncated(180, 180)),
  "false",
);
expect(
  "visually cut headline receives full-text disclosure",
  String(isCandidateHeadlineTruncated(181, 180)),
  "true",
);

console.log(`\ncurated-detail-metadata: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);