import type { HostFontProvider, HostFontSnapshot } from "../../../packages/contracts/src/hwp-fonts.ts";
import { installCrispCanvases } from "../../../third_party/hop/crisp-canvas.ts";
import { enhanceCustomSelects } from "../../../third_party/hop/custom-select.ts";
import { installHwpFontRule } from "./hwp-fonts.ts";

type StudioWindow = Window & { rhwpStudio?: { fonts: { setProvider(provider: HostFontProvider): Promise<void> } } };

/** The original HOP provider contract over the existing authenticated editor origin. */
export function installHwpEnhancements(frame: HTMLIFrameElement, token: string): () => void {
  const view = frame.contentWindow as StudioWindow | null, doc = frame.contentDocument;
  if (!view?.rhwpStudio || !doc) return () => {};
  const root = doc.getElementById("scroll-content");
  const stopCrisp = root ? installCrispCanvases(root) : () => {};
  // The font name opens the studio's own categorised picker (document, installed, all fonts).
  const stopSelects = enhanceCustomSelects(doc, { ownPicker: "#font-name" });
  const controller = new AbortController();
  const get = async (path: string, signal: AbortSignal) => {
    const response = await fetch(path, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.any([signal, controller.signal]) });
    if (!response.ok) throw new Error("설치된 글꼴을 읽지 못했습니다. 문서를 다시 열어 주세요.");
    return response;
  };
  const snapshot = async (signal: AbortSignal): Promise<HostFontSnapshot> => (await get("/api/fonts/hwp-catalog", signal)).json();
  // One request serves the HY / 휴먼 rule and the studio's first snapshot.
  let first: Promise<HostFontSnapshot> | null = snapshot(controller.signal);
  const stopFonts = installHwpFontRule(doc, first);
  const provider: HostFontProvider = {
    getSnapshot(signal) { const shared = first; first = null; return shared ?? snapshot(signal); },
    async readFace(id, revision, signal) {
      const response = await get(`/api/fonts/hwp-face/${encodeURIComponent(id)}?revision=${encodeURIComponent(revision)}`, signal);
      return { bytes: await response.arrayBuffer(), faceIndex: Number(response.headers.get("x-workbench-font-index")) || 0 };
    },
    subscribe() { return () => {}; },
  };
  void view.rhwpStudio.fonts.setProvider(provider).catch(error => {
    if (!controller.signal.aborted) console.warn("한글 설치 글꼴 연결:", error);
  });
  return () => { controller.abort(); stopCrisp(); stopSelects(); stopFonts(); };
}

/**
 * The studio's own skins (flat, old-school) restyle its bars over the app's skin; its menu for
 * them is hidden, and a skin chosen before is set back to the default before the studio starts.
 */
export function pinStudioSkin(storage: Storage) {
  let settings: Record<string, unknown> = {};
  try { const stored = JSON.parse(storage.getItem("rhwp-settings") ?? "{}"); if (stored && typeof stored === "object" && !Array.isArray(stored)) settings = stored; } catch { /* rewritten below */ }
  const theme = settings.theme && typeof settings.theme === "object" ? settings.theme as Record<string, unknown> : {};
  if (theme.skin === "default") return;
  storage.setItem("rhwp-settings", JSON.stringify({ ...settings, theme: { ...theme, skin: "default" } }));
}
