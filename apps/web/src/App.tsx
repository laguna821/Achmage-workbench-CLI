import { DesktopTargetPicker } from "./components/DesktopTargetPicker.tsx";
import { MobilePushSettings } from "./components/MobilePushSettings.tsx";
import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { GLOBAL_LAYOUT, PROVIDER_LABEL, isUnseen, type AccessMode, type Artifact, type Attachment, type CreateTarget, type DocRef, type DocumentRemovalPlan, type ProjectPick, type Proposal, type Provider, type Session, type SessionStatus, type UiPrefs, type Work, type Workspace } from "@workbench/contracts";
import { Api, ApiRequestError, readToken } from "./api.ts";
import { saveBlobAs } from "./mobile-platform.ts";
import { VoiceEnvironment } from "./voice/context.ts";
import { ExtensionLibrary } from "./components/ExtensionLibrary.tsx";
import { EventHub } from "./components/EventHub.tsx";
import { PhoneMessenger } from "./components/PhoneMessenger.tsx";
import { AttentionInbox, CompletionNotifications, ShownPanels, ShownPanelsContext, completionSurface, sessionsOnScreen, visibleSessionIds, watchAttentionPresence } from "./completion-notifications.ts";
import { SharedBrowser, type BrowserNativeCommand } from "./browser-state.ts";
import { BrowserView, NewBrowserDialog, openBrowserTab, type BrowserTarget } from "./components/BrowserView.tsx";
import type { AttentionPayload, SequencedEvent } from "@workbench/contracts";
import { useOfficeControl } from "./office-control.ts";
import { configureDesign } from "./design.ts";
import { initialState, isBusy, reducer, sessionsOf } from "./state.ts";
import { becomesActive, lookingChangesState, opensBeside, restoreRefusal, restoredAgentPlan, sessionEntries, sessionRoute } from "./session-route.ts";
import { applyPanePreset, type PanePreset } from "./layout-presets.ts";
import { WorkspaceLayoutTools, PaneStart, WorkLinkDialog } from "./components/WorkspaceLayoutTools.tsx";
import { newRequestId, titleFrom, statusText } from "./format.ts";
import { folderChoices, readOpenState, workSessions, type Move, type Row, type SortMode, type TreeOpenState } from "./tree.ts";
import { Connections } from "./components/Connections.tsx";
import type { BrowserActions } from "./components/BrowserPill.tsx";
import { EditableText } from "./components/EditableText.tsx";
import { Icon } from "./components/Icon.tsx";
import { TopNotice } from "./components/TopNotice.tsx";
import { EMPTY_NOTICES, asSlot, failure, noticeReducer, type Notify } from "./top-notice.ts";
import { Wordmark, BrandSymbol } from "./components/BrandMark.tsx";
import { Popover } from "./components/Popover.tsx";
import { Sidebar, type SidebarActions } from "./components/Sidebar.tsx";
import { RightSidebar, sideNoteOf, useRightSidebar } from "./components/right/RightSidebar.tsx";
import { requestNavigatorFocus } from "./components/nav/focus.ts";
import { FromMenu } from "./components/nav/dialogs.tsx";
import type { DocModes } from "./components/note/ConversationHead.tsx";
import { addShortcuts, readShortcuts, sameShortcut } from "./components/nav/model.ts";
import { RenameDialog } from "./components/RenameDialog.tsx";
import { documentAttentionSession, type AgentReveal } from "./components/docs/document-modes.ts";
import { ContextMenu, type MenuEntry, type MenuRequest } from "./components/ContextMenu.tsx";
import { createActions, creationWorkspace, type CreateAction } from "./create-actions.ts";
import { NewDirectoryDialog } from "./components/NewDirectoryDialog.tsx";
import { SearchPalette, type PaletteCommand, type PaletteMode } from "./components/SearchPalette.tsx";
import { ArchiveView } from "./components/ArchiveView.tsx";
import { ProjectDeleteDialog } from "./components/ProjectDeleteDialog.tsx";
import { ConfirmDialog } from "./components/ConfirmDialog.tsx";
import { EditorRegistry, leaveEditors, removeAfterSaving, type EditorHandle } from "./doc-editors.ts";
import { StartView, useEngineChoice } from "./components/StartView.tsx";
import { WorkView, type WorkActions } from "./components/WorkView.tsx";
import type { DrawState } from "./components/ImageGen.tsx";
import { AppearanceSheet, type SheetTarget } from "./components/AppearanceSheet.tsx";
import { EngineMenu } from "./components/EngineMenu.tsx";
import { Switcher, UnseenContext } from "./components/SessionCards.tsx";
import { DocContext, FormatBadge, type DocActions } from "./components/DocCards.tsx";
import { GroupTabs } from "./components/GroupTabs.tsx";
import { TaskPanel } from "./components/TaskPanel.tsx";
import { AttentionCenter } from "./components/AttentionCenter.tsx";
import { TerminalDialog } from "./components/TerminalDialog.tsx";
import { WorkspaceServices } from "./components/WorkspaceServices.tsx";
import { WorkspacePreparationDialog } from "./components/WorkspacePreparationDialog.tsx";
import { SourceControlDialog } from "./components/SourceControlDialog.tsx";
import { IntegrationsSheet } from "./components/IntegrationsSheet.tsx";
import { ImageUploadRow, ImageUploadSheet } from "./components/ImageUploadSheet.tsx";
import { OfficeSettings } from "./components/OfficeSettings.tsx";
import { BackgroundHost } from "./components/BackgroundHost.tsx";
import { OfficeDrive } from "./components/OfficeDrive.tsx";
import { DropboxDialog } from "./components/DropboxDialog.tsx";
import { KnowledgeLibrary } from "./components/KnowledgeLibrary.tsx";
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
import { FolderTemplateDialog } from "./components/project/FolderTemplateDialog.tsx";
import { LinkContext, hopsText, linkOfSession, useLinkApi } from "./links.ts";
import { Beside, useBesideRoom } from "./components/companion/Beside.tsx";
import { besideOf, isCompanion, readMinimum, oneViewPerDocument, upgradeStoredLayout, viewDocument, viewsOfDocument, viewsOfPage, withoutCompanion, type Companion } from "./companion.ts";
import { createDesk, settleLayout } from "./companion-desk.ts";
import { MoveQuestion } from "./components/companion/MoveQuestion.tsx";
import { keepPosition, keptPosition, modeDocument, modeOf, readingPosition, restorePosition, reviewProposal, useWorkModeKeys, type ModeProps, type ReadingPosition, type WorkMode } from "./workmodes.ts";
import { detachSession, showInWindow, windowSession } from "./windows.ts";
import { PkmProvider, type PkmApi } from "./components/pkm/PkmContext.tsx";
import { VaultDialogHost, VaultSettingsRow } from "./components/pkm/VaultDialog.tsx";
import { PkmCenter, pkmTitle } from "./components/pkm/PkmCenter.tsx";
import { ProjectView } from "./components/project/ProjectView.tsx";
import type { PkmTarget } from "./pkm.ts";
import { entryClient, homeTarget, sessionToOpen, unseenFailure } from "./entry.ts";
import { isWorking } from "./overview.ts";
import { WorksDirRow } from "./components/WorksDirRow.tsx";
import { EngineMark } from "./components/EngineMark.tsx";
import { LeaveGate } from "./leave-gate.ts";
import { LayoutPersistence, keepChosen } from "./layout-persistence.ts";
import { activeTab, activateTab, addBackgroundTab, closeTab, contentKey, dropTabs, findTab, moveTab, tabsOf, updateTabUi, updateTabView, withTabs } from "./tabs.ts";
import { PaneLayout, type PaneHead, type PaneScope } from "./components/Panes.tsx";
import { NewDocumentDialog, type NewDocumentTarget } from "./components/NewDocumentButton.tsx";
import { IeumAppDialog } from "./components/IeumAppDialog.tsx";
import { OfficeImportDialog } from "./components/OfficeImportDialog.tsx";
import { closePane, effectAt, focusPane, focusedPane, movePane, otherPane, paneById, placeAt, resizeSplit, restoreLayout, setPane, shownElsewhere, singleLayout, splitPane, treeOf, minimumSize, MAX_PANES, MIN_PANE, type Layout, type Pane, type PaneContent, type PaneId, type PaneItem, type PaneTab, type PaneTarget, type Side, type TabUiState } from "./panes.ts";
import { PaneActionsContext, type PaneActions } from "./panedrag.ts";

// Editors (CodeMirror, PDF.js) load only when a document opens.
const DocumentView = lazy(() => import("./components/docs/DocumentView.tsx"));
const Reader = lazy(() => import("./components/Reader.tsx"));
const TerminalView = lazy(() => import("./components/TerminalView.tsx"));
import { AppearanceContext, DEFAULT_APPEARANCE, engineTheme, lookStyle, readAppearance, type AppearanceApi } from "./appearance.ts";
import { isThemePref, resolveTheme, setRootTheme, useSystemTheme, type ThemePref } from "./theme.ts";

const PREFS_CACHE_KEY = "workbench.prefsCache";

function readCachedPrefs(key = PREFS_CACHE_KEY): UiPrefs {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}") as UiPrefs;
  } catch {
    return {};
  }
}
const desktopRuntime = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
async function sharedBrowserNative<T>(command: BrowserNativeCommand): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>("shared_browser", { command });
}

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

/** Claimed host fallback: generic copy and an opaque attention id, never local titles or text. */
async function notifyAttention(payload: AttentionPayload, onOpen: (id: string) => void) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("notify_attention", { title: payload.title, body: payload.body, attentionId: payload.attentionId });
  } catch (error) {
    // Only an explicit unsupported result permits another adapter. Unknown delivery is not retried.
    if (String(error) !== "unsupported") throw error;
    if (typeof Notification === "undefined") throw new Error("이 화면에서는 시스템 알림을 표시할 수 없습니다. 알림 목록에서 확인해 주세요.");
    const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    if (permission !== "granted") throw new Error("시스템 알림 권한이 없습니다. 알림 목록에서 확인해 주세요.");
    const notification = new Notification(payload.title, { body: payload.body, tag: payload.attentionId });
    notification.onclick = () => { window.focus(); notification.close(); onOpen(payload.attentionId); };
  }
}

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
    filters: [{ name: "문서", extensions: ["md", "markdown", "html", "htm", "pdf", "hwpx", "hwp", "txt", "docx", "pptx", "xlsx", "xlsm", "xmind", "epub"] }],
  });
  return typeof picked === "string" ? picked : null;
}

/** Where to save a Markdown export (desktop save dialog); null when cancelled. */
async function pickSavePath(defaultPath: string): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ title: "마크다운으로 내보내기", defaultPath, filters: [{ name: "Markdown", extensions: ["md"] }] });
}

