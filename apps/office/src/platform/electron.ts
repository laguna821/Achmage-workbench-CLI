// What IeumOffice's editor code asks of Electron's main process, answered by Workbench inside the
// editor page's worker. The editor page is the one "webContents"; its calls arrive as IPC
// handlers registered here, and `send` goes back to the page. There are no windows, menus or
// native dialogs: a dialog answers its cancel button (an informational one is shown to the user
// through Workbench instead), the clipboard lives in memory, files live in fs.ts.
import { EventEmitter } from "./emitter.ts";

type Notice = (message: string) => void;
let deliver: (webContentsId: number, channel: string, args: unknown[]) => void = () => {};
let notice: Notice = () => {};
/** Where page messages and user-facing notices go (set by the worker). */
export function connect(to: { deliver: typeof deliver; notice: Notice }) {
  deliver = to.deliver;
  notice = to.notice;
}

const noop = () => {};
const resolved = <T>(value: T) => Promise.resolve(value);

// ── app ──────────────────────────────────────────────────────────────────
const PATHS: Record<string, string> = {
  home: "/home/workbench",
  appData: "/appData",
  userData: "/userData",
  sessionData: "/userData",
  temp: "/tmp",
  documents: "/documents",
  downloads: "/downloads",
  desktop: "/desktop",
  logs: "/logs",
};
class App extends EventEmitter {
  readonly isPackaged = true;
  readonly commandLine = { appendSwitch: noop, appendArgument: noop, hasSwitch: () => false, getSwitchValue: () => "" };
  name = "IeumOffice";
  getPath(name: string) {
    return PATHS[name] ?? `/${name}`;
  }
  getAppPath() {
    return "/app";
  }
  getVersion() {
    return "0.12.7";
  }
  getName() {
    return this.name;
  }
  getLocale() {
    return "ko";
  }
  getSystemLocale() {
    return "ko-KR";
  }
  getPreferredSystemLanguages() {
    return ["ko-KR"];
  }
  whenReady() {
    return resolved(undefined);
  }
  isReady() {
    return true;
  }
  getAppMetrics() {
    return [];
  }
  getGPUFeatureStatus() {
    return {};
  }
  quit = noop;
  exit = noop;
  focus = noop;
  addRecentDocument = noop;
}
export const app = new App();

// ── IPC ──────────────────────────────────────────────────────────────────
type Handler = (event: IpcEvent, ...args: unknown[]) => unknown;
type IpcEvent = { sender: Page; senderFrame: unknown; processId: number; frameId: number; returnValue?: unknown; reply(channel: string, ...args: unknown[]): void };

class IpcMain extends EventEmitter {
  readonly handlers = new Map<string, Handler>();
  handle(channel: string, handler: Handler) {
    this.handlers.set(channel, handler);
  }
  handleOnce(channel: string, handler: Handler) {
    this.handlers.set(channel, (event, ...args) => {
      this.handlers.delete(channel);
      return handler(event, ...args);
    });
  }
  removeHandler(channel: string) {
    this.handlers.delete(channel);
  }
}
export const ipcMain = new IpcMain();

const eventFor = (sender: Page): IpcEvent => ({
  sender,
  senderFrame: sender.mainFrame,
  processId: 0,
  frameId: 0,
  reply: (channel, ...args) => sender.send(channel, ...args),
});

/** A page's `ipcRenderer.invoke`; undefined when nothing handles the channel here. */
export function invoke(webContentsId: number, channel: string, args: unknown[]): { handled: boolean; result?: Promise<unknown> } {
  const sender = pages.get(webContentsId);
  const handler = ipcMain.handlers.get(channel);
  if (!sender || !handler) return { handled: false };
  return { handled: true, result: Promise.resolve().then(() => handler(eventFor(sender), ...args)) };
}

/** A page's `ipcRenderer.send`. */
export function emit(webContentsId: number, channel: string, args: unknown[]) {
  const sender = pages.get(webContentsId);
  if (!sender) return;
  const event = eventFor(sender);
  ipcMain.emit(channel, event, ...args);
  sender.ipc.emit(channel, event, ...args);
}

// ── the editor page (webContents) ────────────────────────────────────────
const pages = new Map<number, Page>();
let nextId = 1;

