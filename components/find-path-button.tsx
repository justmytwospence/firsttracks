import { Button } from "@/components/ui/button";
import type { ExplorationNode } from "@/hooks/usePathfinder";
import { type Bounds, getDEM } from "@/lib/dem-cache";
import type { FeatureCollection, LineString, Point } from "geojson";
import { Loader } from "lucide-react";
import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

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
    gradientRaster: Uint8Array
  ) => void;
  onExplorationUpdate?: (nodes: ExplorationNode[]) => void;
  explorationBatchSize?: number;
  explorationDelayMs?: number;
  className?: string;
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
      explorationBatchSize = 125,
      explorationDelayMs = 10,
      className,
    },
    ref
  ) {
    const workerRef = useRef<Worker | null>(null);
    const [workerReady, setWorkerReady] = useState(false);
    const explorationQueueRef = useRef<ExplorationNode[][]>([]);
    const processingRef = useRef(false);
    
    // Process exploration queue with delays for smooth animation
    const processExplorationQueue = useCallback(async () => {
      if (processingRef.current) return;
      processingRef.current = true;
      
      while (explorationQueueRef.current.length > 0) {
        const batch = explorationQueueRef.current.shift();
        if (batch) {
          onExplorationUpdate?.(batch);
          if (explorationDelayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, explorationDelayMs));
          }
        }
      }
      
      processingRef.current = false;
    }, [onExplorationUpdate, explorationDelayMs]);
    
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
    
    const handleClick = useCallback(async () => {
      if (!bounds || !workerRef.current) return;
      setIsLoading(true);
      toast.dismiss();
      
      const loadingToastId = "pathfinder-loading";
      const worker = workerRef.current;
      
      try {
        // Fetch DEM data (with caching)
        toast.message("Downloading DEM from OpenTopo...", { 
          id: loadingToastId, 
          duration: Number.POSITIVE_INFINITY 
        });
        
        const demData = await getDEM(bounds, {
          onProgress: (message) => {
            toast.message(message, { id: loadingToastId, duration: Number.POSITIVE_INFINITY });
          }
        });
        
        // Compute azimuths (copy demData since postMessage can detach ArrayBuffer)
        toast.message("Computing azimuths and gradients...", { 
          id: loadingToastId, 
          duration: Number.POSITIVE_INFINITY 
        });
        
        const azimuthsPromise = new Promise<{
          elevations: Uint8Array;
          azimuths: Uint8Array;
          gradients: Uint8Array;
        }>((resolve, reject) => {
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
              });
            }
          };
          
          worker.addEventListener("message", handler);
          worker.postMessage({
            type: "compute_azimuths",
            id,
            elevationsGeotiff: new Uint8Array(demData),
          } as WorkerRequest);
        });
        
        const azimuthResult = await azimuthsPromise;
        toast.success("Azimuths and gradients computed");
        setAspectRaster(azimuthResult.azimuths, azimuthResult.gradients);
        
        // Find paths for each segment
        let pathSegmentCounter = 0;
        
        for (let i = 0; i < waypoints.length - 1; i++) {
          toast.message(`Finding path for segment ${i + 1}...`, { 
            id: loadingToastId, 
            duration: Number.POSITIVE_INFINITY 
          });
          
          const pathPromise = new Promise<string>((resolve, reject) => {
            const id = `path_${Date.now()}_${i}`;
            
            const handler = (event: MessageEvent<WorkerResponse>) => {
              if (event.data.id !== id) return;
              
              if (event.data.type === "exploration") {
                // Queue exploration updates for delayed processing
                const nodes = (event.data.nodes as [number, number][]).map(
                  ([lon, lat]) => ({
                    lon,
                    lat,
                    timestamp: Date.now(),
                  })
                );
                explorationQueueRef.current.push(nodes);
                processExplorationQueue();
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
              elevationsBuffer: new Uint8Array(demData),
              start: waypoints[i].coordinates as [number, number],
              end: waypoints[i + 1].coordinates as [number, number],
              maxGradient,
              azimuthsBuffer: new Uint8Array(azimuthResult.azimuths),
              excludedAspects,
              gradientsBuffer: new Uint8Array(azimuthResult.gradients),
              aspectGradientThreshold: 0.05,
              explorationBatchSize,
              explorationDelayMs,
            } as WorkerRequest);
          });
          
          try {
            const pathJson = await pathPromise;
            toast.dismiss(loadingToastId);
            toast.success("Path found!");
            
            const pathData = JSON.parse(pathJson);
            const path = {
              type: "LineString",
              coordinates: pathData.features.map(
                (point: { geometry: { coordinates: [number, number] } }) => 
                  point.geometry.coordinates
              ),
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
      processExplorationQueue,
      explorationBatchSize,
      explorationDelayMs,
    ]);

    return (
      <Button
        ref={ref}
        className={className || "flex-1"}
        onClick={handleClick}
        disabled={waypoints.length < 2 || !workerReady}
      >
        {isLoading ? (
          <>
            Find Path
            <Loader className="animate-spin h-4 w-4 ml-2" />
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
