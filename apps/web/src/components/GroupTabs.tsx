import type { Pane } from "../panes.ts";
import { activeTab, tabsOf } from "../tabs.ts";
import { paneDrag } from "../panedrag.ts";
import type { PaneHead } from "./Panes.tsx";
import { Icon } from "./Icon.tsx";

export function GroupTabs<V>({ pane, head, onSelect, onClose, onReorder, onNew }: {
  pane: Pane<V>; head: (pane: Pane<V>) => PaneHead;
  onSelect: (id: string) => void; onClose: (id: string) => void;
  onReorder: (id: string, index: number) => void; onNew: () => void;
}) {
  const tabs = tabsOf(pane), activeId = activeTab(pane).id;
  return <nav className="group-tabs" data-pane-id={pane.id} aria-label="작업공간 탭">
    <div role="tablist" aria-label="열린 탭">
      {tabs.map((tab, index) => {
        const title = head({ ...pane, view: tab.view, workId: tab.workId, sessionId: tab.sessionId });
        return <div className={`group-tab${tab.id === activeId ? " active" : ""}`} data-tab-index={index} data-tab-id={tab.id} key={tab.id}>
          <button type="button" role="tab" aria-selected={tab.id === activeId} tabIndex={tab.id === activeId ? 0 : -1} title={`${title.hint ?? title.title} · 끌어서 이동 · Ctrl+Shift+←→로 순서 변경`}
            onPointerDown={(event) => paneDrag.press({ item: { kind: "tab", id: tab.id }, label: title.title }, event)}
            onMouseDown={(event) => paneDrag.press({ item: { kind: "tab", id: tab.id }, label: title.title }, event)}
            onClick={() => { if (!paneDrag.justDragged()) onSelect(tab.id); }}
            onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onClose(tab.id); } }}
            onKeyDown={(event) => {
              const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
              if (step && (event.ctrlKey || event.metaKey) && event.shiftKey) { event.preventDefault(); onReorder(tab.id, Math.max(0, Math.min(tabs.length - 1, index + step))); return; }
              const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : step ? (index + step + tabs.length) % tabs.length : -1;
              if (next >= 0) { event.preventDefault(); onSelect(tabs[next]!.id); }
              if (event.key === "Delete") { event.preventDefault(); onClose(tab.id); }
            }}><span aria-hidden>{title.icon}</span><span className="group-tab-title">{title.title}</span></button>
          <button type="button" className="group-tab-close" aria-label={`${title.title} 탭 닫기`} title="탭 닫기 · 파일과 세션 기록은 유지" onClick={() => onClose(tab.id)}><Icon name="x" size={12} /></button>
        </div>;
      })}
    </div>
    <button type="button" className="icon-button small group-tab-new" aria-label="새 탭" title="새 탭" onClick={onNew}><Icon name="plus" size={14} /></button>
  </nav>;
}
