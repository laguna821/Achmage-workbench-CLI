import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExtension } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { tags } from "@lezer/highlight";
import { imagePaste, type ImageHandling } from "./image-paste.ts";

export type EditorSelection = { from: number; to: number; text: string; label: string; pageId?: string; objectIds?: string[] } | null;

// Colors come from the look tokens, so the editor wears the engine's look.
const highlight = HighlightStyle.define([
  { tag: tags.heading1, fontWeight: "700", fontSize: "1.35em", color: "var(--h1)" },
  { tag: tags.heading2, fontWeight: "700", fontSize: "1.2em", color: "var(--h2)" },
  { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], fontWeight: "650", color: "var(--h3)" },
  { tag: tags.strong, fontWeight: "700", color: "var(--strong)" },
  { tag: tags.emphasis, fontStyle: "italic", color: "var(--em)" },
  { tag: [tags.link, tags.url], color: "var(--link)" },
  { tag: tags.monospace, fontFamily: "var(--mono)", color: "var(--code-text)", backgroundColor: "color-mix(in srgb, var(--code-bg) 85%, transparent)" },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: "var(--faint)" },
  { tag: tags.quote, color: "var(--text-soft)", fontStyle: "italic" },
  { tag: tags.list, color: "var(--accent)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--text)", fontSize: "var(--e-size)" },
  ".cm-scroller": { fontFamily: "var(--e-font)", lineHeight: "var(--e-line)", padding: "18px 0 40px" },
  ".cm-content": { caretColor: "var(--accent)", maxWidth: "820px", margin: "0 auto", padding: "0 24px" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 24%, transparent) !important",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent) 5%, transparent)" },
  ".cm-placeholder": { color: "var(--faint)" },
});

function selectionOf(state: EditorState): EditorSelection {
  const range = state.selection.main;
  if (range.empty) return null;
  const startLine = state.doc.lineAt(range.from).number;
  const endLine = state.doc.lineAt(range.to).number;
  return {
    from: range.from,
    to: range.to,
    text: state.sliceDoc(range.from, range.to),
    label: startLine === endLine ? `${startLine}행` : `${startLine}–${endLine}행`,
  };
}

/** CodeMirror 6 on the original text: no reformatting, so YAML, links and body stay as written. */
export function MarkdownEditor({
  value,
  readOnly,
  onChange,
  onSelection,
  onBlur,
  images,
}: {
  value: string;
  readOnly?: boolean;
  onChange: (text: string) => void;
  onSelection: (selection: EditorSelection) => void;
  onBlur?: () => void;
  /** What pasted or dropped pictures become (image-paste.ts); none: the editor's own paste. */
  images?: ImageHandling | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onSelection, onBlur, images });
  callbacks.current = { onChange, onSelection, onBlur, images };

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          markdown(),
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          theme,
          placeholderExtension("내용을 입력하세요"),
          EditorState.readOnly.of(Boolean(readOnly)),
          imagePaste(() => callbacks.current.images ?? null),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
            if (update.selectionSet || update.docChanged) callbacks.current.onSelection(selectionOf(update.state));
            if (update.focusChanged && !update.view.hasFocus) callbacks.current.onBlur?.();
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // Recreated only when switching between editable and read-only views.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  // Outside changes (a new revision loaded) replace the text without resetting history position.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current !== value) editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return <div className="md-editor" ref={host} />;
}
