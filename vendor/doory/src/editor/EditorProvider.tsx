import type { ReactNode } from 'react'
import { CollabContext } from './collab/context'
import type { CollabSession } from './collab/session'
import { EngineContext, PortalContext } from './context'
import type { EditorEngine } from './engine/editor'

/** Makes the engine, the portal root (where popovers and dialogs render) and the live-editing session, if any, available to the editor UI. */
export function EditorProvider({ engine, portalRoot, collab = null, children }: { engine: EditorEngine; portalRoot: HTMLElement | null; collab?: CollabSession | null; children: ReactNode }) {
  return (
    <EngineContext.Provider value={engine}>
      <PortalContext.Provider value={portalRoot}>
        <CollabContext.Provider value={collab}>{children}</CollabContext.Provider>
      </PortalContext.Provider>
    </EngineContext.Provider>
  )
}
