use georaster::geotiff::{GeoTiffReader, RasterValue};
use std::io::{Read, Seek};
use wasm_bindgen::prelude::*;

/// Read a GeoTIFF as a flat row-major f32 buffer along with (width, height).
/// Returns elevation/azimuth/gradient/runout values uniformly as f32 — sub-meter
/// precision is plenty for terrain analysis and halves bandwidth in the hot loops.
pub fn get_raster_flat<R: Read + Seek + Send>(
  geotiff: &mut GeoTiffReader<R>,
) -> Result<(Vec<f32>, usize, usize), JsValue> {
  let (width, height) = geotiff
    .image_info()
    .dimensions
    .ok_or_else(|| JsValue::from_str("Failed to get image dimensions"))?;
  let width = width as usize;
  let height = height as usize;

  let mut data: Vec<f32> = vec![0.0; width * height];
  for (x, y, value) in geotiff.pixels(0, 0, width as u32, height as u32) {
    let v: f32 = match value {
      RasterValue::F64(v) => v as f32,
      RasterValue::F32(v) => v,
      _ => return Err(JsValue::from_str(&format!("Unsupported raster type: {:?}", value))),
    };
    data[(y as usize) * width + (x as usize)] = v;
  }
  Ok((data, width, height))
}
