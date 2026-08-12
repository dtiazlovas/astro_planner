import React, { useState, useEffect, useRef } from 'react'
import { getObjects, getObjectTypes, getObjectFilterStats, getObjectPlanProgress, getPlans, assignToActivePlan, createObject, updateObject, deleteObject, reorderObjects, getFilters, getExposures, getSessions, getImportedRecords, getObjectFolderFilesViaBackend, analyzeFitsViaBackend, deleteObjectFilesViaBackend, saveImportedAnalysis, openFitsFile } from '../api'
import type { ApObject, ApObjectType, ObjectFilterStat, PlanProgressItem } from '../types'
import { fetchPatterns, fetchImportFileMode, fetchDayStartHour, type ImportFileMode } from '../utils/filePattern'
import { ensureImagesFolderAccess, listObjectFolderFiles, getObjectFolderFiles, deleteObjectFolderFiles } from '../utils/imagesFolder'
import { scanObjectFiles, applyObjectSync, cullSubset, type SyncScanResult } from '../utils/objectSync'
import { analyzeFitsFiles } from '../utils/fitsAnalysis'
import type { FitsAnalysis } from '../utils/fits'
import SnrChart, { type SnrPoint } from '../components/SnrChart'
import FileListDialog from '../components/FileListDialog'
import { useEquipment } from '../context/EquipmentContext'
import PlansPanel from './PlansPanel'
import FilterBadge from '../components/FilterBadge'
import BlinkViewer from '../components/BlinkViewer'

const emptyForm = { name: '', typeId: '', position_json: '', comment: '', aliases: '', active: true, folder: '' }

const fmtDuration = (s: number): string => {
  if (s <= 0) return '—'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `~${h}h ${m}m` : `~${m}m`
}

const fmtMinsH = (minutes: number): string => `${(minutes / 60).toFixed(1)}h`

// Stand-in for a filter with nothing analyzed yet — never written to.
const NO_RESULTS: Map<string, FitsAnalysis> = new Map()

