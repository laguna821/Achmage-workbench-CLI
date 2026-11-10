import { createHash, randomUUID } from "node:crypto";
import type { BrowserAction, BrowserControl, BrowserDriverPoll, BrowserDriverReply, BrowserJob, BrowserJobResult, BrowserList, BrowserObservation, BrowserPage, BrowserPageCreate, BrowserProfile, Session } from "@workbench/contracts";
import type { Store } from "./store.ts";
import { HttpError } from "./errors.ts";

type Receipt = { job: BrowserJob; hash: string; status: "queued" | "dispatched" | "completed" | "rejected" | "outcome_unknown"; result: BrowserJobResult | null };
type Waiter = { resolve: (result: BrowserJobResult) => void; timer: NodeJS.Timeout; promise: Promise<BrowserJobResult> };
type Hooks = { workspace(id: string): { workId: string }; session(id: string): Session; interrupted(sessionId: string, reason: string): void };
const key = "shared-browser:v1", receiptKey = "shared-browser-command:";
const idOk = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,160}$/.test(value);
const fail = (code: string, text: string) => new HttpError(409, code, text);
const sameControl = (a: BrowserControl, b: BrowserControl) => a.generation === b.generation && a.owner === b.owner;
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function webUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192) throw new HttpError(400, "browser_url", "웹 주소를 확인해 주세요.");
  if (value === "about:blank") return value;
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(400, "browser_url", "http 또는 https 웹 주소를 입력해 주세요."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new HttpError(400, "browser_url", "로그인 정보가 없는 http 또는 https 주소만 열 수 있습니다.");
  return url.href;
}
export function pageAction(value: unknown): BrowserAction {
  if (!value || typeof value !== "object") throw new HttpError(400, "browser_action", "웹 동작을 다시 선택해 주세요.");
  const action = value as BrowserAction;
  if (["snapshot", "back", "forward", "reload", "stop", "close"].includes(action.kind)) return { kind: action.kind } as BrowserAction;
  if (action.kind === "navigate") return { kind: "navigate", url: webUrl(action.url) };
  if (action.kind === "scroll" && Number.isFinite(action.x) && Number.isFinite(action.y)) return { kind: "scroll", x: Math.max(-10000, Math.min(10000, action.x)), y: Math.max(-10000, Math.min(10000, action.y)) };
  if ("ref" in action && /^e\d{1,5}$/.test(action.ref)) {
    if (action.kind === "click") return { kind: action.kind, ref: action.ref };
    if ((action.kind === "fill" || action.kind === "select") && typeof action.value === "string" && action.value.length <= 20000) return { kind: action.kind, ref: action.ref, value: action.value };
    if (action.kind === "press" && typeof action.key === "string" && /^(Enter|Tab|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Backspace|Delete|Home|End)$/.test(action.key)) return { kind: action.kind, ref: action.ref, key: action.key };
  }
  throw new HttpError(400, "browser_action", "지원하지 않는 웹 동작입니다. 페이지를 다시 관찰한 뒤 지원 명령을 사용해 주세요.");
}

