use georaster::geotiff::GeoTiffReader;
use js_sys::Float32Array;
use serde::{Deserialize, Serialize};
use std::{f64::consts::PI, io::Cursor};
use wasm_bindgen::prelude::*;

use crate::console_log::console_log;

use crate::{get_raster, serialize_to_geotiff};

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
  pub fn elevations(&self) -> Vec<u8> {
    self.elevations.clone()
  }

  #[wasm_bindgen(getter)]
  pub fn azimuths(&self) -> Vec<u8> {
    self.azimuths.clone()
  }

  #[wasm_bindgen(getter)]
  pub fn gradients(&self) -> Vec<u8> {
    self.gradients.clone()
  }

  #[wasm_bindgen(getter)]
  pub fn runout_zones(&self) -> Vec<u8> {
    self.runout_zones.clone()
  }
}

/// Result struct for array-based azimuth computation (without GeoTIFF serialization)
/// Now includes 8 separate runout channels (one per aspect) for pre-computed runout zones
#[wasm_bindgen]
pub struct AzimuthArrayResult {
  elevations: Vec<f32>,
  azimuths: Vec<f32>,
  gradients: Vec<f32>,
  /// 8 runout channels packed sequentially: [N, NE, E, SE, S, SW, W, NW]
  /// Each channel is width*height f32 values, total size = 8 * width * height
  runout_zones: Vec<f32>,
  width: u32,
  height: u32,
}

#[wasm_bindgen]
impl AzimuthArrayResult {
  /// Get elevations as Float32Array (copies data to JS heap).
  /// For large grids, this is more efficient than returning Vec<f32>.
  #[wasm_bindgen]
  pub fn get_elevations(&self) -> Float32Array {
    Float32Array::from(&self.elevations[..])
  }

  /// Get azimuths as Float32Array (copies data to JS heap).
  #[wasm_bindgen]
  pub fn get_azimuths(&self) -> Float32Array {
    Float32Array::from(&self.azimuths[..])
  }

  /// Get gradients as Float32Array (copies data to JS heap).
  #[wasm_bindgen]
  pub fn get_gradients(&self) -> Float32Array {
    Float32Array::from(&self.gradients[..])
  }

  /// Get runout zones as Float32Array (copies data to JS heap).
  /// This is 8 channels packed sequentially, each width*height elements.
  #[wasm_bindgen]
  pub fn get_runout_zones(&self) -> Float32Array {
    Float32Array::from(&self.runout_zones[..])
  }

  #[wasm_bindgen(getter)]
  pub fn width(&self) -> u32 {
    self.width
  }

  #[wasm_bindgen(getter)]
  pub fn height(&self) -> u32 {
    self.height
  }

  /// Consume the result and return elevations, transferring ownership.
  #[wasm_bindgen]
  pub fn into_elevations(self) -> Vec<f32> {
    self.elevations
  }

  /// Consume the result and return azimuths, transferring ownership.
  #[wasm_bindgen]
  pub fn into_azimuths(self) -> Vec<f32> {
    self.azimuths
  }

  /// Consume the result and return gradients, transferring ownership.
  #[wasm_bindgen]
  pub fn into_gradients(self) -> Vec<f32> {
    self.gradients
  }

  /// Consume the result and return runout zones, transferring ownership.
  #[wasm_bindgen]
  pub fn into_runout_zones(self) -> Vec<f32> {
    self.runout_zones
  }
}


