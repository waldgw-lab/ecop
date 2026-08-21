import { db } from './db';
import { appFlags } from '@shared/schema';
import { eq } from 'drizzle-orm';

// Restore the persisted per-bot toggles from the database at boot.
// Fail-open: on error the in-memory defaults are kept.
// NOTE: The drudgeScraperEnabled flag has been retired — the direct Drudge
// scraper path was permanently disabled and DrudgeBot (Team chat) covers
// Drudge content. The column remains in the DB schema but is no longer read.
export async function restoreScraperFlags(): Promise<void> {
  try {
    const [row] = await db.select().from(appFlags).where(eq(appFlags.id, 'global'));
    if (row) {
      // Restore per-bot enable/disable overrides. Only known bot ids are
      // applied so stale keys for removed bots can't create ghost state;
      // missing keys keep their in-memory defaults (drudgeBot OFF, rest ON).
      const persisted = row.botStates || {};
      let restoredCount = 0;
      for (const bot of BOT_DEFINITIONS) {
        const val = persisted[bot.id];
        if (typeof val === 'boolean' && val !== botStates[bot.id]) {
          botStates[bot.id] = val;
          restoredCount++;
        }
      }
      if (restoredCount > 0) {
        console.log(`[ScraperConfig] Restored ${restoredCount} persisted bot toggle(s): ${BOT_DEFINITIONS.filter(b => typeof persisted[b.id] === 'boolean' && persisted[b.id] !== !BOTS_DISABLED_BY_DEFAULT.has(b.id)).map(b => `${b.id}=${persisted[b.id] ? 'ON' : 'OFF'}`).join(', ')}`);
      }
    }
  } catch (err) {
    console.error('[ScraperConfig] Failed to restore scraper flags (continuing with defaults):', err);
  }
}

export interface BotDefinition {
  id: string;
  name: string;
  description: string;
  schedule: string;
}

export const BOT_DEFINITIONS: BotDefinition[] = [
  { id: 'drudgeBot', name: 'Drudge Bot', description: 'Scrapes Drudge Report for military-relevant articles', schedule: 'Every 30 min' },
  { id: 'bbcBot', name: 'BBC Bot', description: 'Scrapes BBC News for military-relevant articles', schedule: 'Every 30 min' },
  { id: 'socialBot', name: 'Social Bot', description: 'Reposts POTUS and SecWar social media posts', schedule: 'Every 30 min' },
  { id: 'foxNewsBot', name: 'Fox News Bot', description: 'Scrapes Fox News for military-relevant articles', schedule: 'Every hour' },
  { id: 'abcNewsBot', name: 'ABC News Bot', description: 'Scrapes ABC News for military-relevant articles', schedule: 'Every hour' },
  { id: 'cbsNewsBot', name: 'CBS News Bot', description: 'Scrapes CBS News for military-relevant articles', schedule: 'Every hour' },
  { id: 'nbcNewsBot', name: 'NBC News Bot', description: 'Scrapes NBC News for military-relevant articles', schedule: 'Every hour' },
  { id: 'apNewsBot', name: 'AP News Bot', description: 'Scrapes AP News for military-relevant articles', schedule: 'Every hour' },
  { id: 'reutersBot', name: 'Reuters Bot', description: 'Scrapes Reuters for military-relevant articles', schedule: 'Every hour' },
  { id: 'cnnCuratedBot', name: 'CNN Curated Bot', description: 'CURATED-ONLY: scrapes cnn.com section pages and routes headlines into the isolated Curated lane only (never the main/Classic/Visual/custom-MCOP feeds).', schedule: 'Every hour' },
  { id: 'nprCuratedBot', name: 'NPR Curated Bot', description: 'CURATED-ONLY: scrapes npr.org section pages and routes headlines into the isolated Curated lane only (never the main/Classic/Visual/custom-MCOP feeds).', schedule: 'Every hour' },
  { id: 'globalTimesCuratedBot', name: 'Global Times Curated Bot', description: 'CURATED-ONLY: scrapes globaltimes.cn section pages (RSS is stale) into the isolated Curated lane only (never the main/Classic/Visual/custom-MCOP feeds).', schedule: 'Every hour' },
  { id: 'chinaDailyCuratedBot', name: 'China Daily Curated Bot', description: 'CURATED-ONLY: scrapes chinadaily.com.cn section pages (RSS is stale) into the isolated Curated lane only (never the main/Classic/Visual/custom-MCOP feeds).', schedule: 'Every hour' },
  { id: 'peoplesDailyCuratedBot', name: "People's Daily Curated Bot", description: 'CURATED-ONLY: scrapes en.people.cn section pages (RSS is stale) into the isolated Curated lane only (never the main/Classic/Visual/custom-MCOP feeds).', schedule: 'Every hour' },
  { id: 'cgtnCuratedBot', name: 'CGTN Curated Bot', description: 'CURATED-ONLY: scrapes cgtn.com section pages (RSS is stale) into the isolated Curated lane only (never the main/Classic/Visual/custom-MCOP feeds).', schedule: 'Every hour' },
  { id: 'telesurCuratedBot', name: 'teleSUR Curated Bot', description: 'CURATED-ONLY: scrapes telesurenglish.net (RSS returns anti-bot 413) into the isolated Curated lane only (never the main/Classic/Visual/custom-MCOP feeds); resolves to Venezuela in the registry, not a Cuba substitute.', schedule: 'Every hour' },
  { id: 'kcnaCuratedBot', name: 'KCNA Curated Bot', description: 'CURATED-ONLY: scrapes kcnawatch.org (KCNA RSS 302-redirects to an HTML signup wall) into the isolated Curated lane only (never the main/Classic/Visual/custom-MCOP feeds).', schedule: 'Every hour' },
  { id: 'meltwaterCuratedBot', name: 'Meltwater Curated Bot', description: 'CURATED-ONLY: pulls the Meltwater "Curated (CPC/SWL/EPC)" saved search into the isolated Curated lane only (never the main/Classic/Visual/custom-MCOP feeds); every item is tagged CPC/SWL/EPC contrast.', schedule: 'Every 3 hours' },
  { id: 'breakingDefenseOffHostBot', name: 'Breaking Defense Off-Host Bot', description: 'CURATED-ONLY: discovers breakingdefense.com articles OFF-HOST via Bing News RSS (its own feed intermittently 403s from prod egress) into the isolated Curated lane only (never the main/Classic/Visual/custom-MCOP feeds).', schedule: 'Every hour' },
  { id: 'starsStripesOffHostBot', name: 'Stars and Stripes Off-Host Bot', description: 'CURATED-ONLY: discovers stripes.com articles OFF-HOST via Bing News RSS (Stars and Stripes publishes no working RSS) into the isolated Curated lane only (never the main/Classic/Visual/custom-MCOP feeds).', schedule: 'Every hour' },
  { id: 'usaTodayOffHostBot', name: 'USA Today Off-Host Bot', description: 'CURATED-ONLY: discovers usatoday.com defense/security articles OFF-HOST via Bing News RSS (USA Today RSS retired) into the isolated Curated lane only (never the main/Classic/Visual/custom-MCOP feeds).', schedule: 'Every hour' },
  { id: 'bloombergOffHostBot', name: 'Bloomberg Off-Host Bot', description: 'CURATED-ONLY: discovers bloomberg.com defense/security/geopolitics articles OFF-HOST via Bing News RSS (Bloomberg RSS returns HTTP 404 from prod egress) into the isolated Curated lane only (never the main/Classic/Visual/custom-MCOP feeds).', schedule: 'Every hour' },
  { id: 'rssFeedBot', name: 'RSS Feed Bot', description: 'Monitors 45+ defense/geopolitical/major-outlet RSS feeds (incl. WaPo, Bloomberg, Politico, The Hill, MSNBC, CNBC, USA Today, NewsNation, Washington Times/Examiner) for military-relevant articles. Each source posts as its own RSS(SourceName) Bot.', schedule: 'Every 5 min' },
];

