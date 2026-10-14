export const MAX_RECORDING_BYTES = 25 * 1024 * 1024;

export interface RecordingDraft {
  readonly audio: Blob;
  readonly message?: string;
  // Already inserted into the prompt; a failed Send retries without duplicating words.
  readonly transcript?: string | undefined;
}

// Audio belongs to the draft, not to a mounted composer. The memory copy also
// keeps navigation safe where IndexedDB is unavailable (private browser policy).
const drafts = new Map<string, RecordingDraft | null>();
const listeners = new Map<string, Set<(draft: RecordingDraft | null) => void>>();

export function subscribeRecordingDraft(
  key: string,
  listener: (draft: RecordingDraft | null) => void,
): () => void {
  let group = listeners.get(key);
  if (!group) listeners.set(key, (group = new Set()));
  group.add(listener);
  return () => {
    group?.delete(listener);
    if (group?.size === 0) listeners.delete(key);
  };
}

let database: Promise<IDBDatabase> | undefined;
let writes = Promise.resolve();

function openDatabase(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("t3code-voice-drafts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("recordings");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

export async function readRecordingDraft(key: string): Promise<RecordingDraft | null> {
  if (drafts.has(key)) return drafts.get(key) ?? null;
  if (typeof indexedDB === "undefined") return null;
  try {
    await writes;
    const db = await openDatabase();
    const value = await new Promise<RecordingDraft | undefined>((resolve, reject) => {
      const request = db.transaction("recordings").objectStore("recordings").get(key);
      request.onsuccess = () => resolve(request.result as RecordingDraft | undefined);
      request.onerror = () => reject(request.error);
    });
    if (drafts.has(key)) return drafts.get(key) ?? null;
    if (value?.audio instanceof Blob && value.audio.size <= MAX_RECORDING_BYTES) {
      drafts.set(key, value);
      return value;
    }
  } catch {
    // Navigation still retains the in-memory copy when browser storage fails.
  }
  return null;
}

export function writeRecordingDraft(key: string, value: RecordingDraft | null): void {
  if (value && value.audio.size > MAX_RECORDING_BYTES) return;
  drafts.set(key, value);
  listeners.get(key)?.forEach((listener) => listener(value));
  if (typeof indexedDB === "undefined") return;
  writes = writes
    .then(async () => {
      const db = await openDatabase();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("recordings", "readwrite");
        const store = transaction.objectStore("recordings");
        if (value) store.put(value, key);
        else store.delete(key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    })
    .catch(() => {});
}
