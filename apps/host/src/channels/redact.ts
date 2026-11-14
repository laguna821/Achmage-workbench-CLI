// The one place that hides secrets before text is logged, stored as an error, written to the
// audit trail or sent to a chat: token shapes of the messengers, addresses that carry a token, and
// the values the channel holds (registered by name). Message bodies are not logged at all; this is
// for what slips into an error, an address or an engine's answer.
//
// Matching is done on the text with invisible characters (zero-width spaces and joiners, soft
// hyphens, direction marks) taken out, so a value split by one of them is still found; what is
// replaced is the stretch of the original text it covered, invisible characters included.

import { cutAt } from "./shape.ts";

// A Bot API file address carries the bot token in its path: the whole address goes.
const FILE_URL = /https?:\/\/[^\s"'<>]*\/file\/bot\d+:[A-Za-z0-9_-]{30,}[^\s"'<>]*/g;
const FILE_PATH = /file\/bot\d+:[A-Za-z0-9_-]{30,}[^\s"'<>]*/g;
const BOT_TOKEN = /\d+:[A-Za-z0-9_-]{30,}/g;
const SLACK_TOKEN = /\bxox[a-z]-[A-Za-z0-9-]{10,}/g;
const SLACK_APP_TOKEN = /\bxapp-[A-Za-z0-9-]{10,}/g;
// Secrets tools commonly print (an engine may show them in an answer). Each needs an unmistakable
// lead and a credential-shaped value, so ordinary words stay ("Bearer of …", "sk-ill",
// "Authorization: department-approval-required"). Where a pattern names a `secret` group, only that
// part is replaced and the rest of the line stays readable.
const KEY = "[A-Za-z0-9._~+/=-]";
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
/** `Authorization: Bearer|Basic|Token <value>`, also as a JSON key (`"Authorization": "Basic …"`). */
const AUTH_SCHEME = new RegExp(`\\bAuthorization"?\\s*:\\s*"?\\s*(?:Bearer|Basic|Token)\\s+(?<secret>${KEY}{12,})`, "dgi");
/** `Authorization: <value>` without a scheme word: only a long value mixing letters and digits. */
const AUTH_VALUE = new RegExp(`\\bAuthorization"?\\s*:\\s*"?(?<secret>(?=${KEY}*\\d)(?=${KEY}*[A-Za-z])${KEY}{24,})`, "dgi");
const BEARER = new RegExp(`\\bBearer\\s+(?<secret>${KEY}{16,})`, "dg");
const API_KEY = /\bsk-(?:[A-Za-z0-9]+-){0,3}[A-Za-z0-9_]{20,}/g;
const AWS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
const AWS_SECRET = /\baws_secret_access_key"?\s*[=:]\s*"?(?<secret>[A-Za-z0-9/+=]{40})/dgi;
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g;
const GOOGLE_KEY = /\bAIza[0-9A-Za-z_-]{35}/g;
/** `scheme://user:password@host`: the password only. */
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'<>]+:(?<secret>[^\s@/"'<>]+)@/dgi;
const SHAPES: [RegExp, string][] = [[FILE_URL, "[파일 주소]"], [FILE_PATH, "[파일 주소]"], [BOT_TOKEN, "[봇 토큰]"], [SLACK_APP_TOKEN, "[Slack 토큰]"], [SLACK_TOKEN, "[Slack 토큰]"],
  [PRIVATE_KEY, "[개인 키]"], [AUTH_SCHEME, "[인증 값]"], [AUTH_VALUE, "[인증 값]"], [BEARER, "[인증 값]"], [API_KEY, "[API 키]"], [AWS_KEY, "[API 키]"],
  [AWS_SECRET, "[비밀 키]"], [GITHUB_TOKEN, "[GitHub 토큰]"], [GOOGLE_KEY, "[API 키]"], [URL_PASSWORD, "[비밀번호]"]];
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤﻿]/;

type Span = { start: number; end: number; label: string };

