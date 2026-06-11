/**
 * Pathfinder Service
 * 
 * Singleton service that manages the pathfinder web worker and provides
 * a clean API for computing azimuths and finding paths.
 */

import type {
  AzimuthsResult,
  ComputeAzimuthsFromArrayRequest,
  ErrorResult,
  WorkerResponse,
} from '@/workers/pathfinder.worker';
import type { AzimuthData, Bounds, ElevationGrid } from './dem-cache';

// Re-export types for convenience
export type { Bounds, ElevationGrid, AzimuthData };

/**
 * Pathfinder service class - manages worker lifecycle and message handling
 */
class PathfinderService {
  private worker: Worker | null = null;
  private workerReady = false;
  private initPromise: Promise<void> | null = null;
  private pendingRejects = new Map<string, (err: Error) => void>();

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
        // A module worker that fails to load/parse (or whose WASM import
        // fails) reports it via an async 'error' event; without these
        // listeners every pending request would hang forever.
        this.worker.addEventListener('error', (event) => {
          console.error('[PathfinderService] Worker error:', event.message);
          this.failPending(new Error(`Pathfinder worker error: ${event.message || 'worker failed to load'}`));
        });
        this.worker.addEventListener('messageerror', () => {
          this.failPending(new Error('Pathfinder worker message could not be deserialized'));
        });
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
   * Reject every in-flight request (worker died or can't deliver messages).
   */
  private failPending(err: Error): void {
    for (const reject of this.pendingRejects.values()) {
      reject(err);
    }
    this.pendingRejects.clear();
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

    const id = `azimuths_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    return new Promise<AzimuthData>((resolve, reject) => {
      const worker = this.worker;
      if (!worker) {
        reject(new Error('Worker not available'));
        return;
      }

      const settle = () => {
        worker.removeEventListener('message', handler);
        this.pendingRejects.delete(id);
      };
      const handler = (event: MessageEvent<WorkerResponse>) => {
        if (event.data.id !== id) return;

        settle();

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
      this.pendingRejects.set(id, (err) => {
        settle();
        reject(err);
      });

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

    const id = `compute_runout_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    return new Promise<Float32Array>((resolve, reject) => {
      const worker = this.worker;
      if (!worker) {
        reject(new Error('Worker not available'));
        return;
      }

      const settle = () => {
        worker.removeEventListener('message', handler);
        this.pendingRejects.delete(id);
      };
      const handler = (event: MessageEvent) => {
        if (event.data.id !== id) return;

        settle();

        if (event.data.type === 'error') {
          reject(new Error(event.data.message));
        } else if (event.data.type === 'compute_runout_result') {
          resolve(event.data.runout_zones);
        }
      };
      this.pendingRejects.set(id, (err) => {
        settle();
        reject(err);
      });

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
      this.failPending(new Error('Pathfinder worker terminated'));
    }
  }
}

// Singleton instance
export const pathfinderService = new PathfinderService();
