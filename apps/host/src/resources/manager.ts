import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ResourceSettings, ResourceState, Session } from "@workbench/contracts";
import type { EngineSource } from "../app-memory.ts";
import { writeAtomic } from "../atomic-write.ts";
import { HttpError } from "../errors.ts";
import {
  CostBook, MAX_LIMIT, PRESSURE_MARGIN, clampManual, estimate, lineOrder, lowMarkFor, nextToStart, waitingReason,
  type Engine, type MachineFacts, type Waiting,
} from "./core.ts";
import { CAP_CHOICES, capSupport, ladderAfter, leastUrgent, type CapSupport, type Ladder, type ScopeProbe } from "./ladder.ts";
import { engineScope, probeScope, raiseOomScore, reclaimEngine, sweepEngineScopes } from "./engine-scope.ts";
import { BACKGROUND_PRIORITY, NORMAL_PRIORITY, applyPriority, linuxEngineTrees, machineFacts, readingFor, type EngineTree } from "./measure.ts";

// The resource manager (0.5.3): every start of a turn asks it for a slot. A free slot → the turn starts as
// before. None → the request waits in its conversation's queue (`QueuedMessage.slot`), and starts by
// itself when its turn in the line comes. The queue stays the one truth for conversations (a request leaves
// it only when it is written into the conversation, so it is never lost and never sent twice); the editor's
// own 문서 AI, which has no queue, waits in its `turn-start` call. Running = conversations working now ∪
// slots handed out but not yet started.

export const DEFAULT_SETTINGS: ResourceSettings = { mode: "auto", manual: 4, background: true, cap: null };
const capOf = (value: unknown): number | null => (typeof value === "number" && CAP_CHOICES.includes(value) ? value : null);
const SAMPLE_MS = 5_000;
const TREE_MS = 10_000;

