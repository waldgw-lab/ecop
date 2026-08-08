// Curated lane — editor-feedback LEARNING LOOP (Task #659) enforcement cache.
//
// Three of the four learned-rule types are "self-enforcing": an approved row
// in `curated_learned_rules` IS the live overlay — there is no separate write
// into another table. Enforcement call sites consult this short-TTL in-memory
// cache instead of hitting the DB on every hot-path call. The fourth type
// (outlet-behavior-flip) performs a REAL write into outlet_registry via
// setOutletManualOverride and is NOT looked up here.
//
// CURATED-ONLY, fail-closed: any read error returns empty maps (treated as
// "no learned rule applies"), never throws into a hot path.
import { storage } from "./storage";
import type { CuratedLearnedRule } from "@shared/schema";
import { normalizeOutletName } from "@shared/outletRegistry";
import { CURATED_SOFT_CAP } from "./scoreAdjustments";

const TTL_MS = 30_000;

export interface ClassificationRelabelPayload {
  outlet: string;
  fromTopic: string;
  toTopic: string;
}
export interface MustLinkPayload {
  outletA: string;
  outletB: string;
}
export interface IrrelevanceSuppressionPayload {
  outlet: string;
  category: string;
}
export interface ScoringCapPayload {
  outlet: string;
  category: string;
  cap: number;
}

export interface LearnedRuleConflict {
  kind: 'classification-relabel' | 'scoring-cap';
  scope: string;
  winnerId: string;
  competingIds: string[];
}

export interface LearnedRulesSnapshot {
  // key: `${outlet}::${fromTopic}` (both lowercased/trimmed) -> target topic
  classificationRelabels: Map<string, string>;
  // key: sorted `${outletA}::${outletB}` (lowercased/trimmed)
  mustLinkPairs: Set<string>;
  // key: `${outlet}::${category}` (both lowercased/trimmed)
  irrelevanceSuppressions: Set<string>;
  // key: `${outlet}::${category}` (both lowercased/trimmed) -> cap ceiling
  // (Task #678 — DOWN-only, cap-only curated scoring cap).
  scoringCaps: Map<string, number>;
  // Observation-only diagnostics for the review UI/API.
  conflicts: LearnedRuleConflict[];
  fetchedAt: number;
}

let cache: LearnedRulesSnapshot | null = null;
let inFlight: Promise<LearnedRulesSnapshot> | null = null;

function norm(s: string | undefined | null): string {
  return normalizeOutletName(s);
}

function mustLinkKey(a: string, b: string): string {
  const [x, y] = [norm(a), norm(b)].sort();
  return `${x}::${y}`;
}

function buildEmptySnapshot(): LearnedRulesSnapshot {
  return {
    classificationRelabels: new Map(),
    mustLinkPairs: new Set(),
    irrelevanceSuppressions: new Set(),
    scoringCaps: new Map(),
    conflicts: [],
    fetchedAt: Date.now(),
  };
}

