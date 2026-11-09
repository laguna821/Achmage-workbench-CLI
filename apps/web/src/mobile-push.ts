import type { Api } from "./api.ts";
import type { PushOpenResult, PushStatus, PushSubscriptionInput } from "../../../packages/contracts/src/push.ts";
import { forgetPushOpen, pendingPushOpens, pushIntentFromUrl, rememberPushOpen, type PushOpenIntent } from "./push-navigation.ts";
import workerUrl from "./mobile-worker.ts?worker&url";
export type { PushOpenIntent } from "./push-navigation.ts";

const acknowledgeEvent = "workbench:push-acknowledged";
export function pushCapability(): string | null {
  if (!window.isSecureContext) return "모바일 알림은 HTTPS로 연 앱에서 사용할 수 있습니다.";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "이 브라우저는 웹 푸시를 지원하지 않습니다. iPhone·iPad에서는 홈 화면에 추가한 앱에서 열어 주세요.";
  return null;
}
function trustedWorker(event: MessageEvent) {
  const source = event.source as ServiceWorker | null;
  if (!source || typeof source.scriptURL !== "string") return false;
  const url = new URL(source.scriptURL);
  // Existing notifications may belong to the previous hashed worker after an app update.
  return url.origin === location.origin && (url.href === new URL(workerUrl, location.href).href || /^\/assets\/mobile-worker-[A-Za-z0-9_-]+\.js$/.test(url.pathname));
}
const hostScope = (hostId: string) => `/__workbench_push/${encodeURIComponent(hostId)}/`;
async function registeredHostWorker(hostId: string) {
  const scope = new URL(hostScope(hostId), location.origin).href;
  const registration = await navigator.serviceWorker.getRegistration(scope);
  // getRegistration otherwise falls back to the root worker, which can own a different subscription.
  return registration?.scope === scope ? registration : undefined;
}
export async function registerMobileWorker(hostId?: string): Promise<ServiceWorkerRegistration> {
  const unavailable = pushCapability(); if (unavailable) throw new Error(unavailable);
  // Each host has its own VAPID key. Separate scopes avoid replacing another host's subscription.
  const scope = hostId ? hostScope(hostId) : "/";
  const registration = await navigator.serviceWorker.register(workerUrl, { type: "module", scope });
  if (registration.active) return registration;
  await new Promise<void>((resolve, reject) => {
    const worker = registration.installing ?? registration.waiting;
    if (!worker) { reject(new Error("알림 수신기를 설치하지 못했습니다.")); return; }
    const timeout = setTimeout(() => { worker.removeEventListener("statechange", changed); reject(new Error("알림 수신기 준비 시간이 초과되었습니다.")); }, 15000);
    const changed = () => {
      if (worker.state !== "activated" && worker.state !== "redundant") return;
      clearTimeout(timeout); worker.removeEventListener("statechange", changed);
      if (worker.state === "activated") resolve(); else reject(new Error("알림 수신기 설치가 중단되었습니다."));
    };
    worker.addEventListener("statechange", changed); changed();
  });
  return registration;
}

