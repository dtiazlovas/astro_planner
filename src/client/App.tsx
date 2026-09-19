import { useState } from 'react'
import ObjectsPage from './pages/ObjectsPage'
import SessionsPage from './pages/SessionsPage'
import CalendarPage from './pages/CalendarPage'
import EquipmentPage from './pages/EquipmentPage'
import SettingsPage from './pages/SettingsPage'
import NavIcon from './components/NavIcons'
import TotalsBar, { TotalsSummary } from './components/TotalsBar'
import { useEquipment } from './context/EquipmentContext'
import './index.css'

type Page = 'objects' | 'sessions' | 'calendar' | 'equipment' | 'settings'

const PAGES: Page[] = ['objects', 'sessions', 'calendar', 'equipment', 'settings']

function RigSelector() {
  const { equipment, activeId, setActiveId } = useEquipment()
  if (equipment.length === 0) return null
  // No visible label — the rig names say what the control is, so the name it
  // needs for a screen reader comes off the select itself instead.
  return (
    <div className="rig-selector" title="Active rig — filters and tags all data">
      <select
        className="rig-selector__select"
        aria-label="Active rig"
        value={activeId ?? ''}
        onChange={e => setActiveId(e.target.value ? Number(e.target.value) : null)}
      >
        {equipment.map(eq => <option key={eq.id} value={eq.id}>{eq.name}</option>)}
      </select>
    </div>
  )
}

export default function App() {
  const [page, setPage] = useState<Page>('objects')
  // Import has no page of its own: the nav entry lands on Sessions with the
  // import panel open and its file picker already up. Counted rather than
  // flagged so pressing it again re-opens the picker, and cleared by any other
  // nav click so coming back to Sessions later doesn't re-trigger it.
  const [importRequest, setImportRequest] = useState(0)

  const goTo = (p: Page) => { setPage(p); setImportRequest(0) }
  const requestImport = () => { setPage('sessions'); setImportRequest(n => n + 1) }

  return (
    <div className="app">
      {/* Brand, nav and totals live together so they can be a left rail on a
          wide screen and stack back into a top bar on a narrow one. The rail
          has room for the full totals at its foot; the top bar doesn't, so
          there the headline numbers ride up beside the rig selector instead
          and only the per-filter breakdown stays in the bar. */}
      <aside className="app-side">
        <div className="app-side__brand">
          <h1>Astro Logger</h1>
          <div className="app-side__rig">
            <TotalsSummary refreshKey={page} />
            <RigSelector />
          </div>
        </div>
        {/* Import leads the nav because nearly every visit starts there. It is
            the one entry that runs an action instead of switching pages, so it
            never takes the active state — only a tint that sets it apart. */}
        <nav className="app-nav">
          {/* aria-label on every entry, not just for show: on a phone the labels
              are hidden and the icon alone is what's left, and a hidden label
              contributes nothing to an accessible name. */}
          <button className="nav-link nav-link--import" onClick={requestImport} aria-label="Import files" title="Import files">
            <NavIcon name="import" />
            {/* Nested so the top bar can drop "files" on its own — the space
                belongs to the word it precedes. */}
            <span className="nav-link__label">Import<span className="nav-link__word"> files</span></span>
          </button>
          {PAGES.map(p => {
            const label = p.charAt(0).toUpperCase() + p.slice(1)
            return (
              <button key={p} className={`nav-link ${page === p ? 'nav-link--active' : ''}`}
                onClick={() => goTo(p)} aria-label={label} title={label}>
                <NavIcon name={p} />
                <span className="nav-link__label">{label}</span>
              </button>
            )
          })}
        </nav>
        <TotalsBar refreshKey={page} />
      </aside>
      <div className="app-body">
        <main className="app-main">
          {page === 'objects' && <ObjectsPage />}
          {page === 'sessions' && <SessionsPage importRequest={importRequest} />}
          {page === 'calendar' && <CalendarPage />}
          {page === 'equipment' && <EquipmentPage />}
          {page === 'settings' && <SettingsPage />}
        </main>
        <footer className="app-footer">
          Icons by <a href="https://www.flaticon.com/" target="_blank" rel="noopener noreferrer">Flaticon</a>
        </footer>
      </div>
    </div>
  )
}
