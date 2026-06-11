/**
 * DEM Cache Service
 * 
 * Client-side caching for DEM (Digital Elevation Model) data using IndexedDB.
 * Fetches elevation tiles from AWS Terrain Tiles (Terrarium format) and stitches
 * them into a single elevation grid with proper georeferencing.
 * 
 * Supports tile-level caching for incremental fetching - only fetches tiles
 * that aren't already cached.
 */

const DB_NAME = 'dem-cache';
// v4: azimuths store now holds raw Float32Array per band (no GeoTIFF round-trip).
// Old v3 records have Uint8Array (GeoTIFF) buffers; we drop & recreate the store on upgrade.
const DB_VERSION = 4;
const STORE_NAME = 'tiles';
const AZIMUTHS_STORE_NAME = 'azimuths';
const INDIVIDUAL_TILES_STORE_NAME = 'individual_tiles';  // z/x/y tiles

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

/**
 * Maximum number of tiles that can be fetched for a single request.
 * 400 tiles = 20x20 grid = 5120x5120 pixels ≈ 100MB Float32Array.
 * This prevents browser memory exhaustion when requesting large areas.
 */
const MAX_TILES = 400;

// ============ TILE COORDINATE UTILITIES ============

/**
 * Convert latitude/longitude to tile coordinates at a given zoom level.
 * Uses Web Mercator projection (EPSG:3857).
 */
export function latLngToTile(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  // Clamp to the Web Mercator domain: lat beyond +/-85.0511 or lng at
  // exactly 180 would otherwise produce tile indices outside [0, n).
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const x = Math.max(0, Math.min(n - 1, Math.floor((lng + 180) / 360 * n)));
  const latRad = clampedLat * Math.PI / 180;
  const y = Math.max(0, Math.min(n - 1, Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n)));
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
 * If the bounds would require more than MAX_TILES, the bounds are shrunk
 * toward the center to fit within the limit.
 */
export function getTilesForBounds(bounds: Bounds, zoom: number): { x: number; y: number }[] {
  const nw = latLngToTile(bounds.north, bounds.west, zoom);
  const se = latLngToTile(bounds.south, bounds.east, zoom);
  
  // Check tile count and shrink if needed
  let tilesWide = se.x - nw.x + 1;
  let tilesHigh = se.y - nw.y + 1;
  let tileCount = tilesWide * tilesHigh;
  
  // If over limit, shrink bounds toward center
  let startX = nw.x;
  let endX = se.x;
  let startY = nw.y;
  let endY = se.y;
  
  if (tileCount > MAX_TILES) {
    // Calculate scale factor to fit within MAX_TILES
    const scaleFactor = Math.sqrt(MAX_TILES / tileCount);
    const newTilesWide = Math.floor(tilesWide * scaleFactor);
    const newTilesHigh = Math.floor(tilesHigh * scaleFactor);
    
    // Shrink from center
    const removeX = tilesWide - newTilesWide;
    const removeY = tilesHigh - newTilesHigh;
    
    startX = nw.x + Math.floor(removeX / 2);
    endX = se.x - Math.ceil(removeX / 2);
    startY = nw.y + Math.floor(removeY / 2);
    endY = se.y - Math.ceil(removeY / 2);
    
    // Ensure at least 1 tile in each dimension
    if (endX < startX) endX = startX;
    if (endY < startY) endY = startY;
    
    tilesWide = endX - startX + 1;
    tilesHigh = endY - startY + 1;
    tileCount = tilesWide * tilesHigh;
    
    console.warn(
      `[DEM] Bounds capped to ${tileCount} tiles (max: ${MAX_TILES}). Area reduced toward center.`
    );
  }
  
  const tiles: { x: number; y: number }[] = [];
  for (let y = startY; y <= endY; y++) {
    for (let x = startX; x <= endX; x++) {
      tiles.push({ x, y });
    }
  }
  return tiles;
}

