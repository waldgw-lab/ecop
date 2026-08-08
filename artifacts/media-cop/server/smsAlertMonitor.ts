/**
 * server/smsAlertMonitor.ts — periodic SMS pipeline health monitor.
 *
 * Evaluates the health verdict (green/amber/red) from smsHealthLogic.ts on
 * every cron tick, and sends ONE incident email when the pipeline enters red,
 * plus ONE recovery email when it clears. Amber never triggers email.
 *
 * Email recipients are hardcoded (per task spec — not editable in UI).
 * Per-recipient failures are logged individually so a .mil gateway rejection
 * doesn't abort the rest.
 *
 * Durable incident marker: reuses getRelayOutageEscalatedAt /
 * setRelayOutageEscalatedAt with relay key 'sms-alert-health' — same pattern
 * as the Truth Social relay outage monitor, no new schema needed.
 *
 * Email is suppressed in dev workspaces (REPLIT_DEPLOYMENT !== '1') to avoid
 * double-sending when both dev and deployed app run.
 */

import { and, eq, gte, sql as dsql } from 'drizzle-orm';
import { db } from './db';
import { smsQueue } from '@shared/schema';
import { getSmsMode, isTwilioConfigured } from './twilioService';
import { getBridgeStatus } from './smsBridge';
import { deriveSmsHealth, decideSmsAlertAction } from './smsHealthLogic';
import { PENDING_STUCK_MAX_AGE_MS } from './smsFailoverLogic';
import type { IStorage } from './storage';
import type { SmsHealthInput, SmsHealthVerdict } from './smsHealthLogic';

// Hardcoded recipient list (per spec — not editable via UI).
const ALERT_RECIPIENTS = [
  { email: 'chelsea.hall11@gmail.com', name: 'Chelsea Hall' },
  { email: 'chelsea.l.durante.mil@mail.mil', name: 'Chelsea Durante' },
  { email: 'gerhard.a.wald.mil@mail.mil', name: 'Gerhard Wald' },
  { email: 'WaldGW@gmail.com', name: 'GW Wald' },
];

const MONITOR_KEY = 'sms-alert-health';

// Injectable seams — tests mutate these properties to stub deps.
export const smsAlertMonitorDeps = {
  getHealthInput: async (): Promise<SmsHealthInput> => getHealthInputFromDb(),
  sendEmail: async (subject: string, html: string): Promise<void> => sendAlertEmail(subject, html),
  now: (): number => Date.now(),
  isDeployed: (): boolean =>
    process.env.REPLIT_DEPLOYMENT === '1' || process.env.NODE_ENV === 'production',
};

// In-memory mirror of the durable marker (write-through after first load).
let incidentAt: Date | null = null;
let incidentLoaded = false;
let checkInFlight = false;

export function resetSmsAlertMonitorForTests(): void {
  incidentAt = null;
  incidentLoaded = false;
  checkInFlight = false;
}

// ── Real implementations of the injectable deps ─────────────────────────────

async function getHealthInputFromDb(): Promise<SmsHealthInput> {
  const mode = getSmsMode();
  const twilioConfigured = isTwilioConfigured();

  // Oldest pending outbound message within the stuck-queue window.
  const windowStart = new Date(Date.now() - PENDING_STUCK_MAX_AGE_MS);
  const [oldestRow] = await db
    .select({ minCreatedAt: dsql<string | null>`min(created_at)` })
    .from(smsQueue)
    .where(
      and(
        eq(smsQueue.status, 'pending'),
        eq(smsQueue.direction, 'outbound'),
        gte(smsQueue.createdAt, windowStart),
      ),
    );
  const oldestCreatedAt = oldestRow?.minCreatedAt ? new Date(oldestRow.minCreatedAt) : null;
  const oldestPendingAgeMs = oldestCreatedAt ? Date.now() - oldestCreatedAt.getTime() : null;

  const [countRow] = await db
    .select({ count: dsql<string>`count(*)` })
    .from(smsQueue)
    .where(and(eq(smsQueue.status, 'pending'), eq(smsQueue.direction, 'outbound')));
  const termuxQueuePending = Number(countRow?.count ?? 0);

  let primaryAlive = false;
  let backupAlive = false;
  let activeDevice: 'primary' | 'backup' | null = null;
  let primaryConsecutiveFailures = 0;

  if (mode === 'termux') {
    try {
      const bridge = await getBridgeStatus();
      primaryAlive = bridge.primaryAlive;
      backupAlive = bridge.backupAlive;
      activeDevice = bridge.activeDevice;
      primaryConsecutiveFailures = bridge.primaryConsecutiveFailures;
    } catch (err) {
      console.error('[SmsAlertMonitor] Failed to read bridge status:', err);
    }
  }

  return {
    mode,
    twilioConfigured,
    primaryAlive,
    backupAlive,
    activeDevice,
    primaryConsecutiveFailures,
    termuxQueuePending,
    oldestPendingAgeMs,
  };
}

