import { connectToDatabase } from '../db.js'

// ── PSFSW display anchors ────────────────────────────────────────────────────
// PSF Signal Weight is dimensionless but its magnitude depends on the target,
// filter and sky, so it is shown as a ratio against a reference. That reference
// is stored here per object+filter(+mosaic panel) and never recomputed on its
// own: the point is that a sub measured last winter reads the same number today.
// Each mosaic panel is a different star field, so each gets its own scale; a
// plain object's pairs use panel ''. The median is computed on the client, where
// filenames are parsed into target, panel and filter.

export interface PsfswAnchor {
  object: number
  filter: number
  panel: string     // '' for a plain object
  anchor: number
  subs: number      // how many subs the median was taken over, for the UI
  set_at: string
}

const COLS = 'object, filter, panel, anchor, subs, set_at'
const WHERE_KEY = 'object = @object AND filter = @filter AND panel = @panel'

export const getPsfswAnchors = async (): Promise<PsfswAnchor[]> =>
  connectToDatabase().prepare(`SELECT ${COLS} FROM ap_psfsw_anchor`).all() as PsfswAnchor[]

/**
 * Establishes the anchor for a pair, or leaves the existing one alone. First
 * writer wins — two screens can reach for the same scale at once, and a later
 * one must not redefine what the numbers already on screen mean. Returns the
 * anchor now in force.
 */
export const ensurePsfswAnchor = async (object: number, filter: number, panel: string, anchor: number, subs: number): Promise<PsfswAnchor> => {
  const db = connectToDatabase()
  db.prepare(`
    INSERT OR IGNORE INTO ap_psfsw_anchor (${COLS})
    VALUES (@object, @filter, @panel, @anchor, @subs, @set_at)
  `).run({ object, filter, panel, anchor, subs, set_at: new Date().toISOString() })
  return db.prepare(`SELECT ${COLS} FROM ap_psfsw_anchor WHERE ${WHERE_KEY}`).get({ object, filter, panel }) as PsfswAnchor
}

// Deliberate re-baseline: replaces the frozen scale. Every number already shown
// for this pair shifts by the ratio of old to new, so this is only ever driven
// by an explicit click.
export const setPsfswAnchor = async (object: number, filter: number, panel: string, anchor: number, subs: number): Promise<PsfswAnchor> => {
  const db = connectToDatabase()
  db.prepare(`
    INSERT INTO ap_psfsw_anchor (${COLS})
    VALUES (@object, @filter, @panel, @anchor, @subs, @set_at)
    ON CONFLICT(object, filter, panel) DO UPDATE SET anchor = @anchor, subs = @subs, set_at = @set_at
  `).run({ object, filter, panel, anchor, subs, set_at: new Date().toISOString() })
  return db.prepare(`SELECT ${COLS} FROM ap_psfsw_anchor WHERE ${WHERE_KEY}`).get({ object, filter, panel }) as PsfswAnchor
}
