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

/// Convert a flat Float32Array to GeoTIFF format with custom bounds.
/// This allows JavaScript to create GeoTIFF data from AWS Terrain Tiles elevation arrays.
/// 
/// Parameters:
/// - elevations: Flat array of elevation values in row-major order
/// - width: Width of the raster in pixels
/// - height: Height of the raster in pixels
/// - west: Western longitude bound
/// - north: Northern latitude bound
/// - east: Eastern longitude bound
/// - south: Southern latitude bound
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
  
  // Validate input size
  if elevations.len() != width * height {
    return Err(JsValue::from_str(&format!(
      "Elevation array size {} doesn't match dimensions {}x{}={}",
      elevations.len(), width, height, width * height
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

    // Standard GeoTIFF keys for geographic CRS (EPSG:4326)
    let geo_keys: Vec<u32> = vec![
      1, 1, 0, 4,           // KeyDirectoryVersion, KeyRevision, MinorRevision, NumberOfKeys
      1024, 0, 1, 2,        // GTModelTypeGeoKey = Geographic
      1025, 0, 1, 1,        // GTRasterTypeGeoKey = PixelIsArea
      2048, 0, 1, 4326,     // GeographicTypeGeoKey = WGS84
      2054, 0, 1, 9102,     // GeogAngularUnitsGeoKey = Degree
    ];
    
    image
      .encoder()
      .write_tag(Tag::Unknown(34735), &geo_keys[..])
      .map_err(|e| JsValue::from_str(&format!("Failed to write geo_keys: {}", e)))?;
    
    // Calculate pixel scale from bounds
    let pixel_scale_x = (east - west) / width as f64;
    let pixel_scale_y = (north - south) / height as f64;
    let pixel_scale: Vec<f64> = vec![pixel_scale_x, pixel_scale_y, 0.0];
    image
      .encoder()
      .write_tag(Tag::Unknown(33550), &pixel_scale[..])
      .map_err(|e| JsValue::from_str(&format!("Failed to write pixel scale: {}", e)))?;
    
    // Tie point: pixel (0,0) corresponds to (west, north)
    let tie_points: Vec<f64> = vec![0.0, 0.0, 0.0, west, north, 0.0];
    image
      .encoder()
      .write_tag(Tag::Unknown(33922), &tie_points[..])
      .map_err(|e| JsValue::from_str(&format!("Failed to write tie points: {}", e)))?;

    image
      .write_data(elevations)
      .map_err(|e| JsValue::from_str(&format!("Failed to write data: {}", e)))?;
  }
  
  Ok(cursor.into_inner())
}