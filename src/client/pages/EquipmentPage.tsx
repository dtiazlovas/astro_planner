import { useState, useEffect, FormEvent } from 'react'
import { getEquipment, createEquipment, updateEquipment, deleteEquipment } from '../api'
import type { ApEquipment, CreateApEquipmentDto } from '../types'
import { useEquipment } from '../context/EquipmentContext'

interface SensorPreset {
  label: string
  width: number
  height: number
  pixel: number // micrometres
}

// Selectable Sony sensors. `pixel` is the unbinned pixel pitch in µm.
const SENSORS: Record<string, SensorPreset> = {
  '585': { label: 'Sony IMX585', width: 3856, height: 2180, pixel: 2.9 },
  '571': { label: 'Sony IMX571', width: 6252, height: 4176, pixel: 3.76 },
  '455': { label: 'Sony IMX455', width: 9576, height: 6388, pixel: 3.76 },
}

const BINNINGS = [1, 2]

const emptyForm = {
  name: '',
  focal_length: '',
  focal_ratio: '',
  reducer: '1.0',
  sensor: '585',
  binning: '1',
}

type FormState = typeof emptyForm

const resolution = (sensor: string, binning: number): string => {
  const s = SENSORS[sensor]
  if (!s) return '—'
  return `${Math.floor(s.width / binning)} × ${Math.floor(s.height / binning)}`
}

// Arcsec/pixel = 206.265 × pixel(µm) × binning ÷ effective focal length(mm)
const imageScale = (eq: { focal_length: number; reducer: number; sensor: string; binning: number }): string => {
  const s = SENSORS[eq.sensor]
  const efl = eq.focal_length * eq.reducer
  if (!s || efl <= 0) return '—'
  return `${(206.265 * s.pixel * eq.binning / efl).toFixed(2)}″/px`
}

const effectiveFocal = (eq: { focal_length: number; focal_ratio: number; reducer: number }): string => {
  const efl = Math.round(eq.focal_length * eq.reducer)
  const efr = eq.focal_ratio * eq.reducer
  if (eq.reducer === 1) return `${efl}mm · f/${eq.focal_ratio}`
  return `${efl}mm · f/${efr.toFixed(1)}`
}

