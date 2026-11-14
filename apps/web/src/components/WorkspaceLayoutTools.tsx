import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Session, Work } from "@workbench/contracts";
import type { State } from "../state.ts";
import type { PanePreset } from "../layout-presets.ts";
import { statusText } from "../format.ts";
import { Icon } from "./Icon.tsx";
import { IconButton } from "./ui/Hig.tsx";
import { MenuItem, Popover } from "./Popover.tsx";
import { restoreSurfaceFocus } from "./controls/menu-navigation.ts";
import { EngineMark } from "./EngineMark.tsx";
import { Select, type SelectOption } from "./ui/Select.tsx";
import { layerOwns } from "./ui/layers.ts";

export function WorkspaceLayoutTools({ count, disabled, inline = false, onPreset, onLink, onAdvanced }: {
  count: number; disabled: boolean; inline?: boolean; onPreset: (count: PanePreset) => void; onLink: () => void; onAdvanced: (anchor: HTMLElement) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = <><Icon name="grid" size={16} /><span>{count === 1 ? "화면 배치" : `${count}칸`}</span><Icon name="chevronDown" size={12} /></>;
  const options = <div className="layout-options">
      <div className="menu-label">동시에 볼 작업</div>
      {([1, 2, 4, 9] as const).map(n => <MenuItem key={n} active={count === n} disabled={disabled} onSelect={() => { setOpen(false); onPreset(n); }}><span className={`layout-mini layout-mini-${n}`} aria-hidden>{Array.from({ length: n }, (_, i) => <i key={i} />)}</span>{n}칸{n === 1 ? " · 탭으로 모으기" : n === 2 ? " · 나란히" : ` · ${Math.sqrt(n)} × ${Math.sqrt(n)}`}</MenuItem>)}
      <div className="menu-separator" />
      <MenuItem onSelect={() => { setOpen(false); onLink(); }}><Icon name="link" size={16} />작업 연결…</MenuItem>
      <MenuItem onSelect={() => { setOpen(false); const anchor = document.querySelector<HTMLElement>(".workspace-layout-tools > button, .workspace-layout-inline > summary"); if (anchor) onAdvanced(anchor); }}>저장된 작업공간 배치…</MenuItem>
  </div>;
  // The settings surface already owns the one active popover. A nested popover
  // would close its parent immediately; use an inline disclosure in that surface.
  if (inline) return <details className="workspace-layout-inline"><summary aria-label="화면 배치">{trigger}</summary>{options}</details>;
  return <div className="anchor workspace-layout-tools">
    <button type="button" className="ghost-button small" aria-label="화면 배치" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}>{trigger}</button>
    <Popover open={open} onClose={() => setOpen(false)} align="right" label="화면 배치">{options}</Popover>
  </div>;
}

export function PaneStart({ split, works, onProject, children }: { split: boolean; works: Work[]; onProject: (id: string) => void; children: ReactNode }) {
  const [newTask, setNewTask] = useState(false);
  if (!split || newTask) return children;
  return <div className="pane-start"><h2>이 칸에서 볼 프로젝트</h2><p>프로젝트를 선택하거나 새 작업을 시작하세요.</p><div className="pane-start-projects">{works.map(work => <button type="button" key={work.id} onClick={() => onProject(work.id)}><Icon name="project" size={18} /><span>{work.title}</span><Icon name="chevronRight" size={14} /></button>)}</div><button type="button" className="button" onClick={() => setNewTask(true)}><Icon name="plus" size={16} />새 작업 시작</button></div>;
}

