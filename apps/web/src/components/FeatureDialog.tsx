import { useLayoutEffect, useRef, type ReactNode } from "react";
import { IconButton } from "./ui/Hig.tsx";
import { restoreSurfaceFocus } from "./controls/menu-navigation.ts";
import "../styles/optional-features.css";

export function FeatureDialog({ title, description, onClose, children }: { title: string; description: string; onClose(): void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null), opener = useRef(document.activeElement);
  useLayoutEffect(() => { const surface = dialog.current; surface?.showModal(); return () => restoreSurfaceFocus(opener.current, surface); }, []);
  return <dialog ref={dialog} className="feature-dialog" aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><div><h2>{title}</h2><p>{description}</p></div><IconButton icon="x" label={`${title} 닫기`} onClick={onClose} /></header>
    <div className="feature-body">{children}</div>
  </dialog>;
}

export const featureError = (error: unknown) => error instanceof Error ? error.message : String(error);
export const featureTime = (value: number | null) => value === null ? "—" : new Date(value).toLocaleString("ko-KR");
