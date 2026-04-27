/**
 * Pathfinder Web Worker
 *
 * Runs the WASM pathfinding algorithm off the main thread to keep the UI responsive.
 * Sends exploration updates back to main thread for visualization.
 *
 * The worker speaks Float32Array end-to-end with the WASM module — no GeoTIFF
 * encoding/decoding round-trip. Geo-transform (NW corner + pixel scale) is
 * passed alongside the rasters.
 */

import wasmInit, { find_path_rs, compute_azimuths_from_array, compute_runout_for_aspects, init as initPanicHook } from '../pathfinder/pkg/pathfinder';

// Worker-scope `self`. The project's tsconfig includes `dom` (not `webworker`),
// so `self` would otherwise type as `Window`, which has the wrong postMessage shape.
declare const self: {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

interface BoundsLike {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface PathfinderRequest {
  type: 'find_path';
  id: string;
  elevations: Float32Array;
  azimuths: Float32Array;
  gradients: Float32Array;
  runoutZones?: Float32Array;
  width: number;
  height: number;
  bounds: BoundsLike;
  start: [number, number];
  end: [number, number];
  maxGradient: number | null;
  excludedAspects: string[];
  aspectGradientThreshold: number | null;
}

/**
 * Compute azimuths from raw elevation arrays (AWS Terrain Tiles).
 */
export interface ComputeAzimuthsFromArrayRequest {
  type: 'compute_azimuths_from_array';
  id: string;
  elevations: Float32Array;
  width: number;
  height: number;
  bounds: BoundsLike;
  excludedAspects: string[];
}

/**
 * Compute runout zones lazily when aspect selection changes.
 */
export interface ComputeRunoutRequest {
  type: 'compute_runout';
  id: string;
  elevations: Float32Array;
  azimuths: Float32Array;
  gradients: Float32Array;
  width: number;
  height: number;
  bounds: BoundsLike;
  excludedAspects: string[];
}

export interface ComputeRunoutResult {
  type: 'compute_runout_result';
  id: string;
  runout_zones: Float32Array;
}

/**
 * Raw exploration data from Rust WASM.
 */
export interface RawExplorationData {
  cells: Uint16Array;
  originX: number;
  originY: number;
  scaleX: number;
  scaleY: number;
  width: number;
  height: number;
}

export interface ExplorationUpdate {
  type: 'exploration';
  id: string;
  cells: Uint16Array;
  originX: number;
  originY: number;
  scaleX: number;
  scaleY: number;
  width: number;
  height: number;
}

export interface PathResult {
  type: 'path_result';
  id: string;
  geojson: string;
}

export interface AzimuthsResult {
  type: 'azimuths_result';
  id: string;
  elevations_raw: Float32Array;
  azimuths_raw: Float32Array;
  gradients_raw: Float32Array;
  width: number;
  height: number;
  bounds: BoundsLike;
}

export interface ErrorResult {
  type: 'error';
  id: string;
  message: string;
}

export type WorkerRequest = PathfinderRequest | ComputeAzimuthsFromArrayRequest | ComputeRunoutRequest;
export type WorkerResponse = ExplorationUpdate | PathResult | AzimuthsResult | ComputeRunoutResult | ErrorResult;

let wasmInitialized = false;

async function ensureWasmInit(): Promise<void> {
  if (wasmInitialized) return;

  try {
    const wasmUrl = new URL('../pathfinder/pkg/pathfinder_bg.wasm', import.meta.url);
    const response = await fetch(wasmUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch WASM: ${response.status} ${response.statusText}`);
    }

    const bytes = await response.arrayBuffer();
    await wasmInit(bytes);
    initPanicHook();

    wasmInitialized = true;
  } catch (error) {
    console.error('[Worker] Failed to initialize WASM:', error);
    throw error;
  }
}

function pixelScaleFromBounds(bounds: BoundsLike, width: number, height: number) {
  const pixelScaleX = (bounds.east - bounds.west) / width;
  // pixelScaleY is negative — latitude decreases as raster y increases.
  const pixelScaleY = (bounds.south - bounds.north) / height;
  return { pixelScaleX, pixelScaleY };
}

async function handleFindPath(request: PathfinderRequest): Promise<void> {
  const { id, elevations, azimuths, gradients, runoutZones, width, height, bounds, start, end, maxGradient, excludedAspects, aspectGradientThreshold } = request;

  try {
    await ensureWasmInit();

    if (elevations.buffer.byteLength === 0) throw new Error('elevations buffer is detached');
    if (azimuths.buffer.byteLength === 0) throw new Error('azimuths buffer is detached');
    if (gradients.buffer.byteLength === 0) throw new Error('gradients buffer is detached');
    if (runoutZones && runoutZones.buffer.byteLength === 0) throw new Error('runoutZones buffer is detached');

    const startGeoJson = JSON.stringify({ type: 'Point', coordinates: start });
    const endGeoJson = JSON.stringify({ type: 'Point', coordinates: end });

    // Two-phase callback: Rust sends "init" once with origin/scale/dims,
    // then "cells" messages per batch. Cache the constants and forward in
    // the original ExplorationUpdate shape so the leaflet overlay is unchanged.
    let cached: Omit<RawExplorationData, 'cells'> | null = null;
    const explorationCallback = (data: { type?: string; cells?: Uint16Array } & Partial<RawExplorationData>) => {
      if (data.type === 'init') {
        cached = {
          originX: data.originX as number,
          originY: data.originY as number,
          scaleX: data.scaleX as number,
          scaleY: data.scaleY as number,
          width: data.width as number,
          height: data.height as number,
        };
        return;
      }
      if (!cached || !data.cells) return;
      self.postMessage({
        type: 'exploration',
        id,
        cells: data.cells,
        originX: cached.originX,
        originY: cached.originY,
        scaleX: cached.scaleX,
        scaleY: cached.scaleY,
        width: cached.width,
        height: cached.height,
      } satisfies ExplorationUpdate);
    };

    const { pixelScaleX, pixelScaleY } = pixelScaleFromBounds(bounds, width, height);
    // Origin is the NW corner.
    const originX = bounds.west;
    const originY = bounds.north;

    const resultJson = find_path_rs(
      elevations,
      azimuths,
      gradients,
      runoutZones ?? new Float32Array(0),
      width,
      height,
      originX,
      originY,
      pixelScaleX,
      pixelScaleY,
      startGeoJson,
      endGeoJson,
      maxGradient,
      excludedAspects,
      aspectGradientThreshold,
      explorationCallback,
      500
    );

    self.postMessage({
      type: 'path_result',
      id,
      geojson: resultJson,
    } satisfies PathResult);
  } catch (error) {
    console.error('[Worker] Pathfinding error:', error);
    let message: string;
    if (error instanceof Error) {
      message = error.message;
    } else if (typeof error === 'string') {
      message = error;
    } else if (error && typeof error === 'object' && 'message' in error) {
      message = String((error as { message: unknown }).message);
    } else {
      try {
        message = String(error);
      } catch {
        message = 'Unknown error during pathfinding';
      }
    }
    self.postMessage({ type: 'error', id, message } satisfies ErrorResult);
  }
}

async function handleComputeAzimuthsFromArray(request: ComputeAzimuthsFromArrayRequest): Promise<void> {
  const { id, elevations, width, height, bounds } = request;

  try {
    if (elevations.buffer.byteLength === 0) {
      throw new Error('elevations buffer is detached');
    }

    await ensureWasmInit();

    // Convert geographic bounds (degrees) to meters per pixel at the raster
    // centre so Sobel normalization is correct away from the equator.
    // 111320 m/deg longitude at the equator (scaled by cos(lat)); 110540 m/deg latitude.
    const centreLat = (bounds.north + bounds.south) / 2;
    const cosLat = Math.cos((centreLat * Math.PI) / 180);
    const pxXMeters = ((bounds.east - bounds.west) / width) * cosLat * 111320;
    const pxYMeters = ((bounds.north - bounds.south) / height) * 110540;

    // Runout is computed lazily on aspect change. Pass an empty array here.
    const arrayResult = compute_azimuths_from_array(elevations, width, height, [], pxXMeters, pxYMeters);

    const resultElevations = arrayResult.get_elevations();
    const resultAzimuths = arrayResult.get_azimuths();
    const resultGradients = arrayResult.get_gradients();
    const resultWidth = arrayResult.width;
    const resultHeight = arrayResult.height;

    self.postMessage(
      {
        type: 'azimuths_result',
        id,
        elevations_raw: resultElevations,
        azimuths_raw: resultAzimuths,
        gradients_raw: resultGradients,
        width: resultWidth,
        height: resultHeight,
        bounds,
      } satisfies AzimuthsResult,
      [resultElevations.buffer as ArrayBuffer, resultAzimuths.buffer as ArrayBuffer, resultGradients.buffer as ArrayBuffer]
    );
  } catch (error) {
    console.error('[Worker] Array azimuth computation error:', error);
    self.postMessage({
      type: 'error',
      id,
      message: error instanceof Error ? error.message : 'Unknown error computing azimuths from array',
    } satisfies ErrorResult);
  }
}

async function handleComputeRunout(request: ComputeRunoutRequest): Promise<void> {
  const { id, elevations, azimuths, gradients, width, height, excludedAspects } = request;

  try {
    await ensureWasmInit();

    const runoutArray = compute_runout_for_aspects(
      elevations,
      azimuths,
      gradients,
      width,
      height,
      excludedAspects
    );

    self.postMessage(
      {
        type: 'compute_runout_result',
        id,
        runout_zones: runoutArray,
      } satisfies ComputeRunoutResult,
      [runoutArray.buffer as ArrayBuffer]
    );
  } catch (error) {
    console.error('[Worker] Compute runout error:', error);
    self.postMessage({
      type: 'error',
      id,
      message: error instanceof Error ? error.message : 'Unknown error computing runout',
    } satisfies ErrorResult);
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  switch (request.type) {
    case 'find_path':
      await handleFindPath(request);
      break;
    case 'compute_azimuths_from_array':
      await handleComputeAzimuthsFromArray(request);
      break;
    case 'compute_runout':
      await handleComputeRunout(request);
      break;
  }
};
