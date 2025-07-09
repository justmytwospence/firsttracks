import polyline from "@mapbox/polyline";
import type { LineString } from "geojson";
import { z } from "zod";

// Enum for sport types, includes new sport types
export const SportTypeSchema = z.enum([
  "AlpineSki",
  "BackcountrySki",
  "Badminton",
  "Canoeing",
  "Crossfit",
  "EBikeRide",
  "Elliptical",
  "EMountainBikeRide",
  "Golf",
  "GravelRide",
  "Handcycle",
  "HighIntensityIntervalTraining",
  "Hike",
  "IceSkate",
  "InlineSkate",
  "Kayaking",
  "Kitesurf",
  "MountainBikeRide",
  "NordicSki",
  "Pickleball",
  "Pilates",
  "Racquetball",
  "Ride",
  "RockClimbing",
  "RollerSki",
  "Rowing",
  "Run",
  "Sail",
  "Skateboard",
  "Snowboard",
  "Snowshoe",
  "Soccer",
  "Squash",
  "StairStepper",
  "StandUpPaddling",
  "Surfing",
  "Swim",
  "TableTennis",
  "Tennis",
  "TrailRun",
  "Velomobile",
  "VirtualRide",
  "VirtualRow",
  "VirtualRun",
  "Walk",
  "WeightTraining",
  "Wheelchair",
  "Windsurf",
  "Workout",
  "Yoga",
]);

function decodeLineString(data: string | null | undefined): LineString | null {
  if (!data) return null;
  return polyline.toGeoJSON(data) as LineString;
}

// Map details including polylines
export const PolylineMapSchema = z.object({
  id: z.coerce.string(), // Identifier for the map
  polyline: z
    .string()
    .nullable()
    .optional()
    .transform(decodeLineString),
  summary_polyline: z
    .string()
    .nullable()
    .optional()
    .transform(decodeLineString),
});

// SummarySegmentEffort - Summary of an effort on a segment
// Included in:
// DetailedSegment.athlete_segment_stats
// SummarySegment.athlete_segment_stats
export const SummarySegmentEffortSchema = z.object({
  activity_id: z.coerce.string(), // Activity ID related to this effort
  distance: z.number().optional(), // Effort distance in meters
  elapsed_time: z.number().int().optional(), // Elapsed time of the effort
  id: z.coerce.string(), // Unique identifier of the effort
  is_kom: z.boolean().optional(), // Whether this effort is a KOM
  start_date: z.string().datetime().optional(), // Start date of the effort
  start_date_local: z.string().datetime().optional(), // Local start date of the effort
});

// Summary of a segment
// Returned by: /segments/starred
// Included in DetailedSegmentEffort.segment
export const SummarySegmentSchema = z.object({
  activity_type: SportTypeSchema, // Type of activity
  athlete_segment_stats: SummarySegmentEffortSchema.optional(), // Segment effort details if available
  average_grade: z.number(), // Average grade in percent
  city: z.string().nullable(), // Segment's city
  climb_category: z.number().int().min(0).max(5), // Climb difficulty rating (0-5)
  country: z.string().nullable(), // Segment's country
  distance: z.number(), // Segment distance in meters
  elevation_high: z.number(), // Highest elevation in meters
  elevation_low: z.number(), // Lowest elevation in meters
  id: z.coerce.string(), // Unique identifier of the segment
  maximum_grade: z.number(), // Maximum grade in percent
  name: z.string(), // Segment name
  private: z.boolean(), // Whether the segment is private
  state: z.string().nullable(), // Segment's state or region
});
export type SummarySegment = z.infer<typeof SummarySegmentSchema>;

