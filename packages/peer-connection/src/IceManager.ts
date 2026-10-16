import { DEFAULT_FRAME_BYTES, peerCapabilitiesSchema } from '@meshdrop/protocol';
import type { PeerCapabilities } from '@meshdrop/shared-types';

/** A new manager is used for every epoch, including ICE restart. */
export class IceManager {
  private readonly pending: RTCIceCandidateInit[] = [];
  private ready = false;
  async add(pc: RTCPeerConnection, candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.ready) {
      if (this.pending.length >= 64) throw new Error('Too many queued ICE candidates.');
      this.pending.push(candidate);
    } else await pc.addIceCandidate(candidate);
  }
  async remoteReady(pc: RTCPeerConnection): Promise<void> {
    this.ready = true;
    for (const candidate of this.pending.splice(0)) await pc.addIceCandidate(candidate);
  }
}
export function negotiateCapabilities(
  localInput: PeerCapabilities,
  remoteInput: PeerCapabilities,
): PeerCapabilities {
  const local = peerCapabilitiesSchema.parse(localInput);
  const remote = peerCapabilitiesSchema.parse(remoteInput);
  const storageModes = local.storageModes.filter((mode) => remote.storageModes.includes(mode));
  if (!storageModes.length) throw new Error('No compatible storage mode.');
  return {
    protocolVersion: 1,
    preferredFrameBytes: Math.min(
      DEFAULT_FRAME_BYTES,
      local.preferredFrameBytes,
      remote.preferredFrameBytes,
      local.maxMessageBytes,
      remote.maxMessageBytes,
    ),
    maxMessageBytes: Math.min(local.maxMessageBytes, remote.maxMessageBytes),
    supportedHashes: ['SHA-256'],
    storageModes,
    resumeMode:
      local.resumeMode === 'persistent' && remote.resumeMode === 'persistent'
        ? 'persistent'
        : local.resumeMode !== 'unavailable' && remote.resumeMode !== 'unavailable'
          ? 'session-only'
          : 'unavailable',
  };
}
export interface IcePath {
  kind: 'direct' | 'relay' | 'unknown';
  localType: string;
  remoteType: string;
  protocol: string;
}
/** Return path categories only. Never expose addresses, ports, candidates or TURN passwords. */
export async function selectedIcePath(pc: RTCPeerConnection): Promise<IcePath> {
  const report = await pc.getStats();
  let pair: RTCStats | undefined;
  report.forEach((stat) => {
    if (stat.type === 'transport' && typeof stat.selectedCandidatePairId === 'string')
      pair = report.get(stat.selectedCandidatePairId);
  });
  if (!pair)
    report.forEach((stat) => {
      if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated)
        pair = stat;
    });
  const fields = pair as
    | (RTCStats & { localCandidateId?: string; remoteCandidateId?: string })
    | undefined;
  const local = fields?.localCandidateId ? report.get(fields.localCandidateId) : undefined;
  const remote = fields?.remoteCandidateId ? report.get(fields.remoteCandidateId) : undefined;
  const types = new Set(['host', 'srflx', 'prflx', 'relay']);
  const localType = types.has(local?.candidateType) ? String(local?.candidateType) : 'unknown';
  const remoteType = types.has(remote?.candidateType) ? String(remote?.candidateType) : 'unknown';
  return {
    kind:
      localType === 'relay' || remoteType === 'relay'
        ? 'relay'
        : pair && localType !== 'unknown' && remoteType !== 'unknown'
          ? 'direct'
          : 'unknown',
    localType,
    remoteType,
    protocol: ['udp', 'tcp'].includes(local?.protocol) ? String(local?.protocol) : 'unknown',
  };
}
