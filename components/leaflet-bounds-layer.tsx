"use client";

import type { Bounds } from "@/lib/dem-cache";
import { Rectangle } from "react-leaflet";

interface LeafletBoundsLayerProps {
  /** One or more bounding rectangles. Each is drawn as a separate dashed outline. */
  regions: Bounds[];
}

export default function LeafletBoundsLayer({ regions }: LeafletBoundsLayerProps) {
  return (
    <>
      {regions.map((b) => (
        <Rectangle
          key={`${b.north},${b.south},${b.east},${b.west}`}
          bounds={[
            [b.south, b.west],
            [b.north, b.east],
          ]}
          pathOptions={{
            color: "#3b82f6",
            weight: 2,
            opacity: 0.6,
            fill: false,
            dashArray: "6, 6",
          }}
        />
      ))}
    </>
  );
}
