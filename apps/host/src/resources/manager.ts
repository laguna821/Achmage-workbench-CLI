import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ResourceSettings, ResourceState, Session } from "@workbench/contracts";
import type { EngineSource } from "../app-memory.ts";
import { writeAtomic } from "../atomic-write.ts";
import { HttpError } from "../errors.ts";
import {
  CostBook, MAX_LIMIT, clampManual, estimate, lineOrder, nextToStart, pressureAfter, waitingReason,
  type Engine, type MachineFacts, type Waiting,
} from "./core.ts";
import { BACKGROUND_PRIORITY, NORMAL_PRIORITY, applyPriority, linuxEngineTrees, machineFacts, readingFor, type EngineTree } from "./measure.ts";

// The resource manager (0.5.3): every start of a turn asks it for a slot. A free slot → the turn starts as
// before. None → the request waits in its conversation's queue (`QueuedMessage.slot`), and starts by
// itself when its turn in the line comes. The queue stays the one truth for conversations (a request leaves
// it only when it is written into the conversation, so it is never lost and never sent twice); the editor's
// own 문서 AI, which has no queue, waits in its `turn-start` call. Running = conversations working now ∪
// slots handed out but not yet started.

export const DEFAULT_SETTINGS: ResourceSettings = { mode: "auto", manual: 4, background: true };
const SAMPLE_MS = 5_000;
const TREE_MS = 10_000;

type Ticket = { id: string; sessionId: string; requestId: string | null; forced: boolean; at: number };
type DocWaiter = Waiting & { kind: "document"; resolve: (ticket: Ticket) => void; reject: (error: unknown) => void };
type LineEntry = Waiting & { kind: "conversation" | "document"; phone: boolean; waiter?: DocWaiter };

export type ResourceHooks = {
  sessions(): Iterable<Session>;
  shown(): ReadonlySet<string>;
  /** Its engine is there to start it (after a restart the adapters register a moment later). */
  ready(session: Session): boolean;
  /** Start a waiting request of a conversation now (it has its slot): the SessionManager's own sendWaiting. */
  start(sessionId: string, requestId: string): Promise<unknown>;
  engines(): EngineSource[];
  closeIdle(): number;
  publish(state: ResourceState): void;
  /** Said once in a conversation (a request could not start from the line). */
  failed(sessionId: string, requestId: string, error: unknown): void;
};

export type ResourceOptions = {
  dataDir: string | null;
  platform?: string;
  facts?: () => MachineFacts;
  trees?: (engines: EngineSource[]) => Promise<EngineTree[]>;
  priority?: (pids: readonly number[], priority: number) => Promise<{ set: number; refused: number }>;
  now?: () => number;
  /** Tests: no timers (sample() is called by hand). */
  manualClock?: boolean;
};

const busy = (session: Session) => session.status !== "idle" && session.status !== "error";

export class ResourceManager {
  private readonly hooks: ResourceHooks;
  private readonly platform: string;
  private readonly facts: () => MachineFacts;
  private readonly trees: (engines: EngineSource[]) => Promise<EngineTree[]>;
  private readonly priority: (pids: readonly number[], priority: number) => Promise<{ set: number; refused: number }>;
  private readonly now: () => number;
  private readonly settingsFile: string | null;
  readonly costs: CostBook;
  private settingsNow: ResourceSettings;
  /** Slots handed out, until their conversation shows it works (or the start failed). */
  private readonly tickets = new Map<string, Ticket>();
  /** Conversations running now because of "지금 바로 실행". */
  private readonly forced = new Set<string>();
  /** Conversations seen working, with the engine and the peak of their turn's tree. */
  private readonly turns = new Map<string, { engine: Engine; peak: number }>();
  private readonly docWaiters: DocWaiter[] = [];
  private pressure = false;
  private sleepNow = 0;
  private lastFacts: MachineFacts;
  private treeBytes = 0;
  private lastTreeAt = 0;
  private sampler: NodeJS.Timeout | null = null;
  private pumpTimer: NodeJS.Timeout | null = null;
  private lastPublished = "";
  private readonly applied = new Map<number, number>();
  /** Tests and the report: raising a priority back was refused this many times. */
  priorityRefused = 0;
  private closed = false;

