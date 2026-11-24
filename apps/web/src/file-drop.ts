import { useEffect, useState, type DragEvent } from "react";

// Files dropped from the computer onto a conversation (composer-056). The owner's Linux app (WebKitGTK)
// hands a file manager's drop to the page as a `text/uri-list` of file:// addresses, often with an
// empty `dataTransfer.files`: both are taken, the files as files and the addresses as paths (the
// gateway reads those, apps/host sessions.ts attachLocal). A drag that started inside the page (a link,
// selected text, an image) is never a file drop.

/** Local paths named by a uri-list: file:// lines only (comments and web addresses left out). */
export function droppedPaths(uriList: string): string[] {
  const paths: string[] = [];
  for (const raw of uriList.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !/^file:\/\//i.test(line)) continue;
    let url: URL;
    try { url = new URL(line); } catch { continue; }
    if (url.host && url.host !== "localhost") continue;
    let path: string;
    try { path = decodeURIComponent(url.pathname); } catch { continue; }
    // file:///C:/Users/… on Windows.
    if (/^\/[a-z]:\//i.test(path)) path = path.slice(1).replace(/\//g, "\\");
    if (path) paths.push(path);
  }
  return paths;
}

/** What a drag from outside carries that could be files (its types are readable while it moves; its data only at the drop). */
export const carriesFiles = (types: readonly string[] | DOMStringList) => {
  const list = Array.from(types as ArrayLike<string>);
  return list.includes("Files") || list.includes("text/uri-list");
};

// Drags that start in this page are the page's own (one listener for every drop zone).
let insideDrag = false;
let listening = false;
function watchInsideDrags() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener("dragstart", () => { insideDrag = true; }, true);
  const end = () => { insideDrag = false; };
  document.addEventListener("dragend", end, true);
  // A drag of the page's own that ended outside the window without a dragend never blocks the next one.
  document.addEventListener("mousedown", end, true);
}

/**
 * A drop zone for files from the computer: `over` while such a drag is above it, and the props for its
 * element. `onFiles` takes files with their bytes; `onPaths` (the PC only) takes file:// paths when the
 * drop carries no files. `enabled` false: the zone takes nothing.
 */
export function useFileDrop({ onFiles, onPaths, enabled = true }: { onFiles: ((files: File[]) => void) | null | undefined; onPaths?: ((paths: string[]) => void) | null; enabled?: boolean }) {
  const [over, setOver] = useState(false);
  useEffect(() => { watchInsideDrags(); }, []);
  useEffect(() => { if (!enabled) setOver(false); }, [enabled]);
  const active = enabled && Boolean(onFiles);
  const takes = (event: DragEvent) => active && !insideDrag && carriesFiles(event.dataTransfer?.types ?? []);
  const props = {
    onDragEnter: (event: DragEvent) => {
      if (!takes(event)) return;
      event.preventDefault();
      setOver(true);
    },
    onDragOver: (event: DragEvent) => {
      if (!takes(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setOver(true);
    },
    onDragLeave: (event: DragEvent) => {
      // Into a child of the zone it is still over it (WebKit may name no next target: the next dragover says so again).
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      setOver(false);
    },
    onDrop: (event: DragEvent) => {
      setOver(false);
      if (!takes(event)) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer.files ?? []);
      if (files.length) { onFiles!(files); return; }
      const paths = droppedPaths(event.dataTransfer.getData("text/uri-list") ?? "");
      if (paths.length && onPaths) onPaths(paths);
    },
  };
  return { over: over && active, props };
}
