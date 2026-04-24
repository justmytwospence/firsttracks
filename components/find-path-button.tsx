import { Button } from "@/components/ui/button";
import { type AzimuthData, type Bounds, type ElevationGrid, boundsContain, cacheAzimuths, expandBounds, getAzimuthsWithContainsCheck, getDEMWithContainsCheck, unionBounds } from "@/lib/dem-cache";
import type { FeatureCollection, LineString, Point } from "geojson";
import { Loader } from "lucide-react";
import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * Compute bounds that contain all waypoints.
 */
function waypointsToBounds(waypoints: Point[]): Bounds | null {
  if (waypoints.length === 0) return null;
  
  const lons = waypoints.map(w => w.coordinates[0]);
  const lats = waypoints.map(w => w.coordinates[1]);
  
  return {
    north: Math.max(...lats),
    south: Math.min(...lats),
    east: Math.max(...lons),
    west: Math.min(...lons),
  };
}

/**
 * Check if all waypoints are within the given bounds.
 */
function waypointsWithinBounds(waypoints: Point[], bounds: Bounds): boolean {
  return waypoints.every(w => {
    const [lon, lat] = w.coordinates;
    return lat <= bounds.north && lat >= bounds.south && lon <= bounds.east && lon >= bounds.west;
  });
}

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
  onExplorationUpdate?: (data: {
    cells: Uint16Array;
    originX: number;
    originY: number;
    scaleX: number;
    scaleY: number;
    width: number;
    height: number;
  }) => void;
  onExplorationComplete?: () => void;
  onStartPathfinding?: () => void;
  onDataBoundsChange?: (bounds: Bounds) => void;
  className?: string;
  onlyLastSegment?: boolean;
  preloadBounds?: Bounds | null;
  avoidRunoutZones?: boolean;
}

