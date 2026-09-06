// Vercel Blob as the durable home for the SQLite file. Object storage has no
// partial read or write, so the whole file is pulled at boot and pushed after
// each write — workable only at under a megabyte with one writer (see
// uploadDbFromFile for what happens when there isn't). Inert without
// BLOB_READ_WRITE_TOKEN.
import fs from 'node:fs'
import path from 'node:path'

// Lazy so disk-backed deployments never install or parse the SDK to boot.
const sdk = async () => import('@vercel/blob')

export const isBlobEnabled = (): boolean => Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim())

export const blobKey = (): string => process.env.BLOB_DB_KEY?.trim() || 'astro_planner.db'

// Must match how the store was created: a private store rejects reads issued as
// 'public' and vice versa.
const blobAccess = (): 'public' | 'private' =>
  process.env.BLOB_DB_ACCESS?.trim() === 'public' ? 'public' : 'private'

// Sent as `ifMatch` on upload, so a snapshot can't land on a copy we haven't seen.
let knownEtag: string | null = null

export const remoteEtag = (): string | null => knownEtag

// Sidecars belong to the file they were created from; left beside a freshly
// downloaded one they replay an unrelated log over it.
const dropSidecars = (dbFile: string): void => {
  for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(`${dbFile}${suffix}`, { force: true })
}

/** Headers only, so it is cheap enough for a per-request freshness check. */
export const remoteVersion = async (): Promise<string | null> => {
  const { head, BlobNotFoundError } = await sdk()
  try {
    return (await head(blobKey())).etag
  } catch (error) {
    if (error instanceof BlobNotFoundError) return null
    throw error
  }
}

/** False when the store holds no database yet — a first boot, not an error. */
export const downloadDbToFile = async (target: string): Promise<boolean> => {
  const { get, BlobNotFoundError } = await sdk()

  let result
  try {
    // useCache: false — a stale read means starting from data already superseded.
    result = await get(blobKey(), { access: blobAccess(), useCache: false })
  } catch (error) {
    if (error instanceof BlobNotFoundError) return false
    throw error
  }
  if (!result || result.statusCode !== 200) return false

  // Not Readable.fromWeb: its signature only matches Node's ReadableStream, and
  // a build with the DOM lib in scope resolves the SDK's stream to the DOM one
  // and refuses to compile.
  const chunks: Uint8Array[] = []
  const reader = result.stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }

  // Renamed into place, so an interrupted transfer leaves the previous database
  // intact rather than a truncated one.
  const partial = `${target}.download`
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(partial, Buffer.concat(chunks))
  dropSidecars(target)
  fs.renameSync(partial, target)

  knownEtag = result.blob.etag
  return true
}

/**
 * Push `file` to the store, conditional on the version we last saw. A mismatch
 * means another instance wrote and one copy has to lose, so the remote one is
 * kept under a `.conflict-<timestamp>` key before this overwrites it.
 */
export const uploadDbFromFile = async (file: string): Promise<void> => {
  const { put, copy, BlobPreconditionFailedError } = await sdk()
  const body = fs.readFileSync(file)
  const options = {
    access: blobAccess(),
    // One mutable document under a stable key, not a versioned upload.
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/vnd.sqlite3',
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
