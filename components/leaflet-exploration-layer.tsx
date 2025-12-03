'use client';

import type { ExplorationNode } from '@/hooks/usePathfinder';
import L from 'leaflet';
import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';

interface LeafletExplorationLayerProps {
  nodes: ExplorationNode[];
  /** Fade out duration in ms */
  fadeOutDuration?: number;
  /** Point radius in pixels (only used in 'points' mode) */
  radius?: number;
  /** Point/line color */
  color?: string;
  /** How long points stay fully visible before fading (ms) */
  persistDuration?: number;
  /** Visualization mode: 'points' for individual dots, 'boundary' for connected frontier line */
  mode?: 'points' | 'boundary';
  /** Line width for boundary mode */
  lineWidth?: number;
}

// DEM cell size is approximately 1/10800 degrees (~10m at equator)
const CELL_SIZE = 1 / 10800;
const INV_CELL_SIZE = 10800; // Pre-computed inverse for faster multiplication

// Pre-allocated arrays for neighbor offsets (8-connectivity)
const NEIGHBOR_DX = [-1, 0, 1, -1, 1, -1, 0, 1];
const NEIGHBOR_DY = [-1, -1, -1, 0, 0, 1, 1, 1];

/**
 * Canvas-based Leaflet layer for visualizing A* exploration in real-time.
 * Uses a custom L.Layer subclass for optimal performance.
 */
