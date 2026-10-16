import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { Provider, Session, Work } from "@workbench/contracts";
import { Api, ApiRequestError, readToken } from "./api.ts";
import { initialState, reducer, sessionsOf } from "./state.ts";
import { newRequestId, titleFrom } from "./format.ts";
import { Connections } from "./components/Connections.tsx";
import { EditableText } from "./components/EditableText.tsx";
import { Finder } from "./components/Finder.tsx";
import { Icon } from "./components/Icon.tsx";
import { Popover } from "./components/Popover.tsx";
import { StartView } from "./components/StartView.tsx";
import { WorkView, type WorkActions } from "./components/WorkView.tsx";

const LAST_WORK_KEY = "workbench.lastWork";
const inDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function pickFolderNative(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title: "작업 폴더 선택" });
  return typeof picked === "string" ? picked : null;
}

async function openExternal(url: string) {
  if (inDesktop) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

type View = { kind: "work" } | { kind: "finder" } | { kind: "new"; folderId: string | null };

export function App() {
  const api = useMemo(() => {
    const token = readToken();
    return token ? new Api(token) : null;
  }, []);
  const [state, dispatch] = useReducer(reducer, initialState);
  const [workId, setWorkIdState] = useState<string | null>(() => localStorage.getItem(LAST_WORK_KEY));
  const [view, setView] = useState<View>({ kind: "work" });
  const [toast, setToast] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loginMessage, setLoginMessage] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  const setWorkId = (id: string | null) => {
    setWorkIdState(id);
    if (id) localStorage.setItem(LAST_WORK_KEY, id);
  };

  const fail = useCallback((error: unknown) => {
    setToast(error instanceof ApiRequestError || error instanceof Error ? error.message : String(error));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Snapshot, then live events; a resync reloads the snapshot.
  useEffect(() => {
    if (!api) return;
    let stop = () => {};
    let cancelled = false;
    const load = async () => {
      try {
        const snapshot = await api.snapshot();
        if (cancelled) return;
        dispatch({ type: "snapshot", snapshot });
        stop();
        stop = api.events(
          snapshot.seq,
          (event) => dispatch({ type: "event", event }),
          () => void load(),
          (connected) => dispatch({ type: "connected", connected }),
        );
      } catch (error) {
        fail(error);
        window.setTimeout(() => void load(), 2000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      stop();
    };
  }, [api, fail]);

  const work = workId ? state.works[workId] : undefined;
  const activeSession =
    work && ((work.activeSessionId && state.sessions[work.activeSessionId]) || sessionsOf(state, work.id).at(-1));

  // Load the transcript of the visible session once.
  useEffect(() => {
    if (!api || !activeSession || state.transcripts[activeSession.id]) return;
    let cancelled = false;
    api
      .items(activeSession.id)
      .then((result) => !cancelled && dispatch({ type: "transcript", sessionId: activeSession.id, transcript: result }))
      .catch(fail);
    return () => {
      cancelled = true;
    };
  }, [api, activeSession, state.transcripts, fail]);

  const actions: WorkActions = useMemo(
    () => ({
      send: async (session: Session, text: string) => {
        if (!api) return false;
        try {
          await api.send(session.id, newRequestId(), text);
          return true;
        } catch (error) {
          fail(error);
          return false;
        }
      },
      interrupt: (session) => void api?.interrupt(session.id).catch(fail),
      answer: (session, itemId, decision) => void api?.answer(session.id, itemId, decision).catch(fail),
      newSession: async (target: Work, provider: Provider) => {
        if (!api) return null;
        try {
          return await api.createSession(target.id, provider);
        } catch (error) {
          fail(error);
          return null;
        }
      },
      selectSession: (target, session) => {
        setWorkId(target.id);
        setView({ kind: "work" });
        if (target.activeSessionId !== session.id) void api?.updateWork(target.id, { activeSessionId: session.id }).catch(fail);
      },
      renameSession: (session, purpose) => void api?.renameSession(session.id, purpose).catch(fail),
      moveWork: (target, folderId) => void api?.updateWork(target.id, { folderId }).catch(fail),
      openFinder: () => setView({ kind: "finder" }),
    }),
    [api, fail],
  );

  const startWork = async (text: string, provider: Provider, cwd: string | null, folderId: string | null) => {
    if (!api) return false;
    try {
      const created = await api.createWork(titleFrom(text), folderId, cwd);
      const session = await api.createSession(created.id, provider);
      setWorkId(created.id);
      setView({ kind: "work" });
      await api.send(session.id, newRequestId(), text);
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };

  const pendingApprovals = Object.values(state.sessions).filter((session) => session.status === "awaitingApproval");

  if (!api) {
    return (
      <div className="fatal">
        <h1>Achmage Workbench</h1>
        <p>앱 내부 연결 정보가 없습니다. 데스크톱 앱에서 다시 열어 주세요.</p>
      </div>
    );
  }

  const showStart = view.kind === "new" || (view.kind === "work" && !work);
  const title = view.kind === "finder" ? work?.title ?? "" : showStart ? "새 작업" : work?.title ?? "";

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <span className="brand">Achmage</span>
          <button
            type="button"
            className={`ghost-button${view.kind === "finder" ? " pressed" : ""}`}
            onClick={() => setView(view.kind === "finder" ? { kind: "work" } : { kind: "finder" })}
            aria-expanded={view.kind === "finder"}
          >
            작업 <Icon name={view.kind === "finder" ? "chevronUp" : "chevronDown"} size={14} />
          </button>
          <button
            type="button"
            className={`ghost-button${showStart ? " pressed" : ""}`}
            onClick={() => {
              setView({ kind: "new", folderId: null });
              // Already on the start screen: make the click visibly do something.
              window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus());
            }}
            title="새 작업"
          >
            <Icon name="plus" size={15} /> 새 작업
          </button>
        </div>
        {editingTitle && work && view.kind === "work" ? (
          <EditableText
            className="topbar-title-edit"
            value={work.title}
            onSave={(next) => void api.updateWork(work.id, { title: next }).catch(fail)}
            onDone={() => setEditingTitle(false)}
          />
        ) : (
          <button
            type="button"
            className="topbar-title"
            title={work && view.kind === "work" && !showStart ? "눌러서 작업 이름 바꾸기" : title}
            onClick={() => work && view.kind === "work" && !showStart && setEditingTitle(true)}
          >
            {title}
          </button>
        )}
        <div className="topbar-right">
          {pendingApprovals.length ? (
            <button
              type="button"
              className="attention-button"
              onClick={() => {
                const session = pendingApprovals[0];
                const target = state.works[session.workId];
                if (target) actions.selectSession(target, session);
              }}
            >
              <span className="dot dot-attention" /> 확인 {pendingApprovals.length}
            </button>
          ) : null}
          {!state.connected && state.ready ? <span className="offline">연결 끊김</span> : null}
          <div className="anchor">
            <button type="button" className="icon-button" onClick={() => setMenuOpen(!menuOpen)} aria-label="연결과 설정" aria-expanded={menuOpen}>
              <Icon name="dots" size={18} />
            </button>
            <Popover open={menuOpen} onClose={closeMenu} align="right">
              <Connections
                providers={state.providers}
                connected={state.connected}
                hostLabel={state.hostLabel}
                loginMessage={loginMessage}
                onRefresh={() => void api.refreshProviders().catch(fail)}
                onLogin={(provider) =>
                  void api
                    .login(provider)
                    .then((result) => {
                      setLoginMessage(result.message);
                      if (result.url) void openExternal(result.url);
                    })
                    .catch(fail)
                }
              />
            </Popover>
          </div>
        </div>
      </header>

      {!state.ready ? (
        <main className="loading">불러오는 중…</main>
      ) : view.kind === "finder" ? (
        <Finder
          state={state}
          currentWorkId={work?.id ?? null}
          onOpenWork={(target) => {
            setWorkId(target.id);
            setView({ kind: "work" });
          }}
          onOpenSession={actions.selectSession}
          onNewWork={(folderId) => setView({ kind: "new", folderId })}
          onCreateFolder={async (name, parentId) => {
            await api.createFolder(name, parentId).catch(fail);
          }}
          onBack={work ? () => setView({ kind: "work" }) : null}
        />
      ) : showStart ? (
        <StartView
          state={state}
          folderId={view.kind === "new" ? view.folderId : null}
          onClearFolder={() => setView({ kind: "new", folderId: null })}
          onStart={(text, provider, cwd) => startWork(text, provider, cwd, view.kind === "new" ? view.folderId : null)}
          onOpenWork={(target) => {
            setWorkId(target.id);
            setView({ kind: "work" });
          }}
          pickFolder={inDesktop ? pickFolderNative : null}
        />
      ) : work ? (
        <WorkView state={state} work={work} actions={actions} />
      ) : null}

      {toast ? (
        <div className="toast" role="status" onClick={() => setToast(null)}>
          {toast}
        </div>
      ) : null}
    </div>
  );
}
