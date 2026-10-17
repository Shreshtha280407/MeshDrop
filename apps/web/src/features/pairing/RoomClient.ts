import {
  MAX_CONTROL_MESSAGE_BYTES,
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
import { DiagnosticsSession, MetricsStore, emptyProbe } from '@meshdrop/network-intelligence';
import type { DiagnosticsView } from '@meshdrop/network-intelligence';
import { RetryPolicy } from '@meshdrop/recovery';
import { probeCapabilities, receivePolicy } from '@meshdrop/platform';
import type { LifecycleEvent } from '@meshdrop/platform';
import type { TransferManifest } from '@meshdrop/protocol';
import type { FileControl } from '@meshdrop/protocol';
import { INITIAL_PEER, PeerSession } from '@meshdrop/peer-connection';
import type { PeerSignal, PeerView } from '@meshdrop/peer-connection';
import type { SessionStatus, SignalingEnvelope } from '@meshdrop/protocol';
import type { RetentionPolicy } from '@meshdrop/storage';

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
  retention: RetentionPolicy;
  recoveryStatus: string;
  diagnostics: DiagnosticsView | null;
  diagnosticsError: string;
  lifecycleMessage: string;
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
  retention: '24-hours',
  recoveryStatus: '',
  diagnostics: null,
  diagnosticsError: '',
  lifecycleMessage: '',
};
export function parseInvitation(value: string): { roomId: string; capability: string } {
  if (value.length > 2048) throw new Error('Invitation exceeds input limits.');
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
  private diagnostics: DiagnosticsSession | null = null;
  private readonly retiringReports = new Map<string, Promise<void>>();
  private retireDiagnostics(): void {
    const session = this.diagnostics;
    if (!session) return;
    session.stop();
    const id = session.getSnapshot().report.reportId;
    const flush = session.flush();
    this.retiringReports.set(id, flush);
    void flush.finally(() => {
      if (this.retiringReports.get(id) === flush) this.retiringReports.delete(id);
    });
  }
  private ignoredDiagnosticsTransfer = '';
  private observeDiagnostics(transfer: TransferView, epoch: number): void {
    const id = transfer.manifest?.transferId;
    if (!id || !transfer.state || id === this.ignoredDiagnosticsTransfer) return;
    try {
      if (this.diagnostics?.getSnapshot().report.transferId !== id || this.diagnostics.isStopped) {
        this.retireDiagnostics();
        const session = new DiagnosticsSession({
          transferId: id,
          role: this.view.status?.role === 'owner' ? 'owner' : 'receiver',
          epoch,
          probe: () =>
            this.peerSession?.diagnostics() ?? Promise.resolve(emptyProbe('not-connected')),
        });
        this.diagnostics = session;
        this.update({ diagnosticsError: '' });
        session.subscribe(() => {
          if (this.diagnostics === session) this.update({ diagnostics: session.getSnapshot() });
        });
      }
      this.diagnostics.observe({
        transferId: id,
        epoch,
        state: transfer.state,
        committedBytes: transfer.committedBytes,
        reusedBytes: transfer.reusedBytes,
        attemptPayloadBytes: transfer.attemptBytes,
        paused: transfer.localPaused || transfer.remotePaused,
        storageFull: transfer.storageFull,
        recoveryAccepted: transfer.recovery.startsWith('Resume accepted'),
      });
      if (this.diagnostics.isStopped) throw new Error('Diagnostics stopped.');
    } catch {
      this.diagnostics?.abandon();
      this.diagnostics = null;
      this.ignoredDiagnosticsTransfer = id;
      this.update({
        diagnostics: null,
        diagnosticsError:
          'Measurements are unavailable. File verification continues independently.',
      });
    }
  }
  async deleteDiagnostics(reportId: string): Promise<void> {
    const session = this.diagnostics;
    if (session?.getSnapshot().report.reportId === reportId) {
      session.stop();
      await session.flush();
      this.diagnostics = null;
      this.ignoredDiagnosticsTransfer = session.getSnapshot().report.transferId;
      this.update({ diagnostics: null });
    }
    await this.retiringReports.get(reportId);
    await new MetricsStore().delete(reportId);
  }
  private readonly downloadUrls = new Map<string, string>();
  private queuedSignals = 0;
  private queuedSignalBytes = 0;
  private signalQueue: Promise<void> = Promise.resolve();
  private startingEpoch = false;
  private connecting = false;
  private refreshInFlight = false;
  private generation = 0;
  private retry = new RetryPolicy();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retrySuppressed = false;
  private foreground = true;
  private suspended = false;
  handleLifecycle(event: LifecycleEvent): void {
    if (event === 'hidden') {
      this.foreground = false;
      this.clearRetry();
      if (this.view.transfer.state === 'active')
        void this.transfer?.setPaused(true).catch(() => this.transfer?.disconnect());
      this.update({
        lifecycleMessage:
          'This page moved out of the foreground. Delivery is paused where possible; in-flight blocks may settle. Return to both devices and choose Resume transfer.',
      });
    } else if (event === 'pagehide' || event === 'freeze' || event === 'offline') {
      this.suspended = true;
      this.clearRetry();
      this.closePeer();
      this.socket?.close();
      this.update({
        lifecycleMessage:
          'The page was suspended or lost connectivity. Committed checkpoints remain subject to retention and browser eviction. Reconnect, compare a fresh code, then resume saved data.',
      });
    } else {
      this.foreground = document.visibilityState !== 'hidden';
      if (navigator.onLine !== false && this.foreground) {
        this.suspended = false;
        if (this.view.status?.state === 'approved') {
          void this.refresh().catch(() => {});
          if (!this.view.peer.ready || this.socket?.readyState !== WebSocket.OPEN)
            this.scheduleRecovery();
        }
      }
      if (this.view.lifecycleMessage)
        this.update({
          lifecycleMessage:
            'Back in the foreground. Check both devices. A pause requires Resume transfer; a broken connection requires a fresh pairing code and authenticated resume.',
        });
    }
  }
  private sourceFiles: readonly File[] = [];
  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
  private scheduleRecovery(): void {
    if (
      this.retryTimer ||
      this.retrySuppressed ||
      this.suspended ||
      !this.foreground ||
      this.view.status?.state !== 'approved'
    )
      return;
    if (this.view.status.role !== 'owner' && this.socket?.readyState === WebSocket.OPEN) {
      this.update({
        recoveryStatus: 'Waiting for the room owner to reconnect. Saved data is retained.',
      });
      return;
    }
    const next = this.retry.next();
    if (next.exhausted) {
      this.update({
        recoveryStatus:
          'Automatic retries stopped after 5 attempts. Check both devices, then choose Retry connection.',
      });
      return;
    }
    this.update({
      recoveryStatus: `Reconnect attempt ${next.attempt}/5 in ${Math.round((next.nextAt! - Date.now()) / 1000)} seconds. Saved blocks are retained.`,
    });
    const generation = this.generation;
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = undefined;
        if (generation !== this.generation || this.view.status?.state !== 'approved') return;
        void (async () => {
          try {
            if (this.socket?.readyState !== WebSocket.OPEN) await this.connect();
            else if (this.view.status?.role === 'owner')
              await this.requestConnection(this.retry.mode(next.attempt));
          } catch {
            this.scheduleRecovery();
          }
        })();
      },
      Math.max(0, next.nextAt! - Date.now()),
    );
  }
  async retryConnection(): Promise<void> {
    this.clearRetry();
    this.retry.reset();
    this.retrySuppressed = false;
    if (this.view.status?.state !== 'approved') {
      this.update({
        recoveryStatus:
          'Create a fresh invitation, approve the returning peer and compare its new code before resuming saved data.',
      });
      return;
    }
    if (this.socket?.readyState !== WebSocket.OPEN) await this.reconnect();
    else
      await this.requestConnection(
        this.peerSession?.snapshot.ready ? 'ice-restart' : 'new-connection',
      );
  }
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
    if (navigator.onLine === false)
      throw new Error(
        'You are offline. Pairing and file delivery require connectivity; retained local files can still be checked and exported.',
      );
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
      this.retrySuppressed = false;
      this.retry.reset();
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
      this.retrySuppressed = false;
      this.retry.reset();
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
          this.scheduleRecovery();
          reject(new Error('Signaling connection closed.'));
        };
        socket.onmessage = (event: MessageEvent<unknown>) => {
          if (socket !== this.socket || event.data === 'pong' || typeof event.data !== 'string')
            return;
          try {
            if (event.data.length > MAX_CONTROL_MESSAGE_BYTES)
              throw new Error('Signaling message exceeds byte limit.');
            const bytes = new TextEncoder().encode(event.data).length;
            if (this.queuedSignals >= 64 || this.queuedSignalBytes + bytes > 256 * 1024)
              throw new Error('Signaling receive queue exceeded its limit.');
            const envelope = parseSignalingMessage(event.data);
            if (envelope.roomId !== credentials.roomId)
              throw new Error('Unexpected signaling scope.');
            if (envelope.type === 'ROOM_CLOSED') {
              this.event('Room closed. Admission revoked.');
              this.markClosed();
              return;
            }
            this.queuedSignals++;
            this.queuedSignalBytes += bytes;
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
              })
              .finally(() => {
                this.queuedSignals--;
                this.queuedSignalBytes -= bytes;
              });
          } catch {
            this.update({ error: 'Invalid signaling response. Reconnect to continue.' });
            socket.close();
          }
        };
      });
    } catch (error) {
      this.update({ connection: 'disconnected' });
      this.scheduleRecovery();
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
      if (envelope.payload.code === 'PEER_UNAVAILABLE') {
        this.closePeer();
        this.scheduleRecovery();
      }
    } else if (envelope.type === 'PEER_READY') {
      if (status.role === 'owner' && (!this.peerSession || !this.view.peer.ready))
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
      this.scheduleRecovery();
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
    this.retrySuppressed = true;
    this.clearRetry();
    this.peerSession?.rejectComparison();
  }
  private peerChanged(peer: PeerView): void {
    if (this.transfer && (!peer.ready || this.transfer.epoch !== peer.epoch))
      this.transfer.disconnect();
    this.update({ peer });
    if (peer.ready) this.diagnostics?.connectionRestored(peer.epoch);
    if (peer.ready) {
      this.clearRetry();
      this.retry.reset();
      if (this.view.transfer.state === 'reconnecting')
        this.update({
          recoveryStatus:
            'Compare the new pairing code on both devices. Prepare the original source, then resume the saved transfer.',
        });
    } else if (peer.verification === 'mismatch') {
      this.retrySuppressed = true;
      this.clearRetry();
    } else if (peer.epoch > 0 && (peer.state === 'reconnecting' || peer.state === 'closed'))
      this.scheduleRecovery();
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
      roomId: this.credentials!.roomId,
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
      onChange: (transfer) => {
        const previous = this.view.transfer;
        if (transfer.state === 'active' && !this.foreground && !transfer.localPaused)
          queueMicrotask(() => {
            if (!this.foreground)
              void this.transfer?.setPaused(true).catch(() => this.transfer?.disconnect());
          });
        this.observeDiagnostics(transfer, peer.epoch);
        this.update({
          transfer,
          ...(transfer.recovery.startsWith('Resume accepted')
            ? {
                recoveryStatus:
                  transfer.state === 'complete'
                    ? 'Recovery complete. The final stored-file hashes and new receipt are verified.'
                    : 'Recovery authenticated. Both peers must stay online until final verification completes.',
              }
            : {}),
        });
        if (
          transfer.recovery.startsWith('Resume accepted') &&
          !previous.recovery.startsWith('Resume accepted')
        )
          this.event(
            `Resume accepted on epoch ${peer.epoch}: ${transfer.reusedBytes} verified bytes reused.`,
          );
        if (transfer.state === 'reconnecting' && previous.state !== 'reconnecting')
          this.event(
            'Transfer interrupted. Retained checkpoints require revalidation before reuse.',
          );
      },
      retention: this.view.retention,
      onStorageCommit: (duration) => this.diagnostics?.storageCommitted(duration),
    });
  }
  private async receiveFileControl(message: FileControl): Promise<void> {
    if (
      message.type === 'RESUME_HELLO' &&
      (!this.transfer?.canResumeSource ||
        this.transfer.snapshot.manifest?.transferId !== message.transferId)
    ) {
      await this.peerSession?.sendFileControl({
        type: 'RESUME_UNAVAILABLE',
        transferId: message.transferId,
        payload: {
          attemptId: message.payload.attemptId,
          manifestDigest: message.payload.manifestDigest,
          reason: 'source-required',
        },
      });
      return;
    }

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
      this.sourceFiles = files;
      await this.transfer.offer(files);
    });
  }
  private async replaceForResume(): Promise<TransferMachine> {
    if (this.peerSession?.snapshot.capabilities?.resumeMode !== 'persistent')
      throw new Error('Both browsers must support persistent checkpoint resume.');
    if (!this.peerSession?.canTransfer)
      throw new Error('Compare and confirm the new pairing code on both devices first.');
    const state = this.transfer?.snapshot.state;
    if (state && !['reconnecting', 'failed', 'cancelled', 'complete'].includes(state))
      throw new Error('Finish or cancel the current attempt first.');
    await this.transfer?.dispose(false);
    this.transfer = null;
    this.update({ transfer: INITIAL_TRANSFER });
    this.ensureTransfer();
    if (!this.transfer) throw new Error('Resume storage is unavailable.');
    return this.transfer;
  }
  async resumeSource(manifest: TransferManifest, files: readonly File[]): Promise<void> {
    return this.action(async () => {
      if (this.view.status?.role !== 'owner')
        throw new Error('The room owner provides the original source.');
      const transfer = await this.replaceForResume();
      this.sourceFiles = files;
      await transfer.restoreSource(manifest, files);
    });
  }
  async resumeReceiver(manifest: TransferManifest): Promise<void> {
    return this.action(async () => {
      if (this.view.status?.role !== 'receiver')
        throw new Error('Join and confirm a fresh room as the receiver first.');
      const transfer = await this.replaceForResume();
      await transfer.restoreReceiver(manifest);
    });
  }
  async resumeCurrent(): Promise<void> {
    const manifest = this.view.transfer.manifest;
    if (!manifest) return;
    if (this.view.status?.role === 'owner') await this.resumeSource(manifest, this.sourceFiles);
    else await this.resumeReceiver(manifest);
  }
  async acceptFiles(acknowledgedLimits = false): Promise<void> {
    return this.action(async () => {
      const transfer = this.transfer;
      if (!transfer?.snapshot.manifest) return;
      const policy = receivePolicy(
        await probeCapabilities(),
        transfer.snapshot.manifest.totalBytes,
      );
      if (!policy.allowed || (policy.requiresAcknowledgement && !acknowledgedLimits)) {
        this.update({
          error: policy.allowed
            ? 'Confirm the storage and export limits before accepting.'
            : policy.warnings.join(' '),
        });
        return;
      }
      if (transfer === this.transfer) await transfer.accept();
    });
  }
  setRetention(retention: RetentionPolicy): void {
    this.transfer?.setRetention(retention);
    this.update({ retention });
  }
  async retryStorage(): Promise<void> {
    await this.transfer?.retryStorage();
  }
  async rejectFiles(): Promise<void> {
    await this.transfer?.reject();
  }
  async pauseFiles(paused: boolean): Promise<void> {
    await this.transfer?.setPaused(paused);
  }
  async cancelFiles(): Promise<void> {
    this.retrySuppressed = true;
    this.clearRetry();
    await this.transfer?.cancel();
  }
  async clearTransfer(): Promise<void> {
    const removed = await this.transfer?.dispose();
    if (removed === false) {
      this.update({
        error:
          'Local data could not be deleted. Close other tabs using this transfer and try Clear transfer again.',
      });
      return;
    }
    this.transfer = null;
    this.retireDiagnostics();
    this.sourceFiles = [];
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
  verifiedFile(fileId: string): File | undefined {
    return this.transfer?.download(fileId);
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
    this.retrySuppressed = true;
    this.clearRetry();
    this.closePeer();
    this.retireDiagnostics();
    if (this.polling) clearInterval(this.polling);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close();
    this.update({
      status: this.view.status ? { ...this.view.status, state: 'closed' } : null,
      connection: 'disconnected',
      invitation: '',
      busy: false,
      recoveryStatus:
        'Room access ended. Saved data remains local. Start again, renew admission and compare the new pairing code before resuming.',
    });
  }
  reset(): void {
    this.dispose();
    this.credentials = null;
    this.joinAttempt = null;
    this.retrySuppressed = false;
    this.retry.reset();
    this.update({ ...INITIAL });
  }
  dispose(): void {
    this.retireDiagnostics();
    this.diagnostics = null;
    this.retrySuppressed = true;
    this.clearRetry();
    void this.transfer?.dispose(false);
    this.transfer = null;
    this.sourceFiles = [];
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
