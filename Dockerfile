FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      chromium curl fonts-thai-tlwg novnc openbox supervisor websockify x11vnc xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY app ./app
COPY fixture ./fixture
COPY scripts ./scripts
COPY supervisord.conf ./supervisord.conf
COPY next.config.mjs ./next.config.mjs
RUN npm run build

RUN mkdir -p /data/chromium /state/evidence \
    && chown -R node:node /app /data /state

EXPOSE 3000
CMD ["/usr/bin/supervisord", "-c", "/app/supervisord.conf"]

