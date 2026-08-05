import { useState } from 'react'
import ObjectsPage from './pages/ObjectsPage'
import SessionsPage from './pages/SessionsPage'
import CalendarPage from './pages/CalendarPage'
import EquipmentPage from './pages/EquipmentPage'
import SettingsPage from './pages/SettingsPage'
import TotalsBar from './components/TotalsBar'
import { useEquipment } from './context/EquipmentContext'
import './index.css'

type Page = 'objects' | 'sessions' | 'calendar' | 'equipment' | 'settings'

function RigSelector() {
  const { equipment, activeId, setActiveId } = useEquipment()
  if (equipment.length === 0) return null
  return (
    <label className="rig-selector" title="Active rig — filters and tags all data">
      <span className="rig-selector__label">Rig</span>
      <select
        className="rig-selector__select"
        value={activeId ?? ''}
        onChange={e => setActiveId(e.target.value ? Number(e.target.value) : null)}
      >
        {equipment.map(eq => <option key={eq.id} value={eq.id}>{eq.name}</option>)}
      </select>
    </label>
  )
}

export default function App() {
  const [page, setPage] = useState<Page>('objects')

  return (
    <div className="app">
      <TotalsBar refreshKey={page} />
      <header className="app-header">
        <h1>Astro Session Logger</h1>
        <nav className="app-nav">
          {(['objects', 'sessions', 'calendar', 'equipment', 'settings'] as Page[]).map(p => (
            <button key={p} className={`nav-link ${page === p ? 'nav-link--active' : ''}`} onClick={() => setPage(p)}>
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </button>
          ))}
        </nav>
        <RigSelector />
      </header>
      <main className="app-main">
        {page === 'objects' && <ObjectsPage />}
        {page === 'sessions' && <SessionsPage />}
        {page === 'calendar' && <CalendarPage />}
        {page === 'equipment' && <EquipmentPage />}
        {page === 'settings' && <SettingsPage />}
      </main>
      <footer className="app-footer">
        Icons by <a href="https://www.flaticon.com/" target="_blank" rel="noopener noreferrer">Flaticon</a>
      </footer>
    </div>
  )
}
