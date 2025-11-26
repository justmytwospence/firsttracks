# Pathfinder

Interactive terrain-aware route planning with DEM analysis. Click-to-place waypoints on a map and find optimal paths using terrain analysis.

## Features

- **Interactive Map**: Click to place waypoints on a Leaflet terrain map
- **Pathfinding**: Find optimal paths using a Rust WASM module with A* algorithm
- **Real-time Visualization**: Watch the pathfinding algorithm explore the terrain
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
- **Rust Integration**: WebAssembly via wasm-bindgen, running in a Web Worker
- **Pathfinding Algorithm**: A* via pathfinding.rs crate
- **Terrain Analysis**: Custom Sobel filter for aspect computation
- **DEM Data**: OpenTopography API (cached in IndexedDB)

## Environment Variables

```bash
NEXT_PUBLIC_JAWG_ACCESS_TOKEN="" # Jawg Maps tile layer
OPEN_TOPO_API_KEY="" # OpenTopography DEM data
```

## Development

```bash
# Install dependencies
npm install

# Build the Rust WASM module
npm run build:wasm

# Start development server
npm run dev

# Full production build
npm run build
```

## Architecture

The pathfinding runs entirely client-side:
1. DEM tiles are fetched via `/api/dem` proxy (keeps API key secret)
2. Tiles are cached in IndexedDB for offline/repeat use
3. WASM module runs in a Web Worker for non-blocking UI
4. Exploration updates stream back to main thread for real-time visualization

## Deployment

The app is deployed to Vercel. The WASM module is built during the Vercel build process.
