/**
 * Unsaved editor buffers, kept in IndexedDB because they can be megabytes of
 * text: localStorage holds about 5 MB per origin and would have to serialise
 * every buffer on every keystroke.
 *
 * Keys are `<folder>\u0000<relative path>`, so a folder's buffers sit in one key
 * range and one file's write never touches another's.
 */
const DB_NAME = "acpio-editor";
const STORE = "buffers";

const fold = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
const keyOf = (root: string, path: string) => `${fold(root)}\u0000${path}`;

let opening: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    // Private windows and ancient browsers have none: the editor works without it.
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  return opening;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise<T | null>((resolve) => {
    const request = run(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => resolve(null);
  });
}

export async function saveBuffer(root: string, path: string, text: string): Promise<void> {
  await withStore("readwrite", (store) => store.put({ text, savedAt: Date.now() }, keyOf(root, path)));
}

export async function dropBuffer(root: string, path: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(keyOf(root, path)));
}

/** The stored text of the given files, keyed by relative path. */
export async function loadBuffers(root: string, paths: string[]): Promise<Map<string, string>> {
  const texts = await Promise.all(
    paths.map(async (path) => {
      const record = await withStore<{ text?: string }>("readonly", (store) => store.get(keyOf(root, path)));
      return [path, record?.text] as const;
    }),
  );
  const buffers = new Map<string, string>();
  for (const [path, text] of texts) if (typeof text === "string") buffers.set(path, text);
  return buffers;
}

/** Ask the browser to keep this data instead of evicting it under disk pressure. */
export function requestPersistence(): void {
  void navigator.storage?.persist?.();
}
