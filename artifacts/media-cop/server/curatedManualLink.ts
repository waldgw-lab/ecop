// =============================================================================
// Curated lane — EDITOR manual-link AI SECOND OPINION.
//
// This remains advisory-only: every AI/configuration/parse failure returns
// `skipped`, and an editor can always continue. It consumes the SAME event-
// identity guidance as live Curated clustering, but deliberately does NOT use
// clustering's multi-model chain: an interactive second opinion gets one bounded
// GPT-4o-quality request and then fails open promptly.
// =============================================================================
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { createPreferOpenRouter, isAIConfigured, isTransientAIError } from './aiClient';
import { withAiTimeout } from './aiTimeout';
import { CURATED_EVENT_IDENTITY_GUIDANCE } from './curatedEventIdentityGuidance';
import { normalizeIdentityUrl } from './urlIdentity';

export const MANUAL_LINK_REVIEW_LIMIT = 25;
export const MANUAL_LINK_REVIEW_REQUEST_TIMEOUT_MS = 8_000;
export const MANUAL_LINK_REVIEW_BACKSTOP_MS = 10_000;
const REVIEW_TOKEN_TTL_MS = 30 * 60 * 1000;
const EVIDENCE_MAX_CHARS = 220;

type ManualLinkCompletion = typeof createPreferOpenRouter;
let manualLinkCompletionOverride: ManualLinkCompletion | null = null;
let manualLinkReviewBackstopOverrideMs: number | null = null;

/** Test-only completion seam; production always uses createPreferOpenRouter. */
export function __setManualLinkCompletionForTest(fn: ManualLinkCompletion | null): void {
  manualLinkCompletionOverride = fn;
}

/** Test-only deadline seam so a hung-provider regression stays fast. */
export function __setManualLinkReviewBackstopForTest(ms: number | null): void {
  manualLinkReviewBackstopOverrideMs =
    typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : null;
}

export interface ManualLinkReviewItem {
  title: string;
  outlet?: string | null;
  url?: string | null;
  publishedAt?: Date | string | null;
  role?: string | null;
  summary?: string | null;
  bullets?: string[] | null;
  evidenceSource?: 'server' | 'client';
}

export type ManualLinkVerdict = 'concur' | 'object' | 'skipped';

export interface ManualLinkReview {
  verdict: ManualLinkVerdict;
  reasoning: string;
  rationale: string;
  requestedCount: number;
  reviewedCount: number;
  evidenceResolvedCount: number;
  partial: boolean;
  warning: string | null;
  reviewToken?: string;
}

type ReviewTokenPayload = {
  verdict: ManualLinkVerdict;
  reasoning: string;
  requestedCount: number;
  reviewedCount: number;
  selectionFingerprint: string;
  issuedAt: number;
};

function cleanText(value: unknown, max = EVIDENCE_MAX_CHARS): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function formatPublishedAt(value: Date | string | null | undefined): string {
  if (!value) return 'time unknown';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : 'time unknown';
}

function publishedTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

// The interactive review is intentionally bounded. When a proposed grouping
// contains more than the cap, review the freshest reporting rather than whichever
// cluster happened to be serialized first by the client. Unknown/tied dates keep
// their stable incoming order so the selection remains deterministic.
export function selectRecentManualLinkReviewItems(
  items: ManualLinkReviewItem[],
  limit = MANUAL_LINK_REVIEW_LIMIT,
): ManualLinkReviewItem[] {
  return items
    .map((item, index) => ({ item, index, time: publishedTime(item.publishedAt) }))
    .sort((a, b) => {
      if (a.time !== null && b.time !== null && a.time !== b.time) return b.time - a.time;
      if (a.time !== null && b.time === null) return -1;
      if (a.time === null && b.time !== null) return 1;
      return a.index - b.index;
    })
    .slice(0, Math.max(0, limit))
    .map(({ item }) => item);
}