  constructor(hooks: ResourceHooks, options: ResourceOptions) {
    this.hooks = hooks;
    this.platform = options.platform ?? process.platform;
    this.facts = options.facts ?? machineFacts;
    this.now = options.now ?? Date.now;
    const gatewayPid = process.pid;
    this.trees = options.trees ?? ((engines) => (this.platform === "linux" ? linuxEngineTrees(gatewayPid, engines) : Promise.resolve([])));
    this.priority = options.priority ?? ((pids, priority) => applyPriority(this.platform, pids, priority));
    this.settingsFile = options.dataDir ? join(options.dataDir, "resource-settings.json") : null;
    this.costs = new CostBook(options.dataDir ? join(options.dataDir, "resource-costs.json") : null);
    this.settingsNow = this.readSettings();
    this.lastFacts = this.facts();
    this.manualClock = options.manualClock === true;
  }
  private readonly manualClock: boolean;

  private readSettings(): ResourceSettings {
    if (!this.settingsFile) return { ...DEFAULT_SETTINGS };
    try {
      const raw = JSON.parse(readFileSync(this.settingsFile, "utf8")) as Partial<ResourceSettings>;
      return {
        mode: raw.mode === "manual" ? "manual" : "auto",
        manual: clampManual(typeof raw.manual === "number" ? raw.manual : DEFAULT_SETTINGS.manual),
        background: raw.background !== false,
      };
    } catch { return { ...DEFAULT_SETTINGS }; }
  }

  settings() { return { ...this.settingsNow }; }

  /** Only the settings change the limit (PUT /api/resources/settings from the window). */
  updateSettings(patch: Partial<ResourceSettings>): ResourceState {
    const next: ResourceSettings = {
      mode: patch.mode === undefined ? this.settingsNow.mode : patch.mode === "manual" ? "manual" : "auto",
      manual: patch.manual === undefined ? this.settingsNow.manual : clampManual(patch.manual),
      background: patch.background === undefined ? this.settingsNow.background : patch.background !== false,
    };
    if (patch.mode !== undefined && patch.mode !== "auto" && patch.mode !== "manual") throw new HttpError(400, "resource_settings", "자동 또는 직접만 고를 수 있습니다.");
    this.settingsNow = next;
    if (this.settingsFile) {
      mkdirSync(dirname(this.settingsFile), { recursive: true });
      writeAtomic(this.settingsFile, JSON.stringify(next));
    }
    void this.prioritize();
    this.pumpSoon();
    return this.publish(true);
  }

  // What runs and what waits

  private running(): { sessionId: string; forced: boolean; kind: "conversation" | "document" }[] {
    const seen = new Map<string, { sessionId: string; forced: boolean; kind: "conversation" | "document" }>();
    for (const session of this.hooks.sessions()) {
      if (!busy(session)) continue;
      seen.set(session.id, { sessionId: session.id, forced: this.forced.has(session.id), kind: session.documentAgent ? "document" : "conversation" });
    }
    for (const ticket of this.tickets.values()) if (!seen.has(ticket.sessionId)) seen.set(ticket.sessionId, { sessionId: ticket.sessionId, forced: ticket.forced, kind: "conversation" });
    return [...seen.values()];
  }

  private line(): LineEntry[] {
    const shown = this.hooks.shown();
    const taken = new Set([...this.tickets.values()].map((ticket) => ticket.sessionId));
    const entries: LineEntry[] = [];
    for (const session of this.hooks.sessions()) {
      if (busy(session) || session.archivedAt || taken.has(session.id) || !this.hooks.ready(session)) continue;
      for (const entry of session.queued) {
        if (!entry.slot || entry.held) continue;
        entries.push({ sessionId: session.id, requestId: entry.id, at: entry.at, shown: shown.has(session.id), kind: "conversation", phone: Boolean(entry.origin) });
      }
    }
    for (const waiter of this.docWaiters) entries.push({ ...waiter, shown: shown.has(waiter.sessionId), phone: false, waiter });
    return lineOrder(entries, this.now());
  }

