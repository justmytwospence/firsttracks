use std::{cell::RefCell, collections::HashSet, rc::Rc};

use geojson::{FeatureCollection, GeoJson, Geometry, Value};
use js_sys::Function;
use pathfinding::directed::fringe::fringe;
use wasm_bindgen::prelude::*;

use crate::azimuth::{deg_pixel_to_meters, Aspect, ASPECT_TOLERANCE_DEG};

fn parse_point_to_coordinate(point_str: &str) -> Result<(f64, f64), JsValue> {
  let geojson = GeoJson::from_json_value(
    serde_json::from_str(point_str)
      .map_err(|e| JsValue::from_str(&format!("Invalid JSON: {}", e)))?,
  )
  .map_err(|e| JsValue::from_str(&format!("Invalid GeoJSON: {}", e)))?;

  match geojson {
    GeoJson::Geometry(Geometry { value: Value::Point(coords), .. }) if coords.len() >= 2 => {
      // GeoJSON Point: [lon, lat]
      Ok((coords[0], coords[1]))
    }
    _ => Err(JsValue::from_str("Expected GeoJSON Point with [lon, lat]")),
  }
}

/// Octile distance in meters for an 8-connected (possibly anisotropic) grid.
/// Walks min(dx, dy) diagonals + |dx - dy| cardinal steps along the longer axis.
/// Always <= true grid cost (sqrt(px_x² + px_y²) <= px_x + px_y), so admissible.
fn octile_distance(a: (usize, usize), b: (usize, usize), px_x_m: f64, px_y_m: f64) -> f64 {
  let dx = (b.0 as isize - a.0 as isize).abs() as f64;
  let dy = (b.1 as isize - a.1 as isize).abs() as f64;
  let short = dx.min(dy);
  let diag = (px_x_m * px_x_m + px_y_m * px_y_m).sqrt();
  let extra = if dx >= dy {
    (dx - dy) * px_x_m
  } else {
    (dy - dx) * px_y_m
  };
  short * diag + extra
}

fn euclidean_distance(a: (usize, usize), b: (usize, usize), px_x_m: f64, px_y_m: f64) -> f64 {
  let dx = (b.0 as isize - a.0 as isize).abs() as f64 * px_x_m;
  let dy = (b.1 as isize - a.1 as isize).abs() as f64 * px_y_m;
  ((dx * dx) + (dy * dy)).sqrt()
}

fn linear_multiplier(x: f64) -> f64 {
  (20.0 * x).clamp(1.0, 20.0)
}

#[allow(dead_code)]
fn logistic_multiplier(x: f64) -> f64 {
  const SCALE: f64 = 5.0;
  const GROWTH_RATE: f64 = 70.0;
  const X0: f64 = 0.12;
  let logistic_curve: f64 = SCALE / (1.0 + (-GROWTH_RATE * (x - X0)).exp());
  let y_shift: f64 = 1.0 - SCALE / (1.0 + (GROWTH_RATE * X0).exp());
  logistic_curve + y_shift
}

#[allow(dead_code)]
fn exponential_multiplier(x: f64) -> f64 {
  use std::f64::consts::E;
  const M: f64 = 50.0;
  const B: f64 = 0.1;
  E.powf(M * (x - B)) + 1.0
}

/// Below this runout intensity we apply only a graduated cost penalty; at or
/// above this, the cell is rejected entirely. Tuned so that lateral spread
/// (≤ 0.49 in two iterations of 0.7×) remains traversable but high-confidence
/// runout (initial 1.0, decaying along the flow) is blocked.
const RUNOUT_BLOCK: f32 = 0.5;
const RUNOUT_PENALTY_SCALE: f64 = 10.0;

/// Edge cost = base distance × gradient multiplier × runout penalty (u32).
fn cost_fn(distance_m: f64, gradient: f64, runout_intensity: f32) -> u32 {
  let gradient_multiplier = linear_multiplier(gradient);
  let runout_penalty = 1.0 + (runout_intensity as f64) * RUNOUT_PENALTY_SCALE;
  (distance_m * gradient_multiplier * runout_penalty) as u32
}

/// Exploration tracker — streams newly-explored cells to JS for the animated flood-fill overlay.
///
/// Origin / scale / dimensions are sent once at start via `send_init`, so each flush only
/// ships the new cells. Flushes fire on a wall-clock cadence (~33 ms) rather than on radial
/// growth, so each batch is predictable in size and digestible on the main thread regardless
/// of how fast or slow the search is moving through terrain.
struct ExplorationTracker {
  callback: Option<Function>,
  explored_cells: Vec<(u16, u16)>,
  explored_set: HashSet<(usize, usize)>,
  last_flush_idx: usize,
  last_flush_time_ms: f64,
  nodes_since_time_check: u32,
}

