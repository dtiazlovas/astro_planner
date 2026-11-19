// Name → coordinates through CDS Sesame, called straight from the browser (it
// answers with CORS `*`), so the server stays out of it like it stays out of
// every other external thing. Sesame tries SIMBAD, then NED, then VizieR, and
// answers from the first that knows the name.

import type { SkyPosition } from './astro'

const SESAME = 'https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV?'

export interface LookupResult extends SkyPosition {
  /** The catalogue's main identifier, e.g. "M 31" for "Andromeda Galaxy". */
  name: string
  /** SIMBAD object type code, e.g. "HII", "G", "PN"; null when the resolver gives none. */
  otype: string | null
  /** Which database answered, e.g. "Simbad". */
  source: string
}

/** Resolves a name; null when no database knows it. Throws on network failure. */
export async function resolveObjectName(query: string, signal?: AbortSignal): Promise<LookupResult | null> {
  const q = query.trim()
  if (!q) return null
  const res = await fetch(SESAME + encodeURIComponent(q), { signal })
  if (!res.ok) throw new Error(`Lookup service answered ${res.status}`)
  const doc = new DOMParser().parseFromString(await res.text(), 'text/xml')
  if (doc.querySelector('parsererror')) throw new Error('Lookup service sent an unreadable answer')

  for (const resolver of Array.from(doc.getElementsByTagName('Resolver'))) {
    const text = (tag: string) => resolver.getElementsByTagName(tag)[0]?.textContent?.trim() || null
    const ra = parseFloat(text('jradeg') ?? ''), dec = parseFloat(text('jdedeg') ?? '')
    if (!isFinite(ra) || !isFinite(dec)) continue
    // "S=Simbad, IDIA (via url)" → "Simbad"
    const source = (resolver.getAttribute('name') ?? '').replace(/^\w=/, '').split(/[,(]/)[0].trim() || 'Sesame'
    return {
      ra, dec,
      // SIMBAD prefixes nicknames with "NAME " — an identifier convention, not part of the name.
      name: (text('oname') ?? q).replace(/^NAME\s+/, ''),
      otype: text('otype'),
      source,
    }
  }
  return null
}
