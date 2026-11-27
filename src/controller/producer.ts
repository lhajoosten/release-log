import { join, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { planRelease } from "../release/core.ts";
import { planVersionFiles } from "../release/version-files.ts";
import { serializeReview, verifyReview } from "./review.ts";
import { git } from "./local.ts";
import { sha } from "./remote.ts";

const current = { planRelease, planVersionFiles, serializeReview, verifyReview };

// The trusted workflow supplies this checkout. The consumer's record supplies only an object ID.
export async function reviewFunctions(producer: string): Promise<typeof current> {
  const selected = process.env.ROLLING_RELEASE_REVIEW_SHA;
  if (!selected) return current;
  if (sha(selected) !== producer)
    throw new Error("Reviewed provider revision differs from the verified workflow selection");
  const root = process.env.ROLLING_RELEASE_REVIEW_RUNTIME;
  if (!root && selected === process.env.ROLLING_RELEASE_PRODUCER_SHA) return current;
  if (!root || !isAbsolute(root) || (await git(root, "rev-parse", "HEAD")).trim() !== producer)
    throw new Error("Missing verified provider checkout for " + producer);
  const modulePath = (name: string) => pathToFileURL(join(root, "dist", "src", name)).href;
  const [core, versions, review]: [
    Pick<typeof current, "planRelease">,
    Pick<typeof current, "planVersionFiles">,
    Pick<typeof current, "verifyReview" | "serializeReview">,
  ] = await Promise.all([
    import(modulePath("release/core.js")),
    import(modulePath("release/version-files.js")),
    import(modulePath("controller/review.js")),
  ]);
  if (
    [core.planRelease, versions.planVersionFiles, review.verifyReview, review.serializeReview].some(
      (fn) => typeof fn !== "function",
    )
  )
    throw new Error("Provider lacks the supported release verification functions");
  return {
    planRelease: core.planRelease,
    planVersionFiles: versions.planVersionFiles,
    verifyReview: review.verifyReview,
    serializeReview: review.serializeReview,
  };
}
