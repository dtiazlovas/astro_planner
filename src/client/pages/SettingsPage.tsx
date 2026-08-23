import { useState, useEffect, useRef, FormEvent } from 'react'
import { getFilters, createFilter, updateFilter, deleteFilter, getObjects } from '../api'
import type { ApFilter, ApObject } from '../types'
import { DEFAULT_PATTERN, PLACEHOLDER_DOCS, patternToRegex, parseFile, fetchPatterns, savePatterns, fetchDayStartHour, saveDayStartHour, inferPattern, buildPattern, PATTERN_FIELD_ORDER, REQUIRED_PATTERN_FIELDS, type PatternInference, type PatternFieldKind } from '../utils/filePattern'
import { getStoredImagesFolder, pickImagesFolder, isFolderAccessSupported } from '../utils/imagesFolder'
import { fetchLatitude, saveLatitude, DEFAULT_LATITUDE } from '../utils/astro'
import { cacheStats, clearCache, formatBytes, CACHE_CAP_BYTES } from '../utils/previewCache'
import LatitudePicker from '../components/LatitudePicker'

const emptyFilterForm = { name: '', aliases: '', folder: '' }

const FIELD_LABELS: Record<PatternFieldKind, string> = {
  target: 'Target',
  duration: 'Exposure',
  filter: 'Filter',
  short_datetime: 'Date / time',
  filenumber: 'Frame number',
}

