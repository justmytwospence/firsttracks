"use client";

import { fetchActivity } from "@/app/actions/fetchActivity";
import { fetchActivityStreamsData } from "@/app/actions/fetchActivityStreamsData";
import LazyPolylineMap from "@/components/leaflet-map-lazy";
import { Spinner } from "@/components/ui/spinner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import PaceChart from "@/components/pace-chart";
import HeartRateChart from "@/components/heart-rate-chart";
import { useQuery } from "@tanstack/react-query";
import { Clock, Navigation, TrendingUp, Calendar, MapPin, Zap } from "lucide-react";
import dynamic from "next/dynamic";

// Dynamic import for Leaflet component to avoid SSR issues
const GeoJSONLayer = dynamic(() => import("@/components/leaflet-geojson-layer"), { ssr: false });

type ActivityDetailPageProps = {
  params: {
    activityId: string;
  };
};

function formatDuration(duration: number) {
  const hours = Math.floor(duration / 3600);
  const minutes = Math.floor((duration % 3600) / 60);
  const seconds = duration % 60;
  return hours > 0 
    ? `${hours}h ${minutes}m ${seconds}s` 
    : minutes > 0 
    ? `${minutes}m ${seconds}s`
    : `${seconds}s`;
}

function formatDate(date: Date) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
}

export default function ActivityDetailPage({ params }: ActivityDetailPageProps) {
  const { data: activity, isLoading, error } = useQuery({
    queryKey: ["activity", params.activityId],
    queryFn: () => fetchActivity(params.activityId),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });

  // Fetch activity streams for charts
  const { data: streams, isLoading: streamsLoading } = useQuery({
    queryKey: ["activity-streams", params.activityId],
    queryFn: () => fetchActivityStreamsData(params.activityId),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    enabled: !!activity, // Only fetch streams after activity is loaded
  });

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-screen">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  if (error || !activity) {
    return (
      <div className="flex justify-center items-center h-screen">
        <p className="text-red-500">Failed to load activity</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">{activity.name}</h1>
        <p className="text-muted-foreground mt-2">
          {formatDate(activity.startDate)}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Map */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Route</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-96 w-full rounded-lg overflow-hidden">
              <LazyPolylineMap interactive={true}>
                <GeoJSONLayer polyline={activity.polyline || activity.summaryPolyline} interactive={false}/>
              </LazyPolylineMap>
            </div>
          </CardContent>
        </Card>

        {/* Statistics */}
        <Card>
          <CardHeader>
            <CardTitle>Statistics</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <Navigation className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">Distance</p>
                <p className="text-lg font-semibold">
                  {activity.distance ? (activity.distance / 1609.34).toFixed(2) : '0'} miles
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Clock className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">Moving Time</p>
                <p className="text-lg font-semibold">
                  {formatDuration(activity.movingTime)}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <TrendingUp className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">Elevation Gain</p>
                <p className="text-lg font-semibold">
                  {activity.totalElevationGain ? Math.round(activity.totalElevationGain * 3.28084).toLocaleString() : '0'} ft
                </p>
              </div>
            </div>

            {activity.averageSpeed && (
              <div className="flex items-center gap-3">
                <Zap className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-sm text-muted-foreground">Average Speed</p>
                  <p className="text-lg font-semibold">
                    {(activity.averageSpeed * 2.237).toFixed(1)} mph
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Activity Details */}
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <MapPin className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">Sport Type</p>
                <p className="text-lg font-semibold">{activity.sportType}</p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Calendar className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">Date</p>
                <p className="text-lg font-semibold">
                  {formatDate(activity.startDate)}
                </p>
              </div>
            </div>

            {activity.averageWatts && (
              <div className="flex items-center gap-3">
                <Zap className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-sm text-muted-foreground">Average Watts</p>
                  <p className="text-lg font-semibold">{activity.averageWatts}W</p>
                </div>
              </div>
            )}

            {activity.description && (
              <div>
                <p className="text-sm text-muted-foreground">Description</p>
                <p className="text-sm mt-1">{activity.description}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Charts Section */}
        {streams && streams.length > 0 && (
          <>
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Pace Analysis</CardTitle>
              </CardHeader>
              <CardContent>
                {streamsLoading ? (
                  <div className="flex justify-center items-center h-64">
                    <Spinner className="h-8 w-8" />
                  </div>
                ) : (
                  <PaceChart streams={streams} />
                )}
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Heart Rate Analysis</CardTitle>
              </CardHeader>
              <CardContent>
                {streamsLoading ? (
                  <div className="flex justify-center items-center h-64">
                    <Spinner className="h-8 w-8" />
                  </div>
                ) : (
                  <HeartRateChart streams={streams} />
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}