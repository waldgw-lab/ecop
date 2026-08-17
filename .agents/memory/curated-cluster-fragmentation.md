---
name: Curated clustering fragmentation lessons
description: Why obvious same-event merges get missed in the curated Top Stories clusterer and which levers are safe to pull.
---

# Curated clustering fragmentation

**Rule:** When editors report obvious missed merges, the cause is almost always (a) an LLM prompt separation rule over-applied to edge phrasings, or (b) token morphology blocking the deterministic repair nets — NOT the precision bars/budgets, which are deliberate and should stay untouched.

**Why:** Diagnosed three real editor-reported misses: "heads to Cairo ahead of X's visit" tripped the scheduled-event phase split (it's an open-ended talks track, not a summit); a roundup headline mentioning both attack directions pulled a defender-claim item ("Moscow says 600 drones targeted region") into a bogus exchange cluster; and singular/plural mismatches (drones/drone, strikes/strike) made legitimate pairs miss titlesHighlySimilar's 3-shared/0.6 bars.

**How to apply:**
- Prefer prompt clarifications in curatedEventIdentityGuidance.ts (narrow the over-applied rule with an explicit exception) and recall-side token normalization (e.g. conservative plural fold) over loosening precision bars, link counts, or budgets.
- The missed-corroboration alarm repeats some groups forever because the 22h staleness phase-out (intentional) dissolves aged stories — those "misses" are not merge bugs.
- Token-pipeline changes must preserve pseudo-tokens (casualtycount, displacecount, moneyfigure) and are pinned by scripts/curated-vocab-normalization.test.ts check (16). "news" is a stopword.
- Test scripts under scripts/*.test.ts are plain tsx self-executing scripts (run `npx tsx scripts/<t>.test.ts`), not vitest.
- The stored `category` is a FREE-FORM specific phrase ("Iran Nuclear Talks"), not a controlled label — any cross-story compatibility/veto logic must key on the controlled `primaryTopic` from the classification overlay, with the free-form text only as a legacy fallback. Sharper taxonomy makes equality vetoes fail-close on one real event carrying related defense/diplomacy topics; fix by declaring an explicit related-topic set compatible and letting the unchanged token/time/ambiguity gates decide — never weaken the gates.
- A policy decision/order and its direct same-track execution (same actors, same concrete measure, inside the same-event window) are ONE event; the identity-guidance exception must carve out scheduled-event phases, reactions/market effects, counter-strikes, and different-measure executions.
