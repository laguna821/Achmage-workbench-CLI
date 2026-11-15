import { useEffect, useState, type ReactNode } from "react";
import type { Api } from "../api.ts";
import { EDITOR_AI_DIFFERENCE, editorAiShown, setEditorAiShown } from "../editor-ai.ts";
import { type AgentBrowserStatus, type DocumentTools, type Provider, type ProviderStatus, type ToolStatus } from "@workbench/contracts";
import webPackage from "../../package.json";
import { BrowserEngine, BrowserInstall, BrowserLogin, type BrowserActions } from "./BrowserPill.tsx";
import { capital, EngineCard, usageWords, type EngineActions } from "./EngineSetup.tsx";
import { PathDetail, SettingsGroup, SettingsRow, SettingsSwitch } from "./SettingsSheet.tsx";
import { Segmented } from "./ui/Hig.tsx";
import { MESSENGER_NEEDS } from "./phone-words.ts";

// The rows of 설정 (release unit B). Each section is one component; App gives them the actions
// the old ⋯ pile had, so every control keeps its behaviour (rel-b report: old → new).

export const APP_VERSION: string = webPackage.version;

/** A document tool's state in a teacher's words: whether it is here and ready, never "OS 등록". */
export function toolState(status: ToolStatus) {
  if (status.setup === "error") return { text: "준비가 멈춤", tone: "warn" as const };
  if (status.setup === "checking") return { text: "확인 중", tone: "" as const };
  if (status.setup === "registering") return { text: "연결하는 중", tone: "" as const };
  if (status.busy || status.setup === "installing") return { text: "설치 중", tone: "" as const };
  if (status.registered === true) return { text: "연결됨", tone: "ok" as const };
  if (status.registered === false && status.available) return { text: "연결 필요", tone: "warn" as const };
  if (status.bundled) return { text: "앱에 들어 있음", tone: "ok" as const };
  if (status.available) return { text: "쓸 수 있음", tone: "ok" as const };
  return { text: "아직 없음", tone: "warn" as const };
}

const key = (label: string, onClick: () => void, extra: { primary?: boolean; disabled?: boolean; haspopup?: boolean } = {}) =>
  <button type="button" className={`button small${extra.primary ? " primary" : ""}`} disabled={extra.disabled} aria-haspopup={extra.haspopup ? "dialog" : undefined} onClick={onClick}>{label}</button>;

// ── 일반 ─────────────────────────────────────────────────────────────────────────────────────

