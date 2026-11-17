import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { HostPairingOffer, LocalDeviceApi, TailscaleState } from "../host-connections.ts";

/**
 * 설정 › 휴대폰과 다른 기기 › 테일스케일로 연결: one state at a time, as the gateway reads it from the
 * `tailscale` program. Nothing here changes a Tailscale setting except the person's own press on
 * 켜기 / 끄기, and 켜기 sends back the very command it shows (the gateway refuses any other). 켜기 is a
 * standing choice: the gateway keeps that command running while the app runs, until 끄기.
 * "휴대폰에서 열림" is said only after a device really signed in through the Tailscale address.
 */
export type TailscalePanelProps = {
  api: LocalDeviceApi;
  /** Opens a fixed page (download, admin) in the browser. */
  openExternal?: (url: string) => Promise<void> | void;
  /** After 켜기 / 끄기: the connection settings changed (address, remote access). */
  onChanged?: () => void;
  /** How often to look again while the road is open (ms). */
  pollMs?: number;
};

const time = (value: number) => new Date(value).toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
const LOST = "휴대폰에서 이 PC로 오던 테일스케일 길이 끊겼습니다.";
/** What 켜기 means over time (M3): said next to 켜기 and in the on state. */
export const STANDING = "끄기를 누를 때까지, 이 앱이 켜져 있는 동안만 열립니다. 앱을 끄면 닫히고, 다시 켜면 다시 열립니다.";
const RETRYING = "켜 둔 상태라 잠시 뒤 저절로 다시 엽니다.";

