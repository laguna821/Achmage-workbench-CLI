// Unsaved edits kept in the browser while an editor has them (the editors' crash-recovery copy),
// one per document, with the revision they were made on. The gateway keeps the same port across
// launches, so they survive closing the app; a save or "open the latest revision" removes them.

export type Kept = { baseRevision: number; bytes: ArrayBuffer; at: number };

const DB = "workbench-office";
const STORE = "recovery";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result as T);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export const recovery = {
  get: (artifactId: string) => run<Kept | undefined>("readonly", (store) => store.get(artifactId)),
  put: (artifactId: string, kept: Kept) => run<void>("readwrite", (store) => store.put(kept, artifactId)),
  drop: (artifactId: string) => run<void>("readwrite", (store) => store.delete(artifactId)),
};
