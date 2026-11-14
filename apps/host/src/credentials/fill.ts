import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { SHOWN, type DaemonAnswer, type HostPage } from "../browse-host.ts";
import { HttpError } from "../errors.ts";
import type { CredentialService, ToolAnswer } from "./service.ts";
import { askableHost, siteOf, siteRefusal, type SiteOrigin } from "./site.ts";
import type { CredentialSummary } from "./store.ts";

// `workbench-credential fill` (unit 9, design §6.4): the AI points, the gateway types. The AI names
// an entry and gives element references from its page snapshot; the gateway takes the values from
// the store and types them into the agent browser itself, over the CLI daemon's socket
// (browse-host.ts): never in a command line, never in anything the engine reads back. The AI hears
// `ok` and the page title, or `fail:<code>`. Only on the entry's own site (site.ts); a secret field
// only into a password input (a text input shows its value in every later snapshot and screenshot).
// `step` is the second factor and what only the person can do (a code, an approval in another app,
// a mail link, a step that needs the PC); the chat side is channels/login-chat.ts.

const answer = (code: string, extra = ""): ToolAnswer => ({ code: code === "ok" ? 0 : 1, stdout: `${code}\n${extra}`, stderr: "" });
const REF = /^(?:f\d+)?e\d+$/;
/** How long a one-time code or a mail link stays known to the scrubber after it was typed or opened. */
const ONCE_MS = 30 * 60_000;

/** What the gateway learns of an element before it types into it (nothing of its value). */
const PROBE = `(el) => JSON.stringify({ tag: el.tagName.toLowerCase(), type: String(el.getAttribute("type") || "").toLowerCase(), frame: /^https?:/.test(el.ownerDocument.location.href) ? el.ownerDocument.location.href : String(el.ownerDocument.defaultView && el.ownerDocument.defaultView.origin) })`;
const TOP = `() => location.href`;
const TITLE = `() => document.title`;

/** An `eval`'s raw result, read back to the value (a string the page made may come JSON-quoted once or twice). */
export function evalValue(text: string): unknown {
  let value: unknown = text.trim();
  for (let round = 0; round < 3 && typeof value === "string"; round += 1) {
    try { value = JSON.parse(value as string); } catch { break; }
  }
  return value;
}

export type StepKind = "code" | "approve" | "link" | "pc";
export type PcWhy = "captcha" | "passkey" | "app" | "security";
/** "'X' 로그인은 a에 저장되어 있습니다. b에서도 쓰게 할까요?": asked once per entry and host. */
export type HostQuestion = { id: string; sessionId: string; entryId: string; name: string; own: string; host: string };
export type LoginStep = { id: string; sessionId: string; name: string; site: string; kind: StepKind; ref?: string; submit?: string | null; label?: string; app?: string; why?: PcWhy };

/** The chat's part (channels/login-chat.ts): what is said, and the input for a code or a link. */
export type LoginChatSide = {
  /** Whether the conversation has a paired chat to ask in. */
  reaches(sessionId: string): boolean;
  /** The one message (with a picture of the page when it may be shown) and, for a code or a link, its input. "held": the chat is paused or locked, nothing was said. */
  askStep(step: LoginStep): Promise<"asked" | "held" | "refused">;
  /** The one question for a fill on another host ([이 주소도 허용] [안 함]). */
  askHost(question: HostQuestion): Promise<"asked" | "held" | "refused">;
  /** One line, once per key (a fill refused for another site, the browser that keeps no login). */
  notice(sessionId: string, key: string, text: string): Promise<void>;
  /** The record: a stored entry used (name, host, result; never a value). */
  used(sessionId: string, name: string, host: string, result: string): void;
};

export type LoginFillerOptions = {
  service: CredentialService;
  /** The session's agent page for the gateway's own commands, or why there is none (AgentBrowser.hostPage). */
  page: (sessionId: string) => HostPage | string;
  /** Where screenshots for the chat are made (removed after they are sent). */
  dataDir: string;
};

/** The words for what cannot be done from the phone (design §6.4 table). */
export const PC_ONLY: Record<PcWhy, string> = {
  captcha: "이 단계(그림·드래그 확인)는 사람이 화면에서 직접 풀어야 합니다.",
  passkey: "이 사이트는 패스키로만 로그인합니다. PC에서 한 번 로그인해 두면 다음부터는 이 채널이 이어서 씁니다.",
  app: "같은 휴대폰의 앱으로 넘어가는 로그인이라 PC 브라우저에서는 열 수 없습니다.",
  security: "보안 프로그램이나 가상 키패드를 쓰는 단계라 자동 입력이 막혀 있습니다.",
};

