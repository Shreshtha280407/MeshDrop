import { emptyProbe, readWebRtcStats } from '@meshdrop/network-intelligence';
import type { TransportProbe } from '@meshdrop/network-intelligence';
import {
  DEFAULT_FRAME_BYTES,
  MAX_PEER_CONTROL_BYTES,
  connectionEpochSchema,
  peerHelloSchema,
  signedHelloSchema,
  signedPingSchema,
  signedFileControlSchema,
  fileControlSchema,
  transitionPeer,
} from '@meshdrop/protocol';
import type {
  ConnectionEpoch,
  FileControl,
  FileControlInput,
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
  remoteVerified: boolean;
  peakReceiveQueueBytes: number;
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
  remoteVerified: false,
  peakReceiveQueueBytes: 0,
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
  onFileControl?: (message: FileControl) => Promise<void>;
  onFileFrame?: (bytes: Uint8Array) => Promise<void>;
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
  private queuedOutgoing = 0;
  private outgoingQueue: Promise<void> = Promise.resolve();
  private sequence = 0;
  private queuedReceiveBytes = 0;
  private queuedReceiveMessages = 0;
  private remoteSequence = -1;
  private readonly pendingPings = new Map<string, number>();
  private applicationRtt: { value: number; at: number } | null = null;
  private lastAutomaticPing = -Infinity;
  private pathProbe: RTCPeerConnection | null = null;
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
    this.applicationRtt = null;
    this.lastAutomaticPing = -Infinity;
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
        else if (this.pendingLocalIce.length < 128) this.pendingLocalIce.push(candidate);
        else this.fail('Local candidate queue exceeded its limit.');
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
      const size =
        typeof event.data === 'string'
          ? new TextEncoder().encode(event.data).length
          : event.data instanceof ArrayBuffer
            ? event.data.byteLength
            : 0;
      this.queuedReceiveBytes += size;
      this.queuedReceiveMessages++;
      if (this.queuedReceiveBytes > 2 * 1024 * 1024 || this.queuedReceiveMessages > 4096) {
        this.queuedReceiveBytes -= size;
        this.queuedReceiveMessages--;
        this.fail('Peer receive queue exceeded its bounded window.');
        return;
      }
      if (this.queuedReceiveBytes > this.view.peakReceiveQueueBytes)
        this.update({ peakReceiveQueueBytes: this.queuedReceiveBytes });
      this.messageQueue = this.messageQueue
        .then(async () => {
          if (channel === this.channel && this.current(generation))
            await this.receiveData(event.data, generation);
        })
        .catch(() => {
          if (this.current(generation))
            this.fail('Peer message failed identity, capability, or replay checks.');
        })
        .finally(() => {
          this.queuedReceiveBytes -= size;
          this.queuedReceiveMessages--;
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
        storageModes:
          typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function'
            ? ['opfs', 'memory']
            : ['memory'],
        resumeMode:
          maxMessageBytes >= 8192 &&
          typeof navigator.storage?.getDirectory === 'function' &&
          typeof navigator.locks?.request === 'function'
            ? 'persistent'
            : 'unavailable',
      },
    });
    const signature = await sign(hello, identity.privateKey);
    if (!this.current(generation)) return;
    this.localHello = hello;
    channel.send(JSON.stringify({ hello, signature }));
    await this.finishHandshake(generation);
  }
  private async receiveData(raw: unknown, generation: number): Promise<void> {
    if (raw instanceof ArrayBuffer) {
      if (
        raw.byteLength >= 72 &&
        new DataView(raw).getUint32(0) === 0x4d445031 &&
        new DataView(raw).getUint32(40) < this.epoch
      )
        return;
      if (
        !this.canTransfer ||
        !this.options.onFileFrame ||
        raw.byteLength > (this.view.capabilities?.preferredFrameBytes ?? 0)
      )
        throw new Error('Unaccepted binary data.');
      await this.options.onFileFrame(new Uint8Array(raw));
      return;
    }
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
    const fileMessage = signedFileControlSchema.safeParse(parsed);
    if (fileMessage.success) {
      const { control, signature } = fileMessage.data;
      if (control.epoch < this.epoch) return;
      if (
        !this.canTransfer ||
        !this.remoteHello ||
        !this.options.onFileControl ||
        control.roomId !== this.options.roomId ||
        control.peerId !== this.remotePeerId ||
        control.epoch !== this.epoch ||
        control.transcript !== this.view.fingerprint ||
        control.seq <= this.remoteSequence ||
        !(await verify(control, signature, this.remoteHello.publicKey))
      )
        throw new Error('Invalid file control.');
      if (!this.current(generation)) return;
      this.remoteSequence = control.seq;
      await this.options.onFileControl(control);
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
    if (ping.type === 'PAIRING_CONFIRMED') {
      this.update({ remoteVerified: true });
    } else if (ping.type === 'PING') {
      this.update({ pingsReceived: this.view.pingsReceived + 1 });
      // A best-effort timing reply must never close a healthy file transfer under buffer pressure.
      await this.enqueuePing('PONG', ping.messageId).catch(() => {});
    } else {
      const started = this.pendingPings.get(ping.messageId);
      if (started === undefined) throw new Error('Unexpected pong.');
      this.pendingPings.delete(ping.messageId);
      this.applicationRtt = {
        value: Math.max(0, performance.now() - started),
        at: performance.now(),
      };
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
    if (!pc || this.pathProbe === pc) return;
    this.pathProbe = pc;
    try {
      const path = await selectedIcePath(pc);
      if (pc === this.pc) this.update({ path });
    } catch {
      /* Statistics availability does not decide connectivity or trust. */
    } finally {
      if (this.pathProbe === pc) this.pathProbe = null;
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
    void this.enqueuePing('PAIRING_CONFIRMED', crypto.randomUUID()).catch(() =>
      this.fail('Peer comparison confirmation could not be delivered.'),
    );
  }
  rejectComparison(): void {
    this.fail('Peer identity comparison was rejected. Connection closed.', true);
  }
  async ping(): Promise<void> {
    await this.enqueuePing('PING', crypto.randomUUID());
  }
  private enqueuePing(
    type: 'PING' | 'PONG' | 'PAIRING_CONFIRMED',
    messageId: string,
  ): Promise<void> {
    return this.enqueueControl(async () => this.sendPing(type, messageId));
  }
  private enqueueControl(work: () => Promise<void>): Promise<void> {
    if (this.queuedOutgoing >= 64) return Promise.reject(new Error('Peer control queue is full.'));
    this.queuedOutgoing++;
    const generation = this.generation;
    const task = this.outgoingQueue
      .then(async () => {
        if (!this.current(generation)) throw new Error('Connection epoch changed.');
        await work();
      })
      .finally(() => {
        this.queuedOutgoing--;
      });
    this.outgoingQueue = task.catch(() => {});
    return task;
  }
  private async sendPing(
    type: 'PING' | 'PONG' | 'PAIRING_CONFIRMED',
    messageId: string,
  ): Promise<void> {
    if (!this.view.ready || !this.identity || this.channel?.readyState !== 'open')
      throw new Error('Peer handshake is not ready.');
    if (
      (type === 'PING' && this.pendingPings.size >= 16) ||
      this.channel.bufferedAmount > (type === 'PONG' ? 512 * 1024 : MAX_PEER_CONTROL_BYTES * 4)
    )
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
    if (type === 'PING') this.pendingPings.set(messageId, performance.now());
    this.channel!.send(JSON.stringify({ ping, signature }));
  }
  /** Local allowlisted diagnostics. No raw stats, addresses or private peer fields escape. */
  async diagnostics(): Promise<TransportProbe> {
    const pc = this.pc,
      generation = this.generation;
    if (!pc || !this.view.ready || this.channel?.readyState !== 'open')
      return emptyProbe('not-connected');
    const now = performance.now();
    if (
      this.canTransfer &&
      now - this.lastAutomaticPing >= 2000 &&
      this.pendingPings.size < 4 &&
      this.channel.bufferedAmount <= MAX_PEER_CONTROL_BYTES * 4
    ) {
      this.lastAutomaticPing = now;
      void this.ping().catch(() => {});
    }
    let stats: ReturnType<typeof readWebRtcStats> = {
      iceRttMs: null,
      path: null,
      candidateState: null,
    };
    let reason: TransportProbe['reason'] = 'unsupported';
    try {
      stats = readWebRtcStats(await pc.getStats());
    } catch {
      reason = 'sampler-error';
    }
    if (!this.current(generation) || pc !== this.pc || !this.view.ready)
      return emptyProbe('not-connected');
    const rtt =
      this.applicationRtt && performance.now() - this.applicationRtt.at <= 10000
        ? this.applicationRtt.value
        : null;
    return {
      ...stats,
      applicationRttMs: rtt,
      bufferedBytes: this.channel?.bufferedAmount ?? null,
      reason,
    };
  }
  get canTransfer(): boolean {
    return this.view.ready && this.view.verification === 'verified' && this.view.remoteVerified;
  }
  get bufferedAmount(): number {
    return this.channel?.bufferedAmount ?? 0;
  }
  async sendFileControl(input: FileControlInput): Promise<void> {
    const generation = this.generation;
    await this.enqueueControl(async () => {
      if (
        !this.current(generation) ||
        !this.canTransfer ||
        !this.identity ||
        this.channel?.readyState !== 'open'
      )
        throw new Error('Both peer comparisons must be confirmed.');
      const control = fileControlSchema.parse({
        ...input,
        version: 1,
        roomId: this.options.roomId,
        peerId: this.options.peerId,
        epoch: this.epoch,
        transcript: this.view.fingerprint,
        messageId: crypto.randomUUID(),
        seq: this.sequence++,
      });
      const signature = await sign(control, this.identity.privateKey);
      if (!this.current(generation)) throw new Error('Connection epoch changed.');
      const message = JSON.stringify({ control, signature });
      if (
        new TextEncoder().encode(message).length >
        Math.min(MAX_PEER_CONTROL_BYTES, this.view.capabilities?.maxMessageBytes ?? 0)
      )
        throw new Error('Transfer control message exceeds negotiated bounds.');
      if (this.channel!.bufferedAmount + new TextEncoder().encode(message).length > 512 * 1024)
        throw new Error('Peer control buffer is full.');
      this.channel!.send(message);
    });
  }
  sendFileFrame(bytes: Uint8Array<ArrayBuffer>): void {
    if (
      !this.canTransfer ||
      this.channel?.readyState !== 'open' ||
      bytes.length > (this.view.capabilities?.preferredFrameBytes ?? 0) ||
      this.channel.bufferedAmount + bytes.length > 512 * 1024
    )
      throw new Error('File transport is unavailable or its send queue is full.');
    this.channel.send(bytes);
  }
  async waitForDrain(signal: AbortSignal): Promise<void> {
    const channel = this.channel;
    const generation = this.generation;
    if (!channel || !this.canTransfer) throw new Error('File transport is unavailable.');
    signal.throwIfAborted();
    channel.bufferedAmountLowThreshold = 128 * 1024;
    if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        channel.removeEventListener('bufferedamountlow', low);
        channel.removeEventListener('close', closed);
        signal.removeEventListener('abort', aborted);
        if (error) reject(error);
        else resolve();
      };
      const low = () => {
        if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) finish();
      };
      const closed = () => finish(new Error('File channel closed.'));
      const aborted = () => finish(new Error('Transfer stopped.'));
      const timer = setTimeout(() => finish(new Error('File send buffer stalled.')), 30000);
      channel.addEventListener('bufferedamountlow', low);
      channel.addEventListener('close', closed);
      signal.addEventListener('abort', aborted, { once: true });
      low();
    });
    if (!this.current(generation)) throw new Error('Connection epoch changed.');
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
      remoteVerified: false,
      code: '',
      fingerprint: '',
      capabilities: null,
    });
  }
}
