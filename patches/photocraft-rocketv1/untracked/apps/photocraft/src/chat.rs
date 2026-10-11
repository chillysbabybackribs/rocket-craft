//! Window › Chat, desktop side: the control server its models reach this window through, and
//! the runner that lends each message to a provider CLI (`photocraft_assistant`).
//!
//! Without `--control`, the window starts a control server of its own on a free loopback port,
//! with a token in a private file, so the panel works from a plain launch. With `--control`, the
//! chat shares that server. The models read and write files below the home folder only, through
//! the same automation roots any control client gets.

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use photocraft_assistant::{Runner, Tooling};
use photocraft_ui_egui::chat_panel::ChatServices;

/// A control server for the chat, not yet started: it needs the egui context.
pub struct Control {
    pub listener: TcpListener,
    pub token: String,
}

pub struct Setup {
    pub tooling: Tooling,
    pub workspace: Option<photocraft_automation::AuthorizedWorkspace>,
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

fn chat_dir() -> Option<PathBuf> {
    crate::services::config_dir().map(|d| d.join("chat"))
}

/// Writes the token where only this user can read it.
fn write_token(path: &Path, token: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        opts.mode(0o600);
    }
    use std::io::Write as _;
    opts.open(path)?.write_all(token.as_bytes())
}

/// `photocraft-cli` beside this binary (every package ships both), else on PATH.
fn cli_path() -> PathBuf {
    let name = if cfg!(windows) { "photocraft-cli.exe" } else { "photocraft-cli" };
    std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join(name))).filter(|p| p.is_file()).unwrap_or_else(|| PathBuf::from(name))
}

/// Prepare the chat's control access. `existing` is the `--control` port and token when given.
/// Returns the server to start (when the chat brings its own) and the runner's setup; `None`
/// when the chat can't be set up, which leaves the panel saying so.
pub fn prepare(existing: Option<(u16, &str)>) -> Option<(Option<Control>, Setup)> {
    let dir = chat_dir()?;
    let token_file = dir.join("control.token");
    let (port, token, control) = match existing {
        Some((port, token)) => (port, token.to_string(), None),
        None => {
            let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| log::warn!("chat: no loopback port: {e}")).ok()?;
            let port = listener.local_addr().ok()?.port();
            let token = photocraft_automation::security::generate_token().map_err(|e| log::warn!("chat: no token: {e}")).ok()?;
            (port, token.clone(), Some(Control { listener, token }))
        }
    };
    if let Err(e) = write_token(&token_file, &token) {
        log::warn!("chat: couldn't write the control token: {e}");
        return None;
    }
    let root = home();
    let workspace = match control {
        Some(_) => photocraft_automation::AuthorizedWorkspace::new(root.as_deref(), root.as_deref()).map_err(|e| log::warn!("chat: {e}")).ok(),
        None => None,
    };
    let tooling = Tooling {
        command: cli_path(),
        args: vec!["mcp".into(), "--bridge".into(), format!("127.0.0.1:{port}"), "--control-token-file".into(), token_file.display().to_string()],
        files_root: root,
        work_dir: dir.join("work"),
    };
    Some((control, Setup { tooling, workspace }))
}

pub fn services(tooling: Tooling) -> ChatServices {
    ChatServices {
        make: Box::new(move |ctx: egui::Context| {
            let wake: Arc<dyn Fn() + Send + Sync> = Arc::new(move || ctx.request_repaint());
            Box::new(Runner::new(tooling.clone(), wake))
        }),
        render_png: Box::new(|doc, side| photocraft_automation::files::render_png(doc, side).map_err(|e| e.to_string())),
    }
}
