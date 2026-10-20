import { useEffect, useState } from "react";
import type { DesignHostMessage, DesignPageMessage } from "@workbench/contracts";

// Design documents in the Workbench window: thumbnails drawn by the design page's renderer (a hidden
// iframe, created on first use and removed when idle) and object-level differences between two
// versions of a design.

let token: string | null = null;

export function configureDesign(value: string) {
  token = value;
}

export function designToken() {
  return token;
}

type Pending = { resolve: (dataUrl: string) => void; reject: (error: Error) => void };

class Renderer {
  private frame: HTMLIFrameElement | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<string, Pending>();
  private idle: number | undefined;
  private counter = 0;

  constructor() {
    window.addEventListener("message", (event) => {
      if (event.origin !== location.origin || !this.frame || event.source !== this.frame.contentWindow) return;
      const message = event.data as DesignPageMessage;
      if (message.type !== "render:result") return;
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.dataUrl) waiting.resolve(message.dataUrl);
      else waiting.reject(new Error(message.error ?? "그리지 못했습니다."));
      this.scheduleIdle();
    });
  }

  private start() {
    if (this.ready) return this.ready;
    const frame = document.createElement("iframe");
    frame.src = "/design/?mode=render";
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText = "position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;left:-10px;top:-10px";
    this.frame = frame;
    this.ready = new Promise((resolve) => {
      const onReady = (event: MessageEvent) => {
        if (event.source !== frame.contentWindow || (event.data as DesignPageMessage)?.type !== "render:ready") return;
        window.removeEventListener("message", onReady);
        this.send({ type: "render:init", token: token ?? "" });
        resolve();
      };
      window.addEventListener("message", onReady);
    });
    document.body.appendChild(frame);
    return this.ready;
  }

  private send(message: DesignHostMessage) {
    this.frame?.contentWindow?.postMessage(message, location.origin);
  }

  /** The renderer holds the editor engine in memory; let it go a while after the last thumbnail. */
  private scheduleIdle() {
    window.clearTimeout(this.idle);
    this.idle = window.setTimeout(() => {
      if (this.pending.size) return this.scheduleIdle();
      this.frame?.remove();
      this.frame = null;
      this.ready = null;
    }, 45_000);
  }

  async render(artifactId: string, document: string, page: number, width: number): Promise<string> {
    await this.start();
    window.clearTimeout(this.idle);
    const id = `r${++this.counter}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ type: "render:request", id, artifactId, document, page, width });
    });
  }
}

let renderer: Renderer | null = null;
const images = new Map<string, Promise<string>>();
const texts = new Map<string, Promise<string>>();

function remember<T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>, limit = 80) {
  let value = cache.get(key);
  if (!value) {
    value = make();
    value.catch(() => cache.delete(key));
    cache.set(key, value);
    if (cache.size > limit) cache.delete(cache.keys().next().value!);
  }
  return value;
}

async function get(path: string) {
  const response = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  const body = (await response.json()) as { text?: string; base?: string; proposed?: string; message?: string };
  if (!response.ok) throw new Error(body.message ?? response.statusText);
  return body;
}

/** JSON of a design revision (immutable, so cached). */
export function revisionText(artifactId: string, revision: number) {
  return remember(texts, `${artifactId}@${revision}`, () => get(`/api/artifacts/${artifactId}/text?revision=${revision}`).then((body) => body.text ?? ""));
}

/** Base and proposed JSON of a design proposal. */
export function proposalTexts(proposalId: string) {
  return remember(texts, `proposal:${proposalId}`, () => get(`/api/proposals/${proposalId}`).then((body) => JSON.stringify([body.base ?? "", body.proposed ?? ""]))).then(
    (value) => JSON.parse(value) as [string, string],
  );
}

export type ThumbSource = { artifactId: string; revision: number } | { artifactId: string; proposalId: string; side: "base" | "proposed" };

export function designThumb(source: ThumbSource, page: number, width: number): Promise<string> {
  const key = "proposalId" in source ? `${source.proposalId}:${source.side}#${page}@${width}` : `${source.artifactId}@${source.revision}#${page}@${width}`;
  return remember(images, key, async () => {
    const document = "proposalId" in source ? (await proposalTexts(source.proposalId))[source.side === "base" ? 0 : 1] : await revisionText(source.artifactId, source.revision);
    renderer ??= new Renderer();
    return renderer.render(source.artifactId, document, page, width);
  });
}

