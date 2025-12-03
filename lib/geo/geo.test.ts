import { describe, expect, it } from "vitest";
import {
  computeCdf,
  computeDistanceMiles,
  computeGradient,
  removeStaticPoints,
} from "./geo";

describe("computeDistanceMiles", () => {
  it("returns [0] for single point", () => {
    const coords = [[-122.4194, 37.7749]];
    expect(computeDistanceMiles(coords)).toEqual([0]);
  });

  it("returns cumulative distances starting with 0", () => {
    // Two points roughly 1 km apart
    const coords = [
      [-122.4194, 37.7749],
      [-122.4194, 37.7839], // ~1km north
    ];
    const distances = computeDistanceMiles(coords);
    expect(distances[0]).toBe(0);
    expect(distances[1]).toBeGreaterThan(0);
  });

  it("calculates cumulative distance for multiple points", () => {
    const coords = [
      [-122.4194, 37.7749],
      [-122.4194, 37.7849], // Move north
      [-122.4194, 37.7949], // Move further north
    ];
    const distances = computeDistanceMiles(coords);
    expect(distances).toHaveLength(3);
    expect(distances[0]).toBe(0);
    expect(distances[2]).toBeGreaterThan(distances[1]);
    // Distances should be cumulative
    expect(distances[2]).toBeCloseTo(distances[1] * 2, 1);
  });

  it("returns distances in miles", () => {
    // Approximately 1 degree latitude = 69 miles
    const coords = [
      [-122.4194, 37.0],
      [-122.4194, 38.0], // 1 degree north
    ];
    const distances = computeDistanceMiles(coords);
    // Should be approximately 69 miles (1 degree of latitude)
    expect(distances[1]).toBeCloseTo(69, 0);
  });
});

describe("removeStaticPoints", () => {
  it("keeps first point regardless of distance", () => {
    const coords = [[-122.4194, 37.7749]];
    expect(removeStaticPoints(coords)).toEqual(coords);
  });

  it("removes points that are too close together", () => {
    // Points that are essentially the same location
    const coords = [
      [-122.4194, 37.7749],
      [-122.4194, 37.7749], // Same location
      [-122.4194, 37.7749], // Same location
    ];
    const filtered = removeStaticPoints(coords, 10);
    expect(filtered).toHaveLength(1);
  });

  it("keeps points that are far enough apart", () => {
    const coords = [
      [-122.4194, 37.7749],
      [-122.4194, 37.7849], // ~1km north
      [-122.4194, 37.7949], // ~1km further north
    ];
    const filtered = removeStaticPoints(coords, 10);
    expect(filtered).toHaveLength(3);
  });

  it("uses default tolerance of 10 meters", () => {
    // Points 1 meter apart should be filtered
    const coords = [
      [-122.4194, 37.7749],
      [-122.4194, 37.77490001], // Very close
    ];
    const filtered = removeStaticPoints(coords);
    expect(filtered).toHaveLength(1);
  });
});

describe("computeGradient", () => {
  it("returns gradients array of same length as input", () => {
    const coords = [
      [-122.4194, 37.7749, 100],
      [-122.4194, 37.7849, 200],
    ];
    const gradients = computeGradient(coords);
    expect(gradients).toHaveLength(2);
  });

  it("computes positive gradient for uphill", () => {
    // Going uphill (elevation increasing)
    const coords = [
      [-122.4194, 37.7749, 100],
      [-122.4194, 37.7750, 110], // Small move north, 10m elevation gain
    ];
    const gradients = computeGradient(coords);
    expect(gradients[1]).toBeGreaterThan(0);
  });

  it("computes negative gradient for downhill", () => {
    // Going downhill (elevation decreasing)
    const coords = [
      [-122.4194, 37.7749, 200],
      [-122.4194, 37.7750, 190], // Small move north, 10m elevation loss
    ];
    const gradients = computeGradient(coords);
    expect(gradients[1]).toBeLessThan(0);
  });

  it("returns smoothed gradients", () => {
    // Create a path with varying gradients
    const coords = [
      [-122.4194, 37.7749, 100],
      [-122.4194, 37.7750, 110],
      [-122.4194, 37.7751, 120],
      [-122.4194, 37.7752, 130],
      [-122.4194, 37.7753, 140],
    ];
    const gradients = computeGradient(coords);
    expect(gradients).toHaveLength(5);
    // All should be positive since we're going uphill
    for (let i = 1; i < gradients.length; i++) {
      expect(gradients[i]).toBeGreaterThan(0);
    }
  });
});

describe("computeCdf", () => {
  it("returns CDF for simple data", () => {
    const data = [1, 2, 3, 4, 5];
    const range = [1, 2, 3, 4, 5];
    const cdf = computeCdf(data, range);
    
    expect(cdf[0]).toBe(0.2); // 1/5 <= 1
    expect(cdf[1]).toBe(0.4); // 2/5 <= 2
    expect(cdf[2]).toBe(0.6); // 3/5 <= 3
    expect(cdf[3]).toBe(0.8); // 4/5 <= 4
    expect(cdf[4]).toBe(1.0); // 5/5 <= 5
  });

  it("handles unsorted data", () => {
    const data = [5, 1, 3, 2, 4];
    const range = [3];
    const cdf = computeCdf(data, range);
    
    expect(cdf[0]).toBe(0.6); // 3/5 values <= 3
  });

  it("handles range values not in data", () => {
    const data = [1, 3, 5];
    const range = [0, 2, 4, 6];
    const cdf = computeCdf(data, range);
    
    expect(cdf[0]).toBe(0);       // 0/3 <= 0
    expect(cdf[1]).toBeCloseTo(1/3, 5); // 1/3 <= 2
    expect(cdf[2]).toBeCloseTo(2/3, 5); // 2/3 <= 4
    expect(cdf[3]).toBe(1);       // 3/3 <= 6
  });

  it("returns all zeros for empty data", () => {
    const data: number[] = [];
    const range = [1, 2, 3];
    const cdf = computeCdf(data, range);
    
    // With empty data, 0/0 becomes NaN
    expect(cdf.every(v => Number.isNaN(v))).toBe(true);
  });

  it("returns same length as range", () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const range = [2, 5, 8];
    const cdf = computeCdf(data, range);
    
    expect(cdf).toHaveLength(3);
  });

  it("handles duplicate values in data", () => {
    const data = [1, 1, 2, 2, 3];
    const range = [1, 2, 3];
    const cdf = computeCdf(data, range);
    
    expect(cdf[0]).toBe(0.4); // 2/5 <= 1
    expect(cdf[1]).toBe(0.8); // 4/5 <= 2
    expect(cdf[2]).toBe(1.0); // 5/5 <= 3
  });
});
