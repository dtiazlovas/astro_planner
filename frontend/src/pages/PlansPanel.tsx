import { useState, useEffect, Fragment } from 'react'
import { getPlans, createPlan, updatePlan, deletePlan, getPlanDetails, createPlanDetail, updatePlanDetail, deletePlanDetail, getFilters } from '../api'
import type { ApPlan, ApPlanDetail, ApFilter } from '../types'
import FilterBadge from '../components/FilterBadge'

const emptyPlanForm = { name: '', active: true }
const emptyDetailForm = { filterId: '', hours: '0', minutes: '0' }

const fmtDuration = (minutes: number) => {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h > 0 && m > 0) return `${h}h ${m}m`
  if (h > 0) return `${h}h`
  return `${m}m`
}

interface Props {
  objectId: number
  objectName: string
  onClose: () => void
  onActivePlanChange?: (hasActivePlan: boolean) => void
}

export default function PlansPanel({ objectId, objectName, onClose, onActivePlanChange }: Props) {
  const [plans, setPlans] = useState<ApPlan[]>([])
  const [filters, setFilters] = useState<ApFilter[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [showPlanForm, setShowPlanForm] = useState(false)
  const [editingPlanId, setEditingPlanId] = useState<number | null>(null)
  const [planForm, setPlanForm] = useState(emptyPlanForm)
  const [submittingPlan, setSubmittingPlan] = useState(false)
  const [confirmingPlanId, setConfirmingPlanId] = useState<number | null>(null)
  const [deletingPlanId, setDeletingPlanId] = useState<number | null>(null)

  const [expandedPlanIds, setExpandedPlanIds] = useState<Set<number>>(new Set())
  const [planDetails, setPlanDetails] = useState<Map<number, ApPlanDetail[]>>(new Map())
  const [loadingDetailIds, setLoadingDetailIds] = useState<Set<number>>(new Set())

  const [addingDetailFor, setAddingDetailFor] = useState<number | null>(null)
  const [editingDetailId, setEditingDetailId] = useState<number | null>(null)
  const [detailForm, setDetailForm] = useState(emptyDetailForm)
  const [submittingDetail, setSubmittingDetail] = useState(false)
  const [confirmingDetailId, setConfirmingDetailId] = useState<number | null>(null)
  const [deletingDetailId, setDeletingDetailId] = useState<number | null>(null)

  useEffect(() => {
    Promise.all([getPlans(objectId), getFilters()])
      .then(([p, f]) => { setPlans(p); setFilters(f) })
      .catch(() => setError('Failed to load plans'))
      .finally(() => setLoading(false))
  }, [objectId])

  const filterName = (id: number) => filters.find(f => f.id === id)?.name ?? `Filter ${id}`

  const toggleExpand = (plan: ApPlan) => {
    if (expandedPlanIds.has(plan.id)) {
      setExpandedPlanIds(prev => { const s = new Set(prev); s.delete(plan.id); return s })
      return
    }
    setExpandedPlanIds(prev => new Set(prev).add(plan.id))
    if (!planDetails.has(plan.id)) {
      setLoadingDetailIds(prev => new Set(prev).add(plan.id))
      getPlanDetails(plan.id)
        .then(d => setPlanDetails(prev => new Map(prev).set(plan.id, d)))
        .catch(() => {})
        .finally(() => setLoadingDetailIds(prev => { const s = new Set(prev); s.delete(plan.id); return s }))
    }
  }

  const openEditPlan = (plan: ApPlan) => {
    setEditingPlanId(plan.id)
    setPlanForm({ name: plan.name, active: plan.active })
    setShowPlanForm(true)
    setConfirmingPlanId(null)
    setError(null)
  }

  const handleCancelPlan = () => {
    setShowPlanForm(false); setEditingPlanId(null); setPlanForm(emptyPlanForm); setError(null)
  }

  const handleSubmitPlan = async (e: { preventDefault(): void }) => {
    e.preventDefault()
    setSubmittingPlan(true); setError(null)
    try {
      if (editingPlanId !== null) {
        const updated = await updatePlan(editingPlanId, { name: planForm.name.trim(), active: planForm.active })
        const next = plans.map(p => p.id === editingPlanId ? updated : p)
        setPlans(next)
        onActivePlanChange?.(next.some(p => p.active))
      } else {
        const created = await createPlan({ object: objectId, name: planForm.name.trim(), active: planForm.active })
        const next = [...plans, created]
        setPlans(next)
        onActivePlanChange?.(next.some(p => p.active))
      }
      handleCancelPlan()
    } catch {
      setError(editingPlanId !== null ? 'Failed to update plan' : 'Failed to create plan')
    } finally {
      setSubmittingPlan(false)
    }
  }

  const handleDeletePlan = async (id: number) => {
    setDeletingPlanId(id)
    try {
      await deletePlan(id)
      const next = plans.filter(p => p.id !== id)
      setPlans(next)
      onActivePlanChange?.(next.some(p => p.active))
      setConfirmingPlanId(null)
      if (editingPlanId === id) handleCancelPlan()
      setExpandedPlanIds(prev => { const s = new Set(prev); s.delete(id); return s })
      setPlanDetails(prev => { const m = new Map(prev); m.delete(id); return m })
    } catch {
      setError('Failed to delete plan')
    } finally {
      setDeletingPlanId(null)
    }
  }

  const handleToggleActive = async (plan: ApPlan) => {
    try {
      const updated = await updatePlan(plan.id, { active: !plan.active })
      const next = plans.map(p => p.id === plan.id ? updated : p)
      setPlans(next)
      onActivePlanChange?.(next.some(p => p.active))
    } catch {
      setError('Failed to update plan')
    }
  }

  const openEditDetail = (planId: number, detail: ApPlanDetail) => {
    setEditingDetailId(detail.id)
    setAddingDetailFor(planId)
    setDetailForm({
      filterId: String(detail.filter),
      hours:    String(Math.floor(detail.duration / 60)),
      minutes:  String(detail.duration % 60),
    })
    setConfirmingDetailId(null); setError(null)
  }

  const handleCancelDetail = () => {
    setEditingDetailId(null); setAddingDetailFor(null); setDetailForm(emptyDetailForm); setError(null)
  }

  const handleSubmitDetail = async (planId: number, e: { preventDefault(): void }) => {
    e.preventDefault()
    setSubmittingDetail(true); setError(null)
    try {
      const duration = Number(detailForm.hours) * 60 + Number(detailForm.minutes)
      if (editingDetailId !== null) {
        const updated = await updatePlanDetail(editingDetailId, {
          filter: Number(detailForm.filterId), duration,
        })
        setPlanDetails(prev => new Map(prev).set(planId,
          (prev.get(planId) ?? []).map(d => d.id === editingDetailId ? updated : d)
        ))
      } else {
        const created = await createPlanDetail({
          planid: planId, filter: Number(detailForm.filterId), duration,
        })
        setPlanDetails(prev => new Map(prev).set(planId, [...(prev.get(planId) ?? []), created]))
      }
      handleCancelDetail()
    } catch {
      setError(editingDetailId !== null ? 'Failed to update detail' : 'Failed to add detail')
    } finally {
      setSubmittingDetail(false)
    }
  }

  const handleDeleteDetail = async (planId: number, id: number) => {
    setDeletingDetailId(id)
    try {
      await deletePlanDetail(id)
      setPlanDetails(prev => new Map(prev).set(planId, (prev.get(planId) ?? []).filter(d => d.id !== id)))
      setConfirmingDetailId(null)
      if (editingDetailId === id) handleCancelDetail()
    } catch {
      setError('Failed to delete detail')
    } finally {
      setDeletingDetailId(null)
    }
  }

  return (
    <div className="contents-panel">
      <div className="contents-panel__header">
        <span className="contents-panel__title">{objectName} — Plans</span>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            className={`btn ${showPlanForm ? 'btn-ghost' : 'btn-primary'}`}
            onClick={() => {
              if (showPlanForm) handleCancelPlan()
              else { setShowPlanForm(true); setEditingPlanId(null); setPlanForm(emptyPlanForm) }
            }}>
            {showPlanForm ? 'Cancel' : '+ Add Plan'}
          </button>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {showPlanForm && (
        <form className="contents-add-form" onSubmit={handleSubmitPlan}>
          <div className="contents-form-row">
            <div className="form-field">
              <label htmlFor="plan-name">Name</label>
              <input id="plan-name" value={planForm.name}
                onChange={e => setPlanForm(f => ({ ...f, name: e.target.value }))}
                required placeholder="e.g. Ha narrowband" autoFocus />
            </div>
            <div className="form-field form-field--check" style={{ alignSelf: 'flex-end', paddingBottom: '0.1rem' }}>
              <label className="check-label">
                <input type="checkbox" checked={planForm.active}
                  onChange={e => setPlanForm(f => ({ ...f, active: e.target.checked }))} />
                Active
              </label>
            </div>
            <div className="form-field form-field--action">
              <label>&nbsp;</label>
              <button type="submit" className="btn btn-primary" disabled={submittingPlan}>
                {submittingPlan ? '…' : editingPlanId !== null ? 'Update' : 'Save'}
              </button>
            </div>
          </div>
        </form>
      )}

      {loading ? (
        <p className="state-msg">Loading…</p>
      ) : plans.length === 0 && !showPlanForm ? (
        <p className="state-msg" style={{ padding: '1.5rem 0' }}>No plans yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Active</th>
                <th>Details</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {plans.map(plan => (
                <Fragment key={plan.id}>
                  <tr className={editingPlanId === plan.id ? 'row--editing' : ''}>
                    <td className="cell-name">{plan.name}</td>
                    <td>
                      <button className={`toggle ${plan.active ? 'toggle--on' : ''}`}
                        onClick={() => handleToggleActive(plan)}
                        title={plan.active ? 'Active' : 'Inactive'} />
                    </td>
                    <td className="cell-total--clickable" onClick={() => toggleExpand(plan)} title="Click to see details">
                      <span className="expand-caret">{expandedPlanIds.has(plan.id) ? '▾' : '▸'}</span>
                      {planDetails.has(plan.id)
                        ? ` ${planDetails.get(plan.id)!.length} line${planDetails.get(plan.id)!.length !== 1 ? 's' : ''}`
                        : ''}
                    </td>
                    <td className="cell-action">
                      {confirmingPlanId === plan.id ? (
                        <div className="row-actions">
                          <button className="btn-icon btn-danger"
                            onClick={() => handleDeletePlan(plan.id)}
                            disabled={deletingPlanId === plan.id}>
                            {deletingPlanId === plan.id ? '…' : 'Yes'}
                          </button>
                          <button className="btn-icon btn-ghost" onClick={() => setConfirmingPlanId(null)}>No</button>
                        </div>
                      ) : (
                        <div className="row-actions">
                          <button className="btn-icon btn-edit" onClick={() => openEditPlan(plan)} title="Edit">✎</button>
                          <button className="btn-icon btn-danger" onClick={() => setConfirmingPlanId(plan.id)} title="Delete">✕</button>
                        </div>
                      )}
                    </td>
                  </tr>

                  {expandedPlanIds.has(plan.id) && (
                    <tr>
                      <td colSpan={4} style={{ padding: 0 }}>
                        <div className="filter-stats-panel" style={{ paddingBottom: '0.5rem' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                            <span className="filter-stats-panel__title">{plan.name} — details</span>
                            <button
                              className={`btn btn-sm ${addingDetailFor === plan.id && editingDetailId === null ? 'btn-ghost' : 'btn-primary'}`}
                              onClick={() => {
                                if (addingDetailFor === plan.id && editingDetailId === null) handleCancelDetail()
                                else { setAddingDetailFor(plan.id); setEditingDetailId(null); setDetailForm(emptyDetailForm) }
                              }}>
                              {addingDetailFor === plan.id && editingDetailId === null ? 'Cancel' : '+ Add'}
                            </button>
                          </div>

                          {addingDetailFor === plan.id && (
                            <form className="contents-add-form" style={{ marginBottom: '0.5rem' }}
                              onSubmit={e => handleSubmitDetail(plan.id, e)}>
                              <div className="contents-form-row">
                                <div className="form-field">
                                  <label>Filter</label>
                                  <select value={detailForm.filterId}
                                    onChange={e => setDetailForm(f => ({ ...f, filterId: e.target.value }))} required>
                                    <option value="">Select…</option>
                                    {filters.map(f => <option key={f.id} value={f.id}>{f.name ?? `Filter ${f.id}`}</option>)}
                                  </select>
                                </div>
                                <div className="form-field form-field--narrow">
                                  <label>Hours</label>
                                  <input type="number" min="0" value={detailForm.hours}
                                    onChange={e => setDetailForm(f => ({ ...f, hours: e.target.value }))} required />
                                </div>
                                <div className="form-field form-field--narrow">
                                  <label>Minutes</label>
                                  <input type="number" min="0" max="59" value={detailForm.minutes}
                                    onChange={e => setDetailForm(f => ({ ...f, minutes: e.target.value }))} required />
                                </div>
                                <div className="form-field form-field--action">
                                  <label>&nbsp;</label>
                                  <button type="submit" className="btn btn-primary" disabled={submittingDetail}>
                                    {submittingDetail ? '…' : editingDetailId !== null ? 'Update' : '+ Add'}
                                  </button>
                                </div>
                              </div>
                            </form>
                          )}

                          {loadingDetailIds.has(plan.id) ? (
                            <span className="cell-muted">Loading…</span>
                          ) : (planDetails.get(plan.id)?.length ?? 0) === 0 ? (
                            <span className="cell-muted">No details yet.</span>
                          ) : (
                            <table className="data-table">
                              <thead>
                                <tr><th>Filter</th><th>Duration</th><th></th></tr>
                              </thead>
                              <tbody>
                                {(planDetails.get(plan.id) ?? []).map(detail => (
                                  <tr key={detail.id} className={editingDetailId === detail.id ? 'row--editing' : ''}>
                                    <td><FilterBadge name={filterName(detail.filter)} /></td>
                                    <td className="cell-time">{fmtDuration(detail.duration)}</td>
                                    <td className="cell-action">
                                      {confirmingDetailId === detail.id ? (
                                        <div className="row-actions">
                                          <button className="btn-icon btn-danger"
                                            onClick={() => handleDeleteDetail(plan.id, detail.id)}
                                            disabled={deletingDetailId === detail.id}>
                                            {deletingDetailId === detail.id ? '…' : 'Yes'}
                                          </button>
                                          <button className="btn-icon btn-ghost" onClick={() => setConfirmingDetailId(null)}>No</button>
                                        </div>
                                      ) : (
                                        <div className="row-actions">
                                          <button className="btn-icon btn-edit" onClick={() => openEditDetail(plan.id, detail)} title="Edit">✎</button>
                                          <button className="btn-icon btn-danger" onClick={() => setConfirmingDetailId(detail.id)} title="Delete">✕</button>
                                        </div>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
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
