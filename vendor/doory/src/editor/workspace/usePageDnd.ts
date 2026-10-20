import { useState } from 'react'

/** Native drag & drop reordering state shared by the page strip and the Pages panel. */
export function usePageDnd(onMove: (id: string, toIndex: number) => void) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState<{ id: string; side: 'before' | 'after' } | null>(null)

  const handlers = (id: string, index: number, order: readonly string[], horizontal: boolean) => ({
    onDragStart: (e: React.DragEvent) => {
      setDragId(id)
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/x-doory-page', id)
    },
    onDragOver: (e: React.DragEvent) => {
      if (!dragId || dragId === id) return
      e.preventDefault()
      const r = e.currentTarget.getBoundingClientRect()
      const before = horizontal ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2
      setOver((cur) => (cur?.id === id && cur.side === (before ? 'before' : 'after') ? cur : { id, side: before ? 'before' : 'after' }))
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      if (dragId && over) {
        const from = order.indexOf(dragId)
        let to = index + (over.side === 'after' ? 1 : 0)
        if (from < to) to -= 1
        if (from !== to) onMove(dragId, to)
      }
      setDragId(null)
      setOver(null)
    },
    onDragEnd: () => {
      setDragId(null)
      setOver(null)
    },
  })

  return { handlers, overFor: (id: string) => (over?.id === id ? over.side : null) }
}
