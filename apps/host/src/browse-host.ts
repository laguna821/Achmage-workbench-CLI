import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

// The gateway's own hand on the agent browser (unit 9: a stored login typed by the host). Engines
// drive the browser through the Playwright CLI, one process per command, whose arguments any
// program of the same user can read (/proc/<pid>/cmdline). A value must not go that way. The CLI
// itself is only a client: each command goes as one JSON line over a local socket to the session's
// daemon, which holds the browser. The gateway speaks that line itself, in its own process: no
// process is started, nothing is written to disk, and the value travels gateway → socket → daemon
// → browser (CDP pipe). The daemon's answer (which may repeat the value, "…fill('…')") is read here
// only and dropped by the caller.

/** One command as the daemon reads it (the CLI's parsed arguments): positionals in `_`, flags by name. */
export type DaemonArgs = { _: string[] } & Record<string, string | boolean | string[]>;
export type DaemonAnswer = { error: boolean; text: string };

/** The page of one agent session, for the gateway's own commands. */
export type HostPage = {
  /** One command, one at a time with the session's own. `raw`: only the result (an `eval`'s value). */
  run(args: DaemonArgs, raw?: boolean): Promise<DaemonAnswer>;
  /**
   * Values the gateway types into this window, named by their entry: from now on hidden in all
   * the window answers (engines, snapshot files, approval cards), whatever their length (see
   * `hideTyped`). A page's snapshot prints an input's value, a password input's too, and the
   * scrubber does not look for values under 8 characters. `key`: the mark ends with `forget(key)`
   * (a one-time code's step); without one it lasts while the window does (at most 30 minutes).
   */
  typed(label: string, values: string[], key?: string): void;
  /** The marks typed under this key end. */
  forget(key: string): void;
  /** Whether a value typed into this window is still marked (a picture then needs the whole page readable). */
  live(): boolean;
  /** Text from this window as anything but the gateway may see it (the scrubber, then the typed values). */
  hide(text: string): string;
};

/**
 * What a picture of the page would show as text: every input's value except password inputs', and
 * the page's text, also inside open shadow roots and frames the page can read. `blind`: frames it
 * cannot read (another origin) and defined custom elements with no open shadow root (a closed one
 * cannot be read): while a typed value is live, a picture of such a page is not taken (fail closed).
 */
export const SHOWN = `() => {
  const values = [], texts = [];
  let blind = 0;
  const textOf = (node) => (node && (typeof node.innerText === "string" ? node.innerText : node.textContent)) || "";
  const visit = (root, depth) => {
    for (const el of root.querySelectorAll("*")) {
      const tag = el.localName;
      if ((tag === "input" && String(el.getAttribute("type") || "").toLowerCase() !== "password") || tag === "textarea") values.push(String(el.value));
      if (el.shadowRoot) { texts.push(el.shadowRoot.textContent || ""); visit(el.shadowRoot, depth); }
      else if (tag.includes("-") && window.customElements && window.customElements.get(tag)) blind += 1;
      if (tag === "iframe" || tag === "frame" || tag === "object" || tag === "embed") {
        let doc = null;
        try { doc = el.contentDocument; } catch (error) { doc = null; }
        if (doc && doc.documentElement && depth < 5) { texts.push(textOf(doc.body)); visit(doc, depth + 1); }
        else if (tag === "iframe" || tag === "frame" || el.getAttribute("data") || el.getAttribute("src")) blind += 1;
      }
    }
  };
  texts.push(textOf(document.body));
  visit(document, 0);
  return JSON.stringify({ values, text: texts.join("\\n").slice(0, 200000), blind });
}`;

/** A typed value is hidden inside other text only from this length on and when not all digits. */
const LOOSE_MIN = 6;
const FIELD_LINE = /^(\s*-\s*(?:textbox|searchbox|combobox|spinbutton)\b.*?\]:\s?)(.+)$/gm;
const REF = /\[ref=[^\]\s]*\]/g;

