import { formsOf, INVISIBLE } from "./forms.ts";

// The scrubber: a stored secret value that turns up in a conversation is replaced by
// `[비밀: <name>]`. Two different things are made of an item:
// - what is KEPT (the in-memory transcript, SQLite, the search index, exports): the whole item,
//   every value replaced (`value`, `text`). Nothing is ever withheld from it.
// - what is BROADCAST live while text is still being written (`live`, `delta`): the same, except
//   that a tail which could be the beginning of a stored value is held back until the next piece
//   shows whether it is one. With nothing that could be a beginning, nothing is held and the live
//   answer is not delayed at all. Everything held is released (`release`) when the turn ends, is
//   stopped, fails, or the engine exits.
// It rewrites text people or the model read; never ids, nor the path fields used to track files.
// With nothing stored, the very same objects and strings pass through.

type Rule = "anywhere" | "digits";
type Form = { form: string; label: string; rule: Rule };
type Span = { start: number; end: number; label: string };
type Visible = { plain: string; at: number[] } | null;

/**
 * Keys whose strings are not text to read: ids, paths the gateway tracks files by, and structural
 * words (a kind, a status, a tool's name, an engine's settings) that a secret equal to an enum word
 * must never rewrite. Object keys themselves are never rewritten.
 */
const SKIPPED = /^(?:id|.*Id|paths|reads|path|cwd|kind|status|type|role|tool|level|provider|mode|access|effort|model|engineModel|engineEffort|decision|change|state|executorKind)$/;

function visible(text: string): Visible {
  if (!INVISIBLE.test(text)) return null;
  let plain = "";
  const at: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (INVISIBLE.test(char)) continue;
    plain += char;
    at.push(index);
  }
  return { plain, at };
}

/**
 * A secret is found wherever it appears. The one exception: a number (digits only, or a card
 * number in its groupings) is not found inside a longer run of digits (a phone number, an id).
 */
const ruleOf = (form: string): Rule => (/^\d[\d -]*$/.test(form) && /\d$/.test(form) ? "digits" : "anywhere");

const DIGIT = /\d/;

/** Item fields still being written while the item is in progress (live only). */
function growing(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const entry = item as { kind?: unknown; streaming?: unknown; status?: unknown };
  if (entry.kind === "assistant" && entry.streaming === true) return "text";
  if (entry.kind === "reasoning") return "text";
  if (entry.kind === "tool" && entry.status === "running") return "output";
  return null;
}

type Stream = { emitted: string; tail: string; before: string };

export class TranscriptScrubber {
  private readonly entries = new Map<string, { label: string; values: string[] }>();
  private forms: Form[] = [];
  /** Forms by their first character, for the "could this tail begin a value" question. */
  private byFirst = new Map<string, Form[]>();
  private longest = 0;
  /** Live streams: what the screens have (`emitted`), the raw text not shown yet, and the raw character before it. */
  private readonly streams = new Map<string, Stream>();
  /** Items whose live copy is behind the kept one (released at turn end). */
  private readonly held = new Set<string>();

  get active() { return this.forms.length > 0; }

  /** Every stored value whatever its length, for exact matches only (a decoded JSON string, ruling E). */
  private readonly exacts = new Map<string, { label: string; values: string[] }>();

  /** The label of a stored value that is exactly this text (any length), or null. */
  exact(text: string): string | null {
    if (!text) return null;
    for (const entry of this.exacts.values()) if (entry.values.includes(text)) return entry.label;
    return null;
  }

  /** The secret values of one stored entry, hidden under its name. Values under 8 characters are not looked for (but known exactly). */
  set(id: string, name: string, values: string[]) {
    const all = values.filter((value) => value.length > 0);
    if (all.length) this.exacts.set(id, { label: `[비밀: ${name}]`, values: all });
    else this.exacts.delete(id);
    const kept = values.filter((value) => formsOf(value).length);
    if (!kept.length) { if (this.entries.delete(id)) this.rebuild(); return; }
    this.entries.set(id, { label: `[비밀: ${name}]`, values: kept });
    this.rebuild();
  }

  /** Every form of every value held (8+ characters), for searching files (channels/file-scan.ts). */
  needles(): string[] {
    return [...new Set(this.forms.map((form) => form.form))];
  }

