use georaster::geotiff::GeoTiffReader;
use js_sys::Float32Array;
use serde::{Deserialize, Serialize};
use std::{f64::consts::PI, io::Cursor};
use wasm_bindgen::prelude::*;

use crate::console_log::console_log;
use crate::geotiff::serialize_to_geotiff_flat;
use crate::raster::get_raster_flat;

/// Sentinel value for "flat" azimuth (no defined slope direction).
const AZIMUTH_FLAT: f32 = -1.0;

/// Tolerance (degrees) applied when matching an azimuth against an excluded
/// aspect. Shared by runout source selection and the pathfinder's aspect rule
/// so both agree on exactly which cells count as dangerous.
pub const ASPECT_TOLERANCE_DEG: f64 = 22.5;

/// Approximate meters per degree of latitude (good to 0.5% across the globe).
const METERS_PER_DEG_LAT: f64 = 110540.0;
/// Meters per degree of longitude at the equator. Multiply by cos(lat) at other latitudes.
const METERS_PER_DEG_LON_EQUATOR: f64 = 111320.0;

/// Sobel response for a uniformly tilted plane: response = SOBEL_NORMALIZER * slope * pixel_size.
/// Derived from sum_ij(k_ij * (j-2)) for the gx kernel: 28 + 52 + 80 + 52 + 28 = 240.
const SOBEL_NORMALIZER: f64 = 240.0;

/// 5x5 Sobel kernel for x-derivative (column gradient). Flat row-major.
#[rustfmt::skip]
const GX_KERNEL: [f64; 25] = [
  -5.0,  -4.0,  0.0,  4.0,  5.0,
  -8.0, -10.0,  0.0, 10.0,  8.0,
 -10.0, -20.0,  0.0, 20.0, 10.0,
  -8.0, -10.0,  0.0, 10.0,  8.0,
  -5.0,  -4.0,  0.0,  4.0,  5.0,
];

/// 5x5 Sobel kernel for y-derivative (row gradient). Flat row-major.
#[rustfmt::skip]
const GY_KERNEL: [f64; 25] = [
  -5.0,  -8.0, -10.0,  -8.0, -5.0,
  -4.0, -10.0, -20.0, -10.0, -4.0,
   0.0,   0.0,   0.0,   0.0,  0.0,
   4.0,  10.0,  20.0,  10.0,  4.0,
   5.0,   8.0,  10.0,   8.0,  5.0,
];

#[wasm_bindgen]
pub struct AzimuthResult {
  elevations: Vec<u8>,
  azimuths: Vec<u8>,
  gradients: Vec<u8>,
  runout_zones: Vec<u8>,
}

#[wasm_bindgen]
impl AzimuthResult {
  #[wasm_bindgen(getter)]
  pub fn elevations(&self) -> Vec<u8> { self.elevations.clone() }
  #[wasm_bindgen(getter)]
  pub fn azimuths(&self) -> Vec<u8> { self.azimuths.clone() }
  #[wasm_bindgen(getter)]
  pub fn gradients(&self) -> Vec<u8> { self.gradients.clone() }
  #[wasm_bindgen(getter)]
  pub fn runout_zones(&self) -> Vec<u8> { self.runout_zones.clone() }
}

#[wasm_bindgen]
pub struct AzimuthArrayResult {
  elevations: Vec<f32>,
  azimuths: Vec<f32>,
  gradients: Vec<f32>,
  runout_zones: Vec<f32>,
  width: u32,
  height: u32,
}

#[wasm_bindgen]
impl AzimuthArrayResult {
  #[wasm_bindgen]
  pub fn get_elevations(&self) -> Float32Array { Float32Array::from(&self.elevations[..]) }
  #[wasm_bindgen]
  pub fn get_azimuths(&self) -> Float32Array { Float32Array::from(&self.azimuths[..]) }
  #[wasm_bindgen]
  pub fn get_gradients(&self) -> Float32Array { Float32Array::from(&self.gradients[..]) }
  #[wasm_bindgen]
  pub fn get_runout_zones(&self) -> Float32Array { Float32Array::from(&self.runout_zones[..]) }
  #[wasm_bindgen(getter)]
  pub fn width(&self) -> u32 { self.width }
  #[wasm_bindgen(getter)]
  pub fn height(&self) -> u32 { self.height }
  #[wasm_bindgen]
  pub fn into_elevations(self) -> Vec<f32> { self.elevations }
  #[wasm_bindgen]
  pub fn into_azimuths(self) -> Vec<f32> { self.azimuths }
  #[wasm_bindgen]
  pub fn into_gradients(self) -> Vec<f32> { self.gradients }
  #[wasm_bindgen]
  pub fn into_runout_zones(self) -> Vec<f32> { self.runout_zones }
}

