import type { ApObject, ObjectFilterStat, PlanProgressItem, ApObjectType, ApSession, CreateApObjectDto, CreateApSessionDto, ApObjectSession, CreateApObjectSessionDto, ApExposure, ApFilter, ApPlan, ApPlanDetail, ApPlanSession, ApEquipment, CreateApEquipmentDto } from '../types'
import type { FitsAnalysis } from '../utils/fits'

const BASE = '/api'

const json = <T>(res: Response): Promise<T> => {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

// Builds a `?equipment=ID` query suffix, omitted when no rig is active.
const eqQuery = (equipment?: number | null, lead = '?'): string =>
  equipment != null ? `${lead}equipment=${equipment}` : ''

export const getObjectTypes = (): Promise<ApObjectType[]> =>
  fetch(`${BASE}/object-types`).then(json<ApObjectType[]>)

export const getObjects = (equipment?: number | null): Promise<ApObject[]> =>
  fetch(`${BASE}/objects${eqQuery(equipment)}`).then(json<ApObject[]>)

export const createObject = (data: CreateApObjectDto): Promise<ApObject> =>
  fetch(`${BASE}/objects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(json<ApObject>)

export const updateObject = (id: number, data: Partial<Omit<ApObject, 'id'>>): Promise<ApObject> =>
  fetch(`${BASE}/objects/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(json<ApObject>)

export const getObjectFilterStats = (id: number, equipment?: number | null): Promise<ObjectFilterStat[]> =>
  fetch(`${BASE}/objects/${id}/filter-stats${eqQuery(equipment)}`).then(json<ObjectFilterStat[]>)

export const getAllFilterStats = (equipment?: number | null): Promise<ObjectFilterStat[]> =>
  fetch(`${BASE}/objects/filter-stats${eqQuery(equipment)}`).then(json<ObjectFilterStat[]>)

export const getObjectPlanProgress = (id: number, equipment?: number | null): Promise<PlanProgressItem[]> =>
  fetch(`${BASE}/objects/${id}/plan-progress${eqQuery(equipment)}`).then(json<PlanProgressItem[]>)

export const assignToActivePlan = (id: number, equipment?: number | null): Promise<{ assigned: number }> =>
  fetch(`${BASE}/objects/${id}/assign-to-plan${eqQuery(equipment)}`, { method: 'POST' }).then(json<{ assigned: number }>)

export const reorderObjects = (ids: number[]): Promise<ApObject[]> =>
  fetch(`${BASE}/objects/reorder`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }).then(json<ApObject[]>)

export const deleteObject = (id: number): Promise<void> =>
  fetch(`${BASE}/objects/${id}`, { method: 'DELETE' }).then(() => undefined)

export const updateSession = (id: number, data: Partial<Omit<ApSession, 'id'>>): Promise<ApSession> =>
  fetch(`${BASE}/sessions/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(json<ApSession>)

export const getSessions = (equipment?: number | null): Promise<ApSession[]> =>
  fetch(`${BASE}/sessions${eqQuery(equipment)}`).then(json<ApSession[]>)

export const createSession = (data: CreateApSessionDto): Promise<ApSession> =>
  fetch(`${BASE}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(json<ApSession>)

export const deleteSession = (id: number): Promise<void> =>
  fetch(`${BASE}/sessions/${id}`, { method: 'DELETE' }).then(() => undefined)

export const getExposures = (): Promise<ApExposure[]> =>
  fetch(`${BASE}/exposures`).then(json<ApExposure[]>)

export const getFilters = (): Promise<ApFilter[]> =>
  fetch(`${BASE}/filters`).then(json<ApFilter[]>)

export const createFilter = (data: { name: string; aliases: string | null; folder?: string | null }): Promise<ApFilter> =>
  fetch(`${BASE}/filters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(json<ApFilter>)

export const updateFilter = (id: number, data: { name: string; aliases: string | null; folder?: string | null }): Promise<ApFilter> =>
  fetch(`${BASE}/filters/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(json<ApFilter>)

export const deleteFilter = (id: number): Promise<void> =>
  fetch(`${BASE}/filters/${id}`, { method: 'DELETE' }).then(() => undefined)

export const getObjectSessions = (sessionId: number): Promise<ApObjectSession[]> =>
  fetch(`${BASE}/object-sessions?session=${sessionId}`).then(json<ApObjectSession[]>)

export const getObjectSessionsForObject = (objectId: number): Promise<ApObjectSession[]> =>
  fetch(`${BASE}/object-sessions?object=${objectId}`).then(json<ApObjectSession[]>)

export const createObjectSession = (data: CreateApObjectSessionDto): Promise<ApObjectSession> =>
  fetch(`${BASE}/object-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(json<ApObjectSession>)

export const updateObjectSession = (id: number, data: Partial<CreateApObjectSessionDto>): Promise<ApObjectSession> =>
  fetch(`${BASE}/object-sessions/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(json<ApObjectSession>)

export const deleteObjectSession = (id: number): Promise<void> =>
  fetch(`${BASE}/object-sessions/${id}`, { method: 'DELETE' })
    .then(res => { if (!res.ok) throw new Error(`${res.status} ${res.statusText}`) })

export const checkImported = (names: string[]): Promise<string[]> =>
  fetch(`${BASE}/imported/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ names }),
  }).then(json<string[]>)

// `objectSessionId` links the files to the session entry they were imported
// under; deleting that entry then deletes these records too.
export const recordImported = (names: string[], sessionId: number, objectSessionId: number | null = null): Promise<void> =>
  fetch(`${BASE}/imported/record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ names, sessionId, objectSessionId }),
  }).then(() => undefined)

// Points existing records at a session entry — used by the object file sync to
// attribute records that predate the link, and to move records off entries it
// is about to merge away.
export const relinkImported = (names: string[], objectSessionId: number): Promise<{ relinked: number }> =>
  fetch(`${BASE}/imported/relink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ names, objectSessionId }),
  }).then(json<{ relinked: number }>)

export interface ImportedRecord {
  filename: string
  session_id: number | null
  // the session entry this file was imported under, null for records predating
  // the link or belonging to a multi-entry session no sync has attributed yet
  object_session_id: number | null
  // persisted quality analysis: raw PSFSW and FWHM in pixels
  psfsw: number | null
  fwhm: number | null
}

export const getImportedRecords = (): Promise<ImportedRecord[]> =>
  fetch(`${BASE}/imported`, { cache: 'no-store' }).then(json<ImportedRecord[]>)

export const saveImportedAnalysis = (items: { filename: string; psfsw: number | null; fwhm: number | null }[]): Promise<{ updated: number }> =>
  fetch(`${BASE}/imported/analysis`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  }).then(json<{ updated: number }>)

export const removeImported = (names: string[]): Promise<{ removed: number }> =>
  fetch(`${BASE}/imported/remove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ names }),
  }).then(json<{ removed: number }>)

