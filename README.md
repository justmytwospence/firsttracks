# Vertfarm

Advanced route analysis and comparison tools for Strava users who like to farm vert. Work in Progress.

## Tech Stack

- **Framework** React 19
- **Meta Framework:** Next.js 15 with App Router
- **Deployment** Vercel
- **Authentication:** NextAuth.js v5
- **State management** Zustand
- **Database:** PostgreSQL with Prisma ORM
- **GIS** PostGIS
- **Styling:** Tailwind CSS, shadcn/ui
- **Maps:** Leaflet, React Leaflet
- **Charts:** Chart.js
- **Route/Course data:** Strava API
- **Type Safety:** TypeScript, Zod
- **Rust WASM** napi-rs
- **Pathfinding algorithm** pathfinding.rs
- **Azimuths analysis**  Custom Sobel filter
- **DEM data** Open Topography API

## Environment variables

```
DATABASE_URL=""
STRAVA_CLIENT_ID=""
STRAVA_CLIENT_SECRET=""
AUTH_SECRET="" # Added by `npx auth`.
STRAVA_WEBHOOK_VERIFY_TOKEN=""
```

## Branches/Deployment

- **Production**: The `main` branch is automatically deployed to $DOMAIN and migrations are run against the production database.
- **Staging**: The `staging` branch is automatically deployed to the staging.$DOMAIN and migrations are run against the staging database.

## TODO

- [x] Set up database
- [x] Implement authentication
- [x] Integrate Strava API for fetching routes
- [x] Add maps using Leaflet and React Leaflet
- [x] Implement logging with Winston
- [x] Ensure type safety with TypeScript and Zod
- [x] Set up deployment pipeline
- [x] Create route comparison tools
- [x] Implement logic for dealing with Strava rate limits
- [x] Implement webhook for account deletion per API terms
- [x] Refactor functions to take userId instead of session
- [x] Handle rate limiting using the headers from Strava
- [x] Implement webhook for new activites
- [x] Split sync into route and activity
- [x] Sync SegmentEffort and Segment models
- [X] Map brushed linking
- [X] add isEnriched flag to data models
- [X] Show mappable activities in the Routes page
- [X] Exclude current filter from dropdown
- [X] Exclude current sort from dropdown
- [X] use React Portal for syncing toasts
- [X] Implement sort order toggle
- [X] Fix pagination
- [X] Add activities to course comparison
- [X] Store the access token in the JWT to bypass account lookups
- [X] Verify token refresh is working
- [ ] Add Streams model
- [ ] Sync Activity streams
- [ ] Show streams in Activity detail page
- [ ] Implement power-duration/gradient curve
- [ ] Increase athlete headcount
- pathfinder
  - [X] Fix map implementation
  - [X] Change polyline color
  - [X] Save to Strava
  - [X] Improve Aspect categorization
  - [X] Set raster opacity by gradient
  - [ ] Hide charts at the beginning
  - [ ] Cache geotiffs
