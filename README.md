# Pathfinder

Interactive terrain-aware route planning with DEM analysis. Click-to-place waypoints on a map and find optimal paths using terrain analysis.

## Features

- **Interactive Map**: Click to place waypoints on a Leaflet terrain map
- **Pathfinding**: Find optimal paths using a Rust NAPI-RS module with DEM analysis
- **Aspect Analysis**: Visualize terrain aspects with a raster overlay; exclude certain aspects from pathfinding
- **Gradient Control**: Set maximum gradient constraints for the pathfinding algorithm
- **Elevation Profile**: View the elevation profile of your planned route
- **Gradient Distribution**: Analyze the gradient distribution with a CDF chart
- **Aspect Distribution**: See the aspect distribution of your route
- **GPX Export**: Download your planned route as a GPX file

## Tech Stack

- **Framework**: React 19, Next.js 15 with App Router
- **Deployment**: Vercel
- **State**: Zustand
- **Styling**: Tailwind CSS, shadcn/ui
- **Maps**: Leaflet, React Leaflet
- **Charts**: Chart.js
- **Rust Integration**: NAPI-RS pathfinding module
- **Pathfinding Algorithm**: pathfinding.rs
- **Terrain Analysis**: Custom Sobel filter for aspect computation
- **DEM Data**: OpenTopography API

## Environment Variables

```bash
NEXT_PUBLIC_JAWG_ACCESS_TOKEN="" # Jawg Maps tile layer
OPEN_TOPO_API_KEY="" # OpenTopography DEM data
```

## Development

```bash
# Install dependencies
npm install

# Build the Rust pathfinding module
cd pathfinder && npm run build && cd ..

# Start development server
npm run dev
```

## Deployment

The app is deployed to Vercel. The Rust module is built during the Vercel build process.
