import type { TemplateSelection } from "../../../../vendor/ieumoffice/apps/slides/src/shared/template-selection.ts";
import { Gateway, post } from "../bridge.ts";

type Selection = { revision: string | null; selection: TemplateSelection | null };
export function createSlideStyles(gateway: Gateway, artifactId: string) {
  const call = <T>(operation: string, body: unknown = {}) => gateway.aiSession(artifactId).json<T>(`styles/${operation}`, body);
  let current: Selection | undefined, pending: Promise<unknown> = Promise.resolve();
  const selected = async () => current = await call<Selection>("selection-get");
  const serialize = (run: () => Promise<unknown>) => {
    const result = pending.then(run); pending = result.catch(() => undefined); return result;
  };
  return async (channel: string, args: unknown[], fallback: () => Promise<unknown>): Promise<unknown> => {
    try {
      switch (channel) {
        case "slides:ai-template-selection-get": return await serialize(async () => (await selected()).selection);
        case "slides:ai-template-selection-set": return await serialize(async () => {
          const previous = current ?? await selected();
          try { current = await call<Selection>("selection-set", { selection: args[0], expectedRevision: previous.revision }); }
          catch (error) { current = undefined; throw error; }
          return current.selection;
        });
        case "ai:list-style-templates": return await call("list");
        case "ai:load-style-template": return await call("load", { name: args[0] });
        case "ai:save-style-template": {
          try {
            const previous = await call<{ revision: string | null }>("load", { name: args[0] });
            return await call("save", { name: args[0], data: args[1], expectedRevision: previous.revision });
          } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
        }
        case "ai:save-sidecar": return await call("sidecar", { data: args[0] });
        case "slides:open-template-fonts-folder": return await call("fonts-folder");
        default: return fallback();
      }
    } catch (error) {
      post({ type: "office:error", message: error instanceof Error ? error.message : String(error) }); throw error;
    }
  };
}
