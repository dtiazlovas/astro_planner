import {
  getObjectSessionsForObject, updateObjectSession, deleteObjectSession, createObjectSession,
  createSession, recordImported, removeImported, getPlans, setPlanSession,
  type ImportedRecord,
} from '../api'
import { parseFile, patternToRegex, matchObject, matchFilter, matchExposure, dateKey, toDatetimeLocal, type ParsedFile } from './filePattern'
import type { ApObject, ApObjectSession, ApFilter, ApExposure, ApSession } from '../types'

// ── Object file sync ─────────────────────────────────────────────────────────
// Makes an object's DB stats reflect the files actually present in its folder.
// Every attributable disk file is assigned to an (observing date, filter,
// exposure) slot via the filename patterns — the same rules import uses — and
// each of the object's session entries is recounted to the number of unique
// subs on disk for its slot. That includes:
//   • entries whose files were deleted → frames reduced or entry removed,
//     even when the files predate per-file import tracking;
//   • files never registered → entries/sessions created, records added;
//   • stale import records (file gone) → removed.
// Matching ignores the extension and `_`-separated suffix segments appended by
// processing tools ("..._0001_a.xisf"), and original + derived copies of the
// same sub count once. Only entries of the active rig's sessions are touched.

const stem = (name: string) => name.replace(/\.[^.]+$/, '').toLowerCase()

// Strips one trailing "_<alpha...>" processing suffix ("_a", "_cal", …).
// Numeric segments are left alone — those are frame numbers.
const stripSuffix = (s: string) => s.replace(/_[a-z][a-z0-9]*$/, '')

const baseStem = (s: string): string => {
  while (true) {
    const t = stripSuffix(s)
    if (t === s) return s
    s = t
  }
}

// A filename can parse under several patterns with different targets — e.g. a
// rotation token ("_90deg_") swallowed into the target by a pattern without
// the wildcard. Collect every candidate parse instead of the first match, so
// the caller can pick the one that actually resolves to the object.
const parseCandidates = (filename: string, regexes: RegExp[]): ParsedFile[] => {
  const out: ParsedFile[] = []
  for (const rx of regexes) {
    try {
      const r = parseFile(filename, rx)
      if (r) out.push(r)
    } catch {}
  }
  return out
}

export interface SyncChange {
  dateKey: string
  sessionId: number | null      // null → a session is created on apply
  sessionName: string
  filterId: number
  filterName: string
  exposureId: number
  duration: number
  diskFiles: number             // unique subs on disk for this slot
  addFiles: string[]            // unregistered files → import records created
  missingFiles: string[]        // stale import records → removed
  entryIds: number[]            // existing session entries for this slot
  currentFrames: number         // sum over those entries
  newFrames: number             // = diskFiles
  earliestTime: Date | null
}

export interface SyncScanResult {
  presentCount: number    // files in the object folder
  recordedCount: number   // import records parsed to this object
  missingCount: number    // recorded but no longer present
  addCount: number        // present but not recorded
  changes: SyncChange[]
  unadjustable: string[]  // stale records that fit no slot — removed, stats untouched
  unattributable: number  // present files matching no pattern/this object (e.g. masters) — ignored
  // Unique attributable subs on disk (one file per sub), with the capture time
  // and filter parsed from the filename — the input for quality analysis,
  // which runs per filter since quality scales differ between filters.
  analyzableFiles: { name: string; time: number; filterId: number; filterName: string }[]
}

