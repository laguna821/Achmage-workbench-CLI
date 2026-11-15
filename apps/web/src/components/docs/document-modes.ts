import type { Artifact, Session } from "@workbench/contracts";

type Format = Artifact["format"];
/** Document screens built from IeumOffice, inside the central Workbench tab. */
export const isWordEditor = (format: Format | undefined) =>
  format === "docx" || format === "pptx" || format === "xlsx" || format === "pdf" || format === "xmind" || format === "epub" || format === "hwpx" || format === "hwp";
export const isRichTextEditor = (format: Format | undefined) => format === "markdown" || format === "html";
export const isOfficeEditing = (format: Format | undefined, mode: string) => (isWordEditor(format) && mode === "edit") || (isRichTextEditor(format) && mode === "rich");
/**
 * Whether an embedded editor keeps an AI panel of its own beside the page while the app's column is
 * beside it. The Hangul editor does not: its dock is the document's 문서 AI and is never on screen
 * with the column (closed, it takes no width). Word says when its sidebar is closed.
 */
export const editorKeepsAiPanel = (format: Format | undefined, editorAi: boolean | null) =>
  format !== "hwp" && format !== "hwpx" && editorAi !== false;
/** Editors that tell the app whether their own AI sidebar is open, when they start and on every change: Word, and the Hangul editor's dock. */
export const reportsAiSidebar = (format: Format | undefined) => format === "docx" || format === "hwp" || format === "hwpx";
/**
 * The Hangul editor's own AI dock is the document's one AI entry while the editor is open: the tab's
 * 문서 AI button opens and closes it (selection scope, live edits as one undo, attachments, skills,
 * images and the office executor live there), and the app's column is not shown beside it.
 */
export const editorAiIsEntry = (format: Format | undefined) => format === "hwp" || format === "hwpx";

/** A click on a document AI's row: the request to show that AI's conversation, held by the app until a view acts on it. */
export type AgentReveal = { sessionId: string };
/** How long a request waits for Word to say whether its own AI sidebar is open. */
export const REVEAL_WAIT_MS = 3000;
/** The Hangul dock is asked again after these pauses until it agrees; after the last, the tab says it did not. */
export const DOCK_RETRY_MS = [250, 500, 1000, 1000];
/** The Hangul editor opened its document but has not drawn its dock: said after this long. */
export const DOCK_READY_WAIT_MS = 8000;

export type ShownInput = {
  format: Format | undefined; mode: string;
  /** The document's tab is the one on screen. */
  visible: boolean;
  sessionId: string | null;
  /** The embedded editor is on this screen (not the pages of a document edited in another tab or window). */
  editorHere: boolean;
  /** A comparison or an older revision covers the editor. */
  editorHidden: boolean;
  /** The editor's own AI sidebar, where the editor reports it (Word); null when it does not, or has not yet. */
  editorAi: boolean | null;
  /** The app's conversation column beside the document shows this AI. */
  column: boolean;
};

/**
 * The document's conversation on screen, as far as the app knows: its conversation column beside
 * the document (any view of it), or an embedded editor's own AI sidebar once that editor has said
 * it is open (only Word does). An editor that says nothing is not taken to show it.
 */
export function documentConversationShown(input: ShownInput): string | null {
  if (!input.visible || !input.sessionId) return null;
  if (input.column) return input.sessionId;
  return isOfficeEditing(input.format, input.mode) && reportsAiSidebar(input.format) && input.editorHere && !input.editorHidden && input.editorAi === true ? input.sessionId : null;
}

/**
 * Which conversation the document view asks the gateway for. The pane's session decides when it
 * names an AI of this document (a click on that AI's row); otherwise the choice made when the
 * view opened stands. The gateway returns an AI of the same document as it is.
 */
export function documentAgentParent(artifactId: string, paneSession: Session | null | undefined, openedWith: string | null): string | null {
  return paneSession?.documentAgent?.artifactId === artifactId ? paneSession.id : openedWith;
}

/** The document's AI that counts as looked at: the one the view reports drawn, else the pane's, else the newest. */
export function documentAttentionSession(artifactId: string, drawn: string | null, paneSession: Session | null | undefined, sessions: Record<string, Session>): string | null {
  if (drawn && sessions[drawn]?.documentAgent?.artifactId === artifactId) return drawn;
  if (paneSession?.documentAgent?.artifactId === artifactId) return paneSession.id;
  return Object.values(sessions).filter((session) => session.documentAgent?.artifactId === artifactId && !session.archivedAt).sort((a, b) => b.createdAt - a.createdAt)[0]?.id ?? null;
}

