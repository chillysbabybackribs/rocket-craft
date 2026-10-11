//! Claude through the Claude Code CLI in print mode, one long-lived process per chat.
//!
//! CLI behaviour this relies on (Claude Code 2.1.293, flags read in `claude --help` and the
//! official CLI reference, code.claude.com/docs/en/cli-reference, on 2026-10-10):
//! - `-p --input-format stream-json --output-format stream-json --verbose` keeps the process open
//!   and takes one JSON user message per stdin line; `--include-partial-messages` adds
//!   `stream_event` lines carrying the API's content-block deltas.
//! - `--mcp-config <json>` with `--strict-mcp-config` loads only PhotoCraft's server.
//!   `--tools ""` removes the built-in tools (shell, files, web); MCP tools are unaffected.
//!   `--allowedTools mcp__photocraft` lets that server's tools run without a permission prompt.
//! - `--resume <session id>` continues a conversation after the process was stopped.
//! - Stream shapes (as Rocket's adapter has seen them with the same CLI): `system`/`init` carries
//!   `session_id` and `model`; text arrives as `stream_event` `content_block_delta` with a
//!   `text_delta`; each finished block is restated in an `assistant` message (tool_use blocks
//!   with their whole `input`); tool results come back in `user` messages as `tool_result`
//!   blocks; `result` (with `is_error`) closes the turn.

use base64::Engine as _;
use serde_json::{Value, json};
use std::collections::HashSet;

use crate::{Event, Message, Tooling, prompt_text, result_line, tool_detail};

/// The command line for one chat's process.
pub fn args(tooling: &Tooling, resume: Option<&str>) -> Vec<String> {
    let mcp = json!({"mcpServers": {"photocraft": {"command": tooling.command, "args": tooling.args}}});
    let mut a: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--strict-mcp-config",
        "--mcp-config",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    a.push(mcp.to_string());
    a.extend(["--tools".into(), String::new(), "--allowedTools".into(), "mcp__photocraft".into()]);
    a.extend(["--append-system-prompt".into(), crate::instructions(tooling)]);
    if let Some(id) = resume {
        a.extend(["--resume".into(), id.to_string()]);
    }
    a
}

/// One stdin line: the user's message, with the canvas as an image block when attached.
pub fn user_line(message: &Message) -> String {
    let mut content = Vec::new();
    if let Some(png) = &message.image_png {
        let data = base64::engine::general_purpose::STANDARD.encode(png);
        content.push(json!({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": data}}));
    }
    content.push(json!({"type": "text", "text": prompt_text(message)}));
    json!({"type": "user", "message": {"role": "user", "content": content}}).to_string()
}

/// Turns the CLI's stdout lines into [`Event`]s.
#[derive(Default)]
pub struct Translator {
    started: HashSet<String>,
}

impl Translator {
    pub fn handle(&mut self, v: &Value) -> Vec<Event> {
        let mut out = Vec::new();
        let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "system" if v.get("subtype").and_then(Value::as_str) == Some("init") => {
                let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                out.push(Event::Session { session_id: s("session_id"), model: s("model") });
            }
            "stream_event" => {
                let e = v.get("event").unwrap_or(&Value::Null);
                if e.get("type").and_then(Value::as_str) == Some("content_block_delta") {
                    let d = e.get("delta").unwrap_or(&Value::Null);
                    let is_text = d.get("type").and_then(Value::as_str).is_none_or(|t| t == "text_delta");
                    if is_text && let Some(t) = d.get("text").and_then(Value::as_str) {
                        out.push(Event::Text(t.to_string()));
                    }
                }
            }
            "assistant" => {
                for block in blocks(v) {
                    if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                        continue;
                    }
                    let id = block.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                    if !self.started.insert(id.clone()) {
                        continue;
                    }
                    let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                    let input = block.get("input").unwrap_or(&Value::Null);
                    out.push(Event::ToolStart { id, name: crate::short_tool_name(name), detail: tool_detail(name, input) });
                }
            }
            "user" => {
                for block in blocks(v) {
                    if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                        continue;
                    }
                    let id = block.get("tool_use_id").and_then(Value::as_str).unwrap_or("").to_string();
                    let ok = !block.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                    out.push(Event::ToolDone { id, ok, detail: result_line(&content_text(block.get("content"))) });
                }
            }
            "result" => {
                let failed = v.get("is_error").and_then(Value::as_bool).unwrap_or(false)
                    || v.get("subtype").and_then(Value::as_str).is_some_and(|s| s != "success");
                let error = failed.then(|| {
                    let why = v.get("result").and_then(Value::as_str).filter(|s| !s.trim().is_empty());
                    let sub = v.get("subtype").and_then(Value::as_str).unwrap_or("error");
                    format!("Claude stopped with an error: {}. Send the message again, or start a new chat.", why.unwrap_or(sub).trim())
                });
                out.push(Event::Done { error });
            }
            _ => {}
        }
        out
    }
}

