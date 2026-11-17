export const A11Y_STATES = [
  'pairing',
  'offer',
  'active',
  'paused',
  'verification',
  'completed',
  'storage-full',
  'error',
  'recovery',
  'cancelled',
] as const;
export type A11yState = (typeof A11Y_STATES)[number];
