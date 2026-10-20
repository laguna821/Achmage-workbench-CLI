import { t } from '../strings'
import { registerPalette } from '../ui/swatches'
import type { BrandKit } from '@/types/api'

let unregister: (() => void) | null = null

/**
 * Makes the colours of the active brand kit available as a "Brand colors" row in every colour picker, or removes
 * the row when there is no kit (or it has no colours). Pickers read the registry, so this is the only call needed.
 */
export function setBrandPalette(kit: BrandKit | null): void {
  unregister?.()
  unregister = null
  if (!kit || kit.colors.length === 0) return
  unregister = registerPalette({ id: 'brand', label: t.brand.palette(kit.name), order: -10, colors: kit.colors.map((c) => c.hex) })
}
