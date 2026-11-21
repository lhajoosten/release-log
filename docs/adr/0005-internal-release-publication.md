# Internal release candidates for Release Log

Status accepted for the repository's self-release workflow. This decision implements [#136](https://github.com/lhajoosten/release-log/issues/136) and amends the timing of Release Log's stable boundary in [ADR 0001](0001-container-distribution.md) and [ADR 0004](0004-release-presentation-and-latest.md). The [prerelease-channel proposal](../spec/78-release-candidates.md) covers an independent consumer feature.

## Decision

The human merge of a verified generated release PR identifies the exact internal candidate. Reviewed Git history, the generated inputs and the PR establish the candidate's repository, source, stable baseline, version, producer, and landing. Main pushes and a four-hour schedule both reconcile current history. The run summary and scan artifacts record the candidate and the outcome. No public Git tag, GitHub Release or GHCR version is issued while the candidate fails its initial gate.

Build the packaged CLI from that landing with its locked dependencies, base image and APK inputs. Smoke test and scan its exact local image under the full publication policy with fresh advisory data. The controller publishes that same image if it qualifies. A source or pin change requires an ordinary reviewed change and a newly reviewed release landing. An ordinary merge by itself leaves the queued candidate's contents fixed. A replacement starts from the last completed stable baseline and accounts for verified earlier automation landings without dropping ordinary changes.

One trusted workflow serializes proposal writes and publication. It records the verified candidate and scanned config digest in the reserved, append-only `release-log/publication` ref before the first public write. The reconciler verifies the PR, Git objects and actual public state on retry. Before GHCR confirms a version image, a newer verified landing can supersede the attempt. Once the image exists, finish with that landing and digest. A replacement that lands too late is carried forward as verified automation in a fresh proposal against the completed boundary.

After verifying the immutable image digest, create the stable tag at the same reviewed landing and publish its verified GitHub Release. Those three outputs complete the stable boundary. Reconcile GitHub and GHCR latest pointers from the completed version with newer-version guards. If a run stops partway, recover observed writes and freshly test and scan a retained image before completing the remaining immutable outputs. A completed version can repair its aliases without a rebuild.

## Consequences

Container findings can defer stable publication while development continues. Temporary scanner, runner, or registry failures are retried from current state. Cross-service writes can still succeed independently, so a stable image or tag may briefly exist while the qualified release is completing. The workflow reports identity conflicts for review. Candidate journal and workflow evidence serve maintainer operations. Consumers continue to install stable versions through the existing GitHub and GHCR interfaces, and reusable rolling-workflow callers retain their own tag-based release contract.

The [container publication runbook](../container-release.md) describes status, automatic recovery and the live verification procedure.
