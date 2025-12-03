use georaster::geotiff::GeoTiffReader;
use serde::{Deserialize, Serialize};
use std::{f64::consts::PI, io::Cursor};
use wasm_bindgen::prelude::*;

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

/// Compute avalanche runout zones by following steepest descent from source zones.
/// Source zones are pixels with gradient >= BETA_THRESHOLD (10° ≈ 0.176 rise/run) AND
/// aspect in excluded_aspects. Runout propagates downhill until gradient drops below threshold.
fn compute_runout_zones(
  elevations: &Vec<Vec<f64>>,
  azimuths: &Vec<Vec<f64>>,
  gradients: &Vec<Vec<f64>>,
  excluded_aspects: &[Aspect],
) -> Vec<Vec<f64>> {
  const BETA_THRESHOLD: f64 = 0.176; // tan(10°) - the beta point where debris typically stops

  let height = elevations.len();
  let width = elevations[0].len();
  
  let mut runout: Vec<Vec<f64>> = vec![vec![0.0; width]; height];
  
  // If no aspects are excluded, no runout zones to compute
  if excluded_aspects.is_empty() {
    return runout;
  }
  
  // Directions for 8-connected neighbors
  const DIRECTIONS: [(isize, isize); 8] = [
    (0, 1), (1, 0), (0, -1), (-1, 0),
    (1, 1), (1, -1), (-1, -1), (-1, 1),
  ];
  
  // For each pixel, check if it's a source zone
  for i in 1..(height - 1) {
    for j in 1..(width - 1) {
      let gradient = gradients[i][j];
      let azimuth = azimuths[i][j];
      
      // Skip if gradient is below threshold
      if gradient < BETA_THRESHOLD {
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
      
      // This is a source zone - follow steepest descent to mark runout BELOW it
      // Note: The source zone itself is NOT marked as runout (it shows as red aspect shading)
      let mut current_y = i;
      let mut current_x = j;
      
      loop {
        // Find neighbor with lowest elevation
        let mut min_elevation = elevations[current_y][current_x];
        let mut next_y = current_y;
        let mut next_x = current_x;
        
        for &(dy, dx) in DIRECTIONS.iter() {
          let ny = (current_y as isize + dy) as usize;
          let nx = (current_x as isize + dx) as usize;
          
          if ny < height && nx < width {
            let neighbor_elevation = elevations[ny][nx];
            if neighbor_elevation < min_elevation {
              min_elevation = neighbor_elevation;
              next_y = ny;
              next_x = nx;
            }
          }
        }
        
        // If no lower neighbor found, stop
        if next_y == current_y && next_x == current_x {
          break;
        }
        
        // Move to next cell and mark it as runout
        current_y = next_y;
        current_x = next_x;
        runout[current_y][current_x] = 1.0;
        
        // If this cell's gradient is below threshold, stop (reached beta point)
        // We still marked it as runout since debris would reach here
        if gradients[current_y][current_x] < BETA_THRESHOLD {
          break;
        }
      }
    }
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
