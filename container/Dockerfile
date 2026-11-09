FROM node:26.13.0-alpine3.24@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216

# The builder verifies archive hashes; apk verifies Alpine signatures without network resolution.
COPY apks/ /tmp/release-log-apks/
RUN apk --no-network --no-cache add /tmp/release-log-apks/*.apk \
    && rm -rf /tmp/release-log-apks

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