/** Uses the existing host handoff/reply protocol; sending here never occupies the source chat. */
export function WorkLinkDialog({ state, initialSource, visibleIds, onSend, onOpen, onClose }: {
  state: State; initialSource?: string | null; visibleIds: string[];
  onSend: (source: Session, target: Session, text: string) => Promise<boolean>;
  onOpen: (session: Session) => void; onClose: () => void;
}) {
  const choices = Object.values(state.sessions).filter(s => !s.archivedAt && state.works[s.workId] && !state.works[s.workId]?.archivedAt).sort((a, b) => Number(visibleIds.includes(b.id)) - Number(visibleIds.includes(a.id)));
  const [sourceId, setSource] = useState(initialSource ?? choices[0]?.id ?? "");
  const [targetId, setTarget] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDialogElement>(null), opener = useRef(document.activeElement);
  useLayoutEffect(() => { const surface = dialog.current; surface?.showModal(); return () => restoreSurfaceFocus(opener.current, surface); }, []);
  const source = choices.find(s => s.id === sourceId), target = choices.find(s => s.id === targetId && s.id !== sourceId);
  // Grouped by project, with the session's state, so the right one is found by name or project.
  const options = (sessions: Session[]): SelectOption<string>[] => sessions.map(s => ({
    value: s.id, label: s.purpose, group: state.works[s.workId]?.title, icon: <EngineMark provider={s.provider} size={16} />,
    hint: visibleIds.includes(s.id) ? `화면에 표시됨 · ${statusText(s)}` : statusText(s),
  }));
  const links = Object.values(state.handoffs).filter(h => h.sourceSessionId === sourceId || h.targetSessionId === sourceId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 12);
  return <dialog ref={dialog} className="work-link-dialog" aria-labelledby="work-link-title" onCancel={event => { if (layerOwns(event.nativeEvent)) event.preventDefault(); else onClose(); }}>
    <header><div><h2 id="work-link-title">작업 연결</h2><p>다른 세션에 일을 요청하고, 보낸 세션에서 답을 받습니다.</p></div><IconButton icon="x" label="작업 연결 닫기" onClick={onClose} /></header>
    <form onSubmit={async event => {
      event.preventDefault(); if (!source || !target || !text.trim() || busy) return;
      setBusy(true); setNotice("");
      try { if (await onSend(source, target, text)) { setText(""); setNotice("요청을 보냈습니다. 회신은 보낸 세션에 연결됩니다."); } else setNotice("보내지 못했습니다. 요청 내용은 유지됩니다."); }
      catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
      finally { setBusy(false); }
    }}>
      <div className="work-link-pair"><div className="work-link-field"><span>보내는 세션</span><Select label="보내는 세션" searchable searchPlaceholder="프로젝트나 세션 찾기" value={sourceId || null} disabled={busy} options={options(choices)} onChange={id => { setSource(id); setNotice(""); }} /></div><Icon name="arrowRight" size={18} /><div className="work-link-field"><span>받는 세션</span><Select label="받는 세션" searchable searchPlaceholder="프로젝트나 세션 찾기" placeholder="세션 선택" value={targetId || null} disabled={busy} options={options(choices.filter(s => s.id !== sourceId))} onChange={setTarget} /></div></div>
      {target ? <p className="work-link-status">{statusText(target)} · 작업 중이면 요청이 대기열에 들어갑니다.</p> : null}
      <label>전달할 요청과 맥락<textarea value={text} onChange={e => setText(e.target.value)} rows={4} placeholder="검토할 내용이나 맡길 작업을 입력하세요" disabled={busy} /></label>
      <footer><span role="status">{notice}</span><button type="submit" className="button primary" disabled={!source || !target || !text.trim() || busy}>{busy ? "보내는 중…" : "요청 보내기"}</button></footer>
    </form>
    {choices.length < 2 ? <p>프로젝트에서 세션을 두 개 이상 만들면 서로 연결할 수 있습니다.</p> : null}
    {links.length ? <section className="work-link-history" aria-label="연결된 요청"><h3>연결된 요청</h3>{links.map(h => <article key={h.id}><strong>{state.sessions[h.sourceSessionId]?.purpose ?? "이전 세션"}<Icon name="arrowRight" size={14} />{state.sessions[h.targetSessionId]?.purpose ?? "이전 세션"}</strong><span>{h.status === "answered" ? "답 받음" : h.status === "failed" ? "전달 실패" : "답 기다리는 중"}</span><p>{h.reply ?? h.error ?? h.text}</p>{state.sessions[h.sourceSessionId] ? <button type="button" className="text-button" onClick={() => { onOpen(state.sessions[h.sourceSessionId]!); onClose(); }}>보낸 대화 열기</button> : null}</article>)}</section> : null}
  </dialog>;
}