export default function EquipmentPage() {
  const { refresh: refreshRigs } = useEquipment()
  const [equipment, setEquipment] = useState<ApEquipment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [submitting, setSubmitting] = useState(false)
  const [confirmingId, setConfirmingId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  useEffect(() => {
    getEquipment()
      .then(setEquipment)
      .catch(() => setError('Failed to load equipment'))
      .finally(() => setLoading(false))
  }, [])

  const openAdd = () => {
    setEditingId(null); setForm(emptyForm); setShowForm(true); setError(null); setConfirmingId(null)
  }

  const openEdit = (eq: ApEquipment) => {
    setEditingId(eq.id)
    setForm({
      name: eq.name,
      focal_length: String(eq.focal_length),
      focal_ratio: String(eq.focal_ratio),
      reducer: String(eq.reducer),
      sensor: eq.sensor in SENSORS ? eq.sensor : '585',
      binning: String(eq.binning),
    })
    setShowForm(true); setError(null); setConfirmingId(null)
  }

  const handleCancel = () => {
    setShowForm(false); setEditingId(null); setForm(emptyForm); setError(null)
  }

  const set = (field: keyof FormState) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => setForm(f => ({ ...f, [field]: e.target.value }))

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) return
    setSubmitting(true); setError(null)
    const payload: CreateApEquipmentDto = {
      name: form.name.trim(),
      focal_length: Number(form.focal_length),
      focal_ratio: Number(form.focal_ratio),
      reducer: form.reducer.trim() === '' ? 1.0 : Number(form.reducer),
      sensor: form.sensor,
      binning: Number(form.binning),
    }
    try {
      if (editingId !== null) {
        const updated = await updateEquipment(editingId, payload)
        setEquipment(prev => prev.map(eq => eq.id === editingId ? updated : eq))
      } else {
        const created = await createEquipment(payload)
        setEquipment(prev => [...prev, created])
      }
      void refreshRigs()
      handleCancel()
    } catch {
      setError(editingId !== null ? 'Failed to update equipment' : 'Failed to create equipment')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (id: number) => {
    setDeletingId(id)
    try {
      await deleteEquipment(id)
      setEquipment(prev => prev.filter(eq => eq.id !== id))
      void refreshRigs()
      setConfirmingId(null)
      if (editingId === id) handleCancel()
    } catch {
      setError('Failed to delete equipment')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="objects-page">
      <div className="page-header">
        <h2>Equipment</h2>
        <button className={`btn ${showForm && editingId === null ? 'btn-ghost' : 'btn-primary'}`}
          onClick={showForm && editingId === null ? handleCancel : openAdd}>
          {showForm && editingId === null ? 'Cancel' : '+ Add Equipment'}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {showForm && (
        <form className="object-form" onSubmit={handleSubmit}>
          <p className="form-title">{editingId !== null ? 'Edit Equipment' : 'New Equipment'}</p>
          <div className="form-grid">
            <div className="form-field form-field--full">
              <label htmlFor="eq-name">Name</label>
              <input id="eq-name" value={form.name} onChange={set('name')} required
                placeholder="e.g. Redcat 51 + IMX571" autoFocus />
            </div>
            <div className="form-field">
              <label htmlFor="eq-fl">Focal length (mm)</label>
              <input id="eq-fl" type="number" min="1" step="1" value={form.focal_length}
                onChange={set('focal_length')} required placeholder="e.g. 250" />
            </div>
            <div className="form-field">
              <label htmlFor="eq-fr">Focal ratio (f/)</label>
              <input id="eq-fr" type="number" min="0.1" step="0.1" value={form.focal_ratio}
                onChange={set('focal_ratio')} required placeholder="e.g. 4.9" />
            </div>
            <div className="form-field">
              <label htmlFor="eq-reducer">Reducer / Teleconverter (×)</label>
              <input id="eq-reducer" type="number" min="0.1" step="0.01" value={form.reducer}
                onChange={set('reducer')} placeholder="1.0" />
            </div>
            <div className="form-field">
              <label htmlFor="eq-sensor">Camera sensor</label>
              <select id="eq-sensor" value={form.sensor} onChange={set('sensor')}>
                {Object.entries(SENSORS).map(([key, s]) => (
                  <option key={key} value={key}>{s.label} ({s.width} × {s.height})</option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="eq-binning">Binning</label>
              <select id="eq-binning" value={form.binning} onChange={set('binning')}>
                {BINNINGS.map(b => <option key={b} value={b}>Bin {b}</option>)}
              </select>
            </div>
          </div>
          <div className="form-field form-field--full">
            <span className="cell-muted" style={{ fontSize: '0.85rem' }}>
              Resolution: <strong>{resolution(form.sensor, Number(form.binning) || 1)}</strong>
              {form.focal_length && form.reducer && (
                <> · Image scale: <strong>{imageScale({
                  focal_length: Number(form.focal_length),
                  reducer: Number(form.reducer) || 1,
                  sensor: form.sensor,
                  binning: Number(form.binning) || 1,
                })}</strong></>
              )}
            </span>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={submitting || !form.name.trim()}>
              {submitting ? 'Saving…' : editingId !== null ? 'Update Equipment' : 'Save Equipment'}
            </button>
            {editingId !== null && (
              <button type="button" className="btn btn-ghost" onClick={handleCancel}>Cancel</button>
            )}
          </div>
        </form>
      )}

      {loading ? (
        <p className="state-msg">Loading…</p>
      ) : equipment.length === 0 ? (
        <p className="state-msg">No equipment yet — add one above.</p>
      ) : (
        <div className="table-wrap">
          {/* Seven columns is a rig spec sheet, not something a phone can hold
              as a table — below 700px each row becomes a card. */}
          <table className="data-table data-table--cards data-table--equipment">
            <thead>
              <tr>
                <th>Name</th>
                <th>Optics</th>
                <th>Sensor</th>
                <th>Resolution</th>
                <th>Binning</th>
                <th>Image scale</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {equipment.map(eq => (
                <tr key={eq.id} className={`row--card ${editingId === eq.id ? 'row--editing' : ''}`}>
                  <td className="cell-name">{eq.name}</td>
                  <td className="cell-muted cell-eq-optics" data-label="Optics">{effectiveFocal(eq)}</td>
                  <td className="cell-eq-sensor"><span className="type-badge">{SENSORS[eq.sensor]?.label ?? eq.sensor}</span></td>
                  <td className="cell-muted cell-eq-res" data-label="Resolution">{resolution(eq.sensor, eq.binning)}</td>
                  <td className="cell-muted cell-eq-binning">Bin {eq.binning}</td>
                  <td className="cell-time cell-eq-scale" data-label="Image scale">{imageScale(eq)}</td>
                  <td className="cell-action">
                    <div className="row-actions">
                      <button className="btn-icon btn-edit" onClick={() => openEdit(eq)} title="Edit">✎</button>
                      <button className="btn-icon btn-danger" onClick={() => setConfirmingId(eq.id)} title="Delete">✕</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirmingId !== null && (() => {
        const eq = equipment.find(e => e.id === confirmingId)
        return (
          <div className="modal-backdrop" onClick={() => setConfirmingId(null)}>
            <div className="modal-dialog" onClick={e => e.stopPropagation()}>
              <div className="modal-dialog__header">
                <span className="modal-dialog__title">Delete equipment?</span>
              </div>
              <p style={{ color: '#cbd5e1', margin: 0 }}>
                <strong style={{ color: '#e2e8f0' }}>{eq?.name}</strong> will be permanently deleted.
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
