import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { artifactCacheKey, type Attachment } from "@workbench/contracts";
import { retainAttachmentUrl } from "../api.ts";
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
  return Array.from(data.files);
}

/**
 * Files for the next request. Each uploads as soon as it is pasted or dropped; `take` waits for the
 * uploads still running and hands over the files that made it (a failed one stays, its chip says so).
 * The list empties when `scope` changes (another work or document).
 */
export function usePendingFiles(upload: (file: File) => Promise<Attachment | null>, scope: string) {
  const [files, setFiles] = useState<PendingFile[]>([]);
  const uploads = useRef(new Map<string, Promise<Attachment | null>>());
  const add = (list: File[]) => {
    const added = list.map((file) => ({
      file,
      entry: {
        key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: file.name || "붙여넣은 그림.png",
        size: file.size,
        preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
        attachment: null,
        error: file.size > MAX_FILE ? `25MB보다 큽니다 (${sizeText(file.size)})` : null,
      } satisfies PendingFile,
    }));
    setFiles((current) => [...current, ...added.map(({ entry }) => entry)]);
    for (const { file, entry } of added) {
      if (entry.error) continue;
      const uploading = upload(file).catch(() => null).then((attachment) => {
        setFiles((current) => current.map((item) => (item.key === entry.key ? { ...item, attachment, error: attachment ? null : "올리지 못했습니다" } : item)));
        return attachment;
      });
      uploads.current.set(entry.key, uploading);
    }
  };
  const remove = (keys?: string[]) => {
    setFiles((current) => {
      for (const item of keys ? current.filter((entry) => keys.includes(entry.key)) : current) {
        if (item.preview) URL.revokeObjectURL(item.preview);
        uploads.current.delete(item.key);
      }
      return keys ? current.filter((entry) => !keys.includes(entry.key)) : [];
    });
  };
  useEffect(() => () => remove(), [scope]);
  const take = async () => {
    const sending = files.filter((item) => !item.error);
    const carried = (await Promise.all(sending.map((item) => uploads.current.get(item.key) ?? Promise.resolve(item.attachment)))).filter(
      (attachment): attachment is Attachment => Boolean(attachment),
    );
    return { carried, done: () => remove(sending.map((item) => item.key)) };
  };
  return { files, add, remove, take, count: files.filter((item) => !item.error).length };
}

/** Chips above the input: a thumbnail or the file's name, with a spinner while it uploads. */
export function PendingFiles({ files, onRemove }: { files: PendingFile[]; onRemove: (key: string) => void }) {
  return (
    <>
      {files.map((file) => (
        <span key={file.key} className={`attach-chip${file.error ? " failed" : ""}`} title={file.error ?? `${file.name} · ${sizeText(file.size)}`}>
          {file.preview ? <img src={file.preview} alt="" /> : <Icon name="file" size={13} />}
          <span className="attach-name">{file.name}</span>
          {file.error ? <span className="attach-size">올리지 못함</span> : !file.attachment ? <span className="spinner small" aria-label="올리는 중" /> : <span className="attach-size">{sizeText(file.size)}</span>}
          <button type="button" onClick={() => onRemove(file.key)} aria-label={`${file.name} 빼기`}>
            <Icon name="x" size={11} />
          </button>
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
          <span key={attachment.id} className="attach-chip" title={attachment.name}>
            <Icon name="file" size={13} />
            <span className="attach-name">{attachment.name}</span>
            <span className="attach-size">{sizeText(attachment.size)}</span>
          </span>
        ),
      )}
      {shown !== null && pictures[shown] ? <Lightbox attachments={pictures} index={shown} onSelect={setShown} onClose={() => setShown(null)} /> : null}
    </div>
  );
}

function useImage(attachment: Attachment, active = true) {
  const [url, setUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const identity = attachment.reference ? artifactCacheKey(attachment.reference) : "local";
  useEffect(() => {
    setUrl(null); setProblem(null);
    if (!active) return;
    let live = true;
    const lease = retainAttachmentUrl(attachment.id, identity);
    lease.promise.then(value => { if (live) setUrl(value); }).catch(error => { if (live) setProblem(error instanceof Error ? error.message : "그림을 불러오지 못했습니다"); });
    return () => { live = false; lease.release(); };
  }, [attachment.id, identity, active, attempt]);
  return { url, problem, retry: () => setAttempt(value => value + 1), failed: () => setProblem("그림을 표시하지 못했습니다") };
}

function Thumb({ attachment, onOpen }: { attachment: Attachment; onOpen: () => void }) {
  const container = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || !container.current) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)), { rootMargin: "400px" });
    observer.observe(container.current); return () => observer.disconnect();
  }, []);
  const image = useImage(attachment, visible);
  return (
    <span className="attach-preview" ref={container}>
      <button type="button" className="attach-thumb" onClick={onOpen} title={attachment.name} aria-label={`${attachment.name} 크게 보기`} disabled={!image.url || !!image.problem}>
        {image.url && !image.problem ? <img src={image.url} alt={attachment.name} onError={image.failed} decoding="async" /> : <span className="attach-thumb-wait">{image.problem ? "그림 없음" : visible ? "불러오는 중…" : "그림"}</span>}
      </button>
      {image.problem ? <button type="button" className="text-button attach-retry" onClick={image.retry} title={image.problem}>다시 불러오기</button> : null}
    </span>
  );
}

/** Inline Markdown images use the immutable message capture, never an arbitrary file URL. */
export function MessageImage({ attachment, gallery }: { attachment: Attachment; gallery: Attachment[] }) {
  const [shown, setShown] = useState<number | null>(null);
  return <span className="message-image"><Thumb attachment={attachment} onOpen={() => setShown(Math.max(0, gallery.indexOf(attachment)))} />
    {shown !== null ? <Lightbox attachments={gallery} index={shown} onSelect={setShown} onClose={() => setShown(null)} /> : null}</span>;
}

/** The gallery retains its own blob while the source thumbnail scrolls out of view. */
function Lightbox({ attachments, index, onSelect, onClose }: { attachments: Attachment[]; index: number; onSelect(index: number): void; onClose(): void }) {
  const attachment = attachments[index]!;
  const image = useImage(attachment);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current?.focus(); return () => { if (origin?.isConnected) origin.focus(); };
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
      <div className="attach-gallery-image">{image.url && !image.problem ? <img src={image.url} alt={attachment.name} onError={image.failed} /> : <p>{image.problem ?? "그림을 불러오는 중…"}{image.problem ? <button type="button" onClick={image.retry}>다시 불러오기</button> : null}</p>}</div>
      <footer><button type="button" disabled={attachments.length < 2} onClick={() => onSelect((index + attachments.length - 1) % attachments.length)}>이전 그림</button>
        {image.url ? <a href={image.url} download={attachment.name}>이 그림 저장</a> : null}
        <button type="button" disabled={attachments.length < 2} onClick={() => onSelect((index + 1) % attachments.length)}>다음 그림</button></footer>
    </div>,
    document.body,
  );
}
