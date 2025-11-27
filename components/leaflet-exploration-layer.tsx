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
  
  // Keep nodes ref updated
  useEffect(() => {
    nodesRef.current = nodes;
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
        
        // Handle map move/resize
        leafletMap.on('move', this._updatePosition, this);
        leafletMap.on('resize', this._onResize, this);
        
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
      },
      
      _onResize() {
        if (!canvasRef.current) return;
        const size = map.getSize();
        canvasRef.current.width = size.x;
        canvasRef.current.height = size.y;
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
        
        // DEM cell size is approximately 1/10800 degrees (~10m at equator)
        const cellSize = 1 / 10800;
        
        // Build a set of grid positions for fast lookup
        // Round to grid cells for comparison
        const toGridKey = (lon: number, lat: number) => {
          const gx = Math.round(lon / cellSize);
          const gy = Math.round(lat / cellSize);
          return `${gx},${gy}`;
        };
        
        const gridSet = new Set<string>();
        const nodesByGrid = new Map<string, typeof visibleNodes[0]>();
        
        for (const node of visibleNodes) {
          const key = toGridKey(node.lon, node.lat);
          gridSet.add(key);
          nodesByGrid.set(key, node);
        }
        
        // Calculate average alpha
        let totalAlpha = 0;
        const now2 = Date.now();
        for (const node of visibleNodes) {
          const age = now2 - node.timestamp;
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
        
        const drawnEdges = new Set<string>();
        
        for (const node of visibleNodes) {
          const gx = Math.round(node.lon / cellSize);
          const gy = Math.round(node.lat / cellSize);
          
          // Check all 8 neighbors
          for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
              if (dx === 0 && dy === 0) continue;
              
              const neighborKey = `${gx + dx},${gy + dy}`;
              if (gridSet.has(neighborKey)) {
                // Create edge key to avoid drawing twice
                const edgeKey = gx < gx + dx || (gx === gx + dx && gy < gy + dy)
                  ? `${gx},${gy}-${gx + dx},${gy + dy}`
                  : `${gx + dx},${gy + dy}-${gx},${gy}`;
                
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
        }
        
        ctx.stroke();
      } else {
        // Points mode: draw individual dots (original behavior)
        for (const node of currentNodes) {
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
          
          // Draw point
          ctx.beginPath();
          ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
