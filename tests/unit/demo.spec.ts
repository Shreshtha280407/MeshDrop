import { expect, it } from 'vitest';
import {
  INITIAL_DEMO,
  applyDemoRoomMessage,
  demoRoomMessage,
  runDemoLifecycle,
} from '@meshdrop/protocol/demo';

it('drives a synthetic session through schema-valid room messages and lifecycle states', () => {
  const states = runDemoLifecycle();
  expect(states[0]).toEqual(INITIAL_DEMO);
  expect(states.at(-1)).toEqual({ room: 'closed', peer: 'closed', transfer: 'complete' });
  expect(states.map((state) => state.transfer)).toContain('verifying');
});
it('rejects premature approval and malformed messages in the demonstration', () => {
  expect(() => applyDemoRoomMessage(INITIAL_DEMO, demoRoomMessage('PEER_APPROVED'))).toThrow(
    'Illegal transition',
  );
  expect(() => applyDemoRoomMessage(INITIAL_DEMO, '{}')).toThrow('Invalid protocol');
});