// Detailed information about a segment
// Returned by /segments/{id} endpoint
export const DetailedSegmentSchema = z
  .object({
    activity_type: z.enum(["Ride", "Run", "Hike", "BackcountrySki"]), // Type of activity (Ride or Run)
    athlete_count: z.number().int().optional(), // Number of unique athletes with efforts
    athlete_segment_stats: SummarySegmentEffortSchema.optional(), // Segment effort details if available
    average_grade: z.number(), // Average grade in percent
    city: z.string().nullable(), // Segment's city
    climb_category: z.number().int().min(0), // Climb difficulty rating (0-5)
    country: z.string().nullable(), // Segment's country
    created_at: z.string().datetime(), // Date when the segment was created
    distance: z.number(), // Segment distance in meters
    effort_count: z.number().int(), // Total number of efforts on this segment
    elevation_high: z.number(), // Highest elevation in meters
    elevation_low: z.number(), // Lowest elevation in meters
    hazardous: z.boolean(), // If the segment is considered hazardous
    id: z.coerce.string(), // Unique identifier of the segment
    map: PolylineMapSchema, // Map details
    maximum_grade: z.number(), // Maximum grade in percent
    name: z.string(), // Segment name
    private: z.boolean(), // Whether the segment is private
    star_count: z.number().int().optional(), // Number of stars for this segment
    state: z.string().nullable(), // Segment's state or region
    total_elevation_gain: z.number().optional(), // Total elevation gain in meters
    updated_at: z.string().datetime(), // Date when the segment was last updated
  })
  .strict();
export type DetailedSegment = z.infer<typeof DetailedSegmentSchema>;

// Returned by GET /segment_efforts/{id}
// Returns details of a segment effort
// Included in DetailedActivity.segment_efforts
export const DetailedSegmentEffortSchema = z
  .object({
    activity: z.object({ id: z.coerce.string() }), // Associated activity details
    activity_id: z.coerce.string(), // Activity ID related to this effort
    athlete: z.object({ id: z.coerce.string() }), // Athlete details
    average_cadence: z.number().nullable().optional(), // Average cadence during effort
    average_heartrate: z.number().optional(), // Average heart rate during effort
    average_watts: z.number().nullable().optional(), // Average watts during effort
    device_watts: z.boolean().nullable().optional(), // If wattage is from a power meter
    distance: z.number(), // Effort distance in meters
    elapsed_time: z.number().int(), // Elapsed time of the effort
    end_index: z.number().int(), // End index in activity's stream
    hidden: z.boolean().optional(), // If this effort should be hidden in the activity
    id: z.coerce.string(), // Unique identifier of the effort
    is_kom: z.boolean().optional(), // If this is the current best on leaderboard
    kom_rank: z.number().int().nullable().optional(), // Rank on the global leaderboard if in top 10, can be null
    max_heartrate: z.number().optional(), // Max heart rate during effort
    moving_time: z.number().int(), // Moving time during the effort
    name: z.string(), // Segment name for this effort
    pr_rank: z.number().int().nullable(), // Rank on athlete's leaderboard if in top 3
    segment: SummarySegmentSchema.optional(), // Detailed segment information (optional because this might be a best effort)
    start_date: z.string().datetime(), // Start date of the effort
    start_date_local: z.string().datetime(), // Local start date of the effort
    start_index: z.number().int(), // Start index in activity's stream
  })
  .strict();
export type DetailedSegmentEffort = z.infer<typeof DetailedSegmentEffortSchema>;