#[derive(PartialEq, Debug, Clone, Serialize, Deserialize)]
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
    if azimuth == -1.0 {
      Aspect::Flat
    } else {
      match azimuth as f64 {
        a if a < 22.5 => Aspect::North,
        a if a < 67.5 => Aspect::Northeast,
        a if a < 112.5 => Aspect::East,
        a if a < 157.5 => Aspect::Southeast,
        a if a < 202.5 => Aspect::South,
        a if a < 247.5 => Aspect::Southwest,
        a if a < 292.5 => Aspect::West,
        a if a < 337.5 => Aspect::Northwest,
        _ => Aspect::North,
      }
    }
  }

  pub fn contains_azimuth(&self, azimuth: f64, tolerance: Option<f64>) -> bool {
    // Handle NaN and invalid values
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
        (0.0 - tolerance) <= azimuth && azimuth <= (22.5 + tolerance)
          || (337.5 - tolerance) <= azimuth && azimuth <= 360.0
      }
      Aspect::Flat => azimuth == -1.0,
    }
  }
}

/// Calculate azimuth from horizontal (Gx) and vertical (Gy) gradients
pub fn calculate_azimuth(gx: f64, gy: f64) -> f64 {
  if gx == 0.0 && gy == 0.0 {
    return -1.0; // Default value for flat areas
  }

  // Calculate azimuth in radians, then convert to degrees
  let azimuth_radians: f64 = ((-gx) as f64).atan2(gy as f64); // Invert gx to correct E/W mapping
  let mut azimuth_degrees: f64 = azimuth_radians * 180.0 / PI;

  // Normalize to [0, 360)
  if azimuth_degrees < 0.0 {
    azimuth_degrees += 360.0;
  }

  azimuth_degrees as f64
}

/// Compute gradient along azimuth
fn compute_gradient_along_azimuth(gx: f64, gy: f64, azimuth: f64) -> f64 {
  if azimuth == -1.0 {
    return 0.0;
  }

  const PIXEL_SIZE: f64 = 10.0; // 10m pixel size
  const KERNEL_SUM: f64 = 68.0; // Sum of absolute values in Sobel 5x5 kernel

  // Normalize gradients
  let gx_normalized: f64 = gx / (KERNEL_SUM * PIXEL_SIZE).abs();
  let gy_normalized: f64 = gy / (KERNEL_SUM * PIXEL_SIZE).abs();

  // Calculate slope as rise/run
  ((gx_normalized * gx_normalized) + (gy_normalized * gy_normalized)).sqrt()
}

/// Compute D8 flow directions for each cell.
/// Returns a 2D array where each value encodes the direction to the steepest downhill neighbor:
///   0=N, 1=NE, 2=E, 3=SE, 4=S, 5=SW, 6=W, 7=NW, 255=flat/sink (no downhill neighbor)
fn compute_d8_flow_directions(elevations: &Vec<Vec<f64>>) -> Vec<Vec<u8>> {
  let height = elevations.len();
  let width = elevations[0].len();
  
  let mut flow_dir: Vec<Vec<u8>> = vec![vec![255; width]; height];
  
  // D8 neighbor offsets: (dy, dx) for directions 0-7
  // Direction encoding: 0=N, 1=NE, 2=E, 3=SE, 4=S, 5=SW, 6=W, 7=NW
  const D8_OFFSETS: [(isize, isize); 8] = [
    (-1, 0),  // 0: N
    (-1, 1),  // 1: NE
    (0, 1),   // 2: E
    (1, 1),   // 3: SE
    (1, 0),   // 4: S
    (1, -1),  // 5: SW
    (0, -1),  // 6: W
    (-1, -1), // 7: NW
  ];
  
  // Distance weights for diagonal vs cardinal (sqrt(2) vs 1)
  const D8_WEIGHTS: [f64; 8] = [1.0, 1.414, 1.0, 1.414, 1.0, 1.414, 1.0, 1.414];
  
  for i in 1..(height - 1) {
    for j in 1..(width - 1) {
      let center_elev = elevations[i][j];
      let mut steepest_slope = 0.0;
      let mut steepest_dir: u8 = 255;
      
      for (dir, &(dy, dx)) in D8_OFFSETS.iter().enumerate() {
        let ny = (i as isize + dy) as usize;
        let nx = (j as isize + dx) as usize;
        
        let neighbor_elev = elevations[ny][nx];
        let drop = center_elev - neighbor_elev;
        
        if drop > 0.0 {
          // Slope = drop / distance (accounting for diagonal distance)
          let slope = drop / D8_WEIGHTS[dir];
          if slope > steepest_slope {
            steepest_slope = slope;
            steepest_dir = dir as u8;
          }
        }
      }
      
      flow_dir[i][j] = steepest_dir;
    }
  }
  
  flow_dir
}

