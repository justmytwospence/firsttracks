import { baseLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import type { StreamSet } from "@/lib/strava/schemas/strava";

export interface ActivityStreamData {
  time: Date;
  altitude?: number;
  cadence?: number;
  distance?: number;
  gradientSmooth?: number;
  heartrate?: number;
  latitude?: number;
  longitude?: number;
  moving?: boolean;
  temperature?: number;
  velocitySmooth?: number;
  watts?: number;
}

export async function storeActivityStreams(
  userId: string,
  activityId: string,
  streams: StreamSet
): Promise<void> {
  baseLogger.debug(`Storing activity streams for activity ${activityId}`);

  // Get the time stream as the base for all other streams
  const timeStream = streams.time?.data;
  if (!timeStream || timeStream.length === 0) {
    baseLogger.warn(`No time stream data for activity ${activityId}, skipping stream storage`);
    return;
  }

  // Prepare stream data points
  const streamDataPoints: ActivityStreamData[] = timeStream.map((timeValue, index) => {
    const latlng = streams.latlng?.data?.[index];
    return {
      time: new Date(Date.now() + timeValue * 1000), // Convert relative time to absolute time
      altitude: streams.altitude?.data?.[index],
      cadence: streams.cadence?.data?.[index],
      distance: streams.distance?.data?.[index],
      gradientSmooth: streams.grade_smooth?.data?.[index],
      heartrate: streams.heartrate?.data?.[index],
      latitude: latlng?.[0],
      longitude: latlng?.[1],
      moving: streams.moving?.data?.[index],
      temperature: streams.temp?.data?.[index],
      velocitySmooth: streams.velocity_smooth?.data?.[index],
      watts: streams.watts?.data?.[index],
    };
  });

  // Delete existing streams for this activity
  await prisma.activityStream.deleteMany({
    where: {
      activityId,
      userId,
    },
  });

  // Insert new stream data in batches to avoid overwhelming the database
  const batchSize = 1000;
  for (let i = 0; i < streamDataPoints.length; i += batchSize) {
    const batch = streamDataPoints.slice(i, i + batchSize);
    await prisma.activityStream.createMany({
      data: batch.map((point) => ({
        activityId,
        userId,
        ...point,
      })),
    });
  }

  baseLogger.debug(`Stored ${streamDataPoints.length} stream data points for activity ${activityId}`);
}

export async function queryActivityStreams(
  userId: string,
  activityId: string
): Promise<ActivityStreamData[]> {
  baseLogger.debug(`Querying activity streams for activity ${activityId}`);

  const streams = await prisma.activityStream.findMany({
    where: {
      activityId,
      userId,
    },
    orderBy: {
      time: 'asc',
    },
  });

  return streams;
}

export async function deleteActivityStreams(
  userId: string,
  activityId: string
): Promise<void> {
  baseLogger.debug(`Deleting activity streams for activity ${activityId}`);

  await prisma.activityStream.deleteMany({
    where: {
      activityId,
      userId,
    },
  });

  baseLogger.debug(`Deleted activity streams for activity ${activityId}`);
}

// Create TimescaleDB hypertable - this should be called after Prisma migration
export async function createActivityStreamsHypertable(): Promise<void> {
  try {
    baseLogger.info("Creating ActivityStreams hypertable");
    
    // Check if TimescaleDB extension is available
    await prisma.$executeRaw`CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;`;
    
    // Create hypertable on the activity_streams table
    await prisma.$executeRaw`
      SELECT create_hypertable('activity_streams', 'time', 
        chunk_time_interval => INTERVAL '1 day',
        if_not_exists => TRUE
      );
    `;
    
    baseLogger.info("ActivityStreams hypertable created successfully");
  } catch (error) {
    baseLogger.error("Failed to create ActivityStreams hypertable:", error);
    // Don't throw here as the application should still work without hypertable
  }
}