class Page extends EventEmitter {
  readonly id = nextId++;
  readonly ipc = new IpcMain();
  readonly mainFrame = { url: "", send: (channel: string, ...args: unknown[]) => this.send(channel, ...args) };
  readonly session = defaultSession;
  private destroyed = false;
  constructor() {
    super();
    pages.set(this.id, this);
  }
  send(channel: string, ...args: unknown[]) {
    if (!this.destroyed) deliver(this.id, channel, args);
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    pages.delete(this.id);
    this.emit("destroyed");
  }
  close() {
    this.destroy();
  }
  loadURL() {
    return resolved(undefined);
  }
  loadFile() {
    return resolved(undefined);
  }
  getURL() {
    return "";
  }
  getOSProcessId() {
    return 0;
  }
  isLoading() {
    return false;
  }
  isFocused() {
    return true;
  }
  getZoomFactor() {
    return 1;
  }
  executeJavaScript() {
    return Promise.reject(new Error("not available in the editor"));
  }
  printToPDF() {
    return Promise.reject(new Error("PDF 내보내기는 Workbench에서 아직 지원하지 않습니다."));
  }
  print(_options?: unknown, callback?: (success: boolean, reason: string) => void) {
    callback?.(false, "not available");
  }
  capturePage() {
    return resolved(nativeImage.createEmpty());
  }
  // Editing commands the page carries out itself (slides.ts answers the clipboard channel).
  cut = noop;
  copy = noop;
  paste = noop;
  selectAll = noop;
  undo = noop;
  redo = noop;
  setWindowOpenHandler = noop;
  setZoomFactor = noop;
  setBackgroundThrottling = noop;
  setIgnoreMenuShortcuts = noop;
  focus = noop;
  reload = noop;
  forcefullyCrashRenderer = noop;
  openDevTools = noop;
  insertCSS = () => resolved("");
}

const defaultSession = {
  setDisplayMediaRequestHandler: noop,
  setPermissionRequestHandler: noop,
  setPermissionCheckHandler: noop,
  setSpellCheckerLanguages: noop,
  getSpellCheckerLanguages: () => [],
  resolveProxy: () => resolved("DIRECT"),
  on: noop,
  protocol: { handle: noop, unhandle: noop, isProtocolHandled: () => false },
  webRequest: { onBeforeRequest: noop, onHeadersReceived: noop },
};
export const session = { defaultSession, fromPartition: () => defaultSession };

export const webContents = {
  fromId: (id: number) => pages.get(id),
  getAllWebContents: () => [...pages.values()],
  getFocusedWebContents: () => null,
};

/** The editor page's view: its webContents is the page. */
export class WebContentsView {
  readonly webContents = new Page();
  constructor(_options?: unknown) {}
  setBounds = noop;
  setBackgroundColor = noop;
  setVisible = noop;
  setBorderRadius = noop;
}

/** No windows: there is nothing to find, and new ones (print, PDF) do nothing. */
export class BrowserWindow extends EventEmitter {
  readonly webContents = new Page();
  constructor(_options?: unknown) {
    super();
  }
  static fromWebContents() {
    return null;
  }
  static getFocusedWindow() {
    return null;
  }
  static getAllWindows() {
    return [];
  }
  loadURL() {
    return resolved(undefined);
  }
  isDestroyed() {
    return this.webContents.isDestroyed();
  }
  close() {
    this.webContents.destroy();
  }
  destroy() {
    this.webContents.destroy();
  }
  getBounds() {
    return { x: 0, y: 0, width: 1440, height: 900 };
  }
  show = noop;
  hide = noop;
  focus = noop;
  setTitle = noop;
  setBounds = noop;
  setFullScreen = noop;
  isFullScreen() {
    return false;
  }
  setBackgroundColor = noop;
  setDocumentEdited = noop;
}

export class Menu {
  readonly items: unknown[];
  constructor(items: unknown[] = []) {
    this.items = items;
  }
  static buildFromTemplate(template: unknown[]) {
    return new Menu(template);
  }
  static setApplicationMenu = noop;
  static getApplicationMenu() {
    return null;
  }
  append(item: unknown) {
    this.items.push(item);
  }
  popup = noop;
}

// ── dialogs, shell, screen ───────────────────────────────────────────────
type Box = { message?: string; detail?: string; buttons?: string[]; cancelId?: number; defaultId?: number; type?: string };
const boxOf = (args: unknown[]) => args[args.length - 1] as Box;
export const dialog = {
  showOpenDialog: () => resolved({ canceled: true, filePaths: [] as string[] }),
  showSaveDialog: () => resolved({ canceled: true, filePath: undefined }),
  // No one to ask here: a question takes its cancel answer (keeps things as they are); a box with
  // a single button is information, shown to the user by Workbench.
  showMessageBox: (...args: unknown[]) => {
    const box = boxOf(args);
    if ((box.buttons?.length ?? 1) <= 1 && box.message) notice([box.message, box.detail].filter(Boolean).join(" — "));
    return resolved({ response: box.cancelId ?? box.defaultId ?? 0, checkboxChecked: false });
  },
  showMessageBoxSync: (...args: unknown[]) => {
    const box = boxOf(args);
    return box.cancelId ?? box.defaultId ?? 0;
  },
  showErrorBox: (title: string, content: string) => notice(`${title} — ${content}`),
};

