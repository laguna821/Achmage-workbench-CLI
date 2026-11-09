import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { parseRemoteOffer } from "@workbench/client";
import { openPairScan } from "../../../../vendor/paseo/onboarding/pair-scan-model.ts";
import { cameraProblem, createQrReader, qrImage } from "../qr-reader.ts";

/** Reads an offer only. Connecting and the host's grant confirmation remain separate actions. */
export function QrScanner({ onOffer, onClose }: { onOffer(link: string): void; onClose(): void }) {
  const video = useRef<HTMLVideoElement>(null), input = useRef<HTMLInputElement>(null);
  const stream = useRef<MediaStream | null>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reader = useRef<Awaited<ReturnType<typeof createQrReader>> | null>(null);
  const live = useRef(true), generation = useRef(0), accepted = useRef<string | null>(null);
  const callbacks = useRef({ onOffer, onClose }); callbacks.current = { onOffer, onClose };
  const [camera, setCamera] = useState<"off" | "requesting" | "running">("off");
  const [message, setMessage] = useState("카메라 또는 QR 그림을 선택하세요. 영상과 그림은 이 기기에서만 읽습니다.");
  const [error, setError] = useState<string | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  function stop() {
    generation.current++;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
    if (video.current) { video.current.pause(); video.current.srcObject = null; }
    reader.current?.close(); reader.current = null;
    if (live.current) setCamera("off");
  }
  const [scan] = useState(() => openPairScan({
    async importConnectionLink(link) {
      stop();
      const offer = parseRemoteOffer(link);
      accepted.current = link;
      return { status: "connected", serverId: offer.serverId };
    },
    onConnected() {
      if (live.current && accepted.current) callbacks.current.onOffer(accepted.current);
    },
  }));
  const scanState = useSyncExternalStore(scan.subscribe, scan.getState, scan.getState);
  useEffect(() => {
    live.current = true;
    const hide = () => {
      if (document.visibilityState !== "hidden") return;
      stop();
      setMessage("다른 화면으로 이동해 카메라를 껐습니다. 다시 켜려면 버튼을 눌러 주세요.");
    };
    const leave = () => stop();
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", leave);
    return () => {
      live.current = false; stop();
      // React's development effect replay reuses this model; a real unmount closes it.
      queueMicrotask(() => { if (!live.current) scan.close(); });
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", leave);
    };
  }, [scan]);
  const start = async () => {
    stop(); scan.scanAgain(); setError(null);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError("카메라는 HTTPS 또는 이 기기의 로컬 주소에서 사용할 수 있습니다. QR 그림이나 연결 링크를 사용하세요.");
      return;
    }
    const visit = generation.current;
    setCamera("requesting"); setMessage("브라우저의 카메라 권한 요청을 확인해 주세요.");
    try {
      const next = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } });
      if (!live.current || visit !== generation.current) { next.getTracks().forEach(track => track.stop()); return; }
      stream.current = next;
      for (const track of next.getVideoTracks()) track.addEventListener("ended", () => {
        if (live.current && visit === generation.current) { stop(); setError("카메라 연결이 끝났습니다. 다시 켜거나 QR 그림을 선택해 주세요."); }
      }, { once: true });
      const decoder = await createQrReader();
      if (!live.current || visit !== generation.current) { decoder.close(); return; }
      reader.current = decoder;
      const element = video.current;
      if (!element) { stop(); return; }
      element.srcObject = next; await element.play();
      if (!live.current || visit !== generation.current) return;
      setCamera("running"); setMessage("호스트의 연결 QR을 비춰 주세요.");
      const read = async () => {
        if (!live.current || visit !== generation.current) return;
        try {
          const value = element.readyState >= 2 ? await decoder.read(element) : null;
          if (!live.current || visit !== generation.current) return;
          if (value) scan.scan(value);
          if (scan.getState().status === "scanning" && visit === generation.current) timer.current = setTimeout(() => void read(), 300);
        } catch (reason) {
          if (live.current && visit === generation.current) { stop(); setError(cameraProblem(reason)); }
        }
      };
      void read();
    } catch (reason) {
      if (live.current && visit === generation.current) { stop(); setError(cameraProblem(reason)); }
    }
  };
  const fromImage = async (file: File) => {
    stop(); scan.scanAgain(); setError(null); setImageBusy(true);
    const visit = generation.current;
    let picture: Awaited<ReturnType<typeof qrImage>> | null = null;
    let decoder: Awaited<ReturnType<typeof createQrReader>> | null = null;
    try {
      picture = await qrImage(file); decoder = await createQrReader();
      if (!live.current || visit !== generation.current) return;
      const value = await decoder.read(picture.image);
      if (!live.current || visit !== generation.current) return;
      if (!value) throw new Error("그림에서 QR을 찾지 못했습니다. QR 전체가 선명한 그림을 골라 주세요.");
      scan.scan(value);
      if (scan.getState().status === "scanning") throw new Error("Workbench 연결 QR이 아닙니다. 호스트에서 새 연결 링크를 만들어 주세요.");
    } catch (reason) { if (live.current && visit === generation.current) setError(cameraProblem(reason)); }
    finally {
      picture?.close(); decoder?.close();
      if (live.current) setImageBusy(false);
    }
  };
  const scanError = scanState.status === "stopped" ? scanState.error : null;
  return <section className="host-qr-scanner" aria-label="연결 QR 읽기">
    <video ref={video} muted playsInline autoPlay aria-label="QR 카메라 미리보기" hidden={camera === "off"} />
    <p role="status">{message}</p>
    {error || scanError ? <p className="host-connections-error" role="alert">{error ?? scanError}</p> : null}
    <div className="host-connection-actions">
      <button type="button" className="button" disabled={camera !== "off" || imageBusy} onClick={() => void start()}>카메라 켜기</button>
      {camera !== "off" ? <button type="button" className="button" onClick={() => { stop(); setMessage("카메라를 껐습니다."); }}>카메라 중단</button> : null}
      <button type="button" className="button" disabled={imageBusy} onClick={() => { stop(); input.current?.click(); }}>{imageBusy ? "그림 읽는 중…" : "QR 그림 선택"}</button>
      <button type="button" className="text-button" onClick={() => { stop(); callbacks.current.onClose(); }}>닫고 링크 붙여넣기</button>
    </div>
    <input ref={input} type="file" accept="image/*" hidden onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void fromImage(file); }} />
    <small>QR을 읽으면 연결 대상만 채웁니다. 기기 이름을 확인하고 ‘연결 요청’을 누른 뒤 호스트에서 승인하세요.</small>
  </section>;
}