#[derive(PartialEq, Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Aspect {
  North,
  Northeast,
  East,
  Southeast,
  South,
  Southwest,
  West,
  Northwest,
  Flat,
}

impl Aspect {
  pub fn from_azimuth(azimuth: f64) -> Aspect {
    if azimuth < 0.0 || azimuth.is_nan() {
      return Aspect::Flat;
    }
    let normalized = azimuth.rem_euclid(360.0);
    if normalized < 22.5 || normalized >= 337.5 {
      Aspect::North
    } else if normalized < 67.5 {
      Aspect::Northeast
    } else if normalized < 112.5 {
      Aspect::East
    } else if normalized < 157.5 {
      Aspect::Southeast
    } else if normalized < 202.5 {
      Aspect::South
    } else if normalized < 247.5 {
      Aspect::Southwest
    } else if normalized < 292.5 {
      Aspect::West
    } else {
      Aspect::Northwest
    }
  }

  pub fn contains_azimuth(&self, azimuth: f64, tolerance: Option<f64>) -> bool {
    if azimuth.is_nan() || azimuth < -1.5 || azimuth > 360.0 {
      return false;
    }
    let tolerance: f64 = tolerance.unwrap_or(0.0);
    match self {
      Aspect::Northeast => (22.5 - tolerance) <= azimuth && azimuth <= (67.5 + tolerance),
      Aspect::East => (67.5 - tolerance) <= azimuth && azimuth <= (112.5 + tolerance),
      Aspect::Southeast => (112.5 - tolerance) <= azimuth && azimuth <= (157.5 + tolerance),
      Aspect::South => (157.5 - tolerance) <= azimuth && azimuth <= (202.5 + tolerance),
      Aspect::Southwest => (202.5 - tolerance) <= azimuth && azimuth <= (247.5 + tolerance),
      Aspect::West => (247.5 - tolerance) <= azimuth && azimuth <= (292.5 + tolerance),
      Aspect::Northwest => (292.5 - tolerance) <= azimuth && azimuth <= (337.5 + tolerance),
      Aspect::North => {
        (azimuth >= 0.0 && azimuth <= 22.5 + tolerance)
          || (azimuth >= 337.5 - tolerance && azimuth <= 360.0)
      }
      Aspect::Flat => azimuth < 0.0,
    }
  }

}

/// Parse a JS excluded-aspects array. A malformed list is a hard error:
/// silently dropping exclusions would route through terrain the user asked
/// to avoid.
pub fn parse_excluded_aspects(value: JsValue) -> Result<Vec<Aspect>, JsValue> {
  if value.is_undefined() || value.is_null() {
    return Ok(vec![]);
  }
  serde_wasm_bindgen::from_value(value)
    .map_err(|e| JsValue::from_str(&format!("Invalid excluded_aspects: {}", e)))
}

/// Per-cell "is this azimuth on an excluded aspect" mask, using the same
/// `contains_azimuth` tolerance as the pathfinder's aspect rule. This is the
/// single definition of "dangerous aspect" — runout sources and A* blocking
/// must never disagree about which cells qualify.
fn build_excluded_azimuth_mask(azimuths: &[f32], excluded: &[Aspect]) -> Vec<bool> {
  azimuths
    .iter()
    .map(|&az| {
      let az = az as f64;
      excluded.iter().any(|a| a.contains_azimuth(az, Some(ASPECT_TOLERANCE_DEG)))
    })
    .collect()
}

/// Calculate azimuth (degrees, 0..360, or -1 for flat) from horizontal (gx)
/// and vertical (gy) Sobel responses.
pub fn calculate_azimuth(gx: f64, gy: f64) -> f64 {
  // NaN responses (nodata in the Sobel window) are treated as flat rather
  // than letting NaN propagate into the azimuth raster.
  if gx.is_nan() || gy.is_nan() || (gx == 0.0 && gy == 0.0) {
    return AZIMUTH_FLAT as f64;
  }
  // Invert gx so that east-rising terrain reports a west-facing aspect (descent direction).
  let azimuth_radians = (-gx).atan2(gy);
  let mut azimuth_degrees = azimuth_radians * 180.0 / PI;
  if azimuth_degrees < 0.0 {
    azimuth_degrees += 360.0;
  }
  azimuth_degrees
}

