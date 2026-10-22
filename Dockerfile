FROM node:22-bookworm-slim

ENV NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/auth ./src/auth
COPY src/db ./src/db
COPY src/http ./src/http
COPY src/inventory ./src/inventory
COPY src/jobs ./src/jobs
COPY src/inbox ./src/inbox
COPY src/channels ./src/channels
COPY src/workers ./src/workers
COPY src/replies ./src/replies
COPY src/policy ./src/policy
COPY src/config.mjs src/server.mjs src/worker.mjs src/meta-webhook.mjs src/conversation.mjs ./src/
COPY app ./app
COPY public ./public
COPY scripts/create-admin.mjs scripts/migrate.mjs scripts/import-json-state.mjs scripts/provision-runtime.mjs scripts/staging-facebook-check.mjs ./scripts/
COPY next.config.mjs ./next.config.mjs
RUN npm run build && chown -R node:node /app/.next

USER node
EXPOSE 3000
CMD ["node", "src/server.mjs"]

