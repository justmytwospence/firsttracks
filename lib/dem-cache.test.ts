import { describe, expect, it } from "vitest";
import { type Bounds, boundsContain, expandBounds, latLngToTile, tileToLatLng, getTilesForBounds, decodeTerrarium } from "./dem-cache";

describe("boundsContain", () => {
  const outerBounds: Bounds = {
    north: 40.0,
    south: 38.0,
    east: -120.0,
    west: -122.0,
  };

  it("returns true when outer fully contains inner", () => {
    const innerBounds: Bounds = {
      north: 39.5,
      south: 38.5,
      east: -120.5,
      west: -121.5,
    };
    expect(boundsContain(outerBounds, innerBounds)).toBe(true);
  });

  it("returns true when bounds are identical", () => {
    expect(boundsContain(outerBounds, outerBounds)).toBe(true);
  });

  it("returns false when inner extends north of outer", () => {
    const innerBounds: Bounds = {
      north: 40.5, // Extends beyond outer.north
      south: 38.5,
      east: -120.5,
      west: -121.5,
    };
    expect(boundsContain(outerBounds, innerBounds)).toBe(false);
  });

  it("returns false when inner extends south of outer", () => {
    const innerBounds: Bounds = {
      north: 39.5,
      south: 37.5, // Extends beyond outer.south
      east: -120.5,
      west: -121.5,
    };
    expect(boundsContain(outerBounds, innerBounds)).toBe(false);
  });

  it("returns false when inner extends east of outer", () => {
    const innerBounds: Bounds = {
      north: 39.5,
      south: 38.5,
      east: -119.5, // Extends beyond outer.east (less negative = more east)
      west: -121.5,
    };
    expect(boundsContain(outerBounds, innerBounds)).toBe(false);
  });

  it("returns false when inner extends west of outer", () => {
    const innerBounds: Bounds = {
      north: 39.5,
      south: 38.5,
      east: -120.5,
      west: -122.5, // Extends beyond outer.west (more negative = more west)
    };
    expect(boundsContain(outerBounds, innerBounds)).toBe(false);
  });

  it("returns false when inner is completely outside outer", () => {
    const innerBounds: Bounds = {
      north: 45.0,
      south: 44.0,
      east: -110.0,
      west: -112.0,
    };
    expect(boundsContain(outerBounds, innerBounds)).toBe(false);
  });

  it("returns true when inner touches outer boundaries exactly", () => {
    const innerBounds: Bounds = {
      north: 40.0, // Same as outer.north
      south: 38.0, // Same as outer.south
      east: -120.0, // Same as outer.east
      west: -122.0, // Same as outer.west
    };
    expect(boundsContain(outerBounds, innerBounds)).toBe(true);
  });
});

describe("expandBounds", () => {
  const baseBounds: Bounds = {
    north: 37.8,
    south: 37.7,
    east: -122.4,
    west: -122.5,
  };

  it("expands bounds by the given factor", () => {
    const expanded = expandBounds(baseBounds, 2);
    const originalWidth = baseBounds.east - baseBounds.west; // 0.1
    const originalHeight = baseBounds.north - baseBounds.south; // 0.1

    const newWidth = expanded.east - expanded.west;
    const newHeight = expanded.north - expanded.south;

    expect(newWidth).toBeCloseTo(originalWidth * 2, 5);
    expect(newHeight).toBeCloseTo(originalHeight * 2, 5);
  });

  it("keeps the center point the same", () => {
    const expanded = expandBounds(baseBounds, 3);

    const originalCenterLat = (baseBounds.north + baseBounds.south) / 2;
    const originalCenterLon = (baseBounds.east + baseBounds.west) / 2;

    const newCenterLat = (expanded.north + expanded.south) / 2;
    const newCenterLon = (expanded.east + expanded.west) / 2;

    expect(newCenterLat).toBeCloseTo(originalCenterLat, 5);
    expect(newCenterLon).toBeCloseTo(originalCenterLon, 5);
  });

  it("returns same bounds when factor is 1", () => {
    const expanded = expandBounds(baseBounds, 1);

    expect(expanded.north).toBeCloseTo(baseBounds.north, 5);
    expect(expanded.south).toBeCloseTo(baseBounds.south, 5);
    expect(expanded.east).toBeCloseTo(baseBounds.east, 5);
    expect(expanded.west).toBeCloseTo(baseBounds.west, 5);
  });

  it("shrinks bounds when factor is less than 1", () => {
    const expanded = expandBounds(baseBounds, 0.5);
    const originalWidth = baseBounds.east - baseBounds.west;
    const originalHeight = baseBounds.north - baseBounds.south;

    const newWidth = expanded.east - expanded.west;
    const newHeight = expanded.north - expanded.south;

    expect(newWidth).toBeCloseTo(originalWidth * 0.5, 5);
    expect(newHeight).toBeCloseTo(originalHeight * 0.5, 5);
  });

  it("does not limit small expansions (no API limits with AWS Terrain Tiles)", () => {
    // Small bounds that won't exceed limits even when expanded
    const smallBounds: Bounds = {
      north: 37.80,
      south: 37.79,
      east: -122.40,
      west: -122.41,
    };

    const expanded = expandBounds(smallBounds, 3);
    const originalWidth = smallBounds.east - smallBounds.west;
    const originalHeight = smallBounds.north - smallBounds.south;

    const newWidth = expanded.east - expanded.west;
    const newHeight = expanded.north - expanded.south;

    // Should be exactly 3x without limiting
    expect(newWidth).toBeCloseTo(originalWidth * 3, 5);
    expect(newHeight).toBeCloseTo(originalHeight * 3, 5);
  });
});

