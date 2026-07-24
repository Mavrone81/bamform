# BamForm API / worker — multi-stage, non-root (PR-004)
# syntax=docker/dockerfile:1

# ---------- deps ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json ./api/
COPY shared/package.json ./shared/
RUN npm ci --workspaces --include-workspace-root

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app
# `npm ci --workspaces` nests some deps under the consuming workspace instead
# of hoisting to the root (currently: api/node_modules/jose,
# api/node_modules/js-yaml — verify with `npm ls jose` if this ever changes).
# Copying only /app/node_modules from `deps` silently drops those, and
# `nest build` fails with "Cannot find module 'jose'". Copy the whole /app
# tree from `deps` (root node_modules + every nested workspace
# node_modules), then overlay real source with `COPY . .` below.
COPY --from=deps /app ./
COPY . .
RUN npx prisma generate --schema=api/prisma/schema.prisma \
 && npm run build --workspace=shared \
 && npm run build --workspace=api

# ---------- production deps only ----------
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json ./api/
COPY shared/package.json ./shared/
RUN npm ci --workspaces --include-workspace-root --omit=dev \
 && npm cache clean --force

# ---------- runtime ----------
FROM node:22-alpine AS runtime

# Chromium for server-side PDF rendering (PR-117). Puppeteer must not download
# its own copy — use the distro build so it is patched by the base image.
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont tini
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    NODE_ENV=production

# The runtime CMD is `node dist/main.js` — it never invokes npm/npx/corepack.
# The node:22-alpine base image nonetheless bundles npm's own CLI (with its
# own vendored, independently-versioned deps), which is genuinely unused
# attack surface here and periodically trips Trivy HIGH/CRITICAL findings
# (observed: brace-expansion, picomatch, sigstore, tar — all inside
# usr/local/lib/node_modules/npm/node_modules, not our application's
# dependencies). Removing it is not a scan suppression — it deletes the
# vulnerable code from the image outright, which is strictly safer than
# ignoring the finding.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

# Fixed uid/gid so volume ownership is predictable across rebuilds
RUN addgroup -g 10001 -S bamform && adduser -u 10001 -S bamform -G bamform

WORKDIR /app
COPY --from=prod-deps --chown=10001:10001 /app/node_modules ./node_modules
# Same nested-workspace-deps gap as the build stage above (see its comment)
# — without this, the shipped image is missing api/node_modules/jose and
# every request that needs a signed/verified access token 500s at startup
# with "Cannot find module 'jose'". dist/main.js resolves modules from
# /app/node_modules (dist has no api/ prefix — flattened by the COPY below),
# so this merges the nested workspace deps straight into it rather than
# preserving an api/ subdirectory that would never be on the resolution path.
COPY --from=prod-deps --chown=10001:10001 /app/api/node_modules ./node_modules
# `npm ci --workspaces` links @bamform/shared as node_modules/@bamform/shared
# -> ../../shared (a workspace symlink, `ls -la node_modules/@bamform/` in
# any stage shows it), so it resolves to /app/shared at runtime — which
# nothing copied before this fix (dist/prisma/openapi.yaml only). Every
# require('@bamform/shared') (auth.controller.ts, assets.service.ts,
# scheduling/job-generation.service.ts, ...) therefore crashed at import
# time with "Cannot find module '@bamform/shared'" the moment the process
# actually ran as a container (docker build only compiles; `docker compose
# up` is what exercises this, and CI jobs 1-6 never boot the built image —
# only jobs 7+, which stay red for unrelated PWA reasons, per
# .superpowers/sdd/progress.md — so this was never caught). Found and fixed
# while verifying this slice's worker entrypoint actually runs.
COPY --from=build     --chown=10001:10001 /app/shared/package.json ./shared/package.json
COPY --from=build     --chown=10001:10001 /app/shared/dist         ./shared/dist
# `prisma generate` (RUN step, `build` stage) writes the actual generated
# client — query engine binary included — into node_modules/.prisma/client;
# node_modules/@prisma/client is just a thin re-export of it (see its
# default.js). `prod-deps` never runs `prisma generate`, so without this the
# raw @prisma/client package loads but every generated enum/type
# (RevisionStatusT, JobStatusT, ...) is undefined at runtime. Both stages
# share the same node:22-alpine base, so the engine binary `prisma generate`
# fetched for `build` is the right platform for `runtime` too.
COPY --from=build     --chown=10001:10001 /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build     --chown=10001:10001 /app/api/dist      ./dist
COPY --from=build     --chown=10001:10001 /app/api/prisma    ./prisma
COPY --from=build     --chown=10001:10001 /app/api/openapi.yaml ./openapi.yaml

USER 10001:10001
EXPOSE 3000

# tini reaps zombie Chromium processes — without it the worker leaks PIDs
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
