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

// Target visual radial expansion speed, in grid cells per second.
// The per-frame cell reveal rate is derived from this: since a ring at
// radius r has ~2πr cells, to advance the frontier by `RADIAL_SPEED` cells
// per second we need to reveal ~2πr × RADIAL_SPEED cells per second. This
// auto-scales with the current frontier radius so the visible wavefront
// keeps a steady speed, while cells are still drawn in A*'s arrival (cost)
// order so the goal-directed search pattern stays visible.
const RADIAL_SPEED_CELLS_PER_SEC = 50;

// Floor so the pacer never reveals fewer cells than this per frame (prevents
// a frozen look at r ≈ 0 and during brief buffer-empty moments).
const MIN_CELLS_PER_FRAME = 60;

// When flush() is called (pathfinding complete), drain the remaining
// cells over at most this window so the final state settles smoothly.
const MAX_FLUSH_DRAIN_MS = 800;

interface PendingBatch {
  cells: Uint16Array;
  cursor: number; // index into cells[] of the next *cell* (pair) to draw
}

/**
 * Canvas-based exploration frontier overlay.
 *
 * Incoming cells are queued and revealed at a constant rate (~8000 cells/s)
 * in arrival order — A*'s cost order — so the goal-directed search pattern
 * stays visible while the visible motion rate stays steady. A buffer
 * naturally accumulates during the fast early phase and drains through the
 * slower late phase.
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

    // Reveal queue and pacer state.
    const pendingRef = useRef<PendingBatch[]>([]);
    const pendingCellCountRef = useRef(0);
    const revealRafIdRef = useRef<number | null>(null);
    const isFlushingRef = useRef(false);
    const flushStartMsRef = useRef(0);
    const flushStartPendingRef = useRef(0);

    // Search start cell (first cell emitted by Rust) and the largest radius
    // seen so far — used to compute the current per-frame reveal budget.
    const startCellRef = useRef<{ x: number; y: number } | null>(null);
    const maxRadiusRef = useRef(0);

    const hasCellsRef = useRef(false);

    // Blit RAF control
    const blitRafIdRef = useRef<number | null>(null);
    const needsBlitRef = useRef(false);

    const colorRef = useRef(color);
    colorRef.current = color;

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

    // Draw `count` cells starting from the head of the pending queue.
    // Returns the number of cells actually drawn.
    const drawFromQueue = useCallback((count: number): number => {
      const ctx = offscreenCtxRef.current;
      if (!ctx) return 0;

      const pending = pendingRef.current;
      let drawn = 0;
      while (drawn < count && pending.length > 0) {
        const head = pending[0];
        const available = (head.cells.length >>> 1) - head.cursor;
        const want = count - drawn;
        const take = Math.min(available, want);

        const end = head.cursor + take;
        for (let i = head.cursor; i < end; i++) {
          const x = head.cells[i * 2];
          const y = head.cells[i * 2 + 1];
          ctx.fillRect(x, y, 1, 1);
        }
        head.cursor = end;
        drawn += take;

        if (head.cursor >= head.cells.length >>> 1) {
          pending.shift();
        }
      }
      pendingCellCountRef.current -= drawn;
      if (drawn > 0) hasCellsRef.current = true;
      return drawn;
    }, []);

    const revealStep = useCallback(() => {
      revealRafIdRef.current = null;

      const pending = pendingRef.current;
      if (pending.length === 0) {
        isFlushingRef.current = false;
        return;
      }

      let cellsThisFrame: number;
      if (isFlushingRef.current) {
        const now = performance.now();
        const flushElapsed = now - flushStartMsRef.current;
        const remainingMs = Math.max(MAX_FLUSH_DRAIN_MS - flushElapsed, 16.7);
        const framesLeft = remainingMs / 16.7;
        const totalStart = flushStartPendingRef.current;
        // Drain the flush-start backlog evenly across the remaining frames,
        // floored at the base rate so we never go slower than normal.
        cellsThisFrame = Math.max(
          MIN_CELLS_PER_FRAME,
          Math.ceil(totalStart / Math.max(framesLeft, 1)),
        );
      } else {
        // Scale with frontier radius: ring at r has ~2πr cells, so advancing
        // the visible edge by RADIAL_SPEED cells/s needs ~2πr × RADIAL_SPEED
        // cells/s of reveal — i.e., proportional to current max radius.
        const r = maxRadiusRef.current;
        const perSec = 2 * Math.PI * r * RADIAL_SPEED_CELLS_PER_SEC;
        cellsThisFrame = Math.max(MIN_CELLS_PER_FRAME, Math.ceil(perSec / 60));
      }

      const drew = drawFromQueue(cellsThisFrame);
      if (drew > 0) scheduleBlit();

      if (pendingRef.current.length > 0) {
        revealRafIdRef.current = requestAnimationFrame(revealStep);
      } else {
        isFlushingRef.current = false;
      }
    }, [drawFromQueue, scheduleBlit]);

    const scheduleReveal = useCallback(() => {
      if (revealRafIdRef.current !== null) return;
      revealRafIdRef.current = requestAnimationFrame(revealStep);
    }, [revealStep]);

    const enqueueBatch = useCallback((data: ExplorationData) => {
      if (data.cells.length === 0) return;

      // First batch: allocate full-raster offscreen and capture transform/color.
      // The first cell Rust emits is the search start (A* expands the start
      // node first), so anchor the radius computation there.
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
        startCellRef.current = { x: data.cells[0], y: data.cells[1] };
      }

      // Update max radius across the new batch.
      const start = startCellRef.current;
      if (start) {
        const cells = data.cells;
        let maxSqThisBatch = 0;
        for (let i = 0; i < cells.length; i += 2) {
          const dx = cells[i] - start.x;
          const dy = cells[i + 1] - start.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > maxSqThisBatch) maxSqThisBatch = d2;
        }
        const maxThisBatch = Math.sqrt(maxSqThisBatch);
        if (maxThisBatch > maxRadiusRef.current) maxRadiusRef.current = maxThisBatch;
      }

      pendingRef.current.push({ cells: data.cells, cursor: 0 });
      pendingCellCountRef.current += data.cells.length >>> 1;
      scheduleReveal();
    }, [scheduleReveal]);

    useImperativeHandle(ref, () => ({
      addCells: (data: ExplorationData) => {
        enqueueBatch(data);
      },
      flush: () => {
        if (pendingRef.current.length === 0) {
          if (hasCellsRef.current) scheduleBlit();
          return;
        }
        isFlushingRef.current = true;
        flushStartMsRef.current = performance.now();
        flushStartPendingRef.current = pendingCellCountRef.current;
        scheduleReveal();
      },
      clear: () => {
        offscreenRef.current = null;
        offscreenCtxRef.current = null;
        transformRef.current = null;
        startCellRef.current = null;
        maxRadiusRef.current = 0;
        pendingRef.current = [];
        pendingCellCountRef.current = 0;
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
    }), [enqueueBatch, scheduleBlit, scheduleReveal]);

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
