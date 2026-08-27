# Vercel deployment

Everything specific to running this app on Vercel, kept out of the way of local
development. Nothing here is imported by `npm run dev`, `npm run build` or
`npm start` — those never see this folder.

| file | what it is |
| --- | --- |
| `handler.ts` | The serverless function. Mounts the same routers as the local server via `createApiApp()`, waits for the database to come down from Blob, and flushes it back after the response. |
| `blob-db.ts` | CLI for moving the SQLite file between here and the Blob store by hand — `npm run db:list` / `db:push` / `db:pull` / `db:info`. |

One more entry point lives outside this folder: `scripts/blob-upload.js`
(`npm run db:upload`) sends a backup — by default the newest one the daily
backup task wrote — up to the store. It sits with the other backup scripts
because that folder is what it reads, and it is plain JS to match them.

## Two files that can't live here

Vercel finds both by filesystem convention at the deployment root, and neither
has a setting that points somewhere else:

- **`/vercel.json`** — platform config. Must be at the root of the deployed
  directory.
- **`/api/index.ts`** — a function is a file under `api/`. It is a two-line
  re-export of `handler.ts`, so the entrypoint's actual code is still here.

Both are marked with a comment saying so, so neither reads as a stray.

## The build

`vercel.json` sets `buildCommand: "npm run vercel"`, which builds the client and
nothing else — the server bundle (`dist/server.js`) is for self-hosting and has
no place in a serverless deployment. Vercel builds `api/index.ts` itself,
tracing its imports into `src/server`.

That keeps the two paths apart in both directions: the deploy build never
produces the local server, and `npm run build` never produces the function.

## What stays in `src/server`

`blobDb.ts` — the Vercel Blob adapter — deliberately did not move. `db.ts` calls
it as its durable-storage layer, so putting it here would make the *self-hosted*
build import from the deployment folder, which is the dependency the split is
meant to avoid. It stays inert unless `BLOB_READ_WRITE_TOKEN` is set, and the
SDK is imported lazily, so a local run never loads it.

See the root `README.md` for how the Blob storage works and how to set it up.
