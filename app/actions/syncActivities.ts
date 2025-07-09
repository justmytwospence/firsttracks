"use server";

import { auth } from "@/auth";
import { enrichActivity, upsertSegmentEffort, upsertSummaryActivity } from "@/lib/db";
import { baseLogger } from "@/lib/logger";
import { fetchActivities, fetchActivityStreams } from "@/lib/strava";
import { isMappableActivity } from "@/types/transformers";
import pLimit from "p-limit";

type SyncActivitiesMessage = {
  type: "info" | "success" | "warning" | "error";
  message: string;
};

export default async function syncActivities(includeStreamData = false): Promise<
  AsyncGenerator<SyncActivitiesMessage>
> {
  async function* generator(): AsyncGenerator<SyncActivitiesMessage> {
    try {
      const session = await auth();
      if (!session?.user?.id) {
        throw new Error("Unauthorized");
      }

      baseLogger.info("Syncing activities");

      let currentPage = 1;
      const limit = pLimit(5);
      let syncedCount = 0;

      while (true) {
        const { summaryActivities, unrecognizedKeys } = await fetchActivities(
          session.access_token,
          currentPage
        );
        if (!summaryActivities?.length) break;

        baseLogger.info(
          `Syncing page ${currentPage} with ${summaryActivities.length} activities`
        );
        yield {
          type: "info",
          message: `Syncing page ${currentPage} with ${summaryActivities.length} activities`,
        };

        if (unrecognizedKeys.size > 0) {
          yield {
            type: "warning",
            message: `Unrecognized keys: ${Array.from(unrecognizedKeys).join(
              ", "
            )}`,
          };
        }

        await Promise.all(
          summaryActivities.map((activity) =>
            limit(async () => {
                await upsertSummaryActivity(session.user.id, activity);
                syncedCount++;
                
                // If includeStreamData is true and activity is mappable, fetch and enrich with stream data
                if (includeStreamData && isMappableActivity(activity)) {
                  try {
                    const { activityStreams } = await fetchActivityStreams(
                      session.access_token, 
                      activity.id.toString()
                    );
                    if (activityStreams) {
                      await enrichActivity(activity.id.toString(), activityStreams);
                    }
                  } catch (error) {
                    baseLogger.warn(`Failed to fetch streams for activity ${activity.id}:`, error);
                    // Continue without failing the entire sync
                  }
                }
            })
          )
        );

        currentPage++;
      }

      baseLogger.info(`Successfully synced ${syncedCount} activities`);
      yield {
        type: "success",
        message: `Successfully synced ${syncedCount} activities`,
      };

    } catch (error) {
      baseLogger.error("Failed to sync activities:", error);
      yield { type: "error", message: "Failed to sync activities" };
      throw error;
    }
  }

  return generator();
}
