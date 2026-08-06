// Vercel Blob as the durable home for the SQLite file.
//
// Blob is object storage, not a database: there is no partial read and no
// partial write, so the unit of transfer is the whole file. The server pulls it
// once at boot and pushes a fresh snapshot after each write. That is workable
// here because the database is under a megabyte and the app has one writer;
// see the concurrency note on uploadDbFromFile for what happens when it doesn't.
//
// Everything is inert unless BLOB_READ_WRITE_TOKEN is set, so local dev and the
// Render disk deployment behave exactly as before and never load the SDK.
import fs from 'node:fs'
import path from 'node:path'

// The SDK is imported lazily rather than at module scope: it requires Node 20+
// and is irrelevant to the disk-backed deployments, which should not have to
// install or parse it just to boot.
const sdk = async () => import('@vercel/blob')

export const isBlobEnabled = (): boolean => Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim())

// Matches the file as it sits in the store today. The store is dedicated to this
// app, so the database lives at the root rather than under a prefix.
export const blobKey = (): string => process.env.BLOB_DB_KEY?.trim() || 'astro_planner.db'

// Must match how the store itself was created — a private store rejects reads
// issued as 'public' and vice versa. Private is the default because the blob is
// the whole database, and a public blob is readable by anyone with the URL.
const blobAccess = (): 'public' | 'private' =>
  process.env.BLOB_DB_ACCESS?.trim() === 'public' ? 'public' : 'private'

// The version our local file was built from. Sent as `ifMatch` on upload so a
// snapshot can never silently land on top of a copy we have not seen.
let knownEtag: string | null = null

export const remoteEtag = (): string | null => knownEtag

// Enough state to answer "is this actually working?" from outside the process,
// which on a serverless host is the only way to ask. See /api/health.
let lastUploadAt: string | null = null
let lastError: string | null = null

export const blobActivity = (): { lastUploadAt: string | null; lastError: string | null } =>
  ({ lastUploadAt, lastError })

// SQLite keeps recovery state in sidecar files next to the database. They belong
// to the file they were created from, so leaving them beside a freshly
// downloaded one would replay an unrelated log over it — corruption, not a
// stale read. Always clear them when the main file is replaced wholesale.
const dropSidecars = (dbFile: string): void => {
  for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(`${dbFile}${suffix}`, { force: true })
}

/**
 * Pull the stored database into `target`, replacing whatever is there.
 * Returns false when the store holds no database yet — a first boot, not an error.
 */
export const downloadDbToFile = async (target: string): Promise<boolean> => {
  const { get, BlobNotFoundError } = await sdk()

  let result
  try {
    // useCache: false — the CDN is fine for assets, but reading a stale database
    // would mean starting from data we have already superseded.
    result = await get(blobKey(), { access: blobAccess(), useCache: false })
  } catch (error) {
    if (error instanceof BlobNotFoundError) return false
    throw error
  }
  if (!result || result.statusCode !== 200) return false

  // Read the web stream directly rather than adapting it with Readable.fromWeb:
  // that helper's signature only matches Node's own ReadableStream type, and a
  // build that has the DOM lib in scope (which a Vercel function can) resolves
  // the SDK's stream to the DOM one and refuses to compile. The whole file is
  // held in memory either way — uploads already do, and it is under a megabyte.
  const chunks: Uint8Array[] = []
  const reader = result.stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }

  // Written beside the target and renamed into place, so an interrupted transfer
  // leaves the previous database intact rather than a truncated one.
  const partial = `${target}.download`
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(partial, Buffer.concat(chunks))
  dropSidecars(target)
  fs.renameSync(partial, target)

  knownEtag = result.blob.etag
  return true
}

/**
 * Push `file` to the store as the current database.
 *
 * The upload is conditional on the version we last saw. A mismatch means
 * another instance wrote in the meantime — the file we are holding was branched
 * off an older copy, and one of the two is going to lose. Rather than pick
 * silently, the remote copy is preserved under a `.conflict-<timestamp>` key
 * before this one overwrites it, so nothing is destroyed and either side can be
 * recovered by hand.
 */
export const uploadDbFromFile = async (file: string): Promise<void> => {
  try {
    await writeToBlob(file)
    lastUploadAt = new Date().toISOString()
    lastError = null
  } catch (error) {
    lastError = `${new Date().toISOString()} ${error instanceof Error ? error.message : String(error)}`
    throw error
  }
}

const writeToBlob = async (file: string): Promise<void> => {
  const { put, copy, BlobPreconditionFailedError } = await sdk()
  const body = fs.readFileSync(file)
  const options = {
    access: blobAccess(),
    // A stable key: this is one mutable document, not a versioned upload, and
    // the reader has to be able to find it by name.
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/vnd.sqlite3',
    // The database changes on every write; a cached copy is a wrong copy.
    cacheControlMaxAge: 0,
  } as const

  try {
    const result = await put(blobKey(), body, knownEtag ? { ...options, ifMatch: knownEtag } : options)
    knownEtag = result.etag
    return
  } catch (error) {
    if (!(error instanceof BlobPreconditionFailedError)) throw error
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const conflictKey = `${blobKey()}.conflict-${stamp}`
  await copy(blobKey(), conflictKey, { access: blobAccess(), addRandomSuffix: false })
  console.warn(
    `Blob DB: the stored database changed under us — another instance is writing. ` +
    `Its copy was kept as "${conflictKey}"; this instance's copy is now current.`
  )

  const result = await put(blobKey(), body, options)
  knownEtag = result.etag
}
