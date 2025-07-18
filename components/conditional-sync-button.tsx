import syncActivities from "@/app/actions/syncActivities";
import syncSelectedActivityStreams from "@/app/actions/syncSelectedActivityStreams";
import { Button } from "@/components/ui/button";
import { useSyncAction } from "@/hooks/useSyncAction";
import { Loader } from "lucide-react";

type ConditionalSyncButtonProps = {
  selectedIds: string[];
  selectionMode: boolean;
};

export default function ConditionalSyncButton({
  selectedIds,
  selectionMode,
}: ConditionalSyncButtonProps) {
  const hasSelectedActivities = selectionMode && selectedIds.length > 0;

  // Sync action for regular activities (no streams)
  const { executeSyncAction: executeSyncActivities, isSyncing: isSyncingActivities } = useSyncAction(
    syncActivities,
    {
      invalidationKeys: ["activities"],
      errorPrefix: "Failed to sync activities",
      initialMessage: "Syncing activities...",
    }
  );

  // Sync action for selected activity streams
  const { executeSyncAction: executeSyncStreams, isSyncing: isSyncingStreams } = useSyncAction(
    () => syncSelectedActivityStreams(selectedIds),
    {
      invalidationKeys: ["activities", "activity-streams"],
      errorPrefix: "Failed to sync activity streams",
      initialMessage: "Syncing activity streams...",
    }
  );

  const isSyncing = isSyncingActivities || isSyncingStreams;

  if (hasSelectedActivities) {
    return (
      <Button onClick={executeSyncStreams} disabled={isSyncing}>
        {isSyncingStreams ? (
          <>
            Syncing Activity Streams
            <Loader className="animate-spin h-4 w-4 ml-2" />
          </>
        ) : (
          `Sync Activity Streams (${selectedIds.length})`
        )}
      </Button>
    );
  }

  return (
    <Button onClick={executeSyncActivities} disabled={isSyncing}>
      {isSyncingActivities ? (
        <>
          Syncing Activities
          <Loader className="animate-spin h-4 w-4 ml-2" />
        </>
      ) : (
        "Sync Activities"
      )}
    </Button>
  );
}