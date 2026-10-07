# The relay must run on the building's own network: the appliances live on
# private (RFC1918) addresses, so this image is useless on a public cloud host.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY relay/package.json ./relay/
RUN npm install --workspaces --include-workspace-root --omit=dev=false
COPY relay/tsconfig.json ./relay/
COPY relay/src ./relay/src
RUN npm run build --workspace relay

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY relay/package.json ./relay/
RUN npm install --workspaces --include-workspace-root --omit=dev \
  && npm cache clean --force
COPY --from=build /app/relay/dist ./relay/dist

# Drop privileges; nothing here needs root.
USER node

EXPOSE 8787
ENV PORT=8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "relay/dist/server.js"]
