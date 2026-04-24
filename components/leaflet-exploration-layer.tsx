'use client';

import L from 'leaflet';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { useMap } from 'react-leaflet';

export interface ExplorationData {
  cells: Uint16Array;
  originX: number;
  originY: number;
  scaleX: number;
  scaleY: number;
  width: number;
  height: number;
}

export interface ExplorationLayerHandle {
  addCells: (data: ExplorationData) => void;
  flush: () => void;
  clear: () => void;
}

interface LeafletExplorationLayerProps {
  color?: string;
}

// Visual rate of frontier expansion, in grid cells of radius per second.
// At z14 Terrarium tiles (~10 m/cell) with the typical map zoom this is
// roughly 500 screen px / 10 s, which reads as a smooth "ping" expanding
// outward. The natural A* expansion is constant *area* per second, which
// means the raw radial rate drops as 1/r — buffering cells by distance and
// releasing them at this fixed rate converts that into a perceptually
// constant-speed wavefront.
const RADIAL_SPEED_CELLS_PER_SEC = 50;

// When flush() is called (pathfinding complete), drain the remaining
// buckets over this window so the final state settles smoothly.
const FLUSH_DRAIN_MS = 300;

/**
 * Canvas-based exploration frontier overlay with radial pacing.
 *
 * The pathfinder's A* search explores at ~constant area/sec, so the natural
 * radius grows as sqrt(t) and the leading edge appears to slow as the disc
 * gets bigger. This layer intercepts incoming cells, buckets them by
 * distance from the search start, and reveals rings at a constant radial
 * rate — so the visible frontier advances at a steady speed regardless of
 * how fast or slow the underlying search is running.
 *
 * The offscreen canvas is allocated once to the full DEM raster on the
 * first batch; every cell draw is a single fillRect at its grid coords.
 */
