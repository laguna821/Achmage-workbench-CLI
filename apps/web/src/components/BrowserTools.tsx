import { useEffect, useRef, useState } from "react";
import type { BrowserDownload, BrowserOutput, BrowserOutputRequest, BrowserPage, BrowserPermissionRequest } from "@workbench/contracts";
import type { Api } from "../api.ts";
import type { SharedBrowser } from "../browser-state.ts";
import { AttachmentStrip, MAX_FILE, sizeText } from "./Attachments.tsx";
import { FeatureDialog, featureError, featureTime } from "./FeatureDialog.tsx";

const downloadLabel: Record<BrowserDownload["status"], string> = { blocked: "저장 전 중단", downloading: "다운로드 중", cancelling: "취소 요청 중", checking: "파일 확인 중", completed: "저장 완료", failed: "다운로드 실패", cancelled: "취소됨", unconfirmed: "결과 확인 필요" };
const permissionLabel: Record<BrowserPermissionRequest["status"], string> = { pending: "결정 대기", "native-prompt": "브라우저 확인창에서 결정", allowed: "이번 요청 허용", denied: "거절됨", expired: "만료됨", unsupported: "지원하지 않아 거절됨" };
const kinds: Record<string, string> = { microphone: "마이크", camera: "카메라", "camera-microphone": "카메라와 마이크", "display-capture": "화면 공유", geolocation: "위치", notifications: "알림", "pointer-lock": "마우스 잠금", "clipboard-read": "클립보드 읽기", midi: "MIDI", sensors: "센서", "local-fonts": "설치된 글꼴", "window-management": "창 관리", "automatic-downloads": "여러 파일 다운로드", "file-system-access": "파일 접근", autoplay: "자동 재생", other: "기타 권한" };

