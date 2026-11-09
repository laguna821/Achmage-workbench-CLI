import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "@workbench/contracts";
import type { ExtensionActivation, ExtensionCall, ExtensionCapability, ExtensionRecord, ExtensionRunResult, ExtensionScreen, ExtensionState } from "../../../../packages/contracts/src/extensions.ts";
import type { Api } from "../api.ts";
import { FeatureDialog, featureError, featureTime } from "./FeatureDialog.tsx";

type Space = { id: string; label: string };
const CAPABILITY: Record<ExtensionCapability, string> = { tool: "도구 실행", screen: "확장 화면", provider: "에이전트 연결" };
const STATUS: Record<ExtensionRecord["status"], string> = { disabled: "꺼짐", enabled: "사용 중", updating: "업데이트 중", failed: "실패" };
const toggle = <T,>(values: T[], value: T, checked: boolean) => checked ? [...new Set([...values, value])] : values.filter(item => item !== value);

function ExtensionFrame({ api, screen, onError }: { api: Api; screen: ExtensionScreen; onError(message: string): void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [expired, setExpired] = useState(screen.expiresAt <= Date.now());
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => setExpired(true), Math.max(0, screen.expiresAt - Date.now()));
    const receive = async (event: MessageEvent) => {
      const source = frame.current?.contentWindow, value = event.data;
      if (!source || event.source !== source || !value || value.type !== "workbench.extension.call" || value.nonce !== screen.nonce || typeof value.requestId !== "string" || value.requestId.length > 200) return;
      const call = value.call as ExtensionCall | undefined;
      let output: unknown, error: string | undefined;
      try {
        if (Date.now() >= screen.expiresAt) throw new Error("화면의 사용 기한이 끝났습니다. 다시 열어 주세요.");
        if (!call || call.extensionId !== screen.extensionId || call.artifactHash !== screen.artifactHash || call.grantGeneration !== screen.grantGeneration || call.workspaceId !== screen.workspaceId || call.capability !== "tool") throw new Error("이 화면에서 허용하지 않은 요청입니다.");
        const result = await api.request<ExtensionRunResult>("POST", "/api/extensions/screen/call", { nonce: screen.nonce, call }); output = result.output;
      } catch (reason) { error = featureError(reason); if (live) onError(error); }
      if (live && source === frame.current?.contentWindow) source.postMessage({ type: "workbench.extension.result", nonce: screen.nonce, requestId: value.requestId, ...(error ? { error } : { output }) }, "*");
    };
    window.addEventListener("message", receive);
    return () => { live = false; clearTimeout(timer); window.removeEventListener("message", receive); };
  }, [api, screen, onError]);
  return expired ? <p>화면의 사용 기한이 끝났습니다. 다시 열어 주세요.</p> : <iframe ref={frame} className="extension-frame" title={`확장 화면 ${screen.screenId}`} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={screen.html} />;
}

function GrantEditor({ extension, spaces, busy, onActivate }: { extension: ExtensionRecord; spaces: Space[]; busy: boolean; onActivate(grant: ExtensionActivation): void }) {
  const [capabilities, setCapabilities] = useState<ExtensionCapability[]>([]), [workspaceIds, setWorkspaceIds] = useState<string[]>([]);
  const [files, setFiles] = useState<("read" | "write")[]>([]), [network, setNetwork] = useState<string[]>([]), [confirmed, setConfirmed] = useState(false);
  const manifest = extension.manifest;
  return <form className="feature-form" onSubmit={event => { event.preventDefault(); if (confirmed) onActivate({ expectedHash: extension.artifactHash, expectedGeneration: extension.grant.generation, capabilities, workspaceIds, permissions: { files, network } }); }}>
    <h4>이 판본에 허용할 권한</h4><p className="sheet-hint">지원하는 기존 권한만 유지하며, 새 권한은 직접 승인합니다. 이전 판 복원 후에는 다시 활성화합니다. 선택하지 않은 작업공간에는 접근할 수 없습니다.</p><fieldset disabled={busy}>
      <div className="feature-checks">{manifest.capabilities.map(value => <label key={value} className="feature-check"><input type="checkbox" checked={capabilities.includes(value)} onChange={event => setCapabilities(toggle(capabilities, value, event.target.checked))} />{CAPABILITY[value]}</label>)}</div>
      <strong>작업공간</strong><div className="feature-checks">{spaces.map(space => <label key={space.id} className="feature-check"><input type="checkbox" checked={workspaceIds.includes(space.id)} onChange={event => setWorkspaceIds(toggle(workspaceIds, space.id, event.target.checked))} />{space.label}</label>)}{!spaces.length ? <p>승인할 작업공간이 없습니다.</p> : null}</div>
      <strong>파일 접근</strong><div className="feature-checks">{manifest.permissions.files.map(value => <label key={value} className="feature-check"><input type="checkbox" checked={files.includes(value)} onChange={event => setFiles(toggle(files, value, event.target.checked))} />{value === "read" ? "읽기" : "쓰기"}</label>)}{!manifest.permissions.files.length ? <span>요청 없음</span> : null}</div>
      <strong>네트워크 접근</strong><div className="feature-checks">{manifest.permissions.network.map(value => <label key={value} className="feature-check"><input type="checkbox" checked={network.includes(value)} onChange={event => setNetwork(toggle(network, value, event.target.checked))} />{value}</label>)}{!manifest.permissions.network.length ? <span>요청 없음</span> : null}</div>
      <p className="feature-mono">승인할 SHA-256 {extension.artifactHash}</p><label className="feature-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />위 판본·기능·작업공간의 실행을 승인합니다.</label><button type="submit" className="button small primary" disabled={!confirmed || !capabilities.length || !workspaceIds.length}>선택한 권한으로 활성화</button>
    </fieldset>
  </form>;
}

