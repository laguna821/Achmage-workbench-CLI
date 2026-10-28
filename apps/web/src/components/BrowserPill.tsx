import { useCallback, useState } from "react";
import { LOGIN_SITES, type AccessMode, type AgentBrowserStatus, type Session } from "@workbench/contracts";
import { Icon } from "./Icon.tsx";
import { Popover } from "./Popover.tsx";
import "../styles/browse.css";

/** What the browser controls do (the app calls the gateway). */
export type BrowserActions = {
  setOn: (session: Session, on: boolean) => void;
  install: () => void;
  login: (url: string | null) => void;
  closeLogin: () => void;
  focus: () => void;
  pause: (session: Session, paused: boolean) => void;
};

/** What each access means for browser commands, in the words of what the user will see. */
export function browserAccessHelp(access: AccessMode) {
  if (access === "ask") return "묻기: 페이지 읽기를 포함해 브라우저 동작마다 확인합니다.";
  if (access === "auto") return "자동: 읽기와 이미 연 사이트 안 이동은 바로 하고, 누르기·입력·새 사이트는 확인합니다.";
  return "전체 접근: 묻지 않습니다. 보내기·결제·삭제·공유 전에는 엔진이 대화에서 먼저 확인을 구합니다.";
}

const hostOf = (url: string | null) => {
  if (!url || url === "about:blank") return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
};

/**
 * Signing in for the agent: a plain window of the same browser on the same profile (sites refuse
 * sign-in in an automated one), quick links, and the sites that are signed in already.
 */
