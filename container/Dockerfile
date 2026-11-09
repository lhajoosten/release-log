FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68

# Snapshot archives pin Git and its dependencies; keep signature verification enabled.
RUN rm -f /etc/apt/sources.list.d/debian.sources \
    && printf '%s\n' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261105T000000Z bookworm main' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20261105T000000Z bookworm-security main' \
      > /etc/apt/sources.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The CLI needs Node, not the base image's package managers and their dependencies.
RUN rm -rf /usr/local/lib/node_modules/npm /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY runtime/ /opt/release-log/
ARG TOOL_VERSION
LABEL org.opencontainers.image.title="release-log" \
      org.opencontainers.image.description="Deterministic release CLI; no automatic publication" \
      org.opencontainers.image.source="https://github.com/lhajoosten/release-log" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${TOOL_VERSION}"

ENV HOME=/tmp \
    GIT_TERMINAL_PROMPT=0 \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null
WORKDIR /workspace
USER 1000:1000
ENTRYPOINT ["node", "/opt/release-log/dist/src/cli.js"]
CMD ["--help"]
