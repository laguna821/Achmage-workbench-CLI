import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { DOORY_ATTRIBUTION, DOORY_CREDIT_LINE } from "@workbench/contracts";
import { attributionOf } from "../../web/licences.ts";
import { DooryCredit } from "./credit.tsx";

// vendor/doory/LICENSE (Attribution Assurance License) clause 2: a prominent display of the author's name,
// professional identification and URL each time the program starts — on the design editor's own page.

it("carries the licence's three items verbatim", () => {
  expect(attributionOf(readFileSync("vendor/doory/LICENSE", "utf8"))).toEqual(DOORY_ATTRIBUTION);
  expect(DOORY_CREDIT_LINE).toBe("Doory · Siam, Creator and maintainer of Doory · https://github.com/shaongitbd/doory");
});

it("is one line of text with the URL as a link that opens it", () => {
  const html = renderToStaticMarkup(createElement(DooryCredit));
  const text = html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");
  expect(text).toBe(DOORY_CREDIT_LINE);
  expect(html).toContain(`<a href="${DOORY_ATTRIBUTION.url}" target="_blank" rel="noreferrer">${DOORY_ATTRIBUTION.url}</a>`);
  expect(html).toContain('aria-label="디자인 편집기 저작자 표시"');
});

it("stands at the top of the editor's page, before the editor (not at its foot), in both modes", () => {
  const source = readFileSync("apps/design/src/EditorHost.tsx", "utf8");
  const ready = source.slice(source.lastIndexOf("  return ("));
  expect(ready.indexOf("<DooryCredit />")).toBeGreaterThan(-1);
  expect(ready.indexOf("<DooryCredit />")).toBeLessThan(ready.indexOf('className="wb-design-editor"'));
  expect(ready.slice(ready.indexOf("<DooryCredit />") - 200, ready.indexOf("<DooryCredit />"))).not.toMatch(/readOnly\s*&&|!init\.readOnly/);
  const css = readFileSync("apps/design/src/design.css", "utf8");
  const rule = /\.wb-design-credit \{([^}]*)\}/.exec(css)?.[1] ?? "";
  expect(rule).toMatch(/font-size: 12px/);
  expect(rule).toMatch(/color: var\(--color-text\)/);
  expect(rule).not.toMatch(/ellipsis|nowrap|display: none/);
});
