/**
 * DEM Cache Service
 * 
 * Client-side caching for DEM (Digital Elevation Model) GeoTIFF data using IndexedDB.
 * Fetches from the /api/dem proxy endpoint which keeps the OpenTopo API key server-side.
 */

const DB_NAME = 'dem-cache';
const DB_VERSION = 2;
const STORE_NAME = 'tiles';
const AZIMUTHS_STORE_NAME = 'azimuths';

export interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

interface CachedTile {
  key: string;
  bounds: Bounds;
  data: ArrayBuffer;
  timestamp: number;
}

interface CachedAzimuths {
  key: string;
  bounds: Bounds;
  elevations: ArrayBuffer;
  azimuths: ArrayBuffer;
  gradients: ArrayBuffer;
  runout_zones?: ArrayBuffer;
  excludedAspects: string[];
  timestamp: number;
}

/**
 * Generate a cache key from bounds
 * Round to 3 decimal places (~111m precision) to improve cache hits
 * when bounds change slightly due to floating point or minor map movements
 */
function boundsToKey(bounds: Bounds): string {
  // Round to 3 decimal places for better cache hit rate
  const n = bounds.north.toFixed(3);
  const s = bounds.south.toFixed(3);
  const e = bounds.east.toFixed(3);
  const w = bounds.west.toFixed(3);
  return `dem_${n}_${s}_${e}_${w}`;
}

/**
 * Generate a cache key for azimuths that includes excluded aspects.
 * Runout zones depend on which aspects are excluded, so different aspect
 * selections need separate cache entries.
 */
function azimuthCacheKey(bounds: Bounds, excludedAspects?: string[]): string {
  const baseKey = boundsToKey(bounds);
  const aspects = excludedAspects ?? [];
  // Sort aspects for consistent key regardless of selection order
  const aspectsKey = aspects.length > 0 
    ? `_aspects_${[...aspects].sort().join('-')}` 
    : '';
  return `${baseKey}${aspectsKey}`;
}

/**
 * Normalize bounds by rounding to match cache key precision
 */
function normalizeBounds(bounds: Bounds): Bounds {
  return {
    north: Number(bounds.north.toFixed(3)),
    south: Number(bounds.south.toFixed(3)),
    east: Number(bounds.east.toFixed(3)),
    west: Number(bounds.west.toFixed(3)),
  };
}

/**
 * Open IndexedDB for DEM caching
 */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      // Verify both stores exist, if not we need to delete and recreate
      if (!db.objectStoreNames.contains(STORE_NAME) || !db.objectStoreNames.contains(AZIMUTHS_STORE_NAME)) {
        db.close();
        // Delete and recreate
        const deleteRequest = indexedDB.deleteDatabase(DB_NAME);
        deleteRequest.onsuccess = () => {
          // Recursively call openDB to create fresh database
          openDB().then(resolve).catch(reject);
        };
        deleteRequest.onerror = () => reject(deleteRequest.error);
        return;
      }
      resolve(db);
    };
    
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
      if (!db.objectStoreNames.contains(AZIMUTHS_STORE_NAME)) {
        const azimuthsStore = db.createObjectStore(AZIMUTHS_STORE_NAME, { keyPath: 'key' });
        azimuthsStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
  });
}

/**
 * Get cached DEM tile
 */
async function getCachedTile(bounds: Bounds): Promise<ArrayBuffer | null> {
  try {
    const db = await openDB();
    const key = boundsToKey(bounds);
    
    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key);
      
      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const result = request.result as CachedTile | undefined;
        resolve(result?.data || null);
      };
    });
  } catch {
    return null;
  }
}

/**
 * Cache DEM tile
 */
