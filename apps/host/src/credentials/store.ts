import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CredentialKind, CredentialSummary } from "@workbench/contracts";
import { writeAtomic } from "../atomic-write.ts";
import { HttpError } from "../errors.ts";
import type { OfficeVault } from "../office-vault.ts";
import type { TranscriptScrubber } from "./scrubber.ts";

// The credential store ("비밀 보관함"): what a person gave the PC so that its AI can log in, call a
// service or pay without being given the value. `<data>/credentials/store.json` (folder 0700, file
// 0600, the shared atomic writer) holds per entry its name, kind, site, field names, and per field
// a value sealed by the existing vault for the purpose "cred", bound to the entry and the field (a
// sealed value moved elsewhere in the file does not open). The same file holds the hand-overs and
// the fields of a hand-over still being given, so that taking a field, finishing an entry and
// marking its hand-over ready each happen in one write. Without an OS keyring nothing is written:
// the value is kept in memory, given once, and dropped. No value is ever returned by a route,
// sent to a messenger or exported; the scrubber learns each value the moment the store has it.

export type { CredentialKind, CredentialSummary };
export const KINDS: CredentialKind[] = ["login", "api-key", "card", "other"];

/**
 * A request for something only the person has (`give`), or, for an entry with 매번 묻기, for leave
 * to use it once (`use`). `events`: the messenger messages that gave its fields (each counts once).
 * `continued`: whether the conversation was asked to go on (`queued`) or that was refused.
 */
export type Handoff = {
  id: string; sessionId: string; bindingId: string | null;
  name: string; kind: CredentialKind; site: string; fields: string[];
  mode: "give" | "use"; entryId: string;
  /** Unit 9: the site's scheme and port when not https and its default (see CredentialSummary.origin). */
  origin?: string;
  /** Per field: secret or not (see `isSecretField`). Absent in a hand-over written before fix round 1: every field secret. */
  secret?: Record<string, boolean>;
  state: "waiting" | "ready" | "expired" | "declined" | "cancelled";
  createdAt: number; expiresAt: number; doneAt: number | null;
  held: "sealed" | "memory" | null;
  continued: "queued" | "refused" | null;
  events: string[];
  /** `use`: the leave was spent by a use. */
  usedAt?: number | null;
  /** When its message reached the chat (null: not yet, the chat was paused or locked; asked when it opens). */
  askedAt?: number | null;
  /** It expired while the chat could not hear it: said there when the chat opens. */
  unsaid?: "expired" | null;
  /** Its message was refused for good (a 4xx) this many times; it is tried once more. */
  askRefusals?: number;
  /** Which message asks it (a new one after a refusal or a new pairing; the first is round 0). */
  askRound?: number;
};

type Entry = Omit<CredentialSummary, "held"> & { values: Record<string, string> };
const PRE_ROUND1 = (entry: Entry): Entry => ({ ...entry, secret: entry.secret ?? Object.fromEntries(entry.fields.map((field) => [field, true])) });
type Draft = { handoffId: string; values: Record<string, string>; events: string[] };
type Trashed = Entry & { removedAt: number };
type FileShape = { version: 1; entries: Entry[]; drafts: Draft[]; trash: Trashed[]; handoffs: Handoff[] };

/** How long a deleted entry can be brought back. */
const TRASH_MS = 10 * 60_000;
const USED_IN = 20;
const HANDOFFS_KEPT = 200;

/** A name as it is shown and compared: one line, no control characters, at most 40 characters. */
export function cleanName(value: unknown): string {
  if (typeof value !== "string") return "";
  return [...value.replace(/[\p{Cc}\p{Cf}]+/gu, "").replace(/\s+/gu, " ").trim()].slice(0, 40).join("");
}
const same = (a: string, b: string) => a.toLocaleLowerCase("ko") === b.toLocaleLowerCase("ko");

/**
 * Whether a field is secret (design R2): a login's 아이디 / e-mail / user name and a card holder's
 * name are not; everything else is (passwords, keys, card number, expiry, CVC, PINs, codes, any
 * field of kind "other").
 */