export function LeafletExplorationLayer({
  nodes,
  fadeOutDuration = 2000,
  radius = 2,
  color = 'rgba(59, 130, 246, 0.8)', // blue-500 with alpha
  persistDuration = 500,
  mode = 'points',
  lineWidth = 2,
}: LeafletExplorationLayerProps) {
  const map = useMap();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const layerRef = useRef<L.Layer | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const nodesRef = useRef<ExplorationNode[]>([]);
  const lastNodesLengthRef = useRef<number>(0);
  const needsRedrawRef = useRef<boolean>(true);
  
  // Reusable data structures to avoid GC pressure
  const gridSetRef = useRef<Set<number>>(new Set());
  const nodesByGridRef = useRef<Map<number, ExplorationNode>>(new Map());
  const drawnEdgesRef = useRef<Set<number>>(new Set());
  
  // Keep nodes ref updated and mark for redraw
  useEffect(() => {
    nodesRef.current = nodes;
    needsRedrawRef.current = true;
  }, [nodes]);
  
  // Create and add canvas layer
  useEffect(() => {
    // Create custom canvas layer
    const CanvasLayer = L.Layer.extend({
      onAdd(leafletMap: L.Map) {
        const size = leafletMap.getSize();
        const canvas = L.DomUtil.create('canvas', 'leaflet-exploration-layer');
        canvas.width = size.x;
        canvas.height = size.y;
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.pointerEvents = 'none';
        canvas.style.zIndex = '400'; // Above tiles, below markers
        
        canvasRef.current = canvas;
        
        const pane = leafletMap.getPane('overlayPane');
        if (pane) {
          pane.appendChild(canvas);
        }
        
        // Handle map move/resize - mark for redraw
        const markRedraw = () => { needsRedrawRef.current = true; };
        leafletMap.on('move', this._updatePosition, this);
        leafletMap.on('move', markRedraw);
        leafletMap.on('resize', this._onResize, this);
        leafletMap.on('zoom', markRedraw);
        
        this._updatePosition();
      },
      
      onRemove(leafletMap: L.Map) {
        if (canvasRef.current) {
          canvasRef.current.remove();
          canvasRef.current = null;
        }
        leafletMap.off('move', this._updatePosition, this);
        leafletMap.off('resize', this._onResize, this);
      },
      
      _updatePosition() {
        if (!canvasRef.current) return;
        const pos = map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(canvasRef.current, pos);
        needsRedrawRef.current = true;
      },
      
      _onResize() {
        if (!canvasRef.current) return;
        const size = map.getSize();
        canvasRef.current.width = size.x;
        canvasRef.current.height = size.y;
        needsRedrawRef.current = true;
      },
    });
    
    const layer = new CanvasLayer();
    layer.addTo(map);
    layerRef.current = layer;
    
    return () => {
      if (layerRef.current) {
        map.removeLayer(layerRef.current);
        layerRef.current = null;
      }
    };
  }, [map]);
  
  // Animation loop
  useEffect(() => {
    const render = () => {
      const canvas = canvasRef.current;
      if (!canvas) {
        animationFrameRef.current = requestAnimationFrame(render);
        return;
      }
      
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        animationFrameRef.current = requestAnimationFrame(render);
        return;
      }
      
      // Clear canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      const now = Date.now();
      const currentNodes = nodesRef.current;
      
      // Parse base color to get RGB values
      const baseColor = color.match(/[\d.]+/g);
      const r = baseColor ? Number.parseInt(baseColor[0]) : 59;
      const g = baseColor ? Number.parseInt(baseColor[1]) : 130;
      const b = baseColor ? Number.parseInt(baseColor[2]) : 246;
      const baseAlpha = baseColor?.[3] ? Number.parseFloat(baseColor[3]) : 0.8;
      
      if (mode === 'boundary') {
        // Boundary mode: draw edges between adjacent frontier points on the grid
        const visibleNodes = currentNodes.filter(node => {
          const age = now - node.timestamp;
          return age <= persistDuration + fadeOutDuration;
        });
        
        if (visibleNodes.length < 2) {
          animationFrameRef.current = requestAnimationFrame(render);
          return;
        }
        
        // Reuse data structures - clear instead of recreating
        const gridSet = gridSetRef.current;
        const nodesByGrid = nodesByGridRef.current;
        const drawnEdges = drawnEdgesRef.current;
        gridSet.clear();
        nodesByGrid.clear();
        drawnEdges.clear();
        
        // Use integer grid keys for faster hashing
        // Combine gx and gy into a single number: gx * 1000000 + gy (assumes grid coords < 1M)
        const toGridKey = (lon: number, lat: number): number => {
          const gx = Math.round(lon * INV_CELL_SIZE);
          const gy = Math.round(lat * INV_CELL_SIZE);
          return gx * 1000000 + gy;
        };
        
        // Build grid lookup
        for (let i = 0; i < visibleNodes.length; i++) {
          const node = visibleNodes[i];
          const key = toGridKey(node.lon, node.lat);
          gridSet.add(key);
          nodesByGrid.set(key, node);
        }
        
        // Calculate average alpha
        let totalAlpha = 0;
        for (let i = 0; i < visibleNodes.length; i++) {
          const node = visibleNodes[i];
          const age = now - node.timestamp;
          let alpha = baseAlpha;
          if (age > persistDuration) {
            const fadeProgress = (age - persistDuration) / fadeOutDuration;
            alpha = baseAlpha * (1 - fadeProgress);
          }
          totalAlpha += alpha;
        }
        const avgAlpha = totalAlpha / visibleNodes.length;
        
        // Draw edges only between adjacent grid cells (8-connectivity)
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${avgAlpha})`;
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        
        for (let i = 0; i < visibleNodes.length; i++) {
          const node = visibleNodes[i];
          const gx = Math.round(node.lon * INV_CELL_SIZE);
          const gy = Math.round(node.lat * INV_CELL_SIZE);
          
          // Check all 8 neighbors using pre-allocated offset arrays
          for (let n = 0; n < 8; n++) {
            const ngx = gx + NEIGHBOR_DX[n];
            const ngy = gy + NEIGHBOR_DY[n];
            const neighborKey = ngx * 1000000 + ngy;
            
            if (gridSet.has(neighborKey)) {
              // Create edge key - use consistent ordering to avoid duplicates
              const edgeKey = gx < ngx || (gx === ngx && gy < ngy)
                ? gx * 1e12 + gy * 1e6 + ngx * 1e3 + ngy
                : ngx * 1e12 + ngy * 1e6 + gx * 1e3 + gy;
              
              if (!drawnEdges.has(edgeKey)) {
                drawnEdges.add(edgeKey);
                
                const neighbor = nodesByGrid.get(neighborKey);
                if (neighbor) {
                  const p1 = map.latLngToContainerPoint([node.lat, node.lon]);
                  const p2 = map.latLngToContainerPoint([neighbor.lat, neighbor.lon]);
                  ctx.moveTo(p1.x, p1.y);
                  ctx.lineTo(p2.x, p2.y);
                }
              }
            }
          }
        }
        
        ctx.stroke();
      } else {
        // Points mode: draw individual dots with batched drawing by alpha
        // Group points by alpha to minimize fillStyle changes
        const TWO_PI = Math.PI * 2;
        const nodeCount = currentNodes.length;
        
        // Pre-calculate visible points and their alphas
        for (let i = 0; i < nodeCount; i++) {
          const node = currentNodes[i];
          const age = now - node.timestamp;
          
          // Skip if fully faded
          if (age > persistDuration + fadeOutDuration) continue;
          
          // Calculate opacity
          let alpha = baseAlpha;
          if (age > persistDuration) {
            const fadeProgress = (age - persistDuration) / fadeOutDuration;
            alpha = baseAlpha * (1 - fadeProgress);
          }
          
          if (alpha <= 0) continue;
          
          // Convert lat/lng to container point
          const point = map.latLngToContainerPoint([node.lat, node.lon]);
          
          // Draw point - batch begin/fill for same alpha
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
          ctx.beginPath();
          ctx.arc(point.x, point.y, radius, 0, TWO_PI);
          ctx.fill();
        }
      }
      
      animationFrameRef.current = requestAnimationFrame(render);
    };
    
    animationFrameRef.current = requestAnimationFrame(render);
    
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [map, fadeOutDuration, radius, color, persistDuration, mode, lineWidth]);
  
  // Re-render on map events
  useEffect(() => {
    const updateCanvas = () => {
      const canvas = canvasRef.current;
      if (canvas) {
        const size = map.getSize();
        if (canvas.width !== size.x || canvas.height !== size.y) {
          canvas.width = size.x;
          canvas.height = size.y;
        }
      }
    };
    
    map.on('zoom zoomend moveend resize', updateCanvas);
    
    return () => {
      map.off('zoom zoomend moveend resize', updateCanvas);
    };
  }, [map]);
  
  return null;
}
