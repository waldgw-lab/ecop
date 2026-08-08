/**
 * scripts/sms-alert-health.test.ts — CI gate for the SMS pipeline health
 * verdict (smsHealthLogic.ts) and the one-shot incident/recovery email
 * trigger logic (smsHealthLogic.decideSmsAlertAction + smsAlertMonitor.ts).
 *
 * Part 1 (always, pure): exercises deriveSmsHealth boundaries for all
 * green/amber/red verdicts and decideSmsAlertAction transitions.
 *
 * Part 2 (always, seam-injected): exercises checkSmsAlertHealth's full
 * one-shot state machine (incident email once, hold, recovery email, re-arm)
 * using stub storage and stub deps — no live DB, no real email, synthetic clock.
 *
 * Exit 0 = PASS, 1 = FAIL (harness-reliability convention).
 */

import {
  deriveSmsHealth,
  decideSmsAlertAction,
  type SmsHealthInput,
} from '../server/smsHealthLogic';
import {
  checkSmsAlertHealth,
  resetSmsAlertMonitorForTests,
  smsAlertMonitorDeps,
} from '../server/smsAlertMonitor';
import {
  PENDING_STUCK_MS,
  PENDING_STUCK_MAX_AGE_MS,
  PRIMARY_FAILURE_THRESHOLD,
} from '../server/smsFailoverLogic';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── Part 1: pure verdict logic ───────────────────────────────────────────────

console.log('[sms-alert-health] Part 1: pure verdict (deriveSmsHealth)');

function baseInput(overrides: Partial<SmsHealthInput> = {}): SmsHealthInput {
  return {
    mode: 'termux',
    twilioConfigured: false,
    primaryAlive: true,
    backupAlive: true,
    activeDevice: 'primary',
    primaryConsecutiveFailures: 0,
    termuxQueuePending: 0,
    oldestPendingAgeMs: null,
    ...overrides,
  };
}

// GREEN: both phones alive, no issues
{
  const v = deriveSmsHealth(baseInput());
  check('termux healthy → green', v.color === 'green' && v.reasons.length === 0, JSON.stringify(v));
}

// GREEN: Twilio mode + configured
{
  const v = deriveSmsHealth(baseInput({ mode: 'twilio', twilioConfigured: true }));
  check('twilio configured → green', v.color === 'green', JSON.stringify(v));
}

// RED: Twilio + not configured
{
  const v = deriveSmsHealth(baseInput({ mode: 'twilio', twilioConfigured: false }));
  check('twilio not configured → red', v.color === 'red', JSON.stringify(v));
  check('twilio red has reason', v.reasons.length > 0);
}

// RED: Termux + no phone alive
{
  const v = deriveSmsHealth(baseInput({ primaryAlive: false, backupAlive: false }));
  check('both phones dead → red', v.color === 'red', JSON.stringify(v));
}

// RED: stuck queue + no backup
{
  const v = deriveSmsHealth(baseInput({
    primaryAlive: true,
    backupAlive: false,
    oldestPendingAgeMs: PENDING_STUCK_MS + 1000,
  }));
  check('stuck queue + no backup → red', v.color === 'red', JSON.stringify(v));
}

// NOT red: stuck queue but backup alive (failover in progress → amber)
{
  const v = deriveSmsHealth(baseInput({
    oldestPendingAgeMs: PENDING_STUCK_MS + 1000,
    backupAlive: true,
  }));
  check('stuck queue + backup alive → amber (failover in progress)', v.color === 'amber', JSON.stringify(v));
}

// NOT triggered: ancient backlog past max-age window (garbage, not a stuck signal)
{
  const v = deriveSmsHealth(baseInput({
    oldestPendingAgeMs: PENDING_STUCK_MAX_AGE_MS + 1000,
    backupAlive: false,
  }));
  check('ancient backlog (past max-age) → not red for stuck-queue reason', v.color !== 'red' || !v.reasons.some(r => r.includes('stuck')), JSON.stringify(v));
}

// AMBER: running on backup (primary failed over)
{
  const v = deriveSmsHealth(baseInput({ activeDevice: 'backup' }));
  check('active=backup → amber', v.color === 'amber', JSON.stringify(v));
}

// AMBER: primary alive, backup offline (no redundancy)
{
  const v = deriveSmsHealth(baseInput({ primaryAlive: true, backupAlive: false }));
  check('primary up, backup down → amber (no redundancy)', v.color === 'amber', JSON.stringify(v));
}

// AMBER: consecutive failures (below threshold)
{
  const v = deriveSmsHealth(baseInput({ primaryConsecutiveFailures: PRIMARY_FAILURE_THRESHOLD - 1 }));
  check('consecutive failures below threshold → amber', v.color === 'amber', JSON.stringify(v));
  // At threshold, failover should have fired; test only below-threshold amber
}

