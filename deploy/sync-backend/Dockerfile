# SPDX-License-Identifier: AGPL-3.0-or-later
FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV SYNC_DATA_DIR="/data"
ENV HOST="0.0.0.0"

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@11.27.0

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY fluxer_app/package.json ./fluxer_app/package.json
COPY fluxer_admin/package.json ./fluxer_admin/package.json
COPY fluxer_docs/package.json ./fluxer_docs/package.json
COPY tsconfigs ./tsconfigs
COPY config ./config
COPY packages ./packages
COPY fluxer_api ./fluxer_api
COPY patches ./patches

RUN pnpm install --filter fluxer_api... --frozen-lockfile

RUN mkdir -p /data

EXPOSE 8080

CMD ["pnpm", "--filter", "fluxer_api", "start:sync"]
