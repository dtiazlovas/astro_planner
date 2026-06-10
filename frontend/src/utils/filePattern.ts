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
      return data.value ?? DEFAULT_PATTERN
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
