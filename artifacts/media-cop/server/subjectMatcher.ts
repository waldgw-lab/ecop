import { openai } from './aiClient';
import { withAiTimeout, AI_CALL_TIMEOUT_MS, AI_CALL_BACKSTOP_MS } from './aiTimeout';
import { storage } from './storage';


// Predefined topics that should be seeded on startup
export const PREDEFINED_TOPICS = [
  { name: 'FLASH: TOP STORIES', description: 'High-priority stories (66+ score) from the last 12 hours' },
  { name: 'MOST RECENT', description: 'All stories and posts from the past 3 hours' },
  { name: 'CJCS MENTIONS', description: 'Stories mentioning Chairman General Dan Caine (CJCS)' },
  { name: 'MATA / OSINT SOCIAL MEDIA', description: 'MATA/OSINT social media posts for flight tracking and intelligence' },
  { name: 'Domestic', description: 'US domestic news and politics' },
  { name: 'Venezuela', description: 'News related to Venezuela' },
  { name: 'Iran', description: 'News related to Iran' },
  { name: 'Greenland', description: 'News related to Greenland' },
  { name: 'Russia / Ukraine', description: 'News related to Russia, Ukraine, and the war' },
  { name: 'Israel', description: 'News related to Israel' },
  { name: 'China', description: 'News related to China and Indo-Pacific' },
  { name: 'Middle East', description: 'News related to the Middle East region' },
  { name: 'Europe', description: 'News related to Europe' },
  { name: 'Arctic', description: 'News related to the Arctic region' },
  { name: 'India', description: 'News related to India' },
  { name: 'Africa', description: 'News related to Africa' },
  { name: 'Mexico / South America', description: 'News related to Mexico and South America' },
  { name: 'Emerging', description: 'New topics that do not fit other categories' },
];

export const FLASH_TOPIC_NAME = 'FLASH: TOP STORIES';
export const FLASH_PRIORITY_THRESHOLD = 66;
export const FLASH_MAX_HOURS = 12;
export const FLASH_MAX_NEWS = 8;
export const FLASH_MAX_SOCIAL = 8;

/**
 * Pure predicate for the FLASH "TOP STORIES" highlight surface. An item earns a
 * FLASH placement only when its priority score clears FLASH_PRIORITY_THRESHOLD
 * (66). This is the SEPARATE, stricter bar from the main-feed auto-promotion bar
 * (MAIN_FEED_PROMOTION_THRESHOLD, 50, in relevanceDefinition.ts): a moderate
 * 50-65 item belongs on the main feed but NOT in the FLASH reel. Keeping this
 * keyed off its own constant ensures the two bars never re-conflate.
 */
export function qualifiesForFlashTopStories(score: number | undefined | null): boolean {
  return typeof score === 'number' && Number.isFinite(score) && score >= FLASH_PRIORITY_THRESHOLD;
}

export const CJCS_TOPIC_NAME = 'CJCS MENTIONS';
export const MATA_OSINT_TOPIC_NAME = 'MATA / OSINT SOCIAL MEDIA';
export const MOST_RECENT_TOPIC_NAME = 'MOST RECENT';
export const MOST_RECENT_HOURS = 3;

/**
 * Quick keyword check for potential Chairman Caine mentions
 * Returns true if the text might contain a CJCS mention (needs AI verification)
 */
function quickCaineCheck(text: string): boolean {
  const lowerText = text.toLowerCase();
  
  // Exclude false positives first
  if (lowerText.includes('cocaine') || lowerText.includes('sugar cane') || lowerText.includes('candy cane')) {
    // Check if there's an actual Caine mention beyond the false positive
    const withoutFalsePositives = lowerText
      .replace(/cocaine/g, '')
      .replace(/sugar cane/g, '')
      .replace(/candy cane/g, '');
    if (!withoutFalsePositives.includes('caine') && !withoutFalsePositives.includes('kaine') && !withoutFalsePositives.includes(' kane')) {
      return false;
    }
  }
  
  // Keywords that suggest Chairman Caine mention
  const keywords = [
    'caine', 'kaine', ' kane',
    'cjcs', 'chairman of the joint',
    'joint chiefs', 'dan caine', 'dan kaine',
    'general caine', 'gen caine', 'gen. caine',
    'chairman caine', 'chairman kaine',
    'raizin caine', 'raisin caine', 'raizin kaine', 'raisin kaine'
  ];
  
  return keywords.some(kw => lowerText.includes(kw));
}

