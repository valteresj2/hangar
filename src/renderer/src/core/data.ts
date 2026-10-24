// React hooks over the core store. They refetch whenever main broadcasts `store:event:changed`.
import { useEffect, useState } from 'react'
import type { CollectionName, Collections, Settings, StoreChange } from '@shared/contracts'
import { CORE } from '@shared/ipc'
import { api, bridge } from './api'

export function useCollection<K extends CollectionName>(name: K): Collections[K][] {
  const [rows, setRows] = useState<Collections[K][]>([])
  useEffect(() => {
    let alive = true
    const load = () => void api.list(name).then((r) => alive && setRows(r))
    load()
    const off = bridge.on(CORE.storeChanged, (change: StoreChange) => {
      if (change.collection === name) load()
    })
    return () => {
      alive = false
      off()
    }
  }, [name])
  return rows
}

export function useRow<K extends CollectionName>(name: K, id: string | undefined): Collections[K] | undefined {
  const [row, setRow] = useState<Collections[K] | undefined>()
  useEffect(() => {
    if (!id) return setRow(undefined)
    let alive = true
    const load = () => void api.get(name, id).then((r) => alive && setRow(r))
    load()
    const off = bridge.on(CORE.storeChanged, (change: StoreChange) => {
      if (change.collection === name && (!change.id || change.id === id)) load()
    })
    return () => {
      alive = false
      off()
    }
  }, [name, id])
  return row
}

export function useSettings(): Settings | undefined {
  const [value, setValue] = useState<Settings>()
  useEffect(() => {
    let alive = true
    const load = () => void api.settings().then((s) => alive && setValue(s))
    load()
    const off = bridge.on(CORE.storeChanged, (change: StoreChange) => {
      if (change.collection === 'settings') load()
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  return value
}