export function buildManualLinkReviewPrompt(items: ManualLinkReviewItem[]): string {
  const lines = items.map((it, i) => {
    const evidence = [
      `publisher=${cleanText(it.outlet, 100) || 'unknown'}`,
      `published=${formatPublishedAt(it.publishedAt)}`,
      `role=${cleanText(it.role, 60) || 'unknown'}`,
    ];
    const snippets = [
      cleanText(it.summary),
      ...(Array.isArray(it.bullets) ? it.bullets.map((b) => cleanText(b)) : []),
    ].filter(Boolean).slice(0, 3);
    return `${i + 1}. "${cleanText(it.title, 300)}" (${evidence.join(', ')})${
      snippets.length ? ` -- ${snippets.join(' | ')}` : ' -- no summary/bullet evidence available'
    }`;
  });

  return `You are a newsroom editor's assistant reviewing a proposed manual grouping into ONE Curated defense-news story.

Apply the EXACT same event-identity policy used by live Curated clustering:

${CURATED_EVENT_IDENTITY_GUIDANCE}

PROPOSED ITEMS (server-resolved evidence is authoritative; missing evidence must not be invented):
${lines.join('\n')}

Decide whether ALL reviewed items can coherently cover one story under that policy. In "rationale", name the most relevant policy rationale (for example: same negotiation track/status update, scheduled-event phase split, kinetic-vs-diplomatic split, downstream market effect, counter-strike, or same incident/different wording). Do not object merely because same-track negotiation coverage uses different wording or moves from announcement/anticipation to a direct denial or status qualification.

The editor has final say. Return ONLY strict JSON:
{"verdict":"concur"|"object","rationale":"short policy label","reasoning":"one or two sentences"}
- "concur": all reviewed items may belong to one story under the policy.
- "object": at least one reviewed item is a genuinely different event; identify the specific split rationale.
Keep rationale under 80 characters and reasoning under 300 characters.`;
}

function signingSecret(): string | null {
  const secret = process.env.SESSION_SECRET;
  return secret && secret.length >= 16 ? secret : null;
}

