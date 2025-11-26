use georaster::geotiff::{GeoTiffReader, RasterValue};
use std::io::{Read, Seek};
use wasm_bindgen::prelude::*;

pub fn get_raster<R: Read + Seek + Send>(geotiff: &mut GeoTiffReader<R>) -> Result<Vec<Vec<f64>>, JsValue> {
  let (width, height) = geotiff.image_info().dimensions
    .ok_or_else(|| JsValue::from_str("Failed to get image dimensions"))?;
  let width: usize = width as usize;
  let height: usize = height as usize;

  let mut raster_data: Vec<Vec<f64>> = vec![vec![0.0; width]; height];
  for pixel in geotiff.pixels(0, 0, width as u32, height as u32) {
    let (x, y, value) = pixel;
    let data: f64 = match value {
      RasterValue::F64(v) => v,
      RasterValue::F32(v) => v as f64,
      _ => return Err(JsValue::from_str(&format!("Data must be f64, found: {:?}", value))),
    };
    raster_data[y as usize][x as usize] = data;
  }
  Ok(raster_data)
}
