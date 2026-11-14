import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ChannelAuditRow, ChannelBinding, ChannelBot, ChannelPairingLink, ChannelPairingRequest, ChannelsState } from "@workbench/contracts";
import { ApiRequestError, type Api } from "../api.ts";
import { FeatureDialog, featureError } from "./FeatureDialog.tsx";
import { SlackPairingLine, SlackTokenForm, SlackWizard, messengerName, slackPlace } from "./PhoneMessengerSlack.tsx";
import { Segmented } from "./ui/Hig.tsx";
import { VaultPanel } from "./VaultPanel.tsx";
import "../styles/phone-messenger.css";

// "휴대폰 메신저" (⋯ → 연결 → 선택 기능): the owner pairs a Telegram chat (or a Slack DM, see
// PhoneMessengerSlack.tsx) with this PC, one messenger at a time. Before a bot is registered it is
// the registration wizard of the design (m02 §4.1, §4.2); after, the bot's
// status line, the pairing approval with its four digits, and the PC's gates: pause, lock and
// unlock (unlocking only here), disconnect, replace the token, and the record. The token is typed
// into a field that is never filled back, and is never kept by this screen after it was sent.
// Names come from the messenger and anyone can set them: they are shown isolated (<bdi>) and next
// to the account's number; the four digits are what to trust.

export type PhoneMessengerProps = {
  api: Api;
  openExternal(url: string): Promise<void>;
  copy(text: string): Promise<void>;
  readClipboard(): Promise<string>;
  onClose(): void;
};

type Autostart = { enabled: boolean; supported: boolean };
type Step = "intro" | "open" | "send" | "token" | "slack";
const STEPS: Step[] = ["intro", "open", "send", "token"];
/** Telegram's screens in all: these, then the QR and the approval (Slack counts its own, also six). */
const TELEGRAM_TOTAL = STEPS.length + 2;
// BotFather's chat inside Telegram Web: it works in any browser once the person has scanned the
// log-in QR with the phone. https://t.me/BotFather only hands over to an installed Telegram app
// (its START BOT does nothing on a PC without one), so it is the second choice, named as such.
const BOTFATHER_WEB = "https://web.telegram.org/k/#@BotFather";
const BOTFATHER_APP = "https://t.me/BotFather";

const RISKS = [
  "연결을 켜면, 연결한 텔레그램 계정을 쓸 수 있는 사람은 누구든 이 PC에 확인 없이 무엇이든 시킬 수 있습니다(저장해 둔 로그인과 카드 사용 포함).",
  "주고받는 글·사진·파일과 AI의 답은 텔레그램 회사의 서버를 거쳐 그곳에 저장되며, 봇 토큰이 새면 남이 그 대화를 엿보거나 가로챌 수 있습니다.",
];
const NO_KEYRING = "이 PC에는 토큰을 봉인해 둘 보안 저장소(키링)가 없습니다. 토큰을 평문으로 저장하지 않습니다.";
const BOT_NAME = "내 Workbench";
const AUTOSTART = "PC를 켜면 자동으로 시작";
const REMOVE_WARNING = "이 PC에서 봇 등록을 지웁니다. 휴대폰 연결도 끊어지고, 다시 쓰려면 토큰을 넣고 다시 연결해야 합니다. 봇과 토큰은 텔레그램에 그대로 남습니다(끝내려면 BotFather에서 토큰을 폐기하세요).";
const REMOVE_WARNING_SLACK = "이 PC에서 Slack 앱 등록을 지웁니다. 연결도 끊어지고, 다시 쓰려면 토큰 두 개를 넣고 다시 연결해야 합니다. Slack 앱과 토큰은 Slack에 그대로 남습니다(끝내려면 api.slack.com에서 앱을 지우세요).";
const POLL_MS = 2_000;

/** A bot username BotFather accepts: 5–32 characters, ending in `bot`. */
export function newBotUsername() {
  const letters = "abcdefghijklmnopqrstuvwxyz0123456789";
  return `wb_${[...crypto.getRandomValues(new Uint8Array(6))].map((byte) => letters[byte % letters.length]).join("")}_bot`;
}

const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;
const day = (at: number) => new Date(at).toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });
const time = (at: number) => new Date(at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** How long a line saying what was just done stays: not left standing under a later, different state. */
const NOTICE_MS = 10_000;
/** A name someone chose, kept to its own direction so it cannot reorder the sentence around it. */
const Name = ({ children }: { children: string }) => <bdi>{children}</bdi>;

export function PhoneMessenger({ api, openExternal, copy, readClipboard, onClose }: PhoneMessengerProps) {
  const [state, setState] = useState<ChannelsState | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [autostart, setAutostart] = useState<Autostart | null>(null);
  const [wantAutostart, setWantAutostart] = useState(true);
  // Before a bot is registered the 비밀 보관함 is opened from under the wizard (afterwards it is a tab).
  const [vault, setVault] = useState(false);
  const live = useRef(true);

  const refresh = useCallback(async () => {
    const next = await api.request<ChannelsState>("GET", "/api/channels");
    if (live.current) setState(next);
    return next;
  }, [api]);

  useEffect(() => {
    live.current = true;
    void refresh().catch((reason) => { if (live.current) setError(featureError(reason)); });
    void api.request<Autostart>("GET", "/api/host/autostart").then((value) => { if (live.current) setAutostart(value); }).catch(() => undefined);
    // The phone's pairing request and the connection's state change at the gateway: looked at again every two seconds while open.
    const timer = setInterval(() => { void refresh().catch(() => undefined); }, POLL_MS);
    return () => { live.current = false; clearInterval(timer); };
  }, [api, refresh]);

  // A line about what was just done goes after a while, so it never reads as the state of later.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => { if (live.current) setNotice(""); }, NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const setStartup = async (enabled: boolean) => {
    try { const next = await api.request<Autostart>("PUT", "/api/host/autostart", { enabled }); if (live.current) setAutostart(next); }
    catch (reason) { if (live.current) setError(featureError(reason)); }
  };

  const registered = async (next: ChannelsState) => {
    setState(next);
    setError("");
    const bot = next.bots[0];
    setNotice(bot ? (bot.kind === "slack" ? `Slack 앱 @${bot.username}(${bot.name})을 확인했습니다.` : `봇 @${bot.username}을 확인했습니다.`) : "");
    if (wantAutostart && autostart?.supported && !autostart.enabled) await setStartup(true);
  };

  const bot = state?.bots[0] ?? null;
  return <FeatureDialog title="휴대폰 메신저" description="휴대폰에서 이 PC의 AI에게 일을 시킵니다." onClose={onClose}>
    <div className="phone-messenger">
      {error ? <p className="notice notice-error" role="alert">{error}</p> : null}
      {!state ? (error ? null : <p className="muted">불러오는 중…</p>)
        : bot ? <Registered api={api} bot={bot} autostart={autostart} notice={notice} setNotice={setNotice} setError={setError} setState={setState} refresh={refresh} setStartup={setStartup} readClipboard={readClipboard} openExternal={openExternal} copy={copy} />
          : vault ? <><VaultPanel api={api} /><div className="feature-actions"><button type="button" className="button small" onClick={() => setVault(false)}>휴대폰 연결로 돌아가기</button></div></>
            : <><Wizard api={api} openExternal={openExternal} copy={copy} readClipboard={readClipboard} autostart={autostart} wantAutostart={wantAutostart} setWantAutostart={setWantAutostart} onRegistered={registered} setError={setError} />
              <p className="pm-foot">AI가 쓸 로그인·키를 넣어 두는 곳: <button type="button" className="text-button" onClick={() => setVault(true)}>비밀 보관함</button></p></>}
    </div>
  </FeatureDialog>;
}

