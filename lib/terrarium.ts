/**
 * AWS Terrain Tiles (Terrarium format) fetching and decoding.
 */

/**
 * AWS Terrain Tiles configuration
 * - Zoom 14 provides ~10m resolution (comparable to USGS10m)
 * - Each tile is 256x256 pixels
 * - Terrarium format: elevation = (red * 256 + green + blue / 256) - 32768
 */
const TERRAIN_TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

/**
 * Decode Terrarium format PNG elevation data.
 * Formula: elevation = (red * 256 + green + blue / 256) - 32768
 * Note: JS operator precedence means this is evaluated as: ((red * 256) + green + (blue / 256)) - 32768
 * Returns elevation values in meters as Float32Array.
 */
export function decodeTerrarium(imageData: ImageData): Float32Array {
  const { data, width, height } = imageData;
  const elevations = new Float32Array(width * height);
  
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    elevations[i] = (r * 256 + g + b / 256) - 32768;
  }
  
  return elevations;
}

/**
 * Fetch a single terrain tile from AWS S3 and decode its elevation data.
 */
export async function fetchTerrainTile(x: number, y: number, zoom: number): Promise<Float32Array> {
  const url = `${TERRAIN_TILE_URL}/${zoom}/${x}/${y}.png`;

  // AWS terrain tiles return no Cache-Control header (only Last-Modified from 2017).
  // 'force-cache' lets the browser serve any HTTP-cached copy without revalidation;
  // safe because terrain tiles are immutable. Transient network/S3 errors are
  // retried so one hiccup doesn't reject the whole Promise.all of a fetch.
  const MAX_ATTEMPTS = 3;
  let response: Response | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      response = await fetch(url, { cache: 'force-cache' });
      // 4xx is definitive; only retry server errors.
      if (response.ok || response.status < 500) break;
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
      response = undefined;
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
  if (!response || !response.ok) {
    throw new Error(`Failed to fetch terrain tile ${zoom}/${x}/${y}: ${response?.status}`);
  }

  const blob = await response.blob();
  // Terrarium decoding needs bit-exact RGB: without these options browsers
  // (Safari especially) may color-manage the PNG, and 1 LSB of green is a
  // full meter of elevation error.
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  
  // Use OffscreenCanvas to extract pixel data
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Failed to get 2D context');
  }
  
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  
  return decodeTerrarium(imageData);
}
