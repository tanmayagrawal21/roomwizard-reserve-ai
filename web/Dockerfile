# Static build, served by nginx. The relay's address is baked in at build time
# from VITE_RELAY_URL, but is also changeable at runtime from the UI's Relay
# panel — so getting it wrong here is recoverable, not fatal.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json ./web/
RUN npm ci --workspace web --include-workspace-root
COPY web/ ./web/
# Served from the domain root in a container, not a GitHub Pages subpath.
ARG VITE_BASE=/
ARG VITE_RELAY_URL
ENV VITE_BASE=$VITE_BASE
RUN if [ -n "$VITE_RELAY_URL" ]; then export VITE_RELAY_URL="$VITE_RELAY_URL"; fi; \
    npm run build --workspace web

FROM nginx:alpine AS runtime
COPY --from=build /app/web/dist /usr/share/nginx/html
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