/// Compute runout zones LAZILY for only the specified excluded aspects.
/// This is called when aspect selection changes, instead of pre-computing all 8 channels.
/// Returns a single combined runout intensity map (not 8 channels).
/// 
/// Parameters:
/// - elevations_flat: Flat f32 array of elevation values
/// - azimuths_flat: Flat f32 array of azimuth values (0-360 degrees)
/// - gradients_flat: Flat f32 array of gradient values (rise/run)
/// - width, height: Grid dimensions
/// - excluded_aspects: JS array of aspect names to compute runout for
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
  let grid_size = width * height;
  
  // Parse excluded aspects
  let excluded_aspects_vec: Vec<Aspect> = if excluded_aspects.is_undefined() || excluded_aspects.is_null() {
    vec![]
  } else {
    serde_wasm_bindgen::from_value(excluded_aspects).unwrap_or(vec![])
  };
  
  // If no aspects excluded, return empty runout
  if excluded_aspects_vec.is_empty() {
    console_log("[WASM] No aspects excluded, returning empty runout");
    return Ok(Float32Array::from(vec![0.0f32; grid_size].as_slice()));
  }
  
  console_log(&format!("[WASM] Computing runout for {} excluded aspects on {}x{} grid", 
    excluded_aspects_vec.len(), width, height));
  
  // Convert flat arrays to 2D for D8 flow computation
  let elevations: Vec<Vec<f64>> = (0..height)
    .map(|row| {
      (0..width)
        .map(|col| elevations_flat[row * width + col] as f64)
        .collect()
    })
    .collect();
  
  // Pre-compute D8 flow directions
  let flow_dir = compute_d8_flow_directions(&elevations);
  
  // Create a set of excluded aspect indices for fast lookup
  let excluded_indices: Vec<usize> = excluded_aspects_vec.iter().filter_map(|aspect| {
    match aspect {
      Aspect::North => Some(0),
      Aspect::Northeast => Some(1),
      Aspect::East => Some(2),
      Aspect::Southeast => Some(3),
      Aspect::South => Some(4),
      Aspect::Southwest => Some(5),
      Aspect::West => Some(6),
      Aspect::Northwest => Some(7),
      Aspect::Flat => None,
    }
  }).collect();
  
  // Pre-compute aspect indices for all cells
  let aspect_indices: Vec<Option<usize>> = azimuths_flat
    .iter()
    .map(|&azimuth| {
      if azimuth < 0.0 || azimuth.is_nan() {
        None
      } else {
        let normalized = (azimuth + 22.5) % 360.0;
        Some((normalized / 45.0) as usize % 8)
      }
    })
    .collect();
  
  // Single combined runout grid
  let mut runout: Vec<f32> = vec![0.0f32; grid_size];
  
  // Constants
  const START_ZONE_THRESHOLD: f32 = 0.176; // tan(10°)
  const MAX_RUNOUT_CELLS: usize = 50;
  const INITIAL_INTENSITY: f32 = 1.0;
  const DECAY_RATE: f32 = 0.92;
  
  const D8_OFFSETS: [(isize, isize); 8] = [
    (-1, 0),  // 0: N
    (-1, 1),  // 1: NE
    (0, 1),   // 2: E
    (1, 1),   // 3: SE
    (1, 0),   // 4: S
    (1, -1),  // 5: SW
    (0, -1),  // 6: W
    (-1, -1), // 7: NW
  ];
  
  let idx = |row: usize, col: usize| -> usize { row * width + col };
  
  // Single pass - only process source zones for excluded aspects
  for i in 1..(height - 1) {
    for j in 1..(width - 1) {
      let flat_idx = idx(i, j);
      let gradient = gradients_flat[flat_idx];
      
      if gradient < START_ZONE_THRESHOLD {
        continue;
      }
      
      // Check if this cell's aspect is in the excluded list
      let aspect_idx = match aspect_indices[flat_idx] {
        Some(idx) => idx,
        None => continue,
      };
      
      if !excluded_indices.contains(&aspect_idx) {
        continue;
      }
      
      // Mark source zone edge blending
      let blend_range = 0.35 - START_ZONE_THRESHOLD;
      let gradient_above_threshold = gradient - START_ZONE_THRESHOLD;
      if gradient_above_threshold < blend_range {
        let blend_factor = 1.0 - (gradient_above_threshold / blend_range);
        let edge_intensity = blend_factor * 0.5;
        runout[flat_idx] = runout[flat_idx].max(edge_intensity);
      }
      
      // Propagate runout downhill
      let mut current_y = i;
      let mut current_x = j;
      let mut runout_cells = 0;
      let mut current_intensity = INITIAL_INTENSITY;
      
      loop {
        let dir = flow_dir[current_y][current_x];
        
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
        runout_cells += 1;
        current_intensity *= DECAY_RATE;
        
        let next_flat_idx = idx(current_y, current_x);
        
        // Don't mark if this is also an excluded source zone
        let next_gradient = gradients_flat[next_flat_idx];
        let next_aspect = aspect_indices[next_flat_idx];
        let next_is_source = next_gradient >= START_ZONE_THRESHOLD 
          && next_aspect.map(|a| excluded_indices.contains(&a)).unwrap_or(false);
        
        if !next_is_source {
          runout[next_flat_idx] = runout[next_flat_idx].max(current_intensity);
        }
        
        if runout_cells >= MAX_RUNOUT_CELLS || current_intensity < 0.05 {
          break;
        }
      }
    }
  }
  
  // Lateral spreading pass
  const SPREAD_ITERATIONS: usize = 2;
  const SPREAD_DECAY: f32 = 0.7;
  
  let mut spread_buffer: Vec<f32> = vec![0.0f32; grid_size];
  
  for _ in 0..SPREAD_ITERATIONS {
    spread_buffer.copy_from_slice(&runout);
    
    for i in 1..(height - 1) {
      for j in 1..(width - 1) {
        let flat_idx = idx(i, j);
        let intensity = runout[flat_idx];
        
        if intensity > 0.0 {
          let neighbors = [(i - 1, j), (i + 1, j), (i, j - 1), (i, j + 1)];
          
          for &(ny, nx) in &neighbors {
            if ny > 0 && ny < height - 1 && nx > 0 && nx < width - 1 {
              let neighbor_flat_idx = idx(ny, nx);
              let neighbor_gradient = gradients_flat[neighbor_flat_idx];
              let neighbor_aspect = aspect_indices[neighbor_flat_idx];
              let is_source = neighbor_gradient >= START_ZONE_THRESHOLD
                && neighbor_aspect.map(|a| excluded_indices.contains(&a)).unwrap_or(false);
              
              if !is_source {
                let spread_intensity = intensity * SPREAD_DECAY;
                spread_buffer[neighbor_flat_idx] = spread_buffer[neighbor_flat_idx].max(spread_intensity);
              }
            }
          }
        }
      }
    }
    
    runout.copy_from_slice(&spread_buffer);
  }
  
  console_log(&format!("[WASM] Lazy runout computation complete, {} elements", runout.len()));
  Ok(Float32Array::from(runout.as_slice()))
}

