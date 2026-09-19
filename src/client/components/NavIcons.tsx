import type { ReactNode, SVGProps } from 'react'

export type NavIconName = 'import' | 'objects' | 'sessions' | 'calendar' | 'equipment' | 'settings'

// One 24-grid, one stroke weight, no fills — so the six read as a set at the
// 28px the nav renders them at. Everything is drawn in currentColor: the import
// entry is dark ink on violet, the page links light on near-black.
const GLYPHS: Record<NavIconName, ReactNode> = {
  // Arrow dropping into a tray.
  import: <>
    <path d="M12 4v9" />
    <path d="M8.5 9.5 12 13l3.5-3.5" />
    <path d="M4.5 15.5V18a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2.5" />
  </>,
  // A star, for the targets themselves.
  objects: <path d="M12 4.2l2.3 4.9 5.4.7-3.9 3.75.95 5.35L12 16.25l-4.75 2.65.95-5.35L4.3 9.8l5.4-.7z" />,
  // A clock: a session is a span of a night.
  sessions: <>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 7.5V12l3.2 2" />
  </>,
  calendar: <>
    <rect x="3.5" y="5.5" width="17" height="15" rx="2.5" />
    <path d="M3.5 10.5h17" />
    <path d="M8.5 3.5v4" />
    <path d="M15.5 3.5v4" />
  </>,
  // The rig: tube on a tripod, with the counterweight shaft and weight that are
  // what make the mount equatorial rather than a fork.
  equipment: <>
    <path d="M8.5 10.4 17 4.9 19 8.1 10.5 13.6Z" />
    <path d="M10.6 12.6 7 16.4" />
    <circle cx="6.1" cy="17.3" r="1.3" />
    <path d="M11.6 13 12.2 16.8" />
    <path d="M12.2 16.8 9.3 21" />
    <path d="M12.2 16.8 15.1 21" />
  </>,
  // Sliders, with the rails broken around each knob so the glyph stays open.
  settings: <>
    <path d="M5 7.5h4.2" />
    <path d="M13.2 7.5H19" />
    <circle cx="11.2" cy="7.5" r="1.8" />
    <path d="M5 12h8.2" />
    <path d="M17.2 12H19" />
    <circle cx="15.2" cy="12" r="1.8" />
    <path d="M5 16.5h2.2" />
    <path d="M11.2 16.5H19" />
    <circle cx="9.2" cy="16.5" r="1.8" />
  </>,
}

interface Props extends SVGProps<SVGSVGElement> {
  name: NavIconName
}

export default function NavIcon({ name, ...props }: Props) {
  return (
    <svg
      className="nav-link__icon"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {GLYPHS[name]}
    </svg>
  )
}