export function ExtensionLibrary({ api, onClose, workspaces }: { api: Api; onClose(): void; workspaces?: Space[] }) {
  const [state, setState] = useState<ExtensionState | null>(null), [spaces, setSpaces] = useState<Space[]>(workspaces ?? []), [selected, setSelected] = useState("");
  const [directory, setDirectory] = useState(""), [expectedHash, setExpectedHash] = useState(""), [updateDirectory, setUpdateDirectory] = useState(""), [updateHash, setUpdateHash] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [workspaceId, setWorkspaceId] = useState(""), [contribution, setContribution] = useState(""), [input, setInput] = useState("{}"), [output, setOutput] = useState<unknown>(undefined), [screen, setScreen] = useState<ExtensionScreen | null>(null);
  const live = useRef(true), pending = useRef(false);
  const refresh = async () => { const next = await api.request<ExtensionState>("GET", "/api/extensions"); if (live.current) setState(next); return next; };
  useEffect(() => {
    live.current = true;
    if (!api.isRemote) {
      void refresh().catch(reason => { if (live.current) setError(featureError(reason)); });
      if (!workspaces) void api.request<Snapshot>("GET", "/api/snapshot").then(next => { if (live.current) setSpaces((next.workspaces ?? []).filter(space => !space.archivedAt && !space.removedAt).map(space => ({ id: space.id, label: `${next.works.find(work => work.id === space.workId)?.title ?? "프로젝트"} · ${space.label}` }))); }, reason => { if (live.current) setError(featureError(reason)); });
    }
    const timer = setInterval(() => { if (!api.isRemote && !pending.current) void refresh().catch(reason => { if (live.current) setError(featureError(reason)); }); }, 5000);
    return () => { live.current = false; clearInterval(timer); };
  }, [api]);
  const extension = state?.extensions.find(item => item.manifest.id === selected);
  useEffect(() => { setOutput(undefined); setScreen(null); setContribution(""); setWorkspaceId(""); setUpdateDirectory(""); setUpdateHash(""); }, [selected, extension?.artifactHash, extension?.grant.generation]);
  const perform = async <T,>(action: () => Promise<T>, message: string | ((result: T) => string)) => {
    if (pending.current || api.isRemote) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try { const result = await action(); await refresh(); if (live.current) setNotice(typeof message === "function" ? message(result) : message); }
    catch (reason) { if (live.current) setError(featureError(reason)); }
    finally { pending.current = false; if (live.current) setBusy(false); }
  };
  const pickDirectory = async (put: (value: string) => void) => {
    if (api.isRemote || !("__TAURI_INTERNALS__" in window)) return;
    try { const { open } = await import("@tauri-apps/plugin-dialog"); const value = await open({ directory: true, multiple: false, title: "확장 패키지 폴더 선택" }); if (typeof value === "string") put(value); }
    catch (reason) { setError(featureError(reason)); }
  };
  const runContribution = () => {
    if (!extension || !contribution || !workspaceId) return;
    void perform(async () => {
      const [capability, contributionId] = JSON.parse(contribution) as [ExtensionCapability, string];
      const call: ExtensionCall = { extensionId: extension.manifest.id, artifactHash: extension.artifactHash, grantGeneration: extension.grant.generation, workspaceId, capability, contributionId, input: JSON.parse(input) };
      if (capability === "screen") { const next = await api.request<ExtensionScreen>("POST", "/api/extensions/screen", call); if (live.current) { setScreen(next); setOutput(undefined); } }
      else { const result = await api.request<ExtensionRunResult>("POST", "/api/extensions/run", call); if (live.current) { setOutput(result.output); setScreen(null); } }
    }, "확장 실행 요청을 처리했습니다.");
  };
  return <FeatureDialog title="실행 확장" description="설치한 확장의 출처와 권한을 확인하고 필요한 기능만 실행합니다." onClose={onClose}>
    {api.isRemote ? <p>실행 확장은 호스트 PC에서 관리합니다.</p> : <>
      {error ? <p className="notice notice-error compact" role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
      <p className="sheet-hint">양식·스킬 보관함과 별도로 관리합니다. 가져온 패키지는 꺼진 상태로 설치되며 활성화 전에는 실행하지 않습니다.</p>
      <details><summary>확장 패키지 설치</summary><form className="feature-form" onSubmit={event => { event.preventDefault(); void perform(async () => { await api.request<ExtensionRecord>("POST", "/api/extensions/install", { directory, ...(expectedHash.trim() ? { expectedHash: expectedHash.trim() } : {}) }); if (live.current) { setDirectory(""); setExpectedHash(""); } }, "확장을 꺼진 상태로 설치했습니다. 목록에서 출처와 권한을 확인하세요."); }}><fieldset disabled={busy}><label>이 PC의 패키지 폴더<input required value={directory} onChange={event => setDirectory(event.target.value)} /></label>{"__TAURI_INTERNALS__" in window ? <button type="button" className="button small" onClick={() => void pickDirectory(setDirectory)}>폴더 선택</button> : null}<label>배포자가 제공한 SHA-256 (선택)<input value={expectedHash} onChange={event => setExpectedHash(event.target.value)} pattern="[a-fA-F0-9]{64}" /></label><button className="button small primary" type="submit">꺼진 상태로 설치</button></fieldset></form></details>
      <div className="feature-actions"><button type="button" className="button small" disabled={busy} onClick={() => void perform(refresh, "목록을 새로 불러왔습니다.")}>새로고침</button>{state ? <span>WASM 격리 실행 · {state.runtime.platform} · {state.runtime.verification === "host-tested" ? "호스트 검증됨" : "이 환경 실행 미검증"}</span> : <span role="status">확장 불러오는 중…</span>}</div>
      <div className="feature-columns"><nav className="feature-list" aria-label="설치한 실행 확장">{state?.extensions.map(item => <button type="button" key={item.manifest.id} className={selected === item.manifest.id ? "active" : ""} aria-pressed={selected === item.manifest.id} onClick={() => setSelected(item.manifest.id)}><strong>{item.manifest.name}</strong><span>{item.manifest.version} · {STATUS[item.status]}</span></button>)}{state && !state.extensions.length ? <p>설치한 실행 확장이 없습니다.</p> : null}</nav>
        <main>{extension ? <>
          <h3>{extension.manifest.name} · {extension.manifest.version}</h3><p>{STATUS[extension.status]} · {extension.manifest.license}</p><p className="feature-mono">출처 {extension.manifest.source.url}<br />판본 {extension.manifest.source.revision}</p><details><summary>설치 파일·해시</summary><p className="feature-mono">SHA-256 {extension.artifactHash}</p>{extension.files.map(file => <p className="feature-mono" key={file.path}>{file.path} · {file.bytes.toLocaleString()} bytes<br />{file.sha256}</p>)}</details>
          {extension.error ? <p className="notice notice-error compact" role="alert">{extension.error}</p> : null}
          {extension.status === "enabled" ? <><p>현재 권한: {extension.grant.capabilities.map(value => CAPABILITY[value]).join(", ")} · {extension.grant.workspaceIds.length}개 작업공간</p><button type="button" className="button small" disabled={busy} onClick={() => void perform(async () => { setScreen(null); await api.request<ExtensionRecord>("POST", `/api/extensions/${encodeURIComponent(selected)}/disable`, { expectedGeneration: extension.grant.generation }); }, "확장을 끄고 기존 권한을 철회했습니다.")}>확장 끄기·권한 철회</button></> : null}
          <GrantEditor key={`${extension.manifest.id}:${extension.artifactHash}:${extension.grant.generation}`} extension={extension} spaces={spaces} busy={busy} onActivate={grant => void perform(() => api.request<ExtensionRecord>("POST", `/api/extensions/${encodeURIComponent(selected)}/activate`, grant), "확장을 선택한 권한으로 활성화했습니다.")} />
          <details><summary>업데이트·이전 판 복원</summary><form className="feature-form" onSubmit={event => { event.preventDefault(); void perform(async () => { setScreen(null); return api.request<ExtensionRecord>("POST", `/api/extensions/${encodeURIComponent(selected)}/update`, { directory: updateDirectory, ...(updateHash.trim() ? { expectedHash: updateHash.trim() } : {}) }); }, result => result.status === "enabled" ? "새 버전으로 업데이트하고 지원하는 기존 권한을 유지했습니다. 새 권한은 직접 승인하세요." : "새 버전으로 업데이트했습니다. 사용하려면 권한을 확인하고 활성화하세요."); }}><fieldset disabled={busy}><label>새 패키지 폴더<input required value={updateDirectory} onChange={event => setUpdateDirectory(event.target.value)} /></label>{"__TAURI_INTERNALS__" in window ? <button type="button" className="button small" onClick={() => void pickDirectory(setUpdateDirectory)}>폴더 선택</button> : null}<label>새 패키지 SHA-256 (선택)<input value={updateHash} onChange={event => setUpdateHash(event.target.value)} pattern="[a-fA-F0-9]{64}" /></label><button type="submit" className="button small">새 버전으로 업데이트</button>{extension.previous ? <button type="button" className="button small" onClick={() => void perform(async () => { setScreen(null); await api.request<ExtensionRecord>("POST", `/api/extensions/${encodeURIComponent(selected)}/rollback`, { expectedGeneration: extension.grant.generation }); }, "이전 판을 복원했습니다. 실행 권한을 다시 확인하세요.")}>이전 판 {extension.previous.manifest.version} 복원</button> : null}</fieldset></form></details>
          <section className="feature-section"><h4>승인한 기능 실행</h4><fieldset disabled={busy || extension.status !== "enabled"}>
            <label>작업공간<select value={workspaceId} onChange={event => setWorkspaceId(event.target.value)}><option value="">선택하세요</option>{spaces.filter(space => extension.grant.workspaceIds.includes(space.id)).map(space => <option key={space.id} value={space.id}>{space.label}</option>)}</select></label>
            <label>실행할 기능<select value={contribution} onChange={event => setContribution(event.target.value)}><option value="">선택하세요</option>{(["tool", "screen", "provider"] as const).filter(kind => extension.grant.capabilities.includes(kind)).flatMap(kind => (kind === "tool" ? extension.manifest.tools : kind === "screen" ? extension.manifest.screens : extension.manifest.providers).map(item => <option key={`${kind}:${item.id}`} value={JSON.stringify([kind, item.id])}>{CAPABILITY[kind]} · {item.title}</option>))}</select></label><label>실행 입력 (JSON)<textarea rows={3} value={input} onChange={event => setInput(event.target.value)} spellCheck={false} /></label><button type="button" className="button small primary" disabled={!contribution || !workspaceId} onClick={runContribution}>선택한 기능 실행</button>
          </fieldset>{output !== undefined ? <pre className="feature-output">{JSON.stringify(output, null, 2)}</pre> : null}{screen ? <><p className="sheet-hint">확장 화면은 승인한 도구의 입력 양식입니다. 임의 스크립트는 실행하지 않습니다.</p><ExtensionFrame api={api} screen={screen} onError={setError} /></> : null}</section>
        </> : <p>목록에서 확장을 선택해 출처·권한·실행 기록을 확인하세요.</p>}</main>
      </div>
      <section className="feature-section"><h3>실행 기록</h3><div className="feature-history">{state?.runs.filter(run => !selected || run.extensionId === selected).map(run => <article key={run.id}><strong>{run.extensionId} · {run.contributionId}</strong><p>{{ running: "실행 중", completed: "완료", failed: "실패", cancelled: "취소됨" }[run.status]} · {featureTime(run.startedAt)}</p><small>작업공간 {spaces.find(space => space.id === run.workspaceId)?.label ?? run.workspaceId} · 승인 {run.grantGeneration}판</small>{run.error ? <p>{run.error}</p> : null}</article>)}</div>{state && !state.runs.some(run => !selected || run.extensionId === selected) ? <p>실행 기록이 없습니다.</p> : null}</section>
    </>}
  </FeatureDialog>;
}
