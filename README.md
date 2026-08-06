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

The SQLite file lives in `data/` (`SQLITE_PATH` in `.env`), unless a Vercel Blob
store is configured — see below. Deploying means
shipping `dist/` plus `node_modules/better-sqlite3` and, if a blob store is
configured, `node_modules/@vercel/blob` — the dependencies left outside the
server bundle.

## Deploying

**Render** (`render.yaml`) is the supported target. One web service runs
`dist/server.js`, which serves both the API and the client, and a mounted disk
at `/var/data` holds the SQLite file so it survives deploys and restarts.

**Vercel** (`vercel.json`) splits the app: the client is built by `build:client`
and served from the CDN, while `/api/*` is rewritten to a serverless function
(`api/index.ts`) that mounts the same routers via `createApiApp()`.

Vercel gives a function no persistent disk — only `/tmp`, which is per-instance
and wiped on every cold start. Vercel Blob covers that gap; see below.

Refresh the seed the Vercel build ships with:

```
sqlite3 data/astro_planner.db "VACUUM INTO 'data/seed.db'"
```

## Vercel Blob storage

Set `BLOB_READ_WRITE_TOKEN` and the SQLite file stops being the database and
becomes a working copy of it. The server pulls the file from the blob store at
boot (`initDatabase()`) and pushes a fresh snapshot after any request that
changed something. `SQLITE_PATH` still says where the working copy lives —
`/tmp/astro_planner.db` on Vercel — but losing it no longer loses data.

Leave the token unset and none of this happens: the file on disk is the
database, the SDK is never even imported, and local dev and the Render disk
behave exactly as they did before.

Setting it up:

1. Create a Blob store on the project's **Storage** tab, access **Private**, and
   **connect it to the project** — that is what puts `BLOB_READ_WRITE_TOKEN` in
   the function's environment. Creating a store is not enough on its own.
2. Deploy. The server reads the database at `BLOB_DB_KEY`, which defaults to
   `astro_planner.db` — where it already sits in the `astro-planner-db` store.
   If that key holds nothing, the first boot uploads whatever it opened instead
   (on Vercel, the committed `data/seed.db`), so an empty store is populated
   without a separate migration step.

The key has to match the pathname exactly. A file put in the store by hand —
the dashboard, or `vercel blob put` — keeps whatever name it was given, and can
pick up a random suffix. `npm run db:list` prints the pathnames the store
actually holds and flags whether `BLOB_DB_KEY` matches one; anything under a
different pathname is invisible to the server.

### Is it actually using the blob?

`GET /api/health` answers this without going near the log viewer:

```json
{ "status": "ok",
  "database": {
    "instance": "j3ljce", "bootedAt": "…", "path": "/tmp/astro_planner.db",
    "blob": { "enabled": true, "key": "astro_planner.db",
              "restoredAtBoot": true, "pendingSnapshot": false,
              "remoteVersion": "…", "lastUploadAt": "…", "lastError": null } } }
```

- `enabled: false` — the token is not in this environment. The store exists but
  was never *connected to the project*. Every write is going to `/tmp` and dies
  with the instance. This is the usual cause of "my changes disappeared".
- `restoredAtBoot: false` — the token works, but nothing was found at `key`.
  The instance has just uploaded its own copy there; if you expected existing
  data, the key is wrong (`npm run db:list`).
- `lastError` — the last upload that failed, with its message.
- **`instance` changing across repeated calls** — more than one instance is
  serving, and each has its own copy of the database. See below.

The same picture is in the cold-start log: `Restored database from Vercel Blob`,
or `No database in Vercel Blob yet`.

### Several instances

Vercel starts instances as concurrency demands, and nothing tells one that
another has written. An instance that only pulled at boot goes stale silently:
reads serve old data, and a write branches off the stale copy and uploads a
database missing the other instance's work.

So every request checks first. `refreshDatabaseFromBlob()` compares the store's
version (a `head`, headers only) against the one this copy came from, and
re-downloads when they differ. Writes always check, because a write must branch
off the current version. Reads may be up to `BLOB_REVALIDATE_MS` behind
(default 2000) — one page load fires a dozen API calls and a round trip on each
is latency for a change that cannot have happened in between.

That makes concurrent instances converge rather than diverge, but it is
cooperation, not locking: two writes landing in the same instant can still
collide, and the loser's copy is kept as a `.conflict-` blob. For one person
using the app that window is theoretical. If the app ever gets genuinely
concurrent writers, move to a database built to be shared — Turso is SQLite over
the network and the smallest step from here.

Blob is object storage, so the whole file moves on every read and every write.
That is fine at this size (under a megabyte) and with one person using the app;
it is not a networked database and does not pretend to be:

- **Every write uploads the entire database, and waits for it.** The response is
  held until the upload lands, so a 2xx means the change is stored, not merely
  written to the local file. Snapshotting after the response instead would be
  faster and wrong: a serverless instance can be suspended the moment the
  response is flushed, and an upload still in flight never finishes — the client
  sees success and the write is gone at the next cold start.
- **Two instances writing at once will conflict.** Uploads are conditional on
  the version the instance started from, so the second one cannot silently
  overwrite the first — the copy it would have destroyed is preserved under a
  `…​.conflict-<timestamp>` key and a warning is logged. Nothing is lost, but
  reconciling the two is a manual job. If the app ever gets concurrent writers,
  that is the point to move to Postgres/Turso rather than tune this.
- **The blob is the whole database.** Keep the store private; a public blob is
  downloadable by anyone with the URL.

Moving the file by hand — needs `BLOB_READ_WRITE_TOKEN` in `.env`, or
`vercel env pull`:

```
npm run db:list              # every blob in the store, with its pathname
npm run db:info              # what the store holds at BLOB_DB_KEY
npm run db:push              # local SQLITE_PATH → blob (seed it, or overwrite)
npm run db:push -- data/seed.db
npm run db:pull              # blob → local SQLITE_PATH (inspect production)
npm run db:pull -- /tmp/prod.db
```

`db:push` overwrites unconditionally — it is the deliberate-override escape
hatch, so it does not do the conflict dance the server does.
