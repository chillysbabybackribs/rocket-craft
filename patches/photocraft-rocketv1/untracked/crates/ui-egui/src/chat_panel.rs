//! Window › Chat: a column beside the dock where the user asks a model, through a CLI they are
//! already signed in to, to edit the open document. The model works through PhotoCraft's own
//! commands (the MCP bridge to this window), so every change it makes is a normal, undoable step.
//!
//! The panel owns only the transcript and the composer. The model runner comes from the desktop
//! app through [`ChatServices`] (`photocraft_assistant::Runner`); the web build has none and says so.
//! Strings here are English only (not `tl!`): this panel is not part of the translated catalog yet.

use egui::{Color32, RichText};
use photocraft_assistant::{Chat, Event, Message, Provider, ProviderInfo};
use serde_json::{Value, json};

use crate::PhotocraftApp;
use crate::theme::Tokens;
use crate::widgets;

/// Builds the runner on first use; the context lets its threads ask for a repaint.
pub type ChatFactory = Box<dyn Fn(egui::Context) -> Box<dyn Chat>>;
/// The flattened document as a PNG no larger than `max_side` on its long edge.
pub type RenderPngFn = Box<dyn Fn(&photocraft_doc::Document, u32) -> Result<Vec<u8>, String>>;

pub struct ChatServices {
    pub make: ChatFactory,
    pub render_png: RenderPngFn,
}

/// The long edge of the canvas picture sent with a message.
const CANVAS_SIDE: u32 = 1024;

struct Step {
    id: String,
    name: String,
    detail: String,
    done: Option<bool>,
    result: String,
}

enum Entry {
    User { text: String, attached: Option<String> },
    Reply(Reply),
}

struct Reply {
    provider: Provider,
    /// Text and steps in the order they came.
    parts: Vec<Part>,
    done: bool,
    stopped: bool,
    error: Option<String>,
    /// The document's index and history length when the reply started, for "Undo this reply".
    undo_from: Option<(usize, usize)>,
    undone: bool,
}

enum Part {
    Text(String),
    Step(Step),
}

pub struct ChatUi {
    provider: Provider,
    input: String,
    attach_canvas: bool,
    entries: Vec<Entry>,
    models: std::collections::HashMap<Provider, String>,
    chat: Option<Box<dyn Chat>>,
    providers: Option<Vec<ProviderInfo>>,
    notice: Option<String>,
    stick_to_bottom: bool,
}

impl Default for ChatUi {
    fn default() -> Self {
        ChatUi {
            provider: Provider::Claude,
            input: String::new(),
            attach_canvas: true,
            entries: Vec::new(),
            models: Default::default(),
            chat: None,
            providers: None,
            notice: None,
            stick_to_bottom: true,
        }
    }
}

impl ChatUi {
    fn reply_mut(&mut self) -> Option<&mut Reply> {
        match self.entries.last_mut() {
            Some(Entry::Reply(r)) if !r.done => Some(r),
            _ => None,
        }
    }
}

/// Draw the column (call before the central canvas). Drains the runner's events first.
pub fn show(app: &mut PhotocraftApp, ui: &mut egui::Ui) {
    drain(app);
    let t = Tokens::get(ui.ctx());
    egui::Panel::right("chat")
        .resizable(true)
        .default_size(360.0)
        .size_range(280.0..=720.0)
        .frame(egui::Frame::NONE.fill(t.dock).inner_margin(egui::Margin::same(8)))
        .show(ui, |ui| body(app, ui, &t));
}

fn drain(app: &mut PhotocraftApp) {
    let Some(chat) = app.chat.chat.as_mut() else { return };
    let events = chat.poll();
    if events.is_empty() {
        return;
    }
    let provider = app.chat.provider;
    for e in events {
        match e {
            Event::Session { model, .. } => {
                if !model.is_empty() {
                    app.chat.models.insert(provider, model);
                }
            }
            Event::Text(s) => {
                if let Some(r) = app.chat.reply_mut() {
                    match r.parts.last_mut() {
                        Some(Part::Text(t)) => t.push_str(&s),
                        _ => r.parts.push(Part::Text(s)),
                    }
                }
            }
            Event::ToolStart { id, name, detail } => {
                if let Some(r) = app.chat.reply_mut() {
                    r.parts.push(Part::Step(Step { id, name, detail, done: None, result: String::new() }));
                }
            }
            Event::ToolDone { id, ok, detail } => {
                if let Some(r) = app.chat.reply_mut() {
                    for p in r.parts.iter_mut().rev() {
                        if let Part::Step(s) = p
                            && s.id == id
                        {
                            s.done = Some(ok);
                            s.result = detail;
                            break;
                        }
                    }
                }
            }
            Event::Done { error } => {
                if let Some(r) = app.chat.reply_mut() {
                    r.done = true;
                    r.error = error;
                }
            }
        }
    }
    app.chat.stick_to_bottom = true;
}

