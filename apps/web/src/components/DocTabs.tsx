import type { State } from "../state.ts";
import { paneDrag, usePaneActions } from "../panedrag.ts";
import { FormatBadge } from "./DocCards.tsx";
import { Icon } from "./Icon.tsx";

/**
 * Documents opened in this work, as tabs next to the conversation: switch between them in one
 * click, and `@`-mention them first. A tab dragged onto the main area's left or right half (or
 * Ctrl+clicked, middle-clicked) opens beside.
 */
export function DocTabs({
  state,
  ids,
  activeId,
  onConversation,
  onOpen,
  onClose,
}: {
  state: State;
  ids: string[];
  /** The open document, or null while the conversation is shown. */
  activeId: string | null;
  onConversation: () => void;
  onOpen: (artifactId: string) => void;
  onClose: (artifactId: string) => void;
}) {
  const panes = usePaneActions();
  const documents = ids.map((id) => state.artifacts[id]).filter((artifact) => Boolean(artifact));
  if (!documents.length) return null;
  return (
    <nav className="doc-tabs" aria-label="열린 문서">
      <button type="button" className={`doc-tab conversation${activeId === null ? " active" : ""}`} onClick={onConversation} aria-current={activeId === null}>
        <Icon name="send" size={13} /> 대화
      </button>
      {documents.map((artifact) => (
        <span key={artifact.id} className={`doc-tab${artifact.id === activeId ? " active" : ""}`}>
          <button
            type="button"
            className="doc-tab-open"
            onPointerDown={(event) => {
              if (event.button === 1 && panes) event.preventDefault();
              paneDrag.press({ item: { kind: "doc", id: artifact.id }, label: artifact.name }, event);
            }}
            onClick={(event) => {
              if (paneDrag.justDragged()) return;
              if (panes && (event.ctrlKey || event.metaKey)) panes.openBeside({ kind: "doc", id: artifact.id });
              else onOpen(artifact.id);
            }}
            onAuxClick={(event) => event.button === 1 && panes?.openBeside({ kind: "doc", id: artifact.id })}
            aria-current={artifact.id === activeId}
            title={artifact.path}
          >
            <FormatBadge format={artifact.format} />
            <span className="doc-tab-name">{artifact.name}</span>
            {artifact.diskState !== "same" ? <span className="dot dot-warn" aria-label="디스크와 다름" /> : null}
          </button>
          <button type="button" className="doc-tab-close" onClick={() => onClose(artifact.id)} aria-label={`${artifact.name} 탭 닫기`}>
            <Icon name="x" size={11} />
          </button>
        </span>
      ))}
    </nav>
  );
}
