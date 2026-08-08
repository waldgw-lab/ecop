// Curated-lane AI test-harness stub gate (Task #492).
//
// The curated-isolation harness (`scripts/curated-isolation-harness.ts`) drives a
// few AI-backed curated side-effects (the LLM admission gate, clustering grouping,
// reuse-intake enrichment) IN ITS OWN tsx process. Under a live 429 storm those
// calls used to either hang out a wall-clock budget or get skipped, so the gate
// "passed" by luck rather than by actually exercising the code. When the harness
// sets CURATED_AI_HARNESS_STUB=1 in its own process, these curated-only surfaces
// substitute a deterministic, network-free result so the exercise ALWAYS runs and
// the harness can assert on RESULTS, not on wall-clock timing.
//
// Strictly scoped:
//  - read at CALL time, so it only affects the process that set the env var;
//  - the production server never sets it, so live admission / clustering /
//    enrichment are completely unaffected;
//  - gated only inside curated-only modules (curatedIngest, curatedCluster).
export function isCuratedAiHarnessStub(): boolean {
  return process.env.CURATED_AI_HARNESS_STUB === '1';
}
