import {
  apiErrorSchema,
  capabilitySchema,
  parseSignalingMessage,
  serializeSignalingMessage,
  sessionCreatedSchema,
  sessionStatusSchema,
  socketTicketSchema,
  uuidSchema,
} from '@meshdrop/protocol';
import type { SessionStatus } from '@meshdrop/protocol';

interface Credentials {
  roomId: string;
  peerId: string;
  capability: string;
}
export interface RoomView {
  status: SessionStatus | null;
  connection: 'disconnected' | 'connecting' | 'connected';
  invitation: string;
  busy: boolean;
  error: string;
  events: readonly string[];
  receivedSignals: number;
}
const INITIAL: RoomView = {
  status: null,
  connection: 'disconnected',
  invitation: '',
  busy: false,
  error: '',
  events: [],
  receivedSignals: 0,
};
export function parseInvitation(value: string): { roomId: string; capability: string } {
  const url = new URL(value);
  const hash = new URLSearchParams(url.hash.slice(1));
  if (
    url.origin !== window.location.origin ||
    url.search ||
    Array.from(hash.keys()).length !== 2 ||
    !hash.has('room') ||
    !hash.has('invite')
  )
    throw new Error('Use a MeshDrop invitation from this application.');
  return {
    roomId: uuidSchema.parse(hash.get('room')),
    capability: capabilitySchema.parse(hash.get('invite')),
  };
}
function newCapability(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
/** P1 admission adapter. Credentials stay in memory, never in web storage or logs. */
export class RoomClient {
  private view: RoomView = INITIAL;
  private readonly listeners = new Set<() => void>();
  private credentials: Credentials | null = null;
  private joinAttempt: { invite: string; peerId: string; peerCapability: string } | null = null;
  private socket: WebSocket | null = null;
  private polling: ReturnType<typeof setInterval> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private nextSeq = 0;
  private connecting = false;
  private refreshInFlight = false;
  private generation = 0;
  readonly getSnapshot = () => this.view;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<RoomView>) {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }
  private event(message: string) {
    this.update({ events: [...this.view.events.slice(-29), message] });
  }
  private async api(
    path: string,
    method: string,
    token?: string,
    body?: unknown,
  ): Promise<unknown> {
    const generation = this.generation;
    const response = await fetch(path, {
      method,
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(await response.json().catch(() => null));
      if (parsed.success) throw new Error(`${parsed.data.code}: ${parsed.data.message}`);
      throw new Error('The signaling service is unavailable. Try again.');
    }
    const bodyResult: unknown = await response.json();
    if (generation !== this.generation) throw new Error('Local session changed.');
    return bodyResult;
  }
  private async action(work: () => Promise<void>): Promise<void> {
    if (this.view.busy) return;
    const generation = this.generation;
    this.update({ busy: true, error: '' });
    try {
      await work();
    } catch (error) {
      if (generation !== this.generation || this.view.status?.state === 'closed') return;
      this.update({ error: error instanceof Error ? error.message : 'Operation failed.' });
    } finally {
      if (generation === this.generation) this.update({ busy: false });
    }
  }
  async createRoom(): Promise<void> {
    return this.action(async () => {
      const room = sessionCreatedSchema.parse(
        await this.api('/v1/sessions', 'POST', undefined, {}),
      );
      this.credentials = {
        roomId: room.roomId,
        peerId: room.peerId,
        capability: room.ownerCapability,
      };
      const invitation = `${window.location.origin}/#room=${room.roomId}&invite=${room.inviteCapability}`;
      this.update({ invitation, events: [], receivedSignals: 0 });
      this.event('Room created. Waiting for a receiver request.');
      await this.refresh();
      this.startPolling();
      await this.connect();
    });
  }
  async joinRoom(value: string): Promise<void> {
    return this.action(async () => {
      let invitation: ReturnType<typeof parseInvitation>;
      try {
        invitation = parseInvitation(value);
      } catch {
        throw new Error('Invalid invitation. Paste the complete private invitation link.');
      }
      if (!this.joinAttempt || this.joinAttempt.invite !== value)
        this.joinAttempt = {
          invite: value,
          peerId: crypto.randomUUID(),
          peerCapability: newCapability(),
        };
      const { peerId, peerCapability } = this.joinAttempt;
      const status = sessionStatusSchema.parse(
        await this.api(`/v1/sessions/${invitation.roomId}/join`, 'POST', invitation.capability, {
          peerId,
          peerCapability,
        }),
      );
      this.credentials = { roomId: status.roomId, peerId, capability: peerCapability };
      this.update({ status, events: [], invitation: '', receivedSignals: 0 });
      this.event(
        status.approval === 'approved'
          ? 'Admission already approved.'
          : 'Request sent. The room owner must approve you.',
      );
      this.startPolling();
      if (status.approval === 'approved') await this.connect();
    });
  }
  async decide(decision: 'approve' | 'reject'): Promise<void> {
    return this.action(async () => {
      const credentials = this.credentials;
      const candidatePeerId = this.view.status?.candidatePeerId;
      if (!credentials || !candidatePeerId) return;
      const status = sessionStatusSchema.parse(
        await this.api(
          `/v1/sessions/${credentials.roomId}/decisions`,
          'POST',
          credentials.capability,
          { candidatePeerId, decision },
        ),
      );
      this.update({ status });
      this.event(
        decision === 'approve'
          ? 'Receiver approved.'
          : 'Receiver rejected. Create a new room to invite someone else.',
      );
    });
  }
  private startPolling(): void {
    if (this.polling) clearInterval(this.polling);
    this.polling = setInterval(() => {
      void this.refresh().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Status is unavailable.';
        if (message.startsWith('ROOM_CLOSED') || message.startsWith('NOT_FOUND')) this.markClosed();
        else this.update({ error: message });
      });
    }, 1500);
  }
  private async refresh(): Promise<void> {
    const credentials = this.credentials;
    if (!credentials || this.refreshInFlight || this.view.status?.state === 'closed') return;
    this.refreshInFlight = true;
    const generation = this.generation;
    try {
      const status = sessionStatusSchema.parse(
        await this.api(`/v1/sessions/${credentials.roomId}/status`, 'GET', credentials.capability),
      );
      if (generation !== this.generation) return;
      const approvedNow =
        this.view.status?.approval === 'pending' && status.approval === 'approved';
      this.update({ status });
      if (approvedNow) {
        this.event('Owner approved admission.');
        await this.connect();
      }
    } finally {
      if (generation === this.generation) this.refreshInFlight = false;
    }
  }
  async reconnect(): Promise<void> {
    return this.action(async () => {
      await this.refresh();
      await this.connect();
    });
  }
  private async connect(): Promise<void> {
    const credentials = this.credentials;
    if (
      !credentials ||
      this.connecting ||
      this.view.status?.approval !== 'approved' ||
      this.view.status.state === 'closed'
    )
      return;
    this.connecting = true;
    this.update({ connection: 'connecting' });
    try {
      const issued = socketTicketSchema.parse(
        await this.api(
          `/v1/sessions/${credentials.roomId}/ws-ticket`,
          'POST',
          credentials.capability,
          {},
        ),
      );
      this.nextSeq = issued.nextSeq;
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const previous = this.socket;
      const socket = new WebSocket(
        `${scheme}//${window.location.host}/v1/sessions/${credentials.roomId}/ws`,
        ['meshdrop.v1', `meshdrop.ticket.${issued.ticket}`],
      );
      this.socket = socket;
      previous?.close();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error('Signaling connection timed out. Request a fresh connection.'));
        }, 8000);
        socket.onopen = () => {
          if (socket !== this.socket) return;
          clearTimeout(timer);
          this.update({ connection: 'connected', error: '' });
          this.event('Authorized signaling socket opened.');
          if (this.heartbeat) clearInterval(this.heartbeat);
          this.heartbeat = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send('ping');
          }, 25000);
          resolve();
        };
        socket.onerror = () => {
          clearTimeout(timer);
          reject(new Error('Signaling admission failed. Request a fresh connection.'));
        };
        socket.onclose = () => {
          clearTimeout(timer);
          if (socket !== this.socket) return;
          if (this.heartbeat) clearInterval(this.heartbeat);
          this.update({ connection: 'disconnected' });
          reject(new Error('Signaling connection closed.'));
        };
        socket.onmessage = (event: MessageEvent<unknown>) => {
          if (socket !== this.socket || event.data === 'pong' || typeof event.data !== 'string')
            return;
          try {
            const envelope = parseSignalingMessage(event.data);
            if (
              envelope.roomId !== credentials.roomId ||
              envelope.epoch !== this.view.status?.epoch
            )
              throw new Error('Unexpected signaling scope.');
            if (envelope.type === 'ERROR') {
              this.update({ error: `${envelope.payload.code}: ${envelope.payload.message}` });
              return;
            }
            if (envelope.type === 'ROOM_CLOSED') {
              this.event('Room closed. Admission revoked.');
              this.markClosed();
              return;
            }
            if (
              ['SDP_OFFER', 'SDP_ANSWER', 'ICE_CANDIDATE', 'RENEGOTIATE'].includes(envelope.type)
            ) {
              this.event(`Received ${envelope.type} signaling probe from the approved peer.`);
              this.update({ receivedSignals: this.view.receivedSignals + 1 });
            } else if (envelope.type !== 'JOINED') {
              this.event(envelope.type.replaceAll('_', ' '));
              void this.refresh().catch(() => {});
            }
          } catch {
            this.update({ error: 'Invalid signaling response. Reconnect to continue.' });
            socket.close();
          }
        };
      });
    } catch (error) {
      this.update({ connection: 'disconnected' });
      throw error;
    } finally {
      this.connecting = false;
    }
  }
  sendProbe(): void {
    const credentials = this.credentials;
    const status = this.view.status;
    if (
      !credentials ||
      !status ||
      this.socket?.readyState !== WebSocket.OPEN ||
      status.state !== 'approved'
    )
      return;
    this.socket.send(
      serializeSignalingMessage({
        version: 1,
        type: status.role === 'owner' ? 'SDP_OFFER' : 'SDP_ANSWER',
        roomId: credentials.roomId,
        peerId: credentials.peerId,
        messageId: crypto.randomUUID(),
        epoch: status.epoch,
        seq: this.nextSeq++,
        sentAt: new Date().toISOString(),
        payload: { sdp: 'MeshDrop P1 signaling probe. No WebRTC negotiation or file content.' },
      }),
    );
    this.event('Sent signaling probe; delivery is visible on the other device.');
  }
  async closeRoom(): Promise<void> {
    return this.action(async () => {
      const credentials = this.credentials;
      if (!credentials) return;
      await this.api(`/v1/sessions/${credentials.roomId}`, 'DELETE', credentials.capability);
      this.markClosed();
    });
  }
  private markClosed(): void {
    this.generation++;
    if (this.polling) clearInterval(this.polling);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close();
    this.update({
      status: this.view.status ? { ...this.view.status, state: 'closed' } : null,
      connection: 'disconnected',
      invitation: '',
      busy: false,
    });
  }
  reset(): void {
    this.dispose();
    this.credentials = null;
    this.joinAttempt = null;
    this.update({ ...INITIAL });
  }
  dispose(): void {
    this.generation++;
    this.refreshInFlight = false;
    if (this.polling) clearInterval(this.polling);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close();
    this.socket = null;
  }
}
