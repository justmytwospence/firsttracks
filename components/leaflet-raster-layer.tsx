import type { Aspect } from "@/components/ui/select-aspects-dialog";
import GeoRasterLayer from "georaster-layer-for-leaflet";
import type GeoTIFF from "geotiff";
import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";

function containsAzimuth(aspect: Aspect, azimuth: number, tolerance = 0.0) {
  console.log(`Checking if ${aspect} contains ${azimuth}`);
  switch (aspect) {
    case "northeast":
      console.log(22.5 - tolerance <= azimuth && azimuth <= 67.5 + tolerance);
      return 22.5 - tolerance <= azimuth && azimuth <= 67.5 + tolerance;
    case "east":
      return 67.5 - tolerance <= azimuth && azimuth <= 112.5 + tolerance;
    case "southeast":
      return 112.5 - tolerance <= azimuth && azimuth <= 157.5 + tolerance;
    case "south":
      return 157.5 - tolerance <= azimuth && azimuth <= 202.5 + tolerance;
    case "southwest":
      return 202.5 - tolerance <= azimuth && azimuth <= 247.5 + tolerance;
    case "west":
      return 247.5 - tolerance <= azimuth && azimuth <= 292.5 + tolerance;
    case "northwest":
      return 292.5 - tolerance <= azimuth && azimuth <= 337.5 + tolerance;
    case "north":
      return (
        (0.0 - tolerance <= azimuth && azimuth <= 22.5 + tolerance) ||
        (337.5 - tolerance <= azimuth && azimuth <= 360.0)
      );
    case "flat":
      return azimuth === -1.0;
    default:
      return false;
  }
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
      pixelValuesToColorFn: (values) => {
        const azimuth = values[0];
        const gradient = Math.abs(values[1]);
        console.log(`Azimuth: ${azimuth}, Gradient: ${gradient}`);
        for (const excludedAspect of excludedAspects) {
          if (containsAzimuth(excludedAspect, azimuth, 2.5)) {
            return `rgba(255, 0, 0, ${Math.min(gradient * 0.4, 0.8)})`;
          }
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
