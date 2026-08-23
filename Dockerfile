# syntax=docker/dockerfile:1

# Current Node. better-sqlite3 v13 ships one Node-API binding per platform
# inside the package — including linux-x64 and linuxmusl-x64 — so the binary is
# not tied to a Node version and `npm ci` never downloads or compiles anything.
# That is what makes running the newest Node here safe; v11 shipped a binding
# per ABI and had none past Node 23.
#
# 26 is Current, not LTS. Change this to 24 for the LTS line; nothing else needs
# to move, because engines only requires >=22.
ARG NODE_VERSION=26

# ── dependencies ────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts is doing two necessary jobs here.
#
# better-sqlite3 v13 ships a binding.gyp but no install script, and npm's
# default response to that combination is `node-gyp rebuild` — which needs
# Python and a toolchain this image doesn't have. There is nothing to build:
# the Node-API binding is picked out of prebuilds/ at require time.
#
# It also skips `prepare`, which would run the full app build before any source
# has been copied. This layer exists to cache dependencies alone, so that
# editing a source file doesn't reinstall them.
RUN npm ci --ignore-scripts

# ── development ─────────────────────────────────────────────────────────────
# compose.yaml mounts the source over /app, so what is copied here only matters
# for `docker run` without compose.
FROM deps AS dev
ENV NODE_ENV=development
COPY . .
EXPOSE 5000
CMD ["npm", "run", "dev"]

# ── production build ────────────────────────────────────────────────────────
FROM deps AS build
COPY . .
RUN npm run build

# ── production ──────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS prod
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# Runtime dependencies only. esbuild bundles express and friends into
# dist/server.js; better-sqlite3 is left external because it is a native module,
# and @vercel/blob because its WASM parser does not survive bundling. vite is
# the third external and is a devDependency the production server never imports.
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
EXPOSE 5000
# SQLITE_PATH defaults to ./data relative to the app root, which is where
# compose mounts the database volume.
CMD ["node", "dist/server.js"]