fn blocks(v: &Value) -> impl Iterator<Item = &Value> {
    v.get("message").and_then(|m| m.get("content")).and_then(Value::as_array).into_iter().flatten()
}

/// A tool result's content: a string, or a list of text blocks.
fn content_text(c: Option<&Value>) -> String {
    match c {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items.iter().filter_map(|i| i.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(lines: &[Value]) -> Vec<Event> {
        let mut t = Translator::default();
        lines.iter().flat_map(|l| t.handle(l)).collect()
    }

    #[test]
    fn a_turn_with_a_tool_call() {
        let tool = json!({"type": "tool_use", "id": "t1", "name": "mcp__photocraft__command_run", "input": {"id": "layer.new.layer"}});
        let events = run(&[
            json!({"type": "system", "subtype": "init", "session_id": "s1", "model": "claude-opus-5-5"}),
            json!({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "On it."}}}),
            json!({"type": "stream_event", "event": {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{"}}}),
            json!({"type": "assistant", "message": {"content": [tool]}}),
            json!({"type": "assistant", "message": {"content": [tool]}}),
            json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": [{"type": "text", "text": "{\"layer\": 4}"}]}]}}),
            json!({"type": "result", "subtype": "success", "is_error": false, "result": "On it."}),
        ]);
        assert_eq!(
            events,
            vec![
                Event::Session { session_id: "s1".into(), model: "claude-opus-5-5".into() },
                Event::Text("On it.".into()),
                Event::ToolStart { id: "t1".into(), name: "command_run".into(), detail: "layer.new.layer".into() },
                Event::ToolDone { id: "t1".into(), ok: true, detail: "{\"layer\": 4}".into() },
                Event::Done { error: None },
            ]
        );
    }

    #[test]
    fn a_failed_tool_and_a_failed_turn() {
        let events = run(&[
            json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t", "is_error": true, "content": "unknown command"}]}}),
            json!({"type": "result", "subtype": "error_during_execution", "is_error": true}),
        ]);
        assert_eq!(events[0], Event::ToolDone { id: "t".into(), ok: false, detail: "unknown command".into() });
        let Event::Done { error: Some(e) } = &events[1] else { unreachable!("expected a failed turn") };
        assert!(e.contains("error_during_execution"));
    }

    #[test]
    fn the_command_line_loads_only_photocraft() {
        let tooling = Tooling { command: "/x/photocraft-cli".into(), args: vec!["mcp".into()], ..Default::default() };
        let a = args(&tooling, Some("s1"));
        let at = |flag: &str| a.iter().position(|x| x == flag).and_then(|i| a.get(i + 1)).cloned();
        assert_eq!(at("--tools").as_deref(), Some(""));
        assert_eq!(at("--allowedTools").as_deref(), Some("mcp__photocraft"));
        assert_eq!(at("--resume").as_deref(), Some("s1"));
        assert!(a.contains(&"--strict-mcp-config".to_string()));
        let mcp: Value = serde_json::from_str(&at("--mcp-config").unwrap_or_default()).unwrap_or_default();
        assert_eq!(mcp["mcpServers"]["photocraft"]["command"], "/x/photocraft-cli");
    }

    #[test]
    fn the_canvas_goes_first_as_an_image() {
        let line = user_line(&Message { text: "hi".into(), image_png: Some(vec![1, 2, 3]), ..Default::default() });
        let v: Value = serde_json::from_str(&line).unwrap_or_default();
        assert_eq!(v["message"]["content"][0]["type"], "image");
        assert_eq!(v["message"]["content"][1]["text"], "hi");
    }
}
