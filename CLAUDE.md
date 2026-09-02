# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Domain

Personal astrophotography planner: what to shoot, what has been shot, and whether the
subs are worth keeping. One user, one database, on the order of 1200 imaging hours a year.

**The normal loop is plan-first** — create an object, set per-filter integration targets
on a plan, shoot it across many nights, then import. But import must also work when the
files arrive first: creating the object, session and entries on the fly is a supported
path, not a degraded one. Don't write import code that assumes a plan or object already
exists.

**Objects are imaged across many nights**, and everything that moves quality moves
between them — seeing, guiding, moonlight. So the purpose of the quality numbers is
*comparability across sessions*, not ranking within one night. That is the entire reason
the PSFSW anchor is frozen: a scale recomputed as subs accumulate silently redefines
every value ever shown, which destroys the comparison the feature exists to provide.
Treat it as the system's core requirement, not an implementation detail.

**PSFSW is the working metric; FWHM is a backup.** Neither is sufficient — a bad sub can
hide behind numbers as good as its neighbours', and only blinking finds it. Blink is the
court of last resort, and it competes with the user's willingness to open it, so friction
added to blinking costs real quality. Surfacing *when* the numbers are ambiguous is worth
more than making the numbers more precise.

**Deleting a good sub is the worst thing this app can do.** A miscounted integration
total is a nuisance by comparison. Culling exists for storage economics — roughly 20,000
subs and 1.5–2 TB a year before processing data — not because rejected subs are
worthless; keeping everything would be preferable if it were affordable. Anything on the
cull path that makes deletion more reversible, more reviewable or narrower in scope is
aligned with intent; anything that widens or accelerates deletion is not.

**Capture is ASIAIR, processing is PixInsight** — both subject to change, as are their
internal filename conventions. That is why the filename pattern is a user setting and
why matching tolerates tool-appended suffixes. Never hardcode an ASIAIR or PixInsight
convention; anything tool-specific belongs in configuration.

**Deliberately not built: session planning** — choosing tonight's target from altitude,
moon and weather. ASIAIR covers that, so the app doesn't. It would be a core feature for
a NINA-based rig; here it is out of scope. Don't propose it.

The Calendar page is a retrospective summary of what actually got imaged, not a forward
planner — its moon and darkness figures are context for reading past nights. Planning
from it would help little in any case: the binding constraint on how much of the
available time gets used is weather, which nothing here models.

## Commands

```
npm ci               # install exactly what package-lock.json says
npm run dev          # one process on :5000 — API + Vite middleware, HMR
npm run typecheck    # tsc -b over all three project references
npm run build        # client → dist/public, server → dist/server.js
npm start            # runs dist/server.js
```

`npm install` runs `build` through the `prepare` script, so a fresh clone is runnable
without a separate build. npm skips `prepare` when devDependencies are omitted
(`--omit=dev`, or `NODE_ENV=production`) — that is deliberate, it keeps the install from
failing on a host with no vite/esbuild.

There is no test suite and no linter. `npm run typecheck` is the only automated check.

Database helpers (`db:push`/`db:pull`/`db:list`/`db:info` need `BLOB_READ_WRITE_TOKEN`;
`db:snapshot`/`db:upload` work locally) are documented in the README.

## Architecture

**One process serves API and client.** No separate Vite dev server, no `/api` proxy, no
CORS — same origin in every deployment. In dev, Vite runs as Express middleware sharing
the HTTP server (so HMR shares the port); in production the same process serves
`dist/public`.

**Two entrypoints mount the same routers**, which is why `src/server/api.ts` (the
`createApiApp()` factory) is separate from `src/server/index.ts`:

- `src/server/index.ts` — self-hosting. Binds a port, mounts the client, bundled by
  `scripts/build-server.js` into `dist/server.js`.
- `deploy/vercel/handler.ts` (re-exported by `api/index.ts`, which must sit at the repo
  root because Vercel finds it by convention) — serverless. Only `/api/*` reaches it; the
  CDN serves the client. `npm run vercel` builds the client only and never touches the
  server bundle.

**Server layering is one quadruple per table**, all prefixed `ap`/`Ap`:

```
src/server/models/ApThing.ts      interfaces + Create/Update DTO types only — no logic
src/server/services/apThingService.ts   all SQL, via connectToDatabase()
src/server/routes/apThing.ts      Router: validate params/body, call service, map errors
src/server/api.ts                 app.use('/api/kebab-case', router)
```

Services are `async` although better-sqlite3 is synchronous — keep that, the whole call
chain is written against it. SQL uses named parameters (`@id`, `@equipment`). SQLite
booleans are integers, mapped with `!!` in the service's `mapRow`. Routes return
`{ error: string }` with a generic 500 on any throw. Adding a table means all four files
plus a `CREATE TABLE` in `db.ts`.