/// Pixel size in meters at the given latitude, given a degrees-per-pixel scale.
pub fn deg_pixel_to_meters(pixel_scale_deg: [f64; 2], lat_deg: f64) -> (f64, f64) {
  let cos_lat = (lat_deg * PI / 180.0).cos().abs();
  let px_x = pixel_scale_deg[0].abs() * cos_lat * METERS_PER_DEG_LON_EQUATOR;
  let px_y = pixel_scale_deg[1].abs() * METERS_PER_DEG_LAT;
  (px_x, px_y)
}

/// Apply the 5x5 Sobel kernels to a flat row-major elevation buffer.
/// Returns `(azimuths, gradients)`, both row-major and length width*height.
/// The 2-pixel border is initialised to (-1.0, 0.0) — i.e. Aspect::Flat with zero slope.
pub fn compute_sobel_flat(
  elevations: &[f32],
  width: usize,
  height: usize,
  pixel_size_x_m: f64,
  pixel_size_y_m: f64,
) -> (Vec<f32>, Vec<f32>) {
  let n = width * height;
  let mut azimuths = vec![AZIMUTH_FLAT; n];
  let mut gradients = vec![0.0f32; n];

  if width < 5 || height < 5 {
    return (azimuths, gradients);
  }

  let inv_norm_x = 1.0 / (SOBEL_NORMALIZER * pixel_size_x_m);
  let inv_norm_y = 1.0 / (SOBEL_NORMALIZER * pixel_size_y_m);

  for i in 2..(height - 2) {
    let row_out = i * width;
    for j in 2..(width - 2) {
      let mut gx = 0.0f64;
      let mut gy = 0.0f64;
      for ki in 0..5 {
        let row_in = (i + ki - 2) * width;
        let k_row = ki * 5;
        for kj in 0..5 {
          let pixel_value = elevations[row_in + j + kj - 2] as f64;
          gx += pixel_value * GX_KERNEL[k_row + kj];
          gy += pixel_value * GY_KERNEL[k_row + kj];
        }
      }
      // Normalize per-axis BEFORE computing the direction: with anisotropic
      // pixels (degree rasters: px_x = px_y * cos(lat)) the raw kernel sums
      // are scaled differently per axis, which would skew azimuths toward
      // the N-S axis (~11 degrees at 47N for a true 45-degree aspect).
      let gx_n = gx * inv_norm_x;
      let gy_n = gy * inv_norm_y;
      let azimuth = calculate_azimuth(gx_n, gy_n);
      let out_idx = row_out + j;
      azimuths[out_idx] = azimuth as f32;
      if azimuth >= 0.0 {
        gradients[out_idx] = ((gx_n * gx_n) + (gy_n * gy_n)).sqrt() as f32;
      }
    }
  }

  (azimuths, gradients)
}

// ---------------------------------------------------------------------------
// D8 flow direction
// ---------------------------------------------------------------------------

/// D8 neighbour offsets keyed by direction: 0=N, 1=NE, 2=E, 3=SE, 4=S, 5=SW, 6=W, 7=NW.
pub const D8_OFFSETS: [(isize, isize); 8] = [
  (-1, 0), (-1, 1), (0, 1), (1, 1),
  (1, 0), (1, -1), (0, -1), (-1, -1),
];

/// Distance weight: 1.0 for cardinals, sqrt(2) for diagonals.
const D8_WEIGHTS: [f64; 8] = [
  1.0, std::f64::consts::SQRT_2, 1.0, std::f64::consts::SQRT_2,
  1.0, std::f64::consts::SQRT_2, 1.0, std::f64::consts::SQRT_2,
];