/// Compute avalanche runout zones using D8 flow routing.
/// Source zones are steep pixels (gradient >= threshold) with aspect in excluded_aspects.
/// Returns intensity values (0.0-1.0) that fade with distance from source zones.
/// Runout zones are the FLAT areas (<10°) below source zones where debris comes to rest.
fn compute_runout_zones(
  elevations: &Vec<Vec<f64>>,
  azimuths: &Vec<Vec<f64>>,
  gradients: &Vec<Vec<f64>>,
  excluded_aspects: &[Aspect],
) -> Vec<Vec<f64>> {
  // Minimum gradient to be considered a potential avalanche start zone (~10° slope)
  // This matches where red aspect shading stops
  const START_ZONE_THRESHOLD: f64 = 0.176; // tan(10°)
  // Maximum cells to mark as runout on flat terrain
  const MAX_RUNOUT_CELLS: usize = 50;
  // Starting intensity for runout zones (will fade with distance)
  const INITIAL_INTENSITY: f64 = 1.0;
  // Decay rate per cell on flat terrain (faster decay since terrain is flat)
  const DECAY_RATE: f64 = 0.92;

  let height = elevations.len();
  let width = elevations[0].len();
  
  let mut runout: Vec<Vec<f64>> = vec![vec![0.0; width]; height];
  
  // If no aspects are excluded, no runout zones to compute
  if excluded_aspects.is_empty() {
    return runout;
  }
  
  // Compute D8 flow directions
  let flow_dir = compute_d8_flow_directions(elevations);
  
  // D8 neighbor offsets matching direction encoding
  const D8_OFFSETS: [(isize, isize); 8] = [
    (-1, 0),  // 0: N
    (-1, 1),  // 1: NE
    (0, 1),   // 2: E
    (1, 1),   // 3: SE
    (1, 0),   // 4: S
    (1, -1),  // 5: SW
    (0, -1),  // 6: W
    (-1, -1), // 7: NW
  ];
  
  // Find all source zone cells and propagate runout from each
  // Also mark source zone cells with low-intensity runout to blend with red shading
  for i in 1..(height - 1) {
    for j in 1..(width - 1) {
      let gradient = gradients[i][j];
      let azimuth = azimuths[i][j];
      
      // Must be steep enough to be an avalanche start zone
      if gradient < START_ZONE_THRESHOLD {
        continue;
      }
      
      // Check if this pixel's aspect is in the excluded list
      let mut is_excluded = false;
      for aspect in excluded_aspects {
        if aspect.contains_azimuth(azimuth, Some(22.5)) {
          is_excluded = true;
          break;
        }
      }
      
      if !is_excluded {
        continue;
      }
      
      // Mark source zone cells near the 10° threshold with fading runout
      // to create a smooth blend between red aspect shading and amber runout
      // The closer to 10° threshold, the more runout blending we apply
      let blend_range = 0.35 - START_ZONE_THRESHOLD; // ~10° to ~20° range for blending
      let gradient_above_threshold = gradient - START_ZONE_THRESHOLD;
      if gradient_above_threshold < blend_range {
        let blend_factor = 1.0 - (gradient_above_threshold / blend_range);
        let edge_intensity = blend_factor * 0.5; // Max 50% intensity at the 10° edge
        runout[i][j] = runout[i][j].max(edge_intensity);
      }
      
      // This is a source zone - follow D8 flow and mark runout with fading intensity
      let mut current_y = i;
      let mut current_x = j;
      let mut runout_cells = 0;
      let mut current_intensity = INITIAL_INTENSITY;
      
      // Follow flow and mark runout starting from first cell after source
      loop {
        let dir = flow_dir[current_y][current_x];
        
        // Stop if this is a sink (no downhill flow) or invalid direction
        if dir >= 8 {
          break;
        }
        
        // Move to next cell following flow direction
        let (dy, dx) = D8_OFFSETS[dir as usize];
        let next_y = (current_y as isize + dy) as usize;
        let next_x = (current_x as isize + dx) as usize;
        
        // Bounds check
        if next_y == 0 || next_y >= height - 1 || next_x == 0 || next_x >= width - 1 {
          break;
        }
        
        current_y = next_y;
        current_x = next_x;
        runout_cells += 1;
        
        // Decay intensity with distance
        current_intensity *= DECAY_RATE;
        
        // Don't mark cells that are themselves steep excluded-aspect source zones (they show as red)
        let next_gradient = gradients[current_y][current_x];
        let next_azimuth = azimuths[current_y][current_x];
        let mut next_is_source = false;
        if next_gradient >= START_ZONE_THRESHOLD {
          for aspect in excluded_aspects {
            if aspect.contains_azimuth(next_azimuth, Some(22.5)) {
              next_is_source = true;
              break;
            }
          }
        }
        
        // Only mark as runout if it's not a source zone itself (source zones show as red)
        // Use max to accumulate intensity from multiple flow paths
        if !next_is_source {
          runout[current_y][current_x] = runout[current_y][current_x].max(current_intensity);
        }
        
        // Stop conditions:
        // 1. Traveled max distance
        // 2. Intensity has faded too much
        // Note: We continue on flat terrain - runout extends until it fades out
        if runout_cells >= MAX_RUNOUT_CELLS {
          break;
        }
        if current_intensity < 0.05 {
          break;
        }
      }
    }
  }
  
  // Lateral spreading pass: expand runout zones to fill gaps between D8 flow paths
  // This simulates debris spreading laterally as it flows downhill
  const SPREAD_ITERATIONS: usize = 2;
  const SPREAD_DECAY: f64 = 0.7; // Intensity multiplier for spread cells
  
  for _ in 0..SPREAD_ITERATIONS {
    let mut spread_runout = runout.clone();
    
    for i in 1..(height - 1) {
      for j in 1..(width - 1) {
        if runout[i][j] > 0.0 {
          // Spread to 4-connected neighbors (not diagonal, to avoid over-spreading)
          let neighbors = [(i - 1, j), (i + 1, j), (i, j - 1), (i, j + 1)];
          
          for &(ny, nx) in &neighbors {
            if ny > 0 && ny < height - 1 && nx > 0 && nx < width - 1 {
              // Don't spread into steep excluded-aspect source zones (they show as red)
              let neighbor_gradient = gradients[ny][nx];
              let neighbor_azimuth = azimuths[ny][nx];
              let mut is_source = false;
              if neighbor_gradient >= START_ZONE_THRESHOLD {
                for aspect in excluded_aspects {
                  if aspect.contains_azimuth(neighbor_azimuth, Some(22.5)) {
                    is_source = true;
                    break;
                  }
                }
              }
              
              if !is_source {
                let spread_intensity = runout[i][j] * SPREAD_DECAY;
                spread_runout[ny][nx] = spread_runout[ny][nx].max(spread_intensity);
              }
            }
          }
        }
      }
    }
    
    runout = spread_runout;
  }
  
  runout
}

