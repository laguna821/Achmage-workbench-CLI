import type { OfficeWikiAction, WikiBacklink, WikiGraph, WikiLink } from "../../../packages/contracts/src/office-wiki.ts";
import { rememberWikiFragment, takeWikiFragment } from "@ieum/apps/markdown/src/main/wiki-fragment.ts";
import { listen, post, type Init } from "./bridge.ts";

/** A retained tab must consume its fragment when shown, including an already visible split. */
export function onWikiActivation(jump: () => void) {
  let visible = false, pending = false;
  const run = () => { if (visible && pending) { pending = false; jump(); } };
  const observer = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); run(); });
  observer.observe(document.body);
  const off = listen(message => {
    if (message.type === "office:wiki-activate") { pending = true; run(); }
  });
  return () => { off(); observer.disconnect(); };
}

type WikiBlock = { type: { name: string }; isTextblock: boolean; textContent: string };
/** An explicit trailing ^id is read as text; never add attributes or change the source. */
export function wikiBlockPosition(doc: { descendants(visit: (node: WikiBlock, pos: number) => boolean | void): void }, fragment: string) {
  const id = fragment.trim().slice(1);
  if (!/^[a-zA-Z0-9-]+$/.test(id)) return null;
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null || !node.isTextblock || node.type.name === "codeBlock") return;
    if (node.textContent.match(/(?:^|\s)\^([a-zA-Z0-9-]+)\s*$/)?.[1] === id) found = pos + 1;
  });
  return found;
}

/** Original pure fragment store per frame; filesystem and navigation stay in the trusted host. */
export function createOfficeWiki(init: Init) {
  const waiting = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  let session = init.sessionId;
  listen(message => {
    if (message.type === "office:wiki-result") {
      const pending = waiting.get(message.requestId);
      if (!pending) return;
      waiting.delete(message.requestId);
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.value);
    } else if (message.type === "office:grant" && message.sessionId !== session) {
      session = message.sessionId;
      for (const pending of waiting.values()) pending.reject(new Error("위키를 읽는 동안 선택한 대화가 바뀌었습니다."));
      waiting.clear();
    }
  });
  const call = <T>(action: OfficeWikiAction, input: Record<string, unknown> = {}) => new Promise<T>((resolve, reject) => {
    if (waiting.size >= 32) { reject(new Error("위키 요청을 처리 중입니다. 잠시 뒤 다시 시도해 주세요.")); return; }
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { waiting.delete(requestId); reject(new Error("위키 요청이 제시간에 완료되지 않았습니다.")); }, 30000);
    waiting.set(requestId, { resolve: value => { clearTimeout(timer); resolve(value as T); }, reject: error => { clearTimeout(timer); reject(error); } });
    post({ type: "office:wiki", requestId, action, input });
  });
  return {
    resolveWikiLinks: (request: { targets: string[]; fromPath: string }) => call<Record<string, WikiLink>>("resolve", { targets: request.targets }),
    wikiBacklinks: (_path: string) => call<WikiBacklink[]>("backlinks"),
    wikiGraph: () => call<WikiGraph>("graph"),
    rememberWikiFragment: async (path: string, fragment: string) => { rememberWikiFragment(path, fragment); },
    takeWikiFragment: async (path: string) => takeWikiFragment(path) || (path === init.artifact.path ? await call<string>("take-fragment") : ""),
    openSourcePath: async (path: string) => {
      if (path === init.artifact.path) return { ok: true };
      try { await call("open", { path, fragment: takeWikiFragment(path) }); return { ok: true }; }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        post({ type: "office:error", message }); return { ok: false, error: message };
      }
    },
  };
}