/// Compute D8 flow direction (steepest downhill neighbour) for each interior cell.
/// Returns flat row-major buffer; cells with no downhill neighbour or on the
/// border are marked with 255.
pub fn compute_d8_flow_directions_flat(elevations: &[f32], width: usize, height: usize) -> Vec<u8> {
  let mut flow_dir = vec![255u8; width * height];
  if width < 3 || height < 3 {
    return flow_dir;
  }
  for i in 1..(height - 1) {
    for j in 1..(width - 1) {
      let center = elevations[i * width + j];
      let mut steepest_slope = 0.0f64;
      let mut steepest_dir: u8 = 255;
      for (dir, &(dy, dx)) in D8_OFFSETS.iter().enumerate() {
        let ny = (i as isize + dy) as usize;
        let nx = (j as isize + dx) as usize;
        let drop = (center - elevations[ny * width + nx]) as f64;
        if drop > 0.0 {
          let slope = drop / D8_WEIGHTS[dir];
          if slope > steepest_slope {
            steepest_slope = slope;
            steepest_dir = dir as u8;
          }
        }
      }
      flow_dir[i * width + j] = steepest_dir;
    }
  }
  flow_dir
}

// ---------------------------------------------------------------------------
// Runout propagation
// ---------------------------------------------------------------------------

/// Minimum gradient (rise/run) for a cell to be considered an avalanche source zone.
/// 0.176 ≈ tan(10°). Now meaningful again after fixing SOBEL_NORMALIZER.
pub const START_ZONE_THRESHOLD: f32 = 0.176;
const MAX_RUNOUT_CELLS: usize = 50;
const INITIAL_INTENSITY: f32 = 1.0;
const DECAY_RATE: f32 = 0.92;
const SPREAD_ITERATIONS: usize = 2;
const SPREAD_DECAY: f32 = 0.5;
const TERMINATE_BELOW: f32 = 0.05;
/// Width of the gradient blend zone (10°-20°) where source-zone edge intensity fades in.
const BLEND_RANGE: f32 = 0.35 - START_ZONE_THRESHOLD;
/// Intensity painted onto source cells themselves once fully blended in.
/// Deliberately below RUNOUT_BLOCK: whether a steep excluded-aspect cell is
/// traversable is the aspect rule's call (user-tunable threshold), not runout's.
const SOURCE_EDGE_INTENSITY: f32 = 0.45;

/// At or above this intensity the pathfinder rejects the cell outright; below
/// it the cell is traversable with a graduated cost penalty.
///
/// Invariants (covered by tests):
/// - Flow-chain cells (INITIAL_INTENSITY decaying by DECAY_RATE) start blocked:
///   these are the avalanche channel itself.
/// - Lateral spread (chain * SPREAD_DECAY) stays BELOW the block threshold:
///   the ring around a channel is penalized, never hard-blocked.
/// - Source-cell shading (<= SOURCE_EDGE_INTENSITY) stays below the threshold.
pub const RUNOUT_BLOCK: f32 = 0.5;

/// Propagate runout intensity downhill from each excluded-aspect source cell
/// using D8 flow, then apply lateral spreading. Operates in place on `runout`.
fn propagate_runout(
  runout: &mut [f32],
  spread_buffer: &mut [f32],
  gradients: &[f32],
  is_excluded: &[bool],
  flow_dir: &[u8],
  width: usize,
  height: usize,
) {
  let is_source = |idx: usize| -> bool {
    gradients[idx] >= START_ZONE_THRESHOLD && is_excluded[idx]
  };

  for i in 1..(height - 1) {
    for j in 1..(width - 1) {
      let flat_idx = i * width + j;
      if !is_source(flat_idx) {
        continue;
      }

      // Edge blending: intensity fades IN with steepness across the 10°-20°
      // blend zone (near zero just past the threshold, SOURCE_EDGE_INTENSITY
      // from 20° up), so the overlay ramps smoothly into the red aspect
      // shading and gentle slopes are never hard-blocked by their own shading.
      let above = gradients[flat_idx] - START_ZONE_THRESHOLD;
      let blend = (above / BLEND_RANGE).min(1.0);
      runout[flat_idx] = runout[flat_idx].max(blend * SOURCE_EDGE_INTENSITY);

      // Walk down the D8 flow chain, decaying intensity each step.
      let mut current_y = i;
      let mut current_x = j;
      let mut cells_walked = 0usize;
      let mut intensity = INITIAL_INTENSITY;

      loop {
        let dir = flow_dir[current_y * width + current_x];
        if dir >= 8 {
          break;
        }
        let (dy, dx) = D8_OFFSETS[dir as usize];
        let next_y = (current_y as isize + dy) as usize;
        let next_x = (current_x as isize + dx) as usize;
        if next_y == 0 || next_y >= height - 1 || next_x == 0 || next_x >= width - 1 {
          break;
        }
        current_y = next_y;
        current_x = next_x;
        cells_walked += 1;
        intensity *= DECAY_RATE;

        let next_idx = current_y * width + current_x;
        if !is_source(next_idx) && intensity > runout[next_idx] {
          runout[next_idx] = intensity;
        }
        if cells_walked >= MAX_RUNOUT_CELLS || intensity < TERMINATE_BELOW {
          break;
        }
      }
    }
  }

  // Lateral spreading: 4-connected diffusion, skipping source zones.
  for _ in 0..SPREAD_ITERATIONS {
    spread_buffer.copy_from_slice(runout);
    for i in 1..(height - 1) {
      for j in 1..(width - 1) {
        let flat_idx = i * width + j;
        let intensity = runout[flat_idx];
        if intensity <= 0.0 {
          continue;
        }
        let spread = intensity * SPREAD_DECAY;
        let neighbours = [
          (i - 1) * width + j,
          (i + 1) * width + j,
          i * width + (j - 1),
          i * width + (j + 1),
        ];
        for &n_idx in &neighbours {
          if !is_source(n_idx) && spread > spread_buffer[n_idx] {
            spread_buffer[n_idx] = spread;
          }
        }
      }
    }
    runout.copy_from_slice(spread_buffer);
  }
}

