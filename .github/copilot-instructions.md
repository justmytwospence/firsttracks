# Vertfarm - AI Agent Instructions

## Core Architecture

This is a **Next.js 15 + App Router** application for advanced Strava route analysis with GIS capabilities. Key components:

- **Authentication**: NextAuth.js v5 with Strava OAuth (JWT strategy)
- **Database**: PostgreSQL + PostGIS with Prisma ORM (preview features enabled)
- **State**: Zustand stores with `subscribeWithSelector` middleware
- **UI**: shadcn/ui + Tailwind CSS, custom Leaflet maps, Chart.js
- **Rust Integration**: NAPI-RS pathfinding module with DEM processing

## Critical Patterns

### Data Model Hierarchy
- **Base models**: `Activity`, `Route`, `Segment` (from Strava API)
- **Mappable types**: Models with `summaryPolyline` (GeoJSON LineString)
- **Enriched types**: Mappable + full `polyline` + `enrichedAt` timestamp
- Use type guards: `isMappableActivity()`, `isEnrichedRoute()`, etc.

### Strava API Integration
- **Rate limiting**: Custom `StravaHttpError` with rate limit headers
- **Token refresh**: Automatic in JWT callback (`lib/strava/auth.ts`)
- **Brand compliance**: Must use `StravaAttribution` + `ViewOnStravaLink` components
- **Webhooks**: Handle create/update/delete events at `/api/strava-webhook`

### Database Patterns
- **Composite keys**: `id_userId` for user-scoped resources
- **Enrichment workflow**: Base → Mappable → Enriched (with streams/geometry)
- **GeoJSON storage**: Use `/// [LineStringType]` Prisma comments for type generation
- **Snake/camel conversion**: Use `convertKeysToCamelCase()` for API responses

### Server Actions Structure
```typescript
// Pattern: actions/fetchEntity.ts
"use server";
const session = await auth();
const entity = await queryEntity(session.user.id, id);
if (!isEnriched(entity) || entity.enrichedAt < entity.updatedAt) {
  return await enrichEntity(session.user.id, id, apiData);
}
```

## Development Workflows

- **Database**: `npx prisma migrate dev` for schema changes
- **Rust module**: Build with `npm run build` in `/pathfinder`
- **Type safety**: Zod schemas for all external APIs (`lib/strava/schemas/`)
- **Logging**: Winston logger with file rotation (`lib/logger.ts`)

## Key Constraints

- **Middleware**: Auth required except `/api/*`, `/login`, `/pathfinder`, static assets
- **Root redirect**: `/` → `/pathfinder`
- **User scope**: All queries must include `userId` parameter
- **Error boundaries**: Use server actions for data fetching, not client-side API calls

## Environment Requirements
```bash
DATABASE_URL="" # PostgreSQL with PostGIS
STRAVA_CLIENT_ID=""
STRAVA_CLIENT_SECRET=""
AUTH_SECRET=""
STRAVA_WEBHOOK_VERIFY_TOKEN=""
```

## Miscellaneous

- Don't make changes unrelated to the immediate request. 
- When implementing complex features, explain the step-by-step approach first.
- Code comments should not be made in reference to previoius versions of the code, they should only explain the current version of the code, where it is especially useful or necessary to understand the logic.kkkkkk