/** A thumbnail image URL, null while it is drawn, or an error message. */
export function useDesignThumb(source: ThumbSource | null, page: number, width: number) {
  const key = source ? JSON.stringify([source, page, width]) : "";
  const [result, setResult] = useState<{ key: string; url: string | null; error: string | null }>({ key: "", url: null, error: null });
  useEffect(() => {
    if (!source) return;
    let active = true;
    designThumb(source, page, width).then(
      (url) => active && setResult({ key, url, error: null }),
      (error: Error) => active && setResult({ key, url: null, error: error.message }),
    );
    return () => {
      active = false;
    };
    // The key covers every input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return result.key === key ? result : { url: null, error: null };
}

type Json = Record<string, unknown>;
type DesignObject = Json & { id?: string; type?: string; text?: string };

export type DesignChange = {
  kind: "added" | "removed" | "text" | "moved" | "style" | "page-added" | "page-removed" | "background";
  page: number;
  label: string;
  /** Before → after of a text change. */
  detail?: string;
};

const GEOMETRY = new Set(["left", "top", "width", "height", "scaleX", "scaleY", "angle", "flipX", "flipY", "skewX", "skewY"]);
const KIND_LABEL: Record<DesignChange["kind"], string> = {
  added: "추가",
  removed: "삭제",
  text: "글자",
  moved: "위치·크기",
  style: "모양",
  "page-added": "페이지 추가",
  "page-removed": "페이지 삭제",
  background: "배경",
};

export const changeKindLabel = (kind: DesignChange["kind"]) => KIND_LABEL[kind];

function parse(text: string): { pages: (Json & { id?: string; objects?: DesignObject[]; background?: unknown })[] } | null {
  try {
    const value = JSON.parse(text) as Json;
    return Array.isArray(value.pages) ? (value as never) : null;
  } catch {
    return null;
  }
}

function flatten(objects: DesignObject[] | undefined, out = new Map<string, DesignObject>()) {
  for (const object of objects ?? []) {
    if (typeof object.id === "string") out.set(object.id, object);
    if (Array.isArray(object.objects)) flatten(object.objects as DesignObject[], out);
  }
  return out;
}

const KIND_NAME: Record<string, string> = { textbox: "글자", text: "글자", itext: "글자", rect: "사각형", ellipse: "타원", circle: "원", image: "이미지", path: "도형", line: "선", group: "그룹", polygon: "다각형", triangle: "삼각형" };

function describe(object: DesignObject) {
  const kind = KIND_NAME[String(object.type).toLowerCase()] ?? String(object.type);
  const words = typeof object.text === "string" ? ` "${object.text.replace(/\s+/g, " ").slice(0, 24)}"` : "";
  return `${kind}${words}`;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What changed between two versions of a design, object by object (ids are stable across edits). */
export function designChanges(beforeText: string, afterText: string): DesignChange[] | null {
  const before = parse(beforeText);
  const after = parse(afterText);
  if (!before || !after) return null;
  const changes: DesignChange[] = [];
  const beforePages = new Map(before.pages.map((page, index) => [String(page.id), { page, index }]));
  after.pages.forEach((page, index) => {
    const previous = beforePages.get(String(page.id));
    if (!previous) {
      changes.push({ kind: "page-added", page: index, label: `${index + 1}쪽` });
      return;
    }
    if (!same(previous.page.background, page.background)) changes.push({ kind: "background", page: index, label: `${index + 1}쪽 배경` });
    const old = flatten(previous.page.objects);
    const now = flatten(page.objects);
    for (const [id, object] of now) {
      const was = old.get(id);
      if (!was) {
        changes.push({ kind: "added", page: index, label: describe(object) });
        continue;
      }
      if (was.text !== object.text) {
        changes.push({ kind: "text", page: index, label: describe(was), detail: `${String(was.text ?? "")} → ${String(object.text ?? "")}` });
      }
      const keys = new Set([...Object.keys(was), ...Object.keys(object)].filter((key) => key !== "text" && key !== "objects"));
      let moved = false;
      let styled = false;
      for (const key of keys) {
        if (same(was[key], object[key])) continue;
        if (GEOMETRY.has(key)) moved = true;
        else styled = true;
      }
      if (moved) changes.push({ kind: "moved", page: index, label: describe(object) });
      if (styled) changes.push({ kind: "style", page: index, label: describe(object) });
    }
    for (const [id, object] of old) if (!now.has(id)) changes.push({ kind: "removed", page: index, label: describe(object) });
  });
  const afterIds = new Set(after.pages.map((page) => String(page.id)));
  for (const [id, { index }] of beforePages) if (!afterIds.has(id)) changes.push({ kind: "page-removed", page: index, label: `${index + 1}쪽` });
  return changes;
}

/** The page to show for a set of changes: the first one that changed. */
export function firstChangedPage(changes: DesignChange[] | null) {
  return changes?.find((change) => change.kind !== "page-removed")?.page ?? 0;
}
