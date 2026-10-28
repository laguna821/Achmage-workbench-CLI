import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { PROVIDER_LABEL, isUnseen, type AccessMode, type Artifact, type CreateTarget, type DocRef, type Proposal, type Provider, type Session, type SessionStatus, type UiPrefs, type Work } from "@workbench/contracts";
import { Api, ApiRequestError, readToken } from "./api.ts";
import { configureDesign } from "./design.ts";
import { initialState, isBusy, reducer, sessionsOf } from "./state.ts";
import { newRequestId, titleFrom } from "./format.ts";
import { folderChoices, readOpenState, workSessions, type Move, type Row, type SortMode, type TreeOpenState } from "./tree.ts";
import { Connections } from "./components/Connections.tsx";
import { EditableText } from "./components/EditableText.tsx";
import { Icon } from "./components/Icon.tsx";
import { BrandSymbol, Wordmark } from "./components/BrandMark.tsx";
import { Popover } from "./components/Popover.tsx";
import { Sidebar, type SidebarActions } from "./components/Sidebar.tsx";
import { ContextMenu, type MenuEntry, type MenuRequest } from "./components/ContextMenu.tsx";
import { SearchPalette, type PaletteCommand } from "./components/SearchPalette.tsx";
import { ArchiveView } from "./components/ArchiveView.tsx";
import { StartView, useEngineChoice } from "./components/StartView.tsx";
import { WorkView, type WorkActions } from "./components/WorkView.tsx";
import { AppearanceSheet, type SheetTarget } from "./components/AppearanceSheet.tsx";
import { EngineMenu } from "./components/EngineMenu.tsx";
import { Switcher, UnseenContext } from "./components/SessionCards.tsx";
import { DocContext, type DocActions } from "./components/DocCards.tsx";
import { DocTabs } from "./components/DocTabs.tsx";
import { IntegrationsSheet } from "./components/IntegrationsSheet.tsx";
import { Onboarding } from "./components/Onboarding.tsx";
import { SessionPicker } from "./components/SessionPicker.tsx";
import { PkmProvider } from "./components/pkm/PkmContext.tsx";
import { VaultDialogHost, VaultSettingsRow } from "./components/pkm/VaultDialog.tsx";
import { PkmCenter, pkmTitle } from "./components/pkm/PkmCenter.tsx";
import type { PkmTarget } from "./pkm.ts";

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

/** An OS notification (desktop app); the first one asks for permission where the system wants that. */
async function notify(title: string, body: string) {
  const { isPermissionGranted, requestPermission, sendNotification } = await import("@tauri-apps/plugin-notification");
  if (!(await isPermissionGranted()) && (await requestPermission()) !== "granted") return;
  sendNotification({ title, body });
}

const BUSY: SessionStatus[] = ["starting", "running", "interrupting", "awaitingApproval"];

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
    filters: [{ name: "문서", extensions: ["md", "markdown", "html", "htm", "pdf", "hwpx", "hwp", "txt", "docx", "pptx", "xlsx"] }],
  });
  return typeof picked === "string" ? picked : null;
}

/** Where to save a Markdown export (desktop save dialog); null when cancelled. */
async function pickSavePath(defaultPath: string): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ title: "마크다운으로 내보내기", defaultPath, filters: [{ name: "Markdown", extensions: ["md"] }] });
}

