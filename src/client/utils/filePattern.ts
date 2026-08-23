import type { ApObject, ApFilter, ApExposure } from '../types'

const BASE = '/api'

export const DEFAULT_PATTERN = 'Light_{target}_*_{duration}.0s_Bin1_{filter}_{short_datetime}_{filenumber}.fit'
const SETTING_KEY = 'file_pattern'
const DAY_START_HOUR_KEY = 'day_start_hour'

export const PLACEHOLDER_DOCS: Record<string, string> = {
  target: 'Object / target name',
  duration: 'Exposure duration in seconds (digits only, no unit)',
  filter: 'Filter name',
  short_datetime: 'Date + time (e.g. 20260607_220415)',
  filenumber: 'Frame sequence number',
}

export interface ParsedFile {
  target: string
  duration: number
  filter: string
  datetime: Date
  rawName: string
}

export async function fetchPattern(): Promise<string> {
  try {
    const res = await fetch(`${BASE}/settings/${SETTING_KEY}`)
    if (res.ok) {
      const data = await res.json() as { value: string | null }
      return data.value?.split('\n')[0]?.trim() ?? DEFAULT_PATTERN
    }
  } catch {}
  return DEFAULT_PATTERN
}

export async function savePattern(value: string): Promise<void> {
  await fetch(`${BASE}/settings/${SETTING_KEY}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  })
}

export async function fetchPatterns(): Promise<string[]> {
  try {
    const res = await fetch(`${BASE}/settings/${SETTING_KEY}`)
    if (res.ok) {
      const data = await res.json() as { value: string | null }
      if (data.value) {
        const parts = data.value.split('\n').map(s => s.trim()).filter(Boolean)
        if (parts.length) return parts
      }
    }
  } catch {}
  return [DEFAULT_PATTERN]
}

export async function savePatterns(patterns: string[]): Promise<void> {
  await fetch(`${BASE}/settings/${SETTING_KEY}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: patterns.join('\n') }),
  })
}

export function parseFileMulti(filename: string, patterns: string[]): ParsedFile | null {
  for (const pattern of patterns) {
    try {
      const r = parseFile(filename, patternToRegex(pattern))
      if (r) return r
    } catch {}
  }
  return null
}

export function getPatternAcceptMulti(patterns: string[]): string {
  const exts = [...new Set(patterns.map(getPatternAccept).filter(e => e !== '*'))]
  return exts.length ? exts.join(',') : '*'
}

export async function fetchDayStartHour(): Promise<number> {
  try {
    const res = await fetch(`${BASE}/settings/${DAY_START_HOUR_KEY}`)
    if (res.ok) {
      const data = await res.json() as { value: string | null }
      const v = parseInt(data.value ?? '', 10)
      if (!isNaN(v) && v >= 0 && v <= 23) return v
    }
  } catch {}
  return 16
}