fn body(app: &mut PhotocraftApp, ui: &mut egui::Ui, t: &Tokens) {
    let busy = app.chat.chat.as_ref().is_some_and(|c| c.busy());
    header(app, ui, t, busy);
    ui.add_space(4.0);
    widgets::hairline(ui);
    let composer_h = 132.0;
    let log_h = (ui.available_height() - composer_h).max(80.0);
    let mut undo: Option<usize> = None;
    egui::ScrollArea::vertical().id_salt("chat-log").max_height(log_h).auto_shrink([false, false]).stick_to_bottom(app.chat.stick_to_bottom).show(ui, |ui| {
        ui.set_width(ui.available_width());
        if app.chat.entries.is_empty() {
            ui.add_space(12.0);
            ui.label(RichText::new("Ask for an edit, and the model makes it here while you watch.").color(t.text_dim));
            ui.add_space(6.0);
            for example in ["Add a soft vignette as its own layer", "Make the title text gold with a thin dark stroke", "Crop to 4:5 for Instagram, keeping the subject centred"] {
                ui.label(RichText::new(format!("•  {example}")).color(t.text_faint));
            }
        }
        for (i, entry) in app.chat.entries.iter().enumerate() {
            ui.add_space(8.0);
            match entry {
                Entry::User { text, attached } => user_bubble(ui, t, text, attached.as_deref()),
                Entry::Reply(r) => {
                    if reply(ui, t, r, &app.chat.models) {
                        undo = Some(i);
                    }
                }
            }
        }
        ui.add_space(6.0);
    });
    if let Some(i) = undo {
        undo_reply(app, i);
    }
    widgets::hairline(ui);
    composer(app, ui, t, busy);
}

fn header(app: &mut PhotocraftApp, ui: &mut egui::Ui, t: &Tokens, busy: bool) {
    let infos = app.chat.providers.get_or_insert_with(|| Provider::ALL.into_iter().map(|p| ProviderInfo { provider: p, path: photocraft_assistant_find(p) }).collect()).clone();
    ui.horizontal(|ui| {
        ui.label(RichText::new("Chat").strong().color(t.text));
        ui.add_space(6.0);
        let labels: Vec<(Provider, String)> = infos
            .iter()
            .map(|i| {
                let suffix = if i.path.is_none() { " (not installed)" } else { "" };
                (i.provider, format!("{}{suffix}", i.provider.label()))
            })
            .collect();
        let options: Vec<(Provider, &str)> = labels.iter().map(|(p, l)| (*p, l.as_str())).collect();
        ui.add_enabled_ui(!busy, |ui| {
            let mut p = app.chat.provider;
            if widgets::dropdown(ui, "chat-provider", &mut p, &options, 150.0) {
                app.chat.provider = p;
            }
        });
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if ui.add_enabled(!busy, egui::Button::new("New chat")).on_hover_text("Forget this conversation and start a new one").clicked() {
                if let Some(c) = app.chat.chat.as_mut() {
                    c.reset();
                }
                app.chat.entries.clear();
                app.chat.models.clear();
                app.chat.notice = None;
            }
        });
    });
    let model = app.chat.models.get(&app.chat.provider).cloned();
    let note = match model {
        Some(m) => format!("{} · {m} · your own subscription", app.chat.provider.label()),
        None => format!("{} · its default model · your own subscription", app.chat.provider.label()),
    };
    ui.label(RichText::new(note).small().color(t.text_faint));
}

