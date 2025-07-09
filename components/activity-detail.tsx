"use client";

import GeoJSONLayer from "@/components/leaflet-geojson-layer";
import LazyPolylineMap from "@/components/leaflet-map-lazy";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Card, CardContent } from "@/components/ui/card";
import { hoverIndexStore as defaultHoverIndexStore } from "@/store";
import type { EnrichedActivity } from "@prisma/client";
import type { StreamSet } from "@/lib/strava/schemas/strava";
import ElevationChart from "./elevation-chart";
import HeartRateChart from "./heart-rate-chart";
import PaceChart from "./pace-chart";

interface ActivityDetailProps {
  activity: EnrichedActivity;
  activityStreams?: StreamSet;
}

export default function ActivityDetail({ 
  activity, 
  activityStreams 
}: ActivityDetailProps) {
  const hasHeartRateData = activityStreams?.heartrate?.data && activityStreams?.heartrate?.data.length > 0;
  const hasPaceData = activityStreams?.velocity_smooth?.data && activityStreams?.velocity_smooth?.data.length > 0;
  const hasTimeData = activityStreams?.time?.data && activityStreams?.time?.data.length > 0;

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
              {activity.name}
            </BreadcrumbLink>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex flex-col gap-4">
        <h1 className="text-3xl font-bold">{activity.name}</h1>
        <div className="flex gap-4 text-sm text-muted-foreground">
          <span>{activity.sportType}</span>
          {activity.distance && (
            <span>{(activity.distance * 0.000621371).toFixed(2)} miles</span>
          )}
          {activity.movingTime && (
            <span>{Math.floor(activity.movingTime / 60)}:{(activity.movingTime % 60).toString().padStart(2, '0')}</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Map */}
        <Card className="w-full aspect-[2/1] lg:aspect-square">
          <CardContent className="h-full p-0">
            {activity.polyline && (
              <div className="h-full w-full rounded-lg overflow-hidden">
                <LazyPolylineMap interactive={true}>
                  <GeoJSONLayer polyline={activity.polyline} interactive={true}/>
                </LazyPolylineMap>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Elevation Chart */}
        <Card className="h-[350px] lg:h-full">
          <CardContent className="h-full">
            {activity.polyline && (
              <div className="h-full">
                <ElevationChart polyline={activity.polyline} />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Pace and Heart Rate Charts */}
      {(hasPaceData || hasHeartRateData) && hasTimeData && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Pace Chart */}
          {hasPaceData && hasTimeData && (
            <Card className="h-[350px]">
              <CardContent className="h-full">
                <div className="h-full">
                  <PaceChart 
                    velocityData={activityStreams.velocity_smooth!.data}
                    timeData={activityStreams.time!.data}
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {/* Heart Rate Chart */}
          {hasHeartRateData && hasTimeData && (
            <Card className="h-[350px]">
              <CardContent className="h-full">
                <div className="h-full">
                  <HeartRateChart 
                    heartRateData={activityStreams.heartrate!.data}
                    timeData={activityStreams.time!.data}
                  />
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}