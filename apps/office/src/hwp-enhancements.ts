import type { HostFontProvider } from "../../../packages/contracts/src/hwp-fonts.ts";
import { installCrispCanvases } from "../../../third_party/hop/crisp-canvas.ts";

type StudioWindow = Window & { rhwpStudio?: { fonts: { setProvider(provider: HostFontProvider): Promise<void> } } };

/** The original HOP provider contract over the existing authenticated editor origin. */
export function installHwpEnhancements(frame: HTMLIFrameElement, token: string): () => void {
  const view = frame.contentWindow as StudioWindow | null, doc = frame.contentDocument;
  if (!view?.rhwpStudio || !doc) return () => {};
  const root = doc.getElementById("scroll-content");
  const stop = root ? installCrispCanvases(root) : () => {};
  const controller = new AbortController();
  const get = async (path: string, signal: AbortSignal) => {
    const response = await fetch(path, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.any([signal, controller.signal]) });
    if (!response.ok) throw new Error("설치된 글꼴을 읽지 못했습니다. 문서를 다시 열어 주세요.");
    return response;
  };
  const provider: HostFontProvider = {
    async getSnapshot(signal) { return (await get("/api/fonts/hwp-catalog", signal)).json(); },
    async readFace(id, revision, signal) {
      const response = await get(`/api/fonts/hwp-face/${encodeURIComponent(id)}?revision=${encodeURIComponent(revision)}`, signal);
      return { bytes: await response.arrayBuffer(), faceIndex: Number(response.headers.get("x-workbench-font-index")) || 0 };
    },
    subscribe() { return () => {}; },
  };
  void view.rhwpStudio.fonts.setProvider(provider).catch(error => {
    if (!controller.signal.aborted) console.warn("한글 설치 글꼴 연결:", error);
  });
  return () => { controller.abort(); stop(); };
}
