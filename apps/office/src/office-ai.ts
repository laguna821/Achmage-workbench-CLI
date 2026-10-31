import type { OfficeHostMessage, TranscriptItem } from "@workbench/contracts";
import type { OfficeTurnReceipt } from "../../../packages/contracts/src/office-ai.ts";
import type { AgentMessage } from "../../../vendor/ieumoffice/packages/agent-core/src/types.ts";
import type { IpcStreamChunk } from "../../../vendor/ieumoffice/packages/agent-core/src/electron-transport.ts";
import { Events, Gateway, listen, post, type Init } from "./bridge.ts";
import { officeCopyBusy, setCopyAiBusy } from "./copy.ts";
import { installOfficeConversation, type OfficeConversationPort, type OfficeRun, type WorkbenchAgentLoop } from "./office-agent.ts";
import { createOfficeReferences } from "./office-references.ts";
import type { OfficeAttachment } from "../../../packages/contracts/src/office-references.ts";
import { createOfficeSkills } from "./office-skills.ts";
import type { OfficeSkillChip } from "../../../packages/contracts/src/office-skills.ts";

type Prepared = NonNullable<Extract<OfficeHostMessage, { type: "office:ai-result" }>["value"]>;
type History = { workId: string; sessionId: string; items: TranscriptItem[]; attachments?: OfficeAttachment[]; before: string | null; hasMore: boolean };
type Chat = { role: "user" | "assistant"; text: string; seq: number; ts: string; attachments?: OfficeAttachment[]; skills?: OfficeSkillChip[]; tools?: { name: string; summary: string; input?: string; output?: string; isError?: boolean }[] };

/** A view of the one Workbench transcript for the original panel's history reader. */
export function officeChat(items: TranscriptItem[]): Chat[] {
  const chat: Chat[] = [];
  for (const item of items) {
    const base = { seq: chat.length + 1, ts: new Date(item.at).toISOString() };
    if (item.kind === "user" || item.kind === "assistant") chat.push({ ...base, role: item.kind, text: item.text, ...(item.kind === "user" && item.office?.attachments ? { attachments: item.office.attachments } : {}), ...(item.kind === "user" && item.office?.skills ? { skills: item.office.skills.map(({ id, source, title }) => ({ id, source, title })) } : {}) });
    else if (item.kind === "tool") {
      const detail = item.detail ?? "", split = detail.indexOf("\n");
      const tool = { name: split < 0 ? item.tool : detail.slice(0, split), summary: item.title, input: split < 0 ? detail : detail.slice(split + 1), output: item.output ?? undefined, isError: item.status === "failed" };
      const last = chat.at(-1);
      if (last?.role === "assistant" && !item.office?.cardSaved && !last.tools?.some((entry) => entry.output?.startsWith("skill-card-saved:"))) (last.tools ??= []).push(tool);
      else chat.push({ ...base, role: "assistant", text: "", tools: [tool] });
    } else if (item.kind === "notice" || item.kind === "turnEnd" && item.status !== "completed") {
      chat.push({ ...base, role: "assistant", text: item.kind === "notice" ? item.text : `[${item.status === "interrupted" ? "요청 중단" : "요청 실패"}]` });
    }
  }
  return chat;
}
export function officeModelHistory(items: TranscriptItem[], liveInstructions?: ReadonlyMap<string, string>): AgentMessage[] {
  const modelItems = items.filter((item) => !item.office?.cardSaved).map((item) => item.kind === "user" && item.office && liveInstructions?.has(item.office.turnId) ? { ...item, text: liveInstructions.get(item.office.turnId)! } : item);
  return officeChat(modelItems).map((item) => ({ role: item.role, text: [item.text, ...(item.tools ?? []).map((tool) => `이전 도구 실행 기록 (자료):\n${JSON.stringify(tool)}`)].filter(Boolean).join("\n\n") }));
}

