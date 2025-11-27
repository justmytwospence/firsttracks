"use client";

import type { Bounds } from "@/lib/dem-cache";
import { Rectangle } from "react-leaflet";

interface LeafletBoundsLayerProps {
  bounds: Bounds;
}

export default function LeafletBoundsLayer({ bounds }: LeafletBoundsLayerProps) {
  const leafletBounds: [[number, number], [number, number]] = [
    [bounds.south, bounds.west],
    [bounds.north, bounds.east],
  ];

  return (
    <Rectangle
      bounds={leafletBounds}
      pathOptions={{
        color: "#3b82f6",
        weight: 2,
        opacity: 0.6,
        fill: true,
        fillColor: "#3b82f6",
        fillOpacity: 0.05,
        dashArray: "6, 6",
      }}
    />
  );
}
