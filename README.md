# Vertfarm

Interactive terrain-aware route planning with DEM analysis. Plan ski tours, backcountry routes, and hiking trails with real-time terrain analysis.

## Features

- **Interactive Map**: Click to place waypoints on a Leaflet terrain map
- **Pathfinding**: Find optimal paths using a Rust WASM module with A* algorithm
- **Real-time Visualization**: Watch the pathfinding algorithm explore the terrain
- **Aspect Analysis**: Visualize terrain aspects with a raster overlay; exclude certain aspects from pathfinding
- **Gradient Control**: Set maximum gradient constraints for the pathfinding algorithm
- **Elevation Profile**: View the elevation profile and gradient of your planned route
- **Gradient Distribution**: Analyze the gradient distribution with histogram and CDF charts
- **Aspect Distribution**: See the aspect distribution of your route
- **GPX Import/Export**: Import existing routes or download your planned route as GPX

## Tech Stack

- **Framework**: React 19, Next.js 15 with App Router
- **Deployment**: Vercel
- **State**: Zustand with subscribeWithSelector middleware
- **Styling**: Tailwind CSS, shadcn/ui
- **Maps**: Leaflet, React Leaflet
- **Charts**: Chart.js, react-chartjs-2
- **Rust Integration**: WebAssembly via wasm-bindgen, running in a Web Worker
- **Pathfinding Algorithm**: A* via pathfinding.rs crate
- **Terrain Analysis**: Custom 5x5 Sobel filter for aspect/gradient computation
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

# Full production build (WASM + Next.js)
npm run build
```

### Prerequisites

- Node.js 22+
- Rust toolchain with `wasm32-unknown-unknown` target
- wasm-pack (`cargo install wasm-pack`)

## Architecture

The pathfinding runs entirely client-side:
1. DEM tiles are fetched via `/api/dem` proxy (keeps API key secret)
2. Tiles are cached in IndexedDB for offline/repeat use
3. Azimuths and gradients are computed once per region and cached
4. WASM module runs in a Web Worker for non-blocking UI
5. Exploration updates stream back to main thread for real-time visualization
6. Paths are smoothed using Gaussian-weighted moving average

## Deployment

The app deploys to Vercel. The WASM module is built during the Vercel build process using Rust/wasm-pack installed via the custom install command.
