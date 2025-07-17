import syncSegments from "@/app/actions/syncSegments";
import { Button } from "@/components/ui/button";
import { useSyncAction } from "@/hooks/useSyncAction";
import { Loader } from "lucide-react";

export default function SyncSegmentsButton({segmentIds}: {segmentIds: string[]}) {
  const { executeSyncAction, isSyncing } = useSyncAction(
    syncSegments,
    {
      invalidationKeys: ["segments"],
      errorPrefix: "Failed to sync segments",
      initialMessage: "Syncing segments...",
    }
  );

  const handleSyncSegments = () => executeSyncAction(segmentIds);

  return (
    <Button onClick={handleSyncSegments} disabled={isSyncing}>
      {isSyncing ? (
        <>
          Syncing
          <Loader className="animate-spin h-4 w-4 ml-2" />
        </>
      ) : (
        "Sync Segments"
      )}
    </Button>
  );
}
