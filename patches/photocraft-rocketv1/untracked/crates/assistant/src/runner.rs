//! The [`Chat`] the desktop app hands to the panel: one provider process at a time, kept alive
//! between messages and resumed by session id after a stop or a switch of provider.

use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use crate::process::{self, Proc, Rpc};
use crate::{Chat, Event, Message, Provider, ProviderInfo, Tooling, claude, codex, cursor, prompt_text};

const SETUP_TIMEOUT: Duration = Duration::from_secs(90);

/// Sends events to the panel and wakes it. A `Done` closes the turn, so a process that exits
/// afterwards is not reported as a failure.
#[derive(Clone)]
struct Sink {
    tx: Sender<Event>,
    wake: Arc<dyn Fn() + Send + Sync>,
    in_turn: Arc<AtomicBool>,
    stopping: Arc<AtomicBool>,
}

impl Sink {
    fn emit(&self, e: Event) {
        if matches!(e, Event::Done { .. }) && !self.in_turn.swap(false, Ordering::SeqCst) {
            return;
        }
        let _ = self.tx.send(e);
        (self.wake)();
    }

    fn fail(&self, error: String) {
        self.emit(Event::Done { error: Some(error) });
    }

    /// For a process that ended: a failure only when a turn was open and nobody asked it to stop.
    fn exited(&self, who: &str, stderr: &str) {
        if self.stopping.load(Ordering::SeqCst) || !self.in_turn.load(Ordering::SeqCst) {
            return;
        }
        let why = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("it exited without saying why");
        self.fail(format!("{who} stopped unexpectedly ({why}). Check that you are signed in to it, then send the message again."));
    }
}

enum Active {
    Claude(Proc),
    Rpc(Arc<Rpc>, Arc<Mutex<Option<String>>>),
}

pub struct Runner {
    tooling: Tooling,
    tx: Sender<Event>,
    rx: Receiver<Event>,
    wake: Arc<dyn Fn() + Send + Sync>,
    in_turn: Arc<AtomicBool>,
    stopping: Arc<AtomicBool>,
    active: Option<(Provider, Active)>,
    sessions: HashMap<Provider, String>,
    images: u32,
}

impl Runner {
    pub fn new(tooling: Tooling, wake: Arc<dyn Fn() + Send + Sync>) -> Self {
        let (tx, rx) = channel();
        Runner {
            tooling,
            tx,
            rx,
            wake,
            in_turn: Arc::default(),
            stopping: Arc::default(),
            active: None,
            sessions: HashMap::new(),
            images: 0,
        }
    }

    fn sink(&self) -> Sink {
        Sink { tx: self.tx.clone(), wake: self.wake.clone(), in_turn: self.in_turn.clone(), stopping: self.stopping.clone() }
    }

    fn end_process(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        match self.active.take() {
            Some((_, Active::Claude(mut p))) => p.kill(),
            Some((_, Active::Rpc(r, _))) => r.kill(),
            None => {}
        }
    }

    fn program(p: Provider) -> Result<PathBuf, String> {
        process::find(p.program()).ok_or_else(|| {
            format!("PhotoCraft couldn't find the `{}` command. Install {} and sign in to it in a terminal, then try again.", p.program(), p.label())
        })
    }

    fn send_claude(&mut self, message: &Message) -> Result<(), String> {
        let reuse = match &mut self.active {
            Some((Provider::Claude, Active::Claude(p))) => p.alive(),
            _ => false,
        };
        if !reuse {
            self.end_process();
            self.stopping.store(false, Ordering::SeqCst);
            let program = Self::program(Provider::Claude)?;
            let args = claude::args(&self.tooling, self.sessions.get(&Provider::Claude).map(String::as_str));
            let sink = self.sink();
            let mut translator = claude::Translator::default();
            let on_line: process::LineFn = Box::new(move |line, _| {
                if let Ok(v) = serde_json::from_str::<Value>(line) {
                    for e in translator.handle(&v) {
                        sink.emit(e);
                    }
                }
            });
            let sink = self.sink();
            let on_exit: process::ExitFn = Box::new(move |tail| sink.exited("Claude", &tail));
            let proc = process::spawn(&program, &args, &self.tooling.work_dir, on_line, on_exit)
                .map_err(|e| format!("PhotoCraft couldn't start Claude: {e}. Check that `claude` runs in a terminal."))?;
            self.active = Some((Provider::Claude, Active::Claude(proc)));
        }
        let Some((_, Active::Claude(proc))) = &self.active else { return Err("Claude isn't running.".into()) };
        proc.writer.line(&claude::user_line(message)).map_err(|e| format!("PhotoCraft couldn't write to Claude: {e}. Send the message again."))
    }

