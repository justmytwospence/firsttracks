use std::{cell::RefCell, f64::consts::E, io::Cursor, rc::Rc};

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

fn logistic_multiplier(x: f64) -> f64 {
  const SCALE: f64 = 5.0;
  const GROWTH_RATE: f64 = 70.0;
  const X0: f64 = 0.12;
  let logistic_curve: f64 = SCALE / (1.0 + (-GROWTH_RATE * (x - X0)).exp());
  let y_shift: f64 = 1.0 - SCALE / (1.0 + (GROWTH_RATE * X0).exp());
  logistic_curve + y_shift
}

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
struct ExplorationTracker {
  callback: Option<Function>,
  explored_nodes: Vec<(usize, usize)>,  // pixel coordinates
  batch_size: usize,
  pixel_scale: (f64, f64),  // (dx, dy) for pixel to coord conversion
  origin: (f64, f64),       // (x, y) origin
}

impl ExplorationTracker {
  fn new(callback: Option<Function>, geotiff: &GeoTiffReader<Cursor<Vec<u8>>>, batch_size: usize) -> Self {
    // Get transform parameters from geotiff
    let origin = geotiff.origin().unwrap_or([0.0, 0.0]);
    let pixel_scale_arr = geotiff.pixel_size().unwrap_or([1.0/10800.0, -1.0/10800.0]);
    
    Self {
      callback,
      explored_nodes: Vec::with_capacity(batch_size),
      batch_size,
      pixel_scale: (pixel_scale_arr[0], pixel_scale_arr[1]),
      origin: (origin[0], origin[1]),
    }
  }

  fn add_node(&mut self, x: usize, y: usize) {
    if self.callback.is_some() {
      self.explored_nodes.push((x, y));
      
      if self.explored_nodes.len() >= self.batch_size {
        self.flush();
      }
    }
  }

  fn flush(&mut self) {
    if let Some(ref callback) = self.callback {
      if !self.explored_nodes.is_empty() {
        // Convert to JS array of [lon, lat] pairs
        let arr = js_sys::Array::new();
        for (x, y) in &self.explored_nodes {
          // Convert pixel to coordinate
          let lon = self.origin.0 + (*x as f64) * self.pixel_scale.0;
          let lat = self.origin.1 + (*y as f64) * self.pixel_scale.1;
          
          let point = js_sys::Array::new();
          point.push(&JsValue::from_f64(lon));
          point.push(&JsValue::from_f64(lat));
          arr.push(&point);
        }
        
        let _ = callback.call1(&JsValue::NULL, &arr);
        self.explored_nodes.clear();
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
  // Default batch_size is 125 for smoother animation (4x more frequent than before)
  let batch_size = exploration_batch_size.unwrap_or(125);
  let tracker = Rc::new(RefCell::new(ExplorationTracker::new(exploration_callback, &elevations_geotiff, batch_size)));
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
            "aspect": format!("{:?}", aspect),
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