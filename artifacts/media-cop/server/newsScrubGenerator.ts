import { db } from "./db";
import { teamSubmissions, teamSubjects } from "@shared/schema";
import { eq, and, gte, lte, isNull, desc } from "drizzle-orm";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink, AlignmentType } from "docx";
import Anthropic from '@anthropic-ai/sdk';
import { formatInTimeZone } from "date-fns-tz";
import { stripBriefingPreamble } from './summarySanitizer';
import { assertAIIntegrationsEnabled } from './aiClient';

let anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  assertAIIntegrationsEnabled();
  if (!anthropic) {
    anthropic = new Anthropic({
      apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
    });
  }
  return anthropic;
}

export interface SubmissionWithTopic {
  id: string;
  headline: string;
  summary: string;
  fullText: string | null;
  sourceUrl: string;
  sourceName: string | null;
  sourceType: string;
  priorityScore: number;
  publishedAt: Date | null;
  createdAt: Date;
  topicName: string;
}

// Keywords that indicate a story is about US National Guard / Domestic Operations
const DOMESTIC_OPS_KEYWORDS = [
  "national guard", "guard deployment", "guard troops", "guard soldiers",
  "domestic deployment", "state guard", "guard training", "guard exercise",
  "governor deploy", "governor mobilize", "insurrection act",
  "civil unrest response", "domestic emergency", "state of emergency deployment",
  "guard activated", "guard activation", "guard unit", "guard forces",
  "minnesota guard", "texas guard", "california guard", "florida guard",
  "ohio guard", "new york guard", "illinois guard", "pennsylvania guard"
];

// Keywords that indicate Global IE stories (military, instability, wars, major international events)
const GLOBAL_KEYWORDS = [
  "nato", "un security council", "united nations", "european union", "eu",
  "china", "russia", "iran", "north korea", "ukraine", "israel", "gaza", 
  "taiwan", "india", "pakistan", "syria", "iraq", "afghanistan", "yemen",
  "arctic", "baltic", "south china sea", "red sea", "suez",
  "military exercise", "war", "conflict", "invasion", "airstrike", "bombing",
  "missile", "nuclear", "sanctions", "trade war", "diplomatic",
  "alliance", "treaty", "ceasefire", "peace deal", "hostage", "terrorism",
  "global instability", "coup", "martial law", "civil war", "insurgency",
  "g7", "g20", "summit", "foreign policy", "international relations"
];

// Keywords for Pentagon/National Security stories
const PENTAGON_NATSEC_KEYWORDS = [
  "pentagon", "defense department", "dod", "secretary of defense", "secdef",
  "secretary of war", "secwar", "joint chiefs", "chairman", "centcom",
  "indo-pacom", "eucom", "africom", "northcom", "southcom", "socom", "cybercom",
  "space force", "army", "navy", "air force", "marines", "coast guard",
  "cia", "nsa", "intelligence", "classified", "security clearance",
  "defense budget", "military spending", "weapons system", "procurement",
  "veterans", "military personnel", "troops", "soldiers", "service members",
  "military base", "doge cuts", "defense cuts", "military readiness"
];

// Stories to exclude from all categories
const EXCLUSION_KEYWORDS = [
  "celebrity gossip", "entertainment news", "sports scores", "movie review",
  "music video", "album release", "concert tour", "streaming service",
  "netflix", "recipe", "fashion week", "dating app", "reality tv"
];

export function categorizeSubmission(submission: SubmissionWithTopic): string {
  if (submission.sourceType === 'social_media') {
    return "Social Media";
  }
  
  const text = `${submission.headline} ${submission.summary} ${submission.topicName}`.toLowerCase();
  
  // Check for exclusions
  for (const exclusion of EXCLUSION_KEYWORDS) {
    if (text.includes(exclusion.toLowerCase())) {
      return "Excluded";
    }
  }
  
  // Check for Domestic Ops (National Guard focused)
  for (const keyword of DOMESTIC_OPS_KEYWORDS) {
    if (text.includes(keyword.toLowerCase())) {
      return "Domestic Operations IE";
    }
  }
  
  // Check for Global IE (international military/instability)
  for (const keyword of GLOBAL_KEYWORDS) {
    if (text.includes(keyword.toLowerCase())) {
      return "Global IE";
    }
  }
  
  // Check for Pentagon/NatSec
  for (const keyword of PENTAGON_NATSEC_KEYWORDS) {
    if (text.includes(keyword.toLowerCase())) {
      return "Pentagon/NATSEC";
    }
  }
  
  // Default to Pentagon/NATSEC for remaining military-adjacent stories
  return "Pentagon/NATSEC";
}

