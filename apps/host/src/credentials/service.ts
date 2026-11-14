import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CredentialHandoffView, CredentialKind, CredentialsState, CredentialSummary, Session } from "@workbench/contracts";
import { HttpError } from "../errors.ts";
import { readBody, sendJson } from "../http.ts";
import type { OfficeVault } from "../office-vault.ts";
import type { SessionManager } from "../sessions.ts";
import { TranscriptScrubber } from "./scrubber.ts";
import { originText, siteOf } from "./site.ts";
import { CredentialStore, KINDS, cleanName, cleanSite, newEntryId, secretsOf, type Handoff } from "./store.ts";

/**
 * A site as shown (the AI chooses it, a page may have put words in its mouth): the host name only,
 * lower case, letters, digits, dots and hyphens, at most 60 characters. Never a link, never markup.
 */
export function hostOf(value: unknown): string {
  const text = cleanSite(value);
  if (!text) return "";
  let host = text;
  try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).hostname; } catch { /* Not an address: what is left of it below. */ }
  return host.toLowerCase().replace(/[^a-z0-9.-]/g, "").slice(0, 60);
}

// What the AI's `workbench-credential` asks for, and what follows: a hand-over ("X가 필요합니다")
// given at the PC or in the paired chat, then ONE continuation request in the same conversation
// (request id `cont:<handoffId>`, queued mode). The conversation is not held open while waiting:
// the engine ends its turn, and the continuation leaves the queue by the same rule as every
// request (when its user item is written). The same request id makes it go in once, however often
// it is tried (restarts, retries, a button pressed twice).

/** How long a hand-over waits for the person. */
export const HANDOFF_TTL = 24 * 60 * 60_000;
const TICK_MS = 60_000;
/** Hand-overs waiting at once: per conversation, and per chat. */
const WAITING_PER_SESSION = 3;
const WAITING_PER_CHAT = 5;
const VALUE_LIMIT = 4096;

/** The one line the AI gets (exit 0 for ok, 1 for a fixed failure code). */
export type ToolAnswer = { code: number; stdout: string; stderr: string };
const answer = (code: string): ToolAnswer => ({ code: code === "ok" ? 0 : 1, stdout: `${code}\n`, stderr: "" });

export const continuationText = (name: string) => `[자동 이어 하기] '${name}'가 준비되었습니다. 멈춘 곳에서 이어 하세요.`;
export const continuationId = (handoffId: string) => `cont:${handoffId}`;

/** What the paired chat does for hand-overs (channels/vault-chat.ts); absent, everything is at the PC. */
export type CredentialChat = {
  /** The chat whose requests run in this conversation, if one is paired and open. */
  bindingFor(sessionId: string): string | null;
  /**
   * The one message in the chat ("X가 필요합니다", its input with it, or 쓰기 / 안 쓰기). "asked": it
   * went or may have gone (its input is open); "refused": known not sent, for good (a 4xx); "held":
   * not sent now (the chat is paused or locked, or the messenger did not take it yet).
   */
  ask(handoff: Handoff): Promise<"asked" | "refused" | "held">;
  /** A line about a hand-over that ended without the chat: given at the PC, expired. True when it reached the chat. */
  told(handoff: Handoff, what: "given-at-pc" | "expired" | "declined"): Promise<boolean>;
  /** The hand-over no longer waits: its input in the chat (and any "late" state) is over. */
  ended(handoff: Handoff): void;
  /** One line to the chat of a conversation (the PC's keyring is locked). */
  notice(sessionId: string, key: string, text: string): Promise<void>;
  /**
   * The continuation, through the channel's own gates and with the chat as its origin ("pc": no
   * chat to go through; "held": the chat is paused or locked, tried again when it opens).
   */
  continueWith(handoff: Handoff): Promise<"queued" | "refused" | "pc" | "held">;
};

export type CredentialServiceOptions = {
  dataDir: string;
  vault: OfficeVault;
  manager: Pick<SessionManager, "view" | "send" | "items"> & { sink?: Pick<SessionManager["sink"], "upsertItem"> };
  now?: () => number;
  log?: (code: string, detail?: unknown) => void;
};

