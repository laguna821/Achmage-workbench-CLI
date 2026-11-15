import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Skin 2 fix 1, ruling 6: the composer's send/stop key was the only TEAL filled key (rest teal, hover and
// press navy: a hue change under the hand). It is navy like every filled key, the same hue at rest,
// hover and press (the primary recipe's own steps). No sheet may paint it with the accent.
const sheets = ["styles/hig-chat.css", "styles/controls.css", "styles.css"].map((path) => readFileSync(resolve("apps/web/src", path), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""));
it("the composer's filled key takes the navy primary fill, never the accent", () => {
  const rules = sheets.flatMap((css) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /composer[^,{]*\.icon-button\.primary|composer[^,{]*\.stop/.test(m[1]!)).map((m) => `${m[1]!.trim()} { ${m[2]!.trim()} }`));
  expect(rules.filter((rule) => /--c-fill(?:-hover|-press)?\s*:\s*var\(--(?:accent|color-teal)/.test(rule))).toEqual([]);
});