// AMBER: queue pending (not stuck)
{
  const v = deriveSmsHealth(baseInput({ termuxQueuePending: 3 }));
  check('queue pending (not stuck) → amber', v.color === 'amber', JSON.stringify(v));
}

// Threshold injection: custom stuckMs
{
  const v = deriveSmsHealth(baseInput({
    oldestPendingAgeMs: 10_000, // 10s
    backupAlive: false,
    pendingStuckMs: 5_000,      // custom low threshold
    pendingStuckMaxAgeMs: 60 * 60 * 1000,
  }));
  check('custom stuckMs threshold fires correctly', v.color === 'red', JSON.stringify(v));
}

// ── Part 1b: decideSmsAlertAction transitions ─────────────────────────────────

console.log('[sms-alert-health] Part 1b: decideSmsAlertAction transitions');

const NOW_DATE = new Date();
{
  check('green + no incident → nothing', decideSmsAlertAction('green', null) === 'nothing');
  check('amber + no incident → nothing (amber never emails)', decideSmsAlertAction('amber', null) === 'nothing');
  check('red + no incident → send-incident', decideSmsAlertAction('red', null) === 'send-incident');
  check('red + existing incident → hold', decideSmsAlertAction('red', NOW_DATE) === 'hold');
  check('green + existing incident → send-recovery', decideSmsAlertAction('green', NOW_DATE) === 'send-recovery');
  check('amber + existing incident → send-recovery', decideSmsAlertAction('amber', NOW_DATE) === 'send-recovery');
}

// ── Part 2: full checkSmsAlertHealth state machine (seam-injected) ────────────

console.log('[sms-alert-health] Part 2: full incident/recovery state machine');

function makeStubStorage(initial: Date | null = null) {
  const state = { marker: initial, setCalls: [] as (Date | null)[] };
  const storage = {
    getRelayOutageEscalatedAt: async (_key: string) => state.marker,
    setRelayOutageEscalatedAt: async (_key: string, at: Date | null) => {
      state.marker = at;
      state.setCalls.push(at);
    },
  } as any;
  return { state, storage };
}

const TEST_NOW = Date.now();
let emailsSent: { subject: string; html: string }[] = [];

function setMonitorDeps(opts: {
  color: 'green' | 'amber' | 'red';
  deployed?: boolean;
  failEmail?: boolean;
}) {
  emailsSent = [];
  smsAlertMonitorDeps.now = () => TEST_NOW;
  smsAlertMonitorDeps.isDeployed = () => opts.deployed !== false;
  smsAlertMonitorDeps.getHealthInput = async () => ({
    mode: 'termux' as const,
    twilioConfigured: false,
    primaryAlive: opts.color !== 'red',
    backupAlive: opts.color !== 'red',
    activeDevice: 'primary' as const,
    primaryConsecutiveFailures: 0,
    termuxQueuePending: 0,
    oldestPendingAgeMs: null,
  });
  smsAlertMonitorDeps.sendEmail = async (subject: string, html: string) => {
    if (opts.failEmail) throw new Error('simulated email failure');
    emailsSent.push({ subject, html });
  };
}

// Green: nothing happens
{
  resetSmsAlertMonitorForTests();
  const { state, storage } = makeStubStorage();
  setMonitorDeps({ color: 'green' });
  const r = await checkSmsAlertHealth(storage);
  check('green → ok, no email, no marker', r === 'ok' && emailsSent.length === 0 && state.marker === null, `result=${r}`);
}

// Amber: nothing happens (amber does not email)
{
  resetSmsAlertMonitorForTests();
  const { state, storage } = makeStubStorage();
  setMonitorDeps({ color: 'amber' });
  const r = await checkSmsAlertHealth(storage);
  check('amber → ok, no email', r === 'ok' && emailsSent.length === 0, `result=${r}`);
}

// Red → incident email (one-shot) + durable marker
{
  resetSmsAlertMonitorForTests();
  const { state, storage } = makeStubStorage();
  setMonitorDeps({ color: 'red' });
  const r1 = await checkSmsAlertHealth(storage);
  check('red → incident, 1 email, marker set', r1 === 'incident' && emailsSent.length === 1 && state.marker !== null, `result=${r1} emails=${emailsSent.length}`);
  check('incident email subject mentions DOWN', emailsSent[0]?.subject.includes('DOWN') === true, emailsSent[0]?.subject);

  // Still red: no second email
  setMonitorDeps({ color: 'red' });
  const r2 = await checkSmsAlertHealth(storage);
  check('still red → hold, no second email', r2 === 'hold' && emailsSent.length === 0, `result=${r2}`);

  // Simulated redeploy mid-incident: wipe in-memory, keep durable marker
  resetSmsAlertMonitorForTests();
  setMonitorDeps({ color: 'red' });
  const r3 = await checkSmsAlertHealth(storage);
  check('restart mid-incident → hold, no duplicate email', r3 === 'hold' && emailsSent.length === 0, `result=${r3}`);

  // Recovery: clear marker + send recovery email
  setMonitorDeps({ color: 'green' });
  const r4 = await checkSmsAlertHealth(storage);
  check('recovery → recovered, 1 email, marker cleared', r4 === 'recovered' && emailsSent.length === 1 && state.marker === null, `result=${r4} emails=${emailsSent.length}`);
  check('recovery email subject mentions RESTORED', emailsSent[0]?.subject.includes('RESTORED') === true, emailsSent[0]?.subject);

  // Healthy again: quiet
  setMonitorDeps({ color: 'green' });
  const r5 = await checkSmsAlertHealth(storage);
  check('healthy after recovery → ok', r5 === 'ok' && emailsSent.length === 0, `result=${r5}`);

  // New episode: escalates again (re-armed)
  setMonitorDeps({ color: 'red' });
  const r6 = await checkSmsAlertHealth(storage);
  check('new episode → incident again', r6 === 'incident' && emailsSent.length === 1, `result=${r6}`);
}