async function cacheTile(bounds: Bounds, data: ArrayBuffer): Promise<void> {
  try {
    const db = await openDB();
    const key = boundsToKey(bounds);
    
    const tile: CachedTile = {
      key,
      bounds,
      data,
      timestamp: Date.now(),
    };
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(tile);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch {
    // Caching failed, but that's okay
  }
}

/**
 * Fetch DEM data from server (via proxy)
 */
async function fetchDEM(bounds: Bounds, dataset = 'USGS10m'): Promise<ArrayBuffer> {
  const params = new URLSearchParams({
    north: bounds.north.toString(),
    south: bounds.south.toString(),
    east: bounds.east.toString(),
    west: bounds.west.toString(),
    dataset,
  });
  
  const response = await fetch(`/api/dem?${params}`);
  
  if (!response.ok) {
    // Try to get error details from response body
    let errorDetail = response.statusText;
    try {
      const errorJson = await response.json();
      errorDetail = errorJson.error || errorDetail;
    } catch {
      // Response wasn't JSON, use statusText
    }
    throw new Error(`Failed to fetch DEM: ${errorDetail}`);
  }
  
  return response.arrayBuffer();
}

/**
 * Get DEM data for bounds, using cache if available
 */
export async function getDEM(
  bounds: Bounds, 
  options?: { 
    dataset?: string;
    onProgress?: (message: string) => void;
  }
): Promise<Uint8Array> {
  const { dataset = 'USGS10m', onProgress } = options || {};
  
  // Normalize bounds for consistent caching
  const normalizedBounds = normalizeBounds(bounds);
  const cacheKey = boundsToKey(normalizedBounds);
  
  // Check cache first
  onProgress?.('Checking DEM cache...');
  console.log('[DEM Cache] Looking for key:', cacheKey);
  const cached = await getCachedTile(normalizedBounds);
  
  if (cached) {
    console.log('[DEM Cache] Cache HIT');
    onProgress?.('Using cached DEM data');
    return new Uint8Array(cached);
  }
  
  console.log('[DEM Cache] Cache MISS - fetching from server');
  // Fetch from server
  onProgress?.('Downloading DEM from OpenTopo...');
  const data = await fetchDEM(normalizedBounds, dataset);
  
  // Cache for next time
  onProgress?.('Caching DEM data...');
  await cacheTile(normalizedBounds, data);
  console.log('[DEM Cache] Cached with key:', cacheKey);
  
  return new Uint8Array(data);
}

/**
 * Clear all cached DEM tiles
 */
export async function clearDEMCache(): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch {
    // Clear failed
  }
}

/**
 * Calculate approximate area in km² from lat/lng bounds
 */
function calculateAreaKm2(bounds: Bounds): number {
  const latDiff = bounds.north - bounds.south;
  const lngDiff = bounds.east - bounds.west;
  const avgLat = (bounds.north + bounds.south) / 2;
  // km per degree latitude is ~111
  const latKm = latDiff * 111;
  // km per degree longitude varies with latitude
  const lngKm = lngDiff * 111 * Math.cos(avgLat * Math.PI / 180);
  return latKm * lngKm;
}

// Maximum area limits in km² from OpenTopography API docs
const MAX_AREA_KM2: Record<string, number> = {
  "USGS1m": 250,
  "USGS10m": 25000,
  "USGS30m": 225000,
};

/**
 * Expand bounds by a factor, limited by OpenTopo API max area
 * A factor of 3 means the resulting bounds will be 3x the width and height
 */
export function expandBounds(bounds: Bounds, factor: number, dataset = 'USGS10m'): Bounds {
  const width = bounds.east - bounds.west;
  const height = bounds.north - bounds.south;
  const centerLon = (bounds.east + bounds.west) / 2;
  const centerLat = (bounds.north + bounds.south) / 2;
  
  let newWidth = width * factor;
  let newHeight = height * factor;
  
  // Calculate expanded bounds and check area
  let expandedBounds: Bounds = {
    north: centerLat + newHeight / 2,
    south: centerLat - newHeight / 2,
    east: centerLon + newWidth / 2,
    west: centerLon - newWidth / 2,
  };
  
  const maxArea = MAX_AREA_KM2[dataset] || 25000;
  const expandedArea = calculateAreaKm2(expandedBounds);
  
  // If too large, reduce expansion factor until it fits
  if (expandedArea > maxArea) {
    // Scale down proportionally
    const scaleFactor = Math.sqrt(maxArea / expandedArea) * 0.95; // 5% safety margin
    newWidth = width * factor * scaleFactor;
    newHeight = height * factor * scaleFactor;
    
    expandedBounds = {
      north: centerLat + newHeight / 2,
      south: centerLat - newHeight / 2,
      east: centerLon + newWidth / 2,
      west: centerLon - newWidth / 2,
    };
    
    console.log(`[DEM] Reduced expansion to fit ${dataset} limit of ${maxArea} km²`);
  }
  
  return expandedBounds;
}

/**
 * Check if outer bounds fully contain inner bounds
 */
export function boundsContain(outer: Bounds, inner: Bounds): boolean {
  return (
    outer.north >= inner.north &&
    outer.south <= inner.south &&
    outer.east >= inner.east &&
    outer.west <= inner.west
  );
}

/**
 * Find a cached tile that contains the requested bounds
 * Returns the bounds of the cached tile if found, null otherwise
 * Useful for showing the cached region on the map
 */
