import { verifyRollbackTarget } from './rollback-compatibility';

const [current, target, currentDirectory, targetDirectory, ...extra] = process.argv.slice(2);
if (!current || !target || extra.length || Boolean(currentDirectory) !== Boolean(targetDirectory)) {
  console.error(
    'Usage: pnpm verify:rollback-target CURRENT_SHA TARGET_SHA [CURRENT_ARCHIVE TARGET_ARCHIVE]',
  );
  process.exitCode = 1;
} else {
  const report = await verifyRollbackTarget(
    current,
    target,
    currentDirectory && targetDirectory
      ? { current: currentDirectory, target: targetDirectory }
      : undefined,
  );
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}
