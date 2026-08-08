import type { InsertFirstAlert } from '@shared/schema';

const AUTH_URL = 'https://firstalert-api.dataminr.com/auth/1/userAuthorization';
const ALERTS_URL = 'https://firstalert-api.dataminr.com/alerts/1/alerts';
const ALERT_VERSION = 19;

interface AuthResponse {
  authorizationToken: string;
  expirationTime: number;
  TOS: string;
  thirdPartyTerms: string;
}

interface DataMinrAlert {
  alertId: string;
  headline: string;
  subHeadline?: any;
  eventTime: number;
  publicPost?: {
    link?: string;
    text?: string;
  };
  firstAlertURL?: string;
  alertType?: {
    name: string;
  };
  alertTopics?: Array<{
    name: string;
    id: string;
  }>;
  alertLists?: Array<{
    name: string;
  }>;
  estimatedEventLocation?: string[];
  termsOfUse?: string;
}

interface AlertsResponse {
  alerts: DataMinrAlert[];
  to: string;
}

let cachedToken: string | null = null;
let tokenExpiration: number | null = null;
let lastCursor: string | null = null;

// --- DataMinr intake downsampling (deterministic, no AI, faster not slower) ---
// A few watchlists are extremely high-volume and dominated by routine ticker items
// (notably "Russia/Ukraine" ground-war alerts, ~half of all DataMinr volume). To
// de-bloat the alert feeds (Visual / War / custom MCOPs) and the curated attach-only
// layer WITHOUT touching AI, we drop an alert during parsing when it is ALL of:
//   (a) on a downsampled watchlist, AND
//   (b) on NO other watchlist (anything cross-listed to a command/region is kept), AND
//   (c) NOT critically flagged (alertType is neither "Urgent" nor "Flash").
// DataMinr never becomes a real article, so this can only remove alert / attach-only
// noise — never a story. Tune by editing the two sets below.
const DOWNSAMPLE_WATCHLISTS = new Set<string>(['Russia/Ukraine']);
const CRITICAL_ALERT_TYPES = new Set<string>(['Urgent', 'Flash']);

function shouldDownsampleAlert(alertLists: string[], alertType: string | null): boolean {
  if (alertLists.length !== 1) return false;                 // keep anything cross-listed
  if (!DOWNSAMPLE_WATCHLISTS.has(alertLists[0])) return false;
  if (alertType && CRITICAL_ALERT_TYPES.has(alertType)) return false; // keep Urgent/Flash
  return true;
}