export function TailscalePanel({ api, openExternal = (url) => { window.open(url, "_blank", "noopener"); }, onChanged, pollMs = 10_000 }: TailscalePanelProps) {
  const [view, setView] = useState<TailscaleState | null>(null);
  const [busy, setBusy] = useState<"" | "check" | "on" | "off" | "offer">("");
  const [problem, setProblem] = useState("");
  const [offer, setOffer] = useState<HostPairingOffer | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const check = useCallback(async (quiet = false) => {
    if (!api.tailscale) return;
    if (!quiet) { setBusy("check"); setProblem(""); }
    try { const next = await api.tailscale(); if (live.current) setView(next); }
    catch (error) { if (live.current && !quiet) setProblem(`테일스케일 상태를 확인하지 못했습니다. ${reason(error)}`); }
    finally { if (live.current && !quiet) setBusy(""); }
  }, [api]);
  useEffect(() => { void check(); }, [check]);
  // While the road is open (or was), look again now and then: a stopped Tailscale or a phone that signed in shows up by itself.
  const watching = !!view && (view.state === "on" || view.ours);
  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(() => void check(true), pollMs);
    return () => clearInterval(timer);
  }, [watching, check, pollMs]);

  if (!api.tailscale) return null;
  const act = async (name: "on" | "off", run: () => Promise<TailscaleState>) => {
    setBusy(name); setProblem("");
    try { const next = await run(); if (live.current) { setView(next); setOffer(null); onChanged?.(); } }
    catch (error) { if (live.current) setProblem(`${name === "on" ? "켜지 못했습니다." : "끄지 못했습니다."} ${reason(error)}`); void check(true); }
    finally { if (live.current) setBusy(""); }
  };
  const makeOffer = async () => {
    setBusy("offer"); setProblem("");
    try { const next = await api.createOffer(); if (live.current) setOffer(next); }
    catch (error) { if (live.current) setProblem(`QR을 만들지 못했습니다. ${reason(error)}`); }
    finally { if (live.current) setBusy(""); }
  };
  const again = (label = "다시 확인") => <button type="button" className="button" disabled={!!busy} aria-busy={busy === "check" || undefined} onClick={() => void check()}>{busy === "check" ? "확인하는 중…" : label}</button>;
  const external = (label: string, url: string) => <button type="button" className="button" disabled={!!busy} onClick={() => void Promise.resolve(openExternal(url)).catch(() => setProblem(`브라우저를 열지 못했습니다. ${url} 에 직접 들어가 주세요.`))}>{label}</button>;
  const command = (line: string | undefined, label = "실행할 명령") => line ? <code className="tailscale-command" aria-label={label}>{line}</code> : null;
  // While 켜기 stands and the road is closed: why (the CLI's last line, as text) and whether it is tried again.
  const gone = view && view.ours && view.lost ? <>
    <p>{LOST}</p>
    {view.why ? <p className="tailscale-why">{view.why}</p> : null}
    {view.retrying ? <p className="muted">{RETRYING}</p> : null}
  </> : null;
  const off = (label = "끄기") => view?.ours ? <button type="button" className="button" disabled={!!busy} aria-busy={busy === "off" || undefined} onClick={() => void act("off", () => api.tailscaleOff!())}>{busy === "off" ? "끄는 중…" : label}</button> : null;

  let title = "", body: ReactNode = null, actions: ReactNode = null, tone: "plain" | "warn" | "ok" = "plain";
  if (!view) { title = "테일스케일 상태를 확인하는 중입니다"; }
  else switch (view.state) {
    case "missing":
      title = "이 PC에 테일스케일이 없습니다";
      body = <>{gone}<p>테일스케일은 내 기기들끼리만 통하는 사설 연결망입니다. 이 PC와 휴대폰에 설치하고 같은 계정으로 로그인하면, 휴대폰에서 이 PC의 작업실 화면을 그대로 열 수 있습니다.</p></>;
      actions = <>{external("설치 안내 열기", view.downloadUrl)}{again("설치했어요 · 다시 확인")}{off()}</>;
      break;
    case "stopped":
      title = "테일스케일이 꺼져 있습니다"; tone = view.lost ? "warn" : "plain";
      body = <>{gone}<p>{view.backend === "NoDaemon" ? "이 PC에서 테일스케일 앱을 열어 켜 주세요." : "이 PC의 테일스케일 앱에서 연결을 켜 주세요."}</p></>;
      actions = <>{again()}{off()}</>; break;
    case "needs-login":
      title = "테일스케일에 로그인되어 있지 않습니다"; tone = view.lost ? "warn" : "plain";
      body = <>{gone}<p>이 PC의 테일스케일 앱에서 로그인해 주세요. 휴대폰도 같은 계정으로 로그인해야 합니다.</p></>;
      actions = <>{again()}{off()}</>; break;
    case "no-https":
      title = view.reason === "name" ? "이 PC의 테일스케일 이름을 주소로 쓸 수 없습니다" : view.reason === "magicdns" ? "테일스케일의 MagicDNS가 꺼져 있습니다" : "테일스케일의 HTTPS 인증서가 꺼져 있습니다";
      tone = view.lost ? "warn" : "plain";
      body = <>
        {gone}
        {view.machine && view.reason !== "name" ? <p>이 PC의 테일넷 이름: <strong className="tailscale-address">{view.machine}</strong></p> : null}
        <p>{view.reason === "name" ? "테일스케일 관리 페이지에서 이 PC의 이름을 영문과 숫자로 바꾼 뒤 다시 확인을 누르세요."
          : view.reason === "magicdns" ? "테일스케일 관리 페이지의 DNS 화면에서 MagicDNS를 켠 뒤 다시 확인을 누르세요."
          : "테일스케일 관리 페이지의 DNS 화면에서 HTTPS Certificates(HTTPS 인증서)를 켠 뒤 다시 확인을 누르세요."}</p>
      </>;
      actions = <>{external("관리 페이지 열기", view.adminUrl)}{again()}{off()}</>; break;
    case "ready":
      title = "이 PC의 작업실을 내 테일스케일 안에서만 열기"; tone = view.lost ? "warn" : "plain";
      body = <>
        {gone}
        <p>켜기를 누르면 이 PC에서 아래 명령을 실행해 둡니다. 내 테일스케일에 로그인한 기기만 이 주소에 닿고, 인터넷 전체에는 열리지 않습니다.</p>
        {command(view.commandLine)}
        <p className="tailscale-standing">{STANDING}</p>
        <p>열릴 주소: <strong className="tailscale-address">{view.address}</strong></p>
        <p className="muted">작업실은 계속 이 PC 안(127.0.0.1)에서만 연결을 받고, 테일스케일이 그 앞에서 HTTPS로 이어 줍니다. 휴대폰은 처음 연결할 때 이 PC에서 여섯 자리 숫자로 승인해야 합니다.</p>
      </>;
      actions = <><button type="button" className="button primary" disabled={!!busy} aria-busy={busy === "on" || undefined} onClick={() => void act("on", () => api.tailscaleOn!(view.command))}>{busy === "on" ? "여는 중…" : view.ours ? "지금 다시 열기" : "켜기"}</button>{again()}{off()}</>;
      break;
    case "opening":
      title = "테일스케일 길을 여는 중입니다";
      body = <>
        <p>테일스케일이 이 PC의 HTTPS 주소를 준비하고 있습니다. 처음에는 인증서를 받느라 조금 걸릴 수 있습니다.</p>
        {command(view.commandLine, "실행 중인 명령")}
        <p>열릴 주소: <strong className="tailscale-address">{view.address}</strong></p>
      </>;
      actions = <>{again()}{off()}</>; break;
    case "background":
      title = "테일스케일에 이 앱으로 가는 길이 따로 열려 있습니다"; tone = "warn";
      body = <>
        {gone}
        <p>이 PC의 테일스케일 Serve에 443번(HTTPS)을 이 앱으로 계속 잇는 설정(백그라운드)이 남아 있습니다. 이 앱은 그 설정을 고치거나 지우지 않습니다.</p>
        <p>지우려면 터미널에서 아래 명령을 실행한 뒤 다시 확인을 누르세요.</p>
        {command(view.commandLine, "지우는 명령")}
      </>;
      actions = <>{again()}{off()}</>; break;
    case "taken":
      title = "테일스케일의 HTTPS 자리를 다른 것이 쓰고 있습니다"; tone = "warn";
      body = <>{gone}<p>이 PC의 테일스케일 Serve가 443번(HTTPS)을 이미 다른 곳({view.by})으로 잇고 있습니다. 그 설정을 덮어쓰지 않습니다.</p><p>테일스케일에서 그 Serve 설정을 끈 뒤 다시 확인을 누르세요.</p></>;
      actions = <>{again()}{off()}</>; break;
    case "funnel":
      title = "Funnel이 켜져 있어 연결하지 않습니다"; tone = "warn";
      body = <>{gone}<p>이 PC의 테일스케일 Funnel이 443번에 켜져 있어 그 주소는 인터넷 전체에 열립니다. 이 앱은 내 테일스케일 안(Serve)으로만 연결합니다.</p><p>테일스케일에서 Funnel을 끈 뒤 다시 확인을 누르세요.</p></>;
      actions = <>{again()}{off()}</>; break;
    case "on": {
      title = "켜짐: 내 테일스케일 안에서만 열림"; tone = "ok";
      const seen = view.seenAt;
      body = <>
        <p>다른 기기에서 접속할 주소: <strong className="tailscale-address">{view.address}</strong></p>
        {view.listenerOff ? <p>테일스케일은 이 PC로 이어져 있지만 작업실의 연결 받기가 꺼져 있습니다. 끈 다음 다시 켜 주세요.</p> : null}
        <p className={`tailscale-seen${seen ? " seen" : ""}`} role="status">{seen ? `휴대폰에서 열림 · ${time(seen)}` : "아직 이 주소로 연결한 기기가 없습니다."}</p>
        <ol className="tailscale-phone-steps">
          <li>휴대폰에 테일스케일 앱을 설치하고 이 PC와 같은 계정으로 로그인합니다.</li>
          <li>아래 QR을 휴대폰 카메라로 찍으면 휴대폰 브라우저에 작업실이 열립니다.</li>
          <li>휴대폰과 이 PC에 같은 여섯 자리 숫자가 보이는지 보고, 이 PC에서 승인합니다.</li>
        </ol>
        {offer && offer.qrDataUrl && /^data:image\/(png|svg\+xml);/i.test(offer.qrDataUrl) && offer.url.startsWith(view.address + "/") ? <div className="host-connection-offer">
          <img className="host-connection-qr" src={offer.qrDataUrl} alt="휴대폰으로 찍을 연결 QR 코드" />
          <p className="muted">한 번만 쓰는 QR입니다. {time(offer.expiresAt)}까지 쓸 수 있습니다. 승인은 아래 ‘휴대폰에 나온 숫자와 같은지 보고 승인합니다’에서 합니다.</p>
        </div> : null}
        {view.ours ? <>
          <p className="tailscale-standing">{STANDING}</p>
          <p className="muted">이 앱이 실행해 둔 명령: {command(view.commandLine, "실행 중인 명령")}</p>
          <p className="muted">끄기를 누르면 이 명령을 끝내고 연결 설정을 켜기 전으로 돌립니다. 테일스케일 설정에는 아무것도 남기지 않습니다.</p>
        </> : <p className="muted">이 Serve 설정은 이 앱이 켠 것이 아닙니다. 끄려면 테일스케일에서 끄세요.</p>}
      </>;
      actions = <>
        <button type="button" className="button primary" disabled={!!busy || !!view.listenerOff} aria-busy={busy === "offer" || undefined} onClick={() => void makeOffer()}>{busy === "offer" ? "만드는 중…" : offer ? "QR 다시 만들기" : "휴대폰으로 찍을 QR 만들기"}</button>
        {off()}
        {again()}
      </>;
      break;
    }
    case "error":
      title = "테일스케일 상태를 알 수 없습니다"; tone = "warn";
      body = <>{gone}<p>{view.message}</p></>;
      actions = <>{again()}{off()}</>; break;
  }
  return <section className={`host-connections-section tailscale-panel tone-${tone}`} aria-labelledby="tailscale-title" data-state={view?.state ?? "loading"}>
    <div className="host-connection-section-head"><h3 id="tailscale-title">테일스케일로 연결</h3></div>
    <div className="tailscale-card" aria-live="polite">
      <h4>{title}</h4>
      {body}
      {problem ? <p role="alert" className="host-connections-error">{problem}</p> : null}
      {actions ? <div className="host-connection-actions tailscale-actions">{actions}</div> : null}
    </div>
  </section>;
}
