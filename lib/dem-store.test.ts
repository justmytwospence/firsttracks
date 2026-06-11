import { describe, expect, it } from "vitest";
import { stitchTiles } from "./dem-store";
import { TERRAIN_TILE_SIZE } from "./tile-math";

// Build a tile whose every sample equals `value`.
function solidTile(value: number): Float32Array {
  return new Float32Array(TERRAIN_TILE_SIZE * TERRAIN_TILE_SIZE).fill(value);
}

describe("stitchTiles", () => {
  it("places each tile at its grid offset with no seam overlap", () => {
    // 2x1 grid: tile (0,0)=10, tile (1,0)=20.
    const grid = stitchTiles(
      [
        { x: 0, y: 0, data: solidTile(10) },
        { x: 1, y: 0, data: solidTile(20) },
      ],
      2,
      1,
    );

    expect(grid.width).toBe(2 * TERRAIN_TILE_SIZE);
    expect(grid.height).toBe(TERRAIN_TILE_SIZE);

    // Left tile's last column and right tile's first column are distinct
    // samples (slippy tiles don't share edges) — no off-by-one bleed.
    const row = 0;
    expect(grid.data[row * grid.width + (TERRAIN_TILE_SIZE - 1)]).toBe(10);
    expect(grid.data[row * grid.width + TERRAIN_TILE_SIZE]).toBe(20);
  });

  it("places tiles into the correct rows for a 2x2 grid", () => {
    const grid = stitchTiles(
      [
        { x: 0, y: 0, data: solidTile(1) },
        { x: 1, y: 0, data: solidTile(2) },
        { x: 0, y: 1, data: solidTile(3) },
        { x: 1, y: 1, data: solidTile(4) },
      ],
      2,
      2,
    );

    const w = grid.width;
    const at = (col: number, r: number) => grid.data[r * w + col];
    // Sample one pixel well inside each quadrant.
    expect(at(10, 10)).toBe(1); // top-left
    expect(at(TERRAIN_TILE_SIZE + 10, 10)).toBe(2); // top-right
    expect(at(10, TERRAIN_TILE_SIZE + 10)).toBe(3); // bottom-left
    expect(at(TERRAIN_TILE_SIZE + 10, TERRAIN_TILE_SIZE + 10)).toBe(4); // bottom-right
  });
});