export function GeneralSection({ startScreen, onStartScreen, notifications, onNotifications, brandMotion, onBrandMotion, worksDir, background, bookmarks, onPropertyTemplate, shortcutSettings, onOnboarding }: {
  startScreen: "home" | "last"; onStartScreen(next: "home" | "last"): void;
  notifications: boolean; onNotifications(next: boolean): void;
  brandMotion: boolean; onBrandMotion(next: boolean): void;
  /** 프로젝트 기본 폴더 (WorksDirRow). */
  worksDir?: ReactNode;
  /** 앱을 닫아도 계속 (BackgroundHost). */
  background?: ReactNode;
  /** 웹 즐겨찾기 (BookmarkSettings): its own group. */
  bookmarks?: ReactNode;
  onPropertyTemplate?: () => void;
  shortcutSettings?: ReactNode;
  onOnboarding(): void;
}) {
  return <>
    <SettingsGroup title="앱을 열면">
      <SettingsRow label="처음 보이는 화면" hint="앱을 열 때 지금 화면으로 시작할지, 마지막에 보던 작업으로 시작할지 고릅니다."
        control={<Segmented label="앱을 열면" className="theme-choice" value={startScreen} onChange={onStartScreen} options={[{ value: "home", label: "지금" }, { value: "last", label: "마지막 작업" }]} />} />
      <SettingsRow label="지금 화면의 로고 움직임" hint="지금 화면을 열 때 로고가 잠깐 움직입니다."
        control={<SettingsSwitch label="지금 화면의 로고 움직임" checked={brandMotion} onChange={onBrandMotion} />} />
      <SettingsRow label="끝나면 알림 보내기" hint="창이 뒤에 있을 때 답이 오거나, 확인이 필요하거나, 실패하면 컴퓨터 알림으로 알립니다."
        control={<SettingsSwitch label="끝나면 알림 보내기" checked={notifications} onChange={onNotifications} />} />
      {background}
    </SettingsGroup>
    <SettingsGroup title="프로젝트">
      {worksDir}
      {onPropertyTemplate ? <SettingsRow label="프로젝트 속성 템플릿" hint="모든 프로젝트의 속성 칸(단계, 마감 …)이 따르는 틀입니다." control={key("템플릿 고치기…", onPropertyTemplate, { haspopup: true })} /> : null}
    </SettingsGroup>
    {bookmarks}
    {shortcutSettings ? <SettingsGroup title="단축키">
      <SettingsRow label="키 조합 바꾸기" hint="칸을 누르고 새 조합을 누릅니다. Esc는 그만두기, Backspace는 기본값으로 되돌리기입니다." detail={shortcutSettings} />
    </SettingsGroup> : null}
    <SettingsGroup title="처음 안내">
      <SettingsRow label="처음 안내 다시 보기" hint="화면 고르기, AI 엔진 연결, 첫 프로젝트, 휴대폰 연결을 차례로 다시 봅니다." control={key("다시 보기", onOnboarding)} />
    </SettingsGroup>
  </>;
}

// ── AI 엔진 ──────────────────────────────────────────────────────────────────────────────────

/** The agent browser: installed or not, and signing in once for every conversation. */
function BrowserRow({ status, actions }: { status: AgentBrowserStatus; actions: BrowserActions }) {
  const install = status.install;
  const lightpanda = status.engine === "lightpanda";
  const state = install.state === "ready" ? { text: "준비됨", tone: "ok" as const } : install.state === "installing" ? { text: "설치 중", tone: "" as const } : install.state === "error" ? { text: "설치 실패", tone: "warn" as const } : { text: "없음", tone: "warn" as const };
  return <SettingsRow className="browser-connection" label="AI가 쓰는 웹 브라우저" state={state}
    hint={lightpanda ? "화면 없이 AI의 웹 탐색과 자료 모으기를 처리합니다." : "로그인이 필요한 사이트와 화면 확인에 씁니다."}
    detail={<>
      <BrowserEngine status={status} actions={actions} />
      <BrowserInstall status={status} actions={actions} />
      {install.state === "ready" && !lightpanda ? <><p className="settings-note">AI와 같은 브라우저에 한 번 로그인해 두면 모든 대화가 씁니다.</p><BrowserLogin status={status} actions={actions} /></> : null}
      {install.state === "ready" ? <PathDetail value={`${lightpanda ? "Lightpanda" : "Chromium"} ${install.browserVersion ?? ""}`.trim()} label="판 보기" /> : null}
    </>} />;
}

