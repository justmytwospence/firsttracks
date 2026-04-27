use std::{cell::RefCell, collections::HashSet, f64::consts::E, rc::Rc};

use geojson::{FeatureCollection, GeoJson, Geometry, Value};
use js_sys::Function;
use pathfinding::directed::fringe::fringe;
use wasm_bindgen::prelude::*;
use crate::azimuth::Aspect;

fn parse_point_to_coordinate(point_str: &str) -> Result<(f64, f64), JsValue> {
  let geojson: GeoJson = GeoJson::from_json_value(point_str.parse().unwrap())
    .map_err(|_| JsValue::from_str("Invalid GeoJSON"))?;

  match geojson {
    GeoJson::Geometry(Geometry {
      value: Value::Point(coords),
      ..
    }) => Ok((coords[0], coords[1])),
    _ => Err(JsValue::from_str("Invalid point GeoJSON")),
  }
}

fn distance(a: (usize, usize), b: (usize, usize)) -> f64 {
  let dx: f64 = (b.0 as isize - a.0 as isize).abs() as f64 * 10.0;
  let dy: f64 = (b.1 as isize - a.1 as isize).abs() as f64 * 10.0;
  ((dx * dx) + (dy * dy)).sqrt()
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
  const M: f64 = 50.0;
  const B: f64 = 0.1;
  E.powf(M * (x - B)) + 1.0
}

fn linear_multiplier(x: f64) -> f64 {
  (20.0 * x).clamp(1.0, 20.0)
}

fn cost_fn(distance: f64, gradient: f64) -> i32 {
  let gradient_multiplier: f64 = linear_multiplier(gradient);
  (distance * gradient_multiplier) as i32
}

/// Exploration tracker - streams newly-explored cells to JS for the animated flood-fill overlay.
struct ExplorationTracker {
  callback: Option<Function>,
  explored_cells: Vec<(u16, u16)>,
  explored_set: HashSet<(usize, usize)>,
  pixel_scale: (f64, f64),
  origin: (f64, f64),
  raster_width: u32,
  raster_height: u32,
  last_flush_idx: usize,
  last_flush_time_ms: f64,
  nodes_since_time_check: u32,
}

const FLUSH_INTERVAL_MS: f64 = 33.0;
const TIME_CHECK_NODE_STRIDE: u32 = 200;

impl ExplorationTracker {
  fn new(
    callback: Option<Function>,
    origin: (f64, f64),
    pixel_scale: (f64, f64),
    raster_width: u32,
    raster_height: u32,
  ) -> Self {
    Self {
      callback,
      explored_cells: Vec::with_capacity(50000),
      explored_set: HashSet::with_capacity(50000),
      pixel_scale,
      origin,
      raster_width,
      raster_height,
      last_flush_idx: 0,
      last_flush_time_ms: js_sys::Date::now(),
      nodes_since_time_check: 0,
    }
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

    let obj = js_sys::Object::new();
    js_sys::Reflect::set(&obj, &"originX".into(), &JsValue::from_f64(self.origin.0)).unwrap();
    js_sys::Reflect::set(&obj, &"originY".into(), &JsValue::from_f64(self.origin.1)).unwrap();
    js_sys::Reflect::set(&obj, &"scaleX".into(), &JsValue::from_f64(self.pixel_scale.0)).unwrap();
    js_sys::Reflect::set(&obj, &"scaleY".into(), &JsValue::from_f64(self.pixel_scale.1)).unwrap();
    js_sys::Reflect::set(&obj, &"width".into(), &JsValue::from_f64(self.raster_width as f64)).unwrap();
    js_sys::Reflect::set(&obj, &"height".into(), &JsValue::from_f64(self.raster_height as f64)).unwrap();

    let cells = js_sys::Uint16Array::new_with_length((new_cells.len() * 2) as u32);
    for (i, &(x, y)) in new_cells.iter().enumerate() {
      cells.set_index((i * 2) as u32, x);
      cells.set_index((i * 2 + 1) as u32, y);
    }
    js_sys::Reflect::set(&obj, &"cells".into(), &cells).unwrap();

    let _ = callback.call1(&JsValue::NULL, &obj);

    self.last_flush_idx = self.explored_cells.len();
  }
}