// ── Registration ──────────────────────────────────────────────────────────────────────────────

function Wizard({ api, openExternal, copy, readClipboard, autostart, wantAutostart, setWantAutostart, onRegistered, setError }: {
  api: Api; openExternal(url: string): Promise<void>; copy(text: string): Promise<void>; readClipboard(): Promise<string>;
  autostart: Autostart | null; wantAutostart: boolean; setWantAutostart(value: boolean): void;
  onRegistered(state: ChannelsState): Promise<void>; setError(value: string): void;
}) {
  // A Slack way left part done (waiting for the admin) is offered at the intro, never opened in Telegram's place.
  const [step, setStep] = useState<Step>("intro"), [said, setSaid] = useState("");
  const [username, setUsername] = useState(newBotUsername);
  const heading = useRef<HTMLHeadingElement>(null);
  const go = (next: Step) => { setStep(next); setSaid(""); setError(""); };
  // The new step's heading takes the focus, so a keyboard or screen reader starts there.
  useEffect(() => { if (step !== "intro") heading.current?.focus(); }, [step]);
  const index = STEPS.indexOf(step);
  const open = (url: string) => void openExternal(url).catch((reason) => setError(featureError(reason)));
  const copied = (text: string) => void copy(text).then(() => setSaid(`복사했습니다: ${text}`)).catch((reason) => setError(featureError(reason)));
  const back = <button type="button" className="button small" onClick={() => go(STEPS[index - 1]!)}>이전</button>;
  const next = <button type="button" className="button small primary" onClick={() => go(STEPS[index + 1]!)}>다음</button>;
  const direct = <button type="button" className="text-button pm-direct" onClick={() => go("token")}>토큰을 직접 입력</button>;
  const title = (text: string) => <><p className="pm-step-no">{index + 1} / {TELEGRAM_TOTAL}단계</p><h3 ref={heading} tabIndex={-1}>{text}</h3></>;
  const shell = (body: ReactNode, nav: ReactNode, foot?: ReactNode) => <section className="pm-step" aria-label={`${index + 1}단계`}>
    {body}
    {said ? <p className="pm-said" role="status">{said}</p> : null}
    <div className="feature-actions pm-nav">{nav}</div>
    {foot ? <p className="pm-foot">휴대폰에서 이미 봇을 만들었다면 {foot}</p> : null}
  </section>;

  if (step === "slack") return <SlackWizard api={api} openExternal={openExternal} copy={copy} readClipboard={readClipboard} onRegistered={onRegistered} onBack={() => go("intro")} setError={setError} />;

  const kept = step === "intro" ? slackPlace() : null;
  if (step === "intro") return <section className="pm-step pm-intro" aria-label="1단계">
    <p className="pm-step-no">1 / {TELEGRAM_TOTAL}단계</p>
    <h3>휴대폰으로 일 시키기</h3>
    <p>휴대폰 메신저로 이 PC의 AI에게 일을 시키고 결과를 받습니다.</p>
    <div className="pm-risks">{RISKS.map((line) => <p key={line}>{line}</p>)}</div>
    <div className="feature-actions">
      <button type="button" className="button primary" onClick={() => go("open")}>텔레그램으로 시작</button>
      <button type="button" className="button" onClick={() => go("slack")}>{kept ? "Slack 이어서 하기" : "Slack으로 시작"}</button>
    </div>
    {kept ? <p className="pm-hint" data-testid="slack-kept">Slack 앱 등록을 하던 중입니다. [Slack 이어서 하기]를 누르면 멈춘 단계부터 이어서 합니다.</p> : null}
    <p className="pm-hint">메신저는 한 번에 하나만 연결합니다.</p>
    {autostart?.supported ? <label className="feature-check"><input type="checkbox" checked={autostart.enabled || wantAutostart} disabled={autostart.enabled} onChange={(event) => setWantAutostart(event.target.checked)} />{AUTOSTART}</label> : null}
  </section>;

  if (step === "open") return shell(<>
    {title("PC 브라우저에서 BotFather 대화를 엽니다.")}
    <p>봇은 이 PC 전용 대화 상대입니다. 텔레그램의 공식 도우미 BotFather에게 말을 걸어 만듭니다. PC에 텔레그램 앱이 없어도 됩니다.</p>
    <div className="feature-actions"><button type="button" className="button primary" onClick={() => open(BOTFATHER_WEB)}>텔레그램 웹에서 BotFather 열기</button></div>
    <ol className="pm-copy-list pm-how">
      <li><span>처음이면 QR이 나옵니다. 휴대폰 텔레그램 → 설정 → 기기 → 데스크톱 기기 연결을 눌러 그 QR을 찍으세요.</span></li>
      <li><span>로그인하면 BotFather 대화가 열립니다. 열리지 않으면 왼쪽 위 검색 칸에 아래를 붙여 넣고, 파란 체크가 붙은 BotFather를 고르세요.</span><CopyRow value="@BotFather" label="@BotFather 복사" onCopy={copied} /></li>
      <li><span>대화 아래쪽의 [START](시작)를 누르세요. 그러면 글을 보낼 수 있습니다.</span></li>
    </ol>
    <p className="pm-hint">메뉴 이름은 텔레그램 버전에 따라 조금 다를 수 있습니다.</p>
    <div className="feature-actions"><button type="button" className="text-button" onClick={() => open(BOTFATHER_APP)}>PC에 텔레그램 앱이 있으면: 앱으로 열기</button></div>
  </>, <>{back}{next}</>, direct);

  if (step === "send") return shell(<>
    {title("BotFather에게 아래 세 줄을 차례로 보내세요.")}
    <ol className="pm-copy-list">
      <li><span>먼저 이것을 붙여 넣고 Enter로 보내세요. BotFather는 영어로 답합니다.</span><CopyRow value="/newbot" label="/newbot 복사" onCopy={copied} /></li>
      <li><span>“…Please choose a <b>name</b> for your bot.”이라고 하면 이것을 보내세요. 채팅 목록에 보일 이름이고, 한글도 됩니다.</span><CopyRow value={BOT_NAME} label="봇 이름 복사" onCopy={copied} /></li>
      <li><span>“…choose a <b>username</b> for your bot. It must end in `bot`.”이라고 하면 이것을 보내세요. 봇의 주소가 되는 이름입니다.</span><CopyRow value={username} label="사용자명 복사" onCopy={copied} testId="bot-username" />
        <p className="pm-hint">Workbench가 무작위로 만든 이름입니다. 직접 지어도 됩니다: 영문·숫자·밑줄만, 5–32자, 끝은 반드시 bot (예: my_workbench_bot). 이미 쓰는 이름이라고 하면 다른 이름을 보내세요.</p>
        <div className="feature-actions"><button type="button" className="button small" onClick={() => { setUsername(newBotUsername()); setSaid(""); }}>다른 이름 만들기</button></div></li>
    </ol>
  </>, <>{back}{next}</>, direct);

  return shell(<>
    {title("BotFather가 보낸 긴 토큰(숫자:문자)을 복사해 여기에 붙여 넣으세요.")}
    <p className="pm-hint">BotFather의 마지막 답에서 ‘Use this token to access the HTTP API’ 아래의 긴 글자를 누르면 복사됩니다.</p>
    <TokenForm api={api} label="봇 토큰" readClipboard={readClipboard} onDone={onRegistered} />
  </>, back);
}

