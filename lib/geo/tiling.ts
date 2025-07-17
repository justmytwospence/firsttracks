import type { Bounds } from "@/app/actions/findPath";
import { prisma } from "@/lib/prisma";

export async function insertGeoTiff(geoTiff: Buffer) {
  await prisma.$transaction(async (tx) => {
    // Set memory and timeout settings individually
    await tx.$executeRaw`SET LOCAL work_mem = '256MB'`;
    await tx.$executeRaw`SET LOCAL maintenance_work_mem = '1GB'`;
    await tx.$executeRaw`SET LOCAL statement_timeout = 300000`; // 5 minutes in ms

    const tileSize = 256; // Define tile size in desired units (e.g., pixels)

    // Execute the INSERT statement with tagged template literal for proper parameter binding
    try {
      await tx.$executeRaw`
        WITH base_raster AS (
          SELECT ST_FromGDALRaster(${geoTiff}, 4269) AS rast
        ),
        aligned_raster AS (
          SELECT ST_SnapToGrid(rast, CAST(${tileSize} AS INTEGER), CAST(${tileSize} AS INTEGER), 0, 0) AS rast FROM base_raster
        ),
        tiled_rasters AS (
          SELECT ST_Tile(rast, CAST(${tileSize} AS INTEGER), CAST(${tileSize} AS INTEGER)) AS rast FROM aligned_raster
        )
        INSERT INTO "ElevationTile" (rast)
        SELECT rast
        FROM tiled_rasters
        WHERE NOT EXISTS (
          SELECT 1
          FROM "ElevationTile" et
          WHERE ST_Intersects(et.rast, ST_Envelope(tiled_rasters.rast))
            AND ST_NumBands(et.rast) = ST_NumBands(tiled_rasters.rast) -- Ensure full data coverage
        )
        AND NOT ST_IsEmpty(rast);
      `;
    } catch (error) {
      console.error("Failed to insert GeoTIFF:", error);
      throw error;
    }
  }, {
    maxWait: 305000  // Keep a slightly higher maxWait for cleanup
  });
}

export async function checkGeoTIFFCache(bounds: Bounds): Promise<boolean> {
  const { north, south, east, west } = bounds;
  const cacheCheck = await prisma.$queryRaw<{ is_contained: boolean }[]>`
    WITH 
    bbox AS (
      SELECT ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4269) AS bbox
    ),
    coverage AS (
      SELECT ST_Union(raster_valued_extent) AS coverage
      FROM "ElevationTile"
    )
    SELECT 
      ST_Contains(coverage, (SELECT bbox FROM bbox)) AS is_contained
      FROM coverage;
  `;
  console.log(cacheCheck)
  return cacheCheck?.[0]?.is_contained ?? false;
}

export async function getGeoTiff(bounds: Bounds) {
  const { north, south, east, west } = bounds;
  const geoTiff = await prisma.$queryRaw< { tiff: Buffer }[]>`
    SELECT ST_AsGDALRaster(ST_Union(rast), 'GTiff') AS tiff
    FROM "ElevationTile"
    WHERE ST_Intersects(rast, ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4269));
  `;
  return geoTiff[0].tiff;
}