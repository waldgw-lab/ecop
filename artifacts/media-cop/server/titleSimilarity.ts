// Shared normalized-title similarity (Task #1105). Extracted from the private
// Levenshtein implementation inside storage.ts so the curated ingest can run
// the same-article fuzzy de-dupe IN MEMORY against a once-per-pass corpus
// snapshot instead of issuing two DB round-trips per candidate (the per-item
// getSimilarCuratedItems / getSimilarCuratedItemsForOutlet reads over the Neon
// serverless driver were ~275 ms/item and dominated the RSS insert loop).
//
// Semantics: identical to storage.calculateSimilarity —
//   similarity = 1 - levenshtein(a, b) / max(len(a), len(b))
// with a > threshold decision. For efficiency the distance is computed with a
// banded (Ukkonen-style) DP bounded at k = floor((1 - threshold) * maxLen):
// any pair whose true distance exceeds k cannot clear the threshold, so we
// bail out early and report similarity 0. For pairs within the band the
// returned similarity is EXACTLY the unbanded value, so ranking (top-5 by
// similarity) is unchanged for every row that can possibly match.

/** Exact Levenshtein distance, but returns -1 as soon as the distance is
 * provably > k (early bail — the row can't clear the similarity threshold). */
export function boundedLevenshtein(a: string, b: string, k: number): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > k) return -1;
  if (la === 0) return lb <= k ? lb : -1;
  if (lb === 0) return la <= k ? la : -1;
  // Two-row DP restricted to a diagonal band of half-width k.
  const INF = k + 1;
  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j <= k ? j : INF;
  for (let i = 1; i <= la; i++) {
    const from = Math.max(1, i - k);
    const to = Math.min(lb, i + k);
    curr[from - 1] = i - k >= 1 ? INF : i; // left edge of the band
    let rowMin = INF;
    for (let j = from; j <= to; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      const v = Math.min(del, ins, sub);
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (to < lb) curr[to + 1] = INF; // right edge sentinel for next row's reads
    if (rowMin > k) return -1;       // whole band above k → can never recover
    const tmp = prev; prev = curr; curr = tmp;
  }
  const d = prev[lb];
  return d <= k ? d : -1;
}

/** Similarity in [0,1] when it exceeds `threshold`, else 0 (fast reject).
 * Matches storage.calculateSimilarity exactly for every pair that can clear
 * the threshold. */
export function titleSimilarityAbove(a: string, b: string, threshold: number): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const k = Math.floor((1 - threshold) * maxLen);
  const d = boundedLevenshtein(a, b, k);
  if (d < 0) return 0;
  const sim = 1 - d / maxLen;
  return sim > threshold ? sim : 0;
}
