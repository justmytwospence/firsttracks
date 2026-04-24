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
}

export interface ExplorationLayerHandle {
  addCells: (data: ExplorationData) => void;
  flush: () => void;
  clear: () => void;
}

interface LeafletExplorationLayerProps {
  color?: string;
}

// Target visual duration for a full exploration animation. Soft goal: if the
// underlying search finishes faster, animation finishes faster too; if it's
// slower, we stretch until we've caught up then track arrival rate.
const TARGET_DURATION_MS = 10_000;

// Minimum cells rendered per frame while the pacer is active. Floor below which
// the animation would feel frozen to the eye.
const MIN_CELLS_PER_FRAME = 32;

// When `flush()` is called (pathfinding completed), drain any queued cells over
// this window so the user sees the final state settle before `clear()` fires.
const FLUSH_DRAIN_MS = 200;

// Cells outside the current offscreen canvas trigger a resize. Reserve this
// much headroom each resize so the canvas doesn't have to reallocate on every
// cell at the leading edge.
const BOUNDS_GROW_MARGIN = 64;

interface PendingBatch {
  cells: Uint16Array;
  originX: number;
  originY: number;
  scaleX: number;
  scaleY: number;
}

/**
 * Canvas-based frontier visualization with paced reveal.
 *
 * Incoming cell batches are buffered and drained on a RAF loop that targets a
 * perceptually-constant ~10 s reveal regardless of how fast or slow the
 * underlying A* search is running. Cells are drawn onto an OffscreenCanvas in
 * grid space, then blitted to the visible Leaflet overlay with a geo transform.
 */