function CopyRow({ value, label, onCopy, testId }: { value: string; label: string; onCopy(value: string): void; testId?: string }) {
  return <div className="pm-copy"><code data-testid={testId}>{value}</code><button type="button" className="button small" aria-label={label} onClick={() => onCopy(value)}>복사</button></div>;
}

/**
 * The token field: not bound to React state, so the value is never written back into the page,
 * and gone with the form. Its errors are said under it. Without an OS keyring the gateway refuses
 * to store the token (503); then it may be kept in memory for this run only, by the person's choice.
 */
function TokenForm({ api, label, readClipboard, onDone, onCancel }: {
  api: Api; label: string; readClipboard(): Promise<string>; onDone(state: ChannelsState): Promise<void>; onCancel?(): void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false), [noKeyring, setNoKeyring] = useState(false), [hint, setHint] = useState(""), [error, setError] = useState("");
  const send = async (memoryOnly: boolean) => {
    const token = field.current?.value.trim() ?? "";
    if (!token) { setError("토큰을 붙여 넣어 주세요."); field.current?.focus(); return; }
    setBusy(true); setError(""); setHint("");
    try {
      const next = await api.request<ChannelsState>("POST", "/api/channels/telegram/bots", memoryOnly ? { token, memoryOnly: true } : { token });
      if (field.current) field.current.value = "";
      await onDone(next);
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.code === "office_vault_unavailable") { setNoKeyring(true); setError(NO_KEYRING); }
      else setError(featureError(reason));
      setBusy(false);
    }
  };
  return <form className="pm-token" onSubmit={(event) => { event.preventDefault(); if (!busy) void send(false); }}>
    <label>{label}<input ref={field} type="password" autoComplete="off" spellCheck={false} placeholder="123456789:ABC…" disabled={busy} aria-invalid={error ? true : undefined} /></label>
    {error ? <p className="notice notice-error" role="alert">{error}</p> : null}
    <div className="feature-actions">
      <button type="button" className="button small" disabled={busy} onClick={() => void readClipboard().then((text) => {
        if (field.current) field.current.value = text.trim();
        field.current?.focus();
      }).catch(() => { setHint("붙여넣기를 쓸 수 없습니다. 칸을 누르고 Ctrl+V로 붙여 넣어 주세요."); field.current?.focus(); })}>붙여넣기</button>
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

// ── Registered ────────────────────────────────────────────────────────────────────────────────

type Tone = "ok" | "warn" | "danger" | "idle";
type Action = "replace" | "reconnect" | "unlock" | null;
type Status = { word: string; tone: Tone; text: string; action: Action };

