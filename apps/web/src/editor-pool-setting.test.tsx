// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { EditorPoolRow } from "./components/Connections.tsx";
import { EDITOR_POOL_HINT, poolKindOf, readEditorPool } from "./editor-pool.ts";

// 설정 › 문서 도구 › 「같은 종류 문서는 편집기 함께 쓰기」: the editor pool's master switch (on by default).

afterEach(() => { cleanup(); localStorage.clear(); });

it("is on by default; turned off, every kind opens one editor per tab (new tabs); on again, the pooled kinds share", () => {
  expect(readEditorPool()).toBe(true);
  render(<EditorPoolRow />);
  const toggle = screen.getByRole("switch", { name: "같은 종류 문서는 편집기 함께 쓰기" });
  expect((toggle as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText(EDITOR_POOL_HINT)).toBeTruthy();
  expect(poolKindOf("docx")).toBe("docs");
  fireEvent.click(toggle);
  expect(readEditorPool()).toBe(false);
  expect(localStorage.getItem("workbench.editorPool")).toBe("off");
  for (const format of ["docx", "pptx", "xlsx"] as const) expect(poolKindOf(format)).toBeNull();
  // The per-kind keys (rigs) do not override the person's off.
  localStorage.setItem("workbench.pool.docs", "on");
  expect(poolKindOf("docx")).toBeNull();
  fireEvent.click(screen.getByRole("switch", { name: "같은 종류 문서는 편집기 함께 쓰기" }));
  expect(poolKindOf("docx")).toBe("docs");
});
