/** Local build pinning only: these digests do not authenticate a deployment. */
export function assertDeviceTestIdentity(expected, observed) {
  const valid = (value) =>
    value !== null &&
    typeof value === 'object' &&
    value.purpose === 'isolated-task13-test' &&
    value.productionApproved === false &&
    value.productionMutations === 0 &&
    /^[a-f0-9]{40}$/.test(value.sourceCommit ?? '') &&
    ['sourceDiffSha256', 'buildSha256'].every((key) => /^[a-f0-9]{64}$/.test(value[key] ?? ''));
  if (
    !valid(expected) ||
    !valid(observed) ||
    ['sourceCommit', 'sourceDiffSha256', 'buildSha256'].some(
      (key) => expected[key] !== observed[key],
    )
  )
    throw Error('IOS_CURRENT_BUILD_IDENTITY_MISMATCH');
}
