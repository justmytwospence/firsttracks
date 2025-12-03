import { Button } from "@/components/ui/button";
import type { ExplorationNode } from "@/hooks/usePathfinder";
import { type AzimuthData, type Bounds, cacheAzimuths, getAzimuthsWithContainsCheck, getDEMWithContainsCheck } from "@/lib/dem-cache";
import type { FeatureCollection, LineString, Point } from "geojson";
import { Loader } from "lucide-react";
import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * Smooth a path using Gaussian-weighted moving average.
 * This produces smoother, more natural-looking curves than simple corner cutting.
 * @param coords - Array of [lng, lat, elevation?] coordinates
 * @param windowSize - Size of the smoothing window (default 5)
 * @param sigma - Standard deviation for Gaussian weights (default 1.5)
 * @param preserveIndices - Optional set of indices to preserve exactly (e.g., waypoints)
 * @returns Smoothed coordinates array
 */
function smoothPath(coords: number[][], windowSize = 5, sigma = 1.5, preserveIndices?: Set<number>): number[][] {
  if (coords.length < 3) return coords;
  
  // Generate Gaussian weights
  const halfWindow = Math.floor(windowSize / 2);
  const weights: number[] = [];
  let weightSum = 0;
  
  for (let i = -halfWindow; i <= halfWindow; i++) {
    const weight = Math.exp(-(i * i) / (2 * sigma * sigma));
    weights.push(weight);
    weightSum += weight;
  }
  
  // Normalize weights
  for (let i = 0; i < weights.length; i++) {
    weights[i] /= weightSum;
  }
  
  const result: number[][] = [];
  const hasElevation = coords[0].length >= 3;
  
  for (let i = 0; i < coords.length; i++) {
    // Keep first, last, and any preserved indices unchanged
    if (i < halfWindow || i >= coords.length - halfWindow || preserveIndices?.has(i)) {
      result.push([...coords[i]]);
      continue;
    }
    
    let smoothedLng = 0;
    let smoothedLat = 0;
    let smoothedEle = 0;
    
    for (let j = -halfWindow; j <= halfWindow; j++) {
      const idx = i + j;
      const weight = weights[j + halfWindow];
      smoothedLng += coords[idx][0] * weight;
      smoothedLat += coords[idx][1] * weight;
      if (hasElevation) {
        smoothedEle += (coords[idx][2] || 0) * weight;
      }
    }
    
    if (hasElevation) {
      result.push([smoothedLng, smoothedLat, smoothedEle]);
    } else {
      result.push([smoothedLng, smoothedLat]);
    }
  }
  
  return result;
}

/**
 * Apply multiple passes of smoothing for stronger effect.
 * @param coords - Array of coordinates
 * @param passes - Number of smoothing passes
 * @param windowSize - Size of the smoothing window
 * @param sigma - Standard deviation for Gaussian weights
 * @param preserveIndices - Optional set of indices to preserve exactly (e.g., waypoints)
 */
function multiPassSmooth(coords: number[][], passes = 3, windowSize = 5, sigma = 1.5, preserveIndices?: Set<number>): number[][] {
  let result = coords;
  for (let i = 0; i < passes; i++) {
    result = smoothPath(result, windowSize, sigma, preserveIndices);
  }
  return result;
}

// Aspect enum (mirroring Rust enum)
export type Aspect = 
  | "north"
  | "northeast"
  | "east"
  | "southeast"
  | "south"
  | "southwest"
  | "west"
  | "northwest"
  | "flat";

interface FindPathButtonProps {
  waypoints: Point[];
  bounds: Bounds | null;
  maxGradient: number;
  excludedAspects: Aspect[];
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
  setPath: (path: LineString | null, invocationCounter: number) => void;
  setPathAspects: (aspectPoints: FeatureCollection) => void;
  setAspectRaster: (
    azimuthRaster: Uint8Array,
    gradientRaster: Uint8Array,
    runoutRaster?: Uint8Array
  ) => void;
  onExplorationUpdate?: (nodes: ExplorationNode[]) => void;
  onExplorationComplete?: () => void;
  onStartPathfinding?: () => void;
  explorationBatchSize?: number;
  explorationDelayMs?: number;
  className?: string;
  onlyLastSegment?: boolean;
  preloadBounds?: Bounds | null;
}

