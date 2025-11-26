import type { Bounds } from "@/app/actions/findPath";
import { baseLogger } from "@/lib/logger";
import type { Point } from "geojson";
import L from "leaflet";
import type { LatLngExpression } from "leaflet";
import { useCallback, useEffect, useRef, useState } from "react";
import { CircleMarker, Polyline, useMap, useMapEvents } from "react-leaflet";

interface LeafletPathfindingLayerProps {
  markers: Point[];
  showLine?: boolean;
  onMapClick?: (point: Point) => void;
  onBoundsChange?: (newBounds: Bounds) => Bounds;
  mapCenter?: LatLngExpression;
  fitBounds?: Bounds;
}

export default function LeafletPathfindingLayer({
  markers,
  showLine,
  onMapClick,
  onBoundsChange,
  mapCenter,
  fitBounds,
}: LeafletPathfindingLayerProps) {
  const map = useMap();
  const [userLocation, setUserLocation] = useState<[number, number] | null>(
    () => {
      const savedUserLocation = localStorage.getItem("userLocation");
      if (savedUserLocation) {
        return JSON.parse(savedUserLocation);
      }
      if (navigator?.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            const location: [number, number] = [
              position.coords.latitude,
              position.coords.longitude,
            ];
            localStorage.setItem("userLocation", JSON.stringify(location));
            setUserLocation(location);
          },
          (error) => {
            // User denied permission or geolocation unavailable - not a critical error
            baseLogger.warn("Geolocation unavailable:", error.message || "Permission denied or not supported");
          }
        );
      }
      return null;
    }
  );

  const prevMapCenterRef = useRef<LatLngExpression | undefined>(mapCenter);
  const prevFitBoundsRef = useRef<Bounds | undefined>(fitBounds);

  useEffect(() => {
    // Only set view when mapCenter explicitly changes (e.g., from location search)
    // Don't set view on initial mount - let the map use its saved/default bounds
    if (mapCenter && mapCenter !== prevMapCenterRef.current) {
      map.setView(mapCenter, 13, { animate: true });
    }
    prevMapCenterRef.current = mapCenter;
  }, [map, mapCenter]);

  useEffect(() => {
    // Fit bounds when fitBounds changes (e.g., from GPX import)
    // Use a delay to allow the dock to appear and resize the map first
    if (fitBounds && fitBounds !== prevFitBoundsRef.current) {
      const timer = setTimeout(() => {
        map.invalidateSize(); // Force map to recalculate its size after dock appears
        map.fitBounds(
          [
            [fitBounds.south, fitBounds.west],
            [fitBounds.north, fitBounds.east],
          ],
          { padding: [20, 20], animate: true }
        );
      }, 150); // Delay to allow dock animation to complete
      prevFitBoundsRef.current = fitBounds;
      return () => clearTimeout(timer);
    }
  }, [map, fitBounds]);

  const mapEvents = useMapEvents({
    click(e) {
      if (onMapClick) {
        const point: Point = {
          type: "Point",
          coordinates: [e.latlng.lng, e.latlng.lat],
        };
        onMapClick(point);
      }
    },
    moveend() {
      if (onBoundsChange) {
        const bounds = map.getBounds();
        const nw = bounds.getNorthWest();
        const se = bounds.getSouthEast();
        onBoundsChange({
          north: nw.lat,
          south: se.lat,
          east: se.lng,
          west: nw.lng,
        } as Bounds);
      }
    },
  });

  // Track previous marker count (kept for potential future use)
  const prevMarkerCountRef = useRef(markers.length);

  // Update marker count ref without adjusting bounds
  useEffect(() => {
    prevMarkerCountRef.current = markers.length;
  }, [markers.length]);

  // Add initialization effect for onMapMove
  useEffect(() => {
    if (onBoundsChange) {
      const bounds = map.getBounds();
      const nw = bounds.getNorthWest();
      const se = bounds.getSouthEast();
      onBoundsChange({
        north: nw.lat,
        south: se.lat,
        east: se.lng,
        west: nw.lng,
      } as Bounds);
    }
  }, [map, onBoundsChange]);

  return (
    <>
      {markers.map((position) => (
        <CircleMarker
          key={`${position.coordinates[0]}-${position.coordinates[1]}`}
          center={[position.coordinates[1], position.coordinates[0]]}
          radius={5}
          pathOptions={{ color: "blue", fillColor: "blue", fillOpacity: 1 }}
        />
      ))}
      {showLine && (
        <Polyline
          positions={markers.map((point) => [
            point.coordinates[1],
            point.coordinates[0],
          ])}
          pathOptions={{ color: "blue", weight: 2 }}
        />
      )}
    </>
  );
}
