//! Child processes for the provider CLIs: line-based stdio, and JSON-RPC 2.0 on top of it.

use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex, PoisonError};

/// Find a CLI on PATH, then in the per-user folders installers use (a desktop launch often has a
/// shorter PATH than a terminal: no `~/.local/bin`, no nvm).
pub fn find(program: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for d in [".local/bin", ".cargo/bin", ".npm-global/bin", ".bun/bin", ".volta/bin", "bin"] {
            dirs.push(home.join(d));
        }
        // nvm keeps one bin folder per Node version; prefer the newest.
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions: Vec<PathBuf> = entries.flatten().map(|e| e.path().join("bin")).collect();
            versions.sort();
            dirs.extend(versions.into_iter().rev());
        }
    }
    dirs.extend(["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"].iter().map(PathBuf::from));
    dirs.into_iter().map(|d| d.join(program)).find(|p| p.is_file())
}

/// The writing end of a child's stdin, shared by the reader thread (to answer requests) and the runner.
#[derive(Clone)]
pub struct Writer(Arc<Mutex<ChildStdin>>);

impl Writer {
    pub fn line(&self, line: &str) -> std::io::Result<()> {
        let mut w = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        w.write_all(line.as_bytes())?;
        w.write_all(b"\n")?;
        w.flush()
    }
}

pub struct Proc {
    child: Child,
    pub writer: Writer,
}

impl Proc {
    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Proc {
    fn drop(&mut self) {
        self.kill();
    }
}

pub type LineFn = Box<dyn FnMut(&str, &Writer) + Send>;
/// Called once stdout closes, with the last of stderr.
pub type ExitFn = Box<dyn FnOnce(String) + Send>;

/// Start `program args…` in `cwd`. Every stdout line goes to `on_line`; `on_exit` runs once the
/// process closes its stdout.
pub fn spawn(program: &Path, args: &[String], cwd: &Path, mut on_line: LineFn, on_exit: ExitFn) -> std::io::Result<Proc> {
    let mut cmd = Command::new(program);
    cmd.args(args).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // A Node CLI's `#!/usr/bin/env node` needs its own bin folder on PATH.
    if let Some(dir) = program.parent() {
        let mut paths = vec![dir.to_path_buf()];
        if let Some(p) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&p));
        }
        if let Ok(joined) = std::env::join_paths(paths) {
            cmd.env("PATH", joined);
        }
    }
    let mut child = cmd.spawn()?;
    let stdin = child.stdin.take().ok_or_else(|| std::io::Error::other("no stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| std::io::Error::other("no stdout"))?;
    let stderr = child.stderr.take();
    let writer = Writer(Arc::new(Mutex::new(stdin)));
    let tail = Arc::new(Mutex::new(String::new()));
    if let Some(mut err) = stderr {
        let tail = tail.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = err.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let mut t = tail.lock().unwrap_or_else(PoisonError::into_inner);
                t.push_str(&String::from_utf8_lossy(buf.get(..n).unwrap_or_default()));
                let len = t.chars().count();
                if len > 2000 {
                    *t = t.chars().skip(len - 2000).collect();
                }
            }
        });
    }
    let w = writer.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if !line.trim().is_empty() {
                        on_line(line.trim_end(), &w);
                    }
                }
            }
        }
        // Give stderr a moment to drain before reporting it.
        std::thread::sleep(std::time::Duration::from_millis(100));
        let t = tail.lock().unwrap_or_else(PoisonError::into_inner).trim().to_string();
        on_exit(t);
    });
    Ok(Proc { child, writer })
}

type Pending = Arc<Mutex<HashMap<u64, Sender<Result<Value, String>>>>>;

/// A JSON-RPC 2.0 peer on a child's stdio.
pub struct Rpc {
    pub proc: Mutex<Proc>,
    next: AtomicU64,
    pending: Pending,
}

/// Handles what the peer sends on its own: `(method, params)` notifications, and requests,
/// whose return value (when `Some`) is the result sent back.
pub type NotifyFn = Box<dyn FnMut(&str, &Value) + Send>;
pub type RequestFn = Box<dyn FnMut(&str, &Value) -> Option<Value> + Send>;

