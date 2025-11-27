import type { Aspect } from "@/components/find-path-button";
import { type StoreApi, type UseBoundStore, create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

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

export type HoverIndexStore = UseBoundStore<StoreApi<HoverIndexState>>;
export type GradientStore = UseBoundStore<StoreApi<GradientState>>;

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