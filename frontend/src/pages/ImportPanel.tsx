import { useState, useEffect, useRef } from 'react'
import {
  getObjects, getFilters, getExposures, getObjectTypes, getSessions,
  createSession, createObjectSession,
  updateObject, createObject,
  updateFilter, createFilter,
  checkImported, recordImported, copyFilesToObjectFolders,
  getPlans, setPlanSession, createPlan, createPlanDetail,
} from '../api'
import type { CopyItem } from '../api'
import type { ApObject, ApObjectType, ApFilter, ApExposure, ApSession, ApPlan } from '../types'

interface ImportResult {
  sessionsCreated: number
  entriesOk: number
  entriesFailed: Array<{ target: string; filter: string }>
  entriesSkipped: Array<{ target: string; filter: string; reason: string }>
  filesCopied: number
  filesSkipped: number
  filesNotFound: number
  filesFailed: number
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
  const [objects, setObjects] = useState<ApObject[]>([])
  const [objectTypes, setObjectTypes] = useState<ApObjectType[]>([])
  const [filters, setFilters] = useState<ApFilter[]>([])
  const [exposures, setExposures] = useState<ApExposure[]>([])
  const [sessions, setSessions] = useState<ApSession[]>([])
  const [patterns, setPatterns] = useState<string[]>([DEFAULT_PATTERN])
  const [dayStartHour, setDayStartHour] = useState(16)
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

  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (folderInputRef.current) folderInputRef.current.setAttribute('webkitdirectory', '')
  }, [])

  useEffect(() => {
    Promise.all([getObjects(), getFilters(), getExposures(), fetchPatterns(), getObjectTypes(), getSessions(), getPlans(), fetchDayStartHour()])
      .then(([o, f, e, p, ot, s, pl, dsh]) => {
        setObjects(o); setFilters(f); setExposures(e); setPatterns(p); setObjectTypes(ot); setSessions(s); setAllPlans(pl); setDayStartHour(dsh)
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

  // ── import ───────────────────────────────────────────────────
  const importableCount = preview?.flatMap(s => s.entries).filter(e => e.canImport).length ?? 0
  const importableSessions = preview?.filter(s => s.entries.some(e => e.canImport)) ?? []

  const handleImport = async () => {
    setImporting(true); setError(null); setImportResult(null); setResultExpanded(null)
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
        }
      }

      setImportProgress({ step: 'Creating plans…', current: 0, total: 0 })
      for (const [objectId, objSessionIds] of createdObjSessionsByObject.entries()) {
        if (allPlans.some(p => p.object === objectId)) continue
        try {
          const entries = entriesByObject.get(objectId)!
          const newPlan = await createPlan({ object: objectId, name: entries[0].objectName ?? String(objectId), active: true })
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

      const copyItems: CopyItem[] = []
      for (const s of importableSessions) {
        for (const entry of s.entries.filter(e => e.canImport)) {
          const obj = objects.find(o => o.id === entry.objectId)
          if (obj?.folder && entry.fileNames.length) {
            const filt = filters.find(f => f.id === entry.filterId)
            const filterFolder = filt?.folder ?? filt?.name ?? entry.filterName ?? ''
            if (filterFolder)
              copyItems.push({ fileNames: entry.fileNames, objectFolder: obj.folder, filterName: filterFolder })
          }
        }
      }
      let filesCopied = 0, filesSkipped = 0, filesNotFound = 0, filesFailed = 0
      if (copyItems.length) {
        const totalFiles = copyItems.reduce((n, i) => n + i.fileNames.length, 0)
        setImportProgress({ step: `Copying ${totalFiles} file${totalFiles !== 1 ? 's' : ''}…`, current: 0, total: 0 })
        const stats = await copyFilesToObjectFolders(copyItems).catch(() => null)
        if (stats) { filesCopied = stats.copied; filesSkipped = stats.skipped; filesNotFound = stats.notFound; filesFailed = stats.failed }
      }

      setImportProgress(null)
      setImportResult({ sessionsCreated, entriesOk: entryCount, entriesFailed, entriesSkipped, filesCopied, filesSkipped, filesNotFound, filesFailed })
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
                  <button className="btn btn-primary" onClick={handleImport} disabled={importing}>
                    {importing ? 'Importing…' : `Import ${importableCount} entr${importableCount !== 1 ? 'ies' : 'y'}`}
                  </button>
                )}
              </div>

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

            {(importResult.filesCopied + importResult.filesSkipped + importResult.filesNotFound + importResult.filesFailed) > 0 && (
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
              </div>
            )}

            <div className="import-result-actions">
              <button className="btn btn-primary" onClick={() => { setImportResult(null); setResultExpanded(null); try { onImported() } catch {} }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {importProgress !== null && (
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
