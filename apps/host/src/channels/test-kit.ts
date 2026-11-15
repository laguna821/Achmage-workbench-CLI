import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccessMode, ApprovalDecision, Provider, ProviderStatus, SearchPage, Session, TranscriptItem, TurnCause, Work } from "@workbench/contracts";
import { EventBus } from "../bus.ts";
import { Pkm } from "../pkm.ts";
import { Projects } from "../project.ts";
import { SessionManager } from "../sessions.ts";
import { Store } from "../store.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "../providers/types.ts";
import { ChannelCore } from "./core.ts";
import { FakeAdapter } from "./fake-adapter.ts";
import { ChannelLog } from "./log.ts";
import { Redactor } from "./redact.ts";

// For the channel's tests only: a gateway on a temporary data folder with a stand-in engine (no
// model, no process) and an in-memory messenger. Nothing here is used by the gateway itself.

/** An engine a test drives by hand: it says, asks, and ends turns when told to. */
export class StandInEngine implements ProviderAdapter {
  readonly provider: Provider;
  /** What the engine reports about itself (models, usage), as a test sets it. */
  report: Partial<ProviderStatus> = {};
  readonly sent: { sessionId: string; text: string; access: AccessMode; requestId: string }[] = [];
  readonly steered: { sessionId: string; text: string }[] = [];
  readonly interrupted: string[] = [];
  readonly answered: { sessionId: string; itemId: string; decision: ApprovalDecision }[] = [];
  canSteer = true;
  /** How many requests reached the engine, counted before it takes them. */
  asked = 0;
  /** The next send fails with this message (the engine never starts). */
  failSend: string | null = null;
  /** Held open while the engine takes a new request. */
  sendGate: Promise<void> | null = null;
  private readonly sink: () => AdapterSink;
  private readonly turns = new Map<string, string>();
  private readonly asking = new Map<string, Extract<TranscriptItem, { kind: "approval" }>>();
  private count = 0;

  constructor(sink: () => AdapterSink, provider: Provider = "claude") { this.sink = sink; this.provider = provider; }
  async init() {}
  status(): ProviderStatus { return { ...emptyStatus(this.provider), installed: true, ...this.report }; }
  async refreshStatus() { return this.status(); }
  async login() { return { url: null, message: "" }; }

  async send(session: Session & { access: AccessMode }, _work: Work, text: string, turnKey: string) {
    this.asked += 1;
    await this.sendGate;
    if (this.failSend) { const message = this.failSend; this.failSend = null; throw new Error(message); }
    this.sent.push({ sessionId: session.id, text, access: session.access, requestId: turnKey });
    this.turns.set(session.id, turnKey);
    this.sink().updateSession(session.id, { status: "running", activity: "응답 중" });
  }

  async steer(session: Session, _work: Work, text: string) {
    if (!this.canSteer || !this.turns.has(session.id)) return false;
    this.steered.push({ sessionId: session.id, text });
    return true;
  }

  running(sessionId: string) { return this.turns.has(sessionId); }

  /** The engine writes a reply. */
  say(sessionId: string, text: string) {
    this.sink().upsertItem(sessionId, { kind: "assistant", id: `reply:${++this.count}`, text, streaming: false, at: Date.now() });
  }

  /** The engine reports what it is doing (the line under the conversation). */
  doing(sessionId: string, activity: string) {
    this.sink().updateSession(sessionId, { activity });
  }

  /** The engine asks before a step (a conversation in a stricter mode), or shows a plan to go ahead with. */
  ask(sessionId: string, title: string, detail: string | null, options: { plan?: boolean } = {}) {
    const item: Extract<TranscriptItem, { kind: "approval" }> = { kind: "approval", id: `approval:${++this.count}`, title, detail, reason: null, decision: null, at: Date.now(), ...(options.plan ? { plan: true } : {}) };
    this.asking.set(item.id, item);
    this.sink().upsertItem(sessionId, item);
    this.sink().updateSession(sessionId, { status: "awaitingApproval", activity: "승인 필요" });
    return item.id;
  }

  async answerApproval(session: Session, itemId: string, decision: ApprovalDecision) {
    const item = this.asking.get(itemId);
    if (!item) return false;
    this.asking.delete(itemId);
    this.answered.push({ sessionId: session.id, itemId, decision });
    this.sink().upsertItem(session.id, { ...item, decision });
    this.sink().updateSession(session.id, { status: "running", activity: "응답 중" });
    return true;
  }