/// Compute runout zones LAZILY for only the specified excluded aspects.
/// Inputs are flat row-major f32 arrays; output is a flat f32 intensity map.
#[wasm_bindgen]
pub fn compute_runout_for_aspects(
  elevations_flat: &[f32],
  azimuths_flat: &[f32],
  gradients_flat: &[f32],
  width: u32,
  height: u32,
  excluded_aspects: JsValue,
) -> Result<Float32Array, JsValue> {
  let width = width as usize;
  let height = height as usize;
  let n = width * height;

  let excluded_aspects_vec: Vec<Aspect> = parse_excluded_aspects(excluded_aspects)?;

  if excluded_aspects_vec.is_empty() {
    console_log("[WASM] No aspects excluded, returning empty runout");
    return Ok(Float32Array::from(vec![0.0f32; n].as_slice()));
  }

  if elevations_flat.len() != n || azimuths_flat.len() != n || gradients_flat.len() != n {
    return Err(JsValue::from_str(&format!(
      "Input arrays must all be {} elements; got elevations={}, azimuths={}, gradients={}",
      n, elevations_flat.len(), azimuths_flat.len(), gradients_flat.len()
    )));
  }

  console_log(&format!(
    "[WASM] Computing runout for {} excluded aspects on {}x{} grid",
    excluded_aspects_vec.len(), width, height
  ));

  let flow_dir = compute_d8_flow_directions_flat(elevations_flat, width, height);
  let is_excluded = build_excluded_azimuth_mask(azimuths_flat, &excluded_aspects_vec);

  let mut runout = vec![0.0f32; n];
  let mut spread_buffer = vec![0.0f32; n];
  propagate_runout(
    &mut runout,
    &mut spread_buffer,
    gradients_flat,
    &is_excluded,
    &flow_dir,
    width,
    height,
  );

  console_log(&format!("[WASM] Lazy runout computation complete, {} elements", runout.len()));
  Ok(Float32Array::from(runout.as_slice()))
}

/// Eager runout computation on flat buffers — used by the GeoTIFF-based
/// `compute_azimuths` entrypoint.
fn compute_runout_zones_flat(
  elevations: &[f32],
  azimuths: &[f32],
  gradients: &[f32],
  width: usize,
  height: usize,
  excluded_aspects: &[Aspect],
) -> Vec<f32> {
  let n = width * height;
  let mut runout = vec![0.0f32; n];
  if excluded_aspects.is_empty() {
    return runout;
  }
  let flow_dir = compute_d8_flow_directions_flat(elevations, width, height);
  let is_excluded = build_excluded_azimuth_mask(azimuths, excluded_aspects);
  let mut spread_buffer = vec![0.0f32; n];
  propagate_runout(
    &mut runout,
    &mut spread_buffer,
    gradients,
    &is_excluded,
    &flow_dir,
    width,
    height,
  );
  runout
}

// ---------------------------------------------------------------------------
// Public WASM entrypoints
// ---------------------------------------------------------------------------

