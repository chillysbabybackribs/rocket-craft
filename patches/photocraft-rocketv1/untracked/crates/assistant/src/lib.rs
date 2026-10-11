//! The Chat panel's model runner.
//!
//! PhotoCraft does not call any model API itself. It lends each message to a CLI the user is
//! already signed in to (Claude Code, Codex, Cursor), so replies run on the user's own
//! subscription. Each CLI gets exactly one MCP server, `photocraft-cli mcp --bridge`, connected
//! to this window's control server: the model edits the open document through the same command
//! registry the menus use, and sees the window through `ui_screenshot`.
//!
//! The UI only sees [`Chat`]: send a message, stop, start over, and drain [`Event`]s once a frame.
//! Each provider is a process wrapper plus a pure stream translator, so the translators are tested
//! without a CLI. This crate has no egui dependency: the panel passes a waker that asks for a repaint.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]

pub mod claude;
pub mod codex;
pub mod cursor;
#[cfg(not(target_arch = "wasm32"))]
mod process;
#[cfg(not(target_arch = "wasm32"))]
mod runner;

#[cfg(not(target_arch = "wasm32"))]
pub use runner::Runner;

use std::path::PathBuf;

/// The CLIs a chat can be lent to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Provider {
    Claude,
    Codex,
    Cursor,
}

impl Provider {
    pub const ALL: [Provider; 3] = [Provider::Claude, Provider::Codex, Provider::Cursor];

    pub fn label(self) -> &'static str {
        match self {
            Provider::Claude => "Claude",
            Provider::Codex => "Codex",
            Provider::Cursor => "Cursor",
        }
    }

    /// The executable looked up on PATH (and in the usual per-user install folders).
    pub fn program(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
            Provider::Cursor => "cursor-agent",
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
            Provider::Cursor => "cursor",
        }
    }

    pub fn from_id(id: &str) -> Option<Provider> {
        Provider::ALL.into_iter().find(|p| p.id() == id)
    }
}

/// Whether a provider's CLI was found, and where.
#[derive(Clone, Debug)]
pub struct ProviderInfo {
    pub provider: Provider,
    pub path: Option<PathBuf>,
}

/// How a CLI starts PhotoCraft's MCP server: `command args…` (the bridge to this window).
#[derive(Clone, Debug, Default)]
pub struct Tooling {
    pub command: PathBuf,
    pub args: Vec<String>,
    /// The folder the model's paths are relative to (the automation read/write root).
    pub files_root: Option<PathBuf>,
    /// Where the CLIs run: an empty folder of the chat's own, so no project instructions load.
    pub work_dir: PathBuf,
}

/// One message from the user.
#[derive(Clone, Debug, Default)]
pub struct Message {
    pub text: String,
    /// A PNG of the canvas, when the user attached it.
    pub image_png: Option<Vec<u8>>,
    /// What the model should simply know about the window right now (document, layers,
    /// selection, tool), sent ahead of the user's words.
    pub context: String,
}

/// What happened, drained by the panel once a frame.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// The CLI reported its session and the model it resolved.
    Session { session_id: String, model: String },
    /// More of the reply's text.
    Text(String),
    /// The model called a tool. `id` pairs it with its [`Event::ToolDone`].
    ToolStart { id: String, name: String, detail: String },
    ToolDone { id: String, ok: bool, detail: String },
    /// The reply ended. `error` is a full sentence when it ended badly.
    Done { error: Option<String> },
}

/// The chat, as the panel drives it.
pub trait Chat {
    fn providers(&self) -> Vec<ProviderInfo>;
    /// Send a message to `provider`. Starts the CLI (or resumes its session) when needed.
    fn send(&mut self, provider: Provider, message: Message) -> Result<(), String>;
    /// Stop the reply in flight. The session is kept for the next message.
    fn stop(&mut self);
    /// Forget the sessions: the next message starts a new conversation.
    fn reset(&mut self);
    fn busy(&self) -> bool;
    fn poll(&mut self) -> Vec<Event>;
}

/// Instructions every provider gets ahead of the conversation.
pub fn instructions(tooling: &Tooling) -> String {
    let root = tooling.files_root.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "no folder".into());
    format!(
        "You are the assistant inside PhotoCraft, an open-source image editor modelled on Adobe Photoshop. \
The user is looking at the PhotoCraft window and talks to you in its Chat panel.\n\
\n\
Work only through the `photocraft` MCP tools: they drive this window live, and the user watches each change.\n\
- `command_list` lists every engine command id with its parameters (filter it, it is long); `command_run` runs one; \
`command_batch` runs several in one step.\n\
- `doc_inspect` describes the document and its layer tree. `ui_screenshot` shows you the window: look after visual work \
and fix what is off before you answer.\n\
- `doc_open` and `doc_save` take paths relative to {root}; absolute paths are refused.\n\
- Prefer editable results (shape, type, fill and adjustment layers, layer styles) over flattening pixels, and name new layers.\n\
\n\
Each message starts with a <photocraft-context> block: the window's state when the user sent it. \
Keep replies short: say what you changed, in plain words."
    )
}