// Lists files present in an object's folder on the server ('backend' file mode).
export const getObjectFolderFilesViaBackend = (objectFolder: string): Promise<string[]> =>
  fetch(`${BASE}/imported/object-files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ objectFolder }),
  }).then(json<string[]>)

// Deletes subs (and their derived copies) from an object's folder on the server.
export const deleteObjectFilesViaBackend = (objectFolder: string, fileNames: string[]): Promise<{ deleted: number; failed: number }> =>
  fetch(`${BASE}/imported/delete-object-files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ objectFolder, fileNames }),
  }).then(json<{ deleted: number; failed: number }>)

// ── Server-side file operations — used only in 'backend' import file mode ───
// The server locates files by name in the images folder's parent tree, so
// sources must live on the server machine; the browser never reads the bytes.

export interface BackendCopyItem { fileNames: string[]; objectFolder: string; filterName: string }
export interface BackendCopyStats { copied: number; skipped: number; notFound: number; failed: number }

export const copyFilesViaBackend = (items: BackendCopyItem[]): Promise<BackendCopyStats> =>
  fetch(`${BASE}/imported/copy-to-object-folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  }).then(json<BackendCopyStats>)

export const analyzeFitsViaBackend = (fileNames: string[], normalize = true, signal?: AbortSignal): Promise<FitsAnalysis[]> =>
  fetch(`${BASE}/fits/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileNames, normalize }),
    signal,
  }).then(json<FitsAnalysis[]>)

// Opens a sub in the OS default app on the server machine. The server's message
// is the useful part here (folder not set, file not found), so it's unwrapped.
export const openFitsFile = async (fileName: string): Promise<{ path: string }> => {
  const res = await fetch(`${BASE}/fits/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName }),
  })
  const body = await res.json().catch(() => null) as { path?: string; error?: string } | null
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
  return { path: body?.path ?? '' }
}

export const getPlans = (objectId?: number, equipment?: number | null): Promise<ApPlan[]> => {
  const params = [objectId !== undefined ? `object=${objectId}` : '', equipment != null ? `equipment=${equipment}` : ''].filter(Boolean)
  return fetch(`${BASE}/plans${params.length ? `?${params.join('&')}` : ''}`).then(json<ApPlan[]>)
}

export const createPlan = (data: { object: number; name: string; active: boolean; equipment?: number | null }): Promise<ApPlan> =>
  fetch(`${BASE}/plans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(json<ApPlan>)

export const updatePlan = (id: number, data: Partial<Omit<ApPlan, 'id' | 'object'>>): Promise<ApPlan> =>
  fetch(`${BASE}/plans/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(json<ApPlan>)

export const deletePlan = (id: number): Promise<void> =>
  fetch(`${BASE}/plans/${id}`, { method: 'DELETE' }).then(() => undefined)

export const getPlanDetails = (planId: number): Promise<ApPlanDetail[]> =>
  fetch(`${BASE}/plan-details?plan=${planId}`).then(json<ApPlanDetail[]>)

export const createPlanDetail = (data: { planid: number; filter: number; duration: number }): Promise<ApPlanDetail> =>
  fetch(`${BASE}/plan-details`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(json<ApPlanDetail>)

export const updatePlanDetail = (id: number, data: { filter?: number; duration?: number }): Promise<ApPlanDetail> =>
  fetch(`${BASE}/plan-details/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(json<ApPlanDetail>)

export const deletePlanDetail = (id: number): Promise<void> =>
  fetch(`${BASE}/plan-details/${id}`, { method: 'DELETE' }).then(() => undefined)

export const setPlanSession = (data: { session: number; planid: number }): Promise<ApPlanSession> =>
  fetch(`${BASE}/plan-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(json<ApPlanSession>)

export const deletePlanSession = (id: number): Promise<void> =>
  fetch(`${BASE}/plan-sessions/${id}`, { method: 'DELETE' }).then(() => undefined)

export const getEquipment = (): Promise<ApEquipment[]> =>
  fetch(`${BASE}/equipment`).then(json<ApEquipment[]>)

export const createEquipment = (data: CreateApEquipmentDto): Promise<ApEquipment> =>
  fetch(`${BASE}/equipment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(json<ApEquipment>)

export const updateEquipment = (id: number, data: CreateApEquipmentDto): Promise<ApEquipment> =>
  fetch(`${BASE}/equipment/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(json<ApEquipment>)

export const deleteEquipment = (id: number): Promise<void> =>
  fetch(`${BASE}/equipment/${id}`, { method: 'DELETE' }).then(() => undefined)
