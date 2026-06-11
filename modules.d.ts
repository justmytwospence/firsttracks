// Type declarations for dependencies that ship no types.

declare module "georaster" {
  export interface GeoRaster {
    xmin: number;
    ymin: number;
    xmax: number;
    ymax: number;
    pixelWidth: number;
    pixelHeight: number;
    width: number;
    height: number;
    noDataValue: number | null;
    projection: number;
    /** Band-major: values[band][row] is one row of samples. */
    values: Float32Array[][];
  }

  function parseGeoraster(
    values: Float32Array[][] | ArrayBuffer,
    metadata?: Record<string, unknown>,
  ): Promise<GeoRaster>;

  export default parseGeoraster;
}

declare module "togpx" {
  import type { Feature, FeatureCollection, Geometry } from "geojson";

  function togpx(
    geojson: FeatureCollection | Feature | Geometry,
    options?: Record<string, unknown>,
  ): string;

  export default togpx;
}
