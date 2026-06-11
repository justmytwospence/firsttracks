import { describe, expect, it } from "vitest";
import { decodeTerrarium } from "./terrarium";

// Terrarium: elevation = (red * 256 + green + blue / 256) - 32768
describe("decodeTerrarium", () => {
  it("decodes the blue channel's fractional meters", () => {
    // blue=128 contributes 128/256 = 0.5 m. With r=128,g=0 the base is 0,
    // so this isolates the fractional term the previous test never exercised.
    const data = new Uint8ClampedArray([
      128, 0, 128, 255, // 0 + 0.5
      131, 232, 64, 255, // 1000 + 0.25
    ]);
    const elevations = decodeTerrarium({ data, width: 2, height: 1 } as ImageData);
    expect(elevations[0]).toBeCloseTo(0.5, 4);
    expect(elevations[1]).toBeCloseTo(1000.25, 4);
  });

  it("decodes integer elevations across the range", () => {
    const data = new Uint8ClampedArray([
      128, 0, 0, 255, // 0
      127, 156, 0, 255, // -100
      147, 136, 0, 255, // 5000
    ]);
    const elevations = decodeTerrarium({ data, width: 3, height: 1 } as ImageData);
    expect(elevations[0]).toBeCloseTo(0, 4);
    expect(elevations[1]).toBeCloseTo(-100, 4);
    expect(elevations[2]).toBeCloseTo(5000, 4);
  });
});