/** The text without invisible characters, and where each of its characters was in the original. */
function visible(text: string): { plain: string; at: number[] } {
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

/** Replace the stretches found in the visible text; a stretch that overlaps one found before it is left to that one. */
function hide(text: string, find: (plain: string, taken: (start: number, end: number) => boolean) => Span[]): string {
  if (!text) return text;
  const { plain, at } = visible(text);
  const spans: Span[] = [];
  const taken = (start: number, end: number) => spans.some((span) => start < span.end && span.start < end);
  for (const span of find(plain, taken)) if (!taken(span.start, span.end)) spans.push(span);
  if (!spans.length) return text;
  spans.sort((a, b) => a.start - b.start);
  let out = "", from = 0;
  for (const span of spans) {
    const start = at[span.start]!, end = at[span.end - 1]! + 1;
    out += text.slice(from, start) + span.label;
    from = end;
  }
  return out + text.slice(from);
}

function shapes(plain: string, taken: (start: number, end: number) => boolean): Span[] {
  const found: Span[] = [];
  for (const [pattern, label] of SHAPES) {
    for (const match of plain.matchAll(pattern)) {
      const part = match.indices?.groups?.secret;
      const span = part ? { start: part[0], end: part[1], label } : { start: match.index, end: match.index + match[0].length, label };
      if (!taken(span.start, span.end) && !found.some((other) => span.start < other.end && other.start < span.end)) found.push(span);
    }
  }
  return found;
}

/** Token shapes and token-carrying addresses, hidden. */
export function redact(text: string): string {
  return hide(text, shapes);
}

/** Values shorter than this are not registered: hiding them would blank ordinary words. */
const MIN_VALUE = 8;

/**
 * The forms a value takes in text: as written, URL-encoded (either case of escape), hex, and
 * base64 / base64url — also inside the base64 of a longer text such as `user:value` (a Basic-auth
 * header), where only the part of it aligned to whole base64 groups is stable.
 */
function formsOf(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const encoded = encodeURIComponent(value);
  const forms = [value, encoded, encoded.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()), bytes.toString("hex"), bytes.toString("hex").toUpperCase()];
  for (const b64 of [bytes.toString("base64"), bytes.toString("base64url")]) forms.push(b64, b64.replace(/=+$/, ""));
  for (let shift = 0; shift < 3; shift += 1) {
    const whole = Math.floor((bytes.length - shift) / 3) * 3;
    if (whole < 6) continue;
    const aligned = bytes.subarray(shift, shift + whole);
    forms.push(aligned.toString("base64"), aligned.toString("base64url"));
  }
  return [...new Set(forms)].filter((form) => form.length >= MIN_VALUE);
}

/**
 * The shapes plus the values held for the channel, each hidden under the name it was given. A value
 * replaced under the same name (a new bot token) stays hidden, as "<name> (이전)".
 */
export class Redactor {
  private readonly values = new Map<string, string>();
  private readonly retired = new Map<string, string>();
  /** Every form of every value with its label, longest first. */
  private forms: [form: string, label: string][] = [];

  add(name: string, value: string) {
    if (value.length < MIN_VALUE) return;
    const before = this.values.get(name);
    if (before !== undefined && before !== value) this.retired.set(before, `${name} (이전)`);
    this.retired.delete(value);
    this.values.set(name, value);
    this.rebuild();
  }

  remove(name: string) {
    if (this.values.delete(name)) this.rebuild();
  }

  private rebuild() {
    const forms: [string, string][] = [];
    const named: [string, string][] = [...[...this.values].map(([name, value]): [string, string] => [value, `[비밀: ${name}]`]), ...[...this.retired].map(([value, name]): [string, string] => [value, `[비밀: ${name}]`])];
    for (const [value, label] of named) for (const form of formsOf(value)) forms.push([form, label]);
    this.forms = forms.sort((a, b) => b[0].length - a[0].length);
  }

  /** The stored values' forms a file is checked for (the 비밀 보관함's; VaultRedactor). The channel's own tokens are not among them. */
  stored(): string[] {
    return [];
  }

  apply(text: string): string {
    return hide(text, (plain, taken) => {
      const found: Span[] = [];
      const clash = (start: number, end: number) => taken(start, end) || found.some((span) => start < span.end && span.start < end);
      for (const [form, label] of this.forms) {
        for (let at = plain.indexOf(form); at >= 0; at = plain.indexOf(form, at + 1)) {
          if (!clash(at, at + form.length)) found.push({ start: at, end: at + form.length, label });
        }
      }
      return [...found, ...shapes(plain, clash)];
    });
  }

  /** An error as it may be logged or stored: its message and the messages of its causes. */
  error(error: unknown): string {
    const parts: string[] = [];
    for (let at: unknown = error, depth = 0; at && depth < 5; depth += 1) {
      parts.push(at instanceof Error ? at.message : String(at));
      at = at instanceof Error ? at.cause : null;
    }
    return cutAt(this.apply(parts.join(" ← ")), 500);
  }
}
