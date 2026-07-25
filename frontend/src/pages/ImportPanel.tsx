import { useState, useEffect, useRef } from 'react'
import {
  getObjects, getFilters, getExposures, getObjectTypes, getSessions,
  createSession, createObjectSession,
  updateObject, createObject,
  updateFilter, createFilter,
  checkImported, recordImported,
  getPlans, setPlanSession, createPlan, createPlanDetail,
  analyzeFitsViaBackend, copyFilesViaBackend, saveImportedAnalysis, getImportedRecords,
} from '../api'
import { analyzeFitsFiles } from '../utils/fitsAnalysis'
import type { FitsAnalysis } from '../utils/fits'
import { ensureImagesFolderAccess, copyFilesToObjectFolders, type CopyItem } from '../utils/imagesFolder'
import type { ApObject, ApObjectType, ApFilter, ApExposure, ApSession, ApPlan } from '../types'
import { useEquipment } from '../context/EquipmentContext'
import SnrChart, { type SnrPoint } from '../components/SnrChart'
import FileListDialog from '../components/FileListDialog'

interface ImportResult {
  sessionsCreated: number
  entriesOk: number
  entriesFailed: Array<{ target: string; filter: string }>
  entriesSkipped: Array<{ target: string; filter: string; reason: string }>
  filesCopied: number
  filesSkipped: number
  filesNotFound: number
  filesFailed: number
  copyWarning: string | null
}
import {
  DEFAULT_PATTERN, fetchPatterns, parseFileMulti, parseFile, patternToRegex, dateKey, toDatetimeLocal,
  matchObject, matchFilter, matchExposure, getPatternAcceptMulti,
  fetchDayStartHour, fetchImportFileMode, type ImportFileMode,
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
  const [importFileMode, setImportFileMode] = useState<ImportFileMode>('frontend')
  const [lookupReady, setLookupReady] = useState(false)

  const [rawFiles, setRawFiles] = useState<File[]>([])
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

  // ── quality analysis / frame approval ─────────────────────────
  const [snrResults, setSnrResults] = useState<Map<string, FitsAnalysis>>(new Map())
  // Both metrics are measured in one pass; this selects which is shown and
  // culled against. PSFSW: higher is better (normalized to median ≈ 1.0);
  // FWHM: lower is better (raw pixels).
  const [qualityMetric, setQualityMetric] = useState<'psfsw' | 'fwhm'>('psfsw')
  // Values of previously-analyzed subs sharing this batch's target+filter
  // (different files), time-ordered — background context for the chart.
  // PSFSW is normalized to the live median; FWHM is raw px.
  const [snrHistorical, setSnrHistorical] = useState<number[]>([])
  const [fwhmHistorical, setFwhmHistorical] = useState<number[]>([])
  const [snrThreshold, setSnrThreshold] = useState<number | null>(null)
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

  // Closing the panel stops a running analysis instead of letting it keep
  // hammering the worker / server in the background.
  useEffect(() => () => analyzeAbortRef.current?.abort(), [])

  useEffect(() => {
    if (folderInputRef.current) folderInputRef.current.setAttribute('webkitdirectory', '')
  }, [])

  useEffect(() => {
    Promise.all([getObjects(activeId), getFilters(), getExposures(), fetchPatterns(), getObjectTypes(), getSessions(activeId), getPlans(undefined, activeId), fetchDayStartHour(), fetchImportFileMode()])
      .then(([o, f, e, p, ot, s, pl, dsh, ifm]) => {
        setObjects(o); setFilters(f); setExposures(e); setPatterns(p); setObjectTypes(ot); setSessions(s); setAllPlans(pl); setDayStartHour(dsh); setImportFileMode(ifm)
        setLookupReady(true)
      })
      .catch(() => setError('Failed to load lookup data'))
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
    setSnrResults(new Map()); setSnrThreshold(null); setSnrHistorical([]); setFwhmHistorical([])

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

  const handleAnalyzeSnr = async () => {
    if (!importableFileNames.length) return
    setAnalyzing(true); setError(null)
    setSnrResults(new Map()); setSnrThreshold(null); setSnrHistorical([]); setFwhmHistorical([])
    const ctrl = new AbortController()
    analyzeAbortRef.current = ctrl

    // Accumulated raw frames, re-normalized and pushed to the chart after each
    // batch / frame so results render live while analysis is still running.
    const raw: FitsAnalysis[] = []
    // Historical subs matched to this batch's target+filter, time-ordered.
    let historicalMatched: { psfsw: number | null; fwhm: number | null; time: number }[] = []
    // Renders the historical band/dots. PSFSW is normalized by the supplied
    // median so it shares the axis with the incoming frames; FWHM stays raw px.
    // Called once as soon as the historical set is gathered (with the
    // historical's own median as a stand-in) so the band never lags behind the
    // live dots, then again from commit() with the live median.
    const pushHistorical = (median: number) => {
      setSnrHistorical(historicalMatched
        .filter(h => h.psfsw != null)
        .map(h => median > 0 ? Math.round((h.psfsw! / median) * 1000) / 1000 : h.psfsw!))
      setFwhmHistorical(historicalMatched.filter(h => h.fwhm != null).map(h => h.fwhm!))
    }
    const commit = () => {
      if (!raw.length) return
      // Unit-median normalization of PSFSW over every frame so far (PixInsight's
      // K). FWHM is kept raw (pixels).
      const weights = raw.map(r => r.snr).filter((v): v is number => v != null && v > 0).sort((a, b) => a - b)
      const median = weights.length ? weights[weights.length >> 1] : 0
      const normed = median > 0
        ? raw.map(r => r.snr != null ? { ...r, snr: Math.round((r.snr / median) * 1000) / 1000 } : r)
        : raw
      setSnrResults(new Map(normed.map(r => [r.fileName, r])))
      // Keep the approve line at the "approve everything" default for the active
      // metric until analysis finishes and the user drags it.
      if (qualityMetricRef.current === 'psfsw') {
        const snrs = normed.map(r => r.snr).filter((v): v is number => v != null)
        setSnrThreshold(snrs.length ? Math.min(...snrs) : null)
      } else {
        const fwhms = normed.map(r => r.fwhm).filter((v): v is number => v != null)
        setSnrThreshold(fwhms.length ? Math.max(...fwhms) : null)
      }
      // Historical spread, re-normalized by the live median now that frames exist.
      pushHistorical(median)
    }

    try {
      setImportProgress({ step: 'Analyzing frame quality…', current: 0, total: importableFileNames.length })

      // Gather the historical spread up front: PSFSW + FWHM of previously-analyzed
      // subs (different files) whose parsed target+filter matches an entry in
      // this batch. Fetched before the loop so the context can render live.
      try {
        const analyzedSet = new Set(importableFileNames)
        const pairSet = new Set(
          (preview ?? []).flatMap(s => s.entries
            .filter(e => e.canImport && e.objectId != null && e.filterId != null)
            .map(e => `${e.objectId}|${e.filterId}`))
        )
        // Try every configured pattern per record, not just the first that
        // matches: a greedy pattern can swallow a token like a rotation angle
        // ("nessy_270deg") into the target and miss the real object, while a
        // more specific pattern parses it correctly. A record counts if any
        // pattern resolves it to an object+filter pair in this batch.
        const regexes = patterns.map(patternToRegex)
        const records = await getImportedRecords()
        for (const rec of records) {
          if ((rec.psfsw == null && rec.fwhm == null) || analyzedSet.has(rec.filename)) continue
          for (const rx of regexes) {
            const parsed = parseFile(rec.filename, rx)
            if (!parsed) continue
            const obj = matchObject(parsed.target, objects)
            const filt = matchFilter(parsed.filter, filters)
            if (obj && filt && pairSet.has(`${obj.id}|${filt.id}`)) {
              historicalMatched.push({ psfsw: rec.psfsw, fwhm: rec.fwhm, time: parsed.datetime.getTime() })
              break
            }
          }
        }
        historicalMatched.sort((a, b) => a.time - b.time)
        // Render the band straight away, before the first new frame is measured,
        // so it never trails the live dots. PSFSW is normalized by the
        // historical's own median as a stand-in; commit() re-normalizes by the
        // live median once frames arrive (same target/filter, so the two medians
        // nearly coincide — no visible jump).
        const hpsf = historicalMatched.map(h => h.psfsw).filter((v): v is number => v != null && v > 0).sort((a, b) => a - b)
        pushHistorical(hpsf.length ? hpsf[hpsf.length >> 1] : 0)
      } catch { historicalMatched = [] }

      if (importFileMode === 'backend') {
        // Server mode: the backend locates files by name near its images
        // folder. Analyze in batches so results stream in.
        const total = importableFileNames.length
        const BATCH = 6
        for (let i = 0; i < total; i += BATCH) {
          if (ctrl.signal.aborted) break
          try {
            const batch = await analyzeFitsViaBackend(importableFileNames.slice(i, i + BATCH), false, ctrl.signal)
            raw.push(...batch)
            for (const r of batch) rawAnalysisRef.current.set(r.fileName, { psfsw: r.snr, fwhm: r.fwhm })
          } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') break
            throw err
          }
          setImportProgress({ step: 'Analyzing frame quality…', current: Math.min(i + BATCH, total), total })
          commit()
        }
      } else {
        // Browser mode: analyze the picked File objects directly, in a worker,
        // committing each frame as the worker returns it.
        const fileByName = new Map(rawFiles.map(f => [f.name, f]))
        const files = importableFileNames.map(n => fileByName.get(n)).filter((f): f is File => f !== undefined)
        await analyzeFitsFiles(files, (done, total, result) => {
          if (result) { raw.push(result); rawAnalysisRef.current.set(result.fileName, { psfsw: result.snr, fwhm: result.fwhm }) }
          setImportProgress({ step: 'Analyzing frame quality…', current: done, total })
          commit()
        }, ctrl.signal)
      }

      commit() // final normalization over the full set
    } catch {
      setError(importFileMode === 'backend'
        ? 'Quality analysis failed — is the images folder set and reachable on the server?'
        : 'Quality analysis failed')
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
  const historicalForMetric = qualityMetric === 'psfsw' ? snrHistorical : fwhmHistorical

  const measuredPoints: SnrPoint[] = [...snrResults.values()]
    .filter(r => metricValue(r) != null)
    .map(r => ({ fileName: r.fileName, snr: metricValue(r) as number, time: timeForFile(r.fileName) }))
  // While analysis is running, seed a baseline point for every importable file
  // not yet measured so the chart lays out its full x-axis immediately and each
  // point rises in place as its value arrives.
  const pendingPoints: SnrPoint[] = analyzing
    ? importableFileNames
        .filter(n => !snrResults.has(n))
        .map(n => ({ fileName: n, snr: 0, time: timeForFile(n), pending: true }))
    : []
  const snrPoints: SnrPoint[] = [...measuredPoints, ...pendingPoints].sort((a, b) => a.time - b.time)

  const analyzedCount = measuredPoints.length
  const analysisErrors = [...snrResults.values()].filter(r => metricValue(r) == null).length
  const avgStars = (() => {
    const counts = [...snrResults.values()].map(r => r.stars ?? 0).filter(n => n > 0)
    return counts.length ? Math.round(counts.reduce((a, b) => a + b, 0) / counts.length) : 0
  })()
  const rejectedFiles = snrThreshold == null ? [] : measuredPoints
    .filter(p => goodDirection === 'above' ? p.snr < snrThreshold : p.snr > snrThreshold)
    .map(p => p.fileName)
  const rejectedCount = rejectedFiles.length

  // A file is approved if we couldn't measure it (unknown → keep) or it clears the line.
  const isApproved = (fileName: string): boolean => {
    if (snrThreshold == null) return true
    const r = snrResults.get(fileName)
    const v = r ? metricValue(r) : null
    if (v == null) return true
    return goodDirection === 'above' ? v >= snrThreshold : v <= snrThreshold
  }

  // Reset the approve line to "keep everything" for the newly selected metric.
  const handleMetricChange = (m: 'psfsw' | 'fwhm') => {
    qualityMetricRef.current = m
    setQualityMetric(m)
    setShowRejectedList(false)
    const vals = [...snrResults.values()].map(r => m === 'psfsw' ? r.snr : r.fwhm).filter((v): v is number => v != null)
    setSnrThreshold(vals.length ? (m === 'psfsw' ? Math.min(...vals) : Math.max(...vals)) : null)
  }

  // ── import ───────────────────────────────────────────────────
  const importableCount = preview?.flatMap(s => s.entries).filter(e => e.canImport).length ?? 0
  const importableSessions = preview?.filter(s => s.entries.some(e => e.canImport)) ?? []

  const handleImport = async () => {
    setImporting(true); setError(null); setImportResult(null); setResultExpanded(null)

    // In browser mode files are copied via the File System Access API. Acquire
    // folder access first: a permission prompt needs this click's transient
    // user activation, which would be long expired once copying starts.
    const fileByName = new Map(rawFiles.map(f => [f.name, f]))
    const wantsCopy = importableSessions.some(s => s.entries.some(e => {
      if (!e.canImport) return false
      const obj = objects.find(o => o.id === e.objectId)
      return !!obj?.folder && e.fileNames.some(isApproved)
    }))
    let imagesDir: FileSystemDirectoryHandle | null = null
    let copyWarning: string | null = null
    if (wantsCopy && importFileMode === 'frontend') {
      imagesDir = await ensureImagesFolderAccess()
      if (!imagesDir) copyWarning = 'Images folder not accessible — no files were copied. Choose it in Settings and grant access.'
    }

    const totalEntries = importableSessions.reduce((n, s) => n + s.entries.filter(e => e.canImport).length, 0)
    const entriesSkipped = (preview ?? []).flatMap(s =>
      s.entries.filter(e => !e.canImport).map(e => ({ target: e.target, filter: e.filter, reason: e.warning ?? 'Unresolved' }))
    )
    const entriesFailed: Array<{ target: string; filter: string }> = []
    let entryCount = 0, sessionsCreated = 0

    const sessionByDate = new Map<string, number>()
    for (const s of sessions) {
      const dk = dateKey(new Date(s.start), dayStartHour)
      if (!sessionByDate.has(dk)) sessionByDate.set(dk, s.id)
    }

    const createdObjSessionsByObject = new Map<number, number[]>()
    const entriesByObject = new Map<number, ImportEntry[]>()
    const allRecordedNames: string[] = []

    try {
      setImportProgress({ step: 'Importing entries…', current: 0, total: totalEntries })
      for (const s of importableSessions) {
        let sessionId: number
        try {
          if (sessionByDate.has(s.dateKey)) {
            sessionId = sessionByDate.get(s.dateKey)!
          } else {
            const created = await createSession({
              name: s.name, start: toDatetimeLocal(s.startTime),
              duration: null, duration_set: false, comment: 'Imported from folder',
              equipment: activeId,
            })
            sessionId = created.id
            sessionByDate.set(s.dateKey, sessionId)
            sessionsCreated++
          }
        } catch {
          for (const entry of s.entries.filter(e => e.canImport))
            entriesFailed.push({ target: entry.target, filter: entry.filter })
          continue
        }

        const sessionFileNames: string[] = []
        for (const entry of s.entries.filter(e => e.canImport)) {
          try {
            const created = await createObjectSession({
              session: sessionId, object: entry.objectId!,
              filter: entry.filterId!, exposure: entry.exposureId!, frames: entry.frames,
            })
            const planId = getEntryPlanId(s.dateKey, entry)
            if (planId) { try { await setPlanSession({ session: created.id, planid: planId }) } catch {} }
            const objId = entry.objectId!
            createdObjSessionsByObject.set(objId, [...(createdObjSessionsByObject.get(objId) ?? []), created.id])
            entriesByObject.set(objId, [...(entriesByObject.get(objId) ?? []), entry])
            sessionFileNames.push(...entry.fileNames)
            entryCount++
            setImportProgress({ step: 'Importing entries…', current: entryCount, total: totalEntries })
          } catch {
            entriesFailed.push({ target: entry.target, filter: entry.filter })
          }
        }
        if (sessionFileNames.length) {
          try { await recordImported(sessionFileNames, sessionId) } catch {}
          allRecordedNames.push(...sessionFileNames)
        }
      }

      // Persist quality analysis measured during this import onto the records.
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
            if (e.filterId) byFilter.set(e.filterId, (byFilter.get(e.filterId) ?? 0) + e.frames * e.duration)
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
      for (const s of importableSessions) {
        for (const entry of s.entries.filter(e => e.canImport)) {
          const obj = objects.find(o => o.id === entry.objectId)
          const approvedNames = entry.fileNames.filter(isApproved)
          if (obj?.folder && approvedNames.length) {
            const filt = filters.find(f => f.id === entry.filterId)
            const filterFolder = filt?.folder ?? filt?.name ?? entry.filterName ?? ''
            if (filterFolder)
              copyGroups.push({ fileNames: approvedNames, objectFolder: obj.folder, filterName: filterFolder })
          }
        }
      }
      let filesCopied = 0, filesSkipped = 0, filesNotFound = 0, filesFailed = 0
      if (copyGroups.length && importFileMode === 'backend') {
        const totalFiles = copyGroups.reduce((n, i) => n + i.fileNames.length, 0)
        setImportProgress({ step: `Copying ${totalFiles} file${totalFiles !== 1 ? 's' : ''}…`, current: 0, total: 0 })
        const stats = await copyFilesViaBackend(copyGroups).catch(() => null)
        if (stats) { filesCopied = stats.copied; filesSkipped = stats.skipped; filesNotFound = stats.notFound; filesFailed = stats.failed }
        else copyWarning = 'File copying failed on the server.'
      } else if (copyGroups.length && imagesDir) {
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
      setImportResult({ sessionsCreated, entriesOk: entryCount, entriesFailed, entriesSkipped, filesCopied, filesSkipped, filesNotFound, filesFailed, copyWarning })
      setPreview(null)
    } catch {
      setError('Import failed — check console for details')
    } finally {
      setImporting(false)
      setImportProgress(null)
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
                </span>
                {duplicateCount > 0 && (
                  <span className="import-duplicate-warn">
                    {duplicateCount} duplicate{duplicateCount !== 1 ? 's' : ''} already imported, skipped
                  </span>
                )}
                {importableCount > 0 && (
                  <button className="btn btn-secondary" onClick={handleAnalyzeSnr} disabled={analyzing || importing}>
                    {analyzing ? 'Analyzing…' : snrResults.size ? '↻ Re-analyze quality' : '📈 Analyze quality'}
                  </button>
                )}
                {importableCount > 0 && (
                  <button className="btn btn-primary" onClick={handleImport} disabled={importing || analyzing}>
                    {importing ? 'Importing…' : `Import ${importableCount} entr${importableCount !== 1 ? 'ies' : 'y'}`}
                  </button>
                )}
              </div>

              {(analyzing || (snrResults.size > 0 && snrThreshold != null && analyzedCount > 0)) && (
                <div className="import-session-block">
                  <div className="import-session-header">
                    <span className="cell-name">Frame quality</span>
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
                    <span className="cell-muted" style={{ fontSize: '0.8rem' }}>
                      {analyzing && importProgress
                        ? `Analyzing… ${importProgress.current} / ${importProgress.total}${analyzedCount > 0 ? ` · ${analyzedCount} measured so far` : ''}`
                        : <>
                            {analyzedCount} analyzed{avgStars > 0 ? ` · ~${avgStars} stars/frame` : ''}{qualityMetric === 'psfsw' ? ' · median frame ≈ 1.0' : ' · px'} · {rejectedCount} {goodDirection === 'above' ? 'below' : 'above'} approve line will be skipped
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
                  <p className="cell-muted" style={{ fontSize: '0.8rem', margin: '0.25rem 0 0.5rem' }}>
                    {analyzing
                      ? 'Results appear as each frame is measured — the approve line unlocks when analysis finishes.'
                      : `Drag the ▸ handle to set the approve line — only frames ${goodDirection === 'above' ? 'above' : 'below'} it are copied.`}
                  </p>
                  {snrPoints.length > 0 ? (
                    <SnrChart points={snrPoints} threshold={snrThreshold ?? 0} onThresholdChange={setSnrThreshold}
                      metricLabel={metricLabel} goodDirection={goodDirection} historical={historicalForMetric} disabled={analyzing} />
                  ) : (
                    <p className="cell-muted" style={{ fontSize: '0.85rem', padding: '2rem 0', textAlign: 'center' }}>
                      Waiting for frames…
                    </p>
                  )}
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
                      title="Frames below the approve line"
                      files={rejectedFiles}
                      onClose={() => setShowRejectedList(false)}
                    />
                  )}
                </div>
              )}
              {!analyzing && snrResults.size > 0 && analyzedCount === 0 && (
                <div className="import-warnings">
                  {importFileMode === 'backend'
                    ? 'No SNR could be measured — files may be missing from the images folder, or not mono FITS.'
                    : 'No SNR could be measured — files may not be mono FITS images.'}
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
                            <td>{entry.frames}</td>
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

            <div className="import-result-actions">
              <button className="btn btn-primary" onClick={() => { setImportResult(null); setResultExpanded(null); try { onImported() } catch {} }}>Close</button>
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
    </div>
  )
}
