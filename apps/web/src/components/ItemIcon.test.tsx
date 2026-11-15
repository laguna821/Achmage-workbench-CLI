// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { ItemIcon, artifactKind, itemKindOf } from "./ItemIcon.tsx";
import { readUiFont, uiFontStack } from "../theme.ts";

// atlas-look: the item icons are Icons8's Liquid Glass artwork (as Atlas File Manager uses), with its notice;
// one box per icon (the line icon's size), tinted per kind; the 글꼴 choice, old records = Pretendard.

it("draws an item in the line icon's box, its kind's hue, the artwork as its shape", () => {
  const { container } = render(<ItemIcon kind="project" size={15} className="side-row-icon" />);
  const icon = container.firstElementChild as HTMLElement;
  expect([icon.className, icon.style.width, icon.style.height, icon.getAttribute("aria-hidden")]).toEqual(["item-icon item-project side-row-icon", "15px", "15px", "true"]);
  expect(icon.style.getPropertyValue("--item-art")).toMatch(/create-new\.png/);
});

it("gives every document format a kind: 한글, Word, PowerPoint, Excel, PDF, Markdown, design, web", () => {
  const kinds = (["hwpx", "hwp", "docx", "pptx", "xlsx", "pdf", "markdown", "design", "html"] as const).map((format) => artifactKind({ format, name: `a.${format}` }));
  expect(kinds).toEqual(["hwp", "hwp", "word", "slides", "sheet", "pdf", "markdown", "design", "web"]);
  expect([itemKindOf("project"), itemKindOf("globe"), itemKindOf("chevronDown")]).toEqual(["project", "web", null]);
});

it("ships the artwork with its notice (source, licence, attribution, each file's address)", () => {
  const dir = "apps/web/src/vendor/icons8-liquid-glass";
  const notice = readFileSync(`${dir}/NOTICE.md`, "utf8");
  expect(notice).toContain("https://icons8.com/license");
  expect(notice).toMatch(/free use requires\s+attribution/i);
  for (const png of readdirSync(dir).filter((name) => name.endsWith(".png"))) expect([png, notice.includes(png)]).toEqual([png, true]);
});

it("글꼴: an old record is Pretendard; the system face and a named face go through the one token", () => {
  expect([readUiFont(undefined), readUiFont("serif"), readUiFont("system"), readUiFont("custom:나눔고딕")]).toEqual(["pretendard", "pretendard", "system", "custom:나눔고딕"]);
  expect([uiFontStack("pretendard"), uiFontStack("system"), uiFontStack('custom:My"Font')]).toEqual([null, "var(--font-system)", '"MyFont", var(--font-pretendard)']);
});
