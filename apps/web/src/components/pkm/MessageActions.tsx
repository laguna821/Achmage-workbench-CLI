import { useRef } from "react";
import { Icon } from "../Icon.tsx";
import { useOptionalPkm } from "./PkmContext.tsx";
import "../../styles/pkm.css";

/**
 * "페이지로 만들기" on a reply: the reply (or the part of it selected) becomes a page of the work,
 * with `source: workbench://session/…` so it remembers where it came from.
 */
export function MessageActions({ sessionId, itemId, streaming }: { sessionId: string; itemId: string; streaming: boolean }) {
  const pkm = useOptionalPkm();
  const ref = useRef<HTMLDivElement>(null);
  if (!pkm || streaming) return null;
  const makePage = () => {
    // A selection inside this reply narrows the page to it.
    const selection = window.getSelection();
    const message = ref.current?.parentElement;
    const inside = selection && !selection.isCollapsed && message && selection.anchorNode && message.contains(selection.anchorNode) ? selection.toString() : null;
    void pkm.client
      .messagePage(sessionId, itemId, inside)
      .then((artifact) => {
        pkm.onToast(`페이지를 만들었습니다: ${artifact.name}`);
        pkm.openArtifact(artifact);
      })
      .catch((error: Error) => pkm.onToast(error.message));
  };
  return (
    <div ref={ref} className="message-actions">
      <button
        type="button"
        className="ghost-button small message-page"
        // Keep the text selection: a mouse press on the button would clear it first.
        onMouseDown={(event) => event.preventDefault()}
        onClick={makePage}
        title="이 답(고른 부분이 있으면 그 부분)을 작업 폴더의 새 페이지로"
      >
        <Icon name="page" size={13} /> 페이지로 만들기
      </button>
    </div>
  );
}
