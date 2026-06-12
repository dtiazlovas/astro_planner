import { useState } from 'react'
import ObjectsPage from './pages/ObjectsPage'
import SessionsPage from './pages/SessionsPage'
import SettingsPage from './pages/SettingsPage'
import './index.css'

type Page = 'objects' | 'sessions' | 'settings'

export default function App() {
  const [page, setPage] = useState<Page>('objects')

  return (
    <div className="app">
      <header className="app-header">
        <h1>Astro Session Logger</h1>
        <nav className="app-nav">
          {(['objects', 'sessions', 'settings'] as Page[]).map(p => (
            <button key={p} className={`nav-link ${page === p ? 'nav-link--active' : ''}`} onClick={() => setPage(p)}>
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </button>
          ))}
        </nav>
      </header>
      <main className="app-main">
        {page === 'objects' && <ObjectsPage />}
        {page === 'sessions' && <SessionsPage />}
        {page === 'settings' && <SettingsPage />}
      </main>
      <footer className="app-footer">
        Icons by <a href="https://www.flaticon.com/" target="_blank" rel="noopener noreferrer">Flaticon</a>
      </footer>
    </div>
  )
}