impl Rpc {
    pub fn spawn(program: &Path, args: &[String], cwd: &Path, mut notify: NotifyFn, mut request: RequestFn, on_exit: ExitFn) -> std::io::Result<Arc<Rpc>> {
        let pending: Pending = Arc::default();
        let p = pending.clone();
        let on_line: LineFn = Box::new(move |line, w| {
            let Ok(v) = serde_json::from_str::<Value>(line) else { return };
            let method = v.get("method").and_then(Value::as_str);
            let params = v.get("params").cloned().unwrap_or(Value::Null);
            match (method, v.get("id")) {
                (Some(m), Some(id)) => {
                    let reply = match request(m, &params) {
                        Some(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
                        None => json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": format!("PhotoCraft does not serve {m}")}}),
                    };
                    let _ = w.line(&reply.to_string());
                }
                (Some(m), None) => notify(m, &params),
                (None, Some(id)) => {
                    let Some(id) = id.as_u64() else { return };
                    let waiter = p.lock().unwrap_or_else(PoisonError::into_inner).remove(&id);
                    if let Some(tx) = waiter {
                        let answer = match v.get("error") {
                            Some(e) => Err(rpc_error(e)),
                            None => Ok(v.get("result").cloned().unwrap_or(Value::Null)),
                        };
                        let _ = tx.send(answer);
                    }
                }
                (None, None) => {}
            }
        });
        let p = pending.clone();
        let exit: ExitFn = Box::new(move |tail| {
            // Wake everyone still waiting: their answers will never come.
            p.lock().unwrap_or_else(PoisonError::into_inner).clear();
            on_exit(tail);
        });
        let proc = spawn(program, args, cwd, on_line, exit)?;
        Ok(Arc::new(Rpc { proc: Mutex::new(proc), next: AtomicU64::new(1), pending }))
    }

    /// Send a request; the answer arrives on the returned receiver (or it disconnects when the
    /// process ends first).
    pub fn request(&self, method: &str, params: Value) -> Receiver<Result<Value, String>> {
        let (tx, rx) = channel();
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.pending.lock().unwrap_or_else(PoisonError::into_inner).insert(id, tx.clone());
        let msg = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        let sent = self.proc.lock().unwrap_or_else(PoisonError::into_inner).writer.line(&msg.to_string());
        if let Err(e) = sent {
            self.pending.lock().unwrap_or_else(PoisonError::into_inner).remove(&id);
            let _ = tx.send(Err(format!("could not write to the process: {e}")));
        }
        rx
    }

    /// Send a request and wait for its answer.
    pub fn call(&self, method: &str, params: Value, timeout: Option<std::time::Duration>) -> Result<Value, String> {
        let rx = self.request(method, params);
        let answer = match timeout {
            Some(t) => rx.recv_timeout(t).map_err(|_| format!("no answer to {method} within {} s", t.as_secs())),
            None => rx.recv().map_err(|_| "the process ended".to_string()),
        };
        answer?
    }

    pub fn notify(&self, method: &str, params: Value) {
        let msg = json!({"jsonrpc": "2.0", "method": method, "params": params});
        let _ = self.proc.lock().unwrap_or_else(PoisonError::into_inner).writer.line(&msg.to_string());
    }

    pub fn kill(&self) {
        self.proc.lock().unwrap_or_else(PoisonError::into_inner).kill();
    }

    pub fn alive(&self) -> bool {
        self.proc.lock().unwrap_or_else(PoisonError::into_inner).alive()
    }
}

/// A JSON-RPC error as one sentence; cursor-agent puts the reason in `data.message`.
fn rpc_error(e: &Value) -> String {
    let data = e.get("data").and_then(|d| d.get("message").and_then(Value::as_str).map(str::to_string).or_else(|| d.as_str().map(str::to_string)));
    let msg = e.get("message").and_then(Value::as_str).unwrap_or("error");
    data.unwrap_or_else(|| msg.to_string())
}
