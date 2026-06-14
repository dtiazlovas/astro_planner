import React, { useState, useEffect, Fragment } from 'react'
import { getObjects, getObjectTypes, getObjectFilterStats, getObjectPlanProgress, getPlans, assignToActivePlan, createObject, updateObject, deleteObject, reorderObjects } from '../api'
import type { ApObject, ApObjectType, ObjectFilterStat, PlanProgressItem } from '../types'
import PlansPanel from './PlansPanel'
import FilterBadge from '../components/FilterBadge'
import GalaxyIcon from '../components/GalaxyIcon'
import nebulaImg from '../assets/nebula.png'
import nebulaReflectionImg from '../assets/nebula-reflection.png'

const emptyForm = { name: '', typeId: '', position_json: '', comment: '', aliases: '', active: true, folder: '' }

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
  const [dragOverId, setDragOverId] = useState<number | null>(null)

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

  const getTypeIcon = (name: string): { icon: React.ReactNode; color: string } => {
    const n = name.toLowerCase()
    if (n.includes('star cluster') || n.includes('cluster')) return { icon: '⁂', color: '#93c5fd' }
    if (n.includes('star'))    return { icon: '★',  color: '#fde68a' }
    if (n.includes('emission')) return { icon: <img src={nebulaImg} className="type-icon-img" alt="emission nebula" />, color: '#f87171' }
    if (n.includes('reflection')) return { icon: <img src={nebulaReflectionImg} className="type-icon-img type-icon-img--reflection" alt="reflection nebula" />, color: '#67e8f9' }
    if (n.includes('galaxy'))  return { icon: <GalaxyIcon className="type-icon-svg" />, color: '#c4b5fd' }
    return { icon: '·', color: '#94a3b8' }
  }

  const handleDragStart = (e: React.DragEvent, id: number) => {
    e.dataTransfer.setData('text/plain', String(id))
    e.dataTransfer.effectAllowed = 'move'

    const tr = (e.currentTarget as HTMLElement).closest('tr')
    if (tr) {
      const rect = tr.getBoundingClientRect()
      const ghost = document.createElement('table')
      ghost.className = 'data-table'
      ghost.style.cssText = `position:absolute;top:-9999px;left:-9999px;width:${rect.width}px;border-collapse:collapse;background:#1e1e32;opacity:0.95;`
      const tbody = document.createElement('tbody')
      tbody.appendChild(tr.cloneNode(true))
      ghost.appendChild(tbody)
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
    const newOrder = [...objects]
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
      try { setObjects(await getObjects()) } catch {}
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
          <button className={`btn ${showForm && editingId === null ? 'btn-ghost' : 'btn-primary'}`} onClick={showForm && editingId === null ? handleCancel : openAdd}>
            {showForm && editingId === null ? 'Cancel' : '+ Add Object'}
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {showForm && editingId === null && (
        <form className="object-form" onSubmit={handleSubmit}>
          <p className="form-title">New Object</p>
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
                <th>Name</th>
                <th>Type</th>
                <th>Active</th>
                <th>Total</th>
                <th>Progress</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {objects.map((obj, objIdx) => {
                const progress = planProgress.get(obj.id)
                return (
                  <Fragment key={obj.id}>
                    <tr
                      className={editingId === obj.id ? 'row--editing' : dragOverId === obj.id ? 'row--drag-over' : ''}
                      onDragOver={e => handleDragOver(e, obj.id)}
                      onDragLeave={() => setDragOverId(null)}
                      onDrop={e => handleDrop(e, obj.id)}
                    >
                      <td className="cell-name-actions" style={{ verticalAlign: 'top' }}>
                        <div className="cell-name">{obj.name}</div>
                        {obj.aliases && obj.aliases.split(';').map(a => a.trim()).filter(Boolean).map((a, i) => (
                          <div key={i} className="cell-muted" style={{ fontSize: '0.8rem' }}>{a}</div>
                        ))}
                        <div
                          className="drag-handle"
                          draggable
                          onDragStart={e => handleDragStart(e, obj.id)}
                          title="Drag to reorder"
                        >{Array.from({ length: 9 }).map((_, i) => <span key={i} className="drag-handle__dot" />)}</div>
                      </td>
                      <td className="cell-type">
                        {(() => { const typeName = typeMap.get(obj.type) ?? String(obj.type); const { icon, color } = getTypeIcon(typeName); return (<><span className="type-icon" style={{ color }}>{icon}</span><span className="type-badge">{typeName}</span></>) })()}
                      </td>
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
                      </td>
                      <td className="cell-action" style={{ verticalAlign: 'top' }}>
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
                    {editingId === obj.id && showForm && (
                      <tr className="row--editor">
                        <td colSpan={6} style={{ padding: 0 }}>
                          <form className="object-form object-form--inline" onSubmit={handleSubmit}>
                            <div className="form-actions">
                              <button type="submit" className="btn btn-primary" disabled={submitting}>
                                {submitting ? 'Saving…' : 'Update Object'}
                              </button>
                              <button type="button" className="btn btn-ghost" onClick={handleCancel}>Cancel</button>
                            </div>
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
                          </form>
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

      {confirmingId !== null && (() => {
        const obj = objects.find(o => o.id === confirmingId)
        return (
          <div className="modal-backdrop" onClick={() => setConfirmingId(null)}>
            <div className="modal-dialog" onClick={e => e.stopPropagation()}>
              <div className="modal-dialog__header">
                <span className="modal-dialog__title">Delete object?</span>
              </div>
              <p style={{ color: '#cbd5e1', margin: 0 }}>
                <strong style={{ color: '#e2e8f0' }}>{obj?.name}</strong> will be permanently deleted.
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