/// Apply a 5x5 Sobel filter to compute azimuth and gradient along azimuth for each pixel on a `Vec<f32>`
#[wasm_bindgen]
pub fn compute_azimuths(elevations_geotiff: &[u8], excluded_aspects: JsValue) -> Result<AzimuthResult, JsValue> {
  // Parse excluded aspects from JS value
  let excluded_aspects_vec: Vec<Aspect> = if excluded_aspects.is_undefined() || excluded_aspects.is_null() {
    vec![]
  } else {
    serde_wasm_bindgen::from_value(excluded_aspects).unwrap_or(vec![])
  };

  let cursor: Cursor<Vec<u8>> = Cursor::new(elevations_geotiff.to_vec());
  let mut elevations_geotiff: GeoTiffReader<Cursor<Vec<u8>>> =
    GeoTiffReader::open(cursor)
      .map_err(|e| JsValue::from_str(&format!("Failed to open GeoTIFF: {:?}", e)))?;
  let elevations: Vec<Vec<f64>> = get_raster(&mut elevations_geotiff)?;

  let gx_kernel: [[f64; 5]; 5] = [
    [-5.0, -4.0, 0.0, 4.0, 5.0],
    [-8.0, -10.0, 0.0, 10.0, 8.0],
    [-10.0, -20.0, 0.0, 20.0, 10.0],
    [-8.0, -10.0, 0.0, 10.0, 8.0],
    [-5.0, -4.0, 0.0, 4.0, 5.0],
  ];

  let gy_kernel: [[f64; 5]; 5] = [
    [-5.0, -8.0, -10.0, -8.0, -5.0],
    [-4.0, -10.0, -20.0, -10.0, -4.0],
    [0.0, 0.0, 0.0, 0.0, 0.0],
    [4.0, 10.0, 20.0, 10.0, 4.0],
    [5.0, 8.0, 10.0, 8.0, 5.0],
  ];

  let height: usize = elevations.len();
  let width: usize = elevations[0].len();

  let mut azimuths: Vec<Vec<f64>> = vec![vec![0.0; width]; height];
  let mut gradients: Vec<Vec<f64>> = vec![vec![0.0; width]; height];

  // Apply convolution
  for i in 2..(height - 2) {
    for j in 2..(width - 2) {
      let mut gx: f64 = 0.0;
      let mut gy: f64 = 0.0;

      // Apply the 5x5 kernel
      for ki in 0..5 {
        for kj in 0..5 {
          let x: usize = j + kj - 2;
          let y: usize = i + ki - 2;
          let pixel_value: f64 = elevations[y][x];

          gx += pixel_value * gx_kernel[ki][kj];
          gy += pixel_value * gy_kernel[ki][kj];
        }
      }

      // Compute azimuth for the current pixel
      let azimuth: f64 = calculate_azimuth(gx, gy);
      azimuths[i][j] = azimuth;
      gradients[i][j] = compute_gradient_along_azimuth(gx, gy, azimuth);
    }
  }

  // Compute runout zones based on excluded aspects
  let runout_zones = compute_runout_zones(&elevations, &azimuths, &gradients, &excluded_aspects_vec);

  let geo_keys: Vec<u32> = elevations_geotiff.geo_keys.as_ref()
    .ok_or_else(|| JsValue::from_str("Missing geo_keys"))?
    .clone();
  let origin: [f64; 2] = elevations_geotiff.origin()
    .ok_or_else(|| JsValue::from_str("Missing origin"))?;

  // Serialize all rasters to GeoTIFF format
  let elevations_geotiff_bytes = serialize_to_geotiff(elevations, &geo_keys, &origin)?;
  let runout_zones_geotiff_bytes = serialize_to_geotiff(runout_zones, &geo_keys, &origin)?;
  
  Ok(AzimuthResult {
    elevations: elevations_geotiff_bytes,
    azimuths: serialize_to_geotiff(azimuths, &geo_keys, &origin)?,
    gradients: serialize_to_geotiff(gradients, &geo_keys, &origin)?,
    runout_zones: runout_zones_geotiff_bytes,
  })
}

