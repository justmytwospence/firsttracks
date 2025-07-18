import LazyPolylineMap from "@/components/leaflet-map-lazy";
import { Card } from "@/components/ui/card";
import type { Activity } from "@prisma/client";
import cn from "clsx";
import { Clock, Navigation, TrendingUp, Calendar } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";

// Dynamic import for Leaflet component to avoid SSR issues
const GeoJSONLayer = dynamic(() => import("@/components/leaflet-geojson-layer"), { ssr: false });

type ActivityCardProps = {
  activity: Activity;
  selected?: boolean;
  selectionMode?: boolean;
  onToggleSelection?: (id: string) => void;
};

function formatDuration(duration: number) {
  const hours = Math.floor(duration / 3600);
  const minutes = Math.floor((duration % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatDate(date: Date) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date);
}

export default function ActivityCard({
  activity,
  selected,
  selectionMode,
  onToggleSelection,
}: ActivityCardProps) {
  const router = useRouter();

  function handleClick(e: React.MouseEvent) {
    if (selectionMode && onToggleSelection) {
      e.preventDefault();
      onToggleSelection(activity.id);
    } else {
      router.push(`/activities/${activity.id}`);
    }
  }

  return (
    <Card
      className={cn(
        "group transition-all duration-200 rounded-lg overflow-hidden hover:cursor-pointer h-full flex flex-col bg-white",
        selected && "ring-2 ring-primary"
      )}
      onClick={handleClick}
    >
      {selectionMode && (
        <div className="absolute top-2 right-2 z-10">
          <div
            className={cn(
              "w-5 h-5 rounded-full border-2 border-white bg-background",
              selected && "bg-primary"
            )}
          />
        </div>
      )}

      <div className="relative h-48 w-full">
        <LazyPolylineMap interactive={false}>
          <GeoJSONLayer polyline={activity.summaryPolyline} interactive={false}/>
        </LazyPolylineMap>
      </div>

      <div className="flex-grow p-4 space-y-3">
        <h3 className="text-lg font-semibold line-clamp-1 group-hover:text-primary transition-colors">
          {activity.name}
        </h3>
        <div className="flex flex-wrap gap-4">
          <div className="flex items-center gap-2">
            <Navigation className="h-4 w-4 text-muted-foreground font-bold" />
            <span className="text-sm font-bold">
              {activity.distance ? (activity.distance / 1609.34).toFixed(1) : '0'}mi
            </span>
          </div>
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-muted-foreground font-bold" />
            <span className="text-sm font-bold">
              {activity.totalElevationGain ? Math.round(activity.totalElevationGain * 3.28084).toLocaleString() : '0'}ft
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground font-bold" />
            <span className="text-sm font-bold">
              {formatDuration(activity.movingTime)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-muted-foreground font-bold" />
            <span className="text-sm font-bold">
              {formatDate(activity.startDate)}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground bg-secondary px-2 py-1 rounded">
            {activity.sportType}
          </span>
        </div>
      </div>
    </Card>
  );
}