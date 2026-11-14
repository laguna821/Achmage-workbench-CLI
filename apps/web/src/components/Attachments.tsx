import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { artifactCacheKey, type Attachment } from "@workbench/contracts";
import { decodeMarkdownImage } from "../../../../vendor/paseo/image-decoding/image-decoding.ts";
import { attachmentHostId, retainAttachmentUrl } from "../api.ts";
import { collectImageFilesFromClipboardData } from "../../../../vendor/paseo/mobile-web/clipboard-images.ts";
import { isRasterImageFile } from "../../../../vendor/paseo/mobile-web/file-types.ts";
import { canShareFile, downloadAttachment, pickedFiles, shareableFile, shareFile } from "../mobile-platform.ts";
import { Popover } from "./Popover.tsx";
import { Icon } from "./Icon.tsx";
import "../styles/attachments.css";

/** A file on its way into the next request: shown at once, sent once the gateway has it. */
export type PendingFile = {
  key: string;
  name: string;
  size: number;
  /** Local thumbnail of a picture (an object URL, revoked when the chip goes). */
  preview: string | null;
  attachment: Attachment | null;
  error: string | null;
  canRetry?: boolean;
};

/** Pictures both engines take as images. */
export const isPicture = (mime: string) => /^image\/(png|jpeg|webp|gif)$/.test(mime);

/** The gateway keeps up to 25 MB per file. */
export const MAX_FILE = 25 * 1024 * 1024;

