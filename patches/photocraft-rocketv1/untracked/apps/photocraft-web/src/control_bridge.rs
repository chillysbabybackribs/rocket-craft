//! The control bridge for a host that embeds the web build, such as an app showing PhotoCraft
//! in a panel of its own. The desktop app takes control requests over loopback TCP
//! (`photocraft --control`, `docs/control-protocol.md`); a browser page can't listen on a socket,
//! so with `?control` in the URL the page gets `window.photocraft` instead. It feeds the same
//! queue as the desktop transport (`PhotocraftApp::with_control`), so every control method
//! answers exactly as it does there. Without the flag nothing is installed and the public web
//! build is unchanged.
//!
//! `window.photocraft`:
//! - `call(method, paramsJson?)` → a Promise of the reply as JSON text, the same envelope the
//!   desktop channel writes (`{"ok": true, "result": …}` or `{"ok": false, "error": …}`).
//! - `put(path, bytes)`, `take(path)`, `files()`: the page's file store, which stands in for the
//!   disk behind `app.open` and `app.save`. The host puts a file before `app.open {path}` and
//!   takes the bytes after `app.save {path}`. Paths are only names in the store.
//!
//! The page only drains requests while it draws frames. Browsers stop drawing a hidden page, so
//! the host must keep the page visible (or its frame loop running) while it waits for replies.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use photocraft_ui_egui::Services;
use serde_json::Value;

/// The page's file store: what `app.open` reads and `app.save` writes under automation.
#[derive(Clone, Default)]
pub struct Files(Rc<RefCell<BTreeMap<String, Vec<u8>>>>);

impl Files {
    pub fn put(&self, path: &str, bytes: Vec<u8>) {
        self.0.borrow_mut().insert(path.to_string(), bytes);
    }

    /// Removes the file: a saved export is handed over once, so the store doesn't grow.
    pub fn take(&self, path: &str) -> Option<Vec<u8>> {
        self.0.borrow_mut().remove(path)
    }

    pub fn paths(&self) -> Vec<String> {
        self.0.borrow().keys().cloned().collect()
    }

    /// A put file stays after it is opened, so the same path can be opened again.
    fn read(&self, path: &str) -> Result<(String, Vec<u8>), String> {
        let bytes = self
            .0
            .borrow()
            .get(path)
            .cloned()
            .ok_or_else(|| format!("`{path}` is not in the page's file store; put it with photocraft.put(path, bytes) before app.open"))?;
        Ok((file_name(path), bytes))
    }

    fn write(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        if file_name(path).is_empty() {
            return Err(format!("`{path}` has no file name to save under"));
        }
        self.put(path, bytes.to_vec());
        Ok(())
    }

    /// Give control requests this store as their read and write authority, the role the
    /// desktop's authorized workspace plays.
    pub fn attach(&self, services: &mut Services) {
        let read = self.clone();
        services.automation_read = Some(Box::new(move |path: &str| read.read(path)));
        let write = self.clone();
        services.automation_write = Some(Box::new(move |path: &str, bytes: &[u8]| write.write(path, bytes)));
    }
}

