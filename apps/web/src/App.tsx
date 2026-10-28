import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CreateTarget, DocRef, Proposal, Provider, Session, UiPrefs, Work } from "@workbench/contracts";
import { Api, ApiRequestError, readToken } from "./api.ts";
import { configureDesign } from "./design.ts";
import { initialState, reducer, sessionsOf } from "./state.ts";
import { newRequestId, titleFrom } from "./format.ts";
import { Connections } from "./components/Connections.tsx";
import { EditableText } from "./components/EditableText.tsx";
import { Finder } from "./components/Finder.tsx";
import { Icon } from "./components/Icon.tsx";
import { Popover } from "./components/Popover.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import type { TreeActions } from "./components/WorkTree.tsx";
import { StartView, useEngineChoice } from "./components/StartView.tsx";
import { WorkView, type WorkActions } from "./components/WorkView.tsx";
import { AppearanceSheet, type SheetTarget } from "./components/AppearanceSheet.tsx";
import { EngineMenu } from "./components/EngineMenu.tsx";
import { Overview, Switcher, UnseenContext } from "./components/Overview.tsx";
import { DocContext, type DocActions } from "./components/DocCards.tsx";
import { DocTabs } from "./components/DocTabs.tsx";
import { SessionPicker } from "./components/SessionPicker.tsx";

// Editors (CodeMirror, PDF.js) load only when a document opens.
const DocumentView = lazy(() => import("./components/docs/DocumentView.tsx"));
import { AppearanceContext, DEFAULT_APPEARANCE, engineTheme, lookStyle, readAppearance, type AppearanceApi } from "./appearance.ts";
import { isThemePref, resolveTheme, setRootTheme, useSystemTheme, type ThemePref } from "./theme.ts";

const LAST_WORK_KEY = "workbench.lastWork";
const PREFS_CACHE_KEY = "workbench.prefsCache";

function cachedPrefs(): UiPrefs {
  try {
    return JSON.parse(localStorage.getItem(PREFS_CACHE_KEY) ?? "{}") as UiPrefs;
  } catch {
    return {};
  }
}
const inDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function pickFolderNative(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title: "작업 폴더 선택" });
  return typeof picked === "string" ? picked : null;
}

async function pickFileNative(folder: string): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    directory: false,
    multiple: false,
    defaultPath: folder,
    title: "문서 열기",
    filters: [{ name: "문서", extensions: ["md", "markdown", "html", "htm", "pdf", "hwpx", "hwp", "txt"] }],
  });
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

type View =
  | { kind: "work" }
  | { kind: "finder" }
  | { kind: "new"; folderId: string | null }
  | { kind: "overview"; workId: string | null }
  | { kind: "document"; artifactId: string; proposalId: string | null };

const SEEN_KEY = "workbench.seen";
const OPEN_DOCS_KEY = "workbench.openDocs";
const MRU_KEY = "workbench.recentSessions";
const readJson = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

