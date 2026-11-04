import { DEFAULT_ROLLBACK_BASELINE, verifyLocalRollback } from './local-rollback';

// Local Miniflare/workerd only. No provider credentials or deployment commands.
const report = await verifyLocalRollback({
  baseline: process.env.MESHDROP_ROLLBACK_BASELINE ?? DEFAULT_ROLLBACK_BASELINE,
});
console.log(JSON.stringify(report));
