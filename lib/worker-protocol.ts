/**
 * Pure helpers for the pathfinder worker protocol — no WASM or worker globals,
 * so they're unit-testable without spinning up a real Worker.
 */

export interface BoundsLike {
  north: number;
  south: number;
  east: number;
  west: number;
}

/** Degrees-per-pixel geo-transform. pixelScaleY is negative (lat decreases as raster y increases). */
export function pixelScaleFromBounds(bounds: BoundsLike, width: number, height: number) {
  const pixelScaleX = (bounds.east - bounds.west) / width;
  const pixelScaleY = (bounds.south - bounds.north) / height;
  return { pixelScaleX, pixelScaleY };
}

export interface ExplorationConstants {
  originX: number;
  originY: number;
  scaleX: number;
  scaleY: number;
  width: number;
  height: number;
}

export interface ExplorationBatch extends ExplorationConstants {
  cells: Uint16Array;
}

type RawCallbackData = { type?: string; cells?: Uint16Array } & Partial<ExplorationConstants>;

/**
 * Two-phase exploration reassembler. Rust sends one `init` message with the
 * geo-transform constants, then repeated `cells` batches. This caches the
 * constants and merges them into each batch, calling `emit` with the flat
 * shape the leaflet overlay expects. Batches arriving before `init` (or with
 * no cells) are dropped.
 */
export function createExplorationReassembler(
  emit: (batch: ExplorationBatch) => void,
): (data: RawCallbackData) => void {
  let cached: ExplorationConstants | null = null;

  return (data: RawCallbackData) => {
    if (data.type === 'init') {
      cached = {
        originX: data.originX as number,
        originY: data.originY as number,
        scaleX: data.scaleX as number,
        scaleY: data.scaleY as number,
        width: data.width as number,
        height: data.height as number,
      };
      return;
    }
    if (!cached || !data.cells) return;
    emit({ cells: data.cells, ...cached });
  };
}