const FLUSH_INTERVAL_MS: f64 = 33.0;
const TIME_CHECK_NODE_STRIDE: u32 = 200;

impl ExplorationTracker {
  fn new(callback: Option<Function>) -> Self {
    Self {
      callback,
      explored_cells: Vec::with_capacity(50_000),
      explored_set: HashSet::with_capacity(50_000),
      last_flush_idx: 0,
      last_flush_time_ms: js_sys::Date::now(),
      nodes_since_time_check: 0,
    }
  }

  fn send_init(
    &self,
    origin: (f64, f64),
    pixel_scale: (f64, f64),
    raster_width: u32,
    raster_height: u32,
  ) {
    let Some(ref callback) = self.callback else { return };
    let obj = js_sys::Object::new();
    let _ = js_sys::Reflect::set(&obj, &"type".into(), &"init".into());
    let _ = js_sys::Reflect::set(&obj, &"originX".into(), &JsValue::from_f64(origin.0));
    let _ = js_sys::Reflect::set(&obj, &"originY".into(), &JsValue::from_f64(origin.1));
    let _ = js_sys::Reflect::set(&obj, &"scaleX".into(), &JsValue::from_f64(pixel_scale.0));
    let _ = js_sys::Reflect::set(&obj, &"scaleY".into(), &JsValue::from_f64(pixel_scale.1));
    let _ = js_sys::Reflect::set(&obj, &"width".into(), &JsValue::from_f64(raster_width as f64));
    let _ = js_sys::Reflect::set(&obj, &"height".into(), &JsValue::from_f64(raster_height as f64));
    let _ = callback.call1(&JsValue::NULL, &obj);
  }

  fn add_node(&mut self, x: usize, y: usize) {
    if self.callback.is_none() {
      return;
    }
    if !self.explored_set.insert((x, y)) {
      return;
    }
    self.explored_cells.push((x as u16, y as u16));

    self.nodes_since_time_check += 1;
    if self.nodes_since_time_check >= TIME_CHECK_NODE_STRIDE {
      self.nodes_since_time_check = 0;
      let now = js_sys::Date::now();
      if now - self.last_flush_time_ms >= FLUSH_INTERVAL_MS {
        self.flush();
        self.last_flush_time_ms = now;
      }
    }
  }

  fn flush(&mut self) {
    let Some(ref callback) = self.callback else { return };
    let new_cells = &self.explored_cells[self.last_flush_idx..];
    if new_cells.is_empty() {
      return;
    }

    // One allocation, one batched copy into JS.
    let mut packed: Vec<u16> = Vec::with_capacity(new_cells.len() * 2);
    for &(x, y) in new_cells {
      packed.push(x);
      packed.push(y);
    }
    let cells = js_sys::Uint16Array::from(&packed[..]);

    let obj = js_sys::Object::new();
    let _ = js_sys::Reflect::set(&obj, &"type".into(), &"cells".into());
    let _ = js_sys::Reflect::set(&obj, &"cells".into(), &cells);
    let _ = callback.call1(&JsValue::NULL, &obj);

    self.last_flush_idx = self.explored_cells.len();
  }
}

