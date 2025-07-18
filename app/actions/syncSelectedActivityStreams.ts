"use server";

import { auth } from "@/auth";
import { queryActivity } from "@/lib/db";
import { storeActivityStreams } from "@/lib/db/activity-streams";
import { baseLogger } from "@/lib/logger";
import { fetchActivityStreams } from "@/lib/strava";
import pLimit from "p-limit";

type SyncSelectedActivityStreamsMessage = {
  type: "info" | "success" | "warning" | "error";
  message: string;
};

export default async function syncSelectedActivityStreams(
  activityIds: string[]
): Promise<AsyncGenerator<SyncSelectedActivityStreamsMessage>> {
  async function* generator(): AsyncGenerator<SyncSelectedActivityStreamsMessage> {
    try {
      const session = await auth();
      if (!session?.user?.id) {
        throw new Error("Unauthorized");
      }

      if (!activityIds.length) {
        yield {
          type: "warning",
          message: "No activities selected",
        };
        return;
      }

      baseLogger.info(`Syncing streams for ${activityIds.length} selected activities`);
      
      yield {
        type: "info",
        message: `Syncing streams for ${activityIds.length} selected activities...`,
      };

      const limit = pLimit(3); // Reduced concurrency for stream fetching
      let streamsCount = 0;
      let errorCount = 0;

      await Promise.all(
        activityIds.map((activityId) =>
          limit(async () => {
            try {
              // Get the activity to get the start time and check if it has GPS data
              const activity = await queryActivity(session.user.id, activityId);
              if (!activity) {
                baseLogger.warn(`Activity ${activityId} not found`);
                errorCount++;
                return;
              }

              // Only fetch streams for activities that have GPS data
              if (activity.summaryPolyline) {
                const { activityStreams } = await fetchActivityStreams(
                  session.access_token,
                  activityId
                );
                
                await storeActivityStreams(
                  session.user.id,
                  activityId,
                  activityStreams,
                  activity.startDate
                );
                streamsCount++;
              } else {
                baseLogger.info(`Activity ${activityId} has no GPS data, skipping stream sync`);
              }
            } catch (error) {
              baseLogger.warn(`Failed to fetch streams for activity ${activityId}:`, error);
              errorCount++;
            }
          })
        )
      );

      const successMessage = `Successfully synced streams for ${streamsCount} activities`;
      const warningMessage = errorCount > 0 ? ` (${errorCount} failed)` : "";
      
      baseLogger.info(successMessage + warningMessage);
      yield {
        type: errorCount > 0 ? "warning" : "success",
        message: successMessage + warningMessage,
      };

    } catch (error) {
      const errorMessage = `Failed to sync activity streams: ${error instanceof Error ? error.message : String(error)}`;
      baseLogger.error("Failed to sync selected activity streams:", error);
      yield { type: "error", message: errorMessage };
      throw error;
    }
  }

  return generator();
}