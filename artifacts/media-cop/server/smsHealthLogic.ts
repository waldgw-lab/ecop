/**
 * server/smsHealthLogic.ts — PURE health-verdict helper for the SMS alert pipeline.
 *
 * No database or environment imports on purpose: the CI gate
 * (scripts/sms-alert-health.test.ts) exercises these functions directly with
 * synthetic inputs. The runtime wiring lives in server/smsAlertMonitor.ts.
 *
 * Verdict colours:
 *   green — alerts can send normally
 *   amber — degraded but still sending
 *   red   — cannot send; triggers incident email
 */

import {
  PENDING_STUCK_MS,
  PENDING_STUCK_MAX_AGE_MS,
  PRIMARY_FAILURE_THRESHOLD,
} from './smsFailoverLogic';

export type SmsHealthColor = 'green' | 'amber' | 'red';

export interface SmsHealthInput {
  mode: 'twilio' | 'termux';
  /** Twilio credentials all present */
  twilioConfigured: boolean;
  /** Bridge phone liveness (from getBridgeStatus) */
  primaryAlive: boolean;
  backupAlive: boolean;
  /** Which device the controller is currently routing to (null when mode=twilio) */
  activeDevice: 'primary' | 'backup' | null;
  /** Consecutive failed send confirmations on the primary since its last success */
  primaryConsecutiveFailures: number;
  /** Pending outbound message count */
  termuxQueuePending: number;
  /**
   * Age (ms) of the OLDEST pending outbound message within the stuck-queue window,
   * or null when the queue is empty or all messages are ancient backlog.
   */
  oldestPendingAgeMs: number | null;
  // Threshold overrides — injectable so the gate can drive boundaries precisely.
  pendingStuckMs?: number;
  pendingStuckMaxAgeMs?: number;
  primaryFailureThreshold?: number;
}

export interface SmsHealthVerdict {
  color: SmsHealthColor;
  reasons: string[];
}

/** Pure: maps the current SMS pipeline state to a green/amber/red verdict. */
export function deriveSmsHealth(input: SmsHealthInput): SmsHealthVerdict {
  const {
    mode,
    twilioConfigured,
    primaryAlive,
    backupAlive,
    activeDevice,
    primaryConsecutiveFailures,
    termuxQueuePending,
    oldestPendingAgeMs,
    pendingStuckMs = PENDING_STUCK_MS,
    pendingStuckMaxAgeMs = PENDING_STUCK_MAX_AGE_MS,
    primaryFailureThreshold = PRIMARY_FAILURE_THRESHOLD,
  } = input;

  // === Twilio mode ===
  if (mode === 'twilio') {
    if (!twilioConfigured) {
      return {
        color: 'red',
        reasons: [
          'Twilio not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER',
        ],
      };
    }
    return { color: 'green', reasons: [] };
  }

  // === Termux (bridge) mode ===

  // Is the queue showing a "stuck" signal within the bounded window?
  const stuckQueue =
    oldestPendingAgeMs !== null &&
    oldestPendingAgeMs >= pendingStuckMs &&
    oldestPendingAgeMs < pendingStuckMaxAgeMs;

  // RED: no phone available at all
  if (!primaryAlive && !backupAlive) {
    return {
      color: 'red',
      reasons: ['No phone available — both primary and backup are offline'],
    };
  }

  // RED: queue stuck and no backup alive to failover to (nothing can deliver)
  if (stuckQueue && !backupAlive) {
    const ageMin = Math.round(oldestPendingAgeMs! / 60_000);
    return {
      color: 'red',
      reasons: [
        `Outbound queue stuck (oldest message ${ageMin}m old) and backup phone is offline — failover blocked, nothing delivering`,
      ],
    };
  }

  // AMBER: degraded but still sending
  const reasons: string[] = [];

  if (activeDevice === 'backup') {
    reasons.push('Running on backup phone — primary phone is down');
  }
  if (primaryAlive && !backupAlive) {
    reasons.push('Backup phone offline — no redundancy');
  }
  if (primaryConsecutiveFailures > 0 && primaryConsecutiveFailures < primaryFailureThreshold) {
    reasons.push(
      `${primaryConsecutiveFailures} consecutive send failure${primaryConsecutiveFailures !== 1 ? 's' : ''} on primary (below failover threshold)`,
    );
  }
  if (stuckQueue) {
    const ageMin = Math.round(oldestPendingAgeMs! / 60_000);
    reasons.push(`Outbound queue stuck (oldest message ${ageMin}m old) — failover should be in progress`);
  } else if (termuxQueuePending > 0) {
    reasons.push(`${termuxQueuePending} message${termuxQueuePending !== 1 ? 's' : ''} queued`);
  }

  if (reasons.length > 0) {
    return { color: 'amber', reasons };
  }

  return { color: 'green', reasons: [] };
}

/**
 * One-shot incident email trigger logic — pure, injectable for testing.
 *
 * @param currentColor  The verdict color from this cycle.
 * @param incidentAt    Timestamp when the current incident email was sent, or null.
 * @returns 'send-incident' | 'send-recovery' | 'hold' | 'nothing'
 */
export type SmsAlertAction = 'send-incident' | 'send-recovery' | 'hold' | 'nothing';

export function decideSmsAlertAction(
  currentColor: SmsHealthColor,
  incidentAt: Date | null,
): SmsAlertAction {
  const isRed = currentColor === 'red';
  if (isRed && !incidentAt) return 'send-incident';
  if (isRed && incidentAt) return 'hold';
  if (!isRed && incidentAt) return 'send-recovery';
  return 'nothing';
}
