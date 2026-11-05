import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { requireRelease, ReleaseError } from './release-record';

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
