/**
 * Azimuth store: cached Sobel azimuth/gradient/runout bands keyed by bounds.
 */

import { AZIMUTHS_STORE_NAME, openDB, putRecord } from './idb';
import { type Bounds, boundsContain, boundsToKey, normalizeBounds } from './tile-math';

interface CachedAzimuths {
  key: string;
  bounds: Bounds;
  /** Raw Float32Array per band, all keyed by row-major width*height. */
  elevations: ArrayBuffer;
  azimuths: ArrayBuffer;
  gradients: ArrayBuffer;
  /** Combined runout zones (Float32Array, intensity 0..1+) for current aspect selection. */
  runout_zones?: ArrayBuffer;
  width: number;
  height: number;
  timestamp: number;
}

/**
 * Generate a cache key for azimuths.
 */
function azimuthCacheKey(bounds: Bounds): string {
  const baseKey = boundsToKey(bounds);
  return `${baseKey}_azimuths`;
}

export interface AzimuthData {
  /** Row-major width*height f32 per band. Same shape as the WASM output. */
  elevations: Float32Array;
  azimuths: Float32Array;
  gradients: Float32Array;
  /** Combined runout intensity (0..1+) for current aspect selection. Empty/undefined = no aspects excluded. */
  runout_zones?: Float32Array;
  width: number;
  height: number;
  bounds: Bounds;
}

/**
 * Get cached azimuths for bounds.
 * Runout zones are pre-computed for all aspects.
 */
export async function getCachedAzimuths(bounds: Bounds): Promise<AzimuthData | null> {
  try {
    const db = await openDB();
    const normalizedBounds = normalizeBounds(bounds);
    const key = azimuthCacheKey(normalizedBounds);

    return new Promise((resolve) => {
      const transaction = db.transaction(AZIMUTHS_STORE_NAME, 'readonly');
      const store = transaction.objectStore(AZIMUTHS_STORE_NAME);
      const request = store.get(key);

      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const result = request.result as CachedAzimuths | undefined;
        if (result) {
          resolve({
            elevations: new Float32Array(result.elevations),
            azimuths: new Float32Array(result.azimuths),
            gradients: new Float32Array(result.gradients),
            runout_zones: result.runout_zones ? new Float32Array(result.runout_zones) : undefined,
            width: result.width,
            height: result.height,
            bounds: result.bounds,
          });
        } else {
          resolve(null);
        }
      };
    });
  } catch {
    return null;
  }
}
/**
 * Find cached azimuths that contain the requested bounds.
 */
export async function findContainingCachedAzimuths(bounds: Bounds): Promise<AzimuthData | null> {
  try {
    const db = await openDB();
    const normalizedBounds = normalizeBounds(bounds);

    return new Promise((resolve) => {
      const transaction = db.transaction(AZIMUTHS_STORE_NAME, 'readonly');
      const store = transaction.objectStore(AZIMUTHS_STORE_NAME);
      const request = store.openCursor();

      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const cached = cursor.value as CachedAzimuths;
          if (boundsContain(cached.bounds, normalizedBounds)) {
            resolve({
              elevations: new Float32Array(cached.elevations),
              azimuths: new Float32Array(cached.azimuths),
              gradients: new Float32Array(cached.gradients),
              runout_zones: cached.runout_zones ? new Float32Array(cached.runout_zones) : undefined,
              width: cached.width,
              height: cached.height,
              bounds: cached.bounds,
            });
            return;
          }
          cursor.continue();
        } else {
          resolve(null);
        }
      };
    });
  } catch {
    return null;
  }
}

/**
 * Find cached azimuths that contain the requested bounds
 * Returns the bounds of the cached azimuths if found, null otherwise
 */
export async function findCachedAzimuthBoundsContaining(bounds: Bounds): Promise<Bounds | null> {
  try {
    const db = await openDB();
    const normalizedBounds = normalizeBounds(bounds);
    
    return new Promise((resolve) => {
      const transaction = db.transaction(AZIMUTHS_STORE_NAME, 'readonly');
      const store = transaction.objectStore(AZIMUTHS_STORE_NAME);
      const request = store.openCursor();
      
      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const cached = cursor.value as CachedAzimuths;
          if (boundsContain(cached.bounds, normalizedBounds)) {
            resolve(cached.bounds);
            return;
          }
          cursor.continue();
        } else {
          resolve(null);
        }
      };
    });
  } catch {
    return null;
  }
}

/**
 * Cache computed azimuths.
 */
export async function cacheAzimuths(bounds: Bounds, data: AzimuthData): Promise<void> {
  try {
    const normalizedBounds = normalizeBounds(bounds);
    const key = azimuthCacheKey(normalizedBounds);

    // Copy arrays so we don't keep references to buffers that may be transferred
    // out by callers later.
    const elevationsCopy = new Float32Array(data.elevations);
    const azimuthsCopy = new Float32Array(data.azimuths);
    const gradientsCopy = new Float32Array(data.gradients);
    const runoutZonesCopy = data.runout_zones ? new Float32Array(data.runout_zones) : undefined;

    const cached: CachedAzimuths = {
      key,
      // Store the TRUE bounds as the raster's geo-transform; the rounded
      // normalizedBounds is only the lookup key. Storing rounded bounds
      // (~55 m of error) shifted the overlay and the A* origin by several
      // pixels after a cache round-trip.
      bounds,
      elevations: elevationsCopy.buffer,
      azimuths: azimuthsCopy.buffer,
      gradients: gradientsCopy.buffer,
      runout_zones: runoutZonesCopy?.buffer,
      width: data.width,
      height: data.height,
      timestamp: Date.now(),
    };

    await putRecord(AZIMUTHS_STORE_NAME, cached);
  } catch (error) {
    // Cache writes are best-effort: a quota/transaction failure must not
    // abort the operation that produced the data.
    console.warn('[Azimuth Cache] Failed to cache azimuths:', error);
  }
}

/**
 * Get the first cached azimuth entry (for startup when we don't know bounds yet)
 */
export async function getFirstCachedAzimuths(): Promise<AzimuthData | null> {
  try {
    const db = await openDB();

    return new Promise((resolve) => {
      const transaction = db.transaction(AZIMUTHS_STORE_NAME, 'readonly');
      const store = transaction.objectStore(AZIMUTHS_STORE_NAME);
      const request = store.openCursor();

      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const cached = cursor.value as CachedAzimuths;
          resolve({
            elevations: new Float32Array(cached.elevations),
            azimuths: new Float32Array(cached.azimuths),
            gradients: new Float32Array(cached.gradients),
            runout_zones: cached.runout_zones ? new Float32Array(cached.runout_zones) : undefined,
            width: cached.width,
            height: cached.height,
            bounds: cached.bounds,
          });
        } else {
          resolve(null);
        }
      };
    });
  } catch {
    return null;
  }
}

/**
 * Get azimuths with cache check (exact match or containing).
 */
export async function getAzimuthsWithContainsCheck(bounds: Bounds): Promise<AzimuthData | null> {
  const normalizedBounds = normalizeBounds(bounds);
  
  // First check exact match
  const exact = await getCachedAzimuths(normalizedBounds);
  if (exact) return exact;
  
  // Check for containing cached azimuths
  const containing = await findContainingCachedAzimuths(normalizedBounds);
  if (containing) return containing;
  
  return null;
}
