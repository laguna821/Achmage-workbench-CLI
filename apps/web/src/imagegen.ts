import { useEffect, useState, useSyncExternalStore } from "react";
import { isImageAspect, type DrawRequest, type DrawResult, type ImageAspect, type ImageInfo, type ImageTemplates } from "@workbench/contracts";
import { designToken } from "./design.ts";

// "그림" in the window: gateway calls (with this window's token, like office.ts), picture files as
// blob: URLs, the templates, the choices the pill remembers, and which Markdown document a picture
// goes into ("현재 문서에 넣기", drawing at a place in a document).

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${designToken()}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as T & { message?: string };
  if (!response.ok) throw new Error(json.message ?? response.statusText);
  return json;
}

export const drawImage = (sessionId: string, request: DrawRequest) => call<DrawResult>("POST", `/api/sessions/${sessionId}/images`, request);
export const imageInfo = (imageId: string) => call<ImageInfo>("GET", `/api/images/${encodeURIComponent(imageId)}`);
export const stopSession = (sessionId: string) => call("POST", `/api/sessions/${sessionId}/interrupt`);

// ── templates ────────────────────────────────────────────────────────────────

let templates: Promise<ImageTemplates> | null = null;
let templatesNow: ImageTemplates | null = null;
const templateListeners = new Set<() => void>();

/** What the gateway sent, in the shape the menus can always read. */
const usable = (value: Partial<ImageTemplates> | null | undefined): ImageTemplates => ({
  templates: Array.isArray(value?.templates) ? value.templates : [],
  rules: typeof value?.rules === "string" ? value.rules : "",
});

function loadTemplates() {
  if (!templates) {
    templates = call<ImageTemplates>("GET", "/api/image-templates").then((raw) => {
      const value = usable(raw);
      templatesNow = value;
      templateListeners.forEach((listener) => listener());
      return value;
    });
    templates.catch(() => {
      templates = null;
    });
  }
  return templates;
}

/** Replace the user's templates and standing rules (built-ins are not sent back). */
export async function saveTemplates(value: ImageTemplates) {
  const saved = usable(await call<ImageTemplates>("PUT", "/api/image-templates", { templates: value.templates.filter((template) => !template.builtIn), rules: value.rules }));
  templatesNow = saved;
  templates = Promise.resolve(saved);
  templateListeners.forEach((listener) => listener());
  return saved;
}

/** Built-in and user templates with the standing rules; null until loaded. */
export function useTemplates(): ImageTemplates | null {
  const value = useSyncExternalStore(
    (listener) => {
      templateListeners.add(listener);
      return () => templateListeners.delete(listener);
    },
    () => templatesNow,
  );
  useEffect(() => {
    void loadTemplates().catch(() => undefined);
  }, []);
  return value;
}

// ── picture files ────────────────────────────────────────────────────────────

const pictures = new Map<string, Promise<string>>();

/** A picture inside a work folder as a blob: URL (pictures are new files, so the URL is kept). */
export function pictureUrl(workId: string, path: string, workspaceId?: string): Promise<string> {
  const key = `${workId}\u0000${workspaceId ?? ""}\u0000${path}`;
  let url = pictures.get(key);
  if (!url) {
    url = fetch(`/api/works/${workId}/image?path=${encodeURIComponent(path)}${workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : ""}`, { headers: { authorization: `Bearer ${designToken()}` } }).then(async (response) => {
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? response.statusText);
      }
      return URL.createObjectURL(await response.blob());
    });
    url.catch(() => pictures.delete(key));
    pictures.set(key, url);
    if (pictures.size > 200) pictures.delete(pictures.keys().next().value!);
  }
  return url;
}