/**
 * Decode Terrarium format PNG elevation data.
 * Formula: elevation = (red * 256 + green + blue / 256) - 32768
 * Note: JS operator precedence means this is evaluated as: ((red * 256) + green + (blue / 256)) - 32768
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

/**
 * Individual tile cached by z/x/y coordinates
 */
interface CachedIndividualTile {
  key: string;  // Format: "z/x/y"
  z: number;
  x: number;
  y: number;
  data: ArrayBuffer;  // Float32Array for single tile (256x256)
  timestamp: number;
}

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
 * Generate a cache key for azimuths.
 * Note: excludedAspects parameter is ignored - runout zones are now pre-computed
 * for all 8 aspects and combined client-side based on selection.
 */
function azimuthCacheKey(bounds: Bounds, _excludedAspects?: string[]): string {
  const baseKey = boundsToKey(bounds);
  return `${baseKey}_azimuths`;
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
 * Open IndexedDB for DEM caching.
 * Memoized: subsequent calls return the same connection promise.
 */
let dbPromise: Promise<IDBDatabase> | null = null;
function openDB(): Promise<IDBDatabase> {
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

    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.put(tile);

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch (error) {
    // Cache writes are best-effort: a quota/transaction failure must not
    // abort the operation that produced the data.
    console.warn('[DEM Cache] Failed to cache stitched grid:', error);
  }
}

/**
 * Fetch a single terrain tile from AWS S3 and decode its elevation data.
 */
async function fetchTerrainTile(x: number, y: number, zoom: number): Promise<Float32Array> {
  const url = `${TERRAIN_TILE_URL}/${zoom}/${x}/${y}.png`;

  // AWS terrain tiles return no Cache-Control header (only Last-Modified from 2017).
  // 'force-cache' lets the browser serve any HTTP-cached copy without revalidation;
  // safe because terrain tiles are immutable. Transient network/S3 errors are
  // retried so one hiccup doesn't reject the whole Promise.all of a fetch.
  const MAX_ATTEMPTS = 3;
  let response: Response | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      response = await fetch(url, { cache: 'force-cache' });
      // 4xx is definitive; only retry server errors.
      if (response.ok || response.status < 500) break;
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
      response = undefined;
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
  if (!response || !response.ok) {
    throw new Error(`Failed to fetch terrain tile ${zoom}/${x}/${y}: ${response?.status}`);
  }

  const blob = await response.blob();
  // Terrarium decoding needs bit-exact RGB: without these options browsers
  // (Safari especially) may color-manage the PNG, and 1 LSB of green is a
  // full meter of elevation error.
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  
  // Use OffscreenCanvas to extract pixel data
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Failed to get 2D context');
  }
  
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  
  return decodeTerrarium(imageData);
}

// ============ INDIVIDUAL TILE CACHING ============

/**
 * Generate key for individual tile
 */
function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

/**
 * Get a single cached individual tile
 */