/** Host-owned identities and receipts. A renderer is a driver transport, never an AI execution lease. */
export class BrowserRegistry {
  private readonly pages = new Map<string, BrowserPage>();
  private readonly profiles = new Map<string, BrowserProfile>();
  private readonly drivers = new Map<string, number>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly waiters = new Map<string, Waiter>();
  private readonly observed = new Map<string, BrowserObservation>();
  private readonly timer: NodeJS.Timeout;
  private readonly store: Store;
  private readonly hooks: Hooks;
  constructor(store: Store, hooks: Hooks) {
    this.store = store; this.hooks = hooks;
    const saved = store.getMeta(key);
    if (saved) {
      const records = JSON.parse(saved) as BrowserList;
      for (const profile of records.profiles) this.profiles.set(profile.id, profile);
      for (const page of records.pages) this.pages.set(page.pageId, page.status === "closed" ? page : { ...page, status: "interrupted", error: "이전 웹 페이지가 연결되어 있지 않습니다. 새 탭으로 다시 열어 주세요." });
    }
    if (!this.profiles.size) this.profiles.set("default", { id: "default", name: "기본", createdAt: Date.now() });
    for (const row of store.metaEntries(receiptKey)) {
      const receipt = JSON.parse(row.value) as Receipt;
      if (receipt.status === "queued" || receipt.status === "dispatched") {
        receipt.status = receipt.status === "queued" ? "rejected" : "outcome_unknown";
        receipt.result = { id: receipt.job.id, pageId: receipt.job.pageId, error: "호스트 재시작으로 결과를 확인할 수 없습니다. 자동 재실행하지 않았습니다." };
      }
      this.persistReceipt(receipt);
    }
    this.save();
    this.timer = setInterval(() => this.expire(), 2500); this.timer.unref();
  }
  private save() { this.store.setMeta(key, JSON.stringify({ pages: [...this.pages.values()], profiles: [...this.profiles.values()] })); }
  private persistReceipt(receipt: Receipt) {
    this.receipts.set(receipt.job.id, receipt);
    this.store.setMeta(`${receiptKey}${receipt.job.id}`, JSON.stringify({ ...receipt,
      job: { ...receipt.job, expected: receipt.job.expected ? { ...receipt.job.expected, text: "" } : null },
      result: receipt.result?.observation ? { ...receipt.result, observation: { ...receipt.result.observation, text: "페이지 본문은 저장하지 않았습니다. snapshot으로 다시 읽어 주세요." } } : receipt.result }));
  }
  private readReceipt(id: string): Receipt | undefined {
    const live = this.receipts.get(id); if (live) return live;
    const saved = this.store.getMeta(`${receiptKey}${id}`); return saved ? JSON.parse(saved) as Receipt : undefined;
  }
  list(): BrowserList { this.expire(); return { pages: [...this.pages.values()].filter(page => page.status !== "closed"), profiles: [...this.profiles.values()] }; }
  get(id: string): BrowserPage {
    const page = this.pages.get(id);
    if (!page) throw new HttpError(404, "browser_missing", "웹 탭을 찾지 못했습니다.");
    this.hooks.workspace(page.workspaceId);
    return page;
  }
  profile(name: unknown): BrowserProfile {
    if (typeof name !== "string" || !name.trim() || name.length > 80 || this.profiles.size >= 32) throw new HttpError(400, "browser_profile", "프로필 이름을 확인해 주세요. 프로필은 32개까지 만들 수 있습니다.");
    const profile = { id: randomUUID(), name: name.trim(), createdAt: Date.now() };
    this.profiles.set(profile.id, profile); this.save(); return profile;
  }
  create(input: BrowserPageCreate): BrowserPage {
    if (!input || !idOk(input.requestId) || !idOk(input.driverId) || !this.profiles.has(input.profileId)) throw new HttpError(400, "browser_create", "웹 탭과 프로필을 다시 선택해 주세요.");
    const url = webUrl(input.url), workspace = this.hooks.workspace(input.workspaceId), existing = this.pages.get(input.requestId);
    const createHash = fingerprint([input.driverId, input.workspaceId, input.profileId, url]);
    if (existing) {
      if (this.store.getMeta(`shared-browser-create:${input.requestId}`) !== createHash) throw fail("browser_request_reused", "다른 웹 탭에 사용된 요청 ID입니다.");
      return existing;
    }
    if ((this.drivers.get(input.driverId) ?? 0) < Date.now() - 15000) throw fail("browser_driver_missing", "데스크톱 브라우저 연결을 기다린 뒤 다시 열어 주세요.");
    if ([...this.pages.values()].filter(page => page.status !== "closed").length >= 64) throw fail("browser_tab_limit", "열린 웹 탭을 닫은 뒤 새 탭을 열어 주세요.");
    const now = Date.now();
    const page: BrowserPage = { pageId: input.requestId, profileId: input.profileId, driverId: input.driverId, workspaceId: input.workspaceId, workId: workspace.workId, url, title: url === "about:blank" ? "새 탭" : url, status: "opening", sessionId: null, control: { generation: 0, owner: "human" }, native: null, error: null, createdAt: now, updatedAt: now };
    this.pages.set(page.pageId, page); this.store.setMeta(`shared-browser-create:${input.requestId}`, createHash); this.save(); return page;
  }
  attach(pageId: string, session: Session) {
    const page = this.get(pageId);
    if (session.pageAgent?.pageId !== pageId || session.workId !== page.workId || session.workspaceId !== page.workspaceId) throw fail("browser_session_scope", "같은 웹 탭의 대화만 연결할 수 있습니다.");
    page.sessionId = session.id; page.updatedAt = Date.now(); this.save();
  }
  agentPage(sessionId: string): BrowserPage | undefined {
    const session = this.hooks.session(sessionId);
    if (session.pageAgent) return this.get(session.pageAgent.pageId);
    return [...this.pages.values()].reverse().find(page => page.agentSessionId === sessionId);
  }
  /** Explicit tab-open creates a real desktop page. Background Lightpanda stays separate. */
  async openAgentPage(sessionId: string, url: string): Promise<BrowserPage> {
    const session = this.hooks.session(sessionId);
    const driverId = [...this.drivers].sort((a, b) => b[1] - a[1]).find(([, at]) => at > Date.now() - 15000)?.[0];
    if (!driverId || !session.workspaceId) throw fail("browser_driver_missing", "웹 탭을 열려면 데스크톱 앱에 연결해 주세요.");
    let page = this.agentPage(sessionId);
    if (!page || page.status === "interrupted" || page.status === "closed") {
      page = this.create({ requestId: randomUUID(), driverId, workspaceId: session.workspaceId, profileId: "default", url });
      page.agentSessionId = sessionId; this.save();
    }
    const until = Date.now() + 12000;
    while (page.status === "opening" && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
    this.requireReady(page);
    await this.control(page.pageId, sessionId, page.control.generation);
    return page;
  }
  receipt(id: string) { const receipt = this.readReceipt(id); return receipt ? { status: receipt.status, result: receipt.result } : null; }
  async control(pageId: string, owner: unknown, expectedGeneration: unknown): Promise<BrowserPage> {
    const page = this.get(pageId); this.requireReady(page);
    if (typeof owner !== "string" || (owner !== "human" && owner !== page.sessionId && owner !== page.agentSessionId) || !Number.isSafeInteger(expectedGeneration)) throw fail("browser_control", "이 웹 탭의 사람 또는 AI 대화를 선택해 주세요.");
    if (page.control.owner === owner && page.control.generation === expectedGeneration) return page;
    const generation = Number(expectedGeneration) + 1, id = `control-${pageId}-${generation}`;
    if (page.control.generation === generation && page.control.owner === owner) {
      const existing = this.waiters.get(id);
      if (existing) await existing.promise;
      else if (this.receipts.get(id)?.status !== "completed") throw fail("browser_control_unknown", "제어권 인계 결과를 확인하지 못했습니다. 현재 페이지 상태를 확인해 주세요.");
      return this.get(pageId);
    }
    if (page.control.generation !== expectedGeneration) throw fail("browser_control_changed", "제어권이 바뀌었습니다. 현재 상태에서 다시 선택해 주세요.");
    page.control = { generation, owner }; page.updatedAt = Date.now(); this.observed.delete(pageId); this.save();
    // Invalidate queued old actions now. Dispatched actions are fenced in the actual document.
    for (const receipt of this.receipts.values()) if (receipt.job.pageId === pageId && receipt.status === "queued" && receipt.job.action.kind !== "control") this.finish(receipt, { id: receipt.job.id, pageId, error: "CONTROL_REVOKED: 제어권을 인계해 실행하지 않았습니다." }, "rejected");
    const result = await this.enqueue(page, id, { kind: "control", control: page.control }, null, page.control);
    if (result.error) throw fail("browser_control_failed", result.error);
    return this.get(pageId);
  }
  human(pageId: string, input: { requestId: string; action: unknown; expected?: BrowserObservation }) {
    const page = this.get(pageId), action = pageAction(input.action);
    const existing = this.readReceipt(input.requestId);
    if (existing) return this.replay(existing, page, action);
    this.requireReady(page);
    if (page.control.owner !== "human" && action.kind !== "snapshot") throw fail("browser_agent_control", "‘직접 조작’을 눌러 제어권을 받은 뒤 이동해 주세요.");
    return this.enqueue(page, input.requestId, action, input.expected ?? null, page.control);
  }
  generation(sessionId: string): BrowserControl {
    const page = this.agentPage(sessionId);
    if (!page) throw fail("browser_missing", "연결된 웹 탭이 없습니다.");
    this.requireReady(page);
    return { ...page.control };
  }
  async agent(sessionId: string, requestId: string, command: string, args: string[], control: BrowserControl) {
    const page = this.agentPage(sessionId);
    if (!page) throw fail("browser_missing", "연결된 웹 탭이 없습니다.");
    let action: BrowserAction;
    if (["snapshot", "read", "links"].includes(command) || (command === "open" && !args.length)) action = { kind: "snapshot" };
    else if (command === "open" || command === "goto") action = pageAction({ kind: "navigate", url: args[0] });
    else if (["go-back", "go-forward", "reload", "close"].includes(command)) action = { kind: command === "go-back" ? "back" : command === "go-forward" ? "forward" : command as "reload" | "close" };
    else if (command === "click") action = pageAction({ kind: "click", ref: args[0] });
    else if (command === "fill" || command === "select") action = pageAction({ kind: command, ref: args[0], value: args.slice(1).join(" ") });
    else if (command === "press") action = pageAction({ kind: "press", ref: args[0], key: args[1] });
    else if (command === "scroll") action = pageAction({ kind: "scroll", x: Number(args[0] ?? 0), y: Number(args[1] ?? 0) });
    else throw fail("browser_command_unsupported", `공유 웹 탭은 ${command} 명령을 지원하지 않습니다. playwright-cli --help에서 지원 명령을 확인하세요.`);
    const id = `${sessionId}-${requestId}`, prior = this.readReceipt(id);
    if (prior) return this.replay(prior, page, action);
    this.requireReady(page);
    if (action.kind !== "snapshot" && (control.owner !== sessionId || !sameControl(control, page.control))) throw fail("CONTROL_REVOKED", "사용자가 페이지를 직접 조작해 이번 동작을 멈췄습니다. 다음 채팅 요청에서 이어가세요. 이 동작은 실행되지 않았습니다.");
    const expected = action.kind === "snapshot" ? null : this.observed.get(page.pageId) ?? null;
    if ("ref" in action && !expected) throw fail("STALE_DOCUMENT", "먼저 snapshot으로 이 페이지의 현재 요소를 읽어 주세요.");
    return this.enqueue(page, id, action, expected, control);
  }
  private replay(receipt: Receipt, page: BrowserPage, action: BrowserAction): Promise<BrowserJobResult> {
    if (receipt.job.pageId !== page.pageId || fingerprint(receipt.job.action) !== fingerprint(action)) throw fail("browser_request_reused", "다른 웹 동작에 사용한 요청 ID입니다.");
    return this.waiters.get(receipt.job.id)?.promise ?? Promise.resolve(receipt.result ?? { id: receipt.job.id, pageId: page.pageId, error: "동작 결과를 확인하지 못했습니다. 자동으로 다시 실행하지 않았습니다." });
  }
  private requireReady(page: BrowserPage) {
    this.expire();
    if (page.status !== "ready" || !page.native) throw fail("browser_interrupted", page.error || "웹 페이지가 아직 연결되지 않았습니다.");
    this.hooks.workspace(page.workspaceId);
  }
  private enqueue(page: BrowserPage, id: string, action: BrowserAction, expected: BrowserObservation | null, control: BrowserControl): Promise<BrowserJobResult> {
    if (!idOk(id)) throw new HttpError(400, "browser_request", "웹 요청 ID를 확인해 주세요.");
    if (this.receipts.size >= 4000) {
      for (const [oldId, receipt] of this.receipts) if (receipt.status === "completed" || receipt.status === "rejected") { this.receipts.delete(oldId); if (this.receipts.size < 3000) break; }
      if (this.receipts.size >= 4000) throw fail("browser_receipt_limit", "확인이 필요한 웹 동작 기록이 많습니다. 브라우저 연결을 확인해 주세요.");
    }
    const job: BrowserJob = { id, pageId: page.pageId, driverId: page.driverId, action, expected, control: { ...control }, deadline: Date.now() + 20000 };
    this.persistReceipt({ job, hash: fingerprint(job), status: "queued", result: null });
    let done!: (result: BrowserJobResult) => void;
    const promise = new Promise<BrowserJobResult>(resolve => { done = resolve; });
    const timer = setTimeout(() => {
      const receipt = this.receipts.get(id);
      if (receipt) this.finish(receipt, { id, pageId: page.pageId, error: receipt.status === "dispatched" ? "실행 결과를 확인할 수 없습니다. 페이지를 확인한 뒤 계속하세요. 자동 재실행하지 않았습니다." : "브라우저가 연결되지 않아 실행하지 않았습니다." }, receipt.status === "dispatched" ? "outcome_unknown" : "rejected");
    }, 20500); timer.unref();
    this.waiters.set(id, { promise, resolve: done, timer }); return promise;
  }
  poll(input: BrowserDriverPoll): BrowserDriverReply {
    if (!input || !idOk(input.driverId) || !Array.isArray(input.pages) || input.pages.length > 64 || !Array.isArray(input.results) || input.results.length > 128) throw new HttpError(400, "browser_driver", "브라우저 연결 정보가 올바르지 않습니다.");
    this.drivers.set(input.driverId, Date.now());
    let changed = false;
    for (const native of input.pages) {
      const page = this.pages.get(native.pageId);
      if (!page || page.driverId !== input.driverId || page.profileId !== native.profileId || page.status === "closed" || page.status === "interrupted") continue;
      if (!Number.isSafeInteger(native.navigationRevision) || !native.control || !Number.isSafeInteger(native.control.generation) || (native.control.owner !== "human" && native.control.owner !== page.sessionId && native.control.owner !== page.agentSessionId)) continue;
      if (native.control.generation > page.control.generation) { page.control = { ...native.control }; this.observed.delete(page.pageId); }
      if (JSON.stringify(page.native) !== JSON.stringify(native) || page.status !== "ready") {
        page.native = native; page.url = native.url; page.title = native.title || native.url; page.status = "ready"; page.error = native.error; page.updatedAt = Date.now(); changed = true;
      }
    }
    const present = new Set(input.pages.map(page => page.pageId));
    const closed = new Set(input.results.filter(result => !result.error && this.receipts.get(result.id)?.job.action.kind === "close" && this.receipts.get(result.id)?.job.driverId === input.driverId).map(result => result.pageId));
    for (const page of this.pages.values()) if (page.driverId === input.driverId && page.status === "ready" && !present.has(page.pageId) && !closed.has(page.pageId)) { this.interrupt(page, "실제 웹 페이지가 닫혀 작업을 멈췄습니다. 다른 브라우저로 이동하지 않았습니다."); changed = true; }
    for (const result of input.results) {
      const receipt = this.receipts.get(result.id);
      if (!receipt || receipt.job.driverId !== input.driverId || receipt.job.pageId !== result.pageId || !["dispatched", "outcome_unknown"].includes(receipt.status)) continue;
      this.finish(receipt, result, result.outcome === "unknown" ? "outcome_unknown" : result.error ? "rejected" : "completed");
      const page = this.pages.get(result.pageId);
      if (!page) continue;
      if (!result.error && receipt.job.action.kind === "close") { page.status = "closed"; page.control = { generation: page.control.generation + 1, owner: "human" }; if (page.sessionId) this.hooks.interrupted(page.sessionId, "웹 탭을 닫아 브라우저 작업이 끝났습니다."); changed = true; }
      if (!result.error && result.observation && sameControl(page.control, receipt.job.control) && result.observation.target.pageId === page.pageId && result.observation.target.profileId === page.profileId) this.observed.set(page.pageId, result.observation);
    }
    const jobs: BrowserJob[] = [];
    // Handoffs are dispatched ahead of queued actions, and native execution checks the fence again.
    const queued = [...this.receipts.values()].filter(r => r.job.driverId === input.driverId && r.status === "queued").sort((a, b) => Number(b.job.action.kind === "control") - Number(a.job.action.kind === "control"));
    for (const receipt of queued.slice(0, 32)) {
      const page = this.pages.get(receipt.job.pageId);
      if (!page || page.status !== "ready" || receipt.job.deadline <= Date.now() || (receipt.job.action.kind !== "snapshot" && !sameControl(page.control, receipt.job.control))) { this.finish(receipt, { id: receipt.job.id, pageId: receipt.job.pageId, error: "CONTROL_REVOKED: 페이지 또는 제어권이 바뀌어 실행하지 않았습니다." }, "rejected"); continue; }
      receipt.status = "dispatched"; this.persistReceipt(receipt); jobs.push(receipt.job);
    }
    if (changed) this.save();
    return { driverId: input.driverId, jobs, ...this.list() } as BrowserDriverReply;
  }
  private finish(receipt: Receipt, result: BrowserJobResult, status: Receipt["status"]) {
    receipt.status = status; receipt.result = result;
    // Page text is transient: durable receipts keep only identity/result status, not private DOM copies.
    this.persistReceipt(receipt);
    const waiter = this.waiters.get(receipt.job.id);
    if (waiter) { clearTimeout(waiter.timer); this.waiters.delete(receipt.job.id); waiter.resolve(result); }
  }
  private interrupt(page: BrowserPage, error: string) {
    page.status = "interrupted"; page.error = error; page.control = { generation: page.control.generation + 1, owner: "human" }; this.observed.delete(page.pageId);
    if (page.sessionId) this.hooks.interrupted(page.sessionId, error);
  }
  private expire() {
    let changed = false;
    for (const page of this.pages.values()) if ((page.status === "ready" || page.status === "opening") && (this.drivers.get(page.driverId) ?? 0) < Date.now() - 15000) { this.interrupt(page, "데스크톱 웹 페이지 연결이 끊겼습니다. 결과를 확인하고 새 탭에서 다시 시작해 주세요."); changed = true; }
    if (changed) this.save();
  }
  shutdown() {
    clearInterval(this.timer);
    for (const receipt of this.receipts.values()) if (receipt.status === "queued" || receipt.status === "dispatched") this.finish(receipt, { id: receipt.job.id, pageId: receipt.job.pageId, error: "호스트가 종료되어 웹 동작 결과를 확인하지 못했습니다." }, receipt.status === "dispatched" ? "outcome_unknown" : "rejected");
  }
}