function statusOf(bot: ChannelBot, binding: ChannelBinding | null): Status {
  const conn = bot.status;
  if (conn.state === "conflict") return { word: "충돌", tone: "danger", text: conn.detail ?? "다른 곳에서 이 봇을 쓰고 있습니다.", action: "replace" };
  if (bot.token === "none") return { word: "꺼짐", tone: "danger", text: conn.detail ?? "토큰을 다시 넣어 주세요.", action: "replace" };
  if (conn.state === "stopped") return { word: "꺼짐", tone: "danger", text: conn.detail ?? "연결이 멈췄습니다.", action: conn.detail?.includes("토큰 바꾸기") ? "replace" : "reconnect" };
  if (binding?.lockedAt) return { word: "잠김", tone: "warn", text: binding.pausedAt ? "잠겨 있고 멈춰 둔 상태입니다. 잠금은 이 PC에서만 풀 수 있습니다." : "잠갔습니다. 이 PC에서만 풀 수 있습니다. 그동안 끝난 답은 풀 때 보냅니다.", action: "unlock" };
  if (binding?.pausedAt) return { word: "멈춤", tone: "warn", text: "휴대폰에서 온 글은 실행하지 않고, 멈춰 두었다고만 답합니다.", action: null };
  if (conn.state === "retrying") return { word: conn.detail ?? "다시 연결 중", tone: "warn", text: "인터넷이 이어지면 저절로 다시 연결됩니다.", action: null };
  return { word: "연결됨", tone: "ok", text: binding ? "휴대폰에서 적어 보내면 이 PC의 AI가 합니다." : "이제 휴대폰을 연결하세요.", action: null };
}

function Registered({ api, bot, autostart, notice, setNotice, setError, setState, refresh, setStartup, readClipboard, openExternal, copy }: {
  api: Api; bot: ChannelBot; autostart: Autostart | null; notice: string; setNotice(value: string): void; setError(value: string): void;
  setState(state: ChannelsState): void; refresh(): Promise<ChannelsState>; setStartup(enabled: boolean): Promise<void>; readClipboard(): Promise<string>;
  openExternal(url: string): Promise<void>; copy(text: string): Promise<void>;
}) {
  const [tab, setTab] = useState<"link" | "record" | "vault">("link"), [replacing, setReplacing] = useState(false), [removing, setRemoving] = useState(false), [busy, setBusy] = useState(false);
  const binding = bot.bindings[0] ?? null;
  const status = statusOf(bot, binding);
  const act = async (run: () => Promise<ChannelsState | unknown>, said = "") => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const next = await run();
      if (next && typeof next === "object" && "bots" in next) setState(next as ChannelsState); else await refresh();
      setNotice(said);
    } catch (reason) { setError(featureError(reason)); }
    finally { setBusy(false); }
  };
  const patch = (body: Record<string, unknown>, said = "") => act(() => api.request<ChannelsState>("PATCH", `/api/channels/bindings/${encodeURIComponent(binding!.id)}`, body), said);
  const base = `/api/channels/${bot.kind}/bots/${encodeURIComponent(bot.id)}`;
  const replaceButton = <button type="button" className="button small" disabled={busy} onClick={() => { setReplacing(true); setRemoving(false); setNotice(""); }}>토큰 바꾸기</button>;
  return <>
    <header className="pm-head">
      <div className="pm-status-line">
        <p className="pm-status" data-testid="channel-status"><span className="pm-dot" data-tone={status.tone} aria-hidden /><span>{messengerName(bot.kind)} @{bot.username} · {status.word} · {binding ? <Name>{binding.displayName}</Name> : "휴대폰 연결 전"}</span></p>
        {binding ? <div className="feature-actions">
          <button type="button" className="button small" disabled={busy} aria-pressed={Boolean(binding.pausedAt)} onClick={() => void patch({ paused: !binding.pausedAt }, binding.pausedAt ? "다시 시작했습니다." : "멈췄습니다. 휴대폰에서 온 글은 실행하지 않습니다.")}>{binding.pausedAt ? "다시 시작" : "멈춤"}</button>
          {binding.lockedAt ? null : <button type="button" className="button small" disabled={busy} onClick={() => void patch({ locked: true }, "잠갔습니다. 하던 일도 멈췄고, 푸는 것은 이 PC에서만 할 수 있습니다.")}>잠금</button>}
        </div> : null}
      </div>
      <p className="pm-status-text" aria-live="polite">{status.text}</p>
      {binding?.undelivered ? <p className="pm-status-text pm-warn-line" data-testid="channel-undelivered">전하지 못한 답 {binding.undelivered.count}개 · {time(binding.undelivered.at)} · {binding.undelivered.reason}</p> : null}
      {binding?.uncertain ? <p className="pm-status-text pm-warn-line" data-testid="channel-uncertain">전달됐는지 확인하지 못한 답 {binding.uncertain.count}개 · {time(binding.uncertain.at)} · 다시 보내지는 않습니다. 대화는 PC에 있습니다.</p> : null}
      {status.action && !replacing ? <div className="feature-actions">
        {status.action === "replace" ? replaceButton : null}
        {status.action === "reconnect" ? <button type="button" className="button small" disabled={busy} onClick={() => void act(() => api.request<ChannelsState>("POST", `${base}/reconnect`, {}), "다시 연결하고 있습니다.")}>다시 연결</button> : null}
        {status.action === "unlock" ? <button type="button" className="button small primary" disabled={busy} onClick={() => void patch({ locked: false }, "잠금을 풀었습니다.")}>잠금 풀기</button> : null}
      </div> : null}
      {notice ? <p className="pm-said" role="status">{notice}</p> : null}
    </header>
    <Segmented tabs id="pm-tabs" controls="pm-panel" label="휴대폰 메신저 보기" value={tab} onChange={setTab} options={[{ value: "link", label: "연결" }, { value: "record", label: "기록" }, { value: "vault", label: "비밀 보관함" }]} />
    <div className="pm-panel" id="pm-panel" role="tabpanel" aria-labelledby={`pm-tabs-${["link", "record", "vault"].indexOf(tab)}`}>
      {tab === "vault" ? <VaultPanel api={api} /> : tab === "record" ? <Record api={api} bot={bot} /> : <>
        {binding ? <section className="pm-section" aria-label="연결한 휴대폰">
          <dl className="pm-facts">
            <div><dt>연결한 사람</dt><dd><Name>{binding.displayName}</Name>{binding.handle ? ` (@${binding.handle})` : ""} · {bot.kind === "slack" ? "ID" : "번호"} {binding.userId}</dd></div>
            <div><dt>연결한 날</dt><dd>{day(binding.createdAt)}</dd></div>
            <div><dt>지금 대화</dt><dd>{binding.pointerLabel ?? "아직 없습니다. 휴대폰에서 적어 보내면 새 대화가 생깁니다."}</dd></div>
          </dl>
          <div className="feature-actions"><button type="button" className="button small" disabled={busy} onClick={() => void patch({ revoked: true }, "연결을 끊었습니다. 그 휴대폰에서 온 글은 이제 실행하지 않습니다.")}>연결 끊기</button></div>
        </section> : <Pairing api={api} bot={bot} busy={busy} act={act} refresh={refresh} openExternal={openExternal} copy={copy} />}
        <section className="pm-section" aria-label="토큰 보관">
          <dl className="pm-facts"><div><dt>{bot.kind === "slack" ? "토큰 두 개" : "봇 토큰"}</dt><dd>{bot.token === "sealed" ? "보안 저장소에 봉인해 두었습니다." : bot.token === "memory" ? "이번 실행 동안만 기억합니다. PC를 다시 켜면 다시 넣어야 합니다." : "없습니다. 다시 넣어 주세요."}</dd></div></dl>
          {replacing ? (bot.kind === "slack" ? <SlackTokenForm api={api} fresh readClipboard={readClipboard} onCancel={() => setReplacing(false)}
            onDone={async (next) => { setState(next); setReplacing(false); setNotice("새 토큰으로 바꿨습니다."); }} />
            : <TokenForm api={api} label="새 봇 토큰" readClipboard={readClipboard} onCancel={() => setReplacing(false)}
            onDone={async (next) => { setState(next); setReplacing(false); setNotice("새 토큰으로 바꿨습니다."); }} />)
            : removing ? <div className="pm-remove-confirm" role="group" aria-label="봇 등록 지우기">
              <p>{bot.kind === "slack" ? REMOVE_WARNING_SLACK : REMOVE_WARNING}</p>
              <div className="feature-actions">
                <button type="button" className="button small" disabled={busy} onClick={() => void act(() => api.request<ChannelsState>("DELETE", base), `봇 등록을 지웠습니다. ${bot.kind === "slack" ? "Slack 앱과 토큰은 Slack" : "봇과 토큰은 텔레그램"}에 남아 있습니다.`).then(() => setRemoving(false))}>지우기</button>
                <button type="button" className="button small" disabled={busy} onClick={() => setRemoving(false)}>취소</button>
              </div>
            </div>
              : <div className="feature-actions">{status.action === "replace" ? null : replaceButton}
                <button type="button" className="text-button pm-remove" disabled={busy} onClick={() => setRemoving(true)}>봇 등록 지우기</button></div>}
        </section>
        {autostart?.supported ? <label className="feature-check"><input type="checkbox" checked={autostart.enabled} onChange={(event) => void setStartup(event.target.checked)} />{AUTOSTART}</label>
          : autostart ? <p className="pm-hint">이 실행 방식에서는 자동 시작을 켤 수 없습니다. 설치한 앱에서 켜 주세요.</p> : null}
      </>}
    </div>
  </>;
}

