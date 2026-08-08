import Parser from 'rss-parser';

interface RSSHeadline {
  title: string;
  url: string;
  publishedAt?: Date | null;
}

const parser = new Parser({
  customFields: {
    item: ['pubDate', 'published']
  }
});

export async function scrapeRSSFeed(): Promise<RSSHeadline[]> {
  const rssUrl = process.env.RSS_FEED_URL;
  
  if (!rssUrl) {
    console.log('RSS_FEED_URL environment variable not set, skipping RSS scraping');
    return [];
  }

  try {
    console.log(`Fetching RSS feed from: ${rssUrl.substring(0, 50)}...`);
    const feed = await parser.parseURL(rssUrl);
    
    if (!feed.items || feed.items.length === 0) {
      console.log('No items found in RSS feed');
      return [];
    }

    const headlines: RSSHeadline[] = [];
    
    for (const item of feed.items) {
      if (!item.title || !item.link) {
        continue;
      }

      // Parse publication date
      let publishedAt: Date | null = null;
      const dateString = item.pubDate || (item as any).published;
      if (dateString) {
        try {
          publishedAt = new Date(dateString);
          if (isNaN(publishedAt.getTime())) {
            publishedAt = null;
          }
        } catch {
          publishedAt = null;
        }
      }

      headlines.push({
        title: item.title.trim(),
        url: item.link,
        publishedAt
      });
      
      console.log(`  RSS: "${item.title.trim()}"`);
    }

    console.log(`Scraped ${headlines.length} headlines from RSS feed`);
    return headlines;
  } catch (error) {
    console.error('Error scraping RSS feed:', error);
    return [];
  }
}