/// Find a path through terrain using A*-like fringe search.
///
/// Inputs are raw row-major Float32Array slices plus the geo-transform
/// (NW-corner origin and pixel scale in degrees). Pixel scales are converted
/// to meters via cos(centre_lat) so Sobel/A* edge costs are correct away from
/// the equator. No GeoTIFF parsing on the hot path.
#[wasm_bindgen]
pub fn find_path_rs(
  elevations: &[f32],
  azimuths: &[f32],
  gradients: &[f32],
  runout_zones: &[f32],
  width: u32,
  height: u32,
  origin_x: f64,
  origin_y: f64,
  pixel_scale_x: f64,
  pixel_scale_y: f64,
  start: String,
  end: String,
  max_gradient: Option<f64>,
  excluded_aspects: JsValue,
  aspect_gradient_threshold: Option<f64>,
  exploration_callback: Option<Function>,
  _exploration_batch_size: Option<usize>,
) -> Result<String, JsValue> {
  let max_gradient: f64 = max_gradient.unwrap_or(1.0);
  let excluded_aspects: Vec<Aspect> = if excluded_aspects.is_undefined() || excluded_aspects.is_null() {
    vec![]
  } else {
    serde_wasm_bindgen::from_value(excluded_aspects).unwrap_or(vec![])
  };
  let aspect_gradient_threshold: f64 = aspect_gradient_threshold.unwrap_or(0.0);

  let width_us: usize = width as usize;
  let height_us: usize = height as usize;
  let expected_len: usize = width_us * height_us;

  if elevations.len() != expected_len {
    return Err(JsValue::from_str(&format!(
      "elevations length {} != width*height {}", elevations.len(), expected_len
    )));
  }
  if azimuths.len() != expected_len {
    return Err(JsValue::from_str("azimuths length mismatch"));
  }
  if gradients.len() != expected_len {
    return Err(JsValue::from_str("gradients length mismatch"));
  }
  let has_runout = !runout_zones.is_empty();
  if has_runout && runout_zones.len() != expected_len {
    return Err(JsValue::from_str("runout_zones length mismatch"));
  }

  // Convert degrees-per-pixel to meters at the raster centre. pixel_scale_y is
  // negative for terrain tiles (lat decreases as y increases).
  let centre_lat = origin_y + pixel_scale_y * (height as f64) / 2.0;
  let (px_x_m, px_y_m) = deg_pixel_to_meters([pixel_scale_x, pixel_scale_y], centre_lat);

  // Geo helpers in degrees (for waypoint lookup / output). pixel_scale_y < 0.
  let coord_to_pixel = |lon: f64, lat: f64| -> (i32, i32) {
    let x = ((lon - origin_x) / pixel_scale_x).floor() as i32;
    let y = ((lat - origin_y) / pixel_scale_y).floor() as i32;
    (x, y)
  };
  let pixel_to_coord = |x: u32, y: u32| -> (f64, f64) {
    let lon = origin_x + (x as f64 + 0.5) * pixel_scale_x;
    let lat = origin_y + (y as f64 + 0.5) * pixel_scale_y;
    (lon, lat)
  };

  let (start_lon, start_lat) = parse_point_to_coordinate(&start)?;
  let (end_lon, end_lat) = parse_point_to_coordinate(&end)?;

  let (start_x, start_y) = coord_to_pixel(start_lon, start_lat);
  if start_x < 0 || start_y < 0 || (start_x as usize) >= width_us || (start_y as usize) >= height_us {
    return Err(JsValue::from_str(&format!(
      "Start point ({}, {}) is outside raster bounds ({}x{})",
      start_x, start_y, width_us, height_us
    )));
  }
  let start_node: (usize, usize) = (start_x as usize, start_y as usize);

  let (end_x, end_y) = coord_to_pixel(end_lon, end_lat);
  if end_x < 0 || end_y < 0 || (end_x as usize) >= width_us || (end_y as usize) >= height_us {
    return Err(JsValue::from_str(&format!(
      "End point ({}, {}) is outside raster bounds ({}x{})",
      end_x, end_y, width_us, height_us
    )));
  }
  let end_node: (usize, usize) = (end_x as usize, end_y as usize);

  let tracker = Rc::new(RefCell::new(ExplorationTracker::new(exploration_callback)));
  tracker.borrow().send_init(
    (origin_x, origin_y),
    (pixel_scale_x, pixel_scale_y),
    width,
    height,
  );
  let tracker_clone = tracker.clone();

  let idx = |x: usize, y: usize| -> usize { y * width_us + x };

  let is_blocked_by_aspect = |i: usize| -> bool {
    let g = gradients[i] as f64;
    if g <= aspect_gradient_threshold {
      return false;
    }
    let azimuth = azimuths[i] as f64;
    for aspect in &excluded_aspects {
      if aspect.contains_azimuth(azimuth, Some(ASPECT_TOLERANCE_DEG)) {
        return true;
      }
    }
    false
  };

  let is_blocked = |i: usize| -> bool {
    if has_runout && runout_zones[i] >= RUNOUT_BLOCK {
      return true;
    }
    is_blocked_by_aspect(i)
  };

  const DIRECTIONS: [(isize, isize); 8] = [
    (0, 1), (1, 0), (0, -1), (-1, 0),
    (1, 1), (1, -1), (-1, -1), (-1, 1),
  ];

  let heuristic = |&(x, y): &(usize, usize)| -> u32 {
    octile_distance((x, y), end_node, px_x_m, px_y_m) as u32
  };

  let successors = |&(x, y): &(usize, usize)| -> Vec<((usize, usize), u32)> {
    tracker_clone.borrow_mut().add_node(x, y);

    let mut neighbours: Vec<((usize, usize), u32)> = Vec::with_capacity(8);
    let cur_idx = idx(x, y);
    let cur_elev = elevations[cur_idx];

    for &(dx, dy) in DIRECTIONS.iter() {
      let nx_i = x as isize + dx;
      let ny_i = y as isize + dy;
      if nx_i < 0 || ny_i < 0 {
        continue;
      }
      let nx = nx_i as usize;
      let ny = ny_i as usize;
      if nx >= width_us || ny >= height_us {
        continue;
      }
      let n_idx = idx(nx, ny);

      if is_blocked(n_idx) {
        continue;
      }

      // No corner-cutting: a diagonal step is rejected if both adjoining
      // cardinal cells are blocked, since the path "sweeps" through them.
      if dx != 0 && dy != 0 {
        let cardinal_x_idx = idx(nx, y);
        let cardinal_y_idx = idx(x, ny);
        if is_blocked(cardinal_x_idx) && is_blocked(cardinal_y_idx) {
          continue;
        }
      }

      let d = euclidean_distance((x, y), (nx, ny), px_x_m, px_y_m);
      let dz = (elevations[n_idx] - cur_elev) as f64;
      let gradient = dz / d;
      if gradient >= max_gradient {
        continue;
      }

      let runout_intensity = if has_runout { runout_zones[n_idx] } else { 0.0 };
      let cost = cost_fn(d, gradient, runout_intensity);
      neighbours.push(((nx, ny), cost));
    }
    neighbours
  };

  let is_end_node = |&node: &(usize, usize)| -> bool { node == end_node };

  let result: Option<(Vec<(usize, usize)>, u32)> =
    fringe(&start_node, successors, heuristic, is_end_node);

  tracker.borrow_mut().flush();

  let path_nodes: Vec<(usize, usize)> = match result {
    Some((path, _)) => path,
    None => return Err(JsValue::from_str("No path found")),
  };

  let features: Vec<geojson::Feature> = path_nodes
    .iter()
    .map(|(x, y)| {
      let (lon, lat) = pixel_to_coord(*x as u32, *y as u32);
      let i = idx(*x, *y);
      let elevation = elevations[i] as f64;
      let azimuth = azimuths[i] as f64;
      let aspect = Aspect::from_azimuth(azimuth);
      geojson::Feature {
        bbox: None,
        geometry: Some(Geometry::new(Value::Point(vec![lon, lat, elevation]))),
        id: None,
        properties: Some(
          serde_json::json!({
            "aspect": serde_json::to_value(&aspect).unwrap(),
            "azimuth": azimuth.to_string(),
          })
          .as_object()
          .unwrap()
          .clone(),
        ),
        foreign_members: None,
      }
    })
    .collect();

  Ok(FeatureCollection { features, bbox: None, foreign_members: None }.to_string())
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
  use super::*;

  #[test]
  fn octile_matches_known_diagonal_path() {
    // 3 diagonal steps + 4 straight steps on a 10m grid: 3*sqrt(2)*10 + 4*10.
    let h = octile_distance((0, 0), (7, 3), 10.0, 10.0);
    let expected = 3.0 * (2.0_f64).sqrt() * 10.0 + 4.0 * 10.0;
    assert!((h - expected).abs() < 1e-6, "octile got {}, expected {}", h, expected);
  }

  #[test]
  fn euclidean_anisotropic_distance() {
    let d = euclidean_distance((0, 0), (3, 4), 8.0, 12.0);
    let expected = ((3.0 * 8.0_f64).powi(2) + (4.0 * 12.0_f64).powi(2)).sqrt();
    assert!((d - expected).abs() < 1e-6);
  }

  #[test]
  fn cost_fn_floors_at_distance_for_flat_terrain() {
    assert_eq!(cost_fn(10.0, 0.0, 0.0), 10);
  }

  #[test]
  fn cost_fn_penalises_runout_intensity() {
    let cost_clean = cost_fn(10.0, 0.0, 0.0);
    let cost_runout = cost_fn(10.0, 0.0, 0.4);
    assert!(cost_runout > cost_clean);
  }

  #[test]
  fn parse_point_to_coordinate_extracts_lon_lat() {
    let s = r#"{"type":"Point","coordinates":[-122.4,37.8]}"#;
    let (lon, lat) = parse_point_to_coordinate(s).expect("should parse");
    assert!((lon - (-122.4)).abs() < 1e-9, "lon wrong: {}", lon);
    assert!((lat - 37.8).abs() < 1e-9, "lat wrong: {}", lat);
  }
}
