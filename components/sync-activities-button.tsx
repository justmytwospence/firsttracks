import syncActivities from "@/app/actions/syncActivities";
import { Button } from "@/components/ui/button";
import { useSyncAction } from "@/hooks/useSyncAction";
import { Loader } from "lucide-react";

export default function SyncActivitiesButton() {
  const { executeSyncAction, isSyncing } = useSyncAction(
    syncActivities,
    {
      invalidationKeys: ["activities"],
      errorPrefix: "Failed to sync activities",
      initialMessage: "Syncing activities...",
    }
  );

  return (
    <Button onClick={executeSyncAction} disabled={isSyncing}>
      {isSyncing ? (
        <>
          Syncing
          <Loader className="animate-spin h-4 w-4 ml-2" />
        </>
      ) : (
        "Sync Activities"
      )}
    </Button>
  );
}
