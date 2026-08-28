# astro_planner
small app to plan astrophotography targets and track their completition

## Running

One Node app serves the API and the UI on a single port (`PORT`, default 5000).
Needs **Node 22 or newer** (`.nvmrc` pins the current release, 26). Nothing else
has to be installed first — in particular **not SQLite**, which `better-sqlite3`
carries its own copy of, as a prebuilt binary per platform inside the package.
No compiler, no download, no `node-gyp`.

Don't want to install Node at all? See [Docker](#docker) below.

```
npm install     # installs, then builds via the prepare script
npm start       # http://localhost:5000
```

No `.env` is needed to start: `PORT` and `SQLITE_PATH` both have defaults, and
`.env.example` documents what overriding them does.

### Docker

For developing on the current Node without installing it, or for running the app
without a Node toolchain at all:

```
docker compose up                                # dev, http://localhost:5000
docker compose run --rm app npm run db:snapshot  # copy the DB to ./backups
docker compose build                             # after a dependency change
```

`compose.yaml` carries three volume entries that each work around a specific way
a plain bind mount breaks this app on Windows — a Linux-native `node_modules`,
the database on a named volume rather than the host drive, and a backups folder
to get snapshots back out. The reasoning is in the comments there; the short
version is that SQLite's file locking needs semantics a Windows bind mount does
not provide, so the database deliberately does not live on your Windows drive.
`npm run db:snapshot` writes a consistent copy that does.

Editing works normally: the source is bind-mounted and watched by polling
(`CHOKIDAR_USEPOLLING`), because bind mounts on Windows drives do not deliver
inotify events into the container.

The same Dockerfile builds a production image:

```
docker build --target prod -t astro-planner:prod .
docker run -p 5000:5000 -v astro-planner-data:/app/data astro-planner:prod
```

`npm run db:snapshot` also works outside Docker, writing to `./backups`.

#### Backups

The stack includes a `backup` service that snapshots the database once a day
into `./backups` and keeps the last seven. It runs inside compose rather than as
a cron or Task Scheduler entry, so it needs no per-machine setup — starting the
stack is enough. Tune it on the service in `compose.yaml`:

| | |
|---|---|
| `BACKUP_AT` | time of day, container-local. Default `03:00` — UTC unless you set `TZ` |
| `BACKUP_KEEP` | how many to retain. Default `7` |

It also takes one on every start, so cycling the service is how you force a
backup — and a machine that is switched off at `BACKUP_AT` still gets one when
it comes up:

```
docker compose restart backup
```

The scheduled run is skipped when that day already has a snapshot, so a restart
during the day does not add a second one at 03:00. Only files it wrote are
pruned (`astro_planner-<timestamp>.db`) — a copy you make by hand keeps its own
name and is never touched.

Each run leaves two files:

| | |
|---|---|
| `backups/astro_planner-<timestamp>.db` | the history, pruned to `BACKUP_KEEP` |
| `backups/astro_planner.db` | the newest one under the database's own name, replaced every run |

The second is the point of the folder for everyday use: the database lives on a
named volume, out of Explorer's reach, and this is it at a path you can type —
open it in a SQLite browser, copy it to another machine, hand it to
`npm run db:upload` — without first reading a timestamp out of a directory
listing. It is never pruned, and the name follows `SQLITE_PATH`, so pointing
that elsewhere renames this too.

Restore over the live database with the app stopped — the latest, or a specific
day from the history:

```
docker compose down
docker compose run --rm -e SQLITE_PATH=/backups/astro_planner.db \
  app npm run db:snapshot -- /app/data/astro_planner.db
docker compose up -d
```

#### Initialising the database volume

`astro-planner-data` starts empty and the app creates its schema on first boot,
so an empty database needs nothing. To start from an existing one instead, run
the restore above with `-v "/path/to/data:/import"` and `SQLITE_PATH` pointing
into `/import`. The mount must be writable, not `:ro` — SQLite needs to be able
to create a journal file beside the database even to read it, and read-only
fails with `SQLITE_CANTOPEN`.

Note the app's own `data/seed.db` fallback never fires under Docker: the volume
is mounted over `/app/data`, which hides the repo's copy. Seed explicitly with
the same command.

### Your image files

