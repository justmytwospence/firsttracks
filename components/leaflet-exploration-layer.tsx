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

// Reserve this much headroom on each offscreen-canvas resize so the canvas
// doesn't have to reallocate on every cell arriving at the leading edge.
const BOUNDS_GROW_MARGIN = 64;

/**
 * Canvas-based exploration frontier overlay.
 *
 * Cells arrive via `addCells` (usually from the pathfinder worker at ~33 ms
 * cadence) and are drawn immediately into an OffscreenCanvas in grid space.
 * The offscreen is blitted to the visible Leaflet overlay on the next RAF,
 * applying a geo transform so cells land at their real-world locations.
 *
 * Pacing is handled upstream by the Rust tracker's wall-clock flush cadence —
 * this layer trusts whatever arrives and renders it promptly.
 */
export const LeafletExplorationLayer = forwardRef<ExplorationLayerHandle, LeafletExplorationLayerProps>(
  function LeafletExplorationLayer({ color = 'rgba(59, 130, 246, 0.4)' }, ref) {
    const map = useMap();
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const layerRef = useRef<L.Layer | null>(null);

    // Offscreen canvas for accumulating cells in grid space.
    const offscreenRef = useRef<OffscreenCanvas | null>(null);
    const offscreenCtxRef = useRef<OffscreenCanvasRenderingContext2D | null>(null);

    // Grid bounds the offscreen canvas currently covers (includes margin).
    const gridBoundsRef = useRef<{ minX: number; minY: number; maxX: number; maxY: number } | null>(null);
    const geoTransformRef = useRef<{ originX: number; originY: number; scaleX: number; scaleY: number } | null>(null);

    const hasCellsRef = useRef(false);

    // Blit RAF control.
    const blitRafIdRef = useRef<number | null>(null);
    const needsBlitRef = useRef(false);

    const colorRef = useRef(color);
    colorRef.current = color;

    const blit = useCallback(() => {
      blitRafIdRef.current = null;
      needsBlitRef.current = false;

      const canvas = canvasRef.current;
      const offscreen = offscreenRef.current;
      const transform = geoTransformRef.current;
      const gridBounds = gridBoundsRef.current;

      if (!canvas || !offscreen || !transform || !gridBounds || !hasCellsRef.current) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

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
    }, [map]);

    const scheduleBlit = useCallback(() => {
      if (needsBlitRef.current) return;
      needsBlitRef.current = true;
      blitRafIdRef.current = requestAnimationFrame(blit);
    }, [blit]);

    const drawCells = useCallback((
      cells: Uint16Array,
      transform: { originX: number; originY: number; scaleX: number; scaleY: number },
    ) => {
      if (cells.length === 0) return;

      if (!geoTransformRef.current) {
        geoTransformRef.current = { ...transform };
      }

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

    useImperativeHandle(ref, () => ({
      addCells: (data: ExplorationData) => {
        drawCells(data.cells, data);
      },
      flush: () => {
        // All cells have been drawn synchronously as they arrived;
        // just make sure a final blit is queued so the last batch is visible.
        if (hasCellsRef.current) scheduleBlit();
      },
      clear: () => {
        offscreenRef.current = null;
        offscreenCtxRef.current = null;
        gridBoundsRef.current = null;
        geoTransformRef.current = null;
        hasCellsRef.current = false;

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
    }), [drawCells, scheduleBlit]);

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
      };
    }, [map, scheduleBlit]);

    return null;
  },
);