/** Another live AI of the same document (same workspace), the latest used first: what a view goes on with when the AI it shows is archived. */
export function otherDocumentAgent(sessions: Record<string, Session>, artifactId: string, ended: Session): Session | null {
  return Object.values(sessions)
    .filter((session) => session.id !== ended.id && session.documentAgent?.artifactId === artifactId && !session.archivedAt && session.workspaceId === ended.workspaceId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

/**
 * The narrowest document view the embedded editors are opened in. They keep a 360px AI panel beside
 * the page; measured, the text column is the view's width minus 504px, so at 560px it is 80px (a
 * few characters a line) and at 420px nothing. 680px leaves it about eleven Hangul a line.
 */
export const EDITOR_MIN_WIDTH = 680;
/** The AI panel the embedded editors keep beside the page (measured: the text column is the view's width minus 504 with it open). */
export const EDITOR_PANEL_WIDTH = 360;
/**
 * A document read beside a conversation as pages drawn to the column's width (Word, PowerPoint,
 * Excel 쪽 보기; PDF): below about 640 an A4 page's body text is drawn at 6–7 px (the review's reading
 * of the page scale; not measured on a real page here). Text that reflows (미리보기, 글 보기, 원문)
 * reads at a pane's minimum.
 */
export const READ_PAGE_MIN_WIDTH = 640;

export type NarrowInput = {
  /** The document view's width; null or 0 while it is not known. */
  width: number | null;
  /** The embedded editor is the view chosen now. */
  editing: boolean;
  /** An embedded editor is mounted in this view (it may hold edits it has not reported yet). */
  mounted: boolean;
  /** The view is being opened: this is the first width known for it, and no editor was ever mounted in it. */
  opening: boolean;
  /** The person asked for the editor in a narrow pane ("편집기로 열기"). */
  forced: boolean;
  /** The app's own view is shown because the pane was narrow when the document opened (not picked by the person). */
  auto: boolean;
  /** Edits not saved yet in the app's own view (text typed there, a save still on its way). */
  unsaved: boolean;
};

/**
 * What the pane's width asks for. A size change never removes an editor that is already open,
 * whatever it reports: the Word and PowerPoint editors say "unsaved" only every two seconds, so
 * their last report is not their state. An open editor in a pane too narrow for it stays and the
 * other view is offered (taking it is the person's own change of view, with its usual save). The
 * app's own view is chosen by itself only when a document is opened into an already narrow pane,
 * before any editor is mounted. Widening mounts the editor from that stand-in view only, and never
 * over unsaved edits there.
 */
export function narrowPaneStep({ width, editing, mounted, opening, forced, auto, unsaved }: NarrowInput): "stay" | "offer-view" | "open-own-view" | "back-to-editor" {
  if (!width) return "stay";
  if (editing) {
    if (forced || width >= EDITOR_MIN_WIDTH) return "stay";
    return mounted ? "offer-view" : opening ? "open-own-view" : "stay";
  }
  return auto && !unsaved && width >= EDITOR_MIN_WIDTH ? "back-to-editor" : "stay";
}

/**
 * The app's own read view of a format, as a document opens beside a conversation: never an
 * embedded editor. Pages for Word, PowerPoint and Excel; the drawn page for Markdown and HTML; the
 * text for the rest (plain text and designs are read-only there, having no writer lease).
 */
export function readView(format: Format | undefined): "preview" | "pages" | "render" | "edit" {
  if (format === "markdown") return "preview";
  if (format === "html") return "render";
  if (format === "docx" || format === "pptx" || format === "xlsx") return "pages";
  return isWordEditor(format) ? "preview" : "edit";
}

/** The app's own view of a format, shown in place of its embedded editor. */
export function narrowView(format: Format | undefined): { mode: "edit" | "source" | "preview"; label: string; go: string } {
  if (format === "markdown") return { mode: "edit", label: "원문", go: "원문으로 보기" };
  if (format === "html") return { mode: "source", label: "원문", go: "원문으로 보기" };
  return format === "pdf" ? { mode: "preview", label: "미리보기", go: "미리보기로 바꾸기" } : { mode: "preview", label: "글 보기", go: "글 보기로 바꾸기" };
}
