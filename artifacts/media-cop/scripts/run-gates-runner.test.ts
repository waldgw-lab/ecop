/**
 * Synthetic tests for the consolidated gate runner. These use only throwaway
 * manifests and temp files: no application DB, server, network, or AI.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface SyntheticGate {
  name: string;
  cmd: string;
  timeoutMs?: number;
  inconclusive3?: boolean;
}

const root = process.cwd();
const runnerArgs = ['tsx', 'scripts/run-gates.ts'];
let assertions = 0;

function assert(condition: unknown, message: string): asserts condition {
  assertions++;
  if (!condition) throw new Error(message);
}

function run(
  manifest: SyntheticGate[],
  args: string[] = [],
  extraEnv: Record<string, string> = {},
): { status: number | null; output: string; elapsedMs: number } {
  const started = Date.now();
  const result = spawnSync('npx', [...runnerArgs, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GATES_MANIFEST_JSON: JSON.stringify(manifest),
      GATES_NO_RESUME: '1',
      ...extraEnv,
    },
    timeout: 20_000,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    elapsedMs: Date.now() - started,
  };
}

function resultNames(output: string): string[] {
  return [...output.matchAll(/^  (?:PASS|FAIL|INCONCLUSIVE)\s+([\w-]+)\s+/gm)].map((m) => m[1]);
}

function testConcurrencyAndCollection(dir: string): void {
  const events = join(dir, 'events.log');
  const mkGate = (name: string): SyntheticGate => ({
    name,
    cmd: `printf 'S ${name} %s\\n' \"$(date +%s%N)\" >> '${events}'; sleep 0.35; printf 'E ${name} %s\\n' \"$(date +%s%N)\" >> '${events}'`,
  });
  // These names are in the real reviewed parallel-safe allowlist. Unknown
  // synthetic names correctly fail closed to isolated scheduling.
  const manifest = [
    'title-cleaner',
    'watch-topic-bool-match',
    'curated-soft-cap',
    'summary-sanitizer',
  ].map(mkGate);
  const result = run(manifest, ['--jobs=2']);
  assert(result.status === 0, `parallel synthetic run failed:\n${result.output}`);
  const names = resultNames(result.output);
  assert(
    names.join(',') ===
      'title-cleaner,watch-topic-bool-match,curated-soft-cap,summary-sanitizer',
    `summary order/coverage wrong: ${names.join(',')}`,
  );
  assert(new Set(names).size === 4, 'duplicate result collected');
  const lines = readFileSync(events, 'utf8').trim().split('\n');
  const eventsParsed = lines
    .map((line) => {
      const [kind, name, at] = line.split(' ');
      return { kind, name, at: Number(at) };
    })
    .sort((a, b) => a.at - b.at);
  let active = 0;
  let maxActive = 0;
  for (const event of eventsParsed) {
    active += event.kind === 'S' ? 1 : -1;
    maxActive = Math.max(maxActive, active);
  }
  assert(maxActive === 2, `expected concurrency exactly 2, observed ${maxActive}`);

  const barrierEvents = join(dir, 'barrier-events.log');
  const barrierResult = run(
    [
      {
        name: 'title-cleaner',
        cmd: `printf 'S before %s\\n' \"$(date +%s%N)\" >> '${barrierEvents}'; sleep 0.2; printf 'E before %s\\n' \"$(date +%s%N)\" >> '${barrierEvents}'`,
      },
      {
        // Unknown names are isolated by default.
        name: 'resource-sensitive',
        cmd: `printf 'S barrier %s\\n' \"$(date +%s%N)\" >> '${barrierEvents}'; sleep 0.2; printf 'E barrier %s\\n' \"$(date +%s%N)\" >> '${barrierEvents}'`,
      },
      {
        name: 'summary-sanitizer',
        cmd: `printf 'S after %s\\n' \"$(date +%s%N)\" >> '${barrierEvents}'; sleep 0.2; printf 'E after %s\\n' \"$(date +%s%N)\" >> '${barrierEvents}'`,
      },
    ],
    ['--jobs=2'],
  );
  assert(barrierResult.status === 0, `barrier run failed:\n${barrierResult.output}`);
  const barrierLines = readFileSync(barrierEvents, 'utf8').trim().split('\n');
  assert(
    barrierLines.map((line) => line.split(' ').slice(0, 2).join(' ')).join(',') ===
      'S before,E before,S barrier,E barrier,S after,E after',
    `isolated gate overlapped a neighboring pool: ${barrierLines.join(' | ')}`,
  );
}

function testExitCodesSelectorsAndKeepGoing(): void {
  const manifest: SyntheticGate[] = [
    { name: 'inc', cmd: 'exit 3', inconclusive3: true },
    { name: 'bad3', cmd: 'exit 3' },
    { name: 'tail', cmd: 'exit 0' },
  ];
  const all = run(manifest);
  assert(all.status === 1, 'unapproved exit 3 must fail the runner');
  assert(all.output.includes('gate inc: INCONCLUSIVE'), 'approved exit 3 was not inconclusive');
  assert(all.output.includes('gate bad3: FAIL'), 'unapproved exit 3 was not a failure');
  assert(all.output.includes('gate tail: PASS'), 'keep-going did not collect the tail result');
  const selected = run(manifest, ['inc']);
  assert(selected.status === 0, 'named inconclusive-only run should be non-blocking');
  assert(resultNames(selected.output).join(',') === 'inc', 'named selector ran extra or missing gates');
  const unknown = run(manifest, ['missing']);
  assert(unknown.status === 2, 'unknown selector must exit 2');
}

function testTimeoutDescendantCleanup(dir: string): void {
  const pidFile = join(dir, 'descendant.pid');
  const result = run([
    {
      name: 'timeout-tree',
      cmd: `sleep 30 & echo $! > '${pidFile}'; wait`,
      timeoutMs: 200,
    },
  ]);
  assert(result.status === 1, 'timed-out gate must fail');
  assert(result.output.includes('timed out after 0s'), 'timeout note missing');
  assert(existsSync(pidFile), 'descendant PID was not captured');
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  assert(ps.status !== 0 || ps.stdout.trim() === '' || ps.stdout.trim().startsWith('Z'), `live descendant survived timeout: ${pid}`);
}

function testCheckpointTombstone(dir: string): void {
  const stateFile = join(dir, 'state.json');
  const behavior = join(dir, 'behavior');
  const manifest = [{ name: 'checkpointed', cmd: `test \"$(cat '${behavior}')\" = pass` }];
  const env = {
    GATES_NO_RESUME: '0',
    GATES_TEST_WORKSPACE_HASH: 'synthetic-workspace',
    GATES_TEST_STATE_FILE: stateFile,
  };
  writeFileSync(behavior, 'pass');
  const first = run(manifest, [], env);
  assert(first.status === 0 && existsSync(stateFile), 'initial checkpoint PASS was not persisted');
  const resumed = run(manifest, [], env);
  assert(resumed.status === 0 && resumed.output.includes('RESUME: 1 gate'), 'checkpoint PASS did not resume');
  writeFileSync(behavior, 'fail');
  const forcedFailure = run(manifest, ['checkpointed'], env);
  assert(forcedFailure.status === 1, 'explicit selector did not force checkpointed gate to rerun');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert(!state.entries.checkpointed, 'failed rerun did not tombstone stale PASS');
  const afterTombstone = run(manifest, [], env);
  assert(afterTombstone.status === 1 && !afterTombstone.output.includes('RESUME:'), 'stale PASS was resurrected');
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), 'run-gates-test-'));
  try {
    testConcurrencyAndCollection(dir);
    testExitCodesSelectorsAndKeepGoing();
    testTimeoutDescendantCleanup(dir);
    testCheckpointTombstone(dir);
    execFileSync('npx', ['tsx', 'scripts/gate-manifest-coverage.test.ts'], {
      cwd: root,
      stdio: 'inherit',
    });
    console.log(`[run-gates-runner] PASS (${assertions} assertions)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main();