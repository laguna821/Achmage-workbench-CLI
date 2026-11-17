import type { TemplateSelection } from "../../../../vendor/ieumoffice/apps/slides/src/shared/template-selection.ts";
import { Gateway, listen, post } from "../bridge.ts";
import { afterSwap, swapInProgress } from "../swap.ts";

type Selection = { revision: string | null; selection: TemplateSelection | null };
/** `artifactId`: the document the page edits now (the editor pool may open another one in place). */
export function createSlideStyles(gateway: Gateway, artifactId: () => string) {
  const call = <T>(operation: string, body: unknown = {}) => gateway.aiSession(artifactId()).json<T>(`styles/${operation}`, body);
  let current: Selection | undefined, pending: Promise<unknown> = Promise.resolve();
  // The editor pool opened another deck in this page: the remembered selection was the other deck's.
  listen((message) => { if (message.type === "office:swap") current = undefined; });
  const selected = async () => current = await call<Selection>("selection-get");
  const serialize = (run: () => Promise<unknown>) => {
    const result = pending.then(run); pending = result.catch(() => undefined); return result;
  };
  return async (channel: string, args: unknown[], fallback: () => Promise<unknown>): Promise<unknown> => {
    // Asked while another deck is opened in place (the design panel drawn afresh for it reads its selection): answered
    // for the new deck once it is open, not refused (it was answered 401 mid-swap, and the panel then showed none).
    if (swapInProgress() && channel.startsWith("slides:ai-template-selection")) await afterSwap();
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
      // Asked while another deck is being opened in place (the panel refreshing itself): the gateway refuses that call
      // (401, measured on WebKitGTK; its cause is not found) — the deck's own reading after it opens answers it. Not a
      // save failure: nothing is said to the person.
      if (swapInProgress() && channel === "slides:ai-template-selection-get") return null;
      post({ type: "office:error", message: error instanceof Error ? error.message : String(error) }); throw error;
    }
  };
}
