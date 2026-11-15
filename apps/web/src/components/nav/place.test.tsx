// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PLACE_KEY, STARTS_AT_NOW, followOpen, forgetPlaces, litPlace, placeStore, readPlace, useListFollows, useNavPlace } from "./place.ts";

// Where the list column is belongs to ONE window (skin 2, S2a), and it follows what is opened (D 7).

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  forgetPlaces();
});

describe("followOpen — the one rule of the list following what is opened", () => {
  const at = (patch: object) => readPlace({ rail: "projects", level: "projects", project: null, ...patch });
  it("puts the list at the opened item's project, level 2", () => {
    expect(followOpen(at({}), "P")).toEqual({ level: "project", project: "P" });
    expect(followOpen(at({ level: "project", project: "Q" }), "P")).toEqual({ level: "project", project: "P" });
  });
  it("changes nothing when it is already there, or when nothing of a project is opened", () => {
    expect(followOpen(at({ level: "project", project: "P" }), "P")).toBeNull();
    expect(followOpen(at({ level: "project", project: "P" }), null)).toBeNull();
  });
  it("on another rail place (문서, 활동, 볼트) the rail stays; only the remembered project changes", () => {
    expect(followOpen(at({ rail: "docs" }), "P")).toEqual({ project: "P" });
    expect(followOpen(at({ rail: "activity", project: "P" }), "P")).toBeNull();
    expect(followOpen(at({ rail: "vault", level: "project", project: "Q" }), "P")).toEqual({ project: "P" });
  });
});

describe("the place is per window", () => {
  it("starts from the old shared prefs once, then lives in this window's storage, never in the prefs", () => {
    const legacy = { rail: "projects", level: "project", project: "A", sortDefault: { key: "name", desc: false } };
    const { result } = renderHook(() => useNavPlace("", legacy));
    expect(result.current[0]).toMatchObject({ rail: "projects", level: "project", project: "A" });
    act(() => result.current[1]({ level: "projects" }));
    expect(JSON.parse(sessionStorage.getItem(PLACE_KEY)!)).toMatchObject({ level: "projects", project: "A" });
    // A new window (a fresh store) starts where this device was last.
    forgetPlaces();
    sessionStorage.clear();
    expect(placeStore().get(legacy).level).toBe("projects");
  });

  it("a prefs broadcast from another client does not move this window's rail, level or project", () => {
    let prefs: unknown = { rail: "projects", level: "project", project: "A" };
    const { result, rerender } = renderHook(() => useNavPlace("", prefs));
    expect(result.current[0].project).toBe("A");
    // Another window (or the phone) writes its own place into the shared prefs, which are broadcast.
    prefs = { rail: "docs", level: "project", project: "B" };
    rerender();
    expect(result.current[0]).toMatchObject({ rail: "projects", level: "project", project: "A" });
  });

  it("each gateway (a remote host) has its own place", () => {
    placeStore("").set({ rail: "vault" });
    expect(placeStore("host:h1:").get().rail).toBe("projects");
  });

  it("a broken stored value falls back to level 1", () => {
    sessionStorage.setItem(PLACE_KEY, "{not json");
    localStorage.setItem(PLACE_KEY, JSON.stringify({ rail: "elsewhere", level: "project", project: 3 }));
    expect(placeStore().get()).toEqual({ rail: "projects", level: "projects", project: null, scroll: 0 });
  });

  it("the scroll is kept without drawing anything", () => {
    const { result } = renderHook(() => useNavPlace("", undefined));
    const before = result.current[0];
    act(() => result.current[1]({ scroll: 240 }));
    expect(result.current[0]).toBe(before);
    expect(JSON.parse(localStorage.getItem(PLACE_KEY)!).scroll).toBe(240);
  });
});

describe("useListFollows — the app's one call site", () => {
  it("the restored project changes nothing; what is opened afterwards moves the list", () => {
    let workId: string | null = null;
    let ready = false;
    const { rerender } = renderHook(() => useListFollows("", workId, ready));
    workId = "A";
    rerender();
    ready = true;
    rerender();
    expect(placeStore().get().level).toBe("projects");
    workId = null; // home
    rerender();
    expect(placeStore().get().level).toBe("projects");
    workId = "B"; // opened from home, a notification, the palette…
    rerender();
    expect(placeStore().get()).toMatchObject({ level: "project", project: "B" });
  });
});

// Skin 2 fix 1, design review finding 7: after a restart the work showed 지금 while the rail lit 프로젝트
// (the column's last place). The app opens at 지금; the rail lights the place the screen shows.
describe("the rail lights the place on screen", () => {
  it("on start, with 지금 in the centre and the column open, lights 지금 (not the column's last place)", () => {
    expect(litPlace({ homeShown: true, atNow: STARTS_AT_NOW, sidebarOpen: true, rail: "projects" })).toBe("now");
    expect(litPlace({ homeShown: true, atNow: STARTS_AT_NOW, sidebarOpen: true, rail: "docs" })).toBe("now");
  });
  it("a list place chosen while 지금 is shown lights that place; anything else in the centre lights the column's place", () => {
    expect(litPlace({ homeShown: true, atNow: false, sidebarOpen: true, rail: "activity" })).toBe("activity");
    expect(litPlace({ homeShown: false, atNow: true, sidebarOpen: true, rail: "projects" })).toBe("projects");
    expect(litPlace({ homeShown: true, atNow: false, sidebarOpen: false, rail: "projects" })).toBe("now");
    expect(litPlace({ homeShown: false, atNow: false, sidebarOpen: false, rail: "projects" })).toBeNull();
  });
});

// Technical review (a mutation that survived): this window's place (sessionStorage) wins over the
// device's last place (localStorage) — two windows must not take each other's list on a reload.
it("reads this window's place before the device's last place", () => {
  localStorage.setItem(PLACE_KEY, JSON.stringify({ rail: "docs", level: "projects", project: null }));
  sessionStorage.setItem(PLACE_KEY, JSON.stringify({ rail: "projects", level: "project", project: "P" }));
  expect(placeStore().get()).toMatchObject({ rail: "projects", level: "project", project: "P" });
});