const INSTRUCTIONS = `- workbench-credential fill --name <name> --ref <field>=<element ref> [--ref …] [--submit <element ref>]
  After need answered ok, with the login page open in your Workbench browser (playwright-cli, Chromium): give the refs of the input fields from your latest snapshot, one --ref per stored field (for example --ref 아이디=e12 --ref 비밀번호=e15 --submit e20). The gateway types the stored values itself; you get ok and the page title, or fail:<code>. Take a new snapshot afterwards.
  fail:wrong_site / fail:insecure: the page is not the entry's site; never fill there. fail:handover_sent: the page is on another host and the person is asked whether this login may be used there; write one short status line and end your turn (a "[자동 이어 하기] …" request tells you the answer). fail:visible_field: a secret field is not a password input. fail:stale_ref: snapshot again and retry once. fail:needs_chromium / fail:browser_missing: the agent browser must be Chromium (installed) for logins; the phone chat was told where to switch it at the PC (without a phone chat, tell the person: '브라우저' under the input → '탐색 방식' Chromium, or '설치'); write one short line and end your turn, and go on when the person says '이어서'.
- workbench-credential step --name <name> --kind code --ref <element ref> [--submit <element ref>] [--label <what the site calls it>]
  A one-time code is asked (SMS, authenticator, mail code): the person gives it on the phone and the gateway types it. Never use need for a one-time code, an approval in another app or a mail link: nothing of them is stored. Also: --kind approve --app <앱 이름> (approve in another app), --kind link (a sign-in link sent by mail; the gateway opens it), --kind pc --why captcha|passkey|app|security (only possible at the PC). Each answers fail:handover_sent: write one short status line and end your turn (fail:chat_paused: the phone chat is paused; say so in one line and end your turn); a "[자동 이어 하기] …" request continues it (for --kind pc the person sends '이어서'). fail:no_chat: no phone chat; tell the person what to do in the browser window at the PC and end your turn.`;

/** How many distinct other hosts are asked about per conversation and entry. */
const HOST_QUESTIONS = 3;

export class LoginFiller {
  chat: LoginChatSide | null = null;
  private readonly options: LoginFillerOptions;
  private readonly steps = new Map<string, LoginStep>();
  private readonly questions = new Map<string, HostQuestion>();
  /** Hosts the person said no to, per conversation and entry: not asked again. */
  private readonly refusedHosts = new Set<string>();
  /** The hosts asked about per conversation and entry (round 2: at most HOST_QUESTIONS; then refused without asking). */
  private readonly askedHosts = new Map<string, Set<string>>();

  constructor(options: LoginFillerOptions) {
    this.options = options;
  }

  /** `fill` and `step` become subcommands of `workbench-credential`; their lines go into the tool's instructions. */
  install() {
    this.options.service.commands.set("fill", (sessionId, args) => this.fill(sessionId, args));
    this.options.service.commands.set("step", (sessionId, args) => this.step(sessionId, args));
    return INSTRUCTIONS;
  }

  private get service() { return this.options.service; }

  /** The site a stored entry is for; null when it has none (a login with no site is typed nowhere). */
  static siteOf(entry: Pick<CredentialSummary, "site" | "origin">): SiteOrigin | null {
    return entry.origin ? siteOf(entry.origin) : entry.site ? siteOf(entry.site) : null;
  }

  private async page(sessionId: string): Promise<HostPage | string> {
    const page = this.options.page(sessionId);
    if (page === "browser_missing") await this.chat?.notice(sessionId, `login-chromium:${sessionId}`, "PC의 에이전트 브라우저(Chromium)가 아직 설치되어 있지 않습니다. PC의 Workbench에서 대화 입력창 아래 '브라우저' → '설치'를 눌러 주세요(약 200MB를 받습니다). 한 번만 하면 됩니다. 끝나면 '이어서'라고 보내 주세요.").catch(() => undefined);
    if (page === "needs_chromium") await this.chat?.notice(sessionId, `login-chromium:${sessionId}`, "로그인을 기억하며 쓰려면 PC의 에이전트 브라우저가 Chromium이어야 합니다. PC의 Workbench에서 대화 입력창 아래 '브라우저' → '탐색 방식'을 'Chromium'으로 바꿔 주세요. 한 번만 하면 됩니다. 바꾼 뒤 '이어서'라고 보내 주세요.").catch(() => undefined);
    return page;
  }

