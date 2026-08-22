// Move the SQLite file between here and the Vercel Blob store by hand.
//
//   npm run db:list               everything in the store, with its pathname
//   npm run db:push [-- <file>]   local file  → blob   (seeding, or a restore)
//   npm run db:pull [-- <file>]   blob        → local  (grab what's deployed)
//   npm run db:info               what the store currently holds at BLOB_DB_KEY
//
// The server does this on its own — it pulls at boot and pushes after writes —
// so this is for the cases it can't cover: putting the first copy in the store,
// pulling production data down to look at, or overwriting a bad state.
//
// Needs BLOB_READ_WRITE_TOKEN (`.env` is loaded, or `vercel env pull`).
import 'dotenv/config'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { blobKey, downloadDbToFile, isBlobEnabled, uploadDbFromFile } from '../../src/server/blobDb.js'
import { dbFilePath } from '../../src/server/db.js'

const [command, fileArg] = process.argv.slice(2)

const die = (message: string): never => {
  console.error(message)
  process.exit(1)
}

if (!isBlobEnabled()) {
  die('BLOB_READ_WRITE_TOKEN is not set. Add it to .env, or run `vercel env pull`.')
}

const push = async (): Promise<void> => {
  const source = path.resolve(fileArg ?? dbFilePath())
  if (!fs.existsSync(source)) die(`No such database: ${source}`)

  // Snapshot rather than upload the file as it sits on disk: the live database
  // may have committed pages still in its WAL, which is a separate file we are
  // not shipping. VACUUM INTO folds them in and writes one consistent copy.
  const snapshot = path.join(os.tmpdir(), `astro-planner-push-${process.pid}.db`)
  fs.rmSync(snapshot, { force: true })
  const database = new Database(source, { readonly: true })
  try {
    database.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`)
  } finally {
    database.close()
  }

  try {
    await uploadDbFromFile(snapshot)
    console.log(`Pushed ${source} (${fs.statSync(snapshot).size} bytes) → blob "${blobKey()}"`)
  } finally {
    fs.rmSync(snapshot, { force: true })
  }
}

const pull = async (): Promise<void> => {
  const target = path.resolve(fileArg ?? dbFilePath())
  // Overwriting the file someone may be running against is not something to do
  // by accident, so say what is about to be replaced.
  if (fs.existsSync(target)) console.log(`Overwriting ${target}`)
  const restored = await downloadDbToFile(target)
  if (!restored) die(`The store holds no database at "${blobKey()}" — nothing to pull.`)
  console.log(`Pulled blob "${blobKey()}" → ${target} (${fs.statSync(target).size} bytes)`)
}

const info = async (): Promise<void> => {
  const { head, BlobNotFoundError } = await import('@vercel/blob')
  try {
    const blob = await head(blobKey())
    console.log(`key        ${blob.pathname}`)
    console.log(`size       ${blob.size} bytes`)
    console.log(`uploaded   ${blob.uploadedAt.toISOString()}`)
    console.log(`etag       ${blob.etag}`)
  } catch (error) {
    if (error instanceof BlobNotFoundError) return console.log(`No database stored at "${blobKey()}" yet.`)
    throw error
  }
}

// Uploads made through the dashboard or `vercel blob put` land under whatever
// pathname they were given — possibly with a random suffix — so the key the
// server reads is not something you can assume. This is how you find it.
const list = async (): Promise<void> => {
  const { list: listBlobs } = await import('@vercel/blob')
  const { blobs } = await listBlobs()
  if (blobs.length === 0) return console.log('The store is empty.')
  console.log(`${blobs.length} blob(s). BLOB_DB_KEY is currently "${blobKey()}".\n`)
  for (const blob of blobs) {
    const marker = blob.pathname === blobKey() ? ' <- BLOB_DB_KEY' : ''
    console.log(`${String(blob.size).padStart(9)}  ${blob.uploadedAt.toISOString()}  ${blob.pathname}${marker}`)
  }
  if (!blobs.some(blob => blob.pathname === blobKey())) {
    console.log(`\nNothing is stored at "${blobKey()}". Set BLOB_DB_KEY to one of the pathnames above,`)
    console.log('or run `npm run db:push` to write the database there.')
  }
}

const commands: Record<string, () => Promise<void>> = { list, push, pull, info }

const run = commands[command ?? '']
if (!run) die(`Usage: tsx deploy/vercel/blob-db.ts <list|push|pull|info> [file]`)

await run()
