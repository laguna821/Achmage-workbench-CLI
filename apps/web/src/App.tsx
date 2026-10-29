import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { PROVIDER_LABEL, isUnseen, type AccessMode, type Artifact, type Attachment, type CreateTarget, type DocRef, type ProjectPick, type Proposal, type Provider, type Session, type SessionStatus, type UiPrefs, type Work } from "@workbench/contracts";
import { Api, ApiRequestError, readToken } from "./api.ts";
import { configureDesign } from "./design.ts";
import { initialState, isBusy, reducer, sessionsOf } from "./state.ts";
import { newRequestId, titleFrom } from "./format.ts";
import { folderChoices, readOpenState, workSessions, type Move, type Row, type SortMode, type TreeOpenState } from "./tree.ts";
import { Connections } from "./components/Connections.tsx";
import type { BrowserActions } from "./components/BrowserPill.tsx";
import { EditableText } from "./components/EditableText.tsx";
import { Icon } from "./components/Icon.tsx";
import { BrandSymbol, Wordmark } from "./components/BrandMark.tsx";
import { Popover } from "./components/Popover.tsx";
import { Sidebar, type SidebarActions } from "./components/Sidebar.tsx";
import { ContextMenu, type MenuEntry, type MenuRequest } from "./components/ContextMenu.tsx";
import { SearchPalette, type PaletteCommand, type PaletteMode } from "./components/SearchPalette.tsx";
import { ArchiveView } from "./components/ArchiveView.tsx";
import { StartView, useEngineChoice } from "./components/StartView.tsx";
import { WorkView, type WorkActions } from "./components/WorkView.tsx";
import type { DrawState } from "./components/ImageGen.tsx";
import { AppearanceSheet, type SheetTarget } from "./components/AppearanceSheet.tsx";
import { EngineMenu } from "./components/EngineMenu.tsx";
import { Switcher, UnseenContext } from "./components/SessionCards.tsx";
import { DocContext, FormatBadge, type DocActions } from "./components/DocCards.tsx";
import { DocTabs } from "./components/DocTabs.tsx";
import { IntegrationsSheet } from "./components/IntegrationsSheet.tsx";
import { ImageUploadRow, ImageUploadSheet } from "./components/ImageUploadSheet.tsx";
import { Onboarding } from "./components/Onboarding.tsx";
import type { EngineActions } from "./components/EngineSetup.tsx";
import { SessionPicker } from "./components/SessionPicker.tsx";
import { LinkLayer } from "./components/LinkCards.tsx";
import { ImportDialog } from "./components/ImportDialog.tsx";
import { ScheduleDialog } from "./components/ScheduleDialog.tsx";
import { WorktreeReview } from "./components/WorktreeReview.tsx";
import { LoadingView } from "./components/Skeleton.tsx";
import { writeDraft } from "./components/Composer.tsx";
import { comboOf, shortcutsOf } from "./shortcuts.ts";
import { ShortcutSettings } from "./components/ShortcutSettings.tsx";
import { TemplateDialog } from "./components/project/TemplateDialog.tsx";
import { LinkContext, hopsText, linkOfSession, useLinkApi } from "./links.ts";
import { SplitView, WorkModeBar, useWorkModeKeys } from "./components/WorkModes.tsx";
import { keepPosition, keptPosition, modeOf, readingPosition, restorePosition, reviewProposal, viewFor, type ModeProps, type ReadingPosition, type WorkMode } from "./workmodes.ts";
import { detachSession, showInWindow, windowSession } from "./windows.ts";
import { PkmProvider, type PkmApi } from "./components/pkm/PkmContext.tsx";
import { VaultDialogHost, VaultSettingsRow } from "./components/pkm/VaultDialog.tsx";
import { PkmCenter, pkmTitle } from "./components/pkm/PkmCenter.tsx";
import { ProjectView } from "./components/project/ProjectView.tsx";
import type { PkmTarget } from "./pkm.ts";
import { entryClient, homeTarget, sessionToOpen, unseenFailure } from "./entry.ts";
import { WorksDirRow } from "./components/WorksDirRow.tsx";
import { EngineMark } from "./components/EngineMark.tsx";
import { PaneLayout, type PaneHead, type PaneScope } from "./components/Panes.tsx";
import { closePane, dropEffect, focusPane, focusedPane, otherPane, paneById, placeOnSide, readRatio, setPane, shownElsewhere, singleLayout, swapPanes, type Layout, type Pane, type PaneContent, type PaneId, type PaneItem, type Side } from "./panes.ts";
import { PaneActionsContext, type PaneActions } from "./panedrag.ts";

// Editors (CodeMirror, PDF.js) load only when a document opens.
const DocumentView = lazy(() => import("./components/docs/DocumentView.tsx"));
const Reader = lazy(() => import("./components/Reader.tsx"));
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

/**
 * An OS notification (desktop app). On Linux the shell's own one opens its session when clicked;
 * elsewhere (or without a notification server that says so) the plugin's, which only shows.
 */
async function notify(title: string, body: string, sessionId: string) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("notify_session", { title, body, sessionId });
    return;
  } catch {
    // Not Linux: the plugin's notification below.
  }
  const { isPermissionGranted, requestPermission, sendNotification } = await import("@tauri-apps/plugin-notification");
  if (!(await isPermissionGranted()) && (await requestPermission()) !== "granted") return;
  sendNotification({ title, body });
}

const BUSY: SessionStatus[] = ["starting", "running", "interrupting", "awaitingApproval"];

async function pickFolderNative(title = "작업 폴더 선택", defaultPath?: string): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title, defaultPath });
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
  /** "나란히": chosen only, never where the app opens (views are not kept across launches). */
  | { kind: "split"; artifactId: string; draftKey: string; focus: "chat" | "doc" }
  /** Cards of a vault folder, an app folder, a work or a saved view; or one vault note (pkm). */
  | { kind: "pkm"; target: PkmTarget }
  /** A work as a project note (project page). */
  | { kind: "project"; workId: string };

type Toast = { text: string; action?: { label: string; run: () => void } };