describe("tile coordinate utilities", () => {
  describe("latLngToTile", () => {
    it("converts known coordinate to correct tile", () => {
      // San Francisco at zoom 14
      const result = latLngToTile(37.7749, -122.4194, 14);
      // Expected tile for SF at zoom 14 is approximately x=2620, y=6332
      expect(result.x).toBe(2620);
      expect(result.y).toBe(6332);
    });

    it("handles prime meridian and equator", () => {
      const result = latLngToTile(0, 0, 10);
      const n = 2 ** 10;
      expect(result.x).toBe(Math.floor(n / 2)); // Should be at center x
      expect(result.y).toBe(Math.floor(n / 2)); // Should be at center y
    });

    it("handles negative longitudes (Western hemisphere)", () => {
      const result = latLngToTile(40.7128, -74.006, 10); // New York
      expect(result.x).toBeGreaterThan(0);
      expect(result.x).toBeLessThan(2 ** 10);
    });
  });

  describe("tileToLatLng", () => {
    it("converts tile back to coordinates", () => {
      const tile = { x: 2620, y: 6332 };
      const result = tileToLatLng(tile.x, tile.y, 14);
      // Should be near San Francisco
      expect(result.lat).toBeCloseTo(37.78, 1);
      expect(result.lng).toBeCloseTo(-122.45, 1);
    });

    it("returns expected values for known tiles", () => {
      // Top-left corner of the world at any zoom
      const corner = tileToLatLng(0, 0, 1);
      expect(corner.lng).toBe(-180);
      expect(corner.lat).toBeCloseTo(85.05, 1); // Web Mercator max lat
    });
  });

  describe("getTilesForBounds", () => {
    it("returns correct number of tiles for small area", () => {
      const bounds: Bounds = {
        north: 37.78,
        south: 37.77,
        east: -122.40,
        west: -122.42,
      };
      const tiles = getTilesForBounds(bounds, 14);
      // Small area should be covered by 1-4 tiles at zoom 14
      expect(tiles.length).toBeGreaterThanOrEqual(1);
      expect(tiles.length).toBeLessThanOrEqual(4);
    });

    it("returns tiles in row-major order", () => {
      const bounds: Bounds = {
        north: 38.0,
        south: 37.5,
        east: -122.0,
        west: -122.5,
      };
      const tiles = getTilesForBounds(bounds, 10);
      // Verify tiles are ordered correctly (top-to-bottom, left-to-right within each row)
      for (let i = 1; i < tiles.length; i++) {
        const prev = tiles[i - 1];
        const curr = tiles[i];
        // Either same row and x increased, or new row
        const sameRow = curr.y === prev.y;
        if (sameRow) {
          expect(curr.x).toBeGreaterThan(prev.x);
        } else {
          expect(curr.y).toBeGreaterThan(prev.y);
        }
      }
    });
  });
});

describe("decodeTerrarium", () => {
  it("decodes Terrarium format correctly", () => {
    // Create mock ImageData with known values
    // Terrarium formula: elevation = (red * 256 + green + blue / 256) - 32768
    // For elevation 0: (128 * 256 + 0) - 32768 = 32768 - 32768 = 0
    // For elevation 1000: (131 * 256 + 232) - 32768 = 33768 - 32768 = 1000
    // For elevation -100: (127 * 256 + 156) - 32768 = 32668 - 32768 = -100
    // For elevation 5000: (147 * 256 + 136) - 32768 = 37768 - 32768 = 5000
    const width = 2;
    const height = 2;
    const data = new Uint8ClampedArray([
      // Pixel 0: elevation 0
      128, 0, 0, 255,
      // Pixel 1: elevation 1000
      131, 232, 0, 255,
      // Pixel 2: elevation -100
      127, 156, 0, 255,
      // Pixel 3: elevation 5000
      147, 136, 0, 255,
    ]);
    
    const imageData = { data, width, height } as ImageData;
    const elevations = decodeTerrarium(imageData);
    
    expect(elevations.length).toBe(4);
    expect(elevations[0]).toBeCloseTo(0, 1);
    expect(elevations[1]).toBeCloseTo(1000, 1);
    expect(elevations[2]).toBeCloseTo(-100, 1);
    expect(elevations[3]).toBeCloseTo(5000, 1);
  });
});
