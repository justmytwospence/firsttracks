import syncRoutes from "@/app/actions/syncRoutes";
import { Button } from "@/components/ui/button";
import { useSyncAction } from "@/hooks/useSyncAction";
import { Loader } from "lucide-react";

export default function SyncRoutesButton() {
  const { executeSyncAction, isSyncing } = useSyncAction(
    syncRoutes,
    {
      invalidationKeys: ["routes"],
      errorPrefix: "Failed to sync routes",
      initialMessage: "Syncing routes...",
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
        "Sync Routes"
      )}
    </Button>
  );
}
