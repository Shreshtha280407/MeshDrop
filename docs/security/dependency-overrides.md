# Dependency security overrides

## minimatch — GHSA-g3hv-75wg-m249

Reviewed 4 November 2026. The unchanged release audit reproduced the moderate
[globparts-amplification advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249)
with `minimatch@10.2.6`. The minimum patched release is **11.0.1**. The current
graph introduces this package through development tooling: `eslint@10.12.0`,
`@eslint/config-array@0.23.5`, and
`@typescript-eslint/typescript-estree@8.71.2`. It is not an application runtime
dependency. CI audits development dependencies too and fails at severity `low`;
that policy is unchanged.

Published ESLint 10.x, including 10.14.0, still requests minimatch 10.x. The
current config-array and typescript-estree releases do too. Updating those
parents alone cannot satisfy the advisory. The root pnpm override therefore
pins only the vulnerable 10.x range to `11.0.1`, without upgrading the parent
toolchain or changing application code.

This crosses a minimatch major version deliberately. Its Node engine range
supports MeshDrop's Node versions and CI's Node 24. Its ESM/CommonJS entry points,
`Minimatch`, `match()`, and the options used by these consumers remain available.
The [upstream changelog](https://github.com/isaacs/minimatch/blob/v11.0.1/changelog.md)
removes APIs including `makeRe()` and changes internal pattern representations;
the inspected consumers do not use those removed APIs. Compatibility validation
must include unchanged ESLint file coverage, full lint/types, and the existing
application gates. This is a scoped compatibility decision, not a claim that
minimatch 11 is interchangeable with every earlier release.

Remove the override when all three dependency paths resolve patched versions
through supported parent dependency ranges. Keep `pnpm audit:release` unchanged
and regenerate the lockfile with pnpm when revisiting it; never ignore this
advisory or hand-edit lockfile resolutions.
