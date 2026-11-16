// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Api } from "../api.ts";
import { EditorAiRow } from "./Connections.tsx";

// 설정 › 문서 도구 (I7): the editors' own AI 도우미 can be shown or hidden, with one line on how it differs from 문서 AI.
afterEach(cleanup);

it("shows the stored choice, changes it on a click, and says how it differs from 문서 AI", async () => {
  let shown = true;
  const request = vi.fn(async (_method: string, _path: string, body: { channel: string; args: { showAiSidebar?: boolean }[] }) => {
    if (body.channel === "home:set-ai-panel-prefs") shown = body.args[0]!.showAiSidebar !== false;
    return { showAiSidebar: shown };
  });
  await act(async () => { render(<EditorAiRow api={{ request } as unknown as Api} />); });
  const toggle = screen.getByRole("switch", { name: "편집기 안에 문서 AI 보이기" }) as HTMLInputElement;
  expect(toggle.checked).toBe(true);
  expect(document.body.textContent).toContain("끄면 문서 AI는 문서 옆 대화로 열리고, 사본에서 고친 뒤 수정안으로 돌려줍니다");
  await act(async () => { fireEvent.click(toggle); });
  expect(request).toHaveBeenLastCalledWith("POST", "/api/office-preferences", { channel: "home:set-ai-panel-prefs", args: [{ showAiSidebar: false }] });
  expect((screen.getByRole("switch", { name: "편집기 안에 문서 AI 보이기" }) as HTMLInputElement).checked).toBe(false);
});