export default function ObjectsPage() {
  const { activeId } = useEquipment()
  const [objects, setObjects] = useState<ApObject[]>([])
  const [types, setTypes] = useState<ApObjectType[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [submitting, setSubmitting] = useState(false)
  const [togglingId, setTogglingId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [confirmingId, setConfirmingId] = useState<number | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())
  const [expandedStats, setExpandedStats] = useState<Map<number, ObjectFilterStat[]>>(new Map())
  const [planProgress, setPlanProgress] = useState<Map<number, PlanProgressItem[]>>(new Map())
  const [loadingIds, setLoadingIds] = useState<Set<number>>(new Set())
  // Plans open as a dialog, so at most one object's plans are shown at a time.
  const [plansForId, setPlansForId] = useState<number | null>(null)
  /** Subs dropped by eye in the sync dialog's blink, culled alongside the limit. */
  const [droppedSubs, setDroppedSubs] = useState<Set<string>>(new Set())
  const [blinkFiles, setBlinkFiles] = useState<{ label: string; files: File[] } | null>(null)
  const [blinkLoading, setBlinkLoading] = useState(false)
  const [activePlanObjectIds, setActivePlanObjectIds] = useState<Set<number>>(new Set())
  const [assigningIds, setAssigningIds] = useState<Set<number>>(new Set())
  const [dragOverId, setDragOverId] = useState<number | null>(null)
  const [importFileMode, setImportFileMode] = useState<ImportFileMode>('frontend')
  const [syncingId, setSyncingId] = useState<number | null>(null)
  const [syncPreview, setSyncPreview] = useState<{ obj: ApObject; scan: SyncScanResult } | null>(null)
  const [syncApplying, setSyncApplying] = useState(false)

  // ── sub-quality analysis inside the sync dialog ──────────────
  // Runs per filter: quality scales differ between filters, so each gets its
  // own normalization and limit.
  const [qualityFilterId, setQualityFilterId] = useState<number | null>(null)
  // Both metrics are measured in one pass; this only selects which one is
  // shown and culled against. PSFSW: higher is better; FWHM: lower is better.
  const [qualityMetric, setQualityMetric] = useState<'psfsw' | 'fwhm'>('psfsw')
  // Results and limit are held per filter, not per pane: switching the filter
  // selector must not throw away what the pane is showing, and switching back
  // has to restore that filter's own measurements and limit unchanged.
  const [qualityResultsByFilter, setQualityResultsByFilter] = useState<Map<number, Map<string, FitsAnalysis>>>(new Map())
  const [qualityThresholdByFilter, setQualityThresholdByFilter] = useState<Map<number, number>>(new Map())
  // Filters actually measured in this dialog — a filter seeded from saved
  // analysis alone hasn't been, so its button still offers the cheap pass.
  const [qualityMeasuredFilters, setQualityMeasuredFilters] = useState<Set<number>>(new Set())
  // Once the first analysis opens the chart it stays open across filter changes.
  const [qualityPaneOpen, setQualityPaneOpen] = useState(false)
  const [qualityAnalyzing, setQualityAnalyzing] = useState(false)
  const [qualityProgress, setQualityProgress] = useState<{ current: number; total: number } | null>(null)
  const [qualityDeleting, setQualityDeleting] = useState(false)
  const [confirmDeleteSubs, setConfirmDeleteSubs] = useState(false)
  const [showCullList, setShowCullList] = useState(false)
  const qualityAbortRef = useRef<AbortController | null>(null)

  // Closing the dialog (or leaving the page) stops a running analysis instead
  // of letting it keep hammering the worker / server in the background.
  useEffect(() => () => qualityAbortRef.current?.abort(), [])
  const closeSyncPreview = () => {
    qualityAbortRef.current?.abort()
    setSyncPreview(null)
  }

  useEffect(() => {
    const load = async () => {
      try {
        const [objs, ts, plans] = await Promise.all([getObjects(activeId), getObjectTypes(), getPlans(undefined, activeId)])
        setObjects(objs)
        setTypes(ts)
        const activePlanObjIds = [...new Set(plans.filter(p => p.active).map(p => p.object))]
        setActivePlanObjectIds(new Set(activePlanObjIds))
        const progressResults = await Promise.all(
          activePlanObjIds.map(id => getObjectPlanProgress(id, activeId).catch(() => [] as PlanProgressItem[]))
        )
        const map = new Map<number, PlanProgressItem[]>()
        activePlanObjIds.forEach((id, i) => {
          if (progressResults[i].length > 0) map.set(id, progressResults[i])
        })
        setPlanProgress(map)
      } catch {
        setError('Failed to load data')
      } finally {
        setLoading(false)
      }
    }
    load()
    // Collapse any rig-specific expanded state when switching rigs
    setExpandedIds(new Set()); setExpandedStats(new Map()); setPlansForId(null)
  }, [activeId])

  // Loaded up-front so the sync click can request folder permission while the
  // click's transient user activation is still fresh.
  useEffect(() => { fetchImportFileMode().then(setImportFileMode) }, [])

  // Reads the object's folder and diffs it against the DB. Separate from the
  // dialog state so the cull can scan, apply and re-scan in one go.
  const scanObject = async (obj: ApObject): Promise<SyncScanResult> => {
    let present: string[]
    if (importFileMode === 'backend') {
      present = await getObjectFolderFilesViaBackend(obj.folder!)
    } else {
      const dir = await ensureImagesFolderAccess()
      if (!dir) throw new Error('Images folder not accessible — choose it in Settings and grant access')
      present = await listObjectFolderFiles(dir, obj.folder!)
    }
    const [filters, exposures, patterns, sessions, imported, dayStartHour] = await Promise.all([
      getFilters(), getExposures(), fetchPatterns(), getSessions(), getImportedRecords(), fetchDayStartHour(),
    ])
    return scanObjectFiles(obj, objects, present, imported, filters, exposures, patterns, sessions, dayStartHour, activeId)
  }

  // Pulls the list's view of one object back in line after its stats changed.
  const refreshObjectStats = async (id: number) => {
    setObjects(await getObjects(activeId))
    if (expandedIds.has(id)) {
      getObjectFilterStats(id, activeId)
        .then(s => setExpandedStats(prev => new Map(prev).set(id, s)))
        .catch(() => {})
    }
    if (activePlanObjectIds.has(id)) {
      getObjectPlanProgress(id, activeId)
        .then(p => setPlanProgress(prev => new Map(prev).set(id, p)))
        .catch(() => {})
    }
  }

  const handleSync = async (obj: ApObject, keepQuality = false) => {
    if (!obj.folder) return
    setSyncingId(obj.id); setError(null)
    if (!keepQuality) {
      setQualityResultsByFilter(new Map()); setQualityThresholdByFilter(new Map())
      setQualityMeasuredFilters(new Set()); setQualityPaneOpen(false)
      setConfirmDeleteSubs(false); setQualityFilterId(null)
      setDroppedSubs(new Set())
    }
    try {
      setSyncPreview({ obj, scan: await scanObject(obj) })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync scan failed')
    } finally {
      setSyncingId(null)
    }
  }

  const handleApplySync = async () => {
    if (!syncPreview) return
    setSyncApplying(true); setError(null)
    try {
      const applied = await applyObjectSync(syncPreview.obj, syncPreview.scan, activeId)
      if (applied.failedGroups > 0) {
        setError(`${applied.failedGroups} sync group${applied.failedGroups !== 1 ? 's' : ''} failed to update — their records were kept, run sync again`)
      }
      await refreshObjectStats(syncPreview.obj.id)
      setSyncPreview(null)
    } catch {
      setError('Failed to apply sync — stats may be partially updated, run sync again')
    } finally {
      setSyncApplying(false)
    }
  }

  // ── sub-quality analysis / culling ───────────────────────────
  const analyzableFilters = [...new Map(
    (syncPreview?.scan.analyzableFiles ?? []).map(f => [f.filterId, f.filterName])
  ).entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  const activeQualityFilterId = qualityFilterId ?? analyzableFilters[0]?.id ?? null
  const qualityFilterFiles = (syncPreview?.scan.analyzableFiles ?? []).filter(f => f.filterId === activeQualityFilterId)

  const metricValue = (r: FitsAnalysis): number | null => qualityMetric === 'psfsw' ? r.snr : r.fwhm
  // Default limit keeps everything: min for PSFSW (cull below), max for FWHM (cull above).
  const defaultThreshold = (results: Iterable<FitsAnalysis>, metric: 'psfsw' | 'fwhm'): number | null => {
    const vals = [...results].map(r => metric === 'psfsw' ? r.snr : r.fwhm).filter((v): v is number => v != null)
    if (!vals.length) return null
    return metric === 'psfsw' ? Math.min(...vals) : Math.max(...vals)
  }

  // What the pane shows: the active filter's slice of the per-filter state.
  const qualityResults = (activeQualityFilterId != null ? qualityResultsByFilter.get(activeQualityFilterId) : null) ?? NO_RESULTS
  const qualityThreshold = (activeQualityFilterId != null ? qualityThresholdByFilter.get(activeQualityFilterId) : null) ?? null
  const setQualityThreshold = (v: number) => {
    if (activeQualityFilterId != null) setQualityThresholdByFilter(prev => new Map(prev).set(activeQualityFilterId, v))
  }

  // Saved analysis for one filter's subs, normalized to unit median exactly as
  // a fresh run is — enough to keep the chart populated when the filter is
  // switched, without measuring anything.
  const storedResultsFor = (filterId: number): Map<string, FitsAnalysis> => {
    const files = (syncPreview?.scan.analyzableFiles ?? []).filter(f => f.filterId === filterId && f.storedPsfsw != null)
    const weights = files.map(f => f.storedPsfsw!).filter(v => v > 0).sort((a, b) => a - b)
    const median = weights.length ? weights[weights.length >> 1] : 0
    return new Map(files.map(f => [f.name, {
      fileName: f.name,
      snr: median > 0 ? Math.round((f.storedPsfsw! / median) * 1000) / 1000 : f.storedPsfsw,
      fwhm: f.storedFwhm,
      dateObs: null, width: null, height: null,
    }]))
  }

  const qualityTimeByName = new Map((syncPreview?.scan.analyzableFiles ?? []).map(f => [f.name, f.time]))
  const measuredPoints: SnrPoint[] = [...qualityResults.values()]
    .filter(r => metricValue(r) != null)
    .map(r => ({ fileName: r.fileName, snr: metricValue(r) as number, time: qualityTimeByName.get(r.fileName) ?? 0 }))
  // Subs not measured yet are plotted as faint markers so the run keeps its
  // full width while results stream in — otherwise every new frame re-spreads
  // every x position and the chart jitters for the whole pass.
  const pendingPoints: SnrPoint[] = qualityFilterFiles
    .filter(f => !qualityResults.has(f.name))
    .map(f => ({ fileName: f.name, snr: 0, time: f.time, pending: true }))
  const qualityPoints: SnrPoint[] = [...measuredPoints, ...pendingPoints].sort((a, b) => a.time - b.time)
  const qualityUnmeasured = qualityResults.size - measuredPoints.length
  /** Below the limit on score alone — what the chart's line rejects. */
  const belowLimit = (name: string): boolean => {
    if (qualityThreshold == null) return false
    const r = qualityResults.get(name)
    const v = r ? metricValue(r) : null
    if (v == null) return false
    return qualityMetric === 'psfsw' ? v < qualityThreshold : v > qualityThreshold
  }
  // The limit and a hand drop in blink are both vetoes. Scoped to the filter on
  // screen, because that is the set the delete button acts on.
  const cullFiles = [...new Set(
    qualityFilterFiles.map(f => f.name).filter(n => belowLimit(n) || droppedSubs.has(n)),
  )]
  const handDroppedHere = qualityFilterFiles.filter(f => droppedSubs.has(f.name)).length

  const handleQualityFilterChange = (id: number) => {
    setQualityFilterId(id)
    setConfirmDeleteSubs(false)
    // The pane follows the selector instead of collapsing: the filter being
    // left keeps its own results, and the one arriving shows whatever this
    // dialog already measured for it, else its saved analysis.
    if (qualityPaneOpen && !qualityResultsByFilter.has(id)) {
      const seeded = storedResultsFor(id)
      if (seeded.size) {
        setQualityResultsByFilter(prev => new Map(prev).set(id, seeded))
        const t = defaultThreshold(seeded.values(), qualityMetric)
        if (t != null) setQualityThresholdByFilter(prev => new Map(prev).set(id, t))
      }
    }
  }

  const handleQualityMetricChange = (metric: 'psfsw' | 'fwhm') => {
    setQualityMetric(metric)
    // Every filter's limit is metric-specific — a PSFSW limit is meaningless on
    // an FWHM axis — so reset them all, not just the one on screen.
    const next = new Map<number, number>()
    for (const [id, results] of qualityResultsByFilter) {
      const t = defaultThreshold(results.values(), metric)
      if (t != null) next.set(id, t)
    }
    setQualityThresholdByFilter(next)
    setConfirmDeleteSubs(false)
  }

  // `force` recomputes everything; otherwise persisted values are used and
  // only files without a saved analysis are measured (and then persisted).
  const handleAnalyzeQuality = async (force: boolean) => {
    if (!syncPreview?.obj.folder) return
    if (!qualityFilterFiles.length || activeQualityFilterId == null) return
    // The filter can't change mid-run (its selector is disabled while
    // analyzing), but the results are filed under the one we started on.
    const filterId = activeQualityFilterId
    setQualityAnalyzing(true); setError(null); setConfirmDeleteSubs(false)
    const ctrl = new AbortController()
    qualityAbortRef.current = ctrl
    try {
      const stored: FitsAnalysis[] = force ? [] : qualityFilterFiles
        .filter(f => f.storedPsfsw != null)
        .map(f => ({ fileName: f.name, snr: f.storedPsfsw, fwhm: f.storedFwhm, dateObs: null, width: null, height: null }))
      const storedNames = new Set(stored.map(r => r.fileName))
      const names = qualityFilterFiles.map(f => f.name).filter(n => !storedNames.has(n))

      // Raw PSFSW values (saved and computed alike), normalized to unit
      // median over the combined set. On stop, partial results show.
      const raw: FitsAnalysis[] = []

      /**
       * Publishes what has been measured so far. Called after every frame
       * rather than once at the end, so the chart fills in live instead of
       * staying blank for the whole pass — which on a few hundred subs looks
       * like nothing is happening.
       */
      const commit = () => {
        const all = [...stored, ...raw]
        if (!all.length) return
        const weights = all.map(r => r.snr).filter((v): v is number => v != null && v > 0).sort((a, b) => a - b)
        const median = weights.length ? weights[weights.length >> 1] : 0
        const normed = median > 0
          ? all.map(r => r.snr != null ? { ...r, snr: Math.round((r.snr / median) * 1000) / 1000 } : r)
          : all
        setQualityResultsByFilter(prev => new Map(prev).set(filterId, new Map(normed.map(r => [r.fileName, r]))))
        // Held at "keep everything" until the run finishes; the handle is
        // disabled meanwhile, so this can't fight a drag in progress.
        const t = defaultThreshold(normed, qualityMetric)
        setQualityThresholdByFilter(prev => {
          const next = new Map(prev)
          if (t != null) next.set(filterId, t); else next.delete(filterId)
          return next
        })
        setQualityPaneOpen(true)
      }

      // Saved values are already in hand — show them before decoding anything.
      commit()

      if (names.length) {
        setQualityProgress({ current: 0, total: names.length })
        if (importFileMode === 'backend') {
          const BATCH = 6
          for (let i = 0; i < names.length; i += BATCH) {
            if (ctrl.signal.aborted) break
            try {
              raw.push(...await analyzeFitsViaBackend(names.slice(i, i + BATCH), false, ctrl.signal))
            } catch (err) {
              if (err instanceof DOMException && err.name === 'AbortError') break
              throw err
            }
            setQualityProgress({ current: Math.min(i + BATCH, names.length), total: names.length })
            commit()
          }
        } else {
          const dir = await ensureImagesFolderAccess()
          if (!dir) throw new Error('Images folder not accessible — choose it in Settings and grant access')
          const files = await getObjectFolderFiles(dir, syncPreview.obj.folder, names)
          await analyzeFitsFiles(files, (done, _total, result) => {
            raw.push(result)
            setQualityProgress({ current: done, total: files.length })
            commit()
          }, ctrl.signal)
        }

        // Persist what was just measured on the files' import records.
        const fileByName = new Map(qualityFilterFiles.map(f => [f.name, f]))
        const items = raw
          .filter(r => r.snr != null && fileByName.get(r.fileName)?.recordName)
          .map(r => ({ filename: fileByName.get(r.fileName)!.recordName!, psfsw: r.snr, fwhm: r.fwhm }))
        if (items.length) { try { await saveImportedAnalysis(items) } catch {} }
      }

      // Final publish, then mark the filter as measured in this dialog so the
      // button offers a re-measure rather than the cheap saved-analysis pass.
      commit()
      if (stored.length || raw.length) setQualityMeasuredFilters(prev => new Set(prev).add(filterId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Quality analysis failed')
    } finally {
      qualityAbortRef.current = null
      setQualityAnalyzing(false); setQualityProgress(null)
    }
  }

  const handleDeleteBelowLimit = async () => {
    if (!syncPreview?.obj.folder || !cullFiles.length) return
    setQualityDeleting(true); setError(null)
    try {
      let stats: { deleted: number; failed: number }
      if (importFileMode === 'backend') {
        stats = await deleteObjectFilesViaBackend(syncPreview.obj.folder, cullFiles)
      } else {
        const dir = await ensureImagesFolderAccess()
        if (!dir) throw new Error('Images folder not accessible — choose it in Settings and grant access')
        stats = await deleteObjectFolderFiles(dir, syncPreview.obj.folder, cullFiles)
      }
      if (stats.failed > 0) setError(`${stats.failed} file${stats.failed !== 1 ? 's' : ''} could not be deleted`)
      // These files are gone; keeping them flagged would re-count them against
      // the next scan's cull total.
      setDroppedSubs(prev => {
        const next = new Set(prev)
        for (const n of cullFiles) next.delete(n)
        return next
      })
      const filterId = activeQualityFilterId
      if (filterId != null) setQualityResultsByFilter(prev => {
        const results = prev.get(filterId)
        if (!results) return prev
        const m = new Map(results)
        for (const n of cullFiles) m.delete(n)
        return new Map(prev).set(filterId, m)
      })
      setConfirmDeleteSubs(false)

      // The subs are off disk but the DB still counts them, so the cull isn't
      // finished until its own frame counts and import records follow. Scan,
      // apply just the slots those subs belonged to, then re-scan so the
      // dialog shows what is left. Only the cull's own slots are applied —
      // everything else the scan found stays pending for the Apply button,
      // which is the user's call, not a side effect of deleting.
      const obj = syncPreview.obj
      setSyncingId(obj.id)
      try {
        const scan = await scanObject(obj)
        const cull = cullSubset(scan, cullFiles)
        if (cull.changes.length > 0 || cull.unadjustable.length > 0) {
          const applied = await applyObjectSync(obj, cull, activeId)
          if (applied.failedGroups > 0) {
            setError(`${applied.failedGroups} session entr${applied.failedGroups !== 1 ? 'ies' : 'y'} could not be updated for the deleted subs — run sync again`)
          }
          await refreshObjectStats(obj.id)
          setSyncPreview({ obj, scan: await scanObject(obj) })
        } else {
          // Nothing of the cull was registered — the scan in hand is current.
          setSyncPreview({ obj, scan })
        }
      } finally {
        setSyncingId(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deleting files failed')
    } finally {
      setQualityDeleting(false)
    }
  }

  /**
   * Opens the blink viewer on the filter currently selected in the sync
   * dialog, so what you see is the same set the approve line and the delete
   * button act on. Folder permission is requested here rather than inside the
   * viewer: a re-prompt needs the click's transient activation, which is gone
   * by the time a mount effect runs.
   */
  const handleBlink = async () => {
    const obj = syncPreview?.obj
    if (!obj?.folder || !qualityFilterFiles.length) return
    setError(null); setBlinkLoading(true)
    try {
      const dir = await ensureImagesFolderAccess()
      if (!dir) throw new Error('Images folder is not accessible — choose it in Settings and grant access')
      const names = qualityFilterFiles.map(f => f.name)
      const files = await getObjectFolderFiles(dir, obj.folder, names)
      if (!files.length) throw new Error('None of these subs could be read from the images folder')
      // The folder walk returns tree order; capture order is what makes drift
      // and cloud visible, so sort by the time the scan already resolved.
      const timeOf = new Map(qualityFilterFiles.map(f => [f.name, f.time]))
      files.sort((a, b) => (timeOf.get(a.name) ?? 0) - (timeOf.get(b.name) ?? 0))
      const label = analyzableFilters.find(f => f.id === activeQualityFilterId)?.name ?? 'subs'
      setBlinkFiles({ label: `${obj.name} · ${label}`, files })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the images folder')
    } finally {
      setBlinkLoading(false)
    }
  }

  const handleAssignAll = async (objectId: number) => {
    setAssigningIds(prev => new Set(prev).add(objectId))
    try {
      await assignToActivePlan(objectId, activeId)
      const progress = await getObjectPlanProgress(objectId, activeId)
      setPlanProgress(prev => new Map(prev).set(objectId, progress))
    } catch {
      setError('Failed to assign sessions to plan')
    } finally {
      setAssigningIds(prev => { const s = new Set(prev); s.delete(objectId); return s })
    }
  }

  const typeMap = new Map(types.map(t => [t.id, t.name]))

  // Active first, paused after. Array.sort is stable, so each group keeps its
  // underlying priority order (the drag-reorder ordering). The combined list
  // stays the basis for drag-and-drop, which reorders across the whole set;
  // the two slices below are only how it gets rendered.
  const displayObjects = [...objects].sort((a, b) => Number(b.active) - Number(a.active))
  const activeObjects = displayObjects.filter(o => o.active)
  const pausedObjects = displayObjects.filter(o => !o.active)

  const handleDragStart = (e: React.DragEvent, id: number) => {
    e.dataTransfer.setData('text/plain', String(id))
    e.dataTransfer.effectAllowed = 'move'

    const card = (e.currentTarget as HTMLElement).closest('.obj-card')
    if (card) {
      const rect = card.getBoundingClientRect()
      const ghost = card.cloneNode(true) as HTMLElement
      ghost.style.cssText = `position:absolute;top:-9999px;left:-9999px;width:${rect.width}px;opacity:0.95;`
      document.body.appendChild(ghost)
      e.dataTransfer.setDragImage(ghost, e.clientX - rect.left, e.clientY - rect.top)
      setTimeout(() => document.body.removeChild(ghost), 0)
    }
  }

  const handleDragOver = (e: React.DragEvent, id: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverId(id)
  }

  const handleDrop = async (e: React.DragEvent, targetId: number) => {
    e.preventDefault()
    setDragOverId(null)
    const sourceId = Number(e.dataTransfer.getData('text/plain'))
    if (!sourceId || sourceId === targetId) return
    const newOrder = [...displayObjects]
    const sourceIdx = newOrder.findIndex(o => o.id === sourceId)
    const targetIdx = newOrder.findIndex(o => o.id === targetId)
    if (sourceIdx === -1 || targetIdx === -1) return
    const [removed] = newOrder.splice(sourceIdx, 1)
    const newTargetIdx = newOrder.findIndex(o => o.id === targetId)
    const insertAt = sourceIdx < targetIdx ? newTargetIdx + 1 : newTargetIdx
    newOrder.splice(insertAt, 0, removed)
    setObjects(newOrder)
    try {
      await reorderObjects(newOrder.map(o => o.id))
    } catch {
      setError('Failed to reorder objects')
      try { setObjects(await getObjects(activeId)) } catch {}
    }
  }

  const openAdd = () => {
    setEditingId(null); setForm(emptyForm); setShowForm(true); setError(null)
  }

  const openEdit = (obj: ApObject) => {
    setEditingId(obj.id)
    setForm({ name: obj.name, typeId: String(obj.type), position_json: obj.position_json, comment: obj.comment ?? '', aliases: obj.aliases ?? '', active: obj.active, folder: obj.folder ?? '' })
    setShowForm(true); setConfirmingId(null); setError(null)
  }

  const handleCancel = () => { setShowForm(false); setEditingId(null); setForm(emptyForm); setError(null) }

  const handleSubmit = async (e: { preventDefault(): void }) => {
    e.preventDefault()
    setSubmitting(true); setError(null)
    const payload = { name: form.name.trim(), type: Number(form.typeId), position_json: form.position_json.trim(), comment: form.comment.trim() || null, aliases: form.aliases.trim() || null, active: form.active, folder: form.folder.trim() || null }
    try {
      if (editingId !== null) {
        const updated = await updateObject(editingId, payload)
        setObjects(prev => prev.map(o => o.id === editingId ? updated : o))
      } else {
        const created = await createObject(payload)
        setObjects(prev => [...prev, created])
      }
      setForm(emptyForm); setEditingId(null); setShowForm(false)
    } catch {
      setError(editingId !== null ? 'Failed to update object' : 'Failed to create object')
    } finally {
      setSubmitting(false)
    }
  }

  const handleToggleActive = async (obj: ApObject) => {
    setTogglingId(obj.id)
    try {
      const updated = await updateObject(obj.id, { active: !obj.active })
      setObjects(prev => prev.map(o => o.id === obj.id ? updated : o))
    } catch {
      setError('Failed to update object')
    } finally {
      setTogglingId(null)
    }
  }

  const handleDelete = async (id: number) => {
    setDeletingId(id)
    try {
      await deleteObject(id)
      setObjects(prev => prev.filter(o => o.id !== id))
      setConfirmingId(null)
      if (editingId === id) handleCancel()
      if (expandedIds.has(id)) {
        setExpandedIds(prev => { const s = new Set(prev); s.delete(id); return s })
        setExpandedStats(prev => { const m = new Map(prev); m.delete(id); return m })
      }
    } catch {
      setError('Failed to delete object')
    } finally {
      setDeletingId(null)
    }
  }

  const handleToggleExpand = (obj: ApObject) => {
    if (obj.total_seconds <= 0) return
    if (expandedIds.has(obj.id)) {
      setExpandedIds(prev => { const s = new Set(prev); s.delete(obj.id); return s })
      setExpandedStats(prev => { const m = new Map(prev); m.delete(obj.id); return m })
      return
    }
    setExpandedIds(prev => new Set(prev).add(obj.id))
    setLoadingIds(prev => new Set(prev).add(obj.id))
    getObjectFilterStats(obj.id, activeId)
      .then(s => setExpandedStats(prev => new Map(prev).set(obj.id, s)))
      .catch(() => {})
      .finally(() => setLoadingIds(prev => { const s = new Set(prev); s.delete(obj.id); return s }))
  }

  const set = (field: keyof Omit<typeof emptyForm, 'active'>) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => setForm(f => ({ ...f, [field]: e.target.value }))

  // One object card plus any panel it has expanded. Shared by the active and
  // paused groups so the two lists cannot drift apart.
  const renderObject = (obj: ApObject) => {
    const progress = planProgress.get(obj.id)
    const typeName = typeMap.get(obj.type) ?? String(obj.type)
    const aliases = (obj.aliases ?? '').split(';').map(a => a.trim()).filter(Boolean)
    const expanded = expandedIds.has(obj.id)
    return (
      <div
        key={obj.id}
        className={[
          'obj-entry',
          obj.active ? '' : 'obj-entry--inactive',
          editingId === obj.id ? 'obj-entry--editing' : '',
          dragOverId === obj.id ? 'obj-entry--drag-over' : '',
        ].filter(Boolean).join(' ')}
        onDragOver={e => handleDragOver(e, obj.id)}
        onDragLeave={() => setDragOverId(null)}
        onDrop={e => handleDrop(e, obj.id)}
      >
                <div className="obj-card">
                  <div className="obj-card__head">
                    <div
                      className="obj-card__grip"
                      draggable
                      onDragStart={e => handleDragStart(e, obj.id)}
                      title="Drag to reorder"
                    >{Array.from({ length: 6 }).map((_, i) => <span key={i} className="obj-card__grip-dot" />)}</div>

                    <div className="obj-card__id">
                      <div className="obj-card__name">{obj.name}</div>
                      <div className="obj-card__meta">
                        <span className="type-badge">{typeName}</span>
                        {aliases.length > 0 && <span className="obj-card__aliases">{aliases.join(' · ')}</span>}
                      </div>
                    </div>

                    <button
                      className={`state-chip ${obj.active ? 'state-chip--on' : 'state-chip--off'}`}
                      onClick={() => handleToggleActive(obj)}
                      disabled={togglingId === obj.id}
                      title={obj.active ? 'Active — click to pause' : 'Paused — click to activate'}
                    >
                      <span className="state-chip__dot" />
                      {obj.active ? 'Active' : 'Paused'}
                    </button>
                  </div>

                  <button
                    className={`obj-card__total ${obj.total_seconds > 0 ? 'obj-card__total--clickable' : ''}`}
                    onClick={() => handleToggleExpand(obj)}
                    disabled={obj.total_seconds <= 0}
                    title={obj.total_seconds > 0 ? 'Show breakdown by filter' : 'Nothing captured yet'}
                  >
                    <span className="obj-card__total-label">Integrated</span>
                    <span className="obj-card__total-value">
                      {fmtDuration(Number(obj.total_seconds))}
                      {obj.total_seconds > 0 && <span className="expand-caret">{expanded ? ' ▾' : ' ▸'}</span>}
                    </span>
                  </button>

                  {progress && progress.length > 0 && (
                    <div className="obj-card__progress">
                      {progress.map(p => {
                        const capturedMins = p.captured_seconds / 60
                        const pct = p.target_minutes > 0 ? Math.min(100, Math.round(capturedMins / p.target_minutes * 100)) : 0
                        const avgExp = p.total_frames > 0 ? Math.round(p.captured_seconds / p.total_frames) : null
                        const tooltip = p.total_frames > 0
                          ? `${p.total_frames} frame${p.total_frames !== 1 ? 's' : ''}${avgExp !== null ? ` × ${avgExp}s` : ''}`
                          : undefined
                        return (
                          <div key={p.filter_id} className="plan-progress-item" title={tooltip}>
                            <FilterBadge name={p.filter_name} />
                            <div className="plan-progress-bar">
                              <div className="plan-progress-fill" style={{ width: `${pct}%` }} />
                            </div>
                            <span className="cell-time">{fmtMinsH(capturedMins)} / {fmtMinsH(p.target_minutes)}</span>
                            <span className="plan-progress-pct">{pct}%</span>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  <div className="obj-card__actions">
                    <button className="btn-icon btn-contents" onClick={() => setPlansForId(obj.id)} title="Plans">☰</button>
                    {activePlanObjectIds.has(obj.id) && (
                      <button className="btn-icon btn-assign" onClick={() => handleAssignAll(obj.id)} disabled={assigningIds.has(obj.id)} title="Assign all unassigned sessions to active plan">
                        {assigningIds.has(obj.id) ? '…' : '⬆'}
                      </button>
                    )}
                    {obj.folder && (
                      <button className="btn-icon btn-sync" onClick={() => handleSync(obj)} disabled={syncingId !== null}
                        title="Sync stats with files present in the object folder">
                        {syncingId === obj.id ? '…' : '⟳'}
                      </button>
                    )}
                    <button className="btn-icon btn-edit" onClick={() => openEdit(obj)} title="Edit">✎</button>
                    <button className="btn-icon btn-danger" onClick={() => setConfirmingId(obj.id)} title="Delete">✕</button>
                  </div>
                </div>

                {expanded && (
                  <div className="filter-stats-panel">
                    <span className="filter-stats-panel__title">{obj.name} — by filter</span>
                    {loadingIds.has(obj.id) ? (
                      <span className="cell-muted">Loading…</span>
                    ) : (expandedStats.get(obj.id)?.length ?? 0) === 0 ? (
                      <span className="cell-muted">No data</span>
                    ) : (
                      <div className="filter-stats-list">
                        {(expandedStats.get(obj.id) ?? []).map((s, i) => (
                          <div key={i} className="filter-stat-item">
                            <FilterBadge name={s.filter_name} />
                            <span className="cell-time">{fmtDuration(Number(s.total_seconds))}</span>
                            {(s.exposures?.length ?? 0) > 0 && (
                              <span className="cell-muted" style={{ fontSize: '0.8rem' }}>
                                {s.exposures!.map(e => `${e.frames} × ${e.duration}s`).join(' · ')}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

              </div>
    )
  }

  return (
    <div className="objects-page">
      <div className="page-header">
        <h2>Objects</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {expandedIds.size > 0 && (
            <button className="btn btn-ghost" onClick={() => { setExpandedIds(new Set()); setExpandedStats(new Map()) }}>Collapse all</button>
          )}
          <button className="btn btn-primary" onClick={openAdd}>+ Add Object</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading ? (
        <p className="state-msg">Loading…</p>
      ) : objects.length === 0 ? (
        <p className="state-msg">No objects yet — add one above.</p>
      ) : (
        <>
          {activeObjects.length > 0 && (
            <div className="obj-list">{activeObjects.map(renderObject)}</div>
          )}

          {pausedObjects.length > 0 && (
            <section className="obj-group">
              <h3 className="obj-group__title">
                Paused <span className="obj-group__count">{pausedObjects.length}</span>
              </h3>
              <div className="obj-list">{pausedObjects.map(renderObject)}</div>
            </section>
          )}
        </>
      )}
      {blinkFiles && (
        <BlinkViewer
          title={blinkFiles.label}
          files={blinkFiles.files}
          scope={blinkFiles.label}
          dropped={droppedSubs}
          belowLine={belowLimit}
          onToggleDrop={name => setDroppedSubs(prev => {
            const next = new Set(prev)
            next.has(name) ? next.delete(name) : next.add(name)
            return next
          })}
          onClose={() => setBlinkFiles(null)}
        />
      )}

      {/* Add and edit share one dialog — same fields, same submit handler. */}
      {showForm && (
        <div className="modal-backdrop" onClick={handleCancel}>
          <div className="modal-dialog modal-dialog--form" onClick={e => e.stopPropagation()}>
            <div className="modal-dialog__header">
              <span className="modal-dialog__title">{editingId !== null ? 'Edit object' : 'New object'}</span>
              <button className="btn btn-ghost" onClick={handleCancel}>✕</button>
            </div>
            {error && <div className="error-banner">{error}</div>}
            <form onSubmit={handleSubmit}>
              <div className="form-grid">
                <div className="form-field">
                  <label htmlFor="obj-name">Name</label>
                  <input id="obj-name" value={form.name} onChange={set('name')} required placeholder="e.g. Andromeda Galaxy" autoFocus />
                </div>
                <div className="form-field">
                  <label htmlFor="obj-type">Type</label>
                  <select id="obj-type" value={form.typeId} onChange={set('typeId')} required>
                    <option value="">Select type…</option>
                    {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div className="form-field form-field--full">
                  <label htmlFor="obj-position">Position (JSON)</label>
                  <input id="obj-position" value={form.position_json} onChange={set('position_json')} required placeholder='{"ra": "00h42m44s", "dec": "+41°16′09″"}' />
                </div>
                <div className="form-field">
                  <label htmlFor="obj-aliases">Aliases</label>
                  <input id="obj-aliases" value={form.aliases} onChange={set('aliases')} placeholder="e.g. M31; NGC 224" />
                </div>
                <div className="form-field form-field--check">
                  <label className="check-label">
                    <input type="checkbox" checked={form.active} onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} />
                    Active
                  </label>
                </div>
                <div className="form-field form-field--full">
                  <label htmlFor="obj-folder">Folder</label>
                  <input id="obj-folder" value={form.folder} onChange={set('folder')} placeholder="e.g. M31" spellCheck={false} />
                </div>
                <div className="form-field form-field--full">
                  <label htmlFor="obj-comment">Comment</label>
                  <textarea id="obj-comment" value={form.comment} onChange={set('comment')} placeholder="Optional notes…" rows={2} />
                </div>
              </div>
              <div className="form-actions">
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting ? 'Saving…' : editingId !== null ? 'Update Object' : 'Save Object'}
                </button>
                <button type="button" className="btn btn-ghost" onClick={handleCancel}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {plansForId !== null && (() => {
        const obj = objects.find(o => o.id === plansForId)
        if (!obj) return null
        return (
          <div className="modal-backdrop" onClick={() => setPlansForId(null)}>
            <div className="modal-dialog modal-dialog--wide" onClick={e => e.stopPropagation()}>
              <PlansPanel
                objectId={obj.id}
                objectName={obj.name}
                onClose={() => setPlansForId(null)}
                onActivePlanChange={has => setActivePlanObjectIds(prev => {
                  const s = new Set(prev)
                  has ? s.add(obj.id) : s.delete(obj.id)
                  return s
                })}
              />
            </div>
          </div>
        )
      })()}

      {syncPreview !== null && (
        <div className="modal-backdrop" onClick={closeSyncPreview}>
          <div className="modal-dialog modal-dialog--wide" onClick={e => e.stopPropagation()}>
            <div className="modal-dialog__header">
              <span className="modal-dialog__title">Sync files — {syncPreview.obj.name}</span>
              <button className="btn btn-ghost" onClick={closeSyncPreview}>✕</button>
            </div>
            <p className="cell-muted" style={{ margin: '0 0 0.75rem', fontSize: '0.85rem' }}>
              {syncPreview.scan.presentCount} file{syncPreview.scan.presentCount !== 1 ? 's' : ''} in folder
              {' · '}{syncPreview.scan.recordedCount} imported record{syncPreview.scan.recordedCount !== 1 ? 's' : ''} for this object
              {' '}<span title="Files are matched by name with the extension ignored">(extensions ignored)</span>
            </p>
            {syncPreview.scan.changes.length === 0 && syncPreview.scan.unadjustable.length === 0 ? (
              <>
                <p style={{ color: '#4ade80', margin: 0 }}>✓ Everything in sync — session counts match the files on disk.</p>
                {syncPreview.scan.relinkCount > 0 && (
                  <p className="cell-muted" style={{ fontSize: '0.85rem', margin: '0.5rem 0 0' }}>
                    {syncPreview.scan.relinkCount} import record{syncPreview.scan.relinkCount !== 1 ? 's' : ''} aren't tied to their session entry yet — apply to link them, so deleting an entry also frees its subs for re-import.
                  </p>
                )}
              </>
            ) : (
              <>
                {syncPreview.scan.changes.length > 0 && (
                  <>
                    <p style={{ color: '#cbd5e1', margin: '0 0 0.5rem' }}>
                      Session entries will be set to the number of subs actually on disk:
                    </p>
                    <div style={{ overflowX: 'auto', marginBottom: '0.75rem' }}>
                      <table className="data-table">
                        <thead>
                          <tr><th>Session</th><th>Filter</th><th>Exposure</th><th>On disk</th><th>Frames</th><th></th></tr>
                        </thead>
                        <tbody>
                          {syncPreview.scan.changes.map(c => (
                            <tr key={`${c.dateKey}|${c.filterId}|${c.exposureId}`}>
                              <td>
                                {c.sessionName}
                                {c.sessionId === null && <span className="type-badge" style={{ marginLeft: '0.4rem' }}>new session</span>}
                              </td>
                              <td><span className="type-badge">{c.filterName}</span></td>
                              <td>{c.duration}s</td>
                              <td>{c.diskFiles}</td>
                              <td>
                                {c.entryIds.length > 0 ? `${c.currentFrames} → ${c.newFrames}` : c.newFrames}
                                {c.entryIds.length === 0 && <span className="cell-muted"> (new entry)</span>}
                                {c.entryIds.length > 0 && c.newFrames === 0 && <span className="cell-muted"> (entry removed)</span>}
                                {c.entryIds.length > 1 && c.newFrames > 0 && <span className="cell-muted"> (merges {c.entryIds.length} entries)</span>}
                              </td>
                              <td className="cell-muted" style={{ fontSize: '0.8rem' }}>
                                {[
                                  c.addFiles.length ? `+${c.addFiles.length} file${c.addFiles.length !== 1 ? 's' : ''} registered` : null,
                                  c.missingFiles.length ? `−${c.missingFiles.length} stale record${c.missingFiles.length !== 1 ? 's' : ''}` : null,
                                ].filter(Boolean).join(' · ')}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
                {syncPreview.scan.unadjustable.length > 0 && (
                  <p className="cell-muted" style={{ fontSize: '0.85rem', margin: '0 0 0.5rem' }}>
                    ⚠ {syncPreview.scan.unadjustable.length} stale record{syncPreview.scan.unadjustable.length !== 1 ? 's' : ''} fit no
                    session/filter/exposure — removed without touching stats.
                  </p>
                )}
                {syncPreview.scan.unattributable > 0 && (
                  <p className="cell-muted" style={{ fontSize: '0.85rem', margin: '0 0 0.5rem' }}>
                    {syncPreview.scan.unattributable} file{syncPreview.scan.unattributable !== 1 ? 's' : ''} in the folder
                    {' '}match{syncPreview.scan.unattributable === 1 ? 'es' : ''} no pattern for this object (e.g. masters) — ignored.
                  </p>
                )}
              </>
            )}
            {/* ── Sub quality ── */}
            {syncPreview.scan.analyzableFiles.length > 0 && (
              <div style={{ marginTop: '0.75rem', borderTop: '1px solid #2a2a35', paddingTop: '0.75rem' }}>
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <select
                    className="select-dark"
                    value={activeQualityFilterId ?? ''}
                    onChange={e => handleQualityFilterChange(Number(e.target.value))}
                    disabled={qualityAnalyzing || qualityDeleting}
                  >
                    {analyzableFilters.map(f => (
                      <option key={f.id} value={f.id}>
                        {f.name} ({syncPreview.scan.analyzableFiles.filter(a => a.filterId === f.id).length})
                      </option>
                    ))}
                  </select>
                  {/* Force a re-measure only for a filter this dialog actually
                      measured — one merely showing its saved analysis still
                      gets the cheap pass. */}
                  {(() => {
                    const measured = activeQualityFilterId != null && qualityMeasuredFilters.has(activeQualityFilterId)
                    return (
                      <button className="btn btn-secondary" onClick={() => handleAnalyzeQuality(measured)}
                        disabled={qualityAnalyzing || qualityDeleting || syncApplying || syncingId !== null || !qualityFilterFiles.length}
                        title={measured ? 'Measure all subs again and refresh the saved analysis' : 'Uses saved analysis where available; measures only new subs'}>
                        {qualityAnalyzing
                          ? `Analyzing… ${qualityProgress ? `${qualityProgress.current}/${qualityProgress.total}` : ''}`
                          : measured ? '↻ Re-analyze quality' : '📈 Analyze quality'}
                      </button>
                    )
                  })()}
                  {qualityAnalyzing && (
                    <button className="btn btn-ghost" onClick={() => qualityAbortRef.current?.abort()}>■ Stop</button>
                  )}
                  {/* Frontend mode only — backend mode never has the subs in
                      the browser, and shipping them over HTTP to blink is not
                      viable at ~50 MB each. */}
                  {importFileMode === 'frontend' && qualityFilterFiles.length > 0 && (
                    <button className="btn btn-secondary" onClick={handleBlink}
                      disabled={blinkLoading || qualityAnalyzing || qualityDeleting || syncApplying}
                      title="Flick through this filter's subs and drop the bad ones by eye">
                      {blinkLoading ? 'Opening…' : `◫ Blink ${qualityFilterFiles.length}`}
                    </button>
                  )}
                  <select
                    className="select-dark"
                    value={qualityMetric}
                    onChange={e => handleQualityMetricChange(e.target.value as 'psfsw' | 'fwhm')}
                    disabled={qualityAnalyzing || qualityDeleting}
                    title="Both metrics are measured in one pass — this selects which one is shown"
                  >
                    <option value="psfsw">Signal (PSFSW)</option>
                    <option value="fwhm">Star size (FWHM)</option>
                  </select>
                  {qualityResults.size > 0 && (
                    <span className="cell-muted" style={{ fontSize: '0.8rem' }}>
                      {analyzableFilters.find(f => f.id === activeQualityFilterId)?.name}: {measuredPoints.length} of {qualityFilterFiles.length} measured
                      {qualityMetric === 'psfsw' ? ' · median ≈ 1.0' : ' · px'} · {cullFiles.length} {qualityMetric === 'psfsw' ? 'below' : 'above'} the limit
                      {qualityUnmeasured > 0 ? ` · ${qualityUnmeasured} not measurable (kept)` : ''}
                    </span>
                  )}
                </div>
                {/* Open from the first analysis onward. A filter with nothing to
                    plot yet shows why, rather than collapsing the pane shut. */}
                {qualityPaneOpen && !(qualityThreshold != null && qualityPoints.length > 0) && (
                  <p className="cell-muted" style={{ fontSize: '0.8rem', margin: '0.5rem 0' }}>
                    {qualityResults.size > 0
                      ? `No ${qualityMetric === 'psfsw' ? 'PSFSW' : 'FWHM'} values for this filter — its subs couldn't be measured.`
                      : `No saved analysis for this filter — analyze quality to measure its ${qualityFilterFiles.length} sub${qualityFilterFiles.length !== 1 ? 's' : ''}.`}
                  </p>
                )}
                {qualityPaneOpen && qualityThreshold != null && qualityPoints.length > 0 && (
                  <>
                    <p className="cell-muted" style={{ fontSize: '0.8rem', margin: '0.5rem 0' }}>
                      Drag the ▸ handle to set the limit — subs {qualityMetric === 'psfsw' ? 'below' : 'above'} it (including derived copies) are deleted from disk.
                      {handDroppedHere > 0 && ` ${handDroppedHere} more dropped by eye in blink.`}
                    </p>
                    <SnrChart points={qualityPoints} threshold={qualityThreshold} onThresholdChange={setQualityThreshold}
                      metricLabel={qualityMetric === 'psfsw' ? 'PSFSW' : 'FWHM (px)'}
                      goodDirection={qualityMetric === 'psfsw' ? 'above' : 'below'}
                      droppedFiles={droppedSubs} disabled={qualityAnalyzing}
                      onOpenFile={p => openFitsFile(p.fileName)} />
                  </>
                )}
                {/* Outside the chart's own gate: blinking and dropping by eye
                    is a complete workflow on its own, so the cull controls have
                    to be reachable without running an analysis first. Always
                    rendered once there is anything to cull (the buttons
                    disable rather than disappear) so dragging the limit across
                    the 0-excluded boundary doesn't resize the panel and jerk
                    the handle. */}
                {(cullFiles.length > 0 || (qualityPaneOpen && qualityThreshold != null && qualityPoints.length > 0)) && (
                  <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <button className="btn btn-ghost" onClick={() => setShowCullList(true)} disabled={cullFiles.length === 0}>
                      📋 View {cullFiles.length} excluded…
                    </button>
                    {confirmDeleteSubs && cullFiles.length > 0 ? (
                      <>
                        <span style={{ color: '#f87171', fontSize: '0.85rem' }}>
                          Permanently delete {cullFiles.length} sub{cullFiles.length !== 1 ? 's' : ''} from disk?
                        </span>
                        <button className="btn btn-danger" onClick={handleDeleteBelowLimit} disabled={qualityDeleting}>
                          {qualityDeleting ? 'Deleting…' : 'Yes, delete'}
                        </button>
                        <button className="btn btn-ghost" onClick={() => setConfirmDeleteSubs(false)} disabled={qualityDeleting}>Cancel</button>
                      </>
                    ) : (
                      <button className="btn btn-danger" onClick={() => setConfirmDeleteSubs(true)}
                        disabled={cullFiles.length === 0 || qualityDeleting || qualityAnalyzing || syncingId !== null}>
                        🗑 Delete {cullFiles.length} sub{cullFiles.length !== 1 ? 's' : ''}
                        {handDroppedHere > 0 && cullFiles.length > handDroppedHere ? ` (${handDroppedHere} by eye)` : ''}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {showCullList && (
              <FileListDialog
                title={`Subs excluded by the ${qualityMetric === 'psfsw' ? 'PSFSW' : 'FWHM'} limit — ${syncPreview.obj.name}`}
                files={cullFiles}
                onClose={() => setShowCullList(false)}
              />
            )}

            <div className="form-actions">
              {(syncPreview.scan.changes.length > 0 || syncPreview.scan.unadjustable.length > 0 || syncPreview.scan.relinkCount > 0) && (
                <button className="btn btn-primary" onClick={handleApplySync} disabled={syncApplying || syncingId !== null || qualityDeleting}>
                  {syncApplying ? 'Applying…' : `Apply ${syncPreview.scan.changes.length} change${syncPreview.scan.changes.length !== 1 ? 's' : ''}${
                    syncPreview.scan.addCount > 0 ? ` · register ${syncPreview.scan.addCount}` : ''}${
                    syncPreview.scan.missingCount > 0 ? ` · drop ${syncPreview.scan.missingCount}` : ''}${
                    syncPreview.scan.relinkCount > 0 ? ` · link ${syncPreview.scan.relinkCount}` : ''}`}
                </button>
              )}
              <button className="btn btn-ghost" onClick={closeSyncPreview}>
                {syncPreview.scan.changes.length > 0 || syncPreview.scan.unadjustable.length > 0 ? 'Cancel' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmingId !== null && (() => {
        const obj = objects.find(o => o.id === confirmingId)
        return (
          <div className="modal-backdrop" onClick={() => setConfirmingId(null)}>
            <div className="modal-dialog" onClick={e => e.stopPropagation()}>
              <div className="modal-dialog__header">
                <span className="modal-dialog__title">Delete object?</span>
              </div>
              <p style={{ color: '#cbd5e1', margin: 0 }}>
                <strong style={{ color: '#e2e8f0' }}>{obj?.name}</strong> will be permanently deleted, along with its
                session entries, plans and import records. Subs already on disk are left alone — and stop counting as
                imported, so they can be imported again.
              </p>
              <div className="form-actions">
                <button className="btn btn-danger" onClick={() => handleDelete(confirmingId)} disabled={deletingId === confirmingId}>
                  {deletingId === confirmingId ? 'Deleting…' : 'Delete'}
                </button>
                <button className="btn btn-ghost" onClick={() => setConfirmingId(null)}>Cancel</button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
