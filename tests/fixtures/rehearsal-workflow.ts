import { parsers } from 'prettier/plugins/yaml';
import assert from 'node:assert/strict';
type Node = { type: string; value?: unknown; children?: Node[]; anchor?: unknown; tag?: unknown };
type Map = Record<string, unknown>;
function object(value: unknown): Map {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return value as Map;
}
function decode(node: Node): unknown {
  assert(!node.anchor && !node.tag, 'Aliases, anchors and tags require separate review.');
  const children = node.children ?? [];
  if (node.type === 'root') {
    assert.equal(children.length, 1);
    return decode(children[0]!);
  }
  if (node.type === 'document') {
    const body = children.find((n) => n.type === 'documentBody');
    assert(body);
    assert.equal(children.find((n) => n.type === 'documentHead')?.children?.length, 0);
    return decode(body);
  }
  if (node.type === 'mapping' || node.type === 'flowMapping') {
    const result: Map = {};
    for (const item of children) {
      const pair = item.children!;
      const key = decode(pair[0]!);
      assert.equal(typeof key, 'string');
      assert(!Object.hasOwn(result, key as string));
      assert.notEqual(key, '__proto__');
      result[key as string] = decode(pair[1]!);
    }
    return result;
  }
  if (node.type === 'sequence' || node.type === 'flowSequence') return children.map(decode);
  if (
    ['documentBody', 'mappingKey', 'mappingValue', 'sequenceItem', 'flowSequenceItem'].includes(
      node.type,
    )
  ) {
    assert(children.length <= 1);
    return children.length ? decode(children[0]!) : null;
  }
  if (['plain', 'quoteSingle', 'quoteDouble', 'blockLiteral', 'blockFolded'].includes(node.type)) {
    if (node.type === 'plain' && ['true', 'false'].includes(String(node.value)))
      return node.value === 'true';
    if (node.type === 'plain' && /^[0-9]+$/.test(String(node.value))) return Number(node.value);
    return node.value;
  }
  throw new Error(`Unsupported workflow YAML node: ${node.type}`);
}
export function workflowObject(source: string): Map {
  return object(decode((parsers.yaml.parse as unknown as (s: string) => Node)(source)));
}
const pins: Record<string, string> = {
  'actions/checkout': '11d5960a326750d5838078e36cf38b85af677262',
  'actions/setup-node': '49933ea5288caeca8642d1e84afbd3f7d6820020',
  'pnpm/action-setup': 'b906affcce14559ad1aafd4ab0e942779e9f58b1',
  'actions/attest': '1e69f48acb82d1966a394da916b4c1698aa569d6',
  'actions/upload-artifact': 'ea165f8d65b6e75b540449e92b4886f43607fa02',
  'actions/download-artifact': 'd3f86a106a0bac45b974a628896c90dbdf5c8093',
};
export function enforceWorkflow(value: unknown): void {
  const w = object(value);
  assert.deepEqual(Object.keys(object(w.on)), ['workflow_dispatch']);
  assert.deepEqual(Object.keys(object(w.permissions)), []);
  assert.deepEqual(object(w.concurrency), {
    group: 'meshdrop-trust-rehearsal-${{ inputs.environment }}',
    'cancel-in-progress': false,
  });
  const jobs = object(w.jobs);
  assert.deepEqual(Object.keys(jobs).sort(), ['inspect', 'produce', 'recover']);
  const expectedPermissions: Record<string, Map> = {
    inspect: { contents: 'read', actions: 'read' },
    produce: { contents: 'read', 'id-token': 'write', attestations: 'write' },
    recover: { contents: 'read', actions: 'read' },
  };
  const commands = new Set([
    'pnpm install --frozen-lockfile --ignore-scripts',
    'pnpm exec tsx scripts/rehearsal/cli.ts preflight',
    'pnpm exec tsx scripts/rehearsal/cli.ts prepare',
    'pnpm exec tsx scripts/rehearsal/cli.ts verify-produced "$BUNDLE_PATH"',
    'pnpm exec tsx scripts/rehearsal/cli.ts store',
  ]);
  let attest = 0,
    download = 0,
    passwords = 0;
  for (const [name, raw] of Object.entries(jobs)) {
    const job = object(raw);
    assert.equal(job['runs-on'], 'ubuntu-26.04');
    assert.equal(job.if, undefined);
    assert.deepEqual(job.permissions, expectedPermissions[name]);
    assert.equal(job['continue-on-error'], undefined);
    if (name === 'inspect') {
      assert.equal(job.environment, undefined);
      assert.equal(job.needs, undefined);
    } else {
      assert.deepEqual(job.environment, { name: '${{ needs.inspect.outputs.environment-name }}' });
      assert.deepEqual(job.needs, name === 'produce' ? 'inspect' : ['inspect', 'produce']);
    }
    assert(Array.isArray(job.steps));
    for (const rawStep of job.steps) {
      const s = object(rawStep);
      assert.equal(s['continue-on-error'], undefined);
      assert.equal(s.if, undefined);
      if (s.run !== undefined) {
        assert.equal(typeof s.run, 'string');
        assert(commands.has(s.run as string));
      }
      if (s.uses !== undefined) {
        assert.equal(typeof s.uses, 'string');
        const [action, pin] = (s.uses as string).split('@');
        assert.equal(pin, pins[action!]);
        assert(pin && /^[a-f0-9]{40}$/.test(pin));
        const withValues = object(s.with ?? {});
        if (action === 'actions/checkout') {
          assert.equal(withValues['persist-credentials'], false);
          assert.equal(withValues.clean, false);
        }
        if (action === 'actions/attest') {
          attest++;
          assert.equal(name, 'produce');
          assert.equal(withValues['subject-path'], 'rehearsal-evidence/rehearsal.json');
          assert.equal(withValues['push-to-registry'], false);
          assert.equal(withValues['create-storage-record'], false);
        }
        if (action === 'actions/download-artifact') {
          download++;
          assert.equal(name, 'recover');
          assert.equal(withValues['artifact-ids'], '${{ needs.produce.outputs.artifact-id }}');
          assert.equal(withValues.name, undefined);
          assert.equal(withValues.path, 'rehearsal-evidence');
        }
        if (action === 'actions/upload-artifact') {
          assert.equal(withValues.overwrite, false);
          assert.equal(withValues['include-hidden-files'], false);
          assert.equal(withValues['if-no-files-found'], 'error');
          assert.deepEqual(
            String(withValues.path).trim().split(/\s+/).sort(),
            (name === 'produce'
              ? ['rehearsal-evidence/rehearsal.json', 'rehearsal-evidence/bundle.json']
              : [
                  'rehearsal-evidence/head.json',
                  'rehearsal-evidence/events.json',
                  'rehearsal-evidence/summary.json',
                ]
            ).sort(),
          );
        }
      }
      const env = object(s.env ?? {});
      for (const [key, val] of Object.entries(env)) {
        if (String(val).includes('secrets.')) {
          passwords++;
          assert.equal(name, 'recover');
          assert.equal(s.run, 'pnpm exec tsx scripts/rehearsal/cli.ts store');
          assert.equal(key, 'REHEARSAL_DB_PASSWORD');
          assert.equal(val, '${{ secrets.REHEARSAL_DB_PASSWORD }}');
        }
      }
    }
  }
  assert.equal(attest, 1);
  assert.equal(download, 1);
  assert.equal(passwords, 1);
  const all = JSON.stringify(w);
  assert(!/CLOUDFLARE|WRANGLER|OPS_REVOKE|TURN_SHARED|deployments|toJSON\(secrets\)/i.test(all));
}
