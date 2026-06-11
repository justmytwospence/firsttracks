use wasm_bindgen::prelude::*;

mod azimuth;
mod find_path;

pub use azimuth::{
  compute_azimuths_from_array, compute_runout_for_aspects, Aspect, AzimuthArrayResult,
};
pub use find_path::find_path_rs;

// Initialize panic hook for better error messages in browser console
#[wasm_bindgen]
pub fn init() {
    console_error_panic_hook::set_once();
}