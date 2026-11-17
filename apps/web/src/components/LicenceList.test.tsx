// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { collectLicences, licenceOf } from "../../licences.ts";
import { AboutSection } from "./Connections.tsx";
import { LicenceList } from "./LicenceList.tsx";

// 설정 › 정보 › 오픈소스 라이선스: generated from the notices the repository ships (no typed licence text).

afterEach(cleanup);

it("collects one entry per shipped component from its own notice files, the licence named from the text", () => {
  const entries = collectLicences(process.cwd());
  const names = entries.map((entry) => entry.name);
  expect(new Set(names).size).toBe(names.length);
  for (const expected of ["doory", "hop", "ieumoffice", "paseo", "pretendard", "lucide", "hallym-kordoc"]) expect(names).toContain(expected);
  for (const entry of entries.filter((each) => !each.href)) {
    expect(entry.files.length).toBeGreaterThan(0);
    expect(entry.text.length).toBeGreaterThan(100);
  }
  const doory = entries.find((entry) => entry.name === "doory")!;
  expect(doory.licences).toContain("Attribution Assurance License");
  expect(doory.attribution).toBe("Siam, Creator and maintainer of Doory, https://github.com/shaongitbd/doory");
  expect(doory.files).toContain("vendor/doory/LICENSE");
  expect(entries.find((entry) => entry.name === "resvg-wasm")?.licences).toEqual(["MPL-2.0"]);
});

it("names a licence from its own words, the MPL before the GPL it mentions", () => {
  expect(licenceOf("Mozilla Public License Version 2.0\n… GNU General Public License, Version 2.0 …")).toBe("MPL-2.0");
  expect(licenceOf("MIT License\n\nCopyright (c) 2026")).toBe("MIT");
  expect(licenceOf("                                 Apache License\n                           Version 2.0, January 2004")).toBe("Apache-2.0");
  expect(licenceOf("some words")).toBeNull();
});

const respond = (body: unknown, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 404, json: () => Promise.resolve(body), text: () => Promise.resolve(String(body)) } as Response);

it("lists names and licences in 정보 and shows a text only when asked", async () => {
  const load = vi.fn((path: string) => path === "licences/index.json"
    ? respond([{ name: "doory", licences: ["Attribution Assurance License"], files: ["vendor/doory/LICENSE"], attribution: "Siam, Creator and maintainer of Doory, https://github.com/shaongitbd/doory" }, { name: "hop", licences: ["MIT"], files: ["third_party/hop/LICENSE"] }])
    : respond(`TEXT OF ${path}`));
  await act(async () => { render(<AboutSection hostLabel="이 PC" licences={<LicenceList load={load} />} />); });
  expect(screen.getByText("doory")).toBeTruthy();
  expect(screen.getByText("Attribution Assurance License")).toBeTruthy();
  expect(screen.getByText("Siam, Creator and maintainer of Doory, https://github.com/shaongitbd/doory")).toBeTruthy();
  expect(screen.getByText("MIT")).toBeTruthy();
  expect(screen.queryByText(/TEXT OF/)).toBeNull();
  const keys = screen.getAllByRole("button", { name: "전문 보기" });
  await act(async () => { fireEvent.click(keys[1]!); });
  expect(screen.getByText("TEXT OF licences/hop.txt")).toBeTruthy();
  expect(screen.getByRole("button", { name: "전문 닫기" }).getAttribute("aria-expanded")).toBe("true");
  // The fallback row of 정보 gives way to the list.
  expect(screen.queryByText("함께 쓴 오픈소스")).toBeNull();
});

it("says what happened when the list cannot be read", async () => {
  await act(async () => { render(<LicenceList load={() => respond(null, false)} />); });
  expect(screen.getByText(/목록을 불러오지 못했습니다/)).toBeTruthy();
});

/** A repository-shaped fixture: { "vendor/a/LICENSE": "…", … }. */
function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "wb-licences-"));
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); }
  return root;
}
const MIT = "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software, " + "x".repeat(80);

it("lists identical notice texts once, never a .json manifest, and a group folder's components (third_party/skills/*)", () => {
  const root = tree({ "vendor/a/LICENSE": MIT, "third_party/a/LICENSE.md": MIT, "vendor/a/license.json": "{}", "third_party/skills/kordoc/LICENSE": MIT + " kordoc" });
  try {
    const entries = collectLicences(root);
    expect(entries.map((entry) => entry.name)).toContain("kordoc");
    const a = entries.find((entry) => entry.name === "a")!;
    expect(a.files).toEqual(["third_party/a/LICENSE.md"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("fails the build for a shipped component without a notice (no silent drop)", () => {
  const root = tree({ "vendor/a/LICENSE": MIT, "vendor/b/README.md": "no licence here" });
  try { expect(() => collectLicences(root)).toThrow(/vendor\/b/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

// Release re-review 1, next round 3: a component without a notice INSIDE a group folder was dropped silently.
it("fails the build for a component without a notice inside a group folder (third_party/skills/x), naming it", () => {
  const root = tree({ "third_party/skills/kordoc/LICENSE": MIT, "third_party/skills/zz-nolicence/SKILL.md": "no licence here" });
  try { expect(() => collectLicences(root)).toThrow(/third_party\/skills\/zz-nolicence/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

it("orders by code point, the same on every build machine", () => {
  const root = tree({ "vendor/b/LICENSE": MIT + "b", "vendor/a/LICENSE": MIT + "a", "vendor/B/LICENSE": MIT + "B", "vendor/_x/LICENSE": MIT + "x" });
  try { expect(collectLicences(root).filter((entry) => !entry.href).map((entry) => entry.name)).toEqual(["B", "_x", "a", "b"]); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

it("lists the office editors' own notices, read from the editors' bundle", async () => {
  const office = collectLicences(process.cwd()).find((entry) => entry.href);
  expect(office).toMatchObject({ name: "이음오피스 편집기의 구성 요소", href: "office/THIRD-PARTY-NOTICES.txt" });
  const load = vi.fn((path: string) => path === "licences/index.json" ? respond([{ name: office!.name, licences: [], files: [], href: office!.href }]) : respond(`TEXT OF ${path}`));
  await act(async () => { render(<LicenceList load={load} />); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "전문 보기" })); });
  expect(screen.getByText("TEXT OF office/THIRD-PARTY-NOTICES.txt")).toBeTruthy();
});
