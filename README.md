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
