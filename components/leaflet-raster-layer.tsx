import type { Aspect } from "@/components/ui/select-aspects-dialog";
import type { GeoRaster } from "georaster";
import L from "leaflet";
import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";

// Returns a value from 0 to 1 indicating how strongly the azimuth falls within the aspect
// 0 = not in aspect at all, 1 = fully in the center of the aspect
function getAspectIntensity(aspect: Aspect, azimuth: number): number {
  const ASPECT_WIDTH = 45; // degrees for each aspect (360/8)
  const HALF_WIDTH = ASPECT_WIDTH / 2;
  
  // Get the center azimuth for each aspect
  const aspectCenters: Record<string, number> = {
    north: 0,
    northeast: 45,
    east: 90,
    southeast: 135,
    south: 180,
    southwest: 225,
    west: 270,
    northwest: 315,
  };
  
  if (aspect === "flat") {
    return azimuth === -1.0 ? 1.0 : 0.0;
  }
  
  const center = aspectCenters[aspect];
  if (center === undefined) return 0;
  
  // Calculate angular distance, handling wraparound for north
  let distance = Math.abs(azimuth - center);
  if (distance > 180) {
    distance = 360 - distance;
  }
  
  // If within the aspect range, return intensity based on distance from center
  // Using a smooth falloff that reaches 0 at the boundaries
  if (distance <= HALF_WIDTH + 10) { // Add soft transition zone of 10 degrees
    // Smooth cosine falloff for natural blending
    const normalizedDistance = distance / (HALF_WIDTH + 10);
    return Math.max(0, Math.cos(normalizedDistance * Math.PI / 2));
  }
  
  return 0;
}

// Get interpolation parameters for a raster position
function getInterpolationParams(
  x: number,
  y: number,
  width: number,
  height: number
): { x0: number; y0: number; x1: number; y1: number; xFrac: number; yFrac: number } {
  const x0 = Math.max(0, Math.min(width - 2, Math.floor(x)));
  const y0 = Math.max(0, Math.min(height - 2, Math.floor(y)));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const xFrac = x - x0;
  const yFrac = y - y0;
  return { x0, y0, x1, y1, xFrac, yFrac };
}

// Bilinear interpolation for smooth sampling between raster pixels
function bilinearInterpolate(
  values: number[][],
  x: number,
  y: number,
  width: number,
  height: number
): number {
  const { x0, y0, x1, y1, xFrac, yFrac } = getInterpolationParams(x, y, width, height);
  
  // Get the four surrounding values
  const v00 = values[y0]?.[x0] ?? 0;
  const v10 = values[y0]?.[x1] ?? 0;
  const v01 = values[y1]?.[x0] ?? 0;
  const v11 = values[y1]?.[x1] ?? 0;
  
  // Bilinear interpolation
  const v0 = v00 * (1 - xFrac) + v10 * xFrac;
  const v1 = v01 * (1 - xFrac) + v11 * xFrac;
  return v0 * (1 - yFrac) + v1 * yFrac;
}

// Compute aspect intensity with bilinear interpolation of intensities (not azimuths)
// This avoids artifacts from interpolating circular azimuth values
function getInterpolatedAspectIntensity(
  azimuthValues: number[][],
  gradientValues: number[][],
  x: number,
  y: number,
  width: number,
  height: number,
  excludedAspects: Aspect[]
): { intensity: number; gradient: number } {
  const { x0, y0, x1, y1, xFrac, yFrac } = getInterpolationParams(x, y, width, height);
  
  // Get azimuth and gradient values at four corners
  const az00 = azimuthValues[y0]?.[x0] ?? 0;
  const az10 = azimuthValues[y0]?.[x1] ?? 0;
  const az01 = azimuthValues[y1]?.[x0] ?? 0;
  const az11 = azimuthValues[y1]?.[x1] ?? 0;
  
  const gr00 = Math.abs(gradientValues[y0]?.[x0] ?? 0);
  const gr10 = Math.abs(gradientValues[y0]?.[x1] ?? 0);
  const gr01 = Math.abs(gradientValues[y1]?.[x0] ?? 0);
  const gr11 = Math.abs(gradientValues[y1]?.[x1] ?? 0);
  
  // Compute intensity at each corner (for all excluded aspects)
  let int00 = 0, int10 = 0, int01 = 0, int11 = 0;
  for (const aspect of excludedAspects) {
    int00 = Math.max(int00, getAspectIntensity(aspect, az00));
    int10 = Math.max(int10, getAspectIntensity(aspect, az10));
    int01 = Math.max(int01, getAspectIntensity(aspect, az01));
    int11 = Math.max(int11, getAspectIntensity(aspect, az11));
  }
  
  // Bilinearly interpolate the intensities (not the azimuths!)
  const int0 = int00 * (1 - xFrac) + int10 * xFrac;
  const int1 = int01 * (1 - xFrac) + int11 * xFrac;
  const intensity = int0 * (1 - yFrac) + int1 * yFrac;
  
  // Also interpolate gradient for opacity calculation
  const gr0 = gr00 * (1 - xFrac) + gr10 * xFrac;
  const gr1 = gr01 * (1 - xFrac) + gr11 * xFrac;
  const gradient = gr0 * (1 - yFrac) + gr1 * yFrac;
  
  return { intensity, gradient };
}

