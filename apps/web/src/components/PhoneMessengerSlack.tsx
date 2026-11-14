import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ChannelKind, ChannelsState } from "@workbench/contracts";
import { ApiRequestError, type Api } from "../api.ts";
import { featureError } from "./FeatureDialog.tsx";

// The Slack branch of "휴대폰 메신저" (design m02 §4.2): the app manifest to copy, the steps in
// plain Korean, the two tokens in masked fields, and the line the person sends in the app's DM to
// pair. Slack's own screens are in English, so their button names are given as Slack shows them.
// The token fields are not bound to React state: a value is never written back into the page.

/** Slack's limit for an app's name (manifest `display_information.name`: "Maximum length is 35 characters"). */
const NAME_LIMIT = 35;
const SCOPES = ["chat:write", "im:history", "files:read", "files:write", "users:read"];

/**
 * The app as Slack's "From a manifest" editor takes it, in YAML or JSON (its editor has both tabs).
 * Scopes and why: chat:write answers, im:history reads the DM (its events and what was missed),
 * files:read / files:write take and send files, users:read names who wrote.
 */
export function slackManifest(name: string, format: "yaml" | "json"): string {
  const shown = [...(name.trim() || "Workbench")].slice(0, NAME_LIMIT).join("");
  const manifest = {
    display_information: { name: shown, description: "이 PC의 AI에게 일을 시키는 개인용 앱입니다. PC가 켜져 있을 때 답합니다." },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: shown, always_online: false },
    },
    oauth_config: { scopes: { bot: SCOPES } },
    settings: { event_subscriptions: { bot_events: ["message.im"] }, interactivity: { is_enabled: true }, org_deploy_enabled: false, socket_mode_enabled: true, token_rotation_enabled: false },
  };
  if (format === "json") return `${JSON.stringify(manifest, null, 2)}\n`;
  const quoted = JSON.stringify(shown);
  return `display_information:
  name: ${quoted}
  description: ${manifest.display_information.description}
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: ${quoted}
    always_online: false
oauth_config:
  scopes:
    bot:
${SCOPES.map((scope) => `      - ${scope}`).join("\n")}
settings:
  event_subscriptions:
    bot_events:
      - message.im
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
`;
}

const RISKS = [
  "연결을 켜면, 연결한 Slack 계정을 쓸 수 있는 사람은 누구든 이 PC에 확인 없이 무엇이든 시킬 수 있습니다(저장해 둔 로그인과 카드 사용 포함).",
  "주고받는 글·사진·파일과 AI의 답은 Slack 회사와, 워크스페이스에 따라 그 관리자의 서버를 거쳐 그곳에 저장되며, 토큰이 새면 남이 그 대화를 엿보거나 가로챌 수 있습니다.",
];
const NO_KEYRING = "이 PC에는 토큰을 봉인해 둘 보안 저장소(키링)가 없습니다. 토큰을 평문으로 저장하지 않습니다.";

/** The messenger by name, as the dialog says it. */
export const messengerName = (kind: ChannelKind) => (kind === "slack" ? "Slack" : "텔레그램");

type Step = "create" | "install" | "tokens";
const STEPS: Step[] = ["create", "install", "tokens"];
/** The Workbench screens of the Slack way: the intro, these three, the pairing line, the approval. */
const NUMBER: Record<Step, string> = { create: "2 / 6단계", install: "3 / 6단계", tokens: "4 / 6단계" };
/** Where the person was, so a dialog closed while waiting for the workspace's admin opens there again. */
const PLACE = "workbench.phone-messenger.slack";
type Place = { step: Step; name: string };

export function slackPlace(): Place | null {
  try {
    const place = JSON.parse(localStorage.getItem(PLACE) ?? "null") as Partial<Place> | null;
    return place && STEPS.includes(place.step as Step) ? { step: place.step as Step, name: typeof place.name === "string" ? place.name : "" } : null;
  } catch { return null; }
}
export function forgetSlackPlace() {
  try { localStorage.removeItem(PLACE); } catch { /* No storage: nothing kept. */ }
}