export function App() {
  const api = useMemo(() => {
    const token = readToken();
    if (token) configureDesign(token);
    return token ? new Api(token) : null;
  }, []);
  const [state, dispatch] = useReducer(reducer, initialState);
  const [workId, setWorkIdState] = useState<string | null>(() => localStorage.getItem(LAST_WORK_KEY));
  const [view, setView] = useState<View>({ kind: "work" });
  // Documents opened in each work, shown as tabs and offered first by "@".
  const [openDocs, setOpenDocs] = useState<Record<string, string[]>>(() => readJson(OPEN_DOCS_KEY, {}));
  const [toast, setToast] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loginMessage, setLoginMessage] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [engine, setEngine] = useEngineChoice();
  const [engineMenu, setEngineMenu] = useState<{ provider: Provider; x: number; y: number } | null>(null);
  const [sheet, setSheet] = useState<SheetTarget | null>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const closeEngineMenu = useCallback(() => setEngineMenu(null), []);

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

  // Screen preferences: kept by the gateway, edited optimistically, cached for the first frame.
  const [localPrefs, setLocalPrefs] = useState<UiPrefs | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const latestSave = useRef<UiPrefs | null>(null);
  const prefs = localPrefs ?? (state.ready ? state.prefs : cachedPrefs());
  useEffect(() => {
    if (state.ready) localStorage.setItem(PREFS_CACHE_KEY, JSON.stringify(state.prefs));
  }, [state.ready, state.prefs]);
  const savePrefs = useCallback(
    (patch: UiPrefs) => {
      setLocalPrefs((current) => {
        const next = { ...(current ?? state.prefs), ...patch };
        latestSave.current = next;
        window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => {
          void api
            ?.savePrefs(next)
            .then((saved) => {
              dispatch({ type: "prefs", prefs: saved.prefs });
              if (latestSave.current === next) setLocalPrefs(null);
            })
            .catch(fail);
        }, 250);
        return next;
      });
    },
    [api, fail, state.prefs],
  );

  const systemTheme = useSystemTheme();
  const themePref: ThemePref = isThemePref(prefs.theme) ? prefs.theme : "system";
  const appTheme = resolveTheme(themePref, systemTheme);
  const appearance = useMemo(() => readAppearance(prefs.appearance), [prefs.appearance]);
  // Closed by default (PRD 2.1); remembered once the user pins it.
  const sidebarOpen = prefs.sidebar === true;
  const toggleSidebar = () => savePrefs({ sidebar: !sidebarOpen });

  const work = workId ? state.works[workId] : undefined;
  const activeSession =
    work && ((work.activeSessionId && state.sessions[work.activeSessionId]) || sessionsOf(state, work.id).at(-1));

  // A document shown becomes a tab of its work (at most 8, the oldest goes).
  useEffect(() => {
    if (view.kind !== "document") return;
    const artifact = state.artifacts[view.artifactId];
    if (!artifact) return;
    setOpenDocs((current) => {
      const list = current[artifact.workId] ?? [];
      return list.includes(artifact.id) ? current : { ...current, [artifact.workId]: [...list, artifact.id].slice(-8) };
    });
  }, [view, state.artifacts]);
  useEffect(() => localStorage.setItem(OPEN_DOCS_KEY, JSON.stringify(openDocs)), [openDocs]);
  const openDocIds = work ? (openDocs[work.id] ?? []).filter((id) => state.artifacts[id]) : [];
  const closeDoc = (artifactId: string) => {
    if (!work) return;
    const rest = openDocIds.filter((id) => id !== artifactId);
    setOpenDocs((current) => ({ ...current, [work.id]: rest }));
    if (view.kind === "document" && view.artifactId === artifactId) {
      setView(rest.length ? { kind: "document", artifactId: rest[rest.length - 1], proposalId: null } : { kind: "work" });
    }
  };

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

  // "어느 세션에 보낼까요?" picker, answered through a promise.
  const [picker, setPicker] = useState<{ workId: string; excludeSessionId: string | null; resolve: (session: Session | null) => void } | null>(null);

  const actions: WorkActions = useMemo(
    () => ({
      send: async (session: Session, text: string, refs: DocRef[] = [], create: CreateTarget | null = null) => {
        if (!api) return false;
        try {
          await api.send(session.id, newRequestId(), text, refs, create);
          return true;
        } catch (error) {
          fail(error);
          return false;
        }
      },
      handoff: async (source: Session, target: Session, text: string, refs: DocRef[] = []) => {
        if (!api) return false;
        try {
          await api.handoff({ requestId: newRequestId(), sourceSessionId: source.id, targetSessionId: target.id, text, refs });
          return true;
        } catch (error) {
          fail(error);
          return false;
        }
      },
      pickSession: (work: Work, exclude: Session | null) =>
        new Promise<Session | null>((resolve) => setPicker({ workId: work.id, excludeSessionId: exclude?.id ?? null, resolve })),
      openArtifact: (artifactId: string) => setView({ kind: "document", artifactId, proposalId: null }),
      openFile: async (target: Work, path: string) => {
        if (!api) return;
        try {
          const artifact = await api.openFile(target.id, path);
          setView({ kind: "document", artifactId: artifact.id, proposalId: null });
        } catch (error) {
          fail(error);
        }
      },
      newDesign: async (target: Work, preset: string) => {
        if (!api) return;
        try {
          const artifact = await api.createDesign(target.id, "새 디자인", preset);
          setView({ kind: "document", artifactId: artifact.id, proposalId: null });
        } catch (error) {
          fail(error);
        }
      },
      interrupt: (session) => void api?.interrupt(session.id).catch(fail),
      answer: (session, itemId, decision) => void api?.answer(session.id, itemId, decision).catch(fail),
      newSession: async (target: Work, provider: Provider, choice) => {
        if (!api) return null;
        try {
          return await api.createSession(target.id, provider, { model: choice?.model ?? null, effort: choice?.effort ?? null });
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
      renameSession: (session, purpose) => void api?.updateSession(session.id, { purpose }).catch(fail),
      setModel: (session, choice) => void api?.updateSession(session.id, { model: choice.model, effort: choice.effort }).catch(fail),
      moveWork: (target, folderId) => void api?.updateWork(target.id, { folderId }).catch(fail),
      openFinder: () => setView({ kind: "finder" }),
      openOverview: (target) => setView({ kind: "overview", workId: target?.id ?? null }),
    }),
    [api, fail],
  );

  const docActions: DocActions = useMemo(
    () => ({
      openArtifact: (artifactId, proposalId) => {
        const artifact = state.artifacts[artifactId];
        if (artifact) setWorkId(artifact.workId);
        setView({ kind: "document", artifactId, proposalId: proposalId ?? null });
      },
      applyProposal: (proposal: Proposal) =>
        void api
          ?.applyProposal(proposal.id)
          .then((result) => setToast(`수정안을 적용했습니다 → ${result.artifact.name} r${result.artifact.revision}`))
          .catch(fail),
      discardProposal: (proposal: Proposal) => void api?.discardProposal(proposal.id).catch(fail),
      retryProposal: async (proposal: Proposal) => {
        if (!api) return;
        const session = state.sessions[proposal.sessionId];
        const artifact = state.artifacts[proposal.artifactId];
        if (!session || !artifact) return;
        try {
          // The same request again, on the latest revision; the old proposal is set aside.
          const { items } = await api.items(session.id);
          const original = items.find((item) => item.kind === "user" && item.id === `user:${proposal.requestId}`);
          const text = original && original.kind === "user" ? original.text : `${artifact.name}을(를) 최신 판 기준으로 다시 고쳐 주세요.`;
          await api.discardProposal(proposal.id);
          await api.send(session.id, newRequestId(), text, [{ artifactId: artifact.id, revision: artifact.revision, mode: "edit", selection: null }]);
          setToast(`r${artifact.revision} 기준으로 다시 요청했습니다.`);
        } catch (error) {
          fail(error);
        }
      },
      openSession: (sessionId: string) => {
        const session = state.sessions[sessionId];
        const target = session ? state.works[session.workId] : undefined;
        if (session && target) actions.selectSession(target, session);
      },
    }),
    [api, fail, state.artifacts, state.sessions, state.works, actions],
  );

  const startWork = async (
    text: string,
    provider: Provider,
    cwd: string | null,
    folderId: string | null,
    choice: { model: string | null; effort: string | null },
  ) => {
    if (!api) return false;
    try {
      const created = await api.createWork(titleFrom(text), folderId, cwd);
      const session = await api.createSession(created.id, provider, choice);
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
  const runningCount = Object.values(state.sessions).filter((session) => session.status === "starting" || session.status === "running").length;

  // What the user has looked at: replies arriving in sessions not on screen are marked new.
  const visibleSession = view.kind === "work" && activeSession ? activeSession : null;
  const [seen, setSeen] = useState<Record<string, number> | null>(() => readJson<Record<string, number> | null>(SEEN_KEY, null));
  useEffect(() => {
    if (!state.ready) return;
    if (seen === null) {
      // First run: everything already there counts as seen.
      const initial = Object.fromEntries(Object.values(state.sessions).map((session) => [session.id, session.previewAt ?? 0]));
      setSeen(initial);
      localStorage.setItem(SEEN_KEY, JSON.stringify(initial));
      return;
    }
    if (visibleSession?.previewAt && visibleSession.previewAt > (seen[visibleSession.id] ?? 0)) {
      const next = { ...seen, [visibleSession.id]: visibleSession.previewAt };
      setSeen(next);
      localStorage.setItem(SEEN_KEY, JSON.stringify(next));
    }
  }, [state.ready, state.sessions, seen, visibleSession]);
  const unseen = useMemo(
    () =>
      new Set(
        Object.values(state.sessions)
          .filter((session) => seen && session.previewAt && session.previewAt > (seen[session.id] ?? 0) && session.id !== visibleSession?.id)
          .map((session) => session.id),
      ),
    [state.sessions, seen, visibleSession],
  );

  // Sessions in the order they were last looked at, for Ctrl+Tab.
  const [recent, setRecent] = useState<string[]>(() => readJson<string[]>(MRU_KEY, []));
  useEffect(() => {
    if (!visibleSession) return;
    setRecent((list) => {
      if (list[0] === visibleSession.id) return list;
      const next = [visibleSession.id, ...list.filter((id) => id !== visibleSession.id)].slice(0, 24);
      localStorage.setItem(MRU_KEY, JSON.stringify(next));
      return next;
    });
  }, [visibleSession?.id]);
  const switchable = recent.map((id) => state.sessions[id]).filter((session): session is Session => Boolean(session)).slice(0, 8);
  const [switcher, setSwitcher] = useState<number | null>(null);
  const switcherRef = useRef<number | null>(null);
  const openSession = useCallback(
    (session: Session) => {
      const target = state.works[session.workId];
      if (target) actions.selectSession(target, session);
    },
    [state.works, actions],
  );
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === "Tab") {
        event.preventDefault();
        if (switchable.length < 2) return;
        const count = switchable.length;
        const step = event.shiftKey ? -1 : 1;
        const current = switcherRef.current;
        const next = current === null ? (step === 1 ? 1 : count - 1) : (current + step + count) % count;
        switcherRef.current = next;
        setSwitcher(next);
      } else if (event.ctrlKey && (event.key === "k" || event.key === "K")) {
        event.preventDefault();
        setView((current) => (current.kind === "overview" ? { kind: "work" } : { kind: "overview", workId: null }));
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Control" || switcherRef.current === null) return;
      const target = switchable[switcherRef.current];
      switcherRef.current = null;
      setSwitcher(null);
      if (target) openSession(target);
    };
    const onBlur = () => {
      switcherRef.current = null;
      setSwitcher(null);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [switchable, openSession]);

  // The engine in focus dresses the window: the visible session's engine, else the engine picked
  // for a new request. While the appearance sheet is open, the look being edited is shown instead.
  const startScreen = view.kind === "new" || (view.kind === "work" && !work);
  const focusedProvider: Provider = sheet?.provider ?? (!startScreen && activeSession ? activeSession.provider : engine);
  const focusedTheme = sheet?.theme ?? engineTheme(appearance[focusedProvider], appTheme);
  const focusedLook = appearance[focusedProvider][focusedTheme];
  useEffect(() => setRootTheme(focusedTheme), [focusedTheme]);

  const appearanceApi: AppearanceApi = {
    appearance,
    appTheme,
    themeOf: (provider) => engineTheme(appearance[provider], appTheme),
    lookOf: (provider) => appearance[provider][engineTheme(appearance[provider], appTheme)],
    updateLook: (provider, theme, patch) => {
      const current = appearance[provider][theme];
      const next = { ...current, ...patch, palette: { ...current.palette, ...(patch.palette ?? {}) } };
      savePrefs({ appearance: { ...appearance, [provider]: { ...appearance[provider], [theme]: next } } });
    },
    setMode: (provider, mode) => savePrefs({ appearance: { ...appearance, [provider]: { ...appearance[provider], mode } } }),
    resetLook: (provider, theme) =>
      savePrefs({ appearance: { ...appearance, [provider]: { ...appearance[provider], [theme]: DEFAULT_APPEARANCE[provider][theme] } } }),
    openMenu: (event, provider) => {
      // Text fields and selected text keep the system menu (copy, paste).
      const target = event.target as HTMLElement;
      if (target.closest("textarea, input, a, [contenteditable=true]") || window.getSelection()?.toString()) return;
      event.preventDefault();
      event.stopPropagation();
      setEngineMenu({ provider, x: event.clientX, y: event.clientY });
    },
    openSettings: (provider, theme) => {
      const target = provider ?? focusedProvider;
      setSheet({ provider: target, theme: theme ?? engineTheme(appearance[target], appTheme) });
    },
  };

  const treeActions: TreeActions = {
    onOpenWork: (target) => {
      setWorkId(target.id);
      setView({ kind: "work" });
    },
    onOpenSession: actions.selectSession,
    onNewWork: (folderId) => {
      setView({ kind: "new", folderId });
      window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus());
    },
    onCreateFolder: async (name, parentId) => {
      await api?.createFolder(name, parentId).catch(fail);
    },
  };

  if (!api) {
    return (
      <div className="fatal">
        <h1>Achmage Workbench</h1>
        <p>앱 내부 연결 정보가 없습니다. 데스크톱 앱에서 다시 열어 주세요.</p>
      </div>
    );
  }

  const showStart = startScreen;
  const tabs = work ? (
    <DocTabs
      state={state}
      ids={openDocIds}
      activeId={view.kind === "document" ? view.artifactId : null}
      onConversation={() => setView({ kind: "work" })}
      onOpen={(artifactId) => setView({ kind: "document", artifactId, proposalId: null })}
      onClose={closeDoc}
    />
  ) : null;
  const title = view.kind === "finder" ? work?.title ?? "" : showStart ? "새 작업" : work?.title ?? "";

  return (
    <AppearanceContext.Provider value={appearanceApi}>
    <UnseenContext.Provider value={unseen}>
    <DocContext.Provider value={{ state, actions: docActions }}>
    <div
      className="app look-scope"
      data-theme={focusedTheme}
      data-bubble={focusedLook.bubble}
      data-frame={focusedLook.frame ? "on" : "off"}
      style={lookStyle(focusedLook)}
    >
      <header className="topbar">
        <div className="topbar-left">
          <button
            type="button"
            className={`icon-button${sidebarOpen ? " pressed" : ""}`}
            onClick={toggleSidebar}
            aria-label={sidebarOpen ? "사이드바 닫기" : "사이드바 열기"}
            title={sidebarOpen ? "사이드바 닫기" : "사이드바 열기"}
          >
            <Icon name="sidebar" size={18} />
          </button>
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
            className={`ghost-button overview-button${view.kind === "overview" ? " pressed" : ""}`}
            onClick={() => setView(view.kind === "overview" ? { kind: "work" } : { kind: "overview", workId: null })}
            title="한눈에 · 모든 세션 (Ctrl+K)"
          >
            <Icon name="grid" size={15} /> 한눈에
            {runningCount ? <span className="count-chip active" title="진행 중">{runningCount}</span> : null}
            {unseen.size ? <span className="count-chip new" title="새 답">{unseen.size}</span> : null}
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
          <button
            type="button"
            className="icon-button"
            onClick={() => savePrefs({ theme: focusedTheme === "dark" ? "light" : "dark" })}
            aria-label={focusedTheme === "dark" ? "라이트 화면으로" : "다크 화면으로"}
            title={focusedTheme === "dark" ? "라이트 화면으로" : "다크 화면으로"}
          >
            <Icon name={focusedTheme === "dark" ? "sun" : "moon"} size={18} />
          </button>
          <div className="anchor">
            <button type="button" className="icon-button" onClick={() => setMenuOpen(!menuOpen)} aria-label="연결과 설정" aria-expanded={menuOpen}>
              <Icon name="dots" size={18} />
            </button>
            <Popover open={menuOpen} onClose={closeMenu} align="right">
              <Connections
                tools={state.tools}
                onInstallIeum={() => void api.installIeumOffice().catch(fail)}
                onRefreshTools={() => void api.refreshTools().catch(fail)}
                providers={state.providers}
                connected={state.connected}
                hostLabel={state.hostLabel}
                loginMessage={loginMessage}
                themePref={themePref}
                onTheme={(pref) => savePrefs({ theme: pref })}
                onAppearance={() => {
                  closeMenu();
                  appearanceApi.openSettings();
                }}
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

      <div className={`body${sidebarOpen && state.ready ? " with-sidebar" : ""}`}>
      {sidebarOpen && state.ready ? <Sidebar state={state} currentWorkId={view.kind === "work" ? work?.id ?? null : null} actions={treeActions} /> : null}
      {!state.ready ? (
        <main className="loading">불러오는 중…</main>
      ) : view.kind === "document" && work ? (
        <Suspense fallback={<main className="loading">문서를 여는 중…</main>}>
          <DocumentView
            key={view.artifactId}
            api={api}
            state={state}
            artifactId={view.artifactId}
            focusProposalId={view.proposalId}
            work={work}
            session={activeSession ?? null}
            tabs={tabs}
            openDocIds={openDocIds}
            onBack={() => setView({ kind: "work" })}
            onToast={setToast}
            onOpenArtifact={(artifactId) => setView({ kind: "document", artifactId, proposalId: null })}
            onPickTarget={() => actions.pickSession(work, activeSession ?? null)}
            onSend={async (session, text, refs, handoffTo, create) => {
              let source = session;
              if (!source) source = await actions.newSession(work, engine);
              if (!source) return false;
              if (handoffTo) return actions.handoff(source, handoffTo, text, refs);
              return actions.send(source, text, refs, create);
            }}
          />
        </Suspense>
      ) : view.kind === "overview" ? (
        <Overview
          state={state}
          unseen={unseen}
          workFilter={view.workId ? state.works[view.workId] ?? null : null}
          onOpen={openSession}
          onClose={() => setView({ kind: "work" })}
        />
      ) : view.kind === "finder" ? (
        <Finder state={state} currentWorkId={work?.id ?? null} actions={treeActions} onBack={work ? () => setView({ kind: "work" }) : null} />
      ) : showStart ? (
        <StartView
          state={state}
          folderId={view.kind === "new" ? view.folderId : null}
          onClearFolder={() => setView({ kind: "new", folderId: null })}
          onStart={(text, provider, cwd, choice) => startWork(text, provider, cwd, view.kind === "new" ? view.folderId : null, choice)}
          onOpenWork={(target) => {
            setWorkId(target.id);
            setView({ kind: "work" });
          }}
          pickFolder={inDesktop ? pickFolderNative : null}
          engine={engine}
          setEngine={setEngine}
        />
      ) : work ? (
        <WorkView state={state} work={work} actions={actions} engine={engine} setEngine={setEngine} pickFile={inDesktop ? pickFileNative : null} tabs={tabs} openDocIds={openDocIds} />
      ) : null}
      </div>

      {sheet ? (
        <AppearanceSheet
          target={sheet}
          onTarget={setSheet}
          themePref={themePref}
          onThemePref={(pref) => savePrefs({ theme: pref })}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {engineMenu ? <EngineMenu provider={engineMenu.provider} x={engineMenu.x} y={engineMenu.y} onClose={closeEngineMenu} /> : null}
      {switcher !== null ? <Switcher state={state} sessions={switchable} index={switcher} unseen={unseen} /> : null}
      {picker ? (
        <SessionPicker
          state={state}
          workId={picker.workId}
          excludeSessionId={picker.excludeSessionId}
          onPick={(session) => {
            picker.resolve(session);
            setPicker(null);
          }}
          onNew={async (provider) => {
            const target = state.works[picker.workId];
            const created = target ? await actions.newSession(target, provider) : null;
            picker.resolve(created);
            setPicker(null);
          }}
          onClose={() => {
            picker.resolve(null);
            setPicker(null);
          }}
        />
      ) : null}

      {toast ? (
        <div className="toast" role="status" onClick={() => setToast(null)}>
          {toast}
        </div>
      ) : null}
    </div>
    </DocContext.Provider>
    </UnseenContext.Provider>
    </AppearanceContext.Provider>
  );
}