  private limitNow() {
    return estimate(this.lastFacts, { runningTreeBytes: this.treeBytes, costBytes: this.costs.cost().bytes }, this.settingsNow);
  }

  /**
   * A request asks to start a new turn in an idle conversation. True: it has its slot (`forced`: the person's
   * own "지금 바로 실행"). A request the line handed its slot to (`pump`) passes with that slot.
   * False: it must wait (the caller puts it into the queue with `slot: true`).
   */
  admit(sessionId: string, requestId: string, options: { forced?: boolean; at?: number } = {}): boolean {
    if (this.suspended) return false;
    const own = [...this.tickets.values()].find((ticket) => ticket.sessionId === sessionId && ticket.requestId === requestId);
    if (own) return true;
    if (options.forced) { this.take(sessionId, requestId, true); return true; }
    this.sample();
    const line = this.line().filter((entry) => !(entry.sessionId === sessionId && entry.requestId === requestId));
    const self: LineEntry = { sessionId, requestId, at: options.at ?? this.now(), shown: this.hooks.shown().has(sessionId), kind: "conversation", phone: false };
    // Its conversation's older waiting requests stay ahead of it (lineOrder keeps one per conversation, the oldest).
    const order = lineOrder([...line, self], this.now());
    const next = nextToStart({ limit: this.limitNow().limit, pressure: this.pressure, running: this.running(), line: order }, this.now());
    if (next === self) { this.take(sessionId, requestId, false); return true; }
    this.ensureSampling();
    this.publish();
    return false;
  }

  /** The slot of a request that did not start after all (refused, failed before the engine was called). */
  giveBack(sessionId: string, requestId: string) {
    for (const [id, ticket] of this.tickets) if (ticket.sessionId === sessionId && ticket.requestId === requestId) { this.tickets.delete(id); if (ticket.forced) this.forced.delete(sessionId); }
    this.pumpSoon();
    this.publish();
  }

  private take(sessionId: string, requestId: string | null, forced: boolean): Ticket {
    const ticket: Ticket = { id: randomUUID(), sessionId, requestId, forced, at: this.now() };
    this.tickets.set(ticket.id, ticket);
    if (forced) this.forced.add(sessionId);
    this.ensureSampling();
    return ticket;
  }

  /**
   * The editor's own 문서 AI asks for a slot. Resolves with a release function once it has one (at once
   * when free); the caller calls it when its turn has started or failed. Rejects when `signal` aborts
   * (the editor went away) or the gateway closes.
   */
  waitDocument(sessionId: string, signal?: AbortSignal): (() => void) | Promise<() => void> {
    this.sample();
    const order = this.line();
    const self: Waiting = { sessionId, requestId: `document:${randomUUID()}`, at: this.now(), shown: this.hooks.shown().has(sessionId) };
    const head = nextToStart({ limit: this.limitNow().limit, pressure: this.pressure, running: this.running(), line: lineOrder([...order, { ...self, kind: "document" as const, phone: false }], this.now()) }, this.now());
    const releaseOf = (ticket: Ticket) => () => { this.tickets.delete(ticket.id); this.pumpSoon(); this.publish(); };
    // A free slot: given at once (synchronously — the caller takes its conversation's lock in the same tick, as before).
    if (head?.requestId === self.requestId) return releaseOf(this.take(sessionId, self.requestId, false));
    return new Promise<Ticket>((resolve, reject) => {
        const waiter: DocWaiter = { ...self, kind: "document", resolve, reject };
        this.docWaiters.push(waiter);
        const abort = () => {
          const index = this.docWaiters.indexOf(waiter);
          if (index >= 0) { this.docWaiters.splice(index, 1); this.publish(); }
          reject(new HttpError(409, "office_turn_cancelled", "기다리던 문서 AI 요청을 취소했습니다."));
        };
        if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
        this.ensureSampling();
        this.publish();
      }).then(releaseOf);
  }

