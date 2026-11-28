/** Select a PR from the original close event or an explicitly authorized manual retry. */
export function releaseEventNumber(event: Record<string, unknown>): number {
  const retry = process.env.ROLLING_RELEASE_RETRY_PR ?? "";
  if (retry) {
    if (
      process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      process.env.GITHUB_REF !== "refs/heads/main" ||
      !/^[1-9][0-9]*$/u.test(retry)
    )
      throw new Error("A retry requires a PR number and a manual dispatch from main");
    const number = Number(retry);
    if (!Number.isSafeInteger(number)) throw new Error("Invalid retry PR number");
    return number;
  }
  const pull = event.pull_request;
  if (event.action !== "closed" || typeof pull !== "object" || pull === null || Array.isArray(pull))
    throw new Error("Expected a closed pull request event");
  const number: unknown = Reflect.get(pull, "number");
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0)
    throw new Error("Expected a closed pull request event");
  return number;
}
