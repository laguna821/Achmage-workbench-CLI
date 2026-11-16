import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { versionWith, type AppUpdateAction, type AppUpdateStatus } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { PathDetail, SettingsRow, SettingsSwitch } from "./SettingsSheet.tsx";

// 설정 › 정보 › 업데이트 (app-update brief): the installed version, whether a newer one is published, and one
// key that downloads, checks and installs it. The gateway decides the address, the file and the version from
// the signed manifest; this window only names an action. A phone or another PC never shows it.

const WORKING: AppUpdateStatus["state"][] = ["checking", "downloading", "verifying", "waiting", "installing"];

/** The update state for the window; polled only while something is under way, else every hour. */
export function useAppUpdate(api: Api | null, enabled: boolean) {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const read = useCallback(async () => {
    if (!api || !enabled) return;
    try { setStatus(await api.request<AppUpdateStatus>("GET", "/api/host/app-update")); } catch { /* an older gateway: no row */ }
  }, [api, enabled]);
  useEffect(() => {
    void read();
    // The gateway's quiet check runs shortly after its start; read again once it has had time.
    const soon = window.setTimeout(() => void read(), 30_000), hourly = window.setInterval(() => void read(), 3_600_000);
    return () => { window.clearTimeout(soon); window.clearInterval(hourly); };
  }, [read]);
  const working = !!status && WORKING.includes(status.state);
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => void read(), 700);
    return () => window.clearInterval(timer);
  }, [working, read]);
  const act = useCallback(async (action: AppUpdateAction) => {
    if (!api) return;
    try { setStatus(await api.request<AppUpdateStatus>("POST", "/api/host/app-update", { action })); } catch { void read(); }
  }, [api, read]);
  return { status, act, refresh: read };
}

/** 설정's "something new here" mark: a newer version is published (never a banner or a dialog). */
export const updateMarked = (status: AppUpdateStatus | null) => !!status && ["available", "saved"].includes(status.state) && !!status.available;

const key = (label: string, onClick: () => void, primary = false, disabled = false) =>
  <button type="button" className={`button small${primary ? " primary" : ""}`} disabled={disabled} onClick={onClick}>{label}</button>;

export function AppUpdateRows({ status, act, onOpenUrl, onReveal, onQuit }: {
  status: AppUpdateStatus;
  act(action: AppUpdateAction): void;
  onOpenUrl(url: string): void;
  onReveal?(path: string): void;
  /** The desktop window closes itself so the helper can install (the gateway has already stopped). */
  onQuit?(): void;
}) {
  const quitAsked = useRef(false);
  useEffect(() => {
    if (status.state === "installing" && !quitAsked.current) { quitAsked.current = true; onQuit?.(); }
  }, [status.state, onQuit]);
  const next = status.available;
  const notes = next ? <a href={next.releaseUrl} onClick={(event) => { event.preventDefault(); onOpenUrl(next.releaseUrl); }}>바뀐 점 보기</a> : null;
  let state: { text: string; tone?: "" | "ok" | "warn" } | undefined;
  let hint: ReactNode = null, control: ReactNode = null, detail: ReactNode = null;
  switch (status.state) {
    case "idle": control = key("업데이트 확인", () => act("check")); break;
    case "checking": state = { text: "확인하는 중" }; control = key("업데이트 확인", () => undefined, false, true); break;
    case "latest": state = { text: "최신 버전입니다", tone: "ok" }; control = key("업데이트 확인", () => act("check")); break;
    case "available":
      state = { text: `${versionWith(next?.version ?? "", "이")} 나왔습니다`, tone: "warn" };
      hint = notes;
      control = key(status.installable ? "업데이트" : "내려받기", () => act("install"), true);
      break;
    case "downloading": state = { text: `내려받는 중 ${status.progress ?? 0}%` }; hint = <progress className="update-progress" max={100} value={status.progress ?? 0} aria-label="내려받는 중" />; break;
    case "verifying": state = { text: "확인하는 중" }; hint = "내려받은 파일이 게시된 것과 같은지 확인합니다."; break;
    case "blocked":
    case "waiting":
      state = { text: status.state === "waiting" ? "작업이 끝나기를 기다리는 중" : "끝나지 않은 작업이 있습니다", tone: "warn" };
      hint = status.state === "waiting" ? "아래 작업이 끝나면 바로 설치합니다. 진행 중인 작업은 멈추지 않고, 새 작업은 업데이트 뒤에 시작할 수 있습니다."
        : "아래 작업이 끝나야 설치할 수 있습니다. 진행 중인 작업은 멈추지 않습니다.";
      detail = <ul className="update-blockers">{status.blockers.map((blocker) => <li key={`${blocker.kind}:${blocker.id}`}>{blocker.label}</li>)}</ul>;
      control = <>{status.state === "blocked" ? key("작업이 끝나면 업데이트", () => act("wait"), true) : null}{key("취소", () => act("cancel"))}</>;
      break;
    case "installing": state = { text: "설치하는 중" }; hint = "앱이 잠시 닫혔다 다시 열립니다. 대화와 문서는 그대로 남습니다."; break;
    case "saved":
      state = { text: "설치 파일을 받아 두었습니다", tone: "ok" };
      hint = status.saved?.instruction;
      detail = <PathDetail value={status.saved?.path} label="받아 둔 곳 보기" />;
      control = <>{status.saved && onReveal ? key("폴더에서 보기", () => onReveal(status.saved!.path), true) : null}{key("닫기", () => act("dismiss"))}</>;
      break;
    case "failed":
      state = { text: "업데이트하지 못했습니다", tone: "warn" };
      hint = status.message;
      control = key(next ? "다시 시도" : "업데이트 확인", () => act(next ? "install" : "check"));
      break;
  }
  // After the restart: one quiet line under the version (gone with the next check).
  if (status.lastResult && (status.state === "idle" || status.state === "latest") && !hint)
    hint = <span className={`update-result ${status.lastResult.ok ? "ok" : "warn"}`}>{status.lastResult.message}</span>;
  return <>
    <SettingsRow className="update-row" label={<>Achmage Workbench <span className="update-version">버전 {status.installed}</span></>} state={state} hint={hint} control={control} detail={detail} />
    <SettingsRow label="새 버전 자동으로 확인" hint="하루에 한 번 게시된 판 번호만 확인합니다. 이 컴퓨터나 사용자에 대한 정보는 보내지 않고, 저절로 설치하지 않습니다."
      control={<SettingsSwitch label="새 버전 자동으로 확인" checked={status.autoCheck} onChange={(on) => act(on ? "auto-on" : "auto-off")} />} />
  </>;
}
