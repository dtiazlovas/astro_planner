import { connectToDatabase } from '../db.js'

// ── PSFSW display anchors ────────────────────────────────────────────────────
// PSF Signal Weight is dimensionless but its magnitude depends on the target,
// the filter and the sky, so it is always shown as a ratio against a reference.
// That reference is stored here, per object+filter, and never recomputed on its
// own: the whole point is that a sub measured last winter reads the same number
// today. The median itself is computed on the client, which is where filenames
// are parsed into a target and a filter.

export interface PsfswAnchor {
  object: number
  filter: number
  anchor: number
  subs: number      // how many subs the median was taken over, for the UI
  set_at: string
}

export const getPsfswAnchors = async (): Promise<PsfswAnchor[]> =>
  connectToDatabase().prepare('SELECT object, filter, anchor, subs, set_at FROM ap_psfsw_anchor').all() as PsfswAnchor[]

/**
 * Establishes the anchor for a pair, or leaves the existing one alone.
 *
 * First writer wins: two screens can reach for the same scale at once, and a
 * later one must not quietly redefine what the numbers already on screen mean.
 * Returns the anchor now in force, whichever of the two it is.
 */
export const ensurePsfswAnchor = async (object: number, filter: number, anchor: number, subs: number): Promise<PsfswAnchor> => {
  const db = connectToDatabase()
  db.prepare(`
    INSERT OR IGNORE INTO ap_psfsw_anchor (object, filter, anchor, subs, set_at)
    VALUES (@object, @filter, @anchor, @subs, @set_at)
  `).run({ object, filter, anchor, subs, set_at: new Date().toISOString() })
  return db.prepare('SELECT object, filter, anchor, subs, set_at FROM ap_psfsw_anchor WHERE object = @object AND filter = @filter')
    .get({ object, filter }) as PsfswAnchor
}

// Deliberate re-baseline: replaces the frozen scale. Every number already shown
// for this pair shifts by the ratio of old to new, so this is only ever driven
// by an explicit click.
export const setPsfswAnchor = async (object: number, filter: number, anchor: number, subs: number): Promise<PsfswAnchor> => {
  const db = connectToDatabase()
  db.prepare(`
    INSERT INTO ap_psfsw_anchor (object, filter, anchor, subs, set_at)
    VALUES (@object, @filter, @anchor, @subs, @set_at)
    ON CONFLICT(object, filter) DO UPDATE SET anchor = @anchor, subs = @subs, set_at = @set_at
  `).run({ object, filter, anchor, subs, set_at: new Date().toISOString() })
  return db.prepare('SELECT object, filter, anchor, subs, set_at FROM ap_psfsw_anchor WHERE object = @object AND filter = @filter')
    .get({ object, filter }) as PsfswAnchor
}
