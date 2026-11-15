// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Artifact, Proposal } from "@workbench/contracts";
import { AppearanceContext } from "../appearance.ts";
import type { State } from "../state.ts";
import { DocContext, ProposalCard } from "./DocCards.tsx";

vi.mock("../office.ts", () => ({ useOfficePage: () => ({ url: null, error: null }) }));

const artifact = { id: "doc", name: "계획서.hwpx", format: "hwpx", revision: 1, path: "/계획서.hwpx" } as Artifact;
const proposal = (extra: Partial<Proposal>): Proposal => ({ id: "p", artifactId: "doc", sessionId: "s", requestId: "r", baseRevision: 1, workingPath: "/w.hwpx", status: "pending", added: 1, removed: 3, appliedRevision: null, ...extra }) as Proposal;
function card(value: Proposal) {
  const state = { artifacts: { doc: artifact }, sessions: {} } as unknown as State;
  const actions = { openArtifact: vi.fn(), applyProposal: vi.fn(), discardProposal: vi.fn(), retryProposal: vi.fn(), openSession: vi.fn(), resendHandoff: vi.fn() };
  return render(
    <AppearanceContext.Provider value={{ lookOf: () => ({}) } as never}>
      <DocContext.Provider value={{ state, actions }}><ProposalCard proposal={value} /></DocContext.Provider>
    </AppearanceContext.Provider>,
  );
}

afterEach(cleanup);

describe("Hangul proposal card", () => {
  it("says what the proposal removes before the person applies it, and still offers to apply", () => {
    const screen = card(proposal({ removedStructure: ["표 1→0", "그림 2→1"] }));
    expect(screen.getByText("이 수정안을 적용하면 없어집니다: 표 1→0, 그림 2→1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "적용" })).toBeTruthy();
  });

  it("says nothing when nothing is removed", () => {
    const screen = card(proposal({ removedStructure: [] }));
    expect(screen.queryByText(/없어집니다/)).toBeNull();
  });
});
