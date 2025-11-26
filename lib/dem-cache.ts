/**
 * DEM Cache Service
 * 
 * Client-side caching for DEM (Digital Elevation Model) GeoTIFF data using IndexedDB.
 * Fetches from the /api/dem proxy endpoint which keeps the OpenTopo API key server-side.
 */

const DB_NAME = 'dem-cache';
const DB_VERSION = 1;
const STORE_NAME = 'tiles';

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
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
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
    throw new Error(`Failed to fetch DEM: ${response.statusText}`);
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