export function buildLearnedRulesSnapshot(rows: CuratedLearnedRule[]): LearnedRulesSnapshot {
  const snap = buildEmptySnapshot();
  // Make a conflict winner intentional, stable, and reviewable rather than
  // depending on storage-return ordering.
  const rowsInPrecedenceOrder = rows.filter(r => r.status === 'approved').sort((a, b) => {
    const updated = new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime();
    return updated || String(a.id).localeCompare(String(b.id)) || a.signature.localeCompare(b.signature);
  });
  const relabelOwners = new Map<string, string>();
  const capOwners = new Map<string, string>();
  for (const row of rowsInPrecedenceOrder) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    try {
      if (row.ruleType === 'classification-relabel') {
        const p = payload as unknown as ClassificationRelabelPayload;
        if (p.outlet && p.fromTopic && p.toTopic) {
          const key = `${norm(p.outlet)}::${norm(p.fromTopic)}`;
          const owner = relabelOwners.get(key);
          if (!owner) {
            snap.classificationRelabels.set(key, p.toTopic);
            relabelOwners.set(key, row.id);
          } else if (snap.classificationRelabels.get(key) !== p.toTopic) {
            const prior = snap.conflicts.find(c => c.kind === 'classification-relabel' && c.scope === key);
            if (prior) prior.competingIds.push(row.id);
            else snap.conflicts.push({ kind: 'classification-relabel', scope: key, winnerId: owner, competingIds: [row.id] });
          }
        }
      } else if (row.ruleType === 'must-link') {
        const p = payload as unknown as MustLinkPayload;
        if (p.outletA && p.outletB && norm(p.outletA) && norm(p.outletB) && norm(p.outletA) !== norm(p.outletB)) {
          snap.mustLinkPairs.add(mustLinkKey(p.outletA, p.outletB));
        }
      } else if (row.ruleType === 'irrelevance-suppression') {
        const p = payload as unknown as IrrelevanceSuppressionPayload;
        if (p.outlet && p.category) {
          snap.irrelevanceSuppressions.add(`${norm(p.outlet)}::${norm(p.category)}`);
        }
      } else if (row.ruleType === 'scoring-cap') {
        const p = payload as unknown as ScoringCapPayload;
        if (p.outlet && p.category && typeof p.cap === 'number' && Number.isFinite(p.cap) && p.cap >= 0 && p.cap <= CURATED_SOFT_CAP) {
          const key = `${norm(p.outlet)}::${norm(p.category)}`;
          const current = snap.scoringCaps.get(key);
          if (current == null || p.cap < current) {
            if (current != null) snap.conflicts.push({ kind: 'scoring-cap', scope: key, winnerId: row.id, competingIds: [capOwners.get(key)!] });
            snap.scoringCaps.set(key, p.cap);
            capOwners.set(key, row.id);
          } else if (p.cap !== current) {
            const prior = snap.conflicts.find(c => c.kind === 'scoring-cap' && c.scope === key);
            if (prior) prior.competingIds.push(row.id);
            else snap.conflicts.push({ kind: 'scoring-cap', scope: key, winnerId: capOwners.get(key)!, competingIds: [row.id] });
          }
        }
      }
      // scoring-boost is explicitly advisory-only and never enters enforcement.
      // outlet-behavior-flip is enforced via outlet_registry directly — not cached here.
    } catch {
      // Malformed payload on a single row must never break the whole cache.
      continue;
    }
  }
  return snap;
}

// LEGACY LEARNED-RULE ENFORCEMENT RETIRED (Task #1180). Aggregate learned rules
// (outlet×category scoring caps / irrelevance suppression, standing outlet
// relabels, standing outlet-pair must-links, advisory score boosts) are no
// longer enforced in any backend hot path. Generation is unreachable and this
// cache now returns an EMPTY snapshot regardless of any approved rows still
// present in curated_learned_rules — so no learned rule is ever applied.
//
// The module's exported enforcement APIs are intentionally preserved (they all
// resolve to "no rule applies") so any remaining importers stay compilable.
// The DB is never read here anymore; buildLearnedRulesSnapshot /
// buildEmptySnapshot are kept for compatibility (old tests may import them).
async function refresh(): Promise<LearnedRulesSnapshot> {
  const empty = buildEmptySnapshot();
  cache = empty;
  return empty;
}

async function getSnapshot(): Promise<LearnedRulesSnapshot> {
  return buildEmptySnapshot();
}

// Force an immediate refresh — call right after an approve/revoke so the
// change is enforced on the very next read instead of waiting out the TTL.
export function invalidateCuratedLearnedRulesCache(): void {
  cache = null;
  inFlight = null;
}

export async function getLearnedClassificationRelabel(outlet: string, fromTopic: string): Promise<string | undefined> {
  const snap = await getSnapshot();
  return snap.classificationRelabels.get(`${norm(outlet)}::${norm(fromTopic)}`);
}

export async function isLearnedMustLinkPair(outletA: string, outletB: string): Promise<boolean> {
  const snap = await getSnapshot();
  return snap.mustLinkPairs.has(mustLinkKey(outletA, outletB));
}

export async function getLearnedMustLinkPairs(): Promise<Set<string>> {
  const snap = await getSnapshot();
  return snap.mustLinkPairs;
}

export async function isLearnedIrrelevanceSuppressed(outlet: string, category: string): Promise<boolean> {
  const snap = await getSnapshot();
  return snap.irrelevanceSuppressions.has(`${norm(outlet)}::${norm(category)}`);
}

// Task #678 — return the approved learned scoring cap ceiling for an
// outlet×category, or undefined if none applies. DOWN-only, cap-only: the
// caller must apply it via Math.min against a MACHINE score only (never a real
// human/upstream score). Fail-closed: a cache error yields no cap.
export async function getLearnedScoringCap(
  outlet: string,
  category: string | null | undefined,
): Promise<number | undefined> {
  if (!category) return undefined;
  const snap = await getSnapshot();
  return snap.scoringCaps.get(`${norm(outlet)}::${norm(category)}`);
}
