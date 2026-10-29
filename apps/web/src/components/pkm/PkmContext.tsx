import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import type { Artifact, PkmState, Session, VaultTree, Work } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { pkmClient, type PkmClient, type PkmTarget } from "../../pkm.ts";
import type { MenuRequest } from "../ContextMenu.tsx";
import type { State } from "../../state.ts";

// What the PKM pieces (sidebar vault section, card lists, dialogs) share: the vault tree, which of
// its folders are unfolded, and the dialogs they open. The tree is fetched again whenever the
// gateway says the vault changed (`pkm.changed`), and after a reconnect.

const OPEN_KEY = "workbench.vaultOpen";

/** Dialogs of the PKM layer: attaching the vault, a page from a template. */
export type PkmDialog = { kind: "vault" } | { kind: "template"; workId: string; parentId: string | null } | { kind: "view"; id: string | null } | { kind: "rules" } | { kind: "insight"; sessionId: string };

/** A notice, with an action ("되돌리기") when there is one. */
export type PkmToast = { text: string; action?: { label: string; run: () => void } };

export type PkmApi = {
  api: Api;
  state: State;
  client: PkmClient;
  tree: VaultTree | null;
  /** Saved views (with counts), rules and where rules put works. */
  pkmState: PkmState | null;
  /** Vault folders unfolded in the sidebar. */
  unfolded: ReadonlySet<string>;
  toggle: (path: string) => void;
  dialog: PkmDialog | null;
  setDialog: (dialog: PkmDialog | null) => void;
  attach: (path: string) => Promise<boolean>;
  detach: () => void;
  rescan: () => void;
  onToast: (message: string | PkmToast) => void;
  /** What the centre shows now (a vault folder's cards, a note…), or null. */
  target: PkmTarget | null;
  /** Show cards or a note in the centre; null where the app cannot (the folder then only folds). */
  open: ((target: PkmTarget) => void) | null;
  /** Show a session's conversation (after a request was sent from a card list). */
  showSession: (work: Work, session: Session) => void;
  /** Show a work's conversation. */
  showWork: (work: Work) => void;
  /** The app menu (right-click on a card). */
  openMenu: (request: MenuRequest) => void;
  /** Open a page just made, unfolding its work's documents in the tree. */
  openArtifact: (artifact: Artifact) => void;
};

const PkmContext = createContext<PkmApi | null>(null);

export function usePkm() {
  const value = useContext(PkmContext);
  if (!value) throw new Error("usePkm outside PkmProvider");
  return value;
}

/** For pieces that may render before the provider exists (tests, the fatal screen). */
export const useOptionalPkm = () => useContext(PkmContext);

export function PkmProvider({
  api,
  state,
  onToast,
  target = null,
  onOpen = null,
  onShowSession = () => undefined,
  onShowWork = () => undefined,
  onMenu = () => undefined,
  handle,
  onOpenArtifact = () => undefined,
  children,
}: {
  onOpenArtifact?: (artifact: Artifact) => void;
  /** Filled with the current context, for the app's menus (which live outside the provider). */
  handle?: MutableRefObject<PkmApi | null>;
  onShowWork?: (work: Work) => void;
  onMenu?: (request: MenuRequest) => void;
  api: Api;
  state: State;
  onToast: (message: string | PkmToast) => void;
  target?: PkmTarget | null;
  onOpen?: ((target: PkmTarget) => void) | null;
  onShowSession?: (work: Work, session: Session) => void;
  children: ReactNode;
}) {
  const client = useMemo(() => pkmClient(api), [api]);
  const [tree, setTree] = useState<VaultTree | null>(null);
  const [pkmState, setPkmState] = useState<PkmState | null>(null);
  const [dialog, setDialog] = useState<PkmDialog | null>(null);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toastRef = useRef(onToast);
  toastRef.current = onToast;
  const fail = useCallback((error: unknown) => toastRef.current(error instanceof Error ? error.message : String(error)), []);

  const vaultVersion = state.pkm.vault ?? 0;
  const live = state.ready && state.connected;
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    client
      .tree()
      .then((next) => !cancelled && setTree(next))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, vaultVersion, live]);

  // Views, rules and placements: again when they change, and a moment after sessions change
  // (a view of running sessions counts them).
  const viewsVersion = `${state.pkm.views ?? 0}:${state.pkm.rules ?? 0}:${state.pkm.pins ?? 0}:${vaultVersion}`;
  const sessions = state.sessions;
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const timer = window.setTimeout(
      () =>
        void client
          .state()
          .then((next) => !cancelled && setPkmState(next))
          .catch(() => undefined),
      pkmState ? 400 : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, viewsVersion, sessions, live]);

  const toggle = useCallback((path: string) => {
    setUnfolded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  const value: PkmApi = {
    api,
    state,
    client,
    tree,
    pkmState,
    unfolded,
    toggle,
    dialog,
    setDialog,
    attach: async (path) => {
      try {
        await client.attach(path);
        setTree(await client.tree());
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },
    detach: () =>
      void client
        .detach()
        .then(() => client.tree().then(setTree))
        .catch(fail),
    rescan: () => void client.rescan().catch(fail),
    onToast,
    target,
    open: onOpen,
    showSession: onShowSession,
    showWork: onShowWork,
    openMenu: onMenu,
    openArtifact: onOpenArtifact,
  };
  if (handle) handle.current = value;
  return <PkmContext.Provider value={value}>{children}</PkmContext.Provider>;
}