/// Find a path through terrain using A*-like fringe search.
///
/// Inputs are raw row-major Float32Array slices plus the geo-transform
/// (NW-corner origin and pixel scale). This skips the GeoTIFF parsing that
/// the old entry point did per call.
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
  exploration_batch_size: Option<usize>,
) -> Result<String, JsValue> {
  let max_gradient: f64 = max_gradient.unwrap_or(1.0);
  let excluded_aspects: Vec<Aspect> = if excluded_aspects.is_undefined() || excluded_aspects.is_null() {
    vec![]
  } else {
    serde_wasm_bindgen::from_value(excluded_aspects).unwrap_or(vec![])
  };
  let aspect_gradient_threshold: f64 = aspect_gradient_threshold.unwrap_or(0.0);
  let _ = exploration_batch_size; // batch size is now wall-clock based; kept for API compat

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

  // Geo helpers. pixel_scale_y is negative for terrain tiles (lat decreases with y).
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

  let tracker = Rc::new(RefCell::new(ExplorationTracker::new(
    exploration_callback,
    (origin_x, origin_y),
    (pixel_scale_x, pixel_scale_y),
    width,
    height,
  )));
  let tracker_clone = tracker.clone();

  let heuristic = |&(x, y): &(usize, usize)| -> i32 {
    distance((x, y), end_node) as i32
  };

  let idx = |x: usize, y: usize| -> usize { y * width_us + x };

  let successors = |&(x, y): &(usize, usize)| -> Vec<((usize, usize), i32)> {
    tracker_clone.borrow_mut().add_node(x, y);

    const DIRECTIONS: [(isize, isize); 8] = [
      (0, 1), (1, 0), (0, -1), (-1, 0),
      (1, 1), (1, -1), (-1, -1), (-1, 1),
    ];

    let mut neighbors: Vec<((usize, usize), i32)> = Vec::with_capacity(8);
    'neighbors: for &(dx, dy) in DIRECTIONS.iter() {
      let nx_isize: isize = (x as isize) + dx;
      let ny_isize: isize = (y as isize) + dy;
      if nx_isize < 0 || ny_isize < 0 {
        continue;
      }
      let nx: usize = nx_isize as usize;
      let ny: usize = ny_isize as usize;

      if nx < width_us && ny < height_us {
        let n_idx = idx(nx, ny);

        if has_runout && runout_zones[n_idx] > 0.0 {
          continue 'neighbors;
        }

        let azimuth: f64 = azimuths[n_idx] as f64;
        let aspect_gradient: f64 = gradients[n_idx] as f64;
        if aspect_gradient > aspect_gradient_threshold {
          for aspect in &excluded_aspects {
            if aspect.contains_azimuth(azimuth, Some(22.5)) {
              continue 'neighbors;
            }
          }
        }

        let d: f64 = distance((x, y), (nx, ny));
        let dz: f64 = (elevations[n_idx] as f64) - (elevations[idx(x, y)] as f64);
        let gradient: f64 = dz / d;
        if gradient < max_gradient {
          let cost: i32 = cost_fn(d, gradient);
          neighbors.push(((nx, ny), cost));
        }
      }
    }
    neighbors
  };

  let is_end_node = |&node: &(usize, usize)| -> bool { node == end_node };

  let result: Option<(Vec<(usize, usize)>, i32)> =
    fringe(&start_node, successors, heuristic, is_end_node);

  tracker.borrow_mut().flush();

  let path_nodes: Vec<(usize, usize)> = match result {
    Some((path, _)) => path,
    None => return Err(JsValue::from_str("No path found")),
  };

  let results: String = FeatureCollection {
    features: path_nodes
      .iter()
      .map(|(x, y)| {
        let (lon, lat) = pixel_to_coord(*x as u32, *y as u32);
        let elevation: f64 = elevations[idx(*x, *y)] as f64;
        let azimuth: f64 = azimuths[idx(*x, *y)] as f64;
        let aspect: Aspect = Aspect::from_azimuth(azimuth);
        geojson::Feature {
          bbox: None,
          geometry: Some(Geometry::new(Value::Point(vec![
            lon,
            lat,
            elevation,
          ]))),
          id: None,
          properties: Some(serde_json::json!({
            "aspect": serde_json::to_value(&aspect).unwrap(),
            "azimuth": azimuth.to_string(),
          }).as_object().unwrap().clone()),
          foreign_members: None,
        }
      })
      .collect::<Vec<geojson::Feature>>(),
    bbox: None,
    foreign_members: None,
  }
  .to_string();

  Ok(results)
}