const BOTS_DISABLED_BY_DEFAULT = new Set<string>(['drudgeBot']);

function isBotDisabledByEnvironment(botId: string): boolean {
  return botId === 'meltwaterCuratedBot' && process.env.MELTWATER_DISABLED === 'true';
}

const botStates: Record<string, boolean> = {};
for (const bot of BOT_DEFINITIONS) {
  botStates[bot.id] = !BOTS_DISABLED_BY_DEFAULT.has(bot.id);
}

export function getBotStates(): Record<string, boolean> {
  const states = { ...botStates };
  for (const botId of Object.keys(states)) {
    if (isBotDisabledByEnvironment(botId)) states[botId] = false;
  }
  return states;
}

export function isBotEnabled(botId: string): boolean {
  if (isBotDisabledByEnvironment(botId)) return false;
  return botStates[botId] ?? true;
}

export function setBotEnabled(botId: string, enabled: boolean): void {
  if (enabled && isBotDisabledByEnvironment(botId)) {
    botStates[botId] = false;
    console.log(`[ScraperConfig] ${botId} remains disabled by environment configuration`);
    return;
  }
  botStates[botId] = enabled;
  const def = BOT_DEFINITIONS.find(b => b.id === botId);
  console.log(`[ScraperConfig] ${def?.name || botId} ${enabled ? 'enabled' : 'disabled'}`);
}

// Write the full current bot-state map to the single-row app_flags table so
// per-bot toggles survive restarts/redeploys. Restored at boot by
// restoreScraperFlags(). Persisting the whole map (not a single-key patch)
// keeps the write idempotent and avoids read-modify-write races on the
// jsonb column across concurrent toggles in this single-process deploy.
export async function persistBotStates(): Promise<void> {
  const snapshot = { ...botStates };
  await db.insert(appFlags)
    .values({ id: 'global', botStates: snapshot, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appFlags.id,
      set: { botStates: snapshot, updatedAt: new Date() },
    });
}