/** Reuses a warm window; the caller chooses the authenticated host and acknowledges only actual navigation. */
export function watchPushOpen(onOpen: (intent: PushOpenIntent) => void, onError?: (error: unknown) => void): () => void {
  let active = true, currentId: string | null = null, draining = false;
  const report = (error: unknown) => { if (active) onError?.(error); };
  const drain = async () => {
    if (!active || currentId || draining) return;
    draining = true;
    try { const [next] = await pendingPushOpens(); if (active && !currentId && next) { currentId = next.id; onOpen(next); } }
    catch (error) { report(error); } finally { draining = false; }
  };
  const receive = async (link: string, fromLocation = false) => {
    const intent = pushIntentFromUrl(link, location.origin); if (!intent) return;
    try {
      await rememberPushOpen(intent);
      if (fromLocation && active && location.href === link) {
        const url = new URL(location.href), hash = new URLSearchParams(url.hash.slice(1)); hash.delete("pushHost"); hash.delete("pushLink"); url.hash = hash.toString();
        history.replaceState(history.state, "", url.href);
      }
      await drain();
    } catch (error) {
      report(error);
      // Keep the original hash if durable storage is unavailable, while allowing this window to open it.
      if (active && !currentId) { currentId = intent.id; onOpen(intent); }
    }
  };
  const message = (event: MessageEvent) => {
    if (!trustedWorker(event) || event.data?.type !== "workbench:push-open" || typeof event.data.link !== "string") return;
    void receive(event.data.link);
  };
  const acknowledged = (event: Event) => { if ((event as CustomEvent<string>).detail === currentId) { currentId = null; void drain(); } };
  const foreground = () => { if (!document.hidden) void drain(); };
  const hashChanged = () => { void receive(location.href, true); };
  navigator.serviceWorker?.addEventListener("message", message);
  window.addEventListener(acknowledgeEvent, acknowledged); window.addEventListener("hashchange", hashChanged); window.addEventListener("focus", foreground); document.addEventListener("visibilitychange", foreground);
  void (async () => { await receive(location.href, true); await drain(); })();
  return () => { active = false; navigator.serviceWorker?.removeEventListener("message", message); window.removeEventListener(acknowledgeEvent, acknowledged); window.removeEventListener("hashchange", hashChanged); window.removeEventListener("focus", foreground); document.removeEventListener("visibilitychange", foreground); };
}
export async function resolvePushOpen(api: Pick<Api, "request">, intent: PushOpenIntent): Promise<PushOpenResult> {
  const result = await api.request<PushOpenResult>("POST", "/api/push/links/resolve", { token: intent.token });
  if (!/^[a-f0-9]{64}$/.test(result.attentionId) || result.target.hostId !== intent.hostId || result.target.taskRef.hostId !== intent.hostId || result.target.taskRef.sessionId !== result.target.sessionId) throw new Error("알림의 호스트 또는 원문 대상이 다릅니다. 기기 연결을 확인해 주세요.");
  return result;
}
export async function acknowledgePushOpen(intent: PushOpenIntent) {
  await forgetPushOpen(intent.id);
  window.dispatchEvent(new CustomEvent(acknowledgeEvent, { detail: intent.id }));
}
function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}
function sameKey(subscription: PushSubscription, publicKey: string) {
  const existing = subscription.options.applicationServerKey, expected = applicationServerKey(publicKey);
  if (!existing) return false;
  const bytes = new Uint8Array(existing); return bytes.length === expected.length && bytes.every((value, index) => value === expected[index]);
}
async function saveSubscription(api: Pick<Api, "request">, status: PushStatus, subscription: PushSubscription) {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error("이 브라우저의 구독 키를 읽지 못했습니다.");
  const input: PushSubscriptionInput = { subscription: { endpoint: json.endpoint, expirationTime: json.expirationTime, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } }, appUrl: location.origin + location.pathname, keyVersion: status.keyVersion };
  return api.request<PushStatus>("PUT", "/api/push/subscription", input);
}
/** Invoke from the user's button: permission and provider registration are never requested on app startup. */
export async function enableMobilePush(api: Pick<Api, "request">, status: PushStatus): Promise<PushStatus> {
  const unavailable = pushCapability(); if (unavailable) throw new Error(unavailable);
  if (!status.enabled || !status.publicKey) throw new Error("호스트 PC에서 모바일 알림 발송을 먼저 켜 주세요.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("알림 권한이 허용되지 않았습니다. 브라우저 설정에서 이 앱의 권한을 확인해 주세요.");
  const registration = await registerMobileWorker(status.hostId);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription, status.publicKey)) { await subscription.unsubscribe(); subscription = null; }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(status.publicKey) });
  return saveSubscription(api, status, subscription);
}
export async function disableMobilePush(api: Pick<Api, "request">, hostId: string): Promise<PushStatus> {
  // Revoke at the authenticated host before discarding the browser's registration.
  const status = await api.request<PushStatus>("DELETE", "/api/push/subscription");
  if ("serviceWorker" in navigator) {
    const registration = await registeredHostWorker(hostId);
    if (registration) { const subscription = await registration.pushManager.getSubscription(); await subscription?.unsubscribe(); }
  }
  return status;
}
/** Existing opt-in only; no subscribe/requestPermission here. Renew when a connected app returns to the foreground. */
export function watchMobilePushLease(api: Pick<Api, "request">, hostId: string, onStatus?: (status: PushStatus) => void, onError?: (error: unknown) => void) {
  let active = true, busy = false, last = 0;
  const renew = async (force = false) => {
    if (!active || busy || document.hidden || pushCapability() || (!force && Date.now() - last < 60_000)) return;
    busy = true; last = Date.now();
    try {
      const status = await api.request<PushStatus>("GET", "/api/push");
      if (status.hostId !== hostId) throw new Error("알림 구독의 호스트가 다릅니다.");
      if (!active) return;
      if (!status.enabled || !status.device?.enabled) { onStatus?.(status); return; }
      if (Notification.permission !== "granted") { const disabled = await api.request<PushStatus>("DELETE", "/api/push/subscription"); if (active) onStatus?.(disabled); return; }
      const registration = await registeredHostWorker(hostId), subscription = await registration?.pushManager.getSubscription();
      if (!subscription || !status.publicKey || !sameKey(subscription, status.publicKey)) { onStatus?.(status); throw new Error("브라우저 알림 구독이 바뀌었습니다. 모바일 알림에서 다시 등록해 주세요."); }
      const renewed = await saveSubscription(api, status, subscription); if (active) onStatus?.(renewed);
    } catch (error) { if (active) onError?.(error); } finally { busy = false; }
  };
  const foreground = () => { void renew(); }, changed = (event: MessageEvent) => { if (trustedWorker(event) && event.data?.type === "workbench:push-subscription-changed") void renew(true); };
  window.addEventListener("focus", foreground); document.addEventListener("visibilitychange", foreground); navigator.serviceWorker?.addEventListener("message", changed);
  const timer = setInterval(foreground, 12 * 3600_000); void renew();
  return () => { active = false; clearInterval(timer); window.removeEventListener("focus", foreground); document.removeEventListener("visibilitychange", foreground); navigator.serviceWorker?.removeEventListener("message", changed); };
}
