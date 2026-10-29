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
  /** The text selected inside this reply, if any. */
  const selected = () => {
    const selection = window.getSelection();
    const message = ref.current?.parentElement;
    return selection && !selection.isCollapsed && message && selection.anchorNode && message.contains(selection.anchorNode) ? selection.toString().trim() || null : null;
  };
  /** "결정으로 / 질문으로": the selection, else the reply's first paragraph, into the project note. */
  const keep = (section: "decision" | "question") => {
    const session = pkm.state.sessions[sessionId];
    if (!session) return;
    const item = pkm.state.transcripts[sessionId]?.items.find((entry) => entry.id === itemId);
    const whole = item && item.kind === "assistant" ? item.text : "";
    // The first paragraph of prose: headings, code and quotes are skipped, list marks dropped.
    const prose = whole
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .find((part) => part && !/^(#{1,6}\s|```|~~~|>|\|)/.test(part));
    const text = selected() ?? prose?.replace(/^([-*+]|\d+\.)\s+/gm, "").replace(/\s+/g, " ").trim() ?? "";
    if (!text) return;
    void pkm.api
      .addProjectEntry(session.workId, { section, text: text.slice(0, 400), sessionId, itemId })
      .then((write) =>
        pkm.onToast({
          text: `${section === "decision" ? "결정" : "열린 질문"}으로 프로젝트 노트에 남겼습니다.`,
          action: write.token ? { label: "되돌리기", run: () => void pkm.api.undoProject(session.workId, write.token).catch((error: Error) => pkm.onToast(error.message)) } : undefined,
        }),
      )
      .catch((error: Error) => pkm.onToast(error.message));
  };
  const makePage = () => {
    // A selection inside this reply narrows the page to it.
    const inside = selected();
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
      <button type="button" className="ghost-button small message-keep" onMouseDown={(event) => event.preventDefault()} onClick={() => keep("decision")} title="이 답(고른 부분이 있으면 그 부분)을 프로젝트 노트의 결정으로">
        <Icon name="check" size={13} /> 결정으로
      </button>
      <button type="button" className="ghost-button small message-keep" onMouseDown={(event) => event.preventDefault()} onClick={() => keep("question")} title="이 답(고른 부분이 있으면 그 부분)을 프로젝트 노트의 열린 질문으로">
        <Icon name="help" size={13} /> 질문으로
      </button>
    </div>
  );
}