const loose = (value: string) => value.length >= LOOSE_MIN && !/^\d+$/.test(value);
/** A field's or a line's value as written ("…" when the snapshot or an eval quoted it). */
const bare = (text: string) => {
  const trimmed = text.trim();
  if (/^".*"$/.test(trimmed)) { try { const value = JSON.parse(trimmed) as unknown; if (typeof value === "string") return value; } catch { /* As written. */ } }
  return trimmed;
};

/** What a field's value part holds once the quotes (escaped or not) and a trailing comma are taken off. */
function valuePart(rest: string): string {
  let part = rest.trim();
  for (let round = 0; round < 4; round += 1) {
    const next = part.replace(/,$/, "").replace(/^\\?"/, "").replace(/\\?"$/, "").trim();
    if (next === part) break;
    part = next;
  }
  return part;
}

/** How deep JSON inside a JSON string is decoded (round 4, ruling P4). */
const JSON_DEPTH = 4;

/**
 * Structured output judged decoded (round 3, ruling E; all the way down, round 4, ruling P4): when
 * the text is JSON (one document, or one per line), every string in it is decoded; a string that is
 * itself a JSON object or array is judged the same way (to depth 4) and encoded again; a string, a
 * number's text or a key that is exactly a secret (`exact` names it) is replaced whole; any other
 * string goes through `rule` (the text rule); then it is written again in the same layout. Lines of
 * a text that are JSON documents of their own (a CLI heading above a quoted eval result) are judged
 * so too, the others get the rule. Null when no part of the text is JSON (the caller applies the rule).
 */
