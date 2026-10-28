import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Attachment } from "@workbench/contracts";
import { attachmentUrl } from "../api.ts";
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
      const uploading = upload(file).then((attachment) => {
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
  const [shown, setShown] = useState<{ url: string; name: string } | null>(null);
  return (
    <div className="attach-strip">
      {attachments.map((attachment) =>
        isPicture(attachment.mime) ? (
          <Thumb key={attachment.id} attachment={attachment} onOpen={(url) => setShown({ url, name: attachment.name })} />
        ) : (
          <span key={attachment.id} className="attach-chip" title={attachment.name}>
            <Icon name="file" size={13} />
            <span className="attach-name">{attachment.name}</span>
            <span className="attach-size">{sizeText(attachment.size)}</span>
          </span>
        ),
      )}
      {shown ? <Lightbox url={shown.url} name={shown.name} onClose={() => setShown(null)} /> : null}
    </div>
  );
}

function Thumb({ attachment, onOpen }: { attachment: Attachment; onOpen: (url: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let live = true;
    attachmentUrl(attachment.id)
      .then((value) => live && setUrl(value))
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [attachment.id]);
  return (
    <button type="button" className="attach-thumb" onClick={() => url && onOpen(url)} title={attachment.name} aria-label={`${attachment.name} 크게 보기`} disabled={!url}>
      {url ? <img src={url} alt={attachment.name} /> : <span className="attach-thumb-wait">{missing ? "그림 없음" : ""}</span>}
    </button>
  );
}

/** The whole picture over everything; Esc or a click closes it (and Esc does nothing else). */
function Lightbox({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="attach-lightbox" role="dialog" aria-label={name} onClick={onClose}>
      <img src={url} alt={name} />
    </div>,
    document.body,
  );
}