export const LeafletExplorationLayer = forwardRef<ExplorationLayerHandle, LeafletExplorationLayerProps>(
  function LeafletExplorationLayer({ color = 'rgba(59, 130, 246, 0.4)' }, ref) {
    const map = useMap();
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const layerRef = useRef<L.Layer | null>(null);

    // Offscreen canvas for accumulating cells (in grid space)
    const offscreenRef = useRef<OffscreenCanvas | null>(null);
    const offscreenCtxRef = useRef<OffscreenCanvasRenderingContext2D | null>(null);

    // Grid bounds the offscreen canvas currently covers
    const gridBoundsRef = useRef<{ minX: number; minY: number; maxX: number; maxY: number } | null>(null);
    const geoTransformRef = useRef<{ originX: number; originY: number; scaleX: number; scaleY: number } | null>(null);

    const hasCellsRef = useRef(false);

    // Blit RAF control (runs whenever the offscreen or the map changes)
    const blitRafIdRef = useRef<number | null>(null);
    const needsBlitRef = useRef(false);

    // Reveal pacer state
    const pendingRef = useRef<PendingBatch[]>([]);
    const firstArrivalTimeRef = useRef<number | null>(null);
    const revealRafIdRef = useRef<number | null>(null);
    const isFlushingRef = useRef(false);
    const flushStartTimeRef = useRef(0);

    const colorRef = useRef(color);
    colorRef.current = color;

    // Blit offscreen canvas to visible canvas with geo transform
    const blit = useCallback(() => {
      const canvas = canvasRef.current;
      const offscreen = offscreenRef.current;
      const transform = geoTransformRef.current;
      const gridBounds = gridBoundsRef.current;

      blitRafIdRef.current = null;

      if (!canvas || !offscreen || !transform || !gridBounds || !hasCellsRef.current) {
        needsBlitRef.current = false;
        return;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        needsBlitRef.current = false;
        return;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const topLeftGeo: [number, number] = [
        transform.originY + gridBounds.minY * transform.scaleY,
        transform.originX + gridBounds.minX * transform.scaleX,
      ];
      const bottomRightGeo: [number, number] = [
        transform.originY + (gridBounds.maxY + 1) * transform.scaleY,
        transform.originX + (gridBounds.maxX + 1) * transform.scaleX,
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

      needsBlitRef.current = false;
    }, [map]);

    const scheduleBlit = useCallback(() => {
      if (!needsBlitRef.current) {
        needsBlitRef.current = true;
        blitRafIdRef.current = requestAnimationFrame(blit);
      }
    }, [blit]);

    // Draw a set of cells to the offscreen canvas, expanding bounds as needed.
    const drawCells = useCallback((
      cells: Uint16Array,
      transform: { originX: number; originY: number; scaleX: number; scaleY: number },
    ) => {
      if (cells.length === 0) return;

      // Capture geo transform on first cell ever drawn this session.
      if (!geoTransformRef.current) {
        geoTransformRef.current = { ...transform };
      }

      // Bounds of the incoming cells.
      let cellMinX = Number.POSITIVE_INFINITY;
      let cellMinY = Number.POSITIVE_INFINITY;
      let cellMaxX = Number.NEGATIVE_INFINITY;
      let cellMaxY = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < cells.length; i += 2) {
        const x = cells[i];
        const y = cells[i + 1];
        if (x < cellMinX) cellMinX = x;
        if (y < cellMinY) cellMinY = y;
        if (x > cellMaxX) cellMaxX = x;
        if (y > cellMaxY) cellMaxY = y;
      }

      const prevBounds = gridBoundsRef.current;
      const needsExpand = !prevBounds ||
        cellMinX < prevBounds.minX || cellMinY < prevBounds.minY ||
        cellMaxX > prevBounds.maxX || cellMaxY > prevBounds.maxY;

      if (needsExpand) {
        // Grow with a margin so we don't reallocate on every cell at the frontier.
        const newMinX = prevBounds
          ? Math.min(prevBounds.minX, cellMinX - BOUNDS_GROW_MARGIN)
          : cellMinX - BOUNDS_GROW_MARGIN;
        const newMinY = prevBounds
          ? Math.min(prevBounds.minY, cellMinY - BOUNDS_GROW_MARGIN)
          : cellMinY - BOUNDS_GROW_MARGIN;
        const newMaxX = prevBounds
          ? Math.max(prevBounds.maxX, cellMaxX + BOUNDS_GROW_MARGIN)
          : cellMaxX + BOUNDS_GROW_MARGIN;
        const newMaxY = prevBounds
          ? Math.max(prevBounds.maxY, cellMaxY + BOUNDS_GROW_MARGIN)
          : cellMaxY + BOUNDS_GROW_MARGIN;

        const newWidth = newMaxX - newMinX + 1;
        const newHeight = newMaxY - newMinY + 1;

        const newOffscreen = new OffscreenCanvas(newWidth, newHeight);
        const newCtx = newOffscreen.getContext('2d');
        if (!newCtx) return;

        if (offscreenRef.current && prevBounds) {
          const offsetX = prevBounds.minX - newMinX;
          const offsetY = prevBounds.minY - newMinY;
          newCtx.drawImage(offscreenRef.current, offsetX, offsetY);
        }

        offscreenRef.current = newOffscreen;
        offscreenCtxRef.current = newCtx;
        gridBoundsRef.current = { minX: newMinX, minY: newMinY, maxX: newMaxX, maxY: newMaxY };
      }

      const offCtx = offscreenCtxRef.current;
      const bounds = gridBoundsRef.current;
      if (!offCtx || !bounds) return;

      const match = colorRef.current.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      offCtx.fillStyle = match
        ? `rgb(${match[1]}, ${match[2]}, ${match[3]})`
        : 'rgb(59, 130, 246)';

      for (let i = 0; i < cells.length; i += 2) {
        const x = cells[i] - bounds.minX;
        const y = cells[i + 1] - bounds.minY;
        offCtx.fillRect(x, y, 1, 1);
      }

      hasCellsRef.current = true;
      scheduleBlit();
    }, [scheduleBlit]);

    // RAF-driven pacer: pulls cells from the pending queue and draws them at a
    // rate that targets TARGET_DURATION_MS (or FLUSH_DRAIN_MS when flushing).
    const revealStep = useCallback(() => {
      revealRafIdRef.current = null;

      const pending = pendingRef.current;
      if (pending.length === 0) {
        isFlushingRef.current = false;
        return;
      }

      const now = performance.now();

      let totalPending = 0;
      for (const b of pending) totalPending += b.cells.length >>> 1;

      let remainingMs: number;
      if (isFlushingRef.current) {
        remainingMs = FLUSH_DRAIN_MS - (now - flushStartTimeRef.current);
      } else {
        const elapsed = firstArrivalTimeRef.current !== null ? now - firstArrivalTimeRef.current : 0;
        remainingMs = TARGET_DURATION_MS - elapsed;
      }

      let cellsToReveal: number;
      if (remainingMs <= 16.7) {
        // Budget exhausted — drain everything this frame so we don't fall further behind.
        cellsToReveal = totalPending;
      } else {
        const framesLeft = remainingMs / 16.7;
        cellsToReveal = Math.max(Math.ceil(totalPending / framesLeft), MIN_CELLS_PER_FRAME);
      }

      let revealed = 0;
      while (revealed < cellsToReveal && pending.length > 0) {
        const head = pending[0];
        const available = head.cells.length >>> 1;
        const wanted = cellsToReveal - revealed;

        if (wanted >= available) {
          drawCells(head.cells, head);
          revealed += available;
          pending.shift();
        } else {
          const slice = head.cells.subarray(0, wanted * 2);
          drawCells(slice, head);
          head.cells = head.cells.subarray(wanted * 2);
          revealed += wanted;
        }
      }

      if (pending.length > 0) {
        revealRafIdRef.current = requestAnimationFrame(revealStep);
      } else {
        isFlushingRef.current = false;
      }
    }, [drawCells]);

    useImperativeHandle(ref, () => ({
      addCells: (data: ExplorationData) => {
        pendingRef.current.push({
          cells: data.cells,
          originX: data.originX,
          originY: data.originY,
          scaleX: data.scaleX,
          scaleY: data.scaleY,
        });
        if (firstArrivalTimeRef.current === null) {
          firstArrivalTimeRef.current = performance.now();
        }
        if (revealRafIdRef.current === null) {
          revealRafIdRef.current = requestAnimationFrame(revealStep);
        }
      },
      flush: () => {
        if (pendingRef.current.length === 0) return;
        isFlushingRef.current = true;
        flushStartTimeRef.current = performance.now();
        if (revealRafIdRef.current === null) {
          revealRafIdRef.current = requestAnimationFrame(revealStep);
        }
      },
      clear: () => {
        pendingRef.current = [];
        firstArrivalTimeRef.current = null;
        isFlushingRef.current = false;

        offscreenRef.current = null;
        offscreenCtxRef.current = null;
        gridBoundsRef.current = null;
        geoTransformRef.current = null;
        hasCellsRef.current = false;

        if (revealRafIdRef.current !== null) {
          cancelAnimationFrame(revealRafIdRef.current);
          revealRafIdRef.current = null;
        }
        if (blitRafIdRef.current !== null) {
          cancelAnimationFrame(blitRafIdRef.current);
          blitRafIdRef.current = null;
        }
        needsBlitRef.current = false;

        const canvas = canvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext('2d');
          ctx?.clearRect(0, 0, canvas.width, canvas.height);
        }
      },
    }), [revealStep]);

    // Create canvas layer
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
          if (hasCellsRef.current) {
            scheduleBlit();
          }
        },
        _onResize() {
          const size = mapInstance.getSize();
          if (canvasRef.current) {
            canvasRef.current.width = size.x;
            canvasRef.current.height = size.y;
          }
          if (hasCellsRef.current) {
            scheduleBlit();
          }
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
