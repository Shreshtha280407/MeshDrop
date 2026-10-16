import { capabilitySchema } from '@meshdrop/protocol';
import { HttpError } from '../errors';

export function randomCapability(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
export async function verifier(kind: string, scope: string, capability: string): Promise<string> {
  const bytes = new TextEncoder().encode(`meshdrop:v1:${kind}:${scope}:${capability}`);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function bearer(request: Request): string {
  const header = request.headers.get('Authorization');
  if (!header?.startsWith('Bearer '))
    throw new HttpError(401, 'UNAUTHORIZED', 'A scoped capability is required.');
  const capability = header.slice(7);
  if (!capabilitySchema.safeParse(capability).success)
    throw new HttpError(401, 'UNAUTHORIZED', 'Invalid capability.');
  return capability;
}
