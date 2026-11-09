import { useEffect, useRef, useState } from "react";
import { TerminalEmulatorRuntime, type TerminalFindResult } from "@workbench/paseo-terminal/emulator";
import { TerminalStreamController } from "@workbench/paseo-terminal/controller";
import { dispatchTerminalKeyInput, createTerminalKeyInput, EMPTY_TERMINAL_KEY_MODIFIERS, type TerminalKeyModifierState } from "@workbench/paseo-terminal/keys";
import { getTerminalVirtualKeyboardControlId, resolveTerminalVirtualKeyboardRows } from "@workbench/paseo-terminal/virtual-keyboard";
import { WorkbenchTerminalClient } from "../../../../packages/client/src/terminal.ts";
import type { TerminalSession } from "@workbench/contracts";
import type { Api } from "../api.ts";
import type { TabUiState } from "../panes.ts";
import { terminalStatus } from "./TerminalDialog.tsx";
import "@workbench/paseo-terminal/xterm.css";
import "../styles/terminal.css";

export default function TerminalView({ api, id, focused, onList, uiState, onUiState }: { api: Api; id: string; focused: boolean; onList: () => void; uiState?: TabUiState; onUiState?: (state: TabUiState) => void }) {
  const element = useRef<HTMLDivElement>(null), findInput = useRef<HTMLInputElement>(null);
  const runtime = useRef<TerminalEmulatorRuntime | null>(null), client = useRef<WorkbenchTerminalClient | null>(null);
  const callbacks = useRef({ onUiState, focused }); callbacks.current = { onUiState, focused };
  const initialUi = useRef(uiState), metadata = useRef<TerminalSession | null>(null);
  const [entry, setEntry] = useState<TerminalSession | null>(null), [error, setError] = useState("");
  const [find, setFind] = useState(false), [query, setQuery] = useState(""), [regex, setRegex] = useState(false), [caseSensitive, setCaseSensitive] = useState(false), [found, setFound] = useState<TerminalFindResult | null>(null);
  const [truncated, setTruncated] = useState(false), [busy, setBusy] = useState(false), [confirmClose, setConfirmClose] = useState(false);
  const [ready, setReady] = useState(false), [connected, setConnected] = useState(false), [canWrite, setCanWrite] = useState(false);
  const [modifiers, setModifiers] = useState<TerminalKeyModifierState>({ ...EMPTY_TERMINAL_KEY_MODIFIERS }), [width, setWidth] = useState(500), [keyBar, setKeyBar] = useState(false);
  useEffect(() => {
    const host = element.current; if (!host) return;
    let gone = false, restored = false, writable = false, online = false, scrolling: ReturnType<typeof setTimeout> | undefined;
    setReady(false); setEntry(null); setError(""); setTruncated(false); setCanWrite(false); setConnected(false);
    const emulator = new TerminalEmulatorRuntime(); runtime.current = emulator;
    const showError = (reason: unknown) => { if (!gone) setError(reason instanceof Error ? reason.message : String(reason)); };
    const updateInput = () => { const terminal = emulator.getTerminal(); if (terminal) terminal.options.disableStdin = !(restored && writable && online && metadata.current?.status === "running"); };
    const transport = new WorkbenchTerminalClient(api, {
      onMetadata(value) { if (gone) return; metadata.current = value; setEntry(value); updateInput(); },
      onTruncated() { if (!gone) setTruncated(true); },
      onConnection(value, reason) { const reconnected = value && !online; online = value; if (!gone) { setConnected(value); if (reason) setError(reason); else setError(""); } updateInput(); if (reconnected && restored && callbacks.current.focused) emulator.resize({ shouldClaim: true, forceClaim: true }); },
      onInputError: showError,
      isVisible: () => document.visibilityState === "visible" && !!host.getClientRects().length,
    });
    client.current = transport;
    const send = (data: string) => {
      if (!restored || !online || !writable || metadata.current?.status !== "running") return;
      emulator.resize({ shouldClaim: true, forceClaim: true });
      transport.sendTerminalInput(id, { type: "input", data });
    };
    emulator.setCallbacks({ callbacks: {
      onInput: send,
      onTerminalKey: keyInput => dispatchTerminalKeyInput({ keyInput, inputMode: emulator.getInputModeState(), sendData: send }),
      onPendingModifiersConsumed: () => setModifiers({ ...EMPTY_TERMINAL_KEY_MODIFIERS }),
      onResize({ rows, cols, shouldClaim, forceClaim }) {
        if (!writable || !restored || !online || metadata.current?.status !== "running") return;
        transport.sendTerminalInput(id, { type: "resize", rows, cols, intent: (shouldClaim || forceClaim) && callbacks.current.focused ? "claim" : "update" });
      },
      onFindRequest: () => setFind(true), onFindResult: setFound,
      onOpenExternalUrl: url => { if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer"); },
    } });
    emulator.mount({ root: host, host, embedded: true, scrollback: 10_000, fontSize: 14,
      fontFamily: '"D2Coding", "DejaVu Sans Mono", Consolas, monospace',
      theme: { background: "#101827", foreground: "#e5edf7", cursor: "#89c3ff", selectionBackground: "#365477" } });
    const terminal = emulator.getTerminal()!; terminal.options.disableStdin = true; terminal.options.screenReaderMode = true;
    const scroll = terminal.onScroll(() => {
      if (!restored) return;
      const buffer = terminal.buffer.active, saved = { line: buffer.viewportY, follow: buffer.viewportY >= buffer.baseY };
      clearTimeout(scrolling); scrolling = setTimeout(() => callbacks.current.onUiState?.({ terminalScroll: saved }), 200);
    });
    const controller = new TerminalStreamController({ client: transport, getPreferredSize: () => null,
      onOutput: ({ data }) => emulator.write({ data }),
      onReplay: ({ replay }) => {
        if (replay.type === "begin") { restored = false; updateInput(); }
        emulator.replay(replay, () => {
          if (gone) return;
          restored = true; setReady(true); updateInput();
          const saved = initialUi.current?.terminalScroll;
          if (saved && !saved.follow) terminal.scrollToLine(saved.line); else terminal.scrollToBottom();
          initialUi.current = undefined;
          if (callbacks.current.focused) { emulator.resize({ shouldClaim: true, forceClaim: true }); if (!findInput.current) emulator.focus(); }
        });
      },
      onStatusChange: status => { if (!gone && status.error && status.error !== "Terminal exited") setError(status.error); },
    });
    void api.terminalCanWrite().then(value => { writable = value; if (!gone) setCanWrite(value); updateInput(); if (restored && online && callbacks.current.focused) emulator.resize({ shouldClaim: true, forceClaim: true }); }).catch(showError);
    controller.setTerminal({ terminalId: id });
    const observer = new ResizeObserver(() => { setWidth(host.clientWidth); }); observer.observe(host);
    return () => { gone = true; clearTimeout(scrolling); observer.disconnect(); scroll.dispose(); controller.dispose(); transport.dispose(); emulator.unmount(); runtime.current = null; client.current = null; };
  }, [api, id]);
  useEffect(() => { runtime.current?.setPendingModifiers({ pendingModifiers: modifiers }); }, [modifiers]);
  useEffect(() => { if (focused && !find) { runtime.current?.focus(); runtime.current?.resize({ shouldClaim: true, forceClaim: true }); } }, [focused, find]);
  useEffect(() => { if (find) findInput.current?.focus(); }, [find]);
  const search = (previous = false) => { try { runtime.current?.find.search(query, previous ? "previous" : "next", { regex, caseSensitive }); } catch { setFound({ resultIndex: -1, resultCount: 0, limited: false, placement: "top" }); } };
  const running = !!entry && ["starting", "running", "stopping"].includes(entry.status), inputAllowed = ready && connected && canWrite && entry?.status === "running";
  const paste = () => { void navigator.clipboard.readText().then(text => runtime.current?.paste(text)).catch(reason => setError(String(reason))); };
  return <section className="terminal-view" data-terminal-id={id} data-terminal-status={entry?.status ?? "loading"} data-terminal-ready={ready} onKeyDown={event => event.stopPropagation()}>
    <header className="terminal-toolbar">
      <strong style={entry?.color ? { borderLeft: `3px solid ${entry.color}`, paddingLeft: 6 } : undefined}>{entry?.label ?? "터미널"}</strong><span className="terminal-status">{entry ? terminalStatus(entry) : "불러오는 중…"}{api.isRemote ? connected ? " · 원격 연결" : " · 다시 연결 중" : ""}</span>
      <span className="terminal-path" title={entry?.cwd}>{entry?.cwd}</span>
      <button className="button small" onClick={() => setFind(!find)}>찾기</button>
      <button className="button small" onClick={() => {
        const terminal = runtime.current?.getTerminal(); if (!terminal) return;
        const buffer = terminal.buffer.active, lines: string[] = [];
        for (let index = Math.max(0, buffer.length - 200); index < buffer.length; index++) lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
        void navigator.clipboard.writeText(terminal.getSelection() || lines.join("\n").slice(-32_000)).catch(reason => setError(String(reason)));
      }}>복사</button>
      <button className="button small" onClick={paste} disabled={!inputAllowed}>붙여넣기</button>
      <button className="button small" aria-pressed={keyBar} onClick={() => setKeyBar(!keyBar)}>보조 키</button>
      <button className="button small terminal-list-open" onClick={onList}>터미널 목록</button>
      <button className="button small danger terminal-stop" disabled={!running || busy || !canWrite} onClick={() => setConfirmClose(true)}>실행 종료</button>
    </header>
    {find ? <form className="terminal-find" onSubmit={event => { event.preventDefault(); search(); }}>
      <input ref={findInput} aria-label="터미널 출력 찾기" value={query} onChange={event => { setQuery(event.target.value); setFound(null); }} onKeyDown={event => { if (event.key === "Escape") { setFind(false); runtime.current?.find.clear(); } }} />
      <label><input type="checkbox" checked={regex} onChange={event => setRegex(event.target.checked)} />정규식</label><label><input type="checkbox" checked={caseSensitive} onChange={event => setCaseSensitive(event.target.checked)} />대소문자</label>
      <button type="button" className="button small" onClick={() => search(true)}>이전</button><button type="submit" className="button small">다음</button>
      <span role="status">{found ? `${found.resultIndex + 1} / ${found.resultCount}${found.limited ? "+" : ""}` : ""}</span>
      <button type="button" className="button small" onClick={() => { setFind(false); runtime.current?.find.clear(); }}>닫기</button>
    </form> : null}
    {truncated ? <div className="terminal-message">로그는 최근 2 MiB를 보관합니다. 이전 출력 일부는 보관 범위를 넘었습니다.</div> : null}
    {!ready ? <div className="terminal-message">출력을 복원하는 중…</div> : null}
    {ready && !canWrite ? <div className="terminal-message">이 연결에서는 출력만 볼 수 있습니다. 터미널 입력 권한은 호스트의 기기 설정에서 관리합니다.</div> : null}
    {error ? <div className="terminal-message error" role="alert">{error}</div> : null}
    {confirmClose ? <div className="terminal-message terminal-stop-confirm" role="alertdialog" aria-label="터미널 실행 종료 확인">
      <span>이 터미널의 셸과 실행 중인 작업을 종료합니다. 출력 기록은 유지됩니다.</span><button className="button small" disabled={busy} onClick={() => setConfirmClose(false)}>취소</button>
      <button className="button small danger" disabled={busy} onClick={async () => { setBusy(true); try { setEntry(await api.closeTerminal(id)); setConfirmClose(false); } catch (reason) { setError(String(reason)); } finally { setBusy(false); } }}>종료 확인</button>
    </div> : null}
    <div className="terminal-surface" ref={element} onPointerDown={() => runtime.current?.resize({ shouldClaim: true, forceClaim: true })} />
    <div className={`terminal-key-bar ${keyBar ? "is-open" : ""}`} aria-label="터미널 보조 키">{resolveTerminalVirtualKeyboardRows({ isCompact: width < 760, availableWidth: width }).map((row, index) => <div className="terminal-key-row" key={index}>{row.map(control => {
      const key = getTerminalVirtualKeyboardControlId(control);
      if (control.type === "modifier") return <button type="button" key={key} disabled={!inputAllowed} aria-pressed={modifiers[control.modifier]} onPointerDown={event => event.preventDefault()} onClick={() => setModifiers(before => ({ ...before, [control.modifier]: !before[control.modifier] }))}>{control.modifier}</button>;
      if (control.type === "paste") return <button type="button" key={key} disabled={!inputAllowed} onClick={paste}>붙여넣기</button>;
      if (control.type === "keyboardToggle") return <button type="button" key={key} disabled={!inputAllowed} onClick={() => runtime.current?.focus({ forceRefocus: true })}>키보드</button>;
      return <button type="button" key={key} disabled={!inputAllowed} onPointerDown={event => event.preventDefault()} onClick={() => {
        const emulator = runtime.current, transport = client.current; if (!emulator || !transport) return;
        emulator.resize({ shouldClaim: true, forceClaim: true });
        dispatchTerminalKeyInput({ keyInput: createTerminalKeyInput({ key: control.button.key, modifiers }), inputMode: emulator.getInputModeState(), sendData: data => transport.sendTerminalInput(id, { type: "input", data }) });
        setModifiers({ ...EMPTY_TERMINAL_KEY_MODIFIERS });
      }}>{control.button.label}</button>;
    })}</div>)}</div>
    {entry && !running ? <footer className="terminal-ended">이전 출력 기록입니다. 명령은 자동으로 다시 실행하지 않습니다.<button className="button small" onClick={onList}>새 터미널 열기</button></footer> : null}
  </section>;
}