export function BrowserTools({ browser, api, page, ready, onOpenArtifact, onClose }: {
  browser: SharedBrowser; api: Api; page: BrowserPage; ready: boolean; onOpenArtifact(id: string): void; onClose(): void;
}) {
  const [outputs, setOutputs] = useState<BrowserOutput[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [remember, setRemember] = useState<Record<string, boolean>>({});
  const pending = useRef<BrowserOutputRequest | null>(null), acting = useRef(false);
  const endpoint = `/api/browser/pages/${encodeURIComponent(page.pageId)}/outputs`;
  const native = page.native, downloads = native?.downloads ?? [], permissions = native?.permissions ?? [];
  const refresh = async () => { setOutputs(await api.request<BrowserOutput[]>("GET", endpoint)); };
  useEffect(() => { let live = true; void api.request<BrowserOutput[]>("GET", endpoint).then(value => { if (live) setOutputs(value); }).catch(reason => { if (live) setError(featureError(reason)); }); return () => { live = false; }; }, [api, endpoint]);
  const run = async (action: () => Promise<void>) => {
    if (acting.current) return; acting.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (reason) { setError(featureError(reason)); } finally { acting.current = false; setBusy(false); }
  };
  const chooseDirectory = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const directory = await open({ directory: true, multiple: false, title: "이 웹 탭의 다운로드 저장 폴더", ...(native?.downloadDirectory ? { defaultPath: native.downloadDirectory } : {}) });
    if (typeof directory !== "string") return;
    await browser.downloadDirectory(page.pageId, directory);
    setNotice("저장 폴더를 설정했습니다. 사이트의 다운로드 버튼으로 파일을 저장해 주세요.");
  };
  const save = async (kind: "page-text" | "download", downloadId?: string) => {
    const existing = downloadId ? outputs.find(output => output.downloadId === downloadId) : undefined;
    if (existing) { setNotice("이미 이 작업공간에 보관한 파일입니다."); return; }
    let request = pending.current;
    if (request && (request.kind !== kind || (request.kind === "download" && request.downloadId !== downloadId))) throw new Error("앞선 자료의 보관 결과를 먼저 다시 확인해 주세요.");
    if (!request) request = kind === "download" ? { requestId: crypto.randomUUID(), kind, downloadId: downloadId! } : { requestId: crypto.randomUUID(), kind };
    pending.current = request;
    const output = await api.request<BrowserOutput>("POST", endpoint, request);
    pending.current = null; setOutputs(current => [output, ...current.filter(entry => entry.id !== output.id)]);
    setNotice(output.artifact ? "작업공간에 문서와 원본 첨부를 보관했습니다." : "작업공간에 파일과 원본 첨부를 보관했습니다. 이 형식은 문서 편집 대상이 아닙니다.");
  };
  const decide = async (request: BrowserPermissionRequest, allow: boolean) => {
    const saved = Boolean(remember[request.id] && request.requestingOrigin && request.topLevelOrigin && native?.capabilities.includes("permission_persistence"));
    await browser.decidePermission(page.pageId, request.id, allow, saved);
    setNotice(saved ? `이 프로필에서 같은 상위 사이트와 요청 출처의 ${allow ? "허용" : "거절"} 결정을 저장했습니다.` : allow ? "이번 요청을 허용했습니다." : "이번 요청을 거절했습니다.");
  };
  return <FeatureDialog title="이 웹 탭의 다운로드·권한" description="현재 페이지와 프로필에 속한 요청만 표시합니다. 설정을 바꾸거나 권한을 결정하면 직접 조작으로 전환합니다." onClose={onClose}>
    <div className="browser-tools">
      {error ? <p role="alert" className="browser-error">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {pending.current ? <div className="browser-pending"><span>보관 결과 확인이 필요합니다. 같은 요청의 결과를 다시 확인할 수 있습니다.</span><button type="button" className="button small" disabled={busy} onClick={() => void run(() => { const value = pending.current!; return save(value.kind, value.kind === "download" ? value.downloadId : undefined); })}>보관 결과 다시 확인</button><button type="button" className="ghost-button small" disabled={busy} onClick={() => { pending.current = null; void run(refresh); }}>목록 확인 후 다른 자료 선택</button></div> : null}
      <section aria-labelledby="browser-download-title">
        <h3 id="browser-download-title">다운로드</h3>
        <p className="muted">먼저 저장 폴더를 고른 뒤 사이트에서 다운로드하세요. 이름이 겹쳐도 기존 파일을 덮어쓰지 않습니다. 저장 폴더를 지우면 이후 다운로드를 막습니다.</p>
        <p className="browser-file-path">{native?.downloadDirectory ?? "아직 저장 폴더를 고르지 않았습니다."}</p>
        <div className="browser-tools-actions"><button type="button" className="button small" disabled={busy || !ready || !native?.capabilities.includes("downloads")} onClick={() => void run(chooseDirectory)}>저장 폴더 선택</button><button type="button" className="ghost-button small" disabled={busy || !ready || !native?.downloadDirectory} onClick={() => void run(async () => { await browser.downloadDirectory(page.pageId, null); })}>저장 폴더 지우기</button></div>
        {!downloads.length ? <p className="muted">이 탭에서 시작한 다운로드가 없습니다.</p> : <ol className="browser-tools-list">{downloads.slice().reverse().map(download => <li key={download.id}>
          <div><strong>{download.name}</strong><span className="browser-record-status">{downloadLabel[download.status]}{download.size === null ? "" : ` · ${sizeText(download.size)}`}</span></div>
          <small>{featureTime(download.requestedAt)}</small><p className="browser-file-path">{download.path ?? download.url}</p>
          {download.error ? <p className="browser-error">{download.error}</p> : null}
          {download.status === "downloading" ? native?.capabilities.includes("download_cancel") ? <button type="button" className="button small" disabled={busy || !ready} onClick={() => void run(async () => { await browser.cancelDownload(page.pageId, download.id); })}>다운로드 취소</button> : <p className="muted">이 플랫폼의 현재 API는 앱에서 진행 중 다운로드를 취소할 수 없습니다.</p> : null}
          {download.status === "completed" ? download.sha256 && (download.size ?? Infinity) <= MAX_FILE ? <button type="button" className="button small" disabled={busy || !!pending.current || outputs.some(output => output.downloadId === download.id)} onClick={() => void run(() => save("download", download.id))}>{outputs.some(output => output.downloadId === download.id) ? "작업공간에 보관됨" : "작업공간에 보관"}</button> : <p className="muted">25MB가 넘는 파일은 다운로드 폴더에서 사용할 수 있습니다.</p> : null}
        </li>)}</ol>}
      </section>
      <section aria-labelledby="browser-permission-title">
        <h3 id="browser-permission-title">사이트 권한 요청</h3>
        <p className="muted">지원 항목: {(native?.permissionSupport ?? []).map(kind => kinds[kind] ?? kind).join(", ") || "확인할 수 없음"}. 운영체제의 별도 카메라·마이크 권한도 필요할 수 있습니다.</p>
        {!native?.capabilities.includes("permission_decision") ? <p className="muted">이 환경에서는 앱의 요청별 권한 결정을 지원하지 않습니다. 허용되지 않은 요청은 차단합니다.</p> : <p className="muted">대기 요청은 60초 또는 페이지 이동 후 만료됩니다. 저장을 선택하지 않으면 이번 요청에만 적용합니다.</p>}
        {!native?.capabilities.includes("permission_persistence") ? <p className="muted">현재 API는 실제 요청 프레임의 출처를 제공하지 않아 사이트 권한을 저장하지 않습니다. 표시된 페이지 주소는 상위 페이지이며 요청 출처를 뜻하지 않습니다.</p> : <p className="muted">저장한 결정은 이 프로필의 상위 사이트·요청한 출처·권한 종류가 모두 같은 요청에만 적용합니다.</p>}
        {!permissions.length ? <p className="muted">이 탭에서 받은 권한 요청이 없습니다.</p> : <ol className="browser-tools-list">{permissions.slice().reverse().map(request => <li key={request.id}>
          <div><strong>{kinds[request.kind] ?? request.kind}</strong><span className="browser-record-status">{request.remembered ? `저장된 결정 · ${request.status === "allowed" ? "허용" : "거절"}` : permissionLabel[request.status]}</span></div><p className="browser-file-path">상위 페이지 {request.topLevelOrigin ?? request.pageUrl}</p><p className="browser-file-path">요청 출처 {request.requestingOrigin ?? "API가 제공하지 않음"}</p><small>{featureTime(request.requestedAt)}</small>
          {request.status === "pending" && native?.capabilities.includes("permission_decision") ? <>
            {native.capabilities.includes("permission_persistence") && request.requestingOrigin && request.topLevelOrigin ? <label className="browser-permission-remember"><input type="checkbox" checked={!!remember[request.id]} disabled={busy} onChange={event => setRemember(current => ({ ...current, [request.id]: event.target.checked }))} />이 프로필에서 같은 사이트·출처의 결정을 기억</label> : null}
            <div className="browser-tools-actions"><button type="button" className="button small" disabled={!ready || busy || request.expiresAt <= Date.now()} onClick={() => void run(() => decide(request, true))}>{remember[request.id] ? "허용하고 저장" : "이번 요청 허용"}</button><button type="button" className="ghost-button small" disabled={!ready || busy || request.expiresAt <= Date.now()} onClick={() => void run(() => decide(request, false))}>{remember[request.id] ? "거절하고 저장" : "이번 요청 거절"}</button></div>
          </> : null}
        </li>)}</ol>}
      </section>
      <section aria-labelledby="browser-saved-permission-title">
        <h3 id="browser-saved-permission-title">이 프로필에 저장한 사이트 권한</h3><p className="muted">삭제하면 같은 프로필의 해당 상위 사이트 탭을 새로고칩니다. 작성 중인 사이트 입력은 먼저 저장해 주세요. 이후 요청은 다시 결정합니다.</p>
        {!native?.sitePermissions?.length ? <p className="muted">저장한 권한이 없습니다.</p> : <ol className="browser-tools-list">{native.sitePermissions.map(rule => <li key={rule.id}><div><strong>{kinds[rule.kind] ?? rule.kind}</strong><span>{rule.allow ? "허용" : "거절"}</span></div><p className="browser-file-path">상위 사이트 {rule.topLevelOrigin}</p><p className="browser-file-path">요청 출처 {rule.requestingOrigin}</p><small>{featureTime(rule.updatedAt)}</small><button className="button small" type="button" disabled={!ready || busy} onClick={() => void run(async () => { await browser.forgetSitePermission(page.pageId, rule.id); setNotice("저장된 결정을 삭제하고 같은 프로필의 해당 사이트 탭을 새로고쳤습니다."); })}>저장한 권한 삭제·사이트 탭 새로고침</button></li>)}</ol>}
      </section>
      <section aria-labelledby="browser-output-title">
        <h3 id="browser-output-title">작업공간에 보관한 웹 자료</h3>
        <p className="muted">페이지 본문과 완료한 다운로드를 이 탭의 작업공간에 복사합니다. 원본 주소·프로필·대화 연결과 고정된 첨부 내용을 함께 기록합니다. 다운로드 파일을 자동 실행하지 않습니다.</p>
        <div className="browser-tools-actions"><button type="button" className="button small" disabled={!ready || busy || !!pending.current} onClick={() => void run(() => save("page-text"))}>현재 페이지 본문 보관</button><button type="button" className="ghost-button small" disabled={busy} onClick={() => void run(refresh)}>목록 새로고침</button></div>
        {!outputs.length ? <p className="muted">보관한 자료가 없습니다.</p> : <ol className="browser-tools-list">{outputs.map(output => <li key={output.id}>
          <div><strong>{output.attachment.name}</strong><small>{featureTime(output.createdAt)}</small></div><p className="browser-file-path">{output.sourceUrl}</p>
          <AttachmentStrip attachments={[output.attachment]} /><p className="browser-file-path">{output.attachment.reference?.canonicalPath}</p>
          {output.artifact ? <button type="button" className="button small" onClick={() => { onClose(); onOpenArtifact(output.artifact!.id); }}>문서 열기</button> : <p className="muted">이 파일은 작업공간의 Browser 폴더에 보관되어 있습니다.</p>}
        </li>)}</ol>}
      </section>
      <p className="muted">{native?.capabilities.includes("persistent_profile") ? "이 프로필은 브라우저의 로컬 저장소를 사용합니다." : "이 환경의 프로필은 임시 저장소입니다. 앱을 다시 시작하면 로그인 상태를 유지하지 않습니다."}</p>
    </div>
  </FeatureDialog>;
}
