use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

pub const READBOX_REF: &str = "15f766f19f1ab204535f1947983fa397540352c8";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadBoxModelConfig {
    pub api_key: String,
    pub api_base: String,
    pub model: String,
    pub max_tokens: u32,
    pub temperature: f32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadBoxRuntimeSnapshot {
    pub status: String,
    pub port: Option<u16>,
    pub upstream_ref: String,
    pub error: Option<String>,
}

struct ReadBoxRuntime {
    child: Option<Child>,
    port: Option<u16>,
    status: String,
    error: Option<String>,
}

impl Default for ReadBoxRuntime {
    fn default() -> Self {
        Self {
            child: None,
            port: None,
            status: "idle".to_string(),
            error: None,
        }
    }
}

pub struct ReadBoxState(Mutex<ReadBoxRuntime>);

impl Default for ReadBoxState {
    fn default() -> Self {
        Self(Mutex::new(ReadBoxRuntime::default()))
    }
}

fn snapshot(runtime: &ReadBoxRuntime) -> ReadBoxRuntimeSnapshot {
    ReadBoxRuntimeSnapshot {
        status: runtime.status.clone(),
        port: runtime.port,
        upstream_ref: READBOX_REF.to_string(),
        error: runtime.error.clone(),
    }
}

fn resolve_source_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("READBOX_SOURCE_DIR") {
        return PathBuf::from(path);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../.readbox/upstream")
        .join(READBOX_REF)
}

fn resolve_uv_bin() -> PathBuf {
    if let Some(path) = std::env::var_os("READBOX_UV_BIN") {
        return PathBuf::from(path);
    }

    #[cfg(target_os = "windows")]
    {
        let mut candidates = Vec::new();
        if let Some(app_data) = std::env::var_os("APPDATA") {
            let python_root = PathBuf::from(app_data).join("Python");
            if let Ok(entries) = std::fs::read_dir(python_root) {
                for entry in entries.flatten() {
                    candidates.push(entry.path().join("Scripts/uv.exe"));
                }
            }
        }
        if let Some(user_profile) = std::env::var_os("USERPROFILE") {
            candidates.push(PathBuf::from(user_profile).join(".local/bin/uv.exe"));
        }
        candidates.sort();
        candidates.reverse();
        if let Some(path) = candidates.into_iter().find(|path| path.is_file()) {
            return path;
        }
    }

    PathBuf::from("uv")
}

fn verify_source(source_dir: &Path) -> Result<PathBuf, String> {
    let backend_dir = source_dir.join("code/backend");
    if !backend_dir.join("app/main.py").is_file() {
        return Err(format!(
            "Pinned Read-Box source is unavailable. Run `pnpm readbox:source` (expected ref {}).",
            READBOX_REF
        ));
    }

    let output = Command::new("git")
        .arg("-C")
        .arg(source_dir)
        .args(["rev-parse", "HEAD"])
        .creation_flags_hidden()
        .output()
        .map_err(|error| format!("Unable to verify pinned Read-Box source: {error}"))?;
    if !output.status.success() {
        return Err("Unable to verify pinned Read-Box source HEAD".to_string());
    }
    let head = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if head != READBOX_REF {
        return Err(format!(
            "Read-Box source ref mismatch: expected {}, found {}",
            READBOX_REF, head
        ));
    }
    Ok(backend_dir)
}

fn available_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("Unable to reserve a loopback port: {error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("Unable to inspect the loopback port: {error}"))
}

fn wait_for_health(child: &mut Child, port: u16) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|error| format!("Unable to create Read-Box health client: {error}"))?;
    let url = format!("http://127.0.0.1:{port}/api/health");
    let deadline = Instant::now() + Duration::from_secs(45);

    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "Read-Box worker exited before readiness ({status})"
            ));
        }
        if let Ok(response) = client.get(&url).send() {
            if response.status().is_success() {
                return Ok(());
            }
        }
        thread::sleep(Duration::from_millis(400));
    }
    Err("Read-Box worker did not become ready within 45 seconds".to_string())
}

#[cfg(target_os = "windows")]
fn terminate_child(child: &mut Child) {
    let pid = child.id().to_string();
    let _ = Command::new("taskkill")
        .args(["/PID", &pid, "/T"])
        .creation_flags_hidden()
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = Command::new("taskkill")
        .args(["/PID", &pid, "/T", "/F"])
        .creation_flags_hidden()
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.wait();
}

#[cfg(not(target_os = "windows"))]
fn terminate_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn stop_runtime(runtime: &mut ReadBoxRuntime) {
    if let Some(mut child) = runtime.child.take() {
        terminate_child(&mut child);
    }
    runtime.port = None;
    runtime.status = "stopped".to_string();
}

pub fn stop_on_app_close(state: &ReadBoxState) {
    if let Ok(mut runtime) = state.0.lock() {
        stop_runtime(&mut runtime);
    }
}

