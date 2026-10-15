import { ROOM_TRANSITIONS, PEER_TRANSITIONS, TRANSFER_TRANSITIONS } from '@meshdrop/protocol';
import { runDemoLifecycle } from '@meshdrop/protocol/demo';

console.log('MeshDrop P0 synthetic lifecycle — no networking, file writes, or authorization.');
console.table(runDemoLifecycle());
for (const [machine, table] of Object.entries({
  room: ROOM_TRANSITIONS,
  peer: PEER_TRANSITIONS,
  transfer: TRANSFER_TRANSITIONS,
})) {
  console.log(`\nPermitted ${machine} transitions (including idempotent repeats):`);
  for (const [from, events] of Object.entries(table)) {
    for (const [event, to] of Object.entries(events)) console.log(`${from} + ${event} -> ${to}`);
  }
}