export default function SettingsPage() {
  const [patterns, setPatterns] = useState<string[]>([DEFAULT_PATTERN])
  const [saving, setSaving] = useState(false)
  const [test, setTest] = useState('')
  const [dayStartHour, setDayStartHour] = useState(16)
  const [imagesFolderName, setImagesFolderName] = useState<string | null>(null)
  const [imagesFolderPicking, setImagesFolderPicking] = useState(false)
  const [imagesFolderError, setImagesFolderError] = useState<string | null>(null)
  const [latitude, setLatitude] = useState(DEFAULT_LATITUDE)
  const [cacheStatsValue, setCacheStatsValue] = useState<{ count: number; bytes: number } | null>(null)
  const [clearingCache, setClearingCache] = useState(false)

  // Pattern-from-a-file: the proposal stands until it is accepted or discarded,
  // and `accepted` is which of its guesses survive into the saved pattern.
  const [inference, setInference] = useState<PatternInference | null>(null)
  const [sampleNames, setSampleNames] = useState<string[]>([])
  const [accepted, setAccepted] = useState<Set<PatternFieldKind>>(new Set())
  const [inferError, setInferError] = useState<string | null>(null)
  const patternFileRef = useRef<HTMLInputElement>(null)

  const [filters, setFilters] = useState<ApFilter[]>([])
  const [loadingFilters, setLoadingFilters] = useState(true)
  const [filterError, setFilterError] = useState<string | null>(null)
  const [showFilterForm, setShowFilterForm] = useState(false)
  const [editingFilterId, setEditingFilterId] = useState<number | null>(null)
  const [filterForm, setFilterForm] = useState(emptyFilterForm)
  const [submittingFilter, setSubmittingFilter] = useState(false)
  const [confirmingFilterId, setConfirmingFilterId] = useState<number | null>(null)
  const [deletingFilterId, setDeletingFilterId] = useState<number | null>(null)

  useEffect(() => { fetchPatterns().then(setPatterns) }, [])
  useEffect(() => { fetchDayStartHour().then(setDayStartHour) }, [])
  useEffect(() => { getStoredImagesFolder().then(h => setImagesFolderName(h?.name ?? null)) }, [])
  useEffect(() => { fetchLatitude().then(setLatitude) }, [])
  useEffect(() => { cacheStats().then(setCacheStatsValue) }, [])

  useEffect(() => {
    getFilters()
      .then(setFilters)
      .catch(() => setFilterError('Failed to load filters'))
      .finally(() => setLoadingFilters(false))
  }, [])

  const saveAll = async (next: string[]) => {
    setPatterns(next)
    setSaving(true)
    try { await savePatterns(next) } finally { setSaving(false) }
  }

  const handlePatternChange = (idx: number, v: string) => {
    const next = patterns.map((p, i) => i === idx ? v : p)
    saveAll(next)
  }

  const addPattern = () => saveAll([...patterns, ''])

  const removePattern = (idx: number) => {
    if (patterns.length <= 1) return
    saveAll(patterns.filter((_, i) => i !== idx))
  }

  const resetPatterns = () => saveAll([DEFAULT_PATTERN])

  // ── Pattern from a file ──────────────────────────────────────
  // The browser hands over the name only, which is all a pattern is about.
  // Objects are fetched here rather than held in page state: they are read once
  // per proposal, to recognise a target the user has already created.
  const handlePatternFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const names = Array.from(e.target.files ?? []).map(f => f.name)
    if (patternFileRef.current) patternFileRef.current.value = ''
    if (!names.length) return
    setInferError(null)
    let objects: ApObject[] = []
    try { objects = await getObjects() } catch {}
    const inf = inferPattern(names, objects, filters)
    if (!inf || !inf.fields.length) {
      setInference(null)
      setInferError(`Nothing recognisable in “${names[0]}” — write the pattern by hand below.`)
      return
    }
    setSampleNames(names)
    setInference(inf)
    setAccepted(new Set(inf.fields.map(f => f.kind)))
  }

  const toggleField = (kind: PatternFieldKind, on: boolean) =>
    setAccepted(prev => {
      const next = new Set(prev)
      if (on) next.add(kind); else next.delete(kind)
      return next
    })

  const discardInference = () => { setInference(null); setSampleNames([]); setInferError(null) }

  const builtPattern = inference ? buildPattern(inference, accepted) : ''
  const missingRequired = REQUIRED_PATTERN_FIELDS.filter(k => !accepted.has(k))
  // Proof rather than promise: the proposed pattern is run over every file that
  // was selected, so "it works" is something the panel can show, not claim.
  const sampleMatches = (() => {
    if (!builtPattern || missingRequired.length) return 0
    try {
      const rx = patternToRegex(builtPattern)
      return sampleNames.filter(n => parseFile(n, rx) !== null).length
    } catch { return 0 }
  })()

  const acceptInference = async () => {
    if (!builtPattern) return
    await saveAll([...patterns.filter(p => p.trim() && p !== builtPattern), builtPattern])
    discardInference()
  }

  let parsed: ReturnType<typeof parseFile> | 'invalid' = null
  if (test.trim()) {
    for (const p of patterns) {
      try {
        const r = parseFile(test.trim(), patternToRegex(p))
        if (r) { parsed = r; break }
      } catch { parsed = 'invalid'; break }
    }
    if (parsed === null) parsed = null
  }

  const openAddFilter = () => {
    setEditingFilterId(null); setFilterForm(emptyFilterForm)
    setShowFilterForm(true); setFilterError(null); setConfirmingFilterId(null)
  }

  const openEditFilter = (f: ApFilter) => {
    setEditingFilterId(f.id)
    setFilterForm({ name: f.name ?? '', aliases: f.aliases ?? '', folder: f.folder ?? '' })
    setShowFilterForm(true); setFilterError(null); setConfirmingFilterId(null)
  }

  const handleCancelFilter = () => {
    setShowFilterForm(false); setEditingFilterId(null); setFilterForm(emptyFilterForm)
  }

  const handleFilterSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!filterForm.name.trim()) return
    setSubmittingFilter(true); setFilterError(null)
    const payload = { name: filterForm.name.trim(), aliases: filterForm.aliases.trim() || null, folder: filterForm.folder.trim() || null }
    try {
      if (editingFilterId !== null) {
        const updated = await updateFilter(editingFilterId, payload)
        setFilters(prev => prev.map(f => f.id === editingFilterId ? updated : f))
      } else {
        const created = await createFilter(payload)
        setFilters(prev => [...prev, created])
      }
      setFilterForm(emptyFilterForm); setEditingFilterId(null); setShowFilterForm(false)
    } catch {
      setFilterError(editingFilterId !== null ? 'Failed to update filter' : 'Failed to create filter')
    } finally {
      setSubmittingFilter(false)
    }
  }

  const handleDeleteFilter = async (id: number) => {
    setDeletingFilterId(id)
    try {
      await deleteFilter(id)
      setFilters(prev => prev.filter(f => f.id !== id))
      if (editingFilterId === id) handleCancelFilter()
    } catch {
      setFilterError('Failed to delete filter')
    } finally {
      setDeletingFilterId(null); setConfirmingFilterId(null)
    }
  }

  return (
    <div className="objects-page">
      <div className="page-header"><h2>Settings</h2></div>

      {/* ── Images Folder ── */}
      <div className="settings-card">
        <p className="settings-card__title">Images Folder</p>
        <p className="cell-muted" style={{ fontSize: '0.85rem', marginBottom: '1rem' }}>
          Folder where imported frames are copied, organized into object/filter subfolders.
        </p>

        <p className="cell-muted" style={{ fontSize: '0.8rem', marginBottom: '1rem' }}>
          Quality analysis and copying run in this browser on the files you pick — they can come
          from any drive. Needs Chrome or Edge, opened directly (not embedded).
        </p>

        {!isFolderAccessSupported ? (
          <div className="error-banner">
            This browser does not support local folder access (File System Access API).
            Use a Chromium-based browser (Chrome, Edge).
          </div>
        ) : (
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                <button
                  className="btn btn-secondary"
                  disabled={imagesFolderPicking}
                  onClick={async () => {
                    setImagesFolderPicking(true); setImagesFolderError(null)
                    try {
                      const handle = await pickImagesFolder()
                      if (handle) setImagesFolderName(handle.name)
                    } catch (err) {
                      const detail = err instanceof DOMException ? `${err.name}: ${err.message}` : err instanceof Error ? err.message : 'Folder selection failed'
                      const hint = err instanceof DOMException && err.name === 'SecurityError'
                        ? ' — folder access is blocked in embedded browsers; open the app directly in Chrome or Edge.'
                        : ''
                      setImagesFolderError(detail + hint)
                    } finally {
                      setImagesFolderPicking(false)
                    }
                  }}
                >
                  {imagesFolderPicking ? '…' : imagesFolderName ? 'Change folder…' : 'Choose folder…'}
                </button>
                {imagesFolderName
                  ? <span style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>📁 {imagesFolderName}</span>
                  : <span className="cell-muted" style={{ fontSize: '0.85rem' }}>No folder selected</span>}
          </div>
        )}
        {imagesFolderError && (
          <div className="error-banner" style={{ marginTop: '0.75rem' }}>{imagesFolderError}</div>
        )}
      </div>

      {/* ── Blink preview cache ── */}
      <div className="settings-card">
        <p className="settings-card__title">Blink Previews</p>
        <p className="cell-muted" style={{ fontSize: '0.85rem', marginBottom: '1rem' }}>
          Downsampled, auto-stretched copies of your subs, kept so the blink viewer opens instantly
          the second time. They rebuild on their own if a frame changes on disk, and the oldest
          targets are dropped once the cache passes {formatBytes(CACHE_CAP_BYTES)}.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="cell-muted" style={{ fontSize: '0.85rem' }}>
            {cacheStatsValue
              ? `${cacheStatsValue.count} preview${cacheStatsValue.count !== 1 ? 's' : ''} · ${formatBytes(cacheStatsValue.bytes)}`
              : 'Reading cache…'}
          </span>
          <button
            className="btn btn-secondary"
            disabled={clearingCache || !cacheStatsValue?.count}
            onClick={async () => {
              setClearingCache(true)
              try {
                await clearCache()
                setCacheStatsValue(await cacheStats())
              } finally {
                setClearingCache(false)
              }
            }}
          >
            {clearingCache ? 'Clearing…' : 'Clear cache'}
          </button>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="settings-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <p className="settings-card__title" style={{ margin: 0 }}>Filters</p>
          {!showFilterForm && (
            <button className="btn btn-primary" onClick={openAddFilter}>+ Add Filter</button>
          )}
        </div>

        {filterError && <div className="error-banner">{filterError}</div>}

        {showFilterForm && (
          <form onSubmit={handleFilterSubmit} className="inline-form" style={{ marginBottom: '1rem' }}>
            <div className="form-field">
              <label>Name</label>
              <input value={filterForm.name} onChange={e => setFilterForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Luminance" autoFocus />
            </div>
            <div className="form-field form-field--full">
              <label>Aliases <span className="cell-muted" style={{ fontWeight: 400, fontSize: '0.8rem' }}>(semicolon-separated)</span></label>
              <input value={filterForm.aliases} onChange={e => setFilterForm(f => ({ ...f, aliases: e.target.value }))}
                placeholder="e.g. L;Lum;Lum2" />
            </div>
            <div className="form-field">
              <label>Folder</label>
              <input value={filterForm.folder} onChange={e => setFilterForm(f => ({ ...f, folder: e.target.value }))}
                placeholder="e.g. Lum" spellCheck={false} />
            </div>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={submittingFilter || !filterForm.name.trim()}>
                {submittingFilter ? 'Saving…' : editingFilterId !== null ? 'Save' : 'Add'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={handleCancelFilter}>Cancel</button>
            </div>
          </form>
        )}

        {loadingFilters ? (
          <p className="cell-muted">Loading…</p>
        ) : filters.length === 0 ? (
          <p className="cell-muted">No filters yet.</p>
        ) : (
          <div className="table-scroll">
            {/* Cards on a phone: three short columns plus an action cluster
                don't fit a narrow screen as a table, and this is a list you
                read rather than compare down a column. */}
            <table className="data-table data-table--cards data-table--filters">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Aliases</th>
                  <th>Folder</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filters.map(f => (
                  <tr key={f.id} className={`row--card ${editingFilterId === f.id ? 'row--editing' : ''}`}>
                    <td className="cell-name">{f.name}</td>
                    <td className="cell-muted cell-filter-aliases" style={{ fontSize: '0.85rem' }} data-label="Aliases">
                      {f.aliases
                        ? f.aliases.split(';').map((a, i) => (
                            <span key={i} className="type-badge" style={{ marginRight: '0.25rem' }}>{a.trim()}</span>
                          ))
                        : '—'}
                    </td>
                    <td className="cell-muted cell-filter-folder" style={{ fontSize: '0.85rem', fontFamily: 'monospace' }} data-label="Folder">
                      {f.folder ?? '—'}
                    </td>
                    <td className="cell-actions">
                      {confirmingFilterId === f.id ? (
                        <>
                          <span className="cell-muted" style={{ fontSize: '0.85rem' }}>Delete?</span>
                          <button className="btn btn-danger"
                            disabled={deletingFilterId === f.id}
                            onClick={() => handleDeleteFilter(f.id)}>
                            {deletingFilterId === f.id ? '…' : 'Yes'}
                          </button>
                          <button className="btn btn-ghost" onClick={() => setConfirmingFilterId(null)}>No</button>
                        </>
                      ) : (
                        <>
                          <button className="btn btn-ghost" onClick={() => openEditFilter(f)}>✎</button>
                          <button className="btn btn-danger" onClick={() => setConfirmingFilterId(f.id)}>✕</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Filename Patterns ── */}
      <div className="settings-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <p className="settings-card__title" style={{ margin: 0 }}>
            Filename Patterns {saving && <span className="cell-muted" style={{ fontWeight: 400, fontSize: '0.8rem' }}> saving…</span>}
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={() => patternFileRef.current?.click()}>📄 From a file…</button>
            <button className="btn btn-ghost" onClick={addPattern}>+ Add Pattern</button>
            <button className="btn btn-ghost" onClick={resetPatterns}>Reset</button>
          </div>
        </div>
        <p className="cell-muted" style={{ fontSize: '0.85rem', marginBottom: '1rem' }}>
          A file must match at least one pattern to be imported.
          Use <code className="inline-code">{'{placeholder}'}</code> tokens and <code className="inline-code">*</code> as a wildcard.
          Saved automatically. Or pick a few of your own subs with <strong>From a file…</strong> and
          confirm what it recognises — nothing is saved until you accept it.
        </p>

        {/* Names only: the file is never read, so picking a 60MB sub costs
            nothing and no data leaves the machine. */}
        <input ref={patternFileRef} type="file" multiple style={{ display: 'none' }} onChange={handlePatternFiles} />

        {inferError && <div className="error-banner">{inferError}</div>}

        {inference && (
          <div className="pattern-infer">
            <div className="pattern-infer__head">
              <code className="pattern-infer__file">{inference.fileName}</code>
              <span className="cell-muted" style={{ fontSize: '0.78rem' }}>
                {inference.sampleCount > 1
                  ? `${inference.sampleCount} files — parts that differ between them became wildcards`
                  : 'One file — pick several at once and the parts that vary become wildcards'}
              </span>
            </div>

            <div className="pattern-infer__fields">
              {PATTERN_FIELD_ORDER.map(kind => {
                const f = inference.fields.find(x => x.kind === kind)
                return (
                  <label key={kind} className={`pattern-infer__field ${f ? '' : 'pattern-infer__field--missing'}`}>
                    <input type="checkbox" disabled={!f} checked={!!f && accepted.has(kind)}
                      onChange={e => toggleField(kind, e.target.checked)} />
                    <span className="pattern-infer__key">{FIELD_LABELS[kind]}</span>
                    {f ? (
                      <>
                        <code className="inline-code">{f.text}</code>
                        <span className="cell-muted">{f.display}</span>
                      </>
                    ) : (
                      <span className="cell-muted">not recognised</span>
                    )}
                  </label>
                )
              })}
            </div>

            <div className="pattern-infer__preview">
              <span className="pattern-infer__key">Pattern</span>
              <code className="inline-code">{builtPattern}</code>
            </div>

            {missingRequired.length > 0 ? (
              <div className="error-banner">
                A pattern needs {missingRequired.map(k => FIELD_LABELS[k].toLowerCase()).join(', ')} to import a file.
                {inference.fields.some(f => missingRequired.includes(f.kind)) ? ' Tick them above,' : ' None was found in this name —'} or write the pattern by hand.
              </div>
            ) : sampleMatches === sampleNames.length ? (
              <div className="pattern-infer__ok">
                ✓ Parses {sampleNames.length === 1 ? 'the selected file' : `all ${sampleNames.length} selected files`}
              </div>
            ) : (
              <div className="error-banner">
                Parses {sampleMatches} of {sampleNames.length} selected files — the rest are named differently and need a pattern of their own.
              </div>
            )}

            <div className="form-actions">
              <button className="btn btn-primary" onClick={acceptInference}
                disabled={saving || missingRequired.length > 0 || sampleMatches === 0}>
                {saving ? 'Saving…' : 'Accept & save'}
              </button>
              <button className="btn btn-ghost" onClick={discardInference}>Discard</button>
            </div>
          </div>
        )}

        {patterns.map((p, idx) => (
          <div key={idx} className="form-field" style={{ marginBottom: '0.75rem' }}>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input value={p} onChange={e => handlePatternChange(idx, e.target.value)}
                style={{ fontFamily: 'monospace', fontSize: '0.85rem', flex: 1 }} spellCheck={false} />
              <button className="btn btn-danger" disabled={patterns.length <= 1}
                onClick={() => removePattern(idx)}>✕</button>
            </div>
          </div>
        ))}

        <div className="placeholder-grid" style={{ marginTop: '1rem' }}>
          {Object.entries(PLACEHOLDER_DOCS).map(([k, v]) => (
            <div key={k} className="placeholder-row">
              <code className="inline-code">{`{${k}}`}</code>
              <span className="cell-muted">{v}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Location ── */}
      <div className="settings-card">
        <p className="settings-card__title">Location</p>
        <p className="cell-muted" style={{ fontSize: '0.85rem', marginBottom: '1rem' }}>
          Observer latitude used to compute astronomical darkness (Sun below −18°) on the Calendar.
          Drag the line on the map or type degrees below. Longitude isn't needed — it doesn't affect the length of darkness.
        </p>
        <LatitudePicker
          value={latitude}
          onChange={setLatitude}
          onCommit={lat => { saveLatitude(lat).catch(() => {}) }}
        />
      </div>

      {/* ── Session Grouping ── */}
      <div className="settings-card">
        <p className="settings-card__title">Session Grouping</p>
        <p className="cell-muted" style={{ fontSize: '0.85rem', marginBottom: '1rem' }}>
          Hour at which a new observing day begins. Files before this hour are grouped with the previous day's session.
          Default is 16:00.
        </p>
        <div className="form-field">
          <label htmlFor="day-start">Day starts at</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              id="day-start"
              type="number" min="0" max="23"
              value={dayStartHour}
              style={{ width: '4rem' }}
              onChange={async e => {
                const v = Math.max(0, Math.min(23, parseInt(e.target.value, 10) || 0))
                setDayStartHour(v)
                await saveDayStartHour(v)
              }}
            />
            <span className="cell-muted">:00</span>
          </div>
        </div>
      </div>

      {/* ── Test Pattern ── */}
      <div className="settings-card">
        <p className="settings-card__title">Test Pattern</p>
        <div className="form-field" style={{ marginBottom: '1rem' }}>
          <label htmlFor="test-fn">Paste a filename to verify it parses correctly</label>
          <input id="test-fn" value={test} onChange={e => setTest(e.target.value)}
            style={{ fontFamily: 'monospace', fontSize: '0.85rem' }} spellCheck={false}
            placeholder="Light_M31_90deg_120.0s_Bin1_LExtreme_20260607_220415_001.fit" />
        </div>

        {test.trim() && (
          parsed === 'invalid' ? (
            <div className="error-banner">Pattern is not a valid regex</div>
          ) : parsed === null ? (
            <div className="error-banner">No match — filename does not fit the pattern</div>
          ) : (
            <div className="parse-result">
              {([['Target', parsed.target], ['Duration', `${parsed.duration}s`], ['Filter', parsed.filter], ['Date/Time', parsed.datetime.toLocaleString()]] as [string, string][]).map(([k, v]) => (
                <div key={k} className="parse-result__row">
                  <span className="parse-result__key">{k}</span>
                  <span className="parse-result__val">{v}</span>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  )
}
