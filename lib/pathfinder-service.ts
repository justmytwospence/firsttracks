/**
 * Pathfinder Service
 * 
 * Singleton service that manages the pathfinder web worker and provides
 * a clean API for computing azimuths and finding paths.
 */

import type { AzimuthData, Bounds, ElevationGrid } from './dem-cache';

// Re-export types for convenience
export type { Bounds, ElevationGrid, AzimuthData };

// Worker message types (mirror from worker file)
interface ComputeAzimuthsFromArrayRequest {
  type: 'compute_azimuths_from_array';
  id: string;
  elevations: Float32Array;
  width: number;
  height: number;
  bounds: Bounds;
  excludedAspects: string[];
}

interface AzimuthsResult {
  type: 'azimuths_result';
  id: string;
  elevations_raw: Float32Array;
  azimuths_raw: Float32Array;
  gradients_raw: Float32Array;
  width: number;
  height: number;
  bounds: Bounds;
}

interface ErrorResult {
  type: 'error';
  id: string;
  message: string;
}

type WorkerResponse = AzimuthsResult | ErrorResult | { type: string; id: string };

/**
 * Pathfinder service class - manages worker lifecycle and message handling
 */
class PathfinderService {
  private worker: Worker | null = null;
  private workerReady = false;
  private initPromise: Promise<void> | null = null;

  /**
   * Initialize the worker if not already initialized
   */
  async init(): Promise<void> {
    if (this.workerReady) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise<void>((resolve, reject) => {
      try {
        this.worker = new Worker(
          new URL('../workers/pathfinder.worker.ts', import.meta.url),
          { type: 'module' }
        );
        this.workerReady = true;
        console.log('[PathfinderService] Worker initialized');
        resolve();
      } catch (error) {
        console.error('[PathfinderService] Failed to initialize worker:', error);
        reject(error);
      }
    });

    return this.initPromise;
  }

  /**
   * Compute azimuths, gradients, and runout zones from elevation grid
   */
  async computeAzimuths(
    demGrid: ElevationGrid,
    excludedAspects: string[],
    onProgress?: (step: 'azimuths' | 'runout') => void
  ): Promise<AzimuthData> {
    await this.init();

    if (!this.worker) {
      throw new Error('Worker not initialized');
    }

    const id = `azimuths_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    return new Promise<AzimuthData>((resolve, reject) => {
      const handler = (event: MessageEvent<WorkerResponse>) => {
        if (event.data.id !== id) return;

        this.worker?.removeEventListener('message', handler);

        if (event.data.type === 'error') {
          reject(new Error((event.data as ErrorResult).message));
        } else if (event.data.type === 'azimuths_result') {
          const result = event.data as AzimuthsResult;
          resolve({
            elevations: result.elevations_raw,
            azimuths: result.azimuths_raw,
            gradients: result.gradients_raw,
            // runout_zones is computed lazily on aspect change.
            width: result.width,
            height: result.height,
            bounds: result.bounds,
          });
        }
      };

      const worker = this.worker;
      if (!worker) {
        reject(new Error('Worker not available'));
        return;
      }

      worker.addEventListener('message', handler);

      // Notify that azimuth computation is starting
      onProgress?.('azimuths');

      worker.postMessage(
        {
          type: 'compute_azimuths_from_array',
          id,
          elevations: demGrid.data,
          width: demGrid.width,
          height: demGrid.height,
          bounds: demGrid.bounds,
          excludedAspects,
        } as ComputeAzimuthsFromArrayRequest,
        [demGrid.data.buffer as ArrayBuffer]
      );
    });
  }

  /**
   * Compute runout zones lazily for specified aspects.
   * This is called when aspect selection changes.
   */
  async computeRunout(
    elevations: Float32Array,
    azimuths: Float32Array,
    gradients: Float32Array,
    width: number,
    height: number,
    bounds: Bounds,
    excludedAspects: string[]
  ): Promise<Float32Array> {
    await this.init();

    if (!this.worker) {
      throw new Error('Worker not initialized');
    }

    const id = `compute_runout_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    return new Promise<Float32Array>((resolve, reject) => {
      const handler = (event: MessageEvent) => {
        if (event.data.id !== id) return;

        this.worker?.removeEventListener('message', handler);

        if (event.data.type === 'error') {
          reject(new Error(event.data.message));
        } else if (event.data.type === 'compute_runout_result') {
          resolve(event.data.runout_zones);
        }
      };

      const worker = this.worker;
      if (!worker) {
        reject(new Error('Worker not available'));
        return;
      }

      worker.addEventListener('message', handler);

      // NOTE: do NOT transfer these buffers. The caller (page.tsx) reuses the
      // same Float32Arrays across repeated aspect toggles via currentAzimuthDataRef.
      worker.postMessage({
        type: 'compute_runout',
        id,
        elevations,
        azimuths,
        gradients,
        width,
        height,
        bounds,
        excludedAspects,
      });
    });
  }

  /**
   * Get the underlying worker (for pathfinding operations that need direct access)
   */
  getWorker(): Worker | null {
    return this.worker;
  }

  /**
   * Check if worker is ready
   */
  isReady(): boolean {
    return this.workerReady;
  }

  /**
   * Terminate the worker
   */
  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.workerReady = false;
      this.initPromise = null;
    }
  }
}

// Singleton instance
export const pathfinderService = new PathfinderService();
