import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { TerminalSession } from "@workbench/contracts";
import type { Api } from "../api.ts";
import type { TabUiState } from "../panes.ts";
import { terminalStatus } from "./TerminalDialog.tsx";
import "@xterm/xterm/css/xterm.css";
import "../styles/terminal.css";

export default function TerminalView({ api, id, focused, onList, uiState, onUiState }: { api: Api; id: string; focused: boolean; onList: () => void; uiState?: TabUiState; onUiState?: (state: TabUiState) => void }) {
  const element = useRef<HTMLDivElement>(null), findInput = useRef<HTMLInputElement>(null);
  const runtime = useRef<{ terminal: Terminal; search: SearchAddon } | null>(null);
  const callbacks = useRef({ onUiState }); callbacks.current = { onUiState };
  const initialUi = useRef(uiState), metadata = useRef<TerminalSession | null>(null);
  const [entry, setEntry] = useState<TerminalSession | null>(null), [error, setError] = useState("");
  const [find, setFind] = useState(false), [query, setQuery] = useState(""), [regex, setRegex] = useState(false), [caseSensitive, setCaseSensitive] = useState(false), [found, setFound] = useState<boolean | null>(null);
  const [truncated, setTruncated] = useState(false), [busy, setBusy] = useState(false), [confirmClose, setConfirmClose] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!element.current) return;
    let gone = false, cursor = 0, restored = false, polling = 0, scrolling = 0, resizing = 0, lastSize = "";
    const terminal = new Terminal({ cols: 80, rows: 24, cursorBlink: true, scrollback: 10_000, screenReaderMode: true, fontSize: 14, fontFamily: '"D2Coding", "DejaVu Sans Mono", Consolas, monospace', allowProposedApi: true, disableStdin: true, theme: { background: "#101827", foreground: "#e5edf7", cursor: "#89c3ff", selectionBackground: "#365477" } });
    const fit = new FitAddon(), search = new SearchAddon(); terminal.loadAddon(fit); terminal.loadAddon(search); terminal.open(element.current);
    runtime.current = { terminal, search };
    const showError = (error: unknown) => { if (!gone) setError(error instanceof Error ? error.message : String(error)); };
    // Concurrent HTTP requests can arrive out of key order. Keep one ordered input stream.
    let inputQueue = Promise.resolve();
    const input = terminal.onData((data) => {
      const points = Array.from(data);
      for (let offset = 0; offset < points.length; offset += 8192) {
        const chunk = points.slice(offset, offset + 8192).join("");
        inputQueue = inputQueue.then(() => gone ? undefined : api.terminalInput(id, chunk).then(() => undefined)).catch(showError);
      }
    });
    terminal.attachCustomKeyEventHandler((event) => {
      // Terminal control keys belong to the shell/TUI, not the application's global shortcuts.
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        if (event.type === "keydown") { event.preventDefault(); setFind(true); } return false;
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "c") {
        if (event.type === "keydown") { event.preventDefault(); void navigator.clipboard.writeText(terminal.getSelection()).catch(showError); } return false;
      }
      return true;
    });
    const resize = () => {
      if (gone || !element.current?.getClientRects().length) return;
      try {
        fit.fit();
        const key = `${terminal.cols}:${terminal.rows}`;
        if (metadata.current?.status === "running" && key !== lastSize && terminal.cols >= 2 && terminal.rows >= 2) {
          lastSize = key; void api.resizeTerminal(id, terminal.cols, terminal.rows).catch((error) => { lastSize = ""; showError(error); });
        }
      } catch (error) { showError(error); }
    };
    const observer = new ResizeObserver(() => { clearTimeout(resizing); resizing = window.setTimeout(resize, 100); }); observer.observe(element.current);
    const scroll = terminal.onScroll(() => {
      if (!restored) return;
      const buffer = terminal.buffer.active;
      const saved = { line: buffer.viewportY, follow: buffer.viewportY >= buffer.baseY };
      clearTimeout(scrolling); scrolling = window.setTimeout(() => callbacks.current.onUiState?.({ terminalScroll: saved }), 200);
    });
    const poll = async () => {
      try {
        const chunk = await api.terminalOutput(id, cursor); if (gone) return;
        metadata.current = chunk.terminal; setEntry(chunk.terminal);
        terminal.options.disableStdin = !restored || chunk.terminal.status !== "running";
        if (chunk.terminal.error) setError(chunk.terminal.error);
        if (chunk.truncated) { setTruncated(true); if (cursor) terminal.reset(); }
        if (chunk.data) {
          const bytes = Uint8Array.from(atob(chunk.data), (character) => character.charCodeAt(0));
          await new Promise<void>((resolve) => terminal.write(bytes, resolve));
        }
        if (gone) return;
        cursor = chunk.end;
        if (!restored && cursor >= chunk.terminal.outputEnd) {
          restored = true;
          setReady(true); terminal.options.disableStdin = chunk.terminal.status !== "running";
          const saved = initialUi.current?.terminalScroll;
          if (saved && !saved.follow) terminal.scrollToLine(saved.line); else terminal.scrollToBottom();
        }
        resize();
        const visible = !!element.current?.getClientRects().length;
        polling = window.setTimeout(() => void poll(), cursor < chunk.terminal.outputEnd ? 0 : visible && ["running", "starting", "stopping"].includes(chunk.terminal.status) ? 100 : 1500);
      } catch (error) { showError(error); if (!gone) polling = window.setTimeout(() => void poll(), 1500); }
    };
    void poll();
    return () => { gone = true; clearTimeout(polling); clearTimeout(scrolling); clearTimeout(resizing); observer.disconnect(); input.dispose(); scroll.dispose(); runtime.current = null; terminal.dispose(); };
  }, [api, id]);
  useEffect(() => { if (focused && !find) runtime.current?.terminal.focus(); }, [focused, find]);
  useEffect(() => { if (find) findInput.current?.focus(); }, [find]);
  const search = (previous = false) => {
    const addon = runtime.current?.search;
    try { setFound(query && addon ? (previous ? addon.findPrevious(query, { regex, caseSensitive }) : addon.findNext(query, { regex, caseSensitive })) : null); }
    catch { setFound(false); }
  };
  const running = entry && ["starting", "running", "stopping"].includes(entry.status);
  return <section className="terminal-view" data-terminal-id={id} data-terminal-status={entry?.status ?? "loading"} data-terminal-ready={ready}>
    <header className="terminal-toolbar">
      <strong style={entry?.color ? { borderLeft: `3px solid ${entry.color}`, paddingLeft: 6 } : undefined}>{entry?.label ?? "터미널"}</strong><span className="terminal-status">{entry ? terminalStatus(entry) : "불러오는 중…"}</span>
      <span className="terminal-path" title={entry?.cwd}>{entry?.cwd}</span>
      <button className="button small" onClick={() => setFind(!find)}>찾기</button>
      <button className="button small" onClick={() => {
        const terminal = runtime.current?.terminal; if (!terminal) return;
        const buffer = terminal.buffer.active, lines: string[] = [];
        for (let index = Math.max(0, buffer.length - 200); index < buffer.length; index++) lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
        void navigator.clipboard.writeText(terminal.getSelection() || lines.join("\n").slice(-32_000)).catch((error) => setError(String(error)));
      }}>복사</button>
      <button className="button small" onClick={() => { void navigator.clipboard.readText().then((text) => runtime.current?.terminal.paste(text)).catch((error) => setError(String(error))); }} disabled={!running}>붙여넣기</button>
      <button className="button small terminal-list-open" onClick={onList}>터미널 목록</button>
      <button className="button small danger terminal-stop" disabled={!running || busy} onClick={() => setConfirmClose(true)}>실행 종료</button>
    </header>
    {find ? <form className="terminal-find" onSubmit={(event) => { event.preventDefault(); search(); }}>
      <input ref={findInput} aria-label="터미널 출력 찾기" value={query} onChange={(event) => { setQuery(event.target.value); setFound(null); }} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") { setFind(false); runtime.current?.search.clearDecorations(); } }} />
      <label><input type="checkbox" checked={regex} onChange={(event) => setRegex(event.target.checked)} />정규식</label><label><input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} />대소문자</label>
      <button type="button" className="button small" onClick={() => search(true)}>이전</button><button type="submit" className="button small">다음</button>
      <span role="status">{found === false ? "찾지 못했습니다" : found ? "찾았습니다" : ""}</span>
      <button type="button" className="button small" onClick={() => { setFind(false); runtime.current?.search.clearDecorations(); }}>닫기</button>
    </form> : null}
    {truncated ? <div className="terminal-message">출력은 최근 2 MiB를 보관합니다. 앞부분은 보관 범위를 넘었습니다.</div> : null}
    {!ready ? <div className="terminal-message">출력을 복원하는 중…</div> : null}
    {error ? <div className="terminal-message error" role="alert">{error}</div> : null}
    {confirmClose ? <div className="terminal-message terminal-stop-confirm" role="alertdialog" aria-label="터미널 실행 종료 확인">
      <span>이 터미널의 셸과 실행 중인 작업을 종료합니다. 출력 기록은 유지됩니다.</span>
      <button className="button small" disabled={busy} onClick={() => setConfirmClose(false)}>취소</button>
      <button className="button small danger" disabled={busy} onClick={async () => { setBusy(true); try { setEntry(await api.closeTerminal(id)); setConfirmClose(false); } catch (error) { setError(String(error)); } finally { setBusy(false); } }}>종료 확인</button>
    </div> : null}
    <div className="terminal-surface" ref={element} />
    {entry && !running ? <footer className="terminal-ended">이전 출력 기록입니다. 명령은 자동으로 다시 실행하지 않습니다.<button className="button small" onClick={onList}>새 터미널 열기</button></footer> : null}
  </section>;
}