async function generateRelevantSocialMedia(socialPosts: SubmissionWithTopic[]): Promise<string> {
  if (socialPosts.length === 0) return "";
  
  const sortedPosts = [...socialPosts].sort((a, b) => b.priorityScore - a.priorityScore);
  
  const potusPosts = sortedPosts.filter(s => {
    const name = s.sourceName?.toLowerCase() || '';
    return name.includes('potus') || name.includes('truth') || name.includes('trump') || name.includes('realdonaldtrump');
  });
  
  const leadershipPosts = sortedPosts.filter(s => {
    const name = s.sourceName?.toLowerCase() || '';
    return name.includes('secwar') || name.includes('hegseth') || name.includes('rapid') || 
           name.includes('dow') || name.includes('pete') || name.includes('press secretary');
  });
  
  const otherPosts = sortedPosts.filter(s => {
    return !potusPosts.includes(s) && !leadershipPosts.includes(s);
  });
  
  const topPotusPosts = potusPosts.slice(0, 5);
  const topLeadershipPosts = leadershipPosts.slice(0, 3);
  const topOtherPosts = otherPosts.slice(0, 2);
  
  const allPostsContent = [
    ...topPotusPosts.map(p => `POTUS (Truth Social): "${p.fullText || p.headline}"`),
    ...topLeadershipPosts.map(p => `Senior Administration (${p.sourceName}): "${p.fullText || p.headline}"`),
    ...topOtherPosts.map(p => `${p.sourceName}: "${p.fullText || p.headline}"`)
  ].join('\n\n');
  
  if (!allPostsContent.trim()) return "";
  
  const prompt = `You are writing the "Relevant Social Media" section of a defense-news intelligence brief.

Based on the following social media posts, write 2-3 paragraphs summarizing the most significant activity.

Format requirements:
- First paragraph: POTUS social media activity, starting with "POTUS social media activity included..."
- Second paragraph: Senior Administration activity (if any), starting with "Senior Administration SM amplified..." or similar
- Include direct quotes when impactful
- Focus on national security, military, and foreign policy relevance
- Write only the section prose: no heading, no title, no label, no preamble, and never name or address an audience or state who the brief is for
- Write in professional intelligence briefing style

Social media posts:
${allPostsContent}

Write the "Relevant Social Media" section:`;

  try {
    const response = await getAnthropic().messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });
    
    const textContent = response.content.find(c => c.type === 'text');
    return textContent?.text?.trim() || "";
  } catch (error) {
    console.error("Error generating social media summary:", error);
    return "";
  }
}

