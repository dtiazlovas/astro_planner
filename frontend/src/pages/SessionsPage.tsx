import { useState, useEffect, Fragment } from 'react'
import { getSessions, createSession, updateSession, deleteSession } from '../api'
import type { ApSession } from '../types'
import SessionContentsPanel from './SessionContentsPanel'
import ImportPanel from './ImportPanel'

const emptyForm = { name: '', start: '', duration: '', duration_set: false, comment: '' }

const fmtCalcDuration = (totalSeconds: number): string => {
  if (totalSeconds <= 0) return '—'
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  return h > 0 ? `~${h}h ${m}m` : `~${m}m`
}

const fmtDate = (iso: string | null) => {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

const toDatetimeLocal = (iso: string | null): string => {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function SessionsPage() {
  const [sessions, setSessions] = useState<ApSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [submitting, setSubmitting] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [confirmingId, setConfirmingId] = useState<number | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [showImport, setShowImport] = useState(false)
  const [sortField, setSortField] = useState<keyof ApSession>('start')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const handleSort = (field: keyof ApSession) => {
    if (field === sortField) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(field); setSortDir('asc') }
  }

  const sortedSessions = [...sessions].sort((a, b) => {
    const av = a[sortField] ?? '', bv = b[sortField] ?? ''
    const cmp = typeof av === 'number' && typeof bv === 'number'
      ? av - bv
      : String(av).localeCompare(String(bv))
    return sortDir === 'asc' ? cmp : -cmp
  })

  const sortInd = (field: keyof ApSession) =>
    sortField === field ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''

  useEffect(() => {
    getSessions()
      .then(setSessions)
      .catch(() => setError('Failed to load sessions'))
      .finally(() => setLoading(false))
  }, [])

  const openAdd = () => {
    setEditingId(null)
    setForm(emptyForm)
    setShowForm(true)
    setError(null)
  }

  const openEdit = (ses: ApSession) => {
    setEditingId(ses.id)
    setForm({
      name: ses.name,
      start: toDatetimeLocal(ses.start),
      duration: toDatetimeLocal(ses.duration),
      duration_set: ses.duration_set,
      comment: ses.comment ?? '',
    })
    setShowForm(true)
    setConfirmingId(null)
    setError(null)
  }

  const handleCancel = () => {
    setShowForm(false)
    setEditingId(null)
    setForm(emptyForm)
    setError(null)
  }

  const handleSubmit = async (e: { preventDefault(): void }) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    const payload = {
      name: form.name.trim(),
      start: form.start,
      duration: form.duration_set && form.duration ? form.duration : null,
      duration_set: form.duration_set,
      comment: form.comment.trim() || null,
    }
    try {
      if (editingId !== null) {
        const updated = await updateSession(editingId, payload)
        setSessions(prev => prev.map(s => s.id === editingId ? updated : s))
      } else {
        const created = await createSession(payload)
        setSessions(prev => [created, ...prev])
      }
      setForm(emptyForm)
      setEditingId(null)
      setShowForm(false)
    } catch {
      setError(editingId !== null ? 'Failed to update session' : 'Failed to create session')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (id: number) => {
    setDeletingId(id)
    try {
      await deleteSession(id)
      setSessions(prev => prev.filter(s => s.id !== id))
      setConfirmingId(null)
      if (editingId === id) handleCancel()
    } catch {
      setError('Failed to delete session')
    } finally {
      setDeletingId(null)
    }
  }

  const set = (field: keyof Omit<typeof emptyForm, 'duration_set'>) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => setForm(f => ({ ...f, [field]: e.target.value }))

  return (
    <div className="objects-page">
      <div className="page-header">
        <h2>Sessions</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {selectedIds.size > 0 && (
            <button className="btn btn-ghost" onClick={() => setSelectedIds(new Set())}>Collapse all</button>
          )}
          <button className={`btn ${showImport ? 'btn-ghost' : 'btn-contents'}`} onClick={() => { setShowImport(v => !v); if (showForm) handleCancel() }}>
            {showImport ? 'Hide Import' : '📁 Import'}
          </button>
          <button className={`btn ${showForm && editingId === null ? 'btn-ghost' : 'btn-primary'}`} onClick={showForm && editingId === null ? handleCancel : openAdd}>
            {showForm && editingId === null ? 'Cancel' : '+ Add Session'}
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {showForm && editingId === null && (
        <form className="object-form" onSubmit={handleSubmit}>
          <p className="form-title">New Session</p>
          <div className="form-grid">
            <div className="form-field form-field--full">
              <label htmlFor="ses-name">Name</label>
              <input id="ses-name" value={form.name} onChange={set('name')} required placeholder="e.g. Backyard session 2026-06-07" autoFocus />
            </div>

            <div className="form-field">
              <label htmlFor="ses-start">Start</label>
              <input id="ses-start" type="datetime-local" value={form.start} onChange={set('start')} required />
            </div>

            <div className="form-field form-field--check" style={{ alignSelf: 'flex-end', paddingBottom: '0.1rem' }}>
              <label className="check-label">
                <input type="checkbox" checked={form.duration_set} onChange={e => setForm(f => ({ ...f, duration_set: e.target.checked, duration: e.target.checked ? f.duration : '' }))} />
                Set duration
              </label>
            </div>

            {form.duration_set && (
              <div className="form-field form-field--full">
                <label htmlFor="ses-duration">End / Duration</label>
                <input id="ses-duration" type="datetime-local" value={form.duration} onChange={set('duration')} />
              </div>
            )}

            <div className="form-field form-field--full">
              <label htmlFor="ses-comment">Comment</label>
              <textarea id="ses-comment" value={form.comment} onChange={set('comment')} placeholder="Optional notes…" rows={2} />
            </div>
          </div>

          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save Session'}
            </button>
          </div>
        </form>
      )}

      {showImport && (
        <ImportPanel
          onClose={() => setShowImport(false)}
          onImported={() => {
            getSessions().then(setSessions).catch(() => {})
            setShowImport(false)
          }}
        />
      )}

      {loading ? (
        <p className="state-msg">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="state-msg">No sessions yet — add one above.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th className="th-sort" onClick={() => handleSort('name')}>Name{sortInd('name')}</th>
                <th className="th-sort" onClick={() => handleSort('start')}>Start{sortInd('start')}</th>
                <th className="th-sort" onClick={() => handleSort('duration')}>Duration / End{sortInd('duration')}</th>
                <th className="th-sort" onClick={() => handleSort('calculated_seconds')}>Content{sortInd('calculated_seconds')}</th>
                <th className="th-sort" onClick={() => handleSort('comment')}>Comment{sortInd('comment')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sortedSessions.map(ses => (
                <Fragment key={ses.id}>
                  <tr className={editingId === ses.id ? 'row--editing' : ''}>
                    <td className="cell-name">{ses.name}</td>
                    <td>{fmtDate(ses.start)}</td>
                    <td className="cell-muted">{ses.duration_set ? fmtDate(ses.duration) : '—'}</td>
                    <td className="cell-time">{fmtCalcDuration(Number(ses.calculated_seconds))}</td>
                    <td className="cell-muted">{ses.comment ?? '—'}</td>
                    <td className="cell-action">
                      {confirmingId === ses.id ? (
                        <div className="row-actions">
                          <button className="btn-icon btn-danger" onClick={() => handleDelete(ses.id)} disabled={deletingId === ses.id}>
                            {deletingId === ses.id ? '…' : 'Yes'}
                          </button>
                          <button className="btn-icon btn-ghost" onClick={() => setConfirmingId(null)}>No</button>
                        </div>
                      ) : (
                        <div className="row-actions">
                          <button className="btn-icon btn-contents" onClick={() => setSelectedIds(prev => { const s = new Set(prev); s.has(ses.id) ? s.delete(ses.id) : s.add(ses.id); return s })} title="Contents">≡</button>
                          <button className="btn-icon btn-edit" onClick={() => openEdit(ses)} title="Edit">✎</button>
                          <button className="btn-icon btn-danger" onClick={() => setConfirmingId(ses.id)} title="Delete">✕</button>
                        </div>
                      )}
                    </td>
                  </tr>
                  {selectedIds.has(ses.id) && (
                    <tr>
                      <td colSpan={6} style={{ padding: 0 }}>
                        <SessionContentsPanel
                          session={ses}
                          onClose={() => setSelectedIds(prev => { const s = new Set(prev); s.delete(ses.id); return s })}
                          onDurationChange={seconds =>
                            setSessions(prev => prev.map(s =>
                              s.id === ses.id ? { ...s, calculated_seconds: seconds } : s
                            ))
                          }
                        />
                      </td>
                    </tr>
                  )}
                  {editingId === ses.id && showForm && (
                    <tr className="row--editor">
                      <td colSpan={6} style={{ padding: 0 }}>
                        <form className="object-form object-form--inline" onSubmit={handleSubmit}>
                          <div className="form-actions">
                            <button type="submit" className="btn btn-primary" disabled={submitting}>
                              {submitting ? 'Saving…' : 'Update Session'}
                            </button>
                            <button type="button" className="btn btn-ghost" onClick={handleCancel}>Cancel</button>
                          </div>
                          <div className="form-grid">
                            <div className="form-field form-field--full">
                              <label htmlFor="ses-name-inline">Name</label>
                              <input id="ses-name-inline" value={form.name} onChange={set('name')} required placeholder="e.g. Backyard session 2026-06-07" autoFocus />
                            </div>

                            <div className="form-field">
                              <label htmlFor="ses-start-inline">Start</label>
                              <input id="ses-start-inline" type="datetime-local" value={form.start} onChange={set('start')} required />
                            </div>

                            <div className="form-field form-field--check" style={{ alignSelf: 'flex-end', paddingBottom: '0.1rem' }}>
                              <label className="check-label">
                                <input type="checkbox" checked={form.duration_set} onChange={e => setForm(f => ({ ...f, duration_set: e.target.checked, duration: e.target.checked ? f.duration : '' }))} />
                                Set duration
                              </label>
                            </div>

                            {form.duration_set && (
                              <div className="form-field form-field--full">
                                <label htmlFor="ses-duration-inline">End / Duration</label>
                                <input id="ses-duration-inline" type="datetime-local" value={form.duration} onChange={set('duration')} />
                              </div>
                            )}

                            <div className="form-field form-field--full">
                              <label htmlFor="ses-comment-inline">Comment</label>
                              <textarea id="ses-comment-inline" value={form.comment} onChange={set('comment')} placeholder="Optional notes…" rows={2} />
                            </div>
                          </div>
                        </form>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

    </div>
  )
}
