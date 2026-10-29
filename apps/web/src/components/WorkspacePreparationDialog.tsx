import { useEffect, useRef, useState } from "react";
import type { HookSource, PreparationJob, PreparationOptions, PreparationPreview, TerminalSession, Workspace, WorkspaceEnvironment } from "@workbench/contracts";
import type { Api } from "../api.ts";
import "../styles/preparation.css";

const labels: Record<PreparationJob["phase"], string> = { queued: "대기", paths: "파일 준비", hook: "명령 실행 중", tabs: "기본 터미널 생성", complete: "완료", failed: "실패", canceled: "취소됨", interrupted: "이전 준비 중단" };
const active = (job: PreparationJob) => ["queued", "paths", "hook", "tabs"].includes(job.phase);
const sourceLabels: Record<HookSource, string> = { auto: "개인 명령이 있으면 개인 설정 우선", "shared-only": "orca.yaml만", "local-only": "개인 설정만", "run-both": "orca.yaml 다음 개인 설정" };

export function WorkspacePreparationDialog({ api, workspace, onOpen, onClose }: { api: Api; workspace: Workspace; onOpen: (terminal: TerminalSession) => Promise<unknown> | void; onClose: () => void }) {
  const [settings, setSettings] = useState<WorkspaceEnvironment | null>(null), [dirty, setDirty] = useState(false);
  const [options, setOptions] = useState<PreparationOptions>({ kind: "setup", applyPaths: true, runCommands: true, openTabs: true });
  const [preview, setPreview] = useState<PreparationPreview | null>(null), [jobs, setJobs] = useState<PreparationJob[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const requestId = useRef(crypto.randomUUID()), openingJob = useRef<string | null>(null), mounted = useRef(true);
  const callbacks = useRef({ onOpen, onClose }); callbacks.current = { onOpen, onClose };
  const fail = (error: unknown) => { if (mounted.current) setError(error instanceof Error ? error.message : String(error)); };
  const openTerminals = async (ids: string[]) => {
    try {
      for (const id of ids) { const output = await api.terminalOutput(id); await callbacks.current.onOpen(output.terminal); }
      callbacks.current.onClose();
    } catch (error) { fail(error); }
  };
  useEffect(() => {
    mounted.current = true;
    void api.workspaceEnvironment(workspace.workId).then((value) => { if (mounted.current) setSettings(value); }).catch(fail);
    const refresh = () => { void api.preparations(workspace.id).then((jobs) => {
      if (!mounted.current) return; setJobs(jobs);
      const completed = jobs.find((job) => job.id === openingJob.current && job.phase === "complete");
      if (completed) { openingJob.current = null; if (completed.terminalIds.length) void openTerminals(completed.terminalIds); }
    }).catch(fail); };
    refresh(); const timer = window.setInterval(refresh, 600);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [api, workspace.id, workspace.workId]); // callbacks are intentionally read through refs.
  const change = (patch: Partial<WorkspaceEnvironment>) => { if (settings) { setSettings({ ...settings, ...patch }); setDirty(true); setPreview(null); } };
  const choose = (patch: Partial<PreparationOptions>) => { setOptions({ ...options, ...patch }); setPreview(null); };
  const readPreview = async () => {
    setBusy(true); setError("");
    try { setPreview(await api.preparationPreview(workspace.id, options)); requestId.current = crypto.randomUUID(); }
    catch (error) { setPreview(null); fail(error); } finally { setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="preparation-dialog" role="dialog" aria-modal="true" aria-label="작업공간 환경 준비">
      <header><h2>{workspace.label} · 환경 준비</h2><button className="button small" onClick={onClose} disabled={busy}>닫기</button></header>
      <p className="preparation-path">{workspace.cwd}</p>
      <p className="muted">적용 전에 원본·목적지와 실행할 명령을 확인합니다. 기존 목적지 파일은 유지합니다.</p>
      <details className="preparation-settings"><summary>이 프로젝트의 개인 설정</summary>
        {settings ? <form onSubmit={async (event) => {
          event.preventDefault(); setBusy(true); setError("");
          try { setSettings(await api.saveWorkspaceEnvironment(workspace.workId, { ...settings, sharedPaths: settings.sharedPaths.map((path) => path.trim()).filter(Boolean) })); setDirty(false); setPreview(null); }
          catch (error) { fail(error); } finally { setBusy(false); }
        }}>
          <p>이 앱에만 저장합니다. 저장소의 orca.yaml과 .worktreeinclude는 바꾸지 않습니다.</p>
          {(["setup", "archive"] as const).map((kind) => <div key={kind}>
            <label>{kind === "setup" ? "준비" : "보관"} 명령 출처<select aria-label={`${kind === "setup" ? "준비" : "보관"} 명령 출처`} value={settings[`${kind}Source`]} onChange={(event) => change({ [`${kind}Source`]: event.target.value as HookSource })}>{Object.entries(sourceLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            <label>개인 {kind === "setup" ? "준비" : "보관"} 명령<textarea aria-label={`개인 ${kind === "setup" ? "준비" : "보관"} 명령`} rows={3} value={settings[`${kind}Script`]} onChange={(event) => change({ [`${kind}Script`]: event.target.value })} /></label>
          </div>)}
          <label>공유 경로 · 저장소 상대 경로, 한 줄에 하나<textarea aria-label="개인 공유 경로" rows={3} value={settings.sharedPaths.join("\n")} onChange={(event) => change({ sharedPaths: event.target.value.split("\n") })} /></label>
          <label className="preparation-check"><input type="checkbox" checked={settings.waitForSetup} onChange={(event) => change({ waitForSetup: event.target.checked })} />준비 완료 후 AI 요청 허용</label>
          <label>Bash 실행 파일 · Windows Git Bash 등<input aria-label="준비 Bash 경로" value={settings.bashPath} placeholder="기본값 사용" onChange={(event) => change({ bashPath: event.target.value })} /></label>
          <button className="button small" disabled={busy || !dirty}>개인 설정 저장</button>
          <button type="button" className="text-button" disabled={busy} onClick={() => { void api.workspaceEnvironment(workspace.workId).then((value) => { setSettings(value); setDirty(false); setPreview(null); }).catch(fail); }}>다시 불러오기</button>
        </form> : <p>개인 설정을 읽는 중…</p>}
      </details>
      <div className="preparation-options">
        <label>작업<select aria-label="환경 준비 종류" value={options.kind} onChange={(event) => choose({ kind: event.target.value as PreparationOptions["kind"] })}><option value="setup">작업 시작 준비</option><option value="archive">보관·제거 준비</option></select></label>
        {options.kind === "setup" ? <><label><input type="checkbox" checked={options.applyPaths} onChange={(event) => choose({ applyPaths: event.target.checked })} />복사·공유 적용</label><label><input type="checkbox" checked={options.openTabs} onChange={(event) => choose({ openTabs: event.target.checked })} />기본 터미널 만들기</label></> : null}
        <label><input aria-label="준비 명령 실행" type="checkbox" checked={options.runCommands} onChange={(event) => choose({ runCommands: event.target.checked })} />명령 실행</label>
        <button className="button small preparation-preview-button" disabled={busy || dirty || workspace.archivedAt !== null || workspace.removedAt !== null} onClick={() => void readPreview()}>미리보기</button>
      </div>
      {dirty ? <p>개인 설정을 저장한 뒤 미리보기를 열어 주세요.</p> : null}
      {workspace.archivedAt !== null || workspace.removedAt !== null ? <p>보관되거나 제거된 작업공간의 기록입니다. 새 준비 작업을 실행하지 않습니다.</p> : null}
      {!options.runCommands ? <p className="preparation-warning">이번 준비의 명령을 건너뜁니다. 보관 준비에서 적용하면 보관·제거가 허용됩니다.</p> : null}
      {error ? <p className="preparation-error" role="alert">{error}</p> : null}
      {preview ? <div className="preparation-preview" data-revision={preview.revision}>
        <dl><dt>원본 체크아웃</dt><dd>{preview.primary}</dd><dt>실행·적용 폴더</dt><dd>{preview.target}</dd></dl>
        {preview.paths.length ? <table><thead><tr><th>방식</th><th>경로</th><th>결과</th></tr></thead><tbody>{preview.paths.map((entry, index) => <tr key={`${entry.path}-${index}`}>
          <td>{entry.mode === "copy" ? "독립 복사" : "공유 링크"}</td><td><strong>{entry.path}</strong><small>원본: {entry.source}</small><small>목적지: {entry.target}</small></td><td>{entry.action === "apply" ? `${entry.entries}개 · ${(entry.bytes / 1024).toFixed(1)} KiB` : entry.reason}</td>
        </tr>)}</tbody></table> : null}
        {preview.hook.script ? <><h3>{preview.options.kind === "setup" ? "준비" : "보관"} 명령 · {sourceLabels[preview.hook.source]}</h3><p>{preview.options.runCommands ? `실행: ${preview.shellPath}` : "이번에는 실행하지 않습니다."}</p><pre className="preparation-script">{preview.hook.script}</pre></> : <p>선택한 출처에 실행할 명령이 없습니다.</p>}
        {preview.tabs.length ? <><h3>기본 터미널</h3>{preview.tabs.map((tab) => <div className="preparation-tab" key={tab.key}><strong>{tab.title}{tab.terminalId ? " · 기존 기록 재사용" : ""}</strong><pre>{tab.command || "기본 셸"}</pre></div>)}</> : null}
        <details><summary>명령에 전달할 경로</summary><pre>{Object.entries(preview.environment).map(([key, value]) => `${key}=${value}`).join("\n")}</pre></details>
        {preview.warnings.map((warning, index) => <p className="preparation-warning" key={index}>{warning}</p>)}
        <button className="button primary preparation-apply" disabled={busy || jobs.some(active)} onClick={async () => {
          setBusy(true); setError("");
          try {
            const job = await api.applyPreparation(workspace.id, { requestId: requestId.current, expectedRevision: preview.revision, options: preview.options });
            if (preview.options.openTabs) openingJob.current = job.id;
            setJobs((before) => [job, ...before.filter((entry) => entry.id !== job.id)]); setPreview(null);
          } catch (error) { fail(error); } finally { setBusy(false); }
        }}>{preview.options.runCommands ? "확인한 내용 적용·실행" : "명령을 건너뛰고 적용"}</button>
      </div> : null}
      <h3>준비 기록</h3>
      {!jobs.length ? <p className="muted">아직 실행한 준비 작업이 없습니다.</p> : jobs.map((job) => <article className="preparation-job" data-job-id={job.id} data-phase={job.phase} key={job.id}>
        <strong>{job.preview.options.kind === "setup" ? "작업 시작" : "보관·제거"} · {labels[job.phase]}</strong><small>{new Date(job.createdAt).toLocaleString()} · 파일 처리 {job.pathResults.length}/{job.preview.paths.length}</small>
        {job.error ? <p className="preparation-error">{job.error}</p> : null}
        {active(job) ? <button className="button small" onClick={() => { void api.cancelPreparation(job.id).then(() => api.preparations(workspace.id)).then(setJobs).catch(fail); }}>준비 취소</button> : null}
        {job.terminalIds.length ? <button className="button small preparation-open-results" onClick={() => void openTerminals(job.terminalIds)}>출력·터미널 열기</button> : null}
      </article>)}
      <p className="muted">창을 닫아도 준비는 계속됩니다. 실패·취소 뒤 이미 만든 파일과 기록은 남으며 명령을 자동으로 재실행하지 않습니다.</p>
    </section>
  </div>;
}