// Worker message types
interface WorkerRequest {
  type: "find_path" | "compute_azimuths";
  id: string;
  [key: string]: unknown;
}

interface WorkerResponse {
  type: "exploration" | "path_result" | "azimuths_result" | "error";
  id: string;
  [key: string]: unknown;
}

const FindPathButton = forwardRef<HTMLButtonElement, FindPathButtonProps>(
  function FindPathButton(
    {
      waypoints,
      bounds,
      maxGradient,
      excludedAspects,
      isLoading,
      setIsLoading,
      setPath,
      setPathAspects,
      setAspectRaster,
      onExplorationUpdate,
      onExplorationComplete,
      onStartPathfinding,
      explorationBatchSize = 125,
      explorationDelayMs = 10,
      className,
      onlyLastSegment = false,
      preloadBounds,
    },
    ref
  ) {
    const workerRef = useRef<Worker | null>(null);
    const [workerReady, setWorkerReady] = useState(false);
    const explorationQueueRef = useRef<ExplorationNode[][]>([]);
    const processingRef = useRef(false);
    const batchCountRef = useRef(0);
    const shouldStopRef = useRef(false);
    const cachedAzimuthsRef = useRef<AzimuthData | null>(null);
    const currentPathfindingIdRef = useRef<string | null>(null);
    const prevWaypointCountRef = useRef(0);
    const preloadingRef = useRef(false);
    const lastPreloadedBoundsRef = useRef<string | null>(null);
    
    // Stop exploration animation and cancel pathfinding when waypoints are cleared or reduced (undo)
    useEffect(() => {
      const waypointCountDecreased = waypoints.length < prevWaypointCountRef.current;
      prevWaypointCountRef.current = waypoints.length;
      
      if (waypoints.length === 0) {
        shouldStopRef.current = true;
        explorationQueueRef.current = [];
        processingRef.current = false;
        batchCountRef.current = 0;
        cachedAzimuthsRef.current = null; // Clear cached azimuths when waypoints reset
        currentPathfindingIdRef.current = null; // Cancel any in-progress pathfinding
        preloadingRef.current = false; // Allow new preloading
        setIsLoading(false);
        toast.dismiss();
      } else if (waypointCountDecreased && isLoading) {
        // Undo while pathfinding - cancel the current operation
        shouldStopRef.current = true;
        explorationQueueRef.current = [];
        processingRef.current = false;
        batchCountRef.current = 0;
        currentPathfindingIdRef.current = null;
        setIsLoading(false);
        toast.dismiss();
        // Reset shouldStop so future pathfinding can work
        setTimeout(() => { shouldStopRef.current = false; }, 0);
      } else {
        shouldStopRef.current = false;
      }
    }, [waypoints.length, setIsLoading, isLoading]);
    
    // Invalidate cached azimuths when excluded aspects change (runout zones depend on aspects)
    const prevExcludedAspectsRef = useRef<Aspect[]>(excludedAspects);
    useEffect(() => {
      // Compare excluded aspects by joining their values
      const prevKey = prevExcludedAspectsRef.current.sort().join(',');
      const currentKey = excludedAspects.slice().sort().join(',');
      
      if (prevKey !== currentKey) {
        // Aspects changed - invalidate cached azimuths to force recomputation with new runout zones
        cachedAzimuthsRef.current = null;
        lastPreloadedBoundsRef.current = null;
        prevExcludedAspectsRef.current = excludedAspects;
      }
    }, [excludedAspects]);
    
    // Process exploration queue - skip more batches as iteration count increases
    const processExplorationQueue = useCallback(async () => {
      if (processingRef.current) return;
      processingRef.current = true;
      
      while (explorationQueueRef.current.length > 0 && !shouldStopRef.current) {
        batchCountRef.current += 1;
        
        // Calculate how many batches to skip: floor(batchNumber / 5)
        // Batches 1-4: show every batch, 5-9: skip 1, 10-14: skip 2, etc.
        const skipCount = Math.floor(batchCountRef.current / 5);
        
        // Skip batches by just discarding them
        for (let i = 0; i < skipCount && explorationQueueRef.current.length > 1; i++) {
          explorationQueueRef.current.shift();
          batchCountRef.current += 1;
        }
        
        const batch = explorationQueueRef.current.shift();
        if (batch) {
          onExplorationUpdate?.(batch);
          // Small fixed delay for rendering
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
      }
      
      // Signal that exploration animation is complete (only if not stopped)
      if (!shouldStopRef.current) {
        onExplorationComplete?.();
      }
      processingRef.current = false;
    }, [onExplorationUpdate, onExplorationComplete]);
    
    // Initialize worker
    useEffect(() => {
      const worker = new Worker(
        new URL("../workers/pathfinder.worker.ts", import.meta.url),
        { type: "module" }
      );
      
      workerRef.current = worker;
      setWorkerReady(true);
      
      return () => {
        worker.terminate();
        workerRef.current = null;
      };
    }, []);
    
    // Preload azimuths when preloadBounds changes (typically on first waypoint or GPX import)
    useEffect(() => {
      if (!preloadBounds || !workerRef.current) return;
      
      // Create a key for the bounds to detect changes
      const boundsKey = `${preloadBounds.north},${preloadBounds.south},${preloadBounds.east},${preloadBounds.west}`;
      
      // Skip if already preloading or already preloaded these bounds
      if (preloadingRef.current) return;
      if (lastPreloadedBoundsRef.current === boundsKey && cachedAzimuthsRef.current) return;
      
      const preloadAzimuths = async () => {
        preloadingRef.current = true;
        lastPreloadedBoundsRef.current = boundsKey;
        const worker = workerRef.current;
        if (!worker) return;
        
        try {
          // Check IndexedDB cache first
          let azimuthResult = await getAzimuthsWithContainsCheck(preloadBounds);
          
          if (!azimuthResult) {
            // Fetch DEM data
            console.log('[Preload] Fetching DEM for azimuths...');
            const demData = await getDEMWithContainsCheck(preloadBounds);
            
            // Compute azimuths
            console.log('[Preload] Computing azimuths...');
            azimuthResult = await new Promise<AzimuthData>((resolve, reject) => {
              const id = `preload_azimuths_${Date.now()}`;
              
              const handler = (event: MessageEvent<WorkerResponse>) => {
                if (event.data.id !== id) return;
                
                worker.removeEventListener("message", handler);
                
                if (event.data.type === "error") {
                  reject(new Error(event.data.message as string));
                } else if (event.data.type === "azimuths_result") {
                  resolve({
                    elevations: event.data.elevations as Uint8Array,
                    azimuths: event.data.azimuths as Uint8Array,
                    gradients: event.data.gradients as Uint8Array,
                    runout_zones: event.data.runout_zones as Uint8Array,
                  });
                }
              };
              
              worker.addEventListener("message", handler);
              worker.postMessage({
                type: "compute_azimuths",
                id,
                elevationsGeotiff: new Uint8Array(demData),
                excludedAspects,
              } as WorkerRequest);
            });
            
            // Cache to IndexedDB
            await cacheAzimuths(preloadBounds, azimuthResult);
          }
          
          // Cache in memory
          cachedAzimuthsRef.current = {
            elevations: new Uint8Array(azimuthResult.elevations),
            azimuths: new Uint8Array(azimuthResult.azimuths),
            gradients: new Uint8Array(azimuthResult.gradients),
            runout_zones: azimuthResult.runout_zones ? new Uint8Array(azimuthResult.runout_zones) : undefined,
          };
          
          // Update aspect raster display
          setAspectRaster(azimuthResult.azimuths, azimuthResult.gradients, azimuthResult.runout_zones);
          
          console.log('[Preload] Azimuths ready');
        } catch (error) {
          console.warn('[Preload] Failed to preload azimuths:', error);
        } finally {
          preloadingRef.current = false;
        }
      };
      
      preloadAzimuths();
    }, [preloadBounds, setAspectRaster, excludedAspects]);
    
    const handleClick = useCallback(async () => {
      console.log('=== FindPathButton handleClick START ===');
      console.log('bounds:', bounds);
      console.log('workerRef.current:', !!workerRef.current);
      console.log('waypoints.length:', waypoints.length);
      console.log('onlyLastSegment:', onlyLastSegment);
      
      if (!bounds || !workerRef.current) {
        console.log('Early return: bounds or worker not ready');
        return;
      }
      setIsLoading(true);
      onStartPathfinding?.();
      batchCountRef.current = 0;
      toast.dismiss();
      
      const loadingToastId = "pathfinder-loading";
      const worker = workerRef.current;
      const sessionId = `session_${Date.now()}`;
      currentPathfindingIdRef.current = sessionId;
      
      try {
        let azimuthResult = cachedAzimuthsRef.current;
        
        // Only fetch/compute azimuths if not already cached in memory
        if (!azimuthResult) {
          // Check IndexedDB cache first
          azimuthResult = await getAzimuthsWithContainsCheck(bounds);
          
          if (!azimuthResult) {
            // Fetch DEM data (with caching - will use preloaded expanded region if available)
            toast.message("Downloading DEM from OpenTopo...", { 
              id: loadingToastId, 
              duration: Number.POSITIVE_INFINITY 
            });
            
            const demData = await getDEMWithContainsCheck(bounds, {
              onProgress: (message) => {
                toast.message(message, { id: loadingToastId, duration: Number.POSITIVE_INFINITY });
              }
            });
            
            // Compute azimuths (copy demData since postMessage can detach ArrayBuffer)
            toast.message("Computing azimuths and gradients...", { 
              id: loadingToastId, 
              duration: Number.POSITIVE_INFINITY 
            });
            
            const azimuthsPromise = new Promise<AzimuthData>((resolve, reject) => {
              const id = `azimuths_${Date.now()}`;
              
              const handler = (event: MessageEvent<WorkerResponse>) => {
                if (event.data.id !== id) return;
                
                worker.removeEventListener("message", handler);
                
                if (event.data.type === "error") {
                  reject(new Error(event.data.message as string));
                } else if (event.data.type === "azimuths_result") {
                  resolve({
                    elevations: event.data.elevations as Uint8Array,
                    azimuths: event.data.azimuths as Uint8Array,
                    gradients: event.data.gradients as Uint8Array,
                    runout_zones: event.data.runout_zones as Uint8Array,
                  });
                }
              };
              
              worker.addEventListener("message", handler);
              worker.postMessage({
                type: "compute_azimuths",
                id,
                elevationsGeotiff: new Uint8Array(demData),
                excludedAspects,
              } as WorkerRequest);
            });
            
            azimuthResult = await azimuthsPromise;
            
            // Cache the computed azimuths to IndexedDB for next session
            await cacheAzimuths(bounds, azimuthResult);
          }
          
          // Cache in memory for subsequent pathfinding in this session
          // Make copies to avoid detached buffer issues when posting to worker
          cachedAzimuthsRef.current = {
            elevations: new Uint8Array(azimuthResult.elevations),
            azimuths: new Uint8Array(azimuthResult.azimuths),
            gradients: new Uint8Array(azimuthResult.gradients),
            runout_zones: azimuthResult.runout_zones ? new Uint8Array(azimuthResult.runout_zones) : undefined,
          };
          
          toast.dismiss(loadingToastId);
          setAspectRaster(azimuthResult.azimuths, azimuthResult.gradients, azimuthResult.runout_zones);
        }
        
        // Use the cached copy for pathfinding
        const azimuthData = cachedAzimuthsRef.current;
        if (!azimuthData) {
          throw new Error("Azimuth data not available");
        }
        
        // Find paths - either all segments or just the last one
        // onlyLastSegment=true when adding a new waypoint to an existing path
        // onlyLastSegment=false when dragging/inserting waypoints (triggers full re-pathfinding)
        const startSegment = onlyLastSegment ? waypoints.length - 2 : 0;
        let pathSegmentCounter = onlyLastSegment ? 1 : 0; // Start at 1 to append if onlyLastSegment
        console.log('FindPathButton: waypoints.length =', waypoints.length, 'onlyLastSegment =', onlyLastSegment, 'startSegment =', startSegment);
        
        // Start polling the exploration queue so visualization happens during pathfinding
        const queuePollInterval = setInterval(() => {
          if (explorationQueueRef.current.length > 0 && !processingRef.current) {
            processExplorationQueue();
          }
        }, 16); // ~60fps
        
        try {
          for (let i = startSegment; i < waypoints.length - 1; i++) {
            const pathPromise = new Promise<string>((resolve, reject) => {
            const id = `path_${Date.now()}_${i}`;
            
            const handler = (event: MessageEvent<WorkerResponse>) => {
              if (event.data.id !== id) return;
              
              if (event.data.type === "exploration") {
                // Ignore if this pathfinding session was cancelled
                if (currentPathfindingIdRef.current !== sessionId) return;
                // Queue exploration updates for delayed processing
                const nodes = (event.data.nodes as [number, number][]).map(
                  ([lon, lat]) => ({
                    lon,
                    lat,
                    timestamp: Date.now(),
                  })
                );
                explorationQueueRef.current.push(nodes);
                // Don't await - let it process asynchronously while pathfinding continues
                setTimeout(() => processExplorationQueue(), 0);
              } else if (event.data.type === "path_result") {
                worker.removeEventListener("message", handler);
                resolve(event.data.geojson as string);
              } else if (event.data.type === "error") {
                worker.removeEventListener("message", handler);
                reject(new Error(event.data.message as string));
              }
            };
            
            worker.addEventListener("message", handler);
            worker.postMessage({
              type: "find_path",
              id,
              elevationsBuffer: new Uint8Array(azimuthData.elevations),
              start: waypoints[i].coordinates as [number, number],
              end: waypoints[i + 1].coordinates as [number, number],
              maxGradient,
              azimuthsBuffer: new Uint8Array(azimuthData.azimuths),
              excludedAspects,
              gradientsBuffer: new Uint8Array(azimuthData.gradients),
              aspectGradientThreshold: 0.05,
              explorationBatchSize,
              explorationDelayMs,
              runoutZonesBuffer: azimuthData.runout_zones ? new Uint8Array(azimuthData.runout_zones) : undefined,
            } as WorkerRequest);
          });
          
          try {
            const pathJson = await pathPromise;
            
            // Check if this pathfinding session was cancelled
            if (currentPathfindingIdRef.current !== sessionId) {
              return; // Exit the loop, pathfinding was cancelled
            }
            
            toast.dismiss(loadingToastId);
            
            const pathData = JSON.parse(pathJson);
            const rawCoordinates = pathData.features.map(
              (point: { geometry: { coordinates: [number, number] } }) => 
                point.geometry.coordinates
            );
            
            // Apply Gaussian smoothing to reduce jaggedness from grid-based pathfinding
            // Preserve the first and last coordinates (waypoints) exactly
            const preserveIndices = new Set([0, rawCoordinates.length - 1]);
            const smoothedCoordinates = multiPassSmooth(rawCoordinates, 3, 5, 1.5, preserveIndices);
            
            const path = {
              type: "LineString",
              coordinates: smoothedCoordinates,
            } as LineString;
            
            setPath(path, pathSegmentCounter);
            setPathAspects(pathData as FeatureCollection);
            pathSegmentCounter++;
          } catch (segmentError) {
            const errorMessage = segmentError instanceof Error 
              ? segmentError.message 
              : String(segmentError);
              
            if (errorMessage.toLowerCase().includes("no path found")) {
              toast.warning(`No path found for segment ${i + 1}. Try adjusting constraints.`);
            } else {
              throw segmentError;
            }
          }
        }
        } finally {
          // Stop polling the exploration queue
          clearInterval(queuePollInterval);
        }
      } catch (error) {
        toast.dismiss(loadingToastId);
        const errorMessage = error instanceof Error ? error.message : String(error);
        toast.error(errorMessage || "Failed to find path.");
      } finally {
        toast.dismiss(loadingToastId);
        setIsLoading(false);
      }
    }, [
      bounds,
      waypoints,
      maxGradient,
      excludedAspects,
      setIsLoading,
      setPath,
      setPathAspects,
      setAspectRaster,
      onStartPathfinding,
      processExplorationQueue,
      explorationBatchSize,
      explorationDelayMs,
      onlyLastSegment,
    ]);

    return (
      <Button
        ref={ref}
        className={`${className || "flex-1"} overflow-hidden`}
        onClick={handleClick}
        disabled={waypoints.length < 2 || !workerReady}
      >
        {isLoading ? (
          <>
            <span className="truncate">Find Path</span>
            <Loader className="animate-spin h-4 w-4 ml-2 shrink-0" />
          </>
        ) : (
          "Find Path"
        )}
      </Button>
    );
  }
);

export default FindPathButton;
export type { Bounds };
