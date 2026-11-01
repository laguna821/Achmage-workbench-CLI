import type { OfficeMarkdownRequest, OfficeMarkdownSnapshot } from "../../../packages/contracts/src/office-markdown.ts";
import { Gateway, listen, post } from "./bridge.ts";

/** Original Markdown settings UI uses the parent; upload has only this document's grant. */
export function createMarkdownSettings(gateway: Gateway, artifactId: string, legacyTheme: unknown) {
  let snapshot: OfficeMarkdownSnapshot | null = null, sequence = 0, accepted = 0;
  const pending = new Map<string, { resolve(value: OfficeMarkdownSnapshot): void; reject(error: Error): void }>(), controller = new AbortController();
  const stop = listen(message => {
    if (message.type !== "office:markdown-result") return;
    const waiter = pending.get(message.requestId); if (!waiter) return; pending.delete(message.requestId);
    if (message.error || !message.value) waiter.reject(new Error(message.error ?? "Markdown 설정을 읽지 못했습니다.")); else waiter.resolve(message.value);
  });
  const request = async (action: OfficeMarkdownRequest["action"], value?: unknown) => {
    const requestId = crypto.randomUUID(), turn = ++sequence;
    const result = await new Promise<OfficeMarkdownSnapshot>((resolve, reject) => {
      pending.set(requestId, { resolve, reject }); post({ type: "office:markdown", requestId, action, value, revision: snapshot?.revision });
    });
    if (turn >= accepted) { accepted = turn; snapshot = result; }
    return result;
  };
  const report = (error: unknown) => post({ type: "office:error", message: error instanceof Error ? error.message : String(error) });
  window.addEventListener("pagehide", () => { controller.abort(); stop(); for (const waiter of pending.values()) waiter.reject(new Error("문서 창이 닫혔습니다.")); pending.clear(); }, { once: true });
  return {
    async getImageHost() { return (await request("read")).imageHost; },
    async setImageHost(value: unknown) {
      try { if (!snapshot) await request("read"); return (await request("host", value)).imageHost; }
      catch (error) { report(error); return null; }
    },
    async getMarkdownTheme() {
      const saved = await request("read");
      return saved.themeConfigured ? saved.markdownTheme : typeof legacyTheme === "string" ? legacyTheme : "default";
    },
    async setMarkdownTheme(value: unknown) {
      try { if (!snapshot) await request("read"); return (await request("theme", value)).markdownTheme; }
      catch (error) { report(error); return snapshot?.markdownTheme ?? "default"; }
    },
    async uploadImage(data: unknown) {
      try { return await gateway.aiSession(artifactId).json<{ ok: boolean; url?: string; error?: string }>("markdown-upload", data, controller.signal); }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : "그림 업로드를 마치지 못했습니다." }; }
    },
  };
}