export function usePicture(workId: string | null, path: string | null, workspaceId?: string) {
  const key = workId && path ? `${workId}\u0000${workspaceId ?? ""}\u0000${path}` : "";
  const [state, setState] = useState<{ key: string; url: string | null; error: string | null }>({ key: "", url: null, error: null });
  useEffect(() => {
    if (!workId || !path) return;
    let active = true;
    pictureUrl(workId, path, workspaceId).then(
      (url) => active && setState({ key, url, error: null }),
      (error: Error) => active && setState({ key, url: null, error: error.message }),
    );
    return () => {
      active = false;
    };
    // The key covers the work and the path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state : { url: null, error: null };
}

// ── what the pill remembers ──────────────────────────────────────────────────

export type DrawChoice = { templateId: string | null; aspect: ImageAspect; transparent: boolean };

const CHOICE_KEY = "workbench.drawChoice";

export function readDrawChoice(): DrawChoice {
  try {
    const saved = JSON.parse(localStorage.getItem(CHOICE_KEY) ?? "{}") as Partial<DrawChoice>;
    return { templateId: typeof saved.templateId === "string" ? saved.templateId : null, aspect: isImageAspect(saved.aspect) ? saved.aspect : "auto", transparent: saved.transparent === true };
  } catch {
    return { templateId: null, aspect: "auto", transparent: false };
  }
}

export function writeDrawChoice(choice: DrawChoice) {
  localStorage.setItem(CHOICE_KEY, JSON.stringify(choice));
}

export function useDrawChoice() {
  const [choice, setChoice] = useState<DrawChoice>(readDrawChoice);
  const update = (next: DrawChoice) => {
    writeDrawChoice(next);
    setChoice(next);
  };
  return [choice, update] as const;
}

// ── Markdown documents a picture goes into ───────────────────────────────────

/** The Markdown editor on screen: puts a block at its cursor. */
export type DocTarget = { artifactId: string; workId: string; insertAtCursor: (block: string) => void };

const LAST_DOC_KEY = "workbench.lastMarkdownDoc";
let shown: DocTarget | null = null;
let version = 0;
const docListeners = new Set<() => void>();
const queued = new Map<string, string[]>();
/** Drawings asked for at a place in a document: artifactId -> request id -> offset in its text. */
const inline = new Map<string, Map<string, number>>();

const changed = () => {
  version += 1;
  docListeners.forEach((listener) => listener());
};

function lastDocs(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(LAST_DOC_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

/** A Markdown editor is on screen (until the returned cleanup); it is also "the current document" of its work afterwards. */
export function showDoc(target: DocTarget) {
  shown = target;
  localStorage.setItem(LAST_DOC_KEY, JSON.stringify({ ...lastDocs(), [target.workId]: target.artifactId }));
  changed();
  return () => {
    if (shown === target) shown = null;
    changed();
  };
}

/** "현재 문서" of a work: the Markdown document on screen, else the one last shown. */
export function currentDoc(workId: string): string | null {
  if (shown?.workId === workId) return shown.artifactId;
  return lastDocs()[workId] ?? null;
}

/** Into the editor on screen now, or kept until that document opens ("queued"). */
export function putInDoc(artifactId: string, block: string): "now" | "queued" {
  if (shown?.artifactId === artifactId) {
    shown.insertAtCursor(block);
    return "now";
  }
  queued.set(artifactId, [...(queued.get(artifactId) ?? []), block]);
  return "queued";
}

export function takeQueued(artifactId: string) {
  const blocks = queued.get(artifactId) ?? [];
  queued.delete(artifactId);
  return blocks;
}

/** Re-render when the document on screen changes (enables "현재 문서에 넣기"). */
export function useDocVersion() {
  return useSyncExternalStore(
    (listener) => {
      docListeners.add(listener);
      return () => docListeners.delete(listener);
    },
    () => version,
  );
}

const cursors = new Map<string, number>();

/** Where the user last left the cursor in a document (pictures go there). */
export const rememberCursor = (artifactId: string, at: number) => cursors.set(artifactId, at);
export const cursorOf = (artifactId: string) => cursors.get(artifactId) ?? null;

export function inlineDrawings(artifactId: string) {
  let entries = inline.get(artifactId);
  if (!entries) inline.set(artifactId, (entries = new Map()));
  return entries;
}

// ── small things the card needs ──────────────────────────────────────────────

export const inDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Copy text: the clipboard API, or a hidden text area where it is not allowed. */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

/** Open a file in the desktop's default app (desktop shell only). */
export async function openInApp(path: string) {
  const opener = await import("@tauri-apps/plugin-opener");
  await opener.openPath(path);
}
