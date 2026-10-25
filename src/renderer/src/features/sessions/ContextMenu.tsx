// Floating menu (right-click or "…" button) with one level of submenus. Rendered in a portal.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import styles from './sessions.module.css'

export type MenuItem =
  | { separator: true; label?: never }
  | {
      separator?: false
      label: string
      onSelect?: () => void
      submenu?: MenuItem[]
      danger?: boolean
      checked?: boolean
      disabled?: boolean
    }

export interface MenuAnchor {
  x: number
  y: number
}

/** Anchor below-left of a button, for "…" menus. */
export function anchorBelow(el: HTMLElement): MenuAnchor {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.bottom + 4 }
}

function MenuList({
  items,
  onClose,
  at,
  nested
}: {
  items: MenuItem[]
  onClose: () => void
  at: MenuAnchor
  nested?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(at)
  const [openSub, setOpenSub] = useState<{ index: number; at: MenuAnchor }>()

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const x =
      at.x + r.width > window.innerWidth - 4
        ? Math.max(4, nested ? at.x - r.width * 2 : window.innerWidth - r.width - 4)
        : at.x
    const y = at.y + r.height > window.innerHeight - 4 ? Math.max(4, window.innerHeight - r.height - 4) : at.y
    setPos({ x, y })
  }, [at.x, at.y, nested])

  return (
    <div
      ref={ref}
      className={styles.menu}
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className={styles.menuSep} />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={item.disabled}
            className={`${styles.menuItem} ${item.danger ? styles.menuDanger : ''} ${openSub?.index === i ? styles.menuItemOpen : ''}`}
            onMouseEnter={(e) => {
              if (!item.submenu) return setOpenSub(undefined)
              const r = e.currentTarget.getBoundingClientRect()
              setOpenSub({ index: i, at: { x: r.right + 2, y: r.top - 4 } })
            }}
            onClick={(e) => {
              if (item.submenu) {
                const r = e.currentTarget.getBoundingClientRect()
                setOpenSub({ index: i, at: { x: r.right + 2, y: r.top - 4 } })
                return
              }
              onClose()
              item.onSelect?.()
            }}
          >
            <span className={styles.menuCheck}>{item.checked ? '✓' : ''}</span>
            <span className={styles.menuLabel}>{item.label}</span>
            {item.submenu && <span className={styles.menuArrow}>›</span>}
          </button>
        )
      )}
      {openSub &&
        (() => {
          const item = items[openSub.index]
          return item && !item.separator && item.submenu ? (
            <MenuList items={item.submenu} onClose={onClose} at={openSub.at} nested />
          ) : null
        })()}
    </div>
  )
}

export function ContextMenu({ items, at, onClose }: { items: MenuItem[]; at: MenuAnchor; onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return createPortal(
    <div ref={rootRef}>
      <MenuList items={items} onClose={onClose} at={at} />
    </div>,
    document.body
  )
}
