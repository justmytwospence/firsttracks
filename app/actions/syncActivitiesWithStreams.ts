"use server";

import { auth } from "@/auth";
import { upsertSummaryActivity } from "@/lib/db";
import { storeActivityStreams } from "@/lib/db/activity-streams";
import { baseLogger } from "@/lib/logger";
import { fetchActivities, fetchActivityStreams } from "@/lib/strava";
import pLimit from "p-limit";

type SyncActivitiesWithStreamsMessage = {
  type: "info" | "success" | "warning" | "error";
  message: string;
};

export default async function syncActivitiesWithStreams(): Promise<
  AsyncGenerator<SyncActivitiesWithStreamsMessage>
> {
  async function* generator(): AsyncGenerator<SyncActivitiesWithStreamsMessage> {
    try {
      const session = await auth();
      if (!session?.user?.id) {
        throw new Error("Unauthorized");
      }

      baseLogger.info("Syncing activities with streams");

      let currentPage = 1;
      const limit = pLimit(3); // Reduced concurrency for stream fetching
      let syncedCount = 0;
      let streamsCount = 0;

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
          message: `Processing page ${currentPage} with ${summaryActivities.length} activities`,
        };

        if (unrecognizedKeys.size > 0) {
          yield {
            type: "warning",
            message: `Unrecognized keys: ${Array.from(unrecognizedKeys).join(
              ", "
            )}`,
          };
        }

        // First, upsert all activities
        await Promise.all(
          summaryActivities.map((activity) =>
            limit(async () => {
              await upsertSummaryActivity(session.user.id, activity);
              syncedCount++;
            })
          )
        );

        // Then fetch and store streams for each activity
        yield {
          type: "info",
          message: `Fetching streams for ${summaryActivities.length} activities...`,
        };

        await Promise.all(
          summaryActivities.map((activity) =>
            limit(async () => {
              try {
                // Only fetch streams for activities that have GPS data
                if (activity.map?.summary_polyline) {
                  const { activityStreams } = await fetchActivityStreams(
                    session.access_token,
                    activity.id.toString()
                  );
                  
                  await storeActivityStreams(
                    session.user.id,
                    activity.id.toString(),
                    activityStreams,
                    new Date(activity.start_date)
                  );
                  streamsCount++;
                }
              } catch (error) {
                baseLogger.warn(`Failed to fetch streams for activity ${activity.id}:`, error);
                // Continue with other activities even if one fails
              }
            })
          )
        );

        yield {
          type: "info",
          message: `Processed streams for page ${currentPage}`,
        };

        currentPage++;
      }

      const successMessage = `Successfully synced ${syncedCount} activities and ${streamsCount} activity streams`;
      baseLogger.info(successMessage);
      yield {
        type: "success",
        message: successMessage,
      };

    } catch (error) {
      const errorMessage = `Failed to sync activities with streams: ${error instanceof Error ? error.message : String(error)}`;
      baseLogger.error("Failed to sync activities with streams:", error);
      yield { type: "error", message: errorMessage };
      throw error;
    }
  }

  return generator();
}