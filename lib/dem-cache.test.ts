import { describe, expect, it } from "vitest";
import { type Bounds, boundsContain, expandBounds } from "./dem-cache";

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

  it("limits expansion based on dataset max area", () => {
    // Create large bounds that would exceed API limits
    const largeBounds: Bounds = {
      north: 45.0,
      south: 35.0, // 10 degrees tall
      east: -110.0,
      west: -130.0, // 20 degrees wide
    };

    // Try to expand by 10x - should be limited
    const expanded = expandBounds(largeBounds, 10, "USGS10m");

    // Calculate the area of expanded bounds
    const latDiff = expanded.north - expanded.south;
    const lngDiff = expanded.east - expanded.west;
    const avgLat = (expanded.north + expanded.south) / 2;
    const latKm = latDiff * 111;
    const lngKm = lngDiff * 111 * Math.cos(avgLat * Math.PI / 180);
    const areaKm2 = latKm * lngKm;

    // Should be less than or equal to USGS10m limit of 25000 km²
    expect(areaKm2).toBeLessThanOrEqual(25000);
  });

  it("does not limit small expansions", () => {
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
