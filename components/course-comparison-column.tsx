"use client";

import ElevationChart from "@/components/elevation-chart";
import LazyPolylineMap from "@/components/leaflet-map-lazy";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createHoverIndexStore } from "@/store";
import type { Mappable, MappableItem } from "@prisma/client";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";

// Dynamic import for Leaflet component to avoid SSR issues
const GeoJSONLayer = dynamic(() => import("./leaflet-geojson-layer"), { ssr: false });

type SelectedTab = "routes" | "activities";

export default function CourseComparisonColumn({
  routes,
  activities,
  selectedMap,
  handleRouteSelection,
  handleActivitySelection,
}: {
  routes: MappableItem[];
  activities: MappableItem[];
  selectedMap: Mappable | null;
  handleRouteSelection: (value: string) => void;
  handleActivitySelection: (value: string) => void;
}) {
  const hoverIndexStore = useMemo(() => createHoverIndexStore(), []);
  const [selectedTab, setSelectedTab] = useState<SelectedTab>("routes");
  const [selectedRoute, setSelectedRoute] = useState<string | undefined>(
    undefined
  );
  const [selectedActivity, setSelectedActivity] = useState<string | undefined>(
    undefined
  );

  const handleRouteChange = (value: string) => {
    setSelectedRoute(value);
    handleRouteSelection(value);
  };

  const handleActivityChange = (value: string) => {
    setSelectedActivity(value);
    handleActivitySelection(value);
  };

  const sortedRoutes = routes.sort((a, b) => a.name.localeCompare(b.name));
  const sortedActivities = activities.sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  return (
    <div className="space-y-6 p-6 bg-background border rounded-lg">
      <div className="flex items-center space-x-4">
        <Tabs
          value={selectedTab}
          onValueChange={(value) => setSelectedTab(value as SelectedTab)}
        >
          <TabsList className="flex space-x-2">
            <TabsTrigger value="routes">Routes</TabsTrigger>
            <TabsTrigger value="activities">Activities</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex-1">
          {selectedTab === "routes" ? (
            <Select onValueChange={handleRouteChange} value={selectedRoute}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose a route">
                  {selectedRoute
                    ? sortedRoutes.find((route) => route.id === selectedRoute)
                        ?.name
                    : "Choose a route"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {sortedRoutes.map((route) => (
                  <SelectItem key={route.id} value={route.id}>
                    {route.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Select
              onValueChange={handleActivityChange}
              value={selectedActivity}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose an activity">
                  {selectedActivity
                    ? sortedActivities.find(
                        (activity) => activity.id === selectedActivity
                      )?.name
                    : "Choose an activity"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {sortedActivities.map((activity) => (
                  <SelectItem key={activity.id} value={activity.id}>
                    {activity.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
      {selectedMap && (
        <div className="h-[300px] w-full mt-4">
          <LazyPolylineMap interactive={true}>
            <GeoJSONLayer
              polyline={selectedMap.polyline}
              interactive={true}
              hoverIndexStore={hoverIndexStore}
            />
          </LazyPolylineMap>
        </div>
      )}

      {selectedMap && (
        <div className="h-[400px] w-full">
          <ElevationChart
            polyline={selectedMap.polyline}
            hoverIndexStore={hoverIndexStore}
          />
        </div>
      )}
    </div>
  );
}