export async function scanObjectFiles(
  obj: ApObject,
  allObjects: ApObject[],
  presentFileNames: string[],
  imported: ImportedRecord[],
  filters: ApFilter[],
  exposures: ApExposure[],
  patterns: string[],
  sessions: ApSession[],
  dayStartHour: number,
  equipment: number | null,
): Promise<SyncScanResult> {
  const presentStems = presentFileNames.map(stem)
  const presentSet = new Set(presentStems)
  // Processing tools keep the original name and append suffix segments
  // (e.g. "..._0001_a.xisf" from calibration) — count those as present too.
  const isPresent = (recordStem: string) =>
    presentSet.has(recordStem) || presentStems.some(s => s.startsWith(recordStem + '_'))

  const patternRegexes = patterns.map(p => { try { return patternToRegex(p) } catch { return null } })
    .filter((r): r is RegExp => r !== null)
  // For disk files the extension may have changed and suffixes may be appended,
  // so parse them with the pattern's extension replaced by a tolerant tail.
  const tolerantRegexes = patterns.map(p => {
    try {
      const base = p.replace(/\.[A-Za-z0-9]+$/, '')
      return new RegExp(patternToRegex(base).source + '(?:_[a-z][a-z0-9]*)*\\.[a-z0-9]+$', 'i')
    } catch { return null }
  }).filter((r): r is RegExp => r !== null)

  const recordStems = new Set(imported.map(r => stem(r.filename)))
  const isRegistered = (diskStem: string): boolean => {
    let s = diskStem
    while (true) {
      if (recordStems.has(s)) return true
      const t = stripSuffix(s)
      if (t === s) return false
      s = t
    }
  }

  // Slot bookkeeping: one slot per (observing date, filter, exposure).
  interface Slot {
    dateKey: string
    filterId: number
    filterName: string
    exposureId: number
    duration: number
    disk: number
    addFiles: string[]
    missingFiles: string[]
    earliest: Date | null
  }
  const slots = new Map<string, Slot>()
  const slotFor = (dk: string, filterId: number, filterName: string, exposureId: number, duration: number): Slot => {
    const key = `${dk}|${filterId}|${exposureId}`
    let s = slots.get(key)
    if (!s) {
      s = { dateKey: dk, filterId, filterName, exposureId, duration, disk: 0, addFiles: [], missingFiles: [], earliest: null }
      slots.set(key, s)
    }
    return s
  }

  // ── 1. Attribute every disk file to a slot (unique subs only) ─────────────
  let unattributable = 0
  const seenBases = new Set<string>()
  const analyzableFiles: { name: string; time: number; filterId: number; filterName: string }[] = []
  for (const fileName of presentFileNames) {
    const p = parseCandidates(fileName, tolerantRegexes).find(c => matchObject(c.target, allObjects)?.id === obj.id)
    const filt = p ? matchFilter(p.filter, filters) : null
    const exp = p ? matchExposure(p.duration, exposures) : null
    if (!p || !filt || !exp) { unattributable++; continue }
    const base = baseStem(stem(fileName))
    if (seenBases.has(base)) continue // original + derived copy of the same sub
    seenBases.add(base)
    analyzableFiles.push({ name: fileName, time: p.datetime.getTime(), filterId: filt.id, filterName: filt.name ?? p.filter })
    const slot = slotFor(dateKey(p.datetime, dayStartHour), filt.id, filt.name ?? p.filter, exp.id, exp.duration)
    slot.disk++
    if (slot.earliest === null || p.datetime < slot.earliest) slot.earliest = p.datetime
    if (!isRegistered(stem(fileName))) slot.addFiles.push(fileName)
  }

  // ── 2. Import records: find stale ones, attributed by filename date ───────
  let recordedCount = 0
  let missingCount = 0
  const unadjustable: string[] = []
  for (const rec of imported) {
    const p = parseCandidates(rec.filename, patternRegexes).find(c => matchObject(c.target, allObjects)?.id === obj.id)
    if (!p) continue
    recordedCount++
    if (isPresent(stem(rec.filename))) continue
    missingCount++
    const filt = matchFilter(p.filter, filters)
    const exp = matchExposure(p.duration, exposures)
    if (!filt || !exp) { unadjustable.push(rec.filename); continue }
    slotFor(dateKey(p.datetime, dayStartHour), filt.id, filt.name ?? p.filter, exp.id, exp.duration).missingFiles.push(rec.filename)
  }

  // ── 3. Existing session entries of this object (active rig only) ──────────
  const sessionById = new Map(sessions.map(s => [s.id, s]))
  const entries = (await getObjectSessionsForObject(obj.id)).filter(r => {
    const s = sessionById.get(r.session)
    return s !== undefined && (equipment == null || s.equipment === equipment)
  })
  const entriesByKey = new Map<string, ApObjectSession[]>()
  for (const r of entries) {
    const s = sessionById.get(r.session)!
    const dk = dateKey(new Date(s.start), dayStartHour)
    // Materialize the slot even with zero disk files, so orphaned entries
    // (no files, no records) are recounted to reality as well.
    slotFor(dk, r.filter, r.filter_name ?? String(r.filter), r.exposure, r.exposure_duration)
    const key = `${dk}|${r.filter}|${r.exposure}`
    entriesByKey.set(key, [...(entriesByKey.get(key) ?? []), r])
  }

  // This rig's session per observing date, exactly like import.
  const rigSessions = sessions.filter(s => equipment == null || s.equipment === equipment)
  const sessionByDate = new Map<string, ApSession>()
  for (const s of rigSessions) {
    const dk = dateKey(new Date(s.start), dayStartHour)
    if (!sessionByDate.has(dk)) sessionByDate.set(dk, s)
  }

  // ── 4. Emit a change for every slot that differs from disk ────────────────
  const changes: SyncChange[] = []
  for (const [key, slot] of slots) {
    const rows = entriesByKey.get(key) ?? []
    const currentFrames = rows.reduce((n, r) => n + r.frames, 0)
    if (currentFrames === slot.disk && slot.addFiles.length === 0 && slot.missingFiles.length === 0) continue
    // Prefer the entry's own session; else this rig's session for the date.
    const session = (rows.length ? sessionById.get(rows[0].session) : undefined) ?? sessionByDate.get(slot.dateKey) ?? null
    const dk = slot.dateKey
    changes.push({
      dateKey: dk,
      sessionId: session?.id ?? null,
      sessionName: session?.name ?? `${dk.slice(0, 4)}-${dk.slice(4, 6)}-${dk.slice(6, 8)}`,
      filterId: slot.filterId,
      filterName: slot.filterName,
      exposureId: slot.exposureId,
      duration: slot.duration,
      diskFiles: slot.disk,
      addFiles: slot.addFiles,
      missingFiles: slot.missingFiles,
      entryIds: rows.map(r => r.id),
      currentFrames,
      newFrames: slot.disk,
      earliestTime: slot.earliest,
    })
  }
  changes.sort((a, b) => a.sessionName.localeCompare(b.sessionName) || a.filterName.localeCompare(b.filterName))

  return {
    presentCount: presentFileNames.length,
    recordedCount,
    missingCount,
    addCount: changes.reduce((n, c) => n + c.addFiles.length, 0),
    changes,
    unadjustable,
    unattributable,
    analyzableFiles,
  }
}