#[tauri::command]
pub async fn readbox_start(
    app: AppHandle,
    config: ReadBoxModelConfig,
) -> Result<ReadBoxRuntimeSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || readbox_start_blocking(app, config))
        .await
        .map_err(|error| format!("Read-Box runtime task failed: {error}"))?
}

fn readbox_start_blocking(
    app: AppHandle,
    config: ReadBoxModelConfig,
) -> Result<ReadBoxRuntimeSnapshot, String> {
    if config.api_key.trim().is_empty() || config.model.trim().is_empty() {
        return Err("ReadAny has no active AI key/model for the learning worker".to_string());
    }
    if config.api_base.trim().is_empty() {
        return Err("ReadAny active AI endpoint has no base URL".to_string());
    }

    let state = app.state::<ReadBoxState>();
    let mut runtime = state
        .0
        .lock()
        .map_err(|_| "Read-Box runtime state is unavailable".to_string())?;
    stop_runtime(&mut runtime);
    runtime.status = "starting".to_string();
    runtime.error = None;

    let backend_dir = match verify_source(&resolve_source_dir()) {
        Ok(path) => path,
        Err(error) => {
            runtime.status = "unavailable".to_string();
            runtime.error = Some(error.clone());
            return Err(error);
        }
    };
    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve Read-Box cache directory: {error}"))?
        .join("readbox-worker");
    std::fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("Unable to create Read-Box cache directory: {error}"))?;
    let port = available_port()?;
    let port_string = port.to_string();

    let mut command = Command::new(resolve_uv_bin());
    command
        .args(["run", "--frozen", "--project"])
        .arg(&backend_dir)
        .args(["uvicorn", "app.main:app", "--host", "127.0.0.1", "--port"])
        .arg(&port_string)
        .env("PYTHONPATH", &backend_dir)
        .env("LLM_PROVIDER", "openai")
        .env("LLM_API_KEY", config.api_key)
        .env("LLM_API_BASE", config.api_base)
        .env("LLM_MODEL", config.model)
        .env("LLM_MAX_TOKENS", config.max_tokens.to_string())
        .env("LLM_TEMPERATURE", config.temperature.to_string())
        .current_dir(cache_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags_hidden();

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let message = format!("Unable to start system `uv` Read-Box worker: {error}");
            runtime.status = "unavailable".to_string();
            runtime.error = Some(message.clone());
            return Err(message);
        }
    };

    if let Err(error) = wait_for_health(&mut child, port) {
        terminate_child(&mut child);
        runtime.status = "unavailable".to_string();
        runtime.error = Some(error.clone());
        return Err(error);
    }

    runtime.child = Some(child);
    runtime.port = Some(port);
    runtime.status = "ready".to_string();
    Ok(snapshot(&runtime))
}

#[tauri::command]
pub fn readbox_status(state: State<'_, ReadBoxState>) -> Result<ReadBoxRuntimeSnapshot, String> {
    let mut runtime = state
        .0
        .lock()
        .map_err(|_| "Read-Box runtime state is unavailable".to_string())?;
    let exited = runtime
        .child
        .as_mut()
        .and_then(|child| child.try_wait().ok().flatten());
    if let Some(status) = exited {
        runtime.child = None;
        runtime.port = None;
        runtime.status = "unavailable".to_string();
        runtime.error = Some(format!("Read-Box worker exited ({status})"));
    }
    Ok(snapshot(&runtime))
}

#[tauri::command]
pub async fn readbox_stop(app: AppHandle) -> Result<ReadBoxRuntimeSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || readbox_stop_blocking(app))
        .await
        .map_err(|error| format!("Read-Box shutdown task failed: {error}"))?
}

fn readbox_stop_blocking(app: AppHandle) -> Result<ReadBoxRuntimeSnapshot, String> {
    let state = app.state::<ReadBoxState>();
    let mut runtime = state
        .0
        .lock()
        .map_err(|_| "Read-Box runtime state is unavailable".to_string())?;
    stop_runtime(&mut runtime);
    runtime.error = None;
    Ok(snapshot(&runtime))
}

trait HiddenCommand {
    fn creation_flags_hidden(&mut self) -> &mut Self;
}

impl HiddenCommand for Command {
    fn creation_flags_hidden(&mut self) -> &mut Self {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(0x08000000);
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_snapshot_is_explicit_and_pinned() {
        let runtime = ReadBoxRuntime::default();
        let snapshot = snapshot(&runtime);
        assert_eq!(snapshot.status, "idle");
        assert_eq!(snapshot.upstream_ref, READBOX_REF);
        assert!(snapshot.port.is_none());
    }

    #[test]
    fn selects_a_loopback_port() {
        assert!(available_port().expect("loopback port") > 0);
    }
}
