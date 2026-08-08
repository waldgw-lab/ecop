// =============================================================================
// Curated-lane boot-time data heal (Task #354). Idempotent, runs once at startup
// after the DB + outlet registry are ready. Repairs two classes of already-stored
// bad data on EXISTING curated rows so historical cards look right immediately
// instead of waiting to age out:
//
//   1. AI refusal / meta text wrongly stored as summary bullets or attributed
//      claims (e.g. "I cannot generate the requested analysis…"). Cleared to NULL
//      and the row's media state reset so the now-refusal-aware enrichment worker
//      can give it a fresh, clean attempt.
//   2. Raw relay HTML left in social-post bodies (X / Truth Social / DataMinr) —
//      stripped + entity-decoded so literal `</p>` never renders.
//
// Curated-lane ONLY: touches nothing but `curated_items`. Idempotent — once a row
// is clean, re-running matches nothing (refusal patterns no longer present, clean
// text is unchanged by the cleaner), so every boot is a no-op after convergence.
// Prod's DB is agent-read-only via the SQL console, but the app itself owns its
// deployment DB and applies this at boot like the other curated heals.
// =============================================================================
import { db } from './db';
import { curatedItems, curatedHeadlineOverrides, curatedStorySynthesis, curatedStoryArchive, headlines, curatedClassifications, type CuratedArchiveMember } from '@shared/schema';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { OTHER_EMERGING } from '@shared/classificationVocab';
import { storage } from './storage';
import { buildOutletIndex, findOutlet, isSocialFlashOutlet } from '@shared/outletRegistry';
import { isAIRefusalText } from './streamPrefetch';
import { cleanSocialPostText } from './socialPostText';
import { isBotWallHeadline } from './curatedAutoHeadline';
import {
  containsKnownStaleIdentity,
  correctCurrentOfficialTitles,
  groundGeneratedTextInSources,
  hasUnsupportedStatusDescriptor,
  stripStaleStatusDescriptorsFromArray,
} from './staleStatusSanitizer';
import { isMetaFillerLine } from './metaFiller';
import {
  extractBypassTargetUrl,
  isBypassAttributionHost,
  isJunkBypassLabel,
  resolveBypassAttribution,
} from './curatedIngest';

/**
 * Re-attribute historical curated labels that predate the bypass-host guard.
 * URL values are deliberately never included in an update payload.
 */
export async function healCuratedBypassSourceLabels(): Promise<{ curatedItems: number; archiveRows: number }> {
  const registry = await storage.getOutletRegistry();
  const index = buildOutletIndex(registry);
  let curatedItemsHealed = 0;
  let archiveRowsHealed = 0;

  const items = await db
    .select({ id: curatedItems.id, source: curatedItems.source, url: curatedItems.url })
    .from(curatedItems);
  for (const row of items) {
    if (!isJunkBypassLabel(row.source) || !isBypassAttributionHost(row.url)) continue;
    // Explicit extraction guard documents and enforces the short-code no-op.
    if (!extractBypassTargetUrl(row.url)) continue;
    const source = resolveBypassAttribution(row.url, row.source, index);
    if (!source || source === row.source) continue;
    await db.update(curatedItems).set({ source }).where(eq(curatedItems.id, row.id));
    curatedItemsHealed++;
  }

  const archived = await db
    .select({
      id: curatedStoryArchive.id,
      repSource: curatedStoryArchive.repSource,
      repUrl: curatedStoryArchive.repUrl,
      members: curatedStoryArchive.members,
    })
    .from(curatedStoryArchive);
  for (const row of archived) {
    let changed = false;
    let repSource = row.repSource;
    if (
      repSource
      && row.repUrl
      && isJunkBypassLabel(repSource)
      && isBypassAttributionHost(row.repUrl)
      && extractBypassTargetUrl(row.repUrl)
    ) {
      const resolved = resolveBypassAttribution(row.repUrl, repSource, index);
      if (resolved && resolved !== repSource) {
        repSource = resolved;
        changed = true;
      }
    }

    const members = (row.members ?? []).map((member: CuratedArchiveMember) => {
      if (
        !isJunkBypassLabel(member.source)
        || !isBypassAttributionHost(member.url)
        || !extractBypassTargetUrl(member.url)
      ) return member;
      const source = resolveBypassAttribution(member.url, member.source, index);
      if (!source || source === member.source) return member;
      changed = true;
      return { ...member, source };
    });

    if (!changed) continue;
    await db
      .update(curatedStoryArchive)
      .set({ repSource, members })
      .where(eq(curatedStoryArchive.id, row.id));
    archiveRowsHealed++;
  }

  console.log(`[CuratedHeal:bypass-attribution] curated_items=${curatedItemsHealed}, curated_story_archive=${archiveRowsHealed}`);
  return { curatedItems: curatedItemsHealed, archiveRows: archiveRowsHealed };
}

