/**
 * Team reviewed-submission retry contract.
 *
 * Static, deterministic guard over the client/server/storage wiring. It proves
 * that a response-loss retry reuses one client identity, PostgreSQL owns the
 * durable uniqueness boundary, duplicate requests return before asynchronous
 * submission side effects, and successful reviewed saves force fresh Team data.
 */
import fs from 'node:fs';
import { ApiRequestError, parseRetryAfterMs } from '../client/src/lib/queryClient';

let failures = 0;
function check(label: string, ok: boolean): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.error(`  FAIL  ${label}`);
  }
}

const team = fs.readFileSync('client/src/pages/Team.tsx', 'utf8');
const routes = fs.readFileSync('server/routes.ts', 'utf8');
const storage = fs.readFileSync('server/storage.ts', 'utf8');
const schema = fs.readFileSync('shared/schema.ts', 'utf8');
const migrate = fs.readFileSync('server/migrate.ts', 'utf8');
const index = fs.readFileSync('server/index.ts', 'utf8');
const readiness = fs.readFileSync('server/schemaReadiness.ts', 'utf8');
const queryClient = fs.readFileSync('client/src/lib/queryClient.ts', 'utf8');

console.log('\n[Team review idempotency + freshness]');

check('Retry-After seconds parse to milliseconds', parseRetryAfterMs('2', 0) === 2_000);
check('Retry-After HTTP dates parse to a bounded delay', parseRetryAfterMs('Thu, 01 Jan 1970 00:00:03 GMT', 1_000) === 2_000);
const shapedError = new ApiRequestError(503, 'initializing', 2_000);
check(
  'API request error retains status and server retry delay',
  shapedError.status === 503 && shapedError.retryAfterMs === 2_000,
);

check(
  'review intent creates and retains one idempotency key',
  team.includes('reviewSaveIdempotencyRef.current =') &&
    team.includes('idempotencyKey:') &&
    team.includes('reviewSaveIdempotencyRef.current ??'),
);
check(
  'review retry reuses the identical request body and is bounded',
  team.includes("return await apiRequest('POST', '/api/team/chat', body);") &&
    team.includes('const maxAttempts = reviewData ? 5 : 1') &&
    team.includes('for (let attempt = 1; attempt <= maxAttempts; attempt++)'),
);
check(
  'successful reviewed save immediately refetches chat, subjects, and topics',
  team.includes("queryClient.refetchQueries({ queryKey: ['/api/team/chat'] })") &&
    team.includes("queryClient.refetchQueries({ queryKey: ['/api/team/subjects'] })") &&
    team.includes("queryClient.refetchQueries({ queryKey: ['/api/team/topics'] })"),
);
check(
  'server only accepts durable request identity for reviewed saves',
  routes.includes("reviewData && typeof idempotencyKey === 'string'") &&
    routes.includes('storage.addChatMessageIdempotent'),
);
check(
  'duplicate server request exits before asynchronous URL processing',
  routes.indexOf('if (!chatResult.inserted) return res.json(chatMessage);') >= 0 &&
    routes.indexOf('if (!chatResult.inserted) return res.json(chatMessage);') <
      routes.indexOf('// Detect URLs in the message and process them with AI'),
);
check(
  'storage insert uses conflict-ignore and returns the existing row',
  storage.includes('async addChatMessageIdempotent') &&
    storage.includes('.onConflictDoNothing({') &&
    storage.includes('teamChatMessages.clientRequestId'),
);
check(
  'schema and boot migrator enforce user+clientRequestId uniqueness',
  schema.includes('team_chat_client_request_uniq') &&
    migrate.includes('CREATE UNIQUE INDEX team_chat_client_request_uniq ON team_chat_messages (user_id, client_request_id)') &&
    migrate.includes("column_name = 'client_request_id'") &&
    migrate.includes("indexname = 'team_chat_client_request_uniq'") &&
    migrate.includes('Required Team idempotency schema missing after migration'),
);
check(
  'reviewed writes stay retryably unavailable until boot schema init succeeds',
  routes.includes('getSchemaReadiness()') &&
    routes.includes("res.setHeader('Retry-After', '2')") &&
    routes.includes('res.status(503)') &&
    index.includes('markSchemaReady()') &&
    index.includes('markSchemaFailed(err)') &&
    readiness.includes('let schemaReady = false'),
);
check(
  'rare conflict visibility gap uses a bounded read retry',
  storage.includes('for (let attempt = 0; attempt < 3; attempt++)') &&
    storage.includes('existing row was not visible after bounded retry'),
);
check(
  'shared API error preserves status and Retry-After for readiness retries',
  queryClient.includes('export class ApiRequestError') &&
    queryClient.includes('readonly status: number') &&
    queryClient.includes('readonly retryAfterMs: number | null') &&
    queryClient.includes('parseRetryAfterMs(res.headers.get("Retry-After"))'),
);
check(
  'reviewed save honors retryable 503 delay with the same body/key',
  team.includes('error instanceof ApiRequestError') &&
    team.includes('error.status === 503') &&
    team.includes('error.retryAfterMs != null') &&
    team.includes('Math.min(error.retryAfterMs!, 5_000)'),
);

console.log('');
if (failures) {
  console.error(`[team-review-idempotency] FAIL — ${failures} check(s) failed`);
  process.exit(1);
}
console.log('[team-review-idempotency] PASS — all checks passed');
