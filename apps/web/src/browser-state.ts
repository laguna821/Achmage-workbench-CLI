import type { BrowserAction, BrowserControl, BrowserJob, BrowserJobResult, BrowserList, BrowserPage, BrowserPageCreate, NativeBrowserPage } from "@workbench/contracts";
import { ApiRequestError, type Api } from "./api.ts";

export type BrowserPlacement = { pageId: string; x: number; y: number; width: number; height: number; visible: boolean; focus?: boolean };
export type BrowserNativeCommand =
  | { kind: "create"; pageId: string; profileId: string; url: string; control: BrowserControl }
  | { kind: "list" }
  | { kind: "close"; pageId: string; profileId: string }
  | { kind: "present"; pages: BrowserPlacement[] }
  | { kind: "download-directory"; pageId: string; directory: string | null }
  | { kind: "download-cancel"; pageId: string; downloadId: string }
  | { kind: "permission-decision"; pageId: string; requestId: string; allow: boolean; remember?: boolean }
  | { kind: "site-permission-forget"; pageId: string; ruleId: string }
  | { kind: "execute"; job: BrowserJob };
export type BrowserNative = <T>(command: BrowserNativeCommand) => Promise<T>;
type Pending = { id: string; status: "waiting" | "unknown" };
type BrowserState = BrowserList & { connected: boolean; error: string | null; pending: Record<string, Pending> };
type Surface = { element: HTMLElement; pageId: string; visible: boolean };
const driverKey = "workbench.browser.driver";
const pendingKey = "workbench.browser.pending";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export const sameBrowserControl = (a: BrowserControl, b: BrowserControl) => a.owner === b.owner && a.generation === b.generation;
export function browserUrl(input: string): string {
  const value = input.trim();
  if (!value || value === "about:blank") return "about:blank";
  if (value.length > 8192) throw new Error("검색어나 웹 주소를 짧게 입력해 주세요.");
  const host = /^(?:localhost|(?:[\p{L}\d-]+\.)+[\p{L}\d-]+|\[[a-f\d:]+\])(?::\d+)?(?:[/?#]|$)/iu.test(value);
  const scheme = /^[a-z][a-z\d+.-]*:/i.test(value) && !host;
  if (!scheme && (!host || /\s/.test(value))) return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
  const url = new URL(scheme ? value : `https://${value}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("로그인 정보가 없는 http 또는 https 주소를 입력해 주세요.");
  return url.href;
}
function driverIdentity(): string {
  try {
    const saved = sessionStorage.getItem(driverKey);
    if (saved) return saved;
    const id = crypto.randomUUID(); sessionStorage.setItem(driverKey, id); return id;
  } catch { return crypto.randomUUID(); }
}
function savedPending(): Record<string, Pending> {
  try { return JSON.parse(sessionStorage.getItem(pendingKey) ?? "{}") as Record<string, Pending>; } catch { return {}; }
}
function createdPages(): Set<string> {
  try { return new Set(JSON.parse(sessionStorage.getItem("workbench.browser.created") ?? "[]") as string[]); } catch { return new Set(); }
}

/** One trusted main-window driver. Tab visibility never controls execution or native lifetime. */
export class SharedBrowser {
  readonly driverId: string;
  readonly available: boolean;
  private readonly api: Api["sharedBrowser"] | null;
  private readonly native: BrowserNative | null;
  private value: BrowserState = { pages: [], profiles: [], connected: false, error: null, pending: savedPending() };
  private readonly listeners = new Set<() => void>();
  private readonly results = new Map<string, BrowserJobResult>();
  private readonly accepted = new Set<string>();
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly restoring = new Map<string, Promise<BrowserPage>>();
  private readonly surfaces = new Map<string, Surface>();
  private readonly nativeCreates = createdPages();
  private readonly creationErrors = new Map<string, string>();
  private nativePages: NativeBrowserPage[] = [];
  private running = false;
  private epoch = 0;
  private version = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pollInFlight: Promise<void> | null = null;
  private presentation: Promise<void> = Promise.resolve();
  private lastPresentation = "";
  private resize: ResizeObserver | null = null;
  private mutations: MutationObserver | null = null;
  private frame: number | null = null;
  constructor(api: Api["sharedBrowser"] | null, native: BrowserNative | null, driverId = driverIdentity()) {
    this.api = api; this.native = native; this.available = Boolean(api && native); this.driverId = driverId;
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getState = () => this.value;
  private change(patch: Partial<BrowserState>) { this.value = { ...this.value, ...patch }; for (const listener of this.listeners) listener(); }
  private upsert(page: BrowserPage) {
    this.version++; this.change({ pages: [...this.value.pages.filter(entry => entry.pageId !== page.pageId), page] }); this.schedulePresentation();
  }
  private pending(pageId: string, next: Pending | null) {
    const pending = { ...this.value.pending }; if (next) pending[pageId] = next; else delete pending[pageId];
    try { sessionStorage.setItem(pendingKey, JSON.stringify(pending)); } catch { /* Live receipts remain available. */ }
    this.change({ pending });
  }
  start(): () => void {
    if (!this.available || this.running) return () => {};
    this.running = true; const epoch = ++this.epoch;
    this.resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(this.schedulePresentation);
    for (const surface of this.surfaces.values()) this.resize?.observe(surface.element);
    this.mutations = new MutationObserver(this.schedulePresentation);
    this.mutations.observe(document.body, { subtree: true, attributes: true, childList: true, attributeFilter: ["class", "style", "hidden", "open", "aria-hidden"] });
    window.addEventListener("resize", this.schedulePresentation);
    window.addEventListener("scroll", this.schedulePresentation, true);
    document.addEventListener("visibilitychange", this.schedulePresentation);
    void this.loop(epoch);
    return () => this.stop();
  }
  private async loop(epoch: number) {
    if (!this.running || epoch !== this.epoch) return;
    await this.poll();
    if (this.running && epoch === this.epoch) this.timer = setTimeout(() => void this.loop(epoch), 500);
  }
  stop() {
    this.running = false; this.epoch++; clearTimeout(this.timer);
    this.resize?.disconnect(); this.mutations?.disconnect();
    window.removeEventListener("resize", this.schedulePresentation);
    window.removeEventListener("scroll", this.schedulePresentation, true);
    document.removeEventListener("visibilitychange", this.schedulePresentation);
    if (this.frame !== null) cancelAnimationFrame(this.frame); this.frame = null;
    void this.present(true);
  }
  /** Serialized heartbeat; results are retained until the host acknowledges their exact batch. */
  poll(): Promise<void> {
    if (this.pollInFlight) return this.pollInFlight;
    this.pollInFlight = this.readDriver().finally(() => { this.pollInFlight = null; }); return this.pollInFlight;
  }
  private async readDriver() {
    if (!this.api || !this.native) return;
    try {
      // A failed native listing must not be represented as an empty (all pages closed) list.
      const pages = await this.native<NativeBrowserPage[]>({ kind: "list" }); this.nativePages = pages;
      const results = [...this.results.values()].slice(0, 128), version = this.version;
      const reply = await this.api.poll({ driverId: this.driverId, pages, results });
      for (const result of results) {
        if (this.results.get(result.id) === result) this.results.delete(result.id);
        if (this.value.pending[result.pageId]?.id === result.id && !result.error) this.pending(result.pageId, null);
      }
      if (version === this.version) this.change({ pages: reply.pages.map(page => this.creationState(page)), profiles: reply.profiles, closedPageIds: reply.closedPageIds ?? [], connected: true, error: null });
      else this.change({ connected: true, error: null });
      for (const job of reply.jobs) this.scheduleJob(job);
      // Host-created agent tabs use this same native driver; never a URL-copy viewer.
      for (const page of reply.pages) if (page.agentSessionId && page.driverId === this.driverId && page.status === "opening" && !this.nativeCreates.has(page.pageId)) {
        void this.connectCreated(page).catch(error => { this.creationErrors.set(page.pageId, message(error)); });
      }
      this.schedulePresentation();
    } catch (error) { this.change({ connected: false, error: message(error) }); this.schedulePresentation(); }
  }
  private scheduleJob(job: BrowserJob) {
    if (!this.native || job.driverId !== this.driverId || this.accepted.has(job.id)) return;
    this.accepted.add(job.id);
    const lane = (this.lanes.get(job.pageId) ?? Promise.resolve()).then(async () => {
      let result: BrowserJobResult;
      try {
        if (job.deadline <= Date.now()) throw new Error("실행 기한이 지나 이 동작을 실행하지 않았습니다.");
        result = await this.native!<BrowserJobResult>({ kind: "execute", job });
        if (result.id !== job.id || result.pageId !== job.pageId) throw new Error("웹 동작 응답의 대상이 일치하지 않습니다.");
      } catch (error) {
        // Native IPC may have executed before transport loss. Report, never repeat the job.
        result = { id: job.id, pageId: job.pageId, outcome: "unknown", error: `결과 확인 필요: ${message(error)}` };
      }
      this.results.set(job.id, result);
    });
    this.lanes.set(job.pageId, lane);
    void lane.finally(() => { if (this.lanes.get(job.pageId) === lane) this.lanes.delete(job.pageId); });
  }
  async refresh(): Promise<BrowserList> {
    if (!this.api) throw new Error("호스트에 연결해 주세요.");
    const version = this.version, list = await this.api.list();
    if (version === this.version) { this.change({ ...list, pages: list.pages.map(page => this.creationState(page)) }); this.schedulePresentation(); }
    return list;
  }
  async profile(name: string) {
    if (!this.api) throw new Error("호스트에 연결해 주세요.");
    const profile = await this.api.profile(name); this.version++;
    this.change({ profiles: [...this.value.profiles.filter(entry => entry.id !== profile.id), profile] }); return profile;
  }
  /** A caller keeps this request if transport is uncertain; only an explicit new tab gets a new id. */
  async create(input: BrowserPageCreate): Promise<BrowserPage> {
    if (!this.api || !this.native) throw new Error("데스크톱의 기본 창에서 웹 탭을 열어 주세요.");
    let page: BrowserPage;
    try { page = await this.api.create(input); }
    catch (error) {
      const found = (await this.refresh().catch(() => ({ pages: [] }))).pages.find(entry => entry.pageId === input.requestId);
      if (!found) throw error;
      page = found;
    }
    if (page.pageId !== input.requestId || page.driverId !== this.driverId || page.profileId !== input.profileId || page.workspaceId !== input.workspaceId) throw new Error("웹 탭 생성 응답의 대상이 일치하지 않습니다.");
    return this.connectCreated(page);
  }
  private creationState(page: BrowserPage): BrowserPage {
    const error = this.creationErrors.get(page.pageId);
    return error && page.status === "opening" ? { ...page, status: "interrupted", error } : page;
  }
  restore(pageId: string): Promise<BrowserPage> {
    const closing = this.closing.get(pageId);
    if (closing || this.value.closedPageIds?.includes(pageId)) return Promise.reject(new Error("닫은 웹 탭입니다."));
    const previous = this.restoring.get(pageId); if (previous) return previous;
    const restoring = this.restorePage(pageId).finally(() => { if (this.restoring.get(pageId) === restoring) this.restoring.delete(pageId); });
    this.restoring.set(pageId, restoring); return restoring;
  }
  private async restorePage(pageId: string): Promise<BrowserPage> {
    if (!this.api || !this.native) throw new Error("데스크톱 기본 창에서 열어 주세요.");
    const current = this.value.pages.find(page => page.pageId === pageId);
    if (current?.status === "ready" && current.driverId === this.driverId) return current;
    const page = await this.api.restore(pageId, this.driverId);
    if (page.pageId !== pageId || page.driverId !== this.driverId) throw new Error("복원할 웹 탭의 대상이 일치하지 않습니다.");
    this.creationErrors.delete(pageId); this.nativeCreates.delete(pageId);
    this.pending(pageId, null); // Old receipts remain in the host; no old action is resent.
    return this.connectCreated(page);
  }
  async reconcileCreation(input: BrowserPageCreate): Promise<BrowserPage | null> {
    const page = (await this.refresh()).pages.find(entry => entry.pageId === input.requestId);
    if (!page) return null;
    if (page.driverId !== this.driverId || page.profileId !== input.profileId || page.workspaceId !== input.workspaceId) throw new Error("생성 요청의 대상이 일치하지 않습니다.");
    return this.connectCreated(page);
  }
  private async connectCreated(page: BrowserPage): Promise<BrowserPage> {
    if (!this.native) throw new Error("데스크톱 기본 창에서 열어 주세요.");
    this.upsert(this.creationState(page));
    if (page.status !== "opening") return page;
    const existing = (await this.native<NativeBrowserPage[]>({ kind: "list" })).find(entry => entry.pageId === page.pageId);
    if (existing && existing.profileId !== page.profileId) throw new Error("다른 프로필의 웹 탭입니다.");
    if (existing && !sameBrowserControl(existing.control, page.control)) {
      const result = await this.native<BrowserJobResult>({ kind: "execute", job: { id: `restore-${crypto.randomUUID()}`, pageId: page.pageId, driverId: this.driverId, action: { kind: "control", control: page.control }, expected: null, control: page.control, deadline: Date.now() + 20000 } });
      if (result.error) throw new Error(result.error);
    }
    if (!existing) {
      if (this.nativeCreates.has(page.pageId)) {
        this.creationErrors.set(page.pageId, "이 웹 페이지의 생성 결과를 확인할 수 없습니다. 새 탭으로 다시 열어 주세요.");
        const interrupted = this.creationState(page); this.upsert(interrupted); return interrupted;
      }
      this.nativeCreates.add(page.pageId);
      try { sessionStorage.setItem("workbench.browser.created", JSON.stringify([...this.nativeCreates])); } catch { /* Never retry within this driver. */ }
      try { await this.native<NativeBrowserPage>({ kind: "create", pageId: page.pageId, profileId: page.profileId, url: page.url, control: page.control }); }
      catch (error) {
        const found = await this.native<NativeBrowserPage[]>({ kind: "list" }).catch(() => []);
        if (!found.some(entry => entry.pageId === page.pageId)) {
          this.creationErrors.set(page.pageId, `웹 탭 생성 결과를 확인하지 못했습니다. ${message(error)}`);
          const interrupted = this.creationState(page); this.upsert(interrupted); return interrupted;
        }
      }
    }
    await this.poll(); return this.value.pages.find(entry => entry.pageId === page.pageId) ?? page;
  }
  async session(pageId: string, parentSessionId: string | null, provider?: import("@workbench/contracts").Provider) {
    if (!this.api) throw new Error("호스트에 연결해 주세요.");
    const session = await this.api.session(pageId, parentSessionId, provider);
    const page = this.value.pages.find(entry => entry.pageId === pageId);
    if (page) this.upsert({ ...page, sessionId: session.id }); return session;
  }
  async control(pageId: string, owner: string) {
    if (!this.api) throw new Error("호스트에 연결해 주세요.");
    const page = this.value.pages.find(entry => entry.pageId === pageId);
    if (!page) throw new Error("웹 탭을 찾을 수 없습니다.");
    try {
      const result = await this.api.control(pageId, owner, page.control.generation); this.upsert(result);
      if (result.control.owner !== owner || !result.native || !sameBrowserControl(result.control, result.native.control)) throw new Error("제어권 인계가 아직 확인되지 않았습니다. 현재 페이지 상태를 확인해 주세요.");
      return result;
    }
    catch (error) { await this.refresh().catch(() => {}); throw error; }
  }
  private async nativeSetting(command: Extract<BrowserNativeCommand, { kind: "download-directory" | "download-cancel" | "permission-decision" | "site-permission-forget" }>) {
    if (!this.native) throw new Error("데스크톱 기본 창에서 열어 주세요.");
    const page = this.value.pages.find(entry => entry.pageId === command.pageId);
    if (!page || page.status !== "ready" || page.driverId !== this.driverId) throw new Error("연결된 웹 탭에서 다시 시도해 주세요.");
    if (page.control.owner !== "human" || !page.native || !sameBrowserControl(page.control, page.native.control)) await this.control(page.pageId, "human");
    await this.native<NativeBrowserPage>(command); await this.poll();
  }
  downloadDirectory(pageId: string, directory: string | null) { return this.nativeSetting({ kind: "download-directory", pageId, directory }); }
  cancelDownload(pageId: string, downloadId: string) { return this.nativeSetting({ kind: "download-cancel", pageId, downloadId }); }
  decidePermission(pageId: string, requestId: string, allow: boolean, remember = false) { return this.nativeSetting({ kind: "permission-decision", pageId, requestId, allow, remember }); }
  forgetSitePermission(pageId: string, ruleId: string) { return this.nativeSetting({ kind: "site-permission-forget", pageId, ruleId }); }
  async action(pageId: string, action: BrowserAction) {
    if (!this.api) throw new Error("호스트에 연결해 주세요.");
    if (this.value.pending[pageId]) throw new Error("앞선 웹 동작의 결과를 먼저 확인해 주세요.");
    const id = crypto.randomUUID(); this.pending(pageId, { id, status: "waiting" });
    let result: BrowserJobResult;
    try { result = await this.api.action(pageId, id, action); }
    catch (error) {
      if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500) { this.pending(pageId, null); throw error; }
      this.pending(pageId, { id, status: "unknown" });
      const reconciled = await this.reconcile(pageId).catch(() => null);
      if (!reconciled) throw new Error(`웹 동작의 결과를 확인하고 있습니다. 자동 재실행하지 않았습니다. ${message(error)}`);
      result = reconciled;
    }
    if (result.id !== id || result.pageId !== pageId) {
      this.pending(pageId, { id, status: "unknown" }); throw new Error("웹 동작 응답의 대상이 일치하지 않습니다. 기존 요청의 결과를 다시 확인해 주세요.");
    }
    this.pending(pageId, null);
    if (result.error) throw new Error(result.error);
    if (action.kind === "close") {
      const page = this.value.pages.find(entry => entry.pageId === pageId);
      if (page) this.upsert({ ...page, status: "closed", native: null });
    }
    return result;
  }
  async reconcile(pageId: string): Promise<BrowserJobResult | null> {
    const pending = this.value.pending[pageId]; if (!pending || !this.api) return null;
    const receipt = await this.api.receipt(pending.id);
    if (!receipt) throw new Error("호스트에 접수된 동작 기록이 없습니다. 페이지를 확인해 주세요. 이 요청을 자동으로 다시 보내지 않습니다.");
    if (receipt.result && (receipt.result.id !== pending.id || receipt.result.pageId !== pageId)) throw new Error("웹 동작 기록의 대상이 일치하지 않습니다.");
    if (receipt.status === "queued" || receipt.status === "dispatched") return null;
    this.pending(pageId, null);
    return receipt.result ?? { id: pending.id, pageId, error: "이 동작의 결과를 확인할 수 없습니다. 페이지를 확인한 뒤 계속해 주세요." };
  }
  dismissPending(pageId: string) { if (this.value.pending[pageId]?.status === "unknown") this.pending(pageId, null); }
  /** Tab X and explicit page termination share this path. Ordinary unmount only hides. */
  close(pageId: string): Promise<void> {
    const existing = this.closing.get(pageId); if (existing) return existing;
    const closing = this.closePage(pageId).finally(() => { if (this.closing.get(pageId) === closing) this.closing.delete(pageId); });
    this.closing.set(pageId, closing); return closing;
  }
  private async closePage(pageId: string): Promise<void> {
    if (!this.api) throw new Error("호스트에 연결해 주세요.");
    if (this.value.closedPageIds?.includes(pageId)) return;
    await this.restoring.get(pageId)?.catch(() => {});
    const page = await this.api.close(pageId);
    // Persist closure before disposing a view. Broken page scripts cannot prevent closing.
    this.upsert(page); this.pending(pageId, null);
    this.change({ closedPageIds: [...new Set([...(this.value.closedPageIds ?? []), pageId])] });
    if (this.native) await this.native({ kind: "close", pageId, profileId: page.profileId });
  }
  surface(id: string, pageId: string, element: HTMLElement, visible: boolean): () => void {
    this.surfaces.set(id, { pageId, element, visible }); this.resize?.observe(element); this.schedulePresentation();
    return () => { this.resize?.unobserve(element); this.surfaces.delete(id); this.schedulePresentation(); };
  }
  private schedulePresentation = () => {
    if (!this.native || this.frame !== null) return;
    this.frame = requestAnimationFrame(() => { this.frame = null; void this.present(); });
  };
  /** Public for deterministic layout checks; native rectangles use logical CSS pixels. */
  async present(forceHide = false): Promise<void> {
    if (!this.native) return;
    const overlays = Array.from(document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"], [role="menu"], .popover, .context-menu, .palette-backdrop, [data-covers-web]')).filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden" && !element.closest('[hidden], [aria-hidden="true"]'));
    // Native child views paint above DOM content. Modal surfaces block the whole window;
    // local menus/forms only hide pages they actually overlap, leaving side chat usable.
    // `data-covers-web`: a sheet laid over the work (the narrow right sidebar and its scrim).
    const blocked = forceHide || document.hidden || !this.value.connected || overlays.some(element => element.matches('dialog[open], [aria-modal="true"], .palette-backdrop, [role="dialog"]:not(.popover)'));
    const obstructions = overlays.map(element => element.getBoundingClientRect());
    const placements = new Map<string, BrowserPlacement>(this.nativePages.map(page => [page.pageId, { pageId: page.pageId, x: 0, y: 0, width: 1, height: 1, visible: false }]));
    if (!blocked) for (const surface of this.surfaces.values()) {
      if (!surface.visible || !surface.element.isConnected || surface.element.closest('[hidden], [aria-hidden="true"]')) continue;
      const page = this.value.pages.find(entry => entry.pageId === surface.pageId);
      if (!page || page.status !== "ready" || page.driverId !== this.driverId) continue;
      const box = surface.element.getBoundingClientRect();
      const x = Math.max(0, box.left), y = Math.max(0, box.top), width = Math.min(window.innerWidth, box.right) - x, height = Math.min(window.innerHeight, box.bottom) - y;
      if (obstructions.some(rect => rect.left < x + width && rect.right > x && rect.top < y + height && rect.bottom > y)) continue;
      if (width > 1 && height > 1 && getComputedStyle(surface.element).visibility !== "hidden") placements.set(surface.pageId, { pageId: surface.pageId, x, y, width, height, visible: true });
    }
    const pages = [...placements.values()], serialized = JSON.stringify(pages);
    if (serialized === this.lastPresentation) return this.presentation;
    this.lastPresentation = serialized;
    this.presentation = this.presentation.then(async () => { try { await this.native!({ kind: "present", pages }); } catch (error) { this.lastPresentation = ""; this.change({ error: message(error) }); } });
    return this.presentation;
  }
}
