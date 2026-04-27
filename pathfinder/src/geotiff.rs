use std::io::Cursor;
use tiff::encoder::colortype::Gray32Float;
use tiff::encoder::TiffEncoder;
use tiff::tags::Tag;
use wasm_bindgen::prelude::*;

/// Standard GeoTIFF keys for geographic CRS (EPSG:4326 / WGS84).
const WGS84_GEO_KEYS: [u32; 20] = [
  1, 1, 0, 4,           // KeyDirectoryVersion, KeyRevision, MinorRevision, NumberOfKeys
  1024, 0, 1, 2,        // GTModelTypeGeoKey = Geographic
  1025, 0, 1, 1,        // GTRasterTypeGeoKey = PixelIsArea
  2048, 0, 1, 4326,     // GeographicTypeGeoKey = WGS84
  2054, 0, 1, 9102,     // GeogAngularUnitsGeoKey = Degree
];

/// Serialize a flat raster (row-major f32) to GeoTIFF bytes, preserving the
/// caller's geo keys, origin (top-left lon/lat), and pixel scale.
pub fn serialize_to_geotiff_flat(
  data: &[f32],
  width: usize,
  height: usize,
  geo_keys: &[u32],
  origin: &[f64; 2],
  pixel_scale_deg: &[f64; 2],
) -> Result<Vec<u8>, JsValue> {
  if data.len() != width * height {
    return Err(JsValue::from_str(&format!(
      "Raster size {} doesn't match dimensions {}x{}={}",
      data.len(), width, height, width * height
    )));
  }

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
      .write_tag(Tag::Unknown(34735), geo_keys)
      .map_err(|e| JsValue::from_str(&format!("Failed to write geo_keys: {}", e)))?;

    let pixel_scale: [f64; 3] = [pixel_scale_deg[0], pixel_scale_deg[1], 0.0];
    image
      .encoder()
      .write_tag(Tag::Unknown(33550), &pixel_scale[..])
      .map_err(|e| JsValue::from_str(&format!("Failed to write pixel scale: {}", e)))?;

    let tie_points: [f64; 6] = [0.0, 0.0, 0.0, origin[0], origin[1], 0.0];
    image
      .encoder()
      .write_tag(Tag::Unknown(33922), &tie_points[..])
      .map_err(|e| JsValue::from_str(&format!("Failed to write tie points: {}", e)))?;

    image
      .write_data(data)
      .map_err(|e| JsValue::from_str(&format!("Failed to write data: {}", e)))?;
  }
  Ok(cursor.into_inner())
}

/// Convert a flat Float32Array to GeoTIFF format with custom bounds.
/// Used by JavaScript to wrap AWS Terrain Tiles elevation arrays as GeoTIFF.
#[wasm_bindgen]
pub fn array_to_geotiff(
  elevations: &[f32],
  width: u32,
  height: u32,
  west: f64,
  north: f64,
  east: f64,
  south: f64,
) -> Result<Vec<u8>, JsValue> {
  let width = width as usize;
  let height = height as usize;

  // Y pixel scale is stored as positive in ModelPixelScale (tag 33550).
  // The georaster crate's pixel_size() method negates it automatically, so
  // coord_to_pixel computes y = (coord.y - north) / -pixel_size_y, positive
  // for points south of the origin.
  let pixel_scale_x = (east - west) / width as f64;
  let pixel_scale_y = (north - south) / height as f64;

  serialize_to_geotiff_flat(
    elevations,
    width,
    height,
    &WGS84_GEO_KEYS,
    &[west, north],
    &[pixel_scale_x, pixel_scale_y],
  )
}
