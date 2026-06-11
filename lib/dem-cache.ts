/**
 * DEM Cache Service - barrel module.
 *
 * Client-side caching for DEM (Digital Elevation Model) data using IndexedDB.
 * Implementation lives in tile-math, terrarium, idb, dem-store, and
 * azimuth-store; this module re-exports the public surface.
 */

export {
  type Bounds,
  type ElevationGrid,
  type ProgressInfo,
  type ProgressCallback,
  boundsContain,
  expandBounds,
  getTilesForBounds,
  latLngToTile,
  tileToLatLng,
  unionBounds,
} from './tile-math';
export { decodeTerrarium } from './terrarium';
export {
  getCachedIndividualTilesBounds,
  getCachedIndividualTilesRegions,
  getDEMWithContainsCheck,
} from './dem-store';
export {
  type AzimuthData,
  cacheAzimuths,
  findCachedAzimuthBoundsContaining,
  findContainingCachedAzimuths,
  getAzimuthsWithContainsCheck,
  getCachedAzimuths,
  getFirstCachedAzimuths,
} from './azimuth-store';
