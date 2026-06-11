"use client";

import { AspectChart } from "@/components/aspect-chart";
import ElevationProfile from "@/components/elevation-chart";
import FindPathButton, { type Aspect } from "@/components/find-path-button";
import GradientCDF from "@/components/gradient-cdf-chart";
import LazyPolylineMap from "@/components/leaflet-map-lazy";
import LocationSearch from "@/components/location-search";
import { AspectSelector } from "@/components/ui/aspect-selector";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { type AzimuthData, type Bounds, cacheAzimuths, expandBounds, findCachedAzimuthBoundsContaining, getAzimuthsWithContainsCheck, getCachedIndividualTilesBounds, getCachedIndividualTilesRegions, getDEMWithContainsCheck, getFirstCachedAzimuths } from "@/lib/dem-cache";
import { pathfinderService } from "@/lib/pathfinder-service";
import { formatSlope, gradientToSlopeAngle, slopeAngleToGradient } from "@/lib/utils";
import { hoverIndexStore as defaultHoverIndexStore, slopeUnitStore } from "@/store";
import { saveAs } from "file-saver";
import type { FeatureCollection, LineString, Point } from "geojson";
import type { GeoRaster } from "georaster";
import { BarChart3, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download, HelpCircle, Mountain, RotateCcw, Route, TrendingUp, Undo2, Upload, X } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SiBuymeacoffee, SiGithub } from "react-icons/si";
import { toast } from "sonner";

const parseGeoraster = require("georaster");

// Dynamic imports for Leaflet components to avoid SSR issues
const GeoJSONLayer = dynamic(() => import("@/components/leaflet-geojson-layer"), { ssr: false });
const LeafletBoundsLayer = dynamic(() => import("@/components/leaflet-bounds-layer"), { ssr: false });
const LeafletPathfindingLayer = dynamic(() => import("@/components/leaflet-pathfinding-layer"), { ssr: false });
const LeafletRasterLayer = dynamic(() => import("@/components/leaflet-raster-layer"), { ssr: false });
const LeafletExplorationLayer = dynamic(() => import("@/components/leaflet-exploration-layer").then(mod => ({ default: mod.LeafletExplorationLayer })), { ssr: false });

// Import the handle type for the exploration layer ref
import type { ExplorationLayerHandle } from "@/components/leaflet-exploration-layer";