function encodePayload(payload: ReviewTokenPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function manualLinkReviewSelectionFingerprint(items: Array<{ url?: string | null }>): string {
  const urls = Array.from(new Set(
    items
      .map((item) => item.url ? normalizeIdentityUrl(item.url) : null)
      .filter((url): url is string => !!url),
  )).sort();
  return createHash('sha256').update(urls.join('\n')).digest('hex');
}

export function issueManualLinkReviewToken(
  review: ManualLinkReview,
  items: ManualLinkReviewItem[],
): string | undefined {
  const secret = signingSecret();
  if (!secret) return undefined;
  const body = encodePayload({
    verdict: review.verdict,
    reasoning: review.reasoning,
    requestedCount: review.requestedCount,
    reviewedCount: review.reviewedCount,
    selectionFingerprint: manualLinkReviewSelectionFingerprint(items),
    issuedAt: Date.now(),
  });
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function verifyManualLinkReviewToken(token: unknown): ReviewTokenPayload | null {
  const secret = signingSecret();
  if (!secret || typeof token !== 'string') return null;
  const [body, suppliedSignature, extra] = token.split('.');
  if (!body || !suppliedSignature || extra) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(suppliedSignature, 'base64url');
  } catch {
    return null;
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ReviewTokenPayload;
    if (
      !payload ||
      !['concur', 'object', 'skipped'].includes(payload.verdict) ||
      typeof payload.reasoning !== 'string' ||
      !Number.isInteger(payload.requestedCount) ||
      !Number.isInteger(payload.reviewedCount) ||
      typeof payload.selectionFingerprint !== 'string' ||
      payload.selectionFingerprint.length !== 64 ||
      !Number.isFinite(payload.issuedAt) ||
      Date.now() - payload.issuedAt > REVIEW_TOKEN_TTL_MS ||
      payload.issuedAt > Date.now() + 60_000
    ) return null;
    return payload;
  } catch {
    return null;
  }
}

function skippedReview(
  reasoning: string,
  requestedCount: number,
  reviewedCount: number,
  evidenceResolvedCount: number,
): ManualLinkReview {
  const partial = reviewedCount < requestedCount;
  return {
    verdict: 'skipped',
    reasoning,
    rationale: 'AI unavailable',
    requestedCount,
    reviewedCount,
    evidenceResolvedCount,
    partial,
    warning: partial
      ? `AI reviewed the most recent ${reviewedCount} of ${requestedCount} selected items.`
      : null,
  };
}

// Always resolves. A failure returns `skipped`, so the editor flow never blocks.
export async function reviewManualLink(
  items: ManualLinkReviewItem[],
  selectionUrls: string[] = items.map((item) => item.url).filter((url): url is string => !!url),
): Promise<ManualLinkReview> {
  const cleaned = items.filter((it) => it && typeof it.title === 'string' && it.title.trim());
  const requestedCount = cleaned.length;
  const clean = selectRecentManualLinkReviewItems(cleaned);
  const reviewedCount = clean.length;
  const evidenceResolvedCount = clean.filter((it) => it.evidenceSource === 'server').length;

  if (requestedCount < 2) {
    return skippedReview('Need at least two items to review.', requestedCount, reviewedCount, evidenceResolvedCount);
  }
  if (!isAIConfigured()) {
    return skippedReview('AI review unavailable.', requestedCount, reviewedCount, evidenceResolvedCount);
  }

  try {
    const completion = manualLinkCompletionOverride ?? createPreferOpenRouter;
    const response = await withAiTimeout(
      completion(
        {
          model: 'gpt-4o',
          messages: [{ role: 'user', content: buildManualLinkReviewPrompt(clean) }],
          temperature: 0.1,
          max_tokens: 350,
          response_format: { type: 'json_object' },
        },
        {
          // One short source-level attempt. The shared client may transparently
          // use its other provider, but this call never advances through the
          // clustering model chain and the outer deadline always wins.
          timeout: MANUAL_LINK_REVIEW_REQUEST_TIMEOUT_MS,
          maxRetries: 0,
        },
      ),
      manualLinkReviewBackstopOverrideMs ?? MANUAL_LINK_REVIEW_BACKSTOP_MS,
      'curatedManualLink',
      { trackStorm: false },
    );
    const content = response.choices[0]?.message?.content?.trim();
    if (!content) {
      return skippedReview('AI review returned no content.', requestedCount, reviewedCount, evidenceResolvedCount);
    }
    let parsed: { verdict?: unknown; reasoning?: unknown; rationale?: unknown };
    try {
      const unfenced = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      parsed = JSON.parse(unfenced);
    } catch {
      return skippedReview('AI review reply could not be parsed.', requestedCount, reviewedCount, evidenceResolvedCount);
    }

    const verdict = parsed.verdict === 'concur' || parsed.verdict === 'object'
      ? parsed.verdict
      : 'skipped';
    if (verdict === 'skipped') {
      return skippedReview('AI review reply was malformed.', requestedCount, reviewedCount, evidenceResolvedCount);
    }
    const rationale = cleanText(parsed.rationale, 100) || 'Event-identity policy';
    const modelReasoning = cleanText(parsed.reasoning, 400);
    const reasoning = modelReasoning ? `${rationale}: ${modelReasoning}`.slice(0, 400) : rationale;
    const partial = reviewedCount < requestedCount;
    const review: ManualLinkReview = {
      verdict,
      rationale,
      reasoning,
      requestedCount,
      reviewedCount,
      evidenceResolvedCount,
      partial,
      warning: partial
        ? `AI opinion is based on the most recent ${reviewedCount} of ${requestedCount} selected items; the older ${requestedCount - reviewedCount} were not evaluated.`
        : evidenceResolvedCount < reviewedCount
          ? `Server evidence was unavailable for ${reviewedCount - evidenceResolvedCount} reviewed item(s); client display fields were used as fallback.`
          : null,
    };
    // Bind the token to the FULL requested selection, even when only the newest
    // REVIEW_LIMIT items were evaluated. This preserves honest partial-review
    // metadata while still letting the commit prove it is the same selection.
    // A partial verdict must never authenticate AI metadata for identities the
    // model did not see. The editor may still proceed; the commit route simply
    // records `skipped` because there is no server-issued token to accept.
    if (!review.partial) {
      review.reviewToken = issueManualLinkReviewToken(
        review,
        selectionUrls.map((url) => ({ title: '', url })),
      );
    }
    return review;
  } catch (err) {
    if (isTransientAIError(err)) {
      return skippedReview('AI review temporarily unavailable.', requestedCount, reviewedCount, evidenceResolvedCount);
    }
    console.error('[CuratedManualLink] AI review error:', err);
    return skippedReview('AI review failed.', requestedCount, reviewedCount, evidenceResolvedCount);
  }
}