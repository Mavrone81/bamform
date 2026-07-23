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
COPY --from=deps /app/node_modules ./node_modules
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

# Fixed uid/gid so volume ownership is predictable across rebuilds
RUN addgroup -g 10001 -S bamform && adduser -u 10001 -S bamform -G bamform

WORKDIR /app
COPY --from=prod-deps --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build     --chown=10001:10001 /app/api/dist      ./dist
COPY --from=build     --chown=10001:10001 /app/api/prisma    ./prisma
COPY --from=build     --chown=10001:10001 /app/api/openapi.yaml ./openapi.yaml

USER 10001:10001
EXPOSE 3000

# tini reaps zombie Chromium processes — without it the worker leaks PIDs
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