type Ticket = { id: string; sessionId: string; requestId: string | null; forced: boolean; at: number };
/** What a waiting 문서 AI request is, kept on disk while it waits (0.5.4: it outlives a gateway restart). */
export type DocumentRequest = { artifactId: string; turnId: string; text: string };
export type WaitingDocument = DocumentRequest & { sessionId: string; at: number };
type DocWaiter = Waiting & { kind: "document"; request: DocumentRequest | null; resolve: (ticket: Ticket) => void; reject: (error: unknown) => void };
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
  /** Whether engines can have their own scope here (default: probed once at start, in the background). */
  probe?: () => Promise<ScopeProbe | null>;
  /** Rung 4: move up to `bytes` of this engine's memory to swap; how much its memory went down (null: not possible). */
  reclaim?: (pid: number, bytes: number) => Promise<number | null>;
  /** Engine processes are taken before the gateway by the kernel's OOM killer (Linux). */
  oom?: (pids: readonly number[]) => Promise<number>;
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
  private readonly documentsFile: string | null;
  readonly costs: CostBook;
  private settingsNow: ResourceSettings;
  /** Slots handed out, until their conversation shows it works (or the start failed). */
  private readonly tickets = new Map<string, Ticket>();
  /** Conversations running now because of "지금 바로 실행". */
  private readonly forced = new Set<string>();
  /** Conversations seen working, with the engine, the peak of their turn's tree, when it was first seen and what it holds now. */
  private readonly turns = new Map<string, { engine: Engine; peak: number; since: number; bytes: number | null; root: number | null }>();
  private readonly docWaiters: DocWaiter[] = [];
  private ladder: Ladder = { stage: 0, since: 0 };
  private get pressure() { return this.ladder.stage > 0; }
  private sleepNow = 0;
  /** Rung 4: the running conversation picked to give memory back (its next request waits) and what it gave. */
  private relieved: { sessionId: string; bytes: number | null } | null = null;
  private support: CapSupport | "checking" = "checking";
  private readonly reclaim: (pid: number, bytes: number) => Promise<number | null>;
  private readonly oom: (pids: readonly number[]) => Promise<number>;
  private lastFacts: MachineFacts;
  private treeBytes = 0;
  /** The running conversations whose engine tree was found at the last measurement (the others cost the figure). */
  private measured = new Set<string>();
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
    this.documentsFile = options.dataDir ? join(options.dataDir, "resource-waiting-documents.json") : null;
    this.costs = new CostBook(options.dataDir ? join(options.dataDir, "resource-costs.json") : null);
    this.settingsNow = this.readSettings();
    this.lastFacts = this.facts();
    this.manualClock = options.manualClock === true;
    // Stand-in trees (tests) name made-up process ids: nothing is written to real processes for them.
    const real = !options.trees;
    this.reclaim = options.reclaim ?? (real && this.platform === "linux" ? reclaimEngine : async () => null);
    this.oom = options.oom ?? (real && this.platform === "linux" ? raiseOomScore : async () => 0);
    const probe = options.probe ?? (() => probeScope(this.platform));
    // Known without asking (Windows, macOS, test gateways): said from the start, so the answer changes nothing.
    if (!options.probe && (this.platform !== "linux" || process.env.WORKBENCH_ENGINE_SCOPE === "off")) this.support = capSupport(this.platform, null);
    void probe().catch(() => null).then(async (found) => {
      const before = this.support;
      this.support = capSupport(this.platform, found);
      // Engines get their own scope wherever the probe could make one (also with the cap off: OOM isolation).
      if (!options.probe && found?.cgroup2 && found.memory && found.systemdRun) {
        // What a previous run of this same unit left (a service restart does not stop scopes) ends first.
        await sweepEngineScopes().catch(() => 0);
        engineScope.onDisable = () => {
          // The fail-safe turned wrapping off: no cap can be enforced for the rest of this run, and it says so.
          if (this.support === "enforced") this.support = "unavailable";
          this.applyCap();
          this.publish(true);
        };
        engineScope.enabled = true;
      }
      this.applyCap();
      // Pushed only when the answer changed what the window was told (never on a mere read).
      if (this.support !== before) this.publish(true);
    });
  }

  /** The cap reaches engines started from now on (an engine already running keeps the scope it started with). */
  private applyCap() {
    engineScope.capBytes = this.support === "enforced" ? this.settingsNow.cap : null;
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
        cap: capOf(raw.cap),
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
      cap: patch.cap === undefined ? this.settingsNow.cap : capOf(patch.cap),
    };
    if (patch.mode !== undefined && patch.mode !== "auto" && patch.mode !== "manual") throw new HttpError(400, "resource_settings", "자동 또는 직접만 고를 수 있습니다.");
    if (patch.cap !== undefined && patch.cap !== null && capOf(patch.cap) === null) throw new HttpError(400, "resource_settings", "대화당 메모리 상한은 목록에 있는 값만 고를 수 있습니다.");
    this.settingsNow = next;
    this.applyCap();
    if (this.settingsFile) {
      mkdirSync(dirname(this.settingsFile), { recursive: true });
      writeAtomic(this.settingsFile, JSON.stringify(next));
    }
    void this.prioritize();
    this.pumpSoon();
    return this.publish(true);
  }

  // What runs and what waits

  private running(): { sessionId: string; forced: boolean; kind: "conversation" | "document"; since: number | null; bytes: number | null }[] {
    const seen = new Map<string, { sessionId: string; forced: boolean; kind: "conversation" | "document"; since: number | null; bytes: number | null }>();
    for (const session of this.hooks.sessions()) {
      if (!busy(session)) continue;
      const turn = this.turns.get(session.id);
      seen.set(session.id, { sessionId: session.id, forced: this.forced.has(session.id), kind: session.documentAgent ? "document" : "conversation", since: turn?.since ?? null, bytes: turn?.bytes ?? null });
    }
    for (const ticket of this.tickets.values()) if (!seen.has(ticket.sessionId)) seen.set(ticket.sessionId, { sessionId: ticket.sessionId, forced: ticket.forced, kind: "conversation", since: null, bytes: null });
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

  /**
   * The memory the running turns hold is given back to the budget (the memory available now already lacks
   * it). A turn whose engine tree is not known — not measured yet, not found, or a system where trees are
   * not read (macOS, Windows) — holds the cost figure (the default until this computer has learned its
   * own), never nothing: with nothing, every running turn would be counted twice and "약 N개" would shrink
   * as turns start (0.5.4).
   */
  private limitNow() {
    const cost = this.costs.cost().bytes;
    let unknown = 0;
    for (const id of this.turns.keys()) if (!this.measured.has(id)) unknown++;
    return estimate(this.lastFacts, { runningTreeBytes: this.treeBytes + unknown * cost, costBytes: cost }, this.settingsNow);
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
  waitDocument(sessionId: string, signal?: AbortSignal, request?: DocumentRequest): (() => void) | Promise<() => void> {
    this.sample();
    const order = this.line();
    const self: Waiting = { sessionId, requestId: `document:${randomUUID()}`, at: this.now(), shown: this.hooks.shown().has(sessionId) };
    const head = nextToStart({ limit: this.limitNow().limit, pressure: this.pressure, running: this.running(), line: lineOrder([...order, { ...self, kind: "document" as const, phone: false }], this.now()) }, this.now());
    const releaseOf = (ticket: Ticket) => () => { this.tickets.delete(ticket.id); this.pumpSoon(); this.publish(); };
    // A free slot: given at once (synchronously — the caller takes its conversation's lock in the same tick, as before).
    if (head?.requestId === self.requestId) return releaseOf(this.take(sessionId, self.requestId, false));
    return new Promise<Ticket>((resolve, reject) => {
        const waiter: DocWaiter = { ...self, kind: "document", request: request ?? null, resolve, reject };
        this.docWaiters.push(waiter);
        this.saveDocuments();
        const abort = () => {
          const index = this.docWaiters.indexOf(waiter);
          // The editor went away. While the app stops, its connection closes too: the request stays on disk
          // for the restart (recoverDocuments); otherwise the person cancelled it (closed its editor).
          if (index >= 0 && !this.suspended && !this.closed) { this.docWaiters.splice(index, 1); this.saveDocuments(); this.publish(); }
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
        this.saveDocuments();
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
      if (!this.turns.has(session.id)) this.turns.set(session.id, { engine: session.provider === "codex" ? "codex" : "claude", peak: 0, since: this.now(), bytes: null, root: null });
      this.ensureSampling();
    } else {
      // Its turn ended (it was seen working): the "지금 바로 실행" mark ends with it. An idle save before the
      // turn starts (the request leaving its queue) keeps the mark.
      const turn = this.turns.get(session.id);
      if (turn) {
        this.forced.delete(session.id);
        this.turns.delete(session.id);
        if (this.relieved?.sessionId === session.id) this.relieved = null;
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
      if (!this.running().length && !this.line().length) {
        clearInterval(this.sampler!); this.sampler = null; this.treeBytes = 0; this.measured = new Set();
        // Nothing runs or waits: no rung is held (the next start reads the memory afresh).
        if (this.ladder.stage) { this.ladder = { stage: 0, since: this.now() }; this.relieved = null; }
        this.publish(); return;
      }
      this.sample();
      if (this.now() - this.lastTreeAt >= TREE_MS) void this.measureTrees();
      this.pumpSoon();
    }, SAMPLE_MS);
    this.sampler.unref();
  }

  /**
   * Reads the memory available now and moves on the pressure ladder (ladder.ts): each rung's action happens
   * once, when it is reached — 2 idle engines close, 3 the window sleeps its off-screen tabs, 4 the least
   * urgent running turn gives memory back. Back to calm: the line goes on by itself.
   */
  sample() {
    this.lastFacts = this.facts();
    const before = this.ladder.stage;
    this.ladder = ladderAfter(this.ladder, this.lastFacts, this.now());
    const stage = this.ladder.stage;
    if (stage >= 2 && before < 2) { try { this.hooks.closeIdle(); } catch { /* the closer reports on its own */ } }
    if (stage >= 3 && before < 3) this.sleepNow++;
    if (stage >= 4 && before < 4) void this.relieve();
    if (before && !stage) { this.relieved = null; this.pumpSoon(); }
  }

  /** Rung 4: the least urgent running turn's engine gives back what memory is short (Linux, in its own scope). */
  async relieve() {
    const shown = this.hooks.shown();
    const pick = leastUrgent(this.running().map((turn) => ({ sessionId: turn.sessionId, shown: shown.has(turn.sessionId), forced: turn.forced, since: turn.since ?? 0, bytes: turn.bytes })));
    if (!pick) return;
    // Marked at once (its next request waits, as every next one does from rung 1); what it gave back follows.
    const relieved: { sessionId: string; bytes: number | null } = { sessionId: pick.sessionId, bytes: null };
    this.relieved = relieved;
    this.publish();
    const root = this.turns.get(pick.sessionId)?.root ?? null;
    const short = Math.max(PRESSURE_MARGIN, lowMarkFor(this.lastFacts.totalBytes) + PRESSURE_MARGIN - this.lastFacts.availableBytes);
    relieved.bytes = root === null ? null : await this.reclaim(root, short).catch(() => null);
    this.publish();
  }

  /** The engines' trees now: the running turns' share of memory and each turn's peak. */
  async measureTrees() {
    this.lastTreeAt = this.now();
    const engines = this.hooks.engines();
    const trees = await this.trees(engines).catch(() => [] as EngineTree[]);
    const runningIds = new Set(this.running().map((turn) => turn.sessionId));
    let total = 0;
    const measured = new Set<string>();
    for (const tree of trees) {
      const mine = tree.source.sessions.filter((session) => runningIds.has(session.id));
      if (!mine.length) continue;
      total += tree.bytes;
      for (const session of mine) measured.add(session.id);
      // A shared engine (Codex's app-server): each running turn's share.
      const share = tree.bytes / mine.length;
      for (const session of mine) {
        const turn = this.turns.get(session.id);
        if (turn) { turn.peak = Math.max(turn.peak, share); turn.bytes = Math.round(share); turn.root = mine.length === 1 ? tree.pid : null; }
      }
    }
    this.treeBytes = total;
    this.measured = measured;
    // Every engine process (and what it started) is taken before the gateway when the kernel must kill.
    await this.oom(trees.flatMap((tree) => tree.pids)).catch(() => 0);
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
    const running = this.running().map((turn) => ({ ...turn, title: title(turn.sessionId), ...(this.relieved?.sessionId === turn.sessionId ? { relieved: true } : {}) }));
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
      stage: this.ladder.stage,
      capSupport: this.support,
      capChoices: [...CAP_CHOICES],
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

  /** The waiting 문서 AI requests on disk, as they are now (one small file; empty when none waits). */
  private saveDocuments() {
    if (!this.documentsFile) return;
    const list: WaitingDocument[] = this.docWaiters.flatMap((waiter) => (waiter.request ? [{ ...waiter.request, sessionId: waiter.sessionId, at: waiter.at }] : []));
    try {
      mkdirSync(dirname(this.documentsFile), { recursive: true });
      writeAtomic(this.documentsFile, JSON.stringify(list));
    } catch { /* kept in memory; written with the next change */ }
  }

  /**
   * After a restart: the 문서 AI requests that were waiting when the gateway stopped (the editor that asked is gone
   * with the old gateway: it ran those turns itself). Read once and emptied; the SessionManager keeps each in its
   * conversation's list of waiting requests.
   */
  takeWaitingDocuments(): WaitingDocument[] {
    if (!this.documentsFile) return [];
    let list: WaitingDocument[] = [];
    try {
      const raw = JSON.parse(readFileSync(this.documentsFile, "utf8")) as unknown;
      if (Array.isArray(raw)) list = raw.filter((entry): entry is WaitingDocument => !!entry && typeof entry === "object"
        && ["sessionId", "artifactId", "turnId", "text"].every((key) => typeof (entry as Record<string, unknown>)[key] === "string") && typeof (entry as Record<string, unknown>).at === "number");
    } catch { return []; }
    try { writeAtomic(this.documentsFile, "[]"); } catch { /* read again next time: each is kept once per turn id */ }
    return list;
  }

  /** The app is stopping all work: nothing is admitted or started any more (what waits keeps its place for the restart). */
  suspend() { this.suspended = true; }
  private suspended = false;

  close() {
    this.closed = true;
    if (this.sampler) clearInterval(this.sampler);
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    // Their editors get "closing"; the requests stay on disk for the restart.
    for (const waiter of this.docWaiters.splice(0)) waiter.reject(new HttpError(503, "office_closed", "앱을 종료하고 있습니다."));
  }
}
