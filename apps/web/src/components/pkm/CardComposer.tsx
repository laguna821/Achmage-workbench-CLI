import { forwardRef } from "react";
import type { Provider } from "@workbench/contracts";
import { newRequestId, titleFrom } from "../../format.ts";
import { Composer } from "../Composer.tsx";
import { EngineTabs } from "../StartView.tsx";
import { NoteChips } from "./NoteChips.tsx";
import { usePkm } from "./PkmContext.tsx";
import { useNoteDrop } from "../../panedrag.ts";
import "../../styles/pkm.css";

/** Where a request sent under a card list goes: a new work (in an app folder), or a new session of a work. */
export type ComposerPlace = { kind: "new"; folderId: string | null } | { kind: "work"; workId: string };

/**
 * The input under a card list or a vault note: notes dragged onto it (or the note on screen) travel
 * with the request as read-only references, and the request starts a new session — the design's
 * "노트를 입력창으로 끌면 그 노트를 붙인 새 세션".
 */
export const CardComposer = forwardRef<
  HTMLDivElement,
  {
    draftKey: string;
    place: ComposerPlace;
    notes: { path: string; title: string }[];
    onNotes: (notes: { path: string; title: string }[]) => void;
    engine: Provider;
    setEngine: (provider: Provider) => void;
    /** A note is being dragged over the input (it also notices notes held over it by itself). */
    dropping: boolean;
    placeholder?: string;
    /** The line under the input (what dropping a card does, by default). */
    hint?: string;
  }
>(function CardComposer({ draftKey, place, notes, onNotes, engine, setEngine, dropping: held, placeholder, hint }, ref) {
  const pkm = usePkm();
  // A note card or a note's pane header dropped here goes with the request (only Markdown notes).
  const drop = useNoteDrop((note) => {
    if (!note.path.endsWith(".md")) return pkm.onToast("마크다운 노트만 요청에 붙일 수 있습니다.");
    if (!notes.some((entry) => entry.path === note.path)) onNotes([...notes, note]);
  });
  const dropping = held || drop.over;
  const send = async (text: string) => {
    try {
      const work = place.kind === "work" ? pkm.state.works[place.workId] : await pkm.api.createWork(titleFrom(text), place.folderId, null);
      if (!work) return false;
      const session = await pkm.api.createSession(work.id, engine);
      await pkm.client.send(session.id, newRequestId(), text, notes.map((note) => note.path));
      onNotes([]);
      pkm.showSession(work, session);
      return true;
    } catch (error) {
      pkm.onToast(error instanceof Error ? error.message : String(error));
      return false;
    }
  };
  return (
    <div ref={ref} {...drop.props} className={`column composer-area pkm-composer pkm-drop${dropping ? " dropping" : ""}`}>
      <EngineTabs value={engine} onChange={setEngine} />
      <Composer
        draftKey={`pkm:${draftKey}`}
        placeholder={placeholder ?? (place.kind === "work" ? "이 작업에 새 세션으로 요청하기" : "노트를 붙여 새 세션 시작하기")}
        busy={false}
        header={notes.length ? <NoteChips notes={notes} onRemove={(path) => onNotes(notes.filter((note) => note.path !== path))} /> : null}
        onSend={(text) => send(text)}
      />
      <div className="footer-line pkm-drop-hint">{dropping ? "놓으면 이 요청에 노트가 읽기 전용으로 붙습니다." : (hint ?? "노트 카드를 여기로 끌어 놓으면 읽기 전용 참고 자료로 붙습니다.")}</div>
    </div>
  );
});
