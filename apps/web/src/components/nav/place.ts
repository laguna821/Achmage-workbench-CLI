import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { RAIL_DESTS, type RailDest } from "./model.ts";

// Where the list column is (skin 2, S2a): the rail's destination, the level, the project inside,
// and level 1's scroll. This is PER WINDOW: kept in sessionStorage (each window its own), copied
// to localStorage as "the last place on this device" so a new window or a restart starts there.
// It is never written to the gateway prefs: those are broadcast to every client, and two windows
// or the phone would flip each other's list. The old `navigator.rail/level/project` in the prefs
// is read once as the first place and otherwise ignored (never written, never removed).

export type NavPlace = {
  rail: RailDest;
  level: "projects" | "project";
  project: string | null;
  /** Level 1's scroll, so 프로젝트 목록 comes back where it was. */
  scroll: number;
};

export const PLACE_KEY = "workbench.navPlace.v1";

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** A stored or legacy value as a place (tolerating anything). */
export function readPlace(value: unknown): NavPlace {
  const raw = record(value);
  const project = typeof raw.project === "string" && raw.project ? raw.project : null;
  return {
    rail: RAIL_DESTS.includes(raw.rail as RailDest) ? (raw.rail as RailDest) : "projects",
    level: raw.level === "project" && project ? "project" : "projects",
    project,
    scroll: typeof raw.scroll === "number" && Number.isFinite(raw.scroll) && raw.scroll > 0 ? raw.scroll : 0,
  };
}

/**
 * THE rule of "the list follows" (code contrast D 7): an item of project `workId` was opened from
 * anywhere (a row, a tab, a notification, the palette, a deep link, home, 문서 or 활동). The list
 * goes to that project's level 2 — unless the person is on another rail place on purpose (문서,
 * 활동, 볼트): then the rail stays and only the remembered project changes. Null: nothing changes.
 */
export function followOpen(place: NavPlace, workId: string | null): Partial<NavPlace> | null {
  if (!workId) return null;
  if (place.rail !== "projects") return place.project === workId ? null : { project: workId };
  if (place.level === "project" && place.project === workId) return null;
  return { level: "project", project: workId };
}

function load(storage: Storage | undefined, key: string): unknown {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function save(storage: Storage | undefined, key: string, value: NavPlace) {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    /* A full or refused storage only loses the memory of the place. */
  }
}

const safe = (pick: () => Storage) => {
  try {
    return pick();
  } catch {
    return undefined;
  }
};

export class PlaceStore {
  private place: NavPlace | null = null;
  private listeners = new Set<() => void>();
  private readonly key: string;
  constructor(key: string) {
    this.key = key;
  }

  /** The place: this window's, else this device's last, else the old shared prefs, else level 1. */
  get(legacy?: unknown): NavPlace {
    if (!this.place) {
      const own = load(safe(() => sessionStorage), this.key) ?? load(safe(() => localStorage), this.key);
      this.place = readPlace(own ?? { ...record(legacy), scroll: 0 });
    }
    return this.place;
  }

  set(patch: Partial<NavPlace>, legacy?: unknown) {
    const current = this.get(legacy);
    const next = readPlace({ ...current, ...patch });
    const moved = next.rail !== current.rail || next.level !== current.level || next.project !== current.project;
    if (!moved && next.scroll === current.scroll) return;
    // The scroll alone draws nothing (it is read when level 1 comes back): same object, no render.
    if (moved) this.place = next;
    else current.scroll = next.scroll;
    save(safe(() => sessionStorage), this.key, this.place!);
    save(safe(() => localStorage), this.key, this.place!);
    if (moved) for (const listener of this.listeners) listener();
  }

  /** The list follows what was opened (see `followOpen`). */
  follow(workId: string | null, legacy?: unknown) {
    const patch = followOpen(this.get(legacy), workId);
    if (patch) this.set(patch, legacy);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
}

const stores = new Map<string, PlaceStore>();

/** The place store of this window for a gateway (`prefix` is the app's per-host storage prefix). */
export function placeStore(prefix = ""): PlaceStore {
  const key = prefix + PLACE_KEY;
  let store = stores.get(key);
  if (!store) stores.set(key, (store = new PlaceStore(key)));
  return store;
}

/** Tests: forget every store (storage is cleared by the test). */
export function forgetPlaces() {
  stores.clear();
}

/** The app's per-host storage prefix (App.tsx `storagePrefix`). */
export const placePrefix = (remoteHostId: unknown) => (typeof remoteHostId === "string" && remoteHostId ? `host:${remoteHostId}:` : "");

export function useNavPlace(prefix: string, legacy: unknown): [NavPlace, (patch: Partial<NavPlace>) => void] {
  const store = placeStore(prefix);
  const place = useSyncExternalStore(store.subscribe, () => store.get(legacy));
  const set = useCallback((patch: Partial<NavPlace>) => store.set(patch, legacy), [store, legacy]);
  return [place, set];
}

/**
 * The app's one call site of the follow rule: whenever the project of what is on screen changes
 * (any way of opening: rows, tabs, notifications, the palette, deep links, home, 문서, 활동), the
 * list follows (`followOpen`). The first project seen once the app is ready (the restored layout)
 * is where the app starts, not something opened: it changes nothing.
 */
export function useListFollows(prefix: string, workId: string | null, ready: boolean, legacy?: unknown) {
  const seen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!ready) { seen.current = undefined; return; }
    if (seen.current === undefined) { seen.current = workId; return; }
    if (seen.current === workId) return;
    seen.current = workId;
    placeStore(prefix).follow(workId, legacy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefix, workId, ready]);
}

/**
 * Which rail place is lit (skin 2: "the rail lights the place of what's on screen"). 지금 is a place of
 * its own (home "지금" in the centre); the four list places are where the column is. `atNow`: the
 * person went to 지금 (or the app opened there) and has not chosen another list place since.
 */
export function litPlace({ homeShown, atNow, sidebarOpen, rail }: { homeShown: boolean; atNow: boolean; sidebarOpen: boolean; rail: RailDest }): RailDest | "now" | null {
  return homeShown && (atNow || !sidebarOpen) ? "now" : sidebarOpen ? rail : homeShown ? "now" : null;
}

/** On start the app opens at 지금 ("앱을 열면 지금"), so the rail starts there too. */
export const STARTS_AT_NOW = true;
