import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import {
  canonical,
  parseManifest,
  requireRelease,
  ReleaseError,
  sameContent,
} from './release-record';
import type { Manifest } from './release-record';
import { inspectRecovery, parseRecoveryEvent, recoveryScope } from './recovery-evidence';
import type { RecoveryEvent, RecoveryHead, RecoveryStore } from './recovery-evidence';

export interface RecoverySql {
  readonly scope: 'offline-fixture' | 'external-authenticated';
  execute(sql: string): Promise<string>;
}
/** Explicit libpq configuration. Never reads process.env or a project's .env. */
export type PsqlConfiguration = {
  executable: string;
  host: string;
  port: number;
  database: string;
  user: string;
  caFile: string;
  passwordFile: string;
};
export class PsqlRecoveryConnection implements RecoverySql {
  readonly scope = 'external-authenticated' as const;
  private readonly config: PsqlConfiguration;
  constructor(value: PsqlConfiguration) {
    requireRelease(
      value &&
        [value.executable, value.caFile, value.passwordFile].every(
          (p) => typeof p === 'string' && isAbsolute(p),
        ) &&
        /^[A-Za-z0-9.-]+$/.test(value.host) &&
        Number.isInteger(value.port) &&
        value.port > 0 &&
        value.port <= 65535 &&
        [value.database, value.user].every((v) => /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(v)),
      'EXPLICIT_POSTGRES_CONFIGURATION_REQUIRED',
    );
    this.config = structuredClone(value);
  }
  async execute(sql: string): Promise<string> {
    const c = this.config;
    requireRelease(sql.length <= 2 * 1024 * 1024, 'RECOVERY_SQL_LIMIT');
    return new Promise((resolve, reject) => {
      const child = execFile(
        c.executable,
        [
          '--no-psqlrc',
          '--no-password',
          '--quiet',
          '--tuples-only',
          '--no-align',
          '--set',
          'ON_ERROR_STOP=1',
          '--host',
          c.host,
          '--port',
          String(c.port),
          '--dbname',
          c.database,
          '--username',
          c.user,
          '--file',
          '-',
        ],
        {
          timeout: 20000,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            PGSSLMODE: 'verify-full',
            PGSSLROOTCERT: c.caFile,
            PGPASSFILE: c.passwordFile,
            PGCONNECT_TIMEOUT: '5',
            PGOPTIONS:
              '-c search_path=pg_catalog -c statement_timeout=10000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=10000',
            LC_ALL: 'C',
          },
        },
        (error, stdout) =>
          error
            ? reject(new ReleaseError('RECOVERY_DATABASE_UNAVAILABLE_OR_CONFLICT'))
            : resolve(stdout),
      );
      child.stdin?.on('error', () => {});
      child.stdin?.end(sql);
    });
  }
}
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
// Only hex digits enter SQL literals. No shell and no interpolated JSON/identifiers.
function json(value: unknown) {
  return `convert_from(decode('${Buffer.from(canonical(value)).toString('hex')}','hex'),'UTF8')`;
}
/** Concrete PostgreSQL adapter; schema installation/credentials remain separate.
 * TLS authenticates the server. It does not certify retention, a correct server
 * administrator or an independent latest-head witness. No silent local fallback.
 */
export class PostgresRecoveryStore implements RecoveryStore {
  readonly scope: RecoveryStore['scope'];
  private readonly manifest: Manifest;
  constructor(
    manifest: Manifest,
    private readonly storeId: string,
    private readonly connection: RecoverySql,
  ) {
    requireRelease(UUID.test(storeId), 'PINNED_RECOVERY_STORE_REQUIRED');
    this.manifest = structuredClone(parseManifest(manifest));
    this.scope = connection.scope;
  }
  private async execute(sql: string) {
    try {
      const text = await this.connection.execute(sql);
      requireRelease(Buffer.byteLength(text) <= 4 * 1024 * 1024, 'RECOVERY_RESPONSE_LIMIT');
      const result = JSON.parse(text);
      requireRelease(result && result.storeId === this.storeId, 'RECOVERY_STORE_IDENTITY_MISMATCH');
      return result;
    } catch (error) {
      throw error instanceof ReleaseError
        ? error
        : new ReleaseError('RECOVERY_DATABASE_UNAVAILABLE_OR_CONFLICT');
    }
  }
  async append(value: RecoveryEvent, expected: RecoveryHead | null): Promise<RecoveryHead> {
    const event = parseRecoveryEvent(value, this.manifest, value.attemptId);
    requireRelease(event.sequence <= 9999, 'RECOVERY_HISTORY_LIMIT');
    requireRelease(Buffer.byteLength(canonical(event)) <= 262144, 'RECOVERY_EVENT_LIMIT');
    if (expected)
      requireRelease(
        expected.scopeId === event.scopeId &&
          expected.attemptId === event.attemptId &&
          expected.sequence === event.sequence - 1 &&
          expected.hash === event.previousHash,
        'RECOVERY_HEAD_MISMATCH',
      );
    else requireRelease(event.kind === 'START' && event.sequence === 0, 'INVALID_RECOVERY_START');
    const payload = Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'hash'));
    const result = await this.execute(
      `SELECT meshdrop_recovery.append_event('${this.storeId}'::uuid,${json(event)},${json(payload)},${expected === null ? 'NULL' : `${json(expected)}::jsonb`});`,
    );
    const head = {
      scopeId: event.scopeId,
      attemptId: event.attemptId,
      sequence: event.sequence,
      hash: event.hash,
    };
    requireRelease(sameContent(result.head, head), 'RECOVERY_RECEIPT_MISMATCH');
    return head;
  }
  async read(scopeId: string, attemptId: string) {
    requireRelease(
      scopeId === recoveryScope(this.manifest) && UUID.test(attemptId),
      'RECOVERY_SCOPE_MISMATCH',
    );
    const result = await this.execute(
      `SELECT meshdrop_recovery.read_history('${this.storeId}'::uuid,'${scopeId}','${attemptId}'::uuid);`,
    );
    requireRelease(Array.isArray(result.events), 'RECOVERY_HISTORY_MISSING');
    const inspected = inspectRecovery(this.manifest, attemptId, result.events, result.head);
    return { events: inspected.events, head: inspected.head };
  }
}