const SUBCOMMANDS = new Set(["list", "need", "fill", "mcp"]);

/** `--name X` / `--name=X` options of one command line. */
function options(args: string[]): Map<string, string> | null {
  const found = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const inline = /^--([a-z]+)=(.*)$/s.exec(arg);
    if (inline) { found.set(inline[1]!, inline[2]!); continue; }
    const flag = /^--([a-z]+)$/.exec(arg);
    if (!flag || index + 1 >= args.length) return null;
    found.set(flag[1]!, args[index + 1]!);
    index += 1;
  }
  return found;
}

export class CredentialService {
  readonly scrubber = new TranscriptScrubber();
  readonly store: CredentialStore;
  chat: CredentialChat | null = null;
  /** Unit 9: subcommands built elsewhere (`fill`, `step`: credentials/fill.ts), by name. */
  readonly commands = new Map<string, (sessionId: string, args: string[]) => Promise<ToolAnswer>>();
  private readonly options: CredentialServiceOptions;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: CredentialServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.store = new CredentialStore(options.dataDir, options.vault, this.scrubber, this.now);
  }

  private note(code: string, detail?: unknown) {
    this.options.log?.(code, detail);
  }

  /**
   * After the gateway's other services: the scrubber learns what is stored (one keyring call, only
   * when something is), continuations that did not get out before a stop are sent (once, by their
   * id), and hand-overs past their time are ended.
   */
  async start() {
    await this.warmUp();
    await this.tick();
    this.timer = setInterval(() => { void this.tick().catch((error: unknown) => this.note("credentials_tick", error)); }, TICK_MS);
    this.timer.unref();
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * The scrubber learns every stored secret (R5): before any engine starts. One try; it is not
   * repeated on a timer (each try may raise the OS keyring's unlock prompt). Until it succeeds no
   * stored value is given out, and it is tried again only when something needs the store
   * (`ensureReady`: a need for a stored entry, a use, a hand-over finishing, the PC panel's 다시 시도).
   */
  async warmUp(): Promise<boolean> {
    return this.store.warm().catch((error: unknown) => { this.note("credentials_unopened", error); return false; });
  }

  /** Ready, or one more try now (at most one per call). */
  private async ensureReady(): Promise<boolean> {
    return this.store.ready || this.warmUp();
  }

  /** The PC panel opened, or its 다시 시도: one try. */
  async unlock(): Promise<boolean> {
    return this.ensureReady();
  }

  // The AI's tool

  /** One command of `workbench-credential`, from a conversation's own spool (credentials/tool.ts). */
  async run(sessionId: string, args: string[]): Promise<ToolAnswer> {
    const [command, ...rest] = args;
    if (!command || (!SUBCOMMANDS.has(command) && !this.commands.has(command))) return answer("fail:bad_arguments");
    const extra = this.commands.get(command);
    if (extra) return extra(sessionId, rest);
    // Units 9 and 10: the host fills a page / starts an MCP server with the value. Not built yet.
    if (command === "fill" || command === "mcp") return answer("fail:not_available_yet");
    if (command === "list") {
      if (rest.length) return answer("fail:bad_arguments");
      const lines = this.store.summaries().map((entry) => `${entry.name}\t${entry.kind}\t${entry.site || "-"}`);
      return { code: 0, stdout: lines.length ? `${lines.join("\n")}\n` : "(비어 있음)\n", stderr: "" };
    }
    return this.need(sessionId, rest);
  }

  private async need(sessionId: string, args: string[]): Promise<ToolAnswer> {
    const given = options(args);
    if (!given || [...given.keys()].some((key) => !["name", "kind", "site", "fields"].includes(key))) return answer("fail:bad_arguments");
    const name = cleanName(given.get("name"));
    const kind = (given.get("kind") ?? "other") as CredentialKind;
    const fields = (given.get("fields") ?? "").split(",").map(cleanName).filter(Boolean);
    if (!name || !KINDS.includes(kind) || fields.length > 6 || fields.some((field) => field.length > 20) || new Set(fields).size !== fields.length) return answer("fail:bad_arguments");
    const session = this.options.manager.view.sessions.get(sessionId);
    if (!session) return answer("fail:unknown_session");
    if (session.archivedAt) return answer("fail:archived");
    const entry = this.store.find(name);
    const covered = entry && fields.every((field) => entry.fields.includes(field));
    const live = this.store.handoffs().filter((handoff) => handoff.sessionId === sessionId && handoff.expiresAt > this.now());
    if (entry && covered) {
      if (!(await this.ensureReady())) {
        await this.chat?.notice(sessionId, `cred-locked:${sessionId}`, "PC의 보안 저장소가 잠겨 있어 저장한 값을 쓸 수 없습니다. PC에서 잠금을 풀면 이어서 할 수 있습니다.").catch(() => undefined);
        return answer("fail:keyring_locked");
      }
      if (!entry.askEachTime) return answer("ok");
      // 매번 묻기: once before each use; a leave given and not spent yet is enough.
      if (live.some((handoff) => handoff.mode === "use" && handoff.entryId === entry.id && handoff.state === "ready" && !handoff.usedAt)) return answer("ok");
      if (live.some((handoff) => handoff.mode === "use" && handoff.entryId === entry.id && handoff.state === "waiting")) return answer("fail:handover_waiting");
      if (this.tooMany(sessionId)) return answer("fail:too_many_handovers");
      await this.open(session, { name: entry.name, kind: entry.kind, site: entry.site, fields: entry.fields, secret: entry.secret, mode: "use", entryId: entry.id });
      return answer("fail:handover_sent");
    }
    if (live.some((handoff) => handoff.mode === "give" && handoff.state === "waiting" && handoff.name.toLocaleLowerCase("ko") === name.toLocaleLowerCase("ko"))) return answer("fail:handover_waiting");
    if (this.tooMany(sessionId)) return answer("fail:too_many_handovers");
    const asked = fields.length ? fields : ["값"];
    const origin = originText(siteOf(given.get("site")) ?? { scheme: "https", host: "", port: null });
    await this.open(session, { name, kind, site: hostOf(given.get("site")), ...(origin ? { origin } : {}), fields: asked, secret: secretsOf(kind, asked), mode: "give", entryId: newEntryId() });
    return answer("fail:handover_sent");
  }

  /** Too many hand-overs already wait in this conversation, or in its chat. */
  private tooMany(sessionId: string): boolean {
    const now = this.now(), waiting = this.store.handoffs().filter((handoff) => handoff.state === "waiting" && handoff.expiresAt > now);
    if (waiting.filter((handoff) => handoff.sessionId === sessionId).length >= WAITING_PER_SESSION) return true;
    const chat = this.chat?.bindingFor(sessionId) ?? null;
    return Boolean(chat && waiting.filter((handoff) => handoff.bindingId === chat).length >= WAITING_PER_CHAT);
  }

  private async open(session: Session, spec: Pick<Handoff, "name" | "kind" | "site" | "fields" | "secret" | "mode" | "entryId" | "origin">) {
    const now = this.now();
    const handoff: Handoff = {
      id: `h_${randomBytes(9).toString("base64url")}`, sessionId: session.id, bindingId: this.chat?.bindingFor(session.id) ?? null, ...spec,
      state: "waiting", createdAt: now, expiresAt: now + HANDOFF_TTL, doneAt: null, held: null, continued: null, events: [], usedAt: null,
    };
    this.store.saveHandoff(handoff);
    await this.askInChat(handoff);
  }

  /** Its message to the chat, once it can be heard (a paused or locked chat: when it opens again). */
  private async askInChat(handoff: Handoff) {
    if (!handoff.bindingId || !this.chat || handoff.askedAt || (handoff.askRefusals ?? 0) > 1) return;
    const result = await this.chat.ask(handoff).catch((error: unknown) => { this.note("handoff_ask_failed", error); return "held" as const; });
    if (result === "asked") this.store.updateHandoff(handoff.id, { askedAt: this.now() });
    // Refused for good: tried once more, later (by the tick), as a new message.
    if (result === "refused") this.store.updateHandoff(handoff.id, { askRefusals: (handoff.askRefusals ?? 0) + 1, askRound: (handoff.askRound ?? 0) + 1 });
  }

  /**
   * "값이 아니었어요": a line taken as a field was not a value. Waiting: the field is given up and
   * asked again. Already kept: only that field goes, from the entry THIS hand-over made (found by its
   * id, never by name: an entry the person made afterwards under the same name is not touched); an
   * entry with nothing else in it is removed. Nothing of the line is passed on.
   */
  discardField(handoffId: string, field: string): "dropped" | "cleared" | "removed" | "over" {
    const handoff = this.store.handoff(handoffId);
    if (!handoff || handoff.mode !== "give" || !handoff.fields.includes(field)) return "over";
    if (handoff.state === "waiting") {
      this.store.dropDraftField(handoffId, field);
      return "dropped";
    }
    const entry = handoff.state === "ready" ? this.store.summaries().find((other) => other.id === handoff.entryId) : undefined;
    if (!entry) return "over";
    if (this.store.clearField(entry.id, field) === "empty") { this.removeEntry(entry.id); return "removed"; }
    return "cleared";
  }

  /** A chat was paired again: hand-overs still waiting for the same person's disconnected chat are asked there, once. */
  async rebind(bindingId: string, earlier: (bindingId: string) => boolean) {
    for (const handoff of this.store.handoffs()) {
      if (handoff.state !== "waiting" || !handoff.bindingId || handoff.bindingId === bindingId || !earlier(handoff.bindingId)) continue;
      const moved = this.store.updateHandoff(handoff.id, { bindingId, askedAt: null, askRefusals: 0, askRound: (handoff.askRound ?? 0) + 1 })!;
      await this.askInChat(moved);
    }
  }

  /** A hand-over stops waiting, for whatever reason: its draft goes, and so does its input in the chat (N3). */
  private stopWaiting(handoffId: string, patch: Partial<Handoff>): Handoff {
    this.store.dropDraft(handoffId);
    const stopped = this.store.updateHandoff(handoffId, patch)!;
    this.chat?.ended(stopped);
    return stopped;
  }

  /** The chat opened again (resumed, unlocked): what waited for it goes now, once. */
  async reopened(bindingId: string) {
    for (const handoff of this.store.handoffs()) {
      if (handoff.bindingId !== bindingId) continue;
      if (handoff.state === "waiting" && !handoff.askedAt) await this.askInChat(handoff);
      if (handoff.unsaid === "expired" && this.chat && await this.chat.told(handoff, "expired").catch(() => false)) this.store.updateHandoff(handoff.id, { unsaid: null });
      if (handoff.state === "ready" && !handoff.continued) await this.continueWith(handoff);
    }
  }

  // The hand-over's end

  /** The conversation goes on: one continuation request, in the chat's way or straight at the PC. */
  private async continueWith(handoff: Handoff) {
    const current = this.store.handoff(handoff.id);
    if (!current || current.continued) return;
    let result: "queued" | "refused" | "pc" | "held" = current.bindingId && this.chat ? await this.chat.continueWith(current) : "pc";
    // The chat is paused or locked: tried again (once it opens) by the tick.
    if (result === "held") return;
    if (result === "pc") {
      try {
        await this.options.manager.send(current.sessionId, continuationId(current.id), continuationText(current.name), [], null, null, "queue", { activate: false });
        result = "queued";
      } catch (error) {
        // An archived conversation, or a document AI whose document is gone: not brought back.
        this.note("continuation_refused", error);
        result = "refused";
      }
    }
    this.store.updateHandoff(current.id, { continued: result });
  }

  /** A field given in the chat, from one message (counted once). */
  async receive(handoffId: string, field: string, value: string, eventId: string): Promise<"sealed" | "memory" | "taken"> {
    const handoff = this.require(handoffId);
    if (this.store.taken(handoffId, eventId)) return "taken";
    if (!handoff.fields.includes(field) || !value || value.length > VALUE_LIMIT) throw new HttpError(400, "credential_input", "받을 수 없는 값입니다.");
    return this.store.putField(handoff, field, value, eventId);
  }

  /** A field of a finished hand-over given again (다시 넣기): replaced in its entry; the conversation is not continued again. */
  async replaceField(handoffId: string, field: string, value: string, eventId: string): Promise<"sealed" | "memory" | "taken"> {
    const handoff = this.require(handoffId);
    if (this.store.taken(handoffId, eventId)) return "taken";
    if (handoff.state !== "ready" || !handoff.fields.includes(field) || !value || value.length > VALUE_LIMIT) throw new HttpError(400, "credential_input", "받을 수 없는 값입니다.");
    return this.store.replaceField(handoff, field, value, eventId);
  }

  /** Whether every field of a hand-over is in. */
  complete(handoffId: string): boolean {
    const handoff = this.store.handoff(handoffId);
    return Boolean(handoff && handoff.fields.every((field) => this.store.filled(handoffId).includes(field)));
  }

  /** Every field is in: the entry is kept, the hand-over is ready, and the conversation goes on. */
  async finish(handoffId: string): Promise<CredentialSummary> {
    const handoff = this.require(handoffId);
    const entry = this.store.finish(handoffId, { state: "ready", doneAt: this.now() });
    // A hand-over finishing is a need of the store: a keyring locked at start is tried once more (N5).
    if (!this.store.ready) await this.ensureReady();
    this.chat?.ended(this.store.updateHandoff(handoffId, { held: entry.held })!);
    await this.continueWith(this.require(handoffId));
    await this.satisfy(entry.name, handoff.id);
    return entry;
  }

  /** Other conversations waiting for the same name have it now too. */
  private async satisfy(name: string, except: string | null) {
    for (const other of this.store.handoffs()) {
      if (other.id === except || other.mode !== "give" || other.state !== "waiting" || other.name.toLocaleLowerCase("ko") !== name.toLocaleLowerCase("ko")) continue;
      const ready = this.stopWaiting(other.id, { state: "ready", doneAt: this.now(), held: this.store.find(name)?.held ?? null });
      if (ready.bindingId && this.chat) await this.chat.told(ready, "given-at-pc").catch((error: unknown) => this.note("handoff_told_failed", error));
      await this.continueWith(ready);
    }
  }

  /** 매번 묻기 answered (in the chat or at the PC): 쓰기 lets one use happen and the conversation go on; 안 쓰기 ends it. */
  async allow(handoffId: string, use: boolean): Promise<Handoff> {
    const handoff = this.require(handoffId);
    if (handoff.mode !== "use" || handoff.state !== "waiting") throw new HttpError(409, "credential_handoff_done", "이미 끝난 요청입니다.");
    if (!use) return this.stopWaiting(handoffId, { state: "declined", doneAt: this.now() });
    const ready = this.stopWaiting(handoffId, { state: "ready", doneAt: this.now(), usedAt: null });
    await this.continueWith(ready);
    return this.require(handoffId);
  }

  /** The person gave up on a hand-over ("취소" in the chat closes its input only; this ends it). */
  cancel(handoffId: string) {
    const handoff = this.require(handoffId);
    if (handoff.state !== "waiting") return handoff;
    return this.stopWaiting(handoffId, { state: "cancelled", doneAt: this.now() });
  }

  /**
   * The values for one use in a conversation (units 9 and 10: the host fills a page, starts an MCP
   * server). A 매번 묻기 entry needs a leave given for this conversation, and spends it.
   */
  async use(name: string, sessionId: string): Promise<Record<string, string>> {
    const entry = this.store.find(name);
    if (!entry) throw new HttpError(404, "credential_missing", "보관함에 그 항목이 없습니다.");
    await this.ensureReady();
    if (entry.askEachTime) {
      const leave = this.store.handoffs().find((handoff) => handoff.mode === "use" && handoff.entryId === entry.id && handoff.sessionId === sessionId && handoff.state === "ready" && !handoff.usedAt && handoff.expiresAt > this.now());
      if (!leave) throw new HttpError(409, "credential_needs_leave", "매번 묻기 항목이라 쓰기 전에 물어야 합니다.");
      this.store.updateHandoff(leave.id, { usedAt: this.now() });
    }
    return this.store.reveal(entry.id, sessionId);
  }

  handoff(id: string): Handoff | null {
    return this.store.handoff(id);
  }

  private require(id: string): Handoff {
    const handoff = this.store.handoff(id);
    if (!handoff) throw new HttpError(404, "credential_handoff_missing", "넘겨받기를 찾지 못했습니다.");
    return handoff;
  }

  /** Hand-overs past their time end, and say so where they were asked. */
  /** An entry deleted (PC or chat): a hand-over that asks to use it (매번 묻기) stops waiting. */
  removeEntry(entryId: string) {
    this.store.remove(entryId);
    for (const handoff of this.store.handoffs()) if (handoff.state === "waiting" && handoff.mode === "use" && handoff.entryId === entryId) this.stopWaiting(handoff.id, { state: "cancelled", doneAt: this.now() });
  }

  async tick() {
    // Continuations that did not get out (a stop in between, or the chat was paused or locked).
    for (const handoff of this.store.handoffs()) if (handoff.state === "ready" && !handoff.continued) await this.continueWith(handoff);
    const now = this.now();
    for (const handoff of this.store.handoffs()) {
      if (handoff.state !== "waiting") continue;
      // Its conversation was archived or removed, or (매번 묻기) its entry deleted: it ends.
      const session = this.options.manager.view.sessions.get(handoff.sessionId);
      if (!session || session.archivedAt || (handoff.mode === "use" && !this.store.summaries().some((entry) => entry.id === handoff.entryId))) {
        this.stopWaiting(handoff.id, { state: "cancelled", doneAt: now });
        continue;
      }
      if (handoff.expiresAt > now) {
        // Its message did not reach the chat yet (paused, locked, a failed send): tried again.
        if (!handoff.askedAt) await this.askInChat(handoff);
        continue;
      }
      const ended = this.stopWaiting(handoff.id, { state: "expired", doneAt: now });
      // Said in the conversation's own record, and in the chat (when it cannot hear it now: when it opens).
      this.options.manager.sink?.upsertItem(handoff.sessionId, { kind: "notice", id: `cred-expired:${handoff.id}`, level: "info", text: `'${handoff.name}' 넘겨받기 시간이 지났습니다(하루). 필요하면 다시 시켜 주세요.`, at: now });
      if (ended.bindingId && this.chat) {
        const said = await this.chat.told(ended, "expired").catch((error: unknown) => { this.note("handoff_told_failed", error); return false; });
        if (!said) this.store.updateHandoff(ended.id, { unsaid: "expired" });
      }
    }
  }

  // The PC

  private label(sessionId: string): string | null {
    const session = this.options.manager.view.sessions.get(sessionId);
    const work = session ? this.options.manager.view.works.get(session.workId) : undefined;
    return session ? `「${work?.title ?? "?"}」 › 「${session.purpose}」` : null;
  }

  state(): CredentialsState {
    const now = this.now();
    const waiting: CredentialHandoffView[] = this.store.handoffs().filter((handoff) => handoff.state === "waiting" && handoff.expiresAt > now).map((handoff) => ({
      id: handoff.id, sessionId: handoff.sessionId, sessionLabel: this.label(handoff.sessionId), name: handoff.name, kind: handoff.kind, site: handoff.site,
      fields: [...handoff.fields], secret: { ...secretsOf(handoff.kind, handoff.fields), ...handoff.secret }, mode: handoff.mode, createdAt: handoff.createdAt, expiresAt: handoff.expiresAt, inChat: Boolean(handoff.bindingId),
    }));
    return { entries: this.store.summaries(), waiting, trash: this.store.trashed(), locked: !this.store.ready };
  }

  /** Added at the PC (masked fields): kept, and every conversation waiting for that name goes on. */
  async add(input: Record<string, unknown>): Promise<CredentialSummary> {
    const values = input.values;
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new HttpError(400, "credential_input", "값을 넣어 주세요.");
    const entries = Object.entries(values as Record<string, unknown>);
    if (!entries.length || entries.length > 6 || entries.some(([, value]) => typeof value !== "string" || !value || value.length > VALUE_LIMIT)) throw new HttpError(400, "credential_input", "값을 넣어 주세요.");
    const kind = KINDS.includes(input.kind as CredentialKind) ? (input.kind as CredentialKind) : "other";
    const secret = input.secret && typeof input.secret === "object" && !Array.isArray(input.secret) ? (input.secret as Record<string, unknown>) : undefined;
    const origin = originText(siteOf(input.site) ?? { scheme: "https", host: "", port: null });
    const entry = await this.store.add({ name: String(input.name ?? ""), kind, site: hostOf(input.site), origin, values: Object.fromEntries(entries) as Record<string, string>, ...(secret ? { secret } : {}) });
    await this.satisfy(entry.name, null);
    return entry;
  }

  /** `/api/channels/credentials…`: the "비밀 보관함" of the 휴대폰 메신저 dialog. No answer carries a value. */
  async handle(req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<void> {
    const method = req.method ?? "GET";
    const body = async (): Promise<Record<string, unknown>> => {
      let parsed: unknown;
      try { parsed = JSON.parse((await readBody(req, 65_536)).toString("utf8") || "{}"); } catch { throw new HttpError(400, "credential_input", "요청 형식이 올바르지 않습니다."); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "credential_input", "요청 형식이 올바르지 않습니다.");
      return parsed as Record<string, unknown>;
    };
    const [, , , first, second] = parts;
    if (parts.length === 3 && method === "GET") return sendJson(res, 200, this.state());
    if (parts.length === 4 && first === "unlock" && method === "POST") {
      await this.unlock();
      return sendJson(res, 200, this.state());
    }
    if (parts.length === 3 && method === "POST") {
      await this.add(await body());
      return sendJson(res, 200, this.state());
    }
    if (parts.length === 5 && first === "handoffs" && method === "POST") {
      const input = await body();
      if (input.cancel === true) this.cancel(second!);
      else if (typeof input.use === "boolean") await this.allow(second!, input.use);
      else throw new HttpError(400, "credential_input", "use 또는 cancel이 필요합니다.");
      return sendJson(res, 200, this.state());
    }
    if (parts.length === 4 && first && method === "PATCH") {
      const input = await body();
      if (input.name === undefined && input.askEachTime === undefined && input.hosts === undefined) throw new HttpError(400, "credential_input", "바꿀 것이 없습니다.");
      if (input.hosts !== undefined) {
        const kept = this.store.summaries().find((entry) => entry.id === first)?.hosts ?? [];
        // Hosts are added only by the person's answer in the chat; here they can only be taken off.
        if (!Array.isArray(input.hosts) || input.hosts.some((host) => typeof host !== "string" || !kept.includes(host))) throw new HttpError(400, "credential_input", "허용한 주소는 빼기만 할 수 있습니다.");
        this.store.setHosts(first, input.hosts as string[]);
      }
      if (input.askEachTime !== undefined && typeof input.askEachTime !== "boolean") throw new HttpError(400, "credential_input", "askEachTime은 true 또는 false여야 합니다.");
      if (input.name !== undefined) this.store.rename(first, input.name);
      if (typeof input.askEachTime === "boolean") this.store.setAsk(first, input.askEachTime);
      return sendJson(res, 200, this.state());
    }
    if (parts.length === 4 && first && method === "DELETE") {
      this.removeEntry(first);
      return sendJson(res, 200, this.state());
    }
    if (parts.length === 5 && first && second === "restore" && method === "POST") {
      this.store.restore(first);
      return sendJson(res, 200, this.state());
    }
    throw new HttpError(404, "credential_route", "보관함 경로가 없습니다.");
  }
}
