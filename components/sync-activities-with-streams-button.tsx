import syncActivitiesWithStreams from "@/app/actions/syncActivitiesWithStreams";
import { Button } from "@/components/ui/button";
import { useSyncAction } from "@/hooks/useSyncAction";
import { Loader } from "lucide-react";

export default function SyncActivitiesWithStreamsButton() {
  const { executeSyncAction, isSyncing } = useSyncAction(
    syncActivitiesWithStreams,
    {
      invalidationKeys: ["activities"],
      errorPrefix: "Failed to sync activities with streams",
      initialMessage: "Syncing activities and streams...",
    }
  );

  return (
    <Button onClick={executeSyncAction} disabled={isSyncing}>
      {isSyncing ? (
        <>
          Syncing Activities & Streams
          <Loader className="animate-spin h-4 w-4 ml-2" />
        </>
      ) : (
        "Sync Activities & Streams"
      )}
    </Button>
  );
}