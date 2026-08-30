FROM node:22.22.0-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-fund --no-audit

FROM node:22.22.0-bookworm-slim
WORKDIR /app
ARG GIT_SHA=0000000000000000000000000000000000000000
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY migrations ./migrations
COPY scripts ./scripts
COPY src ./src
RUN printf '%s\n' "$GIT_SHA" > .source-sha
RUN mkdir -p /data/backups \
  && chown -R node:node /app /data \
  && chmod 0700 /data /data/backups
USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
