import { useState, useEffect, Fragment } from 'react'
import { getObjects, getObjectTypes, getObjectFilterStats, getObjectPlanProgress, getPlans, assignToActivePlan, createObject, updateObject, deleteObject } from '../api'
import type { ApObject, ApObjectType, ObjectFilterStat, PlanProgressItem } from '../types'
import PlansPanel from './PlansPanel'
import FilterBadge from '../components/FilterBadge'

const emptyForm = { name: '', typeId: '', position_json: '', comment: '', aliases: '', active: true }

const fmtDuration = (s: number): string => {
  if (s <= 0) return '—'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `~${h}h ${m}m` : `~${m}m`
}

const fmtMinsH = (minutes: number): string => `${(minutes / 60).toFixed(1)}h`

export default function ObjectsPage() {
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
  const [planExpandedIds, setPlanExpandedIds] = useState<Set<number>>(new Set())
  const [activePlanObjectIds, setActivePlanObjectIds] = useState<Set<number>>(new Set())
  const [assigningIds, setAssigningIds] = useState<Set<number>>(new Set())

  useEffect(() => {
    const load = async () => {
      try {
        const [objs, ts, plans] = await Promise.all([getObjects(), getObjectTypes(), getPlans()])
        setObjects(objs)
        setTypes(ts)
        const activePlanObjIds = [...new Set(plans.filter(p => p.active).map(p => p.object))]
        setActivePlanObjectIds(new Set(activePlanObjIds))
        const progressResults = await Promise.all(
          activePlanObjIds.map(id => getObjectPlanProgress(id).catch(() => [] as PlanProgressItem[]))
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
  }, [])

  const handleAssignAll = async (objectId: number) => {
    setAssigningIds(prev => new Set(prev).add(objectId))
    try {
      await assignToActivePlan(objectId)
      const progress = await getObjectPlanProgress(objectId)
      setPlanProgress(prev => new Map(prev).set(objectId, progress))
    } catch {
      setError('Failed to assign sessions to plan')
    } finally {
      setAssigningIds(prev => { const s = new Set(prev); s.delete(objectId); return s })
    }
  }

  const typeMap = new Map(types.map(t => [t.id, t.name]))

  type ObjSortField = 'name' | 'type' | 'total_seconds'
  const [sortField, setSortField] = useState<ObjSortField>('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const handleSort = (field: ObjSortField) => {
    if (field === sortField) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(field); setSortDir('asc') }
  }

  const sortedObjects = [...objects].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1
    let cmp = 0
    switch (sortField) {
      case 'name': cmp = a.name.localeCompare(b.name); break
      case 'type': cmp = (typeMap.get(a.type) ?? '').localeCompare(typeMap.get(b.type) ?? ''); break
      case 'total_seconds': cmp = a.total_seconds - b.total_seconds; break
    }
    return sortDir === 'asc' ? cmp : -cmp
  })

  const sortInd = (field: ObjSortField) =>
    sortField === field ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''

  const openAdd = () => {
    setEditingId(null); setForm(emptyForm); setShowForm(true); setError(null)
  }

  const openEdit = (obj: ApObject) => {
    setEditingId(obj.id)
    setForm({ name: obj.name, typeId: String(obj.type), position_json: obj.position_json, comment: obj.comment ?? '', aliases: obj.aliases ?? '', active: obj.active })
    setShowForm(true); setConfirmingId(null); setError(null)
  }

  const handleCancel = () => { setShowForm(false); setEditingId(null); setForm(emptyForm); setError(null) }

  const handleSubmit = async (e: { preventDefault(): void }) => {
    e.preventDefault()
    setSubmitting(true); setError(null)
    const payload = { name: form.name.trim(), type: Number(form.typeId), position_json: form.position_json.trim(), comment: form.comment.trim() || null, aliases: form.aliases.trim() || null, active: form.active }
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
    getObjectFilterStats(obj.id)
      .then(s => setExpandedStats(prev => new Map(prev).set(obj.id, s)))
      .catch(() => {})
      .finally(() => setLoadingIds(prev => { const s = new Set(prev); s.delete(obj.id); return s }))
  }

  const set = (field: keyof Omit<typeof emptyForm, 'active'>) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => setForm(f => ({ ...f, [field]: e.target.value }))

  return (
    <div className="objects-page">
      <div className="page-header">
        <h2>Objects</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {(expandedIds.size > 0 || planExpandedIds.size > 0) && (
            <button className="btn btn-ghost" onClick={() => { setExpandedIds(new Set()); setExpandedStats(new Map()); setPlanExpandedIds(new Set()) }}>Collapse all</button>
          )}
          <button className={`btn ${showForm ? 'btn-ghost' : 'btn-primary'}`} onClick={showForm ? handleCancel : openAdd}>
            {showForm ? 'Cancel' : '+ Add Object'}
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {showForm && (
        <form className="object-form" onSubmit={handleSubmit}>
          <p className="form-title">{editingId !== null ? 'Edit Object' : 'New Object'}</p>
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
              <input id="obj-aliases" value={form.aliases} onChange={set('aliases')} placeholder="e.g. M31, NGC 224" />
            </div>
            <div className="form-field form-field--check">
              <label className="check-label">
                <input type="checkbox" checked={form.active} onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} />
                Active
              </label>
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
          </div>
        </form>
      )}

      {loading ? (
        <p className="state-msg">Loading…</p>
      ) : objects.length === 0 ? (
        <p className="state-msg">No objects yet — add one above.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th className="th-sort" onClick={() => handleSort('name')}>Name{sortInd('name')}</th>
                <th className="th-sort" onClick={() => handleSort('type')}>Type{sortInd('type')}</th>
                <th>Aliases</th>
                <th>Active</th>
                <th className="th-sort" onClick={() => handleSort('total_seconds')}>Total{sortInd('total_seconds')}</th>
                <th>Progress</th>
              </tr>
            </thead>
            <tbody>
              {sortedObjects.map(obj => {
                const progress = planProgress.get(obj.id)
                return (
                  <Fragment key={obj.id}>
                    <tr className={editingId === obj.id ? 'row--editing' : ''}>
                      <td className="cell-name-actions" style={{ verticalAlign: 'top' }}>
                        {confirmingId === obj.id ? (
                          <div className="row-actions">
                            <button className="btn-icon btn-danger" onClick={() => handleDelete(obj.id)} disabled={deletingId === obj.id}>{deletingId === obj.id ? '…' : 'Yes'}</button>
                            <button className="btn-icon btn-ghost" onClick={() => setConfirmingId(null)}>No</button>
                          </div>
                        ) : (
                          <div className="row-actions">
                            <button className="btn-icon btn-contents" onClick={() => setPlanExpandedIds(prev => { const s = new Set(prev); s.has(obj.id) ? s.delete(obj.id) : s.add(obj.id); return s })} title="Plans">☰</button>
                            {activePlanObjectIds.has(obj.id) && (
                              <button className="btn-icon btn-assign" onClick={() => handleAssignAll(obj.id)} disabled={assigningIds.has(obj.id)} title="Assign all unassigned sessions to active plan">
                                {assigningIds.has(obj.id) ? '…' : '⬆'}
                              </button>
                            )}
                            <button className="btn-icon btn-edit" onClick={() => openEdit(obj)} title="Edit">✎</button>
                            <button className="btn-icon btn-danger" onClick={() => setConfirmingId(obj.id)} title="Delete">✕</button>
                          </div>
                        )}
                        <div className="cell-name">{obj.name}</div>
                      </td>
                      <td><span className="type-badge">{typeMap.get(obj.type) ?? obj.type}</span></td>
                      <td className="cell-muted">{obj.aliases ?? '—'}</td>
                      <td>
                        <button className={`toggle ${obj.active ? 'toggle--on' : ''}`} onClick={() => handleToggleActive(obj)} disabled={togglingId === obj.id} title={obj.active ? 'Active' : 'Inactive'} />
                      </td>
                      <td
                        className={`cell-time ${obj.total_seconds > 0 ? 'cell-total--clickable' : ''}`}
                        onClick={() => handleToggleExpand(obj)}
                        title={obj.total_seconds > 0 ? 'Click to see filter breakdown' : undefined}
                      >
                        {fmtDuration(Number(obj.total_seconds))}
                        {obj.total_seconds > 0 && <span className="expand-caret">{expandedIds.has(obj.id) ? ' ▾' : ' ▸'}</span>}
                      </td>
                      <td className="cell-progress">
                        {progress && progress.length > 0 && (
                          <div className="plan-progress-list">
                            {progress.map(p => {
                              const capturedMins = p.captured_seconds / 60
                              const pct = p.target_minutes > 0 ? Math.min(100, Math.round(capturedMins / p.target_minutes * 100)) : 0
                              return (
                                <div key={p.filter_id} className="plan-progress-item">
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
                      </td>
                    </tr>
                    {expandedIds.has(obj.id) && (
                      <tr>
                        <td colSpan={6} style={{ padding: 0 }}>
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
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                    {planExpandedIds.has(obj.id) && (
                      <tr>
                        <td colSpan={6} style={{ padding: 0 }}>
                          <PlansPanel
                            objectId={obj.id}
                            objectName={obj.name}
                            onClose={() => setPlanExpandedIds(prev => { const s = new Set(prev); s.delete(obj.id); return s })}
                            onActivePlanChange={has => setActivePlanObjectIds(prev => {
                              const s = new Set(prev)
                              has ? s.add(obj.id) : s.delete(obj.id)
                              return s
                            })}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
