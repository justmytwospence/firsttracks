import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Activity } from "@prisma/client";
import { Clock, Navigation, TrendingUp } from "lucide-react";
import { useRouter } from "next/navigation";

type ActivityTableProps = {
  activities: Activity[];
  sortBy: string;
  sortDir: "asc" | "desc";
  selectionMode?: boolean;
  selectedIds?: string[];
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

// Simple elevation sparkline component using SVG
function ElevationSparkline({ activity }: { activity: Activity }) {
  if (!activity.summaryPolyline) {
    return <span className="text-muted-foreground text-xs">No elevation data</span>;
  }
  
  // For now, we'll show a placeholder since we don't have the elevation points from the polyline
  // This would need actual elevation data parsing from the polyline
  return (
    <svg width="60" height="20" viewBox="0 0 60 20" className="stroke-primary stroke-1 fill-none">
      <polyline points="0,15 15,10 30,8 45,12 60,5" />
    </svg>
  );
}

export default function ActivityTable({
  activities,
  sortBy,
  sortDir,
  selectionMode,
  selectedIds = [],
  onToggleSelection,
}: ActivityTableProps) {
  const router = useRouter();

  const sortedActivities = [...activities].sort((a, b) => {
    let aValue = a[sortBy as keyof Activity];
    let bValue = b[sortBy as keyof Activity];
    
    // Handle date sorting specifically
    if (sortBy === 'startDate' && aValue instanceof Date && bValue instanceof Date) {
      switch (sortDir) {
        case "asc":
          return aValue.getTime() - bValue.getTime();
        case "desc":
          return bValue.getTime() - aValue.getTime();
      }
    }
    
    // Handle other types
    switch (sortDir) {
      case "asc":
        return aValue > bValue ? 1 : -1;
      case "desc":
        return aValue < bValue ? 1 : -1;
    }
  });

  const handleRowClick = (activity: Activity) => {
    if (selectionMode && onToggleSelection) {
      onToggleSelection(activity.id);
    } else {
      router.push(`/activities/${activity.id}`);
    }
  };

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {selectionMode && <TableHead className="w-12"></TableHead>}
            <TableHead>Activity</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Distance</TableHead>
            <TableHead>Time</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Elevation</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedActivities.map((activity) => (
            <TableRow
              key={activity.id}
              className={`cursor-pointer hover:bg-muted/50 ${
                selectedIds.includes(activity.id) ? "bg-muted" : ""
              }`}
              onClick={() => handleRowClick(activity)}
            >
              {selectionMode && (
                <TableCell>
                  <div
                    className={`w-4 h-4 rounded border-2 ${
                      selectedIds.includes(activity.id)
                        ? "bg-primary border-primary"
                        : "border-muted-foreground"
                    }`}
                  />
                </TableCell>
              )}
              <TableCell className="font-medium">
                <div className="max-w-xs truncate">{activity.name}</div>
              </TableCell>
              <TableCell>
                <span className="inline-flex items-center rounded-full px-2 py-1 text-xs font-medium bg-secondary text-secondary-foreground">
                  {activity.sportType}
                </span>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-1">
                  <Navigation className="h-3 w-3 text-muted-foreground" />
                  <span className="text-sm">
                    {activity.distance ? (activity.distance / 1609.34).toFixed(1) : '0'}mi
                  </span>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-1">
                  <Clock className="h-3 w-3 text-muted-foreground" />
                  <span className="text-sm">
                    {formatDuration(activity.movingTime)}
                  </span>
                </div>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {formatDate(activity.startDate)}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <ElevationSparkline activity={activity} />
                  <span className="text-xs text-muted-foreground">
                    {activity.totalElevationGain ? Math.round(activity.totalElevationGain * 3.28084) : 0}ft
                  </span>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}