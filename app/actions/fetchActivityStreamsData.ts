"use server";

import { auth } from "@/auth";
import { getActivityStreams } from "@/lib/db/activity-streams";
import { baseLogger } from "@/lib/logger";
import { fetchActivityStreams } from "@/lib/strava";
import { storeActivityStreams } from "@/lib/db/activity-streams";
import { queryActivity } from "@/lib/db";
import type { ActivityStreamData } from "@/lib/db/activity-streams";

export async function fetchActivityStreamsData(
  activityId: string
): Promise<ActivityStreamData[]> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  // First check if we already have streams stored
  let streams = await getActivityStreams(session.user.id, activityId);
  
  if (!streams || streams.length === 0) {
    baseLogger.info(`No stored streams found for activity ${activityId}, fetching from Strava`);
    
    // Get the activity to get the start time
    const activity = await queryActivity(session.user.id, activityId);
    if (!activity) {
      throw new Error("Activity not found");
    }

    try {
      // Fetch streams from Strava
      const { activityStreams } = await fetchActivityStreams(
        session.access_token,
        activityId
      );
      
      // Store the streams
      await storeActivityStreams(
        session.user.id,
        activityId,
        activityStreams,
        activity.startDate
      );
      
      // Get the stored streams
      streams = await getActivityStreams(session.user.id, activityId);
    } catch (error) {
      baseLogger.warn(`Failed to fetch streams for activity ${activityId}:`, error);
      return [];
    }
  }

  return streams || [];
}