export async function healCuratedSocialAndRefusalData(): Promise<{ refusalCleared: number; htmlCleaned: number; botWallOverridesDeleted: number }> {
  let refusalCleared = 0;
  let htmlCleaned = 0;
  let botWallOverridesDeleted = 0;
  try {
    // 1) Clear stored AI refusal / meta text from summaryBullets + attributedClaims.
    const withText = await db
      .select({
        id: curatedItems.id,
        summaryBullets: curatedItems.summaryBullets,
        attributedClaims: curatedItems.attributedClaims,
      })
      .from(curatedItems)
      .where(
        or(
          sql`array_length(${curatedItems.summaryBullets}, 1) > 0`,
          sql`array_length(${curatedItems.attributedClaims}, 1) > 0`,
        ),
      );
    for (const r of withText) {
      const bulletsBad = (r.summaryBullets ?? []).some(isAIRefusalText);
      const claimsBad = (r.attributedClaims ?? []).some(isAIRefusalText);
      if (!bulletsBad && !claimsBad) continue;
      // Null both, and reset the media/back-off state so the now-refusal-aware
      // worker re-attempts the row cleanly (existing back-off rules then apply).
      await db
        .update(curatedItems)
        .set({
          summaryBullets: null,
          attributedClaims: null,
          mediaScrapedAt: null,
          mediaAttemptCount: 0,
          lastMediaAttemptAt: null,
        })
        .where(eq(curatedItems.id, r.id));
      refusalCleared++;
    }

    // 2) Strip raw HTML from social-post bodies (curated rows whose outlet is a
    //    social/flash source). Resolve each row through the SAME registry path
    //    ingest uses so "social" can never drift.
    const registry = await storage.getOutletRegistry();
    const index = buildOutletIndex(registry);
    const rows = await db
      .select({
        id: curatedItems.id,
        title: curatedItems.title,
        summary: curatedItems.summary,
        source: curatedItems.source,
        url: curatedItems.url,
      })
      .from(curatedItems);
    for (const r of rows) {
      const outlet = findOutlet(index, r.source, r.url);
      if (!isSocialFlashOutlet(outlet)) continue;
      const cleanTitle = cleanSocialPostText(r.title);
      const cleanSummary = cleanSocialPostText(r.summary);
      // title is NOT NULL — never blank it out; only the summary may legitimately
      // become empty (e.g. a media-only post).
      const nextTitle = cleanTitle || r.title;
      if (nextTitle === r.title && cleanSummary === r.summary) continue;
      await db
        .update(curatedItems)
        .set({ title: nextTitle, summary: cleanSummary })
        .where(eq(curatedItems.id, r.id));
      htmlCleaned++;
    }

    // 3) Delete bot-wall titles wrongly stored as 'auto' headline overrides
    //    ("Bloomberg - Are you a robot?" — the bypass fetched an anti-bot wall
    //    and its <title> slipped past the old whole-string generic check; prod
    //    incident 2026-07-14, 23 rows). AUTO rows only — a 'human' override is
    //    never touched. Deleting the override falls back to the item's stored
    //    ingest-time title, and the hardened evaluateAutoHeadline bot-wall gate
    //    prevents re-writing it. Idempotent: once deleted, matches nothing.
    const overrideRows = await db
      .select({ key: curatedHeadlineOverrides.key, headline: curatedHeadlineOverrides.headline })
      .from(curatedHeadlineOverrides)
      .where(eq(curatedHeadlineOverrides.provenance, 'auto'));
    for (const r of overrideRows) {
      if (!isBotWallHeadline(r.headline)) continue;
      await db.delete(curatedHeadlineOverrides).where(eq(curatedHeadlineOverrides.key, r.key));
      botWallOverridesDeleted++;
    }

    if (refusalCleared > 0 || htmlCleaned > 0 || botWallOverridesDeleted > 0) {
      console.log(
        `✅ [CuratedHeal] Cleared AI refusal text on ${refusalCleared} row(s); stripped raw HTML on ${htmlCleaned} social row(s); deleted ${botWallOverridesDeleted} bot-wall auto headline override(s)`,
      );
    }
  } catch (error) {
    console.error('[CuratedHeal] error:', (error as Error).message);
  }
  return { refusalCleared, htmlCleaned, botWallOverridesDeleted };
}

