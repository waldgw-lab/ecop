import type { BrowserContext, Page } from 'playwright';

/**
 * Shared X/Twitter authentication for every Playwright-based scraper.
 *
 * X (Twitter) blocks logged-out guests from viewing profile timelines, so any
 * scraper that navigates to https://x.com/<handle> WITHOUT auth cookies hits a
 * login wall and extracts 0 tweets ("Found 0 tweet elements"). Injecting the
 * operator's session cookies (auth_token = X_AUTH_TOKEN, ct0 = X_CT0) puts
 * Playwright into authenticated mode so the timeline renders.
 *
 * This is the single source of truth so every X scraper (main feed, influencer,
 * RapidResponse, DOWResponse, OSINT, journalists,
 * sentdefender) authenticates identically and cannot drift apart.
 *
 * Watchdog interaction: the scheduler's self-healing auto-heal re-invokes the
 * same scrape entry points (updateXPosts / updateInfluencerXPosts /
 * runFullScrape), all of which flow through the scrapers below, so recovery runs
 * inherit this authentication automatically. When the cookies ARE present but X
 * still serves a login wall (0 tweets), the cookies are expired/invalid — the
 * watchdog's kill-and-rescrape cannot fix that; refresh X_AUTH_TOKEN / X_CT0.
 */

export function hasXAuth(): boolean {
  return !!(process.env.X_AUTH_TOKEN && process.env.X_CT0);
}

/**
 * Inject X session cookies onto a Playwright BrowserContext before any page is
 * created. Returns true when authenticated cookies were applied, false when
 * credentials are missing (caller continues in unauthenticated/guest mode).
 */
export async function injectXAuthCookies(context: BrowserContext, label: string): Promise<boolean> {
  const authToken = process.env.X_AUTH_TOKEN;
  const ct0 = process.env.X_CT0;

  if (!authToken || !ct0) {
    console.log(`X_AUTH_TOKEN or X_CT0 not set — scraping ${label} in unauthenticated mode`);
    return false;
  }

  try {
    await context.addCookies([
      {
        name: 'auth_token',
        value: authToken,
        domain: '.x.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'None',
      },
      {
        name: 'ct0',
        value: ct0,
        domain: '.x.com',
        path: '/',
        secure: true,
        sameSite: 'Lax',
      },
      {
        name: 'auth_token',
        value: authToken,
        domain: '.twitter.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'None',
      },
      {
        name: 'ct0',
        value: ct0,
        domain: '.twitter.com',
        path: '/',
        secure: true,
        sameSite: 'Lax',
      },
    ]);
    console.log(`Injected X auth cookies for ${label} (authenticated mode)`);
    return true;
  } catch (cookieError) {
    console.error(
      `Failed to inject X auth cookies for ${label}:`,
      cookieError instanceof Error ? cookieError.message : cookieError,
    );
    return false;
  }
}

/**
 * Apply the x-csrf-token header (must equal the ct0 cookie value) to a page.
 * X's authenticated XHR/GraphQL calls reject requests whose csrf header does
 * not match the ct0 cookie, so this mirrors the proven OSINT scraper setup.
 */
export async function applyXCsrfHeader(page: Page): Promise<void> {
  const ct0 = process.env.X_CT0;
  if (ct0) {
    await page.setExtraHTTPHeaders({
      'x-csrf-token': ct0,
    });
  }
}