export function sizeText(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * Files a paste carries, unless it is text: copying from Word or a web page also puts a picture of
 * the selection on the clipboard, and then the text is what was meant.
 */
export function pastedFiles(data: DataTransfer) {
  if (data.getData("text/plain").trim()) return [];
  const files = Array.from(data.files);
  return files.length ? files : collectImageFilesFromClipboardData(data).map(entry => entry.file);
}

type PendingGroup = {
  files: PendingFile[];
  uploads: Map<string, Promise<Attachment | null>>;
  sources: Map<string, File>;
  listeners: Set<() => void>;
};
const pendingGroups = new Map<string, PendingGroup>();
const pendingPrefix = "workbench.draft-attachments.";
function pendingGroup(scope: string): PendingGroup {
  const existing = pendingGroups.get(scope);
  if (existing) return existing;
  let files: PendingFile[] = [];
  try {
    const saved = JSON.parse(localStorage.getItem(pendingPrefix + scope) ?? "[]") as PendingFile[];
    if (Array.isArray(saved)) files = saved.filter(item => item && typeof item.key === "string" && typeof item.name === "string" && Number.isFinite(item.size)).map(item => ({
      key: item.key, name: item.name, size: item.size, preview: null,
      attachment: item.attachment && typeof item.attachment.id === "string" ? item.attachment : null,
      error: item.attachment ? null : "업로드가 중단되었습니다. 파일을 다시 선택해 주세요.",
    }));
  } catch { /* A disabled browser store does not stop the active draft. */ }
  const group: PendingGroup = { files, uploads: new Map(), sources: new Map(), listeners: new Set() };
  pendingGroups.set(scope, group);
  return group;
}
function publishPending(scope: string, group: PendingGroup) {
  try {
    if (group.files.length) localStorage.setItem(pendingPrefix + scope, JSON.stringify(group.files.map(({ preview: _, canRetry: __, ...entry }) => entry)));
    else localStorage.removeItem(pendingPrefix + scope);
  } catch { /* Files remain available in this tab; no new database or file-byte copy. */ }
  for (const notify of group.listeners) notify();
}

/**
 * Files for the next request. Each uploads as soon as it is pasted or dropped; `take` waits for the
 * uploads still running and hands over the files that made it (a failed one stays, its chip says so).
 * Each exact input/host owns a list. Only uploaded references survive browser suspension/reload.
 */
export function usePendingFiles(upload: (file: File) => Promise<Attachment | null>, scope: string) {
  const storageScope = JSON.stringify([attachmentHostId(), scope]);
  const group = pendingGroup(storageScope);
  const files = useSyncExternalStore(listener => {
    group.listeners.add(listener);
    return () => group.listeners.delete(listener);
  }, () => group.files);
  const start = (entry: PendingFile, file: File) => {
    const uploading = upload(file).catch(() => null).then(attachment => {
      group.files = group.files.map(item => item.key === entry.key ? { ...item, attachment, error: attachment ? null : "올리지 못했습니다. 연결 후 다시 시도해 주세요.", canRetry: !attachment } : item);
      group.uploads.delete(entry.key);
      if (attachment) group.sources.delete(entry.key);
      publishPending(storageScope, group);
      return attachment;
    });
    group.uploads.set(entry.key, uploading);
  };
  const add = (list: File[]) => {
    const added = pickedFiles(list).map((file) => ({
      file,
      entry: {
        key: crypto.randomUUID(),
        name: file.name || "붙여넣은 그림.png",
        size: file.size,
        preview: isRasterImageFile(file) && isPicture(file.type) ? URL.createObjectURL(file) : null,
        attachment: null,
        error: file.size > MAX_FILE ? `25MB보다 큽니다 (${sizeText(file.size)})` : null,
      } satisfies PendingFile,
    }));
    group.files = [...group.files, ...added.map(({ entry }) => entry)];
    publishPending(storageScope, group);
    for (const { file, entry } of added) {
      if (entry.error) continue;
      group.sources.set(entry.key, file);
      start(entry, file);
    }
  };
  const remove = (keys?: string[]) => {
    for (const item of keys ? group.files.filter(entry => keys.includes(entry.key)) : group.files) {
      if (item.preview) URL.revokeObjectURL(item.preview);
      group.uploads.delete(item.key);
      group.sources.delete(item.key);
    }
    group.files = keys ? group.files.filter(entry => !keys.includes(entry.key)) : [];
    publishPending(storageScope, group);
  };
  const retry = (key: string) => {
    const entry = group.files.find(item => item.key === key), file = group.sources.get(key);
    if (!entry || !file || group.uploads.has(key)) return;
    group.files = group.files.map(item => item.key === key ? { ...item, error: null, canRetry: false } : item);
    publishPending(storageScope, group);
    start(entry, file);
  };
  const take = async () => {
    const sending = group.files.filter(item => !item.error);
    const ready = await Promise.all(sending.map(async item => ({ key: item.key, attachment: await (group.uploads.get(item.key) ?? Promise.resolve(item.attachment)) })));
    const carried = ready.map(item => item.attachment).filter((attachment): attachment is Attachment => Boolean(attachment));
    return { carried, done: () => remove(ready.filter(item => item.attachment).map(item => item.key)) };
  };
  return { files, add, remove, retry, take, count: files.filter(item => !item.error).length };
}

/** Chips above the input: a thumbnail or the file's name, with a spinner while it uploads. */
export function PendingFiles({ files, onRemove, onRetry }: { files: PendingFile[]; onRemove: (key: string) => void; onRetry?: (key: string) => void }) {
  return (
    <>
      {files.map((file) => (
        <span key={file.key} className="attach-pending">
        <span className={`attach-chip${file.error ? " failed" : ""}`} title={file.error ?? `${file.name} · ${sizeText(file.size)}`}>
          {file.preview ? <img src={file.preview} alt="" /> : <Icon name="file" size={13} />}
          <span className="attach-name">{file.name}</span>
          {file.error ? <span className="attach-size">올리지 못함</span> : !file.attachment ? <span className="spinner small" aria-label="올리는 중" /> : <span className="attach-size">{sizeText(file.size)}</span>}
          {file.canRetry && onRetry ? <button type="button" onClick={() => onRetry(file.key)} aria-label={`${file.name} 업로드 다시 시도`}>재시도</button> : null}
          <button type="button" onClick={() => onRemove(file.key)} aria-label={`${file.name} 빼기`}>
            <Icon name="x" size={11} />
          </button>
        </span>
        {file.error ? <span className="attach-pending-error" role="status">{file.error}</span> : null}
        </span>
      ))}
    </>
  );
}

/** What a request carried: pictures as thumbnails (click for the whole picture), other files by name. */
export function AttachmentStrip({ attachments }: { attachments: Attachment[] }) {
  const [shown, setShown] = useState<number | null>(null);
  const pictures = attachments.filter(attachment => isPicture(attachment.mime));
  return (
    <div className="attach-strip">
      {attachments.map((attachment) =>
        isPicture(attachment.mime) ? (
          <Thumb key={attachment.id} attachment={attachment} onOpen={() => setShown(pictures.indexOf(attachment))} />
        ) : (
          <AttachmentFile key={attachment.id} attachment={attachment} />
        ),
      )}
      {shown !== null && pictures[shown] ? <Lightbox attachments={pictures} index={shown} onSelect={setShown} onClose={() => setShown(null)} /> : null}
    </div>
  );
}

function AttachmentFile({ attachment }: { attachment: Attachment }) {
  const [open, setOpen] = useState(false);
  const [host] = useState(attachmentHostId);
  return <span className="attach-file">
    <button type="button" className="attach-chip attach-file-button" title={attachment.name} aria-label={`${attachment.name} 받기 또는 공유`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Icon name="file" size={13} /><span className="attach-name">{attachment.name}</span><span className="attach-size">{sizeText(attachment.size)}</span><Icon name="download" size={14} />
    </button>
    <Popover open={open} onClose={() => setOpen(false)} role="dialog" label={attachment.name} className="attach-file-menu">
      <span className="attach-file-title">{attachment.name}</span>
      <FileActions attachment={attachment} host={host} />
    </Popover>
  </span>;
}

/** Prepare under the immutable host/reference before the final share/save click. */
function FileActions({ attachment, host }: { attachment: Attachment; host: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [sharing, setSharing] = useState(false);
  const identity = attachment.reference ? artifactCacheKey(attachment.reference) : "local";
  useEffect(() => {
    let live = true;
    setFile(null); setProblem(null);
    const lease = retainAttachmentUrl(attachment.id, identity, attachment.reference?.hostId ?? host, host);
    void lease.promise.then(url => shareableFile(url, attachment.name, attachment.mime)).then(value => {
      if (live) setFile(value);
    }).catch(error => { if (live) setProblem(error instanceof Error ? error.message : "파일을 불러오지 못했습니다."); });
    return () => { live = false; lease.release(); };
  }, [attachment.id, attachment.name, attachment.mime, identity, host, attempt]);
  const share = () => {
    if (!file || sharing) return;
    setSharing(true); setProblem(null);
    void shareFile(file).catch(error => {
      if (!(error instanceof Error && error.name === "AbortError")) setProblem(error instanceof Error ? error.message : "공유하지 못했습니다. 파일 받기를 이용해 주세요.");
    }).finally(() => setSharing(false));
  };
  return <span className="attach-file-actions">
    {!file && !problem ? <span role="status">파일을 준비하는 중…</span> : null}
    <span className="attach-file-buttons">
      <button type="button" disabled={!file} onClick={() => {
        if (!file) return;
        try { downloadAttachment(file); } catch (error) { setProblem(error instanceof Error ? error.message : "파일을 저장하지 못했습니다."); }
      }}><Icon name="download" size={15} /> 파일 받기</button>
      <button type="button" disabled={!file || !canShareFile(file) || sharing} onClick={share}>{sharing ? "공유 창 여는 중…" : "공유…"}</button>
    </span>
    {file && !canShareFile(file) ? <small>이 브라우저에서는 파일 공유를 지원하지 않습니다. 파일 받기를 이용해 주세요.</small> : null}
    {problem ? <span className="attach-file-error" role="alert">{problem}{!file ? <button type="button" onClick={() => setAttempt(value => value + 1)}>다시 불러오기</button> : null}</span> : null}
  </span>;
}

function useImage(attachment: Attachment, active = true) {
  const [url, setUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const identity = attachment.reference ? artifactCacheKey(attachment.reference) : "local";
  const [host] = useState(attachmentHostId);
  useEffect(() => {
    setUrl(null); setProblem(null);
    if (!active) return;
    let live = true;
    const lease = retainAttachmentUrl(attachment.id, identity, attachment.reference?.hostId ?? host, host);
    lease.promise.then(async value => {
      if (!live) return;
      try {
        // Keep the same blob lease while Paseo checks that the browser can display it.
        await decodeMarkdownImage(value, (uri, success, failure) => {
          const image = new Image();
          image.src = uri;
          void image.decode().then(() => success(image.naturalWidth, image.naturalHeight), failure);
        });
        if (live) setUrl(value);
      } catch {
        if (live) setProblem("그림을 표시하지 못했습니다");
      }
    }).catch(error => { if (live) setProblem(error instanceof Error ? error.message : "그림을 불러오지 못했습니다"); });
    return () => { live = false; lease.release(); };
  }, [attachment.id, identity, active, attempt, host]);
  return { url, problem, retry: () => setAttempt(value => value + 1), failed: () => setProblem("그림을 표시하지 못했습니다") };
}

/** Near enough to load (400px around the scroller, or the window): from the layout itself. */
const NEAR = 400;
function nearView(element: Element, root: Element | null) {
  if (!element.isConnected) return false;
  const box = element.getBoundingClientRect();
  if (!box.width && !box.height) return false;
  const area = root ? root.getBoundingClientRect() : { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth };
  return box.bottom >= area.top - NEAR && box.top <= area.bottom + NEAR && box.right >= area.left - NEAR && box.left <= area.right + NEAR;
}

function Thumb({ attachment, onOpen }: { attachment: Attachment; onOpen: () => void }) {
  const container = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  // The observer alone sometimes never reported a thumbnail in view (it stayed "그림", U38). The
  // layout is also read: once mounted, when the transcript scrolls or changes size, and once more
  // shortly after; the observer watches the transcript's scroller, its real root.
  useEffect(() => {
    const element = container.current;
    if (typeof IntersectionObserver === "undefined" || !element) return;
    const root = element.closest(".transcript");
    const check = () => setVisible(nearView(element, root));
    const observer = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting) || nearView(element, root)), { root, rootMargin: `${NEAR}px` });
    observer.observe(element);
    let frame = 0;
    const soon = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; check(); }); };
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(soon);
    if (root) resized?.observe(root);
    (root ?? window).addEventListener("scroll", soon, { passive: true });
    check();
    const later = window.setTimeout(check, 1000);
    return () => { observer.disconnect(); resized?.disconnect(); (root ?? window).removeEventListener("scroll", soon); cancelAnimationFrame(frame); window.clearTimeout(later); };
  }, []);
  const image = useImage(attachment, visible);
  return (
    <span className="attach-preview" ref={container} data-state={image.problem ? "error" : image.url ? "ready" : "loading"}>
      <button type="button" className="attach-thumb" onClick={onOpen} title={attachment.name} aria-label={`${attachment.name} 크게 보기`} aria-haspopup="dialog" aria-busy={!image.url && !image.problem} disabled={!image.url || !!image.problem}>
        {image.url && !image.problem ? <img src={image.url} alt={attachment.name} onError={image.failed} decoding="async" /> : <span className="attach-thumb-wait" role="status">{image.problem ? <><Icon name="image" size={22} /><span>{image.problem}</span></> : <><span className="spinner" aria-hidden /><span>{visible ? "그림 불러오는 중…" : "그림"}</span></>}</span>}
      </button>
      {image.problem ? <button type="button" className="text-button attach-retry" onClick={image.retry} title={image.problem}>다시 불러오기</button> : null}
    </span>
  );
}

