import { StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";

// Pictures pasted or dropped into the Markdown editor: a placeholder shows where the picture goes
// while it is stored (R2 or the work folder, decided by the gateway), then the `![alt](url)` line
// takes its place. The placeholder is a widget, not text, so a save made meanwhile never keeps it.

export type ImageHandling = {
  /** Store one picture; resolves with the Markdown to insert, or null when it could not be stored (already said). */
  insert?: (file: File) => Promise<string | null>;
  /** Why pictures cannot go into this document; shown instead of inserting. */
  refuse?: string;
  notice: (message: string) => void;
  /** The desktop clipboard's picture, for a paste that shows the page nothing (WebKitGTK keeps pictures from pages). */
  clipboard?: () => Promise<File | null>;
};

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const isImageFile = (file: File) => file.type.startsWith("image/") || (!file.type && IMAGE_NAME.test(file.name));

/** An <img>-only fragment, as a browser's "Copy image" puts next to the picture (with its address as text). */
function imageOnlyHtml(html: string) {
  if (!/<img\b/i.test(html)) return false;
  return !(new DOMParser().parseFromString(html, "text/html").body.textContent ?? "").trim();
}

/**
 * Pictures a paste carries, unless it is text: copying from Word or a web page also puts a picture
 * of the selection on the clipboard, and then the text is what was meant.
 */
export function pastedImages(data: DataTransfer | null): File[] {
  if (!data) return [];
  let files = Array.from(data.files ?? []).filter(isImageFile);
  // Some engines list clipboard pictures only as items.
  if (!files.length) {
    files = Array.from(data.items ?? [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
  }
  if (!files.length) return [];
  if (data.getData("text/plain").trim() && !imageOnlyHtml(data.getData("text/html"))) return [];
  return files;
}

/**
 * A paste that shows the page nothing: no files and no text. WebKitGTK hands a page the clipboard's
 * text and copied files but not picture data, so a screenshot arrives like this (an <img>-only
 * fragment from a browser's "Copy image" is nothing either: its picture was held back).
 */
export function showsNothing(data: DataTransfer | null) {
  if (!data) return true;
  if ((data.files?.length ?? 0) > 0 || data.getData("text/plain").trim()) return false;
  const html = data.getData("text/html");
  return !html || !(new DOMParser().parseFromString(html, "text/html").body.textContent ?? "").trim();
}

/** Pictures among dropped files (a file manager's drop may also carry their paths as text). */
export const droppedImages = (data: DataTransfer | null) => Array.from(data?.files ?? []).filter(isImageFile);

const started = StateEffect.define<{ id: number; pos: number; label: string }>({ map: (value, mapping) => ({ ...value, pos: mapping.mapPos(value.pos, 1) }) });
const ended = StateEffect.define<number>();

class Pending extends WidgetType {
  readonly id: number;
  readonly label: string;
  constructor(id: number, label: string) {
    super();
    this.id = id;
    this.label = label;
  }
  eq(other: Pending) {
    return other.id === this.id;
  }
  toDOM() {
    const box = document.createElement("span");
    box.className = "cm-image-pending";
    box.setAttribute("role", "status");
    const spinner = document.createElement("span");
    spinner.className = "spinner small";
    box.append(spinner, document.createTextNode(this.label));
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

const pending = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    let next = set.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(started)) next = next.update({ add: [Decoration.widget({ widget: new Pending(effect.value.id, effect.value.label), side: 1, uploadId: effect.value.id }).range(effect.value.pos)] });
      else if (effect.is(ended)) next = next.update({ filter: (_from, _to, decoration) => decoration.spec.uploadId !== effect.value });
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Editors that went away (another view of the document): a picture stored meanwhile cannot be put in. */
const gone = new WeakSet<EditorView>();
const lifecycle = ViewPlugin.define((view) => ({
  destroy() {
    gone.add(view);
  },
}));

function placeOf(view: EditorView, id: number) {
  let found: number | null = null;
  view.state.field(pending).between(0, view.state.doc.length, (from, _to, decoration) => {
    if (decoration.spec.uploadId !== id) return;
    found = from;
    return false;
  });
  return found as number | null;
}

/**
 * What goes around a picture inserted at `at` so it is a paragraph of its own (lines next to each
 * other are one paragraph in Markdown, and the pictures would sit side by side in the text).
 */
export function paragraphAround(doc: Text, at: number) {
  const line = doc.lineAt(at);
  const head = doc.sliceString(line.from, at);
  const tail = doc.sliceString(at, line.to);
  const blank = (number: number) => number < 1 || number > doc.lines || !doc.line(number).text.trim();
  const before = head.trim() ? "\n\n" : head || blank(line.number - 1) ? "" : "\n";
  const after = tail.trim() ? "\n\n" : tail || blank(line.number + 1) ? "" : "\n";
  return { before, after };
}

let nextId = 1;

/** One placeholder per picture at once; the pictures are stored one after another so they land in order. */
async function insertImages(view: EditorView, files: File[], from: number, to: number, handling: ImageHandling, userEvent: string) {
  const ids = files.map(() => nextId++);
  view.dispatch({
    changes: from === to ? undefined : { from, to, insert: "" },
    effects: ids.map((id, index) => started.of({ id, pos: from, label: `그림 넣는 중… ${files[index]!.name || "image"}` })),
    userEvent,
  });
  for (const [index, file] of files.entries()) {
    const id = ids[index]!;
    let markdown: string | null = null;
    try {
      markdown = await handling.insert!(file);
    } catch (error) {
      handling.notice(`그림을 넣지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (gone.has(view)) {
      if (markdown) handling.notice("문서 보기가 바뀌어 그림을 넣지 못했습니다. 다시 붙여 넣어 주세요.");
      continue;
    }
    const at = placeOf(view, id);
    if (at === null) continue;
    const { before, after } = markdown ? paragraphAround(view.state.doc, at) : { before: "", after: "" };
    const selection = view.state.selection.main;
    const caretHere = selection.empty && selection.head === at;
    view.dispatch({
      changes: markdown ? { from: at, insert: `${before}${markdown}${after}` } : undefined,
      effects: ended.of(id),
      // The caret after the picture's line, where the writing goes on.
      selection: caretHere && markdown ? { anchor: at + before.length + markdown.length } : undefined,
      scrollIntoView: caretHere,
      userEvent,
    });
  }
}

/** Paste and drop of pictures; `handling` is read at the moment of the paste (the document's current rules). */
export function imagePaste(handling: () => ImageHandling | null): Extension {
  const refuse = (current: ImageHandling) => {
    current.notice(current.refuse ?? "이 문서에는 그림을 넣지 못합니다.");
    return true;
  };
  return [
    pending,
    lifecycle,
    EditorView.domEventHandlers({
      paste(event, view) {
        const current = handling();
        if (!current) return false;
        const files = pastedImages(event.clipboardData);
        if (!files.length) {
          // Only for the user's own paste: the desktop clipboard is read on that and nothing else.
          if (!event.isTrusted || !current.clipboard || !showsNothing(event.clipboardData)) return false;
          event.preventDefault();
          if (view.state.readOnly) return true;
          void current.clipboard().then(
            (file) => {
              if (!file || gone.has(view)) return;
              if (current.refuse || !current.insert) return void refuse(current);
              const { from, to } = view.state.selection.main;
              void insertImages(view, [file], from, to, current, "input.paste");
            },
            () => undefined,
          );
          return true;
        }
        event.preventDefault();
        if (view.state.readOnly) return true;
        if (current.refuse || !current.insert) return refuse(current);
        const { from, to } = view.state.selection.main;
        void insertImages(view, files, from, to, current, "input.paste");
        return true;
      },
      dragover(event) {
        // Allow the drop; what it carries is only readable when it lands.
        if (handling() && event.dataTransfer?.types.includes("Files")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
        return false;
      },
      drop(event, view) {
        const current = handling();
        const files = current ? droppedImages(event.dataTransfer) : [];
        if (!current || !files.length) return false;
        event.preventDefault();
        if (view.state.readOnly) return true;
        if (current.refuse || !current.insert) return refuse(current);
        const at = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
        void insertImages(view, files, at, at, current, "input.drop");
        return true;
      },
    }),
  ];
}