export function EnginesSection({ providers, connected, engineActions, onRefresh, browser, browserActions, onIntegrations, voice }: {
  providers: Partial<Record<Provider, ProviderStatus>>;
  connected: boolean;
  engineActions: EngineActions;
  onRefresh(): void;
  browser: AgentBrowserStatus | null;
  browserActions: BrowserActions;
  onIntegrations(): void;
  /** 음성 모델 (the first run's model cache, now here). */
  voice?: ReactNode;
}) {
  return <>
    <p className="settings-lead">이 컴퓨터에서 찾은 AI 엔진입니다. 로그인은 각 엔진의 로그인 페이지에서 하며, 암호를 이 앱에 넣지 않습니다.</p>
    {!connected ? <p className="settings-error" role="alert">앱 안의 연결이 잠시 끊겼습니다. 다시 연결하는 중입니다.</p> : null}
    <SettingsGroup title="엔진" action={<button type="button" className="text-button" onClick={onRefresh}>상태 다시 확인</button>}>
      {(["claude", "codex"] as const).map((provider) => {
        const status = providers[provider];
        return <div key={provider} className="settings-engine">
          <EngineCard provider={provider} status={status} actions={engineActions}>
            {status?.account ? <p className="settings-note">{status.account}{status.plan ? ` (${capital(status.plan)})` : ""}</p> : null}
            {status?.usage.length ? <ul className="settings-facts">{status.usage.map((window) => <li key={window.label}>{usageWords(window)}</li>)}</ul>
              : status?.loggedIn ? <p className="settings-note">사용량은 첫 요청 뒤에 보입니다.</p> : null}
          </EngineCard>
        </div>;
      })}
    </SettingsGroup>
    <SettingsGroup title="엔진이 함께 쓰는 것">
      {browser ? <BrowserRow status={browser} actions={browserActions} /> : null}
      <SettingsRow label="엔진이 함께 쓰는 도구" hint="Claude와 Codex가 함께 쓰는 도구와 양식을 나란히 보고, 한쪽에 있는 것을 다른 쪽에도 넣습니다."
        control={key("열기…", onIntegrations, { haspopup: true })} />
      {voice ? <SettingsRow label="음성 모델" hint="받아쓰기와 읽어주기에 쓰는 모델입니다. 받는 것은 선택입니다." detail={voice} /> : null}
    </SettingsGroup>
  </>;
}

// ── 휴대폰과 다른 기기 ──────────────────────────────────────────────────────────────────────

export function DevicesSection({ panel, onConnections, onPush, onMessenger, local }: {
  /** 기기 연결 itself, in place (ConnectedWorkbench owns its state). */
  panel?: ReactNode;
  /** Without the panel: the 기기 연결 dialog. */
  onConnections?: () => void;
  onPush?: () => void;
  onMessenger?: () => void;
  /** This window runs on the PC itself (not a phone joined to it). */
  local: boolean;
}) {
  return <>
    <p className="settings-lead">휴대폰에서 이 PC의 AI에게 일을 시키는 길은 둘입니다. 메신저가 가장 쉽습니다. 휴대폰 화면으로 직접 열려면 휴대폰이 열 수 있는 이 PC의 주소를 ‘연결 주소 설정’에 직접 넣어야 합니다. 같은 와이파이에 있어도 저절로 되지 않습니다.</p>
    <SettingsGroup title="휴대폰에서 쓰기">
      {local && onMessenger && !panel ? <SettingsRow label="메신저로 쓰기" hint={`텔레그램이나 Slack 대화로 일을 시키고 결과를 받습니다. ${MESSENGER_NEEDS}`} control={key("메신저 설정", onMessenger)} /> : null}
      {onPush ? <SettingsRow label="휴대폰 알림" hint="허용한 기기에 작업이 끝나거나, 실패하거나, 확인이 필요할 때 알립니다." control={key("알림 설정…", onPush, { haspopup: true })} /> : null}
      {!panel && onConnections ? <SettingsRow label="기기 연결" hint="휴대폰이나 다른 PC를 이 PC에 연결하고, 연결한 기기를 관리합니다." control={key("기기 연결…", onConnections, { haspopup: true })} /> : null}
    </SettingsGroup>
    {panel ? <div className="settings-embedded">{panel}</div> : null}
  </>;
}

// ── 문서 도구 ────────────────────────────────────────────────────────────────────────────────

