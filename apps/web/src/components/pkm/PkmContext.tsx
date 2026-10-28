import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { VaultTree } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { pkmClient, type PkmClient, type PkmTarget } from "../../pkm.ts";
import type { State } from "../../state.ts";

// What the PKM pieces (sidebar vault section, card lists, dialogs) share: the vault tree, which of
// its folders are unfolded, and the dialogs they open. The tree is fetched again whenever the
// gateway says the vault changed (`pkm.changed`), and after a reconnect.

const OPEN_KEY = "workbench.vaultOpen";

export type PkmApi = {
  client: PkmClient;
  tree: VaultTree | null;
  /** Vault folders unfolded in the sidebar. */
  unfolded: ReadonlySet<string>;
  toggle: (path: string) => void;
  dialog: "vault" | null;
  setDialog: (dialog: "vault" | null) => void;
  attach: (path: string) => Promise<boolean>;
  detach: () => void;
  rescan: () => void;
  onToast: (message: string) => void;
  /** What the centre shows now (a vault folder's cards, a note…), or null. */
  target: PkmTarget | null;
  /** Show cards or a note in the centre; null where the app cannot (the folder then only folds). */
  open: ((target: PkmTarget) => void) | null;
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
  children,
}: {
  api: Api;
  state: State;
  onToast: (message: string) => void;
  target?: PkmTarget | null;
  onOpen?: ((target: PkmTarget) => void) | null;
  children: ReactNode;
}) {
  const client = useMemo(() => pkmClient(api), [api]);
  const [tree, setTree] = useState<VaultTree | null>(null);
  const [dialog, setDialog] = useState<"vault" | null>(null);
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
    client,
    tree,
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
  };
  return <PkmContext.Provider value={value}>{children}</PkmContext.Provider>;
}
