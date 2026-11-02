import { useEffect, useRef, useState } from "react";
import type { VaultFolder } from "@workbench/contracts";
import type { PkmTarget } from "../../pkm.ts";
import { Icon } from "../Icon.tsx";
import { CardListView } from "./CardListView.tsx";
import { VaultNoteView } from "./VaultNoteView.tsx";
import { PkmNavigationScope, usePkm } from "./PkmContext.tsx";

type Target = Extract<PkmTarget, { kind: "vault" | "note" }>;
const key = (target: Target) => JSON.stringify(target);
const parentPath = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
function folderAt(root: VaultFolder | null | undefined, path: string): VaultFolder | undefined {
  if (!root) return;
  if (root.path === path) return root;
  for (const child of root.children) { const found = folderAt(child, path); if (found) return found; }
}

/** One read-only vault browser per tab. No app/browser history or neighbouring session is changed. */
export function VaultBrowser({ target, onNavigate, active }: { target: Target; onNavigate: (target: PkmTarget) => void; active: boolean }) {
  const pkm = usePkm();
  const [history, setHistory] = useState({ entries: [target], index: 0 });
  const historyRef = useRef(history); historyRef.current = history;
  const move = (next: typeof history) => { historyRef.current = next; setHistory(next); };
  useEffect(() => {
    const current = historyRef.current;
    if (key(current.entries[current.index]!) !== key(target)) move({ entries: [...current.entries.slice(0, current.index + 1), target].slice(-100), index: Math.min(current.index + 1, 99) });
  }, [target]);
  const navigate = (next: PkmTarget) => {
    if (next.kind === "vault" || next.kind === "note") {
      const current = historyRef.current;
      if (key(current.entries[current.index]!) !== key(next)) move({ entries: [...current.entries.slice(0, current.index + 1), next].slice(-100), index: Math.min(current.index + 1, 99) });
    }
    onNavigate(next);
  };
  const back = history.index > 0, forward = history.index < history.entries.length - 1;
  const go = (delta: number) => {
    const current = historyRef.current, index = current.index + delta;
    if (index < 0 || index >= current.entries.length) return;
    move({ ...current, index }); onNavigate(current.entries[index]!);
  };
  const up = () => navigate({ kind: "vault", path: parentPath(target.path) });
  const controls = useRef({ go, up }); controls.current = { go, up };
  useEffect(() => {
    if (!active) return;
    const handle = (event: KeyboardEvent) => {
      if (document.querySelector("dialog[open],.palette,[role=menu]")) return;
      const browserKey = event.key === "BrowserBack" || event.key === "BrowserForward";
      if (!browserKey && (!event.altKey || event.ctrlKey || event.metaKey || !["ArrowLeft", "ArrowRight", "ArrowUp"].includes(event.key))) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === "ArrowUp") controls.current.up(); else controls.current.go(event.key === "ArrowLeft" || event.key === "BrowserBack" ? -1 : 1);
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [active]);
  const parts = target.path.split("/").filter(Boolean);
  const folders = target.kind === "vault" ? folderAt(pkm.tree?.root, target.path)?.children ?? [] : [];
  return <PkmNavigationScope target={target} onOpen={navigate}>
    <section className="vault-browser" aria-label="볼트 탐색" onMouseDown={event => { if (event.button === 3 || event.button === 4) event.preventDefault(); }} onMouseUp={event => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault(); event.stopPropagation(); go(event.button === 3 ? -1 : 1);
    }} onAuxClick={event => { if (event.button === 3 || event.button === 4) event.preventDefault(); }} onContextMenu={event => {
      if (event.defaultPrevented || (event.target as Element).closest("input,textarea,a,[contenteditable=true]") || window.getSelection()?.toString()) return;
      event.preventDefault(); event.stopPropagation();
      pkm.openMenu({ x: event.clientX, y: event.clientY, title: "볼트 탐색", items: [
        { kind: "item", label: "뒤로", icon: "arrowLeft", hint: "Alt+←", disabled: !back, onSelect: () => go(-1) },
        { kind: "item", label: "앞으로", icon: "arrowRight", hint: "Alt+→", disabled: !forward, onSelect: () => go(1) },
        { kind: "item", label: "상위 폴더로 이동", icon: "folder", hint: "Alt+↑", disabled: !target.path, onSelect: up },
        { kind: "item", label: "볼트 처음으로", icon: "book", onSelect: () => navigate({ kind: "vault", path: "" }) },
      ] });
    }}>
      <nav className="vault-navigation" aria-label="볼트 이동">
        <button type="button" className="icon-button small" aria-label="볼트 뒤로" title="뒤로 (Alt+←)" disabled={!back} onClick={() => go(-1)}><Icon name="arrowLeft" size={16} /></button>
        <button type="button" className="icon-button small" aria-label="볼트 앞으로" title="앞으로 (Alt+→)" disabled={!forward} onClick={() => go(1)}><Icon name="arrowRight" size={16} /></button>
        <button type="button" className="ghost-button small" aria-label="상위 폴더로 이동" title="상위 폴더로 이동 (Alt+↑)" disabled={!target.path} onClick={up}><Icon name="folder" size={15} /> 상위</button>
        <div className="vault-breadcrumbs">
          <button type="button" className="link" onClick={() => navigate({ kind: "vault", path: "" })}>{pkm.tree?.status.name ?? "볼트"}</button>
          {parts.map((part, index) => <span key={index}><span aria-hidden="true"> › </span>{target.kind === "note" && index === parts.length - 1 ? <span aria-current="page">{part.replace(/\.md$/i, "")}</span> : <button type="button" className="link" aria-current={index === parts.length - 1 ? "page" : undefined} onClick={() => navigate({ kind: "vault", path: parts.slice(0, index + 1).join("/") })}>{part}</button>}</span>)}
        </div>
      </nav>
      {folders.length ? <nav className="vault-subfolders" aria-label="하위 폴더">{folders.map(folder => <button key={folder.path} type="button" className="ghost-button small" onClick={() => navigate({ kind: "vault", path: folder.path })}><Icon name="folder" size={14} /> {folder.name}</button>)}</nav> : null}
      {target.kind === "note" ? <VaultNoteView key={target.path} path={target.path} location={target.location} /> : <CardListView key={target.path} target={target} />}
    </section>
  </PkmNavigationScope>;
}
