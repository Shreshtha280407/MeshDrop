import {
  DEFAULT_FRAME_BYTES,
  MAX_PEER_CONTROL_BYTES,
  connectionEpochSchema,
  peerHelloSchema,
  signedHelloSchema,
  signedPingSchema,
  transitionPeer,
} from '@meshdrop/protocol';
import type {
  ConnectionEpoch,
  IceConfiguration,
  PeerEvent,
  PeerHello,
  PeerPing,
  PeerState,
  SignalingEnvelope,
} from '@meshdrop/protocol';
import type { PeerCapabilities } from '@meshdrop/shared-types';
import { IceManager, negotiateCapabilities, selectedIcePath } from './IceManager';
import type { IcePath } from './IceManager';
import {
  authenticateHello,
  base64url,
  comparisonMatches,
  createIdentity,
  dtlsFingerprint,
  pairingTranscript,
  sign,
  verify,
} from './PairingVerification';

export type PeerSignal = Extract<
  SignalingEnvelope,
  { type: 'SDP_OFFER' | 'SDP_ANSWER' | 'ICE_CANDIDATE' | 'RENEGOTIATE' }
>;
export interface PeerView {
  state: PeerState;
  epoch: number;
  ready: boolean;
  verification: 'unverified' | 'verified' | 'mismatch';
  code: string;
  fingerprint: string;
  capabilities: PeerCapabilities | null;
  path: IcePath | null;
  relayAvailable: boolean;
  pingsReceived: number;
  pongsReceived: number;
  error: string;
}
export const INITIAL_PEER: PeerView = {
  state: 'idle',
  epoch: 0,
  ready: false,
  verification: 'unverified',
  code: '',
  fingerprint: '',
  capabilities: null,
  path: null,
  relayAvailable: false,
  pingsReceived: 0,
  pongsReceived: 0,
  error: '',
};
export interface PeerSessionOptions {
  roomId: string;
  peerId: string;
  role: 'owner' | 'receiver';
  sendSignal: (type: PeerSignal['type'], payload: PeerSignal['payload']) => void;
  onChange: (view: PeerView) => void;
  connectionTimeoutMs?: number;
  iceTransportPolicy?: RTCIceTransportPolicy;
}

