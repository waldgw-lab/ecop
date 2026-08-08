import { openai, isAIConfigured } from './aiClient';
import type { InsertArticleQuote } from '@shared/schema';


interface ExtractedQuote {
  quote_text: string;
  speaker_name: string;
  normalized_speaker: string;
  speaker_title: string | null;
  location: string | null;
  event: string | null;
  subject_tags: string[];
  context: string;
}

const SYSTEM_PROMPT = `You are an expert data extraction API. Your sole purpose is to extract direct and indirect quotes from the provided news article text and return the data strictly as a JSON array. Do not include any conversational filler, introductory text, or markdown formatting (such as \`\`\`json) in your response.

For every quote found in the text, create a JSON object following these strict rules: 1. quote_text: The exact quote text. 2. speaker_name: The name or title of the speaker exactly as written in the text. 3. normalized_speaker: Resolve the speaker to their actual full name to ensure database consistency (e.g., resolving 'the Chairman' or 'SecWar' to their actual names). 4. speaker_title: The speaker's title or role as identified in the article (e.g., 'President of the United States', 'Secretary of Defense', 'NATO Secretary General'). If not mentioned, set to null. 5. location: The physical location where the statement was made (e.g., 'Pentagon Briefing Room', 'the White House'). If not mentioned, set to null. 6. event: The event or occasion where the statement was made (e.g., 'White House press briefing', 'Senate Armed Services Committee hearing', 'NATO summit'). If not mentioned, set to null. 7. subject_tags: An array of 1-3 concise topic tags relevant to the quote (e.g., ['defense spending', 'NATO']). 8. context: A single sentence summarizing the context in which the quote was made.

Required Output Schema: [ { "quote_text": "string", "speaker_name": "string", "normalized_speaker": "string", "speaker_title": "string" | null, "location": "string" | null, "event": "string" | null, "subject_tags": ["string"], "context": "string" } ]

If no quotes are found in the text, return an empty array: []`;

export async function extractQuotesFromArticle(
  storyId: string,
  fullText: string,
  sourceUrl: string,
  publishedAt: Date | null
): Promise<InsertArticleQuote[]> {
  if (!isAIConfigured()) {
    console.log('Quote extraction skipped: AI not configured');
    return [];
  }

  if (!fullText || fullText.trim().length < 100) {
    return [];
  }

  const truncatedText = fullText.substring(0, 12000);

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: truncatedText },
    ],
    temperature: 0.1,
    max_tokens: 4096,
  });

  const responseText = completion.choices[0]?.message?.content?.trim();
  if (!responseText) return [];

  let parsed: ExtractedQuote[];
  try {
    const cleaned = responseText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    console.error('Quote extraction: failed to parse JSON response for story', storyId);
    return [];
  }

  if (!Array.isArray(parsed) || parsed.length === 0) return [];

  return parsed
    .filter(q => q.quote_text && q.speaker_name && q.normalized_speaker && q.context)
    .map(q => ({
      quoteText: q.quote_text,
      speakerName: q.speaker_name,
      normalizedSpeaker: q.normalized_speaker,
      speakerTitle: q.speaker_title || null,
      location: q.location || null,
      event: q.event || null,
      subjectTags: Array.isArray(q.subject_tags) ? q.subject_tags : [],
      context: q.context,
      sourceUrl,
      dateSpoken: publishedAt,
      storyId,
    }));
}