/**
 * Steps 7–8: the QR of the one-time link, then the phone's request with its four digits. Arrivals
 * are announced (a live region) and the focus moves to the request's sentence, not to [연결].
 */
function Pairing({ api, bot, busy, act, refresh, openExternal, copy }: {
  api: Api; bot: ChannelBot; busy: boolean; act(run: () => Promise<unknown>, said?: string): Promise<void>; refresh(): Promise<ChannelsState>; openExternal(url: string): Promise<void>;
  copy(text: string): Promise<void>;
}) {
  const [link, setLink] = useState<Pick<ChannelPairingLink, "qr" | "expiresAt" | "say" | "open"> | null>(null), [failed, setFailed] = useState("");
  // Slack has no QR: a line to send in the app's DM, the one-time value in it ("연결 값").
  const slack = bot.kind === "slack", fresh = slack ? "새 연결 값 만들기" : "새 QR 만들기";
  const [now, setNow] = useState(Date.now), [ranOut, setRanOut] = useState(false);
  const making = useRef(false), answered = useRef<string | null>(null), shown = useRef<string | null>(null);
  // The link itself only lives here, in memory, for "이 PC의 텔레그램으로 열기"; it is never put on the page.
  const deepLink = useRef<string | null>(null);
  const sentence = useRef<HTMLParagraphElement>(null);
  const request = bot.pairing.request;
  const notice = bot.pairing.notice ?? null;
  const refused = (bot.pairing.refusedSenders ?? []).filter((sender) => sender.until > now);
  const locked = bot.pairing.lockedUntil && bot.pairing.lockedUntil > now ? bot.pairing.lockedUntil : null;
  const make = useCallback(async () => {
    if (making.current) return;
    making.current = true; setFailed(""); setRanOut(false);
    try {
      const { link: url, qr, expiresAt, say, open } = await api.request<ChannelPairingLink>("POST", `/api/channels/${bot.kind}/bots/${encodeURIComponent(bot.id)}/pairing`, {});
      deepLink.current = say ?? url;
      setLink({ qr, expiresAt, say, open: open ?? null });
    } catch (reason) { setFailed(featureError(reason)); }
    finally { making.current = false; }
  }, [api, bot.kind, bot.id]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(timer); }, []);
  // A new link replaces a phone's waiting request, and a contested scan waits for the person: neither makes one by itself.
  // (`shown` still names a request that just left: that one ran out, and the person is told so first.)
  useEffect(() => { if (!link && !request && !notice && !locked && !failed && !ranOut && !shown.current) void make(); }, [link, request, notice, locked, failed, ranOut, make]);
  // A request arrived: its sentence takes the focus. One that left without an answer here ran out.
  useEffect(() => {
    if (request && request.id !== shown.current) {
      shown.current = request.id;
      setRanOut(false);
      sentence.current?.focus();
    } else if (!request && shown.current) {
      if (answered.current !== shown.current && !notice) { setRanOut(true); setLink(null); deepLink.current = null; }
      shown.current = null;
    }
  }, [request, notice]);
  const answer = (target: ChannelPairingRequest, approve: boolean) => act(async () => {
    answered.current = target.id;
    const next = await api.request<ChannelsState>("POST", `/api/channels/${bot.kind}/bots/${encodeURIComponent(bot.id)}/pairing/${encodeURIComponent(target.id)}`, { approve });
    setLink(null);
    deepLink.current = null;
    // Declined: a fresh QR at once (the old value was for that request only).
    if (!approve) { shown.current = null; await make(); }
    return next;
  }, approve ? "연결되었습니다. 휴대폰에서 하고 싶은 일을 적어 보내 보세요." : `연결하지 않았습니다. 모르는 계정이었다면 화면을 가린 뒤 ${slack ? "새 연결 값을" : "새 QR을"} 쓰세요.`);
  const restart = () => act(async () => { setLink(null); deepLink.current = null; await make(); return refresh(); });
  // Telegram's own link scheme goes straight to the app (and stays out of the browser's history).
  // Whether a handler for it exists cannot be told reliably beforehand, so both ways are offered.
  const [appFailed, setAppFailed] = useState(false);
  const openApp = () => {
    if (!deepLink.current) return;
    const value = new URL(deepLink.current).searchParams.get("start") ?? "";
    setAppFailed(false);
    void openExternal(`tg://resolve?domain=${encodeURIComponent(bot.username)}&start=${encodeURIComponent(value)}`).catch(() => setAppFailed(true));
  };
  const openBrowser = () => { if (deepLink.current) void openExternal(deepLink.current).catch(() => undefined); };
  // The dialog closes (or the bot goes) while a QR nobody opened is up: its value is cancelled at
  // the gateway, so a link left in a history or on a photo pairs nobody. A phone's waiting request stays.
  const waiting = useRef(request);
  waiting.current = request;
  useEffect(() => () => {
    if (deepLink.current && !waiting.current) void api.request("DELETE", `/api/channels/${bot.kind}/bots/${encodeURIComponent(bot.id)}/pairing`).catch(() => undefined);
  }, [api, bot.kind, bot.id]);

  const declined = refused.filter((sender) => sender.declined), wrong = refused.filter((sender) => !sender.declined);
  const senderList = (list: typeof refused) => <ul>{list.map((sender) => <li key={sender.userId}><Name>{sender.displayName}</Name>{` · ${sender.handle ? `@${sender.handle}` : "사용자명 없음"} · 번호 ${sender.userId} · ${time(sender.until)}까지`}</li>)}</ul>;
  const refusedList = refused.length ? <div className="pm-refused" data-testid="refused-senders">
    {wrong.length ? <><p className="pm-hint">잘못된 연결 값을 여러 번 낸 계정은 한 시간 동안 받지 않습니다. {slack ? "새 연결 값을" : "새 QR을"} 만들면 풀립니다.</p>{senderList(wrong)}</> : null}
    {declined.length ? <><p className="pm-hint">PC에서 거절한 계정은 한 시간 동안 받지 않습니다.</p>{senderList(declined)}</> : null}
  </div> : null;
  const refuse = slack ? "거절" : "아니요";

  const left = link ? link.expiresAt - now : 0;
  // Only what the person must hear is in the live region: the request, the contested notice, the
  // ran-out line. The countdown changes every second and stays out of it.
  const live = request ? <section className="pm-section pm-request" role="group" aria-label="연결 요청">
    <p className="pm-step-no">{slack ? "6 / 6단계" : `${TELEGRAM_TOTAL} / ${TELEGRAM_TOTAL}단계`}</p>
    <p className="pm-request-text" ref={sentence} tabIndex={-1}>{messengerName(bot.kind)} 사용자 <strong><Name>{request.displayName}</Name></strong>이 연결을 요청합니다.</p>
    <dl className="pm-facts">
      <div><dt>사용자명</dt><dd data-testid="pairing-handle">{request.handle ? `@${request.handle}` : "사용자명 없음"}</dd></div>
      <div><dt>{slack ? "Slack 사용자 ID" : "텔레그램 번호"}</dt><dd data-testid="pairing-number">{request.userId}</dd></div>
      {slack ? <div><dt>워크스페이스</dt><dd data-testid="pairing-workspace"><Name>{bot.name}</Name> (이 앱이 설치된 곳)</dd></div> : null}
    </dl>
    {request.others?.length ? <div className="pm-others" data-testid="pairing-others">
      <p className="pm-hint">다른 사람도 연결을 요청했습니다. 위 요청이 본인 것이 아니면 [거절]을 누른 뒤 다시 보내세요.</p>
      <ul>{request.others.map((other) => <li key={other.userId}><Name>{other.displayName}</Name>{` · ${other.handle ? `@${other.handle}` : "사용자명 없음"} · ${other.userId}`}</li>)}</ul>
    </div> : null}
    <div className="pm-digits"><span>{slack ? "Slack에 보이는 숫자" : "휴대폰에 보이는 숫자"}</span><strong data-testid="pairing-digits">{request.digits.split("").join(" ")}</strong></div>
    <p className="pm-hint">이름은 누구나 똑같이 지을 수 있습니다. 이름이 아니라 네 숫자가 {slack ? "Slack에 보이는 것과" : "휴대폰과"} 같을 때만 연결하세요. 모르는 계정이면 [{refuse}]{slack ? "을" : "를"} 누르세요.</p>
    <div className="feature-actions"><button type="button" className="button small primary" disabled={busy} onClick={() => void answer(request, true)}>연결</button><button type="button" className="button small" disabled={busy} onClick={() => void answer(request, false)}>{refuse}</button></div>
  </section>
    : notice ? <><p className="notice notice-error" role="alert">{notice}</p><div className="feature-actions"><button type="button" className="button small primary" disabled={busy} onClick={() => void restart()}>다시 시작</button></div></>
      : ranOut && !link ? <><p>연결 요청의 시간이 지났습니다. {slack ? "새 연결 값으로" : "새 QR로"} 다시 하세요.</p><div className="feature-actions"><button type="button" className="button small" onClick={() => void make()}>{fresh}</button></div></>
        : null;
  const quiet = request || notice || (ranOut && !link) ? null
    : locked ? <p className="notice">잘못된 연결 시도가 여러 번 있어 {time(locked)}까지 연결을 받지 않습니다.</p>
      : failed ? <><p className="notice notice-error" role="alert">{failed}</p><div className="feature-actions"><button type="button" className="button small" onClick={() => void make()}>{fresh}</button></div></>
        : !link ? <p className="muted">{slack ? "연결 값을" : "QR을"} 만드는 중…</p>
          : left <= 0 ? <><p>{slack ? "연결 값" : "QR"}의 유효 시간(10분)이 지났습니다.</p><div className="feature-actions"><button type="button" className="button small" onClick={() => { deepLink.current = null; setLink(null); }}>{fresh}</button></div></>
            : slack && link.say ? <SlackPairingLine say={link.say} open={link.open ?? null} username={bot.username} appName={bot.appName} left={clock(left)} until={time(link.expiresAt)} copy={copy} openExternal={openExternal} />
            : <div className="pm-qr-row">
              <img className="pm-qr" src={link.qr} alt="텔레그램 봇 연결 QR" width={208} height={208} />
              <div>
                <p>찍으면 휴대폰 텔레그램이 봇 @{bot.username}을 엽니다. [시작]을 누르세요.</p>
                <p>휴대폰에 숫자 네 개가 나오면 이 화면에도 같은 숫자가 나옵니다.</p>
                <p className="pm-hint"><span data-testid="pairing-countdown" aria-hidden="true">{clock(left)} 남음 · </span><span>{time(link.expiresAt)}까지 쓸 수 있는 한 번만 쓰는 QR입니다.</span></p>
                <p className="pm-hint">카메라로 열리지 않으면, 같은 계정으로 로그인한 이 PC의 텔레그램에서 열 수 있습니다.</p>
                <div className="feature-actions">
                  <button type="button" className="button small" onClick={openApp}>텔레그램 앱으로 열기</button>
                  <button type="button" className="button small" onClick={openBrowser}>브라우저로 열기</button>
                </div>
                {appFailed ? <p className="pm-hint" role="status">이 PC에서 텔레그램 앱을 열지 못했습니다. [브라우저로 열기]를 써 보세요.</p> : null}
              </div>
            </div>;
  return <div className="pm-pairing">
    {request ? null : <><p className="pm-step-no">{slack ? "5 / 6단계" : `${TELEGRAM_TOTAL - 1} / ${TELEGRAM_TOTAL}단계`}</p><h3>{slack ? "Slack에서 이 앱에 “연결”이라고 보내세요." : "휴대폰 카메라로 찍으세요."}</h3></>}
    <div className="pm-live" aria-live="polite">{live}</div>
    {quiet ? <section className="pm-section pm-pair" aria-label="휴대폰 연결">{quiet}</section> : null}
    {request ? null : refusedList}
  </div>;
}

