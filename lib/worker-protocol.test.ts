import { describe, expect, it, vi } from "vitest";
import {
  type ExplorationBatch,
  createExplorationReassembler,
  pixelScaleFromBounds,
} from "./worker-protocol";

describe("pixelScaleFromBounds", () => {
  it("computes degrees-per-pixel with a negative y scale", () => {
    const { pixelScaleX, pixelScaleY } = pixelScaleFromBounds(
      { north: 40, south: 39, east: -105, west: -106 },
      100,
      50,
    );
    expect(pixelScaleX).toBeCloseTo((-105 - -106) / 100, 10); // 0.01
    // Latitude decreases as raster y increases, so y scale is negative.
    expect(pixelScaleY).toBeCloseTo((39 - 40) / 50, 10); // -0.02
    expect(pixelScaleY).toBeLessThan(0);
  });
});

describe("createExplorationReassembler", () => {
  it("merges cached init constants into each cells batch", () => {
    const emitted: ExplorationBatch[] = [];
    const cb = createExplorationReassembler((b) => emitted.push(b));

    cb({ type: "init", originX: -106, originY: 40, scaleX: 0.01, scaleY: -0.02, width: 100, height: 50 });
    cb({ cells: new Uint16Array([1, 2, 3, 4]) });
    cb({ cells: new Uint16Array([5, 6]) });

    expect(emitted).toHaveLength(2);
    expect(Array.from(emitted[0].cells)).toEqual([1, 2, 3, 4]);
    expect(emitted[0]).toMatchObject({
      originX: -106,
      originY: 40,
      scaleX: 0.01,
      scaleY: -0.02,
      width: 100,
      height: 50,
    });
    // Second batch reuses the same cached constants.
    expect(Array.from(emitted[1].cells)).toEqual([5, 6]);
    expect(emitted[1].width).toBe(100);
  });

  it("drops cells that arrive before init", () => {
    const emit = vi.fn();
    const cb = createExplorationReassembler(emit);
    cb({ cells: new Uint16Array([1, 2]) });
    expect(emit).not.toHaveBeenCalled();
  });

  it("ignores init messages that carry no cells", () => {
    const emit = vi.fn();
    const cb = createExplorationReassembler(emit);
    cb({ type: "init", originX: 0, originY: 0, scaleX: 1, scaleY: -1, width: 10, height: 10 });
    expect(emit).not.toHaveBeenCalled();
  });
});