async function authenticate(): Promise<string> {
  const userId = process.env.DATAMINR_API_USER_ID;
  const password = process.env.DATAMINR_API_PASSWORD;

  if (!userId || !password) {
    throw new Error('DATAMINR_API_USER_ID and DATAMINR_API_PASSWORD must be set in environment variables');
  }

  console.log('Authenticating with DataMinr First Alert API...');

  const body = new URLSearchParams({
    grant_type: 'api_key',
    scope: 'first_alert_api',
    api_user_id: userId,
    api_password: password,
  }).toString();

  const response = await fetch(AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Authentication failed: ${response.status} - ${errorText}`);
  }

  const data: AuthResponse = await response.json();
  console.log('Successfully authenticated with DataMinr First Alert API');
  console.log(`Token received, expires at: ${new Date(data.expirationTime).toISOString()}`);
  
  cachedToken = data.authorizationToken;
  tokenExpiration = data.expirationTime;
  
  return data.authorizationToken;
}

async function getAuthToken(): Promise<string> {
  const now = Date.now();
  
  if (cachedToken && tokenExpiration && tokenExpiration > now) {
    return cachedToken;
  }
  
  return await authenticate();
}

export async function scrapeFirstAlerts(retryOnAuthFailure = true): Promise<InsertFirstAlert[]> {
  const token = await getAuthToken();
  
  const url = new URL(ALERTS_URL);
  url.searchParams.set('alertversion', ALERT_VERSION.toString());
  
  if (lastCursor) {
    url.searchParams.set('from', lastCursor);
  }

  console.log('Fetching First Alert notifications from DataMinr API...');
  
  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Authorization': `DmAuth ${token}`,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      console.warn('DataMinr authentication token expired or invalid');
      cachedToken = null;
      tokenExpiration = null;
      
      // Retry once with fresh authentication
      if (retryOnAuthFailure) {
        console.log('Retrying with fresh authentication token...');
        return await scrapeFirstAlerts(false);
      }
      
      throw new Error('DataMinr authentication failed after retry');
    }
    const errorText = await response.text();
    throw new Error(`Failed to fetch DataMinr alerts: ${response.status} - ${errorText}`);
  }

  const data: AlertsResponse = await response.json();
  
  if (data.to) {
    lastCursor = data.to;
  }

  // Log first alert for inspection
  if (data.alerts.length > 0) {
    console.log('Sample DataMinr Alert (first one):');
    console.log(JSON.stringify(data.alerts[0], null, 2));
  }

  const alerts: InsertFirstAlert[] = [];
  
  let droppedCount = 0;
  for (const alert of data.alerts) {
    if (!alert.alertId || !alert.headline || !alert.eventTime) {
      continue;
    }

    const url = alert.publicPost?.link || alert.firstAlertURL || '';
    
    if (!url) {
      continue;
    }

    // Extract topic names from alertTopics array
    const alertTopics = alert.alertTopics?.map(topic => topic.name) || [];
    
    // Extract command names from alertLists array
    const alertLists = alert.alertLists?.map(list => list.name) || [];
    
    // Extract alert type name
    const alertType = alert.alertType?.name || null;

    // Deterministic intake downsampling (no AI): drop oversized low-criticality
    // watchlist noise (e.g. routine Russia/Ukraine ground-war ticker) before it is
    // ever stored. Cross-listed and Urgent/Flash items are always kept.
    if (shouldDownsampleAlert(alertLists, alertType)) {
      droppedCount++;
      continue;
    }

    // Extract location data from estimatedEventLocation array
    // Format: [address, latitude, longitude, confidence, mgrs]
    const location = alert.estimatedEventLocation?.[0] || null;
    const latitude = alert.estimatedEventLocation?.[1] || null;
    const longitude = alert.estimatedEventLocation?.[2] || null;
    
    // Extract subHeadline (can be object or string)
    let subHeadline: string | null = null;
    if (alert.subHeadline) {
      if (typeof alert.subHeadline === 'string') {
        subHeadline = alert.subHeadline;
      } else if (typeof alert.subHeadline === 'object' && Object.keys(alert.subHeadline).length > 0) {
        // Convert object to JSON string if it has content
        subHeadline = JSON.stringify(alert.subHeadline);
      }
    }
    
    // Extract public post details
    const publicPostLink = alert.publicPost?.link || null;
    const publicPostText = alert.publicPost?.text || null;
    
    // Extract terms of use
    const termsOfUse = alert.termsOfUse || null;

    alerts.push({
      alertId: alert.alertId,
      headline: alert.headline,
      subHeadline,
      url,
      publishedAt: new Date(alert.eventTime),
      alertTopics,
      alertLists,
      alertType,
      location,
      latitude,
      longitude,
      publicPostLink,
      publicPostText,
      termsOfUse,
    });
  }

  if (droppedCount > 0) {
    console.log(`Downsampled (dropped) ${droppedCount} low-criticality First Alert notifications before storage`);
  }
  console.log(`Scraped ${alerts.length} First Alert notifications`);
  return alerts;
}

// Serialize ALL callers of updateFirstAlerts (the dedicated every-5-min cron AND
// the manual route triggers: /api/scrape-first-alerts, /api/trigger-scrape,
// /api/scrape-all) onto one promise chain. scrapeFirstAlerts() advances a
// module-level cursor (lastCursor); two overlapping runs would race that cursor
// and could skip a batch of new alerts. This lock guarantees one run at a time
// regardless of how many entry points fire concurrently. The chain swallows a
// failed run's rejection so an error can never wedge the lock for later callers.
let firstAlertScrapeChain: Promise<unknown> = Promise.resolve();

export async function updateFirstAlerts(storage: any): Promise<number> {
  const run = firstAlertScrapeChain.then(() => doUpdateFirstAlerts(storage));
  firstAlertScrapeChain = run.catch(() => undefined);
  return run;
}

async function doUpdateFirstAlerts(storage: any): Promise<number> {
  // Let errors propagate to caller so API can respond with 500
  const alerts = await scrapeFirstAlerts();
  let addedCount = 0;
  
  for (const alert of alerts) {
    try {
      const existing = await storage.getFirstAlertByAlertId(alert.alertId);
      if (!existing) {
        await storage.addFirstAlert(alert);
        addedCount++;
      }
    } catch (error) {
      console.error(`Error adding First Alert ${alert.alertId}:`, error);
      // Continue processing other alerts even if one fails
    }
  }
  
  console.log(`Added ${addedCount} new First Alert notifications`);
  return addedCount;
}
