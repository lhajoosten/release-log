import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectCommit, inspectPendingRelease } from "../src/git.ts";
import { collectMergedPullRequests } from "../src/github-association.ts";
import { taggedReleaseNotes } from "../src/github-release.ts";
import { SelfReleaseState } from "../scripts/self-release-state.ts";
import { GitHubProposalRepository } from "../src/github-proposals.ts";
import type { GitHubRead } from "../src/github.ts";
import { describe } from "../src/proposal/identity.ts";
import { prepareVerifiedRelease } from "../src/proposal/prepare.ts";
import { withProducerRuntimes } from "../src/producer-runtime.ts";
import { captureReleaseSnapshot } from "../src/snapshot/capture.ts";
import { candidateLandingPin } from "../src/tagging/candidate.ts";
import { reconcileReleaseTag, verifyReleaseLanding } from "../src/tagging/reconcile.ts";
import { fixture, json, object, text } from "./proposal-fixture.ts";

for (const { title, version, squash } of [
  { title: "fix(api): complete APK refresh", version: "1.2.4", squash: false },
  { title: "feat(api): include a new capability", version: "1.3.0", squash: true },
]) {
  void test(`replacement at v${version} keeps the full stable range and verifies the candidate footprint`, async (context) => {
    const f = await fixture(context, "node", "fix(api): retain selected rows", {
      selfUse: true,
      caller: `env:\n  RELEASE_PRODUCER_SHA: ${"a".repeat(40)}\n`,
    });
    const { configuration: defaults, automation, token } = await f.request();
    const configuration = {
      ...defaults,
      selfUpgrade: true,
      githubRelease: true,
      internalPublication: true,
    } as const;
    const released = { kind: "released", currentVersion: "1.2.3" } as const;
    const base = { kind: "tag", name: "v1.2.3" } as const;
    const { repository, repositoryId } = configuration;
    const reserved: Record<string, unknown>[] = [];

    function ordinary(index: number) {
      const change = f.changes[index];
      assert.ok(change);
      return {
        id: 2000 + index,
        number: 101 + index,
        title: change.title,
        body: `\`\`\`release-log\nversion: 1\naudience: users\nsummary: Change ${index + 1}.\nimpact: Preserve rows.\nrequired_action: null\n\`\`\`\n`,
        state: "closed",
        merged: true,
        merged_at: "2026-11-21T09:00:00Z",
        updated_at: "2026-11-21T10:00:00Z",
        merge_commit_sha: change.sha,
        commits: 1,
        user: { id: 7, type: "User" },
        head: { ref: "ordinary", sha: change.sha, repo: { id: repositoryId } },
        base: { ref: "main", repo: { id: repositoryId, full_name: repository } },
      };
    }
    const commitResponse = async (sha: string) => {
      const commit = await inspectCommit(f.directory, sha);
      return {
        sha,
        commit: { message: commit.message },
        parents: commit.parentShas.map((parent) => ({ sha: parent })),
      };
    };
    const transport: GitHubRead = async (url, options) => {
      const path = decodeURIComponent(new URL(url).pathname.slice(`/repos/${repository}`.length));
      if (path.startsWith("/releases")) return json({}, 404);
      if ((options.method ?? "GET") === "GET") {
        const detail = /^\/pulls\/(\d+)(\/commits)?$/u.exec(path);
        if (detail) {
          const number = Number(detail[1]);
          const pull = number >= 101 ? ordinary(number - 101) : reserved[number - 1];
          if (pull)
            return detail[2]
              ? json([await commitResponse(text(object(pull.head).sha))])
              : json(pull);
        }
        const association = /^\/commits\/([a-f0-9]{40})\/pulls$/u.exec(path);
        if (association) {
          const sha = association[1];
          const result = reserved.filter(
            (pull) => pull.merge_commit_sha === sha || (!squash && object(pull.head).sha === sha),
          );
          for (const [index, change] of f.changes.entries())
            if (change.sha === sha) result.push(ordinary(index));
          return json(result);
        }
      }
      return f.transport(url, options);
    };
    const first = await captureReleaseSnapshot(
      await collectMergedPullRequests(
        {
          repository,
          releaseBranch: "main",
          localRepository: f.directory,
          token,
          range: await inspectPendingRelease(
            f.directory,
            base,
            f.git(["rev-parse", "HEAD"]).trim(),
          ),
        },
        transport,
      ),
      configuration,
    );
    const api = new GitHubProposalRepository(configuration, automation.botUserId, token, transport);
    async function land(
      snapshot: typeof first,
      historyHead: string | null,
      merge: boolean,
      currentVersion: string = released.currentVersion,
    ) {
      const source = await api.tree(snapshot.input.range.sourceCommitSha);
      const prepared = prepareVerifiedRelease(
        snapshot,
        { ...released, currentVersion },
        await api.contents(source),
      );
      const description = describe(
        snapshot,
        prepared,
        automation.botUserId,
        historyHead,
        f.baseline,
      );
      const head = await api.commit(source, historyHead, prepared.files, description.message);
      await api.setRef(head, historyHead !== null);
      const opened = await api.savePull(null, description.title, description.body);
      const landing = f
        .git(
          [
            "commit-tree",
            f.git(["rev-parse", `${head}^{tree}`]).trim(),
            "-p",
            source.commitSha,
            ...(merge ? ["-p", head] : []),
          ],
          "chore: land reviewed proposal\n",
        )
        .trim();
      f.git(["update-ref", "refs/heads/main", landing]);
      f.git(["reset", "--hard", landing]);
      const raw = f.pulls.at(-1);
      assert.ok(raw);
      reserved.push({
        ...raw,
        id: 1000 + opened.number,
        commits: 1,
        merged: true,
        state: "closed",
        merged_at: "2026-11-21T09:00:00Z",
        updated_at: "2026-11-21T10:00:00Z",
        merge_commit_sha: landing,
        merged_by: { type: "User", id: 7 },
        base: {
          ref: "main",
          sha: source.commitSha,
          repo: { id: repositoryId, full_name: repository },
        },
      });
      return { landing, head, prepared, pullNumber: opened.number };
    }

    await withProducerRuntimes({ activeSha: f.baseline, producers: [] }, async () => {
      const candidate = await land(first, null, !squash);
      const input = {
        configuration,
        automation,
        token,
        pullNumber: candidate.pullNumber,
        landingSha: candidate.landing,
      };
      const initial = await verifyReleaseLanding(input, transport);
      assert.equal(initial.verified.nextVersion, "1.2.4");
      assert.equal(f.ref("tags/v1.2.4"), null);
      await assert.rejects(
        reconcileReleaseTag({ ...input, write: true }, transport),
        /requires the container publisher/u,
      );

      await f.advance(title);
      const sourceSha = f.git(["rev-parse", "HEAD"]).trim();
      const range = await inspectPendingRelease(f.directory, base, sourceSha);
      const pin = candidateLandingPin(initial.pull, candidate.landing, initial.verified);
      const association = await collectMergedPullRequests(
        {
          repository,
          releaseBranch: "main",
          localRepository: f.directory,
          token,
          range,
          candidateLandings: [pin],
        },
        transport,
      );
      const captured = await captureReleaseSnapshot(association, {
        ...configuration,
        candidateLandings: [pin],
      });
      assert.deepEqual(
        captured.normalized.pullRequests.map((pull) => pull.number),
        [101, 102],
      );
      assert.deepEqual(
        captured.normalized.excludedPullRequests?.map((pull) => pull.number),
        [1],
      );
      const replacement = await land(captured, candidate.head, false);
      assert.equal(replacement.prepared.plan.nextVersion, version);
      const verified = await verifyReleaseLanding(
        {
          ...input,
          pullNumber: replacement.pullNumber,
          landingSha: replacement.landing,
        },
        transport,
      );
      assert.match(verified.verified.changelog, /pull\/101/u);
      assert.match(verified.verified.changelog, /pull\/102/u);
      assert.equal((verified.verified.changelog.match(/^## v/gmu) ?? []).length, 1);
      assert.equal(f.ref(`tags/v${version}`), null);
      if (version === "1.2.4") {
        // The first candidate published just before the replacement landed. Use
        // the actual stable tag and retain its released notes while rebasing.
        const journal = new SelfReleaseState(api);
        const claim = {
          pullNumber: pin.pullNumber,
          landingSha: pin.landingSha,
          proposalId: pin.proposalId,
          tag: "v1.2.4",
          configDigest: `sha256:${"1".repeat(64)}`,
          manifestDigest: null,
          complete: false,
        };
        const claimed = await journal.write(null, claim, initial.verified.head.treeSha);
        const completed = await journal.write(
          claimed.head,
          {
            ...claim,
            complete: true,
            manifestDigest: `sha256:${"2".repeat(64)}`,
          },
          initial.verified.head.treeSha,
        );
        assert.deepEqual(await journal.read(), completed);
        await assert.rejects(
          journal.write(claimed.head, claim, initial.verified.head.treeSha),
          /journal advanced/u,
        );
        f.git(["tag", claim.tag, candidate.landing]);
        const stalePin = candidateLandingPin(verified.pull, replacement.landing, verified.verified);
        const stabilized = await collectMergedPullRequests(
          {
            repository,
            releaseBranch: "main",
            localRepository: f.directory,
            token,
            range: await inspectPendingRelease(
              f.directory,
              { kind: "tag", name: claim.tag },
              replacement.landing,
            ),
            candidateLandings: [stalePin],
          },
          transport,
        );
        const recreated = await captureReleaseSnapshot(stabilized, {
          ...configuration,
          candidateLandings: [stalePin],
          candidateStableNotes: taggedReleaseNotes(initial.verified.changelog, "1.2.4"),
        });
        const successor = await land(recreated, replacement.head, false, "1.2.4");
        const recovered = await verifyReleaseLanding(
          {
            ...input,
            pullNumber: successor.pullNumber,
            landingSha: successor.landing,
          },
          transport,
        );
        assert.equal(recovered.verified.nextVersion, "1.2.5");
        const next = taggedReleaseNotes(recovered.verified.changelog, "1.2.5");
        assert.match(next, /pull\/102/u);
        assert.doesNotMatch(next, /pull\/101/u);
        assert.match(recovered.verified.changelog, /pull\/101/u);
        assert.deepEqual(recovered.verified.changelog.match(/^## v[\d.]+/gmu), [
          "## v1.2.5",
          "## v1.2.4",
        ]);
      }
      const previous = reserved[0];
      assert.ok(previous);
      previous.body = "tampered";
      await assert.rejects(
        verifyReleaseLanding(
          {
            ...input,
            pullNumber: replacement.pullNumber,
            landingSha: replacement.landing,
          },
          transport,
        ),
        /identity was edited/u,
      );
    });
  });
}