export function isSecretField(kind: CredentialKind, field: string): boolean {
  const name = field.toLocaleLowerCase("ko").replace(/\s+/g, "");
  if (kind === "login") return !/^(아이디|id|이메일|e-?mail|메일|사용자명|사용자이름|username|user|login|계정)$/.test(name);
  if (kind === "card") return !/^(이름|소유자|카드소유자|명의|holder|name)$/.test(name);
  return true;
}
export const secretsOf = (kind: CredentialKind, fields: string[], given?: Record<string, unknown>) =>
  Object.fromEntries(fields.map((field) => [field, typeof given?.[field] === "boolean" ? (given[field] as boolean) : isSecretField(kind, field)]));
/** The values of the secret fields only: what the scrubber looks for. */
const secretValues = (values: Record<string, string>, secret: Record<string, boolean> | undefined) => Object.entries(values).filter(([field]) => secret?.[field] !== false).map(([, value]) => value);
const bindOf = (entryId: string, field: string) => `${entryId}\u0000${field}`;
export const newEntryId = () => `c_${randomBytes(9).toString("base64url")}`;

export class CredentialStore {
  private readonly dir: string;
  private readonly file: string;
  private readonly vault: OfficeVault;
  private readonly scrubber: TranscriptScrubber;
  private readonly now: () => number;
  private cache: FileShape | null = null;
  /** Kept for this run only (no keyring): entries and the fields of hand-overs being given. */
  private readonly memory = new Map<string, Entry>();
  private readonly memoryDrafts = new Map<string, Draft>();

  constructor(dataDir: string, vault: OfficeVault, scrubber: TranscriptScrubber, now: () => number = Date.now) {
    this.dir = join(dataDir, "credentials");
    this.file = join(this.dir, "store.json");
    this.vault = vault;
    this.scrubber = scrubber;
    this.now = now;
  }

  // The file

  private read(): FileShape {
    if (this.cache) return this.cache;
    const empty: FileShape = { version: 1, entries: [], drafts: [], trash: [], handoffs: [] };
    if (!existsSync(this.file)) {
      this.startedEmpty ??= true;
      return (this.cache = empty);
    }
    const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<FileShape>;
    this.startedEmpty ??= !(raw.entries?.length || raw.drafts?.length || raw.trash?.length);
    // An entry written before fields carried `secret` is read as all secret (never guessed less).
    this.cache = { version: 1, entries: (raw.entries ?? []).map(PRE_ROUND1), drafts: raw.drafts ?? [], trash: (raw.trash ?? []).map((entry) => ({ ...PRE_ROUND1(entry), removedAt: entry.removedAt })), handoffs: raw.handoffs ?? [] };
    return this.cache;
  }