/** Inline Markdown images use the immutable message capture, never an arbitrary file URL. */
export function MessageImage({ attachment, gallery }: { attachment: Attachment; gallery: Attachment[] }) {
  const [shown, setShown] = useState<number | null>(null);
  const pictures = gallery.length ? gallery : [attachment];
  return <span className="message-image"><Thumb attachment={attachment} onOpen={() => setShown(Math.max(0, pictures.findIndex(picture => picture.id === attachment.id)))} />
    {shown !== null ? <Lightbox attachments={pictures} index={shown} onSelect={setShown} onClose={() => setShown(null)} /> : null}</span>;
}

/** The gallery retains its own blob while the source thumbnail scrolls out of view. */
function Lightbox({ attachments, index, onSelect, onClose }: { attachments: Attachment[]; index: number; onSelect(index: number): void; onClose(): void }) {
  const attachment = attachments[index]!;
  const image = useImage(attachment);
  const close = useRef<HTMLButtonElement>(null);
  const [host] = useState(attachmentHostId);
  useEffect(() => {
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    close.current?.focus(); return () => { document.body.style.overflow = overflow; if (origin?.isConnected) origin.focus(); };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!["Escape", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft") onSelect((index + attachments.length - 1) % attachments.length);
      if (event.key === "ArrowRight") onSelect((index + 1) % attachments.length);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, onSelect, index, attachments.length]);
  return createPortal(
    <div className="attach-lightbox" role="dialog" aria-modal="true" aria-label={attachment.name} onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={event => {
      if (event.key !== "Tab") return;
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled]), a[href]')], first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <header><span>{attachment.name} · {index + 1}/{attachments.length}{attachment.reference ? " · 답변 당시 그림" : ""}</span>
        <button ref={close} type="button" onClick={onClose} aria-label="그림 닫기"><Icon name="x" /></button></header>
      <div className="attach-gallery-image">{image.url && !image.problem ? <img src={image.url} alt={attachment.name} onError={image.failed} /> : <p role={image.problem ? "alert" : "status"}>{image.problem ?? "그림을 불러오는 중…"}{image.problem ? <button type="button" onClick={image.retry}>다시 불러오기</button> : null}</p>}</div>
      <footer><button type="button" disabled={attachments.length < 2} onClick={() => onSelect((index + attachments.length - 1) % attachments.length)}>이전 그림</button>
        <FileActions key={attachment.reference ? artifactCacheKey(attachment.reference) : attachment.id} attachment={attachment} host={host} />
        <button type="button" disabled={attachments.length < 2} onClick={() => onSelect((index + 1) % attachments.length)}>다음 그림</button></footer>
    </div>,
    document.body,
  );
}
