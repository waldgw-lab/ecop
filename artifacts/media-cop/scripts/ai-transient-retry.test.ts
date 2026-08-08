/**
 * Safety test for the article-submit retry hardening.
 *
 * The whole point of the fix is that a TRANSIENT provider blip (rate-limit /
 * 5xx / network / open circuit) is retried, while a GENUINE failure (bad URL,
 * unanalyzable content, real bug) is surfaced immediately and NEVER masked by a
 * retry. `isTransientAIError` is the single classifier both the route (503 vs
 * 500) and the implicit retry decision hang off, so we assert its boundaries.
 */
import { isTransientAIError, AICircuitOpenError } from '../server/aiClient';

let pass = 0;
let fail = 0;
function check(label: string, got: boolean, want: boolean) {
  if (got === want) {
    console.log(`PASS [${label}]`);
    pass++;
  } else {
    console.log(`FAIL [${label}] expected ${want}, got ${got}`);
    fail++;
  }
}

// --- TRANSIENT: must be retryable -----------------------------------------
check('429 rate-limit (OpenRouter upstream)', isTransientAIError({ status: 429 }), true);
check('429 nested on response', isTransientAIError({ response: { status: 429 } }), true);
check('500 provider error', isTransientAIError({ status: 500 }), true);
check('502 bad gateway', isTransientAIError({ status: 502 }), true);
check('503 service unavailable', isTransientAIError({ status: 503 }), true);
check('ECONNRESET network blip', isTransientAIError({ code: 'ECONNRESET' }), true);
check('ETIMEDOUT network blip', isTransientAIError({ code: 'ETIMEDOUT' }), true);
check('EAI_AGAIN DNS blip', isTransientAIError({ code: 'EAI_AGAIN' }), true);
check('APIConnectionError', isTransientAIError({ name: 'APIConnectionError' }), true);
check('APIConnectionTimeoutError', isTransientAIError({ name: 'APIConnectionTimeoutError' }), true);
check('open circuit breaker', isTransientAIError(new AICircuitOpenError('cooling down')), true);

// --- GENUINE: must NOT be retried (never mask a real failure) --------------
check('400 bad input', isTransientAIError({ status: 400 }), false);
check('404 not found', isTransientAIError({ status: 404 }), false);
check('422 unanalyzable URL', isTransientAIError({ status: 422 }), false);
check('plain Error (real bug)', isTransientAIError(new Error('boom')), false);
check('JSON parse failure shape', isTransientAIError(new SyntaxError('Unexpected token')), false);
check('null', isTransientAIError(null), false);
check('undefined', isTransientAIError(undefined), false);
check('409 duplicate', isTransientAIError({ status: 409 }), false);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
