// Process-local startup readiness for routes that depend on newly-added schema.
// The health-check port may open before migrations finish, but writes using new
// columns must fail explicitly/retryably rather than racing DDL or silently
// running forever after a failed migration.
let schemaReady = false;
let schemaError: string | null = null;

export function markSchemaReady(): void {
  schemaReady = true;
  schemaError = null;
}

export function markSchemaFailed(error: unknown): void {
  schemaReady = false;
  schemaError = error instanceof Error ? error.message : String(error);
}

export function getSchemaReadiness(): { ready: boolean; error: string | null } {
  return { ready: schemaReady, error: schemaError };
}
