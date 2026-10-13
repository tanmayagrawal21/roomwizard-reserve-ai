# The relay must run on the building's own network: the appliances live on
# private (RFC1918) addresses, so this image is useless on a public cloud host.
#
# Node 24+ specifically, for a stable built-in `node:sqlite` — that is what
# lets conversation history work with no native build step, which in turn is
# what keeps this image buildable on an arbitrary admin's machine.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY relay/package.json ./relay/
RUN npm ci --workspace relay --include-workspace-root
COPY relay/tsconfig.json ./relay/
COPY relay/src ./relay/src
RUN npm run build --workspace relay

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY relay/package.json ./relay/
RUN npm ci --workspace relay --include-workspace-root --omit=dev \
  && npm cache clean --force
COPY --from=build /app/relay/dist ./relay/dist

# Conversation history lives here; mount a volume on it to persist across
# restarts. Owned by `node` because the process drops privileges below.
RUN mkdir -p /data && chown node:node /data
ENV RW_CHAT_DB_PATH=/data/chat.db

USER node

EXPOSE 8787
ENV PORT=8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "relay/dist/server.js"]