function fmtMilitary(d: Date): string {
  const eastern = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const hh = eastern.getHours().toString().padStart(2, '0');
  const mm = eastern.getMinutes().toString().padStart(2, '0');
  const dd = eastern.getDate().toString().padStart(2, '0');
  return `${hh}${mm} ${dd}${months[eastern.getMonth()]}${eastern.getFullYear()}`;
}

function fmtDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

async function sendAlertEmail(subject: string, html: string): Promise<void> {
  const { getUncachableResendClient } = await import('./resend');
  const { client, fromEmail } = await getUncachableResendClient();

  for (const recipient of ALERT_RECIPIENTS) {
    try {
      await client.emails.send({
        from: fromEmail,
        to: recipient.email,
        subject,
        html,
      });
      console.log(`[SmsAlertMonitor] Email sent to ${recipient.email}`);
    } catch (err: any) {
      // Log per-recipient failures but continue — .mil gateways may reject.
      console.error(`[SmsAlertMonitor] Failed to send email to ${recipient.email}:`, err?.message ?? err);
    }
  }
}

function buildIncidentEmail(verdict: SmsHealthVerdict, nowMs: number): { subject: string; html: string } {
  const stamp = fmtMilitary(new Date(nowMs));
  const bulletList = verdict.reasons
    .map((r) => `<li>${r}</li>`)
    .join('');
  const subject = `MCOP ALERT: SMS pipeline DOWN — ${stamp}`;
  const html = `
<h2>MCOP SMS Alert Pipeline: DOWN</h2>
<p>The SMS alert pipeline has entered a failure state at <strong>${stamp}</strong>.</p>
<ul>${bulletList}</ul>
<p>POTUS Truth Social SMS alerts cannot be delivered until this is resolved.</p>
<p>Check the SMS Alerts panel on the MCOP Team page for details and manual override options.</p>
<hr><p style="font-size:11px;color:#888;">One-time notification — no repeat emails while this incident persists. A recovery email will be sent when the pipeline is restored.</p>
`;
  return { subject, html };
}

function buildRecoveryEmail(sinceAt: Date, nowMs: number): { subject: string; html: string } {
  const stamp = fmtMilitary(new Date(nowMs));
  const duration = fmtDuration(nowMs - sinceAt.getTime());
  const subject = `MCOP ALERT: SMS pipeline RESTORED — ${stamp}`;
  const html = `
<h2>MCOP SMS Alert Pipeline: RESTORED</h2>
<p>The SMS alert pipeline has recovered at <strong>${stamp}</strong>.</p>
<p>Outage duration: approximately <strong>${duration}</strong> (incident detected at ${fmtMilitary(sinceAt)}).</p>
<p>POTUS Truth Social SMS alerts are now sending normally.</p>
`;
  return { subject, html };
}

// ── Public exported types ────────────────────────────────────────────────────

export type SmsAlertCheckResult =
  | 'ok'          // green/amber — no action
  | 'incident'    // newly red — incident email sent
  | 'hold'        // still red, already notified
  | 'recovered'   // cleared — recovery email sent
  | 'skipped';    // in-flight or durable state unreadable

// ── Main check function ──────────────────────────────────────────────────────

