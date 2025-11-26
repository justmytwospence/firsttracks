"use client";

import { AspectChart } from "@/components/aspect-chart";
import ElevationProfile from "@/components/elevation-chart";
import FindPathButton, { type Aspect } from "@/components/find-path-button";
import GradientCDF from "@/components/gradient-cdf-chart";
import LazyPolylineMap from "@/components/leaflet-map-lazy";
import LocationSearch from "@/components/location-search";
import { Button } from "@/components/ui/button";
import { SelectAspectsDialog } from "@/components/ui/select-aspects-dialog";
import { Slider } from "@/components/ui/slider";
import type { ExplorationNode } from "@/hooks/usePathfinder";
import { type Bounds, preloadDEM } from "@/lib/dem-cache";
import { hoverIndexStore as defaultHoverIndexStore } from "@/store";
import { saveAs } from "file-saver";
import type { FeatureCollection, LineString, Point } from "geojson";
import type { GeoRaster } from "georaster";
import { BarChart3, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download, Mountain, RotateCcw, Route, TrendingUp, Undo2, Upload } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

const parseGeoraster = require("georaster");

// Dynamic imports for Leaflet components to avoid SSR issues
const GeoJSONLayer = dynamic(() => import("@/components/leaflet-geojson-layer"), { ssr: false });
const LeafletPathfindingLayer = dynamic(() => import("@/components/leaflet-pathfinding-layer"), { ssr: false });
const LeafletRasterLayer = dynamic(() => import("@/components/leaflet-raster-layer"), { ssr: false });
const LeafletExplorationLayer = dynamic(() => import("@/components/leaflet-exploration-layer").then(mod => ({ default: mod.LeafletExplorationLayer })), { ssr: false });

