"use client";

import ElevationChart from "@/components/elevation-chart";
import GradientCdfChart from "@/components/gradient-cdf-chart";
import GeoJSONLayer from "@/components/leaflet-geojson-layer";
import LazyPolylineMap from "@/components/leaflet-map-lazy";
import { ViewOnStravaLink } from "@/components/strava-attribution";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Card, CardContent } from "@/components/ui/card";
import { hoverIndexStore as defaultHoverIndexStore } from "@/store";
import type { EnrichedCourse } from "@prisma/client";

export default function CourseDetail({ course }: { course: EnrichedCourse }) {
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
            <BreadcrumbLink href="/courses" className="hover:text-primary">
              Courses
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink href="#" className="text-primary font-semibold">
              {course.name}
            </BreadcrumbLink>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h1 className="text-3xl font-bold">{course.name}</h1>
        <ViewOnStravaLink 
          routeId={Number.parseInt(course.id)} 
          className="text-sm self-start sm:self-center"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="w-full aspect-[2/1] lg:aspect-square">
          <CardContent className="h-full p-0">
            {course.polyline && (
              <div className="h-full w-full rounded-lg overflow-hidden">
                <LazyPolylineMap interactive={true}>
                  <GeoJSONLayer polyline={course.polyline} interactive={true}/>
                </LazyPolylineMap>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-rows-2 gap-6">
          <Card className="h-[350px] lg:h-full">
            <CardContent className="h-full">
              <div className="h-full">
                <ElevationChart polyline={course.polyline} />
              </div>
            </CardContent>
          </Card>

          <Card className="h-[350px] lg:h-full">
            <CardContent className="h-full p-0">
              <div className="h-full">
                <GradientCdfChart mappables={[course]} />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
