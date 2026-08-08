import { openai } from './aiClient';


interface FilterResult {
  include: boolean;
  reason: string;
}

export async function shouldSendAlert(post: {
  content: string;
  imageUrl?: string | null;
  extractedImageText?: string | null;
  isReblog?: boolean;
  rebloggedFrom?: string | null;
  truthSocialUrl?: string;
}): Promise<FilterResult> {
  const content = (post.content || "").trim();
  const hasImage = !!post.imageUrl;
  const hasExtractedText = !!(post.extractedImageText && post.extractedImageText.trim().length > 0);

  const textWithoutUrls = content.replace(/https?:\/\/[^\s]+/g, "").trim();
  const meaningfulTextLength = textWithoutUrls.replace(/\s+/g, "").length;

  if (meaningfulTextLength > 20) {
    return { include: true, reason: "Post contains meaningful text content" };
  }

  if (post.isReblog && meaningfulTextLength > 0) {
    return { include: true, reason: "ReTruth with added commentary" };
  }

  if (meaningfulTextLength === 0 && !hasImage) {
    return { include: false, reason: "Empty post with no content or media" };
  }

  if (meaningfulTextLength === 0 && hasImage && !hasExtractedText) {
    return { include: false, reason: "Standalone image with no text content" };
  }

  if (meaningfulTextLength > 0 && meaningfulTextLength <= 20 && content.match(/^https?:\/\/[^\s]+$/)) {
    return { include: false, reason: "Post is only a bare URL with no commentary" };
  }

  if (hasExtractedText && post.extractedImageText!.trim().length > 30) {
    return { include: true, reason: "Image contains substantial extracted text" };
  }

  try {
    const postDescription = [
      `Post text: "${content}"`,
      hasImage ? "Post includes an image." : "",
      hasExtractedText ? `Text extracted from image: "${post.extractedImageText}"` : "",
      post.isReblog ? `This is a ReTruth (repost) from: ${post.rebloggedFrom || "unknown"}` : "",
    ].filter(Boolean).join("\n");

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: `You are filtering POTUS Truth Social posts for SMS alerts to military leadership. INCLUDE posts that contain: policy statements, personnel announcements, military/defense commentary, foreign policy remarks, executive orders/actions, direct statements or opinions from POTUS on any topic, endorsements, or any substantive communication. EXCLUDE posts that are: standalone promotional images with no policy substance, bare links to external articles with zero commentary, purely decorative/campaign graphics with no text message. When in doubt, INCLUDE the post — it is better to send an extra alert than to miss an important one. Respond with JSON only: {"include": true/false, "reason": "brief explanation"}`
        },
        {
          role: "user",
          content: postDescription
        }
      ],
    });

    const text = response.choices[0]?.message?.content || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as FilterResult;
      return parsed;
    }

    return { include: true, reason: "AI filter returned unclear response, defaulting to include" };
  } catch (error) {
    console.error("[SMS Filter] AI filter error, defaulting to include:", error);
    return { include: true, reason: "AI filter error, defaulting to include" };
  }
}