The server never touches them. Picking folders, reading FITS, measuring frame
quality, copying subs into object folders and deleting culled ones all happen in
the browser through the File System Access API — which needs Chrome or Edge,
opened directly rather than embedded. The server stores records and serves the
app; the only path it ever resolves is its own SQLite file.

That is what lets the same build run anywhere: a container or a serverless
function has no access to your drives and does not need any, because the bytes
never leave the browser.

### Developing

```
npm ci          # exactly what package-lock.json says
npm run dev     # one process, Vite middleware, HMR
npm run typecheck
```

`npm run build` rebuilds by hand (client → `dist/public`, server →
`dist/server.js`); `prepare` runs the same thing after every `npm install`, so a
fresh clone is runnable without a separate build step. npm skips `prepare` when
devDependencies are omitted (`--omit=dev`, or `NODE_ENV=production`), which is
what keeps it from failing on a host that has no vite or esbuild to build with —
such a host wants `dist/` shipped to it, not rebuilt.

The SQLite file lives in `data/` (`SQLITE_PATH` in `.env`), unless a Vercel Blob
store is configured — see below. Deploying means
shipping `dist/` plus `node_modules/better-sqlite3` and, if a blob store is
configured, `node_modules/@vercel/blob` — the dependencies left outside the
server bundle.

## Deploying

**Any Node host** runs `dist/server.js`, which serves the API and the client on
one port. Point `SQLITE_PATH` at storage that survives a restart — on a host
whose filesystem is rebuilt each deploy, that means a mounted disk, or the blob
store below.

**Vercel** splits the app: the client is served from the CDN, while `/api/*` is
rewritten to a serverless function that mounts the same routers via
`createApiApp()`. It lives in [`deploy/vercel/`](deploy/vercel/README.md) and
builds with its own command:

```
npm run vercel   # client only — what vercel.json runs
```

`npm run build` (client + `dist/server.js`) is the self-hosting build and never
touches the function; `npm run vercel` never builds the server bundle. Two files
have to sit at the repo root because Vercel finds them by convention — the
config `vercel.json` and the function `api/index.ts`, which is a re-export of
`deploy/vercel/handler.ts`.

Vercel gives a function no persistent disk — only `/tmp`, which is per-instance
and wiped on every cold start. Vercel Blob covers that gap; see below.

Refresh the seed the Vercel build ships with:

```
npm run db:snapshot -- data/seed.db
```

(Same `VACUUM INTO` the `sqlite3` CLI would do, without needing the CLI
installed. In Docker, prefix with `docker compose run --rm app`.)

## Vercel Blob storage

Set `BLOB_READ_WRITE_TOKEN` and the SQLite file stops being the database and
becomes a working copy of it. The server pulls the file from the blob store at
boot (`initDatabase()`) and pushes a fresh snapshot after any request that
changed something. `SQLITE_PATH` still says where the working copy lives —
`/tmp/astro_planner.db` on Vercel — but losing it no longer loses data.

Leave the token unset and none of this happens: the file on disk is the
database, the SDK is never even imported, and local dev and any host with a real
disk behave exactly as they did before.

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
npm run db:upload            # newest ./backups snapshot → blob (see below)
npm run db:upload -- backups/astro_planner-2026-08-27T03-00-00-004.db
```

`db:push` overwrites unconditionally — it is the deliberate-override escape
hatch, so it does not do the conflict dance the server does.

### Sending a local database to Vercel

The deployment's database is the blob, so putting local data online means
replacing that file. `npm run db:upload` does it from a backup:

```
npm run db:upload                        # the newest snapshot in ./backups
npm run db:upload -- <file>              # a specific backup, or a live database
docker compose run --rm app npm run db:upload   # same, from inside the stack
```

It is `db:push` aimed at the backup folder, with two additions: the file is
staged through `VACUUM INTO` first — which folds in the WAL if you pointed it at
a live database, and fails on a truncated or corrupt file *before* anything in
the store is touched — and whatever the store held is copied to
`<BLOB_DB_KEY>.previous` before the overwrite, so a wrong upload is one copy
away from being undone. `npm run db:list` shows both keys.

The hosted app picks the new file up on its next request: instances revalidate
against the store's etag rather than trusting the copy they booted with.

Uploading is deliberate, never scheduled. It is a one-way overwrite: anything
entered in the hosted app since the last upload is replaced by this machine's
copy — recoverable from `<BLOB_DB_KEY>.previous`, but only by hand. Run it when
you mean to publish local data, not on a timer.
