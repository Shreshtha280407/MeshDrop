import { describe, expect, it } from 'vitest';
import { validatedAlert } from '../../apps/signaling/src/monitoring';
const alert = {
  id: 'failed_joins:123',
  kind: 'failed_joins',
  environment: 'preview',
  observedAt: 123456,
  value: 10,
  threshold: 10,
};
describe('operational alert privacy contract', () => {
  it('retains only the fixed, redacted operational schema', () =>
    expect(validatedAlert(alert)).toEqual(alert));
  it.each([
    { roomId: 'private' },
    { filename: 'private' },
    { token: 'private' },
    { url: 'private' },
  ])('rejects private metadata %j', (extra) =>
    expect(() => validatedAlert({ ...alert, ...extra })).toThrow(),
  );
  it.each([
    { kind: 'private' },
    { id: 'user:private' },
    { environment: 'unknown' },
    { value: NaN },
    { threshold: 0 },
    { observedAt: -1 },
  ])('rejects invalid alert fields %j', (extra) =>
    expect(() => validatedAlert({ ...alert, ...extra })).toThrow(),
  );
});