async function generateBLUF(categorizedStories: Record<string, SubmissionWithTopic[]>, toDate: Date): Promise<string> {
  const globalStories = categorizedStories["Global IE"]?.slice(0, 3) || [];
  const pentagonStories = categorizedStories["Pentagon/NATSEC"]?.slice(0, 3) || [];
  const domesticStories = categorizedStories["Domestic Operations IE"]?.slice(0, 2) || [];
  
  const allTopStories = [
    ...globalStories.map(s => `[GLOBAL] ${s.headline}: ${s.summary}`),
    ...pentagonStories.map(s => `[PENTAGON/NATSEC] ${s.headline}: ${s.summary}`),
    ...domesticStories.map(s => `[DOMESTIC OPS] ${s.headline}: ${s.summary}`)
  ].join('\n');

  const toTime = formatInTimeZone(toDate, 'America/New_York', 'HHmm');
  
  const hasGlobal = globalStories.length > 0;
  const hasPentagon = pentagonStories.length > 0;
  const hasDomestic = domesticStories.length > 0;
  
  const prompt = `You are writing a "Bottom Line Up Front" (BLUF) summary for a defense-news intelligence brief.

Based on these categorized stories, write a BLUF paragraph that covers ALL THREE categories.

Format: "As of ${toTime}, the Global IE was dominated by [1-2 sentence summary of Global IE top stories]. In the Pentagon/NATSEC IE, [1 sentence about Pentagon/NATSEC stories]. In the Domestic Operations IE, [1 sentence about Domestic Ops stories OR 'nothing to report' if no stories]."

Requirements:
- You MUST include a sentence about each of the three categories: Global IE, Pentagon/NATSEC, and Domestic Operations IE
- If a category has no stories, say "nothing to report" or "NSTR" (nothing significant to report) for that category
- Be specific about what the top stories are about
- DO NOT say "this would be of interest to senior military leadership" or similar phrases
- Write in professional intelligence briefing style
- Keep it concise but cover all categories

Stories by category:
${allTopStories}
${!hasGlobal ? '[GLOBAL] No stories' : ''}
${!hasPentagon ? '[PENTAGON/NATSEC] No stories' : ''}
${!hasDomestic ? '[DOMESTIC OPS] No stories' : ''}

Write only the BLUF paragraph:`;

  try {
    const response = await getAnthropic().messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });
    
    const textContent = response.content.find(c => c.type === 'text');
    return textContent?.text?.trim() || "Unable to generate BLUF summary.";
  } catch (error) {
    console.error("Error generating BLUF:", error);
    return "Unable to generate BLUF summary due to an error.";
  }
}

async function generateDetailedSummary(submissions: SubmissionWithTopic[], categoryName: string): Promise<string> {
  if (submissions.length === 0) return "";
  
  const topSubmission = submissions.sort((a, b) => b.priorityScore - a.priorityScore)[0];
  
  const articlesWithFullText = submissions
    .filter(s => s.fullText && s.fullText.length > 100)
    .slice(0, 3);
  
  let articleContent: string;
  if (articlesWithFullText.length > 0) {
    articleContent = articlesWithFullText.map(s => 
      `--- ${s.headline} (${s.sourceName || 'Unknown Source'}) ---\n${s.fullText?.substring(0, 2500) || s.summary}`
    ).join('\n\n');
  } else {
    articleContent = submissions.map(s => `- ${s.headline}: ${s.summary}`).join('\n');
  }
  
  const prompt = `You are writing the "Key Information" section for an intelligence brief on this story.

Main headline: ${topSubmission.headline}

${articlesWithFullText.length > 0 ? 'Full Article Content:' : 'Related coverage:'}
${articleContent}

Write 4-6 bullet points of key information. Each bullet should:
- Be 1-2 sentences with specific facts: names, numbers, dates, locations
- Include direct quotes from officials when available (use quotation marks)
- Focus on factual reporting, not analysis
- Be plain prose only: no heading, no title, no label, no preamble, and never name or address an audience or state who the brief is for
- DO NOT include phrases like "this would be of interest to senior military leadership" or "relevant to military leadership"
- Present facts objectively without commenting on their importance

CRITICAL RULES:
- NEVER apologize for missing information or paywall limitations
- NEVER include phrases like "I apologize", "I cannot", "the article doesn't provide", "I need to see", "Could you please provide"
- NEVER ask questions or request clarification in your output
- If you don't have complete information, simply write what you DO know - do not mention what's missing
- Write ONLY factual bullet points based on available information

Start each bullet with a dash (-):`;

  try {
    const response = await getAnthropic().messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });
    
    const textContent = response.content.find(c => c.type === 'text');
    return textContent?.text?.trim() || "";
  } catch (error) {
    console.error("Error generating detailed summary:", error);
    return topSubmission.summary;
  }
}

function extractKeyEntities(text: string): string[] {
  const words = text.toLowerCase().split(/\s+/);
  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'but', 'with', 'as', 'by', 'from', 'that', 'this', 'it', 'its', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall']);
  return words.filter(w => w.length > 3 && !stopWords.has(w));
}