/// Where the provider's CLI is, looked up once when the panel first draws.
fn photocraft_assistant_find(p: Provider) -> Option<std::path::PathBuf> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        which(p.program())
    }
    #[cfg(target_arch = "wasm32")]
    {
        let _ = p;
        None
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn which(program: &str) -> Option<std::path::PathBuf> {
    // Same search as the runner; duplicated so the panel can label providers before one starts.
    let mut dirs: Vec<std::path::PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) {
        for d in [".local/bin", ".cargo/bin", ".npm-global/bin", ".bun/bin", ".volta/bin", "bin"] {
            dirs.push(home.join(d));
        }
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            dirs.extend(entries.flatten().map(|e| e.path().join("bin")));
        }
    }
    dirs.extend(["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"].iter().map(std::path::PathBuf::from));
    dirs.into_iter().map(|d| d.join(program)).find(|p| p.is_file())
}

fn user_bubble(ui: &mut egui::Ui, t: &Tokens, text: &str, attached: Option<&str>) {
    ui.with_layout(egui::Layout::top_down(egui::Align::Max), |ui| {
        egui::Frame::NONE.fill(t.accent_soft).corner_radius(8).inner_margin(egui::Margin::symmetric(10, 7)).show(ui, |ui| {
            ui.set_max_width(ui.available_width() * 0.85);
            if let Some(a) = attached {
                ui.label(RichText::new(format!("▣ {a}")).small().color(t.text_dim));
            }
            ui.label(RichText::new(text).color(t.text));
        });
    });
}

/// Draws one reply; true when its "Undo this reply" was clicked.
fn reply(ui: &mut egui::Ui, t: &Tokens, r: &Reply, models: &std::collections::HashMap<Provider, String>) -> bool {
    let who = models.get(&r.provider).map(|m| format!("{} · {m}", r.provider.label())).unwrap_or_else(|| r.provider.label().to_string());
    ui.label(RichText::new(who).small().color(t.text_faint));
    let mut steps_in_row: Vec<&Step> = Vec::new();
    let flush = |ui: &mut egui::Ui, steps: &mut Vec<&Step>| {
        if steps.is_empty() {
            return;
        }
        egui::Frame::NONE.fill(t.field).stroke(egui::Stroke::new(1.0, t.separator)).corner_radius(6).inner_margin(egui::Margin::symmetric(8, 5)).show(ui, |ui| {
            ui.set_width(ui.available_width());
            for s in steps.iter() {
                step_row(ui, t, s);
            }
        });
        steps.clear();
    };
    for part in &r.parts {
        match part {
            Part::Text(s) => {
                flush(ui, &mut steps_in_row);
                ui.label(RichText::new(s.trim()).color(t.text));
            }
            Part::Step(s) => steps_in_row.push(s),
        }
    }
    flush(ui, &mut steps_in_row);
    if !r.done {
        ui.horizontal(|ui| {
            ui.spinner();
            ui.label(RichText::new("Working…").color(t.text_dim));
        });
        return false;
    }
    if r.stopped {
        ui.label(RichText::new("Stopped.").italics().color(t.text_dim));
    }
    if let Some(e) = &r.error {
        ui.label(RichText::new(e).color(t.danger));
    }
    let mut clicked = false;
    if r.undo_from.is_some() && r.parts.iter().any(|p| matches!(p, Part::Step(s) if s.done == Some(true))) {
        ui.add_space(2.0);
        if r.undone {
            ui.label(RichText::new("Undone.").small().color(t.text_faint));
        } else if ui.small_button("Undo this reply").on_hover_text("Step the History back to before this reply").clicked() {
            clicked = true;
        }
    }
    clicked
}

fn step_row(ui: &mut egui::Ui, t: &Tokens, s: &Step) {
    let (mark, color) = match s.done {
        None => ("●", t.accent),
        Some(true) => ("✓", Color32::from_rgb(76, 175, 122)),
        Some(false) => ("✕", t.danger),
    };
    let r = ui
        .horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 6.0;
            ui.label(RichText::new(mark).color(color));
            let what = if s.detail.is_empty() { s.name.clone() } else { format!("{} · {}", s.name, s.detail) };
            ui.add(egui::Label::new(RichText::new(what).font(crate::theme::mono(11.0)).color(t.text)).truncate());
        })
        .response;
    if !s.result.is_empty() {
        r.on_hover_text(&s.result);
    }
}

