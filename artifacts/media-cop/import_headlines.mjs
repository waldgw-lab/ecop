import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read the file
const filePath = path.join(__dirname, 'attached_assets/Pasted-01e1791b-bd3b-49eb-895a-075e3a4f9ef7-UK-billionaire-Joe-Lewis-gets-one-https-www-bbc-com-news-a-1763149400396_1763149400397.txt');
const content = fs.readFileSync(filePath, 'utf8');

// Parse TSV data
const lines = content.trim().split('\n');

// Function to normalize title (simplified version)
function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 200);
}

// Generate SQL INSERT statements
const inserts = lines.map(line => {
  const parts = line.split('\t');
  
  if (parts.length < 8) {
    console.error('Invalid line format (parts:', parts.length, '):', line.substring(0, 100));
    return null;
  }
  
  const [id, title, url, category, source, summary, scrapedAt, articlePublishedAt] = parts;
  
  const normalizedTitle = normalizeTitle(title);
  const priorityScore = 0;
  const tags = '{}';
  
  // Parse timestamps
  const scrapedAtClean = scrapedAt.replace(/"/g, '');
  const articlePublishedAtClean = articlePublishedAt === 'null' ? 'NULL' : `'${articlePublishedAt.replace(/"/g, '')}'`;
  
  // Escape single quotes in strings
  const titleEscaped = title.replace(/'/g, "''");
  const urlEscaped = url.replace(/'/g, "''");
  const summaryEscaped = summary.replace(/'/g, "''");
  const normalizedTitleEscaped = normalizedTitle.replace(/'/g, "''");
  
  return `INSERT INTO headlines (id, title, url, category, source, summary, scraped_at, article_published_at, priority_score, tags, normalized_title, priority_override)
VALUES ('${id}', '${titleEscaped}', '${urlEscaped}', '${category}', '${source}', '${summaryEscaped}', '${scrapedAtClean}', ${articlePublishedAtClean}, ${priorityScore}, '${tags}', '${normalizedTitleEscaped}', NULL)
ON CONFLICT (title) DO UPDATE SET
  url = EXCLUDED.url,
  category = EXCLUDED.category,
  source = EXCLUDED.source,
  summary = EXCLUDED.summary,
  scraped_at = EXCLUDED.scraped_at,
  article_published_at = EXCLUDED.article_published_at;`;
}).filter(Boolean);

// Write to SQL file
const sqlContent = inserts.join('\n\n');
fs.writeFileSync('import_headlines.sql', sqlContent);

console.log(`Generated ${inserts.length} INSERT statements`);
console.log('SQL file written to: import_headlines.sql');
console.log('\nFirst INSERT statement:');
console.log(inserts[0]);
