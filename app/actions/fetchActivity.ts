"use server";

import { auth } from "@/auth";
import { enrichActivity, queryActivity } from "@/lib/db";
import { baseLogger } from "@/lib/logger";
import { fetchActivityStreams } from "@/lib/strava";
import { isEnrichedActivity, isMappableActivity } from "@/types/transformers";
import type { EnrichedActivity } from "@prisma/client";
import type { StreamSet } from "@/lib/strava/schemas/strava";

export async function fetchActivity(
  activityId: string
): Promise<EnrichedActivity> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  const activity = await queryActivity(session.user.id, activityId);

  if (!activity) {
    throw new Error("Activity not found");
  }

  if (!isMappableActivity(activity)) {
    throw new Error("Activity is not mappable");
  }

  if (!isEnrichedActivity(activity)) {
    baseLogger.info(
      `Activity ${activityId} is missing polyline, fetching detailed activity`
    );

    const { activityStreams } = await fetchActivityStreams(
      session.access_token,
      activityId
    );
    const enrichedActivity = await enrichActivity(activityId, activityStreams);
    return enrichedActivity;

  }

  return activity;
}

export async function fetchActivityWithStreams(
  activityId: string,
  forceRefreshStreams = false
): Promise<{ activity: EnrichedActivity; streams?: StreamSet }> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  const activity = await queryActivity(session.user.id, activityId);

  if (!activity) {
    throw new Error("Activity not found");
  }

  if (!isMappableActivity(activity)) {
    throw new Error("Activity is not mappable");
  }

  let enrichedActivity: EnrichedActivity;
  let streams: StreamSet | undefined;

  if (!isEnrichedActivity(activity)) {
    baseLogger.info(
      `Activity ${activityId} is missing polyline, fetching detailed activity`
    );

    const { activityStreams } = await fetchActivityStreams(
      session.access_token,
      activityId
    );
    enrichedActivity = await enrichActivity(activityId, activityStreams);
    streams = activityStreams;
  } else {
    enrichedActivity = activity;
    // Only fetch streams if forced or if we need them for display
    if (forceRefreshStreams) {
      try {
        const { activityStreams } = await fetchActivityStreams(
          session.access_token,
          activityId
        );
        streams = activityStreams;
      } catch (error) {
        baseLogger.warn(`Failed to fetch streams for activity ${activityId}:`, error);
        // Continue without streams if fetch fails
      }
    }
  }

  return { activity: enrichedActivity, streams };
}
