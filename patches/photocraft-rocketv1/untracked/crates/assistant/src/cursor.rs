//! Cursor through `cursor-agent acp`: the Agent Client Protocol, JSON-RPC 2.0 over stdio.
//!
//! Protocol this relies on (as verified live by Rocket's adapter against cursor-agent
//! 2026.10.01 on 2026-10-05; installed here: 2026.10.01-14929f9):
//! - `initialize {protocolVersion: 1, clientCapabilities}`; we offer no file system or terminal, so
//!   the agent works only through the MCP server it is given.
//! - `session/new {cwd, mcpServers}` answers `{sessionId, models?}`; `session/load {sessionId, cwd,
//!   mcpServers}` resumes one that took at least one prompt. A stdio MCP server is
//!   `{name, command, args, env: []}` (ACP spec).
//! - `session/prompt {sessionId, prompt: [content blocks]}` answers `{stopReason}` when the turn
//!   ends; meanwhile `session/update` notifications carry `agent_message_chunk {content: {text}}`
//!   and `tool_call` / `tool_call_update {toolCallId, title, kind, status, rawInput, content}`.
//!   An MCP tool's call names it only in `rawInput` (`providerIdentifier`, `toolName`, `args`).
//! - `session/request_permission` is answered with the broadest allow option offered.

use serde_json::{Value, json};
use std::collections::HashSet;

use crate::{Event, Tooling, result_line, tool_detail};

pub fn args() -> Vec<String> {
    vec!["acp".into()]
}

