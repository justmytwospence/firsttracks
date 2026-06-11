/**
 * DEM store: individual z/x/y tile cache, stitched-grid cache, and the
 * fetch-and-stitch pipeline.
 */

import { INDIVIDUAL_TILES_STORE_NAME, STORE_NAME, openDB, putRecord } from './idb';
import { fetchTerrainTile } from './terrarium';
import {
  type Bounds,
  type ElevationGrid,
  MAX_TILES,
  TERRAIN_TILE_SIZE,
  TERRAIN_TILE_ZOOM,
  boundsContain,
  boundsToKey,
  getTilesForBounds,
  latLngToTile,
  normalizeBounds,
  tileToLatLng,
} from './tile-math';

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


/**
 * Cache DEM tile (ElevationGrid)
 */
async function cacheTile(grid: ElevationGrid): Promise<void> {
  try {
    const tile: CachedTile = {
      key: boundsToKey(grid.bounds),
      bounds: grid.bounds,
      data: grid.data.buffer as ArrayBuffer,
      width: grid.width,
      height: grid.height,
      timestamp: Date.now(),
    };

    await putRecord(STORE_NAME, tile);
  } catch (error) {
    // Cache writes are best-effort: a quota/transaction failure must not
    // abort the operation that produced the data.
    console.warn('[DEM Cache] Failed to cache stitched grid:', error);
  }
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
    const key = tileKey(z, x, y);
    
    const cached: CachedIndividualTile = {
      key,
      z,
      x,
      y,
      data: data.buffer as ArrayBuffer,
      timestamp: Date.now(),
    };

    await putRecord(INDIVIDUAL_TILES_STORE_NAME, cached);
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
        // Only consider the canonical zoom: mixing x/y indices from
        // different zoom levels into one min/max would produce garbage
        // bounds (indices are not comparable across zooms).
        const zoom = TERRAIN_TILE_ZOOM;

        for (const k of keys) {
          if (typeof k !== 'string') continue;
          const parts = k.split('/');
          if (parts.length !== 3) continue;
          const z = Number(parts[0]);
          const x = Number(parts[1]);
          const y = Number(parts[2]);
          if (z !== zoom || !Number.isFinite(x) || !Number.isFinite(y)) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
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

