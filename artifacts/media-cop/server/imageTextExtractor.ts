import { openai } from './aiClient';
import { withAiTimeout, AI_CALL_TIMEOUT_MS, AI_CALL_BACKSTOP_MS } from './aiTimeout';
import { fetchImageAsDataUrl } from './streamPrefetch';


export interface ImageAnalysisResult {
  isTextContent: boolean;
  contentType: "screenshot_retweet" | "text_message" | "regular_image";
  extractedText: string | null;
}

// In-memory "tried and failed" back-off for image downloads (Task #428).
// When a host blocks the OCR download (400/403, SSRF-refused, timeout, or a
// non-image content type), fetchImageAsDataUrl returns null and the post is
// skipped as a "regular image". Without this, the SAME broken image URLs are
// re-fetched on every scrape cycle, wasting outbound requests. We remember the
// failures and apply an escalating back-off (mirroring the curated enrichment
// back-off in streamPrefetch), then give up after a cap. A successful download
// clears the entry so a later-recovered host is OCR'd normally.
const FETCH_BACKOFF_BASE_MS = 30 * 60 * 1000; // 30 min per attempt, escalating
const FETCH_BACKOFF_MAX_ATTEMPTS = 5; // stop retrying after this many failures
const FETCH_GIVE_UP_MS = 24 * 60 * 60 * 1000; // back-off applied once cap is hit
// Bound the map so a long-lived process meeting many unique broken image URLs
// can't grow it without limit (memory-constrained VM). Map insertion order = age,
// so evicting the first key is a cheap LRU-ish trim.
const MAX_TRACKED_FAILURES = 2000;
const imageFetchFailures = new Map<string, { count: number; lastAttempt: number }>();

function shouldSkipFailedImageFetch(imageUrl: string): boolean {
  const entry = imageFetchFailures.get(imageUrl);
  if (!entry) return false;
  const elapsed = Date.now() - entry.lastAttempt;
  const window = entry.count >= FETCH_BACKOFF_MAX_ATTEMPTS
    ? FETCH_GIVE_UP_MS
    : entry.count * FETCH_BACKOFF_BASE_MS;
  return elapsed < window;
}

function recordImageFetchFailure(imageUrl: string): void {
  const entry = imageFetchFailures.get(imageUrl);
  // Re-insert (delete first) so a refreshed entry moves to the tail = newest.
  imageFetchFailures.delete(imageUrl);
  imageFetchFailures.set(imageUrl, {
    count: (entry?.count ?? 0) + 1,
    lastAttempt: Date.now(),
  });
  // Trim the oldest entry when over the cap so the map stays bounded.
  if (imageFetchFailures.size > MAX_TRACKED_FAILURES) {
    const oldest = imageFetchFailures.keys().next().value;
    if (oldest !== undefined) imageFetchFailures.delete(oldest);
  }
}

export async function analyzePostImage(imageUrl: string, postContent: string): Promise<ImageAnalysisResult> {
  try {
    // Skip image URLs whose download has repeatedly failed recently (Task #428)
    // so we don't re-fetch a known-broken host on every scrape cycle.
    if (shouldSkipFailedImageFetch(imageUrl)) {
      return { isTextContent: false, contentType: "regular_image", extractedText: null };
    }

    // Vision OCR providers (OpenRouter primary + Anthropic fallback) reject a
    // remote image URL ("URL sources are not supported"), so inline the bytes as
    // a base64 data URL. Fetched through the SSRF-hardened image path; on any
    // failure we skip gracefully (treated as a regular, non-text image).
    const dataUrl = await fetchImageAsDataUrl(imageUrl);
    if (!dataUrl) {
      recordImageFetchFailure(imageUrl);
      return { isTextContent: false, contentType: "regular_image", extractedText: null };
    }
    // Download succeeded — clear any prior failure back-off for this URL.
    imageFetchFailures.delete(imageUrl);

    const response = await withAiTimeout(openai.chat.completions.create({
      model: "gpt-4o-vision",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Analyze this image from a Truth Social post by Donald Trump. The post's text content is: "${postContent || "(no text)"}"

Classify this image into ONE of these categories:
1. "screenshot_retweet" - A screenshot of another person's social media post, tweet, or truth. This includes screenshots of posts from Twitter/X, Truth Social, Facebook, Instagram, or any other social platform being shared as a retweet/reshare.
2. "text_message" - A screenshot of text used to communicate a message, such as a letter, statement, press release, document, legal filing, news article screenshot, or any image that primarily contains readable text meant to convey information.
3. "regular_image" - A regular photograph, meme with minimal text, graphic, logo, rally photo, portrait, infographic, chart, or any image where the primary content is visual rather than textual.

Rules:
- Only classify as "screenshot_retweet" if the image clearly shows a social media post interface (profile picture, username, timestamp, engagement metrics).
- Only classify as "text_message" if the image is primarily text-based content meant to be read (documents, statements, letters, screenshots of articles).
- If the image is a meme with some text overlay on a photo, classify as "regular_image".
- If unsure, default to "regular_image".

Respond in JSON format:
{
  "contentType": "screenshot_retweet" | "text_message" | "regular_image",
  "extractedText": "The full text content extracted from the image if contentType is screenshot_retweet or text_message, otherwise null"
}

If contentType is "screenshot_retweet", include the author/username if visible, then the full post text.
If contentType is "text_message", extract all readable text from the document/statement.
For "regular_image", set extractedText to null.`,
            },
            {
              type: "image_url",
              image_url: {
                url: dataUrl,
                detail: "high",
              },
            },
          ],
        },
      ],
      max_tokens: 2000,
      temperature: 0.1,
      response_format: { type: "json_object" },
    }, { timeout: AI_CALL_TIMEOUT_MS, maxRetries: 0 }), AI_CALL_BACKSTOP_MS, 'imageTextExtractor');

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return { isTextContent: false, contentType: "regular_image", extractedText: null };
    }

    const parsed = JSON.parse(content);
    const contentType = parsed.contentType || "regular_image";
    const isTextContent = contentType === "screenshot_retweet" || contentType === "text_message";

    return {
      isTextContent,
      contentType,
      extractedText: isTextContent ? (parsed.extractedText || null) : null,
    };
  } catch (error) {
    console.error("[ImageTextExtractor] Error analyzing image:", error);
    return { isTextContent: false, contentType: "regular_image", extractedText: null };
  }
}

export async function processPostImages(posts: Array<{ postId: string; imageUrl: string | null; content: string }>): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  const postsWithImages = posts.filter(p => p.imageUrl && p.imageUrl.length > 0);

  if (postsWithImages.length === 0) {
    return results;
  }

  console.log(`[ImageTextExtractor] Analyzing ${postsWithImages.length} posts with images...`);

  for (const post of postsWithImages) {
    try {
      const analysis = await analyzePostImage(post.imageUrl!, post.content);

      if (analysis.isTextContent && analysis.extractedText) {
        console.log(`[ImageTextExtractor] Post ${post.postId}: Detected ${analysis.contentType}, extracted ${analysis.extractedText.length} chars`);
        results.set(post.postId, analysis.extractedText);
      } else {
        console.log(`[ImageTextExtractor] Post ${post.postId}: Regular image, skipping`);
      }
    } catch (error) {
      console.error(`[ImageTextExtractor] Error processing post ${post.postId}:`, error);
    }
  }

  console.log(`[ImageTextExtractor] Completed: ${results.size}/${postsWithImages.length} posts had extractable text`);
  return results;
}