/**
 * Use AI to verify if text mentions Chairman General Dan Caine (CJCS)
 * Handles various spellings: Caine, Kaine, Kane, Raizin Caine, etc.
 */
export async function detectCJCSMention(headline: string, summary?: string): Promise<boolean> {
  const text = summary ? `${headline} ${summary}` : headline;
  
  // Quick keyword check first to avoid unnecessary API calls
  if (!quickCaineCheck(text)) {
    return false;
  }
  
  try {
    const response = await withAiTimeout(openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You determine if text mentions Chairman General Dan Caine, the Chairman of the Joint Chiefs of Staff (CJCS).

VALID MENTIONS include:
- "Chairman Caine", "General Caine", "Gen Caine", "Gen. Caine"
- "Dan Caine", "Daniel Caine"
- Various spellings: "Kaine", "Kane" when referring to the CJCS
- "Raizin Caine" or "Raisin Caine" (nickname)
- "CJCS" when clearly referring to Chairman Caine
- Any reference to the current Chairman of the Joint Chiefs of Staff

FALSE POSITIVES to REJECT:
- "cocaine" (the drug)
- "sugar cane" or "candy cane" (plants/candy)
- Tim Kaine (the senator)
- Other people named Caine/Kane/Kaine not referring to the CJCS
- Kane (WWE wrestler)
- Citizen Kane (movie)

Return JSON: {"mentionsCJCS": boolean, "reason": "brief explanation"}`
        },
        {
          role: 'user',
          content: `Does this text mention Chairman General Dan Caine (CJCS)?\n\nText: ${text}`
        }
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }, { timeout: AI_CALL_TIMEOUT_MS, maxRetries: 0 }), AI_CALL_BACKSTOP_MS, 'detectCJCSMention');

    const content = response.choices[0]?.message?.content;
    if (!content) return false;

    let parsed: { mentionsCJCS?: boolean; reason?: string };
    try {
      parsed = JSON.parse(content);
    } catch (parseError) {
      console.error('[CJCS] Malformed AI response - JSON parse failed. Raw:', content.slice(0, 300), parseError);
      return false;
    }
    if (parsed.mentionsCJCS) {
      console.log(`[CJCS] Detected mention: ${parsed.reason}`);
    }
    return parsed.mentionsCJCS === true;
  } catch (error) {
    console.error('[CJCS] AI call failed for detectCJCSMention:', error);
  }
  
  return false;
}

interface MatchResult {
  subjectName: string;
  isExisting: boolean;
}

/**
 * Ensure all predefined topics exist in the database
 */
export async function seedPredefinedTopics(): Promise<void> {
  console.log('[Topics] Seeding predefined topics...');
  
  for (const topic of PREDEFINED_TOPICS) {
    const existing = await storage.getSubjectByName(topic.name);
    if (!existing) {
      await storage.addSubject({
        name: topic.name,
        description: topic.description,
        origin: 'manual',
        createdBy: 'system',
      });
      console.log(`[Topics] Created predefined topic: ${topic.name}`);
    }
  }
  
  console.log('[Topics] Predefined topics seeding complete');
}

/**
 * Match an article to an existing topic. Always returns an existing topic.
 * Only matches against predefined topics and user-created topics (origin = 'manual'),
 * not old AI-generated topics.
 * If no match found, returns "Emerging" as the fallback.
 */
export async function matchOrCreateSubject(
  title: string,
  summary: string,
  botName: string
): Promise<MatchResult> {
  const allSubjects = await storage.getAllSubjects();
  
  // Filter to only include predefined and user-created topics (origin = 'manual')
  // Exclude special virtual topics that have their own assignment logic
  const SPECIAL_TOPICS = ['FLASH: TOP STORIES', 'MOST RECENT', 'CJCS MENTIONS', 'MATA / OSINT SOCIAL MEDIA'];
  const predefinedNames = PREDEFINED_TOPICS.map(t => t.name.toLowerCase());
  const existingSubjects = allSubjects.filter(s => 
    (s.origin === 'manual' || predefinedNames.includes(s.name.toLowerCase())) &&
    !SPECIAL_TOPICS.includes(s.name)
  );
  
  // Ensure we have topics to match against
  if (existingSubjects.length === 0) {
    await seedPredefinedTopics();
    return { subjectName: 'Emerging', isExisting: true };
  }

  try {
    const response = await withAiTimeout(openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You match news articles to existing topic categories. Return the INDEX number of the best matching topic.

EXISTING TOPICS (return the number, not the name):
${existingSubjects.map((s, i) => `${i}: ${s.name}`).join('\n')}

MATCHING RULES (IN ORDER OF PRIORITY):

**PRIORITY 1 - OP-ED DETECTION (CHECK THIS FIRST):**
Before determining the topic, first evaluate if this is an OPINION piece vs actual news:
- Op-Eds, opinion columns, editorials, commentary, analysis with clear author viewpoint → "Op-Ed"
- Look for signals: "Opinion:", author bylines with "columnist", persuasive language, first-person perspective, calls to action
- Headlines with subjective language ("should", "must", "why we need to", "the case for/against") are often Op-Eds
- If it IS an Op-Ed, assign to "Op-Ed" topic REGARDLESS of what country/topic the opinion is about

**PRIORITY 2 - TOPIC MATCHING (only if NOT an Op-Ed):**
1. Match articles to the topic that best represents the PRIMARY subject of the article
2. Geographic matching: articles about Tehran → "Iran", articles about Beijing/Xi Jinping → "China", articles about Caracas → "Venezuela"
3. War/conflict: Ukraine/Russia conflict → "Russia / Ukraine", Gaza/Hamas/Israeli operations → "Israel"
4. "Domestic" = US DOMESTIC matters only (Congress, US elections, Pentagon internal affairs). NOT foreign leaders meeting with US officials.
5. If article is primarily about a foreign country/leader (even if US is mentioned), use that country's topic, not "Domestic"
6. If the article genuinely doesn't fit ANY existing topic, use "Emerging" (find its index)
7. ALWAYS return a valid index - never return -1

Return JSON: {"isOpEd": boolean, "matchIndex": number, "reason": "brief explanation"}
- isOpEd: true if this is an opinion piece/editorial, false if it's a news story
- matchIndex: the index number (0-${existingSubjects.length - 1}) of the matching topic
- reason: brief explanation of why this topic was chosen`
        },
        {
          role: 'user',
          content: `Match this article to a topic:\nTitle: ${title}\nSummary: ${summary}`
        }
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }, { timeout: AI_CALL_TIMEOUT_MS, maxRetries: 0 }), AI_CALL_BACKSTOP_MS, 'matchOrCreateSubject');

    const content = response.choices[0]?.message?.content;
    if (!content) {
      console.warn(`[${botName}] Empty AI response for topic matching`);
      return { subjectName: 'Emerging', isExisting: true };
    }

    let parsed: { isOpEd?: boolean; matchIndex?: number; reason?: string };
    try {
      parsed = JSON.parse(content);
    } catch (parseError) {
      console.error(`[${botName}] Malformed AI response - JSON parse failed. Raw:`, content.slice(0, 300), parseError);
      return { subjectName: 'Emerging', isExisting: true };
    }

    // If AI detected this as an Op-Ed, enforce routing to Op-Ed topic regardless of matchIndex
    if (parsed.isOpEd === true) {
      const opEdTopic = existingSubjects.find(s => s.name === 'Op-Ed');
      if (opEdTopic) {
        console.log(`[${botName}] Op-Ed detected - routing to "Op-Ed" topic - ${parsed.reason || 'opinion piece detected'}`);
        return { subjectName: 'Op-Ed', isExisting: true };
      }
      // If Op-Ed topic doesn't exist (shouldn't happen), fall through to normal matching
      console.warn(`[${botName}] Op-Ed detected but Op-Ed topic not found, using matchIndex`);
    }

    if (typeof parsed.matchIndex === 'number' && parsed.matchIndex >= 0 && parsed.matchIndex < existingSubjects.length) {
      const matched = existingSubjects[parsed.matchIndex];
      console.log(`[${botName}] Matched to topic: "${matched.name}" - ${parsed.reason || 'no reason provided'}`);
      return { subjectName: matched.name, isExisting: true };
    }
  } catch (error) {
    console.error(`[${botName}] AI call failed for matchOrCreateSubject:`, error);
  }

  // Fallback to "Emerging" if AI matching fails
  console.log(`[${botName}] Fallback to "Emerging" topic`);
  return { subjectName: 'Emerging', isExisting: true };
}