**The schema lives in `initSchema()` in `src/server/db.ts`**, not in a migration tool.
`CREATE TABLE IF NOT EXISTS` for the base shape, then a run of idempotent
`try { database.exec('ALTER TABLE …') } catch {}` lines for everything added since, then
data backfills and seed rows. Migrations are append-only and must stay safe to re-run on
every boot. `astro_planner.sql` at the root is a historical dump, not the source of truth.

**Vercel Blob mode changes what the SQLite file means.** With `BLOB_READ_WRITE_TOKEN`
set, `SQLITE_PATH` is a working copy: pulled at boot by `initDatabase()`, and two
middlewares in `api.ts` keep instances converged — `revalidateBeforeHandling` re-downloads
when the store's version moved (always for writes, at most every `BLOB_REVALIDATE_MS` for
reads), and `snapshotBeforeResponding` holds `res.end()` until the upload lands, so a 2xx
means the change is stored. Uploading after the response is wrong here: a serverless
instance can be suspended the instant the response flushes. Every path is gated on
`isBlobEnabled()`, so without a token none of it runs and the file on disk *is* the
database.

`journal_mode = DELETE`, not WAL, set explicitly — one writer, and the `-shm` sidecar is
what keeps the database off a Windows bind mount.

**Local backups have two writers and one file per day.** `scripts/backup-daily.js` (the
`backup` compose service) is the scheduled floor; `src/server/localBackup.ts` rewrites the
same day's snapshot a few seconds after any successful non-GET, so the newest copy is as
fresh as the last import or cull rather than as fresh as 03:00. They agree on
`astro_planner-<date>.db`, replaced atomically via `.partial` + rename — a backup path
must never have a window where the old copy is gone and the new one is not there yet.
Keep both: the scheduled run is what still fires on a day the middleware has silently
stopped working. Off entirely when `isBlobEnabled()`.

**The server never touches image files.** Picking folders, reading FITS, measuring frame
quality, copying subs into object folders and deleting culled ones all happen in the
browser through the File System Access API (`utils/imagesFolder.ts`; directory handle
persisted in IndexedDB). Chromium-only, by design — it is what lets the same build run in
a container or a serverless function. The only path the server resolves is its own SQLite
file. Don't add server-side filesystem endpoints for user images.

FITS decoding, quality analysis and blink previews run in a dedicated worker
(`utils/fitsWorker.ts`) one file at a time, so a frame is only ever held in memory once;
previews are cached in IndexedDB (`utils/previewCache.ts`, bump `PREVIEW_VERSION` when the
render changes).

**Equipment ("rig") is a cross-cutting filter.** Most endpoints take `?equipment=<id>` and
scope their aggregates to sessions taken with that rig; the client reads the active rig
from `EquipmentContext` (persisted in localStorage) and passes it through the `eqQuery`
helper in `src/client/api/index.ts`. New endpoints that report captured time should
accept it too.

**Client structure is deliberately plain**: no router and no state library — `App.tsx`
switches pages with `useState`, and `src/client/api/index.ts` is the single fetch layer
(every call goes through it; components never call `fetch` on `/api` directly). Most of
the weight is in `pages/ImportPanel.tsx` and `pages/ObjectsPage.tsx`.

**PSFSW anchors** (`utils/psfsw.ts`, `ap_psfsw_anchor`): frame-quality values are shown as
a ratio against a per-target+filter anchor, set once from the median and then frozen in
the database. Never recompute an anchor from a growing population — see Domain for why
this one is load-bearing.

## Constraints

- **TypeScript project references.** `tsconfig.json` is a solution file; the real settings
  are in `tsconfig.server.json` / `.client.json` / `.node.json`. Its `compilerOptions`
  exist for tools that walk up from a file (Vercel's builder, editors) and must be kept in
  step with the per-project configs.
- **Server bundle externals** are `better-sqlite3` (prebuilt native binding), `vite` (dev
  only, dynamically imported) and `@vercel/blob` (WASM via `require`). Deploying means
  shipping `dist/` plus those packages from `node_modules`.
- **Route ordering matters**: literal paths like `/filter-stats` are declared before
  `/:id`, and the `/api` catch-all 404 must stay so a mistyped endpoint never falls
  through to the SPA.
- `requireAuth` is mounted pathless and ahead of the body parser and blob revalidation, so
  an unauthenticated request cannot make the process download the database or parse a
  body. Keep new middleware behind it.
- **The repo is public and the database is personal data.** `data/`, `src/data/`,
  `backups/` and `.env` are gitignored; a database reaches a deployment through
  `npm run db:push`, never through a commit. `vercel.json` is committed — secrets go in
  the Vercel dashboard, not there.
- Node >= 22. `better-sqlite3` carries its own SQLite; nothing else has to be installed.