// Dev workspace: email suppressed
{
  resetSmsAlertMonitorForTests();
  const { state, storage } = makeStubStorage();
  setMonitorDeps({ color: 'red', deployed: false });
  const r = await checkSmsAlertHealth(storage);
  check('non-deployed + red → no email, no marker', r === 'ok' && emailsSent.length === 0 && state.marker === null, `result=${r}`);
}

// Email send failure still stamps marker (no retry spam)
{
  resetSmsAlertMonitorForTests();
  const { state, storage } = makeStubStorage();
  setMonitorDeps({ color: 'red', failEmail: true });
  const r1 = await checkSmsAlertHealth(storage);
  check('send failure → still marked incident', r1 === 'incident' && state.marker !== null, `result=${r1}`);
  setMonitorDeps({ color: 'red' });
  const r2 = await checkSmsAlertHealth(storage);
  check('after send failure → hold, no retry spam', r2 === 'hold' && emailsSent.length === 0, `result=${r2}`);
}

// Stamp ordering: durable DB marker persisted BEFORE email send (crash-safe)
{
  resetSmsAlertMonitorForTests();
  const callOrder: string[] = [];
  const stubStorage = {
    getRelayOutageEscalatedAt: async (_key: string) => null,
    setRelayOutageEscalatedAt: async (_key: string, at: Date | null) => {
      if (at !== null) callOrder.push('persist');
    },
  } as any;
  emailsSent = [];
  smsAlertMonitorDeps.now = () => TEST_NOW;
  smsAlertMonitorDeps.isDeployed = () => true;
  smsAlertMonitorDeps.getHealthInput = async () => ({
    mode: 'termux' as const, twilioConfigured: false,
    primaryAlive: false, backupAlive: false,
    activeDevice: 'primary' as const,
    primaryConsecutiveFailures: 0, termuxQueuePending: 0, oldestPendingAgeMs: null,
  });
  smsAlertMonitorDeps.sendEmail = async (subject: string, html: string) => {
    callOrder.push('email');
    emailsSent.push({ subject, html });
  };
  await checkSmsAlertHealth(stubStorage);
  check(
    'stamp ordering: persist fires before email send',
    callOrder[0] === 'persist' && callOrder[1] === 'email',
    JSON.stringify(callOrder),
  );
}

// DB persist failure → email skipped this tick (no duplicate-on-restart risk)
{
  resetSmsAlertMonitorForTests();
  let persistCalls = 0;
  const failPersistStorage = {
    getRelayOutageEscalatedAt: async (_key: string) => null,
    setRelayOutageEscalatedAt: async (_key: string, _at: Date | null) => {
      persistCalls++;
      throw new Error('simulated DB persist failure');
    },
  } as any;
  emailsSent = [];
  smsAlertMonitorDeps.now = () => TEST_NOW;
  smsAlertMonitorDeps.isDeployed = () => true;
  smsAlertMonitorDeps.getHealthInput = async () => ({
    mode: 'termux' as const, twilioConfigured: false,
    primaryAlive: false, backupAlive: false,
    activeDevice: 'primary' as const,
    primaryConsecutiveFailures: 0, termuxQueuePending: 0, oldestPendingAgeMs: null,
  });
  smsAlertMonitorDeps.sendEmail = async (subject: string, html: string) => {
    emailsSent.push({ subject, html });
  };
  const r1 = await checkSmsAlertHealth(failPersistStorage);
  check(
    'DB persist failure → incident returned, email skipped (no duplicate-on-restart risk)',
    r1 === 'incident' && emailsSent.length === 0 && persistCalls === 1,
    `result=${r1} emails=${emailsSent.length} persistCalls=${persistCalls}`,
  );
}

// ── Result ───────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`[sms-alert-health] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('[sms-alert-health] all checks passed');
process.exit(0);
