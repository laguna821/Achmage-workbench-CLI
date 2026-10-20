import { LocalStorageError, LocalStorageFullError, type LocalAsset, type LocalDesign } from './types'

/** Minimal async key-value contract used by the repository; IndexedDB and in-memory implementations. */
export interface LocalStore {
  listDesigns(): Promise<LocalDesign[]>
  getDesign(id: string): Promise<LocalDesign | undefined>
  putDesign(design: LocalDesign): Promise<void>
  deleteDesign(id: string): Promise<void>
  listAssets(): Promise<LocalAsset[]>
  getAsset(id: string): Promise<LocalAsset | undefined>
  putAsset(asset: LocalAsset): Promise<void>
  deleteAsset(id: string): Promise<void>
  clear(): Promise<void>
}

export const DB_NAME = 'doory-local'
export const DB_VERSION = 1
const DESIGNS = 'designs'
const ASSETS = 'assets'

function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'QuotaExceededError' || error.code === 22)
}

/** Maps low-level failures onto the two errors the UI understands. */
export function mapStorageError(error: unknown): Error {
  if (isQuotaError(error)) return new LocalStorageFullError()
  if (error instanceof LocalStorageError || error instanceof LocalStorageFullError) return error
  return new LocalStorageError(undefined, { cause: error })
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'))
  })
}

export function openDatabase(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let opening: IDBOpenDBRequest
    try {
      opening = factory.open(DB_NAME, DB_VERSION)
    } catch (error) {
      reject(error)
      return
    }
    opening.onupgradeneeded = () => {
      const db = opening.result
      if (!db.objectStoreNames.contains(DESIGNS)) db.createObjectStore(DESIGNS, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS, { keyPath: 'id' })
    }
    opening.onsuccess = () => resolve(opening.result)
    opening.onerror = () => reject(opening.error)
    opening.onblocked = () => reject(new DOMException('Database blocked', 'InvalidStateError'))
  })
}

export function createIndexedDbStore(db: IDBDatabase): LocalStore {
  db.onversionchange = () => db.close()

  async function put(storeName: string, value: unknown): Promise<void> {
    try {
      const tx = db.transaction(storeName, 'readwrite')
      tx.objectStore(storeName).put(value)
      await transactionDone(tx)
    } catch (error) {
      throw mapStorageError(error)
    }
  }
  async function remove(storeName: string, id: string): Promise<void> {
    try {
      const tx = db.transaction(storeName, 'readwrite')
      tx.objectStore(storeName).delete(id)
      await transactionDone(tx)
    } catch (error) {
      throw mapStorageError(error)
    }
  }
  const readAll = async <T>(storeName: string): Promise<T[]> => request<T[]>(db.transaction(storeName, 'readonly').objectStore(storeName).getAll())
  const readOne = async <T>(storeName: string, id: string): Promise<T | undefined> => request<T | undefined>(db.transaction(storeName, 'readonly').objectStore(storeName).get(id))

  return {
    listDesigns: () => readAll<LocalDesign>(DESIGNS),
    getDesign: (id) => readOne<LocalDesign>(DESIGNS, id),
    putDesign: (design) => put(DESIGNS, design),
    deleteDesign: (id) => remove(DESIGNS, id),
    listAssets: () => readAll<LocalAsset>(ASSETS),
    getAsset: (id) => readOne<LocalAsset>(ASSETS, id),
    putAsset: (asset) => put(ASSETS, asset),
    deleteAsset: (id) => remove(ASSETS, id),
    async clear() {
      const tx = db.transaction([DESIGNS, ASSETS], 'readwrite')
      tx.objectStore(DESIGNS).clear()
      tx.objectStore(ASSETS).clear()
      await transactionDone(tx)
    },
  }
}

/** Used when IndexedDB is unavailable (private mode, blocked storage): data lives until the tab closes. */
export function createMemoryStore(): LocalStore {
  const designs = new Map<string, LocalDesign>()
  const assets = new Map<string, LocalAsset>()
  return {
    listDesigns: async () => [...designs.values()],
    getDesign: async (id) => designs.get(id),
    putDesign: async (design) => {
      designs.set(design.id, design)
    },
    deleteDesign: async (id) => {
      designs.delete(id)
    },
    listAssets: async () => [...assets.values()],
    getAsset: async (id) => assets.get(id),
    putAsset: async (asset) => {
      assets.set(asset.id, asset)
    },
    deleteAsset: async (id) => {
      assets.delete(id)
    },
    clear: async () => {
      designs.clear()
      assets.clear()
    },
  }
}
