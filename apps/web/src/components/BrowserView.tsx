import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { PROVIDER_LABEL, type BrowserPage, type BrowserPageCreate, type Session, type Workspace } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { ApiRequestError } from "../api.ts";
import { browserUrl, sameBrowserControl, type SharedBrowser } from "../browser-state.ts";
import { isBusy, type State, type Transcript as Conversation } from "../state.ts";
import { Composer } from "./Composer.tsx";
import { Transcript } from "./Transcript.tsx";
import type { WorkActions } from "./WorkView.tsx";
import { restoreSurfaceFocus } from "./controls/menu-navigation.ts";
import "../styles/browser.css";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
type NewTarget = { workspaceId?: string; profileId?: string; url?: string };
const createKey = "workbench.browser.creation";
function savedCreation(): BrowserPageCreate | null {
  try {
    const input = JSON.parse(sessionStorage.getItem(createKey) ?? "null") as BrowserPageCreate | null;
    return input && typeof input.requestId === "string" && typeof input.workspaceId === "string" && typeof input.profileId === "string" && typeof input.driverId === "string" && typeof input.url === "string" ? input : null;
  } catch { return null; }
}

export function NewBrowserDialog({ browser, workspaces, target, onOpen, onClose }: {
  browser: SharedBrowser; workspaces: Workspace[]; target: NewTarget;
  onOpen: (page: BrowserPage) => void; onClose: () => void;
}) {
  const data = useSyncExternalStore(browser.subscribe, browser.getState);
  const [pending, setPending] = useState(savedCreation);
  const [workspaceId, setWorkspaceId] = useState(pending?.workspaceId ?? target.workspaceId ?? workspaces[0]?.id ?? "");
  const [profileId, setProfileId] = useState(pending?.profileId ?? target.profileId ?? data.profiles[0]?.id ?? "default");
  const [url, setUrl] = useState(pending?.url ?? target.url ?? "https://");
  const [profileName, setProfileName] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null), opener = useRef(document.activeElement), acting = useRef(false);
  const spaces = workspaces.filter(space => !space.archivedAt && !space.removedAt);
  useLayoutEffect(() => { const surface = dialog.current; surface?.showModal(); return () => restoreSurfaceFocus(opener.current, surface); }, []);
  useEffect(() => { void browser.refresh().catch(reason => setError(message(reason))); }, [browser]);
  const remember = (input: BrowserPageCreate | null) => {
    setPending(input); try { if (input) sessionStorage.setItem(createKey, JSON.stringify(input)); else sessionStorage.removeItem(createKey); } catch { /* Keep this dialog's receipt. */ }
  };
  const run = async (fn: () => Promise<void>) => {
    if (acting.current) return; acting.current = true; setBusy(true); setError("");
    try { await fn(); } catch (reason) { setError(message(reason)); } finally { acting.current = false; setBusy(false); }
  };
  const open = async () => {
    const input = { requestId: crypto.randomUUID(), driverId: browser.driverId, workspaceId, profileId, url: browserUrl(url) };
    remember(input);
    try { const page = await browser.create(input); remember(null); onOpen(page); onClose(); }
    catch (reason) { if (reason instanceof ApiRequestError && reason.status >= 400 && reason.status < 500) remember(null); throw reason; }
  };
  return <dialog ref={dialog} className="browser-create-dialog" aria-labelledby="browser-create-title" onCancel={onClose}>
    <header><h2 id="browser-create-title">새 웹 탭</h2><button type="button" className="ghost-button" aria-label="웹 탭 만들기 닫기" onClick={onClose}>닫기</button></header>
    {!browser.available ? <p>공유 웹 탭은 데스크톱 기본 창에서 열 수 있습니다. 기본 창의 + 메뉴를 사용해 주세요.</p> : <>
      <form onSubmit={event => { event.preventDefault(); if (!pending) void run(open); }}>
        <label>작업공간<select value={workspaceId} disabled={busy || !!pending} onChange={event => setWorkspaceId(event.target.value)}>{spaces.map(space => <option key={space.id} value={space.id}>{space.label} · {space.cwd}</option>)}</select></label>
        <label>브라우저 프로필<select value={profileId} disabled={busy || !!pending} onChange={event => setProfileId(event.target.value)}>{data.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
        <label>웹 주소<input autoFocus type="text" inputMode="url" autoCapitalize="none" spellCheck={false} value={url} disabled={busy || !!pending} onChange={event => setUrl(event.target.value)} placeholder="https://example.com" /></label>
        <p className="muted">프로필별 웹 페이지를 구분합니다. 로그인 상태 보존은 플랫폼 지원에 따라 다릅니다. 같은 주소를 새로 열어도 별도 페이지와 AI 대화를 사용합니다.</p>
        <button type="submit" className="button" disabled={busy || !!pending || !workspaceId || !profileId || !data.connected}>웹 탭 열기</button>
      </form>
      {!spaces.length ? <p>프로젝트에 작업공간을 연결한 뒤 웹 탭을 열어 주세요.</p> : null}
      {pending ? <div className="browser-pending" role="status"><p>생성 요청의 결과를 확인해야 합니다. 같은 요청으로 새 페이지를 자동 실행하지 않습니다.</p><code>{pending.requestId}</code><button type="button" className="button small" disabled={busy} onClick={() => void run(async () => {
        const page = await browser.reconcileCreation(pending);
        if (!page) throw new Error("아직 생성 기록을 확인할 수 없습니다. 호스트 연결을 확인한 뒤 다시 조회해 주세요.");
        remember(null); onOpen(page); onClose();
      })}>기존 생성 결과 확인</button><button type="button" className="ghost-button small" disabled={busy} onClick={() => { remember(null); setError("이전 요청을 다시 실행하지 않습니다. 새로 열기를 누르면 별도 페이지가 만들어집니다. 늦게 도착한 기록은 아래 페이지 목록에 남습니다."); }}>별도 새 탭 준비</button></div> : null}
      <form className="browser-profile-create" onSubmit={event => { event.preventDefault(); void run(async () => { const profile = await browser.profile(profileName); setProfileId(profile.id); setProfileName(""); }); }}>
        <label>새 프로필 이름<input value={profileName} maxLength={80} disabled={busy || !!pending} onChange={event => setProfileName(event.target.value)} /></label><button type="submit" className="button small" disabled={busy || !!pending || !profileName.trim()}>프로필 만들기</button>
      </form>
    </>}
    {error || data.error ? <p role="alert" className="browser-error">{error || data.error}</p> : null}
    {data.pages.length ? <section className="browser-existing"><h3>열려 있는 웹 페이지</h3><p className="muted">다른 탭이나 작업공간을 보는 동안에도 페이지와 진행 중인 AI 작업은 유지됩니다.</p>{data.pages.filter(page => page.status !== "closed" && (!workspaceId || page.workspaceId === workspaceId)).map(page => <button type="button" className="ghost-button" key={page.pageId} onClick={() => { onOpen(page); onClose(); }}><strong>{page.title || page.url}</strong><small>{page.status === "interrupted" ? "연결 중단 · " : ""}{data.profiles.find(profile => profile.id === page.profileId)?.name} · {page.url}</small></button>)}</section> : null}
  </dialog>;
}

