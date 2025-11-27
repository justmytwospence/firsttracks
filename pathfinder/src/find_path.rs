use std::{cell::RefCell, collections::HashSet, f64::consts::E, io::Cursor, rc::Rc};

use geojson::{FeatureCollection, GeoJson, Geometry, Value};
use georaster::{geotiff::GeoTiffReader, Coordinate};
use js_sys::Function;
use pathfinding::directed::fringe::fringe;
use wasm_bindgen::prelude::*;
use crate::{azimuth::Aspect, console_log::console_log, raster::get_raster};

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

/// Exploration tracker using interior mutability for callback batching
/// Tracks the true expanding frontier (boundary of explored region)
struct ExplorationTracker {
  callback: Option<Function>,
  explored: HashSet<(usize, usize)>,  // All visited nodes
  frontier: HashSet<(usize, usize)>,   // Current boundary nodes (explored with unexplored neighbors)
  batch_counter: usize,
  total_explored: usize,  // Running count for adaptive batch sizing
  base_batch_size: usize,
  pixel_scale: (f64, f64),  // (dx, dy) for pixel to coord conversion
  origin: (f64, f64),       // (x, y) origin
  width: usize,
  height: usize,
}

impl ExplorationTracker {
  fn new(callback: Option<Function>, geotiff: &GeoTiffReader<Cursor<Vec<u8>>>, batch_size: usize, width: usize, height: usize) -> Self {
    // Get transform parameters from geotiff
    let origin = geotiff.origin().unwrap_or([0.0, 0.0]);
    let pixel_scale_arr = geotiff.pixel_size().unwrap_or([1.0/10800.0, -1.0/10800.0]);
    
    Self {
      callback,
      explored: HashSet::new(),
      frontier: HashSet::new(),
      batch_counter: 0,
      total_explored: 0,
      base_batch_size: batch_size,
      pixel_scale: (pixel_scale_arr[0], pixel_scale_arr[1]),
      origin: (origin[0], origin[1]),
      width,
      height,
    }
  }

  /// Compute adaptive batch size based on total explored nodes
  /// Starts slow for visual feedback, ramps up exponentially
  fn current_batch_size(&self) -> usize {
    // Use log2 scaling: batch doubles roughly every 10x explored nodes
    // 0-500: base (500)
    // 500-5k: 2x (1000)  
    // 5k-50k: 4x (2000)
    // 50k-500k: 8x (4000)
    // 500k+: 16x (8000)
    let multiplier = if self.total_explored < 500 {
      1
    } else {
      // log10(total) gives us roughly: 500->2.7, 5k->3.7, 50k->4.7, 500k->5.7
      // Subtract 2.5 and use as power of 2
      let log_val = (self.total_explored as f64).log10() - 2.5;
      let power = log_val.max(0.0).min(4.0); // Cap at 16x
      (2.0_f64.powf(power)) as usize
    };
    
    self.base_batch_size * multiplier
  }

  /// Called when a node is visited - updates explored set and frontier
  fn add_node(&mut self, x: usize, y: usize) {
    if self.callback.is_none() {
      return;
    }

    // Add to explored set
    self.explored.insert((x, y));
    self.total_explored += 1;
    
    // Add to frontier (will be refined when we check its neighbors)
    self.frontier.insert((x, y));
    
    // Check if this node should remain on frontier (has any unexplored neighbors)
    // Also remove neighbors from frontier if they're now fully surrounded
    self.update_frontier_around(x, y);
    
    self.batch_counter += 1;
    if self.batch_counter >= self.current_batch_size() {
      self.flush();
      self.batch_counter = 0;
    }
  }

