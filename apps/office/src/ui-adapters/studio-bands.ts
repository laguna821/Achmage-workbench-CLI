/** The studio's settings (rhwp-studio core/user-settings.ts STORAGE_KEY), read before its first paint. */
const SETTINGS = "rhwp-settings";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/** Set once this default has been applied on this computer; afterwards the studio's own remembered choice rules. */
const APPLIED = "wb.hwp.toolbox-shown.v2";

/**
 * The Hangul studio opens with its basic toolbox (오려 두기 … 찾기, the icon row under the menus) SHOWN, as
 * rhwp and Achmage HOP do — the owner's ruling of 2026-11-15 ("메뉴만 있고 … 그 바로 밑에 클릭할 수 있는 도구는
 * 안 보이는"). Skin 2 had folded it by default and written `view.toolbarBasic: false` into the studio's
 * settings where nothing was stored; that write is undone ONCE here (a `false` stored before this ran is
 * taken to be that default, not a choice). After this one time nothing is changed: the studio's fold key at
 * the end of the menu row (Ctrl+F1) and 보기 › 도구 상자 still fold it, and the studio remembers that.
 */
export function showStudioToolboxByDefault(storage: Storage): void {
  try {
    if (storage.getItem(APPLIED)) return;
    let settings: Record<string, unknown> = {};
    try { const stored = JSON.parse(storage.getItem(SETTINGS) ?? "{}"); if (stored && typeof stored === "object" && !Array.isArray(stored)) settings = stored; } catch { /* rewritten below */ }
    const view = settings.view && typeof settings.view === "object" && !Array.isArray(settings.view) ? settings.view as Record<string, unknown> : {};
    if (view.toolbarBasic !== true) storage.setItem(SETTINGS, JSON.stringify({ ...settings, view: { ...view, toolbarBasic: true } }));
    storage.setItem(APPLIED, "1");
  } catch { /* storage unavailable: the studio's default (shown) */ }
}
