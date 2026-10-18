/* global window, RTCPeerConnection -- runs only in a disposable test tab */

/** Observe browser defaults without recording SDP, candidate strings, addresses or credentials. */
export function observeRtc() {
  const NativePeer = RTCPeerConnection;
  const observations = [];
  window.__meshdropRtcObservations = observations;
  window.RTCPeerConnection = class extends NativePeer {
    constructor(...args) {
      super(...args);
      const row = {
        localCandidates: { host: 0, srflx: 0, prflx: 0, relay: 0, unknown: 0 },
        mdnsCandidates: 0,
        iceErrors: [],
        connectionStates: [],
        iceStates: [],
        gatheringStates: [],
        signalingStates: [],
      };
      observations.push(row);
      if (observations.length > 8) observations.shift();
      const state = (key, value) => {
        row[key].push(value);
        if (row[key].length > 16) row[key].shift();
      };
      this.addEventListener('icecandidate', ({ candidate }) => {
        if (!candidate) return;
        const type = Object.hasOwn(row.localCandidates, candidate.type)
          ? candidate.type
          : 'unknown';
        row.localCandidates[type]++;
        if (candidate.address?.endsWith('.local')) row.mdnsCandidates++;
      });
      this.addEventListener('icecandidateerror', ({ errorCode }) => {
        if (Number.isInteger(errorCode) && row.iceErrors.length < 16) row.iceErrors.push(errorCode);
      });
      this.addEventListener('connectionstatechange', () =>
        state('connectionStates', this.connectionState),
      );
      this.addEventListener('iceconnectionstatechange', () =>
        state('iceStates', this.iceConnectionState),
      );
      this.addEventListener('icegatheringstatechange', () =>
        state('gatheringStates', this.iceGatheringState),
      );
      this.addEventListener('signalingstatechange', () =>
        state('signalingStates', this.signalingState),
      );
    }
  };
}

export async function rtcObservations(page) {
  return page.evaluate(() => window.__meshdropRtcObservations ?? []).catch(() => []);
}
