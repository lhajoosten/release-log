FROM node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS build
WORKDIR /app
RUN npm install --global pnpm@12.14.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
COPY scripts/build.ts ./scripts/build.ts
COPY src/ ./src/
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm build && pnpm prune --prod --ignore-scripts

FROM node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
RUN apk add --no-cache git libcrypto3=3.5.9-r1 libssl3=3.5.9-r1 zlib=1.4-r0 \
    && rm -rf /usr/local/lib/node_modules/npm /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=build /app/dist/ ./dist/
COPY --from=build /app/node_modules/ ./node_modules/
COPY --from=build /app/package.json ./package.json
ARG TOOL_VERSION
ARG SOURCE_REVISION
ARG SOURCE_URL
LABEL org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.version="${TOOL_VERSION}" \
      org.opencontainers.image.revision="${SOURCE_REVISION}"
ENV HOME=/tmp GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
USER 1000:1000
ENTRYPOINT ["node", "/app/dist/src/cli.js"]
CMD ["--help"]