export function SlackWizard({ api, openExternal, copy, readClipboard, onRegistered, onBack, setError }: {
  api: Api; openExternal(url: string): Promise<void>; copy(text: string): Promise<void>; readClipboard(): Promise<string>;
  onRegistered(state: ChannelsState): Promise<void>; onBack(): void; setError(value: string): void;
}) {
  const kept = useRef(slackPlace());
  const [step, setStep] = useState<Step>(kept.current?.step ?? "create"), [said, setSaid] = useState("");
  const [name, setName] = useState(kept.current?.name ?? "");
  const heading = useRef<HTMLHeadingElement>(null);
  // The PC's name makes the app's own (two colleagues' apps in one school workspace must not look the same).
  useEffect(() => {
    if (kept.current?.name) return;
    let live = true;
    void api.request<{ hostLabel?: string }>("GET", "/api/snapshot").then((snapshot) => { if (live) setName((current) => current || `Workbench · ${snapshot.hostLabel || "내 PC"}`); }).catch(() => { if (live) setName((current) => current || "Workbench · 내 PC"); });
    return () => { live = false; };
  }, [api]);
  useEffect(() => {
    try { localStorage.setItem(PLACE, JSON.stringify({ step, name } satisfies Place)); } catch { /* No storage: the place is not kept. */ }
  }, [step, name]);
  const go = (next: Step) => { setStep(next); setSaid(""); setError(""); };
  // The new step's heading takes the focus, so a keyboard or screen reader starts there.
  useEffect(() => { heading.current?.focus(); }, [step]);
  const index = STEPS.indexOf(step);
  const open = (url: string) => void openExternal(url).catch((reason) => setError(featureError(reason)));
  const copied = (format: "yaml" | "json") => void copy(slackManifest(name, format)).then(() => setSaid(`매니페스트를 ${format.toUpperCase()}로 복사했습니다.`)).catch((reason) => setError(featureError(reason)));
  const back = <button type="button" className="button small" onClick={() => { if (index) go(STEPS[index - 1]!); else { forgetSlackPlace(); onBack(); } }}>이전</button>;
  const next = <button type="button" className="button small primary" onClick={() => go(STEPS[index + 1]!)}>다음</button>;
  // The Slack tab may be gone after a day's wait for the admin: the app's settings page lists the app.
  const settings = <div className="feature-actions"><button type="button" className="button small" onClick={() => open("https://api.slack.com/apps")}>Slack 앱 설정 열기</button></div>;
  const shell = (title: string, body: ReactNode, nav: ReactNode) => <section className="pm-step" aria-label={NUMBER[step]}>
    <p className="pm-step-no">{NUMBER[step]}</p>
    <h3 ref={heading} tabIndex={-1}>{title}</h3>
    {body}
    {said ? <p className="pm-said" role="status">{said}</p> : null}
    <div className="feature-actions pm-nav">{nav}</div>
  </section>;

  if (step === "create") return shell("Slack 앱을 만듭니다.", <>
    <div className="pm-risks">{RISKS.map((line) => <p key={line}>{line}</p>)}</div>
    <label className="pm-name">앱 이름<input value={name} maxLength={NAME_LIMIT} spellCheck={false} onChange={(event) => setName(event.target.value)} /></label>
    <p className="pm-hint">Slack에서 이 이름으로 앱을 찾습니다. 같은 워크스페이스의 다른 사람 앱과 겹치지 않게 지어 주세요.</p>
    <div className="feature-actions">
      <button type="button" className="button" onClick={() => open("https://api.slack.com/apps?new_app=1")}>Slack 앱 만들기 열기</button>
    </div>
    <p className="pm-hint">브라우저에서 Slack 로그인을 먼저 하라고 나오면, 휴대폰 Slack과 같은 계정(같은 이메일)으로 로그인하세요. 워크스페이스 목록에는 로그인한 곳만 나옵니다.</p>
    <ol className="pm-steps-list">
      <li><b>From a manifest</b>를 누릅니다.</li>
      <li>쓸 워크스페이스를 고르고 <b>Next</b>를 누릅니다.</li>
      <li>편집 칸 위에 YAML과 JSON 탭이 있습니다. 보이는 탭에 맞는 것을 아래에서 복사해, 원래 있던 글을 지우고 붙여 넣은 뒤 <b>Next</b> → <b>Create</b>를 누릅니다.</li>
    </ol>
    <div className="feature-actions">
      <button type="button" className="button small" onClick={() => copied("yaml")}>YAML로 복사</button>
      <button type="button" className="button small" onClick={() => copied("json")}>JSON으로 복사</button>
    </div>
    <p className="pm-hint">앱은 DM으로 글과 파일을 주고받을 권한만 받습니다. 공개 주소 없이, 이 PC가 Slack에 연결해 받습니다.</p>
  </>, <>{back}{next}</>);

  if (step === "install") return shell("워크스페이스에 설치합니다.", <>
    <ol className="pm-steps-list">
      <li>만든 앱 화면의 왼쪽 메뉴에서 <b>Install App</b>을 누릅니다.</li>
      <li><b>Install to Workspace</b> → <b>Allow</b>를 누릅니다.</li>
    </ol>
    <p className="pm-hint">워크스페이스에 앱 승인이 켜져 있으면 <b>Allow</b> 대신 관리자에게 승인을 요청하는 화면이 나옵니다. 요청을 보내고 관리자 승인을 기다리세요. 승인 알림이 오면 <b>Install App</b>에서 <b>Install</b>을 한 번 더 누른 뒤 다음 단계로 가세요.</p>
    <p className="pm-hint">기다리는 동안 이 창을 닫았다가 다시 열어도 이 단계로 돌아옵니다.</p>
    {settings}
  </>, <>{back}{next}</>);

  return shell("토큰 두 개를 붙여 넣습니다.", <>
    <ol className="pm-steps-list">
      <li>왼쪽 <b>OAuth &amp; Permissions</b>의 <b>Bot User OAuth Token</b>(xoxb-로 시작)을 복사해 첫 칸에 넣습니다.</li>
      <li>왼쪽 <b>Basic Information</b>을 열고 페이지를 아래로 내리면 <b>App-Level Tokens</b>가 있습니다. <b>Generate Token and Scopes</b>에서 이름은 아무거나 적고, <b>Add Scope</b>로 <code>connections:write</code>를 고른 뒤 <b>Generate</b>를 누릅니다. 나온 토큰(xapp-로 시작)을 둘째 칸에 넣습니다.</li>
    </ol>
    {settings}
    <SlackTokenForm api={api} appName={name.trim()} readClipboard={readClipboard} onDone={async (state) => { forgetSlackPlace(); await onRegistered(state); }} />
  </>, back);
}