/** Browser transport only: no UI, server credentials, file writes or recovery ledger. */
export class PeerSession {
  private view: PeerView = { ...INITIAL_PEER };
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private ice = new IceManager();
  private identity: Awaited<ReturnType<typeof createIdentity>> | null = null;
  private localHello: PeerHello | null = null;
  private remoteHello: PeerHello | null = null;
  private remotePeerId = '';
  private localDescriptionSent = false;
  private remoteDescriptionSet = false;
  private pendingLocalIce: RTCIceCandidateInit[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private generation = 0;
  private sendingHello = false;
  private messageQueue: Promise<void> = Promise.resolve();
  private outgoingQueue: Promise<void> = Promise.resolve();
  private sequence = 0;
  private remoteSequence = -1;
  private readonly pendingPings = new Set<string>();
  constructor(private readonly options: PeerSessionOptions) {}
  get snapshot(): PeerView {
    return this.view;
  }
  get epoch(): number {
    return this.view.epoch;
  }
  private update(patch: Partial<PeerView>): void {
    this.view = { ...this.view, ...patch };
    this.options.onChange(this.view);
  }
  private transition(event: PeerEvent): void {
    this.update({ state: transitionPeer(this.view.state, event) });
  }
  private current(generation: number): boolean {
    return this.generation === generation && this.view.state !== 'closed';
  }
  async start(input: ConnectionEpoch, configuration: IceConfiguration): Promise<void> {
    const epoch = connectionEpochSchema.parse(input);
    if (epoch.epoch <= this.epoch) return;
    const expectedLocal = this.options.role === 'owner' ? epoch.ownerPeerId : epoch.receiverPeerId;
    if (expectedLocal !== this.options.peerId || epoch.ownerPeerId === epoch.receiverPeerId)
      throw new Error('Connection membership does not match.');
    const reuse =
      epoch.mode === 'ice-restart' &&
      this.pc &&
      this.pc.signalingState === 'stable' &&
      this.channel?.readyState === 'open';
    if (epoch.mode === 'ice-restart' && !reuse)
      throw new Error('ICE restart is unavailable. Request a new connection.');
    const generation = ++this.generation;
    this.clearTimers();
    if (!reuse) this.destroyTransport();
    if (this.view.state === 'closed') this.view = { ...INITIAL_PEER };
    if (this.view.state === 'connected' || this.view.state === 'checking')
      this.transition({ type: 'DISCONNECT' });
    if (this.view.state === 'reconnecting') this.transition({ type: 'RETRY' });
    else this.transition({ type: 'BEGIN_SIGNALING' });
    this.update({
      ...INITIAL_PEER,
      state: 'signaling',
      epoch: epoch.epoch,
      relayAvailable: configuration.relayAvailable,
    });
    this.remotePeerId = this.options.role === 'owner' ? epoch.receiverPeerId : epoch.ownerPeerId;
    this.ice = new IceManager();
    this.localHello = null;
    this.remoteHello = null;
    this.sendingHello = false;
    this.localDescriptionSent = false;
    this.remoteDescriptionSet = false;
    this.pendingLocalIce = [];
    this.sequence = 0;
    this.remoteSequence = -1;
    this.pendingPings.clear();
    this.messageQueue = Promise.resolve();
    this.outgoingQueue = Promise.resolve();
    const identity = await createIdentity();
    if (!this.current(generation)) return;
    this.identity = identity;
    const configurationOptions: RTCConfiguration = {
      iceServers: configuration.iceServers.map((server) => ({
        urls: server.urls,
        ...(server.username ? { username: server.username } : {}),
        ...(server.credential ? { credential: server.credential } : {}),
      })),
      iceTransportPolicy: this.options.iceTransportPolicy ?? 'all',
    };
    if (reuse) this.pc!.setConfiguration(configurationOptions);
    else {
      const pc = new RTCPeerConnection(configurationOptions);
      this.pc = pc;
      pc.onicecandidate = (event) => {
        if (pc !== this.pc || !event.candidate) return;
        const candidate = event.candidate.toJSON();
        const localUfrag = pc.localDescription?.sdp.match(/^a=ice-ufrag:(.+)\r?$/m)?.[1]?.trim();
        if (candidate.usernameFragment && localUfrag && candidate.usernameFragment !== localUfrag)
          return;
        if (this.localDescriptionSent) this.emitCandidate(candidate);
        else this.pendingLocalIce.push(candidate);
      };
      pc.ondatachannel = (event) => {
        if (pc !== this.pc) return;
        if (this.options.role !== 'receiver' || this.channel) {
          event.channel.close();
          this.fail('Unexpected additional data channel.');
          return;
        }
        this.attachChannel(event.channel);
      };
      pc.onconnectionstatechange = () => {
        if (pc !== this.pc || this.view.state === 'closed') return;
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
          if (this.view.state === 'checking' || this.view.state === 'connected')
            this.transition({ type: 'DISCONNECT' });
          this.update({
            ready: false,
            verification: 'unverified',
            code: '',
            error: 'Peer connection interrupted. Try ICE restart, then a new connection.',
          });
        } else if (pc.connectionState === 'connected') {
          if (this.view.state === 'reconnecting' && this.localHello && this.remoteHello) {
            void this.finishHandshake(this.generation).catch(() =>
              this.fail('Peer handshake could not resume.'),
            );
          }
          void this.inspectPath();
        }
      };
      if (this.options.role === 'owner')
        this.attachChannel(
          pc.createDataChannel('meshdrop.v1', { ordered: true, protocol: 'meshdrop.v1' }),
        );
    }
    this.timer = setTimeout(
      () =>
        this.fail('Peer connection timed out. Check the other device or configure a TURN relay.'),
      this.options.connectionTimeoutMs ?? 25000,
    );
    if (this.options.role === 'owner') {
      if (reuse) this.pc!.restartIce();
      const pc = this.pc!;
      const offer = await pc.createOffer();
      if (!this.current(generation)) return;
      await pc.setLocalDescription(offer);
      if (!this.current(generation)) return;
      this.options.sendSignal('SDP_OFFER', { sdp: pc.localDescription!.sdp });
      this.descriptionSent();
    }
  }
  private emitCandidate(candidate: RTCIceCandidateInit): void {
    const localUfrag = this.pc?.localDescription?.sdp.match(/^a=ice-ufrag:(.+)\r?$/m)?.[1]?.trim();
    if (candidate.usernameFragment && candidate.usernameFragment !== localUfrag) return;
    if (this.view.state === 'closed') return;
    this.options.sendSignal('ICE_CANDIDATE', {
      candidate: candidate.candidate ?? '',
      sdpMid: candidate.sdpMid ?? null,
      sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      usernameFragment: candidate.usernameFragment ?? null,
    });
  }
  private descriptionSent(): void {
    this.localDescriptionSent = true;
    for (const candidate of this.pendingLocalIce.splice(0)) this.emitCandidate(candidate);
    this.transition({ type: 'CHECK_CONNECTIVITY' });
    void this.maybeHello().catch(() => this.fail('Peer handshake could not start.'));
  }
  async receiveSignal(envelope: PeerSignal): Promise<void> {
    if (envelope.epoch < this.epoch) return;
    if (
      envelope.epoch !== this.epoch ||
      envelope.roomId !== this.options.roomId ||
      envelope.peerId !== this.remotePeerId
    )
      throw new Error('Unexpected signaling identity or epoch.');
    const pc = this.pc;
    const generation = this.generation;
    if (!pc || this.view.state === 'closed') return;
    if (envelope.type === 'ICE_CANDIDATE') {
      const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = envelope.payload;
      await this.ice.add(pc, {
        candidate,
        sdpMid,
        sdpMLineIndex,
        ...(usernameFragment ? { usernameFragment } : {}),
      });
      return;
    }
    if (envelope.type === 'RENEGOTIATE') return;
    if ((envelope.type === 'SDP_OFFER') !== (this.options.role === 'receiver'))
      throw new Error('Unexpected SDP negotiation role.');
    if (this.remoteDescriptionSet) throw new Error('Duplicate SDP in connection epoch.');
    dtlsFingerprint(envelope.payload.sdp);
    await pc.setRemoteDescription({
      type: envelope.type === 'SDP_OFFER' ? 'offer' : 'answer',
      sdp: envelope.payload.sdp,
    });
    if (!this.current(generation)) return;
    this.remoteDescriptionSet = true;
    await this.ice.remoteReady(pc);
    if (!this.current(generation)) return;
    if (envelope.type === 'SDP_OFFER') {
      await pc.setLocalDescription(await pc.createAnswer());
      if (!this.current(generation)) return;
      this.options.sendSignal('SDP_ANSWER', { sdp: pc.localDescription!.sdp });
      this.descriptionSent();
    }
    await this.maybeHello();
  }
  private attachChannel(channel: RTCDataChannel): void {
    if (
      channel.label !== 'meshdrop.v1' ||
      channel.protocol !== 'meshdrop.v1' ||
      !channel.ordered ||
      channel.maxRetransmits !== null ||
      channel.maxPacketLifeTime !== null
    ) {
      channel.close();
      this.fail('A reliable ordered MeshDrop channel is required.');
      return;
    }
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      void this.maybeHello().catch(() => this.fail('Peer handshake could not start.'));
    };
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const generation = this.generation;
      this.messageQueue = this.messageQueue
        .then(async () => {
          if (channel === this.channel && this.current(generation))
            await this.receiveData(event.data, generation);
        })
        .catch(() => {
          if (this.current(generation))
            this.fail('Peer message failed identity, capability, or replay checks.');
        });
    };
    channel.onclose = () => {
      if (channel === this.channel)
        this.fail('Peer data channel closed. Request a new connection.');
    };
    channel.onerror = () => {
      if (channel === this.channel)
        this.fail('Peer data channel failed. Request a new connection.');
    };
  }
  private async maybeHello(): Promise<void> {
    const pc = this.pc;
    const channel = this.channel;
    const identity = this.identity;
    if (
      !pc ||
      channel?.readyState !== 'open' ||
      !identity ||
      this.localHello ||
      this.sendingHello ||
      !this.localDescriptionSent ||
      !this.remoteDescriptionSet
    )
      return;
    this.sendingHello = true;
    const generation = this.generation;
    const transportMax = pc.sctp?.maxMessageSize;
    const maxMessageBytes =
      transportMax && Number.isFinite(transportMax)
        ? Math.min(DEFAULT_FRAME_BYTES, transportMax)
        : DEFAULT_FRAME_BYTES;
    const hello = peerHelloSchema.parse({
      version: 1,
      type: 'HELLO',
      roomId: this.options.roomId,
      peerId: this.options.peerId,
      epoch: this.epoch,
      role: this.options.role,
      nonce: base64url(crypto.getRandomValues(new Uint8Array(32))),
      publicKey: identity.publicKey,
      dtlsFingerprint: dtlsFingerprint(pc.localDescription!.sdp),
      capabilities: {
        protocolVersion: 1,
        preferredFrameBytes: maxMessageBytes,
        maxMessageBytes,
        supportedHashes: ['SHA-256'],
        storageModes: ['memory'],
        resumeMode: 'unavailable',
      },
    });
    const signature = await sign(hello, identity.privateKey);
    if (!this.current(generation)) return;
    this.localHello = hello;
    channel.send(JSON.stringify({ hello, signature }));
    await this.finishHandshake(generation);
  }
  private async receiveData(raw: unknown, generation: number): Promise<void> {
    if (
      typeof raw !== 'string' ||
      raw.length > MAX_PEER_CONTROL_BYTES ||
      new TextEncoder().encode(raw).byteLength > MAX_PEER_CONTROL_BYTES
    )
      throw new Error('Invalid data channel control message.');
    const parsed: unknown = JSON.parse(raw);
    const hello = signedHelloSchema.safeParse(parsed);
    if (hello.success) {
      if (hello.data.hello.epoch < this.epoch) return;
      if (this.remoteHello) throw new Error('Duplicate identity handshake.');
      const authenticated = await authenticateHello(hello.data, {
        roomId: this.options.roomId,
        epoch: this.epoch,
        peerId: this.remotePeerId,
        role: this.options.role === 'owner' ? 'receiver' : 'owner',
        fingerprint: dtlsFingerprint(this.pc!.remoteDescription!.sdp),
      });
      if (!this.current(generation)) return;
      this.remoteHello = authenticated;
      await this.finishHandshake(generation);
      return;
    }
    const { ping, signature } = signedPingSchema.parse(parsed);
    if (ping.epoch < this.epoch) return;
    if (
      !this.remoteHello ||
      !this.view.ready ||
      ping.roomId !== this.options.roomId ||
      ping.peerId !== this.remotePeerId ||
      ping.epoch !== this.epoch ||
      ping.transcript !== this.view.fingerprint ||
      ping.seq <= this.remoteSequence ||
      !(await verify(ping, signature, this.remoteHello.publicKey))
    )
      throw new Error('Invalid signed ping.');
    if (!this.current(generation)) return;
    this.remoteSequence = ping.seq;
    if (ping.type === 'PING') {
      this.update({ pingsReceived: this.view.pingsReceived + 1 });
      await this.enqueuePing('PONG', ping.messageId);
    } else {
      if (!this.pendingPings.delete(ping.messageId)) throw new Error('Unexpected pong.');
      this.update({ pongsReceived: this.view.pongsReceived + 1 });
    }
  }
  private async finishHandshake(generation: number): Promise<void> {
    if (!this.localHello || !this.remoteHello || this.view.ready) return;
    const capabilities = negotiateCapabilities(
      this.localHello.capabilities,
      this.remoteHello.capabilities,
    );
    const { fingerprint, code } = await pairingTranscript(this.localHello, this.remoteHello);
    if (!this.current(generation)) return;
    this.transition({ type: 'CONNECT' });
    this.update({ ready: true, fingerprint, code, capabilities, error: '' });
    if (this.timer) clearTimeout(this.timer);
    await this.inspectPath();
    if (!this.current(generation)) return;
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = setInterval(() => {
      void this.inspectPath();
    }, 2000);
  }
  private async inspectPath(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    try {
      const path = await selectedIcePath(pc);
      if (pc === this.pc) this.update({ path });
    } catch {
      /* Statistics availability does not decide connectivity or trust. */
    }
  }
  confirmComparison(entered: string, independentConfirmation: boolean): void {
    if (!this.view.ready || !this.view.code || this.view.verification === 'mismatch') return;
    if (!independentConfirmation) {
      this.update({ error: 'Confirm that you compared using a separate trusted channel.' });
      return;
    }
    if (!comparisonMatches(this.view.code, entered, independentConfirmation)) {
      this.fail('Pairing codes do not match. Stop and create a new connection.', true);
      return;
    }
    this.update({ verification: 'verified', error: '' });
  }
  rejectComparison(): void {
    this.fail('Peer identity comparison was rejected. Connection closed.', true);
  }
  async ping(): Promise<void> {
    await this.enqueuePing('PING', crypto.randomUUID());
  }
  private enqueuePing(type: 'PING' | 'PONG', messageId: string): Promise<void> {
    const generation = this.generation;
    const task = this.outgoingQueue.then(async () => {
      if (this.current(generation)) await this.sendPing(type, messageId);
    });
    this.outgoingQueue = task.catch(() => {});
    return task;
  }
  private async sendPing(type: 'PING' | 'PONG', messageId: string): Promise<void> {
    if (!this.view.ready || !this.identity || this.channel?.readyState !== 'open')
      throw new Error('Peer handshake is not ready.');
    if (this.pendingPings.size >= 16 || this.channel.bufferedAmount > MAX_PEER_CONTROL_BYTES * 4)
      throw new Error('Peer control queue is full.');
    const generation = this.generation;
    const ping: PeerPing = {
      version: 1,
      type,
      roomId: this.options.roomId,
      peerId: this.options.peerId,
      epoch: this.epoch,
      transcript: this.view.fingerprint,
      messageId,
      seq: this.sequence++,
    };
    const signature = await sign(ping, this.identity.privateKey);
    if (!this.current(generation) || !this.view.ready) return;
    if (type === 'PING') this.pendingPings.add(messageId);
    this.channel!.send(JSON.stringify({ ping, signature }));
  }
  fail(message: string, mismatch = false): void {
    this.close();
    this.update({ error: message, ...(mismatch ? { verification: 'mismatch' as const } : {}) });
  }
  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.statsTimer) clearInterval(this.statsTimer);
  }
  private destroyTransport(): void {
    const channel = this.channel;
    const pc = this.pc;
    this.channel = null;
    this.pc = null;
    channel?.close();
    pc?.close();
  }
  close(): void {
    this.generation++;
    this.clearTimers();
    this.destroyTransport();
    this.identity = null;
    this.localHello = null;
    this.remoteHello = null;
    this.pendingPings.clear();
    this.transition({ type: 'CLOSE' });
    this.update({
      ready: false,
      verification: 'unverified',
      code: '',
      fingerprint: '',
      capabilities: null,
    });
  }
}
