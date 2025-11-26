use web_sys::console;

pub(crate) fn console_log(message: &str) {
  console::log_1(&message.into());
}