export function BrowserLogin({ status, actions }: { status: AgentBrowserStatus; actions: BrowserActions }) {
  const [typing, setTyping] = useState(false);
  const [address, setAddress] = useState("");
  const loginOpen = status.window.kind === "login";
  return (
    <div className="browser-login">
      <div className="browser-sites">
        {LOGIN_SITES.map((site) => (
          <button key={site.id} type="button" className="button small" onClick={() => actions.login(site.url)} title={`${site.label} 로그인 창 열기`}>
            {site.label}
          </button>
        ))}
        <button type="button" className="button small" onClick={() => setTyping(!typing)} aria-expanded={typing}>
          주소…
        </button>
      </div>
      {typing ? (
        <form
          className="browser-address"
          onSubmit={(event) => {
            event.preventDefault();
            if (!address.trim()) return;
            actions.login(address.trim());
            setAddress("");
            setTyping(false);
          }}
        >
          <input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="https://" aria-label="로그인할 주소" autoFocus />
          <button type="submit" className="button small">
            열기
          </button>
        </form>
      ) : null}
      <div className="browser-note">{status.signedIn.length ? `로그인됨: ${status.signedIn.join(", ")}` : "한 번 로그인하면 앱을 다시 켜도 유지됩니다."}</div>
      {loginOpen ? (
        <div className="browser-login-open">
          <span>로그인 창이 열려 있습니다. 마치면 닫아야 에이전트가 쓸 수 있습니다.</span>
          <button type="button" className="button small" onClick={actions.closeLogin}>
            로그인 창 닫기
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Install state and button, shared by the pill and the connections menu. */
export function BrowserInstall({ status, actions }: { status: AgentBrowserStatus; actions: BrowserActions }) {
  const install = status.install;
  if (install.state === "ready") return null;
  return (
    <div className="browser-install">
      {install.state === "installing" ? (
        <>
          <div className="browser-note">{install.message ?? "설치하는 중…"}</div>
          <div className="browser-progress" role="progressbar" aria-valuenow={install.percent ?? undefined} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${install.percent ?? 8}%` }} />
          </div>
        </>
      ) : (
        <>
          <div className="browser-note">
            {install.state === "error" ? install.message : "에이전트 브라우저가 아직 없습니다. Playwright CLI와 Chromium을 앱 데이터 폴더에 받습니다(내려받기 약 180MB)."}
          </div>
          <button type="button" className="button small" onClick={actions.install}>
            {install.state === "error" ? "다시 설치" : "설치"}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * "브라우저" under the input: lets this session's engine use the one visible browser window
 * (off by default). Opened, the switch, the window's state with "창 보기" and "멈춤", signing in,
 * and what the session's access means for browsing.
 */
export function BrowserPill({
  session,
  status,
  access,
  actions,
  draft,
  onDraft,
  ownerLabel,
}: {
  session: Session | null;
  status: AgentBrowserStatus | null;
  access: AccessMode;
  actions: BrowserActions;
  /** Before the first message (no session yet): the switch for the session about to start. */
  draft: boolean;
  onDraft: (on: boolean) => void;
  /** The session that holds the window, when another one does. */
  ownerLabel: string | null;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  if (!status) return null;
  const on = session ? Boolean(session.browser) : draft;
  const win = status.window;
  const mine = Boolean(session && win.kind === "agent" && win.sessionId === session.id);
  const paused = Boolean(session && status.paused.includes(session.id));
  const host = mine && win.kind === "agent" ? hostOf(win.url) : null;
  const busy = mine && win.kind === "agent" && win.busy;
  const windowLine =
    win.kind === "login"
      ? "로그인 창이 열려 있습니다."
      : win.kind === "agent"
        ? mine
          ? `이 세션이 쓰는 중${win.title || host ? ` · ${win.title || host}` : ""}`
          : `다른 세션${ownerLabel ? `('${ownerLabel}')` : ""}이 쓰는 중`
        : "닫혀 있습니다. 엔진이 처음 쓸 때 열립니다.";
  const toggle = () => (session ? actions.setOn(session, !on) : onDraft(!on));
  return (
    <div className="anchor">
      <button
        type="button"
        className={`plain-select browser-pill${on ? " on" : ""}${paused ? " paused" : ""}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={`브라우저: ${on ? "켜짐" : "꺼짐"}${mine ? ` · ${windowLine}` : ""} — ${browserAccessHelp(access)}`}
      >
        <Icon name="globe" size={14} />
        브라우저
        {on && (mine || paused) ? <span className={`browser-dot${busy ? " busy" : ""}${paused ? " paused" : ""}`} aria-hidden /> : null}
        {on && paused ? <span className="browser-host">멈춤</span> : on && host ? <span className="browser-host">{host}</span> : null}
      </button>
      <Popover open={open} onClose={close} placement="above" align="left" className="browser-menu">
        <div className="browser-head">
          <span className="browser-title">브라우저</span>
          <button type="button" role="switch" aria-checked={on} aria-label="이 세션에서 브라우저 쓰기" className={`browser-switch${on ? " on" : ""}`} onClick={toggle} title={on ? "이 세션에서 끄기" : "이 세션에서 켜기"}>
            <span />
          </button>
          <div className="browser-note">이 세션의 엔진이 Playwright CLI로 화면에 보이는 Chromium 창을 다룹니다.</div>
        </div>
        <BrowserInstall status={status} actions={actions} />
        {status.install.state === "ready" ? (
          <>
            <div className="browser-window">
              <span className="browser-note">창: {windowLine}</span>
              <div className="browser-row">
                <button type="button" className="button small" disabled={win.kind === "closed"} onClick={actions.focus}>
                  <Icon name="eye" size={13} /> 창 보기
                </button>
                {session && on ? (
                  <button
                    type="button"
                    className={`button small${paused ? "" : " browser-stop"}`}
                    onClick={() => actions.pause(session, !paused)}
                    title={paused ? "엔진이 다시 브라우저를 쓰게 합니다" : "엔진의 브라우저 명령을 막습니다. 창은 그대로 두어 직접 다룰 수 있습니다"}
                  >
                    <Icon name={paused ? "refresh" : "stop"} size={12} /> {paused ? "다시 쓰게 하기" : "멈춤"}
                  </button>
                ) : null}
              </div>
            </div>
            <div className="menu-divider" />
            <div className="menu-label">로그인 · 에이전트와 같은 프로필</div>
            <BrowserLogin status={status} actions={actions} />
          </>
        ) : null}
        <div className="menu-divider" />
        <div className="browser-note browser-access">{browserAccessHelp(access)}</div>
      </Popover>
    </div>
  );
}
