import { describe, expect, it, beforeEach } from "vitest";
import {
  createAspectStore,
  createGradientStore,
  createHoverIndexStore,
  createSlopeUnitStore,
} from "./store";

describe("hoverIndexStore", () => {
  it("initializes with hoverIndex of -1", () => {
    const store = createHoverIndexStore();
    expect(store.getState().hoverIndex).toBe(-1);
  });

  it("updates hoverIndex when setHoverIndex is called", () => {
    const store = createHoverIndexStore();
    store.getState().setHoverIndex(5);
    expect(store.getState().hoverIndex).toBe(5);
  });

  it("does not trigger update when setting same index", () => {
    const store = createHoverIndexStore();
    store.getState().setHoverIndex(5);
    
    let updateCount = 0;
    store.subscribe(() => {
      updateCount++;
    });
    
    store.getState().setHoverIndex(5);
    expect(updateCount).toBe(0);
  });

  it("triggers update when setting different index", () => {
    const store = createHoverIndexStore();
    store.getState().setHoverIndex(5);
    
    let updateCount = 0;
    store.subscribe(() => {
      updateCount++;
    });
    
    store.getState().setHoverIndex(10);
    expect(updateCount).toBe(1);
  });
});

describe("gradientStore", () => {
  it("initializes with null hoveredGradient and cdf mode", () => {
    const store = createGradientStore();
    const state = store.getState();
    expect(state.hoveredGradient).toBe(null);
    expect(state.gradientHighlightMode).toBe("cdf");
  });

  it("updates hoveredGradient when setHoveredGradient is called", () => {
    const store = createGradientStore();
    store.getState().setHoveredGradient(0.30);
    expect(store.getState().hoveredGradient).toBe(0.30);
  });

  it("updates gradientHighlightMode when provided", () => {
    const store = createGradientStore();
    store.getState().setHoveredGradient(0.30, "histogram");
    expect(store.getState().gradientHighlightMode).toBe("histogram");
  });

  it("defaults to cdf mode when mode is not provided", () => {
    const store = createGradientStore();
    store.getState().setHoveredGradient(0.30, "histogram");
    store.getState().setHoveredGradient(0.40); // No mode specified
    expect(store.getState().gradientHighlightMode).toBe("cdf");
  });

  it("clears gradient when set to null", () => {
    const store = createGradientStore();
    store.getState().setHoveredGradient(0.30);
    store.getState().setHoveredGradient(null);
    expect(store.getState().hoveredGradient).toBe(null);
  });

  it("does not trigger update when setting same gradient and mode", () => {
    const store = createGradientStore();
    store.getState().setHoveredGradient(0.30, "cdf");
    
    let updateCount = 0;
    store.subscribe(() => {
      updateCount++;
    });
    
    store.getState().setHoveredGradient(0.30, "cdf");
    expect(updateCount).toBe(0);
  });
});

describe("aspectStore", () => {
  it("initializes with null hoveredAspect", () => {
    const store = createAspectStore();
    expect(store.getState().hoveredAspect).toBe(null);
  });

  it("updates hoveredAspect when setHoveredAspect is called", () => {
    const store = createAspectStore();
    store.getState().setHoveredAspect("north");
    expect(store.getState().hoveredAspect).toBe("north");
  });

  it("clears aspect when set to null", () => {
    const store = createAspectStore();
    store.getState().setHoveredAspect("south");
    store.getState().setHoveredAspect(null);
    expect(store.getState().hoveredAspect).toBe(null);
  });

  it("handles all aspect values", () => {
    const store = createAspectStore();
    const aspects = [
      "north",
      "northeast",
      "east",
      "southeast",
      "south",
      "southwest",
      "west",
      "northwest",
      "flat",
    ] as const;

    for (const aspect of aspects) {
      store.getState().setHoveredAspect(aspect);
      expect(store.getState().hoveredAspect).toBe(aspect);
    }
  });

  it("does not trigger update when setting same aspect", () => {
    const store = createAspectStore();
    store.getState().setHoveredAspect("north");
    
    let updateCount = 0;
    store.subscribe(() => {
      updateCount++;
    });
    
    store.getState().setHoveredAspect("north");
    expect(updateCount).toBe(0);
  });
});

describe("slopeUnitStore", () => {
  it("initializes with useDegrees as false", () => {
    const store = createSlopeUnitStore();
    expect(store.getState().useDegrees).toBe(false);
  });

  it("updates useDegrees when setUseDegrees is called with true", () => {
    const store = createSlopeUnitStore();
    store.getState().setUseDegrees(true);
    expect(store.getState().useDegrees).toBe(true);
  });

  it("updates useDegrees when setUseDegrees is called with false", () => {
    const store = createSlopeUnitStore();
    store.getState().setUseDegrees(true);
    store.getState().setUseDegrees(false);
    expect(store.getState().useDegrees).toBe(false);
  });

  it("toggles value correctly", () => {
    const store = createSlopeUnitStore();
    const initial = store.getState().useDegrees;
    store.getState().setUseDegrees(!initial);
    expect(store.getState().useDegrees).toBe(!initial);
    store.getState().setUseDegrees(initial);
    expect(store.getState().useDegrees).toBe(initial);
  });
});
