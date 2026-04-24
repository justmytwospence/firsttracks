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

/**
 * Canvas-based exploration frontier overlay.
 *
 * On the first batch, allocates an OffscreenCanvas sized to the full DEM
 * raster dimensions — after that, drawing any cell is O(1) and we never
 * reallocate the canvas. The offscreen is blitted to the visible Leaflet
 * overlay on the next RAF, applying a geo transform so cells land at their
 * real-world locations.
 *
 * Pacing is handled upstream by the Rust tracker's ~33 ms wall-clock flush
 * cadence — this layer trusts whatever arrives and renders it promptly.
 */
export const LeafletExplorationLayer = forwardRef<ExplorationLayerHandle, LeafletExplorationLayerProps>(
  function LeafletExplorationLayer({ color = 'rgba(59, 130, 246, 0.4)' }, ref) {
    const map = useMap();
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const layerRef = useRef<L.Layer | null>(null);

    // Offscreen canvas sized to the full DEM raster (allocated on first batch).
    const offscreenRef = useRef<OffscreenCanvas | null>(null);
    const offscreenCtxRef = useRef<OffscreenCanvasRenderingContext2D | null>(null);

    // Raster transform (origin/scale) and dimensions — captured on first batch.
    const transformRef = useRef<{
      originX: number;
      originY: number;
      scaleX: number;
      scaleY: number;
      width: number;
      height: number;
    } | null>(null);

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
      const transform = transformRef.current;

      if (!canvas || !offscreen || !transform || !hasCellsRef.current) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Full raster corners in geo coords.
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

    const drawCells = useCallback((data: ExplorationData) => {
      if (data.cells.length === 0) return;

      // On first batch, allocate the offscreen canvas to the full raster size.
      // Subsequent batches reuse it — no resize, no reallocation.
      if (!offscreenRef.current || !transformRef.current) {
        const offscreen = new OffscreenCanvas(data.width, data.height);
        const ctx = offscreen.getContext('2d');
        if (!ctx) return;
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
      }

      const offCtx = offscreenCtxRef.current;
      if (!offCtx) return;

      const match = colorRef.current.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      offCtx.fillStyle = match
        ? `rgb(${match[1]}, ${match[2]}, ${match[3]})`
        : 'rgb(59, 130, 246)';

      const cells = data.cells;
      for (let i = 0; i < cells.length; i += 2) {
        offCtx.fillRect(cells[i], cells[i + 1], 1, 1);
      }

      hasCellsRef.current = true;
      scheduleBlit();
    }, [scheduleBlit]);

    useImperativeHandle(ref, () => ({
      addCells: (data: ExplorationData) => {
        drawCells(data);
      },
      flush: () => {
        if (hasCellsRef.current) scheduleBlit();
      },
      clear: () => {
        offscreenRef.current = null;
        offscreenCtxRef.current = null;
        transformRef.current = null;
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
