"use client";

import ElevationChart from "@/components/elevation-chart";
import GradientCdfChart from "@/components/gradient-cdf-chart";
import LazyPolylineMap from "@/components/leaflet-map-lazy";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Card, CardContent } from "@/components/ui/card";
import type { EnrichedSegment } from "@prisma/client";
import dynamic from "next/dynamic";

// Dynamic import for Leaflet component to avoid SSR issues
const GeoJSONLayer = dynamic(() => import("./leaflet-geojson-layer"), { ssr: false });

export default function SegmentDetail({
  segment,
}: {
  segment: EnrichedSegment;
}) {
  return (
    <div className="container mx-auto p-4 space-y-6">
      <Breadcrumb className="text-sm text-muted-foreground" separator="/">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/" className="hover:text-primary">
              Home
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink href="/segments" className="hover:text-primary">
              Segments
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink href="#" className="text-primary font-semibold">
              {segment.name}
            </BreadcrumbLink>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <h1 className="text-3xl font-bold">{segment.name}</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="w-full aspect-[2/1] lg:aspect-square">
          <CardContent className="h-full p-0">
            {segment.polyline && (
              <div className="h-full w-full rounded-lg overflow-hidden">
                <LazyPolylineMap>
                  <GeoJSONLayer
                    polyline={segment.polyline}
                    interactive={true}
                  />
                </LazyPolylineMap>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-rows-2 gap-6">
          <Card className="h-[350px] lg:h-full">
            <CardContent className="h-full">
              <div className="h-full">
                <ElevationChart polyline={segment.polyline} />
              </div>
            </CardContent>
          </Card>

          <Card className="h-[350px] lg:h-full">
            <CardContent className="h-full p-0">
              <div className="h-full">
                <GradientCdfChart mappables={[segment]} />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
