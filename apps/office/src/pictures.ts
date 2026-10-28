import { listen, post } from "./bridge.ts";

// Pictures from other apps in the office editors. The editors embed pictures in the document
// themselves; what they cannot see in a browser page is the system clipboard outside a paste event,
// picture data on it in WebKitGTK (the Linux app's engine gives a page text and copied files only),
// and picture formats they do not take (they take PNG, JPEG and GIF).

/** Formats every editor takes as is. */
export const TAKEN = new Set(["image/png", "image/jpeg", "image/gif"]);
const IMAGE_NAME = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i;

export const isPicture = (file: File) => file.type.startsWith("image/") || (!file.type && IMAGE_NAME.test(file.name));

/** An <img>-only fragment, as a browser's "Copy image" puts next to the picture (with its address as text). */
function imageOnlyHtml(html: string) {
  if (!/<img\b/i.test(html)) return false;
  return !(new DOMParser().parseFromString(html, "text/html").body.textContent ?? "").trim();
}

/**
 * The picture a paste carries, unless it is text: copying from Word, a spreadsheet or a web page
 * also puts a picture of the selection on the clipboard, and then the text is what was meant.
 */
export function pastedPicture(data: DataTransfer): File | null {
  const file =
    Array.from(data.files ?? []).find(isPicture) ??
    Array.from(data.items ?? [])
      .find((item) => item.kind === "file" && item.type.startsWith("image/"))
      ?.getAsFile() ??
    null;
  if (!file) return null;
  if (data.getData("text/plain").trim() && !imageOnlyHtml(data.getData("text/html"))) return null;
  return file;
}

/** The picture as PNG bytes (drawn once on a canvas when it is another format). */
export async function pngBytes(file: Blob): Promise<ArrayBuffer> {
  if (file.type === "image/png") return file.arrayBuffer();
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || 300;
    canvas.height = image.naturalHeight || 150;
    canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error("PNG로 바꾸지 못했습니다.");
    return png.arrayBuffer();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A picture in a format the editors take: PNG, JPEG and GIF as they are, anything else as PNG. */
export async function takenPicture(file: File): Promise<File> {
  if (TAKEN.has(file.type)) return file;
  const stem = file.name.replace(/\.[^.]+$/, "") || "image";
  return new File([await pngBytes(file)], `${stem}.png`, { type: "image/png" });
}

/** Clipboard format of the mark an in-editor copy leaves on the system clipboard. */
export const MARK_TYPE = "application/x-workbench-office";

/**
 * Leave a mark on the system clipboard (during the key press or click that copied): a later paste
 * that still carries it is the editor's own copy; anything else was copied in another app since.
 * Returns the mark, or null when this engine did not let the page write the clipboard.
 */
export function markClipboard(): string | null {
  const mark = crypto.randomUUID();
  let written = false;
  // WebKit copies with nothing selected only when the page asks for it on "beforecopy".
  const allow = (event: Event) => event.preventDefault();
  const write = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.clipboardData.setData(MARK_TYPE, mark);
    event.clipboardData.setData("text/html", `<meta name="workbench-office" content="${mark}">`);
    event.preventDefault();
    event.stopImmediatePropagation();
    written = true;
  };
  document.addEventListener("beforecopy", allow, true);
  document.addEventListener("copy", write, true);
  try {
    document.execCommand("copy");
  } catch {
    // Not allowed outside a user action.
  } finally {
    document.removeEventListener("beforecopy", allow, true);
    document.removeEventListener("copy", write, true);
  }
  return written ? mark : null;
}

/** Whether a paste carries this mark. */
export const carriesMark = (data: DataTransfer, mark: string) => data.getData(MARK_TYPE) === mark || data.getData("text/html").includes(mark);

const redispatched = new WeakSet<Event>();

/**
 * Pastes and drops carrying a picture the editors do not take (WebP, AVIF, BMP, SVG…) go on to the
 * editor as PNG: the event is held, the picture redrawn, and the same event sent again with the PNG.
 * Install before the editor, so this listener runs first.
 */
export function convertForeignPictures() {
  const hold = (event: ClipboardEvent | DragEvent, data: DataTransfer | null) => {
    if (!data || redispatched.has(event)) return;
    const pictures = Array.from(data.files ?? []).filter(isPicture);
    if (!pictures.some((file) => !TAKEN.has(file.type))) return;
    if (event.type === "paste" && !pastedPicture(data)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const target = event.target ?? window;
    const init = { bubbles: true, cancelable: true, composed: true };
    void Promise.all(pictures.map(takenPicture))
      .then((converted) => {
        const transfer = new DataTransfer();
        for (const file of converted) transfer.items.add(file);
        const again =
          event instanceof DragEvent
            ? new DragEvent(event.type, { ...init, dataTransfer: transfer, clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY })
            : new ClipboardEvent(event.type, { ...init, clipboardData: transfer });
        redispatched.add(again);
        target.dispatchEvent(again);
      })
      .catch((error: unknown) => console.warn("[workbench office] picture not converted", error));
  };
  window.addEventListener("paste", (event) => hold(event, event.clipboardData), true);
  window.addEventListener("drop", (event) => hold(event, event.dataTransfer), true);
}

/** A paste that shows the page nothing: no files, no text (an <img>-only fragment: its picture was held back). */
export function showsNothing(data: DataTransfer | null) {
  if (!data) return true;
  if ((data.files?.length ?? 0) > 0 || data.getData("text/plain").trim()) return false;
  const html = data.getData("text/html");
  return !html || !(new DOMParser().parseFromString(html, "text/html").body.textContent ?? "").trim();
}

/** The desktop clipboard's picture, read by the Workbench window for this editor (null: none). */
export function desktopPicture(): Promise<File | null> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      stop();
      resolve(null);
    }, 12_000);
    const stop = listen((message) => {
      if (message.type !== "office:clipboard-picture") return;
      stop();
      window.clearTimeout(timer);
      const picture = message.picture;
      resolve(picture ? new File([picture.bytes], `image.${picture.type.split("/")[1] ?? "png"}`, { type: picture.type }) : null);
    });
    post({ type: "office:clipboard-picture" });
  });
}

/**
 * The user's paste that shows the page nothing (a screenshot in WebKitGTK) goes on to the editor
 * with the desktop clipboard's picture, as the same paste. Install before the editor.
 */
export function pasteDesktopPictures() {
  window.addEventListener(
    "paste",
    (event) => {
      if (!event.isTrusted || redispatched.has(event) || !showsNothing(event.clipboardData)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const target = event.target ?? window;
      void desktopPicture()
        .then(async (file) => {
          if (!file) return;
          const transfer = new DataTransfer();
          transfer.items.add(await takenPicture(file));
          const again = new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: transfer });
          redispatched.add(again);
          target.dispatchEvent(again);
        })
        .catch((error: unknown) => console.warn("[workbench office] clipboard picture not pasted", error));
    },
    true,
  );
}