export async function findCachedBoundsContaining(bounds: Bounds): Promise<Bounds | null> {
  try {
    const db = await openDB();
    const normalizedBounds = normalizeBounds(bounds);
    
    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.openCursor();
      
      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const tile = cursor.value as CachedTile;
          if (boundsContain(tile.bounds, normalizedBounds)) {
            resolve(tile.bounds);
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
 * Find a cached tile that contains the requested bounds
 * Returns the cached data if found, null otherwise
 */
async function findContainingCachedTile(bounds: Bounds): Promise<ArrayBuffer | null> {
  try {
    const db = await openDB();
    
    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.openCursor();
      
      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const tile = cursor.value as CachedTile;
          if (boundsContain(tile.bounds, bounds)) {
            console.log('[DEM Cache] Found containing tile:', boundsToKey(tile.bounds));
            resolve(tile.data);
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
 * Preload DEM data for expanded bounds in the background
 * Returns a promise that resolves when the preload is complete
 * Useful for fetching a larger area ahead of time (e.g., 3x viewport on first waypoint)
 */
export async function preloadDEM(
  bounds: Bounds,
  options?: {
    expansionFactor?: number;
    dataset?: string;
  }
): Promise<void> {
  const { expansionFactor = 3, dataset = 'USGS10m' } = options || {};
  
  // Expand and normalize bounds
  const expandedBounds = expandBounds(bounds, expansionFactor);
  const normalizedBounds = normalizeBounds(expandedBounds);
  const cacheKey = boundsToKey(normalizedBounds);
  
  // Check if already cached
  const cached = await getCachedTile(normalizedBounds);
  if (cached) {
    console.log('[DEM Preload] Already cached:', cacheKey);
    return;
  }
  
  console.log('[DEM Preload] Starting background fetch for:', cacheKey);
  
  try {
    const data = await fetchDEM(normalizedBounds, dataset);
    await cacheTile(normalizedBounds, data);
    console.log('[DEM Preload] Cached expanded region:', cacheKey);
  } catch (error) {
    console.warn('[DEM Preload] Failed:', error);
    // Preload failures are non-critical, don't throw
  }
}

/**
 * Get DEM data for bounds, checking for containing cached tiles first
 * This allows preloaded larger regions to serve smaller requests
 */
export async function getDEMWithContainsCheck(
  bounds: Bounds,
  options?: {
    dataset?: string;
    onProgress?: (message: string) => void;
  }
): Promise<Uint8Array> {
  const { dataset = 'USGS10m', onProgress } = options || {};
  
  const normalizedBounds = normalizeBounds(bounds);
  const cacheKey = boundsToKey(normalizedBounds);
  
  // First check for exact match
  onProgress?.('Checking DEM cache...');
  console.log('[DEM Cache] Looking for key:', cacheKey);
  const exactCached = await getCachedTile(normalizedBounds);
  
  if (exactCached) {
    console.log('[DEM Cache] Exact cache HIT');
    onProgress?.('Using cached DEM data');
    return new Uint8Array(exactCached);
  }
  
  // Check for a larger cached tile that contains our bounds
  console.log('[DEM Cache] Checking for containing cached tile...');
  const containingCached = await findContainingCachedTile(normalizedBounds);
  
  if (containingCached) {
    console.log('[DEM Cache] Found containing cached tile');
    onProgress?.('Using cached DEM data');
    return new Uint8Array(containingCached);
  }
  
  console.log('[DEM Cache] Cache MISS - fetching from server');
  onProgress?.('Downloading DEM from OpenTopo...');
  const data = await fetchDEM(normalizedBounds, dataset);
  
  onProgress?.('Caching DEM data...');
  await cacheTile(normalizedBounds, data);
  console.log('[DEM Cache] Cached with key:', cacheKey);
  
  return new Uint8Array(data);
}

/**
 * Get approximate cache size (number of tiles)
 */
export async function getDEMCacheStats(): Promise<{ count: number; oldestTimestamp?: number }> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const countRequest = store.count();
      
      countRequest.onerror = () => resolve({ count: 0 });
      countRequest.onsuccess = () => {
        const count = countRequest.result;
        
        // Get oldest timestamp
        const index = store.index('timestamp');
        const cursorRequest = index.openCursor();
        
        cursorRequest.onerror = () => resolve({ count });
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          const oldestTimestamp = cursor?.value?.timestamp;
          resolve({ count, oldestTimestamp });
        };
      };
    });
  } catch {
    return { count: 0 };
  }
}

// ============ AZIMUTH CACHING ============

export interface AzimuthData {
  elevations: Uint8Array;
  azimuths: Uint8Array;
  gradients: Uint8Array;
  runout_zones?: Uint8Array;
}

/**
 * Get cached azimuths for bounds and excluded aspects
 */
export async function getCachedAzimuths(bounds: Bounds, excludedAspects?: string[]): Promise<AzimuthData | null> {
  try {
    const db = await openDB();
    const normalizedBounds = normalizeBounds(bounds);
    const key = azimuthCacheKey(normalizedBounds, excludedAspects ?? []);
    
    return new Promise((resolve) => {
      const transaction = db.transaction(AZIMUTHS_STORE_NAME, 'readonly');
      const store = transaction.objectStore(AZIMUTHS_STORE_NAME);
      const request = store.get(key);
      
      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const result = request.result as CachedAzimuths | undefined;
        if (result) {
          console.log('[Azimuth Cache] Cache HIT for:', key);
          resolve({
            elevations: new Uint8Array(result.elevations),
            azimuths: new Uint8Array(result.azimuths),
            gradients: new Uint8Array(result.gradients),
            runout_zones: result.runout_zones ? new Uint8Array(result.runout_zones) : undefined,
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
 * Check if two aspect arrays are equivalent (same aspects, any order)
 */
function aspectsMatch(a?: string[], b?: string[]): boolean {
  const arrA = a ?? [];
  const arrB = b ?? [];
  if (arrA.length !== arrB.length) return false;
  const sortedA = [...arrA].sort();
  const sortedB = [...arrB].sort();
  return sortedA.every((val, i) => val === sortedB[i]);
}

/**
 * Find cached azimuths that contain the requested bounds and match excluded aspects
 */
export async function findContainingCachedAzimuths(bounds: Bounds, excludedAspects?: string[]): Promise<AzimuthData | null> {
  try {
    const db = await openDB();
    const normalizedBounds = normalizeBounds(bounds);
    const aspects = excludedAspects ?? [];
    
    return new Promise((resolve) => {
      const transaction = db.transaction(AZIMUTHS_STORE_NAME, 'readonly');
      const store = transaction.objectStore(AZIMUTHS_STORE_NAME);
      const request = store.openCursor();
      
      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const cached = cursor.value as CachedAzimuths;
          // Must match both bounds containment AND excluded aspects
          // Handle legacy cache entries that don't have excludedAspects
          if (boundsContain(cached.bounds, normalizedBounds) && aspectsMatch(cached.excludedAspects, aspects)) {
            console.log('[Azimuth Cache] Found containing cached azimuths with matching aspects');
            resolve({
              elevations: new Uint8Array(cached.elevations),
              azimuths: new Uint8Array(cached.azimuths),
              gradients: new Uint8Array(cached.gradients),
              runout_zones: cached.runout_zones ? new Uint8Array(cached.runout_zones) : undefined,
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
 * Cache computed azimuths with excluded aspects
 */
export async function cacheAzimuths(bounds: Bounds, data: AzimuthData, excludedAspects?: string[]): Promise<void> {
  try {
    const db = await openDB();
    const normalizedBounds = normalizeBounds(bounds);
    const aspects = excludedAspects ?? [];
    const key = azimuthCacheKey(normalizedBounds, aspects);
    
    const cached: CachedAzimuths = {
      key,
      bounds: normalizedBounds,
      elevations: data.elevations.buffer as ArrayBuffer,
      azimuths: data.azimuths.buffer as ArrayBuffer,
      gradients: data.gradients.buffer as ArrayBuffer,
      runout_zones: data.runout_zones?.buffer as ArrayBuffer | undefined,
      excludedAspects: [...aspects],
      timestamp: Date.now(),
    };
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(AZIMUTHS_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(AZIMUTHS_STORE_NAME);
      const request = store.put(cached);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        console.log('[Azimuth Cache] Cached azimuths for:', key);
        resolve();
      };
    });
  } catch {
    // Caching failed, but that's okay
  }
}

/**
 * Get azimuths with cache check (exact match or containing)
 * Includes excludedAspects in the lookup since runout zones depend on them
 */
export async function getAzimuthsWithContainsCheck(bounds: Bounds, excludedAspects?: string[]): Promise<AzimuthData | null> {
  const normalizedBounds = normalizeBounds(bounds);
  const aspects = excludedAspects ?? [];
  
  // First check exact match
  const exact = await getCachedAzimuths(normalizedBounds, aspects);
  if (exact) return exact;
  
  // Check for containing cached azimuths
  const containing = await findContainingCachedAzimuths(normalizedBounds, aspects);
  if (containing) return containing;
  
  return null;
}
