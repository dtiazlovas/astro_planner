import { useState, useEffect, useRef, useMemo } from 'react'
import {
  getObjects, getFilters, getExposures, getObjectTypes, getSessions,
  createSession, createObjectSession,
  updateObject, createObject,
  updateFilter, createFilter,
  checkImported, recordImported,
  getPlans, setPlanSession, createPlan, createPlanDetail,
  saveImportedAnalysis, getImportedRecords, getPsfswAnchors,
  type ImportedRecord,
} from '../api'
import { analyzeFitsFiles } from '../utils/fitsAnalysis'
import { groupRecords, ensureAnchor, toAnchorMap, medianOf, scaleBy, type AnchorMap } from '../utils/psfsw'
import type { FitsAnalysis } from '../utils/fits'
import { ensureImagesFolderAccess, copyFilesToObjectFolders, pickSourceFolder, isInsideImagesFolder, deleteFilesFromDirectory, type CopyItem } from '../utils/imagesFolder'
import type { ApObject, ApObjectType, ApFilter, ApExposure, ApSession, ApPlan } from '../types'
import { useEquipment } from '../context/EquipmentContext'
import SnrChart, { type SnrPoint } from '../components/SnrChart'
import FileListDialog from '../components/FileListDialog'
import BlinkViewer from '../components/BlinkViewer'

interface ImportResult {
  sessionsCreated: number
  entriesOk: number
  culledRecorded: number  // rejects written against their night, entry or not
  entriesFailed: Array<{ target: string; filter: string }>
  entriesSkipped: Array<{ target: string; filter: string; reason: string }>
  filesCopied: number
  filesSkipped: number
  filesNotFound: number
  filesFailed: number
  copyWarning: string | null
  // The two sets the source cleanup offers to delete, captured here because the
  // preview they were derived from is cleared once the import finishes.
  copiedNames: string[]   // approved subs that reached an object folder
  culledNames: string[]   // subs the approve line / blink rejected — never copied
}
import {
  DEFAULT_PATTERN, fetchPatterns, parseFileMulti, dateKey, toDatetimeLocal,
  matchObject, matchFilter, matchExposure, getPatternAcceptMulti,
  fetchDayStartHour,
} from '../utils/filePattern'

interface ImportEntry {
  target: string
  objectId: number | null; objectName: string | null
  filter: string
  filterId: number | null; filterName: string | null
  duration: number
  exposureId: number | null
  frames: number
  fileNames: string[]
  canImport: boolean
  warning: string | null
}

interface ImportSession {
  dateKey: string
  name: string
  startTime: Date
  entries: ImportEntry[]
}

// One target+filter combination within a batch. Quality analysis is scoped to
// these: PSFSW is normalized to the median of the group, and each group gets its
// own approve line, so importing two targets at once can't cull one against the
// other's signal level.
interface QualityGroup {
  key: string
  label: string
  fileNames: string[]
}

interface HistoricalRecord { psfsw: number | null; fwhm: number | null; time: number }

interface Props {
  onImported: () => void
  onClose: () => void
}

function buildPreview(
  rawFiles: File[],
  objects: ApObject[],
  filters: ApFilter[],
  exposures: ApExposure[],
  patterns: string[],
  overrides: Record<string, number>,
  filterOverrides: Record<string, number>,
  dayStartHour = 0,
): { sessions: ImportSession[]; warnings: string[]; parsed: number; skipped: number } {
  const parsed: ReturnType<typeof parseFileMulti>[] = []
  let skipped = 0
  for (const f of rawFiles) {
    const r = parseFileMulti(f.name, patterns)
    if (r) parsed.push(r)
    else skipped++
  }

  const byDate = new Map<string, typeof parsed>()
  for (const f of parsed) {
    const dk = dateKey(f!.datetime, dayStartHour)
    const arr = byDate.get(dk) ?? []
    arr.push(f)
    byDate.set(dk, arr)
  }

  const sessions: ImportSession[] = []
  const allWarnings: string[] = []

  for (const [dk, files] of [...byDate.entries()].sort()) {
    const validFiles = files.filter(Boolean) as NonNullable<typeof files[number]>[]
    const startTime = validFiles.reduce((min, f) => f.datetime < min ? f.datetime : min, validFiles[0].datetime)

    const byGroup = new Map<string, typeof validFiles>()
    for (const f of validFiles) {
      const key = `${f.target}||${f.filter}||${f.duration}`
      const arr = byGroup.get(key) ?? []
      arr.push(f)
      byGroup.set(key, arr)
    }

    const entries: ImportEntry[] = []

    for (const [key, groupFiles] of byGroup.entries()) {
      const [target, filterStr, durationStr] = key.split('||')
      const duration = parseFloat(durationStr)
      const obj = target in overrides
        ? (objects.find(o => o.id === overrides[target]) ?? null)
        : matchObject(target, objects)
      const filt = filterStr in filterOverrides
        ? (filters.find(f => f.id === filterOverrides[filterStr]) ?? null)
        : matchFilter(filterStr, filters)
      const exp = matchExposure(duration, exposures)

      const warnings: string[] = []
      if (!obj) warnings.push(`Object "${target}" not found`)
      if (!filt) warnings.push(`Filter "${filterStr}" not found`)
      if (!exp) warnings.push(`Exposure ${duration}s not found`)
      for (const w of warnings) allWarnings.push(w)

      entries.push({
        target, objectId: obj?.id ?? null, objectName: obj?.name ?? null,
        filter: filterStr, filterId: filt?.id ?? null, filterName: filt?.name ?? null,
        duration, exposureId: exp?.id ?? null,
        frames: groupFiles.length,
        fileNames: groupFiles.map(f => f.rawName),
        canImport: !!(obj && filt && exp),
        warning: warnings.length ? warnings.join('; ') : null,
      })
    }

    const y = dk.slice(0, 4), mo = dk.slice(4, 6), d = dk.slice(6, 8)
    sessions.push({
      dateKey: dk,
      name: `${y}-${mo}-${d}`,
      startTime,
      entries,
    })
  }

  return { sessions, warnings: [...new Set(allWarnings)], parsed: parsed.length, skipped }
}

