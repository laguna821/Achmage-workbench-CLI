// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { installHwpEnhancements, pinStudioSkin } from "./hwp-enhancements.ts";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

function studioFrame(html: string) {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  frame.contentDocument!.body.innerHTML = html;
  const setProvider = vi.fn(async () => {});
  Object.assign(frame.contentWindow!, { rhwpStudio: { fonts: { setProvider } } });
  return { frame, doc: frame.contentDocument!, setProvider };
}

it("draws the studio's drop-downs in the app's own shape while installed, and gives the original selects back", () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
  const { frame, doc } = studioFrame('<div id="style-bar"><select id="font-lang" class="sb-combo" title="글꼴 적용 언어"><option>대표</option><option>한글</option></select></div><div id="scroll-content"></div>');
  const stop = installHwpEnhancements(frame, "token");
  const trigger = doc.querySelector<HTMLElement>('#style-bar [role="combobox"]');
  expect(trigger?.getAttribute("aria-label")).toBe("글꼴 적용 언어");
  expect(doc.querySelector("#style-bar .custom-select-value")?.textContent).toBe("대표");
  stop();
  expect(doc.querySelector('[role="combobox"]')).toBeNull();
  expect(doc.querySelector("#style-bar > select#font-lang")).not.toBeNull();
});

it("keeps the studio on its default skin so the app's skin is the one drawn, and keeps every other setting", () => {
  const storage = new Map<string, string>([["rhwp-settings", JSON.stringify({ theme: { mode: "dark", skin: "flat" }, view: { zoom: 1.2 } })]]);
  const store = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => void storage.set(key, value) } as Storage;
  pinStudioSkin(store);
  expect(JSON.parse(storage.get("rhwp-settings")!)).toEqual({ theme: { mode: "dark", skin: "default" }, view: { zoom: 1.2 } });
  storage.set("rhwp-settings", "not json");
  pinStudioSkin(store);
  expect(JSON.parse(storage.get("rhwp-settings")!)).toEqual({ theme: { skin: "default" } });
});

it("applies the HY / 휴먼 rule from the gateway's catalogue, with one catalogue request shared with the studio", async () => {
  const catalogue = { revision: "r1", faces: [{ id: "a", family: "Noto Sans CJK KR", fullName: "", postscriptName: "", style: "Regular" }] };
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(catalogue)));
  const { frame, doc, setProvider } = studioFrame('<div id="style-bar"><select id="font-name" class="sb-combo"><option>함초롬바탕</option><option>HY견고딕</option></select></div><div id="scroll-content"></div>');
  Object.assign(frame.contentWindow!, { FontFace: class { load() { return Promise.resolve(this); } } });
  Object.defineProperty(doc, "fonts", { configurable: true, value: { add: vi.fn(), delete: vi.fn() } });
  const stop = installHwpEnhancements(frame, "token");
  const provider = (setProvider.mock.calls[0] as unknown as [import("../../../packages/contracts/src/hwp-fonts.ts").HostFontProvider])[0];
  expect(await provider.getSnapshot(new AbortController().signal)).toEqual(catalogue);
  await new Promise(resolve => setTimeout(resolve, 0));
  const option = [...doc.querySelectorAll("option")].find(item => item.value === "HY견고딕")!;
  expect(option.hidden).toBe(true);
  expect(fetch.mock.calls.filter(([url]) => String(url).includes("/api/fonts/hwp-catalog")).length).toBe(1);
  expect((doc.fonts.add as ReturnType<typeof vi.fn>).mock.calls.length).toBe(8);
  stop();
  expect(option.hidden).toBe(false);
});