export function BrowserView({ browser, api, state, pageId, visible, parentSessionId, actions, onNew, onClosed, onLeaveGuard, onTranscript, onOpenSession, focusItem, onFocusDone }: {
  browser: SharedBrowser; api: Api; state: State; pageId: string; visible: boolean; parentSessionId: string | null;
  actions: WorkActions; onNew: (target: NewTarget) => void; onClosed: () => void;
  onLeaveGuard?: (guard: ((reason?: "close") => Promise<void>) | null) => void;
  onTranscript: (sessionId: string, transcript: Conversation) => void; onOpenSession: (session: Session) => void;
  focusItem: { sessionId: string; itemId: string; nonce: number } | null; onFocusDone: () => void;
}) {
  const data = useSyncExternalStore(browser.subscribe, browser.getState);
  const page = data.pages.find(entry => entry.pageId === pageId);
  const [address, setAddress] = useState(page?.url ?? ""), editingAddress = useRef(false);
  const [aiOpen, setAiOpen] = useState(Boolean(focusItem));
  const [createdSession, setCreatedSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const viewport = useRef<HTMLDivElement>(null), aiButton = useRef<HTMLButtonElement>(null), acting = useRef(false);
  const slot = useId(), transcriptCallback = useRef(onTranscript); transcriptCallback.current = onTranscript;
  const session = (page?.sessionId ? state.sessions[page.sessionId] : undefined) ?? createdSession;
  const transcript = session ? state.transcripts[session.id] : undefined;
  const confirmed = Boolean(page?.native && sameBrowserControl(page.control, page.native.control));
  const ready = browser.available && data.connected && page?.status === "ready" && page.driverId === browser.driverId;
  const human = confirmed && page?.control.owner === "human";
  const ai = confirmed && !!session && page?.control.owner === session.id;
  const pending = data.pending[pageId];
  const run = async (fn: () => Promise<void>) => {
    if (acting.current) return; acting.current = true; setBusy(true); setError("");
    try { await fn(); } catch (reason) { setError(message(reason)); } finally { acting.current = false; setBusy(false); }
  };
  useEffect(() => { if (!editingAddress.current && page?.url) setAddress(page.url); }, [page?.url]);
  useEffect(() => { if (focusItem) setAiOpen(true); }, [focusItem]);
  useEffect(() => {
    onLeaveGuard?.(async reason => { if (reason === "close") await browser.close(pageId); });
    return () => onLeaveGuard?.(null);
  }, [browser, pageId, onLeaveGuard]);
  useLayoutEffect(() => {
    if (viewport.current) return browser.surface(slot, pageId, viewport.current, visible);
  }, [browser, slot, pageId, visible, ready]);
  useEffect(() => {
    if (!session || transcript || !aiOpen) return;
    let cancelled = false;
    void api.items(session.id).then(result => { if (!cancelled) transcriptCallback.current(session.id, result); }).catch(reason => { if (!cancelled) setError(message(reason)); });
    return () => { cancelled = true; };
  }, [api, session?.id, !!transcript, aiOpen]);
  const ask = async () => {
    setAiOpen(true);
    if (!session) setCreatedSession(await browser.session(pageId, parentSessionId));
  };
  const navigate = async (kind: "back" | "forward" | "reload" | "stop") => { await browser.action(pageId, { kind }); };
  const clone = () => onNew({ workspaceId: page?.workspaceId, profileId: page?.profileId, url: page?.url });
  if (!browser.available) return <div className="browser-unavailable"><h2>웹 탭</h2><p>공유 브라우저는 데스크톱 기본 창에서 사용할 수 있습니다. 기본 창에서 이 웹 탭을 열어 주세요.</p></div>;
  return <section className="browser-view" aria-label="공유 웹 탭">
    <div className="browser-toolbar">
      <div className="browser-navigation" role="group" aria-label="페이지 이동">
        <button type="button" className="ghost-button" aria-label="이전 페이지" title="이전 페이지" disabled={!ready || !human || busy || !!pending} onClick={() => void run(() => navigate("back"))}>←</button>
        <button type="button" className="ghost-button" aria-label="다음 페이지" title="다음 페이지" disabled={!ready || !human || busy || !!pending} onClick={() => void run(() => navigate("forward"))}>→</button>
        <button type="button" className="ghost-button" disabled={!ready || !human || busy || !!pending} onClick={() => void run(() => navigate(page?.native?.loading ? "stop" : "reload"))}>{page?.native?.loading ? "중지" : "새로고침"}</button>
      </div>
      <form onSubmit={event => { event.preventDefault(); void run(async () => { await browser.action(pageId, { kind: "navigate", url: browserUrl(address) }); editingAddress.current = false; }); }}>
        <input aria-label="현재 웹 주소" type="text" inputMode="url" spellCheck={false} autoCapitalize="none" value={address} disabled={!ready || !human || busy || !!pending} onFocus={() => { editingAddress.current = true; }} onBlur={() => { editingAddress.current = false; }} onChange={event => setAddress(event.target.value)} />
        <button type="submit" className="button small" disabled={!ready || !human || busy || !!pending}>이동</button>
      </form>
      <button type="button" className="ghost-button small" title="이 주소를 프로필을 골라 새 탭으로 열기" onClick={clone}>{data.profiles.find(profile => profile.id === page?.profileId)?.name ?? "프로필"} · 새 탭</button>
      <button ref={aiButton} type="button" className="button small" aria-expanded={aiOpen} disabled={!ready || busy} onClick={() => aiOpen ? setAiOpen(false) : void run(ask)}>AI에게 요청</button>
    </div>
    <div className="browser-control-bar">
      <span role="status">{!page ? "페이지 기록을 불러오는 중" : page.status === "interrupted" ? "페이지 연결 중단" : page.status === "opening" ? "페이지 여는 중" : !confirmed ? "제어권 인계 중" : human ? "직접 조작 중" : "AI가 조작 중"}</span>
      <span className="muted">페이지를 직접 누르거나 입력하면 제어권을 가져옵니다.</span>
      <button type="button" className="button small" disabled={!ready || busy || human} onClick={() => void run(async () => { await browser.control(pageId, "human"); })}>내가 조작하기</button>
      <button type="button" className="ghost-button small" disabled={!ready || busy || !!pending} onClick={() => void run(async () => { await browser.close(pageId); onClosed(); })}>페이지 종료</button>
    </div>
    {error || data.error || page?.error ? <p role="alert" className="browser-error">{error || data.error || page?.error}</p> : null}
    {pending ? <div className="browser-pending" role="status">앞선 동작 결과 확인 중 <button type="button" className="button small" disabled={busy} onClick={() => void run(async () => { const result = await browser.reconcile(pageId); if (!result) throw new Error("아직 실행 결과를 기다리고 있습니다."); if (result.error) throw new Error(result.error); })}>결과 다시 확인</button>{pending.status === "unknown" ? <button type="button" className="ghost-button small" disabled={busy} onClick={() => { browser.dismissPending(pageId); setError("결과 확인을 끝냈습니다. 이전 동작을 다시 실행하지 않았습니다."); }}>페이지를 직접 확인했어요</button> : null}</div> : null}
    {page?.native?.popups.length ? <div className="browser-popups"><span>차단된 새 창</span>{page.native.popups.map(popup => <button type="button" className="text-button" key={popup.id} title={popup.url} onClick={() => onNew({ workspaceId: page.workspaceId, profileId: page.profileId, url: popup.url })}>{popup.url} · 새 탭으로 열기</button>)}</div> : null}
    <div className="browser-content">
      <div ref={viewport} className="browser-viewport" aria-label="웹 페이지 표시 영역">
        {!ready ? <div className="browser-unavailable"><h2>{page?.status === "interrupted" ? "이 페이지의 연결이 끊겼습니다" : "웹 페이지 연결 대기"}</h2><p>{page?.status === "interrupted" ? "이전 페이지와 AI 작업을 자동으로 다시 시작하지 않습니다." : "데스크톱 브라우저와 호스트의 연결을 확인해 주세요."}</p><button type="button" className="button" onClick={clone}>새 웹 탭으로 열기…</button></div> : null}
      </div>
      {aiOpen ? <aside className="browser-conversation" aria-label="웹 탭 AI 대화">
        <header><div><strong>이 웹 탭에 요청</strong><small>{session ? PROVIDER_LABEL[session.provider] : "독립 대화 준비"} · {page?.title || "웹 페이지"}</small></div><button type="button" className="ghost-button small" aria-label="웹 탭 AI 대화 접기" onClick={() => { setAiOpen(false); aiButton.current?.focus(); }}>접기</button></header>
        <p className="browser-conversation-note">이 페이지의 독립 대화입니다. AI에게 제어권을 넘긴 뒤 요청을 보낼 수 있습니다.</p>
        {session?.pageAgent?.parentSessionId && state.sessions[session.pageAgent.parentSessionId] ? <button type="button" className="text-button" onClick={() => onOpenSession(state.sessions[session.pageAgent!.parentSessionId!]!)}>원래 대화 열기</button> : null}
        <button type="button" className="button small browser-grant" disabled={!ready || busy || ai} onClick={() => void run(async () => { let child = session; if (!child) { child = await browser.session(pageId, parentSessionId); setCreatedSession(child); } await browser.control(pageId, child.id); })}>{ai ? "AI에게 제어권을 맡겼습니다" : "AI에게 맡기기"}</button>
        {session ? <>
          <Transcript sessionId={session.id} items={transcript?.items ?? []} provider={session.provider} running={isBusy(session)} loading={!transcript} onAnswer={(id, decision) => actions.answer(session, id, decision)} focusItem={focusItem?.sessionId === session.id ? focusItem : null} onFocusDone={onFocusDone} />
          {session.queued.length ? <div className="browser-queued" aria-label="대기 요청">{session.queued.map(request => <div key={request.id}><span>{request.text}</span>{request.held ? <button type="button" className="text-button" disabled={!ai || !ready} onClick={() => actions.queued.send(session, request.id)}>보내기</button> : null}<button type="button" className="text-button" onClick={() => actions.queued.cancel(session, request.id)}>대기 취소</button></div>)}</div> : null}
          <Composer draftKey={`browser:${pageId}:${session.id}`} voiceScope={{ workId: session.workId, sessionId: session.id }} voiceReply={transcript?.items.filter(item => item.kind === "assistant" && !item.streaming).map(item => item.kind === "assistant" ? item.text : "").at(-1)} placeholder="이 웹 페이지에서 할 일을 입력하세요" busy={isBusy(session)} waiting={session.status === "awaitingApproval"} disabled={!ready || !ai || busy} steerable={session.provider === "codex"} onSend={(text, mode) => actions.send(session, text, undefined, undefined, mode)} onStop={() => actions.interrupt(session)} />
        </> : <p className="muted">대화를 준비한 뒤 AI에게 제어권을 넘겨 주세요.</p>}
      </aside> : null}
    </div>
    <footer className="browser-footnote">{page?.native && !page.native.capabilities.includes("persistent_profile") ? "이 환경에서는 재시작 뒤 로그인 상태를 유지하지 않습니다. " : ""}업로드·다운로드·사이트 권한 관리 기능은 아직 제공하지 않습니다.</footer>
  </section>;
}
