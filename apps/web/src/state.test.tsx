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

describe("live events of one frame (perf G1)", () => {
  const delta = (seq: number, text: string) => ({ type: "item.delta", sessionId: "s", itemId: "a", textDelta: text, seq, at: seq }) as never;
  const loaded = () => state({ transcripts: { s: { items: [{ id: "a", kind: "assistant", text: "", streaming: true } as never], seq: 0 } } });
  it("a batch gives the same state as one event at a time, in order", () => {
    const events = [delta(1, "가"), delta(2, "나"), delta(3, "다")];
    const one = events.reduce((current, event) => reducer(current, { type: "event", event }), loaded());
    const batch = reducer(loaded(), { type: "events", events });
    expect(batch).toEqual(one);
    expect((batch.transcripts.s!.items[0] as { text: string }).text).toBe("가나다");
  });
  it("marks a conversation whose items wait aside, until it is shown with them; a resync forgets it", () => {
    let current = reducer(loaded(), { type: "aside", sessionId: "s" });
    expect(current.aside).toEqual({ s: true });
    expect(reducer(current, { type: "aside", sessionId: "s" })).toBe(current);
    current = reducer(current, { type: "events", events: [delta(1, "가")], shown: "s" });
    expect(current.aside).toEqual({});
    expect((current.transcripts.s!.items[0] as { text: string }).text).toBe("가");
    current = reducer(reducer(current, { type: "aside", sessionId: "s" }), { type: "snapshot", snapshot: { hostLabel: "", hostId: "", seq: 9, folders: [], works: [], sessions: [], providers: [] } as never });
    expect(current.aside).toEqual({});
  });
});
