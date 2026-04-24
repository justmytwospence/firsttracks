/**
 * Pathfinder Web Worker
 * 
 * Runs the WASM pathfinding algorithm off the main thread to keep the UI responsive.
 * Sends exploration updates back to main thread for visualization.
 */

import wasmInit, { find_path_rs, compute_azimuths, compute_azimuths_from_array, compute_runout_for_aspects, array_to_geotiff, init as initPanicHook } from '../pathfinder/pkg/pathfinder';

// Types for messages
export interface PathfinderRequest {
  type: 'find_path';
  id: string;
  elevationsBuffer: Uint8Array;
  start: [number, number];
  end: [number, number];
  maxGradient: number | null;
  azimuthsBuffer: Uint8Array;
  excludedAspects: string[];
  gradientsBuffer: Uint8Array;
  aspectGradientThreshold: number | null;
  runoutZonesBuffer?: Uint8Array;
}

export interface ComputeAzimuthsRequest {
  type: 'compute_azimuths';
  id: string;
  elevationsGeotiff: Uint8Array;
  excludedAspects: string[];
}

/**
 * New message type for computing azimuths from raw elevation arrays (AWS Terrain Tiles).
 * This bypasses GeoTIFF parsing for better performance.
 */
export interface ComputeAzimuthsFromArrayRequest {
  type: 'compute_azimuths_from_array';
  id: string;
  elevations: Float32Array;
  width: number;
  height: number;
  bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
  excludedAspects: string[];
}

/**
 * Message type for computing runout zones lazily when aspect selection changes.
 * Uses raw elevation/azimuth/gradient data instead of pre-computed channels.
 */
export interface ComputeRunoutRequest {
  type: 'compute_runout';
  id: string;
  elevations: Float32Array;
  azimuths: Float32Array;
  gradients: Float32Array;
  width: number;
  height: number;
  bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
  excludedAspects: string[];
}

/**
 * Result of computing runout zones
 */
export interface ComputeRunoutResult {
  type: 'compute_runout_result';
  id: string;
  runout_zones: Uint8Array;
}

/**
 * Raw exploration data from Rust WASM.
 * Contains grid cells and geo transform for rendering directly.
 */
export interface RawExplorationData {
  cells: Uint16Array;      // Flat array of [x, y, x, y, ...] grid coords
  originX: number;         // Geo origin longitude
  originY: number;         // Geo origin latitude
  scaleX: number;          // Pixel scale X (degrees/pixel)
  scaleY: number;          // Pixel scale Y (degrees/pixel, negative)
}

/**
 * Exploration update sent to main thread with raw cell data.
 * Canvas will render cells directly for smooth visualization.
 */
export interface ExplorationUpdate {
  type: 'exploration';
  id: string;
  cells: Uint16Array;      // Raw grid cells from Rust
  originX: number;
  originY: number;
  scaleX: number;
  scaleY: number;
}

export interface PathResult {
  type: 'path_result';
  id: string;
  geojson: string;
}

export interface AzimuthsResult {
  type: 'azimuths_result';
  id: string;
  elevations: Uint8Array;
  azimuths: Uint8Array;
  gradients: Uint8Array;
  /** 
   * Runout zones GeoTIFF - initially empty, computed lazily on aspect change.
   */
  runout_zones?: Uint8Array;
  /**
   * Raw elevation data as Float32Array for lazy runout computation.
   */
  elevations_raw?: Float32Array;
  /**
   * Raw azimuth data as Float32Array for lazy runout computation.
   */
  azimuths_raw?: Float32Array;
  /**
   * Raw gradient data as Float32Array for lazy runout computation.
   */
  gradients_raw?: Float32Array;
  /** Width of the raster grid */
  width?: number;
  /** Height of the raster grid */
  height?: number;
  /** Bounds for GeoTIFF generation */
  bounds?: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
}

export interface ErrorResult {
  type: 'error';
  id: string;
  message: string;
}

export type WorkerRequest = PathfinderRequest | ComputeAzimuthsRequest | ComputeAzimuthsFromArrayRequest | ComputeRunoutRequest;
export type WorkerResponse = ExplorationUpdate | PathResult | AzimuthsResult | ComputeRunoutResult | ErrorResult;

let wasmInitialized = false;

/**
 * Initialize WASM module in worker
 */
