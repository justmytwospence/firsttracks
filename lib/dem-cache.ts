/**
 * DEM Cache Service
 * 
 * Client-side caching for DEM (Digital Elevation Model) data using IndexedDB.
 * Fetches elevation tiles from AWS Terrain Tiles (Terrarium format) and stitches
 * them into a single elevation grid with proper georeferencing.
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

/**
 * Interface for stitched elevation grid with metadata
 */
export interface ElevationGrid {
  data: Float32Array;
  width: number;
  height: number;
  bounds: Bounds;
}

/**
 * AWS Terrain Tiles configuration
 * - Zoom 14 provides ~10m resolution (comparable to USGS10m)
 * - Each tile is 256x256 pixels
 * - Terrarium format: elevation = (red * 256 + green + blue / 256) - 32768
 */
const TERRAIN_TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const TERRAIN_TILE_ZOOM = 14;
const TERRAIN_TILE_SIZE = 256;

// ============ TILE COORDINATE UTILITIES ============

/**
 * Convert latitude/longitude to tile coordinates at a given zoom level.
 * Uses Web Mercator projection (EPSG:3857).
 */
export function latLngToTile(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n);
  return { x, y };
}

/**
 * Convert tile coordinates to the northwest corner latitude/longitude.
 */
export function tileToLatLng(x: number, y: number, zoom: number): { lat: number; lng: number } {
  const n = 2 ** zoom;
  const lng = x / n * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
  const lat = latRad * 180 / Math.PI;
  return { lat, lng };
}

/**
 * Get all tile coordinates that cover a bounding box at a given zoom level.
 * Returns tiles in row-major order (left-to-right, top-to-bottom).
 */
export function getTilesForBounds(bounds: Bounds, zoom: number): { x: number; y: number }[] {
  const nw = latLngToTile(bounds.north, bounds.west, zoom);
  const se = latLngToTile(bounds.south, bounds.east, zoom);
  
  const tiles: { x: number; y: number }[] = [];
  for (let y = nw.y; y <= se.y; y++) {
    for (let x = nw.x; x <= se.x; x++) {
      tiles.push({ x, y });
    }
  }
  return tiles;
}

/**
 * Decode Terrarium format PNG elevation data.
 * Formula: elevation = (red * 256 + green + blue / 256) - 32768
 * Returns elevation values in meters as Float32Array.
 */
export function decodeTerrarium(imageData: ImageData): Float32Array {
  const { data, width, height } = imageData;
  const elevations = new Float32Array(width * height);
  
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    elevations[i] = (r * 256 + g + b / 256) - 32768;
  }
  
  return elevations;
}

