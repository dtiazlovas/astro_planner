import { useState, useEffect, FormEvent } from 'react'
import { getFilters, createFilter, updateFilter, deleteFilter } from '../api'
import type { ApFilter } from '../types'
import { DEFAULT_PATTERN, PLACEHOLDER_DOCS, patternToRegex, parseFile, fetchPatterns, savePatterns, fetchDayStartHour, saveDayStartHour, fetchImagesFolder, saveImagesFolder, pickFolder } from '../utils/filePattern'

const emptyFilterForm = { name: '', aliases: '', folder: '' }

export default function SettingsPage() {
  const [patterns, setPatterns] = useState<string[]>([DEFAULT_PATTERN])
  const [saving, setSaving] = useState(false)
  const [test, setTest] = useState('')
  const [dayStartHour, setDayStartHour] = useState(16)
  const [imagesFolder, setImagesFolder] = useState('')
  const [imagesFolderSaving, setImagesFolderSaving] = useState(false)
  const [imagesFolderPicking, setImagesFolderPicking] = useState(false)

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
  useEffect(() => { fetchImagesFolder().then(setImagesFolder) }, [])

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
          Local folder where captured images are stored. Saved automatically on blur.
        </p>
        <div className="form-field">
          <label htmlFor="images-folder">Folder path</label>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input
              id="images-folder"
              value={imagesFolder}
              onChange={e => setImagesFolder(e.target.value)}
              onBlur={async () => {
                setImagesFolderSaving(true)
                try { await saveImagesFolder(imagesFolder.trim()) } finally { setImagesFolderSaving(false) }
              }}
              placeholder="e.g. D:\Astrophotography\Images"
              style={{ fontFamily: 'monospace', fontSize: '0.85rem', flex: 1 }}
              spellCheck={false}
            />
            <button
              className="btn btn-secondary"
              disabled={imagesFolderPicking}
              onClick={async () => {
                setImagesFolderPicking(true)
                try {
                  const picked = await pickFolder()
                  if (picked) {
                    setImagesFolder(picked)
                    await saveImagesFolder(picked)
                  }
                } finally {
                  setImagesFolderPicking(false)
                }
              }}
            >
              {imagesFolderPicking ? '…' : 'Browse…'}
            </button>
            {imagesFolderSaving && <span className="cell-muted" style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}>saving…</span>}
          </div>
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
          <table className="data-table">
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
                <tr key={f.id} className={editingFilterId === f.id ? 'row--editing' : ''}>
                  <td className="cell-name">{f.name}</td>
                  <td className="cell-muted" style={{ fontSize: '0.85rem' }}>
                    {f.aliases
                      ? f.aliases.split(';').map((a, i) => (
                          <span key={i} className="type-badge" style={{ marginRight: '0.25rem' }}>{a.trim()}</span>
                        ))
                      : '—'}
                  </td>
                  <td className="cell-muted" style={{ fontSize: '0.85rem', fontFamily: 'monospace' }}>
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
        )}
      </div>

      {/* ── Filename Patterns ── */}
      <div className="settings-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <p className="settings-card__title" style={{ margin: 0 }}>
            Filename Patterns {saving && <span className="cell-muted" style={{ fontWeight: 400, fontSize: '0.8rem' }}> saving…</span>}
          </p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn btn-primary" onClick={addPattern}>+ Add Pattern</button>
            <button className="btn btn-ghost" onClick={resetPatterns}>Reset</button>
          </div>
        </div>
        <p className="cell-muted" style={{ fontSize: '0.85rem', marginBottom: '1rem' }}>
          A file must match at least one pattern to be imported.
          Use <code className="inline-code">{'{placeholder}'}</code> tokens and <code className="inline-code">*</code> as a wildcard.
          Saved automatically.
        </p>

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