// Worker message types
interface WorkerRequest {
  type: "find_path" | "compute_azimuths" | "compute_azimuths_from_array";
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
      onDataBoundsChange,
      className,
      onlyLastSegment = false,
      preloadBounds,
      avoidRunoutZones = true,
    },
    ref
  ) {
    const workerRef = useRef<Worker | null>(null);
    const [workerReady, setWorkerReady] = useState(false);
    const shouldStopRef = useRef(false);
    const cachedAzimuthsRef = useRef<AzimuthData | null>(null);
    const currentPathfindingIdRef = useRef<string | null>(null);
    const prevWaypointCountRef = useRef(0);
    const lastSuccessfulWaypointCountRef = useRef(0);
    const preloadingRef = useRef(false);
    const lastPreloadedBoundsRef = useRef<string | null>(null);

    // Stop exploration animation and cancel pathfinding when waypoints are cleared or reduced (undo)
    useEffect(() => {
      const waypointCountDecreased = waypoints.length < prevWaypointCountRef.current;
      prevWaypointCountRef.current = waypoints.length;

      if (waypoints.length === 0) {
        shouldStopRef.current = true;
        cachedAzimuthsRef.current = null;
        currentPathfindingIdRef.current = null;
        preloadingRef.current = false;
        lastSuccessfulWaypointCountRef.current = 0;
        setIsLoading(false);
        toast.dismiss();
      } else if (waypointCountDecreased && isLoading) {
        shouldStopRef.current = true;
        currentPathfindingIdRef.current = null;
        lastSuccessfulWaypointCountRef.current = 0;
        setIsLoading(false);
        toast.dismiss();
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
    
    // Note: Azimuth preloading is now handled by page.tsx with toasts
    // This component only computes azimuths on-demand during pathfinding if not already cached
    
    const handleClick = useCallback(async () => {
      if (!bounds || !workerRef.current) {
        return;
      }
      
      // Check if waypoints are within current bounds - if not, we need to expand
      let effectiveBounds = bounds;
      const waypointBounds = waypointsToBounds(waypoints);
      const waypointsOutsideBounds = waypointBounds && !boundsContain(bounds, waypointBounds);
      
      if (waypointsOutsideBounds) {
        // Compute new bounds that include both current bounds and waypoints (with padding)
        const combinedBounds = unionBounds(bounds, waypointBounds);
        // Expand by 1.5x to give some buffer around waypoints
        effectiveBounds = expandBounds(combinedBounds, 1.5);
        // Invalidate cached azimuths since we're fetching new data
        cachedAzimuthsRef.current = null;
      }
      
      // Clear existing path when starting new pathfinding
      // Pass invocationCounter 0 to signal a fresh start
      if (!onlyLastSegment) {
        setPath(null, 0);
        setPathAspects({ type: "FeatureCollection", features: [] });
      }
      
      setIsLoading(true);
      onStartPathfinding?.();
      toast.dismiss();
      
      const loadingToastId = "pathfinder-loading";
      const worker = workerRef.current;
      const sessionId = `session_${Date.now()}`;
      currentPathfindingIdRef.current = sessionId;
      
      try {
        let azimuthResult = cachedAzimuthsRef.current;
        
        // Only fetch/compute azimuths if not already cached in memory
        if (!azimuthResult) {
          // Check IndexedDB cache first (use effective bounds which may be expanded)
          azimuthResult = await getAzimuthsWithContainsCheck(effectiveBounds, excludedAspects);
          
          if (!azimuthResult) {
            // Fetch DEM data from AWS Terrain Tiles (with caching - will use preloaded expanded region if available)
            toast.message(waypointsOutsideBounds ? "Expanding terrain coverage..." : "Downloading elevation data...", { 
              id: loadingToastId, 
              duration: Number.POSITIVE_INFINITY 
            });
            
            const demGrid: ElevationGrid = await getDEMWithContainsCheck(effectiveBounds, {
              onProgress: (message) => {
                toast.message(message, { id: loadingToastId, duration: Number.POSITIVE_INFINITY });
              }
            });
            
            // Report actual data bounds to parent
            onDataBoundsChange?.(demGrid.bounds);
            
            // Compute azimuths from array
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
                type: "compute_azimuths_from_array",
                id,
                elevations: demGrid.data,
                width: demGrid.width,
                height: demGrid.height,
                bounds: demGrid.bounds,
                excludedAspects,
              } as WorkerRequest);
            });
            
            azimuthResult = await azimuthsPromise;
            
            // Cache the computed azimuths to IndexedDB for next session
            // Use demGrid.bounds which represents the actual data coverage
            await cacheAzimuths(demGrid.bounds, azimuthResult, excludedAspects);
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
        // Only do last segment if:
        // 1. onlyLastSegment prop is true (caller wants incremental)
        // 2. Waypoint count increased by exactly 1 since last successful pathfind
        // 3. We have a previous successful pathfind (lastSuccessfulWaypointCountRef > 0)
        const addedOneWaypoint = waypoints.length === lastSuccessfulWaypointCountRef.current + 1;
        const effectiveOnlyLastSegment = onlyLastSegment && addedOneWaypoint && lastSuccessfulWaypointCountRef.current > 0;
        
        const startSegment = effectiveOnlyLastSegment ? waypoints.length - 2 : 0;
        let pathSegmentCounter = effectiveOnlyLastSegment ? 1 : 0; // Start at 1 to append if effectiveOnlyLastSegment
        
        try {
          for (let i = startSegment; i < waypoints.length - 1; i++) {
            const pathPromise = new Promise<string>((resolve, reject) => {
            const id = `path_${Date.now()}_${i}`;
            
            const handler = (event: MessageEvent<WorkerResponse>) => {
              if (event.data.id !== id) return;
              
              if (event.data.type === "exploration") {
                if (currentPathfindingIdRef.current !== sessionId) return;
                onExplorationUpdate?.({
                  cells: event.data.cells as Uint16Array,
                  originX: event.data.originX as number,
                  originY: event.data.originY as number,
                  scaleX: event.data.scaleX as number,
                  scaleY: event.data.scaleY as number,
                  width: event.data.width as number,
                  height: event.data.height as number,
                });
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
              runoutZonesBuffer: avoidRunoutZones && azimuthData.runout_zones ? new Uint8Array(azimuthData.runout_zones) : undefined,
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
          // Call exploration complete when done
          onExplorationComplete?.();
        }
        
        // Track successful pathfinding waypoint count for incremental optimization
        lastSuccessfulWaypointCountRef.current = waypoints.length;
        
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
      onDataBoundsChange,
      onExplorationUpdate,
      onExplorationComplete,
      onlyLastSegment,
      avoidRunoutZones,
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
