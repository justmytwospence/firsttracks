import { Button } from "@/components/ui/button";
import { type AzimuthData, type Bounds, type ElevationGrid, boundsContain, cacheAzimuths, expandBounds, getAzimuthsWithContainsCheck, getDEMWithContainsCheck, unionBounds } from "@/lib/dem-cache";
import { pathfinderService } from "@/lib/pathfinder-service";
import type { WorkerRequest, WorkerResponse } from "@/workers/pathfinder.worker";
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
  setPathAspects: (aspectPoints: FeatureCollection | null, invocationCounter?: number) => void;
  setAspectRaster: (
    azimuths: Float32Array,
    gradients: Float32Array,
    runout: Float32Array | undefined,
    width: number,
    height: number,
    bounds: Bounds,
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
  avoidRunoutZones?: boolean;
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
      avoidRunoutZones = true,
    },
    ref
  ) {
    const workerRef = useRef<Worker | null>(null);
    const [workerReady, setWorkerReady] = useState(false);
    const cachedAzimuthsRef = useRef<AzimuthData | null>(null);
    const currentPathfindingIdRef = useRef<string | null>(null);
    const prevWaypointCountRef = useRef(0);
    const lastSuccessfulWaypointCountRef = useRef(0);

    // Stop exploration animation and cancel pathfinding when waypoints are cleared or reduced (undo)
    useEffect(() => {
      const waypointCountDecreased = waypoints.length < prevWaypointCountRef.current;
      prevWaypointCountRef.current = waypoints.length;

      if (waypoints.length === 0) {
        cachedAzimuthsRef.current = null;
        currentPathfindingIdRef.current = null;
        lastSuccessfulWaypointCountRef.current = 0;
        setIsLoading(false);
        toast.dismiss();
      } else if (waypointCountDecreased && isLoading) {
        currentPathfindingIdRef.current = null;
        lastSuccessfulWaypointCountRef.current = 0;
        setIsLoading(false);
        toast.dismiss();
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
        prevExcludedAspectsRef.current = excludedAspects;
      }
    }, [excludedAspects]);
    
    // Use the shared worker from pathfinderService so we don't load a second WASM heap.
    useEffect(() => {
      let cancelled = false;
      pathfinderService.init().then(() => {
        if (cancelled) return;
        workerRef.current = pathfinderService.getWorker();
        setWorkerReady(true);
      }).catch((err) => {
        console.error('[FindPathButton] Failed to init shared worker:', err);
      });
      return () => {
        cancelled = true;
        // Don't terminate — the worker is shared and owned by pathfinderService.
        workerRef.current = null;
      };
    }, []);
    
    // Note: Azimuth preloading is now handled by page.tsx with toasts
    // This component only computes azimuths on-demand during pathfinding if not already cached
    
    const handleClick = useCallback(async () => {
      if (!bounds || !workerRef.current) {
        return;
      }

      // Determine whether this run will pathfind only the last segment (incremental)
      // or all segments (e.g. after a marker drag). For incremental, only the last 2
      // waypoints need to be inside the raster — older segments' paths are already
      // computed and preserved in `path` state, and their tiles are already in IDB.
      // Scoping the bounds to the relevant segment keeps us under MAX_TILES even when
      // the new waypoint is far from the existing region.
      const addedOneWaypoint = waypoints.length === lastSuccessfulWaypointCountRef.current + 1;
      const willOnlyDoLastSegment =
        onlyLastSegment && addedOneWaypoint && lastSuccessfulWaypointCountRef.current > 0;
      const relevantWaypoints = willOnlyDoLastSegment ? waypoints.slice(-2) : waypoints;

      let effectiveBounds = bounds;
      const relevantWaypointBounds = waypointsToBounds(relevantWaypoints);
      const waypointsOutsideBounds =
        relevantWaypointBounds && !boundsContain(bounds, relevantWaypointBounds);

      if (waypointsOutsideBounds) {
        // For incremental pathfinding, focus tightly on the new segment so the
        // resulting bounds stay well inside MAX_TILES. For a full re-pathfind,
        // union with the existing region so all waypoints are covered.
        const baseBounds = willOnlyDoLastSegment
          ? relevantWaypointBounds
          : unionBounds(bounds, relevantWaypointBounds);
        effectiveBounds = expandBounds(baseBounds, 1.5);
        // Defensive: if expansion couldn't grow (e.g. base was already at the tile
        // cap), fall back to a tight box around just the segment.
        if (!boundsContain(effectiveBounds, relevantWaypointBounds)) {
          effectiveBounds = expandBounds(relevantWaypointBounds, 1.2);
        }
        cachedAzimuthsRef.current = null;
      }
      
      // Clear existing path when starting new pathfinding
      // Pass invocationCounter 0 to signal a fresh start
      if (!onlyLastSegment) {
        setPath(null, 0);
        setPathAspects(null);
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
          azimuthResult = await getAzimuthsWithContainsCheck(effectiveBounds);
          
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
            
            // The service transfers demGrid.data's buffer to the worker, same
            // as the previous inline implementation did.
            azimuthResult = await pathfinderService.computeAzimuths(demGrid, excludedAspects);

            // Cache the computed azimuths to IndexedDB for next session.
            await cacheAzimuths(demGrid.bounds, azimuthResult);
          }

          // Cache in memory for subsequent pathfinding in this session.
          // Make copies because we'll transfer buffers per find_path call.
          cachedAzimuthsRef.current = {
            elevations: new Float32Array(azimuthResult.elevations),
            azimuths: new Float32Array(azimuthResult.azimuths),
            gradients: new Float32Array(azimuthResult.gradients),
            runout_zones: azimuthResult.runout_zones ? new Float32Array(azimuthResult.runout_zones) : undefined,
            width: azimuthResult.width,
            height: azimuthResult.height,
            bounds: azimuthResult.bounds,
          };

          toast.dismiss(loadingToastId);
          setAspectRaster(
            azimuthResult.azimuths,
            azimuthResult.gradients,
            azimuthResult.runout_zones,
            azimuthResult.width,
            azimuthResult.height,
            azimuthResult.bounds,
          );
        }
        
        // Use the cached copy for pathfinding
        const azimuthData = cachedAzimuthsRef.current;
        if (!azimuthData) {
          throw new Error("Azimuth data not available");
        }

        // Runout zones are computed lazily, separate from the azimuth compute.
        // If the user wants them avoided and the bundle doesn't have them yet,
        // compute them now — otherwise find_path receives an empty runout
        // array and the "Avoid Runouts" toggle silently does nothing.
        if (avoidRunoutZones && excludedAspects.length > 0 && !azimuthData.runout_zones) {
          toast.message("Computing runout zones...", {
            id: loadingToastId,
            duration: Number.POSITIVE_INFINITY,
          });
          azimuthData.runout_zones = await pathfinderService.computeRunout(
            azimuthData.elevations,
            azimuthData.azimuths,
            azimuthData.gradients,
            azimuthData.width,
            azimuthData.height,
            azimuthData.bounds,
            excludedAspects,
          );
          toast.dismiss(loadingToastId);
        }

        // Find paths - either all segments or just the last one
        // Only do last segment if:
        // 1. onlyLastSegment prop is true (caller wants incremental)
        // 2. Waypoint count increased by exactly 1 since last successful pathfind
        // 3. We have a previous successful pathfind (lastSuccessfulWaypointCountRef > 0)
        // Already computed at the top of handleClick as willOnlyDoLastSegment.
        const startSegment = willOnlyDoLastSegment ? waypoints.length - 2 : 0;
        let pathSegmentCounter = willOnlyDoLastSegment ? 1 : 0; // Start at 1 to append
        let anySegmentFailed = false;

        try {
          for (let i = startSegment; i < waypoints.length - 1; i++) {
            const pathPromise = new Promise<string>((resolve, reject) => {
            const id = `path_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 11)}`;

            const cleanup = () => {
              worker.removeEventListener("message", handler);
              worker.removeEventListener("error", onError);
            };
            const onError = (event: ErrorEvent) => {
              cleanup();
              reject(new Error(`Pathfinder worker error: ${event.message || "worker failed"}`));
            };
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
                cleanup();
                resolve(event.data.geojson as string);
              } else if (event.data.type === "error") {
                cleanup();
                reject(new Error(event.data.message as string));
              }
            };

            worker.addEventListener("message", handler);
            worker.addEventListener("error", onError);
            // Construct fresh buffers per segment so they can be transferred without
            // detaching azimuthData (which is reused for subsequent segments).
            const elevations = new Float32Array(azimuthData.elevations);
            const azimuths = new Float32Array(azimuthData.azimuths);
            const gradients = new Float32Array(azimuthData.gradients);
            const runoutZones = avoidRunoutZones && azimuthData.runout_zones
              ? new Float32Array(azimuthData.runout_zones)
              : undefined;
            const transferList: ArrayBuffer[] = [
              elevations.buffer as ArrayBuffer,
              azimuths.buffer as ArrayBuffer,
              gradients.buffer as ArrayBuffer,
            ];
            if (runoutZones) transferList.push(runoutZones.buffer as ArrayBuffer);
            worker.postMessage({
              type: "find_path",
              id,
              elevations,
              azimuths,
              gradients,
              runoutZones,
              width: azimuthData.width,
              height: azimuthData.height,
              bounds: azimuthData.bounds,
              start: waypoints[i].coordinates as [number, number],
              end: waypoints[i + 1].coordinates as [number, number],
              maxGradient,
              excludedAspects,
              aspectGradientThreshold: 0.05,
            } as WorkerRequest, transferList);
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
            setPathAspects(pathData as FeatureCollection, pathSegmentCounter);
            pathSegmentCounter++;
          } catch (segmentError) {
            const errorMessage = segmentError instanceof Error 
              ? segmentError.message 
              : String(segmentError);
              
            if (errorMessage.toLowerCase().includes("no path found")) {
              anySegmentFailed = true;
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
        
        // Track successful pathfinding waypoint count for incremental optimization.
        // A failed segment leaves a gap in the path, so the next run must do a
        // full re-pathfind rather than append onto the incomplete result.
        lastSuccessfulWaypointCountRef.current = anySegmentFailed ? 0 : waypoints.length;

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
        disabled={waypoints.length < 2 || !workerReady || isLoading}
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
