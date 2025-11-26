use std::io::Cursor;
use tiff::encoder::colortype::Gray32Float;
use tiff::encoder::TiffEncoder;
use tiff::tags::Tag;
use wasm_bindgen::prelude::*;

pub fn serialize_to_geotiff(
  raster: Vec<Vec<f64>>,
  geo_keys: &Vec<u32>,
  origin: &[f64; 2]
) -> Result<Vec<u8>, JsValue> {
  let height: usize = raster.len();
  let width: usize = raster[0].len();
  let buffer: Vec<u8> = Vec::new();
  let mut cursor: Cursor<Vec<u8>> = Cursor::new(buffer);
  let mut encoder: TiffEncoder<&mut Cursor<Vec<u8>>> = TiffEncoder::new(&mut cursor)
    .map_err(|e| JsValue::from_str(&format!("Failed to create encoder: {}", e)))?;
  {
    let mut image = encoder
      .new_image::<Gray32Float>(width as u32, height as u32)
      .map_err(|e| JsValue::from_str(&format!("Failed to create image: {}", e)))?;

    image
      .encoder()
      .write_tag(Tag::Unknown(34735), &**geo_keys)
      .map_err(|e| JsValue::from_str(&format!("Failed to write geo_keys: {}", e)))?;
    image
      .encoder()
      .write_tag(Tag::Unknown(34737), "NAD83|}")
      .map_err(|e| JsValue::from_str(&format!("Failed to write CRS: {}", e)))?;
    let geo_doubles: Vec<f64> = vec![6378137.0, 298.257222101];
    image
      .encoder()
      .write_tag(Tag::Unknown(34736), &geo_doubles[..])
      .map_err(|e| JsValue::from_str(&format!("Failed to write geo_doubles: {}", e)))?;
    let one_third_arc_second: f64 = 1.0 / 10800.0;
    let pixel_scale: Vec<f64> = vec![one_third_arc_second, one_third_arc_second, 0.0];
    image
      .encoder()
      .write_tag(Tag::Unknown(33550), &pixel_scale[..])
      .map_err(|e| JsValue::from_str(&format!("Failed to write pixel scale: {}", e)))?;
    let tie_points: Vec<f64> = vec![0.0, 0.0, 0.0, origin[0], origin[1], 0.0];
    image
      .encoder()
      .write_tag(Tag::Unknown(33922), &tie_points[..])
      .map_err(|e| JsValue::from_str(&format!("Failed to write tie points: {}", e)))?;

    let flattened: Vec<f32> = raster.into_iter().flatten().map(|x| x as f32).collect();
    image
      .write_data(&flattened)
      .map_err(|e| JsValue::from_str(&format!("Failed to write data: {}", e)))?;
  }
  Ok(cursor.into_inner())
}