  /** Where an element is and what it is, before anything is typed into it. */
  private async probe(page: HostPage, ref: string): Promise<{ tag: string; type: string; frame: string } | null> {
    const result = await page.run({ _: ["eval", PROBE, ref] }, true);
    if (result.error) return null;
    const value = evalValue(result.text) as { tag?: unknown; type?: unknown; frame?: unknown };
    return value && typeof value === "object" && typeof value.tag === "string" && typeof value.frame === "string" ? { tag: value.tag, type: String(value.type ?? ""), frame: value.frame } : null;
  }

  private async top(page: HostPage): Promise<string | null> {
    const result = await page.run({ _: ["eval", TOP] }, true);
    const value = result.error ? null : evalValue(result.text);
    return typeof value === "string" ? value : null;
  }

  /** The page and each element are on the site (the top page too: a right form framed by another site is refused). */
  private async onSite(page: HostPage, site: SiteOrigin, refs: string[], hosts: readonly string[] = []): Promise<{ code: "wrong_site" | "insecure" | "stale_ref"; host: string; ask?: string | null } | { probes: Map<string, { tag: string; type: string }> }> {
    const top = await this.top(page);
    if (!top) return { code: "stale_ref", host: "" };
    const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url.slice(0, 40); } };
    const refused = siteRefusal(site, top, hosts);
    if (refused) return { code: refused, host: hostOf(top), ask: refused === "wrong_site" ? askableHost(site, top) : null };
    const probes = new Map<string, { tag: string; type: string }>();
    for (const ref of refs) {
      const probe = await this.probe(page, ref);
      if (!probe) return { code: "stale_ref", host: "" };
      const frame = siteRefusal(site, probe.frame, hosts);
      if (frame) return { code: frame, host: hostOf(probe.frame), ask: frame === "wrong_site" ? askableHost(site, probe.frame) : null };
      probes.set(ref, probe);
    }
    return { probes };
  }

  private async refusedSite(sessionId: string, entry: CredentialSummary, code: string, host: string) {
    this.chat?.used(sessionId, entry.name, host, code);
    if (code === "wrong_site" || code === "insecure") {
      const shown = host.replace(/\./g, "․").slice(0, 60);
      await this.chat?.notice(sessionId, `login-site:${sessionId}:${entry.id}`, `'${entry.name}' 로그인을 다른 곳(${shown})에 넣으려 해서 막았습니다. 저장한 사이트에서만 넣습니다.`).catch(() => undefined);
    }
  }

  /**
   * Another real host (not a look-alike, not an address): the person decides, once per entry and
   * host. Null when it is not asked (no chat, said no before): the fill is then refused as any other.
   */
  private async askHost(sessionId: string, entry: CredentialSummary, site: SiteOrigin, host: string): Promise<string | null> {
    if (!this.chat?.reaches(sessionId) || this.refusedHosts.has(`${sessionId}|${entry.id}|${host}`)) return null;
    if ([...this.questions.values()].some((question) => question.entryId === entry.id && question.host === host)) return "fail:handover_sent";
    // A prompt-injected AI walking through hosts gets at most this many questions per conversation and entry.
    const asked = this.askedHosts.get(`${sessionId}|${entry.id}`) ?? new Set<string>();
    if (!asked.has(host) && asked.size >= HOST_QUESTIONS) return null;
    this.askedHosts.set(`${sessionId}|${entry.id}`, asked.add(host));
    const question: HostQuestion = { id: `h_${randomBytes(9).toString("base64url")}`, sessionId, entryId: entry.id, name: entry.name, own: site.host, host };
    this.questions.set(question.id, question);
    const sent = await this.chat.askHost(question);
    if (sent !== "asked") this.questions.delete(question.id);
    this.chat.used(sessionId, entry.name, host, "ask_host");
    return sent === "asked" ? "fail:handover_sent" : sent === "held" ? "fail:chat_paused" : null;
  }

  /** The person's answer to a host question: allowed (the entry keeps the host) or not (not asked again in this conversation). */
  answerHost(id: string, allow: boolean): HostQuestion | null {
    const question = this.questions.get(id);
    if (!question) return null;
    this.questions.delete(id);
    if (allow) {
      try { this.service.store.allowHost(question.entryId, question.host); } catch { return null; }
    } else this.refusedHosts.add(`${question.sessionId}|${question.entryId}|${question.host}`);
    return question;
  }

  async fill(sessionId: string, args: string[]): Promise<ToolAnswer> {
    let name = "", submit: string | null = null;
    const refs: [string, string][] = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!, next = args[index + 1];
      const inline = /^--(name|ref|submit)=(.*)$/s.exec(arg);
      const [flag, value] = inline ? [inline[1]!, inline[2]!] : /^--(name|ref|submit)$/.test(arg) && next !== undefined ? [arg.slice(2), (index += 1, next)] : [null, null];
      if (!flag || value === null) return answer("fail:bad_arguments");
      if (flag === "name") name = value;
      else if (flag === "submit") submit = value;
      else {
        const at = value.lastIndexOf("=");
        if (at <= 0) return answer("fail:bad_arguments");
        refs.push([value.slice(0, at).trim(), value.slice(at + 1).trim()]);
      }
    }
    if (!name || !refs.length || refs.length > 6 || refs.some(([, ref]) => !REF.test(ref)) || (submit !== null && !REF.test(submit))) return answer("fail:bad_arguments");
    const entry = this.service.store.find(name);
    if (!entry) return answer("fail:not_stored");
    const fields = refs.map(([field]) => entry.fields.find((other) => other.toLocaleLowerCase("ko") === field.toLocaleLowerCase("ko")));
    if (fields.some((field) => !field) || new Set(fields).size !== fields.length) return answer("fail:unknown_field");
    const site = LoginFiller.siteOf(entry);
    if (!site) return answer("fail:no_site");
    const page = await this.page(sessionId);
    if (typeof page === "string") return answer(`fail:${page}`);
    const checked = await this.onSite(page, site, [...refs.map(([, ref]) => ref), ...(submit ? [submit] : [])], entry.hosts);
    if ("code" in checked) {
      if (checked.ask) {
        const asked = await this.askHost(sessionId, entry, site, checked.ask);
        if (asked) return answer(asked);
      }
      if (checked.code !== "stale_ref") await this.refusedSite(sessionId, entry, checked.code, checked.host);
      return answer(`fail:${checked.code}`);
    }
    for (const [index, [, ref]] of refs.entries()) {
      const probe = checked.probes.get(ref)!;
      if (!["input", "textarea"].includes(probe.tag)) return answer("fail:not_a_field");
      if (entry.secret[fields[index]!] !== false && !(probe.tag === "input" && probe.type === "password")) return answer("fail:visible_field");
    }
    // 매번 묻기: asked first, as `need` asks (the leave is spent by the use below).
    if (entry.askEachTime) {
      const asked = await this.service.run(sessionId, ["need", "--name", entry.name, "--kind", entry.kind, "--fields", fields.join(",")]);
      if (asked.code !== 0) return asked;
    }
    let values: Record<string, string>;
    try {
      values = await this.service.use(entry.name, sessionId);
    } catch (error) {
      if (error instanceof HttpError && error.code === "credentials_locked") {
        await this.chat?.notice(sessionId, `cred-locked:${sessionId}`, "PC의 보안 저장소가 잠겨 있어 저장한 값을 쓸 수 없습니다. PC에서 잠금을 풀면 이어서 할 수 있습니다.").catch(() => undefined);
        return answer("fail:keyring_locked");
      }
      return answer(error instanceof HttpError && error.code === "credential_needs_leave" ? "fail:handover_waiting" : "fail:unavailable");
    }
    const host = site.host;
    // Marked on the window first: its next snapshot prints the field's value, a password's too.
    const secrets = refs.map((_ref, index) => fields[index]!).filter((field) => entry.secret[field] !== false).map((field) => values[field]).filter((value): value is string => typeof value === "string" && value.length > 0);
    if (secrets.length) page.typed(entry.name, secrets);
    for (const [index, [, ref]] of refs.entries()) {
      const value = values[fields[index]!];
      if (value === undefined) { this.chat?.used(sessionId, entry.name, host, "missing_value"); return answer("fail:missing_value"); }
      const typed = await page.run({ _: ["fill", ref, value] });
      if (typed.error) { this.chat?.used(sessionId, entry.name, host, "fill_failed"); return answer(failure(typed)); }
    }
    if (submit) {
      const pressed = await page.run({ _: ["click", submit] });
      if (pressed.error) { this.chat?.used(sessionId, entry.name, host, "submit_failed"); return answer(failure(pressed, "fail:submit_failed")); }
    }
    this.chat?.used(sessionId, entry.name, host, "ok");
    return answer("ok", await this.title(page));
  }

  /** "제목: …" of the page now, hidden and cut (it is the page's own text). */
  private async title(page: HostPage): Promise<string> {
    const result = await page.run({ _: ["eval", TITLE] }, true);
    const value = result.error ? null : evalValue(result.text);
    if (typeof value !== "string" || !value.trim()) return "";
    return `제목: ${[...this.service.scrubber.text(value).replace(/\s+/g, " ").trim()].slice(0, 80).join("")}\n`;
  }

  // Second factors and what only the person can do

  async step(sessionId: string, args: string[]): Promise<ToolAnswer> {
    const given = new Map<string, string>();
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      const inline = /^--([a-z]+)=(.*)$/s.exec(arg);
      if (inline) { given.set(inline[1]!, inline[2]!); continue; }
      if (!/^--[a-z]+$/.test(arg) || index + 1 >= args.length) return answer("fail:bad_arguments");
      given.set(arg.slice(2), args[index + 1]!);
      index += 1;
    }
    const kind = given.get("kind") as StepKind | undefined;
    const allowed: Record<StepKind, string[]> = { code: ["name", "kind", "ref", "submit", "label"], approve: ["name", "kind", "app"], link: ["name", "kind"], pc: ["name", "kind", "why"] };
    if (!kind || !allowed[kind] || [...given.keys()].some((key) => !allowed[kind].includes(key))) return answer("fail:bad_arguments");
    const entry = this.service.store.find(given.get("name") ?? "");
    if (!entry) return answer("fail:not_stored");
    const site = LoginFiller.siteOf(entry);
    if (!site) return answer("fail:no_site");
    const clean = (value: string | undefined, max: number) => [...(value ?? "").replace(/[\p{Cc}\p{Cf}]+/gu, "").replace(/\s+/g, " ").trim()].slice(0, max).join("");
    const step: LoginStep = { id: `s_${randomBytes(9).toString("base64url")}`, sessionId, name: entry.name, site: entry.site, kind };
    if (kind === "code") {
      const ref = given.get("ref") ?? "", submit = given.get("submit") ?? null;
      if (!REF.test(ref) || (submit !== null && !REF.test(submit))) return answer("fail:bad_arguments");
      step.ref = ref; step.submit = submit; step.label = clean(given.get("label"), 20) || "인증번호";
      // Asked only for a field on the entry's own site (a code typed elsewhere is a relayed login).
      const page = await this.page(sessionId);
      if (typeof page === "string") return answer(`fail:${page}`);
      const checked = await this.onSite(page, site, [ref, ...(submit ? [submit] : [])], entry.hosts);
      if ("code" in checked) {
        if (checked.code !== "stale_ref") await this.refusedSite(sessionId, entry, checked.code, checked.host);
        return answer(`fail:${checked.code}`);
      }
    }
    if (kind === "approve") step.app = clean(given.get("app"), 20) || "인증";
    if (kind === "pc") {
      const why = given.get("why") as PcWhy | undefined;
      if (!why || !PC_ONLY[why]) return answer("fail:bad_arguments");
      step.why = why;
    }
    if (!this.chat?.reaches(sessionId)) return answer("fail:no_chat");
    this.steps.set(step.id, step);
    const asked = await this.chat.askStep(step);
    if (asked !== "asked") this.steps.delete(step.id);
    if (asked === "refused") return answer("fail:unavailable");
    if (asked === "held") return answer("fail:chat_paused");
    return answer("fail:handover_sent");
  }

  stepOf(id: string): LoginStep | null {
    return this.steps.get(id) ?? null;
  }

  /** A step is over (given, cancelled, run out): a code's mark on the window and in the scrubber ends with it. */
  endStep(id: string) {
    const step = this.steps.get(id);
    this.steps.delete(id);
    if (step?.kind !== "code") return;
    this.service.scrubber.remove(`once:${id}`);
    const page = this.options.page(step.sessionId);
    if (typeof page !== "string") page.forget(id);
  }

  /**
   * A one-time code from the chat, typed by the gateway where the step said, on the entry's own site.
   * Never stored; a long one is known to the scrubber for a while (the next snapshot shows the field).
   */
  async typeOnce(step: LoginStep, value: string): Promise<"ok" | string> {
    const entry = this.service.store.find(step.name);
    const site = entry ? LoginFiller.siteOf(entry) : null;
    if (!entry || !site || !step.ref) return "not_stored";
    const page = await this.page(step.sessionId);
    if (typeof page === "string") return page;
    const checked = await this.onSite(page, site, [step.ref, ...(step.submit ? [step.submit] : [])], entry.hosts);
    if ("code" in checked) {
      if (checked.code !== "stale_ref") await this.refusedSite(step.sessionId, entry, checked.code, checked.host);
      return checked.code;
    }
    this.remember(step.id, step.name, value);
    page.typed(step.name, [value], step.id);
    const typed = await page.run({ _: ["fill", step.ref, value] });
    if (typed.error) return failure(typed).slice(5);
    if (step.submit) {
      const pressed = await page.run({ _: ["click", step.submit] });
      if (pressed.error) return "submit_failed";
    }
    this.chat?.used(step.sessionId, entry.name, site.host, "code");
    return "ok";
  }

  /** A sign-in link from the mail, opened by the gateway in the same browser: only a link of the entry's own site. */
  async openLink(step: LoginStep, link: string): Promise<"ok" | string> {
    const entry = this.service.store.find(step.name);
    const site = entry ? LoginFiller.siteOf(entry) : null;
    if (!entry || !site) return "not_stored";
    const refused = siteRefusal(site, link.trim(), entry.hosts);
    if (refused) return refused;
    const page = await this.page(step.sessionId);
    if (typeof page === "string") return page;
    this.remember(step.id, step.name, link.trim());
    page.typed(step.name, [link.trim()]);
    const went = await page.run({ _: ["goto", link.trim()] });
    if (went.error) return "open_failed";
    this.chat?.used(step.sessionId, entry.name, site.host, "link");
    return "ok";
  }

  /** Known to the scrubber for a while (a code: until its step ends; a code under 8 characters is not looked for: the scrubber's rule). */
  private remember(id: string, name: string, value: string) {
    this.service.scrubber.set(`once:${id}`, name, [value]);
    setTimeout(() => this.service.scrubber.remove(`once:${id}`), ONCE_MS).unref();
  }

  /** A picture whose send was still owed is not kept past an hour (also called by the chat's tick, M11). */
  sweepPictures() {
    const dir = join(this.options.dataDir, "credential-tool", "pictures");
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) { try { if (statSync(join(dir, name)).mtimeMs < Date.now() - 60 * 60_000) rmSync(join(dir, name), { force: true }); } catch { /* Gone. */ } }
  }

  /**
   * A picture of the agent page for the chat, taken by the gateway: only when the page is on the
   * site asked about, and never while a stored value shows as text (an input other than a password
   * input, or the page's text) nor, while a typed value is live, when part of the page could not be
   * read ("withheld": the chat says so). The caller removes the file after sending it.
   */
  async picture(sessionId: string, given: string): Promise<string | "withheld" | null> {
    const site = siteOf(given);
    const page = this.options.page(sessionId);
    if (!site || typeof page === "string") return null;
    const top = await this.top(page);
    if (!top || siteRefusal(site, top) === "wrong_site") return null;
    const shown = await page.run({ _: ["eval", SHOWN] }, true);
    if (shown.error) return null;
    const read = evalValue(shown.text);
    const text = typeof read === "object" ? JSON.stringify(read) : shown.text;
    if (this.service.scrubber.text(text) !== text || page.hide(text) !== text) return null;
    // While a typed value is live, a frame or shadow root the check could not read may show it (I9).
    if (read && typeof read === "object" && Number((read as { blind?: unknown }).blind) > 0 && page.live()) return "withheld";
    const dir = join(this.options.dataDir, "credential-tool", "pictures");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.sweepPictures();
    const path = join(dir, `${randomBytes(8).toString("hex")}.png`);
    const taken = await page.run({ _: ["screenshot"], filename: path });
    try {
      if (taken.error || !existsSync(path) || statSync(path).size > 9 * 1024 * 1024) { rmSync(path, { force: true }); return null; }
    } catch { return null; }
    return path;
  }
}

/** A fixed code for a failed command (its text is the daemon's and may repeat the value: never passed on). */
function failure(result: DaemonAnswer, otherwise = "fail:fill_failed"): string {
  if (/not found in the current page snapshot|Ref \S+ not found/i.test(result.text)) return "fail:stale_ref";
  if (result.text === "no_daemon" || result.text === "closed") return "fail:no_page";
  if (result.text === "timeout") return "fail:timeout";
  return otherwise;
}