export const LeafletExplorationLayer = forwardRef<ExplorationLayerHandle, LeafletExplorationLayerProps>(
  function LeafletExplorationLayer({ color = 'rgba(59, 130, 246, 0.4)' }, ref) {
    const map = useMap();
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const layerRef = useRef<L.Layer | null>(null);

    // Full-raster offscreen canvas (grid space).
    const offscreenRef = useRef<OffscreenCanvas | null>(null);
    const offscreenCtxRef = useRef<OffscreenCanvasRenderingContext2D | null>(null);

    // Raster transform captured on the first batch.
    const transformRef = useRef<{
      originX: number;
      originY: number;
      scaleX: number;
      scaleY: number;
      width: number;
      height: number;
    } | null>(null);

    // Radial pacer state.
    const startCellRef = useRef<{ x: number; y: number } | null>(null);
    const sessionStartMsRef = useRef<number | null>(null);
    // buckets[r] holds a flat [x0, y0, x1, y1, ...] of cells at integer radius r.
    const bucketsRef = useRef<Map<number, number[]>>(new Map());
    const nextRadiusRef = useRef(0);
    const maxPopulatedRadiusRef = useRef(0);

    const isFlushingRef = useRef(false);
    const flushStartMsRef = useRef(0);
    const flushFromRadiusRef = useRef(0);

    const hasCellsRef = useRef(false);

    // RAF control
    const blitRafIdRef = useRef<number | null>(null);
    const needsBlitRef = useRef(false);
    const revealRafIdRef = useRef<number | null>(null);

    const colorRef = useRef(color);
    colorRef.current = color;

    // Draw a single cell to the offscreen (no bounds/transform work — just a fillRect).
    const drawCell = useCallback((x: number, y: number) => {
      const ctx = offscreenCtxRef.current;
      if (!ctx) return;
      ctx.fillRect(x, y, 1, 1);
    }, []);

    const blit = useCallback(() => {
      blitRafIdRef.current = null;
      needsBlitRef.current = false;

      const canvas = canvasRef.current;
      const offscreen = offscreenRef.current;
      const transform = transformRef.current;

      if (!canvas || !offscreen || !transform || !hasCellsRef.current) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const topLeftGeo: [number, number] = [transform.originY, transform.originX];
      const bottomRightGeo: [number, number] = [
        transform.originY + transform.height * transform.scaleY,
        transform.originX + transform.width * transform.scaleX,
      ];

      const topLeftScreen = map.latLngToContainerPoint(topLeftGeo);
      const bottomRightScreen = map.latLngToContainerPoint(bottomRightGeo);

      const destWidth = bottomRightScreen.x - topLeftScreen.x;
      const destHeight = bottomRightScreen.y - topLeftScreen.y;

      ctx.globalAlpha = 0.5;
      ctx.drawImage(
        offscreen,
        0, 0, offscreen.width, offscreen.height,
        topLeftScreen.x, topLeftScreen.y, destWidth, destHeight,
      );
      ctx.globalAlpha = 1;
    }, [map]);

    const scheduleBlit = useCallback(() => {
      if (needsBlitRef.current) return;
      needsBlitRef.current = true;
      blitRafIdRef.current = requestAnimationFrame(blit);
    }, [blit]);

    // Draw every cell in a bucket (flat [x, y, x, y, ...] array).
    const drainBucket = useCallback((bucket: number[]) => {
      const ctx = offscreenCtxRef.current;
      if (!ctx) return;
      for (let i = 0; i < bucket.length; i += 2) {
        ctx.fillRect(bucket[i], bucket[i + 1], 1, 1);
      }
    }, []);

    const revealStep = useCallback(() => {
      revealRafIdRef.current = null;

      const buckets = bucketsRef.current;
      if (buckets.size === 0) {
        isFlushingRef.current = false;
        return;
      }

      const now = performance.now();

      let revealThreshold: number;
      if (isFlushingRef.current) {
        const flushElapsed = now - flushStartMsRef.current;
        const progress = Math.min(flushElapsed / FLUSH_DRAIN_MS, 1);
        const from = flushFromRadiusRef.current;
        revealThreshold = from + (maxPopulatedRadiusRef.current - from) * progress;
      } else {
        const elapsed = sessionStartMsRef.current !== null ? now - sessionStartMsRef.current : 0;
        revealThreshold = (RADIAL_SPEED_CELLS_PER_SEC * elapsed) / 1000;
      }

      let drewSomething = false;
      while (nextRadiusRef.current <= revealThreshold) {
        const bucket = buckets.get(nextRadiusRef.current);
        if (bucket !== undefined) {
          drainBucket(bucket);
          buckets.delete(nextRadiusRef.current);
          hasCellsRef.current = true;
          drewSomething = true;
        }
        nextRadiusRef.current++;
        // Cap work per frame: if we've already drained far past nextRadius
        // but the bucket map has nothing in that range, the while loop is
        // O(skipped radii) per frame; cheap but let's avoid runaway numbers.
        if (nextRadiusRef.current > maxPopulatedRadiusRef.current + 1 && buckets.size === 0) {
          break;
        }
      }

      if (drewSomething) scheduleBlit();

      if (buckets.size > 0) {
        revealRafIdRef.current = requestAnimationFrame(revealStep);
      } else {
        isFlushingRef.current = false;
      }
    }, [drainBucket, scheduleBlit]);

    const scheduleReveal = useCallback(() => {
      if (revealRafIdRef.current !== null) return;
      revealRafIdRef.current = requestAnimationFrame(revealStep);
    }, [revealStep]);

    const addCellsInternal = useCallback((data: ExplorationData) => {
      if (data.cells.length === 0) return;

      // First batch: allocate full-raster offscreen, capture transform, mark start.
      if (!offscreenRef.current || !transformRef.current) {
        const offscreen = new OffscreenCanvas(data.width, data.height);
        const ctx = offscreen.getContext('2d');
        if (!ctx) return;

        const match = colorRef.current.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        ctx.fillStyle = match
          ? `rgb(${match[1]}, ${match[2]}, ${match[3]})`
          : 'rgb(59, 130, 246)';

        offscreenRef.current = offscreen;
        offscreenCtxRef.current = ctx;
        transformRef.current = {
          originX: data.originX,
          originY: data.originY,
          scaleX: data.scaleX,
          scaleY: data.scaleY,
          width: data.width,
          height: data.height,
        };

        // The first cell Rust emits is the search start (A* expands the start
        // node first, which is the first successor call into the tracker).
        startCellRef.current = { x: data.cells[0], y: data.cells[1] };
        sessionStartMsRef.current = performance.now();
      }

      const start = startCellRef.current;
      if (!start) return;

      const cells = data.cells;
      const buckets = bucketsRef.current;
      let drewImmediate = false;
      const cutoff = nextRadiusRef.current;

      for (let i = 0; i < cells.length; i += 2) {
        const x = cells[i];
        const y = cells[i + 1];
        const dx = x - start.x;
        const dy = y - start.y;
        // Integer radius (rounded to nearest cell). Math.hypot is fine here;
        // inner loop is only ~500 cells per 33 ms batch.
        const r = Math.round(Math.sqrt(dx * dx + dy * dy));

        if (r < cutoff) {
          // Ring already revealed — draw this straggler immediately.
          drawCell(x, y);
          drewImmediate = true;
        } else {
          let bucket = buckets.get(r);
          if (bucket === undefined) {
            bucket = [];
            buckets.set(r, bucket);
          }
          bucket.push(x, y);
          if (r > maxPopulatedRadiusRef.current) maxPopulatedRadiusRef.current = r;
        }
      }

      if (drewImmediate) {
        hasCellsRef.current = true;
        scheduleBlit();
      }
      if (buckets.size > 0) scheduleReveal();
    }, [drawCell, scheduleBlit, scheduleReveal]);

    useImperativeHandle(ref, () => ({
      addCells: (data: ExplorationData) => {
        addCellsInternal(data);
      },
      flush: () => {
        if (bucketsRef.current.size === 0) {
          if (hasCellsRef.current) scheduleBlit();
          return;
        }
        isFlushingRef.current = true;
        flushStartMsRef.current = performance.now();
        flushFromRadiusRef.current = nextRadiusRef.current;
        scheduleReveal();
      },
      clear: () => {
        offscreenRef.current = null;
        offscreenCtxRef.current = null;
        transformRef.current = null;
        startCellRef.current = null;
        sessionStartMsRef.current = null;
        bucketsRef.current = new Map();
        nextRadiusRef.current = 0;
        maxPopulatedRadiusRef.current = 0;
        isFlushingRef.current = false;
        hasCellsRef.current = false;

        if (blitRafIdRef.current !== null) {
          cancelAnimationFrame(blitRafIdRef.current);
          blitRafIdRef.current = null;
        }
        if (revealRafIdRef.current !== null) {
          cancelAnimationFrame(revealRafIdRef.current);
          revealRafIdRef.current = null;
        }
        needsBlitRef.current = false;

        const canvas = canvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext('2d');
          ctx?.clearRect(0, 0, canvas.width, canvas.height);
        }
      },
    }), [addCellsInternal, scheduleBlit, scheduleReveal]);

    useEffect(() => {
      const mapInstance = map;

      const CanvasLayer = L.Layer.extend({
        onAdd(leafletMap: L.Map) {
          const size = leafletMap.getSize();

          const canvas = L.DomUtil.create('canvas', 'leaflet-exploration-layer');
          canvas.width = size.x;
          canvas.height = size.y;
          canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:400';
          canvasRef.current = canvas;

          leafletMap.getPane('overlayPane')?.appendChild(canvas);
          leafletMap.on('move', this._updatePosition, this);
          leafletMap.on('moveend', this._onMoveEnd, this);
          leafletMap.on('resize', this._onResize, this);
          this._updatePosition();
        },
        onRemove(leafletMap: L.Map) {
          canvasRef.current?.remove();
          canvasRef.current = null;
          leafletMap.off('move', this._updatePosition, this);
          leafletMap.off('moveend', this._onMoveEnd, this);
          leafletMap.off('resize', this._onResize, this);
        },
        _updatePosition() {
          if (!canvasRef.current) return;
          L.DomUtil.setPosition(canvasRef.current, mapInstance.containerPointToLayerPoint([0, 0]));
        },
        _onMoveEnd() {
          if (hasCellsRef.current) scheduleBlit();
        },
        _onResize() {
          const size = mapInstance.getSize();
          if (canvasRef.current) {
            canvasRef.current.width = size.x;
            canvasRef.current.height = size.y;
          }
          if (hasCellsRef.current) scheduleBlit();
        },
      });

      const layer = new CanvasLayer();
      layer.addTo(map);
      layerRef.current = layer;

      return () => {
        if (layerRef.current) map.removeLayer(layerRef.current);
        if (blitRafIdRef.current !== null) cancelAnimationFrame(blitRafIdRef.current);
        if (revealRafIdRef.current !== null) cancelAnimationFrame(revealRafIdRef.current);
      };
    }, [map, scheduleBlit]);

    return null;
  },
);
