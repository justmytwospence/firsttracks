import type { Aspect } from "@/components/ui/select-aspects-dialog";
import GeoRasterLayer from "georaster-layer-for-leaflet";
import type GeoTIFF from "geotiff";
import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";

// Returns a value from 0 to 1 indicating how strongly the azimuth falls within the aspect
// 0 = not in aspect at all, 1 = fully in the center of the aspect
function getAspectIntensity(aspect: Aspect, azimuth: number): number {
  const ASPECT_WIDTH = 45; // degrees for each aspect (360/8)
  const HALF_WIDTH = ASPECT_WIDTH / 2;
  
  // Get the center azimuth for each aspect
  const aspectCenters: Record<string, number> = {
    north: 0,
    northeast: 45,
    east: 90,
    southeast: 135,
    south: 180,
    southwest: 225,
    west: 270,
    northwest: 315,
  };
  
  if (aspect === "flat") {
    return azimuth === -1.0 ? 1.0 : 0.0;
  }
  
  const center = aspectCenters[aspect];
  if (center === undefined) return 0;
  
  // Calculate angular distance, handling wraparound for north
  let distance = Math.abs(azimuth - center);
  if (distance > 180) {
    distance = 360 - distance;
  }
  
  // If within the aspect range, return intensity based on distance from center
  // Using a smooth falloff that reaches 0 at the boundaries
  if (distance <= HALF_WIDTH + 10) { // Add soft transition zone of 10 degrees
    // Smooth cosine falloff for natural blending
    const normalizedDistance = distance / (HALF_WIDTH + 10);
    return Math.max(0, Math.cos(normalizedDistance * Math.PI / 2));
  }
  
  return 0;
}

interface LeafletRasterLayerProps {
  aspectRaster: GeoTIFF;
  excludedAspects: Aspect[];
}

export default function LeafletRasterLayer({
  aspectRaster,
  excludedAspects,
}: LeafletRasterLayerProps) {
  const map = useMap();
  const geoRasterLayerRef = useRef<GeoRasterLayer | null>(null);

  useEffect(() => {
    geoRasterLayerRef.current = new GeoRasterLayer({
      georaster: aspectRaster,
      resolution: 512,
      updateWhenZooming: false,
      pixelValuesToColorFn: (values) => {
        const azimuth = values[0];
        const gradient = Math.abs(values[1]);
        
        // Calculate the maximum intensity across all excluded aspects
        let maxIntensity = 0;
        for (const excludedAspect of excludedAspects) {
          const intensity = getAspectIntensity(excludedAspect, azimuth);
          maxIntensity = Math.max(maxIntensity, intensity);
        }
        
        if (maxIntensity > 0) {
          // Apply gradient-based opacity with smooth falloff from aspect boundaries
          const baseOpacity = Math.min(gradient * 0.4, 0.8);
          const opacity = baseOpacity * maxIntensity;
          return `rgba(255, 0, 0, ${opacity})`;
        }
        return "transparent";
      },
    });

    geoRasterLayerRef.current.addTo(map);

    return () => {
      geoRasterLayerRef.current?.remove();
    };
  }, [aspectRaster, excludedAspects, map]);

  return null;
}