async function openExternal(url: string) {
  if (inDesktop) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

/** Copy text: the clipboard API, or a hidden text area where it is not allowed. */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

/** The command that resumes this conversation in a terminal (the engine's own resume). */
function resumeCommand(session: Session, work: Work) {
  if (!session.nativeSessionId) return null;
  const quoted = `'${work.cwd.replace(/'/g, `'\\''`)}'`;
  return session.provider === "claude" ? `cd ${quoted} && claude --resume ${session.nativeSessionId}` : `cd ${quoted} && codex resume ${session.nativeSessionId}`;
}

type View =
  | { kind: "work" }
  | { kind: "new"; folderId: string | null }
  | { kind: "archive" }
  | { kind: "document"; artifactId: string; proposalId: string | null }
  /** Cards of a vault folder, an app folder, a work or a saved view; or one vault note (pkm). */
  | { kind: "pkm"; target: PkmTarget };

type Toast = { text: string; action?: { label: string; run: () => void } };

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
const SORT_MODES: SortMode[] = ["manual", "recent", "name"];

export function App() {
  const api = useMemo(() => {
    const token = readToken();
    if (token) configureDesign(token);
    return token ? new Api(token) : null;
  }, []);
  const [state, dispatch] = useReducer(reducer, initialState);
  const [workId, setWorkIdState] = useState<string | null>(() => localStorage.getItem(LAST_WORK_KEY));
  // Home first, unless the user chose to open the last work straight away (and there is one).
  const [view, setViewNow] = useState<View>(() =>
    cachedPrefs().startScreen === "last" && localStorage.getItem(LAST_WORK_KEY) ? { kind: "work" } : { kind: "new", folderId: null },
  );
  const viewRef = useRef(view);
  viewRef.current = view;
  // A document view holding edits only it can save (the Word editor) saves them before it is replaced.
  const leaveGuard = useRef<(() => Promise<void>) | null>(null);
  const setLeaveGuard = useCallback((guard: (() => Promise<void>) | null) => {
    leaveGuard.current = guard;
  }, []);
  const setView = useCallback((next: View | ((current: View) => View)) => {
    const current = viewRef.current;
    const resolved = typeof next === "function" ? next(current) : next;
    const guard = leaveGuard.current;
    const leaving = current.kind === "document" && !(resolved.kind === "document" && resolved.artifactId === current.artifactId);
    if (!guard || !leaving) return setViewNow(resolved);
    void guard()
      .catch(() => undefined)
      .finally(() => setViewNow(resolved));
  }, []);
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const [onboardingAgain, setOnboardingAgain] = useState(false);
  // Documents opened in each work, shown as tabs and offered first by "@".
  const [openDocs, setOpenDocs] = useState<Record<string, string[]>>(() => readJson(OPEN_DOCS_KEY, {}));
  const [toast, setToastState] = useState<Toast | null>(null);
  const setToast = useCallback((next: string | Toast | null) => setToastState(typeof next === "string" ? { text: next } : next), []);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loginMessage, setLoginMessage] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [engine, setEngine] = useEngineChoice();
  const [engineMenu, setEngineMenu] = useState<{ provider: Provider; x: number; y: number } | null>(null);
  const [sheet, setSheet] = useState<SheetTarget | null>(null);
  const [contextMenu, setContextMenu] = useState<MenuRequest | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // A message to bring into view after opening its conversation (from search).
  const [focusItem, setFocusItem] = useState<{ sessionId: string; itemId: string; nonce: number } | null>(null);
  // Inline rename or folder creation asked from a menu, handled by the sidebar.
  const [sidebarPending, setSidebarPending] = useState<{ rename?: string; createIn?: string | null } | null>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const closeEngineMenu = useCallback(() => setEngineMenu(null), []);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const setWorkId = (id: string | null) => {
    setWorkIdState(id);
    if (id) localStorage.setItem(LAST_WORK_KEY, id);
  };

  const fail = useCallback((error: unknown) => {
    setToast(error instanceof ApiRequestError || error instanceof Error ? error.message : String(error));
  }, [setToast]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToastState(null), toast.action ? 9000 : 6000);
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
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
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
  // The sidebar is where many sessions live: open unless the user closed it (decision 2026-10-28).
  const sidebarOpen = prefs.sidebar !== false;
  const toggleSidebar = () => savePrefs({ sidebar: !sidebarOpen });
  const sidebarWidth = typeof prefs.sidebarWidth === "number" ? Math.min(480, Math.max(232, prefs.sidebarWidth)) : 288;
  const sortMode: SortMode = SORT_MODES.includes(prefs.treeSort as SortMode) ? (prefs.treeSort as SortMode) : "manual";
  const treeOpen = useMemo(() => readOpenState(prefs.tree), [prefs.tree]);

  const work = workId ? state.works[workId] : undefined;
  const activeSession =
    work && ((work.activeSessionId && state.sessions[work.activeSessionId] && !state.sessions[work.activeSessionId]!.archivedAt && state.sessions[work.activeSessionId]) || workSessions(state, work.id).at(-1) || sessionsOf(state, work.id).at(-1));

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
      setView(rest.length ? { kind: "document", artifactId: rest[rest.length - 1]!, proposalId: null } : { kind: "work" });
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
      send: async (session: Session, text: string, refs: DocRef[] = [], create: CreateTarget | null = null, mode: "auto" | "queue" = "auto") => {
        if (!api) return false;
        try {
          const result = await api.send(session.id, newRequestId(), text, refs, create, mode);
          if (result.delivery === "queued") setToast("작업이 끝나면 이어서 보냅니다. 입력창 위에서 고치거나 지울 수 있습니다.");
          return true;
        } catch (error) {
          fail(error);
          return false;
        }
      },
      queued: {
        send: (session, queuedId) => void api?.sendQueued(session.id, queuedId).catch(fail),
        edit: (session, queuedId, text) => void api?.updateQueued(session.id, queuedId, text).catch(fail),
        cancel: (session, queuedId) => void api?.cancelQueued(session.id, queuedId).catch(fail),
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
      setAccess: (session, provider, mode) => {
        // The pick is also the default for new sessions of the engine (and those left on default).
        const remembered = (prefsRef.current.access ?? {}) as Partial<Record<Provider, AccessMode>>;
        savePrefs({ access: { ...remembered, [provider]: mode } });
        if (session) void api?.updateSession(session.id, { access: mode }).catch(fail);
        if (mode === "full") setToast(`${PROVIDER_LABEL[provider]}: 이제 묻지 않고 진행합니다(전체 접근). 입력창 아래에서 다시 바꿀 수 있습니다.`);
      },
      compact: (session) =>
        void api
          ?.compact(session.id)
          .then(() => setToast("대화를 요약해 압축하는 중입니다."))
          .catch(fail),
      moveWork: (target, folderId) => void api?.updateWork(target.id, { folderId }).catch(fail),
      openSidebar: () => savePrefs({ sidebar: true }),
      restore: (target) => {
        if (!api) return;
        const request =
          target.kind === "folder" ? api.updateFolder(target.id, { archived: false }) : target.kind === "work" ? api.updateWork(target.id, { archived: false }) : api.updateSession(target.id, { archived: false });
        void request.then(() => setToast("되돌렸습니다.")).catch(fail);
      },
    }),
    [api, fail, savePrefs, setToast, setView],
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
    [api, fail, state.artifacts, state.sessions, state.works, actions, setToast, setView],
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

  const pendingApprovals = Object.values(state.sessions).filter((session) => session.status === "awaitingApproval" && !session.archivedAt);

  // New replies: kept by the gateway, so every window agrees. Looking at a session marks it seen,
  // except right after the user marked it unread while looking at it.
  const visibleSession = view.kind === "work" && activeSession ? activeSession : null;
  const keptUnread = useRef<string | null>(null);
  useEffect(() => {
    if (keptUnread.current && keptUnread.current !== visibleSession?.id) keptUnread.current = null;
  }, [visibleSession?.id]);
  const seenAsked = useRef("");
  useEffect(() => {
    if (!api || !visibleSession || !isUnseen(visibleSession) || keptUnread.current === visibleSession.id) return;
    const key = `${visibleSession.id}:${visibleSession.previewAt}:${visibleSession.unread}`;
    if (seenAsked.current === key) return;
    seenAsked.current = key;
    void api.updateSession(visibleSession.id, { seen: true }).catch(() => undefined);
  }, [api, visibleSession]);
  const unseen = useMemo(
    () => new Set(Object.values(state.sessions).filter((session) => isUnseen(session) && session.id !== visibleSession?.id && !session.archivedAt).map((session) => session.id)),
    [state.sessions, visibleSession?.id],
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
  const switchable = recent.map((id) => state.sessions[id]).filter((session): session is Session => Boolean(session && !session.archivedAt)).slice(0, 8);
  const [switcher, setSwitcher] = useState<number | null>(null);
  const switcherRef = useRef<number | null>(null);
  const openSession = useCallback(
    (session: Session) => {
      const target = state.works[session.workId];
      if (target) actions.selectSession(target, session);
    },
    [state.works, actions],
  );
  /** Notion's "+": a Markdown page in the work folder, shown in the tree and opened at once. */
  const newPage = useCallback(
    (owner: Work) => {
      if (!api) return;
      void api
        .createPage(owner.id)
        .then((artifact) => {
          const open = readOpenState(prefsRef.current.tree);
          savePrefs({
            tree: { ...open, openWorks: [...new Set([...open.openWorks, owner.id])], closedWorks: open.closedWorks.filter((id) => id !== owner.id), openDocs: [...new Set([...open.openDocs, owner.id])] },
          });
          setWorkId(owner.id);
          setView({ kind: "document", artifactId: artifact.id, proposalId: null });
        })
        .catch(fail);
    },
    [api, fail, savePrefs, setView, setWorkId],
  );
  const startNew = useCallback(
    (folderId: string | null = null) => {
      setView({ kind: "new", folderId });
      // Already on the start screen: make the press visibly do something.
      window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus());
    },
    [setView],
  );
  // While the window is behind other windows or hidden in the tray: a reply that arrived, an
  // approval that waits, a turn that failed. Only changes are told, never what was already so.
  const statuses = useRef(new Map<string, SessionStatus>());
  useEffect(() => {
    const seen = statuses.current;
    const away = !document.hasFocus() || document.hidden;
    for (const session of Object.values(state.sessions)) {
      const before = seen.get(session.id);
      seen.set(session.id, session.status);
      if (!before || before === session.status || !inDesktop || !away || prefsRef.current.notify === false) continue;
      const where = `${state.works[session.workId]?.title ?? ""} — ${session.purpose}`;
      if (session.status === "awaitingApproval") void notify(`확인이 필요합니다 · ${PROVIDER_LABEL[session.provider]}`, where).catch(() => undefined);
      else if (session.status === "error") void notify(`응답이 끝나지 못했습니다 · ${PROVIDER_LABEL[session.provider]}`, where).catch(() => undefined);
      else if (session.status === "idle" && BUSY.includes(before)) {
        void notify(`답이 왔습니다 · ${PROVIDER_LABEL[session.provider]}`, `${where}${session.preview ? `\n${session.preview.split("\n")[0]}` : ""}`).catch(() => undefined);
      }
    }
  }, [state.sessions, state.works]);

  // "앱을 열면: 마지막 작업" set elsewhere (another window, a cleared cache): honoured once the
  // gateway's prefs arrive, if the user has not moved away from home meanwhile.
  const startSettled = useRef(false);
  useEffect(() => {
    if (startSettled.current || !state.ready) return;
    startSettled.current = true;
    if (state.prefs.startScreen === "last" && view.kind === "new" && view.folderId === null && workId && state.works[workId]) setView({ kind: "work" });
  }, [state.ready, state.prefs.startScreen, state.works, view, workId, setView]);
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
      } else if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (event.key === "k" || event.key === "K")) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (event.key === "n" || event.key === "N")) {
        event.preventDefault();
        startNew(null);
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
  }, [switchable, openSession, startNew]);

  // The engine in focus dresses the conversation: the visible session's engine, else the engine
  // picked for a new request. While the appearance sheet is open, the look being edited is shown.
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

  // ── what sidebar rows and menus do ──────────────────────────────────────
  const archive = useCallback(
    (target: { kind: "folder" | "work" | "session"; id: string }) => {
      if (!api) return;
      const request =
        target.kind === "folder" ? api.updateFolder(target.id, { archived: true }) : target.kind === "work" ? api.updateWork(target.id, { archived: true }) : api.updateSession(target.id, { archived: true });
      void request
        .then(() =>
          setToast({
            text: "보관함으로 옮겼습니다.",
            action: {
              label: "되돌리기",
              run: () => actions.restore(target),
            },
          }),
        )
        .catch(fail);
    },
    [api, actions, fail, setToast],
  );

  const exportSession = useCallback(
    async (session: Session, target: "work" | "path" | "text") => {
      if (!api) return;
      const owner = state.works[session.workId];
      try {
        if (target === "text") {
          const { markdown } = await api.exportMarkdown(session.id, { target: "text" });
          await copyText(markdown);
          setToast("대화를 마크다운으로 복사했습니다.");
          return;
        }
        if (target === "path") {
          if (!inDesktop) {
            // In a browser: a download of the same text.
            const { markdown } = await api.exportMarkdown(session.id, { target: "text" });
            const link = document.createElement("a");
            link.href = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
            link.download = `${session.purpose.replace(/[\\/:*?"<>|]/g, "_")}.md`;
            link.click();
            URL.revokeObjectURL(link.href);
            return;
          }
          const name = `${session.purpose.replace(/[\\/:*?"<>|]/g, "_")}.md`;
          const path = await pickSavePath(owner ? `${owner.cwd}/${name}` : name);
          if (!path) return;
          const saved = await api.exportMarkdown(session.id, { target: "path", path });
          setToast({
            text: `저장했습니다: ${saved.path}`,
            action: saved.artifactId ? { label: "열기", run: () => docActions.openArtifact(saved.artifactId!) } : undefined,
          });
          return;
        }
        const saved = await api.exportMarkdown(session.id, { target: "work" });
        const name = saved.path?.split(/[\\/]/).slice(-2).join("/") ?? "";
        setToast({
          text: `${name}(으)로 저장했습니다.`,
          action: saved.artifactId ? { label: "열기", run: () => docActions.openArtifact(saved.artifactId!) } : undefined,
        });
      } catch (error) {
        fail(error);
      }
    },
    [api, state.works, docActions, fail, setToast],
  );

  const openPath = useCallback(
    async (path: string, reveal = false) => {
      if (!inDesktop) {
        await copyText(path);
        setToast(`경로를 복사했습니다: ${path}`);
        return;
      }
      try {
        const opener = await import("@tauri-apps/plugin-opener");
        if (reveal) await opener.revealItemInDir(path);
        else await opener.openPath(path);
      } catch (error) {
        fail(error);
      }
    },
    [fail, setToast],
  );

  const menuFor = useCallback(
    (row: Row, x: number, y: number): MenuRequest | null => {
      if (!api) return null;
      const copy = (text: string, done: string) => () => void copyText(text).then(() => setToast(done));
      if (row.type === "session") {
        const { session, work: owner } = row;
        const busy = isBusy(session);
        const resume = resumeCommand(session, owner);
        const unseenNow = isUnseen(session);
        const items: MenuEntry[] = [
          { kind: "item", label: "열기", icon: "chat", hint: "Enter", onSelect: () => openSession(session) },
          { kind: "item", label: "이름 바꾸기", icon: "edit", hint: "F2", onSelect: () => setSidebarPending({ rename: session.id }) },
          { kind: "separator" },
          { kind: "item", label: session.pinned ? "고정 풀기" : "고정", icon: "pin", onSelect: () => void api.updateSession(session.id, { pinned: !session.pinned }).catch(fail) },
          {
            kind: "item",
            label: unseenNow ? "읽음으로 표시" : "읽지 않음으로 표시",
            icon: unseenNow ? "eye" : "bell",
            onSelect: () => {
              if (!unseenNow && session.id === visibleSession?.id) keptUnread.current = session.id;
              void api.updateSession(session.id, { seen: unseenNow }).catch(fail);
            },
          },
          { kind: "separator" },
          {
            kind: "submenu",
            label: "마크다운으로 내보내기",
            icon: "markdown",
            items: [
              { kind: "item", label: "작업 폴더에 저장", icon: "download", hint: "세션 기록/", onSelect: () => void exportSession(session, "work") },
              { kind: "item", label: inDesktop ? "다른 곳에 저장…" : "내려받기", icon: "folderOpen", onSelect: () => void exportSession(session, "path") },
              { kind: "item", label: "마크다운 복사", icon: "copy", onSelect: () => void exportSession(session, "text") },
            ],
          },
          { kind: "separator" },
          ...(inDesktop ? [{ kind: "item" as const, label: "작업 폴더 열기", icon: "folderOpen" as const, onSelect: () => void openPath(owner.cwd) }] : []),
          { kind: "item", label: "작업 폴더 경로 복사", icon: "copy", onSelect: copy(owner.cwd, "경로를 복사했습니다.") },
          ...(resume
            ? [{ kind: "item" as const, label: "터미널에서 이어 하기 명령 복사", icon: "terminal" as const, onSelect: copy(resume, "명령을 복사했습니다. 터미널에 붙여 넣으면 같은 대화를 이어 갑니다.") }]
            : []),
          { kind: "item", label: `${PROVIDER_LABEL[session.provider]} 외형…`, icon: "palette", onSelect: () => appearanceApi.openSettings(session.provider) },
          { kind: "separator" },
          ...(busy ? [{ kind: "item" as const, label: "멈추기", icon: "stop" as const, onSelect: () => actions.interrupt(session) }] : []),
          { kind: "item", label: busy ? "보관 (멈춘 뒤 가능)" : "보관", icon: "archive", hint: "Delete", disabled: busy, onSelect: () => archive({ kind: "session", id: session.id }) },
        ];
        return { x, y, title: session.purpose, items };
      }
      if (row.type === "work") {
        const owner = row.work;
        const busy = row.sessions.some((session) => isBusy(session));
        const folders = folderChoices(state);
        const items: MenuEntry[] = [
          { kind: "item", label: "열기", icon: "project", hint: "Enter", onSelect: () => openWorkNow(owner) },
          {
            kind: "submenu",
            label: "이 작업에 새 세션",
            icon: "plus",
            items: (["claude", "codex"] as const).map((provider) => ({
              kind: "item" as const,
              label: `${PROVIDER_LABEL[provider]} 새 세션`,
              onSelect: () =>
                void actions.newSession(owner, provider).then((created) => {
                  if (created) actions.selectSession(owner, created);
                }),
            })),
          },
          { kind: "item", label: "새 페이지", icon: "page", onSelect: () => newPage(owner) },
          { kind: "item", label: "이름 바꾸기", icon: "edit", hint: "F2", onSelect: () => setSidebarPending({ rename: owner.id }) },
          { kind: "separator" },
          { kind: "item", label: owner.pinned ? "고정 풀기" : "고정", icon: "pin", onSelect: () => void api.updateWork(owner.id, { pinned: !owner.pinned }).catch(fail) },
          {
            kind: "submenu",
            label: "옮기기",
            icon: "folder",
            items: [
              { kind: "item", label: "분류 없음", checked: !owner.folderId, onSelect: () => actions.moveWork(owner, null) },
              ...(folders.length ? [{ kind: "separator" as const }] : []),
              ...folders.map((folder) => ({
                kind: "item" as const,
                label: `${" ".repeat(folder.depth)}${folder.name}`,
                checked: owner.folderId === folder.id,
                onSelect: () => actions.moveWork(owner, folder.id),
              })),
            ],
          },
          { kind: "separator" },
          ...(inDesktop ? [{ kind: "item" as const, label: "작업 폴더 열기", icon: "folderOpen" as const, onSelect: () => void openPath(owner.cwd) }] : []),
          { kind: "item", label: "작업 폴더 경로 복사", icon: "copy", onSelect: copy(owner.cwd, "경로를 복사했습니다.") },
          { kind: "separator" },
          { kind: "item", label: busy ? "보관 (진행 중인 세션이 끝난 뒤)" : "보관", icon: "archive", hint: "Delete", disabled: busy, onSelect: () => archive({ kind: "work", id: owner.id }) },
        ];
        items.splice(1, 0, { kind: "item", label: "카드로 보기", icon: "grid", onSelect: () => setView({ kind: "pkm", target: { kind: "work", id: owner.id } }) });
        return { x, y, title: owner.title, items };
      }
      if (row.type === "folder") {
        const folder = row.folder;
        const items: MenuEntry[] = [
          { kind: "item", label: "카드로 보기", icon: "grid", onSelect: () => setView({ kind: "pkm", target: { kind: "folder", id: folder.id } }) },
          { kind: "item", label: "이 폴더에 새 작업", icon: "plus", onSelect: () => startNew(folder.id) },
          { kind: "item", label: "하위 폴더 만들기", icon: "folder", onSelect: () => setSidebarPending({ createIn: folder.id }) },
          { kind: "item", label: "이름 바꾸기", icon: "edit", hint: "F2", onSelect: () => setSidebarPending({ rename: folder.id }) },
          { kind: "separator" },
          { kind: "item", label: "보관 (안의 것 포함)", icon: "archive", hint: "Delete", onSelect: () => archive({ kind: "folder", id: folder.id }) },
        ];
        return { x, y, title: folder.name, items };
      }
      if (row.type === "doc") {
        const artifact = row.artifact;
        const items: MenuEntry[] = [
          { kind: "item", label: "열기", icon: "file", hint: "Enter", onSelect: () => docActions.openArtifact(artifact.id) },
          { kind: "item", label: "다른 앱으로 열기", icon: "arrowRight", onSelect: () => void api.openExternal(artifact.id).catch(fail) },
          ...(inDesktop ? [{ kind: "item" as const, label: "파일 위치 열기", icon: "folderOpen" as const, onSelect: () => void openPath(artifact.path, true) }] : []),
          { kind: "item", label: "경로 복사", icon: "copy", onSelect: copy(artifact.path, "경로를 복사했습니다.") },
        ];
        return { x, y, title: artifact.name, items };
      }
      return null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, state, actions, archive, exportSession, openPath, openSession, visibleSession?.id, startNew, docActions, fail, setToast],
  );

  function openWorkNow(target: Work) {
    setWorkId(target.id);
    setView({ kind: "work" });
  }

  const move = useCallback(
    (next: Move) => {
      if (!api) return;
      const request =
        next.kind === "folder"
          ? api.updateFolder(next.id, { parentId: next.parentId, sort: next.sort })
          : next.kind === "work"
            ? api.updateWork(next.id, { folderId: next.folderId, sort: next.sort })
            : api.updateSession(next.id, { sort: next.sort });
      void request.catch(fail);
    },
    [api, fail],
  );

  const sidebarActions: SidebarActions = {
    openSession,
    openWork: openWorkNow,
    openDoc: (artifact: Artifact) => docActions.openArtifact(artifact.id),
    newSession: ({ folderId }) => startNew(folderId ?? null),
    createFolder: async (name, parentId) => {
      await api?.createFolder(name, parentId).catch(fail);
    },
    rename: (target, name) => {
      if (!api) return;
      const request =
        target.kind === "folder" ? api.updateFolder(target.id, { name }) : target.kind === "work" ? api.updateWork(target.id, { title: name }) : api.updateSession(target.id, { purpose: name });
      void request.catch(fail);
    },
    move,
    menuFor,
    openMenu: setContextMenu,
    refreshUsage: () => api?.refreshProviders().catch(fail) ?? Promise.resolve(),
    openHome: () => startNew(null),
    newPage,
    archive,
    openSearch: () => setPaletteOpen(true),
    openArchive: () => setView({ kind: "archive" }),
  };

  const paletteCommands: PaletteCommand[] = [
    { id: "new", label: "새 세션", icon: "plus", hint: "Ctrl+N", run: () => startNew(null) },
    { id: "home", label: "홈", icon: "home", run: () => startNew(null) },
    ...(visibleSession
      ? [
          { id: "export-work", label: "지금 대화를 마크다운으로 저장 (작업 폴더)", icon: "markdown" as const, run: () => void exportSession(visibleSession, "work") },
          { id: "export-copy", label: "지금 대화를 마크다운으로 복사", icon: "copy" as const, run: () => void exportSession(visibleSession, "text") },
        ]
      : []),
    { id: "archive", label: "보관함 열기", icon: "archive", run: () => setView({ kind: "archive" }) },
    { id: "sidebar", label: sidebarOpen ? "사이드바 숨기기" : "사이드바 보이기", icon: "sidebar", run: toggleSidebar },
    { id: "theme", label: focusedTheme === "dark" ? "라이트 화면으로" : "다크 화면으로", icon: focusedTheme === "dark" ? "sun" : "moon", run: () => savePrefs({ theme: focusedTheme === "dark" ? "light" : "dark" }) },
    { id: "appearance", label: "엔진 외형 설정", icon: "palette", run: () => appearanceApi.openSettings() },
    { id: "integrations", label: "MCP·스킬 보기", icon: "tool", run: () => setIntegrationsOpen(true) },
    { id: "connections", label: "연결과 설정", icon: "dots", run: () => setMenuOpen(true) },
    { id: "onboarding", label: "처음 안내 다시 보기", icon: "eye", run: () => setOnboardingAgain(true) },
  ];

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
  const title =
    view.kind === "archive" ? "보관함" : view.kind === "pkm" ? pkmTitle(state, view.target, null) : showStart ? (view.kind === "new" && view.folderId ? "새 작업" : "홈") : work?.title ?? "";

  return (
    <AppearanceContext.Provider value={appearanceApi}>
    <UnseenContext.Provider value={unseen}>
    <DocContext.Provider value={{ state, actions: docActions }}>
    <PkmProvider
      api={api}
      state={state}
      onToast={setToast}
      target={view.kind === "pkm" ? view.target : null}
      onOpen={(target) => setView({ kind: "pkm", target })}
      onShowSession={actions.selectSession}
      onShowWork={openWorkNow}
      onMenu={setContextMenu}
    >
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
          <button type="button" className="brand" onClick={() => startNew(null)} title="홈" aria-label="Achmage 홈">
            <Wordmark className="brand-wordmark" />
            <BrandSymbol className="brand-compact" size={26} />
          </button>
          {!sidebarOpen ? (
            <>
              <button type="button" className="ghost-button" onClick={() => startNew(null)} title="새 세션 (Ctrl+N)">
                <Icon name="plus" size={15} /> 새 세션
              </button>
              <button type="button" className="ghost-button" onClick={() => setPaletteOpen(true)} title="찾기 (Ctrl+K)">
                <Icon name="search" size={15} /> 찾기
                {unseen.size ? <span className="count-chip new" title="새 답">{unseen.size}</span> : null}
              </button>
            </>
          ) : null}
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
                const session = pendingApprovals[0]!;
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
                onIntegrations={() => {
                  closeMenu();
                  setIntegrationsOpen(true);
                }}
                onOnboarding={() => {
                  closeMenu();
                  setOnboardingAgain(true);
                }}
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
                startScreen={prefs.startScreen === "last" ? "last" : "home"}
                onStartScreen={(next) => savePrefs({ startScreen: next })}
                brandMotion={prefs.brandMotion !== false}
                onBrandMotion={(next) => savePrefs({ brandMotion: next })}
                notifications={prefs.notify !== false}
                onNotifications={(next) => savePrefs({ notify: next })}
                vault={<VaultSettingsRow onOpen={closeMenu} />}
              />
            </Popover>
          </div>
        </div>
      </header>

      <div className={`body${sidebarOpen && state.ready ? " with-sidebar" : ""}`}>
      {sidebarOpen && state.ready ? (
        <Sidebar
          state={state}
          currentWorkId={view.kind === "work" || view.kind === "document" ? work?.id ?? null : null}
          visibleSessionId={visibleSession?.id ?? null}
          currentDocId={view.kind === "document" ? view.artifactId : null}
          open={treeOpen}
          onOpenChange={(next: TreeOpenState) => savePrefs({ tree: next })}
          sortMode={sortMode}
          homeActive={view.kind === "new" && view.folderId === null}
          onSortMode={(mode) => savePrefs({ treeSort: mode })}
          width={sidebarWidth}
          onWidth={(width) => savePrefs({ sidebarWidth: width })}
          actions={sidebarActions}
          pending={sidebarPending}
          onPendingDone={() => setSidebarPending(null)}
        />
      ) : null}
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
            onLeaveGuard={setLeaveGuard}
            onBack={() => setView({ kind: "work" })}
            onToast={setToast}
            onOpenArtifact={(artifactId) => setView({ kind: "document", artifactId, proposalId: null })}
            onPickTarget={() => actions.pickSession(work, activeSession ?? null)}
            onAnswer={(session, itemId, decision) => actions.answer(session, itemId, decision)}
            onSend={async (session, text, refs, handoffTo, create) => {
              let source = session;
              if (!source) source = await actions.newSession(work, engine);
              if (!source) return false;
              if (handoffTo) return actions.handoff(source, handoffTo, text, refs);
              return actions.send(source, text, refs, create);
            }}
          />
        </Suspense>
      ) : view.kind === "pkm" ? (
        <PkmCenter target={view.target} />
      ) : view.kind === "archive" ? (
        <ArchiveView
          state={state}
          onRestore={actions.restore}
          onOpenSession={openSession}
          onOpenWork={openWorkNow}
          onClose={() => setView({ kind: "work" })}
        />
      ) : showStart ? (
        <StartView
          state={state}
          folderId={view.kind === "new" ? view.folderId : null}
          onClearFolder={() => setView({ kind: "new", folderId: null })}
          onStart={(text, provider, cwd, choice) => startWork(text, provider, cwd, view.kind === "new" ? view.folderId : null, choice)}
          onOpenWork={openWorkNow}
          onOpenSession={openSession}
          motion={prefs.brandMotion !== false}
          pickFolder={inDesktop ? pickFolderNative : null}
          engine={engine}
          setEngine={setEngine}
        />
      ) : work ? (
        <WorkView
          state={state}
          work={work}
          actions={actions}
          engine={engine}
          setEngine={setEngine}
          pickFile={inDesktop ? pickFileNative : null}
          tabs={tabs}
          openDocIds={openDocIds}
          focusItem={focusItem && focusItem.sessionId === activeSession?.id ? focusItem : null}
          onFocusDone={() => setFocusItem(null)}
          sidebarOpen={sidebarOpen}
          prefs={prefs}
        />
      ) : null}
      </div>

      {integrationsOpen && api ? <IntegrationsSheet api={api} onClose={() => setIntegrationsOpen(false)} onToast={setToast} /> : null}
      {state.ready && api && (prefs.onboarding !== "done" || onboardingAgain) ? (
        <Onboarding
          providers={state.providers}
          tools={state.tools}
          onLogin={(provider) =>
            void api
              .login(provider)
              .then((result) => {
                setLoginMessage(result.message);
                if (result.url) void openExternal(result.url);
              })
              .catch(fail)
          }
          onRefresh={() => {
            void api.refreshProviders().catch(() => undefined);
            void api.refreshTools().catch(() => undefined);
          }}
          onInstallIeum={() => void api.installIeumOffice().catch(fail)}
          onDone={() => {
            setOnboardingAgain(false);
            if (prefs.onboarding !== "done") savePrefs({ onboarding: "done" });
          }}
        />
      ) : null}
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
      {contextMenu ? <ContextMenu request={contextMenu} onClose={closeContextMenu} /> : null}
      {paletteOpen ? (
        <SearchPalette
          api={api}
          state={state}
          commands={paletteCommands}
          onOpenSession={openSession}
          onOpenHit={(session, itemId) => {
            openSession(session);
            setFocusItem({ sessionId: session.id, itemId, nonce: Date.now() });
          }}
          onOpenWork={openWorkNow}
          onOpenDoc={(artifact) => docActions.openArtifact(artifact.id)}
          onClose={() => setPaletteOpen(false)}
        />
      ) : null}
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
        <div className="toast" role="status" onClick={() => setToastState(null)}>
          <span>{toast.text}</span>
          {toast.action ? (
            <button
              type="button"
              className="toast-action"
              onClick={(event) => {
                event.stopPropagation();
                toast.action!.run();
                setToastState(null);
              }}
            >
              {toast.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
      <VaultDialogHost pickFolder={inDesktop ? pickFolderNative : null} />
    </div>
    </PkmProvider>
    </DocContext.Provider>
    </UnseenContext.Provider>
    </AppearanceContext.Provider>
  );
}
