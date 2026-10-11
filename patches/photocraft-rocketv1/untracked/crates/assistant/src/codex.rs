//! Codex through `codex app-server`: newline-delimited JSON-RPC over stdio, one process per chat.
//!
//! Protocol this relies on (as verified live by Rocket's adapter against codex-cli 0.160.0 on
//! 2026-10-05; installed here: codex-cli 0.161.0):
//! - `initialize {clientInfo, capabilities}` then the `initialized` notification.
//! - `thread/start` / `thread/resume {threadId}` take `cwd`, `approvalPolicy`, `sandbox` and a
//!   `config` object of config.toml overrides, here `mcp_servers.photocraft {command, args}`, and
//!   answer `{thread: {id}, model}`.
//! - `turn/start {threadId, input: [{type: text}, {type: localImage, path}]}`; the turn's life
//!   arrives as notifications: `item/agentMessage/delta {delta}`, `item/started` /
//!   `item/completed {item}` (an `mcpToolCall` item has `server`, `tool`, `arguments`, `status`,
//!   `result`, `error`), `error {error: {message}, willRetry}` and `turn/completed {turn: {status,
//!   error}}`.
//! - (codex-cli 0.161.0 `app-server generate-json-schema`, read 2026-10-10) `ThreadStartParams` has
//!   `developerInstructions`, `config` (free-form overrides) and `sandbox` (`read-only` |
//!   `workspace-write` | `danger-full-access`).
//! - Approvals should not arrive under `approvalPolicy: never`; one that does is accepted.
//!
//! (codex-cli 0.161.0, seen 2026-10-10) `thread/start` reports each MCP server through
//! `mcpServer/startupStatus/updated {name, status}`; `codex mcp list --json` lists the user's own servers.
//!
//! The sandbox is `read-only`: Codex may look around, but edits go through PhotoCraft's tools.

use serde_json::{Value, json};

use crate::{Event, Tooling, result_line, tool_detail};

/// The app-server, with the bundled plugins that would drive the desktop or a browser turned off
/// for this process only (the user's config is not edited), as Rocket does.
pub fn args() -> Vec<String> {
    let mut a: Vec<String> = ["app-server", "--listen", "stdio://"].iter().map(|s| s.to_string()).collect();
    a.extend(plugin_overrides());
    a
}

pub fn plugin_overrides() -> Vec<String> {
    ["unified-computer-use", "browser", "chrome"].iter().flat_map(|p| ["-c".to_string(), format!("plugins.{p}@openai-bundled.enabled=false")]).collect()
}

/// Names from `codex mcp list --json` (run with [`plugin_overrides`]): the user's own MCP servers,
/// switched off for chat threads. (Seen 2026-10-10: an `enabled = false` override for a server a
/// plugin provides, rather than config.toml, fails thread/start with "invalid transport", so the
/// list must be taken with the plugins already off.)
pub fn server_names(list_json: &str) -> Vec<String> {
    let v: Value = serde_json::from_str(list_json).unwrap_or(Value::Null);
    v.as_array().into_iter().flatten().filter_map(|s| s.get("name").and_then(Value::as_str)).filter(|n| *n != "photocraft").map(str::to_string).collect()
}

pub fn initialize_params() -> Value {
    json!({"clientInfo": {"name": "photocraft", "title": "PhotoCraft", "version": env!("CARGO_PKG_VERSION")}, "capabilities": {"experimentalApi": true}})
}

/// `thread/start` (or `thread/resume` with the thread id added) parameters.
pub fn thread_params(tooling: &Tooling, others: &[String]) -> Value {
    let mut servers = json!({"photocraft": {"command": tooling.command, "args": tooling.args, "tool_timeout_sec": 120}});
    for name in others {
        servers[name] = json!({"enabled": false});
    }
    json!({
        "cwd": tooling.work_dir,
        "approvalPolicy": "never",
        "sandbox": "read-only",
        "developerInstructions": crate::instructions(tooling),
        "config": {"mcp_servers": servers},
    })
}

pub fn turn_input(text: &str, image_path: Option<&std::path::Path>) -> Value {
    let mut input = vec![json!({"type": "text", "text": text})];
    if let Some(p) = image_path {
        input.push(json!({"type": "localImage", "path": p}));
    }
    Value::Array(input)
}

/// The answer to a request Codex sends us (approvals); `None` for requests we don't serve.
pub fn answer(method: &str) -> Option<Value> {
    method.ends_with("requestApproval").then(|| json!({"decision": "accept"}))
}

#[derive(Default)]
pub struct Translator {
    last_error: Option<String>,
}