  relabel(id: string, name: string) {
    const exact = this.exacts.get(id);
    if (exact) exact.label = `[비밀: ${name}]`;
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.label = `[비밀: ${name}]`;
    this.rebuild();
  }

  remove(id: string) {
    this.exacts.delete(id);
    if (this.entries.delete(id)) this.rebuild();
  }

  private rebuild() {
    const forms: Form[] = [];
    for (const entry of this.entries.values()) {
      for (const value of entry.values) {
        // A number's own forms (digits, card groupings) keep the digit rule; its encodings are found anywhere.
        const numeric = /^[\d -]+$/.test(value);
        for (const form of formsOf(value)) forms.push({ form, label: entry.label, rule: numeric ? ruleOf(form) : "anywhere" });
      }
    }
    this.forms = forms.sort((a, b) => b.form.length - a.form.length);
    this.byFirst = new Map();
    for (const form of this.forms) this.byFirst.set(form.form[0]!, [...(this.byFirst.get(form.form[0]!) ?? []), form]);
    this.longest = this.forms[0]?.form.length ?? 0;
  }

  /**
   * Values found in `plain` (no overlaps, longer forms first). `before`: the character before the
   * text. `final`: the text ends here (else a value right at its end, whose next character could
   * still turn it into part of a longer word or number, is not taken yet).
   */
  private spans(plain: string, before: string, final: boolean): Span[] {
    const found: Span[] = [];
    for (const { form, label, rule } of this.forms) {
      for (let at = plain.indexOf(form); at >= 0; at = plain.indexOf(form, at + 1)) {
        const end = at + form.length;
        if (rule === "digits") {
          const left = at > 0 ? plain[at - 1]! : before;
          if (left && DIGIT.test(left)) continue;
          if (end < plain.length ? DIGIT.test(plain[end]!) : !final) continue;
        }
        if (!found.some((span) => at < span.end && span.start < end)) found.push({ start: at, end, label });
      }
    }
    return found.sort((a, b) => a.start - b.start);
  }

  private render(raw: string, view: Visible, spans: Span[], to: number): string {
    const rawAt = (index: number) => (view ? (index < view.at.length ? view.at[index]! : raw.length) : index);
    let out = "", cursor = 0;
    for (const span of spans) {
      if (span.end > to) break;
      out += raw.slice(cursor, rawAt(span.start)) + span.label;
      cursor = view ? view.at[span.end - 1]! + 1 : span.end;
    }
    return out + raw.slice(cursor, rawAt(to));
  }

  /**
   * How much of `plain` may be shown live: up to the start of the longest tail that could begin a
   * stored form (or a whole word-like value whose next character is not here yet). Usually all of it.
   */
  private cut(plain: string, spans: Span[], before: string): number {
    let cut = plain.length;
    for (let at = Math.max(0, plain.length - this.longest + 1); at < plain.length; at += 1) {
      const tail = plain.slice(at);
      if ((this.byFirst.get(plain[at]!) ?? []).some((entry) => entry.form.length > tail.length && entry.form.startsWith(tail))) { cut = at; break; }
    }
    // A value that ends where the text ends, and needs a non-word character after it, waits for one.
    for (const pending of this.spans(plain, before, true)) if (pending.end === plain.length && !spans.some((span) => span.start === pending.start)) cut = Math.min(cut, pending.start);
    // Never inside a value that was found whole.
    for (const span of spans) if (span.start < cut && cut < span.end) cut = span.start;
    return cut;
  }

  /**
   * An edit made from a shown copy: each `[비밀: …]` of `edited` that the shown copy of `original`
   * produced gets back the value it hid there, in order (per name). Anything else stays as edited.
   */
  restore(original: string, edited: string): string {
    if (!this.forms.length || !original || !edited) return edited;
    const view = visible(original), plain = view?.plain ?? original;
    const hidden = new Map<string, string[]>();
    for (const span of this.spans(plain, "", true)) {
      const start = view ? view.at[span.start]! : span.start, end = view ? view.at[span.end - 1]! + 1 : span.end;
      hidden.set(span.label, [...(hidden.get(span.label) ?? []), original.slice(start, end)]);
    }
    let out = edited;
    for (const [label, values] of hidden) {
      let from = 0;
      for (const value of values) {
        const at = out.indexOf(label, from);
        if (at < 0) break;
        out = out.slice(0, at) + value + out.slice(at + label.length);
        from = at + value.length;
      }
    }
    return out;
  }