async function ensureWasmInit(): Promise<void> {
  if (wasmInitialized) return;
  
  try {
    // Fetch the WASM bytes and initialize
    const wasmUrl = new URL('../pathfinder/pkg/pathfinder_bg.wasm', import.meta.url);
    console.log('[Worker] Fetching WASM from:', wasmUrl.href);
    
    const response = await fetch(wasmUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch WASM: ${response.status} ${response.statusText}`);
    }
    
    const bytes = await response.arrayBuffer();
    console.log('[Worker] WASM bytes loaded:', bytes.byteLength);
    
    await wasmInit(bytes);
    console.log('[Worker] WASM module initialized');
    
    initPanicHook();
    console.log('[Worker] Panic hook initialized');
    
    wasmInitialized = true;
  } catch (error) {
    console.error('[Worker] Failed to initialize WASM:', error);
    throw error;
  }
}

/**
 * Handle pathfinding request with callback-based exploration updates
 */
async function handleFindPath(request: PathfinderRequest): Promise<void> {
  const { 
    id, 
    elevationsBuffer, 
    start, 
    end, 
    maxGradient, 
    azimuthsBuffer, 
    excludedAspects, 
    gradientsBuffer,
    aspectGradientThreshold,
    runoutZonesBuffer
  } = request;
  
  try {
    await ensureWasmInit();
    
    const startGeoJson = JSON.stringify({
      type: "Point",
      coordinates: start
    });
    const endGeoJson = JSON.stringify({
      type: "Point", 
      coordinates: end
    });
    
    // Validate buffers aren't detached
    if (elevationsBuffer.buffer.byteLength === 0) {
      throw new Error('elevationsBuffer is detached');
    }
    if (azimuthsBuffer.buffer.byteLength === 0) {
      throw new Error('azimuthsBuffer is detached');
    }
    if (gradientsBuffer.buffer.byteLength === 0) {
      throw new Error('gradientsBuffer is detached');
    }
    if (runoutZonesBuffer && runoutZonesBuffer.buffer.byteLength === 0) {
      throw new Error('runoutZonesBuffer is detached');
    }
    
    // Callback just forwards raw data to main thread - no computation here
    const explorationCallback = (data: RawExplorationData) => {
      self.postMessage({
        type: 'exploration',
        id,
        cells: data.cells,
        originX: data.originX,
        originY: data.originY,
        scaleX: data.scaleX,
        scaleY: data.scaleY,
      } satisfies ExplorationUpdate);
    };
    
    const resultJson = find_path_rs(
      elevationsBuffer,
      startGeoJson,
      endGeoJson,
      maxGradient,
      azimuthsBuffer,
      excludedAspects,
      gradientsBuffer,
      aspectGradientThreshold,
      explorationCallback,
      500, // batch size
      runoutZonesBuffer ?? null
    );
    
    self.postMessage({
      type: 'path_result',
      id,
      geojson: resultJson
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
    self.postMessage({
      type: 'error',
      id,
      message
    } satisfies ErrorResult);
  }
}

/**
 * Handle azimuth computation request
 */
async function handleComputeAzimuths(request: ComputeAzimuthsRequest): Promise<void> {
  const { id, elevationsGeotiff, excludedAspects } = request;
  
  try {
    console.log('[Worker] Starting azimuth computation, buffer length:', elevationsGeotiff.length);
    console.log('[Worker] elevationsGeotiff byteLength:', elevationsGeotiff.byteLength);
    console.log('[Worker] elevationsGeotiff detached:', elevationsGeotiff.buffer.byteLength === 0);
    
    // Validate buffer isn't detached
    if (elevationsGeotiff.buffer.byteLength === 0) {
      throw new Error('elevationsGeotiff buffer is detached');
    }
    
    // Validate buffer has reasonable size (at least some bytes for a GeoTIFF header)
    if (elevationsGeotiff.length < 100) {
      throw new Error(`elevationsGeotiff buffer too small: ${elevationsGeotiff.length} bytes`);
    }
    
    await ensureWasmInit();
    console.log('[Worker] WASM initialized for azimuths');
    
    const result = compute_azimuths(elevationsGeotiff, excludedAspects ?? []);
    console.log('[Worker] Azimuths computed:', {
      elevationsLength: result.elevations.length,
      azimuthsLength: result.azimuths.length,
      gradientsLength: result.gradients.length,
      runoutZonesLength: result.runout_zones?.length
    });
    
    self.postMessage({
      type: 'azimuths_result',
      id,
      elevations: result.elevations,
      azimuths: result.azimuths,
      gradients: result.gradients,
      runout_zones: result.runout_zones
    } satisfies AzimuthsResult);
    
  } catch (error) {
    console.error('[Worker] Azimuth computation error:', error);
    self.postMessage({
      type: 'error',
      id,
      message: error instanceof Error ? error.message : 'Unknown error computing azimuths'
    } satisfies ErrorResult);
  }
}

/**
 * Handle azimuth computation request from raw elevation array (AWS Terrain Tiles).
 * This is more efficient than GeoTIFF parsing for tile-based elevation data.
 * Runout zones are NOT computed here - they are computed lazily on aspect change.
 */
async function handleComputeAzimuthsFromArray(request: ComputeAzimuthsFromArrayRequest): Promise<void> {
  const { id, elevations, width, height, bounds } = request;
  
  try {
    console.log('[Worker] Starting array-based azimuth computation:', { width, height, bounds });
    
    // Validate buffer isn't detached
    if (elevations.buffer.byteLength === 0) {
      throw new Error('elevations buffer is detached');
    }
    
    await ensureWasmInit();
    console.log('[Worker] WASM initialized for array-based azimuths');
    
    // Compute azimuths from raw array (runout is skipped - computed lazily)
    const arrayResult = compute_azimuths_from_array(elevations, width, height, []);
    
    // Get results using methods that return Float32Array
    const resultElevations = arrayResult.get_elevations();
    const resultAzimuths = arrayResult.get_azimuths();
    const resultGradients = arrayResult.get_gradients();
    const resultWidth = arrayResult.width;
    const resultHeight = arrayResult.height;
    
    console.log('[Worker] Array azimuths computed (runout lazy):', {
      elevationsLength: resultElevations.length,
      azimuthsLength: resultAzimuths.length,
      gradientsLength: resultGradients.length,
      width: resultWidth,
      height: resultHeight
    });

    // Convert results to GeoTIFF format for compatibility with existing visualization code
    const elevationsGeotiff = array_to_geotiff(
      resultElevations,
      resultWidth,
      resultHeight,
      bounds.west,
      bounds.north,
      bounds.east,
      bounds.south
    );
    
    const azimuthsGeotiff = array_to_geotiff(
      resultAzimuths,
      resultWidth,
      resultHeight,
      bounds.west,
      bounds.north,
      bounds.east,
      bounds.south
    );
    
    const gradientsGeotiff = array_to_geotiff(
      resultGradients,
      resultWidth,
      resultHeight,
      bounds.west,
      bounds.north,
      bounds.east,
      bounds.south
    );
    
    self.postMessage({
      type: 'azimuths_result',
      id,
      elevations: new Uint8Array(elevationsGeotiff),
      azimuths: new Uint8Array(azimuthsGeotiff),
      gradients: new Uint8Array(gradientsGeotiff),
      // No runout_zones - computed lazily on aspect change
      // Include raw data for lazy runout computation
      elevations_raw: resultElevations,
      azimuths_raw: resultAzimuths,
      gradients_raw: resultGradients,
      width: resultWidth,
      height: resultHeight,
      bounds
    } satisfies AzimuthsResult);
    
  } catch (error) {
    console.error('[Worker] Array azimuth computation error:', error);
    self.postMessage({
      type: 'error',
      id,
      message: error instanceof Error ? error.message : 'Unknown error computing azimuths from array'
    } satisfies ErrorResult);
  }
}

/**
 * Handle request to compute runout zones lazily when aspect selection changes.
 * Calls the WASM function that computes runout only for selected aspects.
 */
async function handleComputeRunout(request: ComputeRunoutRequest): Promise<void> {
  const { id, elevations, azimuths, gradients, width, height, bounds, excludedAspects } = request;
  
  try {
    console.log('[Worker] Computing runout lazily for aspects:', excludedAspects);
    
    await ensureWasmInit();
    
    // Call the lazy runout computation function
    const runoutArray = compute_runout_for_aspects(
      elevations,
      azimuths,
      gradients,
      width,
      height,
      excludedAspects
    );
    
    console.log('[Worker] Lazy runout computed, length:', runoutArray.length);
    
    // Convert to GeoTIFF for rendering
    const runoutZonesGeotiff = array_to_geotiff(
      runoutArray,
      width,
      height,
      bounds.west,
      bounds.north,
      bounds.east,
      bounds.south
    );
    
    self.postMessage({
      type: 'compute_runout_result',
      id,
      runout_zones: new Uint8Array(runoutZonesGeotiff)
    } satisfies ComputeRunoutResult);
    
  } catch (error) {
    console.error('[Worker] Compute runout error:', error);
    self.postMessage({
      type: 'error',
      id,
      message: error instanceof Error ? error.message : 'Unknown error computing runout'
    } satisfies ErrorResult);
  }
}

/**
 * Message handler
 */
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  
  switch (request.type) {
    case 'find_path':
      await handleFindPath(request);
      break;
    case 'compute_azimuths':
      await handleComputeAzimuths(request);
      break;
    case 'compute_azimuths_from_array':
      await handleComputeAzimuthsFromArray(request);
      break;
    case 'compute_runout':
      await handleComputeRunout(request);
      break;
  }
};