export const shell = {
  openExternal: () => resolved(undefined),
  openPath: () => resolved("Workbench에서는 열지 않습니다"),
  showItemInFolder: noop,
  trashItem: () => Promise.reject(new Error("not available")),
  beep: noop,
};

const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, workAreaSize: { width: 1920, height: 1080 }, scaleFactor: 1 };
export const screen = Object.assign(new EventEmitter(), {
  getPrimaryDisplay: () => display,
  getAllDisplays: () => [display],
  getDisplayMatching: () => display,
  getDisplayNearestPoint: () => display,
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
});
export const desktopCapturer = { getSources: () => resolved([]) };
export const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false, themeSource: "system" });
export const net = { fetch: (...args: Parameters<typeof fetch>) => fetch(...args), isOnline: () => true };
export const protocol = { registerSchemesAsPrivileged: noop, handle: noop, unhandle: noop, isProtocolHandled: () => false };

// ── images and clipboard ─────────────────────────────────────────────────
/** Width and height from an image header (PNG, JPEG, GIF, BMP, WebP); 0×0 when unknown. */
function imageSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length > 24 && view.getUint32(0) === 0x89504e47) return { width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length > 10 && text(0, 3) === "GIF") return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (bytes.length > 26 && text(0, 2) === "BM") return { width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) };
  if (bytes.length > 30 && text(0, 4) === "RIFF" && text(8, 12) === "WEBP") {
    const chunk = text(12, 16);
    const u24 = (at: number) => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
    if (chunk === "VP8X") return { width: 1 + u24(24), height: 1 + u24(27) };
    if (chunk === "VP8L") {
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) {
        at += 1;
        continue;
      }
      const marker = bytes[at + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
      at += 2 + view.getUint16(at + 2);
    }
  }
  return { width: 0, height: 0 };
}

class Image {
  private readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array = new Uint8Array()) {
    this.bytes = bytes;
  }
  isEmpty() {
    return this.bytes.length === 0;
  }
  getSize() {
    return imageSize(this.bytes);
  }
  getAspectRatio() {
    const { width, height } = this.getSize();
    return height ? width / height : 1;
  }
  toPNG() {
    return this.bytes;
  }
  toJPEG() {
    return this.bytes;
  }
  toDataURL() {
    let binary = "";
    for (let index = 0; index < this.bytes.length; index += 0x8000) binary += String.fromCharCode(...this.bytes.subarray(index, index + 0x8000));
    return `data:image/png;base64,${btoa(binary)}`;
  }
  resize() {
    return this;
  }
  crop() {
    return this;
  }
}
export const nativeImage = {
  createEmpty: () => new Image(),
  createFromBuffer: (bytes: Uint8Array) => new Image(new Uint8Array(bytes)),
  createFromDataURL: (url: string) => new Image(Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0))),
  createFromPath: () => new Image(),
  createThumbnailFromPath: () => resolved(new Image()),
};

// In-app copy and paste between slides works through this; other apps' clipboard is the page's.
const board = new Map<string, Uint8Array | string>();
export const clipboard = {
  readText: () => String(board.get("text/plain") ?? ""),
  writeText: (text: string) => {
    board.clear();
    board.set("text/plain", text);
  },
  readHTML: () => String(board.get("text/html") ?? ""),
  writeHTML: (html: string) => {
    board.clear();
    board.set("text/html", html);
  },
  readRTF: () => "",
  readImage: () => new Image(),
  writeImage: noop,
  readBuffer: (format: string) => {
    const value = board.get(format);
    return typeof value === "string" ? new TextEncoder().encode(value) : (value ?? new Uint8Array());
  },
  writeBuffer: (format: string, bytes: Uint8Array) => board.set(format, bytes),
  write: (data: { text?: string; html?: string }) => {
    board.clear();
    if (data.text !== undefined) board.set("text/plain", data.text);
    if (data.html !== undefined) board.set("text/html", data.html);
  },
  availableFormats: () => [...board.keys()],
  has: (format: string) => board.has(format),
  read: (format: string) => String(board.get(format) ?? ""),
  clear: () => board.clear(),
};

export default {
  app,
  ipcMain,
  webContents,
  WebContentsView,
  BrowserWindow,
  Menu,
  session,
  dialog,
  shell,
  screen,
  desktopCapturer,
  nativeTheme,
  net,
  protocol,
  nativeImage,
  clipboard,
};