  /// Update frontier status for a node and its neighbors
  fn update_frontier_around(&mut self, x: usize, y: usize) {
    const DIRECTIONS: [(isize, isize); 8] = [
      (0, 1), (1, 0), (0, -1), (-1, 0),
      (1, 1), (1, -1), (-1, -1), (-1, 1),
    ];

    // Check if current node should be on frontier
    let mut has_unexplored_neighbor = false;
    for &(dx, dy) in DIRECTIONS.iter() {
      let nx = (x as isize + dx) as usize;
      let ny = (y as isize + dy) as usize;
      if nx < self.width && ny < self.height && !self.explored.contains(&(nx, ny)) {
        has_unexplored_neighbor = true;
        break;
      }
    }
    
    if !has_unexplored_neighbor {
      self.frontier.remove(&(x, y));
    }
    
    // Check neighbors that were on frontier - they might now be interior
    for &(dx, dy) in DIRECTIONS.iter() {
      let nx = (x as isize + dx) as usize;
      let ny = (y as isize + dy) as usize;
      if nx < self.width && ny < self.height && self.frontier.contains(&(nx, ny)) {
        // Check if this neighbor still has unexplored neighbors
        let mut still_frontier = false;
        for &(ddx, ddy) in DIRECTIONS.iter() {
          let nnx = (nx as isize + ddx) as usize;
          let nny = (ny as isize + ddy) as usize;
          if nnx < self.width && nny < self.height && !self.explored.contains(&(nnx, nny)) {
            still_frontier = true;
            break;
          }
        }
        if !still_frontier {
          self.frontier.remove(&(nx, ny));
        }
      }
    }
  }

  fn flush(&mut self) {
    if let Some(ref callback) = self.callback {
      if !self.frontier.is_empty() {
        // Convert frontier to JS array of [lon, lat] pairs
        let arr = js_sys::Array::new();
        for (x, y) in &self.frontier {
          // Convert pixel to coordinate
          let lon = self.origin.0 + (*x as f64) * self.pixel_scale.0;
          let lat = self.origin.1 + (*y as f64) * self.pixel_scale.1;
          
          let point = js_sys::Array::new();
          point.push(&JsValue::from_f64(lon));
          point.push(&JsValue::from_f64(lat));
          arr.push(&point);
        }
        
        let _ = callback.call1(&JsValue::NULL, &arr);
      }
    }
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

  let start_coord: Coordinate = parse_point_to_coordinate(&start)?;
  let end_coord: Coordinate = parse_point_to_coordinate(&end)?;

  let (start_x, start_y) = elevations_geotiff.coord_to_pixel(start_coord)
    .ok_or_else(|| JsValue::from_str("Failed to convert start coord to pixel"))?;
  let start_node: (usize, usize) = (start_x as usize, start_y as usize);
  let (end_x, end_y) = elevations_geotiff.coord_to_pixel(end_coord)
    .ok_or_else(|| JsValue::from_str("Failed to convert end coord to pixel"))?;
  let end_node: (usize, usize) = (end_x as usize, end_y as usize);

  let (width, height) = elevations_geotiff.image_info().dimensions
    .ok_or_else(|| JsValue::from_str("Failed to get image dimensions"))?;
  let width: usize = width as usize;
  let height: usize = height as usize;

  // Create exploration tracker with callback using Rc<RefCell> for interior mutability
  // Large batch_size (10000) for fast animation - JS throttles to 30fps anyway
  let batch_size = exploration_batch_size.unwrap_or(10000);
  let tracker = Rc::new(RefCell::new(ExplorationTracker::new(exploration_callback, &elevations_geotiff, batch_size, width, height)));
  let tracker_clone = tracker.clone();

  let heuristic = |&(x, y): &(usize, usize)| -> i32 {
    distance((x, y), end_node) as i32
  };

  let d: f64 = distance((start_node.0, start_node.1), (end_node.0, end_node.1));
  let dz: f64 = elevations[end_node.1][end_node.0] - elevations[start_node.1][start_node.0];
  let gradient: f64 = dz / d;
  
  console_log(&format!(
    "Width: {}, Height: {}, Start: ({}, {}), Goal: ({}, {}), Distance: {:.2}, Gradient: {:.4}",
    width, height, start_node.0, start_node.1, end_node.0, end_node.1, d, gradient
  ));

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
        let azimuth: f64 = azimuths[ny][nx];
        let aspect_gradient: f64 = gradients[ny][nx];
        if aspect_gradient > aspect_gradient_threshold {
          for aspect in &excluded_aspects {
            if aspect.contains_azimuth(azimuth, Some(2.5)) {
              break 'neighbors;
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