/** The editors' own AI 도우미, shown or hidden (I7); what it is beside 문서 AI in one line. */
export function EditorAiRow({ api }: { api: Api }) {
  const [shown, setShown] = useState<boolean | null>(null), [problem, setProblem] = useState("");
  useEffect(() => {
    let live = true;
    void editorAiShown(api).then((value) => { if (live) setShown(value); }).catch(() => { if (live) setProblem("지금은 이 설정을 읽지 못했습니다. 잠시 뒤 다시 열어 보세요."); });
    return () => { live = false; };
  }, [api]);
  return <SettingsRow label="편집기 안 AI 도우미 보이기" hint={EDITOR_AI_DIFFERENCE}
    control={<SettingsSwitch label="편집기 안 AI 도우미 보이기" checked={shown ?? true} disabled={shown === null}
      onChange={(next) => { setProblem(""); void setEditorAiShown(api, next).then(setShown).catch(() => setProblem("바꾸지 못했습니다. 잠시 뒤 다시 해 보세요.")); }} />}
    detail={problem ? <p className="settings-note" role="alert">{problem}</p> : undefined} />;
}

export function DocumentsSection({ tools, onInstallIeum, onRefreshTools, onOfficeSettings, onDropbox, onOfficeImport, onKnowledge, imageUpload, vault, editorAi }: {
  tools: DocumentTools | null;
  onInstallIeum(): void;
  onRefreshTools(): void;
  onOfficeSettings?: () => void;
  onDropbox?: () => void;
  onOfficeImport?: () => void;
  onKnowledge?: () => void;
  /** 문서에 붙여 넣는 그림 (ImageUploadRow). */
  imageUpload?: ReactNode;
  /** 볼트 (VaultSettingsRow). */
  vault?: ReactNode;
  /** 편집기 안 AI 도우미 보이기 (EditorAiRow). */
  editorAi?: ReactNode;
}) {
  const rows = tools ? [
    { key: "hwp", name: "한글 문서 편집기", role: "앱 안에서 HWP와 HWPX 문서를 열고 고치고 저장합니다.", status: tools.hwp },
    { key: "ieumoffice", name: "워드, 파워포인트, 엑셀 편집기", role: "앱 안에서 편집하고 저장하며, 문서 AI가 함께 고칩니다.", status: tools.ieumoffice },
    { key: "pdf", name: "PDF 편집기", role: "앱 안에서 PDF에 메모하고 쪽을 정리해 사본으로 저장합니다.", status: tools.pdf },
    { key: "kordoc", name: "한글 보고서 만들기", role: "Markdown이나 양식으로 HWPX 보고서를 만듭니다. 직접 설치한 스킬이 있으면 그것을 씁니다.", status: tools.kordoc },
    { key: "ieumApp", name: "이음오피스 앱", role: "같은 파일을 이음오피스 앱으로 열고, 저장한 내용을 이어받습니다.", status: tools.ieumApp },
  ].filter((row): row is { key: string; name: string; role: string; status: ToolStatus } => Boolean(row.status)) : [];
  return <>
    <SettingsGroup title="문서 편집기" action={<button type="button" className="text-button" onClick={onRefreshTools}>문서 도구 다시 확인</button>}>
      {!tools ? <SettingsRow label="문서 도구" hint="이 컴퓨터에서 확인하는 중입니다." /> : null}
      {rows.map((row) => {
        const state = toolState(row.status);
        return <SettingsRow key={row.key} label={row.name} state={state} hint={row.role}
          control={row.key === "ieumApp" && !row.status.busy ? key(row.status.available ? "연결과 업데이트…" : "설치하고 연결…", onInstallIeum, { haspopup: true }) : undefined}
          detail={<>{row.status.message ? <p className="settings-note">{row.status.message}</p> : null}<PathDetail value={row.status.path ? [row.status.path, row.status.version ? `판 ${row.status.version}` : ""].filter(Boolean).join("\n") : null} label="자세히" /></>} />;
      })}
      {onOfficeSettings ? <SettingsRow label="문서 AI" hint="문서 편집기 안의 AI가 쓰는 엔진과 고치는 방식을 정합니다." control={key("문서 AI 설정…", onOfficeSettings, { haspopup: true })} /> : null}
      {editorAi}
      {onOfficeImport ? <SettingsRow label="이음오피스 설정 가져오기" hint="이음오피스 앱에서 쓰던 설정을 이 앱으로 가져옵니다." control={key("이음오피스 설정 가져오기…", onOfficeImport, { haspopup: true })} /> : null}
    </SettingsGroup>
    <SettingsGroup title="문서가 있는 곳">
      {onDropbox ? <SettingsRow label="Dropbox" hint="Dropbox가 동기화하는 폴더의 문서를 옮기지 않고 그 자리에서 엽니다." control={key("Dropbox 폴더 연결…", onDropbox, { haspopup: true })} /> : null}
      {vault}
      {onKnowledge ? <SettingsRow label="지식베이스" hint="모아 둔 자료를 찾고 대화에 붙입니다." control={key("지식베이스…", onKnowledge, { haspopup: true })} /> : null}
      {imageUpload}
    </SettingsGroup>
  </>;
}

