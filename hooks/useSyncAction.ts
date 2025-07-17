"use client";

import { baseLogger } from "@/lib/logger";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

type SyncMessage = {
  type: "info" | "success" | "warning" | "error";
  message: string;
};

interface UseSyncActionOptions {
  /** Query keys to invalidate after successful sync */
  invalidationKeys: string[];
  /** Custom error message prefix */
  errorPrefix?: string;
  /** Initial toast message */
  initialMessage?: string;
}

export function useSyncAction<T extends SyncMessage, Args extends unknown[] = []>(
  syncAction: (...args: Args) => Promise<AsyncGenerator<T>>,
  options: UseSyncActionOptions
) {
  const queryClient = useQueryClient();
  const [isSyncing, setIsSyncing] = useState(false);

  const executeSyncAction = async (...args: Args) => {
    try {
      setIsSyncing(true);
      toast.dismiss();
      
      const syncToastId = options.initialMessage 
        ? toast.message(options.initialMessage)
        : undefined;

      const generator = await syncAction(...args);
      
      for await (const result of generator) {
        switch (result.type) {
          case "error":
            toast.error(result.message);
            break;
          case "info":
            toast.message(result.message);
            break;
          case "success":
            toast.success(result.message);
            break;
          case "warning":
            toast.warning(result.message);
            break;
        }
      }

      if (syncToastId) {
        toast.dismiss(syncToastId);
      }

      // Invalidate relevant queries
      await queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey.some(
            (key) => 
              typeof key === "string" && 
              options.invalidationKeys.some(invalidationKey => 
                key.includes(invalidationKey)
              )
          ),
      });

    } catch (error) {
      const errorMessage = `${options.errorPrefix || "Failed to sync"}: ${error}`;
      baseLogger.error(errorMessage, error);
      toast.error(errorMessage);
    } finally {
      setIsSyncing(false);
    }
  };

  return {
    executeSyncAction,
    isSyncing,
  };
}
