import { useEffect, useRef, useState } from "react";
import type { Artifact } from "@workbench/contracts";
import type { Api } from "../api.ts";
import type { State } from "../state.ts";
import { KNOWLEDGE_HOME_CHANNELS, type KnowledgeHomeRequest } from "../../../../packages/contracts/src/knowledge-home.ts";

export function KnowledgeHome({ api, state, workId, theme, visible, refreshToken, onOpen, onManage, onSettings, onSkills }: {
  api: Api; state: State; workId?: string | null; theme: "light" | "dark"; visible: boolean; refreshToken: unknown;
  onOpen(artifact: Artifact): void; onManage(): void; onSettings(): void;
  onSkills(scope: { workId?: string; workspaceId?: string }): void;
}) {
  const frame = useRef<HTMLIFrameElement>(null), [page, setPage] = useState<{ origin: string; url: string; owner: string } | null>(null);
  const [error, setError] = useState(""), [creating, setCreating] = useState(false);
  const [target, setTarget] = useState(workId ?? ""), [workspace, setWorkspace] = useState(state.works[workId ?? ""]?.defaultWorkspaceId ?? "");
  const calls = useRef(new Map<string, AbortController>());
  const projects = Object.values(state.works).filter(work => !work.archivedAt);
  const spaces = Object.values(state.workspaces).filter(space => space.workId === target && !space.archivedAt && !space.removedAt);
  const latest = useRef({ theme, target, workspace, onOpen, onManage, onSettings, onSkills }); latest.current = { theme, target, workspace, onOpen, onManage, onSettings, onSkills };
  const post = (value: unknown) => { if (page) frame.current?.contentWindow?.postMessage(value, page.origin); };
  useEffect(() => {
    let alive = true, owner: string | undefined;
    void (async () => {
      const opening = await api.request<{ origin: string; url: string }>("GET", "/api/office-knowledge/page");
      const created = await api.request<{ owner: string }>("POST", "/api/office-knowledge/home", {});
      owner = created.owner;
      if (alive) setPage({ ...opening, owner });
      else await api.request("DELETE", "/api/office-knowledge/home/" + encodeURIComponent(owner), undefined, { keepalive: true });
    })().catch(reason => { if (alive) setError(String(reason)); });
    return () => {
      alive = false; for (const call of calls.current.values()) call.abort(); calls.current.clear();
      if (owner) void api.request("DELETE", "/api/office-knowledge/home/" + encodeURIComponent(owner), undefined, { keepalive: true }).catch(() => {});
    };
  }, [api]);
  useEffect(() => { post({ type: "knowledge:theme", theme }); }, [page, theme]);
  useEffect(() => { if (visible) post({ type: "knowledge:refresh" }); }, [page, visible, refreshToken, target, workspace]);
  useEffect(() => {
    if (!page) return;
    let alive = true;
    const base = "/api/office-knowledge/home/" + encodeURIComponent(page.owner);
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== page.origin) return;
      if (event.data?.type === "knowledge:ready") { post({ type: "knowledge:theme", theme: latest.current.theme }); post({ type: "knowledge:refresh" }); return; }
      if (event.data?.type === "knowledge:cancel") { calls.current.get(event.data.requestId)?.abort(); return; }
      const message = event.data as KnowledgeHomeRequest;
      if (message?.type !== "knowledge:request" || typeof message.requestId !== "string" || !/^[\w-]{1,128}$/.test(message.requestId) || !KNOWLEDGE_HOME_CHANNELS.has(message.channel) || !Array.isArray(message.args) || message.args.length > 4) return;
      const reply = (value?: unknown, error?: string) => { if (alive) post({ type: "knowledge:reply", requestId: message.requestId, value, error }); };
      if (calls.current.has(message.requestId)) return;
      if (calls.current.size >= 24) { reply(undefined, "진행 중인 요청을 마친 뒤 다시 시도해 주세요."); return; }
      const controller = new AbortController(); calls.current.set(message.requestId, controller);
      const { channel, args } = message, options = { signal: controller.signal };
      const destination = latest.current.target ? { workId: latest.current.target, ...(latest.current.workspace ? { workspaceId: latest.current.workspace } : {}) } : undefined;
      if (channel === "ai:stream") {
        const request = args[0] as { requestId?: string } | undefined;
        void api.knowledgeStream(page.owner, args[0], chunk => { if (alive) post({ type: "knowledge:chunk", chunk }); }, controller.signal)
          .catch(reason => { if (alive && !controller.signal.aborted) post({ type: "knowledge:chunk", chunk: { requestId: request?.requestId, type: "error", error: reason instanceof Error ? reason.message : String(reason) } }); })
          .finally(() => calls.current.delete(message.requestId));
        reply(); return;
      }
      const call = async () => {
        if (channel === "home:knowledge-manage") { latest.current.onManage(); return null; }
        if (channel === "home:knowledge-settings") { latest.current.onSettings(); return null; }
        if (channel === "home:skill-settings") { latest.current.onSkills(destination ?? {}); return null; }
        if (channel === "ai:get-settings") return api.request("GET", base + "/settings", undefined, options);
        if (channel === "ai:set-settings") return api.request("POST", base + "/selection", args[0], options);
        if (channel === "ai:stream-cancel") return api.request("POST", base + "/cancel", { requestId: args[0] }, options);
        if (channel.startsWith("kb:") || channel === "home:starred" || channel === "home:starred-groups" || channel === "home:open-path" || channel === "home:skills") {
          const value = await api.request<unknown>("POST", base + "/invoke", { channel, args, destination }, options);
          if (channel === "home:open-path") latest.current.onOpen(value as Artifact);
          if (channel === "home:skills") {
            const result = value as { ok?: boolean; tabId?: string; artifact?: Artifact }, operation = (args[0] as { operation?: string })?.operation;
            if (result.ok && result.artifact && (operation === "open-template" || operation === "focus-tab")) latest.current.onOpen(result.artifact);
          }
          return value;
        }
        return api.request("POST", "/api/office-ai/invoke", { channel, args, owner: "knowledge:" + page.owner }, options);
      };
      void call().then(value => reply(value), reason => { if (!controller.signal.aborted) reply(undefined, reason instanceof Error ? reason.message : String(reason)); })
        .finally(() => calls.current.delete(message.requestId));
    };
    window.addEventListener("message", receive);
    return () => { alive = false; window.removeEventListener("message", receive); };
  }, [api, page]);
  const createProject = async () => {
    if (creating) return; setCreating(true); setError("");
    try { const work = await api.createWork("지식베이스 문서", null, null); setTarget(work.id); setWorkspace(work.defaultWorkspaceId ?? ""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setCreating(false); }
  };
  return <div className="knowledge-home" hidden={!visible}>
    <div className="knowledge-destination">
      <label>문서 저장·열기 <select aria-label="지식베이스 문서 프로젝트" value={target} onChange={event => { setTarget(event.target.value); setWorkspace(state.works[event.target.value]?.defaultWorkspaceId ?? ""); }}>
        <option value="">프로젝트 선택</option>{projects.map(work => <option key={work.id} value={work.id}>{work.title}</option>)}
      </select></label>
      {spaces.length > 1 && <select aria-label="지식베이스 문서 작업공간" value={workspace} onChange={event => setWorkspace(event.target.value)}>{spaces.map(space => <option key={space.id} value={space.id}>{space.label}</option>)}</select>}
      <button type="button" disabled={creating} onClick={() => void createProject()}>{creating ? "만드는 중…" : "새 프로젝트"}</button>
      <small>닫기 전에 필요한 답변을 문서로 저장하세요.</small>
    </div>
    {error && <p role="alert">{error}</p>}
    {page ? <iframe ref={frame} title="지식베이스 질문 화면" src={page.url + "?host=" + encodeURIComponent(location.origin)} sandbox="allow-scripts allow-same-origin allow-modals" /> : <p role="status">질문 화면을 불러오고 있습니다.</p>}
  </div>;
}
