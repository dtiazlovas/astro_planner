import type { ApObject, ObjectFilterStat, PlanProgressItem, ApObjectType, ApSession, CreateApObjectDto, CreateApSessionDto, ApObjectSession, CreateApObjectSessionDto, ApExposure, ApFilter, ApPlan, ApPlanDetail, ApPlanSession } from '../types'

const BASE = '/api'

const json = <T>(res: Response): Promise<T> => {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

export const getObjectTypes = (): Promise<ApObjectType[]> =>
  fetch(`${BASE}/object-types`).then(json<ApObjectType[]>)

export const getObjects = (): Promise<ApObject[]> =>
  fetch(`${BASE}/objects`).then(json<ApObject[]>)

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

export const getObjectFilterStats = (id: number): Promise<ObjectFilterStat[]> =>
  fetch(`${BASE}/objects/${id}/filter-stats`).then(json<ObjectFilterStat[]>)

export const getObjectPlanProgress = (id: number): Promise<PlanProgressItem[]> =>
  fetch(`${BASE}/objects/${id}/plan-progress`).then(json<PlanProgressItem[]>)

export const assignToActivePlan = (id: number): Promise<{ assigned: number }> =>
  fetch(`${BASE}/objects/${id}/assign-to-plan`, { method: 'POST' }).then(json<{ assigned: number }>)

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

export const getSessions = (): Promise<ApSession[]> =>
  fetch(`${BASE}/sessions`).then(json<ApSession[]>)

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

export const createFilter = (data: { name: string; aliases: string | null }): Promise<ApFilter> =>
  fetch(`${BASE}/filters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(json<ApFilter>)

export const updateFilter = (id: number, data: { name: string; aliases: string | null }): Promise<ApFilter> =>
  fetch(`${BASE}/filters/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(json<ApFilter>)

export const deleteFilter = (id: number): Promise<void> =>
  fetch(`${BASE}/filters/${id}`, { method: 'DELETE' }).then(() => undefined)

export const getObjectSessions = (sessionId: number): Promise<ApObjectSession[]> =>
  fetch(`${BASE}/object-sessions?session=${sessionId}`).then(json<ApObjectSession[]>)

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
  fetch(`${BASE}/object-sessions/${id}`, { method: 'DELETE' }).then(() => undefined)

export const checkImported = (names: string[]): Promise<string[]> =>
  fetch(`${BASE}/imported/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ names }),
  }).then(json<string[]>)

export const recordImported = (names: string[]): Promise<void> =>
  fetch(`${BASE}/imported/record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ names }),
  }).then(() => undefined)

export const getPlans = (objectId?: number): Promise<ApPlan[]> =>
  fetch(`${BASE}/plans${objectId !== undefined ? `?object=${objectId}` : ''}`).then(json<ApPlan[]>)

export const createPlan = (data: { object: number; name: string; active: boolean }): Promise<ApPlan> =>
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
