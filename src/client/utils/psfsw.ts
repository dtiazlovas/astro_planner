// ── PSFSW scale ──────────────────────────────────────────────────────────────
// PSF Signal Weight is dimensionless — scaling every pixel by k cancels out of
// (ΣF·ΣM̄)/(σ·bg) — so a raw value is comparable with any other value for the
// same target, filter and rig. What it isn't is *readable*: the magnitude
// depends on the field and the sky, so it is shown as a ratio against a
// reference value, the anchor.
//
// The anchor is established once per target+filter, from the median of that
// pair's subs at the time, and then frozen in the database. Recomputing it from
// a growing population — which is what both charts used to do, each with its
// own population — moves every number that was ever shown, so the same sub read
// differently between screens and between sessions. Frozen, `raw / anchor` is
// a number you can compare across months: 1.0 is a typical sub as of the day
// the scale was set, and nothing later redefines it.

import { savePsfswAnchor, type ImportedRecord, type PsfswAnchorRow } from '../api'
import { parseFile, patternToRegex, matchObject, matchFilter } from './filePattern'
import type { ApObject, ApFilter } from '../types'

export const anchorKeyOf = (objectId: number, filterId: number): string => `${objectId}|${filterId}`

/** Upper-middle element — the convention both charts have always used. */
export const medianOf = (values: number[]): number | null => {
  const sorted = values.filter(v => v > 0).sort((a, b) => a - b)
  return sorted.length ? sorted[sorted.length >> 1] : null
}

/** A displayed PSFSW: raw against the pair's frozen anchor, to 3 decimals. */
export const scaleBy = (raw: number, anchor: number): number =>
  Math.round((raw / anchor) * 1000) / 1000

export interface GroupedRecord { psfsw: number | null; fwhm: number | null; time: number; filename: string }

/**
 * Import records grouped by the object+filter their filename parses to, keyed
 * by `anchorKeyOf`, time-ordered. Values stay raw.
 *
 * Every configured pattern is tried per record rather than the first that
 * matches: a greedy pattern can swallow a token like a rotation angle
 * ("nessy_270deg") into the target and miss the real object, while a more
 * specific one parses it correctly. A record counts if any pattern resolves it.
 */
export function groupRecords(
  records: ImportedRecord[],
  objects: ApObject[],
  filters: ApFilter[],
  patterns: string[],
  exclude?: Set<string>,
): Map<string, GroupedRecord[]> {
  const out = new Map<string, GroupedRecord[]>()
  const regexes = patterns.map(p => { try { return patternToRegex(p) } catch { return null } })
    .filter((r): r is RegExp => r !== null)
  for (const rec of records) {
    if (rec.psfsw == null && rec.fwhm == null) continue
    if (exclude?.has(rec.filename)) continue
    for (const rx of regexes) {
      let parsed: ReturnType<typeof parseFile>
      try { parsed = parseFile(rec.filename, rx) } catch { continue }
      if (!parsed) continue
      const obj = matchObject(parsed.target, objects)
      const filt = matchFilter(parsed.filter, filters)
      if (!obj || !filt) continue
      const key = anchorKeyOf(obj.id, filt.id)
      const entry = { psfsw: rec.psfsw, fwhm: rec.fwhm, time: parsed.datetime.getTime(), filename: rec.filename }
      const list = out.get(key)
      if (list) list.push(entry); else out.set(key, [entry])
      break
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.time - b.time)
  return out
}

export type AnchorMap = Map<string, PsfswAnchorRow>

export const toAnchorMap = (rows: PsfswAnchorRow[]): AnchorMap =>
  new Map(rows.map(r => [anchorKeyOf(r.object, r.filter), r]))

/**
 * The anchor in force for a pair, establishing one from `candidates` (raw
 * values) if the pair has none yet.
 *
 * Returns null only when there is nothing to measure — a first-light group with
 * no analysis at all. The server keeps the first anchor written, so a screen
 * that loses the race adopts the winner's scale rather than its own.
 */
export async function ensureAnchor(
  anchors: AnchorMap,
  objectId: number,
  filterId: number,
  candidates: number[],
): Promise<PsfswAnchorRow | null> {
  const key = anchorKeyOf(objectId, filterId)
  const existing = anchors.get(key)
  if (existing) return existing
  const median = medianOf(candidates)
  if (median == null) return null
  try {
    const row = await savePsfswAnchor(objectId, filterId, median, candidates.filter(v => v > 0).length)
    anchors.set(key, row)
    return row
  } catch {
    return null
  }
}