export default function PathFinderPage() {
  const [waypoints, setWaypoints] = useState<Point[]>([]);
  const [path, setPath] = useState<LineString | null>(null);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [excludedAspects, setExcludedAspects] = useState<Aspect[]>([]);
  const [mapCenter, setMapCenter] = useState<[number, number] | undefined>();
  const [mapFitBounds, setMapFitBounds] = useState<Bounds | undefined>();
  const [pathAspects, setPathAspects] = useState<FeatureCollection | null>(null);
  const [aspectRaster, setAspectRaster] = useState<GeoRaster | null>(null);
  const [maxGradient, setMaxGradient] = useState<number>(0.25);
  const [panelOpen, setPanelOpen] = useState(true);
  const [isPortrait, setIsPortrait] = useState(false);
  const [chartsDockOpen, setChartsDockOpen] = useState(true);
  const [selectedChart, setSelectedChart] = useState<"elevation" | "gradient">("elevation");
  const [explorationNodes, setExplorationNodes] = useState<ExplorationNode[]>([]);
  const [cachedBounds, setCachedBounds] = useState<Bounds | null>(null);
  const explorationStartTimeRef = useRef<number>(0);
  const explorationCountRef = useRef<number>(0);

  // Reference to FindPathButton's click handler for keyboard shortcut
  const findPathRef = useRef<HTMLButtonElement>(null);
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

  // Undo the last waypoint placement
  const handleUndo = useCallback(() => {
    if (waypoints.length === 0) return;
    
    const newWaypoints = waypoints.slice(0, -1);
    setWaypoints(newWaypoints);
    setExplorationNodes([]);
    
    // If we're going from 2+ waypoints down to 1 or 0, we need to trim the path
    if (waypoints.length >= 2 && path) {
      if (newWaypoints.length <= 1) {
        // No path possible with 0 or 1 waypoint
        setPath(null);
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
        } else {
          // Couldn't find the waypoint in path, clear everything to be safe
          setPath(null);
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
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        findPathRef.current?.click();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
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
      // Small delay to let the UI update first
      const timer = setTimeout(() => {
        findPathRef.current?.click();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [waypoints.length, isLoading, cachedBounds]);

  // Compute pathAspects from aspectRaster for imported paths (when pathAspects isn't already set)
  useEffect(() => {
    if (path && aspectRaster && !pathAspects) {
      // Helper to convert azimuth value (0-360) to aspect string
      // Must match the capitalized format expected by AspectChart
      const azimuthToAspect = (azimuth: number): string => {
        if (azimuth === -1 || azimuth === 255) return "Flat"; // NoData values
        if (azimuth < 22.5) return "North";
        if (azimuth < 67.5) return "Northeast";
        if (azimuth < 112.5) return "East";
        if (azimuth < 157.5) return "Southeast";
        if (azimuth < 202.5) return "South";
        if (azimuth < 247.5) return "Southwest";
        if (azimuth < 292.5) return "West";
        if (azimuth < 337.5) return "Northwest";
        return "North";
      };

      // Look up aspect for each coordinate from the raster
      const { xmin, ymax, pixelWidth, pixelHeight, values } = aspectRaster;
      const azimuthValues = values[0]; // First band is azimuths
      
      const features = path.coordinates.map((coord) => {
        const [lon, lat] = coord;
        
        // Convert geographic coordinates to pixel coordinates
        const col = Math.floor((lon - xmin) / pixelWidth);
        const row = Math.floor((ymax - lat) / Math.abs(pixelHeight));
        
        // Get azimuth value from raster (with bounds checking)
        let aspect = "Flat";
        if (row >= 0 && row < azimuthValues.length && col >= 0 && col < azimuthValues[0].length) {
          const azimuthValue = azimuthValues[row][col];
          aspect = azimuthToAspect(azimuthValue);
        }
        
        return {
          type: "Feature" as const,
          properties: { aspect },
          geometry: {
            type: "Point" as const,
            coordinates: coord,
          },
        };
      });

      setPathAspects({
        type: "FeatureCollection",
        features,
      });
    }
  }, [path, aspectRaster, pathAspects]);

  function handleMapClick(point: Point) {
    // On first waypoint, cache expanded bounds (3x current viewport) and preload DEM
    if (waypoints.length === 0 && bounds) {
      const latSpan = bounds.north - bounds.south;
      const lngSpan = bounds.east - bounds.west;
      const expandedBounds: Bounds = {
        north: bounds.north + latSpan,
        south: bounds.south - latSpan,
        east: bounds.east + lngSpan,
        west: bounds.west - lngSpan,
      };
      setCachedBounds(expandedBounds);
      // Preload DEM to IndexedDB in the background
      preloadDEM(bounds, { expansionFactor: 3 }).catch(console.warn);
    }
    setWaypoints([...waypoints, point]);
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
    return newBounds;
  }

  function handleReset() {
    setWaypoints([]);
    setPath(null);
    setBounds(null);
    setCachedBounds(null);
    setIsLoading(false);
    setPathAspects(null);
    setAspectRaster(null);
    setExplorationNodes([]);
    explorationStartTimeRef.current = 0;
    explorationCountRef.current = 0;
    lastAutoPathfindingCount.current = 0;
  }

  // Callback for exploration updates from pathfinder
  // Only show frontier (current batch), not accumulated nodes
  const handleExplorationUpdate = useCallback((nodes: ExplorationNode[]) => {
    explorationCountRef.current += nodes.length;
    // Replace with just the frontier nodes (current batch)
    setExplorationNodes(nodes);
  }, []);

  // Clear exploration nodes when starting a new pathfinding run
  const handleStartPathfinding = useCallback(() => {
    setExplorationNodes([]);
    explorationStartTimeRef.current = Date.now();
    explorationCountRef.current = 0;
  }, []);

  // Called when exploration queue is fully processed
  const handleExplorationComplete = useCallback(() => {
    // Clear the frontier visualization after animation completes
    setExplorationNodes([]);
  }, []);

  const handleSetPath = useCallback(
    (newPath: LineString | null, invocationCounter: number) => {
      setPath((currentPath) => {
        if (newPath === null) {
          return null;
        }

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
    },
    []
  );

  const handleSetPathAspects = useCallback(
    (newPoints: FeatureCollection | null) => {
      setPathAspects((currentAspectPoints) => {
        if (newPoints === null) {
          return null;
        }

        const combinedPoints: FeatureCollection = {
          type: "FeatureCollection",
          features: [
            ...(currentAspectPoints?.features || []),
            ...newPoints.features,
          ],
        };

        return combinedPoints;
      });
    },
    []
  );

  const handleLocationSelect = useCallback((center: [number, number]) => {
    // Reset everything when searching for a new location
    setWaypoints([]);
    setPath(null);
    setCachedBounds(null);
    setPathAspects(null);
    setAspectRaster(null);
    setExplorationNodes([]);
    explorationStartTimeRef.current = 0;
    explorationCountRef.current = 0;
    lastAutoPathfindingCount.current = 0;
    setMapCenter(center);
  }, []);

  const handleSetAspectRaster = useCallback(
    async (azimuths: Uint8Array, gradients: Uint8Array) => {
      const azimuthRaster = (await parseGeoraster(
        azimuths.buffer as ArrayBuffer
      )) as GeoRaster;

      const gradientRaster = (await parseGeoraster(
        gradients.buffer as ArrayBuffer
      )) as GeoRaster;

      const mergedRaster = [azimuthRaster, gradientRaster].reduce(
        (result, georaster) => ({
          ...georaster,
          maxs: [...result.maxs, ...georaster.maxs],
          mins: [...result.mins, ...georaster.mins],
          ranges: [...result.ranges, georaster.ranges],
          values: [...result.values, ...georaster.values],
          numberOfRasters: result.values.length + georaster.values.length,
        })
      );
      setAspectRaster(mergedRaster as GeoRaster);
    },
    []
  );

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
    saveAs(blob, "path.gpx");
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
        } else if (feature.geometry.type === "MultiLineString") {
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
      setExplorationNodes([]);
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

      // Add waypoints at start and end so user can continue adding to the path
      const startCoord = lineCoords[0];
      const endCoord = lineCoords[lineCoords.length - 1];
      const importedWaypoints: Point[] = [
        { type: "Point", coordinates: [startCoord[0], startCoord[1]] },
        { type: "Point", coordinates: [endCoord[0], endCoord[1]] },
      ];
      setWaypoints(importedWaypoints);
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
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Route className="h-5 w-5" />
            Pathfinder
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Plan terrain-aware routes
          </p>
        </div>
      )}

      {/* Scrollable content area */}
      <div className={`flex-1 overflow-auto ${isPortrait ? "p-3" : ""}`}>
        {isPortrait ? (
          // Portrait: Compact mobile layout
          <div className="space-y-2">
            {/* Top row: Search + Actions */}
            <div className="flex gap-2">
              <div className="flex-1 min-w-0">
                <LocationSearch onLocationSelect={handleLocationSelect} />
              </div>
              <Button 
                variant="outline" 
                onClick={handleUndo} 
                size="icon" 
                className="shrink-0 h-9 w-9"
                disabled={waypoints.length === 0}
              >
                <Undo2 className="h-4 w-4" />
              </Button>
              <Button variant="outline" onClick={handleReset} size="icon" className="shrink-0 h-9 w-9" disabled={waypoints.length === 0}>
                <RotateCcw className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="shrink-0 h-9 w-9"
                onClick={() => gpxInputRef.current?.click()}
              >
                <Upload className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="shrink-0 h-9 w-9"
                disabled={path == null}
                onClick={handleDownloadGpx}
              >
                <Download className="h-4 w-4" />
              </Button>
            </div>

            {/* Gradient slider - full row */}
            <div className="space-y-1">
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted-foreground">Max Gradient</span>
                <span className="text-xs font-medium">{Math.round(maxGradient * 100)}%</span>
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

            {/* Find Path + Aspects buttons */}
            <div className="flex gap-2">
              <FindPathButton
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
                onlyLastSegment={path !== null}
                preloadBounds={cachedBounds}
                className="flex-1"
              />
              <SelectAspectsDialog
                onSelectDirections={setExcludedAspects}
                selectedDirections={excludedAspects}
              />
            </div>

            {/* Charts dock for portrait - collapsible above controls */}
            {path && (
              <div className="border rounded-lg overflow-hidden">
                <button
                  type="button"
                  onClick={() => setChartsDockOpen(!chartsDockOpen)}
                  className="w-full px-3 py-2 flex items-center justify-between bg-muted/30 hover:bg-muted/50 transition-colors"
                >
                  <span className="text-xs font-medium flex items-center gap-2">
                    <BarChart3 className="h-3 w-3" />
                    Analysis
                  </span>
                  {chartsDockOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </button>
                {chartsDockOpen && (
                  <div className="p-2 space-y-2">
                    {/* Chart selector */}
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => setSelectedChart("elevation")}
                        className={`flex-1 px-2 py-1 text-xs rounded transition-colors ${
                          selectedChart === "elevation"
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted hover:bg-muted/80"
                        }`}
                      >
                        Elevation
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedChart("gradient")}
                        className={`flex-1 px-2 py-1 text-xs rounded transition-colors ${
                          selectedChart === "gradient"
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted hover:bg-muted/80"
                        }`}
                      >
                        Gradient
                      </button>
                    </div>
                    {/* Chart content */}
                    <div className="h-[100px]">
                      {selectedChart === "elevation" && <ElevationProfile polyline={path} />}
                      {selectedChart === "gradient" && (
                        <GradientCDF mappables={[{ polyline: path, name: "Path", id: "path" }]} />
                      )}
                    </div>
                    {/* Aspect chart - full width square */}
                    {pathAspects && (
                      <div className="w-full aspect-square">
                        <AspectChart aspectPoints={pathAspects} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          // Landscape: Original sidebar layout
          <div className="p-4 space-y-4">
            {/* Location Search */}
            <LocationSearch onLocationSelect={handleLocationSelect} />

            {/* Max Gradient */}
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-sm">Max Gradient</span>
                <span className="text-sm font-medium">{Math.round(maxGradient * 100)}%</span>
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
                onlyLastSegment={path !== null}
                preloadBounds={cachedBounds}
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
                  onClick={handleDownloadGpx}
                  className="flex-1"
                >
                  <Download className="h-4 w-4 mr-1" />
                  Export
                </Button>
              </div>
            </div>

            {/* Excluded Aspects - above aspect chart */}
            <SelectAspectsDialog
              onSelectDirections={setExcludedAspects}
              selectedDirections={excludedAspects}
            />

            {/* Aspect Chart - only show when path exists */}
            {path && pathAspects && (
              <div className="w-full aspect-square">
                <AspectChart aspectPoints={pathAspects} />
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );

  return (
    <div className={`h-screen w-screen flex ${isPortrait ? "flex-col" : "flex-row"}`}>
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

      {/* Toggle Button */}
      <button
        type="button"
        onClick={() => setPanelOpen(!panelOpen)}
        className={`absolute z-[1000] bg-background border rounded-full shadow-lg hover:bg-accent transition-all duration-300 ${
          isPortrait
            ? "left-1/2 -translate-x-1/2 p-3"
            : "top-4 p-2"
        }`}
        style={
          isPortrait
            ? { bottom: panelOpen ? "calc(min(200px, 35vh) + 0.75rem)" : "0.75rem" }
            : { left: panelOpen ? "calc(20rem + 0.5rem)" : "0.5rem" }
        }
      >
        {isPortrait ? (
          panelOpen ? <ChevronDown className="h-5 w-5" /> : <ChevronUp className="h-5 w-5" />
        ) : (
          panelOpen ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />
        )}
      </button>

      {/* Map */}
      <div className="flex-1 relative flex flex-col min-h-0 min-w-0">
        {/* Map container - takes remaining space */}
        <div className="flex-1 relative min-h-0 w-full">
          <LazyPolylineMap interactive={true}>
            <LeafletPathfindingLayer
              markers={waypoints}
              showLine={false}
              onMapClick={handleMapClick}
              onBoundsChange={handleBoundsChange}
              mapCenter={mapCenter}
              fitBounds={mapFitBounds}
            />
            {/* Exploration visualization during pathfinding - show frontier */}
            {explorationNodes.length > 0 && (
              <LeafletExplorationLayer
                nodes={explorationNodes}
                fadeOutDuration={0}
                persistDuration={100000}
                radius={3}
                color="rgba(59, 130, 246, 0.8)"
              />
            )}
            {path && bounds && (
              <GeoJSONLayer
                polyline={path}
                polylineProperties={pathAspects ?? undefined}
                interactive={true}
                hoverIndexStore={defaultHoverIndexStore}
              />
            )}
            {aspectRaster && (
              <LeafletRasterLayer
                aspectRaster={aspectRaster}
                excludedAspects={excludedAspects}
              />
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
                
                {/* Chart content */}
                <div className="flex-1 p-4">
                  {selectedChart === "elevation" && (
                    <div className="h-full">
                      <ElevationProfile polyline={path} />
                    </div>
                  )}
                  
                  {selectedChart === "gradient" && (
                    <div className="h-full">
                      <GradientCDF
                        mappables={[{ polyline: path, name: "Path", id: "path" }]}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Portrait: Bottom panel */}
      {isPortrait ? (
        <div
          className={`w-full bg-background border-t rounded-t-xl shadow-[0_-4px_20px_rgba(0,0,0,0.1)] flex flex-col transition-all duration-300 ${
            panelOpen ? "h-[min(200px,35vh)]" : "h-0"
          } overflow-hidden`}
        >
          {/* Drag handle indicator */}
          <div className="flex justify-center py-2">
            <div className="w-10 h-1 bg-muted-foreground/30 rounded-full" />
          </div>
          {panelContent}
        </div>
      ) : null}
    </div>
  );
}
