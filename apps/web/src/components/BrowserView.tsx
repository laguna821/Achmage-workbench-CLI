import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { PROVIDER_LABEL, type BrowserPage, type BrowserPageCreate, type Session, type Workspace, type Provider } from "@workbench/contracts";
import type { ReactNode } from "react";
import type { Api } from "../api.ts";
import { ApiRequestError } from "../api.ts";
import { browserUrl, type SharedBrowser } from "../browser-state.ts";
import { isBusy, turnRunning, type State, type Transcript as Conversation } from "../state.ts";
import { Icon } from "./Icon.tsx";
import { IconButton } from "./ui/Hig.tsx";
import { Popover, MenuItem } from "./Popover.tsx";
import { BrowseStart } from "./BrowseStart.tsx";
import { EngineTabs } from "./StartView.tsx";
import { ModelPicker, type ModelChoice } from "./ModelPicker.tsx";
export { BrowserSearch } from "./BrowseStart.tsx";
import { Composer } from "./Composer.tsx";
import { readDraft, writeDraft } from "../draft.ts";
import { BrowserTools } from "./BrowserTools.tsx";
import { useShownPanel } from "../completion-notifications.ts";
import { QueuedList, type WorkActions } from "./WorkView.tsx";
import { AgentColumn } from "./companion/AgentColumn.tsx";
import { NoteBanner } from "../conversation/NoteBanner.tsx";
import { Beside, useStoredRatio } from "./companion/Beside.tsx";
import { EngineMark } from "./EngineMark.tsx";
import { Select, type SelectOption } from "./ui/Select.tsx";
import { restoreSurfaceFocus } from "./controls/menu-navigation.ts";
import "../styles/browser.css";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const ENGINES: SelectOption<Provider>[] = (["codex", "claude"] as const).map(provider => ({ value: provider, label: PROVIDER_LABEL[provider], icon: <EngineMark provider={provider} size={16} /> }));
export type BrowserTarget = { workspaceId?: string; profileId?: string; url?: string };
type NewTarget = BrowserTarget;
const createKey = "workbench.browser.creation";
function savedCreation(): BrowserPageCreate | null {
  try {
    const input = JSON.parse(sessionStorage.getItem(createKey) ?? "null") as BrowserPageCreate | null;
    return input && typeof input.requestId === "string" && typeof input.workspaceId === "string" && typeof input.profileId === "string" && typeof input.driverId === "string" && typeof input.url === "string" ? input : null;
  } catch { return null; }
}

function rememberCreation(input: BrowserPageCreate | null) {
  try { if (input) sessionStorage.setItem(createKey, JSON.stringify(input)); else sessionStorage.removeItem(createKey); } catch { /* The browser also retains the creation receipt. */ }
}

/** Direct opening shares the advanced dialog's receipt; uncertain creation is only reconciled. */
export async function openBrowserTab(browser: SharedBrowser, api: Api, state: State, target: BrowserTarget & { workId?: string | null }): Promise<BrowserPage> {
  if (!browser.available) throw new Error("웹 탭은 데스크톱 기본 창에서 열어 주세요.");
  const pending = savedCreation();
  if (pending) {
    const page = await browser.reconcileCreation(pending);
    if (!page) throw new Error("앞선 웹 탭 생성 결과를 확인하고 있습니다. 잠시 뒤 다시 열어 주세요.");
    rememberCreation(null); return page;
  }
  await browser.refresh();
  const spaces = Object.values(state.workspaces).filter(space => !space.archivedAt && !space.removedAt && !state.works[space.workId]?.archivedAt);
  const selected = spaces.find(space => space.id === target.workspaceId);
  const project = target.workId ? state.works[target.workId] : undefined;
  let workspaceId = selected?.id ?? spaces.find(space => project ? space.id === project.defaultWorkspaceId : true)?.id ?? spaces.find(space => space.workId === project?.id)?.id;
  if (!workspaceId) {
    const work = project ?? await api.createWork("웹", null, null);
    workspaceId = work.defaultWorkspaceId ?? (await api.createWorkspace(work.id, work.cwd)).id;
  }
  const input = { requestId: crypto.randomUUID(), driverId: browser.driverId, workspaceId, profileId: target.profileId ?? browser.getState().profiles[0]?.id ?? "default", url: browserUrl(target.url ?? "") };
  rememberCreation(input);
  try { const page = await browser.create(input); rememberCreation(null); return page; }
  catch (reason) { if (reason instanceof ApiRequestError && reason.status >= 400 && reason.status < 500) rememberCreation(null); throw reason; }
}

