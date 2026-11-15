import { describe, expect, it } from "vitest";
import type { Artifact, Work } from "@workbench/contracts";
import { initialState, reducer, type State } from "./state.ts";

const work = { id: "w", title: "강의", cwd: "/home/u/강의" } as Work;
const doc = (path: string) => ({ id: "d", workId: "w", name: path.split("/").at(-1), path }) as Artifact;
const state = (extra: Partial<State> = {}): State => ({ ...initialState, works: { w: work }, ...extra });

describe("the app's state as a document leaves and comes back", () => {
  it("moves it to removedArtifacts, back on restore, and away on delete for good", () => {
    const artifact = doc("/home/u/강의/강의안.md");
    const event = (body: object, seq: number) => ({ type: "event" as const, event: { seq, ...body } as never });
    let current = reducer(state({ artifacts: { d: artifact } }), event({ type: "artifact.removed", artifact: { ...artifact, removed: { at: 1, kind: "trash" } } }, 1));
    expect(current.artifacts.d).toBeUndefined();
    expect(current.removedArtifacts.d?.removed?.kind).toBe("trash");
    current = reducer(current, event({ type: "artifact.upserted", artifact }, 2));
    expect(current.artifacts.d).toBeTruthy();
    expect(current.removedArtifacts.d).toBeUndefined();
    current = reducer(current, event({ type: "artifact.removed", artifact: { ...artifact, removed: { at: 3, kind: "trash" } } }, 3));
    current = reducer(current, event({ type: "artifact.purged", artifactId: "d", workId: "w" }, 4));
    expect(current.removedArtifacts).toEqual({});
  });
});
