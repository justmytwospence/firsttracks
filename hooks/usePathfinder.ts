/**
 * usePathfinder Hook
 * 
 * React hook for running WASM pathfinding in a Web Worker with real-time exploration visualization.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { 
  ComputeAzimuthsRequest, 
  PathfinderRequest, 
  WorkerRequest, 
  WorkerResponse 
} from '../workers/pathfinder.worker';

export interface PathfinderState {
  isReady: boolean;
  isRunning: boolean;
  progress: number; // 0-1 estimate based on exploration
  error: string | null;
}

export interface ExplorationNode {
  lon: number;
  lat: number;
  timestamp: number;
}

export interface PathfinderResult {
  geojson: string;
}

export interface AzimuthsResult {
  elevations: Uint8Array;
  azimuths: Uint8Array;
  gradients: Uint8Array;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export function usePathfinder() {
  const workerRef = useRef<Worker | null>(null);
  const pendingRequestsRef = useRef<Map<string, PendingRequest>>(new Map());
  const requestIdRef = useRef(0);
  
  const [state, setState] = useState<PathfinderState>({
    isReady: false,
    isRunning: false,
    progress: 0,
    error: null,
  });
  
  // Exploration nodes for visualization
  const [explorationNodes, setExplorationNodes] = useState<ExplorationNode[]>([]);
  
  // Initialize worker on mount
  useEffect(() => {
    // Create worker using dynamic import for the URL
    const worker = new Worker(
      new URL('../workers/pathfinder.worker.ts', import.meta.url),
      { type: 'module' }
    );
    
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      
      switch (response.type) {
        case 'exploration': {
          // Add exploration nodes with timestamp for animation
          const timestamp = Date.now();
          const nodes = response.nodes.map(([lon, lat]) => ({ lon, lat, timestamp }));
          setExplorationNodes(prev => [...prev, ...nodes]);
          break;
        }
        
        case 'path_result': {
          const pending = pendingRequestsRef.current.get(response.id);
          if (pending) {
            pending.resolve({ geojson: response.geojson });
            pendingRequestsRef.current.delete(response.id);
          }
          setState(prev => ({ ...prev, isRunning: false, progress: 1 }));
          break;
        }
        
        case 'azimuths_result': {
          const pending = pendingRequestsRef.current.get(response.id);
          if (pending) {
            pending.resolve({
              elevations: response.elevations,
              azimuths: response.azimuths,
              gradients: response.gradients,
            });
            pendingRequestsRef.current.delete(response.id);
          }
          setState(prev => ({ ...prev, isRunning: false }));
          break;
        }
        
        case 'error': {
          const pending = pendingRequestsRef.current.get(response.id);
          if (pending) {
            pending.reject(new Error(response.message));
            pendingRequestsRef.current.delete(response.id);
          }
          setState(prev => ({ 
            ...prev, 
            isRunning: false, 
            error: response.message 
          }));
          break;
        }
      }
    };
    
    worker.onerror = (error) => {
      console.error('Pathfinder worker error:', error);
      setState(prev => ({ 
        ...prev, 
        isRunning: false, 
        error: `Worker error: ${error.message}` 
      }));
    };
    
    workerRef.current = worker;
    setState(prev => ({ ...prev, isReady: true }));
    
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);
  
  /**
   * Generate unique request ID
   */
  const generateId = useCallback(() => {
    return `req_${++requestIdRef.current}`;
  }, []);
  
  /**
   * Send request to worker and return promise
   */
  const sendRequest = useCallback(<T,>(request: WorkerRequest): Promise<T> => {
    return new Promise((resolve, reject) => {
      if (!workerRef.current) {
        reject(new Error('Worker not initialized'));
        return;
      }
      
      pendingRequestsRef.current.set(request.id, { 
        resolve: resolve as (value: unknown) => void, 
        reject 
      });
      workerRef.current.postMessage(request);
    });
  }, []);
  
  /**
   * Find path between two points
   */
  const findPath = useCallback(async (params: {
    elevationsBuffer: Uint8Array;
    start: [number, number];
    end: [number, number];
    maxGradient: number | null;
    azimuthsBuffer: Uint8Array;
    excludedAspects: string[];
    gradientsBuffer: Uint8Array;
    aspectGradientThreshold: number | null;
  }): Promise<PathfinderResult> => {
    const id = generateId();
    
    // Reset state for new pathfinding run
    setState(prev => ({ 
      ...prev, 
      isRunning: true, 
      progress: 0, 
      error: null 
    }));
    setExplorationNodes([]);
    
    const request: PathfinderRequest = {
      type: 'find_path',
      id,
      ...params,
    };
    
    return sendRequest<PathfinderResult>(request);
  }, [generateId, sendRequest]);
  
  /**
   * Compute azimuths from elevation GeoTIFF
   */
  const computeAzimuths = useCallback(async (
    elevationsGeotiff: Uint8Array
  ): Promise<AzimuthsResult> => {
    const id = generateId();
    
    setState(prev => ({ 
      ...prev, 
      isRunning: true, 
      error: null 
    }));
    
    const request: ComputeAzimuthsRequest = {
      type: 'compute_azimuths',
      id,
      elevationsGeotiff,
    };
    
    return sendRequest<AzimuthsResult>(request);
  }, [generateId, sendRequest]);
  
  /**
   * Clear exploration visualization
   */
  const clearExploration = useCallback(() => {
    setExplorationNodes([]);
    setState(prev => ({ ...prev, progress: 0 }));
  }, []);
  
  /**
   * Cancel current pathfinding (terminates and recreates worker)
   */
  const cancel = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate();
      
      // Reject all pending requests
      for (const { reject } of pendingRequestsRef.current.values()) {
        reject(new Error('Cancelled'));
      }
      pendingRequestsRef.current.clear();
      
      // Create new worker
      const worker = new Worker(
        new URL('../workers/pathfinder.worker.ts', import.meta.url),
        { type: 'module' }
      );
      workerRef.current = worker;
      
      setState(prev => ({ 
        ...prev, 
        isRunning: false, 
        progress: 0 
      }));
      setExplorationNodes([]);
    }
  }, []);
  
  return {
    ...state,
    explorationNodes,
    findPath,
    computeAzimuths,
    clearExploration,
    cancel,
  };
}