// SummaryActivity - Summarized structure of an activity
// Returned by GET /athlete/activities
export const SummaryActivitySchema = z
  .object({
    achievement_count: z.number().int(), // Number of achievements gained
    athlete_count: z.number().int(), // Number of athletes involved in the activity
    average_speed: z.number().optional(), // Average speed in meters/second
    average_watts: z.number().optional(), // Average power output in watts (rides only)
    comment_count: z.number().int(), // Number of comments
    commute: z.boolean(), // Whether it's marked as a commute
    device_watts: z.boolean().optional(), // Whether watts are from a power meter
    distance: z.number(), // Distance in meters
    elapsed_time: z.number().int(), // Elapsed time in seconds
    elev_high: z.number().optional(), // Highest elevation in meters, nullable if unknown
    elev_low: z.number().optional(), // Lowest elevation in meters, nullable if unknown
    flagged: z.boolean(), // Whether it is flagged
    gear_id: z.coerce.string().nullable(), // Gear ID used for the activity
    has_kudoed: z.boolean(), // Whether the logged-in athlete has kudoed this activity
    hide_from_home: z.boolean().optional(), // If the activity is muted
    id: z.coerce.string(), // Unique identifier for the activity
    kilojoules: z.number().nullable().optional(), // Work done in kilojoules (rides only)
    kudos_count: z.number().int(), // Number of kudos received
    manual: z.boolean(), // Whether it was created manually
    map: PolylineMapSchema, // Map details
    max_speed: z.number().nullable(), // Maximum speed in meters/second
    max_watts: z.number().int().optional(), // Maximum watts recorded (rides only)
    moving_time: z.number().int(), // Moving time in seconds
    name: z.string(), // Name of the activity
    photo_count: z.number().int(), // Number of Instagram photos
    private: z.boolean(), // Whether it is private
    sport_type: SportTypeSchema, // Sport type of the activity
    start_date: z.string().datetime(), // Start date in UTC
    start_date_local: z.string().datetime(), // Start date in local timezone
    timezone: z.string(), // Timezone of the activity
    total_elevation_gain: z.number(), // Total elevation gain in meters
    total_photo_count: z.number().int(), // Total photos (Instagram + Strava)
    trainer: z.boolean(), // Whether it was recorded on a trainer
    upload_id: z.coerce.string(), // Identifier of the upload that created this activity
    weighted_average_watts: z.number().int().optional(), // Similar to Normalized Power (rides)
    workout_type: z.number().int().nullish(), // Type of workout
  })
  .strict();
export type SummaryActivity = z.infer<typeof SummaryActivitySchema>;
export const SummaryActivitiesSchema = z.array(SummaryActivitySchema);

// Detailed information about an activity
// Returned by GET /activity/{id}
export const DetailedActivitySchema = z
  .object({
    achievement_count: z.number().int(), // Number of achievements gained
    athlete_count: z.number().int(), // Number of athletes involved in the activity
    average_speed: z.number().optional(), // Average speed in meters/second
    average_watts: z.number().optional(), // Average power output in watts (rides only)
    best_efforts: z.array(DetailedSegmentEffortSchema).optional(), // Collection of best efforts 
    calories: z.number().nullable(), // Kilocalories consumed during the activity
    comment_count: z.number().int(), // Number of comments
    commute: z.boolean(), // Whether it's marked as a commute
    description: z.string().nullable(), // Description of the activity
    device_name: z.string().optional(), // Device name used to record the activity
    device_watts: z.boolean().optional(), // Whether watts are from a power meter
    distance: z.number(), // Distance in meters
    elapsed_time: z.number().int(), // Elapsed time in seconds
    elev_high: z.number().optional(), // Highest elevation in meters
    elev_low: z.number().optional(), // Lowest elevation in meters
    embed_token: z.string().nullable(), // Token used to embed a Strava activity
    flagged: z.boolean(), // Whether it is flagged
    gear_id: z.coerce.string().nullable(), // Gear ID used for the activity
    has_kudoed: z.boolean(), // Whether the logged-in athlete has kudoed this activity
    hide_from_home: z.boolean().optional(), // If the activity is muted
    id: z.coerce.string(), // Unique identifier of the activity
    kilojoules: z.number().nullable().optional(), // Work done in kilojoules (rides only)
    kudos_count: z.number().int(), // Number of kudos received
    manual: z.boolean(), // Whether it was created manually
    map: PolylineMapSchema, // Map details
    max_speed: z.number().nullable(), // Maximum speed in meters/second
    max_watts: z.number().int().optional(), // Maximum watts recorded (rides only)
    moving_time: z.number().int(), // Moving time in seconds
    name: z.string(), // Name of the activity
    photo_count: z.number().int(), // Number of Instagram photos
    private: z.boolean(), // Whether it is private
    segment_efforts: z.array(DetailedSegmentEffortSchema).nullable(), // Segment efforts
    sport_type: SportTypeSchema, // Sport type of the activity
    start_date: z.string().datetime(), // Start date in UTC
    start_date_local: z.string().datetime(), // Start date in local timezone
    timezone: z.string(), // Timezone of the activity
    total_elevation_gain: z.number(), // Total elevation gain in meters
    total_photo_count: z.number().int(), // Total photos (Instagram + Strava)
    trainer: z.boolean(), // Whether it was recorded on a trainer
    upload_id: z.coerce.string(), // Identifier of the upload that created this activity
    weighted_average_watts: z.number().int().optional(), // Similar to Normalized Power (rides)
    workout_type: z.number().int().nullish(), // Type of workout
  })
  .strict();
