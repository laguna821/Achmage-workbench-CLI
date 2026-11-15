import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { showStudioToolboxByDefault } from "./studio-bands.ts";

const store = (entries: [string, string][] = []) => {
  const map = new Map(entries);
  return { map, storage: { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) } };
};
const settings = (map: Map<string, string>) => JSON.parse(map.get("rhwp-settings")!);

it("opens the Hangul studio with its basic toolbox SHOWN, once, keeping every other setting", () => {
  const fresh = store();
  showStudioToolboxByDefault(fresh.storage);
  expect(settings(fresh.map)).toEqual({ view: { toolbarBasic: true } });
  expect(fresh.map.get("wb.hwp.toolbox-shown.v2")).toBe("1");
  const other = store([["rhwp-settings", JSON.stringify({ theme: { mode: "dark", skin: "default" }, view: { zoom: 1.2, toolbarFormat: true } })]]);
  showStudioToolboxByDefault(other.storage);
  expect(settings(other.map)).toEqual({ theme: { mode: "dark", skin: "default" }, view: { zoom: 1.2, toolbarFormat: true, toolbarBasic: true } });
  const broken = store([["rhwp-settings", "not json"]]);
  showStudioToolboxByDefault(broken.storage);
  expect(settings(broken.map)).toEqual({ view: { toolbarBasic: true } });
});

it("undoes the fold that skin 2's default wrote — once; a fold chosen afterwards stays", () => {
  const folded = store([["rhwp-settings", JSON.stringify({ view: { zoom: 1.1, toolbarBasic: false } })]]);
  showStudioToolboxByDefault(folded.storage);
  expect(settings(folded.map)).toEqual({ view: { zoom: 1.1, toolbarBasic: true } });
  // The person folds it with the studio's own key (Ctrl+F1): the studio stores false; the next open keeps it.
  folded.map.set("rhwp-settings", JSON.stringify({ view: { zoom: 1.1, toolbarBasic: false } }));
  const raw = folded.map.get("rhwp-settings");
  showStudioToolboxByDefault(folded.storage);
  expect(folded.map.get("rhwp-settings")).toBe(raw);
});

// The studio's source comes from the pinned checkout the studio build unpacks; a fresh checkout has none
// until `node scripts/build-hwp-studio.mjs` ran: this check is then SKIPPED with the reason in its name
// (the same rule as ui-adapters.test.ts, review M4) — except in CI, where the build runs first and a
// missing source fails.
const studio = "vendor/ieumoffice/apps/hwp/node_modules/.cache/rhwp-studio/v0.9.0/rhwp-studio";
const NO_STUDIO = existsSync(`${studio}/src/core/user-settings.ts`) || process.env.CI ? null
  : `skipped: no rhwp-studio v0.9.0 source at ${studio} (run node scripts/build-hwp-studio.mjs)`;
if (NO_STUDIO) console.warn(`studio-bands: 1 studio check ${NO_STUDIO}`);

(NO_STUDIO ? it.skip : it)(`names the studio's own setting and its fold key, so the toolbox stays one press away${NO_STUDIO ? ` [${NO_STUDIO}]` : ""}`, () => {
  expect(readFileSync(`${studio}/src/core/user-settings.ts`, "utf8")).toMatch(/STORAGE_KEY = 'rhwp-settings'[\s\S]*toolbarBasic: true/);
  expect(readFileSync(`${studio}/public/theme-init.js`, "utf8")).toContain("view.toolbarBasic === false");
  expect(readFileSync(`${studio}/index.html`, "utf8")).toMatch(/id="toolbox-basic-toggle"[^>]*data-cmd="view:toolbox-basic"/);
});
