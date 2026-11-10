import { useState, type ReactNode } from "react";
import { Icon } from "./Icon.tsx";
import { Segmented } from "./ui/Hig.tsx";

/** The same single entry on home and a blank web tab. Ask supplies the normal task composer. */
export function BrowseStart({ onSearch, children, disabled = false, autoFocus = false, initialMode = "search" }: {
  onSearch?: (address: string) => Promise<boolean>;
  children: ReactNode;
  disabled?: boolean;
  autoFocus?: boolean;
  initialMode?: "search" | "ask";
}) {
  const [mode, setMode] = useState<"search" | "ask">(onSearch ? initialMode : "ask");
  return <div className="browse-start" data-mode={mode}>
    {onSearch ? <Segmented tabs className="browse-start-modes" label="시작 모드" value={mode} onChange={setMode} options={[{ value: "search", label: "Search" }, { value: "ask", label: "Ask" }]} /> : null}
    <div className="browse-entry">{mode === "search" && onSearch ? <BrowserSearch onOpen={onSearch} disabled={disabled} autoFocus={autoFocus} /> : children}</div>
  </div>;
}

export function BrowserSearch({ onOpen, disabled = false, autoFocus = false }: { onOpen: (address: string) => Promise<boolean>; disabled?: boolean; autoFocus?: boolean }) {
  const [address, setAddress] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <>
    <form className="browser-search" role="search" aria-label="웹 검색" onSubmit={event => {
      event.preventDefault(); if (busy || disabled) return;
      setBusy(true); setError("");
      void onOpen(address).then(ok => { if (ok) setAddress(""); }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false));
    }}><Icon name="search" size={20} /><input autoFocus={autoFocus} aria-label="웹 검색 또는 주소" placeholder="검색어 또는 웹 주소 입력" type="text" autoCapitalize="none" spellCheck={false} value={address} disabled={disabled || busy} onChange={event => setAddress(event.target.value)} /><button type="submit" className="hk-btn hk-btn--filled browser-search-go" aria-label={busy ? "여는 중" : "열기"} disabled={disabled || busy || !address.trim()}><Icon name="arrowRight" size={18} /></button></form>
    {error ? <p className="browser-error" role="alert">{error}</p> : null}
  </>;
}
