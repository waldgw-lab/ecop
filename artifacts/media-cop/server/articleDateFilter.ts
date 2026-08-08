const MAX_ARTICLE_AGE_HOURS = 48;

export function isRecentArticle(pubDate: string | undefined, botName: string): boolean {
  if (!pubDate) {
    console.log(`[${botName}] Article has no pubDate, allowing it through`);
    return true;
  }

  try {
    const articleDate = new Date(pubDate);
    if (isNaN(articleDate.getTime())) {
      console.log(`[${botName}] Could not parse pubDate "${pubDate}", allowing it through`);
      return true;
    }

    const now = new Date();
    const ageInHours = (now.getTime() - articleDate.getTime()) / (1000 * 60 * 60);

    if (ageInHours > MAX_ARTICLE_AGE_HOURS) {
      console.log(`[${botName}] REJECTED old article (${Math.round(ageInHours)}h old, pubDate: ${pubDate})`);
      return false;
    }

    return true;
  } catch {
    console.log(`[${botName}] Error checking pubDate "${pubDate}", allowing it through`);
    return true;
  }
}

export function extractDateFromUrl(url: string): Date | null {
  const datePatterns = [
    /\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//,
    /\/(\d{4})-(\d{2})-(\d{2})\//,
    /-(\d{4})(\d{2})(\d{2})/,
  ];

  for (const pattern of datePatterns) {
    const match = url.match(pattern);
    if (match) {
      const year = parseInt(match[1]);
      const month = parseInt(match[2]);
      const day = parseInt(match[3]);

      if (year >= 2020 && year <= 2030 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        try {
          const date = new Date(year, month - 1, day);
          if (!isNaN(date.getTime())) {
            return date;
          }
        } catch {
          continue;
        }
      }
    }
  }

  return null;
}

export function isRecentUrl(url: string, botName: string): boolean {
  const urlDate = extractDateFromUrl(url);
  if (!urlDate) {
    return true;
  }

  const now = new Date();
  const ageInHours = (now.getTime() - urlDate.getTime()) / (1000 * 60 * 60);

  if (ageInHours > MAX_ARTICLE_AGE_HOURS) {
    console.log(`[${botName}] REJECTED old article from URL date (${Math.round(ageInHours)}h old, URL: ${url})`);
    return false;
  }

  return true;
}
