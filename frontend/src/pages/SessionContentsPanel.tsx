import { useState, useEffect } from 'react'
import { getObjectSessions, createObjectSession, updateObjectSession, deleteObjectSession, getObjects, getExposures, getFilters, getPlans, setPlanSession, deletePlanSession } from '../api'
import type { ApObjectSession, ApObject, ApExposure, ApFilter, ApSession, ApPlan } from '../types'
import FilterBadge from '../components/FilterBadge'

const emptyForm = { objectId: '', exposureId: '', filterId: '', frames: '1', planId: '' }

const fmtDuration = (totalSeconds: number): string => {
  if (totalSeconds <= 0) return '0.0h'
  return `${(totalSeconds / 3600).toFixed(1)}h`
}

interface Props {
  session: ApSession
  onClose: () => void
  onDurationChange?: (seconds: number) => void
}

export default function SessionContentsPanel({ session, onClose, onDurationChange }: Props) {
  const [entries, setEntries] = useState<ApObjectSession[]>([])
  const [objects, setObjects] = useState<ApObject[]>([])
  const [exposures, setExposures] = useState<ApExposure[]>([])
  const [filters, setFilters] = useState<ApFilter[]>([])
  const [allPlans, setAllPlans] = useState<ApPlan[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [confirmingId, setConfirmingId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)

  useEffect(() => {
    setLoading(true)
    setError(null)
    Promise.all([getObjectSessions(session.id), getObjects(), getExposures(), getFilters(), getPlans()])
      .then(([ents, objs, exps, fils, plans]) => {
        setEntries(ents); setObjects(objs); setExposures(exps); setFilters(fils); setAllPlans(plans)
      })
      .catch(() => setError('Failed to load session contents'))
      .finally(() => setLoading(false))
  }, [session.id])

  const totalSeconds = entries.reduce((s, e) => s + e.frames * e.exposure_duration, 0)

  useEffect(() => {
    if (!loading) onDurationChange?.(totalSeconds)
  }, [totalSeconds, loading])

  const activePlansFor = (objectId: number) =>
    allPlans.filter(p => p.object === objectId && p.active)

  const autoSelectPlan = (objectId: string) => {
    if (!objectId) return ''
    const active = activePlansFor(Number(objectId))
    return active.length === 1 ? String(active[0].id) : ''
  }

  const openEdit = (entry: ApObjectSession) => {
    setEditingId(entry.id)
    setForm({
      objectId:   String(entry.object),
      exposureId: String(entry.exposure),
      filterId:   String(entry.filter),
      frames:     String(entry.frames),
      planId:     entry.plan_id ? String(entry.plan_id) : '',
    })
    setConfirmingId(null)
    setError(null)
    setShowAddForm(false)
  }

  const handleCancel = () => {
    setEditingId(null)
    setForm(emptyForm)
    setError(null)
    setShowAddForm(false)
  }

  const set = (field: keyof typeof emptyForm) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const value = e.target.value
    setForm(f => {
      const next = { ...f, [field]: value }
      if (field === 'objectId') next.planId = autoSelectPlan(value)
      return next
    })
  }

  const applyPlanChange = async (
    entryId: number,
    newPlanId: string,
    existing: ApObjectSession,
    updatedBase: ApObjectSession,
  ) => {
    if (newPlanId) {
      const ps = await setPlanSession({ session: entryId, planid: Number(newPlanId) })
      const planName = allPlans.find(p => p.id === ps.planid)?.name ?? null
      setEntries(prev => prev.map(e => e.id === entryId
        ? { ...updatedBase, plan_session_id: ps.id, plan_id: ps.planid, plan_name: planName }
        : e))
    } else if (existing.plan_session_id) {
      await deletePlanSession(existing.plan_session_id)
      setEntries(prev => prev.map(e => e.id === entryId
        ? { ...updatedBase, plan_session_id: null, plan_id: null, plan_name: null }
        : e))
    } else {
      setEntries(prev => prev.map(e => e.id === entryId ? updatedBase : e))
    }
  }

  const handleSubmit = async (e: { preventDefault(): void }) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    const payload = {
      object:   Number(form.objectId),
      exposure: Number(form.exposureId),
      filter:   Number(form.filterId),
      frames:   Number(form.frames),
    }
    try {
      if (editingId !== null) {
        const existing = entries.find(e => e.id === editingId)!
        const updated = await updateObjectSession(editingId, payload)
        await applyPlanChange(editingId, form.planId, existing, updated)
        setEditingId(null)
        setForm(emptyForm)
      } else {
        const created = await createObjectSession({ ...payload, session: session.id })
        if (form.planId) {
          const ps = await setPlanSession({ session: created.id, planid: Number(form.planId) })
          const planName = allPlans.find(p => p.id === ps.planid)?.name ?? null
          setEntries(prev => [...prev, { ...created, plan_session_id: ps.id, plan_id: ps.planid, plan_name: planName }])
        } else {
          setEntries(prev => [...prev, created])
        }
        setForm(emptyForm)
      }
    } catch {
      setError(editingId !== null ? 'Failed to update entry' : 'Failed to add entry')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (id: number) => {
    setDeletingId(id)
    try {
      await deleteObjectSession(id)
      setEntries(prev => prev.filter(e => e.id !== id))
      setConfirmingId(null)
      if (editingId === id) handleCancel()
    } catch {
      setError('Failed to delete entry')
    } finally {
      setDeletingId(null)
    }
  }

  const planOptions = form.objectId
    ? activePlansFor(Number(form.objectId))
    : []

  return (
    <div className="contents-panel">
      <div className="contents-panel__header">
        <div>
          <span className="contents-panel__title">{session.name}</span>
          {entries.length > 0 && (
            <span className="contents-panel__duration">{fmtDuration(totalSeconds)} total</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className={`btn ${showAddForm || editingId !== null ? 'btn-ghost' : 'btn-primary'}`}
            onClick={() => { setShowAddForm(v => !v); if (editingId !== null) handleCancel() }}>
            {showAddForm || editingId !== null ? 'Cancel' : '+ Add'}
          </button>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {(showAddForm || editingId !== null) && <form className="contents-add-form" onSubmit={handleSubmit}>
        <div className="contents-form-row">
          <div className="form-field">
            <label htmlFor="cs-object">Object</label>
            <select id="cs-object" value={form.objectId} onChange={set('objectId')} required>
              <option value="">Select…</option>
              {objects.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>

          <div className="form-field">
            <label htmlFor="cs-filter">Filter</label>
            <select id="cs-filter" value={form.filterId} onChange={set('filterId')} required>
              <option value="">Select…</option>
              {filters.map(f => <option key={f.id} value={f.id}>{f.name ?? `Filter ${f.id}`}</option>)}
            </select>
          </div>

          <div className="form-field">
            <label htmlFor="cs-exposure">Exposure</label>
            <select id="cs-exposure" value={form.exposureId} onChange={set('exposureId')} required>
              <option value="">Select…</option>
              {exposures.map(e => <option key={e.id} value={e.id}>{e.duration}s</option>)}
            </select>
          </div>

          <div className="form-field form-field--narrow">
            <label htmlFor="cs-frames">Frames</label>
            <input id="cs-frames" type="number" min="1" value={form.frames} onChange={set('frames')} required />
          </div>

          {planOptions.length > 0 && (
            <div className="form-field">
              <label htmlFor="cs-plan">Plan</label>
              <select id="cs-plan" value={form.planId} onChange={set('planId')}>
                <option value="">— none —</option>
                {planOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}

          <div className="form-field form-field--action">
            <label>&nbsp;</label>
            <div className="row-actions">
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? '…' : editingId !== null ? 'Update' : '+ Add'}
              </button>
            </div>
          </div>
        </div>
      </form>}

      {loading ? (
        <p className="state-msg">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="state-msg" style={{ padding: '1.5rem 0' }}>No entries yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Object</th>
                <th>Filter</th>
                <th>Exposure</th>
                <th>Frames</th>
                <th>Time</th>
                <th>Plan</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {entries.map(entry => {
                const entrySeconds = entry.frames * entry.exposure_duration
                const timeStr = `${(entrySeconds / 3600).toFixed(1)}h`
                return (
                  <tr key={entry.id} className={editingId === entry.id ? 'row--editing' : ''}>
                    <td className="cell-name">{entry.object_name}</td>
                    <td><FilterBadge name={entry.filter_name} /></td>
                    <td>{entry.exposure_duration}s</td>
                    <td>{entry.frames}</td>
                    <td className="cell-time">{timeStr}</td>
                    <td className="cell-muted">
                      {entry.plan_name
                        ? <span className="type-badge">{entry.plan_name}</span>
                        : '—'}
                    </td>
                    <td className="cell-action">
                      {confirmingId === entry.id ? (
                        <div className="row-actions">
                          <button className="btn-icon btn-danger" onClick={() => handleDelete(entry.id)} disabled={deletingId === entry.id}>
                            {deletingId === entry.id ? '…' : 'Yes'}
                          </button>
                          <button className="btn-icon btn-ghost" onClick={() => setConfirmingId(null)}>No</button>
                        </div>
                      ) : (
                        <div className="row-actions">
                          <button className="btn-icon btn-edit" onClick={() => openEdit(entry)} title="Edit">✎</button>
                          <button className="btn-icon btn-danger" onClick={() => setConfirmingId(entry.id)} title="Delete">✕</button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4} className="cell-muted" style={{ textAlign: 'right', fontStyle: 'italic' }}>Total</td>
                <td className="cell-time cell-time--total">{fmtDuration(totalSeconds)}</td>
                <td></td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