/**
 * Both tokens at once: the gateway checks them together and keeps both or neither. Without an OS
 * keyring the gateway refuses to store them (503); then they may be kept in memory for this run.
 */
export function SlackTokenForm({ api, readClipboard, onDone, onCancel, fresh = false, appName }: {
  api: Api; readClipboard(): Promise<string>; onDone(state: ChannelsState): Promise<void>; onCancel?(): void; fresh?: boolean; appName?: string;
}) {
  const bot = useRef<HTMLInputElement>(null), app = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false), [noKeyring, setNoKeyring] = useState(false), [hint, setHint] = useState(""), [error, setError] = useState("");
  const send = async (memoryOnly: boolean) => {
    const botToken = bot.current?.value.trim() ?? "", appToken = app.current?.value.trim() ?? "";
    if (!botToken || !appToken) { setError("두 칸을 모두 채워 주세요."); (botToken ? app : bot).current?.focus(); return; }
    setBusy(true); setError(""); setHint("");
    try {
      const next = await api.request<ChannelsState>("POST", "/api/channels/slack/bots", { botToken, appToken, ...(appName ? { appName } : {}), ...(memoryOnly ? { memoryOnly: true } : {}) });
      for (const field of [bot, app]) if (field.current) field.current.value = "";
      await onDone(next);
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.code === "office_vault_unavailable") { setNoKeyring(true); setError(NO_KEYRING); }
      else setError(featureError(reason));
      setBusy(false);
    }
  };
  const paste = (field: typeof bot) => void readClipboard().then((text) => {
    if (field.current) field.current.value = text.trim();
    field.current?.focus();
  }).catch(() => { setHint("붙여넣기를 쓸 수 없습니다. 칸을 누르고 Ctrl+V로 붙여 넣어 주세요."); field.current?.focus(); });
  const prefix = fresh ? "새 " : "";
  const field = (ref: typeof bot, label: string, placeholder: string) => <div className="pm-token-row">
    <label>{label}<input ref={ref} type="password" autoComplete="off" spellCheck={false} placeholder={placeholder} disabled={busy} aria-invalid={error ? true : undefined} /></label>
    <button type="button" className="button small" disabled={busy} aria-label={`${label} 붙여넣기`} onClick={() => paste(ref)}>붙여넣기</button>
  </div>;
  return <form className="pm-token" onSubmit={(event) => { event.preventDefault(); if (!busy) void send(false); }}>
    {field(bot, `${prefix}봇 토큰 (xoxb-)`, "xoxb-…")}
    {field(app, `${prefix}앱 토큰 (xapp-)`, "xapp-…")}
    {error ? <p className="notice notice-error" role="alert">{error}</p> : null}
    <div className="feature-actions">
      <button type="submit" className="button small primary" disabled={busy}>{busy ? "확인하는 중…" : "확인"}</button>
      {onCancel ? <button type="button" className="button small" disabled={busy} onClick={onCancel}>취소</button> : null}
    </div>
    {hint ? <p className="pm-hint">{hint}</p> : null}
    {noKeyring ? <div className="pm-memory">
      <button type="button" className="button small" disabled={busy} onClick={() => void send(true)}>이번 실행 동안만 기억</button>
      <p className="pm-hint">PC를 다시 켜거나 앱을 다시 열면 토큰을 다시 넣어야 합니다.</p>
    </div> : null}
  </form>;
}

