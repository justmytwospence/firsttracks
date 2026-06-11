import type { Bounds } from "@/lib/dem-cache";
import type { Point } from "geojson";
import L from "leaflet";
import type { LatLngExpression } from "leaflet";
import { useEffect, useRef } from "react";
import { Polyline, useMap, useMapEvents } from "react-leaflet";

interface LeafletPathfindingLayerProps {
  markers: Point[];
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
  showLine,
  onMapClick,
  onBoundsChange,
  onMarkerDragEnd,
  mapCenter,
  fitBounds,
  dragEndTimeRef,
}: LeafletPathfindingLayerProps) {
  const map = useMap();
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

  useMapEvents({
    click(e) {
      // Don't create new waypoints if we just finished dragging (within 500ms)
      const timeSinceDragEnd = Date.now() - effectiveDragEndTimeRef.current;
      if (isDraggingRef.current || timeSinceDragEnd < 500) {
        isDraggingRef.current = false;
        return;
      }
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
    for (const marker of leafletMarkersRef.current) {
      marker.remove();
    }
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
        isDraggingRef.current = true;
      });

      marker.on('dragstart', () => {
        isDraggingRef.current = true;
      });

      marker.on('dragend', (e: L.DragEndEvent) => {
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
        L.DomEvent.stopPropagation(e);
      });

      marker.addTo(map);
      leafletMarkersRef.current.push(marker);
    });

    // Cleanup on unmount
    return () => {
      for (const marker of leafletMarkersRef.current) {
        marker.remove();
      }
      leafletMarkersRef.current = [];
    };
  }, [markers, map, onMarkerDragEnd, effectiveDragEndTimeRef]);

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