interface LeafletRasterLayerProps {
  aspectRaster: GeoRaster;
  excludedAspects: Aspect[];
  avoidRunoutZones?: boolean;
}

// Custom Leaflet layer class for smooth raster rendering
class SmoothRasterOverlay extends L.Layer {
  private canvas: HTMLCanvasElement | null = null;
  private raster: GeoRaster;
  private excludedAspects: Aspect[];
  private avoidRunoutZones: boolean;
  private animationFrameId: number | null = null;
  private static readonly FADE_DURATION = 300; // ms

  constructor(raster: GeoRaster, excludedAspects: Aspect[], avoidRunoutZones = true) {
    super();
    this.raster = raster;
    this.excludedAspects = excludedAspects;
    this.avoidRunoutZones = avoidRunoutZones;
  }

  onAdd(map: L.Map): this {
    this.canvas = L.DomUtil.create('canvas', 'leaflet-smooth-raster-layer') as HTMLCanvasElement;
    this.canvas.style.position = 'absolute';
    this.canvas.style.pointerEvents = 'none';
    this.canvas.style.transition = `opacity ${SmoothRasterOverlay.FADE_DURATION}ms ease-in-out`;
    this.canvas.style.opacity = '0';
    
    const pane = map.getPane('overlayPane');
    if (pane) {
      pane.appendChild(this.canvas);
    }

    map.on('moveend', this.redraw, this);
    map.on('zoomend', this.redraw, this);
    map.on('resize', this.redraw, this);

    this.redraw();
    
    // Trigger fade in after canvas is added to DOM
    requestAnimationFrame(() => {
      if (this.canvas) {
        this.canvas.style.opacity = '1';
      }
    });
    
    return this;
  }

  onRemove(map: L.Map): this {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    
    map.off('moveend', this.redraw, this);
    map.off('zoomend', this.redraw, this);
    map.off('resize', this.redraw, this);
    
    // Fade out before removing from DOM
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.style.opacity = '0';
      const canvas = this.canvas;
      setTimeout(() => {
        if (canvas.parentNode) {
          canvas.parentNode.removeChild(canvas);
        }
      }, SmoothRasterOverlay.FADE_DURATION);
    }
    