/// Apply a 5x5 Sobel filter to compute azimuth and gradient along azimuth for
/// each pixel of a GeoTIFF-encoded elevation raster, then derive runout zones.
#[wasm_bindgen]
pub fn compute_azimuths(elevations_geotiff: &[u8], excluded_aspects: JsValue) -> Result<AzimuthResult, JsValue> {
  let excluded_aspects_vec: Vec<Aspect> = parse_excluded_aspects(excluded_aspects)?;

  let cursor = Cursor::new(elevations_geotiff.to_vec());
  let mut reader = GeoTiffReader::open(cursor)
    .map_err(|e| JsValue::from_str(&format!("Failed to open GeoTIFF: {:?}", e)))?;
  let (elevations, width, height) = get_raster_flat(&mut reader)?;

  let geo_keys = reader.geo_keys.as_ref()
    .ok_or_else(|| JsValue::from_str("Missing geo_keys"))?
    .clone();
  let origin = reader.origin().ok_or_else(|| JsValue::from_str("Missing origin"))?;
  let pixel_scale_deg = reader.pixel_size().unwrap_or([1.0 / 10800.0, -1.0 / 10800.0]);

  // Convert degrees-per-pixel to meters at the raster centre latitude.
  let centre_lat = origin[1] + (pixel_scale_deg[1] * height as f64) / 2.0;
  let (px_x_m, px_y_m) = deg_pixel_to_meters(pixel_scale_deg, centre_lat);

  let (azimuths, gradients) = compute_sobel_flat(&elevations, width, height, px_x_m, px_y_m);
  let runout_zones = compute_runout_zones_flat(
    &elevations, &azimuths, &gradients, width, height, &excluded_aspects_vec,
  );

  // ModelPixelScale is stored positive; georaster will negate the y component on read.
  let out_pixel_scale = [pixel_scale_deg[0].abs(), pixel_scale_deg[1].abs()];

  Ok(AzimuthResult {
    elevations: serialize_to_geotiff_flat(&elevations, width, height, &geo_keys, &origin, &out_pixel_scale)?,
    azimuths: serialize_to_geotiff_flat(&azimuths, width, height, &geo_keys, &origin, &out_pixel_scale)?,
    gradients: serialize_to_geotiff_flat(&gradients, width, height, &geo_keys, &origin, &out_pixel_scale)?,
    runout_zones: serialize_to_geotiff_flat(&runout_zones, width, height, &geo_keys, &origin, &out_pixel_scale)?,
  })
}