function groupByStory(submissions: SubmissionWithTopic[]): Map<string, SubmissionWithTopic[]> {
  const groups = new Map<string, SubmissionWithTopic[]>();
  
  for (const submission of submissions) {
    const headlineWords = extractKeyEntities(submission.headline);
    const headlineKey = headlineWords.slice(0, 8).join(' ');
    
    let found = false;
    const entries = Array.from(groups.entries());
    for (const [existingKey, group] of entries) {
      const existingHeadlineWords = extractKeyEntities(group[0].headline);
      
      const similarity = calculateSimilarity(headlineKey, existingKey);
      
      const sharedEntities = headlineWords.filter(w => existingHeadlineWords.includes(w));
      const entityOverlap = sharedEntities.length / Math.min(headlineWords.length, existingHeadlineWords.length);
      
      if (similarity > 0.4 || entityOverlap > 0.5) {
        group.push(submission);
        found = true;
        break;
      }
    }
    
    if (!found) {
      groups.set(headlineKey, [submission]);
    }
  }
  
  return groups;
}

function calculateSimilarity(a: string, b: string): number {
  const wordsA = a.split(/\s+/);
  const wordsB = b.split(/\s+/);
  const wordsBSet = new Set(wordsB);
  const intersection = wordsA.filter(w => wordsBSet.has(w)).length;
  const allWords = Array.from(new Set([...wordsA, ...wordsB]));
  return intersection / allWords.length;
}

function normalizeHeadlineCase(headline: string): string {
  if (!headline) return headline;
  
  const words = headline.split(' ');
  const normalized = words.map((word, index) => {
    if (word.length === 0) return word;
    
    const isAcronym = word === word.toUpperCase() && word.length <= 5 && /^[A-Z]+$/.test(word);
    if (isAcronym) return word;
    
    const isAllCaps = word === word.toUpperCase() && word.length > 5;
    const isFirstWord = index === 0;
    const isAfterColon = index > 0 && words[index - 1].endsWith(':');
    
    if (isAllCaps || isFirstWord || isAfterColon) {
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }
    
    const lowerWord = word.toLowerCase();
    const smallWords = ['a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor', 'on', 'at', 'to', 'by', 'in', 'of', 'up'];
    if (smallWords.includes(lowerWord)) {
      return lowerWord;
    }
    
    if (word.charAt(0) === word.charAt(0).toUpperCase()) {
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }
    
    return word.toLowerCase();
  });
  
  return normalized.join(' ');
}

function deduplicateSources(submissions: SubmissionWithTopic[]): SubmissionWithTopic[] {
  const seenUrls = new Set<string>();
  const seenSourceNames = new Set<string>();
  const result: SubmissionWithTopic[] = [];
  
  for (const submission of submissions) {
    const urlKey = submission.sourceUrl.toLowerCase().replace(/\/$/, '');
    const sourceNameKey = (submission.sourceName || '').toLowerCase().trim();
    
    if (seenUrls.has(urlKey)) {
      continue;
    }
    
    if (seenSourceNames.has(sourceNameKey) && sourceNameKey !== '') {
      continue;
    }
    
    seenUrls.add(urlKey);
    if (sourceNameKey) {
      seenSourceNames.add(sourceNameKey);
    }
    result.push(submission);
  }
  
  return result;
}

