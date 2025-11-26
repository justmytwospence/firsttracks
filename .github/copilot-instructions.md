# Pathfinder - AI Agent Instructions

## Core Architecture

This is a **Next.js 15 + App Router** application for interactive terrain-aware route planning with GIS capabilities. Key components:

- **State**: Zustand stores with `subscribeWithSelector` middleware
- **UI**: shadcn/ui + Tailwind CSS, custom Leaflet maps, Chart.js
- **Rust Integration**: NAPI-RS pathfinding module with DEM processing

## Key Features

- Click-to-place waypoints on an interactive Leaflet map
- Find optimal paths using Rust NAPI-RS module with DEM analysis
- Download DEM data from OpenTopo API
- Compute azimuths/gradients and display aspect raster overlay
- Export path as GPX
- Display elevation profile, gradient CDF, and aspect distribution charts

## Development Workflows

- **Rust module**: Build with `npm run build` in `/pathfinder`
- **Dev server**: `npm run dev`

## Environment Requirements
```bash
NEXT_PUBLIC_JAWG_ACCESS_TOKEN="" # Jawg Maps tile layer
OPEN_TOPO_API_KEY="" # OpenTopography DEM data
```

## Miscellaneous

- Don't make changes unrelated to the immediate request. 
- When implementing complex features, explain the step-by-step approach first.
- Code comments should not be made in reference to previous versions of the code, they should only explain the current version of the code, where it is especially useful or necessary to understand the logic.