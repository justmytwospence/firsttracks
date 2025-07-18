import type {
  Activity,
  Course,
  EnrichedActivity,
  EnrichedCourse,
  EnrichedRoute,
  EnrichedSegment,
  MappableActivity,
  Route,
  Segment,
} from "@prisma/client";

export function isEnrichedSegment(segment: Segment): segment is EnrichedSegment {
  return "enrichedAt" in segment && segment.enrichedAt !== null;
}

export function isRoute(maybeRoute: Activity | Route): maybeRoute is Route {
  return "estimatedMovingTime" in maybeRoute;
}

export function isMappableActivity(
  activity: Activity
): activity is MappableActivity {
  return activity.summaryPolyline !== null;
}

export function isEnrichedActivity(
  activity: MappableActivity
): activity is EnrichedActivity {
  return activity.enrichedAt !== null;
}

export function isEnrichedRoute(route: Route): route is EnrichedRoute {
  return route.enrichedAt !== null;
}

export function isEnrichedCourse(course: Course): course is EnrichedCourse {
  return course.enrichedAt !== null;
}

function toCourse(course: EnrichedRoute | EnrichedActivity): EnrichedCourse;
function toCourse(course: Route | MappableActivity): Course;
function toCourse(
  course: Route | EnrichedRoute | MappableActivity | EnrichedActivity
): Course | EnrichedCourse {
  if (isRoute(course)) {
    return {
      courseType: "route" as const,
      createdAt: course.createdAt,
      description: course?.description ?? undefined,
      distance: course.distance,
      duration: course.estimatedMovingTime,
      elevationGain: course.elevationGain,
      id: course.id.toString(),
      name: course.name,
      polyline: course.polyline ?? undefined,
      summaryPolyline: course.summaryPolyline,
      type: course.type?.toString() ?? "Unknown",
      enrichedAt: course.enrichedAt,
    };
  }
  return {
    courseType: "activity" as const,
    createdAt: course.startDate,
    description: course?.description ?? undefined,
    distance: course.distance,
    duration: course.movingTime,
    elevationGain: course.totalElevationGain,
    id: course.id.toString(),
    name: course.name,
    summaryPolyline: course.summaryPolyline,
    type: course.sportType,
    enrichedAt: course.enrichedAt,
    polyline: course.polyline ?? undefined,
  };
}
export { toCourse };

export function toActivity(activity: MappableActivity): Activity {
  return activity;
}