export function hideDecoded(text: string, rule: (text: string) => string, exact: (text: string) => string | null): string | null {
  const parse = (doc: string): { value: unknown } | null => {
    const trimmed = doc.trim();
    if (!/^[[{"]/.test(trimmed)) return null;
    try { return { value: JSON.parse(trimmed) as unknown }; } catch { return null; }
  };
  const walk = (value: unknown, depth: number, mark: { changed: boolean }): unknown => {
    if (typeof value === "string") {
      const hit = exact(value) ?? exact(value.trim());
      if (hit !== null) { mark.changed = true; return hit; }
      // A string that is itself JSON (JSON.stringify inside an eval): judged decoded, encoded again.
      const inner = depth < JSON_DEPTH && /^\s*[[{]/.test(value) ? parse(value) : null;
      if (inner && inner.value && typeof inner.value === "object") {
        const innerMark = { changed: false };
        const out = walk(inner.value, depth + 1, innerMark);
        if (innerMark.changed) { mark.changed = true; return JSON.stringify(out, null, /^[[{]\s*\n([ \t]+)/.exec(value.trim())?.[1]); }
        return value;
      }
      const next = rule(value);
      if (next !== value) mark.changed = true;
      return next;
    }
    if (typeof value === "number") {
      const hit = exact(String(value));
      if (hit !== null) { mark.changed = true; return hit; }
      return value;
    }
    if (Array.isArray(value)) return value.map((entry) => walk(entry, depth, mark));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
        const hidden = exact(key);
        if (hidden !== null) mark.changed = true;
        return [hidden ?? key, walk(entry, depth, mark)];
      }));
    }
    return value;
  };
  const one = (doc: string): { out: string; changed: boolean } | null => {
    const parsed = parse(doc);
    if (!parsed) return null;
    const trimmed = doc.trim();
    const mark = { changed: false };
    const out = walk(parsed.value, 0, mark);
    if (!mark.changed) return { out: doc, changed: false };
    const indent = /^[[{]\s*\n([ \t]+)/.exec(trimmed)?.[1];
    const start = doc.indexOf(trimmed);
    return { out: `${doc.slice(0, start)}${JSON.stringify(out, null, indent)}${doc.slice(start + trimmed.length)}`, changed: true };
  };
  const whole = one(text);
  if (whole) return whole.out;
  // JSON lines, or a text some lines of which are JSON documents of their own.
  const lines = text.split("\n");
  const done = lines.map((line) => (line.trim() ? one(line) : { out: line, changed: false }));
  if (!done.some((entry) => entry && entry.out.trim())) return null;
  if (!done.some((entry, index) => entry && lines[index]!.trim())) return null;
  return done.map((entry, index) => entry?.out ?? rule(lines[index]!)).join("\n");
}

/**
 * Text with the values typed into a window hidden. Any value: a field's value in a snapshot line
 * that holds it (a short or all-digit one only when it IS the field's value), and a line that is
 * the value alone (an `eval` result). A value of 6+ characters that is not all digits: anywhere,
 * except inside an element ref (the AI must still be able to point at it). A PIN or a code is not
 * hidden in running text: the year, a phone number or an order number on a page stays readable.
 */
export function hideTyped(text: string, typed: { label: string; value: string }[]): string {
  const real = typed.filter((entry) => entry.value.length > 0);
  if (!real.length) return text;
  const label = (entry: { label: string }) => `[비밀: ${entry.label}]`;
  let out = text.replace(FIELD_LINE, (line, head: string, value: string) => {
    const hit = real.find((entry) => (loose(entry.value) ? value.includes(entry.value) : bare(value) === entry.value));
    return hit ? `${head}${label(hit)}` : line;
  });
  out = out.split("\n").map((line) => {
    const hit = real.find((entry) => bare(line) === entry.value);
    if (hit) return line.replace(line.trim(), label(hit));
    // A field's value part (after a colon: "pin": "48291", or an escaped `]: \"48291\"` inside text
    // that only looks like JSON) that is exactly a live value (round 3, ruling E).
    for (let at = line.indexOf(":"); at >= 0; at = line.indexOf(":", at + 1)) {
      const rest = line.slice(at + 1);
      const part = valuePart(rest);
      const entry = part ? real.find((typed) => typed.value === part) : undefined;
      if (entry) return `${line.slice(0, at + 1)}${rest.replace(entry.value, label(entry))}`;
    }
    return line;
  }).join("\n");
  // A short or all-digit live value (round 4, ruling P4): any whole token (split on what is not a
  // letter or digit) exactly equal to it is hidden in plain text too, outside element refs.
  const short = real.filter((entry) => !loose(entry.value));
  if (short.length) {
    const refs = out.match(REF) ?? [];
    const token = (entry: { value: string }) => new RegExp(`(?<![A-Za-z0-9])${entry.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "g");
    out = out.split(REF).map((part) => short.reduce((hidden, entry) => hidden.replace(token(entry), label(entry)), part)).reduce((joined, part, index) => joined + (index ? refs[index - 1]! : "") + part, "");
  }
  const long = real.filter((entry) => loose(entry.value)).sort((a, b) => b.value.length - a.value.length);
  if (!long.length) return out;
  // Refs are kept as they are: the text between them is hidden.
  const refs = out.match(REF) ?? [];
  return out.split(REF).map((part) => long.reduce((hidden, entry) => hidden.split(entry.value).join(label(entry)), part)).reduce((joined, part, index) => joined + (index ? refs[index - 1]! : "") + part, "");
}

/** Where the CLI keeps its daemons' session files (as the CLI computes it). */
export function daemonBase(): string {
  if (process.env.PWTEST_DAEMON_SESSION_DIR) return process.env.PWTEST_DAEMON_SESSION_DIR;
  const cache = process.platform === "darwin" ? join(homedir(), "Library", "Caches")
    : process.platform === "win32" ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
      : process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cache, "ms-playwright", "daemon");
}

/**
 * The socket of the daemon that runs this session on this profile (another profile's same-named
 * session is not it). `sockets`: the gateway's own socket folder (inside its data folder, 0700,
 * given to the CLI as PWTEST_SOCKETS_DIR): a session file naming a socket anywhere else, or a
 * socket that is not this user's, is not the gateway's daemon.
 */
export function daemonSocket(name: string, profile: string, sockets?: string): string | null {
  const base = daemonBase();
  let folders: string[];
  try { folders = readdirSync(base); } catch { return null; }
  for (const folder of folders) {
    try {
      const config = JSON.parse(readFileSync(join(base, folder, `${name}.session`), "utf8")) as { socketPath?: unknown; browser?: { userDataDir?: unknown } };
      if (config.browser?.userDataDir !== profile || typeof config.socketPath !== "string") continue;
      if (sockets && !ownSocket(config.socketPath, sockets)) continue;
      return config.socketPath;
    } catch { /* Not in this folder. */ }
  }
  return null;
}

function ownSocket(path: string, sockets: string): boolean {
  if (process.platform === "win32") return true;
  if (!resolve(path).startsWith(resolve(sockets) + sep)) return false;
  try {
    const found = lstatSync(path);
    return found.isSocket() && (typeof process.getuid !== "function" || found.uid === process.getuid());
  } catch { return false; }
}

/** One command over the daemon's socket; its answer, or an error (no daemon, closed, too slow). */
export function daemonRun(socketPath: string, args: DaemonArgs, options: { cwd: string; raw?: boolean; timeoutMs?: number }): Promise<DaemonAnswer> {
  return new Promise((done) => {
    let buffer = "";
    let settled = false;
    const finish = (answer: DaemonAnswer) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); done(answer); };
    const socket = connect(socketPath, () => {
      socket.write(`${JSON.stringify({ id: 1, method: "run", params: { args, cwd: options.cwd, ...(options.raw ? { raw: true } : {}) } })}\n`);
    });
    const timer = setTimeout(() => finish({ error: true, text: "timeout" }), options.timeoutMs ?? 30_000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const message = JSON.parse(buffer.slice(0, end)) as { id?: unknown; error?: unknown; result?: { isError?: unknown; text?: unknown } };
        if (message.error !== undefined) finish({ error: true, text: String(message.error) });
        else finish({ error: message.result?.isError === true, text: typeof message.result?.text === "string" ? message.result.text : "" });
      } catch {
        finish({ error: true, text: "bad_answer" });
      }
    });
    socket.on("error", () => finish({ error: true, text: "no_daemon" }));
    socket.on("close", () => finish({ error: true, text: "closed" }));
  });
}

/** A session's page for the gateway: its daemon found again for each command (a reopened window has a new one). */
export function hostPageOf(name: string, profile: string, cwd: string, serial: <T>(work: () => Promise<T>) => Promise<T>, window: { typed: HostPage["typed"]; forget: HostPage["forget"]; live?: HostPage["live"]; hide: HostPage["hide"]; mark?: () => Map<string, string>; files?: (text: string, marks?: Map<string, string>) => void | Promise<void>; timedOut?: (since: number) => void; sockets?: string; timeoutMs?: number } = { typed: () => undefined, forget: () => undefined, hide: (text) => text }): HostPage {
  return {
    run: (args, raw = false) => serial(async () => {
      const socket = daemonSocket(name, profile, window.sockets);
      if (!socket) return { error: true, text: "no_daemon" };
      const since = Date.now();
      const marks = window.mark?.();
      const answer = await daemonRun(socket, args, { cwd, raw, ...(window.timeoutMs ? { timeoutMs: window.timeoutMs } : {}) });
      // The daemon writes a snapshot file after a click or a move; the field it shows may hold a typed
      // value. Every file it wrote or changed in the output folder is hidden, linked or not.
      await window.files?.(answer.text, marks);
      // Its late answer (and the file it links) never comes back here: the files it may write are swept.
      if (answer.error && answer.text === "timeout") window.timedOut?.(since);
      return answer;
    }),
    typed: window.typed,
    forget: window.forget,
    live: window.live ?? (() => false),
    hide: window.hide,
  };
}
