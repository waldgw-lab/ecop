import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';
import { db } from './db';
import { headlines } from '@shared/schema';
import { normalizeTitle } from './titleNormalizer';

interface CSVRecord {
  id: string;
  title: string;
  url: string;
  category: string;
  source: string;
  summary: string;
  scraped_at: string;
  article_published_at: string;
  priority_score: string;
  tags: string;
}

async function importCSV() {
  try {
    // Read the CSV file
    const csvContent = readFileSync('attached_assets/headlines 20251031 1106 production_1761926262963.csv', 'utf-8');
    
    // Parse CSV
    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      escape: '"',
      quote: '"'
    }) as CSVRecord[];

    console.log(`Found ${records.length} headlines to import`);

    let imported = 0;
    let skipped = 0;

    // Insert each record
    for (const record of records) {
      try {
        // Parse tags - handle both empty arrays and JSON arrays
        let tags: string[] = [];
        if (record.tags && record.tags !== '[]') {
          try {
            tags = JSON.parse(record.tags);
          } catch (e) {
            console.log(`Warning: Could not parse tags for "${record.title}": ${record.tags}`);
          }
        }

        // Parse timestamps
        const scrapedAt = record.scraped_at 
          ? new Date(record.scraped_at.replace(/"/g, '')) 
          : new Date();
        
        const articlePublishedAt = record.article_published_at && record.article_published_at.trim() !== ''
          ? new Date(record.article_published_at.replace(/"/g, ''))
          : null;

        // Insert into database
        await db.insert(headlines).values({
          id: record.id,
          title: record.title,
          normalizedTitle: normalizeTitle(record.title),
          url: record.url,
          category: record.category,
          source: record.source,
          summary: record.summary,
          scrapedAt: scrapedAt,
          articlePublishedAt: articlePublishedAt,
          priorityScore: parseInt(record.priority_score) || 0,
          tags: tags
        });

        imported++;
        console.log(`✓ Imported: ${record.title.substring(0, 60)}...`);
      } catch (error: any) {
        // Skip duplicates (unique constraint on title)
        if (error.message?.includes('duplicate') || error.message?.includes('unique')) {
          skipped++;
          console.log(`⊘ Skipped (duplicate): ${record.title.substring(0, 60)}...`);
        } else {
          console.error(`✗ Error importing "${record.title}":`, error.message);
        }
      }
    }

    console.log(`\n=== Import Complete ===`);
    console.log(`Imported: ${imported}`);
    console.log(`Skipped (duplicates): ${skipped}`);
    console.log(`Total: ${records.length}`);
    
  } catch (error) {
    console.error('Error importing CSV:', error);
    process.exit(1);
  }
  
  process.exit(0);
}

importCSV();