  /** A whole text with every value replaced. */
  text(text: string, before = ""): string {
    if (!this.forms.length || !text) return text;
    const view = visible(text), plain = view?.plain ?? text;
    const spans = this.spans(plain, before, true);
    return spans.length ? this.render(text, view, spans, plain.length) : text;
  }

  private walk(value: unknown): unknown {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) {
      let changed = false;
      const out = value.map((entry) => { const next = this.walk(entry); if (next !== entry) changed = true; return next; });
      return changed ? out : value;
    }
    if (value && typeof value === "object") {
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        const next = SKIPPED.test(key) ? entry : this.walk(entry);
        if (next !== entry) changed = true;
        out[key] = next;
      }
      return changed ? out : value;
    }
    return value;
  }

  /** What is kept: every text of an item (or anything else) scrubbed whole; the same object when nothing was found. */
  value<T>(item: T): T {
    if (!this.forms.length) return item;
    return this.walk(item) as T;
  }

  /**
   * What is broadcast for an item that was just kept (`kept`, from `raw`): while its text is still
   * being written, a tail that could begin a value is held back. `key`: one item of one conversation.
   */
  live<T>(key: string, raw: T, kept: T): T {
    const field = growing(raw);
    if (!field) {
      this.streams.delete(key);
      this.held.delete(key);
      return kept;
    }
    if (!this.forms.length && !this.streams.has(key)) return kept;
    const text = (raw as Record<string, unknown>)[field];
    if (typeof text !== "string") return kept;
    const view = visible(text), plain = view?.plain ?? text;
    const spans = this.spans(plain, "", false);
    const cut = this.cut(plain, spans, "");
    const emitted = this.render(text, view, spans, cut);
    const rawCut = view ? (cut < view.at.length ? view.at[cut]! : text.length) : cut;
    this.streams.set(key, { emitted, tail: text.slice(rawCut), before: text.slice(0, rawCut).slice(-1) });
    if (rawCut < text.length) this.held.add(key); else this.held.delete(key);
    return emitted === (kept as Record<string, unknown>)[field] ? kept : { ...kept, [field]: emitted };
  }

  /**
   * A piece of streaming text: what goes out live now, and the whole text to keep. Null with
   * nothing stored and no stream under way (the piece is kept and sent as it is). `current`: the
   * kept text of the item, when the stream starts here.
   */
  delta(key: string, piece: string, current: string): { live: string; whole: string } | null {
    if (!this.forms.length && !this.streams.has(key)) return null;
    const state = this.streams.get(key) ?? { emitted: current, tail: "", before: "" };
    this.streams.set(key, state);
    state.tail += piece;
    const view = visible(state.tail), plain = view?.plain ?? state.tail;
    const spans = this.spans(plain, state.before, false);
    const cut = this.cut(plain, spans, state.before);
    const out = this.render(state.tail, view, spans, cut);
    const rawCut = view ? (cut < view.at.length ? view.at[cut]! : state.tail.length) : cut;
    state.emitted += out;
    if (rawCut > 0) state.before = state.tail.slice(rawCut - 1, rawCut);
    state.tail = state.tail.slice(rawCut);
    if (state.tail) this.held.add(key); else this.held.delete(key);
    return { live: out, whole: state.emitted + this.text(state.tail, state.before) };
  }

  /** Whether a stream of this item is under way. */
  tracks(key: string): boolean {
    return this.streams.has(key);
  }

  /** The turn ended (or stopped, failed, or the engine exited): the items of this conversation whose live copy is behind. */
  release(prefix: string): string[] {
    const ids: string[] = [];
    for (const key of [...this.streams.keys()]) {
      if (!key.startsWith(prefix)) continue;
      if (this.held.delete(key)) ids.push(key.slice(prefix.length));
      this.streams.delete(key);
    }
    return ids;
  }
}