/// Compute azimuths from raw elevation array (Float32Array) instead of GeoTIFF.
/// This is more efficient for AWS Terrain Tiles which are already decoded as Float32Array.
/// Returns raw Float32Array data for elevations, azimuths, gradients, and runout zones.
/// Runout zones are pre-computed for ALL 8 aspects and packed sequentially:
/// [N channel, NE channel, E channel, SE channel, S channel, SW channel, W channel, NW channel]
/// Each channel is width*height f32 values.
#[wasm_bindgen]
pub fn compute_azimuths_from_array(
  elevations_flat: &[f32],
  width: u32,
  height: u32,
  _excluded_aspects: JsValue,  // Ignored - we now compute all aspects
) -> Result<AzimuthArrayResult, JsValue> {
  console_log(&format!("[WASM] compute_azimuths_from_array called: {}x{}, {} elements", width, height, elevations_flat.len()));
  
  let width = width as usize;
  let height = height as usize;
  
  // Validate input size
  if elevations_flat.len() != width * height {
    return Err(JsValue::from_str(&format!(
      "Elevation array size {} doesn't match dimensions {}x{}={}",
      elevations_flat.len(), width, height, width * height
    )));
  }
  
  // Validate minimum dimensions for 5x5 kernel (need at least 5x5)
  if width < 5 || height < 5 {
    return Err(JsValue::from_str(&format!(
      "Elevation grid too small: {}x{}, minimum is 5x5 for Sobel filtering",
      width, height
    )));
  }
  
  console_log("[WASM] Validation passed, converting to 2D array");

  // Convert flat array to 2D Vec<Vec<f64>> for processing
  let elevations: Vec<Vec<f64>> = (0..height)
    .map(|row| {
      (0..width)
        .map(|col| elevations_flat[row * width + col] as f64)
        .collect()
    })
    .collect();

  let gx_kernel: [[f64; 5]; 5] = [
    [-5.0, -4.0, 0.0, 4.0, 5.0],
    [-8.0, -10.0, 0.0, 10.0, 8.0],
    [-10.0, -20.0, 0.0, 20.0, 10.0],
    [-8.0, -10.0, 0.0, 10.0, 8.0],
    [-5.0, -4.0, 0.0, 4.0, 5.0],
  ];

  let gy_kernel: [[f64; 5]; 5] = [
    [-5.0, -8.0, -10.0, -8.0, -5.0],
    [-4.0, -10.0, -20.0, -10.0, -4.0],
    [0.0, 0.0, 0.0, 0.0, 0.0],
    [4.0, 10.0, 20.0, 10.0, 4.0],
    [5.0, 8.0, 10.0, 8.0, 5.0],
  ];

  let mut azimuths: Vec<Vec<f64>> = vec![vec![0.0; width]; height];
  let mut gradients: Vec<Vec<f64>> = vec![vec![0.0; width]; height];

  // Apply convolution
  for i in 2..(height - 2) {
    for j in 2..(width - 2) {
      let mut gx: f64 = 0.0;
      let mut gy: f64 = 0.0;

      // Apply the 5x5 kernel
      for ki in 0..5 {
        for kj in 0..5 {
          let x: usize = j + kj - 2;
          let y: usize = i + ki - 2;
          let pixel_value: f64 = elevations[y][x];

          gx += pixel_value * gx_kernel[ki][kj];
          gy += pixel_value * gy_kernel[ki][kj];
        }
      }

      // Compute azimuth for the current pixel
      let azimuth: f64 = calculate_azimuth(gx, gy);
      azimuths[i][j] = azimuth;
      gradients[i][j] = compute_gradient_along_azimuth(gx, gy, azimuth);
    }
  }

  // Skip runout computation here - it will be done lazily when aspects are selected
  console_log("[WASM] Skipping runout computation (lazy evaluation on aspect change)");

  // Flatten all 2D arrays to 1D Vec<f32>
  console_log("[WASM] Flattening arrays");
  let elevations_flat: Vec<f32> = elevations.into_iter().flatten().map(|x| x as f32).collect();
  let azimuths_flat: Vec<f32> = azimuths.into_iter().flatten().map(|x| x as f32).collect();
  let gradients_flat: Vec<f32> = gradients.into_iter().flatten().map(|x| x as f32).collect();
  
  console_log("[WASM] Arrays flattened, returning result");

  Ok(AzimuthArrayResult {
    elevations: elevations_flat,
    azimuths: azimuths_flat,
    gradients: gradients_flat,
    runout_zones: Vec::new(), // Empty - computed lazily
    width: width as u32,
    height: height as u32,
  })
}
