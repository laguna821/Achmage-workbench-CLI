import { useEffect, useRef, useState } from "react";
import type { WorkspaceService } from "@workbench/contracts";
import type { TerminalSearchResult } from "../../../../packages/contracts/src/terminal-runtime.ts";
import type { Api } from "../api.ts";

/** A service request stays inside the existing authenticated connection, including on a phone. */
export function WorkspaceServiceInspect({ api, service, mode, onClose }: { api: Api; service: WorkspaceService; mode: "logs" | "proxy"; onClose(): void }) {
  const [query, setQuery] = useState(""), [path, setPath] = useState("/"), [method, setMethod] = useState("GET"), [body, setBody] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [logs, setLogs] = useState<TerminalSearchResult | null>(null);
  const [result, setResult] = useState<{ status: number; type: string; bytes: number; text: string | null; location: string | null } | null>(null);
  const responseBlob = useRef<Blob | null>(null), controller = useRef<AbortController | null>(null), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); responseBlob.current = null; }; }, []);
  const run = async () => {
    if (busy) return;
    setBusy(true); setError("");
    const abort = new AbortController(); controller.current = abort;
    try {
      if (mode === "logs") {
        const next = await api.workspaceServiceLogs(service.id, query); if (mounted.current) setLogs(next);
      } else {
        const response = await api.workspaceServiceProxy(service.id, path, { method, signal: abort.signal,
          ...(method !== "GET" ? { headers: { "content-type": "application/json" }, body } : {}) });
        const blob = await response.blob();
        responseBlob.current = blob;
        const type = response.headers.get("content-type") ?? "application/octet-stream";
        const text = /(^text\/|json|xml|javascript|svg)/i.test(type) ? (await blob.text()).slice(0, 256_000) : null;
        if (mounted.current) setResult({ status: response.status, type, bytes: blob.size, text, location: response.headers.get("x-workbench-service-location") });
      }
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (mounted.current) setBusy(false); if (controller.current === abort) controller.current = null; }
  };
  return <section className="workspace-service-inspect" aria-label={mode === "logs" ? "서비스 로그 검색" : "서비스 포트 요청"} aria-busy={busy}>
    <header><h3>{service.label} · {mode === "logs" ? "로그 검색" : "서비스 포트 요청"}</h3><button type="button" className="button small" onClick={onClose}>접기</button></header>
    <p className="muted">{mode === "logs" ? "이 실행에 보관된 최근 2 MiB 출력에서 찾습니다." : `호스트 ${service.hostId} · 포트 ${service.port}. 현재 기기와 프로젝트에 허용된 연결로 요청합니다.`}</p>
    <form onSubmit={event => { event.preventDefault(); void run(); }}>
      {mode === "logs" ? <label>찾을 글자<input value={query} maxLength={256} onChange={event => setQuery(event.target.value)} autoFocus /></label> : <>
        <label>요청 방식<select value={method} onChange={event => setMethod(event.target.value)}>{["GET", "POST", "PUT", "PATCH", "DELETE"].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>서비스 안의 경로<input value={path} maxLength={16000} onChange={event => setPath(event.target.value)} placeholder="/api/status" /></label>
        {method !== "GET" ? <label>JSON 요청 내용<textarea value={body} onChange={event => setBody(event.target.value)} rows={4} maxLength={1_000_000} /></label> : null}
        <p className="muted">응답 내용을 확인하고 파일로 저장할 수 있습니다. 실제 웹 페이지는 실행 기록의 웹 화면 버튼에서 열 수 있습니다. POST·PUT·PATCH·DELETE는 이 서버의 데이터를 바꿀 수 있습니다.</p>
      </>}
      <div className="workspace-service-actions"><button className="button small primary" disabled={busy || (mode === "logs" ? !query.trim() : !path.startsWith("/"))}>{mode === "logs" ? "검색" : "요청 보내기"}</button>{busy ? <button className="button small" type="button" onClick={() => controller.current?.abort()}>요청 취소</button> : null}</div>
    </form>
    {error ? <p className="workspace-service-error" role="alert">{error}</p> : null}
    {logs ? <div className="workspace-service-log-results" aria-live="polite">
      <p>{logs.matches.length}개{logs.limited ? " 이상" : ""} · 보관 범위 {logs.start}–{logs.end} bytes{logs.truncated ? " · 앞부분 보관 만료" : ""}</p>
      {logs.matches.map(match => <pre key={match.line}><span className="workspace-service-log-line">{match.line}</span>{match.text.slice(0, match.from)}<mark>{match.text.slice(match.from, match.to)}</mark>{match.text.slice(match.to)}</pre>)}
    </div> : null}
    {result ? <div className="workspace-service-response" aria-live="polite">
      <p>HTTP {result.status} · {result.type} · {result.bytes.toLocaleString()} bytes</p>
      {result.location ? <button type="button" className="button small" onClick={() => { setPath(result.location!); setMethod("GET"); }}>같은 서비스의 이동 경로 사용</button> : null}
      {result.text === null ? <p className="muted">바이너리 응답입니다. 파일로 저장해 확인할 수 있습니다.</p> : <pre>{result.text}</pre>}
      {result.text?.length === 256_000 ? <p className="muted">화면에는 앞 256,000자만 표시합니다. 저장 파일에는 전체 응답이 들어갑니다.</p> : null}
      <button type="button" className="button small" onClick={() => {
        const blob = responseBlob.current; if (!blob) return;
        const url = URL.createObjectURL(blob), anchor = document.createElement("a");
        anchor.href = url; anchor.download = `service-${service.id.slice(0, 12)}-response`; anchor.rel = "noopener"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}>응답 파일 저장</button>
    </div> : null}
  </section>;
}
