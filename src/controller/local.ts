import { gitEnvironment } from "../git.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sha } from "./remote.ts";

const exec = promisify(execFile);
export async function git(root: string, ...args: string[]) {
  return (
    await exec("git", ["--no-replace-objects", "-C", root, ...args], {
      encoding: "utf8",
      env: gitEnvironment(),
      timeout: 30000,
      maxBuffer: 64 * 1024 * 1024,
    })
  ).stdout;
}
export async function ancestor(root: string, older: string, newer: string) {
  try {
    await git(root, "merge-base", "--is-ancestor", sha(older), sha(newer));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === 1) return false;
    throw error;
  }
}
export interface StableTag {
  name: string;
  version: string;
  commit: string;
}
export async function stableHistory(root: string, head: string): Promise<StableTag[]> {
  const labels = (await git(root, "tag", "--list", "v*"))
    .trim()
    .split("\n")
    .filter((label) => /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(label))
    .toSorted((a, b) => {
      const aa = a.slice(1).split(".").map(BigInt),
        bb = b.slice(1).split(".").map(BigInt);
      for (let i = 0; i < 3; i++) {
        const x = aa[i],
          y = bb[i];
        if (x !== undefined && y !== undefined && x !== y) return x < y ? -1 : 1;
      }
      return 0;
    });
  const tags: StableTag[] = [];
  for (const name of labels) {
    const commit = sha((await git(root, "rev-parse", "refs/tags/" + name + "^{commit}")).trim());
    if (!(await ancestor(root, commit, head))) continue;
    const prior = tags.at(-1);
    if (prior && (prior.commit === commit || !(await ancestor(root, prior.commit, commit))))
      throw new Error("Ambiguous stable tag history at " + name);
    tags.push({ name, version: name.slice(1), commit });
  }
  return tags;
}
export async function blob(root: string, commit: string, path: string): Promise<string | null> {
  const entry = await git(root, "ls-tree", "-z", sha(commit), "--", path);
  if (!entry) return null;
  if (!entry.startsWith("100644 blob ") && !entry.startsWith("100755 blob "))
    throw new Error("Expected regular file at " + path);
  return git(root, "show", commit + ":" + path);
}