interface CachedTile {
  key: string;
  bounds: Bounds;
  data: ArrayBuffer;  // Float32Array as ArrayBuffer
  width: number;
  height: number;
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
async function getCachedTile(bounds: Bounds): Promise<ElevationGrid | null> {
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
        if (result) {
          resolve({
            data: new Float32Array(result.data),
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
 * Cache DEM tile (ElevationGrid)
 */
async function cacheTile(grid: ElevationGrid): Promise<void> {
  try {
    const db = await openDB();
    const key = boundsToKey(grid.bounds);
    
    const tile: CachedTile = {
      key,
      bounds: grid.bounds,
      data: grid.data.buffer as ArrayBuffer,
      width: grid.width,
      height: grid.height,
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
 * Fetch a single terrain tile from AWS S3 and decode its elevation data.
 */
async function fetchTerrainTile(x: number, y: number, zoom: number): Promise<Float32Array> {
  const url = `${TERRAIN_TILE_URL}/${zoom}/${x}/${y}.png`;
  
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch terrain tile ${zoom}/${x}/${y}: ${response.status}`);
  }
  
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  
  // Use OffscreenCanvas to extract pixel data
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get 2D context');
  }
  
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  
  return decodeTerrarium(imageData);
}

/**
 * Fetch DEM data from AWS Terrain Tiles and stitch into a single elevation grid.
 * Fetches all tiles that cover the bounding box and stitches them together.
 */
async function fetchDEM(
  bounds: Bounds,
  onProgress?: (message: string) => void
): Promise<ElevationGrid> {
  const zoom = TERRAIN_TILE_ZOOM;
  const tiles = getTilesForBounds(bounds, zoom);
  
  if (tiles.length === 0) {
    throw new Error('No tiles found for bounds');
  }
  
  onProgress?.(`Downloading ${tiles.length} elevation tile(s)...`);
  
  // Calculate grid dimensions
  const minX = Math.min(...tiles.map(t => t.x));
  const maxX = Math.max(...tiles.map(t => t.x));
  const minY = Math.min(...tiles.map(t => t.y));
  const maxY = Math.max(...tiles.map(t => t.y));
  
  const tilesWide = maxX - minX + 1;
  const tilesHigh = maxY - minY + 1;
  
  // Fetch all tiles in parallel
  const tilePromises = tiles.map(tile => 
    fetchTerrainTile(tile.x, tile.y, zoom).then(data => ({
      x: tile.x - minX,
      y: tile.y - minY,
      data,
    }))
  );
  
  const tileResults = await Promise.all(tilePromises);
  
  // Stitch tiles into single grid
  const gridWidth = tilesWide * TERRAIN_TILE_SIZE;
  const gridHeight = tilesHigh * TERRAIN_TILE_SIZE;
  const stitched = new Float32Array(gridWidth * gridHeight);
  
  for (const tile of tileResults) {
    const offsetX = tile.x * TERRAIN_TILE_SIZE;
    const offsetY = tile.y * TERRAIN_TILE_SIZE;
    
    for (let row = 0; row < TERRAIN_TILE_SIZE; row++) {
      const srcStart = row * TERRAIN_TILE_SIZE;
      const dstStart = (offsetY + row) * gridWidth + offsetX;
      stitched.set(tile.data.subarray(srcStart, srcStart + TERRAIN_TILE_SIZE), dstStart);
    }
  }
  
  // Calculate actual bounds of the stitched grid
  const nwCorner = tileToLatLng(minX, minY, zoom);
  const seCorner = tileToLatLng(maxX + 1, maxY + 1, zoom);
  
  const gridBounds: Bounds = {
    north: nwCorner.lat,
    south: seCorner.lat,
    east: seCorner.lng,
    west: nwCorner.lng,
  };
  
  return {
    data: stitched,
    width: gridWidth,
    height: gridHeight,
    bounds: gridBounds,
  };
}

/**
 * Get DEM data for bounds, using cache if available.
 * Returns an ElevationGrid with Float32Array elevation data and metadata.
 */
export async function getDEM(
  bounds: Bounds, 
  options?: { 
    onProgress?: (message: string) => void;
  }
): Promise<ElevationGrid> {
  const { onProgress } = options || {};
  
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
    return cached;
  }
  
  console.log('[DEM Cache] Cache MISS - fetching from AWS Terrain Tiles');
  // Fetch from AWS S3
  const grid = await fetchDEM(normalizedBounds, onProgress);
  
  // Cache for next time
  onProgress?.('Caching DEM data...');
  await cacheTile(grid);
  console.log('[DEM Cache] Cached with key:', cacheKey);
  
  return grid;
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
 * Expand bounds by a factor.
 * A factor of 3 means the resulting bounds will be 3x the width and height.
 * Note: No area limits with AWS Terrain Tiles (unlimited free access).
 */
export function expandBounds(bounds: Bounds, factor: number): Bounds {
  const width = bounds.east - bounds.west;
  const height = bounds.north - bounds.south;
  const centerLon = (bounds.east + bounds.west) / 2;
  const centerLat = (bounds.north + bounds.south) / 2;
  
  const newWidth = width * factor;
  const newHeight = height * factor;
  
  return {
    north: centerLat + newHeight / 2,
    south: centerLat - newHeight / 2,
    east: centerLon + newWidth / 2,
    west: centerLon - newWidth / 2,
  };
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
 * Returns the cached ElevationGrid if found, null otherwise
 */
async function findContainingCachedTile(bounds: Bounds): Promise<ElevationGrid | null> {
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
            resolve({
              data: new Float32Array(tile.data),
              width: tile.width,
              height: tile.height,
              bounds: tile.bounds,
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
 * Preload DEM data for expanded bounds in the background
 * Returns a promise that resolves when the preload is complete
 * Useful for fetching a larger area ahead of time (e.g., 3x viewport on first waypoint)
 */
export async function preloadDEM(
  bounds: Bounds,
  options?: {
    expansionFactor?: number;
  }
): Promise<void> {
  const { expansionFactor = 3 } = options || {};
  
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
    const grid = await fetchDEM(normalizedBounds);
    await cacheTile(grid);
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
    onProgress?: (message: string) => void;
  }
): Promise<ElevationGrid> {
  const { onProgress } = options || {};
  
  const normalizedBounds = normalizeBounds(bounds);
  const cacheKey = boundsToKey(normalizedBounds);
  
  // First check for exact match
  onProgress?.('Checking DEM cache...');
  console.log('[DEM Cache] Looking for key:', cacheKey);
  const exactCached = await getCachedTile(normalizedBounds);
  
  if (exactCached) {
    console.log('[DEM Cache] Exact cache HIT');
    onProgress?.('Using cached DEM data');
    return exactCached;
  }
  
  // Check for a larger cached tile that contains our bounds
  console.log('[DEM Cache] Checking for containing cached tile...');
  const containingCached = await findContainingCachedTile(normalizedBounds);
  
  if (containingCached) {
    console.log('[DEM Cache] Found containing cached tile');
    onProgress?.('Using cached DEM data');
    return containingCached;
  }
  
  console.log('[DEM Cache] Cache MISS - fetching from AWS Terrain Tiles');
  const grid = await fetchDEM(normalizedBounds, onProgress);
  
  onProgress?.('Caching DEM data...');
  await cacheTile(grid);
  console.log('[DEM Cache] Cached with key:', cacheKey);
  
  return grid;
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