export type DetailedActivity = z.infer<typeof DetailedActivitySchema>;

// Route - Details of a route
export const RouteSchema = z
  .object({
    created_at: z.string().datetime(), // Route creation date
    description: z.string().nullable(), // Description of the route
    distance: z.number(), // Route distance in meters
    elevation_gain: z.number(), // Total elevation gain in meters
    estimated_moving_time: z.number().int(), // Estimated moving time in seconds
    id: z.number(), // Unique identifier of the route
    id_str: z.string(), // Route ID in string format
    map: PolylineMapSchema, // Map details of the route
    name: z.string(), // Route name
    private: z.boolean(), // Whether the route is private
    segments: z.array(SummarySegmentSchema).nullish(), // Segments traversed by this route
    starred: z.boolean(), // Whether the route is starred
    sub_type: z.number().int().min(1), // Sub-type of the route
    timestamp: z.number().int(), // Epoch timestamp when the route was created
    type: z.number().int().min(1), // Route type (1 for ride, 2 for run)
    updated_at: z.string().datetime(), // Last updated date
  })
  .strict();
export const RoutesSchema = z.array(RouteSchema);
export type Route = z.infer<typeof RouteSchema>;

export const DistanceStreamSchema = z.object({
  data: z.array(z.number()), // Stream data
  original_size: z.number().int(), // Original size of the stream
  resolution: z.string(), // Resolution of the stream
  series_type: z.string()
})

export const AltitudeStreamSchema = z.object({
  data: z.array(z.number()), // Stream data
  original_size: z.number().int(), // Original size of the stream
  resolution: z.string(), // Resolution of the stream
  series_type: z.string()
})

export const LatLngStreamSchema = z.object({
  data: z.array(z.array(z.number())), // Stream data
  original_size: z.number().int(), // Original size of the stream
  resolution: z.string(), // Resolution of the stream
  series_type: z.string()
})

export const HeartrateStreamSchema = z.object({
  data: z.array(z.number()), // Stream data
  original_size: z.number().int(), // Original size of the stream
  resolution: z.string(), // Resolution of the stream
  series_type: z.string()
})

export const VelocityStreamSchema = z.object({
  data: z.array(z.number()), // Stream data  
  original_size: z.number().int(), // Original size of the stream
  resolution: z.string(), // Resolution of the stream
  series_type: z.string()
})

export const TimeStreamSchema = z.object({
  data: z.array(z.number()), // Stream data
  original_size: z.number().int(), // Original size of the stream
  resolution: z.string(), // Resolution of the stream
  series_type: z.string()
})

export const StreamSetSchema = z.object({
  distance: DistanceStreamSchema.optional(),
  latlng: LatLngStreamSchema.optional(),
  altitude: AltitudeStreamSchema.optional(),
  heartrate: HeartrateStreamSchema.optional(),
  velocity_smooth: VelocityStreamSchema.optional(),
  time: TimeStreamSchema.optional(),
})
export type StreamSet = z.infer<typeof StreamSetSchema>;