export function NewBrowserDialog({ browser, workspaces, target, onOpen, onClose }: {
  browser: SharedBrowser; workspaces: Workspace[]; target: NewTarget;
  onOpen: (page: BrowserPage) => void; onClose: () => void;
}) {
  const data = useSyncExternalStore(browser.subscribe, browser.getState);
  const [pending, setPending] = useState(savedCreation);
  const [workspaceId, setWorkspaceId] = useState(pending?.workspaceId ?? target.workspaceId ?? workspaces[0]?.id ?? "");
  const [profileId, setProfileId] = useState(pending?.profileId ?? target.profileId ?? data.profiles[0]?.id ?? "default");
  const [url, setUrl] = useState(pending?.url ?? target.url ?? "");
  const [profileName, setProfileName] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null), opener = useRef(document.activeElement), acting = useRef(false);
  const spaces = workspaces.filter(space => !space.archivedAt && !space.removedAt);
  useLayoutEffect(() => { const surface = dialog.current; surface?.showModal(); return () => restoreSurfaceFocus(opener.current, surface); }, []);
  useEffect(() => { void browser.refresh().catch(reason => setError(message(reason))); }, [browser]);
  const remember = (input: BrowserPageCreate | null) => {
    setPending(input); rememberCreation(input);
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
    <header><h2 id="browser-create-title">웹 탭 설정</h2><button type="button" className="ghost-button" aria-label="웹 탭 만들기 닫기" onClick={onClose}>닫기</button></header>
    {!browser.available ? <p>공유 웹 탭은 데스크톱 기본 창에서 열 수 있습니다. 기본 창의 + 메뉴를 사용해 주세요.</p> : <>
      <form onSubmit={event => { event.preventDefault(); if (!pending) void run(open); }}>
        <label>작업공간<select value={workspaceId} disabled={busy || !!pending} onChange={event => setWorkspaceId(event.target.value)}>{spaces.map(space => <option key={space.id} value={space.id}>{space.label}</option>)}</select></label>
        <label>브라우저 프로필<select value={profileId} disabled={busy || !!pending} onChange={event => setProfileId(event.target.value)}>{data.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
        <label>웹 주소<input autoFocus type="text" inputMode="url" autoCapitalize="none" spellCheck={false} value={url} disabled={busy || !!pending} onChange={event => setUrl(event.target.value)} placeholder="https://example.com" /></label>
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

export function BrowserView({ browser, api, state, pageId, visible, parentSessionId, actions, onNew, onStart, onClosed, engine = "codex", onLeaveGuard, onTranscript, onOpenSession, onSessionMenu, hosted, focusItem, onFocusDone }: {
  browser: SharedBrowser; api: Api; state: State; pageId: string; visible: boolean; parentSessionId: string | null;
  onStart?: (text: string, provider: Provider, choice: ModelChoice) => Promise<boolean>; engine?: Provider;
  actions: WorkActions; onNew: (target: NewTarget) => void; onClosed: () => void;
  onLeaveGuard?: (guard: ((reason?: "close" | "discard") => Promise<void>) | null) => void;
  onTranscript: (sessionId: string, transcript: Conversation) => void; onOpenSession: (session: Session) => void;
  /** This page's AI's own actions (rename, archive, mute…), from its conversation's head. */
  onSessionMenu?: (session: Session, x: number, y: number) => void;
  /**
   * The page is a conversation's companion (beside it, in that conversation's tab): asking goes to
   * that conversation, so this view shows no AI of its own. Its bar closes it (the page lives on),
   * or opens it wide in a tab of its own.
   */
  hosted?: { onClose: () => void; onWide: () => void; /** It lies over the conversation: its bar carries the way back to the conversation, by name. */ over?: boolean; /** What the covered conversation is doing (e.g. 승인 필요). */ back?: string | null };
  focusItem: { sessionId: string; itemId: string; nonce: number } | null; onFocusDone: () => void;
}) {
  const data = useSyncExternalStore(browser.subscribe, browser.getState);
  const page = data.pages.find(entry => entry.pageId === pageId);
  const [address, setAddress] = useState(page?.url ?? ""), editingAddress = useRef(false);
  const [aiOpen, setAiOpen] = useState(Boolean(focusItem) && !hosted);
  const [columnRatio, setColumnRatio] = useStoredRatio("workbench.agentColumn.web", 0.38);
  const [askEngine, setAskEngine] = useState<Provider>(engine);
  const [askChoice, setAskChoice] = useState<ModelChoice>({ model: null, effort: null });
  const [toolsOpen, setToolsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [createdSession, setCreatedSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const viewport = useRef<HTMLDivElement>(null), aiButton = useRef<HTMLButtonElement>(null), acting = useRef(false);
  const slot = useId(), transcriptCallback = useRef(onTranscript); transcriptCallback.current = onTranscript;
  const storedSession = page?.sessionId ? state.sessions[page.sessionId] : undefined;
  const session = createdSession && createdSession.id === page?.sessionId && (!storedSession || createdSession.updatedAt > storedSession.updatedAt) ? createdSession : storedSession;
  const transcript = session ? state.transcripts[session.id] : undefined;
  const ready = browser.available && data.connected && page?.status === "ready" && page.driverId === browser.driverId;
  const blank = page?.url === "about:blank";
  const columnOpen = aiOpen && !blank && !hosted;
  // An archived conversation is only looked at: read-only at both ends, and not marked seen.
  const archived = Boolean(session?.archivedAt);
  useShownPanel(visible && columnOpen && session && !archived ? session.id : null);
  const pending = data.pending[pageId];
  const restoreAttempt = useRef("");
  const [connecting, setConnecting] = useState(false);
  const reconnect = async () => {
    setConnecting(true); setError("");
    try { await browser.restore(pageId); } catch (reason) { setError(message(reason)); }
    finally { setConnecting(false); }
  };
  useEffect(() => {
    if (!visible || !browser.available || !data.connected || ready || data.closedPageIds?.includes(pageId)) return;
    const attempt = `${pageId}:${page?.driverId ?? ""}:${page?.status ?? "legacy"}:${page?.control.generation ?? 0}`;
    if (restoreAttempt.current === attempt) return;
    restoreAttempt.current = attempt;
    void reconnect();
  }, [browser, pageId, visible, data.connected, page?.driverId, page?.status, page?.control.generation, ready, data.closedPageIds]);
  const run = async (fn: () => Promise<void>) => {
    if (acting.current) return; acting.current = true; setBusy(true); setError("");
    try { await fn(); } catch (reason) { setError(message(reason)); } finally { acting.current = false; setBusy(false); }
  };
  useEffect(() => { if (!editingAddress.current && page?.url) setAddress(page.url); }, [page?.url]);
  useEffect(() => { if (focusItem && !hosted) setAiOpen(true); }, [focusItem, Boolean(hosted)]);
  useEffect(() => {
    onLeaveGuard?.(async reason => { if (reason === "close") await browser.close(pageId); });
    return () => onLeaveGuard?.(null);
  }, [browser, pageId, onLeaveGuard]);
  useLayoutEffect(() => {
    if (viewport.current) return browser.surface(slot, pageId, viewport.current, visible && !blank);
  }, [browser, slot, pageId, visible, ready, blank]);
  useEffect(() => {
    if (!session || !columnOpen || (transcript && isBusy(session))) return;
    let cancelled = false;
    void api.items(session.id).then(result => { if (!cancelled) transcriptCallback.current(session.id, result); }).catch(reason => { if (!cancelled) setError(message(reason)); });
    return () => { cancelled = true; };
  }, [api, session?.id, session?.status, !!transcript, transcript?.items.at(-1)?.kind === "turnEnd" ? transcript.items.at(-1)?.id : null, columnOpen]);
  useEffect(() => {
    if (!ready || !columnOpen || session) return;
    let cancelled = false;
    void browser.session(pageId, parentSessionId).then(child => { if (!cancelled) setCreatedSession(child); }).catch(reason => { if (!cancelled) setError(message(reason)); });
    return () => { cancelled = true; };
  }, [browser, pageId, parentSessionId, ready, columnOpen, session?.id]);
  const ask = async () => { setAiOpen(true); };
  const humanAction = async (action: Parameters<SharedBrowser["action"]>[1]) => {
    await browser.control(pageId, "human"); await browser.action(pageId, action);
  };
  const navigate = async (kind: "back" | "forward" | "reload" | "stop") => { await humanAction({ kind }); };
  const send = async (text: string, mode?: "auto" | "queue") => {
    if (!session || acting.current) return false;
    acting.current = true; setBusy(true); setError("");
    try {
      await browser.control(pageId, session.id);
      const sent = await actions.send(session, text, undefined, undefined, mode);
      if (!sent) setError("요청을 보내지 못했습니다. 입력 내용을 확인하고 다시 보내 주세요.");
      return sent;
    } catch (reason) { setError(message(reason)); return false; }
    finally { acting.current = false; setBusy(false); }
  };
  const clone = () => onNew({ workspaceId: page?.workspaceId, profileId: page?.profileId, url: page?.url });
  if (!browser.available) return <div className="browser-unavailable"><h2>웹 탭</h2><p>공유 브라우저는 데스크톱 기본 창에서 사용할 수 있습니다. 기본 창에서 이 웹 탭을 열어 주세요.</p></div>;
  const pageMain = <section className="browser-view" aria-label="공유 웹 탭" data-hosted={hosted ? "" : undefined}>
    <div className="browser-toolbar">
      {hosted?.over ? <button type="button" className="ghost-button browser-back" title="대화로 돌아가기 · 웹 페이지는 탭으로 남습니다" onClick={hosted.onClose}><Icon name="arrowLeft" size={15} /> 대화{hosted.back ? ` · ${hosted.back}` : ""}</button> : null}
      <div className="browser-navigation" role="group" aria-label="페이지 이동">
        <IconButton icon="arrowLeft" label="이전 페이지" disabled={!ready || busy || !!pending} onClick={() => void run(() => navigate("back"))} />
        <IconButton icon="arrowRight" label="다음 페이지" disabled={!ready || busy || !!pending} onClick={() => void run(() => navigate("forward"))} />
        <IconButton icon={page?.native?.loading ? "x" : "refresh"} label={page?.native?.loading ? "중지" : "새로고침"} disabled={!ready || busy || !!pending} onClick={() => void run(() => navigate(page?.native?.loading ? "stop" : "reload"))} />
      </div>
      <form onSubmit={event => { event.preventDefault(); void run(async () => { await humanAction({ kind: "navigate", url: browserUrl(address) }); editingAddress.current = false; }); }}>
        <input aria-label="현재 웹 주소" type="text" inputMode="url" spellCheck={false} autoCapitalize="none" placeholder="검색 또는 주소 입력" value={blank && address === "about:blank" ? "" : address} disabled={!ready || busy || !!pending} onFocus={() => { editingAddress.current = true; }} onBlur={() => { editingAddress.current = false; }} onChange={event => setAddress(event.target.value)} />
        <button type="submit" className="browser-address-go hig-icon-button" aria-label="이동" title="이동" disabled={!ready || busy || !!pending}><Icon name="arrowRight" size={16} /></button>
      </form>
      {!blank ? <>
      {hosted ? null : <button ref={aiButton} type="button" className="hk-btn hk-btn--tinted browser-ask" aria-expanded={aiOpen} disabled={!ready || busy} title="이 페이지의 AI와 나누는 대화를 페이지 옆에 엽니다" onClick={() => aiOpen ? setAiOpen(false) : void run(ask)}><Icon name="chat" size={16} />AI에게 요청</button>}
      <div className="anchor browser-more">
        <IconButton icon="dots" label="웹 탭 메뉴" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)} />
        <Popover open={moreOpen} onClose={() => setMoreOpen(false)} align="right" label="웹 탭 메뉴">
          <MenuItem onSelect={() => { setMoreOpen(false); setToolsOpen(true); }}>다운로드·권한{page?.native?.permissions?.some(request => request.status === "pending") ? " · 결정 대기" : ""}</MenuItem>
          <MenuItem onSelect={() => { setMoreOpen(false); clone(); }}>프로필과 웹 탭 설정…</MenuItem>
          <MenuItem onSelect={() => { setMoreOpen(false); void run(async () => { await browser.close(pageId); onClosed(); }); }}>웹 탭 닫기</MenuItem>
        </Popover>
      </div>
      </> : null}
      {hosted ? <>
        <IconButton icon="openNew" label="탭으로 넓게 열기" onClick={hosted.onWide} />
        {/* The page is not closed by this: it stays listed as a tab behind the conversation. */}
        {hosted.over ? null : <IconButton icon="x" label="곁 화면 닫기" title="곁 화면 닫기 · 웹 페이지는 탭으로 남습니다" onClick={hosted.onClose} />}
      </> : null}
    </div>
    {error || data.error || page?.error ? <p role="alert" className="browser-error">{error || data.error || page?.error}</p> : null}
    {pending ? <div className="browser-pending" role="status">앞선 동작 결과 확인 중 <button type="button" className="button small" disabled={busy} onClick={() => void run(async () => { const result = await browser.reconcile(pageId); if (!result) throw new Error("아직 실행 결과를 기다리고 있습니다."); if (result.error) throw new Error(result.error); })}>결과 다시 확인</button>{pending.status === "unknown" ? <button type="button" className="ghost-button small" disabled={busy} onClick={() => { browser.dismissPending(pageId); setError("결과 확인을 끝냈습니다. 이전 동작을 다시 실행하지 않았습니다."); }}>페이지를 직접 확인했어요</button> : null}</div> : null}
    {page?.native?.popups.length ? <div className="browser-popups"><span>차단된 새 창</span>{page.native.popups.map(popup => <button type="button" className="text-button" key={popup.id} title={popup.url} onClick={() => onNew({ workspaceId: page.workspaceId, profileId: page.profileId, url: popup.url })}>{popup.url} · 새 탭으로 열기</button>)}</div> : null}
    <div className="browser-content">
      <div ref={viewport} className="browser-viewport" aria-label="웹 페이지 표시 영역">
        {ready && blank ? <div className="browser-blank"><h2>새 웹 탭</h2><BrowseStart autoFocus={visible} disabled={busy || !!pending} onSearch={async input => {
          let opened = false; await run(async () => { await humanAction({ kind: "navigate", url: browserUrl(input) }); opened = true; }); return opened;
        }}>
          <EngineTabs value={askEngine} onChange={provider => { setAskEngine(provider); setAskChoice({ model: null, effort: null }); }} />
          <Composer provider={askEngine} draftKey={`browser-start:${pageId}`} placeholder="새 작업의 첫 요청을 입력하세요" busy={false} disabled={!onStart || busy || !!pending} autoFocus onSend={(text) => onStart ? onStart(text, askEngine, askChoice) : Promise.resolve(false)} target={<ModelPicker models={state.providers[askEngine]?.models ?? []} value={askChoice} onChange={setAskChoice} onRefresh={() => api.refreshProviders(askEngine)} />} />
        </BrowseStart></div> : null}
        {!ready ? <div className="browser-unavailable" role="status"><h2>{connecting || !data.connected ? "웹 탭을 다시 연결하고 있습니다" : "웹 탭을 연결하지 못했습니다"}</h2><p>{page?.url && page.url !== "about:blank" ? page.url : "저장된 페이지를 불러옵니다."}</p>{!connecting && data.connected ? <button type="button" className="button" onClick={() => void reconnect()}>다시 연결</button> : null}</div> : null}
      </div>
    </div>
    {toolsOpen && page ? <BrowserTools browser={browser} api={api} page={page} ready={Boolean(ready)} onOpenArtifact={actions.openArtifact} onClose={() => setToolsOpen(false)} /> : null}
  </section>;

  // A conversation's companion: the page alone (the conversation beside it has the input).
  if (hosted) return pageMain;

  const closeColumn = () => { setAiOpen(false); aiButton.current?.focus(); };
  const blocked = !ready || busy || !!pending;
  // The page's AI as a conversation column: its head names it, its input sits under its transcript.
  let input: ReactNode = null;
  if (session && archived) {
    // The gateway takes nothing for an archived conversation: one line where the input was, with its way out.
    input = <>
      <QueuedList session={session} busy={false} actions={actions.queued} readOnly />
      <NoteBanner action={{ label: "되돌리기", run: () => actions.restore({ kind: "session", id: session.id }) }}>
        보관한 대화입니다. 읽기만 할 수 있습니다.{readDraft(`browser:${pageId}:${session.id}`).trim() ? " 쓰던 요청은 그대로 두었습니다. 되돌리면 입력창에 다시 나옵니다." : null}
      </NoteBanner>
    </>;
  } else if (session) {
    input = <>
      <QueuedList session={session} busy={isBusy(session)} actions={{
        // The AI is given the page before a waiting request goes to it.
        send: (target, queuedId) => void run(async () => { await browser.control(pageId, target.id); actions.queued.send(target, queuedId); }),
        edit: actions.queued.edit, cancel: actions.queued.cancel,
      }} />
      <Composer provider={session.provider} draftKey={`browser:${pageId}:${session.id}`} voiceScope={{ workId: session.workId, sessionId: session.id }} voiceReply={transcript?.items.filter(item => item.kind === "assistant" && !item.streaming).map(item => item.kind === "assistant" ? item.text : "").at(-1)} placeholder="이 웹 페이지에서 할 일을 입력하세요" busy={isBusy(session)} waiting={turnRunning(session)} disabled={blocked} steerable={session.provider === "codex"} onSend={send} onStop={() => actions.interrupt(session)}
        target={<span className="composer-group" inert={blocked}>
          <ModelPicker key={session.id} models={state.providers[session.provider]?.models ?? []} value={{ model: session.model, effort: session.effort }} onRefresh={() => api.refreshProviders(session.provider)}
            onChange={choice => void run(async () => { setCreatedSession(await api.updateSession(session.id, choice)); })} />
          <Select className="plain agent-engine" label="이 대화의 AI 엔진" value={session.provider} disabled={isBusy(session) || session.queued.length > 0} side="top"
            icon={<EngineMark provider={session.provider} size={14} />} options={ENGINES}
            title={isBusy(session) || session.queued.length > 0 ? "응답과 대기 요청을 마치거나 멈춘 뒤 엔진을 바꿀 수 있습니다." : "엔진별 대화가 유지됩니다. 다른 엔진을 선택하면 해당 엔진의 대화가 열립니다."}
            onChange={provider => void run(async () => {
              const draft = readDraft(`browser:${pageId}:${session.id}`);
              const next = await browser.session(pageId, session.pageAgent?.parentSessionId ?? parentSessionId, provider);
              if (draft && !readDraft(`browser:${pageId}:${next.id}`)) writeDraft(`browser:${pageId}:${next.id}`, draft);
              setCreatedSession(next);
            })} />
        </span>} />
    </>;
  }
  const column = columnOpen ? (
    <AgentColumn state={state} session={session ?? null} kind="web" name={page?.title || "웹 페이지"} inputClass="browser-composer" waiting="대화를 준비하고 있습니다." readOnly={archived}
      onClose={closeColumn} onMenu={onSessionMenu} onOpenParent={onOpenSession} onAnswer={(answered, id, decision) => actions.answer(answered, id, decision)}
      focusItem={focusItem?.sessionId === session?.id ? focusItem : null} onFocusDone={onFocusDone}>
      {input}
    </AgentColumn>
  ) : null;
  return <Beside chat={column} content={pageMain} over="chat" ratio={columnRatio} onRatio={setColumnRatio} resetRatio={0.38} chatLabel="웹 AI 대화" contentLabel="웹 페이지" onDismiss={closeColumn} />;
}