/**
 * Periodic health check. Called every N minutes from the scheduler.
 * Cheap: in-memory checks on repeat ticks; DB reads only on first boot and
 * on state transitions (incident/recovery).
 */
export async function checkSmsAlertHealth(storage: IStorage): Promise<SmsAlertCheckResult> {
  if (checkInFlight) return 'skipped';
  checkInFlight = true;
  try {
    // Lazily restore durable marker on first call after boot.
    if (!incidentLoaded) {
      try {
        incidentAt = await storage.getRelayOutageEscalatedAt(MONITOR_KEY);
        incidentLoaded = true;
        if (incidentAt) {
          console.log(`[SmsAlertMonitor] Restored incident marker: ${incidentAt.toISOString()} (email already sent this episode)`);
        }
      } catch (err) {
        console.error('[SmsAlertMonitor] Failed to read incident marker (will retry next cycle):', err);
        return 'skipped'; // fail-closed
      }
    }

    const healthInput = await smsAlertMonitorDeps.getHealthInput();
    const verdict = deriveSmsHealth(healthInput);
    const action = decideSmsAlertAction(verdict.color, incidentAt);
    const now = smsAlertMonitorDeps.now();

    if (action === 'nothing' || action === 'hold') {
      return action === 'hold' ? 'hold' : 'ok';
    }

    if (action === 'send-incident') {
      if (!smsAlertMonitorDeps.isDeployed()) {
        console.log(`[SmsAlertMonitor] Pipeline red (${verdict.reasons.join('; ')}) — email suppressed (not deployed)`);
        return 'ok';
      }
      const stampedAt = new Date(now);
      // Stamp in-memory FIRST for same-process double-send guard.
      incidentAt = stampedAt;
      // Persist durable marker BEFORE sending email.  If process crashes after
      // the DB write but before the email send, the email is lost for this
      // episode — that is intentional and correct.  The alternative (email first,
      // persist second) risks a duplicate incident email on every redeploy during
      // an ongoing outage, which is worse.  If the DB write itself fails, we skip
      // the email this tick so the next tick can retry the full incident path.
      try {
        await storage.setRelayOutageEscalatedAt(MONITOR_KEY, stampedAt);
      } catch (err) {
        console.error('[SmsAlertMonitor] Failed to persist incident marker — skipping email this tick (in-memory guard holds; next restart will retry full incident path):', err);
        return 'incident'; // in-memory guard still prevents double-send this session
      }
      const { subject, html } = buildIncidentEmail(verdict, now);
      try {
        await smsAlertMonitorDeps.sendEmail(subject, html);
        console.log(`[SmsAlertMonitor] Incident email sent (${verdict.reasons.join('; ')})`);
      } catch (err) {
        console.error('[SmsAlertMonitor] Incident email failed (marker kept — no retry spam):', err);
      }
      return 'incident';
    }

    if (action === 'send-recovery') {
      // Clear marker FIRST (arms the next episode even if recovery email fails).
      const since = incidentAt!;
      incidentAt = null;
      try {
        await storage.setRelayOutageEscalatedAt(MONITOR_KEY, null);
      } catch (err) {
        console.error('[SmsAlertMonitor] Failed to clear incident marker:', err);
      }
      if (smsAlertMonitorDeps.isDeployed()) {
        const { subject, html } = buildRecoveryEmail(since, now);
        try {
          await smsAlertMonitorDeps.sendEmail(subject, html);
          console.log('[SmsAlertMonitor] Recovery email sent — incident marker cleared');
        } catch (err) {
          console.error('[SmsAlertMonitor] Recovery email failed (marker already cleared):', err);
        }
      } else {
        console.log('[SmsAlertMonitor] Pipeline recovered — recovery email suppressed (not deployed)');
      }
      return 'recovered';
    }

    return 'ok';
  } finally {
    checkInFlight = false;
  }
}

/**
 * Compute the current health verdict from live DB/in-memory state.
 * Used by the /api/sms-alerts/status and /api/sms-alerts/health endpoints.
 */
export async function getSmsHealthVerdict(): Promise<SmsHealthVerdict> {
  const input = await getHealthInputFromDb();
  return deriveSmsHealth(input);
}