async function openExternal(url: string) {
  if (desktopRuntime) {
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
  /** A conversation; `beside`: the document or web page open beside it, in its tab (곁 화면). */
  | { kind: "work"; beside?: Companion }
  | { kind: "new"; folderId: string | null }
  | { kind: "archive" }
  | { kind: "terminal"; terminalId: string; workspaceId: string; label: string }
  | { kind: "browser"; pageId: string }
  | { kind: "document"; artifactId: string; proposalId: string | null }
  | { kind: "presentation"; id: string; artifactId: string; ownerTabId: string }
  /** Cards of a vault folder, an app folder, a work or a saved view; or one vault note (pkm). */
  | { kind: "pkm"; target: PkmTarget }
  /** A work as a project note (project page). */
  | { kind: "project"; workId: string };


function isView(value: unknown): value is View {
  if (!value || typeof value !== "object") return false;
  const view = value as View;
  if (view.kind === "work") return view.beside === undefined || isCompanion(view.beside);
  if (view.kind === "archive") return true;
  if (view.kind === "new") return view.folderId === null || typeof view.folderId === "string";
  if (view.kind === "project") return typeof view.workId === "string";
  if (view.kind === "terminal") return typeof view.terminalId === "string" && typeof view.workspaceId === "string" && typeof view.label === "string";
  if (view.kind === "browser") return typeof view.pageId === "string";
  if (view.kind === "document") return typeof view.artifactId === "string" && (view.proposalId === null || typeof view.proposalId === "string");
  if (view.kind === "presentation") return typeof view.id === "string" && typeof view.artifactId === "string" && typeof view.ownerTabId === "string";
  if (view.kind !== "pkm" || !view.target || typeof view.target !== "object") return false;
  const target = view.target;
  return target.kind === "note" || target.kind === "vault" ? typeof target.path === "string" : ["folder", "work", "view"].includes(target.kind) && "id" in target && typeof target.id === "string";
}

/** The document body in the focused pane (with two panes, the other may show a document too). */
const FOCUSED_DOC = '.pane[data-pane-active="true"][data-tab-active="true"] .document-view .doc-body';
const readJson = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const SORT_MODES: SortMode[] = ["manual", "recent", "name"];

export function App({ apiOverride, onConnections, connectionsOpen = false, messengerRequest = 0, connectionLabel, registerHostSwitchGuard, attentionRequest, onAttentionOpened }: { apiOverride?: Api | null; onConnections?: () => void; connectionsOpen?: boolean; messengerRequest?: number; connectionLabel?: string; registerHostSwitchGuard?: (guard: (() => Promise<void>) | null) => void; attentionRequest?: { id: string; nonce: string } | null; onAttentionOpened?: (id: string) => void } = {}) {
  const api = useMemo(() => {
    if (apiOverride !== undefined) return apiOverride;
    const token = readToken();
    if (token) configureDesign(token);
    return token ? new Api(token) : null;
  }, [apiOverride]);
  const inDesktop = desktopRuntime && !api?.isRemote;
  const storagePrefix = api?.remoteHostId ? "host:" + api.remoteHostId + ":" : "";
  const LAST_WORK_KEY = storagePrefix + "workbench.lastWork", PREFS_CACHE_KEY = storagePrefix + "workbench.prefsCache",
    PANE_LAYOUT_KEY = storagePrefix + "workbench.paneLayout.v1", OPEN_DOCS_KEY = storagePrefix + "workbench.openDocs", MRU_KEY = storagePrefix + "workbench.recentSessions";
  const cachedPrefs = () => readCachedPrefs(PREFS_CACHE_KEY);
  const [state, dispatch] = useReducer(reducer, initialState);
  const [pushSettingsOpen, setPushSettingsOpen] = useState(false);
  const attentionInbox = useMemo(() => new AttentionInbox(api), [api]);
  const shownPanels = useMemo(() => new ShownPanels(), []);
  const attentionState = useSyncExternalStore(attentionInbox.subscribe, attentionInbox.getState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const layoutPersistence = useMemo(() => api ? new LayoutPersistence(api) : null, [api]);
  const [layoutReady, setLayoutReady] = useState(false);
  const [layoutScope, setLayoutScope] = useState(GLOBAL_LAYOUT);
  const layoutScopeRef = useRef(GLOBAL_LAYOUT);
  const layoutSwitching = useRef(false);
  const layoutSaveTimer = useRef<number | undefined>(undefined);
  const [layoutProblem, setLayoutProblem] = useState<{ key: string; message: string } | null>(null);
  const openWorkspaceRef = useRef<(workspace: Workspace | null) => Promise<boolean>>(async () => false);
  const [terminalWorkspace, setTerminalWorkspace] = useState<Workspace | null>(null);
  const [serviceWorkspace, setServiceWorkspace] = useState<Workspace | null>(null);
  const [preparationWorkspace, setPreparationWorkspace] = useState<Workspace | null>(null);
  const [scmWorkspace, setScmWorkspace] = useState<Workspace | null>(null);
  // A window of its own for one session (`?session=`, "새 창으로 떼어 내기"): no sidebar, no home.
  const [single, setSingle] = useState<string | null>(() => windowSession());
  const sharedBrowser = useMemo(() => new SharedBrowser(api?.sharedBrowser ?? null, inDesktop && !single ? sharedBrowserNative : null), [api, Boolean(single)]);
  const browserState = useSyncExternalStore(sharedBrowser.subscribe, sharedBrowser.getState);
  const seenAgentPages = useRef(new Set<string>());
  const lastNativeInteraction = useRef(0), lastDomInteraction = useRef(0);
  useEffect(() => {
    const remember = () => { lastDomInteraction.current = Date.now(); };
    window.addEventListener("pointerdown", remember, true); window.addEventListener("keydown", remember, true);
    return () => { window.removeEventListener("pointerdown", remember, true); window.removeEventListener("keydown", remember, true); };
  }, []);
  useEffect(() => sharedBrowser.start(), [sharedBrowser]);
  const openBrowserRef = useRef<(paneId: PaneId, target: BrowserTarget & { workId?: string | null }) => Promise<boolean>>(async () => false);
  const browserOpening = useRef(false);
  const [newBrowser, setNewBrowser] = useState<{ paneId: PaneId; workspaceId?: string; profileId?: string; url?: string } | null>(null);
  // One pane on a new profile; an existing layout is restored from gateway preferences after
  // the snapshot. Sidebar/search actions route into the focused pane.
  const [layout, setLayout] = useState<Layout<View>>(() => {
    const fallback = singleLayout<View>(
      windowSession() || (cachedPrefs().startScreen === "last" && localStorage.getItem(LAST_WORK_KEY)) ? { kind: "work" } : { kind: "new", folderId: null },
      localStorage.getItem(LAST_WORK_KEY),
    );
    return oneViewPerDocument(withTabs(windowSession() ? fallback : restoreLayout(upgradeStoredLayout(readJson(PANE_LAYOUT_KEY, null)), isView, fallback)));
  });
  // The layout as last asked for, so changes made in one handler build on each other.
  const layoutRef = useRef(layout);
  // Preview capabilities are transient. The persisted tab stores only its source identity.
  const presentations = useRef(new Map<string, { url: string; title: string }>());
  const updateLayout = useCallback((change: (current: Layout<View>) => Layout<View>) => {
    const changed = change(layoutRef.current);
    if (changed === layoutRef.current) return;
    // A conversation gone to again keeps its companion; a document never has two views.
    const next = settleLayout(changed, layoutRef.current);
    layoutRef.current = next;
    setLayout(next);
  }, []);
  const { view, workId } = focusedPane(layout);
  useEffect(() => {
    const tabs = layout.panes.flatMap(tabsOf), owners = new Set(tabs.map(tab => tab.id));
    const shown = new Set(tabs.flatMap(tab => tab.view.kind === "presentation" ? [tab.view.id] : []));
    for (const id of presentations.current.keys()) if (!shown.has(id)) presentations.current.delete(id);
    let next = layout;
    for (const pane of layout.panes) for (const tab of tabsOf(pane)) {
      if (tab.view.kind === "presentation" && (!owners.has(tab.view.ownerTabId) || !presentations.current.has(tab.view.id)))
        next = closeTab(next, pane.id, tab.id, { view: { kind: "new", folderId: null }, workId: null, sessionId: null });
    }
    if (next !== layout) updateLayout(current => current === layout ? next : current);
  }, [layout, updateLayout]);
  // A document view holding edits only it can save (the Word editor) saves them before it is replaced (one per pane).
  const leaveGate = useRef(new LeaveGate());
  /** The tabs showing a document (set each render; read from the event stream). */
  const documentTabsRef = useRef<(artifactId: string) => { pane: Pane<View>; tab: PaneTab<View> }[]>(() => []);
  const leaveGuards = useRef<Partial<Record<PaneId, (reason?: "close" | "discard") => Promise<void>>>>({});
  const guardOf = useMemo(() => {
    const keep = (id: PaneId) => (guard: ((reason?: "close" | "discard") => Promise<void>) | null) => {
      if (guard) leaveGuards.current[id] = guard;
      else delete leaveGuards.current[id];
    };
    return Object.fromEntries(layout.panes.flatMap((pane) => tabsOf(pane).map((tab) => [tab.id, keep(tab.id)])));
  }, [layout.panes.flatMap((pane) => tabsOf(pane).map((tab) => tab.id)).sort().join(",")]);
  useEffect(() => {
    registerHostSwitchGuard?.(async () => {
      for (const guard of Object.values(leaveGuards.current)) await guard?.();
    });
    return () => registerHostSwitchGuard?.(null);
  }, [registerHostSwitchGuard]);
  useEffect(() => {
    const closed = new Set(browserState.closedPageIds ?? []);
    if (!closed.size) return;
    updateLayout(current => {
      let next = current;
      for (const pane of current.panes) for (const tab of tabsOf(pane)) {
        const pageId = tab.view.kind === "browser" ? tab.view.pageId : undefined;
        if (pageId && closed.has(pageId)) next = closeTab(next, pane.id, tab.id, { view: { kind: "new", folderId: null }, workId: null, sessionId: null });
        // A closed page beside a conversation: the conversation stays, alone.
        const beside = besideOf(tab.view);
        if (beside?.kind === "browser" && closed.has(beside.pageId)) next = withoutCompanion(next, tab.id);
      }
      return next;
    });
  }, [browserState.closedPageIds, state.sessions, updateLayout]);
  const uiOf = useMemo(() => Object.fromEntries(layout.panes.flatMap((pane) => tabsOf(pane).map((tab) => [tab.id, (ui: TabUiState) => updateLayout((current) => updateTabUi(current, tab.id, ui))]))), [updateLayout, layout.panes.flatMap((pane) => tabsOf(pane).map((tab) => tab.id)).sort().join(",")]);
  // 곁 화면's wiring (companion-desk.ts): how a view is left, shown, put beside a conversation and
  // closed. Nothing saves or closes a document's other view by itself; a move is the person's
  // act, asked about first when the view that goes holds an editor.
  /**
   * The person (or the app for them) went somewhere since the window opened: the start-up restore
   * keeps it. Never reset: the start-up restore runs once per window.
   */
  const navigated = useRef(false);
  const selectTabRef = useRef<(paneId: PaneId, tabId: string, then?: () => void) => void>(() => undefined);
  const [moveAsk, setMoveAsk] = useState<{ name: string; certain: boolean; same: boolean; go: () => Promise<void>; drop: () => Promise<void> } | null>(null);
  /** Tabs whose conversation is covered by its companion, for callbacks made once. */
  const coveredRef = useRef<Record<string, boolean>>({});
  const desk = useMemo(() => createDesk<View>({
    layout: () => layoutRef.current,
    update: updateLayout,
    guard: (tabId) => leaveGuards.current[tabId],
    gate: leaveGate.current,
    select: (paneId, tabId, then) => selectTabRef.current(paneId, tabId, then),
    editors: (artifactId) => editors.current.states(artifactId),
    looksSaved: (artifactId) => editors.current.looksSaved(artifactId),
    ask: (artifactId, { certain, same }, go, drop) => setMoveAsk({ name: stateRef.current.artifacts[artifactId]?.name ?? "문서", certain, same, go, drop }),
    covered: (tabId) => Boolean(coveredRef.current[tabId]),
    onNavigate: () => { navigated.current = true; },
    fail: (error) => showNotice({ type: "show", slot: asSlot(failure(error)) }),
    home: { view: { kind: "new", folderId: null }, workId: null, sessionId: null },
    conversation: (beside) => ({ kind: "work", beside }),
    page: (pageId) => {
      const page = sharedBrowser.getState().pages.find((entry) => entry.pageId === pageId);
      return page && page.status !== "closed" ? { view: { kind: "browser", pageId }, workId: page.workId, sessionId: page.sessionId } : null;
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [updateLayout, sharedBrowser]);
  /** `then`, after the pane's view saved what only it can save (see `desk.leave`). `move`: the person's explicit move of a document. */
  const afterLeaving = useCallback((id: PaneId, next: View | null, then: () => void, destination: string | null = null, move = false) => desk.leave(id, next, then, { destination, move }), [desk]);
  const setViewOf = useCallback(
    (id: PaneId, next: View | ((current: View) => View), openedScope?: Pick<Artifact, "workId" | "workspaceId"> & { preserveSource?: boolean }, move = false) => {
      const pane = paneById(layoutRef.current, id);
      if (!pane) return;
      const resolved = typeof next === "function" ? next(pane.view) : next;
      if (resolved === pane.view) return;
      const artifact = resolved.kind === "document" || resolved.kind === "presentation" ? stateRef.current.artifacts[resolved.artifactId] ?? openedScope : undefined;
      const currentSession = pane.sessionId ? stateRef.current.sessions[pane.sessionId] : undefined;
      const changedScope = artifact && (artifact.workId !== pane.workId || artifact.workspaceId && artifact.workspaceId !== currentSession?.workspaceId);
      const content = { view: resolved, workId: artifact?.workId ?? pane.workId, sessionId: changedScope ? null : pane.sessionId };
      const existing = resolved.kind === "new" ? null : findTab(layoutRef.current, contentKey(content));
      const targetId = existing?.pane.id ?? id;
      const show = () => updateLayout((current) => ({ ...setPane(current, targetId, content), focus: targetId }));
      // A completed export may open a new tab after preserving the source's recovery
      // buffer. withTabs keeps that source mounted; opening a conversion is not Save.
      if (openedScope?.preserveSource && targetId === id && (resolved.kind === "document" || resolved.kind === "presentation") && viewDocument(pane.view) !== null) leaveGate.current.run(id, null, show, () => {});
      else afterLeaving(targetId, resolved, show, existing?.tab.id ?? null, move);
    },
    [afterLeaving, updateLayout],
  );
  const setView = useCallback((next: View | ((current: View) => View)) => setViewOf(layoutRef.current.focus, next), [setViewOf]);
  // Pane routing for callbacks made once (menus, actions): filled in below on every render.
  const panesRef = useRef<{ focusIfShown: (key: string) => boolean; placeItem: (item: PaneItem, side: Side) => void }>({ focusIfShown: () => false, placeItem: () => undefined });
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const [imageUploadOpen, setImageUploadOpen] = useState(false);
  const [officeSettingsOpen, setOfficeSettingsOpen] = useState(false);
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [extensionsOpen, setExtensionsOpen] = useState(false), [eventHubOpen, setEventHubOpen] = useState(false), [phoneOpen, setPhoneOpen] = useState(false);
  // The device dialog's "휴대폰 메신저 열기" (it lives outside the app; each press raises the counter).
  useEffect(() => { if (messengerRequest > 0) setPhoneOpen(true); }, [messengerRequest]);
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [workLinksOpen, setWorkLinksOpen] = useState(false);
  const [paneFocus, setPaneFocus] = useState(false);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const [pendingAttentionId, setPendingAttentionId] = useState<string | null>(null);
  const [dropboxOpen, setDropboxOpen] = useState(false);
  const [officeImportOpen, setOfficeImportOpen] = useState(false);
  const [ieumAppOpen, setIeumAppOpen] = useState(false);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [knowledgeMounted, setKnowledgeMounted] = useState(false);
  const openKnowledge = () => { setKnowledgeMounted(true); setKnowledgeOpen(true); };
  const [onboardingAgain, setOnboardingAgain] = useState(false);
  // Documents opened in each work, shown as tabs and offered first by "@".
  const [openDocs, setOpenDocs] = useState<Record<string, string[]>>(() => readJson(OPEN_DOCS_KEY, {}));
  // One status slot in the top bar, in the title's place: completions, action results and errors.
  const [notices, showNotice] = useReducer(noticeReducer, EMPTY_NOTICES);
  const closeNotice = useCallback(() => showNotice({ type: "close" }), []);
  const setToast = useCallback<Notify>((next) => showNotice({ type: "show", slot: asSlot(next) }), []);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  // A rename in progress is never hidden: notices wait (their clocks too) until it commits or cancels.
  const shownNotice = editingTitle ? null : notices.current;
  const standingNotice = editingTitle ? null : layoutProblem;
  const [engine, setEngine] = useEngineChoice();
  const [engineMenu, setEngineMenu] = useState<{ provider: Provider; x: number; y: number } | null>(null);
  const [sheet, setSheet] = useState<SheetTarget | null>(null);
  const [contextMenu, setContextMenu] = useState<MenuRequest | null>(null);
  const [newDocument, setNewDocument] = useState<(NewDocumentTarget & { paneId: PaneId }) | null>(null);
  const [newDirectory, setNewDirectory] = useState<string | null>(null);
  const openCreate = useRef<(anchor?: HTMLElement) => void>(() => undefined);
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

  /** Go to `content` (the pane that has it in a tab, else the focused one). `move`: a document beside a conversation is given its own tab for it. */
  const navigateTo = useCallback((content: PaneContent<View>, opened?: () => void, move = false) => {
    desk.show(layoutRef.current.focus, content, { move, then: () => {
      if (content.workId) localStorage.setItem(LAST_WORK_KEY, content.workId);
      opened?.();
    } });
  }, [desk]);

  const fail = useCallback((error: unknown) => {
    showNotice({ type: "show", slot: asSlot(failure(error)) });
  }, []);
  /** Tabs whose conversation is covered by its companion (no room for both): it is not on screen. */
  const [coveredTabs, setCoveredTabs] = useState<Record<string, boolean>>({});
  coveredRef.current = coveredTabs;
  /** Opening beside the focused conversation, for the actions made once (filled in below on every render). */
  const besideRef = useRef<{ open: (artifactId: string, proposalId?: string | null) => boolean; openPage: (pageId: string) => boolean }>({ open: () => false, openPage: () => false });
  /** Per document, the latest request to show one of its AIs, kept until a view acts on it. */
  const [revealAgents, setRevealAgents] = useState<Record<string, AgentReveal | null>>({});
  /**
   * The one opener of a conversation (session-route.ts): every row, menu, notice and card goes
   * through it, so a live document AI always ends beside its document with its conversation out.
   */
  const showConversation = useRef<(session: Session, work?: { id: string }, opened?: () => void) => void>(() => undefined);
  const entries = useMemo(() => sessionEntries({
    find: (sessionId) => stateRef.current.sessions[sessionId],
    hasDocument: (artifactId) => Boolean(stateRef.current.artifacts[artifactId]),
    // A document's or page's AI is shown in the document's or page's own tab: one that is beside a
    // conversation (read there, nothing to save) is given its tab for it.
    navigate: (content, opened) => navigateTo(content, opened, true),
    // Asked for only once the pane has moved to that AI (a refused leave asks for nothing).
    reveal: (artifactId, request) => setRevealAgents((current) => ({ ...current, [artifactId]: request })),
    conversation: (session, work, opened) => showConversation.current(session, work, opened),
  }), [navigateTo]);
  const openSession = entries.open;
  // Office control waits for an editable view: the document's own tab (desk.edit — beside a
  // conversation it is only read, so its own tab is opened, and the request is always answered).
  const notifyOfficeControl = useOfficeControl(api, !single, artifact => new Promise((resolve, reject) => {
    desk.edit(layoutRef.current.focus, { workId: artifact.workId, sessionId: null, view: { kind: "document", artifactId: artifact.id, proposalId: null } }, resolve, reject);
  }), fail);
  // Only this window's explicit creation requests open result tabs. Replayed events open once.
  const creatingRequests = useRef(new Map<string, { workId: string; sessionId: string; tabId: string }>());
  const completedTurns = useRef(new CompletionNotifications());
  const tellCompletion = useRef<(event: SequencedEvent) => void>(() => {});
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


  // Snapshot, then live events; a resync reloads the snapshot.
  useEffect(() => {
    if (!api) return;
    let stop = () => {};
    let cancelled = false;
    const load = async () => {
      try {
        const snapshot = await api.snapshot();
        if (cancelled) return;
        attentionInbox.snapshot(snapshot);
        dispatch({ type: "snapshot", snapshot });
        stop();
        stop = api.events(
          snapshot.seq,
          (event) => {
            attentionInbox.event(event);
            dispatch({ type: "event", event });
            tellCompletion.current(event);
            if (event.type === "work.removed") updateLayout(current => {
              let next = current;
              for (const pane of current.panes) for (const tab of tabsOf(pane)) if (tab.workId === event.workId || (tab.view.kind === "project" && tab.view.workId === event.workId)) next = closeTab(next, pane.id, tab.id, { view: { kind: "new", folderId: null }, workId: null, sessionId: null });
              return next;
            });
            // A document taken out of its project: its tabs close; a conversation beside it stays.
            // No save check runs here: the gateway refuses a removal while any view reports unsaved
            // edits (the app saves first, through each editor's leave path), and a removed document
            // takes no more saves. Running the check made the closing editor wait for a frame that
            // was already going: the tab stayed on 문서를 찾을 수 없습니다 and its pane stopped (U38).
            if (event.type === "artifact.removed") for (const { pane, tab } of documentTabsRef.current(event.artifact.id)) {
              leaveGate.current.run(pane.id, null, () => updateLayout(current => dropTabs(current, view =>
                viewDocument(view) === event.artifact.id ? (view.kind === "document" ? "close" : { kind: "work" }) : null,
                { view: { kind: "new", folderId: null }, workId: null, sessionId: null })), fail, tab.id);
            }
            if (event.type === "office.control") notifyOfficeControl();
            if (event.type === "office.note.ready") window.dispatchEvent(new CustomEvent("workbench:note-ready", { detail: event.artifactId }));
            if (event.type === "item.upserted" && event.item.kind === "artifact" && event.item.id.startsWith("artifact:create:")) {
              const requestId = event.item.id.slice("artifact:create:".length), origin = creatingRequests.current.get(requestId);
              if (origin && event.sessionId === origin.sessionId) {
                creatingRequests.current.delete(requestId);
                const content: PaneContent<View> = { workId: origin.workId, sessionId: origin.sessionId, view: { kind: "document", artifactId: event.item.artifactId, proposalId: null } };
                const source = layoutRef.current.panes.find((pane) => tabsOf(pane).some((tab) => tab.id === origin.tabId));
                if (source && layoutRef.current.focus === source.id && activeTab(source).id === origin.tabId) navigateTo(content);
                else if (source) updateLayout((current) => addBackgroundTab(current, source.id, content));
              }
            }
          },
          () => void load(),
          (connected) => { dispatch({ type: "connected", connected }); if (connected) notifyOfficeControl(); },
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
  }, [api, fail, navigateTo, updateLayout, attentionInbox]);

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
  const [expandedEditorTab, setExpandedEditorTab] = useState<string | null>(null);
  const focusedTabId = activeTab(focusedPane(layout)).id;
  // Tabs whose home wordmark is on screen: one wordmark per screen, so the top bar then shows the symbol.
  const [heroTabs, setHeroTabs] = useState<ReadonlySet<string>>(() => new Set());
  const heroIn = useCallback((tabId: string, shown: boolean) => setHeroTabs(current => {
    if (current.has(tabId) === shown) return current;
    const next = new Set(current);
    if (shown) next.add(tabId); else next.delete(tabId);
    return next;
  }), []);
  const editorFocus = view.kind === "presentation" || view.kind === "document" && !layout.grid && expandedEditorTab !== focusedTabId;
  const [compactShell, setCompactShell] = useState(() => window.matchMedia("(max-width: 900px)").matches);
  const [compactSidebar, setCompactSidebar] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const update = () => { setCompactShell(media.matches); setCompactSidebar(false); };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => setCompactSidebar(false), [focusedTabId, view.kind, workId, focusedPane(layout).sessionId]);
  const sidebarOpen = !single && !editorFocus && (compactShell ? compactSidebar : prefs.sidebar !== false);
  const showSidebar = () => { setCompactSidebar(true); savePrefs({ sidebar: true }); };
  const toggleSidebar = () => compactShell ? setCompactSidebar(!compactSidebar) : savePrefs({ sidebar: !sidebarOpen });
  const sidebarWidth = typeof prefs.sidebarWidth === "number" ? Math.min(480, Math.max(232, prefs.sidebarWidth)) : 288;
  // The right sidebar (개요 · 연결) of the note in the focused pane: closed unless opened, per window.
  // Docked only while the panes keep their least width beside it (one pane when zoomed).
  // A pane holding a conversation and its companion side by side needs both columns' minimums.
  const besideExtra = useBesideRoom();
  const paneMinimum = (editorFocus || paneFocus ? MIN_PANE : minimumSize(treeOf(layout), !!layout.grid).width) + besideExtra;
  const right = useRightSidebar({ prefs, savePrefs, scope: single ? "window" : "main", compact: compactShell, minimum: paneMinimum, ready: layoutReady && state.ready });
  const toggleRight = useRef(right.toggle);
  toggleRight.current = right.toggle;
  const readArtifactText = useCallback((artifactId: string) => api ? api.artifactText(artifactId).then((result) => result.text) : Promise.reject(new Error("no api")), [api]);
  const sortMode: SortMode = SORT_MODES.includes(prefs.treeSort as SortMode) ? (prefs.treeSort as SortMode) : "manual";
  const treeOpen = useMemo(() => readOpenState(prefs.tree), [prefs.tree]);

  const singleSession = single ? state.sessions[single] : undefined;
  const work = singleSession ? state.works[singleSession.workId] : workId ? state.works[workId] : undefined;
  /** The session a work shows: its active one (unless archived), else its latest. */
  const activeOf = (owner: Work) =>
    (owner.activeSessionId && state.sessions[owner.activeSessionId] && !state.sessions[owner.activeSessionId]!.archivedAt && !state.sessions[owner.activeSessionId]!.documentAgent && !state.sessions[owner.activeSessionId]!.pageAgent && state.sessions[owner.activeSessionId]) ||
    workSessions(state, owner.id).filter((entry) => !entry.documentAgent && !entry.pageAgent).at(-1) ||
    sessionsOf(state, owner.id).filter((entry) => !entry.documentAgent && !entry.pageAgent).at(-1);
  const restoredSession = focusedPane(layout).sessionId ? state.sessions[focusedPane(layout).sessionId!] : null;
  const activeSession = singleSession ?? (restoredSession && restoredSession.workId === work?.id && !restoredSession.archivedAt ? restoredSession : work && activeOf(work));
  // ── two panes (panes.ts): the other pane keeps the session it showed when it lost the focus ──
  const sessionIn = (pane: Pane<View>): Session | undefined => {
    if (pane.view.kind === "browser") {
      const pageId = pane.view.pageId;
      const page = browserState.pages.find(entry => entry.pageId === pageId);
      const child = state.sessions[page?.sessionId ?? pane.sessionId ?? ""];
      return child?.pageAgent?.pageId === pageId ? child : undefined;
    }
    const owner = pane.workId ? state.works[pane.workId] : undefined;
    if (!owner) return undefined;
    const kept = pane.sessionId ? state.sessions[pane.sessionId] : undefined;
    const candidate = kept && kept.workId === owner.id ? kept : pane.id === layout.focus && activeSession?.workId === owner.id ? activeSession : activeOf(owner) || undefined;
    if (pane.view.kind === "document") {
      const document = state.artifacts[pane.view.artifactId];
      // An external citation has its own workspace. Null must not silently
      // reattach the project conversation from a different workspace.
      if (!document || candidate?.workId !== document.workId || candidate?.workspaceId !== document.workspaceId) return undefined;
    }
    return candidate;
  };
  const layoutLoaded = useRef(false);
  const layoutSaved = useRef("");
  const restoreWorkspaceLayout = (raw: unknown, fallback: Layout<View>) => {
    const latest = stateRef.current;
    const restored = restoreLayout(upgradeStoredLayout(raw), isView, fallback);
    const panes = restored.panes.map((pane) => {
      const missingWork = pane.workId && !latest.works[pane.workId];
      const at = pane.view;
      const missingDoc = at.kind === "document" && !latest.artifacts[at.artifactId];
      const missingProject = at.kind === "project" && !latest.works[at.workId];
      return missingWork || missingDoc || missingProject ? { ...pane, view: { kind: "new" as const, folderId: null }, workId: null, sessionId: null } : pane;
    });
    // A companion whose document is gone is closed; its conversation stays.
    let upgraded = withTabs({ ...restored, panes });
    for (const tab of upgraded.panes.flatMap(tabsOf)) {
      const beside = besideOf(tab.view);
      if (beside?.kind === "document" && !latest.artifacts[beside.artifactId]) upgraded = withoutCompanion(upgraded, tab.id);
    }
    upgraded = oneViewPerDocument(upgraded);
    if (!restored.panes.some((pane) => pane.tabs)) {
      for (const pane of upgraded.panes) for (const artifactId of openDocs[pane.workId ?? ""] ?? []) {
        const artifact = latest.artifacts[artifactId];
        if (artifact) upgraded = addBackgroundTab(upgraded, pane.id, { view: { kind: "document", artifactId, proposalId: null }, workId: artifact.workId, sessionId: null });
      }
    }
    return upgraded;
  };
  useEffect(() => {
    if (!state.ready || layoutLoaded.current) return;
    layoutLoaded.current = true;
    if (single) { setLayoutReady(true); return; }
    const key = typeof state.prefs.layoutScope === "string" && (state.prefs.layoutScope === GLOBAL_LAYOUT || state.workspaces[state.prefs.layoutScope]) ? state.prefs.layoutScope : GLOBAL_LAYOUT;
    void layoutPersistence?.read(key).then((record) => {
      const upgraded = restoreWorkspaceLayout(record?.layout ?? state.prefs.paneLayout ?? readJson(PANE_LAYOUT_KEY, null), layoutRef.current);
      layoutScopeRef.current = key; setLayoutScope(key);
      // A choice made on this device's copy while the record was read is not undone (keepChosen).
      updateLayout((current) => keepChosen(upgraded, current, navigated.current)); setLayoutReady(true);
    }).catch((error: unknown) => setLayoutProblem({ key, message: error instanceof Error ? error.message : String(error) }));
  }, [state.ready, single, layoutPersistence]);
  useEffect(() => {
    if (!layoutReady || single || layoutSwitching.current || !layoutPersistence) return;
    const saved = { version: 2, ...layout };
    const json = JSON.stringify(saved);
    if (layoutSaved.current === json) return;
    layoutSaved.current = json;
    const key = layoutScopeRef.current;
    window.clearTimeout(layoutSaveTimer.current);
    layoutSaveTimer.current = window.setTimeout(() => {
      void layoutPersistence.write(key, saved).then(() => {
        if (layoutScopeRef.current === key && (prefsRef.current.layoutScope !== key || prefsRef.current.paneLayout !== undefined)) savePrefs({ layoutScope: key, paneLayout: undefined });
      }).catch((error: unknown) => setLayoutProblem({ key, message: error instanceof Error ? error.message : String(error) }));
    }, 200);
    try { localStorage.setItem(PANE_LAYOUT_KEY, json); } catch { /* Gateway remains authoritative. */ }
  }, [layout, layoutReady, layoutScope, single, layoutPersistence]);
  useEffect(() => () => window.clearTimeout(layoutSaveTimer.current), []);

  // A document shown becomes a tab of its work (at most 8, the oldest goes).
  useEffect(() => {
    const artifact = state.artifacts[viewDocument(view) ?? ""];
    if (!artifact) return;
    setOpenDocs((current) => {
      const list = current[artifact.workId] ?? [];
      return list.includes(artifact.id) ? current : { ...current, [artifact.workId]: [...list, artifact.id].slice(-8) };
    });
  }, [view, state.artifacts]);
  useEffect(() => localStorage.setItem(OPEN_DOCS_KEY, JSON.stringify(openDocs)), [openDocs]);
  const docsOf = (owner: Work | undefined) => owner ? [...new Set(layout.panes.flatMap(tabsOf).filter((tab) => tab.workId === owner.id).flatMap((tab) => viewDocument(tab.view) ?? []).concat(openDocs[owner.id] ?? []))].filter((id) => state.artifacts[id]) : [];
  const openDocIds = docsOf(work);

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
  // An archived conversation shown on purpose (보관함, the right sidebar's 연결) is not the work's
  // active one, but its pane shows it: load its transcript too.
  const shownArchived = restoredSession?.archivedAt && restoredSession.workId === work?.id ? restoredSession : null;
  useEffect(() => {
    if (!api || !shownArchived || state.transcripts[shownArchived.id]) return;
    let cancelled = false;
    api.items(shownArchived.id).then((result) => !cancelled && dispatch({ type: "transcript", sessionId: shownArchived.id, transcript: result })).catch(fail);
    return () => { cancelled = true; };
  }, [api, shownArchived?.id, state.transcripts, fail]); // eslint-disable-line react-hooks/exhaustive-deps

  // "어느 세션에 보낼까요?" picker, answered through a promise.
  const [picker, setPicker] = useState<{ workId: string; excludeSessionId: string | null; resolve: (session: Session | null) => void } | null>(null);

  // The agent browser: the pill under the input and the connections menu.
  const browserActions: BrowserActions = useMemo(
    () => ({
      engine: (engine) => void api?.browser.engine(engine).catch(fail),
      setOn: (session, on) => {
        void api?.updateSession(session.id, { browser: on }).catch(fail);
        if (on) setToast("브라우저를 켰습니다. 다음 요청부터 AI가 웹을 탐색할 수 있습니다.");
      },
      install: () => void api?.browser.install().catch(fail),
      login: (url) => void api?.browser.login(url).catch(fail),
      closeLogin: () => void api?.browser.closeLogin().catch(fail),
      focus: () =>
        void api?.browser
          .focus()
          .then((result) => {
            if (!result.ok) setToast(failure(result.message));
          })
          .catch(fail),
      pause: (session, paused) => void api?.browser.pause(session.id, paused).catch(fail),
    }),
    [api, fail, setToast],
  );

  // A conversation shown as itself: a chat, or a read-only one (archived, or an AI whose document is gone).
  showConversation.current = (session, work, opened) => {
    const target = stateRef.current.works[session.workId] ?? (work ? stateRef.current.works[work.id] : undefined);
    if (!target) return;
    if (single) {
      // A detached window stays one window: it switches to the session picked in it.
      navigateTo({ workId: target.id, sessionId: session.id, view: { kind: "work" } }, () => {
        setSingle(session.id);
        showInWindow(session.id);
        opened?.();
      });
      return;
    }
    // Already shown in the other pane: the focus goes there (never the same conversation twice).
    panesRef.current.focusIfShown(`session:${session.id}`);
    // The row names the conversation: where its companion lies over it, the conversation comes back.
    desk.conversation(layoutRef.current.focus, { workId: target.id, sessionId: session.id, view: { kind: "work" } }, () => {
      // An archived one is only looked at (its pane keeps it): it does not become the project's active conversation.
      if (becomesActive(target, session)) {
        dispatch({ type: "focus", work: target, session });
        void api?.updateWork(target.id, { activeSessionId: session.id }).catch(fail);
      }
      opened?.();
    });
  };
  // Document AIs being restored (되돌리기, or their document coming back from 보관함) while a tab
  // shows them read-only: once live again, that tab gives way to the document with the AI beside
  // it — never to another conversation of the project.
  const awaitingBeside = useRef(new Set<string>());
  useEffect(() => {
    for (const id of [...awaitingBeside.current]) {
      const session = state.sessions[id];
      if (!session || (!session.documentAgent && !session.pageAgent)) { awaitingBeside.current.delete(id); continue; }
      if (!opensBeside(session) || (session.documentAgent && !state.artifacts[session.documentAgent.artifactId])) continue;
      awaitingBeside.current.delete(id);
      const plan = restoredAgentPlan(layoutRef.current, session, (artifactId) => Boolean(state.artifacts[artifactId]));
      if (plan.kind === "none") continue;
      const artifactId = session.documentAgent!.artifactId;
      const reveal = () => setRevealAgents((current) => ({ ...current, [artifactId]: { sessionId: session.id } }));
      const close = () => updateLayout((current) => closeTab(current, plan.paneId, plan.tabId, { view: { kind: "new", folderId: null }, workId: null, sessionId: null }));
      if (plan.kind === "replace") {
        updateLayout((current) => updateTabView(current, plan.tabId, () => plan.content.view));
        if (plan.shown) reveal();
      } else if (plan.shown) navigateTo(plan.content, () => { reveal(); close(); });
      else close();
    }
  }, [state.sessions, state.artifacts, navigateTo, updateLayout]);
  /** 되돌리기 of a document: its AIs shown read-only in a tab follow it back (above). */
  const restoreDocument = useCallback((artifactId: string) => {
    if (!api) return Promise.reject(new Error("연결되지 않았습니다."));
    const shown = Object.values(stateRef.current.sessions).filter((session) => session.documentAgent?.artifactId === artifactId && findTab(layoutRef.current, `session:${session.id}`)).map((session) => session.id);
    for (const id of shown) awaitingBeside.current.add(id);
    return api.restoreDocument(artifactId).catch((error: unknown) => { for (const id of shown) awaitingBeside.current.delete(id); throw error; });
  }, [api]);

  const actions: WorkActions = useMemo(
    () => ({
      send: async (session: Session, text: string, refs: DocRef[] = [], create: CreateTarget | null = null, mode: "auto" | "queue" = "auto", attachments: Attachment[] = [], plan = false, omitChanges: string[] = [], notes: string[] = []) => {
        if (!api) return false;
        const requestId = newRequestId();
        if (create) creatingRequests.current.set(requestId, { workId: session.workId, sessionId: session.id, tabId: activeTab(focusedPane(layoutRef.current)).id });
        try {
          const result = await api.send(session.id, requestId, text, refs, create, mode, attachments, plan, { omitChanges, ...(notes.length ? { notes } : {}) });
          if (result.delivery === "queued") setToast("작업이 끝나면 이어서 보냅니다. 입력창 위에서 고치거나 지울 수 있습니다.");
          return true;
        } catch (error) {
          creatingRequests.current.delete(requestId);
          fail(error);
          return false;
        }
      },
      queued: {
        send: (session, queuedId) => void api?.sendQueued(session.id, queuedId).catch(fail),
        edit: (session, queuedId, text) => void api?.updateQueued(session.id, queuedId, text).catch(fail),
        cancel: (session, queuedId) => { creatingRequests.current.delete(queuedId); void api?.cancelQueued(session.id, queuedId).catch(fail); },
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
            navigateTo({ workId: forked.workId, sessionId: forked.id, view: { kind: "work" } });
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
      upload: async (file: File, workId: string) => {
        if (!api) return null;
        try {
          return await api.uploadAttachment(file, workId);
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
      // From a conversation (the note's ⋯, a file just made or opened there): beside that conversation.
      openArtifact: (artifactId: string) => {
        void api?.request<{ handled: boolean; ok?: boolean }>("POST", "/api/office-drive/reopen", { artifactId }).then(result => {
          if (!result.handled) { if (!besideRef.current.open(artifactId)) setView({ kind: "document", artifactId, proposalId: null }); }
          else if (!result.ok) throw new Error("Drive 문서를 열지 못했습니다. 연결 상태를 확인해 주세요.");
        }).catch(fail);
      },
      // A card in the conversation, a 연결 row: beside it; with no conversation there, a tab of its own.
      openBeside: (artifactId: string, proposalId?: string) => {
        const show = () => { if (!besideRef.current.open(artifactId, proposalId ?? null)) docTabRef.current(artifactId, proposalId); };
        if (proposalId) { show(); return; }
        void api?.request<{ handled: boolean; ok?: boolean }>("POST", "/api/office-drive/reopen", { artifactId }).then(result => {
          if (!result.handled) show();
          else if (!result.ok) throw new Error("Drive 문서를 열지 못했습니다. 연결 상태를 확인해 주세요.");
        }).catch(fail);
      },
      openPageBeside: (pageId: string) => besideRef.current.openPage(pageId),
      openFile: async (target: Work, path: string, workspaceId?: string) => {
        if (!api) return;
        try {
          const artifact = await api.openFile(target.id, path, workspaceId);
          setView({ kind: "document", artifactId: artifact.id, proposalId: null });
        } catch (error) {
          fail(error);
        }
      },
      newDesign: async (target: Work, preset: string, workspaceId?: string) => {
        if (!api) return;
        try {
          const artifact = await api.createDesign(target.id, "새 디자인", preset, workspaceId);
          setView({ kind: "document", artifactId: artifact.id, proposalId: null });
        } catch (error) {
          fail(error);
        }
      },
      interrupt: (session) => void api?.interrupt(session.id).catch(fail),
      answer: (session, itemId, decision, response) => void api?.answer(session.id, itemId, decision, response).catch(fail),
      newSession: async (target: Work, provider: Provider, choice, options) => {
        if (!api) return null;
        try {
          const workspaceId = options?.workspaceId ?? (target.activeSessionId ? stateRef.current.sessions[target.activeSessionId]?.workspaceId : undefined);
          const session = await api.createSession(target.id, provider, { workspaceId, model: choice?.model ?? null, effort: choice?.effort ?? null, ...(options?.browser ? { browser: true } : {}), ...(options?.worktree ? { worktree: true } : {}) });
          dispatch({ type: "focus", work: target, session });
          updateLayout((current) => setPane(current, current.focus, { workId: target.id, sessionId: session.id }));
          return session;
        } catch (error) {
          fail(error);
          return null;
        }
      },
      createWorkspace: async (target, cwd) => {
        if (!api) return null;
        try { return await api.createWorkspace(target.id, cwd); } catch (error) { fail(error); return null; }
      },
      updateWorkspace: async (workspace, patch) => {
        if (!api) return null;
        try { return await api.updateWorkspace(workspace.id, patch); } catch (error) { fail(error); return null; }
      },
      openWorkspace: (workspace) => openWorkspaceRef.current(workspace),
      openTerminals: (workspace) => setTerminalWorkspace(workspace),
      openServices: (workspace) => setServiceWorkspace(workspace),
      openBrowser: (workspace) => { void openBrowserRef.current(layoutRef.current.focus, { workspaceId: workspace.id, workId: workspace.workId }); },
      prepareWorkspace: (workspace) => setPreparationWorkspace(workspace),
      reviewWorkspace: (workspace) => setScmWorkspace(workspace),
      workspaceGit: {
        workspaceRepository: async (...args) => { if (!api) throw new Error("연결을 기다려 주세요."); return api.workspaceRepository(...args); },
        connectWorktree: async (...args) => { if (!api) throw new Error("연결을 기다려 주세요."); return api.connectWorktree(...args); },
        worktreeCreations: async (...args) => { if (!api) throw new Error("연결을 기다려 주세요."); return api.worktreeCreations(...args); },
        createWorktreeWorkspace: async (...args) => { if (!api) throw new Error("연결을 기다려 주세요."); return api.createWorktreeWorkspace(...args); },
        cancelWorktreeCreation: async (...args) => { if (!api) throw new Error("연결을 기다려 주세요."); return api.cancelWorktreeCreation(...args); },
      },
      selectSession: (target, session) => entries.select(target, session),
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
        navigateTo({ workId: target.id, sessionId: null, view: { kind: "project", workId: target.id } });
      },
      openSidebar: showSidebar,
      openArchive: () => setView({ kind: "archive" }),
      restore: (target) => {
        if (!api) return;
        // A document AI restored while a tab shows it read-only goes beside its document (below).
        if (target.kind === "session") awaitingBeside.current.add(target.id);
        const request =
          target.kind === "folder" ? api.updateFolder(target.id, { archived: false }) : target.kind === "work" ? api.updateWork(target.id, { archived: false }) : api.updateSession(target.id, { archived: false });
        void request.then(() => setToast("되돌렸습니다.")).catch((error) => { awaitingBeside.current.delete(target.id); fail(error); });
      },
      browser: browserActions,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, fail, savePrefs, setToast, setView, browserActions, single, entries],
  );

  /** A document in a tab of its own (from the navigator, home, a project note, the palette). */
  const docTabRef = useRef<(artifactId: string, proposalId?: string) => void>(() => undefined);
  docTabRef.current = (artifactId, proposalId) => {
    panesRef.current.focusIfShown(`doc:${artifactId}`);
    const artifact = stateRef.current.artifacts[artifactId];
    if (artifact) navigateTo({ workId: artifact.workId, sessionId: null, view: { kind: "document", artifactId, proposalId: proposalId ?? null } });
  };
  const docActions: DocActions = useMemo(
    () => ({
      openArtifact: (artifactId, proposalId) => {
        const show = () => docTabRef.current(artifactId, proposalId);
        if (proposalId) { show(); return; }
        void api?.request<{ handled: boolean; ok?: boolean }>("POST", "/api/office-drive/reopen", { artifactId }).then(result => {
          if (!result.handled) show();
          else if (!result.ok) throw new Error("Drive 문서를 열지 못했습니다. 연결 상태를 확인해 주세요.");
        }).catch(fail);
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
      openSession: entries.byId,
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
    [api, fail, state.artifacts, state.sessions, state.works, actions, setToast, setView, entries],
  );

  const startWork = async (
    text: string,
    provider: Provider,
    cwd: string | null,
    folderId: string | null,
    choice: { model: string | null; effort: string | null },
    pick: ProjectPick = { kind: "auto" },
    originPane = layoutRef.current.focus,
  ) => {
    if (!api) return false;
    try {
      // The project chip: an existing work gets a new session; otherwise a new work (project).
      const existing = await homeTarget(state, pick, cwd, entryClient(api).workAt);
      const created = existing ?? (await api.createWork(titleFrom(text), folderId, cwd));
      const session = await api.createSession(created.id, provider, choice);
      dispatch({ type: "focus", work: created, session });
      updateLayout((current) => setPane(current, originPane, { workId: created.id, view: { kind: "work" }, sessionId: session.id }));
      await api.send(session.id, newRequestId(), text);
      // Home's input is gone from the screen by now and cannot clear itself: the sent text must not come back there.
      writeDraft(originPane === "a" ? `new:${folderId ?? "root"}` : `new:${originPane}:${folderId ?? "root"}`, "");
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };

  /** The AI each open document view draws, as it reports (what counts as looked at). */
  const [drawnAgents, setDrawnAgents] = useState<Record<string, string | null>>({});
  const onRevealDone = useCallback((artifactId: string, request: AgentReveal) => setRevealAgents((current) => (current[artifactId] === request ? { ...current, [artifactId]: null } : current)), []);
  const onAgentDrawn = useCallback((artifactId: string, sessionId: string | null) => setDrawnAgents((current) => (current[artifactId] === sessionId ? current : { ...current, [artifactId]: sessionId })), []);
  // A document's AI drawn in a view has its conversation loaded: its column beside the document
  // shows it, and the main conversation's line about it opens it.
  const loadingTranscripts = useRef(new Set<string>());
  const drawnIds = Object.values(drawnAgents).filter((id): id is string => Boolean(id)).sort().join(",");
  useEffect(() => {
    if (!api) return;
    for (const id of drawnIds ? drawnIds.split(",") : []) {
      if (state.transcripts[id] || loadingTranscripts.current.has(id) || !state.sessions[id]) continue;
      loadingTranscripts.current.add(id);
      // Asked once: a failure is said and not repeated; a loaded one may be asked again after a reconnect clears it.
      void api.items(id).then((transcript) => { dispatch({ type: "transcript", sessionId: id, transcript }); loadingTranscripts.current.delete(id); }).catch(fail);
    }
  }, [api, drawnIds, state.transcripts, state.sessions, fail]);
  const pendingApprovals = Object.values(state.sessions).filter((session) => session.status === "awaitingApproval" && !session.archivedAt);

  // New replies: kept by the gateway, so every window agrees. Looking at a session marks it seen,
  // except right after the user marked it unread while looking at it.
  const visibleSession = view.kind === "work" && activeSession ? activeSession : null;
  const attentionSessionId = view.kind === "document"
    ? documentAttentionSession(view.artifactId, drawnAgents[view.artifactId] ?? null, activeSession, state.sessions)
    : view.kind === "browser" ? browserState.pages.find(page => page.pageId === view.pageId)?.sessionId ?? null
    // A conversation its companion lies over is not what the person is looking at.
    : (coveredTabs[focusedTabId] ? null : visibleSession?.id) ?? null;
  const attentionSession = useRef<string | null>(null); attentionSession.current = attentionSessionId;
  const presenceWatcher = useRef<ReturnType<typeof watchAttentionPresence> | null>(null);
  useEffect(() => {
    if (attentionState.supported !== true) return;
    const watcher = watchAttentionPresence(attentionInbox, () => attentionSession.current); presenceWatcher.current = watcher;
    return () => { watcher.close(); presenceWatcher.current = null; };
  }, [attentionInbox, attentionState.supported]);
  useEffect(() => { presenceWatcher.current?.update(); }, [attentionSessionId]);
  useEffect(() => {
    if (inDesktop && !single && prefs.notify !== false && attentionState.supported === true) void attentionInbox.fallback(payload => notifyAttention(payload, setPendingAttentionId));
  }, [attentionInbox, attentionState.list, attentionState.supported, prefs.notify, single]);
  // The other pane's conversation is on screen too (unless the window is too narrow to show it).
  const [narrowPanes, setNarrowPanes] = useState(false);
  // Everything a completion could be watched in: pane tabs on screen, and a document's or web page's AI column beside it.
  const panelKey = useSyncExternalStore(shownPanels.subscribe, shownPanels.getSnapshot);
  const onScreen = sessionsOnScreen(layout, { narrow: narrowPanes, sessionOf: (pane) => (coveredTabs[activeTab(pane).id] ? undefined : sessionIn(pane)?.id), panels: shownPanels.ids() });
  const visibleSessions = [...onScreen].map((id) => state.sessions[id]).filter((session): session is Session => Boolean(session));
  const visibleIds = `${visibleSessions.map((session) => session.id).join(",")}|${panelKey}`;
  const onScreenRef = useRef(onScreen); onScreenRef.current = onScreen;
  const noticeSession = notices.current?.kind === "completion" ? notices.current.completion.id : null;
  const waitingSession = notices.waiting?.kind === "completion" ? notices.waiting.completion.id : null;
  useEffect(() => { showNotice({ type: "seen", onScreen: onScreenRef.current }); }, [visibleIds, noticeSession, waitingSession]);
  const keptUnread = useRef<string | null>(null);
  useEffect(() => {
    if (keptUnread.current && !visibleSessions.some((session) => session.id === keptUnread.current)) keptUnread.current = null;
  }, [visibleIds]);
  const seenAsked = useRef(new Map<string, string>());
  useEffect(() => {
    if (!api) return;
    for (const shown of visibleSessions) {
      // An archived conversation is only looked at: it stays as it was (unseen too).
      if (!shown || !lookingChangesState(shown)) continue;
      // A failure counts as seen too once looked at (opening the work then goes elsewhere, entry.ts).
      const failed = unseenFailure(shown);
      if (!(isUnseen(shown) || failed) || keptUnread.current === shown.id) continue;
      const key = `${shown.previewAt}:${shown.unread}${failed ? `:${shown.updatedAt}` : ""}`;
      if (seenAsked.current.get(shown.id) === key) continue;
      seenAsked.current.set(shown.id, key);
      void api.updateSession(shown.id, { seen: true }).catch(() => undefined);
    }
  }, [api, visibleIds, state.sessions]);
  const unseen = useMemo(
    () => new Set(Object.values(state.sessions).filter((session) => isUnseen(session) && !visibleSessions.some((shown) => shown.id === session.id) && !session.archivedAt).map((session) => session.id)),
    [state.sessions, visibleIds],
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
  const openAttention = useCallback(async (id: string, onOpened?: () => void) => {
    if (!api) return;
    const target = await attentionInbox.target(id);
    let current = stateRef.current;
    if (!current.sessions[target.sessionId] || !current.works[target.workId] || (target.artifactId && !current.artifacts[target.artifactId])) {
      const snapshot = await api.snapshot(); attentionInbox.snapshot(snapshot); dispatch({ type: "snapshot", snapshot });
      current = reducer(current, { type: "snapshot", snapshot });
    }
    const session = current.sessions[target.sessionId];
    if (!session || session.hostId !== target.hostId || session.workId !== target.workId || !current.works[target.workId] || (target.artifactId && !current.artifacts[target.artifactId])) throw new Error("알림의 원문을 찾을 수 없습니다. 호스트 연결과 알림을 확인해 주세요.");
    if (!current.transcripts[target.sessionId]?.items.some(item => item.id === target.itemId)) {
      const transcript = await api.items(target.sessionId); dispatch({ type: "transcript", sessionId: target.sessionId, transcript });
    }
    setAttentionOpen(false);
    const shown = () => {
      if (target.taskRef.executorKind === "native_agent") setTaskPanelOpen(true);
      else setFocusItem({ sessionId: target.sessionId, itemId: target.itemId, nonce: Date.now() });
      void attentionInbox.read(id).catch(attentionInbox.reportError);
      onOpened?.();
    };
    // A document's or web tab's AI goes through the one opener: beside its document with its
    // conversation out while live, the read-only conversation itself once archived.
    if (session.documentAgent || session.pageAgent) entries.openThen(session, shown);
    else navigateTo({ workId: target.workId, sessionId: target.sessionId, view: target.pageId ? { kind: "browser", pageId: target.pageId } : target.artifactId ? { kind: "document", artifactId: target.artifactId, proposalId: null } : { kind: "work" } }, shown);
  }, [api, attentionInbox, navigateTo, entries]);
  const openingAttention = useRef<string | null>(null);
  useEffect(() => { if (attentionRequest) setPendingAttentionId(attentionRequest.id); }, [attentionRequest]);
  useEffect(() => {
    if (!pendingAttentionId || !state.ready || attentionState.supported !== true || openingAttention.current === pendingAttentionId) return;
    const id = pendingAttentionId; openingAttention.current = id;
    void openAttention(id, () => onAttentionOpened?.(id)).catch(error => { attentionInbox.reportError(error); setAttentionOpen(true); }).finally(() => {
      openingAttention.current = null; setPendingAttentionId(current => current === id ? null : current);
    });
  }, [pendingAttentionId, state.ready, attentionState.supported, openAttention, attentionInbox, onAttentionOpened]);
  // "다른 곳의 대화 가져오기": the imported session opens at once (its work may be new, so by id).
  const [importOpen, setImportOpen] = useState(false);
  // "예약 작업" of the session whose dialog is open.
  const [scheduling, setScheduling] = useState<string | null>(null);
  // "변경 검토" of the worktree session whose dialog is open.
  const [reviewing, setReviewing] = useState<string | null>(null);
  const openImported = useCallback(
    (session: Session) => {
      // The gateway made it the work's active session.
      navigateTo({ workId: session.workId, sessionId: session.id, view: { kind: "work" } });
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
      navigateTo({ workId, sessionId: null, view: { kind: "document", artifactId: artifact.id, proposalId: null } });
    },
    [savePrefs, navigateTo],
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
  // Completion follows the actual event, even when a quick running→idle transition
  // is batched into one render. Main and document chats use the same notification path.
  tellCompletion.current = event => {
    const session = event.type === "item.upserted" ? stateRef.current.sessions[event.sessionId] : undefined;
    const alert = completedTurns.current.take(event, session, session ? stateRef.current.works[session.workId]?.title ?? "" : "", !single && prefsRef.current.notify !== false);
    if (!alert) return;
    // An answer the user is watching arrives with nothing laid over it; any other one says so
    // on its tab and sidebar row (unseen dot) and in the top bar, next to the bell.
    const windowShown = !document.hidden && document.hasFocus();
    if (windowShown && completionSurface(alert.session.id, visibleSessionIds(onScreenRef.current, windowShown)) === "toast") {
      showNotice({ type: "show", slot: { kind: "completion", completion: { id: alert.session.id, provider: alert.session.provider, text: `${alert.body} · 답변 완료`, others: [] } } });
    }
    // The host owns OS notifications.
    if (inDesktop && attentionInbox.getState().supported === false) void notify("Achmage Workbench", "작업이 완료되었습니다.", alert.session.id).catch(() => undefined);
  };
  // Approval/error attention still follows status transitions.
  const statuses = useRef(new Map<string, SessionStatus>());
  useEffect(() => {
    const seen = statuses.current;
    const away = !document.hasFocus() || document.hidden;
    for (const session of Object.values(state.sessions)) {
      const before = seen.get(session.id);
      seen.set(session.id, session.status);
      // Only the main window tells; a detached one would say the same thing twice.
      if (attentionInbox.getState().supported !== false || !before || before === session.status || !inDesktop || !away || prefsRef.current.notify === false || single || session.muted) continue;
      if (session.status === "awaitingApproval") void notify("Achmage Workbench", "확인이 필요한 작업이 있습니다.", session.id).catch(() => undefined);
      else if (session.status === "error") void notify("Achmage Workbench", "작업을 마치지 못했습니다.", session.id).catch(() => undefined);
    }
  }, [state.sessions, state.works]);

  // The tray's "확인 필요 N" follows the sessions waiting for the user (main window only).
  const attention = useRef(-1);
  useEffect(() => {
    if (!inDesktop || single) return;
    const count = attentionState.supported === true ? attentionState.list.unread : Object.values(state.sessions).filter((session) => session.status === "awaitingApproval" && !session.archivedAt).length;
    if (count === attention.current) return;
    attention.current = count;
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("set_attention", { count })).catch(() => undefined);
  }, [state.sessions, attentionState.supported, attentionState.list.unread]);

  // A clicked notification, or the tray's "확인 필요", opens its session.
  const opener = useRef<{ open: (sessionId: string | null) => void; attention: (id: string | null) => void }>({ open: () => undefined, attention: () => undefined });
  opener.current.open = (sessionId) => {
    const target = sessionId ? state.sessions[sessionId] : Object.values(state.sessions).find((session) => session.status === "awaitingApproval" && !session.archivedAt);
    if (target) openSession(target);
  };
  opener.current.attention = id => { if (id) setPendingAttentionId(id); else opener.current.open(null); };
  useEffect(() => {
    if (!inDesktop || single) return;
    let stop = false;
    const unlisten: (() => void)[] = [];
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const handlers = [
        await listen<string>("workbench://open-session", (event) => opener.current.open(event.payload)),
        await listen<string | null>("workbench://open-attention", event => {
          const id = typeof event.payload === "string" ? event.payload : null;
          if (id) void import("@tauri-apps/api/core").then(({ invoke }) => invoke("take_open_attention")).catch(() => undefined);
          opener.current.attention(id);
        }),
      ];
      if (stop) handlers.forEach((handler) => handler());
      else {
        unlisten.push(...handlers);
        void import("@tauri-apps/api/core").then(({ invoke }) => invoke<string | null>("take_open_attention")).then(id => { if (!stop && id) opener.current.attention(id); }).catch(() => undefined);
      }
    });
    return () => {
      stop = true;
      unlisten.forEach((handler) => handler());
    };
  }, []);

  // "앱을 열면: 마지막 작업" set elsewhere (another window, a cleared cache): honoured once the
  // gateway's prefs arrive, if the user has not moved away from home meanwhile.
  const shortcuts = useMemo(() => shortcutsOf(state.prefs), [state.prefs]);
  /** Moves the focus to the other pane (set where the panes are; false with one pane). */
  const focusOtherPane = useRef<() => boolean>(() => false);
  /** True while ⋯ › 단축키 waits for a combination: the app's own shortcuts stand aside. */
  const recordingShortcut = useRef(false);
  /** ⋯ › 프로젝트 속성 템플릿… */
  const [propertyTemplateOpen, setPropertyTemplateOpen] = useState(false);
  const [folderTemplateId, setFolderTemplateId] = useState<string | null>(null);
  const setRecordingShortcut = useCallback((on: boolean) => {
    recordingShortcut.current = on;
  }, []);
  const startSettled = useRef(false);
  useEffect(() => {
    if (startSettled.current || !state.ready) return;
    startSettled.current = true;
    if (state.prefs.paneLayout) return;
    if (state.prefs.startScreen === "last" && view.kind === "new" && view.folderId === null && workId && state.works[workId]) setView({ kind: "work" });
  }, [state.ready, state.prefs.startScreen, state.works, view, workId, setView]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
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
          openCreate.current();
        } else if (combo === shortcuts.otherPane && focusOtherPane.current()) {
          event.preventDefault();
        } else if (combo === shortcuts.navigator && !single) {
          // "내비게이터로": the navigator's list takes the focus; a hidden sidebar opens first.
          event.preventDefault();
          showSidebar();
          requestNavigatorFocus();
        } else if (combo === shortcuts.rightSidebar) {
          event.preventDefault();
          toggleRight.current(true);
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
  }, [switchable, openSession, startNew, shortcuts, single, savePrefs]);

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
  const shownDoc = viewDocument(view);
  useEffect(() => {
    if (work && shownDoc) lastDoc.current[work.id] = shownDoc;
  }, [work, shownDoc]);
  /** The project's documents open in a tab now, in any pane (not the ones only remembered as once opened). */
  const tabDocsOf = (owner: Work | undefined) => owner ? [...new Set(layout.panes.flatMap(tabsOf).filter((tab) => tab.workId === owner.id).flatMap((tab) => viewDocument(tab.view) ?? []))].filter((id) => state.artifacts[id]) : [];
  /** The document a pane's modes are about (workmodes.ts); none open, no modes. */
  const modeDocFor = (at: View, owner: Work | undefined) => modeDocument(at, tabDocsOf(owner), owner ? lastDoc.current[owner.id] : undefined);
  const modeDocId = modeDocFor(view, work);
  const [reading, setReading] = useState<{ artifactId: string; start: ReadingPosition } | null>(null);
  const workMode: WorkMode | null = work && modeDocId && !startScreen ? modeOf(view, Boolean(reading)) : null;
  const reviewTarget = modeDocId ? reviewProposal(state, modeDocId) : null;
  // ── 곁 화면: a document or web page beside its conversation, in that conversation's tab ──
  /** Close what is beside a conversation (a web page stays listed as a tab behind it). */
  const closeCompanion = (paneId: PaneId, tabId: string) => desk.closeBeside(paneId, tabId);
  /** The conversation a pane's document goes back to: the one its AI was started from, else the pane's own. */
  const conversationOf = (pane: Pane<View>): PaneContent<View> => {
    const shown = sessionIn(pane);
    return { workId: pane.workId, sessionId: shown?.documentAgent ? shown.documentAgent.parentSessionId : pane.sessionId, view: { kind: "work" } };
  };
  /** "대화 옆에" (나란히): the person moves a document beside the conversation `at`. Its tab saves — after the question, when it holds an editor — and closes. */
  const showBeside = (paneId: PaneId, at: PaneContent<View>, beside: Companion) =>
    desk.moveBeside(paneId, { workId: at.workId, sessionId: at.sessionId }, beside, () => showSessionOf(at.workId, at.sessionId));
  /**
   * A document opened from a conversation (a file card, the note's ⋯, a 연결 row) comes beside that
   * conversation — unless it already has a view (a tab of its own, another conversation's
   * companion): then the app goes to that view, and nothing is saved or closed. False: the focused
   * pane shows no conversation of the document's project.
   */
  const openBeside = (artifactId: string, proposalId: string | null = null) => {
    const pane = focusedPane(layoutRef.current);
    const artifact = stateRef.current.artifacts[artifactId];
    if (!artifact || pane.view.kind !== "work" || pane.workId !== artifact.workId || !sessionIn(pane)) return false;
    return desk.openBeside(pane.id, { kind: "document", artifactId, proposalId });
  };
  /** A web page opened from a conversation's 연결 comes beside it (the page keeps running wherever it is shown). */
  const openPageBeside = (pageId: string) => {
    const pane = focusedPane(layoutRef.current);
    if (pane.view.kind !== "work" || !pane.workId || !sessionIn(pane)) return false;
    return desk.openBeside(pane.id, { kind: "browser", pageId });
  };
  besideRef.current = { open: openBeside, openPage: openPageBeside };

  const setWorkMode = (mode: WorkMode) => {
    if (!work || !modeDocId || mode === workMode) return;
    if (mode === "read") {
      // Start reading where the document is read now (or was, when it is not on screen).
      const body = workMode === "doc" || workMode === "review" || workMode === "split" ? document.querySelector<HTMLElement>(FOCUSED_DOC) : null;
      setReading({ artifactId: modeDocId, start: body ? readingPosition(body) : (keptPosition(`doc:${modeDocId}`) ?? { page: null, fraction: 0 }) });
      return;
    }
    if (mode === "review" && !reviewTarget) return setToast(failure("검토할 수정안이 없습니다."));
    setReading(null);
    const pane = focusedPane(layoutRef.current);
    if (mode === "chat") {
      // 대화: the conversation alone — its companion closes; from a document's tab, its conversation.
      if (besideOf(pane.view)) closeCompanion(pane.id, activeTab(pane).id);
      else { const back = conversationOf(pane); if (back.sessionId !== pane.sessionId) navigateTo(back); else setViewOf(pane.id, { kind: "work" }); }
    } else if (mode === "split") {
      // 나란히: the document beside its conversation, in that conversation's tab.
      showBeside(pane.id, pane.view.kind === "work" ? { workId: pane.workId, sessionId: pane.sessionId, view: pane.view } : conversationOf(pane), { kind: "document", artifactId: modeDocId, proposalId: null });
    // 문서 · 검토: the document's own tab (one beside the conversation is given its tab: it only read there).
    } else setViewOf(pane.id, { kind: "document", artifactId: modeDocId, proposalId: mode === "review" ? reviewTarget?.id ?? null : null }, undefined, true);
  };
  useWorkModeKeys(workMode !== null, setWorkMode);
  /** 읽기 and 검토 from the focused conversation, by pointer (the note's ⋯), while a document of its project is open. */
  const conversationModes = (here: boolean): DocModes | undefined => {
    const artifact = here && workMode !== null && modeDocId ? state.artifacts[modeDocId] : undefined;
    return artifact ? { artifactId: artifact.id, name: artifact.name, onRead: () => setWorkMode("read"), onReview: reviewTarget ? () => setWorkMode("review") : null } : undefined;
  };
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
    const review = (id: string) => (proposalId: string | null) =>
      updateLayout((current) => updateTabView(current, id, (view) => {
        if (view.kind === "document") return view.proposalId !== proposalId ? { ...view, proposalId } : view;
        const beside = besideOf(view);
        return view.kind === "work" && beside?.kind === "document" && beside.proposalId !== proposalId ? { ...view, beside: { ...beside, proposalId } } : view;
      }));
    return Object.fromEntries(layout.panes.flatMap((pane) => tabsOf(pane).map((tab) => [tab.id, review(tab.id)])));
  }, [updateLayout, layout.panes.flatMap((pane) => tabsOf(pane).map((tab) => tab.id)).sort().join(",")]);
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
  const [deletingWork, setDeletingWork] = useState<Work | null>(null);
  /** A document AI being renamed (it has no sidebar row to rename in place). */
  const [renamingSession, setRenamingSession] = useState<Session | null>(null);
  const deleteProject = async (owner: Work) => {
    if (!api) return;
    for (const pane of layoutRef.current.panes) for (const tab of tabsOf(pane)) if (tab.workId === owner.id) await leaveGuards.current[tab.id]?.();
    await api.deleteWork(owner.id);
    setToast("프로젝트를 삭제했습니다. 문서 파일과 작업 폴더는 보존했습니다.");
  };
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

  const detachSessionWindow = useCallback((session: Session) => {
    if (api?.isRemote) {
      setToast(failure("원격 호스트의 세션은 새 창으로 열 수 없습니다. 현재 창의 탭이나 나란히 보기를 사용하세요."));
      return;
    }
    void detachSession(session.id, session.purpose, inDesktop).catch(fail);
  }, [api, inDesktop, fail, setToast]);

  const creationTarget = useCallback((paneId: PaneId, owner?: Work | null): NewDocumentTarget => {
    const pane = paneById(layoutRef.current, paneId);
    const at = pane?.view;
    const artifact = stateRef.current.artifacts[viewDocument(at) ?? ""];
    const page = at?.kind === "browser" ? sharedBrowser.getState().pages.find(entry => entry.pageId === at.pageId) : undefined;
    const workId = owner?.id ?? artifact?.workId ?? page?.workId ?? (at?.kind === "project" ? at.workId : pane?.workId);
    const session = pane?.sessionId ? stateRef.current.sessions[pane.sessionId] : undefined;
    const project = workId ? stateRef.current.works[workId] : undefined;
    return { workId, workspaceId: creationWorkspace(project, [artifact?.workspaceId, page?.workspaceId, session?.workspaceId, layoutScope], stateRef.current.workspaces) };
  }, [layoutScope, sharedBrowser]);
  openBrowserRef.current = async (paneId, target) => {
    if (!api || browserOpening.current) return false;
    browserOpening.current = true;
    try {
      const at = paneById(layoutRef.current, paneId)?.view;
      const source = at?.kind === "browser" ? sharedBrowser.getState().pages.find(page => page.pageId === at.pageId) : undefined;
      const page = await openBrowserTab(sharedBrowser, api, stateRef.current, { profileId: source?.profileId, ...target });
      const content: PaneContent<View> = { view: { kind: "browser", pageId: page.pageId }, workId: page.workId, sessionId: page.sessionId };
      const targetId = findTab(layoutRef.current, contentKey(content))?.pane.id ?? paneId;
      afterLeaving(targetId, content.view, () => updateLayout(current => ({ ...setPane(current, targetId, content), focus: targetId })), findTab(layoutRef.current, contentKey(content))?.tab.id ?? null);
      return true;
    } catch (error) { fail(error); return false; }
    finally { browserOpening.current = false; }
  };
  const runCreateAction = useCallback((paneId: PaneId, action: CreateAction) => {
    const { target } = action;
    if (action.kind === "document") { setNewDocument({ ...target, paneId, format: action.format }); return; }
    if (action.kind === "directory") { if (target.workspaceId) setNewDirectory(target.workspaceId); return; }
    if (action.kind === "browser") { void openBrowserRef.current(paneId, target); return; }
    if (action.kind === "folder") {
      showSidebar();
      setExpandedEditorTab(paneById(layoutRef.current, paneId)?.activeTabId ?? null);
      setSidebarPending({ createIn: target.folderId });
      return;
    }
    const project = target.workId ? stateRef.current.works[target.workId] : undefined;
    if (action.kind === "project" || !project || !action.provider) { setViewOf(paneId, { kind: "new", folderId: target.folderId }); return; }
    if (!api) return;
    void api.createSession(project.id, action.provider, { workspaceId: target.workspaceId }).then(session => {
      dispatch({ type: "focus", work: project, session });
      afterLeaving(paneId, { kind: "work" }, () => updateLayout(current => ({ ...setPane(current, paneId, { workId: project.id, sessionId: session.id, view: { kind: "work" } }), focus: paneId })));
    }).catch(fail);
  }, [api, afterLeaving, updateLayout, setViewOf, fail, savePrefs]);
  const creationMenu = useCallback((paneId: PaneId, owner: Work | null, x: number, y: number, folderId?: string | null): MenuRequest => {
    const target = creationTarget(paneId, owner);
    const project = target.workId ? stateRef.current.works[target.workId] : undefined;
    const space = target.workspaceId ? stateRef.current.workspaces[target.workspaceId] : undefined;
    const at = paneById(layoutRef.current, paneId)?.view;
    const commands = createActions({ ...target, folderId: folderId !== undefined ? folderId : project?.folderId ?? (at?.kind === "new" ? at.folderId : null) });
    const entry = (action: CreateAction): MenuEntry => ({ kind: "item", label: action.label, icon: action.icon, onSelect: () => runCreateAction(paneId, action) });
    return { x, y, title: project ? `${project.title}${space ? ` · ${space.label}` : ""}` : "새로 만들기", items: [
      { kind: "submenu", label: "새 문서·디자인", icon: "file", items: commands.filter(action => action.kind === "document").map(entry) },
      ...commands.filter(action => action.kind === "session" || action.kind === "browser").map(entry), { kind: "separator" },
      ...commands.filter(action => action.kind === "directory" || action.kind === "folder" || action.kind === "project").map(entry),
    ] };
  }, [creationTarget, runCreateAction]);
  openCreate.current = anchor => {
    const button = anchor ?? document.querySelector<HTMLElement>(".shell-create");
    const box = button?.getBoundingClientRect();
    setContextMenu(creationMenu(layoutRef.current.focus, null, box?.left ?? 24, box?.bottom ?? 56));
  };

  const menuFor = useCallback(
    (row: Row, x: number, y: number, removal?: DocumentRemovalPlan): MenuRequest | null => {
      if (!api) return null;
      if (row.type === "docs" || row.type === "section" && row.workId) {
        const owner = row.type === "docs" ? row.work : state.works[row.workId!];
        return creationMenu(layoutRef.current.focus, owner ?? null, x, y);
      }
      const copy = (text: string, done: string) => () => void copyText(text).then(() => setToast(done));
      // A session's actions: on its row, and for a document AI (no row of its own) under its
      // document row's menu and in its conversation's head beside the document.
      const sessionItems = (session: Session, owner: Work): MenuEntry[] => {
        const busy = isBusy(session);
        const shortcuts = readShortcuts(state.prefs.navShortcuts) ?? [];
        const shortcut = { kind: "session" as const, id: session.id };
        const pinned = session.pinned || shortcuts.some((other) => sameShortcut(other, shortcut));
        const resume = resumeCommand(session, { ...owner, cwd: state.workspaces[session.workspaceId ?? ""]?.cwd ?? session.worktree?.cwd ?? owner.cwd });
        const unseenNow = isUnseen(session);
        const linked = linkOfSession(state, session.id);
        const exports: MenuEntry = {
          kind: "submenu",
          label: "마크다운으로 내보내기",
          icon: "markdown",
          items: [
            { kind: "item", label: "작업 폴더에 저장", icon: "download", hint: "세션 기록/", onSelect: () => void exportSession(session, "work") },
            { kind: "item", label: inDesktop ? "다른 곳에 저장…" : "내려받기", icon: "folderOpen", onSelect: () => void exportSession(session, "path") },
            { kind: "item", label: "마크다운 복사", icon: "copy", onSelect: () => void exportSession(session, "text") },
          ],
        };
        // An archived conversation takes nothing: its menu keeps what still works on it (opening it to
        // read, its name, its place in the list, reading it out) and offers 되돌리기 for 보관; what the
        // gateway refuses for it (sending, a schedule, a link that sends, stopping) is not offered.
        const archived = Boolean(session.archivedAt);
        const items: (MenuEntry | null)[] = [
          { kind: "item", label: "열기", icon: "chat", hint: "Enter", onSelect: () => openSession(session) },
          ...(single ? [] : [{ kind: "item" as const, label: "오른쪽에 열기", icon: "columns" as const, hint: "Ctrl+클릭", onSelect: () => panesRef.current.placeItem({ kind: "session", id: session.id }, "right") }]),
          ...(single === session.id ? [] : [{ kind: "item" as const, label: "새 창으로 떼어 내기", icon: "openNew" as const, disabled: api.isRemote, disabledReason: "원격 연결에서는 현재 창의 탭이나 나란히 보기를 사용하세요.", onSelect: () => detachSessionWindow(session) }]),
          { kind: "item", label: "이름 바꾸기", icon: "edit", hint: session.documentAgent ? undefined : "F2", onSelect: () => (session.documentAgent ? setRenamingSession(session) : setSidebarPending({ rename: session.id })) },
          ...(session.pageAgent ? [{ kind: "item" as const, label: "웹 탭 닫기", icon: "x" as const, hint: "대화는 보관함에 유지", onSelect: () => void sharedBrowser.close(session.pageAgent!.pageId).catch(fail) }] : []),
          { kind: "separator" },
          // A pinned session is kept in 바로가기 (`pinned` follows).
          { kind: "item", label: pinned ? "고정 풀기" : "고정", icon: "pin", hint: "바로가기", onSelect: () => {
            savePrefs({ navShortcuts: pinned ? shortcuts.filter((other) => !sameShortcut(other, shortcut)) : addShortcuts(shortcuts, [shortcut]) });
            void api.updateSession(session.id, { pinned: !pinned }).catch(fail);
          } },
          ...(archived ? [] : [{
            kind: "item" as const,
            label: "예약 작업…",
            icon: "clock" as const,
            hint: (() => {
              const count = state.schedules.filter((entry) => entry.sessionId === session.id && entry.enabled).length;
              return count ? `${count}개` : undefined;
            })(),
            onSelect: () => setScheduling(session.id),
          }]),
          { kind: "item", label: session.muted ? "알림 켜기" : "알림 끄기", icon: "bell", hint: session.muted ? "이 세션은 알리지 않음" : undefined, onSelect: () => void api.updateSession(session.id, { muted: !session.muted }).catch(fail) },
          {
            kind: "item",
            label: unseenNow ? "읽음으로 표시" : "읽지 않음으로 표시",
            icon: unseenNow ? "eye" : "bell",
            onSelect: () => {
              if (!unseenNow && visibleSessions.some((shown) => shown.id === session.id)) keptUnread.current = session.id;
              void api.updateSession(session.id, { seen: unseenNow }).catch(fail);
            },
          },
          { kind: "separator" },
          archived ? null : linked
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
          exports,
          { kind: "separator" },
          ...(inDesktop ? [{ kind: "item" as const, label: "작업 폴더 열기", icon: "folderOpen" as const, onSelect: () => void openPath(owner.cwd) }] : []),
          { kind: "item", label: "작업 폴더 경로 복사", icon: "copy", onSelect: copy(owner.cwd, "경로를 복사했습니다.") },
          ...(resume && !archived
            ? [{ kind: "item" as const, label: "터미널에서 이어 하기 명령 복사", icon: "terminal" as const, onSelect: copy(resume, "명령을 복사했습니다. 터미널에 붙여 넣으면 같은 대화를 이어 갑니다.") }]
            : []),
          { kind: "item", label: `${PROVIDER_LABEL[session.provider]} 외형…`, icon: "palette", onSelect: () => appearanceApi.openSettings(session.provider) },
          { kind: "separator" },
          ...(busy && !archived ? [{ kind: "item" as const, label: "멈추기", icon: "stop" as const, onSelect: () => actions.interrupt(session) }] : []),
          archived
            ? { kind: "item", label: "되돌리기", icon: "restore", disabled: restoreRefusal(session, (id) => Boolean(state.artifacts[id])) !== null, disabledReason: restoreRefusal(session, (id) => Boolean(state.artifacts[id])) ?? undefined, onSelect: () => actions.restore({ kind: "session", id: session.id }) }
            : { kind: "item", label: "보관", icon: "archive", hint: "Delete", disabled: busy, disabledReason: "진행 중인 세션을 멈춘 뒤 보관할 수 있습니다.", onSelect: () => archive({ kind: "session", id: session.id }) },
        ];
        return items.filter((entry): entry is MenuEntry => entry !== null);
      };
      if (row.type === "session") return { x, y, title: row.session.purpose, items: sessionItems(row.session, row.work) };
      if (row.type === "work") {
        const owner = row.work;
        const busy = row.sessions.some((session) => isBusy(session));
        const folders = folderChoices(state);
        const items: MenuEntry[] = [
          { kind: "item", label: "열기", icon: "project", hint: "Enter", onSelect: () => openWorkNow(owner) },
          ...(single ? [] : [{ kind: "item" as const, label: "오른쪽에 열기", icon: "columns" as const, hint: "Ctrl+클릭", onSelect: () => panesRef.current.placeItem({ kind: "work", id: owner.id }, "right") }]),
          { kind: "submenu", label: "새로 만들기", icon: "plus", items: creationMenu(layoutRef.current.focus, owner, 0, 0).items },
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
          { kind: "item", label: "보관", icon: "archive", hint: "Delete", disabled: busy, disabledReason: "진행 중인 세션이 끝나면 보관할 수 있습니다.", onSelect: () => archive({ kind: "work", id: owner.id }) },
          { kind: "item", label: "프로젝트 삭제…", icon: "trash", disabled: busy, disabledReason: "진행 중인 세션이 끝나면 삭제할 수 있습니다.", onSelect: () => setDeletingWork(owner) },
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
          { kind: "item", label: "폴더 노트 템플릿…", icon: "page", onSelect: () => setFolderTemplateId(folder.id) },
          { kind: "item", label: "하위 정리 폴더 만들기", icon: "folder", onSelect: () => setSidebarPending({ createIn: folder.id }) },
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
          // Its AI conversations have no rows of their own: each opens beside the document here.
          // Its AI conversations have no rows of their own: each carries every action its row had.
          ...(row.agents.length ? [{ kind: "separator" as const }, ...row.agents.map((agent): MenuEntry => ({ kind: "submenu", label: `문서 AI · ${PROVIDER_LABEL[agent.provider]} · ${statusText(agent)}`, icon: "chat", items: sessionItems(agent, row.work) }))] : []),
          { kind: "separator" },
          { kind: "item", label: "다른 앱으로 열기", icon: "arrowRight", onSelect: () => void api.openExternal(artifact.id).catch(fail) },
          ...(inDesktop ? [{ kind: "item" as const, label: "폴더에서 보기", icon: "folderOpen" as const, onSelect: () => void openPath(artifact.path, true) }] : []),
          { kind: "item", label: "경로 복사", icon: "copy", onSelect: copy(artifact.path, "경로를 복사했습니다.") },
          { kind: "separator" },
          // What the gateway says can be done with this file, asked as the menu opened. Each item
          // sends exactly its own action; 목록에서 빼기 never touches the file.
          ...(removal && !removal.actions.length
            ? [{ kind: "item" as const, label: "목록에서 빼기", icon: "x" as const, disabled: true, disabledReason: removal.reason ?? "지금은 뺄 수 없습니다.", onSelect: () => undefined }]
            : [{ kind: "item" as const, label: "목록에서 빼기", icon: "x" as const, hint: "파일은 그대로", onSelect: () => void removeDoc(artifact, "unlisted") }]),
          ...(removal?.actions.includes("trash") ? [{ kind: "item" as const, label: "휴지통으로 옮기기", icon: "trash" as const, hint: "보관함에서 되돌림", danger: true, onSelect: () => void removeDoc(artifact, "trash") }] : []),
        ];
        return { x, y, title: artifact.name, items };
      }
      return null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, state, actions, archive, exportSession, openPath, openSession, visibleIds, startNew, docActions, fail, setToast, linkApi, single, creationMenu, detachSessionWindow, sharedBrowser, savePrefs],
  );

  /**
   * 목록에서 빼기 / 휴지통으로 옮기기, both undone by 되돌리기 (here, or in 보관함). The open editors are
   * asked first for unsaved edits; the gateway then does exactly the chosen action or refuses. A
   * refused trash (the file is no longer the app's to move) offers 목록에서 빼기 instead.
   */
  const editors = useRef(new EditorRegistry());
  const onEditorHandle = useCallback((artifactId: string, viewId: string, handle: EditorHandle | null) => editors.current.set(artifactId, viewId, handle), []);
  documentTabsRef.current = (artifactId: string) => documentTabs(artifactId);
  const [unsavedAsk, setUnsavedAsk] = useState<{ name: string; certain: boolean; answer: (go: boolean) => void } | null>(null);
  /** The tabs (in every pane) showing a document, alone or beside its conversation. */
  const documentTabs = (artifactId: string) => layoutRef.current.panes.flatMap((pane) => tabsOf(pane)
    .filter((tab) => viewDocument(tab.view) === artifactId).map((tab) => ({ pane, tab })));
  const [refusedTrash, setRefusedTrash] = useState<{ artifact: Artifact; reason: string } | null>(null);
  async function removeDoc(artifact: Artifact, action: "trash" | "unlisted"): Promise<void> {
    if (!api) return;
    try {
      const result = await removeAfterSaving(editors.current.states(artifact.id),
        (certain) => new Promise<boolean>((answer) => setUnsavedAsk({ name: artifact.name, certain, answer })),
        () => leaveEditors(documentTabs(artifact.id).flatMap(({ tab }) => (leaveGuards.current[tab.id] ? [() => leaveGuards.current[tab.id]!()] : []))),
        () => api.removeDocument(artifact.id, action));
      if (result === "cancelled") return;
      setToast({
        text: result.removed?.kind === "trash" ? "문서를 앱 휴지통으로 옮겼습니다" : "목록에서 뺐습니다. 파일은 그대로입니다",
        action: { label: "되돌리기", run: () => void restoreDocument(artifact.id).catch(fail) },
      });
    } catch (error) {
      if (action === "trash" && error instanceof ApiRequestError && error.code === "removal_changed") return setRefusedTrash({ artifact, reason: error.message });
      fail(error);
    }
  }

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
    navigateTo({ workId: target.id, sessionId: chosen?.id ?? null, view: { kind: "work" } }, () => {
      if (chosen && becomesActive(latest, chosen)) {
        dispatch({ type: "focus", work: latest, session: chosen });
        void api?.updateWork(latest.id, { activeSessionId: chosen.id }).catch(fail);
      }
    });
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
    closeWebTab: session => { if (session.pageAgent) void sharedBrowser.close(session.pageAgent.pageId).catch(fail); },
    openSession,
    openWork: (target) => actions.openProject(target),
    openDoc: (artifact: Artifact) => docActions.openArtifact(artifact.id),
    docRemoval: (artifact) => api ? api.documentRemoval(artifact.id) : Promise.reject(new Error("연결되지 않았습니다.")),
    // The pane's session names the AI; the document view draws that one (also when already open)
    // and opens its conversation.
    openDocAgent: entries.documentRow,
    newSession: ({ folderId, work: owner, provider }) => {
      if (owner) void actions.newSession(owner, provider ?? engine).then(session => { if (session) actions.selectSession(owner, session); });
      else startNew(folderId ?? null);
    },
    creationMenu: (owner, x, y, folderId) => setContextMenu(creationMenu(layoutRef.current.focus, owner, x, y, folderId)),
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
          { id: "new", label: "새로 만들기", icon: "plus" as const, hint: shortcuts.newWork, run: () => openCreate.current() },
          { id: "home", label: "홈", icon: "home" as const, run: () => startNew(null) },
        ]),
    ...(visibleSession
      ? [
          { id: "export-work", label: "지금 대화를 마크다운으로 저장 (작업 폴더)", icon: "markdown" as const, run: () => void exportSession(visibleSession, "work") },
          { id: "export-copy", label: "지금 대화를 마크다운으로 복사", icon: "copy" as const, run: () => void exportSession(visibleSession, "text") },
          ...(single || api?.isRemote
            ? []
            : [{ id: "detach", label: "지금 세션을 새 창으로 떼어 내기", icon: "openNew" as const, run: () => detachSessionWindow(visibleSession) }]),
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
    { id: "office-settings", label: "문서 AI 설정", icon: "tool", run: () => setOfficeSettingsOpen(true) },
    { id: "dropbox", label: "Dropbox 폴더 연결", icon: "folder", run: () => setDropboxOpen(true) },
    { id: "office-import", label: "이음오피스 설정 가져오기", icon: "folder", run: () => setOfficeImportOpen(true) },
    { id: "office-knowledge", label: "지식베이스", icon: "tool", run: () => openKnowledge() },
    { id: "connections", label: "연결과 설정", icon: "dots", run: () => setMenuOpen(true) },
    { id: "onboarding", label: "처음 안내 다시 보기", icon: "eye", run: () => setOnboardingAgain(true) },
  ];


  // ── two panes: what each shows, opening on a side, focus, close, swap (panes.ts, Panes.tsx) ──
  const pkmKey = (target: PkmTarget) => (target.kind === "vault" || target.kind === "note" ? `${target.kind}:${target.path}` : `cards-${target.kind}:${target.id}`);
  /** What a pane shows, as keys: the same conversation or document is never in both panes. */
  const keysOf = (pane: Pane<View>): string[] => {
    const at = pane.view;
    if (at.kind === "work") {
      const shown = sessionIn(pane);
      const beside = besideOf(at);
      return [...(shown ? [`session:${shown.id}`] : pane.workId ? [`work:${pane.workId}`] : []), ...(beside ? [beside.kind === "document" ? `doc:${beside.artifactId}` : `browser:${beside.pageId}`] : [])];
    }
    if (at.kind === "document") return [`doc:${at.artifactId}`];
    if (at.kind === "presentation") return [`presentation:${at.id}`];
    if (at.kind === "project") return [`project:${at.workId}`];
    if (at.kind === "terminal") return [`terminal:${at.terminalId}`];
    if (at.kind === "browser") return [`browser:${at.pageId}`];
    if (at.kind === "pkm") return [pkmKey(at.target)];
    if (at.kind === "archive") return ["archive"];
    return [`home:${at.folderId ?? ""}`];
  };
  const itemKey = (item: PaneItem): string => {
    if (item.kind === "session" && state.sessions[item.id]?.pageAgent && !state.sessions[item.id]?.archivedAt) return `browser:${state.sessions[item.id]!.pageAgent!.pageId}`;
    if (item.kind === "session" && state.sessions[item.id]?.documentAgent) return `doc:${state.sessions[item.id]!.documentAgent!.artifactId}`;
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
      // The opener's route: a live document AI beside its document, an archived one as itself.
      const session = state.sessions[item.id];
      return session ? sessionRoute(session, (artifactId) => Boolean(state.artifacts[artifactId])).content : null;
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
    if (item.kind === "note" || item.kind === "vault") return { view: { kind: "pkm", target: { kind: item.kind, path: item.path, ...(item.kind === "note" ? { location: item.location } : {}) } }, workId: null, sessionId: null };
    if (item.kind === "folder") return { view: { kind: "pkm", target: { kind: "folder", id: item.id } }, workId: null, sessionId: null };
    return null;
  };
  /** The session a pane taking the focus shows becomes its work's active one, as opening it does. */
  const showSessionOf = (ownerId: string | null, sessionId: string | null) => {
    const owner = ownerId ? state.works[ownerId] : undefined;
    const session = sessionId ? state.sessions[sessionId] : undefined;
    if (owner && session && becomesActive(owner, session)) {
      dispatch({ type: "focus", work: owner, session });
      void api?.updateWork(owner.id, { activeSessionId: session.id }).catch(fail);
    }
    if (ownerId && !single) localStorage.setItem(LAST_WORK_KEY, ownerId);
  };
  const flushEditors = async () => { await Promise.all(Object.values(leaveGuards.current).filter((guard) => !!guard).map((guard) => guard())); };
  const persistCurrentLayout = async () => {
    if (!layoutPersistence || !layoutReady || single) return;
    window.clearTimeout(layoutSaveTimer.current);
    const key = layoutScopeRef.current;
    try { await layoutPersistence.write(key, { version: 2, ...layoutRef.current }); }
    catch (error) { setLayoutProblem({ key, message: error instanceof Error ? error.message : String(error) }); throw error; }
  };
  openWorkspaceRef.current = async (workspace) => {
    if (!api || !layoutPersistence || !layoutReady || layoutSwitching.current) return false;
    const key = workspace?.id ?? GLOBAL_LAYOUT;
    if (key === layoutScopeRef.current) return true;
    layoutSwitching.current = true;
    try {
      await flushEditors();
      if (single) {
        if (!workspace) return false;
        const owner = stateRef.current.works[workspace.workId];
        if (!owner || workspace.removedAt || workspace.archivedAt) return false;
        const chosen = Object.values(stateRef.current.sessions).filter((entry) => entry.workspaceId === workspace.id && !entry.archivedAt).sort((a, b) => b.updatedAt - a.updatedAt)[0]
          ?? await api.createSession(owner.id, engine, { workspaceId: workspace.id });
        actions.selectSession(owner, chosen);
        return true;
      }
      await persistCurrentLayout();
      const record = await layoutPersistence.read(key);
      let fallback = singleLayout<View>({ kind: "new", folderId: null }, null);
      if (workspace && !record) {
        const owner = stateRef.current.works[workspace.workId];
        if (!owner || workspace.removedAt || workspace.archivedAt) throw new Error("이 작업공간을 열 수 없습니다. 먼저 보관 상태와 폴더를 확인해 주세요.");
        const candidates = Object.values(stateRef.current.sessions).filter((entry) => entry.workspaceId === workspace.id && !entry.archivedAt).sort((a, b) => b.updatedAt - a.updatedAt);
        const chosen = candidates[0] ?? await api.createSession(owner.id, engine, { workspaceId: workspace.id });
        dispatch({ type: "focus", work: owner, session: chosen });
        fallback = { ...singleLayout<View>({ kind: "work" }, owner.id), panes: [{ id: "a", view: { kind: "work" }, workId: owner.id, sessionId: chosen.id }] };
      }
      const restored = restoreWorkspaceLayout(record?.layout, fallback);
      layoutScopeRef.current = key; setLayoutScope(key); layoutSaved.current = "";
      updateLayout(() => restored);
      const focused = focusedPane(restored);
      showSessionOf(focused.workId, focused.sessionId);
      savePrefs({ layoutScope: key, paneLayout: undefined });
      setLayoutProblem(null);
      return true;
    } catch (error) { fail(error); return false; }
    finally { layoutSwitching.current = false; }
  };
  const resolveLayoutProblem = async (keepLocal: boolean) => {
    if (!layoutProblem || !layoutPersistence || layoutSwitching.current) return;
    layoutSwitching.current = true;
    window.clearTimeout(layoutSaveTimer.current);
    try {
      if (!keepLocal) await flushEditors();
      const key = layoutProblem.key;
      const record = await layoutPersistence.read(key);
      if (keepLocal && layoutReady) await layoutPersistence.write(key, { version: 2, ...layoutRef.current });
      else {
        const restored = restoreWorkspaceLayout(record?.layout ?? prefsRef.current.paneLayout, singleLayout<View>({ kind: "new", folderId: null }, null));
        layoutScopeRef.current = key; setLayoutScope(key); layoutSaved.current = "";
        updateLayout(() => restored); setLayoutReady(true);
      }
      savePrefs({ layoutScope: key, paneLayout: undefined });
      setLayoutProblem(null);
    } catch (error) { setLayoutProblem({ key: layoutProblem.key, message: error instanceof Error ? error.message : String(error) }); }
    finally { layoutSwitching.current = false; }
  };
  /** The conversation the focused pane keeps showing once it loses the focus. */
  const keptOf = (pane: Pane<View>) => (pane.view.kind === "work" ? (sessionIn(pane)?.id ?? null) : null);
  const focusPaneNow = (id: PaneId) => {
    const current = layoutRef.current;
    const target = paneById(current, id);
    if (current.focus === id || !target) return;
    updateLayout((latest) => focusPane(latest, id, keptOf(focusedPane(current))));
    showSessionOf(target.workId, target.sessionId);
  };
  // ⋯ › 단축키 "다른 칸으로": the keyboard handler above calls the current one (false: one pane).
  focusOtherPane.current = () => {
    const other = otherPane(layoutRef.current);
    if (!other) return false;
    focusPaneNow(other.id);
    return true;
  };
  /** Already shown in the other pane: the focus goes there (true). */
  const focusIfShown = (key: string) => {
    const existing = findTab(layoutRef.current, key);
    if (existing) {
      selectTabNow(existing.pane.id, existing.tab.id);
      return true;
    }
    // Beside the conversation on screen in the focused pane: it is shown already.
    if (keysOf(focusedPane(layoutRef.current)).includes(key)) return true;
    const id = shownElsewhere(layoutRef.current, (pane) => keysOf(pane).includes(key));
    if (id) focusPaneNow(id);
    return id !== null;
  };
  /** The document on screen dragged to a side of its only pane: it moves there, its conversation stays beside. */
  const movesOut = (current: Layout<View>, item: PaneItem) => {
    const only = current.panes.length === 1 ? current.panes[0]! : null;
    return Boolean(only && item.kind === "doc" && only.view.kind === "document" && only.view.artifactId === item.id && only.workId);
  };
  const effectOf = (item: PaneItem, target: PaneTarget) => item.kind === "tab" ? "swap" : (target.side !== "center" && movesOut(layoutRef.current, item) ? "split" : effectAt(layoutRef.current, target, showsItem(item)));
  const placeItemAt = (item: PaneItem, target: PaneTarget) => {
    // 오른쪽에 열기 / a drag places without going through the desk: still the person's choice.
    navigated.current = true;
    if (item.kind === "tab") {
      const source = layoutRef.current.panes.flatMap(tabsOf).find((tab) => tab.id === item.id);
      const run = () => updateLayout((current) => moveTab(current, item.id, target, target.tabIndex));
      if (source && target.side === "center") afterLeaving(target.paneId, source.view, run, item.id);
      else run();
      return;
    }
    const content = single ? null : contentOf(item);
    if (!content) return;
    const current = layoutRef.current;
    // A document beside a conversation is not opened a second time by dragging it: the app goes to it.
    const besideHolder = item.kind === "doc" ? viewsOfDocument(current, item.id).find((holder) => holder.beside) : undefined;
    if (besideHolder) { selectTabNow(besideHolder.paneId, besideHolder.tabId); return; }
    const existingTab = findTab(current, contentKey(content));
    // A document AI placed in a pane has its conversation brought out there, as when it is opened.
    const placed = item.kind === "session" ? state.sessions[item.id] : undefined;
    const reveal = placed ? sessionRoute(placed, (artifactId) => Boolean(state.artifacts[artifactId])).reveal : null;
    const askReveal = () => { if (reveal) setRevealAgents((latest) => ({ ...latest, [reveal.artifactId]: { sessionId: reveal.sessionId } })); };
    if (existingTab) {
      updateLayout((latest) => {
        const moved = moveTab(latest, existingTab.tab.id, target, target.tabIndex);
        const holder = reveal ? findTab(moved, contentKey(content)) : null;
        // Its document's tab names this AI once it is the one on screen there.
        return holder && activeTab(holder.pane).id === holder.tab.id ? setPane(moved, holder.pane.id, content) : moved;
      });
      showSessionOf(content.workId, content.sessionId);
      askReveal();
      return;
    }
    const shows = showsItem(item);
    const leaving = focusedPane(current);
    const conversation = target.side !== "center" && movesOut(current, item);
    const effect = conversation ? "split" : effectAt(current, target, shows);
    const holder = current.panes.find(shows);
    const shown = holder ? { workId: holder.workId, sessionId: sessionIn(holder)?.id ?? holder.sessionId } : content;
    // The document dragged out of its only pane leaves its conversation behind in that pane.
    const unsplit: View | null = conversation ? { kind: "work" } : null;
    const keep = conversation ? (sessionIn(leaving)?.id ?? null) : keptOf(leaving);
    const run = () => {
      updateLayout((latest) => placeAt(unsplit ? setPane(latest, leaving.id, { view: unsplit }) : latest, content, target, keep, shows));
      if (shown) showSessionOf(shown.workId, shown.sessionId);
      askReveal();
    };
    if (effect === "replace") afterLeaving(target.paneId, content.view, run);
    else if (unsplit) afterLeaving(leaving.id, unsplit, run);
    else run();
  };
  const placeItem = (item: PaneItem, side: Side) => placeItemAt(item, { paneId: layoutRef.current.focus, side });
  const splitPaneNow = (id: PaneId, side: Side) => {
    if (single) return;
    const current = layoutRef.current;
    if (current.panes.length >= MAX_PANES) return setToast(failure(`한 창에는 최대 ${MAX_PANES}칸을 열 수 있습니다.`));
    const source = paneById(current, id);
    if (source?.view.kind === "terminal" && api) {
      void api.createTerminal(source.view.workspaceId, { requestId: crypto.randomUUID() }).then((entry) => {
        updateLayout((latest) => paneById(latest, id) ? splitPane(latest, id, side, { view: { kind: "terminal", terminalId: entry.id, workspaceId: entry.workspaceId, label: entry.label }, workId: entry.workId, sessionId: null }, keptOf(focusedPane(latest))) : latest);
      }).catch(fail);
      return;
    }
    updateLayout((latest) => splitPane(latest, id, side, { view: { kind: "new", folderId: null }, workId: null, sessionId: null }, keptOf(focusedPane(current))));
  };
  const closePaneNow = (id: PaneId) => {
    const current = layoutRef.current;
    if (current.panes.length < 2) return;
    const next = closePane(current, id);
    const rest = focusedPane(next);
    const previous = paneById(current, rest.id);
    const guards = tabsOf(paneById(current, id)!).map((tab) => leaveGuards.current[tab.id]).filter((guard) => !!guard);
    leaveGate.current.run(id, async () => { await Promise.all(guards.map((guard) => guard("close"))); }, () => {
      updateLayout((latest) => closePane(latest, id));
      if (rest.id !== current.focus && previous) showSessionOf(previous.workId, previous.sessionId);
    }, fail, `close-group:${id}`);
  };
  const selectTabNow = (paneId: string, tabId: string, then?: () => void) => {
    const group = paneById(layoutRef.current, paneId);
    const tab = group && tabsOf(group).find((entry) => entry.id === tabId);
    if (!tab) return;
    afterLeaving(paneId, tab.view, () => {
      updateLayout((current) => activateTab(current, paneId, tabId));
      showSessionOf(tab.workId, tab.sessionId);
      then?.();
    }, tabId);
  };
  selectTabRef.current = selectTabNow;
  const closeTabNow = (paneId: string, tabId: string) => {
    const guard = leaveGuards.current[tabId];
    leaveGate.current.run(paneId, guard ? () => guard("close") : null, () => {
      updateLayout((current) => closeTab(current, paneId, tabId, { view: { kind: "new", folderId: null }, workId: null, sessionId: null }));
    }, fail, tabId);
  };
  panesRef.current = { focusIfShown, placeItem };
  const paneActions = useMemo<PaneActions>(() => ({ openBeside: (item) => panesRef.current.placeItem(item, "right") }), []);
  /** A pane's header: what it shows, and what dragging the header carries. */
  /** An answer that landed off screen, until it is looked at. */
  const unseenAnswer = (session: Session | undefined) => Boolean(session && unseen.has(session.id) && !isWorking(session));
  const paneHead = (pane: Pane<View>): PaneHead => {
    const at = pane.view;
    if (at.kind === "presentation") return { title: `${state.artifacts[at.artifactId]?.name ?? "HTML"} · 발표`, icon: <FormatBadge format="html" />, item: null };
    const owner = pane.workId ? state.works[pane.workId] : undefined;
    const artifact = at.kind === "document" ? state.artifacts[at.artifactId] : undefined;
    if (artifact) {
      const agent = Object.values(state.sessions).filter(entry => entry.documentAgent?.artifactId === artifact.id && !entry.archivedAt).sort((a, b) => b.createdAt - a.createdAt)[0];
      return { project: owner?.title, kindLabel: "문서", title: artifact.name, icon: <FormatBadge format={artifact.format} />, hint: artifact.path, unseen: unseenAnswer(agent), item: { kind: "doc", id: artifact.id } };
    }
    if (at.kind === "work" && owner) {
      const shown = sessionIn(pane);
      return {
        title: shown?.purpose ?? owner.title,
        project: owner.title, kindLabel: shown?.pageAgent ? "웹 AI" : shown?.documentAgent ? "문서 AI" : "대화", status: shown ? statusText(shown) : undefined, unseen: unseenAnswer(shown),
        icon: shown ? <EngineMark provider={shown.provider} size={14} /> : <Icon name="project" size={14} />,
        hint: owner.cwd,
        item: shown ? { kind: "session", id: shown.id } : { kind: "work", id: owner.id },
      };
    }
    if (at.kind === "project") return { kindLabel: "프로젝트", title: state.works[at.workId]?.title ?? "프로젝트", icon: <Icon name="project" size={14} />, item: { kind: "project", id: at.workId } };
    if (at.kind === "terminal") return { project: owner?.title, kindLabel: "터미널", title: at.label, icon: <Icon name="terminal" size={14} />, hint: state.workspaces[at.workspaceId]?.cwd, item: null };
    if (at.kind === "browser") {
      const page = browserState.pages.find(entry => entry.pageId === at.pageId);
      return { project: owner?.title, kindLabel: "웹", title: page?.title || "웹 탭", icon: <Icon name="globe" size={14} />, hint: page?.url, unseen: unseenAnswer(sessionIn(pane)), item: null };
    }
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

  useEffect(() => {
    if (!layoutReady || single || !sharedBrowser.available || layoutSwitching.current) return;
    const pages = browserState.pages.filter(page => page.agentSessionId && page.driverId === sharedBrowser.driverId && page.status === "ready" && !seenAgentPages.current.has(page.pageId));
    if (!pages.length) return;
    updateLayout(current => {
      let next = current;
      for (const page of pages) {
        const key = `browser:${page.pageId}`;
        if (!findTab(next, key) && !viewsOfPage(next, page.pageId).length) {
          const owner = next.panes.find(pane => tabsOf(pane).some(tab => tab.view.kind === "work" && tab.sessionId === page.agentSessionId));
          next = addBackgroundTab(next, owner?.id ?? next.focus, { view: { kind: "browser", pageId: page.pageId }, workId: page.workId, sessionId: page.sessionId });
        }
        // Keep a deliberate user close final; polling must not reopen an already offered page.
        if (findTab(next, key)) seenAgentPages.current.add(page.pageId);
      }
      return next;
    });
  }, [browserState.pages, sharedBrowser, layoutReady, single, layout, updateLayout]);

  useEffect(() => {
    const latest = browserState.pages.reduce<(typeof browserState.pages)[number] | null>((found, page) => (page.native?.interactionAt ?? 0) > (found?.native?.interactionAt ?? 0) ? page : found, null);
    const at = latest?.native?.interactionAt ?? 0;
    if (!latest || at <= lastNativeInteraction.current) return;
    lastNativeInteraction.current = at;
    if (at <= lastDomInteraction.current) return;
    const found = findTab(layoutRef.current, `browser:${latest.pageId}`);
    if (found && (layoutRef.current.focus !== found.pane.id || activeTab(found.pane).id !== found.tab.id)) updateLayout(current => activateTab(current, found.pane.id, found.tab.id));
    // Keep focus inside the native page: only the surrounding pane selection changes.
  }, [browserState.pages, updateLayout]);

  if (!api) {
    return (
      <div className="fatal">
        <h1>Achmage Workbench</h1>
        <p>앱 내부 연결 정보가 없습니다. 데스크톱 앱에서 다시 열어 주세요.</p>
      </div>
    );
  }

  const showStart = startScreen;
  const brandAtHome = showStart && heroTabs.has(focusedTabId);
  /** A work's open documents as tabs, in a pane. */
  // The conversation, alone or beside a document ("나란히"). A detached window shows its own
  // session, whichever one the work has in front elsewhere; so does a pane without the focus.
  const workView = (shown: Work, session: Session | undefined, pinned: boolean, paneTabs: ReactNode, ids: string[], modes: ModeProps, docModes?: DocModes) => (
    <WorkView
      api={api!}
      onToast={setToast}
      state={state}
      work={session && (pinned || session.id !== shown.activeSessionId) ? { ...shown, activeSessionId: session.id } : shown}
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
      modes={{ ...modes, groupedTabs: !single }}
      pages={browserState.pages}
      docModes={docModes}
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
  const paneView = (pane: Pane<View>, focused: boolean, split: boolean, tabId: string, tabActive: boolean): ReactNode => {
    const at = pane.view;
    const owner = focused ? work : pane.workId ? state.works[pane.workId] : undefined;
    const session = sessionIn(pane);
    const ids = focused ? openDocIds : docsOf(owner);
    const paneTabs = null;
    const pinned = focused ? Boolean(single) : true;
    const tabUi = tabsOf(pane).find((tab) => tab.id === tabId)?.ui;
    const start = at.kind === "new" || (at.kind === "work" && !owner);
    if (at.kind === "presentation") {
      const presentation = presentations.current.get(at.id);
      return presentation ? <iframe data-office-presentation={at.ownerTabId} title={`${presentation.title || "HTML"} 발표`} src={presentation.url} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads" allowFullScreen style={{ width: "100%", height: "100%", border: 0, display: "block" }} /> : null;
    }
    if (at.kind === "terminal") return <Suspense fallback={<LoadingView label="터미널을 여는 중…" shape="work" />}><TerminalView api={api} id={at.terminalId} focused={focused && tabActive} uiState={tabUi} onUiState={uiOf[tabId]} onList={() => { const space = state.workspaces[at.workspaceId]; if (space) setTerminalWorkspace(space); }} /></Suspense>;
    const closeThisTab = () => updateLayout((current) => closeTab(current, pane.id, tabId, { view: { kind: "new", folderId: null }, workId: null, sessionId: null }));
    /** A web page: in a tab of its own with its AI beside it, or (`hosted`) beside a conversation. */
    const browserView = (pageId: string, hosted?: { onClose: () => void; onWide: () => void; over: boolean; back: string | null }) => (
      <BrowserView key={pageId} browser={sharedBrowser} api={api} state={state} pageId={pageId} visible={tabActive && (!narrowPanes || focused)} parentSessionId={owner ? activeOf(owner)?.id ?? null : null} actions={actions}
        engine={engine}
        hosted={hosted}
        onStart={(text, provider, choice) => {
          const page = sharedBrowser.getState().pages.find(page => page.pageId === pageId);
          return startWork(text, provider, null, null, choice, page ? { kind: "work", workId: page.workId } : { kind: "new" }, pane.id);
        }}
        onNew={target => setNewBrowser({ ...target, paneId: pane.id })}
        onClosed={hosted ? () => updateLayout((current) => withoutCompanion(current, tabId)) : closeThisTab} onOpenSession={openSession} onLeaveGuard={guardOf[tabId]}
        onSessionMenu={(agent, x, y) => {
          const request = menuFor({ type: "session", id: agent.id, depth: 0, session: agent, work: state.works[agent.workId] }, x, y);
          if (request) setContextMenu(request);
        }}
        onTranscript={(sessionId, transcript) => dispatch({ type: "transcript", sessionId, transcript })}
        focusItem={!hosted && focusItem && state.sessions[focusItem.sessionId]?.pageAgent?.pageId === pageId ? focusItem : null} onFocusDone={() => setFocusItem(null)} />
    );
    if (at.kind === "browser" || (singleSession?.pageAgent && !singleSession.archivedAt && at.kind === "work")) return browserView(at.kind === "browser" ? at.pageId : singleSession!.pageAgent!.pageId);
    /** A document: in a tab of its own with its AI beside it, or (`hosted`) beside a conversation. */
    const documentView = (project: Work, artifactId: string, proposalId: string | null, shown: Session | null, hosted?: { onClose: () => void; onWide: () => void; onAgent: (agent: Session) => void; over: boolean; back: string | null }) => (
      <DocumentView
        key={artifactId}
        api={api}
        state={state}
        artifactId={artifactId}
        focusProposalId={proposalId}
        focusItem={!hosted && focusItem && state.sessions[focusItem.sessionId]?.documentAgent?.artifactId === artifactId ? focusItem : null}
        onFocusDone={() => setFocusItem(null)}
        work={project}
        session={shown}
        visible={tabActive && (!narrowPanes || focused)}
        tabs={paneTabs}
        openDocIds={ids}
        onLeaveGuard={guardOf[tabId]}
        onMcpClose={hosted ? () => updateLayout((current) => withoutCompanion(current, tabId)) : closeThisTab}
        // The conversation's tab keeps the conversation's place; a companion's view is not its to remember.
        uiState={hosted ? undefined : tabUi}
        onUiState={hosted ? undefined : uiOf[tabId]}
        onAgentDrawn={onAgentDrawn}
        onEditorHandle={onEditorHandle}
        revealAgent={hosted ? null : revealAgents[artifactId] ?? null}
        onRevealDone={onRevealDone}
        hosted={hosted}
        queued={actions.queued}
        onReview={reviewOf[tabId]}
        onRead={() => setWorkMode("read")}
        onBeside={hosted ? undefined : () => showBeside(pane.id, conversationOf(pane), { kind: "document", artifactId, proposalId: null })}
        onSessionMenu={(agent, x, y) => {
          const request = menuFor({ type: "session", id: agent.id, depth: 0, session: agent, work: project }, x, y);
          if (request) setContextMenu(request);
        }}
        onBack={() => {
          if (hosted) return hosted.onClose();
          const back = conversationOf(pane);
          if (back.sessionId !== pane.sessionId) navigateTo(back);
          else setViewOf(pane.id, { kind: "work" });
        }}
        onToast={setToast}
        onOpenArtifact={(opened, scope) => setViewOf(pane.id, { kind: "document", artifactId: opened, proposalId: null }, scope)}
        onPresent={(value) => {
          const id = crypto.randomUUID(); presentations.current.set(id, value);
          setViewOf(pane.id, { kind: "presentation", id, artifactId, ownerTabId: tabId }, { workId: project.id, workspaceId: state.artifacts[artifactId]?.workspaceId, preserveSource: true });
        }}
        pickFile={inDesktop ? pickFileNative : null}
        onPickTarget={() => actions.pickSession(project, shown)}
        onAiSettings={() => setOfficeSettingsOpen(true)}
        onExternalSetup={() => setIeumAppOpen(true)}
        onAnswer={(answered, itemId, decision, response) => actions.answer(answered, itemId, decision, response)}
        onSend={async (target, text, refs, handoffTo, create, attachments) => {
          let source = target;
          if (!source) source = await actions.newSession(project, engine);
          if (!source) return false;
          if (handoffTo) return actions.handoff(source, handoffTo, text, refs, attachments);
          return actions.send(source, text, refs, create, "auto", attachments);
        }}
      />
    );
    if (at.kind === "document" && owner) return <Suspense fallback={<LoadingView label="문서를 여는 중…" shape="document" />}>{documentView(owner, at.artifactId, at.proposalId, session ?? null)}</Suspense>;
    if (at.kind === "project") {
      return (
        <ProjectView
          // One page per note: a tab that goes on to another project starts that project's page anew.
          key={at.workId}
          api={api}
          state={state}
          workId={at.workId}
          onLeaveGuard={guardOf[tabId]}
          onOpenSession={(target, itemId) => {
            openSession(target);
            if (itemId) setFocusItem({ sessionId: target.id, itemId, nonce: Date.now() });
          }}
          onOpenProject={actions.openProject}
          onOpenNote={(path) => setView({ kind: "pkm", target: { kind: "note", path } })}
          onOpenDocument={(artifactId, proposalId) => {
            const artifact = state.artifacts[artifactId];
            if (artifact) navigateTo({ workId: artifact.workId, sessionId: null, view: { kind: "document", artifactId, proposalId } });
          }}
          onToast={setToast}
          onError={fail}
          openMenu={setContextMenu}
          onCreate={anchor => { const box = anchor.getBoundingClientRect(); setContextMenu(creationMenu(pane.id, state.works[at.workId] ?? null, box.left, box.bottom)); }}
        />
      );
    }
    if (at.kind === "pkm") return <PkmCenter target={at.target} active={focused && tabActive} onNavigate={target => updateLayout(current => updateTabView(current, tabId, () => ({ kind: "pkm", target })))} />;
    if (at.kind === "archive") return <ArchiveView state={state} onRestore={actions.restore} onOpenSession={openSession} onOpenWork={openWorkNow} onDeleteWork={setDeletingWork}
      onRestoreDoc={(artifact) => void restoreDocument(artifact.id).then(() => setToast(`「${artifact.name}」을(를) 되돌렸습니다.`)).catch(fail)}
      onSaveDocElsewhere={(artifact) => void (async () => {
        if (!api) return;
        if (!inDesktop) {
          // A browser cannot pick a place: the file is downloaded; the trash keeps its own.
          saveBlobAs(await api.trashFile(artifact.id), artifact.name);
          setToast("내려받았습니다. 보관함의 기록은 그대로입니다.");
          return;
        }
        const path = await pickSavePath(artifact.name);
        if (!path) return;
        const saved = await api.saveDocumentCopy(artifact.id, path);
        setToast(`「${artifact.name}」을(를) 저장했습니다: ${saved.path}`);
      })().catch(fail)}
      onPurgeDoc={(artifact) => api ? api.purgeDocument(artifact.id) : Promise.resolve()}
      onClose={() => setView({ kind: "work" })} />;
    if (start) {
      return (
        <PaneStart split={split} works={Object.values(state.works).filter(work => !work.archivedAt).sort((a, b) => b.updatedAt - a.updatedAt)} onProject={id => placeItemAt({ kind: "project", id }, { paneId: pane.id, side: "center" })}>
        <StartView
          state={state}
          autoFocus={focused}
          folderId={at.kind === "new" ? at.folderId : null}
          draftKey={pane.id === "a" ? `new:${at.kind === "new" ? at.folderId ?? "root" : "root"}` : `new:${pane.id}:${at.kind === "new" ? at.folderId ?? "root" : "root"}`}
          onClearFolder={() => setView({ kind: "new", folderId: null })}
          onStart={(text, provider, cwd, choice, pick) => startWork(text, provider, cwd, at.kind === "new" ? at.folderId : null, choice, pick, pane.id)}
          onOpenBrowser={sharedBrowser.available ? address => openBrowserRef.current(pane.id, { ...creationTarget(pane.id), url: address }) : undefined}
          onOpenWork={openWorkNow}
          onOpenProject={actions.openProject}
          onOpenSession={(session, itemId) => {
            openSession(session);
            if (itemId) setFocusItem({ sessionId: session.id, itemId, nonce: Date.now() });
          }}
          onOpenDoc={(artifactId) => docActions.openArtifact(artifactId)}
          api={api}
          homeMode={prefs.homeMode}
          onHomeMode={(mode) => savePrefs({ homeMode: mode })}
          homeViews={prefs.homeViews}
          onHomeViews={(views) => savePrefs({ homeViews: views })}
          motion={prefs.brandMotion !== false}
          onHero={shown => heroIn(tabId, shown)}
          pickFolder={inDesktop ? pickFolderNative : null}
          engine={engine}
          setEngine={setEngine}
        />
        </PaneStart>
      );
    }
    if (!owner) return null;
    // 곁 화면: the conversation keeps its place and its input; what it opened is beside it. Asking
    // there goes to this conversation (it is its document, its page).
    const beside = besideOf(at);
    // Laid over its conversation, the way back says what that conversation is doing (e.g. 승인 필요).
    const hosted = { onClose: () => closeCompanion(pane.id, tabId), over: Boolean(coveredTabs[tabId]), back: session && session.status !== "idle" && !session.archivedAt ? statusText(session) : null };
    const besideDoc = beside?.kind === "document" ? state.artifacts[beside.artifactId] : undefined;
    const companion = besideDoc && beside?.kind === "document"
      ? (
        <Suspense fallback={<LoadingView label="문서를 여는 중…" shape="document" />}>
          {documentView(state.works[besideDoc.workId] ?? owner, besideDoc.id, beside.proposalId,
            // An external citation has its own workspace: the conversation is not its AI's parent.
            session && session.workId === besideDoc.workId && session.workspaceId === besideDoc.workspaceId ? session : null,
            // 탭으로 열어 고치기 / 문서 AI: the person's move to the document's own tab (beside the conversation it only read).
            { ...hosted, onWide: () => setViewOf(pane.id, { kind: "document", artifactId: besideDoc.id, proposalId: null }, undefined, true), onAgent: (agent) => openSession(agent) })}
        </Suspense>
      )
      : beside?.kind === "browser"
        ? browserView(beside.pageId, { ...hosted, onWide: () => {
          const page = sharedBrowser.getState().pages.find((entry) => entry.pageId === beside.pageId);
          if (page) navigateTo({ view: { kind: "browser", pageId: page.pageId }, workId: page.workId, sessionId: page.sessionId }, undefined, true);
        } })
        : null;
    return (
      <Beside
        chat={workView(owner, session, pinned, paneTabs, ids, { single: Boolean(single), paned: split || !focused || companion !== null, uiState: tabUi, onUiState: uiOf[tabId] }, conversationModes(focused && tabActive))}
        content={companion}
        over="content"
        // A document is read beside the conversation: the read view's minimum, else it lies over.
        contentMin={besideDoc ? readMinimum(besideDoc.format) : undefined}
        ratio={typeof prefs.splitRatio === "number" ? prefs.splitRatio : 0.45}
        onRatio={(ratio) => savePrefs({ splitRatio: ratio })}
        resetRatio={0.45}
        chatLabel="대화"
        contentLabel={beside?.kind === "browser" ? "웹 페이지" : "문서"}
        onCovered={(covered) => setCoveredTabs((current) => (Boolean(current[tabId]) === covered ? current : { ...current, [tabId]: covered }))}
      />
    );
  };
  const workspaceLayoutTools = !single ? <WorkspaceLayoutTools inline={compactShell} count={layout.panes.length} disabled={!layoutReady} onPreset={(count: PanePreset) => {
            closeMenu();
            setPaneFocus(false);
            updateLayout(current => applyPanePreset(current, count, () => ({ view: { kind: "new", folderId: null }, workId: null, sessionId: null })));
          }} onLink={() => { closeMenu(); setWorkLinksOpen(true); }} onAdvanced={anchor => {
            const box = anchor.getBoundingClientRect();
            closeMenu();
            setContextMenu({ x: box.left, y: box.bottom, title: "저장된 작업공간 배치", items: [
              { kind: "item", label: "전체 작업 배치", icon: "grid", onSelect: () => { setPaneFocus(false); void openWorkspaceRef.current(null); } },
              ...Object.values(state.workspaces).filter(space => !space.archivedAt && !space.removedAt && !state.works[space.workId]?.archivedAt).map(space => ({ kind: "item" as const, label: `${state.works[space.workId]?.title ?? "프로젝트"} · ${space.label}`, icon: "folder" as const, onSelect: () => { setPaneFocus(false); void openWorkspaceRef.current(space); } })),
            ] });
          }} /> : null;
  const title =
    single && singleSession && work
      ? `${work.title} · ${singleSession.purpose}`
      : view.kind === "browser"
        ? browserState.pages.find(page => page.pageId === view.pageId)?.title || "웹 탭"
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
    <VoiceEnvironment.Provider value={api}>
    <AppearanceContext.Provider value={appearanceApi}>
    <UnseenContext.Provider value={unseen}>
    <ShownPanelsContext.Provider value={shownPanels}>
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
      <header className={`topbar${shownNotice ? " has-notice" : ""}${standingNotice ? " has-standing-notice" : ""}`}>
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
                onClick={() => editorFocus ? setExpandedEditorTab(focusedTabId) : toggleSidebar()}
                aria-label={sidebarOpen ? "사이드바 닫기" : "사이드바 열기"}
                title={sidebarOpen ? "사이드바 닫기" : "사이드바 열기"}
              >
                <Icon name="sidebar" size={18} />
              </button>
              <button type="button" className={`brand${brandAtHome ? " at-home" : ""}`} onClick={() => startNew(null)} title="홈" aria-label="Achmage 홈">
                <Wordmark className="brand-wordmark" />
                <BrandSymbol className="brand-compact" size={26} />
              </button>
            </>
          )}
          {!sidebarOpen && !single && !editorFocus ? (
            <>
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
            // Faded out under a notice: out of the tab order and not operable until it returns.
            inert={Boolean(shownNotice)}
            title={work && view.kind === "work" && !showStart && !single ? "눌러서 작업 이름 바꾸기" : title}
            onClick={() => work && view.kind === "work" && !showStart && !single && setEditingTitle(true)}
          >
            <span className="shell-location-kind">{view.kind === "browser" ? "웹" : view.kind === "document" ? "문서" : view.kind === "project" ? "프로젝트" : view.kind === "work" ? "대화" : view.kind === "pkm" ? "자료" : "작업공간"}</span>
            <span>{title}</span>
          </button>
        )}
        {shownNotice ? <TopNotice slot={shownNotice} serial={notices.serial} onClose={closeNotice} onOpen={entries.byId} /> : null}
        {/* A layout that could not be read or saved stands on its own row under the bar until one of its ways out is taken. */}
        {standingNotice ? <TopNotice className="layout-problem" standing serial={0} onClose={() => undefined} onOpen={() => undefined}
              slot={{ kind: "error", text: standingNotice.message, action: { label: layoutReady ? "저장된 배치 불러오기" : "다시 불러오기", run: () => void resolveLayoutProblem(false) } }}
              more={layoutReady ? { label: "현재 배치로 저장", run: () => void resolveLayoutProblem(true) } : undefined} /> : null}
        <div className="topbar-right">
          {onConnections ? <button type="button" className="ghost-button small shell-connections" onClick={onConnections} aria-label={connectionLabel ?? "기기 연결"} title={connectionLabel ?? "기기 연결"} aria-haspopup="dialog"><Icon name="link" size={18} /><span>{connectionLabel ?? "기기 연결"}</span></button> : null}
          <button type="button" className="ghost-button small shell-create" aria-haspopup="menu" title={`새 문서·세션·폴더 (${shortcuts.newWork})`} onClick={event => openCreate.current(event.currentTarget)}><Icon name="plus" size={15} /> 새로 만들기<Icon name="chevronDown" size={12} /></button>
          <button type="button" className="ghost-button small shell-tasks" aria-label="작업 현황" title="작업 현황" aria-haspopup="dialog" aria-expanded={taskPanelOpen} onClick={() => setTaskPanelOpen(true)}><Icon name="clock" size={18} /></button>
          <button type="button" className="ghost-button small" aria-haspopup="dialog" aria-expanded={attentionOpen} aria-label={attentionState.list.unread ? `알림 · 읽지 않음 ${attentionState.list.unread}개` : "알림"} onClick={() => setAttentionOpen(true)}><Icon name="bell" size={18} />{attentionState.list.unread ? <span className="shell-attention-count">{attentionState.list.unread}</span> : null}</button>
          {view.kind === "document" ? <button type="button" className="ghost-button small" onClick={() => setExpandedEditorTab(editorFocus ? focusedTabId : null)}><Icon name={editorFocus ? "columns" : "expandAll"} size={14} />{editorFocus ? "작업공간 보기" : "편집기에 집중"}</button> : null}
          {!compactShell ? workspaceLayoutTools : null}
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
            className="icon-button shell-theme"
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
              {compactShell ? <div className="compact-toolbar-menu">
                {onConnections ? <button type="button" className="ghost-button" onClick={() => { closeMenu(); onConnections(); }}><Icon name="link" size={18} />{connectionLabel ?? "기기 연결"}</button> : null}
                <button type="button" className="ghost-button" onClick={() => { closeMenu(); setTaskPanelOpen(true); }}><Icon name="clock" size={18} />작업 현황</button>
                {workspaceLayoutTools}
                <button type="button" className="ghost-button" onClick={() => { savePrefs({ theme: focusedTheme === "dark" ? "light" : "dark" }); closeMenu(); }}><Icon name={focusedTheme === "dark" ? "sun" : "moon"} size={18} />{focusedTheme === "dark" ? "라이트 화면으로" : "다크 화면으로"}</button>
              </div> : null}
              <Connections
                backgroundHost={<><BackgroundHost api={api} /><div className="connection"><button type="button" className="button small" onClick={() => { closeMenu(); setPushSettingsOpen(true); }}>모바일 알림</button></div>{!api.isRemote ? <div className="connection"><div className="menu-label">선택 기능</div><div className="feature-actions"><button type="button" className="button small" onClick={() => { closeMenu(); setDesktopOpen(true); }}>외부 앱</button><button type="button" className="button small" onClick={() => { closeMenu(); setExtensionsOpen(true); }}>실행 확장</button><button type="button" className="button small" onClick={() => { closeMenu(); setEventHubOpen(true); }}>이벤트 Hub</button><button type="button" className="button small" onClick={() => { closeMenu(); setPhoneOpen(true); }}>휴대폰 메신저</button></div></div> : null}</>}
                onOfficeSettings={() => { closeMenu(); setOfficeSettingsOpen(true); }}
                onDropbox={() => { closeMenu(); setDropboxOpen(true); }}
                onOfficeImport={() => { closeMenu(); setOfficeImportOpen(true); }}
                onKnowledge={() => { closeMenu(); openKnowledge(); }}
                onIntegrations={() => {
                  closeMenu();
                  setIntegrationsOpen(true);
                }}
                onOnboarding={() => {
                  closeMenu();
                  setOnboardingAgain(true);
                }}
                tools={state.tools}
                onInstallIeum={() => setIeumAppOpen(true)}
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
          <button type="button" className={`icon-button shell-right-sidebar${right.open ? " pressed" : ""}`} {...right.toggleProps} aria-label="오른쪽 사이드바" title={`오른쪽 사이드바 · 개요와 연결 (${shortcuts.rightSidebar})`}>
            <Icon name="sidebarRight" size={18} />
          </button>
        </div>
      </header>


      <div className={`body${sidebarOpen && state.ready ? " with-sidebar" : ""}`}>
      {compactShell && sidebarOpen ? <button className="sidebar-scrim" type="button" aria-label="사이드바 닫고 작업으로 돌아가기" onClick={() => setCompactSidebar(false)} /> : null}
      {sidebarOpen && state.ready ? (
        <Sidebar
          state={state}
          currentWorkId={view.kind === "project" ? view.workId : view.kind === "work" || view.kind === "document" ? work?.id ?? null : null}
          visibleSessionId={view.kind === "project" ? null : visibleSession?.id ?? null}
          currentDocId={view.kind === "document" ? view.artifactId : null}
          open={treeOpen}
          onOpenChange={(next: TreeOpenState) => savePrefs({ tree: next })}
          sortMode={sortMode}
          homeActive={view.kind === "new" && view.folderId === null}
          onSortMode={(mode) => savePrefs({ treeSort: mode })}
          width={sidebarWidth}
          onWidth={(width) => savePrefs({ sidebarWidth: width })}
          paneMinimum={paneMinimum}
          actions={sidebarActions}
          pending={sidebarPending}
          onPendingDone={() => setSidebarPending(null)}
          prefs={prefs}
          onPrefs={savePrefs}
          api={api}
          onToast={setToast}
        />
      ) : null}
      {!state.ready || !layoutReady ? (
        <LoadingView label="불러오는 중…" shape="work" />
      ) : single && !singleSession ? (
        <main className="loading">이 세션을 찾을 수 없습니다. 보관했거나 지운 세션일 수 있습니다.</main>
      ) : (
        <PaneLayout
          layout={layout}
          maximized={editorFocus || paneFocus}
          onMaximize={id => { focusPaneNow(id); setPaneFocus(value => !value); }}
          onPresent={() => void sharedBrowser.present()}
          enabled={!single}
          onResize={(id, ratio) => updateLayout((current) => resizeSplit(current, id, ratio))}
          onFocus={focusPaneNow}
          onClose={closePaneNow}
          onMove={(id, target) => updateLayout((current) => movePane(current, id, target))}
          onSplit={splitPaneNow}
          onDrop={placeItemAt}
          head={paneHead}
          scope={paneScope}
          effectOf={effectOf}
          tabBar={single ? undefined : (pane) => <GroupTabs pane={pane} head={paneHead} onSelect={(tabId) => selectTabNow(pane.id, tabId)} onClose={(tabId) => closeTabNow(pane.id, tabId)} onReorder={(tabId, index) => updateLayout((current) => moveTab(current, tabId, { paneId: pane.id, side: "center" }, index))} onNew={anchor => { const box = anchor.getBoundingClientRect(); setContextMenu(creationMenu(pane.id, null, box.left, box.bottom)); }} />}
          render={(pane, info) => paneView(pane, info.focused, info.split, info.tabId, info.active)}
          onNarrow={setNarrowPanes}
        />
      )}
      {right.shown && state.ready && layoutReady ? (
        <RightSidebar {...right.sidebarProps} note={sideNoteOf(view, single ? visibleSession : sessionIn(focusedPane(layout)) ?? visibleSession, state.artifacts)} state={state} pages={browserState.pages} readText={readArtifactText}
          // From a conversation's 연결: its document, or the web page it opened, comes beside it; a conversation opens as itself.
          onOpenSession={(session) => { if (!(session.pageAgent && !session.archivedAt && sharedBrowser.available && browserState.pages.some((page) => page.pageId === session.pageAgent!.pageId && page.status !== "closed") && actions.openPageBeside(session.pageAgent.pageId))) openSession(session); }}
          onOpenArtifact={(artifactId) => actions.openBeside(artifactId)}
          onOpenPage={sharedBrowser.available && !single ? (page) => void openBrowserRef.current(layoutRef.current.focus, { workspaceId: page.workspaceId, workId: page.workId, profileId: page.profileId, url: page.url }) : undefined} />
      ) : null}
      </div>
      {reading && state.artifacts[reading.artifactId] ? (
        <Suspense fallback={null}>
          <Reader api={api} state={state} artifact={state.artifacts[reading.artifactId]!} start={reading.start} onClose={closeReader} />
        </Suspense>
      ) : null}

      {attentionOpen ? <AttentionCenter inbox={attentionInbox} state={state} onOpen={openAttention} onClose={() => setAttentionOpen(false)} /> : null}
      {newBrowser ? <NewBrowserDialog browser={sharedBrowser} workspaces={Object.values(state.workspaces)} target={newBrowser} onClose={() => setNewBrowser(null)} onOpen={page => {
        const content: PaneContent<View> = { view: { kind: "browser", pageId: page.pageId }, workId: page.workId, sessionId: page.sessionId };
        const targetId = findTab(layoutRef.current, contentKey(content))?.pane.id ?? newBrowser.paneId;
        afterLeaving(targetId, content.view, () => updateLayout(current => ({ ...setPane(current, targetId, content), focus: targetId })), findTab(layoutRef.current, contentKey(content))?.tab.id ?? null);
      }} /> : null}
      {workLinksOpen ? <WorkLinkDialog state={state} initialSource={sessionIn(focusedPane(layout))?.id} visibleIds={layout.panes.map(pane => sessionIn(pane)?.id).filter((id): id is string => !!id)} onSend={actions.handoff} onOpen={openSession} onClose={() => setWorkLinksOpen(false)} /> : null}
      {taskPanelOpen ? <TaskPanel api={api} workId={view.kind === "project" ? view.workId : work?.id} onClose={() => setTaskPanelOpen(false)} onOpen={(sessionId, itemId) => {
        const target = stateRef.current.sessions[sessionId];
        if (!target) { setToast(failure("원문 대화를 찾을 수 없습니다.")); return; }
        setTaskPanelOpen(false);
        openSession(target);
        if (itemId) setFocusItem({ sessionId, itemId, nonce: Date.now() });
      }} /> : null}
      {terminalWorkspace ? <TerminalDialog api={api} workspace={state.workspaces[terminalWorkspace.id] ?? terminalWorkspace} onClose={() => setTerminalWorkspace(null)} onOpen={(entry) => navigateTo({ view: { kind: "terminal", terminalId: entry.id, workspaceId: entry.workspaceId, label: entry.label }, workId: entry.workId, sessionId: null })} /> : null}
      {serviceWorkspace ? <WorkspaceServices key={serviceWorkspace.id} api={api} workspace={state.workspaces[serviceWorkspace.id] ?? serviceWorkspace} onClose={() => setServiceWorkspace(null)} openExternal={openExternal} onOpenPreview={inDesktop && !single ? async (url, workspace) => {
        const page = await sharedBrowser.create({ requestId: newRequestId(), driverId: sharedBrowser.driverId, workspaceId: workspace.id, profileId: browserState.profiles[0]?.id ?? "default", url });
        navigateTo({ view: { kind: "browser", pageId: page.pageId }, workId: page.workId, sessionId: page.sessionId });
      } : undefined} onOpen={(entry) => navigateTo({ view: { kind: "terminal", terminalId: entry.id, workspaceId: entry.workspaceId, label: entry.label }, workId: entry.workId, sessionId: null })} /> : null}
      {preparationWorkspace ? <WorkspacePreparationDialog api={api} workspace={state.workspaces[preparationWorkspace.id] ?? preparationWorkspace} onClose={() => setPreparationWorkspace(null)} onOpen={(entry) => navigateTo({ view: { kind: "terminal", terminalId: entry.id, workspaceId: entry.workspaceId, label: entry.label }, workId: entry.workId, sessionId: null })} /> : null}
      {scmWorkspace ? <SourceControlDialog key={scmWorkspace.id} api={api} workspace={state.workspaces[scmWorkspace.id] ?? scmWorkspace} onClose={() => setScmWorkspace(null)} onTerminal={() => { setTerminalWorkspace(scmWorkspace); setScmWorkspace(null); }} /> : null}
      {integrationsOpen && api ? <IntegrationsSheet api={api} onClose={() => setIntegrationsOpen(false)} onToast={setToast} /> : null}
      {imageUploadOpen && api ? <ImageUploadSheet api={api} onClose={() => setImageUploadOpen(false)} onToast={setToast} /> : null}
      {pushSettingsOpen && api ? <MobilePushSettings api={api} hostId={state.hostId} remote={api.isRemote} onClose={() => setPushSettingsOpen(false)} /> : null}
      {officeSettingsOpen && api ? <OfficeSettings api={api} theme={appTheme} onClose={() => setOfficeSettingsOpen(false)} /> : null}
      {desktopOpen && !api.isRemote ? <DesktopTargetPicker api={api} sessions={Object.values(state.sessions).filter(session => !session.archivedAt).map(session => ({ id: session.id, label: `${state.works[session.workId]?.title ?? "프로젝트"} · ${session.purpose}` }))} onClose={() => setDesktopOpen(false)} /> : null}
      {extensionsOpen && !api.isRemote ? <ExtensionLibrary api={api} workspaces={Object.values(state.workspaces).filter(space => !space.archivedAt && !space.removedAt).map(space => ({ id: space.id, label: `${state.works[space.workId]?.title ?? "프로젝트"} · ${space.label}` }))} onClose={() => setExtensionsOpen(false)} /> : null}
      {eventHubOpen && !api.isRemote ? <EventHub api={api} onClose={() => setEventHubOpen(false)} /> : null}
      {phoneOpen && !api.isRemote ? <PhoneMessenger api={api} openExternal={openExternal} copy={copyText} readClipboard={() => navigator.clipboard.readText()} onClose={() => setPhoneOpen(false)} /> : null}
      {dropboxOpen && api ? <DropboxDialog api={api} pickFolder={inDesktop ? (start) => pickFolderNative("Dropbox 폴더 선택", start) : null} openExternal={openExternal} onClose={() => setDropboxOpen(false)} onOpened={({ work, artifact }) => { setDropboxOpen(false); navigateTo({ workId: work.id, sessionId: null, view: artifact ? { kind: "document", artifactId: artifact.id, proposalId: null } : { kind: "project", workId: work.id } }); }} /> : null}
      {officeImportOpen && api ? <OfficeImportDialog api={api} onClose={() => setOfficeImportOpen(false)} /> : null}
      {api && <OfficeDrive api={api} theme={appTheme} />}
      {ieumAppOpen ? <IeumAppDialog api={api} status={state.tools?.ieumApp} onClose={() => setIeumAppOpen(false)} /> : null}
      {knowledgeMounted && api ? <div hidden={!knowledgeOpen}><KnowledgeLibrary api={api} state={state} workId={view.kind === "project" ? view.workId : work?.id} theme={appTheme} visible={knowledgeOpen} onOpen={artifact => { navigateTo({ workId: artifact.workId, sessionId: null, view: { kind: "document", artifactId: artifact.id, proposalId: null } }); setKnowledgeOpen(false); }} onClose={() => { setKnowledgeOpen(false); setKnowledgeMounted(false); }} /></div> : null}
      {state.ready && api && (prefs.onboarding !== "done" || onboardingAgain) ? (
        <Onboarding
          api={api}
          hostLabel={state.hostLabel}
          artifacts={Object.values(state.artifacts)}
          suspended={ieumAppOpen || dropboxOpen || connectionsOpen || importOpen}
          onOpenDropbox={api.isRemote ? undefined : () => setDropboxOpen(true)}
          onOpenVault={api.isRemote ? undefined : () => pkmHandle.current?.setDialog({ kind: "vault" })}
          onOpenDevices={onConnections}
          onOpenDocument={artifactId => {
            const artifact = stateRef.current.artifacts[artifactId];
            if (artifact) navigateTo({ view: { kind: "document", artifactId, proposalId: null }, workId: artifact.workId, sessionId: null });
          }}
          onCreateDocument={() => setNewDocument({ ...creationTarget(layoutRef.current.focus), paneId: layoutRef.current.focus })}
          onImportHistory={api.isRemote ? undefined : () => setImportOpen(true)}
          providers={state.providers}
          tools={state.tools}
          engineActions={engineActions}
          onRefresh={() => {
            void api.refreshProviders().catch(() => undefined);
            void api.refreshTools().catch(() => undefined);
          }}
          onInstallIeum={() => setIeumAppOpen(true)}
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
      {/* Opened from a row's menu or a ⋯: closing returns the focus there, not to the page. */}
      {moveAsk ? <MoveQuestion name={moveAsk.name} certain={moveAsk.certain} same={moveAsk.same} onSave={moveAsk.go} onDrop={moveAsk.drop} onClose={() => setMoveAsk(null)} /> : null}
      {unsavedAsk ? <FromMenu><ConfirmDialog title="저장하지 않은 내용이 있습니다" tone="primary" lines={[unsavedAsk.certain ? `「${unsavedAsk.name}」에 저장하지 않은 편집이 있습니다. 저장한 뒤 계속합니다.` : `「${unsavedAsk.name}」 편집기에 저장하지 않은 편집이 있을 수 있습니다. 저장을 확인한 뒤 계속합니다.`]} confirmLabel="저장하고 계속" busyLabel="저장하는 중…"
        onConfirm={async () => unsavedAsk.answer(true)} onClose={() => { unsavedAsk.answer(false); setUnsavedAsk(null); }} /></FromMenu> : null}
      {refusedTrash ? <FromMenu><ConfirmDialog title="휴지통으로 옮길 수 없습니다" tone="primary" lines={[refusedTrash.reason, "목록에서만 빼면 파일은 그대로 둡니다."]} confirmLabel="목록에서 빼기" busyLabel="빼는 중…"
        onConfirm={() => removeDoc(refusedTrash.artifact, "unlisted")} onClose={() => setRefusedTrash(null)} /></FromMenu> : null}
      {renamingSession ? <FromMenu><RenameDialog title="문서 AI 이름 바꾸기" value={renamingSession.purpose} onSave={(purpose) => api ? api.updateSession(renamingSession.id, { purpose }).then(() => undefined) : Promise.resolve()} onClose={() => setRenamingSession(null)} /></FromMenu> : null}
      {deletingWork ? <ProjectDeleteDialog work={deletingWork} sessions={Object.values(state.sessions).filter(session => session.workId === deletingWork.id).length}
        trashedDocuments={Object.values(state.removedArtifacts).filter(artifact => artifact.workId === deletingWork.id && artifact.removed?.kind === "trash").length} onDelete={() => deleteProject(deletingWork)} onClose={() => setDeletingWork(null)} /> : null}
      {newDocument && api ? <NewDocumentDialog api={api} state={state} request={newDocument} onClose={() => setNewDocument(null)} onOpen={artifact => setViewOf(newDocument.paneId, { kind: "document", artifactId: artifact.id, proposalId: null }, artifact)} /> : null}
      {newDirectory && api && state.workspaces[newDirectory] ? <NewDirectoryDialog api={api} workspace={state.workspaces[newDirectory]!} onClose={() => setNewDirectory(null)} onCreated={created => setToast({ text: `폴더를 만들었습니다: ${created.path}`, action: { label: inDesktop ? "폴더 열기" : "경로 복사", run: () => void openPath(created.path) } })} /> : null}
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
          onOpenRight={single ? undefined : (item) => placeItem(item, "right")}
          onOpenDoc={(artifact) => docActions.openArtifact(artifact.id)}
          onOpenNote={single ? undefined : (path, location) => setView({ kind: "pkm", target: { kind: "note", path, location } })}
          onOpenView={single ? undefined : (id) => setView({ kind: "pkm", target: { kind: "view", id } })}
          onClose={() => setPaletteOpen(null)}
        />
      ) : null}
      {switcher !== null ? <Switcher state={state} sessions={switchable} index={switcher} unseen={unseen} /> : null}
      <LinkLayer api={api} inDesktop={inDesktop} />
      {propertyTemplateOpen ? <TemplateDialog api={api} onClose={() => setPropertyTemplateOpen(false)} onSaved={() => setToast("속성 템플릿을 저장했습니다. 모든 프로젝트의 속성 칸이 따릅니다.")} onError={fail} /> : null}
      {folderTemplateId && state.folders[folderTemplateId] ? <FolderTemplateDialog api={api} folder={state.folders[folderTemplateId]!} onClose={() => setFolderTemplateId(null)} onSaved={() => setToast("폴더 노트 템플릿을 저장했습니다. 새 노트를 만들 때 적용합니다.")} onError={fail} /> : null}
      {importOpen ? <ImportDialog api={api} onClose={() => setImportOpen(false)} onOpen={openImported} onError={fail} /> : null}
      {reviewing && state.sessions[reviewing]?.worktree ? (
        <WorktreeReview api={api} session={state.sessions[reviewing]} managed={state.workspaces[state.sessions[reviewing].workspaceId ?? ""]?.managed ?? true} onClose={() => setReviewing(null)} onToast={setToast} onError={fail} />
      ) : null}
      {scheduling && state.sessions[scheduling] ? (
        <ScheduleDialog api={api} session={state.sessions[scheduling]} schedules={state.schedules} onClose={() => setScheduling(null)} onError={fail} onOpenSession={id => { const target = state.sessions[id]; if (target) { setScheduling(null); openSession(target); } }} />
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

      <VaultDialogHost pickFolder={inDesktop ? pickFolderNative : null} />
    </div>
    </PkmProvider>
    </PaneActionsContext.Provider>
    </LinkContext.Provider>
    </DocContext.Provider>
    </ShownPanelsContext.Provider>
    </UnseenContext.Provider>
    </AppearanceContext.Provider>
    </VoiceEnvironment.Provider>
  );
}