const OPEN_DOCS_KEY = "workbench.openDocs";
/** The document body in the focused pane (with two panes, the other may show a document too). */
const FOCUSED_DOC = '.pane[data-pane-active="true"] .document-view .doc-body';
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
  // A window of its own for one session (`?session=`, "새 창으로 떼어 내기"): no sidebar, no home.
  const [single, setSingle] = useState<string | null>(() => windowSession());
  // The main area: one pane, or two side by side (panes.ts). `view` and `workId` are the focused
  // pane's, so whatever opens something (sidebar, search, cards) opens it there. Home first, unless
  // the user chose to open the last work straight away (and there is one). Like the views
  // themselves, a second pane is not brought back when the app opens again; its width is.
  const [layout, setLayout] = useState<Layout<View>>(() =>
    singleLayout<View>(
      windowSession() || (cachedPrefs().startScreen === "last" && localStorage.getItem(LAST_WORK_KEY)) ? { kind: "work" } : { kind: "new", folderId: null },
      localStorage.getItem(LAST_WORK_KEY),
    ),
  );
  // The layout as last asked for, so changes made in one handler build on each other.
  const layoutRef = useRef(layout);
  const updateLayout = useCallback((change: (current: Layout<View>) => Layout<View>) => {
    const next = change(layoutRef.current);
    if (next === layoutRef.current) return;
    layoutRef.current = next;
    setLayout(next);
  }, []);
  const { view, workId } = focusedPane(layout);
  // A document view holding edits only it can save (the Word editor) saves them before it is replaced (one per pane).
  const leaveGuards = useRef<Partial<Record<PaneId, () => Promise<void>>>>({});
  const guardOf = useMemo(() => {
    const keep = (id: PaneId) => (guard: (() => Promise<void>) | null) => {
      if (guard) leaveGuards.current[id] = guard;
      else delete leaveGuards.current[id];
    };
    return { a: keep("a"), b: keep("b") };
  }, []);
  /** `then`, after the pane's document view saved what only it can save, when that view goes away. */
  const afterLeaving = useCallback((id: PaneId, next: View | null, then: () => void) => {
    const pane = paneById(layoutRef.current, id);
    const guard = leaveGuards.current[id];
    // "문서" and "나란히" show the same document view; it is left only when another one replaces it.
    const docOf = (entry: View | null) => (entry && (entry.kind === "document" || entry.kind === "split") ? entry.artifactId : null);
    const leaving = pane !== undefined && docOf(pane.view) !== null && docOf(next) !== docOf(pane.view);
    if (!guard || !leaving) return then();
    void guard()
      .catch(() => undefined)
      .finally(then);
  }, []);
  const setViewOf = useCallback(
    (id: PaneId, next: View | ((current: View) => View)) => {
      const pane = paneById(layoutRef.current, id);
      if (!pane) return;
      const resolved = typeof next === "function" ? next(pane.view) : next;
      if (resolved === pane.view) return;
      afterLeaving(id, resolved, () => updateLayout((current) => setPane(current, id, { view: resolved })));
    },
    [afterLeaving, updateLayout],
  );
  const setView = useCallback((next: View | ((current: View) => View)) => setViewOf(layoutRef.current.focus, next), [setViewOf]);
  // Pane routing for callbacks made once (menus, actions): filled in below on every render.
  const panesRef = useRef<{ focusIfShown: (key: string) => boolean; placeItem: (item: PaneItem, side: Side) => void }>({ focusIfShown: () => false, placeItem: () => undefined });
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const [imageUploadOpen, setImageUploadOpen] = useState(false);
  const [onboardingAgain, setOnboardingAgain] = useState(false);
  // Documents opened in each work, shown as tabs and offered first by "@".
  const [openDocs, setOpenDocs] = useState<Record<string, string[]>>(() => readJson(OPEN_DOCS_KEY, {}));
  const [toast, setToastState] = useState<Toast | null>(null);
  const setToast = useCallback((next: string | Toast | null) => setToastState(typeof next === "string" ? { text: next } : next), []);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [engine, setEngine] = useEngineChoice();
  const [engineMenu, setEngineMenu] = useState<{ provider: Provider; x: number; y: number } | null>(null);
  const [sheet, setSheet] = useState<SheetTarget | null>(null);
  const [contextMenu, setContextMenu] = useState<MenuRequest | null>(null);
  // Ctrl+K opens the search box ("palette"); Ctrl+Shift+F opens it for contents only ("content").
  const [paletteOpen, setPaletteOpen] = useState<PaletteMode | null>(null);
  // A message to bring into view after opening its conversation (from search).
  const [focusItem, setFocusItem] = useState<{ sessionId: string; itemId: string; nonce: number } | null>(null);
  // Inline rename or folder creation asked from a menu, handled by the sidebar.
  const [sidebarPending, setSidebarPending] = useState<{ rename?: string; createIn?: string | null } | null>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  // The PKM layer's dialogs and calls, for the menus built here (pkm/PkmContext.tsx).
  const pkmHandle = useRef<PkmApi | null>(null);
  const closeEngineMenu = useCallback(() => setEngineMenu(null), []);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const setWorkId = (id: string | null) => {
    updateLayout((current) => setPane(current, current.focus, { workId: id }));
    if (id && !single) localStorage.setItem(LAST_WORK_KEY, id);
  };

  const fail = useCallback((error: unknown) => {
    setToast(error instanceof ApiRequestError || error instanceof Error ? error.message : String(error));
  }, [setToast]);
  // "설치" and "로그인" of the engines (onboarding and the connection panel); progress comes as status events.
  const engineActions = useMemo<EngineActions>(
    () => ({
      install: (provider) => void api?.installEngine(provider).catch(fail),
      login: (provider) => void api?.login(provider).catch(fail),
      loginCode: async (provider, code) => {
        await api?.loginCode(provider, code);
      },
      cancelLogin: (provider) => void api?.cancelLogin(provider).catch(fail),
      openUrl: (url) => void openExternal(url).catch(fail),
      copy: (text) => void copyText(text).then(() => setToast("복사했습니다.")),
    }),
    [api, fail, setToast],
  );

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
  const sidebarOpen = !single && prefs.sidebar !== false;
  const toggleSidebar = () => savePrefs({ sidebar: !sidebarOpen });
  const sidebarWidth = typeof prefs.sidebarWidth === "number" ? Math.min(480, Math.max(232, prefs.sidebarWidth)) : 288;
  const sortMode: SortMode = SORT_MODES.includes(prefs.treeSort as SortMode) ? (prefs.treeSort as SortMode) : "manual";
  const treeOpen = useMemo(() => readOpenState(prefs.tree), [prefs.tree]);

  const singleSession = single ? state.sessions[single] : undefined;
  const work = singleSession ? state.works[singleSession.workId] : workId ? state.works[workId] : undefined;
  /** The session a work shows: its active one (unless archived), else its latest. */
  const activeOf = (owner: Work) =>
    (owner.activeSessionId && state.sessions[owner.activeSessionId] && !state.sessions[owner.activeSessionId]!.archivedAt && state.sessions[owner.activeSessionId]) ||
    workSessions(state, owner.id).at(-1) ||
    sessionsOf(state, owner.id).at(-1);
  const activeSession = singleSession ?? (work && activeOf(work));
  // ── two panes (panes.ts): the other pane keeps the session it showed when it lost the focus ──
  const second = otherPane(layout);
  const sessionIn = (pane: Pane<View>): Session | undefined => {
    if (pane.id === layout.focus) return activeSession || undefined;
    const owner = pane.workId ? state.works[pane.workId] : undefined;
    if (!owner) return undefined;
    const kept = pane.sessionId ? state.sessions[pane.sessionId] : undefined;
    return kept && kept.workId === owner.id ? kept : activeOf(owner) || undefined;
  };

  // A document shown becomes a tab of its work (at most 8, the oldest goes).
  useEffect(() => {
    if (view.kind !== "document" && view.kind !== "split") return;
    const artifact = state.artifacts[view.artifactId];
    if (!artifact) return;
    setOpenDocs((current) => {
      const list = current[artifact.workId] ?? [];
      return list.includes(artifact.id) ? current : { ...current, [artifact.workId]: [...list, artifact.id].slice(-8) };
    });
  }, [view, state.artifacts]);
  useEffect(() => localStorage.setItem(OPEN_DOCS_KEY, JSON.stringify(openDocs)), [openDocs]);
  const docsOf = (owner: Work | undefined) => (owner ? (openDocs[owner.id] ?? []).filter((id) => state.artifacts[id]) : []);
  const openDocIds = docsOf(work);
  const closeDocIn = (id: PaneId, owner: Work, ids: string[], artifactId: string) => {
    const rest = ids.filter((entry) => entry !== artifactId);
    setOpenDocs((current) => ({ ...current, [owner.id]: rest }));
    const shown = paneById(layoutRef.current, id)?.view;
    if (shown && (shown.kind === "document" || shown.kind === "split") && shown.artifactId === artifactId) {
      setViewOf(id, rest.length ? { kind: "document", artifactId: rest[rest.length - 1]!, proposalId: null } : { kind: "work" });
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

  // The agent browser: the pill under the input and the connections menu.
  const browserActions: BrowserActions = useMemo(
    () => ({
      setOn: (session, on) => {
        void api?.updateSession(session.id, { browser: on }).catch(fail);
        if (on) setToast("브라우저를 켰습니다. 다음 요청부터 엔진이 창을 쓸 수 있습니다.");
      },
      install: () => void api?.browser.install().catch(fail),
      login: (url) => void api?.browser.login(url).catch(fail),
      closeLogin: () => void api?.browser.closeLogin().catch(fail),
      focus: () =>
        void api?.browser
          .focus()
          .then((result) => {
            if (!result.ok) setToast(result.message);
          })
          .catch(fail),
      pause: (session, paused) => void api?.browser.pause(session.id, paused).catch(fail),
    }),
    [api, fail, setToast],
  );

  const actions: WorkActions = useMemo(
    () => ({
      send: async (session: Session, text: string, refs: DocRef[] = [], create: CreateTarget | null = null, mode: "auto" | "queue" = "auto", attachments: Attachment[] = [], plan = false, omitChanges: string[] = [], notes: string[] = []) => {
        if (!api) return false;
        try {
          const result = await api.send(session.id, newRequestId(), text, refs, create, mode, attachments, plan, { omitChanges, ...(notes.length ? { notes } : {}) });
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
      clipboardPicture: () => (api ? api.clipboardPicture().catch(() => null) : Promise.resolve(null)),
      reviewWorktree: (session: Session) => setReviewing(session.id),
      fork: (session: Session, itemId: string) => {
        if (!api) return;
        void api
          .forkBefore(session.id, itemId)
          .then(({ session: forked, text }) => {
            // The request goes back into the new session's input, to be edited and sent again.
            writeDraft(`work:${forked.workId}:${forked.id}`, text);
            setWorkId(forked.workId);
            setView({ kind: "work" });
            setToast("이 요청 앞까지의 대화로 갈래를 만들었습니다. 요청을 고쳐 보내세요.");
          })
          .catch(fail);
      },
      commands: async (session: Session) => {
        if (!api) return [];
        try {
          return (await api.commands(session.id)).commands;
        } catch (error) {
          fail(error);
          return [];
        }
      },
      upload: async (file: File) => {
        if (!api) return null;
        try {
          return await api.uploadAttachment(file);
        } catch (error) {
          fail(error);
          return null;
        }
      },
      handoff: async (source: Session, target: Session, text: string, refs: DocRef[] = [], attachments: Attachment[] = []) => {
        if (!api) return false;
        try {
          await api.handoff({ requestId: newRequestId(), sourceSessionId: source.id, targetSessionId: target.id, text, refs, attachments });
          return true;
        } catch (error) {
          fail(error);
          return false;
        }
      },
      draw: async (session: Session, brief: string, draw: DrawState) => {
        if (!api) return false;
        try {
          await api.draw(session.id, { requestId: newRequestId(), brief, templateId: draw.choice.templateId, aspect: draw.choice.aspect, transparent: draw.choice.transparent, via: draw.via });
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
      newSession: async (target: Work, provider: Provider, choice, options) => {
        if (!api) return null;
        try {
          return await api.createSession(target.id, provider, { model: choice?.model ?? null, effort: choice?.effort ?? null, ...(options?.browser ? { browser: true } : {}), ...(options?.worktree ? { worktree: true } : {}) });
        } catch (error) {
          fail(error);
          return null;
        }
      },
      selectSession: (target, session) => {
        if (single) {
          // A detached window stays one window: it switches to the session picked in it.
          setSingle(session.id);
          showInWindow(session.id);
          setView({ kind: "work" });
          return;
        }
        // Already shown in the other pane: the focus goes there (never the same conversation twice).
        panesRef.current.focusIfShown(`session:${session.id}`);
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
      openProject: (target) => {
        panesRef.current.focusIfShown(`project:${target.id}`);
        setWorkId(target.id);
        setView({ kind: "project", workId: target.id });
      },
      openSidebar: () => savePrefs({ sidebar: true }),
      restore: (target) => {
        if (!api) return;
        const request =
          target.kind === "folder" ? api.updateFolder(target.id, { archived: false }) : target.kind === "work" ? api.updateWork(target.id, { archived: false }) : api.updateSession(target.id, { archived: false });
        void request.then(() => setToast("되돌렸습니다.")).catch(fail);
      },
      browser: browserActions,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, fail, savePrefs, setToast, setView, browserActions, single],
  );

  const docActions: DocActions = useMemo(
    () => ({
      openArtifact: (artifactId, proposalId) => {
        panesRef.current.focusIfShown(`doc:${artifactId}`);
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
      resendHandoff: async (handoff) => {
        if (!api) return;
        try {
          await api.resendHandoff(handoff.id, newRequestId());
          setToast("같은 내용을 다시 보냈습니다.");
        } catch (error) {
          fail(error);
        }
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
    pick: ProjectPick = { kind: "auto" },
  ) => {
    if (!api) return false;
    try {
      // The project chip: an existing work gets a new session; otherwise a new work (project).
      const existing = await homeTarget(state, pick, cwd, entryClient(api).workAt);
      const created = existing ?? (await api.createWork(titleFrom(text), folderId, cwd));
      const session = await api.createSession(created.id, provider, choice);
      dispatch({ type: "focus", work: created, session });
      setWorkId(created.id);
      setView({ kind: "work" });
      await api.send(session.id, newRequestId(), text);
      // Home's input is gone from the screen by now and cannot clear itself: the sent text must not come back there.
      writeDraft(`new:${folderId ?? "root"}`, "");
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };

  const pendingApprovals = Object.values(state.sessions).filter((session) => session.status === "awaitingApproval" && !session.archivedAt);

  // New replies: kept by the gateway, so every window agrees. Looking at a session marks it seen,
  // except right after the user marked it unread while looking at it.
  const visibleSession = (view.kind === "work" || view.kind === "split") && activeSession ? activeSession : null;
  // The other pane's conversation is on screen too (unless the window is too narrow to show it).
  const [narrowPanes, setNarrowPanes] = useState(false);
  const besideSession = second && !narrowPanes && (second.view.kind === "work" || second.view.kind === "split") ? (sessionIn(second) ?? null) : null;
  const keptUnread = useRef<string | null>(null);
  useEffect(() => {
    if (keptUnread.current && keptUnread.current !== visibleSession?.id && keptUnread.current !== besideSession?.id) keptUnread.current = null;
  }, [visibleSession?.id, besideSession?.id]);
  const seenAsked = useRef(new Map<string, string>());
  useEffect(() => {
    if (!api) return;
    for (const shown of [visibleSession, besideSession]) {
      if (!shown) continue;
      // A failure counts as seen too once looked at (opening the work then goes elsewhere, entry.ts).
      const failed = unseenFailure(shown);
      if (!(isUnseen(shown) || failed) || keptUnread.current === shown.id) continue;
      const key = `${shown.previewAt}:${shown.unread}${failed ? `:${shown.updatedAt}` : ""}`;
      if (seenAsked.current.get(shown.id) === key) continue;
      seenAsked.current.set(shown.id, key);
      void api.updateSession(shown.id, { seen: true }).catch(() => undefined);
    }
  }, [api, visibleSession, besideSession]);
  const unseen = useMemo(
    () => new Set(Object.values(state.sessions).filter((session) => isUnseen(session) && session.id !== visibleSession?.id && session.id !== besideSession?.id && !session.archivedAt).map((session) => session.id)),
    [state.sessions, visibleSession?.id, besideSession?.id],
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
  // "다른 곳의 대화 가져오기": the imported session opens at once (its work may be new, so by id).
  const [importOpen, setImportOpen] = useState(false);
  // "예약 작업" of the session whose dialog is open.
  const [scheduling, setScheduling] = useState<string | null>(null);
  // "변경 검토" of the worktree session whose dialog is open.
  const [reviewing, setReviewing] = useState<string | null>(null);
  const openImported = useCallback(
    (session: Session) => {
      // The gateway made it the work's active session.
      setWorkId(session.workId);
      setView({ kind: "work" });
    },
    [],
  );
  /** A page just made: its work's documents unfold in the tree, and it opens. */
  const revealPage = useCallback(
    (artifact: Artifact) => {
      const open = readOpenState(prefsRef.current.tree);
      const workId = artifact.workId;
      savePrefs({
        tree: { ...open, openWorks: [...new Set([...open.openWorks, workId])], closedWorks: open.closedWorks.filter((id) => id !== workId), openDocs: [...new Set([...open.openDocs, workId])] },
      });
      setWorkId(workId);
      setView({ kind: "document", artifactId: artifact.id, proposalId: null });
    },
    [savePrefs, setView, setWorkId],
  );
  /** Notion's "+": a Markdown page in the work folder, shown in the tree and opened at once. */
  const newPage = useCallback(
    (owner: Work) => {
      if (!api) return;
      void api.createPage(owner.id).then(revealPage).catch(fail);
    },
    [api, fail, revealPage],
  );
  const startNew = useCallback(
    (folderId: string | null = null) => {
      if (single) return;
      setView({ kind: "new", folderId });
      // Already on the start screen: make the press visibly do something.
      window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus());
    },
    [setView, single],
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
      // Only the main window tells; a detached one would say the same thing twice.
      if (!before || before === session.status || !inDesktop || !away || prefsRef.current.notify === false || single || session.muted) continue;
      const where = `${state.works[session.workId]?.title ?? ""} — ${session.purpose}`;
      if (session.status === "awaitingApproval") void notify(`확인이 필요합니다 · ${PROVIDER_LABEL[session.provider]}`, where, session.id).catch(() => undefined);
      else if (session.status === "error") void notify(`응답이 끝나지 못했습니다 · ${PROVIDER_LABEL[session.provider]}`, where, session.id).catch(() => undefined);
      else if (session.status === "idle" && BUSY.includes(before)) {
        void notify(`답이 왔습니다 · ${PROVIDER_LABEL[session.provider]}`, `${where}${session.preview ? `\n${session.preview.split("\n")[0]}` : ""}`, session.id).catch(() => undefined);
      }
    }
  }, [state.sessions, state.works]);

  // The tray's "확인 필요 N" follows the sessions waiting for the user (main window only).
  const attention = useRef(-1);
  useEffect(() => {
    if (!inDesktop || single) return;
    const count = Object.values(state.sessions).filter((session) => session.status === "awaitingApproval" && !session.archivedAt).length;
    if (count === attention.current) return;
    attention.current = count;
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("set_attention", { count })).catch(() => undefined);
  }, [state.sessions]);

  // A clicked notification, or the tray's "확인 필요", opens its session.
  const opener = useRef<{ open: (sessionId: string | null) => void }>({ open: () => undefined });
  opener.current.open = (sessionId) => {
    const target = sessionId ? state.sessions[sessionId] : Object.values(state.sessions).find((session) => session.status === "awaitingApproval" && !session.archivedAt);
    if (target) openSession(target);
  };
  useEffect(() => {
    if (!inDesktop || single) return;
    let stop = false;
    const unlisten: (() => void)[] = [];
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const handlers = [
        await listen<string>("workbench://open-session", (event) => opener.current.open(event.payload)),
        await listen("workbench://open-attention", () => opener.current.open(null)),
      ];
      if (stop) handlers.forEach((handler) => handler());
      else unlisten.push(...handlers);
    });
    return () => {
      stop = true;
      unlisten.forEach((handler) => handler());
    };
  }, []);

  // "앱을 열면: 마지막 작업" set elsewhere (another window, a cleared cache): honoured once the
  // gateway's prefs arrive, if the user has not moved away from home meanwhile.
  const shortcuts = useMemo(() => shortcutsOf(state.prefs), [state.prefs]);
  /** True while ⋯ › 단축키 waits for a combination: the app's own shortcuts stand aside. */
  const recordingShortcut = useRef(false);
  /** ⋯ › 프로젝트 속성 템플릿… */
  const [propertyTemplateOpen, setPropertyTemplateOpen] = useState(false);
  const setRecordingShortcut = useCallback((on: boolean) => {
    recordingShortcut.current = on;
  }, []);
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
      } else {
        // The person's combinations (⋯ › 단축키), else Ctrl+K, Ctrl+Shift+F, Ctrl+N.
        const combo = comboOf(event);
        if (!combo || recordingShortcut.current) return;
        if (combo === shortcuts.palette) {
          event.preventDefault();
          setPaletteOpen((open) => (open === "palette" ? null : "palette"));
        } else if (combo === shortcuts.content) {
          event.preventDefault();
          setPaletteOpen((open) => (open === "content" ? null : "content"));
        } else if (combo === shortcuts.newWork) {
          event.preventDefault();
          startNew(null);
        }
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
  }, [switchable, openSession, startNew, shortcuts]);

  // The engine in focus dresses the conversation: the visible session's engine, else the engine
  // picked for a new request. While the appearance sheet is open, the look being edited is shown.
  const startScreen = view.kind === "new" || (view.kind === "work" && !work);
  const focusedProvider: Provider = sheet?.provider ?? (!startScreen && activeSession ? activeSession.provider : engine);
  const focusedTheme = sheet?.theme ?? engineTheme(appearance[focusedProvider], appTheme);
  const focusedLook = appearance[focusedProvider][focusedTheme];
  useEffect(() => setRootTheme(focusedTheme), [focusedTheme]);
  useEffect(() => {
    if (single) document.title = singleSession ? `${singleSession.purpose} — Achmage Workbench` : "Achmage Workbench";
  }, [single, singleSession?.purpose]);

  // ── work screen modes (design 3.2): 대화 · 문서 · 검토 · 나란히 · 읽기, while a document is open ──
  const lastDoc = useRef<Record<string, string>>({});
  const shownDoc = view.kind === "document" || view.kind === "split" ? view.artifactId : null;
  useEffect(() => {
    if (work && shownDoc) lastDoc.current[work.id] = shownDoc;
  }, [work, shownDoc]);
  /** The document a pane's modes are about: the one shown, else the one shown last in its work. */
  const modeDocFor = (at: View, owner: Work | undefined, ids: string[]) => {
    if (at.kind === "document" || at.kind === "split") return at.artifactId;
    const remembered = owner ? lastDoc.current[owner.id] : undefined;
    return remembered && ids.includes(remembered) ? remembered : (ids[ids.length - 1] ?? null);
  };
  const modeDocId = modeDocFor(view, work, openDocIds);
  const [reading, setReading] = useState<{ artifactId: string; start: ReadingPosition } | null>(null);
  const workMode: WorkMode | null = work && modeDocId && !startScreen ? modeOf(view, Boolean(reading)) : null;
  const reviewTarget = modeDocId ? reviewProposal(state, modeDocId) : null;
  const setWorkMode = (mode: WorkMode) => {
    if (!work || !modeDocId || mode === workMode) return;
    if (mode === "read") {
      // Start reading where the document is read now (or was, when it is not on screen).
      const body = workMode === "doc" || workMode === "split" ? document.querySelector<HTMLElement>(FOCUSED_DOC) : null;
      setReading({ artifactId: modeDocId, start: body ? readingPosition(body) : (keptPosition(`doc:${modeDocId}`) ?? { page: null, fraction: 0 }) });
      return;
    }
    if (mode === "review" && !reviewTarget) return setToast("검토할 수정안이 없습니다.");
    if (mode === "split" && layout.panes.length > 1) return setToast("두 칸으로 볼 때는 '나란히'를 쓰지 않습니다. 문서를 다른 칸으로 끌어 놓으세요.");
    setReading(null);
    setView(viewFor(mode, { docId: modeDocId, proposalId: reviewTarget?.id ?? null, from: workMode, chatDraft: `work:${work.id}:${activeSession?.id ?? "none"}` }));
  };
  useWorkModeKeys(workMode !== null, setWorkMode);
  const closeReader = (position: ReadingPosition) => {
    if (!reading) return;
    keepPosition(`doc:${reading.artifactId}`, position);
    setReading(null);
    // Back to the same page in the document, when it is on screen.
    window.requestAnimationFrame(() => {
      const body = document.querySelector<HTMLElement>(FOCUSED_DOC);
      if (body) restorePosition(body, position);
    });
  };
  // Reading ends with its work (another work, home, a closed tab).
  const readingWork = reading ? state.artifacts[reading.artifactId]?.workId : undefined;
  useEffect(() => {
    if (reading && (!workMode || readingWork !== work?.id)) setReading(null);
  }, [reading, workMode, readingWork, work?.id]);
  // The compare view of a proposal is "검토"; closing it is "문서" again (in the pane showing it).
  const reviewOf = useMemo(() => {
    const review = (id: PaneId) => (proposalId: string | null) =>
      setViewOf(id, (current) => (current.kind === "document" && current.proposalId !== proposalId ? { ...current, proposalId } : current));
    return { a: review("a"), b: review("b") };
  }, [setViewOf]);
  const modeBar = workMode ? <WorkModeBar mode={workMode} onMode={setWorkMode} canReview={Boolean(reviewTarget)} canSplit={layout.panes.length < 2} /> : null;
  /** The other pane's bar, as it is: a press there gives that pane the focus first, and its bar is then this one. */
  const barFor = (pane: Pane<View>, owner: Work | undefined, ids: string[]) => {
    const docId = owner ? modeDocFor(pane.view, owner, ids) : null;
    const mode = docId ? modeOf(pane.view, false) : null;
    return mode && docId ? <WorkModeBar mode={mode} onMode={() => undefined} canReview={Boolean(reviewProposal(state, docId))} canSplit={false} /> : null;
  };

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

  // "세션 잇기": its actions, the start dialog and "주고받은 내용" (links.ts).
  const linkApi = useLinkApi({
    api,
    state,
    visibleSessionId: visibleSession?.id ?? null,
    fail,
    toast: setToast,
    openSession: docActions.openSession,
    openArtifact: docActions.openArtifact,
    copyText,
    pickSavePath: inDesktop ? pickSavePath : null,
  });

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
        const linked = linkOfSession(state, session.id);
        const items: MenuEntry[] = [
          { kind: "item", label: "열기", icon: "chat", hint: "Enter", onSelect: () => openSession(session) },
          ...(single ? [] : [{ kind: "item" as const, label: "오른쪽에 열기", icon: "columns" as const, hint: "Ctrl+클릭", onSelect: () => panesRef.current.placeItem({ kind: "session", id: session.id }, "right") }]),
          ...(single === session.id ? [] : [{ kind: "item" as const, label: "새 창으로 떼어 내기", icon: "openNew" as const, onSelect: () => void detachSession(session.id, session.purpose, inDesktop).catch(fail) }]),
          { kind: "item", label: "이름 바꾸기", icon: "edit", hint: "F2", onSelect: () => setSidebarPending({ rename: session.id }) },
          { kind: "separator" },
          { kind: "item", label: session.pinned ? "고정 풀기" : "고정", icon: "pin", onSelect: () => void api.updateSession(session.id, { pinned: !session.pinned }).catch(fail) },
          {
            kind: "item",
            label: "예약 작업…",
            icon: "clock",
            hint: (() => {
              const count = state.schedules.filter((entry) => entry.sessionId === session.id && entry.enabled).length;
              return count ? `${count}개` : undefined;
            })(),
            onSelect: () => setScheduling(session.id),
          },
          { kind: "item", label: session.muted ? "알림 켜기" : "알림 끄기", icon: "bell", hint: session.muted ? "이 세션은 알리지 않음" : undefined, onSelect: () => void api.updateSession(session.id, { muted: !session.muted }).catch(fail) },
          {
            kind: "item",
            label: unseenNow ? "읽음으로 표시" : "읽지 않음으로 표시",
            icon: unseenNow ? "eye" : "bell",
            onSelect: () => {
              if (!unseenNow && (session.id === visibleSession?.id || session.id === besideSession?.id)) keptUnread.current = session.id;
              void api.updateSession(session.id, { seen: unseenNow }).catch(fail);
            },
          },
          { kind: "separator" },
          linked
            ? {
                kind: "submenu",
                label: `세션 잇기 ⇄ ${hopsText(linked)}${linked.state === "paused" ? " · 멈춤" : ""}`,
                icon: "link",
                items: [
                  linked.state === "active"
                    ? { kind: "item", label: "멈춤", onSelect: () => linkApi.pause(linked) }
                    : { kind: "item", label: "이어 가기", onSelect: () => linkApi.resume(linked) },
                  { kind: "item", label: "+1왕복", onSelect: () => linkApi.extend(linked) },
                  { kind: "item", label: "주고받은 내용", onSelect: () => linkApi.openView(linked.id) },
                  { kind: "separator" },
                  { kind: "item", label: "끊기", danger: true, onSelect: () => linkApi.stop(linked) },
                ],
              }
            : { kind: "item", label: "세션 잇기…", icon: "link", hint: "다른 세션과 주고받기", onSelect: () => linkApi.openDialog([session.id]) },
          ...(pkmHandle.current?.tree?.status.path && !busy ? [{ kind: "item" as const, label: "인사이트 초안…", icon: "bulb" as const, onSelect: () => pkmHandle.current?.setDialog({ kind: "insight", sessionId: session.id }) }] : []),
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
          ...(single ? [] : [{ kind: "item" as const, label: "오른쪽에 열기", icon: "columns" as const, hint: "Ctrl+클릭", onSelect: () => panesRef.current.placeItem({ kind: "work", id: owner.id }, "right") }]),
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
          { kind: "item", label: "템플릿으로 새 페이지…", icon: "page", onSelect: () => pkmHandle.current?.setDialog({ kind: "template", workId: owner.id, parentId: null }) },
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
        items.splice(1, 0, { kind: "item", label: "프로젝트 페이지", icon: "project", onSelect: () => actions.openProject(owner) }, { kind: "item", label: "카드로 보기", icon: "grid", onSelect: () => setView({ kind: "pkm", target: { kind: "work", id: owner.id } }) });
        return { x, y, title: owner.title, items };
      }
      if (row.type === "folder") {
        const folder = row.folder;
        const items: MenuEntry[] = [
          { kind: "item", label: "카드로 보기", icon: "grid", onSelect: () => setView({ kind: "pkm", target: { kind: "folder", id: folder.id } }) },
          ...(single ? [] : [{ kind: "item" as const, label: "오른쪽에 카드로 보기", icon: "columns" as const, hint: "Ctrl+클릭", onSelect: () => panesRef.current.placeItem({ kind: "folder", id: folder.id }, "right") }]),
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
          ...(single ? [] : [{ kind: "item" as const, label: "오른쪽에 열기", icon: "columns" as const, hint: "Ctrl+클릭", onSelect: () => panesRef.current.placeItem({ kind: "doc", id: artifact.id }, "right") }]),
          ...(artifact.format === "markdown"
            ? [
                { kind: "item" as const, label: "하위 페이지", icon: "plus" as const, onSelect: () => sidebarActions.newSubpage?.(artifact) },
                { kind: "item" as const, label: "템플릿으로 하위 페이지…", icon: "page" as const, onSelect: () => pkmHandle.current?.setDialog({ kind: "template", workId: artifact.workId, parentId: artifact.id }) },
              ]
            : []),
          { kind: "item", label: "다른 앱으로 열기", icon: "arrowRight", onSelect: () => void api.openExternal(artifact.id).catch(fail) },
          ...(inDesktop ? [{ kind: "item" as const, label: "파일 위치 열기", icon: "folderOpen" as const, onSelect: () => void openPath(artifact.path, true) }] : []),
          { kind: "item", label: "경로 복사", icon: "copy", onSelect: copy(artifact.path, "경로를 복사했습니다.") },
        ];
        return { x, y, title: artifact.name, items };
      }
      return null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, state, actions, archive, exportSession, openPath, openSession, visibleSession?.id, besideSession?.id, startNew, docActions, fail, setToast, linkApi, single],
  );

  function openWorkNow(target: Work) {
    // The session that needs the user: 확인 필요 › 오류 › 새 답 › the one looked at last (entry.ts),
    // shown at once (no other session flashes by and gets marked read).
    const latest = state.works[target.id] ?? target;
    const chosen = sessionToOpen(state, latest);
    // A detached window stays one window: it switches to that session.
    if (single) {
      if (chosen) actions.selectSession(latest, chosen);
      return;
    }
    panesRef.current.focusIfShown(chosen ? `session:${chosen.id}` : `work:${latest.id}`);
    if (chosen && chosen.id !== latest.activeSessionId) {
      dispatch({ type: "focus", work: latest, session: chosen });
      void api?.updateWork(latest.id, { activeSessionId: chosen.id }).catch(fail);
    }
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
    newSubpage: (artifact) => void pkmHandle.current?.client.subpage(artifact.id, "").then(revealPage).catch(fail),
    sessionPage: (session, target) =>
      void pkmHandle.current?.client
        .sessionPage(session.id, target.id)
        .then((page) => setToast({ text: `「${target.title}」에 세션 기록 페이지를 만들었습니다: ${page.name}`, action: { label: "열기", run: () => revealPage(page) } }))
        .catch(fail),
    archive,
    openSearch: () => setPaletteOpen("palette"),
    openArchive: () => setView({ kind: "archive" }),
    linkSessions: (pair) => linkApi.openDialog(pair.map((session) => session.id)),
    importConversations: () => setImportOpen(true),
    openRight: single ? undefined : (item) => placeItem(item, "right"),
  };

  const visibleLink = visibleSession ? linkOfSession(state, visibleSession.id) : null;
  const paletteCommands: PaletteCommand[] = [
    // A detached window stays on its session: no home, no new session there.
    ...(single
      ? []
      : [
          { id: "new", label: "새 세션", icon: "plus" as const, hint: "Ctrl+N", run: () => startNew(null) },
          { id: "home", label: "홈", icon: "home" as const, run: () => startNew(null) },
        ]),
    ...(visibleSession
      ? [
          { id: "export-work", label: "지금 대화를 마크다운으로 저장 (작업 폴더)", icon: "markdown" as const, run: () => void exportSession(visibleSession, "work") },
          { id: "export-copy", label: "지금 대화를 마크다운으로 복사", icon: "copy" as const, run: () => void exportSession(visibleSession, "text") },
          ...(single
            ? []
            : [{ id: "detach", label: "지금 세션을 새 창으로 떼어 내기", icon: "openNew" as const, run: () => void detachSession(visibleSession.id, visibleSession.purpose, inDesktop).catch(fail) }]),
        ]
      : []),
    visibleLink
      ? { id: "link-view", label: `주고받은 내용 보기 (세션 잇기 ${hopsText(visibleLink)})`, icon: "link" as const, run: () => linkApi.openView(visibleLink.id) }
      : { id: "link", label: "세션 잇기… (다른 세션과 주고받기)", icon: "link" as const, run: () => linkApi.openDialog(visibleSession ? [visibleSession.id] : []) },
    ...(single ? [] : [{ id: "import", label: "다른 곳의 대화 가져오기 (터미널·다른 앱의 Claude Code·Codex)", icon: "restore" as const, run: () => setImportOpen(true) }]),
    { id: "archive", label: "보관함 열기", icon: "archive", run: () => setView({ kind: "archive" }) },
    { id: "sidebar", label: sidebarOpen ? "사이드바 숨기기" : "사이드바 보이기", icon: "sidebar", run: toggleSidebar },
    { id: "theme", label: focusedTheme === "dark" ? "라이트 화면으로" : "다크 화면으로", icon: focusedTheme === "dark" ? "sun" : "moon", run: () => savePrefs({ theme: focusedTheme === "dark" ? "light" : "dark" }) },
    { id: "appearance", label: "엔진 외형 설정", icon: "palette", run: () => appearanceApi.openSettings() },
    { id: "integrations", label: "MCP·스킬 보기", icon: "tool", run: () => setIntegrationsOpen(true) },
    { id: "connections", label: "연결과 설정", icon: "dots", run: () => setMenuOpen(true) },
    { id: "onboarding", label: "처음 안내 다시 보기", icon: "eye", run: () => setOnboardingAgain(true) },
  ];


  // ── two panes: what each shows, opening on a side, focus, close, swap (panes.ts, Panes.tsx) ──
  const pkmKey = (target: PkmTarget) => (target.kind === "vault" || target.kind === "note" ? `${target.kind}:${target.path}` : `cards-${target.kind}:${target.id}`);
  /** What a pane shows, as keys: the same conversation or document is never in both panes. */
  const keysOf = (pane: Pane<View>): string[] => {
    const at = pane.view;
    if (at.kind === "work" || at.kind === "split") {
      const shown = sessionIn(pane);
      return [...(shown ? [`session:${shown.id}`] : pane.workId ? [`work:${pane.workId}`] : []), ...(at.kind === "split" ? [`doc:${at.artifactId}`] : [])];
    }
    if (at.kind === "document") return [`doc:${at.artifactId}`];
    if (at.kind === "project") return [`project:${at.workId}`];
    if (at.kind === "pkm") return [pkmKey(at.target)];
    if (at.kind === "archive") return ["archive"];
    return [`home:${at.folderId ?? ""}`];
  };
  const itemKey = (item: PaneItem): string => {
    if (item.kind === "work") {
      const owner = state.works[item.id];
      const chosen = owner ? sessionToOpen(state, owner) : null;
      return chosen ? `session:${chosen.id}` : `work:${item.id}`;
    }
    if (item.kind === "note" || item.kind === "vault") return pkmKey({ kind: item.kind, path: item.path });
    if (item.kind === "folder") return pkmKey({ kind: "folder", id: item.id });
    return `${item.kind}:${item.id}`;
  };
  const showsItem = (item: PaneItem) => {
    const key = itemKey(item);
    return (pane: Pane<View>) => keysOf(pane).includes(key);
  };
  /** What a pane opened for an item shows. */
  const contentOf = (item: PaneItem): PaneContent<View> | null => {
    if (item.kind === "session") {
      const session = state.sessions[item.id];
      return session ? { view: { kind: "work" }, workId: session.workId, sessionId: session.id } : null;
    }
    if (item.kind === "work") {
      const owner = state.works[item.id];
      return owner ? { view: { kind: "work" }, workId: owner.id, sessionId: sessionToOpen(state, owner)?.id ?? null } : null;
    }
    if (item.kind === "doc") {
      const artifact = state.artifacts[item.id];
      return artifact ? { view: { kind: "document", artifactId: artifact.id, proposalId: null }, workId: artifact.workId, sessionId: null } : null;
    }
    if (item.kind === "project") return state.works[item.id] ? { view: { kind: "project", workId: item.id }, workId: item.id, sessionId: null } : null;
    if (item.kind === "note" || item.kind === "vault") return { view: { kind: "pkm", target: { kind: item.kind, path: item.path } }, workId: null, sessionId: null };
    if (item.kind === "folder") return { view: { kind: "pkm", target: { kind: "folder", id: item.id } }, workId: null, sessionId: null };
    return null;
  };
  /** The session a pane taking the focus shows becomes its work's active one, as opening it does. */
  const showSessionOf = (ownerId: string | null, sessionId: string | null) => {
    const owner = ownerId ? state.works[ownerId] : undefined;
    const session = sessionId ? state.sessions[sessionId] : undefined;
    if (owner && session && session.workId === owner.id && owner.activeSessionId !== session.id) {
      dispatch({ type: "focus", work: owner, session });
      void api?.updateWork(owner.id, { activeSessionId: session.id }).catch(fail);
    }
    if (ownerId && !single) localStorage.setItem(LAST_WORK_KEY, ownerId);
  };
  /** The conversation the focused pane keeps showing once it loses the focus. */
  const keptOf = (pane: Pane<View>) => (pane.view.kind === "work" || pane.view.kind === "split" ? (sessionIn(pane)?.id ?? null) : null);
  const focusPaneNow = (id: PaneId) => {
    const current = layoutRef.current;
    const target = paneById(current, id);
    if (current.focus === id || !target) return;
    updateLayout((latest) => focusPane(latest, id, keptOf(focusedPane(current))));
    showSessionOf(target.workId, target.sessionId);
  };
  /** Already shown in the other pane: the focus goes there (true). */
  const focusIfShown = (key: string) => {
    const id = shownElsewhere(layoutRef.current, (pane) => keysOf(pane).includes(key));
    if (id) focusPaneNow(id);
    return id !== null;
  };
  /** The document on screen dragged to a side of its only pane: it moves there, its conversation stays beside. */
  const movesOut = (current: Layout<View>, item: PaneItem) => {
    const only = current.panes.length === 1 ? current.panes[0]! : null;
    return Boolean(only && item.kind === "doc" && only.view.kind === "document" && only.view.artifactId === item.id && only.workId);
  };
  const effectOf = (item: PaneItem, side: Side) => (movesOut(layoutRef.current, item) ? "split" : dropEffect(layoutRef.current, side, showsItem(item)));
  /** Open something on a side: dropped on a half of the main area, or "오른쪽에 열기". */
  const placeItem = (item: PaneItem, side: Side) => {
    const content = single ? null : contentOf(item);
    if (!content) return;
    const current = layoutRef.current;
    const shows = showsItem(item);
    const leaving = focusedPane(current);
    const conversation = movesOut(current, item);
    const effect = conversation ? "split" : dropEffect(current, side, shows);
    const target = current.panes.length === 2 ? current.panes[side === "left" ? 0 : 1]! : null;
    // The pane the item ends up in takes the focus, with its session.
    const holder = effect === "swap" ? current.panes.find((pane) => pane !== target) : effect === "none" ? target : null;
    const shown = holder ? { workId: holder.workId, sessionId: holder.id === current.focus ? null : holder.sessionId } : effect === "none" ? null : content;
    // "나란히" is one pane's mode: a second pane keeps the side of it the user was on.
    const unsplit: View | null = conversation
      ? { kind: "work" }
      : current.panes.length === 1 && leaving.view.kind === "split" && effect === "split"
        ? leaving.view.focus === "chat"
          ? { kind: "work" }
          : { kind: "document", artifactId: leaving.view.artifactId, proposalId: null }
        : null;
    const keep = conversation ? (sessionIn(leaving)?.id ?? null) : keptOf(leaving);
    const run = () => {
      updateLayout((latest) => placeOnSide(unsplit ? setPane(latest, leaving.id, { view: unsplit }) : latest, content, side, keep, shows));
      if (shown) showSessionOf(shown.workId, shown.sessionId);
    };
    if (effect === "replace" && target) afterLeaving(target.id, content.view, run);
    else if (unsplit) afterLeaving(leaving.id, unsplit, run);
    else run();
  };
  const closePaneNow = (id: PaneId) => {
    const current = layoutRef.current;
    const rest = current.panes.find((pane) => pane.id !== id);
    if (!rest || current.panes.length < 2) return;
    afterLeaving(id, null, () => {
      updateLayout((latest) => closePane(latest, id));
      if (rest.id !== current.focus) showSessionOf(rest.workId, rest.sessionId);
    });
  };
  panesRef.current = { focusIfShown, placeItem };
  const paneActions = useMemo<PaneActions>(() => ({ openBeside: (item) => panesRef.current.placeItem(item, "right") }), []);
  /** A pane's header: what it shows, and what dragging the header carries. */
  const paneHead = (pane: Pane<View>): PaneHead => {
    const at = pane.view;
    const owner = pane.workId ? state.works[pane.workId] : undefined;
    const artifact = at.kind === "document" || at.kind === "split" ? state.artifacts[at.artifactId] : undefined;
    if (artifact) return { title: artifact.name, icon: <FormatBadge format={artifact.format} />, hint: artifact.path, item: { kind: "doc", id: artifact.id } };
    if (at.kind === "work" && owner) {
      const shown = sessionIn(pane);
      return {
        title: shown ? `${owner.title} · ${shown.purpose}` : owner.title,
        icon: shown ? <EngineMark provider={shown.provider} size={14} /> : <Icon name="project" size={14} />,
        hint: owner.cwd,
        item: shown ? { kind: "session", id: shown.id } : { kind: "work", id: owner.id },
      };
    }
    if (at.kind === "project") return { title: `${state.works[at.workId]?.title ?? "프로젝트"} · 프로젝트`, icon: <Icon name="project" size={14} />, item: { kind: "project", id: at.workId } };
    if (at.kind === "pkm") {
      const target = at.target;
      const viewName = target.kind === "view" ? pkmHandle.current?.pkmState?.views.find((entry) => entry.id === target.id)?.name : null;
      return {
        title: pkmTitle(state, target, pkmHandle.current?.tree?.status.name ?? null, viewName),
        icon: <Icon name={target.kind === "note" ? "book" : target.kind === "vault" || target.kind === "folder" ? "folder" : "grid"} size={14} />,
        hint: target.kind === "note" || target.kind === "vault" ? target.path : undefined,
        item: target.kind === "note" || target.kind === "vault" ? { kind: target.kind, path: target.path } : target.kind === "folder" ? { kind: "folder", id: target.id } : null,
      };
    }
    if (at.kind === "archive") return { title: "보관함", icon: <Icon name="archive" size={14} />, item: null };
    return { title: at.kind === "new" && at.folderId ? "새 작업" : "홈", icon: <Icon name="home" size={14} />, item: null };
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
  /** A work's open documents as tabs, in a pane. */
  const tabsIn = (id: PaneId, owner: Work | undefined, ids: string[], at: View) =>
    owner ? (
      <DocTabs
        state={state}
        ids={ids}
        activeId={at.kind === "document" || at.kind === "split" ? at.artifactId : null}
        onConversation={() => setViewOf(id, { kind: "work" })}
        onOpen={(artifactId) => {
          if (focusIfShown(`doc:${artifactId}`)) return;
          setViewOf(id, (current) => (current.kind === "split" ? { ...current, artifactId } : { kind: "document", artifactId, proposalId: null }));
        }}
        onClose={(artifactId) => closeDocIn(id, owner, ids, artifactId)}
      />
    ) : null;
  const tabs = tabsIn(layout.focus, work, openDocIds, view);
  // The conversation, alone or beside a document ("나란히"). A detached window shows its own
  // session, whichever one the work has in front elsewhere; so does a pane without the focus.
  const workView = (shown: Work, session: Session | undefined, pinned: boolean, paneTabs: ReactNode, ids: string[], modes: ModeProps) => (
    <WorkView
      state={state}
      work={pinned && session ? { ...shown, activeSessionId: session.id } : shown}
      actions={actions}
      engine={engine}
      setEngine={setEngine}
      pickFile={inDesktop ? pickFileNative : null}
      tabs={paneTabs}
      openDocIds={ids}
      focusItem={focusItem && focusItem.sessionId === session?.id ? focusItem : null}
      onFocusDone={() => setFocusItem(null)}
      sidebarOpen={sidebarOpen}
      prefs={prefs}
      modes={modes}
    />
  );
  /** Each pane wears its own engine's paper; the focused one the look in focus (and the one being edited). */
  const paneScope = (pane: Pane<View>, focused: boolean): PaneScope => {
    const owner = pane.workId ? state.works[pane.workId] : undefined;
    const shown = sessionIn(pane);
    const home = pane.view.kind === "new" || (pane.view.kind === "work" && !owner);
    const provider: Provider = focused ? focusedProvider : !home && shown ? shown.provider : engine;
    const theme = focused ? focusedTheme : engineTheme(appearance[provider], appTheme);
    const look = focused ? focusedLook : appearance[provider][theme];
    return { theme, bubble: look.bubble, frame: look.frame, glow: look.glow, style: lookStyle(look) };
  };
  /** What a pane shows: the focused one exactly as the main area always has; the other with its own work, session and tabs. */
  const paneView = (pane: Pane<View>, focused: boolean, split: boolean): ReactNode => {
    const at = pane.view;
    const owner = focused ? work : pane.workId ? state.works[pane.workId] : undefined;
    const session = focused ? activeSession || undefined : sessionIn(pane);
    const ids = focused ? openDocIds : docsOf(owner);
    const paneTabs = focused ? tabs : tabsIn(pane.id, owner, ids, at);
    const bar = focused ? modeBar : barFor(pane, owner, ids);
    const pinned = focused ? Boolean(single) : true;
    const start = at.kind === "new" || (at.kind === "work" && !owner);
    if ((at.kind === "document" || at.kind === "split") && owner) {
      // Next to its own conversation in the other pane, a document needs no drawer of it.
      const besideChat = split && Boolean(session) && layout.panes.some((other) => other.id !== pane.id && other.view.kind === "work" && sessionIn(other)?.id === session?.id);
      return (
        <Suspense fallback={<LoadingView label="문서를 여는 중…" shape="document" />}>
          <SplitView
            split={at.kind === "split"}
            ratio={typeof prefs.splitRatio === "number" ? prefs.splitRatio : 0.5}
            onRatio={(ratio) => savePrefs({ splitRatio: ratio })}
            focus={at.kind === "split" ? at.focus : "doc"}
            onFocus={(side) => setViewOf(pane.id, (current) => (current.kind === "split" && current.focus !== side ? { ...current, focus: side } : current))}
            tabs={paneTabs}
            left={(slot) => workView(owner, session, pinned, null, ids, { bar, slot, draftKey: at.kind === "split" ? at.draftKey : undefined, split: true, single: Boolean(single) })}
            right={(slot) => (
              <DocumentView
                key={at.artifactId}
                api={api}
                state={state}
                artifactId={at.artifactId}
                focusProposalId={at.kind === "document" ? at.proposalId : null}
                work={owner}
                session={session ?? null}
                tabs={at.kind === "split" ? null : paneTabs}
                openDocIds={ids}
                onLeaveGuard={guardOf[pane.id]}
                onBack={() => setViewOf(pane.id, { kind: "work" })}
                onToast={setToast}
                onOpenArtifact={(artifactId) => setViewOf(pane.id, { kind: "document", artifactId, proposalId: null })}
                onPickTarget={() => actions.pickSession(owner, session ?? null)}
                onAnswer={(answered, itemId, decision) => actions.answer(answered, itemId, decision)}
                onSend={async (target, text, refs, handoffTo, create, attachments) => {
                  let source = target;
                  if (!source) source = await actions.newSession(owner, engine);
                  if (!source) return false;
                  if (handoffTo) return actions.handoff(source, handoffTo, text, refs, attachments);
                  return actions.send(source, text, refs, create, "auto", attachments);
                }}
                modes={{ bar, slot, draftKey: at.kind === "split" ? at.draftKey : undefined, split: at.kind === "split" || besideChat, onReview: reviewOf[pane.id] }}
              />
            )}
          />
        </Suspense>
      );
    }
    if (at.kind === "project") {
      return (
        <ProjectView
          api={api}
          state={state}
          workId={at.workId}
          onOpenSession={(target, itemId) => {
            openSession(target);
            if (itemId) setFocusItem({ sessionId: target.id, itemId, nonce: Date.now() });
          }}
          onOpenProject={actions.openProject}
          onOpenNote={(path) => setView({ kind: "pkm", target: { kind: "note", path } })}
          onOpenDocument={(artifactId, proposalId) => {
            const artifact = state.artifacts[artifactId];
            if (artifact) setWorkId(artifact.workId);
            setView({ kind: "document", artifactId, proposalId });
          }}
          onToast={setToast}
          onError={fail}
          openMenu={setContextMenu}
        />
      );
    }
    if (at.kind === "pkm") return <PkmCenter target={at.target} />;
    if (at.kind === "archive") return <ArchiveView state={state} onRestore={actions.restore} onOpenSession={openSession} onOpenWork={openWorkNow} onClose={() => setView({ kind: "work" })} />;
    if (start) {
      return (
        <StartView
          state={state}
          folderId={at.kind === "new" ? at.folderId : null}
          onClearFolder={() => setView({ kind: "new", folderId: null })}
          onStart={(text, provider, cwd, choice, pick) => startWork(text, provider, cwd, at.kind === "new" ? at.folderId : null, choice, pick)}
          onOpenWork={openWorkNow}
          onOpenProject={actions.openProject}
          onOpenSession={openSession}
          onOpenDoc={(artifactId) => docActions.openArtifact(artifactId)}
          api={api}
          homeMode={prefs.homeMode}
          onHomeMode={(mode) => savePrefs({ homeMode: mode })}
          motion={prefs.brandMotion !== false}
          pickFolder={inDesktop ? pickFolderNative : null}
          engine={engine}
          setEngine={setEngine}
        />
      );
    }
    return owner ? workView(owner, session, pinned, paneTabs, ids, { bar, single: Boolean(single), paned: split }) : null;
  };
  const title =
    single && singleSession && work
      ? `${work.title} · ${singleSession.purpose}`
      : view.kind === "archive"
        ? "보관함"
        : view.kind === "project"
          ? `${state.works[view.workId]?.title ?? "프로젝트"} · 프로젝트`
          : view.kind === "pkm"
          ? pkmTitle(state, view.target, pkmHandle.current?.tree?.status.name ?? null, view.target.kind === "view" ? pkmHandle.current?.pkmState?.views.find((entry) => view.target.kind === "view" && entry.id === view.target.id)?.name : null)
          : showStart
            ? view.kind === "new" && view.folderId
              ? "새 작업"
              : "홈"
            : (work?.title ?? "");

  return (
    <AppearanceContext.Provider value={appearanceApi}>
    <UnseenContext.Provider value={unseen}>
    <DocContext.Provider value={{ state, actions: docActions }}>
    <LinkContext.Provider value={linkApi}>
    <PaneActionsContext.Provider value={single ? null : paneActions}>
    <PkmProvider
      api={api}
      state={state}
      onToast={setToast}
      target={view.kind === "pkm" ? view.target : null}
      onOpen={(target) => {
        focusIfShown(pkmKey(target));
        setView({ kind: "pkm", target });
      }}
      onShowSession={actions.selectSession}
      onShowWork={openWorkNow}
      onMenu={setContextMenu}
      handle={pkmHandle}
      onOpenArtifact={revealPage}
    >
    <div
      className="app look-scope"
      data-theme={focusedTheme}
      data-bubble={focusedLook.bubble}
      data-frame={focusedLook.frame ? "on" : "off"}
      data-glow={focusedLook.glow}
      style={lookStyle(focusedLook)}
    >
      <header className="topbar">
        <div className="topbar-left">
          {single ? (
            <span className="brand" aria-label="Achmage">
              <Wordmark className="brand-wordmark" />
              <BrandSymbol className="brand-compact" size={26} />
            </span>
          ) : (
            <>
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
            </>
          )}
          {!sidebarOpen && !single ? (
            <>
              <button type="button" className="ghost-button" onClick={() => startNew(null)} title="새 세션 (Ctrl+N)">
                <Icon name="plus" size={15} /> 새 세션
              </button>
              <button type="button" className="ghost-button" onClick={() => setPaletteOpen("palette")} title="찾기 (Ctrl+K)">
                <Icon name="search" size={15} /> 찾기
                {unseen.size ? <span className="count-chip new" title="새 답">{unseen.size}</span> : null}
              </button>
            </>
          ) : null}
        </div>
        {editingTitle && work && view.kind === "work" && !single ? (
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
            title={work && view.kind === "work" && !showStart && !single ? "눌러서 작업 이름 바꾸기" : title}
            onClick={() => work && view.kind === "work" && !showStart && !single && setEditingTitle(true)}
          >
            {title}
          </button>
        )}
        <div className="topbar-right">
          {pendingApprovals.length && !single ? (
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
                browser={state.browser}
                browserActions={browserActions}
                providers={state.providers}
                connected={state.connected}
                hostLabel={state.hostLabel}
                themePref={themePref}
                onTheme={(pref) => savePrefs({ theme: pref })}
                onAppearance={() => {
                  closeMenu();
                  appearanceApi.openSettings();
                }}
                onRefresh={() => void api.refreshProviders().catch(fail)}
                engineActions={engineActions}
                startScreen={prefs.startScreen === "last" ? "last" : "home"}
                onStartScreen={(next) => savePrefs({ startScreen: next })}
                brandMotion={prefs.brandMotion !== false}
                onBrandMotion={(next) => savePrefs({ brandMotion: next })}
                notifications={prefs.notify !== false}
                onNotifications={(next) => savePrefs({ notify: next })}
                onPropertyTemplate={() => {
                  closeMenu();
                  setPropertyTemplateOpen(true);
                }}
                shortcutSettings={
                  <ShortcutSettings
                    shortcuts={shortcuts}
                    onChange={(id, combo) => {
                      const saved = { ...((prefs.shortcuts as Record<string, string> | undefined) ?? {}) };
                      if (combo) saved[id] = combo;
                      else delete saved[id];
                      savePrefs({ shortcuts: saved });
                    }}
                    onRecording={setRecordingShortcut}
                  />
                }
                imageUpload={
                  <ImageUploadRow
                    api={api}
                    onOpen={() => {
                      closeMenu();
                      setImageUploadOpen(true);
                    }}
                  />
                }
                vault={<VaultSettingsRow onOpen={closeMenu} />}
                worksDir={<WorksDirRow api={api} pickFolder={inDesktop ? (start) => pickFolderNative("새 프로젝트 폴더 위치", start) : null} />}
              />
            </Popover>
          </div>
        </div>
      </header>

      <div className={`body${sidebarOpen && state.ready ? " with-sidebar" : ""}`}>
      {sidebarOpen && state.ready ? (
        <Sidebar
          state={state}
          currentWorkId={view.kind === "work" || view.kind === "document" || view.kind === "split" ? work?.id ?? null : null}
          visibleSessionId={visibleSession?.id ?? null}
          currentDocId={view.kind === "document" || view.kind === "split" ? view.artifactId : null}
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
        <LoadingView label="불러오는 중…" shape="work" />
      ) : single && !singleSession ? (
        <main className="loading">이 세션을 찾을 수 없습니다. 보관했거나 지운 세션일 수 있습니다.</main>
      ) : (
        <PaneLayout
          layout={layout}
          enabled={!single}
          ratio={readRatio(prefs.paneRatio)}
          onRatio={(ratio) => savePrefs({ paneRatio: ratio })}
          onFocus={focusPaneNow}
          onClose={closePaneNow}
          onSwap={() => updateLayout(swapPanes)}
          onDrop={placeItem}
          head={paneHead}
          scope={paneScope}
          effectOf={effectOf}
          render={(pane, info) => paneView(pane, info.focused, info.split)}
          onNarrow={setNarrowPanes}
        />
      )}
      </div>
      {reading && state.artifacts[reading.artifactId] ? (
        <Suspense fallback={null}>
          <Reader api={api} state={state} artifact={state.artifacts[reading.artifactId]!} start={reading.start} onClose={closeReader} />
        </Suspense>
      ) : null}

      {integrationsOpen && api ? <IntegrationsSheet api={api} onClose={() => setIntegrationsOpen(false)} onToast={setToast} /> : null}
      {imageUploadOpen && api ? <ImageUploadSheet api={api} onClose={() => setImageUploadOpen(false)} onToast={setToast} /> : null}
      {state.ready && api && (prefs.onboarding !== "done" || onboardingAgain) ? (
        <Onboarding
          providers={state.providers}
          tools={state.tools}
          engineActions={engineActions}
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
          mode={paletteOpen}
          onOpenSession={openSession}
          onOpenHit={(session, itemId) => {
            openSession(session);
            setFocusItem({ sessionId: session.id, itemId, nonce: Date.now() });
          }}
          onOpenWork={openWorkNow}
          onOpenProject={single ? undefined : actions.openProject}
          onOpenDoc={(artifact) => docActions.openArtifact(artifact.id)}
          onOpenNote={single ? undefined : (path) => setView({ kind: "pkm", target: { kind: "note", path } })}
          onOpenView={single ? undefined : (id) => setView({ kind: "pkm", target: { kind: "view", id } })}
          onClose={() => setPaletteOpen(null)}
        />
      ) : null}
      {switcher !== null ? <Switcher state={state} sessions={switchable} index={switcher} unseen={unseen} /> : null}
      <LinkLayer api={api} inDesktop={inDesktop} />
      {propertyTemplateOpen ? <TemplateDialog api={api} onClose={() => setPropertyTemplateOpen(false)} onSaved={() => setToast("속성 템플릿을 저장했습니다. 모든 프로젝트의 속성 칸이 따릅니다.")} onError={fail} /> : null}
      {importOpen ? <ImportDialog api={api} onClose={() => setImportOpen(false)} onOpen={openImported} onError={fail} /> : null}
      {reviewing && state.sessions[reviewing]?.worktree ? (
        <WorktreeReview api={api} session={state.sessions[reviewing]} onClose={() => setReviewing(null)} onToast={setToast} onError={fail} />
      ) : null}
      {scheduling && state.sessions[scheduling] ? (
        <ScheduleDialog api={api} session={state.sessions[scheduling]} schedules={state.schedules} onClose={() => setScheduling(null)} onError={fail} />
      ) : null}
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
    </PaneActionsContext.Provider>
    </LinkContext.Provider>
    </DocContext.Provider>
    </UnseenContext.Provider>
    </AppearanceContext.Provider>
  );
}
