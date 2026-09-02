// Send a local database file up to the Vercel Blob store the deployment reads.
//
//   npm run db:upload                  # the newest snapshot in ./backups
//   npm run db:upload -- <file>        # a specific backup, or a live database
//
// This is the missing direction in the backup story. `npm run db:snapshot` and
// the daily `backup` service take copies *out* of the local database; this puts
// one *into* the store that the Vercel deployment reads at boot and revalidates
// on every request, so the hosted app starts serving that data within a request
// or two. Always by hand — nothing uploads on a schedule, because a scheduled
// push would silently overwrite anything entered in the hosted app.
//
// Plain JS, and here rather than a command in deploy/vercel/blob-db.ts, because
// the backup folder it reads is this folder's business and the scripts around
// it are plain JS run straight by node. The key/access lookups below therefore
// mirror src/server/blobDb.ts rather than importing it (a .ts import would drag
// tsx in). That file stays the authority — if the env variables change, they
// change there first. What is deliberately *not* mirrored is its etag
// bookkeeping: the server refuses to overwrite a version it has not seen,
// whereas an upload from here is a person saying "make the store hold this
// file" — the same deliberate-override stance as `npm run db:push`.
//
// Needs BLOB_READ_WRITE_TOKEN (`.env` is loaded, or `vercel env pull`).
import 'dotenv/config'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { defaultBackupDir, snapshotTo } from './snapshot-db.js'

export const isBlobEnabled = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim())

export const blobKey = () => process.env.BLOB_DB_KEY?.trim() || 'astro_planner.db'

const blobAccess = () => (process.env.BLOB_DB_ACCESS?.trim() === 'public' ? 'public' : 'private')

// Where the copy being replaced is kept. One rolling key rather than a
// timestamped one: this is an undo step for the upload that just happened, not
// an archive — the archive is ./backups. Restore it with
// `npm run db:pull -- <file>` after pointing BLOB_DB_KEY at it, or copy it back
// over the live key from the dashboard.
export const previousKey = () => `${blobKey()}.previous`

/** The most recent snapshot the backup task wrote, or null if there are none. */
export const latestSnapshot = (dir = defaultBackupDir()) => {
  if (!fs.existsSync(dir)) return null
  // Same name shape backup-daily.js prunes on. Its `astro_planner.db` copy of
  // the newest one is skipped by the same pattern — identical content, but a
  // name that says less in a log.
  //
  // Ordered by mtime, not by name. Name order was right while every snapshot
  // carried a full ISO timestamp, and is wrong now that they are named for the
  // day and rewritten within it: a leftover astro_planner-<date>T<time>.db from
  // the old scheme sorts *after* the same date's day file, so for as long as one
  // survives pruning this would upload a snapshot hours stale. Name breaks ties,
  // which is what a folder copied wholesale gives you.
  const names = fs.readdirSync(dir)
    .filter(name => /^astro_planner-.*\.db$/.test(name))
    .map(name => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name))
  const newest = names.at(-1)
  return newest ? path.join(dir, newest.name) : null
}

/** What the store holds at BLOB_DB_KEY right now, or null if nothing does. */
export const storedDb = async () => {
  const { head, BlobNotFoundError } = await import('@vercel/blob')
  try {
    return await head(blobKey())
  } catch (error) {
    if (error instanceof BlobNotFoundError) return null
    throw error
  }
}

/**
 * Replace the stored database with `file`.
 *
 * The file is staged through VACUUM INTO first. That is not just the usual
 * WAL-folding argument — though it covers that too, so a live database can be
 * handed straight to this — it is also the only check that what is about to
 * overwrite production is a readable SQLite database at all. A truncated or
 * half-written file fails here, before anything in the store is touched.
 *
 * Whatever the store held is copied to previousKey() before the overwrite, so
 * an upload of the wrong file is always one copy away from being undone.
 */
export const uploadToBlob = async (file) => {
  if (!isBlobEnabled()) throw new Error('BLOB_READ_WRITE_TOKEN is not set')

  const source = path.resolve(file)
  const staged = path.join(os.tmpdir(), `astro-planner-upload-${process.pid}-${Date.now()}.db`)
  const { size } = snapshotTo(source, staged)

  try {
    const { put, copy } = await import('@vercel/blob')
    const access = blobAccess()

    const replaced = await storedDb()
    if (replaced) {
      // Copied from the URL head() just handed back rather than from the
      // pathname: for a private blob that URL is the form the API is certain
      // to accept, and we are holding it anyway.
      await copy(replaced.url, previousKey(), { access, addRandomSuffix: false, allowOverwrite: true })
    }

    await put(blobKey(), fs.readFileSync(staged), {
      access,
      // A stable key: this is one mutable document the server finds by name,
      // not a versioned upload.
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/vnd.sqlite3',
      // The database changes on every write; a cached copy is a wrong copy.
      cacheControlMaxAge: 0,
    })

    return { source, size, replaced }
  } finally {
    fs.rmSync(staged, { force: true })
  }
}

// Only when run directly, so backup-daily.js can import the functions above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const die = (message) => {
    console.error(message)
    process.exit(1)
  }

  if (!isBlobEnabled()) {
    die('BLOB_READ_WRITE_TOKEN is not set. Add it to .env, or run `vercel env pull`.')
  }

  const arg = process.argv[2]
  const file = arg ? path.resolve(arg) : latestSnapshot()
  if (!file) die(`No snapshots in ${defaultBackupDir()} — run \`npm run db:snapshot\` first, or pass a file.`)
  if (!fs.existsSync(file)) die(`No such database: ${file}`)

  // The SDK's own errors are already sentences — "Vercel Blob: This store does
  // not exist", "…Access denied" — and a stack trace through its bundle adds
  // nothing to them. Anything else is a bug here and keeps its trace. Matched
  // by class rather than by `name`, which these never set.
  const { BlobError } = await import('@vercel/blob')
  const { size, replaced } = await uploadToBlob(file).catch(error => {
    if (error instanceof BlobError) die(error.message)
    throw error
  })
  if (replaced) {
    const at = replaced.uploadedAt.toISOString()
    console.log(`Replaced blob "${blobKey()}" (${replaced.size} bytes, uploaded ${at}) — kept as "${previousKey()}"`)
  }
  console.log(`Uploaded ${file} (${size} bytes) → blob "${blobKey()}"`)
}