export function createOfficeAi(init: Init, gateway: Gateway, events: Events) {
  const references = createOfficeReferences();
  let sessionId = init.sessionId, sessionKey = sessionId ?? "unbound";
  let active: WorkbenchAgentLoop<unknown> | null = null;
  let run: { turnId: string; api: ReturnType<Gateway["aiSession"]> } | null = null;
  const subscribers = new Set<() => void>();
  // Preserve the original loop's in-memory request context across live follow-ups.
  // Reopening starts empty: the original history hook re-reads the saved chips.
  const liveInstructions = new Map<string, string>();
  const requests = new Map<string, { resolve(value: Prepared | undefined): void; reject(error: Error): void }>();
  // Grant notifications may arrive before the response to the first prepare.
  // Defer only this unbound handoff until the parent identifies the session it
  // created. A different selection must still cancel the original request.
  let binding: { requestId: string; grants: (string | null)[] } | null = null;
  const streams = new Map<string, AbortController>();
  const webRequests = new Set<AbortController>();
  const abortWeb = () => { for (const controller of webRequests) controller.abort(); };
  window.addEventListener("pagehide", abortWeb);
  setCopyAiBusy(() => active !== null || streams.size > 0);
  const changed = (next: string | null, keepPanel = false) => {
    if (sessionId === next) return;
    sessionId = next;
    if (keepPanel) return;
    references.reset();
    liveInstructions.clear();
    skills.changed();
    sessionKey = next ?? "unbound";
    active?.reset();
    abortWeb();
    for (const listener of subscribers) listener();
  };
  listen((message) => {
    if (message.type === "office:skills-changed") skills.refresh();
    if (message.type === "office:grant") {
      if (binding) binding.grants.push(message.sessionId);
      else changed(message.sessionId);
    }
    if (message.type !== "office:ai-result") return;
    const pending = requests.get(message.requestId);
    if (!pending) return;
    requests.delete(message.requestId);
    const initial = binding?.requestId === message.requestId ? binding : null;
    if (initial) binding = null;
    if (message.error) {
      if (initial?.grants.length) changed(initial.grants.at(-1)!);
      pending.reject(new Error(message.error)); return;
    }
    if (initial && (!message.value?.createdSession || !message.value.sessionId || sessionId !== null || initial.grants.some((id) => id !== null && id !== message.value!.sessionId))) {
      if (initial.grants.length) changed(initial.grants.at(-1)!);
      pending.reject(new Error("선택한 세션이 바뀌었습니다. 새 대화에서 다시 요청해 주세요.")); return;
    }
    if (message.value) { gateway.setToken(message.value.token); changed(message.value.sessionId, Boolean(initial)); }
    pending.resolve(message.value);
  });
  const parent = (action: "prepare" | "new-session" | "settings" | "skills", freezeReferences?: string[]) => new Promise<Prepared | undefined>((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      requests.delete(requestId);
      if (binding?.requestId === requestId) {
        const latest = binding.grants.at(-1); binding = null;
        if (latest !== undefined) changed(latest);
      }
      reject(new Error("문서 저장과 세션 연결 확인 시간이 초과됐습니다."));
    }, 25_000);
    requests.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    if (action === "prepare" && sessionId === null) binding = { requestId, grants: [] };
    post({ type: "office:ai-request", requestId, action, sessionId, ...(freezeReferences ? { freezeReferences } : {}) });
  });
  const skills = createOfficeSkills(init, gateway, events, async () => { await parent("skills"); }, async () => { await prepare(); });
  Object.assign(window, { aiOfficeUserSkills: skills.bridge });
  const prepare = async (freeze = false) => {
    const value = await parent("prepare", freeze ? references.pin() : undefined);
    if (!value?.sessionId) throw new Error("이 문서와 함께 사용할 Workbench 세션을 선택해 주세요.");
    return value;
  };
  const history = async () => {
    const api = gateway.aiSession(init.artifact.id);
    const page = await api.json<History>("history");
    if (page.sessionId !== sessionId) throw new Error("선택한 세션이 바뀌었습니다. 새 세션의 대화를 불러와 주세요.");
    references.restore(page.attachments ?? []);
    return page;
  };
  const port: OfficeConversationPort = {
    attach: (loop) => {
      if (officeCopyBusy()) throw new Error("사본 저장이 끝난 뒤 AI 편집을 시작해 주세요.");
      if (active) throw new Error("이 문서에서 진행 중인 AI 요청을 먼저 마쳐 주세요.");
      active = loop; return () => { if (active === loop) active = null; };
    },
    begin: async (instruction, signal, originalImages, skillContext): Promise<OfficeRun> => {
      try {
        if (sessionId) await history();
        const prepared = await prepare(true), api = gateway.aiSession(init.artifact.id);
        const page = await api.json<History>("history");
        if (signal.aborted) throw new Error("요청을 취소했습니다.");
        if (page.sessionId !== prepared.sessionId || page.sessionId !== sessionId) throw new Error("선택한 세션이 바뀌었습니다.");
        const images = await references.imagesForTurn(originalImages);
        if (signal.aborted || page.sessionId !== sessionId) throw new Error("요청을 취소했거나 선택한 세션이 바뀌었습니다.");
        const turnId = crypto.randomUUID();
        const receipt = await api.json<OfficeTurnReceipt>("turn-start", { turnId, instruction, revision: prepared.revision, ...(skillContext ? { skillContext } : {}), ...(prepared.referenceSnapshot ? { referenceSnapshot: prepared.referenceSnapshot } : {}) });
        if (receipt.duplicate || receipt.status !== "running") throw new Error("이미 처리된 요청입니다. 중복 실행하지 않았습니다.");
        liveInstructions.set(turnId, instruction);
        while (liveInstructions.size > 64 || [...liveInstructions.values()].reduce((sum, text) => sum + text.length, 0) > 8_000_000) liveInstructions.delete(liveInstructions.keys().next().value!);
        run = { turnId, api }; let seq = 0;
        return {
          history: officeModelHistory(page.items, liveInstructions),
          images,
          append: async (events) => { await api.json("turn-events", { turnId, seq: ++seq, events }); },
          save: async () => {
            const saved = await prepare();
            if (saved.sessionId !== page.sessionId) throw new Error("문서 저장 중 선택한 세션이 바뀌었습니다.");
          },
          finish: async (status, error) => {
            try { await api.json("turn-finish", { turnId, status, ...(error ? { error } : {}) }); }
            finally { if (run?.turnId === turnId) run = null; references.release(); }
          },
        };
      } catch (error) { references.release(); throw error; }
    },
  };
  installOfficeConversation(port);
  const getSettings = () => gateway.aiSession(init.artifact.id).json("settings");
  const statuses = (refresh = false) => gateway.aiSession(init.artifact.id).json(`statuses${refresh ? "?refresh=1" : ""}`);
  const openSettings = async () => { await parent("settings"); };
  const webTool = async (name: string, ...args: unknown[]) => {
    const current = run, api = current?.api ?? gateway.aiSession(init.artifact.id);
    const controller = new AbortController(); webRequests.add(controller);
    try { return await api.json<any>("tool", { requestId: crypto.randomUUID(), name, args, ...(current ? { turnId: current.turnId } : {}) }, controller.signal); }
    finally { webRequests.delete(controller); }
  };
  // Return immediately after attaching the stream, as Electron's invoke does. Its events
  // still arrive through the original subscription, including structured error causes.
  const aiStream = async (request: { requestId: string } & Record<string, unknown>) => {
    if (!run) throw new Error("Workbench 요청 기록이 준비되지 않았습니다.");
    const current = run, controller = new AbortController();
    if (streams.has(request.requestId)) throw new Error("같은 AI 호출이 이미 진행 중입니다.");
    streams.set(request.requestId, controller);
    let terminal = false;
    void current.api.stream({ ...request, turnId: current.turnId }, (value) => {
      const chunk = value as IpcStreamChunk;
      if (chunk.requestId !== request.requestId) throw new Error("AI 응답의 요청 번호가 다릅니다.");
      terminal ||= chunk.type === "done" || chunk.type === "error";
      events.emit("aiStream", chunk);
    }, controller.signal).then(() => {
      if (!terminal) throw new Error("AI 응답이 완료 기록 없이 끝났습니다.");
    }).catch((error) => {
      if (!terminal) events.emit("aiStream", controller.signal.aborted ? { requestId: request.requestId, type: "done" } : { requestId: request.requestId, type: "error", error: error instanceof Error ? error.message : String(error) });
    }).finally(() => streams.delete(request.requestId));
  };
  const aiStreamCancel = async (requestId: string) => {
    abortWeb();
    // Ask the host to stop without severing the response first: disconnection would
    // close the outer turn before the original loop can save its partial result.
    try { await run?.api.json("cancel", { requestId }); }
    catch { streams.get(requestId)?.abort(); }
  };
  const projectApi = {
    resolveChat: async () => { const page = await history(); return { projectId: page.workId, chatId: page.sessionId }; },
    rebindChat: async () => { const page = await history(); return { projectId: page.workId, chatId: page.sessionId }; },
    loadChat: async (ids: { projectId: string; chatId: string }) => {
      const page = await history();
      if (ids.projectId !== page.workId || ids.chatId !== page.sessionId) throw new Error("선택한 Workbench 세션과 대화 기록이 다릅니다.");
      return officeChat(page.items);
    },
    // The loop awaits the authoritative turn/event writes. The original panel's
    // fire-and-forget mirror must never create a second JSONL conversation.
    appendChat: async () => {},
  };
  return {
    desktop: { ...references.desktop, getAiSettings: getSettings, openAiModelSettings: openSettings, aiStream, aiStreamCancel, onAiStream: events.on("aiStream"), onAiSettingsChanged: events.on("aiSettingsChanged"),
      aiToolCapabilities: () => gateway.aiSession(init.artifact.id).json<any>("tool-capabilities"),
      webSearch: (query: string, limit?: number) => webTool("web-search", query, ...(limit === undefined ? [] : [limit])),
      imageSearch: (query: string, limit?: number) => webTool("image-search", query, ...(limit === undefined ? [] : [limit])),
      readUrl: (url: string, offset?: number) => webTool("read-url", url, ...(offset === undefined ? [] : [offset])),
      fetchImage: (url: string) => webTool("fetch-image", url),
      setAiSettings: async (settings: unknown) => { const saved = await gateway.aiSession(init.artifact.id).json("selection", settings); events.emit("aiSettingsChanged", saved); return saved; } },
    projectApi,
    templates: skills.bridge,
    docs: references.docs,
    subscription: { statuses: () => statuses(), recheck: () => statuses(true), onChanged: events.on("aiSubscriptionChanged"), openSettings,
      install: openSettings, update: openSettings, login: openSettings, cancelLogin: openSettings, setMeteredAccepted: openSettings, openInstallHelp: openSettings, openConnectHelp: openSettings },
    subscribe: (listener: () => void) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
    snapshot: () => sessionKey,
    newSession: async () => { if (active) { active.cancel(); await active.settled; } await parent("new-session"); },
    refresh: async () => { skills.refresh(); events.emit("aiSettingsChanged", await getSettings()); },
  };
}
export type OfficeAiBridge = ReturnType<typeof createOfficeAi>;