export async function generateNewsScrub(fromDate: Date, toDate: Date, boloTopics?: string): Promise<Buffer> {
  assertAIIntegrationsEnabled();
  const submissions = await db
    .select({
      id: teamSubmissions.id,
      headline: teamSubmissions.headline,
      summary: teamSubmissions.summary,
      fullText: teamSubmissions.fullText,
      sourceUrl: teamSubmissions.sourceUrl,
      sourceName: teamSubmissions.sourceName,
      sourceType: teamSubmissions.sourceType,
      priorityScore: teamSubmissions.priorityScore,
      publishedAt: teamSubmissions.publishedAt,
      createdAt: teamSubmissions.createdAt,
      topicName: teamSubjects.name,
    })
    .from(teamSubmissions)
    .leftJoin(teamSubjects, eq(teamSubmissions.subjectId, teamSubjects.id))
    .where(and(
      gte(teamSubmissions.createdAt, fromDate),
      lte(teamSubmissions.createdAt, toDate),
      eq(teamSubmissions.status, 'processed'),
      isNull(teamSubmissions.deletedAt)
    ))
    .orderBy(desc(teamSubmissions.priorityScore));

  // Parse BOLO topics into keywords for matching
  const boloKeywords = boloTopics
    ? boloTopics.toLowerCase().split(/[,;]|\band\b/).map(k => k.trim()).filter(k => k.length > 2)
    : [];

  const mappedSubmissions: SubmissionWithTopic[] = submissions.map(s => {
    let priorityScore = s.priorityScore || 0;
    
    // Boost priority for submissions matching BOLO topics
    if (boloKeywords.length > 0) {
      const text = `${s.headline || ''} ${s.summary || ''} ${s.fullText || ''}`.toLowerCase();
      for (const keyword of boloKeywords) {
        if (text.includes(keyword)) {
          priorityScore += 15;
          break;
        }
      }
    }
    
    return {
      id: s.id,
      headline: s.headline || "Untitled",
      summary: s.summary || "",
      fullText: s.fullText,
      sourceUrl: s.sourceUrl,
      sourceName: s.sourceName,
      sourceType: s.sourceType,
      priorityScore,
      publishedAt: s.publishedAt,
      createdAt: s.createdAt,
      topicName: s.topicName || "Uncategorized",
    };
  });

  const categorized: Record<string, SubmissionWithTopic[]> = {
    "Global IE": [],
    "Pentagon/NATSEC": [],
    "Domestic Operations IE": [],
    "Social Media": [],
  };

  for (const submission of mappedSubmissions) {
    const category = categorizeSubmission(submission);
    if (categorized[category]) {
      categorized[category].push(submission);
    }
  }

  // Sort each category by priority
  for (const category of Object.keys(categorized)) {
    categorized[category].sort((a, b) => b.priorityScore - a.priorityScore);
  }

  // Second-layer defense: strip any leaked audience-framing heading the model
  // echoed despite the prompt instruction. On-the-fly artifacts are never stored
  // so this is the only write-time sanitize opportunity.
  const rawSocialMediaContent = await generateRelevantSocialMedia(categorized["Social Media"]);
  const socialMediaContent = stripBriefingPreamble(rawSocialMediaContent) ?? '';
  const rawBluf = await generateBLUF(categorized, toDate);
  const bluf = stripBriefingPreamble(rawBluf);

  const formatDateString = (d: Date) => {
    const easternTime = formatInTimeZone(d, 'America/New_York', 'HH:mm');
    const easternDate = formatInTimeZone(d, 'America/New_York', 'MMMM d, yyyy');
    return `${easternTime} ET, ${easternDate}`;
  };

  const children: Paragraph[] = [];

  // BLUF section (no title, starts directly with BLUF)
  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: "BLUF: ", bold: true }),
        new TextRun({ text: bluf }),
      ],
      spacing: { after: 400 },
    })
  );

  // IE Highlights section
  children.push(
    new Paragraph({ text: "" }),
    new Paragraph({
      text: "IE Highlights:",
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 400, after: 200 },
    }),
    new Paragraph({
      text: "Major IE narratives included:",
      spacing: { after: 200 },
    })
  );

  // Add category headers with top 3 stories each
  for (const categoryName of ["Global IE", "Pentagon/NATSEC", "Domestic Operations IE"]) {
    const categorySubmissions = categorized[categoryName];
    if (categorySubmissions.length === 0) continue;

    const displayName = categoryName === "Domestic Operations IE" ? "Domestic operations IE" : categoryName;
    
    children.push(
      new Paragraph({
        text: displayName,
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 200, after: 100 },
      })
    );

    const stories = groupByStory(categorySubmissions);
    const topStories = Array.from(stories.entries())
      .sort((a, b) => {
        const maxA = Math.max(...a[1].map(s => s.priorityScore));
        const maxB = Math.max(...b[1].map(s => s.priorityScore));
        return maxB - maxA;
      })
      .slice(0, 3);

    for (const [, storySubmissions] of topStories) {
      const mainHeadline = normalizeHeadlineCase(storySubmissions[0].headline);
      children.push(
        new Paragraph({
          text: mainHeadline,
          bullet: { level: 0 },
          spacing: { after: 50 },
        })
      );
    }
  }

  // Add Relevant Social Media section in highlights
  if (socialMediaContent) {
    children.push(
      new Paragraph({
        text: "Relevant Social Media",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 200, after: 100 },
      })
    );

    const socialParagraphs = socialMediaContent.split('\n\n').filter(p => p.trim());
    for (const para of socialParagraphs) {
      children.push(
        new Paragraph({
          text: para.trim(),
          spacing: { after: 150 },
        })
      );
    }
  }

  // Detailed sections for each category
  for (const categoryName of ["Global IE", "Pentagon/NATSEC", "Domestic Operations IE"]) {
    const categorySubmissions = categorized[categoryName];
    if (categorySubmissions.length === 0) continue;

    const sectionTitle = categoryName === "Pentagon/NATSEC" 
      ? "NOTABLE PENTAGON/NATSEC STORIES"
      : categoryName === "Domestic Operations IE"
        ? "DOMESTIC OPERATIONS IE"
        : "GLOBAL IE";

    children.push(
      new Paragraph({ text: "" }),
      new Paragraph({ text: "" }),
      new Paragraph({
        text: sectionTitle,
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 400, after: 300 },
      })
    );

    const stories = groupByStory(categorySubmissions);
    const sortedStories = Array.from(stories.entries())
      .sort((a, b) => {
        const maxA = Math.max(...a[1].map(s => s.priorityScore));
        const maxB = Math.max(...b[1].map(s => s.priorityScore));
        return maxB - maxA;
      })
      .slice(0, 5);

    for (const [, storySubmissions] of sortedStories) {
      const mainSubmission = storySubmissions.sort((a, b) => b.priorityScore - a.priorityScore)[0];
      
      children.push(
        new Paragraph({
          text: mainSubmission.headline,
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 300, after: 100 },
        })
      );

      children.push(
        new Paragraph({
          children: [new TextRun({ text: "Key Information:", bold: true })],
          spacing: { after: 100 },
        })
      );

      const rawDetailedSummary = await generateDetailedSummary(storySubmissions, categoryName);
      const detailedSummary = stripBriefingPreamble(rawDetailedSummary) ?? rawDetailedSummary;
      const paragraphs = detailedSummary.split('\n').filter(p => p.trim());
      
      for (const para of paragraphs) {
        const cleanText = stripBriefingPreamble(para.replace(/^[-•]\s*/, '').trim()) ?? '';
        if (!cleanText) continue;
        
        children.push(
          new Paragraph({
            text: cleanText,
            bullet: { level: 0 },
            spacing: { after: 80 },
          })
        );
      }

      // Reporting Outlets with links - deduplicate sources
      children.push(
        new Paragraph({
          children: [new TextRun({ text: "Reporting Outlets:", bold: true })],
          spacing: { before: 200, after: 100 },
        })
      );

      const uniqueSources = deduplicateSources(storySubmissions);
      for (const submission of uniqueSources.slice(0, 3)) {
        const sourceName = submission.sourceName || "Unknown Source";
        children.push(
          new Paragraph({
            children: [
              new ExternalHyperlink({
                children: [
                  new TextRun({
                    text: sourceName,
                    style: "Hyperlink",
                  }),
                ],
                link: submission.sourceUrl,
              }),
            ],
            spacing: { after: 50 },
          })
        );
      }
    }
  }

  const doc = new Document({
    sections: [{
      properties: {},
      children: children,
    }],
    styles: {
      paragraphStyles: [
        {
          id: "Normal",
          name: "Normal",
          run: {
            font: "Calibri",
            size: 24,
          },
        },
      ],
    },
  });

  const buffer = await Packer.toBuffer(doc);
  return Buffer.from(buffer);
}
