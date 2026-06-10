const FILTER_COLORS: Record<string, string> = {
  'ha':        '#e05252',
  'hα':        '#e05252',
  'h-alpha':   '#e05252',
  'halpha':    '#e05252',
  'oxygen':    '#14b8a6',
  'oiii':      '#14b8a6',
  'o3':        '#14b8a6',
  'sulphur':   '#f97316',
  'sii':       '#f97316',
  's2':        '#f97316',
  'l':         '#9ca3af',
  'lum':       '#9ca3af',
  'luminance': '#9ca3af',
  'r':         '#e05252',
  'red':       '#e05252',
  'g':         '#4ade80',
  'green':     '#4ade80',
  'b':         '#60a5fa',
  'blue':      '#60a5fa',
  'uv':        '#a78bfa',
  'ir':        '#fb923c',
}

const FILTER_DOT_COLORS: Record<string, string> = {
  'ha':        '#3f0808',
  'hα':        '#3f0808',
  'h-alpha':   '#3f0808',
  'halpha':    '#3f0808',
  'oxygen':    '#042f2e',
  'oiii':      '#042f2e',
  'o3':        '#042f2e',
  'sulphur':   '#431407',
  'sii':       '#431407',
  's2':        '#431407',
}

const getFilterColor = (name: string | null): string | null => {
  if (!name) return null
  return FILTER_COLORS[name.toLowerCase().trim()] ?? null
}

const getFilterDotColor = (name: string | null): string | null => {
  if (!name) return null
  const key = name.toLowerCase().trim()
  return FILTER_DOT_COLORS[key] ?? FILTER_COLORS[key] ?? null
}

interface Props {
  name: string | null
}

export default function FilterBadge({ name }: Props) {
  const color = getFilterColor(name)
  const dotColor = getFilterDotColor(name)
  return (
    <span
      className="type-badge"
      style={color ? { background: `${color}22`, color, outline: `1.5px solid ${color}99` } : undefined}
    >
      {color && <span className="filter-badge-dot" style={{ background: dotColor ?? color, boxShadow: `0 0 0 1.5px ${color}99` }} />}
      {name ?? '—'}
    </span>
  )
}
