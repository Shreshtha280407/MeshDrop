export type Measurement<Unit extends string> =
  | { available: true; value: number; unit: Unit; method: string; sampledAt: number }
  | { available: false; reason: 'unsupported' | 'not-connected' | 'insufficient-samples' };
export interface NetworkSample {
  readonly throughput: Measurement<'bytes/s'>;
  readonly rtt: Measurement<'ms'>;
  readonly bufferedBytes: Measurement<'bytes'>;
  readonly path: 'direct' | 'relay' | 'unavailable';
}
/** P6: reports remain local unless the user exports them. */
export interface NetworkSampler {
  sample(): Promise<NetworkSample>;
  stop(): void;
}
