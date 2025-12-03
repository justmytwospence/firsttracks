/**
 * Pathfinder Web Worker
 * 
 * Runs the WASM pathfinding algorithm off the main thread to keep the UI responsive.
 * Sends exploration updates back to main thread for visualization.
 */

import wasmInit, { find_path_rs, compute_azimuths, compute_azimuths_from_array, array_to_geotiff, init as initPanicHook } from '../pathfinder/pkg/pathfinder';

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
  explorationBatchSize?: number;
  explorationDelayMs?: number;
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

export interface ExplorationUpdate {
  type: 'exploration';
  id: string;
  nodes: [number, number][]; // [lon, lat] pairs
  delayMs?: number; // Optional delay for animation pacing
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
  runout_zones: Uint8Array;
}

export interface ErrorResult {
  type: 'error';
  id: string;
  message: string;
}

export type WorkerRequest = PathfinderRequest | ComputeAzimuthsRequest | ComputeAzimuthsFromArrayRequest;
export type WorkerResponse = ExplorationUpdate | PathResult | AzimuthsResult | ErrorResult;

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
 * Handle pathfinding request
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
    explorationBatchSize = 125,
    explorationDelayMs = 0,
    runoutZonesBuffer
  } = request;
  
  try {
    console.log('[Worker] Starting pathfinding...', { start, end, maxGradient, explorationBatchSize, explorationDelayMs });
    await ensureWasmInit();
    console.log('[Worker] WASM initialized');
    
    // Create exploration callback that posts updates to main thread
    // Note: WASM calls this synchronously, so we post the message but delay happens client-side
    const explorationCallback = (nodes: [number, number][]) => {
      console.log('[Worker] Exploration callback called with', nodes.length, 'nodes');
      self.postMessage({
        type: 'exploration',
        id,
        nodes,
        delayMs: explorationDelayMs
      } satisfies ExplorationUpdate);
    };
    
    // Call the WASM pathfinding function
    // Wrap coordinates in GeoJSON Point format as expected by Rust
    const startGeoJson = JSON.stringify({
      type: "Point",
      coordinates: start
    });
    const endGeoJson = JSON.stringify({
      type: "Point", 
      coordinates: end
    });
    
    console.log('[Worker] Calling find_path_rs with:', {
      elevationsBufferLength: elevationsBuffer.length,
      elevationsBufferByteLength: elevationsBuffer.byteLength,
      elevationsBufferDetached: elevationsBuffer.buffer.byteLength === 0,
      azimuthsBufferLength: azimuthsBuffer.length,
      azimuthsBufferDetached: azimuthsBuffer.buffer.byteLength === 0,
      gradientsBufferLength: gradientsBuffer.length,
      gradientsBufferDetached: gradientsBuffer.buffer.byteLength === 0,
      runoutZonesBufferLength: runoutZonesBuffer?.length,
      runoutZonesBufferDetached: runoutZonesBuffer ? runoutZonesBuffer.buffer.byteLength === 0 : 'N/A',
      startGeoJson,
      endGeoJson,
      excludedAspects,
      explorationBatchSize
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
      explorationBatchSize,
      runoutZonesBuffer ?? null
    );
    
    console.log('[Worker] Path found, result length:', resultJson.length);
    
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
      // Try to extract message from JsValue or other objects
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
 */
async function handleComputeAzimuthsFromArray(request: ComputeAzimuthsFromArrayRequest): Promise<void> {
  const { id, elevations, width, height, bounds, excludedAspects } = request;
  
  try {
    console.log('[Worker] Starting array-based azimuth computation:', { width, height, bounds });
    
    // Validate buffer isn't detached
    if (elevations.buffer.byteLength === 0) {
      throw new Error('elevations buffer is detached');
    }
    
    await ensureWasmInit();
    console.log('[Worker] WASM initialized for array-based azimuths');
    
    // Compute azimuths from raw array
    const arrayResult = compute_azimuths_from_array(elevations, width, height, excludedAspects ?? []);
    console.log('[Worker] Array azimuths computed:', {
      elevationsLength: arrayResult.elevations.length,
      azimuthsLength: arrayResult.azimuths.length,
      gradientsLength: arrayResult.gradients.length,
      runoutZonesLength: arrayResult.runout_zones?.length,
      width: arrayResult.width,
      height: arrayResult.height
    });
    
    // Convert results to GeoTIFF format for compatibility with existing visualization code
    const elevationsGeotiff = array_to_geotiff(
      arrayResult.elevations,
      arrayResult.width,
      arrayResult.height,
      bounds.west,
      bounds.north,
      bounds.east,
      bounds.south
    );
    
    const azimuthsGeotiff = array_to_geotiff(
      arrayResult.azimuths,
      arrayResult.width,
      arrayResult.height,
      bounds.west,
      bounds.north,
      bounds.east,
      bounds.south
    );
    
    const gradientsGeotiff = array_to_geotiff(
      arrayResult.gradients,
      arrayResult.width,
      arrayResult.height,
      bounds.west,
      bounds.north,
      bounds.east,
      bounds.south
    );
    
    const runoutZonesGeotiff = array_to_geotiff(
      arrayResult.runout_zones,
      arrayResult.width,
      arrayResult.height,
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
      runout_zones: new Uint8Array(runoutZonesGeotiff)
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
  }
};