// ── Record ────────────────────────────────────────────────────────────────────────────────────

const REFUSED: Record<string, string> = { stranger: "모르는 사람", group: "그룹 대화", paused: "멈춤 중", locked: "잠김", archived: "보관된 대화", document_removed: "지운 문서", button: "쓸 수 없는 버튼", updating: "업데이트 준비 중" };
/** Done at the PC, whoever the chat's person is. */
const AT_PC = new Set(["pause", "resume", "unlock", "revoked", "bot.registered", "token.replaced", "bot.removed", "pairing.started", "pairing.declined"]);

function actionLabel(row: ChannelAuditRow): string {
  switch (row.action) {
    case "bot.registered": return `봇 등록${row.result === "memory" ? " · 이번 실행만 기억" : ""}`;
    case "token.replaced": return "토큰 바꿈";
    case "bot.removed": return "봇 등록 지움";
    case "pairing.started": return row.kind === "slack" ? "연결 값 만듦" : "연결 QR 만듦";
    case "pairing.requested": return "휴대폰이 연결 요청";
    case "pairing.declined": return "연결 요청 거절";
    case "pairing.locked": return "연결 막음 · 잘못된 시도가 많음";
    case "pairing.contested": return "연결 취소 · 두 계정이 같은 값을 냄";
    case "pairing.sender_locked": return "잘못된 값이 많아 한 시간 거절";
    case "paired": return "연결";
    case "revoked": return "연결 끊기";
    case "pause": return "PC에서 멈춤";
    case "resume": return "PC에서 다시 시작";
    case "unlock": return "PC에서 잠금 풀기";
    case "lock": return `${row.target === "pc" ? "PC에서" : "휴대폰에서"} 잠금${row.result === "stopped" ? " · 하던 일 멈춤" : row.result === "failed" ? " · 멈추지 못한 일 있음" : ""}`;
    case "stop": return `멈춰${row.result === "idle" ? " · 멈출 일 없음" : ""}`;
    case "request": return `요청 보냄${row.result === "queued" ? " · 대기열" : row.result === "steered" ? " · 하던 일에 덧붙임" : row.result && !["started", "sent"].includes(row.result) ? " · 보내지 못함" : ""}`;
    case "refused": return `거절 · ${row.result?.startsWith("queue.") ? "대기 요청을 보내지 못함" : REFUSED[row.result ?? ""] ?? row.result ?? ""}`;
    case "approval": return `승인 답함${row.result === "allow" ? " · 허용" : row.result === "decline" ? " · 거절" : ""}`;
    case "access": return `접근 모드 · ${row.result === "ask" ? "묻기" : row.result === "auto" ? "자동" : "전체 접근"}`;
    case "pointer": return row.target === "document" ? "문서 AI로 옮김" : "대화 바꿈";
    case "engine": return `엔진 바꿈 · ${row.result === "codex" ? "Codex" : "Claude"} 새 대화`;
    case "model": return "모델 바꿈";
    case "effort": return "노력 바꿈";
    case "queue.send": return "대기 요청 지금 보냄";
    case "queue.drop": return "대기 요청 뺌";
    case "note.entry": return `노트에 ${row.result === "question" ? "열린 질문" : "결정"} 적음`;
    case "note.property": return "노트 속성 바꿈";
    case "note.conflict": return "노트가 바뀌어 적지 않음";
    case "schedule": return "예약 만듦";
    case "notify": return `알림 ${row.result === "on" ? "켬" : "끔"}`;
    case "work.created": return "새 프로젝트 만듦";
    case "schedule.disabled": return `이 채팅의 예약 ${row.result ?? ""}개 끔`;
    case "schedule.enabled": return `예약 ${row.result ?? ""}개 다시 켬`;
    case "file.received": return `파일 ${row.result ?? ""}개 받음`;
    case "file.sent": return `파일 ${row.result ?? ""}개 보냄`;
    case "file.unsent": return `답과 함께 가지 못한 파일 ${row.result ?? ""}개`;
    case "file.blocked": {
      // Unit 9: "<reason>:<count>" for files held back for what they hold ("secret-content" alone in older rows).
      const held = /^(secret-content|unreadable)(?::(\d+))?$/.exec(row.result ?? "");
      if (held) return held[1] === "unreadable" ? `읽지 못한 파일 ${held[2] ?? 1}개를 보내지 않음` : held[2] ? `비밀 값이 든 파일 ${held[2]}개를 보내지 않음` : "비밀 값이 든 파일을 보내지 않음";
      return `비밀이 있을 수 있는 파일 ${row.result ?? ""}개를 보내지 않음`;
    }
    case "send.refused": return `답을 전하지 못함${row.result === "gave_up" ? " · 여러 번 실패" : row.result?.endsWith("403") || row.result === "blocked" ? " · 봇을 차단했을 수 있음" : ""}`;
    case "answer.discarded": return "PC가 끊어 보내지 않은 답";
    case "secret.asked": return `비밀 입력 열림${row.target ? ` · ${row.target}` : ""}`;
    case "secret.received": return `비밀 받음${row.target ? ` · ${row.target}` : ""}${row.result === "memory" ? " · 이번 한 번만" : " · 봉인"}`;
    case "secret.refused": return `비밀 입력 거절${row.result === "not_text" ? " · 글이 아님" : row.result === "stray" ? " · 요청 없는 양식" : row.result === "locked" ? " · 잠김" : row.result === "paused" ? " · 멈춤" : ""}`;
    case "secret.cancelled": return "비밀 입력 취소";
    case "credential.used": return `${LOGIN_USED[row.result ?? ""] ?? "로그인 넣지 못함"}${row.target ? ` · ${row.target}` : ""}`;
    case "login.step": return `로그인 단계${row.target ? ` · ${row.target}` : ""} · ${row.result === "approved" ? "다른 앱에서 승인" : row.result?.endsWith(":ok") ? (row.result.startsWith("link") ? "링크 엶" : "인증번호 넣음") : "넣지 못함"}`;
    case "secret.discarded": return `받은 줄을 값이 아니라며 버림${row.target ? ` · ${row.target}` : ""}`;
    default: return row.action;
  }
}