    /// Start (or reuse) a JSON-RPC provider, then run one turn on a worker thread.
    fn send_rpc(&mut self, provider: Provider, message: &Message) -> Result<(), String> {
        let reuse = matches!(&self.active, Some((p, Active::Rpc(r, _))) if *p == provider && r.alive());
        if !reuse {
            self.end_process();
            self.stopping.store(false, Ordering::SeqCst);
            let program = Self::program(provider)?;
            let sink = self.sink();
            let loading = Arc::new(AtomicBool::new(false));
            let (notify, request, args): (process::NotifyFn, process::RequestFn, Vec<String>) = match provider {
                Provider::Codex => {
                    let mut t = codex::Translator::default();
                    let s = sink.clone();
                    (
                        Box::new(move |m, p| t.handle(m, p).into_iter().for_each(|e| s.emit(e))),
                        Box::new(|m, _| codex::answer(m)),
                        codex::args(),
                    )
                }
                _ => {
                    let mut t = cursor::Translator::default();
                    let s = sink.clone();
                    let l = loading.clone();
                    (
                        Box::new(move |m, p| {
                            // session/load replays the stored history before it answers; that is not this turn.
                            if m == "session/update" && !l.load(Ordering::SeqCst) {
                                t.handle(p.get("update").unwrap_or(&Value::Null)).into_iter().for_each(|e| s.emit(e));
                            }
                        }),
                        Box::new(cursor::answer),
                        cursor::args(),
                    )
                }
            };
            let s = sink.clone();
            let label = provider.label();
            let on_exit: process::ExitFn = Box::new(move |tail| s.exited(label, &tail));
            let rpc = Rpc::spawn(&program, &args, &self.tooling.work_dir, notify, request, on_exit)
                .map_err(|e| format!("PhotoCraft couldn't start {label}: {e}. Check that `{}` runs in a terminal.", provider.program()))?;
            let session = Arc::new(Mutex::new(None::<String>));
            let resume = self.sessions.get(&provider).cloned();
            let tooling = self.tooling.clone();
            let program_for_list = program.clone();
            let (r, sess, sink) = (rpc.clone(), session.clone(), sink.clone());
            // Setup runs ahead of the first turn on the same worker, below.
            self.active = Some((provider, Active::Rpc(rpc, session)));
            let setup: Box<dyn FnOnce() -> Result<bool, String> + Send> = Box::new(move || match provider {
                Provider::Codex => {
                    r.call("initialize", codex::initialize_params(), Some(SETUP_TIMEOUT))?;
                    r.notify("initialized", json!({}));
                    let others = codex_servers(&program_for_list);
                    let mut params = codex::thread_params(&tooling, &others);
                    let resumed = match &resume {
                        Some(id) => {
                            params["threadId"] = json!(id);
                            r.call("thread/resume", params.clone(), Some(SETUP_TIMEOUT)).ok()
                        }
                        None => None,
                    };
                    let fresh = resumed.is_none();
                    let answer = match resumed {
                        Some(a) => a,
                        None => r.call("thread/start", codex::thread_params(&tooling, &others), Some(SETUP_TIMEOUT))?,
                    };
                    let id = answer.get("thread").and_then(|t| t.get("id")).and_then(Value::as_str).unwrap_or("").to_string();
                    let model = answer.get("model").and_then(Value::as_str).unwrap_or("").to_string();
                    *sess.lock().unwrap_or_else(PoisonError::into_inner) = Some(id.clone());
                    sink.emit(Event::Session { session_id: id, model });
                    Ok(fresh)
                }
                _ => {
                    r.call("initialize", cursor::initialize_params(), Some(SETUP_TIMEOUT))?;
                    let loaded = match &resume {
                        Some(id) => {
                            loading.store(true, Ordering::SeqCst);
                            let a = r.call("session/load", cursor::session_params(&tooling, Some(id)), Some(SETUP_TIMEOUT)).ok();
                            loading.store(false, Ordering::SeqCst);
                            a.map(|a| (id.clone(), a))
                        }
                        None => None,
                    };
                    let fresh = loaded.is_none();
                    let (id, setup) = match loaded {
                        Some(x) => x,
                        None => {
                            let a = r.call("session/new", cursor::session_params(&tooling, None), Some(SETUP_TIMEOUT))?;
                            (a.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string(), a)
                        }
                    };
                    *sess.lock().unwrap_or_else(PoisonError::into_inner) = Some(id.clone());
                    sink.emit(Event::Session { session_id: id, model: cursor::session_model(&setup) });
                    Ok(fresh)
                }
            });
            return self.run_turn(provider, message, Some(setup));
        }
        self.run_turn(provider, message, None)
    }