fn composer(app: &mut PhotocraftApp, ui: &mut egui::Ui, t: &Tokens, busy: bool) {
    ui.add_space(6.0);
    let input_id = egui::Id::new("chat-input");
    // Enter sends, Shift+Enter is a new line: take the key before the text box sees it.
    let focused = ui.memory(|m| m.has_focus(input_id));
    let send_key = focused && !busy && ui.input_mut(|i| i.consume_key(egui::Modifiers::NONE, egui::Key::Enter));
    let edit = egui::TextEdit::multiline(&mut app.chat.input)
        .id(input_id)
        .hint_text("Ask for an edit, or describe what you want…")
        .desired_rows(3)
        .desired_width(f32::INFINITY);
    ui.add(edit);
    if let Some(n) = &app.chat.notice {
        ui.label(RichText::new(n).small().color(t.danger));
    }
    ui.horizontal(|ui| {
        widgets::checkbox(ui, &mut app.chat.attach_canvas, "Attach canvas");
        if let Some(doc) = app.session.active() {
            ui.label(RichText::new(format!("· {}", doc_name(doc))).small().color(t.text_faint));
        }
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if busy {
                if widgets::secondary_button(ui, "Stop", 64.0).clicked() {
                    stop(app);
                }
            } else {
                let ready = !app.chat.input.trim().is_empty();
                let clicked = ui.add_enabled_ui(ready, |ui| widgets::primary_button(ui, "Send", 64.0)).inner.clicked();
                if (clicked || send_key) && ready {
                    send(app, ui.ctx());
                    ui.memory_mut(|m| m.request_focus(input_id));
                }
            }
        });
    });
}

fn doc_name(doc: &photocraft_engine::DocState) -> String {
    doc.doc.name.clone()
}

fn stop(app: &mut PhotocraftApp) {
    if let Some(c) = app.chat.chat.as_mut() {
        c.stop();
    }
    drain(app);
    if let Some(Entry::Reply(r)) = app.chat.entries.last_mut() {
        r.done = true;
        r.stopped = true;
    }
}

fn send(app: &mut PhotocraftApp, ctx: &egui::Context) {
    let text = app.chat.input.trim().to_string();
    if text.is_empty() {
        return;
    }
    if app.chat.chat.is_none() {
        let Some(services) = app.services.chat.as_ref() else {
            app.chat.notice = Some("Chat needs the desktop app: this build has no model runner.".into());
            return;
        };
        app.chat.chat = Some((services.make)(ctx.clone()));
    }
    let context = window_context(app);
    let mut attached = None;
    let mut image_png = None;
    if app.chat.attach_canvas
        && let (Some(doc), Some(services)) = (app.session.active(), app.services.chat.as_ref())
    {
        match (services.render_png)(&doc.doc, CANVAS_SIDE) {
            Ok(png) => {
                attached = Some(format!("{} · canvas attached", doc_name(doc)));
                image_png = Some(png);
            }
            Err(e) => app.chat.notice = Some(format!("The canvas couldn't be attached ({e}); the message was sent without it.")),
        }
    }
    let undo_from = app.session.active_index().zip(app.session.active().map(|d| d.history.past_len()));
    let provider = app.chat.provider;
    let message = Message { text: text.clone(), image_png, context };
    let Some(chat) = app.chat.chat.as_mut() else { return };
    match chat.send(provider, message) {
        Ok(()) => {
            app.chat.notice = None;
            app.chat.input.clear();
            app.chat.entries.push(Entry::User { text, attached });
            app.chat.entries.push(Entry::Reply(Reply { provider, parts: Vec::new(), done: false, stopped: false, error: None, undo_from, undone: false }));
            app.chat.stick_to_bottom = true;
        }
        Err(e) => app.chat.notice = Some(e),
    }
}

/// Undo every History step since the reply at `i` started, if that document is still the active one.
fn undo_reply(app: &mut PhotocraftApp, i: usize) {
    let Some(Entry::Reply(r)) = app.chat.entries.get(i) else { return };
    let Some((doc, from)) = r.undo_from else { return };
    if app.session.active_index() != Some(doc) {
        app.chat.notice = Some("Switch back to the document this reply edited, then undo it.".into());
        return;
    }
    let now = app.session.active().map(|d| d.history.past_len()).unwrap_or(from);
    for _ in from..now {
        if app.run("edit.undo", json!({})).is_err() {
            break;
        }
    }
    if let Some(Entry::Reply(r)) = app.chat.entries.get_mut(i) {
        r.undone = true;
    }
}

