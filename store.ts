import type { Aspect } from "@/components/find-path-button";
import { type StoreApi, type UseBoundStore, create } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";

interface HoverIndexState {
  hoverIndex: number;
  setHoverIndex: (index: number) => void;
}

interface GradientState {
  hoveredGradient: number | null;
  gradientHighlightMode: 'cdf' | 'histogram';  // 'cdf' = <= threshold, 'histogram' = exact bin
  setHoveredGradient: (gradient: number | null, mode?: 'cdf' | 'histogram') => void;
}

interface AspectState {
  hoveredAspect: Aspect | null;
  setHoveredAspect: (aspect: Aspect | null) => void;
}

interface SlopeUnitState {
  useDegrees: boolean;
  setUseDegrees: (useDegrees: boolean) => void;
}

interface ProgressState {
  active: boolean;
  label: string | null;
  fraction: number | null;
  tone: 'info' | 'error';
  start: (label: string) => void;
  update: (patch: { label?: string; fraction?: number | null }) => void;
  finish: () => void;
  fail: (label: string) => void;
}

export type HoverIndexStore = UseBoundStore<StoreApi<HoverIndexState>>;
export type GradientStore = UseBoundStore<StoreApi<GradientState>>;
export type SlopeUnitStore = UseBoundStore<StoreApi<SlopeUnitState>>;
export type ProgressStore = UseBoundStore<StoreApi<ProgressState>>;

export const createHoverIndexStore = () => create<HoverIndexState>()(
  subscribeWithSelector((set) => ({
    hoverIndex: -1,
    setHoverIndex: (index) => set((state) => {
      if (state.hoverIndex === index) return state;
      return { hoverIndex: index };
    }),
  }))
);
export const hoverIndexStore = createHoverIndexStore();

export const createGradientStore = () => create<GradientState>()(
  subscribeWithSelector((set) => ({
    hoveredGradient: null,
    gradientHighlightMode: 'cdf',
    setHoveredGradient: (gradient, mode = 'cdf') => set((state) => {
      if (state.hoveredGradient === gradient && state.gradientHighlightMode === mode) return state;
      return { hoveredGradient: gradient, gradientHighlightMode: mode };
    }),
  }))
);
export const gradientStore = createGradientStore();

export const createAspectStore = () => create<AspectState>()(
  subscribeWithSelector((set) => ({
    hoveredAspect: null,
    setHoveredAspect: (aspect) => set((state) => {
      if (state.hoveredAspect === aspect) return state;
      return { hoveredAspect: aspect };
    }),
  }))
);
export const aspectStore = createAspectStore();

export const createSlopeUnitStore = () => create<SlopeUnitState>()(
  persist(
    subscribeWithSelector((set) => ({
      useDegrees: true,
      setUseDegrees: (useDegrees) => set({ useDegrees }),
    })),
    {
      name: 'pathfinder-slope-unit',
    }
  )
);
export const slopeUnitStore = createSlopeUnitStore();

// Tracks a single in-flight long-running operation (DEM download, aspect
// computation, A* search) for the GlobalProgressBar. Only one runs at a time.
export const createProgressStore = () => {
  let clearTimer: ReturnType<typeof setTimeout> | null = null;

  return create<ProgressState>()(
    subscribeWithSelector((set) => {
      const cancelClearTimer = () => {
        if (clearTimer) {
          clearTimeout(clearTimer);
          clearTimer = null;
        }
      };

      return {
        active: false,
        label: null,
        fraction: null,
        tone: 'info',
        start: (label) => {
          cancelClearTimer();
          set({ active: true, label, fraction: null, tone: 'info' });
        },
        update: (patch) => set((state) => {
          if (!state.active) return state;
          const next: Partial<ProgressState> = {};
          if (patch.label !== undefined && patch.label !== state.label) next.label = patch.label;
          if (patch.fraction !== undefined && patch.fraction !== state.fraction) next.fraction = patch.fraction;
          return Object.keys(next).length ? next : state;
        }),
        finish: () => {
          cancelClearTimer();
          // Snap to 100% briefly so a determinate run reads as complete, then clear.
          set((state) => state.fraction !== null ? { fraction: 1 } : state);
          clearTimer = setTimeout(() => {
            clearTimer = null;
            set({ active: false, label: null, fraction: null, tone: 'info' });
          }, 250);
        },
        fail: (label) => {
          cancelClearTimer();
          set({ active: true, label, tone: 'error' });
          clearTimer = setTimeout(() => {
            clearTimer = null;
            set({ active: false, label: null, fraction: null, tone: 'info' });
          }, 1500);
        },
      };
    })
  );
};
export const progressStore = createProgressStore();