    fn run_turn(&mut self, provider: Provider, message: &Message, setup: Option<Box<dyn FnOnce() -> Result<bool, String> + Send>>) -> Result<(), String> {
        let Some((_, Active::Rpc(rpc, session))) = &self.active else { return Err(format!("{} isn't running.", provider.label())) };
        let (rpc, session, sink) = (rpc.clone(), session.clone(), self.sink());
        let text = prompt_text(message);
        let png = message.image_png.clone();
        let image_path = match (&png, provider) {
            (Some(bytes), Provider::Codex) => {
                self.images += 1;
                let path = self.tooling.work_dir.join(format!("canvas-{}.png", self.images));
                std::fs::write(&path, bytes).map_err(|e| format!("PhotoCraft couldn't save the canvas picture for Codex: {e}."))?;
                Some(path)
            }
            _ => None,
        };
        let instructions = crate::instructions(&self.tooling);
        std::thread::spawn(move || {
            let fresh = match setup {
                Some(f) => match f() {
                    Ok(fresh) => fresh,
                    Err(e) => {
                        return sink.fail(format!("{} couldn't start a conversation: {e}. Check that you are signed in, then try again.", provider.label()));
                    }
                },
                None => false,
            };
            let id = session.lock().unwrap_or_else(PoisonError::into_inner).clone().unwrap_or_default();
            match provider {
                Provider::Codex => {
                    let params = json!({"threadId": id, "input": codex::turn_input(&text, image_path.as_deref())});
                    // The turn's end arrives as `turn/completed`.
                    if let Err(e) = rpc.call("turn/start", params, Some(SETUP_TIMEOUT)) {
                        sink.fail(format!("Codex didn't take the message: {e}. Send it again."));
                    }
                }
                _ => {
                    let prompt = cursor::prompt(&text, png.as_deref(), fresh.then_some(instructions.as_str()));
                    match rpc.call("session/prompt", json!({"sessionId": id, "prompt": prompt}), None) {
                        Ok(result) => sink.emit(cursor::finished(&result)),
                        Err(e) => sink.fail(format!("Cursor stopped with an error: {e}. Send the message again, or start a new chat.")),
                    }
                }
            }
        });
        Ok(())
    }
}

impl Chat for Runner {
    fn providers(&self) -> Vec<ProviderInfo> {
        Provider::ALL.into_iter().map(|p| ProviderInfo { provider: p, path: process::find(p.program()) }).collect()
    }

    fn send(&mut self, provider: Provider, message: Message) -> Result<(), String> {
        if self.in_turn.load(Ordering::SeqCst) {
            return Err("A reply is still running. Stop it first, or wait for it to finish.".into());
        }
        let _ = std::fs::create_dir_all(&self.tooling.work_dir);
        self.in_turn.store(true, Ordering::SeqCst);
        let sent = match provider {
            Provider::Claude => self.send_claude(&message),
            Provider::Codex | Provider::Cursor => self.send_rpc(provider, &message),
        };
        if sent.is_err() {
            self.in_turn.store(false, Ordering::SeqCst);
        }
        sent
    }

    fn stop(&mut self) {
        if !self.in_turn.load(Ordering::SeqCst) {
            return;
        }
        // Ending the process is the one stop every CLI honours at once; the session is resumed
        // with the next message.
        self.end_process();
        self.sink().emit(Event::Done { error: None });
    }

    fn reset(&mut self) {
        self.end_process();
        self.in_turn.store(false, Ordering::SeqCst);
        self.sessions.clear();
    }

    fn busy(&self) -> bool {
        self.in_turn.load(Ordering::SeqCst)
    }

    fn poll(&mut self) -> Vec<Event> {
        let events: Vec<Event> = self.rx.try_iter().collect();
        for e in &events {
            if let (Event::Session { session_id, .. }, Some((p, _))) = (e, &self.active)
                && !session_id.is_empty()
            {
                self.sessions.insert(*p, session_id.clone());
            }
        }
        events
    }
}

impl Drop for Runner {
    fn drop(&mut self) {
        self.end_process();
    }
}

/// The user's own Codex MCP servers, by name (`codex mcp list --json`); none when it can't say.
fn codex_servers(program: &std::path::Path) -> Vec<String> {
    let mut cmd = std::process::Command::new(program);
    cmd.args(["mcp", "list", "--json"]).args(codex::plugin_overrides()).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    if let Some(dir) = program.parent() {
        let mut paths = vec![dir.to_path_buf()];
        if let Some(p) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&p));
        }
        if let Ok(joined) = std::env::join_paths(paths) {
            cmd.env("PATH", joined);
        }
    }
    match cmd.output() {
        Ok(out) => codex::server_names(&String::from_utf8_lossy(&out.stdout)),
        Err(_) => Vec::new(),
    }
}