/** What a stored login's use came to (unit 9, `credential.used`). */
const LOGIN_USED: Record<string, string> = { ok: "저장한 로그인 넣음", code: "인증번호 넣음", link: "로그인 링크 엶", wrong_site: "다른 사이트라 로그인 넣지 않음", insecure: "암호화되지 않은 주소라 로그인 넣지 않음", ask_host: "다른 주소에서 쓸지 물음", allow_host: "다른 주소에서도 쓰게 함", deny_host: "다른 주소에서 쓰지 않기로 함" };

function Record({ api, bot }: { api: Api; bot: ChannelBot }) {
  const [rows, setRows] = useState<ChannelAuditRow[] | null>(null), [names, setNames] = useState<Record<string, string>>({}), [more, setMore] = useState(false), [failed, setFailed] = useState("");
  const LIMIT = 100;
  const load = useCallback(async (before?: number) => {
    try {
      const answer = await api.request<{ rows: ChannelAuditRow[]; names?: Record<string, string> }>("GET", `/api/channels/audit?limit=${LIMIT}${before ? `&before=${before}` : ""}`);
      setRows((current) => before && current ? [...current, ...answer.rows] : answer.rows);
      setNames((current) => ({ ...current, ...(answer.names ?? {}) }));
      setMore(answer.rows.length === LIMIT);
    } catch (reason) { setFailed(featureError(reason)); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);
  // Disconnected chats keep their names in the record (the gateway sends them with it).
  const known = { ...names, ...Object.fromEntries(bot.bindings.map((binding) => [binding.id, binding.displayName])) };
  const who = (row: ChannelAuditRow) => AT_PC.has(row.action) || (row.action === "lock" && row.target === "pc") ? "PC"
    : row.bindingId ? known[row.bindingId] ?? "끊은 연결"
      : row.action === "refused" ? (row.result === "group" ? "그룹" : "모르는 사람")
        : row.action === "pairing.contested" ? "두 계정" : row.action === "pairing.sender_locked" ? "모르는 사람"
          : row.action.startsWith("pairing.") && row.target?.startsWith("user:") ? "휴대폰" : "PC";
  let lastDay = "";
  return <section className="pm-section" aria-label="기록">
    <p className="pm-hint">무엇을 했는지만 남깁니다. 주고받은 글과 토큰은 남기지 않습니다(글은 대화에 있습니다).</p>
    {failed ? <p className="notice notice-error" role="alert">{failed}</p> : null}
    {!rows ? <p className="muted">불러오는 중…</p> : !rows.length ? <p className="muted">아직 기록이 없습니다.</p> : <ul className="pm-record">
      {rows.map((row) => {
        const today = day(row.at), head = today !== lastDay ? today : null;
        lastDay = today;
        return <li key={row.id} data-day={head ?? undefined}>
          {head ? <span className="pm-record-day">{head}</span> : null}
          <time dateTime={new Date(row.at).toISOString()}>{time(row.at)}</time><strong><Name>{who(row)}</Name></strong><span>{actionLabel(row)}</span>
        </li>;
      })}
    </ul>}
    {more && rows ? <div className="feature-actions"><button type="button" className="button small" onClick={() => void load(rows.at(-1)!.id)}>더 보기</button></div> : null}
    {bot.kind === "slack" ? <p className="pm-tip">권장: Slack 계정에 2단계 인증을 켜 두세요. 비밀번호가 새어도 그 사람이 이 계정으로 이 PC에 일을 시키지 못합니다.</p>
      : <p className="pm-tip">권장: 텔레그램 설정 → 개인정보 및 보안 → 2단계 인증을 켜 두세요. 휴대폰 번호(SIM)를 남에게 빼앗겨도 그 사람이 이 계정으로 이 PC에 일을 시키지 못합니다.</p>}
  </section>;
}
