# Container publication

The publisher uses the Git tree at the verified release landing. It checks the image's Linux/amd64 platform and OCI source, revision and version labels. It retains a candidate by source SHA and promotes its exact manifest to the stable version tag. A retry can verify a retained image without a second build.

Rolling Release smoke-tests its own image with `--version` and `--help` before publication, including on retries. A separate vulnerability scanner can inspect the published image by digest.

Version tags and candidate references must have one publisher. GHCR does not provide atomic create-only writes for a Docker tag. A second independent writer could change the tag between reads. Grant package write access accordingly.
