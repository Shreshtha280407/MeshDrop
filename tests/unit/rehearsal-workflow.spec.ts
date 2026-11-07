import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { enforceWorkflow, workflowObject } from '../fixtures/rehearsal-workflow';

const file = '.github/workflows/release-trust-rehearsal.yml';
describe('manual rehearsal workflow safety structure', () => {
  it('has only manual dispatch, scoped concurrency, least privilege and pinned maintained actions', async () => {
    enforceWorkflow(workflowObject(await readFile(file, 'utf8')));
  });
  it.each([
    'trigger',
    'permissions',
    'self-hosted',
    'deploy',
    'credential',
    'publish',
    'wildcard',
    'overwrite',
    'download',
    'environment',
    'ignore-failure',
  ] as const)('rejects an unsafe %s mutation', async (kind) => {
    const w = workflowObject(await readFile(file, 'utf8'));
    const jobs = w.jobs as Record<string, Record<string, unknown>>,
      produce = jobs.produce!,
      recover = jobs.recover!;
    const steps = produce.steps as Record<string, unknown>[];
    if (kind === 'trigger') w.on = { push: null };
    if (kind === 'permissions') produce.permissions = { contents: 'write', deployments: 'write' };
    if (kind === 'self-hosted') produce['runs-on'] = 'self-hosted';
    if (kind === 'deploy') steps.push({ run: 'pnpm deploy:cloud publish production' });
    if (kind === 'credential')
      steps.push({
        run: 'pnpm exec tsx scripts/rehearsal/cli.ts prepare',
        env: { CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}' },
      });
    const attest = steps.find((s) => String(s.uses).startsWith('actions/attest@'))!;
    const upload = steps.find((s) => String(s.uses).startsWith('actions/upload-artifact@'))!;
    if (kind === 'publish') (attest.with as Record<string, unknown>)['push-to-registry'] = true;
    if (kind === 'wildcard')
      (upload.with as Record<string, unknown>).path = 'rehearsal-evidence/**';
    if (kind === 'overwrite') (upload.with as Record<string, unknown>).overwrite = true;
    if (kind === 'download')
      (
        (recover.steps as Record<string, unknown>[]).find((s) =>
          String(s.uses).startsWith('actions/download-artifact@'),
        )!.with as Record<string, unknown>
      )['artifact-ids'] = 'untrusted';
    if (kind === 'environment') produce.environment = { name: 'production' };
    if (kind === 'ignore-failure') steps[0]!['continue-on-error'] = true;
    expect(() => enforceWorkflow(w)).toThrow();
  });
  it.each([
    'default-on',
    'production-guard',
    'fault-permissions',
    'fault-secret-leak',
    'fault-deploy',
    'fault-signing-secret',
  ] as const)('rejects unsafe %s fault workflow change', async (kind) => {
    const w = workflowObject(await readFile(file, 'utf8'));
    const jobs = w.jobs as Record<string, Record<string, unknown>>,
      faults = jobs.faults!,
      attest = jobs['attest-faults']!;
    if (kind === 'default-on')
      (
        w.on as Record<string, Record<string, Record<string, Record<string, unknown>>>>
      ).workflow_dispatch!.inputs!.fault_tests!.default = true;
    if (kind === 'production-guard') faults.if = '${{ always() }}';
    if (kind === 'fault-permissions')
      faults.permissions = { contents: 'read', actions: 'read', 'id-token': 'write' };
    if (kind === 'fault-secret-leak')
      faults.env = { BAD: '${{ secrets.REHEARSAL_FAULT_DB_PASSWORD }}' };
    if (kind === 'fault-deploy')
      (faults.steps as Record<string, unknown>[]).push({
        run: 'pnpm deploy:cloud publish preview',
      });
    if (kind === 'fault-signing-secret')
      attest.env = { REHEARSAL_FAULT_DB_PASSWORD: '${{ secrets.REHEARSAL_FAULT_DB_PASSWORD }}' };
    expect(() => enforceWorkflow(w)).toThrow();
  });
  it('has no executable import path from rehearsal code to Cloudflare or release publication', async () => {
    const allowed = new Set(
      [
        'scripts/rehearsal/cli.ts',
        'scripts/rehearsal/contract.ts',
        'scripts/rehearsal/preflight.ts',
        'scripts/rehearsal/recovery.ts',
        'scripts/rehearsal/verification.ts',
        'scripts/rehearsal/witness.ts',
        'scripts/rehearsal/configuration.ts',
        'scripts/rehearsal/fault-contract.ts',
        'scripts/rehearsal/faults.ts',
        'scripts/rehearsal/fault-report.ts',
        'scripts/deploy/postgres-connection.ts',
        'scripts/deploy/github-attestation.ts',
        'scripts/deploy/release-record.ts',
      ].map((p) => resolve(p)),
    );
    const visited = new Set<string>();
    async function walk(path: string): Promise<void> {
      if (visited.has(path)) return;
      visited.add(path);
      expect(allowed.has(path)).toBe(true);
      const text = await readFile(path, 'utf8');
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      const dependencies: string[] = [];
      function visit(node: ts.Node) {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) return;
          if (ts.isExportDeclaration(node) && node.isTypeOnly) return;
          const name = node.moduleSpecifier.text;
          if (!name.startsWith('node:')) {
            expect(name.startsWith('.')).toBe(true);
            dependencies.push(resolve(dirname(path), name + '.ts'));
          }
        }
        if (ts.isCallExpression(node)) {
          expect(node.expression.kind === ts.SyntaxKind.ImportKeyword).toBe(false);
          if (ts.isIdentifier(node.expression)) expect(node.expression.text).not.toBe('require');
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
      for (const child of dependencies) await walk(child);
    }
    await walk(resolve('scripts/rehearsal/cli.ts'));
    expect(visited.size).toBeGreaterThan(5);
  });
  it('normal CI never dispatches a real rehearsal or loads its database credentials', async () => {
    const text = await readFile('.github/workflows/ci.yml', 'utf8');
    expect(text).not.toMatch(
      /workflow_dispatch|cli\.ts store|REHEARSAL_DB_PASSWORD|gh workflow run/,
    );
  });
});
