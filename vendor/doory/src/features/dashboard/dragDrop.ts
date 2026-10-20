export const DESIGN_DRAG_TYPE = 'application/x-doory-design-ids'

export function setDraggedDesigns(event: { dataTransfer: DataTransfer | null }, ids: string[]): void {
  if (!event.dataTransfer) return
  event.dataTransfer.setData(DESIGN_DRAG_TYPE, JSON.stringify(ids))
  event.dataTransfer.setData('text/plain', `${ids.length} design${ids.length === 1 ? '' : 's'}`)
  event.dataTransfer.effectAllowed = 'move'
}

export function hasDraggedDesigns(dataTransfer: DataTransfer | null): boolean {
  return Boolean(dataTransfer && Array.from(dataTransfer.types).includes(DESIGN_DRAG_TYPE))
}

export function readDraggedDesigns(dataTransfer: DataTransfer | null): string[] {
  if (!dataTransfer) return []
  try {
    const parsed: unknown = JSON.parse(dataTransfer.getData(DESIGN_DRAG_TYPE))
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}