    return this;
  }

  updateExcludedAspects(excludedAspects: Aspect[]): void {
    this.excludedAspects = excludedAspects;
    this.redraw();
  }

  updateAvoidRunoutZones(avoidRunoutZones: boolean): void {
    this.avoidRunoutZones = avoidRunoutZones;
    this.redraw();
  }

  private redraw = (): void => {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    this.animationFrameId = requestAnimationFrame(() => this.render());
  };

  private render(): void {
    const map = this._map;
    if (!map || !this.canvas) return;

    const size = map.getSize();
    const bounds = map.getBounds();
    const topLeft = map.latLngToLayerPoint(bounds.getNorthWest());

    // Set canvas size and position
    this.canvas.width = size.x;
    this.canvas.height = size.y;
    this.canvas.style.width = `${size.x}px`;
    this.canvas.style.height = `${size.y}px`;
    L.DomUtil.setPosition(this.canvas, topLeft);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, size.x, size.y);

    // If no aspects to exclude, nothing to render
    if (this.excludedAspects.length === 0) return;

    const { xmin, ymax, pixelWidth, pixelHeight, values, width, height } = this.raster;
    const azimuthValues = values[0]; // First band is azimuths
    const gradientValues = values[1]; // Second band is gradients
    const runoutValues = values[2]; // Third band is runout zones (may be undefined)

    // Get map bounds in geographic coordinates
    const west = bounds.getWest();
    const east = bounds.getEast();
    const north = bounds.getNorth();
    const south = bounds.getSouth();

    // Create ImageData for pixel manipulation
    const imageData = ctx.createImageData(size.x, size.y);
    const data = imageData.data;

    // Render each screen pixel
    for (let screenY = 0; screenY < size.y; screenY++) {
      for (let screenX = 0; screenX < size.x; screenX++) {
        // Convert screen coordinates to geographic coordinates
        const lng = west + (screenX / size.x) * (east - west);
        const lat = north - (screenY / size.y) * (north - south);

        // Convert geographic coordinates to raster pixel coordinates
        const rasterX = (lng - xmin) / pixelWidth;
        const rasterY = (ymax - lat) / Math.abs(pixelHeight);

        // Check if within raster bounds
        if (rasterX < 0 || rasterX >= width || rasterY < 0 || rasterY >= height) {
          continue;
        }

        const pixelIndex = (screenY * size.x + screenX) * 4;
        
        // Check for runout zone first (renders in amber/orange with intensity-based alpha)
        if (runoutValues) {
          const runoutIntensity = bilinearInterpolate(runoutValues, rasterX, rasterY, width, height);
          if (runoutIntensity > 0.005) {
            // Runout zone - render in amber with intensity-based alpha
            // Dim when not being avoided in pathfinding (visual feedback)
            const opacityMultiplier = this.avoidRunoutZones ? 1.0 : 0.35;
            const alpha = Math.min(runoutIntensity * 0.8, 0.7) * opacityMultiplier;
            
            data[pixelIndex] = 245;     // Red
            data[pixelIndex + 1] = 158; // Green
            data[pixelIndex + 2] = 11;  // Blue
            data[pixelIndex + 3] = Math.round(alpha * 255);
            continue; // Skip aspect rendering for runout pixels
          }
        }

        // Use bilinear interpolation of intensities (not raw azimuths) for smooth results
        const { intensity, gradient } = getInterpolatedAspectIntensity(
          azimuthValues,
          gradientValues,
          rasterX,
          rasterY,
          width,
          height,
          this.excludedAspects
        );

        // Only show red shading for slopes >= 10° (tan(10°) ≈ 0.176)
        // Flatter terrain below this threshold shows as runout (amber) instead
        const RED_GRADIENT_THRESHOLD = 0.176;
        
        if (intensity > 0 && gradient >= RED_GRADIENT_THRESHOLD) {
          // Apply gradient-based opacity with smooth falloff from aspect boundaries
          // Use higher minimum opacity to prevent gaps at lower gradients
          const baseOpacity = Math.max(0.25, Math.min(gradient * 0.5, 0.8));
          const opacity = baseOpacity * intensity;

          data[pixelIndex] = 255;     // Red
          data[pixelIndex + 1] = 0;   // Green
          data[pixelIndex + 2] = 0;   // Blue
          data[pixelIndex + 3] = Math.round(opacity * 255); // Alpha
        }
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }
}

export default function LeafletRasterLayer({
  aspectRaster,
  excludedAspects,
  avoidRunoutZones = true,
}: LeafletRasterLayerProps) {
  const map = useMap();
  const layerRef = useRef<SmoothRasterOverlay | null>(null);

  useEffect(() => {
    layerRef.current = new SmoothRasterOverlay(aspectRaster, excludedAspects, avoidRunoutZones);
    layerRef.current.addTo(map);

    return () => {
      layerRef.current?.remove();
    };
  }, [aspectRaster, map, excludedAspects, avoidRunoutZones]);

  // Update excluded aspects without recreating the layer
  useEffect(() => {
    if (layerRef.current) {
      layerRef.current.updateExcludedAspects(excludedAspects);
    }
  }, [excludedAspects]);

  // Update avoidRunoutZones without recreating the layer
  useEffect(() => {
    if (layerRef.current) {
      layerRef.current.updateAvoidRunoutZones(avoidRunoutZones);
    }
  }, [avoidRunoutZones]);

  return null;
}
