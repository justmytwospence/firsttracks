use wasm_bindgen::prelude::*;

mod azimuth;
mod console_log;
mod find_path;
mod geotiff;
mod raster;

pub use azimuth::{
  compute_azimuths, compute_azimuths_from_array, compute_runout_for_aspects,
  Aspect, AzimuthArrayResult, AzimuthResult,
};
pub use find_path::find_path_rs;
pub use geotiff::{array_to_geotiff, serialize_to_geotiff_flat};
pub use raster::get_raster_flat;

// Initialize panic hook for better error messages in browser console
#[wasm_bindgen]
pub fn init() {
    console_error_panic_hook::set_once();
}