import { describe, expect, it } from "vitest";
import {
  type Bounds,
  MAX_TILES,
  TERRAIN_TILE_ZOOM,
  boundsToKey,
  countTilesForBounds,
  getTilesForBounds,
  latLngToTile,
  normalizeBounds,
  unionBounds,
} from "./tile-math";

describe("latLngToTile clamping", () => {
  it("clamps latitude beyond the Web Mercator domain", () => {
    const n = 2 ** TERRAIN_TILE_ZOOM;
    // Above the +85.0511 cutoff, y must stay at the top tile (0), not go negative.
    expect(latLngToTile(89, 0, TERRAIN_TILE_ZOOM).y).toBe(latLngToTile(85.05, 0, TERRAIN_TILE_ZOOM).y);
    expect(latLngToTile(89, 0, TERRAIN_TILE_ZOOM).y).toBeGreaterThanOrEqual(0);
    // Below -85.0511, y must stay within range, not exceed n-1.
    expect(latLngToTile(-89, 0, TERRAIN_TILE_ZOOM).y).toBeLessThanOrEqual(n - 1);
  });

  it("clamps longitude at the antimeridian to a valid tile index", () => {
    const n = 2 ** TERRAIN_TILE_ZOOM;
    // lng exactly 180 would map to x = n (off the grid) without clamping.
    expect(latLngToTile(0, 180, TERRAIN_TILE_ZOOM).x).toBe(n - 1);
    expect(latLngToTile(0, -180, TERRAIN_TILE_ZOOM).x).toBe(0);
  });
});

describe("getTilesForBounds MAX_TILES cap", () => {
  it("never returns more than MAX_TILES for a large area", () => {
    // A multi-degree box at z14 would be tens of thousands of tiles uncapped.
    const huge: Bounds = { north: 45, south: 40, east: -100, west: -110 };
    const tiles = getTilesForBounds(huge, TERRAIN_TILE_ZOOM);
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThanOrEqual(MAX_TILES);
  });

  it("returns tiles in row-major order", () => {
    const tiles = getTilesForBounds(
      { north: 40.02, south: 40.0, east: -105.0, west: -105.02 },
      TERRAIN_TILE_ZOOM,
    );
    for (let i = 1; i < tiles.length; i++) {
      const prev = tiles[i - 1];
      const cur = tiles[i];
      // Either same row advancing in x, or a new row.
      const ordered = cur.y > prev.y || (cur.y === prev.y && cur.x > prev.x);
      expect(ordered).toBe(true);
    }
  });
});

describe("countTilesForBounds", () => {
  it("matches the length of getTilesForBounds below the cap", () => {
    const small: Bounds = { north: 40.02, south: 40.0, east: -105.0, west: -105.02 };
    expect(countTilesForBounds(small, TERRAIN_TILE_ZOOM)).toBe(
      getTilesForBounds(small, TERRAIN_TILE_ZOOM).length,
    );
  });
});

describe("normalizeBounds / boundsToKey", () => {
  const bounds: Bounds = {
    north: 40.123456,
    south: 39.987654,
    east: -105.123456,
    west: -105.987654,
  };

  it("rounds to 3 decimal places", () => {
    const n = normalizeBounds(bounds);
    expect(n.north).toBe(40.123);
    expect(n.south).toBe(39.988);
    expect(n.east).toBe(-105.123);
    expect(n.west).toBe(-105.988);
  });

  it("produces identical keys for inputs that round the same", () => {
    const a = boundsToKey(bounds);
    const b = boundsToKey({ ...bounds, north: 40.1234 });
    expect(a).toBe(b);
    expect(a).toBe("dem_40.123_39.988_-105.123_-105.988");
  });
});

describe("unionBounds", () => {
  it("returns the smallest box containing both inputs", () => {
    const a: Bounds = { north: 40, south: 39, east: -105, west: -106 };
    const b: Bounds = { north: 41, south: 39.5, east: -104, west: -105.5 };
    expect(unionBounds(a, b)).toEqual({
      north: 41,
      south: 39,
      east: -104,
      west: -106,
    });
  });
});
