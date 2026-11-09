import { pushIntentFromUrl, rememberPushOpen } from "./push-navigation.ts";

// Keep the worker's types local: the UI compilation uses DOM, not global WebWorker declarations.
type WorkerClient = { id: string; url: string; focus(): Promise<WorkerClient>; postMessage(value: unknown): void };
type Extendable = { waitUntil(task: Promise<unknown>): void };
type PushEvent = Extendable & { data?: { json(): unknown } | null };
type ClickEvent = Extendable & { notification: { data: unknown; close(): void } };
type WorkerRuntime = {
  location: Location;
  registration: ServiceWorkerRegistration;
  clients: { matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<WorkerClient[]>; openWindow(url: string): Promise<WorkerClient | null>; claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate" | "pushsubscriptionchange", listener: (event: Extendable) => void): void;
  addEventListener(type: "push", listener: (event: PushEvent) => void): void;
  addEventListener(type: "notificationclick", listener: (event: ClickEvent) => void): void;
};
const worker = globalThis as unknown as WorkerRuntime;
const bodies = new Set(["작업이 완료되었습니다.", "작업을 마치지 못했습니다.", "확인이 필요한 작업이 있습니다."]);

worker.addEventListener("install", event => event.waitUntil(worker.skipWaiting()));
worker.addEventListener("activate", event => event.waitUntil(worker.clients.claim()));
worker.addEventListener("push", event => {
  let data: unknown; try { data = event.data?.json(); } catch { return; }
  if (!data || typeof data !== "object") return;
  const value = data as { type?: unknown; link?: unknown; body?: unknown };
  if (value.type !== "workbench.attention" || typeof value.link !== "string") return;
  const intent = pushIntentFromUrl(value.link, worker.location.origin);
  if (!intent) return;
  const body = typeof value.body === "string" && bodies.has(value.body) ? value.body : "Workbench에서 확인할 알림이 있습니다.";
  event.waitUntil(worker.registration.showNotification("Achmage Workbench", { body, tag: intent.id, icon: "/workbench-icon.png", data: { link: value.link } }));
});
worker.addEventListener("notificationclick", event => {
  event.notification.close();
  const link = (event.notification.data as { link?: unknown } | null)?.link;
  if (typeof link !== "string") return;
  const intent = pushIntentFromUrl(link, worker.location.origin);
  if (!intent) return;
  event.waitUntil((async () => {
    // Persist first. Neither a sleeping client nor a missing host credential loses the target.
    try { await rememberPushOpen(intent); } catch { /* The cold URL remains a recovery path. */ }
    const url = new URL(link), clients = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = clients.find(client => { try { const current = new URL(client.url); return current.origin === url.origin && current.pathname === url.pathname; } catch { return false; } });
    if (existing) {
      try { await existing.focus(); existing.postMessage({ type: "workbench:push-open", link }); return; } catch { /* Closed between enumeration and focus. */ }
    }
    await worker.clients.openWindow(link);
  })());
});
worker.addEventListener("pushsubscriptionchange", event => {
  // A worker never receives the host credential. Renewal requires the approved foreground connection.
  event.waitUntil((async () => {
    for (const client of await worker.clients.matchAll({ type: "window", includeUncontrolled: true })) client.postMessage({ type: "workbench:push-subscription-changed" });
  })());
});
// No fetch handler: API responses, media, credentials and conversation state stay out of worker caches.