/** Expose the shared conversation before mounting any original renderer/preload. */
export function mountOfficeAi(init: Init, gateway: Gateway, events = new Events()) {
  const ai = createOfficeAi(init, gateway, events);
  Object.assign(window, { projectApi: ai.projectApi, aiOfficeSubscription: ai.subscription, aiOfficeDocs: ai.docs, workbenchOfficeAi: ai });
  window.addEventListener("focus", () => { void ai.refresh().catch(() => {}); });
  return ai;
}

/** Original Electron channel names, backed by the same scoped document capability. */
export function officeAiTransport(ai: OfficeAiBridge, dispatch: (channel: string, args: unknown[]) => void, fallback: (channel: string, args: unknown[]) => Promise<unknown>) {
  ai.desktop.onAiStream((chunk) => dispatch("ai:stream-chunk", [chunk]));
  ai.desktop.onAiSettingsChanged(() => dispatch("ai:settings-changed", []));
  ai.subscription.onChanged((statuses) => dispatch("ai:subscription-changed", [statuses]));
  return async (channel: string, args: unknown[]): Promise<unknown> => {
    if (/^(?:files:pick|(?:slides|sheets|mindmap|epub):files-pick)$/.test(channel)) return ai.desktop.pickAttachments();
    if (/^(?:files:add-pasted-image|(?:slides|sheets|mindmap|epub):files-add-pasted-image)$/.test(channel)) return ai.desktop.addPastedImage(args[0] as ArrayBuffer, String(args[1]));
    if (/^(?:files:read-image|(?:slides|sheets|mindmap|epub):files-read-image)$/.test(channel)) return ai.desktop.readAttachmentImage(String(args[0]));
    if (/^(?:files:add|(?:slides|sheets|mindmap|epub):files-add)$/.test(channel)) return ai.desktop.addAttachmentPaths(args[0] as string[]);
    if (/^(?:files:read|(?:slides|sheets|mindmap|epub):files-read)$/.test(channel)) return ai.desktop.readAttachment(String(args[0]), args[1] as number | undefined, args[2] as number | undefined);
    switch (channel) {
      case "doc:attach-available": return ai.docs.available();
      case "doc:attach-list": return ai.docs.list();
      case "doc:pick-attachments": return ai.docs.pick();
      case "ai:get-settings": return ai.desktop.getAiSettings();
      case "ai:set-settings": return ai.desktop.setAiSettings(args[0]);
      case "ai:open-model-settings": return ai.desktop.openAiModelSettings();
      case "ai:stream": return ai.desktop.aiStream(args[0] as Parameters<typeof ai.desktop.aiStream>[0]);
      case "ai:stream-cancel": return ai.desktop.aiStreamCancel(String(args[0]));
      case "ai:tool-capabilities": return ai.desktop.aiToolCapabilities();
      case "slides:ai-tool-capabilities": case "sheets:ai-tool-capabilities": return ai.desktop.aiToolCapabilities();
      case "ai:web-search": return ai.desktop.webSearch(String(args[0]), args[1] as number | undefined);
      case "ai:image-search": return ai.desktop.imageSearch(String(args[0]), args[1] as number | undefined);
      case "ai:read-url": return ai.desktop.readUrl(String(args[0]), args[1] as number | undefined);
      case "ai:fetch-image": case "html:fetch-image": case "hwp:fetch-image": case "mindmap:fetch-image": case "sheets:ai-fetch-image": return ai.desktop.fetchImage(String(args[0]));
      case "ai:subscription-statuses": return ai.subscription.statuses();
      case "ai:subscription-recheck": return ai.subscription.recheck();
      case "home:open-subscription-install-help": case "home:open-connect-help": return ai.desktop.openAiModelSettings();
      case "ai:subscription-install": case "ai:subscription-update": case "ai:subscription-login":
      case "ai:subscription-cancel-login": case "ai:subscription-metered": {
        await ai.desktop.openAiModelSettings();
        // The original settings dialog owns installation/login and its progress.
        // Do not report a successful action merely because that dialog was opened.
        return { ok: false, error: "열린 AI 설정 창에서 연결을 계속해 주세요." };
      }
      case "ai:subscription-codex-image": return false;
      default: return fallback(channel, args);
    }
  };
}
