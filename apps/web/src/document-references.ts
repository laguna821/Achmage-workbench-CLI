import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Artifact, DocRef, DocRefInput, DocumentPresence } from "@workbench/contracts";
import type { Api } from "./api.ts";
import { saveReferencedDocument } from "./document-commands.ts";

// One poll for the application, even when many hidden tabs keep their editors mounted.
const stores = new WeakMap<Api, ReturnType<typeof presenceStore>>();
function presenceStore(api: Api) {
  let value: DocumentPresence[] = [];
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null, pending = false;
  const refresh = async () => {
    if (pending) return;
    pending = true;
    try { value = (await api.documentViews()).views; listeners.forEach((listener) => listener()); }
    catch { /* Sending always checks with the gateway again; stale display never authorizes sending. */ }
    finally { pending = false; }
  };
  return {
    get: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!timer) { void refresh(); timer = setInterval(() => void refresh(), 2000); }
      return () => { listeners.delete(listener); if (!listeners.size && timer) { clearInterval(timer); timer = null; } };
    },
  };
}

export function useDocumentReferences(api: Api, scope: string, onError: (message: string) => void) {
  let store = stores.get(api);
  if (!store) { store = presenceStore(api); stores.set(api, store); }
  const presence = useSyncExternalStore(store.subscribe, store.get);
  const [pins, setPins] = useState<Record<string, DocRef>>({});
  useEffect(() => setPins({}), [scope]);
  const toggleSnapshot = useCallback(async (artifactId: string) => {
    if (pins[artifactId]) { setPins((current) => { const next = { ...current }; delete next[artifactId]; return next; }); return; }
    try {
      const { refs } = await api.resolveReferences([{ artifactId, mode: "review", savedSnapshot: true }]);
      setPins((current) => ({ ...current, [artifactId]: refs[0]! }));
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }, [api, pins, onError]);
  const resolve = async (inputs: DocRefInput[]): Promise<DocRef[] | null> => {
    try {
      const refs: DocRefInput[] = [];
      for (const input of inputs) {
        const pin = pins[input.artifactId];
        if (pin) refs.push({ ...pin, mode: input.mode, selection: input.selection });
        else {
          const revision = await saveReferencedDocument(input.artifactId);
          refs.push({ ...input, ...(revision === undefined ? {} : { revision }) });
        }
      }
      return (await api.resolveReferences(refs)).refs;
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); return null; }
  };
  const hint = (artifact: Artifact) => {
    const live = presence.filter((view) => view.artifactId === artifact.id);
    return `r${artifact.revision}${live.some((view) => view.dirty) ? " · 저장 안 됨" : live.length ? " · 열림" : ""}`;
  };
  const forget = (artifactId: string) => setPins((current) => { const next = { ...current }; delete next[artifactId]; return next; });
  return { presence, pins, toggleSnapshot, resolve, hint, forget, clear: () => setPins({}) };
}