export interface SyncApplyResult {
  adjusted: number       // changes applied
  failedGroups: number   // changes that failed (records kept for retry)
  removedRecords: number
  addedFiles: number
  createdSessions: number
}

// Each change is applied independently, and import records are only removed
// for changes that succeeded — a failure never strands the others.
export async function applyObjectSync(obj: ApObject, scan: SyncScanResult, equipment: number | null): Promise<SyncApplyResult> {
  const removeNames: string[] = [...scan.unadjustable]
  let adjusted = 0
  let failedGroups = 0
  let addedFiles = 0
  let createdSessions = 0

  // New entries join the object's single active plan, as import does.
  let planId: number | null = null
  if (scan.changes.some(c => c.entryIds.length === 0 && c.newFrames > 0)) {
    try {
      const active = (await getPlans(obj.id)).filter(p => p.active)
      if (active.length === 1) planId = active[0].id
    } catch {}
  }

  const createdSessionByDate = new Map<string, number>()
  for (const c of scan.changes) {
    try {
      let sessionId = c.sessionId ?? createdSessionByDate.get(c.dateKey) ?? null
      if (sessionId == null && (c.newFrames > 0 || c.addFiles.length > 0)) {
        const created = await createSession({
          name: c.sessionName, start: toDatetimeLocal(c.earliestTime ?? new Date()),
          duration: null, duration_set: false, comment: 'Created by file sync',
          equipment,
        })
        sessionId = created.id
        createdSessionByDate.set(c.dateKey, sessionId)
        createdSessions++
      }

      if (c.entryIds.length > 0) {
        if (c.newFrames > 0) {
          if (c.currentFrames !== c.newFrames || c.entryIds.length > 1) {
            await updateObjectSession(c.entryIds[0], { frames: c.newFrames })
            for (const extra of c.entryIds.slice(1)) await deleteObjectSession(extra)
          }
        } else {
          for (const id of c.entryIds) await deleteObjectSession(id)
        }
      } else if (c.newFrames > 0 && sessionId != null) {
        const created = await createObjectSession({ session: sessionId, object: obj.id, filter: c.filterId, exposure: c.exposureId, frames: c.newFrames })
        if (planId) { try { await setPlanSession({ session: created.id, planid: planId }) } catch {} }
      }

      if (c.addFiles.length && sessionId != null) {
        await recordImported(c.addFiles, sessionId)
        addedFiles += c.addFiles.length
      }
      removeNames.push(...c.missingFiles)
      adjusted++
    } catch {
      failedGroups++
    }
  }

  let removedRecords = 0
  if (removeNames.length) removedRecords = (await removeImported(removeNames)).removed
  return { adjusted, failedGroups, removedRecords, addedFiles, createdSessions }
}
