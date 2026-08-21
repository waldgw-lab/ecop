/**
 * Operational-pause regression gate.
 *
 * DB-free and provider-free: proves the AI kill switch rejects at the public
 * entry points before provider fallback/retry work, and proves the production
 * view gate cannot accidentally hide development.
 */
process.env.AI_INTEGRATIONS_DISABLED = 'true';

import { shouldPauseProductionViews } from '../client/src/lib/operationalPause';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`PASS [${name}]`);
  } else {
    failed += 1;
    console.error(`FAIL [${name}]`);
  }
}

async function rejectsDisabled(
  name: string,
  ErrorType: typeof Error,
  run: () => Promise<unknown>,
): Promise<void> {
  const started = Date.now();
  let error: unknown;
  try {
    await run();
  } catch (caught) {
    error = caught;
  }
  check(`${name}: dedicated disabled error`, error instanceof ErrorType);
  check(`${name}: fails immediately`, Date.now() - started < 250);
}

async function main(): Promise<void> {
  const aiClient = await import('../server/aiClient');
  const { answerQuestion } = await import('../server/newsbot');
  const { generateNewsScrub } = await import('../server/newsScrubGenerator');
  const { runScoreRetry } = await import('../server/scoreRetry');
  const {
    shouldSkipMediaEnrichmentForAIPause,
    shouldUsePauseSafeCuratedWrite,
  } = await import('../server/streamPrefetch');
  const {
    AIIntegrationsDisabledError,
    getAIClientMetrics,
    isAIConfigured,
    isAIIntegrationsDisabled,
    isAnthropicConfigured,
    isOpenRouterConfigured,
    isTransientAIError,
    openai,
    setProviderMode,
  } = aiClient;

  check('kill switch active', isAIIntegrationsDisabled());
  check('aggregate AI configuration reports unavailable', !isAIConfigured());
  check('OpenRouter configuration reports unavailable', !isOpenRouterConfigured());
  check('Anthropic configuration reports unavailable', !isAnthropicConfigured());

  const before = getAIClientMetrics();
  setProviderMode('internal');
  await rejectsDisabled('shared gateway', AIIntegrationsDisabledError, () =>
    openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'This request must never leave the process.' }],
    }),
  );
  const after = getAIClientMetrics();
  check('shared gateway does not enter retry/fallback machinery', JSON.stringify(after) === JSON.stringify(before));
  check('disabled error is not retryable', !isTransientAIError(new AIIntegrationsDisabledError()));

  setProviderMode('openrouter');
  await rejectsDisabled('stored provider mode cannot bypass shutdown', AIIntegrationsDisabledError, () =>
    openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'A provider toggle must not re-enable this.' }],
    }),
  );

  await rejectsDisabled('MCOP Bot direct clients', AIIntegrationsDisabledError, () => answerQuestion('What happened today?'));
  await rejectsDisabled('news scrub direct Anthropic client', AIIntegrationsDisabledError, () =>
    generateNewsScrub(new Date(0), new Date()),
  );
  const scoreRetryStarted = Date.now();
  const scoreRetry = await runScoreRetry();
  check(
    'score retry is a no-op without consuming attempts',
    scoreRetry.retried === 0 && scoreRetry.rescored === 0 && scoreRetry.stillFailed === 0,
  );
  check('score retry skips before DB/provider work', Date.now() - scoreRetryStarted < 250);
  check(
    'paused media enrichment skips rows with a real image',
    shouldSkipMediaEnrichmentForAIPause('https://cdn.example.test/photo.jpg'),
  );
  check(
    'paused media enrichment still permits missing-image recovery',
    !shouldSkipMediaEnrichmentForAIPause(null),
  );
  check(
    'paused curated writes preserve AI state on disabled output',
    shouldUsePauseSafeCuratedWrite('ai_not_configured'),
  );
  check(
    'normal curated failures retain ordinary retry semantics',
    !shouldUsePauseSafeCuratedWrite('ai_error', false),
  );

  check('production + flag renders pause only', shouldPauseProductionViews(true, 'true'));
  check('production + false flag renders app', !shouldPauseProductionViews(true, 'false'));
  check('development ignores production pause flag', !shouldPauseProductionViews(false, 'true'));
  check('boolean flag supported for tests/config adapters', shouldPauseProductionViews(true, true));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});