export default function PathFinderPage() {
  const [waypoints, setWaypoints] = useState<Point[]>([]);
  const [waypointIds, setWaypointIds] = useState<number[]>([]);
  const nextWaypointIdRef = useRef(0);
  const [path, setPath] = useState<LineString | null>(null);
  const [pathSegmentBoundaries, setPathSegmentBoundaries] = useState<number[]>([]);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [excludedAspects, setExcludedAspects] = useState<Aspect[]>([]);
  const [mapCenter, setMapCenter] = useState<[number, number] | undefined>();
  const [mapFitBounds, setMapFitBounds] = useState<Bounds | undefined>();
  const [pathAspects, setPathAspects] = useState<FeatureCollection | null>(null);
  const [aspectRaster, setAspectRaster] = useState<GeoRaster | null>(null);
  const [maxGradient, setMaxGradient] = useState<number>(0.58);  // ~30° slope angle (tan(30°))
  const [panelOpen, setPanelOpen] = useState(true);
  const [isPortrait, setIsPortrait] = useState(false);
  const [chartsDockOpen, setChartsDockOpen] = useState(true);
  const [selectedChart, setSelectedChart] = useState<"elevation" | "gradient">("elevation");
  const [showFrontier, setShowFrontier] = useState(true);
  const explorationLayerRef = useRef<ExplorationLayerHandle>(null);
  const [avoidRunoutZones, setAvoidRunoutZones] = useState(true);
  const [cachedBounds, setCachedBounds] = useState<Bounds | null>(null);
  // Visible cached-region overlay. Driven by IDB tile keys, not by per-fetch state,
  // so disjoint cached areas each render as their own merged rectangle and `Reset`
  // can't blow away the visual indicator.
  const [dataRegions, setDataRegions] = useState<Bounds[]>([]);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportFilename, setExportFilename] = useState("path");
  const [helpOpen, setHelpOpen] = useState(false);
  const [sheetPage, setSheetPage] = useState(0);
  const sheetScrollRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef<number | null>(null);
  const touchStartTime = useRef<number>(0);
  const explorationStartTimeRef = useRef<number>(0);
  const explorationCountRef = useRef<number>(0);
  
  // Store current azimuth data for recombining runout when aspects change
  const currentAzimuthDataRef = useRef<AzimuthData | null>(null);

  // Slope unit preference from store
  const useDegrees = slopeUnitStore((s) => s.useDegrees);
  const setUseDegrees = slopeUnitStore((s) => s.setUseDegrees);

  // Reference to FindPathButton's click handler for keyboard shortcut
  const findPathRef = useRef<HTMLButtonElement>(null);
  const forceFullRepathRef = useRef(false);
  // Shared drag state to prevent path click handler from firing during/after marker drag
  const markerDragEndTimeRef = useRef<number>(0);
  const lastAutoPathfindingCount = useRef<number>(0);
  const gpxInputRef = useRef<HTMLInputElement>(null);

  // Detect portrait vs landscape orientation
  useEffect(() => {
    const checkOrientation = () => {
      setIsPortrait(window.innerHeight > window.innerWidth);
    };
    
    checkOrientation();
    window.addEventListener("resize", checkOrientation);
    return () => window.removeEventListener("resize", checkOrientation);
  }, []);

  // Show help on first visit
  useEffect(() => {
    const seen = localStorage.getItem("pathfinder-help-seen");
    if (!seen) {
      setHelpOpen(true);
    }
  }, []);

  // Close help panel on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && helpOpen) {
        setHelpOpen(false);
        localStorage.setItem("pathfinder-help-seen", "true");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [helpOpen]);

  // Undo the last waypoint placement
  const handleUndo = useCallback(() => {
    if (waypoints.length === 0) return;
    
    const newWaypoints = waypoints.slice(0, -1);
    setWaypoints(newWaypoints);
    setWaypointIds(prev => prev.slice(0, -1));
    explorationLayerRef.current?.clear();
    
    // If we're going from 2+ waypoints down to 1 or 0, we need to trim the path
    if (waypoints.length >= 2 && path) {
      if (newWaypoints.length <= 1) {
        // No path possible with 0 or 1 waypoint
        setPath(null);
        setPathSegmentBoundaries([]);
        setPathAspects(null);
      } else {
        // Find where the second-to-last waypoint is in the path and trim there
        const targetWaypoint = waypoints[waypoints.length - 2]; // The waypoint we want to end at
        const [targetLon, targetLat] = targetWaypoint.coordinates as [number, number];
        
        // Find the index in path.coordinates that matches this waypoint
        // Search from the end since the waypoint should be near the end
        let trimIndex = -1;
        for (let i = path.coordinates.length - 1; i >= 0; i--) {
          const [lon, lat] = path.coordinates[i] as [number, number];
          // Check if this coordinate matches the waypoint (within small tolerance)
          if (Math.abs(lon - targetLon) < 0.0001 && Math.abs(lat - targetLat) < 0.0001) {
            trimIndex = i;
            break;
          }
        }
        
        if (trimIndex > 0) {
          // Trim the path to end at the second-to-last waypoint
          setPath({
            type: "LineString",
            coordinates: path.coordinates.slice(0, trimIndex + 1),
          });
          // Trim pathAspects to match
          if (pathAspects) {
            setPathAspects({
              type: "FeatureCollection",
              features: pathAspects.features.slice(0, trimIndex + 1),
            });
          }
          // Remove the last segment boundary (since we removed the last waypoint)
          setPathSegmentBoundaries(prev => prev.slice(0, -1));
        } else {
          // Couldn't find the waypoint in path, clear everything to be safe
          setPath(null);
          setPathSegmentBoundaries([]);
          setPathAspects(null);
        }
      }
    }
    
    // Reset the auto-pathfinding counter so it doesn't immediately re-trigger
    lastAutoPathfindingCount.current = newWaypoints.length;
  }, [waypoints, path, pathAspects]);

  // Keyboard shortcut: Cmd+Enter to find path, Cmd+Z to undo
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Leave text editing alone: intercepting undo inside an input (e.g.
      // the GPX export filename) would kill native text undo and silently
      // remove a waypoint instead.
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        findPathRef.current?.click();
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "z") {
        e.preventDefault();
        handleUndo();
      }
    };
    
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleUndo]);

  // Auto-start pathfinding when second or subsequent waypoint is placed
  useEffect(() => {
    if (waypoints.length >= 2 && !isLoading && cachedBounds && waypoints.length !== lastAutoPathfindingCount.current) {
      lastAutoPathfindingCount.current = waypoints.length;
      findPathRef.current?.click();
    }
  }, [waypoints.length, isLoading, cachedBounds]);

  // Derive pathAspects from aspectRaster for imported paths (when not already set).
  // useMemo so the heavy per-coordinate raster sampling only runs when path or raster changes.
  const derivedPathAspects = useMemo<FeatureCollection | null>(() => {
    if (!path || !aspectRaster) return null;

    const azimuthToAspect = (azimuth: number): string => {
      if (azimuth === -1 || azimuth === 255) return "flat";
      if (azimuth < 22.5) return "north";
      if (azimuth < 67.5) return "northeast";
      if (azimuth < 112.5) return "east";
      if (azimuth < 157.5) return "southeast";
      if (azimuth < 202.5) return "south";
      if (azimuth < 247.5) return "southwest";
      if (azimuth < 292.5) return "west";
      if (azimuth < 337.5) return "northwest";
      return "north";
    };

    const { xmin, ymax, pixelWidth, pixelHeight, values } = aspectRaster;
    const azimuthValues = values[0];

    const features = path.coordinates.map((coord) => {
      const [lon, lat] = coord;
      const col = Math.floor((lon - xmin) / pixelWidth);
      const row = Math.floor((ymax - lat) / Math.abs(pixelHeight));

      let aspect = "flat";
      if (row >= 0 && row < azimuthValues.length && col >= 0 && col < azimuthValues[0].length) {
        aspect = azimuthToAspect(azimuthValues[row][col]);
      }

      return {
        type: "Feature" as const,
        properties: { aspect },
        geometry: { type: "Point" as const, coordinates: coord },
      };
    });

    return { type: "FeatureCollection", features };
  }, [path, aspectRaster]);

  // Apply derivedPathAspects only if pathAspects isn't already populated by FindPathButton.
  useEffect(() => {
    if (derivedPathAspects && !pathAspects) {
      setPathAspects(derivedPathAspects);
    }
  }, [derivedPathAspects, pathAspects]);

  // Re-derive the visible cached-region rectangles from the IDB tile cache.
  // Called after any operation that may have added tiles (preload, pathfind expansion)
  // and on reset/location changes so the indicator stays in sync with what's actually cached.
  const refreshDataRegions = useCallback(async () => {
    try {
      const regions = await getCachedIndividualTilesRegions();
      setDataRegions(regions);
    } catch (err) {
      console.warn('[DataRegions] Failed to refresh:', err);
    }
  }, []);

  // Build a multi-band GeoRaster from raw Float32 typed arrays — bypasses the
  // GeoTIFF encode/decode round-trip that used to live in the worker + Rust.
  const handleSetAspectRaster = useCallback(
    async (
      azimuths: Float32Array,
      gradients: Float32Array,
      runoutZones: Float32Array | undefined,
      width: number,
      height: number,
      bounds: Bounds,
    ) => {
      // Copy arrays so the underlying buffers are stable even if callers later
      // transfer/overwrite them.
      const azimuthsCopy = new Float32Array(azimuths);
      const gradientsCopy = new Float32Array(gradients);
      const runoutCopy = runoutZones && runoutZones.length > 0 ? new Float32Array(runoutZones) : undefined;

      // Reshape each 1D row-major buffer into [row][col] using subarray views (no data copy).
      const toBand = (data: Float32Array): Float32Array[] =>
        Array.from({ length: height }, (_, row) => data.subarray(row * width, (row + 1) * width));

      const values: Float32Array[][] = [toBand(azimuthsCopy), toBand(gradientsCopy)];
      if (runoutCopy) values.push(toBand(runoutCopy));

      const metadata = {
        xmin: bounds.west,
        ymin: bounds.south,
        xmax: bounds.east,
        ymax: bounds.north,
        pixelWidth: (bounds.east - bounds.west) / width,
        pixelHeight: (bounds.north - bounds.south) / height,
        width,
        height,
        projection: 4326,
        noDataValue: -1,
      };

      const raster = (await parseGeoraster(values, metadata)) as GeoRaster;
      setAspectRaster(raster);
    },
    []
  );

  // Load cached tile bounds on mount to display blue box immediately
  useEffect(() => {
    async function loadCachedBounds() {
      try {
        console.log('[Startup] Loading cached data...');
        
        // First try individual tiles cache (new format)
        const cachedTileBounds = await getCachedIndividualTilesBounds();
        console.log('[Startup] Cached tile bounds:', cachedTileBounds);
        
        if (cachedTileBounds) {
          console.log('[Startup] Found cached tile bounds:', cachedTileBounds);
          await refreshDataRegions();
          setCachedBounds(cachedTileBounds);
          
          // Also try to load cached azimuths for the raster overlay
          const cachedAzimuths = await getAzimuthsWithContainsCheck(cachedTileBounds);
          console.log('[Startup] Cached azimuths result:', cachedAzimuths ? 'found' : 'not found');
          if (cachedAzimuths) {
            console.log('[Startup] Found cached azimuths, loading raster overlay');
            currentAzimuthDataRef.current = cachedAzimuths;
            handleSetAspectRaster(
              cachedAzimuths.azimuths,
              cachedAzimuths.gradients,
              cachedAzimuths.runout_zones,
              cachedAzimuths.width,
              cachedAzimuths.height,
              cachedAzimuths.bounds,
            );
            return; // Found everything, we're done
          }
        }
        
        // Fallback: try to get azimuths from the azimuths store directly (old format or first load)
        console.log('[Startup] Trying fallback getFirstCachedAzimuths...');
        const firstCachedAzimuths = await getFirstCachedAzimuths();
        console.log('[Startup] First cached azimuths:', firstCachedAzimuths ? 'found' : 'not found');
        if (firstCachedAzimuths?.bounds) {
          console.log('[Startup] Found cached azimuths (fallback):', firstCachedAzimuths.bounds);
          await refreshDataRegions();
          setCachedBounds(firstCachedAzimuths.bounds);
          currentAzimuthDataRef.current = firstCachedAzimuths;
          handleSetAspectRaster(
            firstCachedAzimuths.azimuths,
            firstCachedAzimuths.gradients,
            firstCachedAzimuths.runout_zones,
            firstCachedAzimuths.width,
            firstCachedAzimuths.height,
            firstCachedAzimuths.bounds,
          );
        } else {
          console.log('[Startup] No cached data found');
        }
      } catch (error) {
        console.warn('[Startup] Failed to load cached bounds:', error);
      }
    }
    
    loadCachedBounds();
  }, [handleSetAspectRaster, refreshDataRegions]);

  // Preload DEM and compute azimuths with progress toasts
  const preloadTerrainData = useCallback(async (preloadBounds: Bounds) => {
    const demToastId = "dem-download";
    const azimuthToastId = "azimuth-compute";
    
    try {
      // Check if we already have azimuths cached for these bounds
      const cachedAzimuths = await getAzimuthsWithContainsCheck(preloadBounds);
      if (cachedAzimuths) {
        console.log('[Preload] Using cached azimuths');
        currentAzimuthDataRef.current = cachedAzimuths;
        refreshDataRegions();
        handleSetAspectRaster(
          cachedAzimuths.azimuths,
          cachedAzimuths.gradients,
          cachedAzimuths.runout_zones,
          cachedAzimuths.width,
          cachedAzimuths.height,
          cachedAzimuths.bounds,
        );
        return;
      }

      // Step 1: Download DEM (with tile-level caching - only fetches missing tiles)
      toast.loading("Downloading elevation data...", { id: demToastId });
      const demGrid = await getDEMWithContainsCheck(preloadBounds);
      toast.dismiss(demToastId);

      // The fetch may have added new tiles to IDB — refresh the visible regions.
      refreshDataRegions();

      // Step 2: Compute azimuths and runout zones for all 8 aspects
      toast.loading("Computing terrain aspects & runout zones...", { id: azimuthToastId });
      const azimuthResult = await pathfinderService.computeAzimuths(demGrid, excludedAspects);
      toast.dismiss(azimuthToastId);

      // Store the full azimuth data for recombining when aspects change
      const fullAzimuthData = {
        ...azimuthResult,
        width: demGrid.width,
        height: demGrid.height,
        bounds: demGrid.bounds,
      };
      currentAzimuthDataRef.current = fullAzimuthData;

      // Cache the results using actual data bounds (not request bounds) for consistent lookup
      await cacheAzimuths(demGrid.bounds, fullAzimuthData);

      handleSetAspectRaster(
        azimuthResult.azimuths,
        azimuthResult.gradients,
        azimuthResult.runout_zones,
        fullAzimuthData.width,
        fullAzimuthData.height,
        fullAzimuthData.bounds,
      );

      console.log('[Preload] Terrain data ready');
    } catch (error) {
      toast.dismiss(demToastId);
      toast.dismiss(azimuthToastId);
      console.error('[Preload] Failed to preload terrain data:', error);
      toast.error("Failed to load terrain data");
    }
  }, [excludedAspects, handleSetAspectRaster, refreshDataRegions]);

  // Compute runout zones when aspect selection changes (lazy computation).
  // Guarded with a ref so we don't fire a worker round-trip on mount when the
  // value matches whatever the cached azimuth bundle was already computed for.
  const lastRunoutAspectsKeyRef = useRef<string | null>(null);
  useEffect(() => {
    async function computeRunout() {
      const data = currentAzimuthDataRef.current;
      if (!data?.elevations || !data?.azimuths || !data?.gradients ||
          !data.width || !data.height || !data.bounds) {
        return;
      }

      const key = [...excludedAspects].sort().join(',');
      if (lastRunoutAspectsKeyRef.current === key) return;
      lastRunoutAspectsKeyRef.current = key;

      try {
        const newRunoutZones = await pathfinderService.computeRunout(
          data.elevations,
          data.azimuths,
          data.gradients,
          data.width,
          data.height,
          data.bounds,
          excludedAspects
        );
        // If a new region's bundle replaced the ref while runout was in
        // flight, writing back would revert it to the old region's bands.
        // Drop this result and let the next toggle recompute for the new
        // bundle.
        if (currentAzimuthDataRef.current !== data) {
          lastRunoutAspectsKeyRef.current = null;
          return;
        }
        // Update the cached bundle so subsequent toggles compare against the latest runout.
        currentAzimuthDataRef.current = { ...data, runout_zones: newRunoutZones };
        handleSetAspectRaster(
          data.azimuths,
          data.gradients,
          newRunoutZones,
          data.width,
          data.height,
          data.bounds,
        );
      } catch (error) {
        console.error('[Aspect Change] Failed to compute runout:', error);
        lastRunoutAspectsKeyRef.current = null;
      }
    }

    computeRunout();
  }, [excludedAspects, handleSetAspectRaster]);

  function handleMapClick(point: Point) {
    // On first waypoint, cache expanded bounds (3x current viewport) and preload DEM + azimuths
    if (waypoints.length === 0 && bounds) {
      const expandedBounds = expandBounds(bounds, 3);
      setCachedBounds(expandedBounds);
      // Preload terrain data with progress toasts
      preloadTerrainData(expandedBounds);
    }
    setWaypoints([...waypoints, point]);
    setWaypointIds(prev => [...prev, nextWaypointIdRef.current++]);
  }

  function handleBoundsChange(newBounds: Bounds) {
    if (
      bounds &&
      bounds.north === newBounds.north &&
      bounds.south === newBounds.south &&
      bounds.east === newBounds.east &&
      bounds.west === newBounds.west
    ) {
      return newBounds;
    }
    setBounds(newBounds);
    
    // Check if we have cached azimuth data covering this view
    if (!cachedBounds) {
      findCachedAzimuthBoundsContaining(newBounds).then((foundBounds) => {
        if (foundBounds) {
          console.log('[DEM] Found cached azimuth bounds covering view:', foundBounds);
          setCachedBounds(foundBounds);
        }
      });
    }
    
    return newBounds;
  }

  function handleReset() {
    setWaypoints([]);
    setWaypointIds([]);
    setPath(null);
    setPathSegmentBoundaries([]);
    setBounds(null);
    setCachedBounds(null);
    // Don't clear dataRegions — the IDB cache itself isn't cleared on reset, so the
    // visual indicator should keep showing what's still cached. Re-derive from IDB
    // in case anything has changed.
    refreshDataRegions();
    setIsLoading(false);
    setPathAspects(null);
    setAspectRaster(null);
    explorationLayerRef.current?.clear();
    explorationStartTimeRef.current = 0;
    explorationCountRef.current = 0;
    lastAutoPathfindingCount.current = 0;
  }

  // Handle data bounds changes from FindPathButton (e.g., when terrain is expanded for out-of-bounds waypoints)
  const handleDataBoundsChange = useCallback((newBounds: Bounds) => {
    // The visual cache regions are derived from IDB; the new tiles will be picked up.
    refreshDataRegions();
    // Also update cachedBounds if the new data coverage is larger
    // This ensures subsequent pathfinding uses the expanded bounds
    setCachedBounds(prev => {
      if (!prev) return newBounds;
      const prevArea = (prev.north - prev.south) * (prev.east - prev.west);
      const newArea = (newBounds.north - newBounds.south) * (newBounds.east - newBounds.west);
      return newArea > prevArea ? newBounds : prev;
    });
  }, [refreshDataRegions]);

  // Callback for exploration updates from pathfinder
  // Uses imperative API to bypass React state for performance
  const handleExplorationUpdate = useCallback((data: {
    cells: Uint16Array;
    originX: number;
    originY: number;
    scaleX: number;
    scaleY: number;
    width: number;
    height: number;
  }) => {
    explorationCountRef.current += data.cells.length / 2;
    explorationLayerRef.current?.addCells(data);
  }, []);

  // Clear exploration nodes when starting a new pathfinding run
  const handleStartPathfinding = useCallback(() => {
    explorationLayerRef.current?.clear();
    explorationStartTimeRef.current = Date.now();
    explorationCountRef.current = 0;
    // Reset the force full repath flag
    forceFullRepathRef.current = false;
  }, []);

  // Called when exploration is done so the user sees the final state briefly
  // before the overlay clears.
  const handleExplorationComplete = useCallback(() => {
    explorationLayerRef.current?.flush();
    setTimeout(() => {
      explorationLayerRef.current?.clear();
    }, 500);
  }, []);

  const handleSetPath = useCallback(
    (newPath: LineString | null, invocationCounter: number) => {
      if (newPath === null) {
        setPath(null);
        setPathSegmentBoundaries([]);
        return;
      }

      setPath((currentPath) => {
        if (invocationCounter === 0) {
          return newPath;
        }

        return {
          type: "LineString",
          coordinates:
            currentPath === null
              ? newPath.coordinates
              : [...currentPath.coordinates, ...newPath.coordinates.slice(1)],
        } as LineString;
      });

      // Track segment boundaries (index where each segment ends)
      setPathSegmentBoundaries((currentBoundaries) => {
        if (invocationCounter === 0) {
          // First segment: boundary is at end of this segment
          return [newPath.coordinates.length - 1];
        }
        // Subsequent segments: add previous length + new segment length - 1 (for shared point)
        const previousEnd = currentBoundaries.length > 0 
          ? currentBoundaries[currentBoundaries.length - 1] 
          : 0;
        return [...currentBoundaries, previousEnd + newPath.coordinates.length - 1];
      });
    },
    []
  );

  const handleSetPathAspects = useCallback(
    (newPoints: FeatureCollection | null, invocationCounter = 0) => {
      setPathAspects((currentAspectPoints) => {
        if (newPoints === null) {
          return null;
        }

        // Mirror handleSetPath: counter 0 replaces (a fresh pathfind used to
        // append forever, duplicating aspects); appended segments drop the
        // shared first point so features stay 1:1 with path coordinates.
        if (invocationCounter === 0 || !currentAspectPoints) {
          return newPoints;
        }

        return {
          type: "FeatureCollection",
          features: [
            ...currentAspectPoints.features,
            ...newPoints.features.slice(1),
          ],
        };
      });
    },
    []
  );

  const handleLocationSelect = useCallback((center: [number, number]) => {
    // Reset everything when searching for a new location, but keep the cached-region
    // visual — the IDB cache survives, so the rectangles should too.
    setWaypoints([]);
    setWaypointIds([]);
    setPath(null);
    setPathSegmentBoundaries([]);
    setCachedBounds(null);
    refreshDataRegions();
    setPathAspects(null);
    setAspectRaster(null);
    explorationLayerRef.current?.clear();
    explorationStartTimeRef.current = 0;
    explorationCountRef.current = 0;
    lastAutoPathfindingCount.current = 0;
    setMapCenter(center);
  }, [refreshDataRegions]);

  // Handle waypoint drag end - update waypoint position and trigger full re-pathfinding
  const handleMarkerDragEnd = useCallback((index: number, newPosition: Point) => {
    setWaypoints(prev => {
      const newWaypoints = [...prev];
      newWaypoints[index] = newPosition;
      return newWaypoints;
    });

    // Clear the path and trigger re-pathfinding
    setPath(null);
    setPathSegmentBoundaries([]);
    setPathAspects(null);
    explorationLayerRef.current?.clear();

    // Force full re-pathfinding (not just last segment)
    forceFullRepathRef.current = true;

    // Trigger re-pathfinding after a small delay
    setTimeout(() => {
      findPathRef.current?.click();
    }, 100);
  }, []);

  // Handle click on path to insert a new waypoint
  const handlePathClick = useCallback((point: Point, segmentIndex: number) => {
    // Use pathSegmentBoundaries to determine which waypoint segment was clicked
    let insertAfterWaypointIndex = 0;

    if (pathSegmentBoundaries.length > 0) {
      for (let i = 0; i < pathSegmentBoundaries.length; i++) {
        if (segmentIndex <= pathSegmentBoundaries[i]) {
          insertAfterWaypointIndex = i;
          break;
        }
        insertAfterWaypointIndex = pathSegmentBoundaries.length;
      }
    }

    const newId = nextWaypointIdRef.current++;

    setWaypoints(prev => {
      const newWaypoints = [...prev];
      newWaypoints.splice(insertAfterWaypointIndex + 1, 0, point);
      lastAutoPathfindingCount.current = newWaypoints.length;
      return newWaypoints;
    });
    setWaypointIds(prev => {
      const newIds = [...prev];
      newIds.splice(insertAfterWaypointIndex + 1, 0, newId);
      return newIds;
    });
    setPathSegmentBoundaries(prev => {
      const newBoundaries = [...prev];
      // Insert the new boundary at the click position
      // This splits the segment: the new segment ends at segmentIndex
      newBoundaries.splice(insertAfterWaypointIndex, 0, segmentIndex);
      return newBoundaries;
    });
  }, [pathSegmentBoundaries]);

  const handleDownloadGpx = async () => {
    if (!path) return;

    const geojson = {
      type: "Feature",
      geometry: path,
      properties: {},
    };

    // Dynamic import to avoid SSR issues (togpx uses window)
    const togpx = (await import("togpx")).default;
    const gpxData = togpx(geojson);
    const blob = new Blob([gpxData], { type: "application/gpx+xml" });
    const filename = exportFilename.trim() || "path";
    saveAs(blob, `${filename}.gpx`);
    setExportDialogOpen(false);
  };

  const handleImportGpx = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      // Dynamic import to avoid SSR issues
      const toGeoJSON = await import("@tmcw/togeojson");
      const parser = new DOMParser();
      const gpxDoc = parser.parseFromString(text, "application/xml");
      const geoJson = toGeoJSON.gpx(gpxDoc);

      // Find the first LineString or MultiLineString in the GeoJSON
      let lineCoords: number[][] | null = null;
      for (const feature of geoJson.features) {
        if (feature.geometry.type === "LineString") {
          lineCoords = feature.geometry.coordinates as number[][];
          break;
        }
        if (feature.geometry.type === "MultiLineString") {
          // Flatten MultiLineString into a single LineString
          lineCoords = (feature.geometry.coordinates as number[][][]).flat();
          break;
        }
      }

      if (!lineCoords || lineCoords.length === 0) {
        console.warn("No track found in GPX file");
        return;
      }

      // Clear existing state
      setPathAspects(null);
      setAspectRaster(null);
      explorationLayerRef.current?.clear();
      explorationStartTimeRef.current = 0;
      explorationCountRef.current = 0;
      lastAutoPathfindingCount.current = 0;

      // Set the imported path (preserve elevation if available)
      const importedPath: LineString = {
        type: "LineString",
        coordinates: lineCoords.map(coord => 
          coord.length >= 3 ? [coord[0], coord[1], coord[2]] : [coord[0], coord[1], 0]
        ),
      };
      setPath(importedPath);
      // The imported track is a single segment between the two waypoints
      // below; stale boundaries from a previous computed path would make
      // path-clicks insert waypoints at the wrong position.
      setPathSegmentBoundaries([importedPath.coordinates.length - 1]);

      // Add waypoints at start and end so user can continue adding to the path
      const startCoord = lineCoords[0];
      const endCoord = lineCoords[lineCoords.length - 1];
      const importedWaypoints: Point[] = [
        { type: "Point", coordinates: [startCoord[0], startCoord[1]] },
        { type: "Point", coordinates: [endCoord[0], endCoord[1]] },
      ];
      setWaypoints(importedWaypoints);
      setWaypointIds([nextWaypointIdRef.current++, nextWaypointIdRef.current++]);
      // Prevent auto-pathfinding from triggering for imported waypoints
      lastAutoPathfindingCount.current = importedWaypoints.length;

      // Compute bounds from the track with some padding
      const lons = lineCoords.map(c => c[0]);
      const lats = lineCoords.map(c => c[1]);
      const minLon = Math.min(...lons);
      const maxLon = Math.max(...lons);
      const minLat = Math.min(...lats);
      const maxLat = Math.max(...lats);
      
      // Add padding (10% on each side)
      const lonPadding = (maxLon - minLon) * 0.1;
      const latPadding = (maxLat - minLat) * 0.1;
      
      const trackBounds: Bounds = {
        north: maxLat + latPadding,
        south: minLat - latPadding,
        east: maxLon + lonPadding,
        west: minLon - lonPadding,
      };
      
      // Set cached bounds to trigger azimuth preloading
      setCachedBounds(trackBounds);

      // Fit the map to the imported track bounds (with delay for dock to appear)
      setMapFitBounds(trackBounds);
    } catch (error) {
      console.error("Failed to import GPX:", error);
    }

    // Reset the input so the same file can be imported again
    event.target.value = "";
  }, []);

  // Shared panel content
  const panelContent = (
    <>
      {/* Hidden file input for GPX import - always rendered */}
      <input
        ref={gpxInputRef}
        type="file"
        accept=".gpx"
        className="hidden"
        onChange={handleImportGpx}
      />

      {/* Header - hidden in portrait */}
      {!isPortrait && (
        <div className="p-4 border-b">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold flex items-center gap-2">
              <Route className="h-5 w-5" />
              Pathfinder
            </h1>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              onClick={() => setHelpOpen(!helpOpen)}
            >
              <HelpCircle className="h-5 w-5" />
            </Button>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Plan terrain-aware routes
          </p>
        </div>
      )}

      {/* Scrollable content area */}
      <div className={`flex-1 ${isPortrait ? "overflow-hidden" : "overflow-auto"}`}>
        {isPortrait ? (
          // Portrait: Horizontal snap scrolling layout
          <div className="h-full flex flex-col overflow-hidden">
            {/* Horizontal snap scroll container */}
            <div 
              ref={sheetScrollRef}
              onScroll={() => {
                if (sheetScrollRef.current) {
                  const pageWidth = sheetScrollRef.current.offsetWidth;
                  const newPage = Math.round(sheetScrollRef.current.scrollLeft / pageWidth);
                  setSheetPage(newPage);
                }
              }}
              className="flex-1 overflow-x-auto overflow-y-hidden snap-x snap-mandatory flex scrollbar-hide touch-pan-x"
              style={{ scrollbarWidth: 'none', msOverflowStyle: 'none', overflowY: 'hidden' }}
            >
              {/* Page 1: Controls */}
              <div className="snap-center shrink-0 w-full h-full p-3 overflow-y-auto">
                <div className="flex flex-col justify-between h-full">
                {/* Top row: Search + Actions */}
                <div className="flex gap-2">
                  <div className="flex-1 min-w-0">
                    <LocationSearch onLocationSelect={handleLocationSelect} />
                  </div>
                  <Button 
                    variant="outline" 
                    onClick={handleUndo} 
                    size="icon" 
                    className="shrink-0 h-10 w-10"
                    disabled={waypoints.length === 0}
                  >
                    <Undo2 className="h-4 w-4" />
                  </Button>
                  <Button variant="outline" onClick={handleReset} size="icon" className="shrink-0 h-10 w-10" disabled={waypoints.length === 0}>
                    <RotateCcw className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="shrink-0 h-10 w-10"
                    onClick={() => gpxInputRef.current?.click()}
                  >
                    <Upload className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="shrink-0 h-10 w-10"
                    disabled={path == null}
                    onClick={() => setExportDialogOpen(true)}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                </div>

                {/* Gradient slider - full row */}
                <div className="space-y-1">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">{useDegrees ? 'Max Slope' : 'Max Gradient'}</span>
                    <span className="text-sm font-medium">{formatSlope(maxGradient, useDegrees, 0)}</span>
                  </div>
                  <Slider
                    value={[maxGradient]}
                    onValueChange={(value) => setMaxGradient(value[0])}
                    min={0.05}
                    max={2}
                    step={0.01}
                    className="w-full"
                  />
                </div>

                {/* Toggles row - compact horizontal layout */}
                <div className="flex items-center justify-between gap-3">
                  {/* Units toggle */}
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">Units</span>
                    <div className="flex rounded-md border text-xs">
                      <button
                        type="button"
                        onClick={() => setUseDegrees(false)}
                        className={`px-1.5 py-0.5 rounded-l-md transition-colors ${!useDegrees ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
                      >
                        %
                      </button>
                      <button
                        type="button"
                        onClick={() => setUseDegrees(true)}
                        className={`px-1.5 py-0.5 rounded-r-md transition-colors ${useDegrees ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
                      >
                        °
                      </button>
                    </div>
                  </div>

                  {/* Animate toggle */}
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">Animate</span>
                    <button
                      type="button"
                      onClick={() => setShowFrontier(!showFrontier)}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${showFrontier ? 'bg-blue-500' : 'bg-gray-300'}`}
                    >
                      <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${showFrontier ? 'translate-x-5' : 'translate-x-1'}`} />
                    </button>
                  </div>

                  {/* Runouts toggle */}
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">Runouts</span>
                    <button
                      type="button"
                      onClick={() => setAvoidRunoutZones(!avoidRunoutZones)}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${avoidRunoutZones ? 'bg-amber-500' : 'bg-gray-300'}`}
                    >
                      <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${avoidRunoutZones ? 'translate-x-5' : 'translate-x-1'}`} />
                    </button>
                  </div>
                </div>

                {/* Find Path button - full width */}
                <FindPathButton
                  ref={findPathRef}
                  waypoints={waypoints}
                  bounds={cachedBounds}
                  maxGradient={maxGradient}
                  excludedAspects={excludedAspects}
                  isLoading={isLoading}
                  setIsLoading={setIsLoading}
                  setPath={handleSetPath}
                  setPathAspects={handleSetPathAspects}
                  setAspectRaster={handleSetAspectRaster}
                  onExplorationUpdate={handleExplorationUpdate}
                  onExplorationComplete={handleExplorationComplete}
                  onStartPathfinding={handleStartPathfinding}
                  onDataBoundsChange={handleDataBoundsChange}
                  onlyLastSegment={path !== null && !forceFullRepathRef.current}
                  avoidRunoutZones={avoidRunoutZones}
                  className="w-full"
                />
                </div>
              </div>

              {/* Page 2: Avoid Aspects selector */}
              <div className="snap-center shrink-0 w-full h-full p-3 flex flex-col items-center justify-center">
                <span className="text-sm text-muted-foreground mb-2">Avoid Aspects</span>
                <div className="flex-1 w-full max-w-[180px] aspect-square">
                  <AspectSelector
                    selectedAspects={excludedAspects}
                    onAspectToggle={setExcludedAspects}
                  />
                </div>
              </div>

              {/* Chart pages - only when path exists */}
              {path && (
                <>
                  {/* Page 3: Elevation chart */}
                  <div className="snap-center shrink-0 w-full h-full p-3">
                    <ElevationProfile polyline={path} />
                  </div>

                  {/* Page 4: Gradient chart */}
                  <div className="snap-center shrink-0 w-full h-full p-3">
                    <GradientCDF mappables={[{ polyline: path, name: "Path", id: "path" }]} />
                  </div>

                  {/* Page 5: Aspect chart */}
                  {pathAspects && (
                    <div className="snap-center shrink-0 w-full h-full p-3 flex items-center justify-center">
                      <div className="h-full max-h-full aspect-square">
                        <AspectChart aspectPoints={pathAspects} />
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Page indicators - clickable dots */}
            <div className="flex justify-center gap-2 py-2 shrink-0">
              {(() => {
                const pages = ['controls', 'aspects', ...(path ? ['elevation', 'gradient', ...(pathAspects ? ['aspect'] : [])] : [])];
                return pages.map((pageId, i) => (
                  <button
                    key={pageId}
                    type="button"
                    onClick={() => {
                      if (sheetScrollRef.current) {
                        const pageWidth = sheetScrollRef.current.offsetWidth;
                        sheetScrollRef.current.scrollTo({ left: i * pageWidth, behavior: 'smooth' });
                      }
                    }}
                    className={`w-2 h-2 rounded-full transition-colors ${
                      sheetPage === i ? 'bg-primary' : 'bg-muted-foreground/30'
                    }`}
                  />
                ));
              })()}
            </div>
          </div>
        ) : (
          // Landscape: Original sidebar layout
          <div className="p-4 space-y-4">
            {/* Location Search */}
            <LocationSearch onLocationSelect={handleLocationSelect} />

            {/* Max Gradient */}
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-sm">{useDegrees ? 'Max Slope' : 'Max Gradient'}</span>
                <span className="text-sm font-medium">{formatSlope(maxGradient, useDegrees, 0)}</span>
              </div>
              <Slider
                value={[maxGradient]}
                onValueChange={(value) => setMaxGradient(value[0])}
                min={0.05}
                max={2}
                step={0.01}
                className="w-full"
              />
            </div>

            {/* Unit preference toggle */}
            <div className="flex items-center justify-between">
              <span className="text-sm">Units</span>
              <div className="flex rounded-md border text-xs">
                <button
                  type="button"
                  onClick={() => setUseDegrees(false)}
                  className={`px-2 py-0.5 rounded-l-md transition-colors ${!useDegrees ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
                >
                  %
                </button>
                <button
                  type="button"
                  onClick={() => setUseDegrees(true)}
                  className={`px-2 py-0.5 rounded-r-md transition-colors ${useDegrees ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
                >
                  °
                </button>
              </div>
            </div>

            {/* Algorithm animation toggle */}
            <div className="flex items-center justify-between">
              <span className="text-sm">Animate</span>
              <button
                type="button"
                onClick={() => setShowFrontier(!showFrontier)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${showFrontier ? 'bg-blue-500' : 'bg-gray-300'}`}
              >
                <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${showFrontier ? 'translate-x-5' : 'translate-x-1'}`} />
              </button>
            </div>

            {/* Avoid runout zones toggle */}
            <div className="flex items-center justify-between">
              <span className="text-sm">Avoid Runouts</span>
              <button
                type="button"
                onClick={() => setAvoidRunoutZones(!avoidRunoutZones)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${avoidRunoutZones ? 'bg-amber-500' : 'bg-gray-300'}`}
              >
                <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${avoidRunoutZones ? 'translate-x-5' : 'translate-x-1'}`} />
              </button>
            </div>

            {/* Actions */}
            <div className="space-y-2">
              <FindPathButton
                ref={findPathRef}
                waypoints={waypoints}
                bounds={cachedBounds}
                maxGradient={maxGradient}
                excludedAspects={excludedAspects}
                isLoading={isLoading}
                setIsLoading={setIsLoading}
                setPath={handleSetPath}
                setPathAspects={handleSetPathAspects}
                setAspectRaster={handleSetAspectRaster}
                onExplorationUpdate={handleExplorationUpdate}
                onExplorationComplete={handleExplorationComplete}
                onStartPathfinding={handleStartPathfinding}
                onDataBoundsChange={handleDataBoundsChange}
                onlyLastSegment={path !== null && !forceFullRepathRef.current}
                avoidRunoutZones={avoidRunoutZones}
                className="w-full"
              />
              <div className="flex gap-2">
                <Button 
                  variant="outline" 
                  onClick={handleUndo} 
                  className="flex-1" 
                  size="sm"
                  disabled={waypoints.length === 0}
                >
                  <Undo2 className="h-4 w-4 mr-1" />
                  Undo
                </Button>
                <Button variant="outline" onClick={handleReset} className="flex-1" size="sm" disabled={waypoints.length === 0}>
                  <RotateCcw className="h-4 w-4 mr-1" />
                  Reset
                </Button>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => gpxInputRef.current?.click()}
                  className="flex-1"
                >
                  <Upload className="h-4 w-4 mr-1" />
                  Import
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={path == null}
                  onClick={() => setExportDialogOpen(true)}
                  className="flex-1"
                >
                  <Download className="h-4 w-4 mr-1" />
                  Export
                </Button>
              </div>
            </div>

            {/* Avoid Aspects - inline selector */}
            <div className="space-y-2">
              <span className="text-sm">Avoid Aspects</span>
              <div className="w-full max-w-[200px] mx-auto aspect-square">
                <AspectSelector
                  selectedAspects={excludedAspects}
                  onAspectToggle={setExcludedAspects}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer - only in landscape */}
      {!isPortrait && (
        <div className="p-4 border-t text-center text-xs text-muted-foreground">
          <div>
            <span>Made by </span>
            <a 
              href="https://spencerboucher.com" 
              target="_blank" 
              rel="noopener noreferrer"
              className="underline hover:text-foreground transition-colors"
            >
              Spencer Boucher
            </a>
          </div>
          <div className="flex items-center justify-center gap-3 mt-1">
            <a 
              href="https://github.com/justmytwospence/vertfarm" 
              target="_blank" 
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 underline hover:text-foreground transition-colors"
            >
              <SiGithub className="h-3 w-3" />
              GitHub
            </a>
            <a 
              href="https://buymeacoffee.com/justmytwospence" 
              target="_blank" 
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 underline hover:text-foreground transition-colors"
            >
              <SiBuymeacoffee className="h-3 w-3" />
              Buy me a coffee
            </a>
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className={`h-screen w-screen flex overflow-hidden ${isPortrait ? "flex-col" : "flex-row"}`}>
      {/* Panel - Sidebar (landscape) or Bottom Panel (portrait) */}
      {!isPortrait ? (
        // Landscape: Left sidebar
        <div
          className={`h-full bg-background border-r flex flex-col transition-all duration-300 flex-shrink-0 ${
            panelOpen ? "w-80" : "w-0"
          } overflow-hidden`}
        >
          {panelContent}
        </div>
      ) : null}

      {/* Toggle Button - only show in landscape */}
      {!isPortrait && (
        <button
          type="button"
          onClick={() => setPanelOpen(!panelOpen)}
          className="absolute z-[1000] bg-background border rounded-full shadow-lg hover:bg-accent transition-all duration-300 p-2"
          style={{ 
            left: panelOpen ? "calc(20rem + 0.75rem)" : "0.75rem",
            bottom: path && chartsDockOpen ? "calc(280px + 0.75rem)" : "0.75rem"
          }}
        >
          {panelOpen ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
      )}

      {/* Map */}
      <div id="main-content" className="flex-1 relative flex flex-col min-h-0 min-w-0">
        {/* Map container - takes remaining space */}
        <div className="flex-1 relative min-h-0 w-full">
          {/* Help popover content - top left of map */}
          {helpOpen && (
            <div 
              className="absolute top-3 left-3 z-[1000] w-80 max-h-[calc(100%-3.5rem)] overflow-y-auto rounded-md border bg-popover p-4 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
            >
              <button
                type="button"
                onClick={() => {
                  setHelpOpen(false);
                  localStorage.setItem("pathfinder-help-seen", "true");
                }}
                className="absolute right-2 top-2 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              >
                <X className="h-4 w-4" />
                <span className="sr-only">Close</span>
              </button>
              <div className="space-y-4 pr-4">
                <div className="space-y-2">
                  <h4 className="font-medium text-sm">Getting Started</h4>
                  <ol className="list-decimal list-inside space-y-1 text-xs text-muted-foreground">
                    <li>Search for a location or pan the map</li>
                    <li>Click on the map to place waypoints</li>
                    <li>Path auto-calculates between points</li>
                  </ol>
                </div>

                <div className="space-y-2">
                  <h4 className="font-medium text-sm">Editing Routes</h4>
                  <ul className="list-disc list-inside space-y-1 text-xs text-muted-foreground">
                    <li><strong>Add:</strong> Click on the map</li>
                    <li><strong>Insert:</strong> Click on the path</li>
                    <li><strong>Move:</strong> Drag markers</li>
                    <li><strong>Undo:</strong> <kbd className="px-1 py-0.5 text-xs bg-muted rounded">⌘Z</kbd></li>
                  </ul>
                </div>

                <div className="space-y-2">
                  <h4 className="font-medium text-sm">Settings</h4>
                  <ul className="list-disc list-inside space-y-1 text-xs text-muted-foreground">
                    <li><strong>Max Gradient:</strong> Steepest slope allowed</li>
                    <li><strong>Avoid Aspects:</strong> Skip certain directions</li>
                  </ul>
                </div>

                <div className="space-y-2">
                  <h4 className="font-medium text-sm">Charts</h4>
                  <p className="text-xs text-muted-foreground">Hover on charts to highlight map sections</p>
                  <ul className="list-disc list-inside space-y-1 text-xs text-muted-foreground">
                    <li><strong>Elevation:</strong> Height profile along route</li>
                    <li><strong>Gradient:</strong> Hover to see % of route steeper than that point</li>
                    <li><strong>Aspect:</strong> Distribution of slope directions</li>
                  </ul>
                </div>

                <div className="space-y-2">
                  <h4 className="font-medium text-sm">Map Shading</h4>
                  <ul className="list-disc list-inside space-y-1 text-xs text-muted-foreground">
                    <li><span className="inline-block w-2 h-2 rounded-sm bg-red-500 mr-1" /><strong>Red:</strong> Avoided aspects (steep slopes facing selected directions)</li>
                    <li><span className="inline-block w-2 h-2 rounded-sm bg-amber-500 mr-1" /><strong>Amber:</strong> Runout zones (areas below steep avoided terrain)</li>
                  </ul>
                </div>

                <div className="space-y-2 pt-2 border-t">
                  <p className="text-xs text-muted-foreground">
                    <strong>Disclaimer:</strong> This tool is for informational purposes only. You are solely responsible for planning safe routes in the backcountry. Always assess current conditions, carry proper safety equipment, and make informed decisions based on your skill level and experience.
                  </p>
                </div>
              </div>
            </div>
          )}
          <LazyPolylineMap interactive={true}>
            <LeafletPathfindingLayer
              markers={waypoints}
              showLine={false}
              onMapClick={handleMapClick}
              onBoundsChange={handleBoundsChange}
              onMarkerDragEnd={handleMarkerDragEnd}
              mapCenter={mapCenter}
              fitBounds={mapFitBounds}
              dragEndTimeRef={markerDragEndTimeRef}
            />
            {/* Exploration visualization during pathfinding - show frontier */}
            {showFrontier && (
              <LeafletExplorationLayer
                ref={explorationLayerRef}
                color="rgba(59, 130, 246, 0.8)"
              />
            )}
            {path && bounds && (
              <GeoJSONLayer
                polyline={path}
                polylineProperties={pathAspects ?? undefined}
                interactive={true}
                hoverIndexStore={defaultHoverIndexStore}
                onPathClick={handlePathClick}
                dragEndTimeRef={markerDragEndTimeRef}
              />
            )}
            {aspectRaster && (
              <LeafletRasterLayer
                aspectRaster={aspectRaster}
                excludedAspects={excludedAspects}
                avoidRunoutZones={avoidRunoutZones}
              />
            )}
            {dataRegions.length > 0 && (
              <LeafletBoundsLayer regions={dataRegions} />
            )}
          </LazyPolylineMap>
        </div>

        {/* Bottom Charts Dock - Only in landscape when path exists */}
        {path && !isPortrait && (
          <div className="relative flex-shrink-0">
            {/* Toggle button for dock - sits on top edge of dock */}
            <button
              type="button"
              onClick={() => setChartsDockOpen(!chartsDockOpen)}
              className="absolute left-1/2 -translate-x-1/2 bottom-full z-[1000] bg-background border border-b-0 rounded-t-lg px-4 py-1 hover:bg-accent transition-colors flex items-center gap-2"
            >
              <BarChart3 className="h-4 w-4" />
              <span className="text-sm font-medium">Analysis</span>
              {chartsDockOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
            </button>

            <div
              className={`bg-background border-t transition-all duration-300 ${
                chartsDockOpen ? "h-[280px]" : "h-0"
              } overflow-hidden`}
            >
              {/* Charts content with vertical tab selector */}
              <div className="h-full flex">
                {/* Vertical tab selector */}
                <div className="flex flex-col border-r bg-muted/30">
                  <button
                    type="button"
                    onClick={() => setSelectedChart("elevation")}
                    className={`px-3 py-4 text-xs font-medium transition-colors ${
                      selectedChart === "elevation"
                        ? "bg-background text-foreground border-r-2 border-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-background/50"
                    }`}
                  >
                    <Mountain className="h-4 w-4 mx-auto mb-1" />
                    Elevation
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedChart("gradient")}
                    className={`px-3 py-4 text-xs font-medium transition-colors ${
                      selectedChart === "gradient"
                        ? "bg-background text-foreground border-r-2 border-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-background/50"
                    }`}
                  >
                    <TrendingUp className="h-4 w-4 mx-auto mb-1" />
                    Gradient
                  </button>
                </div>
                
                {/* Chart content - aspect chart on left, line chart on right */}
                <div className="flex-1 p-4 flex gap-4">
                  {/* Aspect chart - fixed square, only when pathAspects exists */}
                  {pathAspects && (
                    <div className="h-full aspect-square shrink-0">
                      <AspectChart aspectPoints={pathAspects} />
                    </div>
                  )}
                  
                  {/* Line chart - fills remaining space */}
                  <div className="flex-1 h-full min-w-0">
                    {selectedChart === "elevation" && (
                      <ElevationProfile polyline={path} />
                    )}
                    
                    {selectedChart === "gradient" && (
                      <GradientCDF
                        mappables={[{ polyline: path, name: "Path", id: "path" }]}
                      />
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Portrait: Bottom panel */}
      {isPortrait ? (
        <div className="w-full flex flex-col">
          {/* Drag handle - always visible, tappable to toggle panel, swipeable */}
          <button
            type="button"
            onClick={() => setPanelOpen(!panelOpen)}
            onTouchStart={(e) => {
              touchStartY.current = e.touches[0].clientY;
              touchStartTime.current = Date.now();
            }}
            onTouchEnd={(e) => {
              if (touchStartY.current === null) return;
              const touchEndY = e.changedTouches[0].clientY;
              const deltaY = touchStartY.current - touchEndY;
              const deltaTime = Date.now() - touchStartTime.current;
              const velocity = Math.abs(deltaY) / deltaTime;
              
              // Require minimum swipe distance (30px) or high velocity (0.3px/ms)
              const isSwipe = Math.abs(deltaY) > 30 || velocity > 0.3;
              
              if (isSwipe) {
                e.preventDefault();
                if (deltaY > 0) {
                  // Swiped up - expand
                  setPanelOpen(true);
                } else {
                  // Swiped down - collapse
                  setPanelOpen(false);
                }
              }
              touchStartY.current = null;
            }}
            className="flex justify-center py-3 w-full bg-background border-t rounded-t-xl shadow-[0_-4px_20px_rgba(0,0,0,0.1)] hover:bg-muted/30 transition-colors cursor-pointer touch-none"
          >
            <div className="w-10 h-1 bg-muted-foreground/30 rounded-full" />
          </button>
          {/* Collapsible content */}
          <div
            className={`w-full bg-background flex flex-col transition-all duration-300 ${
              panelOpen ? "h-[220px]" : "h-0"
            } overflow-hidden`}
          >
            {panelContent}
          </div>
        </div>
      ) : null}

      {/* Export GPX Dialog */}
      <Dialog open={exportDialogOpen} onOpenChange={setExportDialogOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Export GPX</DialogTitle>
            <DialogDescription>
              Enter a name for your GPX file.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="filename">Filename</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="filename"
                  value={exportFilename}
                  onChange={(e) => setExportFilename(e.target.value)}
                  placeholder="path"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleDownloadGpx();
                    }
                  }}
                />
                <span className="text-muted-foreground">.gpx</span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              <strong>Disclaimer:</strong> This tool is for informational purposes only. You are solely responsible for planning safe routes in the backcountry. Always assess current conditions, carry proper safety equipment, and make informed decisions based on your skill level and experience.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExportDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleDownloadGpx}>
              <Download className="h-4 w-4 mr-2" />
              Export
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
