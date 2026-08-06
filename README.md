# astro_planner
small app to plan astrophotography targets and track their completition

## Running

One Node app serves the API and the UI on a single port (`PORT`, default 5000).

```
npm install
npm run dev     # one process, Vite middleware, HMR
npm run build   # client → dist/public, server → dist/server.js
npm start       # production
```

`npm run typecheck` checks the server, client and build-config projects.

The SQLite file lives in `data/` (`SQLITE_PATH` in `.env`). Deploying means
shipping `dist/` plus `node_modules/better-sqlite3` — the only dependency left
outside the server bundle, because it carries a native binding.

## Deploying

**Render** (`render.yaml`) is the supported target. One web service runs
`dist/server.js`, which serves both the API and the client, and a mounted disk
at `/var/data` holds the SQLite file so it survives deploys and restarts.

**Vercel** (`vercel.json`) is a second, read-mostly target. It splits the app:
the client is built by `build:client` and served from the CDN, while `/api/*` is
rewritten to a serverless function (`api/index.ts`) that mounts the same routers
via `createApiApp()`.

The catch is storage. Vercel gives a function no persistent disk — only `/tmp`,
which is per-instance and wiped on every cold start. So `SQLITE_PATH` points at
`/tmp/astro_planner.db`, each cold instance copies the committed `data/seed.db`
into place, and **anything written afterwards is lost** (and invisible to other
concurrent instances). That is fine for a demo or a read-only share; it is not
fine for real use, which is what the Render disk is for. Making Vercel a real
target means moving off local SQLite to a networked database.

Refresh the seed the Vercel build ships with:

```
sqlite3 data/astro_planner.db "VACUUM INTO 'data/seed.db'"
```