/// Compute azimuths from a raw elevation Float32Array. Used for AWS Terrain
/// Tiles which are already decoded as flat arrays. Runout is computed lazily.
///
/// `pixel_size_x_m` and `pixel_size_y_m` give the per-pixel cell size in
/// meters (callers compute these from raster bounds and the centre latitude).
/// If omitted the function falls back to 10m (legacy behaviour).
#[wasm_bindgen]
pub fn compute_azimuths_from_array(
  elevations_flat: &[f32],
  width: u32,
  height: u32,
  _excluded_aspects: JsValue,
  pixel_size_x_m: Option<f64>,
  pixel_size_y_m: Option<f64>,
) -> Result<AzimuthArrayResult, JsValue> {
  console_log(&format!(
    "[WASM] compute_azimuths_from_array called: {}x{}, {} elements",
    width, height, elevations_flat.len()
  ));
  let width = width as usize;
  let height = height as usize;

  if elevations_flat.len() != width * height {
    return Err(JsValue::from_str(&format!(
      "Elevation array size {} doesn't match dimensions {}x{}={}",
      elevations_flat.len(), width, height, width * height
    )));
  }
  if width < 5 || height < 5 {
    return Err(JsValue::from_str(&format!(
      "Elevation grid too small: {}x{}, minimum is 5x5 for Sobel filtering",
      width, height
    )));
  }

  let px_x = pixel_size_x_m.unwrap_or(10.0);
  let px_y = pixel_size_y_m.unwrap_or(10.0);

  let (azimuths, gradients) = compute_sobel_flat(elevations_flat, width, height, px_x, px_y);

  Ok(AzimuthArrayResult {
    elevations: elevations_flat.to_vec(),
    azimuths,
    gradients,
    runout_zones: Vec::new(),
    width: width as u32,
    height: height as u32,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
  use super::*;

  fn tilted_x(width: usize, height: usize, slope: f64, dx: f64) -> Vec<f32> {
    let mut data = vec![0.0f32; width * height];
    for i in 0..height {
      for j in 0..width {
        data[i * width + j] = (slope * (j as f64) * dx) as f32;
      }
    }
    data
  }

  #[test]
  fn sobel_recovers_known_slope_x() {
    let slope = (10.0_f64).to_radians().tan(); // ≈ 0.1763
    let dx = 10.0;
    let elev = tilted_x(15, 15, slope, dx);
    let (azimuths, gradients) = compute_sobel_flat(&elev, 15, 15, dx, dx);
    let centre = 7 * 15 + 7;
    // East-rising terrain → west-facing slope, azimuth 270°.
    assert!((azimuths[centre] as f64 - 270.0).abs() < 1.0,
      "expected azimuth ≈ 270, got {}", azimuths[centre]);
    assert!((gradients[centre] as f64 - slope).abs() < 1e-3,
      "expected gradient ≈ {}, got {}", slope, gradients[centre]);
  }

  #[test]
  fn sobel_azimuth_correct_with_anisotropic_pixels() {
    // Plane rising equally (in meters) toward east and south: descent faces
    // northwest, azimuth 315. With px_x != px_y the per-axis normalization
    // must happen before the direction is computed, not just the magnitude.
    let (width, height) = (15, 15);
    let (px_x, px_y) = (7.0, 10.0);
    let slope = (20.0_f64).to_radians().tan();
    let mut elev = vec![0.0f32; width * height];
    for i in 0..height {
      for j in 0..width {
        elev[i * width + j] = (slope * (j as f64 * px_x + i as f64 * px_y)) as f32;
      }
    }
    let (azimuths, gradients) = compute_sobel_flat(&elev, width, height, px_x, px_y);
    let centre = 7 * width + 7;
    assert!((azimuths[centre] as f64 - 315.0).abs() < 1.0,
      "expected azimuth ~ 315, got {}", azimuths[centre]);
    let expected_gradient = slope * (2.0_f64).sqrt();
    assert!((gradients[centre] as f64 - expected_gradient).abs() < 1e-3,
      "expected gradient ~ {}, got {}", expected_gradient, gradients[centre]);
  }

  #[test]
  fn sobel_flat_returns_flat_sentinel() {
    let elev = vec![1234.5f32; 15 * 15];
    let (azimuths, gradients) = compute_sobel_flat(&elev, 15, 15, 10.0, 10.0);
    let centre = 7 * 15 + 7;
    assert_eq!(azimuths[centre], -1.0);
    assert_eq!(gradients[centre], 0.0);
  }

  #[test]
  fn border_cells_are_flat() {
    let elev = vec![100.0f32; 15 * 15];
    let (azimuths, _) = compute_sobel_flat(&elev, 15, 15, 10.0, 10.0);
    assert_eq!(azimuths[0], -1.0);
    assert_eq!(azimuths[15 * 15 - 1], -1.0);
  }

  #[test]
  fn aspect_from_azimuth_wraps_north_correctly() {
    assert_eq!(Aspect::from_azimuth(0.0), Aspect::North);
    assert_eq!(Aspect::from_azimuth(15.0), Aspect::North);
    assert_eq!(Aspect::from_azimuth(345.0), Aspect::North);
    assert_eq!(Aspect::from_azimuth(360.0), Aspect::North);
    assert_eq!(Aspect::from_azimuth(45.0), Aspect::Northeast);
    assert_eq!(Aspect::from_azimuth(90.0), Aspect::East);
    assert_eq!(Aspect::from_azimuth(180.0), Aspect::South);
    assert_eq!(Aspect::from_azimuth(-1.0), Aspect::Flat);
  }

  #[test]
  fn excluded_azimuth_mask_matches_pathfinder_tolerance() {
    // NE spans 22.5-67.5; with the 22.5 tolerance the excluded range is
    // exactly [0, 90] — matching contains_azimuth, not whole neighbour bins.
    let azimuths: Vec<f32> = vec![350.0, 0.0, 45.0, 90.0, 91.0, -1.0];
    let mask = build_excluded_azimuth_mask(&azimuths, &[Aspect::Northeast]);
    assert_eq!(mask, vec![false, true, true, true, false, false]);
  }

  #[test]
  fn d8_picks_steepest_descent() {
    let mut elev = vec![0.0f32; 5 * 5];
    for i in 0..5 {
      for j in 0..5 {
        elev[i * 5 + j] = (4 - j) as f32;
      }
    }
    let flow = compute_d8_flow_directions_flat(&elev, 5, 5);
    // Centre cell descends east (dir 2).
    assert_eq!(flow[2 * 5 + 2], 2);
  }

  #[test]
  fn runout_constants_keep_lateral_spread_and_source_shading_traversable() {
    // The avalanche channel itself (chain cells) must start blocked...
    assert!(INITIAL_INTENSITY * DECAY_RATE >= RUNOUT_BLOCK);
    // ...but the first lateral ring and source-cell shading must not be.
    assert!(INITIAL_INTENSITY * DECAY_RATE * SPREAD_DECAY < RUNOUT_BLOCK);
    assert!(SOURCE_EDGE_INTENSITY < RUNOUT_BLOCK);
  }

  #[test]
  fn gentle_source_cells_get_near_zero_runout() {
    // A cell barely past the 10-degree source threshold used to receive
    // maximum blend (exactly RUNOUT_BLOCK) and was deterministically blocked.
    let n = 5 * 5;
    let gradients = vec![START_ZONE_THRESHOLD + 0.001; n];
    let is_excluded = vec![true; n];
    let flow_dir = vec![255u8; n];
    let mut runout = vec![0.0f32; n];
    let mut spread = vec![0.0f32; n];
    propagate_runout(&mut runout, &mut spread, &gradients, &is_excluded, &flow_dir, 5, 5);
    for &v in &runout {
      assert!(v < 0.05, "gentle source cell should get near-zero runout, got {}", v);
    }
  }

  #[test]
  fn steep_source_cells_capped_below_block_threshold() {
    let n = 5 * 5;
    let gradients = vec![0.6f32; n]; // well past the blend zone
    let is_excluded = vec![true; n];
    let flow_dir = vec![255u8; n];
    let mut runout = vec![0.0f32; n];
    let mut spread = vec![0.0f32; n];
    propagate_runout(&mut runout, &mut spread, &gradients, &is_excluded, &flow_dir, 5, 5);
    let centre = 2 * 5 + 2;
    assert!((runout[centre] - SOURCE_EDGE_INTENSITY).abs() < 1e-6);
    assert!(runout[centre] < RUNOUT_BLOCK);
  }

  #[test]
  fn flow_chain_blocked_but_lateral_ring_traversable() {
    // Single steep source at (3,3) flowing east two cells. The chain is the
    // avalanche channel (blocked); everything beside it stays below the
    // block threshold.
    let (width, height) = (7, 7);
    let n = width * height;
    let mut gradients = vec![0.0f32; n];
    let mut is_excluded = vec![false; n];
    let mut flow_dir = vec![255u8; n];
    let src = 3 * width + 3;
    gradients[src] = 0.6;
    is_excluded[src] = true;
    flow_dir[src] = 2; // east
    flow_dir[3 * width + 4] = 2; // east
    let mut runout = vec![0.0f32; n];
    let mut spread = vec![0.0f32; n];
    propagate_runout(&mut runout, &mut spread, &gradients, &is_excluded, &flow_dir, width, height);

    let chain = [3 * width + 4, 3 * width + 5];
    for &c in &chain {
      assert!(runout[c] >= RUNOUT_BLOCK, "chain cell should be blocked, got {}", runout[c]);
    }
    for i in 0..n {
      if i == src || chain.contains(&i) {
        continue;
      }
      assert!(runout[i] < RUNOUT_BLOCK,
        "non-chain cell {} should stay traversable, got {}", i, runout[i]);
    }
  }

  #[test]
  fn runout_decays_along_flow() {
    let width = 20;
    let height = 5;
    let mut elev = vec![0.0f32; width * height];
    for i in 0..height {
      for j in 0..width {
        elev[i * width + j] = ((width - j) as f32) * 5.0;
      }
    }
    let (az, grad) = compute_sobel_flat(&elev, width, height, 10.0, 10.0);
    let runout = compute_runout_zones_flat(&elev, &az, &grad, width, height, &[Aspect::West]);
    // No NaNs, all values within [0, 1].
    for &v in &runout {
      assert!(v >= 0.0 && v <= 1.0, "runout out of range: {}", v);
    }
  }
}
