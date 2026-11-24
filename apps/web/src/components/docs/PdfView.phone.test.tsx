// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Api } from "../../api.ts";
import { PdfView } from "./PdfView.tsx";

// 0.5.6 round 2: on a phone joined to the PC the PDF is read; its 쪽 편집 (돌리기, 삭제) is the PC's — not offered, one line why.
afterEach(cleanup);
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
const api = { raw: vi.fn(() => new Promise<ArrayBuffer>(() => undefined)) } as unknown as Api;

it("with no page edits (a phone): no 돌리기 / 삭제, one line saying where they are", () => {
  render(<PdfView api={api} artifactId="p1" revision={1} onSelection={() => undefined} />);
  expect(screen.queryByRole("button", { name: "오른쪽으로 돌리기" })).toBeNull();
  expect(screen.queryByRole("button", { name: "삭제" })).toBeNull();
  expect(screen.getByText("쪽 돌리기·지우기는 PC에서 합니다")).toBeTruthy();
});

it("on the PC: the page edits as before", () => {
  render(<PdfView api={api} artifactId="p1" revision={1} onSelection={() => undefined} onEdit={async () => undefined} />);
  expect(screen.getByRole("button", { name: "오른쪽으로 돌리기" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "삭제" })).toBeTruthy();
});
