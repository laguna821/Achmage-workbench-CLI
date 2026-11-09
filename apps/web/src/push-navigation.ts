/** Small opaque navigation queue shared with the worker; never stores credentials or conversation data. */
export type PushOpenIntent = { id: string; hostId: string; token: string; createdAt: number };
const database = "workbench-push-navigation", storeName = "opens", lifetime = 7 * 86400_000;

export function pushIntentFromUrl(input: string, origin: string): PushOpenIntent | null {
  let url: URL; try { url = new URL(input); } catch { return null; }
  if (url.origin !== origin || url.username || url.password || !["https:", "http:"].includes(url.protocol)) return null;
  const params = new URLSearchParams(url.hash.slice(1)), hostId = params.get("pushHost"), token = params.get("pushLink");
  if (!hostId || !/^[A-Za-z0-9._:-]{1,200}$/.test(hostId) || !token || !/^[\w-]{43}$/.test(token)) return null;
  return { id: `${hostId}:${token}`, hostId, token, createdAt: Date.now() };
}

function openQueue(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: "id" }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("알림 이동 정보를 이 브라우저에 보관하지 못했습니다."));
    request.onblocked = () => reject(new Error("알림 보관함을 열지 못했습니다. 이전 Workbench 창을 닫고 다시 열어 주세요."));
  });
}
async function changeQueue(action: (store: IDBObjectStore) => void) {
  const db = await openQueue();
  try { await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(new Error("알림 이동 정보를 저장하지 못했습니다."));
    action(transaction.objectStore(storeName));
  }); } finally { db.close(); }
}
export async function rememberPushOpen(intent: PushOpenIntent) {
  await changeQueue(store => {
    const request = store.get(intent.id);
    request.onsuccess = () => { if (!request.result) store.put(intent); };
  });
}
export async function pendingPushOpens(): Promise<PushOpenIntent[]> {
  const db = await openQueue();
  let values: PushOpenIntent[];
  try { values = await new Promise((resolve, reject) => {
    const request = db.transaction(storeName).objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result as PushOpenIntent[]);
    request.onerror = () => reject(new Error("보관한 알림을 읽지 못했습니다."));
  }); } finally { db.close(); }
  const valid = values.filter(value => Number.isFinite(value.createdAt) && value.createdAt > Date.now() - lifetime).sort((a, b) => a.createdAt - b.createdAt).slice(-32);
  const keep = new Set(valid.map(value => value.id));
  if (values.some(value => !keep.has(value.id))) await changeQueue(store => { for (const value of values) if (!keep.has(value.id)) store.delete(value.id); });
  return valid;
}
export function forgetPushOpen(id: string) { return changeQueue(store => { store.delete(id); }); }