async function getCachedIndividualTile(z: number, x: number, y: number): Promise<Float32Array | null> {
  try {
    const db = await openDB();
    const key = tileKey(z, x, y);
    
    return new Promise((resolve) => {
      const transaction = db.transaction(INDIVIDUAL_TILES_STORE_NAME, 'readonly');
      const store = transaction.objectStore(INDIVIDUAL_TILES_STORE_NAME);
      const request = store.get(key);
      
      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const result = request.result as CachedIndividualTile | undefined;
        if (result) {
          resolve(new Float32Array(result.data));
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
 * Cache a single individual tile
 */
async function cacheIndividualTile(z: number, x: number, y: number, data: Float32Array): Promise<void> {
  try {
    const db = await openDB();
    const key = tileKey(z, x, y);
    
    const cached: CachedIndividualTile = {
      key,
      z,
      x,
      y,
      data: data.buffer as ArrayBuffer,
      timestamp: Date.now(),
    };

    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(INDIVIDUAL_TILES_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(INDIVIDUAL_TILES_STORE_NAME);
      store.put(cached);

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch (error) {
    // Cache writes are best-effort: a quota/transaction failure must not
    // abort the operation that produced the data.
    console.warn('[DEM Cache] Failed to cache tile:', error);
  }
}

/**
 * Check which tiles from a list are already cached
 * Returns array of tile keys that are cached
 */
async function getCachedTileKeys(tiles: { x: number; y: number }[], zoom: number): Promise<Set<string>> {
  try {
    const db = await openDB();
    const cachedKeys = new Set<string>();
    
    return new Promise((resolve) => {
      const transaction = db.transaction(INDIVIDUAL_TILES_STORE_NAME, 'readonly');
      const store = transaction.objectStore(INDIVIDUAL_TILES_STORE_NAME);
      
      // Check each tile
      let completed = 0;
      for (const tile of tiles) {
        const key = tileKey(zoom, tile.x, tile.y);
        const request = store.get(key);
        
        request.onsuccess = () => {
          if (request.result) {
            cachedKeys.add(key);
          }
          completed++;
          if (completed === tiles.length) {
            resolve(cachedKeys);
          }
        };
        request.onerror = () => {
          completed++;
          if (completed === tiles.length) {
            resolve(cachedKeys);
          }
        };
      }
      
      // Handle empty tiles array
      if (tiles.length === 0) {
        resolve(cachedKeys);
      }
    });
  } catch {
    return new Set();
  }
}

/**
 * Fetch a tile, using cache if available
 */
async function fetchTileWithCache(x: number, y: number, zoom: number): Promise<Float32Array> {
  // Check cache first
  const cached = await getCachedIndividualTile(zoom, x, y);
  if (cached) {
    return cached;
  }
  
  // Fetch from network
  const data = await fetchTerrainTile(x, y, zoom);
  
  // Cache for next time
  await cacheIndividualTile(zoom, x, y, data);
  
  return data;
}

/**
 * Get the union bounds of all cached individual tiles.
 * Used to display cached region on page load.
 */
/**
 * Group cached individual tiles into connected regions and return one Bounds per region.
 * Two tiles are part of the same region if they are 4-adjacent (share an edge).
 * The returned rectangles are the bounding boxes of each connected component, so
 * a contiguous patch of cached tiles shows as one rectangle and a separate cached
 * area shows as its own rectangle.
 */
export async function getCachedIndividualTilesRegions(): Promise<Bounds[]> {
  try {
    const db = await openDB();
    const keys: IDBValidKey[] = await new Promise((resolve) => {
      const tx = db.transaction(INDIVIDUAL_TILES_STORE_NAME, 'readonly');
      const req = tx.objectStore(INDIVIDUAL_TILES_STORE_NAME).getAllKeys();
      req.onerror = () => resolve([]);
      req.onsuccess = () => resolve(req.result as IDBValidKey[]);
    });

    // Bucket tiles by zoom; within a zoom, BFS to connect 4-adjacent tiles.
    const tilesByZoom = new Map<number, Set<string>>();
    for (const k of keys) {
      if (typeof k !== 'string') continue;
      const parts = k.split('/');
      if (parts.length !== 3) continue;
      const z = Number(parts[0]);
      const x = Number(parts[1]);
      const y = Number(parts[2]);
      if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      let bucket = tilesByZoom.get(z);
      if (!bucket) {
        bucket = new Set();
        tilesByZoom.set(z, bucket);
      }
      bucket.add(`${x},${y}`);
    }

    const regions: Bounds[] = [];
    for (const [z, set] of tilesByZoom) {
      const visited = new Set<string>();
      for (const start of set) {
        if (visited.has(start)) continue;
        // BFS the connected component
        const queue: string[] = [start];
        visited.add(start);
        let minX = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        while (queue.length > 0) {
          const cur = queue.shift() as string;
          const [cxStr, cyStr] = cur.split(',');
          const cx = Number(cxStr);
          const cy = Number(cyStr);
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nk = `${cx + dx},${cy + dy}`;
            if (set.has(nk) && !visited.has(nk)) {
              visited.add(nk);
              queue.push(nk);
            }
          }
        }
        const nw = tileToLatLng(minX, minY, z);
        const se = tileToLatLng(maxX + 1, maxY + 1, z);
        regions.push({
          north: nw.lat,
          south: se.lat,
          east: se.lng,
          west: nw.lng,
        });
      }
    }
    return regions;
  } catch {
    return [];
  }
}

export async function getCachedIndividualTilesBounds(): Promise<Bounds | null> {
  try {
    const db = await openDB();

    return new Promise((resolve) => {
      const transaction = db.transaction(INDIVIDUAL_TILES_STORE_NAME, 'readonly');
      const store = transaction.objectStore(INDIVIDUAL_TILES_STORE_NAME);
      // Key-only iteration: avoids rehydrating every cached tile's Float32Array
      // (~256 KB each) just to read z/x/y. Keys are the format "z/x/y".
      const request = store.getAllKeys();

      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const keys = request.result as IDBValidKey[];
        if (keys.length === 0) {
          resolve(null);
          return;
        }

        let minX = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        let zoom = TERRAIN_TILE_ZOOM;

        for (const k of keys) {
          if (typeof k !== 'string') continue;
          const parts = k.split('/');
          if (parts.length !== 3) continue;
          const z = Number(parts[0]);
          const x = Number(parts[1]);
          const y = Number(parts[2]);
          if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          zoom = z;
        }

        if (!Number.isFinite(minX)) {
          resolve(null);
          return;
        }

        const nwCorner = tileToLatLng(minX, minY, zoom);
        const seCorner = tileToLatLng(maxX + 1, maxY + 1, zoom);

        resolve({
          north: nwCorner.lat,
          south: seCorner.lat,
          east: seCorner.lng,
          west: nwCorner.lng,
        });
      };
    });
  } catch {
    return null;
  }
}

/**
 * Fetch DEM data from AWS Terrain Tiles and stitch into a single elevation grid.
 * Uses individual tile caching - only fetches tiles that aren't already cached.
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
  
  // Check which tiles are already cached
  const cachedKeys = await getCachedTileKeys(tiles, zoom);
  const uncachedTiles = tiles.filter(t => !cachedKeys.has(tileKey(zoom, t.x, t.y)));
  
  if (uncachedTiles.length > 0) {
    onProgress?.(`Downloading ${uncachedTiles.length} of ${tiles.length} elevation tile(s)...`);
  } else {
    onProgress?.(`Using ${tiles.length} cached elevation tile(s)`);
  }
  
  // Calculate grid dimensions
  const minX = Math.min(...tiles.map(t => t.x));
  const maxX = Math.max(...tiles.map(t => t.x));
  const minY = Math.min(...tiles.map(t => t.y));
  const maxY = Math.max(...tiles.map(t => t.y));
  
  const tilesWide = maxX - minX + 1;
  const tilesHigh = maxY - minY + 1;
  
  // Fetch all tiles in parallel (uses cache when available)
  const tilePromises = tiles.map(tile => 
    fetchTileWithCache(tile.x, tile.y, zoom).then(data => ({
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
 * Expand bounds by a factor, capped to stay within MAX_TILES limit.
 * A factor of 3 means the resulting bounds will be 3x the width and height.
 * The actual expansion may be reduced if it would exceed tile limits.
 */
export function expandBounds(bounds: Bounds, factor: number): Bounds {
  const width = bounds.east - bounds.west;
  const height = bounds.north - bounds.south;
  const centerLon = (bounds.east + bounds.west) / 2;
  const centerLat = (bounds.north + bounds.south) / 2;

  // Cap at MAX_TILES, but never below 1.0 — shrinking the input here drops
  // whichever waypoint sits on the far edge, which the caller never wants.
  // If the input itself already exceeds MAX_TILES, return it as-is and let
  // the tile fetcher decide how to handle it.
  const currentTiles = countTilesForBounds(bounds, TERRAIN_TILE_ZOOM);
  const maxFactor = Math.sqrt(MAX_TILES / currentTiles);
  const cappedFactor = Math.max(1, Math.min(factor, maxFactor));

  const newWidth = width * cappedFactor;
  const newHeight = height * cappedFactor;

  return {
    north: centerLat + newHeight / 2,
    south: centerLat - newHeight / 2,
    east: centerLon + newWidth / 2,
    west: centerLon - newWidth / 2,
  };
}

/**
 * Count how many tiles would be needed for bounds without allocating the array.
 */
function countTilesForBounds(bounds: Bounds, zoom: number): number {
  const nw = latLngToTile(bounds.north, bounds.west, zoom);
  const se = latLngToTile(bounds.south, bounds.east, zoom);
  const tilesWide = se.x - nw.x + 1;
  const tilesHigh = se.y - nw.y + 1;
  return tilesWide * tilesHigh;
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
 * Merge two bounds into a union that contains both
 */
export function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    north: Math.max(a.north, b.north),
    south: Math.min(a.south, b.south),
    east: Math.max(a.east, b.east),
    west: Math.min(a.west, b.west),
  };
}

/**
 * Get all cached DEM tile bounds.
 * Returns an array of all cached bounds, useful for displaying cached regions on map load.
 */
export async function getAllCachedBounds(): Promise<Bounds[]> {
  try {
    const db = await openDB();
    
    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();
      
      request.onerror = () => resolve([]);
      request.onsuccess = () => {
        const tiles = request.result as CachedTile[];
        resolve(tiles.map(t => t.bounds));
      };
    });
  } catch {
    return [];
  }
}

/**
 * Get the union of all cached DEM tile bounds.
 * Returns null if no tiles are cached.
 */
export async function getCachedBoundsUnion(): Promise<Bounds | null> {
  const allBounds = await getAllCachedBounds();
  if (allBounds.length === 0) return null;
  
  return allBounds.reduce((union, bounds) => unionBounds(union, bounds));
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

  // Look for a cached stitched grid covering the request. (There is no
  // exact-key fast path: records are keyed by their tile-aligned stitched
  // bounds, which never match a request's normalized bounds.)
  onProgress?.('Checking DEM cache...');
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
  console.log('[DEM Cache] Cached stitched grid with key:', boundsToKey(grid.bounds));

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
 * Note: excludedAspects parameter is kept for backward compatibility but ignored.
 * Runout zones are pre-computed for all aspects.
 */
export async function getCachedAzimuths(bounds: Bounds, _excludedAspects?: string[]): Promise<AzimuthData | null> {
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
 * @deprecated No longer used - aspects are pre-computed
 */
function aspectsMatch(_a?: string[], _b?: string[]): boolean {
  return true; // Always match since aspects are pre-computed
}

/**
 * Find cached azimuths that contain the requested bounds.
 * Note: excludedAspects parameter is kept for backward compatibility but ignored.
 */
export async function findContainingCachedAzimuths(bounds: Bounds, _excludedAspects?: string[]): Promise<AzimuthData | null> {
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
 * Note: excludedAspects parameter is kept for backward compatibility but ignored.
 */
export async function cacheAzimuths(bounds: Bounds, data: AzimuthData, _excludedAspects?: string[]): Promise<void> {
  try {
    const db = await openDB();
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

    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(AZIMUTHS_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(AZIMUTHS_STORE_NAME);
      store.put(cached);

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
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
 * Note: excludedAspects parameter is kept for backward compatibility but ignored.
 */
export async function getAzimuthsWithContainsCheck(bounds: Bounds, _excludedAspects?: string[]): Promise<AzimuthData | null> {
  const normalizedBounds = normalizeBounds(bounds);
  
  // First check exact match
  const exact = await getCachedAzimuths(normalizedBounds);
  if (exact) return exact;
  
  // Check for containing cached azimuths
  const containing = await findContainingCachedAzimuths(normalizedBounds);
  if (containing) return containing;
  
  return null;
}
