/** 存储适配：IndexedDB（主）+ 内存降级（Firefox 私密模式等场景）。 */

export interface KVStorage {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  del(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
  /** true = 降级内存（刷新即失，UI 应提示导出） */
  readonly degraded: boolean;
}

export class MemoryStorage implements KVStorage {
  readonly degraded = true;
  private map = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.map.set(key, value);
  }
  async del(key: string): Promise<void> {
    this.map.delete(key);
  }
  async keys(prefix: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }
}

/** 打开 IDB KV 存储；任何失败（私密模式/配额/禁用）都降级为内存实现，永不 reject。 */
export function openIdbStorage(dbName: string): Promise<KVStorage> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(new MemoryStorage());
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(dbName, 1);
    } catch {
      resolve(new MemoryStorage());
      return;
    }
    const fail = (): void => resolve(new MemoryStorage());
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = (mode: IDBTransactionMode): IDBTransaction => db.transaction('kv', mode);
      const store = (mode: IDBTransactionMode): IDBObjectStore => tx(mode).objectStore('kv');
      resolve({
        degraded: false,
        async get<T>(key: string): Promise<T | undefined> {
          return new Promise((res, rej) => {
            const r = store('readonly').get(key);
            r.onsuccess = () => res(r.result as T | undefined);
            r.onerror = () => rej(r.error);
          });
        },
        async set<T>(key: string, value: T): Promise<void> {
          return new Promise((res, rej) => {
            const t = tx('readwrite');
            t.objectStore('kv').put(value, key);
            t.oncomplete = () => res();
            t.onerror = () => rej(t.error);
            t.onabort = () => rej(t.error);
          });
        },
        async del(key: string): Promise<void> {
          return new Promise((res, rej) => {
            const t = tx('readwrite');
            t.objectStore('kv').delete(key);
            t.oncomplete = () => res();
            t.onerror = () => rej(t.error);
          });
        },
        async keys(prefix: string): Promise<string[]> {
          return new Promise((res, rej) => {
            const r = store('readonly').getAllKeys();
            r.onsuccess = () => res((r.result as IDBValidKey[]).filter((k) => String(k).startsWith(prefix)).map(String));
            r.onerror = () => rej(r.error);
          });
        },
      });
    };
    req.onerror = fail;
    req.onblocked = fail;
  });
}

/** 尝试请求持久化存储（避免 best-effort 逐出）；失败静默。 */
export function requestPersistent(): void {
  try {
    void navigator.storage?.persist?.();
  } catch {
    /* ignore */
  }
}

// ---------- 设置（localStorage，同步可用） ----------

const SETTINGS_PREFIX = 'yanagi:settings:';

export function loadSettingsJson<T>(gameId: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(SETTINGS_PREFIX + gameId);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as object) } as T;
  } catch {
    return fallback;
  }
}

export function saveSettingsJson(gameId: string, value: unknown): void {
  try {
    localStorage.setItem(SETTINGS_PREFIX + gameId, JSON.stringify(value));
  } catch {
    /* 私密模式等：静默 */
  }
}
