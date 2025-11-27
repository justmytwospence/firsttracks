import type { Bounds } from "@/lib/dem-cache";
import { baseLogger } from "@/lib/logger";
import type { Point } from "geojson";
import L from "leaflet";
import type { LatLngExpression } from "leaflet";
import { useCallback, useEffect, useRef, useState } from "react";
import { Marker, Polyline, useMap, useMapEvents } from "react-leaflet";

interface LeafletPathfindingLayerProps {
  markers: Point[];
  markerIds?: number[];
  showLine?: boolean;
  onMapClick?: (point: Point) => void;
  onBoundsChange?: (newBounds: Bounds) => Bounds;
  onMarkerDragEnd?: (index: number, newPosition: Point) => void;
  mapCenter?: LatLngExpression;
  fitBounds?: Bounds;
  dragEndTimeRef?: React.MutableRefObject<number>;
}

// Create a custom blue circle icon to match the previous CircleMarker appearance
const createWaypointIcon = () =>
  L.divIcon({
    className: "waypoint-marker",
    html: '<div style="width: 10px; height: 10px; background-color: blue; border-radius: 50%; border: 2px solid white; box-shadow: 0 1px 3px rgba(0,0,0,0.3);"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });

export default function LeafletPathfindingLayer({
  markers,
  markerIds,
  showLine,
  onMapClick,
  onBoundsChange,
  onMarkerDragEnd,
  mapCenter,
  fitBounds,
  dragEndTimeRef,
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
      }, 350); // Delay to allow dock animation to complete
      prevFitBoundsRef.current = fitBounds;
      return () => clearTimeout(timer);
    }
  }, [map, fitBounds]);

  // Track if we're currently dragging to suppress click events
  const isDraggingRef = useRef(false);
  // Use provided dragEndTimeRef or fall back to local ref
  const localDragEndTimeRef = useRef(0);
  const effectiveDragEndTimeRef = dragEndTimeRef ?? localDragEndTimeRef;

  const mapEvents = useMapEvents({
    click(e) {
      // Don't create new waypoints if we just finished dragging (within 500ms)
      const timeSinceDragEnd = Date.now() - effectiveDragEndTimeRef.current;
      console.log('Map click event - isDragging:', isDraggingRef.current, 'timeSinceDragEnd:', timeSinceDragEnd);
      if (isDraggingRef.current || timeSinceDragEnd < 500) {
        console.log('Suppressing map click - drag in progress or just ended');
        isDraggingRef.current = false;
        return;
      }
      if (onMapClick) {
        console.log('Creating new waypoint from map click');
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

  // Memoize the waypoint icon to avoid recreating on every render
  const waypointIcon = useRef(createWaypointIcon());

  // Store Leaflet marker instances
  const leafletMarkersRef = useRef<L.Marker[]>([]);

  // Create and manage markers using native Leaflet API for reliable dragging
  useEffect(() => {
    // Remove old markers
    leafletMarkersRef.current.forEach(marker => marker.remove());
    leafletMarkersRef.current = [];

    // Create new markers
    markers.forEach((position, index) => {
      const marker = L.marker(
        [position.coordinates[1], position.coordinates[0]],
        {
          icon: waypointIcon.current,
          draggable: true,
        }
      );

      marker.on('mousedown', () => {
        console.log(`=== MOUSEDOWN on marker index=${index} ===`);
        isDraggingRef.current = true;
      });

      marker.on('dragstart', () => {
        console.log(`=== DRAG START on marker index=${index} ===`);
        isDraggingRef.current = true;
      });

      marker.on('dragend', (e: L.DragEndEvent) => {
        console.log(`=== DRAG END on marker index=${index} ===`);
        effectiveDragEndTimeRef.current = Date.now();
        
        if (onMarkerDragEnd) {
          const latlng = e.target.getLatLng();
          const newPosition: Point = {
            type: "Point",
            coordinates: [latlng.lng, latlng.lat],
          };
          setTimeout(() => {
            isDraggingRef.current = false;
            onMarkerDragEnd(index, newPosition);
          }, 10);
        }
      });

      marker.on('click', (e: L.LeafletMouseEvent) => {
        console.log(`=== CLICK on marker index=${index} ===`);
        L.DomEvent.stopPropagation(e);
      });

      marker.addTo(map);
      leafletMarkersRef.current.push(marker);
    });

    // Cleanup on unmount
    return () => {
      leafletMarkersRef.current.forEach(marker => marker.remove());
      leafletMarkersRef.current = [];
    };
  }, [markers, map, onMarkerDragEnd]);

  // Debug: log when markers or markerIds change
  useEffect(() => {
    console.log('LeafletPathfindingLayer received:');
    console.log('  markers count:', markers.length);
    console.log('  markerIds:', JSON.stringify(markerIds));
    console.log('  onMarkerDragEnd defined:', !!onMarkerDragEnd);
  }, [markers, markerIds, onMarkerDragEnd]);

  return (
    <>
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
