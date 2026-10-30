import type { OfficeSkillRead, OfficeSkillView } from "../../../packages/contracts/src/office-skills.ts";
import { Events, Gateway, listen, post, type Init } from "./bridge.ts";
import type { OfficeSkillRequest } from "../../../packages/contracts/src/office-skills.ts";

/** Original picker, read-only tools and explicit cards share Workbench's library. */
export function createOfficeSkills(init: Init, gateway: Gateway, events: Events, openSettings: () => Promise<void>, prepare: () => Promise<unknown>) {
  let generation = 0;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  listen((message) => {
    if (message.type !== "office:skills-result") return;
    const entry = pending.get(message.requestId); if (!entry) return;
    pending.delete(message.requestId);
    if (message.error) entry.reject(new Error(message.error)); else entry.resolve(message.value);
  });
  const parent = (action: OfficeSkillRequest["action"], input: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
    const requestId = crypto.randomUUID(), timer = window.setTimeout(() => { pending.delete(requestId); reject(new Error("양식 요청 확인 시간이 초과됐습니다. 생성한 사본이 있는지 확인해 주세요.")); }, 30_000);
    pending.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    post({ type: "office:skills", requestId, action, input: { ...input, requestId } });
  });
  const call = async <T>(operation: string, input?: unknown): Promise<T> => {
    const before = generation, api = gateway.aiSession(init.artifact.id);
    const result = await api.json<T>(`skills/${operation}`, input);
    if (before !== generation) throw new Error("스킬을 읽는 동안 선택한 세션이 바뀌었습니다.");
    return result;
  };
  const refresh = () => events.emit("userSkillsChanged");
  return {
    changed: () => { generation++; refresh(); }, refresh,
    bridge: {
      list: () => call<OfficeSkillView[]>("list"),
      read: (id: string) => call("read", { id }),
      aiRead: (id: string) => call<{ ok: true; skill: OfficeSkillRead } | { ok: false; reason: string }>("ai-read", { id }),
      aiReadFile: (id: string, path: string) => call("ai-read-file", { id, path }),
      suggestName: (title: string) => call<string>("suggest-name", { title }),
      checkName: (name: string, forId?: string, card?: unknown) => call("check-name", { name, forId, card }),
      saveFromCard: async (input: Record<string, unknown>) => {
        const before = generation;
        let template: { fileName: string; base64: string } | undefined;
        if (input.template) {
          const value = input.template as { fileName: string; bytes: Uint8Array };
          if (!(value.bytes instanceof Uint8Array) || value.bytes.byteLength > 64 * 1024 * 1024) throw new Error("양식 파일 크기를 확인해 주세요.");
          const parts: string[] = [];
          for (let at = 0; at < value.bytes.length; at += 0x8000) parts.push(String.fromCharCode(...value.bytes.subarray(at, at + 0x8000)));
          template = { fileName: value.fileName, base64: btoa(parts.join("")) };
        }
        const result = await parent("save-card", { ...input, ...(template ? { template } : {}) });
        if (before !== generation) throw new Error("저장 중 선택한 대화가 바뀌었습니다. 보관함에서 결과를 확인해 주세요.");
        refresh(); return result;
      },
      openTemplate: async (input: Record<string, unknown>) => { await prepare(); return parent("open-template", input); },
      takeHandoff: (target: string) => call("take-handoff", { target }),
      focusTab: (tabId: string) => parent("focus-tab", { tabId }),
      openSettings,
      onChanged: (listener: () => void) => events.on("userSkillsChanged")(listener),
    },
  };
}