  /** A slot may have freed (a turn ended, a setting changed, memory came back): the next starts by itself. */
  pumpSoon() {
    if (this.closed || this.suspended || this.pumpTimer) return;
    this.pumpTimer = setTimeout(() => { this.pumpTimer = null; this.pump(); }, 0);
  }

  private pump() {
    for (let guard = 0; guard < MAX_LIMIT * 2; guard++) {
      const line = this.line();
      const next = nextToStart({ limit: this.limitNow().limit, pressure: this.pressure, running: this.running(), line }, this.now());
      if (!next) break;
      const ticket = this.take(next.sessionId, next.requestId, false);
      if (next.waiter) {
        const index = this.docWaiters.indexOf(next.waiter);
        if (index >= 0) this.docWaiters.splice(index, 1);
        next.waiter.resolve(ticket);
        continue;
      }
      void this.hooks.start(next.sessionId, next.requestId).catch((error: unknown) => {
        // Still waiting as it was (it never reached the conversation): it is held and said once, as a
        // failed "끝나면 보내기" is today. Deleted or edited meanwhile: nothing to say.
        if (!(error instanceof HttpError && (error.code === "queued_changed" || error.code === "queued_not_found"))) this.hooks.failed(next.sessionId, next.requestId, error);
      }).finally(() => {
        // Started: the conversation's status counts it from now on. Not started: the slot goes back.
        this.tickets.delete(ticket.id);
        this.pumpSoon();
        this.publish();
      });
    }
    this.publish();
  }

  /** A conversation changed (status, queue): forced marks end with the turn, the learned cost takes the peak. */
  sessionChanged(session: Session) {
    if (busy(session)) {
      for (const [id, ticket] of this.tickets) if (ticket.sessionId === session.id && !ticket.requestId?.startsWith("document:")) this.tickets.delete(id);
      if (!this.turns.has(session.id)) this.turns.set(session.id, { engine: session.provider === "codex" ? "codex" : "claude", peak: 0 });
      this.ensureSampling();
    } else {
      // Its turn ended (it was seen working): the "지금 바로 실행" mark ends with it. An idle save before the
      // turn starts (the request leaving its queue) keeps the mark.
      const turn = this.turns.get(session.id);
      if (turn) {
        this.forced.delete(session.id);
        this.turns.delete(session.id);
        if (turn.peak > 0) this.costs.record(turn.engine, turn.peak);
        this.pumpSoon();
      }
    }
    this.publish();
  }

  /** The window's view changed: on-screen conversations go first in the line and get their engines' normal priority back. */
  shownChanged() {
    void this.prioritize();
    this.pumpSoon();
    this.publish();
  }

  // Sampling (only while something runs or waits)

  private ensureSampling() {
    if (this.manualClock || this.sampler || this.closed) return;
    this.sampler = setInterval(() => {
      if (!this.running().length && !this.line().length) { clearInterval(this.sampler!); this.sampler = null; this.treeBytes = 0; this.publish(); return; }
      this.sample();
      if (this.now() - this.lastTreeAt >= TREE_MS) void this.measureTrees();
      this.pumpSoon();
    }, SAMPLE_MS);
    this.sampler.unref();
  }

  /** Reads the memory available now and updates the pressure state. */
  sample() {
    this.lastFacts = this.facts();
    const before = this.pressure;
    this.pressure = pressureAfter(before, this.lastFacts);
    if (this.pressure && !before) {
      // Pressure: idle engines close, the window sleeps its off-screen tabs now.
      this.sleepNow++;
      try { this.hooks.closeIdle(); } catch { /* the closer reports on its own */ }
    }
    if (before && !this.pressure) this.pumpSoon();
  }

  /** The engines' trees now: the running turns' share of memory and each turn's peak. */
  async measureTrees() {
    this.lastTreeAt = this.now();
    const engines = this.hooks.engines();
    const trees = await this.trees(engines).catch(() => [] as EngineTree[]);
    const runningIds = new Set(this.running().map((turn) => turn.sessionId));
    let total = 0;
    for (const tree of trees) {
      const mine = tree.source.sessions.filter((session) => runningIds.has(session.id));
      if (!mine.length) continue;
      total += tree.bytes;
      // A shared engine (Codex's app-server): each running turn's share.
      const share = tree.bytes / mine.length;
      for (const session of mine) {
        const turn = this.turns.get(session.id);
        if (turn) turn.peak = Math.max(turn.peak, share);
      }
    }
    this.treeBytes = total;
    await this.prioritize(trees);
    this.publish();
  }