  private write(next: FileShape) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    // Made 0600 before the first byte goes in; the atomic writer keeps the mode of the file it replaces.
    if (!existsSync(this.file)) closeSync(openSync(this.file, "wx", 0o600));
    writeAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
    chmodSync(this.file, 0o600);
    this.cache = next;
  }

  private change(edit: (file: FileShape) => void) {
    const next = structuredClone(this.read());
    edit(next);
    this.write(next);
  }

  /** Is anything stored at all (no keyring is asked for when nothing is)? */
  get empty() {
    const file = this.read();
    return !file.entries.length && !file.drafts.length && !file.trash.length && !this.memory.size && !this.memoryDrafts.size;
  }

  // Entries

  private summary(entry: Entry, held: "sealed" | "memory"): CredentialSummary {
    const { values: _values, ...shown } = entry;
    return { ...shown, fields: [...entry.fields], secret: { ...entry.secret }, usedIn: [...entry.usedIn], ...(entry.hosts ? { hosts: [...entry.hosts] } : {}), held };
  }

  private warmed = false;
  private startedEmpty: boolean | null = null;
  /** Every stored secret is known to the scrubber (nothing was stored when this run began, or `warm` succeeded): only then is a value given out. */
  get ready() {
    if (this.startedEmpty === null) this.read();
    return this.warmed || this.startedEmpty === true;
  }

  summaries(): CredentialSummary[] {
    this.purge();
    return [...this.read().entries.map((entry) => this.summary(entry, "sealed")), ...[...this.memory.values()].map((entry) => this.summary(entry, "memory"))];
  }

  find(name: string): CredentialSummary | null {
    const wanted = cleanName(name);
    return this.summaries().find((entry) => same(entry.name, wanted)) ?? null;
  }

  private get(id: string): { entry: Entry; held: "sealed" | "memory" } | null {
    const sealed = this.read().entries.find((entry) => entry.id === id);
    if (sealed) return { entry: sealed, held: "sealed" };
    const kept = this.memory.get(id);
    return kept ? { entry: kept, held: "memory" } : null;
  }

  private require(id: string) {
    const found = this.get(id);
    if (!found) throw new HttpError(404, "credential_missing", "보관함에 그 항목이 없습니다.");
    return found;
  }

  private nameInUse(name: string, except: string | null) {
    return this.summaries().some((entry) => entry.id !== except && same(entry.name, name));
  }

  /** Seal every field for an entry, or, without a keyring, null (the vault's 503). */
  private async seal(entryId: string, values: Record<string, string>): Promise<Record<string, string> | null> {
    const sealed: Record<string, string> = {};
    try {
      for (const [field, value] of Object.entries(values)) sealed[field] = await this.vault.sealFor("cred", value, bindOf(entryId, field));
    } catch (error) {
      if (error instanceof HttpError && error.code === "office_vault_unavailable") return null;
      throw error;
    }
    return sealed;
  }

  /**
   * Add an entry (at the PC). A same-named entry is replaced: changing a value means entering it again.
   * Without a keyring it is kept in memory for one use.
   */
  async add(input: { name: string; kind: CredentialKind; site: string; origin?: string | null; values: Record<string, string>; secret?: Record<string, unknown> }): Promise<CredentialSummary> {
    const name = cleanName(input.name);
    const fields = Object.keys(input.values).map(cleanName);
    if (!name || !fields.length || fields.some((field) => !field) || new Set(fields).size !== fields.length) throw new HttpError(400, "credential_input", "이름과 칸 이름, 값을 넣어 주세요.");
    if (Object.values(input.values).some((value) => typeof value !== "string" || !value)) throw new HttpError(400, "credential_input", "빈 값은 넣을 수 없습니다.");
    const id = newEntryId();
    const values = Object.fromEntries(Object.entries(input.values).map(([field, value]) => [cleanName(field), value]));
    const kind = KINDS.includes(input.kind) ? input.kind : "other";
    const secret = secretsOf(kind, fields, Object.fromEntries(Object.entries(input.secret ?? {}).map(([field, flag]) => [cleanName(field), flag])));
    this.scrubber.set(id, name, secretValues(values, secret));
    const sealed = await this.seal(id, values);
    const replaced = this.find(name);
    const entry: Entry = { id, name, kind, site: cleanSite(input.site), ...(input.origin ? { origin: input.origin } : {}), fields, secret, values: sealed ?? values, createdAt: this.now(), lastUsedAt: null, usedIn: [], askEachTime: replaced?.askEachTime ?? false, ...keptHosts(replaced, cleanSite(input.site)) };
    if (replaced?.held === "memory") this.drop(replaced.id);
    // One write: the new entry in, the one it replaces to the trash (it can be brought back for ten minutes).
    if (sealed || replaced?.held === "sealed") this.change((file) => {
      const old = replaced?.held === "sealed" ? file.entries.find((other) => other.id === replaced.id) : undefined;
      if (old) { file.entries = file.entries.filter((other) => other.id !== old.id); file.trash.push({ ...old, removedAt: this.now() }); }
      if (sealed) file.entries.push(entry);
    });
    if (!sealed) this.memory.set(id, entry);
    return this.summary(entry, sealed ? "sealed" : "memory");
  }

  /** An entry gone for good (replaced by a new one under its name). */
  private drop(id: string) {
    this.memory.delete(id);
    if (this.read().entries.some((entry) => entry.id === id)) this.change((file) => { file.entries = file.entries.filter((entry) => entry.id !== id); });
    this.scrubber.remove(id);
  }

  rename(id: string, name: unknown): CredentialSummary {
    const { entry, held } = this.require(id);
    const next = cleanName(name);
    if (!next) throw new HttpError(400, "credential_input", "새 이름을 넣어 주세요.");
    if (this.nameInUse(next, id)) throw new HttpError(409, "credential_name_taken", "같은 이름의 항목이 이미 있습니다.");
    if (held === "memory") entry.name = next;
    else this.change((file) => { file.entries.find((candidate) => candidate.id === id)!.name = next; });
    this.scrubber.relabel(id, next);
    return this.summary(this.require(id).entry, held);
  }

  /** Unit 9: the person allowed this login on another host too (in the chat). */
  allowHost(id: string, host: string): CredentialSummary {
    const { entry, held } = this.require(id);
    const hosts = [...new Set([...(entry.hosts ?? []), host.toLowerCase()])];
    return this.setHosts(id, hosts, held);
  }

  /** The other hosts kept for an entry (at the PC: only removing them). */
  setHosts(id: string, hosts: string[], held = this.require(id).held): CredentialSummary {
    const apply = (entry: Entry) => { if (hosts.length) entry.hosts = hosts; else delete entry.hosts; };
    if (held === "memory") apply(this.memory.get(id)!);
    else this.change((file) => apply(file.entries.find((entry) => entry.id === id)!));
    return this.summary(this.require(id).entry, held);
  }

  setAsk(id: string, on: boolean): CredentialSummary {
    const { held } = this.require(id);
    if (held === "memory") this.memory.get(id)!.askEachTime = on;
    else this.change((file) => { file.entries.find((entry) => entry.id === id)!.askEachTime = on; });
    return this.summary(this.require(id).entry, held);
  }

  /** Delete: it can be brought back for ten minutes (still hidden in transcripts meanwhile). */
  remove(id: string): CredentialSummary {
    const { entry, held } = this.require(id);
    if (held === "memory") {
      this.memory.delete(id);
      this.scrubber.remove(id);
      return this.summary(entry, held);
    }
    this.change((file) => {
      file.entries = file.entries.filter((candidate) => candidate.id !== id);
      file.trash.push({ ...entry, removedAt: this.now() });
    });
    return this.summary(entry, held);
  }

  restore(id: string): CredentialSummary {
    this.purge();
    const gone = this.read().trash.find((entry) => entry.id === id);
    if (!gone) throw new HttpError(404, "credential_missing", "되살릴 항목이 없습니다(10분이 지났을 수 있습니다).");
    if (this.nameInUse(gone.name, null)) throw new HttpError(409, "credential_name_taken", "같은 이름의 항목이 이미 있습니다.");
    const { removedAt: _removedAt, ...entry } = gone;
    this.change((file) => {
      file.trash = file.trash.filter((candidate) => candidate.id !== id);
      file.entries.push(entry);
    });
    return this.summary(entry, "sealed");
  }

  /** Deleted entries that can still be brought back (names only). */
  trashed(): { id: string; name: string; removedAt: number }[] {
    this.purge();
    return this.read().trash.map((entry) => ({ id: entry.id, name: entry.name, removedAt: entry.removedAt }));
  }

  /** Deleted entries past their ten minutes go for good (and the scrubber forgets them). */
  private purge() {
    const file = this.read(), before = this.now() - TRASH_MS;
    const old = file.trash.filter((entry) => entry.removedAt < before);
    if (!old.length) return;
    this.change((next) => { next.trash = next.trash.filter((entry) => entry.removedAt >= before); });
    for (const entry of old) this.scrubber.remove(entry.id);
  }

  private async open(id: string): Promise<Record<string, string>> {
    const entry = this.read().entries.find((candidate) => candidate.id === id) ?? this.read().trash.find((candidate) => candidate.id === id);
    if (!entry) throw new HttpError(404, "credential_missing", "보관함에 그 항목이 없습니다.");
    const values: Record<string, string> = {};
    // A field given up as "not a value" (clearField) has no value until it is entered again: it is simply absent.
    for (const field of entry.fields) if (entry.values[field] !== undefined) values[field] = await this.vault.openFor("cred", entry.values[field]!, bindOf(entry.id, field));
    return values;
  }

  /**
   * The values, for the one place that uses them (the host filling a page, starting an MCP server;
   * units 9 and 10). Never for a route or a messenger. A memory-only entry is given once and dropped.
   */
  async reveal(id: string, sessionId: string): Promise<Record<string, string>> {
    // A value the scrubber does not know yet is never handed to anything (R5).
    if (!this.ready) throw new HttpError(503, "credentials_locked", "PC의 보안 저장소가 잠겨 있어 저장한 값을 쓸 수 없습니다. PC에서 잠금을 풀어 주세요.");
    const { entry, held } = this.require(id);
    if (held === "memory") {
      this.memory.delete(id);
      return { ...entry.values };
    }
    const values = await this.open(id);
    this.scrubber.set(id, entry.name, secretValues(values, entry.secret));
    this.change((file) => {
      const stored = file.entries.find((candidate) => candidate.id === id)!;
      stored.lastUsedAt = this.now();
      stored.usedIn = [sessionId, ...stored.usedIn.filter((other) => other !== sessionId)].slice(0, USED_IN);
    });
    return values;
  }

  /**
   * The scrubber learns every stored secret (one keyring call, only when something is stored).
   * True when done; false when the keyring could not be opened (tried again later). Until it is
   * done no value is given out (`reveal`).
   */
  async warm(): Promise<boolean> {
    if (this.empty) return (this.warmed = true);
    const file = this.read();
    try {
      for (const entry of [...file.entries, ...file.trash]) this.scrubber.set(entry.id, entry.name, secretValues(await this.open(entry.id), entry.secret));
      for (const draft of file.drafts) {
        const handoff = file.handoffs.find((candidate) => candidate.id === draft.handoffId);
        if (!handoff) continue;
        const values: Record<string, string> = {};
        for (const [field, sealed] of Object.entries(draft.values)) values[field] = await this.vault.openFor("cred", sealed, bindOf(handoff.entryId, field));
        this.scrubber.set(`draft:${draft.handoffId}`, handoff.name, secretValues(values, handoff.secret));
      }
    } catch (error) {
      if (error instanceof HttpError && error.code === "office_vault_unavailable") return false;
      throw error;
    }
    return (this.warmed = true);
  }

  // Hand-overs

  handoffs(): Handoff[] {
    return this.read().handoffs.map((handoff) => ({ ...handoff }));
  }

  handoff(id: string): Handoff | null {
    const found = this.read().handoffs.find((handoff) => handoff.id === id);
    return found ? { ...found } : null;
  }

  saveHandoff(handoff: Handoff) {
    this.change((file) => {
      file.handoffs = [...file.handoffs.filter((other) => other.id !== handoff.id), handoff].slice(-HANDOFFS_KEPT);
    });
  }

  updateHandoff(id: string, patch: Partial<Handoff>): Handoff | null {
    if (!this.read().handoffs.some((handoff) => handoff.id === id)) return null;
    this.change((file) => {
      const at = file.handoffs.findIndex((handoff) => handoff.id === id);
      file.handoffs[at] = { ...file.handoffs[at]!, ...patch };
    });
    return this.handoff(id);
  }

  /** Whether this messenger message already gave a field of this hand-over (handled once, also after a crash). */
  taken(handoffId: string, eventId: string): boolean {
    const draft = this.read().drafts.find((entry) => entry.handoffId === handoffId) ?? this.memoryDrafts.get(handoffId);
    return Boolean(draft?.events.includes(eventId) || this.handoff(handoffId)?.events.includes(eventId));
  }

  /** How the fields given so far are kept: sealed in the file, or in memory (no keyring). */
  filledHeld(handoffId: string): "sealed" | "memory" {
    return this.memoryDrafts.has(handoffId) ? "memory" : "sealed";
  }

  filled(handoffId: string): string[] {
    const draft = this.read().drafts.find((entry) => entry.handoffId === handoffId) ?? this.memoryDrafts.get(handoffId);
    return draft ? Object.keys(draft.values) : [];
  }

  /**
   * One field of a hand-over, from one message: sealed into the hand-over's draft (bound to the
   * entry it will become), or kept in memory when there is no keyring. Its message counts as taken
   * in the same write.
   */
  async putField(handoff: Handoff, field: string, value: string, eventId: string): Promise<"sealed" | "memory"> {
    const kept = this.memoryDrafts.get(handoff.id);
    const values = { ...(kept?.values ?? {}), [field]: value };
    const known = [...(this.draftValues.get(handoff.id) ?? []), ...(handoff.secret?.[field] === false ? [] : [value])];
    this.draftValues.set(handoff.id, known);
    if (known.length) this.scrubber.set(`draft:${handoff.id}`, handoff.name, known);
    const sealed = kept ? null : await this.seal(handoff.entryId, { [field]: value });
    if (!sealed) {
      this.memoryDrafts.set(handoff.id, { handoffId: handoff.id, values, events: [...(kept?.events ?? []), eventId] });
      // Fields sealed before the keyring went away are not mixed with these: the hand-over goes on in memory.
      if (!kept && this.read().drafts.some((draft) => draft.handoffId === handoff.id)) this.change((file) => { file.drafts = file.drafts.filter((draft) => draft.handoffId !== handoff.id); });
      return "memory";
    }
    this.change((file) => {
      const draft = file.drafts.find((entry) => entry.handoffId === handoff.id);
      if (draft) {
        draft.values[field] = sealed[field]!;
        draft.events.push(eventId);
      } else file.drafts.push({ handoffId: handoff.id, values: sealed, events: [eventId] });
    });
    return "sealed";
  }

  /** What the scrubber was told of a draft so far (kept so that a second field does not unhide the first). */
  private readonly draftValues = new Map<string, string[]>();

  /**
   * Every field is in: the draft becomes the entry (replacing one of the same name) and the
   * hand-over gets `patch`, in one write.
   */
  finish(handoffId: string, patch: Partial<Handoff>): CredentialSummary {
    const handoff = this.handoff(handoffId);
    if (!handoff) throw new HttpError(404, "credential_handoff_missing", "넘겨받기가 없습니다.");
    const kept = this.memoryDrafts.get(handoffId);
    const draft = kept ?? this.read().drafts.find((entry) => entry.handoffId === handoffId);
    if (!draft || handoff.fields.some((field) => draft.values[field] === undefined)) throw new HttpError(409, "credential_incomplete", "아직 받지 못한 칸이 있습니다.");
    const replaced = this.find(handoff.name);
    const entry: Entry = { id: handoff.entryId, name: handoff.name, kind: handoff.kind, site: handoff.site, ...(handoff.origin ? { origin: handoff.origin } : {}), fields: [...handoff.fields], secret: { ...secretsOf(handoff.kind, handoff.fields), ...handoff.secret }, values: { ...draft.values }, createdAt: this.now(), lastUsedAt: null, usedIn: [], askEachTime: replaced?.askEachTime ?? false, ...keptHosts(replaced, handoff.site) };
    if (replaced && replaced.id !== entry.id) {
      this.memory.delete(replaced.id);
      this.scrubber.remove(replaced.id);
    }
    if (kept) {
      this.memoryDrafts.delete(handoffId);
      this.memory.set(entry.id, entry);
    }
    this.change((file) => {
      const old = replaced ? file.entries.find((other) => other.id === replaced.id) : undefined;
      if (old) { file.entries = file.entries.filter((other) => other.id !== old.id); file.trash.push({ ...old, removedAt: this.now() }); }
      file.drafts = file.drafts.filter((other) => other.handoffId !== handoffId);
      if (!kept) file.entries.push(entry);
      const at = file.handoffs.findIndex((other) => other.id === handoffId);
      file.handoffs[at] = { ...file.handoffs[at]!, ...patch, events: [...new Set([...file.handoffs[at]!.events, ...draft.events])] };
    });
    // The scrubber goes on hiding the values, now under the entry.
    const known = kept ? secretValues(kept.values, entry.secret) : this.draftValues.get(handoffId);
    if (known) {
      this.scrubber.set(entry.id, entry.name, known);
      this.scrubber.remove(`draft:${handoffId}`);
    } else void this.open(entry.id).then((values) => { this.scrubber.set(entry.id, entry.name, secretValues(values, entry.secret)); this.scrubber.remove(`draft:${handoffId}`); }).catch(() => undefined);
    this.draftValues.delete(handoffId);
    return this.summary(entry, kept ? "memory" : "sealed");
  }

  /**
   * One field of a finished hand-over's entry given again (다시 넣기 after the last field): sealed
   * in place, bound to the same entry and field, with its message counted as taken, in one write.
   */
  async replaceField(handoff: Handoff, field: string, value: string, eventId: string): Promise<"sealed" | "memory"> {
    const secret = handoff.secret?.[field] !== false;
    // The new value is hidden at once; the old one stays hidden too until the next start (never less).
    if (secret) this.scrubber.set(`again:${handoff.entryId}:${field}:${eventId}`, handoff.name, [value]);
    const kept = this.memory.get(handoff.entryId);
    if (kept) {
      kept.values[field] = value;
      this.change((file) => { const at = file.handoffs.findIndex((other) => other.id === handoff.id); if (at >= 0) file.handoffs[at]!.events.push(eventId); });
      return "memory";
    }
    if (!this.read().entries.some((entry) => entry.id === handoff.entryId)) throw new HttpError(404, "credential_missing", "보관함에 그 항목이 없습니다.");
    const sealed = await this.seal(handoff.entryId, { [field]: value });
    if (!sealed) throw new HttpError(503, "office_vault_unavailable", "운영체제의 보안 저장소를 사용할 수 없습니다.");
    this.change((file) => {
      file.entries.find((entry) => entry.id === handoff.entryId)!.values[field] = sealed[field]!;
      const at = file.handoffs.findIndex((other) => other.id === handoff.id);
      if (at >= 0) file.handoffs[at]!.events.push(eventId);
    });
    return "sealed";
  }

  /**
   * One field's value is taken out of an entry (it was not a value); the entry and its other fields
   * stay, and the scrubber still hides what was there. "empty": no value is left in the entry.
   */
  clearField(entryId: string, field: string): "cleared" | "empty" {
    const kept = this.memory.get(entryId);
    if (kept) {
      delete kept.values[field];
      return Object.keys(kept.values).length ? "cleared" : "empty";
    }
    let left = 0;
    this.change((file) => {
      const entry = file.entries.find((other) => other.id === entryId);
      if (!entry) return;
      delete entry.values[field];
      left = Object.keys(entry.values).length;
    });
    return left ? "cleared" : "empty";
  }

  /** One field of a hand-over's draft is given up (it was not a value); the scrubber still hides it. */
  dropDraftField(handoffId: string, field: string) {
    const kept = this.memoryDrafts.get(handoffId);
    if (kept) delete kept.values[field];
    if (this.read().drafts.some((draft) => draft.handoffId === handoffId && draft.values[field] !== undefined)) {
      this.change((file) => { const draft = file.drafts.find((entry) => entry.handoffId === handoffId); if (draft) delete draft.values[field]; });
    }
  }

  dropDraft(handoffId: string) {
    this.memoryDrafts.delete(handoffId);
    this.draftValues.delete(handoffId);
    if (this.read().drafts.some((draft) => draft.handoffId === handoffId)) this.change((file) => { file.drafts = file.drafts.filter((draft) => draft.handoffId !== handoffId); });
  }
}

/** A site or service as given: one line, at most 200 characters. */
/** An entry given again for the same site keeps the other hosts the person allowed. */
function keptHosts(replaced: CredentialSummary | null | undefined, site: string): { hosts?: string[] } {
  return replaced?.hosts?.length && replaced.site === site ? { hosts: [...replaced.hosts] } : {};
}

export function cleanSite(value: unknown): string {
  if (typeof value !== "string") return "";
  return [...value.replace(/[\p{Cc}\p{Cf}]+/gu, "").replace(/\s+/gu, " ").trim()].slice(0, 200).join("");
}
