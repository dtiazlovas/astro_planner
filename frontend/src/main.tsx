import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { EquipmentProvider } from './context/EquipmentContext'

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')

createRoot(root).render(
  <StrictMode>
    <EquipmentProvider>
      <App />
    </EquipmentProvider>
  </StrictMode>,
)