/// What the model should simply know about the window, ahead of the user's words.
fn window_context(app: &mut PhotocraftApp) -> String {
    let n = app.session.documents().len();
    let tool = format!("{:?}", app.ui.tool);
    if app.session.active().is_none() {
        return format!("No document is open ({n} open). Active tool: {tool}.");
    }
    let inspect = app.run("document.inspect", json!({})).unwrap_or(Value::Null);
    let s = |k: &str| inspect.get(k).map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())).unwrap_or_default();
    let mut out = format!(
        "Active document: {} ({} × {} px, {} {}-bit), {n} open. Active tool: {tool}.\nSelected layers: {}. Selection: {}.\nLayers, top first:\n",
        s("name"),
        s("width"),
        s("height"),
        s("mode"),
        s("depth"),
        s("selectedLayers"),
        if inspect.get("hasSelection").and_then(Value::as_bool) == Some(true) { format!("bounds {}", s("selectionBounds")) } else { "none".into() },
    );
    let layers = inspect.get("layers").or_else(|| inspect.get("tree")).and_then(Value::as_array).cloned().unwrap_or_default();
    let mut lines = Vec::new();
    layer_lines(&layers, 0, &mut lines);
    let total = lines.len();
    for l in lines.iter().take(60) {
        out.push_str(l);
        out.push('\n');
    }
    if total > 60 {
        out.push_str(&format!("…and {} more (use doc_inspect).\n", total - 60));
    }
    out
}

fn layer_lines(layers: &[Value], depth: usize, out: &mut Vec<String>) {
    if depth > 12 {
        return;
    }
    for l in layers {
        let g = |k: &str| l.get(k).map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())).unwrap_or_default();
        let hidden = if l.get("visible").and_then(Value::as_bool) == Some(false) { ", hidden" } else { "" };
        out.push(format!("{}- {} [id {}, {}{hidden}]", "  ".repeat(depth), g("name"), g("id"), g("kind")));
        if let Some(children) = l.get("children").and_then(Value::as_array) {
            layer_lines(children, depth + 1, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layer_lines_indent_groups() {
        let layers = json!([{"name": "Group", "id": 3, "kind": "Group", "children": [{"name": "Sun", "id": 4, "kind": "Shape", "visible": false}]}]);
        let mut out = Vec::new();
        layer_lines(layers.as_array().map(Vec::as_slice).unwrap_or_default(), 0, &mut out);
        assert_eq!(out, vec!["- Group [id 3, Group]".to_string(), "  - Sun [id 4, Shape, hidden]".to_string()]);
    }

    #[test]
    fn events_fill_the_open_reply() {
        let mut app = PhotocraftApp::new(photocraft_engine::Session::new(), Default::default());
        app.chat.entries.push(Entry::Reply(Reply {
            provider: Provider::Claude,
            parts: vec![],
            done: false,
            stopped: false,
            error: None,
            undo_from: None,
            undone: false,
        }));
        app.chat.chat = Some(Box::new(Fake(vec![
            Event::Text("Hel".into()),
            Event::Text("lo".into()),
            Event::ToolStart { id: "a".into(), name: "command_run".into(), detail: "x".into() },
            Event::ToolDone { id: "a".into(), ok: true, detail: "ok".into() },
            Event::Done { error: None },
        ])));
        drain(&mut app);
        let Some(Entry::Reply(r)) = app.chat.entries.last() else { unreachable!() };
        assert!(r.done);
        assert!(matches!(&r.parts[0], Part::Text(s) if s == "Hello"));
        assert!(matches!(&r.parts[1], Part::Step(s) if s.done == Some(true)));
    }

    struct Fake(Vec<Event>);
    impl Chat for Fake {
        fn providers(&self) -> Vec<ProviderInfo> {
            vec![]
        }
        fn send(&mut self, _: Provider, _: Message) -> Result<(), String> {
            Ok(())
        }
        fn stop(&mut self) {}
        fn reset(&mut self) {}
        fn busy(&self) -> bool {
            false
        }
        fn poll(&mut self) -> Vec<Event> {
            std::mem::take(&mut self.0)
        }
    }
}
