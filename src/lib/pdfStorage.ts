import type { RemovedImageRecord } from '@/app/editor/types';

const DB_NAME = 'pdf-editor-db';
const DB_VERSION = 2;
const STORE_NAME = 'pdf-files';
const PDF_KEY = 'current-pdf';
const SESSION_KEY = 'editor-session';
const REMOVED_IMAGES_KEY = 'removed-images';

export interface StoredPdf {
  bytes: ArrayBuffer;
  fileName: string;
}

export interface EditorSessionOverlay {
  drawnPathsJson: string;
  floatingTextsJson: string;
  floatingImagesJson: string;
  signaturesJson: string;
  removedImagesJson?: string;
  currentPage: number;
}

export interface EditorSessionRecord {
  bytes: ArrayBuffer;
  fileName: string;
  updatedAt: number;
  overlays: EditorSessionOverlay;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function savePdfToStorage(bytes: ArrayBuffer, fileName: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ bytes, fileName }, PDF_KEY);
    // New upload replaces any prior dirty session and previous removed images
    store.delete(SESSION_KEY);
    store.delete(REMOVED_IMAGES_KEY);
    try {
      localStorage.removeItem('bloom_removed_images');
      localStorage.removeItem('bloom_editor_session');
    } catch {}
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadPdfFromStorage(): Promise<StoredPdf | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(PDF_KEY);
    req.onsuccess = () => resolve((req.result as StoredPdf) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function clearPdfFromStorage(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(PDF_KEY);
    store.delete(SESSION_KEY);
    store.delete(REMOVED_IMAGES_KEY);
    try {
      localStorage.removeItem('bloom_removed_images');
      localStorage.removeItem('bloom_editor_session');
    } catch {}
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveEditorSession(session: EditorSessionRecord): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(session, SESSION_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadEditorSession(): Promise<EditorSessionRecord | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(SESSION_KEY);
    req.onsuccess = () => resolve((req.result as EditorSessionRecord) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function clearEditorSession(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(SESSION_KEY);
    store.delete(REMOVED_IMAGES_KEY);
    try {
      localStorage.removeItem('bloom_removed_images');
      localStorage.removeItem('bloom_editor_session');
    } catch {}
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function deduplicateRemovedImages(images: RemovedImageRecord[]): RemovedImageRecord[] {
  if (!Array.isArray(images)) return [];
  const seen = new Set<string>();
  const deduped: RemovedImageRecord[] = [];
  for (const img of images) {
    if (!img) continue;
    const key = img.dataUrl || img.id;
    if (key && !seen.has(key)) {
      seen.add(key);
      deduped.push(img);
    }
  }
  return deduped;
}

export async function saveRemovedImages(images: RemovedImageRecord[]): Promise<void> {
  const clean = deduplicateRemovedImages(images);
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(clean, REMOVED_IMAGES_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    try {
      localStorage.setItem('bloom_removed_images', JSON.stringify(clean));
    } catch {
      // Ignore quota error if any
    }
  }
}

export async function loadRemovedImages(): Promise<RemovedImageRecord[]> {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(REMOVED_IMAGES_KEY);
      req.onsuccess = () => resolve(deduplicateRemovedImages((req.result as RemovedImageRecord[] | undefined) ?? []));
      req.onerror = () => {
        try {
          const fallback = localStorage.getItem('bloom_removed_images');
          resolve(deduplicateRemovedImages(fallback ? JSON.parse(fallback) : []));
        } catch {
          resolve([]);
        }
      };
    });
  } catch {
    try {
      const fallback = localStorage.getItem('bloom_removed_images');
      return deduplicateRemovedImages(fallback ? JSON.parse(fallback) : []);
    } catch {
      return [];
    }
  }
}

export async function clearRemovedImages(): Promise<void> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(REMOVED_IMAGES_KEY);
      try {
        localStorage.removeItem('bloom_removed_images');
      } catch {}
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    try {
      localStorage.removeItem('bloom_removed_images');
    } catch {}
  }
}
