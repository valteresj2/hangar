// Small stroke icons (16px, currentColor).
import type { ReactNode } from 'react'

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

export const PlusIcon = () => (
  <Svg>
    <path d="M8 3v10M3 8h10" />
  </Svg>
)

export const SearchIcon = () => (
  <Svg size={14}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </Svg>
)

export const MoreIcon = () => (
  <Svg>
    <circle cx="3.5" cy="8" r="0.6" fill="currentColor" />
    <circle cx="8" cy="8" r="0.6" fill="currentColor" />
    <circle cx="12.5" cy="8" r="0.6" fill="currentColor" />
  </Svg>
)

export const ChevronIcon = ({ open }: { open: boolean }) => (
  <span style={{ display: 'inline-flex', transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }}>
    <Svg size={12}>
      <path d="m6 4 4 4-4 4" />
    </Svg>
  </span>
)

export const PinIcon = ({ filled }: { filled?: boolean }) => (
  <Svg>
    <path d="M9.5 2.5 13.5 6.5 11 8l-1.5 3.5-5-5L8 5z" fill={filled ? 'currentColor' : 'none'} />
    <path d="m5.5 10.5-3 3" />
  </Svg>
)

export const FolderIcon = () => (
  <Svg size={14}>
    <path d="M2 4.5c0-.6.4-1 1-1h3l1.5 1.5H13c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z" />
  </Svg>
)

export const BranchIcon = () => (
  <Svg size={12}>
    <circle cx="4.5" cy="3.5" r="1.5" />
    <circle cx="4.5" cy="12.5" r="1.5" />
    <circle cx="11.5" cy="5.5" r="1.5" />
    <path d="M4.5 5v6M11.5 7c0 3-7 2-7 4" />
  </Svg>
)

export const ImportIcon = () => (
  <Svg size={14}>
    <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
  </Svg>
)
