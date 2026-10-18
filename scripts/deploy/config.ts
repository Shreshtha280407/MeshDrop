import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { turnProvider } from '../../apps/signaling/src/turn-config';

export type Environment = 'preview' | 'production';
export function environment(value: string | undefined): Environment {
  if (value !== 'preview' && value !== 'production')
    throw new Error('Choose preview or production.');
  return value;
}

export function deploymentConfig(
  target: Environment,
  values: Record<string, string | undefined>,
  root: string,
) {
  const project = values.PAGES_PROJECT ?? '';
  if (!/^[a-z][a-z0-9-]{2,40}$/.test(project) || project.includes('yourname'))
    throw new Error('Set a unique PAGES_PROJECT using lowercase letters, digits and hyphens.');
  if (!project.endsWith(`-${target}`))
    throw new Error('PAGES_PROJECT must end with the selected environment name.');
  const origin = values.PUBLIC_ORIGIN || `https://${project}.pages.dev`;
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password)
    throw new Error('PUBLIC_ORIGIN must be one exact HTTPS origin.');
  if (!/^[A-Za-z0-9_-]{43}$/.test(values.OPS_REVOKE_SECRET ?? ''))
    throw new Error('OPS_REVOKE_SECRET must be a random 32-byte base64url value.');
  const turnUrls = values.TURN_URLS?.trim() ?? '';
  const turnSecret = values.TURN_SHARED_SECRET?.trim() ?? '';
  const provider = turnProvider({
    TURN_PROVIDER: values.TURN_PROVIDER,
    TURN_URLS: turnUrls,
    TURN_SHARED_SECRET: turnSecret,
    CLOUDFLARE_TURN_KEY_ID: values.CLOUDFLARE_TURN_KEY_ID,
    CLOUDFLARE_TURN_API_TOKEN: values.CLOUDFLARE_TURN_API_TOKEN,
  });
  if (values.ADMISSION_PAUSED && !['true', 'false'].includes(values.ADMISSION_PAUSED))
    throw new Error('ADMISSION_PAUSED must be true or false.');
  const workerName = `${project}-signaling`;
  const namespace = (kind: string) =>
    String(
      BigInt(
        `0x${createHash('sha256').update(`${workerName}:${kind}`).digest('hex').slice(0, 12)}`,
      ) + 1n,
    );
  const directory = resolve(root, '.meshdrop-artifacts/deploy', target);
  const worker = {
    name: workerName,
    main: './worker/index.js',
    compatibility_date: '2026-07-01',
    workers_dev: false,
    preview_urls: false,
    send_metrics: false,
    upload_source_maps: false,
    vars: {
      ENVIRONMENT: target,
      ALLOWED_ORIGINS: origin,
      STUN_URLS: 'stun:stun.cloudflare.com:3478',
      TURN_PROVIDER: provider,
      TURN_URLS: turnUrls,
      TURN_TTL_SECONDS: '300',
      ROOM_TTL_SECONDS: '900',
      INVITE_TTL_SECONDS: '300',
      WS_TICKET_TTL_SECONDS: '30',
      CLOSED_TOMBSTONE_SECONDS: '60',
      ADMISSION_PAUSED: values.ADMISSION_PAUSED ?? 'false',
      AUDIT_LOGS: 'true',
    },
    durable_objects: { bindings: [{ name: 'SESSION_ROOMS', class_name: 'SessionRoom' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['SessionRoom'] }],
    ratelimits: [
      {
        name: 'CREATE_LIMITER',
        namespace_id: namespace('create'),
        simple: { limit: 30, period: 60 },
      },
      {
        name: 'REQUEST_LIMITER',
        namespace_id: namespace('request'),
        simple: { limit: 300, period: 60 },
      },
    ],
    observability: {
      enabled: true,
      head_sampling_rate: 0.1,
      logs: { enabled: true, invocation_logs: false },
    },
  };
  const binding = [{ binding: 'SIGNALING', service: workerName }];
  const pages = {
    name: project,
    compatibility_date: '2026-07-01',
    pages_build_output_dir: './web',
    vars: { PUBLIC_ORIGIN: origin },
    services: binding,
    // Separate Pages projects per release environment. Unstable branch/hash
    // aliases are refused by the gateway even when Cloudflare binds them here.
    env: { preview: { vars: { PUBLIC_ORIGIN: origin }, services: binding } },
  };
  return { directory, origin, project, workerName, worker, pages };
}
