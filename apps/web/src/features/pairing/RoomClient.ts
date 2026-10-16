import {
  apiErrorSchema,
  connectionEpochSchema,
  iceConfigurationSchema,
  capabilitySchema,
  parseSignalingMessage,
  serializeSignalingMessage,
  sessionCreatedSchema,
  sessionStatusSchema,
  socketTicketSchema,
  uuidSchema,
} from '@meshdrop/protocol';
import { INITIAL_TRANSFER, TransferMachine } from '@meshdrop/transfer-core';
import type { TransferView } from '@meshdrop/transfer-core';
import type { FileControl } from '@meshdrop/protocol';
import { INITIAL_PEER, PeerSession } from '@meshdrop/peer-connection';
import type { PeerSignal, PeerView } from '@meshdrop/peer-connection';
import type { SessionStatus, SignalingEnvelope } from '@meshdrop/protocol';

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
  peer: PeerView;
  transfer: TransferView;
}
const INITIAL: RoomView = {
  status: null,
  connection: 'disconnected',
  invitation: '',
  busy: false,
  error: '',
  events: [],
  peer: INITIAL_PEER,
  transfer: INITIAL_TRANSFER,
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
/** Admission and browser peer-session adapter. Credentials stay in memory, never in web storage or logs. */
export class RoomClient {
  private view: RoomView = INITIAL;
  private readonly listeners = new Set<() => void>();
  private credentials: Credentials | null = null;
  private joinAttempt: { invite: string; peerId: string; peerCapability: string } | null = null;
  private socket: WebSocket | null = null;
  private polling: ReturnType<typeof setInterval> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private nextSeq = 0;
  private peerSession: PeerSession | null = null;
  private transfer: TransferMachine | null = null;
  private readonly downloadUrls = new Map<string, string>();
  private signalQueue: Promise<void> = Promise.resolve();
  private startingEpoch = false;
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
      this.update({ invitation, events: [], peer: INITIAL_PEER });
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
      this.update({ status, events: [], invitation: '', peer: INITIAL_PEER });
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
      if ((this.view.status?.epoch ?? 0) > status.epoch) return;
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
      const generation = this.generation;
      this.closePeer();
      this.signalQueue = Promise.resolve();
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
          if (socket !== this.socket || generation !== this.generation) {
            socket.close();
            return;
          }
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
          this.closePeer();
          this.update({ connection: 'disconnected' });
          reject(new Error('Signaling connection closed.'));
        };
        socket.onmessage = (event: MessageEvent<unknown>) => {
          if (socket !== this.socket || event.data === 'pong' || typeof event.data !== 'string')
            return;
          try {
            const envelope = parseSignalingMessage(event.data);
            if (envelope.roomId !== credentials.roomId)
              throw new Error('Unexpected signaling scope.');
            if (envelope.type === 'ROOM_CLOSED') {
              this.event('Room closed. Admission revoked.');
              this.markClosed();
              return;
            }
            this.signalQueue = this.signalQueue
              .then(async () => {
                if (socket === this.socket && generation === this.generation)
                  await this.handleSignal(envelope);
              })
              .catch(() => {
                if (generation === this.generation) {
                  this.peerSession?.fail('Peer negotiation failed. Request a new connection.');
                  this.update({ error: 'Peer negotiation failed. Request a new connection.' });
                }
              });
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
  private async handleSignal(envelope: SignalingEnvelope): Promise<void> {
    const status = this.view.status;
    if (!status) return;
    if (envelope.epoch < status.epoch) return;
    if (envelope.type === 'CONNECTION_EPOCH') {
      const epoch = connectionEpochSchema.parse(envelope.payload);
      if (epoch.epoch !== envelope.epoch || epoch.epoch <= (this.peerSession?.epoch ?? 0)) return;
      this.update({ status: { ...status, epoch: epoch.epoch } });
      const credentials = this.credentials!;
      const configuration = iceConfigurationSchema.parse(
        await this.api(
          `/v1/sessions/${credentials.roomId}/ice-credentials`,
          'POST',
          credentials.capability,
          {},
        ),
      );
      if (!this.peerSession)
        this.peerSession = new PeerSession({
          roomId: credentials.roomId,
          peerId: credentials.peerId,
          role: status.role === 'owner' ? 'owner' : 'receiver',
          sendSignal: (type, payload) => this.sendSignal(type, payload),
          onChange: (peer) => this.peerChanged(peer),
          onFileControl: (message) => this.receiveFileControl(message),
          onFileFrame: async (bytes) => {
            if (!this.transfer) throw new Error('No accepted transfer.');
            await this.transfer.receiveFrame(bytes);
          },
        });
      this.event(`Starting connection epoch ${epoch.epoch}. Compare the new pairing code.`);
      await this.peerSession.start(epoch, configuration);
    } else if (envelope.epoch !== status.epoch) {
      throw new Error('Unexpected signaling epoch.');
    } else if (envelope.type === 'ERROR') {
      this.update({ error: `${envelope.payload.code}: ${envelope.payload.message}` });
      if (envelope.payload.code === 'PEER_UNAVAILABLE') this.closePeer();
    } else if (envelope.type === 'PEER_READY') {
      if (status.role === 'owner' && !this.peerSession)
        void this.requestConnection('new-connection');
    } else if (envelope.type === 'RENEGOTIATE') {
      if (status.role === 'owner') void this.requestConnection(envelope.payload.reason);
    } else if (
      envelope.type === 'SDP_OFFER' ||
      envelope.type === 'SDP_ANSWER' ||
      envelope.type === 'ICE_CANDIDATE'
    ) {
      if (!this.peerSession) throw new Error('Connection epoch has not been admitted.');
      await this.peerSession.receiveSignal(envelope);
    } else if (envelope.type !== 'JOINED') {
      this.event(envelope.type.replaceAll('_', ' '));
      void this.refresh().catch(() => {});
    }
  }
  private sendSignal(type: PeerSignal['type'], payload: PeerSignal['payload']): void {
    const credentials = this.credentials;
    const status = this.view.status;
    if (
      !credentials ||
      !status ||
      this.socket?.readyState !== WebSocket.OPEN ||
      status.state !== 'approved'
    )
      throw new Error('Authorized signaling is unavailable.');
    this.socket.send(
      serializeSignalingMessage({
        version: 1,
        type,
        roomId: credentials.roomId,
        peerId: credentials.peerId,
        messageId: crypto.randomUUID(),
        epoch: status.epoch,
        seq: this.nextSeq++,
        sentAt: new Date().toISOString(),
        payload,
      } as SignalingEnvelope),
    );
  }
  async requestConnection(mode: 'ice-restart' | 'new-connection'): Promise<void> {
    if (this.startingEpoch) return;
    this.startingEpoch = true;
    try {
      const credentials = this.credentials;
      const status = this.view.status;
      if (!credentials || !status || status.state !== 'approved') return;
      if (status.role === 'owner') {
        await this.api(
          `/v1/sessions/${credentials.roomId}/connection`,
          'POST',
          credentials.capability,
          { expectedEpoch: status.epoch, mode },
        );
      } else this.sendSignal('RENEGOTIATE', { reason: mode });
      this.update({ error: '' });
    } catch (error) {
      this.update({ error: error instanceof Error ? error.message : 'Connection request failed.' });
    } finally {
      this.startingEpoch = false;
    }
  }
  async sendPing(): Promise<void> {
    try {
      await this.peerSession?.ping();
    } catch (error) {
      this.update({ error: error instanceof Error ? error.message : 'Ping failed.' });
    }
  }
  confirmComparison(entered: string, independentConfirmation: boolean): void {
    this.peerSession?.confirmComparison(entered, independentConfirmation);
  }
  rejectComparison(): void {
    this.peerSession?.rejectComparison();
  }
  private peerChanged(peer: PeerView): void {
    if (this.transfer && (!peer.ready || this.transfer.epoch !== peer.epoch))
      this.transfer.disconnect();
    this.update({ peer });
    this.ensureTransfer();
  }
  private ensureTransfer(): void {
    const peer = this.peerSession;
    if (
      this.transfer ||
      !peer?.canTransfer ||
      !this.view.status ||
      !peer.snapshot.capabilities?.storageModes.includes('opfs')
    )
      return;
    this.transfer = new TransferMachine({
      role: this.view.status.role === 'owner' ? 'owner' : 'receiver',
      epoch: peer.epoch,
      frameBytes: peer.snapshot.capabilities.preferredFrameBytes,
      transport: {
        get bufferedAmount() {
          return peer.bufferedAmount;
        },
        sendControl: (message) => peer.sendFileControl(message),
        sendFrame: (bytes) => peer.sendFileFrame(bytes),
        waitForDrain: (signal) => peer.waitForDrain(signal),
      },
      onChange: (transfer) => this.update({ transfer }),
    });
  }
  private async receiveFileControl(message: FileControl): Promise<void> {
    this.ensureTransfer();
    if (!this.transfer) throw new Error('This browser cannot accept file transfers.');
    if (
      message.type === 'TRANSFER_OFFER' &&
      this.transfer.snapshot.state &&
      this.transfer.snapshot.manifest?.transferId !== message.transferId
    ) {
      await this.peerSession?.sendFileControl({
        type: 'TRANSFER_REJECT',
        transferId: message.transferId,
        payload: { reason: 'unsupported' },
      });
      return;
    }
    await this.transfer.receiveControl(message);
  }
  async offerFiles(files: readonly File[]): Promise<void> {
    return this.action(async () => {
      this.ensureTransfer();
      if (!this.peerSession?.canTransfer || !this.transfer)
        throw new Error(
          'Both devices must confirm the pairing code and support temporary browser storage.',
        );
      await this.transfer.offer(files);
    });
  }
  async acceptFiles(): Promise<void> {
    await this.transfer?.accept();
  }
  async rejectFiles(): Promise<void> {
    await this.transfer?.reject();
  }
  async pauseFiles(paused: boolean): Promise<void> {
    await this.transfer?.setPaused(paused);
  }
  async cancelFiles(): Promise<void> {
    await this.transfer?.cancel();
  }
  async clearTransfer(): Promise<void> {
    await this.transfer?.dispose();
    this.transfer = null;
    for (const url of this.downloadUrls.values()) URL.revokeObjectURL(url);
    this.downloadUrls.clear();
    this.update({ transfer: INITIAL_TRANSFER });
    this.ensureTransfer();
  }
  saveFile(fileId: string): void {
    const file = this.transfer?.download(fileId);
    const entry = this.view.transfer.manifest?.files.find((entry) => entry.fileId === fileId);
    if (!file || !entry) return;
    let url = this.downloadUrls.get(fileId);
    if (!url) {
      url = URL.createObjectURL(file);
      this.downloadUrls.set(fileId, url);
    }
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = entry.path.split('/').at(-1)!;
    anchor.rel = 'noopener';
    anchor.click();
  }
  saveReceipt(): void {
    const receipt = this.view.transfer.receipt;
    if (!receipt || this.view.transfer.state !== 'complete') return;
    const key = 'receipt';
    let url = this.downloadUrls.get(key);
    if (!url) {
      url = URL.createObjectURL(
        new Blob([JSON.stringify(receipt, null, 2)], { type: 'application/json' }),
      );
      this.downloadUrls.set(key, url);
    }
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `meshdrop-receipt-${receipt.receiptId}.json`;
    anchor.click();
  }
  private closePeer(): void {
    this.transfer?.disconnect();
    this.peerSession?.close();
    this.peerSession = null;
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
    this.closePeer();
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
    void this.transfer?.dispose();
    this.transfer = null;
    for (const url of this.downloadUrls.values()) URL.revokeObjectURL(url);
    this.downloadUrls.clear();
    this.generation++;
    this.refreshInFlight = false;
    this.closePeer();
    if (this.polling) clearInterval(this.polling);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close();
    this.socket = null;
  }
}
