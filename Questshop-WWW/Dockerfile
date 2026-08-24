FROM node:22.22.0-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-fund --no-audit

FROM postgres:16-bookworm AS pgtools

FROM node:22.22.0-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates liblz4-1 libpq5 libzstd1 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=pgtools /usr/lib/postgresql/16/bin/pg_dump /usr/local/bin/pg_dump
COPY --from=pgtools /usr/lib/postgresql/16/bin/pg_restore /usr/local/bin/pg_restore
WORKDIR /app
ENV NODE_ENV=production
ENV PG_DUMP_PATH=/usr/local/bin/pg_dump
ENV PG_RESTORE_PATH=/usr/local/bin/pg_restore
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY migrations ./migrations
COPY scripts ./scripts
COPY src ./src
USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
