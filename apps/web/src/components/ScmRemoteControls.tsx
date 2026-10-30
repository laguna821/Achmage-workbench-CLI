import { useEffect, useState } from "react";
import type { ScmAction, ScmPushPreview, ScmRemoteInventory, ScmRemoteRequest, ScmStatus } from "@workbench/contracts";
import type { Api } from "../api.ts";

export function ScmRemoteControls({ api, status, inventory, busy, act, onError, onTerminal }: {
  api: Api; status: ScmStatus; inventory: ScmRemoteInventory; busy: boolean;
  act: (action: ScmAction, remote: ScmRemoteRequest) => Promise<void>; onError: (message: string) => void; onTerminal: () => void;
}) {
  const [direction, setDirection] = useState<"pull" | "push">("push");
  const initial = inventory.pushTarget ?? inventory.pullTarget;
  const [remote, setRemote] = useState(initial?.remote ?? inventory.remotes[0]?.name ?? ""), [branch, setBranch] = useState(initial?.branch ?? status.branch ?? "");
  const [strategy, setStrategy] = useState<"ff-only" | "merge" | "rebase">("ff-only"), [setUpstream, setSetUpstream] = useState(!inventory.pullTarget);
  const [preview, setPreview] = useState<ScmPushPreview | null>(null), [probing, setProbing] = useState(false), [confirmForce, setConfirmForce] = useState(false);
  useEffect(() => { setPreview(null); setConfirmForce(false); }, [remote, branch, status.head, inventory.revision]);
  const target = inventory.remotes.find((entry) => entry.name === remote), disabled = busy || probing || !target || !branch;
  const request = (): ScmRemoteRequest => ({ remote, branch, expectedRevision: inventory.revision, ...(direction === "pull" ? { strategy } : { setUpstream }) });
  const choose = (value: "pull" | "push") => { setDirection(value); const defaults = value === "push" ? inventory.pushTarget : inventory.pullTarget; if (defaults) { setRemote(defaults.remote); setBranch(defaults.branch); } setPreview(null); setConfirmForce(false); };
  return <details className="scm-remote-controls"><summary>원격 동기화{inventory.remotes.length ? ` · ${inventory.remotes.length}개` : " · 연결 없음"}</summary>
    {!inventory.remotes.length ? <p>이 저장소에 원격 주소가 없습니다. 터미널에서 연결하면 새로고침으로 확인할 수 있습니다.</p> : <>
      <div className="scm-remote-fields"><label>작업<select aria-label="원격 작업" value={direction} onChange={(event) => choose(event.target.value as "pull" | "push")}><option value="push">보내기</option><option value="pull">받기</option></select></label>
        <label>원격<select aria-label="Git 원격" value={remote} onChange={(event) => setRemote(event.target.value)}>{inventory.remotes.map((entry) => <option key={entry.name}>{entry.name}</option>)}</select></label>
        <label>대상 브랜치<input aria-label="원격 브랜치" value={branch} onChange={(event) => setBranch(event.target.value)} /></label>
        {direction === "pull" ? <label>받는 방법<select aria-label="받는 방법" value={strategy} onChange={(event) => setStrategy(event.target.value as typeof strategy)}><option value="ff-only">단순 전진만</option><option value="merge">병합</option><option value="rebase">리베이스</option></select></label> : null}
      </div>
      <div className="scm-remote-destinations">{(direction === "push" ? target?.pushUrls : target?.fetchUrls.slice(0, 1))?.map((url, index) => <code key={index}>{url}</code>)}</div>
      <p>{direction === "push" ? `${status.branch ?? "분리된 HEAD"}의 ${status.head?.slice(0, 8) ?? "커밋 없음"} → ${remote}/${branch}` : `${remote}/${branch} → ${status.branch ?? "분리된 HEAD"}`}</p>
      {direction === "push" ? <label className="scm-remote-check"><input type="checkbox" checked={setUpstream} onChange={(event) => setSetUpstream(event.target.checked)} />성공 후 이 원격 브랜치를 추적</label> : <small>기존 변경은 먼저 커밋하거나 직접 보관하세요. 자동 stash는 만들지 않습니다.</small>}
      <div className="scm-remote-buttons"><button className="button small scm-fetch" disabled={disabled} onClick={() => void act("fetch", request())}>브랜치 가져오기</button><button className="button primary small scm-remote-run" disabled={disabled || !status.head || !status.branch || !!status.operation} onClick={() => void act(direction, request())}>{direction === "push" ? "보내기" : "받기"}</button></div>
      {direction === "push" ? <details className="scm-force"><summary>기록을 다시 쓴 브랜치 보내기…</summary><p>원격 커밋을 확인한 뒤 명시적으로 덮어씁니다. 확인 후 원격이 바뀌면 거절됩니다.</p><button className="button small scm-push-probe" disabled={disabled || !status.head} onClick={async () => { setProbing(true); setConfirmForce(false); try { setPreview(await api.scmPushPreview(status.workspaceId, request())); } catch (error) { onError(error instanceof Error ? error.message : String(error)); } finally { setProbing(false); } }}>{probing ? "원격 확인 중…" : "원격 커밋 확인"}</button>
        {preview ? <div className="scm-force-preview">{preview.destinations.map((entry, index) => <p key={index}><code>{entry.url}</code><br />{entry.head?.slice(0, 12) ?? "새 브랜치"} → {preview.head.slice(0, 12)}</p>)}<label><input type="checkbox" checked={confirmForce} onChange={(event) => setConfirmForce(event.target.checked)} />위 원격 브랜치의 기록을 바꾸겠습니다.</label><button className="button danger small scm-force-push" disabled={busy || !confirmForce || preview.expiresAt <= Date.now()} onClick={() => { setConfirmForce(false); void act("push", { ...request(), forcePreviewId: preview.id }); }}>확인한 커밋일 때만 강제 보내기</button></div> : null}
      </details> : null}
    </>}
    <small>이 컴퓨터의 Git 자격 증명을 사용합니다. 인증이 필요하면 터미널에서 연결한 뒤 다시 실행하세요.</small><button className="text-button scm-auth-terminal" onClick={onTerminal}>이 작업공간 터미널 열기</button>
  </details>;
}
