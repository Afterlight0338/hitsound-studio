import type { Lane, OsuBeatmap, TimingPoint, Trigger } from '../types';

export interface CachedProjectData {
  title: string;
  artist: string;
  creator: string;
  audioFileName: string;
  lanes: Lane[];
  triggers: Trigger[];
  timingPoints: TimingPoint[];
  allBeatmaps: OsuBeatmap[];
  referenceVersion: string | null;
  savedAt: number;
}

export interface CachedSessionRecord {
  id: string; // always 'current'
  savedAt: number;
  project: CachedProjectData;
  songAudioBytes?: ArrayBuffer;
  laneSampleBytes?: Record<string, Uint8Array>; // custom sample files dropped on lanes
  zipEntries?: [string, Uint8Array][];
}

const DB_NAME = 'hitsound_studio_cache';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB is not available'));
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveSessionToCache(record: CachedSessionRecord): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[Cache] Could not save session to IndexedDB:', err);
  }
}

export async function loadSessionFromCache(): Promise<CachedSessionRecord | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get('current');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[Cache] Could not read session from IndexedDB:', err);
    return null;
  }
}

export async function clearSessionCache(): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete('current');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[Cache] Could not clear session cache from IndexedDB:', err);
  }
}
