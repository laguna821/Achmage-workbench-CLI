import { useEffect, useState } from 'react'
import type { AiService } from '@/types/adapter'
import type { AiOption } from '@/types/api'
import { useEditor } from '../context'
import { BACKGROUND_REMOVAL_TASK, DEVICE_OPTION, isBackgroundRemovalAvailable } from '../engine/bgRemoval'
import { t } from '../strings'

/** What the Remove background dialog can offer: the options in order and the one to start with. */
export interface BgRemovalChoices {
  options: AiOption[]
  initial: string | null
}

function deviceOption(): AiOption {
  return { id: DEVICE_OPTION, label: t.bgRemoval.device, task: BACKGROUND_REMOVAL_TASK, kind: 'device', provider_name: '', owner: 'device', sends_offsite: false }
}

/**
 * The options without a service: the in-browser model alone, as before server options existed. Known at once,
 * so the dialog starts the removal right away (and says so when the model is not installed after all).
 */
export function deviceChoices(): BgRemovalChoices {
  return { options: [deviceOption()], initial: DEVICE_OPTION }
}

/**
 * The options of `ai` for background removal. The in-browser model is listed only when this browser has it
 * (first, under the editor's own label); the choice to start with is the user's last one, else the server's
 * default, else the first option.
 */
export async function loadBackgroundRemovalChoices(ai: AiService | null | undefined): Promise<BgRemovalChoices> {
  if (!ai) return deviceChoices()
  const listed = await ai.options(BACKGROUND_REMOVAL_TASK).catch(() => ({ default: null, models: [] }))
  const servers = listed.models.filter((option) => option.kind === 'server')
  const options = isBackgroundRemovalAvailable() ? [deviceOption(), ...servers] : servers
  const ids = new Set(options.map((option) => option.id))
  const remembered = ai.remembered(BACKGROUND_REMOVAL_TASK)
  const initial = [remembered, listed.default].find((id): id is string => typeof id === 'string' && ids.has(id)) ?? options[0]?.id ?? null
  return { options, initial }
}

/** The background-removal choices of the open editor; `null` while the server's list is on its way. */
export function useBackgroundRemovalOptions(): BgRemovalChoices | null {
  const ai = useEditor().adapter.services.ai
  const [loaded, setLoaded] = useState<{ ai: AiService; choices: BgRemovalChoices } | null>(null)
  useEffect(() => {
    if (!ai) return
    let live = true
    void loadBackgroundRemovalChoices(ai).then((choices) => {
      if (live) setLoaded({ ai, choices })
    })
    return () => {
      live = false
    }
  }, [ai])
  if (!ai) return deviceChoices()
  return loaded?.ai === ai ? loaded.choices : null
}
