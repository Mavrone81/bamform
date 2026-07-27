# BamForm PWA — static bundle served by nginx (ADR-001: no Node SSR process)
# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json ./web/
COPY shared/package.json ./shared/
RUN npm ci --workspaces --include-workspace-root
COPY . .
ARG VITE_APP_VERSION=local
# Same-origin relative path (.env.example) — a build ARG, not a runtime
# secret; src/api/config.ts also falls back to this exact default if it is
# ever omitted, so a build is never left silently calling `/undefined/...`.
ARG VITE_API_BASE_URL=/api/v1
ARG VITE_OFFLINE_HISTORY_DAYS=90
ENV VITE_APP_VERSION=${VITE_APP_VERSION}
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ENV VITE_OFFLINE_HISTORY_DAYS=${VITE_OFFLINE_HISTORY_DAYS}
RUN npm run build --workspace=shared && npm run build --workspace=web

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
# nginx-unprivileged already runs as uid 101; we align to 10001 for consistency
USER root
RUN deluser nginx 2>/dev/null || true; \
    addgroup -g 10001 -S bamform && adduser -u 10001 -S bamform -G bamform
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY web/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build --chown=10001:10001 /app/web/dist /usr/share/nginx/html
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
