import { DurableObject } from 'cloudflare:workers';
import {
  CLIENT_SIGNAL_TYPES,
  connectionRequestSchema,
  MAX_UINT32,
  MAX_CONTROL_MESSAGE_BYTES,
  ProtocolValidationError,
  decisionRequestSchema,
  joinSessionRequestSchema,
  parseSignalingMessage,
  serializeSignalingMessage,
  ticketRequestSchema,
  transitionRoom,
  uuidSchema,
} from '@meshdrop/protocol';
import type { ErrorCode, RoomState, SignalingEnvelope } from '@meshdrop/protocol';
import { iceCredentials } from '../routes/ice-credentials';
import { bearer, randomCapability, verifier } from '../auth/capabilities';
import { SOCKET_PROTOCOL, socketCredential } from '../auth/tickets';
import { allowedOrigins, duration } from '../env';
import type { Env } from '../env';
import { HttpError, errorResponse } from '../errors';
import {
  HOUSEKEEPING_MS,
  MAX_PEER_MESSAGES_PER_WINDOW,
  MAX_SOCKET_VIOLATIONS,
  MESSAGE_WINDOW_MS,
  SOCKET_IDLE_MS,
  readJson,
} from '../limits';

type RoomRow = {
  room_id: string;
  owner_peer_id: string;
  state: RoomState;
  revision: number;
  epoch: number;
  expires_at: number;
  server_seq: number;
  purge_at: number | null;
};
type PeerRow = {
  peer_id: string;
  role: 'owner' | 'candidate' | 'receiver';
  approval: 'pending' | 'approved' | 'rejected';
  verifier: string;
  generation: number;
  last_seq: number;
  recent_ids: string;
  window_start: number;
  message_count: number;
};
type InviteRow = {
  verifier: string;
  expires_at: number;
  consumed_peer_id: string | null;
  revoked_at: number | null;
};
type TicketRow = {
  verifier: string;
  peer_id: string;
  expires_at: number;
  room_revision: number;
  epoch: number;
  origin: string;
  consumed_at: number | null;
};
type Attachment = {
  peerId: string;
  generation: number;
  revision: number;
  epoch: number;
  origin: string;
  lastActiveAt: number;
  violations: number;
};
type Initialization = {
  roomId: string;
  peerId: string;
  ownerVerifier: string;
  inviteVerifier: string;
  expiresAt: number;
  inviteExpiresAt: number;
};

