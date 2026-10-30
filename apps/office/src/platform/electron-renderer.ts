// What IeumOffice's preload (the editor's window API, used unchanged) imports from Electron, in the
// editor page: its IPC goes to the page's own transport (the editor's worker, plus answers the page
// gives itself), and only the editor's own bridge is exposed — not its AI, project or file bridges.

type Listener = (event: { sender: unknown }, ...args: unknown[]) => void;
export type Transport = {
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  send(channel: string, args: unknown[]): void;
};

let transport: Transport | null = null;
export function useTransport(next: Transport) {
  transport = next;
}

const listeners = new Map<string, Set<Listener>>();

/** Deliver a main-process message (`webContents.send`) to the editor's listeners. */
export function dispatch(channel: string, args: unknown[]) {
  for (const listener of [...(listeners.get(channel) ?? [])]) {
    try {
      listener({ sender: ipcRenderer }, ...args);
    } catch (error) {
      console.error(`[workbench office] ${channel} listener failed`, error);
    }
  }
}

export const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]) {
    if (!transport) return Promise.reject(new Error("편집기가 아직 준비되지 않았습니다."));
    return transport.invoke(channel, args);
  },
  send(channel: string, ...args: unknown[]) {
    transport?.send(channel, args);
  },
  sendSync() {
    return undefined;
  },
  on(channel: string, listener: Listener) {
    let set = listeners.get(channel);
    if (!set) listeners.set(channel, (set = new Set()));
    set.add(listener);
    return ipcRenderer;
  },
  once(channel: string, listener: Listener) {
    const wrapped: Listener = (event, ...args) => {
      ipcRenderer.removeListener(channel, wrapped);
      listener(event, ...args);
    };
    return ipcRenderer.on(channel, wrapped);
  },
  removeListener(channel: string, listener: Listener) {
    listeners.get(channel)?.delete(listener);
    return ipcRenderer;
  },
  off(channel: string, listener: Listener) {
    return ipcRenderer.removeListener(channel, listener);
  },
  removeAllListeners(channel?: string) {
    if (channel) listeners.delete(channel);
    else listeners.clear();
    return ipcRenderer;
  },
  postMessage() {},
};

/** The editor's own API only (`slidesApi`, `desktopApi`); its AI, Drive, skills, project and file bridges stay out. */
const EXPOSED = new Set(["slidesApi", "desktopApi", "pdfApi", "mindmapApi", "epubApi"]);
export const contextBridge = {
  exposeInMainWorld(key: string, api: unknown) {
    if (EXPOSED.has(key)) (window as unknown as Record<string, unknown>)[key] = api;
  },
};

export const webUtils = { getPathForFile: () => "" };

export default { ipcRenderer, contextBridge, webUtils };
