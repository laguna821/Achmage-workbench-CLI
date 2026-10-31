// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Artifact } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { OfficeFileMenu } from "./OfficeFileMenu.tsx";

beforeEach(() => { vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function props() {
  return { api: { createOfficeDocument: vi.fn(async () => ({ id: "new", name: "new.docx" })), openFile: vi.fn(async () => ({ id: "opened" })) } as unknown as Api,
    workId: "work", workspaceId: "space", sessionId: "session", cwd: "/project", sourceKey: "source",
    beforeOpen: vi.fn(async () => true), onOpenArtifact: vi.fn(), onToast: vi.fn() };
}
async function create(screen: ReturnType<typeof render>) {
  fireEvent.click(screen.getByRole("button", { name: "문서 파일 메뉴" }));
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: /^워드 문서/ })); });
}
it("saves the source before creating and carries the exact workspace and session", async () => {
  const p = props(), screen = render(<OfficeFileMenu {...p} />);
  await create(screen);
  expect(p.beforeOpen).toHaveBeenCalledOnce();
  expect(p.api.createOfficeDocument).toHaveBeenCalledWith("work", { format: "docx", workspaceId: "space", sessionId: "session" });
  expect(p.onOpenArtifact).toHaveBeenCalledWith("new");
});
it("does not create or navigate when saving the current document fails", async () => {
  const p = props(); p.beforeOpen.mockResolvedValue(false);
  await create(render(<OfficeFileMenu {...p} />));
  expect(p.api.createOfficeDocument).not.toHaveBeenCalled(); expect(p.onOpenArtifact).not.toHaveBeenCalled();
});
it("retains a completed document without navigating into a different conversation", async () => {
  const p = props(); let finish!: (artifact: Artifact) => void;
  vi.mocked(p.api.createOfficeDocument).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const screen = render(<OfficeFileMenu {...p} />); await create(screen);
  screen.rerender(<OfficeFileMenu {...p} sessionId="another-session" />);
  await act(async () => { finish({ id: "new", name: "new.docx" } as Artifact); });
  expect(p.onOpenArtifact).not.toHaveBeenCalled(); expect(p.onToast).toHaveBeenCalledWith(expect.stringContaining("new.docx"));
});
it("cancels a file picker without saving and opens a picked file in the same scope", async () => {
  const p = props(), pickFile = vi.fn<() => Promise<string | null>>().mockResolvedValueOnce(null).mockResolvedValueOnce("/project/book.epub");
  const screen = render(<OfficeFileMenu {...p} pickFile={pickFile} />);
  const open = async () => { fireEvent.click(screen.getByRole("button", { name: "문서 파일 메뉴" })); await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "파일 열기…" })); }); };
  await open(); expect(p.beforeOpen).not.toHaveBeenCalled(); expect(p.api.openFile).not.toHaveBeenCalled();
  await open(); expect(p.api.openFile).toHaveBeenCalledWith("work", "/project/book.epub", "space", "session"); expect(p.onOpenArtifact).toHaveBeenCalledWith("opened");
});
