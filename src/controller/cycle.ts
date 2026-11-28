import { releaseEventNumber } from "./event.ts";
import { gitEnvironment } from "../git.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { planRelease, type Change } from "../release/core.ts";
import { planVersionFiles } from "../release/version-files.ts";
import { readChanges, releaseMembers } from "./history.ts";
import { type Remote, object, sha } from "./remote.ts";
import { ancestor, blob, git, stableHistory } from "./local.ts";
import { createReview, serializeReview } from "./review.ts";
import { reviewFunctions } from "./producer.ts";
import { publishImage } from "../registry/publish.ts";

const branch = "release/next";
const recordPath = ".rolling-release/review.json";
const title = (version: string) => "chore(release): prepare v" + version;

function changelogParts(previous: string | null) {
  if (!previous) return { prefix: "# Changelog\n\n", suffix: "" };
  const heading = previous.search(/^## /mu);
  if (heading >= 0)
    return { prefix: previous.slice(0, heading), suffix: "\n" + previous.slice(heading) };
  return {
    prefix: previous + (previous.endsWith("\n\n") ? "" : previous.endsWith("\n") ? "\n" : "\n\n"),
    suffix: "",
  };
}

export function prependRelease(previous: string | null, section: string) {
  const { prefix, suffix } = changelogParts(previous);
  return prefix + section + suffix;
}

async function checkedOut<T>(
  root: string,
  source: string,
  read: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "rolling-release-"));
  try {
    await git(
      root,
      "-c",
      "core.hooksPath=/dev/null",
      "clone",
      "--quiet",
      "--shared",
      "--no-checkout",
      "--",
      root,
      dir,
    );
    await git(
      dir,
      "-c",
      "core.hooksPath=/dev/null",
      "checkout",
      "--quiet",
      "--detach",
      sha(source),
    );
    return await read(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function generated(
  root: string,
  source: string,
  version: string,
  previous: string | null,
  markdown: string,
  versionsFor = planVersionFiles,
) {
  const versions = await checkedOut(root, source, (dir) => versionsFor(dir, previous, version));
  const files = new Map(versions);
  files.set("CHANGELOG.md", prependRelease(await blob(root, source, "CHANGELOG.md"), markdown));
  return files;
}
function captured(value: unknown): Change[] {
  if (!Array.isArray(value)) throw new Error("Missing captured PRs");
  return value.map((raw) => {
    const row = object(raw);
    if (
      typeof row.number !== "number" ||
      typeof row.title !== "string" ||
      (row.author !== null && typeof row.author !== "string") ||
      (row.requiredAction !== null && typeof row.requiredAction !== "string")
    )
      throw new Error("Invalid captured PR metadata");
    return {
      number: row.number,
      title: row.title,
      author: row.author,
      requiredAction: row.requiredAction,
    };
  });
}
async function boundary(root: string, source: string, reviewedStart?: string) {
  const prior = (await stableHistory(root, source)).at(-1);
  const baseline = prior?.commit ?? reviewedStart ?? sha(process.env.ROLLING_RELEASE_START_SHA);
  if (!(await ancestor(root, baseline, source)))
    throw new Error("Reviewed release boundary must be an ancestor of the source");
  return { baseline, previousVersion: prior?.version ?? null };
}

// The first parent of every bot-generated head is the main commit used for its plan.
async function verifyHead(root: string, remote: Remote, head: string, existingNotes?: unknown) {
  const source = sha((await git(root, "rev-parse", sha(head) + "^1")).trim());
  const text = await blob(root, head, recordPath);
  if (!text) throw new Error("Missing reviewed release inputs");
  const record = object(JSON.parse(text));
  const { baseline, previousVersion } = await boundary(root, source, sha(record.baseline));
  const changes = captured(record.changes);
  if (!(await remote.verifiedAppCommit(head)))
    throw new Error("Release proposal head was not committed by the trusted App");
  const numbers = await releaseMembers(root, remote.repository, baseline, source);
  if (JSON.stringify(numbers) !== JSON.stringify(changes.map((change) => change.number)))
    throw new Error("Reviewed membership differs from verified Git landings");
  // Refresh and historical recognition inspect a signed proposal without reauthorizing it.
  // The immutable tree records the producer's actual output across provider upgrades.
  if (typeof existingNotes === "string") {
    if (
      record.schema !== 1 ||
      record.repository !== remote.repository ||
      record.branch !== "main" ||
      record.source !== source ||
      record.baseline !== baseline ||
      record.previousVersion !== previousVersion ||
      typeof record.version !== "string" ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(record.version) ||
      !Array.isArray(record.files)
    )
      throw new Error("Invalid reviewed proposal identity");
    const files = record.files.map((value) => {
      const item = object(value);
      if (
        typeof item.path !== "string" ||
        typeof item.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(item.sha256) ||
        !/^(?:(?:[^/\\\0]+\/)*(?:package\.json|Cargo\.toml|pyproject\.toml)|CHANGELOG\.md|Cargo\.lock|package-lock\.json|npm-shrinkwrap\.json|uv\.lock|poetry\.lock|bun\.lock|pnpm-lock\.yaml)$/u.test(
          item.path,
        ) ||
        item.path.split("/").some((p) => p === "." || p === ".." || p.toLowerCase() === ".git")
      )
        throw new Error("Invalid reviewed file metadata");
      return { path: item.path, sha256: item.sha256 };
    });
    const actual = (await git(root, "diff", "--no-renames", "--name-only", "-z", source, head))
      .split("\0")
      .filter(Boolean)
      .toSorted();
    const expected = [recordPath, ...files.map((f) => f.path)].toSorted();
    if (JSON.stringify(actual) !== JSON.stringify(expected) || !expected.includes("CHANGELOG.md"))
      throw new Error("Reviewed file set changed");
    for (const file of files) {
      const content = await blob(root, head, file.path);
      if (
        content === null ||
        createHash("sha256").update(content).digest("hex") !== file.sha256 ||
        !(await git(root, "ls-tree", head, "--", file.path)).startsWith("100644 blob ")
      )
        throw new Error("Reviewed file changed: " + file.path);
    }
    if (
      !existingNotes.startsWith("## v" + record.version + "\n") ||
      (await blob(root, head, "CHANGELOG.md")) !==
        prependRelease(await blob(root, source, "CHANGELOG.md"), existingNotes)
    )
      throw new Error("Proposal text differs from its generated head");
    return {
      schema: 1 as const,
      producer: sha(record.producer),
      repository: remote.repository,
      branch: "main",
      baseline,
      source,
      previousVersion,
      changes,
      version: record.version,
      markdown: existingNotes,
      files,
    };
  }
  if (
    process.env.ROLLING_RELEASE_REVIEW_HEAD &&
    sha(process.env.ROLLING_RELEASE_REVIEW_HEAD) !== head
  )
    throw new Error("Release PR head changed after producer selection");
  const runtime = await reviewFunctions(sha(record.producer));
  const plan = runtime.planRelease({ repository: remote.repository, previousVersion, changes });
  if (plan.kind !== "release") throw new Error("Pending changes cannot authorize publication");
  const files = await generated(
    root,
    source,
    plan.version,
    previousVersion,
    plan.markdown,
    runtime.planVersionFiles,
  );
  const review = runtime.verifyReview(record, {
    producer: sha(record.producer),
    repository: remote.repository,
    branch: "main",
    baseline,
    source,
    previousVersion,
    changes,
    files,
  });
  files.set(recordPath, runtime.serializeReview(review));
  const changed = (await git(root, "diff", "--no-renames", "--name-only", "-z", source, head))
    .split("\0")
    .filter(Boolean);
  if (changed.length !== files.size || changed.some((path) => !files.has(path)))
    throw new Error("Unexpected generated file set on the proposal");
  for (const [path, bytes] of files) {
    const data = Buffer.from(bytes);
    const id = createHash("sha1")
      .update("blob " + data.length + "\0")
      .update(data)
      .digest("hex");
    const entry = await git(root, "ls-tree", "-z", head, "--", path);
    if (entry !== "100644 blob " + id + "\t" + path + "\0")
      throw new Error("Changed reviewed file: " + path);
  }
  return review;
}
// Recover the generated section from the signed tree, then validate it with verifyHead.
async function headNotes(root: string, head: string) {
  const source = sha((await git(root, "rev-parse", head + "^1")).trim());
  const previous = await blob(root, source, "CHANGELOG.md");
  const current = await blob(root, head, "CHANGELOG.md");
  if (current === null) throw new Error("Missing generated changelog");
  const { prefix, suffix } = changelogParts(previous);
  if (
    !current.startsWith(prefix) ||
    !current.endsWith(suffix) ||
    current.length < prefix.length + suffix.length
  )
    throw new Error("Proposal text differs from its generated head");
  return current.slice(prefix.length, current.length - suffix.length);
}
export async function ensureProposalHead(
  root: string,
  remote: Remote,
  pull: Record<string, unknown>,
) {
  const head = sha(object(pull.head).sha);
  try {
    await git(root, "cat-file", "-e", head + "^{commit}");
    return head;
  } catch {
    if (typeof pull.number !== "number" || !Number.isSafeInteger(pull.number) || pull.number <= 0)
      throw new Error("Invalid PR identity");
    const auth = Buffer.from("x-access-token:" + (process.env.GITHUB_TOKEN ?? "")).toString(
      "base64",
    );
    await promisify(execFile)(
      "git",
      [
        "-C",
        root,
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "https://github.com/" + remote.repository + ".git",
        "refs/pull/" + pull.number + "/head",
      ],
      {
        env: {
          ...gitEnvironment(),
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic " + auth,
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
    await git(root, "cat-file", "-e", head + "^{commit}");
    return head;
  }
}
export async function checkProposal(root: string, remote: Remote) {
  const event = object(JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH ?? "", "utf8")));
  const number = object(event.pull_request).number;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0)
    throw new Error("Invalid PR event");
  const pull = object(await remote.request("pulls/" + number));
  if (!remote.owned(pull, branch) || pull.state !== "open")
    throw new Error("Expected an open bot-owned release proposal");
  const head = await ensureProposalHead(root, remote, pull);
  const review = await verifyHead(root, remote, head);
  if (
    review.source !== (await remote.ref("heads/main")) ||
    head !== (await remote.ref("heads/" + branch)) ||
    pull.title !== title(review.version) ||
    pull.body !== review.markdown
  )
    throw new Error("Proposal is stale or differs from reviewed files");
}
export async function verifyBackfillCommit(remote: Remote, head: string) {
  if (!(await remote.verifiedAppCommit(head))) throw new Error("Unverified backfill commit");
}
export async function verifyBackfillLanding(
  root: string,
  remote: Remote,
  pull: Record<string, unknown>,
) {
  if (
    !remote.owned(pull, "release/changelog-backfill") ||
    pull.merged !== true ||
    pull.state !== "closed"
  )
    throw new Error("Expected a merged backfill PR from the configured App");
  const head = await ensureProposalHead(root, remote, pull),
    landing = sha(pull.merge_commit_sha);
  await verifyBackfillCommit(remote, head);
  const main = await remote.ref("heads/main");
  if (
    !main ||
    !(await ancestor(root, landing, main)) ||
    !(await git(root, "ls-tree", head, "--", "CHANGELOG.md")).startsWith("100644 blob ")
  )
    throw new Error("Unverified backfill commit");
  const source = sha((await git(root, "rev-parse", head + "^1")).trim());
  const parents = (await git(root, "show", "-s", "--format=%P", landing)).trim().split(" ");
  if (
    parents[0] !== source ||
    parents.length > 2 ||
    (parents.length === 2 && parents[1] !== head) ||
    (await git(root, "rev-parse", landing + "^{tree}")) !==
      (await git(root, "rev-parse", head + "^{tree}")) ||
    (await git(root, "diff", "--name-only", "-z", source, head)) !== "CHANGELOG.md\0"
  )
    throw new Error("Backfill landing must contain only the reviewed CHANGELOG.md");
  return landing;
}
export async function verifyLanded(
  root: string,
  remote: Remote,
  pull: Record<string, unknown>,
  historical = false,
) {
  if (!remote.owned(pull, branch) || pull.merged !== true || pull.state !== "closed")
    throw new Error("Expected a merged release proposal from the configured App");
  const head = await ensureProposalHead(root, remote, pull),
    landing = sha(pull.merge_commit_sha);
  const review = await verifyHead(root, remote, head, historical ? pull.body : undefined);
  const parents = (await git(root, "show", "-s", "--format=%P", landing)).trim().split(" ");
  if (
    pull.title !== title(review.version) ||
    parents[0] !== review.source ||
    parents.length > 2 ||
    (parents.length === 2 && parents[1] !== head) ||
    (await git(root, "rev-parse", landing + "^{tree}")) !==
      (await git(root, "rev-parse", head + "^{tree}"))
  )
    throw new Error("Release landing differs from the reviewed source, head or tree");
  const main = await remote.ref("heads/main");
  if (!main || !(await ancestor(root, landing, main))) throw new Error("Landing is outside main");
  return { review, landing };
}

async function eventPull(remote: Remote) {
  const event = object(JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH ?? "", "utf8")));
  const number = releaseEventNumber(event);
  const pull = object(await remote.request("pulls/" + number));
  if (
    pull.number !== number ||
    pull.merged !== true ||
    object(pull.base).ref !== "main" ||
    object(object(pull.base).repo).full_name !== remote.repository
  )
    throw new Error("Expected a merged PR into main");
  return pull;
}
export async function propose(
  root: string,
  remote: Remote,
  preview: boolean,
  afterPublish = false,
) {
  if (!preview) {
    const pull = await eventPull(remote);
    if (remote.owned(pull, branch)) {
      const { review, landing } = await verifyLanded(root, remote, pull, true);
      if (!afterPublish) return;
      const tag = "v" + review.version;
      if ((await remote.tag(tag)) !== landing) throw new Error("Release has not been promoted");
      matchingRelease(await remote.request("releases/tags/" + tag), tag, review.markdown);
    } else if (afterPublish)
      throw new Error("A post-publication refresh needs its merged release PR");
  }
  const source = sha((await git(root, "rev-parse", "HEAD")).trim());
  if ((await remote.ref("heads/main")) !== source)
    throw new Error("Main advanced before planning; retry");
  const { baseline, previousVersion } = await boundary(root, source);
  if (previousVersion && (await remote.tag("v" + previousVersion)) !== baseline)
    throw new Error("Baseline tag changed");
  const changes = await readChanges(root, remote.repository, baseline, source);
  const plan = planRelease({ repository: remote.repository, previousVersion, changes });
  const pr = await remote.openProposal(branch);
  const head = await remote.ref("heads/" + branch);
  if (pr && pr.head !== head) throw new Error("Release proposal head changed");
  if (!pr) {
    const closed = await remote.lastClosed(branch);
    if (head && (!closed || object(closed.head).sha !== head))
      throw new Error("Orphaned release proposal branch");
    if (closed) {
      const { review, landing } = await verifyLanded(root, remote, closed, true);
      const tag = "v" + review.version;
      if ((await remote.tag(tag)) !== landing)
        throw new Error("Previous release still awaits promotion");
      const release = await remote.optional("releases/tags/" + tag);
      if (release === null) throw new Error("Previous release still awaits publication");
      matchingRelease(release, tag, review.markdown);
    }
  }
  if (plan.kind === "pending") {
    if (pr) throw new Error("Pending changes cannot authorize the existing release proposal");
    console.log(JSON.stringify({ kind: "pending", changes }));
    return;
  }
  let old = null;
  if (pr) {
    await ensureProposalHead(root, remote, pr.pull);
    old = await verifyHead(root, remote, pr.head, await headNotes(root, pr.head));
    if (pr.body !== old.markdown || pr.title !== title(old.version)) {
      const parents = (await git(root, "show", "-s", "--format=%P", pr.head)).trim().split(" ");
      if (parents.length !== 2)
        throw new Error("Proposal text differs from its generated head; review before retrying");
      const previous = await verifyHead(root, remote, sha(parents[1]), pr.body);
      if (pr.title !== title(previous.version) || pr.body !== previous.markdown)
        throw new Error("Proposal text differs from its generated head; review before retrying");
      if (!preview) {
        await remote.updateProposalText({
          source,
          branch,
          head: pr.head,
          number: pr.number,
          expectedTitle: pr.title,
          expectedBody: pr.body,
          title: title(old.version),
          body: old.markdown,
          recheck: async () => {
            if (previousVersion && (await remote.tag("v" + previousVersion)) !== baseline)
              throw new Error("Baseline moved");
          },
        });
        pr.title = title(old.version);
        pr.body = old.markdown;
      }
    }
  }
  const files = await generated(root, source, plan.version, previousVersion, plan.markdown);
  const record = createReview({
    producer: sha(process.env.ROLLING_RELEASE_PRODUCER_SHA),
    repository: remote.repository,
    branch: "main",
    baseline,
    source,
    previousVersion,
    changes,
    files,
  });
  files.set(recordPath, serializeReview(record));
  console.log(
    JSON.stringify({
      version: plan.version,
      changes,
      markdown: plan.markdown,
      files: record.files,
    }),
  );
  if (
    preview ||
    (JSON.stringify(old) === JSON.stringify(record) && pr?.title === title(plan.version))
  )
    return;
  if (previousVersion && (await remote.tag("v" + previousVersion)) !== baseline)
    throw new Error("Baseline moved before proposal");
  await remote.writeProposal({
    source,
    branch,
    previous: head,
    number: pr?.number ?? null,
    files,
    title: title(plan.version),
    body: plan.markdown,
    expectedBody: pr?.body,
    expectedTitle: pr?.title,
    recheck: async () => {
      if (previousVersion && (await remote.tag("v" + previousVersion)) !== baseline)
        throw new Error("Baseline moved");
    },
  });
}
function matchingRelease(raw: unknown, tag: string, markdown: string) {
  const data = object(raw);
  if (
    data.tag_name !== tag ||
    data.name !== tag ||
    data.body !== markdown ||
    data.prerelease !== false ||
    data.draft !== false
  )
    throw new Error("Conflicting GitHub Release " + tag);
}
export async function finalize(root: string, remote: Remote, mode: "promote" | "publish") {
  const pull = await eventPull(remote);
  if (object(pull.head).ref !== branch) {
    if (process.env.ROLLING_RELEASE_RETRY_PR)
      throw new Error("Expected a merged release proposal from the configured App");
    return;
  }
  const { review, landing } = await verifyLanded(root, remote, pull);
  const tag = "v" + review.version;
  const recheck = async () => {
    const main = await remote.ref("heads/main");
    if (!main || !(await ancestor(root, landing, main)))
      throw new Error("Release landing left main");
    if (
      review.previousVersion &&
      (await remote.tag("v" + review.previousVersion)) !== review.baseline
    )
      throw new Error("Release baseline tag changed");
  };
  await recheck();
  const target = await remote.tag(tag);
  if (target && target !== landing) throw new Error("Conflicting tag " + tag);
  if (mode === "promote") {
    if (target) return;
    if (process.env.ROLLING_RELEASE_RETRY_PR)
      throw new Error("Manual publication retry requires the existing release tag " + tag);
    const again = await verifyLanded(root, remote, await eventPull(remote));
    if (again.landing !== landing || again.review.source !== review.source)
      throw new Error("Release changed before tagging");
    await recheck();
    await remote.request("git/refs", "POST", { ref: "refs/tags/" + tag, sha: landing });
    if ((await remote.tag(tag)) !== landing) throw new Error("Tag creation was not confirmed");
    return;
  }
  if (target !== landing) throw new Error("Promotion has not created " + tag);
  const path = "releases/tags/" + tag;
  const existing = await remote.optional(path);
  if (existing !== null) matchingRelease(existing, tag, review.markdown);
  await checkedOut(root, landing, (dir) =>
    publishImage(dir, remote.repository, tag, landing, async () => {
      await recheck();
      if ((await remote.tag(tag)) !== landing)
        throw new Error("Release tag changed before image publication");
    }),
  );
  if ((await remote.tag(tag)) !== landing)
    throw new Error("Tag changed before GitHub Release publication");
  const latest = await remote.optional(path);
  if (latest !== null) {
    matchingRelease(latest, tag, review.markdown);
    return;
  }
  await recheck();
  if ((await remote.tag(tag)) !== landing) throw new Error("Release tag moved before publication");
  matchingRelease(
    await remote.request("releases", "POST", {
      tag_name: tag,
      target_commitish: landing,
      name: tag,
      body: review.markdown,
      draft: false,
      prerelease: false,
    }),
    tag,
    review.markdown,
  );
  matchingRelease(await remote.request(path), tag, review.markdown);
}