export default function ImportPanel({ onImported, onClose }: Props) {
  const { activeId } = useEquipment()
  const [objects, setObjects] = useState<ApObject[]>([])
  const [objectTypes, setObjectTypes] = useState<ApObjectType[]>([])
  const [filters, setFilters] = useState<ApFilter[]>([])
  const [exposures, setExposures] = useState<ApExposure[]>([])
  const [sessions, setSessions] = useState<ApSession[]>([])
  const [patterns, setPatterns] = useState<string[]>([DEFAULT_PATTERN])
  const [dayStartHour, setDayStartHour] = useState(16)
  const [lookupReady, setLookupReady] = useState(false)

  const [rawFiles, setRawFiles] = useState<File[]>([])
  const [blinkOpen, setBlinkOpen] = useState(false)
  const [duplicateCount, setDuplicateCount] = useState(0)
  const [preview, setPreview] = useState<ImportSession[] | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [parsedCount, setParsedCount] = useState(0)
  const [skippedCount, setSkippedCount] = useState(0)

  // object target state
  const [targetOverrides, setTargetOverrides] = useState<Record<string, number>>({})
  const [targetAliasTo, setTargetAliasTo] = useState<Record<string, string>>({})
  const [ignoredTargets, setIgnoredTargets] = useState<string[]>([])
  const [resolvingTarget, setResolvingTarget] = useState<string | null>(null)

  // create-object dialog
  const [createDialog, setCreateDialog] = useState<string | null>(null)
  const [createDialogForm, setCreateDialogForm] = useState({ name: '', typeId: '', aliases: '', position_json: '', active: true, folder: '', comment: '' })
  const [createDialogSubmitting, setCreateDialogSubmitting] = useState(false)

  // filter state
  const [filterOverrides, setFilterOverrides] = useState<Record<string, number>>({})
  const [filterAliasTo, setFilterAliasTo] = useState<Record<string, string>>({})
  const [ignoredFilters, setIgnoredFilters] = useState<string[]>([])
  const [resolvingFilter, setResolvingFilter] = useState<string | null>(null)

  const [allPlans, setAllPlans] = useState<ApPlan[]>([])
  const [entryPlanMap, setEntryPlanMap] = useState<Map<string, number>>(new Map())

  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<{ step: string; current: number; total: number } | null>(null)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [resultExpanded, setResultExpanded] = useState<'failed' | 'skipped' | null>(null)
  const [error, setError] = useState<string | null>(null)

  // ── source cleanup, offered in the result dialog ──────────────
  const [confirmDeleteSources, setConfirmDeleteSources] = useState(false)
  const [deletingSources, setDeletingSources] = useState(false)
  // Reported inside the dialog rather than the page's error banner — the banner
  // sits behind the modal backdrop.
  const [sourceDeleteMsg, setSourceDeleteMsg] = useState<{ kind: 'ok' | 'warn' | 'fail'; text: string } | null>(null)

  // ── quality analysis / frame approval ─────────────────────────
  const [snrResults, setSnrResults] = useState<Map<string, FitsAnalysis>>(new Map())
  // Both metrics are measured in one pass; this selects which is shown and
  // culled against. PSFSW: higher is better (normalized to median ≈ 1.0);
  // FWHM: lower is better (raw pixels).
  const [qualityMetric, setQualityMetric] = useState<'psfsw' | 'fwhm'>('psfsw')
  // Previously-analyzed subs (different files) grouped by the target+filter they
  // belong to, time-ordered — background context for the chart. Raw values;
  // PSFSW is normalized against the active group's median when rendered.
  const [historicalByGroup, setHistoricalByGroup] = useState<Map<string, HistoricalRecord[]>>(new Map())
  // Approve line per target+filter group. A single line across groups would be
  // meaningless: PSFSW is relative to each group's own median.
  const [thresholds, setThresholds] = useState<Record<string, number>>({})
  const [activeGroupKey, setActiveGroupKey] = useState<string | null>(null)
  /**
   * Frames dropped by eye in the blink viewer. This only ever removes frames:
   * not being dropped means "let the approve line decide", not "keep no matter
   * what", so a frame you leave alone is still culled if it scores badly.
   */
  const [droppedFrames, setDroppedFrames] = useState<Set<string>>(new Set())
  const [analyzing, setAnalyzing] = useState(false)
  const [showRejectedList, setShowRejectedList] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const analyzeAbortRef = useRef<AbortController | null>(null)
  // Mirrors qualityMetric so the streaming commit() can pick the right
  // approve-line default without stale closure state.
  const qualityMetricRef = useRef<'psfsw' | 'fwhm'>('psfsw')
  // Raw (un-normalized) analysis values, persisted onto the import records on import.
  const rawAnalysisRef = useRef<Map<string, { psfsw: number | null; fwhm: number | null }>>(new Map())
  // All import records, prefetched when files are selected so the chart's
  // historical band can be matched synchronously the instant Analyze is clicked
  // — fetching them behind the click raced the chart's first mount, so the band
  // was missing on the first analyze and only appeared on re-analyze.
  const importedRecordsRef = useRef<ImportedRecord[] | null>(null)
  // The frozen per-target+filter PSFSW scales. A ref because `commit()` runs
  // inside the analysis loop and must not read a stale copy; the counter is
  // what tells the chart to redraw when one is established.
  const anchorsRef = useRef<AnchorMap>(new Map())
  const [anchorVersion, setAnchorVersion] = useState(0)

  // Closing the panel stops a running analysis instead of letting it keep
  // hammering the worker / server in the background.
  useEffect(() => () => analyzeAbortRef.current?.abort(), [])

  useEffect(() => {
    if (folderInputRef.current) folderInputRef.current.setAttribute('webkitdirectory', '')
  }, [])

  useEffect(() => {
    Promise.all([getObjects(activeId), getFilters(), getExposures(), fetchPatterns(), getObjectTypes(), getSessions(activeId), getPlans(undefined, activeId), fetchDayStartHour()])
      .then(([o, f, e, p, ot, s, pl, dsh]) => {
        setObjects(o); setFilters(f); setExposures(e); setPatterns(p); setObjectTypes(ot); setSessions(s); setAllPlans(pl); setDayStartHour(dsh)
        setLookupReady(true)
      })
      .catch(() => setError('Failed to load lookup data'))
    // Separate from the lookups above: a missing anchor table shouldn't stop
    // the panel loading, it just means no pair is anchored yet.
    getPsfswAnchors()
      .then(rows => { anchorsRef.current = toAnchorMap(rows); setAnchorVersion(v => v + 1) })
      .catch(() => {})
  }, [])

  const applyPreview = (
    files: File[],
    objs: ApObject[],
    filts: ApFilter[],
    ovr: Record<string, number>,
    fovr: Record<string, number>,
    dsh = dayStartHour,
  ) => {
    const result = buildPreview(files, objs, filts, exposures, patterns, ovr, fovr, dsh)
    setPreview(result.sessions)
    setWarnings(result.warnings)
    setParsedCount(result.parsed)
    setSkippedCount(result.skipped)
  }

  const processFiles = async (all: File[]) => {
    if (!all.length) return
    setError(null); setImportResult(null)
    setTargetOverrides({}); setTargetAliasTo({}); setIgnoredTargets([])
    setFilterOverrides({}); setFilterAliasTo({}); setIgnoredFilters([])
    setSnrResults(new Map()); setThresholds({}); setHistoricalByGroup(new Map()); setActiveGroupKey(null)

    // Prefetch the import records now so the historical band is ready to match
    // the moment Analyze is clicked (no fetch racing the chart's first mount).
    try { importedRecordsRef.current = await getImportedRecords() } catch { importedRecordsRef.current = [] }

    let alreadyImported: string[] = []
    try { alreadyImported = await checkImported(all.map(f => f.name)) } catch {}
    const alreadySet = new Set(alreadyImported)
    const fresh = all.filter(f => !alreadySet.has(f.name))
    setDuplicateCount(all.length - fresh.length)
    setRawFiles(fresh)
    applyPreview(fresh, objects, filters, {}, {})
  }

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const all = Array.from(e.target.files ?? [])
    if (fileInputRef.current) fileInputRef.current.value = ''
    await processFiles(all)
  }

  const handleFolderFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const accept = getPatternAcceptMulti(patterns)
    const exts = accept === '*' ? null : accept.split(',').map(e => e.toLowerCase())

    const all = Array.from(e.target.files ?? [])
      .filter(f => !exts || exts.some(ext => f.name.toLowerCase().endsWith(ext)))
    if (folderInputRef.current) folderInputRef.current.value = ''
    await processFiles(all)
  }

  // ── target helpers ──────────────────────────────────────────
  const allTargets = [...new Set(preview?.flatMap(s => s.entries).map(e => e.target) ?? [])]
  const matchedTargets = allTargets.filter(t =>
    preview?.flatMap(s => s.entries).find(e => e.target === t)?.objectId != null
  )
  const unresolvedTargets = allTargets.filter(t =>
    !preview?.flatMap(s => s.entries).find(e => e.target === t)?.objectId &&
    !ignoredTargets.includes(t)
  )

  const handleOverride = (target: string, objectIdStr: string) => {
    const newOvr = objectIdStr
      ? { ...targetOverrides, [target]: Number(objectIdStr) }
      : (() => { const o = { ...targetOverrides }; delete o[target]; return o })()
    setTargetOverrides(newOvr)
    applyPreview(rawFiles, objects, filters, newOvr, filterOverrides)
  }

  const handleAddAlias = async (target: string) => {
    const objectId = Number(targetAliasTo[target])
    if (!objectId) return
    setResolvingTarget(target)
    try {
      const obj = objects.find(o => o.id === objectId)!
      const newAliases = obj.aliases ? `${obj.aliases};${target}` : target
      const updated = await updateObject(objectId, { aliases: newAliases })
      const newObjects = objects.map(o => o.id === objectId ? updated : o)
      setObjects(newObjects)
      applyPreview(rawFiles, newObjects, filters, targetOverrides, filterOverrides)
    } catch {
      setError(`Failed to add alias for "${target}"`)
    } finally {
      setResolvingTarget(null)
    }
  }

  const openCreateDialog = (target: string) => {
    setCreateDialogForm({
      name: target,
      typeId: String(objectTypes[0]?.id ?? ''),
      aliases: target,
      position_json: '',
      active: true,
      folder: '',
      comment: '',
    })
    setCreateDialog(target)
  }

  const handleCreateDialogSubmit = async () => {
    if (!createDialogForm.name.trim()) return
    setCreateDialogSubmitting(true)
    try {
      const created = await createObject({
        name: createDialogForm.name.trim(),
        type: Number(createDialogForm.typeId),
        position_json: createDialogForm.position_json.trim() || '{}',
        comment: createDialogForm.comment.trim() || null,
        active: createDialogForm.active,
        aliases: createDialogForm.aliases.trim() || null,
        folder: createDialogForm.folder.trim() || null,
      })
      const newObjects = [...objects, created]
      setObjects(newObjects)
      applyPreview(rawFiles, newObjects, filters, targetOverrides, filterOverrides)
      setCreateDialog(null)
    } catch {
      setError(`Failed to create object "${createDialogForm.name}"`)
    } finally {
      setCreateDialogSubmitting(false)
    }
  }

  // ── filter helpers ───────────────────────────────────────────
  const allFilterNames = [...new Set(preview?.flatMap(s => s.entries).map(e => e.filter) ?? [])]
  const matchedFilterNames = allFilterNames.filter(fn =>
    preview?.flatMap(s => s.entries).find(e => e.filter === fn)?.filterId != null
  )
  const unresolvedFilterNames = allFilterNames.filter(fn =>
    !preview?.flatMap(s => s.entries).find(e => e.filter === fn)?.filterId &&
    !ignoredFilters.includes(fn)
  )

  const handleFilterOverride = (filterName: string, filterIdStr: string) => {
    const newFovr = filterIdStr
      ? { ...filterOverrides, [filterName]: Number(filterIdStr) }
      : (() => { const o = { ...filterOverrides }; delete o[filterName]; return o })()
    setFilterOverrides(newFovr)
    applyPreview(rawFiles, objects, filters, targetOverrides, newFovr)
  }

  const handleAddFilterAlias = async (filterName: string) => {
    const filterId = Number(filterAliasTo[filterName])
    if (!filterId) return
    setResolvingFilter(filterName)
    try {
      const filt = filters.find(f => f.id === filterId)!
      const newAliases = filt.aliases ? `${filt.aliases};${filterName}` : filterName
      const updated = await updateFilter(filterId, { name: filt.name ?? '', aliases: newAliases })
      const newFilters = filters.map(f => f.id === filterId ? updated : f)
      setFilters(newFilters)
      applyPreview(rawFiles, objects, newFilters, targetOverrides, filterOverrides)
    } catch {
      setError(`Failed to add alias for filter "${filterName}"`)
    } finally {
      setResolvingFilter(null)
    }
  }

  const handleCreateFilter = async (filterName: string) => {
    setResolvingFilter(filterName)
    try {
      const created = await createFilter({ name: filterName, aliases: null })
      const newFilters = [...filters, created]
      setFilters(newFilters)
      applyPreview(rawFiles, objects, newFilters, targetOverrides, filterOverrides)
    } catch {
      setError(`Failed to create filter "${filterName}"`)
    } finally {
      setResolvingFilter(null)
    }
  }

  // ── plan helpers ─────────────────────────────────────────────
  const entryKey = (dk: string, target: string, filter: string, duration: number) =>
    `${dk}|${target}|${filter}|${duration}`

  const getEntryPlanId = (dk: string, entry: { target: string; filter: string; duration: number; objectId: number | null }): number | null => {
    const key = entryKey(dk, entry.target, entry.filter, entry.duration)
    if (entryPlanMap.has(key)) return entryPlanMap.get(key)!
    if (entry.objectId) {
      const active = allPlans.filter(p => p.object === entry.objectId && p.active)
      if (active.length === 1) return active[0].id
    }
    return null
  }

  const setEntryPlan = (dk: string, entry: { target: string; filter: string; duration: number }, planId: number | null) => {
    const key = entryKey(dk, entry.target, entry.filter, entry.duration)
    setEntryPlanMap(prev => {
      const m = new Map(prev)
      if (planId === null) m.delete(key)
      else m.set(key, planId)
      return m
    })
  }

  // ── SNR analysis ─────────────────────────────────────────────
  // All distinct .fit file names across importable entries, in capture order.
  const importableFileNames = [...new Set(
    (preview ?? []).flatMap(s => s.entries.filter(e => e.canImport)).flatMap(e => e.fileNames)
  )]

  // Importable frames split by target+filter, merged across sessions and
  // exposures. Every quality figure below is scoped to one of these.
  const qualityGroups: QualityGroup[] = (() => {
    const byKey = new Map<string, QualityGroup>()
    for (const session of preview ?? []) {
      for (const e of session.entries) {
        if (!e.canImport || e.objectId == null || e.filterId == null) continue
        const key = `${e.objectId}|${e.filterId}`
        const group = byKey.get(key) ?? { key, label: `${e.objectName ?? e.target} · ${e.filterName ?? e.filter}`, fileNames: [] }
        group.fileNames.push(...e.fileNames)
        byKey.set(key, group)
      }
    }
    for (const g of byKey.values()) g.fileNames = [...new Set(g.fileNames)]
    return [...byKey.values()]
  })()

  const groupKeyOfFile = new Map<string, string>()
  for (const g of qualityGroups) for (const name of g.fileNames) groupKeyOfFile.set(name, g.key)

  // Falls back to the first group so a key left over from a previous batch
  // never leaves the chart pointing at nothing.
  const activeGroup = qualityGroups.find(g => g.key === activeGroupKey) ?? qualityGroups[0] ?? null
  const activeThreshold = activeGroup ? thresholds[activeGroup.key] ?? null : null

  // Previously-analyzed subs (persisted psfsw/fwhm, different files) whose parsed
  // target+filter matches an importable entry in this batch — the chart's
  // historical context, and the population a pair's anchor is set from. Matched
  // synchronously from the prefetched records so the band is available
  // immediately when analysis starts. Raw values, time-ordered.
  const matchHistoricalRecords = (): Map<string, HistoricalRecord[]> => {
    const records = importedRecordsRef.current
    if (!records?.length) return new Map()
    const pairSet = new Set(qualityGroups.map(g => g.key))
    if (!pairSet.size) return new Map()
    // The batch's own files are excluded: they are what the history is context
    // for, and on a re-import they may already carry a stored analysis. Culled
    // subs are excluded too — the history is what the kept population looks
    // like, and a scale anchored to rejected frames is pulled towards them.
    const grouped = groupRecords(records.filter(r => !r.culled), objects, filters, patterns, new Set(importableFileNames))
    const out = new Map<string, HistoricalRecord[]>()
    for (const [key, list] of grouped) {
      if (pairSet.has(key)) out.set(key, list.map(r => ({ psfsw: r.psfsw, fwhm: r.fwhm, time: r.time })))
    }
    return out
  }

  /**
   * Makes sure every group on screen has a frozen PSFSW scale, so the numbers
   * this import shows are the ones the object's own analysis will show later.
   *
   * A pair is anchored to its history where it has any; a first-light pair has
   * only this batch to go on, so it anchors to that — which is also why this
   * runs again after measuring, for the groups that had nothing to anchor to
   * beforehand.
   */
  const ensureGroupAnchors = async (history: Map<string, HistoricalRecord[]>) => {
    let changed = false
    for (const g of qualityGroups) {
      const [objectId, filterId] = g.key.split('|').map(Number)
      if (anchorsRef.current.has(g.key)) continue
      const fromHistory = (history.get(g.key) ?? []).map(h => h.psfsw).filter((v): v is number => v != null)
      const fromBatch = g.fileNames.map(n => rawAnalysisRef.current.get(n)?.psfsw).filter((v): v is number => v != null)
      const row = await ensureAnchor(anchorsRef.current, objectId, filterId, fromHistory.length ? fromHistory : fromBatch)
      if (row) changed = true
    }
    if (changed) setAnchorVersion(v => v + 1)
  }

  const handleAnalyzeSnr = async () => {
    if (!importableFileNames.length) return
    setAnalyzing(true); setError(null)
    setSnrResults(new Map()); setThresholds({}); setHistoricalByGroup(new Map())
    setActiveGroupKey(qualityGroups[0]?.key ?? null)
    // Hand calls were made against the previous measurements; re-measuring
    // invalidates the basis for them.
    setDroppedFrames(new Set())
    const ctrl = new AbortController()
    analyzeAbortRef.current = ctrl

    // Accumulated raw frames, re-normalized and pushed to the chart after each
    // batch / frame so results render live while analysis is still running.
    const raw: FitsAnalysis[] = []
    // Captured now: the groups can't change mid-analysis, and commit() would
    // otherwise close over whatever `preview` was at render time.
    const fileGroup = groupKeyOfFile

    const commit = () => {
      if (!raw.length) return
      // Frames are scaled within their own target+filter group, against that
      // pair's frozen anchor — the same divisor the object's own analysis uses,
      // so a sub reads the same number there as here, tonight and next year.
      // Until a first-light pair has an anchor, its own median stands in and the
      // final commit redraws it against the anchor once one is written.
      // FWHM stays raw (pixels).
      const byGroup = new Map<string, FitsAnalysis[]>()
      for (const r of raw) {
        const key = fileGroup.get(r.fileName) ?? ''
        const list = byGroup.get(key)
        if (list) list.push(r); else byGroup.set(key, [r])
      }

      const normedAll: FitsAnalysis[] = []
      // Keep each approve line at its "approve everything" default until analysis
      // finishes and the user drags it (dragging is disabled while analyzing).
      const defaults: Record<string, number> = {}
      for (const [key, items] of byGroup) {
        const anchored = anchorsRef.current.get(key)?.anchor
        const median = anchored ?? medianOf(items.map(r => r.snr).filter((v): v is number => v != null)) ?? 0
        const normed = median > 0
          ? items.map(r => r.snr != null ? { ...r, snr: scaleBy(r.snr, median) } : r)
          : items
        normedAll.push(...normed)
        const vals = normed
          .map(r => qualityMetricRef.current === 'psfsw' ? r.snr : r.fwhm)
          .filter((v): v is number => v != null)
        if (vals.length) defaults[key] = qualityMetricRef.current === 'psfsw' ? Math.min(...vals) : Math.max(...vals)
      }
      setSnrResults(new Map(normedAll.map(r => [r.fileName, r])))
      setThresholds(defaults)
    }

    try {
      setImportProgress({ step: 'Analyzing frame quality…', current: 0, total: importableFileNames.length })

      // Match the historical spread up front, per target+filter: PSFSW + FWHM of
      // previously-analyzed subs (different files) whose parsed target+filter
      // matches a group in this batch. The records were prefetched on file
      // selection, so this is a synchronous match with no fetch racing the
      // chart's first mount — the band is present on the very first analyze, not
      // only on re-analyze. The prefetch may not have run (or may have failed),
      // so fetch as a fallback. The history is also what a pair's scale is
      // anchored to, so it is established here — before the first frame is
      // committed, or the chart would start on a stand-in scale and jump.
      let history = new Map<string, HistoricalRecord[]>()
      try {
        if (importedRecordsRef.current == null) importedRecordsRef.current = await getImportedRecords()
        history = matchHistoricalRecords()
        setHistoricalByGroup(history)
      } catch { setHistoricalByGroup(new Map()) }
      await ensureGroupAnchors(history)

      // Analyze the picked File objects directly, in a worker, committing each
      // frame as the worker returns it.
      const fileByName = new Map(rawFiles.map(f => [f.name, f]))
      const files = importableFileNames.map(n => fileByName.get(n)).filter((f): f is File => f !== undefined)
      await analyzeFitsFiles(files, (done, total, result) => {
        if (result) { raw.push(result); rawAnalysisRef.current.set(result.fileName, { psfsw: result.snr, fwhm: result.fwhm }) }
        setImportProgress({ step: 'Analyzing frame quality…', current: done, total })
        commit()
      }, ctrl.signal)

      // First-light pairs had no history to anchor to; now that their frames are
      // measured they can be anchored to this batch, and the re-commit puts the
      // chart on that scale for good.
      await ensureGroupAnchors(history)
      commit() // final scaling over the full set
    } catch {
      setError('Quality analysis failed')
    } finally {
      analyzeAbortRef.current = null
      setAnalyzing(false)
      setImportProgress(null)
    }
  }

  // Capture time for ordering: FITS DATE-OBS, else the filename-parsed datetime.
  const timeForFile = (fileName: string): number => {
    const dateObs = snrResults.get(fileName)?.dateObs
    if (dateObs) { const t = Date.parse(dateObs); if (!isNaN(t)) return t }
    return parseFileMulti(fileName, patterns)?.datetime.getTime() ?? 0
  }

  // PSFSW is plotted normalized (higher is better); FWHM raw px (lower is better).
  const metricValue = (r: FitsAnalysis): number | null => qualityMetric === 'psfsw' ? r.snr : r.fwhm
  const goodDirection: 'above' | 'below' = qualityMetric === 'psfsw' ? 'above' : 'below'
  const metricLabel = qualityMetric === 'psfsw' ? 'PSFSW' : 'FWHM (px)'

  // The chart shows one group at a time; everything below it is scoped to that
  // group, while the import-wide totals are computed separately.
  const activeResults = [...snrResults.values()].filter(r => groupKeyOfFile.get(r.fileName) === activeGroup?.key)

  // Past subs for this group, on the same scale as the live frames because both
  // divide by the pair's frozen anchor — no longer by whatever this batch's
  // median happens to be, which made the band shift as frames arrived and put
  // it on a different scale from the object's own analysis. FWHM is raw px.
  const activeAnchor = activeGroup ? anchorsRef.current.get(activeGroup.key) ?? null : null
  const historicalForMetric: number[] = (() => {
    void anchorVersion // recompute when a scale is established
    const records = activeGroup ? historicalByGroup.get(activeGroup.key) ?? [] : []
    if (qualityMetric === 'fwhm') return records.map(h => h.fwhm).filter((v): v is number => v != null)
    const psfsw = records.map(h => h.psfsw).filter((v): v is number => v != null)
    // No anchor yet (first light, before anything is measured): the stand-in is
    // the historical set's own median, matching what commit() falls back to.
    const divisor = activeAnchor?.anchor ?? medianOf(psfsw)
    return divisor ? psfsw.map(v => scaleBy(v, divisor)) : psfsw
  })()

  const measuredPoints: SnrPoint[] = activeResults
    .filter(r => metricValue(r) != null)
    .map(r => ({ fileName: r.fileName, snr: metricValue(r) as number, time: timeForFile(r.fileName) }))
  // While analysis is running, seed a baseline point for every file in this group
  // not yet measured so the chart lays out its full x-axis immediately and each
  // point rises in place as its value arrives.
  const pendingPoints: SnrPoint[] = analyzing
    ? (activeGroup?.fileNames ?? [])
        .filter(n => !snrResults.has(n))
        .map(n => ({ fileName: n, snr: 0, time: timeForFile(n), pending: true }))
    : []
  const snrPoints: SnrPoint[] = [...measuredPoints, ...pendingPoints].sort((a, b) => a.time - b.time)

  const analyzedCount = measuredPoints.length
  const analyzedCountAll = [...snrResults.values()].filter(r => metricValue(r) != null).length
  const analysisErrors = activeResults.filter(r => metricValue(r) == null).length
  const avgStars = (() => {
    const counts = activeResults.map(r => r.stars ?? 0).filter(n => n > 0)
    return counts.length ? Math.round(counts.reduce((a, b) => a + b, 0) / counts.length) : 0
  })()

  // Where the approve line alone puts a frame: approved if we couldn't measure
  // it (unknown → keep) or it clears its own group's line.
  const clearsLine = (fileName: string): boolean => {
    const key = groupKeyOfFile.get(fileName)
    const threshold = key != null ? thresholds[key] : undefined
    if (threshold == null) return true
    const r = snrResults.get(fileName)
    const v = r ? metricValue(r) : null
    if (v == null) return true
    return goodDirection === 'above' ? v >= threshold : v <= threshold
  }

  // Dropping by eye and the approve line are both vetoes — a frame has to
  // survive each of them to be imported.
  const isApproved = (fileName: string): boolean =>
    !droppedFrames.has(fileName) && clearsLine(fileName)

  // Everything the active group will skip, whether the line or a hand call put
  // it there. Built from the group's own file list rather than the measured
  // points, so a frame dropped by eye before it was measured is included.
  const rejectedFiles = (activeGroup?.fileNames ?? []).filter(n => !isApproved(n))
  const rejectedCount = rejectedFiles.length
  const handDroppedActive = (activeGroup?.fileNames ?? []).filter(n => droppedFrames.has(n)).length
  /** Analysis has produced usable numbers — the approve line and chart need this. */
  const measured = snrResults.size > 0 && analyzedCountAll > 0
  // Every group's own line plus any hand calls — what the import will actually
  // skip. Counted over the importable set rather than the measured results, so
  // a frame dropped by eye before it was measured still shows up here.
  const rejectedCountAll = importableFileNames.filter(n => !isApproved(n)).length

  // Reset every group's approve line to "keep everything" for the newly selected
  // metric — a PSFSW line means nothing once the axis is FWHM.
  const handleMetricChange = (m: 'psfsw' | 'fwhm') => {
    qualityMetricRef.current = m
    setQualityMetric(m)
    setShowRejectedList(false)
    const byGroup = new Map<string, number[]>()
    for (const r of snrResults.values()) {
      const key = groupKeyOfFile.get(r.fileName)
      const v = m === 'psfsw' ? r.snr : r.fwhm
      if (key == null || v == null) continue
      const list = byGroup.get(key)
      if (list) list.push(v); else byGroup.set(key, [v])
    }
    const next: Record<string, number> = {}
    for (const [key, vals] of byGroup) next[key] = m === 'psfsw' ? Math.min(...vals) : Math.max(...vals)
    setThresholds(next)
  }

  // ── import ───────────────────────────────────────────────────
  // Frames an entry contributes once the approve line is applied — what the
  // import actually writes, and what the preview shows.
  const approvedFrames = (entry: ImportEntry): number => entry.fileNames.filter(isApproved).length
  const importableCount = preview?.flatMap(s => s.entries).filter(e => e.canImport && approvedFrames(e) > 0).length ?? 0
  // Gates the import controls. Not `importableCount > 0`: pulling the approve
  // line above every sub in the batch leaves no entry to create but plenty to
  // record, and hiding the button there makes a night that culled everything
  // impossible to import at all.
  const hasImportableFiles = importableFileNames.length > 0

  // Blinking is scoped to one target+filter: comparing frames only tells you
  // anything when they are the same field through the same filter. Capture
  // order comes from the file names. Memoized because BlinkViewer rebuilds its
  // previews whenever this array identity changes.
  // Depend on the names by value, not by array identity: qualityGroups is
  // rebuilt on every render, so `activeGroup.fileNames` is a new array each
  // time and would re-trigger the viewer's preview build continuously.
  const groupNamesKey = (activeGroup?.fileNames ?? []).join('\n')
  const blinkFiles = useMemo(() => {
    if (!groupNamesKey) return []
    const wanted = new Set(groupNamesKey.split('\n'))
    return rawFiles.filter(f => wanted.has(f.name)).sort((a, b) => a.name.localeCompare(b.name))
  }, [rawFiles, groupNamesKey])

  const handleImport = async () => {
    setImporting(true); setError(null); setImportResult(null); setResultExpanded(null)
    setConfirmDeleteSources(false); setSourceDeleteMsg(null)

    // Culled frames never reach an entry's frame count: counting them would
    // overstate the integration and leave the object folder short of the subs
    // the DB claims. They are still recorded — flagged culled, which keeps them
    // out of every file-based reckoning while the night keeps the tally of what
    // it threw away. Every write below uses this approved set, resolved once so
    // the approve lines can't shift underneath a half-finished import.
    const approvedByEntry = new Map<ImportEntry, string[]>()
    for (const s of preview ?? [])
      for (const e of s.entries) approvedByEntry.set(e, e.fileNames.filter(isApproved))
    const approvedOf = (e: ImportEntry): string[] => approvedByEntry.get(e) ?? e.fileNames
    // Resolved from the same snapshot: what the lines rejected is what the
    // source cleanup can offer to delete outright, since none of it is copied.
    const approvedSet = new Set([...approvedByEntry.values()].flat())
    const culledNames = importableFileNames.filter(n => !approvedSet.has(n))
    const culledOf = (e: ImportEntry): string[] => e.fileNames.filter(n => !approvedSet.has(n))
    // An entry whose every frame was culled has nothing to import — creating a
    // zero-frame entry for it would be the same stale row in another guise.
    const entriesToImport = (s: ImportSession) => s.entries.filter(e => e.canImport && approvedOf(e).length > 0)
    const sessionsToImport = (preview ?? []).filter(s => entriesToImport(s).length > 0)

    // In browser mode files are copied via the File System Access API. Acquire
    // folder access first: a permission prompt needs this click's transient
    // user activation, which would be long expired once copying starts.
    const fileByName = new Map(rawFiles.map(f => [f.name, f]))
    const wantsCopy = sessionsToImport.some(s => entriesToImport(s).some(e => {
      const obj = objects.find(o => o.id === e.objectId)
      return !!obj?.folder
    }))
    let imagesDir: FileSystemDirectoryHandle | null = null
    let copyWarning: string | null = null
    if (wantsCopy) {
      imagesDir = await ensureImagesFolderAccess()
      if (!imagesDir) copyWarning = 'Images folder not accessible — no files were copied. Choose it in Settings and grant access.'
    }

    const totalEntries = sessionsToImport.reduce((n, s) => n + entriesToImport(s).length, 0)
    const entriesSkipped = (preview ?? []).flatMap(s =>
      s.entries
        .filter(e => !e.canImport || approvedOf(e).length === 0)
        .map(e => ({
          target: e.target,
          filter: e.filter,
          reason: e.canImport
            ? `All ${e.frames} frame${e.frames !== 1 ? 's' : ''} below the approve line`
            : e.warning ?? 'Unresolved',
        }))
    )
    const entriesFailed: Array<{ target: string; filter: string }> = []
    let entryCount = 0, sessionsCreated = 0, culledRecorded = 0

    const sessionByDate = new Map<string, number>()
    for (const s of sessions) {
      const dk = dateKey(new Date(s.start), dayStartHour)
      if (!sessionByDate.has(dk)) sessionByDate.set(dk, s.id)
    }

    const createdObjSessionsByObject = new Map<number, number[]>()
    const entriesByObject = new Map<number, ImportEntry[]>()
    const allRecordedNames: string[] = []

    // Rejects with no entry to hang on, because their entry kept nothing. Still
    // written one entry at a time rather than in a single call: each carries the
    // exposure it was shot at, which is the only thing left that says what the
    // night lost once no entry survives to say it.
    const recordCulledWithoutEntry = async (entries: ImportEntry[], sessionId: number) => {
      for (const e of entries) {
        const culled = culledOf(e)
        if (!culled.length) continue
        try { await recordImported(culled, sessionId, null, true, e.exposureId) } catch {}
        allRecordedNames.push(...culled)
        culledRecorded += culled.length
      }
    }

    // The session a night's records go against, created on demand. Nights that
    // kept nothing reach this too: the observing happened, the sky was spent,
    // and a night that shows no session at all reads as one that never ran.
    const sessionForNight = async (s: ImportSession): Promise<number | null> => {
      const existing = sessionByDate.get(s.dateKey)
      if (existing != null) return existing
      try {
        const created = await createSession({
          name: s.name, start: toDatetimeLocal(s.startTime),
          duration: null, duration_set: false, comment: 'Imported from folder',
          equipment: activeId,
        })
        sessionByDate.set(s.dateKey, created.id)
        sessionsCreated++
        return created.id
      } catch {
        return null
      }
    }

    try {
      setImportProgress({ step: 'Importing entries…', current: 0, total: totalEntries })
      for (const s of sessionsToImport) {
        const sessionId = await sessionForNight(s)
        if (sessionId == null) {
          for (const entry of entriesToImport(s))
            entriesFailed.push({ target: entry.target, filter: entry.filter })
          continue
        }

        for (const entry of entriesToImport(s)) {
          const approved = approvedOf(entry)
          try {
            const created = await createObjectSession({
              session: sessionId, object: entry.objectId!,
              filter: entry.filterId!, exposure: entry.exposureId!, frames: approved.length,
            })
            const planId = getEntryPlanId(s.dateKey, entry)
            if (planId) { try { await setPlanSession({ session: created.id, planid: planId }) } catch {} }
            const objId = entry.objectId!
            createdObjSessionsByObject.set(objId, [...(createdObjSessionsByObject.get(objId) ?? []), created.id])
            entriesByObject.set(objId, [...(entriesByObject.get(objId) ?? []), entry])
            // Recorded per entry, tied to the entry just created — deleting that
            // entry later takes exactly these files' records with it.
            try { await recordImported(approved, sessionId, created.id, false, entry.exposureId) } catch {}
            allRecordedNames.push(...approved)
            // This entry's rejects, flagged culled so nothing reads them as
            // subs that went missing from the object folder. Same entry link:
            // it says which target and filter they were shot for.
            const culled = culledOf(entry)
            if (culled.length) {
              try { await recordImported(culled, sessionId, created.id, true, entry.exposureId) } catch {}
              allRecordedNames.push(...culled)
              culledRecorded += culled.length
            }
            entryCount++
            setImportProgress({ step: 'Importing entries…', current: entryCount, total: totalEntries })
          } catch {
            entriesFailed.push({ target: entry.target, filter: entry.filter })
          }
        }

        // Entries the line rejected outright: nothing was imported, so there is
        // no entry to hang their records on, but the night still lost the
        // frames and says so.
        await recordCulledWithoutEntry(s.entries.filter(e => e.canImport && approvedOf(e).length === 0), sessionId)
      }

      // Nights where every importable frame was culled never reached the loop
      // above — no entry means it was never given a session there. They get one
      // here: a night that kept nothing still happened, and it is the only night
      // whose whole story is what it threw away.
      const culledOnlyNights = (preview ?? []).filter(s =>
        !sessionsToImport.includes(s) && s.entries.some(e => e.canImport && culledOf(e).length > 0))
      if (culledOnlyNights.length) setImportProgress({ step: 'Recording culled subs…', current: 0, total: 0 })
      for (const s of culledOnlyNights) {
        const culledEntries = s.entries.filter(e => e.canImport && culledOf(e).length > 0)
        const sessionId = await sessionForNight(s)
        if (sessionId == null) continue
        await recordCulledWithoutEntry(culledEntries, sessionId)
      }

      // Persist quality analysis measured during this import onto the records —
      // culled subs included: what they measured is why they were culled.
      const analysisItems = allRecordedNames
        .map(n => ({ n, a: rawAnalysisRef.current.get(n) }))
        .filter((x): x is { n: string; a: { psfsw: number | null; fwhm: number | null } } => !!x.a && (x.a.psfsw != null || x.a.fwhm != null))
        .map(x => ({ filename: x.n, psfsw: x.a.psfsw, fwhm: x.a.fwhm }))
      if (analysisItems.length) { try { await saveImportedAnalysis(analysisItems) } catch {} }

      setImportProgress({ step: 'Creating plans…', current: 0, total: 0 })
      for (const [objectId, objSessionIds] of createdObjSessionsByObject.entries()) {
        if (allPlans.some(p => p.object === objectId)) continue
        try {
          const entries = entriesByObject.get(objectId)!
          const newPlan = await createPlan({ object: objectId, name: entries[0].objectName ?? String(objectId), active: true, equipment: activeId })
          const byFilter = new Map<number, number>()
          for (const e of entries) {
            if (e.filterId) byFilter.set(e.filterId, (byFilter.get(e.filterId) ?? 0) + approvedOf(e).length * e.duration)
          }
          for (const [filterId, totalSeconds] of byFilter.entries()) {
            const durationMinutes = Math.ceil(totalSeconds / 36000) * 600
            await createPlanDetail({ planid: newPlan.id, filter: filterId, duration: durationMinutes })
          }
          for (const osId of objSessionIds) {
            try { await setPlanSession({ session: osId, planid: newPlan.id }) } catch {}
          }
        } catch {}
      }

      // Approved files per entry that map to an object folder + filter folder.
      const copyGroups: { fileNames: string[]; objectFolder: string; filterName: string }[] = []
      for (const s of sessionsToImport) {
        for (const entry of entriesToImport(s)) {
          const obj = objects.find(o => o.id === entry.objectId)
          const approvedNames = approvedOf(entry)
          if (obj?.folder && approvedNames.length) {
            const filt = filters.find(f => f.id === entry.filterId)
            const filterFolder = filt?.folder ?? filt?.name ?? entry.filterName ?? ''
            if (filterFolder)
              copyGroups.push({ fileNames: approvedNames, objectFolder: obj.folder, filterName: filterFolder })
          }
        }
      }
      let filesCopied = 0, filesSkipped = 0, filesNotFound = 0, filesFailed = 0
      if (copyGroups.length && imagesDir) {
        const copyItems: CopyItem[] = copyGroups.map(g => ({
          files: g.fileNames.map(n => fileByName.get(n)).filter((f): f is File => f !== undefined),
          objectFolder: g.objectFolder, filterName: g.filterName,
        }))
        const totalFiles = copyItems.reduce((n, i) => n + i.files.length, 0)
        setImportProgress({ step: 'Copying files…', current: 0, total: totalFiles })
        const stats = await copyFilesToObjectFolders(imagesDir, copyItems, done =>
          setImportProgress({ step: 'Copying files…', current: done, total: totalFiles })).catch(() => null)
        if (stats) { filesCopied = stats.copied; filesSkipped = stats.skipped; filesFailed = stats.failed }
        else copyWarning = 'File copying failed.'
      }

      setImportProgress(null)
      setImportResult({
        sessionsCreated, entriesOk: entryCount, culledRecorded, entriesFailed, entriesSkipped,
        filesCopied, filesSkipped, filesNotFound, filesFailed, copyWarning,
        // Only subs with a copy destination count as safe to delete at the
        // source: one belonging to an object with no folder was never copied
        // anywhere, so its source file is still the only copy.
        copiedNames: [...new Set(copyGroups.flatMap(g => g.fileNames))],
        culledNames,
      })
      setPreview(null)
    } catch {
      setError('Import failed — check console for details')
    } finally {
      setImporting(false)
      setImportProgress(null)
    }
  }

  // ── source cleanup ───────────────────────────────────────────
  // The imported subs now live in the object folders, so their originals in the
  // capture folder are redundant. Offered only when the copy actually landed:
  // if any file failed to copy we can't tell which, and deleting a source whose
  // copy never arrived loses the sub.
  const canDeleteCopied = !!importResult
    && importResult.copiedNames.length > 0
    && importResult.filesFailed === 0
    && !importResult.copyWarning
  // The culled subs go with them: they were never copied anywhere, so leaving
  // them behind just refills the folder the cleanup was meant to empty. Their
  // records are flagged culled, so deleting the files strands nothing — no
  // entry counts them and no sync goes looking for them.
  const sourceDeleteNames = importResult
    ? [...new Set([
        ...(canDeleteCopied ? importResult.copiedNames : []),
        ...importResult.culledNames,
      ])]
    : []
  const culledDeleteCount = importResult?.culledNames.length ?? 0
  const copiedDeleteCount = sourceDeleteNames.length - culledDeleteCount

  const handleDeleteSources = async () => {
    if (!sourceDeleteNames.length) return
    setDeletingSources(true); setSourceDeleteMsg(null)
    try {
      // The browser only grants delete access to a folder the user picks, and
      // the files came in through a file input — which carries no handle. The
      // picker is the first await here so the click's activation still holds.
      const dir = await pickSourceFolder()
      if (!dir) return // cancelled
      if (await isInsideImagesFolder(dir))
        throw new Error('That folder is inside the images folder — the imported copies live there. Pick the folder the subs were captured to.')
      const stats: { deleted: number; failed: number; notFound: number; skipped?: number } =
        await deleteFilesFromDirectory(dir, sourceDeleteNames)
      const parts = [
        `${stats.deleted} source file${stats.deleted !== 1 ? 's' : ''} deleted`,
        stats.notFound > 0 ? `${stats.notFound} not found` : null,
        stats.skipped ? `${stats.skipped} inside the images folder, kept` : null,
        stats.failed > 0 ? `${stats.failed} could not be deleted` : null,
      ].filter(Boolean)
      setSourceDeleteMsg({
        kind: stats.failed > 0 ? 'fail' : stats.notFound > 0 || stats.skipped ? 'warn' : 'ok',
        text: parts.join(' · '),
      })
      setConfirmDeleteSources(false)
    } catch (err) {
      setSourceDeleteMsg({ kind: 'fail', text: err instanceof Error ? err.message : 'Deleting source files failed' })
    } finally {
      setDeletingSources(false)
    }
  }

  return (
    <div className="contents-panel">
      <div className="contents-panel__header">
        <span className="contents-panel__title">Import Sessions from Folder</span>
        <button className="btn btn-ghost" onClick={onClose}>Close</button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <input ref={fileInputRef} type="file" style={{ display: 'none' }}
              accept={getPatternAcceptMulti(patterns)} multiple onChange={handleFiles} />
            <input ref={folderInputRef} type="file" style={{ display: 'none' }}
              accept={getPatternAcceptMulti(patterns)} onChange={handleFolderFiles} />
            <button className="btn btn-primary" disabled={!lookupReady}
              onClick={() => fileInputRef.current?.click()}>
              📁 Select Files
            </button>
            <button className="btn btn-secondary" disabled={!lookupReady}
              onClick={() => folderInputRef.current?.click()}>
              🗂 Select Folder
            </button>
            <span className="cell-muted" style={{ fontSize: '0.85rem' }}>
              {patterns.length === 1
                ? <>Pattern: <code className="inline-code">{patterns[0]}</code></>
                : <>{patterns.length} patterns</>}
            </span>
          </div>

          {preview !== null && (
            <>
              <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <span className="cell-muted">
                  {parsedCount} files matched · {skippedCount} skipped · {preview.length} session{preview.length !== 1 ? 's' : ''} · {importableCount} importable entr{importableCount !== 1 ? 'ies' : 'y'}
                  {rejectedCountAll > 0 && ` · ${rejectedCountAll} culled`}
                </span>
                {duplicateCount > 0 && (
                  <span className="import-duplicate-warn">
                    {duplicateCount} duplicate{duplicateCount !== 1 ? 's' : ''} already imported, skipped
                  </span>
                )}
                {hasImportableFiles && (
                  <button className="btn btn-secondary" onClick={handleAnalyzeSnr} disabled={analyzing || importing}>
                    {analyzing ? 'Analyzing…' : snrResults.size ? '↻ Re-analyze quality' : '📈 Analyze quality'}
                  </button>
                )}
                {hasImportableFiles && (
                  <button className="btn btn-primary" onClick={handleImport} disabled={importing || analyzing}>
                    {/* With nothing left above the line there is no entry to
                        import, so the button says what it will actually do. */}
                    {importing ? 'Importing…'
                      : importableCount > 0 ? `Import ${importableCount} entr${importableCount !== 1 ? 'ies' : 'y'}`
                      : `Record ${rejectedCountAll} culled sub${rejectedCountAll !== 1 ? 's' : ''}`}
                  </button>
                )}
              </div>

              {/* Shown as soon as the batch has been grouped by target/filter,
                  not only once measurements exist: the group picker and Blink
                  are useful before any analysis, and blinking a set should not
                  cost a full measuring pass first. The measured parts below
                  gate themselves on having data. */}
              {qualityGroups.length > 0 && (
                <div className="import-session-block">
                  <div className="import-session-header import-session-header--quality">
                    <span className="cell-name">Frame quality</span>
                    <select
                      className="select-dark"
                      value={activeGroup?.key ?? ''}
                      onChange={e => { setActiveGroupKey(e.target.value); setShowRejectedList(false) }}
                      style={{ fontSize: '0.85rem' }}
                      title="Each target/filter is measured and culled on its own — PSFSW is shown against that pair's own fixed scale"
                    >
                      {qualityGroups.map(g => (
                        <option key={g.key} value={g.key}>{g.label} ({g.fileNames.length})</option>
                      ))}
                    </select>
                    <select
                      className="select-dark"
                      value={qualityMetric}
                      onChange={e => handleMetricChange(e.target.value as 'psfsw' | 'fwhm')}
                      style={{ fontSize: '0.85rem' }}
                      title="Both metrics are measured in one pass — this selects which one is shown"
                    >
                      <option value="psfsw">Signal (PSFSW)</option>
                      <option value="fwhm">Star size (FWHM)</option>
                    </select>
                    {/* Frontend mode only — backend mode never has the frames
                        in the browser, and shipping raw subs over HTTP to blink
                        them is not viable at ~50 MB each. */}
                    {blinkFiles.length > 0 && (
                      <button className="btn btn-secondary" onClick={() => setBlinkOpen(true)} disabled={importing}
                        title="Flick through this target/filter's frames and keep or drop them by eye">
                        ◫ Blink {blinkFiles.length}
                      </button>
                    )}
                    <span className="cell-muted import-quality-stats" style={{ fontSize: '0.8rem' }}>
                      {analyzing && importProgress
                        ? `Analyzing… ${importProgress.current} / ${importProgress.total}${analyzedCountAll > 0 ? ` · ${analyzedCountAll} measured so far` : ''}`
                        : !measured
                          ? <>Not measured yet{handDroppedActive > 0 ? ` · ${handDroppedActive} dropped by hand` : ''} — analyze to set an approve line, or blink through them as they are.</>
                          : <>
                              {analyzedCount} analyzed{avgStars > 0 ? ` · ~${avgStars} stars/frame` : ''}
                              {qualityMetric === 'psfsw'
                                ? activeAnchor
                                  ? ` · 1.0 = this target/filter's median of ${activeAnchor.subs} sub${activeAnchor.subs !== 1 ? 's' : ''}, fixed ${activeAnchor.set_at.slice(0, 10)}`
                                  : ' · first light — this batch fixes the scale'
                                : ' · px'} · {rejectedCount} will be skipped{handDroppedActive > 0 ? ` (${handDroppedActive} dropped by hand)` : ''}
                              {analysisErrors > 0 ? ` · ${analysisErrors} not measurable (kept)` : ''}
                              {historicalForMetric.length > 0 ? ` · band + dots = ${historicalForMetric.length} past sub${historicalForMetric.length !== 1 ? 's' : ''} (same target/filter)` : ''}
                            </>}
                    </span>
                  </div>
                  {analyzing && importProgress && importProgress.total > 0 && (
                    <div className="progress-bar" style={{ margin: '0.25rem 0 0.5rem' }}>
                      <div className="progress-bar__fill" style={{ width: `${Math.round((importProgress.current / importProgress.total) * 100)}%` }} />
                    </div>
                  )}
                  {(analyzing || measured) && (
                    <p className="cell-muted" style={{ fontSize: '0.8rem', margin: '0.25rem 0 0.5rem' }}>
                      {analyzing
                        ? 'Results appear as each frame is measured — the approve line unlocks when analysis finishes.'
                        : `Drag the ▸ handle to set the approve line for ${qualityGroups.length > 1 ? 'this target/filter' : 'this batch'} — only frames ${goodDirection === 'above' ? 'above' : 'below'} it are copied. Blink can drop further frames by eye, but never rescues one the line has already cut.`}
                      {!analyzing && qualityGroups.length > 1 && (
                        <> Each target/filter keeps its own line: {rejectedCountAll} of {analyzedCountAll} frames will be skipped across all {qualityGroups.length} groups.</>
                      )}
                    </p>
                  )}
                  {/* The chart only exists once there is something to plot; an
                      unmeasured batch just shows the picker and Blink. */}
                  {(analyzing || measured) && (snrPoints.length > 0 ? (
                    <SnrChart points={snrPoints} threshold={activeThreshold ?? 0}
                      onThresholdChange={v => activeGroup && setThresholds(t => ({ ...t, [activeGroup.key]: v }))}
                      metricLabel={metricLabel} goodDirection={goodDirection} historical={historicalForMetric} disabled={analyzing}
                      droppedFiles={droppedFrames}
                      />
                  ) : (
                    <p className="cell-muted" style={{ fontSize: '0.85rem', padding: '2rem 0', textAlign: 'center' }}>
                      Waiting for frames…
                    </p>
                  ))}
                  {analyzing ? (
                    <button className="btn btn-ghost" style={{ marginTop: '0.5rem' }} onClick={() => analyzeAbortRef.current?.abort()}>
                      ■ Stop analysis
                    </button>
                  ) : rejectedCount > 0 && (
                    <button className="btn btn-ghost" style={{ marginTop: '0.5rem' }} onClick={() => setShowRejectedList(true)}>
                      📋 View {rejectedCount} rejected…
                    </button>
                  )}
                  {showRejectedList && (
                    <FileListDialog
                      title={`Frames that will be skipped — ${activeGroup?.label ?? ''}`}
                      files={rejectedFiles}
                      onClose={() => setShowRejectedList(false)}
                    />
                  )}
                </div>
              )}
              {!analyzing && snrResults.size > 0 && analyzedCountAll === 0 && (
                <div className="import-warnings">
                  No SNR could be measured — files may not be mono FITS images.
                </div>
              )}

              {preview.map(session => (
                <div key={session.dateKey} className="import-session-block">
                  <div className="import-session-header">
                    <span className="cell-name">{session.name}</span>
                    <span className="cell-muted" style={{ fontSize: '0.8rem' }}>{session.startTime.toLocaleString()}</span>
                  </div>
                  <table className="data-table" style={{ marginTop: '0.5rem' }}>
                    <thead>
                      <tr><th>Object</th><th>Filter</th><th>Exposure</th><th>Frames</th><th>Plan</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {session.entries.map((entry, i) => {
                        const activePlans = entry.objectId ? allPlans.filter(p => p.object === entry.objectId && p.active) : []
                        const planId = getEntryPlanId(session.dateKey, entry)
                        return (
                          <tr key={i}>
                            <td className={entry.objectId ? 'cell-name' : 'cell-muted'}>{entry.objectName ?? entry.target}</td>
                            <td>
                              <span className={`type-badge${entry.filterId ? '' : ' type-badge--warn'}`}>
                                {entry.filterName ?? entry.filter}
                              </span>
                            </td>
                            <td>{entry.duration}s</td>
                            <td>
                              {entry.canImport && approvedFrames(entry) !== entry.frames
                                ? <>{approvedFrames(entry)} <span className="cell-muted">of {entry.frames}</span></>
                                : entry.frames}
                            </td>
                            <td>
                              {activePlans.length > 0 ? (
                                <select
                                  value={planId ?? ''}
                                  onChange={e => setEntryPlan(session.dateKey, entry, e.target.value ? Number(e.target.value) : null)}
                                  style={{ fontSize: '0.85rem' }}>
                                  <option value="">— none —</option>
                                  {activePlans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                                </select>
                              ) : (
                                <span className="cell-muted">—</span>
                              )}
                            </td>
                            <td>
                              {entry.canImport
                                ? <span className="status-ok">✓</span>
                                : <span className="status-warn" title={entry.warning ?? ''}>✗ {entry.warning}</span>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ))}

              {/* ── Target assignments ── */}
              {(matchedTargets.length > 0 || unresolvedTargets.length > 0) && (
                <div className="unresolved-panel">
                  <p className="unresolved-panel__title">Target assignments</p>

                  {matchedTargets.map(target => {
                    const entry = preview.flatMap(s => s.entries).find(e => e.target === target)!
                    return (
                      <div key={target} className="unresolved-row">
                        <code className="inline-code unresolved-row__name">{target}</code>
                        <div className="unresolved-row__actions">
                          <span className="target-matched-badge">matched</span>
                          <select value={String(entry.objectId)}
                            onChange={e => handleOverride(target, e.target.value)}>
                            {objects.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                          </select>
                        </div>
                      </div>
                    )
                  })}

                  {unresolvedTargets.map(target => (
                    <div key={target} className="unresolved-row">
                      <code className="inline-code unresolved-row__name">{target}</code>
                      <div className="unresolved-row__actions">
                        <span className="cell-muted">Alias of</span>
                        <select value={targetAliasTo[target] ?? ''}
                          onChange={e => setTargetAliasTo(m => ({ ...m, [target]: e.target.value }))}>
                          <option value="">select object…</option>
                          {objects.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                        </select>
                        <button className="btn btn-sm"
                          disabled={!targetAliasTo[target] || resolvingTarget === target}
                          onClick={() => handleAddAlias(target)}>
                          {resolvingTarget === target ? '…' : 'Add alias'}
                        </button>
                        <span className="cell-muted unresolved-row__or">or</span>
                        <button className="btn btn-sm" onClick={() => setIgnoredTargets(p => [...p, target])}>Ignore</button>
                        <span className="cell-muted unresolved-row__or">or</span>
                        <button className="btn btn-sm" onClick={() => openCreateDialog(target)}>Create new object…</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* ── Filter assignments ── */}
              {(matchedFilterNames.length > 0 || unresolvedFilterNames.length > 0) && (
                <div className="unresolved-panel">
                  <p className="unresolved-panel__title">Filter assignments</p>

                  {matchedFilterNames.map(filterName => {
                    const entry = preview.flatMap(s => s.entries).find(e => e.filter === filterName)!
                    return (
                      <div key={filterName} className="unresolved-row">
                        <code className="inline-code unresolved-row__name">{filterName}</code>
                        <div className="unresolved-row__actions">
                          <span className="target-matched-badge">matched</span>
                          <select value={String(entry.filterId)}
                            onChange={e => handleFilterOverride(filterName, e.target.value)}>
                            {filters.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                          </select>
                        </div>
                      </div>
                    )
                  })}

                  {unresolvedFilterNames.map(filterName => (
                    <div key={filterName} className="unresolved-row">
                      <code className="inline-code unresolved-row__name">{filterName}</code>
                      <div className="unresolved-row__actions">
                        <span className="cell-muted">Alias of</span>
                        <select value={filterAliasTo[filterName] ?? ''}
                          onChange={e => setFilterAliasTo(m => ({ ...m, [filterName]: e.target.value }))}>
                          <option value="">select filter…</option>
                          {filters.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                        </select>
                        <button className="btn btn-sm"
                          disabled={!filterAliasTo[filterName] || resolvingFilter === filterName}
                          onClick={() => handleAddFilterAlias(filterName)}>
                          {resolvingFilter === filterName ? '…' : 'Add alias'}
                        </button>
                        <span className="cell-muted unresolved-row__or">or</span>
                        <button className="btn btn-sm" onClick={() => setIgnoredFilters(p => [...p, filterName])}>Ignore</button>
                        <span className="cell-muted unresolved-row__or">or</span>
                        <button className="btn btn-sm" disabled={resolvingFilter === filterName}
                          onClick={() => handleCreateFilter(filterName)}>
                          {resolvingFilter === filterName ? '…' : 'Create new'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {warnings.length > 0 && (
                <div className="import-warnings">
                  <strong>Warnings:</strong>
                  <ul>{[...new Set(warnings)].map((w, i) => <li key={i}>{w}</li>)}</ul>
                </div>
              )}
            </>
          )}
      </>

      {importResult !== null && (
        <div className="modal-backdrop">
          <div className="import-result-dialog">
            <div className="import-result-dialog__header">
              <span className="import-result-dialog__title">Import complete</span>
            </div>

            <div className="import-result-section">
              <div className="import-result-row import-result-row--ok">
                ✓ {importResult.entriesOk} {importResult.entriesOk === 1 ? 'entry' : 'entries'} imported
                {importResult.sessionsCreated > 0 && <span className="import-result-sub"> · {importResult.sessionsCreated} new session{importResult.sessionsCreated !== 1 ? 's' : ''} created</span>}
              </div>
              {/* The whole result for a night that kept nothing, so the dialog
                  never reports an import that looks like it did nothing. */}
              {importResult.culledRecorded > 0 && (
                <div className="import-result-row import-result-row--muted">
                  — {importResult.culledRecorded} culled sub{importResult.culledRecorded !== 1 ? 's' : ''} recorded against {importResult.culledRecorded !== 1 ? 'their nights' : 'its night'}
                </div>
              )}
              {importResult.entriesSkipped.length > 0 && (
                <div className="import-result-row import-result-row--warn">
                  <button className="import-result-toggle" onClick={() => setResultExpanded(v => v === 'skipped' ? null : 'skipped')}>
                    ⚠ {importResult.entriesSkipped.length} {importResult.entriesSkipped.length === 1 ? 'entry' : 'entries'} skipped
                    <span className="import-result-toggle__arrow">{resultExpanded === 'skipped' ? '▲' : '▼'}</span>
                  </button>
                  {resultExpanded === 'skipped' && (
                    <ul className="import-result-list">
                      {importResult.entriesSkipped.map((e, i) => (
                        <li key={i}><code>{e.target}</code> / {e.filter} — <span className="cell-muted">{e.reason}</span></li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {importResult.entriesFailed.length > 0 && (
                <div className="import-result-row import-result-row--fail">
                  <button className="import-result-toggle" onClick={() => setResultExpanded(v => v === 'failed' ? null : 'failed')}>
                    ✗ {importResult.entriesFailed.length} {importResult.entriesFailed.length === 1 ? 'entry' : 'entries'} failed
                    <span className="import-result-toggle__arrow">{resultExpanded === 'failed' ? '▲' : '▼'}</span>
                  </button>
                  {resultExpanded === 'failed' && (
                    <ul className="import-result-list">
                      {importResult.entriesFailed.map((e, i) => (
                        <li key={i}><code>{e.target}</code> / {e.filter}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            {((importResult.filesCopied + importResult.filesSkipped + importResult.filesNotFound + importResult.filesFailed) > 0 || importResult.copyWarning) && (
              <div className="import-result-section">
                {importResult.filesCopied > 0 && (
                  <div className="import-result-row import-result-row--ok">✓ {importResult.filesCopied} {importResult.filesCopied === 1 ? 'file' : 'files'} copied</div>
                )}
                {importResult.filesSkipped > 0 && (
                  <div className="import-result-row import-result-row--muted">— {importResult.filesSkipped} {importResult.filesSkipped === 1 ? 'file' : 'files'} already existed</div>
                )}
                {importResult.filesNotFound > 0 && (
                  <div className="import-result-row import-result-row--warn">⚠ {importResult.filesNotFound} {importResult.filesNotFound === 1 ? 'file' : 'files'} not found in images folder</div>
                )}
                {importResult.filesFailed > 0 && (
                  <div className="import-result-row import-result-row--fail">✗ {importResult.filesFailed} {importResult.filesFailed === 1 ? 'file' : 'files'} failed to copy</div>
                )}
                {importResult.copyWarning && (
                  <div className="import-result-row import-result-row--warn">⚠ {importResult.copyWarning}</div>
                )}
              </div>
            )}

            {/* Source cleanup. This is the one moment the app knows exactly
                which files a batch came from, so the offer belongs here rather
                than in a later screen that would have to guess. */}
            {(importResult.copiedNames.length > 0 || importResult.culledNames.length > 0) && (
              <div className="import-result-section">
                <div className="import-result-row import-result-row--muted">🗑 Source files</div>
                {canDeleteCopied ? (
                  <div className="import-result-row import-result-row--muted">
                    {importResult.copiedNames.length} imported sub{importResult.copiedNames.length !== 1 ? 's are' : ' is'} now in the object folders — their originals can go.
                  </div>
                ) : importResult.copiedNames.length > 0 && (
                  <div className="import-result-row import-result-row--warn">
                    ⚠ Originals of the {importResult.copiedNames.length} imported sub{importResult.copiedNames.length !== 1 ? 's' : ''} are kept — the copy to the images folder didn't complete.
                  </div>
                )}
                {culledDeleteCount > 0 && (
                  <div className="import-result-row import-result-row--warn">
                    ⚠ The {culledDeleteCount} culled sub{culledDeleteCount !== 1 ? 's' : ''} go{culledDeleteCount === 1 ? 'es' : ''} too — never copied, so this deletes {culledDeleteCount !== 1 ? 'them' : 'it'} outright.
                  </div>
                )}
                {sourceDeleteMsg && (
                  <div className={`import-result-row import-result-row--${sourceDeleteMsg.kind === 'ok' ? 'ok' : sourceDeleteMsg.kind === 'warn' ? 'warn' : 'fail'}`}>
                    {sourceDeleteMsg.kind === 'ok' ? '✓' : sourceDeleteMsg.kind === 'warn' ? '⚠' : '✗'} {sourceDeleteMsg.text}
                  </div>
                )}
                {/* A clean sweep leaves nothing to press again; a partial one
                    keeps the button so the rest can be retried. */}
                <div style={{ display: sourceDeleteMsg?.kind === 'ok' ? 'none' : 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '0.25rem' }}>
                  {confirmDeleteSources ? (
                    <>
                      {/* Spelled out per set: the imported half has a copy in
                          the object folders, the culled half has none. */}
                      <span style={{ color: '#f87171', fontSize: '0.85rem' }}>
                        Permanently delete {sourceDeleteNames.length} file{sourceDeleteNames.length !== 1 ? 's' : ''} from the source folder
                        {culledDeleteCount > 0 && copiedDeleteCount > 0 ? ` (${copiedDeleteCount} imported · ${culledDeleteCount} culled)` : ''}?
                      </span>
                      <button className="btn btn-danger" onClick={handleDeleteSources} disabled={deletingSources}>
                        {deletingSources ? 'Deleting…' : 'Choose folder & delete'}
                      </button>
                      <button className="btn btn-ghost" onClick={() => setConfirmDeleteSources(false)} disabled={deletingSources}>Cancel</button>
                    </>
                  ) : (
                    <button className="btn btn-danger" onClick={() => { setSourceDeleteMsg(null); setConfirmDeleteSources(true) }}
                      disabled={deletingSources || sourceDeleteNames.length === 0}
                      title='You pick the folder they came from; the browser only allows deleting inside a folder you choose'>
                      🗑 Delete {sourceDeleteNames.length} source sub{sourceDeleteNames.length !== 1 ? 's' : ''}
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="import-result-actions">
              <button className="btn btn-primary" onClick={() => { setImportResult(null); setResultExpanded(null); setConfirmDeleteSources(false); setSourceDeleteMsg(null); try { onImported() } catch {} }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Analysis reports progress inline in the chart block; only the import
          step uses this blocking modal. */}
      {importProgress !== null && !analyzing && (
        <div className="modal-backdrop">
          <div className="progress-dialog">
            <p className="progress-dialog__step">{importProgress.step}</p>
            {importProgress.total > 0 ? (
              <>
                <div className="progress-bar">
                  <div className="progress-bar__fill" style={{ width: `${Math.round((importProgress.current / importProgress.total) * 100)}%` }} />
                </div>
                <p className="progress-dialog__count">{importProgress.current} / {importProgress.total}</p>
              </>
            ) : (
              <div className="progress-bar progress-bar--indeterminate" />
            )}
          </div>
        </div>
      )}

      {createDialog !== null && (
        <div className="modal-backdrop" onClick={() => setCreateDialog(null)}>
          <div className="modal-dialog" onClick={e => e.stopPropagation()}>
            <div className="modal-dialog__header">
              <span className="modal-dialog__title">New Object</span>
              <button className="btn btn-ghost" onClick={() => setCreateDialog(null)}>✕</button>
            </div>
            <form onSubmit={e => { e.preventDefault(); handleCreateDialogSubmit() }}>
              <div className="form-field">
                <label>Name</label>
                <input value={createDialogForm.name} autoFocus
                  onChange={e => setCreateDialogForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="form-field">
                <label>Type</label>
                <select value={createDialogForm.typeId}
                  onChange={e => setCreateDialogForm(f => ({ ...f, typeId: e.target.value }))}>
                  {objectTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div className="form-field">
                <label>Aliases <span className="cell-muted" style={{ fontWeight: 400, fontSize: '0.8rem' }}>(semicolon-separated)</span></label>
                <input value={createDialogForm.aliases}
                  onChange={e => setCreateDialogForm(f => ({ ...f, aliases: e.target.value }))}
                  placeholder="e.g. M31;Andromeda Galaxy" />
              </div>
              <div className="form-field">
                <label>Folder</label>
                <input value={createDialogForm.folder}
                  onChange={e => setCreateDialogForm(f => ({ ...f, folder: e.target.value }))}
                  placeholder="e.g. M31" spellCheck={false} />
              </div>
              <div className="form-field">
                <label>Position JSON</label>
                <input value={createDialogForm.position_json}
                  onChange={e => setCreateDialogForm(f => ({ ...f, position_json: e.target.value }))}
                  placeholder='{"ra": "00h42m44s", "dec": "+41d16m09s"}' spellCheck={false} />
              </div>
              <div className="form-field">
                <label>Comment</label>
                <textarea value={createDialogForm.comment} rows={2}
                  onChange={e => setCreateDialogForm(f => ({ ...f, comment: e.target.value }))} />
              </div>
              <div className="form-field form-field--checkbox">
                <input type="checkbox" id="create-dialog-active" checked={createDialogForm.active}
                  onChange={e => setCreateDialogForm(f => ({ ...f, active: e.target.checked }))} />
                <label htmlFor="create-dialog-active">Active</label>
              </div>
              <div className="form-actions">
                <button type="submit" className="btn btn-primary"
                  disabled={createDialogSubmitting || !createDialogForm.name.trim()}>
                  {createDialogSubmitting ? 'Creating…' : 'Create'}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setCreateDialog(null)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {blinkOpen && (
        <BlinkViewer
          title={activeGroup?.label ?? 'Frames to import'}
          files={blinkFiles}
          scope="import"
          dropped={droppedFrames}
          belowLine={name => !clearsLine(name)}
          onToggleDrop={name => setDroppedFrames(prev => {
            const next = new Set(prev)
            next.has(name) ? next.delete(name) : next.add(name)
            return next
          })}
          onClose={() => setBlinkOpen(false)}
        />
      )}
    </div>
  )
}