/** One SQLite actor per room. Never stores raw capabilities, SDP/ICE, or files. */
export class SessionRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_meta (
        room_id TEXT PRIMARY KEY, owner_peer_id TEXT NOT NULL, state TEXT NOT NULL,
        revision INTEGER NOT NULL, epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        server_seq INTEGER NOT NULL DEFAULT 0, purge_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS invites (
        verifier TEXT PRIMARY KEY, expires_at INTEGER NOT NULL,
        consumed_peer_id TEXT, revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS peers (
        peer_id TEXT PRIMARY KEY, role TEXT NOT NULL, approval TEXT NOT NULL,
        verifier TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL DEFAULT 0,
        last_seq INTEGER NOT NULL DEFAULT -1, recent_ids TEXT NOT NULL DEFAULT '[]',
        window_start INTEGER NOT NULL DEFAULT 0, message_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS ticket_nonces (
        verifier TEXT PRIMARY KEY, peer_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
        room_revision INTEGER NOT NULL, epoch INTEGER NOT NULL, origin TEXT NOT NULL,
        consumed_at INTEGER
      );
    `);
    // The runtime retains sockets and attachments through hibernation. No role
    // cache is restored: handlers always re-read authorization from SQLite.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  private room(): RoomRow {
    const row = this.ctx.storage.sql.exec<RoomRow>('SELECT * FROM room_meta LIMIT 1').toArray()[0];
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'Room unavailable.');
    return row;
  }
  private peer(peerId: string): PeerRow | undefined {
    return this.ctx.storage.sql
      .exec<PeerRow>('SELECT * FROM peers WHERE peer_id = ?', peerId)
      .toArray()[0];
  }
  private active(): RoomRow {
    const room = this.room();
    if (room.state === 'closed' || room.expires_at <= Date.now())
      throw new HttpError(410, 'ROOM_CLOSED', 'Room closed or expired.');
    return room;
  }
  private async authenticate(request: Request): Promise<PeerRow> {
    const capability = bearer(request);
    const room = this.room();
    const candidates = this.ctx.storage.sql.exec<PeerRow>('SELECT * FROM peers').toArray();
    const hashes = await Promise.all(
      candidates.map((peer) =>
        verifier(
          peer.role === 'owner' ? 'owner' : 'peer',
          peer.role === 'owner' ? room.room_id : `${room.room_id}:${peer.peer_id}`,
          capability,
        ),
      ),
    );
    const match = candidates.find((peer, index) => peer.verifier === hashes[index]);
    // Re-read after asynchronous hashing so concurrent approval/revocation wins.
    const current = match && this.peer(match.peer_id);
    if (!current) throw new HttpError(403, 'FORBIDDEN', 'Capability does not authorize this room.');
    return current;
  }
  override async fetch(request: Request): Promise<Response> {
    const requestId = request.headers.get('X-Request-Id') ?? crypto.randomUUID();
    try {
      const action = new URL(request.url).pathname.slice(1);
      if (action === 'initialize' && request.method === 'POST')
        return await this.initialize(request);
      if (action === 'join' && request.method === 'POST') return await this.join(request);
      if (action === 'ws' && request.method === 'GET') return await this.upgrade(request);
      const peer = await this.authenticate(request);
      if (action === 'close' && request.method === 'DELETE') {
        if (peer.role !== 'owner')
          throw new HttpError(403, 'FORBIDDEN', 'Only the owner may close this room.');
        this.closeRoom('owner-closed');
        return Response.json({ state: 'closed' });
      }
      this.active();
      if (action === 'status' && request.method === 'GET') return Response.json(this.status(peer));
      if (action === 'decisions' && request.method === 'POST')
        return await this.decide(request, peer.peer_id);
      if (action === 'connection' && request.method === 'POST')
        return await this.advanceConnection(request, peer.peer_id);
      if (action === 'ice-credentials' && request.method === 'POST') {
        if (!ticketRequestSchema.safeParse(await readJson(request)).success)
          throw new HttpError(400, 'INVALID_MESSAGE', 'Invalid ICE request.');
        if (this.peer(peer.peer_id)?.approval !== 'approved' || this.active().state !== 'approved')
          throw new HttpError(403, 'FORBIDDEN', 'Approved room membership is required.');
        const configuration = await iceCredentials(this.env, this.active().expires_at);
        this.active();
        if (this.peer(peer.peer_id)?.approval !== 'approved')
          throw new HttpError(403, 'FORBIDDEN', 'Peer approval was revoked.');
        return Response.json(configuration);
      }
      if (action === 'ws-ticket' && request.method === 'POST')
        return await this.issueTicket(request, peer.peer_id);
      throw new HttpError(404, 'NOT_FOUND', 'Route unavailable.');
    } catch (error) {
      return errorResponse(error, requestId);
    }
  }
  private async initialize(request: Request): Promise<Response> {
    const data = await request.json<Initialization>();
    if (
      !uuidSchema.safeParse(data.roomId).success ||
      !uuidSchema.safeParse(data.peerId).success ||
      !/^[a-f0-9]{64}$/.test(data.ownerVerifier) ||
      !/^[a-f0-9]{64}$/.test(data.inviteVerifier) ||
      !Number.isSafeInteger(data.expiresAt) ||
      !Number.isSafeInteger(data.inviteExpiresAt) ||
      data.expiresAt <= Date.now() ||
      data.inviteExpiresAt > data.expiresAt
    )
      throw new HttpError(400, 'INVALID_MESSAGE', 'Invalid room initialization.');
    this.ctx.storage.transactionSync(() => {
      if (this.ctx.storage.sql.exec('SELECT 1 FROM room_meta LIMIT 1').toArray().length)
        throw new HttpError(409, 'CONFLICT', 'Room already initialized.');
      this.ctx.storage.sql.exec(
        'INSERT INTO room_meta (room_id, owner_peer_id, state, revision, epoch, expires_at) VALUES (?, ?, ?, 0, 0, ?)',
        data.roomId,
        data.peerId,
        'created',
        data.expiresAt,
      );
      this.ctx.storage.sql.exec(
        'INSERT INTO peers (peer_id, role, approval, verifier) VALUES (?, ?, ?, ?)',
        data.peerId,
        'owner',
        'approved',
        data.ownerVerifier,
      );
      this.ctx.storage.sql.exec(
        'INSERT INTO invites (verifier, expires_at) VALUES (?, ?)',
        data.inviteVerifier,
        data.inviteExpiresAt,
      );
    });
    await this.ctx.storage.setAlarm(Math.min(data.expiresAt, Date.now() + HOUSEKEEPING_MS));
    return Response.json({ initialized: true }, { status: 201 });
  }
  private status(peer: PeerRow) {
    const room = this.active();
    const candidate =
      peer.role === 'owner'
        ? this.ctx.storage.sql
            .exec<PeerRow>(
              "SELECT * FROM peers WHERE role != 'owner' AND approval != 'rejected' LIMIT 1",
            )
            .toArray()[0]
        : undefined;
    return {
      roomId: room.room_id,
      peerId: peer.peer_id,
      role: peer.role,
      approval: peer.approval,
      state: room.state,
      epoch: room.epoch,
      revision: room.revision,
      expiresAt: room.expires_at,
      nextSeq: peer.last_seq + 1,
      ...(candidate ? { candidatePeerId: candidate.peer_id } : {}),
    };
  }
  private async join(request: Request): Promise<Response> {
    const invitation = bearer(request);
    const parsed = joinSessionRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'INVALID_MESSAGE', 'Invalid join request.');
    const before = this.room();
    const data = parsed.data;
    const [inviteHash, peerHash] = await Promise.all([
      verifier('invite', before.room_id, invitation),
      verifier('peer', `${before.room_id}:${data.peerId}`, data.peerCapability),
    ]);
    let changed = false;
    this.ctx.storage.transactionSync(() => {
      const room = this.active();
      const invite = this.ctx.storage.sql
        .exec<InviteRow>('SELECT * FROM invites WHERE verifier = ?', inviteHash)
        .toArray()[0];
      if (!invite) throw new HttpError(403, 'FORBIDDEN', 'Invalid invitation.');
      if (invite.revoked_at !== null)
        throw new HttpError(410, 'INVITE_REVOKED', 'Invitation revoked.');
      if (invite.expires_at <= Date.now())
        throw new HttpError(410, 'INVITE_EXPIRED', 'Invitation expired.');
      const existing = this.peer(data.peerId);
      if (
        invite.consumed_peer_id === data.peerId &&
        existing?.verifier === peerHash &&
        existing.approval !== 'rejected'
      )
        return;
      if (invite.consumed_peer_id !== null)
        throw new HttpError(409, 'INVITE_USED', 'Invitation already used.');
      if (
        room.state !== 'created' ||
        this.ctx.storage.sql
          .exec('SELECT 1 FROM peers WHERE peer_id != ? LIMIT 1', room.owner_peer_id)
          .toArray().length
      )
        throw new HttpError(409, 'CAPACITY_EXCEEDED', 'Room already has a receiver.');
      if (existing) throw new HttpError(409, 'CONFLICT', 'Peer identifier already exists.');
      this.ctx.storage.sql.exec(
        'INSERT INTO peers (peer_id, role, approval, verifier) VALUES (?, ?, ?, ?)',
        data.peerId,
        'candidate',
        'pending',
        peerHash,
      );
      this.ctx.storage.sql.exec(
        'UPDATE invites SET consumed_peer_id = ? WHERE verifier = ?',
        data.peerId,
        inviteHash,
      );
      this.ctx.storage.sql.exec(
        'UPDATE room_meta SET state = ?, revision = revision + 1',
        transitionRoom(room.state, { type: 'REQUEST_JOIN' }),
      );
      changed = true;
    });
    if (changed) {
      this.refreshRevision();
      this.notifyOwners('PEER_PENDING', { candidatePeerId: data.peerId });
    }
    return Response.json(this.status(this.peer(data.peerId)!), { status: changed ? 201 : 200 });
  }
  private async decide(request: Request, actorId: string): Promise<Response> {
    const parsed = decisionRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'INVALID_MESSAGE', 'Invalid peer decision.');
    const { candidatePeerId, decision } = parsed.data;
    let changed = false;
    this.ctx.storage.transactionSync(() => {
      const room = this.active();
      if (this.peer(actorId)?.role !== 'owner')
        throw new HttpError(403, 'FORBIDDEN', 'Only the owner may decide admission.');
      const candidate = this.peer(candidatePeerId);
      if (!candidate || candidate.role === 'owner')
        throw new HttpError(404, 'NOT_FOUND', 'Candidate unavailable.');
      const target = decision === 'approve' ? 'approved' : 'rejected';
      if (candidate.approval === target) return;
      if (candidate.approval !== 'pending' || room.state !== 'pending')
        throw new HttpError(409, 'CONFLICT', 'Candidate decision is final.');
      this.ctx.storage.sql.exec(
        'UPDATE peers SET role = ?, approval = ? WHERE peer_id = ?',
        decision === 'approve' ? 'receiver' : 'candidate',
        target,
        candidatePeerId,
      );
      if (decision === 'reject')
        this.ctx.storage.sql.exec('UPDATE invites SET revoked_at = ?', Date.now());
      this.ctx.storage.sql.exec(
        'UPDATE room_meta SET state = ?, revision = revision + 1',
        transitionRoom(room.state, { type: decision === 'approve' ? 'APPROVE' : 'REJECT' }),
      );
      changed = true;
    });
    if (changed) {
      this.refreshRevision();
      this.notifyOwners(decision === 'approve' ? 'PEER_APPROVED' : 'PEER_REJECTED', {
        candidatePeerId,
      });
    }
    return Response.json(this.status(this.peer(actorId)!));
  }
  private async issueTicket(request: Request, peerId: string): Promise<Response> {
    if (!ticketRequestSchema.safeParse(await readJson(request)).success)
      throw new HttpError(400, 'INVALID_MESSAGE', 'Invalid ticket request.');
    const ticket = randomCapability();
    const roomId = this.room().room_id;
    const ticketHash = await verifier('ticket', roomId, ticket);
    const room = this.active();
    const peer = this.peer(peerId);
    if (!peer || peer.approval !== 'approved')
      throw new HttpError(403, 'FORBIDDEN', 'Peer approval is required before socket admission.');
    const origin = request.headers.get('Origin') ?? '';
    if (!allowedOrigins(this.env).includes(origin))
      throw new HttpError(403, 'INVALID_ORIGIN', 'Origin is not allowed.');
    const expiresAt = Math.min(
      room.expires_at,
      Date.now() + duration(this.env.WS_TICKET_TTL_SECONDS, 30, 60),
    );
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        'DELETE FROM ticket_nonces WHERE peer_id = ? AND consumed_at IS NULL',
        peerId,
      );
      this.ctx.storage.sql.exec(
        'INSERT INTO ticket_nonces (verifier, peer_id, expires_at, room_revision, epoch, origin) VALUES (?, ?, ?, ?, ?, ?)',
        ticketHash,
        peerId,
        expiresAt,
        room.revision,
        room.epoch,
        origin,
      );
    });
    return Response.json({ ticket, expiresAt, epoch: room.epoch, nextSeq: peer.last_seq + 1 });
  }
  private async upgrade(request: Request): Promise<Response> {
    const ticket = socketCredential(request);
    const roomId = this.room().room_id;
    const ticketHash = await verifier('ticket', roomId, ticket);
    const origin = request.headers.get('Origin') ?? '';
    if (!allowedOrigins(this.env).includes(origin))
      throw new HttpError(403, 'INVALID_ORIGIN', 'Origin is not allowed.');
    let admitted!: PeerRow;
    this.ctx.storage.transactionSync(() => {
      const room = this.active();
      const nonce = this.ctx.storage.sql
        .exec<TicketRow>('SELECT * FROM ticket_nonces WHERE verifier = ?', ticketHash)
        .toArray()[0];
      if (!nonce) throw new HttpError(401, 'UNAUTHORIZED', 'Invalid admission ticket.');
      if (nonce.consumed_at !== null)
        throw new HttpError(409, 'TICKET_USED', 'Admission ticket already used.');
      if (nonce.expires_at <= Date.now())
        throw new HttpError(410, 'TICKET_EXPIRED', 'Admission ticket expired.');
      if (nonce.origin !== origin)
        throw new HttpError(403, 'INVALID_ORIGIN', 'Ticket belongs to a different origin.');
      if (nonce.room_revision !== room.revision || nonce.epoch !== room.epoch)
        throw new HttpError(409, 'STALE_EPOCH', 'Room changed; request a fresh ticket.');
      const peer = this.peer(nonce.peer_id);
      if (!peer || peer.approval !== 'approved')
        throw new HttpError(403, 'FORBIDDEN', 'Peer approval is required.');
      this.ctx.storage.sql.exec(
        'UPDATE ticket_nonces SET consumed_at = ? WHERE verifier = ?',
        Date.now(),
        ticketHash,
      );
      this.ctx.storage.sql.exec(
        'UPDATE peers SET generation = generation + 1 WHERE peer_id = ?',
        peer.peer_id,
      );
      admitted = this.peer(peer.peer_id)!;
    });
    // Only the most recently admitted socket for a peer may route messages.
    for (const previous of this.ctx.getWebSockets()) {
      const attached = previous.deserializeAttachment() as Attachment | null;
      if (attached?.peerId === admitted.peer_id)
        this.closeSocket(previous, 1008, 'Socket replaced.');
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const room = this.active();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      peerId: admitted.peer_id,
      generation: admitted.generation,
      revision: room.revision,
      epoch: room.epoch,
      origin,
      lastActiveAt: Date.now(),
      violations: 0,
    } satisfies Attachment);
    this.sendEvent(server, 'JOINED', { approval: 'approved' });
    const participants = this.connectedPair();
    if (participants)
      for (const ws of this.ctx.getWebSockets()) this.sendEvent(ws, 'PEER_READY', participants);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': SOCKET_PROTOCOL },
    });
  }
  private connectedPair(): { ownerPeerId: string; receiverPeerId: string } | null {
    const room = this.active();
    if (room.state !== 'approved') return null;
    const connected = new Map<string, PeerRow>();
    for (const ws of this.ctx.getWebSockets()) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          const { peer } = this.validateSocket(ws);
          connected.set(peer.peer_id, peer);
        }
      } catch {
        /* Stale sockets are never counted as participants. */
      }
    }
    const receiver = [...connected.values()].find((peer) => peer.role === 'receiver');
    return connected.has(room.owner_peer_id) && receiver
      ? { ownerPeerId: room.owner_peer_id, receiverPeerId: receiver.peer_id }
      : null;
  }
  private async advanceConnection(request: Request, peerId: string): Promise<Response> {
    const parsed = connectionRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'INVALID_MESSAGE', 'Invalid connection request.');
    let result;
    this.ctx.storage.transactionSync(() => {
      const room = this.active();
      if (this.peer(peerId)?.role !== 'owner')
        throw new HttpError(403, 'FORBIDDEN', 'Only the owner may advance the connection epoch.');
      if (room.epoch !== parsed.data.expectedEpoch || room.epoch === MAX_UINT32)
        throw new HttpError(
          409,
          'STALE_EPOCH',
          'Connection epoch changed. Refresh before retrying.',
        );
      const pair = this.connectedPair();
      if (!pair)
        throw new HttpError(
          409,
          'PEER_UNAVAILABLE',
          'Both approved signaling peers must be online.',
          true,
        );
      if (room.epoch === 0 && parsed.data.mode !== 'new-connection')
        throw new HttpError(409, 'CONFLICT', 'The first connection must be new.');
      this.ctx.storage.sql.exec('UPDATE room_meta SET epoch = epoch + 1, revision = revision + 1');
      this.ctx.storage.sql.exec('DELETE FROM ticket_nonces');
      result = { ...pair, epoch: room.epoch + 1, mode: parsed.data.mode };
    });
    const room = this.room();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment) {
        ws.serializeAttachment({ ...attachment, epoch: room.epoch, revision: room.revision });
        this.sendEvent(ws, 'CONNECTION_EPOCH', result);
      }
    }
    return Response.json(result);
  }
  private refreshRevision(): void {
    const room = this.room();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment) ws.serializeAttachment({ ...attachment, revision: room.revision });
    }
  }
  private sendEvent(
    ws: WebSocket,
    type:
      | 'PEER_READY'
      | 'CONNECTION_EPOCH'
      | 'JOINED'
      | 'PEER_PENDING'
      | 'PEER_APPROVED'
      | 'PEER_REJECTED'
      | 'ROOM_CLOSED'
      | 'ERROR',
    payload: unknown,
  ): void {
    const room = this.room();
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) return;
    this.ctx.storage.sql.exec('UPDATE room_meta SET server_seq = server_seq + 1');
    const envelope = {
      version: 1,
      type,
      roomId: room.room_id,
      peerId: attachment.peerId,
      messageId: crypto.randomUUID(),
      epoch: room.epoch,
      seq: room.server_seq,
      sentAt: new Date().toISOString(),
      payload,
    } as SignalingEnvelope;
    try {
      ws.send(serializeSignalingMessage(envelope));
    } catch {
      this.closeSocket(ws, 1011, 'Connection unavailable.');
    }
  }
  private notifyOwners(
    type: 'PEER_PENDING' | 'PEER_APPROVED' | 'PEER_REJECTED',
    payload: { candidatePeerId: string },
  ): void {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment?.peerId === this.room().owner_peer_id) this.sendEvent(ws, type, payload);
    }
  }
  private closeSocket(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      /* Already closed. */
    }
  }
  private closeRoom(reason: 'owner-closed' | 'expired' | 'revoked'): void {
    const room = this.room();
    if (room.state === 'closed') return;
    const purgeAt = Date.now() + duration(this.env.CLOSED_TOMBSTONE_SECONDS, 60, 300);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        'UPDATE room_meta SET state = ?, revision = revision + 1, purge_at = ?',
        transitionRoom(room.state, { type: reason === 'expired' ? 'EXPIRE' : 'CLOSE' }),
        purgeAt,
      );
      this.ctx.storage.sql.exec('UPDATE invites SET revoked_at = ?', Date.now());
      this.ctx.storage.sql.exec('DELETE FROM ticket_nonces');
    });
    for (const ws of this.ctx.getWebSockets()) {
      this.sendEvent(ws, 'ROOM_CLOSED', { reason });
      this.closeSocket(ws, 1000, 'Room closed.');
    }
    this.ctx.waitUntil(this.ctx.storage.setAlarm(purgeAt));
  }
  private validateSocket(ws: WebSocket): { attachment: Attachment; peer: PeerRow; room: RoomRow } {
    const room = this.active();
    const attachment = ws.deserializeAttachment() as Attachment | null;
    const peer = attachment && this.peer(attachment.peerId);
    if (
      !attachment ||
      !peer ||
      peer.approval !== 'approved' ||
      peer.generation !== attachment.generation ||
      attachment.revision !== room.revision ||
      attachment.epoch !== room.epoch ||
      !allowedOrigins(this.env).includes(attachment.origin)
    )
      throw new HttpError(403, 'FORBIDDEN', 'Socket admission is no longer valid.');
    const lastPing = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    if (Date.now() - Math.max(attachment.lastActiveAt, lastPing) > SOCKET_IDLE_MS)
      throw new HttpError(403, 'FORBIDDEN', 'Socket expired from inactivity.');
    return { attachment, peer, room };
  }
  override webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    try {
      const { room, peer, attachment } = this.validateSocket(ws);
      const now = Date.now();
      const count = now - peer.window_start >= MESSAGE_WINDOW_MS ? 1 : peer.message_count + 1;
      this.ctx.storage.sql.exec(
        'UPDATE peers SET window_start = ?, message_count = ? WHERE peer_id = ?',
        count === 1 ? now : peer.window_start,
        count,
        peer.peer_id,
      );
      if (count > MAX_PEER_MESSAGES_PER_WINDOW)
        throw new HttpError(429, 'RATE_LIMITED', 'Signaling rate limit exceeded.', true);
      if (typeof raw !== 'string')
        throw new HttpError(400, 'INVALID_MESSAGE', 'Binary data is not accepted by signaling.');
      if (raw.length > MAX_CONTROL_MESSAGE_BYTES)
        throw new HttpError(413, 'MESSAGE_TOO_LARGE', 'Control message exceeds byte limit.');
      const envelope = parseSignalingMessage(raw);
      if (envelope.roomId !== room.room_id || envelope.peerId !== peer.peer_id)
        throw new HttpError(403, 'FORBIDDEN', 'Message does not match authenticated membership.');
      if (envelope.epoch !== room.epoch)
        throw new HttpError(409, 'STALE_EPOCH', 'Message belongs to a stale epoch.');
      if (!(CLIENT_SIGNAL_TYPES as readonly string[]).includes(envelope.type))
        throw new HttpError(403, 'FORBIDDEN', 'Server event cannot be sent by a peer.');
      const recentIds = JSON.parse(peer.recent_ids) as string[];
      if (envelope.seq <= peer.last_seq || recentIds.includes(envelope.messageId))
        throw new HttpError(409, 'REPLAY', 'Duplicate or out-of-order signaling event.');
      this.ctx.storage.sql.exec(
        'UPDATE peers SET last_seq = ?, recent_ids = ? WHERE peer_id = ?',
        envelope.seq,
        JSON.stringify([...recentIds.slice(-127), envelope.messageId]),
        peer.peer_id,
      );
      ws.serializeAttachment({ ...attachment, lastActiveAt: now });
      let forwarded = false;
      for (const other of this.ctx.getWebSockets()) {
        if (other === ws) continue;
        try {
          const target = this.validateSocket(other);
          if (
            target.peer.peer_id !== peer.peer_id &&
            target.peer.role !== peer.role &&
            room.state === 'approved'
          ) {
            other.send(serializeSignalingMessage(envelope));
            forwarded = true;
          }
        } catch {
          this.closeSocket(other, 1008, 'Socket admission expired.');
        }
      }
      if (!forwarded)
        throw new HttpError(409, 'PEER_UNAVAILABLE', 'Approved peer is not connected.', true);
    } catch (error) {
      const known =
        error instanceof HttpError
          ? error
          : error instanceof ProtocolValidationError
            ? new HttpError(400, error.code, error.message)
            : new HttpError(400, 'INVALID_MESSAGE', 'Invalid signaling event.');
      this.socketError(ws, known.code, known.message, known.retryable);
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment) {
        const violations = attachment.violations + 1;
        ws.serializeAttachment({ ...attachment, violations });
        if (
          violations >= MAX_SOCKET_VIOLATIONS ||
          ['FORBIDDEN', 'STALE_EPOCH', 'RATE_LIMITED', 'ROOM_CLOSED'].includes(known.code)
        )
          this.closeSocket(ws, 1008, 'Signaling policy violation.');
      } else this.closeSocket(ws, 1008, 'Socket admission invalid.');
    }
  }
  private socketError(ws: WebSocket, code: ErrorCode, message: string, retryable: boolean): void {
    try {
      this.sendEvent(ws, 'ERROR', { code, message, retryable });
    } catch {
      this.closeSocket(ws, 1008, 'Socket admission invalid.');
    }
  }
  override webSocketClose(ws: WebSocket, code: number): void {
    this.closeSocket(ws, code === 1005 ? 1000 : code, 'Connection closed.');
  }
  override webSocketError(ws: WebSocket): void {
    this.closeSocket(ws, 1011, 'Connection failed.');
  }
  override async alarm(): Promise<void> {
    const room = this.ctx.storage.sql.exec<RoomRow>('SELECT * FROM room_meta LIMIT 1').toArray()[0];
    if (!room) return;
    if (room.state === 'closed') {
      if (room.purge_at !== null && room.purge_at <= Date.now()) {
        this.ctx.storage.transactionSync(() => {
          for (const table of ['ticket_nonces', 'invites', 'peers', 'room_meta'])
            this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
        });
      } else if (room.purge_at !== null) await this.ctx.storage.setAlarm(room.purge_at);
      return;
    }
    if (room.expires_at <= Date.now()) {
      this.closeRoom('expired');
      return;
    }
    for (const ws of this.ctx.getWebSockets()) {
      try {
        this.validateSocket(ws);
      } catch {
        this.closeSocket(ws, 1008, 'Socket admission expired.');
      }
    }
    this.ctx.storage.sql.exec('DELETE FROM ticket_nonces WHERE expires_at < ?', Date.now() - 60000);
    await this.ctx.storage.setAlarm(Math.min(room.expires_at, Date.now() + HOUSEKEEPING_MS));
  }
}
