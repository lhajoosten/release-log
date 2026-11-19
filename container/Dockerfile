FROM node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5

# The builder verifies archive hashes; apk verifies Alpine signatures without network resolution.
COPY apks/ /tmp/release-log-apks/
RUN apk --no-network --no-cache add /tmp/release-log-apks/*.apk \
    && rm -rf /tmp/release-log-apks

# The CLI needs Node, not the base image's package managers and their dependencies.
RUN rm -rf /usr/local/lib/node_modules/npm /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY runtime/ /opt/release-log/
ARG TOOL_VERSION
ARG SOURCE_REVISION
LABEL org.opencontainers.image.title="release-log" \
      org.opencontainers.image.description="Deterministic release CLI; no automatic publication" \
      org.opencontainers.image.source="https://github.com/lhajoosten/release-log" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${TOOL_VERSION}" \
      org.opencontainers.image.revision="${SOURCE_REVISION}"

ENV HOME=/tmp \
    GIT_TERMINAL_PROMPT=0 \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null
WORKDIR /workspace
USER 1000:1000
ENTRYPOINT ["node", "/opt/release-log/dist/src/cli.js"]
CMD ["--help"]