  /** The turn ends. */
  finish(sessionId: string, status: "completed" | "interrupted" | "failed" = "completed", cause: TurnCause | null = null) {
    const key = this.turns.get(sessionId);
    if (!key) throw new Error("no turn is running in that conversation");
    this.turns.delete(sessionId);
    this.sink().upsertItem(sessionId, { kind: "turnEnd", id: `end:${key}`, status, durationMs: 1, at: Date.now(), ...(cause ? { cause } : {}) });
    this.sink().updateSession(sessionId, { status: "idle", activity: null });
  }

  async interrupt(session: Session) {
    this.interrupted.push(session.id);
    if (this.turns.has(session.id)) this.finish(session.id, "interrupted", "stop");
  }

  async shutdown() {}
}

export type Kit = ReturnType<typeof openKit> & { dir: string };

const dirs: string[] = [];
/** Remove every temporary data folder a test made. */
export function cleanKits() {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** What a test adds to the gateway: a second engine, the project notes, a search. */
export type KitOptions = { codex?: boolean; projects?: boolean; search?: (query: string) => Promise<SearchPage>; footer?: boolean };

/** The gateway over the data in `dir` (opened again on the same files after a restart). */
export function openKit(dir: string, clock: { now: number }, options: KitOptions = {}) {
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(join(dataDir, "state.sqlite"));
  const bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dataDir, "works"), dataDir });
  const engine = new StandInEngine(() => manager.sink);
  manager.registerAdapter(engine);
  const codex = options.codex ? new StandInEngine(() => manager.sink, "codex") : null;
  if (codex) manager.registerAdapter(codex);
  const projects = options.projects ? new Projects(store, bus, manager, new Pkm(store, bus, manager, { dataDir })) : null;
  const lines: string[] = [];
  const redactor = new Redactor();
  const log = new ChannelLog(redactor, (line) => lines.push(line), () => clock.now);
  const core = new ChannelCore({ store, manager, bus, log, now: () => clock.now, retryMs: [1, 1], projects: () => projects, dataDir, footer: options.footer ?? false, ...(options.search ? { search: options.search } : {}) });
  const adapter = new FakeAdapter();
  core.attach(adapter);
  return { dataDir, store, bus, manager, engine, codex, projects, core, adapter, clock, lines, redactor, options };
}

export async function startKit(options: KitOptions = {}): Promise<Kit> {
  const dir = mkdtempSync(join(tmpdir(), "wb-channel-"));
  dirs.push(dir);
  const kit = openKit(dir, { now: Date.UTC(2026, 10, 12, 3, 0, 0) }, options);
  await kit.core.start();
  return { ...kit, dir };
}

/** The app closes and opens again on the same data: nothing in memory survives. */
export async function restartKit(kit: Kit): Promise<Kit> {
  await kit.core.close();
  await kit.manager.shutdown();
  kit.store.close();
  const again = openKit(kit.dir, kit.clock, kit.options);
  await again.core.start();
  return { ...again, dir: kit.dir };
}

export const tick = (ms = 5) => new Promise((done) => setTimeout(done, ms));

/** Wait until something a test set in motion has happened. */
export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 4000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error("the awaited state did not come");
    await tick(2);
  }
}

/** Everything the core started in the background has settled. */
export async function settle(kit: Pick<Kit, "core">) {
  for (let round = 0; round < 3; round += 1) {
    await kit.core.idle();
    await tick();
  }
}

/** Pair the phone the way a person does: the PC makes the link, the phone opens it, the PC approves. */
export async function pair(kit: Kit, userId = "555") {
  const { code } = kit.core.beginPairing("telegram", kit.adapter.botId);
  await kit.adapter.deliver(kit.adapter.message(`/start ${code}`, { userId }));
  const request = kit.core.pairing("telegram", kit.adapter.botId).request;
  if (!request) throw new Error("the phone's request did not reach the PC");
  const binding = await kit.core.approvePairing("telegram", kit.adapter.botId, request.id);
  await settle(kit);
  return binding;
}

/** A person sends a line from the paired chat, and the core finishes what it started for it. */
export async function say(kit: Kit, text: string, options: { userId?: string; eventId?: string } = {}) {
  const event = kit.adapter.message(text, options);
  await kit.adapter.deliver(event);
  await settle(kit);
  return event;
}

/** A person presses a button on the last message that carries one with this label. */
export async function press(kit: Kit, label: string, options: { userId?: string } = {}) {
  const { token, messageId } = kit.adapter.buttonOf(label);
  const event = kit.adapter.press(token, { ...options, messageId });
  await kit.adapter.deliver(event);
  await settle(kit);
  return event;
}

export const sessionOf = (kit: Pick<Kit, "manager">, id: string) => kit.manager.snapshot().sessions.find((entry) => entry.id === id)!;
export const userItems = (kit: Pick<Kit, "manager">, sessionId: string) => kit.manager.items(sessionId).items.flatMap((item) => (item.kind === "user" ? [item] : []));
