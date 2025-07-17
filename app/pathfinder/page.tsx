"use client";

import type { Bounds } from "@/app/actions/findPath";
import { AspectChart } from "@/components/aspect-chart";
import ElevationProfile from "@/components/elevation-chart";
import FindPathButton from "@/components/find-path-button";
import GradientCDF from "@/components/gradient-cdf-chart";
import LazyPolylineMap from "@/components/leaflet-map-lazy";
import LocationSearch from "@/components/location-search";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SelectAspectsDialog } from "@/components/ui/select-aspects-dialog";
import { Slider } from "@/components/ui/slider";
import type { Aspect } from "@/pathfinder";
import { hoverIndexStore as defaultHoverIndexStore } from "@/store";
import { saveAs } from "file-saver";
import type { FeatureCollection, LineString, Point } from "geojson";
import type { GeoRaster } from "georaster";
import { ChevronDown, Download } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useState } from "react";
import togpx from "togpx";

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
  const [pathAspects, setPathAspects] = useState<FeatureCollection | null>(
    null
  );
  const [aspectRaster, setAspectRaster] = useState<GeoRaster | null>(null);
  const [maxGradient, setMaxGradient] = useState<number>(0.25);

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
  }

  function handleCenter() {
    if (waypoints.length > 0) {
      setWaypoints([...waypoints]);
    }
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

  // Function to convert LineString to GPX using togpx
  const handleDownloadGpx = () => {
    if (!path) return;

    const geojson = {
      type: "Feature",
      geometry: path,
      properties: {},
    };

    const gpxData = togpx(geojson);
    const blob = new Blob([gpxData], { type: "application/gpx+xml" });
    saveAs(blob, "path.gpx");
  };

  return (
    <div className="container mx-auto p-4">
      <div className="flex gap-4 mb-4">
        <LocationSearch onLocationSelect={handleLocationSelect} />
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
        />
        <Button className="flex-1" onClick={handleReset}>
          Reset
        </Button>
        <Button className="flex-1" onClick={handleCenter}>
          Center Points
        </Button>
        <SelectAspectsDialog
          onSelectDirections={setExcludedAspects}
          selectedDirections={excludedAspects}
        />
        <Dialog>
          <DialogTrigger asChild>
            <Button className="flex-1">
              Set Max Gradient ({Math.round(maxGradient * 100)}%)
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogTitle>Set Maximum Gradient</DialogTitle>
            <DialogDescription>
              The maximum gradient to allow on the path.
            </DialogDescription>
            <Slider
              defaultValue={[0.25]}
              onValueChange={(value) => {
                setMaxGradient(value[0]);
              }}
              min={0.05}
              max={2}
              step={0.01}
            />
            <p className="mt-2">
              Current Max Gradient: {Math.round(maxGradient * 100)}%
            </p>
          </DialogContent>
        </Dialog>
        <Button
          className="flex-1"
          disabled={path == null}
          onClick={handleDownloadGpx}
        >
          Save GPX <Download className="ml-2 h-4 w-4" />
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="aspect-square">
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
        </Card>

        <Card className="p-4">
          <h2 className="text-lg font-semibold mb-2">Aspect Distribution</h2>
          {pathAspects && (
            <div className="h-[300px] flex items-center justify-center">
              <AspectChart aspectPoints={pathAspects} />
            </div>
          )}
        </Card>

        <Card className="p-4">
          <h2 className="text-lg font-semibold mb-2">Elevation Profile</h2>
          {path && (
            <div className="h-[300px]">
              <ElevationProfile polyline={path} />
            </div>
          )}
        </Card>

        <Card className="p-4">
          <h2 className="text-lg font-semibold mb-2">Gradient Distribution</h2>
          {path && (
            <div className="h-[300px]">
              <GradientCDF
                mappables={[{ polyline: path, name: "Path", id: "path" }]}
              />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