/**
 * The pairing step on Slack: Slack has no start value in a link. While this window is open, the
 * person sends just "연결" in the app's DM (from the phone or the browser: the same account either
 * way) and the gateway presents the window's value for them. The whole line still works, second.
 * The window is cancelled when the dialog closes, like Telegram's QR.
 */
export function SlackPairingLine({ say, open, username, appName, left, until, copy, openExternal }: {
  say: string; open: string | null; username: string; appName?: string | undefined; left: string; until: string; copy(text: string): Promise<void>; openExternal(url: string): Promise<void>;
}) {
  const [said, setSaid] = useState("");
  // Search by the name the person typed; Slack's handle made from it may have lost its Korean letters.
  return <div className="pm-say">
    {open ? <div className="feature-actions"><button type="button" className="button small primary" onClick={() => void openExternal(open).catch(() => setSaid("브라우저를 열지 못했습니다. app.slack.com에 직접 들어가 주세요."))}>브라우저에서 Slack 열기</button></div> : null}
    {appName ? <>
      <p>이 PC에서: 브라우저 Slack의 왼쪽 위 검색에 “{appName}”를 넣어 앱을 열고, 메시지 칸에 “연결”이라고 보내세요.</p>
      <p>휴대폰 Slack에서 앱 이름 “{appName}”를 검색해 열고 “연결”이라고 보내세요.</p>
    </> : <>
      <p>이 PC에서: 브라우저 Slack의 왼쪽 위 검색에 @{username}을 넣어 앱을 열고, 메시지 칸에 “연결”이라고 보내세요.</p>
      <p>휴대폰 Slack에서 앱 이름(@{username})을 검색해 열고 “연결”이라고 보내세요.</p>
    </>}
    <p>그러면 Slack에 숫자 네 개가 나오고, 이 화면에도 같은 숫자가 나옵니다.</p>
    <p className="pm-hint"><span data-testid="pairing-countdown" aria-hidden="true">{left} 남음 · </span><span>이 화면이 열려 있는 동안({until}까지)만 받습니다.</span></p>
    <p className="pm-hint">“연결”이 통하지 않으면 이 줄을 그대로 보내도 됩니다.</p>
    <div className="pm-copy"><code data-testid="pairing-say">{say}</code><button type="button" className="button small" aria-label="연결 줄 복사" onClick={() => void copy(say).then(() => setSaid("복사했습니다. Slack에서 붙여 넣고 보내세요.")).catch(() => setSaid("복사하지 못했습니다. 줄을 직접 골라 복사해 주세요."))}>복사</button></div>
    <p className="pm-hint">Slack이 이 앱에는 메시지를 보낼 수 없다고 하면: api.slack.com의 앱 설정 → <b>App Home</b> → <b>Messages Tab</b>에서 “Allow users to send Slash commands and messages from the messages tab”을 켜세요.</p>
    {said ? <p className="pm-hint" role="status">{said}</p> : null}
  </div>;
}
