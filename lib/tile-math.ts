/**
 * Tile and bounds math for Web Mercator slippy tiles.
 * Pure functions only - no I/O, no IndexedDB.
 */

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

/** Progress update from a long-running fetch — message plus optional fraction. */
export interface ProgressInfo {
  message: string;
  done?: number;
  total?: number;
}

export type ProgressCallback = (info: ProgressInfo) => void;

/** Zoom 14 provides ~10m resolution (comparable to USGS10m). */
export const TERRAIN_TILE_ZOOM = 14;
export const TERRAIN_TILE_SIZE = 256;

/**
 * Maximum number of tiles that can be fetched for a single request.
 * 400 tiles = 20x20 grid = 5120x5120 pixels ≈ 100MB Float32Array.
 * This prevents browser memory exhaustion when requesting large areas.
 */
export const MAX_TILES = 400;

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
 * Generate a cache key from bounds
 * Round to 3 decimal places (~111m precision) to improve cache hits
 * when bounds change slightly due to floating point or minor map movements
 */
export function boundsToKey(bounds: Bounds): string {
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
export function normalizeBounds(bounds: Bounds): Bounds {
  return {
    north: Number(bounds.north.toFixed(3)),
    south: Number(bounds.south.toFixed(3)),
    east: Number(bounds.east.toFixed(3)),
    west: Number(bounds.west.toFixed(3)),
  };
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
export function countTilesForBounds(bounds: Bounds, zoom: number): number {
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
