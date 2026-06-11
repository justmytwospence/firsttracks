/**
 * IndexedDB plumbing shared by the DEM and azimuth stores.
 */

const DB_NAME = 'dem-cache';
// v4: azimuths store now holds raw Float32Array per band (no GeoTIFF round-trip).
// Old v3 records have Uint8Array (GeoTIFF) buffers; we drop & recreate the store on upgrade.
const DB_VERSION = 4;
export const STORE_NAME = 'tiles';
export const AZIMUTHS_STORE_NAME = 'azimuths';
export const INDIVIDUAL_TILES_STORE_NAME = 'individual_tiles';  // z/x/y tiles

/**
 * Open IndexedDB for DEM caching.
 * Memoized: subsequent calls return the same connection promise.
 */
let dbPromise: Promise<IDBDatabase> | null = null;
export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
    request.onsuccess = () => {
      const db = request.result;
      // Reset the cached promise if the connection closes (e.g. from a version change in another tab)
      db.onclose = () => { dbPromise = null; };
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const oldVersion = event.oldVersion;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
      // v3 -> v4: azimuth records changed shape (Float32Array per band, no GeoTIFF).
      // Drop and recreate so we don't carry stale Uint8Array data.
      if (oldVersion < 4 && db.objectStoreNames.contains(AZIMUTHS_STORE_NAME)) {
        db.deleteObjectStore(AZIMUTHS_STORE_NAME);
      }
      if (!db.objectStoreNames.contains(AZIMUTHS_STORE_NAME)) {
        const azimuthsStore = db.createObjectStore(AZIMUTHS_STORE_NAME, { keyPath: 'key' });
        azimuthsStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
      if (!db.objectStoreNames.contains(INDIVIDUAL_TILES_STORE_NAME)) {
        const individualTilesStore = db.createObjectStore(INDIVIDUAL_TILES_STORE_NAME, { keyPath: 'key' });
        individualTilesStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
  });
  return dbPromise;
}

/**
 * Get cached DEM tile

/**
 * Put a record, resolving only when the transaction commits (the actual
 * durability point - request.onsuccess can fire and the transaction still
 * abort on quota).
 */
export async function putRecord(storeName: string, record: unknown): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put(record as never);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
