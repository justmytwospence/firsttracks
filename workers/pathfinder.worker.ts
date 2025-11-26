/**
 * Pathfinder Web Worker
 * 
 * Runs the WASM pathfinding algorithm off the main thread to keep the UI responsive.
 * Sends exploration updates back to main thread for visualization.
 */

import wasmInit, { find_path_rs, compute_azimuths, init as initPanicHook } from '../pathfinder/pkg/pathfinder';

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
}

export interface ComputeAzimuthsRequest {
  type: 'compute_azimuths';
  id: string;
  elevationsGeotiff: Uint8Array;
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
}

export interface ErrorResult {
  type: 'error';
  id: string;
  message: string;
}

export type WorkerRequest = PathfinderRequest | ComputeAzimuthsRequest;
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
    explorationDelayMs = 0
  } = request;
  
  try {
    console.log('[Worker] Starting pathfinding...', { start, end, maxGradient, explorationBatchSize, explorationDelayMs });
    await ensureWasmInit();
    console.log('[Worker] WASM initialized');
    
    // Create exploration callback that posts updates to main thread
    // Note: WASM calls this synchronously, so we post the message but delay happens client-side
    const explorationCallback = (nodes: [number, number][]) => {
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
      azimuthsBufferLength: azimuthsBuffer.length,
      gradientsBufferLength: gradientsBuffer.length,
      startGeoJson,
      endGeoJson,
      excludedAspects,
      explorationBatchSize
    });
    
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
      explorationBatchSize
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
  const { id, elevationsGeotiff } = request;
  
  try {
    console.log('[Worker] Starting azimuth computation, buffer length:', elevationsGeotiff.length);
    await ensureWasmInit();
    console.log('[Worker] WASM initialized for azimuths');
    
    const result = compute_azimuths(elevationsGeotiff);
    console.log('[Worker] Azimuths computed:', {
      elevationsLength: result.elevations.length,
      azimuthsLength: result.azimuths.length,
      gradientsLength: result.gradients.length
    });
    
    self.postMessage({
      type: 'azimuths_result',
      id,
      elevations: result.elevations,
      azimuths: result.azimuths,
      gradients: result.gradients
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
  }
};
