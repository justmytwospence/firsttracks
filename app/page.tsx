"use client";

import type { Bounds } from "@/app/actions/findPath";
import { AspectChart } from "@/components/aspect-chart";
import ElevationProfile from "@/components/elevation-chart";
import FindPathButton from "@/components/find-path-button";
import GradientCDF from "@/components/gradient-cdf-chart";
import LazyPolylineMap from "@/components/leaflet-map-lazy";
import LocationSearch from "@/components/location-search";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SelectAspectsDialog } from "@/components/ui/select-aspects-dialog";
import { Slider } from "@/components/ui/slider";
import type { Aspect } from "@/pathfinder";
import { hoverIndexStore as defaultHoverIndexStore } from "@/store";
import { saveAs } from "file-saver";
import type { FeatureCollection, LineString, Point } from "geojson";
import type { GeoRaster } from "georaster";
import { BarChart3, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download, MapPin, Mountain, RotateCcw, Route, TrendingUp } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

const parseGeoraster = require("georaster");

// Dynamic imports for Leaflet components to avoid SSR issues
const GeoJSONLayer = dynamic(() => import("@/components/leaflet-geojson-layer"), { ssr: false });
const LeafletPathfindingLayer = dynamic(() => import("@/components/leaflet-pathfinding-layer"), { ssr: false });
const LeafletRasterLayer = dynamic(() => import("@/components/leaflet-raster-layer"), { ssr: false });

export default function PathFinderPage() {
  const [waypoints, setWaypoints] = useState<Point[]>([]);
  const [path, setPath] = useState<LineString | null>(null);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [excludedAspects, setExcludedAspects] = useState<Aspect[]>([]);
  const [mapCenter, setMapCenter] = useState<[number, number] | undefined>();
  const [pathAspects, setPathAspects] = useState<FeatureCollection | null>(null);
  const [aspectRaster, setAspectRaster] = useState<GeoRaster | null>(null);
  const [maxGradient, setMaxGradient] = useState<number>(0.25);
  const [panelOpen, setPanelOpen] = useState(true);
  const [isPortrait, setIsPortrait] = useState(false);
  const [chartsDockOpen, setChartsDockOpen] = useState(true);
  const [selectedChart, setSelectedChart] = useState<"elevation" | "gradient">("elevation");

  // Reference to FindPathButton's click handler for keyboard shortcut
  const findPathRef = useRef<HTMLButtonElement>(null);

  // Detect portrait vs landscape orientation
  useEffect(() => {
    const checkOrientation = () => {
      setIsPortrait(window.innerHeight > window.innerWidth);
    };
    
    checkOrientation();
    window.addEventListener("resize", checkOrientation);
    return () => window.removeEventListener("resize", checkOrientation);
  }, []);

  // Keyboard shortcut: Cmd+Enter to find path
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        findPathRef.current?.click();
      }
    };
    
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  function handleMapClick(point: Point) {
    if (path !== null) {
      return;
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
    setIsLoading(false);
    setPathAspects(null);
    setAspectRaster(null);
  }

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

  // Shared panel content
  const panelContent = (
    <>
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
              <Button variant="outline" onClick={handleReset} size="icon" className="shrink-0 h-9 w-9">
                <RotateCcw className="h-4 w-4" />
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
                bounds={bounds}
                maxGradient={maxGradient}
                excludedAspects={excludedAspects}
                isLoading={isLoading}
                setIsLoading={setIsLoading}
                setPath={handleSetPath}
                setPathAspects={handleSetPathAspects}
                setAspectRaster={handleSetAspectRaster}
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
                    {/* Aspect chart - small */}
                    {pathAspects && (
                      <div className="flex items-center gap-2">
                        <div className="w-[60px] h-[60px]">
                          <AspectChart aspectPoints={pathAspects} />
                        </div>
                        <span className="text-xs text-muted-foreground">Aspect Distribution</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          // Landscape: Original sidebar layout
          <>
            {/* Location Search */}
            <div className="p-4 border-b">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-2 mb-3">
                <MapPin className="h-3 w-3" />
                Location
              </Label>
              <LocationSearch onLocationSelect={handleLocationSelect} />
            </div>

            {/* Route Settings */}
            <div className="p-4 border-b">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-2 mb-3">
                <Route className="h-3 w-3" />
                Route Settings
              </Label>
              
              <div className="space-y-4">
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

                {/* Excluded Aspects */}
                <div className="space-y-2">
                  <span className="text-sm">Excluded Aspects</span>
                  <SelectAspectsDialog
                    onSelectDirections={setExcludedAspects}
                    selectedDirections={excludedAspects}
                  />
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="p-4 space-y-2">
              <FindPathButton
                ref={findPathRef}
                waypoints={waypoints}
                bounds={bounds}
                maxGradient={maxGradient}
                excludedAspects={excludedAspects}
                isLoading={isLoading}
                setIsLoading={setIsLoading}
                setPath={handleSetPath}
                setPathAspects={handleSetPathAspects}
                setAspectRaster={handleSetAspectRaster}
                className="w-full"
              />
              <div className="flex gap-2">
                <Button variant="outline" onClick={handleReset} className="flex-1" size="sm">
                  <RotateCcw className="h-4 w-4 mr-1" />
                  Reset
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={path == null}
                  onClick={handleDownloadGpx}
                  className="flex-1"
                >
                  <Download className="h-4 w-4 mr-1" />
                  Export GPX
                </Button>
              </div>
            </div>

            {/* Aspect Chart - only show when path exists */}
            {path && pathAspects && (
              <div className="p-4 border-t">
                <Label className="text-xs font-medium text-muted-foreground mb-2 block">Aspect Distribution</Label>
                <div className="w-full aspect-square max-w-[200px] mx-auto">
                  <AspectChart aspectPoints={pathAspects} />
                </div>
              </div>
            )}
          </>
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
              showLine={path == null}
              onMapClick={handleMapClick}
              onBoundsChange={handleBoundsChange}
              mapCenter={mapCenter}
            />
            {path && bounds && pathAspects && (
              <GeoJSONLayer
                polyline={path}
                polylineProperties={pathAspects}
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