fn file_name(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

/// A request's params as given to `call`: JSON text, or nothing for none.
fn parse_params(text: Option<&str>) -> Result<Value, String> {
    match text.map(str::trim) {
        None | Some("") => Ok(Value::Object(serde_json::Map::new())),
        Some(text) => serde_json::from_str(text).map_err(|e| format!("params must be JSON: {e}")),
    }
}

/// Install `window.photocraft` and return the queue to attach with `PhotocraftApp::with_control`.
#[cfg(target_arch = "wasm32")]
pub fn install(ctx: egui::Context, files: Files) -> Result<std::sync::mpsc::Receiver<photocraft_ui_egui::ControlRequest>, String> {
    use photocraft_ui_egui::ControlRequest;
    use photocraft_ui_egui::control::{REPLY_DEADLINE, timeout_error};
    use std::sync::mpsc::TryRecvError;
    use wasm_bindgen::JsValue;
    use wasm_bindgen::closure::Closure;

    let js = |e: JsValue| format!("{e:?}");
    let window = web_sys::window().ok_or("no window")?;
    let (tx, rx) = std::sync::mpsc::channel::<ControlRequest>();
    let api = js_sys::Object::new();

    let call = Closure::<dyn FnMut(String, Option<String>) -> js_sys::Promise>::new(move |method: String, params: Option<String>| {
        let params = match parse_params(params.as_deref()) {
            Ok(params) => params,
            Err(e) => return js_sys::Promise::reject(&JsValue::from_str(&e)),
        };
        let (request, reply) = ControlRequest::new(method, params);
        if tx.send(request).is_err() {
            return js_sys::Promise::reject(&JsValue::from_str("PhotoCraft has stopped taking requests"));
        }
        let ctx = ctx.clone();
        ctx.request_repaint();
        // Answer as the desktop transport does when its reply deadline passes, rather than poll on.
        let deadline = js_sys::Date::now() + REPLY_DEADLINE.as_millis() as f64;
        wasm_bindgen_futures::future_to_promise(async move {
            // Replies come from the frame loop: keep frames coming until this one arrives (an
            // idle egui page draws nothing), the way the desktop transport wakes its window.
            loop {
                match reply.try_recv() {
                    Ok(value) => return Ok(JsValue::from_str(&value.to_string())),
                    Err(TryRecvError::Disconnected) => return Err(JsValue::from_str("PhotoCraft dropped the request without replying")),
                    Err(TryRecvError::Empty) if js_sys::Date::now() >= deadline => {
                        return Ok(JsValue::from_str(&serde_json::json!({"ok": false, "error": timeout_error()}).to_string()));
                    }
                    Err(TryRecvError::Empty) => {
                        ctx.request_repaint();
                        sleep(16).await;
                    }
                }
            }
        })
    });
    let put_files = files.clone();
    let put = Closure::<dyn FnMut(String, js_sys::Uint8Array)>::new(move |path: String, bytes: js_sys::Uint8Array| {
        put_files.put(&path, bytes.to_vec());
    });
    let take_files = files.clone();
    let take = Closure::<dyn FnMut(String) -> JsValue>::new(move |path: String| match take_files.take(&path) {
        Some(bytes) => js_sys::Uint8Array::from(bytes.as_slice()).into(),
        None => JsValue::UNDEFINED,
    });
    let list = Closure::<dyn FnMut() -> js_sys::Array>::new(move || files.paths().into_iter().map(|p| JsValue::from_str(&p)).collect());

    for (name, f) in [("call", call.as_ref()), ("put", put.as_ref()), ("take", take.as_ref()), ("files", list.as_ref())] {
        js_sys::Reflect::set(&api, &JsValue::from_str(name), f).map_err(js)?;
    }
    js_sys::Reflect::set(&window, &JsValue::from_str("photocraft"), &api).map_err(js)?;
    // The page owns them for its whole life.
    call.forget();
    put.forget();
    take.forget();
    list.forget();
    Ok(rx)
}

#[cfg(target_arch = "wasm32")]
async fn sleep(ms: i32) {
    let promise = js_sys::Promise::new(&mut |resolve, _reject| {
        let scheduled = web_sys::window().is_some_and(|w| w.set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, ms).is_ok());
        if !scheduled {
            let _ = resolve.call0(&wasm_bindgen::JsValue::NULL);
        }
    });
    let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_reads_a_put_file_and_keeps_it() {
        let files = Files::default();
        files.put("in/sky.png", b"png".to_vec());
        let mut services = Services::default();
        files.attach(&mut services);
        let read = services.automation_read.as_mut().expect("read hook");
        assert_eq!(read("in/sky.png"), Ok(("sky.png".to_string(), b"png".to_vec())));
        assert_eq!(read("in/sky.png").map(|(_, b)| b), Ok(b"png".to_vec()), "a second open still finds it");
    }

    #[test]
    fn open_of_a_missing_file_says_how_to_provide_it() {
        let mut services = Services::default();
        Files::default().attach(&mut services);
        let read = services.automation_read.as_mut().expect("read hook");
        let error = read("nowhere.psd").expect_err("not in the store");
        assert!(error.contains("photocraft.put"), "{error}");
    }

    #[test]
    fn save_lands_in_the_store_and_is_taken_once() {
        let files = Files::default();
        let mut services = Services::default();
        files.attach(&mut services);
        let write = services.automation_write.as_mut().expect("write hook");
        write("out/poster.png", b"bytes").expect("saved");
        assert_eq!(files.paths(), vec!["out/poster.png".to_string()]);
        assert_eq!(files.take("out/poster.png"), Some(b"bytes".to_vec()));
        assert_eq!(files.take("out/poster.png"), None);
        assert!(write("out/", b"x").is_err(), "a folder is not a file name");
    }

    #[test]
    fn params_are_json_or_nothing() {
        assert_eq!(parse_params(None), Ok(serde_json::json!({})));
        assert_eq!(parse_params(Some("  ")), Ok(serde_json::json!({})));
        assert_eq!(parse_params(Some(r#"{"command":"file.new"}"#)), Ok(serde_json::json!({"command": "file.new"})));
        assert!(parse_params(Some("{nope")).is_err_and(|e| e.contains("must be JSON")));
    }
}
