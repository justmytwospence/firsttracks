import ActivityCard from "@/components/activity-card";
import type { Activity } from "@prisma/client";

type ActivityGridProps = {
  activities: Activity[];
  sortBy: string;
  sortDir: "asc" | "desc";
  selectionMode?: boolean;
  selectedIds?: string[];
  onToggleSelection?: (id: string) => void;
};

export default function ActivityGrid({
  activities,
  sortBy,
  sortDir,
  selectionMode,
  selectedIds = [],
  onToggleSelection,
}: ActivityGridProps) {
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

  return (
    <div
      className="grid gap-6 justify-center"
      style={{ gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))" }}
    >
      {sortedActivities.map((activity) => (
        <ActivityCard
          key={activity.id}
          activity={activity}
          selected={selectedIds.includes(activity.id)}
          selectionMode={selectionMode}
          onToggleSelection={onToggleSelection}
        />
      ))}
    </div>
  );
}