// ── 고급 ─────────────────────────────────────────────────────────────────────────────────────

export function AdvancedSection({ onDesktop, onExtensions, onEventHub }: { onDesktop?: () => void; onExtensions?: () => void; onEventHub?: () => void }) {
  if (!onDesktop && !onExtensions && !onEventHub) return <p className="settings-lead">이 기기에서는 고급 기능을 설정할 수 없습니다. 작업하는 PC의 앱에서 설정하세요.</p>;
  return <>
    <p className="settings-lead">필요할 때만 켜는 기능입니다. 처음에는 쓰지 않아도 됩니다.</p>
    <SettingsGroup title="선택 기능">
      {onDesktop ? <SettingsRow label="다른 앱 창과 함께 일하기" hint="작업할 앱 창을 대화에 연결한 뒤 채팅에서 요청합니다. 창마다 작업 기록을 남깁니다." control={key("외부 앱…", onDesktop, { haspopup: true })} /> : null}
      {onExtensions ? <SettingsRow label="확장 기능" hint="설치한 확장의 출처와 권한을 확인하고 필요한 것만 실행합니다." control={key("실행 확장…", onExtensions, { haspopup: true })} /> : null}
      {onEventHub ? <SettingsRow label="이벤트 받기" hint="허용한 GitHub, Slack, Discord 소식을 정해 둔 작업에 전합니다." control={key("이벤트 받기…", onEventHub, { haspopup: true })} /> : null}
    </SettingsGroup>
  </>;
}

// ── 정보 ─────────────────────────────────────────────────────────────────────────────────────

export function AboutSection({ hostLabel, licences }: { hostLabel: string; licences?: ReactNode }) {
  return <>
    <SettingsGroup title="이 앱">
      <SettingsRow label="Achmage Workbench" hint={`판 ${APP_VERSION}`} />
      <SettingsRow label="이 앱이 일하는 컴퓨터" hint={hostLabel} />
      {/* Icons8's free licence asks for this link (vendor/icons8-liquid-glass/NOTICE.md): the item icons are theirs. */}
      <SettingsRow label="아이콘: Icons8" hint={<>프로젝트, 폴더, 대화, 문서의 아이콘은 <a href="https://icons8.com" target="_blank" rel="noreferrer">Icons8</a>의 Liquid Glass 아이콘입니다.</>} />
    </SettingsGroup>
    <SettingsGroup title="오픈소스 라이선스">
      {/* LicenceList (generated from the shipped notices); the slot keeps its place even while it is empty. */}
      <div className="settings-slot" data-slot="licences">{licences}</div>
      {licences ? null : <SettingsRow label="함께 쓴 오픈소스" hint="이 앱이 함께 쓰는 오픈소스와 그 라이선스는 앱과 함께 설치된 third_party 폴더에 있습니다." />}
    </SettingsGroup>
  </>;
}