pub fn initialize_params() -> Value {
    json!({"protocolVersion": 1, "clientCapabilities": {"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false}})
}

pub fn session_params(tooling: &Tooling, resume: Option<&str>) -> Value {
    let server = json!({"name": "photocraft", "command": tooling.command, "args": tooling.args, "env": []});
    let mut p = json!({"cwd": tooling.work_dir, "mcpServers": [server]});
    if let Some(id) = resume {
        p["sessionId"] = json!(id);
    }
    p
}

/// The prompt's content blocks. ACP has no system prompt, so the first message of a session
/// carries the instructions ahead of the user's words.
pub fn prompt(text: &str, image_png: Option<&[u8]>, instructions: Option<&str>) -> Value {
    use base64::Engine as _;
    let text = match instructions {
        Some(i) => format!("<instructions>\n{i}\n</instructions>\n\n{text}"),
        None => text.to_string(),
    };
    let mut blocks = vec![json!({"type": "text", "text": text})];
    if let Some(png) = image_png {
        blocks.push(json!({"type": "image", "mimeType": "image/png", "data": base64::engine::general_purpose::STANDARD.encode(png)}));
    }
    Value::Array(blocks)
}

/// The model a new or loaded session runs, when it says.
pub fn session_model(setup: &Value) -> String {
    let models = setup.get("models").unwrap_or(&Value::Null);
    let current = models.get("currentModelId").and_then(Value::as_str).unwrap_or("");
    let label = models
        .get("availableModels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|m| m.get("modelId").and_then(Value::as_str) == Some(current))
        .and_then(|m| m.get("name").and_then(Value::as_str));
    label.unwrap_or(current).to_string()
}

/// Our answer to a request the agent sends; `None` for requests we don't serve.
pub fn answer(method: &str, params: &Value) -> Option<Value> {
    if method != "session/request_permission" {
        return None;
    }
    let options: Vec<&Value> = params.get("options").and_then(Value::as_array).into_iter().flatten().collect();
    let field = |o: &Value, k: &str| o.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let pick = options
        .iter()
        .find(|o| field(o, "kind") == "allow_always")
        .or_else(|| options.iter().find(|o| field(o, "kind").contains("allow") || field(o, "optionId").contains("allow")))
        .or_else(|| options.first());
    let id = pick.map(|o| field(o, "optionId")).filter(|s| !s.is_empty()).unwrap_or_else(|| "allow".into());
    Some(json!({"outcome": {"outcome": "selected", "optionId": id}}))
}

/// What a finished `session/prompt` means.
pub fn finished(result: &Value) -> Event {
    let error = match result.get("stopReason").and_then(Value::as_str) {
        Some("refusal") => Some("Cursor declined this request. Rephrase it, or choose Claude or Codex.".to_string()),
        _ => None,
    };
    Event::Done { error }
}

#[derive(Default)]
pub struct Translator {
    started: HashSet<String>,
    finished: HashSet<String>,
}

impl Translator {
    pub fn handle(&mut self, update: &Value) -> Vec<Event> {
        let s = |k: &str| update.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("agent_message_chunk") => {
                let t = update.get("content").and_then(|c| c.get("text")).and_then(Value::as_str).unwrap_or("");
                if t.is_empty() { vec![] } else { vec![Event::Text(t.to_string())] }
            }
            Some("tool_call") | Some("tool_call_update") => {
                let id = s("toolCallId");
                let mut out = vec![];
                if !self.started.contains(&id) {
                    let raw = update.get("rawInput").unwrap_or(&Value::Null);
                    let tool = raw.get("toolName").and_then(Value::as_str).map(str::to_string);
                    let (name, detail) = match tool {
                        Some(t) => {
                            let d = tool_detail(&t, raw.get("args").unwrap_or(&Value::Null));
                            (t, d)
                        }
                        None => (if s("kind").is_empty() { "tool".into() } else { s("kind") }, s("title").trim_matches('`').to_string()),
                    };
                    // A bare update for a call we never saw starting is still a call.
                    self.started.insert(id.clone());
                    out.push(Event::ToolStart { id: id.clone(), name: crate::short_tool_name(&name), detail });
                }
                let status = s("status");
                if (status == "completed" || status == "failed") && self.finished.insert(id.clone()) {
                    out.push(Event::ToolDone { id, ok: status == "completed", detail: result_line(&call_output(update)) });
                }
                out
            }
            _ => vec![],
        }
    }
}

fn call_output(update: &Value) -> String {
    let parts: Vec<String> = update
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|b| b.get("content").and_then(|c| c.get("text")).and_then(Value::as_str).map(str::to_string))
        .collect();
    if !parts.is_empty() {
        return parts.join("\n");
    }
    let raw = update.get("rawOutput").unwrap_or(&Value::Null);
    ["content", "output", "error"].iter().find_map(|k| raw.get(*k).and_then(Value::as_str).map(str::to_string)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_turn_with_an_mcp_call() {
        let mut t = Translator::default();
        let raw = json!({"providerIdentifier": "photocraft", "toolName": "command_run", "args": {"id": "edit.fill"}});
        let mut e = vec![];
        e.extend(t.handle(&json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Filling."}})));
        e.extend(t.handle(&json!({"sessionUpdate": "tool_call", "toolCallId": "c1", "kind": "other", "status": "pending", "rawInput": raw})));
        e.extend(t.handle(&json!({"sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "completed",
            "content": [{"type": "content", "content": {"type": "text", "text": "{\"contents\":\"color\"}"}}]})));
        e.extend(t.handle(&json!({"sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "completed"})));
        assert_eq!(
            e,
            vec![
                Event::Text("Filling.".into()),
                Event::ToolStart { id: "c1".into(), name: "command_run".into(), detail: "edit.fill".into() },
                Event::ToolDone { id: "c1".into(), ok: true, detail: "{\"contents\":\"color\"}".into() },
            ]
        );
    }

    #[test]
    fn permission_requests_take_the_broadest_allow() {
        let p = json!({"options": [{"optionId": "reject", "kind": "reject_once"}, {"optionId": "once", "kind": "allow_once"}, {"optionId": "always", "kind": "allow_always"}]});
        assert_eq!(answer("session/request_permission", &p), Some(json!({"outcome": {"outcome": "selected", "optionId": "always"}})));
        assert_eq!(answer("fs/read_text_file", &p), None);
    }

    #[test]
    fn sessions_get_photocraft_as_a_stdio_server() {
        let tooling = Tooling { command: "/x/photocraft-cli".into(), args: vec!["mcp".into()], work_dir: "/w".into(), ..Default::default() };
        let p = session_params(&tooling, Some("s"));
        assert_eq!(p["mcpServers"][0]["name"], "photocraft");
        assert_eq!(p["mcpServers"][0]["env"], json!([]));
        assert_eq!(p["sessionId"], "s");
        assert_eq!(session_model(&json!({"models": {"currentModelId": "m1", "availableModels": [{"modelId": "m1", "name": "GPT-6"}]}})), "GPT-6");
        assert_eq!(finished(&json!({"stopReason": "end_turn"})), Event::Done { error: None });
    }
}