/**
 * Boot-time heal for stale status descriptors ("Former President Trump") that
 * older AI generations stored in curated_items bullets/claims and in
 * curated_story_synthesis prose fields. Idempotent: the hardened prompts +
 * write-time sanitizer guarantee the pattern can't be re-written, so after one
 * boot this converges to a no-op.
 *
 * Strategy:
 *   curated_items — per-row source text (title + summary) is available, so we
 *     can try in-place sanitization. Where the result is empty we null the
 *     array so re-enrichment can fill it.
 *   curated_story_synthesis — member source texts are NOT stored here, so we
 *     delete any synthesis row whose prose contains an unsupported descriptor;
 *     the next clustering pass re-synthesizes it with the hardened prompt.
 *
 * Human-provenance overlays (curated_headline_overrides with provenance='human')
 * are never touched.
 */
export async function healStaleStatusDescriptors(): Promise<{
  itemBulletsHealed: number;
  itemClaimsHealed: number;
  synthesisRowsDeleted: number;
}> {
  let itemBulletsHealed = 0;
  let itemClaimsHealed = 0;
  let synthesisRowsDeleted = 0;
  const paparoItemKeys = new Set<string>();
  try {
    // ── 1. curated_items: sanitize summaryBullets + attributedClaims in place.
    const itemRows = await db
      .select({
        id: curatedItems.id,
        url: curatedItems.url,
        title: curatedItems.title,
        summary: curatedItems.summary,
        summaryBullets: curatedItems.summaryBullets,
        attributedClaims: curatedItems.attributedClaims,
        sourceSpin: curatedItems.sourceSpin,
      })
      .from(curatedItems)
      .where(
        or(
          sql`array_length(${curatedItems.summaryBullets}, 1) > 0`,
          sql`array_length(${curatedItems.attributedClaims}, 1) > 0`,
          // Historical identity substitutions can exist in scalar enrichment
          // fields even when arrays are empty. Keep this bounded to the known
          // stale identity rather than scanning/re-writing every summary.
          sql`${curatedItems.summary} ILIKE '%John Aquilino%'`,
          sql`${curatedItems.sourceSpin} ILIKE '%John Aquilino%'`,
        ),
      );

    for (const r of itemRows) {
      // Use the item's own stored title + summary as the source-text oracle.
      // If the article used "Former President X", the headline/summary would
      // contain it; if not, the AI injected it stale.
      let srcTexts = [r.title, r.summary].filter((s): s is string => typeof s === 'string' && s.length > 0);
      // Verified production repair for the AP article that names Admiral Samuel
      // Paparo but whose stored enrichment substituted predecessor John
      // Aquilino. The exact URL binds this source oracle to one article only.
      if (r.url.includes('8b2b98dad27f8420c7bc217a31354b4a')) {
        paparoItemKeys.add(`curated:${r.id}`);
        // Do not include the stored AI summary here: it is the contaminated
        // field being repaired and must never legitimize its own stale name.
        srcTexts = [
          r.title,
          'Admiral Samuel Paparo said coercive actions challenge regional stability. Paparo is the head of U.S. Pacific Command and the U.S. Indo-Pacific commander.',
        ].filter((s): s is string => typeof s === 'string' && s.length > 0);
      }

      const sanitizeLine = (line: string) =>
        groundGeneratedTextInSources(
          stripStaleStatusDescriptorsFromArray([line], srcTexts)[0],
          srcTexts,
        ) ?? '';
      // `summary` is the one-sentence AI enrichment for this item. Correct the
      // exact known stale-office phrase in place too; do not touch the source
      // title or any human override table.
      const cleanSummary = r.summary
        ? (groundGeneratedTextInSources(r.summary, srcTexts) ?? r.summary)
        : r.summary;
      const cleanSourceSpin = r.sourceSpin
        ? (groundGeneratedTextInSources(r.sourceSpin, srcTexts) ?? r.sourceSpin)
        : r.sourceSpin;
      const hasSummaryIssue = cleanSummary !== r.summary;
      const hasSourceSpinIssue = cleanSourceSpin !== r.sourceSpin;
      const hasBulletIssue = (r.summaryBullets ?? []).some((b) => sanitizeLine(b) !== b);
      const hasClaimIssue = (r.attributedClaims ?? []).some((c) => sanitizeLine(c) !== c);
      if (!hasSummaryIssue && !hasSourceSpinIssue && !hasBulletIssue && !hasClaimIssue) continue;

      const cleanBullets = hasBulletIssue
        ? (r.summaryBullets ?? []).map(sanitizeLine).filter((b) => b.trim().length > 0)
        : r.summaryBullets;
      const cleanClaims = hasClaimIssue
        ? (r.attributedClaims ?? []).map(sanitizeLine).filter((c) => c.trim().length > 0)
        : r.attributedClaims;

      const updates: Record<string, unknown> = {};
      if (hasSummaryIssue) updates.summary = cleanSummary;
      if (hasSourceSpinIssue) updates.sourceSpin = cleanSourceSpin;
      if (hasBulletIssue) {
        // Null when all bullets were stripped (allow re-enrichment), else keep cleaned array.
        updates.summaryBullets = (cleanBullets && cleanBullets.length > 0) ? cleanBullets : null;
        itemBulletsHealed++;
      }
      if (hasClaimIssue) {
        updates.attributedClaims = (cleanClaims && cleanClaims.length > 0) ? cleanClaims : null;
        itemClaimsHealed++;
      }
      // If bullets are nulled, also reset media state so re-enrichment triggers.
      if (updates.summaryBullets === null) {
        updates.mediaScrapedAt = null;
        updates.mediaAttemptCount = 0;
        updates.lastMediaAttemptAt = null;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await db.update(curatedItems).set(updates as any).where(eq(curatedItems.id, r.id));
    }

    // ── 2. curated_story_synthesis: mark rows for re-synthesis by nulling contentHash.
    //    Member source texts are NOT stored alongside synthesis rows, so we cannot
    //    safely do in-place descriptor sanitization here without risking incorrect
    //    removal of genuine "former" usage. Instead we null contentHash on rows that
    //    appear to carry a descriptor — the null triggers one re-synthesis on the
    //    next clustering pass, which uses the now-hardened prompt + write-time
    //    sanitizer. The row is NOT deleted: the current display is preserved until
    //    the re-synthesis is complete, and legitimate "former" usage is correctly
    //    restored by the sanitizer because the source member texts are available
    //    at synthesis time.
    //
    //    Detection: scan ALL prose fields (headline, lede, facts, attributedClaims,
    //    spins, alignments) with an empty source oracle so any descriptor triggers
    //    the re-queue flag. Using the row's own text as the oracle is circular —
    //    a stale "Former" in the headline would "support" the same stale descriptor
    //    in the lede, masking the exact production failure mode. False positives are
    //    safe because we null contentHash, not delete; on re-synthesis the hardened
    //    prompt + write-time sanitizer correctly restores "Former" when the actual
    //    member source texts (available at synthesis time) genuinely use it.
    const synthRows = await db
      .select({
        id: curatedStorySynthesis.id,
        headline: curatedStorySynthesis.headline,
        lede: curatedStorySynthesis.lede,
        facts: curatedStorySynthesis.facts,
        attributedClaims: curatedStorySynthesis.attributedClaims,
        spins: curatedStorySynthesis.spins,
        alignments: curatedStorySynthesis.alignments,
        contentHash: curatedStorySynthesis.contentHash,
      })
      .from(curatedStorySynthesis);

    // Simple pattern: scan the descriptor regex over ALL prose fields with an
    // empty source oracle (so any descriptor triggers the flag).  We intentionally
    // do NOT use the row's own synthesized text as a cross-field oracle — that is
    // circular (a stale descriptor in the headline would "support" the same
    // descriptor in the lede, masking the exact production failure mode).
    //
    // False-positives are safe: we only null contentHash, not delete the row,
    // so a story about a GENUINE past official (e.g. "Former SecDef Mattis")
    // simply re-synthesizes once.  The hardened prompt + write-time sanitizer
    // then correctly preserves "Former" because the member source texts ARE
    // available at re-synthesis time and clearly say "former".  After one clean
    // re-synthesis the descriptor pattern is no longer present → contentHash is
    // restored → no further re-synthesis triggered.
    const emptySource: string[] = [];
    const spinDescriptorBad = (spinMap: Record<string, string>): boolean =>
      Object.values(spinMap).some((v) => hasUnsupportedStatusDescriptor(v, emptySource));
    const alignDescriptorBad = (
      alignMap: Record<string, { align: string[]; diverge: string[]; pct?: number }>,
    ): boolean =>
      Object.values(alignMap).some(
        (e) =>
          [...(e.align ?? []), ...(e.diverge ?? [])].some((s) =>
            hasUnsupportedStatusDescriptor(s, emptySource),
          ),
      );
    const containsStaleIdentityInMap = (values: Record<string, string>): boolean =>
      Object.values(values).some((value) => containsKnownStaleIdentity(value));

    for (const r of synthRows) {
      const spinMap = (r.spins ?? {}) as Record<string, string>;
      const containsPaparoMember = Array.from(paparoItemKeys).some((key) =>
        Object.prototype.hasOwnProperty.call(spinMap, key),
      );
      const bad =
        hasUnsupportedStatusDescriptor(r.headline, emptySource) ||
        hasUnsupportedStatusDescriptor(r.lede, emptySource) ||
        (r.facts ?? []).some((f) => hasUnsupportedStatusDescriptor(f, emptySource)) ||
        (r.attributedClaims ?? []).some((c) => hasUnsupportedStatusDescriptor(c, emptySource)) ||
        containsKnownStaleIdentity(r.headline) ||
        containsKnownStaleIdentity(r.lede) ||
        (r.facts ?? []).some(containsKnownStaleIdentity) ||
        (r.attributedClaims ?? []).some(containsKnownStaleIdentity) ||
        (r.spins && containsStaleIdentityInMap(r.spins as Record<string, string>)) ||
        (r.spins && spinDescriptorBad(r.spins as Record<string, string>)) ||
        (r.alignments && alignDescriptorBad(r.alignments as Record<string, { align: string[]; diverge: string[]; pct?: number }>));
      if (!bad) continue;
      // Immediate, source-bound production repair: these synthesis rows contain
      // the exact verified AP Paparo member. Replace the predecessor name in all
      // prose fields now, then null contentHash so the normal synthesis pass can
      // regenerate from the repaired member data. Rows without that exact member
      // are never rewritten (Aquilino may be legitimate historical reporting).
      if (containsPaparoMember && (
        containsKnownStaleIdentity(r.headline) ||
        containsKnownStaleIdentity(r.lede) ||
        (r.facts ?? []).some(containsKnownStaleIdentity) ||
        (r.attributedClaims ?? []).some(containsKnownStaleIdentity) ||
        containsStaleIdentityInMap(spinMap)
      )) {
        const replaceIdentity = (value: string) =>
          value.replace(/\bJohn Aquilino\b/gi, 'Samuel Paparo');
        const replaceArray = (values: string[]) =>
          values.map(replaceIdentity);
        const cleanSpinMap = Object.fromEntries(
          Object.entries(spinMap).map(([key, value]) => [key, replaceIdentity(value)]),
        );
        await db
          .update(curatedStorySynthesis)
          .set({
            headline: replaceIdentity(r.headline),
            lede: replaceIdentity(r.lede),
            facts: replaceArray(r.facts),
            attributedClaims: replaceArray(r.attributedClaims ?? []),
            spins: cleanSpinMap,
            contentHash: null,
          })
          .where(eq(curatedStorySynthesis.id, r.id));
        synthesisRowsDeleted++;
        continue;
      }
      // Null contentHash — the clustering pass re-synthesizes this row next run.
      await db
        .update(curatedStorySynthesis)
        .set({ contentHash: null })
        .where(eq(curatedStorySynthesis.id, r.id));
      synthesisRowsDeleted++;
    }

    // ── 3. main-feed headlines: sanitize summaryBullets + attributedClaims.
    //    Same in-place strategy as curated_items: use per-row title + summary
    //    as source oracle, strip in place, null array where all entries stripped.
    const mainRows = await db
      .select({
        id: headlines.id,
        title: headlines.title,
        summary: headlines.summary,
        summaryBullets: headlines.summaryBullets,
        attributedClaims: headlines.attributedClaims,
      })
      .from(headlines)
      .where(
        or(
          sql`array_length(${headlines.summaryBullets}, 1) > 0`,
          sql`array_length(${headlines.attributedClaims}, 1) > 0`,
        ),
      );

    for (const r of mainRows) {
      const srcTexts = [r.title, r.summary].filter((s): s is string => typeof s === 'string' && s.length > 0);

      const sanitizeLine = (line: string) =>
        correctCurrentOfficialTitles(stripStaleStatusDescriptorsFromArray([line], srcTexts)[0], srcTexts);
      const cleanSummary = r.summary ? correctCurrentOfficialTitles(r.summary, srcTexts) : r.summary;
      const hasSummaryIssue = cleanSummary !== r.summary;
      const hasBulletIssue = (r.summaryBullets ?? []).some((b) => sanitizeLine(b) !== b);
      const hasClaimIssue = (r.attributedClaims ?? []).some((c) => sanitizeLine(c) !== c);
      if (!hasSummaryIssue && !hasBulletIssue && !hasClaimIssue) continue;

      const cleanBullets = hasBulletIssue
        ? (r.summaryBullets ?? []).map(sanitizeLine).filter((b) => b.trim().length > 0)
        : r.summaryBullets;
      const cleanClaims = hasClaimIssue
        ? (r.attributedClaims ?? []).map(sanitizeLine).filter((c) => c.trim().length > 0)
        : r.attributedClaims;

      const updates: Record<string, unknown> = {};
      if (hasSummaryIssue) updates.summary = cleanSummary;
      if (hasBulletIssue) {
        updates.summaryBullets = (cleanBullets && cleanBullets.length > 0) ? cleanBullets : null;
        itemBulletsHealed++;
      }
      if (hasClaimIssue) {
        updates.attributedClaims = (cleanClaims && cleanClaims.length > 0) ? cleanClaims : null;
        itemClaimsHealed++;
      }
      // If bullets nulled, also reset media state for re-enrichment.
      if (updates.summaryBullets === null) {
        updates.mediaScrapedAt = null;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await db.update(headlines).set(updates as any).where(eq(headlines.id, r.id));
    }

    if (itemBulletsHealed > 0 || itemClaimsHealed > 0 || synthesisRowsDeleted > 0) {
      console.log(
        `✅ [CuratedHeal] Stale-status heal: cleaned bullets on ${itemBulletsHealed} row(s), claims on ${itemClaimsHealed} row(s) (curated+main-feed); queued ${synthesisRowsDeleted} synthesis row(s) for re-synthesis`,
      );
    }
  } catch (error) {
    console.error('[CuratedHeal] stale-status heal error:', (error as Error).message);
  }
  return { itemBulletsHealed, itemClaimsHealed, synthesisRowsDeleted };
}

// =============================================================================
// healMetaFillerBulletsAndClaims
//
// Scans curated_items rows whose stored summaryBullets or attributedClaims
// contain meta-filler lines (e.g. "The article is a placeholder…", "The
// excerpt does not contain substantive news content…") and clears them so the
// next enrichment cycle produces clean, real content instead.
//
// Runs once at boot, idempotent — a row is already clean after the first pass.
// Curated-lane only: touches nothing but `curated_items`.
// =============================================================================
export async function healMetaFillerBulletsAndClaims(): Promise<{
  bulletsCleared: number;
  claimsCleared: number;
}> {
  let bulletsCleared = 0;
  let claimsCleared = 0;
  try {
    const rows = await db
      .select({
        id: curatedItems.id,
        summaryBullets: curatedItems.summaryBullets,
        attributedClaims: curatedItems.attributedClaims,
      })
      .from(curatedItems)
      .where(
        or(
          sql`array_length(${curatedItems.summaryBullets}, 1) > 0`,
          sql`array_length(${curatedItems.attributedClaims}, 1) > 0`,
        ),
      );

    for (const r of rows) {
      const hasBulletFiller = (r.summaryBullets ?? []).some((b) => isMetaFillerLine(b));
      const hasClaimFiller = (r.attributedClaims ?? []).some((c) => isMetaFillerLine(c));
      if (!hasBulletFiller && !hasClaimFiller) continue;

      const updates: Record<string, unknown> = {};

      if (hasBulletFiller) {
        const cleaned = (r.summaryBullets ?? []).filter((b) => !isMetaFillerLine(b));
        // Null when all bullets were meta-filler (allows re-enrichment), else keep survivors.
        updates.summaryBullets = cleaned.length > 0 ? cleaned : null;
        // If nulled, also reset media state so enrichment picks it up again.
        if (updates.summaryBullets === null) {
          updates.mediaScrapedAt = null;
          updates.mediaAttemptCount = 0;
          updates.lastMediaAttemptAt = null;
        }
        bulletsCleared++;
      }

      if (hasClaimFiller) {
        const cleaned = (r.attributedClaims ?? []).filter((c) => !isMetaFillerLine(c));
        updates.attributedClaims = cleaned.length > 0 ? cleaned : null;
        claimsCleared++;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await db.update(curatedItems).set(updates as any).where(eq(curatedItems.id, r.id));
    }

    if (bulletsCleared > 0 || claimsCleared > 0) {
      console.log(
        `✅ [CuratedHeal] Meta-filler heal: cleared bullets on ${bulletsCleared} row(s), claims on ${claimsCleared} row(s)`,
      );
    }
  } catch (error) {
    console.error('[CuratedHeal] meta-filler heal error:', (error as Error).message);
  }
  return { bulletsCleared, claimsCleared };
}

// =============================================================================
// repairCatchAllClassifications
//
// Boot-time, idempotent repair for two classes of mis-classified curated rows:
//
//   1. AI 'Other / Emerging' rows blocked by the 6h cooldown gate — their
//      classifiedAt is aged past the cooldown so the next classification cron
//      pass (:05/:15/…) immediately re-sharpens them. Human-provenance rows are
//      never touched (provenance='human' guard).
//
//   2. The same aging makes any row in class (1) that is still within the 24h
//      display window eligible on the very first cron pass post-republish,
//      rather than waiting up to 6h for the cooldown to expire naturally.
//
// Why boot-time: the classification cron already handles the ongoing maintenance
// (reclassify-eligible rows get sharpened every 10 min), but existing rows
// written BEFORE the eligibility fix were blocked by the generate-once lock +
// cooldown. This one-shot aging unblocks them immediately without requiring a
// direct SQL write to the production DB (which is agent-read-only).
//
// Idempotent: once a row is re-classified with a real topic it is no longer
// 'Other / Emerging', so subsequent boots find nothing to reset. A row that
// keeps getting classified back to 'Other / Emerging' is genuinely ambiguous —
// its cooldown will simply restart on each cron pass (expected behavior).
//
// Curated-lane ONLY — touches only curated_classifications. Never modifies
// curated_items, headlines, or any human-authored data.
// =============================================================================

const CATCHALL_REPAIR_COOLDOWN_MS = 6 * 60 * 60 * 1000; // must match RECLASSIFY_GENERIC_COOLDOWN_MS

// Convergence cap (Task #1088). A row that has been repair-reset this many
// times and STILL comes back 'Other / Emerging' is genuinely ambiguous — the
// classifier keeps confirming the catch-all. Skipping it stops the boot repair
// from re-resetting (and the cron from re-AI-classifying) the same ~hundreds of
// rows on every redeploy. The counter is never reset: rows that later earn a
// real topic simply leave the candidate set, and human overrides are already
// protected by the provenance guard.
const CATCHALL_REPAIR_MAX_RESETS = 3;

export async function repairCatchAllClassifications(): Promise<{ eligibilityReset: number }> {
  let eligibilityReset = 0;
  try {
    // Find AI-provenance rows stuck on 'Other / Emerging' whose classifiedAt is
    // still fresh (i.e., blocked by the cooldown gate). We age classifiedAt past
    // the cooldown so the next cron pass treats them as reclassify-eligible.
    const staleAt = new Date(Date.now() - CATCHALL_REPAIR_COOLDOWN_MS - 1000);

    const rows = await db
      .select({
        url: curatedClassifications.url,
        classifiedAt: curatedClassifications.classifiedAt,
        catchallRepairCount: curatedClassifications.catchallRepairCount,
      })
      .from(curatedClassifications)
      .where(and(
        eq(curatedClassifications.provenance, 'ai'),
        eq(curatedClassifications.primaryTopic, OTHER_EMERGING),
        sql`${curatedClassifications.catchallRepairCount} < ${CATCHALL_REPAIR_MAX_RESETS}`,
      ));

    // Only age rows that are still within the cooldown window (i.e., still blocked).
    const toReset = rows.filter((r) => new Date(r.classifiedAt).getTime() > staleAt.getTime());

    if (toReset.length > 0) {
      const urls = toReset.map((r) => r.url);
      const CHUNK = 500;
      for (let i = 0; i < urls.length; i += CHUNK) {
        const slice = urls.slice(i, i + CHUNK);
        await db
          .update(curatedClassifications)
          .set({
            classifiedAt: staleAt,
            // Count this reset toward the convergence cap so a chronically
            // ambiguous row ages out of the repair set after a few cycles.
            catchallRepairCount: sql`${curatedClassifications.catchallRepairCount} + 1`,
          })
          // Hard guard: ONLY update rows that are still AI-provenance (a human
          // override that landed between our SELECT and this UPDATE is protected).
          .where(and(
            inArray(curatedClassifications.url, slice),
            eq(curatedClassifications.provenance, 'ai'),
          ));
      }
      eligibilityReset = toReset.length;
      console.log(
        `✅ [CuratedHeal] Catch-all repair: reset eligibility for ${eligibilityReset} AI "Other / Emerging" row(s) — eligible for re-classification at next cron pass`,
      );
    }
  } catch (error) {
    console.error('[CuratedHeal] catch-all repair error:', (error as Error).message);
  }
  return { eligibilityReset };
}
