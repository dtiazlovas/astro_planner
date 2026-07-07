import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { getEquipment } from '../api'
import type { ApEquipment } from '../types'

interface EquipmentContextValue {
  equipment: ApEquipment[]
  activeId: number | null
  setActiveId: (id: number | null) => void
  refresh: () => Promise<void>
  loading: boolean
}

const EquipmentContext = createContext<EquipmentContextValue | null>(null)
const STORAGE_KEY = 'astro-active-equipment'

export function EquipmentProvider({ children }: { children: ReactNode }) {
  const [equipment, setEquipment] = useState<ApEquipment[]>([])
  const [loading, setLoading] = useState(true)
  const [activeId, setActiveIdState] = useState<number | null>(() => {
    const v = localStorage.getItem(STORAGE_KEY)
    return v ? Number(v) : null
  })

  const setActiveId = (id: number | null) => {
    setActiveIdState(id)
    if (id == null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, String(id))
  }

  const refresh = async () => {
    try {
      setEquipment(await getEquipment())
    } catch {
      // leave existing list in place on failure
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])

  // Keep the active rig valid: default to the first one, or clear if none exist.
  useEffect(() => {
    if (loading) return
    if (equipment.length === 0) {
      if (activeId !== null) setActiveId(null)
    } else if (activeId == null || !equipment.some(e => e.id === activeId)) {
      setActiveId(equipment[0].id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [equipment, loading])

  return (
    <EquipmentContext.Provider value={{ equipment, activeId, setActiveId, refresh, loading }}>
      {children}
    </EquipmentContext.Provider>
  )
}

export function useEquipment(): EquipmentContextValue {
  const ctx = useContext(EquipmentContext)
  if (!ctx) throw new Error('useEquipment must be used within an EquipmentProvider')
  return ctx
}