  /** "뒤에서 도는 작업은 천천히": engines whose conversations are all off screen run below normal. */
  private async prioritize(known?: EngineTree[]) {
    const shown = this.hooks.shown();
    const trees = known ?? (await this.trees(this.hooks.engines()).catch(() => [] as EngineTree[]));
    const targets = trees.length ? trees.map((tree) => ({ pids: tree.pids, source: tree.source }))
      // Not Linux: the processes the adapters name by pid (Codex's app-server); Claude's cannot be told apart.
      : this.hooks.engines().filter((engine) => engine.pid !== null).map((engine) => ({ pids: [engine.pid!], source: engine }));
    for (const target of targets) {
      const low = this.settingsNow.background && !target.source.sessions.some((session) => shown.has(session.id));
      const wanted = low ? BACKGROUND_PRIORITY : NORMAL_PRIORITY;
      const root = target.pids[0]!;
      if ((this.applied.get(root) ?? NORMAL_PRIORITY) === wanted && !low) continue;
      const result = await this.priority(target.pids, wanted).catch(() => ({ set: 0, refused: 1 }));
      this.priorityRefused += result.refused;
      if (!result.refused) this.applied.set(root, wanted);
    }
  }

  // What the window and the phone see

  state(): ResourceState {
    const limit = this.limitNow();
    const sessions = new Map([...this.hooks.sessions()].map((session) => [session.id, session]));
    const title = (id: string) => sessions.get(id)?.purpose || "대화";
    const running = this.running().map((turn) => ({ ...turn, title: title(turn.sessionId) }));
    const line = this.line();
    const cost = this.costs.cost();
    return {
      settings: this.settings(),
      maxLimit: MAX_LIMIT,
      limit: limit.limit,
      running,
      waiting: line.map((entry, index) => ({
        sessionId: entry.sessionId, requestId: entry.waiter ? null : entry.requestId, title: title(entry.sessionId), position: index + 1, at: entry.at, kind: entry.kind, phone: entry.phone,
      })),
      reason: line.length ? waitingReason({ pressure: this.pressure, limit: limit.limit }) : this.pressure ? waitingReason({ pressure: true, limit: limit.limit }) : null,
      pressure: this.pressure,
      sleepNow: this.sleepNow,
      estimate: { comfortable: Math.min(limit.comfortable, limit.ceiling), totalBytes: limit.totalBytes, otherBytes: limit.otherBytes, costBytes: limit.costBytes, learned: cost.learned, reading: readingFor(this.platform) },
    };
  }

  /** The place of a waiting request in the line (1-based), or null. */
  positionOf(sessionId: string, requestId: string): number | null {
    const index = this.line().findIndex((entry) => entry.sessionId === sessionId && entry.requestId === requestId);
    return index < 0 ? null : index + 1;
  }

  reasonNow() { return waitingReason({ pressure: this.pressure, limit: this.limitNow().limit }); }

  private publish(force = false): ResourceState {
    const state = this.state();
    const key = JSON.stringify({ ...state, estimate: { ...state.estimate, totalBytes: 0, otherBytes: Math.round(state.estimate.otherBytes / (64 * 1024 * 1024)) } });
    if (force || key !== this.lastPublished) { this.lastPublished = key; this.hooks.publish(state); }
    return state;
  }

  /** The app is stopping all work: nothing is admitted or started any more (what waits keeps its place for the restart). */
  suspend() { this.suspended = true; }
  private suspended = false;

  close() {
    this.closed = true;
    if (this.sampler) clearInterval(this.sampler);
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    for (const waiter of this.docWaiters.splice(0)) waiter.reject(new HttpError(503, "office_closed", "앱을 종료하고 있습니다."));
  }
}
