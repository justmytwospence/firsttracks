import { computeGradient } from "@/lib/geo/geo";
import type { Aspect } from "@/pathfinder";
import type { HoverIndexStore } from "@/store";
import {
  aspectStore,
  createHoverIndexStore,
  hoverIndexStore as defaultHoverIndexStore,
  gradientStore,
} from "@/store";
import type { Feature, FeatureCollection, LineString, Point } from "geojson";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useCallback, useEffect, useRef } from "react";
import { useMap } from "react-leaflet";

type GeoJsonInteractionLayerProps = {
  polyline: LineString;
  geoJsonRef: React.RefObject<L.GeoJSON | null>;
  hoverIndexStore: HoverIndexStore;
  onPathClick?: (point: Point, segmentIndex: number) => void;
  dragEndTimeRef?: React.RefObject<number>;
};

export default function GeoJsonInteractionLayer({
  polyline,
  geoJsonRef,
  hoverIndexStore,
  onPathClick,
  dragEndTimeRef,
}: GeoJsonInteractionLayerProps) {
  const map = useMap();
  const hoverMarkerRef = useRef<L.Marker | null>(null);
  const { setHoverIndex } = hoverIndexStore();
  const { hoveredGradient } = gradientStore();
  const { hoveredAspect } = aspectStore();

  // Find the closest point on the path and corresponding segment index
  const findClosestPointOnPath = useCallback(
    (latlng: L.LatLng): { point: Point; segmentIndex: number; distance: number } | null => {
      if (polyline.coordinates.length < 2) return null;

      let minDist = Number.POSITIVE_INFINITY;
      let closestPoint: Point | null = null;
      let closestSegmentIndex = -1;

      // Check each segment of the polyline
      for (let i = 0; i < polyline.coordinates.length - 1; i++) {
        const [x1, y1] = polyline.coordinates[i];
        const [x2, y2] = polyline.coordinates[i + 1];

        // Find closest point on this line segment to the click point
        const A = latlng.lng - x1;
        const B = latlng.lat - y1;
        const C = x2 - x1;
        const D = y2 - y1;

        const dot = A * C + B * D;
        const lenSq = C * C + D * D;
        let param = -1;
        if (lenSq !== 0) param = dot / lenSq;

        let closestX: number;
        let closestY: number;

        if (param < 0) {
          closestX = x1;
          closestY = y1;
        } else if (param > 1) {
          closestX = x2;
          closestY = y2;
        } else {
          closestX = x1 + param * C;
          closestY = y1 + param * D;
        }

        const dist = L.latLng(closestY, closestX).distanceTo(latlng);
        if (dist < minDist) {
          minDist = dist;
          closestPoint = {
            type: "Point",
            coordinates: [closestX, closestY],
          };
          closestSegmentIndex = i;
        }
      }

      if (closestPoint && closestSegmentIndex >= 0) {
        return { point: closestPoint, segmentIndex: closestSegmentIndex, distance: minDist };
      }
      return null;
    },
    [polyline]
  );

  // Handle click on path
  const handlePathClick = useCallback(
    (e: L.LeafletMouseEvent) => {
      if (!onPathClick) return;

      // Don't insert waypoint if a marker was just dragged (within 500ms)
      if (dragEndTimeRef?.current) {
        const timeSinceDragEnd = Date.now() - dragEndTimeRef.current;
        if (timeSinceDragEnd < 500) {
          console.log('GeoJSON handlePathClick suppressed - marker drag just ended', timeSinceDragEnd, 'ms ago');
          return;
        }
      }

      console.log('GeoJSON handlePathClick called');
      const result = findClosestPointOnPath(e.latlng);
      if (result && result.distance < 50) {
        // Within 50 meters of the path
        console.log('Path click - inserting waypoint at segment', result.segmentIndex);
        L.DomEvent.stopPropagation(e);
        onPathClick(result.point, result.segmentIndex);
      }
    },
    [findClosestPointOnPath, onPathClick, dragEndTimeRef]
  );

  const handleMouseMove = useCallback((e: L.LeafletMouseEvent) => {
    const mousePoint = L.latLng(e.latlng.lat, e.latlng.lng);
    let minDist = Number.POSITIVE_INFINITY;
    let closestIndex = -1;

    for (let i = 0; i < polyline.coordinates.length; i++) {
      const coord = polyline.coordinates[i];
      const point = L.latLng(coord[1], coord[0]);
      const dist = mousePoint.distanceTo(point);
      if (dist < minDist) {
        minDist = dist;
        closestIndex = i;
      }
    }

    setHoverIndex(minDist < 100 ? closestIndex : -1);
  }, [polyline, setHoverIndex]);

  // Set up event listeners
  useEffect(() => {
    map.on("mousemove", handleMouseMove);
    map.on("mouseout", () => setHoverIndex(-1));
    if (onPathClick) {
      map.on("click", handlePathClick);
    }

    // Cleanup event listeners
    return () => {
      map.off("mousemove", handleMouseMove);
      map.off("mouseout");
      map.off("click", handlePathClick);
    };
  }, [map, handleMouseMove, handlePathClick, onPathClick, setHoverIndex]);

  // respond to hoverIndex
  const updateHoverPoint = useCallback(
    (index: number) => {
      if (index < 0 || !polyline.coordinates[index]) {
        hoverMarkerRef.current?.remove();
        hoverMarkerRef.current = null;
        return;
      }

      const point = polyline.coordinates[index];
      if (!hoverMarkerRef.current) {
        hoverMarkerRef.current = L.marker([point[1], point[0]], {
          icon: L.divIcon({
            className: "hover-marker",
            html: '<div class="marker-inner"></div>',
            iconSize: [12, 12],
            iconAnchor: [6, 6],
          }),
        }).addTo(map);
      } else {
        hoverMarkerRef.current.setLatLng([point[1], point[0]]);
      }
    },
    [map, polyline]
  );

  // hoverIndex useEffect
  useEffect(() => {
    const unsub = hoverIndexStore.subscribe((state) => {
      updateHoverPoint(state.hoverIndex);
    });
    return unsub;
  }, [updateHoverPoint, hoverIndexStore]);

  // respond to hoveredGradient
  const highlightGradients = useCallback((hoveredGradient: number | null) => {
    if (geoJsonRef.current) {
      geoJsonRef.current.setStyle((feature) => ({
        color:
          feature?.properties?.gradient >= (hoveredGradient ?? 0)
            ? "orange"
            : "black",
        weight: 3,
        opacity: 1,
      }));
    }
  }, [geoJsonRef]);

  // hoveredGradient useEffect
  useEffect(() => {
    const unsub = gradientStore.subscribe(
      (state) => state.hoveredGradient,
      (hoveredGradient) => {
        highlightGradients(hoveredGradient);
      }
    );
    return unsub;
  }, [highlightGradients]);

  // respond to hoveredAspect
  const highlightAspect = useCallback((hoveredAspect: Aspect | null) => {
    if (geoJsonRef.current) {
      geoJsonRef.current.setStyle((feature) => ({
        color:
          feature?.properties?.aspect as Aspect === (hoveredAspect ?? 0)
            ? "orange"
            : "black",
        weight: 3,
        opacity: 1,
      }));
    }
  }, [geoJsonRef]);

  // hoveredAspect useEffect
  useEffect(() => {
    const unsub = aspectStore.subscribe(
      (state) => state.hoveredAspect,
      (hoveredAspect) => {
        highlightAspect(hoveredAspect);
      }
    );
    return unsub;
  }, [highlightAspect]);

  return null;
}