impl Translator {
    pub fn handle(&mut self, method: &str, p: &Value) -> Vec<Event> {
        let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        match method {
            "item/agentMessage/delta" => {
                let d = s(p, "delta");
                if d.is_empty() { vec![] } else { vec![Event::Text(d)] }
            }
            "item/started" | "item/completed" => {
                let item = p.get("item").unwrap_or(&Value::Null);
                let id = s(item, "id");
                let done = method == "item/completed";
                let (name, detail) = match item.get("type").and_then(Value::as_str) {
                    Some("mcpToolCall") => {
                        let tool = s(item, "tool");
                        let detail = tool_detail(&tool, item.get("arguments").unwrap_or(&Value::Null));
                        (tool, detail)
                    }
                    Some("commandExecution") => ("shell".to_string(), s(item, "command")),
                    _ => return vec![],
                };
                if !done {
                    return vec![Event::ToolStart { id, name, detail }];
                }
                let status = s(item, "status");
                let ok = status != "failed" && status != "declined" && item.get("error").is_none_or(Value::is_null);
                let out = match (item.get("error"), item.get("result")) {
                    (Some(e), _) if !e.is_null() => e.get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| e.to_string()),
                    (_, Some(r)) => result_text(r),
                    _ => s(item, "aggregatedOutput"),
                };
                vec![Event::ToolDone { id, ok, detail: result_line(&out) }]
            }
            "error" => {
                if p.get("willRetry").and_then(Value::as_bool) != Some(true) {
                    let m = p.get("error").and_then(|e| e.get("message")).and_then(Value::as_str).unwrap_or("");
                    if !m.is_empty() {
                        self.last_error = Some(m.to_string());
                    }
                }
                vec![]
            }
            "turn/completed" => {
                let turn = p.get("turn").unwrap_or(&Value::Null);
                let error = match turn.get("status").and_then(Value::as_str) {
                    Some("failed") => {
                        let why = turn.get("error").and_then(|e| e.get("message")).and_then(Value::as_str).map(str::to_string);
                        let why = why.or_else(|| self.last_error.take()).unwrap_or_else(|| "the turn failed".into());
                        Some(format!("Codex stopped with an error: {why}. Send the message again, or start a new chat."))
                    }
                    _ => None,
                };
                vec![Event::Done { error }]
            }
            _ => vec![],
        }
    }
}

/// An MCP call result: its text blocks, or the JSON.
fn result_text(r: &Value) -> String {
    let texts: Vec<&str> = r.get("content").and_then(Value::as_array).into_iter().flatten().filter_map(|c| c.get("text").and_then(Value::as_str)).collect();
    if texts.is_empty() { r.to_string() } else { texts.join("\n") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_turn_with_a_tool_call() {
        let mut t = Translator::default();
        let call = json!({"type": "mcpToolCall", "id": "i1", "server": "photocraft", "tool": "command_run", "arguments": {"id": "select.all"}});
        let mut done = call.clone();
        done["status"] = json!("completed");
        done["result"] = json!({"content": [{"type": "text", "text": "{\"ok\":true}"}]});
        let mut events = vec![];
        events.extend(t.handle("item/agentMessage/delta", &json!({"delta": "Sure."})));
        events.extend(t.handle("item/started", &json!({"item": call})));
        events.extend(t.handle("item/completed", &json!({"item": done})));
        events.extend(t.handle("item/started", &json!({"item": {"type": "reasoning", "id": "r"}})));
        events.extend(t.handle("turn/completed", &json!({"turn": {"status": "completed"}})));
        assert_eq!(
            events,
            vec![
                Event::Text("Sure.".into()),
                Event::ToolStart { id: "i1".into(), name: "command_run".into(), detail: "select.all".into() },
                Event::ToolDone { id: "i1".into(), ok: true, detail: "{\"ok\":true}".into() },
                Event::Done { error: None },
            ]
        );
    }

    #[test]
    fn a_failed_turn_names_the_last_error() {
        let mut t = Translator::default();
        assert!(t.handle("error", &json!({"error": {"message": "usage limit reached"}, "willRetry": false})).is_empty());
        let events = t.handle("turn/completed", &json!({"turn": {"status": "failed"}}));
        let [Event::Done { error: Some(e) }] = events.as_slice() else { unreachable!("expected a failed turn") };
        assert!(e.contains("usage limit reached"));
    }

    #[test]
    fn the_thread_gets_only_photocraft_and_a_read_only_sandbox() {
        let tooling = Tooling { command: "/x/photocraft-cli".into(), args: vec!["mcp".into()], ..Default::default() };
        let others = server_names(r#"[{"name": "node_repl"}, {"name": "photocraft"}]"#);
        assert_eq!(others, vec!["node_repl".to_string()]);
        let p = thread_params(&tooling, &others);
        assert_eq!(p["config"]["mcp_servers"]["node_repl"], json!({"enabled": false}));
        assert_eq!(p["sandbox"], "read-only");
        assert_eq!(p["config"]["mcp_servers"]["photocraft"]["command"], "/x/photocraft-cli");
        assert_eq!(answer("item/commandExecution/requestApproval"), Some(json!({"decision": "accept"})));
        assert_eq!(answer("something/else"), None);
    }
}
