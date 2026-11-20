// Stroke-style SVG icons (24x24, currentColor). Decorative by default; pass `title` to label one.
function Icon({ children, size = 20, title, className = '', strokeWidth = 2 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {children}
    </svg>
  )
}

export const Check = (p) => (
  <Icon {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
)
export const X = (p) => (
  <Icon {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Icon>
)
export const Minus = (p) => (
  <Icon {...p}>
    <path d="M5 12h14" />
  </Icon>
)
export const Ticket = (p) => (
  <Icon {...p}>
    <path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4Z" />
    <path d="M13 6v2M13 11v2M13 16v2" />
  </Icon>
)
export const Home = (p) => (
  <Icon {...p}>
    <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1Z" />
  </Icon>
)
export const Shield = (p) => (
  <Icon {...p}>
    <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6Z" />
    <path d="m9 12 2 2 4-4" />
  </Icon>
)
export const Shuffle = (p) => (
  <Icon {...p}>
    <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
  </Icon>
)
export const Users = (p) => (
  <Icon {...p}>
    <circle cx="9" cy="8" r="4" />
    <path d="M2 21a7 7 0 0 1 14 0M16 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3" />
  </Icon>
)
export const Percent = (p) => (
  <Icon {...p}>
    <path d="M19 5 5 19" />
    <circle cx="6.5" cy="6.5" r="2.5" />
    <circle cx="17.5" cy="17.5" r="2.5" />
  </Icon>
)
export const Clock = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Icon>
)
export const Cpu = (p) => (
  <Icon {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
  </Icon>
)
export const Phone = (p) => (
  <Icon {...p}>
    <rect x="6" y="2" width="12" height="20" rx="3" />
    <path d="M11 18h2" />
  </Icon>
)
export const IdCard = (p) => (
  <Icon {...p}>
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <circle cx="8" cy="12" r="2.5" />
    <path d="M14 10h4M14 14h4" />
  </Icon>
)
export const Scan = (p) => (
  <Icon {...p}>
    <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16" />
  </Icon>
)
export const Chart = (p) => (
  <Icon {...p}>
    <path d="M3 3v18h18M8 16v-5M13 16V8M18 16v-8" />
  </Icon>
)
export const Building = (p) => (
  <Icon {...p}>
    <path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M16 9h2a2 2 0 0 1 2 2v10M2 21h20M8 7h4M8 11h4M8 15h4" />
  </Icon>
)
export const ArrowLeft = (p) => (
  <Icon {...p}>
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </Icon>
)
export const ArrowRight = (p) => (
  <Icon {...p}>
    <path d="M5 12h14M12 5l7 7-7 7" />
  </Icon>
)
export const External = (p) => (
  <Icon {...p}>
    <path d="M14 4h6v6M20 4 10 14M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Icon>
)
export const Refresh = (p) => (
  <Icon {...p}>
    <path d="M20 11a8 8 0 0 0-14.7-4.4L3 9M3 4v5h5M4 13a8 8 0 0 0 14.7 4.4L21 15M21 20v-5h-5" />
  </Icon>
)
export const Wallet = (p) => (
  <Icon {...p}>
    <path d="M19 7V5a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4M21 17v2a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V6" />
    <path d="M17 12h4v4h-4a2 2 0 0 1 0-4Z" />
  </Icon>
)
export const Logout = (p) => (
  <Icon {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
  </Icon>
)
export const Alert = (p) => (
  <Icon {...p}>
    <path d="M12 3 2 20h20Z" />
    <path d="M12 10v4M12 17h.01" />
  </Icon>
)
export const Info = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </Icon>
)
export const Bot = (p) => (
  <Icon {...p}>
    <rect x="4" y="8" width="16" height="12" rx="3" />
    <path d="M12 8V4M9 13h.01M15 13h.01M9 17h6" />
  </Icon>
)
export const Undo = (p) => (
  <Icon {...p}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
  </Icon>
)
export const Tag = (p) => (
  <Icon {...p}>
    <path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9Z" />
    <circle cx="8" cy="8" r="1.5" />
  </Icon>
)
export const Copy = (p) => (
  <Icon {...p}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </Icon>
)
export const Swap = (p) => (
  <Icon {...p}>
    <path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7" />
  </Icon>
)
export const Plus = (p) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
)
export const Link = (p) => (
  <Icon {...p}>
    <path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
  </Icon>
)
