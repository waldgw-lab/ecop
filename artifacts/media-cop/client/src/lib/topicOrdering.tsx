import { SelectGroup, SelectItem, SelectLabel } from "@/components/ui/select";

// Operational topics are always pinned to the top of every topic picker, in
// this exact order. They are not part of any region/theme group.
export const OPERATIONAL_TOPIC_NAMES = [
  "FLASH: TOP STORIES",
  "MOST RECENT",
  "CJCS MENTIONS",
  "MATA / OSINT SOCIAL MEDIA",
];

// Region/theme grouping for the remaining topics. Extend this in one place as
// new topics are added — anything not listed here falls into the "Other" group.
export const TOPIC_GROUPS: Array<{ label: string; topics: string[] }> = [
  { label: "Middle East", topics: ["Iran", "Israel", "Middle East"] },
  { label: "Europe & Eurasia", topics: ["Europe", "Russia / Ukraine", "Greenland", "Arctic"] },
  { label: "Asia-Pacific", topics: ["China", "India"] },
  { label: "Americas", topics: ["Domestic", "Mexico / South America", "Venezuela"] },
  { label: "Africa", topics: ["Africa"] },
];

export const OTHER_GROUP_LABEL = "Other";

const operationalIndex = new Map(
  OPERATIONAL_TOPIC_NAMES.map((n, i) => [n.toLowerCase(), i] as const),
);

const groupIndex = new Map<string, number>();
TOPIC_GROUPS.forEach((g, gi) => g.topics.forEach((t) => groupIndex.set(t.toLowerCase(), gi)));

function rankTopic(name: string): { tier: number; order: number } {
  const lower = (name || "").trim().toLowerCase();
  const op = operationalIndex.get(lower);
  if (op !== undefined) return { tier: 0, order: op };
  const gi = groupIndex.get(lower);
  if (gi !== undefined) return { tier: 1, order: gi };
  return { tier: 2, order: 0 };
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

/**
 * Sort topics into a stable, readable order: operational topics pinned on top
 * (fixed order), then region/theme groups (fixed order, A–Z within), then the
 * catch-all "Other" group A–Z.
 */
export function sortTopics<T extends { name: string }>(topics: T[]): T[] {
  return [...topics].sort((a, b) => {
    const ra = rankTopic(a.name);
    const rb = rankTopic(b.name);
    if (ra.tier !== rb.tier) return ra.tier - rb.tier;
    if (ra.tier === 0) return ra.order - rb.order; // operational: fixed order only
    if (ra.order !== rb.order) return ra.order - rb.order; // group order
    return byName(a, b); // A–Z within group / within Other
  });
}

export interface RenderTopicGroup<T> {
  key: string;
  label: string | null;
  topics: T[];
}

/**
 * Bucket topics into ordered render groups with optional headers. The
 * operational group has no header (it is just pinned on top).
 */
export function groupTopics<T extends { name: string }>(topics: T[]): RenderTopicGroup<T>[] {
  const operational: T[] = [];
  const buckets: T[][] = TOPIC_GROUPS.map(() => []);
  const other: T[] = [];

  for (const t of topics) {
    const r = rankTopic(t.name);
    if (r.tier === 0) operational.push(t);
    else if (r.tier === 1) buckets[r.order].push(t);
    else other.push(t);
  }

  operational.sort(
    (a, b) =>
      operationalIndex.get(a.name.trim().toLowerCase())! -
      operationalIndex.get(b.name.trim().toLowerCase())!,
  );

  const result: RenderTopicGroup<T>[] = [];
  if (operational.length) result.push({ key: "operational", label: null, topics: operational });
  TOPIC_GROUPS.forEach((g, gi) => {
    if (buckets[gi].length) {
      result.push({ key: g.label, label: g.label, topics: [...buckets[gi]].sort(byName) });
    }
  });
  if (other.length) {
    result.push({ key: "other", label: OTHER_GROUP_LABEL, topics: [...other].sort(byName) });
  }
  return result;
}

/**
 * Renders the grouped <SelectItem>s for a topic dropdown, with region/theme
 * group headers. Reused everywhere the Team page shows a topic picker so the
 * ordering stays consistent.
 */
export function TopicSelectItems<T extends { id: string; name: string }>({
  topics,
  testIdPrefix,
}: {
  topics: T[];
  testIdPrefix?: string;
}) {
  const groups = groupTopics(topics);
  return (
    <>
      {groups.map((group) => (
        <SelectGroup key={group.key}>
          {group.label && <SelectLabel>{group.label}</SelectLabel>}
          {group.topics.map((t) => (
            <SelectItem
              key={t.id}
              value={t.id}
              data-testid={testIdPrefix ? `${testIdPrefix}-${t.id}` : undefined}
            >
              {t.name}
            </SelectItem>
          ))}
        </SelectGroup>
      ))}
    </>
  );
}
