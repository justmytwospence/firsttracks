use std::{cell::RefCell, collections::HashSet, f64::consts::E, io::Cursor, rc::Rc};

use geojson::{FeatureCollection, GeoJson, Geometry, Value};
use georaster::{geotiff::GeoTiffReader, Coordinate};
use js_sys::Function;
use pathfinding::directed::fringe::fringe;
use wasm_bindgen::prelude::*;
use crate::{azimuth::Aspect, raster::get_raster};

fn parse_point_to_coordinate(point_str: &str) -> Result<Coordinate, JsValue> {
  let geojson: GeoJson = GeoJson::from_json_value(point_str.parse().unwrap())
    .map_err(|_| JsValue::from_str("Invalid GeoJSON"))?;

  match geojson {
    GeoJson::Geometry(Geometry {
      value: Value::Point(coords),
      ..
    }) => Ok(Coordinate::new(coords[1], coords[0])),
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
///
/// Flushes fire on a wall-clock cadence (~33 ms) rather than on radial growth, so each batch is
/// predictable in size and digestible on the main thread regardless of how fast or slow the
/// search is moving through terrain. Each flush ships ONLY cells added since the previous flush
/// (incremental), so total transfer and draw cost are O(n) over the search instead of O(n²).
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
  fn new(callback: Option<Function>, geotiff: &GeoTiffReader<Cursor<Vec<u8>>>, _batch_size: usize) -> Self {
    let origin = geotiff.origin().unwrap_or([0.0, 0.0]);
    let pixel_scale_arr = geotiff.pixel_size().unwrap_or([1.0/10800.0, -1.0/10800.0]);
    let (raster_width, raster_height) = geotiff.image_info().dimensions.unwrap_or((1, 1));

    Self {
      callback,
      explored_cells: Vec::with_capacity(50000),
      explored_set: HashSet::with_capacity(50000),
      pixel_scale: (pixel_scale_arr[0], pixel_scale_arr[1]),
      origin: (origin[0], origin[1]),
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

    // Amortize the Date::now() call across TIME_CHECK_NODE_STRIDE nodes so the
    // pathfinding hot loop isn't dominated by the time check.
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

  /// Ship cells added since the previous flush. No-op if there are no new cells.
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

#[wasm_bindgen]
pub fn find_path_rs(
  elevations_buffer: &[u8],
  start: String,
  end: String,
  max_gradient: Option<f64>,
  azimuths_buffer: &[u8],
  excluded_aspects: JsValue,
  gradients_buffer: &[u8],
  aspect_gradient_threshold: Option<f64>,
  exploration_callback: Option<Function>,
  exploration_batch_size: Option<usize>,
  runout_zones_buffer: Option<Vec<u8>>,
) -> Result<String, JsValue> { 
  let max_gradient: f64 = max_gradient.unwrap_or(1.0);
  let excluded_aspects: Vec<Aspect> = if excluded_aspects.is_undefined() || excluded_aspects.is_null() {
    vec![]
  } else {
    serde_wasm_bindgen::from_value(excluded_aspects).unwrap_or(vec![])
  };
  let aspect_gradient_threshold: f64 = aspect_gradient_threshold.unwrap_or(0.0);

  let elevations_cursor: Cursor<Vec<u8>> = Cursor::new(elevations_buffer.to_vec());
  let mut elevations_geotiff: GeoTiffReader<Cursor<Vec<u8>>> = GeoTiffReader::open(elevations_cursor)
    .map_err(|e| JsValue::from_str(&format!("Failed to open elevations GeoTIFF: {:?}", e)))?;
  let elevations: Vec<Vec<f64>> = get_raster(&mut elevations_geotiff)?;

  let azimuths_cursor: Cursor<Vec<u8>> = Cursor::new(azimuths_buffer.to_vec());
  let mut azimuths_geotiff: GeoTiffReader<Cursor<Vec<u8>>> = GeoTiffReader::open(azimuths_cursor)
    .map_err(|e| JsValue::from_str(&format!("Failed to open azimuths GeoTIFF: {:?}", e)))?;
  let azimuths: Vec<Vec<f64>> = get_raster(&mut azimuths_geotiff)?;

  let gradients_cursor: Cursor<Vec<u8>> = Cursor::new(gradients_buffer.to_vec());
  let mut gradients_geotiff: GeoTiffReader<Cursor<Vec<u8>>> = GeoTiffReader::open(gradients_cursor)
    .map_err(|e| JsValue::from_str(&format!("Failed to open gradients GeoTIFF: {:?}", e)))?;
  let gradients: Vec<Vec<f64>> = get_raster(&mut gradients_geotiff)?;

  // Parse runout zones if provided
  let runout_zones: Option<Vec<Vec<f64>>> = if let Some(buffer) = runout_zones_buffer {
    let runout_cursor: Cursor<Vec<u8>> = Cursor::new(buffer);
    let mut runout_geotiff: GeoTiffReader<Cursor<Vec<u8>>> = GeoTiffReader::open(runout_cursor)
      .map_err(|e| JsValue::from_str(&format!("Failed to open runout zones GeoTIFF: {:?}", e)))?;
    Some(get_raster(&mut runout_geotiff)?)
  } else {
    None
  };

  let start_coord: Coordinate = parse_point_to_coordinate(&start)?;
  let end_coord: Coordinate = parse_point_to_coordinate(&end)?;

  let (width, height) = elevations_geotiff.image_info().dimensions
    .ok_or_else(|| JsValue::from_str("Failed to get image dimensions"))?;
  let width: usize = width as usize;
  let height: usize = height as usize;

  let (start_x, start_y) = elevations_geotiff.coord_to_pixel(start_coord)
    .ok_or_else(|| JsValue::from_str("Failed to convert start coord to pixel"))?;
  let start_node: (usize, usize) = (start_x as usize, start_y as usize);
  
  // Validate start node is within bounds
  if start_node.0 >= width || start_node.1 >= height {
    return Err(JsValue::from_str(&format!(
      "Start point ({}, {}) is outside raster bounds ({}x{})",
      start_node.0, start_node.1, width, height
    )));
  }
  
  let (end_x, end_y) = elevations_geotiff.coord_to_pixel(end_coord)
    .ok_or_else(|| JsValue::from_str("Failed to convert end coord to pixel"))?;
  let end_node: (usize, usize) = (end_x as usize, end_y as usize);
  
  // Validate end node is within bounds
  if end_node.0 >= width || end_node.1 >= height {
    return Err(JsValue::from_str(&format!(
      "End point ({}, {}) is outside raster bounds ({}x{})",
      end_node.0, end_node.1, width, height
    )));
  }

  // Create exploration tracker
  let batch_size = exploration_batch_size.unwrap_or(500);
  let tracker = Rc::new(RefCell::new(ExplorationTracker::new(exploration_callback, &elevations_geotiff, batch_size)));
  let tracker_clone = tracker.clone();

  let heuristic = |&(x, y): &(usize, usize)| -> i32 {
    distance((x, y), end_node) as i32
  };

  let successors = |&(x, y): &(usize, usize)| -> Vec<((usize, usize), i32)> {
    // Track exploration for visualization
    tracker_clone.borrow_mut().add_node(x, y);
    
    const DIRECTIONS: [(isize, isize); 8] = [
      (0, 1), (1, 0), (0, -1), (-1, 0),
      (1, 1), (1, -1), (-1, -1), (-1, 1),
    ];

    let mut neighbors: Vec<((usize, usize), i32)> = Vec::with_capacity(8);
    'neighbors: for &(dx, dy) in DIRECTIONS.iter() {
      let nx: usize = ((x as isize) + dx) as usize;
      let ny: usize = ((y as isize) + dy) as usize;

      if nx < width && ny < height {
        // Check if neighbor is in a runout zone
        if let Some(ref runout) = runout_zones {
          if runout[ny][nx] > 0.0 {
            continue 'neighbors;
          }
        }

        let azimuth: f64 = azimuths[ny][nx];
        let aspect_gradient: f64 = gradients[ny][nx];
        if aspect_gradient > aspect_gradient_threshold {
          for aspect in &excluded_aspects {
            // Use 22.5° tolerance to also exclude half of adjacent aspects
            if aspect.contains_azimuth(azimuth, Some(22.5)) {
              continue 'neighbors;
            }
          }
        }

        let d: f64 = distance((x, y), (nx, ny));
        let dz: f64 = elevations[ny][nx] - elevations[y][x];
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

  // Flush any remaining exploration nodes
  tracker.borrow_mut().flush();

  let path_nodes: Vec<(usize, usize)> = match result {
    Some((path, _)) => path,
    None => return Err(JsValue::from_str("No path found")),
  };

  // Create feature collection with points
  let results: String = FeatureCollection {
    features: path_nodes
      .iter()
      .map(|(x, y)| {
        let coordinate: Coordinate = elevations_geotiff.pixel_to_coord(*x as u32, *y as u32).unwrap();
        let elevation: f64 = elevations[*y][*x];
        let azimuth: f64 = azimuths[*y][*x];
        let aspect: Aspect = Aspect::from_azimuth(azimuth);
        geojson::Feature {
          bbox: None,
          geometry: Some(Geometry::new(Value::Point(vec![
            coordinate.x,
            coordinate.y,
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