/// The context block and the user's words, as one prompt text.
pub fn prompt_text(message: &Message) -> String {
    if message.context.trim().is_empty() {
        message.text.clone()
    } else {
        format!("<photocraft-context>\n{}\n</photocraft-context>\n\n{}", message.context.trim(), message.text)
    }
}

/// A tool's name without the MCP server prefix each CLI adds (`mcp__photocraft__command_run`,
/// `photocraft.command_run`, `photocraft-command_run`).
pub fn short_tool_name(name: &str) -> String {
    for prefix in ["mcp__photocraft__", "photocraft.", "photocraft__", "photocraft-", "photocraft/"] {
        if let Some(rest) = name.strip_prefix(prefix) {
            return rest.to_string();
        }
    }
    name.to_string()
}

/// One line that says what a tool call does: the command id for `command_run`, the step count
/// for `command_batch`, the path for file tools.
pub fn tool_detail(name: &str, input: &serde_json::Value) -> String {
    let short = short_tool_name(name);
    let s = |k: &str| input.get(k).and_then(serde_json::Value::as_str).map(str::to_string);
    match short.as_str() {
        "command_run" => s("id").or_else(|| s("command")).unwrap_or_default(),
        "command_batch" => match input.get("steps").and_then(serde_json::Value::as_array) {
            Some(steps) => {
                let ids: Vec<String> = steps
                    .iter()
                    .filter_map(|st| {
                        st.get("id").or_else(|| st.get("command")).and_then(serde_json::Value::as_str).map(str::to_string).or_else(|| {
                            st.as_array().and_then(|a| a.first()).and_then(serde_json::Value::as_str).map(str::to_string)
                        })
                    })
                    .take(3)
                    .collect();
                let more = if steps.len() > ids.len() { format!(" +{}", steps.len() - ids.len()) } else { String::new() };
                format!("{} steps: {}{more}", steps.len(), ids.join(", "))
            }
            None => String::new(),
        },
        "doc_open" | "doc_save" | "doc_export" => s("path").unwrap_or_default(),
        "command_list" => s("filter").map(|f| format!("filter: {f}")).unwrap_or_default(),
        "ui_menu_invoke" => s("id").unwrap_or_default(),
        "control_call" => s("method").unwrap_or_default(),
        _ => String::new(),
    }
}

/// The first line of a tool result, shortened for the step row.
pub fn result_line(text: &str) -> String {
    let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    let mut out: String = line.chars().take(120).collect();
    if line.chars().count() > 120 {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tool_names_lose_their_server_prefix() {
        assert_eq!(short_tool_name("mcp__photocraft__command_run"), "command_run");
        assert_eq!(short_tool_name("photocraft.doc_inspect"), "doc_inspect");
        assert_eq!(short_tool_name("Bash"), "Bash");
    }

    #[test]
    fn tool_details_name_the_command() {
        assert_eq!(tool_detail("mcp__photocraft__command_run", &json!({"id": "shape.create", "params": {}})), "shape.create");
        let batch = json!({"steps": [{"id": "a"}, ["b", {}], {"command": "c"}, {"id": "d"}]});
        assert_eq!(tool_detail("command_batch", &batch), "4 steps: a, b, c +1");
        assert_eq!(tool_detail("doc_save", &json!({"path": "out.psd"})), "out.psd");
        assert_eq!(tool_detail("ui_screenshot", &json!({})), "");
    }

    #[test]
    fn the_context_goes_ahead_of_the_words() {
        let m = Message { text: "make it blue".into(), context: "doc: a.psd".into(), ..Default::default() };
        assert_eq!(prompt_text(&m), "<photocraft-context>\ndoc: a.psd\n</photocraft-context>\n\nmake it blue");
        let bare = Message { text: "hi".into(), ..Default::default() };
        assert_eq!(prompt_text(&bare), "hi");
    }

    #[test]
    fn result_lines_are_short() {
        assert_eq!(result_line("\n  {\"layer\": 3}\nmore"), "{\"layer\": 3}");
        assert_eq!(result_line(&"x".repeat(200)).chars().count(), 121);
    }
}