export async function saveDayStartHour(hour: number): Promise<void> {
  await fetch(`${BASE}/settings/${DAY_START_HOUR_KEY}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: String(hour) }),
  })
}


export function patternToRegex(pattern: string): RegExp {
  const parts = pattern.split(/(\{[^}]+\})/)
  let rx = ''
  for (const part of parts) {
    const m = part.match(/^\{(\w+)\}$/)
    if (m) {
      const name = m[1]
      if (name === 'duration') rx += `(?<duration>[\\d.]+)`
      else if (name === 'short_datetime') rx += `(?<short_datetime>[\\d_T:+-]+)`
      else if (name === 'filenumber') rx += `(?<filenumber>\\d+)`
      else rx += `(?<${name}>.+?)`
    } else {
      // Split on * (glob wildcard) and escape the literal pieces between them
      rx += part.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*?')
    }
  }
  return new RegExp(rx, 'i')
}

export function parseDatetime(dt: string): Date | null {
  const c = dt.replace(/\D/g, '')
  if (c.length < 8) return null
  const y = +c.slice(0, 4), mo = +c.slice(4, 6) - 1, d = +c.slice(6, 8)
  const h = c.length >= 10 ? +c.slice(8, 10) : 0
  const mi = c.length >= 12 ? +c.slice(10, 12) : 0
  const s = c.length >= 14 ? +c.slice(12, 14) : 0
  const date = new Date(y, mo, d, h, mi, s)
  return isNaN(date.getTime()) ? null : date
}

export function parseFile(filename: string, regex: RegExp): ParsedFile | null {
  const m = filename.match(regex)
  if (!m?.groups) return null
  const { target, duration, filter, short_datetime } = m.groups
  if (!target || !duration || !filter || !short_datetime) return null
  const datetime = parseDatetime(short_datetime)
  if (!datetime) return null
  return {
    target: target.replace(/_/g, ' ').trim(),
    duration: parseFloat(duration),
    filter: filter.replace(/_/g, ' ').trim(),
    datetime,
    rawName: filename,
  }
}

// ── Pattern inference ────────────────────────────────────────────────────────
// Reads a real filename and proposes the pattern that would parse it, so a new
// user can point at one of their own subs instead of writing placeholder
// syntax. Every guess is shown for acceptance before anything is saved — the
// rules below are heuristics, and the one thing they must never do is quietly
// produce a pattern that mis-reads a night.

export type PatternFieldKind = 'target' | 'duration' | 'filter' | 'short_datetime' | 'filenumber'

export const PATTERN_FIELD_ORDER: PatternFieldKind[] = ['target', 'duration', 'filter', 'short_datetime', 'filenumber']

// parseFile() needs these four; a pattern without them can't import anything.
export const REQUIRED_PATTERN_FIELDS: PatternFieldKind[] = ['target', 'duration', 'filter', 'short_datetime']

export interface InferredField {
  kind: PatternFieldKind
  /** The text exactly as it appears in the name. */
  text: string
  /** That text spelled out — what the accept/reject list shows. */
  display: string
  from: number       // first segment this field covers
  to: number         // last segment it covers (inclusive; datetimes can span two)
  /** Literal tail kept outside the token, e.g. the "s" of "300s". */
  suffix: string
}

export interface PatternInference {
  fileName: string
  parts: string[]       // name segments, split on _ and whitespace
  seps: string[]        // seps[i] is the separator that followed parts[i]
  extension: string
  fields: InferredField[]
  /** Segments that differ across the selected files — wildcards, not literals. */
  wildcards: number[]
  sampleCount: number
}

const FRAME_TYPE_WORDS = /^(light|dark|flat|bias|dark ?flat|master|stack|calibrated|cal|registered|reg)$/i
const BINNING_WORD = /^bin\d+$/i

// Splits a name into segments and the separators between them. '-' is left
// inside segments: it separates the halves of "20260822-131045" but it is also
// part of target names like "Sh2-155", and keeping it costs nothing — the
// datetime rule reads through it.
const splitName = (fileName: string): { parts: string[]; seps: string[]; extension: string } => {
  const dot = fileName.lastIndexOf('.')
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName
  const extension = dot > 0 ? fileName.slice(dot) : ''
  const raw = stem.split(/([_\s]+)/)
  const parts: string[] = []
  const seps: string[] = []
  for (let i = 0; i < raw.length; i += 2) {
    parts.push(raw[i])
    seps.push(raw[i + 1] ?? '')
  }
  return { parts, seps, extension }
}

const digitsOf = (s: string) => s.replace(/\D/g, '')
const isDateish = (s: string) => /^[\d\-T:.+]+$/.test(s)

// hhmm / hhmmss, as a clock actually reads.
const validTime = (digits: string): boolean =>
  (digits.length === 4 || digits.length === 6) &&
  +digits.slice(0, 2) <= 23 && +digits.slice(2, 4) <= 59 &&
  (digits.length === 4 || +digits.slice(4, 6) <= 59)

const plausibleDate = (digits: string): Date | null => {
  if (digits.length !== 8 && digits.length !== 12 && digits.length !== 14) return null
  const year = +digits.slice(0, 4)
  if (year < 1990 || year > 2100) return null
  if (digits.length > 8 && !validTime(digits.slice(8))) return null
  const d = parseDatetime(digits)
  // A date that rolled over (month 13, day 32) came out of a number that only
  // looked like a date.
  if (!d || d.getFullYear() !== year || d.getMonth() + 1 !== +digits.slice(4, 6)) return null
  return d
}

/**
 * Propose a pattern for `fileNames[0]`, using any further names only to tell
 * which unrecognised segments vary (wildcards) and which are fixed text.
 *
 * `objects` and `filters` are what the guesses for target and filter are drawn
 * from — matching against the user's own library beats guessing by position,
 * which is why this takes them rather than working on the name alone.
 */
export function inferPattern(fileNames: string[], objects: ApObject[], filters: ApFilter[]): PatternInference | null {
  if (!fileNames.length) return null
  const fileName = fileNames[0]
  const { parts, seps, extension } = splitName(fileName)
  if (!parts.length) return null

  const fields: InferredField[] = []
  const used = new Set<number>()
  const claim = (f: InferredField) => {
    fields.push(f)
    for (let i = f.from; i <= f.to; i++) used.add(i)
  }

  // 1. Date/time — the most distinctive thing in a sub's name, so it goes
  //    first and stops the frame number rule from eating an 8-digit date.
  //    The last plain run of digits in a name is where a frame number lives, so
  //    a short one there is left alone rather than read as a time: "…_0001" is
  //    frame 1, not one minute past midnight.
  const lastDigitSeg = parts.reduce((last, p, i) => /^\d+$/.test(p) ? i : last, -1)
  for (let i = 0; i < parts.length; i++) {
    if (used.has(i) || !isDateish(parts[i])) continue
    const own = digitsOf(parts[i])
    // A date segment followed by a separate time segment ("20260822_131045").
    // Tried before the date alone, or the time would be dropped on the floor.
    if (own.length === 8 && i + 1 < parts.length && /^\d{4,6}$/.test(parts[i + 1])) {
      const next = parts[i + 1]
      const timeLike = next.length === 6 || (validTime(next) && i + 1 !== lastDigitSeg)
      const paired = timeLike ? plausibleDate(own + next.padEnd(6, '0')) : null
      if (paired) {
        claim({ kind: 'short_datetime', text: `${parts[i]}${seps[i]}${next}`, display: paired.toLocaleString(), from: i, to: i + 1, suffix: '' })
        break
      }
    }
    const whole = plausibleDate(own)
    if (whole) { claim({ kind: 'short_datetime', text: parts[i], display: whole.toLocaleString(), from: i, to: i, suffix: '' }); break }
  }

  // 2. Duration — only the unit-suffixed form. A bare number is indis-
  //    tinguishable from a frame count, and guessing wrong here silently
  //    misreports every night's integration.
  for (let i = 0; i < parts.length; i++) {
    if (used.has(i)) continue
    const m = parts[i].match(/^(\d+(?:\.\d+)?)(s|sec|secs)$/i)
    if (!m) continue
    claim({ kind: 'duration', text: parts[i], display: `${parseFloat(m[1])} s`, from: i, to: i, suffix: m[2] })
    break
  }

  // 3. Filter — matched against the filters already configured, names and
  //    aliases alike. Nothing else in a name is reliably a filter.
  for (let i = 0; i < parts.length; i++) {
    if (used.has(i)) continue
    const f = matchFilter(parts[i], filters)
    if (!f) continue
    claim({ kind: 'filter', text: parts[i], display: f.name ?? parts[i], from: i, to: i, suffix: '' })
    break
  }

  // 4. Target — a known object first, over spans of up to three segments so a
  //    name broken up by separators ("M_31") still lands. Failing that, the
  //    first segment that isn't a frame type, a binning tag or a number.
  outer: for (let span = 3; span >= 1; span--) {
    for (let i = 0; i + span - 1 < parts.length; i++) {
      const to = i + span - 1
      let free = true
      for (let k = i; k <= to; k++) if (used.has(k)) free = false
      if (!free) continue
      const text = parts.slice(i, to + 1).join('_')
      const obj = matchObject(text, objects)
      if (!obj) continue
      claim({ kind: 'target', text, display: obj.name, from: i, to, suffix: '' })
      break outer
    }
  }
  if (!fields.some(f => f.kind === 'target')) {
    for (let i = 0; i < parts.length; i++) {
      if (used.has(i) || !parts[i]) continue
      if (FRAME_TYPE_WORDS.test(parts[i]) || BINNING_WORD.test(parts[i]) || /^\d+$/.test(parts[i])) continue
      claim({ kind: 'target', text: parts[i], display: parts[i].replace(/_/g, ' '), from: i, to: i, suffix: '' })
      break
    }
  }

  // 5. Frame number — the last plain run of digits left over.
  for (let i = parts.length - 1; i >= 0; i--) {
    if (used.has(i) || !/^\d{1,6}$/.test(parts[i])) continue
    claim({ kind: 'filenumber', text: parts[i], display: parts[i], from: i, to: i, suffix: '' })
    break
  }

  // Segments that differ between the selected files are the ones that vary
  // from frame to frame — a rotation tag, a session code — so they become
  // wildcards rather than literals nailing the pattern to one night. With a
  // single file there is nothing to compare, and everything unknown stays
  // literal, which the panel says out loud.
  const wildcards: number[] = []
  const others = fileNames.slice(1).map(splitName).filter(o => o.parts.length === parts.length)
  if (others.length) {
    for (let i = 0; i < parts.length; i++) {
      if (used.has(i)) continue
      if (others.some(o => o.parts[i].toLowerCase() !== parts[i].toLowerCase())) wildcards.push(i)
    }
  }

  fields.sort((a, b) => a.from - b.from)
  return { fileName, parts, seps, extension, fields, wildcards, sampleCount: fileNames.length }
}

/** Renders the inference as a pattern, keeping only the accepted fields. */
export function buildPattern(inf: PatternInference, accepted: Iterable<PatternFieldKind>): string {
  const keep = new Set(accepted)
  const fieldAt = new Map<number, InferredField>()
  for (const f of inf.fields) if (keep.has(f.kind)) fieldAt.set(f.from, f)

  let out = ''
  let i = 0
  while (i < inf.parts.length) {
    const f = fieldAt.get(i)
    const end = f ? f.to : i
    out += f
      ? `{${f.kind}}${f.suffix}`
      : inf.wildcards.includes(i) ? '*' : inf.parts[i]
    if (end < inf.parts.length - 1) out += inf.seps[end] || '_'
    i = end + 1
  }
  return out + inf.extension
}

export function dateKey(d: Date, dayStartHour = 0): string {
  const adjusted = dayStartHour > 0 ? new Date(d.getTime() - dayStartHour * 3600000) : d
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${adjusted.getFullYear()}${pad(adjusted.getMonth() + 1)}${pad(adjusted.getDate())}`
}

export function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function getPatternAccept(pattern: string): string {
  const withoutPlaceholders = pattern.replace(/\{[^}]+\}/g, 'X').replace(/\*/g, 'X')
  const lastDot = withoutPlaceholders.lastIndexOf('.')
  if (lastDot === -1) return '*'
  const ext = withoutPlaceholders.slice(lastDot + 1)
  if (/^[a-z0-9]+$/i.test(ext)) return `.${ext}`
  return '*'
}

const norm = (s: string) => s.toLowerCase().replace(/[_\s-]+/g, '').replace(/[^a-z0-9]/g, '')

export function matchObject(target: string, objects: ApObject[]): ApObject | null {
  const nt = norm(target)
  for (const obj of objects) {
    if (norm(obj.name) === nt) return obj
    if (obj.aliases) {
      for (const a of obj.aliases.split(';')) {
        if (norm(a.trim()) === nt) return obj
      }
    }
  }
  return null
}

export function matchFilter(name: string, filters: ApFilter[]): ApFilter | null {
  const nf = norm(name)
  return filters.find(f => {
    if (f.name != null && norm(f.name) === nf) return true
    if (f.aliases) return f.aliases.split(';').some(a => norm(a.trim()) === nf)
    return false
  }) ?? null
}

export function matchExposure(duration: number, exposures: ApExposure[]): ApExposure | null {
  return exposures.find(e => e.duration === duration)
    ?? exposures.find(e => Math.abs(e.duration - duration) < 1)
    ?? null
}
